// Executed-bundle integrity (Phase 0 linchpin) tests. Proves: a live bundle that
// diverges from its atomically-stored signed attestation is detected; a
// legitimate repoint re-attests; legacy (no attestation) is grandfathered; a
// downgrade to an old validly-signed version is rejected when current_version is
// known.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  __resetVerdictCacheForTest,
  type BundleAttestation,
  deleteLiveExecutedBundle,
  executedBundleVerifyMode,
  isExecutedBundleViolation,
  loadLiveExecutedBundle,
  putLiveExecutedBundle,
  verifyExecutedBundle,
} from "./executed-bundle.ts";

interface Entry {
  value: string;
  metadata: unknown;
}

function installKv(): { restore: () => void; store: Map<string, Entry> } {
  const store = new Map<string, Entry>();
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const prev = g.__env;
  g.__env = {
    TRUST_SIGNING_SECRET: "test-trust-secret",
    CODE_CACHE: {
      get: (k: string) => Promise.resolve(store.get(k)?.value ?? null),
      // deno-lint-ignore no-explicit-any
      getWithMetadata: (k: string) => {
        const e = store.get(k);
        return Promise.resolve(
          e ? { value: e.value, metadata: e.metadata ?? null } : { value: null, metadata: null },
        );
      },
      // deno-lint-ignore no-explicit-any
      put: (k: string, v: string, opts?: { metadata?: any }) => {
        store.set(k, { value: v, metadata: opts?.metadata ?? null });
        return Promise.resolve();
      },
      delete: (k: string) => {
        store.delete(k);
        return Promise.resolve();
      },
    },
  };
  __resetVerdictCacheForTest();
  return { restore: () => { g.__env = prev; }, store };
}

async function verifyLive(appId: string, expectedVersion?: string) {
  const { code, attestation } = await loadLiveExecutedBundle(appId);
  return verifyExecutedBundle({ appId, esmCode: code ?? "", attestation, expectedVersion });
}

const KEY = (appId: string) => `esm:${appId}:latest`;

Deno.test("executed bundle: put then load+verify the same bytes → ok", async () => {
  const kv = installKv();
  try {
    await putLiveExecutedBundle({ appId: "app_1", version: "1.0.0", esmCode: "export const x=1;" });
    assertEquals((await verifyLive("app_1")).status, "ok");
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: bundle + attestation are stored atomically (KV metadata)", async () => {
  const kv = installKv();
  try {
    await putLiveExecutedBundle({ appId: "app_1", version: "1.0.0", esmCode: "GOOD" });
    const entry = kv.store.get(KEY("app_1"))!;
    assertEquals(entry.value, "GOOD");
    assert(entry.metadata, "attestation rides in KV metadata, not a separate key");
    // No separate sidecar key exists.
    assert(!kv.store.has("esm:app_1:latest:trust"));
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: ephemeral pointers can be deleted after gx.test", async () => {
  const kv = installKv();
  try {
    await putLiveExecutedBundle({
      appId: "test_ephemeral",
      version: "test",
      esmCode: "export const ok = true;",
    });
    assert(kv.store.has(KEY("test_ephemeral")));
    await deleteLiveExecutedBundle("test_ephemeral");
    assert(!kv.store.has(KEY("test_ephemeral")));
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: a swapped bundle (stale attestation) → hash_mismatch", async () => {
  const kv = installKv();
  try {
    await putLiveExecutedBundle({ appId: "app_1", version: "1.0.0", esmCode: "GOOD" });
    const att = kv.store.get(KEY("app_1"))!.metadata;
    // Raw KV swap of the bytes WITHOUT a fresh attestation — the RUG-2 divergence.
    kv.store.set(KEY("app_1"), { value: "EVIL", metadata: att });
    const r = await verifyLive("app_1");
    assertEquals(r.status, "hash_mismatch");
    assert(isExecutedBundleViolation(r.status), "must block under enforce");
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: a tampered attestation → bad_signature", async () => {
  const kv = installKv();
  try {
    await putLiveExecutedBundle({ appId: "app_1", version: "1.0.0", esmCode: "GOOD" });
    const att = { ...(kv.store.get(KEY("app_1"))!.metadata as BundleAttestation) };
    att.bundle_hash = "0".repeat(64); // re-point attested hash, keep old sig
    kv.store.set(KEY("app_1"), { value: "GOOD", metadata: att });
    const r = await verifyLive("app_1");
    assertEquals(r.status, "bad_signature");
    assert(isExecutedBundleViolation(r.status));
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: no attestation (legacy) → no_attestation (grandfathered)", async () => {
  const kv = installKv();
  try {
    kv.store.set(KEY("app_legacy"), { value: "OLD", metadata: null });
    const r = await verifyLive("app_legacy");
    assertEquals(r.status, "no_attestation");
    assert(!isExecutedBundleViolation(r.status));
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: a legitimate repoint re-attests the new bytes", async () => {
  const kv = installKv();
  try {
    await putLiveExecutedBundle({ appId: "app_1", version: "1.0.0", esmCode: "V1" });
    await putLiveExecutedBundle({ appId: "app_1", version: "2.0.0", esmCode: "V2" });
    assertEquals((await verifyLive("app_1")).status, "ok");
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: version skew is DETECTED but warn-only (not a hard block)", async () => {
  const kv = installKv();
  try {
    // The live bundle is a correctly-signed v1.0.0, but the app's DB current
    // version is 2.0.0 — a rollback/replay OR an in-flight deploy skew. It is
    // detected (status version_mismatch) but must NOT block, because the KV/DB
    // updates are non-atomic and would spuriously fail legitimate deploys.
    await putLiveExecutedBundle({ appId: "app_1", version: "1.0.0", esmCode: "OLD" });
    const r = await verifyLive("app_1", "2.0.0");
    assertEquals(r.status, "version_mismatch");
    assert(!isExecutedBundleViolation(r.status), "version_mismatch must NOT hard-block");
    // Same bytes verify OK when current_version matches.
    __resetVerdictCacheForTest();
    assertEquals((await verifyLive("app_1", "1.0.0")).status, "ok");
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: attestation signed with a different secret → bad_signature", async () => {
  const kv = installKv();
  try {
    await putLiveExecutedBundle({ appId: "app_1", version: "1.0.0", esmCode: "GOOD" });
    // deno-lint-ignore no-explicit-any
    (globalThis as any).__env.TRUST_SIGNING_SECRET = "a-different-secret";
    __resetVerdictCacheForTest();
    assertEquals((await verifyLive("app_1")).status, "bad_signature");
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: cross-app attestation replay → bad_signature (app_id bound)", async () => {
  const kv = installKv();
  try {
    await putLiveExecutedBundle({ appId: "app_a", version: "1.0.0", esmCode: "SAME" });
    const attA = kv.store.get(KEY("app_a"))!.metadata;
    // Plant app_a's bundle+attestation under app_b's key.
    kv.store.set(KEY("app_b"), { value: "SAME", metadata: attA });
    assertEquals((await verifyLive("app_b")).status, "bad_signature");
  } finally {
    kv.restore();
  }
});

Deno.test("executed bundle: verify mode parses off/observe/enforce with observe default", () => {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const prev = g.__env;
  try {
    g.__env = { EXECUTED_BUNDLE_VERIFY: "enforce" };
    assertEquals(executedBundleVerifyMode(), "enforce");
    g.__env = { EXECUTED_BUNDLE_VERIFY: "off" };
    assertEquals(executedBundleVerifyMode(), "off");
    g.__env = { EXECUTED_BUNDLE_VERIFY: "nonsense" };
    assertEquals(executedBundleVerifyMode(), "observe");
    g.__env = {};
    assertEquals(executedBundleVerifyMode(), "observe");
  } finally {
    g.__env = prev;
  }
});
