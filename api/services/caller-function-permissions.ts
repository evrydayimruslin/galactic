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

interface CallerPermissionDefaultRow {
  user_id: string;
  default_policy: string | null;
  updated_at?: string | null;
}

interface CallerFunctionPermissionRow {
  app_id: string;
  function_name: string;
  policy: string | null;
  updated_at?: string | null;
}

export interface CallerFunctionPermissionResolution
  extends LaunchCallerFunctionPermissionSummary {
  defaultPolicy: LaunchCallerFunctionPolicy;
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
  permissions?: Array<{
    functionName?: unknown;
    function_name?: unknown;
    policy?: unknown;
  }>;
  allowedFunctionNames?: string[];
}

export interface CallerFunctionPermissionEnforcementInput {
  userId: string;
  appId: string;
  functionName: string;
  configureUrl: string;
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

export function buildCallerPermissionConfigureUrl(
  baseUrl: string,
  appId: string,
  functionName: string,
): string {
  // Points at the Agent page, where the per-function permission control
  // lives (the facade resolves UUID or slug locators).
  const url = new URL(`/agents/${encodeURIComponent(appId)}`, baseUrl);
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
  const { defaultPolicy, permissionRows } = await fetchPermissionState(
    input.userId,
    input.appId,
  );
  const explicit = permissionRows.find((row) =>
    row.function_name === input.functionName
  );
  if (explicit) {
    return {
      appId: input.appId,
      functionName: input.functionName,
      policy: normalizeStoredPolicy(explicit.policy),
      source: "explicit",
      updatedAt: explicit.updated_at || null,
      defaultPolicy,
    };
  }
  return {
    appId: input.appId,
    functionName: input.functionName,
    policy: defaultPolicy,
    source: "default",
    updatedAt: null,
    defaultPolicy,
  };
}

export async function listCallerFunctionPermissions(
  input: CallerFunctionPermissionListInput,
): Promise<
  Pick<
    LaunchCallerFunctionPermissionsResponse,
    "defaultPolicy" | "permissions"
  >
> {
  const functionNames = uniqueFunctionNames(input.functionNames);
  const { defaultPolicy, permissionRows } = await fetchPermissionState(
    input.userId,
    input.appId,
  );
  const explicitByFunction = new Map(
    permissionRows.map((row) => [row.function_name, row]),
  );

  const permissions = functionNames.map((functionName) => {
    const explicit = explicitByFunction.get(functionName);
    return {
      appId: input.appId,
      functionName,
      policy: explicit ? normalizeStoredPolicy(explicit.policy) : defaultPolicy,
      source: explicit ? "explicit" : "default",
      updatedAt: explicit?.updated_at || null,
    } satisfies LaunchCallerFunctionPermissionSummary;
  });

  return { defaultPolicy, permissions };
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

  if (input.defaultPolicy !== undefined) {
    const defaultPolicy = normalizeCallerFunctionPolicy(
      input.defaultPolicy,
      "defaultPolicy",
    );
    await dbWrite(
      db,
      "/rest/v1/user_agent_permission_defaults?on_conflict=user_id",
      [{
        user_id: input.userId,
        default_policy: defaultPolicy,
      }],
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
    return {
      user_id: input.userId,
      app_id: input.appId,
      function_name: functionName,
      policy: normalizeCallerFunctionPolicy(entry.policy),
    };
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
    return { allowed: true, resolution };
  }

  const isAsk = resolution.policy === "ask";
  const message = isAsk
    ? `Your connected agent needs permission to call ${input.functionName}.`
    : `Connected agents are not allowed to call ${input.functionName}.`;
  const details = {
    type: isAsk ? "permission_required" : "permission_denied",
    policy: resolution.policy,
    appId: input.appId,
    functionName: input.functionName,
    message,
    configureUrl: input.configureUrl,
    source: resolution.source,
    updatedAt: resolution.updatedAt || null,
  } as CallerPermissionBlock;

  return {
    allowed: false,
    httpStatus: 403,
    rpcCode: CALLER_FUNCTION_PERMISSION_RPC_CODE,
    errorType: isAsk ? "AGENT_PERMISSION_REQUIRED" : "AGENT_PERMISSION_DENIED",
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
  permissionRows: CallerFunctionPermissionRow[];
}> {
  const db = getDbConfig();
  if (!db) {
    return {
      defaultPolicy: DEFAULT_CALLER_FUNCTION_POLICY,
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
          select: "user_id,default_policy,updated_at",
          limit: "1",
        },
      ),
      dbGet<CallerFunctionPermissionRow>(
        db,
        "user_agent_function_permissions",
        {
          user_id: `eq.${userId}`,
          app_id: `eq.${appId}`,
          select: "app_id,function_name,policy,updated_at",
          limit: "500",
        },
      ),
    ]);
    return {
      defaultPolicy: normalizeStoredPolicy(defaultRows[0]?.default_policy),
      permissionRows,
    };
  } catch (err) {
    console.warn("[CALLER-PERMISSIONS] Falling back to ask policy:", err);
    return {
      defaultPolicy: DEFAULT_CALLER_FUNCTION_POLICY,
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
