// Durable-execution queue consumer (PR3).
//
// Each message carries only { jobId }; everything else lives on the
// async_jobs row. Execution is AT-MOST-ONCE per job: the optimistic
// 'queued' -> 'running' claim is the idempotency guard against Queues'
// at-least-once delivery — a duplicate message finds the row already claimed
// and acks. Queue retries therefore only help failures BEFORE the claim
// (DB blips); after the claim, a crashed invocation is recovered by the
// stale-job sweeper, never by re-running a possibly-settled execution.

import { claimQueuedJob, failJobIfActive } from "./async-jobs.ts";

type ExecMessageOutcome = "ack" | "retry";

export async function processExecMessage(
  body: unknown,
): Promise<ExecMessageOutcome> {
  // Routine runs share EXEC_QUEUE (already provisioned) and are discriminated
  // by the routineRunId key. They must execute here in the consumer context —
  // the dynamic sandbox (env.LOADER) cannot run from the scheduled() cron.
  const routineRunId = body && typeof body === "object" &&
      typeof (body as { routineRunId?: unknown }).routineRunId === "string"
    ? (body as { routineRunId: string }).routineRunId
    : null;
  if (routineRunId) {
    const { processQueuedRoutineRun } = await import("./routine-executor.ts");
    return await processQueuedRoutineRun({ routineRunId });
  }

  const jobId = body && typeof body === "object" &&
      typeof (body as { jobId?: unknown }).jobId === "string"
    ? (body as { jobId: string }).jobId
    : null;
  if (!jobId) {
    console.warn("[QUEUE-EXEC] Dropping malformed message:", body);
    return "ack";
  }

  let job;
  try {
    job = await claimQueuedJob(jobId);
  } catch (err) {
    // Pre-claim infra failure: nothing has executed — safe to retry.
    console.warn(`[QUEUE-EXEC] Claim failed for job ${jobId}, will retry:`, err);
    return "retry";
  }
  if (!job) {
    // Already claimed/terminal: at-least-once duplicate, or a sweep beat us.
    return "ack";
  }

  try {
    // Lazy import keeps the handler graph out of this module's load path
    // (same pattern as the event-bus dispatcher).
    const { executeQueuedJob } = await import("../handlers/mcp.ts");
    await executeQueuedJob(job);
  } catch (err) {
    // The job is claimed — never retry the message (the execution may have
    // run and settled before throwing). Record the failure and ack.
    console.error(`[QUEUE-EXEC] Job ${jobId} failed:`, err);
    await failJobIfActive(jobId, {
      type: "ExecutionError",
      message: err instanceof Error ? err.message : String(err),
    }, 0).catch(() => {});
  }
  return "ack";
}
