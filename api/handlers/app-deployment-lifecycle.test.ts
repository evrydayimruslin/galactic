import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { createApp } from "./app.ts";
import { handleHttpEndpoint } from "./http.ts";
import { executeQueuedJob, handleMcp } from "./mcp.ts";
import { handleRun } from "./run.ts";
import type { AsyncJob } from "../services/async-jobs.ts";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface FetchCall {
  method: string;
  pathname: string;
  body?: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setupLifecycleHarness(
  state: "materializing" | "setup_required" | undefined,
  options: {
    visibility?: "private" | "public";
  } = {},
) {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const fetchCalls: FetchCall[] = [];
  const app = {
    id: APP_ID,
    owner_id: OWNER_ID,
    slug: "lifecycle-agent",
    name: "Lifecycle Agent",
    description: "Lifecycle test fixture",
    visibility: options.visibility ?? "public",
    hosting_suspended: false,
    current_version: "1.0.0",
    updated_at: "2026-07-30T00:00:00.000Z",
    storage_key: `apps/${APP_ID}/1.0.0/`,
    runtime: "deno",
    deployment_state: state,
    manifest: JSON.stringify({
      name: "Lifecycle Agent",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {
        ping: {
          description: "Ping",
          parameters: {},
        },
      },
    }),
    exports: ["ping"],
    skills_md: null,
    rate_limit_config: null,
    http_enabled: true,
  };

  const source = [
    "export default async function handler(_request: Request) {",
    "  globalThis.__lifecycle_native_execution_reached = true;",
    '  return new Response("executed");',
    "}",
  ].join("\n");
  const bucket = {
    get: () =>
      Promise.resolve({
        text: () => Promise.resolve(source),
        arrayBuffer: () =>
          Promise.resolve(new TextEncoder().encode(source).buffer),
      }),
  };

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    SUPABASE_ANON_KEY: "anon-key",
    BASE_URL: "https://api.example",
    ENVIRONMENT: "test",
    R2_BUCKET: bucket,
  } as unknown as typeof globalThis.__env;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url || String(input));
    const method = init?.method || request?.method || "GET";
    const bodyText = init?.body && typeof init.body === "string"
      ? init.body
      : request
      ? await request.clone().text()
      : "";
    fetchCalls.push({
      method,
      pathname: url.pathname,
      ...(bodyText ? { body: JSON.parse(bodyText) } : {}),
    });

    if (url.pathname === "/rest/v1/apps" && method === "GET") {
      return jsonResponse([app]);
    }
    if (url.pathname === "/auth/v1/user") {
      return jsonResponse({
        id: OWNER_ID,
        email: "owner@example.com",
        user_metadata: {},
      });
    }
    if (url.pathname === "/rest/v1/users") {
      return jsonResponse([{
        id: OWNER_ID,
        email: "owner@example.com",
        display_name: "Owner",
        avatar_url: null,
        tier: "pro",
        byok_enabled: false,
        byok_provider: null,
        byok_keys: null,
      }]);
    }
    if (url.pathname === "/rest/v1/account_entitlements") {
      return jsonResponse([{
        plan_code: "pro",
        subscription_status: "active",
      }]);
    }
    if (url.pathname === "/rest/v1/pending_permissions") {
      return jsonResponse([]);
    }
    if (url.pathname === "/rest/v1/async_jobs" && method === "PATCH") {
      return jsonResponse([{}]);
    }
    throw new Error(`Unexpected fetch: ${method} ${url.pathname}${url.search}`);
  };

  return {
    fetchCalls,
    cleanup() {
      globalThis.fetch = originalFetch;
      globalThis.__env = originalEnv;
      delete (
        globalThis as unknown as Record<string, unknown>
      ).__lifecycle_native_execution_reached;
    },
  };
}

function bearerHeaders(): HeadersInit {
  return {
    "Authorization": "Bearer owner-token",
    "Content-Type": "application/json",
  };
}

Deno.test("runtime entry points reject setup_required before usage side effects", async () => {
  const harness = setupLifecycleHarness("setup_required");
  try {
    const runResponse = await handleRun(
      new Request(`https://api.example/run/${APP_ID}`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({ function: "ping", args: {} }),
      }),
      APP_ID,
    );
    assertEquals(runResponse.status, 409);
    const runBody = await runResponse.json();
    assertEquals(runBody.error.type, "APP_DEPLOYMENT_SETUP_REQUIRED");

    const httpResponse = await handleHttpEndpoint(
      new Request(`https://api.example/http/${APP_ID}/ping`, {
        method: "POST",
      }),
      APP_ID,
      "/ping",
    );
    assertEquals(httpResponse.status, 409);
    const httpBody = await httpResponse.json();
    assertEquals(httpBody.type, "APP_DEPLOYMENT_SETUP_REQUIRED");

    const mcpResponse = await handleMcp(
      new Request(`https://api.example/mcp/${APP_ID}`, {
        method: "POST",
        headers: bearerHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "lifecycle-call",
          method: "tools/call",
          params: {
            name: "lifecycle-agent_ping",
            arguments: {},
          },
        }),
      }),
      APP_ID,
    );
    const mcpBody = await mcpResponse.json();
    assertEquals(mcpBody.error.code, -32011);
    assertEquals(
      mcpBody.error.data.type,
      "APP_DEPLOYMENT_SETUP_REQUIRED",
    );

    assertEquals(
      harness.fetchCalls.some((call) =>
        call.pathname.includes("check_rate_limit") ||
        call.pathname.includes("increment_weekly_calls") ||
        call.pathname.includes("billing") ||
        call.pathname.includes("capacity")
      ),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

Deno.test("private HTTP lifecycle is disclosed only to the authenticated owner", async () => {
  const harness = setupLifecycleHarness("setup_required", {
    visibility: "private",
  });
  try {
    const anonymousResponse = await handleHttpEndpoint(
      new Request(`https://api.example/http/${APP_ID}/ping`, {
        method: "POST",
      }),
      APP_ID,
      "/ping",
    );
    assertEquals(anonymousResponse.status, 404);
    assertEquals(await anonymousResponse.json(), { error: "App not found" });

    const ownerResponse = await handleHttpEndpoint(
      new Request(`https://api.example/http/${APP_ID}/ping`, {
        method: "POST",
        headers: bearerHeaders(),
      }),
      APP_ID,
      "/ping",
    );
    assertEquals(ownerResponse.status, 409);
    assertEquals(await ownerResponse.json(), {
      error: "This Agent must finish setup before it can run.",
      type: "APP_DEPLOYMENT_SETUP_REQUIRED",
      deployment_state: "setup_required",
    });
  } finally {
    harness.cleanup();
  }
});

Deno.test("native server execution checks lifecycle before module import", async () => {
  const harness = setupLifecycleHarness("setup_required");
  try {
    const response = await createApp().handle(
      new Request(`https://api.example/a/${APP_ID}/?embed=1`),
    );
    assertEquals(response.status, 409);
    const body = await response.json();
    assertEquals(body.type, "APP_DEPLOYMENT_SETUP_REQUIRED");
    assertEquals(
      (
        globalThis as unknown as Record<string, unknown>
      ).__lifecycle_native_execution_reached,
      undefined,
    );
  } finally {
    harness.cleanup();
  }
});

Deno.test("queued execution fails durably before loading runtime context", async () => {
  const harness = setupLifecycleHarness("materializing");
  try {
    const job: AsyncJob = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      app_id: APP_ID,
      user_id: OWNER_ID,
      owner_id: OWNER_ID,
      function_name: "ping",
      status: "running",
      args: {},
      caller_app_id: null,
      caller_grant_id: null,
      hop: null,
      result: null,
      result_r2_key: null,
      error: null,
      logs: [],
      duration_ms: null,
      ai_cost_light: 0,
      execution_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      server_instance: "test",
      started_at: "2026-07-30T00:00:00.000Z",
      completed_at: null,
      expires_at: "2026-07-31T00:00:00.000Z",
      meta: {},
      created_at: "2026-07-30T00:00:00.000Z",
    };

    assertEquals(await executeQueuedJob(job), { kind: "complete" });
    const failure = harness.fetchCalls.find((call) =>
      call.pathname === "/rest/v1/async_jobs" && call.method === "PATCH"
    );
    assert(failure);
    assertEquals(
      (failure.body as Record<string, unknown>).error,
      {
        type: "APP_DEPLOYMENT_MATERIALIZING",
        message: "This Agent is still being deployed and cannot run yet.",
      },
    );
    assertEquals(
      harness.fetchCalls.some((call) => call.pathname === "/rest/v1/users"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

Deno.test("runtime rejects an incomplete lifecycle projection", async () => {
  const harness = setupLifecycleHarness(undefined);
  try {
    const response = await handleHttpEndpoint(
      new Request(`https://api.example/http/${APP_ID}/ping`, {
        method: "POST",
      }),
      APP_ID,
      "/ping",
    );
    assertEquals(response.status, 503);
    const body = await response.json();
    assertEquals(body.type, "APP_DEPLOYMENT_STATE_INVALID");
    assertEquals(body.deployment_state, "missing");
  } finally {
    harness.cleanup();
  }
});
