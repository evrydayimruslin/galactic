import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  getRoutineMonitorDetail,
  listRoutineMonitor,
  updateRoutineMonitorStatus,
} from "./routine-monitoring.ts";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function routineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "routine-1",
    user_id: overrides.user_id ?? "user-1",
    composer_app_id: overrides.composer_app_id ?? "composer-1",
    composer_app_slug: overrides.composer_app_slug ?? "email-composer",
    template_id: overrides.template_id ?? "sales_followup",
    template_version: overrides.template_version ?? "1.0.0",
    name: overrides.name ?? "Sales follow-up",
    description: overrides.description ?? null,
    intent: overrides.intent ?? null,
    handler_function: overrides.handler_function ?? "run_followup",
    status: overrides.status ?? "active",
    schedule: overrides.schedule ?? { type: "interval", every_minutes: 5 },
    config: overrides.config ?? {},
    budget_policy: overrides.budget_policy ?? {},
    approval_policy: overrides.approval_policy ?? {},
    max_concurrency: overrides.max_concurrency ?? 1,
    next_run_at: overrides.next_run_at ?? "2026-05-17T12:05:00Z",
    last_run_at: overrides.last_run_at ?? "2026-05-17T11:55:00Z",
    last_success_at: overrides.last_success_at ?? null,
    last_error_at: overrides.last_error_at ?? null,
    failure_count: overrides.failure_count ?? 0,
    created_by_trace_id: overrides.created_by_trace_id ?? null,
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? "2026-05-17T10:00:00Z",
    updated_at: overrides.updated_at ?? "2026-05-17T11:55:00Z",
    deleted_at: overrides.deleted_at ?? null,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? "run-1",
    routine_id: overrides.routine_id ?? "routine-1",
    user_id: overrides.user_id ?? "user-1",
    status: overrides.status ?? "succeeded",
    trigger: overrides.trigger ?? "scheduled",
    trace_id: overrides.trace_id ?? "00000000-0000-4000-8000-000000000701",
    started_at: overrides.started_at ?? "2026-05-17T11:50:00Z",
    completed_at: overrides.completed_at ?? "2026-05-17T11:51:00Z",
    duration_ms: overrides.duration_ms ?? 60_000,
    total_light: overrides.total_light ?? 10,
    summary: overrides.summary ?? "Completed",
    error: overrides.error ?? null,
    run_config: overrides.run_config ?? {},
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? "2026-05-17T11:50:00Z",
  };
}

Deno.test("routine monitoring: aggregates inventory, cards, approvals, and spend", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method || "GET";

    if (url.includes("/user_routines") && method === "GET") {
      return jsonResponse([
        routineRow({ id: "routine-1", status: "active" }),
        routineRow({
          id: "routine-2",
          name: "Daily digest",
          status: "paused",
          next_run_at: null,
        }),
      ]);
    }
    if (url.includes("/routine_capabilities")) {
      return jsonResponse([
        { routine_id: "routine-1", approved: true },
        { routine_id: "routine-1", approved: false },
        { routine_id: "routine-2", approved: true },
      ]);
    }
    if (url.includes("/routine_runs")) {
      return jsonResponse([
        runRow({ id: "run-1", routine_id: "routine-1", total_light: 10 }),
        runRow({
          id: "run-2",
          routine_id: "routine-2",
          status: "failed",
          total_light: 2,
          error: { message: "Mailbox unavailable" },
          created_at: "2026-05-17T11:30:00Z",
        }),
      ]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const monitor = await listRoutineMonitor("user-1", {
      now: new Date("2026-05-17T12:00:00Z"),
    });

    assertEquals(monitor.summary.total, 2);
    assertEquals(monitor.summary.active, 1);
    assertEquals(monitor.summary.pending_approvals, 1);
    assertEquals(monitor.summary.failures_24h, 1);
    assertEquals(monitor.summary.spend_light_30d, 12);
    assertEquals(monitor.routines[0].pending_capability_count, 1);
    assertEquals(monitor.routines[0].health, "needs_approval");
    assertEquals(monitor.cards.routine_inventory.body.kind, "summary");
    assertEquals(monitor.cards.routine_status.body.kind, "list");
    assert("routine_failures" in monitor.cards);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routine monitoring: pause and resume controls return refreshed detail", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });

    if (url.includes("/user_routines") && method === "PATCH") {
      return jsonResponse([routineRow({ status: body?.status ?? "paused" })]);
    }
    if (url.includes("/user_routines") && method === "GET") {
      return jsonResponse([routineRow({ status: "paused" })]);
    }
    if (url.includes("/routine_capabilities")) return jsonResponse([]);
    if (url.includes("/routine_dashboard_bindings")) return jsonResponse([]);
    if (url.includes("/routine_runs")) {
      const headers = new Headers(init?.headers);
      if (headers.get("Prefer") === "count=exact") {
        return new Response("[]", {
          headers: {
            "Content-Type": "application/json",
            "Content-Range": "*/0",
          },
        });
      }
      return jsonResponse([]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const detail = await updateRoutineMonitorStatus("user-1", "routine-1", {
      action: "pause",
    });

    assertEquals(detail.routine.status, "paused");
    assertEquals(detail.routine.active_run_count, 0);
    assert(
      calls.some((call) =>
        call.method === "PATCH" &&
        call.url.includes("/user_routines") &&
        (call.body as { status?: string } | null)?.status === "paused"
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routine monitoring: detail exposes an exact owner-scoped active run count", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let countRequest: { url: string; headers: Headers } | null = null;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/user_routines")) {
      return jsonResponse([routineRow({ status: "paused" })]);
    }
    if (
      url.includes("/routine_capabilities") ||
      url.includes("/routine_dashboard_bindings")
    ) {
      return jsonResponse([]);
    }
    if (url.includes("/routine_runs")) {
      const headers = new Headers(init?.headers);
      if (headers.get("Prefer") === "count=exact") {
        countRequest = { url, headers };
        return new Response("[]", {
          headers: {
            "Content-Type": "application/json",
            "Content-Range": "0-0/7",
          },
        });
      }
      return jsonResponse([]);
    }
    throw new Error(`Unexpected routine detail request: ${url}`);
  }) as typeof fetch;

  try {
    const detail = await getRoutineMonitorDetail("user-1", "routine-1");
    assert(detail);
    assertEquals(detail.routine.active_run_count, 7);
    assert(countRequest);
    const countUrl = new URL(countRequest.url);
    assertEquals(countUrl.searchParams.get("user_id"), "eq.user-1");
    assertEquals(countUrl.searchParams.get("routine_id"), "eq.routine-1");
    assertEquals(countUrl.searchParams.get("status"), "in.(queued,running)");
    assertEquals(countRequest.headers.get("Range"), "0-0");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routine monitoring: detail fails closed without an exact active run total", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/user_routines")) {
      return jsonResponse([routineRow({ status: "paused" })]);
    }
    if (
      url.includes("/routine_capabilities") ||
      url.includes("/routine_dashboard_bindings")
    ) {
      return jsonResponse([]);
    }
    if (url.includes("/routine_runs")) {
      const headers = new Headers(init?.headers);
      if (headers.get("Prefer") === "count=exact") {
        return new Response("[]", {
          headers: {
            "Content-Type": "application/json",
            "Content-Range": "not-a-range/1",
          },
        });
      }
      return jsonResponse([]);
    }
    throw new Error(`Unexpected routine detail request: ${url}`);
  }) as typeof fetch;

  try {
    await assertRejects(
      () => getRoutineMonitorDetail("user-1", "routine-1"),
      Error,
      "Active routine run count is unavailable",
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
