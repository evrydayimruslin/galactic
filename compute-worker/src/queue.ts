import type { Env } from "./contracts";
import { ComputeRunBusyError } from "./errors";

export type ComputeRunExecutor = (
  env: Env,
  body: unknown,
) => Promise<unknown>;

export type ComputeQueueDeliveryOutcome = "ack" | "deferred";

function isComputeRunBusy(error: unknown): boolean {
  // Durable Object RPC serializes thrown errors. Do not rely exclusively on a
  // custom prototype surviving that boundary; require both the stable name
  // and message before treating a delivery as a harmless concurrency miss.
  return error instanceof ComputeRunBusyError ||
    (error instanceof Error && error.name === "ComputeRunBusyError" &&
      error.message === "compute concurrency slot is busy");
}

/**
 * A per-Agent concurrency miss is durable queueing state, not a failed run.
 * ACK this delivery and let the API minute dispatcher re-enqueue the still-
 * queued row. Throw every real execution failure so Cloudflare retry/DLQ
 * semantics remain intact.
 */
export async function processComputeQueueDelivery(
  env: Env,
  body: unknown,
  execute: ComputeRunExecutor,
): Promise<ComputeQueueDeliveryOutcome> {
  try {
    await execute(env, body);
    return "ack";
  } catch (error) {
    if (isComputeRunBusy(error)) return "deferred";
    throw error;
  }
}
