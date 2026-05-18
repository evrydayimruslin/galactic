import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";

import {
  claimReferralLandingsForUser,
  claimReferralTokenForUser,
  createReferralClaimToken,
  getOrCreatePublisherReferralLink,
  isValidReferralSlug,
  recordReferralLanding,
  referralUrl,
} from "./referrals.ts";

function installEnv() {
  (globalThis as unknown as { __env: Record<string, unknown> }).__env = {
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("referrals: validates and formats referral URLs", () => {
  assertEquals(isValidReferralSlug("abc123"), true);
  assertEquals(isValidReferralSlug("a_bc-123"), true);
  assertEquals(isValidReferralSlug("short"), false);
  assertEquals(isValidReferralSlug("-starts-bad"), false);
  assertEquals(referralUrl("abc123", "https://ul.test/"), "https://ul.test/r/abc123");
});

Deno.test("referrals: creates an active publisher referral link when none exists", async () => {
  installEnv();
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });

    if (method === "GET" && url.includes("/publisher_referral_links?app_id=")) {
      return jsonResponse([]);
    }
    if (method === "POST" && url.endsWith("/publisher_referral_links")) {
      return jsonResponse([{
        id: "link-1",
        app_id: body?.app_id,
        publisher_user_id: body?.publisher_user_id,
        slug: body?.slug,
        status: "active",
        created_at: "2026-05-18T12:00:00Z",
      }]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const link = await getOrCreatePublisherReferralLink("app-1", "publisher-1", {
    fetchFn,
    baseUrl: "https://ul.test",
    randomBytes: () => new Uint8Array(18).fill(1),
  });

  assertEquals(link.app_id, "app-1");
  assertEquals(link.publisher_user_id, "publisher-1");
  assert(link.slug.length >= 6);
  assertEquals(link.url, `https://ul.test/r/${link.slug}`);
  assertEquals(calls.length, 2);
  assertEquals(calls[1].body?.status, "active");
});

Deno.test("referrals: disables stale transferred-app link before creating owner link", async () => {
  installEnv();
  let postAttempts = 0;
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });

    if (
      method === "GET" &&
      url.includes("/publisher_referral_links?app_id=") &&
      url.includes("&publisher_user_id=")
    ) {
      return jsonResponse([]);
    }
    if (
      method === "GET" &&
      url.includes("/publisher_referral_links?app_id=") &&
      !url.includes("&publisher_user_id=")
    ) {
      return jsonResponse([{
        id: "old-link",
        app_id: "app-1",
        publisher_user_id: "previous-owner",
        slug: "old123",
        status: "active",
        created_at: "2026-05-17T12:00:00Z",
      }]);
    }
    if (method === "PATCH" && url.includes("/publisher_referral_links?id=eq.old-link")) {
      return jsonResponse([]);
    }
    if (method === "POST" && url.endsWith("/publisher_referral_links")) {
      postAttempts += 1;
      if (postAttempts === 1) {
        return new Response(JSON.stringify({ code: "23505" }), { status: 409 });
      }
      return jsonResponse([{
        id: "new-link",
        app_id: body?.app_id,
        publisher_user_id: body?.publisher_user_id,
        slug: body?.slug,
        status: "active",
        created_at: "2026-05-18T12:00:00Z",
      }]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const link = await getOrCreatePublisherReferralLink("app-1", "publisher-1", {
    fetchFn,
    baseUrl: "https://ul.test",
    randomBytes: () => new Uint8Array(18).fill(2),
    now: () => new Date("2026-05-18T12:00:00Z"),
  });

  assertEquals(link.id, "new-link");
  assertEquals(postAttempts, 2);
  const stalePatch = calls.find((call) => call.method === "PATCH");
  assertEquals(stalePatch?.body?.status, "disabled");
  assertEquals(stalePatch?.body?.disabled_at, "2026-05-18T12:00:00.000Z");
});

Deno.test("referrals: anonymous landing records a visitor but does not create a grant", async () => {
  installEnv();
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });

    if (method === "GET" && url.includes("/publisher_referral_links?slug=")) {
      return jsonResponse([{
        id: "link-1",
        app_id: "app-1",
        publisher_user_id: "publisher-1",
        slug: "abc123",
        status: "active",
        created_at: "2026-05-18T12:00:00Z",
      }]);
    }
    if (method === "GET" && url.includes("/apps?id=")) {
      return jsonResponse([{ owner_id: "publisher-1" }]);
    }
    if (method === "POST" && url.endsWith("/publisher_referral_landings")) {
      return jsonResponse([{
        id: "landing-1",
        ...body,
        landed_at: "2026-05-18T12:00:00Z",
        claimed_at: null,
      }]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const result = await recordReferralLanding({
    slug: "abc123",
    metadata: { ipHash: "ip", userAgentHash: "ua" },
  }, { fetchFn });

  assertEquals(result.status, "recorded");
  assertEquals(result.appId, "app-1");
  assertEquals(result.grantId, null);
  assert(result.visitorId);
  const landingPost = calls.find((call) => call.method === "POST");
  assertEquals(landingPost?.body?.publisher_user_id, "publisher-1");
  assertEquals(landingPost?.body?.user_id, null);
  assertEquals(typeof landingPost?.body?.anonymous_visitor_id, "string");
  assertEquals(calls.some((call) => call.url.includes("publisher_fee_waiver_grants")), false);
});

Deno.test("referrals: self-referral is ignored before landing insert", async () => {
  installEnv();
  const calls: Array<{ url: string; method: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method });

    if (method === "GET" && url.includes("/publisher_referral_links?slug=")) {
      return jsonResponse([{
        id: "link-1",
        app_id: "app-1",
        publisher_user_id: "publisher-1",
        slug: "abc123",
        status: "active",
        created_at: "2026-05-18T12:00:00Z",
      }]);
    }
    if (method === "GET" && url.includes("/apps?id=")) {
      return jsonResponse([{ owner_id: "publisher-1" }]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const result = await recordReferralLanding({
    slug: "abc123",
    userId: "publisher-1",
  }, { fetchFn });

  assertEquals(result.status, "self_referral_ignored");
  assertEquals(calls.some((call) => call.method === "POST"), false);
});

Deno.test("referrals: auth claim uses earliest visitor landing without extension", async () => {
  installEnv();
  const grantPosts: Record<string, unknown>[] = [];
  const landingPatches: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;

    if (method === "GET" && url.includes("/publisher_referral_landings?anonymous_visitor_id=")) {
      return jsonResponse([
        {
          id: "landing-early",
          referral_link_id: "link-1",
          publisher_user_id: "publisher-1",
          app_id: "app-1",
          anonymous_visitor_id: "11111111-1111-4111-8111-111111111111",
          user_id: null,
          landed_at: "2026-05-18T12:00:00Z",
          claimed_at: null,
        },
        {
          id: "landing-late",
          referral_link_id: "link-2",
          publisher_user_id: "publisher-1",
          app_id: "app-2",
          anonymous_visitor_id: "11111111-1111-4111-8111-111111111111",
          user_id: null,
          landed_at: "2026-05-19T12:00:00Z",
          claimed_at: null,
        },
      ]);
    }
    if (method === "GET" && url.includes("/publisher_fee_waiver_grants?")) {
      return grantPosts.length === 0
        ? jsonResponse([])
        : jsonResponse([{ id: "grant-1", starts_at: "2026-05-18T12:00:00Z", expires_at: "2026-08-16T12:00:00.000Z" }]);
    }
    if (method === "POST" && url.endsWith("/publisher_fee_waiver_grants")) {
      grantPosts.push(body || {});
      return jsonResponse([{ id: "grant-1", starts_at: body?.starts_at, expires_at: body?.expires_at }]);
    }
    if (method === "PATCH" && url.includes("/publisher_referral_landings?id=")) {
      landingPatches.push(body || {});
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const result = await claimReferralLandingsForUser({
    userId: "user-1",
    anonymousVisitorId: "11111111-1111-4111-8111-111111111111",
  }, {
    fetchFn,
    now: () => new Date("2026-05-20T12:00:00Z"),
  });

  assertEquals(result.claimedLandingCount, 2);
  assertEquals(result.grantIds, ["grant-1"]);
  assertEquals(grantPosts.length, 1);
  assertEquals(grantPosts[0].source_landing_id, "landing-early");
  assertEquals(grantPosts[0].starts_at, "2026-05-18T12:00:00Z");
  assertEquals(grantPosts[0].expires_at, "2026-08-16T12:00:00.000Z");
  assertEquals(landingPatches.length, 2);
});

Deno.test("referrals: expired existing grant is claimed but not renewed", async () => {
  installEnv();
  const grantPosts: Record<string, unknown>[] = [];
  const landingPatches: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;

    if (method === "GET" && url.includes("/publisher_referral_landings?anonymous_visitor_id=")) {
      return jsonResponse([{
        id: "landing-new",
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
      return jsonResponse([{
        id: "expired-grant",
        starts_at: "2025-12-01T12:00:00Z",
        expires_at: "2026-03-01T12:00:00Z",
      }]);
    }
    if (method === "POST" && url.endsWith("/publisher_fee_waiver_grants")) {
      grantPosts.push(body || {});
      return jsonResponse([]);
    }
    if (method === "PATCH" && url.includes("/publisher_referral_landings?id=")) {
      landingPatches.push(body || {});
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const result = await claimReferralLandingsForUser({
    userId: "user-1",
    anonymousVisitorId: "11111111-1111-4111-8111-111111111111",
  }, { fetchFn });

  assertEquals(result.claimedLandingCount, 1);
  assertEquals(result.grantIds, ["expired-grant"]);
  assertEquals(grantPosts.length, 0);
  assertEquals(landingPatches.length, 1);
});

Deno.test("referrals: one user can hold grants for multiple publishers", async () => {
  installEnv();
  const grantPosts: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;

    if (method === "GET" && url.includes("/publisher_referral_landings?anonymous_visitor_id=")) {
      return jsonResponse([
        {
          id: "landing-pub-1",
          referral_link_id: "link-1",
          publisher_user_id: "publisher-1",
          app_id: "app-1",
          anonymous_visitor_id: "11111111-1111-4111-8111-111111111111",
          user_id: null,
          landed_at: "2026-05-18T12:00:00Z",
          claimed_at: null,
        },
        {
          id: "landing-pub-2",
          referral_link_id: "link-2",
          publisher_user_id: "publisher-2",
          app_id: "app-2",
          anonymous_visitor_id: "11111111-1111-4111-8111-111111111111",
          user_id: null,
          landed_at: "2026-05-19T12:00:00Z",
          claimed_at: null,
        },
      ]);
    }
    if (method === "GET" && url.includes("/publisher_fee_waiver_grants?")) {
      return jsonResponse([]);
    }
    if (method === "POST" && url.endsWith("/publisher_fee_waiver_grants")) {
      grantPosts.push(body || {});
      return jsonResponse([{
        id: `grant-${grantPosts.length}`,
        starts_at: body?.starts_at,
        expires_at: body?.expires_at,
      }]);
    }
    if (method === "PATCH" && url.includes("/publisher_referral_landings?id=")) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const result = await claimReferralLandingsForUser({
    userId: "user-1",
    anonymousVisitorId: "11111111-1111-4111-8111-111111111111",
  }, { fetchFn });

  assertEquals(result.claimedLandingCount, 2);
  assertEquals(result.grantIds, ["grant-1", "grant-2"]);
  assertEquals(grantPosts.map((post) => post.publisher_user_id), [
    "publisher-1",
    "publisher-2",
  ]);
});

Deno.test("referrals: desktop claim token redeems a landing for the signed-in user", async () => {
  installEnv();
  const token = await createReferralClaimToken({
    landingId: "landing-1",
    visitorId: "11111111-1111-4111-8111-111111111111",
  }, {
    now: () => new Date("2026-05-18T12:00:00Z"),
  });
  const grantPosts: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;

    if (method === "GET" && url.includes("/publisher_referral_landings?id=eq.landing-1")) {
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

  const result = await claimReferralTokenForUser(token, "user-1", { fetchFn });

  assertEquals(result.claimedLandingCount, 1);
  assertEquals(result.grantIds, ["grant-1"]);
  assertEquals(grantPosts[0].source_landing_id, "landing-1");
});

Deno.test("referrals: signed-in landing creates a fixed 90-day grant", async () => {
  installEnv();
  const grantPosts: Record<string, unknown>[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;

    if (method === "GET" && url.includes("/publisher_referral_links?slug=")) {
      return jsonResponse([{
        id: "link-1",
        app_id: "app-1",
        publisher_user_id: "publisher-1",
        slug: "abc123",
        status: "active",
        created_at: "2026-05-18T12:00:00Z",
      }]);
    }
    if (method === "GET" && url.includes("/apps?id=")) {
      return jsonResponse([{ owner_id: "publisher-1" }]);
    }
    if (method === "POST" && url.endsWith("/publisher_referral_landings")) {
      return jsonResponse([{
        id: "landing-1",
        ...body,
        landed_at: "2026-05-18T12:00:00Z",
        claimed_at: null,
      }]);
    }
    if (method === "GET" && url.includes("/publisher_fee_waiver_grants?")) {
      return jsonResponse([]);
    }
    if (method === "POST" && url.endsWith("/publisher_fee_waiver_grants")) {
      grantPosts.push(body || {});
      return jsonResponse([{
        id: "grant-1",
        starts_at: body?.starts_at,
        expires_at: body?.expires_at,
      }]);
    }
    if (method === "PATCH" && url.includes("/publisher_referral_landings?id=")) {
      return jsonResponse([]);
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  const result = await recordReferralLanding({
    slug: "abc123",
    anonymousVisitorId: "11111111-1111-4111-8111-111111111111",
    userId: "user-1",
  }, { fetchFn });

  assertEquals(result.status, "recorded");
  assertEquals(result.grantId, "grant-1");
  assertEquals(grantPosts.length, 1);
  assertEquals(grantPosts[0].starts_at, "2026-05-18T12:00:00Z");
  assertEquals(grantPosts[0].expires_at, "2026-08-16T12:00:00.000Z");
});
