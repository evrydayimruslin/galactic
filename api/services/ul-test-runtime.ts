// Deterministic host responses for gx.test. These values are returned only by
// parent-worker RPC bindings selected through RuntimeConfig.testMode; tenant
// source cannot enable them or obtain provider/inbox credentials.

import type {
  AppDataService,
  QueryOptions,
  QueryResult,
} from "../runtime/sandbox.ts";

export const UL_TEST_BLOCKED_EFFECTS = {
  outboundHttp: "outbound_http",
  outboundTcp: "outbound_tcp",
  credentialedHttp: "credentialed_http",
  imap: "imap",
  smtp: "smtp",
  eventPublish: "event_publish",
  agentCall: "agent_call",
} as const;

export type UlTestBlockedEffect =
  typeof UL_TEST_BLOCKED_EFFECTS[keyof typeof UL_TEST_BLOCKED_EFFECTS];

/**
 * Stable, public effect identifiers emitted by basic conformance.
 *
 * These values deliberately describe only the operation class. They never
 * contain tenant-controlled keys, table names, URLs, prompts, payloads, or
 * credential material, so the snapshot is safe to persist and display.
 */
export const UL_TEST_OBSERVED_EFFECTS = {
  storageRead: "storage.read",
  storageWrite: "storage.write",
  storageDelete: "storage.delete",
  databaseRead: "database.read",
  databaseWrite: "database.write",
  memoryRead: "memory.read",
  memoryWrite: "memory.write",
  routineRead: "routine.read",
  notificationOwnerWrite: "notification.owner.write",
  inferenceGenerate: "inference.generate",
  inferenceEmbed: "inference.embed",
  computeExecute: "compute.execute",
  networkHttp: "network.http",
  networkTcp: "network.tcp",
  credentialHttp: "credential.http",
  emailImapRead: "email.imap.read",
  emailSmtpSend: "email.smtp.send",
  eventPublish: "event.publish",
  agentCall: "agent.call",
} as const;

export type UlTestObservedEffect =
  typeof UL_TEST_OBSERVED_EFFECTS[keyof typeof UL_TEST_OBSERVED_EFFECTS];

const UL_TEST_OBSERVED_EFFECT_SET = new Set<string>(
  Object.values(UL_TEST_OBSERVED_EFFECTS),
);
const UL_TEST_BLOCKED_EFFECT_SET = new Set<string>(
  Object.values(UL_TEST_BLOCKED_EFFECTS),
);

export const MAX_UL_TEST_OBSERVED_EFFECTS = UL_TEST_OBSERVED_EFFECT_SET.size;

export function isUlTestObservedEffect(
  value: unknown,
): value is UlTestObservedEffect {
  return typeof value === "string" &&
    UL_TEST_OBSERVED_EFFECT_SET.has(value);
}

export function isUlTestBlockedEffect(
  value: unknown,
): value is UlTestBlockedEffect {
  return typeof value === "string" &&
    UL_TEST_BLOCKED_EFFECT_SET.has(value);
}

const OBSERVED_EFFECT_BY_BLOCKED_EFFECT: Record<
  UlTestBlockedEffect,
  UlTestObservedEffect
> = {
  [UL_TEST_BLOCKED_EFFECTS.outboundHttp]: UL_TEST_OBSERVED_EFFECTS.networkHttp,
  [UL_TEST_BLOCKED_EFFECTS.outboundTcp]: UL_TEST_OBSERVED_EFFECTS.networkTcp,
  [UL_TEST_BLOCKED_EFFECTS.credentialedHttp]:
    UL_TEST_OBSERVED_EFFECTS.credentialHttp,
  [UL_TEST_BLOCKED_EFFECTS.imap]: UL_TEST_OBSERVED_EFFECTS.emailImapRead,
  [UL_TEST_BLOCKED_EFFECTS.smtp]: UL_TEST_OBSERVED_EFFECTS.emailSmtpSend,
  [UL_TEST_BLOCKED_EFFECTS.eventPublish]: UL_TEST_OBSERVED_EFFECTS.eventPublish,
  [UL_TEST_BLOCKED_EFFECTS.agentCall]: UL_TEST_OBSERVED_EFFECTS.agentCall,
};

export function observedEffectForBlockedEffect(
  effect: UlTestBlockedEffect,
): UlTestObservedEffect {
  return OBSERVED_EFFECT_BY_BLOCKED_EFFECT[effect];
}

export interface UlTestEffectRecorder {
  recordBlockedEffect(
    effect: UlTestBlockedEffect,
  ): void | Promise<void>;
}

export interface UlTestObservedEffectRecorder {
  recordObservedEffect(
    effect: UlTestObservedEffect,
  ): void | Promise<void>;
}

/**
 * Shared core for the Cloudflare Test* effect bindings.
 *
 * Kept outside WorkerEntrypoint so Deno tests execute the exact latch/error
 * implementation shipped behind those adapters.
 */
export async function blockUlTestEffect(
  recorder: UlTestEffectRecorder,
  effect: UlTestBlockedEffect,
): Promise<never> {
  // Do not throw until the invocation-owned session has durably observed the
  // attempt. This ordering is what makes a caught binding error still
  // disqualify the test.
  await recorder.recordBlockedEffect(effect);
  const error = new Error(
    `gx.test blocked ${
      effect.replaceAll("_", " ")
    }: external effects require a declared test fixture`,
  );
  error.name = "GxTestEffectBlockedError";
  throw error;
}

export const UL_TEST_AI_CONTENT = JSON.stringify({
  assessment: "gx.test deterministic AI response",
  actions: [],
});

export function createUlTestAiResponse() {
  return {
    content: UL_TEST_AI_CONTENT,
    model: "gx-test-stub",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cost_light: 0,
    },
  };
}

export function createUlTestEmbedResponse() {
  return {
    embedding: [0, 0, 0, 0],
    model: "gx-test-embedding-stub",
    dimensions: 4,
    usage: {
      input_tokens: 0,
      total_tokens: 0,
      cost_light: 0,
    },
  };
}

export function createUlTestNotifyResponse() {
  return {
    created: false,
    reason: "test_mode",
  };
}

export function createUlTestRunsResponse(): { runs: unknown[] } {
  return { runs: [] };
}

export function createUlTestMemoryAdapter() {
  const values = new Map<string, unknown>();
  return {
    remember(key: string, value: unknown): Promise<void> {
      values.set(key, value);
      return Promise.resolve();
    },
    recall(key: string): Promise<unknown> {
      return Promise.resolve(values.has(key) ? values.get(key) : null);
    },
  };
}

/**
 * Legacy RuntimeConfig adapter for gx.test.
 *
 * Dynamic execution uses TestAppDataBinding instead. Keeping this adapter
 * entirely in memory prevents the host orchestration path from constructing or
 * cleaning an R2-backed app-data service merely to satisfy the shared runtime
 * contract.
 */
export function createUlTestAppDataService(): AppDataService {
  const values = new Map<
    string,
    { value: unknown; updatedAt: string }
  >();

  const store = (key: string, value: unknown): Promise<void> => {
    values.set(key, {
      value: structuredClone(value),
      updatedAt: new Date().toISOString(),
    });
    return Promise.resolve();
  };
  const load = (key: string): Promise<unknown> => {
    const entry = values.get(key);
    return Promise.resolve(entry ? structuredClone(entry.value) : null);
  };
  const remove = (key: string): Promise<void> => {
    values.delete(key);
    return Promise.resolve();
  };
  const list = (prefix = ""): Promise<string[]> =>
    Promise.resolve(
      [...values.keys()].filter((key) => key.startsWith(prefix)).sort(),
    );
  const query = async (
    prefix: string,
    options: QueryOptions = {},
  ): Promise<QueryResult[]> => {
    let rows = (await list(prefix)).map((key) => {
      const entry = values.get(key)!;
      return {
        key,
        value: structuredClone(entry.value),
        updatedAt: entry.updatedAt,
      };
    });
    if (options.filter) {
      rows = rows.filter((row) => options.filter!(row.value));
    }
    if (options.sort) {
      const { field, order } = options.sort;
      const direction = order === "desc" ? -1 : 1;
      rows.sort((left, right) =>
        String(recordField(left.value, field) ?? "").localeCompare(
          String(recordField(right.value, field) ?? ""),
        ) * direction
      );
    }
    const offset = options.offset && options.offset > 0 ? options.offset : 0;
    const limit = options.limit !== undefined && options.limit >= 0
      ? options.limit
      : rows.length;
    return rows.slice(offset, offset + limit);
  };

  return {
    store,
    load,
    remove,
    list,
    query,
    async batchStore(items) {
      for (const item of items) await store(item.key, item.value);
    },
    async batchLoad(keys) {
      return await Promise.all(keys.map(async (key) => ({
        key,
        value: await load(key),
      })));
    },
    async batchRemove(keys) {
      for (const key of keys) await remove(key);
    },
  };
}

function recordField(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[field];
}
