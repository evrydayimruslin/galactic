import type {
  ComputeLaunchAgentReference,
  ComputeLaunchArtifactDownload,
  ComputeLaunchAuthorityRule,
  ComputeLaunchManifestCeiling,
  ComputeLaunchRunStatus,
  ComputeLaunchRunSummary,
  ComputeLaunchSecretBindingSummary,
  ComputeLaunchSecretDelivery,
  ComputeLaunchService,
  ComputeLaunchSettingsMutation,
  ComputeLaunchSettingsView,
} from "../handlers/launch-compute.ts";
import { ComputeLaunchServiceError } from "../handlers/launch-compute.ts";
import {
  COMPUTE_EXEC_PERMISSION,
  normalizeManifestComputeConfig,
  type ManifestComputeConfig,
} from "../../shared/contracts/compute.ts";
import type { AppManifest } from "../../shared/contracts/manifest.ts";
import { canonicalPlatformMcpToolName } from "./platform-mcp-authorization.ts";
import {
  type ComputeDatabaseDeps,
  ComputeControlPlaneError,
  queryComputeRows,
} from "./compute/database.ts";
import {
  getComputeAgentPolicy,
  listComputeAgentPolicyRules,
  replaceComputeAgentConfiguration,
  type ReplaceComputeAgentConfigurationInput,
  type ReplacedComputeAgentConfiguration,
} from "./compute/policies.ts";
import {
  getComputeRun,
  requestComputeRunCancellation,
  terminalizeComputeRunCancellation,
} from "./compute/runs.ts";
import { leaseComputeArtifactOwnerDownload } from "./compute/artifacts.ts";
import { mapComputeSecretBindingRow } from "./compute/secrets.ts";
import type {
  ComputeAgentPolicy,
  ComputeAgentPolicyRule,
  ComputeArtifact,
  ComputeAuthority,
  ComputeRun,
  ComputeSecretBinding,
} from "./compute/types.ts";
import { COMPUTE_MAX_TIMEOUT_MS } from "./compute/runs.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALLER_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "revoked",
]);
const DEFAULT_MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 10;
const SECRET_FILE_PREFIX = "/run/galactic/secrets/";
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

interface LaunchAgentRow {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  currentVersion: string;
  manifest: string | AppManifest | null;
  /** Encrypted values are deliberately opaque; only own-key presence is read. */
  envVars: Record<string, unknown>;
}

interface LiveManifestSnapshot {
  ceiling: ComputeLaunchManifestCeiling;
  config: ManifestComputeConfig | null;
  callerFunctions: string[];
  revision: string | null;
}

interface OwnerRunReadRow {
  id: string;
  receiptId: string;
  billingMode: "wallet" | "subscription_capacity";
  callerFunction: string;
  state: ComputeRun["state"];
  stateVersion: string;
  stopRequestedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  terminalReason: string | null;
  terminalError: string | null;
  exitCode: number | null;
  artifacts: Array<{
    id: string;
    direction: "input" | "output";
    logicalName: string;
    sizeBytes: string | null;
    state: "pending" | "ready" | "deleted";
    expiresAt: string | null;
  }>;
  receipt: {
    id: string;
    capacitySettlementStatus: "not_applicable" | "pending" | "settled";
    reservedLight: number;
    actualLight: number;
    releasedLight: number;
  } | null;
  budget: {
    reservedLight: number;
    actualLight: number;
    releasedLight: number;
    status: "reserved" | "settlement_pending" | "settled" | "released";
  } | null;
}

interface RunCursor {
  version: 1;
  createdAt: string;
  runId: string;
}

export interface ComputeLaunchCancellationInput {
  userId: string;
  agentId: string;
  run: ComputeRun;
}

/**
 * Privileged cancellation seam. Its implementation must first make the stop
 * durable, then destroy the deterministic body, and only then terminalize and
 * settle the run. The owner HTTP facade intentionally cannot perform those
 * steps independently.
 */
export interface ComputeLaunchCancellationOrchestrator {
  cancelActiveRun(input: ComputeLaunchCancellationInput): Promise<void>;
}

export interface ComputeLaunchBodyDestroyer {
  /** Destroy the Sandbox derived only from this canonical run id. */
  destroyRunBody(runId: string): Promise<void>;
}

export function createComputePlaneBodyDestroyer(plane: {
  cancelRun(message: unknown): Promise<{ destroyed: true }>;
}): ComputeLaunchBodyDestroyer {
  return {
    async destroyRunBody(runId: string): Promise<void> {
      if (!UUID_PATTERN.test(runId)) {
        throw launchError(
          "COMPUTE_RUN_INVALID",
          503,
          "Compute cancellation received an invalid run identity.",
        );
      }
      const result = await plane.cancelRun({ version: 1, run_id: runId });
      if (result?.destroyed !== true) {
        throw launchError(
          "COMPUTE_BODY_DESTRUCTION_FAILED",
          503,
          "Compute body destruction was not confirmed.",
        );
      }
    },
  };
}

/**
 * Production cancellation choreography. The durable stop fence is committed
 * before a claimed body is destroyed; settlement is attempted only after that
 * destruction succeeds. Unclaimed runs cannot have a body after the fence, so
 * they may be terminalized without asking the Compute Plane to instantiate a
 * nonexistent Sandbox merely to destroy it.
 */
export function createComputeLaunchCancellationOrchestrator(input: {
  bodyDestroyer: ComputeLaunchBodyDestroyer;
  database?: ComputeDatabaseDeps;
}): ComputeLaunchCancellationOrchestrator {
  const database = input.database ?? {};
  return {
    async cancelActiveRun({ userId, agentId, run }): Promise<void> {
      const fenced = await requestComputeRunCancellation({
        runId: run.id,
        userId,
        agentId,
        callerFunction: run.callerFunction,
        reason: "owner_cancelled",
      }, database);
      if (TERMINAL_STATES.has(fenced.run.state)) return;
      const claimed = fenced.run.state === "provisioning" ||
        fenced.run.state === "running";
      if (claimed) await input.bodyDestroyer.destroyRunBody(fenced.run.id);
      await terminalizeComputeRunCancellation({
        runId: fenced.run.id,
        userId,
        agentId,
        callerFunction: fenced.run.callerFunction,
        expectedStateVersion: fenced.run.stateVersion,
        bodyDestroyed: true,
      }, database);
    },
  };
}

interface ComputeLaunchOperations {
  queryRows(pathAndQuery: string): Promise<Record<string, unknown>[]>;
  getPolicy(input: { userId: string; agentId: string }): Promise<ComputeAgentPolicy | null>;
  listPolicyRules(input: {
    userId: string;
    agentId: string;
  }): Promise<ComputeAgentPolicyRule[]>;
  listSecretBindings(input: {
    userId: string;
    agentId: string;
  }): Promise<ComputeSecretBinding[]>;
  replaceConfiguration(
    input: ReplaceComputeAgentConfigurationInput,
  ): Promise<ReplacedComputeAgentConfiguration>;
  getRun(input: {
    runId: string;
    userId: string;
    agentId: string;
    callerFunction: string;
  }): Promise<ComputeRun | null>;
  leaseArtifactDownload(input: {
    artifactId: string;
    runId: string;
    userId: string;
    agentId: string;
    callerFunction: string;
  }): Promise<ComputeArtifact | null>;
  getArtifactObject(storageKey: string): Promise<R2ObjectBody | null>;
}

export interface CreateComputeLaunchServiceOptions {
  database?: ComputeDatabaseDeps;
  artifacts?: R2Bucket | null;
  cancellation?: ComputeLaunchCancellationOrchestrator | null;
  now?: () => Date;
  /** Focused test seam; production callers should use the core defaults. */
  operations?: Partial<ComputeLaunchOperations>;
}

function launchError(
  code: string,
  status: number,
  message: string,
  exposeMessage = false,
): ComputeLaunchServiceError {
  return new ComputeLaunchServiceError({
    code,
    status,
    message,
    exposeMessage,
  });
}

function normalizeSha256(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function hexDigest(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * R2 computes its checksum at upload time. Older upload paths also persist the
 * same digest in custom metadata, so that trusted metadata is the compatibility
 * fallback when a native checksum is unavailable. Any conflicting digest is a
 * storage integrity failure, even if the other source happens to match.
 */
function artifactObjectMatchesSha256(
  object: R2ObjectBody,
  expectedValue: string,
): boolean {
  const expected = normalizeSha256(expectedValue);
  if (!expected) return false;

  const nativeValue = object.checksums?.sha256;
  const native = nativeValue ? hexDigest(nativeValue) : null;
  const metadataValue = object.customMetadata?.sha256;
  const metadata = normalizeSha256(metadataValue);
  if (native !== null && native !== expected) return false;
  if (metadataValue !== undefined && metadata !== expected) return false;
  return native === expected || metadata === expected;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw launchError(
      "COMPUTE_SERVICE_INVALID_RESPONSE",
      503,
      `Compute persistence returned invalid ${label}.`,
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(
  row: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = row[field];
  if (typeof value !== "string" || !value) {
    throw launchError(
      "COMPUTE_SERVICE_INVALID_RESPONSE",
      503,
      `Compute persistence returned invalid ${label}.`,
    );
  }
  return value;
}

function nullableString(
  row: Record<string, unknown>,
  field: string,
): string | null {
  return typeof row[field] === "string" && row[field] ? row[field] as string : null;
}

function integerString(value: unknown, label: string): string {
  if (
    (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  ) return String(value);
  throw launchError(
    "COMPUTE_SERVICE_INVALID_RESPONSE",
    503,
    `Compute persistence returned invalid ${label}.`,
  );
}

function finiteNonNegative(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw launchError(
      "COMPUTE_SERVICE_INVALID_RESPONSE",
      503,
      `Compute persistence returned invalid ${label}.`,
    );
  }
  return parsed;
}

function relationOne(
  value: unknown,
  label: string,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length !== 1) {
      throw launchError(
        "COMPUTE_SERVICE_INVALID_RESPONSE",
        503,
        `Compute persistence returned duplicate ${label}.`,
      );
    }
    return record(value[0], label);
  }
  return record(value, label);
}

function relationMany(value: unknown, label: string): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw launchError(
      "COMPUTE_SERVICE_INVALID_RESPONSE",
      503,
      `Compute persistence returned invalid ${label}.`,
    );
  }
  return value.map((entry) => record(entry, label));
}

function mapAgentRow(row: Record<string, unknown>): LaunchAgentRow {
  const manifest = row.manifest;
  if (
    manifest !== null && typeof manifest !== "string" &&
    (typeof manifest !== "object" || Array.isArray(manifest))
  ) {
    throw launchError(
      "COMPUTE_SERVICE_INVALID_RESPONSE",
      503,
      "Agent manifest storage is invalid.",
    );
  }
  const envVars = row.env_vars === null || row.env_vars === undefined
    ? {}
    : record(row.env_vars, "Agent Variables");
  return {
    id: requiredString(row, "id", "Agent id"),
    ownerId: requiredString(row, "owner_id", "Agent owner"),
    slug: requiredString(row, "slug", "Agent slug"),
    name: requiredString(row, "name", "Agent name"),
    currentVersion: typeof row.current_version === "string"
      ? row.current_version.trim()
      : "",
    manifest: manifest as string | AppManifest | null,
    envVars,
  };
}

function parseManifest(value: LaunchAgentRow["manifest"]): AppManifest | null {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as AppManifest
      : null;
  } catch {
    return null;
  }
}

function liveManifestSnapshot(app: LaunchAgentRow): LiveManifestSnapshot {
  const manifest = parseManifest(app.manifest);
  const config = normalizeManifestComputeConfig(manifest?.compute);
  const hasPermission = manifest?.permissions?.includes(COMPUTE_EXEC_PERMISSION) === true;
  const callerFunctions = Object.entries(manifest?.functions ?? {})
    .filter(([name, fn]) => CALLER_PATTERN.test(name) && fn?.uses_compute === true)
    .map(([name]) => name)
    .sort();
  const valid = hasPermission && config !== null && app.currentVersion.length > 0 &&
    callerFunctions.length > 0;
  return {
    ceiling: {
      enabled: valid,
      profile: valid ? "developer-v1" : null,
      tools: valid ? [...config.tools] : [],
      secrets: valid ? [...(config.secrets ?? [])] : [],
    },
    config: valid ? config : null,
    callerFunctions: valid ? callerFunctions : [],
    revision: valid ? app.currentVersion : null,
  };
}

function mapAuthorityRule(rule: ComputeAgentPolicyRule): ComputeLaunchAuthorityRule {
  const constraints = rule.authority.constraints ?? {};
  if (Object.keys(constraints).length > 0) {
    throw launchError(
      "COMPUTE_CONFIGURATION_INTEGRITY_ERROR",
      503,
      "An active Compute authority cannot be represented by Launch.",
    );
  }
  if (rule.authority.action === "platform.call") {
    return {
      callerFunction: rule.callerFunction,
      decision: rule.decision,
      action: "platform.call",
      target: {
        functionName: canonicalPlatformMcpToolName(
          rule.authority.target.functionName,
        ),
      },
      version: rule.ruleVersion,
    };
  }
  if (rule.authority.action === "agents.call") {
    return {
      callerFunction: rule.callerFunction,
      decision: rule.decision,
      action: "agents.call",
      target: {
        agentId: rule.authority.target.agentId,
        functionName: rule.authority.target.functionName,
      },
      version: rule.ruleVersion,
    };
  }
  throw launchError(
    "COMPUTE_CONFIGURATION_INTEGRITY_ERROR",
    503,
    "An active Compute authority cannot be represented by Launch.",
  );
}

function launchDelivery(binding: ComputeSecretBinding): ComputeLaunchSecretDelivery {
  return binding.delivery.kind === "raw_env"
    ? { kind: "env", envName: binding.delivery.envName }
    : {
      kind: "file",
      path: `${SECRET_FILE_PREFIX}${binding.delivery.fileName}`,
    };
}

function collapseSecretBindings(
  bindings: readonly ComputeSecretBinding[],
  app: LaunchAgentRow,
): ComputeLaunchSecretBindingSummary[] {
  if (bindings.length === 0) return [];
  // Do not demand equality with today's manifest caller set here: a newly
  // promoted release can legitimately change uses_compute callers before the
  // owner reconciles settings. Every still-active copy must nevertheless have
  // one identical Agent-wide shape; the next atomic PUT rewrites the caller set.
  const grouped = new Map<string, ComputeSecretBinding[]>();
  for (const binding of bindings) {
    if (binding.status !== "active") {
      throw launchError(
        "COMPUTE_CONFIGURATION_INTEGRITY_ERROR",
        503,
        "Compute secret metadata unexpectedly included a revoked binding.",
      );
    }
    const list = grouped.get(binding.name) ?? [];
    list.push(binding);
    grouped.set(binding.name, list);
  }
  const summaries: ComputeLaunchSecretBindingSummary[] = [];
  for (const [name, copies] of grouped) {
    const first = copies[0];
    const shape = JSON.stringify([
      first.variableName,
      first.delivery,
      first.expiresAt,
    ]);
    if (
      new Set(copies.map((copy) => copy.callerFunction)).size !== copies.length ||
      copies.some((copy) =>
        JSON.stringify([copy.variableName, copy.delivery, copy.expiresAt]) !== shape
      )
    ) {
      throw launchError(
        "COMPUTE_CONFIGURATION_INTEGRITY_ERROR",
        503,
        "Compute secret metadata differs between live callers.",
      );
    }
    const version = copies.reduce((highest, copy) =>
      BigInt(copy.bindingVersion) > BigInt(highest) ? copy.bindingVersion : highest,
    "0");
    const updatedAt = copies.reduce<string | null>((latest, copy) =>
      latest === null || copy.updatedAt > latest ? copy.updatedAt : latest,
    null);
    summaries.push({
      name,
      delivery: launchDelivery(first),
      configured: Object.prototype.hasOwnProperty.call(app.envVars, first.variableName),
      version,
      updatedAt,
    });
  }
  return summaries.sort((left, right) => left.name.localeCompare(right.name));
}

function settingsView(input: {
  app: LaunchAgentRow;
  manifest: LiveManifestSnapshot;
  policy: ComputeAgentPolicy | null;
  rules: readonly ComputeAgentPolicyRule[];
  bindings: readonly ComputeSecretBinding[];
}): ComputeLaunchSettingsView {
  const { app, manifest, policy } = input;
  return {
    settings: {
      enabled: policy?.enabled === true && policy.state === "active",
      profile: "developer-v1",
      allowedTools: policy ? [...policy.allowedTools] : [...manifest.ceiling.tools],
      secretBindings: collapseSecretBindings(
        input.bindings,
        app,
      ),
      authorityRules: input.rules.map(mapAuthorityRule).sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ),
      limits: {
        maxTimeoutMs: policy?.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
        maxConcurrency: policy?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
        maxArtifactBytes: policy
          ? Number(policy.maxArtifactBytes)
          : DEFAULT_MAX_ARTIFACT_BYTES,
        maxArtifacts: policy?.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS,
      },
      manifestCeiling: manifest.ceiling,
      ownerConfirmedAt: policy?.ownerConfirmedAt ?? null,
      updatedAt: policy?.updatedAt ?? null,
    },
    revision: policy?.revision ?? "0",
  };
}

function mutationAuthority(
  rule: ComputeLaunchSettingsMutation["settings"]["authorityRules"][number],
): ComputeAuthority {
  return rule.action === "platform.call"
    ? {
      action: "platform.call",
      target: {
        kind: "platform_function",
        functionName: canonicalPlatformMcpToolName(rule.target.functionName),
      },
      constraints: {},
    }
    : {
      action: "agents.call",
      target: {
        kind: "agent_function",
        agentId: rule.target.agentId,
        functionName: rule.target.functionName,
      },
      constraints: {},
    };
}

function enforceLiveCeiling(
  mutation: ComputeLaunchSettingsMutation,
  manifest: LiveManifestSnapshot,
  app: LaunchAgentRow,
): void {
  if (mutation.settings.enabled && !manifest.ceiling.enabled) {
    throw launchError(
      "COMPUTE_NOT_DECLARED",
      422,
      "The live Agent release does not authorize Compute.",
      true,
    );
  }
  const liveTools = new Set(manifest.ceiling.tools);
  if (mutation.settings.allowedTools.some((tool) => !liveTools.has(tool))) {
    throw launchError(
      "TOOLS_OUTSIDE_MANIFEST",
      422,
      "A selected tool is outside the live Agent release ceiling.",
      true,
    );
  }
  const liveSecrets = new Set(manifest.ceiling.secrets);
  for (const binding of mutation.settings.secretBindings) {
    if (!liveSecrets.has(binding.name)) {
      throw launchError(
        "SECRET_OUTSIDE_MANIFEST",
        422,
        "A selected secret is outside the live Agent release ceiling.",
        true,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(app.envVars, binding.name)) {
      throw launchError(
        "COMPUTE_AGENT_VARIABLE_NOT_FOUND",
        422,
        `Agent Variable ${binding.name} is not configured.`,
        true,
      );
    }
  }
  const liveCallers = new Set(manifest.callerFunctions);
  if (
    mutation.settings.authorityRules.some((rule) =>
      !liveCallers.has(rule.callerFunction)
    )
  ) {
    throw launchError(
      "COMPUTE_CALLER_NOT_DECLARED",
      422,
      "Every authority rule must name an exact live Compute caller.",
      true,
    );
  }
}

function mapAgentWideSecretMutation(
  binding: ComputeLaunchSettingsMutation["settings"]["secretBindings"][number],
) {
  return {
    name: binding.name,
    // v1 intentionally binds a manifest secret name to the same exact Agent
    // Variable name. No value crosses this configuration interface.
    variableName: binding.name,
    delivery: binding.delivery.kind === "env"
      ? { kind: "raw_env" as const, envName: binding.delivery.envName }
      : {
        kind: "raw_file" as const,
        fileName: binding.delivery.path.slice(SECRET_FILE_PREFIX.length),
      },
    expiresAt: null,
  };
}

function mapRunState(
  state: ComputeRun["state"],
  receipt: OwnerRunReadRow["receipt"],
): ComputeLaunchRunStatus {
  if (
    TERMINAL_STATES.has(state) &&
    (!receipt || receipt.capacitySettlementStatus === "pending")
  ) return "settlement_pending";
  switch (state) {
    case "admitted":
    case "queued":
      return "queued";
    case "provisioning":
      return "starting";
    case "running":
      return "running";
    case "succeeded":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "expired":
    case "revoked":
      return "failed";
  }
}

function safeFailure(row: OwnerRunReadRow): ComputeLaunchRunSummary["infraFailure"] {
  if (row.state !== "failed" && row.state !== "expired" && row.state !== "revoked") {
    return null;
  }
  const raw = (row.terminalReason ?? row.state).toUpperCase().replace(
    /[^A-Z0-9_]/g,
    "_",
  ).slice(0, 64);
  const code = raw || "COMPUTE_FAILED";
  const retryable = new Set([
    "INTERNAL_ERROR",
    "IMAGE_UNAVAILABLE",
    "ARTIFACT_ERROR",
    "DEADLINE_EXCEEDED",
    "DISPATCH_DEAD_LETTER",
  ]).has(code);
  return {
    code,
    message: row.state === "expired"
      ? "The Compute run expired before it could complete."
      : row.state === "revoked"
      ? "The Compute run was revoked after its authority changed."
      : "The Compute environment could not complete this run.",
    retryable,
  };
}

function runSummary(
  row: OwnerRunReadRow,
  app: LaunchAgentRow,
  asOf: Date,
): ComputeLaunchRunSummary {
  const accounting = row.receipt ?? row.budget;
  const reserved = accounting?.reservedLight ?? 0;
  const actual = row.receipt
    ? row.receipt.actualLight
    : row.budget && row.budget.status !== "reserved"
    ? row.budget.actualLight
    : null;
  return {
    runId: row.id,
    receiptId: row.receiptId,
    receiptUrl: row.receipt && row.billingMode === "wallet"
      ? `/wallet?tab=receipts&receipt=${encodeURIComponent(row.receipt.id)}`
      : null,
    billingMode: row.billingMode,
    status: mapRunState(row.state, row.receipt),
    agentId: app.id,
    agentName: app.name,
    functionName: row.callerFunction,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    usage: {
      reserved,
      actual,
      trueUp: actual === null ? null : actual - reserved,
      unit: "Light",
    },
    exitCode: row.exitCode,
    infraFailure: safeFailure(row),
    artifacts: row.artifacts
      .filter((artifact) =>
        artifact.direction === "output" && artifact.state === "ready" &&
        artifact.sizeBytes !== null && artifact.expiresAt !== null &&
        Date.parse(artifact.expiresAt) > asOf.getTime()
      )
      .map((artifact) => ({
        id: artifact.id,
        name: artifact.logicalName,
        sizeBytes: Number(artifact.sizeBytes),
        expiresAt: artifact.expiresAt!,
        url: null,
      })),
    cancellable: !TERMINAL_STATES.has(row.state) && row.stopRequestedAt === null,
  };
}

function mapOwnerRunRow(row: Record<string, unknown>): OwnerRunReadRow {
  const state = requiredString(row, "state", "run state") as ComputeRun["state"];
  if (
    state !== "admitted" && state !== "queued" && state !== "provisioning" &&
    state !== "running" && state !== "succeeded" && state !== "failed" &&
    state !== "cancelled" && state !== "expired" && state !== "revoked"
  ) {
    throw launchError(
      "COMPUTE_SERVICE_INVALID_RESPONSE",
      503,
      "Compute persistence returned invalid run state.",
    );
  }
  const receiptRow = relationOne(row.receipt, "run receipt");
  const budgetRow = relationOne(row.budget, "run budget");
  const receipt = receiptRow
    ? {
      id: requiredString(receiptRow, "id", "receipt id"),
      capacitySettlementStatus: (() => {
        const value = requiredString(
          receiptRow,
          "capacity_settlement_status",
          "capacity settlement status",
        );
        if (
          value !== "not_applicable" && value !== "pending" &&
          value !== "settled"
        ) throw launchError(
          "COMPUTE_SERVICE_INVALID_RESPONSE",
          503,
          "Compute persistence returned invalid capacity settlement state.",
        );
        return value as "not_applicable" | "pending" | "settled";
      })(),
      reservedLight: finiteNonNegative(receiptRow.reserved_light, "receipt reservation"),
      actualLight: finiteNonNegative(receiptRow.actual_light, "receipt actual usage"),
      releasedLight: finiteNonNegative(receiptRow.released_light, "receipt release"),
    }
    : null;
  let budget: OwnerRunReadRow["budget"] = null;
  if (budgetRow) {
    const status = requiredString(budgetRow, "status", "budget status");
    if (
      status !== "reserved" && status !== "settlement_pending" &&
      status !== "settled" && status !== "released"
    ) {
      throw launchError(
        "COMPUTE_SERVICE_INVALID_RESPONSE",
        503,
        "Compute persistence returned invalid budget status.",
      );
    }
    budget = {
      reservedLight: finiteNonNegative(budgetRow.reserved_light, "budget reservation"),
      actualLight: finiteNonNegative(budgetRow.actual_light, "budget actual usage"),
      releasedLight: finiteNonNegative(budgetRow.released_light, "budget release"),
      status,
    };
  }
  const exitCode = row.exit_code === null || row.exit_code === undefined
    ? null
    : Number(row.exit_code);
  if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255)) {
    throw launchError(
      "COMPUTE_SERVICE_INVALID_RESPONSE",
      503,
      "Compute persistence returned invalid exit code.",
    );
  }
  return {
    id: requiredString(row, "id", "run id"),
    receiptId: requiredString(row, "receipt_id", "run receipt id"),
    billingMode: (() => {
      const value = requiredString(row, "billing_mode", "run billing mode");
      if (value !== "wallet" && value !== "subscription_capacity") {
        throw launchError(
          "COMPUTE_SERVICE_INVALID_RESPONSE",
          503,
          "Compute persistence returned invalid billing mode.",
        );
      }
      return value;
    })(),
    callerFunction: requiredString(row, "caller_function", "run caller"),
    state,
    stateVersion: integerString(row.state_version, "run state version"),
    stopRequestedAt: nullableString(row, "stop_requested_at"),
    createdAt: requiredString(row, "created_at", "run creation time"),
    startedAt: nullableString(row, "started_at"),
    finishedAt: nullableString(row, "finished_at"),
    terminalReason: nullableString(row, "terminal_reason"),
    terminalError: nullableString(row, "terminal_error"),
    exitCode,
    artifacts: relationMany(row.artifacts, "run artifacts").map((artifactRow) => {
      const direction = requiredString(
        artifactRow,
        "direction",
        "artifact direction",
      );
      const state = requiredString(artifactRow, "state", "artifact state");
      if (
        (direction !== "input" && direction !== "output") ||
        (state !== "pending" && state !== "ready" && state !== "deleted")
      ) {
        throw launchError(
          "COMPUTE_SERVICE_INVALID_RESPONSE",
          503,
          "Compute persistence returned invalid artifact metadata.",
        );
      }
      return {
        id: requiredString(artifactRow, "id", "artifact id"),
        direction,
        logicalName: requiredString(
          artifactRow,
          "logical_name",
          "artifact name",
        ),
        sizeBytes: artifactRow.size_bytes === null ||
            artifactRow.size_bytes === undefined
          ? null
          : integerString(artifactRow.size_bytes, "artifact size"),
        state,
        expiresAt: (() => {
          const value = nullableString(artifactRow, "expires_at");
          if (value !== null && !Number.isFinite(Date.parse(value))) {
            throw launchError(
              "COMPUTE_SERVICE_INVALID_RESPONSE",
              503,
              "Compute persistence returned an invalid artifact expiry.",
            );
          }
          return value;
        })(),
      };
    }),
    receipt,
    budget,
  };
}

function encodeCursor(cursor: RunCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string | null): RunCursor | null {
  if (value === null) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = record(
      JSON.parse(new TextDecoder().decode(bytes)),
      "run cursor",
    );
    const cursor: RunCursor = {
      version: 1,
      createdAt: requiredString(parsed, "createdAt", "run cursor timestamp"),
      runId: requiredString(parsed, "runId", "run cursor id"),
    };
    if (
      parsed.version !== 1 || Object.keys(parsed).length !== 3 ||
      !UUID_PATTERN.test(cursor.runId) ||
      !Number.isFinite(Date.parse(cursor.createdAt)) ||
      encodeCursor(cursor) !== value
    ) throw new Error("invalid cursor");
    return cursor;
  } catch (error) {
    if (
      error instanceof ComputeLaunchServiceError &&
      error.code !== "COMPUTE_SERVICE_INVALID_RESPONSE"
    ) throw error;
    throw launchError("INVALID_CURSOR", 400, "cursor is invalid", true);
  }
}

function ownerRunSelect(): string {
  return [
    "id",
    "receipt_id",
    "billing_mode",
    "caller_function",
    "state",
    "state_version",
    "stop_requested_at",
    "created_at",
    "started_at",
    "finished_at",
    "terminal_reason",
    "terminal_error",
    "exit_code",
    // The owner history read model deliberately never selects an R2 key. The
    // exact download path performs a separate owner/run/artifact lookup.
    "artifacts:compute_artifacts(id,direction,logical_name,size_bytes,state,expires_at)",
    "receipt:compute_run_receipts(id,capacity_settlement_status,reserved_light,actual_light,released_light)",
    "budget:compute_run_budget_reservations(reserved_light,actual_light,released_light,status)",
  ].join(",");
}

function mapCoreError(error: unknown): never {
  if (error instanceof ComputeLaunchServiceError) throw error;
  if (error instanceof ComputeControlPlaneError) {
    const conflict = error.code === "COMPUTE_POLICY_CONFLICT" ||
      error.code === "COMPUTE_RUN_CONFLICT" ||
      error.code === "COMPUTE_POLICY_NOT_ACTIVE";
    const notFound = error.code === "COMPUTE_RUN_NOT_FOUND" ||
      error.code === "COMPUTE_ARTIFACT_NOT_FOUND" ||
      error.code === "COMPUTE_AGENT_NOT_OWNED";
    const rejected = error.code.startsWith("COMPUTE_INVALID_") ||
      error.code === "COMPUTE_AGENT_VARIABLE_NOT_FOUND" ||
      error.code === "COMPUTE_TARGET_NOT_OWNED" ||
      error.code === "COMPUTE_CALLER_NOT_DECLARED";
    throw launchError(
      error.code,
      conflict
        ? 409
        : notFound
        ? 404
        : rejected
        ? 422
        : error.status === 429
        ? 429
        : 503,
      conflict
        ? "Compute state changed; refresh and retry."
        : notFound
        ? "Compute resource not found."
        : rejected
        ? "Compute settings were rejected."
        : "Compute management is temporarily unavailable.",
      conflict || rejected,
    );
  }
  throw launchError(
    "COMPUTE_SERVICE_UNAVAILABLE",
    503,
    "Compute management is temporarily unavailable.",
  );
}

export function createComputeLaunchService(
  options: CreateComputeLaunchServiceOptions = {},
): ComputeLaunchService {
  const database = options.database ?? {};
  const defaultQuery = (path: string) => queryComputeRows(path, database);
  const queryRows = options.operations?.queryRows ?? defaultQuery;
  const artifacts = options.artifacts ??
    ((globalThis as { __env?: { COMPUTE_ARTIFACTS?: R2Bucket } }).__env
      ?.COMPUTE_ARTIFACTS ?? null);
  const operations: ComputeLaunchOperations = {
    queryRows,
    getPolicy: options.operations?.getPolicy ??
      ((input) => getComputeAgentPolicy(input, database)),
    listPolicyRules: options.operations?.listPolicyRules ??
      ((input) => listComputeAgentPolicyRules(input, database)),
    listSecretBindings: options.operations?.listSecretBindings ??
      (async (input) => {
        const rows = await queryRows(
          `compute_agent_secret_bindings?user_id=eq.${encodeURIComponent(input.userId)}` +
            `&agent_id=eq.${encodeURIComponent(input.agentId)}` +
            "&status=eq.active&select=*&order=caller_function.asc,name.asc",
        );
        return rows.map(mapComputeSecretBindingRow);
      }),
    replaceConfiguration: options.operations?.replaceConfiguration ??
      ((input) => replaceComputeAgentConfiguration(input, database)),
    getRun: options.operations?.getRun ??
      ((input) => getComputeRun(input, database)),
    leaseArtifactDownload: options.operations?.leaseArtifactDownload ??
      ((input) => leaseComputeArtifactOwnerDownload(input, database)),
    getArtifactObject: options.operations?.getArtifactObject ??
      (async (storageKey) => artifacts ? await artifacts.get(storageKey) : null),
  };
  const now = options.now ?? (() => new Date());

  async function agentCandidates(
    locator: string,
    userId: string,
  ): Promise<LaunchAgentRow[]> {
    const filter = UUID_PATTERN.test(locator)
      ? `id=eq.${encodeURIComponent(locator)}`
      : `slug=eq.${encodeURIComponent(locator)}`;
    const rows = await operations.queryRows(
      `apps?${filter}&owner_id=eq.${encodeURIComponent(userId)}` +
        "&deleted_at=is.null" +
        "&select=id,owner_id,slug,name,current_version,manifest,env_vars&limit=1",
    );
    return rows.map(mapAgentRow);
  }

  async function ownedApp(userId: string, agentId: string): Promise<LaunchAgentRow> {
    const rows = await operations.queryRows(
      `apps?id=eq.${encodeURIComponent(agentId)}` +
        `&owner_id=eq.${encodeURIComponent(userId)}&deleted_at=is.null` +
        "&select=id,owner_id,slug,name,current_version,manifest,env_vars&limit=1",
    );
    if (rows.length !== 1) {
      throw launchError("AGENT_NOT_FOUND", 404, "Agent not found.");
    }
    return mapAgentRow(rows[0]);
  }

  async function configuration(
    userId: string,
    app: LaunchAgentRow,
  ): Promise<ComputeLaunchSettingsView> {
    const manifest = liveManifestSnapshot(app);
    const [policy, rules, bindings] = await Promise.all([
      operations.getPolicy({ userId, agentId: app.id }),
      operations.listPolicyRules({ userId, agentId: app.id }),
      operations.listSecretBindings({ userId, agentId: app.id }),
    ]);
    return settingsView({ app, manifest, policy, rules, bindings });
  }

  async function oneRunRow(
    userId: string,
    agentId: string,
    runId: string,
  ): Promise<OwnerRunReadRow | null> {
    const rows = await operations.queryRows(
      `compute_runs?id=eq.${encodeURIComponent(runId)}` +
        `&user_id=eq.${encodeURIComponent(userId)}` +
        `&agent_id=eq.${encodeURIComponent(agentId)}` +
        `&select=${encodeURIComponent(ownerRunSelect())}&limit=1`,
    );
    return rows[0] ? mapOwnerRunRow(rows[0]) : null;
  }

  return {
    async resolveAgent(
      locator,
      userId,
    ): Promise<ComputeLaunchAgentReference | null> {
      try {
        const candidates = await agentCandidates(locator, userId);
        if (candidates.length !== 1) return null;
        return { id: candidates[0].id, ownerUserId: candidates[0].ownerId };
      } catch (error) {
        return mapCoreError(error);
      }
    },

    async getSettings(input): Promise<ComputeLaunchSettingsView> {
      try {
        const app = await ownedApp(input.userId, input.agentId);
        return await configuration(input.userId, app);
      } catch (error) {
        return mapCoreError(error);
      }
    },

    async putSettings(input): Promise<ComputeLaunchSettingsView> {
      try {
        const app = await ownedApp(input.userId, input.agentId);
        const manifest = liveManifestSnapshot(app);
        enforceLiveCeiling(input.mutation, manifest, app);
        const current = await operations.getPolicy({
          userId: input.userId,
          agentId: input.agentId,
        });
        const actualRevision = current?.revision ?? "0";
        if (actualRevision !== input.mutation.expectedRevision) {
          throw launchError(
            "COMPUTE_POLICY_CONFLICT",
            409,
            "Compute state changed; refresh and retry.",
            true,
          );
        }
        const replaced = await operations.replaceConfiguration({
          userId: input.userId,
          agentId: input.agentId,
          enabled: input.mutation.settings.enabled,
          allowedTools: input.mutation.settings.allowedTools,
          maxTimeoutMs: Math.min(
            input.mutation.settings.limits.maxTimeoutMs,
            COMPUTE_MAX_TIMEOUT_MS,
          ),
          maxConcurrency: input.mutation.settings.limits.maxConcurrency,
          maxArtifactBytes: input.mutation.settings.limits.maxArtifactBytes,
          maxArtifacts: input.mutation.settings.limits.maxArtifacts,
          ownerConfirmedAt: now().toISOString(),
          callerFunctions: manifest.callerFunctions,
          authorityRules: input.mutation.settings.authorityRules.map((rule) => ({
            callerFunction: rule.callerFunction,
            decision: rule.decision,
            authority: mutationAuthority(rule),
          })),
          secretBindings: input.mutation.settings.secretBindings.map(
            mapAgentWideSecretMutation,
          ),
          expectedRevision: actualRevision,
          expectedAuthorityEpoch: current?.authorityEpoch ?? "0",
        });
        return settingsView({
          app,
          manifest,
          policy: replaced.policy,
          rules: replaced.authorityRules,
          bindings: replaced.secretBindings,
        });
      } catch (error) {
        return mapCoreError(error);
      }
    },

    async listRuns(input) {
      try {
        const app = await ownedApp(input.userId, input.agentId);
        const cursor = decodeCursor(input.cursor);
        const cursorFilter = cursor
          ? `&or=(created_at.lt.${encodeURIComponent(cursor.createdAt)},` +
            `and(created_at.eq.${encodeURIComponent(cursor.createdAt)},` +
            `id.lt.${encodeURIComponent(cursor.runId)}))`
          : "";
        const rows = await operations.queryRows(
          `compute_runs?user_id=eq.${encodeURIComponent(input.userId)}` +
            `&agent_id=eq.${encodeURIComponent(input.agentId)}` + cursorFilter +
            `&select=${encodeURIComponent(ownerRunSelect())}` +
            `&order=created_at.desc,id.desc&limit=${input.limit + 1}`,
        );
        const page = rows.slice(0, input.limit).map(mapOwnerRunRow);
        const last = page.at(-1);
        return {
          runs: page.map((row) => runSummary(row, app, now())),
          nextCursor: rows.length > input.limit && last
            ? encodeCursor({
              version: 1,
              createdAt: last.createdAt,
              runId: last.id,
            })
            : null,
        };
      } catch (error) {
        return mapCoreError(error);
      }
    },

    async cancelRun(input): Promise<ComputeLaunchRunSummary> {
      try {
        const app = await ownedApp(input.userId, input.agentId);
        let row = await oneRunRow(input.userId, input.agentId, input.runId);
        if (!row) {
          throw launchError("COMPUTE_RUN_NOT_FOUND", 404, "Compute run not found.");
        }
        if (TERMINAL_STATES.has(row.state)) return runSummary(row, app, now());
        if (!options.cancellation) {
          throw launchError(
            "COMPUTE_CANCELLATION_UNAVAILABLE",
            503,
            "Compute cancellation is temporarily unavailable.",
          );
        }
        const run = await operations.getRun({
          runId: row.id,
          userId: input.userId,
          agentId: input.agentId,
          callerFunction: row.callerFunction,
        });
        if (!run) {
          throw launchError("COMPUTE_RUN_NOT_FOUND", 404, "Compute run not found.");
        }
        if (!TERMINAL_STATES.has(run.state)) {
          await options.cancellation.cancelActiveRun({
            userId: input.userId,
            agentId: input.agentId,
            run,
          });
        }
        row = await oneRunRow(input.userId, input.agentId, input.runId);
        if (!row) {
          throw launchError("COMPUTE_RUN_NOT_FOUND", 404, "Compute run not found.");
        }
        if (!TERMINAL_STATES.has(row.state)) {
          throw launchError(
            "COMPUTE_CANCELLATION_PENDING",
            409,
            "Compute cancellation has not reached a terminal state; retry.",
            true,
          );
        }
        return runSummary(row, app, now());
      } catch (error) {
        return mapCoreError(error);
      }
    },

    async downloadArtifact(input): Promise<ComputeLaunchArtifactDownload> {
      try {
        await ownedApp(input.userId, input.agentId);
        const runRow = await oneRunRow(input.userId, input.agentId, input.runId);
        if (!runRow) {
          throw launchError("COMPUTE_ARTIFACT_NOT_FOUND", 404, "Artifact not found.");
        }
        const artifact = await operations.leaseArtifactDownload({
          artifactId: input.artifactId,
          runId: input.runId,
          userId: input.userId,
          agentId: input.agentId,
          callerFunction: runRow.callerFunction,
        });
        if (
          !artifact || artifact.direction !== "output" ||
          artifact.state !== "ready" || artifact.sizeBytes === null ||
          artifact.sha256 === null
        ) {
          throw launchError("COMPUTE_ARTIFACT_NOT_FOUND", 404, "Artifact not found.");
        }
        const object = await operations.getArtifactObject(artifact.storageKey);
        if (
          !object || object.size !== Number(artifact.sizeBytes) ||
          !artifactObjectMatchesSha256(object, artifact.sha256)
        ) {
          throw launchError(
            "COMPUTE_ARTIFACT_UNAVAILABLE",
            503,
            "Artifact storage is temporarily unavailable.",
          );
        }
        return {
          body: object.body,
          contentType: artifact.mediaType,
          contentLength: object.size,
          fileName: artifact.logicalName,
        };
      } catch (error) {
        return mapCoreError(error);
      }
    },
  };
}
