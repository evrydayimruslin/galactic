import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  computeNextRoutineRunAt,
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
    if (table === "routine_runs" && method === "GET") return jsonResponse([]);
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
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        mcpCalls.push({
          url: input.toString(),
          auth: new Headers(init?.headers).get("Authorization"),
          body,
        });
        return jsonResponse({
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          },
        });
      }) as typeof fetch,
    });

    assertEquals(summary.claimed_scheduled, 1);
    assertEquals(summary.executed, 1);
    assertEquals(summary.succeeded, 1);
    assertEquals(
      mcpCalls[0].url,
      "https://api.example.test/mcp/composer-app-1",
    );
    assert(mcpCalls[0].auth?.startsWith("Bearer gxr_v1_"));
    const claimPatch = dbCalls.find((call) =>
      call.table === "user_routines" &&
      call.method === "PATCH" &&
      (call.body as Record<string, unknown>).lease_id
    );
    assert(
      new URL(claimPatch?.url || "https://supabase.example").searchParams
        .get("and")?.includes("next_run_at.lte.2026-05-17T12:00:00.000Z"),
    );
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

Deno.test("routine executor: retries failed queued runs with backoff", async () => {
  const restoreEnv = installEnv();
  const originalFetch = globalThis.fetch;
  const runPatches: Array<{ body: Record<string, unknown>; url: string }> = [];

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
      if (url.searchParams.get("status") === "in.(queued,running)") {
        return jsonResponse([]);
      }
      return jsonResponse([runRow({
        status: "queued",
        trigger: "manual",
        started_at: null,
        attempt_count: 1,
        lease_id: null,
        lease_expires_at: null,
      })]);
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
      fetchFn: (async () =>
        jsonResponse({
          error: { code: -32000, message: "Inbox unavailable" },
        })) as typeof fetch,
    });

    assertEquals(summary.claimed_queued, 1);
    assertEquals(summary.executed, 1);
    assertEquals(summary.retried, 1);

    const claimPatch = runPatches.find((patch) =>
      patch.body.status === "running"
    );
    assert(
      new URL(claimPatch?.url || "https://supabase.example").searchParams
        .get("and")?.includes("next_attempt_at.lte.2026-05-17T12:00:00.000Z"),
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
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

Deno.test("routine executor: skips scheduled run and defers to budget reset when the daily budget is exhausted", async () => {
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
    if (table === "routine_runs" && method === "GET") return jsonResponse([]);
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
      fetchFn: (async () => {
        handlerInvocations += 1;
        return jsonResponse({
          result: { content: [{ type: "text", text: "{}" }] },
        });
      }) as typeof fetch,
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

  // failure_count 9 + this terminal failed attempt = 10 = default threshold.
  const failing = () => routineRow({ failure_count: 9, budget_policy: {} });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const table = url.pathname.split("/").pop() || "";
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

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
      if (url.searchParams.get("status") === "in.(queued,running)") {
        return jsonResponse([]);
      }
      if (url.searchParams.get("id")) return jsonResponse([runRow()]);
      return jsonResponse([runRow({
        status: "queued",
        trigger: "manual",
        started_at: null,
        attempt_count: 2,
        max_attempts: 3,
        lease_id: null,
        lease_expires_at: null,
      })]);
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
      fetchFn: (async () =>
        jsonResponse({
          error: { code: -32000, message: "Inbox unavailable" },
        })) as typeof fetch,
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
      // The post-run spend read: the run accrued 25 Light via contributions.
      if (url.searchParams.get("id")) {
        return jsonResponse([{ id: "run-1", total_light: 25 }]);
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
      fetchFn: (async () =>
        jsonResponse({
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
          },
        })) as typeof fetch,
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
