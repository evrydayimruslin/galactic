#!/usr/bin/env node
// Ensure the fixed Compute certification Agent owns the one paused managed
// routine required to certify Policy Pillar enforcement. This helper runs with
// a short-lived account session before any Compute admission version is
// uploaded or promoted.
//
// The only mutation it may perform is creating the declared routine from the
// already-live app template when no exact-name routine exists. Existing state
// is never edited: duplicates, drift, blockers, active runs, or a non-free
// function policy all fail closed while Compute remains OFF.

import { randomUUID } from "node:crypto";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { ownerSessionTarget } from "./with-staging-owner-session.mjs";

export const COMPUTE_CERTIFICATION_ROUTINE_PREFLIGHT_KIND =
  "galactic_compute_certification_routine_preflight";
export const COMPUTE_CERTIFICATION_ROUTINE_PREFLIGHT_SCHEMA_VERSION = 1;
export const COMPUTE_CERTIFICATION_ROUTINE_TEMPLATE_ID =
  "compute_policy_probe";
export const COMPUTE_CERTIFICATION_ROUTINE_FUNCTION =
  "run_compute_policy_probe";
export const COMPUTE_CERTIFICATION_ROUTINE_NAME =
  "Compute policy certification";
export const COMPUTE_CERTIFICATION_ROUTINE_POLICY = "free";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_BLOCKER_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/u;
const ACTIVE_ROUTINE_RUN_STATUSES = new Set(["queued", "running"]);
const ROUTINE_RUN_STATUSES = new Set([
  ...ACTIVE_ROUTINE_RUN_STATUSES,
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONVERGENCE_ATTEMPTS = 12;
const DEFAULT_CONVERGENCE_DELAY_MS = 500;

export class ComputeCertificationRoutinePreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "ComputeCertificationRoutinePreflightError";
  }
}

function fail(message) {
  throw new ComputeCertificationRoutinePreflightError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredSecret(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} is required.`);
  }
  return value;
}

function canonicalUuid(value, label) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value.toLowerCase();
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 0 && codePoint <= 31) || codePoint === 127) return true;
  }
  return false;
}

export function computeCertificationRoutineOutputPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    containsControlCharacter(value) ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    basename(value).length === 0 ||
    dirname(value) === value
  ) {
    fail("Compute certification routine evidence path is invalid.");
  }
  return value;
}

function privateNoStore(response) {
  const directives = String(response?.headers?.get("cache-control") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return directives.includes("private") && directives.includes("no-store") &&
    !directives.includes("public");
}

async function requestJson(
  fetchImpl,
  url,
  init,
  label,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init?.signal || AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail(`${label} request failed.`);
  }
  if (!response?.ok) fail(`${label} request was rejected.`);
  let body;
  try {
    body = await response.json();
  } catch {
    fail(`${label} returned invalid JSON.`);
  }
  return { response, body };
}

function decodePlatformToolResult(body) {
  if (!isRecord(body) || body.error !== undefined || !isRecord(body.result)) {
    fail("Compute certification routine platform action failed.");
  }
  const result = body.result;
  if (result.isError === true) {
    fail("Compute certification routine platform action failed.");
  }
  if (result.structuredContent !== undefined) {
    if (!isRecord(result.structuredContent)) {
      fail("Compute certification routine platform result is invalid.");
    }
    return result.structuredContent;
  }
  const text = Array.isArray(result.content)
    ? result.content.find((item) => item?.type === "text")?.text
    : undefined;
  if (typeof text !== "string") {
    fail("Compute certification routine platform result is invalid.");
  }
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    fail("Compute certification routine platform result is invalid.");
  }
}

export async function callComputeCertificationRoutineTool({
  apiBase,
  ownerAccessToken,
  args,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  randomUuidImpl = randomUUID,
}) {
  const token = requiredSecret(
    ownerAccessToken,
    "GALACTIC_OWNER_ACCESS_TOKEN",
  );
  let response;
  try {
    response = await requestJson(
      fetchImpl,
      `${apiBase}/mcp/platform`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: canonicalUuid(
            randomUuidImpl(),
            "Compute certification routine request id",
          ),
          method: "tools/call",
          params: { name: "gx.routine", arguments: args },
        }),
      },
      "Compute certification routine platform action",
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof ComputeCertificationRoutinePreflightError) throw error;
    fail("Compute certification routine platform action failed.");
  }
  return decodePlatformToolResult(response.body);
}

async function readLaunchProjection(context) {
  const { response, body } = await requestJson(
    context.fetchImpl,
    `${context.apiBase}/api/launch/agents/${encodeURIComponent(context.agentId)}/routines`,
    { headers: { Authorization: `Bearer ${context.ownerAccessToken}` } },
    "Compute certification routine projection",
    context.timeoutMs,
  );
  if (!privateNoStore(response)) {
    fail("Compute certification routine projection is not private and no-store.");
  }
  if (
    !isRecord(body) ||
    typeof body.revision !== "string" ||
    body.revision.length === 0 ||
    body.agent?.id !== context.agentId ||
    !Array.isArray(body.routines)
  ) {
    fail("Compute certification routine projection is invalid.");
  }
  return body;
}

function exactNamedRoutines(projection) {
  return projection.routines.filter((routine) =>
    routine?.name === COMPUTE_CERTIFICATION_ROUTINE_NAME
  );
}

function selectExactNamedRoutine(projection) {
  const matches = exactNamedRoutines(projection);
  if (matches.length > 1) {
    fail("Multiple Compute certification routines exist.");
  }
  return matches[0] || null;
}

function validateLaunchRoutine(projection, expectedRoutineId) {
  const routine = selectExactNamedRoutine(projection);
  if (!routine) fail("Compute certification routine is missing.");
  const routineId = canonicalUuid(
    routine.id,
    "Compute certification routine projection id",
  );
  if (routineId !== expectedRoutineId) {
    fail("Compute certification routine identity changed.");
  }
  const recentRunsValid = Array.isArray(routine.recentRuns) &&
    routine.recentRuns.every((run) =>
      isRecord(run) &&
      UUID_RE.test(String(run.id ?? "")) &&
      ROUTINE_RUN_STATUSES.has(run.status)
    );
  if (routine.name !== COMPUTE_CERTIFICATION_ROUTINE_NAME) {
    fail("Compute certification routine projection identity drifted.");
  }
  if (routine.status !== "paused") {
    fail("Compute certification routine is not paused.");
  }
  if (
    !Number.isInteger(routine.activeRunCount) ||
    routine.activeRunCount !== 0
  ) {
    fail("Compute certification routine has an active run count.");
  }
  if (!recentRunsValid) {
    fail("Compute certification routine recent run history is invalid.");
  }
  if (
    routine.recentRuns.some((run) =>
      ACTIVE_ROUTINE_RUN_STATUSES.has(run.status)
    )
  ) {
    fail("Compute certification routine has a visible active run.");
  }
  if (!Array.isArray(routine.blockers)) {
    fail("Compute certification routine blocker projection is invalid.");
  }
  if (routine.blockers.length > 0) {
    const codes = routine.blockers.map((blocker) => blocker?.code);
    if (
      codes.some((code) =>
        typeof code !== "string" || !SAFE_BLOCKER_CODE_RE.test(code)
      )
    ) {
      fail("Compute certification routine blocker projection is invalid.");
    }
    fail(
      `Compute certification routine has activation blockers: ${
        [...new Set(codes)].sort().join(", ")
      }.`,
    );
  }
  if (
    !isRecord(routine.actions) ||
    typeof routine.actions.canActivate !== "boolean"
  ) {
    fail("Compute certification routine action projection is invalid.");
  }
  if (routine.actions.canActivate !== true) {
    fail("Compute certification routine cannot be activated.");
  }
  return routine;
}

function validateStoredRoutine(payload, context, expectedRoutineId) {
  const routine = payload?.routine;
  if (!isRecord(routine)) {
    fail("Compute certification routine detail is invalid.");
  }
  const routineId = canonicalUuid(
    routine.id,
    "Compute certification routine detail id",
  );
  if (
    routineId !== expectedRoutineId ||
    canonicalUuid(
      routine.composer_app_id,
      "Compute certification routine composer Agent id",
    ) !== context.agentId ||
    routine.template_id !== COMPUTE_CERTIFICATION_ROUTINE_TEMPLATE_ID ||
    routine.name !== COMPUTE_CERTIFICATION_ROUTINE_NAME ||
    routine.handler_function !== COMPUTE_CERTIFICATION_ROUTINE_FUNCTION ||
    routine.status !== "paused" ||
    routine.max_concurrency !== 1 ||
    !isRecord(routine.metadata) ||
    routine.metadata.launch_managed !== true ||
    !Array.isArray(routine.capabilities) ||
    routine.capabilities.length !== 0
  ) {
    fail("Compute certification routine detail has drifted.");
  }
  return routine;
}

async function readPolicyPillar(context) {
  const { response, body } = await requestJson(
    context.fetchImpl,
    `${context.apiBase}/api/launch/agents/${encodeURIComponent(context.agentId)}/policies`,
    { headers: { Authorization: `Bearer ${context.ownerAccessToken}` } },
    "Compute certification Policy Pillar",
    context.timeoutMs,
  );
  if (!privateNoStore(response)) {
    fail("Compute certification Policy Pillar is not private and no-store.");
  }
  if (!isRecord(body) || !Array.isArray(body.policies)) {
    fail("Compute certification Policy Pillar projection is invalid.");
  }
  const matches = body.policies.filter((policy) =>
    policy?.functionName === COMPUTE_CERTIFICATION_ROUTINE_FUNCTION
  );
  if (matches.length !== 1) {
    fail("Compute certification Policy Pillar function is missing or duplicated.");
  }
  const policy = matches[0];
  if (
    policy.policy !== COMPUTE_CERTIFICATION_ROUTINE_POLICY ||
    typeof policy.revision !== "string" ||
    typeof policy.declaredReleaseId !== "string" ||
    typeof policy.declarationHash !== "string"
  ) {
    fail("Compute certification Policy Pillar is not at the free baseline.");
  }
  return policy;
}

export function computeCertificationRoutinePreflightEvidence({
  target,
  agentId,
  routineId,
  created,
}) {
  let environment;
  try {
    environment = ownerSessionTarget(target);
  } catch {
    fail("Compute certification routine target is invalid.");
  }
  if (typeof created !== "boolean") {
    fail("Compute certification routine creation state is invalid.");
  }
  return {
    schema_version: COMPUTE_CERTIFICATION_ROUTINE_PREFLIGHT_SCHEMA_VERSION,
    kind: COMPUTE_CERTIFICATION_ROUTINE_PREFLIGHT_KIND,
    verified: true,
    target: environment.name,
    agent_id: canonicalUuid(agentId, "Compute certification Agent id"),
    routine_id: canonicalUuid(routineId, "Compute certification routine id"),
    template_id: COMPUTE_CERTIFICATION_ROUTINE_TEMPLATE_ID,
    function_name: COMPUTE_CERTIFICATION_ROUTINE_FUNCTION,
    name: COMPUTE_CERTIFICATION_ROUTINE_NAME,
    status: "paused",
    active_run_count: 0,
    function_policy: COMPUTE_CERTIFICATION_ROUTINE_POLICY,
    created,
  };
}

export async function writeComputeCertificationRoutinePreflightEvidence(
  outputPath,
  evidence,
  {
    writeFileImpl = writeFile,
    chmodImpl = chmod,
    renameImpl = rename,
    unlinkImpl = unlink,
    randomUuidImpl = randomUUID,
  } = {},
) {
  const destination = computeCertificationRoutineOutputPath(outputPath);
  const verified = computeCertificationRoutinePreflightEvidence({
    target: evidence?.target,
    agentId: evidence?.agent_id,
    routineId: evidence?.routine_id,
    created: evidence?.created,
  });
  if (
    JSON.stringify(evidence) !== JSON.stringify(verified) ||
    Object.keys(evidence ?? {}).length !== Object.keys(verified).length
  ) {
    fail("Compute certification routine evidence is invalid.");
  }
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.${canonicalUuid(
      randomUuidImpl(),
      "Compute certification routine evidence temporary id",
    )}.tmp`,
  );
  if (temporary === destination || dirname(temporary) !== dirname(destination)) {
    fail("Compute certification routine evidence temporary path is invalid.");
  }
  try {
    await writeFileImpl(
      temporary,
      `${JSON.stringify(verified, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await chmodImpl(temporary, 0o600);
    await renameImpl(temporary, destination);
  } catch {
    await unlinkImpl(temporary).catch(() => undefined);
    fail("Compute certification routine evidence could not be written.");
  }
  return destination;
}

async function waitForCreatedRoutine(context, dependencies) {
  for (let attempt = 1; attempt <= dependencies.convergenceAttempts; attempt += 1) {
    const projection = await readLaunchProjection(context);
    const routine = selectExactNamedRoutine(projection);
    if (routine) return { projection, routine };
    if (attempt < dependencies.convergenceAttempts) {
      await dependencies.sleep(dependencies.convergenceDelayMs);
    }
  }
  fail("Compute certification routine creation did not converge.");
}

export async function ensureComputeCertificationRoutine(
  {
    target,
    ownerAccessToken,
    agentId,
    outputPath,
  },
  {
    fetchImpl = fetch,
    callRoutineTool = callComputeCertificationRoutineTool,
    writeEvidence = writeComputeCertificationRoutinePreflightEvidence,
    sleep = (milliseconds) =>
      new Promise((accept) => setTimeout(accept, milliseconds)),
    convergenceAttempts = DEFAULT_CONVERGENCE_ATTEMPTS,
    convergenceDelayMs = DEFAULT_CONVERGENCE_DELAY_MS,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {},
) {
  let environment;
  try {
    environment = ownerSessionTarget(target);
  } catch {
    fail("Compute certification routine target is invalid.");
  }
  const context = {
    apiBase: environment.apiBase,
    target: environment.name,
    ownerAccessToken: requiredSecret(
      ownerAccessToken,
      "GALACTIC_OWNER_ACCESS_TOKEN",
    ),
    agentId: canonicalUuid(agentId, "GALACTIC_SMOKE_APP_ID"),
    fetchImpl,
    timeoutMs,
  };
  const destination = computeCertificationRoutineOutputPath(outputPath);
  if (
    !Number.isSafeInteger(convergenceAttempts) ||
    convergenceAttempts < 1 ||
    !Number.isSafeInteger(convergenceDelayMs) ||
    convergenceDelayMs < 0
  ) {
    fail("Compute certification routine convergence configuration is invalid.");
  }

  let projection = await readLaunchProjection(context);
  let routine = selectExactNamedRoutine(projection);
  let created = false;
  if (!routine) {
    try {
      await callRoutineTool({
        apiBase: context.apiBase,
        ownerAccessToken: context.ownerAccessToken,
        args: {
          action: "create",
          app_id: context.agentId,
          template_id: COMPUTE_CERTIFICATION_ROUTINE_TEMPLATE_ID,
          name: COMPUTE_CERTIFICATION_ROUTINE_NAME,
          activate: false,
        },
        fetchImpl,
        timeoutMs,
      });
    } catch {
      // A transport error may happen after the server commits. Reconcile from
      // the owner projection instead of retrying the non-idempotent create.
    }
    ({ projection, routine } = await waitForCreatedRoutine(context, {
      convergenceAttempts,
      convergenceDelayMs,
      sleep,
    }));
    created = true;
  }

  const routineId = canonicalUuid(
    routine.id,
    "Compute certification routine projection id",
  );
  validateLaunchRoutine(projection, routineId);

  let detail;
  try {
    detail = await callRoutineTool({
      apiBase: context.apiBase,
      ownerAccessToken: context.ownerAccessToken,
      args: { action: "get", routine_id: routineId },
      fetchImpl,
      timeoutMs,
    });
  } catch {
    fail("Compute certification routine detail lookup failed.");
  }
  validateStoredRoutine(detail, context, routineId);
  await readPolicyPillar(context);

  const finalProjection = await readLaunchProjection(context);
  if (finalProjection.revision !== projection.revision) {
    fail("Compute certification routine changed during preflight.");
  }
  validateLaunchRoutine(finalProjection, routineId);

  const evidence = computeCertificationRoutinePreflightEvidence({
    target: context.target,
    agentId: context.agentId,
    routineId,
    created,
  });
  try {
    await writeEvidence(destination, evidence);
  } catch {
    fail("Compute certification routine evidence could not be written.");
  }
  return evidence;
}

export function computeCertificationRoutineConfigFromCli(
  argv,
  env = process.env,
) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--output") {
    fail(
      "Usage: ensure-compute-certification-routine.mjs " +
        "--output <absolute-json-path>",
    );
  }
  let target;
  try {
    target = ownerSessionTarget(env.GALACTIC_SMOKE_TARGET).name;
  } catch {
    fail("Compute certification routine target is invalid.");
  }
  return {
    target,
    ownerAccessToken: requiredSecret(
      env.GALACTIC_OWNER_ACCESS_TOKEN,
      "GALACTIC_OWNER_ACCESS_TOKEN",
    ),
    agentId: canonicalUuid(
      env.GALACTIC_SMOKE_APP_ID,
      "GALACTIC_SMOKE_APP_ID",
    ),
    outputPath: computeCertificationRoutineOutputPath(argv[1]),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  await ensureComputeCertificationRoutine(
    computeCertificationRoutineConfigFromCli(argv, env),
  );
  console.log("Compute certification routine preflight evidence written.");
  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(
      error instanceof ComputeCertificationRoutinePreflightError
        ? error.message
        : "Compute certification routine preflight failed.",
    );
    process.exitCode = 1;
  }
}
