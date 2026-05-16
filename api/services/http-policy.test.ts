import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  type AppManifest,
  validateManifest,
} from "../../shared/contracts/manifest.ts";
import {
  DEFAULT_PUBLIC_HTTP_RATE_LIMIT_RPM,
  listManifestHttpRoutes,
  resolveHttpRoutePolicy,
} from "./http-policy.ts";

function baseManifest(overrides: Record<string, unknown> = {}): AppManifest {
  return {
    name: "HTTP Policy App",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      webhook: { description: "Receive an external webhook" },
      dashboard: { description: "Render a dashboard" },
    },
    ...overrides,
  } as AppManifest;
}

Deno.test("http policy manifest: accepts explicit public routes and normalizes methods/origins", () => {
  const manifest = baseManifest({
    http: {
      routes: {
        webhook: {
          auth: "public",
          methods: ["post"],
          cors: {
            origins: ["https://example.com/"],
            headers: ["X-Webhook-Signature"],
          },
          rate_limit: { rpm: 120, daily: 10_000 },
        },
      },
    },
  });

  const result = validateManifest(manifest);

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
  assertEquals(manifest.http?.routes?.webhook?.methods, ["POST"]);
  assertEquals(manifest.http?.routes?.webhook?.cors?.origins, [
    "https://example.com",
  ]);
});

Deno.test("http policy manifest: rejects unsafe public route policy", () => {
  const result = validateManifest(baseManifest({
    http: {
      routes: {
        webhook: {
          auth: "public",
          billing: "caller",
          data_scope: "user",
          cors: {
            origins: ["*"],
            credentials: true,
          },
        },
      },
    },
  }));

  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((error) => error.path === "http.routes.webhook.methods"),
    true,
  );
  assertEquals(
    result.errors.some((error) => error.path === "http.routes.webhook.billing"),
    true,
  );
  assertEquals(
    result.errors.some((error) =>
      error.path === "http.routes.webhook.data_scope"
    ),
    true,
  );
  assertEquals(
    result.errors.some((error) =>
      error.path === "http.routes.webhook.cors.credentials"
    ),
    true,
  );
});

Deno.test("http policy manifest: validates route names and function references", () => {
  const result = validateManifest(baseManifest({
    http: {
      routes: {
        "missing/function": {
          auth: "public",
          methods: ["POST"],
        },
      },
    },
  }));

  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((error) =>
      error.message.includes("single function path segment")
    ),
    true,
  );
  assertEquals(
    result.errors.some((error) => error.message.includes("missing function")),
    true,
  );
});

Deno.test("http policy resolver: preserves authenticated default when no route is declared", () => {
  const policy = resolveHttpRoutePolicy(baseManifest(), "webhook");

  assertEquals(policy.declared, false);
  assertEquals(policy.auth, "user");
  assertEquals(policy.methods, null);
  assertEquals(policy.cors, null);
  assertEquals(policy.rateLimit, null);
  assertEquals(policy.billing, "caller");
  assertEquals(policy.dataScope, "app");
});

Deno.test("http policy resolver: resolves route defaults and public safeguards", () => {
  const manifest = baseManifest({
    http: {
      defaults: {
        cors: {
          origins: ["https://app.example"],
        },
      },
      routes: {
        webhook: {
          auth: "public",
          methods: ["POST"],
          cors: {
            headers: ["X-Webhook-Signature"],
          },
        },
      },
    },
  });

  const policy = resolveHttpRoutePolicy(manifest, "webhook");

  assertEquals(policy.declared, true);
  assertEquals(policy.auth, "public");
  assertEquals(policy.methods, ["POST"]);
  assertEquals(policy.billing, "owner");
  assertEquals(policy.dataScope, "app");
  assertEquals(policy.rateLimit?.rpm, DEFAULT_PUBLIC_HTTP_RATE_LIMIT_RPM);
  assertEquals(policy.cors, {
    origins: ["https://app.example"],
    credentials: false,
    headers: ["X-Webhook-Signature"],
    maxAgeSeconds: undefined,
  });
});

Deno.test("http policy resolver: lists declared routes in stable order", () => {
  const routes = listManifestHttpRoutes(baseManifest({
    http: {
      routes: {
        webhook: { auth: "public", methods: ["POST"] },
        dashboard: { methods: ["GET"], billing: "owner" },
      },
    },
  }));

  assertEquals(routes.map((route) => route.functionName), [
    "dashboard",
    "webhook",
  ]);
  assertEquals(routes.map((route) => route.auth), ["user", "public"]);
});
