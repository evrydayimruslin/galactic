import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { handleApps } from "./apps.ts";
import { createRoutineActorToken } from "../services/routine-auth.ts";
import { createSandboxActorToken } from "../services/sandbox-actor.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "22222222-2222-4222-8222-222222222222";

Deno.test("legacy Apps REST rejects verified runtime actors before every route", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    AGENT_CALLER_SECRET: "apps-rest-sandbox-secret",
    ROUTINE_ACTOR_TOKEN_SECRET: "apps-rest-routine-secret",
  } as typeof globalThis.__env;

  try {
    const { token: routineToken } = await createRoutineActorToken({
      user: { id: USER_ID, email: "owner@example.com", tier: "pro" },
      routine: {
        id: "routine-1",
        composerAppId: APP_ID,
        handlerFunction: "tick",
      },
      routineRunId: "run-1",
      capabilities: [],
    });
    const { token: sandboxToken } = await createSandboxActorToken({
      user: { id: USER_ID, email: "owner@example.com", tier: "pro" },
      appId: APP_ID,
      allowedAppIds: [APP_ID],
      executionId: "execution-1",
    });

    const requests = [
      new Request("https://api.test/api/apps", {
        headers: { Authorization: `Bearer ${routineToken}` },
      }),
      // Cookie transport is rejected too; moving the same actor credential out
      // of Authorization must not turn it into an owner browser session.
      new Request("https://api.test/api/apps/me", {
        headers: {
          Cookie: `__Host-ul_session=${encodeURIComponent(sandboxToken)}`,
        },
      }),
    ];

    for (const request of requests) {
      const response = await handleApps(request);
      assertEquals(response.status, 403);
      const body = await response.json() as { error?: string };
      assertStringIncludes(
        body.error || "",
        "Agent runtime credentials cannot access",
      );
    }
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("legacy Apps REST preserves anonymous and non-actor public reads", async () => {
  for (
    const headers of [
      undefined,
      { Authorization: "Bearer gx_builder_key_shape" },
      { Authorization: "Bearer supabase.session.shape" },
      // An invalid actor-shaped token authenticates as nobody and therefore
      // keeps the existing anonymous behavior on genuinely public routes.
      { Authorization: "Bearer gxr_v1_invalid" },
    ]
  ) {
    const response = await handleApps(
      new Request("https://api.test/api/apps", { headers }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { apps: [] });
  }
});
