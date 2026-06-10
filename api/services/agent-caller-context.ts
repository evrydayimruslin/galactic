// Signed caller-context tokens for cross-Agent calls (Phase 4a / P5).
//
// When the runtime initiates a cross-Agent call (Agent A -> Agent B for user
// U), it mints one of these server-side and attaches it as the
// X-Ultralight-Caller header. The target's MCP chokepoint verifies it to learn
// WHO is calling (caller app id + user) without trusting anything the sandbox
// could forge, then runs the grant check.
//
// SECURITY: the signing secret must NOT be one that is injected into the
// dynamic-worker sandbox. WORKER_SECRET is passed into the sandbox (for the
// /api/net/* X-Worker-Secret calls) and is therefore readable by app code, so
// it is explicitly excluded here. We use a dedicated AGENT_CALLER_SECRET, with
// fallbacks to other server-only secrets. The token is also injected into the
// sandbox so the SDK can attach it — but because it only ever asserts the
// caller's OWN app id (signed), an app reading it cannot impersonate another
// caller; it can only assert what is already true.

import { getEnv } from "../lib/env.ts";
import {
  type AgentCallerContextClaims,
  MAX_AGENT_CALL_HOP_DEPTH,
} from "../../shared/contracts/agent-grants.ts";

const TOKEN_PREFIX = "ulc1.";
// Short-lived: a cross-Agent hop chain completes in well under a minute, and a
// tight TTL bounds replay of a leaked token (jti consumption is a 4c
// hardening). Generous enough for deep chains within the hop ceiling.
const DEFAULT_TTL_SECONDS = 60;

export class AgentCallerContextError extends Error {}

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
  throw new AgentCallerContextError(
    "Caller-context signing secret is not configured",
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

export interface MintCallerContextInput {
  callerAppId: string;
  userId: string;
  callerFunction?: string | null;
  // Hop of the INCOMING context (0 for a top-level user/agent call). The minted
  // token carries incomingHop + 1.
  incomingHop?: number;
  ttlSeconds?: number;
  nowMs?: number;
}

export async function mintCallerContextToken(
  input: MintCallerContextInput,
): Promise<string> {
  const callerAppId = input.callerAppId.trim();
  const userId = input.userId.trim();
  if (!callerAppId || !userId) {
    throw new AgentCallerContextError(
      "callerAppId and userId are required to mint a caller context",
    );
  }

  const nowMs = typeof input.nowMs === "number" ? input.nowMs : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const ttl = Math.max(1, Math.floor(input.ttlSeconds ?? DEFAULT_TTL_SECONDS));
  const hop = Math.max(0, Math.floor(input.incomingHop ?? 0)) + 1;

  const claims: AgentCallerContextClaims = {
    v: 1,
    callerAppId,
    userId,
    callerFunction: input.callerFunction?.trim() || null,
    hop,
    issuedAt: nowSec,
    expiresAt: nowSec + ttl,
    jti: crypto.randomUUID(),
  };

  const encodedClaims = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = await hmac(encodedClaims, getSigningSecret());
  return `${TOKEN_PREFIX}${encodedClaims}.${signature}`;
}

function parseClaims(value: unknown): AgentCallerContextClaims | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (c.v !== 1) return null;
  if (typeof c.callerAppId !== "string" || !c.callerAppId) return null;
  if (typeof c.userId !== "string" || !c.userId) return null;
  if (c.callerFunction !== null && typeof c.callerFunction !== "string") {
    return null;
  }
  if (typeof c.hop !== "number" || !Number.isFinite(c.hop) || c.hop < 1) {
    return null;
  }
  if (typeof c.issuedAt !== "number" || typeof c.expiresAt !== "number") {
    return null;
  }
  if (typeof c.jti !== "string" || !c.jti) return null;
  return c as unknown as AgentCallerContextClaims;
}

export interface VerifyCallerContextResult {
  claims: AgentCallerContextClaims | null;
  // Distinguishes "absent" (no header) from "present but invalid/expired" so
  // the caller can fail closed on tampering while allowing direct calls.
  error?: "malformed" | "bad_signature" | "expired" | "hop_exceeded";
}

export async function verifyCallerContextToken(
  token: string | null | undefined,
  nowMs = Date.now(),
): Promise<VerifyCallerContextResult> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) {
    return { claims: null };
  }

  const body = token.slice(TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return { claims: null, error: "malformed" };

  const encodedClaims = body.slice(0, dot);
  const providedSig = body.slice(dot + 1);

  let secret: string;
  try {
    secret = getSigningSecret();
  } catch {
    // No signing secret configured ⇒ cannot trust any caller context.
    return { claims: null, error: "bad_signature" };
  }

  const expectedSig = await hmac(encodedClaims, secret);
  if (!constantTimeEqual(expectedSig, providedSig)) {
    return { claims: null, error: "bad_signature" };
  }

  let parsed: AgentCallerContextClaims | null;
  try {
    parsed = parseClaims(
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(base64UrlToString(encodedClaims), (ch) =>
            ch.charCodeAt(0)),
        ),
      ),
    );
  } catch {
    return { claims: null, error: "malformed" };
  }
  if (!parsed) return { claims: null, error: "malformed" };

  if (parsed.expiresAt <= Math.floor(nowMs / 1000)) {
    return { claims: null, error: "expired" };
  }
  if (parsed.hop > MAX_AGENT_CALL_HOP_DEPTH) {
    return { claims: null, error: "hop_exceeded" };
  }

  return { claims: parsed };
}
