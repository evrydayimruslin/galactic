import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  type ComputeEmergencyStopBatch,
  ComputeEmergencyStopError,
  getComputeEmergencyStopStatus,
  releaseComputeEmergencyStop,
  runComputeEmergencyStop,
} from "./compute-emergency-stop.ts";
import { ComputeControlPlaneError } from "./compute/database.ts";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const CLAIMED_RUN_ID = "44444444-4444-4444-8444-444444444444";
const QUEUED_RUN_ID = "55555555-5555-4555-8555-555555555555";
const CUTOFF = "2026-07-20T12:00:00.000Z";
const CREATED = "2026-07-20T11:59:59.000Z";
const UPDATED = "2026-07-20T12:01:00.000Z";
const COMPLETED = "2026-07-20T12:01:00.000Z";

function statusRow(
  latchState: "clear" | "active" | "completed",
): Record<string, unknown> {
  if (latchState === "clear") {
    return {
      schema_version: 1,
      latch_state: "clear",
      operation_id: null,
      cutoff_at: null,
      target_count: null,
      terminalized_count: null,
      pending_target_count: null,
      created_at: null,
      updated_at: null,
      completed_at: null,
    };
  }
  return {
    schema_version: 1,
    latch_state: latchState,
    operation_id: OPERATION_ID,
    cutoff_at: CUTOFF,
    target_count: 2,
    terminalized_count: latchState === "completed" ? 2 : 1,
    pending_target_count: latchState === "completed" ? 0 : 1,
    created_at: CREATED,
    updated_at: UPDATED,
    completed_at: latchState === "completed" ? COMPLETED : null,
  };
}

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

Deno.test("Compute emergency-stop status decodes only the sanitized service projection", async () => {
  let called = false;
  const status = await getComputeEmergencyStopStatus({
    supabaseUrl: "https://supabase.test",
    serviceRoleKey: "service-role-key",
    fetchFn: (input, init) => {
      called = true;
      const request = new Request(input, init);
      assertEquals(
        request.url,
        "https://supabase.test/rest/v1/rpc/get_compute_emergency_stop_status",
      );
      assertEquals(request.method, "POST");
      assertEquals(request.headers.get("apikey"), "service-role-key");
      assertEquals(
        request.headers.get("authorization"),
        "Bearer service-role-key",
      );
      return Promise.resolve(Response.json(statusRow("completed")));
    },
  });
  assertEquals(called, true);
  assertEquals(status, {
    schemaVersion: 1,
    latchState: "completed",
    operationId: OPERATION_ID,
    cutoffAt: CUTOFF,
    targetCount: 2,
    terminalizedCount: 2,
    pendingTargetCount: 0,
    createdAt: CREATED,
    updatedAt: UPDATED,
    completedAt: COMPLETED,
  });
});

Deno.test("Compute emergency-stop status preserves active aggregate progress", async () => {
  const status = await getComputeEmergencyStopStatus({
    supabaseUrl: "https://supabase.test",
    serviceRoleKey: "service-role-key",
    fetchFn: () => Promise.resolve(Response.json(statusRow("active"))),
  });
  assertEquals(status, {
    schemaVersion: 1,
    latchState: "active",
    operationId: OPERATION_ID,
    cutoffAt: CUTOFF,
    targetCount: 2,
    terminalizedCount: 1,
    pendingTargetCount: 1,
    createdAt: CREATED,
    updatedAt: UPDATED,
    completedAt: null,
  });
});

Deno.test("Compute emergency-stop status fails closed on schema drift", async () => {
  for (
    const payload of [
      { ...statusRow("clear"), schema_version: 2 },
      { ...statusRow("clear"), latch_state: "released" },
      { ...statusRow("clear"), reason: "private" },
      { ...statusRow("clear"), operation_id: OPERATION_ID },
      { ...statusRow("active"), pending_target_count: 0 },
      { ...statusRow("active"), target_count: "2" },
      { ...statusRow("active"), completed_at: COMPLETED },
      { ...statusRow("completed"), terminalized_count: 1 },
      { ...statusRow("completed"), completed_at: null },
      { ...statusRow("completed"), operation_id: "not-a-uuid" },
      { ...statusRow("completed"), completed_at: "2026-07-20T12:02:00.000Z" },
      { ...statusRow("completed"), updated_at: "2026-07-20T11:00:00.000Z" },
      null,
    ]
  ) {
    await assertRejects(
      () =>
        getComputeEmergencyStopStatus({
          supabaseUrl: "https://supabase.test",
          serviceRoleKey: "service-role-key",
          fetchFn: () => Promise.resolve(Response.json(payload)),
        }),
      ComputeControlPlaneError,
    );
  }
});

Deno.test("Compute emergency-stop status rejects PostgREST row arrays", async () => {
  for (
    const payload of [
      [statusRow("clear")],
      [statusRow("clear"), statusRow("active")],
    ]
  ) {
    await assertRejects(
      () =>
        getComputeEmergencyStopStatus({
          supabaseUrl: "https://supabase.test",
          serviceRoleKey: "service-role-key",
          fetchFn: () => Promise.resolve(Response.json(payload)),
        }),
      ComputeControlPlaneError,
      "invalid response",
    );
  }
});

Deno.test("Compute emergency-stop release requires the exact disabled flag", async () => {
  for (const COMPUTE_ENABLED of [undefined, "", " 0", "0 ", "1", "true"]) {
    let released = false;
    const caught = await assertRejects(
      () =>
        releaseComputeEmergencyStop({
          operationId: OPERATION_ID,
          releaseIdempotencyKey: "66666666-6666-4666-8666-666666666666",
          operatorReference: "oncall:corin",
          reason: "staging recovery matrix passed",
        }, {
          env: { COMPUTE_ENABLED },
          release: () => {
            released = true;
            return Promise.resolve({
              id: OPERATION_ID,
              status: "released",
              replayed: false,
            });
          },
        }),
      ComputeEmergencyStopError,
    );
    assertEquals(caught.code, "COMPUTE_ADMISSION_MUST_BE_DISABLED");
    assertEquals(released, false);
  }
});
