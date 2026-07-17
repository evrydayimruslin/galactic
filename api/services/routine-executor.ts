import { getEnv, getExecQueue } from "../lib/env.ts";
import type { RoutineBudgetDefaults } from "../../shared/contracts/routine.ts";
import {
  createRoutineActorTokenForRun,
  type RoutineActorUserInput,
} from "./routine-auth.ts";
import {
  getRoutine,
  isLaunchManagedRoutine,
  type NormalizedRoutineSchedule,
  recordRoutineRunStep,
  type RoutineCapabilityRow,
  type RoutineRunRow,
  type RoutineRunStatus,
  type StoredRoutine,
  validateRoutineActivation,
} from "./routines.ts";
import { createNotification } from "./notifications.ts";
import { validateRoutineLaunchActivation } from "./routine-platform.ts";
import {
  attachDeferredWakeToRun,
  recordDeferredRoutineWake,
  releaseAccountCapacity,
  reserveAccountCapacity,
} from "./account-capacity.ts";
import {
  computeNextRoutineRunAt as computeProductionRoutineRunAt,
  RoutineScheduleValidationError,
} from "./routine-schedule.ts";

const ROUTINE_SELECT =
  "id,user_id,composer_app_id,composer_app_slug,template_id,template_version,name,description,intent,handler_function,status,schedule,config,budget_policy,approval_policy,max_concurrency,next_run_at,last_run_at,last_success_at,last_error_at,failure_count,created_by_trace_id,metadata,created_at,updated_at,deleted_at,lease_id,lease_expires_at";
const RUN_SELECT =
  "id,routine_id,user_id,status,trigger,trace_id,started_at,completed_at,duration_ms,total_light,summary,error,run_config,metadata,created_at,lease_id,lease_expires_at,attempt_count,max_attempts,next_attempt_at";
const USER_SELECT = "id,email,tier,provisional";

const DEFAULT_LIMIT = 10;
const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
const MAX_RETRY_DELAY_SECONDS = 15 * 60;
// Circuit breaker: consecutive failed ATTEMPTS (failure_count resets to 0 on
// any success) before the routine is auto-paused. At the default retry policy
// (3 attempts/run) the default trips after ~3-4 fully failed runs. Overridable
// per routine via metadata.circuit_breaker.max_consecutive_failures (1-100).
const DEFAULT_BREAKER_FAILURES = 10;
// max_calls_per_run is verified by counting the run's recorded contribution
// steps; caps at or above this bound cannot be verified cheaply and are inert.
const MAX_VERIFIABLE_CALLS_CAP = 500;
// Backstop timeout on a single handler invocation. The in-process handler runs
// the dynamic sandbox, which self-limits to 30s (default) / 120s (max) — this
// only fires if an invocation wedges beyond that, so a single stuck routine can
// never stall the shared minute-cron (runRoutineExecutorCycle runs inside the
// worker's Promise.allSettled cron cycle alongside billing, events, etc.).
const HANDLER_INVOKE_TIMEOUT_MS = 130_000;

// Invokes the /mcp/{appId} pipeline for the composer app. Defaults to an
// IN-PROCESS handleMcp call (see invokeRoutineHandler for why); overridable in
// tests to intercept the request without a real handler.
type InvokeMcp = (request: Request, appId: string) => Promise<Response>;

export interface RoutineExecutorOptions {
  now?: Date;
  clock?: () => Date;
  limit?: number;
  leaseMs?: number;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  invokeMcp?: InvokeMcp;
  handlerTimeoutMs?: number;
  // Where claimed runs are dispatched for handler execution. Defaults to the
  // bound EXEC_QUEUE. Explicit `null` forces INLINE execution (tests + any env
  // without queues) — the same in-process path the consumer uses. In prod the
  // queue is always bound, so runs execute in the queue consumer, NOT in the
  // scheduled() cron: the dynamic sandbox (env.LOADER) cannot run from the cron
  // context and hangs there, whereas the queue consumer runs in a normal
  // request context (exactly how events + async jobs already work).
  execQueue?: QueueLike | null;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

class AccountCapacityWaitingError extends Error {
  constructor(readonly retryAt: string) {
    super(`Account capacity is waiting until ${retryAt}`);
    this.name = "AccountCapacityWaitingError";
  }
}

class AgentCapacityCapTooLowError extends Error {
  constructor(readonly details: Record<string, unknown>) {
    super(
      "The Agent capacity cap is too low to admit one execution. Increase the cap before resuming.",
    );
    this.name = "AgentCapacityCapTooLowError";
  }
}

export interface RoutineExecutorSummary {
  checked_at: string;
  // Runs abandoned mid-flight ("running" past lease, or a lost queued message)
  // that this cycle failed terminally to unwedge max_concurrency.
  reaped: number;
  claimed_scheduled: number;
  claimed_queued: number;
  // Runs handed to the EXEC_QUEUE consumer for handler execution (prod path).
  dispatched: number;
  executed: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
  budget_skipped: number;
  auto_paused: number;
  errors: Array<{ run_id?: string; routine_id?: string; error: string }>;
}

// EXEC_QUEUE message shape for a routine run. Discriminated from async-job
// messages ({ jobId }) by the routineRunId key. The run is left "queued" on
// enqueue; the consumer claims queued->running, which is the at-most-once guard
// against Queues' at-least-once delivery.
interface RoutineRunQueueMessage {
  routineRunId: string;
}

interface QueueLike {
  send(body: unknown): Promise<void>;
}

interface ExecutorRoutineRow {
  id: string;
  user_id: string;
  composer_app_id: string | null;
  composer_app_slug: string | null;
  template_id: string;
  template_version: string | null;
  name: string;
  description: string | null;
  intent: string | null;
  handler_function: string;
  status: string;
  schedule: NormalizedRoutineSchedule;
  config: Record<string, unknown>;
  budget_policy: RoutineBudgetDefaults;
  approval_policy: Record<string, unknown>;
  max_concurrency: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  failure_count: number;
  created_by_trace_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
}

interface ExecutorRunRow extends RoutineRunRow {
  lease_id: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
}

interface ExecutorUserRow {
  id: string;
  email: string;
  tier: string | null;
  provisional: boolean | null;
}

interface RetryPolicy {
  maxAttempts: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
}

interface ClaimedRun {
  run: ExecutorRunRow;
  routine?: StoredRoutine;
  source: "scheduled" | "queued";
}

function serviceHeaders(
  prefer = "return=representation",
): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    "Prefer": prefer,
  };
}

function restUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${getEnv("SUPABASE_URL")}/rest/v1/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function readRows<T>(res: Response, label: string): Promise<T[]> {
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(`${label} (${res.status}): ${message}`);
  }
  const value = await res.json();
  return Array.isArray(value) ? value as T[] : [];
}

async function fetchRows<T>(
  table: string,
  params: Record<string, string>,
  label: string,
): Promise<T[]> {
  return await readRows<T>(
    await fetch(restUrl(table, params), { headers: serviceHeaders() }),
    label,
  );
}

async function patchRows<T>(
  table: string,
  params: Record<string, string>,
  payload: Record<string, unknown>,
  label: string,
): Promise<T[]> {
  return await readRows<T>(
    await fetch(restUrl(table, params), {
      method: "PATCH",
      headers: serviceHeaders(),
      body: JSON.stringify(payload),
    }),
    label,
  );
}

async function insertRows<T>(
  table: string,
  params: Record<string, string>,
  payload: Record<string, unknown>,
  label: string,
): Promise<T[]> {
  return await readRows<T>(
    await fetch(restUrl(table, params), {
      method: "POST",
      headers: serviceHeaders(),
      body: JSON.stringify(payload),
    }),
    label,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function iso(date: Date): string {
  return date.toISOString();
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function computeNextRoutineRunAt(
  schedule: NormalizedRoutineSchedule,
  from: Date,
): Date | null {
  try {
    return computeProductionRoutineRunAt(schedule, from);
  } catch (error) {
    // Creation/update reject malformed schedules. Legacy invalid rows must not
    // crash the shared scheduler cycle while operators repair them.
    if (error instanceof RoutineScheduleValidationError) return null;
    throw error;
  }
}

function sanitizePreview(
  value: unknown,
  maxChars = 2000,
): Record<string, unknown> {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= maxChars) return { value };
    return { truncated: true, text: text.slice(0, maxChars) };
  } catch {
    return { value_type: typeof value };
  }
}

function unwrapMcpToolResult(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const content = value.content;
  if (!Array.isArray(content)) return value;
  const textBlock = content.find((entry) =>
    isRecord(entry) && entry.type === "text" && typeof entry.text === "string"
  ) as { text?: string } | undefined;
  if (!textBlock?.text) return value;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return textBlock.text;
  }
}

function errorPayload(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  };
}

function retryPolicyFrom(
  routine: StoredRoutine | ExecutorRoutineRow,
  run?: ExecutorRunRow,
): RetryPolicy {
  const raw = [
    run?.metadata,
    routine.metadata,
    routine.config,
  ].find((source) => isRecord(source?.retry_policy))
    ?.retry_policy;
  const retry = isRecord(raw) ? raw : {};
  const maxAttempts = positiveInteger(
    retry.max_attempts ?? run?.max_attempts,
    run?.max_attempts || DEFAULT_MAX_ATTEMPTS,
    10,
  );
  const baseDelaySeconds = positiveInteger(
    retry.base_delay_seconds,
    DEFAULT_RETRY_DELAY_SECONDS,
    MAX_RETRY_DELAY_SECONDS,
  );
  const maxDelaySeconds = positiveInteger(
    retry.max_delay_seconds,
    MAX_RETRY_DELAY_SECONDS,
    60 * 60,
  );
  return { maxAttempts, baseDelaySeconds, maxDelaySeconds };
}

function nextRetryAt(
  now: Date,
  attemptCount: number,
  policy: RetryPolicy,
): Date {
  const exponent = Math.max(0, attemptCount - 1);
  const delaySeconds = Math.min(
    policy.maxDelaySeconds,
    policy.baseDelaySeconds * 2 ** exponent,
  );
  return addMs(now, delaySeconds * 1000);
}

// ---------------------------------------------------------------------------
// Budget enforcement + circuit breaker.
//
// This executor provides a coarse wake-level gate and circuit breaker. The
// authoritative run/day/month/call decision happens atomically before every
// billable app/AI operation in reserve_routine_run_budget.
// - The metadata day/month rollup avoids waking an Agent that is already known
//   to be exhausted and defers next_run_at to the UTC reset boundary. It is an
//   optimization only; manual and scheduled work remain subject to the same
//   database-backed admission limits even if this best-effort rollup is stale.
// - Per-run Light/call ceilings stop new billable operations before execution.
//   The post-run check below remains a defense-in-depth circuit breaker for
//   legacy/nonbillable contribution anomalies.
// - The circuit breaker auto-pauses after consecutive failed attempts
//   (failure_count already resets on success), so a routine that can never
//   succeed — e.g. wallet below the inference floor — stops rescheduling
//   forever. Resume via gx.routine resume; the pause reason is recorded on
//   metadata.auto_pause and surfaces in the routine monitor and gx.routine.

interface BudgetSpendRollup {
  day: string;
  day_light: number;
  month: string;
  month_light: number;
  updated_at: string;
}

interface AutoPauseInfo {
  reason:
    | "consecutive_failures"
    | "budget_run_exceeded"
    | "budget_calls_exceeded";
  at: string;
  run_id?: string;
  light?: number;
  calls?: number;
  cap?: number;
  failure_count?: number;
  threshold?: number;
}

interface RunBudgetAccounting {
  spendRollup?: BudgetSpendRollup;
  autoPause?: AutoPauseInfo;
}

interface RunOutcome {
  status: "succeeded" | "failed" | "retried" | "skipped";
  budgetSkipped?: boolean;
  autoPaused?: boolean;
}

function budgetCap(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function utcDayKey(date: Date): string {
  return iso(date).slice(0, 10);
}

function utcMonthKey(date: Date): string {
  return iso(date).slice(0, 7);
}

function nextUtcMidnight(date: Date): Date {
  const next = new Date(date.getTime());
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function nextUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

// Reads the routine's spend rollup, resetting whichever window (UTC day /
// month) has rolled over since it was last written.
function currentSpendRollup(
  routine: StoredRoutine,
  now: Date,
): BudgetSpendRollup {
  const raw =
    isRecord(routine.metadata) && isRecord(routine.metadata.budget_spend)
      ? routine.metadata.budget_spend
      : {};
  const day = utcDayKey(now);
  const month = utcMonthKey(now);
  return {
    day,
    day_light: raw.day === day && typeof raw.day_light === "number" &&
        Number.isFinite(raw.day_light)
      ? raw.day_light
      : 0,
    month,
    month_light: raw.month === month && typeof raw.month_light === "number" &&
        Number.isFinite(raw.month_light)
      ? raw.month_light
      : 0,
    updated_at: iso(now),
  };
}

interface BudgetGateResult {
  period: "daily" | "monthly";
  code: "budget_day_exhausted" | "budget_month_exhausted";
  cap: number;
  spent: number;
  resumeAt: Date;
}

function budgetGate(
  routine: StoredRoutine,
  now: Date,
): BudgetGateResult | null {
  const budget = routine.budget_policy || {};
  const dayCap = budgetCap(budget.max_light_per_day);
  const monthCap = budgetCap(budget.max_light_per_month);
  if (dayCap === null && monthCap === null) return null;
  const rollup = currentSpendRollup(routine, now);
  if (dayCap !== null && rollup.day_light >= dayCap) {
    return {
      period: "daily",
      code: "budget_day_exhausted",
      cap: dayCap,
      spent: rollup.day_light,
      resumeAt: nextUtcMidnight(now),
    };
  }
  if (monthCap !== null && rollup.month_light >= monthCap) {
    return {
      period: "monthly",
      code: "budget_month_exhausted",
      cap: monthCap,
      spent: rollup.month_light,
      resumeAt: nextUtcMonthStart(now),
    };
  }
  return null;
}

function circuitBreakerThreshold(routine: StoredRoutine): number {
  const raw = isRecord(routine.metadata) &&
      isRecord(routine.metadata.circuit_breaker)
    ? routine.metadata.circuit_breaker.max_consecutive_failures
    : undefined;
  return positiveInteger(raw, DEFAULT_BREAKER_FAILURES, 100);
}

// The run row's total_light is accumulated by record_routine_call_contribution
// during the run; the executor's in-memory copy is stale by completion time.
async function readRunTotalLight(runId: string): Promise<number> {
  try {
    const [row] = await fetchRows<{ id: string; total_light: number | null }>(
      "routine_runs",
      { id: `eq.${runId}`, select: "id,total_light", limit: "1" },
      "Failed to read routine run spend",
    );
    return typeof row?.total_light === "number" &&
        Number.isFinite(row.total_light)
      ? Math.max(0, row.total_light)
      : 0;
  } catch {
    return 0;
  }
}

// Counts the run's recorded contribution steps. Called BEFORE the executor
// records its own root step, so the count contains exactly the calls the run
// made. Fetches at most cap+1 rows — enough to detect a violation.
async function countRunContributionSteps(
  runId: string,
  cap: number,
): Promise<number> {
  try {
    const rows = await fetchRows<{ id: string }>(
      "routine_run_steps",
      {
        run_id: `eq.${runId}`,
        select: "id",
        limit: String(Math.min(cap + 1, MAX_VERIFIABLE_CALLS_CAP)),
      },
      "Failed to count routine run steps",
    );
    return rows.length;
  } catch {
    return 0;
  }
}

// Post-run budget accounting: fold the run's spend into the rollup and detect
// per-run cap violations. Only queries when a relevant cap is set, so routines
// without a budget_policy keep the exact pre-existing hot path.
async function settleRunBudget(
  routine: StoredRoutine,
  run: ExecutorRunRow,
  completedAt: Date,
): Promise<RunBudgetAccounting> {
  const budget = routine.budget_policy || {};
  const runCap = budgetCap(budget.max_light_per_run);
  const dayCap = budgetCap(budget.max_light_per_day);
  const monthCap = budgetCap(budget.max_light_per_month);
  const callsCap = budgetCap(budget.max_calls_per_run);

  const accounting: RunBudgetAccounting = {};
  if (
    runCap === null && dayCap === null && monthCap === null && callsCap === null
  ) {
    return accounting;
  }

  let runLight = 0;
  if (runCap !== null || dayCap !== null || monthCap !== null) {
    runLight = await readRunTotalLight(run.id);
  }
  if (dayCap !== null || monthCap !== null) {
    const rollup = currentSpendRollup(routine, completedAt);
    rollup.day_light += runLight;
    rollup.month_light += runLight;
    accounting.spendRollup = rollup;
  }
  if (runCap !== null && runLight > runCap) {
    accounting.autoPause = {
      reason: "budget_run_exceeded",
      at: iso(completedAt),
      run_id: run.id,
      light: runLight,
      cap: runCap,
    };
    return accounting;
  }
  if (callsCap !== null) {
    const calls = await countRunContributionSteps(run.id, callsCap);
    if (calls > callsCap) {
      accounting.autoPause = {
        reason: "budget_calls_exceeded",
        at: iso(completedAt),
        run_id: run.id,
        calls,
        cap: callsCap,
      };
    }
  }
  return accounting;
}

async function activeRunCount(routineId: string): Promise<number> {
  const rows = await fetchRows<{ id: string }>(
    "routine_runs",
    {
      routine_id: `eq.${routineId}`,
      status: "in.(queued,running)",
      select: "id",
      limit: "100",
    },
    "Failed to count active routine runs",
  );
  return rows.length;
}

// Clear leases stuck on active routines past their expiry (a cron/consumer that
// died between claim and release). A flat filter so it's cheap and the reset
// makes the routine claimable again via lease_id=is.null. Returns rows touched.
async function clearExpiredRoutineLeases(now: Date): Promise<number> {
  const cleared = await patchRows<{ id: string }>(
    "user_routines",
    {
      status: "eq.active",
      lease_expires_at: `lt.${iso(now)}`,
      select: "id",
    },
    { lease_id: null, lease_expires_at: null, updated_at: iso(now) },
    "Failed to clear expired routine leases",
  ).catch(() => [] as Array<{ id: string }>);
  return cleared.length;
}

async function claimRoutine(
  routine: ExecutorRoutineRow,
  now: Date,
  leaseMs: number,
): Promise<ExecutorRoutineRow | null> {
  const leaseId = crypto.randomUUID();
  // FLAT filter only (id + status + lease_id.is.null) — the CAS guard against
  // concurrent claimers, resolved by PostgreSQL row-locking so exactly one wins.
  // A nested `and=(or,or)` filter here returns an EMPTY representation on a
  // successful PATCH (PostgREST only echoes rows still matching the filter after
  // the update, and setting lease_expires_at pushes the row out of the lease-free
  // clause), so the claim looked like it failed and the lease was orphaned. Flat
  // params echo the updated row correctly (same shape claimQueuedRunForExecution
  // relies on). Expired leases are reset to null by clearExpiredRoutineLeases
  // before this runs; the due-check already happened in dueRoutineCandidates.
  const [claimed] = await patchRows<ExecutorRoutineRow>(
    "user_routines",
    {
      id: `eq.${routine.id}`,
      status: "eq.active",
      lease_id: "is.null",
      select: ROUTINE_SELECT,
    },
    {
      lease_id: leaseId,
      lease_expires_at: iso(addMs(now, leaseMs)),
      updated_at: iso(now),
    },
    "Failed to claim routine",
  );
  return claimed ?? null;
}

async function releaseRoutineLease(
  routineId: string,
  now: Date,
  updates: Record<string, unknown> = {},
): Promise<void> {
  await patchRows<ExecutorRoutineRow>(
    "user_routines",
    {
      id: `eq.${routineId}`,
      select: ROUTINE_SELECT,
    },
    {
      ...updates,
      lease_id: null,
      lease_expires_at: null,
      updated_at: iso(now),
    },
    "Failed to release routine lease",
  );
}

async function insertScheduledRun(
  routine: ExecutorRoutineRow,
  now: Date,
  runId?: string,
): Promise<ExecutorRunRow> {
  const policy = retryPolicyFrom(routine);
  const [run] = await insertRows<ExecutorRunRow>(
    "routine_runs",
    { select: RUN_SELECT },
    {
      ...(runId ? { id: runId } : {}),
      routine_id: routine.id,
      user_id: routine.user_id,
      // Created "queued", NOT "running": the cron only enqueues; the queue
      // consumer claims queued->running and executes. A cron that dies before
      // enqueueing leaves the run "queued", so the next cron re-enqueues it —
      // nothing is ever orphaned in "running".
      status: "queued",
      trigger: "scheduled",
      trace_id: crypto.randomUUID(),
      started_at: null,
      run_config: {},
      metadata: {
        source: "routine_executor",
        routine_lease_id: routine.lease_id,
      },
      lease_id: null,
      lease_expires_at: null,
      // attempt_count 0 → the consumer's claim increments it to 1 (first try).
      attempt_count: 0,
      max_attempts: policy.maxAttempts,
    },
    "Failed to create scheduled routine run",
  );
  if (!run) throw new Error("Scheduled routine run insert returned no row");
  return run;
}

async function dueRoutineCandidates(
  now: Date,
  limit: number,
): Promise<ExecutorRoutineRow[]> {
  return await fetchRows<ExecutorRoutineRow>(
    "user_routines",
    {
      status: "eq.active",
      deleted_at: "is.null",
      or: `(next_run_at.is.null,next_run_at.lte.${iso(now)})`,
      select: ROUTINE_SELECT,
      order: "next_run_at.asc.nullsfirst",
      limit: String(limit),
    },
    "Failed to load due routines",
  );
}

// Creates a "queued" run for each due routine (leasing the routine + advancing
// next_run_at to prevent a double-fire) and returns the new run ids to enqueue.
// It does NOT claim runs to "running" — that happens in the consumer.
async function prepareDueScheduledRuns(
  now: Date,
  limit: number,
  leaseMs: number,
): Promise<string[]> {
  const runIds: string[] = [];
  // Free leases orphaned by a prior crash so their routines are claimable again.
  await clearExpiredRoutineLeases(now);
  const candidates = await dueRoutineCandidates(now, limit);

  for (const candidate of candidates) {
    if (runIds.length >= limit) break;
    const activeCount = await activeRunCount(candidate.id);
    if (activeCount >= candidate.max_concurrency) continue;

    const claimedRoutine = await claimRoutine(candidate, now, leaseMs);
    if (!claimedRoutine) continue;

    try {
      const nextRunAt = computeNextRoutineRunAt(claimedRoutine.schedule, now);
      const capacityEnabled = getEnv("SUBSCRIPTION_CAPACITY_ENABLED") === "1" &&
        isLaunchManagedRoutine(claimedRoutine);
      const runId = capacityEnabled ? crypto.randomUUID() : undefined;
      let capacityReservationId: string | null = null;
      if (capacityEnabled && runId) {
        const admission = await reserveAccountCapacity({
          userId: claimedRoutine.user_id,
          capacityAgentId: claimedRoutine.composer_app_id ?? undefined,
          // This is only a cheap scheduler admission probe. The actual MCP
          // execution creates its own predicted hold with a unique execution
          // key, so nested calls cannot alias one routine-wide reservation.
          idempotencyKey: `routine-wake:${runId}`,
          // With Agent enforcement the zero-Light probe asks whether either
          // window is already exhausted without guessing this handler's
          // runtime hold. MCP performs the authoritative predicted hold.
          reserveLight: getEnv("AGENT_CAPACITY_ENABLED") === "1" ? 0 : 1,
          expiresAt: new Date(now.getTime() + leaseMs + 120_000).toISOString(),
          now: iso(now),
          metadata: {
            routine_id: claimedRoutine.id,
            routine_run_id: runId,
            capacity_agent_id: claimedRoutine.composer_app_id,
            trigger: "scheduled",
          },
        });
        if (!admission.allowed || !admission.reservationId) {
          if (admission.code === "agent_cap_too_low_for_request") {
            const at = iso(now);
            await releaseRoutineLease(claimedRoutine.id, now, {
              status: "paused",
              next_run_at: null,
              last_error_at: at,
              metadata: {
                ...(claimedRoutine.metadata || {}),
                capacity_blocked: {
                  code: admission.code,
                  at,
                  capacity_agent_id: admission.agentCapacity?.agentId ??
                    claimedRoutine.composer_app_id,
                  cap_basis_points: admission.agentCapacity?.capBasisPoints ??
                    null,
                },
              },
            });
            await createNotification({
              userId: claimedRoutine.user_id,
              agentId: claimedRoutine.composer_app_id,
              kind: "routine_capacity_blocked",
              severity: "critical",
              title: `${claimedRoutine.name} needs a higher Agent capacity cap`,
              body:
                "Its current per-Agent cap cannot admit even one scheduled wake. Increase the cap, then resume the routine.",
              entityType: "routine",
              entityId: claimedRoutine.id,
              dedupeKey: `routine_capacity_too_low:${claimedRoutine.id}:${
                admission.agentCapacity?.capBasisPoints ?? "unknown"
              }`,
            });
            continue;
          }
          const nextEligibleAt = admission.nextEligibleAt ||
            admission.weekly.resetsAt;
          await recordDeferredRoutineWake({
            routineId: claimedRoutine.id,
            userId: claimedRoutine.user_id,
            scheduledAt: iso(now),
            nextEligibleAt,
          });
          const capacityResumeAt = new Date(nextEligibleAt);
          const resumeAt = nextRunAt && nextRunAt <= capacityResumeAt
            ? nextRunAt
            : capacityResumeAt;
          await releaseRoutineLease(claimedRoutine.id, now, {
            // Preserve frequent cadences so each missed tick is counted, but
            // never strand a sparse routine past the first capacity reset.
            next_run_at: iso(resumeAt),
          });
          continue;
        }
        capacityReservationId = admission.reservationId;
      }

      let run: ExecutorRunRow;
      try {
        run = await insertScheduledRun(claimedRoutine, now, runId);
        if (capacityEnabled) {
          await attachDeferredWakeToRun(
            claimedRoutine.id,
            claimedRoutine.user_id,
            run.id,
          );
        }
      } catch (insertError) {
        if (capacityReservationId) {
          await releaseAccountCapacity({
            reservationId: capacityReservationId,
            userId: claimedRoutine.user_id,
          }).catch(() => {});
        }
        throw insertError;
      }
      if (capacityReservationId) {
        // The queued execution performs authoritative admission with its
        // expected runtime hold. Releasing this 1-Light probe avoids double
        // reserving while the queue owns the run.
        await releaseAccountCapacity({
          reservationId: capacityReservationId,
          userId: claimedRoutine.user_id,
        });
      }
      await releaseRoutineLease(claimedRoutine.id, now, {
        next_run_at: nextRunAt ? iso(nextRunAt) : null,
        last_run_at: iso(now),
      });
      runIds.push(run.id);
    } catch (err) {
      await releaseRoutineLease(claimedRoutine.id, now, {
        last_error_at: iso(now),
        failure_count: claimedRoutine.failure_count + 1,
      }).catch(() => {});
      throw err;
    }
  }

  return runIds;
}

async function queuedRunCandidates(
  now: Date,
  limit: number,
): Promise<ExecutorRunRow[]> {
  return await fetchRows<ExecutorRunRow>(
    "routine_runs",
    {
      status: "eq.queued",
      or: `(next_attempt_at.is.null,next_attempt_at.lte.${iso(now)})`,
      select: RUN_SELECT,
      order: "created_at.asc",
      limit: String(limit),
    },
    "Failed to load queued routine runs",
  );
}

// Consumer/inline claim: load the run by id and optimistically move it
// queued->running (attempt++). Returns the claimed run, or null when it is not
// claimable — already claimed/terminal (a duplicate Queues delivery, or a
// concurrent claim won the race), or attempts exhausted. The atomic PATCH
// (status=queued AND attempt_count=N) is the at-most-once guard.
async function claimQueuedRunForExecution(
  runId: string,
  now: Date,
  leaseMs: number,
): Promise<ExecutorRunRow | null> {
  const run = await getRunById(runId);
  if (!run) return null;
  if (run.status !== "queued") return null;
  if (run.attempt_count >= run.max_attempts) {
    await finishRun(run, "failed", now, {
      summary: "Routine run exhausted retry attempts before claim.",
      error: { message: "retry attempts exhausted" },
    });
    return null;
  }

  const [claimed] = await patchRows<ExecutorRunRow>(
    "routine_runs",
    {
      id: `eq.${runId}`,
      status: "eq.queued",
      attempt_count: `eq.${run.attempt_count}`,
      select: RUN_SELECT,
    },
    {
      status: "running",
      // Backfill legacy queued rows atomically with the claim. New runs already
      // carry a trace, but no actor token may be minted from an incomplete
      // routine/run/trace tuple.
      trace_id: run.trace_id || crypto.randomUUID(),
      started_at: run.started_at ?? iso(now),
      lease_id: crypto.randomUUID(),
      lease_expires_at: iso(addMs(now, leaseMs)),
      attempt_count: run.attempt_count + 1,
      next_attempt_at: null,
    },
    "Failed to claim queued routine run",
  );
  return claimed ?? null;
}

async function loadUser(userId: string): Promise<RoutineActorUserInput> {
  const [user] = await fetchRows<ExecutorUserRow>(
    "users",
    {
      id: `eq.${userId}`,
      select: USER_SELECT,
      limit: "1",
    },
    "Failed to load routine actor user",
  );
  if (!user?.id || !user.email) {
    throw new Error(`Routine user not found: ${userId}`);
  }
  return {
    id: user.id,
    email: user.email,
    tier: user.tier || "free",
    provisional: user.provisional === true,
  };
}

function routineCapabilitiesForActor(
  capabilities: RoutineCapabilityRow[],
): Array<{
  app_id?: string | null;
  app_ref?: string | null;
  function_name?: string | null;
  access?: "read" | "write" | null;
  approved?: boolean | null;
  required?: boolean | null;
  constraints?: Record<string, unknown> | null;
  pricing_snapshot?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}> {
  return capabilities.map((capability) => ({
    app_id: capability.app_id,
    app_ref: capability.app_ref,
    function_name: capability.function_name,
    access: capability.access,
    approved: capability.approved,
    required: capability.required,
    constraints: capability.constraints,
    pricing_snapshot: capability.pricing_snapshot,
    metadata: capability.metadata,
  }));
}

function buildRoutineArgs(
  routine: StoredRoutine,
  run: ExecutorRunRow,
): Record<string, unknown> {
  return {
    ...(routine.config || {}),
    ...(run.run_config || {}),
    _routine: {
      routine_id: routine.id,
      routine_run_id: run.id,
      trace_id: run.trace_id,
      trigger: run.trigger,
      attempt: run.attempt_count,
      scheduled_at: run.created_at,
      // The routine's natural-language goal. Lives inside the reserved
      // _routine namespace so it can never collide with a config key.
      intent: routine.intent ?? null,
    },
  };
}

async function invokeRoutineHandler(
  routine: StoredRoutine,
  run: ExecutorRunRow,
  options: Required<
    Pick<RoutineExecutorOptions, "baseUrl" | "invokeMcp" | "handlerTimeoutMs">
  >,
): Promise<unknown> {
  const composerAppId = routine.composer_app_id || routine.composer_app_slug;
  if (!composerAppId) {
    throw new Error("Routine has no composer app to invoke");
  }

  const user = await loadUser(routine.user_id);
  const actor = await createRoutineActorTokenForRun({
    user,
    routine: {
      id: routine.id,
      composer_app_id: routine.composer_app_id,
      composer_app_slug: routine.composer_app_slug,
      handler_function: routine.handler_function,
      budget_policy: routine.budget_policy,
      capabilities: routineCapabilitiesForActor(routine.capabilities),
    },
    run: { id: run.id, trace_id: run.trace_id },
    tokenId: `routine-run-${run.id}-attempt-${run.attempt_count}`,
  });

  // Invoke the handler IN-PROCESS via handleMcp, NOT through a SELF
  // service-binding HTTP round-trip. The executor's only home is the worker's
  // scheduled() cron cycle, and a SELF round-trip made from there HANGS (it
  // works fine from a normal fetch() request context, which is why gx.call and
  // the interface bridge are unaffected). The event-bus dispatcher — also
  // cron-triggered — already invokes handlers in-process (executeEventDelivery),
  // which is why events work while routines did not. An in-process handleMcp
  // call runs the identical /mcp pipeline (auth from the routine-actor bearer,
  // caller-permission, dynamic sandbox, settlement, flight recorder) with no
  // network hop. A backstop timeout guards the shared cron against a wedge.
  const mcpRequest = new Request(
    `${options.baseUrl.replace(/\/+$/, "")}/mcp/${
      encodeURIComponent(composerAppId)
    }`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${actor.token}`,
        "X-Galactic-Routine-Id": routine.id,
        "X-Galactic-Routine-Run-Id": run.id,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: run.id,
        method: "tools/call",
        params: {
          name: routine.handler_function,
          arguments: buildRoutineArgs(routine, run),
        },
      }),
    },
  );
  const response = await withTimeout(
    options.invokeMcp(mcpRequest, composerAppId),
    options.handlerTimeoutMs,
    "Routine handler invocation timed out",
  );

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Routine MCP call failed (${response.status}): ${text}`);
  }

  const rpc = await response.json() as {
    result?: unknown;
    error?: {
      message?: string;
      code?: number;
      data?: {
        type?: string;
        retry_at?: string;
        capacity_agent_id?: string | null;
        agent_cap_basis_points?: number | null;
      };
    };
  };
  if (rpc.error) {
    if (
      rpc.error.code === -32010 &&
      rpc.error.data?.type === "agent_cap_too_low_for_request"
    ) {
      throw new AgentCapacityCapTooLowError(rpc.error.data);
    }
    if (
      rpc.error.code === -32010 &&
      (rpc.error.data?.type === "capacity_waiting" ||
        rpc.error.data?.type === "agent_cap_waiting") &&
      typeof rpc.error.data.retry_at === "string"
    ) {
      throw new AccountCapacityWaitingError(rpc.error.data.retry_at);
    }
    throw new Error(
      rpc.error.message || `Routine MCP error ${rpc.error.code ?? ""}`.trim(),
    );
  }

  // Execution failures surface as tool RESULTS with isError: true (the
  // JSON-RPC layer succeeded; the handler did not). Without this check a
  // failed handler — e.g. a never-built app's "Run rebuild first" — would be
  // recorded as a SUCCEEDED run and never retried.
  if (isRecord(rpc.result) && rpc.result.isError === true) {
    const structured = isRecord(rpc.result.structuredContent)
      ? rpc.result.structuredContent
      : null;
    const propagatedType = structured?.error_type;
    const propagatedDetails = isRecord(structured?.error_details)
      ? structured.error_details
      : {};
    if (propagatedType === "AgentCapacityCapTooLowError") {
      throw new AgentCapacityCapTooLowError(propagatedDetails);
    }
    if (
      propagatedType === "AgentCapacityWaitingError" &&
      typeof propagatedDetails.retry_at === "string"
    ) {
      throw new AccountCapacityWaitingError(propagatedDetails.retry_at);
    }
    const content = rpc.result.content;
    const textBlock = Array.isArray(content)
      ? content.find((entry) =>
        isRecord(entry) && entry.type === "text" &&
        typeof entry.text === "string"
      ) as { text?: string } | undefined
      : undefined;
    throw new Error(textBlock?.text || "Routine handler failed");
  }

  const result = unwrapMcpToolResult(rpc.result);
  if (isRecord(result) && result._async === true) {
    throw new Error("Routine handlers must complete synchronously");
  }
  return result;
}

async function patchRun(
  runId: string,
  payload: Record<string, unknown>,
  // Optional CAS guard: only apply the update if the row is still in this
  // status. Note callers must NOT rely on the returned row when the update
  // moves the row OUT of expectStatus — PostgREST return=representation echoes
  // only rows still matching the filter after the write (see claimRoutine).
  expectStatus?: RoutineRunStatus,
): Promise<ExecutorRunRow | null> {
  const [run] = await patchRows<ExecutorRunRow>(
    "routine_runs",
    {
      id: `eq.${runId}`,
      ...(expectStatus ? { status: `eq.${expectStatus}` } : {}),
      select: RUN_SELECT,
    },
    payload,
    "Failed to update routine run",
  );
  return run ?? null;
}

async function finishRun(
  run: Pick<ExecutorRunRow, "id" | "user_id">,
  status: RoutineRunStatus,
  now: Date,
  updates: {
    summary?: string | null;
    error?: Record<string, unknown> | null;
    totalLight?: number;
  } = {},
): Promise<void> {
  await patchRun(run.id, {
    status,
    completed_at: ["succeeded", "failed", "cancelled", "skipped"].includes(
        status,
      )
      ? iso(now)
      : null,
    lease_id: null,
    lease_expires_at: null,
    ...(updates.summary !== undefined ? { summary: updates.summary } : {}),
    ...(updates.error !== undefined ? { error: updates.error } : {}),
    ...(updates.totalLight !== undefined
      ? { total_light: updates.totalLight }
      : {}),
  });
}

async function markRunForRetry(
  run: ExecutorRunRow,
  routine: StoredRoutine,
  now: Date,
  error: unknown,
): Promise<void> {
  const policy = retryPolicyFrom(routine, run);
  await patchRun(run.id, {
    status: "queued",
    error: errorPayload(error),
    next_attempt_at: iso(nextRetryAt(now, run.attempt_count, policy)),
    lease_id: null,
    lease_expires_at: null,
    metadata: {
      ...(run.metadata || {}),
      last_attempt_failed_at: iso(now),
      retry_policy: {
        max_attempts: policy.maxAttempts,
        base_delay_seconds: policy.baseDelaySeconds,
        max_delay_seconds: policy.maxDelaySeconds,
      },
    },
    // CAS: only re-queue a run that is still "running". A run the reaper already
    // failed, or one finishRun already marked terminal, must never be resurrected
    // to "queued" (which would re-execute the handler's side effects).
  }, "running");
}

// Updates the routine's bookkeeping after a run attempt and applies the
// circuit breaker + budget auto-pause. Returns true when the routine was
// auto-paused by this update.
async function updateRoutineAfterRun(
  routine: StoredRoutine,
  now: Date,
  success: boolean,
  accounting: RunBudgetAccounting = {},
): Promise<boolean> {
  let autoPause = accounting.autoPause ?? null;
  const nextFailureCount = success ? 0 : (routine.failure_count || 0) + 1;
  if (!success && !autoPause) {
    const threshold = circuitBreakerThreshold(routine);
    if (nextFailureCount >= threshold) {
      autoPause = {
        reason: "consecutive_failures",
        at: iso(now),
        failure_count: nextFailureCount,
        threshold,
      };
    }
  }

  const metadataUpdates: Record<string, unknown> = {};
  if (accounting.spendRollup) {
    metadataUpdates.budget_spend = accounting.spendRollup;
  }
  if (autoPause) metadataUpdates.auto_pause = autoPause;

  const payload: Record<string, unknown> = success
    ? {
      last_run_at: iso(now),
      last_success_at: iso(now),
      failure_count: 0,
      updated_at: iso(now),
    }
    : {
      last_run_at: iso(now),
      last_error_at: iso(now),
      failure_count: nextFailureCount,
      updated_at: iso(now),
    };
  if (Object.keys(metadataUpdates).length > 0) {
    payload.metadata = { ...(routine.metadata || {}), ...metadataUpdates };
  }
  if (autoPause) payload.status = "paused";

  await patchRows<ExecutorRoutineRow>(
    "user_routines",
    { id: `eq.${routine.id}`, select: ROUTINE_SELECT },
    payload,
    "Failed to update routine after run",
  );
  // Tell the owner their agent stopped — the point of an always-on agent is
  // that you don't have to watch it. Best-effort + idempotent (one row per pause
  // event via the `at` timestamp in the dedupe key), never blocks the executor.
  if (autoPause) {
    const reason = autoPause.reason === "consecutive_failures"
      ? `Paused after ${autoPause.failure_count} consecutive failed attempts.`
      : autoPause.reason === "budget_run_exceeded"
      ? `Paused: a run exceeded its per-run budget (${autoPause.light}/${autoPause.cap} Light).`
      : autoPause.reason === "budget_calls_exceeded"
      ? `Paused: a run exceeded its per-run call cap (${autoPause.calls}/${autoPause.cap} calls).`
      : "Paused by the circuit breaker.";
    await createNotification({
      userId: routine.user_id,
      agentId: routine.composer_app_id,
      kind: "routine_paused",
      severity: "critical",
      title: `${routine.name} was paused`,
      body: `${reason} Resume it once you've addressed the cause.`,
      entityType: "routine",
      entityId: routine.id,
      dedupeKey: `routine_paused:${routine.id}:${autoPause.at}`,
    });
  }
  return autoPause !== null;
}

async function recordRootStep(
  routine: StoredRoutine,
  run: ExecutorRunRow,
  status: "succeeded" | "failed",
  startedAt: Date,
  completedAt: Date,
  args: Record<string, unknown>,
  result: unknown,
  error?: unknown,
): Promise<void> {
  await recordRoutineRunStep({
    runId: run.id,
    routineId: routine.id,
    userId: routine.user_id,
    stepIndex: 0,
    appId: routine.composer_app_id,
    appRef: routine.composer_app_slug,
    functionName: routine.handler_function,
    status,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    argsPreview: sanitizePreview(args),
    resultPreview: status === "succeeded" ? sanitizePreview(result) : {},
    error: status === "failed" ? errorPayload(error) : null,
    metadata: { source: "routine_executor.root_handler" },
  }).catch(() => {});
}

async function executeClaimedRun(
  claimed: ClaimedRun,
  options: Required<
    Pick<RoutineExecutorOptions, "baseUrl" | "invokeMcp" | "handlerTimeoutMs">
  >,
  now: Date,
  clock: () => Date,
): Promise<RunOutcome> {
  const run = claimed.run;
  const routine = claimed.routine ??
    await getRoutine(run.user_id, run.routine_id);
  if (!routine) {
    await finishRun(run, "failed", now, {
      error: { message: `Routine ${run.routine_id} not found` },
    });
    return { status: "failed" };
  }

  // Only active routines may execute. This also stops queued retries claimed
  // before any pause, disable, delete, or terminal error transition landed.
  if (routine.status !== "active") {
    await finishRun(run, "skipped", now, {
      summary: `Routine is ${routine.status}`,
    });
    return { status: "skipped" };
  }

  // Defense in depth for legacy rows that were activated before owner-only
  // capability approval became mandatory. The executor must never turn a
  // stale/hand-edited active row into authority. Pause it atomically enough
  // for the shared runner and leave an actionable run error + notification.
  const activation = validateRoutineActivation(routine);
  const activationBlockers: Array<{
    code: string;
    message: string;
    capability_ids?: string[];
  }> = [...activation.blockers];
  const launchManaged = isLaunchManagedRoutine(routine);
  const legacyLaunchRoutine = routine.metadata?.source === "ul.routine";
  if (legacyLaunchRoutine && !launchManaged) {
    activationBlockers.push({
      code: "noncanonical_launch_routine",
      message:
        "This legacy launch routine is not the Agent's canonical primary routine and must be reconciled before execution.",
    });
  } else if (launchManaged) {
    try {
      await validateRoutineLaunchActivation(routine.user_id, routine);
    } catch (err) {
      activationBlockers.push({
        code: "launch_invariant_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (activationBlockers.length > 0) {
    const completedAt = clock();
    await finishRun(run, "skipped", completedAt, {
      summary: "Routine failed launch-safety validation and was paused.",
      error: {
        code: "routine_activation_blocked",
        blockers: activationBlockers,
      },
    });
    await patchRows<ExecutorRoutineRow>(
      "user_routines",
      { id: `eq.${routine.id}`, status: "eq.active", select: ROUTINE_SELECT },
      {
        status: "paused",
        updated_at: iso(completedAt),
        metadata: {
          ...(routine.metadata || {}),
          auto_pause: {
            reason: "activation_validation_failed",
            at: iso(completedAt),
            blockers: activationBlockers,
          },
        },
      },
      "Failed to pause routine with pending capabilities",
    ).catch(() => {});
    await createNotification({
      userId: routine.user_id,
      agentId: routine.composer_app_id,
      kind: "routine_activation_blocked",
      severity: "critical",
      title: `${routine.name} needs attention`,
      body: `The Agent was paused before execution: ${
        activationBlockers.map((item) => item.message).join(" ")
      }`,
      entityType: "routine",
      entityId: routine.id,
      dedupeKey: `routine_activation_blocked:${routine.id}`,
    });
    return { status: "skipped", autoPaused: true };
  }

  // Day/month budget gate for every wake. Manual owner-triggered runs are not
  // a budget escape hatch; an explicit override can be added later as a
  // separately authorized one-shot operation.
  {
    const gate = budgetGate(routine, now);
    if (gate) {
      const label = gate.period === "daily" ? "Daily" : "Monthly";
      await finishRun(run, "skipped", now, {
        summary:
          `${label} credits budget exhausted (${gate.spent}/${gate.cap} Light); ` +
          `next run deferred to ${iso(gate.resumeAt)}.`,
        error: {
          code: gate.code,
          spent: gate.spent,
          cap: gate.cap,
          resume_at: iso(gate.resumeAt),
        },
      });
      await patchRows<ExecutorRoutineRow>(
        "user_routines",
        { id: `eq.${routine.id}`, select: ROUTINE_SELECT },
        { next_run_at: iso(gate.resumeAt), updated_at: iso(now) },
        "Failed to defer routine to budget reset",
      ).catch(() => {});
      // Notify the owner ONCE per reset window (the resumeAt in the dedupe key),
      // not on every skipped tick until the budget resets.
      const periodLabel = gate.period === "daily" ? "daily" : "monthly";
      await createNotification({
        userId: routine.user_id,
        agentId: routine.composer_app_id,
        kind: "routine_budget_exhausted",
        severity: "info",
        title: `${routine.name} hit its ${periodLabel} budget`,
        body:
          `Spent ${gate.spent}/${gate.cap} Light this ${periodLabel} window. ` +
          `Runs resume automatically at ${iso(gate.resumeAt)}.`,
        entityType: "routine",
        entityId: routine.id,
        dedupeKey: `routine_budget:${routine.id}:${gate.period}:${
          iso(gate.resumeAt)
        }`,
      });
      return { status: "skipped", budgetSkipped: true };
    }
  }

  const startedAt = now;
  const args = buildRoutineArgs(routine, run);

  // ONLY the handler invocation is in the retryable try. A failure here is the
  // handler genuinely failing (its side effects did not complete) — the one
  // case that may retry / terminally-fail the run.
  let result: unknown;
  try {
    result = await invokeRoutineHandler(routine, run, options);
  } catch (err) {
    const completedAt = clock();
    if (err instanceof AgentCapacityCapTooLowError) {
      const at = iso(completedAt);
      await finishRun(run, "failed", completedAt, {
        summary: err.message,
        error: {
          code: "agent_cap_too_low_for_request",
          ...err.details,
        },
      });
      await patchRows<ExecutorRoutineRow>(
        "user_routines",
        { id: `eq.${routine.id}`, select: ROUTINE_SELECT },
        {
          status: "paused",
          next_run_at: null,
          last_error_at: at,
          failure_count: routine.failure_count + 1,
          metadata: {
            ...(routine.metadata || {}),
            capacity_blocked: {
              code: "agent_cap_too_low_for_request",
              at,
              capacity_agent_id: err.details.capacity_agent_id ??
                routine.composer_app_id,
              cap_basis_points: err.details.agent_cap_basis_points ?? null,
            },
          },
          updated_at: at,
        },
        "Failed to pause routine blocked by its Agent capacity cap",
      );
      await createNotification({
        userId: routine.user_id,
        agentId: routine.composer_app_id,
        kind: "routine_capacity_blocked",
        severity: "critical",
        title: `${routine.name} needs a higher Agent capacity cap`,
        body:
          "Its current per-Agent cap cannot admit one execution. Increase the cap, then resume the routine.",
        entityType: "routine",
        entityId: routine.id,
        dedupeKey: `routine_capacity_too_low:${routine.id}:${
          err.details.agent_cap_basis_points ?? "unknown"
        }`,
      });
      return { status: "failed" };
    }
    if (err instanceof AccountCapacityWaitingError) {
      const deferred = await recordDeferredRoutineWake({
        routineId: routine.id,
        userId: routine.user_id,
        scheduledAt: iso(completedAt),
        nextEligibleAt: err.retryAt,
        manualRequested: run.trigger === "manual",
      });
      await finishRun(run, "skipped", completedAt, {
        summary:
          `Capacity wait: ${deferred.deferredWakeCount} wake(s) coalesced; resumes at ${err.retryAt}.`,
        error: {
          code: "capacity_waiting",
          retry_at: err.retryAt,
          deferred_wake_count: deferred.deferredWakeCount,
        },
      });
      return { status: "skipped", budgetSkipped: true };
    }
    const policy = retryPolicyFrom(routine, run);
    const willRetry = run.attempt_count < policy.maxAttempts;
    // Failed runs spend too — fold terminal attempts into the rollup. Retried
    // runs settle when they terminally complete (total_light spans attempts).
    const accounting = willRetry
      ? {}
      : await settleRunBudget(routine, run, completedAt);
    await recordRootStep(
      routine,
      run,
      "failed",
      startedAt,
      completedAt,
      args,
      null,
      err,
    );
    if (willRetry) {
      await markRunForRetry(run, routine, completedAt, err);
      const autoPaused = await updateRoutineAfterRun(
        routine,
        completedAt,
        false,
      ).catch(() => false);
      return { status: "retried", autoPaused };
    }

    await finishRun(run, "failed", completedAt, {
      error: errorPayload(err),
      summary: "Routine handler failed.",
    });
    const autoPaused = await updateRoutineAfterRun(
      routine,
      completedAt,
      false,
      accounting,
    ).catch(() => false);
    return { status: "failed", autoPaused };
  }

  // The handler SUCCEEDED — its side effects are committed. From here, ANY
  // bookkeeping failure is best-effort and MUST NOT re-run the handler (a retry
  // would duplicate the side effects — emails re-sent, rows re-written). We
  // swallow it and still report success; the run is a completed wake regardless
  // of whether the flight/budget rollup finished writing.
  const completedAt = clock();
  try {
    // Budget accounting runs before the root step is recorded so the
    // contribution count contains exactly the calls the run made.
    const accounting = await settleRunBudget(routine, run, completedAt);
    await recordRootStep(
      routine,
      run,
      "succeeded",
      startedAt,
      completedAt,
      args,
      result,
    );
    await finishRun(run, "succeeded", completedAt, {
      summary: "Routine handler completed successfully.",
    });
    const autoPaused = await updateRoutineAfterRun(
      routine,
      completedAt,
      true,
      accounting,
    );
    return { status: "succeeded", autoPaused };
  } catch (bookkeepingErr) {
    console.error(
      "[ROUTINE-EXEC] post-success bookkeeping failed (run not re-run):",
      bookkeepingErr,
    );
    // Best-effort: get the run out of "running" so the reaper doesn't later
    // fail it and drive a retry of an already-succeeded handler.
    await finishRun(run, "succeeded", completedAt, {
      summary:
        "Routine handler completed successfully (bookkeeping incomplete).",
    }).catch(() => {});
    return { status: "succeeded", autoPaused: false };
  }
}

// Resolves the shared handler-invocation options (baseUrl + in-process
// invokeMcp + timeout), used by both the scheduled cycle's inline fallback and
// the queue consumer.
function resolveInvocationOptions(
  options: RoutineExecutorOptions,
): Required<
  Pick<RoutineExecutorOptions, "baseUrl" | "invokeMcp" | "handlerTimeoutMs">
> {
  return {
    baseUrl: options.baseUrl || getEnv("BASE_URL") ||
      "https://api.connectgalactic.com",
    // Call handleMcp IN-PROCESS (lazy import keeps the handler graph off this
    // module's load path). Overridable in tests.
    invokeMcp: options.invokeMcp ||
      (async (request, appId) => {
        const { handleMcp } = await import("../handlers/mcp.ts");
        return handleMcp(request, appId);
      }),
    handlerTimeoutMs: positiveInteger(
      options.handlerTimeoutMs,
      HANDLER_INVOKE_TIMEOUT_MS,
      15 * 60 * 1000,
    ),
  };
}

async function getRunById(runId: string): Promise<ExecutorRunRow | null> {
  const [run] = await fetchRows<ExecutorRunRow>(
    "routine_runs",
    { id: `eq.${runId}`, select: RUN_SELECT, limit: "1" },
    "Failed to load routine run",
  );
  return run ?? null;
}

// Optimistic re-claim in the CONSUMER: transition the run's lease from the one
// the scheduled() cycle stamped to a fresh consumer lease, gated on the run
// still being "running". This is the at-most-once guard against Queues'
// at-least-once delivery — a duplicate message finds the lease already rotated
// (or the run terminal) and matches zero rows.
// Claim a queued run (queued->running) and execute it. Shared by the queue
// consumer and the inline (no-queue) cron path. Returns the run outcome, or
// null when the run was not claimable (duplicate / already terminal).
async function claimAndExecuteRun(
  runId: string,
  options: RoutineExecutorOptions,
): Promise<RunOutcome | null> {
  const now = options.now ?? new Date();
  const clock = options.clock || (() => new Date());
  const leaseMs = positiveInteger(
    options.leaseMs,
    DEFAULT_LEASE_MS,
    60 * 60 * 1000,
  );
  const invocation = resolveInvocationOptions(options);

  const claimed = await claimQueuedRunForExecution(runId, now, leaseMs);
  if (!claimed) return null;
  return await executeClaimedRun(
    {
      run: claimed,
      source: claimed.trigger === "scheduled" ? "scheduled" : "queued",
    },
    invocation,
    now,
    clock,
  );
}

// EXEC_QUEUE consumer entry for a routine run (routed from processExecMessage
// by the routineRunId key). Runs in the queue-consumer context, where the
// dynamic sandbox works — unlike scheduled(). Always acks: the run's own
// lifecycle (retry/fail via executeClaimedRun) is the durability mechanism, not
// message redelivery, which could double-execute a settled run.
export async function processQueuedRoutineRun(
  body: RoutineRunQueueMessage,
  options: RoutineExecutorOptions = {},
): Promise<"ack"> {
  await claimAndExecuteRun(body.routineRunId, options).catch((err) => {
    console.error("[ROUTINE-QUEUE] Run execution failed:", err);
  });
  return "ack";
}

// Fail a batch of runs matched by a flat staleness filter and return how many
// were written. Probe-first (the minute cron must not blind-write every tick),
// and the PATCH re-applies the SAME filter so a run legitimately re-leased or
// settled between probe and write is not clobbered.
async function failStaleRuns(
  filter: Record<string, string>,
  now: Date,
): Promise<number> {
  const stale = await fetchRows<{ id: string }>(
    "routine_runs",
    { ...filter, select: "id", limit: "200" },
    "Failed to probe stale routine runs",
  ).catch((err) => {
    console.error(
      "[ROUTINE-REAP] probe failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [] as Array<{ id: string }>;
  });
  if (stale.length === 0) return 0;

  const ids = stale.map((row) => row.id).join(",");
  const reaped = await patchRows<{ id: string }>(
    "routine_runs",
    { ...filter, id: `in.(${ids})`, select: "id" },
    {
      status: "failed",
      completed_at: iso(now),
      lease_id: null,
      lease_expires_at: null,
      error: {
        type: "ServerTimeout",
        message:
          "Routine run exceeded its lease (worker restart or lost invocation).",
      },
    },
    "Failed to reap stale routine runs",
  ).catch((err) => {
    console.error(
      "[ROUTINE-REAP] patch failed:",
      err instanceof Error ? err.message : String(err),
    );
    return [] as Array<{ id: string }>;
  });
  return reaped.length;
}

// Recover runs abandoned mid-flight and fail them terminally. A run claimed to
// "running" whose lease has expired means the consumer crashed after the claim
// but before finishRun — at-least-once redelivery can't recover it (the claim
// guard finds it no longer "queued"), and left alone it counts against
// max_concurrency forever, permanently wedging a max_concurrency=1 routine.
// Terminal fail (not retry) matches async jobs' at-most-once contract: a
// periodic routine simply recovers on its next scheduled tick, and re-running a
// run that may have partially executed would risk duplicate side effects.
//
// Only "running" is reaped: a "queued" run is never orphaned — queuedRunCandidates
// re-dispatches it every cron, and a lost EXEC_QUEUE message is near-impossible
// (at-least-once delivery + DLQ). Two FLAT filters (the proven PostgREST shape,
// no nested and/or grouping): a live lease that has expired, and a legacy /
// never-leased run stuck past the staleness window. They are disjoint (lease
// non-null-and-past vs lease null), so nothing is counted twice.
async function reapStaleRoutineRuns(now: Date): Promise<number> {
  const leaseCutoff = iso(now);
  const startedCutoff = iso(addMs(now, -DEFAULT_LEASE_MS));
  let reaped = 0;
  reaped += await failStaleRuns(
    { status: "eq.running", lease_expires_at: `lt.${leaseCutoff}` },
    now,
  );
  reaped += await failStaleRuns(
    {
      status: "eq.running",
      lease_expires_at: "is.null",
      started_at: `lt.${startedCutoff}`,
    },
    now,
  );
  return reaped;
}

export async function runRoutineExecutorCycle(
  options: RoutineExecutorOptions = {},
): Promise<RoutineExecutorSummary> {
  const now = options.now ?? new Date();
  const limit = positiveInteger(options.limit, DEFAULT_LIMIT, 50);
  const leaseMs = positiveInteger(
    options.leaseMs,
    DEFAULT_LEASE_MS,
    60 * 60 * 1000,
  );
  const invocation = resolveInvocationOptions(options);
  const clock = options.clock || (() => new Date());
  // Dispatch target for handler execution. Explicit null => inline (tests / no
  // queue). In prod EXEC_QUEUE is always bound, so runs execute in the consumer.
  const execQueue = options.execQueue !== undefined
    ? options.execQueue
    : getExecQueue();

  const summary: RoutineExecutorSummary = {
    checked_at: iso(now),
    reaped: 0,
    claimed_scheduled: 0,
    claimed_queued: 0,
    dispatched: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    skipped: 0,
    budget_skipped: 0,
    auto_paused: 0,
    errors: [],
  };

  // Reap abandoned runs FIRST: a run orphaned in "running" counts against
  // max_concurrency, so clearing it here lets a wedged routine schedule again
  // this same cycle.
  summary.reaped = await reapStaleRoutineRuns(now).catch((err) => {
    summary.errors.push({
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  });

  // Create a "queued" run per due scheduled routine (does NOT claim to
  // running); the ids are enqueued below alongside due queued runs. This is the
  // minimal, cut-off-safe work the cron does — the claim + execute happen in the
  // consumer (or inline when no queue is bound).
  const scheduledRunIds = await prepareDueScheduledRuns(now, limit, leaseMs)
    .catch((err) => {
      summary.errors.push({
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as string[];
    });
  summary.claimed_scheduled = scheduledRunIds.length;

  const remaining = Math.max(0, limit - scheduledRunIds.length);
  const queuedRuns = remaining > 0
    ? await queuedRunCandidates(now, remaining).catch((err) => {
      summary.errors.push({
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as ExecutorRunRow[];
    })
    : [];
  summary.claimed_queued = queuedRuns.length;

  const runIds = [
    ...new Set([...scheduledRunIds, ...queuedRuns.map((r) => r.id)]),
  ];

  for (const runId of runIds) {
    try {
      if (execQueue) {
        // PROD path: enqueue only. The run stays "queued"; the EXEC_QUEUE
        // consumer claims queued->running and runs the dynamic sandbox in a
        // normal request context (the sandbox hangs in scheduled()). A cron
        // that dies before/while enqueueing leaves the run "queued" for the
        // next cron — nothing is orphaned in "running".
        await execQueue.send(
          { routineRunId: runId } satisfies RoutineRunQueueMessage,
        );
        summary.dispatched += 1;
        continue;
      }

      // INLINE path (tests / no queue bound): claim + run in-process, exactly
      // what the consumer does.
      const outcome = await claimAndExecuteRun(runId, {
        ...options,
        now,
        clock,
        execQueue: null,
      });
      if (!outcome) continue; // already claimed / terminal (duplicate)
      summary.executed += 1;
      if (outcome.status === "succeeded") summary.succeeded += 1;
      if (outcome.status === "failed") summary.failed += 1;
      if (outcome.status === "retried") summary.retried += 1;
      if (outcome.status === "skipped") summary.skipped += 1;
      if (outcome.budgetSkipped) summary.budget_skipped += 1;
      if (outcome.autoPaused) summary.auto_paused += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
