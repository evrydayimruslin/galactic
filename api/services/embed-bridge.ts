import { getEnv } from '../lib/env.ts';

const EMBED_BRIDGE_PREFIX = 'ul_embed_';
const BRIDGE_SALT_LENGTH = 16;
const BRIDGE_IV_LENGTH = 12;
const DEFAULT_BRIDGE_TTL_SECONDS = 60;
const MAX_BRIDGE_TTL_SECONDS = 120;

export type EmbedBridgeAudience = 'desktop_embed' | 'launch_web';

export interface EmbedBridgeTokenPayload {
  v: 1;
  aud: EmbedBridgeAudience;
  sub: string;
  access_token: string;
  issued_at: number;
  expires_at: number;
  jti: string;
}

function encodeBase64Url(data: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...data));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  const normalized = remainder === 0 ? padded : `${padded}${'='.repeat(4 - remainder)}`;
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

async function deriveEmbedBridgeKey(salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const normalizedSalt = Uint8Array.from(salt);
  const keyData = encoder.encode(`embed-bridge:${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`);
  const keyMaterial = await crypto.subtle.importKey('raw', keyData, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: normalizedSalt as BufferSource,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function parsePayload(value: unknown): EmbedBridgeTokenPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (payload.v !== 1) return null;
  if (payload.aud !== 'desktop_embed' && payload.aud !== 'launch_web') return null;
  if (typeof payload.sub !== 'string' || !payload.sub) return null;
  if (typeof payload.access_token !== 'string' || !payload.access_token) return null;
  if (typeof payload.issued_at !== 'number' || !Number.isFinite(payload.issued_at)) return null;
  if (typeof payload.expires_at !== 'number' || !Number.isFinite(payload.expires_at)) return null;
  if (typeof payload.jti !== 'string' || !payload.jti) return null;
  return payload as unknown as EmbedBridgeTokenPayload;
}

function clampTtlSeconds(ttlSeconds?: number | null): number {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) {
    return DEFAULT_BRIDGE_TTL_SECONDS;
  }
  return Math.max(5, Math.min(MAX_BRIDGE_TTL_SECONDS, Math.floor(ttlSeconds)));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payloadText = new TextDecoder().decode(decodeBase64Url(parts[1]));
    const payload = JSON.parse(payloadText);
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function getAccessTokenRemainingLifetimeSeconds(token: string, nowMs = Date.now()): number | null {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return Math.max(0, Math.floor(exp - (nowMs / 1000)));
}

export async function issueEmbedBridgeToken(input: {
  accessToken: string;
  audience?: EmbedBridgeAudience;
  userId: string;
  ttlSeconds?: number | null;
  nowMs?: number;
}): Promise<{ token: string; expiresIn: number }> {
  const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
  const accessLifetime = getAccessTokenRemainingLifetimeSeconds(input.accessToken, nowMs);
  const requestedTtl = clampTtlSeconds(input.ttlSeconds);
  const effectiveTtl = accessLifetime === null
    ? requestedTtl
    : Math.max(1, Math.min(requestedTtl, accessLifetime));

  const payload: EmbedBridgeTokenPayload = {
    v: 1,
    aud: input.audience || 'desktop_embed',
    sub: input.userId,
    access_token: input.accessToken,
    issued_at: Math.floor(nowMs / 1000),
    expires_at: Math.floor(nowMs / 1000) + effectiveTtl,
    jti: crypto.randomUUID(),
  };

  const salt = crypto.getRandomValues(new Uint8Array(BRIDGE_SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(BRIDGE_IV_LENGTH));
  const key = await deriveEmbedBridgeKey(salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  const combined = new Uint8Array(BRIDGE_SALT_LENGTH + BRIDGE_IV_LENGTH + encrypted.byteLength);
  combined.set(salt);
  combined.set(iv, BRIDGE_SALT_LENGTH);
  combined.set(new Uint8Array(encrypted), BRIDGE_SALT_LENGTH + BRIDGE_IV_LENGTH);

  return {
    token: `${EMBED_BRIDGE_PREFIX}${encodeBase64Url(combined)}`,
    expiresIn: effectiveTtl,
  };
}

export async function consumeEmbedBridgeToken(
  token: string | null | undefined,
  nowMs = Date.now(),
): Promise<EmbedBridgeTokenPayload | null> {
  if (!token || !token.startsWith(EMBED_BRIDGE_PREFIX)) return null;

  try {
    const encoded = token.slice(EMBED_BRIDGE_PREFIX.length);
    const combined = decodeBase64Url(encoded);
    const salt = combined.slice(0, BRIDGE_SALT_LENGTH);
    const iv = combined.slice(BRIDGE_SALT_LENGTH, BRIDGE_SALT_LENGTH + BRIDGE_IV_LENGTH);
    const ciphertext = combined.slice(BRIDGE_SALT_LENGTH + BRIDGE_IV_LENGTH);
    const key = await deriveEmbedBridgeKey(salt);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const payload = parsePayload(JSON.parse(new TextDecoder().decode(decrypted)));
    if (!payload) return null;
    if (payload.expires_at <= Math.floor(nowMs / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
