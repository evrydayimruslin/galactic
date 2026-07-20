import assert from "node:assert/strict";
import { ApiClient } from "../api.ts";
import {
  DEFAULT_JOB_GATEWAY_URL,
  DEFAULT_JOB_TOKEN_FILE,
  loadRuntimeConfig,
  resolveComputeJobEnvironment,
} from "../job-context.ts";

Deno.test("compute config gives the token file precedence and never reads persistent config", async () => {
  const reads: string[] = [];
  let persistentReads = 0;
  const config = await loadRuntimeConfig({
    env: {
      GALACTIC_LEASE_ID: "lease_123",
      GALACTIC_JOB_TOKEN_FILE: "/tmp/lease-token",
      GALACTIC_GATEWAY_URL: "https://gateway.internal/v1/",
      GALACTIC_TOKEN: "gx_human_token_must_be_ignored",
      GALACTIC_API_URL: "https://public.example",
    },
    readTokenFile: async (path) => {
      reads.push(path);
      return "job_opaque_token\n";
    },
    readPersistentConfig: async () => {
      persistentReads++;
      throw new Error("persistent config must not be read");
    },
  });

  assert.deepEqual(reads, ["/tmp/lease-token"]);
  assert.equal(persistentReads, 0);
  assert.equal(config.api_url, "https://gateway.internal/v1");
  assert.equal(config.auth?.token, "job_opaque_token");
  assert.equal(config.auth?.is_job_token, true);
  assert.equal(config.runtime?.lease_id, "lease_123");
});

Deno.test("lease marker enables safe defaults only in explicit compute mode", async () => {
  let tokenPath = "";
  const config = await loadRuntimeConfig({
    env: { GALACTIC_LEASE_ID: "lease_default" },
    readTokenFile: async (path) => {
      tokenPath = path;
      return "opaque";
    },
    readPersistentConfig: async () => {
      throw new Error("must not read persistent config");
    },
  });
  assert.equal(tokenPath, DEFAULT_JOB_TOKEN_FILE);
  assert.equal(config.api_url, DEFAULT_JOB_GATEWAY_URL);

  assert.equal(resolveComputeJobEnvironment({}), null);
});

Deno.test("partial or unreadable compute context fails closed without fallback", async () => {
  assert.throws(
    () =>
      resolveComputeJobEnvironment({
        GALACTIC_GATEWAY_URL: "https://gateway.internal/v1",
      }),
    /GALACTIC_LEASE_ID is required/,
  );

  let persistentReads = 0;
  await assert.rejects(
    loadRuntimeConfig({
      env: { GALACTIC_LEASE_ID: "lease_missing" },
      readTokenFile: async () => {
        throw new Deno.errors.NotFound();
      },
      readPersistentConfig: async () => {
        persistentReads++;
        return { api_url: "https://public.example" };
      },
    }),
    /Unable to read Galactic Compute job token file/,
  );
  assert.equal(persistentReads, 0);
});

Deno.test("human mode preserves persistent config behavior", async () => {
  let persistentReads = 0;
  const config = await loadRuntimeConfig({
    env: { GALACTIC_TOKEN: "gx_env_is_resolved_by_normal_path" },
    readPersistentConfig: async () => {
      persistentReads++;
      return {
        api_url: "https://api.connectgalactic.com",
        auth: { token: "gx_human", is_api_token: true },
      };
    },
  });
  assert.equal(persistentReads, 1);
  assert.equal(config.auth?.token, "gx_human");
});

Deno.test("compute API client uses only the private platform chokepoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<
    { url: string; authorization: string | null; body: unknown }
  > = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { ok: true } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = new ApiClient({
      api_url: "https://galactic.internal/v1",
      auth: { token: "job_secret", is_job_token: true },
      runtime: {
        kind: "compute-job",
        lease_id: "lease_1",
        token_file: "/run/galactic/job-token",
      },
    });
    const result = await client.callTool("gx.upload", { files: [] });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://galactic.internal/v1/mcp/platform");
    assert.equal(calls[0].authorization, "Bearer job_secret");
    assert.equal(
      (calls[0].body as { params: { name: string } }).params.name,
      "gx.upload",
    );

    await assert.rejects(
      client.callAppTool("app_1", "app_1_fn", {}),
      /Direct per-app MCP routes are unavailable/,
    );
    assert.equal(
      calls.length,
      1,
      "per-app denial must happen before any request",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("lease utility and artifact routes remain private, authenticated, and integrity-bound", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    sha256: string | null;
    idempotencyKey: string | null;
    contentLength: string | null;
  }> = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method || "GET",
      authorization: headers.get("authorization"),
      sha256: headers.get("x-galactic-sha256"),
      idempotencyKey: headers.get("x-galactic-idempotency-key"),
      contentLength: headers.get("content-length"),
    });
    if (String(input).endsWith("/artifacts/artifact_123")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    return new Response('{"artifact_id":"artifact_123"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const client = new ApiClient({
      api_url: "https://galactic.internal/v1/",
      auth: { token: "job_secret", is_job_token: true },
      runtime: {
        kind: "compute-job",
        lease_id: "lease_1",
        token_file: "/run/galactic/job-token",
      },
    });
    await client.getComputeBudget();
    await client.getCurrentReceipt();
    const uploaded = await client.putArtifact(
      "report final.pdf",
      new Uint8Array([1, 2, 3]),
      {
        size: 3,
        sha256: "a".repeat(64),
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      },
    );
    assert.equal(uploaded.artifact_id, "artifact_123");
    const downloaded = await client.getArtifact("artifact_123");
    assert.deepEqual(
      new Uint8Array(await downloaded.arrayBuffer()),
      new Uint8Array([1, 2, 3]),
    );
    assert.deepEqual(calls.map((call) => call.url), [
      "https://galactic.internal/v1/budget",
      "https://galactic.internal/v1/receipts/current",
      "https://galactic.internal/v1/artifacts?name=report+final.pdf",
      "https://galactic.internal/v1/artifacts/artifact_123",
    ]);
    assert.deepEqual(calls.map((call) => call.method), [
      "GET",
      "GET",
      "PUT",
      "GET",
    ]);
    assert(calls.every((call) => call.authorization === "Bearer job_secret"));
    assert.equal(calls[2].sha256, "a".repeat(64));
    assert.equal(
      calls[2].idempotencyKey,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(calls[2].contentLength, "3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
