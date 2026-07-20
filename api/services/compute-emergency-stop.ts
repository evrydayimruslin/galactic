import type { Env } from "../lib/env.ts";
import { getEnv } from "../lib/env.ts";
import {
  callComputeRpc,
  ComputeControlPlaneError,
  type ComputeDatabaseDeps,
  firstComputeRow,
  integerString,
  nullableString,
  requiredString,
} from "./compute/database.ts";
import { requireComputeUuid } from "./compute/authority.ts";
import { terminalizeComputeRunCancellation } from "./compute/runs.ts";
import type { ComputeRunState } from "./compute/types.ts";
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

export class ComputeEmergencyStopError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ComputeEmergencyStopError";
    this.code = code;
    this.status = status;
  }
}

export interface ComputeEmergencyStopInput {
  operationId: string;
  operatorReference: string;
  reason: string;
  batchSize?: number;
  maxBatches?: number;
}

export interface ComputeEmergencyStopTarget {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  state: ComputeRunState;
  stateVersion: string;
  requiresBodyDestroy: boolean;
  attemptCount: number;
  lastErrorCode: string | null;
}

export interface ComputeEmergencyStopBatch {
  operationId: string;
  status: "active" | "completed";
  cutoffAt: string;
  targetCount: number;
  terminalizedCount: number;
  targets: ComputeEmergencyStopTarget[];
  initializing: boolean;
  replayed: boolean;
}

export interface ComputeEmergencyStopResult {
  operationId: string;
  status: "active" | "completed";
  cutoffAt: string;
  targetCount: number;
  terminalizedCount: number;
  processedThisRequest: number;
  continuationRequired: boolean;
  failures: Array<{
    runId: string;
    phase: "destroy" | "terminalize" | "audit";
    errorCode: string;
  }>;
}

export interface ComputeEmergencyStopReleaseInput {
  operationId: string;
  releaseIdempotencyKey: string;
  operatorReference: string;
  reason: string;
}

export interface ComputeEmergencyStopDeps {
  env?: Partial<Env>;
  database?: ComputeDatabaseDeps;
  fenceBatch?: (input: {
    operationId: string;
    requestHash: string;
    operatorReference: string;
    reason: string;
    limit: number;
  }) => Promise<ComputeEmergencyStopBatch>;
  destroy?: (runId: string) => Promise<void>;
  terminalize?: (input: {
    runId: string;
    userId: string;
    agentId: string;
    callerFunction: string;
    expectedStateVersion: string;
    bodyDestroyed: boolean;
  }) => Promise<unknown>;
  completeTarget?: (input: {
    operationId: string;
    runId: string;
    bodyDestroyed: boolean;
  }) => Promise<void>;
  recordFailure?: (input: {
    operationId: string;
    runId: string;
    phase: "destroy" | "terminalize" | "audit";
    errorCode: string;
  }) => Promise<void>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_INVALID_RESPONSE",
      status: 503,
      message: `${label} returned an invalid response.`,
    });
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(
  value: unknown,
  label: string,
): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
    ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_INVALID_RESPONSE",
      status: 503,
      message: `${label} returned an invalid count.`,
    });
  }
  return parsed;
}

function runState(value: unknown): ComputeRunState {
  if (
    value === "admitted" || value === "queued" ||
    value === "provisioning" || value === "running" ||
    value === "succeeded" || value === "failed" ||
    value === "cancelled" || value === "expired" || value === "revoked"
  ) return value;
  throw new ComputeControlPlaneError({
    code: "COMPUTE_DATABASE_INVALID_RESPONSE",
    status: 503,
    message: "Emergency-stop fencing returned an invalid run state.",
  });
}

function mapBatch(value: unknown): ComputeEmergencyStopBatch {
  const row = firstComputeRow(value, "Fence Compute emergency-stop batch");
  const status = requiredString(
    row,
    "status",
    "Fence Compute emergency-stop batch",
  );
  if (status !== "active" && status !== "completed") {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_INVALID_RESPONSE",
      status: 503,
      message: "Emergency-stop fencing returned an invalid operation state.",
    });
  }
  const targetsValue = row.targets;
  if (!Array.isArray(targetsValue)) {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_INVALID_RESPONSE",
      status: 503,
      message: "Emergency-stop fencing returned invalid targets.",
    });
  }
  return {
    operationId: requireComputeUuid(
      requiredString(row, "operation_id", "Fence Compute emergency-stop batch"),
      "operationId",
    ),
    status,
    cutoffAt: requiredString(
      row,
      "cutoff_at",
      "Fence Compute emergency-stop batch",
    ),
    targetCount: nonNegativeInteger(
      row.target_count,
      "Emergency-stop target count",
    ),
    terminalizedCount: nonNegativeInteger(
      row.terminalized_count,
      "Emergency-stop terminalized count",
    ),
    targets: targetsValue.map((value) => {
      const target = record(value, "Emergency-stop target");
      const requiresBodyDestroy = target.requires_body_destroy;
      if (typeof requiresBodyDestroy !== "boolean") {
        throw new ComputeControlPlaneError({
          code: "COMPUTE_DATABASE_INVALID_RESPONSE",
          status: 503,
          message:
            "Emergency-stop target returned an invalid destroy decision.",
        });
      }
      return {
        runId: requireComputeUuid(
          requiredString(target, "run_id", "Emergency-stop target"),
          "runId",
        ),
        userId: requireComputeUuid(
          requiredString(target, "user_id", "Emergency-stop target"),
          "userId",
        ),
        agentId: requireComputeUuid(
          requiredString(target, "agent_id", "Emergency-stop target"),
          "agentId",
        ),
        callerFunction: requiredString(
          target,
          "caller_function",
          "Emergency-stop target",
        ),
        state: runState(target.state),
        stateVersion: integerString(
          target,
          "state_version",
          "Emergency-stop target",
        ),
        requiresBodyDestroy,
        attemptCount: nonNegativeInteger(
          target.attempt_count,
          "Emergency-stop target attempts",
        ),
        lastErrorCode: nullableString(target, "last_error_code"),
      };
    }),
    initializing: row.initializing === true,
    replayed: row.replayed === true,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function exactText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 || normalized.length > max ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ComputeEmergencyStopError(
      "COMPUTE_EMERGENCY_STOP_INVALID",
      400,
      `${label} is invalid.`,
    );
  }
  return normalized;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw new ComputeEmergencyStopError(
      "COMPUTE_EMERGENCY_STOP_INVALID",
      400,
      `${label} must be between ${min} and ${max}.`,
    );
  }
  return selected;
}

function canonicalFailureCode(
  error: unknown,
  phase: "destroy" | "terminalize" | "audit",
): string {
  if (
    error instanceof ComputeControlPlaneError &&
    ERROR_CODE_PATTERN.test(error.code)
  ) return error.code;
  if (
    error instanceof ComputeEmergencyStopError &&
    ERROR_CODE_PATTERN.test(error.code)
  ) return error.code;
  if (phase === "destroy") return "COMPUTE_BODY_DESTRUCTION_FAILED";
  if (phase === "terminalize") return "COMPUTE_SETTLEMENT_FAILED";
  return "COMPUTE_EMERGENCY_STOP_AUDIT_FAILED";
}

export async function fenceComputeEmergencyStopBatch(
  input: {
    operationId: string;
    requestHash: string;
    operatorReference: string;
    reason: string;
    limit: number;
  },
  deps: ComputeDatabaseDeps = {},
): Promise<ComputeEmergencyStopBatch> {
  return mapBatch(
    await callComputeRpc("fence_compute_emergency_stop_batch", {
      p_operation_id: requireComputeUuid(input.operationId, "operationId"),
      p_request_hash: input.requestHash,
      p_operator_reference: input.operatorReference,
      p_reason: input.reason,
      p_limit: input.limit,
    }, deps),
  );
}

export async function completeComputeEmergencyStopTarget(
  input: { operationId: string; runId: string; bodyDestroyed: boolean },
  deps: ComputeDatabaseDeps = {},
): Promise<void> {
  await callComputeRpc("complete_compute_emergency_stop_target", {
    p_operation_id: requireComputeUuid(input.operationId, "operationId"),
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_body_destroyed: input.bodyDestroyed,
  }, deps);
}

export async function recordComputeEmergencyStopTargetFailure(
  input: {
    operationId: string;
    runId: string;
    phase: "destroy" | "terminalize" | "audit";
    errorCode: string;
  },
  deps: ComputeDatabaseDeps = {},
): Promise<void> {
  await callComputeRpc("record_compute_emergency_stop_target_failure", {
    p_operation_id: requireComputeUuid(input.operationId, "operationId"),
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_phase: input.phase,
    p_error_code: input.errorCode,
  }, deps);
}

export async function releaseComputeEmergencyStop(
  input: ComputeEmergencyStopReleaseInput,
  deps: {
    env?: Partial<Env>;
    database?: ComputeDatabaseDeps;
    release?: (input: {
      operationId: string;
      requestHash: string;
      operatorReference: string;
      reason: string;
    }) => Promise<unknown>;
  } = {},
): Promise<{
  operationId: string;
  status: "released";
  replayed: boolean;
}> {
  const operationId = requireComputeUuid(input.operationId, "operationId");
  const releaseIdempotencyKey = requireComputeUuid(
    input.releaseIdempotencyKey,
    "releaseIdempotencyKey",
  );
  const operatorReference = exactText(
    input.operatorReference,
    "operatorReference",
    128,
  );
  const reason = exactText(input.reason, "reason", 1024);
  const env = deps.env ?? getEnv();
  if (env.COMPUTE_ENABLED === "1") {
    throw new ComputeEmergencyStopError(
      "COMPUTE_ADMISSION_MUST_BE_DISABLED",
      409,
      "Keep new Compute admission disabled while releasing the emergency-stop latch.",
    );
  }
  const requestHash = await sha256(JSON.stringify({
    releaseIdempotencyKey,
    operatorReference,
    reason,
  }));
  const payload = await (deps.release ??
    (async (value) =>
      await callComputeRpc("release_compute_emergency_stop", {
        p_operation_id: value.operationId,
        p_request_hash: value.requestHash,
        p_operator_reference: value.operatorReference,
        p_reason: value.reason,
      }, deps.database ?? {})))({
      operationId,
      requestHash,
      operatorReference,
      reason,
    });
  const row = firstComputeRow(payload, "Release Compute emergency stop");
  const status = requiredString(
    row,
    "status",
    "Release Compute emergency stop",
  );
  if (status !== "released") {
    throw new ComputeControlPlaneError({
      code: "COMPUTE_DATABASE_INVALID_RESPONSE",
      status: 503,
      message: "Emergency-stop release returned an invalid state.",
    });
  }
  return {
    operationId: requireComputeUuid(
      requiredString(row, "id", "Release Compute emergency stop"),
      "operationId",
    ),
    status,
    replayed: row.replayed === true,
  };
}

/**
 * Process bounded deterministic batches. A 202 response is intentionally
 * resumable with the same operation id and exact body; no successful target is
 * destroyed or settled twice in an economically meaningful way.
 */
export async function runComputeEmergencyStop(
  input: ComputeEmergencyStopInput,
  deps: ComputeEmergencyStopDeps = {},
): Promise<ComputeEmergencyStopResult> {
  const operationId = requireComputeUuid(input.operationId, "operationId");
  const operatorReference = exactText(
    input.operatorReference,
    "operatorReference",
    128,
  );
  const reason = exactText(input.reason, "reason", 1024);
  const batchSize = boundedInteger(input.batchSize, 25, 1, 50, "batchSize");
  const maxBatches = boundedInteger(input.maxBatches, 4, 1, 10, "maxBatches");
  const env = deps.env ?? getEnv();
  if (env.COMPUTE_ENABLED === "1") {
    throw new ComputeEmergencyStopError(
      "COMPUTE_ADMISSION_MUST_BE_DISABLED",
      409,
      "Disable new Compute admission before starting an emergency stop.",
    );
  }
  const plane = env.COMPUTE_PLANE;
  const destroy = deps.destroy ?? (async (runId: string) => {
    if (!plane || typeof plane.cancelRun !== "function") {
      throw new ComputeEmergencyStopError(
        "COMPUTE_PLANE_UNAVAILABLE",
        503,
        "The Compute Plane is unavailable for emergency destruction.",
      );
    }
    const result = await plane.cancelRun({ version: 1, run_id: runId });
    if (result?.destroyed !== true) {
      throw new ComputeEmergencyStopError(
        "COMPUTE_BODY_DESTRUCTION_FAILED",
        503,
        "The Compute Plane did not confirm body destruction.",
      );
    }
  });
  const database = deps.database ?? {};
  const fence = deps.fenceBatch ??
    ((value) => fenceComputeEmergencyStopBatch(value, database));
  const terminalize = deps.terminalize ??
    ((value) => terminalizeComputeRunCancellation(value, database));
  const completeTarget = deps.completeTarget ??
    ((value) => completeComputeEmergencyStopTarget(value, database));
  const recordFailure = deps.recordFailure ??
    ((value) => recordComputeEmergencyStopTargetFailure(value, database));
  const requestHash = await sha256(JSON.stringify({
    operatorReference,
    reason,
    batchSize,
    maxBatches,
  }));

  let processedThisRequest = 0;
  let latest: ComputeEmergencyStopBatch | null = null;
  let initializationObserved = false;
  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    latest = await fence({
      operationId,
      requestHash,
      operatorReference,
      reason,
      limit: batchSize,
    });
    if (latest.initializing) {
      if (
        initializationObserved || latest.status !== "active" ||
        latest.targets.length !== 0
      ) {
        throw new ComputeEmergencyStopError(
          "COMPUTE_EMERGENCY_STOP_STALLED",
          503,
          "Emergency-stop persistence returned an invalid initialization state.",
        );
      }
      initializationObserved = true;
      batchIndex -= 1;
      continue;
    }
    if (latest.status === "completed") {
      return {
        operationId,
        status: "completed",
        cutoffAt: latest.cutoffAt,
        targetCount: latest.targetCount,
        terminalizedCount: latest.terminalizedCount,
        processedThisRequest,
        continuationRequired: false,
        failures: [],
      };
    }
    if (latest.targets.length === 0) {
      throw new ComputeEmergencyStopError(
        "COMPUTE_EMERGENCY_STOP_STALLED",
        503,
        "Emergency-stop persistence returned an active operation with no batch.",
      );
    }

    const outcomes: Array<
      {
        runId: string;
        phase: "destroy" | "terminalize" | "audit";
        errorCode: string;
      } | null
    > = new Array(latest.targets.length).fill(null);
    let cursor = 0;
    const workerCount = Math.min(8, latest.targets.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < latest!.targets.length) {
        const index = cursor;
        cursor += 1;
        const target = latest!.targets[index];
        let phase: "destroy" | "terminalize" | "audit" = "destroy";
        try {
          if (target.requiresBodyDestroy) await destroy(target.runId);
          phase = "terminalize";
          await terminalize({
            runId: target.runId,
            userId: target.userId,
            agentId: target.agentId,
            callerFunction: target.callerFunction,
            expectedStateVersion: target.stateVersion,
            bodyDestroyed: target.requiresBodyDestroy,
          });
          phase = "audit";
          await completeTarget({
            operationId,
            runId: target.runId,
            bodyDestroyed: target.requiresBodyDestroy,
          });
          processedThisRequest += 1;
        } catch (error) {
          const errorCode = canonicalFailureCode(error, phase);
          outcomes[index] = { runId: target.runId, phase, errorCode };
          try {
            await recordFailure({
              operationId,
              runId: target.runId,
              phase,
              errorCode,
            });
          } catch {
            outcomes[index] = {
              runId: target.runId,
              phase: "audit",
              errorCode: "COMPUTE_EMERGENCY_STOP_AUDIT_FAILED",
            };
          }
        }
      }
    }));
    const failures = outcomes.filter((
      value,
    ): value is NonNullable<typeof value> => value !== null);
    if (failures.length > 0) {
      return {
        operationId,
        status: "active",
        cutoffAt: latest.cutoffAt,
        targetCount: latest.targetCount,
        terminalizedCount: latest.terminalizedCount +
          (latest.targets.length - failures.length),
        processedThisRequest,
        continuationRequired: true,
        failures,
      };
    }
  }

  if (!latest) {
    throw new ComputeEmergencyStopError(
      "COMPUTE_EMERGENCY_STOP_STALLED",
      503,
      "Emergency-stop processing did not start.",
    );
  }
  return {
    operationId,
    status: "active",
    cutoffAt: latest.cutoffAt,
    targetCount: latest.targetCount,
    terminalizedCount: latest.terminalizedCount + latest.targets.length,
    processedThisRequest,
    continuationRequired: true,
    failures: [],
  };
}
