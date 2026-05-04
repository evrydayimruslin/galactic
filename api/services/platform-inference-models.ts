import { LIGHT_PER_DOLLAR_DESKTOP } from "../../shared/types/index.ts";

export type PlatformInferenceProvider = "ultralight";
export type PlatformInferenceUpstreamProvider = "deepseek" | "openrouter";
export type PlatformInferenceKeySource = "platform_deepseek" | "platform_openrouter";
export type PlatformInferencePricingPolicy =
  | "deepseek_v4_flash_direct"
  | "deepseek_v4_pro_direct";

export interface PlatformInferenceRequestDefaults extends Record<string, unknown> {
  /** DeepSeek V4 thinking mode is disabled until our tool loop preserves reasoning_content. */
  thinking?: { type: "disabled" };
}

export interface PlatformInferenceModel {
  id: string;
  aliases: readonly string[];
  name: string;
  provider: PlatformInferenceProvider;
  upstreamProvider: PlatformInferenceUpstreamProvider;
  upstreamModel: string;
  baseUrl: string;
  keySource: PlatformInferenceKeySource;
  apiKeyEnv?: "DEEPSEEK_API_KEY";
  contextWindow: number;
  pricingPolicy: PlatformInferencePricingPolicy;
  requestDefaults?: PlatformInferenceRequestDefaults;
}

export interface DeepSeekDirectPricingSnapshot {
  policy: PlatformInferencePricingPolicy;
  label: string;
  cacheHitInputUsdPerMillion: number;
  cacheMissInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  effectiveAt: string;
  validUntil: string | null;
  listPrice: boolean;
}

export interface PlatformInferenceTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

export interface PlatformInferenceCostBreakdown {
  modelId: string;
  canonicalModelId: string;
  upstreamProvider: PlatformInferenceUpstreamProvider;
  upstreamModel: string;
  pricingPolicy: PlatformInferencePricingPolicy;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  completionTokens: number;
  inputCacheHitUsd: number;
  inputCacheMissUsd: number;
  outputUsd: number;
  totalUsd: number;
  totalLight: number;
  lightPerDollar: number;
  listPrice: boolean;
  pricingValidUntil: string | null;
}

export const ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL = "ultralight/deepseek-v4-flash";
export const ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL = "ultralight/deepseek-v4-pro";
export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_V4_PRO_DISCOUNT_EXPIRES_AT = "2026-05-31T15:59:00Z";

export const DEEPSEEK_THINKING_DISABLED_REQUEST_DEFAULTS: PlatformInferenceRequestDefaults = {
  thinking: { type: "disabled" },
};

export const PLATFORM_INFERENCE_MODELS = [
  {
    id: ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL,
    aliases: [
      "deepseek/deepseek-v4-flash",
      "deepseek-v4-flash",
    ],
    name: "DeepSeek V4 Flash",
    provider: "ultralight",
    upstreamProvider: "deepseek",
    upstreamModel: "deepseek-v4-flash",
    baseUrl: DEEPSEEK_API_BASE_URL,
    keySource: "platform_deepseek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 1_048_576,
    pricingPolicy: "deepseek_v4_flash_direct",
    requestDefaults: DEEPSEEK_THINKING_DISABLED_REQUEST_DEFAULTS,
  },
  {
    id: ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
    aliases: [
      "deepseek/deepseek-v4-pro",
      "deepseek-v4-pro",
    ],
    name: "DeepSeek V4 Pro",
    provider: "ultralight",
    upstreamProvider: "deepseek",
    upstreamModel: "deepseek-v4-pro",
    baseUrl: DEEPSEEK_API_BASE_URL,
    keySource: "platform_deepseek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 1_048_576,
    pricingPolicy: "deepseek_v4_pro_direct",
    requestDefaults: DEEPSEEK_THINKING_DISABLED_REQUEST_DEFAULTS,
  },
] as const satisfies readonly PlatformInferenceModel[];

const MODEL_BY_ID = new Map<string, PlatformInferenceModel>();

for (const model of PLATFORM_INFERENCE_MODELS) {
  MODEL_BY_ID.set(model.id, model);
  for (const alias of model.aliases) {
    MODEL_BY_ID.set(alias, model);
  }
}

function toFiniteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function roundLight(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function isBefore(instant: Date, iso: string): boolean {
  return instant.getTime() < Date.parse(iso);
}

export function normalizePlatformInferenceModelId(modelId: string): string | null {
  return MODEL_BY_ID.get(modelId)?.id ?? null;
}

export function resolvePlatformInferenceModel(modelId: string): PlatformInferenceModel | null {
  return MODEL_BY_ID.get(modelId) ?? null;
}

export function isPlatformInferenceModel(modelId: string): boolean {
  return MODEL_BY_ID.has(modelId);
}

export function getDeepSeekDirectPricingSnapshot(
  policy: PlatformInferencePricingPolicy,
  now: Date = new Date(),
): DeepSeekDirectPricingSnapshot {
  if (policy === "deepseek_v4_flash_direct") {
    return {
      policy,
      label: "DeepSeek V4 Flash direct",
      cacheHitInputUsdPerMillion: 0.0028,
      cacheMissInputUsdPerMillion: 0.14,
      outputUsdPerMillion: 0.28,
      effectiveAt: "2026-04-28T00:00:00Z",
      validUntil: null,
      listPrice: true,
    };
  }

  if (isBefore(now, DEEPSEEK_V4_PRO_DISCOUNT_EXPIRES_AT)) {
    return {
      policy,
      label: "DeepSeek V4 Pro direct discounted",
      cacheHitInputUsdPerMillion: 0.003625,
      cacheMissInputUsdPerMillion: 0.435,
      outputUsdPerMillion: 0.87,
      effectiveAt: "2026-04-28T00:00:00Z",
      validUntil: DEEPSEEK_V4_PRO_DISCOUNT_EXPIRES_AT,
      listPrice: false,
    };
  }

  return {
    policy,
    label: "DeepSeek V4 Pro direct list",
    cacheHitInputUsdPerMillion: 0.0145,
    cacheMissInputUsdPerMillion: 1.74,
    outputUsdPerMillion: 3.48,
    effectiveAt: DEEPSEEK_V4_PRO_DISCOUNT_EXPIRES_AT,
    validUntil: null,
    listPrice: true,
  };
}

export function calculatePlatformInferenceCost(
  modelId: string,
  usage: PlatformInferenceTokenUsage,
  options: { now?: Date; lightPerDollar?: number } = {},
): PlatformInferenceCostBreakdown {
  const model = resolvePlatformInferenceModel(modelId);
  if (!model) {
    throw new Error(`Unsupported Ultralight platform model: ${modelId}`);
  }

  const pricing = getDeepSeekDirectPricingSnapshot(
    model.pricingPolicy,
    options.now ?? new Date(),
  );
  const promptTokens = toFiniteNonNegative(usage.promptTokens);
  const explicitHitTokens = toFiniteNonNegative(usage.promptCacheHitTokens);
  const promptCacheMissTokens = usage.promptCacheMissTokens === undefined
    ? Math.max(promptTokens - explicitHitTokens, 0)
    : toFiniteNonNegative(usage.promptCacheMissTokens);
  const promptCacheHitTokens = explicitHitTokens;
  const completionTokens = toFiniteNonNegative(usage.completionTokens);

  const inputCacheHitUsd = (promptCacheHitTokens / 1_000_000) *
    pricing.cacheHitInputUsdPerMillion;
  const inputCacheMissUsd = (promptCacheMissTokens / 1_000_000) *
    pricing.cacheMissInputUsdPerMillion;
  const outputUsd = (completionTokens / 1_000_000) *
    pricing.outputUsdPerMillion;
  const totalUsd = inputCacheHitUsd + inputCacheMissUsd + outputUsd;
  const lightPerDollar = options.lightPerDollar ?? LIGHT_PER_DOLLAR_DESKTOP;

  return {
    modelId,
    canonicalModelId: model.id,
    upstreamProvider: model.upstreamProvider,
    upstreamModel: model.upstreamModel,
    pricingPolicy: model.pricingPolicy,
    promptCacheHitTokens,
    promptCacheMissTokens,
    completionTokens,
    inputCacheHitUsd: roundUsd(inputCacheHitUsd),
    inputCacheMissUsd: roundUsd(inputCacheMissUsd),
    outputUsd: roundUsd(outputUsd),
    totalUsd: roundUsd(totalUsd),
    totalLight: roundLight(totalUsd * lightPerDollar),
    lightPerDollar,
    listPrice: pricing.listPrice,
    pricingValidUntil: pricing.validUntil,
  };
}
