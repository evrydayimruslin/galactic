import {
  callComputeRpc,
  type ComputeDatabaseDeps,
} from "./compute/database.ts";
import type {
  ComputeBillingMode,
  ComputeCapacitySettlementStatus,
  ComputeRunState,
  ComputeTerminalRunState,
} from "./compute/types.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const INTEGER_STRING_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const LIGHT_PATTERN = /^(?:0|[1-9][0-9]*)\.[0-9]{12}$/u;
const CALLER_FUNCTION_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const MAX_SELECTED_RUNS = 20;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const COMPUTE_RATE_VERSION = "compute-rate-v1";
const COMPUTE_RATE_LIGHT_PER_MS = "0.000002056000";
const COMPUTE_RATE_UNITS_PER_MS = 2_056_000n;
const COMPUTE_TEARDOWN_ALLOWANCE_MS = "15000";

const TERMINAL_STATES = new Set<ComputeRunState>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "revoked",
]);

const TOP_LEVEL_KEYS = [
  "agent_id",
  "generated_at",
  "health",
  "latch_state",
  "owner_id",
  "requested_run_count",
  "runs",
  "schema_version",
  "selected_run_count",
  "since",
  "violations",
] as const;

const HEALTH_KEYS = [
  "dlq_fenced_runs",
  "old_settlement_pending",
  "receipt_mismatches",
  "stale_nonterminal_runs",
  "stale_pending_artifacts",
  "terminal_active_tokens",
  "terminal_input_aliases",
  "terminal_reserved_budgets",
  "unreconciled_deleted_outputs",
  "violations",
] as const;

const RUN_KEYS = [
  "agent_id",
  "artifacts",
  "backing",
  "billing_mode",
  "budget",
  "caller_function",
  "capacity_agent_id",
  "cardinality",
  "created_at",
  "directive_hash",
  "environment_digest",
  "expires_at",
  "finished_at",
  "owner_id",
  "receipt",
  "receipt_id",
  "request_hash",
  "run_id",
  "started_at",
  "state",
  "state_version",
  "terminal_active_token_count",
  "updated_at",
  "violations",
] as const;

const CARDINALITY_KEYS = [
  "artifact_rows",
  "budget_rows",
  "input_artifact_rows",
  "output_artifact_rows",
  "projected_artifact_rows",
  "receipt_rows",
  "token_rows",
] as const;

const BACKING_KEYS = [
  "budget_capacity_agent_match",
  "budget_capacity_reservation",
  "budget_hold",
  "budget_matches_run_capacity",
  "budget_owner_match",
  "receipt_capacity_agent_match",
  "receipt_capacity_reservation",
  "receipt_cloud_usage_event",
  "receipt_hold",
  "receipt_matches_budget_hold",
  "receipt_matches_run_capacity",
  "receipt_principal_match",
  "run_capacity_reservation",
] as const;

const BUDGET_KEYS = [
  "actual_light",
  "actual_wall_ms",
  "billing_mode",
  "expires_at",
  "rate_light_per_ms",
  "rate_version",
  "released_light",
  "reserved_light",
  "reserved_wall_ms",
  "settled_at",
  "status",
  "teardown_allowance_ms",
] as const;

const RECEIPT_KEYS = [
  "actual_light",
  "billed_wall_ms",
  "billing_mode",
  "capacity_settlement_status",
  "created_at",
  "id",
  "outcome",
  "rate_version",
  "released_light",
  "reserved_light",
  "teardown_allowance_ms",
  "worker_wall_ms",
] as const;

const ARTIFACT_KEYS = [
  "artifact_id",
  "direction",
  "expires_at",
  "object_deleted",
  "sha256",
  "size_bytes",
  "state",
  "state_version",
] as const;

const TOP_LEVEL_VIOLATIONS = [
  "EMERGENCY_STOP_LATCH_SET",
  "SELECTED_RUN_CARDINALITY_MISMATCH",
] as const;

const HEALTH_VIOLATIONS = [
  "DLQ_FENCED_RUNS",
  "OLD_SETTLEMENT_PENDING",
  "RECEIPT_MISMATCHES",
  "STALE_NONTERMINAL_RUNS",
  "STALE_PENDING_ARTIFACTS",
  "TERMINAL_ACTIVE_TOKENS",
  "TERMINAL_INPUT_ALIASES",
  "TERMINAL_RESERVED_BUDGETS",
  "UNRECONCILED_DELETED_OUTPUTS",
] as const;

const RUN_VIOLATIONS = [
  "ACCOUNTING_CONSERVATION_INVALID",
  "ARTIFACT_CARDINALITY_INVALID",
  "ARTIFACT_INTEGRITY_INVALID",
  "ARTIFACT_PROJECTION_TRUNCATED",
  "BILLING_BACKING_INVALID",
  "BILLING_MODE_MISMATCH",
  "BUDGET_CARDINALITY_INVALID",
  "RECEIPT_CARDINALITY_INVALID",
  "RECEIPT_ID_MISMATCH",
  "RECEIPT_OUTCOME_MISMATCH",
  "TERMINAL_ACTIVE_TOKEN",
  "TERMINAL_TIMESTAMP_INVALID",
] as const;

type TopLevelViolation = typeof TOP_LEVEL_VIOLATIONS[number];
export type ComputeCertificationHealthViolation =
  typeof HEALTH_VIOLATIONS[number];
export type ComputeCertificationRunViolation = typeof RUN_VIOLATIONS[number];

export class ComputeCertificationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ComputeCertificationError";
    this.code = code;
    this.status = status;
  }
}

export interface ComputeCertificationInput {
  ownerId: string;
  agentId: string;
  runIds: string[];
  since: string;
}

export interface ComputeCertificationCardinality {
  budgetRows: number;
  receiptRows: number;
  tokenRows: number;
  artifactRows: number;
  inputArtifactRows: number;
  outputArtifactRows: number;
  projectedArtifactRows: number;
}

export interface ComputeCertificationBacking {
  runCapacityReservation: boolean;
  budgetHold: boolean;
  budgetCapacityReservation: boolean;
  receiptHold: boolean;
  receiptCapacityReservation: boolean;
  receiptCloudUsageEvent: boolean;
  budgetMatchesRunCapacity: boolean;
  receiptMatchesRunCapacity: boolean;
  receiptMatchesBudgetHold: boolean;
  budgetOwnerMatch: boolean;
  budgetCapacityAgentMatch: boolean;
  receiptPrincipalMatch: boolean;
  receiptCapacityAgentMatch: boolean;
}

export type ComputeCertificationBudgetStatus =
  | "reserved"
  | "settlement_pending"
  | "settled"
  | "released";

export interface ComputeCertificationBudget {
  status: ComputeCertificationBudgetStatus;
  billingMode: ComputeBillingMode;
  rateVersion: string;
  rateLightPerMs: string;
  actualWallMs: string | null;
  reservedWallMs: string;
  teardownAllowanceMs: string;
  reservedLight: string;
  actualLight: string;
  releasedLight: string;
  expiresAt: string;
  settledAt: string | null;
}

export interface ComputeCertificationReceipt {
  id: string;
  outcome: ComputeTerminalRunState;
  billingMode: ComputeBillingMode;
  rateVersion: string;
  capacitySettlementStatus: ComputeCapacitySettlementStatus;
  reservedLight: string;
  actualLight: string;
  releasedLight: string;
  workerWallMs: string | null;
  teardownAllowanceMs: string;
  billedWallMs: string;
  createdAt: string;
}

export interface ComputeCertificationArtifact {
  artifactId: string;
  direction: "input" | "output";
  state: "pending" | "ready" | "deleted";
  stateVersion: string;
  sha256: string | null;
  sizeBytes: string | null;
  expiresAt: string | null;
  objectDeleted: boolean;
}

export interface ComputeCertificationRun {
  runId: string;
  receiptId: string;
  ownerId: string;
  agentId: string;
  callerFunction: string;
  state: ComputeRunState;
  stateVersion: string;
  billingMode: ComputeBillingMode;
  capacityAgentId: string;
  environmentDigest: string;
  directiveHash: string;
  requestHash: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cardinality: ComputeCertificationCardinality;
  backing: ComputeCertificationBacking;
  budget: ComputeCertificationBudget | null;
  receipt: ComputeCertificationReceipt | null;
  terminalActiveTokenCount: number;
  artifacts: ComputeCertificationArtifact[];
  violations: ComputeCertificationRunViolation[];
}

export interface ComputeCertificationHealth {
  staleNonterminalRuns: number;
  oldSettlementPending: number;
  terminalReservedBudgets: number;
  receiptMismatches: number;
  terminalActiveTokens: number;
  dlqFencedRuns: number;
  stalePendingArtifacts: number;
  unreconciledDeletedOutputs: number;
  terminalInputAliases: number;
  violations: ComputeCertificationHealthViolation[];
}

export interface ComputeCertificationSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  ownerId: string;
  agentId: string;
  since: string;
  latchState: "clear" | "active" | "completed";
  requestedRunCount: number;
  selectedRunCount: number;
  runs: ComputeCertificationRun[];
  health: ComputeCertificationHealth;
  violations: TopLevelViolation[];
}

function invalidInput(message: string): never {
  throw new ComputeCertificationError(
    "COMPUTE_CERTIFICATION_INVALID",
    400,
    message,
  );
}

function invalidResponse(message: string): never {
  throw new ComputeCertificationError(
    "COMPUTE_CERTIFICATION_INVALID_RESPONSE",
    503,
    `Compute certification snapshot ${message}.`,
  );
}

function record(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidResponse(`returned an invalid ${label}`);
  }
  const candidate = value as Record<string, unknown>;
  const supplied = Object.keys(candidate).sort();
  if (
    supplied.length !== keys.length ||
    supplied.some((key, index) => key !== keys[index])
  ) {
    invalidResponse(`returned an invalid ${label} schema`);
  }
  return candidate;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalidResponse(`returned an invalid ${label}`);
  }
  return value.toLowerCase();
}

function inputUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalidInput(`${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (
    year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 ||
    second > 59
  ) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day < 1 || day > monthDays[month - 1]) return false;
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/u);
  if (offset) {
    const offsetHours = Number(offset[2]);
    const offsetMinutes = Number(offset[3]);
    if (
      offsetHours > 14 || offsetMinutes > 59 ||
      (offsetHours === 14 && offsetMinutes !== 0)
    ) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function timestamp(value: unknown, label: string): string {
  if (!validTimestamp(value)) {
    invalidResponse(`returned an invalid ${label}`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function inputTimestamp(value: unknown, now: Date): string {
  if (!validTimestamp(value)) {
    invalidInput("since must be an ISO timestamp with an explicit timezone.");
  }
  const parsed = Date.parse(value);
  if (parsed > now.getTime()) {
    invalidInput("since cannot be in the future.");
  }
  if (parsed < now.getTime() - MAX_LOOKBACK_MS) {
    invalidInput("since must be within the last 24 hours.");
  }
  return new Date(parsed).toISOString();
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidResponse(`returned an invalid ${label}`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    invalidResponse(`returned an invalid ${label}`);
  }
  return value;
}

function positiveIntegerString(value: unknown, label: string): string {
  if (
    typeof value !== "string" || !INTEGER_STRING_PATTERN.test(value) ||
    value === "0"
  ) {
    invalidResponse(`returned an invalid ${label}`);
  }
  return value;
}

function integerString(
  value: unknown,
  label: string,
  nullable = false,
): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !INTEGER_STRING_PATTERN.test(value)) {
    invalidResponse(`returned an invalid ${label}`);
  }
  return value;
}

function light(value: unknown, label: string): string {
  if (typeof value !== "string" || !LIGHT_PATTERN.test(value)) {
    invalidResponse(`returned an invalid ${label}`);
  }
  return value;
}

function lightUnits(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    invalidResponse(`returned an invalid ${label}`);
  }
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function billingMode(value: unknown, label: string): ComputeBillingMode {
  if (value !== "wallet" && value !== "subscription_capacity") {
    invalidResponse(`returned an invalid ${label}`);
  }
  return value;
}

function runState(value: unknown): ComputeRunState {
  if (
    value !== "admitted" && value !== "queued" &&
    value !== "provisioning" && value !== "running" &&
    value !== "succeeded" && value !== "failed" &&
    value !== "cancelled" && value !== "expired" && value !== "revoked"
  ) invalidResponse("returned an invalid run state");
  return value;
}

function terminalState(value: unknown): ComputeTerminalRunState {
  const state = runState(value);
  if (!TERMINAL_STATES.has(state)) {
    invalidResponse("returned an invalid receipt outcome");
  }
  return state as ComputeTerminalRunState;
}

function exactViolations<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T[] {
  if (!Array.isArray(value)) {
    invalidResponse(`returned invalid ${label}`);
  }
  const allowedSet = new Set<string>(allowed);
  const violations: T[] = [];
  let previous = "";
  for (const candidate of value) {
    if (
      typeof candidate !== "string" || !allowedSet.has(candidate) ||
      candidate <= previous
    ) invalidResponse(`returned invalid ${label}`);
    previous = candidate;
    violations.push(candidate as T);
  }
  return violations;
}

function sameValues(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function accountingValid(
  billing: ComputeBillingMode,
  status: ComputeCertificationBudgetStatus | null,
  reserved: string,
  actual: string,
  released: string,
): boolean {
  const reservedUnits = lightUnits(reserved);
  const actualUnits = lightUnits(actual);
  const releasedUnits = lightUnits(released);
  if (releasedUnits > reservedUnits) return false;
  if (billing === "wallet") {
    if (status === "settlement_pending") return false;
    if (actualUnits > reservedUnits) return false;
    return status === "reserved" ||
      actualUnits + releasedUnits === reservedUnits;
  }
  if (status === "reserved") {
    return actualUnits === 0n && releasedUnits === 0n;
  }
  const expectedReleased = reservedUnits > actualUnits
    ? reservedUnits - actualUnits
    : 0n;
  return releasedUnits === expectedReleased;
}

function budgetTariffValid(budget: ComputeCertificationBudget): boolean {
  const reservedWall = BigInt(budget.reservedWallMs);
  return budget.rateVersion === COMPUTE_RATE_VERSION &&
    budget.rateLightPerMs === COMPUTE_RATE_LIGHT_PER_MS &&
    budget.teardownAllowanceMs === COMPUTE_TEARDOWN_ALLOWANCE_MS &&
    lightUnits(budget.reservedLight) ===
      reservedWall * COMPUTE_RATE_UNITS_PER_MS &&
    (budget.status !== "reserved" ||
      (budget.actualWallMs === null &&
        budget.actualLight === "0.000000000000" &&
        budget.releasedLight === "0.000000000000"));
}

function mapBudget(value: unknown): ComputeCertificationBudget | null {
  if (value === null) return null;
  const row = record(value, BUDGET_KEYS, "budget");
  const status = row.status;
  if (
    status !== "reserved" && status !== "settlement_pending" &&
    status !== "settled" && status !== "released"
  ) invalidResponse("returned an invalid budget status");
  const settledAt = nullableTimestamp(
    row.settled_at,
    "budget settlement timestamp",
  );
  if (
    (status === "reserved" || status === "settlement_pending")
      ? settledAt !== null
      : settledAt === null
  ) invalidResponse("returned an inconsistent budget settlement timestamp");
  if (typeof row.rate_version !== "string") {
    invalidResponse("returned an invalid budget rate version");
  }
  return {
    status,
    billingMode: billingMode(row.billing_mode, "budget billing mode"),
    rateVersion: row.rate_version,
    rateLightPerMs: light(row.rate_light_per_ms, "budget rate"),
    actualWallMs: integerString(
      row.actual_wall_ms,
      "budget actual wall milliseconds",
      true,
    ),
    reservedWallMs: positiveIntegerString(
      row.reserved_wall_ms,
      "budget reserved wall milliseconds",
    ),
    teardownAllowanceMs: integerString(
      row.teardown_allowance_ms,
      "budget teardown allowance",
    ) as string,
    reservedLight: light(row.reserved_light, "budget reserved Light"),
    actualLight: light(row.actual_light, "budget actual Light"),
    releasedLight: light(row.released_light, "budget released Light"),
    expiresAt: timestamp(row.expires_at, "budget expiry timestamp"),
    settledAt,
  };
}

function mapReceipt(value: unknown): ComputeCertificationReceipt | null {
  if (value === null) return null;
  const row = record(value, RECEIPT_KEYS, "receipt");
  const settlement = row.capacity_settlement_status;
  if (
    settlement !== "not_applicable" && settlement !== "pending" &&
    settlement !== "settled"
  ) invalidResponse("returned an invalid receipt settlement state");
  if (typeof row.rate_version !== "string") {
    invalidResponse("returned an invalid receipt rate version");
  }
  return {
    id: uuid(row.id, "receipt id"),
    outcome: terminalState(row.outcome),
    billingMode: billingMode(row.billing_mode, "receipt billing mode"),
    rateVersion: row.rate_version,
    capacitySettlementStatus: settlement,
    reservedLight: light(row.reserved_light, "receipt reserved Light"),
    actualLight: light(row.actual_light, "receipt actual Light"),
    releasedLight: light(row.released_light, "receipt released Light"),
    workerWallMs: integerString(
      row.worker_wall_ms,
      "receipt worker wall milliseconds",
      true,
    ),
    teardownAllowanceMs: integerString(
      row.teardown_allowance_ms,
      "receipt teardown allowance",
    ) as string,
    billedWallMs: integerString(
      row.billed_wall_ms,
      "receipt billed wall milliseconds",
    ) as string,
    createdAt: timestamp(row.created_at, "receipt creation timestamp"),
  };
}

function mapArtifact(value: unknown): ComputeCertificationArtifact {
  const row = record(value, ARTIFACT_KEYS, "artifact");
  const direction = row.direction;
  if (direction !== "input" && direction !== "output") {
    invalidResponse("returned an invalid artifact direction");
  }
  const state = row.state;
  if (state !== "pending" && state !== "ready" && state !== "deleted") {
    invalidResponse("returned an invalid artifact state");
  }
  return {
    artifactId: uuid(row.artifact_id, "artifact id"),
    direction,
    state,
    stateVersion: positiveIntegerString(
      row.state_version,
      "artifact state version",
    ),
    sha256: nullableHash(row.sha256, "artifact digest"),
    sizeBytes: integerString(row.size_bytes, "artifact size", true),
    expiresAt: nullableTimestamp(row.expires_at, "artifact expiry timestamp"),
    objectDeleted: boolean(row.object_deleted, "artifact deletion marker"),
  };
}

function artifactValid(artifact: ComputeCertificationArtifact): boolean {
  const pairedIntegrity = (artifact.sha256 === null) ===
    (artifact.sizeBytes === null);
  return pairedIntegrity &&
    (artifact.state !== "ready" ||
      (artifact.sha256 !== null && artifact.sizeBytes !== null &&
        artifact.expiresAt !== null && !artifact.objectDeleted)) &&
    (!artifact.objectDeleted ||
      (artifact.direction === "output" && artifact.state === "deleted")) &&
    (artifact.direction !== "input" || artifact.state !== "pending") &&
    (artifact.direction !== "input" || !artifact.objectDeleted) &&
    (artifact.state !== "pending" || !artifact.objectDeleted);
}

function mapCardinality(value: unknown): ComputeCertificationCardinality {
  const row = record(value, CARDINALITY_KEYS, "cardinality");
  return {
    budgetRows: count(row.budget_rows, "budget row count"),
    receiptRows: count(row.receipt_rows, "receipt row count"),
    tokenRows: count(row.token_rows, "token row count"),
    artifactRows: count(row.artifact_rows, "artifact row count"),
    inputArtifactRows: count(
      row.input_artifact_rows,
      "input artifact row count",
    ),
    outputArtifactRows: count(
      row.output_artifact_rows,
      "output artifact row count",
    ),
    projectedArtifactRows: count(
      row.projected_artifact_rows,
      "projected artifact row count",
    ),
  };
}

function mapBacking(value: unknown): ComputeCertificationBacking {
  const row = record(value, BACKING_KEYS, "billing backing");
  return {
    runCapacityReservation: boolean(
      row.run_capacity_reservation,
      "run capacity backing",
    ),
    budgetHold: boolean(row.budget_hold, "budget hold backing"),
    budgetCapacityReservation: boolean(
      row.budget_capacity_reservation,
      "budget capacity backing",
    ),
    receiptHold: boolean(row.receipt_hold, "receipt hold backing"),
    receiptCapacityReservation: boolean(
      row.receipt_capacity_reservation,
      "receipt capacity backing",
    ),
    receiptCloudUsageEvent: boolean(
      row.receipt_cloud_usage_event,
      "receipt usage backing",
    ),
    budgetMatchesRunCapacity: boolean(
      row.budget_matches_run_capacity,
      "budget/run capacity match",
    ),
    receiptMatchesRunCapacity: boolean(
      row.receipt_matches_run_capacity,
      "receipt/run capacity match",
    ),
    receiptMatchesBudgetHold: boolean(
      row.receipt_matches_budget_hold,
      "receipt/budget hold match",
    ),
    budgetOwnerMatch: boolean(row.budget_owner_match, "budget owner match"),
    budgetCapacityAgentMatch: boolean(
      row.budget_capacity_agent_match,
      "budget capacity Agent match",
    ),
    receiptPrincipalMatch: boolean(
      row.receipt_principal_match,
      "receipt principal match",
    ),
    receiptCapacityAgentMatch: boolean(
      row.receipt_capacity_agent_match,
      "receipt capacity Agent match",
    ),
  };
}

function backingValid(
  billing: ComputeBillingMode,
  cardinality: ComputeCertificationCardinality,
  backing: ComputeCertificationBacking,
  budget: ComputeCertificationBudget | null,
  receipt: ComputeCertificationReceipt | null,
  bodyStarted: boolean,
  succeeded: boolean,
): boolean {
  if (billing === "wallet" && backing.runCapacityReservation) return false;
  if (
    (bodyStarted || succeeded) &&
    (cardinality.budgetRows !== 1 || cardinality.tokenRows < 1)
  ) return false;
  if (cardinality.budgetRows === 1) {
    if (!backing.budgetOwnerMatch || !backing.budgetCapacityAgentMatch) {
      return false;
    }
    if (
      billing === "wallet"
        ? !backing.budgetHold || backing.budgetCapacityReservation
        : backing.budgetHold || !backing.budgetCapacityReservation ||
          !backing.runCapacityReservation
    ) return false;
    if (!backing.budgetMatchesRunCapacity) return false;
  }
  if (cardinality.receiptRows === 1) {
    if (!backing.receiptPrincipalMatch || !backing.receiptCapacityAgentMatch) {
      return false;
    }
    if (
      billing === "wallet"
        ? backing.receiptHold !== (budget !== null) ||
          backing.receiptCloudUsageEvent !==
            (receipt !== null && receipt.workerWallMs !== null) ||
          backing.receiptCapacityReservation
        : backing.receiptHold || backing.receiptCloudUsageEvent ||
          backing.receiptCapacityReservation !==
            backing.runCapacityReservation
    ) return false;
    if (
      !backing.receiptMatchesRunCapacity ||
      !backing.receiptMatchesBudgetHold
    ) return false;
    if (receipt) {
      if (
        billing === "wallet" &&
        receipt.capacitySettlementStatus !== "not_applicable"
      ) return false;
      if (
        billing === "subscription_capacity" &&
        (backing.receiptCapacityReservation
          ? receipt.capacitySettlementStatus === "not_applicable"
          : receipt.capacitySettlementStatus !== "not_applicable")
      ) return false;
    }
  }
  return true;
}

function accountingConserves(
  billing: ComputeBillingMode,
  budget: ComputeCertificationBudget | null,
  receipt: ComputeCertificationReceipt | null,
  bodyStarted: boolean,
): boolean {
  if (
    budget && (!budgetTariffValid(budget) ||
      !accountingValid(
        budget.billingMode,
        budget.status,
        budget.reservedLight,
        budget.actualLight,
        budget.releasedLight,
      ))
  ) return false;
  if (receipt === null) return budget === null || budget.status === "reserved";
  if (
    receipt.rateVersion !== COMPUTE_RATE_VERSION ||
    !accountingValid(
      receipt.billingMode,
      null,
      receipt.reservedLight,
      receipt.actualLight,
      receipt.releasedLight,
    )
  ) return false;
  const workerStarted = receipt.workerWallMs !== null;
  if (workerStarted !== bodyStarted) return false;
  if (
    budget &&
    (budget.reservedLight !== receipt.reservedLight ||
      budget.actualLight !== receipt.actualLight ||
      budget.releasedLight !== receipt.releasedLight ||
      budget.teardownAllowanceMs !== receipt.teardownAllowanceMs)
  ) return false;
  if (!workerStarted) {
    if (
      receipt.billedWallMs !== "0" ||
      receipt.actualLight !== "0.000000000000"
    ) return false;
    if (budget === null) {
      return receipt.teardownAllowanceMs === "0" &&
        receipt.reservedLight === "0.000000000000" &&
        receipt.releasedLight === "0.000000000000";
    }
    if (
      budget.actualWallMs !== null ||
      budget.actualLight !== "0.000000000000" ||
      budget.releasedLight !== budget.reservedLight
    ) return false;
  } else {
    if (budget === null || budget.actualWallMs !== receipt.workerWallMs) {
      return false;
    }
    const workerWall = BigInt(receipt.workerWallMs as string);
    const expectedBilled = billing === "wallet"
      ? workerWall < BigInt(budget.reservedWallMs)
        ? workerWall
        : BigInt(budget.reservedWallMs)
      : workerWall;
    if (
      BigInt(receipt.billedWallMs) !== expectedBilled ||
      lightUnits(receipt.actualLight) !==
        expectedBilled * COMPUTE_RATE_UNITS_PER_MS
    ) return false;
  }
  if (billing === "wallet") {
    return receipt.capacitySettlementStatus === "not_applicable" &&
      (workerStarted
        ? budget?.status === "settled"
        : budget === null || budget.status === "released");
  }
  if (budget === null) {
    return receipt.capacitySettlementStatus === "not_applicable";
  }
  return (budget.status === "settlement_pending" &&
    receipt.capacitySettlementStatus === "pending") ||
    (budget.status === "settled" &&
      receipt.capacitySettlementStatus === "settled");
}

function expectedRunViolations(
  run: Omit<ComputeCertificationRun, "violations">,
): ComputeCertificationRunViolation[] {
  const expected: ComputeCertificationRunViolation[] = [];
  const terminal = TERMINAL_STATES.has(run.state);
  const bodyStarted = run.startedAt !== null;
  if (
    !accountingConserves(
      run.billingMode,
      run.budget,
      run.receipt,
      bodyStarted,
    )
  ) {
    expected.push("ACCOUNTING_CONSERVATION_INVALID");
  }
  if (
    run.cardinality.artifactRows !==
      run.cardinality.inputArtifactRows +
        run.cardinality.outputArtifactRows ||
    run.cardinality.projectedArtifactRows !== run.artifacts.length ||
    run.cardinality.projectedArtifactRows > run.cardinality.artifactRows
  ) expected.push("ARTIFACT_CARDINALITY_INVALID");
  if (run.artifacts.some((artifact) => !artifactValid(artifact))) {
    expected.push("ARTIFACT_INTEGRITY_INVALID");
  }
  if (
    run.cardinality.projectedArtifactRows < run.cardinality.artifactRows
  ) expected.push("ARTIFACT_PROJECTION_TRUNCATED");
  if (
    !backingValid(
      run.billingMode,
      run.cardinality,
      run.backing,
      run.budget,
      run.receipt,
      bodyStarted,
      run.state === "succeeded",
    )
  ) {
    expected.push("BILLING_BACKING_INVALID");
  }
  if (
    (run.budget !== null && run.budget.billingMode !== run.billingMode) ||
    (run.receipt !== null && run.receipt.billingMode !== run.billingMode)
  ) expected.push("BILLING_MODE_MISMATCH");
  if (
    run.cardinality.budgetRows > 1 ||
    ((bodyStarted || run.state === "succeeded") &&
      run.cardinality.budgetRows !== 1)
  ) {
    expected.push("BUDGET_CARDINALITY_INVALID");
  }
  if (
    (terminal && run.cardinality.receiptRows !== 1) ||
    (!terminal && run.cardinality.receiptRows !== 0)
  ) expected.push("RECEIPT_CARDINALITY_INVALID");
  if (run.receipt !== null && run.receipt.id !== run.receiptId) {
    expected.push("RECEIPT_ID_MISMATCH");
  }
  if (run.receipt !== null && run.receipt.outcome !== run.state) {
    expected.push("RECEIPT_OUTCOME_MISMATCH");
  }
  if (terminal && run.terminalActiveTokenCount > 0) {
    expected.push("TERMINAL_ACTIVE_TOKEN");
  }
  const created = Date.parse(run.createdAt);
  const updated = Date.parse(run.updatedAt);
  const expires = Date.parse(run.expiresAt);
  const started = run.startedAt === null ? null : Date.parse(run.startedAt);
  const finished = run.finishedAt === null ? null : Date.parse(run.finishedAt);
  if (
    created > updated || expires <= created ||
    (started !== null && (started < created || started > updated)) ||
    terminal !== (finished !== null) ||
    (run.state === "succeeded" && started === null) ||
    (finished !== null && (finished < created || finished > updated)) ||
    (started !== null && finished !== null && finished < started)
  ) expected.push("TERMINAL_TIMESTAMP_INVALID");
  return expected;
}

function mapRun(
  value: unknown,
  ownerId: string,
  agentId: string,
  since: string,
  generatedAt: string,
): ComputeCertificationRun {
  const row = record(value, RUN_KEYS, "run");
  const runId = uuid(row.run_id, "run id");
  const selectedOwner = uuid(row.owner_id, "run owner id");
  const selectedAgent = uuid(row.agent_id, "run Agent id");
  if (selectedOwner !== ownerId || selectedAgent !== agentId) {
    invalidResponse("returned a run outside the requested principal");
  }
  if (
    typeof row.caller_function !== "string" ||
    !CALLER_FUNCTION_PATTERN.test(row.caller_function)
  ) invalidResponse("returned an invalid caller function");
  if (
    typeof row.environment_digest !== "string" ||
    !DIGEST_PATTERN.test(row.environment_digest)
  ) invalidResponse("returned an invalid environment digest");
  const artifactsValue = row.artifacts;
  if (!Array.isArray(artifactsValue)) {
    invalidResponse("returned invalid artifacts");
  }
  const artifacts = artifactsValue.map(mapArtifact);
  for (let index = 1; index < artifacts.length; index += 1) {
    const previous = artifacts[index - 1];
    const current = artifacts[index];
    const previousKey = `${previous.direction}:${previous.artifactId}`;
    const currentKey = `${current.direction}:${current.artifactId}`;
    if (currentKey <= previousKey) {
      invalidResponse("returned duplicate or unordered artifacts");
    }
  }
  const cardinality = mapCardinality(row.cardinality);
  const backing = mapBacking(row.backing);
  const budget = mapBudget(row.budget);
  const receipt = mapReceipt(row.receipt);
  if (
    (cardinality.budgetRows === 1) !== (budget !== null) ||
    (cardinality.receiptRows === 1) !== (receipt !== null)
  ) invalidResponse("returned inconsistent selected-row cardinality");
  const terminalActiveTokenCount = count(
    row.terminal_active_token_count,
    "terminal active token count",
  );
  if (terminalActiveTokenCount > cardinality.tokenRows) {
    invalidResponse("returned inconsistent token cardinality");
  }
  const mapped = {
    runId,
    receiptId: uuid(row.receipt_id, "reserved receipt id"),
    ownerId: selectedOwner,
    agentId: selectedAgent,
    callerFunction: row.caller_function,
    state: runState(row.state),
    stateVersion: positiveIntegerString(row.state_version, "run state version"),
    billingMode: billingMode(row.billing_mode, "run billing mode"),
    capacityAgentId: uuid(row.capacity_agent_id, "capacity Agent id"),
    environmentDigest: row.environment_digest,
    directiveHash: hash(row.directive_hash, "directive hash"),
    requestHash: hash(row.request_hash, "request hash"),
    createdAt: timestamp(row.created_at, "run creation timestamp"),
    updatedAt: timestamp(row.updated_at, "run update timestamp"),
    expiresAt: timestamp(row.expires_at, "run expiry timestamp"),
    startedAt: nullableTimestamp(row.started_at, "run start timestamp"),
    finishedAt: nullableTimestamp(row.finished_at, "run finish timestamp"),
    cardinality,
    backing,
    budget,
    receipt,
    terminalActiveTokenCount,
    artifacts,
  } satisfies Omit<ComputeCertificationRun, "violations">;
  const createdAt = Date.parse(mapped.createdAt);
  if (
    createdAt < Date.parse(since) || createdAt > Date.parse(generatedAt)
  ) invalidResponse("returned a run outside the observation window");
  const violations = exactViolations(
    row.violations,
    RUN_VIOLATIONS,
    "run violations",
  );
  const expected = expectedRunViolations(mapped);
  const truncated = expected.includes("ARTIFACT_PROJECTION_TRUNCATED");
  if (truncated) {
    // The SQL checks every artifact, while the response deliberately caps the
    // safe artifact projection. A hidden row may therefore be the integrity
    // offender; every other code remains completely derivable here.
    const withoutIntegrity = (values: readonly string[]) =>
      values.filter((value) => value !== "ARTIFACT_INTEGRITY_INVALID");
    if (!sameValues(withoutIntegrity(violations), withoutIntegrity(expected))) {
      invalidResponse("returned inconsistent run violations");
    }
    if (
      expected.includes("ARTIFACT_INTEGRITY_INVALID") &&
      !violations.includes("ARTIFACT_INTEGRITY_INVALID")
    ) invalidResponse("omitted a projected artifact integrity violation");
  } else if (!sameValues(violations, expected)) {
    invalidResponse("returned inconsistent run violations");
  }
  return { ...mapped, violations };
}

function mapHealth(value: unknown): ComputeCertificationHealth {
  const row = record(value, HEALTH_KEYS, "health summary");
  const mapped = {
    staleNonterminalRuns: count(
      row.stale_nonterminal_runs,
      "stale nonterminal run count",
    ),
    oldSettlementPending: count(
      row.old_settlement_pending,
      "old settlement pending count",
    ),
    terminalReservedBudgets: count(
      row.terminal_reserved_budgets,
      "terminal reserved budget count",
    ),
    receiptMismatches: count(
      row.receipt_mismatches,
      "receipt mismatch count",
    ),
    terminalActiveTokens: count(
      row.terminal_active_tokens,
      "terminal active token count",
    ),
    dlqFencedRuns: count(row.dlq_fenced_runs, "DLQ-fenced run count"),
    stalePendingArtifacts: count(
      row.stale_pending_artifacts,
      "stale pending artifact count",
    ),
    unreconciledDeletedOutputs: count(
      row.unreconciled_deleted_outputs,
      "unreconciled deleted output count",
    ),
    terminalInputAliases: count(
      row.terminal_input_aliases,
      "terminal input alias count",
    ),
  };
  const violations = exactViolations(
    row.violations,
    HEALTH_VIOLATIONS,
    "health violations",
  );
  const expected: ComputeCertificationHealthViolation[] = [];
  if (mapped.dlqFencedRuns > 0) expected.push("DLQ_FENCED_RUNS");
  if (mapped.oldSettlementPending > 0) {
    expected.push("OLD_SETTLEMENT_PENDING");
  }
  if (mapped.receiptMismatches > 0) expected.push("RECEIPT_MISMATCHES");
  if (mapped.staleNonterminalRuns > 0) {
    expected.push("STALE_NONTERMINAL_RUNS");
  }
  if (mapped.stalePendingArtifacts > 0) {
    expected.push("STALE_PENDING_ARTIFACTS");
  }
  if (mapped.terminalActiveTokens > 0) {
    expected.push("TERMINAL_ACTIVE_TOKENS");
  }
  if (mapped.terminalInputAliases > 0) {
    expected.push("TERMINAL_INPUT_ALIASES");
  }
  if (mapped.terminalReservedBudgets > 0) {
    expected.push("TERMINAL_RESERVED_BUDGETS");
  }
  if (mapped.unreconciledDeletedOutputs > 0) {
    expected.push("UNRECONCILED_DELETED_OUTPUTS");
  }
  if (!sameValues(violations, expected)) {
    invalidResponse("returned inconsistent health violations");
  }
  return { ...mapped, violations };
}

function normalizeInput(
  input: ComputeCertificationInput,
  now: Date,
): ComputeCertificationInput {
  if (input === null || typeof input !== "object") {
    invalidInput("Compute certification input is required.");
  }
  if (
    !Array.isArray(input.runIds) || input.runIds.length < 1 ||
    input.runIds.length > MAX_SELECTED_RUNS
  ) {
    invalidInput(`runIds must contain 1 to ${MAX_SELECTED_RUNS} UUIDs.`);
  }
  const runIds = input.runIds.map((value, index) =>
    inputUuid(value, `runIds[${index}]`)
  );
  if (new Set(runIds).size !== runIds.length) {
    invalidInput("runIds must not contain duplicates.");
  }
  return {
    ownerId: inputUuid(input.ownerId, "ownerId"),
    agentId: inputUuid(input.agentId, "agentId"),
    runIds,
    since: inputTimestamp(input.since, now),
  };
}

function mapSnapshot(
  value: unknown,
  input: ComputeCertificationInput,
): ComputeCertificationSnapshot {
  // The RPC returns one scalar jsonb object. Accepting a PostgREST row array
  // here would hide a return-shape or schema drift at the certification wall.
  const row = record(value, TOP_LEVEL_KEYS, "top-level");
  if (row.schema_version !== 1) {
    invalidResponse("returned an unsupported schema version");
  }
  const ownerId = uuid(row.owner_id, "owner id");
  const agentId = uuid(row.agent_id, "Agent id");
  if (ownerId !== input.ownerId || agentId !== input.agentId) {
    invalidResponse("returned a different principal");
  }
  const generatedAt = timestamp(row.generated_at, "generation timestamp");
  const since = timestamp(row.since, "window timestamp");
  if (
    Date.parse(since) !== Date.parse(input.since) ||
    Date.parse(generatedAt) < Date.parse(since)
  ) invalidResponse("returned an inconsistent observation window");
  const latchState = row.latch_state;
  if (
    latchState !== "clear" && latchState !== "active" &&
    latchState !== "completed"
  ) invalidResponse("returned an invalid latch state");
  const requestedRunCount = count(
    row.requested_run_count,
    "requested run count",
  );
  const selectedRunCount = count(
    row.selected_run_count,
    "selected run count",
  );
  if (
    requestedRunCount !== input.runIds.length ||
    selectedRunCount > requestedRunCount
  ) invalidResponse("returned inconsistent selected-run counts");
  if (!Array.isArray(row.runs)) invalidResponse("returned invalid runs");
  const runs = row.runs.map((run) =>
    mapRun(run, ownerId, agentId, since, generatedAt)
  );
  if (runs.length !== selectedRunCount) {
    invalidResponse("returned inconsistent selected-run cardinality");
  }
  let lastInputIndex = -1;
  for (const run of runs) {
    const inputIndex = input.runIds.indexOf(run.runId);
    if (inputIndex <= lastInputIndex) {
      invalidResponse("returned an unknown, duplicate, or unordered run");
    }
    lastInputIndex = inputIndex;
  }
  const violations = exactViolations(
    row.violations,
    TOP_LEVEL_VIOLATIONS,
    "top-level violations",
  );
  const expected: TopLevelViolation[] = [];
  if (latchState !== "clear") expected.push("EMERGENCY_STOP_LATCH_SET");
  if (selectedRunCount !== requestedRunCount) {
    expected.push("SELECTED_RUN_CARDINALITY_MISMATCH");
  }
  if (!sameValues(violations, expected)) {
    invalidResponse("returned inconsistent top-level violations");
  }
  return {
    schemaVersion: 1,
    generatedAt,
    ownerId,
    agentId,
    since,
    latchState,
    requestedRunCount,
    selectedRunCount,
    runs,
    health: mapHealth(row.health),
    violations,
  };
}

export async function getComputeCertificationSnapshot(
  input: ComputeCertificationInput,
  deps: ComputeDatabaseDeps = {},
): Promise<ComputeCertificationSnapshot> {
  const normalized = normalizeInput(input, deps.now ?? new Date());
  let payload: unknown;
  try {
    payload = await callComputeRpc("get_compute_certification_snapshot", {
      p_owner_id: normalized.ownerId,
      p_agent_id: normalized.agentId,
      p_run_ids: normalized.runIds,
      p_since: normalized.since,
    }, deps);
  } catch (error) {
    if (error instanceof ComputeCertificationError) throw error;
    throw new ComputeCertificationError(
      "COMPUTE_CERTIFICATION_UNAVAILABLE",
      503,
      "Compute certification snapshot is unavailable.",
    );
  }
  return mapSnapshot(payload, normalized);
}
