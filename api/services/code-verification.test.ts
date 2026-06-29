// Open-code verification (Phase 2) tests. Proves: per-file matching keys on the
// signed sourceKey (readable source, not the executed bundle); readVersionSource
// drops the bundle sibling; the verdict anchors to the LIVE attested version (so
// a rollback verifies the bytes that actually run); and open-code divergence
// drops verified to false.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  __resetFileMatchCacheForTest,
  buildVerificationVerdict,
  getVersionTrust,
  matchFilesAgainstHashes,
  readVersionSourceFiles,
} from "./code-verification.ts";
import { buildVersionTrustMetadata, sha256Hex } from "./trust.ts";
import { __resetVerdictCacheForTest, putLiveExecutedBundle } from "./executed-bundle.ts";

// deno-lint-ignore no-explicit-any
function fakeR2(files: Record<string, string>): any {
  return {
    // deno-lint-ignore no-explicit-any
    list: ({ prefix }: { prefix: string }) =>
      Promise.resolve({
        objects: Object.keys(files)
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
    get: (key: string) =>
      Promise.resolve(
        key in files ? { text: () => Promise.resolve(files[key]) } : null,
      ),
  };
}

function installEnv(r2Files?: Record<string, string>): { restore: () => void } {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const prev = g.__env;
  const store = new Map<string, { value: string; metadata: unknown }>();
  g.__env = {
    TRUST_SIGNING_SECRET: "test-trust-secret",
    R2_BUCKET: r2Files ? fakeR2(r2Files) : undefined,
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
  __resetFileMatchCacheForTest();
  return { restore: () => { g.__env = prev; } };
}

Deno.test("match: keys on sourceKey so source is matched, not the bundle", async () => {
  const env = installEnv();
  try {
    const source = "export const x = 1;";
    const bundle = "var x=1;export{x};"; // different bytes, signed under index.ts
    const hashes = {
      ["_source_index.ts"]: await sha256Hex(source),
      ["index.ts"]: await sha256Hex(bundle),
    };
    // The readable source file (sourceKey _source_index.ts) must match the SOURCE
    // hash, never the bundle hash under its display path index.ts.
    const r = await matchFilesAgainstHashes(
      [{ path: "index.ts", content: source, sourceKey: "_source_index.ts" }],
      hashes,
    );
    assertEquals(r.files[0].matches, true);
    assertEquals(r.files[0].published_sha256, hashes["_source_index.ts"]);
    assert(r.all_match);
  } finally {
    env.restore();
  }
});

Deno.test("match: a tampered file does NOT match", async () => {
  const env = installEnv();
  try {
    const hashes = { ["index.ts"]: await sha256Hex("original") };
    const r = await matchFilesAgainstHashes([{ path: "index.ts", content: "TAMPERED" }], hashes);
    assertEquals(r.files[0].matches, false);
    assertEquals(r.all_match, false);
  } finally {
    env.restore();
  }
});

Deno.test("match: a returned-but-unsigned file fails all_match (conservative)", async () => {
  const env = installEnv();
  try {
    const hashes = { ["index.ts"]: await sha256Hex("a") };
    const r = await matchFilesAgainstHashes(
      [
        { path: "index.ts", content: "a" },
        { path: "extra.ts", content: "sneaky" },
      ],
      hashes,
    );
    assertEquals(r.files[0].matches, true);
    assertEquals(r.files[1].matches, false);
    assertEquals(r.all_match, false);
  } finally {
    env.restore();
  }
});

Deno.test("readVersionSourceFiles: drops generated bundles, keeps source incl. mid-name _source_", async () => {
  const env = installEnv({
    "apps/app_b/1.0.0/index.tsx": "IIFE_BUNDLE", // generated IIFE bundle -> dropped
    "apps/app_b/1.0.0/index.esm.js": "ESM_BUNDLE", // generated ESM bundle -> dropped
    "apps/app_b/1.0.0/_source_index.tsx": "SOURCE_BYTES", // entry source -> kept
    "apps/app_b/1.0.0/lib/util.ts": "UTIL", // non-entry source -> kept
    "apps/app_b/1.0.0/my_source_helper.ts": "HELPER", // mid-name _source_ -> KEPT (regression guard)
    "apps/app_b/1.0.0/embedding.json": "{}", // internal artifact -> skipped
  });
  try {
    const files = await readVersionSourceFiles("app_b", "1.0.0");
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    // entry: present exactly once, the SOURCE bytes (both bundles dropped).
    assertEquals(files.filter((f) => f.path === "index.tsx").length, 1);
    assertEquals(byPath["index.tsx"].content, "SOURCE_BYTES");
    assertEquals(byPath["index.tsx"].sourceKey, "_source_index.tsx");
    assert(!("index.esm.js" in byPath), "ESM bundle must be dropped");
    // source files kept (including the mid-name _source_ one).
    assertEquals(byPath["lib/util.ts"].content, "UTIL");
    assertEquals(byPath["my_source_helper.ts"].content, "HELPER");
    assert(!("embedding.json" in byPath));
  } finally {
    env.restore();
  }
});

Deno.test("getVersionTrust: selects the requested version's trust", () => {
  const app = {
    current_version: "2.0.0",
    // deno-lint-ignore no-explicit-any
    version_metadata: [
      { version: "1.0.0", trust: { version: "1.0.0" } },
      { version: "2.0.0", trust: { version: "2.0.0" } },
    ] as any,
  };
  assertEquals(getVersionTrust(app, "1.0.0")?.version, "1.0.0");
  assertEquals(getVersionTrust(app, "2.0.0")?.version, "2.0.0");
  assertEquals(getVersionTrust(app, "9.9.9"), null);
});

Deno.test("verdict: open-code app with matching source => verified + files_match", async () => {
  const source = "export const x=1;";
  const bundle = "var x=1;";
  const env = installEnv({
    "apps/app_x/1.0.0/_source_index.ts": source,
    "apps/app_x/1.0.0/index.ts": bundle,
  });
  try {
    const manifest = {
      name: "x",
      version: "1.0.0",
      type: "mcp" as const,
      entry: { functions: "index.ts" },
      functions: {},
    };
    const trust = await buildVersionTrustMetadata({
      appId: "app_x",
      version: "1.0.0",
      runtime: "deno",
      manifest,
      files: [
        { name: "_source_index.ts", content: source },
        { name: "index.ts", content: bundle },
      ],
    });
    await putLiveExecutedBundle({ appId: "app_x", version: "1.0.0", esmCode: bundle });

    const app = {
      id: "app_x",
      name: "x",
      current_version: "1.0.0",
      runtime: "deno",
      manifest: JSON.stringify(manifest),
      version_metadata: [{ version: "1.0.0", size_bytes: 1, created_at: "t", trust }],
      visibility: "public",
      download_access: "public",
      env_schema: {},
      // deno-lint-ignore no-explicit-any
    } as any;

    const verdict = await buildVerificationVerdict(app);
    assertEquals(verdict.files_match, true);
    assertEquals(verdict.verified, true);
    assertEquals(verdict.open_code, true);
  } finally {
    env.restore();
  }
});

Deno.test("verdict: open-code source divergence => files_match false => NOT verified", async () => {
  const signedSource = "export const x=1;";
  const env = installEnv({
    // R2 serves DIFFERENT source bytes than were signed (divergence).
    "apps/app_d/1.0.0/_source_index.ts": "export const x=999;",
  });
  try {
    const manifest = {
      name: "d",
      version: "1.0.0",
      type: "mcp" as const,
      entry: { functions: "index.ts" },
      functions: {},
    };
    const trust = await buildVersionTrustMetadata({
      appId: "app_d",
      version: "1.0.0",
      runtime: "deno",
      manifest,
      files: [{ name: "_source_index.ts", content: signedSource }],
    });
    await putLiveExecutedBundle({ appId: "app_d", version: "1.0.0", esmCode: "BUNDLE" });

    const app = {
      id: "app_d",
      name: "d",
      current_version: "1.0.0",
      runtime: "deno",
      manifest: JSON.stringify(manifest),
      version_metadata: [{ version: "1.0.0", size_bytes: 1, created_at: "t", trust }],
      visibility: "public",
      download_access: "public",
      env_schema: {},
      // deno-lint-ignore no-explicit-any
    } as any;

    const verdict = await buildVerificationVerdict(app);
    assertEquals(verdict.files_match, false);
    assertEquals(verdict.verified, false); // divergence can't read as verified
  } finally {
    env.restore();
  }
});

Deno.test("verdict: open-code app whose source can't be read => filesMatch null => NOT verified", async () => {
  // No R2_BUCKET seeded => readVersionSourceFiles throws => filesMatch stays null.
  // For an open-code app that must read as NOT verified (can't confirm the
  // open-code promise), never green by default.
  const env = installEnv();
  try {
    const manifest = {
      name: "n",
      version: "1.0.0",
      type: "mcp" as const,
      entry: { functions: "index.ts" },
      functions: {},
    };
    const trust = await buildVersionTrustMetadata({
      appId: "app_n",
      version: "1.0.0",
      runtime: "deno",
      manifest,
      files: [{ name: "_source_index.ts", content: "src" }],
    });
    await putLiveExecutedBundle({ appId: "app_n", version: "1.0.0", esmCode: "B" });
    const app = {
      id: "app_n",
      name: "n",
      current_version: "1.0.0",
      runtime: "deno",
      manifest: JSON.stringify(manifest),
      version_metadata: [{ version: "1.0.0", size_bytes: 1, created_at: "t", trust }],
      visibility: "public",
      download_access: "public", // open code, but source unreadable here
      env_schema: {},
      // deno-lint-ignore no-explicit-any
    } as any;
    const verdict = await buildVerificationVerdict(app);
    assertEquals(verdict.files_match, null);
    assertEquals(verdict.integrity.published_signature_valid, true);
    assertEquals(verdict.integrity.executed_bundle_ok, true);
    assertEquals(verdict.verified, false); // open code + unreadable => not green
  } finally {
    env.restore();
  }
});

Deno.test("verdict: a gx.set rollback verifies the LIVE version, not DB current_version", async () => {
  const env = installEnv();
  try {
    const mkTrust = (version: string) =>
      buildVersionTrustMetadata({
        appId: "app_r",
        version,
        runtime: "deno",
        manifest: {
          name: "r",
          version,
          type: "mcp" as const,
          entry: { functions: "index.ts" },
          functions: {},
        },
        files: [{ name: "index.ts", content: "v" + version }],
      });
    const trust1 = await mkTrust("1.0.0");
    const trust2 = await mkTrust("2.0.0");
    // Live KV is pinned to the OLD (validly-signed) 1.0.0 — a rollback — while the
    // DB current_version has advanced to 2.0.0.
    await putLiveExecutedBundle({ appId: "app_r", version: "1.0.0", esmCode: "BUNDLE_1" });

    const app = {
      id: "app_r",
      name: "r",
      current_version: "2.0.0",
      runtime: "deno",
      manifest: JSON.stringify({ name: "r", version: "2.0.0", type: "mcp", entry: { functions: "index.ts" }, functions: {} }),
      version_metadata: [
        { version: "1.0.0", size_bytes: 1, created_at: "t", trust: trust1 },
        { version: "2.0.0", size_bytes: 1, created_at: "t", trust: trust2 },
      ],
      visibility: "public",
      download_access: "owner",
      env_schema: {},
      // deno-lint-ignore no-explicit-any
    } as any;

    const verdict = await buildVerificationVerdict(app);
    // Anchored to what RUNS: version 1.0.0, validly signed => verified, no spurious
    // version_mismatch failure.
    assertEquals(verdict.version, "1.0.0");
    assertEquals(verdict.integrity.executed_bundle_status, "ok");
    assertEquals(verdict.verified, true);
  } finally {
    env.restore();
  }
});

Deno.test("verdict: a legacy app with no signed trust is NOT verified", async () => {
  const env = installEnv();
  try {
    const app = {
      id: "app_legacy",
      name: "legacy",
      current_version: "1.0.0",
      runtime: "deno",
      manifest: null,
      version_metadata: [],
      visibility: "public",
      download_access: "owner",
      env_schema: {},
      // deno-lint-ignore no-explicit-any
    } as any;
    const verdict = await buildVerificationVerdict(app);
    assertEquals(verdict.integrity.published_signature_valid, false);
    assertEquals(verdict.verified, false);
  } finally {
    env.restore();
  }
});
