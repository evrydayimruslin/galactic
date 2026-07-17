import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  claimEventById,
  dispatchPendingEvents,
  emitEvent,
} from "./agent-events.ts";
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

function privateOwnerAppRow(
  id = "app-emitter",
  ownerId = "user-1",
  visibility = "private",
) {
  return {
    id,
    owner_id: ownerId,
    visibility,
    deleted_at: null,
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
  const bodies: Record<string, unknown>[] = [];
  await withMockedDb(
    (url, init) => {
      if (url.pathname.endsWith("/rest/v1/apps")) {
        return jsonResponse([privateOwnerAppRow()]);
      }
      assert(url.pathname.endsWith("/rest/v1/agent_events"));
      const parsed = JSON.parse(String(init?.body));
      bodies.push(Array.isArray(parsed) ? parsed[0] : parsed);
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
  assertEquals(bodies.length, 1);
  const body = bodies[0];
  // Identity + status come from the caller-verified inputs, not the payload.
  assertEquals(body.user_id, "user-1");
  assertEquals(body.emitter_app_id, "app-emitter");
  assertEquals(body.capacity_agent_id, "app-emitter");
  assertEquals(body.topic, "sale.created"); // trimmed
  assertEquals(body.status, "pending");
  assertEquals((body.payload as Record<string, unknown>).orderId, "o-99");
});

Deno.test("emitEvent: rejects a non-private or non-owner emitter before enqueue", async () => {
  let eventInsert = false;
  const out = await withMockedDb(
    (url) => {
      if (url.pathname.endsWith("/rest/v1/apps")) {
        return jsonResponse([
          privateOwnerAppRow("app-emitter", "user-1", "public"),
        ]);
      }
      eventInsert = true;
      return jsonResponse([{ id: "evt-unsafe" }], 201);
    },
    () =>
      emitEvent({
        userId: "user-1",
        emitterAppId: "app-emitter",
        topic: "sale.created",
        emitHop: 1,
      }),
  );
  assertEquals(out, { eventId: null, rejected: "private_owner_required" });
  assertEquals(eventInsert, false);
});

Deno.test("emitEvent: persists a distinct signed root Agent after validating both identities", async () => {
  const checkedApps: string[] = [];
  const eventBodies: Record<string, unknown>[] = [];
  const out = await withMockedDb(
    (url, init) => {
      if (url.pathname.endsWith("/rest/v1/apps")) {
        const appId = url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
        checkedApps.push(appId);
        return jsonResponse([privateOwnerAppRow(appId)]);
      }
      const rows = JSON.parse(String(init?.body)) as Record<string, unknown>[];
      eventBodies.push(rows[0]);
      return jsonResponse([{ id: "evt-root" }], 201);
    },
    () =>
      emitEvent({
        userId: "user-1",
        emitterAppId: "app-emitter",
        capacityAgentId: "app-root",
        topic: "sale.created",
        emitHop: 2,
      }),
  );
  assertEquals(out.eventId, "evt-root");
  assertEquals(checkedApps, ["app-emitter", "app-root"]);
  assertEquals(eventBodies[0].emitter_app_id, "app-emitter");
  assertEquals(eventBodies[0].capacity_agent_id, "app-root");
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
        subscribeGrantRow({
          spent_credits_period: 500,
          monthly_cap_credits: 500,
        }),
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
        subscribeGrantRow({
          id: "sub-1",
          target_app_id: "app-a",
          target_function: "onSale",
        }),
        subscribeGrantRow({
          id: "sub-2",
          target_app_id: "app-b",
          target_function: "ship",
        }),
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

// ── PR4: queue-driven dispatch ──────────────────────────────────────────────

interface QueueCapture {
  sent: unknown[];
  failSend?: boolean;
}

// withMockedDb + an EVENT_QUEUE binding (the queue producer is read from
// globalThis.__env, same as the DB config).
async function withMockedDbAndQueue<T>(
  handler: Handler,
  queue: QueueCapture,
  fn: () => Promise<T>,
): Promise<T> {
  return await withMockedDb(handler, async () => {
    const env = globalThis.__env as Record<string, unknown>;
    env.EVENT_QUEUE = {
      send: (body: unknown) => {
        if (queue.failSend) return Promise.reject(new Error("queue down"));
        queue.sent.push(body);
        return Promise.resolve();
      },
    };
    try {
      return await fn();
    } finally {
      delete env.EVENT_QUEUE;
    }
  });
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    user_id: "user-1",
    emitter_app_id: "app-emitter",
    topic: "sale.created",
    payload: { orderId: 7 },
    status: "pending",
    attempts: 0,
    emit_hop: 1,
    lease_until: null,
    created_at: new Date(NOW - 10_000).toISOString(),
    dispatched_at: null,
    ...overrides,
  };
}

Deno.test("emitEvent: enqueues {eventId} to EVENT_QUEUE after the row insert", async () => {
  const queue: QueueCapture = { sent: [] };
  const out = await withMockedDbAndQueue(
    (url) => {
      if (url.pathname.endsWith("/apps")) {
        return jsonResponse([privateOwnerAppRow()]);
      }
      if (url.pathname.endsWith("/agent_events")) {
        return jsonResponse([{ id: "evt-9" }], 201);
      }
      return jsonResponse([]);
    },
    queue,
    () =>
      emitEvent({
        userId: "user-1",
        emitterAppId: "app-emitter",
        topic: "sale.created",
        emitHop: 1,
      }),
  );
  assertEquals(out.eventId, "evt-9");
  assertEquals(queue.sent, [{ eventId: "evt-9" }]);
});

Deno.test("emitEvent: a failed queue send still returns the eventId (sweeper recovers)", async () => {
  const queue: QueueCapture = { sent: [], failSend: true };
  const out = await withMockedDbAndQueue(
    (url) =>
      url.pathname.endsWith("/apps")
        ? jsonResponse([privateOwnerAppRow()])
        : jsonResponse([{ id: "evt-9" }], 201),
    queue,
    () =>
      emitEvent({
        userId: "user-1",
        emitterAppId: "app-emitter",
        topic: "sale.created",
        emitHop: 1,
      }),
  );
  assertEquals(out.eventId, "evt-9");
  assertEquals(queue.sent, []);
});

Deno.test("claimEventById: read-then-claim through the pending/expired-lease filter", async () => {
  const patches: { url: URL; body: Record<string, unknown> }[] = [];
  const claimed = await withMockedDb(
    (url, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return jsonResponse([eventRow({ attempts: 2 })]);
      }
      patches.push({ url, body: JSON.parse(String(init?.body)) });
      return jsonResponse([eventRow({ status: "delivering", attempts: 3 })]);
    },
    () => claimEventById("evt-1", NOW),
  );
  assertEquals(patches.length, 1);
  const filter = patches[0].url.searchParams.get("or") ?? "";
  assert(filter.includes("status.eq.pending"));
  assert(filter.includes("status.eq.delivering,lease_until.lt."));
  assert(filter.includes("status.eq.waiting,next_eligible_at.lte."));
  assertEquals(patches[0].body.status, "delivering");
  // attempts counts dispatch passes, derived from the read row.
  assertEquals(patches[0].body.attempts, 3);
  assertEquals(claimed?.id, "evt-1");
  assertEquals(claimed?.attempts, 3);
});

Deno.test("claimEventById: already claimed (filter matches nothing) → null", async () => {
  const claimed = await withMockedDb(
    (_url, init) =>
      (init?.method ?? "GET") === "GET"
        ? jsonResponse([eventRow({ status: "delivering" })])
        : jsonResponse([]),
    () => claimEventById("evt-1", NOW),
  );
  assertEquals(claimed, null);
});

Deno.test("claimEventById: infra failure throws (queue consumer retries pre-claim)", async () => {
  await withMockedDb(
    () => new Response("db down", { status: 500 }),
    () => assertRejects(() => claimEventById("evt-1", NOW)),
  );
});

Deno.test("sweeper with queue bound: re-enqueues stuck rows only, never dispatches inline", async () => {
  const queue: QueueCapture = { sent: [] };
  const requests: { method: string; url: URL }[] = [];
  const result = await withMockedDbAndQueue(
    (url, init) => {
      requests.push({ method: init?.method ?? "GET", url });
      return jsonResponse([eventRow(), eventRow({ id: "evt-2" })]);
    },
    queue,
    () => dispatchPendingEvents({ nowMs: NOW }),
  );
  assertEquals(result.scanned, 2);
  assertEquals(queue.sent, [{ eventId: "evt-1" }, { eventId: "evt-2" }]);
  // Enqueue-only: a single scan GET, no claim PATCH, no delivery traffic —
  // the cron can never blow its wall budget on a slow fan-out again.
  assertEquals(requests.map((r) => r.method), ["GET"]);
  // Grace window: pending rows younger than the cutoff belong to the queue
  // consumer; sweeping them would race its claim every tick.
  const filter = requests[0].url.searchParams.get("or") ?? "";
  assert(filter.includes("status.eq.waiting,next_eligible_at.lte."));
  const match = filter.match(/status\.eq\.pending,created_at\.lt\.([^)]+)/);
  assert(match, "pending arm must carry a created_at cutoff");
  assertEquals(new Date(match[1]).getTime(), NOW - 2 * 60_000);
});

Deno.test("sweeper without queue (dev): scans without grace and dispatches inline", async () => {
  const methods: string[] = [];
  const scanFilters: string[] = [];
  await withMockedDb(
    (url, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "GET" && url.pathname.endsWith("/agent_events")) {
        scanFilters.push(url.searchParams.get("or") ?? "");
        // Scan returns one pending row; the claim read reuses this handler.
        return jsonResponse([eventRow()]);
      }
      if (method === "PATCH" && url.pathname.endsWith("/agent_events")) {
        const body = JSON.parse(String(init?.body));
        // Claim succeeds; terminal patch captured implicitly.
        return jsonResponse(
          body.status === "delivering"
            ? [eventRow({ status: "delivering", attempts: 1 })]
            : [],
        );
      }
      if (url.pathname.endsWith("/apps")) {
        return jsonResponse([privateOwnerAppRow()]);
      }
      // resolveSubscribers → no grants: zero-subscriber fan-out.
      return jsonResponse([]);
    },
    () => dispatchPendingEvents({ nowMs: NOW }),
  );
  // The pre-queue pending arm exactly: NO created_at predicate (a cross-clock
  // comparison would let DB skew hide a just-emitted row for a tick).
  assert(scanFilters[0].includes("status.eq.pending,and"));
  assert(!scanFilters[0].includes("created_at"));
  // Inline path engaged: at least one PATCH (the claim) was issued.
  assert(methods.includes("PATCH"));
});
