import type { Env } from "../lib/env.ts";
import { getEnv } from "../lib/env.ts";
import { requireComputeUuid } from "./compute/authority.ts";
import {
  queryComputeRows,
  requiredString,
} from "./compute/database.ts";

const COMPUTE_DISPATCH_VERSION = 1 as const;

export interface ComputeDispatchRecoveryResult {
  candidates: number;
  enqueued: number;
  failed: number;
}

export interface ComputeDispatchRecoveryDeps {
  env?: Partial<Env>;
  now?: () => Date;
  listCandidates?: (input: {
    now: string;
    limit: number;
  }) => Promise<string[]>;
  enqueue?: (message: { version: 1; run_id: string }) => Promise<void>;
}

async function defaultCandidates(input: {
  now: string;
  limit: number;
}): Promise<string[]> {
  const rows = await queryComputeRows(
    "compute_runs?state=in.(admitted,queued)" +
      `&expires_at=gt.${encodeURIComponent(input.now)}` +
      "&stop_requested_at=is.null&select=id&order=created_at.asc" +
      `&limit=${input.limit}`,
  );
  return rows.map((row) =>
    requireComputeUuid(
      requiredString(row, "id", "Recover Compute dispatch"),
      "runId",
    )
  );
}

/**
 * Close the unavoidable database-admission → Queue-send crash window.
 * Re-sending is safe: claim_compute_run is the idempotent execution guard.
 */
export async function recoverAdmittedComputeDispatches(
  input: { limit?: number } = {},
  deps: ComputeDispatchRecoveryDeps = {},
): Promise<ComputeDispatchRecoveryResult> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Compute dispatch recovery limit must be between 1 and 500");
  }
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const runIds = await (deps.listCandidates ?? defaultCandidates)({ now, limit });
  const uniqueRunIds = [...new Set(runIds.map((id) => requireComputeUuid(id, "runId")))];
  const env = deps.env ?? getEnv();
  const enqueue = deps.enqueue ?? (async (message) => {
    if (!env.COMPUTE_QUEUE) throw new Error("Compute queue is unavailable");
    await env.COMPUTE_QUEUE.send(message);
  });
  const outcomes = await Promise.allSettled(uniqueRunIds.map((runId) =>
    enqueue({ version: COMPUTE_DISPATCH_VERSION, run_id: runId })
  ));
  const enqueued = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
  return {
    candidates: uniqueRunIds.length,
    enqueued,
    failed: uniqueRunIds.length - enqueued,
  };
}
