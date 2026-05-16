import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  buildHttpRateLimitHeaders,
  checkHttpRouteRateLimit,
  createHttpRateLimitIdentityHash,
  resetHttpRouteRateLimitMemoryForTests,
} from "./http-rate-limit.ts";

async function withEnv<T>(
  env: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...env,
  } as typeof globalThis.__env;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
  }
}

Deno.test("http rate limit: hashes IP identity without exposing the raw address", async () => {
  await withEnv({ ANALYTICS_PEPPER_V1: "pepper" }, async () => {
    const request = new Request("https://api.example/http/app/webhook", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });

    const first = await createHttpRateLimitIdentityHash(request);
    const second = await createHttpRateLimitIdentityHash(request);

    assertEquals(first, second);
    assertEquals(first.startsWith("sha256:"), true);
    assertEquals(first.includes("203.0.113.9"), false);
  });
});

Deno.test("http rate limit: memory fallback is route and identity scoped", async () => {
  resetHttpRouteRateLimitMemoryForTests();
  await withEnv(
    { SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    async () => {
      const base = {
        appId: "11111111-1111-4111-8111-111111111111",
        functionName: "webhook",
        identityHash: "sha256:test",
        limitPerMinute: 2,
      };

      const first = await checkHttpRouteRateLimit(base);
      const second = await checkHttpRouteRateLimit(base);
      const third = await checkHttpRouteRateLimit(base);
      const otherFunction = await checkHttpRouteRateLimit({
        ...base,
        functionName: "dashboard",
      });

      assertEquals(first.allowed, true);
      assertEquals(second.allowed, true);
      assertEquals(third.allowed, false);
      assertEquals(third.reason, "limit_exceeded");
      assertEquals(third.source, "memory");
      assertEquals(otherFunction.allowed, true);
    },
  );
});

Deno.test("http rate limit: calls durable route RPC when Supabase is configured", async () => {
  await withEnv({
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  }, async () => {
    let seenBody: Record<string, unknown> | null = null;
    const result = await checkHttpRouteRateLimit({
      appId: "11111111-1111-4111-8111-111111111111",
      functionName: "webhook",
      identityHash: "sha256:abc",
      limitPerMinute: 60,
    }, {
      fetchFn: async (input, init) => {
        assertEquals(
          String(input),
          "https://supabase.test/rest/v1/rpc/check_http_route_rate_limit",
        );
        seenBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify([{
            allowed: false,
            current_count: 61,
            limit_count: 60,
            remaining: 0,
            reset_at: "2026-05-16T16:01:00.000Z",
          }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    assertEquals(seenBody, {
      p_app_id: "11111111-1111-4111-8111-111111111111",
      p_function_name: "webhook",
      p_identity_hash: "sha256:abc",
      p_limit: 60,
      p_window_seconds: 60,
    });
    assertEquals(result.source, "supabase");
    assertEquals(result.allowed, false);
    assertEquals(result.currentCount, 61);
    assertEquals(result.remaining, 0);
    assertEquals(result.reason, "limit_exceeded");
  });
});

Deno.test("http rate limit: builds standard limit headers", () => {
  const headers = buildHttpRateLimitHeaders({
    limit: 60,
    remaining: 0,
    resetAt: new Date(Date.now() + 30_000),
  });

  assertEquals(headers["X-RateLimit-Limit"], "60");
  assertEquals(headers["X-RateLimit-Remaining"], "0");
  assertEquals(Number(headers["Retry-After"]) > 0, true);
});
