import { getEnv } from "../lib/env.ts";
import { getSupabaseEnv } from "./user-supabase-configs.ts";

export const PRO_SUBSCRIPTION_REQUIRED_CODE = "PRO_SUBSCRIPTION_REQUIRED";
export const PRO_SUBSCRIPTION_UNAVAILABLE_CODE =
  "PRO_SUBSCRIPTION_CHECK_UNAVAILABLE";

export class ProSubscriptionRequiredError extends Error {
  readonly code = PRO_SUBSCRIPTION_REQUIRED_CODE;
  readonly status = 402;

  constructor() {
    super(
      "An active Galactic Pro subscription ($20/month) is required to use API keys, upload Agents, or run Agents.",
    );
    this.name = "ProSubscriptionRequiredError";
  }
}

export class ProSubscriptionCheckUnavailableError extends Error {
  readonly code = PRO_SUBSCRIPTION_UNAVAILABLE_CODE;
  readonly status = 503;

  constructor() {
    super("Galactic could not verify the Pro subscription. Please try again.");
    this.name = "ProSubscriptionCheckUnavailableError";
  }
}

interface EntitlementRow {
  plan_code?: string | null;
  subscription_status?: string | null;
}

interface ProSubscriptionDeps {
  fetchFn?: typeof fetch;
  enabled?: boolean;
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

export function isProSubscriptionRequired(): boolean {
  return getEnv("PRO_SUBSCRIPTION_REQUIRED") === "1";
}

export function isProSubscriptionError(
  error: unknown,
): error is
  | ProSubscriptionRequiredError
  | ProSubscriptionCheckUnavailableError {
  return error instanceof ProSubscriptionRequiredError ||
    error instanceof ProSubscriptionCheckUnavailableError;
}

export async function hasActiveProSubscription(
  userId: string,
  deps: ProSubscriptionDeps = {},
): Promise<boolean> {
  if (!(deps.enabled ?? isProSubscriptionRequired())) return true;

  const env = getSupabaseEnv();
  const supabaseUrl = deps.supabaseUrl ?? env.SUPABASE_URL;
  const serviceRoleKey = deps.serviceRoleKey ??
    env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await (deps.fetchFn ?? fetch)(
    `${supabaseUrl}/rest/v1/account_entitlements?user_id=eq.${
      encodeURIComponent(userId)
    }&select=plan_code,subscription_status&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!response.ok) {
    throw new ProSubscriptionCheckUnavailableError();
  }

  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload)) {
    throw new ProSubscriptionCheckUnavailableError();
  }
  const entitlement = payload[0] as EntitlementRow | undefined;
  // Max rows were historical paid subscriptions. Accept them only during the
  // rolling DB/API overlap; the migration collapses them to Pro and no new Max
  // checkout exists.
  return (
    entitlement?.plan_code === "pro" ||
    entitlement?.plan_code === "max_5x" ||
    entitlement?.plan_code === "max_10x"
  ) &&
    entitlement.subscription_status === "active";
}

export async function requireActiveProSubscription(
  userId: string,
  deps: ProSubscriptionDeps = {},
): Promise<void> {
  if (!await hasActiveProSubscription(userId, deps)) {
    throw new ProSubscriptionRequiredError();
  }
}
