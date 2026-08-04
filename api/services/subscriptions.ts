import type {
  LaunchCapacityResponse,
  LaunchPlanCode,
  LaunchSubscriptionCheckoutAttemptResponse,
  LaunchSubscriptionCheckoutAttemptStatus,
  LaunchSubscriptionRedirectResponse,
  LaunchSubscriptionResponse,
  LaunchSubscriptionStatus,
} from "../../shared/contracts/launch.ts";
import { getEnv } from "../lib/env.ts";
import type { StripeWebhookEvent } from "./stripe-deposits.ts";
import { getOrCreateStripeCustomerForUser } from "./stripe-customers.ts";
import { getSupabaseEnv } from "./user-supabase-configs.ts";
import { getAccountCapacityStatus } from "./account-capacity.ts";

interface PlanRow {
  code: LaunchPlanCode;
  display_name: string;
  price_cents: number;
  currency: "usd";
  interval: "month";
  stripe_price_id: string | null;
  purchasable: boolean;
}

interface SubscriptionRow {
  plan_code: LaunchPlanCode;
  status: LaunchSubscriptionStatus;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  stripe_subscription_id: string | null;
}

interface SubscriptionCheckoutAttemptRow {
  attempt_id: string;
  status: LaunchSubscriptionCheckoutAttemptStatus;
  checkout_url?: string | null;
  stripe_checkout_session_id?: string | null;
  replayed?: boolean;
}

interface StripeCheckoutSessionSnapshot {
  id: string;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  customerId: string | null;
  subscriptionId: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKOUT_ATTEMPT_TTL_MS = 23 * 60 * 60 * 1_000;
const TERMINAL_CHECKOUT_ATTEMPT_STATUSES = new Set<
  LaunchSubscriptionCheckoutAttemptStatus
>(["active", "cancelled", "failed", "expired"]);

export class SubscriptionCheckoutAttemptNotFoundError extends Error {
  constructor() {
    super("Subscription checkout attempt not found");
    this.name = "SubscriptionCheckoutAttemptNotFoundError";
  }
}

export class SubscriptionCheckoutCancellationError extends Error {
  readonly code:
    | "checkout_cancellation_conflict"
    | "checkout_cancellation_unavailable";
  readonly status: 409 | 503;

  constructor(
    code:
      | "checkout_cancellation_conflict"
      | "checkout_cancellation_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionCheckoutCancellationError";
    this.code = code;
    this.status = code === "checkout_cancellation_conflict" ? 409 : 503;
  }
}

class StripeRequestError extends Error {
  readonly definitive: boolean;

  constructor(message: string, definitive: boolean) {
    super(message);
    this.name = "StripeRequestError";
    this.definitive = definitive;
  }
}

class StripeCheckoutCreationError extends Error {
  readonly safeToFailAttempt: boolean;

  constructor(message: string, safeToFailAttempt: boolean) {
    super(message);
    this.name = "StripeCheckoutCreationError";
    this.safeToFailAttempt = safeToFailAttempt;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function dbHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

async function readPlan(code: LaunchPlanCode): Promise<PlanRow> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/billing_plans?code=eq.${
      encodeURIComponent(code)
    }&select=code,display_name,price_cents,currency,interval,stripe_price_id,purchasable&limit=1`,
    { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
  );
  if (!response.ok) throw new Error("Failed to read subscription plan");
  const [plan] = rows<PlanRow>(await response.json());
  if (!plan) throw new Error(`Subscription plan ${code} is unavailable`);
  return plan;
}

async function readSubscription(
  userId: string,
): Promise<SubscriptionRow | null> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/account_subscriptions?user_id=eq.${
      encodeURIComponent(userId)
    }&select=plan_code,status,current_period_end,cancel_at_period_end,stripe_subscription_id&limit=1`,
    { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
  );
  if (!response.ok) throw new Error("Failed to read account subscription");
  return rows<SubscriptionRow>(await response.json())[0] ?? null;
}

export function toLaunchCapacityResponse(
  status: Awaited<ReturnType<typeof getAccountCapacityStatus>>,
  generatedAt = new Date().toISOString(),
): LaunchCapacityResponse {
  return {
    plan: "pro",
    state: status.weekly.state,
    weekly: {
      state: status.weekly.state,
      resetsAt: status.weekly.resetsAt,
      ...(status.weekly.usedPercent !== undefined
        ? { usedPercent: status.weekly.usedPercent }
        : {}),
    },
    nextEligibleAt: status.nextEligibleAt,
    activeAgentLimit: null,
    generatedAt,
  };
}

export async function getLaunchSubscription(
  userId: string,
): Promise<LaunchSubscriptionResponse> {
  const [subscription, capacityStatus] = await Promise.all([
    readSubscription(userId),
    getAccountCapacityStatus(userId),
  ]);
  const effectivePlan = capacityStatus.planCode;
  const plan = await readPlan(effectivePlan);
  const generatedAt = new Date().toISOString();
  const status = subscription?.status ?? "inactive";
  const hasActiveSubscription = status === "active";
  return {
    plan: effectivePlan,
    planName: plan.display_name,
    priceCents: plan.price_cents,
    currency: "usd",
    interval: "month",
    status,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end === true,
    hasActiveSubscription,
    canSubscribe: !subscription?.stripe_subscription_id,
    canManage: Boolean(subscription?.stripe_subscription_id),
    capacity: toLaunchCapacityResponse(capacityStatus, generatedAt),
    generatedAt,
  };
}

function safeReturnUrl(
  requestOrigin: string,
  requested?: string | null,
): string {
  const fallback = `${requestOrigin.replace(/\/+$/, "")}/account`;
  if (!requested) return fallback;
  try {
    const candidate = new URL(requested, requestOrigin);
    const origin = new URL(requestOrigin);
    return candidate.protocol === "https:" && candidate.origin === origin.origin
      ? candidate.toString()
      : fallback;
  } catch {
    return fallback;
  }
}

async function stripeForm(
  path: string,
  body: URLSearchParams,
  options: { idempotencyKey?: string } = {},
): Promise<Record<string, unknown>> {
  const key = getEnv("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe subscriptions are not configured");
  let response: Response;
  try {
    response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(options.idempotencyKey
          ? { "Idempotency-Key": options.idempotencyKey }
          : {}),
      },
      body: body.toString(),
    });
  } catch {
    throw new StripeRequestError(
      "Stripe request outcome could not be confirmed",
      false,
    );
  }
  const payload = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new StripeRequestError(
      typeof error?.message === "string"
        ? error.message
        : "Stripe request failed",
      response.status >= 400 && response.status < 500,
    );
  }
  return payload;
}

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  const key = getEnv("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe subscriptions are not configured");
  let response: Response;
  try {
    response = await fetch(`https://api.stripe.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    throw new StripeRequestError(
      "Stripe request outcome could not be confirmed",
      false,
    );
  }
  const payload = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new StripeRequestError(
      typeof error?.message === "string"
        ? error.message
        : "Stripe request failed",
      response.status >= 400 && response.status < 500,
    );
  }
  return payload;
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).id === "string"
  ) {
    return (value as Record<string, unknown>).id as string;
  }
  return null;
}

function stripeCheckoutSessionSnapshot(
  value: Record<string, unknown>,
  expectedId: string,
): StripeCheckoutSessionSnapshot {
  const statuses = ["open", "complete", "expired"] as const;
  const paymentStatuses = ["paid", "unpaid", "no_payment_required"] as const;
  if (
    value.id !== expectedId ||
    typeof value.status !== "string" ||
    !statuses.includes(value.status as typeof statuses[number]) ||
    typeof value.payment_status !== "string" ||
    !paymentStatuses.includes(
      value.payment_status as typeof paymentStatuses[number],
    )
  ) {
    throw new SubscriptionCheckoutCancellationError(
      "checkout_cancellation_conflict",
      "Checkout could not be safely cancelled because Stripe returned an ambiguous session state.",
    );
  }
  return {
    id: expectedId,
    status: value.status as StripeCheckoutSessionSnapshot["status"],
    paymentStatus: value
      .payment_status as StripeCheckoutSessionSnapshot["paymentStatus"],
    customerId: stripeObjectId(value.customer),
    subscriptionId: stripeObjectId(value.subscription),
  };
}

function isStripeCheckoutRedirect(
  payload: Record<string, unknown>,
): payload is Record<string, unknown> & { id: string; url: string } {
  return typeof payload.id === "string" && payload.id.length > 0 &&
    typeof payload.url === "string" && payload.url.length > 0;
}

async function createStripeCheckoutSessionWithRecovery(
  body: URLSearchParams,
  idempotencyKey: string,
): Promise<Record<string, unknown> & { id: string; url: string }> {
  let firstFailure: unknown;
  try {
    const first = await stripeForm(
      "checkout/sessions",
      body,
      { idempotencyKey },
    );
    if (isStripeCheckoutRedirect(first)) return first;
    firstFailure = new StripeCheckoutCreationError(
      "Stripe returned an incomplete checkout session",
      false,
    );
  } catch (error) {
    firstFailure = error;
  }

  let retryFailure: unknown;
  try {
    // The exact same Stripe idempotency key and form recover a session whose
    // first response was lost after Stripe committed it.
    const recovered = await stripeForm(
      "checkout/sessions",
      body,
      { idempotencyKey },
    );
    if (isStripeCheckoutRedirect(recovered)) return recovered;
    retryFailure = new StripeCheckoutCreationError(
      "Stripe returned an incomplete checkout session",
      false,
    );
  } catch (error) {
    retryFailure = error;
  }

  const safelyRejected = firstFailure instanceof StripeRequestError &&
    firstFailure.definitive &&
    retryFailure instanceof StripeRequestError &&
    retryFailure.definitive;
  const message = retryFailure instanceof Error
    ? retryFailure.message
    : "Stripe checkout creation could not be confirmed";
  throw new StripeCheckoutCreationError(message, safelyRejected);
}

function checkoutCancellationFailure(
  error: unknown,
): SubscriptionCheckoutCancellationError {
  const unavailable = !(error instanceof StripeRequestError) ||
    !error.definitive;
  return new SubscriptionCheckoutCancellationError(
    unavailable
      ? "checkout_cancellation_unavailable"
      : "checkout_cancellation_conflict",
    unavailable
      ? "Checkout could not be safely cancelled because Stripe could not be reached. Nothing was changed; try again."
      : "Checkout could not be safely cancelled because its Stripe state could not be verified. Nothing was changed.",
  );
}

async function retrieveStripeCheckoutSession(
  sessionId: string,
): Promise<StripeCheckoutSessionSnapshot> {
  let payload: Record<string, unknown>;
  try {
    payload = await stripeGet(
      `checkout/sessions/${encodeURIComponent(sessionId)}`,
    );
  } catch (error) {
    throw checkoutCancellationFailure(error);
  }
  return stripeCheckoutSessionSnapshot(payload, sessionId);
}

function stripeCheckoutMayHaveCompleted(
  session: StripeCheckoutSessionSnapshot,
): boolean {
  return session.status === "complete" ||
    session.paymentStatus !== "unpaid";
}

function stripeCheckoutIsSafelyExpired(
  session: StripeCheckoutSessionSnapshot,
): boolean {
  return session.status === "expired" &&
    session.paymentStatus === "unpaid";
}

async function expireStripeCheckoutSession(
  sessionId: string,
  idempotencyKey: string,
): Promise<StripeCheckoutSessionSnapshot> {
  let payload: Record<string, unknown>;
  try {
    payload = await stripeForm(
      `checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
      new URLSearchParams(),
      { idempotencyKey },
    );
  } catch (error) {
    throw checkoutCancellationFailure(error);
  }
  return stripeCheckoutSessionSnapshot(payload, sessionId);
}

async function retireUnpublishedStripeCheckoutSession(
  sessionId: string,
  attemptId: string,
): Promise<void> {
  let session = await retrieveStripeCheckoutSession(sessionId);
  if (
    stripeCheckoutMayHaveCompleted(session) ||
    stripeCheckoutIsSafelyExpired(session)
  ) {
    return;
  }
  session = await expireStripeCheckoutSession(
    sessionId,
    `galactic-subscription-cancel-${attemptId}`,
  );
  if (
    !stripeCheckoutMayHaveCompleted(session) &&
    !stripeCheckoutIsSafelyExpired(session)
  ) {
    throw new SubscriptionCheckoutCancellationError(
      "checkout_cancellation_conflict",
      "The unpublished Stripe Checkout Session could not be safely retired.",
    );
  }
}

function checkoutAttemptRow(value: unknown): SubscriptionCheckoutAttemptRow {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("Subscription checkout persistence returned no attempt");
  }
  const record = row as Record<string, unknown>;
  const statuses: LaunchSubscriptionCheckoutAttemptStatus[] = [
    "creating",
    "pending",
    "active",
    "cancelled",
    "failed",
    "expired",
  ];
  if (
    typeof record.attempt_id !== "string" ||
    !UUID_PATTERN.test(record.attempt_id) ||
    typeof record.status !== "string" ||
    !statuses.includes(record.status as LaunchSubscriptionCheckoutAttemptStatus)
  ) {
    throw new Error(
      "Subscription checkout persistence returned an invalid attempt",
    );
  }
  return {
    attempt_id: record.attempt_id.toLowerCase(),
    status: record.status as LaunchSubscriptionCheckoutAttemptStatus,
    checkout_url: typeof record.checkout_url === "string"
      ? record.checkout_url
      : null,
    stripe_checkout_session_id:
      typeof record.stripe_checkout_session_id === "string"
        ? record.stripe_checkout_session_id
        : null,
    replayed: record.replayed === true,
  };
}

async function checkoutAttemptRpc(
  name: string,
  request: Record<string, unknown>,
): Promise<SubscriptionCheckoutAttemptRow> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      ...dbHeaders(SUPABASE_SERVICE_ROLE_KEY),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_request: request }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(payload);
    } catch {
      // Keep the public error generic.
    }
    if (detail.includes("CHECKOUT_IDEMPOTENCY_CONFLICT")) {
      throw new Error(
        "That checkout idempotency key was already used for a different request",
      );
    }
    if (detail.includes("CHECKOUT_SUBSCRIPTION_EXISTS")) {
      throw new Error("This account already has a managed subscription");
    }
    if (detail.includes("CHECKOUT_ATTEMPT_IN_PROGRESS")) {
      throw new Error(
        "A membership checkout is already in progress. Continue that checkout or wait for it to expire.",
      );
    }
    throw new Error("Subscription checkout persistence is unavailable");
  }
  if (
    payload && typeof payload === "object" && !Array.isArray(payload) &&
    (payload as Record<string, unknown>).code ===
      "checkout_attempt_not_found"
  ) {
    throw new SubscriptionCheckoutAttemptNotFoundError();
  }
  return checkoutAttemptRow(payload);
}

function checkoutIdempotencyKey(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new Error("Checkout idempotency key must be a UUID");
  }
  return value.toLowerCase();
}

export async function createSubscriptionCheckout(input: {
  userId: string;
  plan: "pro";
  requestOrigin: string;
  returnUrl: string;
  idempotencyKey: string;
  /**
   * WO-F3: a funnel checkout is customerless (Stripe Link captures the
   * email; the completed-webhook places stripe_customer_id on the right
   * users row) and omits subscription-level user_id metadata so
   * customer.subscription.* events resolve through the customer mapping
   * instead of pinning membership to the provisional row.
   */
  funnelPairingCode?: string | null;
}): Promise<LaunchSubscriptionRedirectResponse> {
  const plan = await readPlan(input.plan);
  const priceId = plan.stripe_price_id || getEnv("STRIPE_PRO_PRICE_ID");
  if (!plan.purchasable || !priceId) {
    throw new Error("Pro checkout is not configured");
  }
  const existing = await readSubscription(input.userId);
  if (
    existing && ["active", "trialing", "past_due"].includes(existing.status)
  ) {
    throw new Error("This account already has a managed subscription");
  }
  const key = getEnv("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe subscriptions are not configured");
  const returnUrl = safeReturnUrl(input.requestOrigin, input.returnUrl);
  const idempotencyKey = checkoutIdempotencyKey(input.idempotencyKey);
  const attemptId = crypto.randomUUID();
  const requestFingerprint = await sha256Hex(JSON.stringify({
    owner_id: input.userId,
    plan_code: input.plan,
    return_url: returnUrl,
    idempotency_key: idempotencyKey,
  }));
  const claimed = await checkoutAttemptRpc(
    "claim_subscription_checkout_attempt",
    {
      owner_id: input.userId,
      attempt_id: attemptId,
      idempotency_key: idempotencyKey,
      plan_code: input.plan,
      request_fingerprint: requestFingerprint,
      return_url: returnUrl,
      expires_at: new Date(Date.now() + CHECKOUT_ATTEMPT_TTL_MS)
        .toISOString(),
    },
  );
  if (
    claimed.status === "pending" &&
    typeof claimed.checkout_url === "string" &&
    claimed.checkout_url
  ) {
    return {
      url: claimed.checkout_url,
      attemptId: claimed.attempt_id,
      status: "pending",
      generatedAt: new Date().toISOString(),
    };
  }
  if (claimed.status !== "creating") {
    throw new Error(
      claimed.status === "active"
        ? "This checkout already activated the membership"
        : "This checkout attempt can no longer be used",
    );
  }

  const funnelPairingCode = input.funnelPairingCode ?? null;
  const stripeCustomerId = funnelPairingCode
    ? null
    : (await getOrCreateStripeCustomerForUser(input.userId, key))
      .stripeCustomerId;
  const separator = returnUrl.includes("?") ? "&" : "?";
  const stripeIdempotencyKey =
    `galactic-subscription-${input.userId}-${claimed.attempt_id}`;
  const stripeCheckoutRequest = new URLSearchParams({
    mode: "subscription",
    ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url:
      `${returnUrl}${separator}subscription=success&subscription_attempt=${claimed.attempt_id}`,
    cancel_url:
      `${returnUrl}${separator}subscription=cancelled&subscription_attempt=${claimed.attempt_id}`,
    client_reference_id: claimed.attempt_id,
    "metadata[user_id]": input.userId,
    "metadata[plan_code]": input.plan,
    "metadata[checkout_attempt_id]": claimed.attempt_id,
    ...(funnelPairingCode
      ? {
        "metadata[funnel_pairing_code]": funnelPairingCode,
        "subscription_data[metadata][funnel_pairing_code]": funnelPairingCode,
      }
      : { "subscription_data[metadata][user_id]": input.userId }),
    "subscription_data[metadata][plan_code]": input.plan,
    "subscription_data[metadata][checkout_attempt_id]": claimed.attempt_id,
    allow_promotion_codes: "false",
  });
  let payload: Record<string, unknown> & { id: string; url: string };
  try {
    payload = await createStripeCheckoutSessionWithRecovery(
      stripeCheckoutRequest,
      stripeIdempotencyKey,
    );
  } catch (error) {
    if (
      error instanceof StripeCheckoutCreationError &&
      error.safeToFailAttempt
    ) {
      await checkoutAttemptRpc("project_subscription_checkout_attempt", {
        owner_id: input.userId,
        attempt_id: claimed.attempt_id,
        status: "failed",
        reason: "stripe_session_creation_failed",
      }).catch(() => undefined);
    }
    throw error;
  }
  const bound = await checkoutAttemptRpc(
    "bind_subscription_checkout_attempt",
    {
      owner_id: input.userId,
      attempt_id: claimed.attempt_id,
      stripe_checkout_session_id: payload.id,
      checkout_url: payload.url,
    },
  );
  if (bound.status !== "pending") {
    // A cancel can win while the Stripe create request is in flight. Never
    // expose that now-terminal attempt's URL, and retire an open session before
    // returning the failure so it cannot be used after the DB lock is released.
    if (bound.status !== "active") {
      await retireUnpublishedStripeCheckoutSession(
        payload.id,
        claimed.attempt_id,
      );
    }
    throw new Error("Subscription checkout could not be activated");
  }
  return {
    url: payload.url,
    attemptId: bound.attempt_id,
    status: "pending",
    generatedAt: new Date().toISOString(),
  };
}

export async function getSubscriptionCheckoutAttempt(input: {
  userId: string;
  attemptId: string;
}): Promise<LaunchSubscriptionCheckoutAttemptResponse> {
  if (!UUID_PATTERN.test(input.attemptId)) {
    throw new Error("Invalid subscription checkout attempt");
  }
  const [attempt, subscription] = await Promise.all([
    checkoutAttemptRpc("get_subscription_checkout_attempt", {
      owner_id: input.userId,
      attempt_id: input.attemptId.toLowerCase(),
    }),
    getLaunchSubscription(input.userId),
  ]);
  return {
    attemptId: attempt.attempt_id,
    status: attempt.status,
    subscription,
    generatedAt: new Date().toISOString(),
  };
}

async function reconcileNonCancellableCheckout(input: {
  userId: string;
  attemptId: string;
  session: StripeCheckoutSessionSnapshot;
}): Promise<LaunchSubscriptionCheckoutAttemptResponse> {
  let [attempt, subscription] = await Promise.all([
    checkoutAttemptRpc("get_subscription_checkout_attempt", {
      owner_id: input.userId,
      attempt_id: input.attemptId,
    }),
    getLaunchSubscription(input.userId),
  ]);

  if (
    !TERMINAL_CHECKOUT_ATTEMPT_STATUSES.has(attempt.status) &&
    subscription.hasActiveSubscription
  ) {
    attempt = await checkoutAttemptRpc(
      "project_subscription_checkout_attempt",
      {
        owner_id: input.userId,
        attempt_id: input.attemptId,
        status: "active",
        stripe_checkout_session_id: input.session.id,
        ...(input.session.customerId
          ? { stripe_customer_id: input.session.customerId }
          : {}),
        ...(input.session.subscriptionId
          ? { stripe_subscription_id: input.session.subscriptionId }
          : {}),
      },
    );
    // Projection and subscription are read from separate durable sources.
    // Refresh membership after the projection so the returned pair represents
    // the newest authoritative state in either ordering of the webhook race.
    subscription = await getLaunchSubscription(input.userId);
  }

  return {
    attemptId: attempt.attempt_id,
    status: attempt.status,
    subscription,
    generatedAt: new Date().toISOString(),
  };
}

export async function cancelSubscriptionCheckoutAttempt(input: {
  userId: string;
  attemptId: string;
}): Promise<LaunchSubscriptionCheckoutAttemptResponse> {
  if (!UUID_PATTERN.test(input.attemptId)) {
    throw new Error("Invalid subscription checkout attempt");
  }
  const attemptId = input.attemptId.toLowerCase();
  const current = await checkoutAttemptRpc(
    "get_subscription_checkout_attempt",
    {
      owner_id: input.userId,
      attempt_id: attemptId,
    },
  );

  if (TERMINAL_CHECKOUT_ATTEMPT_STATUSES.has(current.status)) {
    return {
      attemptId: current.attempt_id,
      status: current.status,
      subscription: await getLaunchSubscription(input.userId),
      generatedAt: new Date().toISOString(),
    };
  }

  if (current.status === "pending") {
    const sessionId = current.stripe_checkout_session_id;
    if (!sessionId) {
      throw new SubscriptionCheckoutCancellationError(
        "checkout_cancellation_conflict",
        "Checkout could not be safely cancelled because its Stripe session is not bound. Nothing was changed.",
      );
    }

    let stripeSession = await retrieveStripeCheckoutSession(sessionId);
    if (stripeCheckoutMayHaveCompleted(stripeSession)) {
      return await reconcileNonCancellableCheckout({
        userId: input.userId,
        attemptId,
        session: stripeSession,
      });
    }

    if (!stripeCheckoutIsSafelyExpired(stripeSession)) {
      try {
        stripeSession = await expireStripeCheckoutSession(
          sessionId,
          `galactic-subscription-cancel-${attemptId}`,
        );
      } catch (expireError) {
        // Stripe may reject expiry because payment completed between the read
        // and POST. Re-read before deciding; ambiguity never reaches the DB.
        stripeSession = await retrieveStripeCheckoutSession(sessionId);
        if (stripeCheckoutMayHaveCompleted(stripeSession)) {
          return await reconcileNonCancellableCheckout({
            userId: input.userId,
            attemptId,
            session: stripeSession,
          });
        }
        if (!stripeCheckoutIsSafelyExpired(stripeSession)) {
          throw expireError;
        }
      }
    }

    if (stripeCheckoutMayHaveCompleted(stripeSession)) {
      return await reconcileNonCancellableCheckout({
        userId: input.userId,
        attemptId,
        session: stripeSession,
      });
    }
    if (!stripeCheckoutIsSafelyExpired(stripeSession)) {
      throw new SubscriptionCheckoutCancellationError(
        "checkout_cancellation_conflict",
        "Checkout could not be safely cancelled because Stripe did not confirm expiry. Nothing was changed.",
      );
    }
  }

  const cancelled = await checkoutAttemptRpc(
    "cancel_subscription_checkout_attempt",
    {
      owner_id: input.userId,
      attempt_id: attemptId,
    },
  );
  const subscription = await getLaunchSubscription(input.userId);
  return {
    attemptId: cancelled.attempt_id,
    status: cancelled.status,
    subscription,
    generatedAt: new Date().toISOString(),
  };
}

export async function createSubscriptionPortal(input: {
  userId: string;
  requestOrigin: string;
  returnUrl?: string | null;
}): Promise<string> {
  const key = getEnv("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe subscriptions are not configured");
  const { stripeCustomerId } = await getOrCreateStripeCustomerForUser(
    input.userId,
    key,
  );
  const payload = await stripeForm(
    "billing_portal/sessions",
    new URLSearchParams({
      customer: stripeCustomerId,
      return_url: safeReturnUrl(input.requestOrigin, input.returnUrl),
    }),
  );
  if (typeof payload.url !== "string") {
    throw new Error("Stripe returned no portal URL");
  }
  return payload.url;
}

function stripeId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value && typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    return (value as { id: string }).id;
  }
  return null;
}

function stripeTimestamp(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

async function resolveSubscriptionUserId(
  object: Record<string, unknown>,
): Promise<string | null> {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  if (typeof metadata?.user_id === "string") return metadata.user_id;
  const customerId = stripeId(object.customer);
  if (!customerId) return null;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/users?stripe_customer_id=eq.${
      encodeURIComponent(customerId)
    }&select=id&limit=1`,
    { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
  );
  if (!response.ok) throw new Error("Failed to resolve subscription customer");
  return rows<{ id: string }>(await response.json())[0]?.id ?? null;
}

async function resolvePlanCode(
  object: Record<string, unknown>,
  priceId: string | null,
): Promise<LaunchPlanCode> {
  const metadata = object.metadata as Record<string, unknown> | undefined;
  if (
    metadata?.plan_code === "pro" || metadata?.plan_code === "max_5x" ||
    metadata?.plan_code === "max_10x"
  ) return "pro";
  if (priceId) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/billing_plans?stripe_price_id=eq.${
        encodeURIComponent(priceId)
      }&select=code&limit=1`,
      { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
    );
    if (response.ok) {
      const code = rows<{ code: string }>(await response.json())[0]?.code;
      if (code === "pro" || code === "max_5x" || code === "max_10x") {
        return "pro";
      }
    }
  }
  throw new Error("Stripe subscription references an unknown plan");
}

export async function projectStripeSubscriptionEvent(
  event: StripeWebhookEvent,
): Promise<boolean> {
  const object = event.data.object as unknown as Record<string, unknown>;
  const objectMetadata = object.metadata as Record<string, unknown> | undefined;
  const checkoutAttemptId =
    typeof objectMetadata?.checkout_attempt_id === "string" &&
      UUID_PATTERN.test(objectMetadata.checkout_attempt_id)
      ? objectMetadata.checkout_attempt_id.toLowerCase()
      : null;

  if (event.type.startsWith("checkout.session.")) {
    if (!checkoutAttemptId) return false;
    const userId = typeof objectMetadata?.user_id === "string"
      ? objectMetadata.user_id
      : null;
    if (!userId) throw new Error("Stripe checkout has no Galactic user");
    const status: LaunchSubscriptionCheckoutAttemptStatus =
      event.type === "checkout.session.expired"
        ? "expired"
        : event.type === "checkout.session.async_payment_failed"
        ? "failed"
        : "pending";
    await checkoutAttemptRpc("project_subscription_checkout_attempt", {
      owner_id: userId,
      attempt_id: checkoutAttemptId,
      status,
      stripe_checkout_session_id: stripeId(object.id),
      stripe_subscription_id: stripeId(object.subscription),
      event_id: event.id,
      event_created_at: stripeTimestamp(event.created) ??
        new Date().toISOString(),
    });
    return true;
  }

  if (!event.type.startsWith("customer.subscription.")) return false;
  const userId = await resolveSubscriptionUserId(object);
  if (!userId) throw new Error("Stripe subscription has no Galactic user");
  const items = object.items as
    | { data?: Array<Record<string, unknown>> }
    | undefined;
  const price = items?.data?.[0]?.price as Record<string, unknown> | undefined;
  const priceId = stripeId(price);
  const plan = await resolvePlanCode(object, priceId);
  const rawStatus = event.type === "customer.subscription.deleted"
    ? "canceled"
    : object.status;
  const statuses: LaunchSubscriptionStatus[] = [
    "inactive",
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
  ];
  const status = statuses.includes(rawStatus as LaunchSubscriptionStatus)
    ? rawStatus as LaunchSubscriptionStatus
    : "inactive";
  const customerId = stripeId(object.customer);
  const subscriptionId = stripeId(object.id);
  if (!customerId || !subscriptionId) {
    throw new Error("Stripe subscription identity is incomplete");
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/project_account_subscription`,
    {
      method: "POST",
      headers: {
        ...dbHeaders(SUPABASE_SERVICE_ROLE_KEY),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_stripe_customer_id: customerId,
        p_stripe_subscription_id: subscriptionId,
        p_stripe_price_id: priceId,
        p_plan_code: plan,
        p_status: status,
        p_current_period_start: stripeTimestamp(object.current_period_start),
        p_current_period_end: stripeTimestamp(object.current_period_end),
        p_cancel_at_period_end: object.cancel_at_period_end === true,
        p_canceled_at: stripeTimestamp(object.canceled_at),
        p_ended_at: stripeTimestamp(object.ended_at),
        p_event_id: event.id,
        p_event_created_at: stripeTimestamp(event.created) ??
          new Date().toISOString(),
        p_snapshot: object,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to project Stripe subscription (${response.status})`,
    );
  }
  if (checkoutAttemptId) {
    const attemptStatus: LaunchSubscriptionCheckoutAttemptStatus =
      status === "active"
        ? "active"
        : status === "canceled" || status === "unpaid"
        ? "cancelled"
        : status === "incomplete_expired"
        ? "expired"
        : status === "past_due"
        ? "failed"
        : "pending";
    await checkoutAttemptRpc("project_subscription_checkout_attempt", {
      owner_id: userId,
      attempt_id: checkoutAttemptId,
      status: attemptStatus,
      stripe_subscription_id: subscriptionId,
      event_id: event.id,
      event_created_at: stripeTimestamp(event.created) ??
        new Date().toISOString(),
    });
  }
  return true;
}
