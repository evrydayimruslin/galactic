import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  getPlatformTools,
  handleTrustedComputePlatformMcp,
} from "./platform-mcp.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const CAPACITY_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const COMPUTE_BEARER = "compute-job-secret-must-not-forward";

const user = {
  id: USER_ID,
  email: "compute@example.com",
  displayName: "Compute",
  avatarUrl: null,
  tier: "pro",
  provisional: false,
};

function computeRequest(
  method: string,
  params?: unknown,
): Request {
  return new Request("https://api.test/internal/compute/platform-mcp", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${COMPUTE_BEARER}`,
      "Content-Type": "application/json",
      "Mcp-Session-Id": "compute-session-1",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
}

Deno.test({
  name: "compute platform gateway denies an unlisted function before counters",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (() => {
      fetchCount++;
      throw new Error(
        "authorization denial must precede fetch-backed counters",
      );
    }) as typeof fetch;
    try {
      const response = await handleTrustedComputePlatformMcp(
        computeRequest("tools/call", {
          name: "gx.upload",
          arguments: { name: "not-authorized" },
        }),
        {
          userId: USER_ID,
          user,
          allowedPlatformFunctions: ["ul.call"],
        },
      );
      const body = await response.json() as {
        error?: { data?: { type?: string } };
      };
      assertEquals(
        body.error?.data?.type,
        "COMPUTE_PLATFORM_FUNCTION_FORBIDDEN",
      );
      assertEquals(fetchCount, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
});

Deno.test("compute platform gateway tools/list is exact, including demoted tools", async () => {
  const response = await handleTrustedComputePlatformMcp(
    computeRequest("tools/list"),
    {
      userId: USER_ID,
      user,
      allowedPlatformFunctions: [
        "ul.call",
        "ul.upload",
        "ul.download",
        "ul.emit",
      ],
    },
  );
  const body = await response.json() as {
    result?: { tools?: Array<{ name: string }> };
  };
  assertEquals(
    body.result?.tools?.map((tool) => tool.name).sort(),
    ["gx.call", "gx.download", "gx.emit", "gx.upload"],
  );
});

Deno.test({
  name:
    "compute gx.call uses the trusted host callback without forwarding its bearer",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousEnv = globalThis.__env;
    const previousFetch = globalThis.fetch;
    const observedAuthorization: Array<string | null> = [];
    const trustedCalls: Array<Record<string, unknown>> = [];

    globalThis.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      BASE_URL: "https://api.test",
    } as typeof globalThis.__env;
    globalThis.fetch = ((
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url || String(input));
      const headers = new Headers(request?.headers || init?.headers);
      observedAuthorization.push(headers.get("Authorization"));

      if (url.pathname.endsWith("/rest/v1/rpc/increment_weekly_calls")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ current_count: 1 }]), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.pathname.endsWith("/rest/v1/apps")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ id: AGENT_ID }]), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (url.pathname.endsWith("/rest/v1/mcp_call_logs")) {
        return Promise.resolve(
          new Response(JSON.stringify([]), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const response = await handleTrustedComputePlatformMcp(
        computeRequest("tools/call", {
          name: "gx.call",
          arguments: {
            app_id: AGENT_ID,
            function_name: "summarize",
            args: { text: "hello" },
          },
        }),
        {
          userId: USER_ID,
          user,
          allowedPlatformFunctions: ["ul.call"],
          executeAgentFunction: (call) => {
            trustedCalls.push(call as unknown as Record<string, unknown>);
            return Promise.resolve({
              _async: true,
              job_id: "job-1",
              status: "queued",
            });
          },
        },
      );
      const body = await response.json() as {
        result?: unknown;
        error?: unknown;
      };
      assertEquals(body.error, undefined);
      assertEquals(trustedCalls[0]?.agentId, AGENT_ID);
      assertEquals(trustedCalls[0]?.functionName, "summarize");
      assert(
        observedAuthorization.every(
          (value) => value !== `Bearer ${COMPUTE_BEARER}`,
        ),
        "Compute bearer reached a downstream fetch",
      );
    } finally {
      globalThis.__env = previousEnv;
      globalThis.fetch = previousFetch;
    }
  },
});

Deno.test({
  name: "compute gx.emit preserves source provenance and root capacity lineage",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const previousEnv = globalThis.__env;
    const previousFetch = globalThis.fetch;
    let eventInsert: Record<string, unknown> | null = null;
    const logInserts: Record<string, unknown>[] = [];

    globalThis.__env = {
      ...(previousEnv || {}),
      SUPABASE_URL: "https://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    } as typeof globalThis.__env;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url || String(input));
      const method = request?.method || init?.method || "GET";
      const body = request?.body
        ? await request.clone().json()
        : init?.body
        ? JSON.parse(String(init.body))
        : null;

      if (url.pathname.endsWith("/rest/v1/rpc/increment_weekly_calls")) {
        return new Response(JSON.stringify([{ current_count: 1 }]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/rest/v1/apps") && method === "GET") {
        const id = url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
        return new Response(JSON.stringify([{
          id,
          owner_id: USER_ID,
          visibility: "private",
          deleted_at: null,
        }]), { headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname.endsWith("/rest/v1/agent_events") && method === "POST") {
        eventInsert = (body as Record<string, unknown>[])[0];
        return new Response(JSON.stringify([{ id: "event-1" }]), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname.endsWith("/rest/v1/mcp_call_logs") && method === "POST") {
        logInserts.push(body as Record<string, unknown>);
        return new Response("[]", {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    try {
      const response = await handleTrustedComputePlatformMcp(
        computeRequest("tools/call", {
          name: "gx.emit",
          arguments: {
            app_id: AGENT_ID,
            topic: "build.finished",
            payload: { ok: true },
          },
        }),
        {
          userId: USER_ID,
          user,
          allowedPlatformFunctions: ["ul.emit"],
          computeAttribution: {
            runId: RUN_ID,
            sourceAgentId: AGENT_ID,
            capacityAgentId: CAPACITY_AGENT_ID,
            callerFunction: "develop",
          },
        },
      );
      const body = await response.json() as { error?: unknown };
      assertEquals(body.error, undefined);
      assertEquals(eventInsert?.emitter_app_id, AGENT_ID);
      assertEquals(eventInsert?.capacity_agent_id, CAPACITY_AGENT_ID);
      // MCP telemetry keeps the source Agent as provenance; the distinct root
      // Agent is only the conserved capacity lineage for downstream delivery.
      await Promise.resolve();
      assert(logInserts.some((entry) => entry.caller_app_id === AGENT_ID));
    } finally {
      globalThis.__env = previousEnv;
      globalThis.fetch = previousFetch;
    }
  },
});

Deno.test("public platform tool projection keeps its existing scope behavior", () => {
  const names = getPlatformTools({
    auth: { authSource: "api_token", scopes: ["apps:call"] },
  }).map((tool) => tool.name);
  assert(names.includes("gx.call"));
  assert(names.includes("gx.discover"));
  assert(!names.includes("gx.upload"));
  assert(!names.includes("gx.secrets"));
});
