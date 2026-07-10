// Chat Billing Service
// Handles balance checks and post-stream cost deduction for /chat/stream.
// Reuses balance_light wallet and billing_transactions audit trail.
// Uses debit_light RPC with p_update_billed_at=false (chat doesn't affect hosting clock).

import { getEnv } from "../lib/env.ts";
import type {
  ChatBillingResult,
  ChatUsage,
} from "../../shared/contracts/ai.ts";
import {
  CHAT_MIN_BALANCE_LIGHT,
  CHAT_PLATFORM_MARKUP,
} from "../../shared/contracts/ai.ts";
import {
  formatLight,
  LIGHT_PER_DOLLAR_DESKTOP,
} from "../../shared/types/index.ts";
import { buildEconomicIdempotencyKey } from "./economic-idempotency.ts";
import {
  calculatePlatformInferenceCost,
  resolvePlatformInferenceModel,
} from "./platform-inference-models.ts";

export interface ChatBillingMetadata {
  traceId?: string;
  conversationId?: string;
  messageId?: string;
  source?: string;
  // App + function attribution for galactic.ai() calls (debit_light persists
  // them as first-class p_app_id/p_function_name). Absent on the chat surface,
  // which has no app context.
  appId?: string | null;
  functionName?: string | null;
  [key: string]: unknown;
}

export interface ChatBillingCostOptions {
  billingSource?: "none" | "openrouter" | "platform_deepseek_direct";
  now?: Date;
  lightPerDollar?: number;
}

function dbHeaders(): Record<string, string> {
  return {
    "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
    "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
  };
}

function dbWriteHeaders(): Record<string, string> {
  return {
    ...dbHeaders(),
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
  };
}

// ============================================
// BALANCE CHECK
// ============================================

/**
 * Check if user has sufficient balance for chat.
 * Returns the current balance in Light.
 */
export async function checkChatBalance(userId: string): Promise<number> {
  const res = await fetch(
    `${
      getEnv("SUPABASE_URL")
    }/rest/v1/users?id=eq.${userId}&select=balance_light`,
    { headers: dbHeaders() },
  );
  if (!res.ok) throw new Error("Failed to query user balance");
  const rows = await res.json() as Array<{ balance_light: number | null }>;
  if (!rows || rows.length === 0) throw new Error("User not found");
  return rows[0].balance_light ?? 0;
}

// ============================================
// COST CALCULATION
// ============================================

/** Per-model pricing fallback (USD per million tokens). Conservative estimates. */
const MODEL_RATES: Record<
  string,
  { inputPerMillion: number; outputPerMillion: number }
> = {
  "anthropic/claude-sonnet-4-20250514": {
    inputPerMillion: 3,
    outputPerMillion: 15,
  },
  "anthropic/claude-3.5-sonnet": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-3-opus": { inputPerMillion: 15, outputPerMillion: 75 },
  "openai/gpt-4o": { inputPerMillion: 5, outputPerMillion: 15 },
  "openai/gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "google/gemini-pro-1.5": { inputPerMillion: 2.5, outputPerMillion: 7.5 },
  "deepseek/deepseek-chat": { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  // Default platform models, now served via OpenRouter. Accurate rates here keep
  // the fallback honest when OpenRouter doesn't report total_cost (the runtime-ai
  // path never passes it), instead of overcharging via DEFAULT_RATES.
  "deepseek/deepseek-v4-flash": { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  "deepseek/deepseek-v4-pro": { inputPerMillion: 1.74, outputPerMillion: 3.48 },
};

/** Conservative default for unknown models */
const DEFAULT_RATES = { inputPerMillion: 5, outputPerMillion: 15 };

/**
 * Calculate cost in Light from usage data.
 * Prefers OpenRouter's reported total_cost (USD) if available.
 * Falls back to static per-model rate table.
 * Applies the platform markup (CHAT_PLATFORM_MARKUP) for credits-billed routes.
 */
export function calculateCostLight(
  usage: ChatUsage,
  model: string,
  openRouterTotalCostUsd?: number,
  options: ChatBillingCostOptions = {},
): number {
  let baseCostLight: number;

  if (options.billingSource === "platform_deepseek_direct") {
    const platformModel = resolvePlatformInferenceModel(model);
    if (!platformModel) {
      throw new Error(
        `Unsupported Galactic platform model for direct billing: ${model}`,
      );
    }
    return calculatePlatformInferenceCost(
      platformModel.id,
      {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        promptCacheHitTokens: usage.prompt_cache_hit_tokens,
        promptCacheMissTokens: usage.prompt_cache_miss_tokens,
      },
      {
        now: options.now,
        lightPerDollar: options.lightPerDollar,
      },
    ).totalLight;
  }

  if (openRouterTotalCostUsd !== undefined && openRouterTotalCostUsd > 0) {
    // OpenRouter reports cost in USD; convert to Light
    baseCostLight = openRouterTotalCostUsd * LIGHT_PER_DOLLAR_DESKTOP;
  } else {
    // Fallback: estimate from token counts (USD cost then convert to Light)
    const rates = MODEL_RATES[model] || DEFAULT_RATES;
    const baseCostUsd =
      (usage.prompt_tokens / 1_000_000) * rates.inputPerMillion +
      (usage.completion_tokens / 1_000_000) * rates.outputPerMillion;
    baseCostLight = baseCostUsd * LIGHT_PER_DOLLAR_DESKTOP;
  }

  // Apply platform markup
  const totalLight = baseCostLight * CHAT_PLATFORM_MARKUP;

  // Round to 4 decimal places (sub-Light precision, same as hosting billing)
  return Math.round(totalLight * 10000) / 10000;
}

// ============================================
// BALANCE DEDUCTION
// ============================================

/**
 * Deduct chat cost from user balance after stream completes.
 * Uses atomic debit_light RPC (clamps at 0, never goes negative).
 * Logs transaction to billing_transactions (fire-and-forget).
 */
export async function deductChatCost(
  userId: string,
  usage: ChatUsage,
  model: string,
  openRouterTotalCostUsd?: number,
  metadata: ChatBillingMetadata = {},
  options: ChatBillingCostOptions = {},
): Promise<ChatBillingResult> {
  const costLight = calculateCostLight(
    usage,
    model,
    openRouterTotalCostUsd,
    options,
  );

  // Skip deduction for zero-cost (e.g., empty response)
  if (costLight <= 0) {
    return { cost_light: 0, balance_after: 0, was_depleted: false };
  }

  // Atomic debit — p_update_billed_at=false to not touch hosting billing clock
  const debitRes = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/rpc/debit_light`,
    {
      method: "POST",
      headers: { ...dbHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        p_user_id: userId,
        p_amount_light: costLight,
        p_reason: "ai_chat",
        p_update_billed_at: false,
        p_allow_partial: true,
        p_idempotency_key: metadata.messageId
          ? buildEconomicIdempotencyKey("chat_debit", [
            metadata.messageId,
            metadata.conversationId,
            userId,
            model,
          ])
          : null,
        p_app_id: metadata.appId ?? null,
        p_function_name: metadata.functionName ?? null,
        p_metadata: {
          trace_id: metadata.traceId,
          conversation_id: metadata.conversationId,
          message_id: metadata.messageId,
          source: metadata.source,
          model,
          billing_source: options.billingSource ?? null,
          prompt_tokens: usage.prompt_tokens,
          prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens ?? null,
          prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? null,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        },
      }),
    },
  );

  if (!debitRes.ok) {
    const err = await debitRes.text();
    console.error(`[CHAT-BILLING] Debit failed for ${userId}: ${err}`);
    throw new Error("Balance deduction failed");
  }

  const debitResult = await debitRes.json() as Array<{
    old_balance: number;
    new_balance: number;
    was_depleted: boolean;
    amount_debited?: number;
  }>;

  if (!debitResult || debitResult.length === 0) {
    console.error(`[CHAT-BILLING] Debit RPC returned empty for ${userId}`);
    throw new Error("Debit RPC returned empty");
  }

  const { new_balance, was_depleted, amount_debited } = debitResult[0];
  const actualCostLight = typeof amount_debited === "number"
    ? amount_debited
    : costLight;

  // Log transaction (fire-and-forget — never break billing for logging)
  logChatTransaction(
    userId,
    actualCostLight,
    new_balance,
    usage,
    model,
    metadata,
    options,
  ).catch(() => {});

  return {
    cost_light: actualCostLight,
    balance_after: new_balance,
    was_depleted,
  };
}

// ============================================
// TRANSACTION LOGGING
// ============================================

/** Fire-and-forget billing transaction log. Matches hosting-billing.ts pattern. */
async function logChatTransaction(
  userId: string,
  costLight: number,
  balanceAfterLight: number,
  usage: ChatUsage,
  model: string,
  metadata: ChatBillingMetadata = {},
  options: ChatBillingCostOptions = {},
): Promise<void> {
  await fetch(`${getEnv("SUPABASE_URL")}/rest/v1/billing_transactions`, {
    method: "POST",
    headers: dbWriteHeaders(),
    body: JSON.stringify({
      user_id: userId,
      app_id: metadata.appId ?? null,
      type: "charge",
      category: "chat_inference",
      description:
        `Chat: ${model} (${usage.prompt_tokens}+${usage.completion_tokens} tokens, ${
          formatLight(costLight)
        })`,
      amount_light: -costLight, // negative = charge (same convention as hosting)
      balance_after_light: balanceAfterLight,
      metadata: {
        model,
        prompt_tokens: usage.prompt_tokens,
        prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens ?? null,
        prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? null,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        cost_light: costLight,
        billing_source: options.billingSource ?? null,
        function_name: metadata.functionName ?? null,
        markup: CHAT_PLATFORM_MARKUP,
        trace_id: metadata.traceId || null,
        conversation_id: metadata.conversationId || null,
        message_id: metadata.messageId || null,
        source: metadata.source || null,
        ...metadata,
      },
    }),
  });
}

// ============================================
// EXPORTS (for testing)
// ============================================

export { CHAT_MIN_BALANCE_LIGHT };
