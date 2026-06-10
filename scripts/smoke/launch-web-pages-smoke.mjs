#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ensureNode20, parseArgs, repoRoot } from "../analysis/_shared.mjs";

ensureNode20();

const args = parseArgs(process.argv.slice(2));

function printHelp() {
  console.log(`Usage: node scripts/smoke/launch-web-pages-smoke.mjs [options]

Options:
  --target <staging|production>     Release target (required)
  --pages-url <url>                 Launch web Pages origin override
  --api-url <url>                   Launch API origin override
  --token <token>                   Bearer token for authenticated launch API probes
  --tool-slug <slug>                Public Agent slug for /agents/:slug route (default: example)
  --admin-tool-id <id>              Agent id for /admin/agents/:id route and optional admin API probe (default: example)
  --output-dir <path>               Evidence output directory (defaults to UL_LAUNCH_EVIDENCE_DIR)
  --timeout-ms <ms>                 Per-request timeout (default: 15000)
  --skip-auth-api                   Skip authenticated launch API probes even when token is set
  --help                            Show this help
`);
}

if (args.has("--help")) {
  printHelp();
  process.exit(0);
}

const target = String(args.get("--target") || "").trim().toLowerCase();
if (!["staging", "production"].includes(target)) {
  printHelp();
  console.error("launch-web-pages-smoke requires --target staging or --target production.");
  process.exit(1);
}

const defaultPagesUrl = target === "production"
  ? "https://ultralight-launch-web.pages.dev"
  : "https://staging.ultralight-launch-web.pages.dev";
const defaultApiUrl = target === "production"
  ? "https://ultralight-api.rgn4jz429m.workers.dev"
  : "https://ultralight-api-staging.rgn4jz429m.workers.dev";

const pagesBase = normalizeBaseUrl(
  args.get("--pages-url") || process.env.ULTRALIGHT_LAUNCH_WEB_URL ||
    defaultPagesUrl,
);
const apiBase = normalizeBaseUrl(
  args.get("--api-url") || process.env.ULTRALIGHT_API_URL || defaultApiUrl,
);
const token = String(args.get("--token") || process.env.ULTRALIGHT_TOKEN || "")
  .trim();
const toolSlug = String(args.get("--tool-slug") || "example").trim();
const adminToolId = String(args.get("--admin-tool-id") || "example").trim();
const outputDir = String(
  args.get("--output-dir") || process.env.UL_LAUNCH_EVIDENCE_DIR || "",
).trim();
const timeoutMs = Number.parseInt(String(args.get("--timeout-ms") || "15000"), 10);
const skipAuthApi = Boolean(args.has("--skip-auth-api"));

if (!outputDir) {
  console.error("launch-web-pages-smoke requires --output-dir or UL_LAUNCH_EVIDENCE_DIR.");
  process.exit(1);
}

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("--timeout-ms must be a positive integer.");
  process.exit(1);
}

const smokeDir = resolve(outputDir, "smoke");
mkdirSync(smokeDir, { recursive: true });

const outputJsonPath = join(smokeDir, "launch-web-pages.json");
const outputMarkdownPath = join(smokeDir, "launch-web-pages.md");

const pageRoutes = [
  { name: "page-home", path: "/", auth: false },
  { name: "page-install", path: "/install", auth: false },
  { name: "page-store", path: "/store", auth: false },
  {
    name: "page-public-tool",
    path: `/agents/${encodeURIComponent(toolSlug)}`,
    auth: false,
  },
  { name: "page-library", path: "/library", auth: true },
  { name: "page-wallet", path: "/wallet", auth: true },
  { name: "page-settings", path: "/settings", auth: true },
  {
    name: "page-admin-tool",
    path: `/admin/agents/${encodeURIComponent(adminToolId)}`,
    auth: true,
  },
];

const publicApiProbes = [
  {
    name: "api-launch-status",
    path: "/api/launch/status",
    failureClass: "api-status",
    validate: validateLaunchStatus,
  },
  {
    name: "api-launch-openapi",
    path: "/api/launch/openapi.json",
    failureClass: "api-openapi",
    validate: validateOpenApi,
  },
  {
    name: "api-launch-store",
    path: "/api/launch/store?limit=1",
    failureClass: "api-data",
    validate: validateStore,
  },
];

const authenticatedApiProbes = [
  {
    name: "api-launch-library",
    path: "/api/launch/library",
    failureClass: "auth-api",
  },
  {
    name: "api-launch-wallet",
    path: "/api/launch/wallet",
    failureClass: "auth-api",
  },
  {
    name: "api-launch-settings-keys",
    path: "/api/launch/api-keys",
    failureClass: "auth-api",
  },
];

if (adminToolId && adminToolId !== "example") {
  authenticatedApiProbes.push({
    name: "api-launch-admin-tool",
    path: `/api/launch/admin/agents/${encodeURIComponent(adminToolId)}`,
    failureClass: "auth-data",
  });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function redactHeaders(headers) {
  const redacted = { ...headers };
  if (redacted.Authorization) redacted.Authorization = "Bearer [REDACTED_TOKEN]";
  if (redacted.authorization) redacted.authorization = "Bearer [REDACTED_TOKEN]";
  return redacted;
}

async function fetchProbe(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = options.headers || {};
  const startedAt = nowIso();

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      ok: true,
      started_at: startedAt,
      finished_at: nowIso(),
      status_code: response.status,
      final_url: response.url,
      headers: Object.fromEntries(response.headers.entries()),
      body_text: text,
      request: {
        method: options.method || "GET",
        url,
        headers: redactHeaders(headers),
      },
    };
  } catch (error) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      status_code: null,
      final_url: url,
      headers: {},
      body_text: "",
      error: error instanceof Error ? error.message : String(error),
      request: {
        method: options.method || "GET",
        url,
        headers: redactHeaders(headers),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function contentType(headers) {
  return headers["content-type"] || headers["Content-Type"] || "";
}

function acao(headers) {
  return headers["access-control-allow-origin"] ||
    headers["Access-Control-Allow-Origin"] || "";
}

function classifyPageProbe(raw, route) {
  const html = raw.body_text || "";
  const type = contentType(raw.headers);
  const statusOk = raw.status_code === 200;
  const htmlOk = /text\/html/i.test(type);
  const shellOk = html.includes('id="root"') || html.includes("<!doctype html") ||
    html.includes("<!DOCTYPE html");
  const passed = raw.ok && statusOk && htmlOk && shellOk;
  return {
    name: route.name,
    surface: "pages",
    route: route.path,
    auth_route: route.auth,
    status: passed ? "passed" : "failed",
    failure_class: passed ? null : statusOk ? "pages-spa-shell" : "pages-routing",
    expected: "Cloudflare Pages returns the launch SPA shell for the route",
    observed: {
      status_code: raw.status_code,
      content_type: type || null,
      final_url: raw.final_url,
      shell_detected: shellOk,
      error: raw.error || null,
    },
    request: raw.request,
  };
}

async function runPageRoute(route) {
  const raw = await fetchProbe(`${pagesBase}${route.path}`, {
    headers: { "User-Agent": "ultralight-launch-web-pages-smoke" },
  });
  return classifyPageProbe(raw, route);
}

async function runPublicApiProbe(probe) {
  const raw = await fetchProbe(`${apiBase}${probe.path}`, {
    headers: {
      "Origin": pagesBase,
      "Accept": "application/json",
      "User-Agent": "ultralight-launch-web-pages-smoke",
    },
  });
  const validation = probe.validate(raw);
  const corsOk = acao(raw.headers) === pagesBase;
  const passed = raw.ok && raw.status_code === 200 && validation.ok && corsOk;
  return {
    name: probe.name,
    surface: "api",
    route: probe.path,
    status: passed ? "passed" : "failed",
    failure_class: passed
      ? null
      : !corsOk && raw.status_code === 200
      ? "api-cors"
      : validation.failureClass || probe.failureClass,
    expected: validation.expected,
    observed: {
      status_code: raw.status_code,
      content_type: contentType(raw.headers) || null,
      access_control_allow_origin: acao(raw.headers) || null,
      validation: validation.message,
      final_url: raw.final_url,
      error: raw.error || null,
    },
    request: raw.request,
  };
}

async function runCorsPreflight() {
  const raw = await fetchProbe(`${apiBase}/api/launch/status`, {
    method: "OPTIONS",
    headers: {
      "Origin": pagesBase,
      "Access-Control-Request-Method": "GET",
      "User-Agent": "ultralight-launch-web-pages-smoke",
    },
  });
  const allowed = acao(raw.headers);
  const passed = raw.ok && raw.status_code >= 200 && raw.status_code < 400 &&
    allowed === pagesBase;
  return {
    name: "api-launch-cors-preflight",
    surface: "api",
    route: "/api/launch/status",
    status: passed ? "passed" : "failed",
    failure_class: passed ? null : "api-cors",
    expected: "Launch API preflight allows the launch-web Pages origin",
    observed: {
      status_code: raw.status_code,
      access_control_allow_origin: allowed || null,
      final_url: raw.final_url,
      error: raw.error || null,
    },
    request: raw.request,
  };
}

async function runAuthenticatedApiProbe(probe) {
  if (!token || skipAuthApi) {
    return {
      name: probe.name,
      surface: "api",
      route: probe.path,
      status: "skipped",
      failure_class: null,
      expected: "Authenticated launch API probe runs with ULTRALIGHT_TOKEN",
      observed: {
        reason: skipAuthApi
          ? "skipped by --skip-auth-api"
          : "ULTRALIGHT_TOKEN/--token not provided",
      },
      request: {
        method: "GET",
        url: `${apiBase}${probe.path}`,
        headers: { Authorization: "Bearer [REDACTED_TOKEN]" },
      },
    };
  }

  const raw = await fetchProbe(`${apiBase}${probe.path}`, {
    headers: {
      "Origin": pagesBase,
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "ultralight-launch-web-pages-smoke",
    },
  });
  const corsOk = acao(raw.headers) === pagesBase;
  const passed = raw.ok && raw.status_code === 200 && corsOk &&
    /application\/json/i.test(contentType(raw.headers));
  return {
    name: probe.name,
    surface: "api",
    route: probe.path,
    status: passed ? "passed" : "failed",
    failure_class: passed
      ? null
      : !corsOk && raw.status_code === 200
      ? "api-cors"
      : probe.failureClass,
    expected: "Authenticated launch API route returns JSON for the Pages origin",
    observed: {
      status_code: raw.status_code,
      content_type: contentType(raw.headers) || null,
      access_control_allow_origin: acao(raw.headers) || null,
      final_url: raw.final_url,
      error: raw.error || null,
    },
    request: raw.request,
  };
}

function validateLaunchStatus(raw) {
  const payload = parseJson(raw.body_text);
  const ok = Boolean(
    payload && typeof payload === "object" &&
      payload.available === true &&
      typeof payload.version === "string" &&
      payload.endpoints && typeof payload.endpoints === "object",
  );
  return {
    ok,
    failureClass: ok ? null : "api-status",
    expected: "GET /api/launch/status returns launch status JSON",
    message: ok
      ? "launch status JSON detected"
      : "missing available/version/endpoints fields",
  };
}

function validateOpenApi(raw) {
  const payload = parseJson(raw.body_text);
  const ok = Boolean(payload && typeof payload === "object" && payload.openapi);
  return {
    ok,
    failureClass: ok ? null : "api-openapi",
    expected: "GET /api/launch/openapi.json returns an OpenAPI document",
    message: ok ? "openapi field detected" : "missing openapi field",
  };
}

function validateStore(raw) {
  const payload = parseJson(raw.body_text);
  const ok = Boolean(
    payload && typeof payload === "object" && Array.isArray(payload.results),
  );
  return {
    ok,
    failureClass: ok ? null : "api-data",
    expected: "GET /api/launch/store returns discovery JSON with results array",
    message: ok ? "results array detected" : "missing results array",
  };
}

function parseJson(value) {
  try {
    return JSON.parse(value || "");
  } catch {
    return null;
  }
}

function markdownPath(path) {
  const relativePath = relative(repoRoot, resolve(path)).replaceAll("\\", "/");
  return relativePath.startsWith("..") ? resolve(path) : relativePath;
}

function summarizeMarkdown(summary) {
  const lines = [
    "# Launch Web Pages Smoke",
    "",
    `- target: ${summary.target}`,
    `- pages_url: ${summary.pages_url}`,
    `- api_url: ${summary.api_url}`,
    `- generated_at: ${summary.generated_at}`,
    "",
    "| Probe | Status | Failure Class | Route | Observed |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const result of summary.results) {
    const observed = [
      result.observed?.status_code ? `status=${result.observed.status_code}` : null,
      result.observed?.content_type ? `type=${result.observed.content_type}` : null,
      result.observed?.access_control_allow_origin
        ? `ACAO=${result.observed.access_control_allow_origin}`
        : null,
      result.observed?.reason ? result.observed.reason : null,
      result.observed?.error ? `error=${result.observed.error}` : null,
    ].filter(Boolean).join("; ");
    lines.push(
      `| ${result.name} | ${result.status} | ${result.failure_class || "-"} | \`${result.route}\` | ${observed || "-"} |`,
    );
  }

  lines.push(
    "",
    "Failure classes:",
    "",
    "- `pages-routing`: Cloudflare Pages did not return the SPA route.",
    "- `pages-spa-shell`: Pages responded, but not with the launch SPA shell.",
    "- `api-status`: launch status endpoint failed or returned the wrong shape.",
    "- `api-openapi`: OpenAPI endpoint failed or returned the wrong shape.",
    "- `api-data`: public launch API data shape was wrong.",
    "- `api-cors`: API did not allow the launch-web Pages origin.",
    "- `auth-api`: authenticated launch API route failed.",
    "- `auth-data`: authenticated tool-specific data route failed.",
    "",
    `JSON evidence: [\`${markdownPath(outputJsonPath)}\`](${markdownPath(outputJsonPath)})`,
    "",
  );

  return `${lines.join("\n")}\n`;
}

const results = [];

for (const route of pageRoutes) {
  results.push(await runPageRoute(route));
}

for (const probe of publicApiProbes) {
  results.push(await runPublicApiProbe(probe));
}

results.push(await runCorsPreflight());

for (const probe of authenticatedApiProbes) {
  results.push(await runAuthenticatedApiProbe(probe));
}

const summary = {
  generated_at: nowIso(),
  target,
  pages_url: pagesBase,
  api_url: apiBase,
  tool_slug: toolSlug,
  admin_tool_id: adminToolId,
  token_supplied: Boolean(token),
  results,
  counts: {
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  },
};

writeFileSync(outputJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
writeFileSync(outputMarkdownPath, summarizeMarkdown(summary), "utf8");

console.log(`Launch web Pages smoke JSON written to ${outputJsonPath}`);
console.log(`Launch web Pages smoke markdown written to ${outputMarkdownPath}`);
console.log(`Passed: ${summary.counts.passed}`);
console.log(`Failed: ${summary.counts.failed}`);
console.log(`Skipped: ${summary.counts.skipped}`);

if (summary.counts.failed > 0) {
  process.exit(1);
}
