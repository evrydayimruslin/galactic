import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.210.0/assert/assert_string_includes.ts";

import { createApp } from "./app.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("app router: referral landing records visitor and redirects to app", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const landingPosts: Record<string, unknown>[] = [];

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    BASE_URL: "https://ul.test",
  } as typeof globalThis.__env;

  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;

    if (method === "GET" && url.startsWith("https://supabase.test/rest/v1/publisher_referral_links")) {
      return jsonResponse([{
        id: "11111111-1111-4111-8111-111111111111",
        app_id: "22222222-2222-4222-8222-222222222222",
        publisher_user_id: "33333333-3333-4333-8333-333333333333",
        slug: "abc123",
        status: "active",
        created_at: "2026-05-18T12:00:00Z",
      }]);
    }
    if (method === "GET" && url.startsWith("https://supabase.test/rest/v1/apps")) {
      return jsonResponse([{ owner_id: "33333333-3333-4333-8333-333333333333" }]);
    }
    if (method === "POST" && url === "https://supabase.test/rest/v1/publisher_referral_landings") {
      landingPosts.push(body || {});
      return jsonResponse([{
        id: "44444444-4444-4444-8444-444444444444",
        ...body,
        landed_at: "2026-05-18T12:00:00Z",
        claimed_at: null,
      }], 201);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createApp();
    const response = await app.handle(new Request("https://ul.test/r/abc123", {
      headers: {
        "user-agent": "Referral Tester",
        "x-forwarded-for": "203.0.113.10",
      },
      redirect: "manual",
    }));

    assertEquals(response.status, 302);
    const location = response.headers.get("location") || "";
    assert(location.startsWith("/app/22222222-2222-4222-8222-222222222222?ref_claim="));
    assertStringIncludes(response.headers.get("set-cookie") || "", "__Host-ul_ref_visitor=");
    assertStringIncludes(response.headers.get("set-cookie") || "", "Max-Age=7776000");
    assertEquals(landingPosts.length, 1);
    assertEquals(landingPosts[0].publisher_user_id, "33333333-3333-4333-8333-333333333333");
    assertEquals(landingPosts[0].user_id, null);
    assert(typeof landingPosts[0].anonymous_visitor_id === "string");
    assert(typeof landingPosts[0].ip_hash === "string");
    assert(typeof landingPosts[0].user_agent_hash === "string");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("app router: referral bot preview renders OG card WITHOUT recording a landing", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  let landingPosts = 0;

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    BASE_URL: "https://ul.test",
  } as typeof globalThis.__env;

  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method || "GET";
    if (
      method === "GET" &&
      url.startsWith("https://supabase.test/rest/v1/publisher_referral_links")
    ) {
      return jsonResponse([{
        id: "11111111-1111-4111-8111-111111111111",
        app_id: "22222222-2222-4222-8222-222222222222",
        publisher_user_id: "33333333-3333-4333-8333-333333333333",
        slug: "abc123",
        status: "active",
        created_at: "2026-05-18T12:00:00Z",
      }]);
    }
    if (
      method === "GET" &&
      url.startsWith("https://supabase.test/rest/v1/apps")
    ) {
      return jsonResponse([{
        id: "22222222-2222-4222-8222-222222222222",
        slug: "story-builder",
        name: "Story Builder",
        description: "Create fictional worlds.",
        visibility: "public",
      }]);
    }
    if (method === "POST") {
      landingPosts++;
      throw new Error("bot preview must not POST (no landing/grant)");
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  }) as typeof fetch;

  try {
    const app = createApp();
    const response = await app.handle(
      new Request("https://ul.test/r/abc123", {
        headers: { "user-agent": "facebookexternalhit/1.1" },
        redirect: "manual",
      }),
    );

    assertEquals(response.status, 200);
    assertStringIncludes(
      response.headers.get("content-type") || "",
      "text/html",
    );
    const html = await response.text();
    assertStringIncludes(
      html,
      'content="https://ul.test/og/22222222-2222-4222-8222-222222222222.png"',
    );
    assertStringIncludes(html, "Story Builder: Galactic Agent");
    assertStringIncludes(html, 'name="twitter:card" content="summary_large_image"');
    assertEquals(landingPosts, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});

Deno.test("app router: terms page includes fee-waiver policy copy", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
  } as typeof globalThis.__env;
  globalThis.fetch = (async () => {
    throw new Error("Terms page should use default billing config without Supabase");
  }) as typeof fetch;

  try {
    const app = createApp();
    const response = await app.handle(new Request("https://ul.test/terms"));
    assertEquals(response.status, 200);
    const html = await response.text();
    assertStringIncludes(html, "Platform Fees And Waivers");
    assertStringIncludes(html, "do not change the gross credits amount paid by the end user");
    assertStringIncludes(html, "fee-waiver credit");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
});
