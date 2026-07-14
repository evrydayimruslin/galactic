export interface RoutineAIAttemptBudgetPlan {
  primaryReservedLight: number;
  fallbackReservedLight: number;
  totalReservedLight: number;
}

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be finite and non-negative`);
  }
  return value;
}

/**
 * Budget every provider attempt that may run sequentially. A failed primary
 * can still be billed upstream before the fallback begins, so max(primary,
 * fallback) is not a hard bound. Exact-zero BYOK remains zero while still
 * consuming the reservation row's call slot.
 */
export function buildRoutineAIAttemptBudget(
  primaryReservedLight: number,
  fallbackReservedLight = 0,
): RoutineAIAttemptBudgetPlan {
  const primary = finiteNonNegative(
    primaryReservedLight,
    "primaryReservedLight",
  );
  const fallback = finiteNonNegative(
    fallbackReservedLight,
    "fallbackReservedLight",
  );
  const total = primary + fallback;
  return {
    primaryReservedLight: primary,
    fallbackReservedLight: fallback,
    // Pricing is rounded to 4dp. One extra basis point prevents a boundary
    // rejection from floating-point drift, but a BYOK zero must stay zero.
    totalReservedLight: total === 0
      ? 0
      : Math.ceil((total + 0.0001) * 10_000) / 10_000,
  };
}

/** A fallback success still conservatively counts the ambiguous primary. */
export function routineAISuccessSettlementLight(
  plan: RoutineAIAttemptBudgetPlan,
  successfulAttemptActualLight: number,
  fallbackUsed: boolean,
): number {
  const actual = finiteNonNegative(
    successfulAttemptActualLight,
    "successfulAttemptActualLight",
  );
  return (fallbackUsed ? plan.primaryReservedLight : 0) + actual;
}

/** No successful usage payload means every attempted reservation is charged. */
export function routineAIAllAttemptsFailedSettlementLight(
  admittedReservedLight: number,
): number {
  return finiteNonNegative(admittedReservedLight, "admittedReservedLight");
}
