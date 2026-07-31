import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type {
  VersionMetadata,
  VersionTestQualificationMetadata,
} from "../../shared/types/index.ts";
import {
  assertQualificationMatchesPreparedRelease,
  assertQualifiedReleaseArtifactsRetained,
  computePreparedPipelineReleaseIdentity,
} from "./galactic-qualified-release.ts";
import {
  GALACTIC_BASIC_POLICY_REVISION,
  GALACTIC_COMPILER_REVISION,
  GALACTIC_RUNTIME_CONTRACT_REVISION,
} from "./galactic-release-identity.ts";
import {
  findPersistedTestAttestation,
  issueTestAttestation,
  persistedTestAttestation,
  verifyTestAttestation,
} from "./test-attestation.ts";
import { signWithTrustSecret } from "./trust.ts";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const SOURCE_HASH = "a".repeat(64);
const DOCUMENT_DIGEST = "b".repeat(64);
const REPORT_DIGEST = "c".repeat(64);

const prepared = {
  sourceHash: SOURCE_HASH,
  documentDigest: DOCUMENT_DIGEST,
  filesToUpload: [
    {
      name: "galactic.yaml",
      content: "apiVersion: agents.connectgalactic.com/v1alpha1\nkind: Agent\n",
    },
    { name: "manifest.json", content: '{"name":"qualified-agent"}' },
  ],
  interfaceArtifacts: [
    { name: `${"d".repeat(64)}.html`, content: "<p>owner interface</p>" },
  ],
  esmBundledCode: "export const run=()=>({ok:true});",
};

function baseQualification(
  releaseDigest: string,
): VersionTestQualificationMetadata {
  return {
    profile: "basic",
    document_digest: DOCUMENT_DIGEST,
    release_digest: releaseDigest,
    report_digest: REPORT_DIGEST,
    compiler_revision: GALACTIC_COMPILER_REVISION,
    runtime_revision: GALACTIC_RUNTIME_CONTRACT_REVISION,
    policy_revision: GALACTIC_BASIC_POLICY_REVISION,
    cases: {
      declared: 2,
      required: 1,
      passed: 1,
      optional_failed: 1,
    },
    functions: { declared: 2, exercised: 1 },
    effects: { declared: 2, exercised: 1, untested: 1 },
  };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

Deno.test("qualification evidence: every current contract revision and identity layer is rechecked", async () => {
  const identity = await computePreparedPipelineReleaseIdentity(prepared);
  const qualification = baseQualification(identity.release_digest);

  await assertQualificationMatchesPreparedRelease({
    qualification,
    prepared,
  });

  const mismatches: Array<{
    name: string;
    qualification?: VersionTestQualificationMetadata;
    prepared?: typeof prepared;
  }> = [
    {
      name: "source",
      prepared: { ...prepared, sourceHash: "e".repeat(64) },
    },
    {
      name: "document",
      prepared: { ...prepared, documentDigest: "f".repeat(64) },
    },
    {
      name: "prepared artifact",
      prepared: {
        ...prepared,
        filesToUpload: prepared.filesToUpload.map((file) =>
          file.name === "manifest.json"
            ? { ...file, content: '{"name":"tampered"}' }
            : file
        ),
      },
    },
    {
      name: "interface artifact",
      prepared: {
        ...prepared,
        interfaceArtifacts: [{
          ...prepared.interfaceArtifacts[0],
          content: "<p>tampered</p>",
        }],
      },
    },
    {
      name: "executable",
      prepared: {
        ...prepared,
        esmBundledCode: "export const run=()=>({ok:false});",
      },
    },
    {
      name: "compiler revision",
      qualification: {
        ...qualification,
        compiler_revision: "galactic-compiler/stale",
      },
    },
    {
      name: "runtime revision",
      qualification: {
        ...qualification,
        runtime_revision: "dynamic-worker/stale",
      },
    },
    {
      name: "policy revision",
      qualification: {
        ...qualification,
        policy_revision: "basic-conformance/stale",
      },
    },
  ];

  for (const mismatch of mismatches) {
    await assertRejects(
      () =>
        assertQualificationMatchesPreparedRelease({
          qualification: mismatch.qualification ?? qualification,
          prepared: mismatch.prepared ?? prepared,
        }),
      Error,
      undefined,
      mismatch.name,
    );
  }
});

Deno.test("qualification evidence: promotion requires every exact retained artifact and executable", async () => {
  const versionArtifacts = new Map(
    prepared.filesToUpload.map((file) => [file.name, file.content]),
  );
  const interfaceArtifacts = new Map(
    prepared.interfaceArtifacts.map((file) => [file.name, file.content]),
  );
  const bytes = (value: Uint8Array | string): Uint8Array =>
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const read = (
    values: Map<string, Uint8Array | string>,
    name: string,
  ): Promise<Uint8Array> => {
    const value = values.get(name);
    if (value === undefined) return Promise.reject(new Error("missing"));
    return Promise.resolve(bytes(value));
  };

  assertEquals(
    await assertQualifiedReleaseArtifactsRetained({
      prepared,
      readVersionArtifact: (name) => read(versionArtifacts, name),
      readInterfaceArtifact: (name) => read(interfaceArtifacts, name),
      retainedExecutable: prepared.esmBundledCode,
    }),
    prepared.esmBundledCode,
  );

  for (
    const mutation of [
      {
        name: "missing version artifact",
        version: new Map(
          [...versionArtifacts].filter(([name]) => name !== "manifest.json"),
        ),
        interfaces: interfaceArtifacts,
        executable: prepared.esmBundledCode,
      },
      {
        name: "tampered version artifact",
        version: new Map(versionArtifacts).set(
          "manifest.json",
          '{"name":"tampered"}',
        ),
        interfaces: interfaceArtifacts,
        executable: prepared.esmBundledCode,
      },
      {
        name: "tampered interface artifact",
        version: versionArtifacts,
        interfaces: new Map(interfaceArtifacts).set(
          prepared.interfaceArtifacts[0].name,
          "<p>tampered</p>",
        ),
        executable: prepared.esmBundledCode,
      },
      {
        name: "missing executable",
        version: versionArtifacts,
        interfaces: interfaceArtifacts,
        executable: null,
      },
      {
        name: "tampered executable",
        version: versionArtifacts,
        interfaces: interfaceArtifacts,
        executable: `${prepared.esmBundledCode}\n// tampered`,
      },
    ]
  ) {
    await assertRejects(
      () =>
        assertQualifiedReleaseArtifactsRetained({
          prepared,
          readVersionArtifact: (name) => read(mutation.version, name),
          readInterfaceArtifact: (name) => read(mutation.interfaces, name),
          retainedExecutable: mutation.executable,
        }),
      Error,
      undefined,
      mutation.name,
    );
  }
});

Deno.test("qualification evidence: a V2 payload mutation cannot retain the original signature", async () => {
  const identity = await computePreparedPipelineReleaseIdentity(prepared);
  const issued = await issueTestAttestation({
    userId: "owner-1",
    sourceHash: SOURCE_HASH,
    mode: "deno_execution",
    now: NOW,
    qualification: baseQualification(identity.release_digest),
  });
  assertEquals(issued.claims.schema_version, 2);
  if (issued.claims.schema_version !== 2) {
    throw new Error("Expected V2 qualification");
  }

  const [prefix, _encoded, signature] = issued.token.split(".");
  const tamperedClaims = structuredClone(issued.claims);
  tamperedClaims.qualification.functions.exercised = 2;
  const tampered = `${prefix}.${
    base64UrlEncode(JSON.stringify(tamperedClaims))
  }.${signature}`;

  assertEquals(
    await verifyTestAttestation({
      token: tampered,
      userId: "owner-1",
      sourceHash: SOURCE_HASH,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "bad_signature" },
  );
});

Deno.test("qualification evidence: V1 rejects qualification-shaped extra claims", async () => {
  const claims = {
    schema_version: 1,
    purpose: "gx.test",
    attestation_id: crypto.randomUUID(),
    user_id: "owner-1",
    source_hash: SOURCE_HASH,
    mode: "deno_execution",
    lint_error_count: 0,
    tested_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    qualification: baseQualification("e".repeat(64)),
  };
  const encoded = base64UrlEncode(JSON.stringify(claims));
  const signature = await signWithTrustSecret(`gx.test/v1.${encoded}`);

  assertEquals(
    await verifyTestAttestation({
      token: `gxt1.${encoded}.${signature}`,
      userId: "owner-1",
      sourceHash: SOURCE_HASH,
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "malformed" },
  );
});

Deno.test("qualification evidence: non-passing counts can never be issued or projected as passed", async () => {
  const identity = await computePreparedPipelineReleaseIdentity(prepared);
  const qualification = baseQualification(identity.release_digest);
  qualification.cases.required = 2;
  qualification.cases.passed = 1;

  await assertRejects(
    () =>
      issueTestAttestation({
        userId: "owner-1",
        sourceHash: SOURCE_HASH,
        mode: "deno_execution",
        now: NOW,
        qualification,
      }),
    Error,
    "Invalid gx.test qualification metadata",
  );

  const passing = baseQualification(identity.release_digest);
  const issued = await issueTestAttestation({
    userId: "owner-1",
    sourceHash: SOURCE_HASH,
    mode: "deno_execution",
    now: NOW,
    qualification: passing,
  });
  assertEquals(issued.claims.schema_version, 2);
  if (issued.claims.schema_version !== 2) {
    throw new Error("Expected V2 qualification");
  }
  const proof = persistedTestAttestation(issued.claims, NOW);
  assertEquals(proof.schema_version, 2);
  if (proof.schema_version !== 2) {
    throw new Error("Expected persisted V2 qualification");
  }
  proof.qualification.cases.required = 2;
  proof.qualification.cases.passed = 1;
  const metadata: VersionMetadata[] = [{
    version: "1.0.0",
    size_bytes: 1,
    created_at: NOW.toISOString(),
    source_hash: SOURCE_HASH,
    test_attestation: proof,
  }];

  assertEquals(findPersistedTestAttestation(metadata, "1.0.0"), null);
});

Deno.test("qualification evidence: replay is bounded to the same owner, source, mode, and lifetime", async () => {
  const identity = await computePreparedPipelineReleaseIdentity(prepared);
  const issued = await issueTestAttestation({
    userId: "owner-1",
    sourceHash: SOURCE_HASH,
    mode: "deno_execution",
    now: NOW,
    qualification: baseQualification(identity.release_digest),
  });

  const verify = () =>
    verifyTestAttestation({
      token: issued.token,
      userId: "owner-1",
      sourceHash: SOURCE_HASH,
      mode: "deno_execution" as const,
      now: NOW,
    });
  assert((await verify()).valid);
  assert((await verify()).valid);
  assertEquals(
    await verifyTestAttestation({
      token: issued.token,
      userId: "owner-1",
      sourceHash: "f".repeat(64),
      mode: "deno_execution",
      now: NOW,
    }),
    { valid: false, reason: "wrong_source" },
  );
});
