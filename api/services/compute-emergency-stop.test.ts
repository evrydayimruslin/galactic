import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  type ComputeEmergencyStopBatch,
  ComputeEmergencyStopError,
  releaseComputeEmergencyStop,
  runComputeEmergencyStop,
} from "./compute-emergency-stop.ts";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const CLAIMED_RUN_ID = "44444444-4444-4444-8444-444444444444";
const QUEUED_RUN_ID = "55555555-5555-4555-8555-555555555555";
const CUTOFF = "2026-07-20T12:00:00.000Z";

function batch(
  targets: ComputeEmergencyStopBatch["targets"],
  status: "active" | "completed" = "active",
): ComputeEmergencyStopBatch {
  return {
    operationId: OPERATION_ID,
    status,
    cutoffAt: CUTOFF,
    targetCount: targets.length,
    terminalizedCount: status === "completed" ? 2 : 0,
    targets,
    initializing: false,
    replayed: false,
  };
}

function target(
  runId: string,
  state: ComputeEmergencyStopBatch["targets"][number]["state"],
  requiresBodyDestroy: boolean,
): ComputeEmergencyStopBatch["targets"][number] {
  return {
    runId,
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "main",
    state,
    stateVersion: "4",
    requiresBodyDestroy,
    attemptCount: 0,
    lastErrorCode: null,
  };
}

Deno.test("Compute emergency stop destroys claimed bodies before normal cancellation settlement", async () => {
  const targetEvents = new Map<string, string[]>();
  const events = (runId: string) => {
    const existing = targetEvents.get(runId) ?? [];
    targetEvents.set(runId, existing);
    return existing;
  };
  const batches = [
    batch([
      target(CLAIMED_RUN_ID, "running", true),
      target(QUEUED_RUN_ID, "queued", false),
    ]),
    batch([], "completed"),
  ];
  let fenceCalls = 0;
  const result = await runComputeEmergencyStop({
    operationId: OPERATION_ID,
    operatorReference: "pagerduty:INC-42",
    reason: "suspected image compromise",
  }, {
    env: { COMPUTE_ENABLED: "0" },
    fenceBatch: (input) => {
      assertEquals(input.requestHash.length, 64);
      return Promise.resolve(batches[fenceCalls++]);
    },
    destroy: (runId) => {
      events(runId).push("destroy");
      return Promise.resolve();
    },
    terminalize: (input) => {
      events(input.runId).push(`terminalize:${input.bodyDestroyed}`);
      return Promise.resolve({});
    },
    completeTarget: (input) => {
      events(input.runId).push(`audit:${input.bodyDestroyed}`);
      return Promise.resolve();
    },
    recordFailure: () => Promise.resolve(),
  });

  assertEquals(result.status, "completed");
  assertEquals(result.processedThisRequest, 2);
  assertEquals(events(CLAIMED_RUN_ID), [
    "destroy",
    "terminalize:true",
    "audit:true",
  ]);
  assertEquals(events(QUEUED_RUN_ID), [
    "terminalize:false",
    "audit:false",
  ]);
});

Deno.test("Compute emergency stop initialization does not consume a processing batch", async () => {
  let fenceCalls = 0;
  const result = await runComputeEmergencyStop({
    operationId: OPERATION_ID,
    operatorReference: "oncall:corin",
    reason: "initialize the durable stop latch",
    maxBatches: 1,
  }, {
    env: { COMPUTE_ENABLED: "0" },
    fenceBatch: () => {
      fenceCalls += 1;
      if (fenceCalls === 1) {
        return Promise.resolve({
          ...batch([]),
          initializing: true,
        });
      }
      return Promise.resolve(batch([], "completed"));
    },
  });
  assertEquals(fenceCalls, 2);
  assertEquals(result.status, "completed");
});

Deno.test("Compute emergency stop leaves a claimed run fenced when destroy fails", async () => {
  let terminalized = false;
  const failures: Array<Record<string, unknown>> = [];
  const result = await runComputeEmergencyStop({
    operationId: OPERATION_ID,
    operatorReference: "oncall:corin",
    reason: "network containment",
    maxBatches: 1,
  }, {
    env: { COMPUTE_ENABLED: "0" },
    fenceBatch: () =>
      Promise.resolve(batch([
        target(CLAIMED_RUN_ID, "running", true),
      ])),
    destroy: () => Promise.reject(new Error("provider unavailable")),
    terminalize: () => {
      terminalized = true;
      return Promise.resolve({});
    },
    completeTarget: () => Promise.resolve(),
    recordFailure: (input) => {
      failures.push(input);
      return Promise.resolve();
    },
  });

  assertEquals(terminalized, false);
  assertEquals(result.status, "active");
  assertEquals(result.continuationRequired, true);
  assertEquals(result.failures, [{
    runId: CLAIMED_RUN_ID,
    phase: "destroy",
    errorCode: "COMPUTE_BODY_DESTRUCTION_FAILED",
  }]);
  assertEquals(failures.length, 1);
});

Deno.test("Compute emergency stop retry re-confirms destruction before auditing a terminal claimed target", async () => {
  const events: string[] = [];
  const result = await runComputeEmergencyStop({
    operationId: OPERATION_ID,
    operatorReference: "oncall:corin",
    reason: "retry after an uncertain terminal response",
    maxBatches: 1,
  }, {
    env: { COMPUTE_ENABLED: "0" },
    fenceBatch: () =>
      Promise.resolve(batch([
        target(CLAIMED_RUN_ID, "cancelled", true),
      ])),
    destroy: () => {
      events.push("destroy");
      return Promise.resolve();
    },
    terminalize: () => {
      events.push("terminalize-replay");
      return Promise.resolve({});
    },
    completeTarget: () => {
      events.push("audit");
      return Promise.resolve();
    },
    recordFailure: () => Promise.resolve(),
  });
  assertEquals(events, ["destroy", "terminalize-replay", "audit"]);
  assertEquals(result.failures, []);
  assertEquals(result.processedThisRequest, 1);
});

Deno.test("Compute emergency stop surfaces a failed durable failure audit", async () => {
  const result = await runComputeEmergencyStop({
    operationId: OPERATION_ID,
    operatorReference: "oncall:corin",
    reason: "audit dependency outage",
    maxBatches: 1,
  }, {
    env: { COMPUTE_ENABLED: "0" },
    fenceBatch: () =>
      Promise.resolve(batch([
        target(CLAIMED_RUN_ID, "running", true),
      ])),
    destroy: () => Promise.reject(new Error("provider unavailable")),
    terminalize: () => Promise.resolve({}),
    completeTarget: () => Promise.resolve(),
    recordFailure: () => Promise.reject(new Error("database unavailable")),
  });
  assertEquals(result.failures, [{
    runId: CLAIMED_RUN_ID,
    phase: "audit",
    errorCode: "COMPUTE_EMERGENCY_STOP_AUDIT_FAILED",
  }]);
});

Deno.test("Compute emergency stop refuses to conflate admission-off with execution stop", async () => {
  let fenced = false;
  const caught = await assertRejects(
    () =>
      runComputeEmergencyStop({
        operationId: OPERATION_ID,
        operatorReference: "oncall:corin",
        reason: "containment",
      }, {
        env: { COMPUTE_ENABLED: "1" },
        fenceBatch: () => {
          fenced = true;
          return Promise.resolve(batch([], "completed"));
        },
      }),
    ComputeEmergencyStopError,
  );
  assertEquals(caught.code, "COMPUTE_ADMISSION_MUST_BE_DISABLED");
  assertEquals(fenced, false);
});

Deno.test("Compute emergency stop releases its durable admission latch separately", async () => {
  let requestHash = "";
  const result = await releaseComputeEmergencyStop({
    operationId: OPERATION_ID,
    releaseIdempotencyKey: "66666666-6666-4666-8666-666666666666",
    operatorReference: "oncall:corin",
    reason: "staging recovery matrix passed",
  }, {
    env: { COMPUTE_ENABLED: "0" },
    release: (input) => {
      requestHash = input.requestHash;
      return Promise.resolve({
        id: OPERATION_ID,
        status: "released",
        replayed: false,
      });
    },
  });
  assertEquals(requestHash.length, 64);
  assertEquals(result, {
    operationId: OPERATION_ID,
    status: "released",
    replayed: false,
  });
});
