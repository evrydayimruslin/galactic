import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  mintCallerContextToken,
  verifyCallerContextToken,
} from "./agent-caller-context.ts";

const TEST_ENV = { AGENT_CALLER_SECRET: "caller-secret-1" };

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
  }
}

Deno.test("caller context: mint then verify round-trips identity + hop", async () => {
  await withEnv(async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    const token = await mintCallerContextToken({
      callerAppId: "app-caller",
      userId: "user-1",
      callerFunction: "processOrder",
      incomingHop: 0,
      nowMs,
    });
    const { claims, error } = await verifyCallerContextToken(token, nowMs);
    assertEquals(error, undefined);
    assert(claims !== null);
    assertEquals(claims?.callerAppId, "app-caller");
    assertEquals(claims?.userId, "user-1");
    assertEquals(claims?.callerFunction, "processOrder");
    // incomingHop 0 ⇒ minted hop is 1.
    assertEquals(claims?.hop, 1);
  });
});

Deno.test("caller context: hop increments from the incoming context", async () => {
  await withEnv(async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    const token = await mintCallerContextToken({
      callerAppId: "app-b",
      userId: "user-1",
      incomingHop: 3,
      nowMs,
    });
    const { claims } = await verifyCallerContextToken(token, nowMs);
    assertEquals(claims?.hop, 4);
  });
});

Deno.test("caller context: a tampered signature is rejected", async () => {
  await withEnv(async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    const token = await mintCallerContextToken({
      callerAppId: "app-caller",
      userId: "user-1",
      nowMs,
    });
    // Flip the last character of the signature.
    const tampered = token.slice(0, -1) +
      (token.endsWith("A") ? "B" : "A");
    const { claims, error } = await verifyCallerContextToken(tampered, nowMs);
    assertEquals(claims, null);
    assertEquals(error, "bad_signature");
  });
});

Deno.test("caller context: a forged payload (different signing key) is rejected", async () => {
  const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
  // Mint with an attacker secret (simulating sandbox code that does NOT hold
  // the real AGENT_CALLER_SECRET).
  let forged = "";
  await (async () => {
    const previousEnv = globalThis.__env;
    globalThis.__env = {
      ...(previousEnv || {}),
      AGENT_CALLER_SECRET: "attacker-secret",
    } as typeof globalThis.__env;
    try {
      forged = await mintCallerContextToken({
        callerAppId: "victim-app",
        userId: "victim-user",
        nowMs,
      });
    } finally {
      globalThis.__env = previousEnv;
    }
  })();

  await withEnv(async () => {
    const { claims, error } = await verifyCallerContextToken(forged, nowMs);
    assertEquals(claims, null);
    assertEquals(error, "bad_signature");
  });
});

Deno.test("caller context: expired tokens are rejected", async () => {
  await withEnv(async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    const token = await mintCallerContextToken({
      callerAppId: "app-caller",
      userId: "user-1",
      ttlSeconds: 60,
      nowMs,
    });
    const { claims, error } = await verifyCallerContextToken(
      token,
      nowMs + 61_000,
    );
    assertEquals(claims, null);
    assertEquals(error, "expired");
  });
});

Deno.test("caller context: hop beyond the ceiling is rejected", async () => {
  await withEnv(async () => {
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    // incomingHop 8 ⇒ minted hop 9 > MAX_AGENT_CALL_HOP_DEPTH (8).
    const token = await mintCallerContextToken({
      callerAppId: "app-caller",
      userId: "user-1",
      incomingHop: 8,
      nowMs,
    });
    const { claims, error } = await verifyCallerContextToken(token, nowMs);
    assertEquals(claims, null);
    assertEquals(error, "hop_exceeded");
  });
});

Deno.test("caller context: absent token yields null claims with no error", async () => {
  await withEnv(async () => {
    assertEquals(await verifyCallerContextToken(null), { claims: null });
    assertEquals(await verifyCallerContextToken(""), { claims: null });
    assertEquals(await verifyCallerContextToken("not-a-caller-token"), {
      claims: null,
    });
  });
});
