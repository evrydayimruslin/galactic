import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  accountCapacityErrorDetails,
  accountCapacityErrorMessage,
  claimAgentActivationSlot,
  getAccountCapacityStatus,
  getAgentCapacityStatus,
  reconcileCapacitySettlementAttribution,
  recordObservedCapacityCpu,
  reserveAccountCapacity,
  setAgentCapacityCap,
  settleAccountCapacityResources,
} from "./account-capacity.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("account capacity: Free status redacts unpublished numeric limits", async () => {
  const status = await getAccountCapacityStatus("user-1", {}, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async (_input, init) => {
      assertEquals(JSON.parse(String(init?.body)).p_user_id, "user-1");
      return jsonResponse([{
        plan_code: "free",
        limits_public: false,
        active_agent_limit: 1,
        capacity_state: "low",
        burst_resets_at: "2026-07-15T15:00:00.000Z",
        weekly_resets_at: "2026-07-20T10:00:00.000Z",
        next_eligible_at: null,
        burst_limit_light: 10,
        burst_used_light: 9,
        weekly_limit_light: 100,
        weekly_used_light: 50,
      }]);
    },
  });
  assertEquals(status.state, "low");
  assertEquals(status.activeAgentLimit, 1);
  assertEquals(status.burst.usedPercent, undefined);
  assertEquals(status.burst.limitLight, undefined);
  assertEquals(status.weekly.remainingLight, undefined);
});

Deno.test("account capacity: internal status can expose calibration values", async () => {
  const status = await getAccountCapacityStatus("user-1", {
    exposeInternalLimits: true,
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async () =>
      jsonResponse([{
        plan_code: "pro",
        limits_public: false,
        active_agent_limit: null,
        capacity_state: "available",
        burst_resets_at: "2026-07-15T15:00:00.000Z",
        weekly_resets_at: "2026-07-20T10:00:00.000Z",
        burst_limit_light: 10,
        burst_used_light: 2,
        weekly_limit_light: 100,
        weekly_used_light: 25,
      }]),
  });
  assertEquals(status.burst.usedPercent, 20);
  assertEquals(status.weekly.usedPercent, 25);
  assertEquals(status.burst.remainingLight, 8);
});

Deno.test("account capacity: Free Agent status redacts cap and numeric allowances", async () => {
  const status = await getAgentCapacityStatus("user-1", "agent-1", {}, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async () =>
      jsonResponse([{
        capacity_agent_id: "agent-1",
        plan_code: "free",
        limits_public: false,
        capacity_state: "low",
        burst_state: "low",
        weekly_state: "available",
        burst_resets_at: "2026-07-15T15:00:00.000Z",
        weekly_resets_at: "2026-07-20T10:00:00.000Z",
        agent_cap_basis_points: 10000,
        agent_burst_limit_light: 1,
        agent_burst_used_light: 0.9,
        agent_weekly_limit_light: 20,
        agent_weekly_used_light: 2,
      }]),
  });
  assertEquals(status.capBasisPoints, null);
  assertEquals(status.burst.usedPercent, undefined);
  assertEquals(status.weekly.limitLight, undefined);
});

Deno.test("account capacity: paid Agent status exposes percentages but not raw allowances", async () => {
  const status = await getAgentCapacityStatus("user-1", "agent-1", {}, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async () =>
      jsonResponse([{
        capacity_agent_id: "agent-1",
        plan_code: "pro",
        limits_public: false,
        capacity_state: "available",
        burst_state: "available",
        weekly_state: "low",
        burst_resets_at: "2026-07-15T15:00:00.000Z",
        weekly_resets_at: "2026-07-20T10:00:00.000Z",
        agent_cap_basis_points: 2500,
        agent_burst_limit_light: 1.25,
        agent_burst_used_light: 0.25,
        agent_weekly_limit_light: 25,
        agent_weekly_used_light: 20,
      }]),
  });
  assertEquals(status.capBasisPoints, 2500);
  assertEquals(status.burst.usedPercent, 20);
  assertEquals(status.weekly.usedPercent, 80);
  assertEquals(status.burst.limitLight, undefined);
  assertEquals(status.weekly.remainingLight, undefined);
});

Deno.test("account capacity: paid account status exposes percentages but not raw allowances", async () => {
  const status = await getAccountCapacityStatus("user-1", {}, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async () =>
      jsonResponse([{
        plan_code: "pro",
        limits_public: false,
        active_agent_limit: null,
        capacity_state: "low",
        burst_state: "available",
        weekly_state: "low",
        burst_resets_at: "2026-07-15T15:00:00.000Z",
        weekly_resets_at: "2026-07-20T10:00:00.000Z",
        burst_limit_light: 5,
        burst_used_light: 1,
        weekly_limit_light: 100,
        weekly_used_light: 80,
      }]),
  });
  assertEquals(status.burst.usedPercent, 20);
  assertEquals(status.weekly.usedPercent, 80);
  assertEquals(status.burst.limitLight, undefined);
  assertEquals(status.weekly.remainingLight, undefined);
});

Deno.test("account capacity: denial carries deterministic retry time", async () => {
  const admission = await reserveAccountCapacity({
    userId: "user-1",
    idempotencyKey: "execution:123",
    reserveLight: 1,
    expiresAt: "2026-07-15T15:05:00.000Z",
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async () =>
      jsonResponse([{
        allowed: false,
        code: "capacity_waiting",
        reservation_id: null,
        plan_code: "free",
        capacity_state: "waiting",
        burst_resets_at: "2026-07-15T15:00:00.000Z",
        weekly_resets_at: "2026-07-20T10:00:00.000Z",
        next_eligible_at: "2026-07-20T10:00:00.000Z",
        burst_remaining_light: 0,
        weekly_remaining_light: 0,
      }]),
  });
  assertEquals(admission.allowed, false);
  assertEquals(admission.code, "capacity_waiting");
  assertEquals(admission.nextEligibleAt, "2026-07-20T10:00:00.000Z");
});

Deno.test("account capacity: invalid reservation never reaches the database", async () => {
  await assertRejects(
    () =>
      reserveAccountCapacity({
        userId: "user-1",
        idempotencyKey: "",
        reserveLight: 1,
        expiresAt: "2026-07-15T15:05:00.000Z",
      }),
    Error,
    "idempotency key",
  );
});

Deno.test("account capacity: Agent enforcement uses v3 with authoritative attribution and concurrency facts", async () => {
  let calledUrl = "";
  let calledBody: Record<string, unknown> = {};
  const admission = await reserveAccountCapacity({
    userId: "user-1",
    capacityAgentId: "agent-root",
    idempotencyKey: "execution:unique-1",
    reserveLight: 0.25,
    expiresAt: "2026-07-15T15:05:00.000Z",
    usesInference: true,
    routineId: "routine-1",
    routineRunId: "routine-run-1",
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    agentCapacityEnabled: true,
    fetchFn: async (input, init) => {
      calledUrl = String(input);
      calledBody = JSON.parse(String(init?.body));
      return jsonResponse([{
        allowed: true,
        code: "ok",
        reservation_id: "reservation-1",
        plan_code: "pro",
        capacity_state: "available",
        burst_resets_at: "2026-07-15T15:00:00.000Z",
        weekly_resets_at: "2026-07-20T10:00:00.000Z",
        burst_remaining_light: 4,
        weekly_remaining_light: 90,
        capacity_agent_id: "agent-root",
        agent_cap_basis_points: 2500,
        binding_constraint: null,
        agent_burst_remaining_light: 1,
        agent_weekly_remaining_light: 20,
      }]);
    },
  });
  assertEquals(calledUrl.endsWith("/rpc/reserve_account_capacity_v3"), true);
  assertEquals(calledBody.p_capacity_agent_id, "agent-root");
  assertEquals(calledBody.p_uses_inference, true);
  assertEquals(calledBody.p_routine_id, "routine-1");
  assertEquals(calledBody.p_routine_run_id, "routine-run-1");
  assertEquals(admission.agentCapacity, {
    agentId: "agent-root",
    capBasisPoints: 2500,
    bindingConstraint: null,
    burstRemainingLight: 1,
    weeklyRemainingLight: 20,
  });
});

Deno.test("account capacity: concurrency denial preserves economic status and retry scope", async () => {
  const admission = await reserveAccountCapacity({
    userId: "user-1",
    capacityAgentId: "agent-root",
    idempotencyKey: "execution:concurrency",
    reserveLight: 0,
    expiresAt: "2026-07-15T15:05:00.000Z",
    usesInference: true,
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    agentCapacityEnabled: true,
    fetchFn: async () =>
      jsonResponse([{
        allowed: false,
        code: "concurrency_waiting",
        reservation_id: null,
        plan_code: "pro",
        capacity_state: "available",
        burst_state: "available",
        weekly_state: "available",
        burst_resets_at: "2026-07-15T15:00:00.000Z",
        weekly_resets_at: "2026-07-20T10:00:00.000Z",
        next_eligible_at: "2026-07-15T14:01:00.000Z",
        burst_remaining_light: 4,
        weekly_remaining_light: 90,
        capacity_agent_id: "agent-root",
        agent_cap_basis_points: 10_000,
        concurrency_scope: "ai",
      }]),
  });
  assertEquals(admission.code, "concurrency_waiting");
  assertEquals(admission.state, "available");
  assertEquals(admission.concurrencyScope, "ai");
  assertEquals(
    accountCapacityErrorMessage(admission),
    "Too many AI calls are already in progress. Retry after 2026-07-15T14:01:00.000Z.",
  );
  assertEquals(
    accountCapacityErrorDetails(admission).concurrency_scope,
    "ai",
  );
});

Deno.test("account capacity: immediate resource settlement never sends wall duration", async () => {
  let calledUrl = "";
  let calledBody: Record<string, unknown> = {};
  const settlement = await settleAccountCapacityResources({
    reservationId: "reservation-1",
    userId: "user-1",
    receiptId: "receipt-1",
    executionId: "execution-1",
    executedAt: "2026-07-17T20:00:00.000Z",
    resourceFacts: [{
      resource: "d1_read",
      units: 100,
      cloudUnits: 1,
      amountLight: 0.001,
    }],
    reuseKeyHash: "stable-worker-hash",
    workerRequestCount: 1,
    billingConfig: {
      version: 7,
      workerMsPerCloudUnit: 250,
      cloudUnitLightPer1k: 1,
      workerRequestLightPerInvocation: 0.00003,
      workerLoadLightPerInvocation: 0.5,
    },
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async (input, init) => {
      calledUrl = String(input);
      calledBody = JSON.parse(String(init?.body));
      return jsonResponse([{
        settlement_id: "settlement-1",
        status: "pending_cpu",
        immediate_light: 0.50103,
        operation_light: 0.001,
        worker_request_light: 0.00003,
        dynamic_worker_light: 0.5,
        cpu_light: 0,
        total_light: 0.50103,
        dynamic_worker_charged: true,
        billing_config_version: 7,
      }]);
    },
  });
  assertEquals(
    calledUrl.endsWith("/rpc/settle_account_capacity_resources"),
    true,
  );
  assertEquals(calledBody.p_operation_light, 0.001);
  assertEquals(calledBody.p_executed_at, "2026-07-17T20:00:00.000Z");
  assertEquals(calledBody.p_worker_load_mode, "reuse");
  assertEquals(calledBody.p_worker_identity_hash, "stable-worker-hash");
  assertEquals(calledBody.p_dynamic_worker_invoked, true);
  assertEquals(calledBody.p_expected_cpu_sources, [
    "cloudflare_tail_parent",
    "cloudflare_dynamic_tail",
  ]);
  assertEquals("p_duration_ms" in calledBody, false);
  assertEquals("p_timeout_ms" in calledBody, false);
  assertEquals(settlement.status, "pending_cpu");
  assertEquals(settlement.totalLight, 0.50103);
});

Deno.test("account capacity: receipt/routine attribution reconciliation preserves exact delta", async () => {
  let calledBody: Record<string, unknown> = {};
  const result = await reconcileCapacitySettlementAttribution({
    receiptId: "receipt-1",
    userId: "user-1",
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async (input, init) => {
      assertEquals(
        String(input).endsWith(
          "/rpc/reconcile_capacity_settlement_attribution",
        ),
        true,
      );
      calledBody = JSON.parse(String(init?.body));
      return jsonResponse([{
        reconciled: true,
        total_light: 0.75,
        delta_light: 0.25,
      }]);
    },
  });
  assertEquals(calledBody, {
    p_receipt_id: "receipt-1",
    p_user_id: "user-1",
  });
  assertEquals(result, {
    reconciled: true,
    totalLight: 0.75,
    deltaLight: 0.25,
  });
});

Deno.test("account capacity: execution shape declares exactly the CPU sources it expects", async () => {
  let calledBody: Record<string, unknown> = {};
  await settleAccountCapacityResources({
    reservationId: "reservation-parent-only",
    userId: "user-1",
    receiptId: "receipt-parent-only",
    executedAt: "2026-07-17T20:01:00.000Z",
    dynamicWorkerInvoked: false,
    workerRequestCount: 1,
    billingConfig: {
      version: 7,
      workerMsPerCloudUnit: 250,
      cloudUnitLightPer1k: 1,
      workerRequestLightPerInvocation: 0.00003,
      workerLoadLightPerInvocation: 0.5,
    },
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async (_input, init) => {
      calledBody = JSON.parse(String(init?.body));
      return jsonResponse([{
        settlement_id: "settlement-parent-only",
        status: "pending_cpu",
        immediate_light: 0.00003,
        operation_light: 0,
        worker_request_light: 0.00003,
        dynamic_worker_light: 0,
        cpu_light: 0,
        total_light: 0.00003,
        dynamic_worker_charged: false,
        billing_config_version: 7,
      }]);
    },
  });
  assertEquals(calledBody.p_dynamic_worker_invoked, false);
  assertEquals(calledBody.p_worker_load_mode, "none");
  assertEquals(calledBody.p_worker_load_light, 0);
  assertEquals(calledBody.p_expected_cpu_sources, [
    "cloudflare_tail_parent",
  ]);
});

Deno.test("account capacity: Loader identity without fetch charges identity but expects parent CPU only", async () => {
  let calledBody: Record<string, unknown> = {};
  await settleAccountCapacityResources({
    reservationId: "reservation-identity-only",
    userId: "user-1",
    receiptId: "receipt-identity-only",
    executedAt: "2026-07-17T20:02:00.000Z",
    dynamicWorkerIdentityCreated: true,
    dynamicWorkerInvoked: false,
    reuseKeyHash: "identity-only-hash",
    workerRequestCount: 1,
    billingConfig: {
      version: 7,
      workerMsPerCloudUnit: 250,
      cloudUnitLightPer1k: 1,
      workerRequestLightPerInvocation: 0.00003,
      workerLoadLightPerInvocation: 0.5,
    },
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async (_input, init) => {
      calledBody = JSON.parse(String(init?.body));
      return jsonResponse([{
        settlement_id: "settlement-identity-only",
        status: "pending_cpu",
        immediate_light: 0.50003,
        operation_light: 0,
        worker_request_light: 0.00003,
        dynamic_worker_light: 0.5,
        cpu_light: 0,
        total_light: 0.50003,
        dynamic_worker_charged: true,
        billing_config_version: 7,
      }]);
    },
  });
  assertEquals(calledBody.p_dynamic_worker_invoked, false);
  assertEquals(calledBody.p_worker_load_mode, "reuse");
  assertEquals(calledBody.p_worker_identity_hash, "identity-only-hash");
  assertEquals(calledBody.p_expected_cpu_sources, [
    "cloudflare_tail_parent",
  ]);
});

Deno.test("account capacity: Tail CPU observation sends raw CPU and diagnostic wall time only", async () => {
  let calledBody: Record<string, unknown> = {};
  const observation = await recordObservedCapacityCpu({
    receiptId: "receipt-1",
    cpuTimeMs: 2.5,
    wallTimeMs: 45_000,
    observedAt: "2026-07-17T20:00:00.000Z",
    source: "cloudflare_tail_parent",
    final: true,
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async (_input, init) => {
      calledBody = JSON.parse(String(init?.body));
      return jsonResponse([{
        observation_id: "capacity_cpu:1:cloudflare_tail_parent:receipt-1",
        application_status: "applied",
        settlement_id: "settlement-1",
        event_id: "event-1",
        inserted: true,
        settlement_status: "final",
        cpu_time_ms: 2.5,
        wall_time_ms: 45_000,
        cpu_light: 0.00001,
        total_light: 0.50104,
        attempts: 1,
        next_attempt_at: null,
        last_error: null,
      }]);
    },
  });
  assertEquals(calledBody.p_cpu_time_ms, 2.5);
  assertEquals(calledBody.p_wall_time_ms, 45_000);
  assertEquals(calledBody.p_final, true);
  assertEquals(
    calledBody.p_observation_id,
    "capacity_cpu:1:cloudflare_tail_parent:receipt-1",
  );
  assertEquals("p_amount_light" in calledBody, false);
  assertEquals(observation.applicationStatus, "applied");
  assertEquals(observation.settlementStatus, "final");
  assertEquals(observation.cpuLight, 0.00001);
});

Deno.test("account capacity: early Tail observation is durably pending, not an error", async () => {
  const observation = await recordObservedCapacityCpu({
    receiptId: "receipt-early",
    cpuTimeMs: 1,
    wallTimeMs: 20_000,
    observedAt: "2026-07-17T20:00:00.000Z",
    source: "cloudflare_dynamic_tail",
    final: true,
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async () =>
      jsonResponse([{
        observation_id: "capacity_cpu:1:cloudflare_dynamic_tail:receipt-early",
        application_status: "pending",
        settlement_id: null,
        event_id: null,
        inserted: true,
        settlement_status: null,
        cpu_time_ms: 1,
        wall_time_ms: 20_000,
        cpu_light: 0,
        total_light: 0,
        attempts: 1,
        next_attempt_at: "2026-07-17T20:00:05.000Z",
        last_error: "settlement_not_ready",
      }]),
  });
  assertEquals(observation.applicationStatus, "pending");
  assertEquals(observation.settlementId, null);
  assertEquals(observation.lastError, "settlement_not_ready");
});

Deno.test("account capacity: partial CPU observations fail closed before ingestion", async () => {
  let called = false;
  await assertRejects(
    () =>
      recordObservedCapacityCpu(
        {
          receiptId: "receipt-partial",
          cpuTimeMs: 1,
          wallTimeMs: 2,
          observedAt: "2026-07-17T20:00:00.000Z",
          source: "cloudflare_tail_parent",
          final: false,
        } as unknown as Parameters<typeof recordObservedCapacityCpu>[0],
        {
          supabaseUrl: "https://db.example",
          serviceRoleKey: "service-role",
          fetchFn: async () => {
            called = true;
            return jsonResponse([]);
          },
        },
      ),
    Error,
    "Capacity CPU observation must be final",
  );
  assertEquals(called, false);
});

Deno.test("account capacity: Agent enforcement fails closed without attribution", async () => {
  await assertRejects(
    () =>
      reserveAccountCapacity({
        userId: "user-1",
        idempotencyKey: "execution:missing-agent",
        reserveLight: 1,
        expiresAt: "2026-07-15T15:05:00.000Z",
      }, { agentCapacityEnabled: true }),
    Error,
    "Agent attribution is required",
  );
});

Deno.test("account capacity: cap-too-low is distinct and has no fake retry", async () => {
  const admission = await reserveAccountCapacity({
    userId: "user-1",
    capacityAgentId: "agent-root",
    idempotencyKey: "execution:too-large",
    reserveLight: 2,
    expiresAt: "2026-07-15T15:05:00.000Z",
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    agentCapacityEnabled: true,
    fetchFn: async () =>
      jsonResponse([{
        allowed: false,
        code: "agent_cap_too_low_for_request",
        reservation_id: null,
        plan_code: "pro",
        capacity_state: "waiting",
        burst_resets_at: "2026-07-15T15:00:00.000Z",
        weekly_resets_at: "2026-07-20T10:00:00.000Z",
        next_eligible_at: null,
        burst_remaining_light: 5,
        weekly_remaining_light: 100,
        capacity_agent_id: "agent-root",
        agent_cap_basis_points: 1000,
        binding_constraint: "agent",
        agent_burst_remaining_light: 0.5,
        agent_weekly_remaining_light: 10,
      }]),
  });
  assertEquals(admission.code, "agent_cap_too_low_for_request");
  assertEquals(admission.nextEligibleAt, null);
  assertEquals(
    accountCapacityErrorMessage(admission),
    "This Agent's capacity cap is too low to admit one execution. Increase the cap and try again.",
  );
  assertEquals(accountCapacityErrorDetails(admission), {
    type: "agent_cap_too_low_for_request",
    plan: "pro",
    state: "waiting",
    retry_at: null,
    burst_resets_at: "2026-07-15T15:00:00.000Z",
    weekly_resets_at: "2026-07-20T10:00:00.000Z",
    capacity_agent_id: "agent-root",
    agent_cap_basis_points: 1000,
    binding_constraint: "agent",
  });
});

Deno.test("account capacity: cap mutation validates basis points client-side", async () => {
  await assertRejects(
    () =>
      setAgentCapacityCap({
        userId: "user-1",
        agentId: "agent-1",
        capBasisPoints: 0,
      }),
    Error,
    "1 to 10000 basis points",
  );
});

Deno.test("account capacity: Free activation denial identifies the occupied Agent", async () => {
  const decision = await claimAgentActivationSlot("user-1", "app-2", {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async () =>
      jsonResponse([{
        allowed: false,
        code: "active_agent_limit",
        active_agent_limit: 1,
        occupied_by: "app-1",
      }]),
  });
  assertEquals(decision, {
    allowed: false,
    code: "active_agent_limit",
    activeAgentLimit: 1,
    occupiedBy: "app-1",
  });
});
