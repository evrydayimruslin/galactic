import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertThrows } from "https://deno.land/std@0.210.0/assert/assert_throws.ts";

import { resolveInternalMcpCall } from "./internal-mcp.ts";

function withEnv<T>(env: Record<string, unknown>, fn: () => T): T {
  const previous = globalThis.__env;
  globalThis.__env = env as typeof globalThis.__env;
  try {
    return fn();
  } finally {
    globalThis.__env = previous;
  }
}

Deno.test("internal-mcp: routes via SELF with an encoded internal URL when bound", () => {
  const calls: string[] = [];
  const self = {
    fetch(input: RequestInfo | URL) {
      calls.push(String(input));
      return Promise.resolve(new Response("{}"));
    },
  };
  withEnv({ SELF: self }, () => {
    const call = resolveInternalMcpCall("app id..x", {
      baseUrl: "https://public.example",
    });
    assert(call.url.startsWith("https://internal/mcp/"));
    // Encoded: the space must not survive raw.
    assertEquals(call.url, "https://internal/mcp/app%20id..x");
  });
});

Deno.test("internal-mcp: falls back to the public base URL when SELF is unbound", () => {
  withEnv({}, () => {
    const call = resolveInternalMcpCall("app-1", {
      baseUrl: "https://api.example.test/",
    });
    assertEquals(call.url, "https://api.example.test/mcp/app-1");
    assertEquals(call.fetchFn, fetch);
  });
});

Deno.test("internal-mcp: a provided fetchFn wins over global fetch in fallback", () => {
  const fetchFn = (() => Promise.resolve(new Response("{}"))) as typeof fetch;
  withEnv({}, () => {
    const call = resolveInternalMcpCall("app-1", {
      baseUrl: "https://api.example.test",
      fetchFn,
    });
    assertEquals(call.fetchFn, fetchFn);
  });
});

Deno.test("internal-mcp: rejects the platform endpoint and path-shaped ids", () => {
  withEnv({}, () => {
    // "platform" would re-enter the platform handler: an unmetered
    // self-recursion outside the cross-Agent hop ceiling.
    assertThrows(() =>
      resolveInternalMcpCall("platform", { baseUrl: "https://x" })
    );
    assertThrows(() =>
      resolveInternalMcpCall("../api/run/x", { baseUrl: "https://x" })
    );
    assertThrows(() =>
      resolveInternalMcpCall("a?b", { baseUrl: "https://x" })
    );
    assertThrows(() => resolveInternalMcpCall("", { baseUrl: "https://x" }));
  });
});

Deno.test("internal-mcp: SELF without a fetch function is treated as unbound", () => {
  withEnv({ SELF: { notFetch: true } }, () => {
    const call = resolveInternalMcpCall("app-1", {
      baseUrl: "https://api.example.test",
    });
    assertEquals(call.url, "https://api.example.test/mcp/app-1");
  });
});
