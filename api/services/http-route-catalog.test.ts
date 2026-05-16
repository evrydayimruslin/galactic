import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.210.0/assert/assert_string_includes.ts";

import type { App } from "../../shared/types/index.ts";
import {
  buildHttpRouteCatalog,
  formatHttpRouteCatalogLine,
  getRequestBaseUrl,
} from "./http-route-catalog.ts";

function app(
  overrides: Partial<App> = {},
): Pick<App, "id" | "owner_id" | "runtime" | "manifest"> {
  return {
    id: "app-123",
    owner_id: "owner-123",
    runtime: "deno",
    manifest: JSON.stringify({
      name: "Webhook App",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {
        webhook: { description: "Receive provider webhooks" },
        sync: { description: "Run a user sync" },
      },
      http: {
        defaults: {
          cors: { origins: ["https://client.example"] },
        },
        routes: {
          webhook: {
            auth: "public",
            methods: ["POST"],
            rate_limit: { rpm: 120 },
          },
          sync: {
            auth: "user",
          },
        },
      },
    }),
    ...overrides,
  };
}

Deno.test("http route catalog: lists declared routes with URLs and resolved policy", () => {
  const routes = buildHttpRouteCatalog(app(), {
    baseUrl: "https://api.example/",
  });

  assertEquals(routes.length, 2);
  assertEquals(routes[0].function_name, "sync");
  assertEquals(routes[0].auth, "user");
  assertEquals(routes[0].requires_auth, true);
  assertEquals(routes[0].allows_any_method, true);
  assertEquals(routes[0].methods, [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
  ]);

  assertEquals(routes[1].function_name, "webhook");
  assertEquals(routes[1].url, "https://api.example/http/app-123/webhook");
  assertEquals(routes[1].public, true);
  assertEquals(routes[1].billing, "owner");
  assertEquals(routes[1].data_scope, "app");
  assertEquals(routes[1].methods, ["POST"]);
  assertEquals(routes[1].rate_limit?.rpm, 120);
  assertEquals(routes[1].cors?.origins, ["https://client.example"]);
  assertEquals(routes[1].executable, true);
});

Deno.test("http route catalog: can filter to public routes", () => {
  const routes = buildHttpRouteCatalog(app(), { auth: "public" });

  assertEquals(routes.map((route) => route.function_name), ["webhook"]);
});

Deno.test("http route catalog: flags unsupported owner-billed GPU routes", () => {
  const routes = buildHttpRouteCatalog(app({ runtime: "gpu" }), {
    baseUrl: "https://api.example",
    auth: "public",
  });

  assertEquals(routes.length, 1);
  assertEquals(routes[0].executable, false);
  assertEquals(routes[0].issue?.type, "HTTP_ROUTE_UNSUPPORTED");
});

Deno.test("http route catalog: formats instruction lines", () => {
  const [route] = buildHttpRouteCatalog(app(), {
    baseUrl: "https://api.example",
    auth: "public",
  });

  const line = formatHttpRouteCatalogLine(route);

  assertStringIncludes(line, "`POST https://api.example/http/app-123/webhook`");
  assertStringIncludes(line, "public");
  assertStringIncludes(line, "owner-billed");
});

Deno.test("http route catalog: derives public base URL from forwarded headers", () => {
  const request = new Request("http://internal.worker/http/app/webhook", {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "api.ultralight.dev",
    },
  });

  assertEquals(getRequestBaseUrl(request), "https://api.ultralight.dev");
});
