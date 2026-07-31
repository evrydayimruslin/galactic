// Bounded, invocation-owned state for gx.test.
//
// The production adapter is held by a Cloudflare RpcTarget for exactly one
// gx.test execution. Keeping the storage mechanics in this runtime-neutral
// class makes the real semantics directly testable without importing
// `cloudflare:workers` into Deno.

import {
  isUlTestBlockedEffect,
  isUlTestObservedEffect,
  MAX_UL_TEST_OBSERVED_EFFECTS,
  observedEffectForBlockedEffect,
  type UlTestBlockedEffect,
  type UlTestObservedEffect,
} from "./ul-test-runtime.ts";

type TestMemoryScope = "agent" | "user";

interface TestStateEntry {
  value: unknown;
  sizeBytes: number;
}

const MAX_KEYS_PER_NAMESPACE = 1_024;
const MAX_KEY_BYTES = 4 * 1024;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_EXECUTION_STATE_BYTES = 4 * 1024 * 1024;

export const HTTP_TEST_EXECUTION_LIMITS = Object.freeze({
  max_attempts: 32,
  max_exchange_bytes: 8 * 1024 * 1024,
});

function boundedKey(key: string): string {
  const bytes = new TextEncoder().encode(key).byteLength;
  if (bytes > MAX_KEY_BYTES) {
    throw new Error("gx.test state key exceeds 4 KiB");
  }
  return key;
}

function normalizedDataKey(key: string): string {
  return boundedKey(key.replace(/[^a-zA-Z0-9\-_\/]/g, "_"));
}

function keySizeBytes(key: string): number {
  return new TextEncoder().encode(key).byteLength;
}

function assertNamespaceCapacity(
  namespace: ReadonlyMap<string, unknown>,
  key: string,
): void {
  if (!namespace.has(key) && namespace.size >= MAX_KEYS_PER_NAMESPACE) {
    throw new Error("gx.test state key limit reached");
  }
}

function normalizeValue(value: unknown): {
  value: unknown;
  sizeBytes: number;
} {
  // Production DATA/MEMORY are persisted as JSON. Store parsed JSON rather than
  // the original structured-clone value so ArrayBuffer/Map instances cannot
  // occupy unmetered memory and tests observe the same persistence semantics.
  const serialized = JSON.stringify(value);
  const json = serialized ?? "null";
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_VALUE_BYTES) {
    throw new Error("gx.test state value exceeds 1 MiB");
  }
  return {
    value: JSON.parse(json),
    sizeBytes: bytes,
  };
}

/**
 * The complete mutable state of one gx.test run.
 *
 * A session is never shared by execution id or looked up through module-global
 * state. The Cloudflare adapter owns one instance behind one RpcTarget stub and
 * explicitly closes it on every host exit path.
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
    if (total > MAX_EXECUTION_STATE_BYTES) {
      throw new Error("gx.test state exceeds 4 MiB");
    }
    this.#totalBytes = total;
  }

  #releaseBytes(releasedBytes: number): void {
    this.#totalBytes = Math.max(0, this.#totalBytes - releasedBytes);
  }

  storeAppData(key: string, value: unknown): void {
    this.#assertOpen();
    const normalizedKey = normalizedDataKey(key);
    assertNamespaceCapacity(this.#appData, normalizedKey);
    const normalized = normalizeValue(value);
    const sizeBytes = keySizeBytes(normalizedKey) + normalized.sizeBytes;
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
    const entry = this.#appData.get(normalizedDataKey(key));
    return entry ? structuredClone(entry.value) : null;
  }

  removeAppData(key: string): void {
    this.#assertOpen();
    const normalizedKey = normalizedDataKey(key);
    const existing = this.#appData.get(normalizedKey);
    if (existing) this.#releaseBytes(existing.sizeBytes);
    this.#appData.delete(normalizedKey);
  }

  listAppData(prefix = ""): string[] {
    this.#assertOpen();
    const boundedPrefix = boundedKey(prefix);
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
    const scopedKey = boundedKey(`${scope}:${key}`);
    assertNamespaceCapacity(this.#memory, scopedKey);
    const normalized = normalizeValue(value);
    const sizeBytes = keySizeBytes(scopedKey) + normalized.sizeBytes;
    this.#reserveBytes(sizeBytes, this.#memory.get(scopedKey)?.sizeBytes);
    this.#memory.set(scopedKey, {
      value: normalized.value,
      sizeBytes,
    });
  }

  recallMemory(scope: TestMemoryScope, key: string): unknown {
    this.#assertOpen();
    const scopedKey = boundedKey(`${scope}:${key}`);
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
