import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  cancelSubscriptionCheckoutAttempt,
  createSubscriptionCheckout,
  getSubscriptionCheckoutAttempt,
  projectStripeSubscriptionEvent,
  SubscriptionCheckoutAttemptNotFoundError,
  SubscriptionCheckoutCancellationError,
  toLaunchCapacityResponse,
} from "./subscriptions.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
const SUPABASE_URL = "https://supabase.example";
const STRIPE_CHECKOUT_URL = "https://checkout.stripe.example/session";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  rawBody: string;
  body: Record<string, unknown> | null;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): CapturedRequest {
  const headers = new Headers(init?.headers);
  const rawBody = typeof init?.body === "string" ? init.body : "";
  const isJson = headers.get("Content-Type")?.includes("application/json") ??
    false;
  return {
    url: String(input),
    method: init?.method ?? "GET",
    headers,
    rawBody,
    body: rawBody && isJson
      ? JSON.parse(rawBody) as Record<string, unknown>
      : null,
  };
}

function rpcRequest(request: CapturedRequest): Record<string, unknown> {
  const value = request.body?.p_request;
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function planRow(): Record<string, unknown> {
  return {
    code: "pro",
    display_name: "Galactic membership",
    price_cents: 2000,
    currency: "usd",
    interval: "month",
    stripe_price_id: "price_pro",
    purchasable: true,
  };
}

function attemptRow(
  status:
    | "creating"
    | "pending"
    | "active"
    | "cancelled"
    | "failed"
    | "expired",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code: status,
    attempt_id: ATTEMPT_ID,
    status,
    checkout_url: status === "pending" ? STRIPE_CHECKOUT_URL : null,
    stripe_checkout_session_id: status === "pending" ? "cs_durable" : null,
    replayed: false,
    ...overrides,
  };
}

function capacityRow(): Record<string, unknown> {
  return {
    plan_code: "pro",
    limits_public: true,
    capacity_state: "available",
    burst_state: "available",
    weekly_state: "available",
    burst_resets_at: "2026-07-31T00:00:00.000Z",
    weekly_resets_at: "2026-08-06T00:00:00.000Z",
    burst_limit_light: 50,
    burst_used_light: 0,
    weekly_limit_light: 500,
    weekly_used_light: 0,
    next_eligible_at: null,
  };
}

async function withSubscriptionFetch<T>(
  handler: (
    request: CapturedRequest,
  ) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const originalEnv = globalThis.__env;
  const originalFetch = globalThis.fetch;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    STRIPE_SECRET_KEY: "sk_test_checkout",
    STRIPE_PRO_PRICE_ID: "price_pro",
  } as typeof globalThis.__env;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => await handler(captureRequest(input, init))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
}

Deno.test("subscription capacity: legacy plans normalize to Pro with weekly-only output", () => {
  const response = toLaunchCapacityResponse(
    {
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
    } as unknown as Parameters<typeof toLaunchCapacityResponse>[0],
    "2026-07-15T10:00:00.000Z",
  );

  assertEquals(response.plan, "pro");
  assertEquals(response.activeAgentLimit, null);
  assertEquals(response.weekly.state, "waiting");
  assertEquals(response.weekly.usedPercent, undefined);
  assertEquals(response.nextEligibleAt, "2026-07-20T10:00:00.000Z");
});

Deno.test("subscription capacity: Pro exposes weekly percentage utilization", () => {
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

  assertEquals(response.weekly.usedPercent, 35);
  assertEquals(response.activeAgentLimit, null);
});

Deno.test("subscription checkout: durable claim precedes one idempotent Stripe create and bind", async () => {
  const order: string[] = [];
  let claimedAttemptId = "";
  let claim: Record<string, unknown> | null = null;
  let bind: Record<string, unknown> | null = null;
  let stripeSession: CapturedRequest | null = null;

  const result = await withSubscriptionFetch((request) => {
    if (request.url.includes("/rest/v1/billing_plans?")) {
      order.push("plan");
      return jsonResponse([planRow()]);
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      order.push("subscription");
      return jsonResponse([]);
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/claim_subscription_checkout_attempt",
      )
    ) {
      order.push("claim");
      claim = rpcRequest(request);
      claimedAttemptId = String(claim.attempt_id);
      return jsonResponse(attemptRow("creating", {
        attempt_id: claimedAttemptId,
        code: "creating",
      }));
    }
    if (request.url.includes("/rest/v1/users?")) {
      order.push("customer-read");
      return jsonResponse([{
        stripe_customer_id: "cus_existing",
        email: "member@example.com",
      }]);
    }
    if (request.url === "https://api.stripe.com/v1/customers/cus_existing") {
      order.push("customer-verify");
      return jsonResponse({ id: "cus_existing" });
    }
    if (request.url === "https://api.stripe.com/v1/checkout/sessions") {
      order.push("stripe-session");
      stripeSession = request;
      return jsonResponse({
        id: "cs_new",
        url: STRIPE_CHECKOUT_URL,
      });
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/bind_subscription_checkout_attempt",
      )
    ) {
      order.push("bind");
      bind = rpcRequest(request);
      return jsonResponse(attemptRow("pending", {
        attempt_id: claimedAttemptId,
        code: "bound",
        stripe_checkout_session_id: "cs_new",
      }));
    }
    throw new Error(`Unexpected checkout request: ${request.url}`);
  }, () =>
    createSubscriptionCheckout({
      userId: USER_ID,
      plan: "pro",
      requestOrigin: "https://launch.example",
      returnUrl: "https://launch.example/agents?pane=membership",
      idempotencyKey: IDEMPOTENCY_KEY,
    }));

  const capturedClaim = claim as Record<string, unknown> | null;
  assert(capturedClaim);
  assertMatch(String(capturedClaim.attempt_id), /^[0-9a-f-]{36}$/i);
  assertEquals(capturedClaim.owner_id, USER_ID);
  assertEquals(capturedClaim.idempotency_key, IDEMPOTENCY_KEY);
  assertEquals(capturedClaim.plan_code, "pro");
  assertEquals(
    capturedClaim.return_url,
    "https://launch.example/agents?pane=membership",
  );
  assertMatch(String(capturedClaim.request_fingerprint), /^[0-9a-f]{64}$/);
  const expiresAt = Date.parse(String(capturedClaim.expires_at));
  assert(Number.isFinite(expiresAt));
  assert(expiresAt > Date.now() + 5 * 60_000);
  assert(expiresAt <= Date.now() + 24 * 60 * 60_000);

  const capturedStripeSession = stripeSession as CapturedRequest | null;
  assert(capturedStripeSession);
  assertEquals(
    capturedStripeSession.headers.get("Idempotency-Key"),
    `galactic-subscription-${USER_ID}-${claimedAttemptId}`,
  );
  const stripeForm = new URLSearchParams(
    capturedStripeSession.rawBody,
  );
  assertEquals(stripeForm.get("mode"), "subscription");
  assertEquals(stripeForm.get("customer"), "cus_existing");
  assertEquals(stripeForm.get("line_items[0][price]"), "price_pro");
  assertEquals(stripeForm.get("client_reference_id"), claimedAttemptId);
  assertEquals(stripeForm.get("metadata[user_id]"), USER_ID);
  assertEquals(
    stripeForm.get("metadata[checkout_attempt_id]"),
    claimedAttemptId,
  );
  assertEquals(
    stripeForm.get("subscription_data[metadata][checkout_attempt_id]"),
    claimedAttemptId,
  );

  assert(bind);
  assertEquals(bind, {
    owner_id: USER_ID,
    attempt_id: claimedAttemptId,
    stripe_checkout_session_id: "cs_new",
    checkout_url: STRIPE_CHECKOUT_URL,
  });
  assertEquals(result.attemptId, claimedAttemptId);
  assertEquals(result.status, "pending");
  assertEquals(result.url, STRIPE_CHECKOUT_URL);
  assertEquals(order, [
    "plan",
    "subscription",
    "claim",
    "customer-read",
    "customer-verify",
    "stripe-session",
    "bind",
  ]);
});

Deno.test("subscription checkout: an exact idempotent retry recovers a lost Stripe create response", async () => {
  let claimedAttemptId = "";
  const stripeCreates: CapturedRequest[] = [];
  let failedProjections = 0;

  const result = await withSubscriptionFetch((request) => {
    if (request.url.includes("/rest/v1/billing_plans?")) {
      return jsonResponse([planRow()]);
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      return jsonResponse([]);
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/claim_subscription_checkout_attempt",
      )
    ) {
      const claim = rpcRequest(request);
      claimedAttemptId = String(claim.attempt_id);
      return jsonResponse(attemptRow("creating", {
        attempt_id: claimedAttemptId,
      }));
    }
    if (request.url.includes("/rest/v1/users?")) {
      return jsonResponse([{
        stripe_customer_id: "cus_existing",
        email: "member@example.com",
      }]);
    }
    if (request.url === "https://api.stripe.com/v1/customers/cus_existing") {
      return jsonResponse({ id: "cus_existing" });
    }
    if (request.url === "https://api.stripe.com/v1/checkout/sessions") {
      stripeCreates.push(request);
      if (stripeCreates.length === 1) {
        // Stripe may have committed this request even though the response was
        // lost. The service must replay the exact request, not abandon it.
        throw new TypeError("response stream lost");
      }
      return jsonResponse({
        id: "cs_recovered",
        url: STRIPE_CHECKOUT_URL,
      });
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/bind_subscription_checkout_attempt",
      )
    ) {
      const bind = rpcRequest(request);
      assertEquals(bind.stripe_checkout_session_id, "cs_recovered");
      return jsonResponse(attemptRow("pending", {
        attempt_id: claimedAttemptId,
        stripe_checkout_session_id: "cs_recovered",
      }));
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/project_subscription_checkout_attempt",
      )
    ) {
      failedProjections += 1;
      throw new Error("A recovered create must not be marked failed");
    }
    throw new Error(`Unexpected lost-response request: ${request.url}`);
  }, () =>
    createSubscriptionCheckout({
      userId: USER_ID,
      plan: "pro",
      requestOrigin: "https://launch.example",
      returnUrl: "https://launch.example/account",
      idempotencyKey: IDEMPOTENCY_KEY,
    }));

  assertEquals(stripeCreates.length, 2);
  assertEquals(stripeCreates[0]?.rawBody, stripeCreates[1]?.rawBody);
  assertEquals(
    stripeCreates[0]?.headers.get("Idempotency-Key"),
    stripeCreates[1]?.headers.get("Idempotency-Key"),
  );
  assertEquals(
    stripeCreates[1]?.headers.get("Idempotency-Key"),
    `galactic-subscription-${USER_ID}-${claimedAttemptId}`,
  );
  assertEquals(failedProjections, 0);
  assertEquals(result.status, "pending");
  assertEquals(result.attemptId, claimedAttemptId);
});

Deno.test("subscription checkout: ambiguous repeated Stripe transport loss keeps the durable attempt recoverable", async () => {
  let stripeCreates = 0;
  let failedProjections = 0;

  await withSubscriptionFetch((request) => {
    if (request.url.includes("/rest/v1/billing_plans?")) {
      return jsonResponse([planRow()]);
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      return jsonResponse([]);
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/claim_subscription_checkout_attempt",
      )
    ) {
      return jsonResponse(attemptRow("creating"));
    }
    if (request.url.includes("/rest/v1/users?")) {
      return jsonResponse([{
        stripe_customer_id: "cus_existing",
        email: "member@example.com",
      }]);
    }
    if (request.url === "https://api.stripe.com/v1/customers/cus_existing") {
      return jsonResponse({ id: "cus_existing" });
    }
    if (request.url === "https://api.stripe.com/v1/checkout/sessions") {
      stripeCreates += 1;
      throw new TypeError("transport outcome unknown");
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/project_subscription_checkout_attempt",
      )
    ) {
      failedProjections += 1;
      return jsonResponse(attemptRow("failed"));
    }
    throw new Error(`Unexpected ambiguous-create request: ${request.url}`);
  }, async () => {
    await assertRejects(
      () =>
        createSubscriptionCheckout({
          userId: USER_ID,
          plan: "pro",
          requestOrigin: "https://launch.example",
          returnUrl: "https://launch.example/account",
          idempotencyKey: IDEMPOTENCY_KEY,
        }),
      Error,
      "outcome could not be confirmed",
    );
  });

  assertEquals(stripeCreates, 2);
  assertEquals(failedProjections, 0);
});

Deno.test("subscription checkout: two definitive Stripe rejections safely terminalize the attempt", async () => {
  let stripeCreates = 0;
  const failedProjections: Record<string, unknown>[] = [];

  await withSubscriptionFetch((request) => {
    if (request.url.includes("/rest/v1/billing_plans?")) {
      return jsonResponse([planRow()]);
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      return jsonResponse([]);
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/claim_subscription_checkout_attempt",
      )
    ) {
      return jsonResponse(attemptRow("creating"));
    }
    if (request.url.includes("/rest/v1/users?")) {
      return jsonResponse([{
        stripe_customer_id: "cus_existing",
        email: "member@example.com",
      }]);
    }
    if (request.url === "https://api.stripe.com/v1/customers/cus_existing") {
      return jsonResponse({ id: "cus_existing" });
    }
    if (request.url === "https://api.stripe.com/v1/checkout/sessions") {
      stripeCreates += 1;
      return jsonResponse({
        error: { message: "The subscription price is invalid" },
      }, 400);
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/project_subscription_checkout_attempt",
      )
    ) {
      failedProjections.push(rpcRequest(request));
      return jsonResponse(attemptRow("failed"));
    }
    throw new Error(`Unexpected definitive-create request: ${request.url}`);
  }, async () => {
    await assertRejects(
      () =>
        createSubscriptionCheckout({
          userId: USER_ID,
          plan: "pro",
          requestOrigin: "https://launch.example",
          returnUrl: "https://launch.example/account",
          idempotencyKey: IDEMPOTENCY_KEY,
        }),
      Error,
      "price is invalid",
    );
  });

  assertEquals(stripeCreates, 2);
  assertEquals(failedProjections.length, 1);
  assertEquals(failedProjections[0]?.status, "failed");
  assertEquals(
    failedProjections[0]?.reason,
    "stripe_session_creation_failed",
  );
});

Deno.test("subscription checkout: a concurrent creating-attempt cancellation retires the unpublished Stripe session", async () => {
  const order: string[] = [];

  await withSubscriptionFetch((request) => {
    if (request.url.includes("/rest/v1/billing_plans?")) {
      return jsonResponse([planRow()]);
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      return jsonResponse([]);
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/claim_subscription_checkout_attempt",
      )
    ) {
      return jsonResponse(attemptRow("creating"));
    }
    if (request.url.includes("/rest/v1/users?")) {
      return jsonResponse([{
        stripe_customer_id: "cus_existing",
        email: "member@example.com",
      }]);
    }
    if (request.url === "https://api.stripe.com/v1/customers/cus_existing") {
      return jsonResponse({ id: "cus_existing" });
    }
    if (request.url === "https://api.stripe.com/v1/checkout/sessions") {
      order.push("stripe-create");
      return jsonResponse({
        id: "cs_cancel_race",
        url: STRIPE_CHECKOUT_URL,
      });
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/bind_subscription_checkout_attempt",
      )
    ) {
      order.push("bind-cancelled");
      return jsonResponse(attemptRow("cancelled", {
        stripe_checkout_session_id: null,
      }));
    }
    if (
      request.url ===
        "https://api.stripe.com/v1/checkout/sessions/cs_cancel_race"
    ) {
      order.push("stripe-read");
      return jsonResponse({
        id: "cs_cancel_race",
        status: "open",
        payment_status: "unpaid",
      });
    }
    if (
      request.url ===
        "https://api.stripe.com/v1/checkout/sessions/cs_cancel_race/expire"
    ) {
      order.push("stripe-expire");
      return jsonResponse({
        id: "cs_cancel_race",
        status: "expired",
        payment_status: "unpaid",
      });
    }
    throw new Error(`Unexpected create-cancel race request: ${request.url}`);
  }, async () => {
    await assertRejects(
      () =>
        createSubscriptionCheckout({
          userId: USER_ID,
          plan: "pro",
          requestOrigin: "https://launch.example",
          returnUrl: "https://launch.example/account",
          idempotencyKey: IDEMPOTENCY_KEY,
        }),
      Error,
      "could not be activated",
    );
  });

  assertEquals(order, [
    "stripe-create",
    "bind-cancelled",
    "stripe-read",
    "stripe-expire",
  ]);
});

Deno.test("subscription checkout: bound replay skips Stripe and returns the durable URL", async () => {
  let claimCount = 0;
  let stripeCalls = 0;

  const result = await withSubscriptionFetch((request) => {
    if (request.url.includes("/rest/v1/billing_plans?")) {
      return jsonResponse([planRow()]);
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      return jsonResponse([]);
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/claim_subscription_checkout_attempt",
      )
    ) {
      claimCount += 1;
      const claim = rpcRequest(request);
      assertEquals(claim.owner_id, USER_ID);
      assertEquals(claim.idempotency_key, IDEMPOTENCY_KEY);
      assertEquals(claim.plan_code, "pro");
      return jsonResponse(attemptRow("pending", {
        attempt_id: ATTEMPT_ID,
        code: "pending",
        replayed: true,
      }));
    }
    if (
      request.url.startsWith("https://api.stripe.com/") ||
      request.url.includes("/rest/v1/users?") ||
      request.url.includes("bind_subscription_checkout_attempt")
    ) {
      stripeCalls += 1;
      throw new Error("A bound checkout replay must not contact Stripe");
    }
    throw new Error(`Unexpected checkout replay request: ${request.url}`);
  }, () =>
    createSubscriptionCheckout({
      userId: USER_ID,
      plan: "pro",
      requestOrigin: "https://launch.example",
      returnUrl: "https://launch.example/account",
      idempotencyKey: IDEMPOTENCY_KEY,
    }));

  assertEquals(claimCount, 1);
  assertEquals(stripeCalls, 0);
  assertEquals(result, {
    url: STRIPE_CHECKOUT_URL,
    attemptId: ATTEMPT_ID,
    status: "pending",
    generatedAt: result.generatedAt,
  });
});

Deno.test("subscription checkout: database concurrency fences surface actionable errors before Stripe", async (t) => {
  const cases = [
    {
      code: "CHECKOUT_ATTEMPT_IN_PROGRESS",
      message: "already in progress",
    },
    {
      code: "CHECKOUT_SUBSCRIPTION_EXISTS",
      message: "already has a managed subscription",
    },
  ] as const;

  for (const testCase of cases) {
    await t.step(testCase.code, async () => {
      let stripeCalls = 0;
      await withSubscriptionFetch((request) => {
        if (request.url.includes("/rest/v1/billing_plans?")) {
          return jsonResponse([planRow()]);
        }
        if (request.url.includes("/rest/v1/account_subscriptions?")) {
          return jsonResponse([]);
        }
        if (
          request.url.endsWith(
            "/rest/v1/rpc/claim_subscription_checkout_attempt",
          )
        ) {
          return jsonResponse({
            message: "checkout_rejected",
            details: { code: testCase.code },
          }, 409);
        }
        if (
          request.url.startsWith("https://api.stripe.com/") ||
          request.url.includes("/rest/v1/users?") ||
          request.url.includes("bind_subscription_checkout_attempt")
        ) {
          stripeCalls += 1;
        }
        throw new Error(`Unexpected fenced checkout request: ${request.url}`);
      }, async () => {
        await assertRejects(
          () =>
            createSubscriptionCheckout({
              userId: USER_ID,
              plan: "pro",
              requestOrigin: "https://launch.example",
              returnUrl: "https://launch.example/account",
              idempotencyKey: IDEMPOTENCY_KEY,
            }),
          Error,
          testCase.message,
        );
      });
      assertEquals(stripeCalls, 0);
    });
  }
});

Deno.test("subscription checkout: terminal replay is immutable and never reopens Stripe", async (t) => {
  for (
    const status of ["active", "cancelled", "failed", "expired"] as const
  ) {
    await t.step(status, async () => {
      let stripeCalls = 0;
      const error = await withSubscriptionFetch((request) => {
        if (request.url.includes("/rest/v1/billing_plans?")) {
          return jsonResponse([planRow()]);
        }
        if (request.url.includes("/rest/v1/account_subscriptions?")) {
          return jsonResponse([]);
        }
        if (
          request.url.endsWith(
            "/rest/v1/rpc/claim_subscription_checkout_attempt",
          )
        ) {
          return jsonResponse(attemptRow(status, {
            code: status,
            replayed: true,
            checkout_url: null,
          }));
        }
        if (
          request.url.startsWith("https://api.stripe.com/") ||
          request.url.includes("/rest/v1/users?") ||
          request.url.includes("bind_subscription_checkout_attempt")
        ) {
          stripeCalls += 1;
        }
        throw new Error(`Unexpected terminal replay request: ${request.url}`);
      }, () =>
        assertRejects(
          () =>
            createSubscriptionCheckout({
              userId: USER_ID,
              plan: "pro",
              requestOrigin: "https://launch.example",
              returnUrl: "https://launch.example/account",
              idempotencyKey: IDEMPOTENCY_KEY,
            }),
          Error,
          status === "active" ? "already activated" : "can no longer be used",
        ));
      assert(error instanceof Error);
      assertEquals(stripeCalls, 0);
    });
  }
});

Deno.test("subscription checkout poll: lookup is owner-scoped and exposes no checkout URL", async () => {
  const checkoutRpcRequests: Record<string, unknown>[] = [];
  let directAttemptTableReads = 0;

  const result = await withSubscriptionFetch((request) => {
    if (
      request.url.endsWith(
        "/rest/v1/rpc/get_subscription_checkout_attempt",
      )
    ) {
      const body = rpcRequest(request);
      checkoutRpcRequests.push(body);
      return jsonResponse(attemptRow("pending", {
        checkout_url: "https://must-not-leak.example",
        stripe_checkout_session_id: "cs_private",
      }));
    }
    if (request.url.includes("/rest/v1/subscription_checkout_attempts")) {
      directAttemptTableReads += 1;
      throw new Error("Checkout attempts must be read through the owner RPC");
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      return jsonResponse([{
        plan_code: "pro",
        status: "inactive",
        current_period_end: null,
        cancel_at_period_end: false,
        stripe_subscription_id: null,
      }]);
    }
    if (
      request.url.endsWith("/rest/v1/rpc/get_account_capacity_status")
    ) {
      const body = request.body ?? {};
      assertEquals(body.p_user_id, USER_ID);
      return jsonResponse(capacityRow());
    }
    if (request.url.includes("/rest/v1/billing_plans?")) {
      return jsonResponse([planRow()]);
    }
    throw new Error(`Unexpected checkout poll request: ${request.url}`);
  }, () =>
    getSubscriptionCheckoutAttempt({
      userId: USER_ID,
      attemptId: ATTEMPT_ID.toUpperCase(),
    }));

  assertEquals(checkoutRpcRequests, [{
    owner_id: USER_ID,
    attempt_id: ATTEMPT_ID,
  }]);
  assertEquals(directAttemptTableReads, 0);
  assertEquals(result.attemptId, ATTEMPT_ID);
  assertEquals(result.status, "pending");
  assertEquals(result.subscription.status, "inactive");
  assertEquals("url" in result, false);
  assertEquals("stripeCheckoutSessionId" in result, false);
});

Deno.test("subscription checkout cancel: expires the owner-bound open Stripe session before the DB transition", async () => {
  const cancelRpcRequests: Record<string, unknown>[] = [];
  const order: string[] = [];
  let expireRequest: CapturedRequest | null = null;

  const result = await withSubscriptionFetch((request) => {
    if (
      request.url.endsWith(
        "/rest/v1/rpc/get_subscription_checkout_attempt",
      )
    ) {
      order.push("owner-read");
      assertEquals(rpcRequest(request), {
        owner_id: USER_ID,
        attempt_id: ATTEMPT_ID,
      });
      return jsonResponse(attemptRow("pending", {
        checkout_url: "https://must-not-leak.example",
        stripe_checkout_session_id: "cs_private",
      }));
    }
    if (
      request.url ===
        "https://api.stripe.com/v1/checkout/sessions/cs_private" &&
      request.method === "GET"
    ) {
      order.push("stripe-read");
      return jsonResponse({
        id: "cs_private",
        status: "open",
        payment_status: "unpaid",
      });
    }
    if (
      request.url ===
        "https://api.stripe.com/v1/checkout/sessions/cs_private/expire"
    ) {
      order.push("stripe-expire");
      expireRequest = request;
      return jsonResponse({
        id: "cs_private",
        status: "expired",
        payment_status: "unpaid",
      });
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/cancel_subscription_checkout_attempt",
      )
    ) {
      order.push("db-cancel");
      cancelRpcRequests.push(rpcRequest(request));
      return jsonResponse(attemptRow("cancelled", {
        code: "cancelled",
        checkout_url: "https://must-not-leak.example",
        stripe_checkout_session_id: "cs_private",
      }));
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      order.push("subscription");
      return jsonResponse([{
        plan_code: "pro",
        status: "inactive",
        current_period_end: null,
        cancel_at_period_end: false,
        stripe_subscription_id: null,
      }]);
    }
    if (
      request.url.endsWith("/rest/v1/rpc/get_account_capacity_status")
    ) {
      order.push("capacity");
      const body = request.body ?? {};
      assertEquals(body.p_user_id, USER_ID);
      return jsonResponse(capacityRow());
    }
    if (request.url.includes("/rest/v1/billing_plans?")) {
      order.push("plan");
      return jsonResponse([planRow()]);
    }
    throw new Error(`Unexpected checkout cancellation request: ${request.url}`);
  }, () =>
    cancelSubscriptionCheckoutAttempt({
      userId: USER_ID,
      attemptId: ATTEMPT_ID.toUpperCase(),
    }));

  assertEquals(cancelRpcRequests, [{
    owner_id: USER_ID,
    attempt_id: ATTEMPT_ID,
  }]);
  const capturedExpire = expireRequest as CapturedRequest | null;
  assert(capturedExpire);
  assertEquals(capturedExpire.method, "POST");
  assertEquals(
    capturedExpire.headers.get("Idempotency-Key"),
    `galactic-subscription-cancel-${ATTEMPT_ID}`,
  );
  assertEquals(order.slice(0, 4), [
    "owner-read",
    "stripe-read",
    "stripe-expire",
    "db-cancel",
  ]);
  assertEquals(result.attemptId, ATTEMPT_ID);
  assertEquals(result.status, "cancelled");
  assertEquals(result.subscription.status, "inactive");
  assertEquals("url" in result, false);
  assertEquals("stripeCheckoutSessionId" in result, false);
});

Deno.test("subscription checkout cancel: owner-private misses fail closed before membership reads", async () => {
  let requests = 0;
  await withSubscriptionFetch((request) => {
    requests += 1;
    assert(
      request.url.endsWith(
        "/rest/v1/rpc/get_subscription_checkout_attempt",
      ),
    );
    return jsonResponse({ code: "checkout_attempt_not_found" });
  }, async () => {
    await assertRejects(
      () =>
        cancelSubscriptionCheckoutAttempt({
          userId: USER_ID,
          attemptId: ATTEMPT_ID,
        }),
      SubscriptionCheckoutAttemptNotFoundError,
      "not found",
    );
  });
  assertEquals(requests, 1);
});

Deno.test("subscription checkout cancel: a completed payment race is reconciled and never expired or DB-cancelled", async () => {
  let ownerReads = 0;
  let expireCalls = 0;
  let cancelCalls = 0;

  const result = await withSubscriptionFetch((request) => {
    if (
      request.url.endsWith(
        "/rest/v1/rpc/get_subscription_checkout_attempt",
      )
    ) {
      ownerReads += 1;
      return jsonResponse(attemptRow(ownerReads === 1 ? "pending" : "active", {
        stripe_checkout_session_id: "cs_paid",
      }));
    }
    if (
      request.url ===
        "https://api.stripe.com/v1/checkout/sessions/cs_paid"
    ) {
      return jsonResponse({
        id: "cs_paid",
        status: "complete",
        payment_status: "paid",
        customer: "cus_paid",
        subscription: "sub_paid",
      });
    }
    if (request.url.includes("/expire")) {
      expireCalls += 1;
      throw new Error("A completed session must not be expired");
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/cancel_subscription_checkout_attempt",
      )
    ) {
      cancelCalls += 1;
      throw new Error("A completed session must not be DB-cancelled");
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      return jsonResponse([{
        plan_code: "pro",
        status: "active",
        current_period_end: "2026-08-30T00:00:00.000Z",
        cancel_at_period_end: false,
        stripe_subscription_id: "sub_paid",
      }]);
    }
    if (
      request.url.endsWith("/rest/v1/rpc/get_account_capacity_status")
    ) {
      return jsonResponse(capacityRow());
    }
    if (request.url.includes("/rest/v1/billing_plans?")) {
      return jsonResponse([planRow()]);
    }
    throw new Error(`Unexpected completed-race request: ${request.url}`);
  }, () =>
    cancelSubscriptionCheckoutAttempt({
      userId: USER_ID,
      attemptId: ATTEMPT_ID,
    }));

  assertEquals(ownerReads, 2);
  assertEquals(expireCalls, 0);
  assertEquals(cancelCalls, 0);
  assertEquals(result.status, "active");
  assertEquals(result.subscription.hasActiveSubscription, true);
});

Deno.test("subscription checkout cancel: an expiry POST race re-reads Stripe and preserves a completed payment", async () => {
  let stripeReads = 0;
  let expireCalls = 0;
  let cancelCalls = 0;
  let ownerReads = 0;

  const result = await withSubscriptionFetch((request) => {
    if (
      request.url.endsWith(
        "/rest/v1/rpc/get_subscription_checkout_attempt",
      )
    ) {
      ownerReads += 1;
      return jsonResponse(attemptRow(ownerReads === 1 ? "pending" : "active", {
        stripe_checkout_session_id: "cs_race",
      }));
    }
    if (
      request.url ===
        "https://api.stripe.com/v1/checkout/sessions/cs_race"
    ) {
      stripeReads += 1;
      return jsonResponse(
        stripeReads === 1
          ? {
            id: "cs_race",
            status: "open",
            payment_status: "unpaid",
          }
          : {
            id: "cs_race",
            status: "complete",
            payment_status: "paid",
            customer: "cus_race",
            subscription: "sub_race",
          },
      );
    }
    if (
      request.url ===
        "https://api.stripe.com/v1/checkout/sessions/cs_race/expire"
    ) {
      expireCalls += 1;
      return jsonResponse({
        error: { message: "This Checkout Session is no longer open" },
      }, 400);
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/cancel_subscription_checkout_attempt",
      )
    ) {
      cancelCalls += 1;
      throw new Error("The payment race must not be DB-cancelled");
    }
    if (request.url.includes("/rest/v1/account_subscriptions?")) {
      return jsonResponse([{
        plan_code: "pro",
        status: "active",
        current_period_end: "2026-08-30T00:00:00.000Z",
        cancel_at_period_end: false,
        stripe_subscription_id: "sub_race",
      }]);
    }
    if (
      request.url.endsWith("/rest/v1/rpc/get_account_capacity_status")
    ) {
      return jsonResponse(capacityRow());
    }
    if (request.url.includes("/rest/v1/billing_plans?")) {
      return jsonResponse([planRow()]);
    }
    throw new Error(`Unexpected expiry-race request: ${request.url}`);
  }, () =>
    cancelSubscriptionCheckoutAttempt({
      userId: USER_ID,
      attemptId: ATTEMPT_ID,
    }));

  assertEquals(stripeReads, 2);
  assertEquals(expireCalls, 1);
  assertEquals(cancelCalls, 0);
  assertEquals(result.status, "active");
});

Deno.test("subscription checkout cancel: Stripe ambiguity fails closed without a DB transition", async () => {
  let cancelCalls = 0;
  await withSubscriptionFetch((request) => {
    if (
      request.url.endsWith(
        "/rest/v1/rpc/get_subscription_checkout_attempt",
      )
    ) {
      return jsonResponse(attemptRow("pending", {
        stripe_checkout_session_id: "cs_ambiguous",
      }));
    }
    if (
      request.url ===
        "https://api.stripe.com/v1/checkout/sessions/cs_ambiguous"
    ) {
      return jsonResponse({
        id: "cs_ambiguous",
        status: "open",
        // Missing payment_status must never be interpreted as safe to cancel.
      });
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/cancel_subscription_checkout_attempt",
      )
    ) {
      cancelCalls += 1;
    }
    throw new Error(`Unexpected ambiguous-state request: ${request.url}`);
  }, async () => {
    const error = await assertRejects(
      () =>
        cancelSubscriptionCheckoutAttempt({
          userId: USER_ID,
          attemptId: ATTEMPT_ID,
        }),
      SubscriptionCheckoutCancellationError,
      "ambiguous session state",
    );
    assertEquals(error.code, "checkout_cancellation_conflict");
    assertEquals(error.status, 409);
  });
  assertEquals(cancelCalls, 0);
});

Deno.test("subscription checkout cancel: a Stripe read outage fails closed and remains retryable", async () => {
  let cancelCalls = 0;
  await withSubscriptionFetch((request) => {
    if (
      request.url.endsWith(
        "/rest/v1/rpc/get_subscription_checkout_attempt",
      )
    ) {
      return jsonResponse(attemptRow("pending", {
        stripe_checkout_session_id: "cs_unavailable",
      }));
    }
    if (
      request.url ===
        "https://api.stripe.com/v1/checkout/sessions/cs_unavailable"
    ) {
      throw new TypeError("network response lost");
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/cancel_subscription_checkout_attempt",
      )
    ) {
      cancelCalls += 1;
    }
    throw new Error(`Unexpected unavailable-state request: ${request.url}`);
  }, async () => {
    const error = await assertRejects(
      () =>
        cancelSubscriptionCheckoutAttempt({
          userId: USER_ID,
          attemptId: ATTEMPT_ID,
        }),
      SubscriptionCheckoutCancellationError,
      "could not be reached",
    );
    assertEquals(error.code, "checkout_cancellation_unavailable");
    assertEquals(error.status, 503);
  });
  assertEquals(cancelCalls, 0);
});

Deno.test("subscription checkout webhook: replay and older checkout events retain DB authority", async () => {
  const projections: Record<string, unknown>[] = [];
  const events = [
    {
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
      created: 1_784_112_400,
    },
    {
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
      created: 1_784_112_400,
    },
    {
      id: "evt_checkout_expired_older",
      type: "checkout.session.expired",
      created: 1_784_112_300,
    },
  ] as const;

  await withSubscriptionFetch((request) => {
    if (
      request.url.endsWith(
        "/rest/v1/rpc/project_subscription_checkout_attempt",
      )
    ) {
      projections.push(rpcRequest(request));
      // The persistence layer is authoritative and can return the already
      // active terminal state for a repeated or stale webhook.
      return jsonResponse(attemptRow("active", {
        code: "active",
        replayed: true,
      }));
    }
    throw new Error(`Unexpected checkout webhook request: ${request.url}`);
  }, async () => {
    for (const event of events) {
      assertEquals(
        await projectStripeSubscriptionEvent({
          ...event,
          data: {
            object: {
              id: "cs_durable",
              subscription: "sub_durable",
              metadata: {
                user_id: USER_ID,
                plan_code: "pro",
                checkout_attempt_id: ATTEMPT_ID,
              },
            } as never,
          },
        }),
        true,
      );
    }
  });

  assertEquals(
    projections.map((projection) => projection.status),
    ["pending", "pending", "expired"],
  );
  assertEquals(
    projections.map((projection) => projection.event_id),
    [
      "evt_checkout_completed",
      "evt_checkout_completed",
      "evt_checkout_expired_older",
    ],
  );
  assertEquals(
    projections.map((projection) => projection.event_created_at),
    [
      "2026-07-15T10:46:40.000Z",
      "2026-07-15T10:46:40.000Z",
      "2026-07-15T10:45:00.000Z",
    ],
  );
  for (const projection of projections) {
    assertEquals(projection.owner_id, USER_ID);
    assertEquals(projection.attempt_id, ATTEMPT_ID);
    assertEquals(projection.stripe_checkout_session_id, "cs_durable");
    assertEquals(projection.stripe_subscription_id, "sub_durable");
  }
});

Deno.test("subscription webhook: event identity and creation time preserve idempotent monotonic projection", async () => {
  const subscriptionProjections: Record<string, unknown>[] = [];
  const attemptProjections: Record<string, unknown>[] = [];
  const events = [
    {
      id: "evt_subscription_active",
      created: 1_784_112_400,
      status: "active",
    },
    {
      id: "evt_subscription_active",
      created: 1_784_112_400,
      status: "active",
    },
    {
      id: "evt_subscription_past_due_older",
      created: 1_784_112_300,
      status: "past_due",
    },
  ] as const;

  await withSubscriptionFetch((request) => {
    if (
      request.url.endsWith("/rest/v1/rpc/project_account_subscription")
    ) {
      assert(request.body);
      subscriptionProjections.push(request.body);
      return jsonResponse({ applied: true });
    }
    if (
      request.url.endsWith(
        "/rest/v1/rpc/project_subscription_checkout_attempt",
      )
    ) {
      attemptProjections.push(rpcRequest(request));
      return jsonResponse(attemptRow("active", {
        code: "active",
        replayed: true,
      }));
    }
    throw new Error(`Unexpected subscription webhook request: ${request.url}`);
  }, async () => {
    for (const event of events) {
      assertEquals(
        await projectStripeSubscriptionEvent({
          id: event.id,
          type: "customer.subscription.updated",
          created: event.created,
          data: {
            object: {
              id: "sub_durable",
              customer: "cus_durable",
              status: event.status,
              current_period_start: 1_784_112_000,
              current_period_end: 1_786_704_000,
              cancel_at_period_end: false,
              metadata: {
                user_id: USER_ID,
                plan_code: "pro",
                checkout_attempt_id: ATTEMPT_ID,
              },
              items: { data: [{ price: { id: "price_pro" } }] },
            } as never,
          },
        }),
        true,
      );
    }
  });

  assertEquals(
    subscriptionProjections.map((projection) => projection.p_status),
    ["active", "active", "past_due"],
  );
  assertEquals(
    subscriptionProjections.map((projection) => projection.p_event_id),
    [
      "evt_subscription_active",
      "evt_subscription_active",
      "evt_subscription_past_due_older",
    ],
  );
  assertEquals(
    subscriptionProjections.map((projection) => projection.p_event_created_at),
    [
      "2026-07-15T10:46:40.000Z",
      "2026-07-15T10:46:40.000Z",
      "2026-07-15T10:45:00.000Z",
    ],
  );
  assertEquals(
    attemptProjections.map((projection) => projection.status),
    ["active", "active", "failed"],
  );
  assertEquals(
    attemptProjections.map((projection) => projection.event_id),
    [
      "evt_subscription_active",
      "evt_subscription_active",
      "evt_subscription_past_due_older",
    ],
  );
  for (const projection of attemptProjections) {
    assertEquals(projection.owner_id, USER_ID);
    assertEquals(projection.attempt_id, ATTEMPT_ID);
    assertEquals(projection.stripe_subscription_id, "sub_durable");
  }
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
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
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
    const capturedBody = body as Record<string, unknown> | null;
    assert(capturedBody);
    assertEquals(capturedBody.p_user_id, "user-1");
    assertEquals(capturedBody.p_plan_code, "pro");
    assertEquals(capturedBody.p_status, "active");
    assertEquals(capturedBody.p_stripe_subscription_id, "sub_1");
    assertEquals(capturedBody.p_stripe_price_id, "price_pro");
    assertEquals(capturedBody.p_event_id, "evt_subscription_1");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
