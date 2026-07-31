// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { handlePlatformMcp } from "./platform-mcp.ts";

const USER_ID = "71000000-0000-4000-8000-000000000001";
const APP_ID = "71000000-0000-4000-8000-000000000002";
const ACCESS_TOKEN = "supabase-membership-boundary-token";

interface FetchCall {
  method: string;
  pathname: string;
  body: unknown;
}

interface McpToolResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

interface BoundaryHarness {
  calls: FetchCall[];
  membershipReads: number;
  r2Writes: string[];
  codeCacheWrites: string[];
  setVisibility(visibility: "private" | "public" | "unlisted"): void;
  setDeploymentState(state: "legacy" | "ready"): void;
  cleanup(): void;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestFor(
  name: string,
  args: Record<string, unknown>,
): Request {
  return new Request("https://api.test/mcp/platform", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${name}-${crypto.randomUUID()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const response = await handlePlatformMcp(requestFor(name, args));
  const body = await response.json() as {
    result?: McpToolResult;
    error?: {
      message?: string;
      data?: Record<string, unknown>;
    };
  };
  if (body.error) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${body.error.message || ""}` }],
      structuredContent: body.error.data,
    };
  }
  assertEquals(response.status, 200);
  assert(body.result);
  return body.result;
}

function errorText(result: McpToolResult): string {
  assertEquals(result.isError, true);
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert(typeof text === "string");
  return text;
}

function requestBody(
  request: Request | null,
  init?: RequestInit,
): Promise<unknown> {
  if (request) {
    return request.clone().text().then((text) =>
      text ? JSON.parse(text) : null
    );
  }
  if (typeof init?.body === "string" && init.body) {
    return Promise.resolve(JSON.parse(init.body));
  }
  return Promise.resolve(null);
}

function setupBoundaryHarness(input: {
  activeMembership: boolean;
  visibility?: "private" | "public" | "unlisted";
  cachedEmptyFunctionIndex?: boolean;
}): BoundaryHarness {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const r2Writes: string[] = [];
  const codeCacheWrites: string[] = [];
  const r2Values = new Map<string, Uint8Array>();
  let membershipReads = 0;
  let visibility = input.visibility ?? "private";
  let deploymentState: "legacy" | "ready" = "legacy";

  const r2Bucket = {
    put(key: string, value: ArrayBuffer | ArrayBufferView | string) {
      r2Writes.push(key);
      const bytes = typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        );
      r2Values.set(key, bytes.slice());
      return Promise.resolve();
    },
    get(key: string) {
      const bytes = r2Values.get(key);
      if (!bytes) return Promise.resolve(null);
      const snapshot = bytes.slice();
      return Promise.resolve({
        text: () => Promise.resolve(new TextDecoder().decode(snapshot)),
        arrayBuffer: () => Promise.resolve(snapshot.buffer.slice(0)),
      });
    },
    delete(key: string) {
      r2Values.delete(key);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve({ objects: [], truncated: false });
    },
  };
  const codeCache = {
    get: () =>
      Promise.resolve(
        input.cachedEmptyFunctionIndex
          ? {
            functions: {},
            widgets: [],
            contextSources: [],
            routines: [],
            types: "",
            updatedAt: "2026-07-30T00:00:00.000Z",
          }
          : null,
      ),
    put: (key: string) => {
      codeCacheWrites.push(key);
      return Promise.resolve();
    },
    delete: () => Promise.resolve(),
    list: () => Promise.resolve({ keys: [], list_complete: true }),
  };

  globalThis.__env = {
    ...(previousEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    SUPABASE_ANON_KEY: "anon-test",
    BASE_URL: "https://api.test",
    ENVIRONMENT: "test",
    PRO_SUBSCRIPTION_REQUIRED: "1",
    R2_BUCKET: r2Bucket,
    CODE_CACHE: codeCache,
    FN_INDEX: codeCache,
  } as unknown as typeof globalThis.__env;

  globalThis.fetch = (async (
    resource: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = resource instanceof Request ? resource : null;
    const url = new URL(request?.url || String(resource));
    const method = request?.method || init?.method || "GET";
    const body = await requestBody(request, init);
    calls.push({ method, pathname: url.pathname, body });

    if (url.pathname === "/auth/v1/user") {
      return jsonResponse({
        id: USER_ID,
        email: "membership-boundary@example.com",
        email_confirmed_at: "2026-07-30T00:00:00.000Z",
        user_metadata: {},
      });
    }
    if (url.pathname === "/rest/v1/users" && method === "GET") {
      return jsonResponse([{ id: USER_ID, tier: "free" }]);
    }
    if (
      url.pathname === "/rest/v1/rpc/increment_weekly_calls" &&
      method === "POST"
    ) {
      return jsonResponse([{ current_count: 1 }]);
    }
    if (
      url.pathname === "/rest/v1/rpc/check_rate_limit" &&
      method === "POST"
    ) {
      return jsonResponse(true);
    }
    if (
      url.pathname === "/rest/v1/rpc/reserve_staged_bundle_storage" &&
      method === "POST"
    ) {
      const inputBody = body as {
        p_reservation_id: string;
        p_objects: Array<{ size_bytes: number }>;
        p_retained_until: string;
        p_limit_bytes: number;
        p_limit_objects: number;
      };
      const reservedBytes = inputBody.p_objects.reduce(
        (sum, object) => sum + object.size_bytes,
        0,
      );
      const reservedObjects = inputBody.p_objects.length;
      return jsonResponse([{
        reservation_id: inputBody.p_reservation_id,
        allowed: true,
        used_bytes: 0,
        reserved_bytes: reservedBytes,
        projected_bytes: reservedBytes,
        limit_bytes: inputBody.p_limit_bytes,
        remaining_bytes: inputBody.p_limit_bytes - reservedBytes,
        used_objects: 0,
        reserved_objects: reservedObjects,
        projected_objects: reservedObjects,
        limit_objects: inputBody.p_limit_objects,
        remaining_objects: inputBody.p_limit_objects - reservedObjects,
        retained_until: inputBody.p_retained_until,
      }]);
    }
    if (url.pathname === "/rest/v1/account_entitlements") {
      membershipReads += 1;
      return jsonResponse(
        input.activeMembership
          ? [{ plan_code: "pro", subscription_status: "active" }]
          : [],
      );
    }
    if (url.pathname === "/rest/v1/apps" && method === "GET") {
      return jsonResponse([{
        id: APP_ID,
        owner_id: USER_ID,
        slug: "membership-boundary-agent",
        name: "Membership Boundary Agent",
        description: "Boundary fixture",
        visibility,
        deployment_state: deploymentState,
        hosting_suspended: false,
        current_version: "1.0.0",
        versions: ["1.0.0", "2.0.0"],
        version_metadata: [],
        storage_key: `apps/${APP_ID}/1.0.0/`,
        storage_bytes: 0,
        exports: ["ping"],
        manifest: null,
        runtime: "deno",
        updated_at: "2026-07-30T00:00:00.000Z",
        deleted_at: null,
      }]);
    }
    if (url.pathname === "/rest/v1/mcp_call_logs" && method === "POST") {
      return jsonResponse([], 201);
    }
    throw new Error(`Unexpected fetch: ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;

  return {
    calls,
    get membershipReads() {
      return membershipReads;
    },
    r2Writes,
    codeCacheWrites,
    setVisibility(next) {
      visibility = next;
    },
    setDeploymentState(next) {
      deploymentState = next;
    },
    cleanup() {
      globalThis.fetch = previousFetch;
      globalThis.__env = previousEnv;
    },
  };
}

function assertNoLiveDeploymentSideEffects(harness: BoundaryHarness): void {
  assertEquals(harness.r2Writes, []);
  assertEquals(harness.codeCacheWrites, []);
  assertEquals(
    harness.calls.filter((call) =>
      call.pathname === "/rest/v1/apps" && call.method !== "GET"
    ),
    [],
  );
  assertEquals(
    harness.calls.filter((call) =>
      call.pathname.startsWith("/rest/v1/rpc/") &&
      !call.pathname.endsWith("/increment_weekly_calls")
    ),
    [],
  );
}

Deno.test({
  name: "platform MCP keeps gx.stage and gx.test available before membership",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = setupBoundaryHarness({ activeMembership: false });
    try {
      const staged = await callTool("gx.stage", {
        files: [{
          path: "index.ts",
          content: 'export function ping(): string { return "pong"; }',
        }],
      });
      assertEquals(staged.isError, false);
      assertStringIncludes(
        String(staged.structuredContent?.bundle_id),
        "gxb1_",
      );
      assert(harness.r2Writes.length >= 2);

      const tested = await callTool("gx.test", {
        files: [{
          path: "index.ts",
          content: 'export function ping(): string { return "pong"; }',
        }],
        lint_only: true,
      });
      assertEquals(tested.isError, false);
      assert(tested.structuredContent);
      assertEquals(harness.membershipReads, 0);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "legacy gx.upload cannot write bytes for an immutable ready Agent release",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = setupBoundaryHarness({ activeMembership: true });
    harness.setDeploymentState("ready");
    try {
      const result = await callTool("gx.upload", {
        app_id: APP_ID,
        version: "2.0.1",
        files: [{
          path: "index.ts",
          content: 'export function ping(): string { return "changed"; }',
        }],
      });

      assertStringIncludes(
        errorText(result),
        "immutable deployment releases",
      );
      assertEquals(
        result.structuredContent?.type,
        "LIVE_RELEASE_CAS_REQUIRED",
      );
      assertNoLiveDeploymentSideEffects(harness);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "platform MCP rejects upload, version deployment, and public visibility without active Pro",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = setupBoundaryHarness({ activeMembership: false });
    try {
      const upload = await callTool("gx.upload", {
        name: "blocked-before-membership",
        visibility: "private",
        files: [{
          path: "index.ts",
          content: 'export function ping(): string { return "pong"; }',
        }],
      });
      assertStringIncludes(errorText(upload), "active Galactic membership");

      const version = await callTool("gx.set", {
        app_id: APP_ID,
        version: "2.0.0",
      });
      assertStringIncludes(errorText(version), "active Galactic membership");

      for (const targetVisibility of ["unlisted", "published"] as const) {
        const visibility = await callTool("gx.set", {
          app_id: APP_ID,
          visibility: targetVisibility,
        });
        assertStringIncludes(
          errorText(visibility),
          "active Galactic membership",
        );
      }

      assertEquals(harness.membershipReads, 4);
      assertNoLiveDeploymentSideEffects(harness);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name:
    "public and unlisted gx.set version switches reject before KV, R2, D1, or app writes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = setupBoundaryHarness({
      activeMembership: true,
      visibility: "public",
    });
    try {
      for (const currentVisibility of ["public", "unlisted"] as const) {
        harness.setVisibility(currentVisibility);
        const result = await callTool("gx.set", {
          app_id: APP_ID,
          version: "2.0.0",
        });
        assertStringIncludes(
          errorText(result),
          "Direct version switching for public or unlisted Agents is retired",
        );
        assertEquals(
          result.structuredContent?.type,
          "LIVE_RELEASE_CAS_REQUIRED",
        );
      }

      assertEquals(harness.membershipReads, 2);
      assertNoLiveDeploymentSideEffects(harness);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "gx.codemode executes for an active member",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = setupBoundaryHarness({
      activeMembership: true,
      cachedEmptyFunctionIndex: true,
    });
    try {
      const result = await callTool("gx.codemode", {
        code: "return 7;",
      });
      assertEquals(result.isError, false);
      assertEquals(result.structuredContent?.result, 7);
      assertEquals(harness.membershipReads, 1);
    } finally {
      harness.cleanup();
    }
  },
});

Deno.test({
  name: "gx.codemode rejects a lapsed member before in-process execution",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const harness = setupBoundaryHarness({
      activeMembership: false,
      cachedEmptyFunctionIndex: true,
    });
    try {
      const result = await callTool("gx.codemode", {
        code: "throw new Error('tenant code must not run');",
      });
      assertStringIncludes(errorText(result), "active Galactic membership");
      assertEquals(
        result.structuredContent?.type,
        "PRO_SUBSCRIPTION_REQUIRED",
      );
      assertEquals(harness.membershipReads, 1);
    } finally {
      harness.cleanup();
    }
  },
});
