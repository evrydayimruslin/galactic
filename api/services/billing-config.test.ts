import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  DEFAULT_BILLING_CONFIG,
  lightToUsdCents,
  normalizeBillingConfigRow,
  toPublicBillingConfig,
  usdCentsToLight,
} from "./billing-config.ts";

Deno.test("billing config: defaults encode current Light economics", () => {
  assertEquals(DEFAULT_BILLING_CONFIG.canonicalLightPerUsd, 100);
  assertEquals(DEFAULT_BILLING_CONFIG.walletLightPerUsd, 95);
  assertEquals(DEFAULT_BILLING_CONFIG.wireLightPerUsd, 99);
  assertEquals(DEFAULT_BILLING_CONFIG.payoutLightPerUsd, 100);
});

Deno.test("billing config: row normalization falls back only for invalid values", () => {
  const config = normalizeBillingConfigRow({
    id: "singleton",
    version: 3,
    canonical_light_per_usd: 100,
    wallet_light_per_usd: 95,
    wire_light_per_usd: 99,
    payout_light_per_usd: 0,
    platform_fee_rate: 0.12,
    min_withdrawal_light: 6000,
    payout_policy_copy: "Monthly payouts.",
    updated_at: "2026-04-30T00:00:00Z",
  });

  assertEquals(config.version, 3);
  assertEquals(config.walletLightPerUsd, 95);
  assertEquals(config.payoutLightPerUsd, 100);
  assertEquals(config.platformFeeRate, 0.12);
  assertEquals(config.minWithdrawalLight, 6000);
  assertEquals(config.payoutPolicyCopy, "Monthly payouts.");
});

Deno.test("billing config: conversion helpers use supplied rate snapshots", () => {
  assertEquals(usdCentsToLight(2500, 95), 2375);
  assertEquals(usdCentsToLight(2500, 99), 2475);
  assertEquals(lightToUsdCents(5000, 100), 5000);
});

Deno.test("billing config: public shape includes human-readable labels", () => {
  const publicConfig = toPublicBillingConfig(DEFAULT_BILLING_CONFIG);
  assertEquals(publicConfig.labels.wallet_rate, "95 Light / $1");
  assertEquals(publicConfig.labels.wire_rate, "99 Light / $1");
  assertEquals(publicConfig.labels.payout_rate, "100 Light = $1");
  assertEquals(publicConfig.min_publish_deposit_light, 500);
  assertEquals(publicConfig.labels.publish_deposit, "✦500");
  assertEquals(publicConfig.labels.hosting_rate, "✦2.25/MB/hr");
  assertEquals(publicConfig.labels.data_rate, "✦0.045/MB/hr");
  assertEquals(publicConfig.policy_copy.termsUrl, "/terms");
  assertEquals(
    publicConfig.policy_copy.purchasedLight.includes("cannot be cashed out"),
    true,
  );
  assertEquals(
    publicConfig.policy_copy.fundingTerms.includes(
      "authenticated funding transactions",
    ),
    true,
  );
});
