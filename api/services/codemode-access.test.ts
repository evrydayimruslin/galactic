import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  authorizeCodemodeToolMapByAccess,
  filterCodemodeToolMapByAccess,
} from "./codemode-access.ts";
import type { ToolMapping } from "./codemode-tools.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://db.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
};
const RELEASE_DIGEST = "a".repeat(64);

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
    calls_1h: 0,
    ok_1h: 0,
    payers_1h: 0,
    calls_24h: 10,
    ok_24h: 10,
    payers_24h: 3,
    calls_7d: 0,
    ok_7d: 0,
    payers_7d: 0,
    calls_30d: 0,
    ok_30d: 0,
    payers_30d: 0,
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
  globalThis.fetch =
    ((input: RequestInfo | URL) =>
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

function appRow(
  id: string,
  ownerId: string,
  visibility: "private" | "public" | "unlisted" = "private",
  lifecycle: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    owner_id: ownerId,
    visibility,
    deployment_state: "legacy",
    hosting_suspended: false,
    current_version: "1.0.0",
    active_release_digest: null,
    ...lifecycle,
  };
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
        appRow("app-owned", "user-1"),
        appRow("app-public", "other", "public"),
        appRow("app-priv-ok", "other"),
        appRow("app-priv-no", "other"),
      ]);
    }
    if (url.pathname.endsWith("/app_health_windows")) {
      // Both non-owned apps the user can reach are healthy.
      return jsonResponse([
        greenHealth("app-public"),
        greenHealth("app-priv-ok"),
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

Deno.test("codemode access: health overlay drops a non-owned app that is not recently healthy", async () => {
  const toolMap: Record<string, ToolMapping> = {
    mine: tool("app-owned", "doThing"),
    healthyPub: tool("app-public-green", "lookup"),
    unprovenPub: tool("app-public-nodata", "lookup"),
  };
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) {
      return jsonResponse([
        appRow("app-owned", "user-1"),
        appRow("app-public-green", "other", "public"),
        appRow("app-public-nodata", "other", "public"),
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
        appRow("app-owned", "user-1"),
      ]);
    }
    if (url.pathname.endsWith("/user_app_permissions")) return jsonResponse([]);
    if (url.pathname.endsWith("/user_agent_function_permissions")) {
      return jsonResponse([{
        app_id: "app-owned",
        function_name: "sendEmail",
      }]);
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
    if (url.pathname.endsWith("/apps")) {
      return jsonResponse({ error: "boom" }, 500);
    }
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
        appRow("app-owned", "user-1"),
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

Deno.test("codemode access: owned Agents execute only in runnable, unsuspended lifecycle states", async () => {
  const toolMap: Record<string, ToolMapping> = {
    legacy: tool("app-legacy", "run"),
    ready: tool("app-ready", "run"),
    setupRequired: tool("app-setup", "run"),
    materializing: tool("app-materializing", "run"),
    disabled: tool("app-disabled", "run"),
    unknown: tool("app-unknown", "run"),
    missing: tool("app-missing", "run"),
    missingVersion: tool("app-missing-version", "run"),
    missingDigest: tool("app-missing-digest", "run"),
    missingSuspension: tool("app-missing-suspension", "run"),
    suspended: tool("app-suspended", "run"),
  };
  let selectedLifecycle = false;
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) {
      const select = url.searchParams.get("select") ?? "";
      selectedLifecycle = select.includes("deployment_state") &&
        select.includes("hosting_suspended") &&
        select.includes("current_version") &&
        select.includes("active_release_digest");
      return jsonResponse([
        appRow("app-legacy", "user-1"),
        appRow("app-ready", "user-1", "private", {
          deployment_state: "ready",
          active_release_digest: RELEASE_DIGEST,
        }),
        appRow("app-setup", "user-1", "private", {
          deployment_state: "setup_required",
        }),
        appRow("app-materializing", "user-1", "private", {
          deployment_state: "materializing",
        }),
        appRow("app-disabled", "user-1", "private", {
          deployment_state: "disabled",
        }),
        appRow("app-unknown", "user-1", "private", {
          deployment_state: "future_state",
        }),
        appRow("app-missing", "user-1", "private", {
          deployment_state: undefined,
        }),
        appRow("app-missing-version", "user-1", "private", {
          deployment_state: "ready",
          current_version: undefined,
          active_release_digest: RELEASE_DIGEST,
        }),
        appRow("app-missing-digest", "user-1", "private", {
          deployment_state: "ready",
        }),
        appRow("app-missing-suspension", "user-1", "private", {
          hosting_suspended: undefined,
        }),
        appRow("app-suspended", "user-1", "private", {
          deployment_state: "ready",
          hosting_suspended: true,
          active_release_digest: RELEASE_DIGEST,
        }),
      ]);
    }
    if (url.pathname.endsWith("/user_app_permissions")) {
      return jsonResponse([]);
    }
    if (url.pathname.endsWith("/user_agent_function_permissions")) {
      return jsonResponse([]);
    }
    return jsonResponse([]);
  };

  await withMockedDb(handler, async () => {
    const access = await authorizeCodemodeToolMapByAccess("user-1", toolMap);
    const filtered = access.toolMap;
    assertEquals(selectedLifecycle, true);
    assertEquals(Object.keys(filtered).sort(), ["legacy", "ready"]);
    assertEquals(access.releases, {
      "app-legacy": {
        deploymentState: "legacy",
        version: null,
        releaseDigest: null,
      },
      "app-ready": {
        deploymentState: "ready",
        version: "1.0.0",
        releaseDigest: RELEASE_DIGEST,
      },
    });
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
  g.__env = {
    ...(prevEnv || {}),
    ENVIRONMENT: "test",
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
  };
  try {
    const access = await authorizeCodemodeToolMapByAccess("user-1", toolMap);
    assertEquals(Object.keys(access.toolMap), ["a"]);
    assertEquals(access.authorities.a, {
      databaseRead: false,
      databaseWrite: false,
      storageRead: false,
      storageWrite: false,
      storageDelete: false,
    });
  } finally {
    g.__env = prevEnv;
  }
});

Deno.test("codemode access: missing store fails closed outside explicit local/test", async () => {
  const toolMap: Record<string, ToolMapping> = {
    a: tool("app-1", "fn"),
  };
  const g = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const prevEnv = g.__env;
  g.__env = {
    ...(prevEnv || {}),
    ENVIRONMENT: "production",
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
  };
  try {
    const access = await authorizeCodemodeToolMapByAccess("user-1", toolMap);
    assertEquals(access, {
      toolMap: {},
      releases: {},
      authorities: {},
    });
  } finally {
    g.__env = prevEnv;
  }
});

Deno.test("codemode access: compiles an exact authority ceiling per function", async () => {
  const toolMap: Record<string, ToolMapping> = {
    inspect: tool("app-owned", "inspect"),
    mutate: tool("app-owned", "mutate"),
  };
  const manifest = JSON.stringify({
    name: "Authority Agent",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    permissions: ["storage:read", "storage:write", "storage:delete"],
    functions: {
      inspect: {
        description: "Inspect state",
        authority: {
          level: "read",
          effects: {
            "database.read": "free",
            "storage.read": "free",
          },
        },
      },
      mutate: {
        description: "Mutate state",
        authority: {
          level: "internal_write",
          effects: {
            "database.write": "free",
            "storage.write": "free",
            "storage.delete": "free",
          },
        },
      },
    },
  });
  const handler: Handler = (url) => {
    if (url.pathname.endsWith("/apps")) {
      return jsonResponse([
        appRow("app-owned", "user-1", "private", { manifest }),
      ]);
    }
    if (url.pathname.endsWith("/user_app_permissions")) {
      return jsonResponse([]);
    }
    if (url.pathname.endsWith("/user_agent_function_permissions")) {
      return jsonResponse([]);
    }
    return jsonResponse([]);
  };

  await withMockedDb(handler, async () => {
    const access = await authorizeCodemodeToolMapByAccess("user-1", toolMap);
    assertEquals(access.authorities.inspect, {
      databaseRead: true,
      databaseWrite: false,
      storageRead: true,
      storageWrite: false,
      storageDelete: false,
    });
    assertEquals(access.authorities.mutate, {
      databaseRead: false,
      databaseWrite: true,
      storageRead: false,
      storageWrite: true,
      storageDelete: true,
    });
  });
});
