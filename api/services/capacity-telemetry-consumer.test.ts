import {
  parseCapacityCpuObservation,
  processCapacityTelemetryMessage,
} from "./capacity-telemetry-consumer.ts";
import { buildCapacitySettlementIntent } from "./capacity-settlement-recovery.ts";
import { buildComputeCapacitySettlementIntent } from "./compute/capacity-settlement.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const RECEIPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

Deno.test("capacity CPU consumer validates exact Tail observation contract", () => {
  assertEquals(
    parseCapacityCpuObservation({
      version: 1,
      receiptId: RECEIPT,
      cpuTimeMs: 4,
      wallTimeMs: 120_000,
      observedAt: "2026-07-18T00:00:00.000Z",
      source: "cloudflare_tail_parent",
    }),
    {
      version: 1,
      receiptId: RECEIPT,
      cpuTimeMs: 4,
      wallTimeMs: 120_000,
      observedAt: "2026-07-18T00:00:00.000Z",
      source: "cloudflare_tail_parent",
    },
  );
});

Deno.test("capacity CPU consumer drops poison messages without a retry loop", async () => {
  assertEquals(
    await processCapacityTelemetryMessage({
      version: 1,
      receiptId: "not-a-receipt",
      cpuTimeMs: 1,
      wallTimeMs: 1,
      observedAt: new Date().toISOString(),
      source: "cloudflare_dynamic_tail",
    }),
    "ack",
  );
});

Deno.test("capacity CPU parser preserves wall time as diagnostic-only data", () => {
  const parsed = parseCapacityCpuObservation({
    version: 1,
    receiptId: RECEIPT,
    cpuTimeMs: 2,
    wallTimeMs: 300_000,
    observedAt: "2026-07-18T00:00:00.000Z",
    source: "cloudflare_dynamic_tail",
  });
  assertEquals(parsed?.cpuTimeMs, 2);
  assertEquals(parsed?.wallTimeMs, 300_000);
});

Deno.test("capacity CPU consumer ACKs an observation durably stored as pending", async () => {
  let ingested = false;
  const outcome = await processCapacityTelemetryMessage({
    version: 1,
    receiptId: RECEIPT,
    cpuTimeMs: 2,
    wallTimeMs: 300_000,
    observedAt: "2026-07-18T00:00:00.000Z",
    source: "cloudflare_dynamic_tail",
  }, {
    ingestObservation: async (input) => {
      ingested = true;
      assertEquals(input.receiptId, RECEIPT);
      assertEquals(input.final, true);
      return {
        observationId: "capacity_cpu:pending",
        applicationStatus: "pending",
        settlementId: null,
        eventId: null,
        inserted: true,
        settlementStatus: null,
        cpuTimeMs: input.cpuTimeMs,
        wallTimeMs: input.wallTimeMs ?? null,
        cpuLight: 0,
        totalLight: 0,
        attempts: 0,
        nextAttemptAt: "2026-07-18T00:00:02.000Z",
        lastError: null,
      };
    },
  });
  assertEquals(ingested, true);
  assertEquals(outcome, "ack");
});

Deno.test("capacity CPU consumer retries only when durable ingest fails", async () => {
  const outcome = await processCapacityTelemetryMessage({
    version: 1,
    receiptId: RECEIPT,
    cpuTimeMs: 2,
    wallTimeMs: 4,
    observedAt: "2026-07-18T00:00:00.000Z",
    source: "cloudflare_tail_parent",
  }, {
    ingestObservation: () => Promise.reject(new Error("database unavailable")),
  });
  assertEquals(outcome, "retry");
});

const SETTLEMENT_INTENT = buildCapacitySettlementIntent({
  reservationId: "00000000-0000-4000-8000-000000000201",
  userId: "00000000-0000-4000-8000-000000000202",
  receiptId: "00000000-0000-4000-8000-000000000203",
  executionId: "00000000-0000-4000-8000-000000000204",
  executedAt: "2026-07-17T23:59:59.500Z",
  resourceFacts: [{
    resource: "d1_read",
    units: 5,
    cloudUnits: 0.5,
    amountLight: 0.05,
  }],
  workerRequestCount: 2,
  dynamicWorkerIdentityCreated: true,
  dynamicWorkerInvoked: true,
  reuseKeyHash: "b".repeat(64),
  billingConfig: {
    version: 3,
    workerMsPerCloudUnit: 10,
    cloudUnitLightPer1k: 2,
    workerRequestLightPerInvocation: 0.003,
    workerLoadLightPerInvocation: 0.04,
  },
  surface: "mcp",
});

Deno.test("capacity telemetry consumer settles a deferred intent idempotently", async () => {
  let receiptId: string | undefined;
  const outcome = await processCapacityTelemetryMessage(SETTLEMENT_INTENT, {
    settleResources: (input) => {
      receiptId = input.receiptId;
      return Promise.resolve({
        settlementId: "00000000-0000-4000-8000-000000000205",
        reservationId: input.reservationId,
        status: "pending_cpu",
        immediateLight: 0.1,
        operationLight: 0.05,
        workerRequestLight: 0.01,
        dynamicWorkerLight: 0.04,
        cpuLight: 0,
        totalLight: 0.1,
        dynamicWorkerCharged: true,
        billingConfigVersion: 3,
      });
    },
    reconcileAttribution: () =>
      Promise.resolve({
        reconciled: true,
        totalLight: 0.1,
        deltaLight: 0.1,
      }),
  });
  assertEquals(receiptId, SETTLEMENT_INTENT.p);
  assertEquals(outcome, "ack");
});

Deno.test("capacity telemetry consumer retries a transient deferred settlement failure", async () => {
  const outcome = await processCapacityTelemetryMessage(SETTLEMENT_INTENT, {
    settleResources: () => Promise.reject(new Error("database unavailable")),
  });
  assertEquals(outcome, "retry");
});

Deno.test("capacity telemetry consumer retries until deferred receipt attribution is durable", async () => {
  const outcome = await processCapacityTelemetryMessage(SETTLEMENT_INTENT, {
    settleResources: (input) =>
      Promise.resolve({
        settlementId: "00000000-0000-4000-8000-000000000205",
        reservationId: input.reservationId,
        status: "pending_cpu",
        immediateLight: 0.1,
        operationLight: 0.05,
        workerRequestLight: 0.01,
        dynamicWorkerLight: 0.04,
        cpuLight: 0,
        totalLight: 0.1,
        dynamicWorkerCharged: true,
        billingConfigVersion: 3,
      }),
    reconcileAttribution: () =>
      Promise.resolve({
        reconciled: false,
        totalLight: 0.1,
        deltaLight: 0,
      }),
  });
  assertEquals(outcome, "retry");
});

Deno.test("capacity telemetry consumer drops a malformed recognized settlement intent", async () => {
  const outcome = await processCapacityTelemetryMessage({
    ...SETTLEMENT_INTENT,
    f: [["d1_read", -1, 0, 0]],
  });
  assertEquals(outcome, "ack");
});

const COMPUTE_SETTLEMENT_INTENT = buildComputeCapacitySettlementIntent({
  runId: "00000000-0000-4000-8000-000000000301",
  userId: "00000000-0000-4000-8000-000000000302",
  receiptId: "00000000-0000-4000-8000-000000000303",
  reservationId: "00000000-0000-4000-8000-000000000304",
  actualLight: 0.25,
});

Deno.test("capacity telemetry consumer settles a Compute recovery intent without MCP attribution", async () => {
  let settled = false;
  const outcome = await processCapacityTelemetryMessage(
    COMPUTE_SETTLEMENT_INTENT,
    {
      settleCompute: (input) => {
        settled = true;
        assertEquals(input.actualLight, 0.25);
        return Promise.resolve();
      },
      reconcileAttribution: () => {
        throw new Error("Compute settlement must not use MCP attribution");
      },
    },
  );
  assertEquals(settled, true);
  assertEquals(outcome, "ack");
});

Deno.test("capacity telemetry consumer retries a transient Compute settlement failure", async () => {
  const outcome = await processCapacityTelemetryMessage(
    COMPUTE_SETTLEMENT_INTENT,
    { settleCompute: () => Promise.reject(new Error("database unavailable")) },
  );
  assertEquals(outcome, "retry");
});
