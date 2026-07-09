import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.210.0/assert/assert_string_includes.ts";
import type { ResolvedInferenceRoute } from "./inference-route.ts";
import { createRoutedRuntimeAIService, createRuntimeAIContext } from "./runtime-ai.ts";

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
          new_balance: 99.9851,
          was_depleted: false,
          amount_debited: 0.0149,
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
    // gpt-4o-mini fallback rate (0.15/0.6 per M) × 100 Light/$ × 1.1 markup.
    assertEquals(response.usage.cost_light, 0.0149);
    assertEquals(debitBody?.p_user_id, "user-1");
    assertEquals(debitBody?.p_amount_light, 0.0149);
    assertEquals(debitBody?.p_reason, "ai_chat");
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
});

Deno.test("runtime AI: Galactic direct DeepSeek disables thinking and debits cache-aware usage", async () => {
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

function makeCreditsRoute(
  overrides: Partial<ResolvedInferenceRoute> = {},
): ResolvedInferenceRoute {
  return makeRoute({
    billingMode: "light",
    provider: "ultralight",
    upstreamProvider: "openrouter",
    baseUrl: "https://openrouter.test/api/v1",
    model: "deepseek/deepseek-v4-flash",
    keySource: "platform_openrouter",
    billingSource: "openrouter",
    shouldRequireBalance: true,
    shouldDebitLight: true,
    ...overrides,
  });
}

const testUser = { id: "user-1", email: "user-1@example.test" };

Deno.test("runtime AI context: BYOK route skips the balance gate and is not blocked", async () => {
  let balanceCalls = 0;

  const context = await createRuntimeAIContext(testUser, {
    resolveRoute: async () => makeRoute(),
    checkBalance: async () => {
      balanceCalls++;
      return 0;
    },
  });

  assertEquals(balanceCalls, 0);
  assertEquals(context.route?.provider, "deepseek");
  assertEquals(context.resolvedRoute?.shouldRequireBalance, false);
  assertEquals(context.userApiKey, "route-key");
});

Deno.test("runtime AI context: credits route below minimum balance is blocked pre-call", async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;

    const context = await createRuntimeAIContext(testUser, {
      resolveRoute: async () => makeCreditsRoute(),
      checkBalance: async () => 12.5,
    });

    assertEquals(context.route, null);
    assertEquals(context.resolvedRoute, null);
    assertEquals(context.userApiKey, null);
    // The reason must ride the context so the dynamic-worker AI binding can
    // surface the same message as the in-process service path.
    assertStringIncludes(context.unavailableReason ?? "", "credits");
    assertStringIncludes(context.unavailableReason ?? "", "BYOK");

    const response = await context.aiService.call({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });

    assertStringIncludes(response.error ?? "", "credits");
    assertStringIncludes(response.error ?? "", "current balance: 12.5");
    assertStringIncludes(response.error ?? "", "BYOK");
    assertEquals(response.content, "");
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

Deno.test("runtime AI context: credits route at the minimum balance proceeds", async () => {
  let balanceCalls = 0;

  const context = await createRuntimeAIContext(testUser, {
    resolveRoute: async () => makeCreditsRoute(),
    checkBalance: async () => {
      balanceCalls++;
      return 50;
    },
  });

  assertEquals(balanceCalls, 1);
  assertEquals(context.route?.provider, "ultralight");
  assertEquals(context.route?.shouldDebitLight, true);
  assertEquals(context.resolvedRoute?.shouldRequireBalance, true);
  assertEquals(context.userApiKey, "route-key");
});

Deno.test("runtime AI context: balance check failure fails open and proceeds un-gated", async () => {
  const previousWarn = console.warn;
  let warned = false;

  try {
    console.warn = () => {
      warned = true;
    };

    const context = await createRuntimeAIContext(testUser, {
      resolveRoute: async () => makeCreditsRoute(),
      checkBalance: async () => {
        throw new Error("Failed to query user balance");
      },
    });

    assertEquals(warned, true);
    assertEquals(context.route?.provider, "ultralight");
    assertEquals(context.resolvedRoute?.shouldRequireBalance, true);
    assertEquals(context.userApiKey, "route-key");
  } finally {
    console.warn = previousWarn;
  }
});

Deno.test("runtime AI: metered call is refused per-call when balance is below the floor", async () => {
  const previousFetch = globalThis.fetch;
  let providerCalled = false;
  let debitCalled = false;
  try {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/chat/completions")) providerCalled = true;
      if (url.includes("/rpc/debit_light")) debitCalled = true;
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;

    // Injected balance below CHAT_MIN_BALANCE_LIGHT (25) — the per-call gate must
    // refuse BEFORE any billable upstream inference is generated.
    const service = createRoutedRuntimeAIService(
      makeCreditsRoute(),
      "user-1",
      async () => 10,
    );
    const response = await service.call({
      messages: [{ role: "user", content: "hi" }],
    });

    assertEquals(response.content, "");
    assertStringIncludes(response.error ?? "", "requires at least");
    assertEquals(providerCalled, false);
    assertEquals(debitCalled, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

Deno.test("runtime AI: metered call withholds content when the debit depletes the wallet", async () => {
  const previousFetch = globalThis.fetch;
  const globalWithEnv = globalThis as typeof globalThis & { __env?: Record<string, unknown> };
  const previousEnv = globalWithEnv.__env;
  try {
    globalWithEnv.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    };
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        return new Response(JSON.stringify({
          model: "deepseek/deepseek-v4-flash",
          choices: [{ message: { content: "should-be-withheld" } }],
          usage: { prompt_tokens: 100, completion_tokens: 200 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/rpc/debit_light")) {
        // Partial/depleting debit: the buyer could not fully cover the call.
        return new Response(JSON.stringify([{
          old_balance: 0.01,
          new_balance: 0,
          was_depleted: true,
          amount_debited: 0.01,
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/billing_transactions")) return new Response(null, { status: 204 });
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;

    // Balance is above the floor at call time, but the debit depletes it — the
    // content of THIS call must be withheld.
    const service = createRoutedRuntimeAIService(
      makeCreditsRoute(),
      "user-1",
      async () => 1000,
    );
    const response = await service.call({
      messages: [{ role: "user", content: "hi" }],
    });

    assertEquals(response.content, "");
    assertStringIncludes(response.error ?? "", "Insufficient credits");
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
});

Deno.test("runtime AI: metered call with ample balance passes the gate and returns content", async () => {
  const previousFetch = globalThis.fetch;
  const globalWithEnv = globalThis as typeof globalThis & { __env?: Record<string, unknown> };
  const previousEnv = globalWithEnv.__env;
  try {
    globalWithEnv.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    };
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        return new Response(JSON.stringify({
          model: "deepseek/deepseek-v4-flash",
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 100, completion_tokens: 200 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/rpc/debit_light")) {
        return new Response(JSON.stringify([{
          old_balance: 1000,
          new_balance: 999.98,
          was_depleted: false,
          amount_debited: 0.02,
        }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/billing_transactions")) return new Response(null, { status: 204 });
      return new Response("unexpected fetch", { status: 500 });
    }) as typeof fetch;

    const service = createRoutedRuntimeAIService(
      makeCreditsRoute(),
      "user-1",
      async () => 1000,
    );
    const response = await service.call({
      messages: [{ role: "user", content: "hi" }],
    });

    assertEquals(response.content, "ok");
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
});

Deno.test("runtime AI: a pinned route model beats the dev's per-call model", async () => {
  const previousFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.includes("/chat/completions")) {
        return new Response("unexpected fetch", { status: 500 });
      }
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        model: capturedBody.model,
        choices: [{ message: { content: "pinned" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    // Light route with a pinned per-function override model; billing flags off
    // to isolate model selection from the debit path.
    const service = createRoutedRuntimeAIService(
      makeRoute({
        billingMode: "light",
        provider: "ultralight",
        upstreamProvider: "openrouter",
        baseUrl: "https://openrouter.test/api/v1",
        model: "anthropic/claude-x",
        keySource: "platform_openrouter",
        billingSource: "openrouter",
        shouldRequireBalance: false,
        shouldDebitLight: false,
        modelPinned: true,
      }),
      "user-1",
    );
    const response = await service.call({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    assertEquals(capturedBody.model, "anthropic/claude-x");
    assertEquals(response.content, "pinned");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

Deno.test("runtime AI context: a per-function override selection pins the route model", async () => {
  let capturedParams: Record<string, unknown> | null = null;

  const context = await createRuntimeAIContext(testUser, {
    inferenceSelection: { billingMode: "light", model: "openai/gpt-4o-mini" },
    resolveRoute: async (params) => {
      capturedParams = params as unknown as Record<string, unknown>;
      return makeRoute({ modelPinned: true });
    },
    checkBalance: async () => 1000,
  });

  assertEquals(capturedParams?.pinSelectedModel, true);
  assertEquals(
    (capturedParams?.selection as Record<string, unknown>)?.model,
    "openai/gpt-4o-mini",
  );
  // toRuntimeAIRoute must carry the pin through to the sandbox route props.
  assertEquals(context.route?.modelPinned, true);
});

Deno.test("runtime AI context: no override selection does not pin the route model", async () => {
  let capturedParams: Record<string, unknown> | null = null;

  await createRuntimeAIContext(testUser, {
    resolveRoute: async (params) => {
      capturedParams = params as unknown as Record<string, unknown>;
      return makeRoute();
    },
    checkBalance: async () => 1000,
  });

  assertEquals(capturedParams?.pinSelectedModel, false);
});
