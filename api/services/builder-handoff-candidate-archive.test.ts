// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type { VersionTestQualificationMetadata } from "../../shared/types/index.ts";
import {
  type BuilderHandoffCandidateArchiveFile,
  type BuilderHandoffCandidateArchiveStore,
  persistBuilderHandoffCandidateArchive,
  type PersistBuilderHandoffCandidateArchiveInput,
} from "./builder-handoff-candidate-archive.ts";
import type { DecodedSourceFile } from "./test-attestation.ts";
import {
  canonicalJson,
  computeCanonicalUploadSourceHash,
  sha256Hex,
} from "./trust.ts";
import type { PipelineResult } from "./upload-pipeline.ts";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000002";
const CANDIDATE_SET_ID = "10000000-0000-4000-8000-000000000003";
const TARGET_AGENT_ID = "10000000-0000-4000-8000-000000000004";
const BUNDLE_ID = `gxb1_${"a".repeat(64)}`;
const ATTESTATION_DIGEST = "c".repeat(64);
const DOCUMENT_DIGEST = "d".repeat(64);
const RELEASE_DIGEST = "f".repeat(64);
const BASE_SOURCE_HASH = "6".repeat(64);
const BASE_RELEASE_DIGEST = "7".repeat(64);
const BASE_STATE_DIGEST = "8".repeat(64);
const CONFORMANCE_REPORT = {
  schema_version: 1,
  profile: "basic",
  cases: [{ id: "smoke", status: "passed" }],
  observed_effects: ["storage.read"],
};
const REPORT_DIGEST = await sha256Hex(canonicalJson(CONFORMANCE_REPORT));

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

class MemoryCandidateArchiveStore
  implements BuilderHandoffCandidateArchiveStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly writes: string[] = [];
  private tampered = false;

  constructor(private readonly tamperBlobReads = false) {}

  uploadFile(
    key: string,
    file: { content: Uint8Array },
  ): Promise<void> {
    this.writes.push(key);
    this.objects.set(key, new Uint8Array(file.content));
    return Promise.resolve();
  }

  fetchFile(key: string): Promise<Uint8Array> {
    const retained = this.objects.get(key);
    if (!retained) return Promise.reject(new Error(`missing ${key}`));
    const copy = new Uint8Array(retained);
    if (
      this.tamperBlobReads &&
      !this.tampered &&
      key.includes("/archive-blobs/")
    ) {
      this.tampered = true;
      copy[0] = (copy[0] ?? 0) ^ 0xff;
      // Let every sibling read-back verification settle before this one
      // rejects Promise.all, so the failure cannot leave detached digest work.
      return new Promise((resolve) => setTimeout(() => resolve(copy), 10));
    }
    return Promise.resolve(copy);
  }

  async fetchTextFile(key: string): Promise<string> {
    return new TextDecoder().decode(await this.fetchFile(key));
  }

  deleteFile(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}

function qualification(): VersionTestQualificationMetadata {
  return {
    profile: "basic",
    document_digest: DOCUMENT_DIGEST,
    release_digest: RELEASE_DIGEST,
    report_digest: REPORT_DIGEST,
    compiler_revision: "galactic-compiler/test",
    runtime_revision: "dynamic-worker/test",
    policy_revision: "basic-conformance/test",
    cases: {
      declared: 2,
      required: 1,
      passed: 1,
      optional_failed: 1,
    },
    functions: { declared: 2, exercised: 1 },
    effects: { declared: 1, exercised: 1, untested: 0 },
  };
}

function sourceFiles(): DecodedSourceFile[] {
  return [
    {
      path: "index.ts",
      content: "export const run = () => ({ ok: true });\n",
    },
    {
      path: "galactic.yaml",
      content: "apiVersion: agents.connectgalactic.com/v1alpha1\nkind: Agent\n",
    },
    {
      path: "module.wasm",
      content: "",
      bytes: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff]),
    },
  ];
}

const SOURCE_HASH = await computeCanonicalUploadSourceHash(sourceFiles());

function pipeline(): PipelineResult {
  const manifest: NonNullable<PipelineResult["manifest"]> = {
    name: "Archived Agent",
    version: "1.2.3",
    description: "Exact candidate archive fixture",
    type: "mcp",
    entry: { functions: "index.ts" },
  };
  return {
    runtime: "deno",
    manifest,
    agentDocument: {
      sourceKind: "galactic_yaml",
      compiledManifest: manifest,
      document: {
        apiVersion: "agents.connectgalactic.com/v1alpha1",
        kind: "Agent",
        metadata: { name: "Archived Agent", version: "1.2.3" },
        spec: {
          functions: {},
          conformance: { profile: "basic", cases: [] },
        },
      },
      normalizedJson: '{"kind":"Agent"}',
      documentDigest: DOCUMENT_DIGEST,
      cases: [],
      functions: ["run", "status"],
      effects: [],
      effectsByFunction: { run: [], status: [] },
    },
    entryFile: {
      name: "index.ts",
      content: "export const run = () => ({ ok: true });\n",
    },
    exports: ["status", "run"],
    bundledCode: "const bundled = true;\n",
    esmBundledCode:
      'export const run=()=>({ok:true});export const status=()=>"ready";\n',
    bundleUsed: true,
    safetyPassed: true,
    safetyWarnings: 0,
    migrations: [],
    hasMigrations: false,
    filesToUpload: [
      {
        name: "manifest.json",
        content: bytes('{"name":"Archived Agent","version":"1.2.3"}'),
        contentType: "application/json",
      },
      {
        name: "compiled.js",
        content: new Uint8Array([
          0x63,
          0x6f,
          0x6d,
          0x70,
          0x69,
          0x6c,
          0x65,
          0x64,
        ]),
        contentType: "application/javascript",
      },
    ],
    interfaceArtifacts: [
      {
        name: `${"1".repeat(64)}.html`,
        content: bytes("<main>Exact owner interface</main>"),
        contentType: "text/html",
      },
    ],
    normalizedEntryName: "index.ts",
    buildLogs: [],
  };
}

function archiveInput(
  overrides: Partial<PersistBuilderHandoffCandidateArchiveInput> = {},
): PersistBuilderHandoffCandidateArchiveInput {
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
    sourceHash: SOURCE_HASH,
    attestationId: "attestation-1",
    attestationDigest: ATTESTATION_DIGEST,
    qualification: qualification(),
    conformanceReport: CONFORMANCE_REPORT,
    sourceFiles: sourceFiles(),
    pipeline: pipeline(),
    version: "1.2.3",
    ...overrides,
  };
}

function blobKey(
  archiveKey: string,
  file: BuilderHandoffCandidateArchiveFile,
): string {
  const archiveMarker = "archives/";
  const archiveMarkerIndex = archiveKey.indexOf(archiveMarker);
  const prefix = archiveKey.slice(0, archiveMarkerIndex);
  const archiveDigest = archiveKey.slice(
    archiveMarkerIndex + archiveMarker.length,
    -".json".length,
  );
  return `${prefix}archive-blobs/${archiveDigest}/${file.sha256}`;
}

async function assertRetainedBytes(
  store: MemoryCandidateArchiveStore,
  archiveKey: string,
  descriptor: BuilderHandoffCandidateArchiveFile,
  expected: Uint8Array,
): Promise<void> {
  assertEquals(
    await store.fetchFile(blobKey(archiveKey, descriptor)),
    expected,
    descriptor.path,
  );
}

Deno.test("builder handoff candidate archive: digest and storage identities are deterministic and idempotent", async () => {
  const firstStore = new MemoryCandidateArchiveStore();
  const firstInput = archiveInput();
  const first = await persistBuilderHandoffCandidateArchive(
    firstStore,
    firstInput,
  );

  const reorderedInput = archiveInput();
  reorderedInput.sourceFiles.reverse();
  reorderedInput.pipeline.filesToUpload.reverse();
  reorderedInput.pipeline.interfaceArtifacts.reverse();
  reorderedInput.pipeline.exports.reverse();
  const secondStore = new MemoryCandidateArchiveStore();
  const second = await persistBuilderHandoffCandidateArchive(
    secondStore,
    reorderedInput,
  );

  assertEquals(second.archiveDigest, first.archiveDigest);
  assertEquals(second.archiveKey, first.archiveKey);
  assertEquals(second.pointerKey, first.pointerKey);
  assertEquals(
    [...secondStore.objects.keys()].sort(),
    [...firstStore.objects.keys()].sort(),
  );

  const keyCount = firstStore.objects.size;
  const repeated = await persistBuilderHandoffCandidateArchive(
    firstStore,
    archiveInput(),
  );
  assertEquals(repeated.archiveDigest, first.archiveDigest);
  assertEquals(repeated.archiveKey, first.archiveKey);
  assertEquals(repeated.pointerKey, first.pointerKey);
  assertEquals(firstStore.objects.size, keyCount);
});

Deno.test("builder handoff candidate archive: exact source, compiled, interface, and executable bytes survive read-back", async () => {
  const store = new MemoryCandidateArchiveStore();
  const input = archiveInput();
  const receipt = await persistBuilderHandoffCandidateArchive(store, input);
  assertEquals(receipt.manifest.change_scope, "full_release");
  assertEquals(receipt.manifest.base_lineage, null);

  for (const descriptor of receipt.manifest.source_files) {
    const source = input.sourceFiles.find((file) =>
      file.path === descriptor.path
    );
    assert(source);
    await assertRetainedBytes(
      store,
      receipt.archiveKey,
      descriptor,
      source.bytes ?? bytes(source.content),
    );
  }
  for (const descriptor of receipt.manifest.release_artifacts) {
    const artifact = input.pipeline.filesToUpload.find((file) =>
      file.name === descriptor.path
    );
    assert(artifact);
    await assertRetainedBytes(
      store,
      receipt.archiveKey,
      descriptor,
      artifact.content,
    );
  }
  for (const descriptor of receipt.manifest.interface_artifacts) {
    const artifact = input.pipeline.interfaceArtifacts.find((file) =>
      file.name === descriptor.path
    );
    assert(artifact);
    await assertRetainedBytes(
      store,
      receipt.archiveKey,
      descriptor,
      artifact.content,
    );
  }
  await assertRetainedBytes(
    store,
    receipt.archiveKey,
    receipt.manifest.executable,
    bytes(input.pipeline.esmBundledCode!),
  );

  const retainedManifest = JSON.parse(
    await store.fetchTextFile(receipt.archiveKey),
  );
  assertEquals(retainedManifest.source_hash, SOURCE_HASH);
  assertEquals(retainedManifest.compiled_manifest, input.pipeline.manifest);
  assertEquals(
    retainedManifest.agent_document,
    input.pipeline.agentDocument?.document,
  );
  assertEquals(
    JSON.parse(await store.fetchTextFile(receipt.pointerKey)),
    {
      schema_version: 1,
      archive_digest: receipt.archiveDigest,
      release_digest: RELEASE_DIGEST,
    },
  );
});

Deno.test("builder handoff candidate archive: tampered read-back fails before manifest or receipt publication", async () => {
  const store = new MemoryCandidateArchiveStore(true);
  await assertRejects(
    () => persistBuilderHandoffCandidateArchive(store, archiveInput()),
    Error,
    "bytes changed during retention",
  );
  assertEquals(
    [...store.objects.keys()].some((key) => key.includes("/archives/")),
    false,
  );
  assertEquals(
    [...store.objects.keys()].some((key) => key.endsWith("/submitted.json")),
    false,
  );
});

Deno.test("builder handoff candidate archive: identity collisions and invalid digests fail before storage", async () => {
  const base = archiveInput();
  const invalidInputs = [
    archiveInput({ candidateSetId: base.sessionId }),
    archiveInput({ targetAgentId: base.sessionId }),
    archiveInput({ targetAgentId: base.candidateSetId }),
    archiveInput({ sourceHash: "A".repeat(64) }),
    archiveInput({ sourceHash: "0".repeat(64) }),
    archiveInput({ attestationDigest: "not-a-digest" }),
    archiveInput({ baseVersion: "1.2.2" }),
    archiveInput({
      qualification: {
        ...base.qualification,
        document_digest: "short",
      },
    }),
  ];

  for (const input of invalidInputs) {
    const store = new MemoryCandidateArchiveStore();
    await assertRejects(
      () => persistBuilderHandoffCandidateArchive(store, input),
      Error,
    );
    assertEquals(store.writes, []);
  }
});

Deno.test("builder handoff candidate archive: extension intent and exact target identity are preserved", async () => {
  const store = new MemoryCandidateArchiveStore();
  const receipt = await persistBuilderHandoffCandidateArchive(
    store,
    archiveInput({
      intent: "interface",
      baseVersion: "1.2.2",
      baseSourceHash: BASE_SOURCE_HASH,
      baseReleaseDigest: BASE_RELEASE_DIGEST,
      baseStateDigest: BASE_STATE_DIGEST,
    }),
  );
  assertEquals(receipt.manifest.intent, "interface");
  assertEquals(receipt.manifest.change_scope, "full_release");
  assertEquals(receipt.manifest.base_lineage, {
    version: "1.2.2",
    source_hash: BASE_SOURCE_HASH,
    release_digest: BASE_RELEASE_DIGEST,
    state_digest: BASE_STATE_DIGEST,
  });
  assertEquals(receipt.manifest.target_agent_id, TARGET_AGENT_ID);
  assertEquals(receipt.manifest.session_id, SESSION_ID);
  assertEquals(receipt.manifest.candidate_set_id, CANDIDATE_SET_ID);
});

Deno.test("builder handoff candidate archive: exact-retest attempts have disjoint cleanup identities", async () => {
  const store = new MemoryCandidateArchiveStore();
  const olderAttempt = await persistBuilderHandoffCandidateArchive(
    store,
    archiveInput(),
  );
  const newerAttempt = await persistBuilderHandoffCandidateArchive(
    store,
    archiveInput({
      attestationId: "attestation-2",
      attestationDigest: "e".repeat(64),
    }),
  );

  assert(olderAttempt.archiveDigest !== newerAttempt.archiveDigest);
  assertEquals(
    olderAttempt.objectKeys.filter((key) =>
      newerAttempt.objectKeys.includes(key)
    ),
    [],
  );

  await Promise.all(
    olderAttempt.objectKeys.map((key) => store.deleteFile(key)),
  );

  for (const key of newerAttempt.objectKeys) {
    assert(store.objects.has(key), `newer archive lost ${key}`);
  }
  assertEquals(
    JSON.parse(await store.fetchTextFile(newerAttempt.pointerKey)),
    {
      schema_version: 1,
      archive_digest: newerAttempt.archiveDigest,
      release_digest: RELEASE_DIGEST,
    },
  );
});
