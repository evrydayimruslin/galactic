import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { filterCodemodeToolMapByAccess } from "./codemode-access.ts";
import type { ToolMapping } from "./codemode-tools.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};

type Handler = (url: URL) => Response;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

Deno.test("codemode access: keeps owned + public, drops non-owned-private without a grant", async () => {
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

Deno.test("codemode access: fails open when the grant store is unreachable", async () => {
  const toolMap: Record<string, ToolMapping> = {
    a: tool("app-1", "fn"),
  };
  // No SUPABASE env => getDbConfig returns null => map returned unchanged.
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
