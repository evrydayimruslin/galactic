// RPC AI Binding for Dynamic Workers
// Wraps AI service calls behind a WorkerEntrypoint.
// The Dynamic Worker sees env.AI.call() but never has the API key.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { deductChatCost } from '../../services/chat-billing.ts';
import { resolvePlatformInferenceModel } from '../../services/platform-inference-models.ts';

// ============================================
// TYPES
// ============================================

interface AIBindingProps {
  userId: string;
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
}

type ContentPart = { type: 'text'; text: string }
  | { type: 'file'; data: string; filename?: string };

interface AIRequest {
  model?: string;
  messages: Array<{ role: string; content: string | ContentPart[] }>;
  max_tokens?: number;
  temperature?: number;
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
    } = this.ctx.props;

    if (!apiKey || !provider || !baseUrl) {
      return {
        content: '',
        model: 'none',
        usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
        error: 'AI is not configured for this request.',
      };
    }

    // Format messages — handle multimodal content arrays
    const messages = request.messages.map(msg => {
      if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
      if (Array.isArray(msg.content)) return { role: msg.role, content: translateParts(msg.content) };
      return { role: msg.role, content: msg.content };
    });

    const requestedModel = request.model || defaultModel || 'openai/gpt-4o-mini';
    const platformModel = provider === 'ultralight'
      ? resolvePlatformInferenceModel(requestedModel)
      : null;
    const model = platformModel && platformModel.upstreamProvider === upstreamProvider
      ? platformModel.upstreamModel
      : provider === 'ultralight' && upstreamProvider === 'openrouter' && platformModel
      ? platformModel.aliases.find((alias) => alias.includes('/')) || requestedModel
      : provider === 'ultralight' && upstreamProvider !== 'openrouter'
      ? defaultModel || requestedModel
      : requestedModel;
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ultralight.dev',
        'X-Title': 'Ultralight',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: request.max_tokens || 4096,
        temperature: request.temperature ?? 0.7,
        ...(requestDefaults ?? {}),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        content: '',
        model,
        usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
        error: `AI call failed (${response.status}): ${errText}`,
      };
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      };
    };
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
