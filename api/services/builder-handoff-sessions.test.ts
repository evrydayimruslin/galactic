import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  advanceBuilderHandoffSession,
  authenticateBuilderHandoffSession,
  BUILDER_HANDOFF_RECENT_PROMOTED_LIMIT,
  BUILDER_HANDOFF_RECENT_PROMOTED_WINDOW_MS,
  BUILDER_HANDOFF_TTL_SECONDS,
  BUILDER_HANDOFF_UPLOADED_CANDIDATE_LIMIT,
  type BuilderHandoffIntent,
  BuilderHandoffSessionError,
  type BuilderHandoffStatus,
  createBuilderHandoffSession,
  isBuilderHandoffScopeSet,
  isDefinitiveBuilderHandoffTransitionRejection,
  listBuilderHandoffCandidateSessions,
  terminateBuilderHandoffSession,
} from "./builder-handoff-sessions.ts";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000002";
const CANDIDATE_SET_ID = "10000000-0000-4000-8000-000000000003";
const RESERVED_AGENT_ID = "10000000-0000-4000-8000-000000000004";
const EXISTING_AGENT_ID = "10000000-0000-4000-8000-000000000005";
const CREATED_AT = "2026-07-30T18:00:00.000Z";
const EXPIRES_AT = "2026-07-30T19:00:00.000Z";
const DESCRIPTION_DIGEST = "1".repeat(64);
const SOURCE_HASH = "2".repeat(64);
const ATTESTATION_DIGEST = "3".repeat(64);
const DOCUMENT_DIGEST = "4".repeat(64);
const REPORT_DIGEST = "5".repeat(64);
const RELEASE_DIGEST = "6".repeat(64);
const ARCHIVE_DIGEST = "7".repeat(64);
const BASE_SOURCE_HASH = "8".repeat(64);
const BASE_RELEASE_DIGEST = "9".repeat(64);
const BASE_STATE_DIGEST = "a".repeat(64);
const BASE_RELEASE_GENERATION = 7;
const BUNDLE_ID = `gxb1_${"b".repeat(64)}`;

interface SessionRowInput {
  intent?: BuilderHandoffIntent;
  targetAppId?: string | null;
  status?: BuilderHandoffStatus;
  statusVersion?: number;
  lineageRevision?: number;
  baseVersion?: string | null;
  baseSourceHash?: string | null;
  baseReleaseDigest?: string | null;
  baseStateDigest?: string | null;
  baseReleaseGeneration?: number | null;
  descriptionDigest?: string;
  bundleId?: string | null;
  sourceHash?: string | null;
  attestationId?: string | null;
  attestationDigest?: string | null;
  documentDigest?: string | null;
  reportDigest?: string | null;
  releaseDigest?: string | null;
  candidateArchiveDigest?: string | null;
  candidateArchiveBytes?: number | null;
  candidateArchiveObjects?: number | null;
  uploadedAppId?: string | null;
  uploadedVersion?: string | null;
  connectedAt?: string | null;
  stagedAt?: string | null;
  testedAt?: string | null;
  uploadedAt?: string | null;
  promotedAt?: string | null;
  credentialRevokedAt?: string | null;
  terminalAt?: string | null;
  updatedAt?: string;
}

function sessionRow(input: SessionRowInput = {}): Record<string, unknown> {
  const intent = input.intent ?? "agent";
  const targetAppId = input.targetAppId === undefined
    ? RESERVED_AGENT_ID
    : input.targetAppId;
  const status = input.status ?? "created";
  const extension = intent === "interface" || intent === "function" ||
    intent === "routine";
  return {
    id: SESSION_ID,
    token_id: SESSION_ID,
    owner_id: OWNER_ID,
    candidate_set_id: CANDIDATE_SET_ID,
    intent,
    target_app_id: targetAppId,
    base_version: input.baseVersion === undefined
      ? (extension ? "1.2.3" : null)
      : input.baseVersion,
    base_source_hash: input.baseSourceHash === undefined
      ? (extension ? BASE_SOURCE_HASH : null)
      : input.baseSourceHash,
    base_release_digest: input.baseReleaseDigest === undefined
      ? (extension ? BASE_RELEASE_DIGEST : null)
      : input.baseReleaseDigest,
    base_state_digest: input.baseStateDigest === undefined
      ? (extension ? BASE_STATE_DIGEST : null)
      : input.baseStateDigest,
    base_release_generation: input.baseReleaseGeneration === undefined
      ? (extension ? BASE_RELEASE_GENERATION : null)
      : input.baseReleaseGeneration,
    status,
    status_version: input.statusVersion ?? 0,
    lineage_revision: input.lineageRevision ?? 0,
    description_sha256: input.descriptionDigest ?? DESCRIPTION_DIGEST,
    bundle_id: input.bundleId ?? null,
    source_hash: input.sourceHash ?? null,
    attestation_id: input.attestationId ?? null,
    attestation_digest: input.attestationDigest ?? null,
    document_digest: input.documentDigest ?? null,
    report_digest: input.reportDigest ?? null,
    release_digest: input.releaseDigest ?? null,
    candidate_archive_digest: input.candidateArchiveDigest ?? null,
    candidate_archive_bytes: input.candidateArchiveBytes ?? null,
    candidate_archive_objects: input.candidateArchiveObjects ?? null,
    uploaded_app_id: input.uploadedAppId ?? null,
    uploaded_version: input.uploadedVersion ?? null,
    created_at: CREATED_AT,
    expires_at: EXPIRES_AT,
    updated_at: input.updatedAt ?? CREATED_AT,
    connected_at: input.connectedAt ?? null,
    staged_at: input.stagedAt ?? null,
    tested_at: input.testedAt ?? null,
    uploaded_at: input.uploadedAt ?? null,
    promoted_at: input.promotedAt ?? null,
    credential_revoked_at: input.credentialRevokedAt ?? null,
    terminal_at: input.terminalAt ?? null,
  };
}

function rpcJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function serviceOptions(
  fetchFn: typeof fetch,
  overrides: {
    randomUUID?: () => string;
    randomBytes?: (length: number) => Uint8Array;
  } = {},
) {
  return {
    supabaseUrl: "https://supabase.example.test",
    serviceRoleKey: "service-role-key",
    fetchFn,
    now: () => new Date(CREATED_AT),
    ...overrides,
  };
}

function fetchInitValue(
  init: Parameters<typeof fetch>[1],
): { method?: string; body?: unknown } {
  return (init ?? {}) as { method?: string; body?: unknown };
}

function parseFetchBody(
  init: Parameters<typeof fetch>[1],
): Record<string, unknown> {
  return JSON.parse(String(fetchInitValue(init).body)) as Record<
    string,
    unknown
  >;
}

function lifecycleRow(
  status: "staged" | "tested" | "uploaded" | "promoted",
  statusVersion: number,
  evidence: {
    attestationId?: string;
    attestationDigest?: string;
  } = {},
): Record<string, unknown> {
  const tested = status === "tested" || status === "uploaded" ||
    status === "promoted";
  const uploaded = status === "uploaded" || status === "promoted";
  return sessionRow({
    status,
    statusVersion,
    lineageRevision: 1,
    bundleId: BUNDLE_ID,
    sourceHash: SOURCE_HASH,
    attestationId: tested ? (evidence.attestationId ?? "attestation-1") : null,
    attestationDigest: tested
      ? (evidence.attestationDigest ?? ATTESTATION_DIGEST)
      : null,
    documentDigest: tested ? DOCUMENT_DIGEST : null,
    reportDigest: tested ? REPORT_DIGEST : null,
    releaseDigest: tested ? RELEASE_DIGEST : null,
    candidateArchiveDigest: uploaded ? ARCHIVE_DIGEST : null,
    candidateArchiveBytes: uploaded ? 4_096 : null,
    candidateArchiveObjects: uploaded ? 7 : null,
    uploadedAppId: uploaded ? RESERVED_AGENT_ID : null,
    uploadedVersion: uploaded ? "1.2.3" : null,
    connectedAt: CREATED_AT,
    stagedAt: CREATED_AT,
    testedAt: tested ? CREATED_AT : null,
    uploadedAt: uploaded ? CREATED_AT : null,
    promotedAt: status === "promoted" ? CREATED_AT : null,
    credentialRevokedAt: uploaded ? CREATED_AT : null,
  });
}

Deno.test("builder handoff scopes are exact and purpose-bound", () => {
  for (
    const intent of [
      "agent",
      "interface",
      "function",
      "routine",
      "connect",
    ] as const
  ) {
    const scopes = ["apps:read", "agents:build", `handoff:${intent}`];
    assert(isBuilderHandoffScopeSet(scopes, intent));
    assert(isBuilderHandoffScopeSet([...scopes].reverse(), intent));
    assertEquals(
      isBuilderHandoffScopeSet(scopes, "connect"),
      intent === "connect",
    );
    assertEquals(
      isBuilderHandoffScopeSet([...scopes, "agents:operate"], intent),
      false,
    );
    assertEquals(
      isBuilderHandoffScopeSet(
        ["apps:read", "agents:build", `handoff:${intent}`, `handoff:${intent}`],
        intent,
      ),
      false,
    );
  }
});

Deno.test("builder handoff creation derives an exact 60-minute new-Agent credential", async () => {
  const generatedIds = [
    SESSION_ID,
    CANDIDATE_SET_ID,
    RESERVED_AGENT_ID,
  ];
  let randomByteCall = 0;
  const capturedBodies: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    assertEquals(
      String(input),
      "https://supabase.example.test/rest/v1/rpc/create_builder_handoff_session",
    );
    assertEquals(fetchInitValue(init).method, "POST");
    const body = parseFetchBody(init);
    capturedBodies.push(body);
    return rpcJson([
      sessionRow({
        targetAppId: body.p_target_app_id as string,
        descriptionDigest: body.p_description_sha256 as string,
      }),
    ]);
  };

  const result = await createBuilderHandoffSession(
    {
      ownerId: OWNER_ID,
      intent: "agent",
      description: "Build one private Agent candidate",
    },
    serviceOptions(fetchFn, {
      randomUUID: () => generatedIds.shift()!,
      randomBytes: (length) => {
        randomByteCall++;
        return new Uint8Array(length).fill(randomByteCall === 1 ? 0x11 : 0x22);
      },
    }),
  );

  const capturedBody = capturedBodies[0];
  assert(capturedBody);
  assertEquals(capturedBody.p_session_id, SESSION_ID);
  assertEquals(capturedBody.p_candidate_set_id, CANDIDATE_SET_ID);
  assertEquals(capturedBody.p_target_app_id, RESERVED_AGENT_ID);
  assertEquals(capturedBody.p_base_version, null);
  assertEquals(capturedBody.p_base_source_hash, null);
  assertEquals(capturedBody.p_base_release_digest, null);
  assertEquals(capturedBody.p_base_state_digest, null);
  assertEquals(capturedBody.p_base_release_generation, null);
  assertEquals(capturedBody.p_now, CREATED_AT);
  assertEquals(result.session.targetAppId, RESERVED_AGENT_ID);
  assertEquals(result.credential.scopes, [
    "apps:read",
    "agents:build",
    "handoff:agent",
  ]);
  assertEquals(result.credential.appIds, [RESERVED_AGENT_ID]);
  assertEquals(result.credential.plaintextToken, `gx_${"11".repeat(16)}`);
  assertEquals(result.credential.tokenPrefix, "gx_11111");
  assertEquals(
    Date.parse(result.session.expiresAt) - Date.parse(result.session.createdAt),
    BUILDER_HANDOFF_TTL_SECONDS * 1_000,
  );
});

Deno.test("builder handoff creation preserves an extension's immutable base lineage", async () => {
  const generatedIds = [SESSION_ID, CANDIDATE_SET_ID];
  const capturedBodies: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    capturedBodies.push(parseFetchBody(init));
    return rpcJson([
      sessionRow({
        intent: "function",
        targetAppId: EXISTING_AGENT_ID,
        descriptionDigest: capturedBodies[0].p_description_sha256 as string,
      }),
    ]);
  };

  const result = await createBuilderHandoffSession(
    {
      ownerId: OWNER_ID,
      intent: "function",
      targetAppId: EXISTING_AGENT_ID,
      description: "Add the reconcile function",
      baseVersion: "1.2.3",
      baseSourceHash: BASE_SOURCE_HASH,
      baseReleaseDigest: BASE_RELEASE_DIGEST,
      baseStateDigest: BASE_STATE_DIGEST,
      baseReleaseGeneration: BASE_RELEASE_GENERATION,
    },
    serviceOptions(fetchFn, {
      randomUUID: () => generatedIds.shift()!,
      randomBytes: (length) => new Uint8Array(length).fill(0x33),
    }),
  );

  const capturedBody = capturedBodies[0];
  assert(capturedBody);
  assertEquals(capturedBody.p_target_app_id, EXISTING_AGENT_ID);
  assertEquals(capturedBody.p_base_version, "1.2.3");
  assertEquals(capturedBody.p_base_source_hash, BASE_SOURCE_HASH);
  assertEquals(capturedBody.p_base_release_digest, BASE_RELEASE_DIGEST);
  assertEquals(capturedBody.p_base_state_digest, BASE_STATE_DIGEST);
  assertEquals(
    capturedBody.p_base_release_generation,
    BASE_RELEASE_GENERATION,
  );
  assertEquals(result.session.baseVersion, "1.2.3");
  assertEquals(result.session.baseStateDigest, BASE_STATE_DIGEST);
  assertEquals(
    result.session.baseReleaseGeneration,
    BASE_RELEASE_GENERATION,
  );
  assertEquals(result.credential.scopes, [
    "apps:read",
    "agents:build",
    "handoff:function",
  ]);
  assertEquals(result.credential.appIds, [EXISTING_AGENT_ID]);
});

Deno.test("builder handoff authentication rejects non-exact scopes before persistence", async () => {
  let calls = 0;
  const options = serviceOptions(() => {
    calls++;
    return Promise.resolve(rpcJson([]));
  });
  const error = await assertRejects(
    () =>
      authenticateBuilderHandoffSession(
        {
          ownerId: OWNER_ID,
          tokenId: SESSION_ID,
          scopes: [
            "apps:read",
            "agents:build",
            "handoff:agent",
            "agents:operate",
          ],
        },
        options,
      ),
    BuilderHandoffSessionError,
  ) as BuilderHandoffSessionError;
  assertEquals(error.code, "unauthorized");
  assertEquals(calls, 0);
});

Deno.test("builder handoff lifecycle carries exact evidence and treats an exact retest as idempotent", async () => {
  const bodies: Record<string, unknown>[] = [];
  let testCalls = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    assertEquals(
      String(input),
      "https://supabase.example.test/rest/v1/rpc/advance_builder_handoff_session",
    );
    const body = parseFetchBody(init);
    bodies.push(body);
    switch (body.p_event) {
      case "stage":
        return rpcJson([lifecycleRow("staged", 2)]);
      case "test":
        testCalls++;
        return rpcJson([
          lifecycleRow(
            "tested",
            testCalls <= 2 ? 3 : 4,
            testCalls <= 2 ? {} : {
              attestationId: "attestation-2",
              attestationDigest: "c".repeat(64),
            },
          ),
        ]);
      case "upload":
        return rpcJson([
          lifecycleRow("uploaded", 5, {
            attestationId: "attestation-2",
            attestationDigest: "c".repeat(64),
          }),
        ]);
      case "promote":
        return rpcJson([
          lifecycleRow("promoted", 6, {
            attestationId: "attestation-2",
            attestationDigest: "c".repeat(64),
          }),
        ]);
      default:
        throw new Error(`unexpected event: ${body.p_event}`);
    }
  };
  const options = serviceOptions(fetchFn);

  const staged = await advanceBuilderHandoffSession({
    ownerId: OWNER_ID,
    tokenId: SESSION_ID,
    event: "stage",
    bundleId: BUNDLE_ID,
    sourceHash: SOURCE_HASH,
  }, options);
  assertEquals(staged.status, "staged");

  const testInput = {
    ownerId: OWNER_ID,
    tokenId: SESSION_ID,
    event: "test" as const,
    bundleId: BUNDLE_ID,
    sourceHash: SOURCE_HASH,
    attestationId: "attestation-1",
    attestationDigest: ATTESTATION_DIGEST,
    documentDigest: DOCUMENT_DIGEST,
    reportDigest: REPORT_DIGEST,
    releaseDigest: RELEASE_DIGEST,
  };
  const tested = await advanceBuilderHandoffSession(testInput, options);
  const replayed = await advanceBuilderHandoffSession(testInput, options);
  assertEquals(tested.statusVersion, 3);
  assertEquals(replayed.statusVersion, 3);
  const reissued = await advanceBuilderHandoffSession({
    ...testInput,
    attestationId: "attestation-2",
    attestationDigest: "c".repeat(64),
  }, options);
  assertEquals(reissued.statusVersion, 4);
  assertEquals(reissued.attestationId, "attestation-2");
  assertEquals(testCalls, 3);

  const uploaded = await advanceBuilderHandoffSession({
    ...testInput,
    event: "upload",
    attestationId: "attestation-2",
    attestationDigest: "c".repeat(64),
    archiveDigest: ARCHIVE_DIGEST,
    archiveByteCount: 4_096,
    archiveObjectCount: 7,
    appId: RESERVED_AGENT_ID,
    version: "1.2.3",
  }, options);
  assertEquals(uploaded.status, "uploaded");
  assertEquals(uploaded.candidateArchiveDigest, ARCHIVE_DIGEST);
  assertEquals(uploaded.candidateArchiveBytes, 4_096);
  assertEquals(uploaded.candidateArchiveObjects, 7);
  assertEquals(uploaded.credentialRevokedAt, CREATED_AT);

  const promoted = await advanceBuilderHandoffSession({
    ownerId: OWNER_ID,
    tokenId: SESSION_ID,
    event: "promote",
    appId: RESERVED_AGENT_ID,
    releaseDigest: RELEASE_DIGEST,
    version: "1.2.3",
  }, options);
  assertEquals(promoted.status, "promoted");

  assertEquals(bodies[0].p_attestation_id, null);
  assertEquals(bodies[0].p_archive_digest, null);
  assertEquals(bodies[1], bodies[2]);
  assertEquals(bodies[3].p_document_digest, bodies[2].p_document_digest);
  assertEquals(bodies[3].p_release_digest, bodies[2].p_release_digest);
  assertEquals(bodies[3].p_attestation_id, "attestation-2");
  assertEquals(bodies[4].p_archive_digest, ARCHIVE_DIGEST);
  assertEquals(bodies[4].p_archive_bytes, 4_096);
  assertEquals(bodies[4].p_archive_objects, 7);
  assertEquals(bodies[5].p_bundle_id, null);
  assertEquals(bodies[5].p_archive_digest, null);
});

Deno.test("builder handoff upload maps the durable owner archive cap fail-closed", async () => {
  const fetchFn: typeof fetch = () =>
    Promise.resolve(
      rpcJson(
        {
          code: "P0001",
          details: JSON.stringify({
            code: "BUILDER_HANDOFF_ARCHIVE_QUOTA_EXCEEDED",
          }),
        },
        409,
      ),
    );
  const error = await assertRejects(
    () =>
      advanceBuilderHandoffSession({
        ownerId: OWNER_ID,
        tokenId: SESSION_ID,
        event: "upload",
        bundleId: BUNDLE_ID,
        sourceHash: SOURCE_HASH,
        attestationId: "attestation-1",
        attestationDigest: ATTESTATION_DIGEST,
        documentDigest: DOCUMENT_DIGEST,
        reportDigest: REPORT_DIGEST,
        releaseDigest: RELEASE_DIGEST,
        archiveDigest: ARCHIVE_DIGEST,
        archiveByteCount: 4_096,
        archiveObjectCount: 7,
        appId: RESERVED_AGENT_ID,
        version: "1.2.3",
      }, serviceOptions(fetchFn)),
    BuilderHandoffSessionError,
  ) as BuilderHandoffSessionError;
  assertEquals(error.code, "quota_exceeded");
  assertEquals(error.rpcCode, "BUILDER_HANDOFF_ARCHIVE_QUOTA_EXCEEDED");
});

Deno.test("builder handoff archive cleanup excludes ambiguous transition outcomes", () => {
  for (
    const code of [
      "invalid_request",
      "unauthorized",
      "expired",
      "consumed",
      "conflict",
      "quota_exceeded",
    ] as const
  ) {
    assertEquals(
      isDefinitiveBuilderHandoffTransitionRejection(
        new BuilderHandoffSessionError(code, code),
      ),
      true,
      `${code} must permit cleanup of an archive the database rejected`,
    );
  }
  for (const code of ["service_unavailable", "invalid_response"] as const) {
    assertEquals(
      isDefinitiveBuilderHandoffTransitionRejection(
        new BuilderHandoffSessionError(code, code),
      ),
      false,
      `${code} may follow a committed transition and must retain the archive`,
    );
  }
  assertEquals(
    isDefinitiveBuilderHandoffTransitionRejection(
      new Error("unexpected local failure"),
    ),
    false,
  );
});

Deno.test("candidate session projection separately bounds uploaded work and recent promoted recovery", async () => {
  const urls: URL[] = [];
  const fetchFn: typeof fetch = (input) => {
    const url = new URL(String(input));
    urls.push(url);
    const status = url.searchParams.get("status");
    if (status === "eq.uploaded") {
      return Promise.resolve(rpcJson([lifecycleRow("uploaded", 4)]));
    }
    if (status === "eq.promoted") {
      return Promise.resolve(rpcJson([lifecycleRow("promoted", 5)]));
    }
    throw new Error(`Unexpected candidate session query: ${url}`);
  };
  const sessions = await listBuilderHandoffCandidateSessions(
    OWNER_ID,
    serviceOptions(fetchFn),
  );

  assertEquals(sessions.map((session) => session.status), [
    "uploaded",
    "promoted",
  ]);
  assertEquals(urls.length, 2);
  const uploaded = urls.find((url) =>
    url.searchParams.get("status") === "eq.uploaded"
  );
  const promoted = urls.find((url) =>
    url.searchParams.get("status") === "eq.promoted"
  );
  assert(uploaded);
  assert(promoted);
  assertEquals(uploaded.searchParams.get("owner_id"), `eq.${OWNER_ID}`);
  const uploadedSelect = uploaded.searchParams.get("select") ?? "";
  assert(uploadedSelect.includes("token_id"));
  assert(!uploadedSelect.includes("token_hash"));
  assert(!uploadedSelect.includes("token_salt"));
  assertEquals(
    uploaded.searchParams.get("limit"),
    String(BUILDER_HANDOFF_UPLOADED_CANDIDATE_LIMIT),
  );
  assertEquals(uploaded.searchParams.get("order"), "uploaded_at.asc,id.asc");
  assertEquals(promoted.searchParams.get("owner_id"), `eq.${OWNER_ID}`);
  const promotedSelect = promoted.searchParams.get("select") ?? "";
  assert(promotedSelect.includes("token_id"));
  assert(!promotedSelect.includes("token_hash"));
  assert(!promotedSelect.includes("token_salt"));
  assertEquals(
    promoted.searchParams.get("limit"),
    String(BUILDER_HANDOFF_RECENT_PROMOTED_LIMIT),
  );
  assertEquals(promoted.searchParams.get("order"), "promoted_at.desc,id.desc");
  const promotedBounds = promoted.searchParams.getAll("promoted_at");
  assertEquals(promotedBounds, [
    `gte.${
      new Date(
        Date.parse(CREATED_AT) - BUILDER_HANDOFF_RECENT_PROMOTED_WINDOW_MS,
      ).toISOString()
    }`,
    `lte.${new Date(Date.parse(CREATED_AT) + 60_000).toISOString()}`,
  ]);
});

Deno.test("builder handoff termination returns durable credential revocation", async () => {
  const capturedBodies: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    capturedBodies.push(parseFetchBody(init));
    return rpcJson([
      sessionRow({
        status: "cancelled",
        statusVersion: 2,
        connectedAt: CREATED_AT,
        credentialRevokedAt: CREATED_AT,
        terminalAt: CREATED_AT,
      }),
    ]);
  };
  const result = await terminateBuilderHandoffSession({
    ownerId: OWNER_ID,
    tokenId: SESSION_ID,
    status: "cancelled",
  }, serviceOptions(fetchFn));

  const capturedBody = capturedBodies[0];
  assert(capturedBody);
  assertEquals(capturedBody.p_status, "cancelled");
  assertEquals(result.status, "cancelled");
  assertEquals(result.credentialRevokedAt, CREATED_AT);
  assertEquals(result.terminalAt, CREATED_AT);
});

Deno.test("builder handoff parser rejects persistence rows with a non-exact TTL", async () => {
  const invalid = sessionRow();
  invalid.expires_at = "2026-07-30T19:00:01.000Z";
  const error = await assertRejects(
    () =>
      createBuilderHandoffSession(
        {
          ownerId: OWNER_ID,
          intent: "agent",
          description: "Build an Agent",
        },
        serviceOptions(
          () => Promise.resolve(rpcJson([invalid])),
          {
            randomUUID: (() => {
              const ids = [
                SESSION_ID,
                CANDIDATE_SET_ID,
                RESERVED_AGENT_ID,
              ];
              return () => ids.shift()!;
            })(),
            randomBytes: (length) => new Uint8Array(length).fill(0x44),
          },
        ),
      ),
    BuilderHandoffSessionError,
  ) as BuilderHandoffSessionError;
  assertEquals(error.code, "invalid_response");
});
