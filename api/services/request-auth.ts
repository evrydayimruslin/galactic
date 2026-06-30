import { getEnv } from "../lib/env.ts";
import { getAuthAccessTokenFromRequest } from "./auth-cookies.ts";
import { toRawMcpFunctionName } from "./mcp-function-names.ts";
import { logLegacyPermissionNameCompatibility } from "./permission-name-telemetry.ts";
import {
  isRoutineActorToken,
  type RoutineActorTokenClaims,
  verifyRoutineActorToken,
} from "./routine-auth.ts";
import {
  isSandboxActorToken,
  verifySandboxActorToken,
} from "./sandbox-actor.ts";
import { getUserFromToken, isApiToken } from "./tokens.ts";

export type RequestTokenSourcePolicy = "bearer_only" | "bearer_or_cookie";
export type RequestAuthSource =
  | "supabase"
  | "api_token"
  | "routine_actor"
  | "sandbox_actor";

export interface VerifiedSupabaseUser {
  id: string;
  email: string;
  user_metadata?: Record<string, string>;
}

export interface AuthenticatedRequestUser {
  id: string;
  email: string;
  tier: string;
  authSource?: RequestAuthSource;
  provisional?: boolean;
  tokenId?: string;
  tokenAppIds?: string[] | null;
  tokenFunctionNames?: string[] | null;
  scopes?: string[];
  routineActor?: {
    tokenId: string;
    routineId: string;
    routineRunId: string;
    traceId?: string;
    composerAppId?: string;
    composerAppSlug?: string;
    handlerFunction?: string;
    budgetPolicy?: RoutineActorTokenClaims["budget_policy"];
    capabilities: RoutineActorTokenClaims["capabilities"];
  };
  user_metadata?: Record<string, string>;
}

export interface PendingPermissionRow {
  app_id: string;
  app_slug?: string;
  granted_by_user_id: string;
  function_name: string;
  allowed: boolean;
  allowed_args?: Record<string, unknown> | null;
}

export interface ResolvedPendingPermissionRow {
  app_id: string;
  granted_to_user_id: string;
  granted_by_user_id: string;
  function_name: string;
  allowed: boolean;
  allowed_args?: Record<string, unknown> | null;
}

export async function verifySupabaseAccessToken(
  token: string,
): Promise<VerifiedSupabaseUser | null> {
  const verifyResponse = await fetch(`${getEnv("SUPABASE_URL")}/auth/v1/user`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "apikey": getEnv("SUPABASE_ANON_KEY") ||
        getEnv("SUPABASE_SERVICE_ROLE_KEY"),
    },
  });

  if (!verifyResponse.ok) {
    return null;
  }

  const verifiedUser = await verifyResponse.json() as {
    id?: string;
    email?: string;
    user_metadata?: Record<string, string>;
  };
  if (!verifiedUser?.id || !verifiedUser?.email) {
    return null;
  }

  return {
    id: verifiedUser.id,
    email: verifiedUser.email,
    user_metadata: verifiedUser.user_metadata || {},
  };
}

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7).trim();
  if (!token || token === "null" || token === "undefined") {
    return null;
  }

  return token;
}

export function extractRequestAccessToken(
  request: Request,
  policy: RequestTokenSourcePolicy = "bearer_or_cookie",
): string | null {
  return extractBearerToken(request) ||
    (policy === "bearer_or_cookie"
      ? getAuthAccessTokenFromRequest(request)
      : null);
}

/**
 * Check if a set of scopes includes the required scope.
 * Wildcard '*' matches everything for backward compatibility.
 */
export function hasScope(
  scopes: string[] | undefined,
  required: string,
): boolean {
  if (!scopes) return true;
  return scopes.includes("*") || scopes.includes(required);
}

export async function authenticateRequest(
  request: Request,
  policy: RequestTokenSourcePolicy = "bearer_or_cookie",
): Promise<AuthenticatedRequestUser> {
  const token = extractRequestAccessToken(request, policy);
  if (!token) {
    throw new Error("Missing or invalid authorization header");
  }

  if (isRoutineActorToken(token)) {
    const verified = await verifyRoutineActorToken(token);
    if (!verified) {
      throw new Error("Invalid or expired routine actor token");
    }

    const { claims } = verified;
    return {
      id: claims.user_id,
      email: claims.user_email,
      tier: claims.user_tier || "free",
      authSource: "routine_actor",
      provisional: claims.provisional,
      tokenId: claims.jti,
      tokenAppIds: claims.app_ids,
      tokenFunctionNames: claims.function_names,
      scopes: claims.scopes,
      routineActor: {
        tokenId: claims.jti,
        routineId: claims.routine_id,
        routineRunId: claims.routine_run_id,
        ...(claims.trace_id ? { traceId: claims.trace_id } : {}),
        ...(claims.composer_app_id
          ? { composerAppId: claims.composer_app_id }
          : {}),
        ...(claims.composer_app_slug
          ? { composerAppSlug: claims.composer_app_slug }
          : {}),
        ...(claims.handler_function
          ? { handlerFunction: claims.handler_function }
          : {}),
        ...(claims.budget_policy
          ? { budgetPolicy: claims.budget_policy }
          : {}),
        capabilities: claims.capabilities,
      },
    };
  }

  if (isSandboxActorToken(token)) {
    const verified = await verifySandboxActorToken(token);
    if (!verified) {
      throw new Error("Invalid or expired sandbox actor token");
    }
    const { claims } = verified;
    return {
      id: claims.user_id,
      email: claims.user_email,
      tier: claims.user_tier || "free",
      authSource: "sandbox_actor",
      provisional: claims.provisional,
      tokenId: claims.jti,
      // ['*'] => unrestricted; otherwise the executing app + its declared deps.
      tokenAppIds: claims.app_ids,
      tokenFunctionNames: claims.function_names,
      scopes: claims.scopes,
    };
  }

  if (isApiToken(token)) {
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      undefined;

    const user = await getUserFromToken(token, clientIp);
    if (!user) {
      throw new Error("Invalid or expired API token");
    }

    return { ...user, authSource: "api_token" };
  }

  const user = await verifySupabaseAccessToken(token);
  if (!user) {
    throw new Error("Invalid or expired token");
  }

  if (!user.id || !user.email) {
    throw new Error("Invalid token payload");
  }

  const resolvedTier = await resolveTierProvisioningIfMissing(user);

  return {
    id: user.id,
    email: user.email,
    tier: resolvedTier,
    authSource: "supabase",
    user_metadata: user.user_metadata,
  };
}

/**
 * One read for the steady state: fetch the user's tier; only when the row is
 * MISSING (first-ever request) run the full first-contact provisioning
 * (ensureUserExists: insert + pending-permission resolution + default apps).
 * This replaced a 3-RT-per-request chain (existence check + per-request
 * pending-permissions sweep + separate tier read) — pending invites are only
 * ever created for not-yet-registered emails, and the session-exchange
 * endpoints still run ensureUserExists at session establishment as a
 * backstop.
 */
async function resolveTierProvisioningIfMissing(
  user: {
    id: string;
    email: string;
    user_metadata?: { name?: string; avatar_url?: string; full_name?: string };
  },
): Promise<string> {
  try {
    const res = await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/users?id=eq.${user.id}&select=id,tier`,
      {
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
      },
    );
    if (res.ok) {
      const rows = await res.json() as Array<
        { id: string; tier?: string | null }
      >;
      if (Array.isArray(rows) && rows[0]) {
        return rows[0].tier || "free";
      }
    }
    // !res.ok falls through: a degraded read must not skip first-contact
    // provisioning (ensureUserExists is idempotent for existing users).
  } catch {
    return "free";
  }

  // Row absent (first contact) or read degraded: provision the account
  // (insert if missing, pending permission resolution, default apps), then
  // default tier — matching the pre-merge behavior where provisioning ran
  // unconditionally.
  await ensureUserExists(user).catch((err) => {
    console.warn("[AUTH] First-contact provisioning failed:", err);
  });
  return "free";
}

export async function ensureUserExists(
  authUser: {
    id: string;
    email: string;
    user_metadata?: { name?: string; avatar_url?: string; full_name?: string };
  },
): Promise<void> {
  const displayName = authUser.user_metadata?.full_name ||
    authUser.user_metadata?.name || authUser.email.split("@")[0];

  const payload: Record<string, unknown> = {
    id: authUser.id,
    email: authUser.email,
  };

  const checkResponse = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/users?id=eq.${authUser.id}&select=id`,
    {
      headers: {
        "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
        "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
    },
  );

  const existingUsers = await checkResponse.json();

  if (Array.isArray(existingUsers) && existingUsers.length > 0) {
    await resolvePendingPermissions(authUser.id, authUser.email);
    return;
  }

  const insertResponse = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/users`,
    {
      method: "POST",
      headers: {
        "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
        "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );

  if (!insertResponse.ok) {
    const errorText = await insertResponse.text();
    if (errorText.includes("duplicate") || errorText.includes("23505")) {
      return;
    }
    throw new Error("Failed to create user record");
  }

  await resolvePendingPermissions(authUser.id, authUser.email);
  provisionDefaultApps(authUser.id).catch((err) =>
    console.error("[AUTH] Failed to provision default apps:", err)
  );
}

interface DefaultRef {
  app_id: string;
  badge?: string | null;
}

// Resolve the platform's pre-install default set from the private "Defaults
// Manager" Agent named by DEFAULTS_SOURCE_APP. That Agent stores the list in its
// OWN app-data (via ultralight.store('defaults', ...)); we read it here with the
// service role. This is the ONLY coupling to it — no special auth, no platform-
// owner identity, no admin credential: the Agent's functions are owner-only
// simply because the Agent is private. Returns [] (=> no seeding) when the
// pointer is unset, the Agent is missing, or the list is empty/unreadable.
async function readSourceDefaults(): Promise<DefaultRef[]> {
  const slug = getEnv("DEFAULTS_SOURCE_APP").trim();
  if (!slug) return [];
  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  // The source Agent's app-data is keyed by (app id, owner id) — resolve both.
  const appRes = await fetch(
    `${supabaseUrl}/rest/v1/apps?slug=eq.${encodeURIComponent(slug)}` +
      `&deleted_at=is.null&select=id,owner_id&limit=1`,
    { headers },
  );
  if (!appRes.ok) return [];
  const app =
    (await appRes.json() as Array<{ id: string; owner_id: string }>)[0];
  if (!app?.id || !app?.owner_id) return [];
  // Read the Agent's stored list straight from R2 (the same object
  // ultralight.store writes: apps/{appId}/users/{ownerId}/data/defaults.json).
  try {
    const obj = await getEnv().R2_BUCKET.get(
      `apps/${app.id}/users/${app.owner_id}/data/defaults.json`,
    );
    if (!obj) return [];
    const parsed = JSON.parse(await obj.text());
    const list = (parsed?.value ?? parsed) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .map((item): DefaultRef | null => {
        if (typeof item === "string") return { app_id: item };
        if (
          item && typeof item === "object" &&
          typeof (item as { app_id?: unknown }).app_id === "string"
        ) {
          const ref = item as { app_id: string; badge?: string | null };
          return { app_id: ref.app_id, badge: ref.badge ?? null };
        }
        return null;
      })
      .filter((x): x is DefaultRef => !!x && !!x.app_id.trim());
  } catch {
    return [];
  }
}

// Seed a brand-new account's library from the pre-install defaults the owner
// curates via their private Defaults Manager Agent (see readSourceDefaults).
// FORWARD-ONLY: runs once, at account creation (see ensureUserExists), and only
// ever writes the NEW user's rows. Validates each Agent is still live +
// installable before seeding it. `deps.readSourceDefaults` is injectable for
// tests so the seeding logic can be exercised without R2.
export async function provisionDefaultApps(
  userId: string,
  deps: { readSourceDefaults?: () => Promise<DefaultRef[]> } = {},
): Promise<void> {
  const refs = await (deps.readSourceDefaults ?? readSourceDefaults)();
  const appIds = Array.from(
    new Set(refs.map((r) => r.app_id.trim()).filter(Boolean)),
  );
  if (appIds.length === 0) return;

  const supabaseUrl = getEnv("SUPABASE_URL");
  const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  // Validate each is still a live, installable (public/unlisted) Agent. Guards
  // against a default pointing at an app unpublished or deleted after it was
  // added — seeding a private/deleted app would drop an unusable row into the
  // new user's library.
  const appsRes = await fetch(
    `${supabaseUrl}/rest/v1/apps` +
      `?id=in.(${appIds.join(",")})` +
      `&deleted_at=is.null&visibility=in.(public,unlisted)&select=id`,
    { headers },
  );
  if (!appsRes.ok) return;
  const liveApps = await appsRes.json() as Array<{ id: string }>;
  const liveIds = new Set(liveApps.map((a) => a.id));
  const seedIds = appIds.filter((id) => liveIds.has(id));
  if (seedIds.length === 0) return;

  // One batched, idempotent upsert into the user's library. source='default'.
  // No app_likes write — likes are earned, not seeded.
  const rows = seedIds.map((appId) => ({
    user_id: userId,
    app_id: appId,
    source: "default",
  }));
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/user_app_library`, {
    method: "POST",
    headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!insertRes.ok) {
    console.error(
      "[AUTH] Default-app seeding upsert failed:",
      insertRes.status,
      (await insertRes.text()).slice(0, 200),
    );
  }
}

export function resolvePendingPermissionRows(
  pendingRows: PendingPermissionRow[],
  userId: string,
  appSlugsById: Record<string, string> = {},
): ResolvedPendingPermissionRow[] {
  return pendingRows.map((pending) => {
    const appSlug = pending.app_slug || appSlugsById[pending.app_id];

    return {
      app_id: pending.app_id,
      granted_to_user_id: userId,
      granted_by_user_id: pending.granted_by_user_id,
      function_name: appSlug
        ? toRawMcpFunctionName(appSlug, pending.function_name)
        : pending.function_name,
      allowed: pending.allowed,
      ...(pending.allowed_args !== undefined
        ? { allowed_args: pending.allowed_args }
        : {}),
    };
  });
}

/**
 * Resolve pending permission invites for a user.
 * Non-fatal: if this fails, auth still succeeds.
 */
async function resolvePendingPermissions(
  userId: string,
  email: string,
): Promise<void> {
  try {
    const pendingRes = await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/pending_permissions?invited_email=eq.${
        encodeURIComponent(email.toLowerCase())
      }&select=*`,
      {
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
      },
    );
    if (!pendingRes.ok) return;
    const pendingRows = await pendingRes.json() as PendingPermissionRow[];
    if (!Array.isArray(pendingRows) || pendingRows.length === 0) return;

    const appIdsNeedingLookup = [
      ...new Set(
        pendingRows
          .filter((pending) => !pending.app_slug && pending.app_id)
          .map((pending) => pending.app_id),
      ),
    ];

    let appSlugsById: Record<string, string> = {};
    if (appIdsNeedingLookup.length > 0) {
      const appsRes = await fetch(
        `${getEnv("SUPABASE_URL")}/rest/v1/apps?id=in.(${
          appIdsNeedingLookup.join(",")
        })&select=id,slug`,
        {
          headers: {
            "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
            "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
        },
      );

      if (appsRes.ok) {
        const appRows = await appsRes.json() as Array<
          { id: string; slug: string }
        >;
        appSlugsById = Object.fromEntries(
          appRows
            .filter((row) => !!row.id && !!row.slug)
            .map((row) => [row.id, row.slug]),
        );
      }
    }

    const pendingRowsByAppId = new Map<string, PendingPermissionRow[]>();
    for (const pending of pendingRows) {
      const group = pendingRowsByAppId.get(pending.app_id) || [];
      group.push(pending);
      pendingRowsByAppId.set(pending.app_id, group);
    }
    for (const [appId, rowsForApp] of pendingRowsByAppId) {
      const appSlug = rowsForApp[0]?.app_slug || appSlugsById[appId];
      if (!appSlug) continue;
      logLegacyPermissionNameCompatibility({
        surface: "pending_invite_resolution",
        appId,
        appSlug,
        actorUserId: userId,
        rows: rowsForApp,
      });
    }

    const realRows = resolvePendingPermissionRows(
      pendingRows,
      userId,
      appSlugsById,
    );

    await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/user_app_permissions`,
      {
        method: "POST",
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify(realRows),
      },
    );

    await fetch(
      `${getEnv("SUPABASE_URL")}/rest/v1/pending_permissions?invited_email=eq.${
        encodeURIComponent(email.toLowerCase())
      }`,
      {
        method: "DELETE",
        headers: {
          "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
      },
    );

    console.log(`[AUTH] Resolved ${pendingRows.length} pending permissions`);
  } catch {
    // Non-fatal: don't block auth.
  }
}
