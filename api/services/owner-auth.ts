// Owner-actor tokens — a short-lived bearer proving "this request is acting AS
// the platform owner". Minted host-side and accepted ONLY by the internal
// platform-admin routes (/api/admin/internal/*). It is the credential the
// owner's private management agents use to mutate platform-wide state (the first
// being the pre-install defaults registry) without any standing god-mode key
// (e.g. SUPABASE_SERVICE_ROLE_KEY) ever entering app code.
//
// SECURITY:
//   - Minted ONLY host-side, from the AUTHENTICATED execution-context user
//     (never from app/function arguments) — see the ADMIN runtime binding.
//   - Signed with OWNER_ACTOR_TOKEN_SECRET (a dedicated server-only secret).
//     Deliberately NOT WORKER_SECRET — that is injected into the sandbox and is
//     readable by app code, so signing with it would let sandbox code forge an
//     owner token. Mirrors sandbox-actor.ts / agent-caller-context.ts.
//   - REJECTED by the central authenticateRequest, so a leaked gxo_ token is
//     inert on every normal route (incl. /mcp/platform and account-session
//     routes). The ONLY acceptor is authenticateInternalAdmin below, which also
//     asserts the signed user_id === PLATFORM_OWNER_USER_ID.
//   - Short-lived (minutes) to bound replay of a leaked value.

import { getEnv } from "../lib/env.ts";

export const OWNER_ACTOR_TOKEN_PREFIX = "gxo_v1_";
const CLAIM_TYPE = "ultralight.owner_actor";
const DEFAULT_TTL_SECONDS = 2 * 60;
const MAX_TTL_SECONDS = 5 * 60;

export class OwnerActorTokenError extends Error {}

function getSigningSecret(): string {
  for (
    const key of [
      "OWNER_ACTOR_TOKEN_SECRET",
      // Server-only fallbacks. Deliberately NOT WORKER_SECRET (sandbox-exposed):
      // signing with a sandbox-readable secret would let app code forge a token.
      "AGENT_CALLER_SECRET",
      "ROUTINE_ACTOR_TOKEN_SECRET",
      "SUPABASE_SERVICE_ROLE_KEY",
    ]
  ) {
    const value = getEnv(key);
    if (value && value.trim()) return value.trim();
  }
  throw new OwnerActorTokenError(
    "Owner actor token signing secret is not configured",
  );
}

// base64url + HMAC-SHA256 + constant-time compare — mirrors sandbox-actor.ts,
// kept self-contained so this security primitive can be audited on its own.
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

export interface OwnerActorTokenClaims {
  typ: typeof CLAIM_TYPE;
  ver: 1;
  jti: string;
  sub: string;
  user_id: string;
  iat: number;
  exp: number;
}

export interface CreatedOwnerActorToken {
  token: string;
  claims: OwnerActorTokenClaims;
}

export function isOwnerActorToken(token: string): boolean {
  return token.startsWith(OWNER_ACTOR_TOKEN_PREFIX);
}

/**
 * Mint an owner-actor token for `userId`. The CALLER is responsible for passing
 * the authenticated execution-context user id (never an app-supplied value); the
 * acceptor (authenticateInternalAdmin) independently asserts it is the platform
 * owner, so a token minted for a non-owner is useless.
 */
export async function createOwnerActorToken(input: {
  userId: string;
  executionId?: string;
  expiresInSeconds?: number;
  nowMs?: number;
}): Promise<CreatedOwnerActorToken> {
  const userId = input.userId?.trim();
  if (!userId) {
    throw new OwnerActorTokenError(
      "userId is required to mint an owner actor token",
    );
  }
  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const ttl = Math.max(
    1,
    Math.min(
      MAX_TTL_SECONDS,
      Math.floor(input.expiresInSeconds ?? DEFAULT_TTL_SECONDS),
    ),
  );
  const claims: OwnerActorTokenClaims = {
    typ: CLAIM_TYPE,
    ver: 1,
    jti: input.executionId?.trim() || crypto.randomUUID(),
    sub: userId,
    user_id: userId,
    iat: nowSec,
    exp: nowSec + ttl,
  };
  const encodedClaims = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = await hmac(encodedClaims, getSigningSecret());
  return {
    token: `${OWNER_ACTOR_TOKEN_PREFIX}${encodedClaims}.${signature}`,
    claims,
  };
}

function parseClaims(value: unknown): OwnerActorTokenClaims | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (c.typ !== CLAIM_TYPE || c.ver !== 1) return null;
  if (typeof c.jti !== "string" || !c.jti) return null;
  if (typeof c.user_id !== "string" || !c.user_id) return null;
  if (c.sub !== c.user_id) return null;
  if (typeof c.iat !== "number" || !Number.isFinite(c.iat)) return null;
  if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return null;
  return c as unknown as OwnerActorTokenClaims;
}

export async function verifyOwnerActorToken(
  token: string,
  nowMs = Date.now(),
): Promise<CreatedOwnerActorToken | null> {
  if (!isOwnerActorToken(token)) return null;

  const body = token.slice(OWNER_ACTOR_TOKEN_PREFIX.length);
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

  let parsed: OwnerActorTokenClaims | null;
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
 * The ONLY acceptor of an owner-actor token. Verifies the signature + expiry,
 * then asserts the signed user_id is the configured platform owner. Returns the
 * owner user id on success, or null (fail-closed) when the bearer is missing,
 * invalid, expired, signed for a non-owner, or when PLATFORM_OWNER_USER_ID is
 * not configured. Never trusts a caller-supplied id — only the signed claim.
 */
export async function authenticateInternalAdmin(
  request: Request,
  nowMs = Date.now(),
): Promise<string | null> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;

  const verified = await verifyOwnerActorToken(token, nowMs);
  if (!verified) return null;

  const ownerId = getEnv("PLATFORM_OWNER_USER_ID").trim();
  if (!ownerId) return null; // not configured => fail closed
  if (verified.claims.user_id !== ownerId) return null;

  return ownerId;
}
