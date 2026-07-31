import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { handleAuth } from "./auth.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("magic-link auth: requests a generic Supabase OTP email", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let otpUrl = "";
  let otpBody: Record<string, unknown> | null = null;

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_ANON_KEY: "anon-key",
    LAUNCH_WEB_BASE_URL: "https://launch.test",
    CORS_ALLOWED_ORIGINS: "https://launch.test",
  } as typeof globalThis.__env;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    otpUrl = input instanceof Request ? input.url : String(input);
    otpBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({});
  }) as typeof fetch;

  try {
    const response = await handleAuth(
      new Request("https://api.test/auth/launch/magic-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://launch.test",
        },
        body: JSON.stringify({
          email: "person@example.com",
          next: "/agents?welcome=1",
        }),
      }),
    );

    assertEquals(response.status, 200);
    const target = new URL(otpUrl);
    assertEquals(target.origin, "https://supabase.test");
    assertEquals(target.pathname, "/auth/v1/otp");
    assertEquals(
      target.searchParams.get("redirect_to"),
      "https://launch.test/auth/callback?next=%2Fagents%3Fwelcome%3D1",
    );
    assertEquals(otpBody, {
      email: "person@example.com",
      create_user: true,
    });
    assertEquals(await response.json(), {
      audience: "launch_web",
      email: "person@example.com",
      link_sent: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("magic-link auth: GET verification never consumes the token", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    return Promise.resolve(jsonResponse({}));
  }) as typeof fetch;

  try {
    const response = await handleAuth(
      new Request(
        "https://api.test/auth/launch/verify?token_hash=one-time-token-hash",
      ),
    );

    assertEquals(response.status, 404);
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("magic-link auth: verifies the token hash and establishes a launch session", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let verifyBody: Record<string, unknown> | null = null;

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_ANON_KEY: "anon-key",
  } as typeof globalThis.__env;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method || "GET";

    if (method === "POST" && url === "https://supabase.test/auth/v1/verify") {
      verifyBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        access_token: "supabase-access-token",
        expires_in: 3600,
        refresh_token: "supabase-refresh-token",
      });
    }
    if (method === "GET" && url === "https://supabase.test/auth/v1/user") {
      return jsonResponse({
        id: "user-1",
        email: "person@example.com",
        email_confirmed_at: "2026-07-30T17:30:00.000Z",
        user_metadata: { name: "Person" },
      });
    }
    if (
      method === "GET" &&
      url.startsWith("https://supabase.test/rest/v1/users?id=eq.user-1")
    ) {
      return jsonResponse([{ id: "user-1" }]);
    }
    if (
      method === "GET" &&
      url.startsWith("https://supabase.test/rest/v1/pending_permissions")
    ) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  }) as typeof fetch;

  try {
    const response = await handleAuth(
      new Request("https://api.test/auth/launch/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token_hash: "one-time-token-hash" }),
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(verifyBody, {
      token_hash: "one-time-token-hash",
      type: "email",
    });
    const payload = await response.json() as {
      access_token: string;
      refresh_supported: boolean;
      user: { email: string };
    };
    assertEquals(payload.access_token, "supabase-access-token");
    assertEquals(payload.refresh_supported, true);
    assertEquals(payload.user.email, "person@example.com");
    assertEquals(
      (response.headers.get("set-cookie") || "").includes(
        "__Host-ul_launch_refresh=supabase-refresh-token",
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
