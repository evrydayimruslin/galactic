import { getEnv } from "../lib/env.ts";
import { usdCentsToLight } from "./billing-config.ts";

export interface StripeWebhookEvent {
  id: string;
  type: string;
  api_version?: string;
  created?: number;
  livemode?: boolean;
  data: {
    object: StripeObject;
  };
}

interface StripeObject {
  id?: string;
  object?: string;
  customer?: string | { id?: string } | null;
  payment_intent?: string | { id?: string } | null;
  latest_charge?: string | { id?: string } | null;
  charge?: string | { id?: string } | null;
  amount?: number;
  amount_total?: number;
  amount_paid?: number;
  amount_received?: number;
  amount_refunded?: number;
  payment_status?: string;
  status?: string;
  metadata?: Record<string, string | undefined>;
  last_payment_error?: {
    code?: string;
    message?: string;
  } | null;
  failure_code?: string | null;
  failure_message?: string | null;
  refunded?: boolean;
}

interface RpcEventClaimRow {
  event_id: string;
  claimed: boolean;
  status: string;
  process_attempts: number;
}

export interface StripeEventClaim {
  eventId: string;
  claimed: boolean;
  status: string;
  processAttempts: number;
}

interface RpcDepositRow {
  deposit_id: string;
  previous_balance_light?: number;
  new_balance_light?: number;
  credited_light?: number;
  reversed_light?: number;
  recovered_light?: number;
  unrecovered_light?: number;
  status: string;
  already_finalized?: boolean;
}

export interface DepositRpcResult {
  depositId: string;
  status: string;
  previousBalanceLight?: number;
  newBalanceLight?: number;
  creditedLight?: number;
  reversedLight?: number;
  recoveredLight?: number;
  unrecoveredLight?: number;
  alreadyFinalized?: boolean;
}

export interface DepositPendingInput {
  userId: string;
  requestedAmountCents: number;
  requestedLight: number;
  fundingMethod: string;
  stripeEventId?: string;
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
  stripeChargeId?: string;
  stripeCustomerId?: string;
  billingConfigVersion: number;
  lightPerUsd: number;
  metadata?: Record<string, unknown>;
}

export interface DepositFinalizationInput extends DepositPendingInput {
  amountCents: number;
  lightAmount: number;
  stripeEventId: string;
}

export interface DepositFailureInput {
  userId?: string;
  stripeEventId: string;
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
  stripeChargeId?: string;
  stripeCustomerId?: string;
  fundingMethod: string;
  failureCode?: string;
  failureMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface DepositReversalInput {
  stripeEventId: string;
  reason: "refund" | "dispute";
  amountCents: number;
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
  stripeChargeId?: string;
  metadata?: Record<string, unknown>;
}

const DEPOSIT_TYPES = new Set([
  "auto_topup",
  "bank_transfer_deposit",
  "hosting_deposit",
  "light_deposit",
  "wallet_topup",
  "wire_deposit",
]);

function dbHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function rpcUrl(name: string): string {
  return `${getEnv("SUPABASE_URL")}/rest/v1/rpc/${name}`;
}

function readObjectId(
  value: string | { id?: string } | null | undefined,
): string | undefined {
  if (!value) return undefined;
  return typeof value === "string" ? value : value.id;
}

function readNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readInteger(value: string | undefined): number | undefined {
  const parsed = readNumber(value);
  if (parsed === undefined) return undefined;
  return Math.trunc(parsed);
}

function readMetadata(
  event: StripeWebhookEvent,
): Record<string, string | undefined> {
  return event.data.object.metadata || {};
}

function isDepositMetadata(
  metadata: Record<string, string | undefined>,
): boolean {
  const depositType = metadata.type;
  return typeof metadata.user_id === "string" && !!depositType &&
    DEPOSIT_TYPES.has(depositType);
}

function normalizeFundingMethod(
  metadata: Record<string, string | undefined>,
): string {
  return metadata.funding_method || metadata.type || "unknown";
}

function lightRate(metadata: Record<string, string | undefined>): number {
  const parsed = readNumber(metadata.light_per_usd);
  return parsed && parsed > 0 ? parsed : 100;
}

function configVersion(metadata: Record<string, string | undefined>): number {
  const parsed = readInteger(metadata.billing_config_version);
  return parsed && parsed > 0 ? parsed : 1;
}

function metadataLightAmount(
  metadata: Record<string, string | undefined>,
): number | undefined {
  const value = readNumber(metadata.light_amount || metadata.amount_light);
  return value && value > 0 ? value : undefined;
}

function metadataAmountCents(
  metadata: Record<string, string | undefined>,
): number | undefined {
  const value = readInteger(metadata.amount_cents);
  return value && value > 0 ? value : undefined;
}

function baseDepositInput(
  event: StripeWebhookEvent,
): DepositPendingInput | null {
  const object = event.data.object;
  const metadata = readMetadata(event);
  if (!isDepositMetadata(metadata)) return null;

  const userId = metadata.user_id;
  if (!userId) return null;

  const rate = lightRate(metadata);
  const requestedAmountCents = metadataAmountCents(metadata) ||
    object.amount_total ||
    object.amount ||
    object.amount_received ||
    object.amount_paid ||
    0;
  if (requestedAmountCents <= 0) return null;

  const requestedLight = metadataLightAmount(metadata) ||
    usdCentsToLight(requestedAmountCents, rate);

  return {
    userId,
    requestedAmountCents,
    requestedLight,
    fundingMethod: normalizeFundingMethod(metadata),
    stripeEventId: event.id,
    stripePaymentIntentId: readObjectId(object.payment_intent) ||
      (object.object === "payment_intent" ? object.id : undefined),
    stripeCheckoutSessionId: object.object === "checkout.session"
      ? object.id
      : undefined,
    stripeChargeId: readObjectId(object.latest_charge) ||
      readObjectId(object.charge) ||
      (object.object === "charge" ? object.id : undefined),
    stripeCustomerId: readObjectId(object.customer),
    billingConfigVersion: configVersion(metadata),
    lightPerUsd: rate,
    metadata: {
      stripe_event_type: event.type,
      stripe_object_type: object.object || null,
      stripe_object_id: object.id || null,
      deposit_type: metadata.type || null,
      source: metadata.source || null,
    },
  };
}

export function buildStripeDepositPending(
  event: StripeWebhookEvent,
): DepositPendingInput | null {
  if (
    event.type !== "payment_intent.processing" &&
    event.type !== "payment_intent.requires_action" &&
    event.type !== "payment_intent.partially_funded" &&
    event.type !== "checkout.session.completed"
  ) {
    return null;
  }

  const input = baseDepositInput(event);
  if (!input) return null;

  if (
    event.type === "checkout.session.completed" &&
    event.data.object.payment_status === "paid"
  ) {
    return null;
  }

  return input;
}

export function buildStripeDepositFinalization(
  event: StripeWebhookEvent,
): DepositFinalizationInput | null {
  const isCheckoutSuccess = event.type === "checkout.session.completed" &&
    event.data.object.payment_status === "paid";
  const isAsyncCheckoutSuccess =
    event.type === "checkout.session.async_payment_succeeded";
  const isPaymentIntentSuccess = event.type === "payment_intent.succeeded" &&
    event.data.object.status === "succeeded";

  if (
    !isCheckoutSuccess && !isAsyncCheckoutSuccess && !isPaymentIntentSuccess
  ) {
    return null;
  }

  const input = baseDepositInput(event);
  if (!input) return null;

  const object = event.data.object;
  const amountCents = object.amount_paid ||
    object.amount_received ||
    metadataAmountCents(readMetadata(event)) ||
    input.requestedAmountCents;
  if (amountCents <= 0) return null;

  const metadataLight = metadataLightAmount(readMetadata(event));
  const lightAmount =
    amountCents === input.requestedAmountCents && metadataLight
      ? metadataLight
      : usdCentsToLight(amountCents, input.lightPerUsd);

  return {
    ...input,
    stripeEventId: event.id,
    amountCents,
    lightAmount,
  };
}

export function buildStripeDepositFailure(
  event: StripeWebhookEvent,
): DepositFailureInput | null {
  if (
    event.type !== "payment_intent.payment_failed" &&
    event.type !== "payment_intent.canceled" &&
    event.type !== "checkout.session.async_payment_failed" &&
    event.type !== "checkout.session.expired"
  ) {
    return null;
  }

  const input = baseDepositInput(event);
  const object = event.data.object;
  const metadata = readMetadata(event);

  return {
    userId: input?.userId || metadata.user_id,
    stripeEventId: event.id,
    stripePaymentIntentId: input?.stripePaymentIntentId ||
      readObjectId(object.payment_intent) ||
      (object.object === "payment_intent" ? object.id : undefined),
    stripeCheckoutSessionId: input?.stripeCheckoutSessionId ||
      (object.object === "checkout.session" ? object.id : undefined),
    stripeChargeId: input?.stripeChargeId ||
      readObjectId(object.latest_charge) ||
      readObjectId(object.charge) ||
      (object.object === "charge" ? object.id : undefined),
    stripeCustomerId: input?.stripeCustomerId || readObjectId(object.customer),
    fundingMethod: input?.fundingMethod || normalizeFundingMethod(metadata),
    failureCode: object.last_payment_error?.code || object.failure_code ||
      object.status,
    failureMessage: object.last_payment_error?.message ||
      object.failure_message ||
      `Stripe event ${event.type}`,
    metadata: {
      stripe_event_type: event.type,
      stripe_object_type: object.object || null,
      stripe_object_id: object.id || null,
    },
  };
}

export function buildStripeDepositReversal(
  event: StripeWebhookEvent,
): DepositReversalInput | null {
  const object = event.data.object;
  const isRefund = event.type === "charge.refunded" ||
    event.type === "refund.created" ||
    event.type === "refund.updated";
  const isDispute = event.type === "charge.dispute.created" ||
    event.type === "charge.dispute.funds_withdrawn";

  if (!isRefund && !isDispute) return null;

  const amountCents = isRefund
    ? object.amount_refunded || object.amount || 0
    : object.amount || 0;
  if (amountCents <= 0) return null;

  return {
    stripeEventId: event.id,
    reason: isRefund ? "refund" : "dispute",
    amountCents,
    stripePaymentIntentId: readObjectId(object.payment_intent),
    stripeChargeId: readObjectId(object.charge) ||
      (object.object === "charge" ? object.id : undefined),
    metadata: {
      stripe_event_type: event.type,
      stripe_object_type: object.object || null,
      stripe_object_id: object.id || null,
      stripe_refund_status: isRefund ? object.status || null : null,
      stripe_dispute_status: isDispute ? object.status || null : null,
    },
  };
}

function normalizeClaim(row: RpcEventClaimRow): StripeEventClaim {
  return {
    eventId: row.event_id,
    claimed: !!row.claimed,
    status: row.status,
    processAttempts: row.process_attempts,
  };
}

function normalizeDepositResult(row: RpcDepositRow): DepositRpcResult {
  return {
    depositId: row.deposit_id,
    status: row.status,
    previousBalanceLight: row.previous_balance_light,
    newBalanceLight: row.new_balance_light,
    creditedLight: row.credited_light,
    reversedLight: row.reversed_light,
    recoveredLight: row.recovered_light,
    unrecoveredLight: row.unrecovered_light,
    alreadyFinalized: row.already_finalized,
  };
}

async function postRpc<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<T[]> {
  const res = await fetch(rpcUrl(name), {
    method: "POST",
    headers: dbHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${name} failed: ${text}`);
  }
  const text = await res.text();
  if (!text) return [];
  return JSON.parse(text) as T[];
}

export async function claimStripeEvent(
  event: StripeWebhookEvent,
): Promise<StripeEventClaim> {
  const object = event.data.object;
  const rows = await postRpc<RpcEventClaimRow>("claim_stripe_event", {
    p_event_id: event.id,
    p_event_type: event.type,
    p_object_id: object.id || null,
    p_object_type: object.object || null,
    p_livemode: event.livemode ?? null,
    p_api_version: event.api_version || null,
    p_stripe_created_at: event.created
      ? new Date(event.created * 1000).toISOString()
      : null,
    p_payload: event,
  });
  if (!rows[0]) throw new Error("Stripe event claim returned no rows");
  return normalizeClaim(rows[0]);
}

export async function finishStripeEvent(
  eventId: string,
  status: "processed" | "ignored" | "failed",
  metadata: Record<string, unknown> = {},
  errorMessage?: string,
): Promise<void> {
  await postRpc("finish_stripe_event", {
    p_event_id: eventId,
    p_status: status,
    p_error: errorMessage || null,
    p_metadata: metadata,
  });
}

export async function recordPendingLightDeposit(
  input: DepositPendingInput,
): Promise<DepositRpcResult | null> {
  const rows = await postRpc<RpcDepositRow>("upsert_pending_light_deposit", {
    p_user_id: input.userId,
    p_requested_amount_cents: input.requestedAmountCents,
    p_requested_light: input.requestedLight,
    p_funding_method: input.fundingMethod,
    p_stripe_event_id: input.stripeEventId || null,
    p_stripe_payment_intent_id: input.stripePaymentIntentId || null,
    p_stripe_checkout_session_id: input.stripeCheckoutSessionId || null,
    p_stripe_charge_id: input.stripeChargeId || null,
    p_stripe_customer_id: input.stripeCustomerId || null,
    p_billing_config_version: input.billingConfigVersion,
    p_light_per_usd_snapshot: input.lightPerUsd,
    p_metadata: input.metadata || {},
  });
  return rows[0] ? normalizeDepositResult(rows[0]) : null;
}

export async function finalizeLightDeposit(
  input: DepositFinalizationInput,
): Promise<DepositRpcResult> {
  const rows = await postRpc<RpcDepositRow>("finalize_light_deposit", {
    p_user_id: input.userId,
    p_amount_cents: input.amountCents,
    p_light_amount: input.lightAmount,
    p_funding_method: input.fundingMethod,
    p_stripe_event_id: input.stripeEventId,
    p_requested_amount_cents: input.requestedAmountCents,
    p_requested_light: input.requestedLight,
    p_stripe_payment_intent_id: input.stripePaymentIntentId || null,
    p_stripe_checkout_session_id: input.stripeCheckoutSessionId || null,
    p_stripe_charge_id: input.stripeChargeId || null,
    p_stripe_customer_id: input.stripeCustomerId || null,
    p_billing_config_version: input.billingConfigVersion,
    p_light_per_usd_snapshot: input.lightPerUsd,
    p_metadata: input.metadata || {},
  });
  if (!rows[0]) throw new Error("Light deposit finalizer returned no rows");
  return normalizeDepositResult(rows[0]);
}

export async function markLightDepositFailed(
  input: DepositFailureInput,
): Promise<DepositRpcResult | null> {
  const rows = await postRpc<RpcDepositRow>("mark_light_deposit_failed", {
    p_user_id: input.userId || null,
    p_stripe_event_id: input.stripeEventId,
    p_stripe_payment_intent_id: input.stripePaymentIntentId || null,
    p_stripe_checkout_session_id: input.stripeCheckoutSessionId || null,
    p_stripe_charge_id: input.stripeChargeId || null,
    p_stripe_customer_id: input.stripeCustomerId || null,
    p_funding_method: input.fundingMethod,
    p_failure_code: input.failureCode || null,
    p_failure_message: input.failureMessage || null,
    p_metadata: input.metadata || {},
  });
  return rows[0] ? normalizeDepositResult(rows[0]) : null;
}

export interface FailedDepositAttemptInput {
  userId: string;
  fundingMethod: string;
  failureCode: string;
  failureMessage?: string;
  requestedLight?: number;
  requestedAmountCents?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Persist a top-up attempt that failed BEFORE a Stripe object existed
 * (missing Stripe config, PaymentIntent create rejected). Without this row a
 * hard-down checkout leaves zero DB trace — the exact 503 outage class that
 * already happened once, silently. Direct insert (not the webhook RPCs, which
 * key on a stripe_event id this failure never gets). Callers treat it as
 * best-effort: a logging failure must never mask the original error.
 */
export async function recordFailedLightDepositAttempt(
  input: FailedDepositAttemptInput,
): Promise<void> {
  const res = await fetch(`${getEnv("SUPABASE_URL")}/rest/v1/light_deposits`, {
    method: "POST",
    headers: { ...dbHeaders(), "Prefer": "return=minimal" },
    body: JSON.stringify({
      user_id: input.userId,
      status: "failed",
      funding_method: input.fundingMethod,
      requested_amount_cents: input.requestedAmountCents ?? null,
      requested_light: input.requestedLight ?? null,
      failure_code: input.failureCode,
      failure_message: (input.failureMessage || "").slice(0, 500) || null,
      failed_at: new Date().toISOString(),
      metadata: {
        attempt_stage: "intent_create",
        ...(input.metadata || {}),
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to record deposit attempt failure: ${await res.text()}`,
    );
  }
}

export async function recordLightDepositReversal(
  input: DepositReversalInput,
): Promise<DepositRpcResult | null> {
  const rows = await postRpc<RpcDepositRow>("record_light_deposit_reversal", {
    p_stripe_event_id: input.stripeEventId,
    p_reason: input.reason,
    p_amount_cents: input.amountCents,
    p_stripe_payment_intent_id: input.stripePaymentIntentId || null,
    p_stripe_checkout_session_id: input.stripeCheckoutSessionId || null,
    p_stripe_charge_id: input.stripeChargeId || null,
    p_metadata: input.metadata || {},
  });
  return rows[0] ? normalizeDepositResult(rows[0]) : null;
}
