// Codemode cross-app access filter (Phase 4c / P5).
//
// ul.codemode invokes the user's owned + installed app functions IN-PROCESS,
// skipping the per-call authorization the normal /mcp/:appId path applies. The
// recipe is user-authored, so codemode is the user orchestrating their OWN
// library — owned apps stay freely callable. But the in-process path must not
// let a stale cached index call a NON-owned PRIVATE app the user no longer holds
// a permission for (a revoked share), nor a function the user explicitly set the
// connected-agent policy to "never".
//
// Health overlay (parity with the direct gx.call gate): a codemode recipe runs
// non-interactively, so it cannot "ask". For NON-owned apps we therefore apply
// the same protection the gate gives an "always" policy — auto-call only a
// recently-healthy target. A non-owned app that is red or unproven (no_data) is
// DROPPED rather than silently auto-called inside a recipe. Owned apps are exempt
// (it's the user's own code).
//
// Fail CLOSED: if the authorization store can't be read (apps/visibility or the
// "never" prohibition list), we cannot safely decide what may be called, so we
// drop everything instead of returning the map unchanged. (A store that is not
// configured at all — local/test — is the one exception: nothing to authorize
// against, so the map passes through.)

import { getEnv } from "../lib/env.ts";
import { emptyHealth, getAppHealth, isRecentlyHealthy } from "./app-health.ts";
import type { ToolMapping } from "./codemode-tools.ts";

interface DbConfig {
  baseUrl: string;
  headers: HeadersInit;
}

function getDbConfig(): DbConfig | null {
  const baseUrl = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !key) return null;
  return { baseUrl, headers: { apikey: key, Authorization: `Bearer ${key}` } };
}

// Returns the rows, or null on a HARD failure (network error / non-2xx / bad
// body). Null is distinct from an empty array so callers can fail closed on a
// store outage instead of mistaking it for "no rows".
async function getRows<T>(db: DbConfig, path: string): Promise<T[] | null> {
  try {
    const response = await fetch(`${db.baseUrl}${path}`, { headers: db.headers });
    if (!response.ok) return null;
    const rows = await response.json().catch(() => null);
    if (rows === null) return null;
    return Array.isArray(rows) ? rows as T[] : [];
  } catch {
    return null;
  }
}

// Drop toolMap entries the user is not authorized to (or should not silently)
// call in-process. Fails CLOSED on a store outage (see file header): owned apps
// stay callable; non-owned apps must be reachable in the store, not "never",
// recently healthy, and (if private) currently granted.
export async function filterCodemodeToolMapByAccess(
  userId: string,
  toolMap: Record<string, ToolMapping>,
): Promise<Record<string, ToolMapping>> {
  const db = getDbConfig();
  // No store configured at all (local/test) — nothing to authorize against.
  if (!db) return toolMap;

  const appIds = Array.from(
    new Set(Object.values(toolMap).map((t) => t.appId).filter(Boolean)),
  );
  if (appIds.length === 0) return toolMap;

  // App ownership + visibility — the authorization spine. If it can't be read we
  // cannot decide anything safely: fail closed (drop all).
  const apps = await getRows<{ id: string; owner_id: string; visibility: string }>(
    db,
    `/rest/v1/apps?id=in.(${appIds.join(",")})&select=id,owner_id,visibility`,
  );
  if (apps === null) {
    console.error(
      "[CODEMODE-ACCESS] app authorization lookup failed — failing closed (dropping all tools)",
    );
    return {};
  }
  const appById = new Map(apps.map((a) => [a.id, a]));

  // Explicit "never" prohibitions. If this list can't be read we cannot
  // guarantee we are honoring the user's explicit blocks — fail closed (drop all).
  const nevers = await getRows<{ app_id: string; function_name: string }>(
    db,
    `/rest/v1/user_agent_function_permissions?user_id=eq.${userId}&policy=eq.never&select=app_id,function_name`,
  );
  if (nevers === null) {
    console.error(
      "[CODEMODE-ACCESS] 'never' prohibition lookup failed — failing closed (dropping all tools)",
    );
    return {};
  }
  const neverSet = new Set(nevers.map((n) => `${n.app_id}:${n.function_name}`));

  // Live private-app grants. A null here only governs non-owned-PRIVATE access;
  // treat it as "no grants" so those entries fail closed, while owned/public are
  // unaffected (they don't depend on grants).
  const grants = await getRows<{ app_id: string; function_name: string | null }>(
    db,
    `/rest/v1/user_app_permissions?granted_to_user_id=eq.${userId}&allowed=eq.true&select=app_id,function_name`,
  );
  const grantedAll = new Set<string>();
  const grantedFn = new Set<string>();
  for (const g of grants ?? []) {
    if (!g.function_name) grantedAll.add(g.app_id);
    else grantedFn.add(`${g.app_id}:${g.function_name}`);
  }

  // Health overlay applies to NON-owned apps only. Batch one health read for
  // them; getAppHealth degrades to no_data on outage, so an unreadable health
  // view fails closed (non-owned drop) rather than auto-allowing.
  const nonOwnedAppIds = appIds.filter((id) => appById.get(id)?.owner_id !== userId);
  const healthByApp = nonOwnedAppIds.length > 0
    ? await getAppHealth(nonOwnedAppIds)
    : new Map();

  const filtered: Record<string, ToolMapping> = {};
  for (const [name, entry] of Object.entries(toolMap)) {
    const app = appById.get(entry.appId);
    if (!app) continue; // unknown/deleted app — drop
    if (neverSet.has(`${entry.appId}:${entry.fnName}`)) continue;

    if (app.owner_id === userId) {
      filtered[name] = entry; // own app — orchestrate freely
      continue;
    }

    // Non-owned: don't auto-call an unproven/unhealthy Agent inside a recipe.
    if (!isRecentlyHealthy(healthByApp.get(entry.appId) ?? emptyHealth())) {
      continue;
    }

    if (app.visibility === "public" || app.visibility === "unlisted") {
      filtered[name] = entry; // inherently callable + healthy
      continue;
    }
    // Non-owned private: require a live grant for this function (or all).
    if (
      grantedAll.has(entry.appId) ||
      grantedFn.has(`${entry.appId}:${entry.fnName}`)
    ) {
      filtered[name] = entry;
    }
  }
  return filtered;
}
