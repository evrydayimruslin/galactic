#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import { ensureNode20, parseArgs, repoRoot } from "../analysis/_shared.mjs";
import {
  discoverLaunchAssets,
  validateMissingAssetResponse,
  validateReferencedAssetResponse,
} from "./launch-web-asset-integrity.mjs";

ensureNode20();

const args = parseArgs(process.argv.slice(2));

function printHelp() {
  console.log(`Usage: node scripts/smoke/wait-for-pages-deployment.mjs [options]

Options:
  --pages-url <url>             Deployed Pages origin to verify (required)
  --dist-dir <path>             Local Vite output to match exactly (required)
  --timeout-ms <ms>             Maximum propagation wait (default: 300000)
  --interval-ms <ms>            Delay between attempts (default: 3000)
  --consecutive-passes <count>  Stable passes required before success (default: 2)
  --help                        Show this help
`);
}

if (args.has("--help")) {
  printHelp();
  process.exit(0);
}

const pagesBase = String(args.get("--pages-url") || "").trim().replace(/\/+$/, "");
const distDir = resolve(repoRoot, String(args.get("--dist-dir") || ""));
const timeoutMs = Number.parseInt(String(args.get("--timeout-ms") || "300000"), 10);
const intervalMs = Number.parseInt(String(args.get("--interval-ms") || "3000"), 10);
const requiredPasses = Number.parseInt(
  String(args.get("--consecutive-passes") || "2"),
  10,
);

if (!pagesBase || !args.get("--dist-dir")) {
  printHelp();
  console.error("--pages-url and --dist-dir are required.");
  process.exit(1);
}

let pagesOrigin;
try {
  pagesOrigin = new URL(pagesBase).origin;
} catch {
  console.error(`Invalid --pages-url: ${pagesBase}`);
  process.exit(1);
}

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error("--timeout-ms must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
  console.error("--interval-ms must be a positive integer.");
  process.exit(1);
}
if (!Number.isFinite(requiredPasses) || requiredPasses <= 0) {
  console.error("--consecutive-passes must be a positive integer.");
  process.exit(1);
}

function requireFile(path, label, encoding = null) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing (${path})`);
  }
  return encoding ? readFileSync(path, encoding) : readFileSync(path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchPayload(
  url,
  accept,
  { bypassCache = false, timeoutMs: requestTimeoutMs = 15000 } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, requestTimeoutMs),
  );
  try {
    const headers = {
      "Accept": accept,
      "User-Agent": "galactic-pages-deployment-propagation-gate",
    };
    if (bypassCache) headers["Cache-Control"] = "no-cache";
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    const bodyBytes = Buffer.from(await response.arrayBuffer());
    return {
      ok: true,
      status_code: response.status,
      final_url: response.url,
      headers: Object.fromEntries(response.headers.entries()),
      body_bytes: bodyBytes,
      body_text: bodyBytes.toString("utf8"),
    };
  } catch (error) {
    return {
      ok: false,
      status_code: null,
      final_url: url,
      headers: {},
      body_bytes: Buffer.alloc(0),
      body_text: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const expectedIndex = requireFile(
  resolve(distDir, "index.html"),
  "dist/index.html",
  "utf8",
);
const expectedDiscovery = discoverLaunchAssets(expectedIndex, `${pagesBase}/`);
if (expectedDiscovery.errors.length > 0) {
  console.error(
    `Local Pages output is invalid: ${expectedDiscovery.errors.join("; ")}`,
  );
  process.exit(1);
}

const expectedAssets = expectedDiscovery.assets.map((asset) => {
  const pathname = decodeURIComponent(new URL(asset.url).pathname).replace(
    /^\/+/, "",
  );
  const outputPath = resolve(distDir, pathname);
  const distPrefix = `${distDir}${sep}`;
  if (!outputPath.startsWith(distPrefix)) {
    throw new Error(`Asset escaped dist directory: ${asset.route}`);
  }
  const bodyBytes = requireFile(outputPath, `built asset ${asset.route}`);
  return {
    ...asset,
    body_bytes: bodyBytes,
    digest: sha256(bodyBytes),
  };
});

const expectedKeys = new Set(
  expectedAssets.map((asset) => `${asset.kind}:${asset.route}`),
);
const missingPath = `/assets/__galactic-deploy-missing-${randomUUID()}.js`;

async function probeAttempt(attempt, deadline) {
  const reasons = [];
  const nextTimeout = () => Math.min(15000, Math.max(1, deadline - Date.now()));
  const rootUrl = new URL(`${pagesBase}/`);
  rootUrl.searchParams.set("__galactic_deploy_probe", `${Date.now()}-${attempt}`);
  const root = await fetchPayload(rootUrl.href, "text/html", {
    bypassCache: true,
    timeoutMs: nextTimeout(),
  });
  const rootType = root.headers["content-type"] || "";
  if (!root.ok || root.status_code !== 200 || !/text\/html/iu.test(rootType)) {
    reasons.push(
      `root returned ${root.status_code ?? "transport failure"} ${rootType || "without content-type"}`,
    );
  }
  try {
    if (new URL(root.final_url).origin !== pagesOrigin) {
      reasons.push(`root redirected off-origin to ${root.final_url}`);
    }
  } catch {
    reasons.push(`root returned an invalid final URL: ${root.final_url}`);
  }

  const liveDiscovery = discoverLaunchAssets(
    root.body_text,
    root.final_url || rootUrl.href,
  );
  reasons.push(...liveDiscovery.errors.map((message) => `live root: ${message}`));
  const liveKeys = new Set(
    liveDiscovery.assets.map((asset) => `${asset.kind}:${asset.route}`),
  );
  for (const key of expectedKeys) {
    if (!liveKeys.has(key)) reasons.push(`live root is missing ${key}`);
  }
  for (const key of liveKeys) {
    if (!expectedKeys.has(key)) {
      reasons.push(`live root still references unexpected ${key}`);
    }
  }

  for (const asset of expectedAssets) {
    // Probe the exact URL a browser uses. Do not bypass its cache: a poisoned
    // cached response must block the release rather than being hidden here.
    const raw = await fetchPayload(
      asset.url,
      asset.kind === "module"
        ? "application/javascript,*/*;q=0.8"
        : "text/css,*/*;q=0.8",
      { timeoutMs: nextTimeout() },
    );
    if (raw.final_url !== asset.url) {
      reasons.push(`${asset.route}: redirected to ${raw.final_url}`);
      continue;
    }
    const validation = validateReferencedAssetResponse(asset, raw);
    if (!validation.passed) {
      reasons.push(`${asset.route}: ${validation.reason}`);
      continue;
    }
    if (!raw.body_bytes.equals(asset.body_bytes)) {
      reasons.push(
        `${asset.route}: content mismatch (expected ${asset.digest.slice(0, 12)}, got ${sha256(raw.body_bytes).slice(0, 12)})`,
      );
    }
  }

  const missing = await fetchPayload(
    `${pagesBase}${missingPath}`,
    "application/javascript,*/*;q=0.8",
    { timeoutMs: nextTimeout() },
  );
  const expectedMissingUrl = `${pagesBase}${missingPath}`;
  if (missing.final_url !== expectedMissingUrl) {
    reasons.push(`${missingPath}: redirected to ${missing.final_url}`);
  }
  const missingValidation = validateMissingAssetResponse(
    missing,
    root.body_text,
    pagesOrigin,
  );
  if (!missingValidation.passed) {
    reasons.push(`${missingPath}: ${missingValidation.reason}`);
  }

  return { passed: reasons.length === 0, reasons };
}

console.log(
  `Waiting for ${pagesBase} to match ${expectedAssets.length} built assets ` +
    `(${requiredPasses} consecutive passes, ${timeoutMs}ms timeout).`,
);
for (const asset of expectedAssets) {
  console.log(`Expected ${asset.kind} ${asset.route} sha256=${asset.digest}.`);
}

const deadline = Date.now() + timeoutMs;
let attempt = 0;
let consecutivePasses = 0;
while (Date.now() < deadline) {
  attempt += 1;
  const result = await probeAttempt(attempt, deadline);
  if (result.passed) {
    consecutivePasses += 1;
    console.log(`Attempt ${attempt}: ready (${consecutivePasses}/${requiredPasses}).`);
    if (consecutivePasses >= requiredPasses) {
      console.log(`Pages deployment is stable at ${pagesBase}.`);
      process.exit(0);
    }
  } else {
    consecutivePasses = 0;
    console.log(`Attempt ${attempt}: not ready — ${result.reasons.join("; ")}`);
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) break;
  await sleep(Math.min(intervalMs, remaining));
}

console.error(
  `Pages deployment did not become stable after ${attempt} attempts (${timeoutMs}ms).`,
);
process.exit(1);
