// Metered App Data Service
// Decorator that wraps any AppDataService to track user data storage usage.
// Intercepts store(), remove(), batchStore(), batchRemove() to:
//   1. Read soft-cap status before writes (combined source code + user data)
//   2. Adjust data_storage_used_bytes after writes/deletes (atomic via Supabase RPC)
//
// Read operations (load, list, query, batchLoad) pass through unchanged.
// Only applied when userId is present (MCP calls). Shared app data (no userId) is unmetered.

import type { AppDataService, QueryOptions, QueryResult } from './appdata.ts';
import { checkDataQuota, adjustDataStorage } from './data-quota.ts';

// ============================================
// HELPERS
// ============================================

/** Compute byte length of a value when serialized as a store() payload. */
function computeStoreSize(key: string, value: unknown): number {
  const payload = JSON.stringify({
    key,
    value,
    updated_at: new Date().toISOString(),
    _size_bytes: 0,
  });
  return new TextEncoder().encode(payload).length;
}

/**
 * Extract _size_bytes from a loaded raw object.
 * Falls back to estimating from the full serialized length if _size_bytes is missing
 * (backward compat for objects stored before metering was added).
 */
function extractSizeBytes(loaded: unknown): number {
  if (loaded && typeof loaded === 'object') {
    const obj = loaded as Record<string, unknown>;
    if (typeof obj._size_bytes === 'number' && obj._size_bytes > 0) {
      return obj._size_bytes;
    }
    // Legacy fallback: estimate from serialized value
    try {
      return new TextEncoder().encode(JSON.stringify(loaded)).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

// ============================================
// METERED WRAPPER
// ============================================

/**
 * Create a metered wrapper around an AppDataService.
 * Tracks data storage usage per user and reports combined soft-cap status.
 *
 * @param inner - The underlying AppDataService (R2-backed or Worker-backed)
 * @param userId - The calling user's ID (from MCP auth)
 */
export function createMeteredAppDataService(
  inner: AppDataService,
  userId: string,
): AppDataService {
  return {
    // ==========================================
    // STORE — soft-cap check + write + adjust delta
    // ==========================================
    async store(key: string, value: unknown): Promise<void> {
      const newSize = computeStoreSize(key, value);

      // Pre-flight soft-cap check for billing visibility. Product storage caps
      // do not block writes; Light billing handles overage after usage sync.
      await checkDataQuota(userId, newSize, {
        mode: 'fail_open',
        resource: 'app data write',
      });

      // Get old size for delta calculation (cache-first via inner.load)
      let oldSize = 0;
      try {
        const existing = await inner.load(key);
        if (existing !== null && existing !== undefined) {
          oldSize = computeStoreSize(key, existing);
        }
      } catch {
        // Can't determine old size — treat as new key (delta = full new size)
      }

      // Delegate to inner service
      await inner.store(key, value);

      // Adjust data storage by delta (fire-and-forget for performance)
      const delta = newSize - oldSize;
      if (delta !== 0) {
        adjustDataStorage(userId, delta).catch(err =>
          console.error('[DATA-METER] Failed to adjust storage after store:', err)
        );
      }
    },

    // ==========================================
    // REMOVE — get old size + delete + adjust
    // ==========================================
    async remove(key: string): Promise<void> {
      // Get old size before deletion
      let oldSize = 0;
      try {
        const existing = await inner.load(key);
        if (existing !== null && existing !== undefined) {
          oldSize = computeStoreSize(key, existing);
        }
      } catch {
        // Can't determine old size — no adjustment possible
      }

      // Delegate to inner service
      await inner.remove(key);

      // Adjust data storage by negative delta (fire-and-forget)
      if (oldSize > 0) {
        adjustDataStorage(userId, -oldSize).catch(err =>
          console.error('[DATA-METER] Failed to adjust storage after remove:', err)
        );
      }
    },

    // ==========================================
    // BATCH STORE — soft-cap check + delegate + adjust
    // ==========================================
    async batchStore(items: Array<{ key: string; value: unknown }>): Promise<void> {
      if (items.length === 0) return;

      // Compute total new bytes
      const totalNewBytes = items.reduce(
        (sum, item) => sum + computeStoreSize(item.key, item.value), 0
      );

      // Pre-flight soft-cap check for the full batch. This never blocks writes.
      await checkDataQuota(userId, totalNewBytes, {
        mode: 'fail_open',
        resource: 'app data batch write',
      });

      // Delegate to inner service
      await inner.batchStore(items);

      // Adjust by total new bytes (treat all as new for simplicity in batch ops;
      // reconciliation cron will correct any drift from overwritten keys)
      adjustDataStorage(userId, totalNewBytes).catch(err =>
        console.error('[DATA-METER] Failed to adjust storage after batchStore:', err)
      );
    },

    // ==========================================
    // BATCH REMOVE — delegate + adjust
    // ==========================================
    async batchRemove(keys: string[]): Promise<void> {
      if (keys.length === 0) return;

      // Try to load sizes before deletion for accurate adjustment
      let totalOldBytes = 0;
      try {
        const loaded = await inner.batchLoad(keys);
        for (const item of loaded) {
          if (item.value !== null && item.value !== undefined) {
            totalOldBytes += computeStoreSize(item.key, item.value);
          }
        }
      } catch {
        // Can't determine sizes — no adjustment possible
      }

      // Delegate to inner service
      await inner.batchRemove(keys);

      // Adjust data storage by negative total (fire-and-forget)
      if (totalOldBytes > 0) {
        adjustDataStorage(userId, -totalOldBytes).catch(err =>
          console.error('[DATA-METER] Failed to adjust storage after batchRemove:', err)
        );
      }
    },

    // ==========================================
    // READ OPERATIONS — pass-through (unmetered)
    // ==========================================
    load: (key: string) => inner.load(key),
    list: (prefix?: string) => inner.list(prefix),
    query: (prefix: string, options?: QueryOptions) => inner.query(prefix, options),
    batchLoad: (keys: string[]) => inner.batchLoad(keys),
  };
}
