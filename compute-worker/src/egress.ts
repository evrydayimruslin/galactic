/**
 * Hostname patterns understood by the simple `*` glob matcher in the pinned
 * @cloudflare/containers release. V1 combines this deny list with
 * `enableInternet = false` and a registered catch-all HTTP(S) outbound Worker.
 * Consequently non-HTTP transport is denied by the runtime,
 * DNS is restricted to Cloudflare resolvers, and every redirect hop returns to
 * this matcher before it can leave the body.
 */
const range = (
  prefix: string,
  first: number,
  last: number,
): string[] =>
  Array.from(
    { length: last - first + 1 },
    (_, offset) => `${prefix}${first + offset}.*`,
  );

export const HTTP_INTERCEPT_DENIED_HOST_PATTERNS = Object.freeze([
  // IPv4 special, private, loopback, link-local, and benchmark space.
  "0.*",
  "10.*",
  ...range("100.", 64, 127),
  "127.*",
  "169.254.*",
  ...range("172.", 16, 31),
  "192.0.0.*",
  "192.168.*",
  "198.18.*",
  "198.19.*",
  ...range("", 224, 255),

  // URL.hostname retains brackets for IPv6 literals. URL parsing normalizes
  // hex case before the Containers matcher sees the hostname.
  "[::]",
  "[::1]",
  "[::ffff:*",
  "[fc*",
  "[fd*",
  "[fe8*",
  "[fe9*",
  "[fea*",
  "[feb*",
  "[ff*",

  // Well-known metadata and host bridge names/addresses.
  "169.254.169.254",
  "metadata",
  "metadata.google.internal",
  "100.100.100.200",
  "host.docker.internal",

  // The disposable body must use the private gx service-binding route, never
  // a public Galactic API hostname carrying independently supplied auth.
  "*.connectgalactic.com",
  "api.connectgalactic.com",
  "connectgalactic.com",
  "interfaces.connectgalactic.com",
  "*.ultralightagent.com",
  "api.ultralightagent.com",
  "ultralightagent.com",
  "interfaces.ultralightagent.com",
  "*.ultralight.dev",
  "api.ultralight.dev",
  "ultralight-api-iikqz.ondigitalocean.app",
  "ultralight-api.rgn4jz429m.workers.dev",
  "staging-api.ultralight.dev",
  "ultralight-api-staging.rgn4jz429m.workers.dev",
  "ultralight-interfaces-staging.rgn4jz429m.workers.dev",
  "staging.ultralight-launch-web.pages.dev",
]);

/**
 * Forward public HTTP(S) through the trusted Worker runtime. Redirects stay
 * manual so a public origin cannot bounce one request around the Sandbox host
 * gate to a private or Galactic control-plane hostname. Normal clients follow
 * the returned Location with a fresh, independently checked request.
 */
export async function forwardComputePublicHttp(
  request: Request,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    request.method.toUpperCase() === "CONNECT"
  ) {
    return new Response("Compute egress transport denied", {
      status: 405,
      headers: { "cache-control": "no-store" },
    });
  }
  return await fetchFn(new Request(request, { redirect: "manual" }));
}
