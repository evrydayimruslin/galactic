import { getEnv } from "../lib/env.ts";
import type { LaunchAgentReleaseSummary } from "../../shared/contracts/launch.ts";

// WO-4 (docs/AGENT_STUDIO_LAUNCH_WORK_ORDERS.md): read-only owner projection
// of the immutable app_releases ledger. app_releases is service-role-only;
// the explicit owner_id filter below IS the authorization (precedent:
// operator-run-inspection). Nothing here mutates — the table's own trigger
// rejects UPDATE/DELETE regardless.

const RELEASE_LIST_LIMIT = 50;

interface AppReleaseRow {
  id: string;
  version: string;
  release_generation: number;
  storage_bytes: number;
  created_at: string;
}

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

export async function listAgentReleases(
  userId: string,
  appId: string,
): Promise<LaunchAgentReleaseSummary[]> {
  const res = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/app_releases` +
      `?app_id=eq.${encodeURIComponent(appId)}` +
      `&owner_id=eq.${encodeURIComponent(userId)}` +
      `&select=id,version,release_generation,storage_bytes,created_at` +
      `&order=release_generation.desc&limit=${RELEASE_LIST_LIMIT}`,
    { headers: supabaseHeaders() },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to list agent releases: ${err}`);
  }
  const rows = await res.json() as AppReleaseRow[];
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    releaseGeneration: row.release_generation,
    storageBytes: row.storage_bytes,
    createdAt: row.created_at,
  }));
}
