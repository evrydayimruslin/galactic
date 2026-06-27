import { LIGHT_PER_DOLLAR_CANONICAL } from "../../shared/types/index.ts";
import type {
  LaunchWalletFundingFeeSummary,
  LaunchWalletFundingMethod,
  LaunchWalletFundingPreset,
} from "../../shared/contracts/launch.ts";
import { lightToUsdCents } from "./billing-config.ts";
import { RequestValidationError } from "./request-validation.ts";

export const LAUNCH_WALLET_LIGHT_PER_DOLLAR = LIGHT_PER_DOLLAR_CANONICAL;
// $1.00 floor (100 Light). Low enough to remove the old $10 gate, but safely
// above Stripe's hard $0.50 minimum once the processing fee is grossed up.
export const LAUNCH_WALLET_MIN_TOPUP_LIGHT = 100;
// No business cap on top-ups (the old $5,000 limit is removed). The only bound
// is Stripe's hard per-charge maximum for USD ($999,999.99); we cap the base so
// the grossed-up total can never exceed it (which would fail at confirm).
// 97,000,000 Light = $970,000 base → grossed-up total stays under $999,999.99.
export const LAUNCH_WALLET_MAX_TOPUP_LIGHT = 97_000_000;
export const LAUNCH_WALLET_FUNDING_PRESETS: LaunchWalletFundingPreset[] = [
  { light: 1_000, label: "1,000 credits" },
  { light: 2_500, label: "2,500 credits", recommended: true },
  { light: 5_000, label: "5,000 credits" },
  { light: 10_000, label: "10,000 credits" },
];

const CARD_FEE_BPS = 290;
const CARD_FIXED_FEE_CENTS = 30;
const ACH_FEE_BPS = 80;
const ACH_FEE_CAP_CENTS = 500;

export function normalizeLaunchFundingMethod(
  value: unknown,
): LaunchWalletFundingMethod {
  if (value === "card" || value === "ach") return value;
  throw new RequestValidationError("method must be card or ach");
}

export function normalizeLaunchFundingAmountLight(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    throw new RequestValidationError("amount_credits must be an integer");
  }
  if (value < LAUNCH_WALLET_MIN_TOPUP_LIGHT) {
    throw new RequestValidationError(
      `amount_credits must be at least ${LAUNCH_WALLET_MIN_TOPUP_LIGHT}`,
    );
  }
  if (value > LAUNCH_WALLET_MAX_TOPUP_LIGHT) {
    throw new RequestValidationError(
      `amount_credits must be ${LAUNCH_WALLET_MAX_TOPUP_LIGHT} or less`,
    );
  }
  return value;
}

export function quoteLaunchWalletFunding(input: {
  amountLight: number;
  method: LaunchWalletFundingMethod;
}): LaunchWalletFundingFeeSummary {
  const amountLight = normalizeLaunchFundingAmountLight(input.amountLight);
  const method = normalizeLaunchFundingMethod(input.method);
  const baseAmountCents = lightToUsdCents(
    amountLight,
    LAUNCH_WALLET_LIGHT_PER_DOLLAR,
  );
  const totalAmountCents = grossedUpTotalCents(baseAmountCents, method);
  const processingFeeCents = totalAmountCents - baseAmountCents;
  return {
    method,
    methodLabel: method === "card" ? "Card" : "Bank (ACH)",
    amountCredits: amountLight,
    creditsPerDollar: LAUNCH_WALLET_LIGHT_PER_DOLLAR,
    // Deprecated aliases kept for one rename window.
    amountLight,
    lightPerDollar: LAUNCH_WALLET_LIGHT_PER_DOLLAR,
    baseAmountCents,
    processingFeeCents,
    totalAmountCents,
    feeFormula: method === "card" ? "2.9% + $0.30" : "0.8% capped at $5.00",
  };
}

export function stripeProcessingFeeCents(
  totalAmountCents: number,
  method: LaunchWalletFundingMethod,
): number {
  if (!Number.isInteger(totalAmountCents) || totalAmountCents <= 0) {
    throw new RequestValidationError("total_amount_cents must be positive");
  }
  if (method === "card") {
    return Math.ceil((totalAmountCents * CARD_FEE_BPS) / 10_000) +
      CARD_FIXED_FEE_CENTS;
  }
  return Math.min(
    Math.ceil((totalAmountCents * ACH_FEE_BPS) / 10_000),
    ACH_FEE_CAP_CENTS,
  );
}

function grossedUpTotalCents(
  baseAmountCents: number,
  method: LaunchWalletFundingMethod,
): number {
  if (!Number.isInteger(baseAmountCents) || baseAmountCents <= 0) {
    throw new RequestValidationError("base_amount_cents must be positive");
  }

  let totalAmountCents = method === "card"
    ? Math.ceil((baseAmountCents + CARD_FIXED_FEE_CENTS) / 0.971)
    : baseAmountCents;

  while (
    totalAmountCents -
        stripeProcessingFeeCents(totalAmountCents, method) <
      baseAmountCents
  ) {
    totalAmountCents += 1;
  }

  return totalAmountCents;
}
