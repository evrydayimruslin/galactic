// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type { AppManifest } from "../../shared/contracts/manifest.ts";
import type {
  VersionTestAttestationMetadataV2,
  VersionTestQualificationMetadata,
} from "../../shared/types/index.ts";
import type {
  BuilderHandoffCandidateArchiveStore,
  BuilderHandoffCandidateDeploymentSnapshot,
  BuilderHandoffVerifiedCandidateArchiveManifest,
} from "./builder-handoff-candidate-archive.ts";
import {
  BuilderHandoffDeploymentError,
  type BuilderHandoffDeploymentServiceOptions,
  deployBuilderHandoffCandidate,
  getBuilderHandoffCandidateInvitation,
  listBuilderHandoffCandidateInvitations,
} from "./builder-handoff-deployments.ts";
import type { BuilderHandoffSessionRecord } from "./builder-handoff-sessions.ts";
import { putReleaseExecutedBundle } from "./executed-bundle.ts";
import { type FileUpload, StorageObjectNotFoundError } from "./storage.ts";
import { sha256Hex } from "./trust.ts";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000002";
const SESSION_TWO_ID = "10000000-0000-4000-8000-000000000003";
const SESSION_THREE_ID = "10000000-0000-4000-8000-00000000000a";
const CANDIDATE_SET_ID = "10000000-0000-4000-8000-000000000004";
const RESERVED_AGENT_ID = "10000000-0000-4000-8000-000000000005";
const EXISTING_AGENT_ID = "10000000-0000-4000-8000-000000000006";
const RECOVERY_AGENT_ID = "10000000-0000-4000-8000-00000000000b";
const DEPLOYMENT_ID = "10000000-0000-4000-8000-000000000007";
const DEPLOYMENT_TWO_ID = "10000000-0000-4000-8000-00000000000c";
const INITIAL_LEASE_ID = "10000000-0000-4000-8000-000000000008";
const RECONCILED_LEASE_ID = "10000000-0000-4000-8000-000000000009";
const CREATED_AT = "2026-07-30T18:00:00.000Z";
const EXPIRES_AT = "2026-07-30T19:00:00.000Z";
const BUNDLE_ID = `gxb1_${"b".repeat(64)}`;
const SOURCE_HASH = "1".repeat(64);
const ATTESTATION_DIGEST = "2".repeat(64);
const DOCUMENT_DIGEST = "3".repeat(64);
const REPORT_DIGEST = "4".repeat(64);
const RELEASE_DIGEST = "5".repeat(64);
const ARCHIVE_DIGEST = "6".repeat(64);
const BASE_SOURCE_HASH = "7".repeat(64);
const BASE_RELEASE_DIGEST = "8".repeat(64);
const BASE_STATE_DIGEST = "9".repeat(64);
const VERSION = "1.2.3";
const SERVICE_URL = "https://db.example.test";
const SERVICE_KEY = "service-role-test-key";

const encoder = new TextEncoder();

const QUALIFICATION: VersionTestQualificationMetadata = {
  profile: "basic",
  document_digest: DOCUMENT_DIGEST,
  release_digest: RELEASE_DIGEST,
  report_digest: REPORT_DIGEST,
  compiler_revision: "compiler-test",
  runtime_revision: "runtime-test",
  policy_revision: "policy-test",
  cases: {
    declared: 1,
    required: 1,
    passed: 1,
    optional_failed: 0,
  },
  functions: { declared: 1, exercised: 1 },
  effects: { declared: 1, exercised: 1, untested: 0 },
};

const TEST_ATTESTATION: VersionTestAttestationMetadataV2 = {
  schema_version: 2,
  attestation_id: "attestation-test",
  mode: "deno_execution",
  source_hash: SOURCE_HASH,
  tested_at: CREATED_AT,
  token_expires_at: EXPIRES_AT,
  verified_at: CREATED_AT,
  qualification: QUALIFICATION,
};

type SessionWithReleaseGeneration = BuilderHandoffSessionRecord & {
  baseReleaseGeneration?: number | null;
};

function uploadedSession(input: {
  id?: string;
  intent?: "agent" | "interface" | "function" | "routine";
  targetAppId?: string;
  baseReleaseGeneration?: number | null;
  status?: "uploaded" | "promoted";
  promotedAt?: string;
} = {}): SessionWithReleaseGeneration {
  const intent = input.intent ?? "agent";
  const extension = intent !== "agent";
  const status = input.status ?? "uploaded";
  return {
    id: input.id ?? SESSION_ID,
    tokenId: input.id ?? SESSION_ID,
    ownerId: OWNER_ID,
    candidateSetId: CANDIDATE_SET_ID,
    intent,
    targetAppId: input.targetAppId ??
      (extension ? EXISTING_AGENT_ID : RESERVED_AGENT_ID),
    baseVersion: extension ? "1.0.0" : null,
    baseSourceHash: extension ? BASE_SOURCE_HASH : null,
    baseReleaseDigest: extension ? BASE_RELEASE_DIGEST : null,
    baseStateDigest: extension ? BASE_STATE_DIGEST : null,
    baseReleaseGeneration: extension
      ? (input.baseReleaseGeneration === undefined
        ? 3
        : input.baseReleaseGeneration)
      : null,
    status,
    statusVersion: status === "promoted" ? 5 : 4,
    lineageRevision: 1,
    descriptionSha256: "a".repeat(64),
    bundleId: BUNDLE_ID,
    sourceHash: SOURCE_HASH,
    attestationId: TEST_ATTESTATION.attestation_id,
    attestationDigest: ATTESTATION_DIGEST,
    documentDigest: DOCUMENT_DIGEST,
    reportDigest: REPORT_DIGEST,
    releaseDigest: RELEASE_DIGEST,
    candidateArchiveDigest: ARCHIVE_DIGEST,
    candidateArchiveBytes: 4_096,
    candidateArchiveObjects: 5,
    uploadedAppId: input.targetAppId ??
      (extension ? EXISTING_AGENT_ID : RESERVED_AGENT_ID),
    uploadedVersion: VERSION,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    updatedAt: CREATED_AT,
    connectedAt: CREATED_AT,
    stagedAt: CREATED_AT,
    testedAt: CREATED_AT,
    uploadedAt: CREATED_AT,
    promotedAt: status === "promoted" ? (input.promotedAt ?? CREATED_AT) : null,
    credentialRevokedAt: CREATED_AT,
    terminalAt: null,
  };
}

function verifiedSummary(
  session: SessionWithReleaseGeneration,
): BuilderHandoffVerifiedCandidateArchiveManifest {
  const intent = session.intent as
    | "agent"
    | "interface"
    | "function"
    | "routine";
  return {
    archive: {
      digest: ARCHIVE_DIGEST,
      byteCount: 4_096,
      objectCount: 5,
    },
    candidate: {
      candidateSetId: CANDIDATE_SET_ID,
      targetAgentId: session.targetAppId!,
      intent,
      changeScope: "full_release",
      baseLineage: intent === "agent" ? null : {
        version: session.baseVersion!,
        source_hash: session.baseSourceHash,
        release_digest: session.baseReleaseDigest,
        state_digest: session.baseStateDigest!,
      },
    },
    release: {
      version: VERSION,
      name: "Inbox Steward",
      description: "Triages an inbox without sending mail.",
      functions: [{
        name: "triage",
        description: "Classify and label one message.",
        authorityLevel: "external_write",
        effects: [{
          id: "gmail.labels.modify",
          policy: "ask",
        }],
        spend: [],
      }],
      interfaces: [],
      routines: [],
      settings: [{
        key: "GMAIL_TOKEN",
        label: "Gmail",
        description: "OAuth token used after setup.",
        required: true,
        secret: true,
        scope: "agent",
        destination: "gmail.googleapis.com",
      }],
      network: [{
        host: "gmail.googleapis.com",
        label: "Gmail",
        description: "Read and label messages.",
      }],
      compute: null,
      permissions: ["net:fetch"],
    },
    evidence: {
      bundleId: BUNDLE_ID,
      sourceHash: SOURCE_HASH,
      attestationId: TEST_ATTESTATION.attestation_id,
      attestationDigest: ATTESTATION_DIGEST,
      documentDigest: DOCUMENT_DIGEST,
      reportDigest: REPORT_DIGEST,
      releaseDigest: RELEASE_DIGEST,
      qualification: QUALIFICATION,
    },
    deploymentReady: true,
  };
}

class MemoryDeploymentStore implements BuilderHandoffCandidateArchiveStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly writes: string[] = [];

  constructor(private readonly retainUploads = true) {}

  uploadFile(key: string, file: FileUpload): Promise<void> {
    this.writes.push(key);
    if (this.retainUploads) {
      this.objects.set(key, new Uint8Array(file.content));
    }
    return Promise.resolve();
  }

  fetchFile(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);
    return bytes
      ? Promise.resolve(new Uint8Array(bytes))
      : Promise.reject(new StorageObjectNotFoundError(key));
  }

  async fetchTextFile(key: string): Promise<string> {
    return new TextDecoder().decode(await this.fetchFile(key));
  }

  listFiles(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
    );
  }
}

class TransientReadFailureStore extends MemoryDeploymentStore {
  override fetchFile(key: string): Promise<Uint8Array> {
    return Promise.reject(new Error(`temporary R2 read failure for ${key}`));
  }
}

interface RpcCall {
  name: string;
  request: Record<string, unknown>;
}

interface FetchHarness {
  fetchFn: typeof fetch;
  rpcCalls: RpcCall[];
  urls: URL[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchHarness(input: {
  targetApp?: Record<string, unknown> | null;
  deployments?:
    | Record<string, unknown>[]
    | ((url: URL) => Record<string, unknown>[]);
  rpc?: (
    name: string,
    request: Record<string, unknown>,
  ) => Record<string, unknown> | Response;
} = {}): FetchHarness {
  const rpcCalls: RpcCall[] = [];
  const urls: URL[] = [];
  const fetchFn = ((
    resource: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof resource === "string" || resource instanceof URL
        ? String(resource)
        : resource.url,
    );
    urls.push(url);
    const rpcName = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)$/)?.[1];
    if (rpcName) {
      const request = typeof init?.body === "string"
        ? JSON.parse(init.body).p_request as Record<string, unknown>
        : {};
      rpcCalls.push({ name: rpcName, request });
      const result = input.rpc?.(rpcName, request) ?? { ok: true };
      return Promise.resolve(
        result instanceof Response ? result : jsonResponse([result]),
      );
    }
    if (url.pathname.endsWith("/rest/v1/apps")) {
      return Promise.resolve(
        jsonResponse(input.targetApp ? [input.targetApp] : []),
      );
    }
    if (url.pathname.endsWith("/rest/v1/builder_handoff_deployments")) {
      const deployments = typeof input.deployments === "function"
        ? input.deployments(url)
        : input.deployments ?? [];
      const sessionId = url.searchParams.get("session_id")?.replace(
        /^eq\./u,
        "",
      );
      const ownerId = url.searchParams.get("owner_id")?.replace(/^eq\./u, "");
      return Promise.resolve(
        jsonResponse(
          deployments.filter((row) =>
            (!sessionId || row.session_id === sessionId) &&
            (!ownerId || row.owner_id === ownerId)
          ),
        ),
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) as typeof fetch;
  return { fetchFn, rpcCalls, urls };
}

function invitationOptions(input: {
  sessions?: SessionWithReleaseGeneration[];
  session?: SessionWithReleaseGeneration | null;
  summary?: BuilderHandoffVerifiedCandidateArchiveManifest;
  store?: MemoryDeploymentStore;
  fetch?: FetchHarness;
  loadSnapshot?: BuilderHandoffDeploymentServiceOptions["loadSnapshot"];
  randomUUID?: () => string;
  putLiveBundle?: BuilderHandoffDeploymentServiceOptions["putLiveBundle"];
  loadLiveBundle?: BuilderHandoffDeploymentServiceOptions["loadLiveBundle"];
  now?: () => Date;
  provisionAndMigrate?:
    BuilderHandoffDeploymentServiceOptions["provisionAndMigrate"];
}): BuilderHandoffDeploymentServiceOptions {
  const session = input.session ?? input.sessions?.[0] ?? uploadedSession();
  const summary = input.summary ?? verifiedSummary(session);
  const store = input.store ?? new MemoryDeploymentStore();
  const harness = input.fetch ?? fetchHarness();
  return {
    archiveStore: store,
    listSessions: () => Promise.resolve(input.sessions ?? [session]),
    getSession: () => Promise.resolve(input.session === null ? null : session),
    loadInvitation: () => Promise.resolve(summary),
    ...(input.loadSnapshot ? { loadSnapshot: input.loadSnapshot } : {}),
    ...(input.randomUUID ? { randomUUID: input.randomUUID } : {}),
    ...(input.putLiveBundle ? { putLiveBundle: input.putLiveBundle } : {}),
    ...(input.loadLiveBundle ? { loadLiveBundle: input.loadLiveBundle } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.provisionAndMigrate
      ? { provisionAndMigrate: input.provisionAndMigrate }
      : {}),
    fetchFn: harness.fetchFn,
    supabaseUrl: SERVICE_URL,
    serviceRoleKey: SERVICE_KEY,
  };
}

function deploymentState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code: "claimed",
    deployment_id: DEPLOYMENT_ID,
    status: "in_progress",
    phase: "claimed",
    app_id: RESERVED_AGENT_ID,
    version: VERSION,
    replayed: false,
    lease_token: INITIAL_LEASE_ID,
    ...overrides,
  };
}

function persistedDeploymentRow(input: {
  session: SessionWithReleaseGeneration;
  deploymentId?: string;
  status?: "in_progress" | "completed";
  phase?: "claimed" | "committed";
  response?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const status = input.status ?? "in_progress";
  const phase = input.phase ??
    (status === "completed" ? "committed" : "claimed");
  const deploymentId = input.deploymentId ?? DEPLOYMENT_ID;
  const completed = status === "completed";
  return {
    id: deploymentId,
    session_id: input.session.id,
    owner_id: input.session.ownerId,
    target_app_id: input.session.targetAppId,
    status,
    phase,
    version: input.session.uploadedVersion,
    response: input.response === undefined
      ? completed
        ? {
          code: "committed",
          deployment_id: deploymentId,
          status: "completed",
          phase: "committed",
          app_id: input.session.targetAppId,
          app_slug: "inbox-steward",
          app_name: "Inbox Steward",
          version: input.session.uploadedVersion,
          setup_required: true,
          replayed: false,
        }
        : null
      : input.response,
    error_code: null,
    error_message: null,
    completed_at: completed ? input.session.promotedAt : null,
  };
}

async function candidateInvitation(
  session: SessionWithReleaseGeneration,
  options: BuilderHandoffDeploymentServiceOptions,
) {
  const invitation = await getBuilderHandoffCandidateInvitation(
    OWNER_ID,
    session.id,
    options,
  );
  assert(invitation);
  return invitation;
}

async function deploymentSnapshot(
  summary: BuilderHandoffVerifiedCandidateArchiveManifest,
  releaseArtifacts: FileUpload[] = [],
): Promise<BuilderHandoffCandidateDeploymentSnapshot> {
  const manifest: AppManifest = {
    name: summary.release.name,
    version: VERSION,
    description: summary.release.description ?? undefined,
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      triage: { description: "Classify and label one message." },
    },
  };
  const code = "export const triage = () => ({ ok: true });";
  return {
    verifiedManifest: summary,
    manifest,
    sourceFiles: [],
    releaseArtifacts,
    interfaceArtifacts: [],
    executable: {
      name: "executable.mjs",
      content: encoder.encode(code),
      code,
      sha256: await sha256Hex(code),
    },
    exports: ["triage"],
    migrations: [],
    normalizedEntryName: "index.ts",
    testAttestation: TEST_ATTESTATION,
  };
}

Deno.test("candidate invitations project owner-safe zero, one, and many uploaded releases", async () => {
  const empty = await listBuilderHandoffCandidateInvitations(
    OWNER_ID,
    invitationOptions({ sessions: [] }),
  );
  assertEquals(empty, []);

  const first = uploadedSession();
  const second = uploadedSession({ id: SESSION_TWO_ID });
  const summaries = new Map([
    [first.id, verifiedSummary(first)],
    [second.id, verifiedSummary(second)],
  ]);
  let snapshotLoads = 0;
  const harness = fetchHarness();
  const options = invitationOptions({
    sessions: [first],
    fetch: harness,
    loadSnapshot: () => {
      snapshotLoads += 1;
      throw new Error(
        "invitation projection must not load exact release bytes",
      );
    },
  });
  options.loadInvitation = (_store, binding) => {
    const summary = summaries.get(binding.sessionId)!;
    return Promise.resolve({
      ...summary,
      retainedSource: "TOP-SECRET-SOURCE",
      opaqueTestToken: "REPLAYABLE-TOKEN",
    } as BuilderHandoffVerifiedCandidateArchiveManifest);
  };

  const one = await listBuilderHandoffCandidateInvitations(OWNER_ID, options);
  assertEquals(one.length, 1);
  assertEquals(one[0].release.name, "Inbox Steward");
  assertEquals(one[0].release.settings[0], {
    key: "GMAIL_TOKEN",
    label: "Gmail",
    description: "OAuth token used after setup.",
    required: true,
    secret: true,
    scope: "agent",
    destination: "gmail.googleapis.com",
  });
  assertEquals(snapshotLoads, 0);
  const serialized = JSON.stringify(one);
  assert(!serialized.includes("TOP-SECRET-SOURCE"));
  assert(!serialized.includes("REPLAYABLE-TOKEN"));
  assert(!serialized.includes("testAttestation"));

  options.listSessions = () => Promise.resolve([first, second]);
  const many = await listBuilderHandoffCandidateInvitations(OWNER_ID, options);
  assertEquals(many.map((candidate) => candidate.id), [
    SESSION_ID,
    SESSION_TWO_ID,
  ]);
  assertEquals(many.every((candidate) => candidate.deploymentReady), true);
  assertEquals(snapshotLoads, 0);
});

Deno.test("candidate invitations keep ready and recoverable work beside bounded recent deployment receipts", async () => {
  const ready = uploadedSession();
  const deploying = uploadedSession({
    id: SESSION_TWO_ID,
    targetAppId: EXISTING_AGENT_ID,
  });
  const deployed = uploadedSession({
    id: SESSION_THREE_ID,
    targetAppId: RECOVERY_AGENT_ID,
    status: "promoted",
  });
  const summaries = new Map([
    [ready.id, verifiedSummary(ready)],
    [deploying.id, verifiedSummary(deploying)],
    [deployed.id, verifiedSummary(deployed)],
  ]);
  const harness = fetchHarness({
    deployments: [
      persistedDeploymentRow({
        session: deploying,
        deploymentId: DEPLOYMENT_TWO_ID,
      }),
      persistedDeploymentRow({
        session: deployed,
        status: "completed",
      }),
    ],
  });
  const options = invitationOptions({
    sessions: [ready, deploying, deployed],
    fetch: harness,
    now: () => new Date(CREATED_AT),
  });
  options.loadInvitation = (_store, binding) =>
    Promise.resolve(summaries.get(binding.sessionId)!);

  const invitations = await listBuilderHandoffCandidateInvitations(
    OWNER_ID,
    options,
  );

  assertEquals(invitations.map((candidate) => candidate.status), [
    "ready",
    "deploying",
    "deployed",
  ]);
  assertEquals(invitations[0].deployment, null);
  assertEquals(invitations[1].deployment, null);
  assertEquals(invitations[2].deploymentReady, false);
  assertEquals(invitations[2].blocker, null);
  assertEquals(invitations[2].deployment, {
    deploymentId: DEPLOYMENT_ID,
    completedAt: CREATED_AT,
    agent: {
      id: RECOVERY_AGENT_ID,
      slug: "inbox-steward",
      name: "Inbox Steward",
      version: VERSION,
      setupRequired: true,
    },
  });
  const deploymentReads = harness.urls.filter((url) =>
    url.pathname.endsWith("/rest/v1/builder_handoff_deployments")
  );
  assertEquals(deploymentReads.length, 3);
  for (const read of deploymentReads) {
    assertEquals(read.searchParams.get("owner_id"), `eq.${OWNER_ID}`);
    assertEquals(read.searchParams.get("limit"), "1");
    const select = read.searchParams.get("select") ?? "";
    assert(select.includes("response"));
    assert(!select.includes("idempotency_key"));
    assert(!select.includes("request_payload"));
  }
});

Deno.test("candidate detail recovers only a recent completed deployment with an exact durable receipt", async () => {
  const promoted = uploadedSession({
    status: "promoted",
    targetAppId: RECOVERY_AGENT_ID,
  });
  const harness = fetchHarness({
    deployments: [
      persistedDeploymentRow({ session: promoted, status: "completed" }),
    ],
  });
  const options = invitationOptions({
    session: promoted,
    fetch: harness,
    now: () => new Date(CREATED_AT),
  });

  const recovered = await getBuilderHandoffCandidateInvitation(
    OWNER_ID,
    promoted.id,
    options,
  );
  assert(recovered);
  assertEquals(recovered.status, "deployed");
  assertEquals(recovered.deployment?.deploymentId, DEPLOYMENT_ID);
  assertEquals(recovered.deployment?.agent.setupRequired, true);
  const serialized = JSON.stringify(recovered);
  assert(!serialized.includes("idempotency_key"));
  assert(!serialized.includes("request_payload"));
  assert(!serialized.includes("lease_token"));

  const old = uploadedSession({
    status: "promoted",
    promotedAt: "2026-07-20T18:00:00.000Z",
  });
  let oldDeploymentReads = 0;
  const oldHarness = fetchHarness({
    deployments: () => {
      oldDeploymentReads += 1;
      return [persistedDeploymentRow({ session: old, status: "completed" })];
    },
  });
  const expired = await getBuilderHandoffCandidateInvitation(
    OWNER_ID,
    old.id,
    invitationOptions({
      session: old,
      fetch: oldHarness,
      now: () => new Date(CREATED_AT),
    }),
  );
  assertEquals(expired, null);
  assertEquals(oldDeploymentReads, 0);
});

Deno.test("completed deployment receipt parsing fails closed on mismatched or incomplete persistence", async () => {
  const promoted = uploadedSession({
    status: "promoted",
    targetAppId: RECOVERY_AGENT_ID,
  });
  const malformed = persistedDeploymentRow({
    session: promoted,
    status: "completed",
  });
  (malformed.response as Record<string, unknown>).app_slug = "";
  const error = await assertRejects(
    () =>
      getBuilderHandoffCandidateInvitation(
        OWNER_ID,
        promoted.id,
        invitationOptions({
          session: promoted,
          fetch: fetchHarness({ deployments: [malformed] }),
          now: () => new Date(CREATED_AT),
        }),
      ),
    BuilderHandoffDeploymentError,
  ) as BuilderHandoffDeploymentError;
  assertEquals(error.code, "invalid_response");
  assertEquals(error.status, 503);

  const impossibleLifecycle = persistedDeploymentRow({ session: promoted });
  impossibleLifecycle.phase = "committed";
  const lifecycleError = await assertRejects(
    () =>
      getBuilderHandoffCandidateInvitation(
        OWNER_ID,
        promoted.id,
        invitationOptions({
          session: promoted,
          fetch: fetchHarness({ deployments: [impossibleLifecycle] }),
          now: () => new Date(CREATED_AT),
        }),
      ),
    BuilderHandoffDeploymentError,
  ) as BuilderHandoffDeploymentError;
  assertEquals(lifecycleError.code, "invalid_response");
  assertEquals(lifecycleError.status, 503);
});

Deno.test("extension invitation becomes stale when current target lineage moved", async () => {
  const session = uploadedSession({
    intent: "function",
    targetAppId: EXISTING_AGENT_ID,
  });
  const harness = fetchHarness({
    targetApp: {
      id: EXISTING_AGENT_ID,
      owner_id: OWNER_ID,
      slug: "inbox-steward",
      name: "Inbox Steward",
      visibility: "private",
      current_version: "2.0.0",
      manifest: {
        name: "Inbox Steward",
        version: "2.0.0",
        type: "mcp",
        entry: { functions: "index.ts" },
      },
      version_metadata: [],
      deleted_at: null,
      release_generation: 4,
    },
  });
  const invitation = await candidateInvitation(
    session,
    invitationOptions({ session, fetch: harness }),
  );

  assertEquals(invitation.status, "stale");
  assertEquals(invitation.blocker?.code, "candidate_base_stale");
  assertEquals(invitation.target.kind, "extension");
  if (invitation.target.kind === "extension") {
    assertEquals(invitation.target.lineageStatus, "stale");
    assertEquals(invitation.target.currentVersion, "2.0.0");
    assertEquals(invitation.target.baseLineage.version, "1.0.0");
    assertEquals(invitation.target.baseLineage.stateDigest, BASE_STATE_DIGEST);
  }
  const appRead = harness.urls.find((url) =>
    url.pathname.endsWith("/rest/v1/apps")
  );
  assert(appRead);
  assertEquals(appRead.searchParams.get("owner_id"), `eq.${OWNER_ID}`);
  assertEquals(appRead.searchParams.get("id"), `eq.${EXISTING_AGENT_ID}`);
});

Deno.test("pre-M7 extension remains visible but cannot reach deployment", async () => {
  const session = uploadedSession({
    intent: "function",
    targetAppId: EXISTING_AGENT_ID,
    baseReleaseGeneration: null,
  });
  const healthy = uploadedSession({ id: SESSION_TWO_ID });
  const harness = fetchHarness({
    targetApp: {
      id: EXISTING_AGENT_ID,
      owner_id: OWNER_ID,
      slug: "inbox-steward",
      name: "Inbox Steward",
      visibility: "private",
      current_version: "1.0.0",
      manifest: {
        name: "Inbox Steward",
        version: "1.0.0",
        type: "mcp",
        entry: { functions: "index.ts" },
      },
      version_metadata: [],
      deleted_at: null,
      release_generation: 3,
    },
    rpc: () => {
      throw new Error("legacy extension must not reach a deployment claim");
    },
  });
  const options = invitationOptions({
    sessions: [session, healthy],
    fetch: harness,
  });
  const summaries = new Map([
    [session.id, verifiedSummary(session)],
    [healthy.id, verifiedSummary(healthy)],
  ]);
  options.loadInvitation = (_store, binding) =>
    Promise.resolve(summaries.get(binding.sessionId)!);

  const invitations = await listBuilderHandoffCandidateInvitations(
    OWNER_ID,
    options,
  );
  assertEquals(
    invitations.map((candidate) => [candidate.id, candidate.status]),
    [
      [session.id, "stale"],
      [healthy.id, "ready"],
    ],
  );

  const invitation = await candidateInvitation(session, options);

  assertEquals(invitation.status, "stale");
  assertEquals(
    invitation.blocker,
    {
      code: "candidate_base_generation_missing",
      message:
        "This extension candidate predates reliable release lineage. Create a fresh handoff.",
    },
  );

  const error = await assertRejects(
    () =>
      deployBuilderHandoffCandidate(
        {
          ownerId: OWNER_ID,
          candidateId: session.id,
          idempotencyKey: "pre-m7-extension-review",
          archiveDigest: invitation.archive.digest,
          releaseDigest: invitation.evidence.releaseDigest,
          reviewRevision: invitation.reviewRevision,
        },
        options,
      ),
    BuilderHandoffDeploymentError,
  ) as BuilderHandoffDeploymentError;
  assertEquals(error.code, "stale");
  assertEquals(error.status, 409);
  assertEquals(error.causeCode, "candidate_base_generation_missing");
  assertEquals(harness.rpcCalls, []);
});

Deno.test("review, archive, and release digest mismatches fail before the deployment claim", async () => {
  const session = uploadedSession();
  const harness = fetchHarness({
    rpc: () => {
      throw new Error("claim must not run for stale browser input");
    },
  });
  let snapshotLoads = 0;
  const options = invitationOptions({
    session,
    fetch: harness,
    loadSnapshot: () => {
      snapshotLoads += 1;
      throw new Error("snapshot must not load before browser bindings match");
    },
  });
  const invitation = await candidateInvitation(session, options);
  harness.rpcCalls.length = 0;

  const requests = [
    {
      archiveDigest: "a".repeat(64),
      releaseDigest: RELEASE_DIGEST,
      reviewRevision: invitation.reviewRevision,
    },
    {
      archiveDigest: ARCHIVE_DIGEST,
      releaseDigest: "b".repeat(64),
      reviewRevision: invitation.reviewRevision,
    },
    {
      archiveDigest: ARCHIVE_DIGEST,
      releaseDigest: RELEASE_DIGEST,
      reviewRevision: `gxr1:${"c".repeat(64)}`,
    },
  ];
  for (const [index, request] of requests.entries()) {
    const error = await assertRejects(
      () =>
        deployBuilderHandoffCandidate({
          ownerId: OWNER_ID,
          candidateId: SESSION_ID,
          idempotencyKey: `browser-review-${index}`,
          ...request,
        }, options),
      BuilderHandoffDeploymentError,
    );
    assertEquals(error.code, "stale");
    assertEquals(error.status, 409);
  }
  assertEquals(harness.rpcCalls, []);
  assertEquals(snapshotLoads, 0);
});

Deno.test("an already committed idempotent claim replays without rematerializing bytes", async () => {
  const session = uploadedSession();
  const harness = fetchHarness({
    rpc: (name) => {
      assertEquals(name, "claim_builder_handoff_deployment");
      return deploymentState({
        code: "already_committed",
        status: "completed",
        phase: "committed",
        replayed: true,
        app_slug: "inbox-steward",
        app_name: "Inbox Steward",
      });
    },
  });
  let snapshotLoads = 0;
  const store = new MemoryDeploymentStore();
  const options = invitationOptions({
    session,
    store,
    fetch: harness,
    randomUUID: () => INITIAL_LEASE_ID,
    loadSnapshot: () => {
      snapshotLoads += 1;
      throw new Error("committed replay must not load the archive");
    },
  });
  const invitation = await candidateInvitation(session, options);
  harness.rpcCalls.length = 0;

  const response = await deployBuilderHandoffCandidate({
    ownerId: OWNER_ID,
    candidateId: SESSION_ID,
    idempotencyKey: "same-deploy-request",
    archiveDigest: ARCHIVE_DIGEST,
    releaseDigest: RELEASE_DIGEST,
    reviewRevision: invitation.reviewRevision,
  }, options);

  assertEquals(response.success, true);
  assertEquals(response.status, "completed");
  assertEquals(response.replayed, true);
  assertEquals(response.agent, {
    id: RESERVED_AGENT_ID,
    slug: "inbox-steward",
    name: "Inbox Steward",
    version: VERSION,
    setupRequired: true,
  });
  assertEquals(harness.rpcCalls.map((call) => call.name), [
    "claim_builder_handoff_deployment",
  ]);
  assertEquals(
    harness.rpcCalls[0].request.idempotency_key,
    "same-deploy-request",
  );
  assertEquals(snapshotLoads, 0);
  assertEquals(store.writes, []);
});

Deno.test("a promoted session replays its committed result after a lost HTTP response", async () => {
  const session = uploadedSession({ status: "promoted" });
  const harness = fetchHarness({
    rpc: (name) => {
      assertEquals(name, "claim_builder_handoff_deployment");
      return deploymentState({
        code: "already_completed",
        status: "completed",
        phase: "committed",
        replayed: true,
        app_slug: "inbox-steward",
        app_name: "Inbox Steward",
      });
    },
  });
  let invitationLoads = 0;
  let snapshotLoads = 0;
  const store = new MemoryDeploymentStore();
  const options = invitationOptions({
    session,
    store,
    fetch: harness,
    randomUUID: () => INITIAL_LEASE_ID,
    loadSnapshot: () => {
      snapshotLoads += 1;
      throw new Error("promoted replay must not load deployment bytes");
    },
  });
  options.loadInvitation = () => {
    invitationLoads += 1;
    throw new Error("promoted replay must not rebuild the invitation");
  };

  const response = await deployBuilderHandoffCandidate({
    ownerId: OWNER_ID,
    candidateId: SESSION_ID,
    idempotencyKey: "same-deploy-request",
    archiveDigest: ARCHIVE_DIGEST,
    releaseDigest: RELEASE_DIGEST,
    reviewRevision: `gxr1:${"a".repeat(64)}`,
  }, options);

  assertEquals(response.success, true);
  assertEquals(response.status, "completed");
  assertEquals(response.replayed, true);
  assertEquals(response.agent, {
    id: RESERVED_AGENT_ID,
    slug: "inbox-steward",
    name: "Inbox Steward",
    version: VERSION,
    setupRequired: true,
  });
  assertEquals(harness.rpcCalls.map((call) => call.name), [
    "claim_builder_handoff_deployment",
  ]);
  assertEquals(invitationLoads, 0);
  assertEquals(snapshotLoads, 0);
  assertEquals(store.writes, []);
});

Deno.test("a reconciled phase replay retains exact objects and commits through ordered fences", async () => {
  const session = uploadedSession();
  const summary = verifiedSummary(session);
  const releaseFile: FileUpload = {
    name: "manifest.json",
    content: encoder.encode('{"name":"Inbox Steward"}'),
    contentType: "application/json",
  };
  const snapshot = await deploymentSnapshot(summary, [releaseFile]);
  const store = new MemoryDeploymentStore();
  store.objects.set(
    `apps/${RESERVED_AGENT_ID}/releases/${RELEASE_DIGEST}/manifest.json`,
    releaseFile.content,
  );
  const rpcRequests: RpcCall[] = [];
  const harness = fetchHarness({
    rpc: (name, request) => {
      rpcRequests.push({ name, request });
      if (name === "claim_builder_handoff_deployment") {
        return deploymentState({
          phase: "artifacts_verified",
          requires_reconciliation: true,
        });
      }
      if (name === "reconcile_builder_handoff_deployment_lease") {
        return deploymentState({
          code: "reconciled",
          phase: "artifacts_verified",
          lease_token: RECONCILED_LEASE_ID,
        });
      }
      if (name === "fence_builder_handoff_deployment") {
        return deploymentState({
          code: "fenced",
          phase: request.phase,
          lease_token: RECONCILED_LEASE_ID,
        });
      }
      if (name === "commit_builder_handoff_deployment") {
        return deploymentState({
          code: "committed",
          status: "completed",
          phase: "committed",
          lease_token: RECONCILED_LEASE_ID,
          app_slug: "inbox-steward",
          app_name: "Inbox Steward",
        });
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  });
  const generatedLeases = [INITIAL_LEASE_ID, RECONCILED_LEASE_ID];
  let liveWrites = 0;
  const options = invitationOptions({
    session,
    summary,
    store,
    fetch: harness,
    loadSnapshot: () => Promise.resolve(snapshot),
    randomUUID: () => generatedLeases.shift()!,
    putLiveBundle: () => {
      liveWrites += 1;
      return Promise.resolve();
    },
    loadLiveBundle: () =>
      Promise.resolve({
        code: snapshot.executable.code,
        attestation: {
          v: 1,
          app_id: RESERVED_AGENT_ID,
          version: VERSION,
          bundle_hash: snapshot.executable.sha256,
          signed_at: CREATED_AT,
          sig: "signed",
        },
      }),
    provisionAndMigrate: () =>
      Promise.resolve({
        provisioned: false,
        status: "skipped",
        migrations_applied: 0,
        migrations_skipped: 0,
        migration_errors: [],
      }),
  });
  const invitation = await candidateInvitation(session, options);
  harness.rpcCalls.length = 0;
  rpcRequests.length = 0;

  const previousEnv = globalThis.__env;
  const releaseCode = new Map<
    string,
    { value: string; metadata: unknown }
  >();
  globalThis.__env = {
    ENVIRONMENT: "test",
    TRUST_SIGNING_SECRET: "test-trust-secret",
    CODE_CACHE: {
      get: (key: string) =>
        Promise.resolve(releaseCode.get(key)?.value ?? null),
      getWithMetadata: (key: string) => {
        const entry = releaseCode.get(key);
        return Promise.resolve(
          entry
            ? { value: entry.value, metadata: entry.metadata }
            : { value: null, metadata: null },
        );
      },
      put: (
        key: string,
        value: string,
        options?: { metadata?: unknown },
      ) => {
        releaseCode.set(key, {
          value,
          metadata: options?.metadata ?? null,
        });
        return Promise.resolve();
      },
    },
  } as unknown as typeof globalThis.__env;
  try {
    await putReleaseExecutedBundle({
      appId: RESERVED_AGENT_ID,
      version: VERSION,
      releaseDigest: RELEASE_DIGEST,
      esmCode: snapshot.executable.code,
    });
    const response = await deployBuilderHandoffCandidate({
      ownerId: OWNER_ID,
      candidateId: SESSION_ID,
      idempotencyKey: "resume-deploy-request",
      archiveDigest: ARCHIVE_DIGEST,
      releaseDigest: RELEASE_DIGEST,
      reviewRevision: invitation.reviewRevision,
    }, options);

    assertEquals(response.success, true);
    assertEquals(response.status, "completed");
    assertEquals(liveWrites, 1);
    assertEquals(store.writes, []);
    assertEquals(rpcRequests.map((call) => call.name), [
      "claim_builder_handoff_deployment",
      "reconcile_builder_handoff_deployment_lease",
      "fence_builder_handoff_deployment",
      "fence_builder_handoff_deployment",
      "fence_builder_handoff_deployment",
      "fence_builder_handoff_deployment",
      "fence_builder_handoff_deployment",
      "commit_builder_handoff_deployment",
    ]);
    assertEquals(
      rpcRequests
        .filter((call) => call.name === "fence_builder_handoff_deployment")
        .map((call) => call.request.phase),
      [
        "archive_verified",
        "artifacts_started",
        "artifacts_verified",
        "live_bundle_started",
        "live_bundle_verified",
      ],
    );
    assertEquals(
      rpcRequests
        .slice(2)
        .every((call) => call.request.lease_token === RECONCILED_LEASE_ID),
      true,
    );
    const commit = rpcRequests.find((call) =>
      call.name === "commit_builder_handoff_deployment"
    )!;
    assertEquals(
      (commit.request.app as Record<string, unknown>).executable_key,
      `esm:${RESERVED_AGENT_ID}:release:${RELEASE_DIGEST}`,
    );
    assertEquals(
      (commit.request.release_provenance as Record<string, unknown>)
        .attestation_id,
      TEST_ATTESTATION.attestation_id,
    );
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("reconciliation refuses a divergent content-addressed interface before reclaiming the lease", async () => {
  const session = uploadedSession();
  const summary = verifiedSummary(session);
  const snapshot = await deploymentSnapshot(summary);
  const interfaceName = `${"a".repeat(64)}.html`;
  snapshot.interfaceArtifacts = [{
    name: interfaceName,
    content: encoder.encode("<main>frozen interface</main>"),
    contentType: "text/html",
  }];
  const store = new MemoryDeploymentStore();
  store.objects.set(
    `interfaces/${RESERVED_AGENT_ID}/${interfaceName}`,
    encoder.encode("<main>different interface</main>"),
  );
  const harness = fetchHarness({
    rpc: (name) => {
      assertEquals(name, "claim_builder_handoff_deployment");
      return deploymentState({
        phase: "artifacts_started",
        requires_reconciliation: true,
      });
    },
  });
  const options = invitationOptions({
    session,
    summary,
    store,
    fetch: harness,
    loadSnapshot: () => Promise.resolve(snapshot),
    randomUUID: () => INITIAL_LEASE_ID,
  });
  const invitation = await candidateInvitation(session, options);
  harness.rpcCalls.length = 0;

  const error = await assertRejects(
    () =>
      deployBuilderHandoffCandidate({
        ownerId: OWNER_ID,
        candidateId: SESSION_ID,
        idempotencyKey: "divergent-interface-reconciliation",
        archiveDigest: ARCHIVE_DIGEST,
        releaseDigest: RELEASE_DIGEST,
        reviewRevision: invitation.reviewRevision,
      }, options),
    BuilderHandoffDeploymentError,
  );
  assertEquals(error.code, "repair_required");
  assertEquals(error.status, 409);
  assertEquals(harness.rpcCalls.map((call) => call.name), [
    "claim_builder_handoff_deployment",
  ]);
});

Deno.test("a database membership rejection remains an exact 402 boundary", async () => {
  const session = uploadedSession();
  const harness = fetchHarness({
    rpc: (name) => {
      assertEquals(name, "claim_builder_handoff_deployment");
      return { code: "pro_subscription_required", replayed: false };
    },
  });
  const options = invitationOptions({
    session,
    fetch: harness,
    randomUUID: () => INITIAL_LEASE_ID,
  });
  const invitation = await candidateInvitation(session, options);
  harness.rpcCalls.length = 0;

  const rejected = await assertRejects(
    () =>
      deployBuilderHandoffCandidate({
        ownerId: OWNER_ID,
        candidateId: SESSION_ID,
        idempotencyKey: "membership-boundary",
        archiveDigest: ARCHIVE_DIGEST,
        releaseDigest: RELEASE_DIGEST,
        reviewRevision: invitation.reviewRevision,
      }, options),
    BuilderHandoffDeploymentError,
  );
  assertEquals(rejected.code, "membership_required");
  assertEquals(rejected.status, 402);
  assertEquals(harness.rpcCalls.map((call) => call.name), [
    "claim_builder_handoff_deployment",
  ]);
});

Deno.test("failure before materialization is marked failed at the claimed boundary", async () => {
  const session = uploadedSession();
  const failureRequests: Record<string, unknown>[] = [];
  const harness = fetchHarness({
    rpc: (name, request) => {
      if (name === "claim_builder_handoff_deployment") {
        return deploymentState();
      }
      if (name === "fail_builder_handoff_deployment") {
        failureRequests.push(request);
        return { ok: true };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  });
  const options = invitationOptions({
    session,
    fetch: harness,
    randomUUID: () => INITIAL_LEASE_ID,
    loadSnapshot: () =>
      Promise.reject(new Error("archive temporarily offline")),
  });
  const invitation = await candidateInvitation(session, options);
  harness.rpcCalls.length = 0;

  const error = await assertRejects(
    () =>
      deployBuilderHandoffCandidate({
        ownerId: OWNER_ID,
        candidateId: SESSION_ID,
        idempotencyKey: "pre-effect-failure",
        archiveDigest: ARCHIVE_DIGEST,
        releaseDigest: RELEASE_DIGEST,
        reviewRevision: invitation.reviewRevision,
      }, options),
    BuilderHandoffDeploymentError,
  );
  assertEquals(error.code, "materialization_failed");
  assertEquals(error.status, 503);
  assertEquals(harness.rpcCalls.map((call) => call.name), [
    "claim_builder_handoff_deployment",
    "fail_builder_handoff_deployment",
  ]);
  assertEquals(failureRequests.length, 1);
  assertEquals(failureRequests[0].phase, "claimed");
  assertEquals(failureRequests[0].status, "failed");
});

Deno.test("failure after an artifacts fence is marked repair-required", async () => {
  const session = uploadedSession();
  const summary = verifiedSummary(session);
  const snapshot = await deploymentSnapshot(summary, [{
    name: "manifest.json",
    content: encoder.encode('{"name":"Inbox Steward"}'),
    contentType: "application/json",
  }]);
  const store = new MemoryDeploymentStore(false);
  const failureRequests: Record<string, unknown>[] = [];
  const harness = fetchHarness({
    rpc: (name, request) => {
      if (name === "claim_builder_handoff_deployment") {
        return deploymentState();
      }
      if (name === "fence_builder_handoff_deployment") {
        return deploymentState({
          code: "fenced",
          phase: request.phase,
        });
      }
      if (name === "fail_builder_handoff_deployment") {
        failureRequests.push(request);
        return { ok: true };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  });
  const options = invitationOptions({
    session,
    summary,
    store,
    fetch: harness,
    randomUUID: () => INITIAL_LEASE_ID,
    loadSnapshot: () => Promise.resolve(snapshot),
  });
  const invitation = await candidateInvitation(session, options);
  harness.rpcCalls.length = 0;

  const error = await assertRejects(
    () =>
      deployBuilderHandoffCandidate({
        ownerId: OWNER_ID,
        candidateId: SESSION_ID,
        idempotencyKey: "post-effect-failure",
        archiveDigest: ARCHIVE_DIGEST,
        releaseDigest: RELEASE_DIGEST,
        reviewRevision: invitation.reviewRevision,
      }, options),
    BuilderHandoffDeploymentError,
  );
  assertEquals(error.code, "materialization_failed");
  assertEquals(error.status, 503);
  assertEquals(harness.rpcCalls.map((call) => call.name), [
    "claim_builder_handoff_deployment",
    "fence_builder_handoff_deployment",
    "fence_builder_handoff_deployment",
    "fail_builder_handoff_deployment",
  ]);
  assertEquals(failureRequests.length, 1);
  assertEquals(failureRequests[0].phase, "artifacts_started");
  assertEquals(failureRequests[0].status, "repair_required");
});

Deno.test("a transient immutable-object read failure never falls through to overwrite", async () => {
  const session = uploadedSession();
  const summary = verifiedSummary(session);
  const snapshot = await deploymentSnapshot(summary, [{
    name: "manifest.json",
    content: encoder.encode('{"name":"Inbox Steward"}'),
    contentType: "application/json",
  }]);
  const store = new TransientReadFailureStore();
  const failureRequests: Record<string, unknown>[] = [];
  const harness = fetchHarness({
    rpc: (name, request) => {
      if (name === "claim_builder_handoff_deployment") {
        return deploymentState();
      }
      if (name === "fence_builder_handoff_deployment") {
        return deploymentState({
          code: "fenced",
          phase: request.phase,
        });
      }
      if (name === "fail_builder_handoff_deployment") {
        failureRequests.push(request);
        return { ok: true };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  });
  const options = invitationOptions({
    session,
    summary,
    store,
    fetch: harness,
    randomUUID: () => INITIAL_LEASE_ID,
    loadSnapshot: () => Promise.resolve(snapshot),
  });
  const invitation = await candidateInvitation(session, options);
  harness.rpcCalls.length = 0;

  const error = await assertRejects(
    () =>
      deployBuilderHandoffCandidate({
        ownerId: OWNER_ID,
        candidateId: SESSION_ID,
        idempotencyKey: "transient-read-failure",
        archiveDigest: ARCHIVE_DIGEST,
        releaseDigest: RELEASE_DIGEST,
        reviewRevision: invitation.reviewRevision,
      }, options),
    BuilderHandoffDeploymentError,
  );
  assertEquals(error.code, "service_unavailable");
  assertEquals(error.status, 503);
  assertEquals(store.writes, []);
  assertEquals(failureRequests.length, 1);
  assertEquals(failureRequests[0].status, "repair_required");
});
