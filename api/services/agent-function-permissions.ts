import {
  LAUNCH_AGENT_FUNCTION_POLICIES,
  type LaunchAgentFunctionPermissionsResponse,
  type LaunchAgentFunctionPermissionSummary,
  type LaunchAgentFunctionPolicy,
  type LaunchAgentPermissionDenied,
  type LaunchAgentPermissionRequired,
} from "../../shared/contracts/launch.ts";
import { getEnv } from "../lib/env.ts";
import { RequestValidationError } from "./request-validation.ts";

export const DEFAULT_AGENT_FUNCTION_POLICY: LaunchAgentFunctionPolicy = "ask";
export const AGENT_FUNCTION_PERMISSION_RPC_CODE = -32003;

type AgentPermissionBlock =
  | LaunchAgentPermissionRequired
  | LaunchAgentPermissionDenied;

interface DbConfig {
  baseUrl: string;
  headers: HeadersInit;
}

interface AgentPermissionDefaultRow {
  user_id: string;
  default_policy: string | null;
  updated_at?: string | null;
}

interface AgentFunctionPermissionRow {
  app_id: string;
  function_name: string;
  policy: string | null;
  updated_at?: string | null;
}

export interface AgentFunctionPermissionResolution
  extends LaunchAgentFunctionPermissionSummary {
  defaultPolicy: LaunchAgentFunctionPolicy;
}

export interface AgentFunctionPermissionListInput {
  userId: string;
  appId: string;
  functionNames: string[];
}

export interface AgentFunctionPermissionUpdateInput {
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

export interface AgentFunctionPermissionEnforcementInput {
  userId: string;
  appId: string;
  functionName: string;
  configureUrl: string;
}

export type AgentFunctionPermissionEnforcement =
  | {
    allowed: true;
    resolution: AgentFunctionPermissionResolution;
  }
  | {
    allowed: false;
    httpStatus: 403;
    rpcCode: typeof AGENT_FUNCTION_PERMISSION_RPC_CODE;
    errorType: "AGENT_PERMISSION_REQUIRED" | "AGENT_PERMISSION_DENIED";
    message: string;
    details: AgentPermissionBlock;
    resolution: AgentFunctionPermissionResolution;
  };

export function normalizeAgentFunctionPolicy(
  value: unknown,
  field = "policy",
): LaunchAgentFunctionPolicy {
  if (
    typeof value === "string" &&
    (LAUNCH_AGENT_FUNCTION_POLICIES as readonly string[]).includes(value)
  ) {
    return value as LaunchAgentFunctionPolicy;
  }
  throw new RequestValidationError(
    `${field} must be one of: always, ask, never`,
  );
}

export function buildAgentPermissionConfigureUrl(
  baseUrl: string,
  appId: string,
  functionName: string,
): string {
  const url = new URL("/settings", baseUrl);
  url.searchParams.set("tab", "agent-permissions");
  url.searchParams.set("app", appId);
  url.searchParams.set("function", functionName);
  return url.toString();
}

export async function resolveAgentFunctionPermission(
  input: {
    userId: string;
    appId: string;
    functionName: string;
  },
): Promise<AgentFunctionPermissionResolution> {
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

export async function listAgentFunctionPermissions(
  input: AgentFunctionPermissionListInput,
): Promise<
  Pick<
    LaunchAgentFunctionPermissionsResponse,
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
    } satisfies LaunchAgentFunctionPermissionSummary;
  });

  return { defaultPolicy, permissions };
}

export async function updateAgentFunctionPermissions(
  input: AgentFunctionPermissionUpdateInput,
): Promise<void> {
  const db = getDbConfig();
  if (!db) {
    throw new RequestValidationError(
      "Agent permission storage is not configured",
      503,
    );
  }

  if (input.defaultPolicy !== undefined) {
    const defaultPolicy = normalizeAgentFunctionPolicy(
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
        `Unknown function for this tool: ${functionName}`,
      );
    }
    return {
      user_id: input.userId,
      app_id: input.appId,
      function_name: functionName,
      policy: normalizeAgentFunctionPolicy(entry.policy),
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

export async function enforceAgentFunctionPermission(
  input: AgentFunctionPermissionEnforcementInput,
): Promise<AgentFunctionPermissionEnforcement> {
  const resolution = await resolveAgentFunctionPermission(input);
  if (resolution.policy === "always") {
    return { allowed: true, resolution };
  }

  const isAsk = resolution.policy === "ask";
  const message = isAsk
    ? `External agent permission required before calling ${input.functionName}.`
    : `External agents are not allowed to call ${input.functionName}.`;
  const details = {
    type: isAsk ? "permission_required" : "permission_denied",
    policy: resolution.policy,
    appId: input.appId,
    functionName: input.functionName,
    message,
    configureUrl: input.configureUrl,
    source: resolution.source,
    updatedAt: resolution.updatedAt || null,
  } as AgentPermissionBlock;

  return {
    allowed: false,
    httpStatus: 403,
    rpcCode: AGENT_FUNCTION_PERMISSION_RPC_CODE,
    errorType: isAsk ? "AGENT_PERMISSION_REQUIRED" : "AGENT_PERMISSION_DENIED",
    message,
    details,
    resolution,
  };
}

function normalizeStoredPolicy(value: unknown): LaunchAgentFunctionPolicy {
  return (typeof value === "string" &&
      (LAUNCH_AGENT_FUNCTION_POLICIES as readonly string[]).includes(value))
    ? value as LaunchAgentFunctionPolicy
    : DEFAULT_AGENT_FUNCTION_POLICY;
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
  defaultPolicy: LaunchAgentFunctionPolicy;
  permissionRows: AgentFunctionPermissionRow[];
}> {
  const db = getDbConfig();
  if (!db) {
    return {
      defaultPolicy: DEFAULT_AGENT_FUNCTION_POLICY,
      permissionRows: [],
    };
  }

  try {
    const [defaultRows, permissionRows] = await Promise.all([
      dbGet<AgentPermissionDefaultRow>(
        db,
        "user_agent_permission_defaults",
        {
          user_id: `eq.${userId}`,
          select: "user_id,default_policy,updated_at",
          limit: "1",
        },
      ),
      dbGet<AgentFunctionPermissionRow>(
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
    console.warn("[AGENT-PERMISSIONS] Falling back to ask policy:", err);
    return {
      defaultPolicy: DEFAULT_AGENT_FUNCTION_POLICY,
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
