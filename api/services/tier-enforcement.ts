// Tier Enforcement Service
// Shared utility for checking tier-based restrictions.
// Enforces visibility checks, publish deposit gate, and app-count guardrails.

import {
  formatLight,
  MIN_PUBLISH_DEPOSIT_LIGHT,
  type Tier,
  TIER_LIMITS,
} from '../../shared/types/index.ts';
import { getEnv } from '../lib/env.ts';

type Visibility = 'private' | 'unlisted' | 'public';

/**
 * Check whether a visibility value is allowed for the given tier.
 * All visibilities are allowed for all tiers — publishing is gated by deposit, not tier.
 * Returns null (always allowed).
 */
export function checkVisibilityAllowed(
  _tier: Tier,
  _visibility: Visibility,
): string | null {
  return null;
}

/**
 * Check whether a user has sufficient Light balance to publish.
 * Publishing (visibility = 'public' or 'unlisted') requires a minimum deposit.
 * Returns null if allowed, or an error message string if blocked.
 */
export async function checkPublishDeposit(
  userId: string,
): Promise<string | null> {
  const supabaseUrl = getEnv('SUPABASE_URL');
  const supabaseKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseKey) {
    // Can't check — fail open
    console.warn('[TIER] Supabase not configured, skipping publish deposit check');
    return null;
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=balance_light`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      },
    );

    if (!response.ok) {
      console.error('[TIER] checkPublishDeposit: fetch failed:', await response.text());
      // Fail open — don't block users due to a DB issue
      return null;
    }

    const rows = await response.json() as Array<{ balance_light: number | null }>;
    const balance = rows[0]?.balance_light ?? 0;

    if (balance < MIN_PUBLISH_DEPOSIT_LIGHT) {
      return (
        `Publishing requires a minimum ${formatLight(MIN_PUBLISH_DEPOSIT_LIGHT)} deposit. ` +
        `Your current balance is ${formatLight(balance)}. ` +
        `Add Light from Wallet to go live.`
      );
    }

    return null; // Allowed
  } catch (err) {
    console.error('[TIER] checkPublishDeposit error:', err);
    return null; // Fail open
  }
}

/**
 * Check whether a user has room to create another app.
 * Returns null if allowed, or an error message string if at the limit.
 * Uses a lightweight HEAD-style count query (select=count).
 */
export async function checkAppLimit(
  userId: string,
): Promise<string | null> {
  const supabaseUrl = getEnv('SUPABASE_URL');
  const supabaseKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseKey) return null; // fail open

  const maxApps = TIER_LIMITS.free.max_apps;
  if (!isFinite(maxApps)) return null; // no limit configured

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/apps?owner_id=eq.${userId}&deleted_at=is.null&select=id`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer': 'count=exact',
          'Range-Unit': 'items',
          'Range': '0-0', // don't fetch rows, just count
        },
      },
    );

    // Extract count from content-range header: "0-0/42"
    const contentRange = response.headers.get('content-range') || '';
    const match = contentRange.match(/\/(\d+)/);
    const appCount = match ? parseInt(match[1], 10) : 0;

    if (appCount >= maxApps) {
      return (
        `App limit reached (${appCount}/${maxApps}). ` +
        `Delete an unused app to create a new one.`
      );
    }

    return null; // Allowed
  } catch (err) {
    console.error('[TIER] checkAppLimit error:', err);
    return null; // fail open
  }
}

/**
 * Get the user's tier from the database.
 * Lightweight helper — avoids importing the full user service.
 */
export async function getUserTier(userId: string): Promise<Tier> {
  const supabaseUrl = getEnv('SUPABASE_URL');
  const supabaseKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=tier`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      },
    );

    if (!response.ok) {
      console.error('getUserTier: fetch failed:', await response.text());
      return 'free';
    }

    const users = await response.json() as Array<{ tier?: Tier | null }>;
    return (users[0]?.tier || 'free') as Tier;
  } catch (err) {
    console.error('getUserTier: error:', err);
    return 'free';
  }
}
