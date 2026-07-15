import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  projectStripeSubscriptionEvent,
  toLaunchCapacityResponse,
} from "./subscriptions.ts";

Deno.test("subscription capacity: Free hides calibration but exposes independent states and resets", () => {
  const response = toLaunchCapacityResponse({
    planCode: "free",
    state: "waiting",
    activeAgentLimit: 1,
    limitsPublic: false,
    nextEligibleAt: "2026-07-20T10:00:00.000Z",
    burst: {
      state: "available",
      resetsAt: "2026-07-15T15:00:00.000Z",
    },
    weekly: {
      state: "waiting",
      resetsAt: "2026-07-20T10:00:00.000Z",
    },
  }, "2026-07-15T10:00:00.000Z");

  assertEquals(response.plan, "free");
  assertEquals(response.activeAgentLimit, 1);
  assertEquals(response.burst.state, "available");
  assertEquals(response.weekly.state, "waiting");
  assertEquals(response.burst.usedPercent, undefined);
  assertEquals(response.weekly.usedPercent, undefined);
  assertEquals(response.nextEligibleAt, "2026-07-20T10:00:00.000Z");
});

Deno.test("subscription capacity: paid plans may expose percentage utilization", () => {
  const response = toLaunchCapacityResponse({
    planCode: "pro",
    state: "low",
    activeAgentLimit: null,
    limitsPublic: true,
    nextEligibleAt: null,
    burst: {
      state: "low",
      resetsAt: "2026-07-15T15:00:00.000Z",
      usedPercent: 84,
      remainingLight: 8,
      limitLight: 50,
    },
    weekly: {
      state: "available",
      resetsAt: "2026-07-20T10:00:00.000Z",
      usedPercent: 35,
      remainingLight: 325,
      limitLight: 500,
    },
  });

  assertEquals(response.burst.usedPercent, 84);
  assertEquals(response.weekly.usedPercent, 35);
  assertEquals(response.activeAgentLimit, null);
});

Deno.test("subscription webhook projects a complete Stripe snapshot through one RPC", async () => {
  const originalEnv = globalThis.__env;
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | null = null;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body || "{}"));
    return new Response("true", { status: 200 });
  }) as typeof fetch;

  try {
    const projected = await projectStripeSubscriptionEvent({
      id: "evt_subscription_1",
      type: "customer.subscription.updated",
      created: 1_784_112_400,
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          current_period_start: 1_784_112_400,
          current_period_end: 1_786_704_400,
          cancel_at_period_end: false,
          metadata: { user_id: "user-1", plan_code: "pro" },
          items: { data: [{ price: { id: "price_pro" } }] },
        } as never,
      },
    });
    assertEquals(projected, true);
    assertEquals(body?.p_user_id, "user-1");
    assertEquals(body?.p_plan_code, "pro");
    assertEquals(body?.p_status, "active");
    assertEquals(body?.p_stripe_subscription_id, "sub_1");
    assertEquals(body?.p_stripe_price_id, "price_pro");
    assertEquals(body?.p_event_id, "evt_subscription_1");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
