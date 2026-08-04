import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  claimFunnelSession,
  FUNNEL_MINT_LIMIT_PER_IP,
  FUNNEL_MINT_WINDOW_MINUTES,
  FUNNEL_PAIRING_CODE_LENGTH,
  FUNNEL_RETURN_WINDOW_MS,
  FunnelSessionError,
  mintFunnelSession,
  readFunnelPairing,
  reapExpiredFunnelSessions,
  resumeFunnelSession,
} from "./funnel-sessions.ts";

const SUPABASE_URL = "https://supabase.example.test";
const NOW = new Date("2026-08-03T21:00:00.000Z");

function sequencedUuid(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

function sequencedBytes(): (length: number) => Uint8Array {
  let seed = 0;
  return (length: number) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      seed = (seed + 7) % 251;
      bytes[index] = seed;
    }
    return bytes;
  };
}

interface StubState {
  requests: Array<{ method: string; url: string; body: unknown }>;
  funnelRows: Record<string, unknown>[];
  sessionRows: Record<string, unknown>[];
  appRows: Record<string, unknown>[];
  claimResult?: { status: number; body: unknown };
  reapResult?: { status: number; body: unknown };
}

function fetchStub(state: StubState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body)
      : undefined;
    state.requests.push({ method, url, body });

    if (url.includes("/rest/v1/rpc/create_builder_handoff_session")) {
      const request = body as Record<string, unknown>;
      const createdAt = String(request.p_now);
      const expiresAt = new Date(Date.parse(createdAt) + 3_600_000)
        .toISOString();
      return jsonResponse({
        id: request.p_session_id,
        token_id: request.p_session_id,
        owner_id: request.p_owner_id,
        candidate_set_id: request.p_candidate_set_id,
        intent: request.p_intent,
        target_app_id: request.p_target_app_id,
        base_version: null,
        base_source_hash: null,
        base_release_digest: null,
        base_state_digest: null,
        base_release_generation: null,
        status: "created",
        status_version: 0,
        lineage_revision: 0,
        description_sha256: request.p_description_sha256,
        bundle_id: null,
        source_hash: null,
        attestation_id: null,
        attestation_digest: null,
        document_digest: null,
        report_digest: null,
        release_digest: null,
        candidate_archive_digest: null,
        candidate_archive_bytes: null,
        candidate_archive_objects: null,
        uploaded_app_id: null,
        uploaded_version: null,
        created_at: createdAt,
        expires_at: expiresAt,
        updated_at: createdAt,
        connected_at: null,
        staged_at: null,
        tested_at: null,
        uploaded_at: null,
        promoted_at: null,
        credential_revoked_at: null,
        terminal_at: null,
      });
    }
    if (url.includes("/rest/v1/rpc/claim_funnel_session")) {
      const result = state.claimResult ?? { status: 200, body: [] };
      return jsonResponse(result.body, result.status);
    }
    if (url.includes("/rest/v1/rpc/reap_expired_funnel_sessions")) {
      const result = state.reapResult ?? { status: 200, body: 0 };
      return jsonResponse(result.body, result.status);
    }
    if (url.includes("/rest/v1/users") && method === "POST") {
      return jsonResponse([body]);
    }
    if (url.includes("/rest/v1/funnel_sessions") && method === "POST") {
      return jsonResponse([body]);
    }
    if (url.includes("/rest/v1/funnel_sessions") && method === "PATCH") {
      const base = state.funnelRows[0] ?? {};
      return jsonResponse([{ ...base, ...(body as Record<string, unknown>) }]);
    }
    if (url.includes("/rest/v1/funnel_sessions?")) {
      return jsonResponse(state.funnelRows);
    }
    if (url.includes("/rest/v1/builder_handoff_sessions?")) {
      return jsonResponse(state.sessionRows);
    }
    if (url.includes("/rest/v1/apps?")) {
      return jsonResponse(state.appRows);
    }
    throw new Error(`Unexpected request in funnel test: ${method} ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function options(state: StubState) {
  return {
    supabaseUrl: SUPABASE_URL,
    serviceRoleKey: "service-role-test-key",
    fetchFn: fetchStub(state),
    now: () => NOW,
    randomUUID: sequencedUuid(),
    randomBytes: sequencedBytes(),
  };
}

function emptyState(): StubState {
  return { requests: [], funnelRows: [], sessionRows: [], appRows: [] };
}

function funnelRow(overrides: Record<string, unknown> = {}) {
  return {
    pairing_code: "abcdefghjkmnpqrs2345",
    provisional_owner_id: "00000000-0000-4000-8000-000000000001",
    handoff_session_id: "00000000-0000-4000-8000-000000000002",
    surface: "cli",
    created_at: "2026-08-03T21:00:00.000Z",
    updated_at: "2026-08-03T21:00:00.000Z",
    expires_at: "2026-08-10T21:00:00.000Z",
    claimed_at: null,
    claimed_by: null,
    ...overrides,
  };
}

function handoffSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "staged",
    created_at: "2026-08-03T21:00:00.000Z",
    connected_at: "2026-08-03T21:02:00.000Z",
    staged_at: "2026-08-03T21:05:00.000Z",
    tested_at: null,
    uploaded_at: null,
    promoted_at: null,
    expires_at: "2026-08-03T22:00:00.000Z",
    target_app_id: "00000000-0000-4000-8000-000000000004",
    uploaded_app_id: null,
    uploaded_version: null,
    ...overrides,
  };
}

Deno.test("abuse ceilings stay pinned where support expects them", () => {
  assertEquals(FUNNEL_MINT_LIMIT_PER_IP, 6);
  assertEquals(FUNNEL_MINT_WINDOW_MINUTES, 60);
  assertEquals(FUNNEL_RETURN_WINDOW_MS, 7 * 24 * 60 * 60 * 1_000);
  assertEquals(FUNNEL_PAIRING_CODE_LENGTH, 20);
});

Deno.test("mint creates a provisional owner, a handoff, and the pairing", async () => {
  const state = emptyState();
  const minted = await mintFunnelSession(
    { surface: "cli", description: "Chase overdue invoices politely." },
    options(state),
  );

  const userCreate = state.requests.find((entry) =>
    entry.url.endsWith("/rest/v1/users") && entry.method === "POST"
  );
  assert(userCreate, "provisional users row is created");
  const userBody = userCreate.body as Record<string, unknown>;
  assertEquals(userBody.account_kind, "provisional");
  assertMatch(
    String(userBody.email),
    /^provisional\+00000000-0000-4000-8000-000000000001@provisional\.connectgalactic\.com$/,
  );

  assertEquals(minted.provisionalOwnerId, String(userBody.id));
  assertEquals(minted.session.ownerId, minted.provisionalOwnerId);
  assertEquals(minted.session.intent, "agent");
  assertMatch(minted.credential.plaintextToken, /^gx_[0-9a-f]{32}$/);

  assertMatch(minted.funnel.pairingCode, /^[a-z0-9]{20}$/);
  assertEquals(minted.funnel.surface, "cli");
  assertEquals(
    Date.parse(minted.funnel.expiresAt) - Date.parse(minted.funnel.createdAt),
    FUNNEL_RETURN_WINDOW_MS,
  );

  const order = state.requests.map((entry) => entry.url);
  assert(
    order.findIndex((url) => url.endsWith("/rest/v1/users")) <
      order.findIndex((url) => url.includes("create_builder_handoff_session")),
    "the provisional owner exists before the handoff references it",
  );
});

Deno.test("mint rejects a blank or oversized plan and unknown surfaces", async () => {
  const state = emptyState();
  await assertRejects(
    () =>
      mintFunnelSession({ surface: "cli", description: "   " }, options(state)),
    FunnelSessionError,
    "bounded",
  );
  await assertRejects(
    () =>
      mintFunnelSession(
        { surface: "cli", description: "x".repeat(4_001) },
        options(state),
      ),
    FunnelSessionError,
    "bounded",
  );
  await assertRejects(
    () =>
      mintFunnelSession(
        // deno-lint-ignore no-explicit-any
        { surface: "email" as any, description: "ok" },
        options(state),
      ),
    FunnelSessionError,
    "cli or web",
  );
  assertEquals(state.requests.length, 0);
});

Deno.test("pairing read is stages-only and never carries credential material", async () => {
  const state = emptyState();
  state.funnelRows = [funnelRow()];
  state.sessionRows = [handoffSessionRow()];

  const projection = await readFunnelPairing(
    "abcdefghjkmnpqrs2345",
    options(state),
  );
  assertEquals(projection.status, "staged");
  assertEquals(projection.connectedAt, "2026-08-03T21:02:00.000Z");
  assertEquals(projection.stagedAt, "2026-08-03T21:05:00.000Z");
  assertEquals(projection.testedAt, null);
  assertEquals(projection.claimed, false);
  assertEquals(projection.agentName, null);
  assertEquals(
    projection.reservedAgentId,
    "00000000-0000-4000-8000-000000000004",
  );

  const serialized = JSON.stringify(projection);
  for (
    const forbidden of ["token", "credential", "hash", "salt", "secret"]
  ) {
    assertEquals(
      serialized.toLowerCase().includes(forbidden),
      false,
      `pairing projection leaks "${forbidden}"`,
    );
  }
});

Deno.test("pairing read names the Agent only after an upload names it", async () => {
  const state = emptyState();
  state.funnelRows = [funnelRow()];
  state.sessionRows = [handoffSessionRow({
    status: "uploaded",
    uploaded_at: "2026-08-03T21:20:00.000Z",
    uploaded_app_id: "00000000-0000-4000-8000-000000000004",
    uploaded_version: "1.0.0",
  })];
  state.appRows = [{ name: "Invoice Chaser" }];

  const projection = await readFunnelPairing(
    "abcdefghjkmnpqrs2345",
    options(state),
  );
  assertEquals(projection.agentName, "Invoice Chaser");
  assertEquals(projection.uploadedVersion, "1.0.0");
});

Deno.test("an elapsed unclaimed pairing reads as not found; a claimed one survives", async () => {
  const elapsed = emptyState();
  elapsed.funnelRows = [funnelRow({
    expires_at: "2026-08-03T20:59:59.000Z",
  })];
  await assertRejects(
    () => readFunnelPairing("abcdefghjkmnpqrs2345", options(elapsed)),
    FunnelSessionError,
    "Unknown pairing code",
  );

  const claimed = emptyState();
  claimed.funnelRows = [funnelRow({
    expires_at: "2026-08-03T20:59:59.000Z",
    claimed_at: "2026-08-03T12:00:00.000Z",
    claimed_by: "00000000-0000-4000-8000-000000000009",
  })];
  claimed.sessionRows = [handoffSessionRow()];
  const projection = await readFunnelPairing(
    "abcdefghjkmnpqrs2345",
    options(claimed),
  );
  assertEquals(projection.claimed, true);
});

Deno.test("claim maps the RPC contract onto typed errors", async () => {
  const success = emptyState();
  success.claimResult = {
    status: 200,
    body: funnelRow({
      claimed_at: "2026-08-03T21:00:00.000Z",
      claimed_by: "00000000-0000-4000-8000-000000000009",
    }),
  };
  const row = await claimFunnelSession({
    pairingCode: "abcdefghjkmnpqrs2345",
    claimedBy: "00000000-0000-4000-8000-000000000009",
  }, options(success));
  assertEquals(row.claimedBy, "00000000-0000-4000-8000-000000000009");

  const cases: Array<[string, string]> = [
    ["claim_funnel_session: unknown pairing code", "not_found"],
    ["claim_funnel_session: already claimed", "already_claimed"],
    ["claim_funnel_session: return window elapsed", "expired"],
    ["claim_funnel_session: claimer must be a member account", "claimer_not_member"],
  ];
  for (const [message, code] of cases) {
    const state = emptyState();
    state.claimResult = { status: 400, body: { message } };
    const rejection = await assertRejects(
      () =>
        claimFunnelSession({
          pairingCode: "abcdefghjkmnpqrs2345",
          claimedBy: "00000000-0000-4000-8000-000000000009",
        }, options(state)),
      FunnelSessionError,
    );
    assertEquals((rejection as FunnelSessionError).code, code);
  }
});

Deno.test("resume re-mints for the same owner and swaps the funnel's session", async () => {
  const state = emptyState();
  state.funnelRows = [funnelRow()];
  const minted = await resumeFunnelSession(
    { pairingCode: "abcdefghjkmnpqrs2345" },
    options(state),
  );
  assertEquals(
    minted.provisionalOwnerId,
    "00000000-0000-4000-8000-000000000001",
  );
  assertEquals(minted.session.ownerId, minted.provisionalOwnerId);
  assertMatch(minted.credential.plaintextToken, /^gx_[0-9a-f]{32}$/);
  assertEquals(minted.funnel.handoffSessionId, minted.session.id);

  const patch = state.requests.find((entry) => entry.method === "PATCH");
  assert(patch, "the funnel row swaps to the fresh session");
});

Deno.test("resume refuses claimed and window-elapsed funnels", async () => {
  const claimed = emptyState();
  claimed.funnelRows = [funnelRow({
    claimed_at: "2026-08-03T12:00:00.000Z",
    claimed_by: "00000000-0000-4000-8000-000000000009",
  })];
  const claimedRejection = await assertRejects(
    () =>
      resumeFunnelSession(
        { pairingCode: "abcdefghjkmnpqrs2345" },
        options(claimed),
      ),
    FunnelSessionError,
  );
  assertEquals(
    (claimedRejection as FunnelSessionError).code,
    "already_claimed",
  );

  const elapsed = emptyState();
  elapsed.funnelRows = [funnelRow({
    expires_at: "2026-08-03T20:59:59.000Z",
  })];
  const elapsedRejection = await assertRejects(
    () =>
      resumeFunnelSession(
        { pairingCode: "abcdefghjkmnpqrs2345" },
        options(elapsed),
      ),
    FunnelSessionError,
  );
  assertEquals((elapsedRejection as FunnelSessionError).code, "expired");
});

Deno.test("the reaper reports its count and fails closed", async () => {
  const state = emptyState();
  state.reapResult = { status: 200, body: 3 };
  assertEquals(await reapExpiredFunnelSessions(options(state)), 3);

  const failing = emptyState();
  failing.reapResult = { status: 500, body: { message: "boom" } };
  await assertRejects(
    () => reapExpiredFunnelSessions(options(failing)),
    FunnelSessionError,
    "reaper",
  );
});
