import { getEnv } from "../lib/env.ts";
import { isAccountSessionAuthSource } from "./control-plane-auth.ts";
import type { RequestAuthSource } from "./request-auth.ts";
import {
  normalizeRoutineSchedule,
  type NormalizedProductionRoutineSchedule,
  RoutineScheduleValidationError,
} from "./routine-schedule.ts";

const REVISION_TOKEN_PREFIX = "ah1";
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSIENT_DATABASE_CODES = new Set(["40P01", "40001"]);
const MAX_RPC_ATTEMPTS = 3;

type AgentHomeRevisionErrorCode =
  | "ACCOUNT_SESSION_REQUIRED"
  | "AGENT_HOME_INVALID_REVISION"
  | "AGENT_HOME_REVISION_CONFLICT"
  | "AGENT_HOME_NOT_FOUND"
  | "AGENT_HOME_PRIVATE_REQUIRED"
  | "AGENT_HOME_ROUTINE_NOT_FOUND"
  | "AGENT_HOME_ROUTINE_DISABLED"
  | "AGENT_HOME_ACTIVE_AGENT_LIMIT"
  | "AGENT_HOME_CAPABILITY_NOT_FOUND"
  | "AGENT_HOME_ACTION_NOT_FOUND"
  | "AGENT_HOME_ACTION_IN_PROGRESS"
  | "AGENT_HOME_ACTION_RECOVERY_REQUIRED"
  | "AGENT_HOME_RUN_CONCURRENCY_LIMIT"
  | "AGENT_HOME_IDEMPOTENCY_MISMATCH"
  | "AGENT_HOME_INVALID_MUTATION"
  | "AGENT_HOME_SERVICE_UNAVAILABLE";

export class AgentHomeRevisionError extends Error {
  readonly code: AgentHomeRevisionErrorCode;
  readonly status: number;
  readonly statusCode: number;
  readonly currentRevision: string | null;
  readonly expectedRevision: string | null;
  readonly recovery: AgentHomeActionRecovery | null;

  constructor(input: {
    code: AgentHomeRevisionErrorCode;
    status: number;
    message: string;
    currentRevision?: string | null;
    expectedRevision?: string | null;
    recovery?: AgentHomeActionRecovery | null;
  }) {
    super(input.message);
    this.name = "AgentHomeRevisionError";
    this.code = input.code;
    this.status = input.status;
    this.statusCode = input.status;
    this.currentRevision = input.currentRevision ?? null;
    this.expectedRevision = input.expectedRevision ?? null;
    this.recovery = input.recovery ?? null;
  }
}

interface AgentHomeActionRecovery {
  requestId: string;
  idempotencyKey: string;
  action: string;
  requestPayload: Record<string, unknown>;
}

interface AgentHomeDatabaseDeps {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

type RevisionLike = string | number | bigint;
type EncryptedSettingMutation = Record<string, string | null>;

function normalizePositiveRevision(value: RevisionLike): string {
  if (typeof value === "bigint") {
    if (value < 1n) throw invalidRevision();
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) throw invalidRevision();
    return String(value);
  }
  const normalized = value.trim();
  if (!POSITIVE_DECIMAL.test(normalized)) throw invalidRevision();
  return BigInt(normalized).toString();
}

function invalidRevision(): AgentHomeRevisionError {
  return new AgentHomeRevisionError({
    code: "AGENT_HOME_INVALID_REVISION",
    status: 400,
    message: "The Agent Home revision is invalid.",
  });
}

function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_INVALID_MUTATION",
      status: 400,
      message: `${field} is required.`,
    });
  }
  return normalized;
}

function requireUuid(value: string, field: string): string {
  const normalized = requireIdentifier(value, field);
  if (!UUID.test(normalized)) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_INVALID_MUTATION",
      status: 400,
      message: `${field} must be a UUID.`,
    });
  }
  return normalized;
}

/**
 * App-bound opaque revision token. Binding prevents a valid token opened for
 * one Agent from being replayed against another Agent's edit endpoint.
 */
export function formatAgentHomeRevision(
  appId: string,
  revision: RevisionLike,
): string {
  const normalizedAppId = requireIdentifier(appId, "appId");
  return `${REVISION_TOKEN_PREFIX}:${encodeURIComponent(normalizedAppId)}:${
    normalizePositiveRevision(revision)
  }`;
}

/** Returns the lossless decimal bigint expected by the database RPC. */
export function parseAgentHomeRevision(
  token: string,
  expectedAppId: string,
): string {
  if (typeof token !== "string") throw invalidRevision();
  const parts = token.split(":");
  if (parts.length !== 3 || parts[0] !== REVISION_TOKEN_PREFIX) {
    throw invalidRevision();
  }
  let tokenAppId: string;
  try {
    tokenAppId = decodeURIComponent(parts[1]);
  } catch {
    throw invalidRevision();
  }
  if (tokenAppId !== requireIdentifier(expectedAppId, "appId")) {
    throw invalidRevision();
  }
  return normalizePositiveRevision(parts[2]);
}

function requireAccountSession(
  source: RequestAuthSource | string | null | undefined,
): void {
  if (isAccountSessionAuthSource(source)) return;
  throw new AgentHomeRevisionError({
    code: "ACCOUNT_SESSION_REQUIRED",
    status: 403,
    message: "This Agent Home action requires an account session.",
  });
}

function databaseConfig(deps: AgentHomeDatabaseDeps): {
  baseUrl: string;
  serviceRoleKey: string;
  fetchFn: typeof fetch;
} {
  const baseUrl = (deps.supabaseUrl ?? getEnv("SUPABASE_URL")).replace(
    /\/+$/,
    "",
  );
  const serviceRoleKey = deps.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !serviceRoleKey) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home persistence is not configured.",
    });
  }
  return { baseUrl, serviceRoleKey, fetchFn: deps.fetchFn ?? fetch };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function databaseErrorCode(value: unknown): AgentHomeRevisionErrorCode | null {
  const code = stringValue(value);
  switch (code) {
    case "AGENT_HOME_INVALID_REVISION":
    case "AGENT_HOME_REVISION_CONFLICT":
    case "AGENT_HOME_NOT_FOUND":
    case "AGENT_HOME_PRIVATE_REQUIRED":
    case "AGENT_HOME_ROUTINE_NOT_FOUND":
    case "AGENT_HOME_ROUTINE_DISABLED":
    case "AGENT_HOME_ACTIVE_AGENT_LIMIT":
    case "AGENT_HOME_CAPABILITY_NOT_FOUND":
    case "AGENT_HOME_ACTION_NOT_FOUND":
    case "AGENT_HOME_ACTION_IN_PROGRESS":
    case "AGENT_HOME_ACTION_RECOVERY_REQUIRED":
    case "AGENT_HOME_RUN_CONCURRENCY_LIMIT":
    case "AGENT_HOME_IDEMPOTENCY_MISMATCH":
    case "AGENT_HOME_INVALID_MUTATION":
      return code;
    default:
      return null;
  }
}

function parseDatabaseErrorPayload(
  value: unknown,
): Record<string, unknown> | null {
  const payload = asRecord(value);
  if (!payload) return null;
  const details = payload.details;
  if (typeof details === "string") {
    try {
      return asRecord(JSON.parse(details)) ?? payload;
    } catch {
      return payload;
    }
  }
  return asRecord(details) ?? payload;
}

function mappedStatus(code: AgentHomeRevisionErrorCode): number {
  switch (code) {
    case "AGENT_HOME_REVISION_CONFLICT":
      return 412;
    case "AGENT_HOME_PRIVATE_REQUIRED":
    case "AGENT_HOME_IDEMPOTENCY_MISMATCH":
    case "AGENT_HOME_ACTION_IN_PROGRESS":
    case "AGENT_HOME_ACTION_RECOVERY_REQUIRED":
    case "AGENT_HOME_RUN_CONCURRENCY_LIMIT":
    case "AGENT_HOME_ROUTINE_DISABLED":
    case "AGENT_HOME_ACTIVE_AGENT_LIMIT":
      return 409;
    case "AGENT_HOME_NOT_FOUND":
    case "AGENT_HOME_ROUTINE_NOT_FOUND":
    case "AGENT_HOME_CAPABILITY_NOT_FOUND":
    case "AGENT_HOME_ACTION_NOT_FOUND":
      return 404;
    case "AGENT_HOME_INVALID_REVISION":
    case "AGENT_HOME_INVALID_MUTATION":
      return 400;
    case "ACCOUNT_SESSION_REQUIRED":
      return 403;
    case "AGENT_HOME_SERVICE_UNAVAILABLE":
      return 503;
  }
}

async function responseError(
  response: Response,
  appId: string,
): Promise<AgentHomeRevisionError> {
  const payload = await response.json().catch(() => null);
  const detail = parseDatabaseErrorPayload(payload);
  const code = databaseErrorCode(detail?.code) ??
    "AGENT_HOME_SERVICE_UNAVAILABLE";
  const actual = stringValue(detail?.actualRevision);
  const expected = stringValue(detail?.expectedRevision);
  const recoveryPayload = asRecord(detail?.requestPayload);
  const recoveryRequestId = stringValue(detail?.requestId);
  const recoveryIdempotencyKey = stringValue(detail?.idempotencyKey);
  const recoveryAction = stringValue(detail?.action);
  const recovery = code === "AGENT_HOME_ACTION_RECOVERY_REQUIRED" &&
      recoveryRequestId && UUID.test(recoveryRequestId) &&
      recoveryIdempotencyKey && UUID.test(recoveryIdempotencyKey) &&
      recoveryAction && recoveryPayload
    ? {
      requestId: recoveryRequestId,
      idempotencyKey: recoveryIdempotencyKey,
      action: recoveryAction,
      requestPayload: recoveryPayload,
    }
    : null;
  return new AgentHomeRevisionError({
    code,
    status: mappedStatus(code),
    message: code === "AGENT_HOME_REVISION_CONFLICT"
      ? "This Agent changed after the page was loaded. Refresh before retrying."
      : code === "AGENT_HOME_NOT_FOUND" ||
          code === "AGENT_HOME_ROUTINE_NOT_FOUND"
      ? "Agent Home was not found."
      : code === "AGENT_HOME_CAPABILITY_NOT_FOUND"
      ? "An Agent capability was not found."
      : code === "AGENT_HOME_ACTION_NOT_FOUND"
      ? "The Agent Home action request was not found."
      : code === "AGENT_HOME_ROUTINE_DISABLED"
      ? "A disabled routine cannot be paused."
      : code === "AGENT_HOME_ACTIVE_AGENT_LIMIT"
      ? "Free includes one active Agent. Pause the active Agent or upgrade before activating this one."
      : code === "AGENT_HOME_ACTION_IN_PROGRESS"
      ? "The Agent Home action is owned by another active attempt."
      : code === "AGENT_HOME_ACTION_RECOVERY_REQUIRED"
      ? "A previous Agent Home action must be reconciled before a different action can begin."
      : code === "AGENT_HOME_RUN_CONCURRENCY_LIMIT"
      ? "The Agent already has the maximum number of active runs."
      : code === "AGENT_HOME_PRIVATE_REQUIRED"
      ? "Agent Home is available only for private Agents in this launch."
      : code === "AGENT_HOME_IDEMPOTENCY_MISMATCH"
      ? "The idempotency key was already used for a different action."
      : code === "AGENT_HOME_INVALID_MUTATION" ||
          code === "AGENT_HOME_INVALID_REVISION"
      ? "The Agent Home mutation is invalid."
      : `Agent Home persistence is unavailable (${response.status}).`,
    currentRevision: actual ? formatAgentHomeRevision(appId, actual) : null,
    expectedRevision: expected
      ? formatAgentHomeRevision(appId, expected)
      : null,
    recovery,
  });
}

async function callRpc(
  rpc: string,
  body: Record<string, unknown>,
  appId: string,
  deps: AgentHomeDatabaseDeps,
): Promise<unknown> {
  const { baseUrl, serviceRoleKey, fetchFn } = databaseConfig(deps);
  for (let attempt = 1; attempt <= MAX_RPC_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/rest/v1/rpc/${rpc}`, {
        method: "POST",
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      // A transport failure can be an acknowledgement failure after commit.
      // The action layer owns reconciliation; blindly repeating here would be
      // unsafe for RPCs with side effects.
      throw new AgentHomeRevisionError({
        code: "AGENT_HOME_SERVICE_UNAVAILABLE",
        status: 503,
        message: "Agent Home persistence is unavailable.",
      });
    }
    if (response.ok) return await response.json().catch(() => null);

    const retryPayload = attempt < MAX_RPC_ATTEMPTS
      ? await response.clone().json().catch(() => null)
      : null;
    const retryCode = stringValue(asRecord(retryPayload)?.code)?.toUpperCase();
    if (
      attempt < MAX_RPC_ATTEMPTS && retryCode &&
      TRANSIENT_DATABASE_CODES.has(retryCode)
    ) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
      continue;
    }
    throw await responseError(response, appId);
  }
  throw new AgentHomeRevisionError({
    code: "AGENT_HOME_SERVICE_UNAVAILABLE",
    status: 503,
    message: "Agent Home persistence is unavailable.",
  });
}

function firstRow(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload)) return asRecord(payload[0]);
  return asRecord(payload);
}

function scalarString(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (typeof payload === "number" && Number.isSafeInteger(payload)) {
    return String(payload);
  }
  return null;
}

function revisionFromMutation(payload: unknown, appId: string): string {
  const revision = stringValue(firstRow(payload)?.new_revision);
  if (!revision) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home persistence returned no revision.",
    });
  }
  return formatAgentHomeRevision(appId, revision);
}

function mutationBase(input: {
  appId: string;
  userId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
}): {
  appId: string;
  userId: string;
  expectedRevision: string;
} {
  requireAccountSession(input.authSource);
  const appId = requireIdentifier(input.appId, "appId");
  return {
    appId,
    userId: requireIdentifier(input.userId, "userId"),
    expectedRevision: parseAgentHomeRevision(input.expectedRevision, appId),
  };
}

/** Returns an app-bound `ah1:...` revision token, never a bare counter. */
async function getAgentHomeRevisionToken(
  appId: string,
  userId: string,
  deps: AgentHomeDatabaseDeps = {},
): Promise<string | null> {
  const normalizedAppId = requireIdentifier(appId, "appId");
  try {
    const payload = await callRpc(
      "get_agent_home_revision",
      {
        p_app_id: normalizedAppId,
        p_user_id: requireIdentifier(userId, "userId"),
      },
      normalizedAppId,
      deps,
    );
    const revision = scalarString(payload);
    if (!revision) {
      throw new AgentHomeRevisionError({
        code: "AGENT_HOME_SERVICE_UNAVAILABLE",
        status: 503,
        message: "Agent Home persistence returned no revision.",
      });
    }
    return formatAgentHomeRevision(normalizedAppId, revision);
  } catch (error) {
    if (
      error instanceof AgentHomeRevisionError &&
      (error.code === "AGENT_HOME_NOT_FOUND" ||
        error.code === "AGENT_HOME_PRIVATE_REQUIRED")
    ) {
      return null;
    }
    throw error;
  }
}

/** Backwards-compatible route-service name; the value is still a token. */
export const getAgentHomeRevision = getAgentHomeRevisionToken;

/**
 * Revalidates the owner/private revision immediately before a non-config read
 * action such as run-now. The action itself must revalidate runtime blockers.
 */
export async function assertAgentHomeRevision(input: {
  appId: string;
  userId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  const base = mutationBase(input);
  await callRpc(
    "assert_agent_home_revision",
    {
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_expected_revision: base.expectedRevision,
    },
    base.appId,
    deps,
  );
  return formatAgentHomeRevision(base.appId, base.expectedRevision);
}

export async function updateAgentHomeIdentityCAS(input: {
  appId: string;
  userId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
  name?: string;
  description?: string | null;
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  const base = mutationBase(input);
  const setName = Object.prototype.hasOwnProperty.call(input, "name");
  const setDescription = Object.prototype.hasOwnProperty.call(
    input,
    "description",
  );
  const payload = await callRpc(
    "update_agent_home_identity",
    {
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_expected_revision: base.expectedRevision,
      p_set_name: setName,
      p_name: setName ? input.name ?? null : null,
      p_set_description: setDescription,
      p_description: setDescription ? input.description ?? null : null,
    },
    base.appId,
    deps,
  );
  return revisionFromMutation(payload, base.appId);
}

interface AgentHomeBudgetPolicyInput {
  maxLightPerRun: number;
  maxLightPerDay: number;
  maxLightPerMonth: number;
  maxCallsPerRun: number;
}

function invalidMutation(message: string): AgentHomeRevisionError {
  return new AgentHomeRevisionError({
    code: "AGENT_HOME_INVALID_MUTATION",
    status: 400,
    message,
  });
}

function requireNormalizedSchedule(
  value: unknown,
): NormalizedProductionRoutineSchedule {
  let normalized: NormalizedProductionRoutineSchedule;
  try {
    normalized = normalizeRoutineSchedule(value);
  } catch (error) {
    if (error instanceof RoutineScheduleValidationError) {
      throw invalidMutation(`The routine schedule is invalid: ${error.message}`);
    }
    throw error;
  }
  const supplied = asRecord(value);
  if (!supplied) {
    throw invalidMutation("The routine schedule must use normalized JSON.");
  }
  const expectedKeys = normalized.type === "interval"
    ? ["every_seconds", "type"]
    : ["cron", "timezone", "type"];
  const suppliedKeys = Object.keys(supplied).sort();
  const hasExactKeys = suppliedKeys.length === expectedKeys.length &&
    suppliedKeys.every((key, index) => key === expectedKeys[index]);
  const hasExactValues = normalized.type === "interval"
    ? supplied.type === "interval" &&
      supplied.every_seconds === normalized.every_seconds
    : supplied.type === "cron" && supplied.cron === normalized.cron &&
      supplied.timezone === normalized.timezone;
  if (!hasExactKeys || !hasExactValues) {
    throw invalidMutation(
      "The routine schedule must be normalized before the CAS mutation.",
    );
  }
  return normalized;
}

function optionalActiveNextRunAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw invalidMutation("activeNextRunAt must be an ISO timestamp or null.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw invalidMutation("activeNextRunAt must be a valid ISO timestamp.");
  }
  return new Date(parsed).toISOString();
}

export async function updateAgentHomeRoutineCAS(input: {
  appId: string;
  userId: string;
  routineId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
  mission?: string | null;
  intervalSeconds?: number;
  budgets?: AgentHomeBudgetPolicyInput;
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  const base = mutationBase(input);
  const setMission = Object.prototype.hasOwnProperty.call(input, "mission");
  const setInterval = Object.prototype.hasOwnProperty.call(
    input,
    "intervalSeconds",
  );
  const setBudget = Object.prototype.hasOwnProperty.call(input, "budgets");
  const budget = input.budgets;
  const payload = await callRpc(
    "update_agent_home_routine",
    {
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_routine_id: requireIdentifier(input.routineId, "routineId"),
      p_expected_revision: base.expectedRevision,
      p_set_mission: setMission,
      p_mission: setMission ? input.mission ?? null : null,
      p_set_interval: setInterval,
      p_interval_seconds: setInterval ? input.intervalSeconds ?? null : null,
      p_set_budget: setBudget,
      p_budget_policy: setBudget && budget
        ? {
          max_light_per_run: budget.maxLightPerRun,
          max_light_per_day: budget.maxLightPerDay,
          max_light_per_month: budget.maxLightPerMonth,
          max_calls_per_run: budget.maxCallsPerRun,
        }
        : null,
    },
    base.appId,
    deps,
  );
  return revisionFromMutation(payload, base.appId);
}

/**
 * Edit any launch-managed routine belonging to an owner-private Agent.
 *
 * Unlike the legacy primary-routine helper above, this contract accepts the
 * full normalized interval-or-cron schedule. The trusted API computes the
 * active routine's next occurrence and supplies it as `activeNextRunAt`; the
 * database never attempts to reinterpret cron or timezone semantics.
 */
export async function updateAgentHomeManagedRoutineCAS(input: {
  appId: string;
  userId: string;
  routineId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
  name?: string;
  description?: string | null;
  mission?: string | null;
  schedule?: NormalizedProductionRoutineSchedule;
  activeNextRunAt?: string | null;
  budgets?: AgentHomeBudgetPolicyInput;
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  const base = mutationBase(input);
  const setName = Object.prototype.hasOwnProperty.call(input, "name");
  const setDescription = Object.prototype.hasOwnProperty.call(
    input,
    "description",
  );
  const setMission = Object.prototype.hasOwnProperty.call(input, "mission");
  const setSchedule = Object.prototype.hasOwnProperty.call(input, "schedule");
  const setBudget = Object.prototype.hasOwnProperty.call(input, "budgets");
  const suppliedNextRun = Object.prototype.hasOwnProperty.call(
    input,
    "activeNextRunAt",
  );
  if (
    !setName && !setDescription && !setMission && !setSchedule && !setBudget
  ) {
    throw invalidMutation("At least one managed routine field is required.");
  }
  if (suppliedNextRun && !setSchedule) {
    throw invalidMutation(
      "activeNextRunAt may be supplied only with a schedule mutation.",
    );
  }
  const schedule = setSchedule
    ? requireNormalizedSchedule(input.schedule)
    : null;
  const activeNextRunAt = setSchedule
    ? optionalActiveNextRunAt(input.activeNextRunAt)
    : null;
  const budget = input.budgets;
  const payload = await callRpc(
    "update_agent_home_managed_routine",
    {
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_routine_id: requireUuid(input.routineId, "routineId"),
      p_expected_revision: base.expectedRevision,
      p_set_name: setName,
      p_name: setName ? input.name ?? null : null,
      p_set_description: setDescription,
      p_description: setDescription ? input.description ?? null : null,
      p_set_mission: setMission,
      p_mission: setMission ? input.mission ?? null : null,
      p_set_schedule: setSchedule,
      p_schedule: schedule,
      p_active_next_run_at: activeNextRunAt,
      p_set_budget: setBudget,
      p_budget_policy: setBudget && budget
        ? {
          max_light_per_run: budget.maxLightPerRun,
          max_light_per_day: budget.maxLightPerDay,
          max_light_per_month: budget.maxLightPerMonth,
          max_calls_per_run: budget.maxCallsPerRun,
        }
        : null,
    },
    base.appId,
    deps,
  );
  return revisionFromMutation(payload, base.appId);
}

/**
 * The caller must encrypt every non-null value inside the trusted API process.
 * This API deliberately has no plaintext `values` parameter.
 */
export async function updateAgentHomeSettingsCAS(input: {
  appId: string;
  userId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
  agentCiphertexts: EncryptedSettingMutation;
  perUserCiphertexts: EncryptedSettingMutation;
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  const base = mutationBase(input);
  const payload = await callRpc(
    "update_agent_home_settings",
    {
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_expected_revision: base.expectedRevision,
      p_agent_ciphertexts: input.agentCiphertexts,
      p_per_user_ciphertexts: input.perUserCiphertexts,
    },
    base.appId,
    deps,
  );
  return revisionFromMutation(payload, base.appId);
}

export async function updateAgentHomeRoutineStatusCAS(input: {
  appId: string;
  userId: string;
  routineId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
  status: "active" | "paused";
  nextRunAt?: string | null;
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  const base = mutationBase(input);
  const payload = await callRpc(
    "update_agent_home_routine_status",
    {
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_routine_id: requireIdentifier(input.routineId, "routineId"),
      p_expected_revision: base.expectedRevision,
      p_status: input.status,
      p_next_run_at: input.nextRunAt ?? null,
    },
    base.appId,
    deps,
  );
  return revisionFromMutation(payload, base.appId);
}

/**
 * Atomically activate or pause one launch-managed routine under Agent Home
 * revision CAS. The database serializes the Free Agent slot with the status
 * write and releases it only when the last active sibling has stopped.
 */
export async function updateAgentHomeManagedRoutineStatusCAS(input: {
  appId: string;
  userId: string;
  routineId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
  status: "active" | "paused";
  nextRunAt?: string | null;
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  const base = mutationBase(input);
  if (input.status !== "active" && input.status !== "paused") {
    throw invalidMutation("status must be active or paused.");
  }
  const nextRunAt = optionalActiveNextRunAt(input.nextRunAt);
  if (input.status === "active" && nextRunAt === null) {
    throw invalidMutation(
      "nextRunAt is required when activating a managed routine.",
    );
  }
  if (input.status === "paused" && nextRunAt !== null) {
    throw invalidMutation("A paused managed routine cannot have nextRunAt.");
  }
  const payload = await callRpc(
    "update_agent_home_managed_routine_status",
    {
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_routine_id: requireUuid(input.routineId, "routineId"),
      p_expected_revision: base.expectedRevision,
      p_status: input.status,
      p_next_run_at: nextRunAt,
    },
    base.appId,
    deps,
  );
  return revisionFromMutation(payload, base.appId);
}

export async function pauseAgentHomeRoutineEmergency(input: {
  appId: string;
  userId: string;
  authSource: RequestAuthSource | string | null | undefined;
}, deps: AgentHomeDatabaseDeps = {}): Promise<{
  routineId: string;
  status: "paused";
  revision: string;
}> {
  requireAccountSession(input.authSource);
  const appId = requireIdentifier(input.appId, "appId");
  const payload = await callRpc(
    "pause_agent_home_routine_emergency",
    {
      p_app_id: appId,
      p_user_id: requireIdentifier(input.userId, "userId"),
    },
    appId,
    deps,
  );
  const row = firstRow(payload);
  const routineId = stringValue(row?.routine_id);
  const revision = stringValue(row?.new_revision);
  if (
    !routineId || !UUID.test(routineId) || row?.routine_status !== "paused" ||
    !revision
  ) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home emergency pause returned an invalid result.",
    });
  }
  return {
    routineId,
    status: "paused",
    revision: formatAgentHomeRevision(appId, revision),
  };
}

export async function approveAgentHomeCapabilitiesCAS(input: {
  appId: string;
  userId: string;
  routineId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
  capabilityIds: string[];
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  const base = mutationBase(input);
  const payload = await callRpc(
    "approve_agent_home_capabilities",
    {
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_routine_id: requireIdentifier(input.routineId, "routineId"),
      p_expected_revision: base.expectedRevision,
      p_capability_ids: input.capabilityIds,
    },
    base.appId,
    deps,
  );
  return revisionFromMutation(payload, base.appId);
}

interface AgentHomeActionClaim {
  requestId: string;
  leaseToken: string;
  isNew: boolean;
  status: "in_progress" | "completed" | "failed";
  response: Record<string, unknown>;
  requestFingerprint: string;
  currentRevision: string;
}

interface AgentHomeActionRequestPayload {
  capabilityIds?: string[];
  routineId?: string;
  version?: string;
}

function actionStatus(value: unknown): AgentHomeActionClaim["status"] | null {
  return value === "in_progress" || value === "completed" || value === "failed"
    ? value
    : null;
}

function canonicalActionPayload(
  action: string,
  payload: AgentHomeActionRequestPayload,
): Record<string, unknown> {
  const capabilityIds = payload.capabilityIds === undefined ? [] : [
    ...new Set(
      payload.capabilityIds.map((id) => requireIdentifier(id, "capabilityId")),
    ),
  ]
    .sort();
  if (payload.version !== undefined && typeof payload.version !== "string") {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_INVALID_MUTATION",
      status: 400,
      message: "version must be a string.",
    });
  }
  const routineId = payload.routineId === undefined
    ? undefined
    : requireUuid(payload.routineId, "routineId");
  return {
    action: requireIdentifier(action, "action"),
    capabilityIds,
    version: payload.version ?? null,
    ...(routineId ? { routineId } : {}),
  };
}

export async function claimAgentHomeAction(input: {
  appId: string;
  userId: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
  idempotencyKey: string;
  action: string;
  requestPayload?: AgentHomeActionRequestPayload;
}, deps: AgentHomeDatabaseDeps = {}): Promise<AgentHomeActionClaim> {
  const base = mutationBase(input);
  const requestPayload = canonicalActionPayload(
    input.action,
    input.requestPayload ?? {},
  );
  const payload = await callRpc(
    "claim_agent_home_action",
    {
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_expected_revision: base.expectedRevision,
      p_idempotency_key: input.idempotencyKey,
      p_action: input.action,
      p_request_payload: requestPayload,
    },
    base.appId,
    deps,
  );
  const row = firstRow(payload);
  const requestId = stringValue(row?.request_id);
  const leaseToken = stringValue(row?.request_lease_token);
  const status = actionStatus(row?.request_status);
  const response = asRecord(row?.request_response);
  const requestFingerprint = stringValue(row?.request_fingerprint);
  const currentRevision = stringValue(row?.current_revision);
  if (
    !row || !requestId || !UUID.test(requestId) || !leaseToken ||
    !UUID.test(leaseToken) || !status || !response || !requestFingerprint ||
    !/^[a-f0-9]{64}$/.test(requestFingerprint) || !currentRevision ||
    typeof row.is_new !== "boolean"
  ) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home action claim returned an invalid result.",
    });
  }
  return {
    requestId,
    leaseToken,
    isNew: row.is_new,
    status,
    response,
    requestFingerprint,
    currentRevision: formatAgentHomeRevision(base.appId, currentRevision),
  };
}

export async function completeAgentHomeAction(input: {
  appId: string;
  userId: string;
  requestId: string;
  leaseToken: string;
  authSource: RequestAuthSource | string | null | undefined;
  status: "completed" | "failed";
  response: Record<string, unknown>;
}, deps: AgentHomeDatabaseDeps = {}): Promise<{
  requestId: string;
  status: "completed" | "failed";
  response: Record<string, unknown>;
}> {
  requireAccountSession(input.authSource);
  const appId = requireIdentifier(input.appId, "appId");
  const payload = await callRpc(
    "complete_agent_home_action",
    {
      p_request_id: requireUuid(input.requestId, "requestId"),
      p_app_id: appId,
      p_user_id: requireIdentifier(input.userId, "userId"),
      p_lease_token: requireUuid(input.leaseToken, "leaseToken"),
      p_status: input.status,
      p_response: input.response,
    },
    appId,
    deps,
  );
  const row = firstRow(payload);
  const requestId = stringValue(row?.request_id);
  const status = actionStatus(row?.request_status);
  const response = asRecord(row?.request_response);
  if (
    !requestId || (status !== "completed" && status !== "failed") || !response
  ) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home action completion returned an invalid result.",
    });
  }
  return { requestId, status, response };
}

/**
 * Fences every irreversible external promotion step. Renewal is accepted only
 * while this exact attempt still owns a live lease; an expired/stale worker can
 * neither regain ownership nor continue mutating runtime state.
 */
export async function renewAgentHomeActionLease(input: {
  appId: string;
  userId: string;
  requestId: string;
  leaseToken: string;
  authSource: RequestAuthSource | string | null | undefined;
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  requireAccountSession(input.authSource);
  const appId = requireIdentifier(input.appId, "appId");
  const payload = await callRpc(
    "renew_agent_home_action_lease",
    {
      p_request_id: requireUuid(input.requestId, "requestId"),
      p_app_id: appId,
      p_user_id: requireIdentifier(input.userId, "userId"),
      p_lease_token: requireUuid(input.leaseToken, "leaseToken"),
    },
    appId,
    deps,
  );
  const expiresAt = scalarString(payload);
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home lease renewal returned an invalid result.",
    });
  }
  return expiresAt;
}

type AgentHomePromotionStep =
  | "d1"
  | "live_bundle"
  | "app_record"
  | "storage_accounting";

/**
 * Fence one irreversible promotion phase with the durable request lease. The
 * database checks the owner's reviewed revision atomically on the first phase
 * and advances a durable saga marker used by later repair attempts.
 */
export async function fenceAgentHomePromotionStep(input: {
  appId: string;
  userId: string;
  requestId: string;
  leaseToken: string;
  authSource: RequestAuthSource | string | null | undefined;
  step: AgentHomePromotionStep;
}, deps: AgentHomeDatabaseDeps = {}): Promise<{
  leaseExpiresAt: string;
  currentRevision: string;
}> {
  requireAccountSession(input.authSource);
  const appId = requireIdentifier(input.appId, "appId");
  const payload = await callRpc(
    "fence_agent_home_promotion_step",
    {
      p_request_id: requireUuid(input.requestId, "requestId"),
      p_app_id: appId,
      p_user_id: requireIdentifier(input.userId, "userId"),
      p_lease_token: requireUuid(input.leaseToken, "leaseToken"),
      p_step: input.step,
    },
    appId,
    deps,
  );
  const row = firstRow(payload);
  const leaseExpiresAt = stringValue(row?.lease_expires_at);
  const currentRevision = stringValue(row?.current_revision);
  if (
    !leaseExpiresAt || !Number.isFinite(Date.parse(leaseExpiresAt)) ||
    !currentRevision
  ) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home promotion fencing returned an invalid result.",
    });
  }
  return {
    leaseExpiresAt,
    currentRevision: formatAgentHomeRevision(appId, currentRevision),
  };
}

/** Commit only the release fields owned by the fenced promotion saga. */
export async function commitAgentHomePromotionAppRecord(input: {
  appId: string;
  userId: string;
  requestId: string;
  leaseToken: string;
  authSource: RequestAuthSource | string | null | undefined;
  version: string;
  storageKey: string;
  exports: string[];
  manifest: string | null;
  envSchema: Record<string, unknown> | null;
}, deps: AgentHomeDatabaseDeps = {}): Promise<string> {
  requireAccountSession(input.authSource);
  const appId = requireIdentifier(input.appId, "appId");
  const payload = await callRpc(
    "commit_agent_home_promotion_app_record",
    {
      p_request_id: requireUuid(input.requestId, "requestId"),
      p_app_id: appId,
      p_user_id: requireIdentifier(input.userId, "userId"),
      p_lease_token: requireUuid(input.leaseToken, "leaseToken"),
      p_version: requireIdentifier(input.version, "version"),
      p_storage_key: requireIdentifier(input.storageKey, "storageKey"),
      p_exports: input.exports,
      p_set_manifest: input.manifest !== null,
      p_manifest: input.manifest,
      p_env_schema: input.envSchema ?? {},
    },
    appId,
    deps,
  );
  return revisionFromMutation(payload, appId);
}

export async function queueAgentHomeRoutineRun(input: {
  appId: string;
  userId: string;
  routineId: string;
  requestId: string;
  leaseToken: string;
  expectedRevision: string;
  authSource: RequestAuthSource | string | null | undefined;
}, deps: AgentHomeDatabaseDeps = {}): Promise<{
  runId: string;
  isNew: boolean;
}> {
  const base = mutationBase(input);
  const payload = await callRpc(
    "queue_agent_home_routine_run",
    {
      p_request_id: requireUuid(input.requestId, "requestId"),
      p_app_id: base.appId,
      p_user_id: base.userId,
      p_routine_id: requireUuid(input.routineId, "routineId"),
      p_lease_token: requireUuid(input.leaseToken, "leaseToken"),
      p_expected_revision: base.expectedRevision,
    },
    base.appId,
    deps,
  );
  const row = firstRow(payload);
  const runId = stringValue(row?.run_id);
  if (!runId || !UUID.test(runId) || typeof row?.is_new !== "boolean") {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home run queue returned an invalid result.",
    });
  }
  return { runId, isNew: row.is_new };
}

interface AgentHomeBudgetUsageRow {
  [key: string]: unknown;
  day_started_at?: unknown;
  month_started_at?: unknown;
  day_settled_light?: unknown;
  day_reserved_light?: unknown;
  day_total_light?: unknown;
  month_settled_light?: unknown;
  month_reserved_light?: unknown;
  month_total_light?: unknown;
  last_run_id?: unknown;
  last_run_settled_light?: unknown;
  last_run_reserved_light?: unknown;
  last_run_total_light?: unknown;
  last_run_calls?: unknown;
  calls_by_run?: unknown;
}

interface AgentHomeBudgetUsageResult {
  lastRunId: string | null;
  lastRun: number;
  lastRunSettled: number;
  lastRunReserved: number;
  lastRunCalls: number;
  daily: number;
  daySettled: number;
  dayReserved: number;
  monthly: number;
  monthSettled: number;
  monthReserved: number;
  dayStartedAt: string;
  monthStartedAt: string;
  callsByRun: ReadonlyMap<string, number>;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: `Agent Home budget returned invalid ${field}.`,
    });
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = nonNegativeNumber(value, field);
  if (!Number.isSafeInteger(parsed)) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: `Agent Home budget returned invalid ${field}.`,
    });
  }
  return parsed;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  const parsed = stringValue(value);
  if (!parsed) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: `Agent Home budget returned invalid ${field}.`,
    });
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: `Agent Home budget returned invalid ${field}.`,
    });
  }
  return value;
}

export async function getAgentHomeBudgetUsage(input: {
  userId: string;
  routineId: string;
  recentRunIds: string[];
  now?: Date;
}, deps: AgentHomeDatabaseDeps = {}): Promise<AgentHomeBudgetUsageResult> {
  const routineId = requireIdentifier(input.routineId, "routineId");
  const params: Record<string, unknown> = {
    p_user_id: requireIdentifier(input.userId, "userId"),
    p_routine_id: routineId,
    p_recent_run_ids: input.recentRunIds,
  };
  // Production omits p_now so the same database clock defines windows for
  // both hard admission and owner-facing usage. Tests may inject a boundary.
  if (input.now) params.p_now = input.now.toISOString();
  const payload = await callRpc(
    "get_agent_home_budget_usage",
    params,
    routineId,
    deps,
  );
  const raw = firstRow(payload) as AgentHomeBudgetUsageRow | null;
  if (!raw) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home budget returned no result.",
    });
  }
  const callsObject = asRecord(raw.calls_by_run);
  if (!callsObject) {
    throw new AgentHomeRevisionError({
      code: "AGENT_HOME_SERVICE_UNAVAILABLE",
      status: 503,
      message: "Agent Home budget returned invalid action counts.",
    });
  }
  const callsByRun = new Map<string, number>();
  for (const [runId, value] of Object.entries(callsObject)) {
    callsByRun.set(runId, nonNegativeInteger(value, `callsByRun.${runId}`));
  }
  return {
    lastRunId: nullableString(raw.last_run_id, "lastRunId"),
    lastRun: nonNegativeNumber(raw.last_run_total_light, "lastRun"),
    lastRunSettled: nonNegativeNumber(
      raw.last_run_settled_light,
      "lastRunSettled",
    ),
    lastRunReserved: nonNegativeNumber(
      raw.last_run_reserved_light,
      "lastRunReserved",
    ),
    lastRunCalls: nonNegativeInteger(raw.last_run_calls, "lastRunCalls"),
    daily: nonNegativeNumber(raw.day_total_light, "daily"),
    daySettled: nonNegativeNumber(raw.day_settled_light, "daySettled"),
    dayReserved: nonNegativeNumber(raw.day_reserved_light, "dayReserved"),
    monthly: nonNegativeNumber(raw.month_total_light, "monthly"),
    monthSettled: nonNegativeNumber(raw.month_settled_light, "monthSettled"),
    monthReserved: nonNegativeNumber(raw.month_reserved_light, "monthReserved"),
    dayStartedAt: timestamp(raw.day_started_at, "dayStartedAt"),
    monthStartedAt: timestamp(raw.month_started_at, "monthStartedAt"),
    callsByRun,
  };
}
