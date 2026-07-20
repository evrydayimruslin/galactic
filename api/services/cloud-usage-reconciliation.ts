import { buildEconomicIdempotencyKey } from "./economic-idempotency.ts";
import { CloudUsageRpcError, releaseCloudUsageHold } from "./cloud-usage.ts";
import { createSupabaseRestClient } from "./platform-clients/supabase-rest.ts";

const DEFAULT_RELEASE_LIMIT = 100;
const DEFAULT_REPORT_LIMIT = 100;
const DEFAULT_REPORT_SCAN_LIMIT = 10_000;
const DEFAULT_REPORT_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EPSILON_LIGHT = 0.000000001;

const HOLD_SELECT = [
  "id",
  "created_at",
  "updated_at",
  "expires_at",
  "status",
  "payer_user_id",
  "sponsor_user_id",
  "caller_user_id",
  "owner_user_id",
  "app_id",
  "function_name",
  "receipt_id",
  "source",
  "resource",
  "expected_units",
  "expected_cloud_units",
  "expected_amount_light",
  "held_amount_light",
  "settled_amount_light",
  "released_amount_light",
  "settlement_event_id",
  "billing_config_version",
].join(",");

const EVENT_SELECT = [
  "id",
  "created_at",
  "payer_user_id",
  "sponsor_user_id",
  "caller_user_id",
  "owner_user_id",
  "app_id",
  "function_name",
  "receipt_id",
  "source",
  "resource",
  "units",
  "cloud_units",
  "amount_light",
  "billing_config_version",
  "hold_id",
].join(",");

const RECEIPT_SELECT = [
  "id",
  "created_at",
  "app_id",
  "app_name",
  "method",
  "source",
  "success",
  "infra_charge_light",
  "cloud_charge_light",
  "cloud_units",
  "billing_config_version",
].join(",");

const LEDGER_SELECT = [
  "id",
  "created_at",
  "user_id",
  "app_id",
  "bucket",
  "kind",
  "amount_light",
  "reference_table",
  "reference_id",
].join(",");

interface SupabaseRequestClient {
  request(path: string, init?: RequestInit): Promise<Response>;
}

interface CloudUsageHoldRow {
  id: string;
  created_at: string;
  updated_at: string | null;
  expires_at: string | null;
  status: "held" | "settled" | "released" | "expired" | string;
  payer_user_id: string | null;
  sponsor_user_id: string | null;
  caller_user_id: string | null;
  owner_user_id: string | null;
  app_id: string | null;
  function_name: string | null;
  receipt_id: string | null;
  source: string;
  resource: string;
  expected_units: number | null;
  expected_cloud_units: number | null;
  expected_amount_light: number | null;
  held_amount_light: number | null;
  settled_amount_light: number | null;
  released_amount_light: number | null;
  settlement_event_id: string | null;
  billing_config_version: number | null;
}

interface CloudUsageEventRow {
  id: string;
  created_at: string;
  payer_user_id: string | null;
  sponsor_user_id: string | null;
  caller_user_id: string | null;
  owner_user_id: string | null;
  app_id: string | null;
  function_name: string | null;
  receipt_id: string | null;
  source: string;
  resource: string;
  units: number | null;
  cloud_units: number | null;
  amount_light: number | null;
  billing_config_version: number | null;
  hold_id: string | null;
}

interface CallReceiptRow {
  id: string;
  created_at: string;
  app_id: string | null;
  app_name: string | null;
  method: string | null;
  source: string | null;
  success: boolean | null;
  infra_charge_light: number | null;
  cloud_charge_light: number | null;
  cloud_units: number | null;
  billing_config_version: number | null;
}

interface LightLedgerEntryRow {
  id: string;
  created_at: string;
  user_id: string | null;
  app_id: string | null;
  bucket: string;
  kind: string;
  amount_light: number | null;
  reference_table: string | null;
  reference_id: string | null;
}

export interface ReleaseExpiredCloudUsageHoldsOptions {
  now?: Date | string;
  limit?: number;
  fetchFn?: typeof fetch;
}

export interface CloudUsageHoldReleaseJobResult {
  generated_at: string;
  candidate_count: number;
  released_count: number;
  skipped_count: number;
  failed_count: number;
  released_amount_light: number;
  released_hold_ids: string[];
  skipped_holds: Array<{ hold_id: string; reason: string }>;
  errors: Array<{ hold_id: string; message: string }>;
}

export interface CloudUsageReconciliationOptions {
  now?: Date | string;
  since?: Date | string;
  periodDays?: number;
  limit?: number;
  scanLimit?: number;
  fetchFn?: typeof fetch;
}

export interface CloudUsageReconciliationReport {
  generated_at: string;
  since: string;
  period_days: number;
  sample_limit: number;
  scan_limit: number;
  metrics: {
    holds_created: number;
    holds_held: number;
    holds_settled: number;
    holds_released: number;
    holds_past_expiry: number;
    events_recorded: number;
    events_from_holds: number;
    direct_events_recorded: number;
    settlement_overdraw_rows: number;
    settled_holds_missing_event: number;
    settlement_events_missing_hold: number;
    events_missing_receipt: number;
    holds_missing_ledger_entries: number;
    direct_events_missing_ledger_entries: number;
    receipt_infra_mismatches: number;
  };
  stale_holds: {
    count: number;
    amount_light: number;
    sample: CloudUsageHoldSummary[];
  };
  anomalies: {
    settled_holds_missing_event: CloudUsageHoldSummary[];
    settlement_overdraw_rows: CloudUsageHoldSummary[];
    settlement_events_missing_hold: CloudUsageEventSummary[];
    events_missing_receipt: CloudUsageEventSummary[];
    holds_missing_ledger_entries: CloudUsageHoldSummary[];
    direct_events_missing_ledger_entries: CloudUsageEventSummary[];
    receipt_infra_mismatches: Array<{
      receipt_id: string;
      receipt_amount_light: number;
      event_amount_light: number;
      delta_light: number;
      event_count: number;
    }>;
  };
}

interface CloudUsageHoldSummary {
  id: string;
  created_at: string;
  updated_at: string | null;
  expires_at: string | null;
  status: string;
  payer_user_id: string | null;
  app_id: string | null;
  function_name: string | null;
  receipt_id: string | null;
  source: string;
  resource: string;
  expected_amount_light: number;
  held_amount_light: number;
  settled_amount_light: number;
  released_amount_light: number;
  settlement_event_id: string | null;
}

interface CloudUsageEventSummary {
  id: string;
  created_at: string;
  payer_user_id: string | null;
  app_id: string | null;
  function_name: string | null;
  receipt_id: string | null;
  hold_id: string | null;
  source: string;
  resource: string;
  cloud_units: number;
  amount_light: number;
}

export async function releaseExpiredCloudUsageHolds(
  options: ReleaseExpiredCloudUsageHoldsOptions = {},
): Promise<CloudUsageHoldReleaseJobResult> {
  const now = normalizeDate(options.now);
  const nowIso = now.toISOString();
  const limit = normalizeLimit(
    options.limit,
    DEFAULT_RELEASE_LIMIT,
    DEFAULT_REPORT_SCAN_LIMIT,
  );
  const supabase = createSupabaseRestClient({ fetchFn: options.fetchFn });
  // Compute owns destroy-before-settle semantics. Releasing those holds in the
  // generic expiry sweeper can race its fenced body teardown and make the
  // terminal receipt impossible. The Compute reconciler is the sole owner.
  const holds = await queryExpiredHeldHolds(supabase, nowIso, limit, true);
  const result: CloudUsageHoldReleaseJobResult = {
    generated_at: nowIso,
    candidate_count: holds.length,
    released_count: 0,
    skipped_count: 0,
    failed_count: 0,
    released_amount_light: 0,
    released_hold_ids: [],
    skipped_holds: [],
    errors: [],
  };

  for (const hold of holds) {
    try {
      const release = await releaseCloudUsageHold({
        holdId: hold.id,
        idempotencyKey: buildEconomicIdempotencyKey(
          "expired_cloud_hold_release",
          [hold.id],
        ),
        metadata: {
          release_reason: "expired",
          released_by: "cloud_usage_hold_releaser",
          expired_at: hold.expires_at,
          job_now: nowIso,
        },
      }, { fetchFn: options.fetchFn });
      result.released_count += 1;
      result.released_amount_light += release.releasedAmountLight;
      result.released_hold_ids.push(release.holdId);
    } catch (err) {
      const message = errorMessage(err);
      if (isBenignReleaseRace(err)) {
        result.skipped_count += 1;
        result.skipped_holds.push({ hold_id: hold.id, reason: message });
      } else {
        result.failed_count += 1;
        result.errors.push({ hold_id: hold.id, message });
      }
    }
  }

  return result;
}

export async function getCloudUsageReconciliationReport(
  options: CloudUsageReconciliationOptions = {},
): Promise<CloudUsageReconciliationReport> {
  const now = normalizeDate(options.now);
  const periodDays = normalizePeriodDays(options.periodDays);
  const since = options.since
    ? normalizeDate(options.since)
    : new Date(now.getTime() - periodDays * MS_PER_DAY);
  const limit = normalizeLimit(options.limit, DEFAULT_REPORT_LIMIT, 500);
  const scanLimit = normalizeLimit(
    options.scanLimit,
    DEFAULT_REPORT_SCAN_LIMIT,
    50_000,
  );
  const supabase = createSupabaseRestClient({ fetchFn: options.fetchFn });
  const sinceIso = since.toISOString();
  const nowIso = now.toISOString();

  const [expiredHolds, recentHolds, recentEvents] = await Promise.all([
    queryExpiredHeldHolds(supabase, nowIso, scanLimit),
    queryRows<CloudUsageHoldRow>(
      supabase,
      `/rest/v1/cloud_usage_holds?created_at=gte.${
        encodeFilter(sinceIso)
      }&select=${HOLD_SELECT}&order=created_at.desc&limit=${scanLimit}`,
      "recent cloud usage holds",
    ),
    queryRows<CloudUsageEventRow>(
      supabase,
      `/rest/v1/cloud_usage_events?created_at=gte.${
        encodeFilter(sinceIso)
      }&select=${EVENT_SELECT}&order=created_at.desc&limit=${scanLimit}`,
      "recent cloud usage events",
    ),
  ]);

  const eventHoldIds = unique(
    recentEvents.map((event) => event.hold_id).filter(isPresent),
  );
  const receiptIds = unique(
    recentEvents.map((event) => event.receipt_id).filter(isPresent),
  );
  const directEventIds = unique(
    recentEvents
      .filter((event) => !event.hold_id && numberValue(event.amount_light) > 0)
      .map((event) => event.id),
  );
  const holdLedgerIds = unique(recentHolds.map((hold) => hold.id));

  const [referencedHolds, receipts, holdLedgers, eventLedgers] = await Promise
    .all([
      queryRowsById<CloudUsageHoldRow>(
        supabase,
        "cloud_usage_holds",
        HOLD_SELECT,
        eventHoldIds,
        scanLimit,
        "cloud usage holds referenced by events",
      ),
      queryRowsById<CallReceiptRow>(
        supabase,
        "mcp_call_logs",
        RECEIPT_SELECT,
        receiptIds,
        scanLimit,
        "call receipts referenced by cloud events",
      ),
      queryLedgerEntries(
        supabase,
        "cloud_usage_holds",
        holdLedgerIds,
        scanLimit,
      ),
      queryLedgerEntries(
        supabase,
        "cloud_usage_events",
        directEventIds,
        scanLimit,
      ),
    ]);

  const referencedHoldSet = new Set(referencedHolds.map((hold) => hold.id));
  const receiptSet = new Set(receipts.map((receipt) => receipt.id));
  const holdLedgerSet = new Set(
    holdLedgers.map((entry) => entry.reference_id).filter(isPresent),
  );
  const eventLedgerSet = new Set(
    eventLedgers.map((entry) => entry.reference_id).filter(isPresent),
  );

  const settledHoldsMissingEvent = recentHolds.filter((hold) =>
    hold.status === "settled" && !hold.settlement_event_id
  );
  const settlementOverdrawRows = recentHolds.filter((hold) =>
    hold.status === "settled" &&
    numberValue(hold.settled_amount_light) -
          numberValue(hold.held_amount_light) > EPSILON_LIGHT
  );
  const settlementEventsMissingHold = recentEvents.filter((event) =>
    event.hold_id && !referencedHoldSet.has(event.hold_id)
  );
  const eventsMissingReceipt = recentEvents.filter((event) =>
    event.receipt_id && !receiptSet.has(event.receipt_id)
  );
  const holdsMissingLedgerEntries = recentHolds.filter((hold) =>
    numberValue(hold.held_amount_light) > 0 && !holdLedgerSet.has(hold.id)
  );
  const directEventsMissingLedgerEntries = recentEvents.filter((event) =>
    !event.hold_id &&
    numberValue(event.amount_light) > 0 &&
    !eventLedgerSet.has(event.id)
  );
  const receiptInfraMismatches = findReceiptInfraMismatches(
    recentEvents,
    receipts,
  );

  return {
    generated_at: nowIso,
    since: sinceIso,
    period_days: periodDays,
    sample_limit: limit,
    scan_limit: scanLimit,
    metrics: {
      holds_created: recentHolds.length,
      holds_held: recentHolds.filter((hold) => hold.status === "held").length,
      holds_settled: recentHolds.filter((hold) => hold.status === "settled")
        .length,
      holds_released: recentHolds.filter((hold) => hold.status === "released")
        .length,
      holds_past_expiry: expiredHolds.length,
      events_recorded: recentEvents.length,
      events_from_holds: recentEvents.filter((event) => event.hold_id).length,
      direct_events_recorded: recentEvents.filter((event) => !event.hold_id)
        .length,
      settlement_overdraw_rows: settlementOverdrawRows.length,
      settled_holds_missing_event: settledHoldsMissingEvent.length,
      settlement_events_missing_hold: settlementEventsMissingHold.length,
      events_missing_receipt: eventsMissingReceipt.length,
      holds_missing_ledger_entries: holdsMissingLedgerEntries.length,
      direct_events_missing_ledger_entries:
        directEventsMissingLedgerEntries.length,
      receipt_infra_mismatches: receiptInfraMismatches.length,
    },
    stale_holds: {
      count: expiredHolds.length,
      amount_light: sumLight(expiredHolds, (hold) => hold.held_amount_light),
      sample: expiredHolds.slice(0, limit).map(summarizeHold),
    },
    anomalies: {
      settled_holds_missing_event: settledHoldsMissingEvent.slice(0, limit)
        .map(summarizeHold),
      settlement_overdraw_rows: settlementOverdrawRows.slice(0, limit).map(
        summarizeHold,
      ),
      settlement_events_missing_hold: settlementEventsMissingHold.slice(
        0,
        limit,
      ).map(summarizeEvent),
      events_missing_receipt: eventsMissingReceipt.slice(0, limit).map(
        summarizeEvent,
      ),
      holds_missing_ledger_entries: holdsMissingLedgerEntries.slice(0, limit)
        .map(summarizeHold),
      direct_events_missing_ledger_entries: directEventsMissingLedgerEntries
        .slice(0, limit)
        .map(summarizeEvent),
      receipt_infra_mismatches: receiptInfraMismatches.slice(0, limit),
    },
  };
}

function findReceiptInfraMismatches(
  events: CloudUsageEventRow[],
  receipts: CallReceiptRow[],
): CloudUsageReconciliationReport["anomalies"]["receipt_infra_mismatches"] {
  const eventAmountsByReceipt = new Map<
    string,
    { amount_light: number; event_count: number }
  >();
  for (const event of events) {
    if (!event.receipt_id) continue;
    const existing = eventAmountsByReceipt.get(event.receipt_id) ?? {
      amount_light: 0,
      event_count: 0,
    };
    existing.amount_light += numberValue(event.amount_light);
    existing.event_count += 1;
    eventAmountsByReceipt.set(event.receipt_id, existing);
  }

  return receipts.flatMap((receipt) => {
    const eventSummary = eventAmountsByReceipt.get(receipt.id);
    if (!eventSummary) return [];
    const receiptAmount = numberValue(receipt.cloud_charge_light) ||
      numberValue(receipt.infra_charge_light);
    if (receiptAmount === 0) return [];
    const delta = eventSummary.amount_light - receiptAmount;
    if (Math.abs(delta) <= EPSILON_LIGHT) return [];
    return [{
      receipt_id: receipt.id,
      receipt_amount_light: receiptAmount,
      event_amount_light: eventSummary.amount_light,
      delta_light: delta,
      event_count: eventSummary.event_count,
    }];
  });
}

async function queryExpiredHeldHolds(
  supabase: SupabaseRequestClient,
  nowIso: string,
  limit: number,
  excludeComputeManaged = false,
): Promise<CloudUsageHoldRow[]> {
  return await queryRows<CloudUsageHoldRow>(
    supabase,
    `/rest/v1/cloud_usage_holds?status=eq.held&expires_at=not.is.null&expires_at=lte.${
      encodeFilter(nowIso)
    }${excludeComputeManaged ? "&source=neq.galactic_compute" : ""}` +
      `&select=${HOLD_SELECT}&order=expires_at.asc&limit=${limit}`,
    "expired cloud usage holds",
  );
}

async function queryRowsById<T>(
  supabase: SupabaseRequestClient,
  table: string,
  select: string,
  ids: string[],
  limit: number,
  label: string,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const encodedIds = ids.map(encodeFilter).join(",");
  return await queryRows<T>(
    supabase,
    `/rest/v1/${table}?id=in.(${encodedIds})&select=${select}&limit=${
      Math.min(limit, ids.length)
    }`,
    label,
  );
}

async function queryLedgerEntries(
  supabase: SupabaseRequestClient,
  referenceTable: string,
  referenceIds: string[],
  scanLimit: number,
): Promise<LightLedgerEntryRow[]> {
  if (referenceIds.length === 0) return [];
  const encodedIds = referenceIds.map(encodeFilter).join(",");
  return await queryRows<LightLedgerEntryRow>(
    supabase,
    `/rest/v1/light_ledger_entries?reference_table=eq.${referenceTable}&reference_id=in.(${encodedIds})&select=${LEDGER_SELECT}&limit=${
      Math.min(scanLimit, Math.max(referenceIds.length * 4, 100))
    }`,
    `${referenceTable} ledger entries`,
  );
}

async function queryRows<T>(
  supabase: SupabaseRequestClient,
  path: string,
  label: string,
): Promise<T[]> {
  const res = await supabase.request(path);
  if (!res.ok) {
    throw new Error(`Failed to query ${label}: ${await res.text()}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows as T[] : [];
}

function summarizeHold(hold: CloudUsageHoldRow): CloudUsageHoldSummary {
  return {
    id: hold.id,
    created_at: hold.created_at,
    updated_at: hold.updated_at,
    expires_at: hold.expires_at,
    status: hold.status,
    payer_user_id: hold.payer_user_id,
    app_id: hold.app_id,
    function_name: hold.function_name,
    receipt_id: hold.receipt_id,
    source: hold.source,
    resource: hold.resource,
    expected_amount_light: numberValue(hold.expected_amount_light),
    held_amount_light: numberValue(hold.held_amount_light),
    settled_amount_light: numberValue(hold.settled_amount_light),
    released_amount_light: numberValue(hold.released_amount_light),
    settlement_event_id: hold.settlement_event_id,
  };
}

function summarizeEvent(event: CloudUsageEventRow): CloudUsageEventSummary {
  return {
    id: event.id,
    created_at: event.created_at,
    payer_user_id: event.payer_user_id,
    app_id: event.app_id,
    function_name: event.function_name,
    receipt_id: event.receipt_id,
    hold_id: event.hold_id,
    source: event.source,
    resource: event.resource,
    cloud_units: numberValue(event.cloud_units),
    amount_light: numberValue(event.amount_light),
  };
}

function isBenignReleaseRace(err: unknown): boolean {
  if (!(err instanceof CloudUsageRpcError)) return false;
  if (err.rpc !== "release_cloud_usage_hold") return false;
  return /not active|not found/i.test(err.message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeDate(value: Date | string | undefined): Date {
  if (!value) return new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid cloud usage reconciliation date");
  }
  return date;
}

function normalizeLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.max(1, Math.min(Math.floor(value as number), max));
}

function normalizePeriodDays(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_REPORT_DAYS;
  return Math.max(1, Math.min(Math.floor(value as number), 365));
}

function encodeFilter(value: string): string {
  return encodeURIComponent(value);
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function numberValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sumLight<T>(rows: T[], select: (row: T) => number | null): number {
  return rows.reduce((sum, row) => sum + numberValue(select(row)), 0);
}
