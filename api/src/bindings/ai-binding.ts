// RPC AI Binding for Dynamic Workers
// Wraps AI service calls behind a WorkerEntrypoint.
// The Dynamic Worker sees env.AI.call() but never has the API key.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { deductChatCost } from '../../services/chat-billing.ts';
import { recordAiSpend } from '../../services/ai-spend-tracker.ts';
import { resolvePlatformInferenceModel } from '../../services/platform-inference-models.ts';

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
  requestDefaults: Record<string, unknown> | null;
  shouldDebitLight: boolean;
  unavailableReason?: string | null;
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

  async call(request: AIRequest) {
    const {
      apiKey,
      provider,
      upstreamProvider,
      baseUrl,
      defaultModel,
      canonicalModelId,
      billingModelId,
      billingSource,
      requestDefaults,
      shouldDebitLight,
      userId,
      executionId,
      unavailableReason,
    } = this.ctx.props;

    if (!apiKey || !provider || !baseUrl) {
      return {
        content: '',
        model: 'none',
        usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
        error: unavailableReason || 'AI is not configured for this request.',
      };
    }

    // Format messages — handle multimodal content arrays
    const messages = request.messages.map(msg => {
      if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
      if (Array.isArray(msg.content)) return { role: msg.role, content: translateParts(msg.content) };
      return { role: msg.role, content: msg.content };
    });

    // Model precedence: dev's per-call model > user's selected model
    // (defaultModel) > platform fallback (deepseek-v4).
    const requestedModel = request.model || defaultModel || PLATFORM_FALLBACK_MODEL;
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

    // Attempt the resolved model; if it fails, retry once with the platform
    // fallback model — but only on the OpenRouter path, where that slug is
    // valid. A non-OpenRouter BYOK provider can't serve it, so surface the error.
    let result = await attempt(model);
    if (
      'error' in result &&
      upstreamProvider === 'openrouter' &&
      model !== PLATFORM_FALLBACK_MODEL
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
      } catch (err) {
        console.error('[AI-BINDING] Failed to debit Light for AI call:', err);
      }
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
