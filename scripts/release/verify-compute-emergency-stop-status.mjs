#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ADMISSION_STATES = new Set(["enabled", "disabled", "invalid"]);
const LATCH_STATES = new Set(["clear", "active", "completed"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESPONSE_KEYS = [
  "admission_state",
  "completed_at",
  "created_at",
  "cutoff_at",
  "latch_state",
  "operation_id",
  "pending_target_count",
  "schema_version",
  "target_count",
  "terminalized_count",
  "updated_at",
];

function fail(message) {
  throw new Error(`Compute emergency-stop status is invalid: ${message}`);
}

function timestamp(value, field) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u
      .test(value) ||
    !Number.isFinite(Date.parse(value))
  ) fail(`${field} is not a timestamp with an explicit timezone`);
  return value;
}

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${field} is not a non-negative safe integer`);
  }
  return value;
}

export function verifyComputeEmergencyStopStatus({
  status,
  expectedAdmissionState,
  expectedLatchState,
  expectedOperationId = null,
}) {
  if (!ADMISSION_STATES.has(expectedAdmissionState)) {
    fail(
      `unsupported expected admission state ${String(expectedAdmissionState)}`,
    );
  }
  if (!LATCH_STATES.has(expectedLatchState)) {
    fail(`unsupported expected latch state ${String(expectedLatchState)}`);
  }
  if (expectedOperationId !== null && !UUID.test(expectedOperationId)) {
    fail("expected operation id is malformed");
  }
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    fail("response is not an object");
  }
  const keys = Object.keys(status).sort();
  if (
    keys.length !== RESPONSE_KEYS.length ||
    keys.some((key, index) => key !== RESPONSE_KEYS[index])
  ) {
    fail("response fields do not match the sanitized schema");
  }
  if (status.schema_version !== 1) {
    fail("schema version is unsupported");
  }
  if (!ADMISSION_STATES.has(status.admission_state)) {
    fail("admission state is not canonical");
  }
  if (!LATCH_STATES.has(status.latch_state)) {
    fail("latch state is not canonical");
  }
  if (status.admission_state !== expectedAdmissionState) {
    fail(
      `expected admission ${expectedAdmissionState}, received ${status.admission_state}`,
    );
  }
  if (status.latch_state !== expectedLatchState) {
    fail(
      `expected latch ${expectedLatchState}, received ${status.latch_state}`,
    );
  }

  if (status.latch_state === "clear") {
    for (
      const field of [
        "operation_id",
        "cutoff_at",
        "target_count",
        "terminalized_count",
        "pending_target_count",
        "created_at",
        "updated_at",
        "completed_at",
      ]
    ) {
      if (status[field] !== null) fail(`clear latch contains ${field}`);
    }
    if (expectedOperationId !== null) {
      fail("a clear latch cannot match an expected operation id");
    }
  } else {
    if (
      typeof status.operation_id !== "string" ||
      !UUID.test(status.operation_id)
    ) fail("operation id is malformed");
    timestamp(status.cutoff_at, "cutoff_at");
    const createdAt = timestamp(status.created_at, "created_at");
    const updatedAt = timestamp(status.updated_at, "updated_at");
    const targetCount = count(status.target_count, "target_count");
    const terminalizedCount = count(
      status.terminalized_count,
      "terminalized_count",
    );
    const pendingTargetCount = count(
      status.pending_target_count,
      "pending_target_count",
    );
    if (
      terminalizedCount > targetCount ||
      pendingTargetCount !== targetCount - terminalizedCount ||
      Date.parse(updatedAt) < Date.parse(createdAt)
    ) fail("operation progress is inconsistent");
    if (status.latch_state === "active") {
      if (status.completed_at !== null) {
        fail("active latch contains completed_at");
      }
    } else {
      const completedAt = timestamp(status.completed_at, "completed_at");
      if (
        pendingTargetCount !== 0 || terminalizedCount !== targetCount ||
        Date.parse(completedAt) < Date.parse(createdAt) ||
        Date.parse(completedAt) > Date.parse(updatedAt)
      ) fail("completed latch is not fully terminalized");
    }
    if (
      expectedOperationId !== null &&
      status.operation_id !== expectedOperationId
    ) {
      fail(
        `expected operation ${expectedOperationId}, received ${status.operation_id}`,
      );
    }
  }

  return {
    schemaVersion: 1,
    admissionState: status.admission_state,
    latchState: status.latch_state,
    operationId: status.operation_id,
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    fail("response file is not valid JSON");
  }
}

function main(argv) {
  if (argv.length < 3 || argv.length > 4) {
    throw new Error(
      "Usage: verify-compute-emergency-stop-status.mjs " +
        "<status-json> <enabled|disabled|invalid> <clear|active|completed> " +
        "[expected-operation-id|-]",
    );
  }
  const result = verifyComputeEmergencyStopStatus({
    status: readJson(argv[0]),
    expectedAdmissionState: argv[1],
    expectedLatchState: argv[2],
    expectedOperationId: argv[3] && argv[3] !== "-" ? argv[3] : null,
  });
  console.log(
    `${result.admissionState}/${result.latchState}` +
      (result.operationId ? `/${result.operationId}` : ""),
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
