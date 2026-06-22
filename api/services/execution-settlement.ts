import type { UserContext } from "../runtime/sandbox.ts";
import { getEnv } from "../lib/env.ts";
import { type BillingConfig, getBillingConfig } from "./billing-config.ts";
import type { App } from "../../shared/types/index.ts";
import {
  formatLight,
  LIGHT_PER_DOLLAR_DESKTOP,
} from "../../shared/types/index.ts";
import type {
  AgenticSurfaceActionCallMetadata,
  McpCallLogEntry,
  WidgetActionCallMetadata,
} from "./call-logger.ts";
import { logMcpCall } from "./call-logger.ts";
import type { GpuExecuteResult } from "./gpu/executor.ts";
import { settleGpuExecution } from "./gpu/billing.ts";
import { createSupabaseRestClient } from "./platform-clients/supabase-rest.ts";
import {
  calcCloudUsageLight,
  calcOperationCloudUnits,
  calcWorkerCloudUnits,
  type CloudOperationMeteringContext,
  type CloudUsageResource,
  CloudUsageRpcError,
  createRuntimeCloudHold,
  debitCloudUsage,
  releaseCloudUsageHold,
  type RuntimeCloudHoldResult,
  settleRuntimeCloudHold,
} from "./cloud-usage.ts";
import { recordRoutineCallContribution } from "./routine-rollups.ts";
import {
  type RoutineTraceContext,
  routineTraceMetadata,
} from "./routine-trace.ts";
import {
  type AccessPolicyRuntimeEvaluator,
  evaluateAccessPolicy,
  evaluateStaticAccessPolicy,
  isAccessPolicyDenied,
} from "./access-policy.ts";
import { createRuntimeAccessPolicyExecutor } from "./access-policy-runtime.ts";
import { buildEconomicIdempotencyKey } from "./economic-idempotency.ts";
import {
  computeSalesTaxLight,
  isSalesTaxConfigured,
  resolveSalesTaxRateBps,
} from "./sales-tax.ts";
import { resolveBuyerTaxLocation } from "./sales-tax-location.ts";

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

export interface RuntimeInfraCharge {
  amountLight: number;
  units: number;
  cloudUnits: number;
  resource: CloudUsageResource;
  source?: string;
  billingConfigVersion?: number | null;
  metadata?: Record<string, unknown>;
}

export interface SettleAppCallParams extends SettleCallerAppChargeParams {
  receiptId?: string;
  method?: string;
  callerAuthState?: "authenticated" | "anonymous";
  infraCharge?: RuntimeInfraCharge | null;
  runtimePricingPreflight?: RuntimeAppCallPricingPreflight | null;
  runtimeCloudSettlement?: RuntimeCloudSettlementForAppCall | null;
  routineContext?: RoutineTraceContext | null;
}

export interface AppCallSettlementResult {
  chargedLight: number;
  appChargeLight: number;
  appPriceLight: number;
  developerRevenueLight: number;
  platformFeeLight: number;
  feeWouldHaveBeenLight: number;
  feeWaivedLight: number;
  waiverSource?: string | null;
  waiverEventId?: string;
  infraChargeLight: number;
  freeCall: boolean;
  freeCallCount: number | null;
  freeCallLimit: number;
  payerUserId: string;
  infraPayerUserId: string | null;
  ownerSponsoredInfra: boolean;
  callerInfraFallback: boolean;
  transferId?: string;
  cloudUsageEventId?: string;
  cloudUsageHoldId?: string;
  cloudUnits?: number;
  billingConfigVersion?: number | null;
  // Per-transaction sales tax on the monetized app charge (consumption-time).
  taxStatus: string;
  taxableAmountLight: number;
  taxAmountLight: number;
  buyerBillingAddressId: string | null;
  buyerBillingAddressVersion: number | null;
  insufficientBalance: boolean;
  insufficientBalanceCode?:
    | "caller_auth_required"
    | "caller_light_required"
    | "owner_sponsor_light_required"
    | "access_policy_denied"
    | "access_policy_error";
  insufficientBalanceMessage?: string;
  receiptId?: string;
  metadata: Record<string, unknown>;
}

export interface RuntimeAppCallPricingPreflight {
  appPriceLight: number;
  appChargeLight: number;
  freeCall: boolean;
  freeCallCount: number | null;
  freeCallLimit: number;
  freeCallCounterKey: string | null;
  policySource?: string;
}

export interface RuntimeCloudSettlementForAppCall {
  holdId: string;
  eventId: string;
  payerUserId: string;
  ownerSponsoredInfra: boolean;
  callerInfraFallback: boolean;
  cloudUnits: number;
  amountLight: number;
  settledAmountLight: number;
  releasedAmountLight: number;
  billingConfigVersion: number;
}

export interface PreflightRuntimeCloudHoldParams {
  app: App;
  userId: string;
  functionName: string;
  inputArgs: Record<string, unknown>;
  receiptId?: string;
  method: string;
  timeoutMs: number;
  callerAuthState?: "authenticated" | "anonymous";
  // The calling Agent (P5) — exposed to the developer access_policy module so
  // a target dev can deny or reprice specific cross-Agent callers.
  callerAppId?: string | null;
  routineContext?: RoutineTraceContext | null;
}

export interface RuntimeCloudPreflightResult {
  hold: RuntimeCloudHoldResult | null;
  pricing: RuntimeAppCallPricingPreflight;
  billingConfig: BillingConfig;
  insufficientBalance: boolean;
  insufficientBalanceCode?: AppCallSettlementResult["insufficientBalanceCode"];
  insufficientBalanceMessage?: string;
  metadata: Record<string, unknown>;
}

export interface RuntimeOperationMeteringContextParams {
  preflight: RuntimeCloudPreflightResult;
  app: Pick<App, "id" | "owner_id" | "slug">;
  userId: string;
  functionName: string;
  receiptId?: string;
  method: string;
  metadata?: Record<string, unknown>;
  routineContext?: RoutineTraceContext | null;
}

export interface DebitWidgetPullUsageParams {
  preflight: RuntimeCloudPreflightResult;
  app: Pick<App, "id" | "owner_id" | "slug">;
  userId: string;
  functionName: string;
  receiptId?: string;
  widgetName?: string;
  widgetIntervalMs?: number;
  widgetPullReason?: string;
  metadata?: Record<string, unknown>;
  routineContext?: RoutineTraceContext | null;
}

export interface WidgetPullUsageResult {
  eventId: string;
  payerUserId: string;
  ownerSponsoredInfra: boolean;
  units: number;
  cloudUnits: number;
  amountLight: number;
}

export interface LogExecutionResultParams {
  receiptId?: string;
  userId: string;
  appId?: string;
  appName?: string;
  callerAppId?: string | null;
  callChainDepth?: number | null;
  functionName: string;
  method: string;
  success: boolean;
  durationMs: number;
  outputResult: unknown;
  errorMessage?: string;
  source?: McpCallLogEntry["source"];
  inputArgs?: Record<string, unknown>;
  userTier?: string;
  appVersion?: string;
  aiCostLight?: number;
  sessionId?: string;
  sequenceNumber?: number;
  userQuery?: string;
  callChargeLight?: number;
  appPriceLight?: number;
  appChargeLight?: number;
  infraChargeLight?: number;
  platformFeeLight?: number;
  developerNetLight?: number;
  freeCall?: boolean;
  freeCallCount?: number | null;
  freeCallLimit?: number;
  cloudUsageHoldId?: string;
  cloudUsageEventId?: string;
  cloudUnits?: number;
  cloudChargeLight?: number;
  billingConfigVersion?: number | null;
  cloudPayerUserId?: string;
  cloudOwnerSponsored?: boolean;
  taxStatus?: string;
  taxableAmountLight?: number;
  taxAmountLight?: number;
  buyerBillingAddressId?: string | null;
  buyerBillingAddressVersion?: number | null;
  routineContext?: RoutineTraceContext | null;
  toolInvocationId?: string;
  widgetAction?: WidgetActionCallMetadata;
  agenticSurfaceAction?: AgenticSurfaceActionCallMetadata;
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
  callerAppId?: string | null;
  callChainDepth?: number | null;
  gpuResult: GpuExecuteResult;
  durationMs: number;
  sessionId?: string;
  sequenceNumber?: number;
  userQuery?: string;
  source?: McpCallLogEntry["source"];
  routineContext?: RoutineTraceContext | null;
  widgetAction?: WidgetActionCallMetadata;
  agenticSurfaceAction?: AgenticSurfaceActionCallMetadata;
}

export interface SettleAndLogAppExecutionParams {
  receiptId?: string;
  userId: string;
  user: UserContext | null;
  app: App;
  functionName: string;
  inputArgs: Record<string, unknown>;
  method: string;
  success: boolean;
  durationMs: number;
  outputResult: unknown;
  errorMessage?: string;
  source?: McpCallLogEntry["source"];
  aiCostLight?: number;
  sessionId?: string;
  sequenceNumber?: number;
  userQuery?: string;
  infraCharge?: RuntimeInfraCharge | null;
  callerAuthState?: "authenticated" | "anonymous";
  // Cross-Agent attribution (P5): the initiating Agent + call-chain depth.
  callerAppId?: string | null;
  callChainDepth?: number | null;
  runtimePricingPreflight?: RuntimeAppCallPricingPreflight | null;
  runtimeCloudSettlement?: RuntimeCloudSettlementForAppCall | null;
  routineContext?: RoutineTraceContext | null;
  widgetAction?: WidgetActionCallMetadata;
  agenticSurfaceAction?: AgenticSurfaceActionCallMetadata;
}

interface ExecutionSettlementDeps {
  fetchFn?: typeof fetch;
  logMcpCallFn?: typeof logMcpCall;
  settleGpuExecutionFn?: typeof settleGpuExecution;
  accessPolicyExecutor?: AccessPolicyRuntimeEvaluator;
  resolveBuyerTaxLocationFn?: typeof resolveBuyerTaxLocation;
}

export function buildExecutionTelemetry(
  outputResult: unknown,
  durationMs: number,
): ExecutionTelemetry {
  const serialized = JSON.stringify(outputResult);
  const responseSizeBytes =
    new TextEncoder().encode(serialized || "").byteLength;
  const requestCost = 0.0000003;
  const cpuCost = durationMs * 0.00000002;

  return {
    responseSizeBytes,
    executionCostEstimateLight: (requestCost + cpuCost) *
      LIGHT_PER_DOLLAR_DESKTOP,
  };
}

function errorPayload(message?: string): Record<string, unknown> | null {
  return message ? { message } : null;
}

function safePreview(value: unknown, maxChars = 2000): Record<string, unknown> {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text.length <= maxChars) {
      return typeof value === "object" && value !== null &&
          !Array.isArray(value)
        ? value as Record<string, unknown>
        : { value };
    }
    return { truncated: true, text: text.slice(0, maxChars) };
  } catch {
    return { value_type: typeof value };
  }
}

export async function preflightRuntimeCloudHold(
  params: PreflightRuntimeCloudHoldParams,
  deps?: ExecutionSettlementDeps,
): Promise<RuntimeCloudPreflightResult> {
  const accessDecision = await evaluateAccessPolicy({
    app: params.app,
    caller: {
      userId: params.userId,
      authState: params.callerAuthState,
      callerAppId: params.callerAppId ?? null,
    },
    subject: { kind: "function", id: params.functionName },
    input: params.inputArgs,
    metadata: {
      method: params.method,
      receipt_id: params.receiptId,
    },
  }, {
    executeRuntimePolicy: deps?.accessPolicyExecutor ??
      createRuntimeAccessPolicyExecutor({ app: params.app }),
  });
  const billingConfig = await getBillingConfig();
  if (isAccessPolicyDenied(accessDecision)) {
    return {
      hold: null,
      pricing: {
        appPriceLight: 0,
        appChargeLight: 0,
        freeCall: false,
        freeCallCount: null,
        freeCallLimit: 0,
        freeCallCounterKey: null,
        policySource: accessDecision.source,
      },
      billingConfig,
      insufficientBalance: true,
      insufficientBalanceCode: accessDecision.code,
      insufficientBalanceMessage: accessDecision.reason,
      metadata: {
        ...accessDecision.metadata,
        billing_config_version: billingConfig.version,
        app_price_light: 0,
        app_charge_light: 0,
        free_call_limit: 0,
      },
    };
  }
  const appPriceLight = accessDecision.priceLight;
  const freeCallLimit = accessDecision.freeQuotaLimit;
  const basePricing: RuntimeAppCallPricingPreflight = {
    appPriceLight,
    appChargeLight: accessDecision.chargeLight,
    freeCall: accessDecision.free,
    freeCallCount: null,
    freeCallLimit,
    freeCallCounterKey: accessDecision.freeQuotaCounterKey,
    policySource: accessDecision.source,
  };

  if (
    params.userId !== params.app.owner_id &&
    appPriceLight > 0 &&
    params.callerAuthState === "anonymous"
  ) {
    return {
      hold: null,
      pricing: basePricing,
      billingConfig,
      insufficientBalance: true,
      insufficientBalanceCode: "caller_auth_required",
      insufficientBalanceMessage:
        "Authentication is required to call paid apps.",
      metadata: {
        ...accessDecision.metadata,
        billing_config_version: billingConfig.version,
        app_price_light: appPriceLight,
        app_charge_light: accessDecision.chargeLight,
        free_call_limit: freeCallLimit,
      },
    };
  }

  try {
    const hold = await createRuntimeCloudHold({
      callerUserId: params.userId,
      ownerUserId: params.app.owner_id,
      appId: params.app.id,
      functionName: params.functionName,
      receiptId: params.receiptId,
      source: params.method,
      timeoutMs: params.timeoutMs,
      appPriceLight,
      freeCallLimit,
      freeCallCounterKey: accessDecision.freeQuotaCounterKey,
      expiresAt: new Date(Date.now() + params.timeoutMs + 60_000).toISOString(),
      billingConfig,
      metadata: {
        ...accessDecision.metadata,
        ...routineTraceMetadata(params.routineContext),
        billing_config_version: billingConfig.version,
        app_slug: params.app.slug,
        method: params.method,
        receipt_id: params.receiptId,
        function_name: params.functionName,
        input_args: params.inputArgs,
        timeout_ms: params.timeoutMs,
      },
    }, deps);

    // Fold per-transaction sales tax into the upfront reservation. The infra
    // hold reserves only infra; the app charge + tax are paid at settlement.
    // Without this check a buyer who can afford the app charge but not the tax
    // would complete the sale and then under-collect tax (the settlement debit
    // is best-effort). Here we require — before the call runs — that the balance
    // remaining after the infra hold covers appCharge + tax; if not, we release
    // the hold and reject. Gated on a configured rate (zero hot-path cost when
    // tax is off) and on an authoritative paid charge (hold.appChargeLight is
    // post-free-quota, so free/self/sponsored calls are naturally exempt).
    if (isSalesTaxConfigured() && hold.appChargeLight > 0) {
      const resolveTaxLocation = deps?.resolveBuyerTaxLocationFn ??
        resolveBuyerTaxLocation;
      const buyer = await resolveTaxLocation(params.userId);
      const taxLight = computeSalesTaxLight(
        hold.appChargeLight,
        resolveSalesTaxRateBps(buyer?.location ?? null),
      );
      if (taxLight > 0 && hold.newBalance < hold.appChargeLight + taxLight) {
        await releaseCloudUsageHold({ holdId: hold.holdId }, deps).catch(
          (releaseErr) =>
            console.error(
              "[SALES-TAX] Failed to release hold after tax shortfall:",
              releaseErr,
            ),
        );
        const requiredLight = hold.appChargeLight + taxLight;
        return {
          hold: null,
          pricing: basePricing,
          billingConfig,
          insufficientBalance: true,
          insufficientBalanceCode: "caller_light_required",
          insufficientBalanceMessage: buildCallerLightRequiredMessage(
            requiredLight,
          ),
          metadata: {
            ...accessDecision.metadata,
            billing_config_version: billingConfig.version,
            app_price_light: hold.appPriceLight,
            app_charge_light: hold.appChargeLight,
            sales_tax_light: taxLight,
            required_with_tax_light: requiredLight,
            free_call_limit: freeCallLimit,
          },
        };
      }
    }

    return {
      hold,
      pricing: {
        appPriceLight: hold.appPriceLight,
        appChargeLight: hold.appChargeLight,
        freeCall: hold.freeCall,
        freeCallCount: hold.freeCallCount,
        freeCallLimit: hold.freeCallLimit,
        freeCallCounterKey: accessDecision.freeQuotaCounterKey,
        policySource: accessDecision.source,
      },
      billingConfig,
      insufficientBalance: false,
      metadata: {
        ...accessDecision.metadata,
        billing_config_version: billingConfig.version,
        cloud_usage_hold_id: hold.holdId,
        cloud_payer_user_id: hold.payerUserId,
        cloud_owner_sponsored: hold.ownerSponsoredInfra,
        caller_infra_fallback: hold.callerInfraFallback,
        expected_cloud_units: hold.expectedCloudUnits,
        expected_amount_light: hold.expectedAmountLight,
        app_price_light: hold.appPriceLight,
        app_charge_light: hold.appChargeLight,
        free_call: hold.freeCall,
        free_call_count: hold.freeCallCount,
        free_call_limit: hold.freeCallLimit,
      },
    };
  } catch (err) {
    const ownerSponsored = params.userId !== params.app.owner_id &&
      appPriceLight <= 0;
    const callerFallbackRequired = isCallerInfraFallbackLightRequired(err);
    const failurePricing = callerFallbackRequired
      ? { ...basePricing, appChargeLight: 0, freeCall: true }
      : basePricing;
    const code = callerFallbackRequired
      ? "caller_light_required"
      : ownerSponsored
      ? "owner_sponsor_light_required"
      : "caller_light_required";
    const amountLight = calculateExpectedRuntimeHoldAmount(
      params.timeoutMs,
      billingConfig,
    );
    if (!(err instanceof CloudUsageRpcError)) {
      console.error("[PRICING] Runtime cloud hold error:", err);
    }
    return {
      hold: null,
      pricing: failurePricing,
      billingConfig,
      insufficientBalance: true,
      insufficientBalanceCode: code,
      insufficientBalanceMessage: callerFallbackRequired
        ? buildCallerInfraFallbackLightRequiredMessage(amountLight)
        : ownerSponsored
        ? buildOwnerSponsorLightRequiredMessage(amountLight)
        : buildCallerLightRequiredMessage(amountLight),
      metadata: {
        ...accessDecision.metadata,
        billing_config_version: billingConfig.version,
        app_price_light: appPriceLight,
        app_charge_light: failurePricing.appChargeLight,
        free_call: failurePricing.freeCall,
        free_call_limit: freeCallLimit,
        caller_infra_fallback: callerFallbackRequired,
        timeout_ms: params.timeoutMs,
        expected_amount_light: amountLight,
      },
    };
  }
}

export function createRuntimeOperationMeteringContext(
  params: RuntimeOperationMeteringContextParams,
): CloudOperationMeteringContext | null {
  const hold = params.preflight.hold;
  if (!hold) {
    return null;
  }

  return {
    payerUserId: hold.payerUserId,
    sponsorUserId: hold.sponsorUserId,
    callerUserId: params.userId,
    ownerUserId: params.app.owner_id,
    appId: params.app.id,
    functionName: params.functionName,
    receiptId: params.receiptId,
    source: params.method,
    billingConfigVersion: params.preflight.billingConfig.version,
    metadata: {
      ...routineTraceMetadata(params.routineContext),
      app_slug: params.app.slug,
      runtime_cloud_hold_id: hold.holdId,
      owner_sponsored_infra: hold.ownerSponsoredInfra,
      caller_infra_fallback: hold.callerInfraFallback,
      ...(params.metadata ?? {}),
    },
  };
}

export async function settleRuntimeCloudPreflight(
  preflight: RuntimeCloudPreflightResult,
  durationMs: number,
  metadata?: Record<string, unknown>,
  deps?: ExecutionSettlementDeps,
): Promise<RuntimeCloudSettlementForAppCall | null> {
  if (!preflight.hold) {
    return null;
  }

  const settlement = await settleRuntimeCloudHold({
    holdId: preflight.hold.holdId,
    durationMs,
    billingConfig: preflight.billingConfig,
    metadata: {
      ...metadata,
      expected_cloud_units: preflight.hold.expectedCloudUnits,
      expected_amount_light: preflight.hold.expectedAmountLight,
    },
  }, deps);

  return {
    holdId: preflight.hold.holdId,
    eventId: settlement.eventId,
    payerUserId: preflight.hold.payerUserId,
    ownerSponsoredInfra: preflight.hold.ownerSponsoredInfra,
    callerInfraFallback: preflight.hold.callerInfraFallback,
    cloudUnits: settlement.cloudUnits,
    amountLight: settlement.amountLight,
    settledAmountLight: settlement.settledAmountLight,
    releasedAmountLight: settlement.releasedAmountLight,
    billingConfigVersion: preflight.billingConfig.version,
  };
}

export async function debitWidgetPullUsage(
  params: DebitWidgetPullUsageParams,
  deps?: ExecutionSettlementDeps,
): Promise<WidgetPullUsageResult | null> {
  const hold = params.preflight.hold;
  if (!hold) return null;

  const units = 1;
  const billingConfig = params.preflight.billingConfig;
  const cloudUnits = calcOperationCloudUnits(
    units,
    billingConfig.widgetPullsPerCloudUnit,
  );
  const amountLight = calcCloudUsageLight(
    cloudUnits,
    billingConfig.cloudUnitLightPer1k,
  );

  try {
    const event = await debitCloudUsage({
      payerUserId: hold.payerUserId,
      sponsorUserId: hold.sponsorUserId,
      callerUserId: params.userId,
      ownerUserId: params.app.owner_id,
      appId: params.app.id,
      functionName: params.functionName,
      receiptId: params.receiptId,
      source: "widget_pull",
      resource: "widget_pull",
      units,
      cloudUnits,
      amountLight,
      billingConfigVersion: billingConfig.version,
      metadata: {
        ...routineTraceMetadata(params.routineContext),
        app_slug: params.app.slug,
        method: "widget_pull",
        receipt_id: params.receiptId,
        function_name: params.functionName,
        widget_name: params.widgetName,
        widget_interval_ms: params.widgetIntervalMs,
        widget_pull_reason: params.widgetPullReason,
        widget_pulls_per_cloud_unit: billingConfig.widgetPullsPerCloudUnit,
        runtime_cloud_hold_id: hold.holdId,
        owner_sponsored_infra: hold.ownerSponsoredInfra,
        caller_infra_fallback: hold.callerInfraFallback,
        ...(params.metadata ?? {}),
      },
    }, deps);

    return {
      eventId: event.eventId,
      payerUserId: hold.payerUserId,
      ownerSponsoredInfra: hold.ownerSponsoredInfra,
      units,
      cloudUnits,
      amountLight: event.amountDebited,
    };
  } catch (err) {
    try {
      await releaseCloudUsageHold({
        holdId: hold.holdId,
        metadata: {
          reason: "widget_pull_debit_failed",
          receipt_id: params.receiptId,
          widget_name: params.widgetName,
          widget_pull_reason: params.widgetPullReason,
        },
      }, deps);
    } catch (releaseErr) {
      console.error(
        "[PRICING] Failed to release runtime hold after widget pull debit failure:",
        releaseErr,
      );
    }
    throw err;
  }
}

export async function settleCallerAppCharge(
  params: SettleCallerAppChargeParams,
  deps?: ExecutionSettlementDeps,
): Promise<SettleCallerAppChargeResult> {
  const settlement = await settleAppCall(params, deps);
  return {
    chargedLight: settlement.appChargeLight,
    insufficientBalance: settlement.insufficientBalance,
  };
}

export async function settleAppCall(
  params: SettleAppCallParams,
  deps?: ExecutionSettlementDeps,
): Promise<AppCallSettlementResult> {
  const {
    app,
    userId,
    functionName,
    inputArgs,
    successful,
    receiptId,
    method = "tools/call",
  } = params;
  const accessDecision = evaluateStaticAccessPolicy({
    app,
    caller: {
      userId,
      authState: params.callerAuthState,
    },
    subject: { kind: "function", id: functionName },
    input: inputArgs,
    metadata: {
      method,
      receipt_id: receiptId,
    },
  });
  const pricingPreflight = params.runtimePricingPreflight;
  const appPriceLight = pricingPreflight?.appPriceLight ??
    accessDecision.priceLight;
  const selfCall = userId === app.owner_id;
  const freeCallLimit = pricingPreflight?.freeCallLimit ??
    accessDecision.freeQuotaLimit;
  const freeCallCounterKey = pricingPreflight?.freeCallCounterKey ??
    accessDecision.freeQuotaCounterKey;
  let appChargeLight = successful && !selfCall
    ? (pricingPreflight?.appChargeLight ?? accessDecision.chargeLight)
    : 0;
  let freeCall = pricingPreflight?.freeCall ??
    (successful && accessDecision.free);
  let freeCallCount: number | null = pricingPreflight?.freeCallCount ?? null;
  let developerRevenueLight = 0;
  let platformFeeLight = 0;
  let feeWouldHaveBeenLight = 0;
  let feeWaivedLight = 0;
  let waiverSource: string | null | undefined;
  let waiverEventId: string | undefined;
  let transferId: string | undefined;
  let cloudUsageEventId: string | undefined;
  let taxStatus = "not_collecting";
  let taxableAmountLight = 0;
  let taxAmountLight = 0;
  let buyerBillingAddressId: string | null = null;
  let buyerBillingAddressVersion: number | null = null;

  const baseMetadata = {
    ...accessDecision.metadata,
    access_policy_source: pricingPreflight?.policySource ??
      accessDecision.source,
    ...routineTraceMetadata(params.routineContext),
    app_slug: app.slug,
    pricing_source: "app_call",
    method,
    receipt_id: receiptId,
    function_name: functionName,
  };

  const fetchFn = deps?.fetchFn ?? fetch;
  const supabaseConfigured = Boolean(
    getEnv("SUPABASE_URL") && getEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );
  const supabase = supabaseConfigured
    ? createSupabaseRestClient({ fetchFn })
    : null;

  if (
    successful &&
    !selfCall &&
    appChargeLight > 0 &&
    params.callerAuthState === "anonymous"
  ) {
    return buildInsufficientSettlement(params, {
      appPriceLight,
      freeCall,
      freeCallCount,
      freeCallLimit,
      code: "caller_auth_required",
      message: "Authentication is required to call paid apps.",
    });
  }

  if (
    !pricingPreflight && successful && !selfCall && appChargeLight > 0 &&
    freeCallLimit > 0 && freeCallCounterKey &&
    supabase
  ) {
    try {
      const usageRes = await supabase.rpc("increment_caller_usage", {
        p_app_id: app.id,
        p_user_id: userId,
        p_counter_key: freeCallCounterKey,
      });

      if (usageRes.ok) {
        freeCallCount = parseIncrementCallerUsageCount(await usageRes.json());
        if (freeCallCount !== null && freeCallCount <= freeCallLimit) {
          appChargeLight = 0;
          freeCall = true;
        }
      }
    } catch (usageErr) {
      console.error("[PRICING] Free calls usage check error:", usageErr);
    }
  }

  if (appChargeLight > 0) {
    if (!supabase) {
      console.error(
        "[PRICING] Supabase not configured for caller charge settlement",
      );
      return buildBaseSettlement(params, {
        appPriceLight,
        appChargeLight: 0,
        developerRevenueLight: 0,
        platformFeeLight: 0,
        freeCall,
        freeCallCount,
        freeCallLimit,
        infraChargeLight: 0,
        infraPayerUserId: null,
        ownerSponsoredInfra: false,
        callerInfraFallback: false,
        transferId,
        cloudUsageEventId,
      });
    }

    try {
      const transferReason = app.hosting_suspended === true
        ? "tool_call_suspended"
        : "tool_call";
      const transferRes = await supabase.rpc("transfer_light", {
        p_from_user: userId,
        p_to_user: app.owner_id,
        p_amount_light: appChargeLight,
        p_reason: transferReason,
        p_app_id: app.id,
        p_function_name: functionName,
        p_metadata: {
          ...baseMetadata,
          input_args: inputArgs,
        },
        p_idempotency_key: receiptId
          ? buildEconomicIdempotencyKey("tool_call_transfer", [
            receiptId,
            userId,
            app.id,
            functionName,
            transferReason,
          ])
          : null,
      });

      if (!transferRes.ok) {
        const body = await transferRes.text();
        console.error(
          `[PRICING] Transfer failed for ${userId} -> ${app.owner_id}:`,
          body,
        );
        return buildInsufficientSettlement(params, {
          appPriceLight,
          freeCall,
          freeCallCount,
          freeCallLimit,
          code: "caller_light_required",
          message: buildCallerLightRequiredMessage(appChargeLight),
        });
      }

      const rows = await transferRes.json() as Array<{
        from_new_balance?: number;
        to_new_balance?: number;
        platform_fee?: number;
        transfer_id?: string;
        fee_would_have_been?: number;
        fee_waived?: number;
        waiver_source?: string | null;
        waiver_event_id?: string | null;
      }>;
      if (!rows || rows.length === 0) {
        return buildInsufficientSettlement(params, {
          appPriceLight,
          freeCall,
          freeCallCount,
          freeCallLimit,
          code: "caller_light_required",
          message: buildCallerLightRequiredMessage(appChargeLight),
        });
      }

      platformFeeLight = typeof rows[0].platform_fee === "number"
        ? rows[0].platform_fee
        : 0;
      feeWouldHaveBeenLight = typeof rows[0].fee_would_have_been === "number"
        ? rows[0].fee_would_have_been
        : platformFeeLight;
      feeWaivedLight = typeof rows[0].fee_waived === "number"
        ? rows[0].fee_waived
        : 0;
      waiverSource = typeof rows[0].waiver_source === "string"
        ? rows[0].waiver_source
        : null;
      waiverEventId = typeof rows[0].waiver_event_id === "string"
        ? rows[0].waiver_event_id
        : undefined;
      developerRevenueLight = appChargeLight - platformFeeLight;
      transferId = typeof rows[0].transfer_id === "string"
        ? rows[0].transfer_id
        : undefined;

      if (
        app.hosting_suspended === true &&
        Number(rows[0].to_new_balance || 0) > 0
      ) {
        supabase.patch(`/rest/v1/users?id=eq.${app.owner_id}`, {
          hosting_suspended: false,
        }).catch(() => {});
        console.log(
          `[SUSPEND] Auto-unsuspended app ${app.id} — owner balance recovered to ${
            rows[0].to_new_balance
          } Light`,
        );
      }
    } catch (chargeErr) {
      console.error("[PRICING] Charge error:", chargeErr);
      return buildInsufficientSettlement(params, {
        appPriceLight,
        freeCall,
        freeCallCount,
        freeCallLimit,
        code: "caller_light_required",
        message: buildCallerLightRequiredMessage(appChargeLight),
      });
    }
  }

  const runtimeCloudSettlement = params.runtimeCloudSettlement;
  const infraCharge = runtimeCloudSettlement
    ? null
    : normalizeInfraCharge(params.infraCharge);
  let infraPayerUserId = runtimeCloudSettlement?.payerUserId ??
    (infraCharge ? (appChargeLight > 0 ? userId : app.owner_id) : null);
  let ownerSponsoredInfra = runtimeCloudSettlement?.ownerSponsoredInfra ??
    Boolean(
      infraCharge && infraPayerUserId === app.owner_id &&
        userId !== app.owner_id,
    );
  const callerInfraFallback = runtimeCloudSettlement?.callerInfraFallback ??
    Boolean(
      infraCharge && freeCall && !ownerSponsoredInfra &&
        infraPayerUserId === userId && userId !== app.owner_id,
    );
  let infraChargeLight = runtimeCloudSettlement?.settledAmountLight ?? 0;
  let cloudUsageHoldId = runtimeCloudSettlement?.holdId;
  let cloudUnits = runtimeCloudSettlement?.cloudUnits;
  const billingConfigVersion = runtimeCloudSettlement?.billingConfigVersion ??
    infraCharge?.billingConfigVersion ?? null;

  if (runtimeCloudSettlement) {
    cloudUsageEventId = runtimeCloudSettlement.eventId;
  }

  if (infraCharge && infraPayerUserId) {
    try {
      const infraResult = await debitCloudUsage({
        payerUserId: infraPayerUserId,
        sponsorUserId: ownerSponsoredInfra ? app.owner_id : null,
        callerUserId: userId,
        ownerUserId: app.owner_id,
        appId: app.id,
        functionName,
        receiptId,
        source: infraCharge.source || method,
        resource: infraCharge.resource,
        units: infraCharge.units,
        cloudUnits: infraCharge.cloudUnits,
        amountLight: infraCharge.amountLight,
        billingConfigVersion: infraCharge.billingConfigVersion ?? null,
        metadata: {
          ...baseMetadata,
          ...infraCharge.metadata,
          payer_role: ownerSponsoredInfra ? "owner_sponsor" : "caller",
        },
      }, { fetchFn });
      infraChargeLight = infraResult.amountDebited;
      cloudUsageEventId = infraResult.eventId;
      cloudUnits = infraCharge.cloudUnits;
    } catch (err) {
      const insufficient = err instanceof CloudUsageRpcError &&
        /insufficient/i.test(err.message);
      if (insufficient || ownerSponsoredInfra) {
        return buildInsufficientSettlement(params, {
          appPriceLight,
          appChargeLight,
          developerRevenueLight,
          platformFeeLight,
          feeWouldHaveBeenLight,
          feeWaivedLight,
          waiverSource,
          waiverEventId,
          infraChargeLight: 0,
          infraPayerUserId,
          ownerSponsoredInfra,
          callerInfraFallback,
          freeCall,
          freeCallCount,
          freeCallLimit,
          transferId,
          billingConfigVersion,
          code: ownerSponsoredInfra
            ? "owner_sponsor_light_required"
            : "caller_light_required",
          message: ownerSponsoredInfra
            ? buildOwnerSponsorLightRequiredMessage(infraCharge.amountLight)
            : buildCallerLightRequiredMessage(infraCharge.amountLight),
        });
      }
      console.error("[PRICING] Cloud usage debit error:", err);
    }
  }

  // Per-transaction sales tax on the monetized app charge (the buyer's purchase
  // from the seller). Charged on top of the sale and collected by the platform
  // to remit. Gated on a configured rate, so an empty rate table never reads the
  // buyer's address or debits anything — the path is inert until a jurisdiction
  // is turned on. Best-effort: the sale already settled, so a tax failure logs
  // and records `not_collecting` rather than failing an otherwise-paid call.
  if (appChargeLight > 0 && supabase && isSalesTaxConfigured()) {
    try {
      const resolveTaxLocation = deps?.resolveBuyerTaxLocationFn ??
        resolveBuyerTaxLocation;
      const buyer = await resolveTaxLocation(userId);
      if (buyer) {
        buyerBillingAddressId = buyer.addressId;
        buyerBillingAddressVersion = buyer.version;
      }
      const rateBps = resolveSalesTaxRateBps(buyer?.location ?? null);
      const computedTax = computeSalesTaxLight(appChargeLight, rateBps);
      if (computedTax > 0) {
        const taxRes = await supabase.rpc("debit_light", {
          p_user_id: userId,
          p_amount_light: computedTax,
          p_reason: "sales_tax",
          p_update_billed_at: false,
          p_allow_partial: true,
          p_idempotency_key: receiptId
            ? buildEconomicIdempotencyKey("sales_tax", [
              receiptId,
              userId,
              app.id,
              functionName,
            ])
            : null,
          p_metadata: {
            ...baseMetadata,
            taxable_amount_light: appChargeLight,
            tax_rate_bps: rateBps,
            buyer_billing_address_id: buyerBillingAddressId,
            buyer_billing_address_version: buyerBillingAddressVersion,
          },
        });
        if (taxRes.ok) {
          const rows = await taxRes.json() as Array<
            { amount_debited?: number }
          >;
          const debited = typeof rows?.[0]?.amount_debited === "number"
            ? rows[0].amount_debited
            : computedTax;
          taxableAmountLight = appChargeLight;
          taxAmountLight = debited;
          taxStatus = "collected";
        } else {
          console.error(
            "[SALES-TAX] debit_light failed:",
            await taxRes.text().catch(() => ""),
          );
        }
      }
    } catch (taxErr) {
      console.error("[SALES-TAX] Tax settlement error:", taxErr);
    }
  }

  return buildBaseSettlement(params, {
    appPriceLight,
    appChargeLight,
    developerRevenueLight,
    platformFeeLight,
    feeWouldHaveBeenLight,
    feeWaivedLight,
    waiverSource,
    waiverEventId,
    infraChargeLight,
    infraPayerUserId,
    ownerSponsoredInfra,
    callerInfraFallback,
    freeCall,
    freeCallCount,
    freeCallLimit,
    transferId,
    cloudUsageEventId,
    cloudUsageHoldId,
    cloudUnits,
    billingConfigVersion,
    taxStatus,
    taxableAmountLight,
    taxAmountLight,
    buyerBillingAddressId,
    buyerBillingAddressVersion,
  });
}

export function logExecutionResult(
  params: LogExecutionResultParams,
  deps?: ExecutionSettlementDeps,
): void {
  const telemetry = buildExecutionTelemetry(
    params.outputResult,
    params.durationMs,
  );
  const logMcpCallFn = deps?.logMcpCallFn ?? logMcpCall;

  logMcpCallFn({
    receiptId: params.receiptId,
    userId: params.userId,
    appId: params.appId,
    appName: params.appName,
    callerAppId: params.callerAppId ?? null,
    callChainDepth: params.callChainDepth ?? null,
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
    appPriceLight: params.appPriceLight,
    appChargeLight: params.appChargeLight,
    infraChargeLight: params.infraChargeLight,
    platformFeeLight: params.platformFeeLight,
    developerNetLight: params.developerNetLight,
    freeCall: params.freeCall,
    freeCallCount: params.freeCallCount,
    freeCallLimit: params.freeCallLimit,
    cloudUsageHoldId: params.cloudUsageHoldId,
    cloudUsageEventId: params.cloudUsageEventId,
    cloudUnits: params.cloudUnits,
    cloudChargeLight: params.cloudChargeLight,
    billingConfigVersion: params.billingConfigVersion,
    cloudPayerUserId: params.cloudPayerUserId,
    cloudOwnerSponsored: params.cloudOwnerSponsored,
    taxStatus: params.taxStatus,
    taxableAmountLight: params.taxableAmountLight,
    taxAmountLight: params.taxAmountLight,
    buyerBillingAddressId: params.buyerBillingAddressId ?? undefined,
    buyerBillingAddressVersion: params.buyerBillingAddressVersion ?? undefined,
    routineId: params.routineContext?.routineId,
    routineRunId: params.routineContext?.routineRunId,
    traceId: params.routineContext?.traceId,
    toolInvocationId: params.toolInvocationId,
    widgetAction: params.widgetAction,
    agenticSurfaceAction: params.agenticSurfaceAction,
    gpuType: params.gpuType,
    gpuExitCode: params.gpuExitCode,
    gpuDurationMs: params.gpuDurationMs,
    gpuCostLight: params.gpuCostLight,
    gpuPeakVramGb: params.gpuPeakVramGb,
    gpuDeveloperFeeLight: params.gpuDeveloperFeeLight,
    gpuFailurePolicy: params.gpuFailurePolicy,
  });
}

export async function settleAndLogAppExecution(
  params: SettleAndLogAppExecutionParams,
  deps?: ExecutionSettlementDeps,
): Promise<{
  settlement: AppCallSettlementResult;
  chargedLight: number;
  receiptId?: string;
  routineStep?: { step_id: string; step_index: number; total_light: number };
}> {
  const settlement = await settleAppCall({
    app: params.app,
    userId: params.userId,
    functionName: params.functionName,
    inputArgs: params.inputArgs,
    successful: params.success,
    receiptId: params.receiptId,
    method: params.method,
    callerAuthState: params.callerAuthState,
    infraCharge: params.infraCharge,
    runtimePricingPreflight: params.runtimePricingPreflight,
    runtimeCloudSettlement: params.runtimeCloudSettlement,
    routineContext: params.routineContext,
  }, deps);

  const routineCostLight = params.receiptId
    ? settlement.appChargeLight
    : settlement.chargedLight;
  const routineContribution = params.routineContext
    ? recordRoutineCallContribution({
      userId: params.userId,
      routine: params.routineContext,
      appId: params.app.id,
      appRef: params.app.slug,
      functionName: params.functionName,
      receiptId: params.receiptId,
      status: params.success && !settlement.insufficientBalance
        ? "succeeded"
        : "failed",
      durationMs: params.durationMs,
      costLight: routineCostLight,
      argsPreview: safePreview(params.inputArgs),
      resultPreview: safePreview(
        settlement.insufficientBalance
          ? settlement.metadata
          : params.outputResult,
      ),
      error: errorPayload(
        settlement.insufficientBalance
          ? settlement.insufficientBalanceMessage
          : params.errorMessage,
      ),
      metadata: {
        method: params.method,
        app_slug: params.app.slug,
        cloud_usage_hold_id: settlement.cloudUsageHoldId ?? null,
        cloud_usage_event_id: settlement.cloudUsageEventId ?? null,
        billing_config_version: settlement.billingConfigVersion ?? null,
        transfer_id: settlement.transferId ?? null,
        app_charge_light: settlement.appChargeLight,
        infra_charge_light: settlement.infraChargeLight,
        developer_revenue_light: settlement.developerRevenueLight,
        platform_fee_light: settlement.platformFeeLight,
        fee_would_have_been_light: settlement.feeWouldHaveBeenLight,
        fee_waived_light: settlement.feeWaivedLight,
        waiver_source: settlement.waiverSource ?? null,
        waiver_event_id: settlement.waiverEventId ?? null,
      },
    }, deps).catch((err) => {
      console.error("[ROUTINE] Failed to record routine contribution:", err);
      return null;
    })
    : null;

  logExecutionResult({
    userId: params.userId,
    receiptId: params.receiptId,
    appId: params.app.id,
    appName: params.app.name || params.app.slug,
    callerAppId: params.callerAppId ?? null,
    callChainDepth: params.callChainDepth ?? null,
    functionName: params.functionName,
    method: params.method,
    success: params.success && !settlement.insufficientBalance,
    durationMs: params.durationMs,
    errorMessage: settlement.insufficientBalance
      ? settlement.insufficientBalanceMessage
      : params.errorMessage,
    source: params.source,
    inputArgs: params.inputArgs,
    outputResult: settlement.insufficientBalance
      ? settlement.metadata
      : params.outputResult,
    userTier: params.user?.tier,
    appVersion: params.app.current_version || undefined,
    aiCostLight: params.aiCostLight || 0,
    sessionId: params.sessionId,
    sequenceNumber: params.sequenceNumber,
    userQuery: params.userQuery,
    callChargeLight: settlement.appChargeLight,
    appPriceLight: settlement.appPriceLight,
    appChargeLight: settlement.appChargeLight,
    infraChargeLight: settlement.infraChargeLight,
    platformFeeLight: settlement.platformFeeLight,
    developerNetLight: settlement.developerRevenueLight,
    freeCall: settlement.freeCall,
    freeCallCount: settlement.freeCallCount,
    freeCallLimit: settlement.freeCallLimit,
    cloudUsageHoldId: settlement.cloudUsageHoldId,
    cloudUsageEventId: settlement.cloudUsageEventId,
    cloudUnits: settlement.cloudUnits,
    cloudChargeLight: settlement.infraChargeLight,
    billingConfigVersion: settlement.billingConfigVersion,
    cloudPayerUserId: settlement.infraPayerUserId || undefined,
    cloudOwnerSponsored: settlement.ownerSponsoredInfra,
    taxStatus: settlement.taxStatus,
    taxableAmountLight: settlement.taxableAmountLight,
    taxAmountLight: settlement.taxAmountLight,
    buyerBillingAddressId: settlement.buyerBillingAddressId,
    buyerBillingAddressVersion: settlement.buyerBillingAddressVersion,
    routineContext: params.routineContext,
    widgetAction: params.widgetAction,
    agenticSurfaceAction: params.agenticSurfaceAction,
  }, deps);

  const routineStep = routineContribution ? await routineContribution : null;

  return {
    settlement,
    chargedLight: settlement.chargedLight,
    receiptId: params.receiptId,
    ...(routineStep ? { routineStep } : {}),
  };
}

export async function settleAndLogGpuExecution(
  params: SettleAndLogGpuExecutionParams,
  deps?: ExecutionSettlementDeps,
): Promise<{
  settlement: Awaited<ReturnType<typeof settleGpuExecution>> | null;
  chargedLight: number;
  receiptId?: string;
  routineStep?: { step_id: string; step_index: number; total_light: number };
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
      {
        fetchFn: deps?.fetchFn,
        receiptId: params.receiptId,
      },
    );
    chargedLight = settlement.chargedLight;
  }

  const routineContribution = params.routineContext
    ? recordRoutineCallContribution({
      userId: params.userId,
      routine: params.routineContext,
      appId: params.app.id,
      appRef: params.app.slug,
      functionName: params.functionName,
      receiptId: params.receiptId,
      status: params.gpuResult.success ? "succeeded" : "failed",
      durationMs: params.durationMs,
      costLight: chargedLight,
      argsPreview: safePreview(params.inputArgs),
      resultPreview: safePreview(
        params.gpuResult.success
          ? params.gpuResult.result
          : params.gpuResult.error,
      ),
      error: errorPayload(params.gpuResult.error?.message),
      metadata: {
        method: params.method,
        app_slug: params.app.slug,
        gpu_type: params.gpuResult.gpuType,
        gpu_exit_code: params.gpuResult.exitCode,
        gpu_cost_light: params.gpuResult.gpuCostLight,
        gpu_developer_fee_light: settlement?.developerFeeChargedLight ?? 0,
      },
    }, deps).catch((err) => {
      console.error(
        "[ROUTINE] Failed to record GPU routine contribution:",
        err,
      );
      return null;
    })
    : null;

  logExecutionResult({
    userId: params.userId,
    receiptId: params.receiptId,
    appId: params.app.id,
    appName: params.app.name || params.app.slug,
    callerAppId: params.callerAppId ?? null,
    callChainDepth: params.callChainDepth ?? null,
    functionName: params.functionName,
    method: params.method,
    success: params.gpuResult.success,
    durationMs: params.durationMs,
    errorMessage: params.gpuResult.success
      ? undefined
      : params.gpuResult.error?.message,
    source: params.source,
    inputArgs: params.inputArgs,
    outputResult: params.gpuResult.success
      ? params.gpuResult.result
      : params.gpuResult.error,
    userTier: params.user?.tier,
    appVersion: params.app.current_version || undefined,
    sessionId: params.sessionId,
    sequenceNumber: params.sequenceNumber,
    userQuery: params.userQuery,
    callChargeLight: chargedLight,
    gpuType: params.gpuResult.gpuType,
    gpuExitCode: params.gpuResult.exitCode,
    gpuDurationMs: params.gpuResult.billableDurationMs ??
      params.gpuResult.durationMs,
    gpuCostLight: params.gpuResult.gpuCostLight,
    gpuPeakVramGb: params.gpuResult.peakVramGb,
    gpuDeveloperFeeLight: settlement?.developerFeeChargedLight || 0,
    gpuFailurePolicy: settlement?.failurePolicy,
    routineContext: params.routineContext,
    widgetAction: params.widgetAction,
    agenticSurfaceAction: params.agenticSurfaceAction,
  }, deps);

  const routineStep = routineContribution ? await routineContribution : null;
  return {
    settlement,
    chargedLight,
    receiptId: params.receiptId,
    ...(routineStep ? { routineStep } : {}),
  };
}

function normalizeInfraCharge(
  charge: RuntimeInfraCharge | null | undefined,
): RuntimeInfraCharge | null {
  if (!charge || charge.amountLight <= 0) {
    return null;
  }
  return {
    ...charge,
    units: Math.max(charge.units, 0),
    cloudUnits: Math.max(charge.cloudUnits, 0),
  };
}

function buildBaseSettlement(
  params: SettleAppCallParams,
  values: {
    appPriceLight: number;
    appChargeLight: number;
    developerRevenueLight: number;
    platformFeeLight: number;
    feeWouldHaveBeenLight?: number;
    feeWaivedLight?: number;
    waiverSource?: string | null;
    waiverEventId?: string;
    infraChargeLight: number;
    infraPayerUserId: string | null;
    ownerSponsoredInfra: boolean;
    callerInfraFallback: boolean;
    freeCall: boolean;
    freeCallCount: number | null;
    freeCallLimit: number;
    transferId?: string;
    cloudUsageEventId?: string;
    cloudUsageHoldId?: string;
    cloudUnits?: number;
    billingConfigVersion?: number | null;
    taxStatus?: string;
    taxableAmountLight?: number;
    taxAmountLight?: number;
    buyerBillingAddressId?: string | null;
    buyerBillingAddressVersion?: number | null;
  },
): AppCallSettlementResult {
  const accessDecision = evaluateStaticAccessPolicy({
    app: params.app,
    caller: {
      userId: params.userId,
      authState: params.callerAuthState,
    },
    subject: { kind: "function", id: params.functionName },
    input: params.inputArgs,
    metadata: {
      method: params.method,
      receipt_id: params.receiptId,
    },
  });
  return {
    chargedLight: values.appChargeLight + values.infraChargeLight,
    appChargeLight: values.appChargeLight,
    appPriceLight: values.appPriceLight,
    developerRevenueLight: values.developerRevenueLight,
    platformFeeLight: values.platformFeeLight,
    feeWouldHaveBeenLight: values.feeWouldHaveBeenLight ??
      values.platformFeeLight,
    feeWaivedLight: values.feeWaivedLight ?? 0,
    waiverSource: values.waiverSource ?? null,
    waiverEventId: values.waiverEventId,
    infraChargeLight: values.infraChargeLight,
    freeCall: values.freeCall,
    freeCallCount: values.freeCallCount,
    freeCallLimit: values.freeCallLimit,
    payerUserId: params.userId,
    infraPayerUserId: values.infraPayerUserId,
    ownerSponsoredInfra: values.ownerSponsoredInfra,
    callerInfraFallback: values.callerInfraFallback,
    transferId: values.transferId,
    cloudUsageEventId: values.cloudUsageEventId,
    cloudUsageHoldId: values.cloudUsageHoldId,
    cloudUnits: values.cloudUnits,
    billingConfigVersion: values.billingConfigVersion ?? null,
    taxStatus: values.taxStatus ?? "not_collecting",
    taxableAmountLight: values.taxableAmountLight ?? 0,
    taxAmountLight: values.taxAmountLight ?? 0,
    buyerBillingAddressId: values.buyerBillingAddressId ?? null,
    buyerBillingAddressVersion: values.buyerBillingAddressVersion ?? null,
    insufficientBalance: false,
    receiptId: params.receiptId,
    metadata: {
      ...accessDecision.metadata,
      ...routineTraceMetadata(params.routineContext),
      app_price_light: values.appPriceLight,
      app_charge_light: values.appChargeLight,
      developer_revenue_light: values.developerRevenueLight,
      platform_fee_light: values.platformFeeLight,
      fee_would_have_been_light: values.feeWouldHaveBeenLight ??
        values.platformFeeLight,
      fee_waived_light: values.feeWaivedLight ?? 0,
      waiver_source: values.waiverSource ?? null,
      waiver_event_id: values.waiverEventId,
      infra_charge_light: values.infraChargeLight,
      free_call: values.freeCall,
      free_call_count: values.freeCallCount,
      free_call_limit: values.freeCallLimit,
      infra_payer_user_id: values.infraPayerUserId,
      owner_sponsored_infra: values.ownerSponsoredInfra,
      caller_infra_fallback: values.callerInfraFallback,
      transfer_id: values.transferId,
      cloud_usage_hold_id: values.cloudUsageHoldId,
      cloud_usage_event_id: values.cloudUsageEventId,
      cloud_units: values.cloudUnits,
      billing_config_version: values.billingConfigVersion ?? null,
      tax_status: values.taxStatus ?? "not_collecting",
      taxable_amount_light: values.taxableAmountLight ?? 0,
      tax_amount_light: values.taxAmountLight ?? 0,
      receipt_id: params.receiptId,
    },
  };
}

function buildInsufficientSettlement(
  params: SettleAppCallParams,
  values: {
    appPriceLight: number;
    appChargeLight?: number;
    developerRevenueLight?: number;
    platformFeeLight?: number;
    feeWouldHaveBeenLight?: number;
    feeWaivedLight?: number;
    waiverSource?: string | null;
    waiverEventId?: string;
    infraChargeLight?: number;
    infraPayerUserId?: string | null;
    ownerSponsoredInfra?: boolean;
    callerInfraFallback?: boolean;
    freeCall: boolean;
    freeCallCount: number | null;
    freeCallLimit: number;
    transferId?: string;
    cloudUsageEventId?: string;
    cloudUsageHoldId?: string;
    cloudUnits?: number;
    billingConfigVersion?: number | null;
    code: NonNullable<AppCallSettlementResult["insufficientBalanceCode"]>;
    message: string;
  },
): AppCallSettlementResult {
  const base = buildBaseSettlement(params, {
    appPriceLight: values.appPriceLight,
    appChargeLight: values.appChargeLight || 0,
    developerRevenueLight: values.developerRevenueLight || 0,
    platformFeeLight: values.platformFeeLight || 0,
    infraChargeLight: values.infraChargeLight || 0,
    infraPayerUserId: values.infraPayerUserId ?? null,
    ownerSponsoredInfra: values.ownerSponsoredInfra || false,
    callerInfraFallback: values.callerInfraFallback || false,
    freeCall: values.freeCall,
    freeCallCount: values.freeCallCount,
    freeCallLimit: values.freeCallLimit,
    transferId: values.transferId,
    cloudUsageEventId: values.cloudUsageEventId,
    cloudUsageHoldId: values.cloudUsageHoldId,
    cloudUnits: values.cloudUnits,
    billingConfigVersion: values.billingConfigVersion,
  });
  return {
    ...base,
    insufficientBalance: true,
    insufficientBalanceCode: values.code,
    insufficientBalanceMessage: values.message,
    metadata: {
      ...base.metadata,
      insufficient_balance: true,
      insufficient_balance_code: values.code,
      insufficient_balance_message: values.message,
    },
  };
}

function buildCallerLightRequiredMessage(amountLight: number): string {
  return `Insufficient credits balance. This call requires ${
    formatLight(amountLight)
  }. Add credits to your wallet or add creator earnings to balance and try again.`;
}

function buildCallerInfraFallbackLightRequiredMessage(
  amountLight: number,
): string {
  return `The app owner cannot sponsor this free call right now. You can continue by paying ${
    formatLight(amountLight)
  } for infrastructure from your credits balance.`;
}

function buildOwnerSponsorLightRequiredMessage(amountLight: number): string {
  return `This free call requires ${
    formatLight(amountLight)
  } of credits-backed sponsorship. Add credits to your wallet or add creator earnings to balance to call this app.`;
}

function isCallerInfraFallbackLightRequired(err: unknown): boolean {
  return err instanceof CloudUsageRpcError &&
    /caller_infra_fallback_light_required/i.test(err.message);
}

function calculateExpectedRuntimeHoldAmount(
  timeoutMs: number,
  billingConfig: Pick<
    BillingConfig,
    "workerMsPerCloudUnit" | "cloudUnitLightPer1k"
  >,
): number {
  return calcCloudUsageLight(
    calcWorkerCloudUnits(timeoutMs, billingConfig.workerMsPerCloudUnit),
    billingConfig.cloudUnitLightPer1k,
  );
}

function parseIncrementCallerUsageCount(payload: unknown): number | null {
  if (Array.isArray(payload) && payload.length > 0) {
    return parseIncrementCallerUsageCount(payload[0]);
  }
  if (payload && typeof payload === "object") {
    const candidate = payload as {
      increment_caller_usage?: unknown;
      count?: unknown;
      call_count?: unknown;
      current_count?: unknown;
    };
    if (typeof candidate.increment_caller_usage === "number") {
      return candidate.increment_caller_usage;
    }
    if (typeof candidate.count === "number") {
      return candidate.count;
    }
    if (typeof candidate.call_count === "number") {
      return candidate.call_count;
    }
    if (typeof candidate.current_count === "number") {
      return candidate.current_count;
    }
  }
  if (typeof payload === "number") {
    return payload;
  }
  return null;
}
