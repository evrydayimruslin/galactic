// Data Storage Soft-Cap Service
// Tracks user-generated data storage (via ultralight.store/batchStore) per user.
// Combined with storage_used_bytes (app source code) to report a 100MB soft cap.
// Overage billed at DATA_RATE_LIGHT_PER_MB_PER_HOUR from balance_light.

import { getEnv } from '../lib/env.ts';
import { COMBINED_FREE_TIER_BYTES } from '../../shared/types/index.ts';
import { resolveEnforcementOptions, type EnforcementOptions } from './enforcement.ts';

// ============================================
// TYPES
// ============================================

export interface DataQuotaResult {
  allowed: boolean;
  source_used_bytes: number;
  data_used_bytes: number;
  combined_used_bytes: number;
  limit_bytes: number;
  remaining_bytes: number;
  has_hosting_balance: boolean;
  over_soft_cap?: boolean;
  reason?: 'quota_exceeded' | 'service_unavailable';
}

export interface DataStorageAdjustResult {
  new_bytes: number;
  combined_bytes: number;
  storage_limit: number;
  over_limit: boolean;
}

function unavailableDataQuotaResult(
  additionalBytes: number,
  options?: EnforcementOptions,
  detail?: unknown,
): DataQuotaResult {
  const enforcement = resolveEnforcementOptions(options, 'data soft-cap check');

  console.error(
    `[DATA-QUOTA] Soft-cap backend unavailable for ${enforcement.resource}; allowing write. Additional bytes=${additionalBytes}:`,
    detail,
  );

  return {
    allowed: true,
    source_used_bytes: 0,
    data_used_bytes: 0,
    combined_used_bytes: 0,
    limit_bytes: COMBINED_FREE_TIER_BYTES,
    remaining_bytes: COMBINED_FREE_TIER_BYTES,
    has_hosting_balance: false,
    over_soft_cap: false,
    reason: 'service_unavailable',
  };
}

// ============================================
// QUOTA CHECK
// ============================================

/**
 * Read a user's data storage soft-cap status.
 * Combined budget: storage_used_bytes (source code) + data_storage_used_bytes
 * (user data). Writes are always allowed; overage is billed from Light.
 */
export async function checkDataQuota(
  userId: string,
  additionalBytes: number,
  options?: EnforcementOptions,
): Promise<DataQuotaResult> {
  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return unavailableDataQuotaResult(additionalBytes, options, 'Supabase credentials not configured');
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_data_storage_quota`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_additional_bytes: additionalBytes,
      }),
    });

    if (!res.ok) {
      return unavailableDataQuotaResult(additionalBytes, options, await res.text());
    }

    const rows = await res.json() as DataQuotaResult[];
    if (!rows || rows.length === 0) {
      return unavailableDataQuotaResult(additionalBytes, options, 'Quota RPC returned no rows');
    }

    const row = rows[0];
    const projectedBytes = row.combined_used_bytes + additionalBytes;
    return {
      ...row,
      allowed: true,
      over_soft_cap: projectedBytes > row.limit_bytes,
      reason: undefined,
    };
  } catch (err) {
    return unavailableDataQuotaResult(additionalBytes, options, err);
  }
}

// ============================================
// STORAGE ADJUSTMENT
// ============================================

/**
 * Atomically adjust a user's data_storage_used_bytes by a delta (positive or negative).
 * Called after every store() and remove() operation.
 * Uses GREATEST(0, ...) in SQL to prevent negative values.
 * Fails silently on error — storage tracking is best-effort (reconciliation cron corrects drift).
 */
export async function adjustDataStorage(
  userId: string,
  deltaBytes: number
): Promise<DataStorageAdjustResult | null> {
  if (deltaBytes === 0) return null;

  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/adjust_data_storage`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_delta_bytes: deltaBytes,
      }),
    });

    if (!res.ok) {
      console.warn('[DATA-QUOTA] adjust_data_storage RPC failed:', await res.text());
      return null;
    }

    const rows = await res.json() as DataStorageAdjustResult[];
    return rows?.[0] ?? null;
  } catch (err) {
    console.error('[DATA-QUOTA] Error adjusting data storage:', err);
    return null;
  }
}
