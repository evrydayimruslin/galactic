import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildComputeSmokeMarker,
  COMPUTE_SMOKE_FUNCTION,
  COMPUTE_SMOKE_KIND,
  computeSmokeConfigFromEnv,
  runAdmittedComputeSmoke,
} from "./compute-admitted-smoke.mjs";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_ID = "bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb";
const COMPUTE_RECEIPT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const START_RECEIPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STATUS_RECEIPT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CANDIDATE_SHA = "a".repeat(40);
const WORKFLOW_RUN_ID = "123456789";
const OWNER_TOKEN = "owner-access-token-must-never-be-serialized";
const API_BASE = "https://api.connectgalactic.com";
const MARKER = buildComputeSmokeMarker(CANDIDATE_SHA, WORKFLOW_RUN_ID);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function settingsView({
  enabled = false,
  revision = "0",
  limits = {
    maxTimeoutMs: 60_000,
    maxConcurrency: 1,
    maxArtifactBytes: 10_000_000,
    maxArtifacts: 5,
  },
} = {}) {
  return {
    settings: {
      enabled,
      profile: "developer-v1",
      allowedTools: ["shell"],
      secretBindings: [],
      authorityRules: [],
      limits,
      manifestCeiling: {
        enabled: true,
        profile: "developer-v1",
        tools: ["shell"],
        secrets: [],
      },
      ownerConfirmedAt: enabled ? "2026-07-25T12:00:00.000Z" : null,
      updatedAt: "2026-07-25T12:00:00.000Z",
    },
    revision,
    generatedAt: "2026-07-25T12:00:00.000Z",
  };
}

function ownerRun(status) {
  const terminal = ["completed", "failed", "cancelled"].includes(status);
  return {
    runId: RUN_ID,
    receiptId: COMPUTE_RECEIPT_ID,
    receiptUrl: null,
    billingMode: "subscription_capacity",
    status,
    agentId: AGENT_ID,
    agentName: "Interface Demo",
    functionName: COMPUTE_SMOKE_FUNCTION,
    createdAt: "2026-07-25T12:00:01.000Z",
    startedAt: status === "queued"
      ? null
      : "2026-07-25T12:00:02.000Z",
    finishedAt: terminal ? "2026-07-25T12:00:03.000Z" : null,
    usage: terminal
      ? { reserved: 0.5, actual: 0.25, trueUp: -0.25, unit: "Light" }
      : { reserved: 0.5, actual: null, trueUp: null, unit: "Light" },
    exitCode: status === "completed" ? 0 : null,
    infraFailure: null,
    artifacts: [],
    cancellable: ["queued", "reserving", "starting", "running"].includes(
      status,
    ),
  };
}

function smokeConfig(overrides = {}) {
  return {
    target: "production",
    apiBase: API_BASE,
    candidateSha: CANDIDATE_SHA,
    workflowRunId: WORKFLOW_RUN_ID,
    marker: MARKER,
    agentId: AGENT_ID,
    ownerAccessToken: OWNER_TOKEN,
    evidencePath: "/tmp/compute-admitted-production.json",
    cleanupOnly: false,
    ...overrides,
  };
}

function happyFetch({ statuses = ["queued", "settlement_pending", "completed"] } = {}) {
  const calls = [];
  let enabled = false;
  let revision = 0;
  let runPoll = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const call = {
      url,
      method: init.method || "GET",
      headers: new Headers(init.headers),
      body: init.body === undefined ? null : JSON.parse(init.body),
    };
    calls.push(call);
    assert.equal(call.headers.get("authorization"), `Bearer ${OWNER_TOKEN}`);
    assert.equal(url.startsWith(API_BASE), true);

    const settingsPath = `/api/launch/agents/${AGENT_ID}/compute/settings`;
    if (url === `${API_BASE}${settingsPath}` && call.method === "GET") {
      return jsonResponse(settingsView({
        enabled,
        revision: String(revision),
        limits: enabled
          ? {
            maxTimeoutMs: 30_000,
            maxConcurrency: 1,
            maxArtifactBytes: 1_048_576,
            maxArtifacts: 1,
          }
          : {
            maxTimeoutMs: 60_000,
            maxConcurrency: 1,
            maxArtifactBytes: 10_000_000,
            maxArtifacts: 5,
          },
      }));
    }
    if (url === `${API_BASE}${settingsPath}` && call.method === "PUT") {
      assert.equal(String(call.body.expectedRevision), String(revision));
      enabled = call.body.settings.enabled;
      revision += 1;
      return jsonResponse(settingsView({
        enabled,
        revision: String(revision),
        limits: call.body.settings.limits,
      }));
    }

    const functionPath =
      `/api/launch/agents/${AGENT_ID}/functions/${COMPUTE_SMOKE_FUNCTION}/run`;
    if (url === `${API_BASE}${functionPath}` && call.method === "POST") {
      if (call.body.args.action === "start") {
        assert.deepEqual(call.body, {
          args: { action: "start", marker: MARKER },
        });
        return jsonResponse({
          success: true,
          functionName: COMPUTE_SMOKE_FUNCTION,
          result: {
            async: true,
            run_id: RUN_ID,
            receipt_id: COMPUTE_RECEIPT_ID,
            status: "queued",
            profile: "developer-v1",
            tools: ["shell"],
            created_at: "2026-07-25T12:00:01.000Z",
          },
          receiptId: START_RECEIPT_ID,
          error: null,
        });
      }
      assert.deepEqual(call.body, {
        args: { action: "status", run_id: RUN_ID },
      });
      return jsonResponse({
        success: true,
        functionName: COMPUTE_SMOKE_FUNCTION,
        result: {
          run_id: RUN_ID,
          receipt_id: COMPUTE_RECEIPT_ID,
          status: "completed",
          profile: "developer-v1",
          tools: ["shell"],
          created_at: "2026-07-25T12:00:01.000Z",
          started_at: "2026-07-25T12:00:02.000Z",
          finished_at: "2026-07-25T12:00:03.000Z",
          exit_code: 0,
          stdout: MARKER,
          stderr: "",
          artifacts: [],
        },
        receiptId: STATUS_RECEIPT_ID,
        error: null,
      });
    }

    if (
      url ===
        `${API_BASE}/api/launch/agents/${AGENT_ID}/compute/runs?limit=100`
    ) {
      const status = statuses[Math.min(runPoll, statuses.length - 1)];
      runPoll += 1;
      return jsonResponse({ runs: [ownerRun(status)], next_cursor: null });
    }
    throw new Error(`unexpected test request: ${call.method} ${url}`);
  };
  return { fetchImpl, calls, state: () => ({ enabled, revision, runPoll }) };
}

test("parses only pinned target/release inputs and derives the evidence path", () => {
  const config = computeSmokeConfigFromEnv({
    GALACTIC_SMOKE_TARGET: "production",
    COMPUTE_RELEASE_SHA: CANDIDATE_SHA,
    COMPUTE_RELEASE_RUN_ID: WORKFLOW_RUN_ID,
    COMPUTE_RELEASE_EVIDENCE_DIR: "/tmp/release-evidence",
    GALACTIC_SMOKE_APP_ID: AGENT_ID,
    GALACTIC_OWNER_ACCESS_TOKEN: OWNER_TOKEN,
  });
  assert.equal(config.apiBase, API_BASE);
  assert.equal(config.marker, MARKER);
  assert.equal(
    config.evidencePath,
    "/tmp/release-evidence/compute-admitted-production.json",
  );
  assert.throws(
    () =>
      computeSmokeConfigFromEnv({
        GALACTIC_SMOKE_TARGET: "preview",
        COMPUTE_RELEASE_SHA: CANDIDATE_SHA,
        COMPUTE_RELEASE_RUN_ID: WORKFLOW_RUN_ID,
        COMPUTE_RELEASE_EVIDENCE_DIR: "/tmp/evidence",
        GALACTIC_SMOKE_APP_ID: AGENT_ID,
        GALACTIC_OWNER_ACCESS_TOKEN: OWNER_TOKEN,
      }),
    /staging or production/u,
  );
});

test("fails before fetching when target, API, and marker provenance diverge", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return jsonResponse({});
  };
  await assert.rejects(
    runAdmittedComputeSmoke(
      smokeConfig({ apiBase: "https://preview.example.test" }),
      { fetchImpl },
    ),
    /pinned production origin/u,
  );
  await assert.rejects(
    runAdmittedComputeSmoke(
      smokeConfig({
        marker: buildComputeSmokeMarker("b".repeat(40), WORKFLOW_RUN_ID),
      }),
      { fetchImpl },
    ),
    /does not match the release candidate/u,
  );
  assert.equal(fetchCalls, 0);
});

test("proves admission, execution, settlement, exact output, and disabled cleanup", async () => {
  const { fetchImpl, calls, state } = happyFetch();
  const written = [];
  let clock = Date.parse("2026-07-25T12:00:00.000Z");
  const evidence = await runAdmittedComputeSmoke(smokeConfig(), {
    fetchImpl,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    pollIntervalMs: 10,
    writeEvidence: async (path, value) => written.push({ path, value }),
  });

  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.kind, COMPUTE_SMOKE_KIND);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.target, "production");
  assert.equal(evidence.candidate_sha, CANDIDATE_SHA);
  assert.equal(evidence.workflow_run_id, WORKFLOW_RUN_ID);
  assert.equal(evidence.compute_run_id, RUN_ID);
  assert.equal(evidence.compute_receipt_id, COMPUTE_RECEIPT_ID);
  assert.equal(evidence.start_receipt_id, START_RECEIPT_ID);
  assert.equal(evidence.status_receipt_id, STATUS_RECEIPT_ID);
  assert.deepEqual(evidence.observed_states, [
    "queued",
    "settlement_pending",
    "completed",
  ]);
  assert.deepEqual(evidence.result, {
    status: "completed",
    exit_code: 0,
    stdout_sha256: evidence.marker_sha256,
    stderr_bytes: 0,
    artifact_count: 0,
  });
  assert.equal(evidence.policy_cleanup.disabled, true);
  assert.equal(state().enabled, false);
  assert.equal(written.length, 1);
  assert.equal(
    written[0].path,
    "/tmp/compute-admitted-production.json",
  );
  const serialized = JSON.stringify(written[0].value);
  assert.equal(serialized.includes(OWNER_TOKEN), false);
  assert.equal(serialized.includes(MARKER), false);

  const puts = calls.filter((call) =>
    call.method === "PUT" && call.url.endsWith("/compute/settings")
  );
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[0].body.settings, {
    enabled: true,
    profile: "developer-v1",
    allowedTools: ["shell"],
    secretBindings: [],
    authorityRules: [],
    limits: {
      maxTimeoutMs: 30_000,
      maxConcurrency: 1,
      maxArtifactBytes: 1_048_576,
      maxArtifacts: 1,
    },
  });
  assert.deepEqual(puts[1].body.settings, {
    enabled: false,
    profile: "developer-v1",
    allowedTools: ["shell"],
    secretBindings: [],
    authorityRules: [],
    limits: {
      maxTimeoutMs: 60_000,
      maxConcurrency: 1,
      maxArtifactBytes: 10_000_000,
      maxArtifacts: 5,
    },
  });
});

test("times out, cancels the exact admitted run, waits for settlement, and disables policy", async () => {
  const calls = [];
  const written = [];
  let enabled = false;
  let revision = 0;
  let cancelled = false;
  let clock = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    const body = init.body === undefined ? null : JSON.parse(init.body);
    calls.push({ url, method, body });
    if (url.endsWith("/compute/settings") && method === "GET") {
      return jsonResponse(settingsView({
        enabled,
        revision: String(revision),
        limits: enabled
          ? {
            maxTimeoutMs: 30_000,
            maxConcurrency: 1,
            maxArtifactBytes: 1_048_576,
            maxArtifacts: 1,
          }
          : {
            maxTimeoutMs: 60_000,
            maxConcurrency: 1,
            maxArtifactBytes: 10_000_000,
            maxArtifacts: 5,
          },
      }));
    }
    if (url.endsWith("/compute/settings") && method === "PUT") {
      enabled = body.settings.enabled;
      revision += 1;
      return jsonResponse(settingsView({
        enabled,
        revision: String(revision),
        limits: body.settings.limits,
      }));
    }
    if (url.includes("/functions/") && method === "POST") {
      return jsonResponse({
        success: true,
        functionName: COMPUTE_SMOKE_FUNCTION,
        result: {
          async: true,
          run_id: RUN_ID,
          receipt_id: COMPUTE_RECEIPT_ID,
          status: "running",
          profile: "developer-v1",
          tools: ["shell"],
          created_at: "2026-07-25T12:00:01.000Z",
        },
        receiptId: START_RECEIPT_ID,
        error: null,
      });
    }
    if (url.endsWith(`/compute/runs/${RUN_ID}/cancel`)) {
      assert.deepEqual(body, {});
      cancelled = true;
      return jsonResponse(ownerRun("settlement_pending"));
    }
    if (url.includes("/compute/runs?limit=100")) {
      return jsonResponse({
        runs: [ownerRun(cancelled ? "cancelled" : "running")],
        next_cursor: null,
      });
    }
    throw new Error(`unexpected test request: ${method} ${url}`);
  };

  await assert.rejects(
    runAdmittedComputeSmoke(smokeConfig(), {
      fetchImpl,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      smokeTimeoutMs: 10,
      cleanupTimeoutMs: 10,
      pollIntervalMs: 5,
      writeEvidence: async (path, value) => written.push({ path, value }),
    }),
    (error) => {
      assert.equal(error.code, "COMPUTE_RUN_TIMEOUT");
      return true;
    },
  );

  assert.equal(cancelled, true);
  assert.equal(enabled, false);
  assert.equal(
    calls.filter((call) => call.url.endsWith(`/${RUN_ID}/cancel`)).length,
    1,
  );
  assert.equal(written.length, 1);
  assert.equal(written[0].value.verified, false);
  assert.equal(written[0].value.failure_code, "COMPUTE_RUN_TIMEOUT");
  assert.equal(written[0].value.policy_cleanup.disabled, true);
  assert.equal(JSON.stringify(written[0].value).includes(OWNER_TOKEN), false);
});

test("upstream secret bodies never enter errors or evidence", async () => {
  const leaked = "upstream-secret-must-not-appear";
  const written = [];
  const { fetchImpl: baseFetch } = happyFetch();
  const fetchImpl = async (input, init) => {
    if (String(input).includes("/functions/")) {
      return jsonResponse({ leaked }, 500);
    }
    return await baseFetch(input, init);
  };
  await assert.rejects(
    runAdmittedComputeSmoke(smokeConfig(), {
      fetchImpl,
      writeEvidence: async (path, value) => written.push({ path, value }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 500/u);
      assert.doesNotMatch(error.message, new RegExp(leaked, "u"));
      return true;
    },
  );
  assert.equal(written.length, 1);
  assert.equal(JSON.stringify(written[0].value).includes(leaked), false);
  assert.equal(written[0].value.policy_cleanup.disabled, true);
});

test("cleanup-only disables an enabled fixture without starting a job", async () => {
  const calls = [];
  const written = [];
  let enabled = true;
  let revision = 7;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    calls.push({ url, method });
    if (url.endsWith("/compute/settings") && method === "GET") {
      return jsonResponse(settingsView({
        enabled,
        revision: String(revision),
        limits: {
          maxTimeoutMs: 30_000,
          maxConcurrency: 1,
          maxArtifactBytes: 1_048_576,
          maxArtifacts: 1,
        },
      }));
    }
    if (url.endsWith("/compute/settings") && method === "PUT") {
      const body = JSON.parse(init.body);
      enabled = body.settings.enabled;
      revision += 1;
      return jsonResponse(settingsView({
        enabled,
        revision: String(revision),
        limits: body.settings.limits,
      }));
    }
    throw new Error(`unexpected test request: ${method} ${url}`);
  };
  const evidence = await runAdmittedComputeSmoke(
    smokeConfig({ cleanupOnly: true }),
    {
      fetchImpl,
      writeEvidence: async (path, value) => written.push({ path, value }),
    },
  );
  assert.equal(enabled, false);
  assert.equal(evidence.policy_cleanup.disabled, true);
  assert.equal(calls.some((call) => call.url.includes("/functions/")), false);
  assert.equal(written.length, 1);
});
