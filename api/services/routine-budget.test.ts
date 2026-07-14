import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  releaseRoutineRunBudgetReservation,
  reserveRoutineRunBudget,
  settleRoutineRunBudgetReservation,
} from "./routine-budget.ts";

const routine = {
  routineId: "11111111-1111-4111-8111-111111111111",
  routineRunId: "22222222-2222-4222-8222-222222222222",
  traceId: "33333333-3333-4333-8333-333333333333",
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deps(fetchFn: typeof fetch) {
  return {
    fetchFn,
    supabaseUrl: "https://supabase.example",
    serviceRoleKey: "service-key",
  };
}

Deno.test("routine budget: reserves before execution and preserves zero-cost BYOK call slots", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    requests.push({ url: String(input), body });
    return response([{
      allowed: true,
      code: "ok",
      message: "reserved",
      reservation_id: "44444444-4444-4444-8444-444444444444",
      reservation_key: body.p_reservation_key,
      reserved_light: body.p_reserve_light,
      calls_used: 1,
      calls_limit: 25,
      light_used: 0,
      light_reserved: 0,
      light_limit: 10,
    }]);
  }) as typeof fetch;

  const admission = await reserveRoutineRunBudget({
    userId: "user-1",
    routine,
    reservationKey: "ai:exec-1:call-1",
    kind: "ai_call",
    reserveLight: 0,
  }, deps(fetchFn));

  assertEquals(admission.allowed, true);
  assertEquals(admission.reservation?.callsUsed, 1);
  assertEquals(admission.reservation?.reservedLight, 0);
  assertEquals(requests[0].body.p_kind, "ai_call");
  assertEquals(requests[0].body.p_reserve_light, 0);
});

Deno.test("routine budget: returns authoritative denial without a reservation", async () => {
  const admission = await reserveRoutineRunBudget({
    userId: "user-1",
    routine,
    reservationKey: "app:receipt-2",
    kind: "app_call",
    reserveLight: 2,
  }, deps((async () => response([{
      allowed: false,
      code: "routine_budget_light_exhausted",
      message: "ceiling reached",
      reservation_id: null,
    }])) as typeof fetch));
  assertEquals(admission.allowed, false);
  assertEquals(admission.code, "routine_budget_light_exhausted");
  assertEquals(admission.reservation, null);
});

Deno.test("routine budget: an in-flight idempotency key is non-executable", async () => {
  const admission = await reserveRoutineRunBudget({
    userId: "user-1",
    routine,
    reservationKey: "app:receipt-in-flight",
    kind: "app_call",
    reserveLight: 2,
  }, deps((async () => response([{
    allowed: false,
    code: "routine_budget_reservation_in_flight",
    message: "already in flight",
    reservation_id: null,
  }])) as typeof fetch));

  assertEquals(admission.allowed, false);
  assertEquals(admission.code, "routine_budget_reservation_in_flight");
  assertEquals(admission.reservation, null);
});

Deno.test("routine budget: admission infrastructure errors fail closed", async () => {
  await assertRejects(
    () =>
      reserveRoutineRunBudget({
        userId: "user-1",
        routine,
        reservationKey: "app:receipt-3",
        kind: "app_call",
        reserveLight: 1,
      }, deps(
        (async () => response({ error: "rpc unavailable" }, 503)) as typeof fetch,
      )),
    Error,
    "admission unavailable",
  );
});

Deno.test("routine budget: an undersized allowed reservation fails closed", async () => {
  await assertRejects(
    () =>
      reserveRoutineRunBudget({
        userId: "user-1",
        routine,
        reservationKey: "app:undersized",
        kind: "app_call",
        reserveLight: 2,
      }, deps((async () => response([{
        allowed: true,
        code: "ok",
        message: "reserved",
        reservation_id: "44444444-4444-4444-8444-444444444444",
        reservation_key: "app:undersized",
        reserved_light: 1,
      }])) as typeof fetch)),
    Error,
    "undersized reservation",
  );
});

Deno.test("routine budget: settle and release use separate idempotent RPCs", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body || "{}")),
    });
    return response(true);
  }) as typeof fetch;

  await settleRoutineRunBudgetReservation({
    reservationId: "44444444-4444-4444-8444-444444444444",
    userId: "user-1",
    actualLight: 0.25,
    applySpend: true,
  }, deps(fetchFn));
  await releaseRoutineRunBudgetReservation({
    reservationId: "55555555-5555-4555-8555-555555555555",
    userId: "user-1",
  }, deps(fetchFn));

  assertEquals(
    requests[0].url.includes("settle_routine_run_budget_reservation"),
    true,
  );
  assertEquals(requests[0].body.p_actual_light, 0.25);
  assertEquals(requests[0].body.p_apply_spend, true);
  assertEquals(
    requests[1].url.includes("release_routine_run_budget_reservation"),
    true,
  );
});
