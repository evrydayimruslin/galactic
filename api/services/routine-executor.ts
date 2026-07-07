import { getEnv } from "../lib/env.ts";
import { resolveInternalMcpCall } from "./internal-mcp.ts";
import type { RoutineBudgetDefaults } from "../../shared/contracts/routine.ts";
import {
  createRoutineActorTokenForRun,
  type RoutineActorUserInput,
} from "./routine-auth.ts";
import {
  getRoutine,
  type NormalizedRoutineSchedule,
  recordRoutineRunStep,
  type RoutineCapabilityRow,
  type RoutineRunRow,
  type RoutineRunStatus,
  type StoredRoutine,
} from "./routines.ts";

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
const MIN_INTERVAL_SECONDS = 60;
// Circuit breaker: consecutive failed ATTEMPTS (failure_count resets to 0 on
// any success) before the routine is auto-paused. At the default retry policy
// (3 attempts/run) the default trips after ~3-4 fully failed runs. Overridable
// per routine via metadata.circuit_breaker.max_consecutive_failures (1-100).
const DEFAULT_BREAKER_FAILURES = 10;
// max_calls_per_run is verified by counting the run's recorded contribution
// steps; caps at or above this bound cannot be verified cheaply and are inert.
const MAX_VERIFIABLE_CALLS_CAP = 500;

export interface RoutineExecutorOptions {
  now?: Date;
  clock?: () => Date;
  limit?: number;
  leaseMs?: number;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface RoutineExecutorSummary {
  checked_at: string;
  claimed_scheduled: number;
  claimed_queued: number;
  executed: number;
  succeeded: number;
  failed: number;
  retried: number;
  skipped: number;
  budget_skipped: number;
  auto_paused: number;
  errors: Array<{ run_id?: string; routine_id?: string; error: string }>;
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

function leaseAndDueFilter(dueColumn: string, now: Date): string {
  const stamp = iso(now);
  return `(or(lease_expires_at.is.null,lease_expires_at.lt.${stamp}),or(${dueColumn}.is.null,${dueColumn}.lte.${stamp}))`;
}

function nextMinuteAfter(date: Date): Date {
  const next = new Date(date.getTime());
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next;
}

function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const segment of field.split(",")) {
    if (segment === "*") {
      for (let value = min; value <= max; value++) values.push(value);
    } else if (segment.startsWith("*/")) {
      const step = Number.parseInt(segment.slice(2), 10);
      if (!Number.isFinite(step) || step <= 0) throw new Error("bad step");
      for (let value = min; value <= max; value += step) values.push(value);
    } else if (segment.includes("-")) {
      const [start, end] = segment.split("-").map((part) =>
        Number.parseInt(part, 10)
      );
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error("bad range");
      }
      for (let value = start; value <= end; value++) values.push(value);
    } else {
      const value = Number.parseInt(segment, 10);
      if (!Number.isFinite(value)) throw new Error("bad value");
      values.push(value);
    }
  }
  return [...new Set(values.filter((value) => value >= min && value <= max))]
    .sort((a, b) => a - b);
}

function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  try {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    return parseCronField(minute, 0, 59).includes(date.getUTCMinutes()) &&
      parseCronField(hour, 0, 23).includes(date.getUTCHours()) &&
      parseCronField(dayOfMonth, 1, 31).includes(date.getUTCDate()) &&
      parseCronField(month, 1, 12).includes(date.getUTCMonth() + 1) &&
      parseCronField(dayOfWeek, 0, 6).includes(date.getUTCDay());
  } catch {
    return false;
  }
}

export function computeNextRoutineRunAt(
  schedule: NormalizedRoutineSchedule,
  from: Date,
): Date | null {
  if (!isRecord(schedule)) return null;

  if (schedule.type === "interval") {
    const seconds = typeof schedule.every_seconds === "number"
      ? schedule.every_seconds
      : typeof schedule.every_minutes === "number"
      ? schedule.every_minutes * 60
      : 5 * 60;
    const guardedSeconds = Math.max(MIN_INTERVAL_SECONDS, Math.floor(seconds));
    return addMs(from, guardedSeconds * 1000);
  }

  if (schedule.type === "cron" && typeof schedule.cron === "string") {
    let candidate = nextMinuteAfter(from);
    const maxMinutes = 366 * 24 * 60;
    for (let i = 0; i < maxMinutes; i++) {
      if (cronMatches(schedule.cron, candidate)) return candidate;
      candidate = addMs(candidate, 60 * 1000);
    }
  }

  return null;
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
// budget_policy caps (shared/contracts/routine.ts) are enforced here with no
// schema changes:
// - Day/month caps gate SCHEDULED wakes before the handler runs. Spend is
//   rolled up on the routine row (metadata.budget_spend) from each terminal
//   run's total_light, so the gate costs zero extra queries. An exhausted
//   budget records ONE skipped run and defers next_run_at to the budget reset
//   boundary (next UTC midnight / first of next UTC month) instead of
//   re-skipping every cadence tick. Manual run_now bypasses these gates — it
//   is an explicit user action.
// - Per-run caps (max_light_per_run, max_calls_per_run) cannot stop a
//   synchronous handler mid-flight; a violation auto-pauses the routine after
//   the run, limiting a runaway loop to a single wake.
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

function budgetGate(routine: StoredRoutine, now: Date): BudgetGateResult | null {
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

async function claimRoutine(
  routine: ExecutorRoutineRow,
  now: Date,
  leaseMs: number,
): Promise<ExecutorRoutineRow | null> {
  const leaseId = crypto.randomUUID();
  const [claimed] = await patchRows<ExecutorRoutineRow>(
    "user_routines",
    {
      id: `eq.${routine.id}`,
      status: "eq.active",
      and: leaseAndDueFilter("next_run_at", now),
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
  leaseMs: number,
): Promise<ExecutorRunRow> {
  const policy = retryPolicyFrom(routine);
  const [run] = await insertRows<ExecutorRunRow>(
    "routine_runs",
    { select: RUN_SELECT },
    {
      routine_id: routine.id,
      user_id: routine.user_id,
      status: "running",
      trigger: "scheduled",
      trace_id: crypto.randomUUID(),
      started_at: iso(now),
      run_config: {},
      metadata: {
        source: "routine_executor",
        routine_lease_id: routine.lease_id,
      },
      lease_id: crypto.randomUUID(),
      lease_expires_at: iso(addMs(now, leaseMs)),
      attempt_count: 1,
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

async function claimScheduledRuns(
  now: Date,
  limit: number,
  leaseMs: number,
): Promise<ClaimedRun[]> {
  const claimedRuns: ClaimedRun[] = [];
  const candidates = await dueRoutineCandidates(now, limit);

  for (const candidate of candidates) {
    if (claimedRuns.length >= limit) break;
    const activeCount = await activeRunCount(candidate.id);
    if (activeCount >= candidate.max_concurrency) continue;

    const claimedRoutine = await claimRoutine(candidate, now, leaseMs);
    if (!claimedRoutine) continue;

    try {
      const run = await insertScheduledRun(claimedRoutine, now, leaseMs);
      const nextRunAt = computeNextRoutineRunAt(claimedRoutine.schedule, now);
      await releaseRoutineLease(claimedRoutine.id, now, {
        next_run_at: nextRunAt ? iso(nextRunAt) : null,
        last_run_at: iso(now),
      });
      claimedRuns.push({ run, source: "scheduled" });
    } catch (err) {
      await releaseRoutineLease(claimedRoutine.id, now, {
        last_error_at: iso(now),
        failure_count: claimedRoutine.failure_count + 1,
      }).catch(() => {});
      throw err;
    }
  }

  return claimedRuns;
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

async function claimQueuedRun(
  run: ExecutorRunRow,
  now: Date,
  leaseMs: number,
): Promise<ExecutorRunRow | null> {
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
      id: `eq.${run.id}`,
      status: "eq.queued",
      attempt_count: `eq.${run.attempt_count}`,
      and: leaseAndDueFilter("next_attempt_at", now),
      select: RUN_SELECT,
    },
    {
      status: "running",
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

async function claimQueuedRuns(
  now: Date,
  limit: number,
  leaseMs: number,
): Promise<ClaimedRun[]> {
  const claimedRuns: ClaimedRun[] = [];
  const candidates = await queuedRunCandidates(now, limit);

  for (const candidate of candidates) {
    if (claimedRuns.length >= limit) break;
    const claimed = await claimQueuedRun(candidate, now, leaseMs);
    if (claimed) claimedRuns.push({ run: claimed, source: "queued" });
  }

  return claimedRuns;
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
    },
  };
}

async function invokeRoutineHandler(
  routine: StoredRoutine,
  run: ExecutorRunRow,
  options: Required<Pick<RoutineExecutorOptions, "baseUrl" | "fetchFn">>,
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

  // SELF service binding when available: same-worker fetch() over the public
  // hostname is blocked by the CDN (error 1042). options.fetchFn remains the
  // test seam / fallback. The helper validates + encodes the composer id.
  const internalCall = resolveInternalMcpCall(composerAppId, {
    baseUrl: options.baseUrl,
    fetchFn: options.fetchFn,
  });
  const response = await internalCall.fetchFn(
    internalCall.url,
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

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Routine MCP call failed (${response.status}): ${text}`);
  }

  const rpc = await response.json() as {
    result?: unknown;
    error?: { message?: string; code?: number };
  };
  if (rpc.error) {
    throw new Error(
      rpc.error.message || `Routine MCP error ${rpc.error.code ?? ""}`.trim(),
    );
  }

  // Execution failures surface as tool RESULTS with isError: true (the
  // JSON-RPC layer succeeded; the handler did not). Without this check a
  // failed handler — e.g. a never-built app's "Run rebuild first" — would be
  // recorded as a SUCCEEDED run and never retried.
  if (isRecord(rpc.result) && rpc.result.isError === true) {
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
): Promise<ExecutorRunRow | null> {
  const [run] = await patchRows<ExecutorRunRow>(
    "routine_runs",
    { id: `eq.${runId}`, select: RUN_SELECT },
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
  });
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
  options: Required<Pick<RoutineExecutorOptions, "baseUrl" | "fetchFn">>,
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

  // "paused" is included so an auto-pause (circuit breaker / budget) also
  // stops queued retries that were claimed before the pause landed.
  if (
    routine.status === "deleted" || routine.status === "disabled" ||
    routine.status === "paused"
  ) {
    await finishRun(run, "skipped", now, {
      summary: `Routine is ${routine.status}`,
    });
    return { status: "skipped" };
  }

  // Day/month budget gate for scheduled wakes. Manual run_now bypasses it —
  // an explicit user action, and a debugging path while a budget is spent.
  if (run.trigger === "scheduled") {
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
      return { status: "skipped", budgetSkipped: true };
    }
  }

  const startedAt = now;
  const args = buildRoutineArgs(routine, run);
  try {
    const result = await invokeRoutineHandler(routine, run, options);
    const completedAt = clock();
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
  } catch (err) {
    const completedAt = clock();
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
  const baseUrl = options.baseUrl || getEnv("BASE_URL") ||
    "https://api.connectgalactic.com";
  const fetchFn = options.fetchFn || fetch;
  const clock = options.clock || (() => new Date());

  const summary: RoutineExecutorSummary = {
    checked_at: iso(now),
    claimed_scheduled: 0,
    claimed_queued: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    skipped: 0,
    budget_skipped: 0,
    auto_paused: 0,
    errors: [],
  };

  const scheduled = await claimScheduledRuns(now, limit, leaseMs).catch(
    (err) => {
      summary.errors.push({
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as ClaimedRun[];
    },
  );
  summary.claimed_scheduled = scheduled.length;

  const remaining = Math.max(0, limit - scheduled.length);
  const queued = remaining > 0
    ? await claimQueuedRuns(now, remaining, leaseMs).catch((err) => {
      summary.errors.push({
        error: err instanceof Error ? err.message : String(err),
      });
      return [] as ClaimedRun[];
    })
    : [];
  summary.claimed_queued = queued.length;

  for (const claimed of [...scheduled, ...queued]) {
    try {
      const outcome = await executeClaimedRun(
        claimed,
        { baseUrl, fetchFn },
        now,
        clock,
      );
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
        run_id: claimed.run.id,
        routine_id: claimed.run.routine_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
