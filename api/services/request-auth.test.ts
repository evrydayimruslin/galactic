import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  authenticateRequest,
  type PendingPermissionRow,
  resolvePendingPermissionRows,
} from "./request-auth.ts";
import { createRoutineActorToken } from "./routine-auth.ts";

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
