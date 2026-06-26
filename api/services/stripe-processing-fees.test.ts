import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertThrows } from "https://deno.land/std@0.210.0/assert/assert_throws.ts";

import {
  quoteLaunchWalletFunding,
  stripeProcessingFeeCents,
} from "./stripe-processing-fees.ts";
import { RequestValidationError } from "./request-validation.ts";

Deno.test("stripe processing fees: card quote uses true gross-up", () => {
  const quote = quoteLaunchWalletFunding({
    amountLight: 10_000,
    method: "card",
  });

  assertEquals(quote.methodLabel, "Card");
  assertEquals(quote.lightPerDollar, 100);
  assertEquals(quote.baseAmountCents, 10_000);
  assertEquals(quote.totalAmountCents, 10_330);
  assertEquals(quote.processingFeeCents, 330);
  assertEquals(
    quote.totalAmountCents -
      stripeProcessingFeeCents(quote.totalAmountCents, "card"),
    quote.baseAmountCents,
  );
});

Deno.test("stripe processing fees: ACH quote passes through capped direct debit fee", () => {
  const quote = quoteLaunchWalletFunding({
    amountLight: 100_000,
    method: "ach",
  });

  assertEquals(quote.methodLabel, "Bank (ACH)");
  assertEquals(quote.baseAmountCents, 100_000);
  assertEquals(quote.totalAmountCents, 100_500);
  assertEquals(quote.processingFeeCents, 500);
  assertEquals(
    quote.totalAmountCents -
      stripeProcessingFeeCents(quote.totalAmountCents, "ach"),
    quote.baseAmountCents,
  );
});

Deno.test("stripe processing fees: launch top-up amount must be a supported integer", () => {
  assertThrows(
    () => quoteLaunchWalletFunding({ amountLight: 99, method: "card" }),
    RequestValidationError,
    "amount_credits must be at least 100",
  );
  assertThrows(
    () => quoteLaunchWalletFunding({ amountLight: 1_000.5, method: "ach" }),
    RequestValidationError,
    "amount_credits must be an integer",
  );
});
