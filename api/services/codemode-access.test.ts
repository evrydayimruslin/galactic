import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { filterCodemodeToolMapByAccess } from "./codemode-access.ts";
import type { ToolMapping } from "./codemode-tools.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

type Handler = (url: URL) => Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A health row whose freshest (24h) window is green: enough calls, 100% success,
// >= 2 distinct payers (clears MIN_CALLS / HEALTHY_THRESHOLD / MIN_DISTINCT_PAYERS).
function greenHealth(appId: string) {
  return {
    app_id: appId,
    calls_1h: 0, ok_1h: 0, payers_1h: 0,
    calls_24h: 10, ok_24h: 10, payers_24h: 3,
    calls_7d: 0, ok_7d: 0, payers_7d: 0,
    calls_30d: 0, ok_30d: 0, payers_30d: 0,
  };
}

async function withMockedDb(
  handler: Handler,
  fn: () => Promise<void>,
): Promise<void> {
  const g = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const prevEnv = g.__env;
  const prevFetch = globalThis.fetch;
  g.__env = { ...(prevEnv || {}), ...TEST_ENV };
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(handler(new URL(String(input))))) as typeof fetch;
  try {
    await fn();
  } finally {
    g.__env = prevEnv;
    globalThis.fetch = prevFetch;
  }
}

function tool(appId: string, fnName: string): ToolMapping {
  return { appId, appName: appId, appSlug: appId, fnName };
}

Deno.test("codemode access: keeps owned + healthy public/granted, drops non-owned-private without a grant", async () => {
  const toolMap: Record<string, ToolMapping> = {
    mine: tool("app-owned", "doThing"),
    pub: tool("app-public", "lookup"),
    privGranted: tool("app-priv-ok", "read"),
    privRevoked: tool("app-priv-no", "read"),
  };
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) {
      return jsonResponse([
        { id: "app-owned", owner_id: "user-1", visibility: "private" },
        { id: "app-public", owner_id: "other", visibility: "public" },
        { id: "app-priv-ok", owner_id: "other", visibility: "private" },
        { id: "app-priv-no", owner_id: "other", visibility: "private" },
      ]);
    }
    if (url.pathname.endsWith("/app_health_windows")) {
      // Both non-owned apps the user can reach are healthy.
      return jsonResponse([greenHealth("app-public"), greenHealth("app-priv-ok")]);
    }
    if (url.pathname.endsWith("/user_app_permissions")) {
      // The user holds a live grant only for app-priv-ok.read.
      return jsonResponse([{ app_id: "app-priv-ok", function_name: "read" }]);
    }
    if (url.pathname.endsWith("/user_agent_function_permissions")) {
      return jsonResponse([]);
    }
    return jsonResponse([]);
  };

  await withMockedDb(handler, async () => {
    const filtered = await filterCodemodeToolMapByAccess("user-1", toolMap);
    assertEquals(Object.keys(filtered).sort(), ["mine", "privGranted", "pub"]);
  });
});

Deno.test("codemode access: health overlay drops a non-owned app that is not recently healthy", async () => {
  const toolMap: Record<string, ToolMapping> = {
    mine: tool("app-owned", "doThing"),
    healthyPub: tool("app-public-green", "lookup"),
    unprovenPub: tool("app-public-nodata", "lookup"),
  };
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) {
      return jsonResponse([
        { id: "app-owned", owner_id: "user-1", visibility: "private" },
        { id: "app-public-green", owner_id: "other", visibility: "public" },
        { id: "app-public-nodata", owner_id: "other", visibility: "public" },
      ]);
    }
    if (url.pathname.endsWith("/app_health_windows")) {
      // Only the green app is reported; the other is absent => no_data => dropped.
      return jsonResponse([greenHealth("app-public-green")]);
    }
    if (url.pathname.endsWith("/user_app_permissions")) return jsonResponse([]);
    if (url.pathname.endsWith("/user_agent_function_permissions")) {
      return jsonResponse([]);
    }
    return jsonResponse([]);
  };

  await withMockedDb(handler, async () => {
    const filtered = await filterCodemodeToolMapByAccess("user-1", toolMap);
    // Owned stays (health-exempt); the unproven non-owned public app is dropped.
    assertEquals(Object.keys(filtered).sort(), ["healthyPub", "mine"]);
  });
});

Deno.test("codemode access: drops an explicit connected-agent 'never' even on an owned app", async () => {
  const toolMap: Record<string, ToolMapping> = {
    keep: tool("app-owned", "safe"),
    blocked: tool("app-owned", "sendEmail"),
  };
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) {
      return jsonResponse([
        { id: "app-owned", owner_id: "user-1", visibility: "private" },
      ]);
    }
    if (url.pathname.endsWith("/user_app_permissions")) return jsonResponse([]);
    if (url.pathname.endsWith("/user_agent_function_permissions")) {
      return jsonResponse([{ app_id: "app-owned", function_name: "sendEmail" }]);
    }
    return jsonResponse([]);
  };

  await withMockedDb(handler, async () => {
    const filtered = await filterCodemodeToolMapByAccess("user-1", toolMap);
    assertEquals(Object.keys(filtered), ["keep"]);
  });
});

Deno.test("codemode access: fails CLOSED when the app authorization lookup errors", async () => {
  const toolMap: Record<string, ToolMapping> = {
    mine: tool("app-owned", "doThing"),
    pub: tool("app-public", "lookup"),
  };
  // The apps query hard-fails (500). We cannot authorize anything => drop all,
  // including the user's OWN app (ownership itself is unverifiable here).
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) return jsonResponse({ error: "boom" }, 500);
    return jsonResponse([]);
  };

  await withMockedDb(handler, async () => {
    const filtered = await filterCodemodeToolMapByAccess("user-1", toolMap);
    assertEquals(Object.keys(filtered), []);
  });
});

Deno.test("codemode access: fails CLOSED when the 'never' prohibition lookup errors", async () => {
  const toolMap: Record<string, ToolMapping> = {
    mine: tool("app-owned", "doThing"),
  };
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) {
      return jsonResponse([
        { id: "app-owned", owner_id: "user-1", visibility: "private" },
      ]);
    }
    // Can't read the user's "never" set => can't guarantee we honor blocks.
    if (url.pathname.endsWith("/user_agent_function_permissions")) {
      return jsonResponse({ error: "boom" }, 503);
    }
    return jsonResponse([]);
  };

  await withMockedDb(handler, async () => {
    const filtered = await filterCodemodeToolMapByAccess("user-1", toolMap);
    assertEquals(Object.keys(filtered), []);
  });
});

Deno.test("codemode access: passes through when no store is configured (local/test)", async () => {
  const toolMap: Record<string, ToolMapping> = {
    a: tool("app-1", "fn"),
  };
  // No SUPABASE env => getDbConfig returns null => nothing to authorize against.
  const g = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const prevEnv = g.__env;
  g.__env = { ...(prevEnv || {}), SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" };
  try {
    const filtered = await filterCodemodeToolMapByAccess("user-1", toolMap);
    assertEquals(Object.keys(filtered), ["a"]);
  } finally {
    g.__env = prevEnv;
  }
});
