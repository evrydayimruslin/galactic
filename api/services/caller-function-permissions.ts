import {
  LAUNCH_CALLER_FUNCTION_POLICIES,
  type LaunchCallerFunctionPermissionsResponse,
  type LaunchCallerFunctionPermissionSummary,
  type LaunchCallerFunctionPolicy,
  type LaunchCallerPermissionDenied,
  type LaunchCallerPermissionRequired,
} from "../../shared/contracts/launch.ts";
import { getEnv } from "../lib/env.ts";
import { RequestValidationError } from "./request-validation.ts";

export const DEFAULT_CALLER_FUNCTION_POLICY: LaunchCallerFunctionPolicy = "ask";
export const CALLER_FUNCTION_PERMISSION_RPC_CODE = -32003;

type CallerPermissionBlock =
  | LaunchCallerPermissionRequired
  | LaunchCallerPermissionDenied;

interface DbConfig {
  baseUrl: string;
  headers: HeadersInit;
}

export const DEFAULT_CALLER_FUNCTION_HEALTH_GATE = true;

interface CallerPermissionDefaultRow {
  user_id: string;
  default_policy: string | null;
  default_health_gate?: boolean | null;
  updated_at?: string | null;
}

interface CallerFunctionPermissionRow {
  app_id: string;
  function_name: string;
  policy: string | null;
  health_gate?: boolean | null;
  updated_at?: string | null;
}

export interface CallerFunctionPermissionResolution
  extends LaunchCallerFunctionPermissionSummary {
  defaultPolicy: LaunchCallerFunctionPolicy;
  defaultHealthGate: boolean;
}

export interface CallerFunctionPermissionListInput {
  userId: string;
  appId: string;
  functionNames: string[];
}

export interface CallerFunctionPermissionUpdateInput {
  userId: string;
  appId: string;
  defaultPolicy?: unknown;
  defaultHealthGate?: unknown;
  permissions?: Array<{
    functionName?: unknown;
    function_name?: unknown;
    policy?: unknown;
    healthGate?: unknown;
    health_gate?: unknown;
  }>;
  allowedFunctionNames?: string[];
}

export interface CallerFunctionPermissionEnforcementInput {
  userId: string;
  appId: string;
  functionName: string;
  configureUrl: string;
  // Lazily resolves whether the TARGET is recently healthy (green). Only invoked
  // when the resolved policy is "always" AND its health gate is on, so health is
  // never fetched for "ask"/"never" or ungated "always".
  resolveTargetHealthGreen?: () => Promise<boolean>;
  // In-band, one-shot user consent (the Claude-Code "allow once" model): the
  // connected agent asserts its end user approved THIS call. Satisfies an "ask"
  // (including an "always" degraded to ask by the health gate) for this single
  // call WITHOUT persisting. Never overrides an owner-set "never".
  confirmed?: boolean;
}

export type CallerFunctionPermissionEnforcement =
  | {
    allowed: true;
    resolution: CallerFunctionPermissionResolution;
  }
  | {
    allowed: false;
    httpStatus: 403;
    rpcCode: typeof CALLER_FUNCTION_PERMISSION_RPC_CODE;
    errorType: "AGENT_PERMISSION_REQUIRED" | "AGENT_PERMISSION_DENIED";
    message: string;
    details: CallerPermissionBlock;
    resolution: CallerFunctionPermissionResolution;
  };

export function normalizeCallerFunctionPolicy(
  value: unknown,
  field = "policy",
): LaunchCallerFunctionPolicy {
  if (
    typeof value === "string" &&
    (LAUNCH_CALLER_FUNCTION_POLICIES as readonly string[]).includes(value)
  ) {
    return value as LaunchCallerFunctionPolicy;
  }
  throw new RequestValidationError(
    `${field} must be one of: always, ask, never`,
  );
}

export function normalizeHealthGate(value: unknown, field = "healthGate"): boolean {
  if (typeof value === "boolean") return value;
  throw new RequestValidationError(`${field} must be a boolean`);
}

export function buildCallerPermissionConfigureUrl(
  baseUrl: string,
  appId: string,
  functionName: string,
): string {
  // Points at the Agent page, where the per-function permission control
  // lives (the facade resolves UUID or slug locators). The page is served by
  // the launch website, not the API worker — prefer LAUNCH_WEB_BASE_URL.
  const webBaseUrl = getEnv("LAUNCH_WEB_BASE_URL") || baseUrl;
  const url = new URL(`/agents/${encodeURIComponent(appId)}`, webBaseUrl);
  url.searchParams.set("tab", "functions");
  url.searchParams.set("function", functionName);
  return url.toString();
}

export async function resolveCallerFunctionPermission(
  input: {
    userId: string;
    appId: string;
    functionName: string;
  },
): Promise<CallerFunctionPermissionResolution> {
  const { defaultPolicy, defaultHealthGate, permissionRows } =
    await fetchPermissionState(input.userId, input.appId);
  const explicit = permissionRows.find((row) =>
    row.function_name === input.functionName
  );
  if (explicit) {
    return {
      appId: input.appId,
      functionName: input.functionName,
      policy: normalizeStoredPolicy(explicit.policy),
      healthGate: explicit.health_gate ?? defaultHealthGate,
      source: "explicit",
      updatedAt: explicit.updated_at || null,
      defaultPolicy,
      defaultHealthGate,
    };
  }
  return {
    appId: input.appId,
    functionName: input.functionName,
    policy: defaultPolicy,
    healthGate: defaultHealthGate,
    source: "default",
    updatedAt: null,
    defaultPolicy,
    defaultHealthGate,
  };
}

export async function listCallerFunctionPermissions(
  input: CallerFunctionPermissionListInput,
): Promise<
  Pick<
    LaunchCallerFunctionPermissionsResponse,
    "defaultPolicy" | "defaultHealthGate" | "permissions"
  >
> {
  const functionNames = uniqueFunctionNames(input.functionNames);
  const { defaultPolicy, defaultHealthGate, permissionRows } =
    await fetchPermissionState(input.userId, input.appId);
  const explicitByFunction = new Map(
    permissionRows.map((row) => [row.function_name, row]),
  );

  const permissions = functionNames.map((functionName) => {
    const explicit = explicitByFunction.get(functionName);
    return {
      appId: input.appId,
      functionName,
      policy: explicit ? normalizeStoredPolicy(explicit.policy) : defaultPolicy,
      healthGate: explicit ? (explicit.health_gate ?? defaultHealthGate) : defaultHealthGate,
      source: explicit ? "explicit" : "default",
      updatedAt: explicit?.updated_at || null,
    } satisfies LaunchCallerFunctionPermissionSummary;
  });

  return { defaultPolicy, defaultHealthGate, permissions };
}

export async function updateCallerFunctionPermissions(
  input: CallerFunctionPermissionUpdateInput,
): Promise<void> {
  const db = getDbConfig();
  if (!db) {
    throw new RequestValidationError(
      "Caller permission storage is not configured",
      503,
    );
  }

  if (input.defaultPolicy !== undefined || input.defaultHealthGate !== undefined) {
    const row: Record<string, unknown> = { user_id: input.userId };
    if (input.defaultPolicy !== undefined) {
      row.default_policy = normalizeCallerFunctionPolicy(
        input.defaultPolicy,
        "defaultPolicy",
      );
    }
    if (input.defaultHealthGate !== undefined) {
      row.default_health_gate = normalizeHealthGate(
        input.defaultHealthGate,
        "defaultHealthGate",
      );
    }
    await dbWrite(
      db,
      "/rest/v1/user_agent_permission_defaults?on_conflict=user_id",
      [row],
      "Failed to update agent permission default",
    );
  }

  if (input.permissions === undefined) return;
  if (!Array.isArray(input.permissions)) {
    throw new RequestValidationError("permissions must be an array");
  }

  const allowed = new Set(input.allowedFunctionNames || []);
  const rows = input.permissions.map((entry) => {
    const functionName = normalizeFunctionName(
      entry.functionName ?? entry.function_name,
    );
    if (allowed.size > 0 && !allowed.has(functionName)) {
      throw new RequestValidationError(
        `Unknown function for this Agent: ${functionName}`,
      );
    }
    const row: Record<string, unknown> = {
      user_id: input.userId,
      app_id: input.appId,
      function_name: functionName,
      policy: normalizeCallerFunctionPolicy(entry.policy),
    };
    const healthGate = entry.healthGate ?? entry.health_gate;
    if (healthGate !== undefined) {
      row.health_gate = normalizeHealthGate(healthGate, "healthGate");
    }
    return row;
  });
  if (rows.length === 0) return;

  await dbWrite(
    db,
    "/rest/v1/user_agent_function_permissions?on_conflict=user_id,app_id,function_name",
    rows,
    "Failed to update agent function permissions",
  );
}

export async function enforceCallerFunctionPermission(
  input: CallerFunctionPermissionEnforcementInput,
): Promise<CallerFunctionPermissionEnforcement> {
  const resolution = await resolveCallerFunctionPermission(input);

  if (resolution.policy === "always") {
    // Health gate: an "always" policy auto-allows ONLY when the target is
    // recently healthy. Unproven (no_data) or failing (red) degrades to "ask".
    if (resolution.healthGate) {
      const green = input.resolveTargetHealthGreen
        ? await input.resolveTargetHealthGreen()
        : false;
      if (!green) {
        // One-shot user consent still lets it through for this call.
        if (input.confirmed) return { allowed: true, resolution };
        return buildAskBlock(input, resolution, true);
      }
    }
    return { allowed: true, resolution };
  }

  if (resolution.policy === "ask") {
    // In-band consent (the agent asserts its user approved this call) satisfies
    // "ask" for this one call without persisting anything.
    if (input.confirmed) return { allowed: true, resolution };
    return buildAskBlock(input, resolution, false);
  }

  // never — an owner-set hard block; user-agent consent can NEVER override it.
  const message =
    `Connected agents are not allowed to call ${input.functionName}.`;
  const details: CallerPermissionBlock = {
    type: "permission_denied",
    policy: "never",
    appId: input.appId,
    functionName: input.functionName,
    message,
    configureUrl: input.configureUrl,
    source: resolution.source,
    updatedAt: resolution.updatedAt || null,
  };
  return {
    allowed: false,
    httpStatus: 403,
    rpcCode: CALLER_FUNCTION_PERMISSION_RPC_CODE,
    errorType: "AGENT_PERMISSION_DENIED",
    message,
    details,
    resolution,
  };
}

function buildAskBlock(
  input: CallerFunctionPermissionEnforcementInput,
  resolution: CallerFunctionPermissionResolution,
  fromHealthGate: boolean,
): Extract<CallerFunctionPermissionEnforcement, { allowed: false }> {
  const base = fromHealthGate
    ? `${input.functionName} has not been recently healthy, so your approval is required before calling it.`
    : `Calling ${input.functionName} needs your user's confirmation.`;
  // Actionable in-band resolution (no website round-trip): ask the end user,
  // then either retry this call with confirm:true (allow once) or call gx.permit
  // to allow it from now on. Not gx.grants — that is app-to-app wiring.
  const message = `${base} Ask your user, then retry with confirm:true to allow ` +
    `once, or call gx.permit({ app_id, function_name, decision:"always" }) to ` +
    `allow it from now on.`;
  const details: CallerPermissionBlock = {
    type: "permission_required",
    policy: "ask",
    appId: input.appId,
    functionName: input.functionName,
    message,
    configureUrl: input.configureUrl,
    source: resolution.source,
    updatedAt: resolution.updatedAt || null,
    ...(fromHealthGate ? { reason: "health_gate" as const } : {}),
  };
  return {
    allowed: false,
    httpStatus: 403,
    rpcCode: CALLER_FUNCTION_PERMISSION_RPC_CODE,
    errorType: "AGENT_PERMISSION_REQUIRED",
    message,
    details,
    resolution,
  };
}

function normalizeStoredPolicy(value: unknown): LaunchCallerFunctionPolicy {
  return (typeof value === "string" &&
      (LAUNCH_CALLER_FUNCTION_POLICIES as readonly string[]).includes(value))
    ? value as LaunchCallerFunctionPolicy
    : DEFAULT_CALLER_FUNCTION_POLICY;
}

function normalizeFunctionName(value: unknown): string {
  const functionName = typeof value === "string" ? value.trim() : "";
  if (!functionName) {
    throw new RequestValidationError("functionName is required");
  }
  if (functionName.length > 200) {
    throw new RequestValidationError(
      "functionName must be 200 characters or less",
    );
  }
  return functionName;
}

function uniqueFunctionNames(functionNames: string[]): string[] {
  return Array.from(
    new Set(
      functionNames
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

async function fetchPermissionState(
  userId: string,
  appId: string,
): Promise<{
  defaultPolicy: LaunchCallerFunctionPolicy;
  defaultHealthGate: boolean;
  permissionRows: CallerFunctionPermissionRow[];
}> {
  const db = getDbConfig();
  if (!db) {
    return {
      defaultPolicy: DEFAULT_CALLER_FUNCTION_POLICY,
      defaultHealthGate: DEFAULT_CALLER_FUNCTION_HEALTH_GATE,
      permissionRows: [],
    };
  }

  try {
    const [defaultRows, permissionRows] = await Promise.all([
      dbGet<CallerPermissionDefaultRow>(
        db,
        "user_agent_permission_defaults",
        {
          user_id: `eq.${userId}`,
          select: "user_id,default_policy,default_health_gate,updated_at",
          limit: "1",
        },
      ),
      dbGet<CallerFunctionPermissionRow>(
        db,
        "user_agent_function_permissions",
        {
          user_id: `eq.${userId}`,
          app_id: `eq.${appId}`,
          select: "app_id,function_name,policy,health_gate,updated_at",
          limit: "500",
        },
      ),
    ]);
    return {
      defaultPolicy: normalizeStoredPolicy(defaultRows[0]?.default_policy),
      defaultHealthGate: defaultRows[0]?.default_health_gate ??
        DEFAULT_CALLER_FUNCTION_HEALTH_GATE,
      permissionRows,
    };
  } catch (err) {
    console.warn("[CALLER-PERMISSIONS] Falling back to ask policy:", err);
    return {
      defaultPolicy: DEFAULT_CALLER_FUNCTION_POLICY,
      defaultHealthGate: DEFAULT_CALLER_FUNCTION_HEALTH_GATE,
      permissionRows: [],
    };
  }
}

function getDbConfig(): DbConfig | null {
  const baseUrl = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !key) return null;
  return {
    baseUrl,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

async function dbGet<T>(
  db: DbConfig,
  table: string,
  params: Record<string, string>,
): Promise<T[]> {
  const url = new URL(`${db.baseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), { headers: db.headers });
  return await readRows<T>(response, `Failed to fetch ${table}`);
}

async function dbWrite(
  db: DbConfig,
  path: string,
  body: unknown,
  message: string,
): Promise<void> {
  const response = await fetch(`${db.baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...db.headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new RequestValidationError(
      detail ? `${message}: ${detail}` : message,
      500,
    );
  }
}

async function readRows<T>(response: Response, message: string): Promise<T[]> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail ? `${message}: ${detail}` : message);
  }
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? payload as T[] : [payload as T];
}
