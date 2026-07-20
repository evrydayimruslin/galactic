import { requireComputeUuid } from "./authority.ts";
import {
  callComputeRpc,
  type ComputeDatabaseDeps,
  firstComputeRow,
  integerString,
  nullableString,
  requiredString,
} from "./database.ts";
import { settleComputeCapacityFromTerminalPayload } from "./capacity-settlement.ts";

export interface StaleComputeRunCandidate {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  state: "admitted" | "queued" | "provisioning" | "running";
  stateVersion: string;
  claimId: string | null;
  leaseId: string;
  containerId: string | null;
  expiresAt: string;
  claimExpiresAt: string | null;
  stopRequestedAt: string | null;
  stopReason: string | null;
  requiresBodyDestroy: boolean;
}

export interface ComputeTerminalizationIdentity {
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  outcome: "failed" | "cancelled" | "expired" | "revoked";
  reason: string | null;
  receiptId: string;
  replayed: boolean;
}

export interface ComputeTerminalFenceIdentity {
  terminal: true;
  runId: string;
  userId: string;
  agentId: string;
  callerFunction: string;
  outcome: "succeeded" | "failed" | "cancelled" | "expired" | "revoked";
  receiptId: string;
}

function terminalFenceIdentity(
  row: Record<string, unknown>,
  operation: string,
): ComputeTerminalFenceIdentity | null {
  const state = requiredString(row, "state", operation);
  if (
    state !== "succeeded" && state !== "failed" && state !== "cancelled" &&
    state !== "expired" && state !== "revoked"
  ) return null;
  return {
    terminal: true,
    runId: requiredString(row, "id", operation),
    userId: requiredString(row, "user_id", operation),
    agentId: requiredString(row, "agent_id", operation),
    callerFunction: requiredString(row, "caller_function", operation),
    outcome: state,
    receiptId: requiredString(row, "receipt_id", operation),
  };
}

function iso(value: string | undefined, deps: ComputeDatabaseDeps): string {
  const input = value ?? (deps.now ?? new Date()).toISOString();
  if (!Number.isFinite(Date.parse(input))) throw new Error("now must be an ISO timestamp");
  return new Date(input).toISOString();
}

function staleCandidate(row: Record<string, unknown>): StaleComputeRunCandidate {
  const operation = "List stale Compute runs";
  const state = requiredString(row, "state", operation);
  if (
    state !== "admitted" && state !== "queued" && state !== "provisioning" &&
    state !== "running"
  ) throw new Error("Stale Compute candidate returned an invalid state");
  return {
    runId: requiredString(row, "run_id", operation),
    userId: requiredString(row, "user_id", operation),
    agentId: requiredString(row, "agent_id", operation),
    callerFunction: requiredString(row, "caller_function", operation),
    state,
    stateVersion: integerString(row, "state_version", operation),
    claimId: nullableString(row, "claim_id"),
    leaseId: requiredString(row, "lease_id", operation),
    containerId: nullableString(row, "container_id"),
    expiresAt: requiredString(row, "expires_at", operation),
    claimExpiresAt: nullableString(row, "claim_expires_at"),
    stopRequestedAt: nullableString(row, "stop_requested_at"),
    stopReason: nullableString(row, "stop_reason"),
    requiresBodyDestroy: row.requires_body_destroy === true,
  };
}

export async function fenceStaleComputeRun(input: {
  runId: string;
  expectedState: StaleComputeRunCandidate["state"];
  expectedStateVersion: string | number | bigint;
  now?: string;
}, deps: ComputeDatabaseDeps = {}): Promise<{
  terminal: false;
  candidate: StaleComputeRunCandidate;
  replayed: boolean;
} | ComputeTerminalFenceIdentity | {
  terminal: false;
  skipped: true;
  reason: "foreign_stop_fence";
}> {
  const payload = await callComputeRpc("fence_stale_compute_run", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_expected_state: input.expectedState,
    p_expected_state_version: String(input.expectedStateVersion),
    p_now: iso(input.now, deps),
  }, deps);
  const row = firstComputeRow(payload, "Fence stale Compute run");
  await settleComputeCapacityFromTerminalPayload(payload, deps);
  const terminal = terminalFenceIdentity(row, "Fence stale Compute run");
  if (terminal) return terminal;
  if (row.skipped === true && row.skip_reason === "foreign_stop_fence") {
    return {
      terminal: false,
      skipped: true,
      reason: "foreign_stop_fence",
    };
  }
  return {
    terminal: false,
    candidate: staleCandidate({
      ...row,
      run_id: row.id,
      requires_body_destroy: row.state === "provisioning" || row.state === "running",
    }),
    replayed: row.replayed === true,
  };
}

function terminalIdentity(
  row: Record<string, unknown>,
  operation: string,
): ComputeTerminalizationIdentity {
  const outcome = requiredString(row, "state", operation);
  if (
    outcome !== "failed" && outcome !== "cancelled" && outcome !== "expired" &&
    outcome !== "revoked"
  ) throw new Error(`${operation} returned an invalid outcome`);
  return {
    runId: requiredString(row, "id", operation),
    userId: requiredString(row, "user_id", operation),
    agentId: requiredString(row, "agent_id", operation),
    callerFunction: requiredString(row, "caller_function", operation),
    outcome,
    reason: nullableString(row, "terminal_reason"),
    receiptId: requiredString(row, "receipt_id", operation),
    replayed: row.replayed === true,
  };
}

export async function listStaleComputeRuns(input: {
  now?: string;
  limit?: number;
} = {}, deps: ComputeDatabaseDeps = {}): Promise<StaleComputeRunCandidate[]> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be between 1 and 500");
  }
  const payload = await callComputeRpc("list_stale_compute_runs", {
    p_now: iso(input.now, deps),
    p_limit: limit,
  }, deps);
  if (!Array.isArray(payload)) return [];
  return payload.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("List stale Compute runs returned an invalid row");
    }
    return staleCandidate(value as Record<string, unknown>);
  });
}

/** Call only after deterministic Sandbox destruction succeeds when required. */
export async function terminalizeStaleComputeRun(input: {
  runId: string;
  expectedState: StaleComputeRunCandidate["state"];
  expectedStateVersion: string | number | bigint;
  bodyDestroyed: boolean;
  now?: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeTerminalizationIdentity> {
  if (typeof input.bodyDestroyed !== "boolean") throw new Error("bodyDestroyed is required");
  const payload = await callComputeRpc("terminalize_stale_compute_run", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_expected_state: input.expectedState,
    p_expected_state_version: String(input.expectedStateVersion),
    p_body_destroyed: input.bodyDestroyed,
    p_now: iso(input.now, deps),
  }, deps);
  await settleComputeCapacityFromTerminalPayload(payload, deps);
  return terminalIdentity(
    firstComputeRow(payload, "Terminalize stale Compute run"),
    "Terminalize stale Compute run",
  );
}

export async function fenceComputeDlqRun(input: {
  runId: string;
  reason?: string;
}, deps: ComputeDatabaseDeps = {}): Promise<
  | {
    terminal: false;
    candidate: StaleComputeRunCandidate;
    replayed: boolean;
  }
  | {
    terminal: true;
    runId: string;
    userId: string;
    agentId: string;
    callerFunction: string;
    outcome: "succeeded" | "failed" | "cancelled" | "expired" | "revoked";
    receiptId: string;
  }
  | {
    terminal: false;
    skipped: true;
    reason: "foreign_stop_fence";
  }
> {
  const reason = input.reason ?? "compute_dispatch_dlq";
  if (!reason || reason.length > 1024 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new Error("reason is invalid");
  }
  const payload = await callComputeRpc("fence_compute_dlq_run", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_reason: reason,
  }, deps);
  const row = firstComputeRow(payload, "Fence Compute DLQ run");
  await settleComputeCapacityFromTerminalPayload(payload, deps);
  const terminal = terminalFenceIdentity(row, "Fence Compute DLQ run");
  if (terminal) return terminal;
  if (row.skipped === true && row.skip_reason === "foreign_stop_fence") {
    return {
      terminal: false,
      skipped: true,
      reason: "foreign_stop_fence",
    };
  }
  return {
    terminal: false,
    candidate: staleCandidate({ ...row, run_id: row.id }),
    replayed: row.replayed === true,
  };
}

/** Call after fence, and after deterministic Sandbox destruction when required. */
export async function terminalizeComputeDlqRun(input: {
  runId: string;
  expectedStateVersion: string | number | bigint;
  bodyDestroyed: boolean;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeTerminalizationIdentity> {
  if (typeof input.bodyDestroyed !== "boolean") throw new Error("bodyDestroyed is required");
  const payload = await callComputeRpc("terminalize_compute_dlq_run", {
    p_run_id: requireComputeUuid(input.runId, "runId"),
    p_expected_state_version: String(input.expectedStateVersion),
    p_body_destroyed: input.bodyDestroyed,
  }, deps);
  await settleComputeCapacityFromTerminalPayload(payload, deps);
  return terminalIdentity(
    firstComputeRow(payload, "Terminalize Compute DLQ run"),
    "Terminalize Compute DLQ run",
  );
}
