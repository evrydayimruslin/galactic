// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type {
  VersionTestAttestationMetadataV2,
  VersionTestQualificationMetadata,
} from "../../shared/types/index.ts";
import {
  type BuilderHandoffCandidateArchiveExpectedBinding,
  builderHandoffCandidateArchiveKey,
  type BuilderHandoffCandidateArchiveStore,
  loadBuilderHandoffCandidateDeploymentSnapshot,
  loadVerifiedBuilderHandoffCandidateArchiveManifest,
  persistBuilderHandoffCandidateArchive,
  type PersistBuilderHandoffCandidateArchiveInput,
} from "./builder-handoff-candidate-archive.ts";
import { evaluateGalacticBasicConformance } from "./galactic-basic-conformance.ts";
import {
  GALACTIC_BASIC_POLICY_REVISION,
  GALACTIC_COMPILER_REVISION,
  GALACTIC_RUNTIME_CONTRACT_REVISION,
} from "./galactic-release-identity.ts";
import { computePreparedPipelineReleaseIdentity } from "./galactic-qualified-release.ts";
import type { FileUpload } from "./storage.ts";
import type { DecodedSourceFile } from "./test-attestation.ts";
import {
  canonicalJson,
  computeCanonicalUploadSourceHash,
  sha256Hex,
} from "./trust.ts";
import {
  type PipelineResult,
  processUploadPipeline,
} from "./upload-pipeline.ts";

const OWNER_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "20000000-0000-4000-8000-000000000002";
const CANDIDATE_SET_ID = "20000000-0000-4000-8000-000000000003";
const TARGET_AGENT_ID = "20000000-0000-4000-8000-000000000004";
const ATTESTATION_ID = "20000000-0000-4000-8000-000000000005";
const ATTESTATION_DIGEST = "c".repeat(64);
const BUNDLE_ID = `gxb1_${"a".repeat(64)}`;

const GALACTIC_YAML = `apiVersion: agents.connectgalactic.com/v1alpha1
kind: Agent
metadata:
  name: Inbox Reader
  version: 1.2.3
  description: Reads a fixture inbox without external side effects.
spec:
  entry:
    functions: index.ts
  functions:
    run:
      description: Return the number of fixture messages.
      authority:
        level: read
        effects: {}
  network:
    allowed_destinations:
      - host: gmail.googleapis.com
        label: Gmail API
        description: Reads inbox metadata after setup.
  env_vars:
    GMAIL_ACCESS_TOKEN:
      description: OAuth access token for the owner's Gmail account.
      required: true
      scope: per_user
      input: password
      credential:
        destination: gmail.googleapis.com
        inject:
          as: bearer
  routines:
    - id: inbox-check
      label: Check inbox
      description: Checks the inbox after the owner activates it.
      handler: run
      default_schedule:
        type: interval
        every_minutes: 30
  conformance:
    profile: basic
    cases:
      - id: reads-fixture
        function: run
        input: {}
`;

class MemoryCandidateArchiveStore
  implements BuilderHandoffCandidateArchiveStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];

  uploadFile(key: string, file: FileUpload): Promise<void> {
    this.objects.set(key, new Uint8Array(file.content));
    return Promise.resolve();
  }

  fetchFile(key: string): Promise<Uint8Array> {
    this.reads.push(key);
    const value = this.objects.get(key);
    if (!value) return Promise.reject(new Error(`missing ${key}`));
    return Promise.resolve(new Uint8Array(value));
  }

  async fetchTextFile(key: string): Promise<string> {
    return new TextDecoder().decode(await this.fetchFile(key));
  }

  deleteFile(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

interface QualifiedFixture {
  input: PersistBuilderHandoffCandidateArchiveInput;
  pipeline: PipelineResult;
  sourceFiles: DecodedSourceFile[];
  testAttestation: VersionTestAttestationMetadataV2;
}

async function qualifiedFixture(
  options: { includeTestAttestation?: boolean } = {},
): Promise<QualifiedFixture> {
  const sourceFiles: DecodedSourceFile[] = [
    {
      path: "index.ts",
      content:
        "export async function run() { return { fixture_messages: 2 }; }\n",
    },
    { path: "galactic.yaml", content: GALACTIC_YAML },
  ];
  const sourceHash = await computeCanonicalUploadSourceHash(sourceFiles);
  const pipeline = await processUploadPipeline(
    sourceFiles.map((file) => ({
      name: file.path,
      content: file.content,
    })),
    { strictBuild: true },
  );
  assert(pipeline.agentDocument?.document);
  assert(pipeline.esmBundledCode);
  const identity = await computePreparedPipelineReleaseIdentity({
    sourceHash,
    documentDigest: pipeline.agentDocument.documentDigest,
    filesToUpload: pipeline.filesToUpload,
    interfaceArtifacts: pipeline.interfaceArtifacts,
    esmBundledCode: pipeline.esmBundledCode,
  });
  const report = evaluateGalacticBasicConformance({
    releaseDigest: identity.release_digest,
    functions: pipeline.agentDocument.functions,
    effectsByFunction: pipeline.agentDocument.effectsByFunction,
    cases: pipeline.agentDocument.cases,
    observations: pipeline.agentDocument.cases.map((testCase) => ({
      id: testCase.id,
      function: testCase.function,
      required: testCase.required,
      invoked: true,
      success: true,
      observedEffects: [],
    })),
  });
  const reportDigest = await sha256Hex(canonicalJson(report));
  const qualification: VersionTestQualificationMetadata = {
    profile: "basic",
    document_digest: pipeline.agentDocument.documentDigest,
    release_digest: identity.release_digest,
    report_digest: reportDigest,
    compiler_revision: GALACTIC_COMPILER_REVISION,
    runtime_revision: GALACTIC_RUNTIME_CONTRACT_REVISION,
    policy_revision: GALACTIC_BASIC_POLICY_REVISION,
    cases: { ...report.coverage.cases },
    functions: {
      declared: report.coverage.functions.declared,
      exercised: report.coverage.functions.exercised,
    },
    effects: {
      declared: report.coverage.effects.declared,
      exercised: report.coverage.effects.exercised,
      untested: report.coverage.effects.untested,
    },
  };
  const testAttestation: VersionTestAttestationMetadataV2 = {
    schema_version: 2,
    attestation_id: ATTESTATION_ID,
    mode: "deno_execution",
    source_hash: sourceHash,
    tested_at: "2026-07-30T20:00:00.000Z",
    token_expires_at: "2026-07-30T21:00:00.000Z",
    verified_at: "2026-07-30T20:01:00.000Z",
    qualification,
  };
  return {
    sourceFiles,
    pipeline,
    testAttestation,
    input: {
      ownerId: OWNER_ID,
      sessionId: SESSION_ID,
      candidateSetId: CANDIDATE_SET_ID,
      targetAgentId: TARGET_AGENT_ID,
      intent: "agent",
      baseVersion: null,
      baseSourceHash: null,
      baseReleaseDigest: null,
      baseStateDigest: null,
      bundleId: BUNDLE_ID,
      sourceHash,
      attestationId: ATTESTATION_ID,
      attestationDigest: ATTESTATION_DIGEST,
      qualification,
      ...(options.includeTestAttestation === false ? {} : { testAttestation }),
      conformanceReport: report,
      sourceFiles,
      pipeline,
      version: "1.2.3",
    },
  };
}

function expectedBinding(
  fixture: QualifiedFixture,
  receipt: Awaited<ReturnType<typeof persistBuilderHandoffCandidateArchive>>,
): BuilderHandoffCandidateArchiveExpectedBinding {
  return {
    ownerId: OWNER_ID,
    sessionId: SESSION_ID,
    candidateSetId: CANDIDATE_SET_ID,
    targetAgentId: TARGET_AGENT_ID,
    intent: "agent",
    baseVersion: null,
    baseSourceHash: null,
    baseReleaseDigest: null,
    baseStateDigest: null,
    bundleId: BUNDLE_ID,
    sourceHash: fixture.input.sourceHash,
    attestationId: ATTESTATION_ID,
    attestationDigest: ATTESTATION_DIGEST,
    documentDigest: fixture.input.qualification.document_digest,
    reportDigest: fixture.input.qualification.report_digest,
    releaseDigest: fixture.input.qualification.release_digest,
    archiveDigest: receipt.archiveDigest,
    archiveByteCount: receipt.archiveByteCount,
    archiveObjectCount: receipt.archiveObjectCount,
    version: fixture.input.version,
  };
}

function archiveBlobKeys(
  store: MemoryCandidateArchiveStore,
  archiveDigest: string,
): string[] {
  return [...store.objects.keys()].filter((key) =>
    key.includes(`/archive-blobs/${archiveDigest}/`)
  );
}

async function rebindMutatedManifest(
  store: MemoryCandidateArchiveStore,
  binding: BuilderHandoffCandidateArchiveExpectedBinding,
  mutate: (manifest: Record<string, unknown>) => void,
  copyBlobs: boolean,
): Promise<BuilderHandoffCandidateArchiveExpectedBinding> {
  const oldKey = builderHandoffCandidateArchiveKey({
    ownerId: binding.ownerId,
    sessionId: binding.sessionId,
    archiveDigest: binding.archiveDigest,
  });
  const oldBytes = store.objects.get(oldKey)!;
  const manifest = JSON.parse(
    new TextDecoder().decode(oldBytes),
  ) as Record<string, unknown>;
  mutate(manifest);
  const json = canonicalJson(manifest);
  const archiveDigest = await sha256Hex(json);
  const newKey = builderHandoffCandidateArchiveKey({
    ownerId: binding.ownerId,
    sessionId: binding.sessionId,
    archiveDigest,
  });
  const newBytes = new TextEncoder().encode(json);
  store.objects.set(newKey, newBytes);
  if (copyBlobs) {
    for (const oldBlobKey of archiveBlobKeys(store, binding.archiveDigest)) {
      const newBlobKey = oldBlobKey.replace(
        `/archive-blobs/${binding.archiveDigest}/`,
        `/archive-blobs/${archiveDigest}/`,
      );
      store.objects.set(
        newBlobKey,
        new Uint8Array(store.objects.get(oldBlobKey)!),
      );
    }
  }
  return {
    ...binding,
    archiveDigest,
    archiveByteCount: binding.archiveByteCount +
      newBytes.byteLength - oldBytes.byteLength,
  };
}

Deno.test({
  name:
    "candidate archive loader: DB-bound manifest returns a safe invitation projection without reading the pointer",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = new MemoryCandidateArchiveStore();
    const fixture = await qualifiedFixture();
    const receipt = await persistBuilderHandoffCandidateArchive(
      store,
      fixture.input,
    );
    store.objects.set(
      receipt.pointerKey,
      new TextEncoder().encode(
        '{"archive_digest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}',
      ),
    );
    store.reads.length = 0;

    const summary = await loadVerifiedBuilderHandoffCandidateArchiveManifest(
      store,
      expectedBinding(fixture, receipt),
    );

    assertEquals(summary.deploymentReady, true);
    assertEquals(summary.release.name, "Inbox Reader");
    assertEquals(summary.release.functions, [{
      name: "run",
      description: "Return the number of fixture messages.",
      authorityLevel: "read",
      effects: [],
      spend: [],
    }]);
    assertEquals(summary.release.routines, [{
      id: "inbox-check",
      label: "Check inbox",
      description: "Checks the inbox after the owner activates it.",
      handler: "run",
      hasDefaultSchedule: true,
    }]);
    assertEquals(summary.release.settings, [{
      key: "GMAIL_ACCESS_TOKEN",
      label: "Gmail Access Token",
      description: "OAuth access token for the owner's Gmail account.",
      required: true,
      secret: true,
      scope: "per_user",
      destination: "gmail.googleapis.com",
    }]);
    assertEquals(
      store.reads.some((key) => key.endsWith("/submitted.json")),
      false,
    );
    assertEquals(store.reads, [receipt.archiveKey]);
    assertEquals(
      JSON.stringify(summary).includes("compiled_manifest"),
      false,
    );
    assertEquals(JSON.stringify(summary).includes("conformance_report"), false);
  },
});

Deno.test({
  name:
    "candidate archive loader: strict deployment reproduces exact source, release artifacts, executable, and V2 evidence",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = new MemoryCandidateArchiveStore();
    const fixture = await qualifiedFixture();
    const receipt = await persistBuilderHandoffCandidateArchive(
      store,
      fixture.input,
    );
    store.reads.length = 0;

    const snapshot = await loadBuilderHandoffCandidateDeploymentSnapshot(
      store,
      expectedBinding(fixture, receipt),
    );

    assertEquals(
      canonicalJson(snapshot.manifest),
      canonicalJson(fixture.pipeline.manifest),
    );
    assertEquals(snapshot.exports, ["run"]);
    assertEquals(
      snapshot.sourceFiles,
      [...fixture.sourceFiles].sort((left, right) =>
        left.path.localeCompare(right.path)
      ),
    );
    assertEquals(
      snapshot.releaseArtifacts.map((file) => file.name),
      fixture.pipeline.filesToUpload.map((file) => file.name).sort(),
    );
    assertEquals(
      snapshot.executable.code,
      fixture.pipeline.esmBundledCode,
    );
    assertEquals(snapshot.testAttestation, fixture.testAttestation);
    assertEquals(
      store.reads.some((key) => key.endsWith("/submitted.json")),
      false,
    );
  },
});

Deno.test({
  name:
    "candidate archive loader: pre-M7 archive remains projectable but cannot deploy without compact V2 evidence",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = new MemoryCandidateArchiveStore();
    const fixture = await qualifiedFixture({ includeTestAttestation: false });
    const receipt = await persistBuilderHandoffCandidateArchive(
      store,
      fixture.input,
    );
    const binding = expectedBinding(fixture, receipt);

    assertEquals(
      (await loadVerifiedBuilderHandoffCandidateArchiveManifest(store, binding))
        .deploymentReady,
      false,
    );
    await assertRejects(
      () => loadBuilderHandoffCandidateDeploymentSnapshot(store, binding),
      Error,
      "lacks a current durable V2 qualification",
    );
  },
});

Deno.test({
  name:
    "candidate archive loader: wrong session binding and non-canonical descriptor paths fail closed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = new MemoryCandidateArchiveStore();
    const fixture = await qualifiedFixture();
    const receipt = await persistBuilderHandoffCandidateArchive(
      store,
      fixture.input,
    );
    const binding = expectedBinding(fixture, receipt);

    await assertRejects(
      () =>
        loadVerifiedBuilderHandoffCandidateArchiveManifest(store, {
          ...binding,
          candidateSetId: "20000000-0000-4000-8000-000000000099",
        }),
      Error,
      "does not match its database-bound session",
    );

    const rebound = await rebindMutatedManifest(
      store,
      binding,
      (manifest) => {
        const sourceFiles = manifest.source_files as Array<
          Record<string, unknown>
        >;
        sourceFiles[0].path = "../index.ts";
      },
      false,
    );
    await assertRejects(
      () => loadVerifiedBuilderHandoffCandidateArchiveManifest(store, rebound),
      Error,
      "descriptor path is invalid",
    );

    const duplicatePath = await rebindMutatedManifest(
      store,
      binding,
      (manifest) => {
        const sourceFiles = manifest.source_files as Array<
          Record<string, unknown>
        >;
        sourceFiles[1].path = sourceFiles[0].path;
      },
      false,
    );
    await assertRejects(
      () =>
        loadVerifiedBuilderHandoffCandidateArchiveManifest(
          store,
          duplicatePath,
        ),
      Error,
      "descriptor paths are not unique",
    );
  },
});

Deno.test({
  name:
    "candidate archive loader: corrupt or missing content-addressed blobs fail before deployment",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fixture = await qualifiedFixture();

    for (const mode of ["corrupt", "missing"] as const) {
      const store = new MemoryCandidateArchiveStore();
      const receipt = await persistBuilderHandoffCandidateArchive(
        store,
        fixture.input,
      );
      const blobKey = archiveBlobKeys(store, receipt.archiveDigest)[0];
      if (mode === "missing") {
        store.objects.delete(blobKey);
      } else {
        const corrupt = new Uint8Array(store.objects.get(blobKey)!);
        corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
        store.objects.set(blobKey, corrupt);
      }
      await assertRejects(
        () =>
          loadBuilderHandoffCandidateDeploymentSnapshot(
            store,
            expectedBinding(fixture, receipt),
          ),
        Error,
        mode === "missing" ? "blob is missing" : "blob failed verification",
      );
    }
  },
});

Deno.test({
  name:
    "candidate archive loader: a digest-bound but source-divergent compiled manifest is rejected by strict recompilation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const store = new MemoryCandidateArchiveStore();
    const fixture = await qualifiedFixture();
    const receipt = await persistBuilderHandoffCandidateArchive(
      store,
      fixture.input,
    );
    const rebound = await rebindMutatedManifest(
      store,
      expectedBinding(fixture, receipt),
      (manifest) => {
        manifest.description = "A storage-tampered description.";
        const compiled = manifest.compiled_manifest as Record<string, unknown>;
        compiled.description = "A storage-tampered description.";
      },
      true,
    );

    assertEquals(
      (await loadVerifiedBuilderHandoffCandidateArchiveManifest(store, rebound))
        .release.description,
      "A storage-tampered description.",
    );
    await assertRejects(
      () => loadBuilderHandoffCandidateDeploymentSnapshot(store, rebound),
      Error,
      "compiled manifest differs from the exact source",
    );
  },
});
