import { getEnv } from "../lib/env.ts";
import { claimFunnelSession } from "./funnel-sessions.ts";

/**
 * WO-F3: pay-first claim resolution.
 *
 * On `checkout.session.completed` carrying `metadata.funnel_pairing_code`,
 * the email Stripe Link captured (and OTP-verified) decides the account:
 *
 * - **Fresh email** → the provisional users row is PROMOTED IN PLACE
 *   (email + account_kind='member' + stripe_customer_id) and the funnel is
 *   claimed by its own — now real — owner. The user id never changes, so
 *   this is ordering-proof against the customer.subscription.* events that
 *   bind membership.
 * - **Existing email** → the existing account gains the Stripe customer
 *   mapping (only if it has none), so subscription events resolve to it
 *   through the customer lookup; the AGENT stays unclaimed until that
 *   person signs in and claims (decision 9: attaching the build to an
 *   existing account requires the account's own session).
 *
 * Funnel checkouts omit subscription-level user_id metadata precisely so
 * the customer mapping — placed here, on the right row — is what resolves.
 */

export type FunnelCheckoutOutcome =
  | { kind: "not_funnel" }
  | { kind: "no_email" }
  | { kind: "promoted_and_claimed"; userId: string }
  | { kind: "existing_account_linked"; userId: string }
  | { kind: "existing_account_conflict"; userId: string };

export interface FunnelClaimOptions {
  supabaseUrl?: string;
  serviceRoleKey?: string;
  fetchFn?: typeof fetch;
  claim?: typeof claimFunnelSession;
}

interface RestConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchFn: typeof fetch;
}

function restConfig(options: FunnelClaimOptions): RestConfig {
  const supabaseUrl = options.supabaseUrl ?? getEnv("SUPABASE_URL");
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Funnel claim is unavailable: no database");
  }
  return { supabaseUrl, serviceRoleKey, fetchFn: options.fetchFn ?? fetch };
}

async function rest(
  cfg: RestConfig,
  method: "GET" | "PATCH",
  pathAndQuery: string,
  body?: unknown,
): Promise<unknown> {
  const fetchFn = cfg.fetchFn;
  const response = await fetchFn(
    `${cfg.supabaseUrl}/rest/v1/${pathAndQuery}`,
    {
      method,
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...(method === "PATCH" ? { Prefer: "return=representation" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (!response.ok) {
    throw new Error(`Funnel claim storage rejected (${response.status})`);
  }
  return await response.json();
}

function rows(payload: unknown): Record<string, unknown>[] {
  return Array.isArray(payload)
    ? payload.filter((row): row is Record<string, unknown> =>
      Boolean(row && typeof row === "object")
    )
    : [];
}

export async function maybeCompleteFunnelCheckout(
  event: {
    type: string;
    data: { object: unknown };
  },
  options: FunnelClaimOptions = {},
): Promise<FunnelCheckoutOutcome> {
  if (event.type !== "checkout.session.completed") {
    return { kind: "not_funnel" };
  }
  const object = event.data.object as Record<string, unknown>;
  const metadata = object.metadata as Record<string, unknown> | undefined;
  const pairingCode = typeof metadata?.funnel_pairing_code === "string"
    ? metadata.funnel_pairing_code
    : null;
  if (!pairingCode) return { kind: "not_funnel" };

  const customerDetails = object.customer_details as
    | Record<string, unknown>
    | undefined;
  const email = typeof customerDetails?.email === "string"
    ? customerDetails.email.trim().toLowerCase()
    : "";
  if (!email) return { kind: "no_email" };
  const stripeCustomerId = typeof object.customer === "string"
    ? object.customer
    : null;

  const cfg = restConfig(options);
  const funnel = rows(
    await rest(
      cfg,
      "GET",
      `funnel_sessions?pairing_code=eq.${encodeURIComponent(pairingCode)}` +
        `&select=provisional_owner_id,claimed_at&limit=1`,
    ),
  )[0];
  if (!funnel) return { kind: "not_funnel" };
  const provisionalId = String(funnel.provisional_owner_id ?? "");

  const existing = rows(
    await rest(
      cfg,
      "GET",
      `users?email=eq.${encodeURIComponent(email)}` +
        `&select=id,stripe_customer_id,account_kind&limit=1`,
    ),
  )[0];

  if (existing && existing.id !== provisionalId) {
    const existingId = String(existing.id);
    const hasCustomer = typeof existing.stripe_customer_id === "string" &&
      existing.stripe_customer_id.length > 0;
    if (hasCustomer && existing.stripe_customer_id !== stripeCustomerId) {
      // A different live Stripe customer already backs this account —
      // never overwrite payment identity from a webhook.
      return { kind: "existing_account_conflict", userId: existingId };
    }
    if (!hasCustomer && stripeCustomerId) {
      await rest(
        cfg,
        "PATCH",
        `users?id=eq.${encodeURIComponent(existingId)}`,
        { stripe_customer_id: stripeCustomerId },
      );
    }
    // The agent stays unclaimed: attaching a build to an existing account
    // requires that account's own session (sign in → claim).
    return { kind: "existing_account_linked", userId: existingId };
  }

  // Fresh email: the provisional shell becomes the account, id unchanged.
  await rest(
    cfg,
    "PATCH",
    `users?id=eq.${encodeURIComponent(provisionalId)}` +
      `&account_kind=eq.provisional`,
    {
      email,
      account_kind: "member",
      ...(stripeCustomerId ? { stripe_customer_id: stripeCustomerId } : {}),
    },
  );
  if (funnel.claimed_at === null || funnel.claimed_at === undefined) {
    await (options.claim ?? claimFunnelSession)({
      pairingCode,
      claimedBy: provisionalId,
    }, {
      supabaseUrl: cfg.supabaseUrl,
      serviceRoleKey: cfg.serviceRoleKey,
      fetchFn: cfg.fetchFn,
    });
  }
  return { kind: "promoted_and_claimed", userId: provisionalId };
}
