import { getCapacityTelemetryQueue } from "../../lib/env.ts";
import {
  callComputeRpc,
  type ComputeDatabaseDeps,
  firstComputeRow,
  requiredString,
} from "./database.ts";

const COMPUTE_CAPACITY_SETTLEMENT_INTENT_KIND =
  "compute_capacity_settlement_intent" as const;
const COMPUTE_CAPACITY_SETTLEMENT_INTENT_VERSION = 1 as const;
export const MAX_COMPUTE_CAPACITY_SETTLEMENT_INTENT_BYTES = 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ComputeCapacitySettlementInput {
  runId: string;
  userId: string;
  receiptId: string;
  reservationId: string;
  actualLight: number;
}

export async function listPendingComputeCapacitySettlements(
  input: { limit?: number } = {},
  deps: ComputeDatabaseDeps = {},
): Promise<ComputeCapacitySettlementInput[]> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Compute capacity settlement limit must be between 1 and 500");
  }
  const payload = await callComputeRpc(
    "list_pending_compute_capacity_settlements",
    { p_limit: limit },
    deps,
  );
  if (!Array.isArray(payload)) return [];
  return payload.map((value) => {
    const row = value !== null && typeof value === "object" &&
        !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    if (!row) throw new Error("Pending Compute capacity settlement is invalid");
    const actualLight = typeof row.actual_light === "number"
      ? row.actual_light
      : Number(row.actual_light);
    return computeCapacitySettlementInputFromIntent(
      buildComputeCapacitySettlementIntent({
        runId: requiredString(row, "run_id", "Pending Compute settlement"),
        userId: requiredString(row, "user_id", "Pending Compute settlement"),
        receiptId: requiredString(
          row,
          "receipt_id",
          "Pending Compute settlement",
        ),
        reservationId: requiredString(
          row,
          "capacity_reservation_id",
          "Pending Compute settlement",
        ),
        actualLight,
      }),
    );
  });
}

/**
 * Compact recovery envelope for a terminal Compute receipt. It contains only
 * immutable economic identifiers and the already-persisted actual amount.
 */
export interface ComputeCapacitySettlementIntentV1 {
  k: typeof COMPUTE_CAPACITY_SETTLEMENT_INTENT_KIND;
  v: typeof COMPUTE_CAPACITY_SETTLEMENT_INTENT_VERSION;
  /** Compute run id. */
  n: string;
  /** Payer user id. */
  u: string;
  /** Compute receipt id. */
  p: string;
  /** Account-capacity reservation id. */
  r: string;
  /** Full actual Compute Light; may exceed the conservative lease reserve. */
  a: number;
}

interface QueueProducer {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<void>;
}

export interface ComputeCapacitySettlementDeps extends ComputeDatabaseDeps {
  settle?: typeof settleComputeCapacityReservation;
  queue?: QueueProducer | null;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function buildComputeCapacitySettlementIntent(
  input: ComputeCapacitySettlementInput,
): ComputeCapacitySettlementIntentV1 {
  if (
    !validUuid(input.runId) || !validUuid(input.userId) ||
    !validUuid(input.receiptId) || !validUuid(input.reservationId)
  ) {
    throw new Error("Compute capacity settlement identifiers must be UUIDs");
  }
  if (!finiteNonNegative(input.actualLight)) {
    throw new Error("Compute capacity settlement amount must be finite and non-negative");
  }
  const intent: ComputeCapacitySettlementIntentV1 = {
    k: COMPUTE_CAPACITY_SETTLEMENT_INTENT_KIND,
    v: COMPUTE_CAPACITY_SETTLEMENT_INTENT_VERSION,
    n: input.runId.toLowerCase(),
    u: input.userId.toLowerCase(),
    p: input.receiptId.toLowerCase(),
    r: input.reservationId.toLowerCase(),
    a: input.actualLight,
  };
  if (encodedBytes(intent) > MAX_COMPUTE_CAPACITY_SETTLEMENT_INTENT_BYTES) {
    throw new Error("Compute capacity settlement intent exceeds its safe queue bound");
  }
  return intent;
}

export function isComputeCapacitySettlementIntentEnvelope(
  body: unknown,
): boolean {
  return !!body && typeof body === "object" &&
    (body as Record<string, unknown>).k ===
      COMPUTE_CAPACITY_SETTLEMENT_INTENT_KIND;
}

export function parseComputeCapacitySettlementIntent(
  body: unknown,
): ComputeCapacitySettlementIntentV1 | null {
  if (!isComputeCapacitySettlementIntentEnvelope(body)) return null;
  const value = body as Record<string, unknown>;
  if (
    value.v !== COMPUTE_CAPACITY_SETTLEMENT_INTENT_VERSION ||
    !validUuid(value.n) || !validUuid(value.u) || !validUuid(value.p) ||
    !validUuid(value.r) || !finiteNonNegative(value.a) ||
    encodedBytes(body) > MAX_COMPUTE_CAPACITY_SETTLEMENT_INTENT_BYTES
  ) return null;
  return {
    k: COMPUTE_CAPACITY_SETTLEMENT_INTENT_KIND,
    v: COMPUTE_CAPACITY_SETTLEMENT_INTENT_VERSION,
    n: value.n.toLowerCase(),
    u: value.u.toLowerCase(),
    p: value.p.toLowerCase(),
    r: value.r.toLowerCase(),
    a: value.a,
  };
}

export function computeCapacitySettlementInputFromIntent(
  intent: ComputeCapacitySettlementIntentV1,
): ComputeCapacitySettlementInput {
  return {
    runId: intent.n,
    userId: intent.u,
    receiptId: intent.p,
    reservationId: intent.r,
    actualLight: intent.a,
  };
}

/** Invoke the exact, idempotent Compute capacity true-up RPC. */
export async function settleComputeCapacityReservation(
  input: ComputeCapacitySettlementInput,
  deps: ComputeDatabaseDeps = {},
): Promise<void> {
  const intent = buildComputeCapacitySettlementIntent(input);
  const payload = await callComputeRpc("settle_compute_capacity_reservation", {
    p_run_id: intent.n,
    p_user_id: intent.u,
    p_receipt_id: intent.p,
    p_capacity_reservation_id: intent.r,
    p_actual_light: intent.a,
  }, deps);
  const row = firstComputeRow(payload, "Settle Compute capacity reservation");
  if (
    requiredString(row, "run_id", "Settle Compute capacity reservation") !==
      intent.n ||
    requiredString(row, "receipt_id", "Settle Compute capacity reservation") !==
      intent.p ||
    requiredString(
      row,
      "capacity_reservation_id",
      "Settle Compute capacity reservation",
    ) !== intent.r ||
    requiredString(
      row,
      "capacity_settlement_status",
      "Settle Compute capacity reservation",
    ) !== "settled"
  ) {
    throw new Error("Compute capacity settlement returned a mismatched receipt");
  }
}

/**
 * Direct-first settlement with a durable handoff to the existing capacity
 * telemetry Queue. Queue absence or send failure is unsafe and fails closed.
 */
export async function settleOrDeferComputeCapacity(
  input: ComputeCapacitySettlementInput,
  deps: ComputeCapacitySettlementDeps = {},
): Promise<{ deferred: boolean }> {
  const intent = buildComputeCapacitySettlementIntent(input);
  const settle = deps.settle ?? settleComputeCapacityReservation;
  try {
    await settle(computeCapacitySettlementInputFromIntent(intent), deps);
    return { deferred: false };
  } catch (directError) {
    const queue = deps.queue === undefined
      ? getCapacityTelemetryQueue()
      : deps.queue;
    if (!queue) {
      console.error("[COMPUTE-CAPACITY-SETTLEMENT-ALARM] Recovery unavailable", {
        run_id: intent.n,
        receipt_id: intent.p,
        reservation_id: intent.r,
        direct_error: directError instanceof Error
          ? directError.message
          : String(directError),
      });
      throw new Error("Compute capacity settlement could not be persisted safely");
    }
    try {
      await queue.send(intent);
    } catch (queueError) {
      console.error("[COMPUTE-CAPACITY-SETTLEMENT-ALARM] Recovery enqueue failed", {
        run_id: intent.n,
        receipt_id: intent.p,
        reservation_id: intent.r,
        direct_error: directError instanceof Error
          ? directError.message
          : String(directError),
        queue_error: queueError instanceof Error
          ? queueError.message
          : String(queueError),
      });
      throw new Error("Compute capacity settlement could not be persisted safely");
    }
    console.error("[COMPUTE-CAPACITY-SETTLEMENT-ALARM] Settlement safely deferred", {
      run_id: intent.n,
      receipt_id: intent.p,
      reservation_id: intent.r,
      intent_version: intent.v,
    });
    return { deferred: true };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Settle the receipt nested in any terminal Compute RPC result. This seam is
 * shared by Worker completion, owner cancellation, DLQ, and stale-run repair.
 */
export async function settleComputeCapacityFromTerminalPayload(
  payload: unknown,
  deps: ComputeCapacitySettlementDeps = {},
): Promise<{ applicable: boolean; deferred: boolean }> {
  const row = record(Array.isArray(payload) ? payload[0] : payload);
  const receipt = record(row?.receipt);
  if (!receipt || receipt.billing_mode !== "subscription_capacity") {
    return { applicable: false, deferred: false };
  }
  if (receipt.capacity_settlement_status === "not_applicable") {
    if (
      receipt.capacity_reservation_id !== null &&
      receipt.capacity_reservation_id !== undefined
    ) {
      throw new Error(
        "Subscription Compute receipt has inconsistent capacity backing",
      );
    }
    // Subscription attribution is fixed at admission, but a cancellation or
    // policy revocation can terminalize before lease preparation. No capacity
    // reservation exists in that case, so there is nothing to settle.
    return { applicable: false, deferred: false };
  }
  if (receipt.capacity_settlement_status === "settled") {
    return { applicable: true, deferred: false };
  }
  if (receipt.capacity_settlement_status !== "pending") {
    throw new Error("Subscription Compute receipt has no settleable capacity state");
  }
  const actualLight = typeof receipt.actual_light === "number"
    ? receipt.actual_light
    : Number(receipt.actual_light);
  const result = await settleOrDeferComputeCapacity({
    runId: String(receipt.run_id ?? ""),
    userId: String(receipt.user_id ?? ""),
    receiptId: String(receipt.id ?? ""),
    reservationId: String(receipt.capacity_reservation_id ?? ""),
    actualLight,
  }, deps);
  if (!result.deferred) receipt.capacity_settlement_status = "settled";
  return { applicable: true, deferred: result.deferred };
}
