// MCP Call Logger Service
// Records MCP tool calls with full I/O telemetry for monitoring,
// dashboard display, and structured training data export.

import { getEnv } from "../lib/env.ts";
import {
  attachCallReceipts,
  CALL_RECEIPT_LOG_SELECT,
  type CallReceipt,
  type CallReceiptLogRow,
} from "./call-receipts.ts";
import { createServerLogger } from "./logging.ts";

/** Maximum size for input_args and output_result JSONB (bytes). */
const MAX_IO_SIZE = 10_000;
const telemetryLogger = createServerLogger("TELEMETRY");

export interface McpCallLogEntry {
  receiptId?: string;
  userId: string;
  appId?: string;
  appName?: string;
  functionName: string;
  method: string;
  success: boolean;
  durationMs?: number;
  errorMessage?: string;
  source?:
    | "direct"
    | "appstore"
    | "library"
    | "desk"
    | "onboarding_template"
    | "widget_pull";
  // Rich telemetry fields
  inputArgs?: Record<string, unknown>;
  outputResult?: unknown;
  userTier?: string;
  appVersion?: string;
  aiCostLight?: number;
  sessionId?: string;
  sequenceNumber?: number;
  userQuery?: string;
  // Cost telemetry fields — for per-call pricing calibration
  responseSizeBytes?: number;
  executionCostEstimateLight?: number;
  // Per-call pricing: amount charged to caller and transferred to owner
  callChargeLight?: number;
  appPriceLight?: number;
  appChargeLight?: number;
  infraChargeLight?: number;
  platformFeeLight?: number;
  developerNetLight?: number;
  buyerBillingAddressId?: string;
  buyerBillingAddressVersion?: number;
  taxStatus?: string;
  taxableAmountLight?: number;
  taxAmountLight?: number;
  freeCall?: boolean;
  freeCallCount?: number | null;
  freeCallLimit?: number;
  // Cloud usage metering fields — populated for Worker/runtime cloud holds
  cloudUsageHoldId?: string;
  cloudUsageEventId?: string;
  cloudUnits?: number;
  cloudChargeLight?: number;
  cloudPayerUserId?: string;
  cloudOwnerSponsored?: boolean;
  routineId?: string;
  routineRunId?: string;
  traceId?: string;
  toolInvocationId?: string;
  // GPU metering fields — populated for gpu runtime calls
  gpuType?: string;
  gpuExitCode?: string;
  /** Provider-aligned billable GPU duration, including queue/cold-start delay when reported. */
  gpuDurationMs?: number;
  gpuCostLight?: number;
  gpuPeakVramGb?: number;
  gpuDeveloperFeeLight?: number;
  gpuFailurePolicy?: string;
  widgetAction?: WidgetActionCallMetadata;
  agenticSurfaceAction?: AgenticSurfaceActionCallMetadata;
}

export function createExecutionReceiptId(): string {
  return crypto.randomUUID();
}

/**
 * Truncate a value to fit within MAX_IO_SIZE when JSON-stringified.
 * Returns the value as-is if small enough, or a truncated placeholder.
 */
function truncateForStorage(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length <= MAX_IO_SIZE) return value;
    // Too large — store a summary
    return {
      _truncated: true,
      _original_size: json.length,
      _preview: json.slice(0, 500),
    };
  } catch {
    return { _error: "Could not serialize value" };
  }
}

/**
 * Log an MCP call. Fire-and-forget — errors are silently caught.
 */
export function logMcpCall(entry: McpCallLogEntry): void {
  // Fire and forget — don't await
  _insertLog(entry).catch((err) => {
    telemetryLogger.error("Failed to persist MCP call telemetry", {
      function_name: entry.functionName,
      app_id: entry.appId,
      method: entry.method,
      error: err,
    });
  });
}

export function buildMcpCallLogInsertPayload(
  entry: McpCallLogEntry,
): Record<string, unknown> {
  return {
    id: entry.receiptId,
    user_id: entry.userId,
    app_id: entry.appId || null,
    app_name: entry.appName || null,
    function_name: entry.functionName,
    method: entry.method,
    success: entry.success,
    duration_ms: entry.durationMs || null,
    error_message: entry.errorMessage || null,
    source: entry.source || "direct",
    // Rich telemetry
    input_args: truncateForStorage(entry.inputArgs),
    output_result: truncateForStorage(entry.outputResult),
    user_tier: entry.userTier || null,
    app_version: entry.appVersion || null,
    ai_cost_light: entry.aiCostLight || 0,
    session_id: entry.sessionId || null,
    sequence_number: entry.sequenceNumber ?? null,
    user_query: entry.userQuery || null,
    // Cost telemetry
    response_size_bytes: entry.responseSizeBytes ?? null,
    execution_cost_estimate_light: entry.executionCostEstimateLight ?? null,
    call_charge_light: entry.callChargeLight ?? null,
    app_price_light: entry.appPriceLight ?? null,
    app_charge_light: entry.appChargeLight ?? null,
    infra_charge_light: entry.infraChargeLight ?? null,
    platform_fee_light: entry.platformFeeLight ?? null,
    developer_net_light: entry.developerNetLight ?? null,
    buyer_billing_address_id: entry.buyerBillingAddressId ?? null,
    buyer_billing_address_version: entry.buyerBillingAddressVersion ?? null,
    tax_status: entry.taxStatus ?? "not_collecting",
    taxable_amount_light: entry.taxableAmountLight ?? 0,
    tax_amount_light: entry.taxAmountLight ?? 0,
    free_call: entry.freeCall ?? false,
    free_call_count: entry.freeCallCount ?? null,
    free_call_limit: entry.freeCallLimit ?? null,
    cloud_usage_hold_id: entry.cloudUsageHoldId ?? null,
    cloud_usage_event_id: entry.cloudUsageEventId ?? null,
    cloud_units: entry.cloudUnits ?? null,
    cloud_charge_light: entry.cloudChargeLight ?? null,
    cloud_payer_user_id: entry.cloudPayerUserId ?? null,
    cloud_owner_sponsored: entry.cloudOwnerSponsored ?? false,
    routine_id: entry.routineId ?? null,
    routine_run_id: entry.routineRunId ?? null,
    trace_id: entry.traceId ?? null,
    tool_invocation_id: entry.toolInvocationId ?? null,
    widget_action: !!entry.widgetAction,
    widget_surface_id: entry.widgetAction?.surfaceId ?? null,
    widget_id: entry.widgetAction?.widgetId ?? null,
    widget_action_id: entry.widgetAction?.actionId ?? null,
    widget_turn_id: entry.widgetAction?.turnId ?? null,
    agentic_surface_action: !!entry.agenticSurfaceAction,
    agentic_surface_id: entry.agenticSurfaceAction?.surfaceId ?? null,
    agentic_interface_id: entry.agenticSurfaceAction?.interfaceId ?? null,
    agentic_action_id: entry.agenticSurfaceAction?.actionId ?? null,
    agentic_turn_id: entry.agenticSurfaceAction?.turnId ?? null,
    agentic_component_id: entry.agenticSurfaceAction?.componentId ?? null,
    // GPU metering
    gpu_type: entry.gpuType ?? null,
    gpu_exit_code: entry.gpuExitCode ?? null,
    gpu_duration_ms: entry.gpuDurationMs ?? null,
    gpu_cost_light: entry.gpuCostLight ?? null,
    gpu_peak_vram_gb: entry.gpuPeakVramGb ?? null,
    gpu_developer_fee_light: entry.gpuDeveloperFeeLight ?? null,
    gpu_failure_policy: entry.gpuFailurePolicy ?? null,
  };
}

async function _insertLog(entry: McpCallLogEntry): Promise<void> {
  const response = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/mcp_call_logs`,
    {
      method: "POST",
      headers: {
        "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
        "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildMcpCallLogInsertPayload(entry)),
    },
  );

  if (!response.ok) {
    telemetryLogger.error(
      "MCP call telemetry insert returned a non-OK response",
      {
        status: response.status,
        function_name: entry.functionName,
        app_id: entry.appId,
        body: await response.text(),
      },
    );
  }
}

export interface WidgetActionCallMetadata {
  surfaceId?: string;
  widgetId?: string;
  actionId?: string;
  turnId?: string;
}

export interface AgenticSurfaceActionCallMetadata {
  surfaceId?: string;
  interfaceId?: string;
  actionId?: string;
  turnId?: string;
  componentId?: string;
}

/**
 * Extract _user_query, _session_id, and widget metadata from tool call arguments.
 * Returns the clean args (without meta fields) and the extracted meta.
 * Agents pass these as extra fields alongside real tool arguments.
 */
export function extractCallMeta(args: Record<string, unknown>): {
  cleanArgs: Record<string, unknown>;
  userQuery?: string;
  sessionId?: string;
  widgetPull?: {
    widgetName?: string;
    intervalMs?: number;
    reason?: string;
  };
  widgetAction?: WidgetActionCallMetadata;
  agenticSurfaceAction?: AgenticSurfaceActionCallMetadata;
} {
  const {
    _user_query,
    _session_id,
    _widget_pull,
    _widget_name,
    _widget_interval_ms,
    _widget_pull_reason,
    _widget_action,
    _widget_surface_id,
    _widget_id,
    _widget_action_id,
    _widget_turn_id,
    _agentic_surface_action,
    _agentic_surface_id,
    _agentic_interface_id,
    _agentic_action_id,
    _agentic_turn_id,
    _agentic_component_id,
    ...cleanArgs
  } = args;
  const widgetIntervalMs = typeof _widget_interval_ms === "number" &&
      Number.isFinite(_widget_interval_ms)
    ? Math.max(0, Math.round(_widget_interval_ms))
    : undefined;
  const widgetPull = _widget_pull === true
    ? {
      widgetName: typeof _widget_name === "string" && _widget_name.trim()
        ? _widget_name.trim()
        : undefined,
      intervalMs: widgetIntervalMs,
      reason: typeof _widget_pull_reason === "string" &&
          _widget_pull_reason.trim()
        ? _widget_pull_reason.trim()
        : undefined,
    }
    : undefined;
  const widgetSurfaceId = typeof _widget_surface_id === "string" &&
      _widget_surface_id.trim()
    ? _widget_surface_id.trim()
    : undefined;
  const widgetId = typeof _widget_id === "string" && _widget_id.trim()
    ? _widget_id.trim()
    : typeof _widget_name === "string" && _widget_name.trim()
    ? _widget_name.trim()
    : undefined;
  const widgetActionId = typeof _widget_action_id === "string" &&
      _widget_action_id.trim()
    ? _widget_action_id.trim()
    : undefined;
  const widgetTurnId = typeof _widget_turn_id === "string" &&
      _widget_turn_id.trim()
    ? _widget_turn_id.trim()
    : undefined;
  const widgetAction = _widget_action === true || widgetActionId
    ? {
      surfaceId: widgetSurfaceId,
      widgetId,
      actionId: widgetActionId,
      turnId: widgetTurnId,
    }
    : undefined;
  const agenticSurfaceId = typeof _agentic_surface_id === "string" &&
      _agentic_surface_id.trim()
    ? _agentic_surface_id.trim()
    : undefined;
  const agenticInterfaceId = typeof _agentic_interface_id === "string" &&
      _agentic_interface_id.trim()
    ? _agentic_interface_id.trim()
    : undefined;
  const agenticActionId = typeof _agentic_action_id === "string" &&
      _agentic_action_id.trim()
    ? _agentic_action_id.trim()
    : undefined;
  const agenticTurnId = typeof _agentic_turn_id === "string" &&
      _agentic_turn_id.trim()
    ? _agentic_turn_id.trim()
    : undefined;
  const agenticComponentId = typeof _agentic_component_id === "string" &&
      _agentic_component_id.trim()
    ? _agentic_component_id.trim()
    : undefined;
  const agenticSurfaceAction = _agentic_surface_action === true ||
      agenticActionId || agenticInterfaceId
    ? {
      surfaceId: agenticSurfaceId,
      interfaceId: agenticInterfaceId,
      actionId: agenticActionId,
      turnId: agenticTurnId,
      componentId: agenticComponentId,
    }
    : undefined;
  return {
    cleanArgs,
    userQuery: typeof _user_query === "string" ? _user_query : undefined,
    sessionId: typeof _session_id === "string" ? _session_id : undefined,
    widgetPull,
    widgetAction,
    agenticSurfaceAction,
  };
}

/**
 * Get recent MCP call logs for a user.
 */
export async function getRecentCalls(
  userId: string,
  options: {
    limit?: number;
    since?: string;
    before?: string;
    appId?: string;
  } = {},
): Promise<
  Array<CallReceiptLogRow & { receipt_id: string; receipt: CallReceipt }>
> {
  const limit = options.limit || 50;
  const url = new URL(`${getEnv("SUPABASE_URL")}/rest/v1/mcp_call_logs`);
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("select", CALL_RECEIPT_LOG_SELECT);

  if (options.since) {
    url.searchParams.set("created_at", `gt.${options.since}`);
  } else if (options.before) {
    url.searchParams.set("created_at", `lt.${options.before}`);
  }

  if (options.appId) {
    url.searchParams.set("app_id", `eq.${options.appId}`);
  }

  const response = await fetch(url.toString(), {
    headers: {
      "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get call logs: ${await response.text()}`);
  }

  const logs = await response.json() as CallReceiptLogRow[];
  return await attachCallReceipts(logs);
}

/**
 * Get call logs for an app (all users) — owner-only view.
 * Unlike getRecentCalls which filters by user_id, this filters by app_id
 * and includes user_id so the owner can see who called.
 */
export async function getAppCallLog(
  appId: string,
  options: { limit?: number } = {},
): Promise<
  Array<CallReceiptLogRow & { receipt_id: string; receipt: CallReceipt }>
> {
  const limit = Math.min(options.limit || 50, 200);
  const url = `${
    getEnv("SUPABASE_URL")
  }/rest/v1/mcp_call_logs?app_id=eq.${appId}&order=created_at.desc&limit=${limit}&select=${CALL_RECEIPT_LOG_SELECT}`;

  const response = await fetch(url, {
    headers: {
      "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
      "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get app call logs: ${await response.text()}`);
  }

  const logs = await response.json() as CallReceiptLogRow[];
  return await attachCallReceipts(logs);
}
