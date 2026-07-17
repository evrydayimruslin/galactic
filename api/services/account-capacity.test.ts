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
  reserveAccountCapacity,
  setAgentCapacityCap,
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

Deno.test("account capacity: Agent enforcement uses v2 with authoritative attribution", async () => {
  let calledUrl = "";
  let calledBody: Record<string, unknown> = {};
  const admission = await reserveAccountCapacity({
    userId: "user-1",
    capacityAgentId: "agent-root",
    idempotencyKey: "execution:unique-1",
    reserveLight: 0.25,
    expiresAt: "2026-07-15T15:05:00.000Z",
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
  assertEquals(calledUrl.endsWith("/rpc/reserve_account_capacity_v2"), true);
  assertEquals(calledBody.p_capacity_agent_id, "agent-root");
  assertEquals(admission.agentCapacity, {
    agentId: "agent-root",
    capBasisPoints: 2500,
    bindingConstraint: null,
    burstRemainingLight: 1,
    weeklyRemainingLight: 20,
  });
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
