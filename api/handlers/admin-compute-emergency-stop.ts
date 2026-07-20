import { error, json } from "./response.ts";
import {
  type ComputeEmergencyStopDeps,
  ComputeEmergencyStopError,
  releaseComputeEmergencyStop,
  runComputeEmergencyStop,
} from "../services/compute-emergency-stop.ts";
import { ComputeControlPlaneError } from "../services/compute/database.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_BODY_BYTES = 16_384;
const REQUEST_KEYS = new Set([
  "reason",
  "confirm",
  "batch_size",
  "max_batches",
]);
const RELEASE_REQUEST_KEYS = new Set([
  "reason",
  "confirm",
]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function invalid(message: string): ComputeEmergencyStopError {
  return new ComputeEmergencyStopError(
    "COMPUTE_EMERGENCY_STOP_INVALID",
    400,
    message,
  );
}

function optionalInteger(
  row: Record<string, unknown>,
  key: "batch_size" | "max_batches",
): number | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw invalid(`${key} must be an integer.`);
  return value as number;
}

async function parseRequest(request: Request): Promise<{
  operationId: string;
  reason: string;
  batchSize?: number;
  maxBatches?: number;
}> {
  const operationId = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!UUID_PATTERN.test(operationId)) {
    throw invalid("Idempotency-Key must be a UUID.");
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw invalid("Emergency-stop request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw invalid("Emergency-stop request body is too large.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw invalid("Emergency-stop request body must be valid JSON.");
  }
  const body = objectValue(decoded);
  if (!body || Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) {
    throw invalid("Emergency-stop request contains unsupported fields.");
  }
  if (body.confirm !== "STOP_ALL_COMPUTE") {
    throw invalid("confirm must be STOP_ALL_COMPUTE.");
  }
  if (typeof body.reason !== "string") throw invalid("reason is required.");
  return {
    operationId: operationId.toLowerCase(),
    reason: body.reason,
    batchSize: optionalInteger(body, "batch_size"),
    maxBatches: optionalInteger(body, "max_batches"),
  };
}

export async function handleAdminComputeEmergencyStop(
  request: Request,
  operatorReference: string,
  deps: ComputeEmergencyStopDeps = {},
): Promise<Response> {
  try {
    const input = await parseRequest(request);
    const result = await runComputeEmergencyStop({
      ...input,
      operatorReference,
    }, deps);
    const hasFailures = result.failures.length > 0;
    return json({
      success: result.status === "completed",
      operation_id: result.operationId,
      status: result.status,
      cutoff_at: result.cutoffAt,
      target_count: result.targetCount,
      terminalized_count: result.terminalizedCount,
      processed_this_request: result.processedThisRequest,
      continuation_required: result.continuationRequired,
      failures: result.failures.map((failure) => ({
        run_id: failure.runId,
        phase: failure.phase,
        error_code: failure.errorCode,
      })),
    }, hasFailures ? 503 : result.status === "completed" ? 200 : 202);
  } catch (caught) {
    if (caught instanceof ComputeEmergencyStopError) {
      return json({ error: caught.message, code: caught.code }, caught.status);
    }
    if (caught instanceof ComputeControlPlaneError) {
      const status = caught.status >= 400 && caught.status < 600
        ? caught.status
        : 503;
      return json({ error: caught.message, code: caught.code }, status);
    }
    console.error("[COMPUTE] Emergency-stop request failed", {
      code: "COMPUTE_EMERGENCY_STOP_FAILED",
    });
    return error("Compute emergency stop failed.", 503);
  }
}

export async function handleAdminComputeEmergencyStopRelease(
  request: Request,
  operationId: string,
  operatorReference: string,
  deps: Parameters<typeof releaseComputeEmergencyStop>[1] = {},
): Promise<Response> {
  try {
    if (!UUID_PATTERN.test(operationId)) {
      throw invalid("Emergency-stop operation id must be a UUID.");
    }
    const releaseIdempotencyKey =
      request.headers.get("Idempotency-Key")?.trim().toLowerCase() ?? "";
    if (!UUID_PATTERN.test(releaseIdempotencyKey)) {
      throw invalid("Idempotency-Key must be a UUID.");
    }
    const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw invalid("Emergency-stop release body is too large.");
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      throw invalid("Emergency-stop release body is too large.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw invalid("Emergency-stop release body must be valid JSON.");
    }
    const body = objectValue(decoded);
    if (
      !body ||
      Object.keys(body).some((key) => !RELEASE_REQUEST_KEYS.has(key))
    ) throw invalid("Emergency-stop release contains unsupported fields.");
    if (body.confirm !== "RELEASE_COMPUTE_STOP") {
      throw invalid("confirm must be RELEASE_COMPUTE_STOP.");
    }
    if (typeof body.reason !== "string") throw invalid("reason is required.");
    const result = await releaseComputeEmergencyStop({
      operationId: operationId.toLowerCase(),
      releaseIdempotencyKey,
      operatorReference,
      reason: body.reason,
    }, deps);
    return json({
      success: true,
      operation_id: result.operationId,
      status: result.status,
      replayed: result.replayed,
    });
  } catch (caught) {
    if (caught instanceof ComputeEmergencyStopError) {
      return json({ error: caught.message, code: caught.code }, caught.status);
    }
    if (caught instanceof ComputeControlPlaneError) {
      const status = caught.status >= 400 && caught.status < 600
        ? caught.status
        : 503;
      return json({ error: caught.message, code: caught.code }, status);
    }
    console.error("[COMPUTE] Emergency-stop release failed", {
      code: "COMPUTE_EMERGENCY_STOP_RELEASE_FAILED",
    });
    return error("Compute emergency-stop release failed.", 503);
  }
}
