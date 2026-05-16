import { getEnv } from "../lib/env.ts";
import { createServerLogger } from "./logging.ts";

export interface HttpRateLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
  resetAt: Date;
  source: "supabase" | "memory";
  reason?: "limit_exceeded" | "service_unavailable";
}

export interface CheckHttpRouteRateLimitParams {
  appId: string;
  functionName: string;
  identityHash: string;
  limitPerMinute: number;
  windowSeconds?: number;
}

interface HttpRouteRateLimitRow {
  allowed?: boolean;
  current_count?: number;
  limit_count?: number;
  remaining?: number;
  reset_at?: string;
}

interface HttpRateBucket {
  count: number;
  resetAt: number;
}

const logger = createServerLogger("HTTP-RATE");
const inMemoryRateBuckets = new Map<string, HttpRateBucket>();

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return { url, key };
}

function parseClientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getHttpClientIpForRateLimit(request: Request): string {
  return parseClientIp(request);
}

export async function createHttpRateLimitIdentityHash(
  request: Request,
): Promise<string> {
  const pepper = getEnv("ANALYTICS_PEPPER_V1") || getEnv("CHAT_CAPTURE_PEPPER");
  const ip = parseClientIp(request);
  const encoded = new TextEncoder().encode(
    `http-rate-limit:v1:${pepper}:${ip}`,
  );
  return `sha256:${toHex(await crypto.subtle.digest("SHA-256", encoded))}`;
}

function fallbackRateLimit(
  params: CheckHttpRouteRateLimitParams,
  detail?: unknown,
): HttpRateLimitResult {
  if (detail) {
    logger.error(
      "Durable HTTP route rate limit unavailable; using memory fallback",
      {
        app_id: params.appId,
        function_name: params.functionName,
        error: detail,
      },
    );
  }

  const windowSeconds = params.windowSeconds ?? 60;
  const windowMs = windowSeconds * 1000;
  const now = Date.now();
  for (const [key, bucket] of inMemoryRateBuckets) {
    if (bucket.resetAt < now) {
      inMemoryRateBuckets.delete(key);
    }
  }

  const key = [
    params.appId,
    params.functionName || "handler",
    params.identityHash,
    windowSeconds,
  ].join(":");
  let bucket = inMemoryRateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + windowMs };
    inMemoryRateBuckets.set(key, bucket);
  }

  bucket.count++;
  const limit = Math.max(Math.floor(params.limitPerMinute), 1);
  const allowed = bucket.count <= limit;
  return {
    allowed,
    currentCount: bucket.count,
    limit,
    remaining: Math.max(limit - bucket.count, 0),
    resetAt: new Date(bucket.resetAt),
    source: "memory",
    reason: allowed ? "service_unavailable" : "limit_exceeded",
  };
}

function parseRpcResult(value: unknown): HttpRouteRateLimitRow | null {
  if (Array.isArray(value)) {
    return value[0] && typeof value[0] === "object"
      ? value[0] as HttpRouteRateLimitRow
      : null;
  }
  return value && typeof value === "object"
    ? value as HttpRouteRateLimitRow
    : null;
}

export async function checkHttpRouteRateLimit(
  params: CheckHttpRouteRateLimitParams,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<HttpRateLimitResult> {
  const limit = Math.max(Math.floor(params.limitPerMinute), 1);
  const windowSeconds = params.windowSeconds ?? 60;
  const supabase = getSupabaseConfig();
  if (!supabase) {
    return fallbackRateLimit({
      ...params,
      limitPerMinute: limit,
      windowSeconds,
    });
  }

  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const response = await fetchFn(
      `${supabase.url}/rest/v1/rpc/check_http_route_rate_limit`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${supabase.key}`,
          "apikey": supabase.key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_app_id: params.appId,
          p_function_name: params.functionName || "handler",
          p_identity_hash: params.identityHash,
          p_limit: limit,
          p_window_seconds: windowSeconds,
        }),
      },
    );

    if (!response.ok) {
      return fallbackRateLimit(
        { ...params, limitPerMinute: limit, windowSeconds },
        await response.text(),
      );
    }

    const row = parseRpcResult(await response.json());
    if (!row || typeof row.allowed !== "boolean") {
      return fallbackRateLimit(
        { ...params, limitPerMinute: limit, windowSeconds },
        "Unexpected check_http_route_rate_limit response",
      );
    }

    const resetAt = row.reset_at ? new Date(row.reset_at) : new Date(
      Date.now() + windowSeconds * 1000,
    );
    return {
      allowed: row.allowed,
      currentCount: row.current_count ?? 0,
      limit: row.limit_count ?? limit,
      remaining: row.remaining ?? Math.max(limit - (row.current_count ?? 0), 0),
      resetAt,
      source: "supabase",
      reason: row.allowed ? undefined : "limit_exceeded",
    };
  } catch (err) {
    return fallbackRateLimit(
      { ...params, limitPerMinute: limit, windowSeconds },
      err,
    );
  }
}

export function buildHttpRateLimitHeaders(
  result: Pick<HttpRateLimitResult, "limit" | "remaining" | "resetAt">,
): Record<string, string> {
  const retryAfter = Math.max(
    Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
    0,
  );
  return {
    "Retry-After": String(retryAfter),
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.floor(result.resetAt.getTime() / 1000)),
  };
}

export function resetHttpRouteRateLimitMemoryForTests(): void {
  inMemoryRateBuckets.clear();
}
