import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { handlePlatformMcp } from "./platform-mcp.ts";

const TOKEN = "gx_abcdef0123456789abcdef0123456789";
const USER_ID = "11111111-1111-4111-8111-111111111111";

async function tokenHash(token: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function platformRequest(
  method: string,
  params?: unknown,
  token = TOKEN,
): Request {
  return new Request("https://api.test/mcp/platform", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
}

function platformCookieRequest(method: string, params: unknown, token: string): Request {
  return new Request("https://api.test/mcp/platform", {
    method: "POST",
    headers: {
      "Cookie": `__Host-ul_session=${encodeURIComponent(token)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
}

Deno.test({
  name:
    "platform MCP dispatch fails closed before an apps:call key reaches upload",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousEnv = globalThis.__env;
    const previousFetch = globalThis.fetch;
    const salt = "platform-scope-test-salt";
    const hash = await tokenHash(TOKEN, salt);

    globalThis.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      BASE_URL: "https://api.test",
    } as typeof globalThis.__env;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url || String(input));
      const method = request?.method || init?.method || "GET";

      if (url.pathname.endsWith("/rest/v1/user_api_tokens")) {
        if (method === "PATCH") return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify({
            id: "token-scope-test",
            user_id: USER_ID,
            token_hash: hash,
            token_salt: salt,
            plaintext_token: null,
            scopes: ["apps:call"],
            app_ids: null,
            function_names: null,
            expires_at: null,
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.pathname.endsWith("/rest/v1/users")) {
        return new Response(
          JSON.stringify({
            id: USER_ID,
            email: "scope-test@example.com",
            tier: "pro",
            provisional: false,
            last_active_at: null,
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    try {
      const denied = await handlePlatformMcp(
        platformRequest("tools/call", {
          name: "gx.upload",
          arguments: {
            name: "must-not-deploy",
            files: [{ path: "index.ts", content: "export function main() {}" }],
          },
        }),
      );
      const deniedBody = await denied.json() as {
        error?: { code?: number; message?: string; data?: { type?: string } };
      };
      assertEquals(deniedBody.error?.code, -32003);
      assertEquals(deniedBody.error?.data?.type, "API_KEY_SCOPE_REQUIRED");
      assertStringIncludes(deniedBody.error?.message || "", "agents:build");

      const appstoreDenied = await handlePlatformMcp(
        platformRequest("tools/call", {
          name: "gx.discover",
          arguments: { scope: "appstore", query: "agents" },
        }),
      );
      const appstoreBody = await appstoreDenied.json() as {
        error?: { data?: { type?: string }; message?: string };
      };
      assertEquals(
        appstoreBody.error?.data?.type,
        "ACCOUNT_SESSION_REQUIRED",
      );
      assertStringIncludes(
        appstoreBody.error?.message || "",
        "Marketplace discovery is deferred",
      );

      const listed = await handlePlatformMcp(platformRequest("tools/list"));
      const listedBody = await listed.json() as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = listedBody.result?.tools?.map((tool) => tool.name) || [];
      assert(names.includes("gx.call"));
      assert(names.includes("gx.discover"));
      assert(!names.includes("gx.upload"));
      assert(!names.includes("gx.secrets"));
      assert(!names.includes("gx.grants"));
    } finally {
      globalThis.__env = previousEnv;
      globalThis.fetch = previousFetch;
    }
  },
});

Deno.test({
  name:
    "platform MCP keeps connected-builder restrictions when an API token arrives in the session cookie",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const builderToken = "gx_cookie1234567890abcdef1234567890";
    const previousEnv = globalThis.__env;
    const previousFetch = globalThis.fetch;
    const salt = "platform-cookie-builder-salt";
    const hash = await tokenHash(builderToken, salt);

    globalThis.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      BASE_URL: "https://api.test",
    } as typeof globalThis.__env;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url || String(input));
      const method = request?.method || init?.method || "GET";

      if (url.pathname.endsWith("/rest/v1/user_api_tokens")) {
        if (method === "PATCH") return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify({
            id: "token-cookie-builder-test",
            user_id: USER_ID,
            token_hash: hash,
            token_salt: salt,
            plaintext_token: null,
            scopes: ["agents:build"],
            app_ids: null,
            function_names: null,
            expires_at: null,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/rest/v1/users")) {
        return new Response(
          JSON.stringify({
            id: USER_ID,
            email: "cookie-builder-test@example.com",
            tier: "pro",
            provisional: false,
            last_active_at: null,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/rest/v1/rpc/increment_weekly_calls")) {
        return new Response(JSON.stringify([{ current_count: 1 }]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/rest/v1/mcp_call_logs")) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    try {
      const response = await handlePlatformMcp(
        platformCookieRequest(
          "tools/call",
          {
            name: "gx.upload",
            arguments: {
              name: "cookie-transport-must-test-first",
              visibility: "private",
              files: [{
                path: "index.ts",
                content: "export function main() { return { ok: true }; }",
              }],
            },
          },
          builderToken,
        ),
      );
      const body = await response.json() as {
        error?: { code?: number; message?: string; data?: { type?: string } };
      };
      assertEquals(body.error?.code, -32003);
      assertEquals(body.error?.data?.type, "TEST_ATTESTATION_REQUIRED");
      assertStringIncludes(body.error?.message || "", "gx.test");
    } finally {
      globalThis.__env = previousEnv;
      globalThis.fetch = previousFetch;
    }
  },
});

Deno.test({
  name:
    "platform MCP connected builder upload requires gx.test attestation before deployment",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const builderToken = "gx_1234567890abcdef1234567890abcdef";
    const previousEnv = globalThis.__env;
    const previousFetch = globalThis.fetch;
    const salt = "platform-builder-attestation-salt";
    const hash = await tokenHash(builderToken, salt);

    globalThis.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      BASE_URL: "https://api.test",
    } as typeof globalThis.__env;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url || String(input));
      const method = request?.method || init?.method || "GET";

      if (url.pathname.endsWith("/rest/v1/user_api_tokens")) {
        if (method === "PATCH") return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify({
            id: "token-builder-attestation-test",
            user_id: USER_ID,
            token_hash: hash,
            token_salt: salt,
            plaintext_token: null,
            scopes: ["agents:build"],
            app_ids: null,
            function_names: null,
            expires_at: null,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/rest/v1/users")) {
        return new Response(
          JSON.stringify({
            id: USER_ID,
            email: "builder-attestation-test@example.com",
            tier: "pro",
            provisional: false,
            last_active_at: null,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/rest/v1/rpc/increment_weekly_calls")) {
        return new Response(JSON.stringify([{ current_count: 1 }]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/rest/v1/mcp_call_logs")) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    try {
      const response = await handlePlatformMcp(
        platformRequest(
          "tools/call",
          {
            name: "gx.upload",
            arguments: {
              name: "must-test-first",
              visibility: "private",
              files: [{
                path: "index.ts",
                content: "export function main() { return { ok: true }; }",
              }],
            },
          },
          builderToken,
        ),
      );
      const body = await response.json() as {
        error?: { code?: number; message?: string; data?: { type?: string } };
      };
      assertEquals(body.error?.code, -32003);
      assertEquals(body.error?.data?.type, "TEST_ATTESTATION_REQUIRED");
      assertStringIncludes(body.error?.message || "", "gx.test");
      assertStringIncludes(body.error?.message || "", "exact files");
    } finally {
      globalThis.__env = previousEnv;
      globalThis.fetch = previousFetch;
    }
  },
});
