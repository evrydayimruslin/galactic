#!/usr/bin/env node
/**
 * Production-valid Galactic Compute certification suite.
 *
 * The owner-session wrapper supplies a short-lived account bearer. This
 * runner exercises only the fixed `examples/compute-certification` Agent,
 * records public/owner-safe facts, and always restores its Compute policy to
 * disabled. Private economic conservation is deliberately certified in a
 * separate workflow step through POST /api/admin/compute/certification.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  cloudflareWorkerVersionOverride,
  cloudflareWorkerVersionId,
  COMPUTE_CERTIFICATION_API_VERSION_ID_ENV,
  GALACTIC_WORKER_VERSION_HEADER,
} from "./cloudflare-worker-version-override.mjs";

export const COMPUTE_CERTIFICATION_KIND =
  "galactic_compute_deployed_certification";
export const COMPUTE_CERTIFICATION_SCHEMA_VERSION = 1;
export const COMPUTE_CERTIFICATION_FUNCTION = "run_compute_certification";
export const COMPUTE_POLICY_PROBE_FUNCTION = "run_compute_policy_probe";
export const COMPUTE_POLICY_ROUTINE_NAME = "Compute policy certification";
export const COMPUTE_POLICY_BASELINE = "free";
export const COMPUTE_CERTIFICATION_FIXTURE_IDENTITY = "fixture_identity";
export const COMPUTE_POLICY_OFF_ROUTINE_ERROR_CODE = "policy_off";

export const COMPUTE_CERTIFICATION_SCENARIOS = Object.freeze([
  "sync_toolchain",
  "async_echo",
  "browser_https",
  "artifact_producer",
  "artifact_consumer",
  "exit_23",
  "timeout",
  "cancellable",
  "https_egress_boundaries",
  "raw_tcp_denied",
]);

export const COMPUTE_CERTIFICATION_ARTIFACT_SHA256 =
  "6ad9b8ea5280658dc4b229a2b6180d530c4d3824b541d218266ea6049e8b763b";

const EXPECTED_ARTIFACT_PATHS = Object.freeze({
  artifact_producer: Object.freeze(["output/certification-artifact.bin"]),
  artifact_consumer: Object.freeze([
    "output/certification-artifact.bin",
    "output/artifact-consumer.json",
  ]),
  browser_https: Object.freeze([
    "output/browser-https.png",
    "output/browser-https.json",
  ]),
});

export const COMPUTE_CERTIFICATION_TARGETS = Object.freeze({
  staging: Object.freeze({
    name: "staging",
    apiBase: "https://ultralight-api-staging.rgn4jz429m.workers.dev",
    apiWorker: "ultralight-api-staging",
  }),
  production: Object.freeze({
    name: "production",
    apiBase: "https://api.connectgalactic.com",
    apiWorker: "ultralight-api",
  }),
});

export const COMPUTE_CERTIFICATION_PROFILES = Object.freeze({
  "staging-full": Object.freeze({
    target: "staging",
    scenarios: COMPUTE_CERTIFICATION_SCENARIOS,
    policyPillar: true,
  }),
  "production-canary": Object.freeze({
    target: "production",
    scenarios: COMPUTE_CERTIFICATION_SCENARIOS,
    policyPillar: true,
  }),
  "production-global": Object.freeze({
    target: "production",
    scenarios: COMPUTE_CERTIFICATION_SCENARIOS,
    policyPillar: true,
  }),
  "probe-lifecycle": Object.freeze({
    target: "production",
    scenarios: Object.freeze(["async_echo"]),
    policyPillar: false,
  }),
  // The hourly browser probe also includes the lifecycle scenario so every
  // probe artifact independently proves an admitted, settled Compute body.
  probe: Object.freeze({
    target: "production",
    scenarios: Object.freeze(["async_echo", "browser_https"]),
    policyPillar: false,
  }),
});

const OWNER_ACCESS_TOKEN_ENV = "GALACTIC_OWNER_ACCESS_TOKEN";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const GIT_SHA_RE = /^[0-9a-f]{40}$/u;
const WORKFLOW_RUN_ID_RE = /^[1-9][0-9]{0,19}$/u;
const REVISION_RE = /^(0|[1-9][0-9]*)$/u;
const SEMVER_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const ACTIVE_STATUSES = new Set(["queued", "reserving", "starting", "running"]);
const ACTIVE_ROUTINE_STATUSES = new Set(["queued", "running"]);
const FIXTURE_COMPUTE_FUNCTIONS = new Set([
  COMPUTE_CERTIFICATION_FUNCTION,
  COMPUTE_POLICY_PROBE_FUNCTION,
]);
const OWNER_STATUSES = new Set([
  ...ACTIVE_STATUSES,
  "completed",
  "failed",
  "cancelled",
  "settlement_pending",
]);
const OWNER_SETTLED_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_SCENARIO_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const PUBLIC_TERMINAL_CONVERGENCE_TIMEOUT_MS = 60_000;
const MAX_OWNER_RUN_PAGES = 10;
const RUNTIME_ERROR_CODE_RE =
  /\b(?:net::)?(ERR_[A-Z0-9_]{1,64}|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/u;
export const EXPECTED_GALACTIC_CLI_VERSION = (() => {
  const cliPackage = JSON.parse(
    readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8"),
  );
  if (
    typeof cliPackage.version !== "string" ||
    !SEMVER_RE.test(cliPackage.version)
  ) {
    throw new Error(
      "cli/package.json must contain a canonical Galactic CLI version.",
    );
  }
  return cliPackage.version;
})();
const CERTIFICATION_LIMITS = Object.freeze({
  maxTimeoutMs: 120_000,
  maxConcurrency: 2,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxArtifacts: 4,
});

export class ComputeCertificationSuiteError extends Error {
  constructor(
    code,
    message,
    { stage = null, httpStatus = null, runtimeDiagnostic = null } = {},
  ) {
    super(message);
    this.name = "ComputeCertificationSuiteError";
    this.code = code;
    this.stage = stage;
    this.httpStatus = httpStatus;
    this.runtimeDiagnostic = runtimeDiagnostic;
  }
}

function fail(code, message, options) {
  throw new ComputeCertificationSuiteError(code, message, options);
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RESPONSE", `${label} must be an object.`);
  }
  return value;
}

function requiredString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) fail("INVALID_CONFIGURATION", `${label} is required.`);
  return normalized;
}

function canonicalUuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    fail("INVALID_RESPONSE", `${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("INVALID_RESPONSE", `${label} must be an ISO timestamp.`);
  }
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactStringArray(value, expected, label) {
  if (
    !Array.isArray(value) || value.length !== expected.length ||
    value.some((item, index) => item !== expected[index])
  ) {
    fail("INVALID_RESPONSE", `${label} did not match the fixed fixture.`);
  }
}

function sleepMs(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function buildComputeCertificationMarker(candidateSha, workflowRunId) {
  if (!GIT_SHA_RE.test(String(candidateSha ?? ""))) {
    fail("INVALID_CONFIGURATION", "COMPUTE_RELEASE_SHA must be a Git SHA.");
  }
  if (!WORKFLOW_RUN_ID_RE.test(String(workflowRunId ?? ""))) {
    fail(
      "INVALID_CONFIGURATION",
      "COMPUTE_RELEASE_RUN_ID must be a positive workflow run id.",
    );
  }
  return `galactic-compute-certification-v1:${candidateSha}:${workflowRunId}\n`;
}

export function computeCertificationConfigFromEnv(env = process.env, argv = []) {
  if (argv.length !== 0 && !(argv.length === 1 && argv[0] === "--cleanup-only")) {
    fail(
      "INVALID_CONFIGURATION",
      "Usage: compute-certification-suite.mjs [--cleanup-only]",
    );
  }
  const profileName = requiredString(
    env.COMPUTE_CERTIFICATION_PROFILE,
    "COMPUTE_CERTIFICATION_PROFILE",
  );
  const profile = COMPUTE_CERTIFICATION_PROFILES[profileName];
  if (!profile) {
    fail("INVALID_CONFIGURATION", "Compute certification profile is invalid.");
  }
  const targetName = requiredString(env.GALACTIC_SMOKE_TARGET, "GALACTIC_SMOKE_TARGET")
    .toLowerCase();
  const target = COMPUTE_CERTIFICATION_TARGETS[targetName];
  if (!target || (profile.target !== null && profile.target !== target.name)) {
    fail(
      "INVALID_CONFIGURATION",
      "Certification profile and target do not match.",
    );
  }
  const candidateSha = requiredString(env.COMPUTE_RELEASE_SHA, "COMPUTE_RELEASE_SHA");
  const workflowRunId = requiredString(
    env.COMPUTE_RELEASE_RUN_ID,
    "COMPUTE_RELEASE_RUN_ID",
  );
  const agentId = canonicalUuid(
    requiredString(env.GALACTIC_SMOKE_APP_ID, "GALACTIC_SMOKE_APP_ID"),
    "GALACTIC_SMOKE_APP_ID",
  );
  const evidenceDirectory = resolve(requiredString(
    env.COMPUTE_RELEASE_EVIDENCE_DIR,
    "COMPUTE_RELEASE_EVIDENCE_DIR",
  ));
  let apiVersionId = null;
  try {
    apiVersionId = cloudflareWorkerVersionId(
      env[COMPUTE_CERTIFICATION_API_VERSION_ID_ENV],
    );
  } catch {
    fail(
      "INVALID_CONFIGURATION",
      `${COMPUTE_CERTIFICATION_API_VERSION_ID_ENV} is invalid.`,
    );
  }
  return {
    profile: profileName,
    target: target.name,
    apiBase: target.apiBase,
    candidateSha,
    workflowRunId,
    marker: buildComputeCertificationMarker(candidateSha, workflowRunId),
    agentId,
    ownerAccessToken: requiredString(
      env[OWNER_ACCESS_TOKEN_ENV],
      OWNER_ACCESS_TOKEN_ENV,
    ),
    apiVersionId,
    evidencePath: resolve(
      evidenceDirectory,
      `compute-certification-${target.name}.json`,
    ),
    runIdsPath: resolve(
      evidenceDirectory,
      `compute-certification-run-ids-${target.name}.json`,
    ),
    cleanupOnly: argv[0] === "--cleanup-only",
  };
}

async function boundedBody(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail("INVALID_RESPONSE", "Certification response was too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function assertPinnedApiVersionResponse(
  response,
  expectedVersionId,
  { label = "Certification", stage = null } = {},
) {
  if (expectedVersionId == null) return;
  const servedVersionId = response?.headers?.get?.(
    GALACTIC_WORKER_VERSION_HEADER,
  ) ?? null;
  if (servedVersionId !== expectedVersionId) {
    fail(
      "API_VERSION_MISMATCH",
      `${label} was not served by the pinned API version.`,
      { stage, httpStatus: Number(response?.status) || 0 },
    );
  }
}

async function request({
  context,
  path,
  method = "GET",
  body,
  label,
  stage,
  bytes = false,
  acceptedError = null,
}) {
  let response;
  try {
    response = await context.fetchImpl(`${context.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${context.ownerAccessToken}`,
        Accept: bytes ? "application/octet-stream" : "application/json",
        ...(context.apiVersionOverride === null
          ? {}
          : {
            "Cloudflare-Workers-Version-Overrides":
              context.apiVersionOverride,
          }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(context.requestTimeoutMs),
    });
  } catch {
    fail("REQUEST_FAILED", `${label} request failed.`, { stage });
  }
  try {
    assertPinnedApiVersionResponse(response, context.apiVersionId, {
      label,
      stage,
    });
  } catch (error) {
    await response?.body?.cancel?.().catch(() => undefined);
    throw error;
  }
  if (!response?.ok) {
    if (
      acceptedError && response?.status === acceptedError.status
    ) {
      const payload = await boundedBody(response);
      try {
        const parsed = JSON.parse(new TextDecoder().decode(payload));
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          parsed.code === acceptedError.code &&
          typeof parsed.error === "string" &&
          Object.keys(parsed).every((key) => key === "code" || key === "error")
        ) {
          return { accepted_error: acceptedError.code };
        }
      } catch {
        // Fall through to the sanitized HTTP failure.
      }
    }
    await response?.body?.cancel?.().catch(() => undefined);
    fail("HTTP_ERROR", `${label} failed (HTTP ${response?.status ?? 0}).`, {
      stage,
      httpStatus: Number(response?.status) || 0,
    });
  }
  const payload = await boundedBody(response);
  if (bytes) return payload;
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    fail("INVALID_RESPONSE", `${label} returned invalid JSON.`, { stage });
  }
}

function validateLimits(value, label) {
  const limits = record(value, label);
  for (const key of [
    "maxTimeoutMs",
    "maxConcurrency",
    "maxArtifactBytes",
    "maxArtifacts",
  ]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) {
      fail("INVALID_RESPONSE", `${label} ${key} is invalid.`);
    }
  }
  return {
    maxTimeoutMs: limits.maxTimeoutMs,
    maxConcurrency: limits.maxConcurrency,
    maxArtifactBytes: limits.maxArtifactBytes,
    maxArtifacts: limits.maxArtifacts,
  };
}

function validateSettings(value, { requireDisabled = false } = {}) {
  const view = record(value, "Compute settings response");
  const settings = record(view.settings, "Compute settings");
  if (!REVISION_RE.test(String(view.revision ?? ""))) {
    fail("INVALID_RESPONSE", "Compute settings revision is invalid.");
  }
  const ceiling = record(settings.manifestCeiling, "Compute manifest ceiling");
  if (ceiling.enabled !== true || ceiling.profile !== "developer-v1") {
    fail("FIXTURE_NOT_READY", "Certification fixture Compute ceiling is disabled.");
  }
  exactStringArray(ceiling.tools, ["browser", "shell"], "manifest tools");
  exactStringArray(ceiling.secrets, [], "manifest secrets");
  if (settings.profile !== "developer-v1" || typeof settings.enabled !== "boolean") {
    fail("INVALID_RESPONSE", "Compute settings are invalid.");
  }
  if (requireDisabled && settings.enabled !== false) {
    fail("FIXTURE_ALREADY_ENABLED", "Certification fixture must start disabled.");
  }
  if (
    !Array.isArray(settings.allowedTools) ||
    settings.allowedTools.some((tool) => tool !== "browser" && tool !== "shell") ||
    new Set(settings.allowedTools).size !== settings.allowedTools.length ||
    (settings.enabled &&
      (settings.allowedTools.length !== 2 ||
        settings.allowedTools[0] !== "browser" || settings.allowedTools[1] !== "shell"))
  ) {
    fail("INVALID_RESPONSE", "Compute allowed tools are invalid.");
  }
  if (!Array.isArray(settings.secretBindings) || settings.secretBindings.length !== 0) {
    fail("INVALID_RESPONSE", "Certification fixture must not bind secrets.");
  }
  if (!Array.isArray(settings.authorityRules) || settings.authorityRules.length !== 0) {
    fail("INVALID_RESPONSE", "Certification fixture must not grant authorities.");
  }
  return {
    revision: String(view.revision),
    enabled: settings.enabled,
    allowedTools: [...settings.allowedTools],
    limits: validateLimits(settings.limits, "Compute limits"),
  };
}

function sameLimits(left, right) {
  return left.maxTimeoutMs === right.maxTimeoutMs &&
    left.maxConcurrency === right.maxConcurrency &&
    left.maxArtifactBytes === right.maxArtifactBytes &&
    left.maxArtifacts === right.maxArtifacts;
}

function sameSettingsState(view, expected) {
  return view.revision === expected.revision &&
    view.enabled === expected.enabled &&
    sameLimits(view.limits, expected.limits) &&
    view.allowedTools.length === expected.allowedTools.length &&
    view.allowedTools.every((tool, index) => tool === expected.allowedTools[index]);
}

function settingsMutation(
  revision,
  enabled,
  limits,
  allowedTools = ["browser", "shell"],
) {
  return {
    expectedRevision: revision,
    ownerConfirmed: true,
    settings: {
      enabled,
      profile: "developer-v1",
      allowedTools: [...allowedTools],
      secretBindings: [],
      authorityRules: [],
      limits: { ...limits },
    },
  };
}

async function readSettings(context) {
  return validateSettings(await request({
    context,
    path: `/api/launch/agents/${context.agentId}/compute/settings`,
    label: "Compute settings lookup",
    stage: "settings_lookup",
  }));
}

async function writeSettings(
  context,
  revision,
  enabled,
  limits,
  allowedTools = ["browser", "shell"],
) {
  const view = validateSettings(await request({
    context,
    path: `/api/launch/agents/${context.agentId}/compute/settings`,
    method: "PUT",
    body: settingsMutation(revision, enabled, limits, allowedTools),
    label: enabled ? "Compute fixture enablement" : "Compute fixture disablement",
    stage: enabled ? "settings_enable" : "settings_disable",
  }));
  if (
    view.enabled !== enabled ||
    !sameLimits(view.limits, limits) ||
    view.allowedTools.length !== allowedTools.length ||
    view.allowedTools.some((tool, index) => tool !== allowedTools[index])
  ) {
    fail("POLICY_MUTATION_FAILED", "Compute policy mutation did not persist.");
  }
  return view;
}

async function invokeFunction(context, functionName, args, label, stage) {
  const payload = record(await request({
    context,
    path: `/api/launch/agents/${context.agentId}/functions/${functionName}/run`,
    method: "POST",
    body: { args },
    label,
    stage,
  }), `${label} response`);
  if (
    payload.success !== true ||
    payload.functionName !== functionName ||
    payload.error !== null
  ) {
    fail("FUNCTION_RUN_FAILED", `${label} did not succeed.`, { stage });
  }
  return {
    callReceiptId: canonicalUuid(payload.receiptId, `${label} call receipt id`),
    result: record(payload.result, `${label} result`),
  };
}

async function invokeFixture(context, args, label, stage) {
  return await invokeFunction(
    context,
    COMPUTE_CERTIFICATION_FUNCTION,
    args,
    label,
    stage,
  );
}

async function validateFixtureIdentity(context) {
  const invocation = await invokeFunction(
    context,
    COMPUTE_CERTIFICATION_FIXTURE_IDENTITY,
    {},
    "Compute certification fixture identity",
    "fixture_identity",
  );
  const identity = invocation.result;
  if (
    identity.fixture !== "galactic-compute-certification" ||
    identity.schema_version !== 1 ||
    identity.deterministic_artifact_sha256 !==
      COMPUTE_CERTIFICATION_ARTIFACT_SHA256
  ) {
    fail("FIXTURE_IDENTITY_MISMATCH", "Certification fixture identity drifted.");
  }
  exactStringArray(
    identity.scenarios,
    COMPUTE_CERTIFICATION_SCENARIOS,
    "certification scenarios",
  );
  return { callReceiptId: invocation.callReceiptId };
}

function validateComputeIdentity(run, label) {
  const runId = canonicalUuid(run.run_id, `${label} run id`);
  const receiptId = canonicalUuid(run.receipt_id, `${label} receipt id`);
  if (run.profile !== "developer-v1") {
    fail("INVALID_COMPUTE_RESULT", `${label} profile is invalid.`);
  }
  if (
    !Array.isArray(run.tools) || run.tools.length < 1 ||
    run.tools.some((tool) => tool !== "browser" && tool !== "shell") ||
    new Set(run.tools).size !== run.tools.length
  ) {
    fail("INVALID_COMPUTE_RESULT", `${label} tools are invalid.`);
  }
  return {
    runId,
    receiptId,
    createdAt: timestamp(run.created_at, `${label} created_at`),
  };
}

function validateStartedResult(value, scenario) {
  const run = record(value, `${scenario} start result`);
  const identity = validateComputeIdentity(run, `${scenario} start`);
  const active = run.async === true && ACTIVE_STATUSES.has(run.status);
  const expectedTerminalStatus = scenarioExpectation(scenario).status;
  const terminalFastPath = run.async === false &&
    scenario !== "cancellable" &&
    (run.status === expectedTerminalStatus || run.status === "settlement_pending");
  if (!active && !terminalFastPath) {
    fail("ADMISSION_NOT_ACCEPTED", `${scenario} returned an invalid start state.`);
  }
  return { ...identity, status: run.status, terminalFastPath, raw: run };
}

async function ownerRunPageResult(
  context,
  cursor = null,
  { activeOnly = false } = {},
) {
  const suffix = cursor === null
    ? ""
    : `&cursor=${encodeURIComponent(cursor)}`;
  const activeSuffix = activeOnly ? "&active=true" : "";
  const payload = record(await request({
    context,
    path:
      `/api/launch/agents/${context.agentId}/compute/runs?limit=100${suffix}${activeSuffix}`,
    label: "Compute owner run lookup",
    stage: "owner_run_lookup",
  }), "Compute owner run response");
  if (
    !Array.isArray(payload.runs) ||
    !(payload.next_cursor === null ||
      typeof payload.next_cursor === "string" &&
        /^[A-Za-z0-9_-]{1,2048}$/u.test(payload.next_cursor))
  ) {
    fail("INVALID_RESPONSE", "Compute owner run response is invalid.");
  }
  return { runs: payload.runs, nextCursor: payload.next_cursor };
}

async function ownerRunPage(context) {
  return (await ownerRunPageResult(context)).runs;
}

async function ownerRunInventory(context, { activeOnly = false } = {}) {
  const runs = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_OWNER_RUN_PAGES; page += 1) {
    const result = await ownerRunPageResult(context, cursor, { activeOnly });
    runs.push(...result.runs);
    if (result.nextCursor === null) return runs;
    if (seenCursors.has(result.nextCursor)) {
      fail("INVALID_RESPONSE", "Compute owner run pagination repeated a cursor.");
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  fail("INVALID_RESPONSE", "Compute owner run inventory exceeded its page bound.");
}

function validateOwnerRun(value, expected) {
  const run = record(value, "Compute owner run");
  for (const privateField of ["receiptId", "receiptUrl", "billingMode", "usage"]) {
    if (Object.hasOwn(run, privateField)) {
      fail(
        "OWNER_PRIVACY_REGRESSION",
        "Compute owner history exposed private accounting.",
      );
    }
  }
  if (
    canonicalUuid(run.runId, "owner run id") !== expected.runId ||
    canonicalUuid(run.agentId, "owner Agent id") !== expected.agentId ||
    run.functionName !== expected.functionName ||
    !OWNER_STATUSES.has(run.status) ||
    typeof run.cancellable !== "boolean" ||
    !Array.isArray(run.artifacts)
  ) {
    fail("INVALID_OWNER_RUN", "Compute owner run projection is invalid.");
  }
  const createdAt = timestamp(run.createdAt, "owner createdAt");
  const startedAt = run.startedAt === null
    ? null
    : timestamp(run.startedAt, "owner startedAt");
  const finishedAt = run.finishedAt === null
    ? null
    : timestamp(run.finishedAt, "owner finishedAt");
  if (
    startedAt !== null && Date.parse(startedAt) < Date.parse(createdAt) ||
    finishedAt !== null &&
      (startedAt === null || Date.parse(finishedAt) < Date.parse(startedAt))
  ) {
    fail("INVALID_OWNER_RUN", "Compute owner timestamps are not monotonic.");
  }
  const artifacts = run.artifacts.map((candidate) => {
    const artifact = record(candidate, "owner artifact");
    const id = canonicalUuid(artifact.id, "owner artifact id");
    if (
      typeof artifact.name !== "string" || !artifact.name ||
      !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 ||
      typeof artifact.url !== "string" ||
      artifact.url !==
        `/api/launch/agents/${expected.agentId}/compute/runs/${expected.runId}/artifacts/${id}`
    ) {
      fail("INVALID_OWNER_RUN", "Compute owner artifact projection is invalid.");
    }
    return {
      id,
      name: artifact.name,
      sizeBytes: artifact.sizeBytes,
      expiresAt: timestamp(artifact.expiresAt, "owner artifact expiresAt"),
      url: artifact.url,
    };
  });
  return {
    runId: expected.runId,
    status: run.status,
    createdAt,
    startedAt,
    finishedAt,
    exitCode: run.exitCode,
    infraFailure: run.infraFailure,
    artifacts,
    cancellable: run.cancellable,
  };
}

async function loadOwnerRun(context, expected, { allPages = false } = {}) {
  const runs = allPages
    ? await ownerRunInventory(context)
    : await ownerRunPage(context);
  const candidate = runs.find((run) => run?.runId === expected.runId);
  return candidate ? validateOwnerRun(candidate, expected) : null;
}

async function waitForOwnerRun(
  context,
  expected,
  {
    terminalStatuses = OWNER_SETTLED_STATUSES,
    timeoutMs,
    pollIntervalMs,
    sleep,
    now,
    observedStates,
    allPages = false,
  },
) {
  const deadline = now() + timeoutMs;
  do {
    const run = await loadOwnerRun(context, expected, { allPages });
    if (run) {
      if (observedStates.at(-1) !== run.status) observedStates.push(run.status);
      if (terminalStatuses.has(run.status)) return run;
    }
    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  } while (now() <= deadline);
  fail("COMPUTE_RUN_TIMEOUT", `${expected.scenario} did not settle in time.`);
}

async function readComputeRun(context, runId, scenario) {
  const checked = await invokeFixture(
    context,
    { action: "status", run_id: runId },
    `${scenario} status`,
    "compute_status",
  );
  const identity = validateComputeIdentity(checked.result, `${scenario} status`);
  if (identity.runId !== runId) {
    fail("INVALID_COMPUTE_RESULT", `${scenario} status changed run identity.`);
  }
  return { ...checked, identity };
}

function publicTerminalProjectionMatches(run, expected, owner) {
  const exitCode = run?.exit_code ?? null;
  return diagnosticUuid(run?.run_id) === expected.runId &&
    diagnosticUuid(run?.receipt_id) === expected.receiptId &&
    OWNER_SETTLED_STATUSES.has(run?.status) &&
    run.status === owner.status &&
    diagnosticExitCodeIsValid(run?.exit_code) &&
    exitCode === (owner.exitCode ?? null);
}

async function waitForPublicTerminalRun(
  context,
  expected,
  owner,
  { scenarioTimeoutMs, pollIntervalMs, sleep, now },
) {
  const deadline = now() + Math.min(
    scenarioTimeoutMs,
    PUBLIC_TERMINAL_CONVERGENCE_TIMEOUT_MS,
  );
  let checked = null;
  do {
    checked = await readComputeRun(context, expected.runId, expected.scenario);
    if (publicTerminalProjectionMatches(checked.result, expected, owner)) {
      return { checked, converged: true };
    }
    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  } while (now() <= deadline);
  return { checked, converged: false };
}

export async function waitForCancellableBodyStart(
  context,
  expected,
  dependencies,
  observedStates,
) {
  const deadline = dependencies.now() + dependencies.scenarioTimeoutMs;
  do {
    const owner = await loadOwnerRun(context, expected);
    if (owner) {
      if (observedStates.at(-1) !== owner.status) {
        observedStates.push(owner.status);
      }
      if (owner.status === "running" && owner.startedAt !== null) {
        const checked = await readComputeRun(
          context,
          expected.runId,
          expected.scenario,
        );
        const publicRun = record(
          checked.result,
          `${expected.scenario} running status`,
        );
        const publicStartedAt = timestamp(
          publicRun.started_at,
          `${expected.scenario} running started_at`,
        );
        if (
          checked.identity.receiptId !== expected.receiptId ||
          publicRun.status !== "running" ||
          owner.startedAt !== publicStartedAt ||
          Date.parse(publicStartedAt) < Date.parse(checked.identity.createdAt) ||
          Object.hasOwn(publicRun, "finished_at")
        ) {
          fail(
            "CANCELLATION_BODY_NOT_STARTED",
            "Cancellation probe did not prove a running Compute body.",
          );
        }
        return {
          startedAt: publicStartedAt,
          startedStatusCallReceiptId: checked.callReceiptId,
        };
      }
      if (!ACTIVE_STATUSES.has(owner.status)) {
        fail(
          "CANCELLATION_BODY_NOT_STARTED",
          "Cancellation probe settled before its Compute body started.",
        );
      }
    }
    if (dependencies.now() >= deadline) break;
    await dependencies.sleep(dependencies.pollIntervalMs);
  } while (dependencies.now() <= deadline);
  fail(
    "CANCELLATION_BODY_NOT_STARTED",
    "Cancellation probe did not enter the running state in time.",
  );
}

function publicArtifacts(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("INVALID_COMPUTE_RESULT", `${label} artifacts are invalid.`);
  }
  return value.map((candidate) => {
    const artifact = record(candidate, `${label} artifact`);
    if (
      typeof artifact.path !== "string" || !artifact.path ||
      !Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes < 0 ||
      typeof artifact.sha256 !== "string" || !SHA256_RE.test(artifact.sha256)
    ) {
      fail("INVALID_COMPUTE_RESULT", `${label} artifact is invalid.`);
    }
    return {
      id: canonicalUuid(artifact.artifact_id, `${label} artifact id`),
      path: artifact.path,
      sizeBytes: artifact.size_bytes,
      sha256: artifact.sha256,
      expiresAt: timestamp(artifact.expires_at, `${label} artifact expiry`),
    };
  });
}

export function validateComputeCertificationProof(
  run,
  scenario,
  { marker = null, expectedArtifactSha256 = null } = {},
) {
  if (typeof run.stdout !== "string") {
    fail("INVALID_PROBE_OUTPUT", `${scenario} did not return stdout.`);
  }
  let proof;
  try {
    proof = JSON.parse(run.stdout.trim());
  } catch {
    fail("INVALID_PROBE_OUTPUT", `${scenario} stdout was not fixed JSON.`);
  }
  const row = record(proof, `${scenario} proof`);
  if (
    row.schema_version !== 1 || row.scenario !== scenario ||
    row.verified !== true
  ) {
    fail("INVALID_PROBE_OUTPUT", `${scenario} proof did not verify.`);
  }
  if (scenario === "sync_toolchain") {
    const expected = {
      python: "3.13.14",
      npm: "12.0.1",
      deno: "2.9.3",
      galactic_cli: EXPECTED_GALACTIC_CLI_VERSION,
      playwright: "1.62.0-alpha-2026-07-20",
      chromium: "152.0.7977.8",
    };
    for (const [name, version] of Object.entries(expected)) {
      if (row[name] !== version) {
        fail("INVALID_PROBE_OUTPUT", `${scenario} ${name} version drifted.`);
      }
    }
  } else if (scenario === "async_echo") {
    if (
      typeof marker !== "string" ||
      row.marker_sha256 !== sha256Text(marker) ||
      row.marker_length !== Buffer.byteLength(marker)
    ) {
      fail("INVALID_PROBE_OUTPUT", "async echo marker proof did not match.");
    }
  } else if (scenario === "browser_https") {
    if (
      row.tls_verified !== true ||
      row.final_url !== "https://example.com/" ||
      row.title !== "Example Domain" ||
      typeof row.browser_version !== "string" ||
      !row.browser_version
    ) {
      fail("INVALID_PROBE_OUTPUT", "browser HTTPS proof is invalid.");
    }
  } else if (scenario === "artifact_producer") {
    if (
      row.artifact_sha256 !== COMPUTE_CERTIFICATION_ARTIFACT_SHA256 ||
      !Number.isSafeInteger(row.artifact_size_bytes) ||
      row.artifact_size_bytes < 1
    ) {
      fail("INVALID_PROBE_OUTPUT", "artifact producer proof is invalid.");
    }
  } else if (scenario === "artifact_consumer") {
    if (
      typeof expectedArtifactSha256 !== "string" ||
      row.input_sha256 !== expectedArtifactSha256 ||
      !Number.isSafeInteger(row.input_size_bytes) ||
      row.input_size_bytes < 1
    ) {
      fail("INVALID_PROBE_OUTPUT", "artifact consumer proof is invalid.");
    }
  } else if (scenario === "exit_23") {
    if (row.expected_exit_code !== 23) {
      fail("INVALID_PROBE_OUTPUT", "exit probe did not prove code 23.");
    }
  } else if (scenario === "https_egress_boundaries") {
    for (const key of [
      "public_https_ok",
      "private_denied",
      "metadata_denied",
      "control_plane_denied",
    ]) {
      if (row[key] !== true) {
        fail("INVALID_PROBE_OUTPUT", `${scenario} did not prove ${key}.`);
      }
    }
    const literalDenialModes = new Set([
      "http_520",
      "transport_exit_7",
      "transport_exit_28",
      "transport_exit_52",
      "transport_exit_56",
    ]);
    for (const key of ["private_denial_mode", "metadata_denial_mode"]) {
      if (!literalDenialModes.has(row[key])) {
        fail("INVALID_PROBE_OUTPUT", `${scenario} returned an invalid ${key}.`);
      }
    }
    if (row.control_plane_denial_mode !== "http_520") {
      fail(
        "INVALID_PROBE_OUTPUT",
        `${scenario} did not prove the control-plane deniedHosts gate.`,
      );
    }
  } else if (scenario === "raw_tcp_denied") {
    if (row.raw_tcp_denied !== true) {
      fail("INVALID_PROBE_OUTPUT", `${scenario} did not prove raw TCP denial.`);
    }
  }
  return {
    stdoutSha256: sha256Text(run.stdout),
    stderrSha256: sha256Text(typeof run.stderr === "string" ? run.stderr : ""),
  };
}

export function validateTerminalPublicRun(run, expected) {
  const identity = validateComputeIdentity(run, `${expected.scenario} terminal`);
  if (identity.runId !== expected.runId || identity.receiptId !== expected.receiptId) {
    fail("INVALID_COMPUTE_RESULT", `${expected.scenario} terminal identity drifted.`);
  }
  const exitCode = run.exit_code ?? null;
  if (run.status !== expected.status || exitCode !== expected.exitCode) {
    fail("INVALID_COMPUTE_RESULT", `${expected.scenario} terminal result is invalid.`);
  }
  if (
    expected.errorPrefix &&
    (typeof run.error !== "string" ||
      !run.error.startsWith(expected.errorPrefix) ||
      run.error.length <= expected.errorPrefix.length)
  ) {
    fail(
      "INVALID_COMPUTE_RESULT",
      `${expected.scenario} terminal reason is invalid.`,
    );
  }
  const startedAt = timestamp(run.started_at, `${expected.scenario} started_at`);
  const finishedAt = timestamp(run.finished_at, `${expected.scenario} finished_at`);
  if (
    Date.parse(startedAt) < Date.parse(identity.createdAt) ||
    Date.parse(finishedAt) < Date.parse(startedAt)
  ) {
    fail("INVALID_COMPUTE_RESULT", `${expected.scenario} timestamps are invalid.`);
  }
  const artifacts = publicArtifacts(run.artifacts, expected.scenario);
  if (artifacts.some((artifact) =>
    Date.parse(artifact.expiresAt) <= Date.parse(finishedAt)
  )) {
    fail("INVALID_COMPUTE_RESULT", `${expected.scenario} artifact already expired.`);
  }
  const proof = expected.parseProof
    ? validateComputeCertificationProof(run, expected.scenario, {
      marker: expected.marker,
      expectedArtifactSha256: expected.expectedArtifactSha256,
    })
    : {
      stdoutSha256: sha256Text(typeof run.stdout === "string" ? run.stdout : ""),
      stderrSha256: sha256Text(typeof run.stderr === "string" ? run.stderr : ""),
    };
  if (expected.stderrEmpty && run.stderr !== "") {
    fail("INVALID_COMPUTE_RESULT", `${expected.scenario} stderr was not empty.`);
  }
  return {
    runId: identity.runId,
    receiptId: identity.receiptId,
    status: run.status,
    exitCode,
    createdAt: identity.createdAt,
    startedAt,
    finishedAt,
    artifacts,
    ...proof,
  };
}

export function classifyComputeRuntimeFailure(stderr) {
  const text = typeof stderr === "string" ? stderr : "";
  const codeMatch = text.match(RUNTIME_ERROR_CODE_RE);
  const runtimeErrorCode = codeMatch?.[1] ?? null;
  let failureClass = "unknown";
  if (
    /ERR_CERT_|CERT_HAS_EXPIRED|certificate (?:authority|verify|verification)|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(?:GET_ISSUER_CERT_LOCALLY|VERIFY_LEAF_SIGNATURE)/iu
      .test(text)
  ) {
    failureClass = "tls_certificate";
  } else if (/ERR_NAME_NOT_RESOLVED|EAI_AGAIN|ENOTFOUND/iu.test(text)) {
    failureClass = "dns";
  } else if (
    /browserType\.launch|chromium\.launch|Executable doesn't exist|Failed to launch|error while loading shared libraries/iu
      .test(text)
  ) {
    failureClass = "browser_launch";
  } else if (
    /ERR_CONNECTION_|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT/iu
      .test(text)
  ) {
    failureClass = "network_connection";
  } else if (/page\.goto|Navigation|Timeout .* exceeded/iu.test(text)) {
    failureClass = "browser_navigation";
  } else if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/iu.test(text)) {
    failureClass = "runtime_dependency";
  } else if (/browser HTTPS probe|browser_https/iu.test(text)) {
    failureClass = "browser_probe";
  }
  return {
    failure_class: failureClass,
    ...(runtimeErrorCode ? { runtime_error_code: runtimeErrorCode } : {}),
  };
}

function diagnosticUuid(value) {
  return typeof value === "string" && UUID_RE.test(value)
    ? value.toLowerCase()
    : null;
}

function diagnosticStatus(value) {
  return typeof value === "string" && OWNER_STATUSES.has(value) ? value : null;
}

function diagnosticExitCode(value) {
  const normalized = value ?? null;
  return diagnosticExitCodeIsValid(value)
    ? normalized
    : null;
}

function diagnosticExitCodeIsValid(value) {
  const normalized = value ?? null;
  return normalized === null || Number.isSafeInteger(normalized);
}

function diagnosticTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function diagnosticText(value) {
  if (typeof value !== "string") {
    return { present: false, bytes: null, sha256: null };
  }
  return {
    present: true,
    bytes: Buffer.byteLength(value),
    sha256: sha256Text(value),
  };
}

function diagnosticFailureCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)
    ? value
    : null;
}

export function failedScenarioRuntimeDiagnostic(
  run,
  expected,
  owner,
  { startCallReceiptId, statusCallReceiptId },
) {
  const publicRun = run !== null && typeof run === "object" && !Array.isArray(run)
    ? run
    : {};
  const ownerRun = owner !== null && typeof owner === "object" && !Array.isArray(owner)
    ? owner
    : {};
  const publicStatus = diagnosticStatus(publicRun.status);
  const publicExitCode = diagnosticExitCode(publicRun.exit_code);
  const publicExitCodeValid = diagnosticExitCodeIsValid(publicRun.exit_code);
  const ownerStatus = diagnosticStatus(ownerRun.status);
  const ownerExitCode = diagnosticExitCode(ownerRun.exitCode);
  const ownerExitCodeValid = diagnosticExitCodeIsValid(ownerRun.exitCode);
  const stdout = diagnosticText(publicRun.stdout);
  const stderr = diagnosticText(publicRun.stderr);
  const publicError = diagnosticText(publicRun.error);
  // The Compute Worker already redacts every lease token and configured
  // secret before persisting this owner-visible terminal error. Emit it only
  // to the protected workflow log when explicitly requested so an operator
  // can diagnose an otherwise opaque hashed failure without weakening the
  // durable release-evidence artifact.
  if (
    process.env.COMPUTE_CERTIFICATION_LOG_SAFE_TERMINAL_ERROR === "1" &&
    typeof publicRun.error === "string"
  ) {
    console.error(`SAFE_COMPUTE_TERMINAL_ERROR: ${publicRun.error}`);
  }
  const infraFailure = ownerRun.infraFailure !== null &&
      typeof ownerRun.infraFailure === "object" &&
      !Array.isArray(ownerRun.infraFailure)
    ? ownerRun.infraFailure
    : null;
  return {
    scenario: expected.scenario,
    run_id: expected.runId,
    receipt_id: expected.receiptId,
    start_call_receipt_id: diagnosticUuid(startCallReceiptId),
    status_call_receipt_id: diagnosticUuid(statusCallReceiptId),
    expected_status: diagnosticStatus(expected.status),
    expected_exit_code: diagnosticExitCode(expected.exitCode),
    owner_status: ownerStatus,
    owner_exit_code: ownerExitCode,
    status: publicStatus,
    exit_code: publicExitCode,
    projection_converged: publicTerminalProjectionMatches(
      publicRun,
      expected,
      ownerRun,
    ),
    public_run_id_matches: diagnosticUuid(publicRun.run_id) === expected.runId,
    public_receipt_id_matches:
      diagnosticUuid(publicRun.receipt_id) === expected.receiptId,
    public_status_matches_owner: publicStatus !== null &&
      publicStatus === ownerStatus,
    public_exit_code_valid: publicExitCodeValid,
    owner_exit_code_valid: ownerExitCodeValid,
    public_exit_code_matches_owner: publicExitCodeValid &&
      ownerExitCodeValid && publicExitCode === ownerExitCode,
    owner_infra_failure_code: diagnosticFailureCode(infraFailure?.code),
    owner_infra_failure_retryable:
      typeof infraFailure?.retryable === "boolean" ? infraFailure.retryable : null,
    stdout_present: stdout.present,
    stdout_bytes: stdout.bytes,
    stdout_sha256: stdout.sha256,
    stderr_present: stderr.present,
    stderr_bytes: stderr.bytes,
    stderr_sha256: stderr.sha256,
    public_error_present: publicError.present,
    public_error_bytes: publicError.bytes,
    public_error_sha256: publicError.sha256,
    public_artifact_count: Array.isArray(publicRun.artifacts)
      ? publicRun.artifacts.length
      : null,
    owner_artifact_count: Array.isArray(ownerRun.artifacts)
      ? ownerRun.artifacts.length
      : null,
    created_at: diagnosticTimestamp(publicRun.created_at),
    started_at: diagnosticTimestamp(publicRun.started_at),
    finished_at: diagnosticTimestamp(publicRun.finished_at),
    ...classifyComputeRuntimeFailure(publicRun.stderr),
  };
}

function scenarioExpectation(scenario) {
  if (scenario === "exit_23") {
    return { status: "completed", exitCode: 23, parseProof: true, stderrEmpty: true };
  }
  if (scenario === "timeout") {
    return {
      status: "failed",
      exitCode: null,
      parseProof: false,
      stderrEmpty: false,
      errorPrefix: "deadline_exceeded:",
      ownerFailureCode: "DEADLINE_EXCEEDED",
    };
  }
  if (scenario === "cancellable") {
    return { status: "cancelled", exitCode: null, parseProof: false, stderrEmpty: false };
  }
  return { status: "completed", exitCode: 0, parseProof: true, stderrEmpty: true };
}

function scenarioStartArgs(scenario, config, producer) {
  if (scenario === "async_echo") {
    return { action: "start", scenario, marker: config.marker };
  }
  if (scenario === "artifact_consumer") {
    if (!producer || !UUID_RE.test(producer.artifactId) || !SHA256_RE.test(producer.sha256)) {
      fail("ARTIFACT_PRODUCER_MISSING", "Artifact consumer lacks producer proof.");
    }
    return {
      action: "start",
      scenario,
      artifact_id: producer.artifactId,
      expected_sha256: producer.sha256,
    };
  }
  return { action: "start", scenario };
}

async function cancelScenario(context, runId, scenario) {
  let first;
  let second;
  for (const [index, label] of [[1, "first"], [2, "replay"]]) {
    const cancelled = await invokeFixture(
      context,
      { action: "cancel", run_id: runId },
      `${scenario} ${label} cancellation`,
      "compute_cancel",
    );
    const identity = validateComputeIdentity(
      cancelled.result,
      `${scenario} ${label} cancellation`,
    );
    if (identity.runId !== runId) {
      fail("INVALID_CANCELLATION", "Cancellation changed Compute run identity.");
    }
    if (
      !OWNER_STATUSES.has(cancelled.result.status) ||
      ACTIVE_STATUSES.has(cancelled.result.status)
    ) {
      fail("INVALID_CANCELLATION", "Cancellation did not return a terminal run.");
    }
    if (index === 1) first = cancelled;
    else second = cancelled;
  }
  if (
    first.result.run_id !== second.result.run_id ||
    first.result.receipt_id !== second.result.receipt_id ||
    first.result.status !== second.result.status
  ) {
    fail("INVALID_CANCELLATION", "Cancellation replay was not idempotent.");
  }
  return {
    firstCallReceiptId: first.callReceiptId,
    replayCallReceiptId: second.callReceiptId,
  };
}

async function downloadAndVerifyArtifact(
  context,
  ownerArtifact,
  publicArtifact,
  expectedRunId,
) {
  if (
    ownerArtifact.id !== publicArtifact.id ||
    ownerArtifact.name !== publicArtifact.path ||
    ownerArtifact.sizeBytes !== publicArtifact.sizeBytes ||
    ownerArtifact.expiresAt !== publicArtifact.expiresAt
  ) {
    fail("ARTIFACT_PROJECTION_MISMATCH", "Artifact projections did not match.");
  }
  const bytes = await request({
    context,
    path: ownerArtifact.url,
    label: "Compute artifact download",
    stage: "artifact_download",
    bytes: true,
  });
  const digest = sha256Bytes(bytes);
  if (
    bytes.byteLength !== publicArtifact.sizeBytes ||
    digest !== publicArtifact.sha256 ||
    !ownerArtifact.url.includes(`/compute/runs/${expectedRunId}/artifacts/`)
  ) {
    fail("ARTIFACT_DOWNLOAD_MISMATCH", "Downloaded artifact failed integrity.");
  }
  return { byteLength: bytes.byteLength, sha256: digest };
}

async function runScenario(context, config, scenario, producer, dependencies) {
  const startedCall = await invokeFixture(
    context,
    scenarioStartArgs(scenario, config, producer),
    `${scenario} start`,
    "compute_start",
  );
  const started = validateStartedResult(startedCall.result, scenario);
  const observedStates = [started.status];
  context.activeRunIds.add(started.runId);
  context.startedRunIds.push(started.runId);
  const expected = {
    scenario,
    runId: started.runId,
    receiptId: started.receiptId,
    agentId: context.agentId,
    functionName: COMPUTE_CERTIFICATION_FUNCTION,
    marker: config.marker,
    expectedArtifactSha256: scenario === "artifact_consumer"
      ? producer?.sha256 ?? null
      : null,
    ...scenarioExpectation(scenario),
  };
  let cancellation = null;
  if (scenario === "cancellable") {
    const startedProof = await waitForCancellableBodyStart(
      context,
      expected,
      dependencies,
      observedStates,
    );
    cancellation = {
      ...startedProof,
      ...await cancelScenario(context, started.runId, scenario),
    };
  }
  const owner = await waitForOwnerRun(context, expected, {
    timeoutMs: dependencies.scenarioTimeoutMs,
    pollIntervalMs: dependencies.pollIntervalMs,
    sleep: dependencies.sleep,
    now: dependencies.now,
    observedStates,
  });
  context.activeRunIds.delete(started.runId);
  if (owner.cancellable !== false) {
    fail("INVALID_OWNER_RUN", `${scenario} owner terminal state is invalid.`);
  }
  const publicProjection = await waitForPublicTerminalRun(
    context,
    expected,
    owner,
    dependencies,
  );
  const checked = publicProjection.checked;
  if (
    owner.status !== expected.status ||
    (owner.exitCode ?? null) !== expected.exitCode
  ) {
    const runtimeDiagnostic = failedScenarioRuntimeDiagnostic(
      checked.result,
      expected,
      owner,
      {
        startCallReceiptId: startedCall.callReceiptId,
        statusCallReceiptId: checked.callReceiptId,
      },
    );
    fail(
      "SCENARIO_RUNTIME_FAILED",
      `${scenario} runtime did not satisfy certification.`,
      { stage: `scenario_${scenario}`, runtimeDiagnostic },
    );
  }
  if (!publicProjection.converged) {
    const runtimeDiagnostic = failedScenarioRuntimeDiagnostic(
      checked?.result,
      expected,
      owner,
      {
        startCallReceiptId: startedCall.callReceiptId,
        statusCallReceiptId: checked?.callReceiptId,
      },
    );
    fail(
      "PUBLIC_TERMINAL_TIMEOUT",
      `${scenario} public terminal projection did not converge.`,
      { stage: `scenario_${scenario}`, runtimeDiagnostic },
    );
  }
  if (expected.ownerFailureCode) {
    if (
      !owner.infraFailure ||
      owner.infraFailure.code !== expected.ownerFailureCode
    ) {
      fail("INVALID_OWNER_RUN", `${scenario} terminal reason is invalid.`);
    }
  } else if (
    expected.status === "completed" && owner.infraFailure !== null ||
    expected.status === "cancelled" && owner.infraFailure !== null
  ) {
    fail("INVALID_OWNER_RUN", `${scenario} reported an infrastructure failure.`);
  }
  const terminal = validateTerminalPublicRun(checked.result, expected);
  let artifactDownload = null;
  let producerProof = null;
  if (scenario === "artifact_producer") {
    if (terminal.artifacts.length !== 1 || owner.artifacts.length !== 1) {
      fail("ARTIFACT_PRODUCER_INVALID", "Producer did not expose one ready artifact.");
    }
    if (
      terminal.artifacts[0].path !== EXPECTED_ARTIFACT_PATHS.artifact_producer[0] ||
      terminal.artifacts[0].sha256 !== COMPUTE_CERTIFICATION_ARTIFACT_SHA256
    ) {
      fail("ARTIFACT_PRODUCER_INVALID", "Producer artifact identity drifted.");
    }
    artifactDownload = await downloadAndVerifyArtifact(
      context,
      owner.artifacts[0],
      terminal.artifacts[0],
      started.runId,
    );
    producerProof = {
      artifactId: terminal.artifacts[0].id,
      sha256: terminal.artifacts[0].sha256,
    };
  } else if (scenario === "browser_https") {
    if (terminal.artifacts.length !== 2 || owner.artifacts.length !== 2) {
      fail(
        "BROWSER_ARTIFACTS_INVALID",
        "Browser probe did not return its screenshot and proof artifacts.",
      );
    }
    const downloads = [];
    exactStringArray(
      terminal.artifacts.map((artifact) => artifact.path).sort(),
      [...EXPECTED_ARTIFACT_PATHS.browser_https].sort(),
      "browser artifact paths",
    );
    for (const publicArtifact of terminal.artifacts) {
      const ownerArtifact = owner.artifacts.find((item) => item.id === publicArtifact.id);
      if (!ownerArtifact) {
        fail("BROWSER_ARTIFACTS_INVALID", "Browser artifact owner projection is missing.");
      }
      downloads.push(await downloadAndVerifyArtifact(
        context,
        ownerArtifact,
        publicArtifact,
        started.runId,
      ));
    }
    artifactDownload = downloads;
  } else if (scenario === "artifact_consumer") {
    if (terminal.artifacts.length !== 2 || owner.artifacts.length !== 2) {
      fail("ARTIFACT_CONSUMER_INVALID", "Consumer did not return two proof artifacts.");
    }
    exactStringArray(
      terminal.artifacts.map((artifact) => artifact.path).sort(),
      [...EXPECTED_ARTIFACT_PATHS.artifact_consumer].sort(),
      "consumer artifact paths",
    );
    const roundTrip = terminal.artifacts.find((artifact) =>
      artifact.path === "output/certification-artifact.bin"
    );
    if (!roundTrip || roundTrip.sha256 !== producer.sha256) {
      fail("ARTIFACT_CONSUMER_INVALID", "Consumer round-trip digest drifted.");
    }
    const downloads = [];
    for (const publicArtifact of terminal.artifacts) {
      const ownerArtifact = owner.artifacts.find((item) => item.id === publicArtifact.id);
      if (!ownerArtifact) {
        fail("ARTIFACT_CONSUMER_INVALID", "Consumer owner artifact is missing.");
      }
      downloads.push(await downloadAndVerifyArtifact(
        context,
        ownerArtifact,
        publicArtifact,
        started.runId,
      ));
    }
    artifactDownload = downloads;
  } else if (terminal.artifacts.length !== 0 || owner.artifacts.length !== 0) {
    fail("UNEXPECTED_ARTIFACT", `${scenario} returned an unexpected artifact.`);
  }

  return {
    evidence: {
      scenario,
      run_id: terminal.runId,
      receipt_id: terminal.receiptId,
      start_call_receipt_id: startedCall.callReceiptId,
      status_call_receipt_id: checked.callReceiptId,
      status: terminal.status,
      exit_code: terminal.exitCode,
      observed_states: observedStates,
      timestamps: {
        created_at: terminal.createdAt,
        started_at: terminal.startedAt,
        finished_at: terminal.finishedAt,
      },
      stdout_sha256: terminal.stdoutSha256,
      stderr_sha256: terminal.stderrSha256,
      artifacts: terminal.artifacts.map((artifact) => ({
        artifact_id: artifact.id,
        path: artifact.path,
        size_bytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        expires_at: artifact.expiresAt,
      })),
      ...(artifactDownload ? { artifact_download: artifactDownload } : {}),
      ...(cancellation ? { cancellation } : {}),
    },
    producerProof,
  };
}

function activeFixtureComputeRuns(runs, context) {
  const active = [];
  for (const candidate of runs) {
    if (
      !FIXTURE_COMPUTE_FUNCTIONS.has(candidate?.functionName) ||
      !ACTIVE_STATUSES.has(candidate?.status)
    ) continue;
    const runId = canonicalUuid(candidate.runId, "active fixture Compute run id");
    active.push({
      ...validateOwnerRun(candidate, {
        runId,
        agentId: context.agentId,
        functionName: candidate.functionName,
      }),
      functionName: candidate.functionName,
    });
  }
  return active;
}

async function discoverActiveFixtureComputeRuns(context) {
  return activeFixtureComputeRuns(
    await ownerRunInventory(context, { activeOnly: true }),
    context,
  );
}

async function assertNoActiveFixtureComputeRuns(context) {
  const active = await discoverActiveFixtureComputeRuns(context);
  if (active.length !== 0) {
    fail("CLEANUP_FAILED", "Active certification Compute runs remain after cleanup.");
  }
  return 0;
}

async function waitForRunToLeaveActiveInventory(
  context,
  runId,
  dependencies,
) {
  const deadline = dependencies.now() + dependencies.cleanupTimeoutMs;
  do {
    const active = await discoverActiveFixtureComputeRuns(context);
    if (!active.some((run) => run.runId === runId)) return;
    if (dependencies.now() >= deadline) break;
    await dependencies.sleep(dependencies.pollIntervalMs);
  } while (dependencies.now() <= deadline);
  fail("CLEANUP_FAILED", "A cancelled certification run remained active.");
}

async function settleActiveRuns(
  context,
  dependencies,
  { discover = false } = {},
) {
  const targets = new Map(
    [...context.activeRunIds].map((runId) => [runId, {
      runId,
      functionName: COMPUTE_CERTIFICATION_FUNCTION,
      recovery: false,
    }]),
  );
  if (discover) {
    for (const run of await discoverActiveFixtureComputeRuns(context)) {
      targets.set(run.runId, {
        runId: run.runId,
        functionName: run.functionName,
        recovery: true,
      });
    }
  }
  const failures = [];
  for (const target of targets.values()) {
    try {
      await request({
        context,
        path:
          `/api/launch/agents/${context.agentId}/compute/runs/${target.runId}/cancel`,
        method: "POST",
        body: {},
        label: "Compute cleanup cancellation",
        stage: "cleanup_cancel",
        acceptedError: {
          status: 409,
          code: "COMPUTE_CANCELLATION_PENDING",
        },
      });
      if (target.recovery) {
        await waitForRunToLeaveActiveInventory(
          context,
          target.runId,
          dependencies,
        );
      } else {
        const observedStates = [];
        await waitForOwnerRun(context, {
          scenario: "cleanup",
          runId: target.runId,
          agentId: context.agentId,
          functionName: target.functionName,
        }, {
          terminalStatuses: OWNER_SETTLED_STATUSES,
          timeoutMs: dependencies.cleanupTimeoutMs,
          pollIntervalMs: dependencies.pollIntervalMs,
          sleep: dependencies.sleep,
          now: dependencies.now,
          observedStates,
        });
      }
      context.activeRunIds.delete(target.runId);
    } catch {
      failures.push(target.runId);
    }
  }
  if (failures.length > 0) {
    fail("CLEANUP_FAILED", "Certification runs did not settle during cleanup.");
  }
}

async function readFunctionPolicies(context) {
  const payload = record(await request({
    context,
    path: `/api/launch/agents/${context.agentId}/policies`,
    label: "Policy Pillar lookup",
    stage: "policy_lookup",
  }), "Policy Pillar response");
  if (!Array.isArray(payload.policies)) {
    fail("POLICY_PROBE_NOT_READY", "Policy Pillar response is invalid.");
  }
  const policy = payload.policies.find((candidate) =>
    candidate?.functionName === COMPUTE_POLICY_PROBE_FUNCTION
  );
  if (!policy) {
    fail("POLICY_PROBE_NOT_READY", "Policy probe function is not declared.");
  }
  if (
    typeof policy.revision !== "string" ||
    typeof policy.declaredReleaseId !== "string" ||
    typeof policy.declarationHash !== "string" ||
    !["off", "ask", "free"].includes(policy.policy)
  ) {
    fail("POLICY_PROBE_NOT_READY", "Policy probe projection is invalid.");
  }
  return policy;
}

async function setFunctionPolicy(context, current, policy) {
  const payload = record(await request({
    context,
    path: `/api/launch/agents/${context.agentId}/policies/${COMPUTE_POLICY_PROBE_FUNCTION}`,
    method: "PUT",
    body: {
      policy,
      expectedRevision: current.revision,
      expectedReleaseId: current.declaredReleaseId,
      expectedDeclarationHash: current.declarationHash,
      idempotencyKey: randomUUID(),
    },
    label: `Policy Pillar ${policy} mutation`,
    stage: "policy_mutation",
  }), "Policy Pillar mutation response");
  const updated = record(payload.policy, "Policy Pillar updated policy");
  if (
    updated.functionName !== COMPUTE_POLICY_PROBE_FUNCTION ||
    updated.policy !== policy ||
    updated.declaredReleaseId !== current.declaredReleaseId ||
    updated.declarationHash !== current.declarationHash ||
    typeof updated.revision !== "string"
  ) {
    fail("POLICY_MUTATION_FAILED", `Policy Pillar did not persist ${policy}.`);
  }
  return updated;
}

async function readRoutines(context) {
  const payload = record(await request({
    context,
    path: `/api/launch/agents/${context.agentId}/routines`,
    label: "Policy probe routine lookup",
    stage: "routine_lookup",
  }), "Policy probe routines response");
  if (typeof payload.revision !== "string" || !Array.isArray(payload.routines)) {
    fail("POLICY_PROBE_NOT_READY", "Policy probe routine response is invalid.");
  }
  const routine = payload.routines.find((candidate) =>
    candidate?.name === COMPUTE_POLICY_ROUTINE_NAME
  );
  if (!routine || !UUID_RE.test(String(routine.id ?? ""))) {
    fail("POLICY_PROBE_NOT_READY", "Managed policy probe routine is missing.");
  }
  if (
    !Array.isArray(routine.recentRuns) ||
    !Number.isSafeInteger(routine.activeRunCount) ||
    routine.activeRunCount < 0
  ) {
    fail("POLICY_PROBE_NOT_READY", "Managed policy probe history is invalid.");
  }
  return { revision: payload.revision, routine };
}

function activePolicyRoutineRuns(current) {
  return current.routine.recentRuns.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      fail("POLICY_PROBE_NOT_READY", "Managed policy probe history is invalid.");
    }
    if (!ACTIVE_ROUTINE_STATUSES.has(candidate.status)) return false;
    canonicalUuid(candidate.id, "active policy routine run id");
    return true;
  });
}

function activePolicyRoutineRunCount(current) {
  const visibleActiveRuns = activePolicyRoutineRuns(current).length;
  if (visibleActiveRuns > current.routine.activeRunCount) {
    fail("POLICY_PROBE_NOT_READY", "Policy routine active-run count is invalid.");
  }
  return current.routine.activeRunCount;
}

function assertPolicyRoutineReady(current, expectedRevision = null) {
  if (
    current.routine.status !== "paused" ||
    (expectedRevision !== null && current.revision !== expectedRevision) ||
    activePolicyRoutineRunCount(current) !== 0
  ) {
    fail(
      "POLICY_PROBE_NOT_READY",
      "Policy probe routine must be unchanged, paused, and idle.",
    );
  }
  return current;
}

async function waitForNoActivePolicyRoutineRuns(
  context,
  dependencies,
  expectedRoutineId,
  expectedRevision,
) {
  const deadline = dependencies.now() + dependencies.cleanupTimeoutMs;
  do {
    const current = await readRoutines(context);
    if (
      current.routine.id !== expectedRoutineId ||
      current.revision !== expectedRevision ||
      current.routine.status !== "paused"
    ) {
      fail(
        "POLICY_CLEANUP_CONFLICT",
        "Policy probe routine changed while cleanup was draining runs.",
      );
    }
    if (activePolicyRoutineRunCount(current) === 0) return current;
    if (dependencies.now() >= deadline) break;
    await dependencies.sleep(dependencies.pollIntervalMs);
  } while (dependencies.now() <= deadline);
  fail("CLEANUP_FAILED", "Policy probe routine runs did not settle during cleanup.");
}

async function assertPolicyPillarFence(
  context,
  baselinePolicy,
  baselineRoutine,
) {
  const policy = await readFunctionPolicies(context);
  if (
    policy.functionName !== baselinePolicy.functionName ||
    policy.policy !== COMPUTE_POLICY_BASELINE ||
    policy.revision !== baselinePolicy.revision ||
    policy.declaredReleaseId !== baselinePolicy.declaredReleaseId ||
    policy.declarationHash !== baselinePolicy.declarationHash
  ) {
    fail("POLICY_PROBE_NOT_READY", "Policy probe changed during preflight.");
  }
  const routine = assertPolicyRoutineReady(
    await readRoutines(context),
    baselineRoutine.revision,
  );
  if (routine.routine.id !== baselineRoutine.routine.id) {
    fail("POLICY_PROBE_NOT_READY", "Policy probe routine identity changed.");
  }
  return { policy, routine };
}

async function actOnRoutine(context, current, action) {
  const payload = record(await request({
    context,
    path: `/api/launch/agents/${context.agentId}/routines/${current.routine.id}/actions`,
    method: "POST",
    body: {
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
      action,
    },
    label: `Policy probe routine ${action}`,
    stage: `routine_${action}`,
  }), `Policy probe routine ${action} response`);
  if (
    typeof payload.revision !== "string" ||
    payload.routine?.id !== current.routine.id
  ) {
    fail("POLICY_ROUTINE_FAILED", `Policy probe routine ${action} is invalid.`);
  }
  return { revision: payload.revision, routine: payload.routine };
}

async function waitForRoutineRun(
  context,
  routineId,
  excludedIds,
  expectedStatuses,
  dependencies,
  expectedRevision,
) {
  const deadline = dependencies.now() + dependencies.scenarioTimeoutMs;
  do {
    const current = await readRoutines(context);
    if (
      current.routine.id !== routineId ||
      current.revision !== expectedRevision
    ) {
      fail("POLICY_ROUTINE_FAILED", "Policy probe routine identity changed.");
    }
    const candidate = current.routine.recentRuns.find((run) =>
      run && typeof run.id === "string" && !excludedIds.has(run.id)
    );
    if (candidate && expectedStatuses.has(candidate.status)) {
      return { current, run: candidate };
    }
    if (dependencies.now() >= deadline) break;
    await dependencies.sleep(dependencies.pollIntervalMs);
  } while (dependencies.now() <= deadline);
  fail("POLICY_ROUTINE_TIMEOUT", "Policy probe routine did not settle.");
}

async function policyComputeRunIds(context) {
  const runs = await ownerRunPage(context);
  return new Set(
    runs.filter((run) => run?.functionName === COMPUTE_POLICY_PROBE_FUNCTION)
      .map((run) => run.runId),
  );
}

async function waitForNewPolicyComputeRun(
  context,
  baselineIds,
  dependencies,
) {
  const deadline = dependencies.now() + dependencies.scenarioTimeoutMs;
  do {
    const runs = await ownerRunPage(context);
    const candidate = runs.find((run) =>
      run?.functionName === COMPUTE_POLICY_PROBE_FUNCTION &&
      typeof run.runId === "string" && !baselineIds.has(run.runId)
    );
    if (candidate) {
      const runId = canonicalUuid(candidate.runId, "Policy probe Compute run id");
      const observedStates = [];
      const owner = await waitForOwnerRun(context, {
        scenario: "policy_pillar_free",
        runId,
        agentId: context.agentId,
        functionName: COMPUTE_POLICY_PROBE_FUNCTION,
      }, {
        terminalStatuses: new Set(["completed"]),
        timeoutMs: dependencies.scenarioTimeoutMs,
        pollIntervalMs: dependencies.pollIntervalMs,
        sleep: dependencies.sleep,
        now: dependencies.now,
        observedStates,
      });
      return { owner, observedStates };
    }
    if (dependencies.now() >= deadline) break;
    await dependencies.sleep(dependencies.pollIntervalMs);
  } while (dependencies.now() <= deadline);
  fail("POLICY_COMPUTE_MISSING", "Free policy did not admit a Compute run.");
}

async function certifyPolicyPillar(
  context,
  dependencies,
  baselinePolicyView,
  baselineRoutineView,
  ownership,
) {
  let routine = assertPolicyRoutineReady(
    await readRoutines(context),
    ownership.routineRevision,
  );
  if (routine.routine.id !== baselineRoutineView.routine.id) {
    fail("POLICY_PROBE_NOT_READY", "Policy probe routine identity changed.");
  }
  let policy = await readFunctionPolicies(context);
  if (
    !baselinePolicyView ||
    policy.functionName !== COMPUTE_POLICY_PROBE_FUNCTION ||
    policy.revision !== ownership.policyRevision
  ) {
    fail("POLICY_PROBE_NOT_READY", "Policy probe baseline is invalid.");
  }
  const baselinePolicy = policy.policy;
  if (baselinePolicy !== COMPUTE_POLICY_BASELINE) {
    fail(
      "POLICY_PROBE_NOT_READY",
      `Policy probe must start at the managed ${COMPUTE_POLICY_BASELINE} baseline.`,
    );
  }
  const routineId = routine.routine.id;
  const baselineComputeIds = await policyComputeRunIds(context);
  const baselineRoutineIds = new Set(routine.routine.recentRuns.map((run) => run.id));
  let freeRun;
  let offRoutineRun;
  try {
    routine = await actOnRoutine(context, routine, "activate");
    ownership.routineRevision = routine.revision;
    const beforeFreeRun = new Set(routine.routine.recentRuns.map((run) => run.id));
    routine = await actOnRoutine(context, routine, "run_now");
    ownership.routineRevision = routine.revision;
    await waitForRoutineRun(
      context,
      routineId,
      beforeFreeRun,
      new Set(["succeeded"]),
      dependencies,
      ownership.routineRevision,
    );
    freeRun = await waitForNewPolicyComputeRun(
      context,
      baselineComputeIds,
      dependencies,
    );

    policy = await setFunctionPolicy(context, policy, "off");
    ownership.policyRevision = policy.revision;
    routine = await readRoutines(context);
    if (
      routine.routine.id !== routineId ||
      routine.revision !== ownership.routineRevision ||
      routine.routine.status !== "active"
    ) {
      fail("POLICY_ROUTINE_FAILED", "Policy probe routine changed during certification.");
    }
    const beforeOffRun = new Set(routine.routine.recentRuns.map((run) => run.id));
    routine = await actOnRoutine(context, routine, "run_now");
    ownership.routineRevision = routine.revision;
    const denied = await waitForRoutineRun(
      context,
      routineId,
      beforeOffRun,
      new Set(["failed"]),
      dependencies,
      ownership.routineRevision,
    );
    offRoutineRun = denied.run;
    if (offRoutineRun.errorCode !== COMPUTE_POLICY_OFF_ROUTINE_ERROR_CODE) {
      fail(
        "POLICY_OFF_UNPROVEN",
        "Off policy did not return the Policy Pillar denial code.",
      );
    }
    const afterOffComputeIds = await policyComputeRunIds(context);
    const newlyObserved = [...afterOffComputeIds].filter((runId) =>
      !baselineComputeIds.has(runId)
    );
    if (
      newlyObserved.length !== 1 ||
      newlyObserved[0] !== freeRun.owner.runId
    ) {
      fail("POLICY_OFF_ADMITTED", "Off policy admitted an autonomous Compute run.");
    }
  } finally {
    try {
      await ensurePolicyCleanup(context, { ownership });
    } catch {
      // The caller performs a final explicit cleanup verification.
    }
  }
  if (!freeRun || !offRoutineRun) {
    fail("POLICY_CERTIFICATION_FAILED", "Policy Pillar proof is incomplete.");
  }
  const cleanup = await ensurePolicyCleanup(context, { ownership });
  return {
    function_name: COMPUTE_POLICY_PROBE_FUNCTION,
    routine_id: routineId,
    baseline_policy: baselinePolicy,
    free: {
      compute_run_id: freeRun.owner.runId,
      status: freeRun.owner.status,
      observed_states: freeRun.observedStates,
    },
    off: {
      routine_run_id: offRoutineRun.id,
      routine_status: offRoutineRun.status,
      error_code: offRoutineRun.errorCode,
      compute_run_admitted: false,
    },
    cleanup: { routine_paused: true, policy: cleanup.policy.policy },
    prior_routine_run_count: baselineRoutineIds.size,
  };
}

function requireCleanupOwnership(force, ownership) {
  if (
    !force &&
    (!ownership || typeof ownership.policyRevision !== "string" ||
      typeof ownership.routineRevision !== "string" ||
      !UUID_RE.test(String(ownership.routineId ?? "")))
  ) {
    fail("POLICY_CLEANUP_FAILED", "Policy cleanup ownership is missing.");
  }
}

async function ensurePolicyRoutinePaused(
  context,
  { force = false, ownership = null } = {},
) {
  requireCleanupOwnership(force, ownership);
  let routine = await readRoutines(context);
  if (
    !force &&
    (routine.routine.id !== ownership.routineId ||
      routine.revision !== ownership.routineRevision)
  ) {
    fail("POLICY_CLEANUP_CONFLICT", "Policy routine changed outside certification.");
  }
  if (routine.routine.status !== "paused") {
    if (routine.routine.status !== "active") {
      fail("POLICY_CLEANUP_FAILED", "Policy routine cannot be safely paused.");
    }
    routine = await actOnRoutine(context, routine, "pause");
    if (!force) ownership.routineRevision = routine.revision;
  }
  const verifiedRoutine = await readRoutines(context);
  if (
    verifiedRoutine.routine.status !== "paused" ||
    (!force &&
      (verifiedRoutine.routine.id !== ownership.routineId ||
        verifiedRoutine.revision !== ownership.routineRevision))
  ) {
    fail("POLICY_CLEANUP_FAILED", "Policy routine pause did not persist.");
  }
  return verifiedRoutine;
}

async function ensureFunctionPolicyBaseline(
  context,
  { force = false, ownership = null } = {},
) {
  requireCleanupOwnership(force, ownership);
  let policy = await readFunctionPolicies(context);
  if (!force && policy.revision !== ownership.policyRevision) {
    fail("POLICY_CLEANUP_CONFLICT", "Function policy changed outside certification.");
  }
  if (policy.policy !== COMPUTE_POLICY_BASELINE) {
    policy = await setFunctionPolicy(
      context,
      policy,
      COMPUTE_POLICY_BASELINE,
    );
    if (!force) ownership.policyRevision = policy.revision;
  }
  const verifiedPolicy = await readFunctionPolicies(context);
  if (
    verifiedPolicy.policy !== COMPUTE_POLICY_BASELINE ||
    (!force && verifiedPolicy.revision !== ownership.policyRevision)
  ) {
    fail("POLICY_CLEANUP_FAILED", "Function policy cleanup did not persist.");
  }
  return verifiedPolicy;
}

export async function ensurePolicyCleanup(
  context,
  options = {},
) {
  const routine = await ensurePolicyRoutinePaused(context, options);
  const policy = await ensureFunctionPolicyBaseline(context, options);
  return { routine, policy };
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function publicFailure(error) {
  if (!(error instanceof ComputeCertificationSuiteError)) {
    return { code: "COMPUTE_CERTIFICATION_FAILED", stage: null, http_status: null };
  }
  return {
    code: error.code,
    stage: error.stage,
    http_status: error.httpStatus,
    ...(error.runtimeDiagnostic
      ? { runtime_diagnostic: error.runtimeDiagnostic }
      : {}),
  };
}

function evidenceFor(config, state, now) {
  return {
    schema_version: COMPUTE_CERTIFICATION_SCHEMA_VERSION,
    kind: COMPUTE_CERTIFICATION_KIND,
    verified: state.success === true && state.policyDisabled === true &&
      state.policyCleanup === true &&
      state.activeComputeRunsRemaining === 0 &&
      state.activeRoutineRunsRemaining === 0,
    target: config.target,
    profile: config.profile,
    candidate_sha: config.candidateSha,
    workflow_run_id: config.workflowRunId,
    agent_id: config.agentId,
    function_name: COMPUTE_CERTIFICATION_FUNCTION,
    fixture_identity_call_receipt_id: state.fixtureIdentityCallReceiptId,
    marker_sha256: sha256Text(config.marker),
    started_at: state.startedAt,
    scenarios: state.scenarios,
    policy_pillar: state.policyPillar,
    operator_snapshot_required: true,
    cleanup: {
      compute_policy_disabled: state.policyDisabled,
      // Compatibility key consumed by the rollout workflow. The managed
      // fixture preflights and restores the fixed free baseline so a fresh
      // cleanup-only dispatch can recover a killed certification runner.
      policy_probe_paused_and_free: state.policyCleanup,
      active_compute_runs_remaining: state.activeComputeRunsRemaining,
      active_routine_runs_remaining: state.activeRoutineRunsRemaining,
      settings_revision: state.cleanupRevision,
    },
    generated_at: new Date(now()).toISOString(),
    ...(state.failure ? { failure: state.failure } : {}),
  };
}

export async function runComputeCertificationSuite(
  config,
  {
    fetchImpl = fetch,
    sleep = sleepMs,
    now = Date.now,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    scenarioTimeoutMs = DEFAULT_SCENARIO_TIMEOUT_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    writeEvidence = writePrivateJson,
  } = {},
) {
  const profile = COMPUTE_CERTIFICATION_PROFILES[config?.profile];
  const target = COMPUTE_CERTIFICATION_TARGETS[config?.target];
  if (!profile || !target || config.apiBase !== target.apiBase) {
    fail("INVALID_CONFIGURATION", "Certification target/profile is invalid.");
  }
  if (profile.target !== null && profile.target !== target.name) {
    fail("INVALID_CONFIGURATION", "Certification profile target is invalid.");
  }
  let apiVersionId = null;
  let apiVersionOverride = null;
  try {
    apiVersionId = cloudflareWorkerVersionId(config.apiVersionId);
    apiVersionOverride = cloudflareWorkerVersionOverride(
      target.apiWorker,
      apiVersionId,
    );
  } catch {
    fail(
      "INVALID_CONFIGURATION",
      `${COMPUTE_CERTIFICATION_API_VERSION_ID_ENV} is invalid.`,
    );
  }
  const expectedMarker = buildComputeCertificationMarker(
    config.candidateSha,
    config.workflowRunId,
  );
  if (config.marker !== expectedMarker) {
    fail("INVALID_CONFIGURATION", "Certification marker is invalid.");
  }
  const context = {
    fetchImpl,
    apiBase: target.apiBase,
    ownerAccessToken: requiredString(
      config.ownerAccessToken,
      OWNER_ACCESS_TOKEN_ENV,
    ),
    agentId: canonicalUuid(config.agentId, "certification Agent id"),
    apiVersionId,
    apiVersionOverride,
    requestTimeoutMs,
    activeRunIds: new Set(),
    startedRunIds: [],
  };
  const dependencies = {
    sleep,
    now,
    scenarioTimeoutMs,
    cleanupTimeoutMs,
    pollIntervalMs,
  };
  const state = {
    startedAt: new Date(now()).toISOString(),
    fixtureIdentityCallReceiptId: null,
    scenarios: [],
    policyPillar: null,
    baselineLimits: null,
    baselinePolicy: profile.policyPillar ? COMPUTE_POLICY_BASELINE : null,
    policyDisabled: false,
    policyCleanup: !profile.policyPillar,
    activeComputeRunsRemaining: null,
    activeRoutineRunsRemaining: profile.policyPillar ? null : 0,
    cleanupRevision: null,
    success: false,
    failure: null,
  };
  let primaryError = null;
  let baselinePolicyView = null;
  let baselineRoutineView = null;
  let cleanupOwnership = null;
  let policyCleanupRequired = config.cleanupOnly;
  let baselineSettingsRevision = null;
  let baselineAllowedTools = null;
  let enabledSettingsRevision = null;
  let finalSettingsExpectation = null;

  try {
    const baseline = validateSettings(await request({
      context,
      path: `/api/launch/agents/${context.agentId}/compute/settings`,
      label: "Compute settings lookup",
      stage: "settings_lookup",
    }), { requireDisabled: !config.cleanupOnly });
    state.baselineLimits = baseline.limits;
    baselineSettingsRevision = baseline.revision;
    baselineAllowedTools = baseline.allowedTools;
    if (config.cleanupOnly) {
      if (baseline.enabled) {
        const disabled = await writeSettings(
          context,
          baseline.revision,
          false,
          baseline.limits,
        );
        state.cleanupRevision = disabled.revision;
      } else {
        state.cleanupRevision = baseline.revision;
      }
      state.policyDisabled = true;
      state.success = true;
    } else {
      const fixtureIdentity = await validateFixtureIdentity(context);
      state.fixtureIdentityCallReceiptId = fixtureIdentity.callReceiptId;
      if (profile.policyPillar) {
        baselinePolicyView = await readFunctionPolicies(context);
        if (baselinePolicyView.policy !== COMPUTE_POLICY_BASELINE) {
          fail(
            "POLICY_PROBE_NOT_READY",
            `Policy probe must start at the managed ${COMPUTE_POLICY_BASELINE} baseline.`,
          );
        }
        baselineRoutineView = assertPolicyRoutineReady(
          await readRoutines(context),
        );
        cleanupOwnership = {
          policyRevision: baselinePolicyView.revision,
          routineRevision: baselineRoutineView.revision,
          routineId: baselineRoutineView.routine.id,
        };
        policyCleanupRequired = true;
        await assertPolicyPillarFence(
          context,
          baselinePolicyView,
          baselineRoutineView,
        );
      }
      const enabled = await writeSettings(
        context,
        baseline.revision,
        true,
        CERTIFICATION_LIMITS,
      );
      enabledSettingsRevision = enabled.revision;
      if (profile.policyPillar) {
        await assertPolicyPillarFence(
          context,
          baselinePolicyView,
          baselineRoutineView,
        );
      }
      let producer = null;
      for (const scenario of profile.scenarios) {
        const result = await runScenario(
          context,
          config,
          scenario,
          producer,
          dependencies,
        );
        state.scenarios.push(result.evidence);
        if (result.producerProof) producer = result.producerProof;
      }
      if (profile.policyPillar) {
        state.policyPillar = await certifyPolicyPillar(
          context,
          dependencies,
          baselinePolicyView,
          baselineRoutineView,
          cleanupOwnership,
        );
      }
      state.success = true;
    }
  } catch (error) {
    primaryError = error instanceof ComputeCertificationSuiteError
      ? error
      : new ComputeCertificationSuiteError(
        "COMPUTE_CERTIFICATION_FAILED",
        "Compute certification failed.",
      );
    state.failure = publicFailure(primaryError);
  } finally {
    const cleanupFailures = [];
    try {
      const current = await readSettings(context);
      if (config.cleanupOnly) {
        const disabled = current.enabled
          ? await writeSettings(
            context,
            current.revision,
            false,
            state.baselineLimits ?? current.limits,
          )
          : current;
        state.cleanupRevision = disabled.revision;
        finalSettingsExpectation = {
          revision: disabled.revision,
          enabled: false,
          allowedTools: disabled.allowedTools,
          limits: disabled.limits,
        };
      } else if (enabledSettingsRevision !== null) {
        const ownedEnabledState = {
          revision: enabledSettingsRevision,
          enabled: true,
          allowedTools: ["browser", "shell"],
          limits: CERTIFICATION_LIMITS,
        };
        if (!sameSettingsState(current, ownedEnabledState)) {
          fail(
            "COMPUTE_SETTINGS_CONFLICT",
            "Compute settings changed outside certification.",
          );
        }
        const disabled = await writeSettings(
          context,
          current.revision,
          false,
          state.baselineLimits ?? CERTIFICATION_LIMITS,
          baselineAllowedTools ?? ["browser", "shell"],
        );
        state.cleanupRevision = disabled.revision;
        finalSettingsExpectation = {
          revision: disabled.revision,
          enabled: false,
          allowedTools: disabled.allowedTools,
          limits: disabled.limits,
        };
      } else {
        if (
          current.enabled ||
          baselineSettingsRevision === null ||
          current.revision !== baselineSettingsRevision
        ) {
          fail(
            "COMPUTE_SETTINGS_CONFLICT",
            "Compute settings changed before certification owned them.",
          );
        }
        state.cleanupRevision = current.revision;
        finalSettingsExpectation = {
          revision: current.revision,
          enabled: false,
          allowedTools: current.allowedTools,
          limits: current.limits,
        };
      }
      state.policyDisabled = true;
    } catch {
      cleanupFailures.push("compute_policy");
    }
    let cleanupRoutineId = cleanupOwnership?.routineId ?? null;
    let cleanupRoutineRevision = cleanupOwnership?.routineRevision ?? null;
    const policyCleanupOptions = config.cleanupOnly
      ? { force: true }
      : { ownership: cleanupOwnership };
    let routineRunsDrained = !profile.policyPillar;
    if (profile.policyPillar && policyCleanupRequired) {
      try {
        const paused = await ensurePolicyRoutinePaused(
          context,
          policyCleanupOptions,
        );
        cleanupRoutineId = paused.routine.id;
        cleanupRoutineRevision = paused.revision;
      } catch {
        cleanupFailures.push("policy_routine_pause");
      }
    }
    try {
      await settleActiveRuns(context, dependencies, {
        discover: config.cleanupOnly,
      });
    } catch {
      cleanupFailures.push("runs");
    }
    if (
      profile.policyPillar &&
      cleanupRoutineId &&
      cleanupRoutineRevision
    ) {
      try {
        await waitForNoActivePolicyRoutineRuns(
          context,
          dependencies,
          cleanupRoutineId,
          cleanupRoutineRevision,
        );
        routineRunsDrained = true;
      } catch {
        cleanupFailures.push("routine_runs");
      }
    }
    if (config.cleanupOnly) {
      try {
        // A queued routine may have reached Compute while its pause was being
        // applied. Re-scan after routine settlement before certifying cleanup.
        await settleActiveRuns(context, dependencies, { discover: true });
      } catch {
        cleanupFailures.push("late_runs");
      }
    }
    if (profile.policyPillar && policyCleanupRequired && routineRunsDrained) {
      try {
        await ensureFunctionPolicyBaseline(context, policyCleanupOptions);
        const paused = await ensurePolicyRoutinePaused(
          context,
          policyCleanupOptions,
        );
        await waitForNoActivePolicyRoutineRuns(
          context,
          dependencies,
          paused.routine.id,
          paused.revision,
        );
        // Re-read both owner-controlled resources after the drain. This
        // closes the observation window between restoring the managed policy
        // baseline and proving that the routine remained paused.
        await ensureFunctionPolicyBaseline(context, policyCleanupOptions);
        const verifiedRoutine = assertPolicyRoutineReady(
          await readRoutines(context),
          paused.revision,
        );
        if (verifiedRoutine.routine.id !== paused.routine.id) {
          fail(
            "POLICY_CLEANUP_CONFLICT",
            "Policy probe routine identity changed after cleanup.",
          );
        }
        state.policyCleanup = true;
        state.activeRoutineRunsRemaining = 0;
      } catch {
        cleanupFailures.push("policy_baseline");
      }
    }
    try {
      state.activeComputeRunsRemaining =
        await assertNoActiveFixtureComputeRuns(context);
    } catch {
      cleanupFailures.push("active_runs");
    }
    try {
      if (!finalSettingsExpectation) {
        fail("CLEANUP_FAILED", "Compute settings cleanup was not established.");
      }
      const finalSettings = await readSettings(context);
      if (!sameSettingsState(finalSettings, finalSettingsExpectation)) {
        fail(
          "COMPUTE_SETTINGS_CONFLICT",
          "Compute settings changed after cleanup.",
        );
      }
    } catch {
      cleanupFailures.push("compute_policy_fence");
    }
    if (cleanupFailures.length > 0) {
      primaryError = new ComputeCertificationSuiteError(
        "CLEANUP_FAILED",
        "Compute certification cleanup failed.",
      );
      state.failure = publicFailure(primaryError);
      state.success = false;
    }

    const runIds = [
      ...context.startedRunIds,
      ...(state.policyPillar?.free?.compute_run_id
        ? [state.policyPillar.free.compute_run_id]
        : []),
    ];
    if (new Set(runIds).size !== runIds.length) {
      primaryError = new ComputeCertificationSuiteError(
        "RUN_ID_COLLISION",
        "Compute certification returned duplicate run identities.",
      );
      state.failure = publicFailure(primaryError);
      state.success = false;
    }
    const evidence = evidenceFor(config, state, now);
    const runIdsEvidence = {
      schema_version: 1,
      kind: "galactic_compute_certification_run_set",
      target: config.target,
      candidate_sha: config.candidateSha,
      workflow_run_id: config.workflowRunId,
      agent_id: config.agentId,
      since: state.startedAt,
      run_ids: runIds,
      generated_at: evidence.generated_at,
    };
    try {
      await writeEvidence(config.runIdsPath, runIdsEvidence);
      // The verified summary is the commit marker for the pair. Write it only
      // after the bounded run set exists so a partial write can never look
      // promotable.
      await writeEvidence(config.evidencePath, evidence);
    } catch {
      primaryError = new ComputeCertificationSuiteError(
        "EVIDENCE_WRITE_FAILED",
        "Compute certification evidence could not be written.",
      );
    }
    if (!primaryError && evidence.verified) return evidence;
  }
  throw primaryError ?? new ComputeCertificationSuiteError(
    "COMPUTE_CERTIFICATION_FAILED",
    "Compute certification failed.",
  );
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const config = computeCertificationConfigFromEnv(env, argv);
  await runComputeCertificationSuite(config);
  console.log(
    config.cleanupOnly
      ? `Galactic Compute ${config.target} certification fixture is clean.`
      : `Galactic Compute ${config.target} ${config.profile} certification passed.`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof ComputeCertificationSuiteError
        ? `${error.code}: ${error.message}`
        : "COMPUTE_CERTIFICATION_FAILED: Compute certification failed.",
    );
    process.exitCode = 1;
  }
}
