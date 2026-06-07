import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { DEFAULT_BILLING_CONFIG } from "./billing-config.ts";
import {
  buildWireTransferPaymentIntentParams,
  WIRE_TRANSFER_BANK_TRANSFER_TYPE,
  WIRE_TRANSFER_DEPOSIT_TYPE,
  WIRE_TRANSFER_FUNDING_METHOD,
} from "./stripe-wire-funding.ts";

Deno.test("stripe wire funding: PaymentIntent params expose only customer balance bank transfer", () => {
  const params = buildWireTransferPaymentIntentParams({
    userId: "user_123",
    stripeCustomerId: "cus_123",
    email: "founder@example.com",
    amountCents: 2500,
    source: "desktop",
    termsAccepted: true,
    billingConfig: DEFAULT_BILLING_CONFIG,
  });

  assertEquals(params.get("amount"), "2500");
  assertEquals(params.get("currency"), "usd");
  assertEquals(params.get("customer"), "cus_123");
  assertEquals(params.get("payment_method_types[0]"), "customer_balance");
  assertEquals(params.has("payment_method_types[1]"), false);
  assertEquals(params.has("automatic_payment_methods[enabled]"), false);
  assertEquals(params.get("payment_method_data[type]"), "customer_balance");
  assertEquals(
    params.get("payment_method_options[customer_balance][funding_type]"),
    "bank_transfer",
  );
  assertEquals(
    params.get("payment_method_options[customer_balance][bank_transfer][type]"),
    WIRE_TRANSFER_BANK_TRANSFER_TYPE,
  );
  assertEquals(params.get("confirm"), "true");
  assertEquals(params.get("metadata[type]"), WIRE_TRANSFER_DEPOSIT_TYPE);
  assertEquals(
    params.get("metadata[funding_method]"),
    WIRE_TRANSFER_FUNDING_METHOD,
  );
  assertEquals(params.get("metadata[light_amount]"), "2500");
  assertEquals(params.get("metadata[light_per_usd]"), "100");
  assertEquals(params.get("metadata[source]"), "desktop");
  assertEquals(params.get("metadata[terms_accepted]"), "true");
  assertEquals(params.get("receipt_email"), "founder@example.com");
});

Deno.test("stripe wire funding: PaymentIntent metadata carries billing address version", () => {
  const params = buildWireTransferPaymentIntentParams({
    userId: "user_123",
    stripeCustomerId: "cus_123",
    amountCents: 2500,
    source: "web",
    termsAccepted: true,
    billingConfig: DEFAULT_BILLING_CONFIG,
    billingAddressId: "00000000-0000-0000-0000-000000000abc",
    billingAddressVersion: 3,
  });

  assertEquals(
    params.get("metadata[buyer_billing_address_id]"),
    "00000000-0000-0000-0000-000000000abc",
  );
  assertEquals(params.get("metadata[buyer_billing_address_version]"), "3");
});
