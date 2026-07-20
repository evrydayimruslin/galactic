import { describe, expect, it } from "vitest";
import {
  forwardComputePublicHttp,
  HTTP_INTERCEPT_DENIED_HOST_PATTERNS,
} from "../src/egress";

// Mirrors the documented simple `*` matcher in the exactly pinned
// @cloudflare/containers dependency. The image-contract test also prevents a
// silent return to unsupported CIDR strings.
function simpleGlobMatch(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!value.startsWith(first)) return false;
  if (!value.endsWith(last)) return false;
  let position = first.length;
  for (let index = 1; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const next = value.indexOf(part, position);
    if (next === -1) return false;
    position = next + part.length;
  }
  return position <= value.length - last.length;
}

function denied(rawUrl: string): boolean {
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  return HTTP_INTERCEPT_DENIED_HOST_PATTERNS.some((pattern) =>
    simpleGlobMatch(pattern, hostname)
  );
}

describe("HTTP interception denied-host contract", () => {
  it.each([
    "http://0.1.2.3/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://100.127.255.254/",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.16.0.1/",
    "http://172.31.255.254/",
    "http://192.0.0.1/",
    "http://192.168.1.1/",
    "http://198.18.0.1/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fd12::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "https://metadata.google.internal/",
    "https://api.connectgalactic.com/",
    "https://future-service.connectgalactic.com/",
    "https://future-service.ultralightagent.com/",
    "https://future-service.ultralight.dev/",
    "https://ultralight-api.rgn4jz429m.workers.dev/",
    "https://ultralight-api-iikqz.ondigitalocean.app/",
  ])("denies literal/special HTTP destination %s", (url) => {
    expect(denied(url)).toBe(true);
  });

  it.each([
    "https://example.com/",
    "https://github.com/",
    "http://8.8.8.8/",
    "http://100.63.255.255/",
    "http://100.128.0.1/",
    "http://172.15.255.255/",
    "http://172.32.0.1/",
    "http://192.169.0.1/",
    "http://223.255.255.255/",
    "http://[2001:4860:4860::8888]/",
  ])("does not deny ordinary public HTTP destination %s", (url) => {
    expect(denied(url)).toBe(false);
  });
});

describe("public Compute HTTP egress", () => {
  it("leaves denied hosts authoritative", () => {
    expect(denied("https://api.connectgalactic.com/")).toBe(true);
  });

  it("forwards HTTP(S) with redirects manual for per-hop host checks", async () => {
    const seen: Request[] = [];
    const response = await forwardComputePublicHttp(
      new Request("https://public.example/start", {
        headers: { authorization: "Bearer developer-supplied" },
      }),
      (request) => {
        seen.push(request instanceof Request ? request : new Request(request));
        return Promise.resolve(new Response(null, {
          status: 302,
          headers: { location: "https://api.connectgalactic.com/mcp/platform" },
        }));
      },
    );
    expect(response.status).toBe(302);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.redirect).toBe("manual");
    expect(seen[0]!.headers.get("authorization")).toBe(
      "Bearer developer-supplied",
    );
  });

  it("denies CONNECT before public fetch", async () => {
    let fetched = false;
    const request = new Request("https://public.example:443/", {
      method: "POST",
    });
    Object.defineProperty(request, "method", { value: "CONNECT" });
    const response = await forwardComputePublicHttp(request, () => {
      fetched = true;
      return Promise.resolve(new Response("unexpected"));
    });
    expect(response.status).toBe(405);
    expect(fetched).toBe(false);
  });
});
