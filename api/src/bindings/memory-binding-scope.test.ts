// Regression tests for per-agent memory scoping. Before this, the runtime
// MemoryBinding keyed on userId only, so every agent a user ran shared one
// memory.md and could clobber another agent's sections. Agent scope is now the
// default; the shared per-user notebook is opt-in via scope:"user".

import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  normalizeMemoryScope,
  resolveMemoryKey,
} from "./memory-scope.ts";

Deno.test("resolveMemoryKey: agent scope isolates per (app,user)", () => {
  assertEquals(
    resolveMemoryKey("agent", "user-1", "app-a"),
    "apps/app-a/users/user-1/memory.md",
  );
  // Two agents, same user, agent scope => distinct notebooks (the fix).
  assertEquals(
    resolveMemoryKey("agent", "user-1", "app-b"),
    "apps/app-b/users/user-1/memory.md",
  );
});

Deno.test("resolveMemoryKey: user scope is the shared cross-agent notebook", () => {
  // Same key regardless of appId — this is the deliberate cross-agent channel.
  assertEquals(
    resolveMemoryKey("user", "user-1", "app-a"),
    "users/user-1/memory.md",
  );
  assertEquals(
    resolveMemoryKey("user", "user-1", "app-b"),
    "users/user-1/memory.md",
  );
});

Deno.test("resolveMemoryKey: agent scope without an appId falls back to the shared key", () => {
  // Defensive: never throw for a missing appId — degrade to historical behavior.
  assertEquals(
    resolveMemoryKey("agent", "user-1", null),
    "users/user-1/memory.md",
  );
  assertEquals(
    resolveMemoryKey("agent", "user-1", undefined),
    "users/user-1/memory.md",
  );
});

Deno.test("normalizeMemoryScope: defaults to agent, only 'user' opts into sharing", () => {
  assertEquals(normalizeMemoryScope(undefined), "agent");
  assertEquals(normalizeMemoryScope(null), "agent");
  assertEquals(normalizeMemoryScope("agent"), "agent");
  assertEquals(normalizeMemoryScope("nonsense"), "agent");
  assertEquals(normalizeMemoryScope("user"), "user");
});
