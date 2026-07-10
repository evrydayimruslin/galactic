// RPC AI Binding for Dynamic Workers
// Wraps AI service calls behind a WorkerEntrypoint.
// The Dynamic Worker sees env.AI.call() but never has the API key.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { CHAT_MIN_BALANCE_LIGHT, checkChatBalance, deductChatCost } from '../../services/chat-billing.ts';
import { recordUnbilledAiUsage } from '../../services/ai-usage-events.ts';
import { recordAiSpend } from '../../services/ai-spend-tracker.ts';
import { resolveExecutionContext } from '../../services/execution-context-registry.ts';
import { resolvePlatformInferenceModel } from '../../services/platform-inference-models.ts';
import { resolveRequestedModel, shouldRetryWithFallbackModel } from './ai-model-precedence.ts';

// ============================================
// TYPES
// ============================================

// A hung provider (BYOK endpoint that never responds) must not idle the whole
// execution to its sandbox abort — bound each provider call independently.
const AI_FETCH_TIMEOUT_MS = 90_000;
// Platform ceiling on a single completion. Tenant code passes max_tokens
// straight through otherwise, maximizing both latency and per-call spend.
const MAX_AI_MAX_TOKENS = 32_768;
// Final fallback model for galactic.ai(): used when neither the dev's per-call
// model nor the user's selected model is set, and as the retry model when the
// chosen model fails on the OpenRouter (credits) path. A valid OpenRouter slug.
const PLATFORM_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash';

interface AIBindingProps {
  userId: string;
  // App attribution for billing/usage rows. Safe in props (unlike per-call
  // functionName): the isolate reuse key includes the app, so appId is stable
  // for the isolate's lifetime.
  appId?: string | null;
  // Execution receipt key for the authoritative AI-spend ledger
  // (ai-spend-tracker.ts). Null only for legacy callers.
  executionId: string | null;
  apiKey: string | null;
  provider: string | null;
  upstreamProvider: string | null;
  baseUrl: string | null;
  defaultModel: string | null;
  canonicalModelId: string | null;
  billingModelId: string | null;
  billingSource: string | null;
  // Which key served the route ('user_byok' | 'platform_openrouter' | ...).
  keySource: string | null;
  requestDefaults: Record<string, unknown> | null;
  shouldDebitLight: boolean;
  // Metered (credits) route: re-check the wallet before EVERY call so a buyer
  // cannot fan out many galactic.ai() calls in one execution and outspend their
  // balance. BYOK routes set this false.
  shouldRequireBalance: boolean;
  // defaultModel is the installer's EXPLICIT per-function override: it beats
  // the dev's per-call request.model, and the OpenRouter fallback retry is
  // skipped rather than silently substituting another model for the user's
  // choice.
  modelPinned?: boolean;
  unavailableReason?: string | null;
  // Set for bindings loaded into a REUSABLE isolate (loader.get): call() then
  // refuses inference without a resolvable per-call context handle, so a
  // direct-binding bypass can never record spend against the stale frozen
  // props.executionId.
  requireExecCtx?: boolean;
}

type ContentPart = { type: 'text'; text: string }
  | { type: 'file'; data: string; filename?: string };

interface AIRequest {
  model?: string;
  messages: Array<{ role: string; content: string | ContentPart[] }>;
  max_tokens?: number;
  temperature?: number;
  // Forwarded to the provider for parity with the in-process path (ai.ts).
  // NOTE: ai() returns text content only — tool_calls are not surfaced in the
  // response yet, so `tools` acts as a hint to the model, not a round-trip.
  tools?: unknown[];
}

// ============================================
// MULTIMODAL TRANSLATION (mirrors ai.ts)
// ============================================

const IMG = new Set(['png','jpg','jpeg','gif','webp','bmp','svg']);
const TXT = new Set(['txt','md','csv','json','xml','yaml','yml','html','htm','css','js','ts','py','rb','go','rs','java','c','cpp','h','sh','sql','toml','ini','cfg','log','env']);

function ext(f?: string): string { return f ? (f.split('.').pop() || '').toLowerCase() : ''; }
function mime(d: string): string { const m = d.match(/^data:([^;,]+)/); return m ? m[1] : ''; }

function translateParts(parts: ContentPart[]): unknown[] {
  const out: unknown[] = [];
  for (const p of parts) {
    if (p.type === 'text') { out.push({ type: 'text', text: p.text }); continue; }
    if (p.type !== 'file') continue;
    const e = ext(p.filename), m = mime(p.data);
    const isImg = IMG.has(e) || m.startsWith('image/');
    const isTxt = TXT.has(e) || m.startsWith('text/');
    if (isImg) {
      const url = p.data.startsWith('data:') ? p.data : `data:image/${e||'png'};base64,${p.data}`;
      out.push({ type: 'image_url', image_url: { url } });
    } else if (isTxt) {
      let text = '';
      if (p.data.startsWith('data:')) { try { const b = p.data.split(',')[1]; if (b) text = atob(b); } catch { text = p.data; } }
      else text = p.data;
      out.push({ type: 'text', text: (p.filename ? `[File: ${p.filename}]\n` : '') + text });
    } else {
      const url = p.data.startsWith('data:') ? p.data : `data:application/octet-stream;base64,${p.data}`;
      if (p.filename) out.push({ type: 'text', text: `[Attached: ${p.filename}]` });
      out.push({ type: 'image_url', image_url: { url } });
    }
  }
  return out;
}

// ============================================
// RPC BINDING
// ============================================

export class AIBinding extends WorkerEntrypoint<unknown, AIBindingProps> {

  async call(request: AIRequest, execCtxHandle?: string) {
    const {
      apiKey,
      provider,
      upstreamProvider,
      baseUrl,
      defaultModel,
      canonicalModelId,
      billingModelId,
      billingSource,
      keySource,
      requestDefaults,
      shouldDebitLight,
      shouldRequireBalance,
      modelPinned,
      userId,
      executionId: propExecutionId,
      unavailableReason,
    } = this.ctx.props;

    // The execution id the spend ledger is keyed by. Under warm-isolate reuse
    // (loader.get) the isolate's env bindings are FROZEN at first load, so
    // props.executionId would be STALE (call 1's id) on every later call —
    // recording spend under an already-settled id = FREE INFERENCE. So when a
    // per-call handle is threaded — or the binding was loaded into a reusable
    // isolate (props.requireExecCtx, which also catches a direct-binding
    // bypass that omits the handle entirely) — trust ONLY the parent-side
    // registry: an unresolvable handle (execution already deregistered, or a
    // forgery) REFUSES the call rather than charging a stale hold.
    // props.executionId is used only on the legacy no-handle fresh-load path
    // (where they agree). A resolved context whose aiExecutionId is null is
    // legitimate (a run with no spend id) — only an unresolvable HANDLE fails
    // closed.
    let executionId: string | null;
    // App/function attribution for billing rows. appId falls back to props
    // (stable per isolate); functionName is per-CALL, so it comes ONLY from
    // the resolved execution context — a warm isolate's frozen props would
    // attribute call N's spend to call 1's function.
    let attributedAppId: string | null = this.ctx.props.appId ?? null;
    let attributedFunctionName: string | null = null;
    if (execCtxHandle !== undefined || this.ctx.props.requireExecCtx) {
      const resolvedCtx = resolveExecutionContext(execCtxHandle);
      if (!resolvedCtx) {
        return {
          content: '',
          model: request.model || defaultModel || 'none',
          usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
          error:
            'AI execution context could not be resolved; inference refused.',
        };
      }
      executionId = resolvedCtx.aiExecutionId;
      attributedAppId = resolvedCtx.appId ?? attributedAppId;
      attributedFunctionName = resolvedCtx.functionName;
    } else {
      executionId = propExecutionId;
    }

    if (!apiKey || !provider || !baseUrl) {
      return {
        content: '',
        model: 'none',
        usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
        error: unavailableReason || 'AI is not configured for this request.',
      };
    }

    // Metered (credits) route: re-check the wallet before EVERY call. The
    // context-build gate only fires once, so without this a sandboxed app could
    // fan out many galactic.ai() calls in one execution and outspend its
    // balance (the post-hoc debit below allows partial debiting). BYOK routes
    // are not metered and skip this. Fail OPEN on a balance-read error (a
    // Free-Mode / already-insufficient user is denied at context build, so a
    // call only reaches here for a funded route) — the post-hoc debit is the
    // backstop and availability wins on transient blips.
    const metered = shouldRequireBalance && shouldDebitLight;
    if (metered) {
      let balance: number | null = null;
      try {
        balance = await checkChatBalance(userId);
      } catch (balanceError) {
        console.warn('[AI-BINDING] Per-call balance re-check unavailable; proceeding un-gated:', balanceError);
      }
      if (balance !== null && balance < CHAT_MIN_BALANCE_LIGHT) {
        return {
          content: '',
          model: request.model || defaultModel || 'none',
          usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
          error:
            `Platform inference requires at least ${CHAT_MIN_BALANCE_LIGHT} credits ` +
            `(current balance: ${balance}). Add credits in the wallet or configure ` +
            `a BYOK provider key in Settings.`,
        };
      }
    }

    // Format messages — handle multimodal content arrays
    const messages = request.messages.map(msg => {
      if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
      if (Array.isArray(msg.content)) return { role: msg.role, content: translateParts(msg.content) };
      return { role: msg.role, content: msg.content };
    });

    // Model precedence: see resolveRequestedModel — a pinned per-function
    // override beats the dev's per-call model; otherwise per-call model >
    // user's selected model (defaultModel) > platform fallback (deepseek-v4).
    const requestedModel = resolveRequestedModel({
      requestModel: request.model,
      defaultModel,
      modelPinned,
      fallbackModel: PLATFORM_FALLBACK_MODEL,
    });
    const platformModel = provider === 'ultralight'
      ? resolvePlatformInferenceModel(requestedModel)
      : null;
    let model = platformModel && platformModel.upstreamProvider === upstreamProvider
      ? platformModel.upstreamModel
      : provider === 'ultralight' && upstreamProvider === 'openrouter' && platformModel
      ? platformModel.aliases.find((alias) => alias.includes('/')) || requestedModel
      : provider === 'ultralight' && upstreamProvider !== 'openrouter'
      ? defaultModel || requestedModel
      : requestedModel;
    const maxTokens = Math.min(
      Math.max(1, Math.floor(request.max_tokens || 4096)),
      MAX_AI_MAX_TOKENS,
    );

    type CompletionData = {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      };
    };

    // One provider attempt for a given model. Bound independently so a hung
    // endpoint fails fast instead of idling the execution to its sandbox abort.
    const attempt = async (
      modelToUse: string,
    ): Promise<{ data: CompletionData } | { error: string }> => {
      const abort = new AbortController();
      const timeoutId = setTimeout(() => abort.abort(), AI_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://api.connectgalactic.com',
            'X-Title': 'Galactic',
          },
          body: JSON.stringify({
            // Spread defaults FIRST so the clamped max_tokens (and explicit
            // temperature) stay final even if a future platform default carries
            // those keys. requestDefaults is platform-controlled, never tenant.
            ...(requestDefaults ?? {}),
            model: modelToUse,
            messages,
            max_tokens: maxTokens,
            temperature: request.temperature ?? 0.7,
            // Parity with the in-process path: forward tools to the provider when
            // present. Response still returns text content only (no tool_calls).
            ...(Array.isArray(request.tools) && request.tools.length > 0
              ? { tools: request.tools }
              : {}),
          }),
          signal: abort.signal,
        });
        if (!response.ok) {
          const errText = await response.text();
          return { error: `AI call failed (${response.status}): ${errText}` };
        }
        return { data: await response.json() as CompletionData };
      } catch (err) {
        return {
          error: abort.signal.aborted
            ? `AI call timed out after ${Math.round(AI_FETCH_TIMEOUT_MS / 1000)}s`
            : `AI call failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    // Attempt the resolved model; on failure retry once with the platform
    // fallback model when eligible (OpenRouter path only, and never for a
    // pinned model — see shouldRetryWithFallbackModel).
    let result = await attempt(model);
    if (
      'error' in result &&
      shouldRetryWithFallbackModel({
        upstreamProvider,
        attemptedModel: model,
        fallbackModel: PLATFORM_FALLBACK_MODEL,
        modelPinned,
      })
    ) {
      const fallback = await attempt(PLATFORM_FALLBACK_MODEL);
      if ('data' in fallback) {
        model = PLATFORM_FALLBACK_MODEL;
        result = fallback;
      }
    }

    if ('error' in result) {
      return {
        content: '',
        model,
        usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
        error: result.error,
      };
    }
    const data = result.data;
    const promptTokens = data.usage?.prompt_tokens || 0;
    const completionTokens = data.usage?.completion_tokens || 0;
    const promptCacheHitTokens = data.usage?.prompt_cache_hit_tokens;
    const promptCacheMissTokens = data.usage?.prompt_cache_miss_tokens;
    const responseModel = data.model || model;
    let costLight = 0;

    if (shouldDebitLight && promptTokens + completionTokens > 0) {
      try {
        const modelForBilling = billingSource === 'platform_deepseek_direct'
          ? responseModel
          : billingModelId || canonicalModelId || responseModel;
        const billing = await deductChatCost(
          userId,
          {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            prompt_cache_hit_tokens: promptCacheHitTokens,
            prompt_cache_miss_tokens: promptCacheMissTokens,
          },
          modelForBilling,
          undefined,
          {
            provider,
            upstream_provider: upstreamProvider,
            upstream_model: responseModel,
            canonical_model_id: canonicalModelId,
            source: 'runtime_ai_binding',
            appId: attributedAppId,
            functionName: attributedFunctionName,
          },
          {
            billingSource: billingSource === 'platform_deepseek_direct'
              ? 'platform_deepseek_direct'
              : billingSource === 'openrouter'
              ? 'openrouter'
              : 'none',
          },
        );
        costLight = billing.cost_light;
        // Authoritative spend ledger: survives a sandbox abort (where the
        // sandbox-side accumulator is lost) and is out of tenant reach.
        recordAiSpend(executionId, costLight);
        // A depleting (partial) debit means the buyer could not fully cover this
        // call: withhold the content so they cannot consume metered inference
        // they did not pay for. Only on metered routes (a BYOK route never
        // depletes a platform wallet).
        if (metered && billing.was_depleted) {
          return {
            content: '',
            model: responseModel,
            usage: { input_tokens: promptTokens, output_tokens: completionTokens, cost_light: costLight },
            error:
              'Insufficient credits to complete this AI call. Add credits in the ' +
              'wallet or configure a BYOK provider key in Settings.',
          };
        }
      } catch (err) {
        console.error('[AI-BINDING] Failed to debit Light for AI call:', err);
      }
    } else if (!shouldDebitLight && promptTokens + completionTokens > 0) {
      // Zero-debit route (BYOK or otherwise unbilled): record usage metadata
      // on a NON-economic path so model/function analytics aren't blind to
      // BYOK traffic. Fire-and-forget — never blocks or fails the call, and
      // never touches debit_light.
      recordUnbilledAiUsage({
        userId,
        appId: attributedAppId,
        functionName: attributedFunctionName,
        executionId,
        billingMode: keySource === 'user_byok' ? 'byok' : 'unbilled',
        provider,
        upstreamProvider,
        keySource,
        model: responseModel,
        requestedModel: model,
        promptTokens,
        completionTokens,
        source: 'runtime_ai_binding',
      });
    }

    return {
      content: data.choices?.[0]?.message?.content || '',
      model: responseModel,
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        cost_light: costLight,
        prompt_cache_hit_tokens: promptCacheHitTokens,
        prompt_cache_miss_tokens: promptCacheMissTokens,
      },
    };
  }
}
