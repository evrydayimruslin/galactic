import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { CHAT_PLATFORM_MARKUP } from "../../shared/contracts/ai.ts";
import { calculateCostLight, deductChatCost } from "./chat-billing.ts";
import { ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL } from "./platform-inference-models.ts";

Deno.test("chat billing: OpenRouter total_cost is debited at pass-through Light rate", () => {
  assertEquals(CHAT_PLATFORM_MARKUP, 1.0);

  const costLight = calculateCostLight(
    { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    "deepseek/deepseek-v4-flash",
    0.1234,
  );

  assertEquals(costLight, 12.34);
});

Deno.test("chat billing: direct DeepSeek pricing uses cache hit, cache miss, and output tokens", () => {
  const costLight = calculateCostLight(
    {
      prompt_tokens: 1_000,
      prompt_cache_hit_tokens: 400,
      prompt_cache_miss_tokens: 600,
      completion_tokens: 1_000,
      total_tokens: 2_000,
    },
    ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
    undefined,
    {
      billingSource: "platform_deepseek_direct",
      now: new Date("2026-05-04T12:00:00Z"),
    },
  );

  assertEquals(costLight, 0.1132);
});

Deno.test('chat billing: trace metadata is written to billing transaction', async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];

  globalThis.__env = {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  } as unknown as typeof globalThis.__env;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url, body });

    if (url.includes('/rpc/debit_light')) {
      assertEquals((body as { p_reason?: string }).p_reason, 'ai_chat');
      assertEquals((body as { p_metadata?: { trace_id?: string } }).p_metadata?.trace_id, 'trace-123');
      return Promise.resolve(
        new Response(JSON.stringify([{ new_balance: 42, was_depleted: false, amount_debited: 1 }]), {
          status: 200,
        }),
      );
    }

    return Promise.resolve(new Response('', { status: 201 }));
  }) as typeof fetch;

  try {
    await deductChatCost(
      'user-123',
      { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      'deepseek/deepseek-v4-flash',
      0.01,
      {
        traceId: 'trace-123',
        conversationId: 'conv-123',
        messageId: 'msg-123',
        source: 'chat_stream',
      },
    );

    const tx = calls.find((call) => call.url.includes('/billing_transactions'));
    const metadata = (tx?.body as { metadata?: Record<string, unknown> } | undefined)
      ?.metadata;
    assertEquals(metadata?.trace_id, 'trace-123');
    assertEquals(metadata?.conversation_id, 'conv-123');
    assertEquals(metadata?.message_id, 'msg-123');
    assertEquals(metadata?.source, 'chat_stream');
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});
