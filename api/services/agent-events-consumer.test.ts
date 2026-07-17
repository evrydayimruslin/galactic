// processEventMessage: the queue-facing half of the event bus's at-most-once
// contract. Retry is ONLY allowed before the event claim; after it, the
// event-row state machine (attempt ceiling, lease, sweeper) owns recovery —
// per-delivery rows guarantee a subscriber handler is invoked at most once.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { processEventMessage } from "./agent-events-consumer.ts";
import { dispatchClaimedEvent } from "./agent-events.ts";
import type { AgentEvent } from "../../shared/contracts/agent-grants.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

interface SeenRequest {
  method: string;
  url: URL;
  body: Record<string, unknown> | null;
}

async function withMockedDb<T>(
  handler: (url: URL, init: RequestInit | undefined) => Response,
  fn: () => Promise<T>,
  queueSent?: unknown[],
): Promise<{ result: T; requests: SeenRequest[] }> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const requests: SeenRequest[] = [];
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
    ...(queueSent
      ? {
        EVENT_QUEUE: {
          send: (body: unknown) => {
            queueSent.push(body);
            return Promise.resolve();
          },
        },
      }
      : {}),
  } as typeof globalThis.__env;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    let body: Record<string, unknown> | null = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    requests.push({ method: init?.method ?? "GET", url, body });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  try {
    return { result: await fn(), requests };
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
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
    created_at: new Date(Date.now() - 10_000).toISOString(),
    dispatched_at: null,
    ...overrides,
  };
}

function subscribeGrantRow(n: number) {
  return {
    id: `sub-${n}`,
    user_id: "user-1",
    caller_app_id: "app-emitter",
    caller_function: null,
    slot: null,
    target_app_id: `app-subscriber-${n}`,
    target_function: "onSale",
    topic: "sale.created",
    mode: "subscribe",
    status: "active",
    monthly_cap_credits: 500,
    spent_credits_period: 0,
    period_start: new Date(Date.now() - 86_400_000).toISOString(),
    constraints: {},
    created_by: "user",
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
    updated_at: new Date(Date.now() - 86_400_000).toISOString(),
  };
}

function privateOwnerAppRow(id: string) {
  return {
    id,
    owner_id: "user-1",
    visibility: "private",
    deleted_at: null,
  };
}

Deno.test("event consumer: malformed message acks without touching the database", async () => {
  const { result, requests } = await withMockedDb(
    () => new Response("[]", { status: 200 }),
    async () => ({
      missing: await processEventMessage({ nope: true }),
      nonObject: await processEventMessage("evt-1"),
    }),
  );
  assertEquals(result, { missing: "ack", nonObject: "ack" });
  assertEquals(requests.length, 0);
});

Deno.test("event consumer: claim infra failure → retry (nothing dispatched)", async () => {
  const { result } = await withMockedDb(
    () => new Response("db down", { status: 500 }),
    () => processEventMessage({ eventId: "evt-1" }),
  );
  assertEquals(result, "retry");
});

Deno.test("event consumer: duplicate delivery (claim lost) → ack, no fan-out", async () => {
  const { result, requests } = await withMockedDb(
    (_url, init) =>
      (init?.method ?? "GET") === "GET"
        ? new Response(JSON.stringify([eventRow({ status: "delivering" })]), {
          status: 200,
        })
        : new Response("[]", { status: 200 }),
    () => processEventMessage({ eventId: "evt-1" }),
  );
  assertEquals(result, "ack");
  // The claim read + the losing claim PATCH — no grants/deliveries traffic.
  assertEquals(requests.map((r) => r.method), ["GET", "PATCH"]);
});

Deno.test("event consumer: failed delivery is recorded per-row and the event ends 'failed'", async () => {
  const deliveryPatches: Record<string, unknown>[] = [];
  const eventPatches: Record<string, unknown>[] = [];
  const { result } = await withMockedDb(
    (url, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.pathname.endsWith("/agent_events")) {
        if (method === "GET") {
          return new Response(JSON.stringify([eventRow()]), { status: 200 });
        }
        if (body?.status === "delivering") {
          return new Response(
            JSON.stringify([eventRow({ status: "delivering", attempts: 1 })]),
            { status: 200 },
          );
        }
        eventPatches.push(body as Record<string, unknown>);
        return new Response("[]", { status: 200 });
      }
      if (url.pathname.endsWith("/agent_function_grants")) {
        return new Response(JSON.stringify([subscribeGrantRow(1)]), {
          status: 200,
        });
      }
      if (url.pathname.endsWith("/agent_event_deliveries")) {
        if (method === "POST") {
          return new Response(JSON.stringify([{ id: "d-1" }]), { status: 201 });
        }
        if (method === "GET") return new Response("[]", { status: 200 });
        deliveryPatches.push(body as Record<string, unknown>);
        return new Response("[]", { status: 200 });
      }
      if (url.pathname.endsWith("/rest/v1/apps")) {
        const appId = url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
        // The emitter remains valid, but the subscriber no longer exists.
        return new Response(
          JSON.stringify(
            appId === "app-emitter" ? [privateOwnerAppRow(appId)] : [],
          ),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    },
    () => processEventMessage({ eventId: "evt-1" }),
  );
  assertEquals(result, "ack");
  assertEquals(deliveryPatches.length, 1);
  assertEquals(deliveryPatches[0].status, "failed");
  assertEquals(eventPatches.length, 1);
  // Failures surface on the event, never silently swallowed (PR1 invariant).
  assertEquals(eventPatches[0].status, "failed");
  assert(
    String(eventPatches[0].last_error ?? "").includes("1 of 1"),
    "last_error should summarize the failed deliveries",
  );
});

Deno.test("reactive delivery: capacity wait persists, preserves root attribution, and resumes once", async () => {
  const resetAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const eventPatches: Record<string, unknown>[] = [];
  const deliveryPatches: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  const executionInputs: Array<Record<string, unknown>> = [];
  let inserted = false;
  let delivery = {
    id: "d-wait",
    grant_id: "sub-1",
    subscriber_app_id: "app-subscriber-1",
    target_function: "onSale",
    status: "pending",
    attempts: 1,
    next_eligible_at: null as string | null,
  };

  const handler = (url: URL, init: RequestInit | undefined): Response => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname.endsWith("/rest/v1/apps")) {
      const appId = url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
      return new Response(JSON.stringify([privateOwnerAppRow(appId)]), {
        status: 200,
      });
    }
    if (url.pathname.endsWith("/agent_function_grants")) {
      return new Response(JSON.stringify([subscribeGrantRow(1)]), {
        status: 200,
      });
    }
    if (url.pathname.endsWith("/agent_event_deliveries")) {
      if (method === "POST") {
        if (inserted) return new Response("[]", { status: 201 });
        inserted = true;
        return new Response(JSON.stringify([{ id: delivery.id }]), {
          status: 201,
        });
      }
      if (method === "PATCH") {
        deliveryPatches.push(body as Record<string, unknown>);
        delivery = { ...delivery, ...(body as typeof delivery) };
        return new Response(
          body?.status === "pending" ? JSON.stringify([delivery]) : "[]",
          { status: 200 },
        );
      }
      if (url.searchParams.get("status") === "eq.failed") {
        return new Response("[]", { status: 200 });
      }
      if (url.searchParams.get("status") === "eq.waiting") {
        return new Response(
          delivery.status === "waiting" ? JSON.stringify([delivery]) : "[]",
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([delivery]), { status: 200 });
    }
    if (url.pathname.endsWith("/agent_events") && method === "PATCH") {
      eventPatches.push(body as Record<string, unknown>);
      return new Response("[]", { status: 200 });
    }
    if (url.pathname.endsWith("/user_notifications") && method === "POST") {
      notifications.push(body as Record<string, unknown>);
      return new Response("[]", { status: 201 });
    }
    return new Response("[]", { status: 200 });
  };

  const claimedEvent: AgentEvent = {
    id: "evt-wait",
    userId: "user-1",
    emitterAppId: "app-emitter",
    capacityAgentId: "app-root",
    topic: "sale.created",
    payload: { orderId: 7 },
    status: "delivering",
    attempts: 1,
    emitHop: 2,
    createdAt: new Date().toISOString(),
    dispatchedAt: null,
    nextEligibleAt: null,
  };
  const executeDelivery = async (input: unknown) => {
    executionInputs.push(input as Record<string, unknown>);
    if (executionInputs.length === 1) {
      return {
        success: false,
        receiptId: null,
        error: "Agent capacity is waiting",
        admission: {
          code: "agent_cap_waiting" as const,
          nextEligibleAt: resetAt,
          capacityAgentId: "app-root",
          bindingConstraint: "agent" as const,
        },
      };
    }
    return { success: true, receiptId: null };
  };

  await withMockedDb(
    handler,
    () => dispatchClaimedEvent(claimedEvent, Date.now(), { executeDelivery }),
  );
  assertEquals(delivery.status, "waiting");
  assertEquals(delivery.next_eligible_at, resetAt);
  assertEquals(eventPatches.at(-1)?.status, "waiting");
  assertEquals(eventPatches.at(-1)?.next_eligible_at, resetAt);
  assertEquals(executionInputs[0].emitterAppId, "app-emitter");
  assertEquals(executionInputs[0].capacityAgentId, "app-root");
  assertEquals(notifications[0]?.agent_id, "app-subscriber-1");
  assertEquals(notifications[0]?.kind, "event_delivery_waiting");

  await withMockedDb(
    handler,
    () =>
      dispatchClaimedEvent(
        { ...claimedEvent, attempts: 2 },
        new Date(resetAt).getTime() + 1,
        { executeDelivery },
      ),
  );
  assertEquals(
    executionInputs.length,
    2,
    "waiting delivery resumes exactly once",
  );
  assertEquals(delivery.status, "delivered");
  assertEquals(eventPatches.at(-1)?.status, "delivered");
  assertEquals(
    deliveryPatches.filter((patch) => patch.status === "pending").length,
    1,
    "only the due waiting row may re-enter the executable state",
  );
});

Deno.test("reactive delivery: a subscriber that leaves owner-private scope is denied with an Agent Alert", async () => {
  const deliveryPatches: Record<string, unknown>[] = [];
  const notifications: Record<string, unknown>[] = [];
  let executions = 0;
  const handler = (url: URL, init: RequestInit | undefined): Response => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname.endsWith("/rest/v1/apps")) {
      const appId = url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
      return new Response(
        JSON.stringify([{
          ...privateOwnerAppRow(appId),
          visibility: appId === "app-subscriber-1" ? "public" : "private",
        }]),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/agent_function_grants")) {
      return new Response(JSON.stringify([subscribeGrantRow(1)]), {
        status: 200,
      });
    }
    if (url.pathname.endsWith("/agent_event_deliveries")) {
      if (method === "POST") {
        return new Response(JSON.stringify([{ id: "d-blocked" }]), {
          status: 201,
        });
      }
      if (method === "PATCH") {
        deliveryPatches.push(body as Record<string, unknown>);
      }
      return new Response("[]", { status: 200 });
    }
    if (url.pathname.endsWith("/user_notifications") && method === "POST") {
      notifications.push(body as Record<string, unknown>);
      return new Response("[]", { status: 201 });
    }
    return new Response("[]", { status: 200 });
  };
  const event: AgentEvent = {
    id: "evt-blocked",
    userId: "user-1",
    emitterAppId: "app-emitter",
    capacityAgentId: "app-emitter",
    topic: "sale.created",
    payload: {},
    status: "delivering",
    attempts: 1,
    emitHop: 1,
    createdAt: new Date().toISOString(),
    dispatchedAt: null,
    nextEligibleAt: null,
  };
  await withMockedDb(
    handler,
    () =>
      dispatchClaimedEvent(event, Date.now(), {
        executeDelivery: async () => {
          executions++;
          return { success: true, receiptId: null };
        },
      }),
  );
  assertEquals(
    executions,
    0,
    "owner-private isolation is checked pre-execution",
  );
  assertEquals(deliveryPatches[0]?.status, "denied");
  assertEquals(notifications[0]?.agent_id, "app-subscriber-1");
  assertEquals(notifications[0]?.kind, "event_delivery_blocked");
});

Deno.test("event consumer: a fan-out beyond the pass budget re-enqueues, and the continuation pass actually progresses", async () => {
  const queueSent: unknown[] = [];
  const eventPatches: Record<string, unknown>[] = [];
  // Stateful at-most-once mock: a (event, grant) pair can be claimed once;
  // later claims return the ignore-duplicates empty array.
  const claimedPairs = new Set<string>();
  let attempts = 0;
  const grants = Array.from({ length: 41 }, (_, i) => subscribeGrantRow(i));
  const handler = (url: URL, init: RequestInit | undefined): Response => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.pathname.endsWith("/agent_events")) {
      if (method === "GET") {
        return new Response(
          JSON.stringify([eventRow({ status: "pending", attempts })]),
          { status: 200 },
        );
      }
      if (body?.status === "delivering") {
        attempts++;
        return new Response(
          JSON.stringify([eventRow({ status: "delivering", attempts })]),
          { status: 200 },
        );
      }
      eventPatches.push(body as Record<string, unknown>);
      return new Response("[]", { status: 200 });
    }
    if (url.pathname.endsWith("/agent_function_grants")) {
      return new Response(JSON.stringify(grants), { status: 200 });
    }
    if (url.pathname.endsWith("/agent_event_deliveries")) {
      if (method === "POST") {
        const rows = Array.isArray(body) ? body : [];
        const key = `${rows[0]?.event_id}:${rows[0]?.grant_id}`;
        if (claimedPairs.has(key)) {
          // resolution=ignore-duplicates: existing row → nothing inserted.
          return new Response("[]", { status: 201 });
        }
        claimedPairs.add(key);
        return new Response(
          JSON.stringify([{ id: `d-${claimedPairs.size}` }]),
          { status: 201 },
        );
      }
      return new Response("[]", { status: 200 });
    }
    if (url.pathname.endsWith("/rest/v1/apps")) {
      const appId = url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
      return new Response(
        JSON.stringify(
          appId === "app-emitter" ? [privateOwnerAppRow(appId)] : [],
        ),
        { status: 200 },
      );
    }
    // Subscriber apps all missing — each attempted delivery fails fast.
    return new Response("[]", { status: 200 });
  };

  // Pass 1: budget cut at 40, event re-enqueued.
  const pass1 = await withMockedDb(
    handler,
    () => processEventMessage({ eventId: "evt-1" }),
    queueSent,
  );
  assertEquals(pass1.result, "ack");
  assertEquals(claimedPairs.size, 40);
  assertEquals(eventPatches.length, 1);
  assertEquals(eventPatches[0].status, "pending");
  assertEquals(queueSent, [{ eventId: "evt-1" }]);

  // Pass 2 (the continuation contract): the 40 settled subscribers are free
  // "already" skips that must NOT consume the budget — subscriber 41 gets its
  // attempt and the event terminalizes instead of cycling to the attempt
  // ceiling with the remainder stranded.
  const pass2 = await withMockedDb(
    handler,
    () => processEventMessage({ eventId: "evt-1" }),
    queueSent,
  );
  assertEquals(pass2.result, "ack");
  assertEquals(claimedPairs.size, 41);
  assertEquals(eventPatches.length, 2);
  // All deliveries failed (apps missing), so the terminal status is failed —
  // the point here is that it TERMINALIZED with full coverage.
  assertEquals(eventPatches[1].status, "failed");
  assertEquals(queueSent.length, 1);
});
