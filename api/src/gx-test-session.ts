// Strongly ordered, invocation-scoped state for gx.test.
//
// Every padded-room WorkerEntrypoint receives only the random Durable Object
// name in ctx.props, then resolves the persistent stub from its own trusted
// host context. A short-lived RpcTarget stub is not persistently serializable
// and can split or disappear when transferred into a Dynamic Worker. SQLite
// keeps the transcript correct across hibernation.

import { DurableObject } from "cloudflare:workers";

import {
  boundedTestStateKey,
  HTTP_TEST_EXECUTION_LIMITS,
  normalizeTestAppDataKey,
  normalizeTestMemoryKey,
  normalizeTestStateValue,
  TEST_RUNTIME_STATE_LIMITS,
  type TestMemoryScope,
  testStateKeySizeBytes,
} from "../services/test-state-store.ts";
import {
  isUlTestBlockedEffect,
  isUlTestObservedEffect,
  MAX_UL_TEST_OBSERVED_EFFECTS,
  observedEffectForBlockedEffect,
  type UlTestBlockedEffect,
  type UlTestObservedEffect,
} from "../services/ul-test-runtime.ts";

const APP_DATA_NAMESPACE = "app_data";
const MEMORY_NAMESPACE = "memory";
const MAX_SESSION_LIFETIME_MS = 60 * 60 * 1_000;

type SqlRow = Record<string, ArrayBuffer | string | number | null>;

interface EntryRow extends SqlRow {
  json_value: string;
  size_bytes: number;
}

interface NumberRow extends SqlRow {
  value: number;
}

interface KeyRow extends SqlRow {
  entry_key: string;
}

interface EffectRow extends SqlRow {
  effect: string;
}

/**
 * One SQLite-backed coordinator per gx.test execution.
 *
 * The random object name is created host-side and the stub never enters tenant
 * code directly. Tenant code receives only the narrow Test* bindings, while
 * each binding resolves the shared persistent capability by that host-selected
 * name.
 */
export class GxTestSession extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS test_entries (
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        json_value TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        PRIMARY KEY (namespace, entry_key)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS test_effects (
        kind TEXT NOT NULL,
        effect TEXT NOT NULL,
        PRIMARY KEY (kind, effect)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS test_meta (
        meta_key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )
    `);
    for (
      const [key, value] of [
        ["sealed", 0],
        ["http_attempts", 0],
        ["http_exchange_bytes", 0],
      ] as const
    ) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO test_meta (meta_key, value) VALUES (?, ?)",
        key,
        value,
      );
    }

    // Normal execution calls close() within seconds. This absolute lifetime is
    // a fail-safe for isolate termination before finally can run, so test data
    // and SQLite metadata cannot remain orphaned indefinitely. An existing
    // alarm is deliberately not extended by hibernation or later activity.
    this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.getAlarm() === null) {
        await this.ctx.storage.setAlarm(
          Date.now() + MAX_SESSION_LIFETIME_MS,
        );
      }
    });
  }

  #meta(key: string): number {
    const row = this.ctx.storage.sql.exec<NumberRow>(
      "SELECT value FROM test_meta WHERE meta_key = ?",
      key,
    ).toArray()[0];
    if (!row || !Number.isSafeInteger(Number(row.value))) {
      throw new Error("gx.test state session metadata is unavailable");
    }
    return Number(row.value);
  }

  #setMeta(key: string, value: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE test_meta SET value = ? WHERE meta_key = ?",
      value,
      key,
    );
  }

  #assertOpen(): void {
    if (this.#meta("sealed") !== 0) {
      throw new Error("gx.test state session is sealed");
    }
  }

  #entry(namespace: string, key: string): EntryRow | null {
    return this.ctx.storage.sql.exec<EntryRow>(
      `SELECT json_value, size_bytes
         FROM test_entries
        WHERE namespace = ? AND entry_key = ?`,
      namespace,
      key,
    ).toArray()[0] ?? null;
  }

  #entryCount(namespace: string): number {
    const row = this.ctx.storage.sql.exec<NumberRow>(
      `SELECT COUNT(*) AS value
         FROM test_entries
        WHERE namespace = ?`,
      namespace,
    ).toArray()[0];
    return Number(row?.value ?? 0);
  }

  #totalBytes(): number {
    const row = this.ctx.storage.sql.exec<NumberRow>(
      "SELECT COALESCE(SUM(size_bytes), 0) AS value FROM test_entries",
    ).toArray()[0];
    return Number(row?.value ?? 0);
  }

  #store(namespace: string, key: string, value: unknown): void {
    const normalized = normalizeTestStateValue(value);
    const sizeBytes = testStateKeySizeBytes(key) + normalized.sizeBytes;

    this.ctx.storage.transactionSync(() => {
      this.#assertOpen();
      const existing = this.#entry(namespace, key);
      if (
        !existing &&
        this.#entryCount(namespace) >=
          TEST_RUNTIME_STATE_LIMITS.max_keys_per_namespace
      ) {
        throw new Error("gx.test state key limit reached");
      }
      const nextTotal = this.#totalBytes() -
        Number(existing?.size_bytes ?? 0) + sizeBytes;
      if (
        nextTotal > TEST_RUNTIME_STATE_LIMITS.max_execution_state_bytes
      ) {
        throw new Error("gx.test state exceeds 4 MiB");
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO test_entries
           (namespace, entry_key, json_value, size_bytes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (namespace, entry_key) DO UPDATE SET
           json_value = excluded.json_value,
           size_bytes = excluded.size_bytes`,
        namespace,
        key,
        normalized.json,
        sizeBytes,
      );
    });
  }

  storeAppData(key: string, value: unknown): void {
    this.#store(APP_DATA_NAMESPACE, normalizeTestAppDataKey(key), value);
  }

  loadAppData(key: string): unknown {
    this.#assertOpen();
    const row = this.#entry(APP_DATA_NAMESPACE, normalizeTestAppDataKey(key));
    return row ? JSON.parse(row.json_value) : null;
  }

  removeAppData(key: string): void {
    this.#assertOpen();
    this.ctx.storage.sql.exec(
      "DELETE FROM test_entries WHERE namespace = ? AND entry_key = ?",
      APP_DATA_NAMESPACE,
      normalizeTestAppDataKey(key),
    );
  }

  listAppData(prefix = ""): string[] {
    this.#assertOpen();
    const boundedPrefix = boundedTestStateKey(prefix);
    return this.ctx.storage.sql.exec<KeyRow>(
      `SELECT entry_key
         FROM test_entries
        WHERE namespace = ?
        ORDER BY entry_key`,
      APP_DATA_NAMESPACE,
    ).toArray()
      .map((row) => row.entry_key)
      .filter((key) => key.startsWith(boundedPrefix));
  }

  rememberMemory(
    scope: TestMemoryScope,
    key: string,
    value: unknown,
  ): void {
    this.#store(MEMORY_NAMESPACE, normalizeTestMemoryKey(scope, key), value);
  }

  recallMemory(scope: TestMemoryScope, key: string): unknown {
    this.#assertOpen();
    const row = this.#entry(
      MEMORY_NAMESPACE,
      normalizeTestMemoryKey(scope, key),
    );
    return row ? JSON.parse(row.json_value) : null;
  }

  beginHttpFixtureAttempt(): void {
    this.ctx.storage.transactionSync(() => {
      this.#assertOpen();
      const next = this.#meta("http_attempts") + 1;
      if (next > HTTP_TEST_EXECUTION_LIMITS.max_attempts) {
        throw new Error("gx.test HTTP fixture attempt limit reached");
      }
      this.#setMeta("http_attempts", next);
    });
  }

  reserveHttpFixtureExchangeBytes(
    requestBytes: number,
    responseBytes: number,
  ): void {
    if (
      !Number.isSafeInteger(requestBytes) ||
      requestBytes < 0 ||
      !Number.isSafeInteger(responseBytes) ||
      responseBytes < 0
    ) {
      throw new Error("gx.test HTTP fixture byte count is invalid");
    }

    this.ctx.storage.transactionSync(() => {
      this.#assertOpen();
      const next = this.#meta("http_exchange_bytes") + requestBytes +
        responseBytes;
      if (next > HTTP_TEST_EXECUTION_LIMITS.max_exchange_bytes) {
        throw new Error("gx.test HTTP fixture exchange bytes exceed 8 MiB");
      }
      this.#setMeta("http_exchange_bytes", next);
    });
  }

  #recordObservedEffect(effect: UlTestObservedEffect): void {
    if (!isUlTestObservedEffect(effect)) {
      throw new Error("gx.test observed an unknown effect kind");
    }
    const existing = this.ctx.storage.sql.exec<NumberRow>(
      `SELECT COUNT(*) AS value
         FROM test_effects
        WHERE kind = 'observed' AND effect = ?`,
      effect,
    ).toArray()[0];
    const observedCount = Number(
      this.ctx.storage.sql.exec<NumberRow>(
        `SELECT COUNT(*) AS value
           FROM test_effects
          WHERE kind = 'observed'`,
      ).toArray()[0]?.value ?? 0,
    );
    if (
      Number(existing?.value ?? 0) === 0 &&
      observedCount >= MAX_UL_TEST_OBSERVED_EFFECTS
    ) {
      throw new Error("gx.test observed-effect limit reached");
    }
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO test_effects (kind, effect) VALUES ('observed', ?)",
      effect,
    );
  }

  recordObservedEffect(effect: UlTestObservedEffect): void {
    this.ctx.storage.transactionSync(() => {
      this.#assertOpen();
      this.#recordObservedEffect(effect);
    });
  }

  recordBlockedEffect(effect: UlTestBlockedEffect): void {
    if (!isUlTestBlockedEffect(effect)) {
      throw new Error("gx.test blocked an unknown effect kind");
    }
    this.ctx.storage.transactionSync(() => {
      this.#assertOpen();
      this.#recordObservedEffect(observedEffectForBlockedEffect(effect));
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO test_effects (kind, effect) VALUES ('blocked', ?)",
        effect,
      );
    });
  }

  sealAndSnapshot(): {
    blockedEffects: string[];
    observedEffects: string[];
  } {
    return this.ctx.storage.transactionSync(() => {
      this.#assertOpen();
      const blockedEffects = this.ctx.storage.sql.exec<EffectRow>(
        `SELECT effect
           FROM test_effects
          WHERE kind = 'blocked'
          ORDER BY effect`,
      ).toArray().map((row) => row.effect);
      const observedEffects = this.ctx.storage.sql.exec<EffectRow>(
        `SELECT effect
           FROM test_effects
          WHERE kind = 'observed'
          ORDER BY effect`,
      ).toArray().map((row) => row.effect);
      this.#setMeta("sealed", 1);
      return { blockedEffects, observedEffects };
    });
  }

  async close(): Promise<void> {
    // Every execution gets a unique object name. Fully deallocate its SQLite
    // database once the host has captured the sealed transcript; deleting rows
    // alone leaves billable Durable Object metadata behind.
    await this.ctx.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
