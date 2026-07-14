import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  buildRoutineAIAttemptBudget,
  routineAIAllAttemptsFailedSettlementLight,
  routineAISuccessSettlementLight,
} from "./routine-ai-budget.ts";

Deno.test("routine AI budget: sequential primary and fallback reservations are summed", () => {
  const plan = buildRoutineAIAttemptBudget(2, 3);
  assertEquals(plan.primaryReservedLight, 2);
  assertEquals(plan.fallbackReservedLight, 3);
  assertEquals(plan.totalReservedLight, 5.0001);
});

Deno.test("routine AI budget: fallback success charges primary max plus fallback actual", () => {
  const plan = buildRoutineAIAttemptBudget(2, 3);
  assertEquals(routineAISuccessSettlementLight(plan, 1.25, true), 3.25);
  assertEquals(routineAISuccessSettlementLight(plan, 1.25, false), 1.25);
});

Deno.test("routine AI budget: all-fail charges the full admitted reservation", () => {
  assertEquals(routineAIAllAttemptsFailedSettlementLight(5.0001), 5.0001);
});

Deno.test("routine AI budget: BYOK stays zero while its reservation consumes a call slot", () => {
  assertEquals(buildRoutineAIAttemptBudget(0, 0).totalReservedLight, 0);
});
