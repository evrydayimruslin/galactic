import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.210.0/assert/assert_string_includes.ts";

import { handlePlatformMcp, handleSkills } from "./platform-mcp.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const CORE_GUIDANCE = [
  "Post Ultralight URLs only when the link helps the user's current action",
  "`/install`",
  "`/wallet`",
  "`/settings`",
  "`/admin/tools/:id`",
  "`/tools/:slug`",
  "`/api/launch/openapi.json`",
  "`/api/skills`",
  "## Skills As Functions",
  "`skills_index(args: {})`",
  "`skill_reader(args: { skill_id: string })`",
  "Generated skills.md function docs are always free",
  "`ul.download({ name, description, policy: true })`",
  "custom code path for functions",
];

// First-class skills and widgets are off the launch surface: the docs must not
// teach skill pulls, skill pricing, or widget discovery actions.
const RETIRED_GUIDANCE = [
  "First-Class Skills",
  "pull_skill",
  "open_widget",
  "default_skill_pull_price_light",
  "default_free_skill_pulls",
  "skill_prices",
];

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function platformRequest(method: string, params?: unknown): Request {
  return new Request("https://ultralight.test/mcp/platform", {
    method: "POST",
    headers: {
      "Authorization": "Bearer supabase-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: method,
      method,
      params,
    }),
  });
}

async function readJsonRpc(
  response: Response,
): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function withPlatformDocsEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv || {}),
    BASE_URL: "https://ultralight.test",
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  } as typeof globalThis.__env;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.pathname === "/auth/v1/user") {
      return jsonResponse({
        id: USER_ID,
        email: "docs@example.test",
        user_metadata: { full_name: "Docs Tester" },
      });
    }

    if (url.pathname === "/rest/v1/users") {
      if (url.searchParams.get("select") === "tier") {
        return jsonResponse([{ tier: "pro" }]);
      }
      return jsonResponse([{ id: USER_ID }]);
    }

    if (url.pathname === "/rest/v1/pending_permissions") {
      return jsonResponse([]);
    }

    if (url.pathname === "/rest/v1/mcp_call_logs") {
      return jsonResponse([]);
    }

    if (url.pathname === "/rest/v1/apps") {
      return jsonResponse([]);
    }

    if (url.pathname === "/rest/v1/user_app_library") {
      return jsonResponse([]);
    }

    throw new Error(`Unexpected fetch in docs test: ${url.toString()}`);
  }) as typeof fetch;

  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

function assertCoreGuidance(text: string): void {
  for (const expected of CORE_GUIDANCE) {
    assertStringIncludes(text, expected);
  }
  for (const retired of RETIRED_GUIDANCE) {
    assertEquals(
      text.includes(retired),
      false,
      `docs must not mention "${retired}"`,
    );
  }
}

Deno.test("platform docs guidance is shared by initialize, resources/read, and GET /api/skills", async () => {
  await withPlatformDocsEnv(async () => {
    const initializePayload = await readJsonRpc(
      await handlePlatformMcp(platformRequest("initialize")),
    );
    const initializeInstructions =
      ((initializePayload.result as Record<string, unknown>).instructions ||
        "") as string;

    const resourcePayload = await readJsonRpc(
      await handlePlatformMcp(
        platformRequest("resources/read", {
          uri: "ultralight://platform/skills.md",
        }),
      ),
    );
    const resourceText =
      ((resourcePayload.result as Record<string, unknown>).contents as Array<
        { text?: string }
      >)[0].text || "";

    const skillsResponse = handleSkills(
      new Request("https://ultralight.test/api/skills"),
    );
    const skillsText = await skillsResponse.text();

    assertEquals(skillsResponse.status, 200);
    assertStringIncludes(
      skillsResponse.headers.get("Content-Type") || "",
      "text/markdown",
    );

    assertCoreGuidance(initializeInstructions);
    assertCoreGuidance(resourceText);
    assertCoreGuidance(skillsText);
  });
});
