import {
  authorityToDatabaseValue,
  canonicalizeComputeAuthorities,
  requireComputeCallerFunction,
  requireComputeUuid,
} from "./authority.ts";
import {
  callComputeRpc,
  type ComputeDatabaseDeps,
  firstComputeRow,
  integerString,
  nullableString,
  queryComputeRows,
  requiredString,
} from "./database.ts";
import {
  COMPUTE_JOB_TOKEN_AUDIENCE,
  prepareComputeJobToken,
  type PreparedComputeJobToken,
} from "./tokens.ts";
import { mapComputeArtifactRow } from "./artifacts.ts";
import {
  COMPUTE_PROFILE,
  COMPUTE_RUN_STATES,
  DEVELOPER_V1_TOOL_IDS,
  type ComputeAuthority,
  type ComputeArtifact,
  type ComputeExecutionRequest,
  type ComputeManifestCeiling,
  type ComputePolicyLimitsSnapshot,
  type ComputeRun,
  type ComputeRunBudgetReservation,
  type ComputeRunReceipt,
  type ComputeRunState,
  type ComputeToolSelection,
} from "./types.ts";
import { COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS } from "../../../shared/contracts/compute.ts";
import { settleComputeCapacityFromTerminalPayload } from "./capacity-settlement.ts";

export const COMPUTE_RATE_VERSION = "compute-rate-v1" as const;
export const COMPUTE_RATE_LIGHT_PER_MS = 0.000002056;
// Cloudflare Sandbox readiness is bounded by 45s instance + 150s port-ready.
export const COMPUTE_STARTUP_ALLOWANCE_MS = 195_000;
export const COMPUTE_TEARDOWN_ALLOWANCE_MS = 15_000;
export const COMPUTE_MAX_TIMEOUT_MS = COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS;

const SHA256_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/i;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const STATES = new Set<string>(COMPUTE_RUN_STATES);
const BASE_TOOLS = new Set<string>(DEVELOPER_V1_TOOL_IDS);
const TOOL_ID_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const MAX_ARGV = 128;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_WORKSPACE_PATHS = 100;

export interface AdmittedComputeRun {
  run: ComputeRun;
  replayed: boolean;
}

export interface PreparedComputeSecretDescriptor {
  bindingId: string;
  bindingVersion: string;
  name: string;
  variableName: string;
  delivery:
    | { kind: "raw_env"; envName: string }
    | { kind: "raw_file"; fileName: string };
}

export interface PreparedComputeLease {
  run: ComputeRun;
  token: string | null;
  tokenLookupId: string;
  tokenExpiresAt: string;
  replayed: boolean;
  budget: ComputeRunBudgetReservation;
  secretDescriptors: PreparedComputeSecretDescriptor[];
}

export interface ComputeRunSecretDescriptorSnapshot {
  run: ComputeRun;
  secretDescriptors: PreparedComputeSecretDescriptor[];
}

export interface ClaimedComputeInputArtifact {
  artifactId: string;
  storageKey: string;
  mountPath: string;
  sha256: string;
  sizeBytes: string;
  mediaType: string;
}

export interface ClaimedComputeRun {
  claimed: true;
  recovered: boolean;
  run: ComputeRun;
  inputArtifacts: ClaimedComputeInputArtifact[];
  capturePaths: string[];
}

export type ComputeRunClaim = ClaimedComputeRun | {
  claimed: false;
  reason: "not_found" | "already_claimed" | "cancelled" | "busy";
};

function positiveInteger(
  value: string | number | bigint,
  field: string,
): string {
  const normalized = String(value);
  if (!POSITIVE_INTEGER.test(normalized)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return BigInt(normalized).toString();
}

function nonNegativeInteger(
  value: string | number | bigint,
  field: string,
): string {
  const normalized = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return BigInt(normalized).toString();
}

function exactText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (
    !normalized || normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new Error(`${field} is invalid`);
  return normalized;
}

function sha256(value: unknown, field: string, prefix: boolean): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value.trim())) {
    throw new Error(`${field} must be a SHA-256 digest`);
  }
  const normalized = value.trim().toLowerCase().replace(/^sha256:/, "");
  return prefix ? `sha256:${normalized}` : normalized;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function optionalUuid(value: unknown, field: string): string | null {
  return value === undefined || value === null
    ? null
    : requireComputeUuid(value, field);
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`${field} contains unsupported field ${unexpected}`);
}

function canonicalTool(value: unknown): ComputeToolSelection {
  const tool = plainRecord(value, "tool");
  onlyKeys(tool, ["id"], "tool");
  if (typeof tool.id !== "string" || !TOOL_ID_PATTERN.test(tool.id)) {
    throw new Error("tool.id is invalid");
  }
  if (!BASE_TOOLS.has(tool.id)) {
    throw new Error(`tool ${tool.id} is not in the developer-v1 base catalog`);
  }
  return { id: tool.id };
}

function workspaceRelativePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 1024 ||
    value.startsWith("/") || value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) throw new Error(`${field} must be a relative path under /workspace`);
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) throw new Error(`${field} must remain under /workspace`);
  return segments.join("/");
}

export function canonicalizeComputeExecutionRequest(
  value: unknown,
): ComputeExecutionRequest {
  const request = plainRecord(value, "request");
  onlyKeys(request, [
    "argv",
    "tools",
    "secretBindingIds",
    "cwd",
    "stdin",
    "capturePaths",
    "inputArtifacts",
    "timeoutMs",
  ], "request");
  if (!Array.isArray(request.argv) || request.argv.length < 1 || request.argv.length > MAX_ARGV) {
    throw new Error(`request.argv must contain 1-${MAX_ARGV} arguments`);
  }
  const argv = request.argv.map((argument, index) => {
    if (
      typeof argument !== "string" || argument.length === 0 ||
      argument.includes("\u0000") || argument.length > 4096
    ) throw new Error(`request.argv[${index}] is invalid`);
    return argument;
  });
  if (new TextEncoder().encode(JSON.stringify(argv)).byteLength > MAX_ARG_BYTES) {
    throw new Error("request.argv is too large");
  }
  if (!Array.isArray(request.tools) || request.tools.length > 64) {
    throw new Error("request.tools must be an array with at most 64 entries");
  }
  const toolsById = new Map<string, ComputeToolSelection>();
  for (const value of request.tools) {
    const tool = canonicalTool(value);
    const previous = toolsById.get(tool.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(tool)) {
      throw new Error(`tool ${tool.id} has conflicting descriptors`);
    }
    toolsById.set(tool.id, tool);
  }
  const tools = [...toolsById.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const secretBindingIds = canonicalUuidList(
    request.secretBindingIds,
    "request.secretBindingIds",
    50,
  );
  const cwd = request.cwd === "."
    ? "."
    : workspaceRelativePath(request.cwd, "request.cwd");
  const stdinValue = plainRecord(request.stdin, "request.stdin");
  let stdin: ComputeExecutionRequest["stdin"];
  if (stdinValue.kind === "none") {
    onlyKeys(stdinValue, ["kind"], "request.stdin");
    stdin = { kind: "none" };
  } else if (stdinValue.kind === "text") {
    onlyKeys(stdinValue, ["kind", "text"], "request.stdin");
    if (typeof stdinValue.text !== "string") {
      throw new Error("request.stdin.text must be a string");
    }
    if (new TextEncoder().encode(stdinValue.text).byteLength > MAX_STDIN_BYTES) {
      throw new Error("request.stdin.text is too large");
    }
    stdin = { kind: "text", text: stdinValue.text };
  } else {
    throw new Error("request.stdin.kind is invalid");
  }
  if (
    !Array.isArray(request.capturePaths) ||
    request.capturePaths.length > MAX_WORKSPACE_PATHS
  ) throw new Error("request.capturePaths must be an array with at most 100 paths");
  const capturePaths = Array.from(new Set(request.capturePaths.map(
    (path, index) => workspaceRelativePath(path, `request.capturePaths[${index}]`),
  ))).sort();
  if (
    !Array.isArray(request.inputArtifacts) ||
    request.inputArtifacts.length > MAX_WORKSPACE_PATHS
  ) throw new Error("request.inputArtifacts must have at most 100 entries");
  const artifactIds = new Set<string>();
  const mountPaths = new Set<string>();
  const inputArtifacts = request.inputArtifacts.map((value, index) => {
    const artifact = plainRecord(value, `request.inputArtifacts[${index}]`);
    onlyKeys(
      artifact,
      ["artifactId", "mountPath"],
      `request.inputArtifacts[${index}]`,
    );
    const artifactId = requireComputeUuid(
      artifact.artifactId,
      `request.inputArtifacts[${index}].artifactId`,
    );
    const mountPath = workspaceRelativePath(
      artifact.mountPath,
      `request.inputArtifacts[${index}].mountPath`,
    );
    if (artifactIds.has(artifactId) || mountPaths.has(mountPath)) {
      throw new Error("input artifact IDs and mount paths must be unique");
    }
    artifactIds.add(artifactId);
    mountPaths.add(mountPath);
    return { artifactId, mountPath };
  }).sort((left, right) => left.mountPath.localeCompare(right.mountPath));
  if (
    typeof request.timeoutMs !== "number" ||
    !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1_000 ||
    request.timeoutMs > COMPUTE_MAX_TIMEOUT_MS
  ) throw new Error("request.timeoutMs is outside the developer-v1 range");
  return {
    argv,
    tools,
    secretBindingIds,
    cwd,
    stdin,
    capturePaths,
    inputArtifacts,
    timeoutMs: request.timeoutMs,
  };
}

function canonicalToolIdList(
  value: unknown,
  field: string,
): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error(`${field} must contain 1-64 exact tool IDs`);
  }
  return Array.from(new Set(value.map((tool, index) => {
    if (
      typeof tool !== "string" || !TOOL_ID_PATTERN.test(tool) ||
      !BASE_TOOLS.has(tool)
    ) {
      throw new Error(`${field}[${index}] is invalid`);
    }
    return tool;
  }))).sort();
}

export function canonicalizeComputeManifestCeiling(
  value: unknown,
): ComputeManifestCeiling {
  const ceiling = plainRecord(value, "manifestCeiling");
  onlyKeys(
    ceiling,
    ["allowedTools", "maxTimeoutMs", "revision"],
    "manifestCeiling",
  );
  if (
    typeof ceiling.maxTimeoutMs !== "number" ||
    !Number.isSafeInteger(ceiling.maxTimeoutMs) ||
    ceiling.maxTimeoutMs < 1_000 || ceiling.maxTimeoutMs > COMPUTE_MAX_TIMEOUT_MS
  ) throw new Error("manifestCeiling.maxTimeoutMs is invalid");
  return {
    allowedTools: canonicalToolIdList(
      ceiling.allowedTools,
      "manifestCeiling.allowedTools",
    ),
    maxTimeoutMs: ceiling.maxTimeoutMs,
    revision: exactText(ceiling.revision, "manifestCeiling.revision", 128),
  };
}

function canonicalUuidList(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${field} must be an array with at most ${max} UUIDs`);
  }
  return Array.from(
    new Set(value.map((entry) => requireComputeUuid(entry, field))),
  ).sort();
}

function executionRequestFromRow(value: unknown): ComputeExecutionRequest {
  return canonicalizeComputeExecutionRequest(value);
}

function policyLimitsFromRow(value: unknown): ComputePolicyLimitsSnapshot {
  const limits = plainRecord(value, "policy limits snapshot");
  const maxTimeoutMs = Number(limits.maxTimeoutMs);
  const maxConcurrency = Number(limits.maxConcurrency);
  const maxArtifacts = Number(limits.maxArtifacts);
  if (
    !Number.isSafeInteger(maxTimeoutMs) || !Number.isSafeInteger(maxConcurrency) ||
    !Number.isSafeInteger(maxArtifacts)
  ) throw new Error("Compute run returned invalid policy limits");
  return {
    allowedTools: canonicalToolIdList(limits.allowedTools, "policy allowedTools"),
    maxTimeoutMs,
    maxConcurrency,
    maxArtifactBytes: nonNegativeInteger(
      limits.maxArtifactBytes as string | number | bigint,
      "policy maxArtifactBytes",
    ),
    maxArtifacts,
    revision: positiveInteger(
      limits.revision as string | number | bigint,
      "policy revision",
    ),
  };
}

function mapRun(row: Record<string, unknown>): ComputeRun {
  const operation = "Compute run";
  const state = requiredString(row, "state", operation);
  if (!STATES.has(state)) throw new Error("Compute run returned an invalid state");
  const profile = requiredString(row, "profile", operation);
  if (profile !== COMPUTE_PROFILE) {
    throw new Error("Compute run returned an unsupported profile");
  }
  const billingMode = requiredString(row, "billing_mode", operation);
  if (billingMode !== "wallet" && billingMode !== "subscription_capacity") {
    throw new Error("Compute run returned an invalid billing mode");
  }
  return {
    id: requiredString(row, "id", operation),
    receiptId: requiredString(row, "receipt_id", operation),
    leaseId: requiredString(row, "lease_id", operation),
    userId: requiredString(row, "user_id", operation),
    agentId: requiredString(row, "agent_id", operation),
    callerFunction: requiredString(row, "caller_function", operation),
    executionId: nullableString(row, "execution_id"),
    directiveHash: requiredString(row, "directive_hash", operation),
    profile,
    environmentDigest: requiredString(row, "environment_digest", operation),
    billingMode,
    capacityAgentId: requiredString(row, "capacity_agent_id", operation),
    capacityReservationId: nullableString(row, "capacity_reservation_id"),
    request: executionRequestFromRow(row.execution_request),
    manifestCeiling: canonicalizeComputeManifestCeiling(row.manifest_ceiling),
    policyLimits: policyLimitsFromRow(row.policy_limits_snapshot),
    authorityEpoch: integerString(row, "authority_epoch", operation),
    state: state as ComputeRunState,
    stateVersion: integerString(row, "state_version", operation),
    expiresAt: requiredString(row, "expires_at", operation),
    stopRequestedAt: nullableString(row, "stop_requested_at"),
    stopReason: nullableString(row, "stop_reason"),
    startedAt: nullableString(row, "started_at"),
    finishedAt: nullableString(row, "finished_at"),
    terminalReason: nullableString(row, "terminal_reason"),
    exitCode: row.exit_code === null || row.exit_code === undefined
      ? null
      : Number(row.exit_code),
    stdout: row.stdout === null || row.stdout === undefined
      ? null
      : String(row.stdout),
    stderr: row.stderr === null || row.stderr === undefined
      ? null
      : String(row.stderr),
    stdoutBytes: row.stdout_bytes === null || row.stdout_bytes === undefined
      ? null
      : integerString(row, "stdout_bytes", operation),
    stderrBytes: row.stderr_bytes === null || row.stderr_bytes === undefined
      ? null
      : integerString(row, "stderr_bytes", operation),
    stdoutTruncated: typeof row.stdout_truncated === "boolean"
      ? row.stdout_truncated
      : null,
    stderrTruncated: typeof row.stderr_truncated === "boolean"
      ? row.stderr_truncated
      : null,
    executionMetrics: row.execution_metrics === null ||
        row.execution_metrics === undefined
      ? null
      : plainRecord(row.execution_metrics, "execution metrics"),
    terminalError: nullableString(row, "terminal_error"),
    createdAt: requiredString(row, "created_at", operation),
    updatedAt: requiredString(row, "updated_at", operation),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

async function digestRequest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(stableValue(value))),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function admitComputeRun(input: {
  idempotencyKey: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  executionId?: string | null;
  directiveHash: string;
  environmentDigest: string;
  billingMode: "wallet" | "subscription_capacity";
  capacityAgentId: string;
  manifestCeiling: ComputeManifestCeiling | unknown;
  request: ComputeExecutionRequest | unknown;
  expiresAt: string;
  authorities?: readonly (ComputeAuthority | unknown)[];
}, deps: ComputeDatabaseDeps = {}): Promise<AdmittedComputeRun> {
  const normalized = {
    idempotencyKey: requireComputeUuid(input.idempotencyKey, "idempotencyKey"),
    userId: requireComputeUuid(input.userId, "userId"),
    agentId: requireComputeUuid(input.agentId, "agentId"),
    callerFunction: requireComputeCallerFunction(input.callerFunction),
    executionId: input.executionId === undefined || input.executionId === null
      ? null
      : requireComputeUuid(input.executionId, "executionId"),
    directiveHash: sha256(input.directiveHash, "directiveHash", false),
    environmentDigest: sha256(
      input.environmentDigest,
      "environmentDigest",
      true,
    ),
    billingMode: input.billingMode,
    capacityAgentId: requireComputeUuid(
      input.capacityAgentId,
      "capacityAgentId",
    ),
    request: canonicalizeComputeExecutionRequest(input.request),
    manifestCeiling: canonicalizeComputeManifestCeiling(input.manifestCeiling),
    expiresAt: isoTimestamp(input.expiresAt, "expiresAt"),
    authorities: canonicalizeComputeAuthorities(input.authorities ?? []),
  };
  if (
    normalized.billingMode !== "wallet" &&
    normalized.billingMode !== "subscription_capacity"
  ) throw new Error("billingMode is invalid");
  const authorities = normalized.authorities.map(authorityToDatabaseValue);
  // Expiry is server scheduling metadata derived from wall clock, not part of
  // the caller's semantic request. Keeping it in the digest made a retry of
  // the same stable idempotency key conflict a few milliseconds later.
  const { expiresAt: _expiresAt, ...semanticAdmission } = normalized;
  const requestHash = await digestRequest({
    ...semanticAdmission,
    profile: COMPUTE_PROFILE,
    authorities,
  });
  const payload = await callComputeRpc("admit_compute_run", {
    p_idempotency_key: normalized.idempotencyKey,
    p_request_hash: requestHash,
    p_user_id: normalized.userId,
    p_agent_id: normalized.agentId,
    p_caller_function: normalized.callerFunction,
    p_execution_id: normalized.executionId,
    p_directive_hash: normalized.directiveHash,
    p_profile: COMPUTE_PROFILE,
    p_environment_digest: normalized.environmentDigest,
    p_billing_mode: normalized.billingMode,
    p_capacity_agent_id: normalized.capacityAgentId,
    p_execution_request: normalized.request,
    p_manifest_ceiling: normalized.manifestCeiling,
    p_expires_at: normalized.expiresAt,
    p_authorities: authorities,
  }, deps);
  const row = firstComputeRow(payload, "Admit Compute run");
  return { run: mapRun(row), replayed: row.replayed === true };
}

export async function claimComputeRun(input: {
  runId: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeRunClaim> {
  const payload = await callComputeRpc("claim_compute_run", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
  }, deps);
  const row = firstComputeRow(payload, "Claim Compute run");
  if (row.claimed !== true) {
    const reason = row.reason;
    if (
      reason !== "not_found" && reason !== "already_claimed" &&
      reason !== "cancelled" && reason !== "busy"
    ) throw new Error("Claim Compute run returned an invalid refusal");
    return { claimed: false, reason };
  }
  const inputs = Array.isArray(row.input_artifacts) ? row.input_artifacts : [];
  const capturePaths = Array.isArray(row.capture_paths) &&
      row.capture_paths.every((value) => typeof value === "string")
    ? row.capture_paths as string[]
    : [];
  return {
    claimed: true,
    recovered: row.recovered === true,
    run: mapRun(row),
    inputArtifacts: inputs.map((value) => {
      const artifact = plainRecord(value, "claimed input artifact");
      return {
        artifactId: requiredString(artifact, "artifact_id", "claimed input"),
        storageKey: requiredString(artifact, "storage_key", "claimed input"),
        mountPath: requiredString(artifact, "mount_path", "claimed input"),
        sha256: requiredString(artifact, "sha256", "claimed input"),
        sizeBytes: integerString(artifact, "size_bytes", "claimed input"),
        mediaType: requiredString(artifact, "media_type", "claimed input"),
      };
    }),
    capturePaths,
  };
}

function secretDescriptors(value: unknown): PreparedComputeSecretDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = plainRecord(entry, "secret descriptor");
    const delivery = requiredString(row, "delivery", "secret descriptor");
    if (delivery !== "raw_env" && delivery !== "raw_file") {
      throw new Error("Prepare Compute lease returned a non-materialized secret");
    }
    return {
      bindingId: requiredString(row, "binding_id", "secret descriptor"),
      bindingVersion: integerString(
        row,
        "binding_version",
        "secret descriptor",
      ),
      name: requiredString(row, "name", "secret descriptor"),
      variableName: requiredString(row, "variable_name", "secret descriptor"),
      delivery: delivery === "raw_env"
        ? {
          kind: "raw_env" as const,
          envName: requiredString(row, "env_name", "secret descriptor"),
        }
        : {
          kind: "raw_file" as const,
          fileName: requiredString(row, "file_name", "secret descriptor"),
        },
    };
  });
}

function secretDescriptorDatabaseSnapshot(
  descriptors: readonly PreparedComputeSecretDescriptor[],
): Array<Record<string, unknown>> {
  return descriptors.map((descriptor) => ({
    binding_id: descriptor.bindingId,
    binding_version: descriptor.bindingVersion,
    name: descriptor.name,
    variable_name: descriptor.variableName,
    delivery: descriptor.delivery.kind,
    env_name: descriptor.delivery.kind === "raw_env"
      ? descriptor.delivery.envName
      : null,
    file_name: descriptor.delivery.kind === "raw_file"
      ? descriptor.delivery.fileName
      : null,
  }));
}

export async function getComputeRunSecretDescriptors(input: {
  runId: string;
  containerId: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeRunSecretDescriptorSnapshot> {
  const payload = await callComputeRpc("get_compute_run_secret_descriptors", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_container_id: exactText(input.containerId, "containerId", 256),
  }, deps);
  const row = firstComputeRow(payload, "Get Compute run secret descriptors");
  return {
    run: mapRun(row),
    secretDescriptors: secretDescriptors(row.secret_bindings),
  };
}

function finiteNumber(
  row: Record<string, unknown>,
  field: string,
  operation: string,
): number {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${operation} returned invalid ${field}`);
  }
  return parsed;
}

function mapBudget(value: unknown): ComputeRunBudgetReservation {
  const row = plainRecord(value, "budget reservation");
  const status = requiredString(row, "status", "budget reservation");
  if (
    status !== "reserved" && status !== "settlement_pending" &&
    status !== "settled" && status !== "released"
  ) {
    throw new Error("budget reservation returned an invalid status");
  }
  const billingMode = requiredString(row, "billing_mode", "budget reservation");
  if (billingMode !== "wallet" && billingMode !== "subscription_capacity") {
    throw new Error("budget reservation returned an invalid billing mode");
  }
  return {
    id: requiredString(row, "id", "budget reservation"),
    runId: requiredString(row, "run_id", "budget reservation"),
    billingMode,
    holdId: nullableString(row, "hold_id"),
    capacityAgentId: requiredString(
      row,
      "capacity_agent_id",
      "budget reservation",
    ),
    capacityReservationId: nullableString(row, "capacity_reservation_id"),
    rateVersion: COMPUTE_RATE_VERSION,
    rateLightPerMs: finiteNumber(
      row,
      "rate_light_per_ms",
      "budget reservation",
    ),
    reservedWallMs: integerString(
      row,
      "reserved_wall_ms",
      "budget reservation",
    ),
    reservedLight: finiteNumber(row, "reserved_light", "budget reservation"),
    actualWallMs: row.actual_wall_ms === null || row.actual_wall_ms === undefined
      ? null
      : integerString(row, "actual_wall_ms", "budget reservation"),
    actualLight: finiteNumber(row, "actual_light", "budget reservation"),
    releasedLight: finiteNumber(row, "released_light", "budget reservation"),
    status,
    expiresAt: requiredString(row, "expires_at", "budget reservation"),
  };
}

export async function prepareComputeRunLease(input: {
  runId: string;
  containerId: string;
  expectedSecretDescriptors: readonly PreparedComputeSecretDescriptor[];
  replaceExistingToken?: boolean;
  preparedToken?: PreparedComputeJobToken;
}, deps: ComputeDatabaseDeps = {}): Promise<PreparedComputeLease> {
  const prepared = input.preparedToken ?? await prepareComputeJobToken(deps);
  const payload = await callComputeRpc("prepare_compute_run_lease", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_container_id: exactText(input.containerId, "containerId", 256),
    p_token_id: crypto.randomUUID(),
    p_token_lookup_id: prepared.lookupId,
    p_token_digest: prepared.digest,
    p_token_audience: COMPUTE_JOB_TOKEN_AUDIENCE,
    p_expected_secret_bindings: secretDescriptorDatabaseSnapshot(
      input.expectedSecretDescriptors,
    ),
    p_replace_existing_token: input.replaceExistingToken === true,
  }, deps);
  const row = firstComputeRow(payload, "Prepare Compute run lease");
  const returnedLookupId = requiredString(
    row,
    "token_lookup_id",
    "Prepare Compute run lease",
  );
  return {
    run: mapRun(row),
    token: returnedLookupId === prepared.lookupId ? prepared.token : null,
    tokenLookupId: returnedLookupId,
    tokenExpiresAt: requiredString(
      row,
      "token_expires_at",
      "Prepare Compute run lease",
    ),
    replayed: row.replayed === true,
    budget: mapBudget(row.budget_reservation),
    secretDescriptors: secretDescriptors(row.secret_bindings),
  };
}

export async function heartbeatComputeRun(input: {
  runId: string;
  leaseId: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeRun> {
  const payload = await callComputeRpc("heartbeat_compute_run", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_lease_id: requireComputeUuid(input.leaseId, "leaseId"),
  }, deps);
  return mapRun(firstComputeRow(payload, "Heartbeat Compute run"));
}

export async function transitionComputeRun(input: {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  claimId?: string | null;
  expectedState: ComputeRunState;
  expectedStateVersion: string | number | bigint;
  toState: ComputeRunState;
  workerWallMs?: string | number | bigint | null;
  terminalReason?: string | null;
}, deps: ComputeDatabaseDeps = {}): Promise<{
  run: ComputeRun;
  receipt: ComputeRunReceipt | null;
}> {
  if (!STATES.has(input.expectedState) || !STATES.has(input.toState)) {
    throw new Error("invalid Compute run state");
  }
  const payload = await callComputeRpc("transition_compute_run", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_user_id: requireComputeUuid(input.userId, "userId"),
    p_agent_id: requireComputeUuid(input.agentId, "agentId"),
    p_caller_function: requireComputeCallerFunction(input.callerFunction),
    p_claim_id: optionalUuid(input.claimId, "claimId"),
    p_expected_state: input.expectedState,
    p_expected_state_version: positiveInteger(
      input.expectedStateVersion,
      "expectedStateVersion",
    ),
    p_to_state: input.toState,
    p_worker_wall_ms: input.workerWallMs === undefined ||
        input.workerWallMs === null
      ? null
      : nonNegativeInteger(input.workerWallMs, "workerWallMs"),
    p_terminal_reason: input.terminalReason === undefined ||
        input.terminalReason === null
      ? null
      : exactText(input.terminalReason, "terminalReason", 1024),
    p_result: {},
  }, deps);
  const row = firstComputeRow(payload, "Transition Compute run");
  await settleComputeCapacityFromTerminalPayload(payload, deps);
  return { run: mapRun(row), receipt: row.receipt ? mapReceipt(row.receipt) : null };
}

async function terminalResponse(
  value: unknown,
  operation: string,
  deps: ComputeDatabaseDeps,
): Promise<{
  run: ComputeRun;
  receipt: ComputeRunReceipt | null;
}> {
  await settleComputeCapacityFromTerminalPayload(value, deps);
  const row = firstComputeRow(value, operation);
  return {
    run: mapRun(row),
    receipt: row.receipt ? mapReceipt(row.receipt) : null,
  };
}

function ownerFilters(input: {
  runId?: string;
  userId: string;
  agentId: string;
  callerFunction: string;
}): string[] {
  const filters = [
    `user_id=eq.${encodeURIComponent(requireComputeUuid(input.userId, "userId"))}`,
    `agent_id=eq.${encodeURIComponent(requireComputeUuid(input.agentId, "agentId"))}`,
    `caller_function=eq.${
      encodeURIComponent(requireComputeCallerFunction(input.callerFunction))
    }`,
  ];
  if (input.runId) {
    filters.push(
      `id=eq.${encodeURIComponent(requireComputeUuid(input.runId, "runId"))}`,
    );
  }
  return filters;
}

export async function getComputeRun(input: {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeRun | null> {
  const rows = await queryComputeRows(
    `compute_runs?${ownerFilters(input).join("&")}&select=*&limit=1`,
    deps,
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** Trusted control-plane lookup; never expose this unscoped helper to HTTP. */
export async function getComputeRunByIdInternal(
  runId: string,
  deps: ComputeDatabaseDeps = {},
): Promise<ComputeRun | null> {
  const rows = await queryComputeRows(
    `compute_runs?id=eq.${encodeURIComponent(requireComputeUuid(runId, "runId"))}&select=*&limit=1`,
    deps,
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

/** Active bodies for trusted revocation workflows such as Agent deletion. */
export async function listActiveComputeRunsForAgentInternal(
  input: { userId: string; agentId: string },
  deps: ComputeDatabaseDeps = {},
): Promise<ComputeRun[]> {
  const userId = requireComputeUuid(input.userId, "userId");
  const agentId = requireComputeUuid(input.agentId, "agentId");
  const rows = await queryComputeRows(
    `compute_runs?user_id=eq.${encodeURIComponent(userId)}` +
      `&agent_id=eq.${encodeURIComponent(agentId)}` +
      `&state=in.(provisioning,running)&select=*&order=created_at.asc`,
    deps,
  );
  return rows.map(mapRun);
}

export async function listComputeRuns(input: {
  userId: string;
  agentId: string;
  callerFunction: string;
  limit?: number;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeRun[]> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be between 1 and 100");
  }
  const rows = await queryComputeRows(
    `compute_runs?${ownerFilters(input).join("&")}&select=*&order=created_at.desc&limit=${limit}`,
    deps,
  );
  return rows.map(mapRun);
}

export async function getComputeRunReceipt(input: {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeRunReceipt | null> {
  const run = await getComputeRun(input, deps);
  if (!run) return null;
  const rows = await queryComputeRows(
    `compute_run_receipts?run_id=eq.${encodeURIComponent(run.id)}&select=*&limit=1`,
    deps,
  );
  return rows[0] ? mapReceipt(rows[0]) : null;
}

export async function getComputeRunBudget(input: {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeRunBudgetReservation | null> {
  const run = await getComputeRun(input, deps);
  if (!run) return null;
  const rows = await queryComputeRows(
    `compute_run_budget_reservations?run_id=eq.${encodeURIComponent(run.id)}` +
      `&user_id=eq.${encodeURIComponent(run.userId)}&select=*&limit=1`,
    deps,
  );
  return rows[0] ? mapBudget(rows[0]) : null;
}

export interface ComputeRunView {
  run: ComputeRun;
  artifacts: ComputeArtifact[];
  receipt: ComputeRunReceipt | null;
}

export async function getComputeRunView(input: {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeRunView | null> {
  const run = await getComputeRun(input, deps);
  if (!run) return null;
  const [artifactRows, receipt] = await Promise.all([
    queryComputeRows(
      `compute_artifacts?run_id=eq.${encodeURIComponent(run.id)}` +
        `&user_id=eq.${encodeURIComponent(run.userId)}` +
        "&select=*&order=created_at.asc",
      deps,
    ),
    getComputeRunReceipt(input, deps),
  ]);
  return {
    run,
    artifacts: artifactRows.map(mapComputeArtifactRow),
    receipt,
  };
}

function mapReceipt(value: unknown): ComputeRunReceipt {
  const row = plainRecord(value, "receipt");
  const outcome = requiredString(row, "outcome", "receipt");
  if (
    outcome !== "succeeded" && outcome !== "failed" &&
    outcome !== "cancelled" && outcome !== "expired" && outcome !== "revoked"
  ) throw new Error("receipt returned an invalid outcome");
  const billingMode = requiredString(row, "billing_mode", "receipt");
  if (billingMode !== "wallet" && billingMode !== "subscription_capacity") {
    throw new Error("receipt returned an invalid billing mode");
  }
  const capacitySettlementStatus = requiredString(
    row,
    "capacity_settlement_status",
    "receipt",
  );
  if (
    capacitySettlementStatus !== "not_applicable" &&
    capacitySettlementStatus !== "pending" &&
    capacitySettlementStatus !== "settled"
  ) throw new Error("receipt returned an invalid capacity settlement status");
  return {
    id: requiredString(row, "id", "receipt"),
    runId: requiredString(row, "run_id", "receipt"),
    userId: requiredString(row, "user_id", "receipt"),
    agentId: requiredString(row, "agent_id", "receipt"),
    billingMode,
    holdId: nullableString(row, "hold_id"),
    capacityAgentId: requiredString(row, "capacity_agent_id", "receipt"),
    capacityReservationId: nullableString(row, "capacity_reservation_id"),
    capacitySettlementStatus,
    cloudUsageEventId: nullableString(row, "cloud_usage_event_id"),
    outcome,
    rateVersion: COMPUTE_RATE_VERSION,
    workerWallMs: row.worker_wall_ms === null || row.worker_wall_ms === undefined
      ? null
      : integerString(row, "worker_wall_ms", "receipt"),
    teardownAllowanceMs: integerString(
      row,
      "teardown_allowance_ms",
      "receipt",
    ),
    billedWallMs: integerString(row, "billed_wall_ms", "receipt"),
    reservedLight: finiteNumber(row, "reserved_light", "receipt"),
    actualLight: finiteNumber(row, "actual_light", "receipt"),
    releasedLight: finiteNumber(row, "released_light", "receipt"),
    createdAt: requiredString(row, "created_at", "receipt"),
  };
}

export async function completeComputeRun(input: {
  runId: string;
  leaseId: string;
  workerWallMs: string | number | bigint;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: string | number | bigint;
  stderrBytes: string | number | bigint;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  metrics: Record<string, unknown>;
  outputs: Array<{
    artifactId: string;
    path: string;
    storageKey: string;
    sha256: string;
    sizeBytes: string | number | bigint;
    mediaType: string;
    archive: "none" | "tar.gz";
  }>;
}, deps: ComputeDatabaseDeps = {}): Promise<{
  run: ComputeRun;
  receipt: ComputeRunReceipt | null;
}> {
  if (!Number.isSafeInteger(input.exitCode) || input.exitCode < 0 || input.exitCode > 255) {
    throw new Error("exitCode must be between 0 and 255");
  }
  if (
    typeof input.stdout !== "string" || typeof input.stderr !== "string" ||
    new TextEncoder().encode(input.stdout).byteLength > 1_048_576 ||
    new TextEncoder().encode(input.stderr).byteLength > 1_048_576
  ) throw new Error("stdout/stderr exceed the durable result limit");
  if (
    typeof input.stdoutTruncated !== "boolean" ||
    typeof input.stderrTruncated !== "boolean" ||
    input.metrics === null || typeof input.metrics !== "object" ||
    Array.isArray(input.metrics)
  ) throw new Error("completion metrics are invalid");
  const outputs = input.outputs.map((output, index) => {
    if (output.archive !== "none" && output.archive !== "tar.gz") {
      throw new Error(`outputs[${index}].archive is invalid`);
    }
    const mediaType = exactText(output.mediaType, `outputs[${index}].mediaType`, 255)
      .toLowerCase();
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/.test(mediaType)) {
      throw new Error(`outputs[${index}].mediaType is invalid`);
    }
    return {
      artifactId: requireComputeUuid(output.artifactId, `outputs[${index}].artifactId`),
      path: workspaceRelativePath(output.path, `outputs[${index}].path`),
      storageKey: exactText(output.storageKey, `outputs[${index}].storageKey`, 2048),
      sha256: sha256(output.sha256, `outputs[${index}].sha256`, false),
      sizeBytes: nonNegativeInteger(output.sizeBytes, `outputs[${index}].sizeBytes`),
      mediaType,
      archive: output.archive,
    };
  });
  const payload = await callComputeRpc("finalize_compute_worker_run", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_lease_id: requireComputeUuid(input.leaseId, "leaseId"),
    p_to_state: "succeeded",
    p_worker_wall_ms: nonNegativeInteger(input.workerWallMs, "workerWallMs"),
    p_terminal_reason: null,
    p_result: {
      exitCode: input.exitCode,
      stdout: input.stdout,
      stderr: input.stderr,
      stdoutBytes: nonNegativeInteger(input.stdoutBytes, "stdoutBytes"),
      stderrBytes: nonNegativeInteger(input.stderrBytes, "stderrBytes"),
      stdoutTruncated: input.stdoutTruncated,
      stderrTruncated: input.stderrTruncated,
      metrics: input.metrics,
      outputs,
    },
  }, deps);
  return await terminalResponse(payload, "Complete Compute run", deps);
}

export async function failComputeRun(input: {
  runId: string;
  leaseId?: string | null;
  workerWallMs?: string | number | bigint | null;
  code: string;
  message: string;
  metrics?: Record<string, unknown> | null;
}, deps: ComputeDatabaseDeps = {}): Promise<{
  run: ComputeRun;
  receipt: ComputeRunReceipt | null;
}> {
  const code = exactText(input.code, "code", 64);
  const message = exactText(input.message, "message", 900);
  if (
    input.metrics !== undefined && input.metrics !== null &&
    (typeof input.metrics !== "object" || Array.isArray(input.metrics))
  ) throw new Error("failure metrics are invalid");
  const payload = await callComputeRpc("finalize_compute_worker_run", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_lease_id: optionalUuid(input.leaseId, "leaseId"),
    p_to_state: code === "cancelled" ? "cancelled" : "failed",
    p_worker_wall_ms: input.workerWallMs === undefined ||
        input.workerWallMs === null
      ? null
      : nonNegativeInteger(input.workerWallMs, "workerWallMs"),
    p_terminal_reason: code,
    p_result: {
      error: `${code}: ${message}`,
      ...(input.metrics ? { metrics: input.metrics } : {}),
    },
  }, deps);
  return await terminalResponse(payload, "Fail Compute run", deps);
}

export async function requestComputeRunCancellation(input: {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  reason?: string;
}, deps: ComputeDatabaseDeps = {}): Promise<{
  run: ComputeRun;
  replayed: boolean;
}> {
  const payload = await callComputeRpc("request_compute_run_cancellation", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_user_id: requireComputeUuid(input.userId, "userId"),
    p_agent_id: requireComputeUuid(input.agentId, "agentId"),
    p_caller_function: requireComputeCallerFunction(input.callerFunction),
    p_reason: input.reason === undefined
      ? "owner_cancelled"
      : exactText(input.reason, "reason", 1024),
  }, deps);
  const row = firstComputeRow(payload, "Request Compute run cancellation");
  return { run: mapRun(row), replayed: row.replayed === true };
}

/** Call only after deterministic Sandbox destruction succeeds when claimed. */
export async function terminalizeComputeRunCancellation(input: {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  expectedStateVersion: string | number | bigint;
  bodyDestroyed: boolean;
}, deps: ComputeDatabaseDeps = {}): Promise<{
  run: ComputeRun;
  receipt: ComputeRunReceipt | null;
}> {
  if (typeof input.bodyDestroyed !== "boolean") {
    throw new Error("bodyDestroyed is required");
  }
  const payload = await callComputeRpc("terminalize_compute_run_cancellation", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_user_id: requireComputeUuid(input.userId, "userId"),
    p_agent_id: requireComputeUuid(input.agentId, "agentId"),
    p_caller_function: requireComputeCallerFunction(input.callerFunction),
    p_expected_state_version: positiveInteger(
      input.expectedStateVersion,
      "expectedStateVersion",
    ),
    p_body_destroyed: input.bodyDestroyed,
  }, deps);
  return await terminalResponse(
    payload,
    "Terminalize Compute run cancellation",
    deps,
  );
}
