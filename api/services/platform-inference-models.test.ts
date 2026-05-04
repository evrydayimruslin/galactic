import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  calculatePlatformInferenceCost,
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_THINKING_DISABLED_REQUEST_DEFAULTS,
  DEEPSEEK_V4_PRO_DISCOUNT_EXPIRES_AT,
  getDeepSeekDirectPricingSnapshot,
  isPlatformInferenceModel,
  normalizePlatformInferenceModelId,
  PLATFORM_INFERENCE_MODELS,
  resolvePlatformInferenceModel,
  ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL,
  ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
} from "./platform-inference-models.ts";

Deno.test("platform inference models: canonical Ultralight ids and legacy aliases normalize together", () => {
  assertEquals(
    normalizePlatformInferenceModelId("ultralight/deepseek-v4-flash"),
    ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL,
  );
  assertEquals(
    normalizePlatformInferenceModelId("deepseek/deepseek-v4-flash"),
    ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL,
  );
  assertEquals(
    normalizePlatformInferenceModelId("deepseek-v4-flash"),
    ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL,
  );
  assertEquals(
    normalizePlatformInferenceModelId("deepseek/deepseek-v4-pro"),
    ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
  );
  assertEquals(normalizePlatformInferenceModelId("openai/gpt-4o-mini"), null);
  assertEquals(isPlatformInferenceModel("ultralight/deepseek-v4-pro"), true);
  assertEquals(isPlatformInferenceModel("google/gemini-3-flash-preview"), false);
});

Deno.test("platform inference models: direct DeepSeek entries carry upstream metadata and disable thinking", () => {
  const flash = resolvePlatformInferenceModel("deepseek/deepseek-v4-flash");
  const pro = resolvePlatformInferenceModel(ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL);

  assertEquals(PLATFORM_INFERENCE_MODELS.length, 2);
  assertEquals(flash?.provider, "ultralight");
  assertEquals(flash?.upstreamProvider, "deepseek");
  assertEquals(flash?.upstreamModel, "deepseek-v4-flash");
  assertEquals(flash?.baseUrl, DEEPSEEK_API_BASE_URL);
  assertEquals(flash?.keySource, "platform_deepseek");
  assertEquals(flash?.apiKeyEnv, "DEEPSEEK_API_KEY");
  assertEquals(flash?.requestDefaults, DEEPSEEK_THINKING_DISABLED_REQUEST_DEFAULTS);

  assertEquals(pro?.upstreamModel, "deepseek-v4-pro");
  assertEquals(pro?.requestDefaults, DEEPSEEK_THINKING_DISABLED_REQUEST_DEFAULTS);
});

Deno.test("platform inference pricing: DeepSeek V4 Flash uses direct cache-aware Light pricing", () => {
  const cost = calculatePlatformInferenceCost(
    ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL,
    {
      promptTokens: 1_000_000,
      promptCacheHitTokens: 250_000,
      promptCacheMissTokens: 750_000,
      completionTokens: 500_000,
    },
  );

  assertEquals(cost.inputCacheHitUsd, 0.0007);
  assertEquals(cost.inputCacheMissUsd, 0.105);
  assertEquals(cost.outputUsd, 0.14);
  assertEquals(cost.totalUsd, 0.2457);
  assertEquals(cost.totalLight, 24.57);
  assertEquals(cost.listPrice, true);
});

Deno.test("platform inference pricing: missing DeepSeek cache fields conservatively treats prompt tokens as misses", () => {
  const cost = calculatePlatformInferenceCost(
    "deepseek-v4-flash",
    {
      promptTokens: 1_000,
      completionTokens: 1_000,
    },
  );

  assertEquals(cost.canonicalModelId, ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL);
  assertEquals(cost.promptCacheHitTokens, 0);
  assertEquals(cost.promptCacheMissTokens, 1_000);
  assertEquals(cost.completionTokens, 1_000);
  assertEquals(cost.totalUsd, 0.00042);
  assertEquals(cost.totalLight, 0.042);
});

Deno.test("platform inference pricing: DeepSeek V4 Pro discount expires exactly at the encoded cutoff", () => {
  const beforeCutoff = new Date(Date.parse(DEEPSEEK_V4_PRO_DISCOUNT_EXPIRES_AT) - 1);
  const atCutoff = new Date(DEEPSEEK_V4_PRO_DISCOUNT_EXPIRES_AT);

  const discounted = getDeepSeekDirectPricingSnapshot(
    "deepseek_v4_pro_direct",
    beforeCutoff,
  );
  const list = getDeepSeekDirectPricingSnapshot(
    "deepseek_v4_pro_direct",
    atCutoff,
  );

  assertEquals(discounted.validUntil, DEEPSEEK_V4_PRO_DISCOUNT_EXPIRES_AT);
  assertEquals(discounted.listPrice, false);
  assertEquals(discounted.cacheHitInputUsdPerMillion, 0.003625);
  assertEquals(discounted.cacheMissInputUsdPerMillion, 0.435);
  assertEquals(discounted.outputUsdPerMillion, 0.87);

  assertEquals(list.validUntil, null);
  assertEquals(list.listPrice, true);
  assertEquals(list.cacheHitInputUsdPerMillion, 0.0145);
  assertEquals(list.cacheMissInputUsdPerMillion, 1.74);
  assertEquals(list.outputUsdPerMillion, 3.48);
});

Deno.test("platform inference pricing: DeepSeek V4 Pro switches Light charges after discount expiration", () => {
  const usage = {
    promptTokens: 1_000_000,
    promptCacheHitTokens: 200_000,
    promptCacheMissTokens: 800_000,
    completionTokens: 100_000,
  };

  const discounted = calculatePlatformInferenceCost(
    ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
    usage,
    { now: new Date("2026-05-31T15:58:59.999Z") },
  );
  const list = calculatePlatformInferenceCost(
    ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
    usage,
    { now: new Date("2026-05-31T15:59:00.000Z") },
  );

  assertEquals(discounted.totalUsd, 0.435725);
  assertEquals(discounted.totalLight, 43.5725);
  assertEquals(discounted.listPrice, false);
  assertEquals(discounted.pricingValidUntil, DEEPSEEK_V4_PRO_DISCOUNT_EXPIRES_AT);

  assertEquals(list.totalUsd, 1.7429);
  assertEquals(list.totalLight, 174.29);
  assertEquals(list.listPrice, true);
  assertEquals(list.pricingValidUntil, null);
});
