import { getEnv } from "../lib/env.ts";
import type {
  RoutineApprovalPolicy,
  RoutineBudgetDefaults,
  RoutineCapabilityAccess,
  RoutineCapabilityDeclaration,
  RoutineScheduleDeclaration,
} from "../../shared/contracts/routine.ts";
import {
  DEFAULT_ROUTINE_BUDGET_POLICY,
  MIN_ROUTINE_INTERVAL_SECONDS,
} from "../../shared/contracts/routine.ts";

export type RoutineStatus =
  | "active"
  | "paused"
  | "disabled"
  | "deleted"
  | "error";
export type RoutineRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";
export type RoutineRunStepStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "skipped";

export interface RoutineCapabilityInput {
  app_id?: unknown;
  app?: unknown;
  app_ref?: unknown;
  function_name?: unknown;
  functions?: unknown;
  access?: unknown;
  required?: unknown;
  purpose?: unknown;
  approved?: unknown;
  pricing_snapshot?: unknown;
  constraints?: unknown;
  metadata?: unknown;
}

export interface RoutineDashboardBindingInput {
  dashboard_key?: unknown;
  app_id?: unknown;
  app?: unknown;
  app_ref?: unknown;
  widget_id?: unknown;
  card_id?: unknown;
  config?: unknown;
}

export interface RoutineCreateInput {
  composer_app_id?: unknown;
  composer_app_slug?: unknown;
  template_id?: unknown;
  template_version?: unknown;
  name?: unknown;
  description?: unknown;
  intent?: unknown;
  handler_function?: unknown;
  schedule?: unknown;
  config?: unknown;
  budget_policy?: unknown;
  approval_policy?: unknown;
  max_concurrency?: unknown;
  next_run_at?: unknown;
  created_by_trace_id?: unknown;
  metadata?: unknown;
  capabilities?: unknown;
  dashboard_bindings?: unknown;
}

export interface NormalizedRoutineCreateInput {
  routine: {
    composer_app_id: string | null;
    composer_app_slug: string | null;
    template_id: string;
    template_version: string | null;
    name: string;
    description: string | null;
    intent: string | null;
    handler_function: string;
    status: RoutineStatus;
    schedule: NormalizedRoutineSchedule;
    config: Record<string, unknown>;
    budget_policy: RoutineBudgetDefaults;
    approval_policy: RoutineApprovalPolicy;
    max_concurrency: number;
    next_run_at: string | null;
    created_by_trace_id: string | null;
    metadata: Record<string, unknown>;
  };
  capabilities: NormalizedRoutineCapabilityInput[];
  dashboard_bindings: NormalizedRoutineDashboardBindingInput[];
}

export interface NormalizedRoutineSchedule {
  type: "interval" | "cron";
  cron?: string;
  every_seconds?: number;
  every_minutes?: number;
  timezone?: string;
}

export interface NormalizedRoutineCapabilityInput {
  app_id: string | null;
  app_ref: string;
  function_name: string;
  access: RoutineCapabilityAccess;
  required: boolean;
  purpose: string | null;
  approved: boolean;
  approved_at: string | null;
  pricing_snapshot: Record<string, unknown>;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface NormalizedRoutineDashboardBindingInput {
  dashboard_key: string;
  app_id: string | null;
  app_ref: string | null;
  widget_id: string;
  card_id: string | null;
  config: Record<string, unknown>;
}

interface RoutineRow {
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
  status: RoutineStatus;
  schedule: NormalizedRoutineSchedule;
  config: Record<string, unknown>;
  budget_policy: RoutineBudgetDefaults;
  approval_policy: RoutineApprovalPolicy;
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
}

export interface RoutineCapabilityRow {
  id: string;
  routine_id: string;
  user_id: string;
  app_id: string | null;
  app_ref: string;
  function_name: string;
  access: RoutineCapabilityAccess;
  required: boolean;
  purpose: string | null;
  approved: boolean;
  approved_at: string | null;
  approved_by_user_id: string | null;
  pricing_snapshot: Record<string, unknown>;
  constraints: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RoutineDashboardBindingRow {
  id: string;
  routine_id: string;
  user_id: string;
  dashboard_key: string;
  app_id: string | null;
  app_ref: string | null;
  widget_id: string;
  card_id: string | null;
  config: Record<string, unknown>;
  created_at: string;
}

export interface StoredRoutine extends RoutineRow {
  capabilities: RoutineCapabilityRow[];
  dashboard_bindings: RoutineDashboardBindingRow[];
}

export interface RoutineSummary extends RoutineRow {
  capability_count?: number;
}

export interface RoutineRunRow {
  id: string;
  routine_id: string;
  user_id: string;
  status: RoutineRunStatus;
  trigger: string;
  trace_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  total_light: number;
  summary: string | null;
  error: Record<string, unknown> | null;
  run_config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface RoutineRunStepRow {
  id: string;
  run_id: string;
  routine_id: string;
  user_id: string;
  step_index: number;
  app_id: string | null;
  app_ref: string | null;
  function_name: string;
  receipt_id: string | null;
  tool_invocation_id: string | null;
  status: RoutineRunStepStatus;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  cost_light: number;
  args_preview: Record<string, unknown>;
  result_preview: Record<string, unknown>;
  error: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

const ROUTINE_SELECT =
  "id,user_id,composer_app_id,composer_app_slug,template_id,template_version,name,description,intent,handler_function,status,schedule,config,budget_policy,approval_policy,max_concurrency,next_run_at,last_run_at,last_success_at,last_error_at,failure_count,created_by_trace_id,metadata,created_at,updated_at,deleted_at";
const CAPABILITY_SELECT =
  "id,routine_id,user_id,app_id,app_ref,function_name,access,required,purpose,approved,approved_at,approved_by_user_id,pricing_snapshot,constraints,metadata,created_at,updated_at";
const DASHBOARD_BINDING_SELECT =
  "id,routine_id,user_id,dashboard_key,app_id,app_ref,widget_id,card_id,config,created_at";
const RUN_SELECT =
  "id,routine_id,user_id,status,trigger,trace_id,started_at,completed_at,duration_ms,total_light,summary,error,run_config,metadata,created_at";
const STEP_SELECT =
  "id,run_id,routine_id,user_id,step_index,app_id,app_ref,function_name,receipt_id,tool_invocation_id,status,started_at,completed_at,duration_ms,cost_light,args_preview,result_preview,error,metadata,created_at";

function serviceHeaders(
  prefer = "return=representation",
): Record<string, string> {
  return {
    "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
    "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
    "Content-Type": "application/json",
    "Prefer": prefer,
  };
}

function supabaseUrl(path: string): string {
  return `${getEnv("SUPABASE_URL")}/rest/v1/${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 160,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required and must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength = 500,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function optionalObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function optionalIsoTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`${field} must be an ISO timestamp string`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${field} must be a valid ISO timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeSchedule(input: unknown): NormalizedRoutineSchedule {
  if (typeof input === "string") {
    const cron = input.trim();
    if (!cron) throw new Error("schedule must not be empty");
    return { type: "cron", cron };
  }
  if (!isRecord(input)) {
    throw new Error("schedule must be a cron string or object");
  }

  const cron = typeof input.cron === "string" && input.cron.trim()
    ? input.cron.trim()
    : null;
  const everySeconds = input.every_seconds;
  const everyMinutes = input.every_minutes;
  const hasEverySeconds = everySeconds !== undefined && everySeconds !== null;
  const hasEveryMinutes = everyMinutes !== undefined && everyMinutes !== null;

  if (cron) {
    return {
      type: "cron",
      cron,
      ...(typeof input.timezone === "string" && input.timezone.trim()
        ? { timezone: input.timezone.trim() }
        : {}),
    };
  }

  if (!hasEverySeconds && !hasEveryMinutes) {
    throw new Error(
      "schedule must define cron, every_seconds, or every_minutes",
    );
  }

  const schedule: NormalizedRoutineSchedule = { type: "interval" };
  if (hasEverySeconds) {
    if (
      typeof everySeconds !== "number" || !Number.isFinite(everySeconds) ||
      everySeconds <= 0
    ) {
      throw new Error("schedule.every_seconds must be a positive number");
    }
    schedule.every_seconds = Math.floor(everySeconds);
  }
  if (hasEveryMinutes) {
    if (
      typeof everyMinutes !== "number" || !Number.isFinite(everyMinutes) ||
      everyMinutes <= 0
    ) {
      throw new Error("schedule.every_minutes must be a positive number");
    }
    schedule.every_minutes = Math.floor(everyMinutes);
  }
  if (typeof input.timezone === "string" && input.timezone.trim()) {
    schedule.timezone = input.timezone.trim();
  }
  return schedule;
}

function normalizeBudgetPolicy(value: unknown): RoutineBudgetDefaults {
  const supplied = optionalObject(value, "budget_policy") as
    & RoutineBudgetDefaults
    & Record<string, unknown>;
  const budget = {
    ...DEFAULT_ROUTINE_BUDGET_POLICY,
    ...supplied,
  } as Required<RoutineBudgetDefaults> & Record<string, unknown>;
  for (
    const key of [
      "max_light_per_run",
      "max_light_per_day",
      "max_light_per_month",
      "max_calls_per_run",
    ]
  ) {
    const amount = budget[key];
    if (amount === undefined) continue;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`budget_policy.${key} must be a non-negative number`);
    }
    if (key === "max_calls_per_run" && (!Number.isInteger(amount) || amount < 1)) {
      throw new Error("budget_policy.max_calls_per_run must be a positive integer");
    }
  }
  return budget;
}

export interface RoutineActivationValidation {
  budgetPolicy: Required<RoutineBudgetDefaults>;
  blockers: Array<{
    code: "pending_required_capabilities" | "unsafe_cadence" | "invalid_budget";
    message: string;
    capability_ids?: string[];
  }>;
}

const SERVER_OWNED_ROUTINE_METADATA_KEYS = new Set([
  "budget_spend",
  "auto_pause",
  "source",
  "launch_primary",
]);

function isServerOwnedRoutineMetadataKey(key: string): boolean {
  return SERVER_OWNED_ROUTINE_METADATA_KEYS.has(key) ||
    key.startsWith("approval_") || key.startsWith("approved_");
}

/**
 * Routine metadata contains both user configuration and authoritative runtime
 * accounting/approval state. User updates are merge-only and can never erase
 * or replace the server-owned half of that document.
 */
function sanitizeRoutineUserMetadata(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) =>
      !isServerOwnedRoutineMetadataKey(key)
    ),
  );
}

async function mergeRoutineUserMetadata(
  userId: string,
  routineId: string,
  input: Record<string, unknown>,
): Promise<RoutineSummary> {
  const rows = await readRows<RoutineSummary>(
    await fetch(supabaseUrl("rpc/merge_routine_user_metadata"), {
      method: "POST",
      headers: serviceHeaders("return=representation"),
      body: JSON.stringify({
        p_routine_id: routineId,
        p_user_id: userId,
        p_metadata: sanitizeRoutineUserMetadata(input),
      }),
    }),
    "Failed to update routine metadata",
  );
  if (!rows[0]) throw new Error(`Routine ${routineId} not found`);
  return rows[0];
}

/**
 * Resolve the authoritative activation policy for a stored routine. Older
 * rows may predate mandatory ceilings, so missing fields are safely
 * materialized instead of making those Agents permanently unresumable.
 */
export function validateRoutineActivation(
  routine: Pick<StoredRoutine, "schedule" | "budget_policy" | "capabilities">,
): RoutineActivationValidation {
  const budgetPolicy = {
    ...DEFAULT_ROUTINE_BUDGET_POLICY,
    ...(routine.budget_policy || {}),
  } as Required<RoutineBudgetDefaults>;
  const blockers: RoutineActivationValidation["blockers"] = [];
  const pendingRequired = routine.capabilities.filter((capability) =>
    capability.required && !capability.approved
  );
  if (pendingRequired.length > 0) {
    blockers.push({
      code: "pending_required_capabilities",
      message: "Required capabilities must be approved by the account owner before activation.",
      capability_ids: pendingRequired.map((capability) => capability.id),
    });
  }

  if (routine.schedule.type === "interval") {
    const seconds = typeof routine.schedule.every_seconds === "number"
      ? routine.schedule.every_seconds
      : typeof routine.schedule.every_minutes === "number"
      ? routine.schedule.every_minutes * 60
      : 0;
    if (seconds < MIN_ROUTINE_INTERVAL_SECONDS) {
      blockers.push({
        code: "unsafe_cadence",
        message: `Routine cadence must be at least ${MIN_ROUTINE_INTERVAL_SECONDS} seconds.`,
      });
    }
  }

  const { max_light_per_run, max_light_per_day, max_light_per_month, max_calls_per_run } =
    budgetPolicy;
  if (
    !Number.isFinite(max_light_per_run) || max_light_per_run < 0 ||
    !Number.isFinite(max_light_per_day) || max_light_per_day < max_light_per_run ||
    !Number.isFinite(max_light_per_month) || max_light_per_month < max_light_per_day ||
    !Number.isFinite(max_calls_per_run) ||
    !Number.isInteger(max_calls_per_run) || max_calls_per_run < 1
  ) {
    blockers.push({
      code: "invalid_budget",
      message: "Budget ceilings must be finite, calls must be at least 1, and run ≤ day ≤ month.",
    });
  }
  return { budgetPolicy, blockers };
}

function normalizeApprovalPolicy(value: unknown): RoutineApprovalPolicy {
  const policy = optionalObject(value, "approval_policy") as
    & RoutineApprovalPolicy
    & Record<string, unknown>;
  for (
    const key of [
      "require_user_approval",
      "require_paid_capability_approval",
      "require_external_side_effect_approval",
    ]
  ) {
    if (policy[key] !== undefined && typeof policy[key] !== "boolean") {
      throw new Error(`approval_policy.${key} must be a boolean`);
    }
  }
  return policy;
}

function normalizeMaxConcurrency(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error("max_concurrency must be a positive number");
  }
  return Math.floor(value);
}

function normalizeCapabilities(
  input: unknown,
): NormalizedRoutineCapabilityInput[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("capabilities must be an array");

  const capabilities: NormalizedRoutineCapabilityInput[] = [];
  for (const [index, raw] of input.entries()) {
    if (!isRecord(raw)) {
      throw new Error(`capabilities.${index} must be an object`);
    }
    const appRef = requiredString(
      raw.app_ref ?? raw.app,
      `capabilities.${index}.app_ref`,
    );
    const rawFunctions = Array.isArray(raw.functions)
      ? raw.functions
      : raw.function_name !== undefined
      ? [raw.function_name]
      : [];
    if (rawFunctions.length === 0) {
      throw new Error(
        `capabilities.${index}.functions must be a non-empty array`,
      );
    }
    const access = raw.access === undefined ? "read" : raw.access;
    if (access !== "read" && access !== "write") {
      throw new Error(`capabilities.${index}.access must be "read" or "write"`);
    }
    for (const fn of rawFunctions) {
      capabilities.push({
        app_id: typeof raw.app_id === "string" && raw.app_id.trim()
          ? raw.app_id.trim()
          : null,
        app_ref: appRef,
        function_name: requiredString(
          fn,
          `capabilities.${index}.functions`,
          160,
        ),
        access,
        required: raw.required === undefined ? true : raw.required === true,
        purpose: optionalString(raw.purpose, `capabilities.${index}.purpose`) ??
          null,
        approved: raw.approved === true,
        approved_at: raw.approved === true ? new Date().toISOString() : null,
        pricing_snapshot: optionalObject(
          raw.pricing_snapshot,
          `capabilities.${index}.pricing_snapshot`,
        ),
        constraints: optionalObject(
          raw.constraints,
          `capabilities.${index}.constraints`,
        ),
        metadata: optionalObject(
          raw.metadata,
          `capabilities.${index}.metadata`,
        ),
      });
    }
  }
  return capabilities;
}

function normalizeDashboardBindings(
  input: unknown,
): NormalizedRoutineDashboardBindingInput[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new Error("dashboard_bindings must be an array");
  }

  return input.map((raw, index) => {
    if (!isRecord(raw)) {
      throw new Error(`dashboard_bindings.${index} must be an object`);
    }
    return {
      dashboard_key: requiredString(
        raw.dashboard_key ?? "command_home",
        `dashboard_bindings.${index}.dashboard_key`,
        64,
      ),
      app_id: typeof raw.app_id === "string" && raw.app_id.trim()
        ? raw.app_id.trim()
        : null,
      app_ref: optionalString(
        raw.app_ref ?? raw.app,
        `dashboard_bindings.${index}.app_ref`,
        160,
      ) ?? null,
      widget_id: requiredString(
        raw.widget_id,
        `dashboard_bindings.${index}.widget_id`,
        120,
      ),
      card_id: optionalString(
        raw.card_id,
        `dashboard_bindings.${index}.card_id`,
        120,
      ) ?? null,
      config: optionalObject(raw.config, `dashboard_bindings.${index}.config`),
    };
  });
}

export function normalizeRoutineCreateInput(
  input: RoutineCreateInput,
): NormalizedRoutineCreateInput {
  const scheduleInput = input.schedule ?? { every_minutes: 5 };
  const templateId = requiredString(input.template_id, "template_id", 120);
  const name =
    input.name === undefined || input.name === null || input.name === ""
      ? templateId.replace(/[-_]+/g, " ")
      : requiredString(input.name, "name", 120);

  return {
    routine: {
      composer_app_id:
        optionalString(input.composer_app_id, "composer_app_id", 80) ?? null,
      composer_app_slug:
        optionalString(input.composer_app_slug, "composer_app_slug", 160) ??
          null,
      template_id: templateId,
      template_version:
        optionalString(input.template_version, "template_version", 80) ?? null,
      name,
      description: optionalString(input.description, "description", 500) ??
        null,
      intent: optionalString(input.intent, "intent", 1000) ?? null,
      handler_function: requiredString(
        input.handler_function,
        "handler_function",
        160,
      ),
      status: "paused",
      schedule: normalizeSchedule(scheduleInput),
      config: optionalObject(input.config, "config"),
      budget_policy: normalizeBudgetPolicy(input.budget_policy),
      approval_policy: normalizeApprovalPolicy(input.approval_policy),
      max_concurrency: normalizeMaxConcurrency(input.max_concurrency),
      next_run_at: optionalIsoTimestamp(input.next_run_at, "next_run_at"),
      created_by_trace_id:
        optionalString(input.created_by_trace_id, "created_by_trace_id", 80) ??
          null,
      metadata: optionalObject(input.metadata, "metadata"),
    },
    capabilities: normalizeCapabilities(input.capabilities),
    dashboard_bindings: normalizeDashboardBindings(input.dashboard_bindings),
  };
}

async function readRows<T>(res: Response, label: string): Promise<T[]> {
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(`${label} (${res.status}): ${message}`);
  }
  return await res.json() as T[];
}

async function insertRows<T>(
  table: string,
  payload: Record<string, unknown> | Record<string, unknown>[],
  select: string,
): Promise<T[]> {
  const res = await fetch(supabaseUrl(`${table}?select=${select}`), {
    method: "POST",
    headers: serviceHeaders("return=representation"),
    body: JSON.stringify(payload),
  });
  return readRows<T>(res, `Failed to insert ${table}`);
}

async function patchRows<T>(
  tableAndQuery: string,
  payload: Record<string, unknown>,
  select: string,
): Promise<T[]> {
  const res = await fetch(supabaseUrl(`${tableAndQuery}&select=${select}`), {
    method: "PATCH",
    headers: serviceHeaders("return=representation"),
    body: JSON.stringify(payload),
  });
  return readRows<T>(res, `Failed to update ${tableAndQuery}`);
}

export async function createRoutine(
  userId: string,
  input: RoutineCreateInput,
): Promise<StoredRoutine> {
  const normalized = normalizeRoutineCreateInput(input);
  const now = new Date().toISOString();

  const [routine] = await insertRows<RoutineRow>("user_routines", {
    user_id: userId,
    ...normalized.routine,
    updated_at: now,
  }, ROUTINE_SELECT);
  if (!routine) throw new Error("Routine insert returned no row");

  const capabilities = normalized.capabilities.length > 0
    ? await insertRows<RoutineCapabilityRow>(
      "routine_capabilities",
      normalized.capabilities.map((capability) => ({
        routine_id: routine.id,
        user_id: userId,
        ...capability,
        approved_by_user_id: capability.approved ? userId : null,
        updated_at: now,
      })),
      CAPABILITY_SELECT,
    )
    : [];

  const dashboardBindings = normalized.dashboard_bindings.length > 0
    ? await insertRows<RoutineDashboardBindingRow>(
      "routine_dashboard_bindings",
      normalized.dashboard_bindings.map((binding) => ({
        routine_id: routine.id,
        user_id: userId,
        ...binding,
      })),
      DASHBOARD_BINDING_SELECT,
    )
    : [];

  return {
    ...routine,
    capabilities,
    dashboard_bindings: dashboardBindings,
  };
}

export async function listRoutines(
  userId: string,
  options: { status?: RoutineStatus; limit?: number } = {},
): Promise<{ routines: RoutineSummary[] }> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const statusFilter = options.status ? `&status=eq.${options.status}` : "";
  const res = await fetch(
    supabaseUrl(
      `user_routines?user_id=eq.${userId}&deleted_at=is.null${statusFilter}&select=${ROUTINE_SELECT}&order=updated_at.desc&limit=${limit}`,
    ),
    { headers: serviceHeaders("return=representation") },
  );
  const routines = await readRows<RoutineSummary>(
    res,
    "Failed to list routines",
  );
  return { routines };
}

export async function getRoutine(
  userId: string,
  routineId: string,
): Promise<StoredRoutine | null> {
  const encodedRoutineId = encodeURIComponent(routineId);
  const [routine] = await readRows<RoutineRow>(
    await fetch(
      supabaseUrl(
        `user_routines?id=eq.${encodedRoutineId}&user_id=eq.${userId}&deleted_at=is.null&select=${ROUTINE_SELECT}&limit=1`,
      ),
      { headers: serviceHeaders("return=representation") },
    ),
    "Failed to load routine",
  );
  if (!routine) return null;

  const [capabilities, dashboardBindings] = await Promise.all([
    readRows<RoutineCapabilityRow>(
      await fetch(
        supabaseUrl(
          `routine_capabilities?routine_id=eq.${encodedRoutineId}&user_id=eq.${userId}&select=${CAPABILITY_SELECT}&order=created_at.asc`,
        ),
        { headers: serviceHeaders("return=representation") },
      ),
      "Failed to load routine capabilities",
    ),
    readRows<RoutineDashboardBindingRow>(
      await fetch(
        supabaseUrl(
          `routine_dashboard_bindings?routine_id=eq.${encodedRoutineId}&user_id=eq.${userId}&select=${DASHBOARD_BINDING_SELECT}&order=created_at.asc`,
        ),
        { headers: serviceHeaders("return=representation") },
      ),
      "Failed to load routine dashboard bindings",
    ),
  ]);

  return {
    ...routine,
    capabilities,
    dashboard_bindings: dashboardBindings,
  };
}

export async function updateRoutine(
  userId: string,
  routineId: string,
  input: Partial<RoutineCreateInput> & { status?: RoutineStatus },
): Promise<RoutineSummary> {
  let metadataInput: Record<string, unknown> | null = null;
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if ("name" in input) updates.name = requiredString(input.name, "name", 120);
  if ("description" in input) {
    updates.description =
      optionalString(input.description, "description", 500) ?? null;
  }
  if ("intent" in input) {
    updates.intent = optionalString(input.intent, "intent", 1000) ?? null;
  }
  if ("schedule" in input) updates.schedule = normalizeSchedule(input.schedule);
  if ("config" in input) {
    updates.config = optionalObject(input.config, "config");
  }
  if ("budget_policy" in input) {
    updates.budget_policy = normalizeBudgetPolicy(input.budget_policy);
  }
  if ("approval_policy" in input) {
    updates.approval_policy = normalizeApprovalPolicy(input.approval_policy);
  }
  if ("max_concurrency" in input) {
    updates.max_concurrency = normalizeMaxConcurrency(input.max_concurrency);
  }
  if ("next_run_at" in input) {
    updates.next_run_at = optionalIsoTimestamp(
      input.next_run_at,
      "next_run_at",
    );
  }
  if ("metadata" in input) {
    metadataInput = optionalObject(input.metadata, "metadata");
  }
  if (input.status !== undefined) {
    if (
      !["active", "paused", "disabled", "deleted", "error"].includes(
        input.status,
      )
    ) {
      throw new Error(
        "status must be active, paused, disabled, deleted, or error",
      );
    }
    if (input.status === "active") {
      throw new Error(
        "Use resumeRoutine to activate a routine; activation requires owner approvals and safety validation",
      );
    }
    updates.status = input.status;
  }

  const [routine] = await patchRows<RoutineSummary>(
    `user_routines?id=eq.${
      encodeURIComponent(routineId)
    }&user_id=eq.${userId}&deleted_at=is.null`,
    updates,
    ROUTINE_SELECT,
  );
  if (!routine) throw new Error(`Routine ${routineId} not found`);
  return metadataInput
    ? await mergeRoutineUserMetadata(userId, routineId, metadataInput)
    : routine;
}

export function pauseRoutine(
  userId: string,
  routineId: string,
): Promise<RoutineSummary> {
  return updateRoutine(userId, routineId, { status: "paused" });
}

export async function resumeRoutine(
  userId: string,
  routineId: string,
): Promise<RoutineSummary> {
  const routine = await getRoutine(userId, routineId);
  if (!routine) throw new Error(`Routine ${routineId} not found`);
  const validation = validateRoutineActivation(routine);
  if (validation.blockers.length > 0) {
    const error = new Error(
      `Routine cannot be activated: ${validation.blockers.map((item) => item.message).join(" ")}`,
    ) as Error & { code?: string; blockers?: RoutineActivationValidation["blockers"] };
    error.code = "ROUTINE_ACTIVATION_BLOCKED";
    error.blockers = validation.blockers;
    throw error;
  }
  const [updated] = await patchRows<RoutineSummary>(
    `user_routines?id=eq.${
      encodeURIComponent(routineId)
    }&user_id=eq.${userId}&deleted_at=is.null&status=in.(paused,error)`,
    {
      status: "active",
      budget_policy: validation.budgetPolicy,
      updated_at: new Date().toISOString(),
    },
    ROUTINE_SELECT,
  );
  if (updated) return updated;
  // Idempotent resume for an already-active routine, while still validating
  // approvals above. Never silently activates disabled/deleted rows.
  if (routine.status === "active") return routine;
  throw new Error(`Routine ${routineId} is ${routine.status} and cannot be activated`);
}

/**
 * Account-session approval primitive. It is intentionally NOT exposed by the
 * connected-agent platform service: HTTP handlers with account-session auth
 * call this function after presenting the exact requested authority to a user.
 * Omit capabilityIds to approve every capability currently requested.
 */
export async function approveRoutineCapabilities(
  userId: string,
  routineId: string,
  capabilityIds?: string[],
): Promise<StoredRoutine> {
  const routine = await getRoutine(userId, routineId);
  if (!routine) throw new Error(`Routine ${routineId} not found`);
  const allIds = new Set(routine.capabilities.map((capability) => capability.id));
  const requestedIds = capabilityIds === undefined
    ? routine.capabilities.map((capability) => capability.id)
    : Array.from(new Set(capabilityIds.map((id) => id.trim()).filter(Boolean)));
  const unknown = requestedIds.filter((id) => !allIds.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Capabilities do not belong to routine ${routineId}: ${unknown.join(", ")}`,
    );
  }
  if (requestedIds.length === 0) return routine;

  const now = new Date().toISOString();
  // Values have already been proven to be IDs on this routine. Encode each
  // value independently while leaving PostgREST's in.(...) grammar intact.
  const encodedIds = requestedIds.map(encodeURIComponent).join(",");
  await patchRows<RoutineCapabilityRow>(
    `routine_capabilities?routine_id=eq.${
      encodeURIComponent(routineId)
    }&user_id=eq.${encodeURIComponent(userId)}&id=in.(${encodedIds})`,
    {
      approved: true,
      approved_at: now,
      approved_by_user_id: userId,
      updated_at: now,
    },
    CAPABILITY_SELECT,
  );
  const updated = await getRoutine(userId, routineId);
  if (!updated) throw new Error(`Routine ${routineId} not found after approval`);
  return updated;
}

export async function deleteRoutine(
  userId: string,
  routineId: string,
): Promise<{ ok: true; routine_id: string }> {
  await updateRoutine(userId, routineId, {
    status: "deleted",
    metadata: { deleted_by_user: true },
  });
  const res = await fetch(
    supabaseUrl(
      `user_routines?id=eq.${
        encodeURIComponent(routineId)
      }&user_id=eq.${userId}`,
    ),
    {
      method: "PATCH",
      headers: serviceHeaders("return=minimal"),
      body: JSON.stringify({
        status: "deleted",
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to delete routine (${res.status}): ${message}`);
  }
  return { ok: true, routine_id: routineId };
}

export async function createRoutineRun(params: {
  routineId: string;
  userId: string;
  trigger?: string;
  traceId?: string | null;
  status?: RoutineRunStatus;
  runConfig?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<RoutineRunRow> {
  const status = params.status ?? "queued";
  // Every run needs an immutable trace before it can be claimed. Preserve an
  // explicit upstream trace for internal correlation, but never persist the
  // legacy null value: the executor signs this trace into the routine actor
  // and downstream sandbox actors.
  const traceId = params.traceId?.trim() || crypto.randomUUID();
  const [run] = await insertRows<RoutineRunRow>("routine_runs", {
    routine_id: params.routineId,
    user_id: params.userId,
    status,
    trigger: params.trigger ?? "scheduled",
    trace_id: traceId,
    started_at: status === "running" ? new Date().toISOString() : null,
    run_config: params.runConfig ?? {},
    metadata: params.metadata ?? {},
  }, RUN_SELECT);
  if (!run) throw new Error("Routine run insert returned no row");
  return run;
}

export async function updateRoutineRun(
  runId: string,
  userId: string,
  updates: {
    status?: RoutineRunStatus;
    summary?: string | null;
    error?: Record<string, unknown> | null;
    totalLight?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<RoutineRunRow> {
  const payload: Record<string, unknown> = {};
  if (updates.status !== undefined) {
    payload.status = updates.status;
    if (
      ["succeeded", "failed", "cancelled", "skipped"].includes(updates.status)
    ) {
      payload.completed_at = new Date().toISOString();
    }
  }
  if ("summary" in updates) payload.summary = updates.summary;
  if ("error" in updates) payload.error = updates.error;
  if (updates.totalLight !== undefined) {
    if (!Number.isFinite(updates.totalLight) || updates.totalLight < 0) {
      throw new Error("totalLight must be a non-negative number");
    }
    payload.total_light = updates.totalLight;
  }
  if (updates.metadata !== undefined) payload.metadata = updates.metadata;

  const [run] = await patchRows<RoutineRunRow>(
    `routine_runs?id=eq.${encodeURIComponent(runId)}&user_id=eq.${userId}`,
    payload,
    RUN_SELECT,
  );
  if (!run) throw new Error(`Routine run ${runId} not found`);
  return run;
}

export async function recordRoutineRunStep(params: {
  runId: string;
  routineId: string;
  userId: string;
  stepIndex: number;
  appId?: string | null;
  appRef?: string | null;
  functionName: string;
  receiptId?: string | null;
  toolInvocationId?: string | null;
  status?: RoutineRunStepStatus;
  durationMs?: number | null;
  costLight?: number;
  argsPreview?: Record<string, unknown>;
  resultPreview?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}): Promise<RoutineRunStepRow> {
  if (!Number.isFinite(params.stepIndex) || params.stepIndex < 0) {
    throw new Error("stepIndex must be a non-negative number");
  }
  const costLight = params.costLight ?? 0;
  if (!Number.isFinite(costLight) || costLight < 0) {
    throw new Error("costLight must be a non-negative number");
  }
  const status = params.status ?? "started";
  const [step] = await insertRows<RoutineRunStepRow>("routine_run_steps", {
    run_id: params.runId,
    routine_id: params.routineId,
    user_id: params.userId,
    step_index: Math.floor(params.stepIndex),
    app_id: params.appId ?? null,
    app_ref: params.appRef ?? null,
    function_name: requiredString(params.functionName, "functionName"),
    receipt_id: params.receiptId ?? null,
    tool_invocation_id: params.toolInvocationId ?? null,
    status,
    completed_at:
      status === "succeeded" || status === "failed" || status === "skipped"
        ? new Date().toISOString()
        : null,
    duration_ms: params.durationMs ?? null,
    cost_light: costLight,
    args_preview: params.argsPreview ?? {},
    result_preview: params.resultPreview ?? {},
    error: params.error ?? null,
    metadata: params.metadata ?? {},
  }, STEP_SELECT);
  if (!step) throw new Error("Routine run step insert returned no row");
  return step;
}

export function routineCapabilitiesFromManifest(
  capabilities: RoutineCapabilityDeclaration[] | undefined,
): RoutineCapabilityInput[] {
  return (capabilities || []).flatMap((capability) =>
    capability.functions.map((functionName) => ({
      app_ref: capability.app,
      function_name: functionName,
      access: capability.access || "read",
      required: capability.required !== false,
      purpose: capability.purpose ?? null,
    }))
  );
}
