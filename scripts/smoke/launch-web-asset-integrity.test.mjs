import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverLaunchAssets,
  looksLikeHtmlDocument,
  looksLikeLaunchShell,
  validateMissingAssetResponse,
  validateReferencedAssetResponse,
} from "./launch-web-asset-integrity.mjs";

const ORIGIN = "https://connectgalactic.com";
const ROOT_HTML = `<!DOCTYPE html>
<html><head><title>Galactic</title>
<script crossorigin src="/assets/index-a1b2.js" type="module"></script>
<link href="/assets/index-c3d4.css" crossorigin rel="stylesheet">
</head><body><div id="app"></div></body></html>`;

function raw(overrides = {}) {
  return {
    ok: true,
    status_code: 200,
    final_url: `${ORIGIN}/assets/index-a1b2.js`,
    headers: { "content-type": "text/javascript; charset=utf-8" },
    body_text: "console.log('Galactic');",
    ...overrides,
  };
}

test("discovers every root module/preload and stylesheet independent of attribute order", () => {
  const html = `<!doctype html><html><head>
    <SCRIPT crossorigin SRC='/assets/index-a1b2.js?build=1&amp;mode=prod' TYPE='MODULE'></SCRIPT>
    <link href=/assets/chunk-e5f6.js rel='preload modulepreload' crossorigin>
    <LINK REL='alternate stylesheet' HREF='./assets/index-c3d4.css'>
    <script src="/favicon-theme.js"></script>
  </head><body><div id="app"></div></body></html>`;
  const discovery = discoverLaunchAssets(html, `${ORIGIN}/`);
  assert.deepEqual(discovery.errors, []);
  assert.deepEqual(discovery.assets.map(({ kind, route }) => ({ kind, route })), [
    { kind: "module", route: "/assets/index-a1b2.js?build=1&mode=prod" },
    { kind: "module", route: "/assets/chunk-e5f6.js" },
    { kind: "stylesheet", route: "/assets/index-c3d4.css" },
  ]);
});

test("deduplicates repeated references and rejects external or non-assets launch bundles", () => {
  const discovery = discoverLaunchAssets(`
    <script type="module" src="/assets/index.js"></script>
    <link rel="modulepreload" href="/assets/index.js">
    <link rel="stylesheet" href="https://cdn.example.com/index.css">
    <link rel="stylesheet" href="/styles/index.css">
  `, `${ORIGIN}/`);
  assert.equal(discovery.assets.length, 1);
  assert.equal(discovery.assets[0].route, "/assets/index.js");
  assert(discovery.errors.some((message) => message.includes("cross-origin stylesheet")));
  assert(discovery.errors.some((message) => message.includes("outside /assets/")));
  assert(discovery.errors.some((message) => message.includes("no stylesheet")));
});

test("reports absent module and stylesheet references", () => {
  const discovery = discoverLaunchAssets("<!doctype html><div id='app'></div>", `${ORIGIN}/`);
  assert.deepEqual(discovery.assets, []);
  assert(discovery.errors.some((message) => message.includes("no external module")));
  assert(discovery.errors.some((message) => message.includes("no stylesheet")));
});

test("accepts executable JavaScript and CSS assets", () => {
  const assets = discoverLaunchAssets(ROOT_HTML, `${ORIGIN}/`).assets;
  const moduleResult = validateReferencedAssetResponse(assets[0], raw());
  const stylesheetResult = validateReferencedAssetResponse(assets[1], raw({
    final_url: `${ORIGIN}/assets/index-c3d4.css`,
    headers: { "content-type": "text/css; charset=utf-8" },
    body_text: ".nebula { color: #fff; }",
  }));
  assert.equal(moduleResult.passed, true);
  assert.equal(stylesheetResult.passed, true);
});

test("rejects an asset with the wrong MIME type", () => {
  const [asset] = discoverLaunchAssets(ROOT_HTML, `${ORIGIN}/`).assets;
  const result = validateReferencedAssetResponse(asset, raw({
    headers: { "content-type": "text/plain" },
  }));
  assert.equal(result.passed, false);
  assert.equal(result.failureClass, "pages-asset-mime");
});

test("rejects empty, failed, and cross-origin asset deliveries", () => {
  const [asset] = discoverLaunchAssets(ROOT_HTML, `${ORIGIN}/`).assets;
  for (const response of [
    raw({ body_text: "" }),
    raw({ status_code: 404 }),
    raw({ final_url: "https://cdn.example.com/assets/index-a1b2.js" }),
  ]) {
    const result = validateReferencedAssetResponse(asset, response);
    assert.equal(result.passed, false);
    assert.equal(result.failureClass, "pages-asset-delivery");
  }
});

test("rejects a 200 SPA document masquerading as JavaScript", () => {
  const [asset] = discoverLaunchAssets(ROOT_HTML, `${ORIGIN}/`).assets;
  const result = validateReferencedAssetResponse(asset, raw({
    headers: { "content-type": "text/html; charset=utf-8" },
    body_text: ROOT_HTML,
  }));
  assert.equal(result.passed, false);
  assert.equal(result.failureClass, "pages-asset-fallback");
  assert.equal(result.htmlDetected, true);
});

test("HTML detection does not reject JavaScript containing an HTML string", () => {
  assert.equal(looksLikeHtmlDocument('const template = "<html><body></body></html>";', {
    "content-type": "text/javascript",
  }), false);
  assert.equal(looksLikeLaunchShell(ROOT_HTML, "", { "content-type": "text/html" }), true);
});

test("a missing asset passes only as a no-store, same-origin 404", () => {
  const result = validateMissingAssetResponse(raw({
    status_code: 404,
    final_url: `${ORIGIN}/assets/__missing.js`,
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
    body_text: "Not found",
  }), ROOT_HTML, ORIGIN);
  assert.equal(result.passed, true);
  assert.equal(result.shellDetected, false);
  assert.equal(result.noStore, true);
});

test("a generic HTML 404 is not mistaken for the Galactic SPA shell", () => {
  const result = validateMissingAssetResponse(raw({
    status_code: 404,
    final_url: `${ORIGIN}/assets/__missing.js`,
    headers: { "content-type": "text/html", "cache-control": "no-store" },
    body_text: "<!doctype html><html><head><title>Not Found</title></head><body>404</body></html>",
  }), ROOT_HTML, ORIGIN);
  assert.equal(result.passed, true);
  assert.equal(result.shellDetected, false);
});

test("a missing asset fails when it falls through to the SPA shell", () => {
  const result = validateMissingAssetResponse(raw({
    status_code: 200,
    final_url: `${ORIGIN}/assets/__missing.js`,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    },
    body_text: ROOT_HTML,
  }), ROOT_HTML, ORIGIN);
  assert.equal(result.passed, false);
  assert.equal(result.failureClass, "pages-asset-fallback");
  assert.equal(result.shellDetected, true);
  assert.equal(result.immutable, true);
});

test("an immutable missing-asset 404 still fails closed", () => {
  const result = validateMissingAssetResponse(raw({
    status_code: 404,
    final_url: `${ORIGIN}/assets/__missing.js`,
    headers: { "content-type": "text/plain", "cache-control": "public, immutable" },
    body_text: "Not found",
  }), ROOT_HTML, ORIGIN);
  assert.equal(result.passed, false);
  assert.equal(result.immutable, true);
});

test("a missing-asset 404 without no-store fails closed", () => {
  const result = validateMissingAssetResponse(raw({
    status_code: 404,
    final_url: `${ORIGIN}/assets/__missing.js`,
    headers: { "content-type": "text/plain", "cache-control": "max-age=0" },
    body_text: "Not found",
  }), ROOT_HTML, ORIGIN);
  assert.equal(result.passed, false);
  assert.equal(result.noStore, false);
  assert.match(result.reason, /not marked no-store/iu);
});
