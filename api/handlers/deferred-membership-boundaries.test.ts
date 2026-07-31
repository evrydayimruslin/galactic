import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { executeEventDelivery, executeQueuedJob } from "./mcp.ts";
import type { AsyncJob } from "../services/async-jobs.ts";

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface FetchCall {
  method: string;
  pathname: string;
  body?: unknown;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function setupHarness(activeMembership: boolean) {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env;
  const fetchCalls: FetchCall[] = [];

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  } as unknown as typeof globalThis.__env;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url || String(input));
    const method = init?.method || request?.method || "GET";
    const bodyText = init?.body && typeof init.body === "string"
      ? init.body
      : request
      ? await request.clone().text()
      : "";
    fetchCalls.push({
      method,
      pathname: url.pathname,
      ...(bodyText ? { body: JSON.parse(bodyText) } : {}),
    });

    if (url.pathname === "/rest/v1/account_entitlements") {
      return jsonResponse(
        activeMembership
          ? [{ plan_code: "pro", subscription_status: "active" }]
          : [],
      );
    }
    if (url.pathname === "/rest/v1/apps" && method === "GET") {
      return jsonResponse([]);
    }
    if (url.pathname === "/rest/v1/async_jobs" && method === "PATCH") {
      return jsonResponse([{}]);
    }
    throw new Error(`Unexpected fetch: ${method} ${url.pathname}${url.search}`);
  };

  return {
    fetchCalls,
    cleanup() {
      globalThis.fetch = originalFetch;
      globalThis.__env = originalEnv;
    },
  };
}

function eventInput() {
  return {
    subscriberAppId: APP_ID,
    targetFunction: "handle",
    payload: { subject: "test" },
    userId: OWNER_ID,
    emitterAppId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    capacityAgentId: APP_ID,
    grantId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    hop: 0,
  };
}

function asyncJob(): AsyncJob {
  return {
    id: JOB_ID,
    app_id: APP_ID,
    user_id: OWNER_ID,
    owner_id: OWNER_ID,
    function_name: "handle",
    status: "running",
    args: {},
    caller_app_id: null,
    caller_grant_id: null,
    hop: null,
    result: null,
    result_r2_key: null,
    error: null,
    logs: [],
    duration_ms: null,
    ai_cost_light: 0,
    execution_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    server_instance: "test",
    started_at: "2026-07-30T00:00:00.000Z",
    completed_at: null,
    expires_at: "2026-07-31T00:00:00.000Z",
    meta: {},
    created_at: "2026-07-30T00:00:00.000Z",
  };
}

Deno.test("event claim with active membership continues to Agent lookup", async () => {
  const harness = setupHarness(true);
  try {
    assertEquals(await executeEventDelivery(eventInput()), {
      success: false,
      receiptId: null,
      error: "Subscriber Agent not found",
    });
    assertEquals(
      harness.fetchCalls.map((call) => call.pathname),
      [
        "/rest/v1/account_entitlements",
        "/rest/v1/apps",
      ],
    );
  } finally {
    harness.cleanup();
  }
});

Deno.test("event claim with lapsed membership stops before Agent lookup", async () => {
  const harness = setupHarness(false);
  try {
    const outcome = await executeEventDelivery(eventInput());
    assertEquals(outcome.success, false);
    assertEquals(outcome.receiptId, null);
    assertEquals(outcome.admission, undefined);
    assertStringIncludes(
      outcome.error || "",
      "PRO_SUBSCRIPTION_REQUIRED",
    );
    assertEquals(
      harness.fetchCalls.map((call) => call.pathname),
      ["/rest/v1/account_entitlements"],
    );
  } finally {
    harness.cleanup();
  }
});

Deno.test("async claim with active membership continues to Agent lookup", async () => {
  const harness = setupHarness(true);
  try {
    assertEquals(await executeQueuedJob(asyncJob()), { kind: "complete" });
    const failure = harness.fetchCalls.find((call) =>
      call.pathname === "/rest/v1/async_jobs" && call.method === "PATCH"
    );
    assert(failure);
    assertEquals(
      (failure.body as Record<string, unknown>).error,
      {
        type: "AppNotFound",
        message: "The Agent for this job no longer exists",
      },
    );
    assertEquals(
      harness.fetchCalls.some((call) => call.pathname === "/rest/v1/apps"),
      true,
    );
  } finally {
    harness.cleanup();
  }
});

Deno.test("async claim with lapsed membership fails durably without Agent lookup", async () => {
  const harness = setupHarness(false);
  try {
    assertEquals(await executeQueuedJob(asyncJob()), { kind: "complete" });
    const failure = harness.fetchCalls.find((call) =>
      call.pathname === "/rest/v1/async_jobs" && call.method === "PATCH"
    );
    assert(failure);
    assertEquals(
      (failure.body as Record<string, unknown>).error,
      {
        type: "PRO_SUBSCRIPTION_REQUIRED",
        message:
          "An active Galactic membership ($20/month) is required to deploy or run Agents or use persistent API keys.",
      },
    );
    assertEquals(
      harness.fetchCalls.some((call) => call.pathname === "/rest/v1/apps"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});
