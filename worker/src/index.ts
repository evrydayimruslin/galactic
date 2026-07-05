// Galactic Data Layer Worker
// Cloudflare Worker providing native R2 data access + D1 query proxy for MCP app storage
//
// Architecture:
//   DO API Server (control plane + execution) → Worker (data layer)
//   - DO handles: auth, rate limiting, permissions, routing, code execution
//   - Worker handles: R2 storage ops with native bindings, D1 query proxy via CF HTTP API
//
// Auth: shared secret in X-Worker-Secret header
//
// Endpoints:
//   GET  /health                → health check
//   POST /data/store            → store a value (R2)
//   POST /data/load             → load a value (R2)
//   POST /data/remove           → remove a value (R2)
//   POST /data/list             → list keys (R2)
//   POST /data/batch-store      → store multiple values (R2)
//   POST /data/batch-load       → load multiple values (R2)
//   POST /data/batch-remove     → remove multiple values (R2)
//   POST /code/invalidate       → invalidate code cache

interface Env {
  R2_BUCKET: R2Bucket;
  CODE_CACHE: KVNamespace;
  WORKER_SECRET: string;
  ENVIRONMENT: string;
  // Per-tenant proof (defense-in-depth on top of X-Worker-Secret). MUST match
  // the API worker's DATA_TENANT_SECRET. Deliberately NOT WORKER_SECRET.
  DATA_TENANT_SECRET?: string;
  // "1"/"true" → reject any request lacking a valid tenant token. Default off
  // (observe-only) for safe rollout: deploy both workers, confirm tokens
  // validate in logs, then flip this to close the legacy unproven path.
  DATA_TENANT_ENFORCE?: string;
}

// Per-tenant proof verification — MUST stay algorithm-identical to the API
// worker's api/services/data-tenant-token.ts (mintDataTenantToken).
const DATA_TENANT_DEV_SECRET = 'galactic-dev-data-tenant-secret';

interface TenantClaims {
  v: number;
  appId: string;
  userId: string | null;
  iat: number;
  exp: number;
}

interface TenantVerifyResult {
  valid: boolean;
  claims?: TenantClaims;
  reason?: string;
}

function base64UrlToBytes(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function verifyTenantToken(
  token: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<TenantVerifyResult> {
  if (!token || !token.startsWith('gxd1.')) return { valid: false, reason: 'absent' };
  const body = token.slice('gxd1.'.length);
  const dot = body.indexOf('.');
  if (dot <= 0) return { valid: false, reason: 'malformed' };
  const encoded = body.slice(0, dot);
  const signature = body.slice(dot + 1);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = toHex(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded)),
  );
  if (!timingSafeEqual(signature, expected)) return { valid: false, reason: 'bad_signature' };
  let claims: TenantClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (claims.v !== 1 || typeof claims.appId !== 'string') {
    return { valid: false, reason: 'malformed' };
  }
  if (typeof claims.exp !== 'number' || Math.floor(nowMs / 1000) > claims.exp) {
    return { valid: false, reason: 'expired' };
  }
  if (claims.userId !== null && typeof claims.userId !== 'string') {
    return { valid: false, reason: 'malformed' };
  }
  return { valid: true, claims };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check (no auth required)
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({ status: 'ok', service: 'ultralight-data-worker' });
    }

    // Authenticate all other requests
    const secret = request.headers.get('X-Worker-Secret');
    if (!secret || secret !== env.WORKER_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // Per-tenant proof (defense-in-depth). X-Worker-Secret proves "an internal
    // caller"; the tenant token proves "authorized for THIS appId/userId" via a
    // secret that is not sandbox-exposed. When enforcing, a request without a
    // valid token is rejected — so a WORKER_SECRET leak alone cannot cross
    // tenants. Default observe-only: validate-if-present, warn, allow.
    const tenantSecret = env.DATA_TENANT_SECRET || DATA_TENANT_DEV_SECRET;
    const tenantEnforce = env.DATA_TENANT_ENFORCE === '1' ||
      env.DATA_TENANT_ENFORCE === 'true';
    // Footgun guard: enforcing with the publicly-known dev default in production
    // is FALSE security (anyone could forge a token). Fail closed loudly instead
    // of pretending to be protected — forces a real DATA_TENANT_SECRET to be set.
    const usingDevTenantSecret = !env.DATA_TENANT_SECRET ||
      env.DATA_TENANT_SECRET === DATA_TENANT_DEV_SECRET;
    if (tenantEnforce && env.ENVIRONMENT === 'production' && usingDevTenantSecret) {
      console.error('[WORKER] DATA_TENANT_ENFORCE set but DATA_TENANT_SECRET is unset/default in production — refusing to serve');
      return json({
        error: 'tenant enforcement misconfigured: set a non-default DATA_TENANT_SECRET',
      }, 503);
    }
    const tenant = await verifyTenantToken(
      request.headers.get('X-Tenant-Token'),
      tenantSecret,
    );
    if (!tenant.valid && tenantEnforce) {
      return json({ error: 'tenant proof required', reason: tenant.reason }, 403);
    }

    try {
      // (Removed) POST /code/fetch — served any app's private R2 source bundle
      // to any caller with a valid tenant token, with no appId↔token binding.
      // It had no in-repo caller (code bundles load via r2Service); deleted.

      // ============================================
      // CODE CACHE INVALIDATION
      // ============================================
      if (request.method === 'POST' && url.pathname === '/code/invalidate') {
        const { appId } = await request.json() as { appId: string };
        if (!appId) return json({ error: 'Missing appId' }, 400);

        // KV doesn't support prefix deletion, so we just let entries expire (5 min TTL)
        // For immediate invalidation, the caller can pass the specific storageKey
        return json({ ok: true });
      }

      // ============================================
      // DATA OPERATIONS
      // ============================================
      if (request.method === 'POST' && url.pathname.startsWith('/data/')) {
        const op = url.pathname.replace('/data/', '');
        const body = await request.json() as Record<string, unknown>;
        const bodyAppId = body.appId as string;
        const bodyUserId = body.userId as string | undefined;

        if (!bodyAppId) return json({ error: 'Missing appId' }, 400);

        // The tenant token is authoritative for WHICH tenant this touches. When
        // present it MUST match the requested appId/userId (so a forged body
        // can't redirect a valid token at another tenant), and we then build the
        // R2 path from the SIGNED identity — never from the (untrusted) body.
        // When absent/invalid we are in observe mode (enforce already rejected
        // above) — warn so the rollout is visible before flipping enforce.
        let appId = bodyAppId;
        let userId = bodyUserId;
        if (tenant.valid) {
          const claimUser = tenant.claims!.userId ?? null;
          if (tenant.claims!.appId !== bodyAppId || claimUser !== (bodyUserId ?? null)) {
            return json({ error: 'tenant token mismatch' }, 403);
          }
          appId = tenant.claims!.appId;
          userId = tenant.claims!.userId ?? undefined;
        } else {
          console.warn('[WORKER] /data tenant proof missing/invalid (observe mode)', {
            op: op,
            appId: bodyAppId,
            reason: tenant.reason,
          });
        }

        const dataPrefix = userId
          ? `apps/${appId}/users/${userId}/data/`
          : `apps/${appId}/data/`;

        switch (op) {
          case 'store': {
            const key = sanitizeKey(body.key as string);
            const path = `${dataPrefix}${key}.json`;
            // Include _size_bytes for metering delta tracking
            const payload = {
              key: key,
              value: body.value,
              updated_at: new Date().toISOString(),
              _size_bytes: 0,
            };
            const baseData = JSON.stringify(payload);
            const sizeBytes = new TextEncoder().encode(baseData).length;
            payload._size_bytes = sizeBytes;
            const data = JSON.stringify(payload);
            await env.R2_BUCKET.put(path, data, {
              httpMetadata: { contentType: 'application/json' },
            });
            return json({ ok: true, _size_bytes: sizeBytes });
          }

          case 'load': {
            const key = sanitizeKey(body.key as string);
            const path = `${dataPrefix}${key}.json`;
            const obj = await env.R2_BUCKET.get(path);
            if (!obj) return json({ value: null });
            const parsed = JSON.parse(await obj.text());
            return json({ value: parsed.value });
          }

          case 'remove': {
            const key = sanitizeKey(body.key as string);
            const path = `${dataPrefix}${key}.json`;
            await env.R2_BUCKET.delete(path);
            return json({ ok: true });
          }

          case 'list': {
            const prefix = body.prefix as string | undefined;
            const searchPrefix = prefix
              ? `${dataPrefix}${sanitizeKey(prefix)}`
              : dataPrefix;
            const listed = await env.R2_BUCKET.list({ prefix: searchPrefix });
            const keys = listed.objects
              .filter(obj => obj.key.endsWith('.json'))
              .map(obj => obj.key.replace(dataPrefix, '').replace('.json', ''));
            return json({ keys: keys });
          }

          case 'batch-store': {
            const items = body.items as Array<{ key: string; value: unknown }>;
            if (!items || !Array.isArray(items)) return json({ error: 'Missing items array' }, 400);

            // Process in parallel batches of 10
            const BATCH_SIZE = 10;
            let totalSizeBytes = 0;
            for (let i = 0; i < items.length; i += BATCH_SIZE) {
              const batch = items.slice(i, i + BATCH_SIZE);
              await Promise.all(batch.map(item => {
                const key = sanitizeKey(item.key);
                const path = `${dataPrefix}${key}.json`;
                // Include _size_bytes for metering delta tracking
                const payload = {
                  key: key,
                  value: item.value,
                  updated_at: new Date().toISOString(),
                  _size_bytes: 0,
                };
                const baseData = JSON.stringify(payload);
                const sizeBytes = new TextEncoder().encode(baseData).length;
                payload._size_bytes = sizeBytes;
                totalSizeBytes += sizeBytes;
                const data = JSON.stringify(payload);
                return env.R2_BUCKET.put(path, data, {
                  httpMetadata: { contentType: 'application/json' },
                });
              }));
            }
            return json({ ok: true, _total_size_bytes: totalSizeBytes });
          }

          case 'batch-load': {
            const keys = body.keys as string[];
            if (!keys || !Array.isArray(keys)) return json({ error: 'Missing keys array' }, 400);

            const results = await Promise.all(keys.map(async (k) => {
              const key = sanitizeKey(k);
              const path = `${dataPrefix}${key}.json`;
              const obj = await env.R2_BUCKET.get(path);
              if (!obj) return { key: k, value: null };
              try {
                const parsed = JSON.parse(await obj.text());
                return { key: k, value: parsed.value };
              } catch {
                return { key: k, value: null };
              }
            }));
            return json({ items: results });
          }

          case 'batch-remove': {
            const keys = body.keys as string[];
            if (!keys || !Array.isArray(keys)) return json({ error: 'Missing keys array' }, 400);

            // R2 supports multi-delete
            const paths = keys.map(k => `${dataPrefix}${sanitizeKey(k)}.json`);
            const BATCH_SIZE = 100;
            for (let i = 0; i < paths.length; i += BATCH_SIZE) {
              await env.R2_BUCKET.delete(paths.slice(i, i + BATCH_SIZE));
            }
            return json({ ok: true });
          }

          default:
            return json({ error: `Unknown operation: ${op}` }, 404);
        }
      }

      // (Removed) POST /d1/query and /d1/batch — executed arbitrary SQL against
      // a body-supplied databaseId with no appId↔token binding and no user_id
      // scoping, fully bypassing the API worker's scoped-query builder. They had
      // no in-repo caller (app D1 access goes through the API worker's scoped
      // D1 data service); deleted to remove the cross-tenant surface.

      return json({ error: 'Not found' }, 404);

    } catch (err) {
      console.error('[WORKER] Error:', err);
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  },
};

// ============================================
// HELPERS
// ============================================

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sanitizeKey(key: string): string {
  return key
    .replace(/[^a-zA-Z0-9\-_\/]/g, '_')
    .replace(/\/+/g, '/')
    .replace(/^\//, '')
    .replace(/\/$/, '');
}
