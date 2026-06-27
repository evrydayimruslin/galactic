// Provisional User Service
// Handles creation, validation, merge, and cleanup of provisional (pre-auth) users.
// Provisional users get working API tokens without OAuth, enabling zero-friction onboarding.

import { createToken } from './tokens.ts';
import { checkRateLimit } from './ratelimit.ts';
import { getEnv } from '../lib/env.ts';


// ============================================
// CONSTANTS
// ============================================

const MAX_PROVISIONALS_PER_IP = 3;        // 3 provisional tokens per IP per day
const PROVISIONAL_DAILY_CALL_LIMIT = 50;  // 50 MCP calls/day hard limit
const PROVISIONAL_STORAGE_LIMIT = 5 * 1024 * 1024; // 5MB
const INACTIVITY_EXPIRY_MS = 24 * 60 * 60 * 1000;  // 24 hours

function withStatus(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// ============================================
// TYPES
// ============================================

export interface ProvisionalCreateResult {
  id: string;
  token: string;     // Plaintext token (gx_xxx), shown once
  tokenId: string;
}

export interface MergeResult {
  apps_moved: number;
  tokens_moved: number;
  storage_transferred_bytes: number;
}

export type MergeMethod = 'oauth_callback' | 'mcp_auth_link' | 'api_merge';

export interface ConversionEventData {
  provisional_user_id: string;
  real_user_id: string;
  merge_method: MergeMethod;
  provisional_created_at: string | null;
  provisional_ip: string | null;
  calls_as_provisional: number;
  apps_used_as_provisional: number;
  first_app_id: string | null;
  first_app_name: string | null;
  apps_moved: number;
  tokens_moved: number;
  storage_transferred_bytes: number;
  time_to_convert_minutes: number | null;
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Create a new provisional user with a working API token.
 * Rate limited to 3 per IP per 24 hours.
 */
export async function createProvisionalUser(clientIp: string): Promise<ProvisionalCreateResult> {
  const ipCount = await countProvisionalsByIp(clientIp);
  console.log(`[PROVISIONAL] IP ${clientIp} has ${ipCount} provisionals in last 24h (limit: ${MAX_PROVISIONALS_PER_IP})`);
  if (ipCount >= MAX_PROVISIONALS_PER_IP) {
    throw withStatus(
      `Rate limit: ${MAX_PROVISIONALS_PER_IP} provisional accounts per IP per day`,
      429,
    );
  }

  // Generate a stable UUID for the provisional user
  const userId = crypto.randomUUID();
  const email = `provisional-${userId}@ultralight.local`;

  // 1. Create auth.users entry via Supabase Admin API (satisfies FK constraint)
  const randomPassword = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  const authResponse = await fetch(`${getEnv('SUPABASE_URL')}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
      'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: userId,
      email: email,
      password: randomPassword,
      email_confirm: true,
    }),
  });

  if (!authResponse.ok) {
    const errText = await authResponse.text();
    console.error('[PROVISIONAL] Failed to create auth.users entry:', errText);
    throw new Error('Failed to create provisional user');
  }

  // 2. Create public.users entry
  const userInsertResponse = await fetch(`${getEnv('SUPABASE_URL')}/rest/v1/users`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
      'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      id: userId,
      email: email,
      provisional: true,
      provisional_created_ip: clientIp,
      provisional_created_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      storage_limit_bytes: PROVISIONAL_STORAGE_LIMIT,
    }),
  });

  if (!userInsertResponse.ok) {
    const errText = await userInsertResponse.text();
    console.error('[PROVISIONAL] Failed to create public.users entry:', errText);
    // Rollback: delete auth.users entry
    await deleteAuthUser(userId);
    throw new Error('Failed to create provisional user record');
  }

  // 3. Create API token
  const tokenResult = await createToken(userId, 'Provisional Token', {
    expiresInDays: 30,
  });

  console.log(`[PROVISIONAL] Created provisional user ${userId} from IP ${clientIp}`);

  return {
    id: userId,
    token: tokenResult.plaintext_token,
    tokenId: tokenResult.token.id,
  };
}

/**
 * Check if a user is provisional.
 */
export async function isProvisionalUser(userId: string): Promise<boolean> {
  const response = await fetch(
    `${getEnv('SUPABASE_URL')}/rest/v1/users?id=eq.${userId}&select=provisional`,
    {
      headers: {
        'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
        'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      },
    }
  );

  if (!response.ok) return false;

  const data = await response.json() as Array<{ provisional?: boolean }>;
  return data?.[0]?.provisional === true;
}

/**
 * Check provisional daily call limit using the existing rate limit system.
 * Uses a custom bucket "provisional_daily:{userId}" with 50 calls/day window.
 */
export async function checkProvisionalDailyLimit(userId: string) {
  return checkRateLimit(
    userId,
    `provisional_daily:${userId}`,
    PROVISIONAL_DAILY_CALL_LIMIT,
    1440,
    { mode: 'fail_closed', resource: 'provisional daily call limit' },
  );
}

/**
 * Update last_active_at for a provisional user.
 * Fire-and-forget — does not await, does not throw.
 */
export function updateLastActive(userId: string): void {
  fetch(`${getEnv('SUPABASE_URL')}/rest/v1/users?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
      'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      last_active_at: new Date().toISOString(),
    }),
  }).catch(err => {
    console.warn('[PROVISIONAL] Failed to update last_active_at:', err.message);
  });
}

/**
 * Check if a provisional user has expired (no activity in 24 hours).
 */
export function isProvisionalExpired(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return true;
  const lastActive = new Date(lastActiveAt).getTime();
  return (Date.now() - lastActive) > INACTIVITY_EXPIRY_MS;
}

/**
 * Merge a provisional user into a real (authenticated) user.
 * Transfers all apps, tokens, and storage. Deletes the provisional user.
 * Logs a conversion event for analytics.
 */
export async function mergeProvisionalUser(
  provisionalUserId: string,
  realUserId: string,
  mergeMethod: MergeMethod = 'api_merge'
): Promise<MergeResult> {
  // Verify provisional user exists
  if (!await isProvisionalUser(provisionalUserId)) {
    throw new Error('Source user is not provisional');
  }

  // Prevent self-merge
  if (provisionalUserId === realUserId) {
    throw new Error('Cannot merge user into themselves');
  }

  // Gather provisional user metadata BEFORE merge (record gets deleted)
  const provMeta = await getProvisionalMetadata(provisionalUserId);

  // Gather call stats for the provisional user BEFORE merge
  const callStats = await getProvisionalCallStats(provisionalUserId);

  // Call the merge RPC (atomic transfer)
  const rpcResponse = await fetch(`${getEnv('SUPABASE_URL')}/rest/v1/rpc/merge_provisional_user`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
      'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_provisional_id: provisionalUserId,
      p_real_id: realUserId,
    }),
  });

  if (!rpcResponse.ok) {
    const errText = await rpcResponse.text();
    console.error('[PROVISIONAL] Merge RPC failed:', errText);
    throw new Error('Failed to merge provisional user');
  }

  const result = await rpcResponse.json() as {
    error?: string;
    apps_moved?: number;
    tokens_moved?: number;
    storage_transferred_bytes?: number;
  };

  // Check for RPC-level error
  if (result?.error) {
    throw new Error(result.error);
  }

  // Delete the provisional auth.users entry (cleanup)
  await deleteAuthUser(provisionalUserId);

  const mergeResult: MergeResult = {
    apps_moved: result.apps_moved || 0,
    tokens_moved: result.tokens_moved || 0,
    storage_transferred_bytes: result.storage_transferred_bytes || 0,
  };

  // Log conversion event (fire-and-forget)
  const timeToConvert = provMeta?.provisional_created_at
    ? Math.round((Date.now() - new Date(provMeta.provisional_created_at).getTime()) / 60000)
    : null;

  logConversionEvent({
    provisional_user_id: provisionalUserId,
    real_user_id: realUserId,
    merge_method: mergeMethod,
    provisional_created_at: provMeta?.provisional_created_at || null,
    provisional_ip: provMeta?.provisional_created_ip || null,
    calls_as_provisional: callStats.total_calls,
    apps_used_as_provisional: callStats.distinct_apps,
    first_app_id: callStats.first_app_id,
    first_app_name: callStats.first_app_name,
    apps_moved: mergeResult.apps_moved,
    tokens_moved: mergeResult.tokens_moved,
    storage_transferred_bytes: mergeResult.storage_transferred_bytes,
    time_to_convert_minutes: timeToConvert,
  });

  console.log(`[PROVISIONAL] Merged provisional ${provisionalUserId} → real ${realUserId} (${mergeMethod}):`, mergeResult);

  return mergeResult;
}

/**
 * Get the provisional storage limit in bytes.
 */
export function getProvisionalStorageLimit(): number {
  return PROVISIONAL_STORAGE_LIMIT;
}

/**
 * Get the provisional daily call limit.
 */
export function getProvisionalDailyCallLimit(): number {
  return PROVISIONAL_DAILY_CALL_LIMIT;
}

// ============================================
// INTERNAL HELPERS
// ============================================

/**
 * Count how many provisional users were created from this IP in the last 24 hours.
 */
async function countProvisionalsByIp(ip: string): Promise<number> {
  try {
    const response = await fetch(`${getEnv('SUPABASE_URL')}/rest/v1/rpc/count_provisional_by_ip`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
        'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_ip: ip }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('[PROVISIONAL] IP count RPC unavailable, blocking provisional creation:', detail);
      throw withStatus('Provisional signup is temporarily unavailable. Please try again shortly.', 503);
    }

    const count = await response.json();
    if (typeof count !== 'number') {
      console.error('[PROVISIONAL] IP count RPC returned invalid payload, blocking provisional creation:', count);
      throw withStatus('Provisional signup is temporarily unavailable. Please try again shortly.', 503);
    }

    return count;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'status' in err) {
      throw err;
    }
    console.error('[PROVISIONAL] IP count check failed, blocking provisional creation:', err);
    throw withStatus('Provisional signup is temporarily unavailable. Please try again shortly.', 503);
  }
}

/**
 * Delete an auth.users entry via Supabase Admin API.
 * Used for cleanup on creation failure and after merge.
 */
async function deleteAuthUser(userId: string): Promise<void> {
  try {
    await fetch(`${getEnv('SUPABASE_URL')}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
        'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      },
    });
  } catch (err) {
    console.warn(`[PROVISIONAL] Failed to delete auth.users entry for ${userId}:`, err);
  }
}

/**
 * Get provisional user metadata before merge (the record gets deleted).
 */
async function getProvisionalMetadata(userId: string): Promise<{
  provisional_created_at: string | null;
  provisional_created_ip: string | null;
} | null> {
  try {
    const response = await fetch(
      `${getEnv('SUPABASE_URL')}/rest/v1/users?id=eq.${userId}&select=provisional_created_at,provisional_created_ip`,
      {
        headers: {
          'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
          'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
        },
      }
    );
    if (!response.ok) return null;
    const data = await response.json() as Array<{
      provisional_created_at: string | null;
      provisional_created_ip: string | null;
    }>;
    return data?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Get MCP call stats for a provisional user (before merge deletes context).
 */
async function getProvisionalCallStats(userId: string): Promise<{
  total_calls: number;
  distinct_apps: number;
  first_app_id: string | null;
  first_app_name: string | null;
}> {
  try {
    // Get total calls and distinct apps
    const statsResponse = await fetch(
      `${getEnv('SUPABASE_URL')}/rest/v1/mcp_call_logs?user_id=eq.${userId}&select=app_id,app_name,created_at&order=created_at.asc`,
      {
        headers: {
          'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
          'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
        },
      }
    );

    if (!statsResponse.ok) {
      return { total_calls: 0, distinct_apps: 0, first_app_id: null, first_app_name: null };
    }

    const calls = await statsResponse.json() as Array<{ app_id: string | null; app_name: string | null; created_at: string }>;
    const appCalls = calls.filter((c: { app_id: string | null }) => c.app_id !== null);
    const distinctApps = new Set(appCalls.map((c: { app_id: string | null }) => c.app_id));
    const firstAppCall = appCalls[0] || null;

    return {
      total_calls: calls.length,
      distinct_apps: distinctApps.size,
      first_app_id: firstAppCall?.app_id || null,
      first_app_name: firstAppCall?.app_name || null,
    };
  } catch {
    return { total_calls: 0, distinct_apps: 0, first_app_id: null, first_app_name: null };
  }
}

/**
 * Log a conversion event. Fire-and-forget — does not block merge.
 */
function logConversionEvent(event: ConversionEventData): void {
  fetch(`${getEnv('SUPABASE_URL')}/rest/v1/conversion_events`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
      'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      provisional_user_id: event.provisional_user_id,
      real_user_id: event.real_user_id,
      merge_method: event.merge_method,
      provisional_created_at: event.provisional_created_at,
      provisional_ip: event.provisional_ip,
      calls_as_provisional: event.calls_as_provisional,
      apps_used_as_provisional: event.apps_used_as_provisional,
      first_app_id: event.first_app_id,
      first_app_name: event.first_app_name,
      apps_moved: event.apps_moved,
      tokens_moved: event.tokens_moved,
      storage_transferred_bytes: event.storage_transferred_bytes,
      time_to_convert_minutes: event.time_to_convert_minutes,
    }),
  }).catch(err => {
    console.warn('[PROVISIONAL] Failed to log conversion event:', err.message);
  });
}

/**
 * Log an onboarding template request. Fire-and-forget.
 */
export function logOnboardingRequest(clientIp: string | null, userAgent: string | null, referrer: string | null): void {
  fetch(`${getEnv('SUPABASE_URL')}/rest/v1/onboarding_requests`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
      'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      client_ip: clientIp,
      user_agent: userAgent,
      referrer: referrer,
      provisional_created: false,
    }),
  }).catch(err => {
    console.warn('[PROVISIONAL] Failed to log onboarding request:', err.message);
  });
}

/**
 * Mark that a provisional user was created for an IP (correlates with onboarding request).
 * Updates the most recent onboarding_request from this IP to set provisional_created=true.
 */
export function markOnboardingProvisionalCreated(clientIp: string): void {
  // Find the most recent onboarding request from this IP and mark it
  fetch(
    `${getEnv('SUPABASE_URL')}/rest/v1/onboarding_requests?client_ip=eq.${encodeURIComponent(clientIp)}&order=created_at.desc&limit=1`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`,
        'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ provisional_created: true }),
    }
  ).catch(err => {
    console.warn('[PROVISIONAL] Failed to mark onboarding provisional:', err.message);
  });
}
