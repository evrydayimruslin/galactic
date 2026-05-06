import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import type { ResolvedInferenceRoute } from "./inference-route.ts";
import {
  buildFlashCallTelemetryContext,
  callFlashText,
} from "./flash-broker.ts";

function makeRoute(): ResolvedInferenceRoute {
  return {
    billingMode: "light",
    provider: "ultralight",
    upstreamProvider: "deepseek",
    baseUrl: "https://api.deepseek.test",
    apiKey: "deepseek-key",
    model: "deepseek-v4-flash",
    canonicalModelId: "ultralight/deepseek-v4-flash",
    billingModelId: "ultralight/deepseek-v4-flash",
    keySource: "platform_deepseek",
    billingSource: "platform_deepseek_direct",
    shouldRequireBalance: true,
    shouldDebitLight: true,
  };
}

Deno.test("flash broker telemetry: absent broker telemetry keeps Flash calls uninstrumented", () => {
  assertEquals(
    buildFlashCallTelemetryContext(undefined, {
      userId: "user-1",
      userEmail: "user@example.com",
      conversationId: "conversation-1",
    }),
    undefined,
  );
});

Deno.test("flash broker telemetry: shapes broker context for downstream Flash calls", () => {
  assertEquals(
    buildFlashCallTelemetryContext(
      {
        traceId: "00000000-0000-4000-8000-000000000001",
        conversationId: "conversation-from-capture",
        source: "orchestrate",
      },
      {
        userId: "user-1",
        userEmail: "user@example.com",
        conversationId: "conversation-from-request",
      },
    ),
    {
      userId: "user-1",
      userEmail: "user@example.com",
      traceId: "00000000-0000-4000-8000-000000000001",
      conversationId: "conversation-from-capture",
      source: "orchestrate",
    },
  );
});

Deno.test("flash broker telemetry: request conversation id and default source are fallback values", () => {
  assertEquals(
    buildFlashCallTelemetryContext(
      {
        traceId: "00000000-0000-4000-8000-000000000002",
      },
      {
        userId: "user-2",
        userEmail: "second@example.com",
        conversationId: "conversation-from-request",
      },
    ),
    {
      userId: "user-2",
      userEmail: "second@example.com",
      traceId: "00000000-0000-4000-8000-000000000002",
      conversationId: "conversation-from-request",
      source: "orchestrate",
    },
  );
});

Deno.test("flash broker telemetry: callFlashText records Flash invocation snapshots", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: string; body: unknown }> = [];

  globalThis.__env = {
    CHAT_CAPTURE_ENABLED: "true",
    CHAT_CAPTURE_ARTIFACTS_ENABLED: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    ANALYTICS_PEPPER_V1: "test-pepper",
  } as unknown as typeof globalThis.__env;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
    calls.push({
      method: init?.method || "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    if (url === "https://api.deepseek.test/chat/completions") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{
              finish_reason: "stop",
              message: { content: "Found the answer." },
            }],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 4,
              total_tokens: 16,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (url.includes("/llm_context_snapshots")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { id: crypto.randomUUID() },
          ]),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (init?.method === "PATCH") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    return Promise.resolve(new Response("", { status: 201 }));
  }) as typeof fetch;

  try {
    const content = await callFlashText(
      "deepseek-v4-flash",
      "system",
      "user",
      makeRoute(),
      {
        telemetry: {
          userId: "00000000-0000-4000-8000-000000000001",
          userEmail: "flash@example.com",
          traceId: "00000000-0000-4000-8000-000000000004",
          conversationId: "conversation-flash-text",
          source: "orchestrate",
        },
        taskId: "flash_broker.read_response",
        inputFeatures: {
          projectContext: "package.json",
          conversationHistory: [{ role: "user", content: "question" }],
        },
        metadata: {
          mode: "read",
        },
      },
    );

    assertEquals(content, "Found the answer.");

    const providerCall = calls.find((call) =>
      call.url === "https://api.deepseek.test/chat/completions"
    );
    assertEquals(
      (providerCall?.body as { model?: string }).model,
      "deepseek-v4-flash",
    );

    const invocationInsert = calls.find((call) =>
      call.method === "POST" && call.url.includes("/llm_invocations")
    );
    const invocationBody = invocationInsert?.body as {
      phase?: string;
      metadata?: {
        tier?: string;
        component_id?: string;
        schema_id?: string;
        input_features?: { has_project_context?: boolean };
      };
    };
    assertEquals(invocationBody.phase, "flash_broker.read_response");
    assertEquals(invocationBody.metadata?.tier, "flash");
    assertEquals(
      invocationBody.metadata?.component_id,
      "flash_broker.read_response",
    );
    assertEquals(
      invocationBody.metadata?.schema_id,
      "flash_broker.read_response.v1",
    );
    assertEquals(
      invocationBody.metadata?.input_features?.has_project_context,
      true,
    );

    const snapshotInserts = calls.filter((call) =>
      call.method === "POST" && call.url.includes("/llm_context_snapshots")
    );
    assertEquals(
      snapshotInserts.map((call) =>
        (call.body as { snapshot_type?: string }).snapshot_type
      ),
      [
        "llm_request",
        "llm_response",
      ],
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});
