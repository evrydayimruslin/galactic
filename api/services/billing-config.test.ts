import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  DEFAULT_BILLING_CONFIG,
  lightToUsdCents,
  normalizeBillingConfigRow,
  toPublicBillingConfig,
  usdCentsToLight,
} from "./billing-config.ts";

Deno.test("billing config: defaults encode current credits economics", () => {
  assertEquals(DEFAULT_BILLING_CONFIG.canonicalLightPerUsd, 100);
  assertEquals(DEFAULT_BILLING_CONFIG.walletLightPerUsd, 100);
  assertEquals(DEFAULT_BILLING_CONFIG.wireLightPerUsd, 100);
  assertEquals(DEFAULT_BILLING_CONFIG.payoutLightPerUsd, 100);
  assertEquals(DEFAULT_BILLING_CONFIG.platformFeeRate, 0.15);
  assertEquals(DEFAULT_BILLING_CONFIG.cardMinimumCents, 2500);
  assertEquals(DEFAULT_BILLING_CONFIG.wireMinimumCents, 2500);
  assertEquals(DEFAULT_BILLING_CONFIG.cloudUnitLightPer1k, 1);
  assertEquals(DEFAULT_BILLING_CONFIG.workerMsPerCloudUnit, 250);
  assertEquals(DEFAULT_BILLING_CONFIG.workerRequestLightPerInvocation, 0.00003);
  assertEquals(DEFAULT_BILLING_CONFIG.capacityRateCardVersion, 1);
  assertEquals(DEFAULT_BILLING_CONFIG.capacityD1ReadLightPerMillionRows, 0.1);
  assertEquals(DEFAULT_BILLING_CONFIG.capacityD1WriteLightPerMillionRows, 100);
  assertEquals(
    DEFAULT_BILLING_CONFIG.capacityKvReadLightPerMillionOperations,
    50,
  );
  assertEquals(
    DEFAULT_BILLING_CONFIG.capacityKvWriteLightPerMillionOperations,
    500,
  );
  assertEquals(
    DEFAULT_BILLING_CONFIG.capacityKvDeleteLightPerMillionOperations,
    500,
  );
  assertEquals(
    DEFAULT_BILLING_CONFIG.capacityKvListLightPerMillionOperations,
    500,
  );
  assertEquals(
    DEFAULT_BILLING_CONFIG.capacityR2ClassALightPerMillionOperations,
    450,
  );
  assertEquals(
    DEFAULT_BILLING_CONFIG.capacityR2ClassBLightPerMillionOperations,
    36,
  );
  assertEquals(
    DEFAULT_BILLING_CONFIG.capacityR2DeleteLightPerMillionOperations,
    0,
  );
  assertEquals(
    DEFAULT_BILLING_CONFIG.capacityQueueLightPerMillionOperations,
    40,
  );
  assertEquals(DEFAULT_BILLING_CONFIG.d1ReadRowsPerCloudUnit, 100);
  assertEquals(DEFAULT_BILLING_CONFIG.d1WriteRowsPerCloudUnit, 1);
  assertEquals(DEFAULT_BILLING_CONFIG.r2OpsPerCloudUnit, 1);
  assertEquals(DEFAULT_BILLING_CONFIG.kvOpsPerCloudUnit, 1);
  assertEquals(DEFAULT_BILLING_CONFIG.widgetPullsPerCloudUnit, 1);
  assertEquals(DEFAULT_BILLING_CONFIG.storageFreeBytes, 104857600);
  assertEquals(DEFAULT_BILLING_CONFIG.storageLightPerGbMonth, 100);
  assertEquals(DEFAULT_BILLING_CONFIG.publishDepositEnabled, true);
  assertEquals(DEFAULT_BILLING_CONFIG.publisherMinPublishBalanceLight, 1000);
  assertEquals(DEFAULT_BILLING_CONFIG.publishedHostingMeterEnabled, false);
});

Deno.test("billing config: row normalization falls back only for invalid values", () => {
  const config = normalizeBillingConfigRow({
    id: "singleton",
    version: 3,
    canonical_light_per_usd: 100,
    wallet_light_per_usd: 100,
    wire_light_per_usd: 100,
    payout_light_per_usd: 0,
    platform_fee_rate: 0.12,
    min_withdrawal_light: 6000,
    card_minimum_cents: 2500,
    wire_minimum_cents: 2500,
    cloud_unit_light_per_1k: 2,
    worker_ms_per_cloud_unit: 500,
    worker_request_light_per_invocation: 0.00006,
    capacity_rate_card_version: 2,
    capacity_d1_read_light_per_million_rows: 0.2,
    capacity_d1_write_light_per_million_rows: 200,
    capacity_kv_read_light_per_million_operations: 60,
    capacity_kv_write_light_per_million_operations: 600,
    capacity_kv_delete_light_per_million_operations: 610,
    capacity_kv_list_light_per_million_operations: 620,
    capacity_r2_class_a_light_per_million_operations: 460,
    capacity_r2_class_b_light_per_million_operations: 46,
    capacity_r2_delete_light_per_million_operations: 0,
    capacity_queue_light_per_million_operations: 45,
    d1_read_rows_per_cloud_unit: 200,
    d1_write_rows_per_cloud_unit: 1,
    r2_ops_per_cloud_unit: 2,
    kv_ops_per_cloud_unit: 2,
    widget_pulls_per_cloud_unit: 1,
    storage_free_bytes: 209715200,
    storage_light_per_gb_month: 75,
    publish_deposit_enabled: true,
    publisher_min_publish_balance_light: 1500,
    published_hosting_meter_enabled: false,
    payout_policy_copy: "Monthly payouts.",
    updated_at: "2026-04-30T00:00:00Z",
  });

  assertEquals(config.version, 3);
  assertEquals(config.walletLightPerUsd, 100);
  assertEquals(config.payoutLightPerUsd, 100);
  assertEquals(config.platformFeeRate, 0.12);
  assertEquals(config.minWithdrawalLight, 6000);
  assertEquals(config.cardMinimumCents, 2500);
  assertEquals(config.wireMinimumCents, 2500);
  assertEquals(config.cloudUnitLightPer1k, 2);
  assertEquals(config.workerMsPerCloudUnit, 500);
  assertEquals(config.workerRequestLightPerInvocation, 0.00006);
  assertEquals(config.capacityRateCardVersion, 2);
  assertEquals(config.capacityD1ReadLightPerMillionRows, 0.2);
  assertEquals(config.capacityD1WriteLightPerMillionRows, 200);
  assertEquals(config.capacityKvReadLightPerMillionOperations, 60);
  assertEquals(config.capacityKvWriteLightPerMillionOperations, 600);
  assertEquals(config.capacityKvDeleteLightPerMillionOperations, 610);
  assertEquals(config.capacityKvListLightPerMillionOperations, 620);
  assertEquals(config.capacityR2ClassALightPerMillionOperations, 460);
  assertEquals(config.capacityR2ClassBLightPerMillionOperations, 46);
  assertEquals(config.capacityR2DeleteLightPerMillionOperations, 0);
  assertEquals(config.capacityQueueLightPerMillionOperations, 45);
  assertEquals(config.d1ReadRowsPerCloudUnit, 200);
  assertEquals(config.r2OpsPerCloudUnit, 2);
  assertEquals(config.storageFreeBytes, 209715200);
  assertEquals(config.storageLightPerGbMonth, 75);
  assertEquals(config.publishDepositEnabled, true);
  assertEquals(config.publisherMinPublishBalanceLight, 1500);
  assertEquals(config.publishedHostingMeterEnabled, false);
  assertEquals(config.payoutPolicyCopy, "Monthly payouts.");
});

Deno.test("billing config: conversion helpers use supplied rate snapshots", () => {
  assertEquals(usdCentsToLight(2500, 100), 2500);
  assertEquals(usdCentsToLight(2500, 100), 2500);
  assertEquals(lightToUsdCents(5000, 100), 5000);
});

Deno.test("billing config: public shape includes human-readable labels", () => {
  const publicConfig = toPublicBillingConfig(DEFAULT_BILLING_CONFIG);
  assertEquals(publicConfig.labels.wallet_rate, "100 credits / $1");
  assertEquals(publicConfig.labels.wire_rate, "100 credits / $1");
  assertEquals(publicConfig.labels.ach_rate, "100 credits / $1");
  assertEquals(publicConfig.labels.payout_rate, "100 credits = $1");
  assertEquals(publicConfig.card_minimum_cents, 2500);
  assertEquals(publicConfig.wire_minimum_cents, 2500);
  assertEquals(publicConfig.ach_light_per_usd, 100);
  assertEquals(publicConfig.ach_minimum_cents, 2500);
  assertEquals(publicConfig.cloud_unit_light_per_1k, 1);
  assertEquals(publicConfig.worker_ms_per_cloud_unit, 250);
  assertEquals(publicConfig.worker_request_light_per_invocation, 0.00003);
  assertEquals(publicConfig.storage_free_bytes, 104857600);
  assertEquals(publicConfig.storage_light_per_gb_month, 100);
  assertEquals(publicConfig.publish_deposit_enabled, true);
  assertEquals(publicConfig.publisher_min_publish_balance_light, 1000);
  assertEquals(publicConfig.published_hosting_meter_enabled, false);
  assertEquals(publicConfig.labels.card_minimum, "$25.00");
  assertEquals(publicConfig.labels.wire_minimum, "$25.00");
  assertEquals(publicConfig.labels.ach_minimum, "$25.00");
  assertEquals(publicConfig.labels.cloud_unit_rate, "✦1 / 1,000 cloud units");
  assertEquals(
    publicConfig.labels.worker_unit,
    "1 cloud unit per started 250ms",
  );
  assertEquals(
    publicConfig.labels.storage_at_rest,
    "✦100 / GB-month after 100MB free",
  );
  assertEquals(publicConfig.labels.publisher_min_publish_balance, "✦1,000");
  assertEquals(Object.hasOwn(publicConfig, "min_publish_deposit_light"), false);
  assertEquals(Object.hasOwn(publicConfig.labels, "hosting_rate"), false);
  assertEquals(Object.hasOwn(publicConfig.labels, "data_rate"), false);
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
  assertEquals(
    publicConfig.policy_copy.cloudUsage.includes("exact fractional credits"),
    true,
  );
  assertEquals(
    publicConfig.policy_copy.storagePolicy.includes("100MB"),
    true,
  );
  assertEquals(
    publicConfig.policy_copy.freeCallSponsorship.includes(
      "caller needs credits balance",
    ),
    true,
  );
});
