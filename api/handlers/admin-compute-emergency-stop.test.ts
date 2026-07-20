import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  handleAdminComputeEmergencyStop,
  handleAdminComputeEmergencyStopRelease,
} from "./admin-compute-emergency-stop.ts";
import { handleAdmin } from "./admin.ts";
import {
  authenticateComputeEmergencyStopOperator,
} from "../services/compute-emergency-auth.ts";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const EMERGENCY_TOKEN = "emergency-stop-test-token-0123456789abcdef";
const OPERATOR_REFERENCE = `compute-emergency-stop:sha256:${"a".repeat(64)}`;

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
