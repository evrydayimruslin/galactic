// App health windows (Phase 1 trust signal).
//
// Reads the app_health_windows materialized view (paid, non-self call success
// over 1h/24h/7d/30d) and derives a BINARY green/red verdict per window —
// "no_data" when a window has too few paid calls to judge (no yellow). The
// view is refreshed by cron via refreshAppHealthView().

import { getEnv } from "../lib/env.ts";
import type { HealthStatus, HealthWindows } from "../../shared/types/index.ts";

// Tunable without a view re-refresh (the verdict is derived here, not stored).
const MIN_CALLS = 5; // below this in a window => "no_data", never red
const HEALTHY_THRESHOLD = 0.95; // success rate at/above this => green
// A window needs at least this many DISTINCT non-owner paying identities before
// it can be green. A publisher can route paid calls from one sock-puppet account
// (different user_id, so the owner-self exclusion misses it) to fake a track
// record; requiring >= 2 distinct payers defeats the single-second-account case.
// Determined multi-account sybil remains a documented residual that the
// independent post-call-flag signal (Phase 3) + ranking (Phase 4) further blunt.
const MIN_DISTINCT_PAYERS = 2;

export function emptyHealth(): HealthWindows {
  return { "1h": "no_data", "24h": "no_data", "7d": "no_data", "30d": "no_data" };
}

// "Recently healthy" for a pre-call gate: the freshest window with a verdict is
// green. A now-broken Agent (24h red) is NOT healthy even on a stale 7d green;
// no_data (unproven) is NOT healthy either — both fail the gate so the call asks.
export function isRecentlyHealthy(h: HealthWindows): boolean {
  if (h["24h"] === "green") return true;
  if (h["24h"] === "red") return false;
  if (h["7d"] === "green") return true;
  return false;
}

function deriveStatus(calls: number, ok: number, payers: number): HealthStatus {
  const c = Number(calls);
  const o = Number(ok);
  const p = Number(payers);
  // Too little independent evidence to judge => withhold a verdict (never red).
  if (!Number.isFinite(c) || c < MIN_CALLS) return "no_data";
  if (!Number.isFinite(p) || p < MIN_DISTINCT_PAYERS) return "no_data";
  return o / c >= HEALTHY_THRESHOLD ? "green" : "red";
}

interface HealthRow {
  app_id: string;
  calls_1h: number;
  ok_1h: number;
  payers_1h: number;
  calls_24h: number;
  ok_24h: number;
  payers_24h: number;
  calls_7d: number;
  ok_7d: number;
  payers_7d: number;
  calls_30d: number;
  ok_30d: number;
  payers_30d: number;
}

function rowToWindows(r: HealthRow): HealthWindows {
  return {
    "1h": deriveStatus(r.calls_1h, r.ok_1h, r.payers_1h),
    "24h": deriveStatus(r.calls_24h, r.ok_24h, r.payers_24h),
    "7d": deriveStatus(r.calls_7d, r.ok_7d, r.payers_7d),
    "30d": deriveStatus(r.calls_30d, r.ok_30d, r.payers_30d),
  };
}

// Test seam: pure derivation, exposed so the binary thresholds are covered
// without the database.
export function deriveHealthWindows(
  row: Omit<HealthRow, "app_id">,
): HealthWindows {
  return rowToWindows({ app_id: "", ...row });
}

// Batch health for many apps in ONE query (discovery fan-out friendly). Apps
// absent from the view (no qualifying paid calls) are simply not in the map —
// the caller defaults them to emptyHealth().
export async function getAppHealth(
  appIds: string[],
): Promise<Map<string, HealthWindows>> {
  const out = new Map<string, HealthWindows>();
  const unique = [...new Set(appIds.filter(Boolean))];
  if (unique.length === 0) return out;

  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return out;

  try {
    const ids = unique.map((id) => encodeURIComponent(id)).join(",");
    const res = await fetch(
      `${url}/rest/v1/app_health_windows?app_id=in.(${ids})&select=*`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return out;
    const rows = await res.json() as HealthRow[];
    for (const row of rows) {
      if (row?.app_id) out.set(row.app_id, rowToWindows(row));
    }
  } catch {
    // Best-effort: an absent/erroring health view degrades to no_data, never
    // blocks the card.
  }
  return out;
}

// Cron entry point — refresh the materialized view (CONCURRENTLY via the RPC).
export async function refreshAppHealthView(): Promise<void> {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/refresh_app_health`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (!res.ok) {
      console.warn("[APP-HEALTH] refresh failed", {
        status: res.status,
        detail: await res.text().catch(() => res.statusText),
      });
    }
  } catch (err) {
    console.warn("[APP-HEALTH] refresh error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
