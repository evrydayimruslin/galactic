import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  applyRouteCorsHeaders,
  buildCorsHeaders,
  buildCorsPreflightResponse,
  buildRouteCorsHeaders,
  buildRouteCorsPreflightResponse,
  resolveAllowedCorsOrigins,
} from "./cors.ts";

Deno.test("cors: allows configured production origins", () => {
  const request = new Request(
    "https://ultralight-api.rgn4jz429m.workers.dev/http/test",
    {
      headers: { Origin: "https://ultralight-api.rgn4jz429m.workers.dev" },
    },
  );

  const headers = buildCorsHeaders(request, {
    baseUrl: "https://ultralight-api.rgn4jz429m.workers.dev",
    environment: "production",
    allowedOrigins: "https://ultralight-api.rgn4jz429m.workers.dev",
  });

  assertEquals(
    headers["Access-Control-Allow-Origin"],
    "https://ultralight-api.rgn4jz429m.workers.dev",
  );
  assertEquals(headers["Access-Control-Allow-Credentials"], "true");
});

Deno.test("cors: allows production launch-web Pages origin", () => {
  const request = new Request(
    "https://ultralight-api.rgn4jz429m.workers.dev/api/launch/status",
    {
      headers: { Origin: "https://ultralight-launch-web.pages.dev" },
    },
  );

  const headers = buildCorsHeaders(request, {
    baseUrl: "https://ultralight-api.rgn4jz429m.workers.dev",
    environment: "production",
    allowedOrigins:
      "https://ultralight-api.rgn4jz429m.workers.dev,https://ultralight-launch-web.pages.dev",
  });

  assertEquals(
    headers["Access-Control-Allow-Origin"],
    "https://ultralight-launch-web.pages.dev",
  );
  assertEquals(headers["Access-Control-Allow-Credentials"], "true");
});

Deno.test("cors: blocks disallowed production browser origins", () => {
  const request = new Request(
    "https://ultralight-api.rgn4jz429m.workers.dev/http/test",
    {
      headers: { Origin: "https://evil.example" },
    },
  );

  const headers = buildCorsHeaders(request, {
    baseUrl: "https://ultralight-api.rgn4jz429m.workers.dev",
    environment: "production",
    allowedOrigins: "https://ultralight-api.rgn4jz429m.workers.dev",
  });

  assertEquals(headers["Access-Control-Allow-Origin"], undefined);
  assertEquals(headers["Access-Control-Allow-Credentials"], undefined);
});

Deno.test("cors: never includes scrapped desktop tauri origins", () => {
  const origins = resolveAllowedCorsOrigins({
    baseUrl: "https://ultralight-api.rgn4jz429m.workers.dev",
    environment: "production",
  });

  assertEquals(
    origins.includes("https://ultralight-api.rgn4jz429m.workers.dev"),
    true,
  );
  assertEquals(origins.includes("tauri://localhost"), false);
  assertEquals(origins.includes("https://tauri.localhost"), false);
  assertEquals(origins.includes("http://localhost:5173"), false);
});

Deno.test("cors: keeps localhost origins available outside production", () => {
  const origins = resolveAllowedCorsOrigins({
    baseUrl: "https://ultralight-api-staging.rgn4jz429m.workers.dev",
    environment: "staging",
  });

  assertEquals(
    origins.includes("https://ultralight-api-staging.rgn4jz429m.workers.dev"),
    true,
  );
  assertEquals(origins.includes("http://localhost:5173"), true);
  assertEquals(origins.includes("http://localhost:5178"), true);
  assertEquals(origins.includes("tauri://localhost"), false);
});

Deno.test("cors: preflight rejects disallowed origins", async () => {
  const request = new Request(
    "https://ultralight-api.rgn4jz429m.workers.dev/http/test",
    {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    },
  );

  const response = buildCorsPreflightResponse(request, {
    baseUrl: "https://ultralight-api.rgn4jz429m.workers.dev",
    environment: "production",
    allowedOrigins: "https://ultralight-api.rgn4jz429m.workers.dev",
  });

  assertEquals(response.status, 403);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
  assertEquals(await response.text(), "");
});

Deno.test("cors: route policy allows explicit browser origins without credentials", () => {
  const request = new Request("https://api.example/http/app/webhook", {
    headers: { Origin: "https://widget.example" },
  });

  const headers = buildRouteCorsHeaders(request, {
    origins: ["https://widget.example"],
    credentials: false,
    methods: ["POST"],
    headers: ["X-Webhook-Signature"],
  }, {
    baseUrl: "https://api.example",
    environment: "production",
    allowedOrigins: "https://api.example",
  });

  assertEquals(
    headers["Access-Control-Allow-Origin"],
    "https://widget.example",
  );
  assertEquals(headers["Access-Control-Allow-Credentials"], undefined);
  assertEquals(headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
  assertEquals(
    headers["Access-Control-Allow-Headers"],
    "Content-Type, Authorization, X-Requested-With, X-Webhook-Signature",
  );
});

Deno.test("cors: route policy supports wildcard origins only without credentials", () => {
  const request = new Request("https://api.example/http/app/webhook", {
    headers: { Origin: "https://anywhere.example" },
  });

  const headers = buildRouteCorsHeaders(request, {
    origins: ["*"],
    credentials: false,
    methods: ["GET"],
  }, {
    baseUrl: "https://api.example",
    environment: "production",
  });

  assertEquals(headers["Access-Control-Allow-Origin"], "*");
  assertEquals(headers["Access-Control-Allow-Credentials"], undefined);
});

Deno.test("cors: route preflight rejects origins outside route policy", async () => {
  const request = new Request("https://api.example/http/app/webhook", {
    method: "OPTIONS",
    headers: {
      Origin: "https://platform.example",
      "Access-Control-Request-Method": "POST",
    },
  });

  const response = buildRouteCorsPreflightResponse(request, {
    origins: ["https://widget.example"],
    methods: ["POST"],
  }, {
    baseUrl: "https://api.example",
    environment: "production",
    allowedOrigins: "https://platform.example",
  });

  assertEquals(response.status, 403);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
  assertEquals(await response.text(), "");
});

Deno.test("cors: route preflight rejects methods outside route policy", () => {
  const request = new Request("https://api.example/http/app/webhook", {
    method: "OPTIONS",
    headers: {
      Origin: "https://widget.example",
      "Access-Control-Request-Method": "GET",
    },
  });

  const response = buildRouteCorsPreflightResponse(request, {
    origins: ["https://widget.example"],
    methods: ["POST"],
  }, {
    baseUrl: "https://api.example",
    environment: "production",
  });

  assertEquals(response.status, 405);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://widget.example",
  );
  assertEquals(response.headers.get("Allow"), "POST, OPTIONS");
});

Deno.test("cors: route preflight falls back to global origins when no route origins are set", () => {
  const request = new Request("https://api.example/http/app/dashboard", {
    method: "OPTIONS",
    headers: {
      Origin: "https://platform.example",
      "Access-Control-Request-Method": "GET",
    },
  });

  const response = buildRouteCorsPreflightResponse(request, {
    methods: ["GET"],
  }, {
    baseUrl: "https://api.example",
    environment: "production",
    allowedOrigins: "https://platform.example",
  });

  assertEquals(response.status, 204);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://platform.example",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Credentials"),
    "true",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Methods"),
    "GET, OPTIONS",
  );
});

Deno.test("cors: route policy can disable credentials while using global origins", () => {
  const request = new Request("https://api.example/http/app/dashboard", {
    headers: { Origin: "https://platform.example" },
  });

  const headers = buildRouteCorsHeaders(request, {
    credentials: false,
    methods: ["GET"],
  }, {
    baseUrl: "https://api.example",
    environment: "production",
    allowedOrigins: "https://platform.example",
  });

  assertEquals(
    headers["Access-Control-Allow-Origin"],
    "https://platform.example",
  );
  assertEquals(headers["Access-Control-Allow-Credentials"], undefined);
});

Deno.test("cors: route policy clears stale global origin headers", () => {
  const request = new Request("https://api.example/http/app/dashboard", {
    headers: { Origin: "https://platform.example" },
  });
  const headers = new Headers({
    "Access-Control-Allow-Origin": "https://platform.example",
    "Access-Control-Allow-Credentials": "true",
  });

  applyRouteCorsHeaders(headers, request, {
    origins: ["https://widget.example"],
    methods: ["GET"],
  }, {
    baseUrl: "https://api.example",
    environment: "production",
    allowedOrigins: "https://platform.example",
  });

  assertEquals(headers.get("Access-Control-Allow-Origin"), null);
  assertEquals(headers.get("Access-Control-Allow-Credentials"), null);
  assertEquals(headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
});
