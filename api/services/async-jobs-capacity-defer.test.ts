import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  type AsyncJob,
  asyncJobAdmissionStatus,
  cleanupStaleJobs,
  deferJobAfterAdmission,
} from "./async-jobs.ts";

function testJob(): AsyncJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    app_id: "22222222-2222-4222-8222-222222222222",
    user_id: "33333333-3333-4333-8333-333333333333",
    owner_id: "33333333-3333-4333-8333-333333333333",
    function_name: "work",
    status: "running",
    args: {},
    caller_app_id: null,
    caller_grant_id: null,
    hop: null,
    result: null,
    result_r2_key: null,
    error: null,
    logs: [],
    duration_ms: null,
    ai_cost_light: 0,
    execution_id: "exec-1",
    server_instance: "worker-1",
    started_at: "2026-07-18T00:00:00.000Z",
    completed_at: null,
    expires_at: "2026-07-18T01:00:00.000Z",
    meta: { capacity_defer_count: 2, keep: "me" },
    created_at: "2026-07-18T00:00:00.000Z",
  };
}

Deno.test("async job admission defer is CAS guarded and preserves durable wait metadata", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  let seenUrl: URL | null = null;
  let seenBody: Record<string, unknown> = {};
  globalThis.__env = {
    ...(previousEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  } as typeof globalThis.__env;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = new URL(input.toString());
    seenBody = JSON.parse(String(init?.body || "{}"));
    return Promise.resolve(
      new Response(JSON.stringify([{ id: testJob().id }]), {
        status: 200,
      }),
    );
  }) as typeof fetch;
  try {
    const deferred = await deferJobAfterAdmission(testJob(), {
      code: "concurrency_waiting",
      retryAt: "2026-07-19T00:00:00.000Z",
      message: "AI concurrency is full",
      details: { concurrency_scope: "ai" },
    }, "2026-07-18T12:00:00.000Z");
    assertEquals(deferred, true);
    assert(seenUrl !== null);
    assertEquals((seenUrl as URL).searchParams.get("status"), "eq.running");
    assertEquals(seenBody.status, "queued");
    assertEquals(seenBody.started_at, "2026-07-18T12:00:00.000Z");
    assertEquals(seenBody.expires_at, "2026-07-19T01:00:00.000Z");
    const meta = seenBody.meta as Record<string, unknown>;
    assertEquals(meta.keep, "me");
    assertEquals(meta.capacity_defer_count, 3);
    assertEquals(meta.capacity_queue_deferred_cycles, 3);
    assertEquals(meta.capacity_defer_generation, 3);
    assertEquals(meta.capacity_wait_code, "concurrency_waiting");
    assertEquals(
      (meta.capacity_wait_details as Record<string, unknown>)
        .concurrency_scope,
      "ai",
    );
    assertEquals(
      asyncJobAdmissionStatus({
        ...testJob(),
        status: "queued",
        meta,
      }),
      {
        code: "concurrency_waiting",
        retryAt: "2026-07-19T00:00:00.000Z",
        nextAttemptAt: "2026-07-18T12:00:00.000Z",
        scope: "ai",
        message: "AI concurrency is full",
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});

Deno.test("stale async-job sweep gives scheduled admission waits a delivery grace window", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  let probeUrl: URL | null = null;
  globalThis.__env = {
    ...(previousEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  } as typeof globalThis.__env;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    probeUrl = new URL(input.toString());
    return Promise.resolve(new Response("[]", { status: 200 }));
  }) as typeof fetch;
  try {
    assertEquals(await cleanupStaleJobs(), 0);
    assert(probeUrl !== null);
    const filter = decodeURIComponent((probeUrl as URL).search);
    assert(filter.includes("status.eq.queued"));
    assert(filter.includes("started_at.is.null"));
    assert(filter.includes("started_at.lt."));
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});
