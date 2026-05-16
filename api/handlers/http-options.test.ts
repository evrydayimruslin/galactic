import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { handleHttpEndpoint, handleHttpOptions } from "./http.ts";

type MockApp = {
  id: string;
  owner_id?: string;
  slug?: string;
  runtime?: "deno" | "gpu" | null;
  exports?: string[];
  storage_key?: string;
  http_rate_limit?: number;
  manifest: string | null;
  http_enabled?: boolean | null;
  env_vars?: Record<string, string>;
  env_schema?: Record<string, unknown>;
  supabase_enabled?: boolean;
  supabase_config_id?: string | null;
};

async function withMockedApp<T>(
  app: MockApp | null,
  fn: () => Promise<T> | T,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    BASE_URL: "https://api.example",
    ENVIRONMENT: "production",
    CORS_ALLOWED_ORIGINS: "https://platform.example",
  } as typeof globalThis.__env;

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://supabase.test/rest/v1/apps")) {
      return new Response(JSON.stringify(app ? [app] : []), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("https://supabase.test/auth/v1/user")) {
      return new Response("{}", { status: 401 });
    }
    if (
      url.startsWith(
        "https://supabase.test/rest/v1/users?id=eq.owner-123&select=tier",
      )
    ) {
      return new Response(JSON.stringify([{ tier: "scale" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (
      url.startsWith(
        "https://supabase.test/rest/v1/rpc/increment_weekly_calls",
      )
    ) {
      return new Response(JSON.stringify([{ current_count: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (
      url.startsWith(
        "https://supabase.test/rest/v1/rpc/check_http_route_rate_limit",
      )
    ) {
      return new Response(
        JSON.stringify([{
          allowed: true,
          current_count: 1,
          limit_count: 60,
          remaining: 59,
          reset_at: "2026-05-16T16:01:00.000Z",
        }]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url.startsWith("https://supabase.test/rest/v1/http_requests")) {
      return new Response("{}", { status: 201 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__env = originalEnv;
  }
}

function appWithHttpPolicy(): MockApp {
  return {
    id: "app-123",
    owner_id: "owner-123",
    slug: "cors-app",
    runtime: "deno",
    exports: ["webhook"],
    storage_key: "apps/app-123/1.0.0/",
    http_rate_limit: 1000,
    http_enabled: true,
    env_vars: {},
    env_schema: {},
    supabase_enabled: false,
    supabase_config_id: null,
    manifest: JSON.stringify({
      name: "CORS App",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {
        webhook: { description: "Receive webhooks" },
      },
      http: {
        routes: {
          webhook: {
            auth: "public",
            methods: ["POST"],
            cors: {
              origins: ["https://widget.example"],
              headers: ["X-Webhook-Signature"],
            },
          },
        },
      },
    }),
  };
}

function appWithUserHttpPolicy(): MockApp {
  const app = appWithHttpPolicy();
  app.manifest = JSON.stringify({
    name: "User HTTP App",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      webhook: { description: "Receive webhooks" },
    },
    http: {
      routes: {
        webhook: {
          auth: "user",
          methods: ["POST"],
        },
      },
    },
  });
  return app;
}

Deno.test("http options: resolves route-specific CORS policy", async () => {
  await withMockedApp(appWithHttpPolicy(), async () => {
    const response = await handleHttpOptions(
      new Request("https://api.example/http/app-123/webhook", {
        method: "OPTIONS",
        headers: {
          Origin: "https://widget.example",
          "Access-Control-Request-Method": "POST",
        },
      }),
      "app-123",
      "webhook",
    );

    assertEquals(response.status, 204);
    assertEquals(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://widget.example",
    );
    assertEquals(
      response.headers.get("Access-Control-Allow-Credentials"),
      null,
    );
    assertEquals(
      response.headers.get("Access-Control-Allow-Methods"),
      "POST, OPTIONS",
    );
    assertEquals(
      response.headers.get("Access-Control-Allow-Headers"),
      "Content-Type, Authorization, X-Requested-With, X-Webhook-Signature",
    );
  });
});

Deno.test("http options: route policy can reject globally allowed origins", async () => {
  await withMockedApp(appWithHttpPolicy(), async () => {
    const response = await handleHttpOptions(
      new Request("https://api.example/http/app-123/webhook", {
        method: "OPTIONS",
        headers: {
          Origin: "https://platform.example",
          "Access-Control-Request-Method": "POST",
        },
      }),
      "app-123",
      "webhook",
    );

    assertEquals(response.status, 403);
    assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
  });
});

Deno.test("http options: missing app preserves legacy global preflight behavior", async () => {
  await withMockedApp(null, async () => {
    const response = await handleHttpOptions(
      new Request("https://api.example/http/missing/webhook", {
        method: "OPTIONS",
        headers: {
          Origin: "https://platform.example",
          "Access-Control-Request-Method": "POST",
        },
      }),
      "missing",
      "webhook",
    );

    assertEquals(response.status, 204);
    assertEquals(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://platform.example",
    );
    assertEquals(
      response.headers.get("Access-Control-Allow-Credentials"),
      "true",
    );
  });
});

Deno.test("http endpoint: rejects methods outside route policy before auth", async () => {
  await withMockedApp(appWithHttpPolicy(), async () => {
    const response = await handleHttpEndpoint(
      new Request("https://api.example/http/app-123/webhook", {
        method: "GET",
        headers: {
          Origin: "https://widget.example",
          "x-forwarded-for": "203.0.113.10",
        },
      }),
      "app-123",
      "webhook",
    );

    assertEquals(response.status, 405);
    assertEquals(response.headers.get("Allow"), "POST, OPTIONS");
    assertEquals(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://widget.example",
    );
    assertEquals(await response.json(), {
      error: "Method GET not allowed for this HTTP route",
    });
  });
});

Deno.test("http endpoint: public route ignores missing or third-party Authorization before runtime", async () => {
  await withMockedApp(appWithHttpPolicy(), async () => {
    const headerCases: HeadersInit[] = [
      { Origin: "https://widget.example" },
      {
        Origin: "https://widget.example",
        Authorization: "Bearer provider-webhook-secret",
      },
    ];

    for (const headers of headerCases) {
      const response = await handleHttpEndpoint(
        new Request("https://api.example/http/app-123/webhook", {
          method: "POST",
          headers,
        }),
        "app-123",
        "webhook",
      );

      assertEquals(response.status, 404);
      assertEquals(await response.json(), { error: "App code not found" });
    }
  });
});

Deno.test("http endpoint: user route still requires platform auth", async () => {
  await withMockedApp(appWithUserHttpPolicy(), async () => {
    const response = await handleHttpEndpoint(
      new Request("https://api.example/http/app-123/webhook", {
        method: "POST",
        headers: { Origin: "https://platform.example" },
      }),
      "app-123",
      "webhook",
    );

    assertEquals(response.status, 401);
    assertEquals(await response.json(), {
      error: "Missing or invalid authorization header",
      type: "AUTH_REQUIRED",
    });
  });
});
