import type { LaunchInterfaceReadModelSummary } from '../../../../shared/contracts/launch';
import type { InterfaceBridgeCallResult } from './interface-bridge';
import { LAUNCH_AUTH_SESSION_CHANGED_EVENT, LAUNCH_AUTH_TOKEN_KEY } from './auth';

interface ReadEntry {
  storedAt: number;
  value: unknown;
}

interface CachedInterfaceCallOptions {
  agentId: string;
  args: Record<string, unknown>;
  execute: () => Promise<InterfaceBridgeCallResult>;
  functionName: string;
  interfaceId: string;
  now?: () => number;
  ownerScope: string | null;
  artifactHash: string | null | undefined;
  readModel: LaunchInterfaceReadModelSummary | null | undefined;
  releaseVersion: string | null | undefined;
}

const MAX_ENTRIES = 64;
const STORAGE_PREFIX = 'galactic.interface-read.v1.';
const entries = new Map<string, ReadEntry>();
const inFlight = new Map<string, Promise<InterfaceBridgeCallResult>>();
const agentGenerations = new Map<string, number>();
let authCacheEpoch = 0;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function cacheKey(
  ownerScope: string,
  agentId: string,
  releaseVersion: string,
  artifactHash: string,
  interfaceId: string,
  functionName: string,
  args: Record<string, unknown>,
): string {
  return `${ownerScope}\n${agentId}\n${releaseVersion}\n${artifactHash}\n${interfaceId}\n${functionName}\n${
    JSON.stringify(stableValue(args))
  }`;
}

function stringHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function storageKey(
  ownerScope: string,
  agentId: string,
  key: string,
): string {
  return `${STORAGE_PREFIX}${stringHash(ownerScope)}.${encodeURIComponent(agentId)}.${
    stringHash(key)
  }`;
}

function readRemembered(
  ownerScope: string,
  agentId: string,
  key: string,
): ReadEntry | undefined {
  const memory = entries.get(key);
  if (memory) return memory;
  if (typeof sessionStorage === 'undefined') return undefined;
  try {
    const raw = sessionStorage.getItem(storageKey(ownerScope, agentId, key));
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as {
      cacheKey?: unknown;
      ownerScope?: unknown;
      storedAt?: unknown;
      value?: unknown;
    };
    if (
      stored.cacheKey !== key ||
      stored.ownerScope !== ownerScope ||
      typeof stored.storedAt !== 'number'
    ) {
      return undefined;
    }
    const entry = { storedAt: stored.storedAt, value: stored.value };
    entries.set(key, entry);
    return entry;
  } catch {
    return undefined;
  }
}

function remember(
  ownerScope: string,
  agentId: string,
  key: string,
  entry: ReadEntry,
): void {
  entries.delete(key);
  entries.set(key, entry);
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(
        storageKey(ownerScope, agentId, key),
        JSON.stringify({ cacheKey: key, ownerScope, ...entry }),
      );
    } catch {
      // A large Interface result or private browsing quota should only disable
      // persistence; the bounded in-memory cache still works for this page.
    }
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) break;
    entries.delete(oldest);
  }
}

function liveRead(
  key: string,
  ownerAgentKey: string,
  ownerScopeKey: string,
  options: CachedInterfaceCallOptions,
  generation: number,
  now: () => number,
): Promise<InterfaceBridgeCallResult> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = options.execute()
    .then((response) => {
      if (
        response.success &&
        agentGenerations.get(ownerAgentKey) === generation
      ) {
        remember(ownerScopeKey, options.agentId, key, {
          storedAt: now(),
          value: response.result,
        });
      }
      return response;
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Clears all read models after any Interface mutation for this Agent. */
export function invalidateInterfaceReadCache(
  ownerScope: string,
  agentId: string,
): void {
  const ownerScopeKey = `${authCacheEpoch}\n${ownerScope}`;
  const ownerAgentKey = `${ownerScopeKey}\n${agentId}`;
  agentGenerations.set(
    ownerAgentKey,
    (agentGenerations.get(ownerAgentKey) ?? 0) + 1,
  );
  const prefix = `${ownerAgentKey}\n`;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
  if (typeof sessionStorage !== 'undefined') {
    const storagePrefix = `${STORAGE_PREFIX}${stringHash(ownerScopeKey)}.${
      encodeURIComponent(agentId)
    }.`;
    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith(storagePrefix)) sessionStorage.removeItem(key);
      }
    } catch {
      // Storage can be unavailable under strict privacy settings.
    }
  }
}

/**
 * Returns fresh data directly, stale-but-usable data immediately while
 * refreshing it in the background, and awaits the live read on a cold miss.
 * Non-read calls invalidate the Agent's cache before executing.
 */
export function runInterfaceCallWithCache(
  options: CachedInterfaceCallOptions,
): Promise<InterfaceBridgeCallResult> {
  if (!options.ownerScope) return options.execute();

  const policy = options.readModel;
  // Cache authority is an exact, live-release declaration. A suggestive
  // function name (including old built-in names) is never enough. Missing or
  // mismatched metadata fails closed and is treated as a possible mutation.
  if (
    !policy ||
    policy.functionName !== options.functionName ||
    !options.releaseVersion ||
    !options.artifactHash ||
    !options.interfaceId
  ) {
    invalidateInterfaceReadCache(options.ownerScope, options.agentId);
    return options.execute();
  }

  const now = options.now ?? Date.now;
  const ownerScopeKey = `${authCacheEpoch}\n${options.ownerScope}`;
  const ownerAgentKey = `${ownerScopeKey}\n${options.agentId}`;
  const generation = agentGenerations.get(ownerAgentKey) ?? 0;
  agentGenerations.set(ownerAgentKey, generation);
  const key = cacheKey(
    ownerScopeKey,
    options.agentId,
    options.releaseVersion,
    options.artifactHash,
    options.interfaceId,
    options.functionName,
    options.args,
  );
  const cached = readRemembered(ownerScopeKey, options.agentId, key);
  if (!cached) {
    return liveRead(
      key,
      ownerAgentKey,
      ownerScopeKey,
      options,
      generation,
      now,
    );
  }

  const age = Math.max(0, now() - cached.storedAt);
  if (age <= policy.freshForMs) {
    return Promise.resolve({ success: true, result: cached.value });
  }
  if (age <= policy.staleForMs) {
    void liveRead(
      key,
      ownerAgentKey,
      ownerScopeKey,
      options,
      generation,
      now,
    ).catch(() => undefined);
    return Promise.resolve({ success: true, result: cached.value });
  }

  entries.delete(key);
  return liveRead(
    key,
    ownerAgentKey,
    ownerScopeKey,
    options,
    generation,
    now,
  );
}

/** Clears all private Interface read models when the auth session changes. */
export function clearInterfaceReadCache(): void {
  authCacheEpoch += 1;
  entries.clear();
  inFlight.clear();
  agentGenerations.clear();
  if (typeof sessionStorage !== 'undefined') {
    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(key);
      }
    } catch {
      // Storage can be unavailable under strict privacy settings.
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    LAUNCH_AUTH_SESSION_CHANGED_EVENT,
    clearInterfaceReadCache,
  );
  window.addEventListener('storage', (event) => {
    if (event.key === LAUNCH_AUTH_TOKEN_KEY) clearInterfaceReadCache();
  });
}

/** Test-only reset; kept explicit so production callers cannot clear by key. */
export function resetInterfaceReadCacheForTests(): void {
  clearInterfaceReadCache();
}
