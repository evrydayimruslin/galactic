import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  buildLaunchWalletPaymentIntentParams,
  LAUNCH_ACH_FUNDING_METHOD,
  LAUNCH_CARD_FUNDING_METHOD,
  LAUNCH_WALLET_DEPOSIT_TYPE,
} from "./stripe-launch-wallet-funding.ts";
import { quoteLaunchWalletFunding } from "./stripe-processing-fees.ts";

Deno.test("stripe launch wallet funding: card intent params carry gross-up metadata", () => {
  const quote = quoteLaunchWalletFunding({
    amountLight: 10_000,
    method: "card",
  });
  const params = buildLaunchWalletPaymentIntentParams({
    userId: "user_123",
    stripeCustomerId: "cus_123",
    email: "founder@example.com",
    quote,
    billingConfigVersion: 4,
    termsAccepted: true,
    billingAddressId: "addr_123",
    billingAddressVersion: 2,
  });

  assertEquals(params.get("amount"), "10330");
  assertEquals(params.get("currency"), "usd");
  assertEquals(params.get("payment_method_types[0]"), "card");
  assertEquals(
    params.get("payment_method_options[card][request_three_d_secure]"),
    "automatic",
  );
  assertEquals(params.get("metadata[type]"), LAUNCH_WALLET_DEPOSIT_TYPE);
  assertEquals(
    params.get("metadata[funding_method]"),
    LAUNCH_CARD_FUNDING_METHOD,
  );
  assertEquals(params.get("metadata[amount_cents]"), "10330");
  assertEquals(params.get("metadata[base_amount_cents]"), "10000");
  assertEquals(params.get("metadata[processing_fee_cents]"), "330");
  assertEquals(params.get("metadata[light_amount]"), "10000");
  assertEquals(params.get("metadata[light_per_usd]"), "100");
  assertEquals(params.get("metadata[gross_up]"), "true");
  assertEquals(params.get("metadata[payment_method_label]"), "Card");
  assertEquals(params.get("metadata[buyer_billing_address_id]"), "addr_123");
  assertEquals(params.get("metadata[buyer_billing_address_version]"), "2");
  assertEquals(params.get("receipt_email"), "founder@example.com");
});

Deno.test("stripe launch wallet funding: ACH intent params use Bank direct debit", () => {
  const quote = quoteLaunchWalletFunding({
    amountLight: 100_000,
    method: "ach",
  });
  const params = buildLaunchWalletPaymentIntentParams({
    userId: "user_123",
    stripeCustomerId: "cus_123",
    quote,
    billingConfigVersion: 4,
    termsAccepted: true,
  });

  assertEquals(params.get("amount"), "100500");
  assertEquals(params.get("payment_method_types[0]"), "us_bank_account");
  assertEquals(
    params.get("payment_method_options[us_bank_account][verification_method]"),
    "automatic",
  );
  assertEquals(
    params.get("metadata[funding_method]"),
    LAUNCH_ACH_FUNDING_METHOD,
  );
  assertEquals(params.get("metadata[payment_method]"), "ach");
  assertEquals(params.get("metadata[payment_method_label]"), "Bank (ACH)");
  assertEquals(params.get("metadata[processing_fee_cents]"), "500");
  assertEquals(params.get("metadata[light_amount]"), "100000");
  assertEquals(params.get("metadata[light_per_usd]"), "100");
});
