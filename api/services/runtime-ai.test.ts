import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import type { ResolvedInferenceRoute } from "./inference-route.ts";
import { createRoutedRuntimeAIService } from "./runtime-ai.ts";

function makeRoute(overrides: Partial<ResolvedInferenceRoute> = {}): ResolvedInferenceRoute {
  return {
    billingMode: "byok",
    provider: "deepseek",
    upstreamProvider: "deepseek",
    baseUrl: "https://api.deepseek.test",
    apiKey: "route-key",
    model: "deepseek-v4-pro",
    keySource: "user_byok",
    billingSource: "none",
    shouldRequireBalance: false,
    shouldDebitLight: false,
    ...overrides,
  };
}

Deno.test("runtime AI: BYOK route uses resolved provider model and skips Light debit", async () => {
  const previousFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};
  let debitCalled = false;

  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/rpc/debit_light")) {
        debitCalled = true;
      }
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        model: capturedBody.model,
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const service = createRoutedRuntimeAIService(makeRoute(), "user-1");
    const response = await service.call({
      model: "google/gemini-3.1-flash-lite-preview:nitro",
      messages: [{ role: "user", content: "hi" }],
    });

    assertEquals(capturedBody.model, "deepseek-v4-pro");
    assertEquals(response.content, "ok");
    assertEquals(response.usage.cost_light, 0);
    assertEquals(debitCalled, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

Deno.test("runtime AI: Light route debits usage after provider response", async () => {
  const previousFetch = globalThis.fetch;
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  let debitBody: Record<string, unknown> | null = null;

  try {
    globalWithEnv.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    };
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        return new Response(JSON.stringify({
          model: "openai/gpt-4o-mini",
          choices: [{ message: { content: "metered" } }],
          usage: { prompt_tokens: 100, completion_tokens: 200 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/rpc/debit_light")) {
        debitBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify([{
          old_balance: 100,
          new_balance: 99.9865,
          was_depleted: false,
          amount_debited: 0.0135,
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/billing_transactions")) {
        return new Response(null, { status: 204 });
      }

      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;

    const service = createRoutedRuntimeAIService(
      makeRoute({
        billingMode: "light",
        provider: "ultralight",
        upstreamProvider: "openrouter",
        baseUrl: "https://openrouter.test/api/v1",
        model: "deepseek/deepseek-v4-flash",
        keySource: "platform_openrouter",
        billingSource: "openrouter",
        shouldRequireBalance: true,
        shouldDebitLight: true,
      }),
      "user-1",
    );
    const response = await service.call({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    assertEquals(response.content, "metered");
    assertEquals(response.usage.cost_light, 0.0135);
    assertEquals(debitBody?.p_user_id, "user-1");
    assertEquals(debitBody?.p_amount_light, 0.0135);
    assertEquals(debitBody?.p_reason, "ai_chat");
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
});

Deno.test("runtime AI: Ultralight direct DeepSeek disables thinking and debits cache-aware usage", async () => {
  const previousFetch = globalThis.fetch;
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  let providerBody: Record<string, unknown> | null = null;
  let debitBody: Record<string, unknown> | null = null;

  try {
    globalWithEnv.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    };
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        providerBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          model: "deepseek-v4-flash",
          choices: [{ message: { content: "direct" } }],
          usage: {
            prompt_tokens: 1_000,
            prompt_cache_hit_tokens: 400,
            prompt_cache_miss_tokens: 600,
            completion_tokens: 1_000,
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/rpc/debit_light")) {
        debitBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify([{
          old_balance: 100,
          new_balance: 99.9635,
          was_depleted: false,
          amount_debited: 0.0365,
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes("/billing_transactions")) {
        return new Response(null, { status: 204 });
      }

      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;

    const service = createRoutedRuntimeAIService(
      makeRoute({
        billingMode: "light",
        provider: "ultralight",
        upstreamProvider: "deepseek",
        baseUrl: "https://api.deepseek.test",
        model: "deepseek-v4-flash",
        canonicalModelId: "ultralight/deepseek-v4-flash",
        billingModelId: "ultralight/deepseek-v4-flash",
        keySource: "platform_deepseek",
        billingSource: "platform_deepseek_direct",
        requestDefaults: { thinking: { type: "disabled" } },
        shouldRequireBalance: true,
        shouldDebitLight: true,
      }),
      "user-1",
    );
    const response = await service.call({
      model: "ultralight/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });

    assertEquals(providerBody?.model, "deepseek-v4-flash");
    assertEquals(providerBody?.thinking, { type: "disabled" });
    assertEquals(response.content, "direct");
    assertEquals(response.usage.cost_light, 0.0365);
    assertEquals(debitBody?.p_amount_light, 0.0365);
    assertEquals((debitBody?.p_metadata as Record<string, unknown>)?.billing_source, "platform_deepseek_direct");
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
});
