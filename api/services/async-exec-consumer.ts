// Durable-execution queue consumer (PR3).
//
// Each message carries only { jobId }; everything else lives on the
// async_jobs row. Execution is AT-MOST-ONCE per job: the optimistic
// 'queued' -> 'running' claim is the idempotency guard against Queues'
// at-least-once delivery — a duplicate message finds the row already claimed
// and acks. Queue retries normally only help failures BEFORE the claim
// (DB blips). The sole post-claim exception is a structured capacity or
// concurrency admission denial: it proves tenant code never started, so the
// row safely returns to queued and a fresh delayed message resumes it.

import { getExecQueue } from "../lib/env.ts";
import {
  type AsyncJob,
  claimQueuedJob,
  failJobIfActive,
  getQueuedJobDeferredSchedule,
  withAsyncJobQueueOperationCounts,
} from "./async-jobs.ts";

type ExecMessageOutcome = "ack" | "retry";

interface ExecConsumerDeps {
  executeQueuedJob?: (job: AsyncJob) => Promise<
    | { kind: "complete" }
    | {
      kind: "deferred";
      retryAt: string;
      nextDeliveryAt: string;
      deferGeneration: number;
    }
  >;
}

function deferMessageBody(
  jobId: string,
  deferGeneration: number | null,
): { jobId: string; deferGeneration?: number } {
  return deferGeneration === null ? { jobId } : { jobId, deferGeneration };
}

function queueDelaySeconds(nextDeliveryAt: string): number {
  return Math.max(
    1,
    Math.min(
      12 * 60 * 60,
      Math.ceil((Date.parse(nextDeliveryAt) - Date.now()) / 1000),
    ),
  );
}

export async function processExecMessage(
  body: unknown,
  deps: ExecConsumerDeps = {},
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
  const rawDeferGeneration = body && typeof body === "object"
    ? (body as { deferGeneration?: unknown }).deferGeneration
    : undefined;
  const deferGeneration = rawDeferGeneration === undefined
    ? null
    : Number.isSafeInteger(rawDeferGeneration) && Number(rawDeferGeneration) > 0
    ? Math.floor(Number(rawDeferGeneration))
    : NaN;
  if (!jobId) {
    console.warn("[QUEUE-EXEC] Dropping malformed message:", body);
    return "ack";
  }
  if (Number.isNaN(deferGeneration)) {
    console.warn("[QUEUE-EXEC] Dropping malformed defer generation:", body);
    return "ack";
  }

  let job;
  try {
    job = await claimQueuedJob(jobId, { deferGeneration });
  } catch (err) {
    // Pre-claim infra failure: nothing has executed — safe to retry.
    console.warn(
      `[QUEUE-EXEC] Claim failed for job ${jobId}, will retry:`,
      err,
    );
    return "retry";
  }
  if (!job) {
    // A predecessor broker retry carries no (or an old) defer generation. It
    // must never hot-claim the row after deferJobAfterAdmission has moved it
    // back to queued. Instead repair the generation-specific delayed send.
    // If the original send was accepted before throwing, this may enqueue a
    // duplicate; the generation + queued→running CAS makes it harmless.
    let deferred;
    try {
      deferred = await getQueuedJobDeferredSchedule(jobId);
    } catch (err) {
      console.warn(
        `[QUEUE-EXEC] Deferred schedule lookup failed for ${jobId}, will retry:`,
        err,
      );
      return "retry";
    }
    if (deferred) {
      const queue = getExecQueue();
      if (!queue) {
        console.error(
          `[QUEUE-EXEC] Deferred job ${jobId} has no EXEC_QUEUE binding`,
        );
        return "retry";
      }
      try {
        await queue.send(
          deferMessageBody(jobId, deferred.deferGeneration),
          { delaySeconds: queueDelaySeconds(deferred.nextDeliveryAt) },
        );
        return "ack";
      } catch (err) {
        console.error(
          `[QUEUE-EXEC] Failed to repair deferred job ${jobId}:`,
          err,
        );
        return "retry";
      }
    }
    // Already claimed/terminal: at-least-once duplicate, or a sweep beat us.
    return "ack";
  }
  // The queue message carries only an id. Reconstruct the exact normal-path
  // write/read/delete cycles from the durable deferral count and pass the
  // trusted envelope to the execution/settlement layer in job.meta.
  job = withAsyncJobQueueOperationCounts(job);

  try {
    // Lazy import keeps the handler graph out of this module's load path
    // (same pattern as the event-bus dispatcher).
    const executeQueuedJob = deps.executeQueuedJob ??
      (await import("../handlers/mcp.ts")).executeQueuedJob;
    const outcome = await executeQueuedJob(job);
    if (outcome.kind === "deferred") {
      const queue = getExecQueue();
      if (!queue) {
        console.error(
          `[QUEUE-EXEC] Job ${jobId} was deferred but EXEC_QUEUE is unavailable`,
        );
        return "retry";
      }
      const delaySeconds = queueDelaySeconds(outcome.nextDeliveryAt);
      try {
        await queue.send(
          deferMessageBody(jobId, outcome.deferGeneration),
          { delaySeconds },
        );
      } catch (err) {
        // The row is safely back in queued. Retrying this broker message is
        // safe; if send accepted before throwing, the row claim arbitrates the
        // duplicate messages before tenant code can run.
        console.error(
          `[QUEUE-EXEC] Failed to schedule deferred job ${jobId}:`,
          err,
        );
        return "retry";
      }
    }
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
