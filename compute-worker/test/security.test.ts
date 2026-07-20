import { describe, expect, it } from "vitest";
import {
  artifactObjectKey,
  assertSecretEnvName,
  BoundedText,
  proxyComputeGateway,
  secretPath,
  shellCommand,
  workspacePath,
} from "../src/security";

describe("compute security helpers", () => {
  it("confines workspace and secret paths", () => {
    expect(workspacePath("reports/output.pdf")).toBe("/workspace/reports/output.pdf");
    expect(secretPath("providers/anthropic.json")).toBe(
      "/run/galactic/secrets/providers/anthropic.json",
    );
    for (const path of [
      "../secret",
      "/etc/passwd",
      "nested/../../secret",
      "a//b",
      "a\\b",
      "line\nbreak",
    ]) {
      expect(() => workspacePath(path)).toThrow();
    }
  });

  it("quotes argv without giving the shell a second command", () => {
    expect(shellCommand(["printf", "%s", "hello'; touch /tmp/pwned; '"])).toBe(
      `'printf' '%s' 'hello'"'"'; touch /tmp/pwned; '"'"''`,
    );
  });

  it("refuses reserved platform credential environment names", () => {
    expect(assertSecretEnvName("ANTHROPIC_API_KEY")).toBe("ANTHROPIC_API_KEY");
    expect(() => assertSecretEnvName("GALACTIC_AGENT_TOKEN")).toThrow("reserved");
    expect(() => assertSecretEnvName("GALACTIC_INTERNAL_AUTH")).toThrow("reserved");
    expect(() => assertSecretEnvName("PATH")).toThrow("reserved");
    expect(() => assertSecretEnvName("NODE_OPTIONS")).toThrow("reserved");
    expect(() => assertSecretEnvName("GALACTIC_GATEWAY_URL")).toThrow("reserved");
  });

  it("uses tenant-confined deterministic artifact prefixes", () => {
    expect(artifactObjectKey({
      accountId: "00000000-0000-4000-8000-000000000001",
      agentId: "app-demo_1",
      runId: "00000000-0000-4000-8000-000000000002",
      artifactId: "00000000-0000-4000-8000-000000000003",
      index: 2,
      name: "reports/My Final.pdf",
    })).toBe(
      "compute-v1/00000000-0000-4000-8000-000000000001/app-demo_1/00000000-0000-4000-8000-000000000002/outputs/2-00000000-0000-4000-8000-000000000003-my-final.pdf",
    );
  });

  it("bounds text by encoded bytes and records the original byte count", () => {
    const output = new BoundedText(5);
    output.append("abc");
    output.append("def");
    expect(output.value).toBe("abcde");
    expect(output.bytesSeen).toBe(6);
    expect(output.truncated).toBe(true);

    const unicode = new BoundedText(4);
    unicode.append("😀x");
    expect(unicode.value).toBe("😀");
    expect(new TextEncoder().encode(unicode.value).byteLength).toBe(4);
    expect(unicode.bytesSeen).toBe(5);
    expect(unicode.truncated).toBe(true);
  });
});

describe("private compute gateway", () => {
  it("replaces every spoofable Galactic identity with Sandbox context", async () => {
    let forwarded: Request | undefined;
    const response = await proxyComputeGateway(
      new Request("https://galactic.internal/v1/mcp/platform", {
        method: "POST",
        headers: {
          authorization: "Bearer opaque-job-token",
          cookie: "human=session",
          "cf-access-jwt-assertion": "spoofed-cf-identity",
          "cf-connecting-ip": "203.0.113.2",
          origin: "https://spoofed.example",
          "proxy-authorization": "Basic spoofed",
          "x-forwarded-for": "203.0.113.1",
          "x-galactic-user-id": "spoofed-user",
          "x-galactic-container-id": "spoofed-container",
          "x-galactic-idempotency-key": "4f8879f0-18f5-4e5c-a821-5e2818b23460",
          "x-galactic-sha256": "a".repeat(64),
          "x-original-url": "/admin",
          "x-safe-client-header": "not-allowlisted",
        },
        body: "{}",
      }),
      {
        async fetch(input) {
          forwarded = input instanceof Request ? input : new Request(input);
          return new Response("ok");
        },
      },
      { containerId: "run-trusted", className: "ComputeStandard" },
    );
    expect(response.status).toBe(200);
    expect(forwarded?.headers.get("authorization")).toBe("Bearer opaque-job-token");
    expect(forwarded?.headers.get("cookie")).toBeNull();
    expect(forwarded?.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(forwarded?.headers.get("cf-connecting-ip")).toBeNull();
    expect(forwarded?.headers.get("origin")).toBeNull();
    expect(forwarded?.headers.get("proxy-authorization")).toBeNull();
    expect(forwarded?.headers.get("x-forwarded-for")).toBeNull();
    expect(forwarded?.headers.get("x-galactic-user-id")).toBeNull();
    expect(forwarded?.headers.get("x-original-url")).toBeNull();
    expect(forwarded?.headers.get("x-safe-client-header")).toBeNull();
    expect(forwarded?.headers.get("x-galactic-idempotency-key")).toBe(
      "4f8879f0-18f5-4e5c-a821-5e2818b23460",
    );
    expect(forwarded?.headers.get("x-galactic-sha256")).toBe("a".repeat(64));
    expect(forwarded?.headers.get("x-galactic-container-id")).toBe("run-trusted");
    expect(forwarded?.headers.get("x-galactic-container-class")).toBe("ComputeStandard");
  });

  it("rejects non-private routes and missing bearers before the binding", async () => {
    let calls = 0;
    const binding = {
      async fetch() {
        calls += 1;
        return new Response("unexpected");
      },
    };
    expect((await proxyComputeGateway(
      new Request("https://example.com/v1/budget"),
      binding,
      { containerId: "run-a", className: "ComputeStandard" },
    )).status).toBe(404);
    expect((await proxyComputeGateway(
      new Request("https://galactic.internal/v1/budget"),
      binding,
      { containerId: "run-a", className: "ComputeStandard" },
    )).status).toBe(401);
    expect((await proxyComputeGateway(
      new Request("https://galactic.internal/v1/budget", {
        headers: { authorization: "Bearer valid-token" },
      }),
      binding,
      { containerId: "bad identity with spaces", className: "ComputeStandard" },
    )).status).toBe(503);
    expect(calls).toBe(0);
  });
});
