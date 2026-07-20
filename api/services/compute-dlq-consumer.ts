import type { Env } from "../lib/env.ts";
import { getEnv } from "../lib/env.ts";
import { requireComputeUuid } from "./compute/authority.ts";
import { notifyComputeDispatchDeadLetter } from "./compute/alerts.ts";
import {
  fenceComputeDlqRun,
  terminalizeComputeDlqRun,
  type ComputeTerminalizationIdentity,
} from "./compute/reconciliation.ts";

const COMPUTE_DISPATCH_VERSION = 1 as const;

export interface ComputeDlqConsumerDeps {
  env?: Partial<Env>;
  fence?: typeof fenceComputeDlqRun;
  destroy?: (message: { version: 1; run_id: string }) => Promise<void>;
  terminalize?: typeof terminalizeComputeDlqRun;
  notify?: (run: ComputeTerminalizationIdentity) => Promise<void>;
}

function dispatch(value: unknown): { version: 1; run_id: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "run_id,version" ||
    record.version !== COMPUTE_DISPATCH_VERSION ||
    typeof record.run_id !== "string"
  ) return null;
  try {
    return {
      version: COMPUTE_DISPATCH_VERSION,
      run_id: requireComputeUuid(record.run_id, "runId"),
    };
  } catch {
    return null;
  }
}

/** Consume the original exhausted dispatch without trusting any embedded state. */
export async function processComputeDlqMessage(
  value: unknown,
  deps: ComputeDlqConsumerDeps = {},
): Promise<"ack" | "retry"> {
  const message = dispatch(value);
  if (!message) {
    console.error("[COMPUTE] Dropped malformed Compute DLQ message");
    return "ack";
  }
  const env = deps.env ?? getEnv();
  const fence = deps.fence ?? fenceComputeDlqRun;
  const destroy = deps.destroy ?? (async (body) => {
    if (!env.COMPUTE_PLANE) throw new Error("Compute plane is unavailable");
    await env.COMPUTE_PLANE.cancelRun(body);
  });
  const terminalize = deps.terminalize ?? terminalizeComputeDlqRun;
  const notify = deps.notify ?? ((run) => notifyComputeDispatchDeadLetter(run));

  try {
    const fenced = await fence({
      runId: message.run_id,
      reason: "compute_dispatch_dlq_exhausted",
    });
    if (fenced.terminal) return "ack";
    if ("skipped" in fenced) return "ack";
    let bodyDestroyed = false;
    if (fenced.candidate.requiresBodyDestroy) {
      await destroy(message);
      bodyDestroyed = true;
    }
    const terminal = await terminalize({
      runId: message.run_id,
      expectedStateVersion: fenced.candidate.stateVersion,
      bodyDestroyed,
    });
    await notify(terminal).catch(() => undefined);
    return "ack";
  } catch (error) {
    console.error("[COMPUTE] DLQ reconciliation failed", {
      run_id: message.run_id,
      error: error instanceof Error ? error.message : "unknown failure",
    });
    return "retry";
  }
}
