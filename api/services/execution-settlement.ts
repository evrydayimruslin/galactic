import type { UserContext } from '../runtime/sandbox.ts';
import { getEnv } from '../lib/env.ts';
import type {
  App,
  AppPricingConfig,
} from '../../shared/types/index.ts';
import {
  getCallPriceLight,
  getFreeCalls,
  getFreeCallsScope,
  LIGHT_PER_DOLLAR_DESKTOP,
} from '../../shared/types/index.ts';
import type { McpCallLogEntry } from './call-logger.ts';
import { logMcpCall } from './call-logger.ts';
import type { GpuExecuteResult } from './gpu/executor.ts';
import { settleGpuExecution } from './gpu/billing.ts';
import { createSupabaseRestClient } from './platform-clients/supabase-rest.ts';

export interface ExecutionTelemetry {
  responseSizeBytes: number;
  executionCostEstimateLight: number;
}

export interface SettleCallerAppChargeParams {
  app: App;
  userId: string;
  functionName: string;
  inputArgs: Record<string, unknown>;
  successful: boolean;
}

export interface SettleCallerAppChargeResult {
  chargedLight: number;
  insufficientBalance: boolean;
}

export interface LogExecutionResultParams {
  receiptId?: string;
  userId: string;
  appId?: string;
  appName?: string;
  functionName: string;
  method: string;
  success: boolean;
  durationMs: number;
  outputResult: unknown;
  errorMessage?: string;
  source?: McpCallLogEntry['source'];
  inputArgs?: Record<string, unknown>;
  userTier?: string;
  appVersion?: string;
  aiCostLight?: number;
  sessionId?: string;
  sequenceNumber?: number;
  userQuery?: string;
  callChargeLight?: number;
  gpuType?: string;
  gpuExitCode?: string;
  gpuDurationMs?: number;
  gpuCostLight?: number;
  gpuPeakVramGb?: number;
  gpuDeveloperFeeLight?: number;
  gpuFailurePolicy?: string;
}

export interface SettleAndLogGpuExecutionParams {
  receiptId?: string;
  userId: string;
  user: UserContext | null;
  app: App;
  functionName: string;
  inputArgs: Record<string, unknown>;
  method: string;
  gpuResult: GpuExecuteResult;
  durationMs: number;
  sessionId?: string;
  sequenceNumber?: number;
  userQuery?: string;
  source?: McpCallLogEntry['source'];
}

interface ExecutionSettlementDeps {
  fetchFn?: typeof fetch;
  logMcpCallFn?: typeof logMcpCall;
  settleGpuExecutionFn?: typeof settleGpuExecution;
}

export function buildExecutionTelemetry(
  outputResult: unknown,
  durationMs: number,
): ExecutionTelemetry {
  const serialized = JSON.stringify(outputResult);
  const responseSizeBytes = new TextEncoder().encode(serialized || '').byteLength;
  const requestCost = 0.0000003;
  const cpuCost = durationMs * 0.00000002;

  return {
    responseSizeBytes,
    executionCostEstimateLight: (requestCost + cpuCost) * LIGHT_PER_DOLLAR_DESKTOP,
  };
}

export async function settleCallerAppCharge(
  params: SettleCallerAppChargeParams,
  deps?: ExecutionSettlementDeps,
): Promise<SettleCallerAppChargeResult> {
  const { app, userId, functionName, inputArgs, successful } = params;
  if (!successful || userId === app.owner_id) {
    return { chargedLight: 0, insufficientBalance: false };
  }

  const pricingConfig = app.pricing_config as AppPricingConfig | null;
  let chargedLight = getCallPriceLight(pricingConfig, functionName);
  if (chargedLight <= 0) {
    return { chargedLight: 0, insufficientBalance: false };
  }

  const fetchFn = deps?.fetchFn ?? fetch;
  const supabaseUrl = getEnv('SUPABASE_URL');
  const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    console.error('[PRICING] Supabase not configured for caller charge settlement');
    return { chargedLight: 0, insufficientBalance: false };
  }
  const supabase = createSupabaseRestClient({ fetchFn });

  const freeCalls = getFreeCalls(pricingConfig, functionName);
  if (freeCalls > 0) {
    const scope = getFreeCallsScope(pricingConfig);
    const counterKey = scope === 'app' ? '__app__' : functionName;
    try {
      const usageRes = await supabase.rpc('increment_caller_usage', {
        p_app_id: app.id,
        p_user_id: userId,
        p_counter_key: counterKey,
      });

      if (usageRes.ok) {
        const callCount = parseIncrementCallerUsageCount(await usageRes.json());
        if (callCount !== null && callCount <= freeCalls) {
          chargedLight = 0;
        }
      }
    } catch (usageErr) {
      console.error('[PRICING] Free calls usage check error:', usageErr);
    }
  }

  if (chargedLight <= 0) {
    return { chargedLight: 0, insufficientBalance: false };
  }

  try {
    const transferReason = app.hosting_suspended === true ? 'tool_call_suspended' : 'tool_call';
    const transferRes = await supabase.rpc('transfer_light', {
      p_from_user: userId,
      p_to_user: app.owner_id,
      p_amount_light: chargedLight,
      p_reason: transferReason,
      p_app_id: app.id,
      p_function_name: functionName,
      p_metadata: {
        app_slug: app.slug,
        pricing_source: 'app_call',
      },
    });

    if (!transferRes.ok) {
      console.error(`[PRICING] Transfer failed for ${userId} -> ${app.owner_id}:`, await transferRes.text());
      return { chargedLight: 0, insufficientBalance: false };
    }

    const rows = await transferRes.json() as Array<{ from_new_balance: number; to_new_balance: number }>;
    if (!rows || rows.length === 0) {
      return { chargedLight: 0, insufficientBalance: true };
    }

    if (app.hosting_suspended === true && rows[0].to_new_balance > 0) {
      supabase.patch(`/rest/v1/users?id=eq.${app.owner_id}`, { hosting_suspended: false }).catch(() => {});
      console.log(`[SUSPEND] Auto-unsuspended app ${app.id} — owner balance recovered to ${rows[0].to_new_balance}¢`);
    }

    return { chargedLight, insufficientBalance: false };
  } catch (chargeErr) {
    console.error('[PRICING] Charge error:', chargeErr);
    return { chargedLight: 0, insufficientBalance: false };
  }
}

export function logExecutionResult(
  params: LogExecutionResultParams,
  deps?: ExecutionSettlementDeps,
): void {
  const telemetry = buildExecutionTelemetry(params.outputResult, params.durationMs);
  const logMcpCallFn = deps?.logMcpCallFn ?? logMcpCall;

  logMcpCallFn({
    receiptId: params.receiptId,
    userId: params.userId,
    appId: params.appId,
    appName: params.appName,
    functionName: params.functionName,
    method: params.method,
    success: params.success,
    durationMs: params.durationMs,
    errorMessage: params.errorMessage,
    source: params.source,
    inputArgs: params.inputArgs,
    outputResult: params.outputResult,
    userTier: params.userTier,
    appVersion: params.appVersion,
    aiCostLight: params.aiCostLight,
    sessionId: params.sessionId,
    sequenceNumber: params.sequenceNumber,
    userQuery: params.userQuery,
    responseSizeBytes: telemetry.responseSizeBytes,
    executionCostEstimateLight: telemetry.executionCostEstimateLight,
    callChargeLight: params.callChargeLight,
    gpuType: params.gpuType,
    gpuExitCode: params.gpuExitCode,
    gpuDurationMs: params.gpuDurationMs,
    gpuCostLight: params.gpuCostLight,
    gpuPeakVramGb: params.gpuPeakVramGb,
    gpuDeveloperFeeLight: params.gpuDeveloperFeeLight,
    gpuFailurePolicy: params.gpuFailurePolicy,
  });
}

export async function settleAndLogGpuExecution(
  params: SettleAndLogGpuExecutionParams,
  deps?: ExecutionSettlementDeps,
): Promise<{
  settlement: Awaited<ReturnType<typeof settleGpuExecution>> | null;
  chargedLight: number;
  receiptId?: string;
}> {
  const settleGpuExecutionFn = deps?.settleGpuExecutionFn ?? settleGpuExecution;
  let settlement: Awaited<ReturnType<typeof settleGpuExecution>> | null = null;
  let chargedLight = 0;

  if (params.userId !== params.app.owner_id) {
    settlement = await settleGpuExecutionFn(
      params.userId,
      params.app,
      params.functionName,
      params.inputArgs,
      params.gpuResult,
    );
    chargedLight = settlement.chargedLight;
  }

  logExecutionResult({
    userId: params.userId,
    receiptId: params.receiptId,
    appId: params.app.id,
    appName: params.app.name || params.app.slug,
    functionName: params.functionName,
    method: params.method,
    success: params.gpuResult.success,
    durationMs: params.durationMs,
    errorMessage: params.gpuResult.success ? undefined : params.gpuResult.error?.message,
    source: params.source,
    inputArgs: params.inputArgs,
    outputResult: params.gpuResult.success ? params.gpuResult.result : params.gpuResult.error,
    userTier: params.user?.tier,
    appVersion: params.app.current_version || undefined,
    sessionId: params.sessionId,
    sequenceNumber: params.sequenceNumber,
    userQuery: params.userQuery,
    callChargeLight: chargedLight,
    gpuType: params.gpuResult.gpuType,
    gpuExitCode: params.gpuResult.exitCode,
    gpuDurationMs: params.gpuResult.billableDurationMs ?? params.gpuResult.durationMs,
    gpuCostLight: params.gpuResult.gpuCostLight,
    gpuPeakVramGb: params.gpuResult.peakVramGb,
    gpuDeveloperFeeLight: settlement?.developerFeeChargedLight || 0,
    gpuFailurePolicy: settlement?.failurePolicy,
  }, deps);

  return { settlement, chargedLight, receiptId: params.receiptId };
}

function parseIncrementCallerUsageCount(payload: unknown): number | null {
  if (Array.isArray(payload) && payload.length > 0) {
    return parseIncrementCallerUsageCount(payload[0]);
  }
  if (payload && typeof payload === 'object') {
    const candidate = payload as { increment_caller_usage?: unknown; count?: unknown; call_count?: unknown };
    if (typeof candidate.increment_caller_usage === 'number') {
      return candidate.increment_caller_usage;
    }
    if (typeof candidate.count === 'number') {
      return candidate.count;
    }
    if (typeof candidate.call_count === 'number') {
      return candidate.call_count;
    }
  }
  if (typeof payload === 'number') {
    return payload;
  }
  return null;
}
