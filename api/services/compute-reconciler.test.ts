import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  runComputeReconciliationCycle,
} from "./compute-reconciler.ts";
import type {
  ComputeTerminalizationIdentity,
  StaleComputeRunCandidate,
} from "./compute/reconciliation.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function candidate(
  overrides: Partial<StaleComputeRunCandidate> = {},
): StaleComputeRunCandidate {
  return {
    runId: RUN_ID,
    userId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    callerFunction: "develop",
    state: "running",
    stateVersion: "4",
    claimId: "44444444-4444-4444-8444-444444444444",
    leaseId: "55555555-5555-4555-8555-555555555555",
    containerId: `run-${RUN_ID}`,
    expiresAt: "2026-07-19T23:00:00.000Z",
    claimExpiresAt: "2026-07-19T23:00:00.000Z",
    stopRequestedAt: null,
    stopReason: null,
    requiresBodyDestroy: true,
    ...overrides,
  };
}

function terminal(): ComputeTerminalizationIdentity {
  return {
    runId: RUN_ID,
    userId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    callerFunction: "develop",
    outcome: "expired",
    reason: "compute_lease_expired",
    receiptId: "66666666-6666-4666-8666-666666666666",
    replayed: false,
  };
}

Deno.test("Compute reconciler fences, destroys, then terminalizes", async () => {
  const events: string[] = [];
  const original = candidate();
  const fenced = candidate({
    stateVersion: "5",
    stopRequestedAt: "2026-07-20T00:00:00.000Z",
    stopReason: "compute_lease_expired",
  });
  const result = await runComputeReconciliationCycle({}, {
    now: () => new Date("2026-07-20T00:00:00.000Z"),
    listPendingCapacity: () => Promise.resolve([]),
    list: () => Promise.resolve([original]),
    fence: () => {
      events.push("fence");
      return Promise.resolve({ terminal: false as const, candidate: fenced, replayed: false });
    },
    destroy: () => {
      events.push("destroy");
      return Promise.resolve();
    },
    terminalize: (input) => {
      events.push(`terminal:${input.expectedStateVersion}:${input.bodyDestroyed}`);
      return Promise.resolve(terminal());
    },
    notify: () => {
      events.push("notify");
      return Promise.resolve();
    },
  });
  assertEquals(events, ["fence", "destroy", "terminal:5:true", "notify"]);
  assertEquals(result, {
    candidates: 1,
    terminalized: 1,
    failed: 0,
    capacityPending: 0,
    capacitySettled: 0,
    capacityFailed: 0,
  });
});

Deno.test("Compute reconciler never settles after body destruction failure", async () => {
  let terminalCalls = 0;
  const original = candidate();
  const result = await runComputeReconciliationCycle({}, {
    list: () => Promise.resolve([original]),
    listPendingCapacity: () => Promise.resolve([]),
    fence: () =>
      Promise.resolve({ terminal: false as const, candidate: original, replayed: true }),
    destroy: () => Promise.reject(new Error("destroy failed")),
    terminalize: () => {
      terminalCalls++;
      return Promise.resolve(terminal());
    },
    notify: () => Promise.resolve(),
  });
  assertEquals(terminalCalls, 0);
  assertEquals(result, {
    candidates: 1,
    terminalized: 0,
    failed: 1,
    capacityPending: 0,
    capacitySettled: 0,
    capacityFailed: 0,
  });
});

Deno.test("Compute reconciler terminalizes unclaimed expiry without body destroy", async () => {
  const events: string[] = [];
  const original = candidate({
    state: "admitted",
    stateVersion: "1",
    claimId: null,
    containerId: null,
    claimExpiresAt: null,
    requiresBodyDestroy: false,
  });
  const fenced = candidate({
    ...original,
    stateVersion: "2",
    stopRequestedAt: "2026-07-20T00:00:00.000Z",
  });
  const result = await runComputeReconciliationCycle({}, {
    list: () => Promise.resolve([original]),
    listPendingCapacity: () => Promise.resolve([]),
    fence: () =>
      Promise.resolve({ terminal: false as const, candidate: fenced, replayed: false }),
    destroy: () => {
      events.push("destroy");
      return Promise.resolve();
    },
    terminalize: (input) => {
      events.push(`terminal:${input.bodyDestroyed}`);
      return Promise.resolve(terminal());
    },
    notify: () => Promise.resolve(),
  });
  assertEquals(events, ["terminal:false"]);
  assertEquals(result.terminalized, 1);
});

Deno.test("Compute reconciler never destroys or settles a foreign stop fence", async () => {
  let destroyCalls = 0;
  let terminalCalls = 0;
  const result = await runComputeReconciliationCycle({}, {
    list: () => Promise.resolve([candidate()]),
    listPendingCapacity: () => Promise.resolve([]),
    fence: () =>
      Promise.resolve({
        terminal: false as const,
        skipped: true as const,
        reason: "foreign_stop_fence" as const,
      }),
    destroy: () => {
      destroyCalls += 1;
      return Promise.resolve();
    },
    terminalize: () => {
      terminalCalls += 1;
      return Promise.resolve(terminal());
    },
  });
  assertEquals(destroyCalls, 0);
  assertEquals(terminalCalls, 0);
  assertEquals(result, {
    candidates: 1,
    terminalized: 0,
    failed: 0,
    capacityPending: 0,
    capacitySettled: 0,
    capacityFailed: 0,
  });
});

Deno.test("Compute reconciler repairs durable pending capacity receipts after Queue exhaustion", async () => {
  const settlement = {
    runId: RUN_ID,
    userId: "22222222-2222-4222-8222-222222222222",
    receiptId: "66666666-6666-4666-8666-666666666666",
    reservationId: "77777777-7777-4777-8777-777777777777",
    actualLight: 0.25,
  };
  let settled: unknown;
  const result = await runComputeReconciliationCycle({}, {
    listPendingCapacity: () => Promise.resolve([settlement]),
    settlePendingCapacity: (value) => {
      settled = value;
      return Promise.resolve();
    },
    list: () => Promise.resolve([]),
  });
  assertEquals(settled, settlement);
  assertEquals(result, {
    candidates: 0,
    terminalized: 0,
    failed: 0,
    capacityPending: 1,
    capacitySettled: 1,
    capacityFailed: 0,
  });
});
