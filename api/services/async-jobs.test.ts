import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  asyncJobQueueOperationCounts,
  claimQueuedJob,
  cleanupStaleJobs,
  completeJob,
  createQueuedJob,
  failJobIfActive,
  reclaimJobForSyncFallback,
} from "./async-jobs.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

// Captured PATCH bodies, appended by the mocked fetch. Reading via an array
// avoids TS control-flow narrowing closures can't see through.
async function withMockedDb<T>(
  handler: (url: URL, init: RequestInit | undefined) => Response,
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

Deno.test("completeJob: a successful execution writes status completed", async () => {
  const bodies: Record<string, unknown>[] = [];
  await withMockedDb(
    (url, init) => {
      assert(url.pathname.includes("/rest/v1/async_jobs"));
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("[]", { status: 200 });
    },
    () =>
      completeJob("job-1", {
        success: true,
        result: { ok: true },
        logs: [],
        durationMs: 1200,
        aiCostLight: 0.4,
      }),
  );
  assert(bodies.length === 1);
  assertEquals(bodies[0].status, "completed");
  assertEquals(bodies[0].error, null);
  assertEquals(bodies[0].ai_cost_light, 0.4);
});

Deno.test("completeJob: a FAILED execution writes status failed with a {type,message} error", async () => {
  const bodies: Record<string, unknown>[] = [];
  await withMockedDb(
    (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("[]", { status: 200 });
    },
    () =>
      completeJob("job-2", {
        success: false,
        // executeAppFunction passes result.error here on failure.
        result: { type: "AbortError", message: "Execution timed out" },
        logs: [{ level: "error", message: "boom" }],
        durationMs: 120_000,
        aiCostLight: 1.2,
      }),
  );
  assert(bodies.length === 1);
  assertEquals(bodies[0].status, "failed");
  assertEquals(bodies[0].result, null);
  assertEquals(bodies[0].error, {
    type: "AbortError",
    message: "Execution timed out",
  });
  // Spend that happened before the failure stays on the row.
  assertEquals(bodies[0].ai_cost_light, 1.2);
});

Deno.test("createQueuedJob: persists the full execution request, never a bearer token", async () => {
  const bodies: Record<string, unknown>[] = [];
  const jobId = await withMockedDb(
    (url, init) => {
      assert(url.pathname.endsWith("/rest/v1/async_jobs"));
      assertEquals(init?.method, "POST");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("[]", { status: 201 });
    },
    () =>
      createQueuedJob({
        appId: "app-1",
        userId: "user-1",
        ownerId: "owner-1",
        functionName: "slow_fn",
        args: { prompt: "hello" },
        callerAppId: "caller-app",
        callerGrantId: "grant-1",
        hop: 2,
        meta: { executionTimeoutMs: 300_000 },
      }),
  );
  assertEquals(bodies.length, 1);
  const body = bodies[0];
  assertEquals(body.status, "queued");
  assertEquals(body.id, jobId);
  assertEquals(body.args, { prompt: "hello" });
  assertEquals(body.caller_app_id, "caller-app");
  assertEquals(body.caller_grant_id, "grant-1");
  assertEquals(body.hop, 2);
  // execution_id is minted fresh: it becomes the sandbox executionId on claim.
  assert(typeof body.execution_id === "string" && body.execution_id.length > 0);
  // The design invariant: user credentials never ride the queue/job row.
  const serialized = JSON.stringify(body).toLowerCase();
  assert(!serialized.includes("token"));
  assert(!serialized.includes("bearer"));
  assertEquals(body.meta, {
    executionTimeoutMs: 300_000,
    capacity_queue_deferred_cycles: 0,
    capacity_queue_delivery_cycles: 0,
    capacity_queue_operations: { write: 1, read: 0, delete: 0, total: 1 },
  });
});

Deno.test("async queue facts count one normal write/read/delete cycle per delivery", () => {
  assertEquals(asyncJobQueueOperationCounts({ meta: {} }), {
    deferredCycles: 0,
    deliveryCycles: 1,
    write: 1,
    read: 1,
    delete: 1,
    total: 3,
  });
  assertEquals(
    asyncJobQueueOperationCounts({
      meta: { capacity_defer_count: 2 },
    }),
    {
      deferredCycles: 2,
      deliveryCycles: 3,
      write: 3,
      read: 3,
      delete: 3,
      total: 9,
    },
  );
});

Deno.test("claimQueuedJob: claims only queued rows and returns the claimed row", async () => {
  const requests: { url: URL; body: Record<string, unknown> }[] = [];
  const row = { id: "job-9", status: "running", function_name: "fn" };
  const claimed = await withMockedDb(
    (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      assertEquals(init?.method, "PATCH");
      return new Response(JSON.stringify([row]), { status: 200 });
    },
    () => claimQueuedJob("job-9"),
  );
  assertEquals(requests.length, 1);
  // The status filter IS the at-most-once guard — a duplicate delivery's
  // PATCH matches zero rows.
  assertEquals(requests[0].url.searchParams.get("status"), "eq.queued");
  assertEquals(requests[0].url.searchParams.get("id"), "eq.job-9");
  assertEquals(
    requests[0].url.searchParams.get(
      "meta->>capacity_defer_generation",
    ),
    "is.null",
  );
  assert(
    requests[0].url.searchParams.get("or")?.includes("started_at.lte."),
  );
  assertEquals(requests[0].body.status, "running");
  assert(typeof requests[0].body.started_at === "string");
  assertEquals(claimed?.id, "job-9");
});

Deno.test("claimQueuedJob: a delayed message can claim only its matching generation when due", async () => {
  const requests: URL[] = [];
  await withMockedDb(
    (url) => {
      requests.push(url);
      return new Response("[]", { status: 200 });
    },
    () =>
      claimQueuedJob("job-generation", {
        deferGeneration: 3,
        now: new Date("2026-07-18T12:00:00.000Z"),
      }),
  );
  assertEquals(
    requests[0].searchParams.get("meta->>capacity_defer_generation"),
    "eq.3",
  );
  assertEquals(
    requests[0].searchParams.get("or"),
    "(started_at.is.null,started_at.lte.2026-07-18T12:00:00.000Z)",
  );
});

Deno.test("claimQueuedJob: duplicate delivery (already claimed) returns null", async () => {
  const claimed = await withMockedDb(
    () => new Response("[]", { status: 200 }),
    () => claimQueuedJob("job-9"),
  );
  assertEquals(claimed, null);
});

Deno.test("claimQueuedJob: infra failure throws (so the consumer can retry pre-claim)", async () => {
  await withMockedDb(
    () => new Response("db down", { status: 500 }),
    () => assertRejects(() => claimQueuedJob("job-9")),
  );
});

Deno.test("failJobIfActive: only touches non-terminal rows", async () => {
  const requests: { url: URL; body: Record<string, unknown> }[] = [];
  await withMockedDb(
    (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("[]", { status: 200 });
    },
    () =>
      failJobIfActive("job-5", {
        type: "ExecutionError",
        message: "boom",
      }, 42),
  );
  assertEquals(requests.length, 1);
  // Guard: a row the pipeline already finalized (e.g. insufficient-balance
  // wrote a detailed failure first) must not be clobbered.
  assertEquals(
    requests[0].url.searchParams.get("status"),
    "in.(queued,running)",
  );
  assertEquals(requests[0].body.status, "failed");
});

Deno.test("cleanupStaleJobs: empty probe issues NO write", async () => {
  const methods: string[] = [];
  const count = await withMockedDb(
    (_url, init) => {
      methods.push(init?.method ?? "GET");
      return new Response("[]", { status: 200 });
    },
    () => cleanupStaleJobs(),
  );
  assertEquals(count, 0);
  // Probe-then-write: the minute cron must not PATCH blindly every tick.
  assertEquals(methods, ["GET"]);
});

Deno.test("cleanupStaleJobs: stale rows get a single guarded PATCH", async () => {
  const requests: { method: string; url: URL }[] = [];
  const count = await withMockedDb(
    (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (method === "GET") {
        return new Response(
          JSON.stringify([{ id: "stale-1" }, { id: "stale-2" }]),
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    },
    () => cleanupStaleJobs(),
  );
  assertEquals(count, 2);
  assertEquals(requests.map((r) => r.method), ["GET", "PATCH"]);
  const probe = requests[0].url;
  // running staleness keys off started_at (claim time), not created_at —
  // created_at would wrongly kill jobs that merely waited in a backlog.
  const orFilter = probe.searchParams.get("or") ?? "";
  assert(orFilter.includes("status.eq.running,started_at.lt."));
  assert(orFilter.includes("status.eq.queued,created_at.lt."));
  const patch = requests[1].url;
  assertEquals(patch.searchParams.get("id"), "in.(stale-1,stale-2)");
  // The write re-applies the FULL staleness filter: a job claimed (or
  // settled) between probe and PATCH no longer matches and is skipped.
  assertEquals(patch.searchParams.get("or"), orFilter);
});

Deno.test("reclaimJobForSyncFallback: winning the row back permits sync execution", async () => {
  const requests: { url: URL; body: Record<string, unknown> }[] = [];
  const won = await withMockedDb(
    (url, init) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify([{ id: "job-1" }]), { status: 200 });
    },
    () =>
      reclaimJobForSyncFallback("job-1", {
        type: "QueueError",
        message: "send failed",
      }),
  );
  assertEquals(won, true);
  // Races the consumer through the SAME status filter the claim uses.
  assertEquals(requests[0].url.searchParams.get("status"), "eq.queued");
  assertEquals(requests[0].body.status, "failed");
});

Deno.test("reclaimJobForSyncFallback: consumer already claimed → false (never run sync)", async () => {
  const won = await withMockedDb(
    () => new Response("[]", { status: 200 }),
    () =>
      reclaimJobForSyncFallback("job-1", {
        type: "QueueError",
        message: "send failed",
      }),
  );
  assertEquals(won, false);
});

Deno.test("reclaimJobForSyncFallback: ambiguous infra failure → false (don't risk doubling)", async () => {
  const won = await withMockedDb(
    () => new Response("db down", { status: 500 }),
    () =>
      reclaimJobForSyncFallback("job-1", {
        type: "QueueError",
        message: "send failed",
      }),
  );
  assertEquals(won, false);
});

Deno.test("completeJob: failure with a non-object error payload still lands {type,message}", async () => {
  const bodies: Record<string, unknown>[] = [];
  await withMockedDb(
    (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("[]", { status: 200 });
    },
    () =>
      completeJob("job-3", {
        success: false,
        result: null,
        logs: [],
        durationMs: 50,
        aiCostLight: 0,
      }),
  );
  assert(bodies.length === 1);
  assertEquals(bodies[0].status, "failed");
  assertEquals(bodies[0].error, {
    type: "ExecutionError",
    message: "Execution failed",
  });
});
