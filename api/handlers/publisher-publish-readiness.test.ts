import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertExists } from "https://deno.land/std@0.210.0/assert/assert_exists.ts";
import { assertStringIncludes } from "https://deno.land/std@0.210.0/assert/assert_string_includes.ts";

import { handlePlatformMcp } from "./platform-mcp.ts";
import { handleUploadFiles } from "./upload.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

let testQueue = Promise.resolve();

async function runSerial(fn: () => Promise<void>): Promise<void> {
  const run = testQueue.then(fn, fn);
  testQueue = run.catch(() => {});
  await run;
}

async function withMockedEnvAndFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  const previousFetch = globalThis.fetch;

  globalWithEnv.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  };
  globalThis.fetch = handler as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = previousFetch;
    globalWithEnv.__env = previousEnv;
  }
}

function appCountResponse(): Response {
  return new Response("[]", {
    headers: {
      "content-type": "application/json",
      "content-range": "0-0/0",
    },
  });
}

function lowBalanceBillingConfig(): Response {
  return Response.json([{
    id: "singleton",
    version: 23,
    publish_deposit_enabled: true,
    publisher_min_publish_balance_light: 1000,
  }]);
}

Deno.test("publisher readiness: API programmatic upload blocks non-private low-balance publish before storage writes", async () => {
  await runSerial(async () => {
    const calls: string[] = [];
    await withMockedEnvAndFetch(
      async (input) => {
        const url = String(input);
        calls.push(url);

        if (url.includes("/rest/v1/apps?owner_id=")) {
          return appCountResponse();
        }
        if (url.includes("/platform_billing_config")) {
          return lowBalanceBillingConfig();
        }
        if (url.includes("/rest/v1/users?") && url.includes("select=tier")) {
          return Response.json([{ tier: "free" }]);
        }
        if (
          url.includes("/rest/v1/users?") &&
          url.includes("select=balance_light")
        ) {
          return Response.json([{ balance_light: 100 }]);
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        let caught: unknown;
        try {
          await handleUploadFiles(
            "user-1",
            [{
              name: "index.ts",
              content: 'export function greet() { return "hello"; }',
              size: 43,
            }],
            {
              app_type: "mcp",
              name: "Readiness Test",
              visibility: "public",
            },
          );
        } catch (err) {
          caught = err;
        }

        assertExists(caught);
        assertEquals((caught as { status?: number }).status, 402);
        assertEquals(
          (caught as { details?: { required_light?: number } }).details
            ?.required_light,
          1000,
        );
        assertEquals(
          (caught as { details?: { current_balance_light?: number } }).details
            ?.current_balance_light,
          100,
        );
        assertEquals(
          calls.some((url) => url.includes("/storage/v1/")),
          false,
        );
      },
    );
  });
});

Deno.test("publisher readiness: Platform MCP ul.set version returns structured minimum-balance error", async () => {
  await runSerial(async () => {
    await withMockedEnvAndFetch(
      async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";

        if (url.includes("/auth/v1/user")) {
          return Response.json({ id: "user-1", email: "maker@example.test" });
        }
        if (url.includes("/rest/v1/users?") && url.includes("select=id")) {
          return Response.json([{ id: "user-1" }]);
        }
        if (url.includes("/rest/v1/pending_permissions")) {
          return Response.json([]);
        }
        if (url.includes("/rest/v1/users?") && url.includes("select=tier")) {
          return Response.json([{ tier: "free" }]);
        }
        if (url.includes("/rest/v1/rpc/increment_weekly_calls")) {
          return Response.json([{ current_count: 1 }]);
        }
        if (url.includes("/rest/v1/apps?") && url.includes("id=eq.app-1")) {
          return Response.json([{
            id: "app-1",
            owner_id: "user-1",
            slug: "readiness-app",
            name: "Readiness App",
            description: "A published app",
            visibility: "public",
            current_version: "1.0.0",
            versions: ["1.0.0", "2.0.0"],
            storage_key: "apps/app-1/1.0.0/",
            exports: ["greet"],
          }]);
        }
        if (url.includes("/platform_billing_config")) {
          return lowBalanceBillingConfig();
        }
        if (
          url.includes("/rest/v1/users?") &&
          url.includes("select=balance_light")
        ) {
          return Response.json([{ balance_light: 100 }]);
        }
        if (url.includes("/rest/v1/mcp_call_logs") && method === "POST") {
          return new Response(null, { status: 201 });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
      async () => {
        const response = await handlePlatformMcp(
          new Request("https://launch.test/mcp/platform", {
            method: "POST",
            headers: {
              "Authorization": "Bearer supabase-test-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "ul.set",
                arguments: {
                  app_id: "app-1",
                  version: "2.0.0",
                },
              },
            }),
          }),
        );

        assertEquals(response.status, 400);
        const payload = await response.json() as {
          error?: {
            code?: number;
            message?: string;
            data?: Record<string, unknown>;
          };
        };
        assertExists(payload.error);
        assertStringIncludes(
          payload.error.message || "",
          "Publishing requires at least ✦1000",
        );
        assertEquals(payload.error.data?.required_light, 1000);
        assertEquals(payload.error.data?.current_balance_light, 100);
        assertEquals(
          payload.error.data?.next_action,
          "Add credits from Wallet to go live.",
        );
      },
    );
  });
});
