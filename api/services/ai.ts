// AI Service Implementation (BYOK)
// OpenAI-compatible provider adapter for first-tier BYOK providers.

import type { AIRequest, AIResponse, AIContentPart } from '../../shared/contracts/ai.ts';
import type { ActiveBYOKProvider, BYOKProvider } from '../../shared/types/index.ts';
import { BYOK_PROVIDERS, isActiveBYOKProvider } from '../../shared/types/index.ts';

// ============================================
// TYPES
// ============================================

export interface AIServiceConfig {
  provider: BYOKProvider;
  apiKey: string;
  defaultModel?: string;
  requestDefaults?: Record<string, unknown>;
}

interface ProviderConfig {
  baseUrl: string;
  defaultModel: string;
  formatRequest: (request: AIRequest, model: string) => unknown;
  formatHeaders: (apiKey: string) => Record<string, string>;
  parseResponse: (data: unknown) => AIResponse;
  endpoint: string;
}

// ============================================
// MULTIMODAL CONTENT TRANSLATION
// ============================================

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'html', 'htm', 'css', 'js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'sql', 'toml', 'ini', 'cfg', 'log', 'env']);

function getExtension(filename?: string): string {
  if (!filename) return '';
  return (filename.split('.').pop() || '').toLowerCase();
}

function getMimeFromDataUrl(data: string): string {
  const match = data.match(/^data:([^;,]+)/);
  return match ? match[1] : '';
}

/**
 * Translate Ultralight AIContentPart[] to OpenAI/OpenRouter-compatible content array.
 * - type:'text' → { type:'text', text }
 * - type:'file' + image → { type:'image_url', image_url: { url: dataUrl } }
 * - type:'file' + text file → { type:'text', text: decoded content }
 * - type:'file' + PDF/other → { type:'image_url', image_url: { url: dataUrl } } (let model handle)
 */
function translateContentParts(parts: AIContentPart[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text });
      continue;
    }

    if (part.type === 'file') {
      const ext = getExtension(part.filename);
      const mime = getMimeFromDataUrl(part.data);
      const isImage = IMAGE_EXTS.has(ext) || mime.startsWith('image/');
      const isText = TEXT_EXTS.has(ext) || mime.startsWith('text/');

      if (isImage) {
        // Images → image_url (native vision support)
        const url = part.data.startsWith('data:') ? part.data : `data:image/${ext || 'png'};base64,${part.data}`;
        out.push({ type: 'image_url', image_url: { url } });
      } else if (isText) {
        // Text files → decode and inline as text block
        let text = '';
        if (part.data.startsWith('data:')) {
          try {
            const b64 = part.data.split(',')[1];
            if (b64) text = atob(b64);
          } catch { text = part.data; }
        } else {
          text = part.data;
        }
        const label = part.filename ? `[File: ${part.filename}]\n` : '';
        out.push({ type: 'text', text: label + text });
      } else {
        // PDF, DOCX, etc. → send as image_url and let the model/provider handle it.
        // OpenRouter passes data URLs through to models that support document vision.
        const url = part.data.startsWith('data:') ? part.data : `data:application/octet-stream;base64,${part.data}`;
        const label = part.filename ? `[Attached: ${part.filename}]` : '';
        if (label) out.push({ type: 'text', text: label });
        out.push({ type: 'image_url', image_url: { url } });
      }
    }
  }

  return out;
}

// ============================================
// PROVIDER CONFIGURATION
// ============================================

const formatOpenAICompatibleHeaders = (apiKey: string): Record<string, string> => ({
  'Authorization': `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://ultralight-api.rgn4jz429m.workers.dev',
  'X-Title': 'Ultralight',
});

const formatOpenAICompatibleRequest = (request: AIRequest, model: string): unknown => ({
  model,
  messages: request.messages.map(msg => {
    const m: Record<string, unknown> = { role: msg.role };
    if (msg.cache_control) m.cache_control = msg.cache_control;

    // String content — pass through as-is
    if (typeof msg.content === 'string') {
      m.content = msg.content;
      return m;
    }

    // Array content — translate to OpenAI-compatible multimodal format
    if (Array.isArray(msg.content)) {
      m.content = translateContentParts(msg.content as AIContentPart[]);
      return m;
    }

    m.content = msg.content;
    return m;
  }),
  temperature: request.temperature ?? 0.7,
  max_tokens: request.max_tokens,
  tools: request.tools,
});

const parseOpenAICompatibleResponse = (data: unknown): AIResponse => {
  const d = data as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
    };
  };
  return {
    content: d.choices?.[0]?.message?.content || '',
    model: d.model || 'unknown',
    usage: {
      input_tokens: d.usage?.prompt_tokens || 0,
      output_tokens: d.usage?.completion_tokens || 0,
      cost_light: 0,
      prompt_cache_hit_tokens: d.usage?.prompt_cache_hit_tokens,
      prompt_cache_miss_tokens: d.usage?.prompt_cache_miss_tokens,
    },
  };
};

function createOpenAICompatibleConfig(provider: keyof typeof BYOK_PROVIDERS): ProviderConfig {
  const info = BYOK_PROVIDERS[provider];
  return {
    baseUrl: info.baseUrl,
    endpoint: '/chat/completions',
    defaultModel: info.defaultModel,
    formatHeaders: formatOpenAICompatibleHeaders,
    formatRequest: formatOpenAICompatibleRequest,
    parseResponse: parseOpenAICompatibleResponse,
  };
}

const OPENROUTER_CONFIG: ProviderConfig = {
  ...createOpenAICompatibleConfig('openrouter'),
  formatHeaders: (apiKey: string) => ({
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://ultralight-api.rgn4jz429m.workers.dev',
    'X-Title': 'Ultralight',
  }),
};

// Active providers use the shared OpenAI-compatible adapter. Legacy provider
// values still resolve to OpenRouter so old rows do not crash runtime paths.
const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  openrouter: OPENROUTER_CONFIG,
  openai: createOpenAICompatibleConfig('openai'),
  deepseek: createOpenAICompatibleConfig('deepseek'),
  nvidia: createOpenAICompatibleConfig('nvidia'),
  google: createOpenAICompatibleConfig('google'),
  xai: createOpenAICompatibleConfig('xai'),
  anthropic: OPENROUTER_CONFIG,
  moonshot: OPENROUTER_CONFIG,
};

// ============================================
// AI SERVICE CLASS
// ============================================

export class AIService {
  private provider: BYOKProvider;
  private apiKey: string;
  private defaultModel: string;
  private requestDefaults: Record<string, unknown>;

  constructor(config: AIServiceConfig) {
    this.provider = config.provider;
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel ||
      (isActiveBYOKProvider(config.provider)
        ? BYOK_PROVIDERS[config.provider].defaultModel
        : OPENROUTER_CONFIG.defaultModel);
    this.requestDefaults = config.requestDefaults ?? {};
  }

  /**
   * Make an AI call using the configured OpenAI-compatible provider.
   */
  async call(request: AIRequest): Promise<AIResponse> {
    const providerConfig = PROVIDER_CONFIGS[this.provider] || OPENROUTER_CONFIG;
    const model = request.model || this.defaultModel;

    const url = `${providerConfig.baseUrl.replace(/\/$/, '')}${providerConfig.endpoint}`;
    const headers = providerConfig.formatHeaders(this.apiKey);
    const formattedBody = providerConfig.formatRequest(request, model);
    const body = typeof formattedBody === 'object' && formattedBody !== null
      ? { ...(formattedBody as Record<string, unknown>), ...this.requestDefaults }
      : formattedBody;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;

      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorText;
      } catch {
        errorMessage = errorText;
      }

      throw new Error(`AI provider error (${response.status}): ${errorMessage}`);
    }

    const data = await response.json();
    return providerConfig.parseResponse(data);
  }

  /**
   * Get the current provider
   */
  getProvider(): BYOKProvider {
    return this.provider;
  }

  /**
   * Get the default model for this service
   */
  getDefaultModel(): string {
    return this.defaultModel;
  }
}

// ============================================
// FACTORY FUNCTIONS
// ============================================

/**
 * Create an AI service for a specific provider with an API key.
 * Active providers route through their configured OpenAI-compatible base URL.
 */
export function createAIService(
  provider: BYOKProvider = 'openrouter',
  apiKey: string = '',
  defaultModel?: string,
  requestDefaults?: Record<string, unknown>,
): AIService {
  return new AIService({
    provider,
    apiKey,
    defaultModel,
    requestDefaults,
  });
}

/**
 * Validate an API key by making a minimal request
 * Returns true if the key is valid, throws an error otherwise
 */
export async function validateAPIKey(provider: BYOKProvider, apiKey: string): Promise<boolean> {
  const service = createAIService(provider, apiKey);

  try {
    // Make a minimal request to validate the key
    await service.call({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    });
    return true;
  } catch (error) {
    // Check if it's an auth error vs other error
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (normalized.includes('401') || normalized.includes('403') || normalized.includes('invalid') || normalized.includes('unauthorized')) {
      throw new Error(`Invalid API key for ${provider}`);
    }
    // For other errors (rate limit, etc), assume key is valid
    return true;
  }
}

/**
 * Get the list of supported providers
 */
export function getSupportedProviders(): ActiveBYOKProvider[] {
  return Object.keys(BYOK_PROVIDERS) as ActiveBYOKProvider[];
}

/**
 * Get the default model for a provider
 */
export function getDefaultModel(provider: BYOKProvider): string {
  return isActiveBYOKProvider(provider)
    ? BYOK_PROVIDERS[provider].defaultModel
    : OPENROUTER_CONFIG.defaultModel;
}
