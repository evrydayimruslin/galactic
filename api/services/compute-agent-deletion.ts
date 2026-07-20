import type { Env } from "../lib/env.ts";
import { getEnv } from "../lib/env.ts";
import {
  getComputeAgentPolicy,
  setComputeAgentPolicyState,
} from "./compute/policies.ts";
import {
  listActiveComputeRunsForAgentInternal,
  terminalizeComputeRunCancellation,
} from "./compute/runs.ts";
import type { ComputeAgentPolicy, ComputeRun } from "./compute/types.ts";

export interface ComputeAgentDeletionDeps {
  env?: Partial<Env>;
  getPolicy?: typeof getComputeAgentPolicy;
  revokePolicy?: typeof setComputeAgentPolicyState;
  listActiveRuns?: typeof listActiveComputeRunsForAgentInternal;
  terminalize?: typeof terminalizeComputeRunCancellation;
}

/**
 * Security precondition for Agent soft deletion. Policy revocation atomically
 * terminalizes unclaimed work and fences claimed work; every deterministic
 * body is then coordinated to a final destroy before deletion may continue.
 */
export async function revokeAgentComputeBeforeDeletion(
  input: { userId: string; agentId: string },
  deps: ComputeAgentDeletionDeps = {},
): Promise<void> {
  const getPolicy = deps.getPolicy ?? getComputeAgentPolicy;
  const policy = await getPolicy(input);
  if (!policy) return;
  if (policy.state !== "revoked") {
    await (deps.revokePolicy ?? setComputeAgentPolicyState)({
      ...input,
      state: "revoked",
      expectedAuthorityEpoch: policy.authorityEpoch,
    });
  }
  const active = await (deps.listActiveRuns ??
    listActiveComputeRunsForAgentInternal)(input);
  if (active.length === 0) return;
  const env = deps.env ?? getEnv();
  if (!env.COMPUTE_PLANE) {
    throw new Error("Compute body revocation is unavailable; Agent deletion is blocked.");
  }
  const terminalize = deps.terminalize ?? terminalizeComputeRunCancellation;
  for (const run of active) {
    await env.COMPUTE_PLANE.cancelRun({ version: 1, run_id: run.id });
    await terminalize({
      runId: run.id,
      userId: run.userId,
      agentId: run.agentId,
      callerFunction: run.callerFunction,
      expectedStateVersion: run.stateVersion,
      bodyDestroyed: true,
    });
  }
}

export type { ComputeAgentPolicy, ComputeRun };
