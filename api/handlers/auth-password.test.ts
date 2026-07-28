import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { handleAuth } from "./auth.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("password auth: sign-up delegates confirmation delivery and redirect to Supabase", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let signupUrl = "";
  let signupBody: Record<string, unknown> | null = null;

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
    signupUrl = input instanceof Request ? input.url : String(input);
    signupBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      id: "pending-user",
      email: "person@example.com",
    });
  }) as typeof fetch;

  try {
    const response = await handleAuth(
      new Request("https://api.test/auth/launch/password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://launch.test",
        },
        body: JSON.stringify({
          email: "person@example.com",
          mode: "sign_up",
          next: "/agents?welcome=1",
          password: "Strong-password-1!",
        }),
      }),
    );

    assertEquals(response.status, 200);
    const target = new URL(signupUrl);
    assertEquals(target.origin, "https://supabase.test");
    assertEquals(target.pathname, "/auth/v1/signup");
    assertEquals(
      target.searchParams.get("redirect_to"),
      "https://launch.test/auth/callback?next=%2Fagents%3Fwelcome%3D1",
    );
    assertEquals(signupBody, {
      email: "person@example.com",
      password: "Strong-password-1!",
    });
    assertEquals(await response.json(), {
      audience: "launch_web",
      confirmation_required: true,
      email: "person@example.com",
      refresh_supported: false,
    });
    assertEquals(response.headers.get("set-cookie"), null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("password auth: sign-in establishes the existing launch refresh session", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;

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
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method || "GET";

    if (
      method === "POST" &&
      url === "https://supabase.test/auth/v1/token?grant_type=password"
    ) {
      return jsonResponse({
        access_token: "supabase-access-token",
        expires_in: 3600,
        refresh_token: "supabase-refresh-token",
        user: {
          id: "user-1",
          email: "person@example.com",
        },
      });
    }
    if (method === "GET" && url === "https://supabase.test/auth/v1/user") {
      return jsonResponse({
        id: "user-1",
        email: "person@example.com",
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
      new Request("https://api.test/auth/launch/password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://launch.test",
        },
        body: JSON.stringify({
          email: "person@example.com",
          mode: "sign_in",
          next: "/agents",
          password: "Strong-password-1!",
        }),
      }),
    );

    assertEquals(response.status, 200);
    const payload = await response.json() as {
      access_token: string;
      confirmation_required: boolean;
      refresh_supported: boolean;
      user: { email: string };
    };
    assertEquals(payload.access_token, "supabase-access-token");
    assertEquals(payload.confirmation_required, false);
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
