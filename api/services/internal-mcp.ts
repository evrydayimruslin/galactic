// Internal worker-to-worker MCP calls.
//
// Same-worker fetch() to our own public hostname goes through the CDN, which
// blocks it (error 1042) — internal hops must use the SELF service binding
// with a synthetic https://internal/ URL (routing is by pathname). This
// helper is the single chokepoint for that pattern so every caller gets the
// same two guards:
//
//  - target validation: "platform" is rejected (it would re-enter the
//    platform handler — a self-recursion that mints no caller context and so
//    escapes the cross-Agent hop ceiling entirely), as is anything that could
//    not be an app id or slug;
//  - path-segment encoding (matches the sandbox SDK convention in
//    dynamic-sandbox.ts; an un-encoded id could reroute the request).

import { getSelfFetcher } from "../lib/env.ts";

interface InternalMcpCall {
  url: string;
  fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export function resolveInternalMcpCall(
  targetAppId: string,
  fallback: { baseUrl: string; fetchFn?: typeof fetch },
): InternalMcpCall {
  const id = String(targetAppId || "").trim();
  if (!id || id === "platform" || /[/\\?#]/.test(id)) {
    throw new Error(`Invalid target app id for MCP call: "${id}"`);
  }
  const segment = encodeURIComponent(id);
  const selfFetch = getSelfFetcher();
  if (selfFetch) {
    return { url: `https://internal/mcp/${segment}`, fetchFn: selfFetch };
  }
  // No SELF binding (tests, unbound envs): fall back to the provided base URL.
  return {
    url: `${fallback.baseUrl.replace(/\/+$/, "")}/mcp/${segment}`,
    fetchFn: fallback.fetchFn ?? fetch,
  };
}
