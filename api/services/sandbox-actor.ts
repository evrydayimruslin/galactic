// Sandbox actor tokens — the bearer the SDK uses for ultralight.call from
// inside an app sandbox (Phase: launch hardening).
//
// WHY: the runtime used to inject the CALLER'S OWN bearer (often a long-lived,
// full-scope ul_ API key) into the sandbox so app code could call other apps.
// That token is readable by third-party app code — e.g.
// `globalThis.ultralight.call.toString()` reveals the value baked into the
// dynamic-worker setup module, and `globalThis.__rpcEnv.SELF.fetch` lets code
// reach internal routes with it. A malicious Agent could exfiltrate the key.
//
// FIX: per execution, the runtime mints one of these instead. It is:
//   - short-lived (minutes) — bounds replay of a leaked value
//   - app-scoped — usable only against the executing app + its declared call
//     dependencies (unrestricted only when the app holds the broad `app:call`
//     permission, which already let its code call anything)
//   - apps:call only — never valid on an account-session route (key/wallet/
//     permission management), which authenticateRequest + the route guards
//     enforce by treating sandbox_actor like routine_actor
//
// SECURITY: like agent-caller-context, the signing secret must NOT be one that
// is injected into the sandbox. WORKER_SECRET is passed into the sandbox and is
// therefore readable by app code, so it is excluded here — otherwise sandbox
// code could forge a token with a wider scope than it was granted. The crypto
// mirrors agent-caller-context.ts (kept self-contained so this security
// primitive can be audited on its own).

import { getEnv } from "../lib/env.ts";

export const SANDBOX_ACTOR_TOKEN_PREFIX = "gxe_v1_";
const CLAIM_TYPE = "ultralight.sandbox_actor";
const DEFAULT_TTL_SECONDS = 5 * 60;
const MAX_TTL_SECONDS = 15 * 60;
const DEFAULT_SCOPES = ["apps:call"];

export class SandboxActorTokenError extends Error {}

function getSigningSecret(): string {
  for (
    const key of [
      "AGENT_CALLER_SECRET",
      // Server-only fallbacks. Deliberately NOT WORKER_SECRET (sandbox-exposed).
      "ROUTINE_ACTOR_TOKEN_SECRET",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]
  ) {
    const value = getEnv(key);
    if (value && value.trim()) return value.trim();
  }
  throw new SandboxActorTokenError(
    "Sandbox actor token signing secret is not configured",
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToString(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(
    base64.length + (4 - base64.length % 4) % 4,
    "=",
  );
  return atob(padded);
}

function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLength; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

async function hmac(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function dedupe(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

export interface SandboxActorUserInput {
  id: string;
  email: string;
  tier?: string | null;
  provisional?: boolean | null;
}

export interface SandboxActorTokenClaims {
  typ: typeof CLAIM_TYPE;
  ver: 1;
  jti: string;
  sub: string;
  user_id: string;
  user_email: string;
  user_tier: string;
  provisional: boolean;
  /** The executing app the token was minted for (audit/diagnostics). */
  app_id: string;
  /** Allowed call targets. ['*'] = unrestricted (app held broad app:call). */
  app_ids: string[];
  /** Function scope; ['*'] — functions are gated by deps + cross-Agent grants. */
  function_names: string[];
  scopes: string[];
  iat: number;
  exp: number;
}

export interface CreateSandboxActorTokenInput {
  user: SandboxActorUserInput;
  /** The executing app. */
  appId: string;
  /**
   * Apps this token may call. `null` (or includes '*') => unrestricted, used
   * only when the executing app holds the broad `app:call` permission. The
   * executing app id is always added so self-calls work.
   */
  allowedAppIds?: string[] | null;
  scopes?: string[];
  executionId?: string;
  expiresInSeconds?: number;
  nowMs?: number;
}

export interface CreatedSandboxActorToken {
  token: string;
  claims: SandboxActorTokenClaims;
}

export function isSandboxActorToken(token: string): boolean {
  return token.startsWith(SANDBOX_ACTOR_TOKEN_PREFIX);
}

export async function createSandboxActorToken(
  input: CreateSandboxActorTokenInput,
): Promise<CreatedSandboxActorToken> {
  const userId = input.user.id?.trim();
  const userEmail = input.user.email?.trim();
  const appId = input.appId?.trim();
  if (!userId || !userEmail) {
    throw new SandboxActorTokenError(
      "user.id and user.email are required to mint a sandbox actor token",
    );
  }
  if (!appId) {
    throw new SandboxActorTokenError(
      "appId is required to mint a sandbox actor token",
    );
  }

  const allowedAppIds = input.allowedAppIds;
  const unrestricted = allowedAppIds == null || allowedAppIds.includes("*");
  const appIds = unrestricted
    ? ["*"]
    : dedupe([appId, ...allowedAppIds]);

  const scopes = dedupe(
    input.scopes && input.scopes.length > 0 ? input.scopes : DEFAULT_SCOPES,
  );

  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const ttl = Math.max(
    1,
    Math.min(
      MAX_TTL_SECONDS,
      Math.floor(input.expiresInSeconds ?? DEFAULT_TTL_SECONDS),
    ),
  );

  const claims: SandboxActorTokenClaims = {
    typ: CLAIM_TYPE,
    ver: 1,
    jti: input.executionId?.trim() || crypto.randomUUID(),
    sub: userId,
    user_id: userId,
    user_email: userEmail,
    user_tier: input.user.tier?.trim() || "free",
    provisional: input.user.provisional === true,
    app_id: appId,
    app_ids: appIds,
    function_names: ["*"],
    scopes,
    iat: nowSec,
    exp: nowSec + ttl,
  };

  const encodedClaims = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = await hmac(encodedClaims, getSigningSecret());
  return {
    token: `${SANDBOX_ACTOR_TOKEN_PREFIX}${encodedClaims}.${signature}`,
    claims,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && !!item.trim());
}

function parseClaims(value: unknown): SandboxActorTokenClaims | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (c.typ !== CLAIM_TYPE || c.ver !== 1) return null;
  if (typeof c.jti !== "string" || !c.jti) return null;
  if (typeof c.user_id !== "string" || !c.user_id) return null;
  if (c.sub !== c.user_id) return null;
  if (typeof c.user_email !== "string" || !c.user_email) return null;
  if (typeof c.user_tier !== "string" || !c.user_tier) return null;
  if (typeof c.provisional !== "boolean") return null;
  if (typeof c.app_id !== "string" || !c.app_id) return null;
  if (!isStringArray(c.app_ids) || c.app_ids.length === 0) return null;
  if (!isStringArray(c.function_names) || c.function_names.length === 0) {
    return null;
  }
  if (!isStringArray(c.scopes) || c.scopes.length === 0) return null;
  if (typeof c.iat !== "number" || !Number.isFinite(c.iat)) return null;
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return null;
  return c as unknown as SandboxActorTokenClaims;
}

export async function verifySandboxActorToken(
  token: string,
  nowMs = Date.now(),
): Promise<CreatedSandboxActorToken | null> {
  if (!isSandboxActorToken(token)) return null;

  const body = token.slice(SANDBOX_ACTOR_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return null;

  const encodedClaims = body.slice(0, dot);
  const providedSig = body.slice(dot + 1);
  if (!providedSig) return null;

  let secret: string;
  try {
    secret = getSigningSecret();
  } catch {
    return null;
  }

  const expectedSig = await hmac(encodedClaims, secret);
  if (!constantTimeEqual(expectedSig, providedSig)) return null;

  let parsed: SandboxActorTokenClaims | null;
  try {
    parsed = parseClaims(
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            base64UrlToString(encodedClaims),
            (ch) => ch.charCodeAt(0),
          ),
        ),
      ),
    );
  } catch {
    return null;
  }
  if (!parsed) return null;

  const nowSec = Math.floor(nowMs / 1000);
  if (parsed.exp <= nowSec) return null;
  if (parsed.iat > nowSec + 60) return null;

  return { token, claims: parsed };
}

/**
 * Derive the bearer the runtime injects into a sandbox for ultralight.call.
 * Returns null when there is no authenticated user (anonymous executions can't
 * make inter-app calls), so the SDK's existing "missing authToken" guard fires.
 *
 * Mirrors the sandbox's own __ulAllowsAppCall gate: an app with the broad
 * `app:call` permission gets an unrestricted token (matching what its code may
 * already call); otherwise the token is scoped to its declared dependency apps.
 */
export async function mintSandboxAuthToken(opts: {
  user: SandboxActorUserInput | null | undefined;
  appId: string;
  executionId?: string;
  hasBroadCallPermission: boolean;
  dependencyAppIds: string[];
}): Promise<string | null> {
  if (!opts.user?.id || !opts.user?.email) return null;
  const allowedAppIds = opts.hasBroadCallPermission
    ? null
    : dedupe(opts.dependencyAppIds);
  try {
    const { token } = await createSandboxActorToken({
      user: opts.user,
      appId: opts.appId,
      allowedAppIds,
      executionId: opts.executionId,
    });
    return token;
  } catch (err) {
    // Fail closed: without a token, inter-app calls are unavailable for this
    // execution (the SDK's call() surfaces that), but the rest of the run
    // proceeds. In production the signing secret is always configured.
    console.error("[SANDBOX] Failed to mint sandbox actor token:", err);
    return null;
  }
}
