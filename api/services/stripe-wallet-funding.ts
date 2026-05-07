import { formatLight } from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";
import {
  type BillingConfig,
  getBillingConfig,
  usdCentsToLight,
} from "./billing-config.ts";
import { recordPendingLightDeposit } from "./stripe-deposits.ts";

export const WALLET_EXPRESS_FUNDING_METHOD = "wallet_express_checkout";
export const WALLET_EXPRESS_DEPOSIT_TYPE = "wallet_topup";

export class WalletFundingError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
  ) {
    super(message);
    this.name = "WalletFundingError";
  }
}

export interface WalletExpressPaymentIntentParams {
  userId: string;
  stripeCustomerId: string;
  email?: string | null;
  amountCents: number;
  source: "web" | "desktop";
  termsAccepted: true;
  billingConfig: BillingConfig;
  billingAddressId?: string;
  billingAddressVersion?: number;
}

export interface WalletExpressPaymentIntentResult {
  publishableKey: string;
  clientSecret: string;
  paymentIntentId: string;
  stripeCustomerId: string;
  amountCents: number;
  lightAmount: number;
  lightPerUsd: number;
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

export function buildWalletExpressPaymentIntentParams(
  input: WalletExpressPaymentIntentParams,
): URLSearchParams {
  const lightPerUsd = input.billingConfig.walletLightPerUsd;
  const lightAmount = usdCentsToLight(input.amountCents, lightPerUsd);
  const params = new URLSearchParams({
    amount: String(input.amountCents),
    currency: "usd",
    customer: input.stripeCustomerId,
    description: `Ultralight Light funding (${formatLight(lightAmount)})`,
    "payment_method_types[0]": "card",
    "payment_method_options[card][request_three_d_secure]": "automatic",
    "metadata[user_id]": input.userId,
    "metadata[amount_cents]": String(input.amountCents),
    "metadata[light_amount]": String(lightAmount),
    "metadata[light_per_usd]": String(lightPerUsd),
    "metadata[billing_config_version]": String(input.billingConfig.version),
    "metadata[funding_method]": WALLET_EXPRESS_FUNDING_METHOD,
    "metadata[source]": input.source,
    "metadata[terms_accepted]": input.termsAccepted ? "true" : "false",
    "metadata[type]": WALLET_EXPRESS_DEPOSIT_TYPE,
  });
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

export async function createWalletExpressPaymentIntent(input: {
  userId: string;
  stripeCustomerId: string;
  email?: string | null;
  amountCents: number;
  source: "web" | "desktop";
  termsAccepted: true;
  billingAddressId?: string;
  billingAddressVersion?: number;
}): Promise<WalletExpressPaymentIntentResult> {
  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
  const publishableKey = getEnv("STRIPE_PUBLISHABLE_KEY") as string | undefined;

  if (!stripeSecretKey || !publishableKey) {
    throw new WalletFundingError(
      "Stripe wallet funding is not configured yet.",
      503,
    );
  }

  const billingConfig = await getBillingConfig();
  const lightPerUsd = billingConfig.walletLightPerUsd;
  const lightAmount = usdCentsToLight(input.amountCents, lightPerUsd);
  const params = buildWalletExpressPaymentIntentParams({
    ...input,
    billingConfig,
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
      "[STRIPE] Wallet PaymentIntent creation failed:",
      await intentRes.text(),
    );
    throw new WalletFundingError("Failed to create wallet payment intent", 500);
  }

  const intent = await intentRes.json() as StripePaymentIntentResponse;
  if (!intent.client_secret) {
    throw new WalletFundingError("Stripe did not return a client secret", 500);
  }

  await recordPendingLightDeposit({
    userId: input.userId,
    requestedAmountCents: input.amountCents,
    requestedLight: lightAmount,
    fundingMethod: WALLET_EXPRESS_FUNDING_METHOD,
    stripePaymentIntentId: intent.id,
    stripeCustomerId: stripeObjectId(intent.customer) || input.stripeCustomerId,
    billingConfigVersion: billingConfig.version,
    lightPerUsd,
    metadata: {
      source: input.source,
      stripe_payment_intent_created: true,
      stripe_payment_intent_status: intent.status || null,
      express_checkout_only: true,
      terms_accepted: input.termsAccepted,
      buyer_billing_address_id: input.billingAddressId || null,
      buyer_billing_address_version: input.billingAddressVersion || null,
    },
  });

  return {
    publishableKey,
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    stripeCustomerId: stripeObjectId(intent.customer) || input.stripeCustomerId,
    amountCents: input.amountCents,
    lightAmount,
    lightPerUsd,
    billingConfigVersion: billingConfig.version,
    billingAddressId: input.billingAddressId,
    billingAddressVersion: input.billingAddressVersion,
  };
}
