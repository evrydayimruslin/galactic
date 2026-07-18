import { getCapacityTelemetryQueue } from "../lib/env.ts";
import {
  type CapacityResourceSettlement,
  settleAccountCapacityResources,
  type SettleAccountCapacityResourcesInput,
} from "./account-capacity.ts";
import type { CapacityResource, CapacityResourceFact } from "./cloud-usage.ts";

const CAPACITY_SETTLEMENT_INTENT_KIND = "capacity_settlement_intent" as const;
const CAPACITY_SETTLEMENT_INTENT_VERSION = 1 as const;
// Intentionally far below Cloudflare Queues' 128 KB message ceiling.
export const MAX_CAPACITY_SETTLEMENT_INTENT_BYTES = 16 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const RESOURCE_TYPES: readonly CapacityResource[] = [
  "worker_cpu",
  "worker_request",
  "dynamic_worker_identity",
  "r2_operation",
  "kv_operation",
  "d1_read",
  "d1_write",
  "widget_pull",
  "queue_operation",
  "other",
];
const RESOURCE_TYPE_SET = new Set<string>(RESOURCE_TYPES);

type CompactResourceFact = readonly [
  resource: CapacityResource,
  units: number,
  cloudUnits: number,
  amountLight: number,
];

/**
 * Compact, internal-only recovery message. Field names are intentionally
 * short because this can be written on a degraded post-execution path. It
 * contains economic facts and identifiers only: never inputs, outputs, logs,
 * credentials, arbitrary metadata, or tenant environment values.
 */
interface CapacitySettlementIntentV1 {
  k: typeof CAPACITY_SETTLEMENT_INTENT_KIND;
  v: typeof CAPACITY_SETTLEMENT_INTENT_VERSION;
  /** reservation id */
  r: string;
  /** payer user id */
  u: string;
  /** execution receipt id */
  p: string;
  /** execution id */
  x: string | null;
  /** execution/Loader-attempt instant (ISO-8601), pinned across durable replay */
  t: string;
  /** resource facts, aggregated to at most one tuple per resource */
  f: CompactResourceFact[];
  /** billable Worker requests */
  q: number;
  /** whether the Dynamic Worker invocation was attempted */
  d: boolean;
  /** whether Loader returned a potentially billable Dynamic Worker identity */
  i: boolean;
  /** stable Dynamic Worker identity hash, when reuse was used */
  h: string | null;
  /** billing config: version, ms/unit, Light/1k, request Light, load Light */
  b: readonly [number, number, number, number, number];
  /** allowlisted execution surface */
  s: CapacitySettlementSurface;
}

type CapacitySettlementSurface = "run" | "http" | "mcp";

interface RecoverableCapacitySettlementInput {
  reservationId: string;
  userId: string;
  receiptId: string;
  executionId?: string | null;
  executedAt: string;
  resourceFacts?: CapacityResourceFact[];
  workerRequestCount: number;
  dynamicWorkerIdentityCreated: boolean;
  dynamicWorkerInvoked: boolean;
  reuseKeyHash?: string | null;
  billingConfig: NonNullable<
    SettleAccountCapacityResourcesInput["billingConfig"]
  >;
  surface: CapacitySettlementSurface;
}

interface RecoverableCapacitySettlementResult {
  settlement: CapacityResourceSettlement | null;
  deferred: boolean;
}

/** A reservation is releasable only while no tenant invocation was attempted. */
export function shouldReleaseUnstartedCapacityReservation(
  tenantExecutionAttempted: boolean,
): boolean {
  return tenantExecutionAttempted === false;
}

/**
 * Cloudflare bills the public/root API request and the Dynamic Worker request.
 * A nested Agent call reaches MCP over a same-account Service Binding, so only
 * its Dynamic Worker request is billable on that lifecycle.
 */
export function countCapacityWorkerRequests(input: {
  dynamicWorkerInvoked: boolean;
  nestedServiceBinding?: boolean;
}): number {
  return (input.nestedServiceBinding === true ? 0 : 1) +
    (input.dynamicWorkerInvoked ? 1 : 0);
}

interface QueueProducer {
  send(body: unknown, options?: { delaySeconds?: number }): Promise<void>;
}

interface CapacitySettlementRecoveryDeps {
  settle?: typeof settleAccountCapacityResources;
  queue?: QueueProducer | null;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function compactResourceFacts(
  facts: CapacityResourceFact[] | undefined,
): CompactResourceFact[] {
  const byResource = new Map<CapacityResource, [number, number, number]>();
  for (const fact of facts ?? []) {
    if (
      !RESOURCE_TYPE_SET.has(fact.resource) ||
      !finiteNonNegative(fact.units) ||
      !finiteNonNegative(fact.cloudUnits) ||
      !finiteNonNegative(fact.amountLight)
    ) {
      throw new Error("Capacity settlement contains an invalid resource fact");
    }
    const current = byResource.get(fact.resource) ?? [0, 0, 0];
    current[0] += fact.units;
    current[1] += fact.cloudUnits;
    current[2] += fact.amountLight;
    if (!current.every(Number.isFinite)) {
      throw new Error("Capacity settlement resource totals are not finite");
    }
    byResource.set(fact.resource, current);
  }
  return RESOURCE_TYPES.flatMap((resource) => {
    const values = byResource.get(resource);
    return values
      ? [[resource, values[0], values[1], values[2]] as CompactResourceFact]
      : [];
  });
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

export function buildCapacitySettlementIntent(
  input: RecoverableCapacitySettlementInput,
): CapacitySettlementIntentV1 {
  if (
    !validId(input.reservationId) || !validId(input.userId) ||
    !validId(input.receiptId) ||
    (input.executionId != null && !validId(input.executionId))
  ) {
    throw new Error("Capacity settlement identifiers must be UUIDs");
  }
  if (!finiteNonNegative(input.workerRequestCount)) {
    throw new Error("Capacity settlement Worker request count is invalid");
  }
  if (!Number.isSafeInteger(input.workerRequestCount)) {
    throw new Error(
      "Capacity settlement Worker request count is not an integer",
    );
  }
  const executedAt = canonicalTimestamp(input.executedAt);
  if (!executedAt) {
    throw new Error("Capacity settlement execution timestamp is invalid");
  }
  if (
    input.reuseKeyHash != null && input.reuseKeyHash !== "" &&
    !SHA256_RE.test(input.reuseKeyHash)
  ) {
    throw new Error("Capacity settlement reuse key hash is invalid");
  }
  const config = input.billingConfig;
  const billing = [
    config.version,
    config.workerMsPerCloudUnit,
    config.cloudUnitLightPer1k,
    config.workerRequestLightPerInvocation,
    config.workerLoadLightPerInvocation,
  ] as const;
  if (
    !Number.isInteger(billing[0]) || billing[0] < 1 ||
    billing.slice(1).some((value) => !finiteNonNegative(value))
  ) {
    throw new Error("Capacity settlement billing config is invalid");
  }
  const intent: CapacitySettlementIntentV1 = {
    k: CAPACITY_SETTLEMENT_INTENT_KIND,
    v: CAPACITY_SETTLEMENT_INTENT_VERSION,
    r: input.reservationId.toLowerCase(),
    u: input.userId.toLowerCase(),
    p: input.receiptId.toLowerCase(),
    x: input.executionId?.toLowerCase() || null,
    t: executedAt,
    f: compactResourceFacts(input.resourceFacts),
    q: input.workerRequestCount,
    d: input.dynamicWorkerInvoked,
    i: input.dynamicWorkerIdentityCreated,
    h: input.reuseKeyHash?.toLowerCase() || null,
    b: billing,
    s: input.surface,
  };
  if (encodedBytes(intent) > MAX_CAPACITY_SETTLEMENT_INTENT_BYTES) {
    throw new Error("Capacity settlement intent exceeds its safe queue bound");
  }
  return intent;
}

export function isCapacitySettlementIntentEnvelope(
  body: unknown,
): boolean {
  return !!body && typeof body === "object" &&
    (body as Record<string, unknown>).k === CAPACITY_SETTLEMENT_INTENT_KIND;
}

export function parseCapacitySettlementIntent(
  body: unknown,
): CapacitySettlementIntentV1 | null {
  if (!isCapacitySettlementIntentEnvelope(body)) return null;
  const value = body as Record<string, unknown>;
  if (
    value.v !== CAPACITY_SETTLEMENT_INTENT_VERSION ||
    !validId(value.r) || !validId(value.u) || !validId(value.p) ||
    (value.x !== null && !validId(value.x)) ||
    canonicalTimestamp(value.t) === null ||
    !Array.isArray(value.f) || value.f.length > RESOURCE_TYPES.length ||
    !finiteNonNegative(value.q) || !Number.isSafeInteger(value.q) ||
    typeof value.d !== "boolean" ||
    typeof value.i !== "boolean" || (value.d === true && value.i !== true) ||
    (value.h !== null &&
      (typeof value.h !== "string" || !SHA256_RE.test(value.h))) ||
    !Array.isArray(value.b) || value.b.length !== 5 ||
    !Number.isInteger(value.b[0]) || Number(value.b[0]) < 1 ||
    value.b.slice(1).some((entry) => !finiteNonNegative(entry)) ||
    (value.s !== "run" && value.s !== "http" && value.s !== "mcp") ||
    encodedBytes(body) > MAX_CAPACITY_SETTLEMENT_INTENT_BYTES
  ) {
    return null;
  }
  const seen = new Set<string>();
  const facts: CompactResourceFact[] = [];
  for (const raw of value.f) {
    if (
      !Array.isArray(raw) || raw.length !== 4 ||
      typeof raw[0] !== "string" || !RESOURCE_TYPE_SET.has(raw[0]) ||
      seen.has(raw[0]) || !finiteNonNegative(raw[1]) ||
      !finiteNonNegative(raw[2]) || !finiteNonNegative(raw[3])
    ) {
      return null;
    }
    seen.add(raw[0]);
    facts.push([
      raw[0] as CapacityResource,
      raw[1],
      raw[2],
      raw[3],
    ]);
  }
  return {
    k: CAPACITY_SETTLEMENT_INTENT_KIND,
    v: CAPACITY_SETTLEMENT_INTENT_VERSION,
    r: (value.r as string).toLowerCase(),
    u: (value.u as string).toLowerCase(),
    p: (value.p as string).toLowerCase(),
    x: value.x === null ? null : (value.x as string).toLowerCase(),
    t: canonicalTimestamp(value.t)!,
    f: facts,
    q: value.q as number,
    d: value.d as boolean,
    i: value.i as boolean,
    h: value.h === null ? null : (value.h as string).toLowerCase(),
    b: [
      value.b[0] as number,
      value.b[1] as number,
      value.b[2] as number,
      value.b[3] as number,
      value.b[4] as number,
    ],
    s: value.s as CapacitySettlementSurface,
  };
}

export function capacitySettlementInputFromIntent(
  intent: CapacitySettlementIntentV1,
): SettleAccountCapacityResourcesInput {
  return {
    reservationId: intent.r,
    userId: intent.u,
    receiptId: intent.p,
    executionId: intent.x,
    executedAt: intent.t,
    resourceFacts: intent.f.map((
      [resource, units, cloudUnits, amountLight],
    ) => ({
      resource,
      units,
      cloudUnits,
      amountLight,
    })),
    workerRequestCount: intent.q,
    dynamicWorkerIdentityCreated: intent.i,
    dynamicWorkerInvoked: intent.d,
    reuseKeyHash: intent.h,
    billingConfig: {
      version: intent.b[0],
      workerMsPerCloudUnit: intent.b[1],
      cloudUnitLightPer1k: intent.b[2],
      workerRequestLightPerInvocation: intent.b[3],
      workerLoadLightPerInvocation: intent.b[4],
    },
    metadata: {
      surface: intent.s,
      settlement_intent_version: intent.v,
    },
  };
}

/**
 * Direct-first post-execution settlement. If the database path is degraded,
 * a successful Queue send is the durable handoff and the user-facing result
 * may still complete. Queue absence/failure is not safe and therefore rejects.
 */
export async function settleOrDeferCapacityAfterExecution(
  input: RecoverableCapacitySettlementInput,
  deps: CapacitySettlementRecoveryDeps = {},
): Promise<RecoverableCapacitySettlementResult> {
  const intent = buildCapacitySettlementIntent(input);
  const settle = deps.settle ?? settleAccountCapacityResources;
  try {
    const settlement = await settle(capacitySettlementInputFromIntent(intent));
    return { settlement, deferred: false };
  } catch (directError) {
    const queue = deps.queue === undefined
      ? getCapacityTelemetryQueue()
      : deps.queue;
    if (!queue) {
      console.error(
        "[CAPACITY-SETTLEMENT-ALARM] Durable recovery unavailable",
        {
          receipt_id: intent.p,
          reservation_id: intent.r,
          surface: intent.s,
          settlement_deferred: false,
          direct_error: directError instanceof Error
            ? directError.message
            : String(directError),
        },
      );
      throw new Error("Capacity settlement could not be persisted safely");
    }
    try {
      await queue.send(intent);
    } catch (queueError) {
      console.error(
        "[CAPACITY-SETTLEMENT-ALARM] Durable recovery enqueue failed",
        {
          receipt_id: intent.p,
          reservation_id: intent.r,
          surface: intent.s,
          settlement_deferred: false,
          direct_error: directError instanceof Error
            ? directError.message
            : String(directError),
          queue_error: queueError instanceof Error
            ? queueError.message
            : String(queueError),
        },
      );
      throw new Error("Capacity settlement could not be persisted safely");
    }
    console.error("[CAPACITY-SETTLEMENT-ALARM] Settlement safely deferred", {
      receipt_id: intent.p,
      reservation_id: intent.r,
      surface: intent.s,
      settlement_deferred: true,
      intent_version: intent.v,
      direct_error: directError instanceof Error
        ? directError.message
        : String(directError),
    });
    return { settlement: null, deferred: true };
  }
}
