import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  consumeEmbedBridgeToken,
  getAccessTokenRemainingLifetimeSeconds,
  issueEmbedBridgeToken,
} from "./embed-bridge.ts";

const TEST_ENV = {
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

function makeJwt(exp: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const payload = btoa(JSON.stringify({ sub: "user-1", exp }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${header}.${payload}.signature`;
}

async function withMockedEnv(fn: () => Promise<void>): Promise<void> {
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;

  globalWithEnv.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  };

  try {
    await fn();
  } finally {
    globalWithEnv.__env = previousEnv;
  }
}

Deno.test("embed bridge: issues and consumes a valid opaque token", async () => {
  await withMockedEnv(async () => {
    const nowMs = Date.UTC(2026, 3, 20, 12, 0, 0);
    const jwt = makeJwt(Math.floor(nowMs / 1000) + 1800);
    const issued = await issueEmbedBridgeToken({
      accessToken: jwt,
      audience: "desktop_embed",
      userId: "user-1",
      ttlSeconds: 60,
      nowMs,
    });

    assert(issued.token.startsWith("ul_embed_"));
    assertEquals(issued.expiresIn, 60);

    const consumed = await consumeEmbedBridgeToken(issued.token, nowMs);
    assert(consumed !== null);
    assertEquals(consumed?.sub, "user-1");
    assertEquals(consumed?.aud, "desktop_embed");
    assertEquals(consumed?.access_token, jwt);
    assertEquals(consumed?.refresh_token, undefined);
  });
});

Deno.test("embed bridge: can issue launch web bridge tokens", async () => {
  await withMockedEnv(async () => {
    const nowMs = Date.UTC(2026, 3, 20, 12, 0, 0);
    const jwt = makeJwt(Math.floor(nowMs / 1000) + 1800);
    const issued = await issueEmbedBridgeToken({
      accessToken: jwt,
      audience: "launch_web",
      userId: "user-1",
      refreshToken: "refresh-token-1",
      ttlSeconds: 60,
      nowMs,
    });

    const consumed = await consumeEmbedBridgeToken(issued.token, nowMs);
    assert(consumed !== null);
    assertEquals(consumed?.aud, "launch_web");
    assertEquals(consumed?.access_token, jwt);
    assertEquals(consumed?.refresh_token, "refresh-token-1");
  });
});

Deno.test("embed bridge: clamps token ttl to access-token lifetime", async () => {
  await withMockedEnv(async () => {
    const nowMs = Date.UTC(2026, 3, 20, 12, 0, 0);
    const jwt = makeJwt(Math.floor(nowMs / 1000) + 25);
    const issued = await issueEmbedBridgeToken({
      accessToken: jwt,
      audience: "desktop_embed",
      userId: "user-1",
      ttlSeconds: 60,
      nowMs,
    });

    assertEquals(issued.expiresIn, 25);
  });
});

Deno.test("embed bridge: rejects expired or malformed tokens", async () => {
  await withMockedEnv(async () => {
    const nowMs = Date.UTC(2026, 3, 20, 12, 0, 0);
    const jwt = makeJwt(Math.floor(nowMs / 1000) + 1800);
    const issued = await issueEmbedBridgeToken({
      accessToken: jwt,
      audience: "desktop_embed",
      userId: "user-1",
      ttlSeconds: 5,
      nowMs,
    });

    assertEquals(await consumeEmbedBridgeToken("not-a-bridge-token", nowMs), null);
    assertEquals(await consumeEmbedBridgeToken(issued.token, nowMs + 6000), null);
  });
});

Deno.test("embed bridge: reads remaining JWT lifetime when exp exists", () => {
  const nowMs = Date.UTC(2026, 3, 20, 12, 0, 0);
  const jwt = makeJwt(Math.floor(nowMs / 1000) + 90);
  assertEquals(getAccessTokenRemainingLifetimeSeconds(jwt, nowMs), 90);
  assertEquals(getAccessTokenRemainingLifetimeSeconds("opaque-token", nowMs), null);
});
