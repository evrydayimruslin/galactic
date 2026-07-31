import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { createApp } from "./app.ts";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RELEASE_DIGEST = "c".repeat(64);
const IMPORT_COUNT_KEY = "__native_route_fence_import_count";
const HANDLER_COUNT_KEY = "__native_route_fence_handler_count";

type DeploymentState =
  | "legacy"
  | "materializing"
  | "setup_required"
  | "ready";

interface HarnessOptions {
  deploymentState: DeploymentState;
  membershipStatus?: "active" | "canceled";
  visibility?: "public" | "private";
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setupNativeRouteHarness(options: HarnessOptions) {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const nonce = crypto.randomUUID();
  let storageReads = 0;
  let membershipReads = 0;

  const app = {
    id: APP_ID,
    owner_id: OWNER_ID,
    slug: "native-route-agent",
    name: "Native Route Agent",
    description: "Native route fence test fixture",
    visibility: options.visibility ?? "public",
    hosting_suspended: false,
    deployment_state: options.deploymentState,
    active_release_digest: options.deploymentState === "ready"
      ? RELEASE_DIGEST
      : null,
    current_version: "1.0.0",
    updated_at: "2026-07-30T00:00:00.000Z",
    storage_key: `apps/${APP_ID}/1.0.0/`,
    runtime: "deno",
    manifest: JSON.stringify({
      name: "Native Route Agent",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {},
    }),
    exports: [],
    skills_md: null,
    rate_limit_config: null,
    http_enabled: true,
  };

  const source = [
    `const nonce = ${JSON.stringify(nonce)};`,
    "const state = globalThis as unknown as Record<string, unknown>;",
    `state[${JSON.stringify(IMPORT_COUNT_KEY)}] = Number(state[${
      JSON.stringify(IMPORT_COUNT_KEY)
    }] || 0) + 1;`,
    "export default async function handler(_request: Request) {",
    `  state[${JSON.stringify(HANDLER_COUNT_KEY)}] = Number(state[${
      JSON.stringify(HANDLER_COUNT_KEY)
    }] || 0) + 1;`,
    '  return new Response("executed:" + nonce);',
    "}",
  ].join("\n");

  const bucket = {
    get: () => {
      storageReads += 1;
      return Promise.resolve({
        text: () => Promise.resolve(source),
        arrayBuffer: () =>
          Promise.resolve(new TextEncoder().encode(source).buffer),
      });
    },
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

  globalThis.fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url || String(input));
    const method = init?.method || request?.method || "GET";

    if (url.pathname === "/rest/v1/apps" && method === "GET") {
      const publicOnly = url.searchParams.has("visibility");
      return Promise.resolve(
        jsonResponse(publicOnly && app.visibility === "private" ? [] : [app]),
      );
    }
    if (
      url.pathname === "/rest/v1/account_entitlements" &&
      method === "GET"
    ) {
      membershipReads += 1;
      return Promise.resolve(
        jsonResponse([{
          plan_code: "pro",
          subscription_status: options.membershipStatus ?? "active",
        }]),
      );
    }

    throw new Error(`Unexpected fetch: ${method} ${url.pathname}${url.search}`);
  };

  return {
    nonce,
    get storageReads() {
      return storageReads;
    },
    get membershipReads() {
      return membershipReads;
    },
    cleanup() {
      globalThis.fetch = originalFetch;
      globalThis.__env = originalEnv;
      const state = globalThis as unknown as Record<string, unknown>;
      delete state[IMPORT_COUNT_KEY];
      delete state[HANDLER_COUNT_KEY];
    },
  };
}

function nativeExecutionRequest(): Request {
  return new Request(`https://api.example/a/${APP_ID}/invoke`, {
    method: "POST",
  });
}

Deno.test("canonical and incomplete deployments never read or import native route source", async () => {
  const cases: Array<{
    state: Exclude<DeploymentState, "legacy">;
    code: string;
  }> = [
    {
      state: "ready",
      code: "APP_DEPLOYMENT_NATIVE_ROUTE_UNAVAILABLE",
    },
    {
      state: "setup_required",
      code: "APP_DEPLOYMENT_SETUP_REQUIRED",
    },
    {
      state: "materializing",
      code: "APP_DEPLOYMENT_MATERIALIZING",
    },
  ];

  for (const testCase of cases) {
    const harness = setupNativeRouteHarness({
      deploymentState: testCase.state,
    });
    try {
      const response = await createApp().handle(nativeExecutionRequest());
      assertEquals(response.status, 409);
      const body = await response.json();
      assertEquals(body.type, testCase.code);
      assertEquals(body.deployment_state, testCase.state);
      assertEquals(harness.storageReads, 0);
      assertEquals(harness.membershipReads, 0);
      const state = globalThis as unknown as Record<string, unknown>;
      assertEquals(state[IMPORT_COUNT_KEY], undefined);
      assertEquals(state[HANDLER_COUNT_KEY], undefined);
    } finally {
      harness.cleanup();
    }
  }
});

Deno.test("legacy native execution rechecks active owner membership immediately before import", async () => {
  const harness = setupNativeRouteHarness({
    deploymentState: "legacy",
    membershipStatus: "active",
  });
  try {
    const response = await createApp().handle(nativeExecutionRequest());
    assertEquals(response.status, 200);
    assertEquals(await response.text(), `executed:${harness.nonce}`);
    assert(harness.storageReads > 0);
    assertEquals(harness.membershipReads, 1);
    const state = globalThis as unknown as Record<string, unknown>;
    assertEquals(state[IMPORT_COUNT_KEY], 1);
    assertEquals(state[HANDLER_COUNT_KEY], 1);
  } finally {
    harness.cleanup();
  }
});

Deno.test("lapsed legacy membership stops native import and handler execution", async () => {
  const harness = setupNativeRouteHarness({
    deploymentState: "legacy",
    membershipStatus: "canceled",
  });
  try {
    const response = await createApp().handle(nativeExecutionRequest());
    assertEquals(response.status, 402);
    const body = await response.json();
    assertEquals(body.type, "PRO_SUBSCRIPTION_REQUIRED");
    assert(harness.storageReads > 0);
    assertEquals(harness.membershipReads, 1);
    const state = globalThis as unknown as Record<string, unknown>;
    assertEquals(state[IMPORT_COUNT_KEY], undefined);
    assertEquals(state[HANDLER_COUNT_KEY], undefined);
  } finally {
    harness.cleanup();
  }
});

Deno.test("private native lifecycle remains hidden from anonymous callers", async () => {
  const harness = setupNativeRouteHarness({
    deploymentState: "ready",
    visibility: "private",
  });
  try {
    const response = await createApp().handle(nativeExecutionRequest());
    assertEquals(response.status, 404);
    assertEquals(await response.json(), { error: "App not found" });
    assertEquals(harness.storageReads, 0);
    assertEquals(harness.membershipReads, 0);
  } finally {
    harness.cleanup();
  }
});
