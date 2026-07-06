// Pure memory-scope helpers, kept free of the `cloudflare:workers` import so the
// key-selection logic (the per-agent isolation fix) is unit-testable in Deno.

// "agent" = this agent's private memory (default). "user" = the shared memory
// the person carries across every agent they run (a deliberate cross-agent
// channel — opt in explicitly).
export type MemoryScope = "agent" | "user";

export function normalizeMemoryScope(scope: unknown): MemoryScope {
  return scope === "user" ? "user" : "agent";
}

/**
 * The R2 object key for a memory notebook.
 *
 * Agent scope isolates this agent's notebook (`apps/{appId}/users/{userId}`) so
 * one agent can't read or clobber another's — it requires an appId, and without
 * one falls back to the shared per-user key (historical behavior). User scope is
 * always the shared per-user notebook the person carries between their agents.
 */
export function resolveMemoryKey(
  scope: MemoryScope,
  userId: string,
  appId?: string | null,
): string {
  if (scope === "agent" && appId) {
    return `apps/${appId}/users/${userId}/memory.md`;
  }
  return `users/${userId}/memory.md`;
}
