// Code Cache Service
// In-memory LRU cache for app code fetched from R2.
// Prevents redundant R2 fetches on every MCP tool call.

interface CacheEntry {
  code: string;
  fetchedAt: number;
  storageKey: string;
  accessedAt: number;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_TTL_MS = 0; // Disabled — always fetch fresh from R2

export class CodeCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;
  private ttlMs: number;

  // Stats for logging/monitoring
  private _hits = 0;
  private _misses = 0;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  /**
   * Get cached code for an app. Returns null on miss or expiry.
   * Cache key is appId + storageKey, so a version bump auto-invalidates.
   */
  get(appId: string, storageKey: string): string | null {
    const key = `${appId}:${storageKey}`;
    const entry = this.cache.get(key);

    if (!entry) {
      this._misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(key);
      this._misses++;
      return null;
    }

    // Update access time for LRU
    entry.accessedAt = Date.now();
    this._hits++;
    return entry.code;
  }

  /**
   * Store code in cache.
   */
  set(appId: string, storageKey: string, code: string): void {
    const key = `${appId}:${storageKey}`;

    // Evict if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, {
      code,
      storageKey,
      fetchedAt: Date.now(),
      accessedAt: Date.now(),
    });
  }

  /**
   * Invalidate cache for a specific app (all versions).
   * Called when an app is updated/published.
   */
  invalidate(appId: string): void {
    const prefix = `${appId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    console.log(`[CODE_CACHE] Invalidated cache for app ${appId}`);
  }

  /**
   * Get cache stats for monitoring.
   */
  get stats() {
    return {
      entries: this.cache.size,
      maxEntries: this.maxEntries,
      hits: this._hits,
      misses: this._misses,
      hitRate: this._hits + this._misses > 0
        ? (this._hits / (this._hits + this._misses) * 100).toFixed(1) + '%'
        : 'N/A',
    };
  }

  /**
   * Evict the least recently accessed entry.
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.accessedAt < oldestAccess) {
        oldestAccess = entry.accessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}

// Singleton instance shared across all request handlers
let _instance: CodeCache | null = null;

export function getCodeCache(): CodeCache {
  if (!_instance) {
    _instance = new CodeCache();
    // Honest log: DEFAULT_TTL_MS is 0, so every get() expires — caching is
    // deliberately disabled until cross-isolate invalidation exists. (The MCP
    // chokepoint no longer reads R2 code at all; remaining users are the app
    // runner + upload invalidation.)
    console.log('[CODE_CACHE] Initialized (max=1000, TTL=0 — disabled, always fetch fresh)');
  }
  return _instance;
}
