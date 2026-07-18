import { getEnv } from "../lib/env.ts";
import { type BillingConfig, getBillingConfig } from "./billing-config.ts";
import type { CapacityResourceFact } from "./cloud-usage.ts";
import { buildEconomicIdempotencyKey } from "./economic-idempotency.ts";

export type AccountPlanCode = "free" | "pro" | "max_5x" | "max_10x";
export type AccountCapacityState = "available" | "low" | "waiting";

export interface AccountCapacityStatus {
  planCode: AccountPlanCode;
  state: AccountCapacityState;
  activeAgentLimit: number | null;
  burst: {
    state: AccountCapacityState;
    resetsAt: string;
    usedPercent?: number;
    remainingLight?: number;
    limitLight?: number;
  };
  weekly: {
    state: AccountCapacityState;
    resetsAt: string;
    usedPercent?: number;
    remainingLight?: number;
    limitLight?: number;
  };
  nextEligibleAt: string | null;
  limitsPublic: boolean;
}

export type AccountCapacityAdmissionCode =
  | "ok"
  | "capacity_waiting"
  | "agent_cap_waiting"
  | "agent_cap_too_low_for_request"
  | "concurrency_waiting"
  | "released"
  | "expired";

type AccountCapacityConcurrencyScope =
  | "account"
  | "agent"
  | "ai"
  | "routine";

export interface AgentCapacityAdmissionDetails {
  agentId: string;
  capBasisPoints: number;
  bindingConstraint: "account" | "agent" | null;
  burstRemainingLight?: number;
  weeklyRemainingLight?: number;
}

export interface AccountCapacityAdmission extends AccountCapacityStatus {
  allowed: boolean;
  code: AccountCapacityAdmissionCode;
  reservationId: string | null;
  agentCapacity: AgentCapacityAdmissionDetails | null;
  concurrencyScope: AccountCapacityConcurrencyScope | null;
}

/**
 * Economic capacity is settled from observed resource facts. Admission holds
 * no hypothetical timeout cost: bounded distributed concurrency is the
 * in-flight exposure guard, and the final admitted invocation may cross the
 * settled window before subsequent work waits.
 */
export const ACCOUNT_CAPACITY_ADMISSION_EXPOSURE_LIGHT = 0;

export interface CapacityResourceSettlement {
  settlementId: string;
  reservationId: string;
  status: "pending_cpu" | "observed" | "final";
  immediateLight: number;
  operationLight: number;
  workerRequestLight: number;
  dynamicWorkerLight: number;
  cpuLight: number;
  totalLight: number;
  dynamicWorkerCharged: boolean;
  billingConfigVersion: number;
}

interface CapacityCpuObservation {
  observationId: string;
  applicationStatus: "pending" | "applied";
  settlementId: string | null;
  eventId: string | null;
  inserted: boolean;
  settlementStatus: "pending_cpu" | "observed" | "final" | null;
  cpuTimeMs: number;
  wallTimeMs: number | null;
  cpuLight: number;
  totalLight: number;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

type CapacityCpuSource =
  | "cloudflare_tail_parent"
  | "cloudflare_dynamic_tail";

export interface AgentCapacityStatus {
  agentId: string;
  planCode: AccountPlanCode;
  state: AccountCapacityState;
  /** Null on the customer-facing Free surface; Free is fixed at 100%. */
  capBasisPoints: number | null;
  burst: {
    state: AccountCapacityState;
    resetsAt: string;
    usedPercent?: number;
    remainingLight?: number;
    limitLight?: number;
  };
  weekly: {
    state: AccountCapacityState;
    resetsAt: string;
    usedPercent?: number;
    remainingLight?: number;
    limitLight?: number;
  };
  nextEligibleAt: string | null;
  limitsPublic: boolean;
}

interface AgentActivationSlotDecision {
  allowed: boolean;
  code: "ok" | "active_agent_limit";
  activeAgentLimit: number | null;
  occupiedBy: string | null;
}

interface DeferredRoutineWake {
  routineId: string;
  userId: string;
  firstDeferredAt: string;
  latestDeferredAt: string;
  deferredWakeCount: number;
  nextEligibleAt: string;
  manualRequested: boolean;
}

interface CapacityDeps {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  serviceRoleKey?: string;
  /** Test/rollout override. Production defaults to AGENT_CAPACITY_ENABLED. */
  agentCapacityEnabled?: boolean;
}

interface CapacityRpcRow {
  allowed?: boolean;
  code?: string;
  reservation_id?: string | null;
  plan_code?: string;
  limits_public?: boolean;
  active_agent_limit?: number | null;
  capacity_state?: string;
  burst_resets_at?: string;
  weekly_resets_at?: string;
  burst_state?: string;
  weekly_state?: string;
  next_eligible_at?: string | null;
  burst_remaining_light?: number;
  weekly_remaining_light?: number;
  burst_limit_light?: number;
  burst_used_light?: number;
  weekly_limit_light?: number;
  weekly_used_light?: number;
  occupied_by?: string | null;
  capacity_agent_id?: string | null;
  agent_cap_basis_points?: number;
  binding_constraint?: string | null;
  agent_burst_remaining_light?: number;
  agent_weekly_remaining_light?: number;
  agent_burst_limit_light?: number;
  agent_burst_used_light?: number;
  agent_weekly_limit_light?: number;
  agent_weekly_used_light?: number;
  concurrency_scope?: string | null;
  settlement_id?: string;
  status?: string;
  immediate_light?: number;
  operation_light?: number;
  worker_request_light?: number;
  dynamic_worker_light?: number;
  cpu_light?: number;
  total_light?: number;
  dynamic_worker_charged?: boolean;
  billing_config_version?: number;
  event_id?: string;
  inserted?: boolean;
  cpu_time_ms?: number;
  wall_time_ms?: number | null;
  observation_id?: string;
  application_status?: string;
  settlement_status?: string | null;
  attempts?: number;
  next_attempt_at?: string | null;
  last_error?: string | null;
  reconciled?: boolean;
  delta_light?: number;
}

function agentCapacityEnabled(deps: CapacityDeps): boolean {
  return deps.agentCapacityEnabled ?? getEnv("AGENT_CAPACITY_ENABLED") === "1";
}

function rpc(
  name: string,
  body: Record<string, unknown>,
  deps: CapacityDeps,
): Promise<Response> {
  const baseUrl = deps.supabaseUrl ?? getEnv("SUPABASE_URL");
  const key = deps.serviceRoleKey ?? getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !key) {
    throw new Error("Account capacity database is not configured");
  }
  return (deps.fetchFn ?? fetch)(
    `${baseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${name}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

async function rpcRow(
  name: string,
  body: Record<string, unknown>,
  deps: CapacityDeps,
): Promise<CapacityRpcRow> {
  const response = await rpc(name, body, deps);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Account capacity ${name} failed (${response.status}): ${detail}`,
    );
  }
  const payload = await response.json().catch(() => null);
  const row = (Array.isArray(payload) ? payload[0] : payload) as
    | CapacityRpcRow
    | null;
  if (!row) throw new Error(`Account capacity ${name} returned no decision`);
  return row;
}

function planCode(value: unknown): AccountPlanCode {
  if (
    value === "free" || value === "pro" || value === "max_5x" ||
    value === "max_10x"
  ) {
    return value;
  }
  throw new Error("Account capacity returned an invalid plan");
}

function capacityState(value: unknown): AccountCapacityState {
  if (value === "available" || value === "low" || value === "waiting") {
    return value;
  }
  throw new Error("Account capacity returned an invalid state");
}

function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Account capacity returned invalid ${field}`);
  }
  return value;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function percent(used: number, limit: number): number {
  if (limit <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

function statusFromRow(
  row: CapacityRpcRow,
  exposeInternalLimits: boolean,
): AccountCapacityStatus {
  const resolvedPlan = planCode(row.plan_code);
  const limitsPublic = row.limits_public === true;
  const burstLimit = finite(row.burst_limit_light);
  const weeklyLimit = finite(row.weekly_limit_light);
  const burstUsed = finite(row.burst_used_light);
  const weeklyUsed = finite(row.weekly_used_light);
  const reveal = exposeInternalLimits || limitsPublic;
  // Free's exact allowance is intentionally unpublished. Paid owners still
  // need the familiar percentage meter to understand shared capacity, while
  // raw Light limits/remaining amounts remain internal calibration data.
  const revealPercent = resolvedPlan !== "free" || reveal;
  return {
    planCode: resolvedPlan,
    state: capacityState(row.capacity_state),
    activeAgentLimit: Number.isInteger(row.active_agent_limit)
      ? Number(row.active_agent_limit)
      : null,
    burst: {
      state: capacityState(row.burst_state ?? row.capacity_state),
      resetsAt: iso(row.burst_resets_at, "burst reset"),
      ...(revealPercent ? { usedPercent: percent(burstUsed, burstLimit) } : {}),
      ...(reveal
        ? {
          remainingLight: Math.max(0, burstLimit - burstUsed),
          limitLight: burstLimit,
        }
        : {}),
    },
    weekly: {
      state: capacityState(row.weekly_state ?? row.capacity_state),
      resetsAt: iso(row.weekly_resets_at, "weekly reset"),
      ...(revealPercent
        ? { usedPercent: percent(weeklyUsed, weeklyLimit) }
        : {}),
      ...(reveal
        ? {
          remainingLight: Math.max(0, weeklyLimit - weeklyUsed),
          limitLight: weeklyLimit,
        }
        : {}),
    },
    nextEligibleAt: typeof row.next_eligible_at === "string"
      ? row.next_eligible_at
      : null,
    limitsPublic,
  };
}

export async function getAccountCapacityStatus(
  userId: string,
  options: { now?: string; exposeInternalLimits?: boolean } = {},
  deps: CapacityDeps = {},
): Promise<AccountCapacityStatus> {
  const row = await rpcRow("get_account_capacity_status", {
    p_user_id: userId,
    ...(options.now ? { p_now: options.now } : {}),
  }, deps);
  return statusFromRow(row, options.exposeInternalLimits === true);
}

export async function reserveAccountCapacity(input: {
  userId: string;
  /**
   * The signed root/origin Agent responsible for this work. Direct calls use
   * the target Agent. It becomes authoritative when AGENT_CAPACITY_ENABLED=1.
   */
  capacityAgentId?: string;
  idempotencyKey: string;
  reserveLight: number;
  expiresAt: string;
  metadata?: Record<string, unknown>;
  /** Used only by the distributed account AI-concurrency guard. */
  usesInference?: boolean;
  /** A persistent routine has one in-flight wake regardless of call fan-out. */
  routineId?: string | null;
  /** Reservations in the same wake share its routine concurrency lease. */
  routineRunId?: string | null;
  now?: string;
}, deps: CapacityDeps = {}): Promise<AccountCapacityAdmission> {
  if (!input.idempotencyKey.trim()) {
    throw new Error("Capacity idempotency key is required");
  }
  if (!Number.isFinite(input.reserveLight) || input.reserveLight < 0) {
    throw new Error("Capacity reservation must be finite and non-negative");
  }
  const enforceAgentCapacity = agentCapacityEnabled(deps);
  const capacityAgentId = input.capacityAgentId?.trim() || "";
  if (enforceAgentCapacity && !capacityAgentId) {
    throw new Error(
      "Capacity Agent attribution is required while Agent capacity enforcement is enabled",
    );
  }
  const row = await rpcRow(
    enforceAgentCapacity
      ? "reserve_account_capacity_v3"
      : "reserve_account_capacity",
    {
      p_user_id: input.userId,
      ...(enforceAgentCapacity ? { p_capacity_agent_id: capacityAgentId } : {}),
      ...(enforceAgentCapacity
        ? {
          p_uses_inference: input.usesInference === true,
          p_routine_id: input.routineId?.trim() || null,
          p_routine_run_id: input.routineRunId?.trim() || null,
        }
        : {}),
      p_idempotency_key: input.idempotencyKey,
      p_reserve_light: input.reserveLight,
      p_expires_at: input.expiresAt,
      p_metadata: input.metadata ?? {},
      ...(input.now ? { p_now: input.now } : {}),
    },
    deps,
  );
  const knownCodes: AccountCapacityAdmissionCode[] = [
    "ok",
    "capacity_waiting",
    "agent_cap_waiting",
    "agent_cap_too_low_for_request",
    "concurrency_waiting",
    "released",
    "expired",
  ];
  const code = knownCodes.includes(row.code as AccountCapacityAdmissionCode)
    ? row.code as AccountCapacityAdmissionCode
    : "capacity_waiting";
  const burstRemaining = finite(row.burst_remaining_light);
  const weeklyRemaining = finite(row.weekly_remaining_light);
  return {
    allowed: row.allowed === true,
    code,
    reservationId: typeof row.reservation_id === "string"
      ? row.reservation_id
      : null,
    planCode: planCode(row.plan_code),
    state: capacityState(row.capacity_state),
    activeAgentLimit: null,
    burst: {
      state: capacityState(row.burst_state ?? row.capacity_state),
      resetsAt: iso(row.burst_resets_at, "burst reset"),
      remainingLight: burstRemaining,
    },
    weekly: {
      state: capacityState(row.weekly_state ?? row.capacity_state),
      resetsAt: iso(row.weekly_resets_at, "weekly reset"),
      remainingLight: weeklyRemaining,
    },
    nextEligibleAt: typeof row.next_eligible_at === "string"
      ? row.next_eligible_at
      : null,
    limitsPublic: false,
    agentCapacity: typeof row.capacity_agent_id === "string"
      ? {
        agentId: row.capacity_agent_id,
        capBasisPoints: Number.isInteger(row.agent_cap_basis_points)
          ? Number(row.agent_cap_basis_points)
          : 10_000,
        bindingConstraint: row.binding_constraint === "account" ||
            row.binding_constraint === "agent"
          ? row.binding_constraint
          : null,
        ...(Number.isFinite(row.agent_burst_remaining_light)
          ? { burstRemainingLight: Number(row.agent_burst_remaining_light) }
          : {}),
        ...(Number.isFinite(row.agent_weekly_remaining_light)
          ? { weeklyRemainingLight: Number(row.agent_weekly_remaining_light) }
          : {}),
      }
      : null,
    concurrencyScope: row.concurrency_scope === "account" ||
        row.concurrency_scope === "agent" ||
        row.concurrency_scope === "ai" ||
        row.concurrency_scope === "routine"
      ? row.concurrency_scope
      : null,
  };
}

function resourceStatus(
  value: unknown,
): CapacityResourceSettlement["status"] {
  if (value === "pending_cpu" || value === "observed" || value === "final") {
    return value;
  }
  throw new Error("Capacity resource settlement returned an invalid status");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Capacity resource settlement returned invalid ${field}`);
  }
  return value;
}

function nonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Capacity resource settlement returned invalid ${field}`);
  }
  return value;
}

function normalizeResourceFacts(
  facts: CapacityResourceFact[] | undefined,
): CapacityResourceFact[] {
  return (facts ?? []).map((fact) => {
    if (
      !Number.isFinite(fact.units) || fact.units < 0 ||
      !Number.isFinite(fact.cloudUnits) || fact.cloudUnits < 0 ||
      !Number.isFinite(fact.amountLight) || fact.amountLight < 0
    ) {
      throw new Error(
        "Capacity resource facts must be finite and non-negative",
      );
    }
    return {
      resource: fact.resource,
      units: fact.units,
      cloudUnits: fact.cloudUnits,
      amountLight: fact.amountLight,
      ...(fact.metadata ? { metadata: fact.metadata } : {}),
    };
  });
}

/**
 * Settle immediately knowable marginal cost and leave CPU pending for the Tail
 * observation. `reuseKeyHash` identifies a stable Dynamic Worker and charges
 * its floor once per UTC day; absence means loader.load fallback and therefore
 * a real per-call creation charge.
 */
export interface SettleAccountCapacityResourcesInput {
  reservationId: string;
  userId: string;
  receiptId: string;
  executionId?: string | null;
  /** Pinned execution timestamp; durable replay must preserve this instant. */
  executedAt: string;
  resourceFacts?: CapacityResourceFact[];
  /** Compatibility input for an aggregate whose raw facts are unavailable. */
  operationLight?: number;
  workerRequestCount?: number;
  /** False when Loader never returned a potentially billable identity. */
  dynamicWorkerIdentityCreated?: boolean;
  /** False when execution stopped before a Dynamic Worker fetch attempt. */
  dynamicWorkerInvoked?: boolean;
  reuseKeyHash?: string | null;
  billingConfig?: Pick<
    BillingConfig,
    | "version"
    | "workerMsPerCloudUnit"
    | "cloudUnitLightPer1k"
    | "workerRequestLightPerInvocation"
    | "workerLoadLightPerInvocation"
  >;
  metadata?: Record<string, unknown>;
}

export async function settleAccountCapacityResources(
  input: SettleAccountCapacityResourcesInput,
  deps: CapacityDeps = {},
): Promise<CapacityResourceSettlement> {
  if (!input.reservationId.trim()) {
    throw new Error("Reservation id is required");
  }
  if (!input.receiptId.trim()) throw new Error("Receipt id is required");
  const facts = normalizeResourceFacts(input.resourceFacts);
  const factsLight = facts.reduce((sum, fact) => sum + fact.amountLight, 0);
  const aggregateLight = input.operationLight ?? 0;
  if (!Number.isFinite(aggregateLight) || aggregateLight < 0) {
    throw new Error("Operation Light must be finite and non-negative");
  }
  const requestCount = input.workerRequestCount ?? 1;
  if (
    !Number.isSafeInteger(requestCount) || requestCount < 0
  ) {
    throw new Error(
      "Worker request count must be a finite non-negative integer",
    );
  }
  const executedAtMs = Date.parse(input.executedAt);
  if (!Number.isFinite(executedAtMs)) {
    throw new Error("Capacity execution timestamp must be valid");
  }
  const executedAt = new Date(executedAtMs).toISOString();
  const config = input.billingConfig ?? await getBillingConfig();
  const dynamicWorkerInvoked = input.dynamicWorkerInvoked !== false;
  const dynamicWorkerIdentityCreated = input.dynamicWorkerIdentityCreated ??
    dynamicWorkerInvoked;
  if (dynamicWorkerInvoked && !dynamicWorkerIdentityCreated) {
    throw new Error("Dynamic Worker request requires a created identity");
  }
  const expectedCpuSources: CapacityCpuSource[] = dynamicWorkerInvoked
    ? ["cloudflare_tail_parent", "cloudflare_dynamic_tail"]
    : ["cloudflare_tail_parent"];
  const response = await rpc("settle_account_capacity_resources", {
    p_reservation_id: input.reservationId,
    p_user_id: input.userId,
    p_receipt_id: input.receiptId,
    p_execution_id: input.executionId?.trim() || null,
    p_operation_light: factsLight + aggregateLight,
    p_worker_request_count: requestCount,
    p_worker_identity_hash: dynamicWorkerIdentityCreated
      ? input.reuseKeyHash?.trim() || null
      : null,
    p_worker_load_mode: !dynamicWorkerIdentityCreated
      ? "none"
      : input.reuseKeyHash?.trim()
      ? "reuse"
      : "load",
    p_worker_request_light_per_invocation:
      config.workerRequestLightPerInvocation,
    p_worker_load_light: dynamicWorkerIdentityCreated
      ? config.workerLoadLightPerInvocation
      : 0,
    p_worker_ms_per_cloud_unit: config.workerMsPerCloudUnit,
    p_cloud_unit_light_per_1k: config.cloudUnitLightPer1k,
    p_billing_config_version: config.version,
    p_executed_at: executedAt,
    p_dynamic_worker_invoked: dynamicWorkerInvoked,
    p_expected_cpu_sources: expectedCpuSources,
    p_resource_facts: facts,
    p_metadata: input.metadata ?? {},
  }, deps);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to settle account capacity resources (${response.status}): ${detail}`,
    );
  }
  const payload = await response.json().catch(() => null);
  const row = (Array.isArray(payload) ? payload[0] : payload) as
    | CapacityRpcRow
    | null;
  if (!row) throw new Error("Capacity resource settlement returned no row");
  return {
    settlementId: requiredString(row.settlement_id, "settlement id"),
    reservationId: input.reservationId,
    status: resourceStatus(row.status),
    immediateLight: nonNegative(row.immediate_light, "immediate Light"),
    operationLight: nonNegative(row.operation_light, "operation Light"),
    workerRequestLight: nonNegative(
      row.worker_request_light,
      "worker request Light",
    ),
    dynamicWorkerLight: nonNegative(
      row.dynamic_worker_light,
      "Dynamic Worker Light",
    ),
    cpuLight: nonNegative(row.cpu_light, "CPU Light"),
    totalLight: nonNegative(row.total_light, "total Light"),
    dynamicWorkerCharged: row.dynamic_worker_charged === true,
    billingConfigVersion: Number.isInteger(row.billing_config_version)
      ? Number(row.billing_config_version)
      : config.version,
  };
}

interface CapacityAttributionReconciliation {
  reconciled: boolean;
  totalLight: number;
  deltaLight: number;
}

/**
 * Reconcile an authoritative resource settlement into its receipt and any
 * routine accounting sinks. `reconciled=false` is a normal short race while
 * the request path is still persisting its receipt/step and must be retried.
 */
export async function reconcileCapacitySettlementAttribution(input: {
  receiptId: string;
  userId: string;
}, deps: CapacityDeps = {}): Promise<CapacityAttributionReconciliation> {
  if (!input.receiptId.trim()) throw new Error("Receipt id is required");
  const row = await rpcRow("reconcile_capacity_settlement_attribution", {
    p_receipt_id: input.receiptId,
    p_user_id: input.userId,
  }, deps);
  return {
    reconciled: row.reconciled === true,
    totalLight: nonNegative(row.total_light, "attributed total Light"),
    deltaLight: nonNegative(row.delta_light, "attributed delta Light"),
  };
}

/** Idempotently attach Cloudflare-observed CPU to its original windows. */
export async function recordObservedCapacityCpu(input: {
  receiptId: string;
  cpuTimeMs: number;
  wallTimeMs?: number | null;
  observedAt: string;
  source: CapacityCpuSource;
  observationId?: string;
  final: true;
  metadata?: Record<string, unknown>;
}, deps: CapacityDeps = {}): Promise<CapacityCpuObservation> {
  if (!input.receiptId.trim()) throw new Error("Receipt id is required");
  if (!Number.isFinite(input.cpuTimeMs) || input.cpuTimeMs < 0) {
    throw new Error("Observed CPU time must be finite and non-negative");
  }
  if (
    input.wallTimeMs != null &&
    (!Number.isFinite(input.wallTimeMs) || input.wallTimeMs < 0)
  ) {
    throw new Error("Observed wall time must be finite and non-negative");
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("Observed timestamp is invalid");
  }
  if (!input.source.trim()) throw new Error("Observation source is required");
  // One terminal Tail trace is emitted per Worker source. A partial value
  // cannot be accepted because source-level economic idempotency would make a
  // later terminal value look like a duplicate and undercount permanently.
  if (input.final !== true) {
    throw new Error("Capacity CPU observation must be final");
  }
  const observationId = input.observationId?.trim() ||
    buildEconomicIdempotencyKey("capacity_cpu", [
      1,
      input.source,
      input.receiptId,
    ]);
  const row = await rpcRow("ingest_capacity_cpu_observation", {
    p_receipt_id: input.receiptId,
    p_observation_id: observationId,
    p_cpu_time_ms: input.cpuTimeMs,
    p_wall_time_ms: input.wallTimeMs ?? null,
    p_observed_at: input.observedAt,
    p_source: input.source,
    p_final: true,
    p_metadata: input.metadata ?? {},
  }, deps);
  const applicationStatus = row.application_status === "applied"
    ? "applied"
    : row.application_status === "pending"
    ? "pending"
    : null;
  if (!applicationStatus) {
    throw new Error("Capacity CPU inbox returned an invalid status");
  }
  return {
    observationId: requiredString(row.observation_id, "observation id"),
    applicationStatus,
    settlementId: typeof row.settlement_id === "string"
      ? row.settlement_id
      : null,
    eventId: typeof row.event_id === "string" ? row.event_id : null,
    inserted: row.inserted === true,
    settlementStatus: row.settlement_status == null
      ? null
      : resourceStatus(row.settlement_status),
    cpuTimeMs: nonNegative(row.cpu_time_ms, "CPU time"),
    wallTimeMs: row.wall_time_ms == null
      ? null
      : nonNegative(row.wall_time_ms, "wall time"),
    cpuLight: nonNegative(row.cpu_light, "CPU Light"),
    totalLight: nonNegative(row.total_light, "total Light"),
    attempts: Number.isInteger(row.attempts) && Number(row.attempts) >= 0
      ? Number(row.attempts)
      : 0,
    nextAttemptAt: typeof row.next_attempt_at === "string"
      ? row.next_attempt_at
      : null,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

export async function getAgentCapacityStatus(
  userId: string,
  agentId: string,
  options: { now?: string; exposeInternalLimits?: boolean } = {},
  deps: CapacityDeps = {},
): Promise<AgentCapacityStatus> {
  const row = await rpcRow("get_agent_capacity_status", {
    p_user_id: userId,
    p_capacity_agent_id: agentId,
    ...(options.now ? { p_now: options.now } : {}),
  }, deps);
  const limitsPublic = row.limits_public === true;
  const reveal = options.exposeInternalLimits === true || limitsPublic;
  const burstLimit = finite(row.agent_burst_limit_light);
  const weeklyLimit = finite(row.agent_weekly_limit_light);
  const burstUsed = finite(row.agent_burst_used_light);
  const weeklyUsed = finite(row.agent_weekly_used_light);
  const resolvedPlan = planCode(row.plan_code);
  // Paid owners need percentage-only usage to manage a percentage cap, but
  // raw Light allowances remain private calibration data. Free stays fully
  // qualitative unless an internal caller explicitly opts in.
  const revealPercent = resolvedPlan !== "free" || reveal;
  return {
    agentId: typeof row.capacity_agent_id === "string"
      ? row.capacity_agent_id
      : agentId,
    planCode: resolvedPlan,
    state: capacityState(row.capacity_state),
    capBasisPoints: resolvedPlan === "free" && !options.exposeInternalLimits
      ? null
      : Number.isInteger(row.agent_cap_basis_points)
      ? Number(row.agent_cap_basis_points)
      : 10_000,
    burst: {
      state: capacityState(row.burst_state ?? row.capacity_state),
      resetsAt: iso(row.burst_resets_at, "Agent burst reset"),
      ...(revealPercent ? { usedPercent: percent(burstUsed, burstLimit) } : {}),
      ...(reveal
        ? {
          remainingLight: Math.max(0, burstLimit - burstUsed),
          limitLight: burstLimit,
        }
        : {}),
    },
    weekly: {
      state: capacityState(row.weekly_state ?? row.capacity_state),
      resetsAt: iso(row.weekly_resets_at, "Agent weekly reset"),
      ...(revealPercent
        ? { usedPercent: percent(weeklyUsed, weeklyLimit) }
        : {}),
      ...(reveal
        ? {
          remainingLight: Math.max(0, weeklyLimit - weeklyUsed),
          limitLight: weeklyLimit,
        }
        : {}),
    },
    nextEligibleAt: typeof row.next_eligible_at === "string"
      ? row.next_eligible_at
      : null,
    limitsPublic,
  };
}

export async function setAgentCapacityCap(
  input: {
    userId: string;
    agentId: string;
    capBasisPoints: number;
  },
  deps: CapacityDeps = {},
): Promise<{ agentId: string; capBasisPoints: number }> {
  if (
    !Number.isInteger(input.capBasisPoints) || input.capBasisPoints < 1 ||
    input.capBasisPoints > 10_000
  ) {
    throw new Error(
      "Agent capacity cap must be an integer from 1 to 10000 basis points",
    );
  }
  const row = await rpcRow("set_agent_capacity_policy", {
    p_user_id: input.userId,
    p_capacity_agent_id: input.agentId,
    p_cap_basis_points: input.capBasisPoints,
  }, deps);
  return {
    agentId: typeof row.capacity_agent_id === "string"
      ? row.capacity_agent_id
      : input.agentId,
    capBasisPoints: Number.isInteger(row.agent_cap_basis_points)
      ? Number(row.agent_cap_basis_points)
      : input.capBasisPoints,
  };
}

export async function releaseAccountCapacity(input: {
  reservationId: string;
  userId: string;
  expired?: boolean;
}, deps: CapacityDeps = {}): Promise<boolean> {
  const response = await rpc("release_account_capacity", {
    p_reservation_id: input.reservationId,
    p_user_id: input.userId,
    p_expired: input.expired === true,
  }, deps);
  if (!response.ok) {
    throw new Error(`Failed to release account capacity (${response.status})`);
  }
  return await response.json() === true;
}

export async function claimAgentActivationSlot(
  userId: string,
  appId: string,
  deps: CapacityDeps = {},
): Promise<AgentActivationSlotDecision> {
  const row = await rpcRow("claim_agent_activation_slot", {
    p_user_id: userId,
    p_app_id: appId,
  }, deps);
  return {
    allowed: row.allowed === true,
    code: row.code === "ok" ? "ok" : "active_agent_limit",
    activeAgentLimit: Number.isInteger(row.active_agent_limit)
      ? Number(row.active_agent_limit)
      : null,
    occupiedBy: typeof row.occupied_by === "string" ? row.occupied_by : null,
  };
}

export async function releaseAgentActivationSlot(
  userId: string,
  appId: string,
  deps: CapacityDeps = {},
): Promise<boolean> {
  const response = await rpc("release_agent_activation_slot", {
    p_user_id: userId,
    p_app_id: appId,
  }, deps);
  if (!response.ok) {
    throw new Error(
      `Failed to release Agent activation slot (${response.status})`,
    );
  }
  const payload = await response.json().catch(() => false);
  return payload === true;
}

export async function recordDeferredRoutineWake(input: {
  routineId: string;
  userId: string;
  scheduledAt: string;
  nextEligibleAt: string;
  manualRequested?: boolean;
}, deps: CapacityDeps = {}): Promise<DeferredRoutineWake> {
  const response = await rpc("record_deferred_routine_wake", {
    p_routine_id: input.routineId,
    p_user_id: input.userId,
    p_scheduled_at: input.scheduledAt,
    p_next_eligible_at: input.nextEligibleAt,
    p_manual_requested: input.manualRequested === true,
  }, deps);
  if (!response.ok) {
    throw new Error(`Failed to coalesce deferred wake (${response.status})`);
  }
  const payload = await response.json() as Record<string, unknown>;
  return {
    routineId: String(payload.routine_id),
    userId: String(payload.user_id),
    firstDeferredAt: String(payload.first_deferred_at),
    latestDeferredAt: String(payload.latest_deferred_at),
    deferredWakeCount: Number(payload.deferred_wake_count),
    nextEligibleAt: String(payload.next_eligible_at),
    manualRequested: payload.manual_requested === true,
  };
}

export async function attachDeferredWakeToRun(
  routineId: string,
  userId: string,
  runId: string,
  deps: CapacityDeps = {},
): Promise<DeferredRoutineWake | null> {
  const response = await rpc("attach_deferred_wake_to_run", {
    p_routine_id: routineId,
    p_user_id: userId,
    p_run_id: runId,
  }, deps);
  if (!response.ok) {
    throw new Error(`Failed to attach deferred wake (${response.status})`);
  }
  const payload = await response.json().catch(() => null);
  const row = (Array.isArray(payload) ? payload[0] : payload) as
    | Record<string, unknown>
    | null;
  if (!row) return null;
  return {
    routineId: String(row.routine_id),
    userId: String(row.user_id),
    firstDeferredAt: String(row.first_deferred_at),
    latestDeferredAt: String(row.latest_deferred_at),
    deferredWakeCount: Number(row.deferred_wake_count),
    nextEligibleAt: String(row.next_eligible_at),
    manualRequested: row.manual_requested === true,
  };
}

export function accountCapacityErrorDetails(
  admission: AccountCapacityAdmission,
) {
  return {
    type: admission.code === "concurrency_waiting"
      ? "concurrency_waiting"
      : admission.code === "agent_cap_waiting" ||
          admission.code === "agent_cap_too_low_for_request"
      ? admission.code
      : "capacity_waiting",
    plan: admission.planCode,
    state: admission.state,
    retry_at: admission.nextEligibleAt,
    burst_resets_at: admission.burst.resetsAt,
    weekly_resets_at: admission.weekly.resetsAt,
    capacity_agent_id: admission.agentCapacity?.agentId ?? null,
    agent_cap_basis_points: admission.agentCapacity?.capBasisPoints ?? null,
    binding_constraint: admission.agentCapacity?.bindingConstraint ?? "account",
    ...(admission.concurrencyScope
      ? { concurrency_scope: admission.concurrencyScope }
      : {}),
  } as const;
}

export function accountCapacityErrorMessage(
  admission: AccountCapacityAdmission,
): string {
  if (admission.code === "agent_cap_too_low_for_request") {
    return "This Agent's capacity cap is too low to admit one execution. Increase the cap and try again.";
  }
  if (admission.code === "concurrency_waiting") {
    const scope = admission.concurrencyScope === "ai"
      ? "AI calls"
      : admission.concurrencyScope === "agent"
      ? "Agent executions"
      : admission.concurrencyScope === "routine"
      ? "routine wake"
      : "account executions";
    return admission.nextEligibleAt
      ? `Too many ${scope} are already in progress. Retry after ${admission.nextEligibleAt}.`
      : `Too many ${scope} are already in progress. Retry shortly.`;
  }
  const subject = admission.code === "agent_cap_waiting"
    ? "Agent capacity"
    : "Account capacity";
  return admission.nextEligibleAt
    ? `${subject} is ${admission.state}. Work can resume at ${admission.nextEligibleAt}.`
    : `${subject} is ${admission.state}.`;
}
