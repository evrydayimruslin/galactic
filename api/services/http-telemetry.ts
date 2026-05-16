import { getEnv } from "../lib/env.ts";
import { createServerLogger } from "./logging.ts";

export interface HttpAuditParams {
  appId: string;
  functionName: string;
  endpoint: string;
  method: string;
  identityHash?: string | null;
  userAgent?: string | null;
  origin?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  authState?: "authenticated" | "anonymous" | null;
  rateLimited?: boolean;
  receiptId?: string | null;
}

const logger = createServerLogger("HTTP-TELEMETRY");

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-ultralight-webhook-secret",
  "x-webhook-secret",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-signature",
  "stripe-signature",
  "x-slack-signature",
  "x-shopify-hmac-sha256",
]);

const SENSITIVE_KEY_RE =
  /(authorization|cookie|token|secret|signature|api[-_]?key|apikey|password|credential)/i;

function shouldRedactKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(normalized) ||
    SENSITIVE_KEY_RE.test(normalized);
}

function redactRecord(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = shouldRedactKey(key) ? "[REDACTED]" : value;
  }
  return redacted;
}

function safeDecodeQueryKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, " "));
  } catch {
    return rawKey;
  }
}

function redactUrlValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.includes("?")) {
    return value;
  }

  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex < 0) return value;

  const prefix = beforeHash.slice(0, queryIndex);
  const query = beforeHash.slice(queryIndex + 1);
  const redactedQuery = query.split("&").map((part) => {
    if (!part) return part;
    const equalsIndex = part.indexOf("=");
    const rawKey = equalsIndex >= 0 ? part.slice(0, equalsIndex) : part;
    const key = safeDecodeQueryKey(rawKey);
    if (!shouldRedactKey(key)) return part;
    return `${rawKey}=[REDACTED]`;
  }).join("&");

  return `${prefix}?${redactedQuery}${hash}`;
}

export function sanitizeHttpRequestForLogs(
  request: {
    method?: unknown;
    url?: unknown;
    path?: unknown;
    query?: Record<string, unknown>;
    headers?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return {
    method: request.method,
    url: redactUrlValue(request.url),
    path: request.path,
    query: redactRecord(request.query),
    headers: redactRecord(request.headers),
  };
}

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return { url, key };
}

export async function recordHttpRequest(
  params: HttpAuditParams,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<void> {
  const supabase = getSupabaseConfig();
  if (!supabase) return;

  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${supabase.url}/rest/v1/http_requests`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${supabase.key}`,
        "apikey": supabase.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        app_id: params.appId,
        endpoint: params.endpoint,
        function_name: params.functionName,
        method: params.method,
        ip_address: null,
        identity_hash: params.identityHash ?? null,
        user_agent: params.userAgent ?? null,
        origin: params.origin ?? null,
        status_code: params.statusCode ?? null,
        duration_ms: params.durationMs ?? null,
        auth_state: params.authState ?? null,
        rate_limited: params.rateLimited ?? false,
        receipt_id: params.receiptId ?? null,
      }),
    });

    if (!response.ok) {
      logger.error("HTTP request audit insert returned a non-OK response", {
        status: response.status,
        app_id: params.appId,
        function_name: params.functionName,
        body: await response.text(),
      });
    }
  } catch (err) {
    logger.error("Failed to persist HTTP request audit row", {
      app_id: params.appId,
      function_name: params.functionName,
      error: err,
    });
  }
}
