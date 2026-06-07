import { formatLight } from "../../shared/types/index.ts";
import type {
  LaunchWalletFundingFeeSummary,
  LaunchWalletFundingMethod,
} from "../../shared/contracts/launch.ts";
import { getEnv } from "../lib/env.ts";
import { getBillingConfig } from "./billing-config.ts";
import { quoteLaunchWalletFunding } from "./stripe-processing-fees.ts";
import { recordPendingLightDeposit } from "./stripe-deposits.ts";

export const LAUNCH_CARD_FUNDING_METHOD = "launch_card_gross_up";
export const LAUNCH_ACH_FUNDING_METHOD = "launch_ach_direct_debit";
export const LAUNCH_WALLET_DEPOSIT_TYPE = "wallet_topup";

export class LaunchWalletFundingError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
  ) {
    super(message);
    this.name = "LaunchWalletFundingError";
  }
}

export interface LaunchWalletPaymentIntentParams {
  userId: string;
  stripeCustomerId: string;
  email?: string | null;
  quote: LaunchWalletFundingFeeSummary;
  billingConfigVersion: number;
  billingAddressId?: string;
  billingAddressVersion?: number;
  termsAccepted: true;
}

export interface LaunchWalletPaymentIntentResult {
  publishableKey: string;
  clientSecret: string;
  paymentIntentId: string;
  stripeCustomerId: string;
  quote: LaunchWalletFundingFeeSummary;
  billingConfigVersion: number;
  billingAddressId?: string;
  billingAddressVersion?: number;
}

interface StripePaymentIntentResponse {
  id: string;
  client_secret?: string | null;
  customer?: string | { id?: string } | null;
  status?: string;
}

function stripeObjectId(
  value: string | { id?: string } | null | undefined,
): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.id;
}

function fundingMethod(method: LaunchWalletFundingMethod): string {
  return method === "card"
    ? LAUNCH_CARD_FUNDING_METHOD
    : LAUNCH_ACH_FUNDING_METHOD;
}

export function buildLaunchWalletPaymentIntentParams(
  input: LaunchWalletPaymentIntentParams,
): URLSearchParams {
  const params = new URLSearchParams({
    amount: String(input.quote.totalAmountCents),
    currency: "usd",
    customer: input.stripeCustomerId,
    description: `Ultralight Light funding (${
      formatLight(input.quote.amountLight)
    })`,
    "metadata[user_id]": input.userId,
    "metadata[amount_cents]": String(input.quote.totalAmountCents),
    "metadata[base_amount_cents]": String(input.quote.baseAmountCents),
    "metadata[processing_fee_cents]": String(input.quote.processingFeeCents),
    "metadata[light_amount]": String(input.quote.amountLight),
    "metadata[light_per_usd]": String(input.quote.lightPerDollar),
    "metadata[billing_config_version]": String(input.billingConfigVersion),
    "metadata[funding_method]": fundingMethod(input.quote.method),
    "metadata[payment_method]": input.quote.method,
    "metadata[payment_method_label]": input.quote.methodLabel,
    "metadata[fee_formula]": input.quote.feeFormula,
    "metadata[gross_up]": "true",
    "metadata[source]": "launch_web",
    "metadata[terms_accepted]": input.termsAccepted ? "true" : "false",
    "metadata[type]": LAUNCH_WALLET_DEPOSIT_TYPE,
  });

  if (input.quote.method === "card") {
    params.set("payment_method_types[0]", "card");
    params.set(
      "payment_method_options[card][request_three_d_secure]",
      "automatic",
    );
  } else {
    params.set("payment_method_types[0]", "us_bank_account");
    params.set(
      "payment_method_options[us_bank_account][verification_method]",
      "automatic",
    );
  }

  if (input.billingAddressId) {
    params.set("metadata[buyer_billing_address_id]", input.billingAddressId);
  }
  if (input.billingAddressVersion) {
    params.set(
      "metadata[buyer_billing_address_version]",
      String(input.billingAddressVersion),
    );
  }
  if (input.email) {
    params.set("receipt_email", input.email);
  }
  return params;
}

export async function createLaunchWalletPaymentIntent(input: {
  userId: string;
  stripeCustomerId: string;
  email?: string | null;
  amountLight: number;
  method: LaunchWalletFundingMethod;
  termsAccepted: true;
  billingAddressId?: string;
  billingAddressVersion?: number;
}): Promise<LaunchWalletPaymentIntentResult> {
  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
  const publishableKey = getEnv("STRIPE_PUBLISHABLE_KEY") as string | undefined;

  if (!stripeSecretKey || !publishableKey) {
    throw new LaunchWalletFundingError(
      "Stripe wallet funding is not configured yet.",
      503,
    );
  }

  const billingConfig = await getBillingConfig();
  const quote = quoteLaunchWalletFunding({
    amountLight: input.amountLight,
    method: input.method,
  });
  const params = buildLaunchWalletPaymentIntentParams({
    ...input,
    quote,
    billingConfigVersion: billingConfig.version,
  });

  const intentRes = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!intentRes.ok) {
    console.error(
      "[STRIPE] Launch wallet PaymentIntent creation failed:",
      await intentRes.text(),
    );
    throw new LaunchWalletFundingError(
      "Failed to create wallet payment intent",
      500,
    );
  }

  const intent = await intentRes.json() as StripePaymentIntentResponse;
  if (!intent.client_secret) {
    throw new LaunchWalletFundingError(
      "Stripe did not return a client secret",
      500,
    );
  }

  const stripeCustomerId = stripeObjectId(intent.customer) ||
    input.stripeCustomerId;

  await recordPendingLightDeposit({
    userId: input.userId,
    requestedAmountCents: quote.totalAmountCents,
    requestedLight: quote.amountLight,
    fundingMethod: fundingMethod(quote.method),
    stripePaymentIntentId: intent.id,
    stripeCustomerId,
    billingConfigVersion: billingConfig.version,
    lightPerUsd: quote.lightPerDollar,
    metadata: {
      source: "launch_web",
      stripe_payment_intent_created: true,
      stripe_payment_intent_status: intent.status || null,
      payment_method: quote.method,
      payment_method_label: quote.methodLabel,
      base_amount_cents: quote.baseAmountCents,
      processing_fee_cents: quote.processingFeeCents,
      total_amount_cents: quote.totalAmountCents,
      fee_formula: quote.feeFormula,
      gross_up: true,
      terms_accepted: input.termsAccepted,
      buyer_billing_address_id: input.billingAddressId || null,
      buyer_billing_address_version: input.billingAddressVersion || null,
    },
  });

  return {
    publishableKey,
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    stripeCustomerId,
    quote,
    billingConfigVersion: billingConfig.version,
    billingAddressId: input.billingAddressId,
    billingAddressVersion: input.billingAddressVersion,
  };
}
