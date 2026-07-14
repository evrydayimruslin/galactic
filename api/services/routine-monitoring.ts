import type { CommandCardDataPayload } from "../../shared/contracts/widget.ts";
import { getEnv } from "../lib/env.ts";
import {
  createRoutineRun,
  getRoutine,
  listRoutines,
  pauseRoutine,
  type RoutineCapabilityRow,
  type RoutineRunRow,
  type RoutineRunStatus,
  type RoutineStatus,
  type RoutineSummary,
  type StoredRoutine,
} from "./routines.ts";
import { executeRoutinePlatformAction } from "./routine-platform.ts";

interface RoutineCapabilityStatusRow {
  routine_id: string;
  approved: boolean;
}

export interface RoutineMonitorOptions {
  status?: unknown;
  limit?: number;
  now?: Date;
}

export interface RoutineMonitorSummary {
  total: number;
  active: number;
  paused: number;
  error: number;
  pending_approvals: number;
  failures_24h: number;
  spend_light_24h: number;
  spend_light_30d: number;
  next_run_at: string | null;
  last_run_at: string | null;
}

export interface RoutineMonitorAction {
  id: "pause" | "resume" | "run_now";
  label: string;
  method: "PATCH" | "POST";
  endpoint: string;
  body?: Record<string, unknown>;
}

export interface RoutineMonitorItem extends RoutineSummary {
  health: "active" | "paused" | "running" | "needs_approval" | "error";
  approved_capability_count: number;
  pending_capability_count: number;
  capability_count: number;
  last_run: RoutineRunRow | null;
  recent_runs: RoutineRunRow[];
  failures_24h: number;
  spend_light_24h: number;
  spend_light_30d: number;
  actions: RoutineMonitorAction[];
}

export interface RoutineMonitorResponse {
  summary: RoutineMonitorSummary;
  routines: RoutineMonitorItem[];
  cards: Record<string, CommandCardDataPayload>;
  generated_at: string;
}

export interface RoutineMonitorDetailResponse {
  routine: RoutineMonitorItem;
  capabilities: RoutineCapabilityRow[];
  dashboard_bindings: StoredRoutine["dashboard_bindings"];
  cards: Record<string, CommandCardDataPayload>;
  generated_at: string;
}

const RUN_SELECT =
  "id,routine_id,user_id,status,trigger,trace_id,started_at,completed_at,duration_ms,total_light,summary,error,run_config,metadata,created_at";
const CAPABILITY_STATUS_SELECT = "routine_id,approved";
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function serviceHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
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
  const payload = await res.json().catch(() => []);
  return Array.isArray(payload) ? payload as T[] : [];
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function normalizeStatus(value: unknown): RoutineStatus | undefined {
  if (
    value === "active" || value === "paused" || value === "disabled" ||
    value === "deleted" || value === "error"
  ) {
    return value;
  }
  return undefined;
}

function dateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function sumLight(runs: RoutineRunRow[]): number {
  return runs.reduce((sum, run) => {
    const amount = typeof run.total_light === "number" &&
        Number.isFinite(run.total_light)
      ? run.total_light
      : 0;
    return sum + Math.max(0, amount);
  }, 0);
}

function statusLabel(status: RoutineStatus | RoutineRunStatus | null): string {
  if (!status) return "No runs";
  return status.replace(/_/g, " ");
}

function formatLight(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  if (amount >= 10) return amount.toFixed(0);
  if (amount >= 1) return amount.toFixed(2);
  return amount.toFixed(3);
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "-";
  const ms = dateMs(value);
  if (!ms) return "-";
  return new Date(ms).toISOString();
}

function routineActions(routine: RoutineSummary): RoutineMonitorAction[] {
  const endpoint = `/api/user/routines/${encodeURIComponent(routine.id)}`;
  const actions: RoutineMonitorAction[] = [];
  if (routine.status === "active" || routine.status === "error") {
    actions.push({
      id: "pause",
      label: "Pause",
      method: "PATCH",
      endpoint,
      body: { action: "pause" },
    });
  }
  if (routine.status === "paused" || routine.status === "error") {
    actions.push({
      id: "resume",
      label: "Resume",
      method: "PATCH",
      endpoint,
      body: { action: "resume" },
    });
  }
  if (routine.status !== "deleted" && routine.status !== "disabled") {
    actions.push({
      id: "run_now",
      label: "Run now",
      method: "POST",
      endpoint: `${endpoint}/run`,
    });
  }
  return actions;
}

function routineHealth(
  routine: RoutineSummary,
  pendingCapabilityCount: number,
  lastRun: RoutineRunRow | null,
): RoutineMonitorItem["health"] {
  if (pendingCapabilityCount > 0) return "needs_approval";
  if (routine.status === "error") return "error";
  if (lastRun?.status === "running" || lastRun?.status === "queued") {
    return "running";
  }
  if (routine.status === "active") return "active";
  return "paused";
}

function groupCapabilities(
  capabilities: RoutineCapabilityStatusRow[],
): Map<string, RoutineCapabilityStatusRow[]> {
  const grouped = new Map<string, RoutineCapabilityStatusRow[]>();
  for (const capability of capabilities) {
    const bucket = grouped.get(capability.routine_id) ?? [];
    bucket.push(capability);
    grouped.set(capability.routine_id, bucket);
  }
  return grouped;
}

function groupRuns(runs: RoutineRunRow[]): Map<string, RoutineRunRow[]> {
  const grouped = new Map<string, RoutineRunRow[]>();
  for (const run of runs) {
    const bucket = grouped.get(run.routine_id) ?? [];
    bucket.push(run);
    grouped.set(run.routine_id, bucket);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => dateMs(b.created_at) - dateMs(a.created_at));
  }
  return grouped;
}

async function fetchCapabilityStatuses(
  userId: string,
  routineIds: string[],
): Promise<RoutineCapabilityStatusRow[]> {
  if (routineIds.length === 0) return [];
  return await readRows<RoutineCapabilityStatusRow>(
    await fetch(
      restUrl("routine_capabilities", {
        user_id: `eq.${userId}`,
        routine_id: `in.(${routineIds.join(",")})`,
        select: CAPABILITY_STATUS_SELECT,
      }),
      { headers: serviceHeaders() },
    ),
    "Failed to load routine capability approvals",
  );
}

async function fetchRoutineRuns(params: {
  userId: string;
  routineIds: string[];
  limit: number;
  since?: string;
}): Promise<RoutineRunRow[]> {
  if (params.routineIds.length === 0) return [];
  return await readRows<RoutineRunRow>(
    await fetch(
      restUrl("routine_runs", {
        user_id: `eq.${params.userId}`,
        routine_id: `in.(${params.routineIds.join(",")})`,
        ...(params.since ? { created_at: `gte.${params.since}` } : {}),
        select: RUN_SELECT,
        order: "created_at.desc",
        limit: String(params.limit),
      }),
      { headers: serviceHeaders() },
    ),
    "Failed to load routine runs",
  );
}

function buildRoutineMonitorItems(params: {
  routines: RoutineSummary[];
  capabilities: RoutineCapabilityStatusRow[];
  recentRuns: RoutineRunRow[];
  spendRuns30d: RoutineRunRow[];
  now: Date;
}): RoutineMonitorItem[] {
  const capabilitiesByRoutine = groupCapabilities(params.capabilities);
  const recentRunsByRoutine = groupRuns(params.recentRuns);
  const spendRunsByRoutine = groupRuns(params.spendRuns30d);
  const since24h = params.now.getTime() - DAY_MS;

  return params.routines.map((routine) => {
    const capabilityRows = capabilitiesByRoutine.get(routine.id) ?? [];
    const approved = capabilityRows.filter((row) => row.approved).length;
    const pending = capabilityRows.length - approved;
    const recentRuns = recentRunsByRoutine.get(routine.id) ?? [];
    const spendRuns30d = spendRunsByRoutine.get(routine.id) ?? [];
    const spendRuns24h = spendRuns30d.filter((run) =>
      dateMs(run.created_at) >= since24h
    );
    const failures24h = spendRuns24h.filter((run) => run.status === "failed")
      .length;
    const lastRun = recentRuns[0] ?? null;

    return {
      ...routine,
      health: routineHealth(routine, pending, lastRun),
      approved_capability_count: approved,
      pending_capability_count: pending,
      capability_count: capabilityRows.length,
      last_run: lastRun,
      recent_runs: recentRuns.slice(0, 5),
      failures_24h: failures24h,
      spend_light_24h: sumLight(spendRuns24h),
      spend_light_30d: sumLight(spendRuns30d),
      actions: routineActions(routine),
    };
  });
}

function summarize(items: RoutineMonitorItem[]): RoutineMonitorSummary {
  const active = items.filter((item) => item.status === "active").length;
  const paused = items.filter((item) => item.status === "paused").length;
  const error =
    items.filter((item) => item.status === "error" || item.health === "error")
      .length;
  const nextRunAt = items
    .filter((item) => item.status === "active" && item.next_run_at)
    .map((item) => item.next_run_at!)
    .sort((a, b) => dateMs(a) - dateMs(b))[0] ?? null;
  const lastRunAt = items
    .map((item) =>
      item.last_run?.completed_at || item.last_run?.started_at ||
      item.last_run?.created_at || item.last_run_at
    )
    .filter((value): value is string => !!value)
    .sort((a, b) => dateMs(b) - dateMs(a))[0] ?? null;

  return {
    total: items.length,
    active,
    paused,
    error,
    pending_approvals: items.reduce(
      (sum, item) => sum + item.pending_capability_count,
      0,
    ),
    failures_24h: items.reduce((sum, item) => sum + item.failures_24h, 0),
    spend_light_24h: items.reduce(
      (sum, item) => sum + item.spend_light_24h,
      0,
    ),
    spend_light_30d: items.reduce(
      (sum, item) => sum + item.spend_light_30d,
      0,
    ),
    next_run_at: nextRunAt,
    last_run_at: lastRunAt,
  };
}

function buildRoutineCards(
  items: RoutineMonitorItem[],
  summary: RoutineMonitorSummary,
  generatedAt: string,
): Record<string, CommandCardDataPayload> {
  const failedRuns = items.flatMap((item) =>
    item.recent_runs
      .filter((run) => run.status === "failed")
      .map((run) => ({ routine: item, run }))
  ).sort((a, b) => dateMs(b.run.created_at) - dateMs(a.run.created_at))
    .slice(0, 6);

  return {
    routine_inventory: {
      card_id: "routine_inventory",
      meta: {
        title: "Routines",
        icon: "activity",
        status: summary.error > 0 ? "error" : "live",
      },
      body: {
        kind: "summary",
        title: `${summary.active}/${summary.total} active`,
        lines: [
          `${summary.pending_approvals} pending approvals`,
          `${summary.failures_24h} failures in 24h`,
          `${formatLight(summary.spend_light_30d)} Light in 30d`,
          `Next ${formatTime(summary.next_run_at)}`,
        ],
      },
      updated_at: generatedAt,
    },
    routine_status: {
      card_id: "routine_status",
      meta: {
        title: "Routine Status",
        icon: "clock",
        status: summary.active > 0 ? "live" : "paused",
      },
      body: {
        kind: "list",
        rows: items.slice(0, 8).map((item) => [
          item.name,
          item.health,
          statusLabel(item.last_run?.status ?? null),
          formatTime(item.next_run_at),
          `${formatLight(item.spend_light_30d)} Light`,
        ]),
      },
      updated_at: generatedAt,
    },
    routine_approvals: {
      card_id: "routine_approvals",
      meta: {
        title: "Pending Approvals",
        icon: "shield",
        status: summary.pending_approvals > 0 ? "attention" : "live",
      },
      body: {
        kind: "list",
        rows: items
          .filter((item) => item.pending_capability_count > 0)
          .slice(0, 8)
          .map((item) => [
            item.name,
            item.pending_capability_count,
            item.capability_count,
          ]),
      },
      footer: summary.pending_approvals === 0
        ? "All routine capabilities are approved."
        : undefined,
      updated_at: generatedAt,
    },
    routine_failures: {
      card_id: "routine_failures",
      meta: {
        title: "Recent Failures",
        icon: "alert-triangle",
        status: failedRuns.length > 0 ? "error" : "live",
      },
      body: {
        kind: "timeline",
        rows: failedRuns.map(({ routine, run }) => ({
          time: run.created_at,
          title: routine.name,
          subtitle: typeof run.error?.message === "string"
            ? run.error.message
            : run.summary || "Routine run failed",
          accent: "error",
        })),
      },
      footer: failedRuns.length === 0 ? "No recent failed runs." : undefined,
      updated_at: generatedAt,
    },
  };
}

function buildResponse(
  items: RoutineMonitorItem[],
  now: Date,
): RoutineMonitorResponse {
  const generatedAt = now.toISOString();
  const summary = summarize(items);
  return {
    summary,
    routines: items,
    cards: buildRoutineCards(items, summary, generatedAt),
    generated_at: generatedAt,
  };
}

export async function listRoutineMonitor(
  userId: string,
  options: RoutineMonitorOptions = {},
): Promise<RoutineMonitorResponse> {
  const now = options.now ?? new Date();
  const limit = normalizeLimit(options.limit);
  const status = normalizeStatus(options.status);
  const { routines } = await listRoutines(userId, { status, limit });
  const routineIds = routines.map((routine) => routine.id);
  const since30d = new Date(now.getTime() - 30 * DAY_MS).toISOString();

  const [capabilities, recentRuns, spendRuns30d] = await Promise.all([
    fetchCapabilityStatuses(userId, routineIds),
    fetchRoutineRuns({
      userId,
      routineIds,
      limit: Math.max(100, limit * 5),
    }),
    fetchRoutineRuns({
      userId,
      routineIds,
      since: since30d,
      limit: 1000,
    }),
  ]);

  const items = buildRoutineMonitorItems({
    routines,
    capabilities,
    recentRuns,
    spendRuns30d,
    now,
  });
  return buildResponse(items, now);
}

export async function getRoutineMonitorDetail(
  userId: string,
  routineId: string,
  options: { now?: Date } = {},
): Promise<RoutineMonitorDetailResponse | null> {
  const now = options.now ?? new Date();
  const routine = await getRoutine(userId, routineId);
  if (!routine) return null;
  const since30d = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const [recentRuns, spendRuns30d] = await Promise.all([
    fetchRoutineRuns({ userId, routineIds: [routine.id], limit: 100 }),
    fetchRoutineRuns({
      userId,
      routineIds: [routine.id],
      since: since30d,
      limit: 1000,
    }),
  ]);
  const [item] = buildRoutineMonitorItems({
    routines: [routine],
    capabilities: routine.capabilities,
    recentRuns,
    spendRuns30d,
    now,
  });
  const response = buildResponse([item], now);
  return {
    routine: item,
    capabilities: routine.capabilities,
    dashboard_bindings: routine.dashboard_bindings,
    cards: response.cards,
    generated_at: response.generated_at,
  };
}

export async function updateRoutineMonitorStatus(
  userId: string,
  routineId: string,
  input: { action?: unknown; status?: unknown },
): Promise<RoutineMonitorDetailResponse> {
  const action = typeof input.action === "string" ? input.action : null;
  const status = normalizeStatus(input.status);
  if (action === "pause" || status === "paused") {
    await pauseRoutine(userId, routineId);
  } else if (action === "resume" || status === "active") {
    await executeRoutinePlatformAction(userId, {
      action: "resume",
      routine_id: routineId,
    });
  } else {
    throw new Error(
      "action must be pause/resume or status must be active/paused",
    );
  }

  const detail = await getRoutineMonitorDetail(userId, routineId);
  if (!detail) throw new Error(`Routine ${routineId} not found`);
  return detail;
}

export async function queueRoutineMonitorRun(
  userId: string,
  routineId: string,
): Promise<{ queued: true; run: RoutineRunRow; routine: RoutineMonitorItem }> {
  const detail = await getRoutineMonitorDetail(userId, routineId);
  if (!detail) throw new Error(`Routine ${routineId} not found`);
  if (detail.routine.status !== "active") {
    throw new Error(
      `Routine ${routineId} is ${detail.routine.status}; only an active, owner-approved routine can run now`,
    );
  }

  const run = await createRoutineRun({
    routineId,
    userId,
    trigger: "manual",
    traceId: crypto.randomUUID(),
    status: "queued",
    metadata: { source: "command_monitor.run_now" },
  });

  const updatedDetail = await getRoutineMonitorDetail(userId, routineId);
  return {
    queued: true,
    run,
    routine: updatedDetail?.routine ?? detail.routine,
  };
}
