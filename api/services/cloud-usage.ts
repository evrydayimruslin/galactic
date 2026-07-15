import {
  type BillingConfig,
  DEFAULT_BILLING_CONFIG,
} from "./billing-config.ts";
import { buildEconomicIdempotencyKey } from "./economic-idempotency.ts";
import { createSupabaseRestClient } from "./platform-clients/supabase-rest.ts";
import type { RoutineTraceContext } from "./routine-trace.ts";

export type CloudUsageResource =
  | "worker_execution"
  | "r2_operation"
  | "kv_operation"
  | "d1_read"
  | "d1_write"
  | "widget_pull"
  | "storage_at_rest";

export interface CloudUsageContext {
  payerUserId: string;
  source: string;
  resource: CloudUsageResource;
  sponsorUserId?: string | null;
  callerUserId?: string | null;
  ownerUserId?: string | null;
  appId?: string | null;
  functionName?: string | null;
  receiptId?: string | null;
  billingConfigVersion?: number | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CloudOperationMeteringContext {
  payerUserId: string;
  source: string;
  sponsorUserId?: string | null;
  callerUserId?: string | null;
  ownerUserId?: string | null;
  appId?: string | null;
  functionName?: string | null;
  receiptId?: string | null;
  billingConfigVersion?: number | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Trusted server-minted attribution for a persistent routine run. Routine
   * micro-operations are platform-sponsored in the launch MVP: runtime,
   * function, and AI work remain hard-budgeted, while KV/R2/D1 debits are
   * intentionally omitted so an unbounded D1 scan can never happen before its
   * budget authorization decision.
   */
  routineContext?: RoutineTraceContext | null;
  /**
   * Subscription-capacity executions collect weighted infrastructure work in
   * memory and settle it against the enclosing hard reservation. They never
   * touch the legacy wallet ledger.
   */
  capacityMeter?: { addLight: (amountLight: number) => void };
}

export interface DebitCloudOperationParams
  extends CloudOperationMeteringContext {
  resource: Extract<CloudUsageResource, "r2_operation" | "kv_operation">;
  operation: string;
  units?: number;
  billingConfig?: Pick<
    BillingConfig,
    | "version"
    | "cloudUnitLightPer1k"
    | "r2OpsPerCloudUnit"
    | "kvOpsPerCloudUnit"
  >;
  metadata?: Record<string, unknown>;
}

export interface DebitD1UsageParams extends CloudOperationMeteringContext {
  rowsRead?: number;
  rowsWritten?: number;
  operation: string;
  billingConfig?: Pick<
    BillingConfig,
    | "version"
    | "cloudUnitLightPer1k"
    | "d1ReadRowsPerCloudUnit"
    | "d1WriteRowsPerCloudUnit"
  >;
  metadata?: Record<string, unknown>;
}

export interface D1UsageDebitResult {
  rowsRead: number;
  rowsWritten: number;
  readCloudUnits: number;
  writeCloudUnits: number;
  amountLight: number;
  readEventId?: string;
  writeEventId?: string;
  events: CloudUsageDebitResult[];
}

export interface CloudUsageEventParams extends CloudUsageContext {
  units: number;
  cloudUnits: number;
  amountLight: number;
}

export interface CreateCloudUsageHoldParams extends CloudUsageContext {
  expectedUnits: number;
  expectedCloudUnits: number;
  expectedAmountLight: number;
  expiresAt?: string | null;
}

export interface SettleCloudUsageHoldParams {
  holdId: string;
  units: number;
  cloudUnits: number;
  amountLight: number;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ReleaseCloudUsageHoldParams {
  holdId: string;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CloudUsageDebitResult {
  eventId: string;
  oldBalance: number;
  newBalance: number;
  amountDebited: number;
  depositDebited: number;
  earnedDebited: number;
}

export interface CloudUsageHoldResult {
  holdId: string;
  oldBalance: number;
  newBalance: number;
  heldAmountLight: number;
  heldDepositLight: number;
  heldEarnedLight: number;
}

export interface CloudUsageHoldSettlementResult {
  eventId: string;
  holdId: string;
  settledAmountLight: number;
  releasedAmountLight: number;
}

export interface CloudUsageHoldReleaseResult {
  holdId: string;
  releasedAmountLight: number;
}

export interface RuntimeCloudHoldParams {
  callerUserId: string;
  ownerUserId: string;
  appId: string;
  functionName: string;
  receiptId?: string | null;
  source: string;
  timeoutMs: number;
  appPriceLight: number;
  freeCallLimit?: number;
  freeCallCounterKey?: string | null;
  expiresAt?: string | null;
  idempotencyKey?: string | null;
  billingConfig?: Pick<
    BillingConfig,
    | "version"
    | "workerMsPerCloudUnit"
    | "cloudUnitLightPer1k"
    | "workerLoadLightPerInvocation"
  >;
  metadata?: Record<string, unknown>;
  // Free Mode: when true the hold refuses (raises free_mode_blocked) before any
  // debit if this call would charge the caller. See docs/FREE_MODE_DESIGN.md.
  freeMode?: boolean;
}

export interface RuntimeCloudHoldResult extends CloudUsageHoldResult {
  payerUserId: string;
  sponsorUserId: string | null;
  appPriceLight: number;
  appChargeLight: number;
  freeCall: boolean;
  freeCallCount: number | null;
  freeCallLimit: number;
  expectedUnits: number;
  expectedCloudUnits: number;
  expectedAmountLight: number;
  ownerSponsoredInfra: boolean;
  callerInfraFallback: boolean;
}

export interface RuntimeCloudHoldSettlementParams {
  holdId: string;
  durationMs: number;
  idempotencyKey?: string | null;
  billingConfig?: Pick<
    BillingConfig,
    | "workerMsPerCloudUnit"
    | "cloudUnitLightPer1k"
    | "workerLoadLightPerInvocation"
  >;
  // Effective per-load floor for THIS settlement, overriding the config default.
  // Set by the per-(app,user,UTC-day) load-floor dedup (execution-settlement.ts):
  // the first execution that loads the worker each day pays the full floor;
  // later same-day calls pass 0 so the hold's reserved floor is released. Absent
  // → the config floor applies (per-call, unchanged). A negative/NaN value is
  // ignored (falls back to the config floor) so it can never zero out the floor
  // by accident.
  loadFloorLightOverride?: number;
  metadata?: Record<string, unknown>;
}

export interface RuntimeCloudHoldSettlementResult
  extends CloudUsageHoldSettlementResult {
  units: number;
  cloudUnits: number;
  amountLight: number;
}

interface CloudUsageDeps {
  fetchFn?: typeof fetch;
  logger?: Pick<Console, "warn">;
}

type RpcRow = Record<string, unknown>;

export class CloudUsageRpcError extends Error {
  readonly status: number;
  readonly rpc: string;

  constructor(rpc: string, status: number, message: string) {
    super(message);
    this.name = "CloudUsageRpcError";
    this.rpc = rpc;
    this.status = status;
  }
}

export function calculateCloudUsageLight(
  cloudUnits: number,
  cloudUnitLightPer1k = DEFAULT_BILLING_CONFIG.cloudUnitLightPer1k,
): number {
  if (!Number.isFinite(cloudUnits) || cloudUnits < 0) {
    throw new Error("Cloud units must be a non-negative finite number");
  }
  if (!Number.isFinite(cloudUnitLightPer1k) || cloudUnitLightPer1k <= 0) {
    throw new Error("Cloud unit Light rate must be a positive finite number");
  }

  return (cloudUnits * cloudUnitLightPer1k) / 1_000;
}

export const calcCloudUsageLight = calculateCloudUsageLight;

export function calcWorkerCloudUnits(
  durationMs: number,
  workerMsPerCloudUnit = DEFAULT_BILLING_CONFIG.workerMsPerCloudUnit,
): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("Worker duration must be a non-negative finite number");
  }
  if (!Number.isFinite(workerMsPerCloudUnit) || workerMsPerCloudUnit <= 0) {
    throw new Error(
      "Worker cloud unit interval must be a positive finite number",
    );
  }
  return Math.max(1, Math.ceil(durationMs / workerMsPerCloudUnit));
}

export function calcOperationCloudUnits(
  units: number,
  operationsPerCloudUnit: number,
): number {
  if (!Number.isFinite(units) || units < 0) {
    throw new Error(
      "Cloud operation units must be a non-negative finite number",
    );
  }
  if (
    !Number.isFinite(operationsPerCloudUnit) ||
    operationsPerCloudUnit <= 0
  ) {
    throw new Error(
      "Operations per cloud unit must be a positive finite number",
    );
  }
  if (units === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(units / operationsPerCloudUnit));
}

export function calcD1ReadCloudUnits(
  rowsRead: number,
  rowsPerCloudUnit = DEFAULT_BILLING_CONFIG.d1ReadRowsPerCloudUnit,
): number {
  return calcOperationCloudUnits(rowsRead, rowsPerCloudUnit);
}

export function calcD1WriteCloudUnits(
  rowsWritten: number,
  rowsPerCloudUnit = DEFAULT_BILLING_CONFIG.d1WriteRowsPerCloudUnit,
): number {
  return calcOperationCloudUnits(rowsWritten, rowsPerCloudUnit);
}

// Per-call discriminator for cloud-operation idempotency keys.
//
// The key's base parts (receipt, payer, app, function, source, resource,
// operation) identify an operation TYPE, not a call — and cloud_usage_events
// enforces a UNIQUE idempotency key, so without a discriminator every
// same-type debit after the first within one execution was silently deduped
// by the RPC (begin_economic_idempotent_operation returns the prior
// response): an app doing N ultralight.store puts paid for one. Each call now
// gets a sequence number; the first call keeps the legacy key shape so
// single-op executions look identical to historical rows.
//
// The counter is in-process state: an execution runs inside one isolate
// invocation, so per-isolate sequencing is unique per receipt. The epoch
// suffix regenerates whenever the bounded map resets, so a reset mid-receipt
// can never re-collide with keys already issued.
const CLOUD_OP_SEQUENCE_MAX_ENTRIES = 50_000;
// Lazily initialized: Workers reject scripts that generate random values in
// global scope (deploy-time validation error 10021).
let cloudOpSequenceEpoch: string | null = null;
const cloudOpSequences = new Map<string, number>();

function nextCloudOperationKey(baseKey: string | null): string | null {
  if (!baseKey) return null;
  if (cloudOpSequenceEpoch === null) {
    cloudOpSequenceEpoch = crypto.randomUUID().slice(0, 8);
  }
  if (cloudOpSequences.size >= CLOUD_OP_SEQUENCE_MAX_ENTRIES) {
    cloudOpSequences.clear();
    cloudOpSequenceEpoch = crypto.randomUUID().slice(0, 8);
  }
  const seq = cloudOpSequences.get(baseKey) ?? 0;
  cloudOpSequences.set(baseKey, seq + 1);
  return seq === 0 ? baseKey : `${baseKey}:c${cloudOpSequenceEpoch}-${seq}`;
}

export async function debitCloudOperation(
  params: DebitCloudOperationParams,
  deps?: CloudUsageDeps,
): Promise<CloudUsageDebitResult | null> {
  const units = params.units ?? 1;
  if (units === 0) {
    return null;
  }

  const config = params.billingConfig ?? DEFAULT_BILLING_CONFIG;
  const operationsPerCloudUnit = params.resource === "r2_operation"
    ? config.r2OpsPerCloudUnit
    : config.kvOpsPerCloudUnit;
  const cloudUnits = calcOperationCloudUnits(units, operationsPerCloudUnit);
  const amountLight = calculateCloudUsageLight(
    cloudUnits,
    config.cloudUnitLightPer1k,
  );

  if (params.capacityMeter) {
    params.capacityMeter.addLight(amountLight);
    return {
      eventId: `capacity:${crypto.randomUUID()}`,
      oldBalance: 0,
      newBalance: 0,
      amountDebited: amountLight,
      depositDebited: 0,
      earnedDebited: 0,
    };
  }

  // Launch invariant: routine KV/R2 micro-operations are platform-sponsored.
  // The binding calls this before touching storage, but D1 exposes row counts
  // only after executing. Applying one consistent rule across all three keeps
  // the hard routine ledger truthful without disabling persistent storage.
  if (params.routineContext) {
    return null;
  }

  return await debitCloudUsage({
    payerUserId: params.payerUserId,
    sponsorUserId: params.sponsorUserId,
    callerUserId: params.callerUserId,
    ownerUserId: params.ownerUserId,
    appId: params.appId,
    functionName: params.functionName,
    receiptId: params.receiptId,
    source: params.source,
    resource: params.resource,
    units,
    cloudUnits,
    amountLight,
    billingConfigVersion: params.billingConfigVersion ?? config.version,
    idempotencyKey: params.idempotencyKey ??
      (params.receiptId
        ? nextCloudOperationKey(buildEconomicIdempotencyKey("cloud_operation", [
          params.receiptId,
          params.payerUserId,
          params.appId,
          params.functionName,
          params.source,
          params.resource,
          params.operation,
        ]))
        : null),
    metadata: {
      ...(params.metadata ?? {}),
      operation: params.operation,
      operations_per_cloud_unit: operationsPerCloudUnit,
    },
  }, deps);
}

export async function debitD1Usage(
  params: DebitD1UsageParams,
  deps?: CloudUsageDeps,
): Promise<D1UsageDebitResult | null> {
  const rowsRead = normalizeUsageUnits(params.rowsRead ?? 0, "D1 rows read");
  const rowsWritten = normalizeUsageUnits(
    params.rowsWritten ?? 0,
    "D1 rows written",
  );

  if (rowsRead === 0 && rowsWritten === 0) {
    return null;
  }

  const config = params.billingConfig ?? DEFAULT_BILLING_CONFIG;
  const readCloudUnits = calcD1ReadCloudUnits(
    rowsRead,
    config.d1ReadRowsPerCloudUnit,
  );
  const writeCloudUnits = calcD1WriteCloudUnits(
    rowsWritten,
    config.d1WriteRowsPerCloudUnit,
  );

  if (params.capacityMeter) {
    const readAmountLight = calculateCloudUsageLight(
      readCloudUnits,
      config.cloudUnitLightPer1k,
    );
    const writeAmountLight = calculateCloudUsageLight(
      writeCloudUnits,
      config.cloudUnitLightPer1k,
    );
    const events: CloudUsageDebitResult[] = [];
    if (readAmountLight > 0) {
      events.push({
        eventId: `capacity:${crypto.randomUUID()}`,
        oldBalance: 0,
        newBalance: 0,
        amountDebited: readAmountLight,
        depositDebited: 0,
        earnedDebited: 0,
      });
    }
    if (writeAmountLight > 0) {
      events.push({
        eventId: `capacity:${crypto.randomUUID()}`,
        oldBalance: 0,
        newBalance: 0,
        amountDebited: writeAmountLight,
        depositDebited: 0,
        earnedDebited: 0,
      });
    }
    params.capacityMeter.addLight(readAmountLight + writeAmountLight);
    return {
      rowsRead,
      rowsWritten,
      readCloudUnits,
      writeCloudUnits,
      amountLight: readAmountLight + writeAmountLight,
      readEventId: events[0]?.eventId,
      writeEventId: events[readAmountLight > 0 ? 1 : 0]?.eventId,
      events,
    };
  }

  // See debitCloudOperation: D1 row cost is unknowable until the query has
  // executed, so routine D1 is deliberately non-billable for the launch MVP.
  // Runtime/app/AI charges remain admitted against the hard ceiling.
  if (params.routineContext) {
    return null;
  }

  const events: CloudUsageDebitResult[] = [];
  let readEventId: string | undefined;
  let writeEventId: string | undefined;

  if (readCloudUnits > 0) {
    const readAmountLight = calculateCloudUsageLight(
      readCloudUnits,
      config.cloudUnitLightPer1k,
    );
    const readEvent = await debitCloudUsage({
      payerUserId: params.payerUserId,
      sponsorUserId: params.sponsorUserId,
      callerUserId: params.callerUserId,
      ownerUserId: params.ownerUserId,
      appId: params.appId,
      functionName: params.functionName,
      receiptId: params.receiptId,
      source: params.source,
      resource: "d1_read",
      units: rowsRead,
      cloudUnits: readCloudUnits,
      amountLight: readAmountLight,
      billingConfigVersion: params.billingConfigVersion ?? config.version,
      idempotencyKey: params.idempotencyKey ??
        (params.receiptId
          ? buildEconomicIdempotencyKey("d1_usage", [
            params.receiptId,
            params.payerUserId,
            params.appId,
            params.functionName,
            params.source,
            params.operation,
            "read",
          ])
          : null),
      metadata: {
        ...(params.metadata ?? {}),
        operation: params.operation,
        rows_per_cloud_unit: config.d1ReadRowsPerCloudUnit,
      },
    }, deps);
    readEventId = readEvent.eventId;
    events.push(readEvent);
  }

  if (writeCloudUnits > 0) {
    const writeAmountLight = calculateCloudUsageLight(
      writeCloudUnits,
      config.cloudUnitLightPer1k,
    );
    const writeEvent = await debitCloudUsage({
      payerUserId: params.payerUserId,
      sponsorUserId: params.sponsorUserId,
      callerUserId: params.callerUserId,
      ownerUserId: params.ownerUserId,
      appId: params.appId,
      functionName: params.functionName,
      receiptId: params.receiptId,
      source: params.source,
      resource: "d1_write",
      units: rowsWritten,
      cloudUnits: writeCloudUnits,
      amountLight: writeAmountLight,
      billingConfigVersion: params.billingConfigVersion ?? config.version,
      idempotencyKey: params.idempotencyKey ??
        (params.receiptId
          ? buildEconomicIdempotencyKey("d1_usage", [
            params.receiptId,
            params.payerUserId,
            params.appId,
            params.functionName,
            params.source,
            params.operation,
            "write",
          ])
          : null),
      metadata: {
        ...(params.metadata ?? {}),
        operation: params.operation,
        rows_per_cloud_unit: config.d1WriteRowsPerCloudUnit,
      },
    }, deps);
    writeEventId = writeEvent.eventId;
    events.push(writeEvent);
  }

  return {
    rowsRead,
    rowsWritten,
    readCloudUnits,
    writeCloudUnits,
    amountLight: events.reduce((sum, event) => sum + event.amountDebited, 0),
    readEventId,
    writeEventId,
    events,
  };
}

export async function createRuntimeCloudHold(
  params: RuntimeCloudHoldParams,
  deps?: CloudUsageDeps,
): Promise<RuntimeCloudHoldResult> {
  const config = params.billingConfig ?? DEFAULT_BILLING_CONFIG;
  const expectedUnits = params.timeoutMs;
  const expectedCloudUnits = calcWorkerCloudUnits(
    params.timeoutMs,
    config.workerMsPerCloudUnit,
  );
  // Fixed per-load floor (recovers Cloudflare's Dynamic Worker per-load fee, which
  // the duration meter structurally cannot). Added to the RESERVED amount so the
  // existing infra cascade (owner-sponsor → caller → block) routes it exactly like
  // the duration cost — no new branching. Default 0 = behavior-preserving.
  const expectedAmountLight = calculateCloudUsageLight(
    expectedCloudUnits,
    config.cloudUnitLightPer1k,
  ) + (config.workerLoadLightPerInvocation ?? 0);

  const row = await callCloudUsageRpcRow("create_app_call_runtime_cloud_hold", {
    p_caller_user_id: params.callerUserId,
    p_owner_user_id: params.ownerUserId,
    p_app_id: params.appId,
    p_function_name: params.functionName,
    p_receipt_id: params.receiptId ?? null,
    p_source: params.source,
    p_expected_units: expectedUnits,
    p_expected_cloud_units: expectedCloudUnits,
    p_expected_amount_light: expectedAmountLight,
    p_app_price_light: params.appPriceLight,
    p_free_call_limit: params.freeCallLimit ?? 0,
    p_free_call_counter_key: params.freeCallCounterKey ?? null,
    p_expires_at: params.expiresAt ?? null,
    p_billing_config_version: config.version ?? null,
    p_metadata: params.metadata ?? {},
    p_idempotency_key: params.idempotencyKey ??
      buildEconomicIdempotencyKey("runtime_cloud_hold", [
        params.receiptId,
        params.callerUserId,
        params.ownerUserId,
        params.appId,
        params.functionName,
        params.source,
      ]),
    // Only send p_free_mode when it's actually on, so a 16-arg call still matches
    // the function across the migration boundary (the new fn fills the default).
    // This removes any API-vs-migration deploy-ordering constraint.
    ...(params.freeMode ? { p_free_mode: true } : {}),
  }, deps);

  const payerUserId = requiredString(row.payer_user_id, "payer_user_id");
  const sponsorUserId = optionalString(row.sponsor_user_id, "sponsor_user_id");
  const freeCall = requiredBoolean(row.free_call, "free_call");
  return {
    holdId: requiredString(row.hold_id, "hold_id"),
    payerUserId,
    sponsorUserId,
    appPriceLight: requiredNumber(row.app_price_light, "app_price_light"),
    appChargeLight: requiredNumber(row.app_charge_light, "app_charge_light"),
    freeCall,
    freeCallCount: optionalNumber(row.free_call_count, "free_call_count"),
    freeCallLimit: requiredNumber(row.free_call_limit, "free_call_limit"),
    oldBalance: requiredNumber(row.old_balance, "old_balance"),
    newBalance: requiredNumber(row.new_balance, "new_balance"),
    heldAmountLight: requiredNumber(row.held_amount_light, "held_amount_light"),
    heldDepositLight: requiredNumber(
      row.held_deposit_light,
      "held_deposit_light",
    ),
    heldEarnedLight: requiredNumber(row.held_earned_light, "held_earned_light"),
    expectedUnits,
    expectedCloudUnits,
    expectedAmountLight,
    ownerSponsoredInfra: sponsorUserId !== null &&
      sponsorUserId === params.ownerUserId,
    callerInfraFallback: freeCall &&
      sponsorUserId === null &&
      payerUserId === params.callerUserId &&
      params.callerUserId !== params.ownerUserId,
  };
}

/**
 * Read-only peek of a caller's free-allowance counters for one app (Free Mode
 * Phase 3, docs/FREE_MODE_DESIGN.md). Returns a map of counter_key -> call_count
 * so discovery can tell whether a priced function still has free-call headroom
 * for this caller. No mutation, no hold — purely informational.
 *
 * Fails by returning an empty map only via the caller's `.catch()`; on an RPC
 * error this throws `CloudUsageRpcError` like every other RPC here, leaving the
 * fail-open decision to the discovery callers (which treat "no usage data" as
 * "no allowance granted" — the conservative Phase-2 behaviour).
 */
export async function peekCallerUsage(
  appId: string,
  userId: string,
  deps?: CloudUsageDeps,
): Promise<Map<string, number>> {
  const payload = await callCloudUsageRpc("peek_app_caller_usage", {
    p_app_id: appId,
    p_user_id: userId,
  }, deps);
  const map = new Map<string, number>();
  const rows = Array.isArray(payload) ? payload : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = (row as RpcRow).counter_key;
    if (typeof key !== "string") continue;
    const count = Number((row as RpcRow).call_count);
    map.set(key, Number.isFinite(count) ? count : 0);
  }
  return map;
}

export async function settleRuntimeCloudHold(
  params: RuntimeCloudHoldSettlementParams,
  deps?: CloudUsageDeps,
): Promise<RuntimeCloudHoldSettlementResult> {
  const config = params.billingConfig ?? DEFAULT_BILLING_CONFIG;
  const units = params.durationMs;
  const cloudUnits = calcWorkerCloudUnits(
    params.durationMs,
    config.workerMsPerCloudUnit,
  );
  // The per-load floor is a FIXED cost — it must survive the duration true-down,
  // so add it to the settled amount too (matching the hold). Uses the same pinned
  // billing-config version as the hold, so the floor is identical on both sides.
  // An explicit per-day override (>= 0 and finite) wins; anything else falls back
  // to the config floor (never leaks it to 0 on a bad value).
  const override = params.loadFloorLightOverride;
  const loadFloorLight =
    typeof override === "number" && Number.isFinite(override) && override >= 0
      ? override
      : (config.workerLoadLightPerInvocation ?? 0);
  const amountLight = calculateCloudUsageLight(
    cloudUnits,
    config.cloudUnitLightPer1k,
  ) + loadFloorLight;
  const settlement = await settleCloudUsageHold({
    holdId: params.holdId,
    units,
    cloudUnits,
    amountLight,
    idempotencyKey: params.idempotencyKey ??
      buildEconomicIdempotencyKey("runtime_cloud_settlement", [
        params.holdId,
      ]),
    metadata: params.metadata,
  }, deps);

  return {
    ...settlement,
    units,
    cloudUnits,
    amountLight,
  };
}

export async function recordCloudUsageEvent(
  params: CloudUsageEventParams,
  deps?: CloudUsageDeps,
): Promise<string> {
  const payload = await callCloudUsageRpc(
    "record_cloud_usage_event",
    eventBody(params, false),
    deps,
  );
  if (typeof payload === "string") {
    return payload;
  }
  if (Array.isArray(payload) && typeof payload[0] === "string") {
    return payload[0];
  }
  if (Array.isArray(payload) && payload[0] && typeof payload[0] === "object") {
    const row = payload[0] as RpcRow;
    if (typeof row.record_cloud_usage_event === "string") {
      return row.record_cloud_usage_event;
    }
  }
  throw new Error("record_cloud_usage_event returned no event id");
}

export async function debitCloudUsage(
  params: CloudUsageEventParams,
  deps?: CloudUsageDeps,
): Promise<CloudUsageDebitResult> {
  const idempotencyKey = params.idempotencyKey ??
    (params.receiptId
      ? buildEconomicIdempotencyKey("cloud_usage_debit", [
        params.receiptId,
        params.payerUserId,
        params.appId,
        params.functionName,
        params.source,
        params.resource,
      ])
      : null);
  const row = await callCloudUsageRpcRow(
    "debit_cloud_usage",
    eventBody({ ...params, idempotencyKey }, true),
    deps,
  );
  return {
    eventId: requiredString(row.event_id, "event_id"),
    oldBalance: requiredNumber(row.old_balance, "old_balance"),
    newBalance: requiredNumber(row.new_balance, "new_balance"),
    amountDebited: requiredNumber(row.amount_debited, "amount_debited"),
    depositDebited: requiredNumber(row.deposit_debited, "deposit_debited"),
    earnedDebited: requiredNumber(row.earned_debited, "earned_debited"),
  };
}

export async function createCloudUsageHold(
  params: CreateCloudUsageHoldParams,
  deps?: CloudUsageDeps,
): Promise<CloudUsageHoldResult> {
  const idempotencyKey = params.idempotencyKey ??
    (params.receiptId
      ? buildEconomicIdempotencyKey("cloud_usage_hold", [
        params.receiptId,
        params.payerUserId,
        params.appId,
        params.functionName,
        params.source,
        params.resource,
      ])
      : null);
  const row = await callCloudUsageRpcRow(
    "create_cloud_usage_hold",
    holdBody({ ...params, idempotencyKey }),
    deps,
  );
  return {
    holdId: requiredString(row.hold_id, "hold_id"),
    oldBalance: requiredNumber(row.old_balance, "old_balance"),
    newBalance: requiredNumber(row.new_balance, "new_balance"),
    heldAmountLight: requiredNumber(row.held_amount_light, "held_amount_light"),
    heldDepositLight: requiredNumber(
      row.held_deposit_light,
      "held_deposit_light",
    ),
    heldEarnedLight: requiredNumber(row.held_earned_light, "held_earned_light"),
  };
}

export async function settleCloudUsageHold(
  params: SettleCloudUsageHoldParams,
  deps?: CloudUsageDeps,
): Promise<CloudUsageHoldSettlementResult> {
  let row: RpcRow;
  try {
    row = await callCloudUsageRpcRow("settle_cloud_usage_hold", {
      p_hold_id: params.holdId,
      p_units: params.units,
      p_cloud_units: params.cloudUnits,
      p_amount_light: params.amountLight,
      p_metadata: params.metadata ?? {},
      p_idempotency_key: params.idempotencyKey ??
        buildEconomicIdempotencyKey("cloud_hold_settlement", [
          params.holdId,
        ]),
    }, deps);
  } catch (err) {
    if (
      err instanceof CloudUsageRpcError &&
      /settlement exceeds held amount/i.test(err.message)
    ) {
      (deps?.logger ?? console).warn(
        "[USAGE] Cloud usage hold settlement exceeded held amount",
        {
          hold_id: params.holdId,
          amount_light: params.amountLight,
          units: params.units,
          cloud_units: params.cloudUnits,
          error: err.message,
        },
      );
    }
    throw err;
  }

  return {
    eventId: requiredString(row.event_id, "event_id"),
    holdId: requiredString(row.hold_id, "hold_id"),
    settledAmountLight: requiredNumber(
      row.settled_amount_light,
      "settled_amount_light",
    ),
    releasedAmountLight: requiredNumber(
      row.released_amount_light,
      "released_amount_light",
    ),
  };
}

export async function releaseCloudUsageHold(
  params: ReleaseCloudUsageHoldParams,
  deps?: CloudUsageDeps,
): Promise<CloudUsageHoldReleaseResult> {
  const row = await callCloudUsageRpcRow("release_cloud_usage_hold", {
    p_hold_id: params.holdId,
    p_metadata: params.metadata ?? {},
    p_idempotency_key: params.idempotencyKey ??
      buildEconomicIdempotencyKey("cloud_hold_release", [
        params.holdId,
      ]),
  }, deps);

  return {
    holdId: requiredString(row.hold_id, "hold_id"),
    releasedAmountLight: requiredNumber(
      row.released_amount_light,
      "released_amount_light",
    ),
  };
}

function eventBody(
  params: CloudUsageEventParams,
  includeIdempotencyKey: boolean,
): RpcRow {
  const body: RpcRow = {
    ...contextBody(params),
    p_units: params.units,
    p_cloud_units: params.cloudUnits,
    p_amount_light: params.amountLight,
  };
  if (includeIdempotencyKey) {
    body.p_idempotency_key = params.idempotencyKey ?? null;
  }
  return body;
}

function holdBody(params: CreateCloudUsageHoldParams): RpcRow {
  return {
    ...contextBody(params),
    p_expected_units: params.expectedUnits,
    p_expected_cloud_units: params.expectedCloudUnits,
    p_expected_amount_light: params.expectedAmountLight,
    p_expires_at: params.expiresAt ?? null,
    p_idempotency_key: params.idempotencyKey ?? null,
  };
}

function contextBody(params: CloudUsageContext): RpcRow {
  return {
    p_payer_user_id: params.payerUserId,
    p_source: params.source,
    p_resource: params.resource,
    p_sponsor_user_id: params.sponsorUserId ?? null,
    p_caller_user_id: params.callerUserId ?? null,
    p_owner_user_id: params.ownerUserId ?? null,
    p_app_id: params.appId ?? null,
    p_function_name: params.functionName ?? null,
    p_receipt_id: params.receiptId ?? null,
    p_billing_config_version: params.billingConfigVersion ?? null,
    p_metadata: params.metadata ?? {},
  };
}

async function callCloudUsageRpcRow(
  rpc: string,
  body: RpcRow,
  deps?: CloudUsageDeps,
): Promise<RpcRow> {
  const payload = await callCloudUsageRpc(rpc, body, deps);
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row || typeof row !== "object") {
    throw new Error(`${rpc} returned no rows`);
  }
  return row as RpcRow;
}

async function callCloudUsageRpc(
  rpc: string,
  body: RpcRow,
  deps?: CloudUsageDeps,
): Promise<unknown> {
  const supabase = createSupabaseRestClient({ fetchFn: deps?.fetchFn });
  const res = await supabase.rpc(rpc, body);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new CloudUsageRpcError(
      rpc,
      res.status,
      detail || `${rpc} failed with status ${res.status}`,
    );
  }

  const text = await res.text();
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Cloud usage RPC response missing ${field}`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Cloud usage RPC response missing ${field}`);
  }
  return value;
}

function normalizeUsageUnits(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return Math.ceil(value);
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Cloud usage RPC response invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Cloud usage RPC response invalid ${field}`);
  }
  return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Cloud usage RPC response missing ${field}`);
  }
  return value;
}
