#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ensureNode20, parseArgs, repoRoot } from "../analysis/_shared.mjs";
import {
  discoverLaunchAssets,
  responseContentType,
  validateMissingAssetResponse,
  validateReferencedAssetResponse,
} from "./launch-web-asset-integrity.mjs";

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
  ? "https://connectgalactic.com"
  : "https://staging.ultralight-launch-web.pages.dev";
const defaultApiUrl = target === "production"
  ? "https://api.connectgalactic.com"
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
  { name: "page-agents", path: "/agents", auth: true },
  { name: "page-profile", path: "/account", auth: true },
  { name: "page-agent-home", path: `/agents/${encodeURIComponent(toolSlug)}`, auth: true },
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
];

const authenticatedApiProbes = [
  {
    name: "api-launch-subscription",
    path: "/api/launch/subscription",
    failureClass: "auth-api",
    validate: validateSubscription,
  },
  {
    name: "api-launch-capacity",
    path: "/api/launch/capacity",
    failureClass: "auth-api",
    validate: validateCapacity,
  },
  {
    name: "api-launch-wallet-retired",
    path: "/api/launch/wallet",
    failureClass: "auth-api",
    expectStatus: 410,
    expectBodyPattern: /not part of the persistent-Agent launch/i,
    expected: "Customer-facing credits endpoint is retired with HTTP 410",
  },
  {
    // API-key management is browser-account-session ONLY (Tier-2 lockdown):
    // requireAccountSessionForApiKeys rejects bearer api tokens with 403. This
    // probe asserts the gate is working — a 200 here would be the regression.
    name: "api-launch-settings-keys",
    path: "/api/launch/api-keys",
    failureClass: "auth-api",
    expectStatus: 403,
    expectBodyPattern: /account session/i,
    expected:
      "Bearer API token is rejected with 403 JSON (API key management is browser-session only)",
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

async function runPageAssetProbes(shell) {
  const documentUrl = shell.final_url || `${pagesBase}/`;
  const discovery = discoverLaunchAssets(shell.body_text || "", documentUrl);
  const probes = [];
  const discoveryPassed = shell.ok && shell.status_code === 200 &&
    discovery.errors.length === 0;
  probes.push({
    name: "page-asset-discovery",
    surface: "pages",
    route: "/",
    status: discoveryPassed ? "passed" : "failed",
    failure_class: discoveryPassed ? null : "pages-asset-discovery",
    expected:
      "Root launch HTML references same-origin /assets/ modules and stylesheets",
    observed: {
      status_code: shell.status_code,
      content_type: contentType(shell.headers) || null,
      final_url: shell.final_url,
      module_count: discovery.assets.filter((asset) => asset.kind === "module").length,
      stylesheet_count: discovery.assets.filter((asset) => asset.kind === "stylesheet").length,
      errors: discovery.errors,
      error: shell.error || null,
    },
    request: shell.request,
  });

  const kindCounts = { module: 0, stylesheet: 0 };
  for (const asset of discovery.assets) {
    kindCounts[asset.kind] += 1;
    const raw = await fetchProbe(asset.url, {
      headers: {
        "Accept": asset.kind === "module"
          ? "application/javascript,*/*;q=0.8"
          : "text/css,*/*;q=0.8",
        "Cache-Control": "no-cache",
        "User-Agent": "ultralight-launch-web-pages-smoke",
      },
    });
    const validation = validateReferencedAssetResponse(asset, raw);
    probes.push({
      name: `page-${asset.kind}-asset-${kindCounts[asset.kind]}`,
      surface: "pages",
      route: asset.route,
      status: validation.passed ? "passed" : "failed",
      failure_class: validation.failureClass,
      expected:
        "Referenced launch asset returns HTTP 200 with executable MIME and never HTML",
      observed: {
        status_code: raw.status_code,
        content_type: validation.contentType || null,
        final_url: raw.final_url,
        bytes: String(raw.body_text || "").length,
        html_detected: validation.htmlDetected,
        validation: validation.reason,
        error: raw.error || null,
      },
      request: raw.request,
    });
  }

  const missingPath = `/assets/__galactic-smoke-missing-${randomUUID()}.js`;
  const missingUrl = new URL(missingPath, documentUrl);
  for (const attempt of [1, 2]) {
    const missing = await fetchProbe(missingUrl.href, {
      headers: {
        "Accept": "application/javascript,*/*;q=0.8",
        "Cache-Control": "no-cache",
        "User-Agent": "ultralight-launch-web-pages-smoke",
      },
    });
    const missingValidation = validateMissingAssetResponse(
      missing,
      shell.body_text || "",
      missingUrl.origin,
    );
    probes.push({
      name: attempt === 1
        ? "page-missing-asset-fails-closed"
        : "page-missing-asset-repeat-fails-closed",
      surface: "pages",
      route: missingPath,
      status: missingValidation.passed ? "passed" : "failed",
      failure_class: missingValidation.failureClass,
      expected:
        "The same unique missing asset repeatedly returns no-store HTTP 404 instead of the launch SPA shell",
      observed: {
        attempt,
        status_code: missing.status_code,
        content_type: responseContentType(missing.headers) || null,
        cache_control: missingValidation.cacheControl || null,
        shell_detected: missingValidation.shellDetected,
        immutable: missingValidation.immutable,
        no_store: missingValidation.noStore,
        validation: missingValidation.reason,
        final_url: missing.final_url,
        error: missing.error || null,
      },
      request: missing.request,
    });
  }

  return probes;
}

async function runPageRoute(route) {
  const raw = await fetchProbe(`${pagesBase}${route.path}`, {
    headers: {
      "Accept": "text/html",
      "Cache-Control": "no-cache",
      "User-Agent": "ultralight-launch-web-pages-smoke",
    },
  });
  return { raw, result: classifyPageProbe(raw, route) };
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
  const expectStatus = probe.expectStatus ?? 200;
  const corsOk = acao(raw.headers) === pagesBase;
  // For non-200 expectations, also require the gate's own message so a generic
  // 403 (e.g. a WAF) can't fake a pass.
  const payload = parseJson(raw.body_text);
  const bodyOk = !probe.expectBodyPattern ||
    probe.expectBodyPattern.test(payload?.error || "");
  const shape = probe.validate ? probe.validate(raw) : { ok: true, message: "" };
  const passed = raw.status_code === expectStatus && corsOk && bodyOk && shape.ok &&
    /application\/json/i.test(contentType(raw.headers));
  return {
    name: probe.name,
    surface: "api",
    route: probe.path,
    status: passed ? "passed" : "failed",
    failure_class: passed
      ? null
      : !corsOk && raw.status_code === expectStatus
      ? "api-cors"
      : probe.failureClass,
    expected: probe.expected ??
      "Authenticated launch API route returns JSON for the Pages origin",
    observed: {
      status_code: raw.status_code,
      content_type: contentType(raw.headers) || null,
      access_control_allow_origin: acao(raw.headers) || null,
      final_url: raw.final_url,
      error: raw.error || null,
      validation: shape.message || null,
    },
    request: raw.request,
  };
}

function validateCapacity(raw) {
  const payload = parseJson(raw.body_text);
  const states = new Set(["available", "low", "waiting"]);
  const plans = new Set(["free", "pro", "max_5x", "max_10x"]);
  const ok = Boolean(payload && plans.has(payload.plan) && states.has(payload.state) &&
    states.has(payload.burst?.state) && states.has(payload.weekly?.state) &&
    typeof payload.burst?.resetsAt === "string" &&
    typeof payload.weekly?.resetsAt === "string" &&
    !Object.prototype.hasOwnProperty.call(payload, "balance") &&
    !Object.prototype.hasOwnProperty.call(payload, "credits"));
  return { ok, message: ok ? "safe capacity state/reset projection detected" : "capacity shape or hidden-balance invariant failed" };
}

function validateSubscription(raw) {
  const payload = parseJson(raw.body_text);
  const ok = Boolean(payload && typeof payload.plan === "string" &&
    typeof payload.planName === "string" && payload.currency === "usd" &&
    payload.interval === "month" && payload.capacity &&
    validateCapacity({ body_text: JSON.stringify(payload.capacity) }).ok &&
    !Object.prototype.hasOwnProperty.call(payload, "processingFee") &&
    !Object.prototype.hasOwnProperty.call(payload, "agentFee"));
  return { ok, message: ok ? "BYOK subscription and shared-capacity projection detected" : "subscription shape or no-fee invariant failed" };
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
    "- `pages-asset-discovery`: root HTML omitted its module/stylesheet or referenced an unsafe asset URL.",
    "- `pages-asset-delivery`: a referenced client asset was missing, empty, or redirected off-origin.",
    "- `pages-asset-mime`: a referenced client asset used the wrong executable MIME type.",
    "- `pages-asset-fallback`: an asset request returned HTML or a missing asset fell through to the SPA shell.",
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
let rootPageProbe = null;

for (const route of pageRoutes) {
  const pageProbe = await runPageRoute(route);
  results.push(pageProbe.result);
  if (route.path === "/") rootPageProbe = pageProbe.raw;
}

// pageRoutes always contains `/`; keep the fallback defensive so a future
// route-list refactor cannot silently drop the asset-integrity gate.
if (!rootPageProbe) {
  rootPageProbe = await fetchProbe(`${pagesBase}/`, {
    headers: {
      "Accept": "text/html",
      "Cache-Control": "no-cache",
      "User-Agent": "ultralight-launch-web-pages-smoke",
    },
  });
}
results.push(...await runPageAssetProbes(rootPageProbe));

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
