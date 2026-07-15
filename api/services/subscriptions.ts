import type {
  LaunchCapacityResponse,
  LaunchPlanCode,
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

function dbHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

async function readPlan(code: LaunchPlanCode): Promise<PlanRow> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/billing_plans?code=eq.${encodeURIComponent(code)}&select=code,display_name,price_cents,currency,interval,stripe_price_id,purchasable&limit=1`,
    { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
  );
  if (!response.ok) throw new Error("Failed to read subscription plan");
  const [plan] = rows<PlanRow>(await response.json());
  if (!plan) throw new Error(`Subscription plan ${code} is unavailable`);
  return plan;
}

async function readSubscription(userId: string): Promise<SubscriptionRow | null> {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/account_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=plan_code,status,current_period_end,cancel_at_period_end,stripe_subscription_id&limit=1`,
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
    plan: status.planCode,
    state: status.state,
    burst: {
      state: status.burst.state,
      resetsAt: status.burst.resetsAt,
      ...(status.burst.usedPercent !== undefined
        ? { usedPercent: status.burst.usedPercent }
        : {}),
    },
    weekly: {
      state: status.weekly.state,
      resetsAt: status.weekly.resetsAt,
      ...(status.weekly.usedPercent !== undefined
        ? { usedPercent: status.weekly.usedPercent }
        : {}),
    },
    nextEligibleAt: status.nextEligibleAt,
    activeAgentLimit: status.activeAgentLimit,
    generatedAt,
  };
}

export async function getLaunchSubscription(userId: string): Promise<LaunchSubscriptionResponse> {
  const [subscription, capacityStatus] = await Promise.all([
    readSubscription(userId),
    getAccountCapacityStatus(userId),
  ]);
  const effectivePlan = capacityStatus.planCode;
  const plan = await readPlan(effectivePlan);
  const generatedAt = new Date().toISOString();
  const status = subscription?.status ?? "inactive";
  return {
    plan: effectivePlan,
    planName: plan.display_name,
    priceCents: plan.price_cents,
    currency: "usd",
    interval: "month",
    status,
    currentPeriodEnd: subscription?.current_period_end ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end === true,
    canSubscribe: effectivePlan === "free",
    canManage: Boolean(subscription?.stripe_subscription_id),
    capacity: toLaunchCapacityResponse(capacityStatus, generatedAt),
    generatedAt,
  };
}

function safeReturnUrl(requestOrigin: string, requested?: string | null): string {
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

async function stripeForm(path: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const key = getEnv("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe subscriptions are not configured");
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as Record<string, unknown> | undefined;
    throw new Error(typeof error?.message === "string" ? error.message : "Stripe request failed");
  }
  return payload;
}

export async function createSubscriptionCheckout(input: {
  userId: string;
  plan: "pro";
  requestOrigin: string;
  returnUrl?: string | null;
}): Promise<string> {
  const plan = await readPlan(input.plan);
  const priceId = plan.stripe_price_id || getEnv("STRIPE_PRO_PRICE_ID");
  if (!plan.purchasable || !priceId) throw new Error("Pro checkout is not configured");
  const existing = await readSubscription(input.userId);
  if (existing && ["active", "trialing", "past_due"].includes(existing.status)) {
    throw new Error("This account already has a managed subscription");
  }
  const key = getEnv("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe subscriptions are not configured");
  const { stripeCustomerId } = await getOrCreateStripeCustomerForUser(input.userId, key);
  const returnUrl = safeReturnUrl(input.requestOrigin, input.returnUrl);
  const payload = await stripeForm("checkout/sessions", new URLSearchParams({
    mode: "subscription",
    customer: stripeCustomerId,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}subscription=success`,
    cancel_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}subscription=cancelled`,
    client_reference_id: input.userId,
    "metadata[user_id]": input.userId,
    "metadata[plan_code]": input.plan,
    "subscription_data[metadata][user_id]": input.userId,
    "subscription_data[metadata][plan_code]": input.plan,
    allow_promotion_codes: "false",
  }));
  if (typeof payload.url !== "string") throw new Error("Stripe returned no checkout URL");
  return payload.url;
}

export async function createSubscriptionPortal(input: {
  userId: string;
  requestOrigin: string;
  returnUrl?: string | null;
}): Promise<string> {
  const key = getEnv("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Stripe subscriptions are not configured");
  const { stripeCustomerId } = await getOrCreateStripeCustomerForUser(input.userId, key);
  const payload = await stripeForm("billing_portal/sessions", new URLSearchParams({
    customer: stripeCustomerId,
    return_url: safeReturnUrl(input.requestOrigin, input.returnUrl),
  }));
  if (typeof payload.url !== "string") throw new Error("Stripe returned no portal URL");
  return payload.url;
}

function stripeId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
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
    `${SUPABASE_URL}/rest/v1/users?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=id&limit=1`,
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
  if (metadata?.plan_code === "pro" || metadata?.plan_code === "max_5x" ||
    metadata?.plan_code === "max_10x") return metadata.plan_code;
  if (priceId) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/billing_plans?stripe_price_id=eq.${encodeURIComponent(priceId)}&select=code&limit=1`,
      { headers: dbHeaders(SUPABASE_SERVICE_ROLE_KEY) },
    );
    if (response.ok) {
      const code = rows<{ code: LaunchPlanCode }>(await response.json())[0]?.code;
      if (code) return code;
    }
  }
  throw new Error("Stripe subscription references an unknown plan");
}

export async function projectStripeSubscriptionEvent(
  event: StripeWebhookEvent,
): Promise<boolean> {
  if (!event.type.startsWith("customer.subscription.")) return false;
  const object = event.data.object as unknown as Record<string, unknown>;
  const userId = await resolveSubscriptionUserId(object);
  if (!userId) throw new Error("Stripe subscription has no Galactic user");
  const items = object.items as { data?: Array<Record<string, unknown>> } | undefined;
  const price = items?.data?.[0]?.price as Record<string, unknown> | undefined;
  const priceId = stripeId(price);
  const plan = await resolvePlanCode(object, priceId);
  const rawStatus = event.type === "customer.subscription.deleted"
    ? "canceled"
    : object.status;
  const statuses: LaunchSubscriptionStatus[] = [
    "inactive", "incomplete", "incomplete_expired", "trialing", "active",
    "past_due", "canceled", "unpaid", "paused",
  ];
  const status = statuses.includes(rawStatus as LaunchSubscriptionStatus)
    ? rawStatus as LaunchSubscriptionStatus
    : "inactive";
  const customerId = stripeId(object.customer);
  const subscriptionId = stripeId(object.id);
  if (!customerId || !subscriptionId) throw new Error("Stripe subscription identity is incomplete");

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseEnv();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/project_account_subscription`, {
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
      p_event_created_at: stripeTimestamp(event.created) ?? new Date().toISOString(),
      p_snapshot: object,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to project Stripe subscription (${response.status})`);
  }
  return true;
}
