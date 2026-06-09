import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { handleAuth } from "./auth.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("auth session bootstrap claims pending referral visitor landings", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const grantPosts: Record<string, unknown>[] = [];

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_ANON_KEY: "anon-key",
  } as typeof globalThis.__env;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;

    if (method === "GET" && url === "https://supabase.test/auth/v1/user") {
      return jsonResponse({ id: "user-1", email: "user@example.com", user_metadata: {} });
    }
    if (method === "GET" && url.startsWith("https://supabase.test/rest/v1/users?id=eq.user-1")) {
      return jsonResponse([{ id: "user-1" }]);
    }
    if (method === "GET" && url.startsWith("https://supabase.test/rest/v1/pending_permissions")) {
      return jsonResponse([]);
    }
    if (method === "GET" && url.includes("/publisher_referral_landings?anonymous_visitor_id=")) {
      return jsonResponse([{
        id: "landing-1",
        referral_link_id: "link-1",
        publisher_user_id: "publisher-1",
        app_id: "app-1",
        anonymous_visitor_id: "11111111-1111-4111-8111-111111111111",
        user_id: null,
        landed_at: "2026-05-18T12:00:00Z",
        claimed_at: null,
      }]);
    }
    if (method === "GET" && url.includes("/publisher_fee_waiver_grants?")) {
      return jsonResponse([]);
    }
    if (method === "POST" && url.endsWith("/publisher_fee_waiver_grants")) {
      grantPosts.push(body || {});
      return jsonResponse([{ id: "grant-1", starts_at: body?.starts_at, expires_at: body?.expires_at }]);
    }
    if (method === "PATCH" && url.includes("/publisher_referral_landings?id=eq.landing-1")) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const response = await handleAuth(new Request("https://ul.test/auth/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cookie": "__Host-ul_ref_visitor=11111111-1111-4111-8111-111111111111",
      },
      body: JSON.stringify({ access_token: "supabase-access-token" }),
    }));

    assertEquals(response.status, 200);
    assertEquals(grantPosts.length, 1);
    assertEquals(grantPosts[0].source_landing_id, "landing-1");
    assertEquals(grantPosts[0].user_id, "user-1");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("auth callback redirects launch web return targets through opaque bridge", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    SUPABASE_ANON_KEY: "anon-key",
    CORS_ALLOWED_ORIGINS: "https://api.ul.test,https://staging.launch.test",
  } as typeof globalThis.__env;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method || "GET";

    if (method === "POST" && url === "https://supabase.test/auth/v1/token?grant_type=pkce") {
      return jsonResponse({
        access_token: "supabase-access-token",
        refresh_token: "supabase-refresh-token",
        expires_in: 3600,
      });
    }
    if (method === "GET" && url === "https://supabase.test/auth/v1/user") {
      return jsonResponse({ id: "user-1", email: "user@example.com", user_metadata: {} });
    }
    if (method === "GET" && url.startsWith("https://supabase.test/rest/v1/users?id=eq.user-1")) {
      return jsonResponse([{ id: "user-1" }]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  try {
    const verifier = "a".repeat(43);
    const returnTo = encodeURIComponent("https://staging.launch.test/settings?tab=keys");
    const response = await handleAuth(
      new Request(`https://api.ul.test/auth/callback?code=oauth-code&v=${verifier}&return_to=${returnTo}`),
    );

    assertEquals(response.status, 302);
    const location = response.headers.get("location") || "";
    const target = new URL(location);
    assertEquals(target.origin, "https://staging.launch.test");
    assertEquals(target.pathname, "/auth/callback");
    assertEquals(target.searchParams.get("next"), "/settings?tab=keys");

    const fragment = new URLSearchParams(target.hash.slice(1));
    assertEquals(fragment.get("bridge_token")?.startsWith("ul_embed_"), true);
    assertEquals(location.includes("supabase-access-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
