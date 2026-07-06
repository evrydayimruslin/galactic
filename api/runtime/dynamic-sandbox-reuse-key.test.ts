// Isolation invariants for the Worker Loader get() reuse key. These are the
// security-critical properties: a warm isolate must NEVER be shared across
// users, and any change to a baked per-user input must mint a fresh key.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertNotEquals } from "https://deno.land/std@0.210.0/assert/assert_not_equals.ts";
import { deriveIsolateReuseKey } from "./dynamic-sandbox.ts";

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
  };
}
const CODE = "export function run(){return 1}";

Deno.test("reuse key: identical inputs → identical key (enables warm reuse)", async () => {
  const a = await deriveIsolateReuseKey(base(), CODE, []);
  const b = await deriveIsolateReuseKey(base(), CODE, []);
  assertEquals(a, b);
  // Shape: appId:bundleHash:userId:fingerprint
  const parts = a.split(":");
  assertEquals(parts[0], "app-1");
  assertEquals(parts[2], "user-A");
  assertEquals(parts[1].length, 64); // sha256 hex
  assertEquals(parts[3].length, 64);
});

Deno.test("reuse key: DIFFERENT USER → different key (never shared across users)", async () => {
  const a = await deriveIsolateReuseKey(base(), CODE, []);
  const other = base();
  other.userId = "user-B";
  other.user = { id: "user-B", tier: "free" };
  const b = await deriveIsolateReuseKey(other, CODE, []);
  assertNotEquals(a, b);
});

Deno.test("reuse key: ROTATED SECRET → different key (no stale-secret reuse)", async () => {
  const a = await deriveIsolateReuseKey(base(), CODE, []);
  const rotated = base();
  rotated.credentials = { API_KEY: { value: "secret-2" } };
  const b = await deriveIsolateReuseKey(rotated, CODE, []);
  assertNotEquals(a, b);
});

Deno.test("reuse key: CODE CHANGE → different key (new version, fresh isolate)", async () => {
  const a = await deriveIsolateReuseKey(base(), CODE, []);
  const b = await deriveIsolateReuseKey(
    base(),
    "export function run(){return 2}",
    [],
  );
  assertNotEquals(a, b);
});

Deno.test("reuse key: GRANT/DEPENDENCY change → different key", async () => {
  const a = await deriveIsolateReuseKey(base(), CODE, []);
  const withDep = base();
  withDep.appCallDependencies = [{ app: "app-2", functions: ["x"] }];
  const b = await deriveIsolateReuseKey(withDep, CODE, []);
  assertNotEquals(a, b);
});

Deno.test("reuse key: BYOK key change → different key", async () => {
  const a = await deriveIsolateReuseKey(base(), CODE, []);
  const byok = base();
  byok.userApiKey = "sk-user-key";
  const b = await deriveIsolateReuseKey(byok, CODE, []);
  assertNotEquals(a, b);
});

Deno.test("reuse key: egress allowlist change → different key", async () => {
  const a = await deriveIsolateReuseKey(base(), CODE, ["api.a.com"]);
  const b = await deriveIsolateReuseKey(base(), CODE, ["api.b.com"]);
  assertNotEquals(a, b);
});

Deno.test("reuse key: permission-order independence (set semantics)", async () => {
  const a = await deriveIsolateReuseKey(base(), CODE, []);
  const reordered = base();
  reordered.permissions = ["ai:call", "storage:read"];
  const b = await deriveIsolateReuseKey(reordered, CODE, []);
  assertEquals(a, b); // same permission SET → same isolate
});
