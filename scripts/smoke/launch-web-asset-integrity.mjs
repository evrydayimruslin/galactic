const MODULE_MIME_PATTERN = /^(?:application|text)\/(?:javascript|x-javascript|ecmascript)(?:\s*;|$)/iu;
const STYLESHEET_MIME_PATTERN = /^text\/css(?:\s*;|$)/iu;
const CLOUDFLARE_WEB_ANALYTICS_ORIGIN =
  "https://static.cloudflareinsights.com";
const CLOUDFLARE_WEB_ANALYTICS_PATH =
  /^\/beacon\.min\.js\/v[0-9a-f]{32,64}$/u;
const SECURITY_SENSITIVE_BEACON_ATTRIBUTES = new Set([
  "type",
  "src",
  "crossorigin",
  "integrity",
  "data-cf-beacon",
]);

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function tagAttributes(tag) {
  const attributes = {};
  const duplicates = new Set();
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of tag.matchAll(attributePattern)) {
    const name = match[1].toLowerCase();
    if (name.startsWith("<")) continue;
    if (Object.hasOwn(attributes, name)) duplicates.add(name);
    attributes[name] = decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return { attributes, duplicates };
}

function relTokens(value) {
  return new Set(String(value || "").toLowerCase().split(/\s+/u).filter(Boolean));
}

function hasCanonicalSha512Integrity(value) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(String(value || ""));
  if (!match) return false;
  try {
    const digest = Buffer.from(match[1], "base64");
    return digest.length === 64 && digest.toString("base64") === match[1];
  } catch {
    return false;
  }
}

function hasValidCloudflareBeaconData(value) {
  try {
    const data = JSON.parse(String(value || ""));
    if (
      !data || typeof data !== "object" || Array.isArray(data) ||
      Object.getPrototypeOf(data) !== Object.prototype
    ) {
      return false;
    }
    const keys = Object.keys(data).sort();
    return keys.length === 3 &&
      keys[0] === "r" &&
      keys[1] === "token" &&
      keys[2] === "version" &&
      data.r === 1 &&
      typeof data.token === "string" &&
      /^[0-9a-f]{32}$/u.test(data.token) &&
      typeof data.version === "string" &&
      /^\d+(?:\.\d+)+$/u.test(data.version);
  } catch {
    return false;
  }
}

function isCloudflareWebAnalyticsBeacon(tagName, attributes, duplicates, url) {
  return tagName === "script" &&
    attributes.type?.toLowerCase() === "module" &&
    url.protocol === "https:" &&
    url.origin === CLOUDFLARE_WEB_ANALYTICS_ORIGIN &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    CLOUDFLARE_WEB_ANALYTICS_PATH.test(url.pathname) &&
    url.search === "" &&
    url.hash === "" &&
    attributes.crossorigin === "anonymous" &&
    hasCanonicalSha512Integrity(attributes.integrity) &&
    hasValidCloudflareBeaconData(attributes["data-cf-beacon"]) &&
    ![...SECURITY_SENSITIVE_BEACON_ATTRIBUTES].some((name) =>
      duplicates.has(name)
    );
}

/**
 * Discover every executable module/preload and stylesheet referenced by the
 * built root document. Vite currently emits one of each, but collecting all of
 * them keeps this guard valid if chunk preloads are introduced later. Cloudflare
 * may inject its Web Analytics beacon into the response at the edge. That
 * provider-owned auxiliary module is not a launch bundle, so ignore only its
 * exact HTTPS origin and documented/versioned beacon path.
 */
export function discoverLaunchAssets(html, documentUrl) {
  const assets = [];
  const errors = [];
  let document;
  try {
    document = new URL(documentUrl);
  } catch {
    return { assets, errors: [`invalid root document URL: ${documentUrl}`] };
  }

  const seen = new Set();
  let cloudflareBeaconSeen = false;
  const tags = String(html || "").match(/<(?:script|link)\b[^>]*>/giu) || [];
  for (const tag of tags) {
    const tagName = /^<\s*(script|link)\b/iu.exec(tag)?.[1]?.toLowerCase();
    const { attributes, duplicates } = tagAttributes(tag);
    const rel = relTokens(attributes.rel);
    const kind = tagName === "script" && attributes.type?.toLowerCase() === "module" &&
        attributes.src
      ? "module"
      : tagName === "link" && rel.has("modulepreload") && attributes.href
      ? "module"
      : tagName === "link" && rel.has("stylesheet") && attributes.href
      ? "stylesheet"
      : null;
    const reference = tagName === "script" ? attributes.src : attributes.href;
    if (!kind || !reference) continue;

    let url;
    try {
      url = new URL(reference, document);
    } catch {
      errors.push(`invalid ${kind} asset reference: ${reference}`);
      continue;
    }
    if (url.origin !== document.origin) {
      if (
        kind === "module" &&
        isCloudflareWebAnalyticsBeacon(tagName, attributes, duplicates, url)
      ) {
        if (cloudflareBeaconSeen) {
          errors.push("duplicate Cloudflare Web Analytics module");
        }
        cloudflareBeaconSeen = true;
        continue;
      }
      errors.push(`cross-origin ${kind} asset reference: ${url.href}`);
      continue;
    }
    url.hash = "";
    if (!url.pathname.startsWith("/assets/")) {
      errors.push(`launch ${kind} asset is outside /assets/: ${url.pathname}`);
      continue;
    }
    const key = `${kind}:${url.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assets.push({ kind, reference, url: url.href, route: `${url.pathname}${url.search}` });
  }

  if (!assets.some((asset) => asset.kind === "module")) {
    errors.push("root document references no external module asset");
  }
  if (!assets.some((asset) => asset.kind === "stylesheet")) {
    errors.push("root document references no stylesheet asset");
  }
  return { assets, errors };
}

export function responseContentType(headers = {}) {
  return headers["content-type"] || headers["Content-Type"] || "";
}

export function looksLikeHtmlDocument(body, headers = {}) {
  const type = responseContentType(headers);
  if (/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(type)) return true;
  return /^\s*(?:\uFEFF\s*)?<(?:(?:!doctype\s+)?html|head|body)\b/iu.test(
    String(body || ""),
  );
}

export function looksLikeLaunchShell(body, rootHtml = "", headers = {}) {
  const value = String(body || "");
  const normalized = value.trim();
  if (rootHtml && normalized && normalized === String(rootHtml).trim()) return true;
  if (!looksLikeHtmlDocument(value, headers)) return false;
  const hasMount = /\bid\s*=\s*["'](?:app|root)["']/iu.test(value);
  const hasLaunchMarker = /(?:<title>[^<]*Galactic|\/(?:assets)\/[^"']+\.(?:m?js|css))/iu
    .test(value);
  return hasMount && hasLaunchMarker;
}

function finalUrlStaysOnOrigin(finalUrl, expectedOrigin) {
  try {
    return new URL(finalUrl).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function validateReferencedAssetResponse(asset, raw) {
  const type = responseContentType(raw.headers);
  const htmlDetected = looksLikeHtmlDocument(raw.body_text, raw.headers);
  const expectedOrigin = new URL(asset.url).origin;
  const finalOriginOk = finalUrlStaysOnOrigin(raw.final_url, expectedOrigin);
  const mimeOk = asset.kind === "module"
    ? MODULE_MIME_PATTERN.test(type)
    : STYLESHEET_MIME_PATTERN.test(type);
  const bodyPresent = String(raw.body_text || "").length > 0;
  const passed = raw.ok === true && raw.status_code === 200 && finalOriginOk &&
    bodyPresent && mimeOk && !htmlDetected;

  let failureClass = null;
  let reason = "asset delivered with executable MIME type";
  if (!passed) {
    if (htmlDetected) {
      failureClass = "pages-asset-fallback";
      reason = "asset request returned HTML";
    } else if (!mimeOk) {
      failureClass = "pages-asset-mime";
      reason = "asset response used the wrong MIME type";
    } else {
      failureClass = "pages-asset-delivery";
      reason = !bodyPresent
        ? "asset response body was empty"
        : !finalOriginOk
        ? "asset redirected away from the Pages origin"
        : `asset request returned HTTP ${raw.status_code ?? "transport failure"}`;
    }
  }
  return { passed, failureClass, reason, contentType: type, htmlDetected, bodyPresent };
}

export function validateMissingAssetResponse(raw, rootHtml, expectedOrigin) {
  const cacheControl = raw.headers?.["cache-control"] ||
    raw.headers?.["Cache-Control"] || "";
  const shellDetected = looksLikeLaunchShell(raw.body_text, rootHtml, raw.headers);
  const finalOriginOk = finalUrlStaysOnOrigin(raw.final_url, expectedOrigin);
  const immutable = /(?:^|,)\s*(?:public\s*,\s*)?[^,]*\bimmutable\b/iu.test(cacheControl);
  const noStore = /(?:^|,)\s*no-store\s*(?:,|$)/iu.test(cacheControl);
  const passed = raw.ok === true && raw.status_code === 404 && finalOriginOk &&
    !shellDetected && !immutable && noStore;
  let reason = "missing asset failed closed with HTTP 404 and no-store";
  if (!passed) {
    reason = shellDetected
      ? "missing asset returned the launch SPA shell"
      : immutable
      ? "missing asset response was marked immutable"
      : !noStore
      ? "missing asset response was not marked no-store"
      : !finalOriginOk
      ? "missing asset redirected away from the Pages origin"
      : `missing asset returned HTTP ${raw.status_code ?? "transport failure"}`;
  }
  return {
    passed,
    failureClass: passed ? null : "pages-asset-fallback",
    reason,
    shellDetected,
    immutable,
    noStore,
    cacheControl,
  };
}
