#!/usr/bin/env node
/**
 * Deterministic, secret-safe Galactic Compute admitted-job smoke.
 *
 * The owner-session wrapper supplies a short-lived account bearer in the child
 * environment. This smoke temporarily enables the dedicated private Interface
 * Demo fixture, starts one async shell-only job, proves terminal settlement and
 * exact stdout through both owner and in-Agent views, then disables Compute
 * again. It never sends a secret, reaches the network from the body, or creates
 * an artifact.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const COMPUTE_SMOKE_FUNCTION = "run_compute_smoke";
export const COMPUTE_SMOKE_KIND = "galactic_compute_admitted_smoke";
export const COMPUTE_PREFLIGHT_KIND = "galactic_compute_binding_preflight";
export const COMPUTE_SMOKE_SCHEMA_VERSION = 1;
export const COMPUTE_SMOKE_TARGETS = Object.freeze({
  staging: Object.freeze({
    name: "staging",
    apiBase: "https://ultralight-api-staging.rgn4jz429m.workers.dev",
  }),
  production: Object.freeze({
    name: "production",
    apiBase: "https://api.connectgalactic.com",
  }),
});

const OWNER_ACCESS_TOKEN_ENV = "GALACTIC_OWNER_ACCESS_TOKEN";
const PUBLIC_COMPUTE_CODE_RE = /^COMPUTE_[A-Z0-9_]{1,56}$/u;
const PUBLIC_COMPUTE_ERROR_RE =
  /^galactic\.compute failed \((COMPUTE_[A-Z0-9_]{1,56})\):(?: |$)/u;
const RPC_PUBLIC_COMPUTE_ERROR_RE =
  /^GalacticComputeError: galactic\.compute failed \((COMPUTE_[A-Z0-9_]{1,56})\):(?: |$)/u;
const PUBLIC_COMPUTE_UNAVAILABLE_MESSAGE =
  "galactic.compute failed: control plane unavailable.";
const RPC_PUBLIC_COMPUTE_UNAVAILABLE_MESSAGE =
  `GalacticComputeError: ${PUBLIC_COMPUTE_UNAVAILABLE_MESSAGE}`;
const JSON_MEDIA_TYPE_RE =
  /^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/iu;
const HTTP_DIAGNOSTIC_STAGES = new Set([
  "settings_lookup",
  "settings_enable",
  "compute_preflight",
  "compute_start",
  "owner_run_lookup",
  "compute_status",
  "compute_cancel",
  "settings_disable",
]);
const MAX_HTTP_DIAGNOSTIC_BODY_BYTES = 16 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA_RE = /^[0-9a-f]{40}$/u;
const WORKFLOW_RUN_ID_RE = /^[1-9][0-9]{0,19}$/u;
const REVISION_RE = /^(0|[1-9][0-9]*)$/u;
const ACTIVE_STATUSES = new Set([
  "queued",
  "reserving",
  "starting",
  "running",
]);
const OWNER_STATUSES = new Set([
  ...ACTIVE_STATUSES,
  "completed",
  "failed",
  "cancelled",
  "settlement_pending",
]);
const SETTLED_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const SMOKE_LIMITS = Object.freeze({
  maxTimeoutMs: 30_000,
  maxConcurrency: 1,
  maxArtifactBytes: 1_048_576,
  maxArtifacts: 1,
});
const COMPUTE_PREFLIGHT_RUN_ID =
  "00000000-0000-4000-8000-000000000000";
const COMPUTE_PREFLIGHT_EXPECTED_CODE = "COMPUTE_RUN_NOT_FOUND";

export class ComputeSmokeError extends Error {
  constructor(
    code,
    message,
    {
      httpStatus = null,
      publicComputeCode = null,
      requestStage = null,
    } = {},
  ) {
    super(message);
    this.name = "ComputeSmokeError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.publicComputeCode = publicComputeCode;
    this.requestStage = requestStage;
  }
}

function fail(code, message, options) {
  throw new ComputeSmokeError(code, message, options);
}

function requiredString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) fail("INVALID_CONFIGURATION", `${label} is required.`);
  return normalized;
}

function smokeTarget(value) {
  const name = requiredString(value, "GALACTIC_SMOKE_TARGET").toLowerCase();
  const target = COMPUTE_SMOKE_TARGETS[name];
  if (!target) {
    fail(
      "INVALID_CONFIGURATION",
      "GALACTIC_SMOKE_TARGET must be staging or production.",
    );
  }
  return target;
}

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    fail("INVALID_RESPONSE", `${label} must be a UUID.`);
  }
  return value;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_RESPONSE", `${label} must be an object.`);
  }
  return value;
}

function exactStringArray(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((item, index) => item !== expected[index])
  ) {
    fail("INVALID_RESPONSE", `${label} did not match the release fixture.`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("INVALID_RESPONSE", `${label} must be an ISO timestamp.`);
  }
  return value;
}

function finiteNumber(value, label, minimum = -Infinity) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum
  ) {
    fail("INVALID_RESPONSE", `${label} must be a finite number.`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sleepMs(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

async function boundedJsonRecord(response) {
  const contentLength = Number(
    response?.headers?.get?.("content-length") ?? NaN,
  );
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_HTTP_DIAGNOSTIC_BODY_BYTES
  ) {
    await response?.body?.cancel?.().catch(() => undefined);
    return null;
  }
  const reader = response?.body?.getReader?.();
  if (!reader) return null;
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      byteLength += value.byteLength;
      if (byteLength > MAX_HTTP_DIAGNOSTIC_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return null;
  }
}

/**
 * Parse the trusted Launch error envelope in memory, but retain only a bounded
 * public Compute code. Raw bodies and messages may contain developer output,
 * upstream diagnostics, or secrets, so they are never returned, logged, or
 * persisted.
 */
async function safeHttpPublicComputeCode(response) {
  const contentType = response?.headers?.get?.("content-type") || "";
  if (!JSON_MEDIA_TYPE_RE.test(contentType)) return null;
  const payload = await boundedJsonRecord(response);
  if (!payload) return null;
  const error = record(payload?.error);
  const details = record(error?.details);
  const message = typeof error?.message === "string" ? error.message : "";
  if (error?.type === "Error") {
    const rpcComputeCode =
      message.match(RPC_PUBLIC_COMPUTE_ERROR_RE)?.[1] || "";
    if (PUBLIC_COMPUTE_CODE_RE.test(rpcComputeCode)) return rpcComputeCode;
    if (message === RPC_PUBLIC_COMPUTE_UNAVAILABLE_MESSAGE) {
      return "COMPUTE_CONTROL_PLANE_UNAVAILABLE";
    }
    return null;
  }
  for (
    const candidate of [
      payload?.code,
      error?.code,
      error?.type,
      ...(error?.type === "GalacticComputeError" ? [details?.code] : []),
    ]
  ) {
    if (
      typeof candidate === "string" &&
      PUBLIC_COMPUTE_CODE_RE.test(candidate)
    ) {
      return candidate;
    }
  }
  if (error?.type !== "GalacticComputeError") return null;
  const computeCode = message.match(PUBLIC_COMPUTE_ERROR_RE)?.[1] || "";
  if (PUBLIC_COMPUTE_CODE_RE.test(computeCode)) return computeCode;
  if (message === PUBLIC_COMPUTE_UNAVAILABLE_MESSAGE) {
    return "COMPUTE_CONTROL_PLANE_UNAVAILABLE";
  }
  return null;
}

export function buildComputeSmokeMarker(candidateSha, workflowRunId) {
  if (!SHA_RE.test(String(candidateSha || ""))) {
    fail(
      "INVALID_CONFIGURATION",
      "COMPUTE_RELEASE_SHA must be a lowercase 40-character Git SHA.",
    );
  }
  if (!WORKFLOW_RUN_ID_RE.test(String(workflowRunId || ""))) {
    fail(
      "INVALID_CONFIGURATION",
      "COMPUTE_RELEASE_RUN_ID must be a positive workflow run id.",
    );
  }
  return `galactic-compute-release-smoke-v1:${candidateSha}:${workflowRunId}\n`;
}

export function computeSmokeConfigFromEnv(
  env = process.env,
  argv = [],
) {
  const cleanupOnly = argv.length === 1 && argv[0] === "--cleanup-only";
  const preflightOnly = argv.length === 1 && argv[0] === "--preflight-only";
  if (
    argv.length > 1 ||
    (argv.length === 1 && !cleanupOnly && !preflightOnly)
  ) {
    fail(
      "INVALID_CONFIGURATION",
      "Usage: compute-admitted-smoke.mjs [--cleanup-only|--preflight-only]",
    );
  }
  const target = smokeTarget(env.GALACTIC_SMOKE_TARGET);
  const candidateSha = requiredString(
    env.COMPUTE_RELEASE_SHA,
    "COMPUTE_RELEASE_SHA",
  );
  const workflowRunId = requiredString(
    env.COMPUTE_RELEASE_RUN_ID,
    "COMPUTE_RELEASE_RUN_ID",
  );
  const marker = buildComputeSmokeMarker(candidateSha, workflowRunId);
  const agentId = requiredString(
    env.GALACTIC_SMOKE_APP_ID,
    "GALACTIC_SMOKE_APP_ID",
  );
  if (!UUID_RE.test(agentId)) {
    fail(
      "INVALID_CONFIGURATION",
      "GALACTIC_SMOKE_APP_ID must be a UUID.",
    );
  }
  const evidenceDir = resolve(
    requiredString(
      env.COMPUTE_RELEASE_EVIDENCE_DIR,
      "COMPUTE_RELEASE_EVIDENCE_DIR",
    ),
  );
  return {
    target: target.name,
    apiBase: target.apiBase,
    candidateSha,
    workflowRunId,
    marker,
    agentId,
    ownerAccessToken: requiredString(
      env[OWNER_ACCESS_TOKEN_ENV],
      OWNER_ACCESS_TOKEN_ENV,
    ),
    evidencePath: resolve(
      evidenceDir,
      preflightOnly
        ? `compute-preflight-${target.name}.json`
        : `compute-admitted-${target.name}.json`,
    ),
    cleanupOnly,
    preflightOnly,
  };
}

async function requestJson({
  fetchImpl,
  apiBase,
  ownerAccessToken,
  path,
  method = "GET",
  body,
  label,
  stage,
  requestTimeoutMs,
}) {
  let response;
  try {
    response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ownerAccessToken}`,
        Accept: "application/json",
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    fail("REQUEST_FAILED", `${label} request failed.`);
  }
  if (!response?.ok) {
    const httpStatus = Number(response?.status) || 0;
    const publicComputeCode = await safeHttpPublicComputeCode(response);
    fail(
      "HTTP_ERROR",
      `${label} failed (HTTP ${httpStatus}${
        publicComputeCode ? `; ${publicComputeCode}` : ""
      }).`,
      {
        httpStatus,
        publicComputeCode,
        requestStage: HTTP_DIAGNOSTIC_STAGES.has(stage) ? stage : null,
      },
    );
  }
  try {
    return await response.json();
  } catch {
    fail("INVALID_RESPONSE", `${label} returned invalid JSON.`);
  }
}

function validateManifestCeiling(settings) {
  const ceiling = object(settings.manifestCeiling, "Compute manifest ceiling");
  if (ceiling.enabled !== true || ceiling.profile !== "developer-v1") {
    fail(
      "FIXTURE_NOT_READY",
      "The release fixture does not expose the expected Compute ceiling.",
    );
  }
  exactStringArray(ceiling.tools, ["shell"], "Compute manifest tools");
  exactStringArray(ceiling.secrets, [], "Compute manifest secrets");
}

function validateLimits(value, label) {
  const limits = object(value, label);
  for (const field of [
    "maxTimeoutMs",
    "maxConcurrency",
    "maxArtifactBytes",
    "maxArtifacts",
  ]) {
    if (!Number.isSafeInteger(limits[field]) || limits[field] < 1) {
      fail("INVALID_RESPONSE", `${label} ${field} is invalid.`);
    }
  }
  return {
    maxTimeoutMs: limits.maxTimeoutMs,
    maxConcurrency: limits.maxConcurrency,
    maxArtifactBytes: limits.maxArtifactBytes,
    maxArtifacts: limits.maxArtifacts,
  };
}

function validateSettingsView(value, { requireDisabledBaseline = false } = {}) {
  const view = object(value, "Compute settings response");
  const settings = object(view.settings, "Compute settings");
  if (!REVISION_RE.test(String(view.revision ?? ""))) {
    fail("INVALID_RESPONSE", "Compute settings revision is invalid.");
  }
  validateManifestCeiling(settings);
  if (
    typeof settings.enabled !== "boolean" ||
    settings.profile !== "developer-v1"
  ) {
    fail("INVALID_RESPONSE", "Compute settings are invalid.");
  }
  exactStringArray(settings.allowedTools, ["shell"], "Compute allowed tools");
  exactStringArray(settings.secretBindings, [], "Compute secret bindings");
  exactStringArray(settings.authorityRules, [], "Compute authority rules");
  const limits = validateLimits(settings.limits, "Compute limits");
  if (requireDisabledBaseline && settings.enabled !== false) {
    fail(
      "FIXTURE_ALREADY_ENABLED",
      "The dedicated release fixture must be disabled before the smoke.",
    );
  }
  return {
    revision: String(view.revision),
    settings: {
      enabled: settings.enabled,
      profile: "developer-v1",
      allowedTools: ["shell"],
      secretBindings: [],
      authorityRules: [],
      limits,
    },
  };
}

function settingsMutation(revision, enabled, limits = SMOKE_LIMITS) {
  return {
    expectedRevision: revision,
    ownerConfirmed: true,
    settings: {
      enabled,
      profile: "developer-v1",
      allowedTools: ["shell"],
      secretBindings: [],
      authorityRules: [],
      limits: { ...limits },
    },
  };
}

async function getSettings(context) {
  return await requestJson({
    ...context,
    path:
      `/api/launch/agents/${encodeURIComponent(context.agentId)}/compute/settings`,
    label: "Compute settings lookup",
    stage: "settings_lookup",
  });
}

async function putSettings(context, revision, enabled, limits = SMOKE_LIMITS) {
  const response = await requestJson({
    ...context,
    path:
      `/api/launch/agents/${encodeURIComponent(context.agentId)}/compute/settings`,
    method: "PUT",
    body: settingsMutation(revision, enabled, limits),
    label: enabled
      ? "Compute fixture enablement"
      : "Compute fixture disablement",
    stage: enabled ? "settings_enable" : "settings_disable",
  });
  const validated = validateSettingsView(response);
  if (validated.settings.enabled !== enabled) {
    fail(
      "POLICY_MUTATION_FAILED",
      `Compute fixture was not ${enabled ? "enabled" : "disabled"}.`,
    );
  }
  return validated;
}

async function invokeSmokeFunction(context, args, label, stage) {
  const payload = await requestJson({
    ...context,
    path:
      `/api/launch/agents/${encodeURIComponent(context.agentId)}/functions/${
        encodeURIComponent(COMPUTE_SMOKE_FUNCTION)
      }/run`,
    method: "POST",
    body: { args },
    label,
    stage,
  });
  const response = object(payload, `${label} response`);
  if (
    response.success !== true ||
    response.functionName !== COMPUTE_SMOKE_FUNCTION ||
    response.error !== null
  ) {
    fail("FUNCTION_RUN_FAILED", `${label} did not succeed.`);
  }
  const receiptId = assertUuid(response.receiptId, `${label} receipt id`);
  return {
    result: object(response.result, `${label} result`),
    receiptId,
  };
}

function validateAcceptedRun(value) {
  const run = object(value, "Compute admission result");
  const runId = assertUuid(run.run_id, "Compute run id");
  const receiptId = assertUuid(run.receipt_id, "Compute receipt id");
  if (
    run.async !== true ||
    !ACTIVE_STATUSES.has(run.status) ||
    run.profile !== "developer-v1"
  ) {
    fail(
      "ADMISSION_NOT_ACCEPTED",
      "Compute did not return an accepted async job.",
    );
  }
  exactStringArray(run.tools, ["shell"], "Compute admitted tools");
  timestamp(run.created_at, "Compute admitted created_at");
  return {
    runId,
    receiptId,
    status: run.status,
    createdAt: run.created_at,
  };
}

async function ownerRunPage(context) {
  const payload = await requestJson({
    ...context,
    path:
      `/api/launch/agents/${encodeURIComponent(context.agentId)}/compute/runs?limit=100`,
    label: "Compute owner run lookup",
    stage: "owner_run_lookup",
  });
  const page = object(payload, "Compute owner run response");
  if (!Array.isArray(page.runs)) {
    fail("INVALID_RESPONSE", "Compute owner run response is invalid.");
  }
  return page.runs;
}

function rememberStatus(state, status) {
  if (state.observedStates.at(-1) !== status) {
    state.observedStates.push(status);
  }
  state.lastOwnerStatus = status;
}

async function loadOwnerRun(context, state) {
  const runs = await ownerRunPage(context);
  const run = runs.find((candidate) =>
    candidate && typeof candidate === "object" &&
    candidate.runId === state.runId
  );
  if (!run) return null;
  if (!OWNER_STATUSES.has(run.status)) {
    fail("INVALID_RESPONSE", "Compute owner run status is invalid.");
  }
  rememberStatus(state, run.status);
  return run;
}

async function waitForOwnerSettlement(
  context,
  state,
  {
    timeoutMs,
    pollIntervalMs,
    sleep,
    now,
    requireSuccess,
  },
) {
  const deadline = now() + timeoutMs;
  do {
    const run = await loadOwnerRun(context, state);
    if (run && SETTLED_STATUSES.has(run.status)) {
      if (requireSuccess && run.status !== "completed") {
        fail(
          "COMPUTE_RUN_FAILED",
          "The admitted Compute job did not complete successfully.",
        );
      }
      return run;
    }
    if (now() >= deadline) break;
    await sleep(pollIntervalMs);
  } while (now() <= deadline);
  fail(
    "COMPUTE_RUN_TIMEOUT",
    "The admitted Compute job did not settle before the release deadline.",
  );
}

function validateCompletedOwnerRun(value, expected) {
  const run = object(value, "Completed Compute owner run");
  if (
    run.runId !== expected.runId ||
    run.receiptId !== expected.receiptId ||
    run.status !== "completed" ||
    run.agentId !== expected.agentId ||
    run.functionName !== COMPUTE_SMOKE_FUNCTION ||
    !["wallet", "subscription_capacity"].includes(run.billingMode)
  ) {
    fail(
      "INVALID_COMPLETION",
      "The completed Compute owner run did not match the admitted job.",
    );
  }
  const createdAt = timestamp(run.createdAt, "Compute owner createdAt");
  const startedAt = timestamp(run.startedAt, "Compute owner startedAt");
  const finishedAt = timestamp(run.finishedAt, "Compute owner finishedAt");
  if (
    Date.parse(startedAt) < Date.parse(createdAt) ||
    Date.parse(finishedAt) < Date.parse(startedAt)
  ) {
    fail("INVALID_COMPLETION", "Compute owner timestamps are not monotonic.");
  }
  const usage = object(run.usage, "Compute owner usage");
  const reserved = finiteNumber(usage.reserved, "Compute reserved usage", 0);
  const actual = finiteNumber(usage.actual, "Compute actual usage", 0);
  const trueUp = finiteNumber(usage.trueUp, "Compute usage true-up");
  if (
    typeof usage.unit !== "string" ||
    !usage.unit.trim() ||
    Math.abs((actual - reserved) - trueUp) > 1e-9
  ) {
    fail("INVALID_COMPLETION", "Compute usage settlement is invalid.");
  }
  if (
    run.exitCode !== 0 ||
    run.infraFailure !== null ||
    !Array.isArray(run.artifacts) ||
    run.artifacts.length !== 0 ||
    run.cancellable !== false
  ) {
    fail(
      "INVALID_COMPLETION",
      "Compute teardown or terminal result was not clean.",
    );
  }
  return {
    billingMode: run.billingMode,
    usage: {
      reserved,
      actual,
      trueUp,
      unit: usage.unit,
    },
    timestamps: { createdAt, startedAt, finishedAt },
  };
}

function validateComputeGet(value, expected) {
  const run = object(value, "Compute status result");
  if (
    run.run_id !== expected.runId ||
    run.receipt_id !== expected.receiptId ||
    run.status !== "completed" ||
    run.profile !== "developer-v1" ||
    run.exit_code !== 0 ||
    run.stdout !== expected.marker ||
    run.stderr !== "" ||
    !Array.isArray(run.artifacts) ||
    run.artifacts.length !== 0 ||
    typeof run.error === "string"
  ) {
    fail(
      "INVALID_COMPUTE_OUTPUT",
      "Compute status did not prove the exact release marker and clean output.",
    );
  }
  exactStringArray(run.tools, ["shell"], "Compute completed tools");
  timestamp(run.created_at, "Compute status created_at");
  timestamp(run.started_at, "Compute status started_at");
  timestamp(run.finished_at, "Compute status finished_at");
}

async function cancelRun(context, state) {
  try {
    const run = await requestJson({
      ...context,
      path:
        `/api/launch/agents/${encodeURIComponent(context.agentId)}/compute/runs/${
          encodeURIComponent(state.runId)
        }/cancel`,
      method: "POST",
      body: {},
      label: "Compute smoke cancellation",
      stage: "compute_cancel",
    });
    if (run?.runId !== state.runId || !OWNER_STATUSES.has(run?.status)) {
      fail(
        "INVALID_RESPONSE",
        "Compute cancellation returned an invalid run.",
      );
    }
    rememberStatus(state, run.status);
    return run;
  } catch (error) {
    // A terminal run can win the race between the last poll and cancellation.
    if (error instanceof ComputeSmokeError && error.httpStatus === 409) {
      return null;
    }
    throw error;
  }
}

async function settleRunDuringCleanup(context, state, dependencies) {
  if (!state.runId || SETTLED_STATUSES.has(state.lastOwnerStatus)) return;
  if (
    !state.lastOwnerStatus ||
    ACTIVE_STATUSES.has(state.lastOwnerStatus)
  ) {
    const cancelled = await cancelRun(context, state);
    if (cancelled && SETTLED_STATUSES.has(cancelled.status)) return;
  }
  await waitForOwnerSettlement(context, state, {
    ...dependencies,
    timeoutMs: dependencies.cleanupTimeoutMs,
    requireSuccess: false,
  });
}

async function disableFixture(context, state) {
  const current = validateSettingsView(await getSettings(context));
  if (current.settings.enabled === false) {
    state.policyDisabled = true;
    state.cleanupRevision = current.revision;
    return;
  }
  const disabled = await putSettings(
    context,
    current.revision,
    false,
    state.baselineLimits ?? SMOKE_LIMITS,
  );
  state.policyDisabled = disabled.settings.enabled === false;
  state.cleanupRevision = disabled.revision;
}

export async function writeComputeSmokeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function failureDiagnostic(failure) {
  if (
    !HTTP_DIAGNOSTIC_STAGES.has(failure?.requestStage) ||
    !Number.isInteger(failure?.httpStatus) ||
    failure.httpStatus < 400 ||
    failure.httpStatus > 599
  ) {
    return null;
  }
  return {
    stage: failure.requestStage,
    http_status: failure.httpStatus,
    ...(PUBLIC_COMPUTE_CODE_RE.test(failure?.publicComputeCode || "")
      ? { public_compute_code: failure.publicComputeCode }
      : {}),
  };
}

function preflightEvidenceFor(
  config,
  { enabled, revision },
  success,
  failure,
  now,
) {
  const diagnostic = failureDiagnostic(failure);
  return {
    schema_version: COMPUTE_SMOKE_SCHEMA_VERSION,
    kind: COMPUTE_PREFLIGHT_KIND,
    verified: success === true,
    target: config.target,
    candidate_sha: config.candidateSha,
    workflow_run_id: config.workflowRunId,
    agent_id: config.agentId,
    function_name: COMPUTE_SMOKE_FUNCTION,
    fixture_policy: {
      enabled,
      revision,
    },
    probe: {
      action: "status",
      run_id: COMPUTE_PREFLIGHT_RUN_ID,
      expected_http_status: 500,
      expected_public_compute_code: COMPUTE_PREFLIGHT_EXPECTED_CODE,
      ...(success
        ? {
          observed_http_status: 500,
          observed_public_compute_code: COMPUTE_PREFLIGHT_EXPECTED_CODE,
        }
        : {}),
    },
    generated_at: new Date(now()).toISOString(),
    ...(failure?.code ? { failure_code: failure.code } : {}),
    ...(diagnostic ? { failure_diagnostic: diagnostic } : {}),
  };
}

async function runComputeBindingPreflight(
  config,
  context,
  { now, writeEvidence },
) {
  let enabled = null;
  let revision = null;
  let primaryError = null;
  let success = false;

  try {
    const baseline = validateSettingsView(await getSettings(context));
    enabled = baseline.settings.enabled;
    revision = baseline.revision;
    if (enabled !== false) {
      fail(
        "FIXTURE_ALREADY_ENABLED",
        "The dedicated release fixture must be disabled before the preflight.",
      );
    }
    try {
      await invokeSmokeFunction(
        context,
        { action: "status", run_id: COMPUTE_PREFLIGHT_RUN_ID },
        "Compute binding preflight",
        "compute_preflight",
      );
      fail(
        "PREFLIGHT_UNEXPECTED_SUCCESS",
        "Compute binding preflight unexpectedly found the nonexistent run.",
      );
    } catch (error) {
      if (
        error instanceof ComputeSmokeError &&
        error.code === "HTTP_ERROR" &&
        error.httpStatus === 500 &&
        error.publicComputeCode === COMPUTE_PREFLIGHT_EXPECTED_CODE &&
        error.requestStage === "compute_preflight"
      ) {
        success = true;
      } else {
        throw error;
      }
    }
  } catch (error) {
    primaryError = error instanceof ComputeSmokeError
      ? error
      : new ComputeSmokeError(
        "COMPUTE_PREFLIGHT_FAILED",
        "The Compute binding preflight failed.",
      );
  }

  const evidence = preflightEvidenceFor(
    config,
    { enabled, revision },
    success && !primaryError,
    primaryError,
    now,
  );
  try {
    await writeEvidence(config.evidencePath, evidence);
  } catch {
    primaryError = new ComputeSmokeError(
      "EVIDENCE_WRITE_FAILED",
      "Compute preflight evidence could not be written.",
    );
  }
  if (!primaryError && success) return evidence;
  throw primaryError ??
    new ComputeSmokeError(
      "COMPUTE_PREFLIGHT_FAILED",
      "The Compute binding preflight failed.",
    );
}

function evidenceFor(config, state, success, failure, now) {
  const markerDigest = sha256(config.marker);
  const diagnostic = failureDiagnostic(failure);
  return {
    schema_version: COMPUTE_SMOKE_SCHEMA_VERSION,
    kind: COMPUTE_SMOKE_KIND,
    verified: success === true && state.policyDisabled === true,
    target: config.target,
    candidate_sha: config.candidateSha,
    workflow_run_id: config.workflowRunId,
    agent_id: config.agentId,
    function_name: COMPUTE_SMOKE_FUNCTION,
    marker_sha256: markerDigest,
    compute_run_id: state.runId,
    compute_receipt_id: state.computeReceiptId,
    start_receipt_id: state.startReceiptId,
    status_receipt_id: state.statusReceiptId,
    observed_states: [...state.observedStates],
    billing_mode: state.billingMode,
    usage: state.usage,
    timestamps: state.timestamps,
    result: {
      status: success ? "completed" : state.lastOwnerStatus,
      exit_code: success ? 0 : null,
      stdout_sha256: success ? markerDigest : null,
      stderr_bytes: success ? 0 : null,
      artifact_count: success ? 0 : null,
    },
    policy_cleanup: {
      disabled: state.policyDisabled,
      revision: state.cleanupRevision,
    },
    generated_at: new Date(now()).toISOString(),
    ...(failure?.code ? { failure_code: failure.code } : {}),
    ...(diagnostic ? { failure_diagnostic: diagnostic } : {}),
  };
}

export async function runAdmittedComputeSmoke(
  config,
  {
    fetchImpl = fetch,
    sleep = sleepMs,
    now = Date.now,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    smokeTimeoutMs = DEFAULT_SMOKE_TIMEOUT_MS,
    cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    writeEvidence = writeComputeSmokeEvidence,
  } = {},
) {
  const target = smokeTarget(config?.target);
  const expectedMarker = buildComputeSmokeMarker(
    config?.candidateSha,
    config?.workflowRunId,
  );
  if (config?.marker !== expectedMarker) {
    fail(
      "INVALID_CONFIGURATION",
      "Compute smoke marker does not match the release candidate.",
    );
  }
  if (config?.apiBase !== target.apiBase) {
    fail(
      "INVALID_CONFIGURATION",
      `Compute smoke API does not match the pinned ${target.name} origin.`,
    );
  }
  if (config?.cleanupOnly === true && config?.preflightOnly === true) {
    fail(
      "INVALID_CONFIGURATION",
      "Compute smoke cannot run cleanup-only and preflight-only together.",
    );
  }
  const context = {
    fetchImpl,
    apiBase: target.apiBase,
    ownerAccessToken: requiredString(
      config.ownerAccessToken,
      OWNER_ACCESS_TOKEN_ENV,
    ),
    agentId: assertUuid(config.agentId, "GALACTIC_SMOKE_APP_ID"),
    requestTimeoutMs,
  };
  if (config?.preflightOnly === true) {
    return await runComputeBindingPreflight(config, context, {
      now,
      writeEvidence,
    });
  }
  const state = {
    runId: null,
    computeReceiptId: null,
    startReceiptId: null,
    statusReceiptId: null,
    observedStates: [],
    lastOwnerStatus: null,
    billingMode: null,
    usage: null,
    timestamps: null,
    baselineLimits: null,
    policyDisabled: false,
    cleanupRevision: null,
  };
  let primaryError = null;
  let success = false;

  try {
    const baseline = validateSettingsView(await getSettings(context), {
      requireDisabledBaseline: !config.cleanupOnly,
    });
    state.baselineLimits = baseline.settings.limits;
    if (config.cleanupOnly) {
      await disableFixture(context, state);
    } else {
      await putSettings(context, baseline.revision, true);
      const started = await invokeSmokeFunction(
        context,
        { action: "start", marker: config.marker },
        "Compute smoke start",
        "compute_start",
      );
      state.startReceiptId = started.receiptId;
      const admitted = validateAcceptedRun(started.result);
      state.runId = admitted.runId;
      state.computeReceiptId = admitted.receiptId;
      rememberStatus(state, admitted.status);

      const completed = await waitForOwnerSettlement(context, state, {
        timeoutMs: smokeTimeoutMs,
        pollIntervalMs,
        sleep,
        now,
        requireSuccess: true,
      });
      const settlement = validateCompletedOwnerRun(completed, {
        runId: state.runId,
        receiptId: state.computeReceiptId,
        agentId: context.agentId,
      });
      state.billingMode = settlement.billingMode;
      state.usage = settlement.usage;
      state.timestamps = settlement.timestamps;

      const checked = await invokeSmokeFunction(
        context,
        { action: "status", run_id: state.runId },
        "Compute smoke status",
        "compute_status",
      );
      state.statusReceiptId = checked.receiptId;
      validateComputeGet(checked.result, {
        runId: state.runId,
        receiptId: state.computeReceiptId,
        marker: config.marker,
      });
      success = true;
    }
  } catch (error) {
    primaryError = error instanceof ComputeSmokeError
      ? error
      : new ComputeSmokeError(
        "COMPUTE_SMOKE_FAILED",
        "The admitted Compute smoke failed.",
      );
  } finally {
    const cleanupErrors = [];
    let cleanupDiagnostic = null;
    try {
      await settleRunDuringCleanup(context, state, {
        cleanupTimeoutMs,
        pollIntervalMs,
        sleep,
        now,
      });
    } catch (error) {
      cleanupErrors.push("run");
      if (error instanceof ComputeSmokeError) cleanupDiagnostic = error;
    }
    try {
      await disableFixture(context, state);
    } catch (error) {
      cleanupErrors.push("policy");
      if (!cleanupDiagnostic && error instanceof ComputeSmokeError) {
        cleanupDiagnostic = error;
      }
    }
    if (cleanupErrors.length > 0) {
      primaryError = new ComputeSmokeError(
        "CLEANUP_FAILED",
        "Compute smoke cleanup did not complete.",
        {
          httpStatus: cleanupDiagnostic?.httpStatus,
          publicComputeCode: cleanupDiagnostic?.publicComputeCode,
          requestStage: cleanupDiagnostic?.requestStage,
        },
      );
      success = false;
    }

    const evidence = evidenceFor(
      config,
      state,
      success && !primaryError,
      primaryError,
      now,
    );
    try {
      await writeEvidence(config.evidencePath, evidence);
    } catch {
      primaryError = new ComputeSmokeError(
        "EVIDENCE_WRITE_FAILED",
        "Compute smoke evidence could not be written.",
      );
      success = false;
    }
    if (!primaryError && success) return evidence;
    if (!primaryError && config.cleanupOnly && state.policyDisabled) {
      return evidence;
    }
  }

  throw primaryError ??
    new ComputeSmokeError(
      "COMPUTE_SMOKE_FAILED",
      "The admitted Compute smoke failed.",
    );
}

async function main(argv, env = process.env) {
  const config = computeSmokeConfigFromEnv(env, argv);
  const evidence = await runAdmittedComputeSmoke(config);
  if (config.preflightOnly) {
    console.log(
      `Galactic Compute ${config.target} binding preflight verified while admission is off.`,
    );
  } else if (config.cleanupOnly) {
    console.log(
      `Galactic Compute ${config.target} fixture is disabled; cleanup evidence written.`,
    );
  } else {
    console.log(
      `Galactic Compute ${config.target} admitted job verified (${evidence.compute_run_id}).`,
    );
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "The admitted Compute smoke failed.",
    );
    process.exitCode = 1;
  }
}
