// Honest trust-card signals — the three live signals that must be gathered for a
// single-agent detail surface (the website agent page AND gx.discover inspect) so
// both report REAL runtime integrity, health, and publisher verification instead
// of the base builder's optimistic defaults (unknown / no_data / unverified).
//
// Extracted so the website and the MCP inspect path share ONE implementation:
// previously only the website gathered them, and MCP's trust card silently
// defaulted all three — advertising a verified-looking card it hadn't checked.
//
// Cost note: this pays one KV read (executed integrity) + one REST read
// (publisher) + the health map lookup. It is intended ONLY for single-agent
// detail surfaces, never the cheap fan-out card used in search/appstore results.

import { getEnv } from "../lib/env.ts";
import { emptyHealth, getAppHealth } from "./app-health.ts";
import { resolveExecutedIntegrity } from "./executed-bundle.ts";

interface DbConfig {
  baseUrl: string;
  headers: Record<string, string>;
}

function getDbConfig(): DbConfig | null {
  const baseUrl = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !key) return null;
  return {
    baseUrl,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

async function dbGet<T>(
  db: DbConfig,
  table: string,
  params: Record<string, string>,
): Promise<T[]> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${db.baseUrl}/rest/v1/${table}?${query}`, {
    headers: db.headers,
  });
  if (!response.ok) {
    throw new Error(`Failed to read ${table}: ${response.status}`);
  }
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? payload as T[] : [];
}

// A verified snapshot older than this is treated as unverified (fail closed).
// The reconcile cron refreshes sellers well inside this window; if it stalls,
// badges degrade to unverified rather than stranding a stale "verified".
const PUBLISHER_VERIFIED_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * publisher_verified := the owner's Stripe Connect account is payable AND in
 * good standing (strict stripe_connect_verified, distilled by the webhook +
 * reconcile cron) AND that signal is fresh. Reads persisted columns, never the
 * live Stripe API. Every failure direction resolves to false (unverified).
 */
export async function isPublisherVerified(
  ownerId: string | null | undefined,
): Promise<boolean> {
  if (!ownerId) return false;
  try {
    const db = getDbConfig();
    if (!db) return false;
    const rows = await dbGet<{
      stripe_connect_verified: boolean | null;
      stripe_connect_synced_at: string | null;
    }>(db, "users", {
      id: `eq.${ownerId}`,
      select: "stripe_connect_verified,stripe_connect_synced_at",
      limit: "1",
    });
    const row = rows[0];
    if (row?.stripe_connect_verified !== true) return false;
    const syncedAt = row.stripe_connect_synced_at
      ? Date.parse(row.stripe_connect_synced_at)
      : NaN;
    if (!Number.isFinite(syncedAt)) return false;
    return Date.now() - syncedAt <= PUBLISHER_VERIFIED_MAX_AGE_MS;
  } catch (err) {
    console.warn("[trust-signals] publisher_verified lookup failed:", err);
    return false;
  }
}

/**
 * Gather the three honest trust signals for one agent, in parallel. Spread the
 * result straight into buildAppTrustCard's options so the card reports what was
 * actually checked.
 */
export async function resolveTrustSignals(
  app: { id: string; owner_id: string | null | undefined },
) {
  const [publisher_verified, healthMap, executed_integrity] = await Promise.all([
    isPublisherVerified(app.owner_id),
    getAppHealth([app.id]),
    resolveExecutedIntegrity(app.id),
  ]);
  return {
    publisher_verified,
    health: healthMap.get(app.id) ?? emptyHealth(),
    executed_integrity,
  };
}
