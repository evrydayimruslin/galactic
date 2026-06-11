// Codemode cross-app access filter (Phase 4c / P5).
//
// ul.codemode invokes the user's owned + installed app functions IN-PROCESS,
// skipping the per-call authorization the normal /mcp/:appId path applies. The
// recipe is user-authored, so codemode is the user orchestrating their OWN
// library — owned and currently-accessible apps stay freely callable. But the
// in-process path must not let a stale cached index call a NON-owned PRIVATE
// app the user no longer holds a permission for (a revoked share), nor a
// function the user explicitly set the connected-agent policy to "never".
//
// Scope note: codemode deliberately does NOT apply the default-"ask"
// connected-agent gate (that gate is for individual external MCP calls; codemode
// is recipe orchestration over the user's own library). Whether to tighten
// codemode to the full ask/never model is a product decision tracked in
// LAUNCH_FOLLOWUPS.

import { getEnv } from "../lib/env.ts";
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

async function getJson<T>(db: DbConfig, path: string): Promise<T[]> {
  try {
    const response = await fetch(`${db.baseUrl}${path}`, { headers: db.headers });
    if (!response.ok) return [];
    const rows = await response.json().catch(() => []);
    return Array.isArray(rows) ? rows as T[] : [];
  } catch {
    return [];
  }
}

// Drop toolMap entries the user is no longer authorized to call in-process.
// Fails OPEN on a DB outage (returns the map unchanged) so codemode degrades to
// its prior behavior rather than breaking — availability over a best-effort
// tightening. The genuine access-control hole (non-owned private revocation) is
// closed when the store is reachable.
export async function filterCodemodeToolMapByAccess(
  userId: string,
  toolMap: Record<string, ToolMapping>,
): Promise<Record<string, ToolMapping>> {
  const db = getDbConfig();
  if (!db) return toolMap;

  const appIds = Array.from(
    new Set(Object.values(toolMap).map((t) => t.appId).filter(Boolean)),
  );
  if (appIds.length === 0) return toolMap;

  // App ownership + visibility for every referenced app.
  const apps = await getJson<{ id: string; owner_id: string; visibility: string }>(
    db,
    `/rest/v1/apps?id=in.(${appIds.join(",")})&select=id,owner_id,visibility`,
  );
  if (apps.length === 0) return toolMap; // fail open
  const appById = new Map(apps.map((a) => [a.id, a]));

  // Live private-app grants the user holds (non-owned private access).
  const grants = await getJson<{ app_id: string; function_name: string | null }>(
    db,
    `/rest/v1/user_app_permissions?granted_to_user_id=eq.${userId}&allowed=eq.true&select=app_id,function_name`,
  );
  const grantedAll = new Set<string>();
  const grantedFn = new Set<string>();
  for (const g of grants) {
    if (!g.function_name) grantedAll.add(g.app_id);
    else grantedFn.add(`${g.app_id}:${g.function_name}`);
  }

  // Functions the user explicitly set the connected-agent policy to "never".
  const nevers = await getJson<{ app_id: string; function_name: string }>(
    db,
    `/rest/v1/user_agent_function_permissions?user_id=eq.${userId}&policy=eq.never&select=app_id,function_name`,
  );
  const neverSet = new Set(nevers.map((n) => `${n.app_id}:${n.function_name}`));

  const filtered: Record<string, ToolMapping> = {};
  for (const [name, entry] of Object.entries(toolMap)) {
    const app = appById.get(entry.appId);
    if (!app) continue; // unknown/deleted app — drop
    if (neverSet.has(`${entry.appId}:${entry.fnName}`)) continue;

    if (app.owner_id === userId) {
      filtered[name] = entry; // own app — orchestrate freely
      continue;
    }
    if (app.visibility === "public" || app.visibility === "unlisted") {
      filtered[name] = entry; // inherently callable
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
