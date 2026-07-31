import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRecoveryMode,
  recoverStagingSupabaseDataPlane,
  restartPinnedStagingProject,
  StagingDataPlaneRecoveryError,
} from "./recover-staging-supabase-data-plane.mjs";
import {
  StagingSecretReconcileError,
} from "./reconcile-staging-supabase-secrets.mjs";
import {
  STAGING_SUPABASE_PROJECT_REF,
  STAGING_SUPABASE_URL,
  SUPABASE_MANAGEMENT_API_BASE,
} from "../smoke/with-staging-owner-session.mjs";

const MANAGEMENT_TOKEN = "management-secret-must-not-escape";
const SERVICE_ROLE_KEY = "service-role-secret-must-not-escape";

function baseEnv(overrides = {}) {
  return {
    SUPABASE_ACCESS_TOKEN: MANAGEMENT_TOKEN,
    SUPABASE_STAGING_PROJECT_ID: STAGING_SUPABASE_PROJECT_REF,
    ...overrides,
  };
}

function canonicalKeys() {
  return {
    supabaseUrl: STAGING_SUPABASE_URL,
    anonKey: "anon-secret-must-not-escape",
    serviceRoleKey: SERVICE_ROLE_KEY,
  };
}

function reconcileError(code, message = "sanitized failure") {
  return new StagingSecretReconcileError(code, message);
}

test("recovery CLI is explicit and staging-only", () => {
  assert.equal(
    parseRecoveryMode(["--restart-if-degraded"]),
    "restart-if-degraded",
  );
  for (const args of [[], ["--check"], ["--restart-if-degraded", "extra"]]) {
    assert.throws(
      () => parseRecoveryMode(args),
      (error) => error?.code === "invalid_arguments",
    );
  }
});

test("default invocation fails closed with a typed environment error", async () => {
  await assert.rejects(
    recoverStagingSupabaseDataPlane({
      env: Object.create(null),
    }),
    (error) =>
      error instanceof StagingDataPlaneRecoveryError &&
      error.code === "missing_environment",
  );
});

test("responsive canonical PostgREST never reads health or restarts", async () => {
  let healthCalls = 0;
  let restartCalls = 0;
  const logs = [];
  const result = await recoverStagingSupabaseDataPlane({
    env: baseEnv(),
    fetchKeysImpl: async () => canonicalKeys(),
    probeDataPlaneImpl: async ({ serviceRoleKey }) => {
      assert.equal(serviceRoleKey, SERVICE_ROLE_KEY);
    },
    probeHealthImpl: async () => {
      healthCalls += 1;
    },
    restartProjectImpl: async () => {
      restartCalls += 1;
    },
    waitImpl: async () => {},
    timeoutMs: 50,
    log: (value) => logs.push(value),
  });
  assert.deepEqual(result, { restarted: false });
  assert.equal(healthCalls, 0);
  assert.equal(restartCalls, 0);
  assert.match(logs.join("\n"), /no restart was needed/u);
});

test("two exact data-plane timeouts permit one pinned restart and require full recovery", async () => {
  let dataPlaneCalls = 0;
  let healthCalls = 0;
  let restartCalls = 0;
  const waits = [];
  const logs = [];
  const result = await recoverStagingSupabaseDataPlane({
    env: baseEnv(),
    fetchKeysImpl: async () => canonicalKeys(),
    probeDataPlaneImpl: async ({ serviceRoleKey }) => {
      assert.equal(serviceRoleKey, SERVICE_ROLE_KEY);
      dataPlaneCalls += 1;
      if (dataPlaneCalls <= 2) {
        throw reconcileError("canonical_token_store_probe_transport");
      }
    },
    probeHealthImpl: async ({ managementAccessToken }) => {
      assert.equal(managementAccessToken, MANAGEMENT_TOKEN);
      healthCalls += 1;
      if (healthCalls === 2) {
        throw reconcileError(
          "canonical_management_project_unhealthy",
          "Canonical staging Supabase project is not ready (project=RESTARTING).",
        );
      }
      return {
        summary: "project=ACTIVE_HEALTHY",
      };
    },
    restartProjectImpl: async ({ managementAccessToken }) => {
      assert.equal(managementAccessToken, MANAGEMENT_TOKEN);
      restartCalls += 1;
    },
    waitImpl: async (milliseconds) => waits.push(milliseconds),
    timeoutMs: 50,
    recoveryPollDelayMs: 7,
    log: (value) => logs.push(value),
  });
  assert.deepEqual(result, { restarted: true });
  assert.equal(restartCalls, 1);
  assert.equal(dataPlaneCalls, 3);
  assert.equal(healthCalls, 3);
  assert.deepEqual(waits, [2_000, 7]);
  assert.match(logs.join("\n"), /Requested one restart/u);
  assert.match(logs.join("\n"), /recovered after restart/u);
  assert.doesNotMatch(logs.join("\n"), /must-not-escape/u);
});

test("sanitized unhealthy Management state still permits the confirmed recovery", async () => {
  let dataPlaneCalls = 0;
  let restartCalls = 0;
  const logs = [];
  const result = await recoverStagingSupabaseDataPlane({
    env: baseEnv(),
    fetchKeysImpl: async () => canonicalKeys(),
    probeDataPlaneImpl: async () => {
      dataPlaneCalls += 1;
      if (dataPlaneCalls <= 2) {
        throw reconcileError("canonical_token_store_probe_transport");
      }
    },
    probeHealthImpl: async () => {
      if (restartCalls === 0) {
        throw reconcileError(
          "canonical_management_project_unhealthy",
          "Canonical staging Supabase project is not ready (project=ACTIVE_UNHEALTHY).",
        );
      }
      return {
        summary: "project=ACTIVE_HEALTHY",
      };
    },
    restartProjectImpl: async () => {
      restartCalls += 1;
    },
    waitImpl: async () => {},
    timeoutMs: 50,
    log: (value) => logs.push(value),
  });
  assert.deepEqual(result, { restarted: true });
  assert.equal(restartCalls, 1);
  assert.match(logs.join("\n"), /project=ACTIVE_UNHEALTHY/u);
});

test("credential rejection or ambiguous Management status never restarts", async () => {
  for (const error of [
    reconcileError(
      "canonical_token_store_probe_http",
      "Canonical staging API-token PostgREST probe failed (HTTP 401).",
    ),
    reconcileError(
      "canonical_management_project_probe_transport",
      "Canonical staging Supabase Management project probe failed.",
    ),
  ]) {
    let dataPlaneCalls = 0;
    let restartCalls = 0;
    await assert.rejects(
      recoverStagingSupabaseDataPlane({
        env: baseEnv(),
        fetchKeysImpl: async () => canonicalKeys(),
        probeDataPlaneImpl: async () => {
          dataPlaneCalls += 1;
          if (
            error.code === "canonical_management_project_probe_transport"
          ) {
            throw reconcileError("canonical_token_store_probe_transport");
          }
          throw error;
        },
        probeHealthImpl: async () => {
          throw error;
        },
        restartProjectImpl: async () => {
          restartCalls += 1;
        },
        waitImpl: async () => {},
        timeoutMs: 50,
      }),
      (received) => received?.code === error.code,
    );
    assert.equal(restartCalls, 0);
    assert.equal(
      dataPlaneCalls,
      error.code === "canonical_management_project_probe_transport" ? 2 : 1,
    );
  }
});

test("recovery is bounded and does not issue a second restart", async () => {
  let dataPlaneCalls = 0;
  let restartCalls = 0;
  await assert.rejects(
    recoverStagingSupabaseDataPlane({
      env: baseEnv(),
      fetchKeysImpl: async () => canonicalKeys(),
      probeDataPlaneImpl: async () => {
        dataPlaneCalls += 1;
        throw reconcileError("canonical_token_store_probe_transport");
      },
      probeHealthImpl: async () => ({
        summary: "project=ACTIVE_HEALTHY",
      }),
      restartProjectImpl: async () => {
        restartCalls += 1;
      },
      waitImpl: async () => {},
      timeoutMs: 50,
      recoveryPollAttempts: 2,
    }),
    (error) => error?.code === "staging_recovery_timeout",
  );
  assert.equal(dataPlaneCalls, 4);
  assert.equal(restartCalls, 1);
});

test("restart request is exact, bounded, and never exposes upstream content", async () => {
  const calls = [];
  await restartPinnedStagingProject({
    managementAccessToken: MANAGEMENT_TOKEN,
    fetchImpl: async (input, init = {}) => {
      calls.push({
        url: String(input),
        init,
        headers: new Headers(init.headers),
      });
      return new Response(null, { status: 200 });
    },
    timeoutMs: 50,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${SUPABASE_MANAGEMENT_API_BASE}/v1/projects/${STAGING_SUPABASE_PROJECT_REF}/restart`,
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    calls[0].headers.get("authorization"),
    `Bearer ${MANAGEMENT_TOKEN}`,
  );
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const leaked = "upstream-secret-must-not-escape";
  await assert.rejects(
    restartPinnedStagingProject({
      managementAccessToken: MANAGEMENT_TOKEN,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: leaked }), { status: 403 }),
      timeoutMs: 50,
    }),
    (error) =>
      error?.code === "staging_restart_http" &&
      /HTTP 403/u.test(error.message) &&
      !error.message.includes(leaked) &&
      !error.message.includes(MANAGEMENT_TOKEN),
  );
});

test("wrong project is rejected before key lookup or mutation", async () => {
  let keyCalls = 0;
  let restartCalls = 0;
  await assert.rejects(
    recoverStagingSupabaseDataPlane({
      env: baseEnv({
        SUPABASE_STAGING_PROJECT_ID: "aaaaaaaaaaaaaaaaaaaa",
      }),
      fetchKeysImpl: async () => {
        keyCalls += 1;
        return canonicalKeys();
      },
      restartProjectImpl: async () => {
        restartCalls += 1;
      },
    }),
    (error) =>
      error instanceof StagingDataPlaneRecoveryError &&
      error.code === "staging_project_mismatch",
  );
  assert.equal(keyCalls, 0);
  assert.equal(restartCalls, 0);
});
