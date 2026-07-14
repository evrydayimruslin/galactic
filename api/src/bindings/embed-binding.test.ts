import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  estimateEmbeddingReservationLight,
  settleAmbiguousEmbeddingReservation,
} from "./embedding-budget.ts";

Deno.test("embedding reservation uses UTF-8 bytes as a conservative token bound", () => {
  assertEquals(estimateEmbeddingReservationLight("test", 2, false, 0), 0.008);
  assertEquals(estimateEmbeddingReservationLight("é", 2, false, 0), 0.004);
  assertEquals(estimateEmbeddingReservationLight("test", 2, false), 0.072);
  assertEquals(estimateEmbeddingReservationLight("test", 2, true), 0);
});

Deno.test("embedding post-dispatch failure settles the full reservation and never releases it", async () => {
  let settlement: Record<string, unknown> | null = null;
  await settleAmbiguousEmbeddingReservation({
    reservationId: "reservation-1",
    userId: "user-1",
    reservedLight: 4.25,
  }, (async (input) => {
    settlement = input as unknown as Record<string, unknown>;
  }) as typeof import("../../services/routine-budget.ts").settleRoutineRunBudgetReservation);

  const actual = settlement as Record<string, unknown> | null;
  assertEquals(actual, {
    reservationId: "reservation-1",
    userId: "user-1",
    actualLight: 4.25,
    applySpend: true,
  });
});
