// Cross-Agent function grant store + enforcement (Phase 4a / P5).
//
// Authority for cross-Agent calls. The runtime resolves a call against active
// grants; grant CREATION enforces the delegation-not-expansion safety
// invariant (a user may wire caller A -> target F only if the user could call
// F themselves). See docs/LAUNCH_PIVOT_DECISIONS.md and
// memory phase4-cross-agent-interop-design.

import { getEnv } from "../lib/env.ts";
import { RequestValidationError } from "./request-validation.ts";
import type { RuntimeAppCallDependency } from "./app-runtime-resources.ts";
import {
  type AgentFunctionGrant,
  type AgentGrantCreateRequest,
  type AgentGrantOrigin,
  type AgentGrantResolution,
  type AgentGrantSummary,
  type AgentSlotBinding,
  DEFAULT_GRANT_MONTHLY_CAP_CREDITS,
} from "../../shared/contracts/agent-grants.ts";

export interface AppHandle {
  id: string;
  slug: string | null;
  name: string | null;
}

interface DbConfig {
  baseUrl: string;
  headers: HeadersInit;
}

interface AgentGrantRow {
  id: string;
  user_id: string;
  caller_app_id: string;
  caller_function: string | null;
  slot: string | null;
  target_app_id: string;
  target_function: string;
  topic: string | null;
  mode: string;
  status: string;
  monthly_cap_credits: number | string | null;
  spent_credits_period: number | string | null;
  period_start: string;
  constraints: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  updated_at: string;
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

function numeric(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapRow(row: AgentGrantRow): AgentFunctionGrant {
  return {
    id: row.id,
    userId: row.user_id,
    callerAppId: row.caller_app_id,
    // '' sentinel (NOT NULL in the DB) surfaces as null = "any" on the contract.
    callerFunction: row.caller_function ? row.caller_function : null,
    slot: row.slot ? row.slot : null,
    targetAppId: row.target_app_id,
    targetFunction: row.target_function,
    topic: row.topic ? row.topic : null,
    mode: row.mode === "subscribe" ? "subscribe" : "call",
    status: row.status === "pending"
      ? "pending"
      : row.status === "revoked"
      ? "revoked"
      : "active",
    monthlyCapCredits: row.monthly_cap_credits === null ||
        row.monthly_cap_credits === undefined
      ? null
      : numeric(row.monthly_cap_credits),
    spentCreditsPeriod: numeric(row.spent_credits_period),
    periodStart: row.period_start,
    constraints: (row.constraints && typeof row.constraints === "object")
      ? row.constraints
      : {},
    createdBy: (["user", "agent", "developer_hint", "auto_request"].includes(
        row.created_by,
      )
      ? row.created_by
      : "user") as AgentGrantOrigin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function dbGet(
  db: DbConfig,
  query: string,
): Promise<AgentGrantRow[]> {
  const response = await fetch(
    `${db.baseUrl}/rest/v1/agent_function_grants?${query}`,
    { headers: db.headers },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail ? `Failed to read grants: ${detail}` : "Failed to read grants",
    );
  }
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? payload as AgentGrantRow[] : [];
}

// Same calendar month ⇒ keep accumulating; otherwise the period has rolled.
function sameMonth(periodStartIso: string, nowMs: number): boolean {
  const start = new Date(periodStartIso);
  const now = new Date(nowMs);
  return start.getUTCFullYear() === now.getUTCFullYear() &&
    start.getUTCMonth() === now.getUTCMonth();
}

// Effective spend for a grant after applying a lazy monthly rollover (a grant
// whose period_start is in a prior month spends from 0 this month).
function effectiveSpend(grant: AgentFunctionGrant, nowMs: number): number {
  return sameMonth(grant.periodStart, nowMs) ? grant.spentCreditsPeriod : 0;
}

// ── Runtime enforcement ──────────────────────────────────────────────────

export async function resolveCallerGrant(input: {
  userId: string;
  callerAppId: string;
  callerFunction: string | null;
  targetAppId: string;
  targetFunction: string;
  nowMs?: number;
}): Promise<AgentGrantResolution> {
  const db = getDbConfig();
  if (!db) return { allowed: false, grant: null, reason: "no_grant" };
  const nowMs = input.nowMs ?? Date.now();

  // Candidate grants for this (user, caller, target, fn) regardless of status.
  const rows = await dbGet(
    db,
    [
      `user_id=eq.${input.userId}`,
      `caller_app_id=eq.${input.callerAppId}`,
      `target_app_id=eq.${input.targetAppId}`,
      `target_function=eq.${encodeURIComponent(input.targetFunction)}`,
      `mode=eq.call`,
      `select=*`,
      `limit=50`,
    ].join("&"),
  );
  const grants = rows.map(mapRow);

  // A caller_function-narrowed grant only applies while that function runs;
  // a NULL caller_function grant applies to any function of the caller.
  const applies = (g: AgentFunctionGrant): boolean =>
    g.callerFunction === null || g.callerFunction === input.callerFunction;

  const active = grants.find((g) => g.status === "active" && applies(g));
  if (active) {
    if (
      active.monthlyCapCredits !== null &&
      effectiveSpend(active, nowMs) >= active.monthlyCapCredits
    ) {
      return { allowed: false, grant: active, reason: "cap_exceeded" };
    }
    return { allowed: true, grant: active };
  }

  const pending = grants.find((g) => g.status === "pending" && applies(g));
  if (pending) {
    return {
      allowed: false,
      grant: pending,
      reason: "pending",
      pendingRequestId: pending.id,
    };
  }

  return { allowed: false, grant: null, reason: "no_grant" };
}

// Pub/sub: resolve an event delivery against the SUBSCRIBE grant the chokepoint
// trusts. Mirrors resolveCallerGrant but matches mode=subscribe + topic. The
// "caller" is the EMITTER; the target is the subscriber's handler.
export async function resolveSubscribeGrant(input: {
  userId: string;
  emitterAppId: string;
  subscriberAppId: string;
  targetFunction: string;
  topic: string;
  nowMs?: number;
}): Promise<AgentGrantResolution> {
  const db = getDbConfig();
  if (!db) return { allowed: false, grant: null, reason: "no_grant" };
  const nowMs = input.nowMs ?? Date.now();
  const rows = await dbGet(
    db,
    [
      `user_id=eq.${input.userId}`,
      `caller_app_id=eq.${input.emitterAppId}`,
      `target_app_id=eq.${input.subscriberAppId}`,
      `target_function=eq.${encodeURIComponent(input.targetFunction)}`,
      `topic=eq.${encodeURIComponent(input.topic)}`,
      `mode=eq.subscribe`,
      `select=*`,
      `limit=10`,
    ].join("&"),
  );
  const active = rows.map(mapRow).find((g) => g.status === "active");
  if (!active) return { allowed: false, grant: null, reason: "no_grant" };
  if (
    active.monthlyCapCredits !== null &&
    effectiveSpend(active, nowMs) >= active.monthlyCapCredits
  ) {
    return { allowed: false, grant: active, reason: "cap_exceeded" };
  }
  return { allowed: true, grant: active };
}

// Active subscribe grants that should receive an emitter's topic, for the
// dispatcher's fan-out. Capped count bounds amplification per emit.
export async function resolveSubscribers(input: {
  userId: string;
  emitterAppId: string;
  topic: string;
  limit?: number;
}): Promise<AgentFunctionGrant[]> {
  const db = getDbConfig();
  if (!db) return [];
  const rows = await dbGet(
    db,
    [
      `user_id=eq.${input.userId}`,
      `caller_app_id=eq.${input.emitterAppId}`,
      `topic=eq.${encodeURIComponent(input.topic)}`,
      `mode=eq.subscribe`,
      `status=eq.active`,
      `select=*`,
      `limit=${Math.min(input.limit ?? 100, 500)}`,
    ].join("&"),
  );
  return rows.map(mapRow);
}

// Post-call: attribute the credits charged to the grant's monthly window via
// an ATOMIC RPC. A single UPDATE avoids the lost-update race of a
// read-modify-write — concurrent cross-Agent calls each increment correctly —
// and resets the window in the same statement when the month has rolled.
export async function recordGrantSpend(
  grantId: string,
  creditsCharged: number,
  nowMs = Date.now(),
): Promise<void> {
  if (!Number.isFinite(creditsCharged) || creditsCharged <= 0) return;
  const db = getDbConfig();
  if (!db) return;

  try {
    await fetch(`${db.baseUrl}/rest/v1/rpc/increment_agent_grant_spend`, {
      method: "POST",
      headers: { ...db.headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        p_grant_id: grantId,
        p_amount: creditsCharged,
        p_now: new Date(nowMs).toISOString(),
      }),
    });
  } catch (err) {
    // Spend accounting is best-effort; never block the (already-completed)
    // call on a metering write failure.
    console.warn("[AGENT-GRANTS] Failed to record grant spend:", err);
  }
}

// Default-deny side effect: record that a caller wanted access, so it surfaces
// in the user's pending-request inbox. Idempotent on the unique index.
export async function createPendingGrantRequest(input: {
  userId: string;
  callerAppId: string;
  callerFunction: string | null;
  targetAppId: string;
  targetFunction: string;
}): Promise<string | null> {
  const db = getDbConfig();
  if (!db) return null;
  try {
    const response = await fetch(
      `${db.baseUrl}/rest/v1/agent_function_grants?on_conflict=user_id,caller_app_id,caller_function,slot,target_app_id,target_function,topic,mode`,
      {
        method: "POST",
        headers: {
          ...db.headers,
          // ignore-duplicates: never overwrite an existing (possibly active)
          // grant when re-requesting; just ensure a pending row exists.
          Prefer: "resolution=ignore-duplicates,return=representation",
        },
        body: JSON.stringify([{
          user_id: input.userId,
          caller_app_id: input.callerAppId,
          // '' sentinel matches the NOT NULL columns + bare-column unique index.
          caller_function: input.callerFunction ?? "",
          slot: "",
          target_app_id: input.targetAppId,
          target_function: input.targetFunction,
          topic: "",
          mode: "call",
          status: "pending",
          created_by: "auto_request",
        }]),
      },
    );
    if (!response.ok) return null;
    const rows = await response.json().catch(() => []);
    return Array.isArray(rows) && rows[0]?.id ? rows[0].id : null;
  } catch (err) {
    console.warn("[AGENT-GRANTS] Failed to record pending request:", err);
    return null;
  }
}

// ── Caller-side resolution (so granted calls can be EXPRESSED in-sandbox) ──

export interface CallerGrantBindings {
  // Active grants as runtime dependencies, so the in-sandbox ultralight.call
  // gate (__ulAllowsAppCall) permits granted targets even when the developer
  // never declared them. The target still authorizes every call.
  dependencies: RuntimeAppCallDependency[];
  // Logical port -> concrete target bindings for ultralight.use().
  slots: AgentSlotBinding[];
}

// Single active-grants read for (user, caller); derives BOTH the dependency
// set and the slot bindings (avoids two round-trips on the hot path).
export async function resolveCallerGrantBindings(
  userId: string,
  callerAppId: string,
): Promise<CallerGrantBindings> {
  const db = getDbConfig();
  if (!db) return { dependencies: [], slots: [] };
  try {
    const rows = await dbGet(
      db,
      [
        `user_id=eq.${userId}`,
        `caller_app_id=eq.${callerAppId}`,
        `status=eq.active`,
        `mode=eq.call`,
        `select=slot,target_app_id,target_function`,
        `limit=500`,
      ].join("&"),
    );

    const byApp = new Map<string, Set<string>>();
    const bySlot = new Map<string, { app: string; fns: Set<string> }>();
    for (const row of rows) {
      const set = byApp.get(row.target_app_id) ?? new Set<string>();
      set.add(row.target_function);
      byApp.set(row.target_app_id, set);

      if (row.slot) {
        const entry = bySlot.get(row.slot) ??
          { app: row.target_app_id, fns: new Set<string>() };
        // A slot binds to exactly one target app; ignore conflicting rows.
        if (entry.app !== row.target_app_id) continue;
        entry.fns.add(row.target_function);
        bySlot.set(row.slot, entry);
      }
    }

    return {
      dependencies: Array.from(byApp.entries()).map(([app, fns]) => ({
        app,
        functions: Array.from(fns).sort(),
        access: "read" as const,
      })),
      slots: Array.from(bySlot.entries()).map(([slot, entry]) => ({
        slot,
        targetAppId: entry.app,
        functions: Array.from(entry.fns).sort(),
      })),
    };
  } catch (err) {
    console.warn("[AGENT-GRANTS] Failed to resolve caller grant bindings:", err);
    return { dependencies: [], slots: [] };
  }
}

// ── Grant creation (safety invariant lives here) ──────────────────────────

interface AppAccessRow {
  id: string;
  owner_id: string;
  visibility: string;
  slug: string | null;
}

async function loadApp(
  db: DbConfig,
  appId: string,
): Promise<AppAccessRow | null> {
  // deleted_at is null — never wire a soft-deleted Agent.
  const response = await fetch(
    `${db.baseUrl}/rest/v1/apps?id=eq.${appId}&deleted_at=is.null&select=id,owner_id,visibility,slug&limit=1`,
    { headers: db.headers },
  );
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0] as AppAccessRow : null;
}

// Grants store the RAW function name (no slug prefix), matching what the
// runtime resolves at the chokepoint (toRawMcpFunctionName). Strip a leading
// "<slug>_" so a prefixed input still matches at call time.
function toRawFunctionName(
  name: string,
  slug: string | null | undefined,
): string {
  const trimmed = name.trim();
  if (slug && trimmed.startsWith(`${slug}_`)) {
    return trimmed.slice(slug.length + 1);
  }
  return trimmed;
}

async function userControlsCaller(
  db: DbConfig,
  userId: string,
  callerApp: AppAccessRow,
): Promise<boolean> {
  if (callerApp.owner_id === userId) return true;
  // Installed (in the user's library) counts as "an Agent the user runs".
  const response = await fetch(
    `${db.baseUrl}/rest/v1/user_app_library?user_id=eq.${userId}&app_id=eq.${callerApp.id}&select=app_id&limit=1`,
    { headers: db.headers },
  );
  if (!response.ok) return false;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function userCanCallTarget(
  db: DbConfig,
  userId: string,
  target: AppAccessRow,
  targetFunction: string,
): Promise<boolean> {
  if (target.owner_id === userId) return true;
  if (target.visibility === "public" || target.visibility === "unlisted") {
    return true;
  }
  // Private target owned by someone else: the user must already hold a
  // user_app_permission covering this function (or all functions).
  const response = await fetch(
    `${db.baseUrl}/rest/v1/user_app_permissions?granted_to_user_id=eq.${userId}&app_id=eq.${target.id}&allowed=eq.true&select=function_name`,
    { headers: db.headers },
  );
  if (!response.ok) return false;
  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.some((row: { function_name: string | null }) =>
    !row.function_name || row.function_name === targetFunction
  );
}

export async function createGrant(
  userId: string,
  request: AgentGrantCreateRequest,
  origin: AgentGrantOrigin = "user",
): Promise<AgentFunctionGrant> {
  const db = getDbConfig();
  if (!db) {
    throw new RequestValidationError("Grant storage is not configured", 503);
  }

  const callerAppId = request.callerAppId?.trim();
  const targetAppId = request.targetAppId?.trim();
  const rawTargetFunction = request.targetFunction?.trim();
  if (!callerAppId || !targetAppId || !rawTargetFunction) {
    throw new RequestValidationError(
      "callerAppId, targetAppId, and targetFunction are required",
    );
  }
  if (callerAppId === targetAppId) {
    throw new RequestValidationError(
      "An Agent does not need a grant to call its own functions",
    );
  }

  const [callerApp, targetApp] = await Promise.all([
    loadApp(db, callerAppId),
    loadApp(db, targetAppId),
  ]);
  if (!callerApp) throw new RequestValidationError("Caller Agent not found", 404);
  if (!targetApp) throw new RequestValidationError("Target Agent not found", 404);

  // Store the raw function name (matches runtime resolution).
  const targetFunction = toRawFunctionName(rawTargetFunction, targetApp.slug);
  const callerFunction = request.callerFunction
    ? toRawFunctionName(request.callerFunction, callerApp.slug)
    : "";

  // Mode + topic. A subscribe grant authorizes the EMITTER (callerApp) to
  // deliver `topic` events to the SUBSCRIBER's handler (target/targetFunction);
  // a topic is required and only meaningful in subscribe mode.
  const mode = request.mode === "subscribe" ? "subscribe" : "call";
  const topic = mode === "subscribe" ? (request.topic?.trim() || "") : "";
  if (mode === "subscribe" && !topic) {
    throw new RequestValidationError(
      "A subscribe grant requires a topic",
    );
  }

  // SAFETY INVARIANT — delegation, not expansion. (Same for both modes: the
  // user must control the caller/emitter and be able to call the target/
  // subscriber handler that runs.)
  if (!(await userControlsCaller(db, userId, callerApp))) {
    throw new RequestValidationError(
      "You can only wire Agents you own or have installed",
      403,
    );
  }
  if (!(await userCanCallTarget(db, userId, targetApp, targetFunction))) {
    throw new RequestValidationError(
      "You cannot grant access to a function you cannot call yourself",
      403,
    );
  }

  const cap = request.monthlyCapCredits === undefined
    ? DEFAULT_GRANT_MONTHLY_CAP_CREDITS
    : request.monthlyCapCredits; // null = explicitly uncapped
  const slot = request.slot?.trim() || "";

  // SPEND-WINDOW INTEGRITY — never let a re-propose launder the monthly cap.
  // A capped agent calling createGrant with identical params would otherwise
  // merge-duplicate over its own active row and reset spent_credits_period to
  // 0. If an ACTIVE row already exists for this exact wiring, only update the
  // safe mutable fields (cap/constraints) and leave the spend window intact.
  const existing = await dbGet(
    db,
    [
      `user_id=eq.${userId}`,
      `caller_app_id=eq.${callerAppId}`,
      `caller_function=eq.${encodeURIComponent(callerFunction)}`,
      `slot=eq.${encodeURIComponent(slot)}`,
      `target_app_id=eq.${targetAppId}`,
      `target_function=eq.${encodeURIComponent(targetFunction)}`,
      `topic=eq.${encodeURIComponent(topic)}`,
      `mode=eq.${mode}`,
      `select=*`,
      `limit=1`,
    ].join("&"),
  );
  if (existing[0] && existing[0].status === "active") {
    const patched = await patchGrant(db, userId, existing[0].id, {
      monthly_cap_credits: cap,
      constraints: request.constraints ?? existing[0].constraints ?? {},
    });
    if (patched) return patched;
    return mapRow(existing[0]);
  }

  const payload = {
    user_id: userId,
    caller_app_id: callerAppId,
    caller_function: callerFunction,
    slot,
    target_app_id: targetAppId,
    target_function: targetFunction,
    topic,
    mode,
    status: "active",
    monthly_cap_credits: cap,
    spent_credits_period: 0,
    period_start: new Date().toISOString(),
    constraints: request.constraints ?? {},
    created_by: origin,
  };

  // Upsert: a fresh insert, or re-activating a pending/revoked pair (which
  // legitimately starts a clean spend window).
  const response = await fetch(
    `${db.baseUrl}/rest/v1/agent_function_grants?on_conflict=user_id,caller_app_id,caller_function,slot,target_app_id,target_function,topic,mode`,
    {
      method: "POST",
      headers: {
        ...db.headers,
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([payload]),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new RequestValidationError(
      detail ? `Failed to create grant: ${detail}` : "Failed to create grant",
      500,
    );
  }
  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || !rows[0]) {
    throw new RequestValidationError("Grant creation returned no row", 500);
  }
  return mapRow(rows[0] as AgentGrantRow);
}

// Revoke only. Activation must go through approvePendingGrant, which re-runs
// the delegation-not-expansion safety invariant — a bare status flip would
// skip that re-check and could re-activate a wiring the user no longer has
// access to.
export async function setGrantStatus(
  userId: string,
  grantId: string,
  status: "revoked",
): Promise<AgentFunctionGrant | null> {
  const db = getDbConfig();
  if (!db) {
    throw new RequestValidationError("Grant storage is not configured", 503);
  }
  return await patchGrant(db, userId, grantId, { status });
}

export async function listGrants(input: {
  userId: string;
  callerAppId?: string;
  targetAppId?: string;
}): Promise<AgentFunctionGrant[]> {
  const db = getDbConfig();
  if (!db) return [];
  const filters = [`user_id=eq.${input.userId}`, "select=*", "limit=500"];
  if (input.callerAppId) filters.push(`caller_app_id=eq.${input.callerAppId}`);
  if (input.targetAppId) filters.push(`target_app_id=eq.${input.targetAppId}`);
  const rows = await dbGet(db, filters.join("&"));
  return rows.map(mapRow);
}

// Whether the user has opted the connected agent into APPROVING grants via
// ul.grants (default false — the secure floor requires a website action).
export async function getUserGrantAutoApprove(userId: string): Promise<boolean> {
  const db = getDbConfig();
  if (!db) return false;
  try {
    const response = await fetch(
      `${db.baseUrl}/rest/v1/users?id=eq.${userId}&select=agent_grant_autoapprove&limit=1`,
      { headers: db.headers },
    );
    if (!response.ok) return false;
    const rows = await response.json().catch(() => []);
    return Array.isArray(rows) && rows[0]?.agent_grant_autoapprove === true;
  } catch {
    return false;
  }
}

export async function setUserGrantAutoApprove(
  userId: string,
  value: boolean,
): Promise<void> {
  const db = getDbConfig();
  if (!db) {
    throw new RequestValidationError("Grant storage is not configured", 503);
  }
  const response = await fetch(
    `${db.baseUrl}/rest/v1/users?id=eq.${userId}`,
    {
      method: "PATCH",
      headers: { ...db.headers, Prefer: "return=minimal" },
      body: JSON.stringify({ agent_grant_autoapprove: value }),
    },
  );
  if (!response.ok) {
    throw new RequestValidationError("Failed to update preference", 500);
  }
}

export async function getGrant(
  userId: string,
  grantId: string,
): Promise<AgentFunctionGrant | null> {
  const db = getDbConfig();
  if (!db) return null;
  const rows = await dbGet(
    db,
    `user_id=eq.${userId}&id=eq.${grantId}&select=*&limit=1`,
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

// Resolve {id, slug, name} for a set of app ids in one query, so grant lists
// can render Agent names without N round-trips.
export async function fetchAppHandles(
  ids: string[],
): Promise<Map<string, AppHandle>> {
  const map = new Map<string, AppHandle>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return map;
  const db = getDbConfig();
  if (!db) return map;
  try {
    const response = await fetch(
      `${db.baseUrl}/rest/v1/apps?id=in.(${unique.join(",")})&select=id,slug,name`,
      { headers: db.headers },
    );
    if (!response.ok) return map;
    const rows = await response.json().catch(() => []);
    if (Array.isArray(rows)) {
      for (const row of rows as AppHandle[]) map.set(row.id, row);
    }
  } catch {
    // Best-effort labels; callers fall back to ids.
  }
  return map;
}

function handleFor(map: Map<string, AppHandle>, id: string): AppHandle {
  return map.get(id) ?? { id, slug: null, name: null };
}

export function toGrantSummary(
  grant: AgentFunctionGrant,
  apps: Map<string, AppHandle>,
): AgentGrantSummary {
  return {
    id: grant.id,
    callerApp: handleFor(apps, grant.callerAppId),
    targetApp: handleFor(apps, grant.targetAppId),
    callerFunction: grant.callerFunction,
    slot: grant.slot,
    targetFunction: grant.targetFunction,
    topic: grant.topic,
    mode: grant.mode,
    status: grant.status,
    monthlyCapCredits: grant.monthlyCapCredits,
    spentCreditsPeriod: grant.spentCreditsPeriod,
    periodStart: grant.periodStart,
    createdBy: grant.createdBy,
    updatedAt: grant.updatedAt,
  };
}

// Grants joined with Agent handles, ready for the wiring UI / ul.grants.
export async function listGrantSummaries(input: {
  userId: string;
  callerAppId?: string;
  targetAppId?: string;
  status?: "active" | "pending" | "revoked";
}): Promise<AgentGrantSummary[]> {
  const grants = (await listGrants(input)).filter(
    (g) => !input.status || g.status === input.status,
  );
  const apps = await fetchAppHandles(
    grants.flatMap((g) => [g.callerAppId, g.targetAppId]),
  );
  return grants.map((g) => toGrantSummary(g, apps));
}

// Approve a pending request: re-run the safety invariant (the row was
// auto-created at call time; approval is the moment the user authorizes, so
// re-verify the user still controls the caller and can call the target),
// then flip pending -> active and set the cap.
export async function approvePendingGrant(
  userId: string,
  grantId: string,
  options: { monthlyCapCredits?: number | null } = {},
): Promise<AgentFunctionGrant | null> {
  const db = getDbConfig();
  if (!db) {
    throw new RequestValidationError("Grant storage is not configured", 503);
  }
  const grant = await getGrant(userId, grantId);
  if (!grant) return null;
  if (grant.status === "active") return grant;

  const [callerApp, targetApp] = await Promise.all([
    loadApp(db, grant.callerAppId),
    loadApp(db, grant.targetAppId),
  ]);
  if (!callerApp || !targetApp) {
    throw new RequestValidationError("Caller or target Agent not found", 404);
  }
  if (!(await userControlsCaller(db, userId, callerApp))) {
    throw new RequestValidationError(
      "You can only approve grants for Agents you own or have installed",
      403,
    );
  }
  if (!(await userCanCallTarget(db, userId, targetApp, grant.targetFunction))) {
    throw new RequestValidationError(
      "You cannot approve access to a function you cannot call yourself",
      403,
    );
  }

  const cap = options.monthlyCapCredits === undefined
    ? (grant.monthlyCapCredits ?? DEFAULT_GRANT_MONTHLY_CAP_CREDITS)
    : options.monthlyCapCredits;

  return await patchGrant(db, userId, grantId, {
    status: "active",
    monthly_cap_credits: cap,
    // Reset the spend window so an approval starts a fresh month.
    spent_credits_period: 0,
    period_start: new Date().toISOString(),
  });
}

export async function setGrantCap(
  userId: string,
  grantId: string,
  monthlyCapCredits: number | null,
): Promise<AgentFunctionGrant | null> {
  const db = getDbConfig();
  if (!db) {
    throw new RequestValidationError("Grant storage is not configured", 503);
  }
  if (
    monthlyCapCredits !== null &&
    (!Number.isFinite(monthlyCapCredits) || monthlyCapCredits < 0)
  ) {
    throw new RequestValidationError(
      "monthlyCapCredits must be null or a non-negative number",
    );
  }
  return await patchGrant(db, userId, grantId, {
    monthly_cap_credits: monthlyCapCredits,
  });
}

async function patchGrant(
  db: DbConfig,
  userId: string,
  grantId: string,
  patch: Record<string, unknown>,
): Promise<AgentFunctionGrant | null> {
  const response = await fetch(
    `${db.baseUrl}/rest/v1/agent_function_grants?id=eq.${grantId}&user_id=eq.${userId}`,
    {
      method: "PATCH",
      headers: { ...db.headers, Prefer: "return=representation" },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
    },
  );
  if (!response.ok) {
    throw new RequestValidationError("Failed to update grant", 500);
  }
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? mapRow(rows[0] as AgentGrantRow) : null;
}
