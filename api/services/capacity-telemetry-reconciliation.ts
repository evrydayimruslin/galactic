import { createServerLogger, type LoggerLike } from "./logging.ts";
import { createSupabaseRestClient } from "./platform-clients/supabase-rest.ts";

const DEFAULT_RECONCILE_LIMIT = 100;
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_STALE_MINUTES = 5;

interface ReconciliationDeps {
  fetchFn?: typeof fetch;
  logger?: LoggerLike;
  now?: () => Date;
}

interface CapacityTelemetryReconciliationResult {
  processed: number;
  applied: number;
  pending: number;
  errors: number;
}

interface CapacityTelemetryReconciliationSummary {
  since: string | null;
  generated_at: string | null;
  settlements: Record<string, number>;
  resource_light: Record<string, unknown>;
  pending_old_count: number;
  oldest_pending_at: string | null;
  duplicate_observations: number;
  observed_cpu_ms: number;
  observed_wall_time_ms: number;
  total_light: number;
  attribution_pending_count: number;
  attribution_oldest_pending_at: string | null;
  dynamic_worker_daily_identities: number;
  inbox_pending_count: number;
  inbox_oldest_pending_at: string | null;
  inbox_error_count: number;
  inbox_attempts: number;
  [key: string]: unknown;
}

interface CapacityTelemetryReconciliationCycle {
  reconciliation: CapacityTelemetryReconciliationResult;
  summary: CapacityTelemetryReconciliationSummary;
  alarmed: boolean;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Capacity telemetry RPC returned invalid ${field}`);
  }
  return value;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Capacity telemetry RPC returned invalid ${field}`);
  }
  return value;
}

async function rpcPayload(
  name: string,
  body: Record<string, unknown>,
  deps: ReconciliationDeps,
): Promise<unknown> {
  const response = await createSupabaseRestClient({ fetchFn: deps.fetchFn })
    .rpc(name, body);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Capacity telemetry ${name} failed (${response.status}): ${detail}`,
    );
  }
  return await response.json().catch(() => null);
}

function firstObject(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) return asObject(payload[0]);
  return asObject(payload);
}

export async function reconcileCapacityCpuObservations(
  options: { limit?: number; now?: string } = {},
  deps: ReconciliationDeps = {},
): Promise<CapacityTelemetryReconciliationResult> {
  const limit = Math.max(
    1,
    Math.min(Math.trunc(options.limit ?? DEFAULT_RECONCILE_LIMIT), 500),
  );
  const payload = await rpcPayload("reconcile_capacity_cpu_observations", {
    p_limit: limit,
    ...(options.now ? { p_now: options.now } : {}),
  }, deps);
  const row = firstObject(payload);
  if (!row) {
    throw new Error("Capacity telemetry reconciliation returned no row");
  }
  return {
    processed: nonNegativeNumber(row.processed, "processed count"),
    applied: nonNegativeNumber(row.applied, "applied count"),
    pending: nonNegativeNumber(row.pending, "pending count"),
    errors: nonNegativeNumber(row.errors, "error count"),
  };
}

export async function getCapacityTelemetryReconciliationSummary(
  options: { since?: string; pendingAgeMinutes?: number } = {},
  deps: ReconciliationDeps = {},
): Promise<CapacityTelemetryReconciliationSummary> {
  const now = deps.now?.() ?? new Date();
  const pendingAgeMinutes = Math.max(
    1,
    Math.min(
      Math.trunc(options.pendingAgeMinutes ?? DEFAULT_STALE_MINUTES),
      24 * 60,
    ),
  );
  const since = options.since ?? new Date(
    now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  if (!Number.isFinite(Date.parse(since))) {
    throw new Error(
      "Capacity telemetry reconciliation since timestamp is invalid",
    );
  }
  const payload = await rpcPayload("get_capacity_reconciliation_summary", {
    p_since: since,
    p_pending_age: `${pendingAgeMinutes} minutes`,
  }, deps);
  const row = firstObject(payload);
  if (!row) throw new Error("Capacity telemetry summary returned no object");
  const settlements = asObject(row.settlements) ?? {};
  const resourceLight = asObject(row.resource_light) ?? {};
  return {
    ...row,
    since: nullableTimestamp(row.since, "since"),
    generated_at: nullableTimestamp(row.generated_at, "generated timestamp"),
    settlements: Object.fromEntries(
      Object.entries(settlements).map(([key, value]) => [
        key,
        nonNegativeNumber(value, `settlement ${key} count`),
      ]),
    ),
    resource_light: resourceLight,
    pending_old_count: nonNegativeNumber(
      row.pending_old_count ?? 0,
      "old pending settlement count",
    ),
    oldest_pending_at: nullableTimestamp(
      row.oldest_pending_at,
      "oldest pending settlement timestamp",
    ),
    duplicate_observations: nonNegativeNumber(
      row.duplicate_observations ?? 0,
      "duplicate observation count",
    ),
    observed_cpu_ms: nonNegativeNumber(
      row.observed_cpu_ms ?? 0,
      "observed CPU",
    ),
    observed_wall_time_ms: nonNegativeNumber(
      row.observed_wall_time_ms ?? 0,
      "observed wall time",
    ),
    total_light: nonNegativeNumber(row.total_light ?? 0, "total Light"),
    attribution_pending_count: nonNegativeNumber(
      row.attribution_pending_count ?? 0,
      "pending attribution count",
    ),
    attribution_oldest_pending_at: nullableTimestamp(
      row.attribution_oldest_pending_at,
      "oldest pending attribution timestamp",
    ),
    dynamic_worker_daily_identities: nonNegativeNumber(
      row.dynamic_worker_daily_identities ?? 0,
      "Dynamic Worker identity count",
    ),
    inbox_pending_count: nonNegativeNumber(
      row.inbox_pending_count ?? 0,
      "inbox pending count",
    ),
    inbox_oldest_pending_at: nullableTimestamp(
      row.inbox_oldest_pending_at,
      "oldest inbox timestamp",
    ),
    inbox_error_count: nonNegativeNumber(
      row.inbox_error_count ?? 0,
      "inbox error count",
    ),
    inbox_attempts: nonNegativeNumber(
      row.inbox_attempts ?? 0,
      "inbox attempt count",
    ),
  };
}

/**
 * Reconcile durable observations and emit one machine-filterable alarm when
 * telemetry is stale or errored. Cloudflare log alerts should match the
 * `CAPACITY-TELEMETRY-ALARM` scope; owner inbox notifications are deliberately
 * not used for platform operations.
 */
export async function runCapacityTelemetryReconciliationCycle(
  options: { limit?: number; staleMinutes?: number } = {},
  deps: ReconciliationDeps = {},
): Promise<CapacityTelemetryReconciliationCycle> {
  const logger = deps.logger ?? createServerLogger("CAPACITY-TELEMETRY-ALARM");
  const now = deps.now?.() ?? new Date();
  const staleMinutes = Math.max(
    1,
    Math.min(
      Math.trunc(options.staleMinutes ?? DEFAULT_STALE_MINUTES),
      24 * 60,
    ),
  );
  try {
    const reconciliation = await reconcileCapacityCpuObservations({
      limit: options.limit,
      now: now.toISOString(),
    }, deps);
    const summary = await getCapacityTelemetryReconciliationSummary({
      pendingAgeMinutes: staleMinutes,
    }, { ...deps, now: () => now });
    const oldestInboxMs = summary.inbox_oldest_pending_at == null
      ? null
      : Date.parse(summary.inbox_oldest_pending_at);
    const inboxIsStale = summary.inbox_pending_count > 0 &&
      oldestInboxMs != null &&
      oldestInboxMs <= now.getTime() - staleMinutes * 60 * 1000;
    const alarmed = reconciliation.errors > 0 ||
      summary.inbox_error_count > 0 ||
      summary.attribution_pending_count > 0 ||
      summary.pending_old_count > 0 ||
      inboxIsStale;
    if (alarmed) {
      logger.error("Capacity telemetry reconciliation is degraded", {
        stale_minutes: staleMinutes,
        reconciliation,
        pending_settlements_old: summary.pending_old_count,
        oldest_pending_settlement_at: summary.oldest_pending_at,
        inbox_pending: summary.inbox_pending_count,
        inbox_oldest_pending_at: summary.inbox_oldest_pending_at,
        inbox_errors: summary.inbox_error_count,
        inbox_attempts: summary.inbox_attempts,
        attribution_pending: summary.attribution_pending_count,
        attribution_oldest_pending_at: summary.attribution_oldest_pending_at,
      });
    }
    return { reconciliation, summary, alarmed };
  } catch (error) {
    logger.error("Capacity telemetry reconciliation crashed", { error });
    throw error;
  }
}
