import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  computeCanonicalDecodedSourceHash,
  computeDecodedSourceHash,
  decodeSourceFileSet,
  findPersistedTestAttestation,
  issueTestAttestation,
  persistedTestAttestation,
  type TestAttestationClaims,
  type TestAttestationQualification,
  verifyTestAttestation,
  verifyVersionQualificationEvidence,
} from "./test-attestation.ts";
import {
  buildVersionMetadataEntry,
  buildVersionTrustMetadata,
  signWithTrustSecret,
} from "./trust.ts";
import type {
  VersionMetadata,
  VersionTestAttestationMetadataV2,
} from "../../shared/types/index.ts";

const NOW = new Date("2026-07-14T20:00:00.000Z");
const FILES = [
  { path: "manifest.json", content: '{"name":"agent"}' },
  { path: "index.ts", content: "export function run() { return 1; }" },
];
const DOCUMENT_DIGEST = "a".repeat(64);
const RELEASE_DIGEST = "b".repeat(64);
const REPORT_DIGEST = "c".repeat(64);

Deno.test("gxt2 source hash is canonical across Unicode path order", async () => {
  const files = [
    { path: "ä.ts", content: "a" },
    { path: "z.ts", content: "z" },
  ];
  assertEquals(
    await computeCanonicalDecodedSourceHash(files),
    await computeCanonicalDecodedSourceHash([...files].reverse()),
  );
});

function basicQualification(): TestAttestationQualification {
  return {
    profile: "basic",
    document_digest: DOCUMENT_DIGEST,
    release_digest: RELEASE_DIGEST,
    report_digest: REPORT_DIGEST,
    compiler_revision: "compiler-2026.07",
    runtime_revision: "runtime-2026.07",
    policy_revision: "basic-1",
    cases: {
      declared: 3,
      required: 2,
      passed: 2,
      optional_failed: 1,
    },
    functions: {
      declared: 3,
      exercised: 1,
    },
    effects: {
      declared: 2,
      exercised: 1,
      untested: 1,
    },
  };
}

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

async function signedV2(overrides: {
  userId?: string;
  sourceHash?: string;
  ttlSeconds?: number;
  qualification?: TestAttestationQualification;
} = {}) {
  const sourceHash = overrides.sourceHash ??
    await computeDecodedSourceHash(FILES);
  return await issueTestAttestation({
    userId: overrides.userId ?? "user-1",
    sourceHash,
    mode: "deno_execution",
    now: NOW,
    ttlSeconds: overrides.ttlSeconds ?? 300,
    qualification: overrides.qualification ?? basicQualification(),
  });
}

async function qualifiedVersionEntry(overrides: {
  proof: VersionTestAttestationMetadataV2;
  appId?: string;
  version?: string;
  runtime?: string;
  sourceHash?: string;
  bindProof?: boolean;
  bindExecutable?: boolean;
}): Promise<VersionMetadata> {
  const appId = overrides.appId ?? "app-qualified";
  const version = overrides.version ?? "2.0.0";
  const runtime = overrides.runtime ?? "deno";
  const sourceHash = overrides.sourceHash ??
    await computeDecodedSourceHash(FILES);
  const proof = overrides.proof;
  const trust = await buildVersionTrustMetadata({
    appId,
    version,
    runtime,
    manifest: {
      name: "Qualified",
      version,
      type: "mcp" as const,
      entry: { functions: "index.ts" },
      functions: { run: { description: "Run" } },
    },
    files: [{ name: "index.ts", content: FILES[1].content }],
    ...(overrides.bindExecutable === false
      ? {}
      : { executable: "export function run() { return 1; }" }),
    ...(overrides.bindProof === false ? {} : { testAttestation: proof }),
  });
  return buildVersionMetadataEntry(
    version,
    1,
    trust,
    sourceHash,
    proof,
  );
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function signClaims(
  prefix: "gxt1" | "gxt2",
  domain: "gx.test/v1" | "gx.test/v2",
  claims: unknown,
): Promise<string> {
  const encoded = base64UrlEncode(JSON.stringify(claims));
  const signature = await signWithTrustSecret(`${domain}.${encoded}`);
  return `${prefix}.${encoded}.${signature}`;
}

Deno.test("test attestation: decoded text and base64 uploads hash identically", async () => {
  const unicodeFiles = [
    ...FILES,
    { path: "message.txt", content: "Galactic 🪐" },
  ];
  const text = decodeSourceFileSet(unicodeFiles);
  const encoded = decodeSourceFileSet(
    unicodeFiles.map((file) => ({
      path: file.path,
      content: btoa(String.fromCharCode(
        ...new TextEncoder().encode(file.content),
      )),
      encoding: "base64",
    })),
  );
  assertEquals(
    await computeDecodedSourceHash(text),
    await computeDecodedSourceHash(encoded),
  );
});

Deno.test("test attestation: wasm base64 preserves exact non-UTF-8 bytes", async () => {
  const bytes = new Uint8Array([0, 97, 255, 128]);
  const decoded = decodeSourceFileSet([
    { path: "module.wasm", content: "AGH/gA==", encoding: "base64" },
  ]);

  assertEquals(decoded[0].bytes, bytes);
  assertEquals(
    await computeDecodedSourceHash(decoded),
    await computeDecodedSourceHash([{
      path: "module.wasm",
      content: "",
      bytes,
    }]),
  );

  let message = "";
  try {
    decodeSourceFileSet([{ path: "module.wasm", content: "\0aÿ\u0080" }]);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("must use base64 encoding"));
});

Deno.test("test attestation: source paths must be exact canonical relative POSIX paths", () => {
  for (
    const path of [
      " ../index.ts",
      "../index.ts",
      "src/../index.ts",
      "src//index.ts",
      "/index.ts",
      "src\\index.ts",
      "src/./index.ts",
    ]
  ) {
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
  assert(issued.token.startsWith("gxt1."));
  assertEquals(issued.claims.schema_version, 1);
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

Deno.test("test attestation: V2 signs and persists compact basic qualification evidence", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signedV2({ sourceHash });
  assert(issued.token.startsWith("gxt2."));
  assertEquals(issued.claims.schema_version, 2);

  const verified = await verifyTestAttestation({
    token: issued.token,
    userId: "user-1",
    sourceHash,
    mode: "deno_execution",
    now: NOW,
  });
  assert(verified.valid);
  assertEquals(verified.claims.schema_version, 2);
  if (verified.claims.schema_version !== 2) {
    throw new Error("Expected V2 claims");
  }
  assertEquals(verified.claims.qualification, basicQualification());
  assertEquals(
    await verifyTestAttestation({
      token: issued.token,
      userId: "another-user",
      sourceHash,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "wrong_user" },
  );

  const proof = persistedTestAttestation(verified.claims, NOW);
  assertEquals(proof.schema_version, 2);
  if (proof.schema_version !== 2) throw new Error("Expected V2 metadata");
  assertEquals(proof.qualification, basicQualification());
  assert(!JSON.stringify(proof).includes("case_ids"));
  assert(!JSON.stringify(proof).includes("effect_targets"));

  const metadata: VersionMetadata[] = [{
    version: "2.0.0",
    size_bytes: 1,
    created_at: NOW.toISOString(),
    source_hash: sourceHash,
    test_attestation: proof,
  }];
  const persisted = findPersistedTestAttestation(metadata, "2.0.0");
  assert(persisted);
  assertEquals(persisted.attestation.schema_version, 2);
});

Deno.test("test attestation: durable V2 qualification requires an exact signed VersionTrust binding", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signedV2({ sourceHash });
  const proof = persistedTestAttestation(
    issued.claims,
    NOW,
  ) as VersionTestAttestationMetadataV2;
  const entry = await qualifiedVersionEntry({ sourceHash, proof });

  const verified = await verifyVersionQualificationEvidence(entry, {
    appId: "app-qualified",
    version: "2.0.0",
  });
  assert(verified);
  assertEquals(verified.attestation, proof);

  assertEquals(
    await verifyVersionQualificationEvidence(entry, {
      appId: "another-app",
      version: "2.0.0",
    }),
    null,
  );
  assertEquals(
    await verifyVersionQualificationEvidence(entry, {
      appId: "app-qualified",
      version: "3.0.0",
    }),
    null,
  );

  const tamperedProof = structuredClone(entry);
  if (tamperedProof.test_attestation?.schema_version !== 2) {
    throw new Error("Expected V2 proof");
  }
  tamperedProof.test_attestation.qualification.report_digest = "e".repeat(64);
  assertEquals(
    await verifyVersionQualificationEvidence(tamperedProof, {
      appId: "app-qualified",
      version: "2.0.0",
    }),
    null,
  );

  const tamperedTrust = structuredClone(entry);
  if (!tamperedTrust.trust) throw new Error("Expected VersionTrust metadata");
  tamperedTrust.trust.permissions = ["network:undeclared"];
  assertEquals(
    await verifyVersionQualificationEvidence(tamperedTrust, {
      appId: "app-qualified",
      version: "2.0.0",
    }),
    null,
  );
});

Deno.test("test attestation: V2 proof cannot qualify without binding or on a non-Deno runtime", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signedV2({ sourceHash });
  const proof = persistedTestAttestation(
    issued.claims,
    NOW,
  ) as VersionTestAttestationMetadataV2;

  const unbound = await qualifiedVersionEntry({
    sourceHash,
    proof,
    bindProof: false,
  });
  assert(findPersistedTestAttestation([unbound], "2.0.0"));
  assertEquals(
    await verifyVersionQualificationEvidence(unbound, {
      appId: "app-qualified",
      version: "2.0.0",
    }),
    null,
  );

  const noExecutable = await qualifiedVersionEntry({
    sourceHash,
    proof,
    bindExecutable: false,
  });
  assertEquals(
    await verifyVersionQualificationEvidence(noExecutable, {
      appId: "app-qualified",
      version: "2.0.0",
    }),
    null,
  );

  const gpu = await qualifiedVersionEntry({
    sourceHash,
    proof,
    runtime: "gpu",
  });
  assertEquals(
    await verifyVersionQualificationEvidence(gpu, {
      appId: "app-qualified",
      version: "2.0.0",
    }),
    null,
  );
});

Deno.test("test attestation: signed V2 trust cannot be downgraded to a structural V1 proof", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signedV2({ sourceHash });
  const proof = persistedTestAttestation(
    issued.claims,
    NOW,
  ) as VersionTestAttestationMetadataV2;
  const entry = await qualifiedVersionEntry({ sourceHash, proof });
  assert(entry.trust?.test_attestation_digest);

  const downgraded = structuredClone(entry);
  downgraded.test_attestation = {
    schema_version: 1,
    attestation_id: proof.attestation_id,
    mode: proof.mode,
    source_hash: proof.source_hash,
    tested_at: proof.tested_at,
    token_expires_at: proof.token_expires_at,
    verified_at: proof.verified_at,
  };

  assertEquals(
    findPersistedTestAttestation([downgraded], "2.0.0"),
    null,
  );
});

Deno.test("test attestation: durable V2 verifier rejects malformed proof even when its digest is signed", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signedV2({ sourceHash });
  const proof = persistedTestAttestation(
    issued.claims,
    NOW,
  ) as VersionTestAttestationMetadataV2;
  const malformed = {
    ...proof,
    verified_at: proof.token_expires_at,
  };
  const entry = await qualifiedVersionEntry({
    sourceHash,
    proof: malformed,
  });

  assertEquals(
    await verifyVersionQualificationEvidence(entry, {
      appId: "app-qualified",
      version: "2.0.0",
    }),
    null,
  );
});

Deno.test("test attestation: V2 rejects malformed qualification digests, revisions, counts, and extra detail", async () => {
  const invalidQualifications: Array<{
    name: string;
    mutate: (qualification: Record<string, unknown>) => void;
  }> = [
    {
      name: "document digest",
      mutate: (qualification) => {
        qualification.document_digest = "not-a-digest";
      },
    },
    {
      name: "release digest",
      mutate: (qualification) => {
        qualification.release_digest = "D".repeat(64);
      },
    },
    {
      name: "report digest",
      mutate: (qualification) => {
        qualification.report_digest = "c".repeat(63);
      },
    },
    {
      name: "revision",
      mutate: (qualification) => {
        qualification.runtime_revision = "x".repeat(129);
      },
    },
    {
      name: "case ordering",
      mutate: (qualification) => {
        (qualification.cases as Record<string, unknown>).passed = 3;
      },
    },
    {
      name: "function coverage",
      mutate: (qualification) => {
        (qualification.functions as Record<string, unknown>).exercised = 4;
      },
    },
    {
      name: "effect coverage",
      mutate: (qualification) => {
        (qualification.effects as Record<string, unknown>).untested = 0;
      },
    },
    {
      name: "unsafe count",
      mutate: (qualification) => {
        (qualification.cases as Record<string, unknown>).declared =
          Number.MAX_SAFE_INTEGER + 1;
      },
    },
    {
      name: "raw case IDs",
      mutate: (qualification) => {
        (qualification.cases as Record<string, unknown>).ids = ["case-1"];
      },
    },
  ];

  const sourceHash = await computeDecodedSourceHash(FILES);
  for (const invalid of invalidQualifications) {
    const qualification = structuredClone(
      basicQualification(),
    ) as unknown as Record<string, unknown>;
    invalid.mutate(qualification);
    await assertRejects(
      () =>
        issueTestAttestation({
          userId: "user-1",
          sourceHash,
          mode: "deno_execution",
          now: NOW,
          qualification:
            qualification as unknown as TestAttestationQualification,
        }),
      Error,
      "Invalid gx.test qualification metadata",
      invalid.name,
    );
  }
});

Deno.test("test attestation: V2 verification enforces its schema and signing domain", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signedV2({ sourceHash });
  const claims = structuredClone(issued.claims) as TestAttestationClaims;
  assertEquals(claims.schema_version, 2);
  if (claims.schema_version !== 2) throw new Error("Expected V2 claims");
  (claims.qualification.cases as Record<string, unknown>).ids = ["case-1"];

  const signedMalformed = await signClaims("gxt2", "gx.test/v2", claims);
  assertEquals(
    await verifyTestAttestation({
      token: signedMalformed,
      userId: "user-1",
      sourceHash,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "malformed" },
  );

  const wrongDomain = await signClaims(
    "gxt2",
    "gx.test/v1",
    issued.claims,
  );
  assertEquals(
    await verifyTestAttestation({
      token: wrongDomain,
      userId: "user-1",
      sourceHash,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "bad_signature" },
  );

  const wrongPrefix = await signClaims(
    "gxt1",
    "gx.test/v1",
    issued.claims,
  );
  assertEquals(
    await verifyTestAttestation({
      token: wrongPrefix,
      userId: "user-1",
      sourceHash,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "malformed" },
  );
});

Deno.test("test attestation: verification rejects oversized tokens", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  assertEquals(
    await verifyTestAttestation({
      token: `gxt2.${"a".repeat(8192)}.${"0".repeat(64)}`,
      userId: "user-1",
      sourceHash,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "malformed" },
  );
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
  assertEquals(
    findPersistedTestAttestation(
      [
        metadata[0],
        {
          version: "1.2.3",
          size_bytes: 2,
          created_at: new Date(NOW.getTime() + 1_000).toISOString(),
          source_hash: sourceHash,
        },
      ],
      "1.2.3",
    ),
    null,
  );
});

Deno.test("test attestation: malformed persisted V2 qualification fails closed", async () => {
  const sourceHash = await computeDecodedSourceHash(FILES);
  const issued = await signedV2({ sourceHash });
  const proof = persistedTestAttestation(
    issued.claims,
    NOW,
  ) as VersionTestAttestationMetadataV2;
  const metadata: VersionMetadata[] = [{
    version: "2.0.0",
    size_bytes: 1,
    created_at: NOW.toISOString(),
    source_hash: sourceHash,
    test_attestation: proof,
  }];
  assert(findPersistedTestAttestation(metadata, "2.0.0"));

  const badDigest = structuredClone(proof);
  badDigest.qualification.release_digest = "not-a-digest";
  assertEquals(
    findPersistedTestAttestation(
      [{ ...metadata[0], test_attestation: badDigest }],
      "2.0.0",
    ),
    null,
  );

  const badCounts = structuredClone(proof);
  badCounts.qualification.effects.exercised = 2;
  assertEquals(
    findPersistedTestAttestation(
      [{ ...metadata[0], test_attestation: badCounts }],
      "2.0.0",
    ),
    null,
  );
});
