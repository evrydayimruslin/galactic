import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  DEFAULT_BILLING_CONFIG,
  toPublicBillingConfig,
} from "./billing-config.ts";
import {
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
  assertEquals(config.min_publish_deposit_light, 500);
  assertEquals(config.labels.hosting_rate, "✦2.25/MB/hr");
  assertEquals(config.labels.data_rate, "✦0.045/MB/hr");
  assertEquals(config.labels.payout_rate, "100 Light = $1");
  assert(
    config.payout_policy_copy.includes("Purchased Light cannot be cashed out"),
  );
  assert(config.policy_copy.purchasedLight.includes("cannot be cashed out"));
  assert(config.policy_copy.purchasedLight.includes("transferred directly"));
  assert(config.policy_copy.creatorEarnings.includes("requested for payout"));
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
