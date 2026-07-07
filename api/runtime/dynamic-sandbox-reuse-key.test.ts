// Isolation invariants for the Worker Loader get() reuse key. These are the
// security-critical properties: a warm isolate must NEVER be shared across
// users, and any change to a baked per-user input must mint a fresh key.
// The caller-context token is the one deliberate exception: its PRESENCE is
// fingerprinted (it decides whether the EVENTS binding exists) but its VALUE
// is per-call and rides the fetch body — otherwise reuse would never hit.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertNotEquals } from "https://deno.land/std@0.210.0/assert/assert_not_equals.ts";
import {
  deriveIsolateReuseKey,
  isolateReuseEligibility,
} from "./dynamic-sandbox.ts";

// deno-lint-ignore no-explicit-any
function base(): any {
  return {
    appId: "app-1",
    userId: "user-A",
    user: { id: "user-A", tier: "free" },
    envVars: { FOO: "bar" },
    permissions: ["storage:read", "ai:call"],
    credentials: { API_KEY: { value: "secret-1" } },
    appCallDependencies: [],
    slotBindings: [],
    userApiKey: null,
    aiRoute: null,
    aiUnavailableReason: null,
    callerContextToken: "gxc1.token-call-1.sig",
    supabase: undefined,
    baseUrl: "https://api.test.dev",
    workerBaseUrl: "https://api.test.dev",
  };
}
const CODE = "export function run(){return 1}";
// Default baked binding-set state (no DB/MEMORY wired).
const BS = { dbId: null, hasDb: false, hasMemory: false };
// deno-lint-ignore no-explicit-any
const derive = (cfg: any, code = CODE, dests: unknown = [], bs = BS) =>
  deriveIsolateReuseKey(cfg, code, dests, bs);

Deno.test("reuse key: identical inputs → identical key (enables warm reuse)", async () => {
  const a = await derive(base());
  const b = await derive(base());
  assertEquals(a, b);
  // Shape: appId:bundleHash:userId:fingerprint
  const parts = a.split(":");
  assertEquals(parts[0], "app-1");
  assertEquals(parts[2], "user-A");
  assertEquals(parts[1].length, 64); // sha256 hex
  assertEquals(parts[3].length, 64);
});

Deno.test("reuse key: DIFFERENT USER → different key (never shared across users)", async () => {
  const a = await derive(base());
  const other = base();
  other.userId = "user-B";
  other.user = { id: "user-B", tier: "free" };
  const b = await derive(other);
  assertNotEquals(a, b);
});

Deno.test("reuse key: ROTATED SECRET → different key (no stale-secret reuse)", async () => {
  const a = await derive(base());
  const rotated = base();
  rotated.credentials = { API_KEY: { value: "secret-2" } };
  const b = await derive(rotated);
  assertNotEquals(a, b);
});

Deno.test("reuse key: CODE CHANGE → different key (new version, fresh isolate)", async () => {
  const a = await derive(base());
  const b = await derive(base(), "export function run(){return 2}");
  assertNotEquals(a, b);
});

Deno.test("reuse key: GRANT/DEPENDENCY change → different key", async () => {
  const a = await derive(base());
  const withDep = base();
  withDep.appCallDependencies = [{ app: "app-2", functions: ["x"] }];
  const b = await derive(withDep);
  assertNotEquals(a, b);
});

Deno.test("reuse key: BYOK key change → different key", async () => {
  const a = await derive(base());
  const byok = base();
  byok.userApiKey = "sk-user-key";
  const b = await derive(byok);
  assertNotEquals(a, b);
});

Deno.test("reuse key: egress allowlist change → different key", async () => {
  const a = await derive(base(), CODE, ["api.a.com"]);
  const b = await derive(base(), CODE, ["api.b.com"]);
  assertNotEquals(a, b);
});

Deno.test("reuse key: permission-order independence (set semantics)", async () => {
  const a = await derive(base());
  const reordered = base();
  reordered.permissions = ["ai:call", "storage:read"];
  const b = await derive(reordered);
  assertEquals(a, b); // same permission SET → same isolate
});

Deno.test("reuse key: caller-context token VALUE does NOT change the key (per-call, rides the body)", async () => {
  const a = await derive(base());
  const other = base();
  other.callerContextToken = "gxc1.token-call-2-different-hop.sig";
  const b = await derive(other);
  // Same presence, different value → SAME key. Otherwise every call would
  // mint a fresh isolate (the token embeds per-call hop/function/expiry)
  // and reuse would never hit.
  assertEquals(a, b);
});

Deno.test("reuse key: caller-context token PRESENCE changes the key (EVENTS binding existence is baked)", async () => {
  const a = await derive(base());
  const absent = base();
  absent.callerContextToken = undefined;
  const b = await derive(absent);
  assertNotEquals(a, b);
});

Deno.test("reuse key: AI route / unavailable-reason change → different key", async () => {
  const a = await derive(base());
  const routed = base();
  routed.aiRoute = { provider: "openrouter", baseUrl: "https://x", apiKey: "k", model: "m" };
  const b = await derive(routed);
  assertNotEquals(a, b);
  const unavailable = base();
  unavailable.aiUnavailableReason = "insufficient balance";
  const c = await derive(unavailable);
  assertNotEquals(a, c);
});

Deno.test("reuse key: envVars change → different key", async () => {
  const a = await derive(base());
  const changed = base();
  changed.envVars = { FOO: "baz" };
  const b = await derive(changed);
  assertNotEquals(a, b);
});

Deno.test("reuse key: D1 databaseId change → different key (no split-database writes on re-provision)", async () => {
  const a = await derive(base(), CODE, [], {
    dbId: "db-old",
    hasDb: true,
    hasMemory: false,
  });
  const b = await derive(base(), CODE, [], {
    dbId: "db-new",
    hasDb: true,
    hasMemory: false,
  });
  assertNotEquals(a, b);
});

Deno.test("reuse key: DB / MEMORY binding-set presence changes the key (no sticky 'not available')", async () => {
  const none = await derive(base(), CODE, [], {
    dbId: null,
    hasDb: false,
    hasMemory: false,
  });
  const withDb = await derive(base(), CODE, [], {
    dbId: "db-1",
    hasDb: true,
    hasMemory: false,
  });
  const withMem = await derive(base(), CODE, [], {
    dbId: null,
    hasDb: false,
    hasMemory: true,
  });
  assertNotEquals(none, withDb);
  assertNotEquals(none, withMem);
  assertNotEquals(withDb, withMem);
});

// ── Eligibility gates (independent of the rollout flag) ──

// deno-lint-ignore no-explicit-any
function eligBase(over: Record<string, unknown> = {}): any {
  return {
    userId: "user-A",
    d1Fixtures: null,
    permissions: ["storage:read"],
    appCallDependencies: [],
    slotBindings: [],
    ...over,
  };
}

Deno.test("eligibility: real user, no fixtures, no cross-agent calls → eligible", () => {
  const v = isolateReuseEligibility(eligBase());
  assert(v.eligible);
});

Deno.test("eligibility: ANONYMOUS user → ineligible (shared sentinel id must never warm-reuse)", () => {
  const anon = isolateReuseEligibility(
    eligBase({ userId: "00000000-0000-0000-0000-000000000000" }),
  );
  assertEquals(anon.eligible, false);
  assertEquals(anon.reason, "anonymous_user");
  const missing = isolateReuseEligibility(eligBase({ userId: "" }));
  assertEquals(missing.eligible, false);
});

Deno.test("eligibility: fixture-backed execution (gx.test) → ineligible (per-call fixtures are baked)", () => {
  const v = isolateReuseEligibility(eligBase({ d1Fixtures: { tables: {} } }));
  assertEquals(v.eligible, false);
  assertEquals(v.reason, "fixture_execution");
});

Deno.test("eligibility: cross-Agent-call-capable → ineligible (hop ceiling / grants under shared globalThis)", () => {
  // app:call permission
  const broad = isolateReuseEligibility(
    eligBase({ permissions: ["storage:read", "app:call"] }),
  );
  assertEquals(broad.eligible, false);
  assertEquals(broad.reason, "cross_agent_call_capable");
  // a declared call dependency (scoped cross-Agent grant)
  const dep = isolateReuseEligibility(
    eligBase({ appCallDependencies: [{ app: "other", functions: ["fn"] }] }),
  );
  assertEquals(dep.eligible, false);
  assertEquals(dep.reason, "cross_agent_call_capable");
  // a wired slot
  const slot = isolateReuseEligibility(
    eligBase({
      slotBindings: [{ slot: "s", targetAppId: "other", functions: ["fn"] }],
    }),
  );
  assertEquals(slot.eligible, false);
  assertEquals(slot.reason, "cross_agent_call_capable");
});
