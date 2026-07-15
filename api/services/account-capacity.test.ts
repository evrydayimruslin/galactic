import { assertEquals, assertRejects } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  claimAgentActivationSlot,
  getAccountCapacityStatus,
  reserveAccountCapacity,
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
    fetchFn: async () => jsonResponse([{
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

Deno.test("account capacity: denial carries deterministic retry time", async () => {
  const admission = await reserveAccountCapacity({
    userId: "user-1",
    idempotencyKey: "execution:123",
    reserveLight: 1,
    expiresAt: "2026-07-15T15:05:00.000Z",
  }, {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async () => jsonResponse([{
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
    () => reserveAccountCapacity({
      userId: "user-1",
      idempotencyKey: "",
      reserveLight: 1,
      expiresAt: "2026-07-15T15:05:00.000Z",
    }),
    Error,
    "idempotency key",
  );
});

Deno.test("account capacity: Free activation denial identifies the occupied Agent", async () => {
  const decision = await claimAgentActivationSlot("user-1", "app-2", {
    supabaseUrl: "https://db.example",
    serviceRoleKey: "service-role",
    fetchFn: async () => jsonResponse([{
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
