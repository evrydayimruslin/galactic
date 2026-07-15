// Integration coverage for the cross-Agent grant chokepoint in handleMcp /
// handleToolsCall (Phase 4a). Drives the real handler with a signed
// X-Galactic-Caller header and asserts the deny / fail-closed branches that
// return before sandbox execution — the security-critical surface.

import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";

import { handleMcp } from "./mcp.ts";
import { mintCallerContextToken } from "../services/agent-caller-context.ts";
import { createRoutineActorToken } from "../services/routine-auth.ts";
import { createSandboxActorToken } from "../services/sandbox-actor.ts";

const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const CALLER_APP_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const USER_TOKEN = "session-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface HarnessOptions {
  grants?: unknown[];
  onPending?: (body: unknown) => void;
}

function installHarness(options: HarnessOptions = {}): () => void {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env
    ? { ...globalThis.__env as Record<string, unknown> }
    : undefined;

  const app = {
    id: TARGET_ID,
    owner_id: OWNER_ID,
    slug: "inventory",
    name: "Inventory",
    description: "Stock levels.",
    visibility: "public",
    runtime: "deno",
    app_type: "mcp",
    storage_key: "apps/inventory",
    exports: ["getStock"],
    manifest: JSON.stringify({
      name: "Inventory",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: { getStock: { description: "Get stock", parameters: {} } },
    }),
    pricing_config: { default_price_light: 0 },
    rate_limit_config: null,
  };
  const user = {
    id: USER_ID,
    email: "operator@example.com",
    tier: "pro",
    byok_enabled: false,
    byok_provider: null,
    byok_keys: null,
  };

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SUPABASE_ANON_KEY: "anon-key",
    AGENT_CALLER_SECRET: "agent-caller-secret",
    ROUTINE_ACTOR_TOKEN_SECRET: "routine-actor-secret",
    BASE_URL: "https://ultralight.test",
    ENVIRONMENT: "test",
  } as typeof globalThis.__env;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url || String(input));
    const method = init?.method || request?.method || "GET";
    const p = url.pathname;

    if (p === "/auth/v1/user") {
      return jsonResponse({ id: USER_ID, email: user.email, user_metadata: {} });
    }
    if (p === "/rest/v1/users") return jsonResponse([user]);
    if (p === "/rest/v1/apps" && method === "GET") return jsonResponse([app]);
    if (p === "/rest/v1/agent_function_grants" && method === "GET") {
      return jsonResponse(options.grants ?? []);
    }
    if (p === "/rest/v1/agent_function_grants" && method === "POST") {
      options.onPending?.(JSON.parse(String(init?.body)));
      return jsonResponse([{ id: "pending-1" }]);
    }
    // Permissive defaults for rate-limit / weekly-call / misc gates so the
    // call reaches the grant chokepoint without enumerating every gate.
    if (p.startsWith("/rest/v1/rpc/")) return jsonResponse(true);
    return jsonResponse([]);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
    if (originalEnv) globalThis.__env = originalEnv as typeof globalThis.__env;
  };
}

async function callTarget(
  callerHeader: string | null,
  fnName = "getStock",
  bearer = USER_TOKEN,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${bearer}`,
    "Content-Type": "application/json",
  };
  if (callerHeader) headers["X-Galactic-Caller"] = callerHeader;
  const response = await handleMcp(
    new Request(`https://ultralight.test/mcp/${TARGET_ID}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "t1",
        method: "tools/call",
        params: { name: fnName, arguments: {} },
      }),
    }),
    TARGET_ID,
  );
  return await response.json() as Record<string, unknown>;
}

Deno.test("chokepoint: signed actors cannot bypass manifest bindings through synthetic SDK tools", async () => {
  const cleanup = installHarness();
  try {
    const { token: routineToken } = await createRoutineActorToken({
      user: { id: USER_ID, email: "operator@example.com", tier: "pro" },
      routine: {
        id: "routine-1",
        composerAppId: TARGET_ID,
        composerAppSlug: "inventory",
        handlerFunction: "getStock",
      },
      routineRunId: "run-1",
      traceId: "trace-1",
      tokenId: "routine-token-1",
      capabilities: [],
    });
    const { token: sandboxToken } = await createSandboxActorToken({
      user: { id: USER_ID, email: "operator@example.com", tier: "pro" },
      appId: TARGET_ID,
      allowedAppIds: [TARGET_ID],
      executionId: "sandbox-exec-1",
      routineContext: {
        routineId: "routine-1",
        routineRunId: "run-1",
        traceId: "trace-1",
      },
      routineCapabilities: [],
    });
    const sandboxCallerContext = await mintCallerContextToken({
      callerAppId: TARGET_ID,
      userId: USER_ID,
      callerFunction: "getStock",
    });

    for (
      const actor of [
        { bearer: routineToken, callerHeader: null },
        { bearer: sandboxToken, callerHeader: sandboxCallerContext },
      ]
    ) {
      for (
        const tool of [
          "ultralight.ai",
          "ultralight.store",
          "ultralight.remove",
          "ultralight.remember",
        ]
      ) {
        const body = await callTarget(
          actor.callerHeader,
          tool,
          actor.bearer,
        );
        const rpcError = body.error as {
          code?: number;
          data?: { type?: string };
        };
        assertEquals(rpcError.code, -32003);
        assertEquals(rpcError.data?.type, "ACTOR_SDK_TOOL_FORBIDDEN");
      }
    }

    // A tenant export remains on the normal self-call path. It may fail later
    // in this intentionally execution-free harness, but never at the SDK gate.
    const tenantCall = await callTarget(
      sandboxCallerContext,
      "getStock",
      sandboxToken,
    );
    const tenantError = tenantCall.error as {
      data?: { type?: string };
    } | undefined;
    assert(tenantError?.data?.type !== "ACTOR_SDK_TOOL_FORBIDDEN");
    assert(tenantError?.data?.type !== "ROUTINE_CAPABILITY_REQUIRED");
  } finally {
    cleanup();
  }
});

function activeGrantRow() {
  return {
    id: "grant-1",
    user_id: USER_ID,
    caller_app_id: CALLER_APP_ID,
    caller_function: "",
    slot: "",
    target_app_id: TARGET_ID,
    target_function: "getStock",
    mode: "call",
    status: "active",
    monthly_cap_credits: 500,
    spent_credits_period: 0,
    period_start: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    constraints: {},
    created_by: "user",
    created_at: new Date(Date.UTC(2026, 5, 1)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 5, 1)).toISOString(),
  };
}

Deno.test("chokepoint: ungranted cross-Agent call is denied and seeds a pending request", async () => {
  let pending: unknown = null;
  const cleanup = installHarness({
    grants: [],
    onPending: (b) => (pending = b),
  });
  try {
    const token = await mintCallerContextToken({
      callerAppId: CALLER_APP_ID,
      userId: USER_ID,
      callerFunction: "processOrder",
    });
    const body = await callTarget(token);
    const error = body.error as { code: number; data?: { type?: string } };
    assertEquals(error.code, -32003);
    assertEquals(error.data?.type, "AGENT_GRANT_REQUIRED");
    // Pending request seeded for the approval inbox.
    assert(Array.isArray(pending));
    assertEquals((pending as Array<{ status: string }>)[0].status, "pending");
  } finally {
    cleanup();
  }
});

Deno.test("chokepoint: an unknown target function does NOT seed a pending request", async () => {
  let pendingCreated = false;
  const cleanup = installHarness({
    grants: [],
    onPending: () => (pendingCreated = true),
  });
  try {
    const token = await mintCallerContextToken({
      callerAppId: CALLER_APP_ID,
      userId: USER_ID,
    });
    const body = await callTarget(token, "nonexistentFn");
    const error = body.error as { code: number };
    // Rejected as unknown tool, and no inbox row was created.
    assert(error.code === -32602 || error.code === -32003);
    assertEquals(pendingCreated, false);
  } finally {
    cleanup();
  }
});

Deno.test("chokepoint: a tampered caller context fails closed", async () => {
  const cleanup = installHarness({ grants: [activeGrantRow()] });
  try {
    const token = await mintCallerContextToken({
      callerAppId: CALLER_APP_ID,
      userId: USER_ID,
    });
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const body = await callTarget(tampered);
    const error = body.error as { code: number; data?: { type?: string } };
    assertEquals(error.code, -32004);
    assertEquals(error.data?.type, "AGENT_CALLER_CONTEXT_INVALID");
  } finally {
    cleanup();
  }
});

Deno.test("chokepoint: a caller context for a different user is rejected", async () => {
  const cleanup = installHarness({ grants: [activeGrantRow()] });
  try {
    // Signed for a DIFFERENT user than the authenticated bearer (USER_ID).
    const token = await mintCallerContextToken({
      callerAppId: CALLER_APP_ID,
      userId: "99999999-9999-4999-8999-999999999999",
    });
    const body = await callTarget(token);
    const error = body.error as { code: number; data?: { type?: string } };
    assertEquals(error.code, -32004);
    assertEquals(error.data?.type, "AGENT_CALLER_CONTEXT_USER_MISMATCH");
  } finally {
    cleanup();
  }
});

Deno.test("chokepoint: a hop-exceeded caller context fails closed", async () => {
  const cleanup = installHarness({ grants: [activeGrantRow()] });
  try {
    // incomingHop 8 ⇒ minted hop 9 > MAX (8).
    const token = await mintCallerContextToken({
      callerAppId: CALLER_APP_ID,
      userId: USER_ID,
      incomingHop: 8,
    });
    const body = await callTarget(token);
    const error = body.error as { code: number; message: string };
    assertEquals(error.code, -32004);
    assert(error.message.includes("depth"));
  } finally {
    cleanup();
  }
});

Deno.test("chokepoint: a capped grant denies with AGENT_GRANT_CAP_EXCEEDED", async () => {
  const cleanup = installHarness({
    grants: [{
      ...activeGrantRow(),
      monthly_cap_credits: 500,
      spent_credits_period: 500,
      period_start: new Date(Date.UTC(2026, new Date().getUTCMonth(), 1))
        .toISOString(),
    }],
  });
  try {
    const token = await mintCallerContextToken({
      callerAppId: CALLER_APP_ID,
      userId: USER_ID,
    });
    const body = await callTarget(token);
    const error = body.error as { code: number; data?: { type?: string } };
    assertEquals(error.code, -32003);
    assertEquals(error.data?.type, "AGENT_GRANT_CAP_EXCEEDED");
  } finally {
    cleanup();
  }
});

Deno.test("chokepoint: a self-call (caller === target) is exempt from the grant check", async () => {
  // No grants, but the caller app id equals the target — must NOT be denied
  // by the grant gate (it falls through to normal execution, which errors on
  // the unmocked sandbox; we only assert it is NOT a grant denial).
  const cleanup = installHarness({ grants: [] });
  try {
    const token = await mintCallerContextToken({
      callerAppId: TARGET_ID,
      userId: USER_ID,
    });
    const body = await callTarget(token);
    const error = body.error as { code?: number; data?: { type?: string } } |
      undefined;
    if (error) {
      assert(error.data?.type !== "AGENT_GRANT_REQUIRED");
      assert(error.code !== -32004);
    }
  } finally {
    cleanup();
  }
});
