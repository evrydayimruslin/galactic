// GPU Compute Runtime — Executor
// GPU equivalent of executeInSandbox(). Dispatches function calls to RunPod
// via the provider and returns a structured result compatible with handler patterns.
// Pure execution — no billing, no concurrency. Those are handled by callers.

import type { GpuType, GpuExitCode, GpuExecutionResult } from './types.ts';
import {
  computeGpuCostLight,
  GPU_BILLING_INCREMENT_MS,
  isValidGpuType,
} from './types.ts';
import { getGPUProvider } from './provider-singleton.ts';
import { buildGpuNotReadyMessage } from './status.ts';
import type { App } from '../../../shared/types/index.ts';
import {
  getGpuSupportDisabledMessage,
  isGpuSupportEnabled,
} from './feature-flag.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for executing a GPU function. */
export interface GpuExecuteParams {
  /** Full app record (must have gpu_endpoint_id, gpu_type, gpu_status). */
  app: App;
  /** Python function name to call (e.g. "main", "render_frame"). */
  functionName: string;
  /** Keyword arguments to pass to the function. */
  args: Record<string, unknown>;
  /** Unique execution ID for tracing. */
  executionId: string;
  /** Override max duration in ms. Falls back to app.gpu_max_duration_ms, then 60_000. */
  maxDurationMs?: number;
}

/**
 * Result from GPU function execution.
 *
 * Designed as a superset of the Deno sandbox result shape so handlers
 * can use `result.success`, `result.result`, `result.error`, `result.logs`
 * identically. GPU-specific fields are additional.
 */
export interface GpuExecuteResult {
  // ── Handler-compatible fields (match Deno sandbox result) ──
  /** Whether the function completed successfully. */
  success: boolean;
  /** Function return value. null on failure. */
  result: unknown;
  /** Error details on failure. */
  error?: { type: string; message: string; traceback?: string };
  /** Stdout/stderr log lines from the container. */
  logs: string[];
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
  /** Provider-reported execution time, excluding queue/cold-start delay. */
  executionDurationMs: number;
  /** Provider-reported queue/cold-start delay charged through when present. */
  delayTimeMs: number;
  /** Provider-aligned billable duration used for compute cost. */
  billableDurationMs: number;
  /** Billing increment used to round billable duration. */
  billingIncrementMs: number;

  // ── GPU-specific fields (for billing + telemetry) ──
  /** Container harness exit code. Determines failure chargeability. */
  exitCode: GpuExitCode;
  /** Peak GPU memory usage in gigabytes. */
  peakVramGb: number;
  /** GPU type used for this execution. */
  gpuType: GpuType;
  /** Platform compute cost in Light (rate_per_ms × duration_ms). */
  gpuCostLight: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default max execution time when not specified anywhere. */
const DEFAULT_MAX_DURATION_MS = 60_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a GPU function via the provider.
 *
 * Validates that the app is live and has an endpoint, dispatches to RunPod,
 * maps the provider result to handler-compatible shape, and computes
 * platform compute cost.
 *
 * Does NOT handle billing or concurrency — callers are responsible.
 */
export async function executeGpuFunction(
  params: GpuExecuteParams,
): Promise<GpuExecuteResult> {
  const { app, functionName, args, executionId, maxDurationMs } = params;

  // ── Validation ──
  if (!isGpuSupportEnabled()) {
    return makeError(
      'infra_error',
      'GpuSupportDisabled',
      getGpuSupportDisabledMessage('GPU runtime execution'),
      app,
    );
  }

  if (app.gpu_status !== 'live') {
    return makeError(
      'exception',
      'GpuStatusError',
      buildGpuNotReadyMessage(app.gpu_status),
      app,
    );
  }

  if (!app.gpu_endpoint_id) {
    return makeError(
      'infra_error',
      'GpuConfigError',
      'GPU function has no endpoint configured. This is an internal error.',
      app,
    );
  }

  const gpuTypeRaw = app.gpu_type ?? '';
  if (!isValidGpuType(gpuTypeRaw)) {
    return makeError(
      'infra_error',
      'GpuConfigError',
      `Invalid GPU type "${gpuTypeRaw}" on app record.`,
      app,
    );
  }
  const gpuType = gpuTypeRaw as GpuType;

  // ── Resolve max duration ──
  const resolvedMaxDuration = maxDurationMs
    ?? app.gpu_max_duration_ms
    ?? DEFAULT_MAX_DURATION_MS;

  // ── Execute via provider ──
  const wallStart = Date.now();
  let providerResult: GpuExecutionResult;

  try {
    const provider = getGPUProvider();
    providerResult = await provider.execute({
      endpointId: app.gpu_endpoint_id,
      functionName,
      args,
      maxDurationMs: resolvedMaxDuration,
      gpuType,
    });
  } catch (err) {
    // Provider-level failure (network error, 5xx, etc.)
    const wallDuration = Date.now() - wallStart;
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[GPU-EXEC] ${executionId} provider error for ${app.id}:`, errorMsg);

    return {
      success: false,
      result: null,
      error: {
        type: 'InfraError',
        message: `GPU execution failed: ${errorMsg}`,
      },
      logs: [],
      durationMs: wallDuration,
      executionDurationMs: 0,
      delayTimeMs: 0,
      billableDurationMs: 0,
      billingIncrementMs: GPU_BILLING_INCREMENT_MS,
      exitCode: 'infra_error',
      peakVramGb: 0,
      gpuType,
      gpuCostLight: 0, // infra errors are not billed
    };
  }

  const wallDuration = Date.now() - wallStart;
  const billableDurationMs = providerResult.billable_duration_ms ??
    providerResult.duration_ms;
  const delayTimeMs = providerResult.delay_time_ms ?? 0;
  const billingIncrementMs = providerResult.billing_increment_ms ??
    GPU_BILLING_INCREMENT_MS;

  // ── Map provider result → handler-compatible shape ──
  const gpuCostLight = providerResult.success
    ? computeGpuCostLight(gpuType, billableDurationMs)
    : providerResult.exit_code !== 'infra_error'
      ? computeGpuCostLight(gpuType, billableDurationMs)
      : 0;

  console.log(
    `[GPU-EXEC] ${executionId} ${app.id}.${functionName}: ` +
      `${providerResult.exit_code} exec=${providerResult.duration_ms.toFixed(1)}ms ` +
      `delay=${delayTimeMs.toFixed(1)}ms billable=${billableDurationMs.toFixed(1)}ms ` +
      `gpu=${gpuType} cost=${gpuCostLight.toFixed(4)}✦ vram=${providerResult.peak_vram_gb}GB`,
  );

  return {
    success: providerResult.success,
    result: providerResult.result,
    error: providerResult.error,
    logs: providerResult.logs,
    durationMs: wallDuration,
    executionDurationMs: providerResult.duration_ms,
    delayTimeMs,
    billableDurationMs,
    billingIncrementMs,
    exitCode: providerResult.exit_code,
    peakVramGb: providerResult.peak_vram_gb,
    gpuType,
    gpuCostLight,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an error GpuExecuteResult without calling the provider.
 * Used for pre-flight validation failures.
 */
function makeError(
  exitCode: GpuExitCode,
  errorType: string,
  message: string,
  app: App,
): GpuExecuteResult {
  const gpuTypeRaw = app.gpu_type ?? '';
  const gpuType: GpuType = isValidGpuType(gpuTypeRaw) ? gpuTypeRaw as GpuType : 'A40';

  return {
    success: false,
    result: null,
    error: { type: errorType, message },
    logs: [],
    durationMs: 0,
    executionDurationMs: 0,
    delayTimeMs: 0,
    billableDurationMs: 0,
    billingIncrementMs: GPU_BILLING_INCREMENT_MS,
    exitCode,
    peakVramGb: 0,
    gpuType,
    gpuCostLight: 0,
  };
}
