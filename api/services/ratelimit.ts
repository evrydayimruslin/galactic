// Rate Limiting Service
// Uses Supabase table + RPC function for persistent, distributed rate limiting

import { getEnv } from '../lib/env.ts';
import { type EnforcementOptions, resolveEnforcementOptions } from './enforcement.ts';

// ============================================
// TYPES
// ============================================

export interface RateLimitConfig {
  endpoint: string;
  limit: number;
  windowMinutes: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  reason?: 'limit_exceeded' | 'service_unavailable';
}

export const BUILDER_STAGE_RATE_LIMIT_ENDPOINT = 'builder:stage';
export const BUILDER_STAGE_RATE_LIMIT_PER_MINUTE = 10;

// Default rate limits by endpoint
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'mcp:tools/list': { endpoint: 'mcp:tools/list', limit: 30, windowMinutes: 1 },
  'mcp:tools/call': {
    endpoint: 'mcp:tools/call',
    limit: 100,
    windowMinutes: 1,
  },
  'mcp:initialize': { endpoint: 'mcp:initialize', limit: 10, windowMinutes: 1 },
  'generate-docs': { endpoint: 'generate-docs', limit: 10, windowMinutes: 60 },
  'discover': { endpoint: 'discover', limit: 60, windowMinutes: 1 },
  'chat:stream': { endpoint: 'chat:stream', limit: 30, windowMinutes: 1 },
  'chat:models': { endpoint: 'chat:models', limit: 30, windowMinutes: 1 },
  [BUILDER_STAGE_RATE_LIMIT_ENDPOINT]: {
    endpoint: BUILDER_STAGE_RATE_LIMIT_ENDPOINT,
    limit: BUILDER_STAGE_RATE_LIMIT_PER_MINUTE,
    windowMinutes: 1,
  },
};

function fallbackRateLimitResult(
  endpoint: string,
  limit: number,
  windowMinutes: number,
  options?: EnforcementOptions,
  detail?: unknown,
): RateLimitResult {
  const enforcement = resolveEnforcementOptions(options, endpoint);
  const resetAt = new Date(Date.now() + windowMinutes * 60 * 1000);
  const prefix = '[RATE-LIMIT] Backend unavailable';
  const suffix = enforcement.mode === 'fail_closed'
    ? 'blocking request (fail-closed)'
    : 'allowing request (fail-open)';

  console.error(`${prefix} for ${enforcement.resource}, ${suffix}:`, detail);

  return {
    allowed: enforcement.mode !== 'fail_closed',
    remaining: enforcement.mode === 'fail_closed' ? 0 : limit,
    resetAt,
    reason: 'service_unavailable',
  };
}

// ============================================
// RATE LIMIT SERVICE
// ============================================

export class RateLimitService {
  private supabaseUrl: string;
  private supabaseKey: string;

  constructor() {
    const url = getEnv('SUPABASE_URL');
    const key = getEnv('SUPABASE_SERVICE_ROLE_KEY');

    if (!url || !key) {
      throw new Error('Supabase credentials not configured');
    }

    this.supabaseUrl = url;
    this.supabaseKey = key;
  }

  /**
   * Check if a request is allowed under rate limits
   * Uses Supabase RPC function for atomic increment + check
   */
  async checkLimit(
    userId: string,
    endpoint: string,
    limit?: number,
    windowMinutes?: number,
    options?: EnforcementOptions,
  ): Promise<RateLimitResult> {
    // Get config for this endpoint, or use defaults
    const config = RATE_LIMITS[endpoint] ||
      { endpoint, limit: 100, windowMinutes: 1 };
    const effectiveLimit = limit ?? config.limit;
    const effectiveWindow = windowMinutes ?? config.windowMinutes;

    try {
      // Call Supabase RPC function
      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/rpc/check_rate_limit`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.supabaseKey}`,
            'apikey': this.supabaseKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_user_id: userId,
            p_endpoint: endpoint,
            p_limit: effectiveLimit,
            p_window_minutes: effectiveWindow,
          }),
        },
      );

      if (!response.ok) {
        return fallbackRateLimitResult(
          endpoint,
          effectiveLimit,
          effectiveWindow,
          options,
          await response.text(),
        );
      }

      const allowed = await response.json();

      // Calculate remaining and reset time
      const windowStart = new Date();
      windowStart.setSeconds(0, 0); // Truncate to minute
      const resetAt = new Date(
        windowStart.getTime() + effectiveWindow * 60 * 1000,
      );

      return {
        allowed: allowed === true,
        remaining: allowed ? effectiveLimit - 1 : 0, // Approximate
        resetAt,
        reason: allowed ? undefined : 'limit_exceeded',
      };
    } catch (err) {
      return fallbackRateLimitResult(
        endpoint,
        effectiveLimit,
        effectiveWindow,
        options,
        err,
      );
    }
  }

  /**
   * Get rate limit headers for response
   */
  getRateLimitHeaders(
    result: RateLimitResult,
    endpoint: string,
  ): Record<string, string> {
    const config = RATE_LIMITS[endpoint] || { limit: 100 };
    return {
      'X-RateLimit-Limit': String(config.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.floor(result.resetAt.getTime() / 1000)),
    };
  }
}

// ============================================
// IN-MEMORY FALLBACK (for development/testing)
// ============================================

const inMemoryLimits = new Map<string, { count: number; resetAt: number }>();

/**
 * Simple in-memory rate limiter (fallback when Supabase not available)
 */
export function checkInMemoryLimit(
  userId: string,
  endpoint: string,
  limit = 100,
  windowMs = 60000,
): RateLimitResult {
  // Lazy cleanup (replaces top-level setInterval, which CF Workers don't allow)
  cleanupExpiredEntries();

  const key = `${userId}:${endpoint}`;
  const now = Date.now();

  let entry = inMemoryLimits.get(key);

  // Reset if window expired
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
    inMemoryLimits.set(key, entry);
  }

  entry.count++;
  const allowed = entry.count <= limit;

  return {
    allowed,
    remaining: Math.max(0, limit - entry.count),
    resetAt: new Date(entry.resetAt),
    reason: allowed ? undefined : 'limit_exceeded',
  };
}

// Cleanup old entries — called lazily on each check instead of setInterval
// (CF Workers don't allow setInterval at module scope)
function cleanupExpiredEntries() {
  const now = Date.now();
  for (const [key, entry] of inMemoryLimits) {
    if (entry.resetAt < now) {
      inMemoryLimits.delete(key);
    }
  }
}

// ============================================
// FACTORY
// ============================================

let rateLimitService: RateLimitService | null = null;

export function createRateLimitService(): RateLimitService {
  if (!rateLimitService) {
    rateLimitService = new RateLimitService();
  }
  return rateLimitService;
}

// UUID v4 pattern — the Supabase RPC expects p_user_id as UUID type
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check rate limit with fallback to in-memory if Supabase fails.
 * Non-UUID keys (e.g. IP addresses for unauthenticated requests) use the
 * in-memory limiter directly since the Supabase RPC requires a UUID.
 */
export async function checkRateLimit(
  userId: string,
  endpoint: string,
  limit?: number,
  windowMinutes?: number,
  options?: EnforcementOptions,
): Promise<RateLimitResult> {
  const config = RATE_LIMITS[endpoint] || { limit: 100, windowMinutes: 1 };
  const effectiveLimit = limit ?? config.limit;
  const effectiveWindow = windowMinutes ?? config.windowMinutes;

  // Non-UUID keys (IP addresses, 'anonymous') can't be sent to the
  // check_rate_limit RPC which expects p_user_id UUID — use in-memory.
  if (!UUID_RE.test(userId)) {
    return checkInMemoryLimit(
      userId,
      endpoint,
      effectiveLimit,
      effectiveWindow * 60 * 1000,
    );
  }

  try {
    const service = createRateLimitService();
    return await service.checkLimit(
      userId,
      endpoint,
      limit,
      windowMinutes,
      options,
    );
  } catch (err) {
    return fallbackRateLimitResult(
      endpoint,
      effectiveLimit,
      effectiveWindow,
      options,
      err,
    );
  }
}
