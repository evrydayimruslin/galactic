// Stripe Connect publisher verification (Phase 1 trust identity).
//
// The trust card's publisher_verified badge must NEVER be falsely green. So
// "verified" is STRICTER than "payouts_enabled": a seller is verified only when
// payouts are enabled AND the account is in good standing — no outstanding or
// overdue Connect requirements and no disabled_reason. The same predicate is
// computed in two places (the account.updated webhook and the reconcile cron)
// from this single helper so they can never drift.

import { getEnv } from "../lib/env.ts";
import { getAccountStatus } from "./stripe-connect.ts";

// Minimal shape needed to decide verification, satisfiable from either the raw
// Stripe Account object (webhook) or our normalized ConnectAccountStatus.
export interface ConnectVerificationInput {
  payouts_enabled?: boolean | null;
  currently_due?: string[] | null;
  past_due?: string[] | null;
  disabled_reason?: string | null;
}

export function computeConnectVerified(input: ConnectVerificationInput): boolean {
  if (input.payouts_enabled !== true) return false;
  if ((input.currently_due?.length ?? 0) > 0) return false;
  if ((input.past_due?.length ?? 0) > 0) return false;
  if (input.disabled_reason) return false;
  return true;
}

// From the raw Stripe Account object delivered on account.updated.
export function verifiedFromStripeAccount(account: {
  payouts_enabled?: boolean;
  requirements?: {
    currently_due?: string[] | null;
    past_due?: string[] | null;
    disabled_reason?: string | null;
  } | null;
}): boolean {
  return computeConnectVerified({
    payouts_enabled: account.payouts_enabled,
    currently_due: account.requirements?.currently_due,
    past_due: account.requirements?.past_due,
    disabled_reason: account.requirements?.disabled_reason,
  });
}

// How many candidate sellers a single reconcile pass refreshes (bounds the
// number of live Stripe calls per hour).
const RECONCILE_BATCH = 50;
// A connected seller whose snapshot is older than this is re-pulled from Stripe.
// The cron CADENCE is hourly, so a seller is refreshed on the first hourly tick
// after its snapshot crosses this threshold (effective per-seller refresh ~12-13h).
// This must stay comfortably below the read layer's 48h verification max-age so a
// legitimately verified seller never flaps to unverified between reconciles.
const RECONCILE_STALE_HOURS = 12;

interface ReconcileCandidate {
  id: string;
  stripe_connect_account_id: string;
}

export interface ConnectReconcileResult {
  scanned: number;
  updated: number;
  errors: number;
}

// Hourly backstop: Stripe only emits account.updated on a change, so a seller
// who was verified once and then has payouts disabled (fraud, dispute spike,
// KYC re-review) might never get a fresh webhook. This re-pulls the live Connect
// status for connected sellers whose snapshot has gone stale and rewrites the
// derived signals — the freshness the time-bounded badge check depends on.
export async function reconcileConnectVerification(): Promise<ConnectReconcileResult> {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const result: ConnectReconcileResult = { scanned: 0, updated: 0, errors: 0 };
  if (!url || !key) return result;

  const staleBefore = new Date(
    Date.now() - RECONCILE_STALE_HOURS * 60 * 60 * 1000,
  ).toISOString();

  let candidates: ReconcileCandidate[] = [];
  try {
    // Oldest (and never-synced) first, so under a backlog larger than one batch
    // no seller is perpetually starved — the stalest are always refreshed next.
    const query =
      `stripe_connect_account_id=not.is.null` +
      `&or=(stripe_connect_synced_at.is.null,stripe_connect_synced_at.lt.${staleBefore})` +
      `&order=stripe_connect_synced_at.asc.nullsfirst` +
      `&select=id,stripe_connect_account_id&limit=${RECONCILE_BATCH}`;
    const res = await fetch(`${url}/rest/v1/users?${query}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.warn("[CONNECT-RECONCILE] candidate query failed", {
        status: res.status,
      });
      return result;
    }
    candidates = await res.json() as ReconcileCandidate[];
  } catch (err) {
    console.warn("[CONNECT-RECONCILE] candidate query error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  result.scanned = candidates.length;

  for (const candidate of candidates) {
    if (!candidate.stripe_connect_account_id) continue;
    try {
      const status = await getAccountStatus(candidate.stripe_connect_account_id);
      const verified = computeConnectVerified({
        payouts_enabled: status.payouts_enabled,
        currently_due: status.requirements_currently_due,
        past_due: status.requirements_past_due,
        disabled_reason: status.requirements_disabled_reason,
      });
      const patch = await fetch(
        `${url}/rest/v1/users?id=eq.${candidate.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            stripe_connect_payouts_enabled: status.payouts_enabled === true,
            stripe_connect_onboarded: status.details_submitted === true,
            stripe_connect_verified: verified,
            stripe_connect_synced_at: new Date().toISOString(),
          }),
        },
      );
      if (!patch.ok) {
        result.errors++;
        console.warn("[CONNECT-RECONCILE] write failed", {
          user_id: candidate.id,
          status: patch.status,
        });
        continue;
      }
      result.updated++;
    } catch (err) {
      result.errors++;
      console.warn("[CONNECT-RECONCILE] account refresh error", {
        user_id: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
