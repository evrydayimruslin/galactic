import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { maybeCompleteFunnelCheckout } from "./funnel-claim.ts";

const PROVISIONAL = "00000000-0000-4000-8000-000000000001";
const CODE = "abcdefghjkmnpqrs2345";

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        customer: "cus_123",
        metadata: { funnel_pairing_code: CODE },
        customer_details: { email: "New.Member@Example.com" },
        ...overrides,
      },
    },
  };
}

interface StubState {
  requests: Array<{ method: string; url: string; body: unknown }>;
  funnelRows: Record<string, unknown>[];
  userRows: Record<string, unknown>[];
  claims: Array<Record<string, unknown>>;
}

function options(state: StubState) {
  return {
    supabaseUrl: "https://supabase.example.test",
    serviceRoleKey: "service-role-test-key",
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body)
        : undefined;
      state.requests.push({ method, url, body });
      if (url.includes("/rest/v1/funnel_sessions?")) {
        return Response.json(state.funnelRows);
      }
      if (url.includes("/rest/v1/users?") && method === "GET") {
        return Response.json(state.userRows);
      }
      if (url.includes("/rest/v1/users?") && method === "PATCH") {
        return Response.json([{ id: "patched" }]);
      }
      throw new Error(`Unexpected claim-test request: ${method} ${url}`);
    }) as typeof fetch,
    claim: (input: Record<string, unknown>) => {
      state.claims.push(input);
      // deno-lint-ignore no-explicit-any
      return Promise.resolve({} as any);
    },
  };
}

function baseState(overrides: Partial<StubState> = {}): StubState {
  return {
    requests: [],
    funnelRows: [{ provisional_owner_id: PROVISIONAL, claimed_at: null }],
    userRows: [],
    claims: [],
    ...overrides,
  };
}

Deno.test("fresh email promotes the provisional row in place and claims", async () => {
  const state = baseState();
  const outcome = await maybeCompleteFunnelCheckout(event(), options(state));
  assertEquals(outcome, { kind: "promoted_and_claimed", userId: PROVISIONAL });

  const patch = state.requests.find((entry) => entry.method === "PATCH");
  assert(patch, "the provisional users row is patched");
  assert(
    patch.url.includes(`id=eq.${PROVISIONAL}`) &&
      patch.url.includes("account_kind=eq.provisional"),
    "promotion is guarded to the provisional row",
  );
  const body = patch.body as Record<string, unknown>;
  assertEquals(body.email, "new.member@example.com");
  assertEquals(body.account_kind, "member");
  assertEquals(body.stripe_customer_id, "cus_123");
  assertEquals(state.claims.length, 1);
  assertEquals(state.claims[0].claimedBy, PROVISIONAL);
});

Deno.test("existing email links the Stripe customer but never auto-claims", async () => {
  const state = baseState({
    userRows: [{
      id: "existing-user",
      stripe_customer_id: null,
      account_kind: "member",
    }],
  });
  const outcome = await maybeCompleteFunnelCheckout(event(), options(state));
  assertEquals(outcome, {
    kind: "existing_account_linked",
    userId: "existing-user",
  });
  const patch = state.requests.find((entry) => entry.method === "PATCH");
  assert(patch, "the existing account gains the customer mapping");
  assertEquals(
    (patch.body as Record<string, unknown>).stripe_customer_id,
    "cus_123",
  );
  assertEquals(state.claims.length, 0, "the agent stays unclaimed");
});

Deno.test("a conflicting Stripe identity is never overwritten", async () => {
  const state = baseState({
    userRows: [{
      id: "existing-user",
      stripe_customer_id: "cus_other",
      account_kind: "member",
    }],
  });
  const outcome = await maybeCompleteFunnelCheckout(event(), options(state));
  assertEquals(outcome.kind, "existing_account_conflict");
  assertEquals(
    state.requests.filter((entry) => entry.method === "PATCH").length,
    0,
  );
  assertEquals(state.claims.length, 0);
});

Deno.test("non-funnel and email-less events are untouched", async () => {
  const plain = await maybeCompleteFunnelCheckout(
    { type: "checkout.session.completed", data: { object: { metadata: {} } } },
    options(baseState()),
  );
  assertEquals(plain.kind, "not_funnel");

  const wrongType = await maybeCompleteFunnelCheckout(
    { type: "customer.subscription.created", data: { object: {} } },
    options(baseState()),
  );
  assertEquals(wrongType.kind, "not_funnel");

  const state = baseState();
  const noEmail = await maybeCompleteFunnelCheckout(
    event({ customer_details: {} }),
    options(state),
  );
  assertEquals(noEmail.kind, "no_email");
  assertEquals(state.requests.length, 0);
});
