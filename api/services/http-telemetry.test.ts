import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  recordHttpRequest,
  sanitizeHttpRequestForLogs,
} from "./http-telemetry.ts";

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

Deno.test("http telemetry: redacts sensitive headers and query params for logs", () => {
  const sanitized = sanitizeHttpRequestForLogs({
    method: "POST",
    url: "/http/app/webhook?token=secret&ok=1",
    path: "/",
    query: {
      token: "secret",
      ok: "1",
      api_key: "key",
    },
    headers: {
      authorization: "Bearer secret",
      cookie: "session=secret",
      "x-hub-signature-256": "sha256=secret",
      "content-type": "application/json",
    },
  });

  assertEquals(sanitized, {
    method: "POST",
    url: "/http/app/webhook?token=[REDACTED]&ok=1",
    path: "/",
    query: {
      token: "[REDACTED]",
      ok: "1",
      api_key: "[REDACTED]",
    },
    headers: {
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      "x-hub-signature-256": "[REDACTED]",
      "content-type": "application/json",
    },
  });
});

Deno.test("http telemetry: writes audit rows without raw IP addresses", async () => {
  await withEnv({
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  }, async () => {
    let seenBody: Record<string, unknown> | null = null;
    await recordHttpRequest({
      appId: "11111111-1111-4111-8111-111111111111",
      functionName: "webhook",
      endpoint: "/http/11111111-1111-4111-8111-111111111111/webhook",
      method: "POST",
      identityHash: "sha256:abc",
      userAgent: "Test Agent",
      origin: "https://example.com",
      statusCode: 429,
      durationMs: 12,
      authState: "authenticated",
      rateLimited: true,
      receiptId: "22222222-2222-4222-8222-222222222222",
    }, {
      fetchFn: async (input, init) => {
        assertEquals(
          String(input),
          "https://supabase.test/rest/v1/http_requests",
        );
        seenBody = JSON.parse(String(init?.body));
        return new Response("{}", { status: 201 });
      },
    });

    assertEquals(seenBody, {
      app_id: "11111111-1111-4111-8111-111111111111",
      endpoint: "/http/11111111-1111-4111-8111-111111111111/webhook",
      function_name: "webhook",
      method: "POST",
      ip_address: null,
      identity_hash: "sha256:abc",
      user_agent: "Test Agent",
      origin: "https://example.com",
      status_code: 429,
      duration_ms: 12,
      auth_state: "authenticated",
      rate_limited: true,
      receipt_id: "22222222-2222-4222-8222-222222222222",
    });
  });
});
