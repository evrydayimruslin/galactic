import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import type { ResolvedInferenceRoute } from "./inference-route.ts";
import { resolveContext } from "./context-resolver.ts";

function makeRoute(overrides: Partial<ResolvedInferenceRoute> = {}): ResolvedInferenceRoute {
  return {
    billingMode: "byok",
    provider: "deepseek",
    upstreamProvider: "deepseek",
    baseUrl: "https://api.deepseek.test",
    apiKey: "ds-key",
    model: "deepseek-v4-pro",
    keySource: "user_byok",
    billingSource: "none",
    shouldRequireBalance: false,
    shouldDebitLight: false,
    ...overrides,
  };
}

Deno.test("context resolver uses the resolved inference route instead of OpenRouter env", async () => {
  const previousFetch = globalThis.fetch;
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  let capturedUrl = "";
  let capturedAuth = "";
  let capturedBody: Record<string, unknown> = {};

  try {
    globalWithEnv.__env = {
      ...(previousEnv || {}),
      FN_INDEX: {
        get: async (key: string) => {
          if (key === "user:user-1") {
            return {
              functions: {
                app_notes_search: {
                  appId: "app-1",
                  appSlug: "notes",
                  fnName: "search",
                  description: "[Notes] Search notes",
                  params: { query: { type: "string", required: true } },
                  returns: "Note[]",
                  conventions: ["tone: concise"],
                  dependsOn: [],
                },
              },
              widgets: [],
              types: "",
              updatedAt: "2026-04-24T00:00:00Z",
            };
          }
          return null;
        },
      },
    };
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedAuth = new Headers(init?.headers).get("authorization") || "";
      capturedBody = JSON.parse(String(init?.body));

      return new Response(JSON.stringify({
        model: "deepseek-v4-pro",
        choices: [{
          message: {
            content: JSON.stringify({
              functions: ["app_notes_search"],
              entities: [],
              conventions: [{ appName: "notes", key: "tone", value: "concise" }],
              modelSuggestion: "flash",
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const context = await resolveContext(
      "find Sarah notes",
      "user-1",
      "user@example.com",
      undefined,
      makeRoute(),
    );

    assertEquals(capturedUrl, "https://api.deepseek.test/chat/completions");
    assertEquals(capturedAuth, "Bearer ds-key");
    assertEquals(capturedBody.model, "deepseek-v4-pro");
    assertEquals(context.functions.map((fn) => fn.name), ["app_notes_search"]);
    assertEquals(context.conventions, [{ appName: "notes", key: "tone", value: "concise" }]);
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
});
