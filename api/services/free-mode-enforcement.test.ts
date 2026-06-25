/**
 * Free Mode — Phase 1 enforcement tests (docs/FREE_MODE_DESIGN.md).
 *
 * Covers the inference-detection reader, the enforcement flag, and the
 * route-level fail-closed gate. The preflight paid/AI gates are covered in
 * execution-settlement.test.ts; the SQL paid-call gate is exercised by the
 * migration apply + the free_mode_blocked -> verdict mapping test there.
 */

import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";

import { functionUsesInference, isFreeModeEnabled } from "./free-mode.ts";
import { createRuntimeAIContext } from "./runtime-ai.ts";

function withEnv<T>(
  env: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const g = globalThis as typeof globalThis & { __env?: Record<string, unknown> };
  const prev = g.__env;
  g.__env = { ...(prev || {}), ...env };
  return (async () => {
    try {
      return await fn();
    } finally {
      g.__env = prev;
    }
  })();
}

const AI_MANIFEST = JSON.stringify({
  permissions: ["ai:call"],
  functions: { chat: { uses_inference: true }, plain: { uses_inference: false } },
});
const NON_AI_MANIFEST = JSON.stringify({
  permissions: ["storage:read"],
  functions: { get: {} },
});
const LEGACY_AI_MANIFEST = JSON.stringify({
  permissions: ["ai:call"],
  functions: { legacy: {} },
});

// ── functionUsesInference (the AI gate's decision) ────────────────────

Deno.test("free mode: functionUsesInference reads the explicit per-function flag", () => {
  assertEquals(functionUsesInference(AI_MANIFEST, "chat"), true);
  assertEquals(functionUsesInference(AI_MANIFEST, "plain"), false);
});

Deno.test("free mode: functionUsesInference is false when the app has no ai:call", () => {
  assertEquals(functionUsesInference(NON_AI_MANIFEST, "get"), false);
});

Deno.test("free mode: functionUsesInference backfills ai:call apps with no flag as true", () => {
  // Old manifest: app declares ai:call but the function carries no flag.
  assertEquals(functionUsesInference(LEGACY_AI_MANIFEST, "legacy"), true);
  // Unknown function in an ai:call app is also conservative.
  assertEquals(functionUsesInference(AI_MANIFEST, "missing"), true);
});

// ── isFreeModeEnabled (the master switch, default OFF) ─────────────────

Deno.test("free mode: enforcement flag is off by default and parses truthy values", async () => {
  await withEnv({ FREE_MODE: "" }, () => assertEquals(isFreeModeEnabled(), false));
  await withEnv({ FREE_MODE: "off" }, () => assertEquals(isFreeModeEnabled(), false));
  await withEnv({ FREE_MODE: "1" }, () => assertEquals(isFreeModeEnabled(), true));
  await withEnv({ FREE_MODE: "true" }, () => assertEquals(isFreeModeEnabled(), true));
});

// ── Route-level fail-closed gate (runtime-ai) ─────────────────────────

Deno.test("free mode: inference route fails CLOSED on a balance-read error", async () => {
  await withEnv({ FREE_MODE: "1" }, async () => {
    const ctx = await createRuntimeAIContext(
      { id: "u1", email: "u@test" },
      {
        freeMode: true,
        resolveRoute: async () => ({ shouldRequireBalance: true } as never),
        checkBalance: async () => {
          throw new Error("billing read down");
        },
      },
    );
    assertEquals(ctx.route, null);
    assert(ctx.unavailableReason);
  });
});

Deno.test("free mode: route gate is not engaged when the flag is off", async () => {
  // Flag off -> the free-mode fail-closed branch must not fire; a read error
  // falls through to the normal fail-open path (route resolves).
  await withEnv({ FREE_MODE: "0" }, async () => {
    let proceeded = false;
    await createRuntimeAIContext(
      { id: "u1", email: "u@test" },
      {
        freeMode: true,
        resolveRoute: async () => {
          proceeded = true;
          return { shouldRequireBalance: false } as never;
        },
        checkBalance: async () => 0,
      },
    );
    assert(proceeded);
  });
});
