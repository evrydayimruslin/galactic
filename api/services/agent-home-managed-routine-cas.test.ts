import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  AgentHomeRevisionError,
  formatAgentHomeRevision,
  updateAgentHomeManagedRoutineCAS,
  updateAgentHomeManagedRoutineStatusCAS,
} from "./agent-home-revision.ts";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  handler: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function deps(fetchFn: typeof fetch) {
  return {
    fetchFn,
    supabaseUrl: "https://supabase.example/",
    serviceRoleKey: "service-role",
  };
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  assert(typeof init?.body === "string");
  return JSON.parse(init.body) as Record<string, unknown>;
}

Deno.test("managed routine CAS sends every optional field and normalized interval atomically", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const revision = await updateAgentHomeManagedRoutineCAS(
    {
      appId: APP_ID,
      userId: USER_ID,
      routineId: ROUTINE_ID,
      expectedRevision: formatAgentHomeRevision(APP_ID, 12),
      authSource: "supabase",
      name: "Morning triage",
      description: "Review the overnight queue.",
      mission: "Keep every urgent request moving.",
      schedule: { type: "interval", every_seconds: 300 },
      activeNextRunAt: "2026-07-17T12:05:00Z",
      budgets: {
        maxLightPerRun: 5,
        maxLightPerDay: 25,
        maxLightPerMonth: 250,
        maxCallsPerRun: 10,
      },
    },
    deps(mockFetch((url, init) => {
      assertStringIncludes(url, "/rpc/update_agent_home_managed_routine");
      requestBody = bodyOf(init);
      return jsonResponse([{ new_revision: "13" }]);
    })),
  );
  assertEquals(requestBody, {
    p_app_id: APP_ID,
    p_user_id: USER_ID,
    p_routine_id: ROUTINE_ID,
    p_expected_revision: "12",
    p_set_name: true,
    p_name: "Morning triage",
    p_set_description: true,
    p_description: "Review the overnight queue.",
    p_set_mission: true,
    p_mission: "Keep every urgent request moving.",
    p_set_schedule: true,
    p_schedule: { type: "interval", every_seconds: 300 },
    p_active_next_run_at: "2026-07-17T12:05:00.000Z",
    p_set_budget: true,
    p_budget_policy: {
      max_light_per_run: 5,
      max_light_per_day: 25,
      max_light_per_month: 250,
      max_calls_per_run: 10,
    },
  });
  assertEquals(revision, formatAgentHomeRevision(APP_ID, 13));
});

Deno.test("managed routine CAS preserves omitted-vs-clear fields and accepts canonical cron", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  await updateAgentHomeManagedRoutineCAS(
    {
      appId: APP_ID,
      userId: USER_ID,
      routineId: ROUTINE_ID,
      expectedRevision: formatAgentHomeRevision(APP_ID, 20),
      authSource: "supabase",
      description: null,
      mission: null,
      schedule: {
        type: "cron",
        cron: "0 9 * * 1-5",
        timezone: "America/New_York",
      },
      activeNextRunAt: null,
    },
    deps(mockFetch((_url, init) => {
      requestBodies.push(bodyOf(init));
      return jsonResponse([{ new_revision: "21" }]);
    })),
  );
  const requestBody = requestBodies[0];
  assertEquals(requestBody.p_set_name, false);
  assertEquals(requestBody.p_set_description, true);
  assertEquals(requestBody.p_description, null);
  assertEquals(requestBody.p_set_mission, true);
  assertEquals(requestBody.p_mission, null);
  assertEquals(requestBody.p_schedule, {
    type: "cron",
    cron: "0 9 * * 1-5",
    timezone: "America/New_York",
  });
  assertEquals(requestBody.p_active_next_run_at, null);
  assertEquals(requestBody.p_set_budget, false);
});

Deno.test("managed routine CAS rejects non-normalized schedules and no-op writes before fetch", async () => {
  let calls = 0;
  const options = deps(mockFetch(() => {
    calls++;
    return jsonResponse([{ new_revision: "2" }]);
  }));
  const base = {
    appId: APP_ID,
    userId: USER_ID,
    routineId: ROUTINE_ID,
    expectedRevision: formatAgentHomeRevision(APP_ID, 1),
    authSource: "supabase" as const,
  };
  for (
    const mutation of [
      {},
      {
        schedule: {
          type: "interval",
          every_minutes: 5,
        } as never,
      },
      { activeNextRunAt: "2026-07-17T12:05:00Z" },
    ]
  ) {
    const error = await assertRejects(
      () => updateAgentHomeManagedRoutineCAS({ ...base, ...mutation }, options),
      AgentHomeRevisionError,
    ) as AgentHomeRevisionError;
    assertEquals(error.code, "AGENT_HOME_INVALID_MUTATION");
  }
  assertEquals(calls, 0);
});

Deno.test("managed routine CAS requires an account session before RPC", async () => {
  let called = false;
  const error = await assertRejects(
    () =>
      updateAgentHomeManagedRoutineCAS(
        {
          appId: APP_ID,
          userId: USER_ID,
          routineId: ROUTINE_ID,
          expectedRevision: formatAgentHomeRevision(APP_ID, 1),
          authSource: "api_token",
          mission: "Do work",
        },
        deps(mockFetch(() => {
          called = true;
          return jsonResponse([]);
        })),
      ),
    AgentHomeRevisionError,
  ) as AgentHomeRevisionError;
  assertEquals(error.code, "ACCOUNT_SESSION_REQUIRED");
  assertEquals(called, false);
});

Deno.test("managed routine status CAS canonicalizes activation and pause RPCs", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const options = deps(mockFetch((url, init) => {
    requests.push({ url, body: bodyOf(init) });
    return jsonResponse([{ new_revision: String(31 + requests.length) }]);
  }));
  const base = {
    appId: APP_ID,
    userId: USER_ID,
    routineId: ROUTINE_ID,
    expectedRevision: formatAgentHomeRevision(APP_ID, 31),
    authSource: "supabase" as const,
  };
  const activated = await updateAgentHomeManagedRoutineStatusCAS({
    ...base,
    status: "active",
    nextRunAt: "2026-07-17T12:05:00Z",
  }, options);
  const paused = await updateAgentHomeManagedRoutineStatusCAS({
    ...base,
    status: "paused",
  }, options);

  assert(
    requests.every((request) =>
      request.url.endsWith("/rpc/update_agent_home_managed_routine_status")
    ),
  );
  assertEquals(requests[0].body, {
    p_app_id: APP_ID,
    p_user_id: USER_ID,
    p_routine_id: ROUTINE_ID,
    p_expected_revision: "31",
    p_status: "active",
    p_next_run_at: "2026-07-17T12:05:00.000Z",
  });
  assertEquals(requests[1].body.p_status, "paused");
  assertEquals(requests[1].body.p_next_run_at, null);
  assertEquals(activated, formatAgentHomeRevision(APP_ID, 32));
  assertEquals(paused, formatAgentHomeRevision(APP_ID, 33));
});

Deno.test("managed routine status CAS rejects incoherent next-run state", async () => {
  let calls = 0;
  const options = deps(mockFetch(() => {
    calls++;
    return jsonResponse([]);
  }));
  const base = {
    appId: APP_ID,
    userId: USER_ID,
    routineId: ROUTINE_ID,
    expectedRevision: formatAgentHomeRevision(APP_ID, 1),
    authSource: "supabase" as const,
  };
  for (
    const mutation of [
      { status: "active" as const },
      {
        status: "paused" as const,
        nextRunAt: "2026-07-17T12:05:00Z",
      },
    ]
  ) {
    const error = await assertRejects(
      () =>
        updateAgentHomeManagedRoutineStatusCAS(
          { ...base, ...mutation },
          options,
        ),
      AgentHomeRevisionError,
    ) as AgentHomeRevisionError;
    assertEquals(error.code, "AGENT_HOME_INVALID_MUTATION");
  }
  assertEquals(calls, 0);
});

Deno.test("managed routine status CAS maps the Free active-Agent conflict", async () => {
  const error = await assertRejects(
    () =>
      updateAgentHomeManagedRoutineStatusCAS(
        {
          appId: APP_ID,
          userId: USER_ID,
          routineId: ROUTINE_ID,
          expectedRevision: formatAgentHomeRevision(APP_ID, 7),
          authSource: "supabase",
          status: "active",
          nextRunAt: "2026-07-17T12:05:00Z",
        },
        deps(mockFetch(() =>
          jsonResponse({
            code: "P0001",
            details: JSON.stringify({
              code: "AGENT_HOME_ACTIVE_AGENT_LIMIT",
              occupiedBy: "44444444-4444-4444-8444-444444444444",
            }),
          }, 400)
        )),
      ),
    AgentHomeRevisionError,
  ) as AgentHomeRevisionError;
  assertEquals(error.code, "AGENT_HOME_ACTIVE_AGENT_LIMIT");
  assertEquals(error.status, 409);
});

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260717150000_agent_home_managed_routine_cas.sql",
    import.meta.url,
  ),
);
const legacyMigration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260714162000_agent_home_revision.sql",
    import.meta.url,
  ),
);

Deno.test("managed routine migration preserves legacy RPC and enforces owner/managed CAS", () => {
  assertStringIncludes(
    legacyMigration,
    "CREATE OR REPLACE FUNCTION public.update_agent_home_routine(",
  );
  assertEquals(
    migration.includes(
      "CREATE OR REPLACE FUNCTION public.update_agent_home_routine(",
    ),
    false,
    "the compatibility RPC must not be replaced",
  );
  assertEquals(
    /DROP\s+FUNCTION[\s\S]*update_agent_home_routine/i.test(migration),
    false,
  );
  assertStringIncludes(
    migration,
    "PERFORM public.assert_agent_home_revision(\n    p_app_id, p_user_id, p_expected_revision",
  );
  assertStringIncludes(
    migration,
    "PERFORM public.assert_no_started_agent_home_promotion(p_app_id, p_user_id)",
  );
  assertStringIncludes(migration, "routines.id = p_routine_id");
  assertStringIncludes(migration, "routines.user_id = p_user_id");
  assertStringIncludes(migration, "routines.composer_app_id = p_app_id");
  assertStringIncludes(migration, "routines.deleted_at IS NULL");
  assertStringIncludes(
    migration,
    "routines.metadata->>'launch_primary' = 'true'",
  );
  assertStringIncludes(
    migration,
    "routines.metadata->>'launch_managed' = 'true'",
  );
  assertEquals(
    migration.includes("COALESCE(routines.metadata->>'launch_role'"),
    false,
    "unknown managed roles must remain fail-protected and mutable",
  );
  assertStringIncludes(migration, "FOR UPDATE;");
});

Deno.test("managed routine migration validates complete normalized schedule and budget JSON", () => {
  assertStringIncludes(migration, "v_schedule_type = 'interval'");
  assertStringIncludes(migration, "ARRAY['type', 'every_seconds']");
  assertStringIncludes(migration, "jsonb_object_keys(p_schedule)) <> 2");
  assertStringIncludes(
    migration,
    "(p_schedule->>'every_seconds')::numeric < 60",
  );
  assertStringIncludes(migration, "v_schedule_type = 'cron'");
  assertStringIncludes(migration, "ARRAY['type', 'cron', 'timezone']");
  assertStringIncludes(migration, "jsonb_object_keys(p_schedule)) <> 3");
  assertStringIncludes(
    migration,
    "regexp_split_to_array(p_schedule->>'cron', '[[:space:]]+')",
  );
  assertStringIncludes(
    migration,
    "v_routine.status = 'active' AND p_active_next_run_at IS NULL",
  );
  assertStringIncludes(
    migration,
    "WHEN p_set_schedule AND routines.status = 'active'\n          THEN p_active_next_run_at",
  );
  assertStringIncludes(migration, "'max_light_per_run', 'max_light_per_day'");
  assertStringIncludes(migration, "v_day < v_run OR v_month < v_day");
});

Deno.test("managed routine status migration serializes Free slot and preserves active siblings", () => {
  const statusStart = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.update_agent_home_managed_routine_status(",
  );
  const statusSql = migration.slice(statusStart);
  const entitlementLock = statusSql.indexOf(
    "FROM public.account_entitlements AS entitlements",
  );
  const revisionLock = statusSql.indexOf(
    "PERFORM public.assert_agent_home_revision(",
  );
  const routineLock = statusSql.indexOf(
    "FROM public.user_routines AS routines",
  );
  assert(
    entitlementLock >= 0 && revisionLock > entitlementLock &&
      routineLock > revisionLock,
    "status CAS must lock entitlement, then Agent revision, then routine",
  );
  assertStringIncludes(
    statusSql,
    "v_entitlement.free_agent_id IS DISTINCT FROM p_app_id",
  );
  assertStringIncludes(statusSql, "SET free_agent_id = p_app_id");
  assertStringIncludes(statusSql, "siblings.status = 'active'");
  assertStringIncludes(statusSql, "SET free_agent_id = NULL");
  assertStringIncludes(
    statusSql,
    "WHERE entitlements.user_id = p_user_id\n        AND entitlements.free_agent_id = p_app_id",
  );
});

Deno.test("managed routine RPCs are service-role only", () => {
  for (
    const signature of [
      "public.update_agent_home_managed_routine(",
      "public.update_agent_home_managed_routine_status(",
    ]
  ) {
    const revoke = migration.indexOf(`REVOKE ALL ON FUNCTION ${signature}`);
    const grant = migration.indexOf(`GRANT EXECUTE ON FUNCTION ${signature}`);
    assert(revoke >= 0 && grant > revoke);
  }
  assertEquals(
    (migration.match(/FROM PUBLIC, anon, authenticated;/g) ?? []).length,
    2,
  );
  assertEquals((migration.match(/\) TO service_role;/g) ?? []).length, 2);
});
