import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  approveRoutineCapabilities,
  createRoutine,
  createRoutineRun,
  isLaunchManagedRoutine,
  launchRoutineRole,
  listRoutines,
  normalizeRoutineCreateInput,
  pauseRoutine,
  recordRoutineRunStep,
  resumeRoutine,
  routineCapabilitiesFromManifest,
  updateRoutine,
  updateRoutineRun,
  validateRoutineActivation,
} from "./routines.ts";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function routineRow(body: Record<string, unknown>) {
  return {
    id: "routine-1",
    user_id: body.user_id,
    composer_app_id: body.composer_app_id ?? null,
    composer_app_slug: body.composer_app_slug ?? null,
    template_id: body.template_id,
    template_version: body.template_version ?? null,
    name: body.name,
    description: body.description ?? null,
    intent: body.intent ?? null,
    handler_function: body.handler_function,
    status: body.status ?? "paused",
    schedule: body.schedule,
    config: body.config,
    budget_policy: body.budget_policy,
    approval_policy: body.approval_policy,
    max_concurrency: body.max_concurrency ?? 1,
    next_run_at: body.next_run_at ?? null,
    last_run_at: null,
    last_success_at: null,
    last_error_at: null,
    failure_count: 0,
    created_by_trace_id: body.created_by_trace_id ?? null,
    metadata: body.metadata ?? {},
    created_at: "2026-05-17T12:00:00Z",
    updated_at: body.updated_at ?? "2026-05-17T12:00:00Z",
    deleted_at: null,
  };
}

Deno.test("routines: normalizes schedules, capability fan-out, and manifest capabilities", () => {
  const normalized = normalizeRoutineCreateInput({
    template_id: "sales_followup_loop",
    name: "Sales follow-up",
    handler_function: "poll_email_followups",
    schedule: { every_minutes: 5 },
    config: { max_emails: 20 },
    budget_policy: { max_light_per_day: 500 },
    capabilities: [{
      app_ref: "email-drafter",
      functions: ["draft_reply", "summarize_thread"],
      access: "write",
      purpose: "Prepare reviewable replies",
    }],
  });

  assertEquals(normalized.routine.schedule, {
    type: "interval",
    every_seconds: 300,
  });
  assertEquals(normalized.capabilities.length, 2);
  assertEquals(normalized.capabilities[0].access, "write");

  assertEquals(
    routineCapabilitiesFromManifest([{
      app: "crm",
      functions: ["log_followup"],
      access: "write",
    }]),
    [{
      app_ref: "crm",
      function_name: "log_followup",
      access: "write",
      required: true,
      purpose: null,
    }],
  );

  assertThrows(
    () =>
      normalizeRoutineCreateInput({
        template_id: "bad",
        handler_function: "handler",
        schedule: { every_minutes: 0 },
      }),
    Error,
    "every_minutes",
  );

  assertThrows(
    () =>
      normalizeRoutineCreateInput({
        template_id: "bad",
        handler_function: "handler",
        capabilities: [{
          app_ref: "mail",
          functions: ["send"],
          access: "admin",
        }],
      }),
    Error,
    "access",
  );
});

Deno.test("routines: activation fails closed on required pending capabilities and materializes safe budgets", () => {
  const validation = validateRoutineActivation({
    schedule: { type: "interval", every_minutes: 5 },
    budget_policy: {},
    capabilities: [{
      id: "cap-1",
      required: true,
      approved: false,
    }] as never,
  });
  assertEquals(validation.budgetPolicy, {
    max_light_per_run: 10,
    max_light_per_day: 100,
    max_light_per_month: 1000,
    max_calls_per_run: 25,
  });
  assertEquals(validation.blockers[0].code, "pending_required_capabilities");

  const unsafe = validateRoutineActivation({
    schedule: { type: "interval", every_seconds: 30 },
    budget_policy: {
      max_light_per_run: 100,
      max_light_per_day: 10,
      max_light_per_month: 5,
      max_calls_per_run: 0,
    },
    capabilities: [],
  });
  assertEquals(
    unsafe.blockers.map((blocker) => blocker.code),
    ["unsafe_cadence", "invalid_budget"],
  );
});

Deno.test("routines: explicit and legacy launch metadata resolve to protected lifecycle roles", () => {
  assertEquals(launchRoutineRole({ launch_primary: true }), "primary");
  assertEquals(
    launchRoutineRole({ launch_managed: true, launch_role: "primary" }),
    "primary",
  );
  assertEquals(
    launchRoutineRole({ launch_managed: true, launch_role: "routine" }),
    "routine",
  );
  assertEquals(
    launchRoutineRole({ launch_managed: true, launch_role: "invalid" }),
    "routine",
  );
  assertEquals(launchRoutineRole({ launch_primary: false }), null);
  assertEquals(
    isLaunchManagedRoutine({ metadata: { launch_managed: true } }),
    true,
  );
});

Deno.test("routines: account session can approve exact capability ids", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let approved = false;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method || "GET";
    if (url.includes("/user_routines?") && method === "GET") {
      return jsonResponse([routineRow({
        user_id: "user-1",
        template_id: "primary",
        name: "Primary",
        handler_function: "run",
        schedule: { type: "interval", every_minutes: 5 },
        budget_policy: {},
        approval_policy: {},
      })]);
    }
    if (url.includes("/routine_capabilities?") && method === "GET") {
      return jsonResponse([{
        id: "cap-1",
        routine_id: "routine-1",
        user_id: "user-1",
        app_id: null,
        app_ref: "crm",
        function_name: "write",
        access: "write",
        required: true,
        purpose: null,
        approved,
        approved_at: approved ? "2026-07-14T12:00:00Z" : null,
        approved_by_user_id: approved ? "user-1" : null,
        pricing_snapshot: {},
        constraints: {},
        metadata: {},
        created_at: "2026-07-14T12:00:00Z",
        updated_at: "2026-07-14T12:00:00Z",
      }]);
    }
    if (url.includes("/routine_capabilities?") && method === "PATCH") {
      assertEquals(url.includes("id=in.(cap-1)"), true);
      approved = true;
      return jsonResponse([]);
    }
    if (url.includes("/routine_dashboard_bindings?")) return jsonResponse([]);
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const routine = await approveRoutineCapabilities(
      "user-1",
      "routine-1",
      ["cap-1"],
    );
    assertEquals(routine.capabilities[0].approved, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routines: user metadata updates cannot erase server accounting or provenance", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const authoritativeMetadata = {
    budget_spend: { day: "2026-07-14", day_light: 41 },
    auto_pause: { reason: "budget_run_exceeded" },
    source: "ul.routine",
    launch_primary: true,
    approval_source: "account_session",
    user_note: "keep me",
  };
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method || "GET";
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : {};
    if (url.includes("/user_routines?") && method === "PATCH") {
      assertEquals("metadata" in body, false);
      return jsonResponse([routineRow({
        user_id: "user-1",
        template_id: "primary",
        name: "Primary",
        handler_function: "run",
        schedule: { type: "interval", every_minutes: 5 },
        budget_policy: {},
        approval_policy: {},
        metadata: authoritativeMetadata,
      })]);
    }
    if (url.includes("/rpc/merge_routine_user_metadata")) {
      assertEquals(body.p_metadata, {
        user_note: "updated",
        tenant_flag: true,
      });
      return jsonResponse([routineRow({
        user_id: "user-1",
        template_id: "primary",
        name: "Primary",
        handler_function: "run",
        schedule: { type: "interval", every_minutes: 5 },
        budget_policy: {},
        approval_policy: {},
        metadata: {
          ...authoritativeMetadata,
          user_note: "updated",
          tenant_flag: true,
        },
      })]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const routine = await updateRoutine("user-1", "routine-1", {
      metadata: {
        budget_spend: { day_light: 0 },
        auto_pause: null,
        source: "spoofed",
        launch_managed: false,
        launch_role: "routine",
        launch_primary: false,
        approval_source: "self_approved",
        user_note: "updated",
        tenant_flag: true,
      },
    });
    assertEquals(routine.metadata, {
      ...authoritativeMetadata,
      user_note: "updated",
      tenant_flag: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routines: pausing one managed sibling preserves the Agent activation slot", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let releaseCalls = 0;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SUBSCRIPTION_CAPACITY_ENABLED: "1",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method || "GET";
    if (url.includes("/user_routines?") && method === "PATCH") {
      return jsonResponse([routineRow({
        user_id: "user-1",
        composer_app_id: "app-1",
        template_id: "primary",
        name: "Primary",
        handler_function: "run",
        schedule: { type: "interval", every_minutes: 5 },
        budget_policy: {},
        approval_policy: {},
        status: "paused",
        metadata: {
          launch_managed: true,
          launch_role: "primary",
          launch_primary: true,
        },
      })]);
    }
    if (
      url.includes("/user_routines?") && method === "GET" &&
      url.includes("status=eq.active")
    ) {
      return jsonResponse([{
        metadata: { launch_managed: true, launch_role: "routine" },
      }]);
    }
    if (url.includes("/rpc/release_agent_activation_slot")) {
      releaseCalls += 1;
      return jsonResponse(true);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await pauseRoutine("user-1", "routine-1");
    assertEquals(releaseCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routines: stopping the final managed sibling releases the Agent activation slot", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let releaseCalls = 0;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SUBSCRIPTION_CAPACITY_ENABLED: "1",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method || "GET";
    if (url.includes("/user_routines?") && method === "PATCH") {
      return jsonResponse([routineRow({
        user_id: "user-1",
        composer_app_id: "app-1",
        template_id: "worker",
        name: "Worker",
        handler_function: "run",
        schedule: { type: "interval", every_minutes: 5 },
        budget_policy: {},
        approval_policy: {},
        status: "paused",
        metadata: { launch_managed: true, launch_role: "routine" },
      })]);
    }
    if (
      url.includes("/user_routines?") && method === "GET" &&
      url.includes("status=eq.active")
    ) {
      return jsonResponse([]);
    }
    if (url.includes("/rpc/release_agent_activation_slot")) {
      releaseCalls += 1;
      return jsonResponse(true);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await pauseRoutine("user-1", "routine-1");
    assertEquals(releaseCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routines: managed resume claims the Free slot and activates atomically", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let atomicCalls = 0;
  const incidentResolutions: Array<Record<string, unknown>> = [];
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SUBSCRIPTION_CAPACITY_ENABLED: "1",
  };
  const paused = routineRow({
    user_id: "user-1",
    composer_app_id: "app-1",
    template_id: "worker",
    name: "Worker",
    handler_function: "run",
    schedule: { type: "interval", every_minutes: 5 },
    budget_policy: {},
    approval_policy: {},
    status: "paused",
    metadata: {
      launch_managed: true,
      launch_role: "routine",
      capacity_blocked: { cap_basis_points: 2500 },
      auto_pause: {
        reason: "activation_validation_failed",
        at: "2026-07-23T12:00:00.000Z",
      },
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method || "GET";
    if (url.includes("/user_routines?") && method === "GET") {
      return jsonResponse([paused]);
    }
    if (url.includes("/routine_capabilities?")) return jsonResponse([]);
    if (url.includes("/routine_dashboard_bindings?")) return jsonResponse([]);
    if (url.includes("/rpc/activate_managed_routine_with_slot")) {
      atomicCalls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assertEquals(body.p_user_id, "user-1");
      assertEquals(body.p_routine_id, "routine-1");
      assertEquals(body.p_budget_policy, {
        max_light_per_run: 10,
        max_light_per_day: 100,
        max_light_per_month: 1000,
        max_calls_per_run: 25,
      });
      return jsonResponse([{
        allowed: true,
        code: "ok",
        active_agent_limit: 1,
        occupied_by: "app-1",
        routine_record: { ...paused, status: "active" },
      }]);
    }
    if (url.includes("/rpc/resolve_notification_incident_by_dedupe")) {
      incidentResolutions.push(JSON.parse(String(init?.body)));
      return jsonResponse(1);
    }
    if (
      url.includes("/rpc/claim_agent_activation_slot") || method === "PATCH"
    ) {
      throw new Error("managed resume must not split claim and activation");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const active = await resumeRoutine("user-1", "routine-1");
    assertEquals(active.status, "active");
    assertEquals(atomicCalls, 1);
    assertEquals(
      incidentResolutions.map((body) => body.p_dedupe_key),
      [
        "routine_activation_blocked:routine-1",
        "routine_capacity_too_low:routine-1:2500",
        "routine_paused:routine-1:2026-07-23T12:00:00.000Z",
      ],
    );
    assertEquals(
      incidentResolutions.every((body) =>
        body.p_user_id === "user-1" && !("read_at" in body)
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routines: creates routine instances with capabilities and dashboard bindings", async () => {
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
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.includes("/user_routines") && method === "POST") {
      return jsonResponse([routineRow(body as Record<string, unknown>)]);
    }
    if (url.includes("/routine_capabilities") && method === "POST") {
      return jsonResponse(
        (body as Array<Record<string, unknown>>).map((row, index) => ({
          id: `cap-${index}`,
          created_at: "2026-05-17T12:00:00Z",
          updated_at: "2026-05-17T12:00:00Z",
          approved_by_user_id: row.approved ? row.user_id : null,
          ...row,
        })),
      );
    }
    if (url.includes("/routine_dashboard_bindings") && method === "POST") {
      return jsonResponse(
        (body as Array<Record<string, unknown>>).map((row, index) => ({
          id: `binding-${index}`,
          created_at: "2026-05-17T12:00:00Z",
          ...row,
        })),
      );
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const routine = await createRoutine("user-1", {
      composer_app_id: "app-compose",
      composer_app_slug: "routine-composer",
      template_id: "sales_followup_loop",
      template_version: "1.2.3",
      name: "Sales follow-up",
      handler_function: "poll_email_followups",
      schedule: "*/5 * * * *",
      capabilities: [{
        app_ref: "email-drafter",
        function_name: "draft_reply",
        access: "write",
      }],
      dashboard_bindings: [{
        dashboard_key: "command_home",
        widget_id: "email_ops",
        card_id: "pending_drafts",
      }],
    });

    assertEquals(routine.id, "routine-1");
    assertEquals(routine.status, "paused");
    assertEquals(routine.schedule, {
      type: "cron",
      cron: "*/5 * * * *",
      timezone: "UTC",
    });
    assertEquals(routine.capabilities[0].app_ref, "email-drafter");
    assertEquals(routine.dashboard_bindings[0].widget_id, "email_ops");
    assertEquals(calls.length, 3);
    assertEquals(
      calls[0].body && (calls[0].body as Record<string, unknown>).user_id,
      "user-1",
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routines: lists user-owned routine summaries", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async () =>
    jsonResponse([
      routineRow({
        user_id: "user-1",
        template_id: "daily_digest",
        name: "Daily digest",
        handler_function: "run_digest",
        schedule: { type: "cron", cron: "0 9 * * *" },
        config: {},
        budget_policy: {},
        approval_policy: {},
      }),
    ])) as typeof fetch;

  try {
    const result = await listRoutines("user-1", { status: "paused" });
    assertEquals(result.routines.length, 1);
    assertEquals(result.routines[0].template_id, "daily_digest");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routines: records runs, steps, and terminal run status", async () => {
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
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.includes("/routine_runs") && method === "POST") {
      return jsonResponse([{
        id: "run-1",
        created_at: "2026-05-17T12:00:00Z",
        completed_at: null,
        duration_ms: null,
        total_light: 0,
        summary: null,
        error: null,
        ...body,
      }]);
    }
    if (url.includes("/routine_run_steps") && method === "POST") {
      return jsonResponse([{
        id: "step-1",
        created_at: "2026-05-17T12:00:01Z",
        started_at: "2026-05-17T12:00:01Z",
        ...body,
      }]);
    }
    if (url.includes("/routine_runs") && method === "PATCH") {
      return jsonResponse([{
        id: "run-1",
        routine_id: "routine-1",
        user_id: "user-1",
        trigger: "manual",
        trace_id: null,
        started_at: "2026-05-17T12:00:00Z",
        duration_ms: 1200,
        run_config: {},
        created_at: "2026-05-17T12:00:00Z",
        ...body,
      }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const run = await createRoutineRun({
      routineId: "routine-1",
      userId: "user-1",
      trigger: "manual",
      status: "running",
    });
    const step = await recordRoutineRunStep({
      runId: run.id,
      routineId: "routine-1",
      userId: "user-1",
      stepIndex: 0,
      appRef: "email-drafter",
      functionName: "draft_reply",
      status: "succeeded",
      costLight: 2.5,
    });
    const completed = await updateRoutineRun(run.id, "user-1", {
      status: "succeeded",
      summary: "Drafted one reply.",
      totalLight: 2.5,
    });

    assertEquals(run.status, "running");
    assertEquals(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(run.trace_id || ""),
      true,
      "new runs receive a server-minted trace id",
    );
    assertEquals(step.status, "succeeded");
    assertEquals(step.cost_light, 2.5);
    assertEquals(completed.status, "succeeded");
    assertEquals(completed.total_light, 2.5);
    assertEquals(calls.map((call) => call.method), ["POST", "POST", "PATCH"]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routines: propagates Supabase write failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch =
    (async () => new Response("bad write", { status: 500 })) as typeof fetch;

  try {
    await assertRejects(
      () =>
        createRoutine("user-1", {
          template_id: "broken",
          handler_function: "run",
        }),
      Error,
      "bad write",
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
