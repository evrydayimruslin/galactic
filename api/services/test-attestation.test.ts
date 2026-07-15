import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  computeDecodedSourceHash,
  decodeSourceFileSet,
  findPersistedTestAttestation,
  issueTestAttestation,
  persistedTestAttestation,
  verifyTestAttestation,
} from "./test-attestation.ts";
import type { VersionMetadata } from "../../shared/types/index.ts";

const NOW = new Date("2026-07-14T20:00:00.000Z");
const FILES = [
  { path: "manifest.json", content: '{"name":"agent"}' },
  { path: "index.ts", content: "export function run() { return 1; }" },
];

async function signed(overrides: {
  userId?: string;
  sourceHash?: string;
  ttlSeconds?: number;
} = {}) {
  const sourceHash = overrides.sourceHash ??
    await computeDecodedSourceHash(FILES);
  return await issueTestAttestation({
    userId: overrides.userId ?? "user-1",
    sourceHash,
    mode: "deno_execution",
    now: NOW,
    ttlSeconds: overrides.ttlSeconds ?? 300,
  });
}

Deno.test("test attestation: decoded text and base64 uploads hash identically", async () => {
  const text = decodeSourceFileSet(FILES);
  const encoded = decodeSourceFileSet(
    FILES.map((file) => ({
      path: file.path,
      content: btoa(file.content),
      encoding: "base64",
    })),
  );
  assertEquals(
    await computeDecodedSourceHash(text),
    await computeDecodedSourceHash(encoded),
  );
});

Deno.test("test attestation: source paths must be exact canonical relative POSIX paths", () => {
  for (const path of [
    " ../index.ts",
    "../index.ts",
    "src/../index.ts",
    "src//index.ts",
    "/index.ts",
    "src\\index.ts",
    "src/./index.ts",
  ]) {
    let message = "";
    try {
      decodeSourceFileSet([{ path, content: "export {};" }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.length > 0, `${path} should be rejected`);
  }
});

Deno.test("test attestation: valid token is bound to user, source, mode, and expiry", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signed({ sourceHash });
  const verified = await verifyTestAttestation({
    token: issued.token,
    userId: "user-1",
    sourceHash,
    mode: "deno_execution",
    now: NOW,
  });
  assert(verified.valid);
  assertEquals(verified.claims.source_hash, sourceHash);
});

Deno.test("test attestation: absent and forged tokens fail closed", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  assertEquals(
    await verifyTestAttestation({
      token: undefined,
      userId: "user-1",
      sourceHash,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "missing" },
  );
  const issued = await signed({ sourceHash });
  const forged = issued.token.slice(0, -1) +
    (issued.token.endsWith("0") ? "1" : "0");
  assertEquals(
    await verifyTestAttestation({
      token: forged,
      userId: "user-1",
      sourceHash,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "bad_signature" },
  );
});

Deno.test("test attestation: expired token fails closed", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signed({ sourceHash, ttlSeconds: 1 });
  assertEquals(
    await verifyTestAttestation({
      token: issued.token,
      userId: "user-1",
      sourceHash,
      mode: "deno_execution",
      now: new Date(NOW.getTime() + 1001),
    }),
    { valid: false, reason: "expired" },
  );
});

Deno.test("test attestation: wrong user and wrong source cannot replay", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signed({ sourceHash });
  assertEquals(
    await verifyTestAttestation({
      token: issued.token,
      userId: "user-2",
      sourceHash,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "wrong_user" },
  );
  const changedHash = await computeDecodedSourceHash([
    ...FILES,
    { path: "extra.ts", content: "export const changed = true;" },
  ]);
  assertEquals(
    await verifyTestAttestation({
      token: issued.token,
      userId: "user-1",
      sourceHash: changedHash,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "wrong_source" },
  );
  assertEquals(
    await verifyTestAttestation({
      token: issued.token,
      userId: "user-1",
      sourceHash,
      mode: "gpu_validation",
      now: NOW,
    }),
    { valid: false, reason: "wrong_mode" },
  );
});

Deno.test("test attestation: promotion proof must match persisted source and runtime", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signed({ sourceHash });
  const proof = persistedTestAttestation(issued.claims, NOW);
  const metadata: VersionMetadata[] = [{
    version: "1.2.3",
    size_bytes: 1,
    created_at: NOW.toISOString(),
    source_hash: sourceHash,
    test_attestation: proof,
  }];
  assert(findPersistedTestAttestation(metadata, "1.2.3"));
  assertEquals(
    findPersistedTestAttestation(
      [{ ...metadata[0], source_hash: "0".repeat(64) }],
      "1.2.3",
    ),
    null,
  );
});
