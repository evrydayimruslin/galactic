import type { LaunchFunctionInferenceOverrideSummary } from "../../shared/contracts/launch.ts";
import type { InferenceRoutePreference } from "../../shared/contracts/ai.ts";
import { isActiveBYOKProvider } from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";
import { RequestValidationError } from "./request-validation.ts";

interface DbConfig {
  baseUrl: string;
  headers: HeadersInit;
}

interface FunctionInferenceOverrideRow {
  app_id: string;
  function_name: string;
  billing_mode: string;
  provider: string | null;
  model: string;
  updated_at?: string | null;
}

interface FunctionInferenceOverrideListInput {
  userId: string;
  appId: string;
  functionNames: string[];
}

interface FunctionInferenceOverrideSetInput {
  userId: string;
  appId: string;
  functionName: string;
  billingMode: "light" | "byok";
  provider: string | null;
  model: string;
  allowedFunctionNames?: string[];
}

/** Convert a stored row to a resolveInferenceRoute selection. */
function rowToSelection(
  row: FunctionInferenceOverrideRow,
): InferenceRoutePreference {
  const billingMode = row.billing_mode === "byok" ? "byok" : "light";
  const provider = billingMode === "byok" && isActiveBYOKProvider(row.provider)
    ? row.provider
    : undefined;
  return { billingMode, provider, model: row.model };
}

/**
 * Resolve the per-(user, app, function) inference override as a route selection,
 * or null if none is set. FAIL-OPEN: any storage error returns null so the hot
 * path degrades to the default fallback chain — this must NEVER throw.
 */
export async function resolveFunctionInferenceOverride(input: {
  userId: string;
  appId: string;
  functionName: string;
}): Promise<InferenceRoutePreference | null> {
  const db = getDbConfig();
  if (!db) return null;
  try {
    const rows = await dbGet<FunctionInferenceOverrideRow>(
      db,
      "user_function_inference_overrides",
      {
        user_id: `eq.${input.userId}`,
        app_id: `eq.${input.appId}`,
        function_name: `eq.${input.functionName}`,
        select: "app_id,function_name,billing_mode,provider,model,updated_at",
        limit: "1",
      },
    );
    const row = rows[0];
    return row ? rowToSelection(row) : null;
  } catch (err) {
    console.warn("[FUNCTION-INFERENCE] Falling back to default route:", err);
    return null;
  }
}

export async function listFunctionInferenceOverrides(
  input: FunctionInferenceOverrideListInput,
): Promise<LaunchFunctionInferenceOverrideSummary[]> {
  const db = getDbConfig();
  if (!db) return [];
  const names = uniqueFunctionNames(input.functionNames);
  try {
    const rows = await dbGet<FunctionInferenceOverrideRow>(
      db,
      "user_function_inference_overrides",
      {
        user_id: `eq.${input.userId}`,
        app_id: `eq.${input.appId}`,
        select: "app_id,function_name,billing_mode,provider,model,updated_at",
        limit: "500",
      },
    );
    const byFunction = new Map(rows.map((row) => [row.function_name, row]));
    return names.flatMap((functionName) => {
      const row = byFunction.get(functionName);
      if (!row) return [];
      if (row.billing_mode !== "byok" || !row.provider) return [];
      const summary: LaunchFunctionInferenceOverrideSummary = {
        appId: input.appId,
        functionName,
        billingMode: "byok",
        provider: row.provider,
        model: row.model ?? null,
        updatedAt: row.updated_at || null,
      };
      return [summary];
    });
  } catch (err) {
    console.warn("[FUNCTION-INFERENCE] list failed:", err);
    return [];
  }
}

export async function setFunctionInferenceOverride(
  input: FunctionInferenceOverrideSetInput,
): Promise<void> {
  const db = getDbConfig();
  if (!db) {
    throw new RequestValidationError(
      "Function inference override storage is not configured",
      503,
    );
  }
  const functionName = normalizeFunctionName(input.functionName);
  const allowed = new Set(input.allowedFunctionNames || []);
  if (allowed.size > 0 && !allowed.has(functionName)) {
    throw new RequestValidationError(
      `Unknown function for this Agent: ${functionName}`,
    );
  }
  if (input.billingMode !== "light" && input.billingMode !== "byok") {
    throw new RequestValidationError("billingMode must be light or byok");
  }
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) {
    throw new RequestValidationError("model is required");
  }
  const provider = input.billingMode === "byok" &&
      isActiveBYOKProvider(input.provider)
    ? input.provider
    : null;
  if (input.billingMode === "byok" && !provider) {
    throw new RequestValidationError("a valid BYOK provider is required");
  }
  await dbWrite(
    db,
    "/rest/v1/user_function_inference_overrides?on_conflict=user_id,app_id,function_name",
    [{
      user_id: input.userId,
      app_id: input.appId,
      function_name: functionName,
      billing_mode: input.billingMode,
      provider,
      model,
    }],
    "Failed to set function inference override",
  );
}

export async function clearFunctionInferenceOverride(input: {
  userId: string;
  appId: string;
  functionName: string;
}): Promise<void> {
  const db = getDbConfig();
  if (!db) {
    throw new RequestValidationError(
      "Function inference override storage is not configured",
      503,
    );
  }
  const functionName = normalizeFunctionName(input.functionName);
  const url = new URL(`${db.baseUrl}/rest/v1/user_function_inference_overrides`);
  url.searchParams.set("user_id", `eq.${input.userId}`);
  url.searchParams.set("app_id", `eq.${input.appId}`);
  url.searchParams.set("function_name", `eq.${functionName}`);
  const response = await fetch(url.toString(), {
    method: "DELETE",
    headers: { ...db.headers, Prefer: "return=minimal" },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new RequestValidationError(
      detail
        ? `Failed to clear function inference override: ${detail}`
        : "Failed to clear function inference override",
      500,
    );
  }
}

// ── DB helpers (mirror caller-function-permissions.ts) ──

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
