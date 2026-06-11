import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import { emitEvent } from "./agent-events.ts";
import { resolveSubscribeGrant, resolveSubscribers } from "./agent-grants.ts";
import { MAX_AGENT_CALL_HOP_DEPTH } from "../../shared/contracts/agent-grants.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

type Handler = (url: URL, init: RequestInit | undefined) => Response;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withMockedDb<T>(
  handler: Handler,
  fn: () => Promise<T>,
): Promise<T> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

// A subscribe grant: emitter (caller) -> subscriber handler (target), keyed by
// topic. effectiveSpend is computed against period_start, so default to a fresh
// in-month window.
function subscribeGrantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-1",
    user_id: "user-1",
    caller_app_id: "app-emitter",
    caller_function: null,
    slot: null,
    target_app_id: "app-subscriber",
    target_function: "onSale",
    topic: "sale.created",
    mode: "subscribe",
    status: "active",
    monthly_cap_credits: 500,
    spent_credits_period: 0,
    period_start: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    constraints: {},
    created_by: "user",
    created_at: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    ...overrides,
  };
}

const NOW = Date.UTC(2026, 5, 10, 12, 0, 0);

// ── emitEvent ────────────────────────────────────────────────────────────

Deno.test("emitEvent: rejects a topic beyond the hop ceiling WITHOUT touching the DB", async () => {
  let fetched = false;
  await withMockedDb(
    () => {
      fetched = true;
      return jsonResponse([{ id: "evt-should-not-happen" }]);
    },
    async () => {
      const out = await emitEvent({
        userId: "user-1",
        emitterAppId: "app-emitter",
        topic: "sale.created",
        emitHop: MAX_AGENT_CALL_HOP_DEPTH + 1,
      });
      assertEquals(out.eventId, null);
      assertEquals(out.rejected, "hop_exceeded");
    },
  );
  // The hop check fires before any enqueue — a cascade can't be laundered into
  // the queue past the ceiling.
  assertEquals(fetched, false);
});

Deno.test("emitEvent: requires a non-empty topic", async () => {
  await withMockedDb(
    () => jsonResponse([]),
    async () => {
      await assertRejects(
        () =>
          emitEvent({
            userId: "user-1",
            emitterAppId: "app-emitter",
            topic: "   ",
            emitHop: 1,
          }),
        Error,
        "topic is required",
      );
    },
  );
});

Deno.test("emitEvent: rejects an oversized payload before enqueue", async () => {
  let fetched = false;
  await withMockedDb(
    () => {
      fetched = true;
      return jsonResponse([{ id: "evt-x" }]);
    },
    async () => {
      const big = { blob: "x".repeat(40 * 1024) }; // > 32KB serialized
      await assertRejects(
        () =>
          emitEvent({
            userId: "user-1",
            emitterAppId: "app-emitter",
            topic: "sale.created",
            payload: big,
            emitHop: 1,
          }),
        Error,
        "payload must be",
      );
    },
  );
  assertEquals(fetched, false);
});

Deno.test("emitEvent: a dropped emit (storage unconfigured) reports not_configured, never silent ok", async () => {
  // No SUPABASE_* env -> getDbConfig() returns null. Restore env around the call.
  const previousEnv = globalThis.__env;
  globalThis.__env = {} as typeof globalThis.__env;
  try {
    const out = await emitEvent({
      userId: "user-1",
      emitterAppId: "app-emitter",
      topic: "sale.created",
      emitHop: 1,
    });
    assertEquals(out.eventId, null);
    assertEquals(out.rejected, "not_configured");
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("emitEvent: enqueues a pending row and returns its id", async () => {
  let body: Record<string, unknown> | null = null;
  await withMockedDb(
    (url, init) => {
      assert(url.pathname.endsWith("/rest/v1/agent_events"));
      const parsed = JSON.parse(String(init?.body));
      body = Array.isArray(parsed) ? parsed[0] : parsed;
      return jsonResponse([{ id: "evt-1" }], 201);
    },
    async () => {
      const out = await emitEvent({
        userId: "user-1",
        emitterAppId: "app-emitter",
        topic: "  sale.created  ",
        payload: { orderId: "o-99" },
        emitHop: 1,
      });
      assertEquals(out.eventId, "evt-1");
      assertEquals(out.rejected, undefined);
    },
  );
  assert(body, "expected an enqueue body");
  // Identity + status come from the caller-verified inputs, not the payload.
  assertEquals(body!.user_id, "user-1");
  assertEquals(body!.emitter_app_id, "app-emitter");
  assertEquals(body!.topic, "sale.created"); // trimmed
  assertEquals(body!.status, "pending");
  assertEquals((body!.payload as Record<string, unknown>).orderId, "o-99");
});

// ── resolveSubscribeGrant ──────────────────────────────────────────────────

Deno.test("resolveSubscribeGrant: an active in-cap subscribe grant allows delivery", async () => {
  await withMockedDb(
    () => jsonResponse([subscribeGrantRow()]),
    async () => {
      const result = await resolveSubscribeGrant({
        userId: "user-1",
        emitterAppId: "app-emitter",
        subscriberAppId: "app-subscriber",
        targetFunction: "onSale",
        topic: "sale.created",
        nowMs: NOW,
      });
      assertEquals(result.allowed, true);
      assertEquals(result.grant?.id, "sub-1");
    },
  );
});

Deno.test("resolveSubscribeGrant: a cap-reached grant denies delivery (bounds reactive spend)", async () => {
  await withMockedDb(
    () =>
      jsonResponse([
        subscribeGrantRow({ spent_credits_period: 500, monthly_cap_credits: 500 }),
      ]),
    async () => {
      const result = await resolveSubscribeGrant({
        userId: "user-1",
        emitterAppId: "app-emitter",
        subscriberAppId: "app-subscriber",
        targetFunction: "onSale",
        topic: "sale.created",
        nowMs: NOW,
      });
      assertEquals(result.allowed, false);
      assertEquals(result.reason, "cap_exceeded");
    },
  );
});

Deno.test("resolveSubscribeGrant: no matching subscribe grant denies with no_grant", async () => {
  await withMockedDb(
    () => jsonResponse([]),
    async () => {
      const result = await resolveSubscribeGrant({
        userId: "user-1",
        emitterAppId: "app-emitter",
        subscriberAppId: "app-subscriber",
        targetFunction: "onSale",
        topic: "sale.created",
        nowMs: NOW,
      });
      assertEquals(result.allowed, false);
      assertEquals(result.reason, "no_grant");
    },
  );
});

// ── resolveSubscribers ─────────────────────────────────────────────────────

Deno.test("resolveSubscribers: returns the active subscribe grants for an emitter+topic", async () => {
  await withMockedDb(
    (url) => {
      // The fan-out query is scoped to the emitter, topic, subscribe mode, and
      // active status — never a broad scan.
      assert(url.search.includes("caller_app_id=eq.app-emitter"));
      assert(url.search.includes("mode=eq.subscribe"));
      assert(url.search.includes("status=eq.active"));
      return jsonResponse([
        subscribeGrantRow({ id: "sub-1", target_app_id: "app-a", target_function: "onSale" }),
        subscribeGrantRow({ id: "sub-2", target_app_id: "app-b", target_function: "ship" }),
      ]);
    },
    async () => {
      const subs = await resolveSubscribers({
        userId: "user-1",
        emitterAppId: "app-emitter",
        topic: "sale.created",
      });
      assertEquals(subs.length, 2);
      assertEquals(subs[0].targetAppId, "app-a");
      assertEquals(subs[1].targetFunction, "ship");
    },
  );
});
