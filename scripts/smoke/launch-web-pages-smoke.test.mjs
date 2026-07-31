import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const smokeScript = join(scriptDir, "launch-web-pages-smoke.mjs");

const launchShell = `<!doctype html>
<html>
  <head>
    <script type="module" src="/assets/index-test.js"></script>
    <link rel="stylesheet" href="/assets/index-test.css">
  </head>
  <body><div id="root"></div></body>
</html>`;

const funnelRoutes = [
  {
    name: "page-auth-funnel",
    path: "/connect?intent=agent",
  },
  {
    name: "page-magic-link-confirmation",
    path: "/auth/confirm",
  },
  {
    name: "page-auth-callback",
    path: "/auth/callback",
  },
];

async function startFixtureServer({ redirectPath = "" } = {}) {
  const requests = [];
  let origin = "";
  const server = createServer((request, response) => {
    const requestUrl = request.url || "/";
    requests.push(`${request.method} ${requestUrl}`);

    if (redirectPath && requestUrl === redirectPath) {
      response.writeHead(302, { Location: "/" });
      response.end();
      return;
    }

    if (request.method === "OPTIONS" && requestUrl === "/api/launch/status") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      });
      response.end();
      return;
    }

    if (requestUrl === "/api/launch/status") {
      response.writeHead(200, {
        "Access-Control-Allow-Origin": origin,
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({
        available: true,
        version: "fixture",
        endpoints: {},
      }));
      return;
    }

    if (requestUrl === "/api/launch/openapi.json") {
      response.writeHead(200, {
        "Access-Control-Allow-Origin": origin,
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({ openapi: "3.1.0" }));
      return;
    }

    if (requestUrl === "/assets/index-test.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end("globalThis.__galacticSmokeFixture = true;");
      return;
    }

    if (requestUrl === "/assets/index-test.css") {
      response.writeHead(200, { "Content-Type": "text/css" });
      response.end(":root { color-scheme: light; }");
      return;
    }

    if (requestUrl.startsWith("/assets/__galactic-smoke-missing-")) {
      response.writeHead(404, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain",
      });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(launchShell);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, requests };
}

async function runSmoke(options = {}) {
  const fixture = await startFixtureServer(options);
  const outputDir = mkdtempSync(join(tmpdir(), "galactic-pages-smoke-"));
  let stdout = "";
  let stderr = "";

  try {
    const child = spawn(process.execPath, [
      smokeScript,
      "--target",
      "staging",
      "--pages-url",
      fixture.origin,
      "--api-url",
      fixture.origin,
      "--output-dir",
      outputDir,
      "--timeout-ms",
      "2000",
      "--asset-settle-timeout-ms",
      "2000",
      "--asset-settle-interval-ms",
      "10",
      "--skip-auth-api",
    ], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const childTimeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [code, signal] = await once(child, "close").finally(() => {
      clearTimeout(childTimeout);
    });
    const summary = JSON.parse(readFileSync(
      join(outputDir, "smoke", "launch-web-pages.json"),
      "utf8",
    ));
    return {
      code,
      signal,
      stdout,
      stderr,
      summary,
      origin: fixture.origin,
      requests: [...fixture.requests],
    };
  } finally {
    await new Promise((resolveClose) => fixture.server.close(resolveClose));
    rmSync(outputDir, { recursive: true, force: true });
  }
}

test("probes every token-free unauthenticated auth-funnel deep link", {
  timeout: 15_000,
}, async () => {
  const result = await runSmoke();
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  const resultsByName = new Map(
    result.summary.results.map((probe) => [probe.name, probe]),
  );
  for (const route of funnelRoutes) {
    const probe = resultsByName.get(route.name);
    assert(probe, `missing ${route.name}`);
    assert.equal(probe.route, route.path);
    assert.equal(probe.auth_route, false);
    assert.equal(probe.status, "passed");
    assert.equal(probe.failure_class, null);
    assert.equal(probe.observed.location_preserved, true);
    assert.equal(probe.observed.final_url, `${result.origin}${route.path}`);
    assert.equal(probe.request.method, "GET");
    assert(result.requests.includes(`GET ${route.path}`));

    const requestedUrl = new URL(probe.request.url);
    for (const sensitiveParameter of [
      "access_token",
      "code",
      "refresh_token",
      "token",
      "token_hash",
    ]) {
      assert.equal(requestedUrl.searchParams.has(sensitiveParameter), false);
    }
  }
});

test("fails closed when an auth deep link redirects to the home shell", {
  timeout: 15_000,
}, async () => {
  const result = await runSmoke({ redirectPath: "/auth/confirm" });
  assert.equal(result.signal, null);
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);

  const probe = result.summary.results.find((item) =>
    item.name === "page-magic-link-confirmation"
  );
  assert(probe);
  assert.equal(probe.status, "failed");
  assert.equal(probe.failure_class, "pages-routing");
  assert.equal(probe.observed.location_preserved, false);
  assert.equal(probe.observed.final_url, `${result.origin}/`);
});
