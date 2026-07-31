// Codemode cross-app access filter (Phase 4c / P5).
//
// ul.codemode invokes the user's owned + installed app functions IN-PROCESS,
// skipping the per-call authorization the normal /mcp/:appId path applies. The
// recipe is user-authored, so codemode is the user orchestrating their OWN
// library — but ownership is not deployment authority. The in-process path
// must not let a stale cached index execute an owned Agent before setup, while
// materializing, after suspension, or from an unknown lifecycle state. It must
// also not call a NON-owned PRIVATE app the user no longer holds a permission
// for (a revoked share), nor a function the user explicitly set the
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
import { resolveFunctionStrictManifestPermissions } from "./app-runtime-resources.ts";
import { assertAppDeploymentRunnable } from "./app-deployment-lifecycle.ts";
import { emptyHealth, getAppHealth, isRecentlyHealthy } from "./app-health.ts";
import type { ToolMapping } from "./codemode-tools.ts";
import type { GalacticStableEffectId } from "./galactic-agent-document.ts";

interface DbConfig {
  baseUrl: string;
  headers: HeadersInit;
}

interface CodemodeAppRow {
  id: string;
  owner_id: string;
  visibility: string;
  deployment_state?: unknown;
  hosting_suspended?: unknown;
  current_version?: unknown;
  active_release_digest?: unknown;
  manifest?: unknown;
}

interface CodemodeReleaseBinding {
  deploymentState: "legacy" | "ready";
  version: string | null;
  releaseDigest: string | null;
}

/**
 * Host-authored capability ceiling for one exact codemode function.
 *
 * These booleans are deliberately per tool-map entry, not per Agent. Two
 * functions in one Agent may have different authority declarations; sharing
 * an app-wide union would let the less-privileged function borrow the other's
 * storage or database powers.
 */
export interface CodemodeFunctionAuthority {
  databaseRead: boolean;
  databaseWrite: boolean;
  storageRead: boolean;
  storageWrite: boolean;
  storageDelete: boolean;
}

interface CodemodeAccessResult {
  toolMap: Record<string, ToolMapping>;
  releases: Record<string, CodemodeReleaseBinding>;
  authorities: Record<string, CodemodeFunctionAuthority>;
}

const DENIED_FUNCTION_AUTHORITY: CodemodeFunctionAuthority = {
  databaseRead: false,
  databaseWrite: false,
  storageRead: false,
  storageWrite: false,
  storageDelete: false,
};

function functionAuthority(
  app: CodemodeAppRow,
  functionName: string,
): CodemodeFunctionAuthority {
  const manifest = typeof app.manifest === "string"
    ? app.manifest
    : app.manifest && typeof app.manifest === "object"
    ? JSON.stringify(app.manifest)
    : null;
  const resolution = resolveFunctionStrictManifestPermissions(
    { manifest },
    functionName,
  );
  if (!resolution.manifestBacked) return { ...DENIED_FUNCTION_AUTHORITY };

  const effects = resolution.declaredEffects === null
    ? null
    : new Set(resolution.declaredEffects);
  const permissions = new Set(resolution.permissions);
  const declares = (effect: GalacticStableEffectId): boolean =>
    effects === null || effects.has(effect);

  return {
    databaseRead: declares("database.read"),
    databaseWrite: declares("database.write"),
    storageRead: declares("storage.read") &&
      permissions.has("storage:read"),
    storageWrite: declares("storage.write") &&
      permissions.has("storage:write"),
    storageDelete: declares("storage.delete") &&
      permissions.has("storage:delete"),
  };
}

function isLocalOrTestEnvironment(): boolean {
  const environment = getEnv("ENVIRONMENT").trim().toLowerCase();
  return environment === "local" || environment === "development" ||
    environment === "dev" || environment === "test";
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
    const response = await fetch(`${db.baseUrl}${path}`, {
      headers: db.headers,
    });
    if (!response.ok) return null;
    const rows = await response.json().catch(() => null);
    if (rows === null) return null;
    return Array.isArray(rows) ? rows as T[] : [];
  } catch {
    return null;
  }
}

function isCodemodeRunnable(app: CodemodeAppRow): boolean {
  // The deployment migration makes hosting_suspended non-null. Requiring an
  // exact false here means incomplete or stale projections fail closed too.
  if (app.hosting_suspended !== false) return false;
  try {
    assertAppDeploymentRunnable(app);
    return app.deployment_state === "legacy" ||
      (
        app.deployment_state === "ready" &&
        typeof app.current_version === "string" &&
        app.current_version.length > 0 &&
        typeof app.active_release_digest === "string" &&
        /^[a-f0-9]{64}$/.test(app.active_release_digest)
      );
  } catch {
    return false;
  }
}

function releaseBinding(app: CodemodeAppRow): CodemodeReleaseBinding {
  return app.deployment_state === "ready"
    ? {
      deploymentState: "ready",
      version: app.current_version as string,
      releaseDigest: app.active_release_digest as string,
    }
    : { deploymentState: "legacy", version: null, releaseDigest: null };
}

// Drop toolMap entries the user is not authorized to (or should not silently)
// call in-process. Fails CLOSED on a store outage (see file header): owned apps
// must also be in a runnable deployment lifecycle; non-owned apps must be
// runnable, reachable in the store, not "never", recently healthy, and (if
// private) currently granted.
export async function authorizeCodemodeToolMapByAccess(
  userId: string,
  toolMap: Record<string, ToolMapping>,
): Promise<CodemodeAccessResult> {
  const db = getDbConfig();
  // A deliberately local/test runtime may have no authoritative store. Any
  // deployed or unclassified environment must fail closed: missing Supabase
  // configuration in production/staging is an outage, not permission to treat
  // every cached Agent as a legacy executable.
  if (!db) {
    if (!isLocalOrTestEnvironment()) {
      console.error(
        "[CODEMODE-ACCESS] authorization store is not configured outside an explicit local/test environment — failing closed",
      );
      return { toolMap: {}, releases: {}, authorities: {} };
    }
    return {
      toolMap,
      releases: Object.fromEntries(
        Array.from(
          new Set(Object.values(toolMap).map((entry) => entry.appId)),
        ).map((appId) => [
          appId,
          {
            deploymentState: "legacy",
            version: null,
            releaseDigest: null,
          } satisfies CodemodeReleaseBinding,
        ]),
      ),
      // Without the authoritative manifest store there is no trustworthy
      // function-level declaration to compile. Pure functions still work in
      // local/test environments, but every stateful binding fails closed.
      authorities: Object.fromEntries(
        Object.keys(toolMap).map((name) => [
          name,
          { ...DENIED_FUNCTION_AUTHORITY },
        ]),
      ),
    };
  }

  const appIds = Array.from(
    new Set(Object.values(toolMap).map((t) => t.appId).filter(Boolean)),
  );
  if (appIds.length === 0) {
    return { toolMap, releases: {}, authorities: {} };
  }

  // App ownership + visibility — the authorization spine. If it can't be read we
  // cannot decide anything safely: fail closed (drop all).
  const apps = await getRows<CodemodeAppRow>(
    db,
    `/rest/v1/apps?id=in.(${
      appIds.join(",")
    })&select=id,owner_id,visibility,deployment_state,hosting_suspended,current_version,active_release_digest,manifest`,
  );
  if (apps === null) {
    console.error(
      "[CODEMODE-ACCESS] app authorization lookup failed — failing closed (dropping all tools)",
    );
    return { toolMap: {}, releases: {}, authorities: {} };
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
    return { toolMap: {}, releases: {}, authorities: {} };
  }
  const neverSet = new Set(nevers.map((n) => `${n.app_id}:${n.function_name}`));

  // Live private-app grants. A null here only governs non-owned-PRIVATE access;
  // treat it as "no grants" so those entries fail closed, while owned/public are
  // unaffected (they don't depend on grants).
  const grants = await getRows<
    { app_id: string; function_name: string | null }
  >(
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
  const nonOwnedAppIds = appIds.filter((id) =>
    appById.get(id)?.owner_id !== userId
  );
  const healthByApp = nonOwnedAppIds.length > 0
    ? await getAppHealth(nonOwnedAppIds)
    : new Map();

  const filtered: Record<string, ToolMapping> = {};
  const releases: Record<string, CodemodeReleaseBinding> = {};
  const authorities: Record<string, CodemodeFunctionAuthority> = {};
  const allow = (
    name: string,
    entry: ToolMapping,
    app: CodemodeAppRow,
  ): void => {
    filtered[name] = entry;
    releases[app.id] = releaseBinding(app);
    authorities[name] = functionAuthority(app, entry.fnName);
  };
  for (const [name, entry] of Object.entries(toolMap)) {
    const app = appById.get(entry.appId);
    if (!app) continue; // unknown/deleted app — drop
    if (!isCodemodeRunnable(app)) continue;
    if (neverSet.has(`${entry.appId}:${entry.fnName}`)) continue;

    if (app.owner_id === userId) {
      allow(name, entry, app); // own app — orchestrate freely
      continue;
    }

    // Non-owned: don't auto-call an unproven/unhealthy Agent inside a recipe.
    if (!isRecentlyHealthy(healthByApp.get(entry.appId) ?? emptyHealth())) {
      continue;
    }

    if (app.visibility === "public" || app.visibility === "unlisted") {
      allow(name, entry, app); // inherently callable + healthy
      continue;
    }
    // Non-owned private: require a live grant for this function (or all).
    if (
      grantedAll.has(entry.appId) ||
      grantedFn.has(`${entry.appId}:${entry.fnName}`)
    ) {
      allow(name, entry, app);
    }
  }
  return { toolMap: filtered, releases, authorities };
}

export async function filterCodemodeToolMapByAccess(
  userId: string,
  toolMap: Record<string, ToolMapping>,
): Promise<Record<string, ToolMapping>> {
  return (await authorizeCodemodeToolMapByAccess(userId, toolMap)).toolMap;
}
