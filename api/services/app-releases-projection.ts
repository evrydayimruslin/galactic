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

interface FunctionPolicyReleaseSource {
  agentId: string;
  deploymentState: string | null | undefined;
  currentVersion: string | null | undefined;
  currentVersionPromotedAt: string | null | undefined;
  activeReleaseDigest: string | null | undefined;
}

interface FunctionPolicyReleaseAuthority {
  id: string;
  version: string;
  createdAt: string;
}

const EPOCH_TIMESTAMP = new Date(0).toISOString();
const SHA256_RE = /^[0-9a-f]{64}$/u;

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

/**
 * Policy CAS normally binds to the immutable app_releases row. Legacy Agents
 * predate that ledger, but still expose Policy Pillar controls. Bind those
 * controls to an opaque server-derived token over the live version and its
 * strongest available promotion fence. The declaration hash remains the
 * independent function-surface fence.
 */
export function resolveFunctionPolicyReleaseAuthority(
  releases: LaunchAgentReleaseSummary[],
  source: FunctionPolicyReleaseSource,
): FunctionPolicyReleaseAuthority | null {
  const immutable = releases[0];
  if (immutable) {
    return {
      id: immutable.id,
      version: immutable.version,
      createdAt: immutable.createdAt,
    };
  }
  if (source.deploymentState !== "legacy") return null;
  if (
    typeof source.agentId !== "string" || source.agentId.length === 0 ||
    typeof source.currentVersion !== "string" ||
    source.currentVersion.length === 0 ||
    source.currentVersion.trim() !== source.currentVersion
  ) {
    return null;
  }
  const promotedAt = canonicalTimestamp(source.currentVersionPromotedAt);
  const digest = typeof source.activeReleaseDigest === "string" &&
      SHA256_RE.test(source.activeReleaseDigest)
    ? source.activeReleaseDigest
    : null;
  const promotionFence = digest ?? promotedAt ?? "version-only";
  return {
    id: [
      "legacy",
      encodeURIComponent(source.agentId),
      encodeURIComponent(source.currentVersion),
      encodeURIComponent(promotionFence),
    ].join(":"),
    version: source.currentVersion,
    createdAt: promotedAt ?? EPOCH_TIMESTAMP,
  };
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
