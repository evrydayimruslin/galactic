import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyComputeEmergencyStopReleaseResponse,
  verifyComputeEmergencyStopStatus,
} from "./verify-compute-emergency-stop-status.mjs";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const CUTOFF_AT = "2026-07-20T12:00:00.000Z";
const CREATED_AT = "2026-07-20T11:59:59.000Z";
const UPDATED_AT = "2026-07-20T12:01:00.000Z";
const WORKER_VERSION_ID = "12345678-1234-1234-1234-123456789abc";

const clearAndDisabled = {
  schema_version: 1,
  worker_version_id: WORKER_VERSION_ID,
  admission_state: "disabled",
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

function operationStatus(latch_state, overrides = {}) {
  return {
    schema_version: 1,
    worker_version_id: WORKER_VERSION_ID,
    admission_state: "disabled",
    latch_state,
    operation_id: OPERATION_ID,
    cutoff_at: CUTOFF_AT,
    target_count: 2,
    terminalized_count: latch_state === "completed" ? 2 : 1,
    pending_target_count: latch_state === "completed" ? 0 : 1,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    completed_at: latch_state === "completed" ? UPDATED_AT : null,
    ...overrides,
  };
}

test("accepts the exact sanitized clear preflight state", () => {
  assert.deepEqual(
    verifyComputeEmergencyStopStatus({
      status: clearAndDisabled,
      expectedAdmissionState: "disabled",
      expectedLatchState: "clear",
    }),
    {
      schemaVersion: 1,
      admissionState: "disabled",
      latchState: "clear",
      operationId: null,
      workerVersionId: WORKER_VERSION_ID,
    },
  );
});

test("accepts active and completed operation projections with exact identity", () => {
  for (const latchState of ["active", "completed"]) {
    assert.deepEqual(
      verifyComputeEmergencyStopStatus({
        status: operationStatus(latchState),
        expectedAdmissionState: "disabled",
        expectedLatchState: latchState,
        expectedOperationId: OPERATION_ID,
      }),
      {
        schemaVersion: 1,
        admissionState: "disabled",
        latchState,
        operationId: OPERATION_ID,
        workerVersionId: WORKER_VERSION_ID,
      },
    );
  }
});

test("binds a rollout preflight to the exact serving Worker version", () => {
  assert.equal(
    verifyComputeEmergencyStopStatus({
      status: clearAndDisabled,
      expectedAdmissionState: "disabled",
      expectedLatchState: "clear",
      expectedWorkerVersionId: WORKER_VERSION_ID,
    }).workerVersionId,
    WORKER_VERSION_ID,
  );
  assert.throws(
    () => verifyComputeEmergencyStopStatus({
      status: { ...clearAndDisabled, worker_version_id: null },
      expectedAdmissionState: "disabled",
      expectedLatchState: "clear",
      expectedWorkerVersionId: WORKER_VERSION_ID,
    }),
    /expected Worker version/u,
  );
});

test("accepts the exact legacy projection only when no Worker version is expected", () => {
  const { worker_version_id: _omitted, ...legacy } = clearAndDisabled;
  assert.equal(
    verifyComputeEmergencyStopStatus({
      status: legacy,
      expectedAdmissionState: "disabled",
      expectedLatchState: "clear",
    }).workerVersionId,
    null,
  );
  assert.throws(
    () => verifyComputeEmergencyStopStatus({
      status: legacy,
      expectedAdmissionState: "disabled",
      expectedLatchState: "clear",
      expectedWorkerVersionId: WORKER_VERSION_ID,
    }),
    /expected Worker version/u,
  );
});

test("accepts every canonical admission state when explicitly expected", () => {
  for (const admission_state of ["enabled", "disabled", "invalid"]) {
    assert.doesNotThrow(() =>
      verifyComputeEmergencyStopStatus({
        status: { ...clearAndDisabled, admission_state },
        expectedAdmissionState: admission_state,
        expectedLatchState: "clear",
      })
    );
  }
});

test("fails closed on an unexpected live state or operation", () => {
  assert.throws(
    () =>
      verifyComputeEmergencyStopStatus({
        status: clearAndDisabled,
        expectedAdmissionState: "enabled",
        expectedLatchState: "clear",
      }),
    /expected admission enabled, received disabled/u,
  );
  assert.throws(
    () =>
      verifyComputeEmergencyStopStatus({
        status: operationStatus("active"),
        expectedAdmissionState: "disabled",
        expectedLatchState: "clear",
      }),
    /expected latch clear, received active/u,
  );
  assert.throws(
    () =>
      verifyComputeEmergencyStopStatus({
        status: operationStatus("completed"),
        expectedAdmissionState: "disabled",
        expectedLatchState: "completed",
        expectedOperationId: OTHER_OPERATION_ID,
      }),
    /expected operation/u,
  );
});

for (
  const [name, status, expectedLatchState = "clear"] of [
    ["null", null],
    ["array", []],
    ["wrong schema", { ...clearAndDisabled, schema_version: 2 }],
    ["unknown admission", { ...clearAndDisabled, admission_state: "off" }],
    ["unknown latch", { ...clearAndDisabled, latch_state: "released" }],
    [
      "missing field",
      Object.fromEntries(
        Object.entries(clearAndDisabled).filter(([key]) =>
          key !== "completed_at"
        ),
      ),
    ],
    ["clear operation metadata", {
      ...clearAndDisabled,
      operation_id: OPERATION_ID,
    }],
    ["private reason", { ...clearAndDisabled, reason: "secret" }],
    ["private operator", { ...clearAndDisabled, operator_reference: "secret" }],
    [
      "bad UUID",
      operationStatus("active", { operation_id: "not-a-uuid" }),
      "active",
    ],
    [
      "bad timestamp",
      operationStatus("active", { cutoff_at: "yesterday" }),
      "active",
    ],
    [
      "inconsistent pending count",
      operationStatus("active", { pending_target_count: 0 }),
      "active",
    ],
    [
      "active completion timestamp",
      operationStatus("active", { completed_at: UPDATED_AT }),
      "active",
    ],
    [
      "incomplete completed latch",
      operationStatus("completed", {
        terminalized_count: 1,
        pending_target_count: 1,
      }),
      "completed",
    ],
    [
      "completion after update",
      operationStatus("completed", {
        completed_at: "2026-07-20T12:02:00.000Z",
      }),
      "completed",
    ],
  ]
) {
  test(`fails closed on ${name}`, () => {
    assert.throws(
      () =>
        verifyComputeEmergencyStopStatus({
          status,
          expectedAdmissionState: "disabled",
          expectedLatchState,
        }),
      /Compute emergency-stop status is invalid/u,
    );
  });
}

test("fails closed on unsupported expectations", () => {
  assert.throws(
    () =>
      verifyComputeEmergencyStopStatus({
        status: clearAndDisabled,
        expectedAdmissionState: "off",
        expectedLatchState: "clear",
      }),
    /unsupported expected admission state/u,
  );
  assert.throws(
    () =>
      verifyComputeEmergencyStopStatus({
        status: clearAndDisabled,
        expectedAdmissionState: "disabled",
        expectedLatchState: "released",
      }),
    /unsupported expected latch state/u,
  );
  assert.throws(
    () =>
      verifyComputeEmergencyStopStatus({
        status: clearAndDisabled,
        expectedAdmissionState: "disabled",
        expectedLatchState: "clear",
        expectedOperationId: "not-a-uuid",
      }),
    /expected operation id is malformed/u,
  );
});

test("accepts only the exact released operation response", () => {
  for (const replayed of [false, true]) {
    assert.deepEqual(
      verifyComputeEmergencyStopReleaseResponse({
        response: {
          success: true,
          operation_id: OPERATION_ID,
          status: "released",
          replayed,
        },
        expectedOperationId: OPERATION_ID,
      }),
      {
        operationId: OPERATION_ID,
        status: "released",
        replayed,
      },
    );
  }
});

test("release response fails closed on operation mismatch or malformed UUIDs", () => {
  assert.throws(
    () =>
      verifyComputeEmergencyStopReleaseResponse({
        response: {
          success: true,
          operation_id: OTHER_OPERATION_ID,
          status: "released",
          replayed: false,
        },
        expectedOperationId: OPERATION_ID,
      }),
    /expected operation/u,
  );
  assert.throws(
    () =>
      verifyComputeEmergencyStopReleaseResponse({
        response: {
          success: true,
          operation_id: "not-a-uuid",
          status: "released",
          replayed: false,
        },
        expectedOperationId: OPERATION_ID,
      }),
    /operation id is malformed/u,
  );
  assert.throws(
    () =>
      verifyComputeEmergencyStopReleaseResponse({
        response: {
          success: true,
          operation_id: OPERATION_ID,
          status: "released",
          replayed: false,
        },
        expectedOperationId: "not-a-uuid",
      }),
    /expected operation id is malformed/u,
  );
});

for (
  const [name, response] of [
    ["array", []],
    ["missing field", {
      success: true,
      operation_id: OPERATION_ID,
      status: "released",
    }],
    ["false success", {
      success: false,
      operation_id: OPERATION_ID,
      status: "released",
      replayed: false,
    }],
    ["wrong status", {
      success: true,
      operation_id: OPERATION_ID,
      status: "completed",
      replayed: false,
    }],
    ["nonboolean replayed", {
      success: true,
      operation_id: OPERATION_ID,
      status: "released",
      replayed: "false",
    }],
    ["extra private field", {
      success: true,
      operation_id: OPERATION_ID,
      status: "released",
      replayed: false,
      release_reason: "private",
    }],
  ]
) {
  test(`release response fails closed on ${name}`, () => {
    assert.throws(
      () =>
        verifyComputeEmergencyStopReleaseResponse({
          response,
          expectedOperationId: OPERATION_ID,
        }),
      /Compute emergency-stop release response is invalid/u,
    );
  });
}
