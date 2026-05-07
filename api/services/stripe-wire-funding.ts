import { formatLight } from "../../shared/types/index.ts";
import { getEnv } from "../lib/env.ts";
import {
  type BillingConfig,
  getBillingConfig,
  usdCentsToLight,
} from "./billing-config.ts";
import { recordPendingLightDeposit } from "./stripe-deposits.ts";

export const WIRE_TRANSFER_FUNDING_METHOD = "wire_transfer";
export const WIRE_TRANSFER_DEPOSIT_TYPE = "wire_deposit";
export const WIRE_TRANSFER_BANK_TRANSFER_TYPE = "us_bank_transfer";

export class WireFundingError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
  ) {
    super(message);
    this.name = "WireFundingError";
  }
}

export interface WireTransferPaymentIntentParams {
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

export interface StripeFinancialAddress {
  type?: string;
  supported_networks?: string[];
  aba?: {
    account_number?: string;
    routing_number?: string;
    bank_name?: string;
  };
  swift?: {
    account_number?: string;
    swift_code?: string;
    bank_name?: string;
  };
}

export interface WireTransferInstructions {
  type: string;
  reference: string | null;
  amountRemainingCents: number;
  currency: string;
  hostedInstructionsUrl: string | null;
  financialAddresses: StripeFinancialAddress[];
}

export interface WireTransferPaymentIntentResult {
  paymentIntentId: string;
  stripeCustomerId: string;
  amountCents: number;
  lightAmount: number;
  lightPerUsd: number;
  billingConfigVersion: number;
  status: string;
  instructions: WireTransferInstructions | null;
  billingAddressId?: string;
  billingAddressVersion?: number;
}

interface StripePaymentIntentResponse {
  id: string;
  customer?: string | { id?: string } | null;
  status?: string;
  next_action?: {
    type?: string;
    display_bank_transfer_instructions?: {
      type?: string;
      reference?: string | null;
      amount_remaining?: number | null;
      currency?: string | null;
      hosted_instructions_url?: string | null;
      financial_addresses?: StripeFinancialAddress[] | null;
    };
  } | null;
}

function stripeObjectId(
  value: string | { id?: string } | null | undefined,
): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.id;
}

export function buildWireTransferPaymentIntentParams(
  input: WireTransferPaymentIntentParams,
): URLSearchParams {
  const lightPerUsd = input.billingConfig.wireLightPerUsd;
  const lightAmount = usdCentsToLight(input.amountCents, lightPerUsd);
  const params = new URLSearchParams({
    amount: String(input.amountCents),
    currency: "usd",
    customer: input.stripeCustomerId,
    "payment_method_types[0]": "customer_balance",
    "payment_method_data[type]": "customer_balance",
    "payment_method_options[customer_balance][funding_type]": "bank_transfer",
    "payment_method_options[customer_balance][bank_transfer][type]":
      WIRE_TRANSFER_BANK_TRANSFER_TYPE,
    confirm: "true",
    description: `Ultralight wire funding (${formatLight(lightAmount)})`,
    "metadata[user_id]": input.userId,
    "metadata[amount_cents]": String(input.amountCents),
    "metadata[light_amount]": String(lightAmount),
    "metadata[light_per_usd]": String(lightPerUsd),
    "metadata[billing_config_version]": String(input.billingConfig.version),
    "metadata[funding_method]": WIRE_TRANSFER_FUNDING_METHOD,
    "metadata[source]": input.source,
    "metadata[terms_accepted]": input.termsAccepted ? "true" : "false",
    "metadata[type]": WIRE_TRANSFER_DEPOSIT_TYPE,
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

function extractWireTransferInstructions(
  intent: StripePaymentIntentResponse,
): WireTransferInstructions | null {
  const instructions = intent.next_action?.display_bank_transfer_instructions;
  if (!instructions) return null;
  const amountRemaining = instructions.amount_remaining;
  return {
    type: instructions.type || WIRE_TRANSFER_BANK_TRANSFER_TYPE,
    reference: instructions.reference || null,
    amountRemainingCents:
      typeof amountRemaining === "number" && Number.isFinite(amountRemaining)
        ? amountRemaining
        : 0,
    currency: (instructions.currency || "usd").toUpperCase(),
    hostedInstructionsUrl: instructions.hosted_instructions_url || null,
    financialAddresses: Array.isArray(instructions.financial_addresses)
      ? instructions.financial_addresses
      : [],
  };
}

export async function createWireTransferPaymentIntent(input: {
  userId: string;
  stripeCustomerId: string;
  email?: string | null;
  amountCents: number;
  source: "web" | "desktop";
  termsAccepted: true;
  billingAddressId?: string;
  billingAddressVersion?: number;
}): Promise<WireTransferPaymentIntentResult> {
  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) {
    throw new WireFundingError(
      "Stripe wire funding is not configured yet.",
      503,
    );
  }

  const billingConfig = await getBillingConfig();
  const lightPerUsd = billingConfig.wireLightPerUsd;
  const lightAmount = usdCentsToLight(input.amountCents, lightPerUsd);
  const params = buildWireTransferPaymentIntentParams({
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
      "[STRIPE] Wire PaymentIntent creation failed:",
      await intentRes.text(),
    );
    throw new WireFundingError(
      "Failed to create wire transfer instructions",
      500,
    );
  }

  const intent = await intentRes.json() as StripePaymentIntentResponse;
  const instructions = extractWireTransferInstructions(intent);
  const stripeCustomerId = stripeObjectId(intent.customer) ||
    input.stripeCustomerId;

  await recordPendingLightDeposit({
    userId: input.userId,
    requestedAmountCents: input.amountCents,
    requestedLight: lightAmount,
    fundingMethod: WIRE_TRANSFER_FUNDING_METHOD,
    stripePaymentIntentId: intent.id,
    stripeCustomerId,
    billingConfigVersion: billingConfig.version,
    lightPerUsd,
    metadata: {
      source: input.source,
      stripe_payment_intent_created: true,
      stripe_payment_intent_status: intent.status || null,
      bank_transfer_type: WIRE_TRANSFER_BANK_TRANSFER_TYPE,
      wire_reference: instructions?.reference || null,
      amount_remaining_cents: instructions?.amountRemainingCents || null,
      hosted_instructions_url: instructions?.hostedInstructionsUrl || null,
      terms_accepted: input.termsAccepted,
      buyer_billing_address_id: input.billingAddressId || null,
      buyer_billing_address_version: input.billingAddressVersion || null,
    },
  });

  return {
    paymentIntentId: intent.id,
    stripeCustomerId,
    amountCents: input.amountCents,
    lightAmount,
    lightPerUsd,
    billingConfigVersion: billingConfig.version,
    status: intent.status || "unknown",
    instructions,
    billingAddressId: input.billingAddressId,
    billingAddressVersion: input.billingAddressVersion,
  };
}
