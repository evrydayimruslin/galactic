// Egress destination policy for the Dynamic Worker sandbox SSRF guard.
//
// Pure logic only (no cloudflare:workers import) so it is unit-testable under
// plain Deno. OutboundBinding (outbound-binding.ts) wires guardedFetch() as the
// loaded isolate's globalOutbound.
//
// Scope: block non-http(s) schemes and private/loopback/link-local/metadata
// destinations — including the integer/hex/octal IPv4 encodings used to dodge
// string matching, trailing-dot FQDNs, and the IPv6 transition forms that embed
// a private IPv4 (mapped ::ffff:, NAT64 64:ff9b::, 6to4 2002:, IPv4-compatible
// ::a.b.c.d, SIIT ::ffff:0:). Redirects are followed manually so EVERY hop is
// re-checked (an allowed host that 302s to 169.254.169.254 is blocked at the
// next hop). Residual: DNS-rebinding (a public name resolving to a private IP)
// — not expressible from URL inspection, and not edge-routable from a Worker. A
// per-app destination allowlist is the planned follow-up that closes it fully.

export interface OutboundVerdict {
  allowed: boolean;
  reason?: string;
}

// Parse the IPv4 octets from the literal encodings attackers use to dodge string
// matching: dotted-quad (decimal/hex/octal parts), a single decimal integer, or
// a single 0x-hex integer. Returns null if not an IPv4 literal.
function parseIpv4Literal(host: string): number[] | null {
  if (host.includes(".")) {
    const parts = host.split(".");
    if (parts.length !== 4) return null;
    const octets: number[] = [];
    for (const part of parts) {
      let value: number;
      if (/^0x[0-9a-f]+$/.test(part)) value = parseInt(part, 16);
      else if (/^0[0-7]+$/.test(part)) value = parseInt(part, 8);
      else if (/^[0-9]+$/.test(part)) value = parseInt(part, 10);
      else return null;
      if (!Number.isInteger(value) || value < 0 || value > 255) return null;
      octets.push(value);
    }
    return octets;
  }
  let asInt: number | null = null;
  if (/^0x[0-9a-f]+$/.test(host)) asInt = parseInt(host, 16);
  else if (/^[0-9]+$/.test(host)) asInt = parseInt(host, 10);
  if (asInt === null || !Number.isFinite(asInt) || asInt < 0 || asInt > 0xffffffff) {
    return null;
  }
  return [
    (asInt >>> 24) & 0xff,
    (asInt >>> 16) & 0xff,
    (asInt >>> 8) & 0xff,
    asInt & 0xff,
  ];
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local + metadata
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
  return false;
}

// Extract an embedded IPv4 from the IPv6 transition forms that can carry a
// private target. WHATWG URL normalizes dotted IPv4-in-IPv6 to hex, so we read
// the last two hextets for known embedding prefixes; we also catch a literal
// dotted tail just in case.
function embeddedIpv4FromIpv6(host: string): number[] | null {
  const dotted = host.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = parseIpv4Literal(dotted[1]);
    if (octets) return octets;
  }
  const isEmbedding = host.startsWith("::ffff:") || // IPv4-mapped + SIIT ::ffff:0:
    host.startsWith("64:ff9b:") || // NAT64 well-known prefix
    host.startsWith("2002:") || // 6to4
    /^::[0-9a-f]/.test(host); // deprecated IPv4-compatible ::a.b.c.d
  if (!isEmbedding) return null;
  const hextets = host.split(":").filter((h) => h.length > 0);
  if (hextets.length < 2) return null;
  const last = hextets[hextets.length - 1];
  const prev = hextets[hextets.length - 2];
  if (!/^[0-9a-f]{1,4}$/.test(last) || !/^[0-9a-f]{1,4}$/.test(prev)) return null;
  const low = parseInt(last, 16);
  const high = parseInt(prev, 16);
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

// Exported so the IMAP/SMTP socket path (network-binding.ts) can enforce the
// same destination policy as raw fetch — one source of truth.
export function isBlockedHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();
  if (!host) return true;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1); // IPv6
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone); // strip IPv6 zone id
  if (host.length > 1 && host.endsWith(".")) host = host.slice(0, -1); // rooted FQDN

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "internal" || host.endsWith(".internal")) return true;

  if (host.includes(":")) {
    // IPv6
    if (host === "::1" || host === "::") return true; // loopback / unspecified
    // fc00::/7 ULA, fe80::/10 link-local, fec0::/10 site-local, ff00::/8
    // multicast — none are global unicast (which is 2000::/3), so block fc/fd/fe/ff.
    if (/^f[cdef]/.test(host)) return true;
    const embedded = embeddedIpv4FromIpv6(host);
    if (embedded && isBlockedIpv4(embedded)) return true;
    return false; // other global IPv6
  }

  const octets = parseIpv4Literal(host);
  if (octets) return isBlockedIpv4(octets);

  // Regular DNS hostname: allowed. (DNS-rebinding to a private IP is a
  // documented residual — not catchable from the URL, and not edge-routable.)
  return false;
}

// Match a request host (+ optional port) against the app's declared destination
// allowlist. Entries are canonical hosts from the manifest: "host", "*.domain",
// or "host:port". A port-less entry matches any port; a port-bearing entry
// requires an exact port match. Exported so the IMAP/SMTP socket path
// (network-binding.ts) shares one matcher with raw fetch.
export function hostInAllowlist(
  host: string,
  port: string,
  allowlist: readonly string[],
): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // IPv6 literal
  if (h.length > 1 && h.endsWith(".")) h = h.slice(0, -1); // rooted FQDN
  const p = String(port ?? "");

  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    let pattern = entry;
    let patternPort = "";
    const colon = entry.indexOf(":");
    if (colon !== -1) {
      pattern = entry.slice(0, colon);
      patternPort = entry.slice(colon + 1);
    }
    if (patternPort && patternPort !== p) continue;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    } else if (h === pattern) {
      return true;
    }
  }
  return false;
}

// Pure policy — exported for exhaustive unit testing independent of the runtime.
//
// allowlist semantics (default-deny): when `allowlist` is an array (the sandbox
// path — even []), the destination host MUST be declared or it is blocked; [] =
// nothing reachable. `undefined`/`null` = no allowlist enforcement (legacy /
// internal callers), SSRF checks only.
export function evaluateOutbound(
  rawUrl: string,
  allowlist?: readonly string[] | null,
): OutboundVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: "invalid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { allowed: false, reason: `scheme not allowed: ${url.protocol}` };
  }
  if (isBlockedHost(url.hostname)) {
    return { allowed: false, reason: `destination not allowed: ${url.hostname}` };
  }
  if (allowlist && !hostInAllowlist(url.hostname, url.port, allowlist)) {
    return {
      allowed: false,
      reason: `destination not in allowlist: ${url.hostname}`,
    };
  }
  return { allowed: true };
}

function egressBlocked(reason?: string): Response {
  return new Response(
    JSON.stringify({ error: "egress_blocked", reason: reason ?? "blocked" }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}

function safeOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "";
  }
}

export interface GuardedFetchOptions {
  maxRedirects?: number;
  // Default-deny destination allowlist, re-checked on every redirect hop. See
  // evaluateOutbound for the null-vs-[] semantics.
  allowlist?: readonly string[] | null;
  onBlock?: (reason: string, host: string) => void;
}

// Apply the egress policy to a request and forward it, FOLLOWING redirects
// manually so every hop is re-checked. Returns a 403 the moment any hop targets
// a blocked destination. Honors the caller's redirect:"manual" (single hop, no
// following). fetchImpl is injectable for tests; in production it is the parent
// isolate's global fetch (which is not subject to globalOutbound — no loop).
export async function guardedFetch(
  request: Request,
  fetchImpl: (req: Request) => Promise<Response> = fetch,
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 8;
  const followRedirects = request.redirect !== "manual";

  const startMethod = request.method.toUpperCase();
  const hasBody = startMethod !== "GET" && startMethod !== "HEAD";
  let body: ArrayBuffer | null = null;
  if (hasBody) {
    try {
      body = await request.arrayBuffer();
    } catch {
      body = null;
    }
  }

  let url = request.url;
  let method = startMethod;
  const headers = new Headers(request.headers);
  const startOrigin = safeOrigin(url);

  for (let hop = 0;; hop++) {
    const verdict = evaluateOutbound(url, options.allowlist);
    if (!verdict.allowed) {
      let host = "";
      try {
        host = new URL(url).host;
      } catch { /* unparseable */ }
      options.onBlock?.(verdict.reason ?? "blocked", host);
      return egressBlocked(verdict.reason);
    }

    const hopRequest = new Request(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? null : body,
      redirect: "manual",
    });
    const response = await fetchImpl(hopRequest);

    if (
      !followRedirects || response.status < 300 || response.status > 399 ||
      hop >= maxRedirects
    ) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) return response;
    let nextUrl: string;
    try {
      nextUrl = new URL(location, url).toString();
    } catch {
      return response;
    }

    // Method/body transition: 301/302/303 downgrade a body-bearing method to GET
    // (browser behavior); 307/308 preserve method + body.
    if (response.status === 301 || response.status === 302 || response.status === 303) {
      if (method !== "GET" && method !== "HEAD") {
        method = "GET";
        body = null;
        headers.delete("content-length");
        headers.delete("content-type");
      }
    }
    // Don't leak credentials to a different origin across a redirect.
    if (safeOrigin(nextUrl) !== startOrigin) {
      headers.delete("authorization");
      headers.delete("cookie");
    }
    url = nextUrl;
  }
}
