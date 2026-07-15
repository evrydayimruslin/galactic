import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  AgentHomeRevisionError,
  approveAgentHomeCapabilitiesCAS,
  assertAgentHomeRevision,
  claimAgentHomeAction,
  commitAgentHomePromotionAppRecord,
  completeAgentHomeAction,
  fenceAgentHomePromotionStep,
  formatAgentHomeRevision,
  getAgentHomeBudgetUsage,
  getAgentHomeRevision,
  parseAgentHomeRevision,
  pauseAgentHomeRoutineEmergency,
  queueAgentHomeRoutineRun,
  renewAgentHomeActionLease,
  updateAgentHomeIdentityCAS,
  updateAgentHomeRoutineCAS,
  updateAgentHomeRoutineStatusCAS,
  updateAgentHomeSettingsCAS,
} from "./agent-home-revision.ts";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_APP_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ROUTINE_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const CAPABILITY_ID = "66666666-6666-4666-8666-666666666666";
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const LEASE_TOKEN = "88888888-8888-4888-8888-888888888888";

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

Deno.test("Agent Home revisions are app-bound and lossless", () => {
  const token = formatAgentHomeRevision(APP_ID, "900719925474099312345");
  assertEquals(token, `ah1:${APP_ID}:900719925474099312345`);
  assertEquals(
    parseAgentHomeRevision(token, APP_ID),
    "900719925474099312345",
  );
  assertThrows(
    () => parseAgentHomeRevision(token, OTHER_APP_ID),
    AgentHomeRevisionError,
  );
  assertThrows(
    () => formatAgentHomeRevision(APP_ID, Number.MAX_SAFE_INTEGER + 1),
    AgentHomeRevisionError,
  );
});

Deno.test("getAgentHomeRevision returns a token and hides non-owner/private misses", async () => {
  let body: Record<string, unknown> | null = null;
  const token = await getAgentHomeRevision(
    APP_ID,
    USER_ID,
    deps(mockFetch(
      (_url, init) => {
        body = bodyOf(init);
        return jsonResponse("41");
      },
    )),
  );
  assertEquals(body, { p_app_id: APP_ID, p_user_id: USER_ID });
  assertEquals(token, `ah1:${APP_ID}:41`);

  const missing = await getAgentHomeRevision(
    APP_ID,
    USER_ID,
    deps(mockFetch(
      () =>
        jsonResponse({
          code: "P0001",
          details: JSON.stringify({ code: "AGENT_HOME_NOT_FOUND" }),
        }, 400),
    )),
  );
  assertEquals(missing, null);
});

Deno.test("Agent Home CAS rejects every non-account auth source before fetch", async () => {
  for (
    const authSource of [
      "api_token",
      "routine_actor",
      "sandbox_actor",
      undefined,
    ]
  ) {
    let called = false;
    const error = await assertRejects(
      () =>
        updateAgentHomeIdentityCAS(
          {
            appId: APP_ID,
            userId: USER_ID,
            expectedRevision: formatAgentHomeRevision(APP_ID, 1),
            authSource,
            name: "Agent",
          },
          deps(mockFetch(() => {
            called = true;
            return jsonResponse([]);
          })),
        ),
      AgentHomeRevisionError,
    );
    assertEquals(
      (error as AgentHomeRevisionError).code,
      "ACCOUNT_SESSION_REQUIRED",
    );
    assertEquals(called, false);
  }
});

Deno.test("identity CAS allows account sessions and preserves omitted-vs-clear flags", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const revision = await updateAgentHomeIdentityCAS(
    {
      appId: APP_ID,
      userId: USER_ID,
      expectedRevision: formatAgentHomeRevision(APP_ID, 8),
      authSource: "supabase",
      description: null,
    },
    deps(mockFetch((url, init) => {
      assertStringIncludes(url, "/rpc/update_agent_home_identity");
      requestBody = bodyOf(init);
      return jsonResponse([{ new_revision: "9" }]);
    })),
  );
  assertEquals(requestBody, {
    p_app_id: APP_ID,
    p_user_id: USER_ID,
    p_expected_revision: "8",
    p_set_name: false,
    p_name: null,
    p_set_description: true,
    p_description: null,
  });
  assertEquals(revision, formatAgentHomeRevision(APP_ID, 9));
});

Deno.test("stale CAS maps to HTTP 412 and carries the current app-bound token", async () => {
  const error = await assertRejects(
    () =>
      updateAgentHomeIdentityCAS(
        {
          appId: APP_ID,
          userId: USER_ID,
          expectedRevision: formatAgentHomeRevision(APP_ID, 8),
          authSource: "supabase",
          name: "Agent",
        },
        deps(mockFetch(() =>
          jsonResponse({
            code: "P0001",
            details: JSON.stringify({
              code: "AGENT_HOME_REVISION_CONFLICT",
              expectedRevision: "8",
              actualRevision: "11",
            }),
          }, 400)
        )),
      ),
    AgentHomeRevisionError,
  ) as AgentHomeRevisionError;
  assertEquals(error.code, "AGENT_HOME_REVISION_CONFLICT");
  assertEquals(error.status, 412);
  assertEquals(error.currentRevision, formatAgentHomeRevision(APP_ID, 11));
  assertEquals(error.expectedRevision, formatAgentHomeRevision(APP_ID, 8));
});

Deno.test("routine CAS maps camel-case ceilings to the all-or-none database policy", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  await updateAgentHomeRoutineCAS(
    {
      appId: APP_ID,
      userId: USER_ID,
      routineId: ROUTINE_ID,
      expectedRevision: formatAgentHomeRevision(APP_ID, 3),
      authSource: "supabase",
      budgets: {
        maxLightPerRun: 5,
        maxLightPerDay: 20,
        maxLightPerMonth: 200,
        maxCallsPerRun: 7,
      },
    },
    deps(mockFetch((_url, init) => {
      requestBodies.push(bodyOf(init));
      return jsonResponse([{ new_revision: "4" }]);
    })),
  );
  assertEquals(requestBodies[0].p_set_budget, true);
  assertEquals(requestBodies[0].p_budget_policy, {
    max_light_per_run: 5,
    max_light_per_day: 20,
    max_light_per_month: 200,
    max_calls_per_run: 7,
  });
});

Deno.test("settings CAS exposes ciphertext-only RPC fields", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  await updateAgentHomeSettingsCAS(
    {
      appId: APP_ID,
      userId: USER_ID,
      expectedRevision: formatAgentHomeRevision(APP_ID, 3),
      authSource: "supabase",
      agentCiphertexts: { AGENT_KEY: "encrypted-agent" },
      perUserCiphertexts: { USER_KEY: "encrypted-user", OLD_KEY: null },
    },
    deps(mockFetch((_url, init) => {
      requestBodies.push(bodyOf(init));
      return jsonResponse([{ new_revision: "5" }]);
    })),
  );
  const requestBody = requestBodies[0];
  assertEquals(requestBody, {
    p_app_id: APP_ID,
    p_user_id: USER_ID,
    p_expected_revision: "3",
    p_agent_ciphertexts: { AGENT_KEY: "encrypted-agent" },
    p_per_user_ciphertexts: { USER_KEY: "encrypted-user", OLD_KEY: null },
  });
  assertEquals("p_values" in (requestBody || {}), false);
  assertEquals("p_agent_values" in (requestBody || {}), false);
});

Deno.test("lifecycle, capability, and run-now gates use dedicated owner CAS RPCs", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = mockFetch((url, init) => {
    calls.push({ url, body: bodyOf(init) });
    return jsonResponse(
      url.endsWith("/assert_agent_home_revision")
        ? "7"
        : [{ new_revision: "8" }],
    );
  });
  const options = deps(fetchFn);
  const base = {
    appId: APP_ID,
    userId: USER_ID,
    routineId: ROUTINE_ID,
    expectedRevision: formatAgentHomeRevision(APP_ID, 7),
    authSource: "supabase" as const,
  };
  await updateAgentHomeRoutineStatusCAS({ ...base, status: "active" }, options);
  await approveAgentHomeCapabilitiesCAS({
    ...base,
    capabilityIds: [CAPABILITY_ID],
  }, options);
  await assertAgentHomeRevision(base, options);
  assert(calls[0].url.endsWith("/rpc/update_agent_home_routine_status"));
  assert(calls[1].url.endsWith("/rpc/approve_agent_home_capabilities"));
  assert(calls[2].url.endsWith("/rpc/assert_agent_home_revision"));
  assertEquals(calls[1].body.p_capability_ids, [CAPABILITY_ID]);
});

Deno.test("action claims canonicalize authority payload and parse replay state", async () => {
  const requestBodies: Record<string, unknown>[] = [];
  const claim = await claimAgentHomeAction(
    {
      appId: APP_ID,
      userId: USER_ID,
      expectedRevision: formatAgentHomeRevision(APP_ID, 12),
      authSource: "supabase",
      idempotencyKey: "request-key",
      action: "approve_capabilities",
      requestPayload: {
        capabilityIds: [OTHER_APP_ID, CAPABILITY_ID, OTHER_APP_ID],
        version: "v1 exact",
      },
    },
    deps(mockFetch((_url, init) => {
      requestBodies.push(bodyOf(init));
      return jsonResponse([{
        request_id: REQUEST_ID,
        request_lease_token: LEASE_TOKEN,
        is_new: false,
        request_status: "completed",
        request_response: { ok: true },
        request_fingerprint: "a".repeat(64),
        current_revision: "15",
      }]);
    })),
  );
  assertEquals(requestBodies[0].p_request_payload, {
    action: "approve_capabilities",
    capabilityIds: [OTHER_APP_ID, CAPABILITY_ID].sort(),
    version: "v1 exact",
  });
  assertEquals(claim, {
    requestId: REQUEST_ID,
    leaseToken: LEASE_TOKEN,
    isNew: false,
    status: "completed",
    response: { ok: true },
    requestFingerprint: "a".repeat(64),
    currentRevision: formatAgentHomeRevision(APP_ID, 15),
  });
});

Deno.test("action completion is account-only and response preserving", async () => {
  const completed = await completeAgentHomeAction(
    {
      appId: APP_ID,
      userId: USER_ID,
      requestId: REQUEST_ID,
      leaseToken: LEASE_TOKEN,
      authSource: "supabase",
      status: "failed",
      response: { code: "blocked" },
    },
    deps(mockFetch((_url, init) => {
      assertEquals(bodyOf(init).p_response, { code: "blocked" });
      assertEquals(bodyOf(init).p_lease_token, LEASE_TOKEN);
      return jsonResponse([{
        request_id: REQUEST_ID,
        request_status: "failed",
        request_response: { code: "blocked" },
      }]);
    })),
  );
  assertEquals(completed.status, "failed");
  assertEquals(completed.response, { code: "blocked" });
});

Deno.test("action lease renewal passes the exact fencing token", async () => {
  const expiresAt = "2026-07-14T16:30:00.000Z";
  const renewed = await renewAgentHomeActionLease(
    {
      appId: APP_ID,
      userId: USER_ID,
      requestId: REQUEST_ID,
      leaseToken: LEASE_TOKEN,
      authSource: "supabase",
    },
    deps(mockFetch((url, init) => {
      assert(url.endsWith("/rpc/renew_agent_home_action_lease"));
      assertEquals(bodyOf(init).p_request_id, REQUEST_ID);
      assertEquals(bodyOf(init).p_lease_token, LEASE_TOKEN);
      return jsonResponse(expiresAt);
    })),
  );
  assertEquals(renewed, expiresAt);
});

Deno.test("emergency pause atomically resolves and stops the canonical routine", async () => {
  const paused = await pauseAgentHomeRoutineEmergency(
    {
      appId: APP_ID,
      userId: USER_ID,
      authSource: "supabase",
    },
    deps(mockFetch((url, init) => {
      assert(url.endsWith("/rpc/pause_agent_home_routine_emergency"));
      assertEquals(bodyOf(init), { p_app_id: APP_ID, p_user_id: USER_ID });
      return jsonResponse([{
        routine_id: ROUTINE_ID,
        routine_status: "paused",
        new_revision: "14",
      }]);
    })),
  );
  assertEquals(paused, {
    routineId: ROUTINE_ID,
    status: "paused",
    revision: formatAgentHomeRevision(APP_ID, 14),
  });
});

Deno.test("lost action leases retain their explicit nonterminal code", async () => {
  const error = await assertRejects(
    () =>
      completeAgentHomeAction(
        {
          appId: APP_ID,
          userId: USER_ID,
          requestId: REQUEST_ID,
          leaseToken: LEASE_TOKEN,
          authSource: "supabase",
          status: "completed",
          response: { code: "done" },
        },
        deps(mockFetch(() =>
          jsonResponse({
            code: "P0001",
            details: JSON.stringify({ code: "AGENT_HOME_ACTION_IN_PROGRESS" }),
          }, 400)
        )),
      ),
    AgentHomeRevisionError,
  );
  assertEquals(error.code, "AGENT_HOME_ACTION_IN_PROGRESS");
  assertEquals(error.status, 409);
});

Deno.test("expired action recovery returns the exact owner-scoped durable request", async () => {
  const error = await assertRejects(
    () =>
      claimAgentHomeAction(
        {
          appId: APP_ID,
          userId: USER_ID,
          expectedRevision: formatAgentHomeRevision(APP_ID, 12),
          authSource: "supabase",
          idempotencyKey: "99999999-9999-4999-8999-999999999999",
          action: "pause",
        },
        deps(mockFetch(() =>
          jsonResponse({
            code: "P0001",
            details: JSON.stringify({
              code: "AGENT_HOME_ACTION_RECOVERY_REQUIRED",
              requestId: REQUEST_ID,
              idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              action: "promote_candidate",
              requestPayload: {
                action: "promote_candidate",
                capabilityIds: [],
                version: "1.2.3",
              },
            }),
          }, 400)
        )),
      ),
    AgentHomeRevisionError,
  );
  assertEquals(error.code, "AGENT_HOME_ACTION_RECOVERY_REQUIRED");
  assertEquals(error.status, 409);
  assertEquals(error.recovery, {
    requestId: REQUEST_ID,
    idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    action: "promote_candidate",
    requestPayload: {
      action: "promote_candidate",
      capabilityIds: [],
      version: "1.2.3",
    },
  });
});

Deno.test("promotion phases and app-record commit carry the exact lease token", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const options = deps(mockFetch((url, init) => {
    const body = bodyOf(init);
    requests.push({ url, body });
    if (url.endsWith("/rpc/fence_agent_home_promotion_step")) {
      return jsonResponse([{
        lease_expires_at: "2026-07-14T16:30:00.000Z",
        current_revision: "12",
      }]);
    }
    return jsonResponse([{ new_revision: "13" }]);
  }));
  const fenced = await fenceAgentHomePromotionStep({
    appId: APP_ID,
    userId: USER_ID,
    requestId: REQUEST_ID,
    leaseToken: LEASE_TOKEN,
    authSource: "supabase",
    step: "live_bundle",
  }, options);
  assertEquals(fenced.currentRevision, formatAgentHomeRevision(APP_ID, 12));
  const revision = await commitAgentHomePromotionAppRecord({
    appId: APP_ID,
    userId: USER_ID,
    requestId: REQUEST_ID,
    leaseToken: LEASE_TOKEN,
    authSource: "supabase",
    version: "1.2.3",
    storageKey: `apps/${APP_ID}/1.2.3/`,
    exports: ["tick"],
    manifest: '{"functions":{"tick":{}}}',
    envSchema: { API_KEY: { scope: "universal" } },
  }, options);
  assertEquals(revision, formatAgentHomeRevision(APP_ID, 13));
  assertEquals(requests[0].body.p_lease_token, LEASE_TOKEN);
  assertEquals(requests[0].body.p_step, "live_bundle");
  assertEquals(requests[1].body.p_lease_token, LEASE_TOKEN);
  assertEquals(requests[1].body.p_version, "1.2.3");
  assertEquals(requests[1].body.p_set_manifest, true);
  assertEquals(requests[1].body.p_exports, ["tick"]);
});

Deno.test("run-now queue atomically carries revision, routine, request, and lease", async () => {
  const queued = await queueAgentHomeRoutineRun(
    {
      appId: APP_ID,
      userId: USER_ID,
      routineId: ROUTINE_ID,
      requestId: REQUEST_ID,
      leaseToken: LEASE_TOKEN,
      expectedRevision: formatAgentHomeRevision(APP_ID, 12),
      authSource: "supabase",
    },
    deps(mockFetch((url, init) => {
      assert(url.endsWith("/rpc/queue_agent_home_routine_run"));
      assertEquals(bodyOf(init), {
        p_request_id: REQUEST_ID,
        p_app_id: APP_ID,
        p_user_id: USER_ID,
        p_routine_id: ROUTINE_ID,
        p_lease_token: LEASE_TOKEN,
        p_expected_revision: "12",
      });
      return jsonResponse([{ run_id: RUN_ID, is_new: true }]);
    })),
  );
  assertEquals(queued, { runId: RUN_ID, isNew: true });
});

Deno.test("run-now queue maps the durable concurrency gate to an explicit 409", async () => {
  const error = await assertRejects(
    () =>
      queueAgentHomeRoutineRun(
        {
          appId: APP_ID,
          userId: USER_ID,
          routineId: ROUTINE_ID,
          requestId: REQUEST_ID,
          leaseToken: LEASE_TOKEN,
          expectedRevision: formatAgentHomeRevision(APP_ID, 12),
          authSource: "supabase",
        },
        deps(mockFetch(() =>
          jsonResponse({
            code: "P0001",
            details: JSON.stringify({
              code: "AGENT_HOME_RUN_CONCURRENCY_LIMIT",
              activeRuns: 1,
              maxConcurrency: 1,
            }),
          }, 400)
        )),
      ),
    AgentHomeRevisionError,
  ) as AgentHomeRevisionError;
  assertEquals(error.code, "AGENT_HOME_RUN_CONCURRENCY_LIMIT");
  assertEquals(error.status, 409);
});

Deno.test("action claims reject missing or malformed fencing tokens", async () => {
  await assertRejects(
    () =>
      claimAgentHomeAction(
        {
          appId: APP_ID,
          userId: USER_ID,
          expectedRevision: formatAgentHomeRevision(APP_ID, 12),
          authSource: "supabase",
          idempotencyKey: "request-key",
          action: "run_now",
        },
        deps(mockFetch(() =>
          jsonResponse([{
            request_id: REQUEST_ID,
            request_lease_token: "not-a-uuid",
            is_new: true,
            request_status: "in_progress",
            request_response: {},
            request_fingerprint: "a".repeat(64),
            current_revision: "12",
          }])
        )),
      ),
    AgentHomeRevisionError,
  );
});

Deno.test("RPCs retry rolled-back deadlocks but not transport ambiguity", async () => {
  let deadlockAttempts = 0;
  const revision = await getAgentHomeRevision(
    APP_ID,
    USER_ID,
    deps(mockFetch(() => {
      deadlockAttempts += 1;
      return deadlockAttempts < 3
        ? jsonResponse({ code: "40P01", message: "deadlock detected" }, 409)
        : jsonResponse("9");
    })),
  );
  assertEquals(revision, formatAgentHomeRevision(APP_ID, 9));
  assertEquals(deadlockAttempts, 3);

  let transportAttempts = 0;
  await assertRejects(
    () =>
      getAgentHomeRevision(
        APP_ID,
        USER_ID,
        deps(mockFetch(() => {
          transportAttempts += 1;
          throw new TypeError("response lost");
        })),
      ),
    AgentHomeRevisionError,
  );
  assertEquals(transportAttempts, 1);
});

Deno.test("exact budget usage parses settled/reserved totals and zero-credit action counts", async () => {
  const result = await getAgentHomeBudgetUsage(
    {
      userId: USER_ID,
      routineId: ROUTINE_ID,
      recentRunIds: [RUN_ID],
      now: new Date("2026-07-14T15:00:00.000Z"),
    },
    deps(mockFetch((_url, init) => {
      assertEquals(bodyOf(init).p_recent_run_ids, [RUN_ID]);
      return jsonResponse([{
        day_started_at: "2026-07-14T00:00:00.000Z",
        month_started_at: "2026-07-01T00:00:00.000Z",
        day_settled_light: 5,
        day_reserved_light: 2,
        day_total_light: 7,
        month_settled_light: 30,
        month_reserved_light: 2,
        month_total_light: 32,
        last_run_id: RUN_ID,
        last_run_settled_light: 1,
        last_run_reserved_light: 2,
        last_run_total_light: 3,
        last_run_calls: 4,
        calls_by_run: { [RUN_ID]: 4 },
      }]);
    })),
  );
  assertEquals(result.daily, 7);
  assertEquals(result.monthly, 32);
  assertEquals(result.lastRun, 3);
  assertEquals(result.lastRunCalls, 4);
  assertEquals(result.callsByRun.get(RUN_ID), 4);
});

Deno.test("exact budget usage fails closed on malformed database totals", async () => {
  const error = await assertRejects(
    () =>
      getAgentHomeBudgetUsage(
        {
          userId: USER_ID,
          routineId: ROUTINE_ID,
          recentRunIds: [],
        },
        deps(mockFetch((_url, init) => {
          assertEquals("p_now" in bodyOf(init), false);
          return jsonResponse([{
            day_started_at: "2026-07-14T00:00:00.000Z",
            month_started_at: "2026-07-01T00:00:00.000Z",
            day_settled_light: 0,
            day_reserved_light: 0,
            day_total_light: "NaN",
            month_settled_light: 0,
            month_reserved_light: 0,
            month_total_light: 0,
            last_run_id: null,
            last_run_settled_light: 0,
            last_run_reserved_light: 0,
            last_run_total_light: 0,
            last_run_calls: 0,
            calls_by_run: {},
          }]);
        })),
      ),
    AgentHomeRevisionError,
  ) as AgentHomeRevisionError;
  assertEquals(error.code, "AGENT_HOME_SERVICE_UNAVAILABLE");
});

const migration = await Deno.readTextFile(
  new URL(
    "../../supabase/migrations/20260714162000_agent_home_revision.sql",
    import.meta.url,
  ),
);

function sqlFunction(name: string, nextMarker: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const end = migration.indexOf(nextMarker, start);
  assert(start >= 0, `${name} missing`);
  assert(end > start, `${name} end marker missing`);
  return migration.slice(start, end);
}

Deno.test("Agent Home migration revision excludes volatile execution and usage fields", () => {
  assertStringIncludes(
    migration,
    "ADD COLUMN IF NOT EXISTS agent_home_revision bigint",
  );
  const trigger = sqlFunction(
    "touch_app_agent_home_revision",
    "DROP TRIGGER IF EXISTS touch_apps_agent_home_revision",
  );
  assertStringIncludes(trigger, "OLD.current_version");
  assertStringIncludes(trigger, "NEW.current_version_promoted_at := now()");
  assertStringIncludes(
    trigger,
    "NEW.current_version_promoted_at := OLD.current_version_promoted_at",
  );
  assertStringIncludes(
    trigger,
    "NEW.agent_home_revision := OLD.agent_home_revision",
  );
  assertStringIncludes(
    trigger,
    "current_setting('galactic.agent_home_revision_bump', true)",
  );
  const bump = sqlFunction(
    "bump_agent_home_revision",
    "CREATE OR REPLACE FUNCTION public.bump_agent_home_revision_from_routine",
  );
  assertStringIncludes(
    bump,
    "set_config(\n    'galactic.agent_home_revision_bump', p_app_id::text, true",
  );
  for (
    const volatileField of [
      "OLD.total_runs",
      "OLD.runs_7d",
      "OLD.health_status",
      "OLD.last_build_at",
      "OLD.updated_at",
      "NEW.total_runs",
      "NEW.updated_at",
    ]
  ) {
    assertEquals(trigger.includes(volatileField), false, volatileField);
  }
  assertStringIncludes(migration, "- 'budget_spend' - 'auto_pause'");
  const grantTrigger = sqlFunction(
    "bump_agent_home_revision_from_grant",
    "DROP TRIGGER IF EXISTS bump_agent_home_revision_on_grant_insert_delete",
  );
  assertEquals(grantTrigger.includes("spent_credits_period"), false);
});

Deno.test("Agent Home migration tracks every dependent config and authority store", () => {
  for (
    const trigger of [
      "bump_agent_home_revision_on_routine_insert_delete",
      "bump_agent_home_revision_on_routine_update",
      "bump_agent_home_revision_on_capability_insert_delete",
      "bump_agent_home_revision_on_capability_update",
      "bump_agent_home_revision_on_user_setting_insert_delete",
      "bump_agent_home_revision_on_user_setting_update",
      "bump_agent_home_revision_on_grant_insert_delete",
      "bump_agent_home_revision_on_grant_update",
    ]
  ) {
    assertStringIncludes(migration, `CREATE TRIGGER ${trigger}`);
  }
  assertStringIncludes(
    migration,
    "AFTER UPDATE OF user_id, app_id, key, value_encrypted",
  );
  const grantUpdate = migration.slice(
    migration.indexOf(
      "CREATE TRIGGER bump_agent_home_revision_on_grant_update",
    ),
    migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.assert_agent_home_revision",
    ),
  );
  assertEquals(grantUpdate.includes("spent_credits_period"), false);
  assertEquals(grantUpdate.includes("period_start"), false);
});

Deno.test("Agent Home migration CAS is owner/private, row-locked, and ciphertext-only", () => {
  const assertion = sqlFunction(
    "assert_agent_home_revision",
    "CREATE OR REPLACE FUNCTION public.get_agent_home_revision",
  );
  assertStringIncludes(assertion, "owner_id = p_user_id");
  assertStringIncludes(assertion, "FOR UPDATE");
  assertStringIncludes(assertion, "v_visibility IS DISTINCT FROM 'private'");
  const settings = sqlFunction(
    "update_agent_home_settings",
    "CREATE OR REPLACE FUNCTION public.update_agent_home_routine_status",
  );
  assertStringIncludes(settings, "p_agent_ciphertexts");
  assertStringIncludes(settings, "p_per_user_ciphertexts");
  assertEquals(settings.includes("p_agent_values"), false);
  assertEquals(settings.includes("p_per_user_values"), false);
  assertStringIncludes(settings, "v_scope IS DISTINCT FROM 'universal'");
  assertStringIncludes(settings, "v_scope IS DISTINCT FROM 'per_user'");
  assertStringIncludes(settings, "public.normalize_agent_home_env_schema");
  assertStringIncludes(settings, "jsonb_typeof(v_entry) <> 'object'");
  assertStringIncludes(
    settings,
    "public.try_parse_agent_home_jsonb(manifest)",
  );
});

Deno.test("Agent Home migration safely parses legacy text manifests", () => {
  const parser = sqlFunction(
    "try_parse_agent_home_jsonb",
    "REVOKE ALL ON FUNCTION public.try_parse_agent_home_jsonb",
  );
  assertStringIncludes(parser, "RETURN p_value::jsonb");
  assertStringIncludes(parser, "EXCEPTION WHEN others THEN");
  assertStringIncludes(parser, "RETURN NULL");
  assertEquals(migration.includes("jsonb_typeof(manifest)"), false);
  assertEquals(migration.includes("COALESCE(manifest->'env'"), false);
  assertStringIncludes(
    migration,
    "WHEN COALESCE(entries.value->>'scope', entries.value->>'type') =",
  );
  assertStringIncludes(migration, "metadata->>'launch_primary' = 'true'");
});

Deno.test("Agent Home action claims fingerprint the full request and only CAS first claim", () => {
  assertStringIncludes(migration, "request_payload jsonb NOT NULL");
  assertStringIncludes(migration, "request_fingerprint text NOT NULL");
  assertStringIncludes(migration, "lease_token uuid DEFAULT gen_random_uuid() NOT NULL");
  assertStringIncludes(migration, "lease_expires_at timestamp with time zone");
  assertStringIncludes(migration, "agent_home_action_request_keys");
  assertStringIncludes(migration, "agent_home_action_alias_unique");
  assertStringIncludes(
    migration,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_home_one_action_in_progress",
  );
  const claim = sqlFunction(
    "claim_agent_home_action",
    "CREATE OR REPLACE FUNCTION public.complete_agent_home_action",
  );
  assertStringIncludes(claim, "extensions.digest");
  assertStringIncludes(
    claim,
    "v_existing.request_payload IS DISTINCT FROM p_request_payload",
  );
  assertEquals(
    claim.includes(
      "v_existing.expected_revision IS DISTINCT FROM p_expected_revision",
    ),
    false,
  );
  assert(
    claim.indexOf("IF FOUND THEN") <
      claim.indexOf("IF v_revision <> p_expected_revision THEN"),
  );
  assertStringIncludes(claim, "lease_token = gen_random_uuid()");
  assertStringIncludes(claim, "v_existing.lease_expires_at <= now()");
  assertStringIncludes(claim, "v_existing.lease_token");
  assertStringIncludes(claim, '"code":"AGENT_HOME_ACTION_IN_PROGRESS"');
  assertStringIncludes(claim, "AGENT_HOME_ACTION_RECOVERY_REQUIRED");
  assertStringIncludes(claim, "requestPayload");
  assertStringIncludes(claim, "agent_home_action_request_keys");

  const fence = sqlFunction(
    "fence_agent_home_promotion_step",
    "CREATE OR REPLACE FUNCTION public.guard_agent_home_promotion_release_write",
  );
  assertStringIncludes(fence, "v_revision <> v_existing.expected_revision");
  assertStringIncludes(fence, "side_effect_started_at = COALESCE");
  assertStringIncludes(fence, "v_existing.lease_token IS DISTINCT FROM p_lease_token");
  const promotionCommit = sqlFunction(
    "commit_agent_home_promotion_app_record",
    "CREATE OR REPLACE FUNCTION public.renew_agent_home_action_lease",
  );
  assertStringIncludes(promotionCommit, "galactic.agent_home_promotion_request");
  assertStringIncludes(promotionCommit, "v_existing.request_payload->>'version'");
  assertStringIncludes(promotionCommit, "v_existing.lease_token IS DISTINCT FROM p_lease_token");
  assertStringIncludes(
    migration,
    "CREATE TRIGGER guard_agent_home_promotion_release_write",
  );
  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.commit_agent_home_promotion_app_record",
  );

  const renew = sqlFunction(
    "renew_agent_home_action_lease",
    "CREATE OR REPLACE FUNCTION public.complete_agent_home_action",
  );
  assertStringIncludes(renew, "v_existing.lease_expires_at <= now()");
  assertStringIncludes(renew, "v_existing.lease_token IS DISTINCT FROM p_lease_token");
  assertStringIncludes(renew, "lease_expires_at = v_expires_at");

  const emergencyPause = sqlFunction(
    "pause_agent_home_routine_emergency",
    "CREATE OR REPLACE FUNCTION public.approve_agent_home_capabilities",
  );
  assertStringIncludes(emergencyPause, "FOR UPDATE");
  assertStringIncludes(emergencyPause, "metadata->>'launch_primary' = 'true'");
  assertStringIncludes(emergencyPause, "status <> 'disabled'");
  assertStringIncludes(emergencyPause, "next_run_at = NULL");
  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.pause_agent_home_routine_emergency(uuid, uuid)",
  );

  const complete = sqlFunction(
    "complete_agent_home_action",
    "CREATE OR REPLACE FUNCTION public.get_agent_home_budget_usage",
  );
  assertStringIncludes(complete, "p_lease_token uuid");
  assertStringIncludes(
    complete,
    "v_existing.lease_token IS DISTINCT FROM p_lease_token",
  );
  assertStringIncludes(complete, '"code":"AGENT_HOME_ACTION_IN_PROGRESS"');
  assertStringIncludes(
    migration,
    "agent_home_action_request_id uuid",
  );
  assertStringIncludes(
    migration,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_runs_agent_home_action_request",
  );

  const queue = sqlFunction(
    "queue_agent_home_routine_run",
    "CREATE OR REPLACE FUNCTION public.get_agent_home_budget_usage",
  );
  assertStringIncludes(queue, "v_existing.lease_token IS DISTINCT FROM p_lease_token");
  assertStringIncludes(queue, "v_revision <> p_expected_revision");
  assertStringIncludes(queue, "metadata->>'launch_primary' = 'true'");
  assertStringIncludes(queue, "AND status = 'active'");
  assertStringIncludes(queue, "agent_home_action_request_id");
  assertStringIncludes(queue, "status IN ('queued', 'running')");
  assertStringIncludes(queue, "v_active_runs >= v_max_concurrency");
  assertStringIncludes(queue, "AGENT_HOME_RUN_CONCURRENCY_LIMIT");

  const consumerGate = sqlFunction(
    "enforce_routine_run_max_concurrency",
    "DROP TRIGGER IF EXISTS enforce_routine_run_max_concurrency",
  );
  assertStringIncludes(consumerGate, "FROM public.user_routines");
  assertStringIncludes(consumerGate, "FOR UPDATE");
  assertStringIncludes(consumerGate, "status = 'running'");
  assertStringIncludes(consumerGate, "v_running >= v_max_concurrency");
  assertStringIncludes(
    migration,
    "CREATE TRIGGER enforce_routine_run_max_concurrency",
  );
  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.enforce_routine_run_max_concurrency() FROM PUBLIC, anon, authenticated",
  );
});

Deno.test("Agent Home exact budget RPC locks before unbounded authoritative sums", () => {
  const budget = sqlFunction(
    "get_agent_home_budget_usage",
    "REVOKE ALL ON FUNCTION public.touch_app_agent_home_revision",
  );
  assert(
    budget.indexOf("FOR UPDATE OF routines") <
      budget.indexOf("sum(runs.total_light)"),
  );
  assertStringIncludes(budget, "reservations.status = 'reserved'");
  assertStringIncludes(
    budget,
    "count(reservations.id)::integer AS action_count",
  );
  assertStringIncludes(budget, "runs.created_at >= v_month_start");
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.get_agent_home_budget_usage",
  );
});
