// Bounded, invocation-owned state for gx.test.
//
// The production adapter is a SQLite-backed Durable Object for exactly one
// gx.test execution. This runtime-neutral in-memory implementation shares its
// normalization and bounds with that adapter so the semantics remain directly
// testable without importing `cloudflare:workers` into Deno.

import {
  isUlTestBlockedEffect,
  isUlTestObservedEffect,
  MAX_UL_TEST_OBSERVED_EFFECTS,
  observedEffectForBlockedEffect,
  type UlTestBlockedEffect,
  type UlTestObservedEffect,
} from "./ul-test-runtime.ts";

export type TestMemoryScope = "agent" | "user";

interface TestStateEntry {
  value: unknown;
  sizeBytes: number;
}

export const TEST_RUNTIME_STATE_LIMITS = Object.freeze({
  max_keys_per_namespace: 1_024,
  max_key_bytes: 4 * 1024,
  max_value_bytes: 1024 * 1024,
  max_execution_state_bytes: 4 * 1024 * 1024,
});

export const HTTP_TEST_EXECUTION_LIMITS = Object.freeze({
  max_attempts: 32,
  max_exchange_bytes: 8 * 1024 * 1024,
});

export function boundedTestStateKey(key: string): string {
  const bytes = new TextEncoder().encode(key).byteLength;
  if (bytes > TEST_RUNTIME_STATE_LIMITS.max_key_bytes) {
    throw new Error("gx.test state key exceeds 4 KiB");
  }
  return key;
}

export function normalizeTestAppDataKey(key: string): string {
  return boundedTestStateKey(key.replace(/[^a-zA-Z0-9\-_\/]/g, "_"));
}

export function testStateKeySizeBytes(key: string): number {
  return new TextEncoder().encode(key).byteLength;
}

function assertNamespaceCapacity(
  namespace: ReadonlyMap<string, unknown>,
  key: string,
): void {
  if (
    !namespace.has(key) &&
    namespace.size >= TEST_RUNTIME_STATE_LIMITS.max_keys_per_namespace
  ) {
    throw new Error("gx.test state key limit reached");
  }
}

export function normalizeTestStateValue(value: unknown): {
  json: string;
  value: unknown;
  sizeBytes: number;
} {
  // Production DATA/MEMORY are persisted as JSON. Store parsed JSON rather than
  // the original structured-clone value so ArrayBuffer/Map instances cannot
  // occupy unmetered memory and tests observe the same persistence semantics.
  const serialized = JSON.stringify(value);
  const json = serialized ?? "null";
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > TEST_RUNTIME_STATE_LIMITS.max_value_bytes) {
    throw new Error("gx.test state value exceeds 1 MiB");
  }
  return {
    json,
    value: JSON.parse(json),
    sizeBytes: bytes,
  };
}

export function normalizeTestMemoryKey(
  scope: TestMemoryScope,
  key: string,
): string {
  return boundedTestStateKey(`${scope}:${key}`);
}

/**
 * The complete mutable state of one gx.test run.
 *
 * A session is never shared by execution id or looked up through module-global
 * state. The Cloudflare adapter owns one randomly named Durable Object and
 * explicitly seals and closes it on every host exit path.
 */
export class TestRuntimeStateStore {
  #appData = new Map<string, TestStateEntry>();
  #memory = new Map<string, TestStateEntry>();
  #blockedEffects = new Set<UlTestBlockedEffect>();
  #observedEffects = new Set<UlTestObservedEffect>();
  #totalBytes = 0;
  #httpFixtureAttempts = 0;
  #httpFixtureExchangeBytes = 0;
  #closed = false;

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("gx.test state session is closed");
    }
  }

  #reserveBytes(nextBytes: number, previousBytes = 0): void {
    const total = this.#totalBytes - previousBytes + nextBytes;
    if (total > TEST_RUNTIME_STATE_LIMITS.max_execution_state_bytes) {
      throw new Error("gx.test state exceeds 4 MiB");
    }
    this.#totalBytes = total;
  }

  #releaseBytes(releasedBytes: number): void {
    this.#totalBytes = Math.max(0, this.#totalBytes - releasedBytes);
  }

  storeAppData(key: string, value: unknown): void {
    this.#assertOpen();
    const normalizedKey = normalizeTestAppDataKey(key);
    assertNamespaceCapacity(this.#appData, normalizedKey);
    const normalized = normalizeTestStateValue(value);
    const sizeBytes = testStateKeySizeBytes(normalizedKey) +
      normalized.sizeBytes;
    this.#reserveBytes(
      sizeBytes,
      this.#appData.get(normalizedKey)?.sizeBytes,
    );
    this.#appData.set(normalizedKey, {
      value: normalized.value,
      sizeBytes,
    });
  }

  loadAppData(key: string): unknown {
    this.#assertOpen();
    const entry = this.#appData.get(normalizeTestAppDataKey(key));
    return entry ? structuredClone(entry.value) : null;
  }

  removeAppData(key: string): void {
    this.#assertOpen();
    const normalizedKey = normalizeTestAppDataKey(key);
    const existing = this.#appData.get(normalizedKey);
    if (existing) this.#releaseBytes(existing.sizeBytes);
    this.#appData.delete(normalizedKey);
  }

  listAppData(prefix = ""): string[] {
    this.#assertOpen();
    const boundedPrefix = boundedTestStateKey(prefix);
    return [...this.#appData.keys()]
      .filter((key) => key.startsWith(boundedPrefix))
      .sort();
  }

  rememberMemory(
    scope: TestMemoryScope,
    key: string,
    value: unknown,
  ): void {
    this.#assertOpen();
    const scopedKey = normalizeTestMemoryKey(scope, key);
    assertNamespaceCapacity(this.#memory, scopedKey);
    const normalized = normalizeTestStateValue(value);
    const sizeBytes = testStateKeySizeBytes(scopedKey) + normalized.sizeBytes;
    this.#reserveBytes(sizeBytes, this.#memory.get(scopedKey)?.sizeBytes);
    this.#memory.set(scopedKey, {
      value: normalized.value,
      sizeBytes,
    });
  }

  recallMemory(scope: TestMemoryScope, key: string): unknown {
    this.#assertOpen();
    const scopedKey = normalizeTestMemoryKey(scope, key);
    const entry = this.#memory.get(scopedKey);
    return entry ? structuredClone(entry.value) : null;
  }

  beginHttpFixtureAttempt(): void {
    this.#assertOpen();
    const nextAttempts = this.#httpFixtureAttempts + 1;
    if (nextAttempts > HTTP_TEST_EXECUTION_LIMITS.max_attempts) {
      throw new Error("gx.test HTTP fixture attempt limit reached");
    }
    this.#httpFixtureAttempts = nextAttempts;
  }

  reserveHttpFixtureExchangeBytes(
    requestBytes: number,
    responseBytes: number,
  ): void {
    this.#assertOpen();
    if (
      !Number.isSafeInteger(requestBytes) ||
      requestBytes < 0 ||
      !Number.isSafeInteger(responseBytes) ||
      responseBytes < 0
    ) {
      throw new Error("gx.test HTTP fixture byte count is invalid");
    }

    const nextBytes = this.#httpFixtureExchangeBytes + requestBytes +
      responseBytes;
    if (nextBytes > HTTP_TEST_EXECUTION_LIMITS.max_exchange_bytes) {
      throw new Error("gx.test HTTP fixture exchange bytes exceed 8 MiB");
    }

    // Commit only after every check passes, so a rejected exchange cannot
    // corrupt accounting for a concurrently settling call.
    this.#httpFixtureExchangeBytes = nextBytes;
  }

  recordObservedEffect(effect: UlTestObservedEffect): void {
    this.#assertOpen();
    if (!isUlTestObservedEffect(effect)) {
      throw new Error("gx.test observed an unknown effect kind");
    }
    if (
      !this.#observedEffects.has(effect) &&
      this.#observedEffects.size >= MAX_UL_TEST_OBSERVED_EFFECTS
    ) {
      throw new Error("gx.test observed-effect limit reached");
    }
    this.#observedEffects.add(effect);
  }

  recordBlockedEffect(effect: UlTestBlockedEffect): void {
    this.#assertOpen();
    if (!isUlTestBlockedEffect(effect)) {
      throw new Error("gx.test blocked an unknown effect kind");
    }
    // Record the attempted public effect before latching the containment
    // failure. Both sets are fixed-catalog and deduplicated, so tenant input
    // can neither inject report text nor grow the session without bound.
    this.recordObservedEffect(observedEffectForBlockedEffect(effect));
    this.#blockedEffects.add(effect);
  }

  blockedEffects(): UlTestBlockedEffect[] {
    this.#assertOpen();
    return [...this.#blockedEffects].sort();
  }

  observedEffects(): UlTestObservedEffect[] {
    this.#assertOpen();
    return [...this.#observedEffects].sort();
  }

  sizeBytes(): number {
    this.#assertOpen();
    return this.#totalBytes;
  }

  close(): void {
    this.#appData.clear();
    this.#memory.clear();
    this.#blockedEffects.clear();
    this.#observedEffects.clear();
    this.#totalBytes = 0;
    this.#httpFixtureAttempts = 0;
    this.#httpFixtureExchangeBytes = 0;
    this.#closed = true;
  }

  isClosed(): boolean {
    return this.#closed;
  }
}
