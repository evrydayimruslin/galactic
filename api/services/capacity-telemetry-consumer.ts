import {
  reconcileCapacitySettlementAttribution,
  recordObservedCapacityCpu,
  settleAccountCapacityResources,
} from "./account-capacity.ts";
import {
  capacitySettlementInputFromIntent,
  isCapacitySettlementIntentEnvelope,
  parseCapacitySettlementIntent,
} from "./capacity-settlement-recovery.ts";

type CapacityTelemetryOutcome = "ack" | "retry";

interface CapacityTelemetryConsumerDeps {
  ingestObservation?: typeof recordObservedCapacityCpu;
  settleResources?: typeof settleAccountCapacityResources;
  reconcileAttribution?: typeof reconcileCapacitySettlementAttribution;
}

interface CapacityCpuObservationV1 {
  version: 1;
  receiptId: string;
  cpuTimeMs: number;
  wallTimeMs: number;
  observedAt: string;
  source: "cloudflare_tail_parent" | "cloudflare_dynamic_tail";
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCapacityCpuObservation(
  body: unknown,
): CapacityCpuObservationV1 | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (
    value.version !== 1 ||
    (value.source !== "cloudflare_tail_parent" &&
      value.source !== "cloudflare_dynamic_tail") ||
    typeof value.receiptId !== "string" ||
    !UUID_RE.test(value.receiptId) ||
    typeof value.cpuTimeMs !== "number" ||
    !Number.isFinite(value.cpuTimeMs) || value.cpuTimeMs < 0 ||
    typeof value.wallTimeMs !== "number" ||
    !Number.isFinite(value.wallTimeMs) || value.wallTimeMs < 0 ||
    typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt))
  ) {
    return null;
  }
  return {
    version: 1,
    receiptId: value.receiptId.toLowerCase(),
    cpuTimeMs: value.cpuTimeMs,
    wallTimeMs: value.wallTimeMs,
    observedAt: value.observedAt,
    source: value.source,
  };
}

/**
 * Settle one post-invocation Cloudflare CPU observation. Malformed messages
 * are poison and are acknowledged; database/network failures are retried by
 * Queues. The SQL receipt/idempotency constraints make redelivery harmless.
 */
export async function processCapacityTelemetryMessage(
  body: unknown,
  deps: CapacityTelemetryConsumerDeps = {},
): Promise<CapacityTelemetryOutcome> {
  if (isCapacitySettlementIntentEnvelope(body)) {
    const intent = parseCapacitySettlementIntent(body);
    if (!intent) {
      console.warn(
        "[CAPACITY-SETTLEMENT] Dropping malformed settlement intent",
      );
      return "ack";
    }
    try {
      await (deps.settleResources ?? settleAccountCapacityResources)(
        capacitySettlementInputFromIntent(intent),
      );
      const attribution = await (
        deps.reconcileAttribution ?? reconcileCapacitySettlementAttribution
      )({ receiptId: intent.p, userId: intent.u });
      if (!attribution.reconciled) {
        throw new Error("Capacity receipt attribution is not ready");
      }
      return "ack";
    } catch (error) {
      console.error("[CAPACITY-SETTLEMENT] Deferred settlement retry failed", {
        receipt_id: intent.p,
        reservation_id: intent.r,
        intent_version: intent.v,
        error,
      });
      return "retry";
    }
  }

  const observation = parseCapacityCpuObservation(body);
  if (!observation) {
    console.warn("[CAPACITY-CPU] Dropping malformed Tail observation");
    return "ack";
  }
  try {
    // The backing RPC is a durable inbox, not a direct settlement-only write:
    // it persists observations even when the execution settlement has not
    // committed yet. A successfully stored `pending` observation is therefore
    // ACKed here and the minute reconciler attaches it later. Only failure to
    // durably ingest is retried by Queues.
    await (deps.ingestObservation ?? recordObservedCapacityCpu)({
      receiptId: observation.receiptId,
      cpuTimeMs: observation.cpuTimeMs,
      wallTimeMs: observation.wallTimeMs,
      observedAt: observation.observedAt,
      source: observation.source,
      final: true,
      metadata: { telemetry_version: observation.version },
    });
    return "ack";
  } catch (error) {
    console.error("[CAPACITY-CPU] Tail observation durable ingest failed", {
      receipt_id: observation.receiptId,
      error,
    });
    return "retry";
  }
}
