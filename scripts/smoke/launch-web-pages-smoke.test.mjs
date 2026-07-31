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

const weeklyCapacity = {
  plan: "pro",
  state: "available",
  weekly: {
    state: "available",
    resetsAt: "2026-08-03T00:00:00.000Z",
    usedPercent: 25,
  },
  nextEligibleAt: null,
  activeAgentLimit: null,
  generatedAt: "2026-07-30T12:00:00.000Z",
};

async function startFixtureServer({
  redirectPath = "",
  capacity = weeklyCapacity,
  subscriptionOverrides = {},
} = {}) {
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

    if (requestUrl === "/api/launch/capacity") {
      response.writeHead(200, {
        "Access-Control-Allow-Origin": origin,
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(capacity));
      return;
    }

    if (requestUrl === "/api/launch/subscription") {
      response.writeHead(200, {
        "Access-Control-Allow-Origin": origin,
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({
        plan: "pro",
        planName: "Membership",
        priceCents: 2_000,
        currency: "usd",
        interval: "month",
        status: "active",
        currentPeriodEnd: "2026-08-30T12:00:00.000Z",
        cancelAtPeriodEnd: false,
        hasActiveSubscription: true,
        canSubscribe: false,
        canManage: true,
        capacity,
        generatedAt: "2026-07-30T12:00:00.000Z",
        ...subscriptionOverrides,
      }));
      return;
    }

    if (requestUrl === "/api/launch/wallet") {
      response.writeHead(410, {
        "Access-Control-Allow-Origin": origin,
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({
        error: "Wallet is not part of the persistent-Agent launch",
      }));
      return;
    }

    if (requestUrl === "/api/launch/api-keys") {
      response.writeHead(403, {
        "Access-Control-Allow-Origin": origin,
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({
        error: "API key management requires an account session",
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

async function runSmoke({ includeAuthApi = false, ...options } = {}) {
  const fixture = await startFixtureServer(options);
  const outputDir = mkdtempSync(join(tmpdir(), "galactic-pages-smoke-"));
  let stdout = "";
  let stderr = "";

  try {
    const childArgs = [
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
      ...(includeAuthApi
        ? ["--token", "fixture-token"]
        : ["--skip-auth-api"]),
    ];
    const child = spawn(process.execPath, childArgs, {
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

test("accepts the authenticated weekly-only capacity contract", {
  timeout: 15_000,
}, async () => {
  const result = await runSmoke({ includeAuthApi: true });
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);

  const resultsByName = new Map(
    result.summary.results.map((probe) => [probe.name, probe]),
  );
  for (
    const name of [
      "api-launch-subscription",
      "api-launch-capacity",
      "api-launch-wallet-retired",
      "api-launch-settings-keys",
    ]
  ) {
    assert.equal(resultsByName.get(name)?.status, "passed", name);
  }
  assert.equal(
    resultsByName.get("api-launch-capacity")?.request.headers.Authorization,
    "Bearer [REDACTED_TOKEN]",
  );
  for (
    const evidence of [
      result.stdout,
      result.stderr,
      JSON.stringify(result.summary),
    ]
  ) {
    assert.doesNotMatch(evidence, /fixture-token/);
  }
});

test("rejects a legacy subscription plan", {
  timeout: 15_000,
}, async () => {
  const result = await runSmoke({
    includeAuthApi: true,
    subscriptionOverrides: {
      plan: "free",
      priceCents: 0,
    },
  });
  assert.equal(result.signal, null);
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);

  const subscription = result.summary.results.find((probe) =>
    probe.name === "api-launch-subscription"
  );
  const capacity = result.summary.results.find((probe) =>
    probe.name === "api-launch-capacity"
  );
  assert.equal(subscription?.status, "failed");
  assert.equal(
    subscription?.observed.validation,
    "subscription shape or no-fee invariant failed",
  );
  assert.equal(capacity?.status, "passed");
});

test("rejects undeclared or contradictory subscription fields", {
  timeout: 15_000,
}, async () => {
  for (
    const subscriptionOverrides of [{
      processingFeeCents: 123,
    }, {
      canSubscribe: true,
      canManage: true,
    }]
  ) {
    const result = await runSmoke({
      includeAuthApi: true,
      subscriptionOverrides,
    });
    assert.equal(result.signal, null);
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);

    const subscription = result.summary.results.find((probe) =>
      probe.name === "api-launch-subscription"
    );
    const capacity = result.summary.results.find((probe) =>
      probe.name === "api-launch-capacity"
    );
    assert.equal(subscription?.status, "failed");
    assert.equal(capacity?.status, "passed");
  }
});

test("rejects retired burst capacity and hidden limit fields", {
  timeout: 15_000,
}, async () => {
  for (
    const capacity of [{
      ...weeklyCapacity,
      burst: {
        state: "available",
        resetsAt: "2026-07-30T14:00:00.000Z",
      },
    }, {
      ...weeklyCapacity,
      weekly: {
        ...weeklyCapacity.weekly,
        remainingLight: 300,
      },
    }]
  ) {
    const result = await runSmoke({
      includeAuthApi: true,
      capacity,
    });
    assert.equal(result.signal, null);
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);

    const resultsByName = new Map(
      result.summary.results.map((probe) => [probe.name, probe]),
    );
    for (const name of ["api-launch-subscription", "api-launch-capacity"]) {
      const probe = resultsByName.get(name);
      assert.equal(probe?.status, "failed", name);
      assert.match(probe?.observed.validation || "", /weekly-only|hidden-limit/);
    }
  }
});
