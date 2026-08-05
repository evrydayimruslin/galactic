import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  handleAdminComputeCertification,
} from "./admin-compute-certification.ts";
import { handleAdmin } from "./admin.ts";
import type {
  ComputeCertificationSnapshot,
} from "../services/compute-certification.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const SINCE = "2026-08-04T11:00:00.000Z";
const CERTIFICATION_TOKEN = "compute-certification-token-0123456789abcdef";
const EMERGENCY_TOKEN = "compute-emergency-token-0123456789abcdef";
const AUTHORIZED_PRINCIPAL = {
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  entry: `${OWNER_ID}/${AGENT_ID}`,
};

function request(
  token = CERTIFICATION_TOKEN,
  body: Record<string, unknown> = {
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    run_ids: [RUN_ID],
    since: SINCE,
  },
  contentType = "application/json",
): Request {
  return new Request("https://example.com/api/admin/compute/certification", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
    },
    body: JSON.stringify(body),
  });
}

function snapshot(): ComputeCertificationSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-04T12:00:00+00:00",
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    since: "2026-08-04T11:00:00+00:00",
    latchState: "clear",
    requestedRunCount: 1,
    selectedRunCount: 1,
    runs: [{
      runId: RUN_ID,
      receiptId: RECEIPT_ID,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      callerFunction: "run_compute_certification",
      state: "succeeded",
      stateVersion: "5",
      billingMode: "wallet",
      capacityAgentId: AGENT_ID,
      environmentDigest: `sha256:${"a".repeat(64)}`,
      directiveHash: "b".repeat(64),
      requestHash: "c".repeat(64),
      createdAt: "2026-08-04T11:30:00+00:00",
      updatedAt: "2026-08-04T11:31:00+00:00",
      expiresAt: "2026-08-05T11:30:00+00:00",
      startedAt: "2026-08-04T11:30:01+00:00",
      finishedAt: "2026-08-04T11:31:00+00:00",
      cardinality: {
        budgetRows: 1,
        receiptRows: 1,
        tokenRows: 1,
        artifactRows: 1,
        inputArtifactRows: 0,
        outputArtifactRows: 1,
        projectedArtifactRows: 1,
      },
      backing: {
        runCapacityReservation: false,
        budgetHold: true,
        budgetCapacityReservation: false,
        receiptHold: true,
        receiptCapacityReservation: false,
        receiptCloudUsageEvent: true,
        budgetMatchesRunCapacity: true,
        receiptMatchesRunCapacity: true,
        receiptMatchesBudgetHold: true,
        budgetOwnerMatch: true,
        budgetCapacityAgentMatch: true,
        receiptPrincipalMatch: true,
        receiptCapacityAgentMatch: true,
      },
      budget: {
        status: "settled",
        billingMode: "wallet",
        rateVersion: "compute-rate-v1",
        rateLightPerMs: "0.000002056000",
        actualWallMs: "1000",
        reservedWallMs: "211000",
        teardownAllowanceMs: "15000",
        reservedLight: "0.433816000000",
        actualLight: "0.002056000000",
        releasedLight: "0.431760000000",
        expiresAt: "2026-08-04T12:30:00+00:00",
        settledAt: "2026-08-04T11:31:00+00:00",
      },
      receipt: {
        id: RECEIPT_ID,
        outcome: "succeeded",
        billingMode: "wallet",
        rateVersion: "compute-rate-v1",
        capacitySettlementStatus: "not_applicable",
        reservedLight: "0.433816000000",
        actualLight: "0.002056000000",
        releasedLight: "0.431760000000",
        workerWallMs: "1000",
        teardownAllowanceMs: "15000",
        billedWallMs: "1000",
        createdAt: "2026-08-04T11:31:00+00:00",
      },
      terminalActiveTokenCount: 0,
      artifacts: [{
        artifactId: ARTIFACT_ID,
        direction: "output",
        state: "ready",
        stateVersion: "2",
        sha256: "d".repeat(64),
        sizeBytes: "3",
        expiresAt: "2026-09-04T11:31:00+00:00",
        objectDeleted: false,
      }],
      violations: [],
    }],
    health: {
      staleNonterminalRuns: 0,
      oldSettlementPending: 0,
      terminalReservedBudgets: 0,
      receiptMismatches: 0,
      terminalActiveTokens: 0,
      dlqFencedRuns: 0,
      stalePendingArtifacts: 0,
      unreconciledDeletedOutputs: 0,
      terminalInputAliases: 0,
      violations: [],
    },
    violations: [],
  };
}

function emptyRawSnapshot(
  since = SINCE,
  generatedAt = "2026-08-04T12:00:00+00:00",
) {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    since,
    latch_state: "clear",
    requested_run_count: 1,
    selected_run_count: 0,
    runs: [],
    health: {
      stale_nonterminal_runs: 0,
      old_settlement_pending: 0,
      terminal_reserved_budgets: 0,
      receipt_mismatches: 0,
      terminal_active_tokens: 0,
      dlq_fenced_runs: 0,
      stale_pending_artifacts: 0,
      unreconciled_deleted_outputs: 0,
      terminal_input_aliases: 0,
      violations: [],
    },
    violations: ["SELECTED_RUN_CARDINALITY_MISMATCH"],
  };
}

Deno.test("admin Compute certification emits only strict snake-case evidence", async () => {
  let observedInput: unknown = null;
  const response = await handleAdminComputeCertification(request(), {
    authorizedPrincipal: AUTHORIZED_PRINCIPAL,
    readSnapshot: (input) => {
      observedInput = input;
      return Promise.resolve(snapshot());
    },
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "private, no-store");
  assertEquals(response.headers.get("vary"), "Authorization");
  assertEquals(observedInput, {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runIds: [RUN_ID],
    since: SINCE,
  });
  const body = await response.json() as Record<string, unknown>;
  assertEquals(body.schema_version, 1);
  assertEquals(body.owner_id, OWNER_ID);
  assertEquals(Object.hasOwn(body, "ownerId"), false);
  const run = (body.runs as Record<string, unknown>[])[0];
  assertEquals(run.environment_digest, `sha256:${"a".repeat(64)}`);
  assertEquals(Object.hasOwn(run, "environmentDigest"), false);
  const budget = run.budget as Record<string, unknown>;
  const receipt = run.receipt as Record<string, unknown>;
  assertEquals(budget.rate_version, "compute-rate-v1");
  assertEquals(budget.rate_light_per_ms, "0.000002056000");
  assertEquals(budget.actual_wall_ms, "1000");
  assertEquals(receipt.rate_version, "compute-rate-v1");
  const artifact = (run.artifacts as Record<string, unknown>[])[0];
  assertEquals(artifact.artifact_id, ARTIFACT_ID);
  assertEquals(Object.hasOwn(artifact, "storage_key"), false);
});

Deno.test("admin Compute certification rejects media and schema drift before reads", async () => {
  let reads = 0;
  const readSnapshot = () => {
    reads += 1;
    return Promise.resolve(snapshot());
  };
  const wrongMedia = await handleAdminComputeCertification(
    request(CERTIFICATION_TOKEN, {}, "text/plain"),
    { authorizedPrincipal: AUTHORIZED_PRINCIPAL, readSnapshot },
  );
  assertEquals(wrongMedia.status, 415);

  const oversized = await handleAdminComputeCertification(
    new Request("https://example.com/api/admin/compute/certification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(16_385) }),
    }),
    { authorizedPrincipal: AUTHORIZED_PRINCIPAL, readSnapshot },
  );
  assertEquals(oversized.status, 413);

  const extraField = await handleAdminComputeCertification(
    request(
      CERTIFICATION_TOKEN,
      {
        owner_id: OWNER_ID,
        agent_id: AGENT_ID,
        run_ids: [RUN_ID],
        since: SINCE,
        unsafe: true,
      },
    ),
    { authorizedPrincipal: AUTHORIZED_PRINCIPAL, readSnapshot },
  );
  assertEquals(extraField.status, 400);
  assertEquals(reads, 0);
});

Deno.test("admin Compute certification cannot read outside its bound principal", async () => {
  let reads = 0;
  const response = await handleAdminComputeCertification(
    request(CERTIFICATION_TOKEN, {
      owner_id: "99999999-9999-4999-8999-999999999999",
      agent_id: AGENT_ID,
      run_ids: [RUN_ID],
      since: SINCE,
    }),
    {
      authorizedPrincipal: AUTHORIZED_PRINCIPAL,
      readSnapshot: () => {
        reads += 1;
        return Promise.resolve(snapshot());
      },
    },
  );
  assertEquals(response.status, 403);
  assertEquals(reads, 0);
});

Deno.test("admin routing isolates certification from service-role and emergency credentials", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv ?? {}),
    SUPABASE_URL: "https://database.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    COMPUTE_CERTIFICATION_TOKEN: CERTIFICATION_TOKEN,
    COMPUTE_CERTIFICATION_PRINCIPAL: `${OWNER_ID}/${AGENT_ID}`,
    COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN,
  } as typeof globalThis.__env;
  try {
    for (const token of ["service-role-key", EMERGENCY_TOKEN]) {
      const response = await handleAdmin(request(token));
      assertEquals(response.status, 401);
      assertEquals(response.headers.get("cache-control"), "private, no-store");
    }
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("legacy admin auth fails closed when its credential collides with certification", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv ?? {}),
    SUPABASE_URL: "https://database.example",
    SUPABASE_SERVICE_ROLE_KEY: CERTIFICATION_TOKEN,
    COMPUTE_CERTIFICATION_TOKEN: CERTIFICATION_TOKEN,
    COMPUTE_CERTIFICATION_PRINCIPAL: `${OWNER_ID}/${AGENT_ID}`,
    COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN,
  } as typeof globalThis.__env;
  try {
    const response = await handleAdmin(
      new Request(
        "https://example.com/api/admin/unknown",
        { headers: { Authorization: `Bearer ${CERTIFICATION_TOKEN}` } },
      ),
    );
    assertEquals(response.status, 401);
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("dedicated certification credential reaches only the bounded snapshot RPC", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const recentSince = new Date(Date.now() - 60_000).toISOString();
  globalThis.__env = {
    ...(previousEnv ?? {}),
    SUPABASE_URL: "https://database.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    COMPUTE_CERTIFICATION_TOKEN: CERTIFICATION_TOKEN,
    COMPUTE_CERTIFICATION_PRINCIPAL: `${OWNER_ID}/${AGENT_ID}`,
    COMPUTE_EMERGENCY_STOP_TOKEN: EMERGENCY_TOKEN,
  } as typeof globalThis.__env;
  let rpcBody: Record<string, unknown> | null = null;
  const rateLimitBodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input, init) => {
    const outbound = new Request(
      input as RequestInfo | URL,
      init as RequestInit | undefined,
    );
    const url = new URL(outbound.url);
    if (url.pathname === "/rest/v1/rpc/check_rate_limit") {
      rateLimitBodies.push(await outbound.json() as Record<string, unknown>);
      return Response.json(true);
    }
    if (url.pathname === "/rest/v1/rpc/get_compute_certification_snapshot") {
      rpcBody = await outbound.json() as Record<string, unknown>;
      return Response.json(
        emptyRawSnapshot(recentSince, new Date().toISOString()),
      );
    }
    throw new Error(`Unexpected outbound request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    for (const clientIp of ["203.0.113.10", "198.51.100.20"]) {
      const routedRequest = request(CERTIFICATION_TOKEN, {
        owner_id: OWNER_ID,
        agent_id: AGENT_ID,
        run_ids: [RUN_ID],
        since: recentSince,
      });
      routedRequest.headers.set("x-forwarded-for", clientIp);
      const response = await handleAdmin(routedRequest);
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("cache-control"), "private, no-store");
      assertEquals(response.headers.get("vary"), "Authorization");
    }
    assertExists(rpcBody);
    assertEquals(rpcBody, {
      p_owner_id: OWNER_ID,
      p_agent_id: AGENT_ID,
      p_run_ids: [RUN_ID],
      p_since: recentSince,
    });
    assertEquals(rateLimitBodies.length, 2);
    assertEquals(rateLimitBodies[0].p_user_id, rateLimitBodies[1].p_user_id);
    assertEquals(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(String(rateLimitBodies[0].p_user_id)),
      true,
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});
