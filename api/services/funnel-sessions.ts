import { getEnv } from "../lib/env.ts";
import {
  type BuilderHandoffSessionRecord,
  type BuilderHandoffSessionServiceOptions,
  createBuilderHandoffSession,
} from "./builder-handoff-sessions.ts";
import type { BuilderHandoffCredential } from "./builder-handoff-sessions.ts";

/**
 * WO-F1: anonymous claimable funnel sessions.
 *
 * A funnel session binds a stable, unlisted pairing code to a provisional
 * owner and the CURRENT builder handoff session. The pairing code is the
 * human's handle (browser page, CLI watch loop, 7-day return window); the
 * handoff credential remains the coding agent's 60-minute build handle.
 * Everything the provisional owner accumulates re-parents onto a real
 * account at claim time, atomically, in the claim_funnel_session RPC.
 *
 * Abuse ceilings live here as named constants so support can reason about
 * them and tests can pin them (see ONBOARDING_FUNNEL_WORK_ORDERS.md,
 * Cross-cutting).
 */

export const FUNNEL_RETURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const FUNNEL_PAIRING_CODE_LENGTH = 20;
/** Per-IP mints per window — the funnel front door, deliberately narrow. */
export const FUNNEL_MINT_LIMIT_PER_IP = 6;
export const FUNNEL_MINT_WINDOW_MINUTES = 60;
export const FUNNEL_DESCRIPTION_MAX_LENGTH = 4_000;

const PAIRING_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const PAIRING_CODE_RE = /^[a-z0-9]{16,64}$/;
const PROVISIONAL_EMAIL_DOMAIN = "provisional.connectgalactic.com";

export const FUNNEL_SURFACES = ["cli", "web"] as const;
export type FunnelSurface = typeof FUNNEL_SURFACES[number];

export type FunnelSessionErrorCode =
  | "invalid_request"
  | "not_found"
  | "expired"
  | "already_claimed"
  | "claimer_not_member"
  | "unavailable";

export class FunnelSessionError extends Error {
  readonly code: FunnelSessionErrorCode;
  constructor(code: FunnelSessionErrorCode, message: string) {
    super(message);
    this.name = "FunnelSessionError";
    this.code = code;
  }
}

export interface FunnelSessionRow {
  pairingCode: string;
  provisionalOwnerId: string;
  handoffSessionId: string;
  surface: FunnelSurface;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
}

export interface MintFunnelSessionInput {
  surface: FunnelSurface;
  description: string;
}

export interface MintedFunnelSession {
  funnel: FunnelSessionRow;
  session: BuilderHandoffSessionRecord;
  credential: BuilderHandoffCredential;
  provisionalOwnerId: string;
}

/**
 * Sanitized pairing projection: lifecycle stages only. No credential
 * material, no source, no evidence — the page a stranger can watch must
 * never widen what an unlisted link reveals. `agentName` appears only once
 * an upload names the reserved Agent.
 */
export interface FunnelPairingProjection {
  pairingCode: string;
  surface: FunnelSurface;
  status: string;
  createdAt: string;
  connectedAt: string | null;
  stagedAt: string | null;
  testedAt: string | null;
  uploadedAt: string | null;
  promotedAt: string | null;
  handoffExpiresAt: string;
  returnWindowExpiresAt: string;
  claimed: boolean;
  reservedAgentId: string | null;
  agentName: string | null;
  uploadedVersion: string | null;
}

interface ServiceConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchFn: typeof fetch;
}

function serviceConfig(
  options: BuilderHandoffSessionServiceOptions,
): ServiceConfig {
  const supabaseUrl = options.supabaseUrl ?? getEnv("SUPABASE_URL");
  const serviceRoleKey = options.serviceRoleKey ??
    getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new FunnelSessionError(
      "unavailable",
      "Funnel sessions are unavailable: database configuration is missing",
    );
  }
  return {
    supabaseUrl,
    serviceRoleKey,
    fetchFn: options.fetchFn ?? fetch,
  };
}

async function restJson(
  config: ServiceConfig,
  method: "GET" | "POST" | "PATCH",
  pathAndQuery: string,
  body?: unknown,
): Promise<unknown> {
  const fetchFn = config.fetchFn;
  let response: Response;
  try {
    response = await fetchFn(`${config.supabaseUrl}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: method === "GET"
          ? "count=none"
          : "return=representation",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new FunnelSessionError(
      "unavailable",
      "Funnel session storage did not respond",
    );
  }
  if (!response.ok) {
    throw new FunnelSessionError(
      "unavailable",
      `Funnel session storage rejected the request (${response.status})`,
    );
  }
  return await response.json();
}

async function callRpc(
  config: ServiceConfig,
  name: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; payload: unknown } | { ok: false; message: string }> {
  const fetchFn = config.fetchFn;
  let response: Response;
  try {
    response = await fetchFn(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new FunnelSessionError(
      "unavailable",
      "Funnel session storage did not respond",
    );
  }
  if (response.ok) {
    return { ok: true, payload: await response.json() };
  }
  let message = "";
  try {
    const parsed = await response.json() as { message?: unknown };
    message = typeof parsed.message === "string" ? parsed.message : "";
  } catch {
    // Non-JSON error bodies fall through to the generic mapping.
  }
  return { ok: false, message };
}

function generatePairingCode(
  options: BuilderHandoffSessionServiceOptions,
): string {
  const randomBytes = options.randomBytes ??
    ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  const bytes = randomBytes(FUNNEL_PAIRING_CODE_LENGTH);
  let code = "";
  for (let index = 0; index < FUNNEL_PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_CODE_ALPHABET[bytes[index] % PAIRING_CODE_ALPHABET.length];
  }
  return code;
}

function resolveNow(options: BuilderHandoffSessionServiceOptions): Date {
  return options.now ? options.now() : new Date();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FunnelSessionError(
      "unavailable",
      `Funnel session storage returned a malformed ${label}`,
    );
  }
  return value;
}

function parseFunnelRow(value: unknown): FunnelSessionRow {
  const row = (Array.isArray(value) ? value[0] : value) as
    | Record<string, unknown>
    | undefined;
  if (!row || typeof row !== "object") {
    throw new FunnelSessionError(
      "unavailable",
      "Funnel session storage returned no row",
    );
  }
  const surface = row.surface === "web" ? "web" : "cli";
  return {
    pairingCode: requireString(row.pairing_code, "pairing code"),
    provisionalOwnerId: requireString(
      row.provisional_owner_id,
      "provisional owner",
    ),
    handoffSessionId: requireString(row.handoff_session_id, "session id"),
    surface,
    createdAt: requireString(row.created_at, "created timestamp"),
    updatedAt: requireString(row.updated_at, "updated timestamp"),
    expiresAt: requireString(row.expires_at, "expiry timestamp"),
    claimedAt: typeof row.claimed_at === "string" ? row.claimed_at : null,
    claimedBy: typeof row.claimed_by === "string" ? row.claimed_by : null,
  };
}

/**
 * Mint the funnel's front door: provisional users row → purpose-bound
 * handoff session (the existing machinery, unwidened) → funnel row binding
 * the pairing code. The credential is returned exactly once, here.
 */
export async function mintFunnelSession(
  input: MintFunnelSessionInput,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<MintedFunnelSession> {
  if (!FUNNEL_SURFACES.includes(input.surface)) {
    throw new FunnelSessionError(
      "invalid_request",
      "Funnel surface must be cli or web",
    );
  }
  const description = input.description.trim();
  if (
    description.length === 0 ||
    description.length > FUNNEL_DESCRIPTION_MAX_LENGTH
  ) {
    throw new FunnelSessionError(
      "invalid_request",
      "Funnel plan description is required and bounded",
    );
  }

  const config = serviceConfig(options);
  const now = resolveNow(options);
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const provisionalId = randomUUID();

  const userPayload = await restJson(config, "POST", "users", {
    id: provisionalId,
    email: `provisional+${provisionalId}@${PROVISIONAL_EMAIL_DOMAIN}`,
    account_kind: "provisional",
    tier: "free",
    display_name: null,
  });
  const createdUser = (Array.isArray(userPayload) ? userPayload[0] : null) as
    | Record<string, unknown>
    | null;
  if (!createdUser || createdUser.id !== provisionalId) {
    throw new FunnelSessionError(
      "unavailable",
      "Provisional account creation did not return its row",
    );
  }

  const { session, credential } = await createBuilderHandoffSession({
    ownerId: provisionalId,
    intent: "agent",
    description,
  }, options);

  const pairingCode = generatePairingCode(options);
  if (!PAIRING_CODE_RE.test(pairingCode)) {
    throw new FunnelSessionError(
      "unavailable",
      "Generated pairing code failed its own contract",
    );
  }
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + FUNNEL_RETURN_WINDOW_MS)
    .toISOString();
  const funnelPayload = await restJson(config, "POST", "funnel_sessions", {
    pairing_code: pairingCode,
    provisional_owner_id: provisionalId,
    handoff_session_id: session.id,
    surface: input.surface,
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: expiresAt,
  });
  const funnel = parseFunnelRow(funnelPayload);

  return { funnel, session, credential, provisionalOwnerId: provisionalId };
}

/**
 * The unlisted pairing read: stages only, never credential material. An
 * elapsed return window reads as not_found — the link simply stops
 * existing, matching the reaper's eventual physical delete.
 */
export async function readFunnelPairing(
  pairingCode: string,
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<FunnelPairingProjection> {
  if (!PAIRING_CODE_RE.test(pairingCode)) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }
  const config = serviceConfig(options);
  const now = resolveNow(options);

  const funnelPayload = await restJson(
    config,
    "GET",
    `funnel_sessions?pairing_code=eq.${pairingCode}&select=*&limit=1`,
  );
  const funnelRows = Array.isArray(funnelPayload) ? funnelPayload : [];
  if (funnelRows.length === 0) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }
  const funnel = parseFunnelRow(funnelRows);
  if (
    funnel.claimedAt === null &&
    Date.parse(funnel.expiresAt) <= now.getTime()
  ) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }

  const sessionPayload = await restJson(
    config,
    "GET",
    `builder_handoff_sessions?id=eq.${funnel.handoffSessionId}` +
      `&select=status,created_at,connected_at,staged_at,tested_at,` +
      `uploaded_at,promoted_at,expires_at,target_app_id,uploaded_app_id,` +
      `uploaded_version&limit=1`,
  );
  const sessionRows = Array.isArray(sessionPayload) ? sessionPayload : [];
  const session = sessionRows[0] as Record<string, unknown> | undefined;
  if (!session) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }

  const uploadedAppId = typeof session.uploaded_app_id === "string"
    ? session.uploaded_app_id
    : null;
  let agentName: string | null = null;
  if (uploadedAppId) {
    const appPayload = await restJson(
      config,
      "GET",
      `apps?id=eq.${uploadedAppId}&select=name&limit=1`,
    );
    const appRows = Array.isArray(appPayload) ? appPayload : [];
    const app = appRows[0] as Record<string, unknown> | undefined;
    agentName = typeof app?.name === "string" && app.name.length > 0
      ? app.name
      : null;
  }

  const stage = (key: string): string | null =>
    typeof session[key] === "string" ? session[key] as string : null;

  return {
    pairingCode: funnel.pairingCode,
    surface: funnel.surface,
    status: requireString(session.status, "session status"),
    createdAt: funnel.createdAt,
    connectedAt: stage("connected_at"),
    stagedAt: stage("staged_at"),
    testedAt: stage("tested_at"),
    uploadedAt: stage("uploaded_at"),
    promotedAt: stage("promoted_at"),
    handoffExpiresAt: requireString(session.expires_at, "session expiry"),
    returnWindowExpiresAt: funnel.expiresAt,
    claimed: funnel.claimedAt !== null,
    reservedAgentId: typeof session.target_app_id === "string"
      ? session.target_app_id
      : null,
    agentName,
    uploadedVersion: typeof session.uploaded_version === "string"
      ? session.uploaded_version
      : null,
  };
}

/** Claim: atomic re-parent via the claim_funnel_session RPC. */
export async function claimFunnelSession(
  input: { pairingCode: string; claimedBy: string },
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<FunnelSessionRow> {
  if (!PAIRING_CODE_RE.test(input.pairingCode)) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }
  const config = serviceConfig(options);
  const now = resolveNow(options);
  const result = await callRpc(config, "claim_funnel_session", {
    p_pairing_code: input.pairingCode,
    p_claimed_by: input.claimedBy,
    p_now: now.toISOString(),
  });
  if (result.ok) {
    return parseFunnelRow(result.payload);
  }
  if (result.message.includes("unknown pairing code")) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }
  if (result.message.includes("already claimed")) {
    throw new FunnelSessionError(
      "already_claimed",
      "This build was already claimed by another account",
    );
  }
  if (result.message.includes("return window elapsed")) {
    throw new FunnelSessionError(
      "expired",
      "The 7-day return window for this build has elapsed",
    );
  }
  if (result.message.includes("claimer must be a member account")) {
    throw new FunnelSessionError(
      "claimer_not_member",
      "Only a real account can claim a funnel build",
    );
  }
  throw new FunnelSessionError(
    "unavailable",
    "The claim could not be recorded",
  );
}

/**
 * WO-F2 `resume`: the pairing code is the human's stable handle, so its
 * bearer may re-mint an expired 60-minute build credential for the SAME
 * provisional owner. The funnel row swaps to the fresh handoff session;
 * the old session stays behind as ledger history. Claimed or elapsed
 * funnels refuse — resume never widens what a mint could do.
 */
export async function resumeFunnelSession(
  input: { pairingCode: string },
  options: BuilderHandoffSessionServiceOptions = {},
): Promise<MintedFunnelSession> {
  if (!PAIRING_CODE_RE.test(input.pairingCode)) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }
  const config = serviceConfig(options);
  const now = resolveNow(options);
  const payload = await restJson(
    config,
    "GET",
    `funnel_sessions?pairing_code=eq.${input.pairingCode}&select=*&limit=1`,
  );
  const rows = Array.isArray(payload) ? payload : [];
  if (rows.length === 0) {
    throw new FunnelSessionError("not_found", "Unknown pairing code");
  }
  const funnel = parseFunnelRow(rows);
  if (funnel.claimedAt !== null) {
    throw new FunnelSessionError(
      "already_claimed",
      "This build was claimed; sign in to keep building it",
    );
  }
  if (Date.parse(funnel.expiresAt) <= now.getTime()) {
    throw new FunnelSessionError(
      "expired",
      "The 7-day return window for this build has elapsed",
    );
  }

  const { session, credential } = await createBuilderHandoffSession({
    ownerId: funnel.provisionalOwnerId,
    intent: "agent",
    description: "Resumed funnel build session.",
  }, options);

  const patched = await restJson(
    config,
    "PATCH",
    `funnel_sessions?pairing_code=eq.${input.pairingCode}`,
    {
      handoff_session_id: session.id,
      updated_at: now.toISOString(),
    },
  );
  const patchedRows = Array.isArray(patched) ? patched : [patched];
  const nextFunnel = patchedRows.length > 0 && patchedRows[0]
    ? parseFunnelRow(patchedRows)
    : { ...funnel, handoffSessionId: session.id };

  return {
    funnel: nextFunnel,
    session,
    credential,
    provisionalOwnerId: funnel.provisionalOwnerId,
  };
}

/** Reaper entry: bounded, idempotent, spares claimed rows by construction. */
export async function reapExpiredFunnelSessions(
  options: BuilderHandoffSessionServiceOptions = {},
  limit = 100,
): Promise<number> {
  const config = serviceConfig(options);
  const now = resolveNow(options);
  const result = await callRpc(config, "reap_expired_funnel_sessions", {
    p_now: now.toISOString(),
    p_limit: limit,
  });
  if (!result.ok) {
    throw new FunnelSessionError(
      "unavailable",
      "The funnel reaper could not run",
    );
  }
  return typeof result.payload === "number" ? result.payload : 0;
}
