import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  computeNextRoutineRunAt,
  processQueuedRoutineRun,
  runRoutineExecutorCycle,
} from "./routine-executor.ts";

const NOW = new Date("2026-05-17T12:00:00.000Z");

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function routineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "routine-1",
    user_id: "user-1",
    composer_app_id: "composer-app-1",
    composer_app_slug: "email-ops",
    template_id: "sales_followup_loop",
    template_version: "1.2.3",
    name: "Sales follow-up loop",
    description: "Poll email and draft replies.",
    intent: "Handle sales follow-up.",
    handler_function: "poll_email_followups",
    status: "active",
    schedule: { type: "interval", every_minutes: 5 },
    config: { inbox: "sales" },
    budget_policy: { max_light_per_day: 250 },
    approval_policy: {},
    max_concurrency: 1,
    next_run_at: "2026-05-17T11:59:00.000Z",
    last_run_at: null,
    last_success_at: null,
    last_error_at: null,
    failure_count: 0,
    created_by_trace_id: null,
    metadata: {},
    created_at: "2026-05-17T11:00:00.000Z",
    updated_at: "2026-05-17T11:00:00.000Z",
    deleted_at: null,
    lease_id: null,
    lease_expires_at: null,
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    routine_id: "routine-1",
    user_id: "user-1",
    status: "running",
    trigger: "scheduled",
    trace_id: "22222222-2222-4222-8222-222222222222",
    started_at: "2026-05-17T12:00:00.000Z",
    completed_at: null,
    duration_ms: null,
    total_light: 0,
    summary: null,
    error: null,
    run_config: {},
    metadata: {},
    created_at: "2026-05-17T12:00:00.000Z",
    lease_id: "run-lease-1",
    lease_expires_at: "2026-05-17T12:10:00.000Z",
    attempt_count: 1,
    max_attempts: 3,
    next_attempt_at: null,
    ...overrides,
  };
}

// A freshly-queued run as getRunById / queuedRunCandidates return it, ready for
// the consumer (or inline) path to claim queued->running. The cron only
// enqueues; claiming + executing happens against a "queued" row.
function queuedRunRow(overrides: Record<string, unknown> = {}) {
  return runRow({
    status: "queued",
    started_at: null,
    attempt_count: 0,
    lease_id: null,
    lease_expires_at: null,
    ...overrides,
  });
}

// True for the reaper's stale-run probe/write: it is the only routine_runs query
// that filters on lease_expires_at (activeRunCount / queuedRunCandidates /
// getRunById never do).
function isReaperQuery(url: URL): boolean {
  return url.searchParams.has("lease_expires_at");
}

function userRow() {
  return {
    id: "user-1",
    email: "manager@example.com",
    tier: "pro",
    provisional: false,
  };
}

function capabilityRows() {
  return [{
    id: "cap-1",
    routine_id: "routine-1",
    user_id: "user-1",
    app_id: "email-drafter-app",
    app_ref: "email-drafter",
    function_name: "draft_reply",
    access: "write",
    required: true,
    purpose: "Prepare response drafts.",
    approved: true,
    approved_at: "2026-05-17T11:00:00.000Z",
    approved_by_user_id: "user-1",
    pricing_snapshot: {},
    constraints: {},
    metadata: {},
    created_at: "2026-05-17T11:00:00.000Z",
    updated_at: "2026-05-17T11:00:00.000Z",
  }];
}

function installEnv() {
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    ROUTINE_ACTOR_TOKEN_SECRET: "routine-secret",
    BASE_URL: "https://api.example.test",
  };
  return () => {
    globalThis.__env = originalEnv;
  };
}

Deno.test("routine executor: computes interval and cron next runs", () => {
  assertEquals(
    computeNextRoutineRunAt(
      { type: "interval", every_minutes: 5 },
      NOW,
    )?.toISOString(),
    "2026-05-17T12:05:00.000Z",
  );
  assertEquals(
    computeNextRoutineRunAt(
      { type: "interval", every_seconds: 5 },
      NOW,
    )?.toISOString(),
    "2026-05-17T12:01:00.000Z",
  );
  assertEquals(
    computeNextRoutineRunAt(
      { type: "cron", cron: "*/15 * * * *" },
      NOW,
    )?.toISOString(),
    "2026-05-17T12:15:00.000Z",
  );
});

Deno.test("routine executor: claims due routines and invokes composer MCP", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  const dbCalls: Array<{
    table: string;
    method: string;
    body: unknown;
    url: string;
  }> = [];
  const mcpCalls: Array<{ url: string; auth: string | null; body: unknown }> =
    [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    dbCalls.push({ table, method, body, url: url.toString() });

    if (table === "user_routines" && method === "GET") {
      if (url.searchParams.get("status") === "eq.active") {
        return jsonResponse([routineRow()]);
      }
      if (url.searchParams.get("id") === "eq.routine-1") {
        return jsonResponse([routineRow()]);
      }
    }
    if (table === "user_routines" && method === "PATCH") {
      return jsonResponse([{
        ...routineRow(),
        ...(body as Record<string, unknown>),
      }]);
    }
    if (table === "routine_runs" && method === "GET") {
      if (isReaperQuery(url)) return jsonResponse([]); // nothing stale to reap
      if (url.searchParams.get("id")?.startsWith("eq.")) {
        return jsonResponse([queuedRunRow()]); // getRunById -> claimable
      }
      return jsonResponse([]);
    }
    if (table === "routine_runs" && method === "POST") {
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_capabilities") return jsonResponse(capabilityRows());
    if (table === "routine_dashboard_bindings") return jsonResponse([]);
    if (table === "users") return jsonResponse([userRow()]);
    if (table === "routine_run_steps" && method === "POST") {
      return jsonResponse([{
        id: "step-1",
        ...(body as Record<string, unknown>),
      }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const summary = await runRoutineExecutorCycle({
      now: NOW,
      clock: () => NOW,
      limit: 5,
      baseUrl: "https://api.example.test",
      invokeMcp: async (request: Request, appId: string) => {
        const body = await request.json().catch(() => undefined);
        mcpCalls.push({
          url: `${request.url}#${appId}`,
          auth: request.headers.get("Authorization"),
          body,
        });
        return jsonResponse({
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          },
        });
      },
    });

    assertEquals(summary.claimed_scheduled, 1);
    assertEquals(summary.executed, 1);
    assertEquals(summary.succeeded, 1);
    assertEquals(
      mcpCalls[0].url,
      "https://api.example.test/mcp/composer-app-1#composer-app-1",
    );
    assert(mcpCalls[0].auth?.startsWith("Bearer gxr_v1_"));
    // The claim is a FLAT-filter CAS: status=active AND lease_id IS NULL. A
    // nested and=(or,or) filter returns an empty PATCH representation (the update
    // pushes the row out of the filter), which silently orphaned the lease.
    const claimPatch = dbCalls.find((call) =>
      call.table === "user_routines" &&
      call.method === "PATCH" &&
      (call.body as Record<string, unknown>).lease_id
    );
    const claimParams = new URL(claimPatch?.url || "https://supabase.example")
      .searchParams;
    assertEquals(claimParams.get("lease_id"), "is.null");
    assertEquals(claimParams.get("status"), "eq.active");
    assertEquals(claimParams.get("and"), null); // no nested filter
    // Expired leases are cleared before claiming so a crashed routine unwedges.
    const clearExpiredPatch = dbCalls.find((call) =>
      call.table === "user_routines" &&
      call.method === "PATCH" &&
      new URL(call.url).searchParams.get("lease_expires_at")?.startsWith("lt.")
    );
    assert(clearExpiredPatch, "expected an expired-lease clear before claiming");
    const rpcBody = mcpCalls[0].body as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    assertEquals(rpcBody.params.name, "poll_email_followups");
    assertEquals(rpcBody.params.arguments.inbox, "sales");
    assertEquals(
      (rpcBody.params.arguments._routine as Record<string, unknown>)
        .routine_run_id,
      "run-1",
    );
    // The routine's goal is delivered to the handler on every run so agent
    // code can steer autonomous work against it (the /goal contract).
    assertEquals(
      (rpcBody.params.arguments._routine as Record<string, unknown>).intent,
      "Handle sales follow-up.",
    );

    const nextRunPatch = dbCalls.find((call) =>
      call.table === "user_routines" &&
      call.method === "PATCH" &&
      (call.body as Record<string, unknown>).next_run_at
    );
    assertEquals(
      (nextRunPatch?.body as Record<string, unknown>).next_run_at,
      "2026-05-17T12:05:00.000Z",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("routine executor: a post-success bookkeeping failure does NOT re-run the handler", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  let handlerInvocations = 0;
  const runPatches: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (table === "user_routines" && method === "GET") {
      if (url.searchParams.get("status") === "eq.active") {
        return jsonResponse([routineRow()]);
      }
      return jsonResponse([routineRow()]);
    }
    if (table === "user_routines" && method === "PATCH") {
      // The updateRoutineAfterRun success write (carries last_success_at) fails
      // transiently AFTER the handler already succeeded — the exact window that
      // used to route into the retry/re-queue path.
      if ((body as Record<string, unknown>)?.last_success_at) {
        return new Response("boom", { status: 500 });
      }
      return jsonResponse([{ ...routineRow(), ...(body as Record<string, unknown>) }]);
    }
    if (table === "routine_runs" && method === "GET") {
      if (isReaperQuery(url)) return jsonResponse([]);
      if (url.searchParams.get("id")?.startsWith("eq.")) {
        return jsonResponse([queuedRunRow()]);
      }
      return jsonResponse([]);
    }
    if (table === "routine_runs" && method === "POST") {
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      runPatches.push(body as Record<string, unknown>);
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_capabilities") return jsonResponse(capabilityRows());
    if (table === "routine_dashboard_bindings") return jsonResponse([]);
    if (table === "users") return jsonResponse([userRow()]);
    if (table === "routine_run_steps" && method === "POST") {
      return jsonResponse([{ id: "step-1" }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const summary = await runRoutineExecutorCycle({
      now: NOW,
      clock: () => NOW,
      limit: 5,
      baseUrl: "https://api.example.test",
      invokeMcp: async () => {
        handlerInvocations += 1;
        return jsonResponse({
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
        });
      },
    });

    // The handler ran exactly once and the run is reported succeeded, NOT retried.
    assertEquals(handlerInvocations, 1);
    assertEquals(summary.succeeded, 1);
    assertEquals(summary.retried, 0);
    assertEquals(summary.failed, 0);
    // Crucially: the run was NEVER re-queued (which would re-execute the handler).
    assert(
      !runPatches.some((p) => p.status === "queued"),
      "post-success bookkeeping failure must not re-queue the run",
    );
    // The run is still marked terminal succeeded so the reaper won't retry it.
    assert(
      runPatches.some((p) => p.status === "succeeded"),
      "run should be finished as succeeded",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("routine executor: retries failed queued runs with backoff", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  const runPatches: Array<{ body: Record<string, unknown>; url: string }> = [];
  let queuedCandidatesFilter: string | null = null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (table === "user_routines" && method === "GET") {
      if (url.searchParams.get("status") === "eq.active") {
        return jsonResponse([]);
      }
      if (url.searchParams.get("id") === "eq.routine-1") {
        return jsonResponse([routineRow({
          metadata: {
            retry_policy: { max_attempts: 3, base_delay_seconds: 30 },
          },
        })]);
      }
    }
    if (table === "user_routines" && method === "PATCH") {
      return jsonResponse([{
        ...routineRow(),
        ...(body as Record<string, unknown>),
      }]);
    }
    if (table === "routine_runs" && method === "GET") {
      if (isReaperQuery(url)) return jsonResponse([]); // nothing stale to reap
      if (url.searchParams.get("status") === "in.(queued,running)") {
        return jsonResponse([]);
      }
      // queuedRunCandidates carries the due filter (status=eq.queued + or on
      // next_attempt_at); getRunById loads the same run by id to claim it.
      if (url.searchParams.get("status") === "eq.queued") {
        queuedCandidatesFilter = url.searchParams.get("or");
      }
      return jsonResponse([queuedRunRow({ trigger: "manual", attempt_count: 1 })]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      runPatches.push({
        body: body as Record<string, unknown>,
        url: url.toString(),
      });
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_capabilities") return jsonResponse(capabilityRows());
    if (table === "routine_dashboard_bindings") return jsonResponse([]);
    if (table === "users") return jsonResponse([userRow()]);
    if (table === "routine_run_steps" && method === "POST") {
      return jsonResponse([{
        id: "step-1",
        ...(body as Record<string, unknown>),
      }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const summary = await runRoutineExecutorCycle({
      now: NOW,
      clock: () => NOW,
      limit: 5,
      baseUrl: "https://api.example.test",
      invokeMcp: async () =>
        jsonResponse({
          error: { code: -32000, message: "Inbox unavailable" },
        }),
    });

    assertEquals(summary.claimed_queued, 1);
    assertEquals(summary.executed, 1);
    assertEquals(summary.retried, 1);

    // Only DUE queued runs are picked up: the candidate query filters on
    // next_attempt_at (backoff not yet elapsed => not re-dispatched).
    assert(
      queuedCandidatesFilter?.includes(
        "next_attempt_at.lte.2026-05-17T12:00:00.000Z",
      ),
      "queued candidates must be filtered by next_attempt_at",
    );
    // The claim is the at-most-once guard: CAS gated on the row still queued.
    const claimPatch = runPatches.find((patch) =>
      patch.body.status === "running"
    );
    assertEquals(
      new URL(claimPatch?.url || "https://supabase.example").searchParams
        .get("status"),
      "eq.queued",
    );

    const retryPatch = runPatches.find((patch) =>
      patch.body.status === "queued"
    );
    assertEquals(
      retryPatch?.body.next_attempt_at,
      "2026-05-17T12:01:00.000Z",
    );
    assertEquals(retryPatch?.body.lease_id, null);
    assertEquals(
      (retryPatch?.body.error as Record<string, unknown>).message,
      "Inbox unavailable",
    );
    // The re-queue is CAS-guarded on the run still being "running" so a run the
    // reaper already failed (or one finishRun marked terminal) can never be
    // resurrected to "queued" and re-executed.
    assertEquals(
      new URL(retryPatch?.url || "https://supabase.example").searchParams
        .get("status"),
      "eq.running",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("routine executor: manual runs cannot bypass an exhausted daily budget", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  const routinePatches: Array<{ body: Record<string, unknown>; url: string }> =
    [];
  const runPatches: Array<Record<string, unknown>> = [];
  let handlerInvocations = 0;

  const budgeted = () =>
    routineRow({
      budget_policy: { max_light_per_day: 250 },
      metadata: {
        budget_spend: {
          day: "2026-05-17",
          day_light: 250,
          month: "2026-05",
          month_light: 250,
          updated_at: "2026-05-17T11:55:00.000Z",
        },
      },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (table === "user_routines" && method === "GET") {
      return jsonResponse([budgeted()]);
    }
    if (table === "user_routines" && method === "PATCH") {
      routinePatches.push({
        body: body as Record<string, unknown>,
        url: url.toString(),
      });
      return jsonResponse([{
        ...budgeted(),
        ...(body as Record<string, unknown>),
      }]);
    }
    if (table === "routine_runs" && method === "GET") {
      if (isReaperQuery(url)) return jsonResponse([]); // nothing stale to reap
      if (url.searchParams.get("id")?.startsWith("eq.")) {
        return jsonResponse([queuedRunRow({ trigger: "manual" })]); // explicit owner run
      }
      return jsonResponse([]);
    }
    if (table === "routine_runs" && method === "POST") {
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      runPatches.push(body as Record<string, unknown>);
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_capabilities") return jsonResponse(capabilityRows());
    if (table === "routine_dashboard_bindings") return jsonResponse([]);
    if (table === "users") return jsonResponse([userRow()]);
    if (table === "routine_run_steps" && method === "POST") {
      return jsonResponse([{ id: "step-1" }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const summary = await runRoutineExecutorCycle({
      now: NOW,
      clock: () => NOW,
      limit: 5,
      baseUrl: "https://api.example.test",
      invokeMcp: async () => {
        handlerInvocations += 1;
        return jsonResponse({
          result: { content: [{ type: "text", text: "{}" }] },
        });
      },
    });

    assertEquals(summary.skipped, 1);
    assertEquals(summary.budget_skipped, 1);
    assertEquals(summary.succeeded, 0);
    // The handler must never run on an exhausted budget.
    assertEquals(handlerInvocations, 0);

    const skipPatch = runPatches.find((body) => body.status === "skipped");
    assert(String(skipPatch?.summary).includes("budget exhausted"));
    assertEquals(
      (skipPatch?.error as Record<string, unknown>)?.code,
      "budget_day_exhausted",
    );

    // next_run_at is deferred to the UTC-midnight budget reset instead of the
    // routine's own cadence, so an exhausted budget records ONE skipped run.
    const deferPatch = routinePatches.find((patch) =>
      patch.body.next_run_at === "2026-05-18T00:00:00.000Z"
    );
    assert(deferPatch, "expected next_run_at deferred to next UTC midnight");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("routine executor: auto-pauses the routine after consecutive failed attempts", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  const routinePatches: Array<Record<string, unknown>> = [];
  const notifications: Array<Record<string, unknown>> = [];

  // failure_count 9 + this terminal failed attempt = 10 = default threshold.
  const failing = () => routineRow({ failure_count: 9, budget_policy: {} });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (table === "user_notifications" && method === "POST") {
      notifications.push(body as Record<string, unknown>);
      return jsonResponse([{ id: "notif-1", ...(body as Record<string, unknown>) }]);
    }
    if (table === "user_routines" && method === "GET") {
      if (url.searchParams.get("status") === "eq.active") {
        return jsonResponse([]);
      }
      return jsonResponse([failing()]);
    }
    if (table === "user_routines" && method === "PATCH") {
      routinePatches.push(body as Record<string, unknown>);
      return jsonResponse([{
        ...failing(),
        ...(body as Record<string, unknown>),
      }]);
    }
    if (table === "routine_runs" && method === "GET") {
      if (isReaperQuery(url)) return jsonResponse([]); // nothing stale to reap
      if (url.searchParams.get("status") === "in.(queued,running)") {
        return jsonResponse([]);
      }
      // Final attempt (2) already spent: the claim increments to 3 = max, so the
      // failing handler terminates the run and trips the breaker. getRunById and
      // queuedRunCandidates return the same pending run.
      return jsonResponse([queuedRunRow({ trigger: "manual", attempt_count: 2 })]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_capabilities") return jsonResponse(capabilityRows());
    if (table === "routine_dashboard_bindings") return jsonResponse([]);
    if (table === "users") return jsonResponse([userRow()]);
    if (table === "routine_run_steps" && method === "POST") {
      return jsonResponse([{ id: "step-1" }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const summary = await runRoutineExecutorCycle({
      now: NOW,
      clock: () => NOW,
      limit: 5,
      baseUrl: "https://api.example.test",
      invokeMcp: async () =>
        jsonResponse({
          error: { code: -32000, message: "Inbox unavailable" },
        }),
    });

    assertEquals(summary.failed, 1);
    assertEquals(summary.auto_paused, 1);

    const pausePatch = routinePatches.find((body) => body.status === "paused");
    assert(pausePatch, "expected the routine to be auto-paused");
    assertEquals(pausePatch?.failure_count, 10);
    const autoPause = (pausePatch?.metadata as Record<string, unknown>)
      ?.auto_pause as Record<string, unknown>;
    assertEquals(autoPause?.reason, "consecutive_failures");
    assertEquals(autoPause?.threshold, 10);

    // The owner is notified their agent stopped (idempotent per pause event).
    const pauseNotif = notifications.find((n) => n.kind === "routine_paused");
    assert(pauseNotif, "expected an owner notification on auto-pause");
    assertEquals(pauseNotif?.severity, "critical");
    assertEquals(pauseNotif?.entity_type, "routine");
    assert(
      String(pauseNotif?.dedupe_key).startsWith("routine_paused:routine-1:"),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("routine executor: auto-pauses when a run exceeds max_light_per_run and rolls up spend", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  const routinePatches: Array<Record<string, unknown>> = [];

  const capped = () =>
    routineRow({
      budget_policy: { max_light_per_run: 10, max_light_per_day: 250 },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (table === "user_routines" && method === "GET") {
      return jsonResponse([capped()]);
    }
    if (table === "user_routines" && method === "PATCH") {
      routinePatches.push(body as Record<string, unknown>);
      return jsonResponse([{
        ...capped(),
        ...(body as Record<string, unknown>),
      }]);
    }
    if (table === "routine_runs" && method === "GET") {
      // id-GET serves both the claim (getRunById -> a claimable queued run) and
      // the post-run spend read (the run accrued 25 Light via contributions).
      if (url.searchParams.get("id")) {
        return jsonResponse([queuedRunRow({ total_light: 25 })]);
      }
      return jsonResponse([]);
    }
    if (table === "routine_runs" && method === "POST") {
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_capabilities") return jsonResponse(capabilityRows());
    if (table === "routine_dashboard_bindings") return jsonResponse([]);
    if (table === "users") return jsonResponse([userRow()]);
    if (table === "routine_run_steps" && method === "POST") {
      return jsonResponse([{ id: "step-1" }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const summary = await runRoutineExecutorCycle({
      now: NOW,
      clock: () => NOW,
      limit: 5,
      baseUrl: "https://api.example.test",
      invokeMcp: async () =>
        jsonResponse({
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          },
        }),
    });

    assertEquals(summary.succeeded, 1);
    assertEquals(summary.auto_paused, 1);

    const pausePatch = routinePatches.find((body) => body.status === "paused");
    assert(pausePatch, "expected the routine to be auto-paused");
    const metadata = pausePatch?.metadata as Record<string, unknown>;
    const autoPause = metadata?.auto_pause as Record<string, unknown>;
    assertEquals(autoPause?.reason, "budget_run_exceeded");
    assertEquals(autoPause?.light, 25);
    assertEquals(autoPause?.cap, 10);
    // Terminal spend folds into the day/month rollup for the pre-run gates.
    const rollup = metadata?.budget_spend as Record<string, unknown>;
    assertEquals(rollup?.day, "2026-05-17");
    assertEquals(rollup?.day_light, 25);
    assertEquals(rollup?.month_light, 25);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("routine executor: a hung handler invocation times out into a retry (never stuck 'running')", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  const runPatches: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (table === "user_routines" && method === "GET") {
      return jsonResponse([routineRow({ budget_policy: {} })]);
    }
    if (table === "user_routines" && method === "PATCH") {
      return jsonResponse([{ ...routineRow(), ...(body as Record<string, unknown>) }]);
    }
    if (table === "routine_runs" && method === "GET") {
      if (isReaperQuery(url)) return jsonResponse([]); // nothing stale to reap
      if (url.searchParams.get("id")?.startsWith("eq.")) {
        return jsonResponse([queuedRunRow()]); // getRunById -> claimable
      }
      return jsonResponse([]);
    }
    if (table === "routine_runs" && method === "POST") {
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      runPatches.push(body as Record<string, unknown>);
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "routine_capabilities") return jsonResponse(capabilityRows());
    if (table === "routine_dashboard_bindings") return jsonResponse([]);
    if (table === "users") return jsonResponse([userRow()]);
    if (table === "routine_run_steps" && method === "POST") {
      return jsonResponse([{ id: "step-1" }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const summary = await runRoutineExecutorCycle({
      now: NOW,
      clock: () => NOW,
      limit: 5,
      baseUrl: "https://api.example.test",
      handlerTimeoutMs: 40,
      // A wedged handler: never resolves. The backstop must abort it so the run
      // is retried/failed rather than left "running" forever (the prod bug).
      invokeMcp: () => new Promise<Response>(() => {}),
    });

    assertEquals(summary.executed, 1);
    assertEquals(summary.retried, 1);
    const retryPatch = runPatches.find((b) => b.status === "queued");
    assert(retryPatch, "hung run must be re-queued for retry, not left running");
    assertEquals(
      (retryPatch?.error as Record<string, unknown>).message,
      "Routine handler invocation timed out",
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("routine executor: dispatches claimed runs to the queue instead of running inline", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  const sent: Array<{ routineRunId: string }> = [];
  let handlerInvoked = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (table === "user_routines" && method === "GET") return jsonResponse([routineRow()]);
    if (table === "user_routines" && method === "PATCH") return jsonResponse([{ ...routineRow(), ...(body as Record<string, unknown>) }]);
    if (table === "routine_runs" && method === "GET") {
      if (isReaperQuery(url)) return jsonResponse([]); // nothing stale to reap
      if (url.searchParams.get("id")?.startsWith("eq.")) {
        return jsonResponse([queuedRunRow()]); // getRunById -> claimable
      }
      return jsonResponse([]);
    }
    if (table === "routine_runs" && method === "POST") return jsonResponse([runRow(body as Record<string, unknown>)]);
    if (table === "routine_runs" && method === "PATCH") return jsonResponse([runRow(body as Record<string, unknown>)]);
    if (table === "routine_capabilities") return jsonResponse(capabilityRows());
    if (table === "routine_dashboard_bindings") return jsonResponse([]);
    if (table === "users") return jsonResponse([userRow()]);
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const summary = await runRoutineExecutorCycle({
      now: NOW,
      clock: () => NOW,
      limit: 5,
      baseUrl: "https://api.example.test",
      execQueue: { send: async (b) => { sent.push(b as { routineRunId: string }); } },
      // If this ever runs inline, the flag flips — it must NOT in the cron cycle.
      invokeMcp: async () => { handlerInvoked = true; return jsonResponse({ result: { content: [{ type: "text", text: "{}" }] } }); },
    });

    assertEquals(summary.claimed_scheduled, 1);
    assertEquals(summary.dispatched, 1);
    assertEquals(summary.executed, 0);
    assertEquals(handlerInvoked, false);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].routineRunId, "run-1");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("processQueuedRoutineRun: claims the queued run and executes the handler in the consumer", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  let handlerInvoked = false;
  let claimStatusFilter: string | null = null;
  let invokedTraceId: string | null = null;
  const runPatches: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    // getRunById loads the enqueued run; it is still "queued" until claimed here.
    if (table === "routine_runs" && method === "GET") {
      return jsonResponse([queuedRunRow({ trace_id: null })]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      if ((body as Record<string, unknown>)?.status === "running") {
        // The claim's at-most-once guard: CAS gated on the row still being queued.
        claimStatusFilter = url.searchParams.get("status");
      }
      runPatches.push(body as Record<string, unknown>);
      return jsonResponse([runRow(body as Record<string, unknown>)]);
    }
    if (table === "user_routines") return jsonResponse([routineRow()]);
    if (table === "routine_capabilities") return jsonResponse(capabilityRows());
    if (table === "routine_dashboard_bindings") return jsonResponse([]);
    if (table === "users") return jsonResponse([userRow()]);
    if (table === "routine_run_steps" && method === "POST") return jsonResponse([{ id: "step-1" }]);
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    await processQueuedRoutineRun(
      { routineRunId: "run-1" },
      {
        now: NOW,
        clock: () => NOW,
        baseUrl: "https://api.example.test",
        invokeMcp: async (request) => {
          handlerInvoked = true;
          const body = await request.json() as {
            params: { arguments: { _routine: { trace_id: string } } };
          };
          invokedTraceId = body.params.arguments._routine.trace_id;
          return jsonResponse({
            result: {
              content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
            },
          });
        },
      },
    );

    assertEquals(handlerInvoked, true);
    assertEquals(claimStatusFilter, "eq.queued"); // at-most-once: claim only a queued row
    const claim = runPatches.find((patch) => patch.status === "running");
    assert(
      typeof claim?.trace_id === "string" && claim.trace_id.length > 0,
      "claim backfills a legacy null trace before execution",
    );
    assertEquals(invokedTraceId, claim?.trace_id);
    assert(runPatches.some((p) => p.status === "succeeded"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("processQueuedRoutineRun: never executes a queued run after the routine enters error", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  let handlerInvoked = false;
  const runPatches: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : {};
    if (table === "routine_runs" && method === "GET") {
      return jsonResponse([queuedRunRow()]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      runPatches.push(body);
      return jsonResponse([runRow(body)]);
    }
    if (table === "user_routines" && method === "GET") {
      return jsonResponse([routineRow({ status: "error" })]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    await processQueuedRoutineRun(
      { routineRunId: "run-1" },
      {
        now: NOW,
        clock: () => NOW,
        invokeMcp: async () => {
          handlerInvoked = true;
          return jsonResponse({ result: { content: [] } });
        },
      },
    );

    assertEquals(handlerInvoked, false);
    assert(
      runPatches.some((patch) =>
        patch.status === "skipped" && patch.summary === "Routine is error"
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("processQueuedRoutineRun: duplicate delivery (claim matches nothing) is a no-op", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  let handlerInvoked = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    // CAS claim returns no rows -> already claimed / terminal.
    if (table === "routine_runs" && method === "PATCH") return jsonResponse([]);
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const outcome = await processQueuedRoutineRun(
      { routineRunId: "run-1" },
      { now: NOW, invokeMcp: async () => { handlerInvoked = true; return jsonResponse({ result: { content: [] } }); } },
    );
    assertEquals(outcome, "ack");
    assertEquals(handlerInvoked, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("routine executor: reaps a run orphaned in 'running' past its lease", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  const runPatches: Array<{ body: Record<string, unknown>; url: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    // No due routines and no queued candidates: isolate the reap path.
    if (table === "user_routines" && method === "GET") return jsonResponse([]);
    if (table === "routine_runs" && method === "GET") {
      // The reaper runs two disjoint probes; the orphan is a lease-less run
      // stuck past the staleness window (the second probe). The lease-expired
      // probe finds nothing here.
      if (
        isReaperQuery(url) &&
        url.searchParams.get("lease_expires_at") === "is.null"
      ) {
        return jsonResponse([{ id: "orphan-1" }]);
      }
      return jsonResponse([]);
    }
    if (table === "routine_runs" && method === "PATCH") {
      runPatches.push({ body: body as Record<string, unknown>, url: url.toString() });
      return jsonResponse([{ id: "orphan-1" }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const summary = await runRoutineExecutorCycle({
      now: NOW,
      clock: () => NOW,
      limit: 5,
      baseUrl: "https://api.example.test",
      invokeMcp: async () =>
        jsonResponse({ result: { content: [{ type: "text", text: "{}" }] } }),
    });

    assertEquals(summary.reaped, 1);
    const failPatch = runPatches.find((p) => p.body.status === "failed");
    assert(failPatch, "orphaned run must be failed terminally");
    assertEquals(
      (failPatch?.body.error as Record<string, unknown>).type,
      "ServerTimeout",
    );
    assertEquals(failPatch?.body.lease_id, null);
    // The write re-applies the same staleness filter (status + lease) plus the
    // probed ids, so a run legitimately reclaimed between probe and PATCH is
    // not clobbered.
    const failUrl = new URL(failPatch?.url || "https://supabase.example");
    assertEquals(failUrl.searchParams.get("status"), "eq.running");
    assertEquals(failUrl.searchParams.get("lease_expires_at"), "is.null");
    assert(failUrl.searchParams.get("id")?.includes("orphan-1"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
