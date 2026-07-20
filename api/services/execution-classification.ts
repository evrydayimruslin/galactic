import type { AppManifest } from "../../shared/contracts/manifest.ts";
import { functionUsesInference } from "./free-mode.ts";

/**
 * Interactive functions get a bounded response window based on what the
 * upload-derived call graph says THIS function does. App-level AI permissions
 * remain capability authorization; they must not make unrelated read functions
 * inherit the AI timeout.
 */
export const INTERACTIVE_FUNCTION_TIMEOUT_MS = 30_000;
export const INTERACTIVE_INFERENCE_TIMEOUT_MS = 120_000;
// Compute's synchronous lease reserves up to 195s of cold-start time, a 30s
// command, teardown, and parent response headroom. Admission also receives the
// exact host-side deadline and fails before creating a run if that envelope no
// longer fits; longer or later composition uses async mode.
export const INTERACTIVE_COMPUTE_TIMEOUT_MS = 300_000;

interface RuntimeExecutionClassification {
  usesInference: boolean;
  timeoutMs: number;
}

function functionUsesCompute(
  manifestValue: AppManifest | string | null | undefined,
  functionName: string,
): boolean {
  let manifest: AppManifest | null = null;
  if (typeof manifestValue === "string") {
    try {
      const parsed = JSON.parse(manifestValue) as unknown;
      manifest = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as AppManifest
        : null;
    } catch {
      manifest = null;
    }
  } else {
    manifest = manifestValue ?? null;
  }
  const functions = manifest?.functions ?? {};
  const declaration = functions[functionName];
  if (declaration?.uses_compute === true) return true;
  // Once upload-derived flags exist, an explicit/derived false on this exact
  // function wins. Legacy Compute manifests without any flags fail safe to the
  // longer timeout so a previously-valid sync call is not killed at 30s.
  const hasDerivedFlags = Object.values(functions).some((fn) =>
    typeof fn?.uses_compute === "boolean"
  );
  return !hasDerivedFlags &&
    manifest?.permissions?.includes("compute:exec") === true;
}

export function classifyRuntimeExecution(input: {
  manifest: AppManifest | string | null | undefined;
  functionName: string;
  /** Queue consumers pass the already-authorized durable execution budget. */
  executionTimeoutMs?: number | null;
  maxExecutionTimeoutMs?: number;
}): RuntimeExecutionClassification {
  const usesInference = functionUsesInference(
    input.manifest,
    input.functionName,
  );
  const usesCompute = functionUsesCompute(
    input.manifest,
    input.functionName,
  );
  const requestedTimeout = input.executionTimeoutMs;
  const maxTimeout = Number.isFinite(input.maxExecutionTimeoutMs) &&
      Number(input.maxExecutionTimeoutMs) > 0
    ? Math.floor(Number(input.maxExecutionTimeoutMs))
    : Number.POSITIVE_INFINITY;

  const timeoutMs = typeof requestedTimeout === "number" &&
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(Math.floor(requestedTimeout), maxTimeout)
    : usesCompute
    ? INTERACTIVE_COMPUTE_TIMEOUT_MS
    : usesInference
    ? INTERACTIVE_INFERENCE_TIMEOUT_MS
    : INTERACTIVE_FUNCTION_TIMEOUT_MS;

  return { usesInference, timeoutMs };
}
