import type { Env } from "../lib/env.ts";
import { getEnv } from "../lib/env.ts";
import { notifyComputeInfrastructureFailure } from "./compute/alerts.ts";
import {
  listPendingComputeCapacitySettlements,
  settleComputeCapacityReservation,
  type ComputeCapacitySettlementInput,
} from "./compute/capacity-settlement.ts";
import {
  fenceStaleComputeRun,
  listStaleComputeRuns,
  terminalizeStaleComputeRun,
  type ComputeTerminalizationIdentity,
  type StaleComputeRunCandidate,
} from "./compute/reconciliation.ts";

const COMPUTE_DISPATCH_VERSION = 1 as const;

export interface ComputeReconciliationResult {
  candidates: number;
  terminalized: number;
  failed: number;
  capacityPending: number;
  capacitySettled: number;
  capacityFailed: number;
}

export interface ComputeReconcilerDeps {
  env?: Partial<Env>;
  now?: () => Date;
  list?: (input: {
    now: string;
    limit: number;
  }) => Promise<StaleComputeRunCandidate[]>;
  fence?: (input: {
    runId: string;
    expectedState: StaleComputeRunCandidate["state"];
    expectedStateVersion: string;
    now: string;
  }) => ReturnType<typeof fenceStaleComputeRun>;
  destroy?: (message: { version: 1; run_id: string }) => Promise<void>;
  terminalize?: (input: {
    runId: string;
    expectedState: StaleComputeRunCandidate["state"];
    expectedStateVersion: string;
    bodyDestroyed: boolean;
    now: string;
  }) => Promise<ComputeTerminalizationIdentity>;
  notify?: (run: ComputeTerminalizationIdentity) => Promise<void>;
  listPendingCapacity?: (input: {
    limit: number;
  }) => Promise<ComputeCapacitySettlementInput[]>;
  settlePendingCapacity?: (
    input: ComputeCapacitySettlementInput,
  ) => Promise<void>;
}

/** Fence → destroy → settle. Never reverse this sequence. */
export async function runComputeReconciliationCycle(
  input: { limit?: number } = {},
  deps: ComputeReconcilerDeps = {},
): Promise<ComputeReconciliationResult> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Compute reconciliation limit must be between 1 and 500");
  }
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const env = deps.env ?? getEnv();
  const list = deps.list ?? ((value) => listStaleComputeRuns(value));
  const fence = deps.fence ?? ((value) => fenceStaleComputeRun(value));
  const destroy = deps.destroy ?? (async (message) => {
    if (!env.COMPUTE_PLANE) throw new Error("Compute plane is unavailable");
    await env.COMPUTE_PLANE.cancelRun(message);
  });
  const terminalize = deps.terminalize ?? ((value) =>
    terminalizeStaleComputeRun(value));
  const notify = deps.notify ?? (async (run) => {
    await notifyComputeInfrastructureFailure(run, {
      code: "COMPUTE_LEASE_EXPIRED",
      message: "The disposable Compute body stopped responding and was reconciled.",
      retryable: true,
    });
  });

  const listPendingCapacity = deps.listPendingCapacity ?? ((value) =>
    listPendingComputeCapacitySettlements(value));
  const settlePendingCapacity = deps.settlePendingCapacity ?? ((value) =>
    settleComputeCapacityReservation(value));
  let capacityPending = 0;
  let capacitySettled = 0;
  let capacityFailed = 0;
  try {
    const pending = await listPendingCapacity({ limit });
    capacityPending = pending.length;
    for (const settlement of pending) {
      try {
        await settlePendingCapacity(settlement);
        capacitySettled += 1;
      } catch (error) {
        capacityFailed += 1;
        console.error("[COMPUTE-CAPACITY-SETTLEMENT-ALARM] Reconciler retry failed", {
          run_id: settlement.runId,
          receipt_id: settlement.receiptId,
          reservation_id: settlement.reservationId,
          error: error instanceof Error ? error.message : "unknown failure",
        });
      }
    }
  } catch (error) {
    capacityFailed += 1;
    console.error("[COMPUTE-CAPACITY-SETTLEMENT-ALARM] Pending scan failed", {
      error: error instanceof Error ? error.message : "unknown failure",
    });
  }

  const candidates = await list({ now, limit });
  let terminalized = 0;
  let failed = 0;
  for (const original of candidates) {
    try {
      const fenced = await fence({
        runId: original.runId,
        expectedState: original.state,
        expectedStateVersion: original.stateVersion,
        now,
      });
      if (fenced.terminal) continue;
      if (!("candidate" in fenced)) {
        console.info("[COMPUTE] Reconciliation skipped foreign stop fence", {
          run_id: original.runId,
        });
        continue;
      }
      const candidate = fenced.candidate;
      let bodyDestroyed = false;
      if (candidate.requiresBodyDestroy) {
        await destroy({
          version: COMPUTE_DISPATCH_VERSION,
          run_id: candidate.runId,
        });
        bodyDestroyed = true;
      }
      const result = await terminalize({
        runId: candidate.runId,
        expectedState: candidate.state,
        expectedStateVersion: candidate.stateVersion,
        bodyDestroyed,
        now,
      });
      terminalized += 1;
      await notify(result).catch(() => undefined);
    } catch (error) {
      failed += 1;
      console.error("[COMPUTE] Reconciliation candidate failed", {
        run_id: original.runId,
        error: error instanceof Error ? error.message : "unknown failure",
      });
    }
  }
  return {
    candidates: candidates.length,
    terminalized,
    failed,
    capacityPending,
    capacitySettled,
    capacityFailed,
  };
}
