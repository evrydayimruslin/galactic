import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { LAUNCH_API_ROUTES } from "../../shared/contracts/launch.ts";
import { handleLaunch, toLaunchFleetAgentCapacity } from "./launch.ts";

const TEST_API_TOKEN = `ul_${"a".repeat(32)}`;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiTokenAuthMock(): typeof fetch {
  return (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ||
      (input instanceof Request ? input.method : "GET");
    if (url.startsWith("https://supabase.test/rest/v1/user_api_tokens?")) {
      if (method === "PATCH") return new Response(null, { status: 204 });
      return jsonResponse({
        id: "token-1",
        user_id: "user-1",
        token_hash: null,
        token_salt: null,
        plaintext_token: TEST_API_TOKEN,
        scopes: ["*"],
        app_ids: null,
        function_names: null,
        expires_at: null,
      });
    }
    if (url.startsWith("https://supabase.test/rest/v1/users?")) {
      return jsonResponse({
        id: "user-1",
        email: "agent@example.com",
        tier: "free",
        provisional: false,
        last_active_at: null,
      });
    }
    return jsonResponse([]);
  }) as typeof fetch;
}

Deno.test("launch contract exposes Fleet and Agent-filterable Alerts routes", () => {
  assert(LAUNCH_API_ROUTES.includes("GET /api/launch/fleet"));
  assert(LAUNCH_API_ROUTES.includes("GET /api/launch/notifications"));
  assert(LAUNCH_API_ROUTES.includes("PATCH /api/launch/notifications"));
});

Deno.test("Fleet maps paid percentage-only capacity without raw allowances", () => {
  const capacity = toLaunchFleetAgentCapacity({
    agent_id: "agent-1",
    capacity_state: "low",
    capacity_burst_state: "available",
    capacity_weekly_state: "low",
    capacity_burst_resets_at: "2026-07-17T15:00:00.000Z",
    capacity_weekly_resets_at: "2026-07-20T10:00:00.000Z",
    capacity_next_eligible_at: null,
    capacity_cap_basis_points: 2500,
    capacity_burst_used_percent: 5,
    capacity_weekly_used_percent: 20,
  }, "2026-07-17T12:00:00.000Z");
  assertEquals(capacity?.capPercent, 25);
  assertEquals(capacity?.burst.shareUsedPercent, 5);
  assertEquals(capacity?.burst.capUsedPercent, 20);
  assertEquals(capacity?.weekly.shareUsedPercent, 20);
  assertEquals(capacity?.weekly.capUsedPercent, 80);
  assertEquals(capacity?.generatedAt, "2026-07-17T12:00:00.000Z");
});

Deno.test("Fleet keeps Free capacity qualitative", () => {
  const capacity = toLaunchFleetAgentCapacity({
    agent_id: "agent-free",
    capacity_state: "waiting",
    capacity_burst_state: "waiting",
    capacity_weekly_state: "available",
    capacity_burst_resets_at: "2026-07-17T15:00:00.000Z",
    capacity_weekly_resets_at: "2026-07-20T10:00:00.000Z",
    capacity_next_eligible_at: "2026-07-17T15:00:00.000Z",
    capacity_cap_basis_points: null,
    capacity_burst_used_percent: null,
    capacity_weekly_used_percent: null,
  });
  assertEquals(capacity?.state, "waiting");
  assertEquals(capacity?.capPercent, null);
  assertEquals(capacity?.burst.shareUsedPercent, undefined);
  assertEquals(capacity?.burst.capUsedPercent, undefined);
  assertEquals(capacity?.nextEligibleAt, "2026-07-17T15:00:00.000Z");
});

Deno.test({
  name: "launch Fleet rejects API-token callers before reading owner data",
  // API-token auth uses a module-cached Supabase client with a timer that can
  // outlive this focused test, matching the established launch auth tests.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousEnv = globalThis.__env;
    const previousFetch = globalThis.fetch;
    globalThis.__env = {
      ...(previousEnv || {}),
      BASE_URL: "https://ultralight.test",
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    } as typeof globalThis.__env;
    globalThis.fetch = apiTokenAuthMock();
    try {
      const response = await handleLaunch(
        new Request("https://ultralight.test/api/launch/fleet", {
          headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
        }),
      );
      assertEquals(response.status, 403);
      const body = await response.json() as { error?: string };
      assertEquals(body.error, "Fleet access requires an account session");
    } finally {
      globalThis.__env = previousEnv;
      globalThis.fetch = previousFetch;
    }
  },
});
