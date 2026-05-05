import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  buildCorsHeaders,
  buildCorsPreflightResponse,
  resolveAllowedCorsOrigins,
} from "./cors.ts";

Deno.test("cors: allows configured production origins", () => {
  const request = new Request("https://ultralight-api.rgn4jz429m.workers.dev/http/test", {
    headers: { Origin: "https://ultralight-api.rgn4jz429m.workers.dev" },
  });

  const headers = buildCorsHeaders(request, {
    baseUrl: "https://ultralight-api.rgn4jz429m.workers.dev",
    environment: "production",
    allowedOrigins: "https://ultralight-api.rgn4jz429m.workers.dev",
  });

  assertEquals(headers["Access-Control-Allow-Origin"], "https://ultralight-api.rgn4jz429m.workers.dev");
  assertEquals(headers["Access-Control-Allow-Credentials"], "true");
});

Deno.test("cors: blocks disallowed production browser origins", () => {
  const request = new Request("https://ultralight-api.rgn4jz429m.workers.dev/http/test", {
    headers: { Origin: "https://evil.example" },
  });

  const headers = buildCorsHeaders(request, {
    baseUrl: "https://ultralight-api.rgn4jz429m.workers.dev",
    environment: "production",
    allowedOrigins: "https://ultralight-api.rgn4jz429m.workers.dev",
  });

  assertEquals(headers["Access-Control-Allow-Origin"], undefined);
  assertEquals(headers["Access-Control-Allow-Credentials"], undefined);
});

Deno.test("cors: keeps tauri origins available in production", () => {
  const origins = resolveAllowedCorsOrigins({
    baseUrl: "https://ultralight-api.rgn4jz429m.workers.dev",
    environment: "production",
  });

  assertEquals(origins.includes("https://ultralight-api.rgn4jz429m.workers.dev"), true);
  assertEquals(origins.includes("tauri://localhost"), true);
  assertEquals(origins.includes("http://localhost:5173"), false);
});

Deno.test("cors: keeps localhost origins available outside production", () => {
  const origins = resolveAllowedCorsOrigins({
    baseUrl: "https://ultralight-api-staging.rgn4jz429m.workers.dev",
    environment: "staging",
  });

  assertEquals(origins.includes("https://ultralight-api-staging.rgn4jz429m.workers.dev"), true);
  assertEquals(origins.includes("http://localhost:5173"), true);
  assertEquals(origins.includes("tauri://localhost"), true);
});

Deno.test("cors: preflight rejects disallowed origins", async () => {
  const request = new Request("https://ultralight-api.rgn4jz429m.workers.dev/http/test", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example" },
  });

  const response = buildCorsPreflightResponse(request, {
    baseUrl: "https://ultralight-api.rgn4jz429m.workers.dev",
    environment: "production",
    allowedOrigins: "https://ultralight-api.rgn4jz429m.workers.dev",
  });

  assertEquals(response.status, 403);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), null);
  assertEquals(await response.text(), "");
});
