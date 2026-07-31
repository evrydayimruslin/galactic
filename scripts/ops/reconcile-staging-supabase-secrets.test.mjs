import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cleanupPreparedStagingSecretFile,
  parseReconcileMode,
  PINNED_CLOUDFLARE_ACCOUNT_ID,
  PREPARED_SECRET_FILE_NAME,
  probeCanonicalStagingAuth,
  probeCanonicalStagingManagementProject,
  probeCanonicalStagingPostgrest,
  probeStagingWorkerSupabase,
  reconcileStagingSupabaseSecrets,
  SECRET_NAMES,
  spawnWranglerSecretBulk,
  STAGING_WORKER_NAME,
  STAGING_WRANGLER_CONFIG,
  withSecureSecretFile,
  writePreparedStagingSecretFile,
  WRANGLER_BIN,
  WRANGLER_BASE_WORKER_NAME,
} from "./reconcile-staging-supabase-secrets.mjs";
import {
  STAGING_API_BASE,
  STAGING_SUPABASE_PROJECT_REF,
  STAGING_SUPABASE_URL,
  SUPABASE_MANAGEMENT_API_BASE,
} from "../smoke/with-staging-owner-session.mjs";

const MANAGEMENT_TOKEN = "supabase-management-secret";
const ANON_KEY = "canonical-anon-secret";
const SERVICE_ROLE_KEY = "canonical-service-secret";
const CLOUDFLARE_TOKEN = "cloudflare-secret";
const API_TOKEN = "gx_staging-owner-fixture-secret";

function baseEnv(overrides = {}) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    SUPABASE_ACCESS_TOKEN: MANAGEMENT_TOKEN,
    SUPABASE_STAGING_PROJECT_ID: STAGING_SUPABASE_PROJECT_REF,
    ULTRALIGHT_TOKEN: API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: PINNED_CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN,
    UNRELATED_SECRET: "must-not-reach-wrangler",
    ...overrides,
  };
}

function canonicalKeys() {
  return {
    supabaseUrl: STAGING_SUPABASE_URL,
    anonKey: ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
  };
}

function response(body = null, status = 200) {
  return body === null
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

function successfulProbeFetch({ workerFailures = 0 } = {}) {
  const calls = [];
  let workerCalls = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init, headers: new Headers(init.headers) });
    if (
      url ===
        `${SUPABASE_MANAGEMENT_API_BASE}/v1/projects/${STAGING_SUPABASE_PROJECT_REF}`
    ) {
      return response({
        ref: STAGING_SUPABASE_PROJECT_REF,
        status: "ACTIVE_HEALTHY",
      });
    }
    if (url.startsWith(`${STAGING_SUPABASE_URL}/rest/v1/`)) {
      return response();
    }
    if (url === `${STAGING_SUPABASE_URL}/auth/v1/settings`) {
      return response({ external: { google: true } });
    }
    if (url === `${STAGING_API_BASE}/auth/user`) {
      workerCalls += 1;
      if (workerCalls <= workerFailures) {
        throw new Error("synthetic Worker timeout");
      }
      return response({
        id: "11111111-1111-4111-8111-111111111111",
        email: "staging-owner@example.com",
        authSource: "api_token",
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  return { fetchImpl, calls };
}

test("CLI is explicit and cannot select production or an arbitrary target", () => {
  assert.equal(parseReconcileMode(["--check"]), "check");
  assert.equal(parseReconcileMode(["--apply"]), "apply");
  assert.equal(parseReconcileMode(["--prepare-deploy"]), "prepare");
  assert.equal(parseReconcileMode(["--cleanup-deploy"]), "cleanup");
  for (const args of [
    [],
    ["--target", "production"],
    ["--apply", "--target=production"],
    ["--prepare-deploy", "--target=production"],
    ["--cleanup-deploy", "--force"],
    ["--force"],
  ]) {
    assert.throws(
      () => parseReconcileMode(args),
      (error) => error?.code === "invalid_arguments",
    );
  }
});

test("prepared deploy file is fixed, owner-only, exact, and explicitly cleaned", async () => {
  const runnerTemp = await mkdtemp(
    join(tmpdir(), "galactic-staging-secret-runner-"),
  );
  const file = join(runnerTemp, PREPARED_SECRET_FILE_NAME);
  const env = {
    RUNNER_TEMP: runnerTemp,
    STAGING_SUPABASE_SECRETS_FILE: file,
  };
  try {
    const result = await writePreparedStagingSecretFile({
      secrets: {
        SUPABASE_ANON_KEY: ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      },
      env,
    });
    assert.equal(result, file);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    });

    await cleanupPreparedStagingSecretFile({ env });
    await assert.rejects(access(file));
    // Cleanup is intentionally idempotent for an always-running workflow step.
    await cleanupPreparedStagingSecretFile({ env });
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("prepared deploy file rejects every path except the fixed runner-temporary file", async () => {
  const runnerTemp = await mkdtemp(
    join(tmpdir(), "galactic-staging-secret-path-"),
  );
  try {
    for (const candidate of [
      join(runnerTemp, "wrong.json"),
      join(runnerTemp, "nested", PREPARED_SECRET_FILE_NAME),
      PREPARED_SECRET_FILE_NAME,
    ]) {
      await assert.rejects(
        writePreparedStagingSecretFile({
          secrets: {
            SUPABASE_ANON_KEY: ANON_KEY,
            SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
          },
          env: {
            RUNNER_TEMP: runnerTemp,
            STAGING_SUPABASE_SECRETS_FILE: candidate,
          },
        }),
        (error) => error?.code === "invalid_prepared_secret_path",
      );
    }
  } finally {
    await rm(runnerTemp, { recursive: true, force: true });
  }
});

test("canonical probes are rowless and mirror the exact discovery count request", async () => {
  const { fetchImpl, calls } = successfulProbeFetch();
  await probeCanonicalStagingPostgrest({
    serviceRoleKey: SERVICE_ROLE_KEY,
    fetchImpl,
    timeoutMs: 50,
  });

  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    `${STAGING_SUPABASE_URL}/rest/v1/user_api_tokens?select=id&limit=0`,
  );
  assert.equal(calls[0].init.method, "HEAD");
  assert.equal(calls[0].headers.get("prefer"), "count=none");
  assert.equal(
    calls[1].url,
    `${STAGING_SUPABASE_URL}/rest/v1/apps?visibility=eq.public&deleted_at=is.null&select=id`,
  );
  assert.equal(calls[1].init.method, "HEAD");
  assert.equal(calls[1].headers.get("prefer"), "count=exact");
  for (const call of calls) {
    assert.equal(call.headers.get("apikey"), SERVICE_ROLE_KEY);
    assert.equal(
      call.headers.get("authorization"),
      `Bearer ${SERVICE_ROLE_KEY}`,
    );
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test("management project status is pinned, bounded, and strictly projected", async () => {
  const calls = [];
  const result = await probeCanonicalStagingManagementProject({
    managementAccessToken: MANAGEMENT_TOKEN,
    fetchImpl: async (input, init = {}) => {
      calls.push({
        url: String(input),
        init,
        headers: new Headers(init.headers),
      });
      return response({
        ref: STAGING_SUPABASE_PROJECT_REF,
        status: "ACTIVE_HEALTHY",
        name: "must-not-escape",
        organization_slug: "must-not-escape",
        database: { host: "must-not-escape" },
      });
    },
    timeoutMs: 50,
  });

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(
    url.origin,
    SUPABASE_MANAGEMENT_API_BASE,
  );
  assert.equal(
    url.pathname,
    `/v1/projects/${STAGING_SUPABASE_PROJECT_REF}`,
  );
  assert.equal(url.search, "");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(
    calls[0].headers.get("authorization"),
    `Bearer ${MANAGEMENT_TOKEN}`,
  );
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    project: {
      ref: STAGING_SUPABASE_PROJECT_REF,
      status: "ACTIVE_HEALTHY",
    },
    summary: "project=ACTIVE_HEALTHY",
  });
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
});

test("management project status reports a sanitized unhealthy lifecycle state", async () => {
  await assert.rejects(
    probeCanonicalStagingManagementProject({
      managementAccessToken: MANAGEMENT_TOKEN,
      fetchImpl: async () =>
        response({
          ref: STAGING_SUPABASE_PROJECT_REF,
          status: "ACTIVE_UNHEALTHY",
          name: "sensitive-upstream-name",
          database: { host: "sensitive-upstream-host" },
        }),
      timeoutMs: 50,
    }),
    (error) =>
      error?.code === "canonical_management_project_unhealthy" &&
      /project=ACTIVE_UNHEALTHY/.test(error.message) &&
      !/sensitive-upstream/.test(error.message),
  );
});

test("management project status rejects wrong identity and unknown state", async () => {
  for (const payload of [
    null,
    [],
    { ref: "aaaaaaaaaaaaaaaaaaaa", status: "ACTIVE_HEALTHY" },
    { ref: STAGING_SUPABASE_PROJECT_REF, status: "NOT_A_STATUS" },
  ]) {
    await assert.rejects(
      probeCanonicalStagingManagementProject({
        managementAccessToken: MANAGEMENT_TOKEN,
        fetchImpl: async () => response(payload),
        timeoutMs: 50,
      }),
      (error) =>
        error?.code === "canonical_management_project_probe_payload",
    );
  }
});

test("unhealthy management preflight blocks data-plane probes and secret mutation", async () => {
  const calls = [];
  const logs = [];
  let secureFileCalls = 0;
  let wranglerCalls = 0;
  await assert.rejects(
    reconcileStagingSupabaseSecrets({
      mode: "apply",
      env: baseEnv(),
      fetchKeysImpl: async () => canonicalKeys(),
      fetchImpl: async (input) => {
        calls.push(String(input));
        return response({
          ref: STAGING_SUPABASE_PROJECT_REF,
          status: "ACTIVE_UNHEALTHY",
          name: "sensitive-upstream-name",
          database: { host: "sensitive-upstream-host" },
        });
      },
      secureFileImpl: async () => {
        secureFileCalls += 1;
      },
      wranglerBulkImpl: async () => {
        wranglerCalls += 1;
      },
      timeoutMs: 50,
      log: (value) => logs.push(value),
    }),
    (error) =>
      error?.code === "canonical_management_project_unhealthy" &&
      /project=ACTIVE_UNHEALTHY/.test(error.message) &&
      !/sensitive-upstream/.test(error.message),
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0],
    `${SUPABASE_MANAGEMENT_API_BASE}/v1/projects/${STAGING_SUPABASE_PROJECT_REF}`,
  );
  assert.equal(secureFileCalls, 0);
  assert.equal(wranglerCalls, 0);
  assert.equal(logs.join("\n").includes("sensitive-upstream"), false);
});

test("discovery count failure is distinct and blocks reconciliation", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return call === 1 ? response() : response(null, 504);
  };
  await assert.rejects(
    probeCanonicalStagingPostgrest({
      serviceRoleKey: SERVICE_ROLE_KEY,
      fetchImpl,
      timeoutMs: 50,
    }),
    (error) => error?.code === "canonical_discovery_count_probe_http" &&
      /HTTP 504/.test(error.message),
  );
});

test("canonical anon key is accepted by the exact Supabase Auth project", async () => {
  const calls = [];
  await probeCanonicalStagingAuth({
    anonKey: ANON_KEY,
    fetchImpl: async (input, init = {}) => {
      calls.push({
        url: String(input),
        headers: new Headers(init.headers),
      });
      return response({ external: { google: true } });
    },
    timeoutMs: 50,
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${STAGING_SUPABASE_URL}/auth/v1/settings`,
  );
  assert.equal(calls[0].headers.get("apikey"), ANON_KEY);
});

test("Worker readiness is an authenticated token-and-owner read, not the best-effort public status metric", async () => {
  const calls = [];
  await assert.rejects(
    probeStagingWorkerSupabase({
      apiToken: API_TOKEN,
      fetchImpl: async (input, init = {}) => {
        calls.push({
          url: String(input),
          headers: new Headers(init.headers),
        });
        // This is the exact false-positive shape returned by the public status
        // route when its best-effort Supabase count fails.
        return response({ app_count: 0, available: false });
      },
      timeoutMs: 50,
    }),
    (error) => error?.code === "staging_worker_supabase_probe_payload",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${STAGING_API_BASE}/auth/user`);
  assert.equal(calls[0].headers.get("authorization"), `Bearer ${API_TOKEN}`);
});

test("check mode validates canonical and deployed paths without mutating Cloudflare", async () => {
  const { fetchImpl } = successfulProbeFetch();
  let keyOptions;
  let mutated = false;
  const logs = [];
  const result = await reconcileStagingSupabaseSecrets({
    mode: "check",
    env: baseEnv({
      CLOUDFLARE_ACCOUNT_ID: "",
      CLOUDFLARE_API_TOKEN: "",
    }),
    fetchImpl,
    fetchKeysImpl: async (options) => {
      keyOptions = options;
      return canonicalKeys();
    },
    wranglerBulkImpl: async () => {
      mutated = true;
    },
    timeoutMs: 50,
    log: (value) => logs.push(value),
  });

  assert.deepEqual(result, { applied: false });
  assert.equal(mutated, false);
  assert.equal(keyOptions.managementAccessToken, MANAGEMENT_TOKEN);
  assert.equal(keyOptions.projectRef, STAGING_SUPABASE_PROJECT_REF);
  assert.equal(logs.some((line) => line.includes(ANON_KEY)), false);
  assert.equal(logs.some((line) => line.includes(SERVICE_ROLE_KEY)), false);
});

test("prepare mode validates canonical services and needs no live Worker or Cloudflare credentials", async () => {
  const { fetchImpl, calls } = successfulProbeFetch();
  const logs = [];
  let observed;
  const result = await reconcileStagingSupabaseSecrets({
    mode: "prepare",
    env: baseEnv({
      ULTRALIGHT_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
      CLOUDFLARE_API_TOKEN: "",
    }),
    fetchImpl,
    fetchKeysImpl: async () => canonicalKeys(),
    prepareFileImpl: async (options) => {
      observed = options;
    },
    timeoutMs: 50,
    log: (value) => logs.push(value),
  });

  assert.deepEqual(result, { prepared: true });
  assert.deepEqual(observed.secrets, {
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  });
  assert.equal(observed.env.ULTRALIGHT_TOKEN, "");
  assert.equal(
    calls.some(({ url }) => url === `${STAGING_API_BASE}/auth/user`),
    false,
  );
  const renderedLogs = logs.join("\n");
  assert.equal(renderedLogs.includes(ANON_KEY), false);
  assert.equal(renderedLogs.includes(SERVICE_ROLE_KEY), false);
});

test("apply writes exactly two mode-0600 keys, scopes Wrangler, and cleans the file", async () => {
  const { fetchImpl } = successfulProbeFetch({ workerFailures: 1 });
  const logs = [];
  let observedFile;
  let observedPayload;
  let observedMode;
  let observedWrangler;

  const result = await reconcileStagingSupabaseSecrets({
    mode: "apply",
    env: baseEnv(),
    fetchImpl,
    fetchKeysImpl: async () => canonicalKeys(),
    wranglerBulkImpl: async (options) => {
      observedWrangler = options;
      observedFile = options.secretFile;
      observedPayload = JSON.parse(await readFile(options.secretFile, "utf8"));
      observedMode = (await stat(options.secretFile)).mode & 0o777;
    },
    waitImpl: async () => {},
    timeoutMs: 50,
    log: (value) => logs.push(value),
  });

  assert.deepEqual(result, { applied: true });
  assert.deepEqual(Object.keys(observedPayload).sort(), [...SECRET_NAMES].sort());
  assert.equal(observedPayload.SUPABASE_ANON_KEY, ANON_KEY);
  assert.equal(observedPayload.SUPABASE_SERVICE_ROLE_KEY, SERVICE_ROLE_KEY);
  assert.equal(observedMode, 0o600);
  assert.equal(observedWrangler.baseEnv.SUPABASE_ACCESS_TOKEN, MANAGEMENT_TOKEN);
  await assert.rejects(access(observedFile));

  const renderedLogs = logs.join("\n");
  for (const secret of [
    MANAGEMENT_TOKEN,
    ANON_KEY,
    SERVICE_ROLE_KEY,
    CLOUDFLARE_TOKEN,
    API_TOKEN,
  ]) {
    assert.equal(renderedLogs.includes(secret), false);
  }
});

test("explicit apply always rewrites both canonical keys even when the Worker service read is healthy", async () => {
  const { fetchImpl } = successfulProbeFetch();
  let secureFileCalls = 0;
  let wranglerCalls = 0;
  let observedSecrets;
  const result = await reconcileStagingSupabaseSecrets({
    mode: "apply",
    env: baseEnv(),
    fetchImpl,
    fetchKeysImpl: async () => canonicalKeys(),
    secureFileImpl: async (secrets, operation) => {
      secureFileCalls += 1;
      observedSecrets = secrets;
      return await operation("/tmp/opaque-secret-file.json");
    },
    wranglerBulkImpl: async ({ secretFile }) => {
      wranglerCalls += 1;
      assert.equal(secretFile, "/tmp/opaque-secret-file.json");
    },
    timeoutMs: 50,
    log: () => {},
  });
  assert.deepEqual(result, { applied: true });
  assert.equal(secureFileCalls, 1);
  assert.equal(wranglerCalls, 1);
  assert.deepEqual(observedSecrets, {
    SUPABASE_ANON_KEY: ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  });
});

test("Wrangler receives only the fixed staging target and a sanitized environment", async () => {
  const invocations = [];
  const spawnImpl = (command, args, options) => {
    invocations.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };

  await spawnWranglerSecretBulk({
    secretFile: "/tmp/opaque-owner-only-file.json",
    baseEnv: baseEnv(),
    spawnImpl,
  });

  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].args, [
    "secret",
    "list",
    "--format",
    "json",
    "--config",
    STAGING_WRANGLER_CONFIG,
    "--env",
    "staging",
    "--name",
    WRANGLER_BASE_WORKER_NAME,
  ]);
  assert.deepEqual(invocations[1].args, [
    "secret",
    "bulk",
    "/tmp/opaque-owner-only-file.json",
    "--config",
    STAGING_WRANGLER_CONFIG,
    "--env",
    "staging",
    "--name",
    WRANGLER_BASE_WORKER_NAME,
  ]);
  for (const invocation of invocations) {
    assert.equal(invocation.command, WRANGLER_BIN);
    assert.equal(invocation.options.shell, false);
    assert.deepEqual(
      invocation.options.stdio,
      ["ignore", "inherit", "inherit"],
    );
    assert.equal(
      invocation.options.env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_TOKEN,
    );
    assert.equal(
      invocation.options.env.CLOUDFLARE_ACCOUNT_ID,
      PINNED_CLOUDFLARE_ACCOUNT_ID,
    );
    for (const name of [
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_STAGING_PROJECT_ID",
      "ULTRALIGHT_TOKEN",
      "UNRELATED_SECRET",
    ]) {
      assert.equal(Object.hasOwn(invocation.options.env, name), false);
    }
  }
});

test("canonical probe failure prevents any secret file or Wrangler mutation", async () => {
  let secureFileCalls = 0;
  let wranglerCalls = 0;
  await assert.rejects(
    reconcileStagingSupabaseSecrets({
      mode: "apply",
      env: baseEnv(),
      fetchImpl: async (input) => {
        if (
          String(input) ===
            `${SUPABASE_MANAGEMENT_API_BASE}/v1/projects/${STAGING_SUPABASE_PROJECT_REF}`
        ) {
          return response({
            ref: STAGING_SUPABASE_PROJECT_REF,
            status: "ACTIVE_HEALTHY",
          });
        }
        if (String(input).includes("user_api_tokens")) {
          return response(null, 401);
        }
        throw new Error("unexpected call");
      },
      fetchKeysImpl: async () => canonicalKeys(),
      secureFileImpl: async () => {
        secureFileCalls += 1;
      },
      wranglerBulkImpl: async () => {
        wranglerCalls += 1;
      },
      timeoutMs: 50,
      log: () => {},
    }),
    (error) => error?.code === "canonical_token_store_probe_http",
  );
  assert.equal(secureFileCalls, 0);
  assert.equal(wranglerCalls, 0);
});

test("secure file cleanup runs when the secret operation fails", async () => {
  let observedFile;
  await assert.rejects(
    withSecureSecretFile(
      {
        SUPABASE_ANON_KEY: ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      },
      async (file) => {
        observedFile = file;
        throw new Error("synthetic non-secret failure");
      },
    ),
    /synthetic non-secret failure/,
  );
  await assert.rejects(access(observedFile));
});

test("wrong staging project or Cloudflare account fails closed", async () => {
  await assert.rejects(
    reconcileStagingSupabaseSecrets({
      mode: "apply",
      env: baseEnv({ SUPABASE_STAGING_PROJECT_ID: "production-ref" }),
      fetchKeysImpl: async () => canonicalKeys(),
      log: () => {},
    }),
    (error) => error?.code === "staging_project_mismatch",
  );

  const { fetchImpl } = successfulProbeFetch({ workerFailures: 1 });
  await assert.rejects(
    reconcileStagingSupabaseSecrets({
      mode: "apply",
      env: baseEnv({ CLOUDFLARE_ACCOUNT_ID: "wrong-account" }),
      fetchImpl,
      fetchKeysImpl: async () => canonicalKeys(),
      log: () => {},
    }),
    (error) => error?.code === "cloudflare_account_mismatch",
  );
});
