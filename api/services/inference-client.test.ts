import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import type { ResolvedInferenceRoute } from "./inference-route.ts";
import {
  buildInferenceRequestBody,
  buildInferenceHeaders,
  fetchInferenceChatCompletion,
  getInferenceChatCompletionsUrl,
  selectInferenceModel,
  supportsInferenceRealtime,
} from "./inference-client.ts";
import {
  DEEPSEEK_THINKING_DISABLED_REQUEST_DEFAULTS,
  ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
} from "./platform-inference-models.ts";

function makeRoute(overrides: Partial<ResolvedInferenceRoute> = {}): ResolvedInferenceRoute {
  return {
    billingMode: "light",
    provider: "ultralight",
    upstreamProvider: "openrouter",
    baseUrl: "https://openrouter.test/api/v1/",
    apiKey: "route-key",
    model: "deepseek/deepseek-v4-flash",
    keySource: "platform_openrouter",
    billingSource: "openrouter",
    shouldRequireBalance: true,
    shouldDebitLight: true,
    ...overrides,
  };
}

Deno.test("inference client: Light mode honors requested model overrides", () => {
  const route = makeRoute();
  assertEquals(selectInferenceModel(route, "openai/gpt-4o-mini"), "openai/gpt-4o-mini");
  assertEquals(selectInferenceModel(route, ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL), "deepseek/deepseek-v4-pro");
  assertEquals(selectInferenceModel(route, "  "), "deepseek/deepseek-v4-flash");
});

Deno.test("inference client: BYOK mode stays on the resolved provider model", () => {
  const route = makeRoute({
    billingMode: "byok",
    provider: "deepseek",
    upstreamProvider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "ds-key",
    model: "deepseek-v4-pro",
    keySource: "user_byok",
    billingSource: "none",
    shouldRequireBalance: false,
    shouldDebitLight: false,
  });

  assertEquals(selectInferenceModel(route, "google/gemini-3.1-flash-lite-preview:nitro"), "deepseek-v4-pro");
});

Deno.test("inference client: realtime is available only on OpenAI BYOK routes", () => {
  assertEquals(supportsInferenceRealtime(makeRoute({
    billingMode: "byok",
    provider: "openai",
    upstreamProvider: "openai",
  })), true);
  assertEquals(supportsInferenceRealtime(makeRoute({
    billingMode: "byok",
    provider: "deepseek",
    upstreamProvider: "deepseek",
  })), false);
  assertEquals(supportsInferenceRealtime(makeRoute()), false);
});

Deno.test("inference client: Ultralight direct DeepSeek maps canonical models to upstream ids", () => {
  const route = makeRoute({
    upstreamProvider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    canonicalModelId: "ultralight/deepseek-v4-flash",
    billingModelId: "ultralight/deepseek-v4-flash",
    keySource: "platform_deepseek",
    billingSource: "platform_deepseek_direct",
    requestDefaults: DEEPSEEK_THINKING_DISABLED_REQUEST_DEFAULTS,
  });

  assertEquals(selectInferenceModel(route, ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL), "deepseek-v4-pro");
  assertEquals(selectInferenceModel(route, "openai/gpt-4o-mini"), "deepseek-v4-flash");
  assertEquals(
    buildInferenceRequestBody(route, {
      model: ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
      thinking: { type: "enabled" },
      messages: [],
    }),
    {
      model: "deepseek-v4-pro",
      thinking: { type: "disabled" },
      messages: [],
    },
  );
});

Deno.test("inference client: builds OpenAI-compatible chat requests from the route", async () => {
  const previousFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders = new Headers();
  let capturedBody: Record<string, unknown> = {};

  try {
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const route = makeRoute();
    const response = await fetchInferenceChatCompletion(
      route,
      { model: "deepseek/deepseek-v4-flash", messages: [] },
      { title: "Ultralight Test", referer: "https://ultralight.test" },
    );

    assertEquals(response.status, 200);
    assertEquals(capturedUrl, getInferenceChatCompletionsUrl(route));
    assertEquals(capturedHeaders.get("authorization"), "Bearer route-key");
    assertEquals(capturedHeaders.get("content-type"), "application/json");
    assertEquals(capturedHeaders.get("http-referer"), "https://ultralight.test");
    assertEquals(capturedHeaders.get("x-title"), "Ultralight Test");
    assertEquals(capturedBody.model, "deepseek/deepseek-v4-flash");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

Deno.test("inference client: strips trailing base URL slash", () => {
  assertEquals(
    getInferenceChatCompletionsUrl(makeRoute({ baseUrl: "https://api.x.ai/v1/" })),
    "https://api.x.ai/v1/chat/completions",
  );
});
