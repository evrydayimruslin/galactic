import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  DEFAULT_BILLING_CONFIG,
  toPublicBillingConfig,
} from "./billing-config.ts";
import {
  validateEarningsConversionRequest,
  validateWalletFundingRequest,
  validateWireFundingRequest,
  validateWithdrawalRequest,
} from "./platform-request-validation.ts";
import { RequestValidationError } from "./request-validation.ts";

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("payments launch QA: public config states closed-loop Light economics", () => {
  const config = toPublicBillingConfig(DEFAULT_BILLING_CONFIG);

  assertEquals(config.canonical_light_per_usd, 100);
  assertEquals(config.wallet_light_per_usd, 95);
  assertEquals(config.wire_light_per_usd, 99);
  assertEquals(config.payout_light_per_usd, 100);
  assertEquals(config.platform_fee_rate, 0.15);
  assertEquals(config.card_minimum_cents, 2500);
  assertEquals(config.wire_minimum_cents, 2500);
  assertEquals(config.cloud_unit_light_per_1k, 1);
  assertEquals(config.storage_light_per_gb_month, 100);
  assertEquals(config.publish_deposit_enabled, true);
  assertEquals(config.published_hosting_meter_enabled, false);
  assertEquals(config.labels.payout_rate, "100 Light = $1");
  assertEquals(config.labels.cloud_unit_rate, "✦1 / 1,000 cloud units");
  assertEquals(
    config.labels.storage_at_rest,
    "✦100 / GB-month after 100MB free",
  );
  assertEquals(Object.hasOwn(config, "min_publish_deposit_light"), false);
  assertEquals(Object.hasOwn(config.labels, "hosting_rate"), false);
  assert(
    config.payout_policy_copy.includes("Purchased Light cannot be cashed out"),
  );
  assert(config.policy_copy.purchasedLight.includes("cannot be cashed out"));
  assert(config.policy_copy.purchasedLight.includes("transferred directly"));
  assert(
    config.policy_copy.creatorEarnings.includes("added to spendable balance"),
  );
  assert(config.policy_copy.creatorEarnings.includes("requested for payout"));
  assert(config.policy_copy.cloudUsage.includes("cloud units"));
  assert(config.policy_copy.freeCallSponsorship.includes("caller needs Light"));
});

Deno.test("payments launch QA: money-in and payout requests require terms hooks", async () => {
  assertEquals(
    await validateWalletFundingRequest(
      jsonRequest("/api/user/wallet/express-checkout-intent", {
        amount_cents: 2500,
        source: "desktop",
        terms_accepted: true,
      }),
    ),
    { amountCents: 2500, source: "desktop", termsAccepted: true },
  );

  assertEquals(
    await validateWireFundingRequest(
      jsonRequest("/api/user/wallet/wire-transfer-intent", {
        amount_cents: 50000,
        source: "web",
        terms_accepted: true,
      }),
    ),
    { amountCents: 50000, source: "web", termsAccepted: true },
  );

  assertEquals(
    await validateEarningsConversionRequest(
      jsonRequest("/api/user/earnings/convert-to-balance", {
        amount_light: 12.5,
        terms_accepted: true,
      }),
    ),
    { amountLight: 12.5, convertAll: false, termsAccepted: true },
  );

  assertEquals(
    await validateWithdrawalRequest(
      jsonRequest("/api/user/connect/withdraw", {
        amount_light: 5000,
        terms_accepted: true,
      }),
    ),
    { amountLight: 5000, termsAccepted: true },
  );

  await assertRejects(
    () =>
      validateWalletFundingRequest(
        jsonRequest("/api/user/wallet/express-checkout-intent", {
          amount_cents: 2499,
          source: "desktop",
          terms_accepted: true,
        }),
      ),
    RequestValidationError,
    "amount_cents must be at least 2500",
  );

  await assertRejects(
    () =>
      validateWireFundingRequest(
        jsonRequest("/api/user/wallet/wire-transfer-intent", {
          amount_cents: 2499,
          source: "web",
          terms_accepted: true,
        }),
      ),
    RequestValidationError,
    "amount_cents must be at least 2500",
  );

  await assertRejects(
    () =>
      validateWalletFundingRequest(
        jsonRequest("/api/user/wallet/express-checkout-intent", {
          amount_cents: 2500,
          source: "desktop",
        }),
      ),
    RequestValidationError,
    "terms_accepted must be true",
  );

  await assertRejects(
    () =>
      validateWithdrawalRequest(
        jsonRequest("/api/user/connect/withdraw", {
          amount_light: 5000,
        }),
      ),
    RequestValidationError,
    "terms_accepted must be true",
  );
});
