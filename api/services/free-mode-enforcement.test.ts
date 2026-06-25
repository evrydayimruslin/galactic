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

import {
  freeModeNotice,
  functionUsesInference,
  isFreeModeEnabled,
  isFunctionBlockedInFreeMode,
} from "./free-mode.ts";
import { createRuntimeAIContext } from "./runtime-ai.ts";
import { getPlatformTools } from "../handlers/platform-mcp.ts";

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

// ── Discovery filter predicate (tools/list + inspect) ─────────────────

const DISCOVERY_APP = {
  owner_id: "owner-1",
  pricing_config: {
    default_price_light: 0,
    functions: { paidFn: 10 },
  },
  manifest: JSON.stringify({
    permissions: ["ai:call"],
    functions: {
      aiFn: { uses_inference: true },
      plainFn: { uses_inference: false },
    },
  }),
} as unknown as Parameters<typeof isFunctionBlockedInFreeMode>[0];

const callerNoByok = { userId: "caller-1", byokPresent: false };

Deno.test("free mode: discovery hides a paid function", () => {
  assert(isFunctionBlockedInFreeMode(DISCOVERY_APP, "paidFn", callerNoByok));
});

Deno.test("free mode: discovery keeps a free, non-AI function", () => {
  assert(!isFunctionBlockedInFreeMode(DISCOVERY_APP, "plainFn", callerNoByok));
});

Deno.test("free mode: discovery hides an AI function without BYOK, keeps it with BYOK", () => {
  assert(isFunctionBlockedInFreeMode(DISCOVERY_APP, "aiFn", callerNoByok));
  assert(!isFunctionBlockedInFreeMode(DISCOVERY_APP, "aiFn", {
    userId: "caller-1",
    byokPresent: true,
  }));
});

Deno.test("free mode: the owner (self-call) is never filtered", () => {
  assert(!isFunctionBlockedInFreeMode(DISCOVERY_APP, "paidFn", {
    userId: "owner-1",
    byokPresent: false,
  }));
  assert(!isFunctionBlockedInFreeMode(DISCOVERY_APP, "aiFn", {
    userId: "owner-1",
    byokPresent: false,
  }));
});

// ── Phase 3: free-allowance honoring (peek RPC) ───────────────────────

const ALLOWANCE_APP = {
  owner_id: "owner-1",
  pricing_config: {
    default_price_light: 0,
    free_calls_scope: "function",
    functions: { metered: { price_light: 10, free_calls: 3 } },
  },
  manifest: JSON.stringify({ permissions: [], functions: { metered: {} } }),
} as unknown as Parameters<typeof isFunctionBlockedInFreeMode>[0];

Deno.test("free mode: a priced function with free-allowance left stays visible", () => {
  // 2 of 3 free calls used -> the next call is free -> not blocked.
  const usage = new Map([["metered", 2]]);
  assert(!isFunctionBlockedInFreeMode(ALLOWANCE_APP, "metered", callerNoByok, usage));
});

Deno.test("free mode: a priced function with its allowance exhausted is hidden", () => {
  // 3 of 3 used -> the next call would charge -> blocked.
  const usage = new Map([["metered", 3]]);
  assert(isFunctionBlockedInFreeMode(ALLOWANCE_APP, "metered", callerNoByok, usage));
});

Deno.test("free mode: without usage data a priced+allowance function stays hidden", () => {
  // No peek result -> we can't prove headroom -> conservative (Phase-2) hide.
  assert(isFunctionBlockedInFreeMode(ALLOWANCE_APP, "metered", callerNoByok));
  assert(isFunctionBlockedInFreeMode(ALLOWANCE_APP, "metered", callerNoByok, null));
});

Deno.test("free mode: app-scope allowance reads the shared __app__ counter", () => {
  const appScoped = {
    owner_id: "owner-1",
    pricing_config: {
      default_price_light: 10,
      default_free_calls: 5,
      free_calls_scope: "app",
    },
    manifest: JSON.stringify({ permissions: [], functions: { a: {}, b: {} } }),
  } as unknown as Parameters<typeof isFunctionBlockedInFreeMode>[0];
  // 4 shared calls used across the app -> still one free call left for any fn.
  const withHeadroom = new Map([["__app__", 4]]);
  assert(!isFunctionBlockedInFreeMode(appScoped, "a", callerNoByok, withHeadroom));
  assert(!isFunctionBlockedInFreeMode(appScoped, "b", callerNoByok, withHeadroom));
  // 5 used -> shared allowance spent -> every function is now paid.
  const spent = new Map([["__app__", 5]]);
  assert(isFunctionBlockedInFreeMode(appScoped, "a", callerNoByok, spent));
  assert(isFunctionBlockedInFreeMode(appScoped, "b", callerNoByok, spent));
});

// ── Phase 3: module access policies (dynamic pricing) ─────────────────

const MODULE_POLICY_APP = {
  owner_id: "owner-1",
  pricing_config: { default_price_light: 0, functions: {} },
  manifest: JSON.stringify({
    access_policy: { mode: "module", module: "policies/access.ts" },
    functions: { anything: {}, alsoFree: {} },
  }),
} as unknown as Parameters<typeof isFunctionBlockedInFreeMode>[0];

Deno.test("free mode: module-priced apps are hidden even when statically free", () => {
  // Price is decided at call time by dev code; we can't classify it cheaply at
  // discovery, so every function of the app is hidden (fail-safe).
  assert(isFunctionBlockedInFreeMode(MODULE_POLICY_APP, "anything", callerNoByok));
  assert(isFunctionBlockedInFreeMode(MODULE_POLICY_APP, "alsoFree", callerNoByok));
});

Deno.test("free mode: the owner still sees their own module-priced functions", () => {
  assert(!isFunctionBlockedInFreeMode(MODULE_POLICY_APP, "anything", {
    userId: "owner-1",
    byokPresent: false,
  }));
});

// ── Platform tools: codemode drop + the agent notice ──────────────────

Deno.test("free mode: getPlatformTools drops gx.codemode only in free mode", () => {
  const normal = getPlatformTools({ freeMode: false }).map((t) => t.name);
  const free = getPlatformTools({ freeMode: true }).map((t) => t.name);
  assert(normal.includes("gx.codemode"));
  assert(!free.includes("gx.codemode"));
});

Deno.test("free mode: the agent notice states the threshold and a top-up URL", () => {
  const notice = freeModeNotice("https://example.test/account");
  assert(notice.includes("$0.25"));
  assert(notice.includes("https://example.test/account"));
  assert(/free mode/i.test(notice));
});
