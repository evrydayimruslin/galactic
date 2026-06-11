// Read-models for the cross-Agent wiring UX (Phase 4b / P5).
//
// agent-grants.ts is the authority (writes + runtime enforcement); this module
// builds the views the wiring UI and ul.grants render: an Agent's declared
// slots + their bindings, the eligible-target picker, the egress-trust signal,
// and the combined inbound/outbound/pending wiring view. All reads are
// user-scoped; nothing here grants authority.

import { getEnv } from "../lib/env.ts";
import type { AppManifest, ManifestSlotImport } from "../../shared/contracts/manifest.ts";
import type {
  AgentCallerTrustSummary,
  AgentImportSlot,
  AgentWiringTarget,
  AgentWiringView,
} from "../../shared/contracts/agent-grants.ts";
import { listGrantSummaries } from "./agent-grants.ts";

interface DbConfig {
  baseUrl: string;
  headers: HeadersInit;
}

function getDbConfig(): DbConfig | null {
  const baseUrl = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !key) return null;
  return {
    baseUrl,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  };
}

interface AppRow {
  id: string;
  slug: string | null;
  name: string | null;
  owner_id: string;
  visibility: string;
  manifest: string | null;
  declared_permissions: unknown;
  source_fingerprint: string | null;
}

const APP_SELECT =
  "id,slug,name,owner_id,visibility,manifest,declared_permissions,source_fingerprint";

function parseManifest(raw: string | null): AppManifest | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? parsed as AppManifest : null;
  } catch {
    return null;
  }
}

function manifestFunctionList(
  manifest: AppManifest | null,
): { name: string; description: string | null }[] {
  if (!manifest?.functions) return [];
  return Object.entries(manifest.functions)
    .map(([name, def]) => ({
      name,
      description: typeof def?.description === "string" ? def.description : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function appHandle(row: AppRow): { id: string; slug: string | null; name: string | null } {
  return { id: row.id, slug: row.slug, name: row.name };
}

async function fetchApp(db: DbConfig, appId: string): Promise<AppRow | null> {
  const response = await fetch(
    `${db.baseUrl}/rest/v1/apps?id=eq.${appId}&deleted_at=is.null&select=${APP_SELECT}&limit=1`,
    { headers: db.headers },
  );
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] as AppRow : null;
}

// Manifest `imports` -> declared slots (bindings filled in by buildWiringView).
function parseImportSlots(manifest: AppManifest | null): AgentImportSlot[] {
  const imports = manifest?.imports;
  if (!imports || typeof imports !== "object") return [];
  return Object.entries(imports as Record<string, ManifestSlotImport>)
    .map(([name, slot]) => ({
      name,
      description: typeof slot?.description === "string" ? slot.description : null,
      signature: typeof slot?.signature === "string" ? slot.signature : null,
      expectedFunctions: Array.isArray(slot?.functions)
        ? slot.functions.filter((fn): fn is string => typeof fn === "string")
        : [],
      binding: null,
    }));
}

function declaredPermissionList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((p): p is string => typeof p === "string");
  }
  return [];
}

// Whether the caller can plausibly send received data off-platform. This is a
// best-effort surface-and-warn signal (locked decision 4), and it deliberately
// errs toward warning: DIRECT egress (net:*) and INDIRECT egress (app:call to
// a downstream Agent, or a public http route that re-exposes data) all flip it
// true. It is NOT a containment guarantee — ai:call content and bound-slot
// fan-out can also move data, so a false here means "no DECLARED egress
// surface", not "cannot exfiltrate".
function detectNetworkEgress(
  declared: string[],
  manifest: AppManifest | null,
): boolean {
  if (declared.some((p) => p.startsWith("net:"))) return true;
  // Calling another Agent can route data to a net-capable downstream.
  if (declared.includes("app:call")) return true;
  // A public http route re-exposes whatever the Agent serves on it.
  const http = manifest?.http;
  if (http) {
    const defaultAuth = http.defaults?.auth;
    const routes = http.routes ?? {};
    const anyPublic = (defaultAuth === "public" &&
      Object.keys(routes).length >= 0) ||
      Object.values(routes).some((r) =>
        (r?.auth ?? defaultAuth) === "public"
      );
    if (anyPublic && Object.keys(routes).length > 0) return true;
    if (defaultAuth === "public" && Object.keys(routes).length > 0) return true;
  }
  return false;
}

export async function buildCallerTrustSummary(
  userId: string,
  appId: string,
): Promise<AgentCallerTrustSummary | null> {
  const db = getDbConfig();
  if (!db) return null;
  const row = await fetchApp(db, appId);
  if (!row) return null;

  const manifest = parseManifest(row.manifest);
  const declared = declaredPermissionList(row.declared_permissions).length > 0
    ? declaredPermissionList(row.declared_permissions)
    : declaredPermissionList(manifest?.permissions);

  return {
    app: appHandle(row),
    visibility: row.visibility,
    ownedByUser: row.owner_id === userId,
    hasNetworkEgress: detectNetworkEgress(declared, manifest),
    declaredPermissions: declared.sort(),
    // Computed at upload; lets the operator pin the caller's code revision and
    // re-review if it changes under a live wiring.
    codeFingerprint: row.source_fingerprint ?? null,
  };
}

// Agents the user could bind a slot to: owned + installed (+ the optional
// target itself if accessible). Each carries its callable functions so the
// picker can match a slot signature.
export async function listEligibleTargets(
  userId: string,
  options: { query?: string; limit?: number } = {},
): Promise<AgentWiringTarget[]> {
  const db = getDbConfig();
  if (!db) return [];
  const limit = Math.min(options.limit ?? 100, 200);

  // Owned apps.
  const owned = await fetch(
    `${db.baseUrl}/rest/v1/apps?owner_id=eq.${userId}&deleted_at=is.null&select=${APP_SELECT}&limit=${limit}`,
    { headers: db.headers },
  ).then((r) => r.ok ? r.json() : []).catch(() => []) as AppRow[];

  // Installed (library) app ids, then their rows.
  const libRows = await fetch(
    `${db.baseUrl}/rest/v1/user_app_library?user_id=eq.${userId}&select=app_id&limit=${limit}`,
    { headers: db.headers },
  ).then((r) => r.ok ? r.json() : []).catch(() => []) as { app_id: string }[];
  const ownedIds = new Set(owned.map((a) => a.id));
  const installIds = libRows
    .map((r) => r.app_id)
    .filter((id) => id && !ownedIds.has(id));
  let installed: AppRow[] = [];
  if (installIds.length > 0) {
    installed = await fetch(
      `${db.baseUrl}/rest/v1/apps?id=in.(${installIds.join(",")})&deleted_at=is.null&select=${APP_SELECT}`,
      { headers: db.headers },
    ).then((r) => r.ok ? r.json() : []).catch(() => []) as AppRow[];
  }

  const targets: AgentWiringTarget[] = [];
  const pushTarget = (
    row: AppRow,
    relationship: "owned" | "installed" | "accessible",
  ) => {
    const functions = manifestFunctionList(parseManifest(row.manifest));
    if (functions.length === 0) return;
    targets.push({
      app: appHandle(row),
      relationship,
      visibility: row.visibility,
      functions,
    });
  };
  for (const row of owned) pushTarget(row, "owned");
  for (const row of installed) pushTarget(row, "installed");

  const query = options.query?.trim().toLowerCase();
  const filtered = query
    ? targets.filter((t) =>
      (t.app.name || t.app.slug || "").toLowerCase().includes(query) ||
      t.functions.some((fn) =>
        fn.name.toLowerCase().includes(query) ||
        (fn.description || "").toLowerCase().includes(query)
      )
    )
    : targets;

  return filtered.sort((a, b) =>
    (a.app.name || a.app.slug || a.app.id).localeCompare(
      b.app.name || b.app.slug || b.app.id,
    )
  );
}

// The combined wiring view for one Agent (caller's outbound slots + raw grants,
// inbound grants, and the pending-request inbox), all scoped to the user.
export async function buildWiringView(
  userId: string,
  appId: string,
): Promise<AgentWiringView | null> {
  const db = getDbConfig();
  if (!db) return null;
  const row = await fetchApp(db, appId);
  if (!row) return null;

  const slots = parseImportSlots(parseManifest(row.manifest));

  const [outbound, inbound, pending] = await Promise.all([
    listGrantSummaries({ userId, callerAppId: appId, status: "active" }),
    listGrantSummaries({ userId, targetAppId: appId, status: "active" }),
    listGrantSummaries({ userId, status: "pending" }),
  ]);

  // Bind each declared slot to its active outbound grant (if wired).
  for (const slot of slots) {
    slot.binding = outbound.find((g) => g.slot === slot.name) ?? null;
  }
  const outboundGrants = outbound.filter((g) => g.slot === null);
  const pendingRequests = pending.filter(
    (g) => g.callerApp.id === appId || g.targetApp.id === appId,
  );

  // Egress-trust for every distinct CALLER appearing in the inbox / inbound
  // grants, so the UI warns about the agent that actually receives the data
  // (not the page agent). Resolved server-side to keep the inbox a single fetch.
  const callerIds = Array.from(
    new Set([...pendingRequests, ...inbound].map((g) => g.callerApp.id)),
  );
  const callerTrustByApp: Record<string, AgentCallerTrustSummary> = {};
  await Promise.all(callerIds.map(async (callerId) => {
    const trust = await buildCallerTrustSummary(userId, callerId);
    if (trust) callerTrustByApp[callerId] = trust;
  }));

  return {
    app: appHandle(row),
    slots,
    outboundGrants,
    inboundGrants: inbound,
    pendingRequests,
    callerTrustByApp,
    generatedAt: new Date().toISOString(),
  };
}
