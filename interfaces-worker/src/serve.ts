// Ultralight Interfaces sandbox worker — request handling (Interfaces PR3).
//
// SECURITY MODEL (docs/INTERFACE_RELAUNCH_INVESTIGATION.md §4.2):
// - Serves ONLY the content-addressed prefix interfaces/{appId}/{sha256}.html.
//   The bundle path (apps/{appId}/{version}/) holds app source code and must
//   never be reachable from here (invariant I1) — the path parser rejects
//   anything that is not exactly /i/{uuid}/{64-hex} before any storage read.
// - Every HTML response carries the CSP `sandbox` directive, so the document
//   stays inert even when navigated to directly (not just when iframed).
// - connect-src falls back to default-src 'none': interface JS has NO network
//   access; its only I/O is the postMessage bridge on the host page.
// - No cookie is ever set on this origin (invariant I5) — there is nothing
//   here worth stealing.
// - frame-ancestors restricts embedding to the launch website (env var;
//   unset fails closed to 'none').
//
// This module is dependency-free and structurally typed so the full handler
// is unit-testable under Deno with a fake bucket.

const APP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const INTERFACE_KEY_PREFIX = "interfaces/";

export interface R2BucketLike {
  get(key: string): Promise<{ body: ReadableStream | null } | null>;
  // Metadata-only lookup (cheaper than get) — used for HEAD requests.
  head(key: string): Promise<object | null>;
}

export interface InterfaceWorkerEnv {
  R2_BUCKET: R2BucketLike;
  FRAME_ANCESTORS?: string;
  ENVIRONMENT?: string;
}

// Strict allowlist: /i/{appId}/{hash} where appId is a lowercase UUID and
// hash is lowercase sha256 hex. URL.pathname preserves percent-encoding, so
// encoded traversal tricks fail the regexes rather than being decoded.
export function parseInterfacePath(pathname: string): { key: string } | null {
  const segments = pathname.split("/");
  if (segments.length !== 4 || segments[0] !== "" || segments[1] !== "i") {
    return null;
  }
  const appId = segments[2];
  const hash = segments[3];
  if (!APP_ID_RE.test(appId) || !HASH_RE.test(hash)) return null;
  return { key: `${INTERFACE_KEY_PREFIX}${appId}/${hash}.html` };
}

export function buildContentSecurityPolicy(frameAncestors: string): string {
  const ancestors = frameAncestors.trim() || "'none'";
  return [
    "sandbox allow-scripts allow-forms",
    "default-src 'none'",
    "base-uri 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline' https:",
    // https: image/font sources permit GET-beacon exfiltration by a
    // malicious interface — accepted: the only data in the frame is the
    // developer's own function results plus public agent metadata (see
    // LAUNCH_RELEASE_PACKET accepted risks), and remote images/fonts are a
    // legitimate need under the 1 MiB single-file cap.
    "img-src data: blob: https:",
    "font-src data: https:",
    "form-action 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

function sharedSecurityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
  };
}

export function buildContentHeaders(frameAncestors: string): Headers {
  return new Headers({
    ...sharedSecurityHeaders(),
    "Content-Security-Policy": buildContentSecurityPolicy(frameAncestors),
    "Content-Type": "text/html; charset=utf-8",
    // Content-addressed URLs never change meaning — cache forever.
    "Cache-Control": "public, max-age=31536000, immutable",
    // Allows embedding from the (cross-origin) launch site even if it ever
    // enables COEP; frame-ancestors above is what actually restricts WHO.
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: new Headers({
      ...sharedSecurityHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    }),
  });
}

export async function handleInterfaceRequest(
  request: Request,
  env: InterfaceWorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = errorResponse(405, "Method not allowed");
    response.headers.set("Allow", "GET, HEAD");
    return response;
  }

  if (url.pathname === "/") {
    return new Response(null, {
      status: 204,
      headers: new Headers(sharedSecurityHeaders()),
    });
  }

  const target = parseInterfacePath(url.pathname);
  if (!target) return errorResponse(404, "Not found");

  if (request.method === "HEAD") {
    // Metadata-only: never pull the body for HEAD.
    const exists = await env.R2_BUCKET.head(target.key);
    if (!exists) return errorResponse(404, "Not found");
    return new Response(null, {
      status: 200,
      headers: buildContentHeaders(env.FRAME_ANCESTORS ?? ""),
    });
  }

  const object = await env.R2_BUCKET.get(target.key);
  if (!object) return errorResponse(404, "Not found");

  // Zero-price render metering (PR6): one structured line per serve, visible
  // via `wrangler tail` and Workers analytics. Deliberately NOT wired to
  // billing — the dormant widget_pulls basin is the upgrade path if renders
  // ever become chargeable.
  console.log(
    `[INTERFACE-SERVE] GET ${url.pathname} env=${env.ENVIRONMENT ?? "unknown"}`,
  );

  return new Response(object.body, {
    status: 200,
    headers: buildContentHeaders(env.FRAME_ANCESTORS ?? ""),
  });
}
