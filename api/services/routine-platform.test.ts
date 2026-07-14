import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { executeRoutinePlatformAction } from "./routine-platform.ts";

const APP_ID = "11111111-1111-4111-8111-111111111111";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function routineComposerApp() {
  return {
    id: APP_ID,
    owner_id: "user-1",
    slug: "email-ops",
    name: "Email Ops",
    description: "Drafts and routes sales follow-up.",
    visibility: "private",
    current_version: "1.2.3",
    updated_at: "2026-05-17T12:00:00Z",
    manifest: {
      functions: {
        poll_email_followups: {
          description: "Poll inbox and prepare follow-up drafts.",
        },
      },
      widgets: [{
        id: "draft_review",
        label: "Draft review",
        ui_function: "widget_draft_review_ui",
        data_function: "widget_draft_review_data",
        cards: [{
          id: "pending_drafts",
          label: "Pending drafts",
          size: "md",
          render: "native",
        }],
      }],
      routines: [{
        id: "sales_followup_loop",
        label: "Sales follow-up loop",
        description: "Poll email and prepare CRM-aware response drafts.",
        handler: "poll_email_followups",
        default_schedule: { every_minutes: 5 },
        default_config: { inbox: "sales", max_emails: 10 },
        capabilities: [{
          app: "email-drafter",
          functions: ["draft_reply"],
          access: "write",
          purpose: "Prepare reviewable response drafts.",
        }, {
          app: "crm",
          functions: ["log_followup"],
          access: "write",
        }],
        budget_defaults: { max_light_per_day: 250 },
        approval_policy: {
          require_user_approval: true,
          require_external_side_effect_approval: true,
        },
        surfaces: {
          dashboard_key: "command_home",
          command_cards: [{
            widget_id: "draft_review",
            card_id: "pending_drafts",
          }],
        },
      }],
    },
  };
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

function storedRoutine() {
  return routineRow({
    user_id: "user-1",
    composer_app_id: APP_ID,
    composer_app_slug: "email-ops",
    template_id: "sales_followup_loop",
    name: "Sales follow-up loop",
    handler_function: "poll_email_followups",
    schedule: { type: "interval", every_minutes: 5 },
    config: { inbox: "sales" },
    budget_policy: { max_light_per_day: 250 },
    approval_policy: {},
    status: "active",
  });
}

Deno.test("routine platform: lists and plans routine templates", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/apps?") && url.includes("owner_id=eq.user-1")) {
      return jsonResponse([routineComposerApp()]);
    }
    if (url.includes("/apps?") && url.includes("visibility=eq.public")) {
      return jsonResponse([]);
    }
    if (url.includes("/user_app_library?")) return jsonResponse([]);
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const templates = await executeRoutinePlatformAction("user-1", {
      action: "templates",
      query: "email",
    }) as { templates: Array<Record<string, unknown>>; count: number };

    assertEquals(templates.count, 1);
    assertEquals(
      templates.templates[0].templateKey,
      "email-ops/sales_followup_loop",
    );

    const plan = await executeRoutinePlatformAction("user-1", {
      action: "plan",
      template_id: "sales_followup_loop",
      config: { max_emails: 20 },
    }) as {
      routine: Record<string, unknown>;
      approvals: Record<string, unknown>;
      command_surfaces: unknown[];
    };

    assertEquals(plan.routine.config, {
      inbox: "sales",
      max_emails: 20,
    });
    assertEquals(plan.approvals.pending_count, 2);
    assertEquals(plan.command_surfaces.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routine platform: creates routines paused with owner approval pending", async () => {
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

    if (url.includes("/apps?") && url.includes(`id=eq.${APP_ID}`)) {
      return jsonResponse([routineComposerApp()]);
    }
    if (url.includes("/apps?") && url.includes("slug=eq.")) {
      return jsonResponse([]);
    }
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
    const result = await executeRoutinePlatformAction("user-1", {
      action: "create",
      app_id: APP_ID,
      template_id: "sales_followup_loop",
      name: "Resort sales follow-up",
    }) as {
      routine: { id: string; capabilities: Array<{ approved: boolean }> };
      approvals: Record<string, unknown>;
    };

    assertEquals(result.routine.id, "routine-1");
    assertEquals(result.routine.capabilities.map((cap) => cap.approved), [
      false,
      false,
    ]);
    assertEquals(result.approvals.pending_count, 2);

    const routineInsert = calls.find((call) =>
      call.url.includes("/user_routines") && call.method === "POST"
    );
    assertEquals(
      (routineInsert?.body as Record<string, unknown>).metadata,
      {
        source: "ul.routine",
        launch_primary: true,
        template_label: "Sales follow-up loop",
        template_app_name: "Email Ops",
        approval_confirmed: false,
        approval_source: "account_session_required",
      },
    );

    const capabilityInsert = calls.find((call) =>
      call.url.includes("/routine_capabilities") && call.method === "POST"
    );
    assertEquals(
      (capabilityInsert?.body as Array<Record<string, unknown>>).map((row) =>
        row.app_ref
      ),
      ["email-drafter", "crm"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routine platform: concurrent primary insert maps to the one-primary contract", async () => {
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
    if (url.includes("/apps?") && url.includes(`id=eq.${APP_ID}`)) {
      return jsonResponse([routineComposerApp()]);
    }
    if (url.includes("/apps?") && url.includes("slug=eq.")) {
      return jsonResponse([]);
    }
    if (url.includes("/user_routines?") && method === "GET") {
      return jsonResponse([]);
    }
    if (url.includes("/user_routines") && method === "POST") {
      return new Response(JSON.stringify({
        code: "23505",
        message:
          'duplicate key value violates unique constraint "idx_user_routines_one_launch_primary"',
      }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    await assertRejects(
      () =>
        executeRoutinePlatformAction("user-1", {
          action: "create",
          app_id: APP_ID,
          template_id: "sales_followup_loop",
        }),
      Error,
      "already has its primary routine",
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routine platform: queues manual runs without executing them", async () => {
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
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (url.includes("/user_routines") && method === "GET") {
      return jsonResponse([storedRoutine()]);
    }
    if (url.includes("/routine_capabilities") && method === "GET") {
      return jsonResponse([]);
    }
    if (url.includes("/routine_dashboard_bindings") && method === "GET") {
      return jsonResponse([]);
    }
    if (url.includes("/routine_runs") && method === "POST") {
      return jsonResponse([{
        id: "run-1",
        created_at: "2026-05-17T12:00:00Z",
        started_at: null,
        completed_at: null,
        duration_ms: null,
        total_light: 0,
        summary: null,
        error: null,
        ...body,
      }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    const result = await executeRoutinePlatformAction("user-1", {
      action: "run_now",
      routine_id: "routine-1",
      trace_id: "trace-manual",
    }) as {
      queued: boolean;
      run: Record<string, unknown>;
      executor_status: string;
    };

    assertEquals(result.queued, true);
    assertEquals(result.run.trace_id, "trace-manual");
    assertEquals(result.run.trigger, "manual");
    assertEquals(result.executor_status, "queued");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routine platform: activate requires approved capabilities", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/apps?") && url.includes(`id=eq.${APP_ID}`)) {
      return jsonResponse([routineComposerApp()]);
    }
    if (url.includes("/apps?") && url.includes("slug=eq.")) {
      return jsonResponse([]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    await assertRejects(
      () =>
        executeRoutinePlatformAction("user-1", {
          action: "create",
          app_id: APP_ID,
          template_id: "sales_followup_loop",
          activate: true,
        }),
      Error,
      "pending capabilities",
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routine platform: connected callers cannot self-approve capabilities", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/apps?") && url.includes(`id=eq.${APP_ID}`)) {
      return jsonResponse([routineComposerApp()]);
    }
    if (url.includes("/apps?") && url.includes("slug=eq.")) {
      return jsonResponse([]);
    }
    return jsonResponse([]);
  }) as typeof fetch;

  try {
    await assertRejects(
      () =>
        executeRoutinePlatformAction("user-1", {
          action: "create",
          app_id: APP_ID,
          template_id: "sales_followup_loop",
          approve_capabilities: true,
        }),
      Error,
      "cannot approve",
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("routine platform: resume applies the centralized launch contract", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let activated = false;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method || "GET";
    if (url.includes("/apps?") && url.includes(`id=eq.${APP_ID}`)) {
      return jsonResponse([routineComposerApp()]);
    }
    if (url.includes("/apps?") && url.includes("slug=eq.")) {
      return jsonResponse([]);
    }
    if (
      url.includes("/user_routines?") &&
      url.includes("composer_app_id=")
    ) {
      return jsonResponse([{ id: "routine-1" }]);
    }
    if (url.includes("/user_routines?") && method === "GET") {
      return jsonResponse([{
        ...storedRoutine(),
        status: activated ? "active" : "paused",
      }]);
    }
    if (url.includes("/routine_capabilities?")) return jsonResponse([]);
    if (url.includes("/routine_dashboard_bindings?")) return jsonResponse([]);
    if (url.includes("/user_routines?") && method === "PATCH") {
      activated = true;
      return jsonResponse([{ ...storedRoutine(), status: "active" }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const result = await executeRoutinePlatformAction("user-1", {
      action: "resume",
      routine_id: "routine-1",
    }) as { routine: { status: string; budget_policy: Record<string, number> } };
    assertEquals(result.routine.status, "active");
    assertEquals(activated, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
