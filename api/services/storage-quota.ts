// Storage Soft-Cap Service
// Tracks storage usage per app and per user via Supabase RPC functions.
// Used by the hosting billing system to calculate hosting costs.
// Product storage thresholds are soft billing thresholds; upload request-size
// guardrails live at the handler boundary.

import { getEnv } from '../lib/env.ts';
import { COMBINED_FREE_TIER_BYTES } from '../../shared/types/index.ts';
import { resolveEnforcementOptions, type EnforcementOptions } from './enforcement.ts';

/** Combined storage soft cap: source code + user data = 100MB. */
const STORAGE_SOFT_CAP_BYTES = COMBINED_FREE_TIER_BYTES; // 100 MB

export interface StorageQuotaResult {
  allowed: boolean;
  used_bytes: number;
  limit_bytes: number;
  remaining_bytes: number;
  over_soft_cap?: boolean;
  reason?: 'quota_exceeded' | 'service_unavailable';
}

export interface AppStorageAccountingResult {
  previous_bytes: number;
  new_bytes: number;
  delta_bytes: number;
  user_storage_used_bytes: number;
}

function unavailableStorageQuotaResult(
  uploadSizeBytes: number,
  options?: EnforcementOptions,
  detail?: unknown,
): StorageQuotaResult {
  const enforcement = resolveEnforcementOptions(options, 'storage soft-cap check');

  console.error(
    `[STORAGE] Soft-cap backend unavailable for ${enforcement.resource}; allowing upload. Upload bytes=${uploadSizeBytes}:`,
    detail,
  );

  return {
    allowed: true,
    used_bytes: 0,
    limit_bytes: STORAGE_SOFT_CAP_BYTES,
    remaining_bytes: STORAGE_SOFT_CAP_BYTES,
    over_soft_cap: false,
    reason: 'service_unavailable',
  };
}

/**
 * Read storage usage before a source code upload.
 * Queries users.storage_used_bytes + data_storage_used_bytes (combined budget)
 * and reports whether the upload crosses the 100MB soft cap. It never blocks
 * product storage; handlers still enforce technical request-size guardrails.
 */
export async function checkStorageQuota(
  userId: string,
  uploadSizeBytes: number,
  options?: EnforcementOptions,
): Promise<StorageQuotaResult> {
  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return unavailableStorageQuotaResult(uploadSizeBytes, options, 'Supabase credentials not configured');
  }

  try {
    // Query combined storage usage (source code + user data) from users table
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=storage_used_bytes,data_storage_used_bytes`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!res.ok) {
      return unavailableStorageQuotaResult(uploadSizeBytes, options, await res.text());
    }

    const rows = await res.json() as Array<{ storage_used_bytes: number | null; data_storage_used_bytes: number | null }>;
    if (!rows || rows.length === 0) {
      return unavailableStorageQuotaResult(uploadSizeBytes, options, 'User row missing during quota check');
    }
    const sourceBytes = rows[0]?.storage_used_bytes ?? 0;
    const dataBytes = rows[0]?.data_storage_used_bytes ?? 0;
    const combinedUsed = sourceBytes + dataBytes;
    const projectedBytes = combinedUsed + uploadSizeBytes;
    const remaining = Math.max(0, STORAGE_SOFT_CAP_BYTES - combinedUsed);
    const overSoftCap = projectedBytes > STORAGE_SOFT_CAP_BYTES;

    return {
      allowed: true,
      used_bytes: combinedUsed,
      limit_bytes: STORAGE_SOFT_CAP_BYTES,
      remaining_bytes: remaining,
      over_soft_cap: overSoftCap,
    };
  } catch (err) {
    return unavailableStorageQuotaResult(uploadSizeBytes, options, err);
  }
}

/**
 * Set live app storage after a successful publish/live-version change.
 * users.storage_used_bytes is adjusted by the delta from the previous live
 * app size, so replacing a version cannot inflate account-level storage.
 */
export async function setAppStorageBytes(
  userId: string,
  appId: string,
  sizeBytes: number
): Promise<AppStorageAccountingResult> {
  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Storage accounting unavailable: Supabase credentials not configured');
  }

  const normalizedSizeBytes = Math.max(0, Math.trunc(sizeBytes || 0));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_app_storage_bytes`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_user_id: userId,
      p_app_id: appId,
      p_size_bytes: normalizedSizeBytes,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to set app storage bytes: ${await res.text()}`);
  }

  const result = await res.json();
  return parseAppStorageAccountingResult(result);
}

export async function recordUploadStorage(
  userId: string,
  appId: string,
  _version: string,
  sizeBytes: number
): Promise<AppStorageAccountingResult> {
  return await setAppStorageBytes(userId, appId, sizeBytes);
}

/**
 * Reclaim storage when an app is deleted.
 * Calls the reclaim_app_storage RPC which updates users.storage_used_bytes.
 */
export async function reclaimAppStorage(
  userId: string,
  appId: string
): Promise<number> {
  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Storage accounting unavailable: Supabase credentials not configured');
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reclaim_app_storage`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_user_id: userId,
      p_app_id: appId,
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to reclaim app storage: ${await res.text()}`);
  }

  return parseStorageByteScalar(await res.json());
}

/**
 * Reclaim storage for a specific version.
 */
export async function reclaimVersionStorage(
  userId: string,
  appId: string,
  version: string
): Promise<number> {
  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return 0;

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reclaim_version_storage`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_app_id: appId,
        p_version: version,
      }),
    });

    if (res.ok) {
      return parseStorageByteScalar(await res.json());
    }
    console.error(`[STORAGE] Failed to reclaim version storage: ${await res.text()}`);
  } catch (err) {
    console.error('[STORAGE] Error reclaiming version storage:', err);
  }
  return 0;
}

export function getVersionStorageBytes(
  versionMetadata: Array<{ version?: unknown; size_bytes?: unknown }> | null | undefined,
  version: string
): number | null {
  if (!Array.isArray(versionMetadata)) return null;

  for (let i = versionMetadata.length - 1; i >= 0; i--) {
    const entry = versionMetadata[i];
    if (!entry || entry.version !== version) continue;

    const rawBytes = entry.size_bytes;
    const parsedBytes = typeof rawBytes === 'number'
      ? rawBytes
      : typeof rawBytes === 'string'
      ? Number(rawBytes)
      : NaN;
    if (Number.isFinite(parsedBytes) && parsedBytes >= 0) {
      return Math.trunc(parsedBytes);
    }
  }

  return null;
}

function parseAppStorageAccountingResult(result: unknown): AppStorageAccountingResult {
  const row = Array.isArray(result) ? result[0] : result;
  if (!row || typeof row !== 'object') {
    throw new Error('Storage accounting RPC returned an empty result');
  }

  return {
    previous_bytes: toFiniteNumber((row as Record<string, unknown>).previous_bytes),
    new_bytes: toFiniteNumber((row as Record<string, unknown>).new_bytes),
    delta_bytes: toFiniteNumber((row as Record<string, unknown>).delta_bytes),
    user_storage_used_bytes: toFiniteNumber((row as Record<string, unknown>).user_storage_used_bytes),
  };
}

function parseStorageByteScalar(result: unknown): number {
  if (typeof result === 'number') return result;
  if (typeof result === 'string') return toFiniteNumber(result);
  if (Array.isArray(result)) {
    if (result.length === 0) return 0;
    if (typeof result[0] === 'number' || typeof result[0] === 'string') {
      return toFiniteNumber(result[0]);
    }
    if (result[0] && typeof result[0] === 'object') {
      const values = Object.values(result[0] as Record<string, unknown>);
      return values.length > 0 ? toFiniteNumber(values[0]) : 0;
    }
  }
  if (result && typeof result === 'object') {
    const values = Object.values(result as Record<string, unknown>);
    return values.length > 0 ? toFiniteNumber(values[0]) : 0;
  }
  return 0;
}

function toFiniteNumber(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(numberValue)) {
    throw new Error(`Storage accounting RPC returned a non-numeric value: ${String(value)}`);
  }
  return numberValue;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
