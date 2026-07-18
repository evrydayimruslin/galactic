const MODULE_MIME_PATTERN = /^(?:application|text)\/(?:javascript|x-javascript|ecmascript)(?:\s*;|$)/iu;
const STYLESHEET_MIME_PATTERN = /^text\/css(?:\s*;|$)/iu;

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
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of tag.matchAll(attributePattern)) {
    const name = match[1].toLowerCase();
    if (name.startsWith("<")) continue;
    attributes[name] = decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function relTokens(value) {
  return new Set(String(value || "").toLowerCase().split(/\s+/u).filter(Boolean));
}

/**
 * Discover every executable module/preload and stylesheet referenced by the
 * built root document. Vite currently emits one of each, but collecting all of
 * them keeps this guard valid if chunk preloads are introduced later.
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
  const tags = String(html || "").match(/<(?:script|link)\b[^>]*>/giu) || [];
  for (const tag of tags) {
    const tagName = /^<\s*(script|link)\b/iu.exec(tag)?.[1]?.toLowerCase();
    const attributes = tagAttributes(tag);
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
    url.hash = "";
    if (url.origin !== document.origin) {
      errors.push(`cross-origin ${kind} asset reference: ${url.href}`);
      continue;
    }
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
