import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  applySensitiveRouteRateLimitHeaders,
  buildSensitiveRouteRateLimitResponse,
  enforceSensitiveRouteRateLimit,
  getSensitiveRouteClientKey,
} from "./sensitive-route-rate-limit.ts";

Deno.test("sensitive route rate limit: reads client IP from forwarded headers", () => {
  const request = new Request("https://example.com/api/mcp-config/app_123", {
    headers: { "x-forwarded-for": "203.0.113.12, 10.0.0.1" },
  });

  assertEquals(getSensitiveRouteClientKey(request), "203.0.113.12");
});

Deno.test("sensitive route rate limit: blocked responses include retry metadata", () => {
  const response = buildSensitiveRouteRateLimitResponse("user:token_create", {
    allowed: false,
    remaining: 0,
    resetAt: new Date(Date.now() + 45_000),
    reason: "limit_exceeded",
  });

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After") !== null, true);
  assertEquals(response.headers.get("X-RateLimit-Limit"), "20");
});

Deno.test("sensitive route rate limit: can decorate successful responses", () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });

  applySensitiveRouteRateLimitHeaders(response, "developer:app_update", {
    allowed: true,
    remaining: 29,
    resetAt: new Date(Date.now() + 60_000),
  });

  assertEquals(response.headers.get("X-RateLimit-Limit"), "30");
  assertEquals(response.headers.get("X-RateLimit-Remaining"), "29");
});

Deno.test("sensitive route rate limit: new upload, payment, and admin routes expose their configured limits", () => {
  const uploadResponse = buildSensitiveRouteRateLimitResponse("upload:create", {
    allowed: false,
    remaining: 0,
    resetAt: new Date(Date.now() + 30_000),
    reason: "limit_exceeded",
  });
  const wireResponse = buildSensitiveRouteRateLimitResponse(
    "user:wallet_wire_transfer",
    {
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30_000),
      reason: "limit_exceeded",
    },
  );
  const adminResponse = new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });

  applySensitiveRouteRateLimitHeaders(
    adminResponse,
    "admin:cleanup_provisionals",
    {
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
    },
  );
  const payoutResponse = buildSensitiveRouteRateLimitResponse(
    "admin:payout_process",
    {
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30_000),
      reason: "limit_exceeded",
    },
  );
  const computeStatusResponse = buildSensitiveRouteRateLimitResponse(
    "admin:compute_emergency_stop_status",
    {
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30_000),
      reason: "limit_exceeded",
    },
  );

  assertEquals(uploadResponse.headers.get("X-RateLimit-Limit"), "20");
  assertEquals(wireResponse.headers.get("X-RateLimit-Limit"), "10");
  assertEquals(adminResponse.headers.get("X-RateLimit-Limit"), "10");
  assertEquals(adminResponse.headers.get("X-RateLimit-Remaining"), "9");
  assertEquals(payoutResponse.headers.get("X-RateLimit-Limit"), "10");
  assertEquals(computeStatusResponse.headers.get("X-RateLimit-Limit"), "60");
});

Deno.test("sensitive route rate limit: enforce blocks after configured limit", async () => {
  const first = await enforceSensitiveRouteRateLimit(
    "test-user-key",
    "apps:env_set",
    {
      limit: 1,
      windowMinutes: 1,
    },
  );
  const second = await enforceSensitiveRouteRateLimit(
    "test-user-key",
    "apps:env_set",
    {
      limit: 1,
      windowMinutes: 1,
    },
  );

  assertEquals(first.response, null);
  assertEquals(second.response?.status, 429);
});
