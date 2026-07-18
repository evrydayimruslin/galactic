// Async Job Service — durable execution (PR3).
// A job is created in 'queued' status at dispatch time with everything the
// queue consumer needs to reconstruct the execution; the consumer claims it
// ('queued' -> 'running', the at-least-once idempotency guard), runs the full
// pipeline, and finishes it 'completed'/'failed'. State lives in Supabase;
// the queue message carries only { jobId }.

import { getEnv } from "../lib/env.ts";

function supabaseHeaders() {
  return {
    "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
    "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };
}

/** Max result size before offloading to R2 (1MB) */
const MAX_RESULT_SIZE = 1_000_000;

/**
 * Stale 'running' threshold, keyed off started_at (claim time). Must exceed
 * the max consumer execution budget (300s) plus settlement headroom — a
 * running row older than this means the consumer invocation died mid-flight.
 */
const STALE_RUNNING_MS = 10 * 60_000;

/**
 * Stale 'queued' backstop, keyed off created_at. Queues are at-least-once
 * with retries + DLQ, so a queued row this old means its message was lost or
 * dead-lettered.
 */
const STALE_QUEUED_MS = 60 * 60_000;

export interface AsyncJob {
  id: string;
  app_id: string;
  user_id: string;
  owner_id: string;
  function_name: string;
  status: "queued" | "running" | "completed" | "failed";
  args: Record<string, unknown>;
  caller_app_id: string | null;
  caller_grant_id: string | null;
  hop: number | null;
  result: unknown;
  result_r2_key: string | null;
  error: unknown;
  logs: unknown[];
  duration_ms: number | null;
  ai_cost_light: number;
  execution_id: string;
  server_instance: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  meta: Record<string, unknown>;
  created_at: string;
}

interface AsyncJobQueueOperationCounts {
  /** Prior capacity deferrals that completed a normal broker cycle. */
  deferredCycles: number;
  /** Prior cycles plus the currently claimed delivery. */
  deliveryCycles: number;
  write: number;
  read: number;
  delete: number;
  total: number;
}

interface AsyncJobDeferredSchedule {
  jobId: string;
  nextDeliveryAt: string;
  deferGeneration: number | null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

export function nextAsyncJobDeferGeneration(
  job: Pick<AsyncJob, "meta">,
): number {
  return nonNegativeInteger(job.meta?.capacity_defer_count) + 1;
}

/**
 * Exact normal-path Queue operations attributable to a claimed async EXEC.
 * A cycle is one producer write, one consumer read, and one ack/delete. Each
 * structured capacity deferral completes that cycle and schedules the next;
 * the current claim contributes the final cycle that will settle with the
 * execution. Broker redeliveries after crashes/ambiguous sends are excluded
 * because they cannot be proven from the durable job row.
 */
export function asyncJobQueueOperationCounts(
  job: Pick<AsyncJob, "meta">,
): AsyncJobQueueOperationCounts {
  const deferredCycles = nonNegativeInteger(job.meta?.capacity_defer_count);
  const deliveryCycles = deferredCycles + 1;
  return {
    deferredCycles,
    deliveryCycles,
    write: deliveryCycles,
    read: deliveryCycles,
    delete: deliveryCycles,
    total: deliveryCycles * 3,
  };
}

/** Attach the trusted Queue fact envelope consumed by capacity settlement. */
export function withAsyncJobQueueOperationCounts(job: AsyncJob): AsyncJob {
  const counts = asyncJobQueueOperationCounts(job);
  return {
    ...job,
    meta: {
      ...(job.meta || {}),
      capacity_queue_deferred_cycles: counts.deferredCycles,
      capacity_queue_delivery_cycles: counts.deliveryCycles,
      capacity_queue_operations: {
        write: counts.write,
        read: counts.read,
        delete: counts.delete,
        total: counts.total,
      },
    },
  };
}

interface AsyncJobAdmissionWait {
  code:
    | "capacity_waiting"
    | "agent_cap_waiting"
    | "concurrency_waiting";
  retryAt: string;
  message: string;
  details?: Record<string, unknown> | null;
}

interface AsyncJobAdmissionStatus {
  code: AsyncJobAdmissionWait["code"];
  retryAt: string;
  nextAttemptAt: string | null;
  scope: "account" | "agent" | "ai" | "routine" | null;
  message: string | null;
}

export function asyncJobAdmissionStatus(
  job: Pick<AsyncJob, "status" | "meta">,
): AsyncJobAdmissionStatus | null {
  if (job.status !== "queued") return null;
  const code = job.meta?.capacity_wait_code;
  const retryAt = job.meta?.capacity_retry_at;
  if (
    (code !== "capacity_waiting" && code !== "agent_cap_waiting" &&
      code !== "concurrency_waiting") ||
    typeof retryAt !== "string" || !Number.isFinite(Date.parse(retryAt))
  ) return null;
  const details = job.meta?.capacity_wait_details;
  const scopeValue = details && typeof details === "object"
    ? (details as Record<string, unknown>).concurrency_scope ??
      (details as Record<string, unknown>).binding_constraint
    : null;
  const scope = scopeValue === "account" || scopeValue === "agent" ||
      scopeValue === "ai" || scopeValue === "routine"
    ? scopeValue
    : null;
  const nextAttempt = job.meta?.capacity_next_delivery_at;
  return {
    code,
    retryAt,
    nextAttemptAt: typeof nextAttempt === "string" &&
        Number.isFinite(Date.parse(nextAttempt))
      ? nextAttempt
      : null,
    scope,
    message: typeof job.meta?.capacity_wait_message === "string"
      ? job.meta.capacity_wait_message
      : null,
  };
}

// Lazily initialized: Workers reject scripts that generate random values in
// global scope (deploy-time validation error 10021).
let serverInstance: string | null = null;

function getServerInstance(): string {
  if (serverInstance === null) {
    serverInstance = `cf-${Date.now()}-${
      Math.random().toString(36).slice(2, 8)
    }`;
  }
  return serverInstance;
}

/**
 * Create a job in 'queued' status at dispatch time. Persists the full
 * execution request (the queue message carries only the job id). The caller's
 * bearer token is deliberately NOT persisted — queued executions cannot make
 * as-the-user calls, exactly like event deliveries.
 */
export async function createQueuedJob(params: {
  appId: string;
  userId: string;
  ownerId: string;
  functionName: string;
  args: Record<string, unknown>;
  callerAppId?: string | null;
  callerGrantId?: string | null;
  hop?: number | null;
  meta?: Record<string, unknown>;
}): Promise<string> {
  const jobId = crypto.randomUUID();

  const res = await fetch(`${getEnv("SUPABASE_URL")}/rest/v1/async_jobs`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({
      id: jobId,
      app_id: params.appId,
      user_id: params.userId,
      owner_id: params.ownerId,
      function_name: params.functionName,
      status: "queued",
      args: params.args ?? {},
      caller_app_id: params.callerAppId ?? null,
      caller_grant_id: params.callerGrantId ?? null,
      hop: params.hop ?? null,
      // Reused as the sandbox executionId on claim, linking job <-> receipt
      // <-> AI-spend ledger.
      execution_id: crypto.randomUUID(),
      meta: {
        ...(params.meta || {}),
        // A durable queued row starts with one accepted producer write. The
        // consumer replaces this projection with the complete normal delivery
        // cycles before invoking the execution pipeline.
        capacity_queue_deferred_cycles: 0,
        capacity_queue_delivery_cycles: 0,
        capacity_queue_operations: { write: 1, read: 0, delete: 0, total: 1 },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to create queued job: ${err}`);
  }

  return jobId;
}

/**
 * Optimistically claim a queued job ('queued' -> 'running'). Returns the
 * claimed row, or null when the job was already claimed/terminal — the
 * consumer's at-least-once duplicate-delivery guard.
 */
export async function claimQueuedJob(
  jobId: string,
  options: { deferGeneration?: number | null; now?: Date } = {},
): Promise<AsyncJob | null> {
  const deferGeneration = Number.isSafeInteger(options.deferGeneration) &&
      Number(options.deferGeneration) > 0
    ? Math.floor(Number(options.deferGeneration))
    : null;
  const nowIso = (options.now ?? new Date()).toISOString();
  const generationFilter = deferGeneration === null
    ? "meta->>capacity_defer_generation=is.null"
    : `meta->>capacity_defer_generation=eq.${deferGeneration}`;
  const res = await fetch(
    `${
      getEnv("SUPABASE_URL")
    }/rest/v1/async_jobs?id=eq.${jobId}&status=eq.queued&${generationFilter}` +
      `&or=(started_at.is.null,started_at.lte.${nowIso})`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({
        status: "running",
        started_at: new Date().toISOString(),
        server_instance: getServerInstance(),
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to claim queued job ${jobId}: ${err}`);
  }
  const rows = await res.json().catch(() => []) as AsyncJob[];
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Read a queued admission deferral that the current broker message was not
 * authorized to claim. A predecessor retry can use this to (re)schedule the
 * generation-specific delayed message instead of hot-running before reset.
 */
export async function getQueuedJobDeferredSchedule(
  jobId: string,
): Promise<AsyncJobDeferredSchedule | null> {
  const res = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/async_jobs?id=eq.${jobId}` +
      "&status=eq.queued&select=id,started_at,meta&limit=1",
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to read deferred job ${jobId}: ${err}`);
  }
  const rows = await res.json().catch(() => []) as Array<{
    id?: unknown;
    started_at?: unknown;
    meta?: Record<string, unknown> | null;
  }>;
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || typeof row.id !== "string") return null;
  const meta = row.meta && typeof row.meta === "object" ? row.meta : {};
  const nextDeliveryAt = typeof meta.capacity_next_delivery_at === "string"
    ? meta.capacity_next_delivery_at
    : typeof row.started_at === "string"
    ? row.started_at
    : null;
  if (
    typeof meta.capacity_wait_code !== "string" || !nextDeliveryAt ||
    !Number.isFinite(Date.parse(nextDeliveryAt))
  ) return null;
  const rawGeneration = meta.capacity_defer_generation;
  const generation = Number.isSafeInteger(rawGeneration) &&
      Number(rawGeneration) > 0
    ? Math.floor(Number(rawGeneration))
    : null;
  return { jobId: row.id, nextDeliveryAt, deferGeneration: generation };
}

// Normalize a failed execution's error payload to failJob's {type, message}
// shape (the `error` column is jsonb; ul.job surfaces it verbatim).
function serializeJobError(value: unknown): { type: string; message: string } {
  if (value && typeof value === "object") {
    const v = value as { type?: unknown; message?: unknown };
    return {
      type: typeof v.type === "string" && v.type ? v.type : "ExecutionError",
      message: typeof v.message === "string" && v.message
        ? v.message
        : JSON.stringify(value),
    };
  }
  return {
    type: "ExecutionError",
    message: value === null || value === undefined
      ? "Execution failed"
      : String(value),
  };
}

/** Complete a job with its result */
export async function completeJob(jobId: string, result: {
  success: boolean;
  result: unknown;
  logs: unknown[];
  durationMs: number;
  aiCostLight: number;
}): Promise<void> {
  // Check result size — offload to R2 if too large
  let storedResult = result.success ? result.result : null;
  let resultR2Key: string | null = null;

  try {
    const serialized = JSON.stringify(storedResult);
    if (serialized && serialized.length > MAX_RESULT_SIZE) {
      // Store in R2 and save key
      resultR2Key = `async-jobs/${jobId}/result.json`;
      await storeResultInR2(resultR2Key, storedResult);
      storedResult = { _r2: true, key: resultR2Key, size: serialized.length };
    }
  } catch {
    storedResult = { _error: "Result could not be serialized" };
  }

  const updatePayload: Record<string, unknown> = {
    // A failed execution is a FAILED job — writing 'completed' here made
    // ul.job report success with a null result and a hidden error.
    status: result.success ? "completed" : "failed",
    result: storedResult,
    result_r2_key: resultR2Key,
    error: result.success ? null : serializeJobError(result.result),
    logs: (result.logs || []).slice(0, 100), // Cap log entries
    duration_ms: result.durationMs,
    ai_cost_light: result.aiCostLight,
    completed_at: new Date().toISOString(),
  };

  const res = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/async_jobs?id=eq.${jobId}`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify(updatePayload),
    },
  );

  if (!res.ok) {
    console.error(
      `[ASYNC-JOBS] Failed to complete job ${jobId}:`,
      await res.text().catch(() => ""),
    );
  }
}

/** Fail a job */
export async function failJob(
  jobId: string,
  error: {
    type: string;
    message: string;
  },
  durationMs: number,
  extras?: {
    // AI calls that completed before the failure were still billed — keep the
    // spend (and logs) on the row so ul.job reports the truth.
    aiCostLight?: number;
    logs?: unknown[];
  },
): Promise<void> {
  const res = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/async_jobs?id=eq.${jobId}`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({
        status: "failed",
        error,
        duration_ms: durationMs,
        completed_at: new Date().toISOString(),
        ...(extras?.aiCostLight !== undefined
          ? { ai_cost_light: extras.aiCostLight }
          : {}),
        ...(extras?.logs ? { logs: extras.logs.slice(0, 100) } : {}),
      }),
    },
  );

  if (!res.ok) {
    console.error(
      `[ASYNC-JOBS] Failed to fail job ${jobId}:`,
      await res.text().catch(() => ""),
    );
  }
}

/**
 * Reclaim a job after queue.send() threw, so the dispatcher can safely fall
 * back to synchronous execution. A send() rejection does NOT prove the
 * message was never enqueued — the broker may have accepted it before the
 * error. This PATCH races the consumer's claim through the same status
 * filter: whoever flips 'queued' first owns the execution. Returns true when
 * we won (row marked failed; run synchronously), false when the consumer
 * already claimed it (do NOT execute — return the job envelope instead).
 */
export async function reclaimJobForSyncFallback(
  jobId: string,
  error: { type: string; message: string },
): Promise<boolean> {
  const res = await fetch(
    `${
      getEnv("SUPABASE_URL")
    }/rest/v1/async_jobs?id=eq.${jobId}&status=eq.queued`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({
        status: "failed",
        error,
        duration_ms: 0,
        completed_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) {
    // Ambiguous: we could not take ownership, and the consumer might. The
    // only safe answer is "don't run it here".
    console.error(
      `[ASYNC-JOBS] Reclaim failed for job ${jobId}:`,
      await res.text().catch(() => ""),
    );
    return false;
  }
  const rows = await res.json().catch(() => []) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Fail a job only while it is still non-terminal. Used by the queue consumer
 * for pipeline-level failures: when the pipeline already finalized the row
 * (e.g. insufficient-balance writes a detailed failure BEFORE returning a
 * JSON-RPC error), this is a no-op instead of clobbering it.
 */
export async function failJobIfActive(jobId: string, error: {
  type: string;
  message: string;
}, durationMs: number): Promise<void> {
  const res = await fetch(
    `${
      getEnv("SUPABASE_URL")
    }/rest/v1/async_jobs?id=eq.${jobId}&status=in.(queued,running)`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({
        status: "failed",
        error,
        duration_ms: durationMs,
        completed_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) {
    console.error(
      `[ASYNC-JOBS] Failed to fail job ${jobId}:`,
      await res.text().catch(() => ""),
    );
  }
}

/**
 * Return a claimed job to the durable queue after a structured admission
 * denial proves tenant code never started. This is the sole safe post-claim
 * retry lane: ordinary failures may already have side effects and remain
 * terminal. `started_at` temporarily carries the next broker delivery time
 * while status=queued, so the stale-job sweep does not kill a legitimate
 * multi-hour capacity wait before its delayed message arrives.
 */
export async function deferJobAfterAdmission(
  job: AsyncJob,
  wait: AsyncJobAdmissionWait,
  nextDeliveryAt: string,
): Promise<boolean> {
  const previousCount = nonNegativeInteger(job.meta?.capacity_defer_count);
  const deferGeneration = previousCount + 1;
  const retryAtMs = Date.parse(wait.retryAt);
  const currentExpiryMs = Date.parse(job.expires_at || "");
  const extendedExpiry = Number.isFinite(retryAtMs)
    ? new Date(Math.max(
      Number.isFinite(currentExpiryMs) ? currentExpiryMs : 0,
      retryAtMs + 60 * 60_000,
    )).toISOString()
    : job.expires_at;
  const res = await fetch(
    `${
      getEnv("SUPABASE_URL")
    }/rest/v1/async_jobs?id=eq.${job.id}&status=eq.running`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({
        status: "queued",
        // On a queued admission wait this is the next expected broker attempt,
        // not an execution start. claimQueuedJob overwrites it before running.
        started_at: nextDeliveryAt,
        server_instance: null,
        completed_at: null,
        error: null,
        ...(extendedExpiry ? { expires_at: extendedExpiry } : {}),
        meta: {
          ...(job.meta || {}),
          capacity_defer_count: previousCount + 1,
          capacity_queue_deferred_cycles: previousCount + 1,
          // Delayed messages carry this generation. A retry of the predecessor
          // message has no matching generation and therefore cannot claim the
          // row early; it can only repair/reschedule this delayed delivery.
          capacity_defer_generation: deferGeneration,
          capacity_wait_code: wait.code,
          capacity_retry_at: wait.retryAt,
          capacity_next_delivery_at: nextDeliveryAt,
          capacity_wait_message: wait.message,
          ...(wait.details ? { capacity_wait_details: wait.details } : {}),
        },
      }),
    },
  );
  if (!res.ok) {
    console.error(
      `[ASYNC-JOBS] Failed to defer job ${job.id}:`,
      await res.text().catch(() => ""),
    );
    return false;
  }
  const rows = await res.json().catch(() => []) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/** Get a job by ID (user-scoped for security) */
export async function getJob(
  jobId: string,
  userId: string,
): Promise<AsyncJob | null> {
  const res = await fetch(
    `${
      getEnv("SUPABASE_URL")
    }/rest/v1/async_jobs?id=eq.${jobId}&user_id=eq.${userId}&select=*`,
    { headers: supabaseHeaders() },
  );

  if (!res.ok) return null;
  const rows = await res.json() as AsyncJob[];
  const job = rows[0];
  if (!job) return null;

  // If result was offloaded to R2, fetch it
  if (job.status === "completed" && job.result_r2_key) {
    try {
      job.result = await loadResultFromR2(job.result_r2_key);
    } catch {
      job.result = { _error: "Failed to load result from storage" };
    }
  }

  return job;
}

/** Fail stale jobs (consumer crashed mid-execution, or queue message lost) */
export async function cleanupStaleJobs(): Promise<number> {
  // 'running' staleness keys off started_at (claim time): a row older than
  // the consumer's max budget + headroom means the invocation died mid-flight
  // (created_at would wrongly kill jobs that merely waited in a backlog;
  // started_at-less legacy rows fall back to created_at). 'queued' is a
  // backstop: at-least-once delivery + retries + DLQ make a lost message
  // near-impossible, but a queued row this old will never execute.
  const runningCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  const queuedCutoff = new Date(Date.now() - STALE_QUEUED_MS).toISOString();
  const staleFilter = `or=(` +
    `and(status.eq.running,started_at.lt.${runningCutoff}),` +
    `and(status.eq.running,started_at.is.null,created_at.lt.${runningCutoff}),` +
    // Ordinary queued rows have started_at=null. Admission-deferred rows use
    // started_at as their next expected delivery and get the same one-hour
    // grace after that time before the lost-message backstop can fail them.
    `and(status.eq.queued,created_at.lt.${queuedCutoff},` +
    `or(started_at.is.null,started_at.lt.${queuedCutoff})))`;

  // Cheap probe first — the minute cron must not issue a blind write per tick.
  const probe = await fetch(
    `${
      getEnv("SUPABASE_URL")
    }/rest/v1/async_jobs?${staleFilter}&select=id&limit=200`,
    { headers: supabaseHeaders() },
  );
  if (!probe.ok) return 0;
  const stale = await probe.json().catch(() => []) as Array<{ id: string }>;
  if (!Array.isArray(stale) || stale.length === 0) return 0;

  // The write re-applies the FULL staleness filter, not just a status check:
  // a queued job claimed between probe and PATCH gets a fresh started_at and
  // must not be failed by a sweep that probed it under its old status.
  const ids = stale.map((row) => row.id).join(",");
  const res = await fetch(
    `${
      getEnv("SUPABASE_URL")
    }/rest/v1/async_jobs?id=in.(${ids})&${staleFilter}`,
    {
      method: "PATCH",
      headers: { ...supabaseHeaders(), "Prefer": "return=headers-only" },
      body: JSON.stringify({
        status: "failed",
        error: {
          type: "ServerTimeout",
          message:
            "Execution exceeded its window or was never picked up (worker restart or lost queue message)",
        },
        completed_at: new Date().toISOString(),
      }),
    },
  );

  if (!res.ok) return 0;
  return stale.length;
}

/** R2 storage helpers for large results */
async function storeResultInR2(key: string, value: unknown): Promise<void> {
  const WORKER_URL = getEnv("WORKER_URL");
  if (!WORKER_URL) {
    console.error("[ASYNC-JOBS] No WORKER_URL configured for R2 storage");
    return;
  }

  await fetch(`${WORKER_URL}/r2/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

async function loadResultFromR2(key: string): Promise<unknown> {
  const WORKER_URL = getEnv("WORKER_URL");
  if (!WORKER_URL) return null;

  const res = await fetch(
    `${WORKER_URL}/r2/load?key=${encodeURIComponent(key)}`,
  );
  if (!res.ok) return null;
  return res.json();
}
