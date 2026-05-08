// GPU Compute Runtime — Billing Service
// Computes GPU call costs in Light (✦), applies failure chargeability rules,
// and settles balances via two mechanisms:
//   1. transfer_light — developer fee from caller to app owner (platform fee)
//   2. debit_light — compute cost burned from caller (platform revenue)
// Same pattern as chat-billing.ts for the burn, and mcp.ts for the transfer.

import type { GpuPricingConfig, GpuPricingMode, GpuType } from "./types.ts";
import {
  classifyFailure,
  computeGpuBillableDurationMs,
  computeGpuCostLight,
  GPU_COLD_START_BUFFER_MS,
} from "./types.ts";
import type { GpuExecuteResult } from "./executor.ts";
import type { App } from "../../../shared/types/index.ts";
import { formatLight, PLATFORM_FEE_RATE } from "../../../shared/types/index.ts";
import { getEnv } from "../../lib/env.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Breakdown of costs for a single GPU call. */
export interface GpuCostBreakdown {
  /** Platform GPU compute cost in Light (rate_per_ms × duration). */
  computeCostLight: number;
  /** Developer's fee in Light (per_call / per_unit / per_duration). */
  developerFeeLight: number;
  /** Total cost to caller in Light (compute + developer fee). */
  totalCostLight: number;
  /** Revenue transferred to owner in Light (developer fee minus platform fee). */
  ownerRevenueLight: number;
  /** Provider execution time excluding queue/cold-start delay. */
  executionDurationMs: number;
  /** Provider queue/cold-start delay charged through when present. */
  delayTimeMs: number;
  /** Provider-aligned billable duration for compute pass-through. */
  billableDurationMs: number;
}

/** Result from settling a GPU execution's billing. */
export interface GpuSettlementResult {
  /** Whether any charge was applied. */
  charged: boolean;
  /** Actual amount charged to caller in Light (compute debit + developer transfer). */
  chargedLight: number;
  /** Full cost breakdown (before failure policy adjustments). */
  breakdown: GpuCostBreakdown;
  /** Which failure policy was applied. */
  failurePolicy: "full_charge" | "compute_only" | "full_refund";
  /** True if transfer failed due to insufficient balance. */
  insufficientBalance?: boolean;
  /** Pre-formatted error message for the handler to return to caller. */
  insufficientBalanceMessage?: string;
  /** Actual compute cost debited from caller as platform revenue. */
  computeChargedLight: number;
  /** Actual developer fee transferred from caller to app owner. */
  developerFeeChargedLight: number;
}

interface GpuSettlementDeps {
  fetchFn?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max duration for cost estimation when not specified. */
const DEFAULT_MAX_DURATION_MS = 60_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the full cost breakdown for a GPU call.
 *
 * Uses the executor's computed gpuCostLight for compute, and the app's
 * gpu_pricing_config for the developer fee.
 */
export function computeGpuCallCost(
  app: App,
  functionName: string,
  args: Record<string, unknown>,
  gpuResult: GpuExecuteResult,
): GpuCostBreakdown {
  const developerFeeLight = computeDeveloperFee(
    app,
    functionName,
    args,
    gpuResult,
  );
  const computeCostLight = gpuResult.gpuCostLight;
  const totalCostLight = computeCostLight + developerFeeLight;

  return {
    computeCostLight,
    developerFeeLight,
    totalCostLight,
    ownerRevenueLight: developerFeeLight * (1 - PLATFORM_FEE_RATE),
    executionDurationMs: gpuResult.executionDurationMs ?? gpuResult.durationMs,
    delayTimeMs: gpuResult.delayTimeMs ?? 0,
    billableDurationMs: gpuResult.billableDurationMs ?? gpuResult.durationMs,
  };
}

/**
 * Estimate the maximum possible cost for a GPU call (pre-execution).
 *
 * Uses gpu_max_duration_ms with the GPU rate to compute worst-case compute
 * cost, plus the maximum possible developer fee.
 */
export function estimateMaxGpuCost(
  app: App,
  _functionName: string,
  args: Record<string, unknown>,
): number {
  const gpuTypeRaw = app.gpu_type ?? "";
  const maxDurationMs = app.gpu_max_duration_ms ?? DEFAULT_MAX_DURATION_MS;
  const maxBillableDurationMs = computeGpuBillableDurationMs(
    maxDurationMs + GPU_COLD_START_BUFFER_MS,
  );

  // Worst-case compute cost
  let maxComputeLight = 0;
  try {
    maxComputeLight = computeGpuCostLight(
      gpuTypeRaw as GpuType,
      maxBillableDurationMs,
    );
  } catch {
    // Invalid gpu_type — skip
  }

  // Max developer fee (same as actual for per_call and per_unit)
  const pricingConfig = app.gpu_pricing_config as GpuPricingConfig | null;
  let maxDevFee = 0;
  if (pricingConfig) {
    switch (pricingConfig.mode) {
      case "per_call":
        maxDevFee = pricingConfig.flat_fee_light ?? 0;
        break;
      case "per_unit": {
        const unitCount = pricingConfig.unit_count_from
          ? extractUnitCount(args, pricingConfig.unit_count_from)
          : 1;
        maxDevFee = (pricingConfig.unit_price_light ?? 0) * unitCount;
        break;
      }
      case "per_duration":
        maxDevFee = computeDurationDeveloperFee(
          pricingConfig,
          maxBillableDurationMs,
        );
        break;
    }
  }

  return maxComputeLight + maxDevFee;
}

/**
 * Settle billing for a completed GPU execution.
 *
 * Uses two settlement mechanisms:
 *   - transfer_light: developer fee from caller → owner (platform fee deducted)
 *   - debit_light: compute cost burned from caller (platform revenue)
 *
 * Failure policy:
 * - success       → full charge (transfer dev fee + debit compute)
 * - oom/timeout/exception → compute only (debit compute, no dev fee)
 * - infra_error    → nothing charged (full refund)
 *
 * If caller === owner, billing is skipped entirely (self-calls are free).
 */
export async function settleGpuExecution(
  userId: string,
  app: App,
  functionName: string,
  args: Record<string, unknown>,
  gpuResult: GpuExecuteResult,
  deps?: GpuSettlementDeps,
): Promise<GpuSettlementResult> {
  // Compute full breakdown
  const breakdown = computeGpuCallCost(app, functionName, args, gpuResult);

  // Apply failure chargeability
  const chargeability = classifyFailure(gpuResult.exitCode);
  let failurePolicy: GpuSettlementResult["failurePolicy"];
  let devFeeToTransfer: number;
  let computeToDebit: number;

  switch (chargeability) {
    case "chargeable":
      if (gpuResult.exitCode === "success") {
        failurePolicy = "full_charge";
        devFeeToTransfer = breakdown.developerFeeLight;
        computeToDebit = breakdown.computeCostLight;
      } else {
        failurePolicy = "compute_only";
        devFeeToTransfer = 0;
        computeToDebit = breakdown.computeCostLight;
      }
      break;
    case "non_chargeable":
      failurePolicy = "full_refund";
      devFeeToTransfer = 0;
      computeToDebit = 0;
      break;
    case "partial":
      failurePolicy = "compute_only";
      devFeeToTransfer = 0;
      computeToDebit = breakdown.computeCostLight;
      break;
  }

  // Skip billing for self-calls
  if (userId === app.owner_id) {
    return {
      charged: false,
      chargedLight: 0,
      breakdown,
      failurePolicy,
      computeChargedLight: 0,
      developerFeeChargedLight: 0,
    };
  }

  // Nothing to charge
  const totalCharge = devFeeToTransfer + computeToDebit;
  if (totalCharge <= 0) {
    return {
      charged: false,
      chargedLight: 0,
      breakdown,
      failurePolicy,
      computeChargedLight: 0,
      developerFeeChargedLight: 0,
    };
  }

  // ── Supabase config ──
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error("[GPU-BILLING] Supabase not configured, skipping billing");
    return {
      charged: false,
      chargedLight: 0,
      breakdown,
      failurePolicy,
      computeChargedLight: 0,
      developerFeeChargedLight: 0,
    };
  }

  const rpcHeaders = {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
  };

  try {
    const fetchFn = deps?.fetchFn ?? fetch;
    let actualDevFeeCharged = 0;
    let actualComputeCharged = 0;

    const currentBalance = await fetchUserBalanceLight(
      supabaseUrl,
      rpcHeaders,
      userId,
      fetchFn,
    );
    if (currentBalance !== null && currentBalance < totalCharge) {
      return {
        charged: false,
        chargedLight: 0,
        breakdown,
        failurePolicy,
        insufficientBalance: true,
        insufficientBalanceMessage: buildGpuInsufficientBalanceMessage(
          totalCharge,
        ),
        computeChargedLight: 0,
        developerFeeChargedLight: 0,
      };
    }

    // ── Step 1: Debit compute cost from caller (platform revenue) ──
    // Compute is collected before developer fee so provider spend is covered
    // even if a later transfer fails or the caller balance changes mid-flight.
    if (computeToDebit > 0) {
      const debitRes = await fetchFn(
        `${supabaseUrl}/rest/v1/rpc/debit_light`,
        {
          method: "POST",
          headers: rpcHeaders,
          body: JSON.stringify({
            p_user_id: userId,
            p_amount_light: computeToDebit,
            p_reason: "gpu_compute",
            p_update_billed_at: false,
            p_allow_partial: false,
            p_app_id: app.id,
            p_function_name: functionName,
            p_metadata: {
              gpu_type: gpuResult.gpuType,
              execution_duration_ms: breakdown.executionDurationMs,
              delay_time_ms: breakdown.delayTimeMs,
              billable_duration_ms: breakdown.billableDurationMs,
              billing_increment_ms: gpuResult.billingIncrementMs,
              exit_code: gpuResult.exitCode,
              compute_cost_light: computeToDebit,
              developer_fee_light: devFeeToTransfer,
              total_cost_light: totalCharge,
              failure_policy: failurePolicy,
            },
          }),
        },
      );

      if (debitRes.ok) {
        const debitResult = await debitRes.json() as Array<{
          old_balance: number;
          new_balance: number;
          was_depleted: boolean;
          amount_debited?: number;
        }>;

        if (!debitResult || debitResult.length === 0) {
          return {
            charged: false,
            chargedLight: 0,
            breakdown,
            failurePolicy,
            insufficientBalance: true,
            insufficientBalanceMessage: buildGpuInsufficientBalanceMessage(
              totalCharge,
            ),
            computeChargedLight: 0,
            developerFeeChargedLight: 0,
          };
        }

        actualComputeCharged = typeof debitResult[0].amount_debited === "number"
          ? debitResult[0].amount_debited
          : computeToDebit;

        // Log compute deduction to billing_transactions (fire-and-forget)
        fetchFn(`${supabaseUrl}/rest/v1/billing_transactions`, {
          method: "POST",
          headers: { ...rpcHeaders, "Prefer": "return=minimal" },
          body: JSON.stringify({
            user_id: userId,
            type: "charge",
            category: "gpu_compute",
            description: `GPU: ${
              app.gpu_type || "unknown"
            } ${breakdown.billableDurationMs}ms billed — ${
              app.name || app.slug
            }.${functionName}`,
            amount_light: -actualComputeCharged,
            balance_after_light: debitResult[0].new_balance,
            metadata: {
              app_id: app.id,
              function_name: functionName,
              gpu_type: gpuResult.gpuType,
              execution_duration_ms: breakdown.executionDurationMs,
              delay_time_ms: breakdown.delayTimeMs,
              billable_duration_ms: breakdown.billableDurationMs,
              billing_increment_ms: gpuResult.billingIncrementMs,
              exit_code: gpuResult.exitCode,
              compute_cost_light: computeToDebit,
              developer_fee_light: devFeeToTransfer,
              total_cost_light: totalCharge,
              failure_policy: failurePolicy,
            },
          }),
        }).catch(() => {});
      } else {
        const errorText = await debitRes.text();
        console.error(
          `[GPU-BILLING] Compute debit failed for ${userId}:`,
          errorText,
        );
        if (/insufficient/i.test(errorText)) {
          return {
            charged: false,
            chargedLight: 0,
            breakdown,
            failurePolicy,
            insufficientBalance: true,
            insufficientBalanceMessage: buildGpuInsufficientBalanceMessage(
              totalCharge,
            ),
            computeChargedLight: 0,
            developerFeeChargedLight: 0,
          };
        }
        return {
          charged: false,
          chargedLight: 0,
          breakdown,
          failurePolicy,
          computeChargedLight: 0,
          developerFeeChargedLight: 0,
        };
      }
    }

    // ── Step 2: Transfer developer fee to owner (if any) ──
    // transfer_light applies the configured platform fee before owner payout.
    if (devFeeToTransfer > 0) {
      const transferRes = await fetchFn(
        `${supabaseUrl}/rest/v1/rpc/transfer_light`,
        {
          method: "POST",
          headers: rpcHeaders,
          body: JSON.stringify({
            p_from_user: userId,
            p_to_user: app.owner_id,
            p_amount_light: devFeeToTransfer,
            p_reason: "gpu_call",
            p_app_id: app.id,
            p_function_name: functionName,
            p_metadata: {
              gpu_type: gpuResult.gpuType,
              execution_duration_ms: breakdown.executionDurationMs,
              delay_time_ms: breakdown.delayTimeMs,
              billable_duration_ms: breakdown.billableDurationMs,
              billing_increment_ms: gpuResult.billingIncrementMs,
              exit_code: gpuResult.exitCode,
              compute_cost_light: computeToDebit,
              developer_fee_light: devFeeToTransfer,
              total_cost_light: totalCharge,
              failure_policy: failurePolicy,
            },
          }),
        },
      );

      if (transferRes.ok) {
        const rows = await transferRes.json() as Array<{
          from_new_balance: number;
          to_new_balance: number;
          platform_fee: number;
        }>;

        if (!rows || rows.length === 0) {
          if (actualComputeCharged <= 0) {
            return {
              charged: false,
              chargedLight: 0,
              breakdown,
              failurePolicy,
              insufficientBalance: true,
              insufficientBalanceMessage: buildGpuInsufficientBalanceMessage(
                totalCharge,
              ),
              computeChargedLight: 0,
              developerFeeChargedLight: 0,
            };
          }
          console.error(
            `[GPU-BILLING] Developer fee transfer returned no rows after compute debit for ${userId} → ${app.owner_id}`,
          );
        } else {
          actualDevFeeCharged = devFeeToTransfer;
        }
      } else {
        console.error(
          `[GPU-BILLING] Transfer failed for ${userId} → ${app.owner_id}:`,
          await transferRes.text(),
        );
      }
    }

    const totalCharged = actualDevFeeCharged + actualComputeCharged;

    console.log(
      `[GPU-BILLING] ${userId}: dev_fee=${
        formatLight(actualDevFeeCharged)
      } → ${app.owner_id}, ` +
        `compute=${formatLight(actualComputeCharged)} (burned) ` +
        `[${failurePolicy}] for ${app.id}.${functionName}`,
    );

    return {
      charged: totalCharged > 0,
      chargedLight: totalCharged,
      breakdown,
      failurePolicy,
      computeChargedLight: actualComputeCharged,
      developerFeeChargedLight: actualDevFeeCharged,
    };
  } catch (err) {
    console.error("[GPU-BILLING] Settlement error:", err);
    return {
      charged: false,
      chargedLight: 0,
      breakdown,
      failurePolicy,
      computeChargedLight: 0,
      developerFeeChargedLight: 0,
    };
  }
}

/**
 * Extract a numeric value from args using a dot-path.
 *
 * Supports:
 * - Simple keys: "count" → args.count
 * - Nested keys: "images.count" → args.images.count
 * - Array length: "images.length" → args.images.length
 *
 * Returns 1 as fallback if path doesn't resolve or value isn't numeric.
 */
export function extractUnitCount(
  args: Record<string, unknown>,
  path: string,
): number {
  try {
    const parts = path.split(".");
    let current: unknown = args;

    for (const part of parts) {
      if (current === null || current === undefined) return 1;

      if (part === "length" && Array.isArray(current)) {
        return current.length;
      }

      if (typeof current === "object" && current !== null) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return 1;
      }
    }

    if (typeof current === "number" && !isNaN(current) && current > 0) {
      return Math.floor(current);
    }

    return 1;
  } catch {
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function buildGpuInsufficientBalanceMessage(totalCharge: number): string {
  return `Insufficient balance. This GPU function costs ~${
    formatLight(totalCharge)
  } per call. ` +
    `Add Light or add creator earnings to balance from the wallet at https://ultralight-api.rgn4jz429m.workers.dev/wallet.`;
}

async function fetchUserBalanceLight(
  supabaseUrl: string,
  headers: Record<string, string>,
  userId: string,
  fetchFn: typeof fetch,
): Promise<number | null> {
  try {
    const res = await fetchFn(
      `${supabaseUrl}/rest/v1/users?id=eq.${
        encodeURIComponent(userId)
      }&select=balance_light`,
      { method: "GET", headers },
    );
    if (!res.ok) return null;
    const rows = await res.json() as Array<{ balance_light?: unknown }>;
    const balance = rows?.[0]?.balance_light;
    return typeof balance === "number" && Number.isFinite(balance)
      ? balance
      : null;
  } catch {
    return null;
  }
}

function computeDurationDeveloperFee(
  pricingConfig: GpuPricingConfig,
  billableDurationMs: number,
): number {
  const seconds = computeGpuBillableDurationMs(billableDurationMs) / 1000;
  const perSecond =
    typeof pricingConfig.duration_rate_light_per_second === "number"
      ? pricingConfig.duration_rate_light_per_second
      : 0;
  const flatMarkup = typeof pricingConfig.duration_markup_light === "number"
    ? pricingConfig.duration_markup_light
    : 0;
  return (perSecond * seconds) + flatMarkup;
}

/**
 * Compute the developer fee based on the app's gpu_pricing_config.
 * Returns 0 if no pricing is configured.
 */
function computeDeveloperFee(
  app: App,
  _functionName: string,
  args: Record<string, unknown>,
  gpuResult: GpuExecuteResult,
): number {
  const pricingConfig = app.gpu_pricing_config as GpuPricingConfig | null;
  if (!pricingConfig) return 0;

  switch (pricingConfig.mode) {
    case "per_call":
      return pricingConfig.flat_fee_light ?? 0;

    case "per_unit": {
      const unitCount = pricingConfig.unit_count_from
        ? extractUnitCount(args, pricingConfig.unit_count_from)
        : 1;
      return (pricingConfig.unit_price_light ?? 0) * unitCount;
    }

    case "per_duration":
      return computeDurationDeveloperFee(
        pricingConfig,
        gpuResult.billableDurationMs ?? gpuResult.durationMs,
      );

    default:
      return 0;
  }
}
