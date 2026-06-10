// D1 Metering Service
// Tracks per-user-per-app D1 usage for billing and rate limiting.
// Usage is tracked in-database (_usage table within each app's D1).
// Periodically synced to Supabase for billing via d1-billing.ts cron.

import { getEnv } from '../lib/env.ts';
import { D1_FREE_TIER, D1_RATE_LIMITS } from '../../shared/types/index.ts';
import { type EnforcementOptions, resolveEnforcementOptions } from './enforcement.ts';

// ============================================
// TYPES
// ============================================

export interface D1UsageCheck {
  allowed: boolean;
  reason?: string;
  withinFreeTier: boolean;
  rowsReadTotal: number;
  rowsWrittenTotal: number;
  storageBytes: number;
}

// In-memory rate limiter (per-user-per-app, resets every minute)
interface RateLimitBucket {
  reads: number;
  writes: number;
  concurrent: number;
  windowStart: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

// ============================================
// RATE LIMITING
// ============================================

/**
 * Check and consume a rate limit slot for a D1 operation.
 * Returns true if allowed, false if rate-limited.
 */
export function checkD1RateLimit(
  userId: string,
  appId: string,
  tier: string,
  isWrite: boolean,
): { allowed: boolean; reason?: string } {
  const key = `${userId}:${appId}`;
  const limits = D1_RATE_LIMITS[tier] || D1_RATE_LIMITS['free'];
  const now = Date.now();

  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { reads: 0, writes: 0, concurrent: 0, windowStart: now };
    rateLimitBuckets.set(key, bucket);
  }

  if (isWrite) {
    if (bucket.writes >= limits.writes) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${limits.writes} writes/min for ${tier} tier`,
      };
    }
    bucket.writes++;
  } else {
    if (bucket.reads >= limits.reads) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${limits.reads} reads/min for ${tier} tier`,
      };
    }
    bucket.reads++;
  }

  return { allowed: true };
}

/**
 * Track concurrent D1 operations (acquire/release pattern).
 */
export function acquireD1ConcurrencySlot(
  userId: string,
  appId: string,
  tier: string,
): { allowed: boolean; reason?: string } {
  const key = `${userId}:${appId}`;
  const limits = D1_RATE_LIMITS[tier] || D1_RATE_LIMITS['free'];
  const now = Date.now();

  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { reads: 0, writes: 0, concurrent: 0, windowStart: now };
    rateLimitBuckets.set(key, bucket);
  }

  if (bucket.concurrent >= limits.concurrent) {
    return {
      allowed: false,
      reason: `Concurrent limit exceeded: ${limits.concurrent} for ${tier} tier`,
    };
  }

  bucket.concurrent++;
  return { allowed: true };
}

export function releaseD1ConcurrencySlot(userId: string, appId: string): void {
  const key = `${userId}:${appId}`;
  const bucket = rateLimitBuckets.get(key);
  if (bucket && bucket.concurrent > 0) {
    bucket.concurrent--;
  }
}

// ============================================
// FREE TIER CHECKS
// ============================================

/**
 * Check if a user is within D1 free tier via Supabase.
 * Called before executing D1 queries to determine if billing applies.
 */
export async function checkD1FreeTier(userId: string): Promise<D1UsageCheck> {
  return await checkD1FreeTierWithOptions(userId);
}

export async function checkD1FreeTierWithOptions(
  userId: string,
  options?: EnforcementOptions,
): Promise<D1UsageCheck> {
  const supabaseUrl = getEnv('SUPABASE_URL');
  const supabaseKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const enforcement = resolveEnforcementOptions(options, 'D1 free tier check');
  const unavailableResult = (): D1UsageCheck => ({
    allowed: enforcement.mode !== 'fail_closed',
    reason: 'service_unavailable',
    withinFreeTier: enforcement.mode !== 'fail_closed',
    rowsReadTotal: 0,
    rowsWrittenTotal: 0,
    storageBytes: 0,
  });

  if (!supabaseUrl || !supabaseKey) {
    return unavailableResult();
  }

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/check_d1_free_tier`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_user_id: userId }),
    });

    if (!res.ok) return unavailableResult();

    const rows = await res.json() as Array<{
      within_free_tier: boolean;
      rows_read_total: number;
      rows_written_total: number;
      storage_bytes: number;
    }>;

    const row = rows?.[0];
    if (!row) return unavailableResult();

    return {
      allowed: true, // Always allowed, but billing may apply
      withinFreeTier: row.within_free_tier,
      rowsReadTotal: row.rows_read_total,
      rowsWrittenTotal: row.rows_written_total,
      storageBytes: row.storage_bytes,
    };
  } catch (err) {
    console.error('[D1-METERING] Error checking free tier:', err);
    return unavailableResult();
  }
}

/**
 * Check if a user has sufficient balance for D1 operations.
 * Returns false (with 402-style reason) if user has exhausted free tier and has zero balance.
 */
export async function checkD1Balance(
  userId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  return await checkD1BalanceWithOptions(userId);
}

export async function checkD1BalanceWithOptions(
  userId: string,
  options?: EnforcementOptions,
): Promise<{ allowed: boolean; reason?: string }> {
  const supabaseUrl = getEnv('SUPABASE_URL');
  const supabaseKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const enforcement = resolveEnforcementOptions(options, 'D1 balance check');
  const unavailableResult = () => ({
    allowed: enforcement.mode !== 'fail_closed',
    reason: 'service_unavailable',
  });

  if (!supabaseUrl || !supabaseKey) return unavailableResult();

  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=balance_light,d1_rows_read_total,d1_rows_written_total`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      },
    );

    if (!res.ok) return unavailableResult();

    const rows = await res.json() as Array<{
      balance_light: number;
      d1_rows_read_total: number;
      d1_rows_written_total: number;
    }>;

    const user = rows?.[0];
    if (!user) return unavailableResult();

    // Within free tier — always allowed
    if (
      user.d1_rows_read_total < D1_FREE_TIER.ROWS_READ &&
      user.d1_rows_written_total < D1_FREE_TIER.ROWS_WRITTEN
    ) {
      return { allowed: true };
    }

    // Over free tier — need positive balance
    if (user.balance_light <= 0) {
      return {
        allowed: false,
        reason: 'Insufficient balance. D1 free tier exceeded. Add credits from Wallet.',
      };
    }

    return { allowed: true };
  } catch {
    return unavailableResult();
  }
}

// ============================================
// CLEANUP
// ============================================

/** Periodically clean up stale rate limit buckets (called from billing cron) */
export function cleanupRateLimitBuckets(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS * 5) {
      rateLimitBuckets.delete(key);
      cleaned++;
    }
  }
  return cleaned;
}
