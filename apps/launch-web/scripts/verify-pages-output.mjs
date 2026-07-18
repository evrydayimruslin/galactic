#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(appRoot, "dist");

function fail(message) {
  console.error(`Pages output verification failed: ${message}`);
  process.exitCode = 1;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`${label} is missing (${path}).`);
    return null;
  }
  return readFileSync(path, "utf8");
}

if (existsSync(resolve(dist, "404.html"))) {
  fail("dist/404.html must not exist; it disables Cloudflare Pages' SPA fallback.");
}

if (existsSync(resolve(dist, "_redirects"))) {
  fail("dist/_redirects must not exist; a wildcard rewrite can turn missing assets into cacheable HTML.");
}

const asset404 = requireFile(
  resolve(dist, "assets", "404.html"),
  "the nested assets/404.html fail-closed response",
);
if (asset404 !== null && !/asset not found/iu.test(asset404)) {
  fail("dist/assets/404.html does not contain the expected asset-not-found marker.");
}

const headers = requireFile(resolve(dist, "_headers"), "dist/_headers");
if (headers !== null) {
  if (/\/assets\/\*[\s\S]*?cache-control:[^\r\n]*immutable/iu.test(headers)) {
    fail("dist/_headers still makes the broad /assets/* namespace immutable.");
  }
  if (!/\/index\.html\s+[\s\S]*?cache-control:\s*no-store/iu.test(headers)) {
    fail("dist/_headers must keep index.html non-cacheable.");
  }
}

const index = requireFile(resolve(dist, "index.html"), "dist/index.html");
if (index !== null) {
  const references = [...new Set([
    ...index.matchAll(/<(?:script|link)\b[^>]+(?:src|href)=["'](\/assets\/[^"']+)["'][^>]*>/giu),
  ].map((match) => match[1]))];
  const js = references.find((path) => /\.js(?:\?|$)/iu.test(path));
  const css = references.find((path) => /\.css(?:\?|$)/iu.test(path));

  if (!js || !css) {
    fail("dist/index.html must reference content-hashed JavaScript and CSS assets.");
  }

  for (const reference of references) {
    if (!/-[A-Za-z0-9_-]{8}\.(?:js|css)$/u.test(reference)) {
      fail(`client asset filename is not content-hashed (${reference}).`);
    }
    const outputPath = resolve(dist, reference.slice(1));
    if (!existsSync(outputPath) || !statSync(outputPath).isFile()) {
      fail(`referenced client asset is missing (${reference}).`);
    }
  }

  if (js) {
    const source = readFileSync(resolve(dist, js.slice(1)), "utf8");
    if (
      !source.includes("launchClient") || !source.includes("booted") ||
      !/launchRoutingRevision\s*=\s*[`"']2[`"']/u.test(source)
    ) {
      fail("the entry module is missing the launch-client boot sentinel.");
    }
  }

  if (css) {
    const source = readFileSync(resolve(dist, css.slice(1)), "utf8");
    if (!source.includes("--launch-asset-routing-revision:2")) {
      fail("the emitted stylesheet is missing the asset-routing revision marker.");
    }
  }
}

if (!process.exitCode) {
  console.log("Cloudflare Pages output routing verified.");
}
