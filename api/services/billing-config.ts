import {
  COMBINED_FREE_TIER_BYTES,
  DATA_RATE_LIGHT_PER_MB_PER_HOUR,
  HOSTING_RATE_LIGHT_PER_MB_PER_HOUR,
  LIGHT_PER_DOLLAR_CANONICAL,
  LIGHT_PER_DOLLAR_PAYOUT,
  LIGHT_PER_DOLLAR_WALLET,
  LIGHT_PER_DOLLAR_WIRE,
  LIGHT_SYMBOL,
  MIN_PUBLISH_DEPOSIT_LIGHT,
  MIN_WITHDRAWAL_LIGHT,
  PLATFORM_FEE_RATE,
  formatLight,
} from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";

export interface BillingConfig {
  id: string;
  version: number;
  canonicalLightPerUsd: number;
  walletLightPerUsd: number;
  wireLightPerUsd: number;
  payoutLightPerUsd: number;
  platformFeeRate: number;
  minWithdrawalLight: number;
  payoutPolicyCopy: string;
  updatedAt: string | null;
}

interface BillingConfigRow {
  id?: string | null;
  version?: number | null;
  canonical_light_per_usd?: number | null;
  wallet_light_per_usd?: number | null;
  wire_light_per_usd?: number | null;
  payout_light_per_usd?: number | null;
  platform_fee_rate?: number | null;
  min_withdrawal_light?: number | null;
  payout_policy_copy?: string | null;
  updated_at?: string | null;
}

export const DEFAULT_PAYOUT_POLICY_COPY =
  "Payouts are processed on the first business day of each month. Requests must be submitted at least 21 days before that payout date to be included. Purchased Light cannot be cashed out; only creator earnings are eligible for payout.";

export const LIGHT_ECONOMY_POLICY_COPY = {
  purchasedLight:
    "Purchased Light is spend-only platform credit. It cannot be cashed out, redeemed for money, or transferred directly between arbitrary accounts.",
  creatorEarnings:
    "Creator earnings come from platform-mediated app activity and marketplace sales. Earned Light can be spent in Ultralight or requested for payout through Stripe Connect.",
  fundingTerms:
    "By adding Light, you agree that purchased Light is spend-only platform credit and that authenticated funding transactions are governed by the Terms.",
  payoutTerms:
    "By requesting a payout, you confirm that the amount is creator earnings and that payout timing, fees, and eligibility are governed by the Terms.",
  termsUrl: "/terms",
} as const;

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  id: "singleton",
  version: 1,
  canonicalLightPerUsd: LIGHT_PER_DOLLAR_CANONICAL,
  walletLightPerUsd: LIGHT_PER_DOLLAR_WALLET,
  wireLightPerUsd: LIGHT_PER_DOLLAR_WIRE,
  payoutLightPerUsd: LIGHT_PER_DOLLAR_PAYOUT,
  platformFeeRate: PLATFORM_FEE_RATE,
  minWithdrawalLight: MIN_WITHDRAWAL_LIGHT,
  payoutPolicyCopy: DEFAULT_PAYOUT_POLICY_COPY,
  updatedAt: null,
};

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

export function normalizeBillingConfigRow(
  row?: BillingConfigRow | null,
): BillingConfig {
  if (!row) return DEFAULT_BILLING_CONFIG;
  return {
    id: row.id || DEFAULT_BILLING_CONFIG.id,
    version: Number.isInteger(row.version) && Number(row.version) > 0
      ? Number(row.version)
      : DEFAULT_BILLING_CONFIG.version,
    canonicalLightPerUsd: finitePositive(
      row.canonical_light_per_usd,
      DEFAULT_BILLING_CONFIG.canonicalLightPerUsd,
    ),
    walletLightPerUsd: finitePositive(
      row.wallet_light_per_usd,
      DEFAULT_BILLING_CONFIG.walletLightPerUsd,
    ),
    wireLightPerUsd: finitePositive(
      row.wire_light_per_usd,
      DEFAULT_BILLING_CONFIG.wireLightPerUsd,
    ),
    payoutLightPerUsd: finitePositive(
      row.payout_light_per_usd,
      DEFAULT_BILLING_CONFIG.payoutLightPerUsd,
    ),
    platformFeeRate: finiteNonNegative(
      row.platform_fee_rate,
      DEFAULT_BILLING_CONFIG.platformFeeRate,
    ),
    minWithdrawalLight: finitePositive(
      row.min_withdrawal_light,
      DEFAULT_BILLING_CONFIG.minWithdrawalLight,
    ),
    payoutPolicyCopy: row.payout_policy_copy ||
      DEFAULT_BILLING_CONFIG.payoutPolicyCopy,
    updatedAt: row.updated_at || null,
  };
}

export function usdCentsToLight(
  amountCents: number,
  lightPerUsd: number,
): number {
  return Math.round((amountCents / 100) * lightPerUsd);
}

export function lightToUsdCents(
  amountLight: number,
  lightPerUsd: number,
): number {
  return Math.round((amountLight / lightPerUsd) * 100);
}

export function formatLightPerUsd(rate: number): string {
  return `${rate.toLocaleString("en-US")} Light / $1`;
}

function formatLightRate(rate: number): string {
  return `${LIGHT_SYMBOL}${rate.toLocaleString("en-US", {
    maximumFractionDigits: 6,
  })}`;
}

export function toPublicBillingConfig(config: BillingConfig) {
  return {
    version: config.version,
    canonical_light_per_usd: config.canonicalLightPerUsd,
    wallet_light_per_usd: config.walletLightPerUsd,
    wire_light_per_usd: config.wireLightPerUsd,
    payout_light_per_usd: config.payoutLightPerUsd,
    platform_fee_rate: config.platformFeeRate,
    min_withdrawal_light: config.minWithdrawalLight,
    min_publish_deposit_light: MIN_PUBLISH_DEPOSIT_LIGHT,
    hosting_rate_light_per_mb_hour: HOSTING_RATE_LIGHT_PER_MB_PER_HOUR,
    data_rate_light_per_mb_hour: DATA_RATE_LIGHT_PER_MB_PER_HOUR,
    storage_soft_cap_bytes: COMBINED_FREE_TIER_BYTES,
    payout_policy_copy: config.payoutPolicyCopy,
    labels: {
      canonical_rate: formatLightPerUsd(config.canonicalLightPerUsd),
      wallet_rate: formatLightPerUsd(config.walletLightPerUsd),
      wire_rate: formatLightPerUsd(config.wireLightPerUsd),
      payout_rate: `${
        config.payoutLightPerUsd.toLocaleString("en-US")
      } Light = $1`,
      publish_deposit: formatLight(MIN_PUBLISH_DEPOSIT_LIGHT),
      hosting_rate: `${formatLightRate(HOSTING_RATE_LIGHT_PER_MB_PER_HOUR)}/MB/hr`,
      data_rate: `${formatLightRate(DATA_RATE_LIGHT_PER_MB_PER_HOUR)}/MB/hr`,
    },
    policy_copy: LIGHT_ECONOMY_POLICY_COPY,
  };
}

export async function getBillingConfig(): Promise<BillingConfig> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return DEFAULT_BILLING_CONFIG;
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/platform_billing_config?id=eq.singleton&select=*&limit=1`,
      {
        headers: {
          "apikey": SUPABASE_SERVICE_ROLE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!res.ok) return DEFAULT_BILLING_CONFIG;
    const rows = await res.json() as BillingConfigRow[];
    return normalizeBillingConfigRow(rows[0]);
  } catch {
    return DEFAULT_BILLING_CONFIG;
  }
}
