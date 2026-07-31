import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  applyAuthRateLimitHeaders,
  buildAuthRateLimitResponse,
  enforceAuthRouteRateLimit,
  getAuthRateLimitClientIp,
  resolveAuthRateLimitKey,
} from "./auth-rate-limit.ts";

Deno.test("auth route rate limit: prefers Cloudflare client IP over caller-controlled forwarding headers", () => {
  const request = new Request("https://example.com/auth/session", {
    headers: {
      "cf-connecting-ip": "192.0.2.50",
      "x-forwarded-for": "203.0.113.10, 10.0.0.1",
      "x-real-ip": "198.51.100.25",
    },
  });

  assertEquals(getAuthRateLimitClientIp(request), "192.0.2.50");
});

Deno.test("auth route rate limit: falls back through forwarded client IP headers", () => {
  const forwardedRequest = new Request("https://example.com/auth/session", {
    headers: {
      "x-forwarded-for": "203.0.113.10, 10.0.0.1",
      "x-real-ip": "198.51.100.25",
    },
  });
  const realIpRequest = new Request("https://example.com/auth/session", {
    headers: { "x-real-ip": "198.51.100.25" },
  });

  assertEquals(getAuthRateLimitClientIp(forwardedRequest), "203.0.113.10");
  assertEquals(getAuthRateLimitClientIp(realIpRequest), "198.51.100.25");
});

Deno.test("auth route rate limit: resolves desktop poll keys from session id", () => {
  const request = new Request("https://example.com/auth/desktop-poll?session_id=123e4567-e89b-12d3-a456-426614174000", {
    headers: { "x-forwarded-for": "203.0.113.10" },
  });

  assertEquals(
    resolveAuthRateLimitKey(request, "auth:desktop-poll"),
    "123e4567-e89b-12d3-a456-426614174000",
  );
});

Deno.test("auth route rate limit: falls back to client ip when session id is missing", () => {
  const request = new Request("https://example.com/auth/desktop-poll", {
    headers: { "x-real-ip": "198.51.100.25" },
  });

  assertEquals(resolveAuthRateLimitKey(request, "auth:desktop-poll"), "198.51.100.25");
});

Deno.test("auth route rate limit: blocked JSON responses include retry metadata", () => {
  const response = buildAuthRateLimitResponse("auth:refresh", {
    allowed: false,
    remaining: 0,
    resetAt: new Date(Date.now() + 30_000),
    reason: "limit_exceeded",
  });

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After") !== null, true);
  assertEquals(response.headers.get("X-RateLimit-Limit"), "30");
});

Deno.test("auth route rate limit: shared page exchange and signout routes expose their configured limits", () => {
  const shareResponse = buildAuthRateLimitResponse("auth:page_share_exchange", {
    allowed: false,
    remaining: 0,
    resetAt: new Date(Date.now() + 30_000),
    reason: "limit_exceeded",
  });
  const signoutResponse = new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });

  applyAuthRateLimitHeaders(signoutResponse, "auth:signout", {
    allowed: true,
    remaining: 19,
    resetAt: new Date(Date.now() + 60_000),
  });

  assertEquals(shareResponse.headers.get("X-RateLimit-Limit"), "60");
  assertEquals(signoutResponse.headers.get("X-RateLimit-Limit"), "20");
  assertEquals(signoutResponse.headers.get("X-RateLimit-Remaining"), "19");
});

Deno.test("auth route rate limit: blocked OAuth responses use temporarily_unavailable", async () => {
  const response = buildAuthRateLimitResponse("oauth:token", {
    allowed: false,
    remaining: 0,
    resetAt: new Date(Date.now() + 30_000),
    reason: "service_unavailable",
  });

  assertEquals(response.status, 503);
  assertStringIncludes(await response.text(), '"temporarily_unavailable"');
});

Deno.test("auth route rate limit: success responses can be decorated with rate headers", () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" },
  });

  applyAuthRateLimitHeaders(response, "auth:session", {
    allowed: true,
    remaining: 19,
    resetAt: new Date(Date.now() + 60_000),
  });

  assertEquals(response.headers.get("X-RateLimit-Limit"), "20");
  assertEquals(response.headers.get("X-RateLimit-Remaining"), "19");
});

Deno.test("auth route rate limit: enforce blocks after the configured limit", async () => {
  const request = new Request("https://example.com/oauth/token", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.44" },
  });

  const first = await enforceAuthRouteRateLimit(request, "oauth:token", {
    limit: 1,
    windowMinutes: 1,
  });
  const second = await enforceAuthRouteRateLimit(request, "oauth:token", {
    limit: 1,
    windowMinutes: 1,
  });

  assertEquals(first.response, null);
  assertEquals(second.response?.status, 429);
  assertEquals(second.response?.headers.get("Retry-After") !== null, true);
});
