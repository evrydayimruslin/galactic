// Tier Enforcement Service
// Shared utility for checking tier-based restrictions.
// Enforces visibility checks, legacy publish balance gating, and app-count guardrails.

import {
  formatLight,
  type Tier,
  TIER_LIMITS,
} from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";
import { getBillingConfig } from "./billing-config.ts";

type Visibility = "private" | "unlisted" | "public";

export interface PublishReadinessOptions {
  /** Target visibility of the publish action. Only "public" requires Connect. */
  visibility?: Visibility | "published";
  /** apps.connect_gate_exempt — agents that were already public when the gate
   *  shipped are grandfathered and skip the Connect-payouts requirement. New
   *  public agents default to non-exempt and must connect. */
  appConnectGateExempt?: boolean;
}

export type PublishReadinessBlockReason =
  | "billing_check_unavailable"
  | "insufficient_publish_balance"
  | "connect_payouts_required";

export interface PublishReadinessBlock {
  reason: PublishReadinessBlockReason;
  message: string;
  requiredLight: number;
  currentBalanceLight: number;
  nextAction: string;
  status: number;
}

export interface PublishReadinessResult {
  allowed: boolean;
  requiredLight: number;
  currentBalanceLight: number;
  nextAction: string | null;
  block?: PublishReadinessBlock;
}

export interface PublishReadinessErrorPayload {
  error: string;
  reason: PublishReadinessBlockReason;
  required_light: number;
  current_balance_light: number;
  next_action: string;
}

export class PublishReadinessError extends Error {
  status: number;
  reason: PublishReadinessBlockReason;
  requiredLight: number;
  currentBalanceLight: number;
  nextAction: string;
  details: PublishReadinessErrorPayload;

  constructor(block: PublishReadinessBlock) {
    super(block.message);
    this.name = "PublishReadinessError";
    this.status = block.status;
    this.reason = block.reason;
    this.requiredLight = block.requiredLight;
    this.currentBalanceLight = block.currentBalanceLight;
    this.nextAction = block.nextAction;
    this.details = publishReadinessErrorPayload(block);
  }
}

export function publishReadinessErrorPayload(
  block: PublishReadinessBlock,
): PublishReadinessErrorPayload {
  return {
    error: block.message,
    reason: block.reason,
    required_light: block.requiredLight,
    current_balance_light: block.currentBalanceLight,
    next_action: block.nextAction,
  };
}

export function isPublishReadinessError(
  err: unknown,
): err is PublishReadinessError {
  return err instanceof PublishReadinessError ||
    (
      typeof err === "object" &&
      err !== null &&
      (err as { name?: string }).name === "PublishReadinessError" &&
      "details" in err
    );
}

/**
 * Check whether a visibility value is allowed for the given tier.
 * All visibilities are allowed for all tiers.
 * Returns null (always allowed).
 */
export function checkVisibilityAllowed(
  _tier: Tier,
  _visibility: Visibility,
): string | null {
  return null;
}

/**
 * Publish readiness gate.
 * When enabled in billing config, any non-private listing requires a
 * configurable minimum spendable Light balance (covers infra/compute), and
 * publishing PUBLICLY additionally requires Stripe Connect payouts to be set
 * up (so the seller can receive earnings). Unlisted needs only the balance.
 * Pre-gate public agents are grandfathered via appConnectGateExempt.
 */
export async function checkPublisherPublishReadiness(
  userId: string,
  options: PublishReadinessOptions = {},
): Promise<PublishReadinessResult> {
  const billingConfig = await getBillingConfig();
  const requiredLight = billingConfig.publisherMinPublishBalanceLight;
  if (!billingConfig.publishDepositEnabled) {
    return {
      allowed: true,
      requiredLight,
      currentBalanceLight: 0,
      nextAction: null,
    };
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error("[TIER] Supabase not configured for publish gate");
    const nextAction = "Try publishing again shortly.";
    const block: PublishReadinessBlock = {
      reason: "billing_check_unavailable",
      message:
        "Publishing is temporarily unavailable while billing checks recover. Please try again shortly.",
      requiredLight,
      currentBalanceLight: 0,
      nextAction,
      status: 503,
    };
    return {
      allowed: false,
      requiredLight,
      currentBalanceLight: 0,
      nextAction,
      block,
    };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${
        encodeURIComponent(userId)
      }&select=balance_light,stripe_connect_payouts_enabled`,
      {
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
        },
      },
    );

    if (!response.ok) {
      console.error(
        "[TIER] checkPublishDeposit: fetch failed:",
        await response.text(),
      );
      const nextAction = "Try publishing again shortly.";
      const block: PublishReadinessBlock = {
        reason: "billing_check_unavailable",
        message:
          "Publishing is temporarily unavailable while billing checks recover. Please try again shortly.",
        requiredLight,
        currentBalanceLight: 0,
        nextAction,
        status: 503,
      };
      return {
        allowed: false,
        requiredLight,
        currentBalanceLight: 0,
        nextAction,
        block,
      };
    }

    const rows = await response.json() as Array<
      {
        balance_light: number | null;
        stripe_connect_payouts_enabled: boolean | null;
      }
    >;
    const balance = rows[0]?.balance_light ?? 0;

    if (balance < requiredLight) {
      const nextAction = "Add credits from Wallet to go live.";
      const block: PublishReadinessBlock = {
        reason: "insufficient_publish_balance",
        message: `Publishing requires at least ${
          formatLight(requiredLight)
        } spendable credits before a non-private tool can go live. Current balance: ${
          formatLight(balance)
        }. ${nextAction}`,
        requiredLight,
        currentBalanceLight: balance,
        nextAction,
        status: 402,
      };
      return {
        allowed: false,
        requiredLight,
        currentBalanceLight: balance,
        nextAction,
        block,
      };
    }

    // Public listings require Stripe Connect payouts to be set up (so the
    // seller can actually receive earnings). Unlisted needs only the balance
    // minimum above. Pre-gate public agents are grandfathered so the new
    // requirement never retro-unpublishes an existing public agent.
    const effectiveVisibility = options.visibility === "published"
      ? "public"
      : options.visibility;
    const grandfathered = options.appConnectGateExempt === true;
    if (effectiveVisibility === "public" && !grandfathered) {
      const payoutsEnabled = rows[0]?.stripe_connect_payouts_enabled === true;
      if (!payoutsEnabled) {
        const nextAction =
          "Set up Stripe Connect payouts from Earnings to publish publicly.";
        const block: PublishReadinessBlock = {
          reason: "connect_payouts_required",
          message:
            `Publishing publicly requires Stripe Connect payouts so you can receive earnings. ${nextAction}`,
          requiredLight,
          currentBalanceLight: balance,
          nextAction,
          status: 402,
        };
        return {
          allowed: false,
          requiredLight,
          currentBalanceLight: balance,
          nextAction,
          block,
        };
      }
    }

    return {
      allowed: true,
      requiredLight,
      currentBalanceLight: balance,
      nextAction: null,
    };
  } catch (err) {
    console.error("[TIER] checkPublishDeposit error:", err);
    const nextAction = "Try publishing again shortly.";
    const block: PublishReadinessBlock = {
      reason: "billing_check_unavailable",
      message:
        "Publishing is temporarily unavailable while billing checks recover. Please try again shortly.",
      requiredLight,
      currentBalanceLight: 0,
      nextAction,
      status: 503,
    };
    return {
      allowed: false,
      requiredLight,
      currentBalanceLight: 0,
      nextAction,
      block,
    };
  }
}

export async function assertPublisherPublishReadiness(
  userId: string,
  options: PublishReadinessOptions = {},
): Promise<PublishReadinessResult> {
  const readiness = await checkPublisherPublishReadiness(userId, options);
  if (!readiness.allowed && readiness.block) {
    throw new PublishReadinessError(readiness.block);
  }
  return readiness;
}

/**
 * Backward-compatible string wrapper for older publish-gate callers.
 */
export async function checkPublishDeposit(
  userId: string,
  options: PublishReadinessOptions = {},
): Promise<string | null> {
  const readiness = await checkPublisherPublishReadiness(userId, options);
  return readiness.allowed ? null : readiness.block?.message ?? null;
}

/**
 * Check whether a user has room to create another app.
 * Returns null if allowed, or an error message string if at the limit.
 * Uses a lightweight HEAD-style count query (select=count).
 */
export async function checkAppLimit(
  userId: string,
): Promise<string | null> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) return null; // fail open

  const maxApps = TIER_LIMITS.free.max_apps;
  if (!isFinite(maxApps)) return null; // no limit configured

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/apps?owner_id=eq.${userId}&deleted_at=is.null&select=id`,
      {
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Prefer": "count=exact",
          "Range-Unit": "items",
          "Range": "0-0", // don't fetch rows, just count
        },
      },
    );

    // Extract count from content-range header: "0-0/42"
    const contentRange = response.headers.get("content-range") || "";
    const match = contentRange.match(/\/(\d+)/);
    const appCount = match ? parseInt(match[1], 10) : 0;

    if (appCount >= maxApps) {
      return (
        `App limit reached (${appCount}/${maxApps}). ` +
        `Delete an unused app to create a new one.`
      );
    }

    return null; // Allowed
  } catch (err) {
    console.error("[TIER] checkAppLimit error:", err);
    return null; // fail open
  }
}

/**
 * Get the user's tier from the database.
 * Lightweight helper — avoids importing the full user service.
 */
export async function getUserTier(userId: string): Promise<Tier> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=tier`,
      {
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
        },
      },
    );

    if (!response.ok) {
      console.error("getUserTier: fetch failed:", await response.text());
      return "free";
    }

    const users = await response.json() as Array<{ tier?: Tier | null }>;
    return (users[0]?.tier || "free") as Tier;
  } catch (err) {
    console.error("getUserTier: error:", err);
    return "free";
  }
}
