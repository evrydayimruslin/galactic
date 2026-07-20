import type {
  ComputeRequest as PublicComputeRequest,
  ComputeResult as PublicComputeResult,
  ComputeRun as PublicComputeRun,
  ComputeRunStatus as PublicComputeRunStatus,
  ManifestComputeConfig,
} from "../../shared/contracts/compute.ts";
import { DEFAULT_COMPUTE_PROFILE } from "../../shared/contracts/compute.ts";
import { canonicalPlatformMcpToolName } from "./platform-mcp-authorization.ts";
import {
  canonicalizeComputeAuthorities,
  computeAuthorityKey,
} from "./compute/authority.ts";
import {
  canonicalizeComputeExecutionRequest,
  COMPUTE_MAX_TIMEOUT_MS,
} from "./compute/runs.ts";
import type {
  ComputeAgentPolicy,
  ComputeAgentPolicyRule,
  ComputeArtifact,
  ComputeAuthority,
  ComputeExecutionRequest,
  ComputeRun,
  ComputeRunReceipt,
  ComputeSecretBinding,
} from "./compute/types.ts";

export const DEFAULT_COMPUTE_TIMEOUT_MS = 30_000;
export const COMPUTE_QUEUE_ALLOWANCE_MS = 15 * 60_000;
export const COMPUTE_STARTUP_ALLOWANCE_MS = 195_000;
export const COMPUTE_TEARDOWN_ALLOWANCE_MS = 15_000;
export const COMPUTE_SYNC_MAX_TIMEOUT_MS = 30_000;
export const COMPUTE_SYNC_PARENT_HEADROOM_MS = 30_000;

const PUBLIC_REQUEST_FIELDS = new Set([
  "argv",
  "tools",
  "profile",
  "secrets",
  "mode",
  "cwd",
  "stdin",
  "timeout_ms",
  "input_artifacts",
  "capture_paths",
]);

export class ComputePublicRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ComputePublicRequestError";
    this.code = code;
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ComputePublicRequestError(
      "COMPUTE_REQUEST_INVALID",
      `${field} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function exactUniqueStrings(
  value: unknown,
  field: string,
  maximum: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ComputePublicRequestError(
      "COMPUTE_REQUEST_INVALID",
      `${field} must be an array with at most ${maximum} entries.`,
    );
  }
  const values = value.map((entry) => {
    if (typeof entry !== "string" || !entry) {
      throw new ComputePublicRequestError(
        "COMPUTE_REQUEST_INVALID",
        `${field} must contain non-empty strings.`,
      );
    }
    return entry;
  });
  if (new Set(values).size !== values.length) {
    throw new ComputePublicRequestError(
      "COMPUTE_REQUEST_INVALID",
      `${field} must not contain duplicates.`,
    );
  }
  return values;
}

export interface NormalizedPublicComputeRequest {
  mode: "sync" | "async";
  executionRequest: ComputeExecutionRequest;
  manifestCeiling: {
    allowedTools: string[];
    maxTimeoutMs: number;
    revision: string;
  };
}

/**
 * Convert the public snake-case SDK request into the one canonical execution
 * payload persisted by the control plane. Secret names become opaque binding
 * IDs here; a secret value is never accepted from or returned to Agent code.
 */
export function normalizePublicComputeRequest(input: {
  request: PublicComputeRequest | unknown;
  manifest: ManifestComputeConfig;
  manifestRevision: string;
  policy: ComputeAgentPolicy;
  callerFunction: string;
  secretBindings: readonly ComputeSecretBinding[];
  now?: Date;
}): NormalizedPublicComputeRequest {
  const request = record(input.request, "galactic.compute request");
  const unsupported = Object.keys(request).find((key) =>
    !PUBLIC_REQUEST_FIELDS.has(key)
  );
  if (unsupported) {
    throw new ComputePublicRequestError(
      "COMPUTE_REQUEST_INVALID",
      `Unsupported galactic.compute field: ${unsupported}.`,
    );
  }

  const profile = request.profile ?? DEFAULT_COMPUTE_PROFILE;
  if (profile !== DEFAULT_COMPUTE_PROFILE || profile !== input.manifest.profile) {
    throw new ComputePublicRequestError(
      "COMPUTE_PROFILE_DENIED",
      "The requested Compute profile is outside the live release ceiling.",
    );
  }
  const mode = request.mode ?? "sync";
  if (mode !== "sync" && mode !== "async") {
    throw new ComputePublicRequestError(
      "COMPUTE_REQUEST_INVALID",
      "mode must be sync or async.",
    );
  }

  const tools = exactUniqueStrings(request.tools, "tools", 32);
  if (tools.length === 0) {
    throw new ComputePublicRequestError(
      "COMPUTE_TOOLS_REQUIRED",
      "At least one semantic Compute tool is required.",
    );
  }
  const manifestTools = new Set(input.manifest.tools);
  const policyTools = new Set(input.policy.allowedTools);
  const deniedTool = tools.find((tool) =>
    !manifestTools.has(tool) || !policyTools.has(tool)
  );
  if (deniedTool) {
    throw new ComputePublicRequestError(
      "COMPUTE_TOOL_DENIED",
      `Compute tool ${deniedTool} is outside the live release or owner policy.`,
    );
  }

  const requestedSecrets = request.secrets === undefined
    ? []
    : exactUniqueStrings(request.secrets, "secrets", 50);
  const eligibleSecrets = new Set(input.manifest.secrets ?? []);
  const nowMs = (input.now ?? new Date()).getTime();
  const activeByName = new Map(
    input.secretBindings
      .filter((binding) =>
        binding.callerFunction === input.callerFunction &&
        binding.status === "active" &&
        (binding.expiresAt === null || Date.parse(binding.expiresAt) > nowMs)
      )
      .map((binding) => [binding.name, binding] as const),
  );
  const secretBindingIds = requestedSecrets.map((name) => {
    if (!eligibleSecrets.has(name)) {
      throw new ComputePublicRequestError(
        "COMPUTE_SECRET_DENIED",
        `Secret ${name} is outside the live release ceiling.`,
      );
    }
    const binding = activeByName.get(name);
    if (!binding) {
      throw new ComputePublicRequestError(
        "COMPUTE_SECRET_NOT_CONFIGURED",
        `Secret ${name} is not configured for this Compute caller.`,
      );
    }
    return binding.id;
  });

  const timeoutMs = request.timeout_ms ?? Math.min(
    DEFAULT_COMPUTE_TIMEOUT_MS,
    input.policy.maxTimeoutMs,
  );
  if (
    typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 || timeoutMs > COMPUTE_MAX_TIMEOUT_MS ||
    timeoutMs > input.policy.maxTimeoutMs
  ) {
    throw new ComputePublicRequestError(
      "COMPUTE_TIMEOUT_DENIED",
      "timeout_ms is outside the owner-confirmed Compute ceiling.",
    );
  }
  if (mode === "sync" && timeoutMs > COMPUTE_SYNC_MAX_TIMEOUT_MS) {
    throw new ComputePublicRequestError(
      "COMPUTE_SYNC_TIMEOUT_REQUIRES_ASYNC",
      `Synchronous Compute supports timeout_ms up to ${COMPUTE_SYNC_MAX_TIMEOUT_MS}; use mode async for longer jobs.`,
    );
  }

  try {
    const executionRequest = canonicalizeComputeExecutionRequest({
      argv: request.argv,
      tools: tools.map((id) => ({ id })),
      secretBindingIds,
      cwd: request.cwd ?? ".",
      stdin: request.stdin === undefined
        ? { kind: "none" }
        : { kind: "text", text: request.stdin },
      capturePaths: request.capture_paths ?? [],
      inputArtifacts: Array.isArray(request.input_artifacts)
        ? request.input_artifacts.map((artifact) => {
          const item = record(artifact, "input artifact");
          return {
            artifactId: item.artifact_id,
            mountPath: item.mount_path,
          };
        })
        : request.input_artifacts ?? [],
      timeoutMs,
    });
    return {
      mode,
      executionRequest,
      manifestCeiling: {
        allowedTools: [...input.manifest.tools],
        // v1 has no manifest timeout field; the immutable platform ceiling is
        // the release ceiling and owner policy can only narrow it.
        maxTimeoutMs: COMPUTE_MAX_TIMEOUT_MS,
        revision: input.manifestRevision,
      },
    };
  } catch (error) {
    if (error instanceof ComputePublicRequestError) throw error;
    throw new ComputePublicRequestError(
      "COMPUTE_REQUEST_INVALID",
      error instanceof Error ? error.message : "Invalid Compute request.",
    );
  }
}

/** Snapshot only exact, active, owner `always` decisions for this caller. */
export function selectComputeRunAuthorities(
  rules: readonly ComputeAgentPolicyRule[],
  callerFunction: string,
): ComputeAuthority[] {
  const selected: ComputeAuthority[] = [];
  for (const rule of rules) {
    if (
      rule.callerFunction !== callerFunction || rule.decision !== "always"
    ) continue;
    const authority = rule.authority.target.kind === "platform_function"
      ? {
        ...rule.authority,
        target: {
          ...rule.authority.target,
          functionName: canonicalPlatformMcpToolName(
            rule.authority.target.functionName,
          ),
        },
      } as ComputeAuthority
      : rule.authority;
    selected.push(authority);
  }
  return canonicalizeComputeAuthorities(selected).sort((left, right) =>
    computeAuthorityKey(left).localeCompare(computeAuthorityKey(right))
  );
}

export function computeRunExpiresAt(now: Date, timeoutMs: number): string {
  return new Date(
    now.getTime() + COMPUTE_QUEUE_ALLOWANCE_MS +
      COMPUTE_STARTUP_ALLOWANCE_MS + timeoutMs +
      COMPUTE_TEARDOWN_ALLOWANCE_MS,
  ).toISOString();
}

/**
 * Fence a direct synchronous body to the host-authenticated parent deadline.
 * Admission happens only while the complete worst-case reservation plus a
 * response/settlement margin still fits. Long or late composition must use the
 * durable async path, and refusal occurs before a wallet hold or run exists.
 */
export function computeSyncRunExpiresAt(input: {
  now: Date;
  timeoutMs: number;
  executionDeadlineAtMs: number;
}): string {
  if (
    !Number.isSafeInteger(input.executionDeadlineAtMs) ||
    input.executionDeadlineAtMs <= 0
  ) {
    throw new ComputePublicRequestError(
      "COMPUTE_PARENT_DEADLINE_INVALID",
      "The parent Agent execution deadline is unavailable; synchronous Compute was refused.",
    );
  }
  const requiredMs = COMPUTE_STARTUP_ALLOWANCE_MS + input.timeoutMs +
    COMPUTE_TEARDOWN_ALLOWANCE_MS + COMPUTE_SYNC_PARENT_HEADROOM_MS;
  if (input.executionDeadlineAtMs - input.now.getTime() < requiredMs) {
    throw new ComputePublicRequestError(
      "COMPUTE_SYNC_DEADLINE_REQUIRES_ASYNC",
      "The parent Agent execution has insufficient time for synchronous Compute; use mode async.",
    );
  }
  return new Date(
    input.executionDeadlineAtMs - COMPUTE_SYNC_PARENT_HEADROOM_MS,
  ).toISOString();
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJsonValue(nested)]),
    );
  }
  return value;
}

export async function computeDirectiveHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(stableJsonValue(value))),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function isComputeRunTerminal(run: ComputeRun): boolean {
  return run.state === "succeeded" || run.state === "failed" ||
    run.state === "cancelled" || run.state === "expired" ||
    run.state === "revoked";
}

export function publicComputeRunStatus(
  state: ComputeRun["state"],
): PublicComputeRunStatus {
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

function publicArtifacts(artifacts: readonly ComputeArtifact[], now: Date) {
  const nowMs = now.getTime();
  return artifacts
    .filter((artifact) =>
      artifact.direction === "output" && artifact.state === "ready" &&
      artifact.sha256 !== null && artifact.sizeBytes !== null &&
      artifact.expiresAt !== null && Date.parse(artifact.expiresAt) > nowMs
    )
    .map((artifact) => ({
      artifact_id: artifact.id,
      path: artifact.logicalName,
      size_bytes: Number(artifact.sizeBytes),
      sha256: artifact.sha256!,
      expires_at: artifact.expiresAt!,
    }));
}

export function projectPublicComputeRun(input: {
  run: ComputeRun;
  artifacts?: readonly ComputeArtifact[];
  receipt?: ComputeRunReceipt | null;
  now?: Date;
}): PublicComputeRun {
  const { run } = input;
  const settlementPending = isComputeRunTerminal(run) && (
    !input.receipt ||
    input.receipt.capacitySettlementStatus === "pending"
  );
  const projected: PublicComputeRun = {
    run_id: run.id,
    receipt_id: run.receiptId,
    status: settlementPending
      ? "settlement_pending"
      : publicComputeRunStatus(run.state),
    profile: run.profile,
    tools: run.request.tools.map((tool) => tool.id),
    created_at: run.createdAt,
  };
  if (run.startedAt) projected.started_at = run.startedAt;
  if (run.finishedAt) projected.finished_at = run.finishedAt;
  if (run.exitCode !== null) projected.exit_code = run.exitCode;
  if (run.stdout !== null) projected.stdout = run.stdout;
  if (run.stderr !== null) projected.stderr = run.stderr;
  const artifacts = publicArtifacts(input.artifacts ?? [], input.now ?? new Date());
  if (artifacts.length > 0) projected.artifacts = artifacts;
  if (run.state === "failed" || run.state === "expired" || run.state === "revoked") {
    projected.error = run.terminalError || run.terminalReason ||
      "The Compute run failed.";
  }
  return projected;
}

export function projectPublicComputeResult(input: {
  run: ComputeRun;
  artifacts?: readonly ComputeArtifact[];
  receipt?: ComputeRunReceipt | null;
  requestedMode: "sync" | "async";
  now?: Date;
}): PublicComputeResult {
  const run = projectPublicComputeRun(input);
  // A sync replay can discover that another delivery already owns the body.
  // Return the truthful accepted shape instead of fabricating a terminal run.
  const async = !isComputeRunTerminal(input.run);
  return { ...run, async } as PublicComputeResult;
}
