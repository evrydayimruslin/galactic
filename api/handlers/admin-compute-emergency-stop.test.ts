import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  handleAdminComputeEmergencyStop,
  handleAdminComputeEmergencyStopRelease,
  handleAdminComputeEmergencyStopStatus,
} from "./admin-compute-emergency-stop.ts";
import { handleAdmin } from "./admin.ts";
import {
  authenticateComputeEmergencyStopOperator,
} from "../services/compute-emergency-auth.ts";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const EMERGENCY_TOKEN = "emergency-stop-test-token-0123456789abcdef";
const OPERATOR_REFERENCE = `compute-emergency-stop:sha256:${"a".repeat(64)}`;
const CUTOFF_AT = "2026-07-20T12:00:00.000Z";
const CREATED_AT = "2026-07-20T11:59:59.000Z";
const UPDATED_AT = "2026-07-20T12:01:00.000Z";
const COMPLETED_AT = "2026-07-20T12:01:00.000Z";

function completedStatus() {
  return {
    schemaVersion: 1 as const,
    latchState: "completed" as const,
    operationId: OPERATION_ID,
    cutoffAt: CUTOFF_AT,
    targetCount: 2,
    terminalizedCount: 2,
    pendingTargetCount: 0 as const,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    completedAt: COMPLETED_AT,
  };
}

function clearStatus() {
  return {
    schemaVersion: 1 as const,
    latchState: "clear" as const,
    operationId: null,
    cutoffAt: null,
    targetCount: null,
    terminalizedCount: null,
    pendingTargetCount: null,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
  };
}

function request(
  body: Record<string, unknown>,
  headers: HeadersInit = {},
): Request {
  return new Request("https://example.com/api/admin/compute/emergency-stop", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": OPERATION_ID,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

Deno.test("admin Compute emergency stop requires destructive confirmation", async () => {
  const response = await handleAdminComputeEmergencyStop(
    request({
      reason: "containment",
      confirm: "no",
    }),
    OPERATOR_REFERENCE,
    { env: { COMPUTE_ENABLED: "0" } },
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { code: string };
  assertEquals(body.code, "COMPUTE_EMERGENCY_STOP_INVALID");
});

Deno.test("admin Compute emergency stop maps a completed audited operation", async () => {
  const response = await handleAdminComputeEmergencyStop(
    request({
      reason: "containment",
      confirm: "STOP_ALL_COMPUTE",
    }),
    OPERATOR_REFERENCE,
    {
      env: { COMPUTE_ENABLED: "0" },
      fenceBatch: () =>
        Promise.resolve({
          operationId: OPERATION_ID,
          status: "completed",
          cutoffAt: "2026-07-20T12:00:00.000Z",
          targetCount: 0,
          terminalizedCount: 0,
          targets: [],
          initializing: false,
          replayed: false,
        }),
    },
  );
  assertEquals(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assertEquals(body.success, true);
  assertEquals(body.operation_id, OPERATION_ID);
  assertEquals(body.continuation_required, false);
});

Deno.test("admin Compute emergency stop rejects the Supabase service role", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv ?? {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN,
  } as typeof globalThis.__env;
  try {
    const response = await handleAdmin(request({
      reason: "containment",
      confirm: "STOP_ALL_COMPUTE",
    }, { Authorization: "Bearer service-role-key" }));
    assertEquals(response.status, 401);
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("authorized admin Compute emergency stop reaches the durable RPC", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv ?? {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN,
    COMPUTE_ENABLED: "0",
  } as typeof globalThis.__env;
  let fenced = false;
  let operatorReference: string | null = null;
  globalThis.fetch = (async (input, init) => {
    const outbound = new Request(input, init);
    const url = new URL(outbound.url);
    if (url.pathname === "/rest/v1/rpc/check_rate_limit") {
      return Response.json(true);
    }
    if (url.pathname === "/rest/v1/rpc/fence_compute_emergency_stop_batch") {
      fenced = true;
      const payload = await outbound.json() as Record<string, unknown>;
      operatorReference = String(payload.p_operator_reference ?? "");
      return Response.json({
        operation_id: OPERATION_ID,
        status: "completed",
        cutoff_at: "2026-07-20T12:00:00.000Z",
        target_count: 0,
        terminalized_count: 0,
        targets: [],
        replayed: false,
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const response = await handleAdmin(request({
      reason: "containment",
      confirm: "STOP_ALL_COMPUTE",
    }, { Authorization: `Bearer ${EMERGENCY_TOKEN}` }));
    assertEquals(response.status, 200);
    assertEquals(fenced, true);
    const authorization = await authenticateComputeEmergencyStopOperator(
      request({}, { Authorization: `Bearer ${EMERGENCY_TOKEN}` }),
      { COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN },
    );
    assertEquals(authorization.status, "authorized");
    assertEquals(
      operatorReference,
      authorization.status === "authorized"
        ? authorization.operatorReference
        : null,
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});

Deno.test("admin Compute emergency-stop release is explicit and idempotent", async () => {
  const response = await handleAdminComputeEmergencyStopRelease(
    request({
      reason: "recovery matrix passed",
      confirm: "RELEASE_COMPUTE_STOP",
    }),
    OPERATION_ID,
    OPERATOR_REFERENCE,
    {
      env: { COMPUTE_ENABLED: "0" },
      release: () =>
        Promise.resolve({
          id: OPERATION_ID,
          status: "released",
          replayed: true,
        }),
    },
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    success: true,
    operation_id: OPERATION_ID,
    status: "released",
    replayed: true,
  });
});

Deno.test("emergency operator identity is credential-derived and fail-closed", async () => {
  const authorized = await authenticateComputeEmergencyStopOperator(
    request({}, { Authorization: `Bearer ${EMERGENCY_TOKEN}` }),
    { COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN },
  );
  assertEquals(authorized.status, "authorized");
  if (authorized.status === "authorized") {
    assertEquals(
      authorized.operatorReference.startsWith(
        "compute-emergency-stop:sha256:",
      ),
      true,
    );
    assertEquals(authorized.operatorReference.length, 94);
  }
  assertEquals(
    await authenticateComputeEmergencyStopOperator(
      request({}, {
        Authorization: "Bearer wrong-token-that-is-still-long-enough-123456",
      }),
      { COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN },
    ),
    { status: "unauthorized" },
  );
  assertEquals(
    await authenticateComputeEmergencyStopOperator(
      request({}, { Authorization: `Bearer ${EMERGENCY_TOKEN}` }),
      { COMPUTE_EMERGENCY_STOP_TOKEN: "short" },
    ),
    { status: "unavailable" },
  );
  for (
    const collision of [
      { COMPUTE_CERTIFICATION_TOKEN: EMERGENCY_TOKEN },
      { SUPABASE_SERVICE_ROLE_KEY: EMERGENCY_TOKEN },
    ]
  ) {
    assertEquals(
      await authenticateComputeEmergencyStopOperator(
        request({}, { Authorization: `Bearer ${EMERGENCY_TOKEN}` }),
        { COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN, ...collision },
      ),
      { status: "unavailable" },
    );
  }
});

Deno.test("request JSON cannot self-assert the emergency audit actor", async () => {
  const response = await handleAdminComputeEmergencyStop(
    request({
      operator_reference: "oncall:forged",
      reason: "containment",
      confirm: "STOP_ALL_COMPUTE",
    }),
    OPERATOR_REFERENCE,
    { env: { COMPUTE_ENABLED: "0" } },
  );
  assertEquals(response.status, 400);
  assertEquals(
    (await response.json() as { code: string }).code,
    "COMPUTE_EMERGENCY_STOP_INVALID",
  );
});

Deno.test("admin Compute emergency-stop status is minimal, exact, and private", async () => {
  const response = await handleAdminComputeEmergencyStopStatus({
    env: { COMPUTE_ENABLED: "0" },
    readStatus: () => Promise.resolve(completedStatus()),
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Cache-Control"), "private, no-store");
  assertEquals(response.headers.get("Pragma"), "no-cache");
  assertEquals(response.headers.get("Vary"), "Authorization");
  assertEquals(response.headers.get("X-Content-Type-Options"), "nosniff");
  assertEquals(await response.json(), {
    schema_version: 1,
    admission_state: "disabled",
    latch_state: "completed",
    operation_id: OPERATION_ID,
    cutoff_at: CUTOFF_AT,
    target_count: 2,
    terminalized_count: 2,
    pending_target_count: 0,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    completed_at: COMPLETED_AT,
  });
});

Deno.test("admin Compute emergency-stop status reports malformed flags without normalizing them", async () => {
  const response = await handleAdminComputeEmergencyStopStatus({
    env: { COMPUTE_ENABLED: " 0" },
    readStatus: () => Promise.resolve(clearStatus()),
  });
  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    schema_version: 1,
    admission_state: "invalid",
    latch_state: "clear",
    operation_id: null,
    cutoff_at: null,
    target_count: null,
    terminalized_count: null,
    pending_target_count: null,
    created_at: null,
    updated_at: null,
    completed_at: null,
  });
});

Deno.test("admin Compute emergency-stop status sanitizes persistence failures", async () => {
  const response = await handleAdminComputeEmergencyStopStatus({
    env: { COMPUTE_ENABLED: "0" },
    readStatus: () => Promise.reject(new Error("secret database detail")),
  });
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("Cache-Control"), "private, no-store");
  assertEquals(await response.json(), {
    error: "Compute emergency-stop status is unavailable.",
    code: "COMPUTE_EMERGENCY_STOP_STATUS_UNAVAILABLE",
  });
});

Deno.test("admin Compute emergency-stop status authenticates before persistence", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv ?? {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN,
    COMPUTE_ENABLED: "0",
  } as typeof globalThis.__env;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    return Promise.reject(new Error("persistence must not be reached"));
  }) as typeof fetch;
  try {
    const response = await handleAdmin(
      new Request(
        "https://example.com/api/admin/compute/emergency-stop",
        {
          method: "GET",
          headers: { Authorization: "Bearer service-role-key" },
        },
      ),
    );
    assertEquals(response.status, 401);
    assertEquals(fetchCalls, 0);
    assertEquals(response.headers.get("Cache-Control"), "private, no-store");
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});

Deno.test("authorized admin Compute emergency-stop status reads the sanitized RPC", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv ?? {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN,
    COMPUTE_ENABLED: "0",
  } as typeof globalThis.__env;
  const paths: string[] = [];
  globalThis.fetch = ((input, init) => {
    const outbound = new Request(input, init);
    const path = new URL(outbound.url).pathname;
    paths.push(path);
    if (path === "/rest/v1/rpc/check_rate_limit") {
      return Promise.resolve(Response.json(true));
    }
    if (path === "/rest/v1/rpc/get_compute_emergency_stop_status") {
      return Promise.resolve(Response.json({
        schema_version: 1,
        latch_state: "clear",
        operation_id: null,
        cutoff_at: null,
        target_count: null,
        terminalized_count: null,
        pending_target_count: null,
        created_at: null,
        updated_at: null,
        completed_at: null,
      }));
    }
    return Promise.reject(new Error(`Unexpected fetch ${outbound.url}`));
  }) as typeof fetch;
  try {
    const response = await handleAdmin(
      new Request(
        "https://example.com/api/admin/compute/emergency-stop",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${EMERGENCY_TOKEN}`,
            "x-forwarded-for": "203.0.113.19",
          },
        },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Cache-Control"), "private, no-store");
    assertEquals(await response.json(), {
      schema_version: 1,
      admission_state: "disabled",
      latch_state: "clear",
      operation_id: null,
      cutoff_at: null,
      target_count: null,
      terminalized_count: null,
      pending_target_count: null,
      created_at: null,
      updated_at: null,
      completed_at: null,
    });
    assertEquals(paths, [
      "/rest/v1/rpc/get_compute_emergency_stop_status",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});
