import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  authenticateRequest,
  type PendingPermissionRow,
  resolvePendingPermissionRows,
  verifySupabaseAccessToken,
} from "./request-auth.ts";
import { createRoutineActorToken } from "./routine-auth.ts";
import {
  AUTH_SERVICE_UNAVAILABLE,
  classifyPublicAuthenticationError,
} from "./auth-errors.ts";

const HANDOFF_TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  PRO_SUBSCRIPTION_REQUIRED: "1",
};

const HANDOFF_OWNER_ID = "10000000-0000-4000-8000-000000000001";
const HANDOFF_TARGET_ID = "10000000-0000-4000-8000-000000000002";
const HANDOFF_CANDIDATE_SET_ID = "10000000-0000-4000-8000-000000000003";
const HANDOFF_DESCRIPTION_DIGEST = "d".repeat(64);

interface RequestAuthTokenFixture {
  plaintext: string;
  tokenId: string;
  scopes: string[];
  appIds: string[] | null;
}

interface RequestAuthTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  token_salt: string;
  plaintext_token: null;
  scopes: string[];
  app_ids: string[] | null;
  function_names: null;
  expires_at: string;
}

async function requestAuthTokenRow(
  fixture: RequestAuthTokenFixture,
  expiresAt: string,
): Promise<RequestAuthTokenRow> {
  const tokenSalt = fixture.plaintext.slice(3);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(tokenSalt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(fixture.plaintext),
  );
  const tokenHash = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    id: fixture.tokenId,
    user_id: HANDOFF_OWNER_ID,
    token_hash: tokenHash,
    token_salt: tokenSalt,
    plaintext_token: null,
    scopes: fixture.scopes,
    app_ids: fixture.appIds,
    function_names: null,
    expires_at: expiresAt,
  };
}

function builderHandoffRpcRow(input: {
  tokenId: string;
  status?: "connected" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
  terminalAt?: string;
}): Record<string, unknown> {
  const status = input.status ?? "connected";
  const terminal = status === "expired" || status === "revoked";
  const terminalAt = input.terminalAt ?? input.expiresAt;
  return {
    id: input.tokenId,
    token_id: input.tokenId,
    owner_id: HANDOFF_OWNER_ID,
    candidate_set_id: HANDOFF_CANDIDATE_SET_ID,
    intent: "agent",
    target_app_id: HANDOFF_TARGET_ID,
    status,
    status_version: terminal ? 2 : 1,
    lineage_revision: 0,
    description_sha256: HANDOFF_DESCRIPTION_DIGEST,
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
    base_version: null,
    base_source_hash: null,
    base_release_digest: null,
    base_state_digest: null,
    base_release_generation: null,
    created_at: input.createdAt,
    expires_at: input.expiresAt,
    updated_at: terminal ? terminalAt : input.createdAt,
    connected_at: terminal ? null : input.createdAt,
    staged_at: null,
    tested_at: null,
    uploaded_at: null,
    promoted_at: null,
    credential_revoked_at: terminal ? terminalAt : null,
    terminal_at: terminal ? terminalAt : null,
  };
}

function bearerRequest(path: string, token: string): Request {
  return new Request(`https://api.example.test${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

Deno.test("request auth: exposes Supabase email confirmation state", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_ANON_KEY: "anon-key",
  } as typeof globalThis.__env;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: "user-1",
          email: "person@example.com",
          email_confirmed_at: "2026-07-30T17:30:00.000Z",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    )) as typeof fetch;

  try {
    const user = await verifySupabaseAccessToken("access-token");
    assertEquals(user?.emailConfirmedAt, "2026-07-30T17:30:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("request auth: resolvePendingPermissionRows normalizes legacy prefixed function names", () => {
  const pendingRows: PendingPermissionRow[] = [
    {
      app_id: "app-1",
      granted_by_user_id: "owner-1",
      function_name: "demo-app_search",
      allowed: true,
      allowed_args: { q: ["launch"] },
    },
    {
      app_id: "app-2",
      app_slug: "notes",
      granted_by_user_id: "owner-2",
      function_name: "notes_write",
      allowed: false,
    },
    {
      app_id: "app-3",
      granted_by_user_id: "owner-3",
      function_name: "list",
      allowed: true,
      allowed_args: null,
    },
  ];

  assertEquals(
    resolvePendingPermissionRows(pendingRows, "user-123", {
      "app-1": "demo-app",
    }),
    [
      {
        app_id: "app-1",
        granted_to_user_id: "user-123",
        granted_by_user_id: "owner-1",
        function_name: "search",
        allowed: true,
        allowed_args: { q: ["launch"] },
      },
      {
        app_id: "app-2",
        granted_to_user_id: "user-123",
        granted_by_user_id: "owner-2",
        function_name: "write",
        allowed: false,
      },
      {
        app_id: "app-3",
        granted_to_user_id: "user-123",
        granted_by_user_id: "owner-3",
        function_name: "list",
        allowed: true,
        allowed_args: null,
      },
    ],
  );
});

Deno.test("request auth: accepts scoped routine actor bearer tokens", async () => {
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  globalWithEnv.__env = {
    ...previousEnv,
    ROUTINE_ACTOR_TOKEN_SECRET: "routine-actor-test-secret",
  };

  try {
    const { token } = await createRoutineActorToken(
      {
        user: {
          id: "user-1",
          email: "manager@example.com",
          tier: "pro",
        },
        routine: {
          id: "routine-1",
          composerAppSlug: "email-ops",
          handlerFunction: "draft_followups",
        },
        routineRunId: "run-1",
        traceId: "trace-1",
        tokenId: "token-1",
        capabilities: [
          {
            app_id: "crm-app-id",
            app_ref: "crm",
            function_name: "log_lead",
            access: "write",
            approved: true,
          },
        ],
      },
      {
        secret: "routine-actor-test-secret",
      },
    );

    const authUser = await authenticateRequest(
      new Request("https://api.example.test/mcp/email-ops", {
        headers: { "Authorization": `Bearer ${token}` },
      }),
      "bearer_only",
    );

    assertEquals(authUser.authSource, "routine_actor");
    assertEquals(authUser.id, "user-1");
    assertEquals(authUser.email, "manager@example.com");
    assertEquals(authUser.tier, "pro");
    assertEquals(authUser.tokenId, "token-1");
    assertEquals(authUser.tokenAppIds, ["crm", "crm-app-id", "email-ops"]);
    assertEquals(authUser.tokenFunctionNames, [
      "draft_followups",
      "log_lead",
    ]);
    assertEquals(authUser.scopes, ["apps:call"]);
    assertEquals(authUser.routineContext, {
      routineId: "routine-1",
      routineRunId: "run-1",
      traceId: "trace-1",
    });
    assertEquals(authUser.routineCapabilityCeiling, [
      {
        app_id: "crm-app-id",
        app_ref: "crm",
        function_name: "log_lead",
        access: "write",
        required: true,
      },
    ]);
    assertEquals(authUser.routineActor, {
      tokenId: "token-1",
      routineId: "routine-1",
      routineRunId: "run-1",
      traceId: "trace-1",
      composerAppSlug: "email-ops",
      handlerFunction: "draft_followups",
      capabilities: [
        {
          app_id: "crm-app-id",
          app_ref: "crm",
          function_name: "log_lead",
          access: "write",
          required: true,
        },
      ],
    });
  } finally {
    globalWithEnv.__env = previousEnv;
  }
});

Deno.test({
  name:
    "request auth: durable builder handoffs are exact-endpoint, server-mapped, and fail closed",
  // tokens.ts owns a process-lifetime Supabase client and verdict cache.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const handoffScopes = [
      "apps:read",
      "agents:build",
      "handoff:agent",
    ];
    const fixtures: Record<
      "valid" | "forged" | "ordinary" | "expired" | "revoked",
      RequestAuthTokenFixture
    > = {
      valid: {
        plaintext: `gx_${"1".repeat(32)}`,
        tokenId: "20000000-0000-4000-8000-000000000001",
        scopes: handoffScopes,
        appIds: [HANDOFF_TARGET_ID],
      },
      forged: {
        plaintext: `gx_${"2".repeat(32)}`,
        tokenId: "20000000-0000-4000-8000-000000000002",
        scopes: handoffScopes,
        appIds: [HANDOFF_TARGET_ID],
      },
      ordinary: {
        plaintext: `gx_${"3".repeat(32)}`,
        tokenId: "20000000-0000-4000-8000-000000000003",
        scopes: ["apps:read"],
        appIds: null,
      },
      expired: {
        plaintext: `gx_${"4".repeat(32)}`,
        tokenId: "20000000-0000-4000-8000-000000000004",
        scopes: handoffScopes,
        appIds: [HANDOFF_TARGET_ID],
      },
      revoked: {
        plaintext: `gx_${"5".repeat(32)}`,
        tokenId: "20000000-0000-4000-8000-000000000005",
        scopes: handoffScopes,
        appIds: [HANDOFF_TARGET_ID],
      },
    };

    const now = Date.now();
    const activeCreatedAt = new Date(now - 60_000).toISOString();
    const activeExpiresAt = new Date(now + 3_540_000).toISOString();
    const expiredCreatedAt = new Date(now - 7_200_000).toISOString();
    const expiredExpiresAt = new Date(now - 3_600_000).toISOString();
    const tokenExpiresAt = new Date(now + 3_600_000).toISOString();
    const tokenRows = new Map<string, RequestAuthTokenRow>();
    for (const fixture of Object.values(fixtures)) {
      tokenRows.set(
        fixture.plaintext.slice(0, 8),
        await requestAuthTokenRow(fixture, tokenExpiresAt),
      );
    }

    const rpcRows = new Map<string, Record<string, unknown>>([
      [
        fixtures.valid.tokenId,
        builderHandoffRpcRow({
          tokenId: fixtures.valid.tokenId,
          createdAt: activeCreatedAt,
          expiresAt: activeExpiresAt,
        }),
      ],
      [
        fixtures.expired.tokenId,
        builderHandoffRpcRow({
          tokenId: fixtures.expired.tokenId,
          status: "expired",
          createdAt: expiredCreatedAt,
          expiresAt: expiredExpiresAt,
        }),
      ],
      [
        fixtures.revoked.tokenId,
        builderHandoffRpcRow({
          tokenId: fixtures.revoked.tokenId,
          status: "revoked",
          createdAt: activeCreatedAt,
          expiresAt: activeExpiresAt,
          terminalAt: new Date(now).toISOString(),
        }),
      ],
    ]);

    const previousEnv = globalThis.__env;
    const previousFetch = globalThis.fetch;
    const tokenLookups = new Map<string, number>();
    let durableAuthCalls = 0;
    let durableAuthUnavailable = false;
    let proEntitlementCalls = 0;

    globalThis.__env = {
      ...(previousEnv || {}),
      ...HANDOFF_TEST_ENV,
    } as typeof globalThis.__env;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = input instanceof Request
        ? input.method
        : (init?.method ?? "GET");

      if (url.pathname.endsWith("/rest/v1/user_api_tokens")) {
        if (method === "PATCH") {
          return new Response(null, { status: 204 });
        }
        const prefix = url.searchParams.get("token_prefix")?.replace(
          /^eq\./,
          "",
        ) ?? "";
        tokenLookups.set(prefix, (tokenLookups.get(prefix) ?? 0) + 1);
        const row = tokenRows.get(prefix);
        return row
          ? new Response(JSON.stringify(row), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
          : new Response(JSON.stringify({ message: "no rows" }), {
            status: 406,
            headers: { "Content-Type": "application/json" },
          });
      }

      if (url.pathname.endsWith("/rest/v1/users")) {
        return new Response(
          JSON.stringify({
            id: HANDOFF_OWNER_ID,
            email: "builder@example.com",
            tier: "free",
            provisional: false,
            last_active_at: null,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (
        url.pathname.endsWith(
          "/rest/v1/rpc/authenticate_builder_handoff_session",
        )
      ) {
        durableAuthCalls += 1;
        if (durableAuthUnavailable) {
          return new Response(
            JSON.stringify({ message: "database secret=must-not-leak" }),
            {
              status: 503,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        const bodyText = input instanceof Request
          ? await input.clone().text()
          : String(init?.body ?? "");
        const body = JSON.parse(bodyText) as { p_token_id?: string };
        const row = body.p_token_id ? rpcRows.get(body.p_token_id) : undefined;
        return new Response(JSON.stringify(row ? [row] : []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname.endsWith("/rest/v1/account_entitlements")) {
        proEntitlementCalls += 1;
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ message: "unexpected request" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const authenticated = await authenticateRequest(
        bearerRequest("/mcp/platform", fixtures.valid.plaintext),
        "bearer_only",
      );
      assertEquals(authenticated.authSource, "builder_handoff");
      assertEquals(authenticated.id, HANDOFF_OWNER_ID);
      assertEquals(authenticated.email, "builder@example.com");
      assertEquals(authenticated.tier, "free");
      assertEquals(authenticated.tokenId, fixtures.valid.tokenId);
      assertEquals(authenticated.tokenAppIds, [HANDOFF_TARGET_ID]);
      assertEquals(authenticated.scopes, handoffScopes);
      assertEquals(authenticated.builderHandoff, {
        id: fixtures.valid.tokenId,
        candidateSetId: HANDOFF_CANDIDATE_SET_ID,
        intent: "agent",
        status: "connected",
        targetAppId: null,
        boundAppId: HANDOFF_TARGET_ID,
        bundleId: null,
        sourceHash: null,
        attestationId: null,
        testAttestationDigest: null,
        documentDigest: null,
        reportDigest: null,
        releaseDigest: null,
        baseVersion: null,
        baseSourceHash: null,
        baseReleaseDigest: null,
        baseStateDigest: null,
      });
      assertEquals(durableAuthCalls, 1);
      assertEquals(
        proEntitlementCalls,
        0,
        "a valid mapped handoff bypasses membership only on platform MCP",
      );

      await assertRejects(
        () =>
          authenticateRequest(
            bearerRequest("/mcp/platform", fixtures.forged.plaintext),
            "bearer_only",
          ),
        Error,
        "Invalid or expired builder handoff credential",
      );
      assertEquals(durableAuthCalls, 2);
      assertEquals(proEntitlementCalls, 0);

      for (const path of ["/api/apps", "/mcp/platform/"]) {
        const callsBefore = durableAuthCalls;
        await assertRejects(
          () =>
            authenticateRequest(
              bearerRequest(path, fixtures.valid.plaintext),
              "bearer_only",
            ),
          Error,
          "Invalid or expired builder handoff credential",
        );
        assertEquals(
          durableAuthCalls,
          callsBefore,
          "off-endpoint handoff credentials must not reach durable auth",
        );
      }
      assertEquals(proEntitlementCalls, 0);

      const ordinary = await authenticateRequest(
        bearerRequest("/mcp/platform", fixtures.ordinary.plaintext),
        "bearer_only",
      );
      assertEquals(ordinary.authSource, "api_token");
      assertEquals(
        proEntitlementCalls,
        0,
        "authentication classifies ordinary API tokens before route policy and entitlement",
      );

      for (const key of ["expired", "revoked"] as const) {
        await assertRejects(
          () =>
            authenticateRequest(
              bearerRequest("/mcp/platform", fixtures[key].plaintext),
              "bearer_only",
            ),
          Error,
          "Invalid or expired builder handoff credential",
        );
        assertEquals(
          tokenLookups.get(fixtures[key].plaintext.slice(0, 8)),
          1,
          `${key} durable state must fail after normal token verification`,
        );
      }
      assertEquals(durableAuthCalls, 4);
      assertEquals(
        proEntitlementCalls,
        0,
        "credential authentication never hides terminal handoff state behind billing",
      );

      durableAuthUnavailable = true;
      let unavailable: unknown;
      try {
        await authenticateRequest(
          bearerRequest("/mcp/platform", fixtures.valid.plaintext),
          "bearer_only",
        );
      } catch (error) {
        unavailable = error;
      }
      assertEquals(classifyPublicAuthenticationError(unavailable), {
        status: 503,
        type: AUTH_SERVICE_UNAVAILABLE,
        message: "Authentication service is temporarily unavailable",
      });
      assertEquals(durableAuthCalls, 5);
    } finally {
      globalThis.fetch = previousFetch;
      globalThis.__env = previousEnv;
    }
  },
});
