import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import type { CapacityResourceSettlement } from "./account-capacity.ts";
import {
  buildCapacitySettlementIntent,
  capacitySettlementInputFromIntent,
  countCapacityWorkerRequests,
  MAX_CAPACITY_SETTLEMENT_INTENT_BYTES,
  parseCapacitySettlementIntent,
  settleOrDeferCapacityAfterExecution,
  shouldReleaseUnstartedCapacityReservation,
} from "./capacity-settlement-recovery.ts";
import { getCapacityTelemetryQueue } from "../lib/env.ts";

const IDS = {
  reservationId: "00000000-0000-4000-8000-000000000101",
  userId: "00000000-0000-4000-8000-000000000102",
  receiptId: "00000000-0000-4000-8000-000000000103",
  executionId: "00000000-0000-4000-8000-000000000104",
  executedAt: "2026-07-17T23:59:59.500Z",
};

const BILLING = {
  version: 7,
  workerMsPerCloudUnit: 10,
  cloudUnitLightPer1k: 2,
  workerRequestLightPerInvocation: 0.003,
  workerLoadLightPerInvocation: 0.04,
};

const SETTLEMENT: CapacityResourceSettlement = {
  settlementId: "00000000-0000-4000-8000-000000000105",
  reservationId: IDS.reservationId,
  status: "pending_cpu",
  immediateLight: 1,
  operationLight: 0.5,
  workerRequestLight: 0.1,
  dynamicWorkerLight: 0.4,
  cpuLight: 0,
  totalLight: 1,
  dynamicWorkerCharged: true,
  billingConfigVersion: 7,
};

function input() {
  return {
    ...IDS,
    resourceFacts: [
      {
        resource: "d1_read" as const,
        units: 2,
        cloudUnits: 0.2,
        amountLight: 0.02,
        metadata: { credential: "must-never-enter-queue" },
      },
      {
        resource: "d1_read" as const,
        units: 3,
        cloudUnits: 0.3,
        amountLight: 0.03,
        metadata: { request_body: "also-secret" },
      },
      {
        resource: "kv_operation" as const,
        units: 1,
        cloudUnits: 0.1,
        amountLight: 0.01,
      },
    ],
    workerRequestCount: 2,
    dynamicWorkerIdentityCreated: true,
    dynamicWorkerInvoked: true,
    reuseKeyHash: "a".repeat(64),
    billingConfig: BILLING,
    surface: "mcp" as const,
  };
}

Deno.test("capacity settlement intent is bounded, secret-free, and aggregated by resource", () => {
  const intent = buildCapacitySettlementIntent(input());
  const encoded = JSON.stringify(intent);
  assert(
    new TextEncoder().encode(encoded).byteLength <
      MAX_CAPACITY_SETTLEMENT_INTENT_BYTES,
  );
  assertEquals(encoded.includes("must-never-enter-queue"), false);
  assertEquals(encoded.includes("also-secret"), false);
  assertEquals(intent.f, [
    ["kv_operation", 1, 0.1, 0.01],
    ["d1_read", 5, 0.5, 0.05],
  ]);

  const parsed = parseCapacitySettlementIntent(
    JSON.parse(encoded),
  );
  assert(parsed);
  const restored = capacitySettlementInputFromIntent(parsed);
  assertEquals(restored.resourceFacts, [
    {
      resource: "kv_operation",
      units: 1,
      cloudUnits: 0.1,
      amountLight: 0.01,
    },
    {
      resource: "d1_read",
      units: 5,
      cloudUnits: 0.5,
      amountLight: 0.05,
    },
  ]);
  assertEquals(restored.billingConfig, BILLING);
  assertEquals(restored.executedAt, IDS.executedAt);
  assertEquals(restored.metadata, {
    surface: "mcp",
    settlement_intent_version: 1,
  });
});

Deno.test("capacity settlement intent preserves repeated queue and R2 economics by aggregation", () => {
  const intent = buildCapacitySettlementIntent({
    ...input(),
    resourceFacts: [
      {
        resource: "queue_operation",
        units: 1,
        cloudUnits: 1,
        amountLight: 0.1,
      },
      {
        resource: "queue_operation",
        units: 1,
        cloudUnits: 1,
        amountLight: 0.1,
      },
      {
        resource: "queue_operation",
        units: 1,
        cloudUnits: 1,
        amountLight: 0.1,
      },
      { resource: "r2_operation", units: 1, cloudUnits: 1, amountLight: 0.4 },
      { resource: "r2_operation", units: 1, cloudUnits: 1, amountLight: 0.03 },
    ],
  });
  assertEquals(intent.f, [
    ["r2_operation", 2, 2, 0.43000000000000005],
    ["queue_operation", 3, 3, 0.30000000000000004],
  ]);
});

Deno.test("post-execution settlement uses the direct idempotent path first", async () => {
  let directCalls = 0;
  let queueCalls = 0;
  const result = await settleOrDeferCapacityAfterExecution(input(), {
    settle: (_settlementInput) => {
      directCalls += 1;
      return Promise.resolve(SETTLEMENT);
    },
    queue: {
      send: () => {
        queueCalls += 1;
        return Promise.resolve();
      },
    },
  });
  assertEquals(result, { settlement: SETTLEMENT, deferred: false });
  assertEquals(directCalls, 1);
  assertEquals(queueCalls, 0);
});

Deno.test("post-execution settlement safely defers the exact compact intent", async () => {
  let queued: unknown;
  const result = await settleOrDeferCapacityAfterExecution(input(), {
    settle: () => Promise.reject(new Error("database unavailable")),
    queue: {
      send: (body) => {
        queued = body;
        return Promise.resolve();
      },
    },
  });
  assertEquals(result, { settlement: null, deferred: true });
  const intent = parseCapacitySettlementIntent(queued);
  assert(intent);
  assertEquals(
    capacitySettlementInputFromIntent(intent).workerRequestCount,
    2,
  );
  assertEquals(
    capacitySettlementInputFromIntent(intent).dynamicWorkerInvoked,
    true,
  );
  assertEquals(
    capacitySettlementInputFromIntent(intent).dynamicWorkerIdentityCreated,
    true,
  );
});

Deno.test("post-execution settlement fails closed when durable handoff fails", async () => {
  await assertRejects(
    () =>
      settleOrDeferCapacityAfterExecution(input(), {
        settle: () => Promise.reject(new Error("database unavailable")),
        queue: {
          send: () => Promise.reject(new Error("queue unavailable")),
        },
      }),
    Error,
    "could not be persisted safely",
  );
});

Deno.test("capacity telemetry queue accessor binds send without exposing Env", async () => {
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previous = globalWithEnv.__env;
  let received: unknown;
  globalWithEnv.__env = {
    CAPACITY_TELEMETRY_QUEUE: {
      send: (body: unknown) => {
        received = body;
        return Promise.resolve();
      },
    },
  };
  try {
    const queue = getCapacityTelemetryQueue();
    assert(queue);
    await queue.send({ ok: true });
    assertEquals(received, { ok: true });
  } finally {
    globalWithEnv.__env = previous;
  }
});

Deno.test("capacity reservation release is forbidden after any tenant execution attempt", () => {
  assertEquals(shouldReleaseUnstartedCapacityReservation(false), true);
  assertEquals(shouldReleaseUnstartedCapacityReservation(true), false);
});

Deno.test("capacity Worker request facts distinguish root and nested Service Binding lifecycles", () => {
  assertEquals(
    countCapacityWorkerRequests({ dynamicWorkerInvoked: true }),
    2,
  );
  assertEquals(
    countCapacityWorkerRequests({ dynamicWorkerInvoked: false }),
    1,
  );
  assertEquals(
    countCapacityWorkerRequests({
      dynamicWorkerInvoked: true,
      nestedServiceBinding: true,
    }),
    1,
  );
  assertEquals(
    countCapacityWorkerRequests({
      dynamicWorkerInvoked: false,
      nestedServiceBinding: true,
    }),
    0,
  );
});
