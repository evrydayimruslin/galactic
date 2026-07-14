import { settleRoutineRunBudgetReservation } from "../../services/routine-budget.ts";

export const EMBEDDING_RESERVATION_TOKEN_OVERHEAD = 32;

export function estimateEmbeddingReservationLight(
  input: string,
  ratePer1kTokens: number,
  byok: boolean,
  tokenOverhead = EMBEDDING_RESERVATION_TOKEN_OVERHEAD,
): number {
  if (byok) return 0;
  // UTF-8 bytes are a conservative upper bound on token count for the
  // supported text embedding model. Round up at the same precision used by
  // routine budget accounting so actual provider usage cannot exceed reserve.
  const tokenUpperBound = new TextEncoder().encode(input).byteLength +
    Math.max(0, Math.ceil(tokenOverhead));
  const estimate = tokenUpperBound * Math.max(0, ratePer1kTokens) / 1000;
  return Math.ceil(estimate * 10_000) / 10_000;
}

/**
 * Once an embedding request is dispatched, a timeout/transport failure cannot
 * prove zero upstream work. Finalize at the admitted maximum; if this call
 * fails, the row intentionally remains reserved for expiry reconciliation.
 */
export function settleAmbiguousEmbeddingReservation(
  input: {
    reservationId: string;
    userId: string;
    reservedLight: number;
  },
  settleFn: typeof settleRoutineRunBudgetReservation =
    settleRoutineRunBudgetReservation,
): Promise<void> {
  return settleFn({
    reservationId: input.reservationId,
    userId: input.userId,
    actualLight: input.reservedLight,
    applySpend: true,
  });
}
