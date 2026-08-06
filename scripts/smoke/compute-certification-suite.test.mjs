import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import {
  assertPinnedApiVersionResponse,
  buildComputeCertificationMarker,
  classifyComputeRuntimeFailure,
  computeCertificationStartRequestTimeoutMs,
  COMPUTE_CERTIFICATION_ARTIFACT_SHA256,
  COMPUTE_CERTIFICATION_FUNCTION,
  COMPUTE_CERTIFICATION_SCENARIOS,
  COMPUTE_POLICY_PROBE_FUNCTION,
  COMPUTE_POLICY_ROUTINE_NAME,
  COMPUTE_POLICY_BASELINE,
  computeCertificationConfigFromEnv,
  ensurePolicyCleanup,
  EXPECTED_GALACTIC_CLI_VERSION,
  failedScenarioRuntimeDiagnostic,
  runComputeCertificationSuite,
  validateComputeCertificationProof,
  validateTerminalPublicRun,
  waitForCancellableBodyStart,
} from "./compute-certification-suite.mjs";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASYNC_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BROWSER_RUN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASYNC_RECEIPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BROWSER_RECEIPT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ARTIFACT_ONE_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_TWO_ID = "22222222-2222-4222-8222-222222222222";
const POLICY_ROUTINE_ID = "99999999-9999-4999-8999-999999999999";
const POLICY_ROUTINE_RUN_ID = "88888888-8888-4888-8888-888888888888";
const CANDIDATE_SHA = "a".repeat(40);
const WORKFLOW_RUN_ID = "123456789";
const CANDIDATE_API_VERSION_ID = "12345678-1234-1234-1234-123456789abc";
const PRODUCTION_VERSION_OVERRIDE =
  `ultralight-api="${CANDIDATE_API_VERSION_ID}"`;
const API_BASE = "https://api.connectgalactic.com";
const OWNER_TOKEN = "owner-token-must-never-enter-evidence";
const MARKER = buildComputeCertificationMarker(
  CANDIDATE_SHA,
  WORKFLOW_RUN_ID,
);
const CREATED_AT = "2026-08-04T12:00:01.000Z";
const STARTED_AT = "2026-08-04T12:00:02.000Z";
const FINISHED_AT = "2026-08-04T12:00:03.000Z";
const EXPIRES_AT = "2026-08-05T12:00:03.000Z";

function computeFixtureScript(name) {
  const source = readFileSync(
    new URL("../../examples/compute-certification/index.ts", import.meta.url),
    "utf8",
  );
  const match = source.match(
    new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]\\.join\\("\\\\n"\\));`, "u"),
  );
  assert.ok(match, `Missing ${name} in the Compute certification fixture`);
  return runInNewContext(match[1]);
}

function runHttpsEgressFixture(curlBody) {
  return spawnSync("bash", ["-s"], {
    encoding: "utf8",
    input: `curl() {\n${curlBody}\n}\n${computeFixtureScript("HTTPS_EGRESS_SCRIPT")}\n`,
  });
}

function runRawTcpFixture(shellPrelude) {
  return spawnSync("bash", ["-s"], {
    encoding: "utf8",
    input: `${shellPrelude}\n${computeFixtureScript("RAW_TCP_SCRIPT")}\n`,
  });
}

test("binds toolchain certification to the workspace and image CLI metadata", () => {
  const cliPackage = JSON.parse(
    readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8"),
  );
  const fixtureSource = readFileSync(
    new URL("../../examples/compute-certification/index.ts", import.meta.url),
    "utf8",
  );
  assert.equal(EXPECTED_GALACTIC_CLI_VERSION, cliPackage.version);
  assert.match(
    fixtureSource,
    /\/opt\/galactic\/image-metadata\/galactic-cli-version\.txt/u,
  );
  assert.doesNotMatch(fixtureSource, /galactic_cli: "[0-9]+\.[0-9]+\.[0-9]+"/u);

  const proof = {
    schema_version: 1,
    scenario: "sync_toolchain",
    verified: true,
    python: "3.13.14",
    npm: "12.0.1",
    deno: "2.9.3",
    galactic_cli: EXPECTED_GALACTIC_CLI_VERSION,
    playwright: "1.62.0-alpha-2026-07-20",
    chromium: "152.0.7977.8",
  };
  const proofText = JSON.stringify(proof);
  assert.deepEqual(
    validateComputeCertificationProof(
      { stdout: proofText, stderr: "" },
      "sync_toolchain",
    ),
    {
      stdoutSha256: createHash("sha256").update(proofText).digest("hex"),
      stderrSha256: createHash("sha256").update("").digest("hex"),
    },
  );
  assert.throws(
    () => validateComputeCertificationProof(
      {
        stdout: JSON.stringify({ ...proof, galactic_cli: "0.0.0-stale" }),
        stderr: "",
      },
      "sync_toolchain",
    ),
    (error) => error.code === "INVALID_PROBE_OUTPUT",
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Galactic-Worker-Version": CANDIDATE_API_VERSION_ID,
    },
  });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function settingsView(
  enabled,
  revision,
  limits,
  allowedTools = enabled ? ["browser", "shell"] : [],
) {
  return {
    revision: String(revision),
    settings: {
      enabled,
      profile: "developer-v1",
      allowedTools,
      secretBindings: [],
      authorityRules: [],
      limits,
      manifestCeiling: {
        enabled: true,
        profile: "developer-v1",
        tools: ["browser", "shell"],
        secrets: [],
      },
    },
  };
}

function invocation(functionName, result, receiptId) {
  return jsonResponse({
    success: true,
    functionName,
    result,
    receiptId,
    error: null,
  });
}

function computeIdentity(runId, receiptId, tools, status, async) {
  return {
    async,
    run_id: runId,
    receipt_id: receiptId,
    status,
    profile: "developer-v1",
    tools,
    created_at: CREATED_AT,
  };
}

function ownerRun(runId, functionName, artifacts = []) {
  return {
    runId,
    status: "completed",
    agentId: AGENT_ID,
    agentName: "Compute Certification",
    functionName,
    createdAt: CREATED_AT,
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT,
    exitCode: 0,
    infraFailure: null,
    artifacts,
    cancellable: false,
  };
}

function config(overrides = {}) {
  return {
    profile: "probe",
    target: "production",
    apiBase: API_BASE,
    candidateSha: CANDIDATE_SHA,
    workflowRunId: WORKFLOW_RUN_ID,
    marker: MARKER,
    agentId: AGENT_ID,
    ownerAccessToken: OWNER_TOKEN,
    evidencePath: "/tmp/compute-certification-production.json",
    runIdsPath: "/tmp/compute-certification-run-ids-production.json",
    cleanupOnly: false,
    ...overrides,
  };
}

test("derives only a pinned target/profile and private evidence paths", () => {
  const result = computeCertificationConfigFromEnv({
    COMPUTE_CERTIFICATION_PROFILE: "production-canary",
    GALACTIC_SMOKE_TARGET: "production",
    COMPUTE_RELEASE_SHA: CANDIDATE_SHA,
    COMPUTE_RELEASE_RUN_ID: WORKFLOW_RUN_ID,
    GALACTIC_SMOKE_APP_ID: AGENT_ID,
    GALACTIC_OWNER_ACCESS_TOKEN: OWNER_TOKEN,
    COMPUTE_RELEASE_EVIDENCE_DIR: "/tmp/compute-certification",
    COMPUTE_CERTIFICATION_API_VERSION_ID: CANDIDATE_API_VERSION_ID,
  });
  assert.equal(result.apiBase, API_BASE);
  assert.equal(result.marker, MARKER);
  assert.equal(
    result.evidencePath,
    "/tmp/compute-certification/compute-certification-production.json",
  );
  assert.equal(
    result.runIdsPath,
    "/tmp/compute-certification/compute-certification-run-ids-production.json",
  );
  assert.equal(Object.hasOwn(result, "certificationToken"), false);
  assert.equal(result.apiVersionId, CANDIDATE_API_VERSION_ID);
});

test("reserves the cold-start envelope only for synchronous certification starts", () => {
  const synchronous = new Set([
    "sync_toolchain",
    "exit_23",
    "raw_tcp_denied",
  ]);
  for (const scenario of COMPUTE_CERTIFICATION_SCENARIOS) {
    assert.equal(
      computeCertificationStartRequestTimeoutMs(scenario),
      synchronous.has(scenario) ? 300_000 : 20_000,
      scenario,
    );
  }

  assert.equal(
    computeCertificationStartRequestTimeoutMs(
      "sync_toolchain",
      360_000,
      300_000,
    ),
    360_000,
  );
});

test("fails closed on a malformed API version override", () => {
  assert.throws(
    () => computeCertificationConfigFromEnv({
      COMPUTE_CERTIFICATION_PROFILE: "production-canary",
      GALACTIC_SMOKE_TARGET: "production",
      COMPUTE_RELEASE_SHA: CANDIDATE_SHA,
      COMPUTE_RELEASE_RUN_ID: WORKFLOW_RUN_ID,
      GALACTIC_SMOKE_APP_ID: AGENT_ID,
      GALACTIC_OWNER_ACCESS_TOKEN: OWNER_TOKEN,
      COMPUTE_RELEASE_EVIDENCE_DIR: "/tmp/compute-certification",
      COMPUTE_CERTIFICATION_API_VERSION_ID: 'bad\" , injected="value',
    }),
    (error) => error.code === "INVALID_CONFIGURATION",
  );
});

test("fails closed when profile and target do not match", () => {
  assert.throws(
    () => computeCertificationConfigFromEnv({
      COMPUTE_CERTIFICATION_PROFILE: "staging-full",
      GALACTIC_SMOKE_TARGET: "production",
      COMPUTE_RELEASE_SHA: CANDIDATE_SHA,
      COMPUTE_RELEASE_RUN_ID: WORKFLOW_RUN_ID,
      GALACTIC_SMOKE_APP_ID: AGENT_ID,
      GALACTIC_OWNER_ACCESS_TOKEN: OWNER_TOKEN,
      COMPUTE_RELEASE_EVIDENCE_DIR: "/tmp/compute-certification",
    }),
    (error) => error.code === "INVALID_CONFIGURATION",
  );
});

test("pins lifecycle and browser probe profiles to production", () => {
  const base = {
    GALACTIC_SMOKE_TARGET: "production",
    COMPUTE_RELEASE_SHA: CANDIDATE_SHA,
    COMPUTE_RELEASE_RUN_ID: WORKFLOW_RUN_ID,
    GALACTIC_SMOKE_APP_ID: AGENT_ID,
    GALACTIC_OWNER_ACCESS_TOKEN: OWNER_TOKEN,
    COMPUTE_RELEASE_EVIDENCE_DIR: "/tmp/compute-certification",
  };
  assert.equal(
    computeCertificationConfigFromEnv({
      ...base,
      COMPUTE_CERTIFICATION_PROFILE: "probe-lifecycle",
    }).profile,
    "probe-lifecycle",
  );
  assert.throws(
    () => computeCertificationConfigFromEnv({
      ...base,
      COMPUTE_CERTIFICATION_PROFILE: "probe-lifecycle",
      GALACTIC_SMOKE_TARGET: "staging",
    }),
    (error) => error.code === "INVALID_CONFIGURATION",
  );
  assert.throws(
    () => computeCertificationConfigFromEnv({
      ...base,
      COMPUTE_CERTIFICATION_PROFILE: "probe",
      GALACTIC_SMOKE_TARGET: "staging",
    }),
    (error) => error.code === "INVALID_CONFIGURATION",
  );
});

test("requires the async marker digest instead of trusting verified=true", () => {
  assert.throws(
    () => validateComputeCertificationProof({
      stdout: JSON.stringify({
        schema_version: 1,
        scenario: "async_echo",
        verified: true,
      }),
      stderr: "",
    }, "async_echo", { marker: MARKER }),
    (error) => error.code === "INVALID_PROBE_OUTPUT",
  );
});

test("accepts fail-closed literal transport denial but requires the control-plane host gate", () => {
  const proof = {
    schema_version: 1,
    scenario: "https_egress_boundaries",
    verified: true,
    public_https_ok: true,
    private_denied: true,
    private_denial_mode: "transport_exit_7",
    metadata_denied: true,
    metadata_denial_mode: "http_520",
    control_plane_denied: true,
    control_plane_denial_mode: "http_520",
  };
  assert.match(
    validateComputeCertificationProof({
      stdout: JSON.stringify(proof),
      stderr: "",
    }, "https_egress_boundaries").stdoutSha256,
    /^[0-9a-f]{64}$/u,
  );

  assert.throws(
    () => validateComputeCertificationProof({
      stdout: JSON.stringify({
        ...proof,
        control_plane_denial_mode: "transport_exit_7",
      }),
      stderr: "",
    }, "https_egress_boundaries"),
    (error) => error.code === "INVALID_PROBE_OUTPUT",
  );
  assert.throws(
    () => validateComputeCertificationProof({
      stdout: JSON.stringify({
        ...proof,
        private_denial_mode: "transport_exit_6",
      }),
      stderr: "",
    }, "https_egress_boundaries"),
    (error) => error.code === "INVALID_PROBE_OUTPUT",
  );
});

test("the HTTPS egress fixture records narrow denial modes and rejects a transport-only control-plane result", () => {
  const fixedTargets = [
    'target=""',
    'for argument in "$@"; do target="$argument"; done',
    'case "$target" in',
    '  https://example.com/) printf 200; return 0 ;;',
    '  http://127.0.0.1/) printf 000; return 7 ;;',
    '  http://169.254.169.254/latest/meta-data/) printf 520; return 0 ;;',
    '  https://api.connectgalactic.com/health) printf 520; return 0 ;;',
    '  *) printf 000; return 6 ;;',
    "esac",
  ].join("\n");
  const success = runHttpsEgressFixture(fixedTargets);
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout), {
    schema_version: 1,
    scenario: "https_egress_boundaries",
    verified: true,
    public_https_ok: true,
    private_denied: true,
    private_denial_mode: "transport_exit_7",
    metadata_denied: true,
    metadata_denial_mode: "http_520",
    control_plane_denied: true,
    control_plane_denial_mode: "http_520",
  });

  const controlPlaneTransportOnly = runHttpsEgressFixture(
    fixedTargets.replace(
      "https://api.connectgalactic.com/health) printf 520; return 0",
      "https://api.connectgalactic.com/health) printf 000; return 7",
    ),
  );
  assert.equal(controlPlaneTransportOnly.status, 92);

  const reachablePrivateTarget = runHttpsEgressFixture(
    fixedTargets.replace(
      "http://127.0.0.1/) printf 000; return 7",
      "http://127.0.0.1/) printf 200; return 0",
    ),
  );
  assert.equal(reachablePrivateTarget.status, 90);
});

test("the raw transport fixture requires payload escape rather than a local TCP handshake", () => {
  const deniedPrelude = [
    "getent() { return 0; }",
    'timeout() { shift; "$@"; }',
    "ssh() { return 255; }",
  ].join("\n");
  const denied = runRawTcpFixture(deniedPrelude);
  assert.equal(denied.status, 0, denied.stderr);
  assert.deepEqual(JSON.parse(denied.stdout), {
    schema_version: 1,
    scenario: "raw_tcp_denied",
    verified: true,
    raw_tcp_denied: true,
    probe_method: "ssh_banner_absence",
    ssh_over_443_host: "ssh.github.com",
    ssh_over_443_denied: true,
    ssh_port_22_host: "github.com",
    ssh_port_22_denied: true,
  });

  const sshOver443Escape = runRawTcpFixture([
    "getent() { return 0; }",
    'timeout() { shift; "$@"; }',
    'ssh() { previous=""; for argument in "$@"; do if [ "$previous" = "-p" ] && [ "$argument" = "443" ]; then printf \'debug1: Remote protocol version 2.0, remote software version GitHub\\n\'; fi; previous="$argument"; done; return 255; }',
  ].join("\n"));
  assert.equal(sshOver443Escape.status, 91);

  const sshPort22Escape = runRawTcpFixture([
    "getent() { return 0; }",
    'timeout() { shift; "$@"; }',
    'ssh() { previous=""; for argument in "$@"; do if [ "$previous" = "-p" ] && [ "$argument" = "22" ]; then printf \'debug1: Server host key: ssh-ed25519 SHA256:fixture\\n\'; fi; previous="$argument"; done; return 255; }',
  ].join("\n"));
  assert.equal(sshPort22Escape.status, 90);

  const unexpectedProbeFailure = runRawTcpFixture([
    "getent() { return 0; }",
    'timeout() { return 127; }',
  ].join("\n"));
  assert.equal(unexpectedProbeFailure.status, 92);

  const dnsFailure = runRawTcpFixture("getent() { return 2; }");
  assert.equal(dnsFailure.status, 93);
});

test("raw transport proof is bound to the fixed SSH payload probe", () => {
  const script = computeFixtureScript("RAW_TCP_SCRIPT");
  assert.match(script, /probe_ssh_banner ssh\.github\.com 443 91/u);
  assert.match(script, /probe_ssh_banner github\.com 22 90/u);
  assert.doesNotMatch(script, /\bnc\s+-z\b/u);

  const proof = {
    schema_version: 1,
    scenario: "raw_tcp_denied",
    verified: true,
    raw_tcp_denied: true,
    probe_method: "ssh_banner_absence",
    ssh_over_443_host: "ssh.github.com",
    ssh_over_443_denied: true,
    ssh_port_22_host: "github.com",
    ssh_port_22_denied: true,
  };
  assert.match(
    validateComputeCertificationProof({
      stdout: JSON.stringify(proof),
      stderr: "",
    }, "raw_tcp_denied").stdoutSha256,
    /^[0-9a-f]{64}$/u,
  );
  for (const drift of [
    { probe_method: "connect_only" },
    { ssh_over_443_host: "example.com" },
    { ssh_over_443_denied: false },
    { ssh_port_22_host: "example.com" },
    { ssh_port_22_denied: false },
  ]) {
    assert.throws(
      () => validateComputeCertificationProof({
        stdout: JSON.stringify({ ...proof, ...drift }),
        stderr: "",
      }, "raw_tcp_denied"),
      (error) => error.code === "INVALID_PROBE_OUTPUT",
    );
  }
});

test("cross-binds producer and consumer proofs to the deterministic fixture", () => {
  const producer = validateComputeCertificationProof({
    stdout: JSON.stringify({
      schema_version: 1,
      scenario: "artifact_producer",
      verified: true,
      artifact_sha256: COMPUTE_CERTIFICATION_ARTIFACT_SHA256,
      artifact_size_bytes: 61,
    }),
    stderr: "",
  }, "artifact_producer");
  assert.match(producer.stdoutSha256, /^[0-9a-f]{64}$/u);

  assert.throws(
    () => validateComputeCertificationProof({
      stdout: JSON.stringify({
        schema_version: 1,
        scenario: "artifact_consumer",
        verified: true,
        input_sha256: "f".repeat(64),
        input_size_bytes: 61,
      }),
      stderr: "",
    }, "artifact_consumer", {
      expectedArtifactSha256: COMPUTE_CERTIFICATION_ARTIFACT_SHA256,
    }),
    (error) => error.code === "INVALID_PROBE_OUTPUT",
  );
});

test("classifies bounded runtime failures without retaining stderr", () => {
  const secret = "owner-secret-must-not-enter-evidence";
  const diagnostic = classifyComputeRuntimeFailure(
    `page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://example.com/?token=${secret}`,
  );
  assert.deepEqual(diagnostic, {
    failure_class: "tls_certificate",
    runtime_error_code: "ERR_CERT_AUTHORITY_INVALID",
  });
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  assert.deepEqual(
    classifyComputeRuntimeFailure(
      "browserType.launch: Executable doesn't exist at /missing/chrome",
    ),
    { failure_class: "browser_launch" },
  );
});

test("timeout certification requires the canonical deadline terminal reason", () => {
  const terminal = {
    ...computeIdentity(
      ASYNC_RUN_ID,
      ASYNC_RECEIPT_ID,
      ["shell"],
      "failed",
      false,
    ),
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    stdout: "",
    stderr: "",
    artifacts: [],
  };
  const expected = {
    scenario: "timeout",
    runId: ASYNC_RUN_ID,
    receiptId: ASYNC_RECEIPT_ID,
    status: "failed",
    exitCode: null,
    parseProof: false,
    stderrEmpty: false,
    errorPrefix: "deadline_exceeded:",
  };

  assert.throws(
    () => validateTerminalPublicRun({
      ...terminal,
      error: "internal_error: synthetic infrastructure failure",
    }, expected),
    (error) => error.code === "INVALID_COMPUTE_RESULT",
  );
  assert.equal(
    validateTerminalPublicRun({
      ...terminal,
      error: "deadline_exceeded: compute execution deadline exceeded",
    }, expected).status,
    "failed",
  );
});

test("waits for the exact Compute body to be running before cancellation", async () => {
  let ownerReads = 0;
  const runningStatusReceipt = "00000000-0000-4000-8000-000000000403";
  const activeOwnerRun = (status, startedAt) => ({
    ...ownerRun(ASYNC_RUN_ID, COMPUTE_CERTIFICATION_FUNCTION),
    status,
    startedAt,
    finishedAt: null,
    exitCode: null,
    cancellable: true,
  });
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.includes("/compute/runs?limit=100")) {
      ownerReads += 1;
      return jsonResponse({
        runs: [ownerReads === 1
          ? activeOwnerRun("queued", null)
          : activeOwnerRun("running", STARTED_AT)],
        next_cursor: null,
      });
    }
    if (url.endsWith(`/functions/${COMPUTE_CERTIFICATION_FUNCTION}/run`)) {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.args, { action: "status", run_id: ASYNC_RUN_ID });
      return invocation(COMPUTE_CERTIFICATION_FUNCTION, {
        ...computeIdentity(
          ASYNC_RUN_ID,
          ASYNC_RECEIPT_ID,
          ["shell"],
          "running",
          false,
        ),
        started_at: STARTED_AT,
      }, runningStatusReceipt);
    }
    throw new Error(`Unexpected cancellation-start request: ${url}`);
  };
  let clock = Date.parse("2026-08-04T12:00:00.000Z");
  const observedStates = ["queued"];
  const proof = await waitForCancellableBodyStart({
    fetchImpl,
    apiBase: API_BASE,
    ownerAccessToken: OWNER_TOKEN,
    agentId: AGENT_ID,
    requestTimeoutMs: 1_000,
  }, {
    scenario: "cancellable",
    runId: ASYNC_RUN_ID,
    receiptId: ASYNC_RECEIPT_ID,
    agentId: AGENT_ID,
    functionName: COMPUTE_CERTIFICATION_FUNCTION,
  }, {
    now: () => clock,
    scenarioTimeoutMs: 5_000,
    pollIntervalMs: 1,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  }, observedStates);

  assert.equal(ownerReads, 2);
  assert.deepEqual(observedStates, ["queued", "running"]);
  assert.deepEqual(proof, {
    startedAt: STARTED_AT,
    startedStatusCallReceiptId: runningStatusReceipt,
  });
});

test("restores the fixed Policy Pillar baseline during recovery", async () => {
  let currentPolicy = "off";
  let revision = 7;
  const writes = [];
  const policyView = () => ({
    functionName: COMPUTE_POLICY_PROBE_FUNCTION,
    policy: currentPolicy,
    revision: String(revision),
    declaredReleaseId: "release-1",
    declarationHash: "declaration-hash-1",
  });
  const routine = {
    id: "99999999-9999-4999-8999-999999999999",
    name: COMPUTE_POLICY_ROUTINE_NAME,
    status: "paused",
    activeRunCount: 0,
    recentRuns: [],
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url.endsWith(`/agents/${AGENT_ID}/routines`) && method === "GET") {
      return jsonResponse({ revision: "routine-revision-1", routines: [routine] });
    }
    if (url.endsWith(`/agents/${AGENT_ID}/policies`) && method === "GET") {
      return jsonResponse({ policies: [policyView()] });
    }
    if (
      url.endsWith(
        `/agents/${AGENT_ID}/policies/${COMPUTE_POLICY_PROBE_FUNCTION}`,
      ) && method === "PUT"
    ) {
      const body = JSON.parse(init.body);
      writes.push(body);
      assert.equal(body.expectedRevision, String(revision));
      currentPolicy = body.policy;
      revision += 1;
      return jsonResponse({ policy: policyView() });
    }
    throw new Error(`Unexpected policy cleanup request: ${method} ${url}`);
  };

  const cleanup = await ensurePolicyCleanup({
    fetchImpl,
    apiBase: API_BASE,
    ownerAccessToken: OWNER_TOKEN,
    agentId: AGENT_ID,
    requestTimeoutMs: 1_000,
  }, { force: true });

  assert.equal(currentPolicy, COMPUTE_POLICY_BASELINE);
  assert.equal(cleanup.policy.policy, COMPUTE_POLICY_BASELINE);
  assert.equal(writes.length, 1);
});

test("refuses an active Policy Pillar routine before enabling Compute", async () => {
  const calls = [];
  const limits = {
    maxTimeoutMs: 60_000,
    maxConcurrency: 1,
    maxArtifactBytes: 1_048_576,
    maxArtifacts: 2,
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("/compute/settings") && method === "GET") {
      return jsonResponse(settingsView(false, 1, limits));
    }
    if (url.endsWith("/functions/fixture_identity/run") && method === "POST") {
      return invocation("fixture_identity", {
        fixture: "galactic-compute-certification",
        schema_version: 1,
        scenarios: [...COMPUTE_CERTIFICATION_SCENARIOS],
        deterministic_artifact_sha256: COMPUTE_CERTIFICATION_ARTIFACT_SHA256,
      }, "00000000-0000-4000-8000-000000000700");
    }
    if (url.endsWith(`/agents/${AGENT_ID}/policies`) && method === "GET") {
      return jsonResponse({ policies: [{
        functionName: COMPUTE_POLICY_PROBE_FUNCTION,
        policy: "free",
        revision: "policy-revision-1",
        declaredReleaseId: "release-1",
        declarationHash: "declaration-hash-1",
      }] });
    }
    if (url.endsWith(`/agents/${AGENT_ID}/routines`) && method === "GET") {
      return jsonResponse({
        revision: "routine-revision-1",
        routines: [{
          id: POLICY_ROUTINE_ID,
          name: COMPUTE_POLICY_ROUTINE_NAME,
          status: "active",
          activeRunCount: 0,
          recentRuns: [],
        }],
      });
    }
    if (url.includes("/compute/runs?limit=100") && method === "GET") {
      return jsonResponse({ runs: [], next_cursor: null });
    }
    throw new Error(`Unexpected active-routine preflight request: ${method} ${url}`);
  };

  await assert.rejects(
    runComputeCertificationSuite(config({
      profile: "production-canary",
    }), {
      fetchImpl,
      writeEvidence: async () => undefined,
    }),
    (error) => error.code === "POLICY_PROBE_NOT_READY",
  );
  assert.equal(
    calls.some((call) =>
      call.method === "PUT" && call.url.endsWith("/compute/settings")
    ),
    false,
  );
  assert.equal(calls.some((call) => call.method !== "GET" &&
    !call.url.endsWith("/functions/fixture_identity/run")), false);
});

test("fails closed on exact active routine work hidden beyond recent history", async () => {
  const calls = [];
  const limits = {
    maxTimeoutMs: 60_000,
    maxConcurrency: 1,
    maxArtifactBytes: 1_048_576,
    maxArtifacts: 2,
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("/compute/settings") && method === "GET") {
      return jsonResponse(settingsView(false, 1, limits));
    }
    if (url.endsWith("/functions/fixture_identity/run") && method === "POST") {
      return invocation("fixture_identity", {
        fixture: "galactic-compute-certification",
        schema_version: 1,
        scenarios: [...COMPUTE_CERTIFICATION_SCENARIOS],
        deterministic_artifact_sha256: COMPUTE_CERTIFICATION_ARTIFACT_SHA256,
      }, "00000000-0000-4000-8000-000000000702");
    }
    if (url.endsWith(`/agents/${AGENT_ID}/policies`) && method === "GET") {
      return jsonResponse({ policies: [{
        functionName: COMPUTE_POLICY_PROBE_FUNCTION,
        policy: COMPUTE_POLICY_BASELINE,
        revision: "policy-revision-1",
        declaredReleaseId: "release-1",
        declarationHash: "declaration-hash-1",
      }] });
    }
    if (url.endsWith(`/agents/${AGENT_ID}/routines`) && method === "GET") {
      return jsonResponse({
        revision: "routine-revision-1",
        routines: [{
          id: POLICY_ROUTINE_ID,
          name: COMPUTE_POLICY_ROUTINE_NAME,
          status: "paused",
          activeRunCount: 1,
          recentRuns: Array.from({ length: 5 }, (_, index) => ({
            id: `00000000-0000-4000-8000-${String(index + 800).padStart(12, "0")}`,
            status: "succeeded",
          })),
        }],
      });
    }
    if (url.includes("/compute/runs?limit=100") && method === "GET") {
      return jsonResponse({ runs: [], next_cursor: null });
    }
    throw new Error(`Unexpected hidden-active-run request: ${method} ${url}`);
  };

  await assert.rejects(
    runComputeCertificationSuite(config({ profile: "production-canary" }), {
      fetchImpl,
      writeEvidence: async () => undefined,
    }),
    (error) => error.code === "POLICY_PROBE_NOT_READY",
  );
  assert.equal(
    calls.some((call) =>
      call.method === "PUT" && call.url.endsWith("/compute/settings")
    ),
    false,
  );
});

test("normal cleanup never overwrites concurrently changed Compute settings", async () => {
  let enabled = false;
  let revision = 1;
  let currentLimits = {
    maxTimeoutMs: 60_000,
    maxConcurrency: 1,
    maxArtifactBytes: 1_048_576,
    maxArtifacts: 2,
  };
  let settingsWrites = 0;
  const written = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url.endsWith("/compute/settings") && method === "GET") {
      return jsonResponse(settingsView(enabled, revision, currentLimits));
    }
    if (url.endsWith("/compute/settings") && method === "PUT") {
      settingsWrites += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.expectedRevision, String(revision));
      enabled = body.settings.enabled;
      currentLimits = body.settings.limits;
      revision += 1;
      return jsonResponse(settingsView(enabled, revision, currentLimits));
    }
    if (url.endsWith("/functions/fixture_identity/run") && method === "POST") {
      return invocation("fixture_identity", {
        fixture: "galactic-compute-certification",
        schema_version: 1,
        scenarios: [...COMPUTE_CERTIFICATION_SCENARIOS],
        deterministic_artifact_sha256: COMPUTE_CERTIFICATION_ARTIFACT_SHA256,
      }, "00000000-0000-4000-8000-000000000703");
    }
    if (
      url.endsWith(`/functions/${COMPUTE_CERTIFICATION_FUNCTION}/run`) &&
      method === "POST"
    ) {
      // Simulate an owner CAS write after certification enabled the fixture.
      revision += 1;
      currentLimits = { ...currentLimits, maxArtifacts: 1 };
      return jsonResponse({ code: "synthetic_scenario_failure" }, 500);
    }
    if (url.includes("/compute/runs?limit=100") && method === "GET") {
      return jsonResponse({ runs: [], next_cursor: null });
    }
    throw new Error(`Unexpected Compute-settings drift request: ${method} ${url}`);
  };

  await assert.rejects(
    runComputeCertificationSuite(config(), {
      fetchImpl,
      writeEvidence: async (path, value) => written.push({ path, value }),
    }),
    (error) =>
      error.code === "HTTP_ERROR" && error.stage === "compute_start",
  );
  assert.equal(enabled, true);
  assert.equal(settingsWrites, 1);
  assert.deepEqual(written[1].value.failure, {
    code: "HTTP_ERROR",
    stage: "compute_start",
    http_status: 500,
    cleanup_failures: ["compute_policy", "compute_policy_fence"],
  });
});

test("normal cleanup preserves a concurrently changed function policy", async () => {
  let settingsReads = 0;
  let policyReads = 0;
  let policyWrites = 0;
  const written = [];
  const limits = {
    maxTimeoutMs: 60_000,
    maxConcurrency: 1,
    maxArtifactBytes: 1_048_576,
    maxArtifacts: 2,
  };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url.endsWith("/compute/settings") && method === "GET") {
      settingsReads += 1;
      return jsonResponse(settingsView(false, 1, limits));
    }
    if (url.endsWith("/compute/settings") && method === "PUT") {
      return jsonResponse({ code: "synthetic_enable_failure" }, 500);
    }
    if (url.endsWith("/functions/fixture_identity/run") && method === "POST") {
      return invocation("fixture_identity", {
        fixture: "galactic-compute-certification",
        schema_version: 1,
        scenarios: [...COMPUTE_CERTIFICATION_SCENARIOS],
        deterministic_artifact_sha256: COMPUTE_CERTIFICATION_ARTIFACT_SHA256,
      }, "00000000-0000-4000-8000-000000000701");
    }
    if (url.endsWith(`/agents/${AGENT_ID}/policies`) && method === "GET") {
      policyReads += 1;
      const drifted = policyReads > 1;
      return jsonResponse({ policies: [{
        functionName: COMPUTE_POLICY_PROBE_FUNCTION,
        policy: drifted ? "off" : "free",
        revision: drifted ? "policy-revision-owner" : "policy-revision-1",
        declaredReleaseId: "release-1",
        declarationHash: "declaration-hash-1",
      }] });
    }
    if (
      url.includes(`/policies/${COMPUTE_POLICY_PROBE_FUNCTION}`) &&
      method === "PUT"
    ) {
      policyWrites += 1;
      throw new Error("Concurrent owner policy must not be overwritten");
    }
    if (url.endsWith(`/agents/${AGENT_ID}/routines`) && method === "GET") {
      return jsonResponse({
        revision: "routine-revision-1",
        routines: [{
          id: POLICY_ROUTINE_ID,
          name: COMPUTE_POLICY_ROUTINE_NAME,
          status: "paused",
          activeRunCount: 0,
          recentRuns: [],
        }],
      });
    }
    if (url.includes("/compute/runs?limit=100") && method === "GET") {
      return jsonResponse({ runs: [], next_cursor: null });
    }
    throw new Error(`Unexpected policy-drift request: ${method} ${url}`);
  };

  await assert.rejects(
    runComputeCertificationSuite(config({
      profile: "production-canary",
    }), {
      fetchImpl,
      writeEvidence: async (path, value) => written.push({ path, value }),
    }),
    (error) => error.code === "POLICY_PROBE_NOT_READY",
  );
  assert.equal(settingsReads, 3);
  assert.equal(policyWrites, 0);
  assert.deepEqual(written[1].value.failure, {
    code: "POLICY_PROBE_NOT_READY",
    stage: null,
    http_status: null,
    cleanup_failures: ["policy_baseline"],
  });
});

test("normal cleanup never pauses a concurrently changed routine", async () => {
  let routineActions = 0;
  let policyReads = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url.endsWith(`/agents/${AGENT_ID}/routines`) && method === "GET") {
      return jsonResponse({
        revision: "routine-revision-owner",
        routines: [{
          id: POLICY_ROUTINE_ID,
          name: COMPUTE_POLICY_ROUTINE_NAME,
          status: "active",
          activeRunCount: 0,
          recentRuns: [],
        }],
      });
    }
    if (url.includes(`/routines/${POLICY_ROUTINE_ID}/actions`)) {
      routineActions += 1;
      throw new Error("Concurrent owner routine must not be paused");
    }
    if (url.endsWith(`/agents/${AGENT_ID}/policies`) && method === "GET") {
      policyReads += 1;
      return jsonResponse({ policies: [] });
    }
    throw new Error(`Unexpected routine-drift request: ${method} ${url}`);
  };

  await assert.rejects(
    ensurePolicyCleanup({
      fetchImpl,
      apiBase: API_BASE,
      ownerAccessToken: OWNER_TOKEN,
      agentId: AGENT_ID,
      requestTimeoutMs: 1_000,
    }, {
      ownership: {
        policyRevision: "policy-revision-1",
        routineRevision: "routine-revision-1",
        routineId: POLICY_ROUTINE_ID,
      },
    }),
    (error) => error.code === "POLICY_CLEANUP_CONFLICT",
  );
  assert.equal(routineActions, 0);
  assert.equal(policyReads, 0);
});

test("cleanup-only discovers, cancels, and drains orphan fixture work", async () => {
  let cancelled = false;
  let policy = "off";
  let policyRevision = 1;
  let cancellationCalls = 0;
  const limits = {
    maxTimeoutMs: 60_000,
    maxConcurrency: 1,
    maxArtifactBytes: 1_048_576,
    maxArtifacts: 2,
  };
  const orphanRun = () => ({
    ...ownerRun(ASYNC_RUN_ID, COMPUTE_POLICY_PROBE_FUNCTION),
    status: cancelled ? "cancelled" : "running",
    startedAt: STARTED_AT,
    finishedAt: cancelled ? FINISHED_AT : null,
    exitCode: null,
    cancellable: !cancelled,
  });
  const policyView = () => ({
    functionName: COMPUTE_POLICY_PROBE_FUNCTION,
    policy,
    revision: `policy-revision-${policyRevision}`,
    declaredReleaseId: "release-1",
    declarationHash: "declaration-hash-1",
  });
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    if (url.endsWith("/compute/settings") && method === "GET") {
      return jsonResponse(settingsView(false, 3, limits));
    }
    if (url.endsWith(`/agents/${AGENT_ID}/routines`) && method === "GET") {
      return jsonResponse({
        revision: "routine-revision-1",
        routines: [{
          id: POLICY_ROUTINE_ID,
          name: COMPUTE_POLICY_ROUTINE_NAME,
          status: "paused",
          activeRunCount: cancelled ? 0 : 1,
          recentRuns: [{
            id: POLICY_ROUTINE_RUN_ID,
            status: cancelled ? "failed" : "running",
          }],
        }],
      });
    }
    if (url.endsWith(`/agents/${AGENT_ID}/policies`) && method === "GET") {
      return jsonResponse({ policies: [policyView()] });
    }
    if (
      url.includes(`/policies/${COMPUTE_POLICY_PROBE_FUNCTION}`) &&
      method === "PUT"
    ) {
      const body = JSON.parse(init.body);
      assert.equal(body.expectedRevision, policyView().revision);
      policy = body.policy;
      policyRevision += 1;
      return jsonResponse({ policy: policyView() });
    }
    if (url.includes("/compute/runs?limit=100") && method === "GET") {
      if (!url.includes("cursor=page_2")) {
        return jsonResponse({ runs: [], next_cursor: "page_2" });
      }
      return jsonResponse({ runs: [orphanRun()], next_cursor: null });
    }
    if (url.endsWith(`/compute/runs/${ASYNC_RUN_ID}/cancel`) && method === "POST") {
      cancellationCalls += 1;
      cancelled = true;
      return jsonResponse({
        error: "Compute state changed; refresh and retry",
        code: "COMPUTE_CANCELLATION_PENDING",
      }, 409);
    }
    throw new Error(`Unexpected cleanup-only request: ${method} ${url}`);
  };
  const written = [];
  const evidence = await runComputeCertificationSuite(config({
    profile: "production-canary",
    cleanupOnly: true,
  }), {
    fetchImpl,
    pollIntervalMs: 1,
    writeEvidence: async (path, value) => written.push({ path, value }),
  });

  assert.equal(evidence.verified, true);
  assert.equal(evidence.cleanup.active_compute_runs_remaining, 0);
  assert.equal(evidence.cleanup.active_routine_runs_remaining, 0);
  assert.equal(policy, COMPUTE_POLICY_BASELINE);
  assert.equal(cancelled, true);
  assert.equal(cancellationCalls, 1);
  assert.equal(written.length, 2);
});

test("certifies admitted owner-visible probes and always disables the fixture", async () => {
  const browserBytes = new Map([
    ["output/browser-https.png", new TextEncoder().encode("fixed-png")],
    [
      "output/browser-https.json",
      new TextEncoder().encode('{"verified":true}\n'),
    ],
  ]);
  const browserArtifacts = [
    [ARTIFACT_ONE_ID, "output/browser-https.png"],
    [ARTIFACT_TWO_ID, "output/browser-https.json"],
  ].map(([id, path]) => ({
    artifact_id: id,
    path,
    size_bytes: browserBytes.get(path).byteLength,
    sha256: digest(browserBytes.get(path)),
    expires_at: EXPIRES_AT,
  }));
  const ownerArtifacts = browserArtifacts.map((artifact) => ({
    id: artifact.artifact_id,
    name: artifact.path,
    sizeBytes: artifact.size_bytes,
    expiresAt: artifact.expires_at,
    url:
      `/api/launch/agents/${AGENT_ID}/compute/runs/${BROWSER_RUN_ID}/artifacts/${artifact.artifact_id}`,
  }));
  const runs = {
    async_echo: {
      runId: ASYNC_RUN_ID,
      receiptId: ASYNC_RECEIPT_ID,
      tools: ["shell"],
      proof: {
        schema_version: 1,
        scenario: "async_echo",
        verified: true,
        marker_sha256: digest(Buffer.from(MARKER)),
        marker_length: Buffer.byteLength(MARKER),
      },
      artifacts: [],
    },
    browser_https: {
      runId: BROWSER_RUN_ID,
      receiptId: BROWSER_RECEIPT_ID,
      tools: ["browser", "shell"],
      proof: {
        schema_version: 1,
        scenario: "browser_https",
        verified: true,
        final_url: "https://example.com/",
        title: "Example Domain",
        browser_version: "152.0.7977.8",
        tls_verified: true,
      },
      artifacts: browserArtifacts,
    },
  };
  const limits = {
    maxTimeoutMs: 60_000,
    maxConcurrency: 1,
    maxArtifactBytes: 1_048_576,
    maxArtifacts: 2,
  };
  let enabled = false;
  let revision = 0;
  let allowedTools = [];
  let currentLimits = limits;
  let callIndex = 3;
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body === undefined ? null : JSON.parse(init.body);
    calls.push({ url, method, body, headers: new Headers(init.headers) });

    if (url.endsWith("/compute/settings") && method === "GET") {
      return jsonResponse(settingsView(
        enabled,
        revision,
        currentLimits,
        allowedTools,
      ));
    }
    if (url.endsWith("/compute/settings") && method === "PUT") {
      assert.equal(body.expectedRevision, String(revision));
      enabled = body.settings.enabled;
      allowedTools = body.settings.allowedTools;
      currentLimits = body.settings.limits;
      revision += 1;
      return jsonResponse(settingsView(
        enabled,
        revision,
        body.settings.limits,
        body.settings.allowedTools,
      ));
    }
    const functionMatch = url.match(/\/functions\/([^/]+)\/run$/u);
    if (functionMatch && method === "POST") {
      const functionName = functionMatch[1];
      const callReceiptId = `00000000-0000-4000-8000-${String(callIndex++).padStart(12, "0")}`;
      if (functionName === "fixture_identity") {
        return invocation(functionName, {
          fixture: "galactic-compute-certification",
          schema_version: 1,
          scenarios: [...COMPUTE_CERTIFICATION_SCENARIOS],
          deterministic_artifact_sha256:
            COMPUTE_CERTIFICATION_ARTIFACT_SHA256,
        }, callReceiptId);
      }
      assert.equal(functionName, COMPUTE_CERTIFICATION_FUNCTION);
      if (body.args.action === "start") {
        const scenario = body.args.scenario;
        const run = runs[scenario];
        return invocation(functionName, computeIdentity(
          run.runId,
          run.receiptId,
          run.tools,
          "queued",
          true,
        ), callReceiptId);
      }
      const run = Object.values(runs).find((item) =>
        item.runId === body.args.run_id
      );
      return invocation(functionName, {
        ...computeIdentity(
          run.runId,
          run.receiptId,
          run.tools,
          "completed",
          false,
        ),
        started_at: STARTED_AT,
        finished_at: FINISHED_AT,
        exit_code: 0,
        stdout: `${JSON.stringify(run.proof)}\n`,
        stderr: "",
        artifacts: run.artifacts,
      }, callReceiptId);
    }
    if (url.includes("/compute/runs?limit=100")) {
      return jsonResponse({
        runs: [
          ownerRun(ASYNC_RUN_ID, COMPUTE_CERTIFICATION_FUNCTION),
          ownerRun(
            BROWSER_RUN_ID,
            COMPUTE_CERTIFICATION_FUNCTION,
            ownerArtifacts,
          ),
        ],
        next_cursor: null,
      });
    }
    const artifact = ownerArtifacts.find((item) =>
      url.endsWith(item.url)
    );
    if (artifact) {
      return new Response(browserBytes.get(artifact.name), {
        headers: {
          "X-Galactic-Worker-Version": CANDIDATE_API_VERSION_ID,
        },
      });
    }
    throw new Error(`Unexpected certification request: ${method} ${url}`);
  };
  const written = [];
  let clock = Date.parse("2026-08-04T12:00:00.000Z");
  const evidence = await runComputeCertificationSuite(config({
    apiVersionId: CANDIDATE_API_VERSION_ID,
  }), {
    fetchImpl,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    pollIntervalMs: 1,
    writeEvidence: async (path, value) => written.push({ path, value }),
  });

  assert.equal(evidence.verified, true);
  assert.deepEqual(
    evidence.scenarios.map((scenario) => scenario.scenario),
    ["async_echo", "browser_https"],
  );
  assert.equal(evidence.cleanup.compute_policy_disabled, true);
  assert.equal(enabled, false);
  assert.equal(written.length, 2);
  assert.match(written[0].path, /run-ids-production\.json$/u);
  assert.match(written[1].path, /certification-production\.json$/u);
  assert.deepEqual(written[0].value.run_ids, [ASYNC_RUN_ID, BROWSER_RUN_ID]);
  assert.equal(JSON.stringify(written).includes(OWNER_TOKEN), false);
  assert.equal(
    calls.every((call) =>
      call.headers.get("authorization") === `Bearer ${OWNER_TOKEN}` &&
      call.headers.get("cloudflare-workers-version-overrides") ===
        PRODUCTION_VERSION_OVERRIDE
    ),
    true,
  );
});

test("captures a failed terminal runtime before rejecting certification", async () => {
  const leakedStderr =
    "page.goto: net::ERR_CERT_AUTHORITY_INVALID private-runtime-detail";
  const limits = {
    maxTimeoutMs: 60_000,
    maxConcurrency: 1,
    maxArtifactBytes: 1_048_576,
    maxArtifacts: 2,
  };
  let enabled = false;
  let revision = 0;
  let allowedTools = [];
  let currentLimits = limits;
  let callIndex = 900;
  const statusScenarios = [];
  let browserStatusReads = 0;
  const written = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body === undefined ? null : JSON.parse(init.body);
    if (url.endsWith("/compute/settings") && method === "GET") {
      return jsonResponse(settingsView(
        enabled,
        revision,
        currentLimits,
        allowedTools,
      ));
    }
    if (url.endsWith("/compute/settings") && method === "PUT") {
      assert.equal(body.expectedRevision, String(revision));
      enabled = body.settings.enabled;
      allowedTools = body.settings.allowedTools;
      currentLimits = body.settings.limits;
      revision += 1;
      return jsonResponse(settingsView(
        enabled,
        revision,
        currentLimits,
        allowedTools,
      ));
    }
    const functionMatch = url.match(/\/functions\/([^/]+)\/run$/u);
    if (functionMatch && method === "POST") {
      const functionName = functionMatch[1];
      const callReceiptId =
        `00000000-0000-4000-8000-${String(callIndex++).padStart(12, "0")}`;
      if (functionName === "fixture_identity") {
        return invocation(functionName, {
          fixture: "galactic-compute-certification",
          schema_version: 1,
          scenarios: [...COMPUTE_CERTIFICATION_SCENARIOS],
          deterministic_artifact_sha256:
            COMPUTE_CERTIFICATION_ARTIFACT_SHA256,
        }, callReceiptId);
      }
      assert.equal(functionName, COMPUTE_CERTIFICATION_FUNCTION);
      if (body.args.action === "start") {
        const isBrowser = body.args.scenario === "browser_https";
        return invocation(functionName, computeIdentity(
          isBrowser ? BROWSER_RUN_ID : ASYNC_RUN_ID,
          isBrowser ? BROWSER_RECEIPT_ID : ASYNC_RECEIPT_ID,
          isBrowser ? ["browser", "shell"] : ["shell"],
          "queued",
          true,
        ), callReceiptId);
      }
      assert.equal(body.args.action, "status");
      const isBrowser = body.args.run_id === BROWSER_RUN_ID;
      statusScenarios.push(isBrowser ? "browser_https" : "async_echo");
      const proof = {
        schema_version: 1,
        scenario: "async_echo",
        verified: true,
        marker_sha256: digest(Buffer.from(MARKER)),
        marker_length: Buffer.byteLength(MARKER),
      };
      const terminalIdentity = computeIdentity(
        isBrowser ? BROWSER_RUN_ID : ASYNC_RUN_ID,
        isBrowser ? BROWSER_RECEIPT_ID : ASYNC_RECEIPT_ID,
        isBrowser ? ["browser", "shell"] : ["shell"],
        "completed",
        false,
      );
      if (isBrowser) delete terminalIdentity.async;
      if (isBrowser && browserStatusReads++ === 0) {
        return invocation(functionName, {
          ...terminalIdentity,
          status: "settlement_pending",
          started_at: STARTED_AT,
          finished_at: FINISHED_AT,
          exit_code: 1,
          artifacts: [],
        }, callReceiptId);
      }
      return invocation(functionName, {
        ...terminalIdentity,
        started_at: STARTED_AT,
        finished_at: FINISHED_AT,
        exit_code: isBrowser ? 1 : 0,
        stdout: isBrowser ? "" : `${JSON.stringify(proof)}\n`,
        stderr: isBrowser ? leakedStderr : "",
        artifacts: [],
      }, callReceiptId);
    }
    if (url.includes("/compute/runs?limit=100")) {
      return jsonResponse({
        runs: [
          ownerRun(ASYNC_RUN_ID, COMPUTE_CERTIFICATION_FUNCTION),
          {
            ...ownerRun(BROWSER_RUN_ID, COMPUTE_CERTIFICATION_FUNCTION),
            exitCode: 1,
          },
        ],
        next_cursor: null,
      });
    }
    throw new Error(`Unexpected failed certification request: ${method} ${url}`);
  };

  await assert.rejects(
    runComputeCertificationSuite(config({ profile: "probe" }), {
      fetchImpl,
      pollIntervalMs: 1,
      writeEvidence: async (path, value) => written.push({ path, value }),
    }),
    (error) =>
      error.code === "SCENARIO_RUNTIME_FAILED" &&
      error.stage === "scenario_browser_https",
  );

  assert.equal(enabled, false);
  assert.deepEqual(statusScenarios, [
    "async_echo",
    "browser_https",
    "browser_https",
  ]);
  assert.equal(written.length, 2);
  assert.deepEqual(written[0].value.run_ids, [ASYNC_RUN_ID, BROWSER_RUN_ID]);
  const runtimeDiagnostic = written[1].value.failure.runtime_diagnostic;
  const {
    start_call_receipt_id: startCallReceiptId,
    status_call_receipt_id: statusCallReceiptId,
    ...stableDiagnostic
  } = runtimeDiagnostic;
  assert.deepEqual(stableDiagnostic, {
    scenario: "browser_https",
    run_id: BROWSER_RUN_ID,
    receipt_id: BROWSER_RECEIPT_ID,
    expected_status: "completed",
    expected_exit_code: 0,
    owner_status: "completed",
    owner_exit_code: 1,
    status: "completed",
    exit_code: 1,
    projection_converged: true,
    public_run_id_matches: true,
    public_receipt_id_matches: true,
    public_status_matches_owner: true,
    public_exit_code_valid: true,
    owner_exit_code_valid: true,
    public_exit_code_matches_owner: true,
    owner_infra_failure_code: null,
    owner_infra_failure_retryable: null,
    stdout_present: true,
    stdout_bytes: 0,
    stdout_sha256: digest(Buffer.from("")),
    stderr_present: true,
    stderr_bytes: Buffer.byteLength(leakedStderr),
    stderr_sha256: digest(Buffer.from(leakedStderr)),
    public_error_present: false,
    public_error_bytes: null,
    public_error_sha256: null,
    public_artifact_count: 0,
    owner_artifact_count: 0,
    created_at: CREATED_AT,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    failure_class: "tls_certificate",
    runtime_error_code: "ERR_CERT_AUTHORITY_INVALID",
  });
  assert.match(startCallReceiptId, /^[0-9a-f-]{36}$/u);
  assert.match(statusCallReceiptId, /^[0-9a-f-]{36}$/u);
  const serialized = JSON.stringify(written);
  assert.equal(serialized.includes(OWNER_TOKEN), false);
  assert.equal(serialized.includes("private-runtime-detail"), false);
});

test("retains safe terminal diagnostics when projections have not converged", () => {
  const privateError = "artifact upload failed for secret://private-object";
  const privateOwnerMessage = "private R2 credential detail";
  const diagnostic = failedScenarioRuntimeDiagnostic(
    {
      ...computeIdentity(
        BROWSER_RUN_ID,
        BROWSER_RECEIPT_ID,
        ["browser", "shell"],
        "settlement_pending",
        false,
      ),
      error: privateError,
      artifacts: [],
    },
    {
      scenario: "browser_https",
      runId: BROWSER_RUN_ID,
      receiptId: BROWSER_RECEIPT_ID,
      status: "completed",
      exitCode: 0,
    },
    {
      ...ownerRun(BROWSER_RUN_ID, COMPUTE_CERTIFICATION_FUNCTION),
      status: "failed",
      exitCode: null,
      infraFailure: {
        code: "ARTIFACT_ERROR",
        message: privateOwnerMessage,
        retryable: true,
      },
    },
    {
      startCallReceiptId: "00000000-0000-4000-8000-000000000901",
      statusCallReceiptId: "00000000-0000-4000-8000-000000000902",
    },
  );

  assert.equal(diagnostic.projection_converged, false);
  assert.equal(diagnostic.owner_status, "failed");
  assert.equal(diagnostic.status, "settlement_pending");
  assert.equal(diagnostic.owner_infra_failure_code, "ARTIFACT_ERROR");
  assert.equal(diagnostic.owner_infra_failure_retryable, true);
  assert.equal(diagnostic.stdout_present, false);
  assert.equal(diagnostic.stdout_bytes, null);
  assert.equal(diagnostic.stderr_present, false);
  assert.equal(diagnostic.stderr_sha256, null);
  assert.equal(diagnostic.public_error_present, true);
  assert.equal(
    diagnostic.public_error_sha256,
    digest(Buffer.from(privateError)),
  );
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes(privateError), false);
  assert.equal(serialized.includes(privateOwnerMessage), false);
});

test("fails closed when Cloudflare serves a version other than the pinned candidate", () => {
  for (const headers of [
    {},
    {
      "X-Galactic-Worker-Version":
        "87654321-4321-4321-4321-cba987654321",
    },
  ]) {
    assert.throws(
      () => assertPinnedApiVersionResponse(
        new Response(null, { status: 500, headers }),
        CANDIDATE_API_VERSION_ID,
        { label: "sync_toolchain start", stage: "scenario_sync_toolchain" },
      ),
      (error) =>
        error.code === "API_VERSION_MISMATCH" &&
        error.stage === "scenario_sync_toolchain" &&
        error.httpStatus === 500,
    );
  }
});
