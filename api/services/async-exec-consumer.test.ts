// processExecMessage: the queue-facing half of the at-most-once contract.
// Load-bearing cases: retry is ONLY allowed before the claim succeeds; once
// a job is claimed, every path acks (a crashed execution may already have
// settled — re-running it would double side-effects and billing).

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { processExecMessage } from "./async-exec-consumer.ts";

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
): Promise<{ result: T; requests: SeenRequest[] }> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const requests: SeenRequest[] = [];
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
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

Deno.test("consumer: malformed message acks without touching the database", async () => {
  const { result, requests } = await withMockedDb(
    () => new Response("[]", { status: 200 }),
    async () => ({
      missing: await processExecMessage({ nope: true }),
      nonObject: await processExecMessage("job-1"),
      nullBody: await processExecMessage(null),
    }),
  );
  assertEquals(result, { missing: "ack", nonObject: "ack", nullBody: "ack" });
  assertEquals(requests.length, 0);
});

Deno.test("consumer: claim infra failure → retry (nothing has executed)", async () => {
  const { result } = await withMockedDb(
    () => new Response("db down", { status: 500 }),
    () => processExecMessage({ jobId: "job-1" }),
  );
  assertEquals(result, "retry");
});

Deno.test("consumer: duplicate delivery (claim returns nothing) → ack, no execution", async () => {
  const { result, requests } = await withMockedDb(
    () => new Response("[]", { status: 200 }),
    () => processExecMessage({ jobId: "job-1" }),
  );
  assertEquals(result, "ack");
  // Claim PATCH plus a deferred-schedule probe; the execution never starts.
  assertEquals(requests.length, 2);
  assertEquals(requests[0].method, "PATCH");
  assertEquals(requests[0].url.searchParams.get("status"), "eq.queued");
  assertEquals(requests[1].method, "GET");
});

Deno.test("consumer: claimed job whose Agent is gone → failed row, ack (never retry post-claim)", async () => {
  const claimedRow = {
    id: "job-7",
    app_id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    owner_id: "22222222-2222-4222-8222-222222222222",
    function_name: "slow_fn",
    status: "running",
    args: {},
    caller_app_id: null,
    caller_grant_id: null,
    hop: null,
    execution_id: "33333333-3333-4333-8333-333333333333",
    meta: {},
  };
  const { result, requests } = await withMockedDb(
    (url, init) => {
      const method = init?.method ?? "GET";
      if (
        method === "PATCH" && url.searchParams.get("status") === "eq.queued"
      ) {
        return new Response(JSON.stringify([claimedRow]), { status: 200 });
      }
      if (method === "GET" && url.pathname.endsWith("/rest/v1/apps")) {
        // The Agent was deleted after the job was queued.
        return new Response("[]", { status: 200 });
      }
      return new Response("[]", { status: 200 });
    },
    () => processExecMessage({ jobId: "job-7" }),
  );
  assertEquals(result, "ack");
  const failPatch = requests.find((r) =>
    r.method === "PATCH" &&
    r.url.searchParams.get("status") === "in.(queued,running)"
  );
  assert(failPatch, "expected a guarded failJobIfActive PATCH");
  assertEquals(failPatch.body?.status, "failed");
  assertEquals(
    (failPatch.body?.error as { type?: string } | undefined)?.type,
    "AppNotFound",
  );
});

Deno.test("consumer: structured admission defer schedules a fresh delayed message and acks", async () => {
  const claimedRow = {
    id: "job-wait",
    app_id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    owner_id: "22222222-2222-4222-8222-222222222222",
    function_name: "slow_fn",
    status: "running",
    args: {},
    caller_app_id: null,
    caller_grant_id: null,
    hop: null,
    execution_id: "33333333-3333-4333-8333-333333333333",
    meta: {},
    expires_at: "2026-07-18T04:00:00.000Z",
  };
  const sent: Array<{ body: unknown; delaySeconds?: number }> = [];
  const previousEnv = globalThis.__env;
  const nextDeliveryAt = new Date(Date.now() + 60_000).toISOString();
  let seenJobMeta: Record<string, unknown> | null = null;
  try {
    globalThis.__env = {
      ...(previousEnv || {}),
      EXEC_QUEUE: {
        send: (body: unknown, options?: { delaySeconds?: number }) => {
          sent.push({ body, delaySeconds: options?.delaySeconds });
          return Promise.resolve();
        },
      },
    } as typeof globalThis.__env;
    const { result } = await withMockedDb(
      (url, init) => {
        if (
          (init?.method ?? "GET") === "PATCH" &&
          url.searchParams.get("status") === "eq.queued"
        ) {
          return new Response(JSON.stringify([claimedRow]), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      },
      () =>
        processExecMessage({ jobId: "job-wait" }, {
          executeQueuedJob: (job) => {
            seenJobMeta = job.meta;
            return Promise.resolve({
              kind: "deferred",
              retryAt: nextDeliveryAt,
              nextDeliveryAt,
              deferGeneration: 1,
            });
          },
        }),
    );
    assertEquals(result, "ack");
    assertEquals(sent.length, 1);
    assertEquals(sent[0].body, { jobId: "job-wait", deferGeneration: 1 });
    assertEquals(seenJobMeta?.capacity_queue_deferred_cycles, 0);
    assertEquals(seenJobMeta?.capacity_queue_delivery_cycles, 1);
    assertEquals(seenJobMeta?.capacity_queue_operations, {
      write: 1,
      read: 1,
      delete: 1,
      total: 3,
    });
    assert(
      typeof sent[0].delaySeconds === "number" &&
        sent[0].delaySeconds >= 1 && sent[0].delaySeconds <= 60,
    );
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("consumer: failed delayed send is repaired without hot-claiming the deferred job", async () => {
  const now = Date.now();
  const nextDeliveryAt = new Date(now + 5 * 60_000).toISOString();
  const claimedRow = {
    id: "job-send-repair",
    app_id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    owner_id: "22222222-2222-4222-8222-222222222222",
    function_name: "slow_fn",
    status: "running",
    args: {},
    caller_app_id: null,
    caller_grant_id: null,
    hop: null,
    execution_id: "33333333-3333-4333-8333-333333333333",
    meta: {},
    expires_at: new Date(now + 60 * 60_000).toISOString(),
  };
  const deferredRow = {
    id: claimedRow.id,
    started_at: nextDeliveryAt,
    meta: {
      capacity_defer_count: 1,
      capacity_defer_generation: 1,
      capacity_wait_code: "capacity_waiting",
      capacity_next_delivery_at: nextDeliveryAt,
    },
  };
  const sent: unknown[] = [];
  let sendAttempts = 0;
  let claimAttempts = 0;
  let executions = 0;
  const previousEnv = globalThis.__env;
  try {
    globalThis.__env = {
      ...(previousEnv || {}),
      EXEC_QUEUE: {
        send: (body: unknown) => {
          sent.push(body);
          sendAttempts++;
          return sendAttempts === 1
            ? Promise.reject(new Error("broker unavailable"))
            : Promise.resolve();
        },
      },
    } as typeof globalThis.__env;

    const { result, requests } = await withMockedDb(
      (url, init) => {
        if (
          (init?.method ?? "GET") === "PATCH" &&
          url.searchParams.get("status") === "eq.queued"
        ) {
          claimAttempts++;
          return new Response(
            JSON.stringify(claimAttempts === 1 ? [claimedRow] : []),
            { status: 200 },
          );
        }
        if ((init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify([deferredRow]), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      },
      async () => {
        const first = await processExecMessage(
          { jobId: claimedRow.id },
          {
            executeQueuedJob: () => {
              executions++;
              return Promise.resolve({
                kind: "deferred",
                retryAt: nextDeliveryAt,
                nextDeliveryAt,
                deferGeneration: 1,
              });
            },
          },
        );
        // This is the broker retry of the predecessor message. It carries no
        // generation and must repair generation 1, never execute immediately.
        const second = await processExecMessage(
          { jobId: claimedRow.id },
          {
            executeQueuedJob: () => {
              executions++;
              return Promise.resolve({ kind: "complete" });
            },
          },
        );
        return { first, second };
      },
    );

    assertEquals(result, { first: "retry", second: "ack" });
    assertEquals(executions, 1, "predecessor retry must not hot-execute");
    assertEquals(sent, [
      { jobId: claimedRow.id, deferGeneration: 1 },
      { jobId: claimedRow.id, deferGeneration: 1 },
    ]);
    const claims = requests.filter((request) => request.method === "PATCH");
    assertEquals(claims.length, 2);
    assertEquals(
      claims[1].url.searchParams.get("meta->>capacity_defer_generation"),
      "is.null",
      "the predecessor message cannot claim generation 1",
    );
  } finally {
    globalThis.__env = previousEnv;
  }
});
