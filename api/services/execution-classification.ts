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

interface RuntimeExecutionClassification {
  usesInference: boolean;
  timeoutMs: number;
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
  const requestedTimeout = input.executionTimeoutMs;
  const maxTimeout = Number.isFinite(input.maxExecutionTimeoutMs) &&
      Number(input.maxExecutionTimeoutMs) > 0
    ? Math.floor(Number(input.maxExecutionTimeoutMs))
    : Number.POSITIVE_INFINITY;

  const timeoutMs = typeof requestedTimeout === "number" &&
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(Math.floor(requestedTimeout), maxTimeout)
    : usesInference
    ? INTERACTIVE_INFERENCE_TIMEOUT_MS
    : INTERACTIVE_FUNCTION_TIMEOUT_MS;

  return { usesInference, timeoutMs };
}
