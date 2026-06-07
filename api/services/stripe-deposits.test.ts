import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildStripeDepositFailure,
  buildStripeDepositFinalization,
  buildStripeDepositPending,
  buildStripeDepositReversal,
  claimStripeEvent,
  finalizeLightDeposit,
  finishStripeEvent,
  recordPendingLightDeposit,
  type StripeWebhookEvent,
} from "./stripe-deposits.ts";

function withEnv() {
  globalThis.__env = {
    ...(globalThis.__env || {}),
    SUPABASE_URL: "https://db.example.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  } as typeof globalThis.__env;
}

Deno.test("stripe deposits: checkout success finalizes actual settled amount", () => {
  const event: StripeWebhookEvent = {
    id: "evt_checkout_paid",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_123",
        object: "checkout.session",
        payment_intent: "pi_123",
        customer: "cus_123",
        payment_status: "paid",
        amount_total: 1000,
        amount_paid: 500,
        metadata: {
          user_id: "user-1",
          type: "hosting_deposit",
          funding_method: "legacy_checkout",
          light_amount: "950",
          light_per_usd: "95",
          billing_config_version: "7",
        },
      },
    },
  };

  const input = buildStripeDepositFinalization(event);

  assertEquals(input?.userId, "user-1");
  assertEquals(input?.requestedAmountCents, 1000);
  assertEquals(input?.requestedLight, 950);
  assertEquals(input?.amountCents, 500);
  assertEquals(input?.lightAmount, 475);
  assertEquals(input?.stripeCheckoutSessionId, "cs_123");
  assertEquals(input?.stripePaymentIntentId, "pi_123");
  assertEquals(input?.billingConfigVersion, 7);
});

Deno.test("stripe deposits: async checkout completion records pending until paid", () => {
  const event: StripeWebhookEvent = {
    id: "evt_checkout_pending",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_pending",
        object: "checkout.session",
        payment_status: "unpaid",
        amount_total: 2500,
        metadata: {
          user_id: "user-2",
          type: "bank_transfer_deposit",
          funding_method: "wire_transfer",
          light_per_usd: "99",
          billing_config_version: "8",
        },
      },
    },
  };

  const input = buildStripeDepositPending(event);

  assertEquals(input?.userId, "user-2");
  assertEquals(input?.requestedAmountCents, 2500);
  assertEquals(input?.requestedLight, 2475);
  assertEquals(input?.fundingMethod, "wire_transfer");
  assertEquals(input?.lightPerUsd, 99);
});

Deno.test("stripe deposits: wire partial funding updates pending without finalizing", () => {
  const event: StripeWebhookEvent = {
    id: "evt_wire_partial",
    type: "payment_intent.partially_funded",
    data: {
      object: {
        id: "pi_wire_partial",
        object: "payment_intent",
        customer: "cus_wire",
        status: "requires_action",
        amount: 50000,
        amount_received: 12500,
        metadata: {
          user_id: "user-wire",
          amount_cents: "50000",
          type: "wire_deposit",
          funding_method: "wire_transfer",
          light_per_usd: "99",
          light_amount: "49500",
          billing_config_version: "9",
        },
      },
    },
  };

  const pendingInput = buildStripeDepositPending(event);
  const finalInput = buildStripeDepositFinalization(event);

  assertEquals(pendingInput?.stripePaymentIntentId, "pi_wire_partial");
  assertEquals(pendingInput?.requestedAmountCents, 50000);
  assertEquals(pendingInput?.requestedLight, 49500);
  assertEquals(pendingInput?.fundingMethod, "wire_transfer");
  assertEquals(pendingInput?.lightPerUsd, 99);
  assertEquals(finalInput, null);
});

Deno.test("stripe deposits: payment intent success keys idempotency by intent ID", () => {
  const event: StripeWebhookEvent = {
    id: "evt_pi_paid",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_paid",
        object: "payment_intent",
        status: "succeeded",
        amount: 1000,
        amount_received: 1000,
        metadata: {
          user_id: "user-2",
          type: "wallet_topup",
          funding_method: "wallet",
          light_per_usd: "95",
        },
      },
    },
  };

  const input = buildStripeDepositFinalization(event);

  assertEquals(input?.stripePaymentIntentId, "pi_paid");
  assertEquals(input?.amountCents, 1000);
  assertEquals(input?.lightAmount, 950);
});

Deno.test("stripe deposits: gross-up metadata credits intended Light", () => {
  const event: StripeWebhookEvent = {
    id: "evt_launch_topup_paid",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_launch_topup",
        object: "payment_intent",
        status: "succeeded",
        amount: 10330,
        amount_received: 10330,
        metadata: {
          user_id: "user-launch",
          type: "wallet_topup",
          funding_method: "launch_card_gross_up",
          amount_cents: "10330",
          base_amount_cents: "10000",
          processing_fee_cents: "330",
          light_amount: "10000",
          light_per_usd: "100",
          gross_up: "true",
        },
      },
    },
  };

  const input = buildStripeDepositFinalization(event);

  assertEquals(input?.requestedAmountCents, 10330);
  assertEquals(input?.requestedLight, 10000);
  assertEquals(input?.amountCents, 10330);
  assertEquals(input?.lightAmount, 10000);
  assertEquals(input?.lightPerUsd, 100);
});

Deno.test("stripe deposits: failure and reversal events map to deposit ledger inputs", () => {
  const failed: StripeWebhookEvent = {
    id: "evt_failed",
    type: "payment_intent.payment_failed",
    data: {
      object: {
        id: "pi_failed",
        object: "payment_intent",
        customer: "cus_123",
        amount: 1200,
        metadata: {
          user_id: "user-3",
          type: "wallet_topup",
          funding_method: "wallet",
        },
        last_payment_error: {
          code: "card_declined",
          message: "Declined",
        },
      },
    },
  };
  const refund: StripeWebhookEvent = {
    id: "evt_refund",
    type: "charge.refunded",
    data: {
      object: {
        id: "ch_123",
        object: "charge",
        payment_intent: "pi_123",
        amount_refunded: 700,
      },
    },
  };

  const failedInput = buildStripeDepositFailure(failed);
  const reversalInput = buildStripeDepositReversal(refund);

  assertEquals(failedInput?.stripePaymentIntentId, "pi_failed");
  assertEquals(failedInput?.failureCode, "card_declined");
  assertEquals(failedInput?.failureMessage, "Declined");
  assertEquals(reversalInput?.reason, "refund");
  assertEquals(reversalInput?.amountCents, 700);
  assertEquals(reversalInput?.stripeChargeId, "ch_123");
  assertEquals(reversalInput?.stripePaymentIntentId, "pi_123");
});

Deno.test("stripe deposits: event claim and deposit RPC calls use durable tables", async () => {
  withEnv();
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || "{}")) as Record<
        string,
        unknown
      >;
      calls.push({ url, body });
      if (url.endsWith("/rpc/claim_stripe_event")) {
        return Response.json([{
          event_id: body.p_event_id,
          claimed: true,
          status: "processing",
          process_attempts: 1,
        }]);
      }
      if (url.endsWith("/rpc/upsert_pending_light_deposit")) {
        return Response.json([{
          deposit_id: "dep_pending",
          status: "pending",
        }]);
      }
      if (url.endsWith("/rpc/finalize_light_deposit")) {
        return Response.json([{
          deposit_id: "dep_final",
          status: "succeeded",
          previous_balance_light: 0,
          new_balance_light: 950,
          credited_light: 950,
          already_finalized: false,
        }]);
      }
      if (url.endsWith("/rpc/finish_stripe_event")) {
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

  try {
    const claim = await claimStripeEvent({
      id: "evt_123",
      type: "payment_intent.succeeded",
      created: 1_777_777_777,
      livemode: false,
      data: {
        object: {
          id: "pi_123",
          object: "payment_intent",
        },
      },
    });
    await recordPendingLightDeposit({
      userId: "user-4",
      requestedAmountCents: 1000,
      requestedLight: 950,
      fundingMethod: "wallet",
      stripePaymentIntentId: "pi_123",
      billingConfigVersion: 1,
      lightPerUsd: 95,
    });
    const finalized = await finalizeLightDeposit({
      userId: "user-4",
      requestedAmountCents: 1000,
      requestedLight: 950,
      amountCents: 1000,
      lightAmount: 950,
      fundingMethod: "wallet",
      stripeEventId: "evt_123",
      stripePaymentIntentId: "pi_123",
      billingConfigVersion: 1,
      lightPerUsd: 95,
    });
    await finishStripeEvent("evt_123", "processed", { handled: true });

    assertEquals(claim.claimed, true);
    assertEquals(finalized.creditedLight, 950);
    assertEquals(calls[0].url.endsWith("/rpc/claim_stripe_event"), true);
    assertEquals(
      calls[1].url.endsWith("/rpc/upsert_pending_light_deposit"),
      true,
    );
    assertEquals(calls[2].url.endsWith("/rpc/finalize_light_deposit"), true);
    assertEquals(calls[3].url.endsWith("/rpc/finish_stripe_event"), true);
    assertEquals(calls[2].body.p_stripe_event_id, "evt_123");
    assertEquals(calls[2].body.p_stripe_payment_intent_id, "pi_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
