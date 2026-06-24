// GPU Compute Runtime — Core Type Definitions
// All GPU types, rate tables, configs, and result structures used across the GPU subsystem.

// ---------------------------------------------------------------------------
// GPU Hardware Types
// ---------------------------------------------------------------------------

/** Supported GPU types mapped to RunPod Serverless GPU identifiers. */
export type GpuType =
  | 'A40'
  | 'L40'
  | 'L40S'
  | 'A100-80GB-PCIe'
  | 'A100-80GB-SXM'
  | 'H100-PCIe'
  | 'H100-SXM'
  | 'H100-NVL'
  | 'H200'
  | 'B200';

/** Per-GPU rate and spec entry. */
export interface GpuRateEntry {
  /** Platform rate charged to callers, in Light (✦) per millisecond. Includes 10-13x markup over provider cost. */
  rate_per_ms: number;
  /** Available VRAM in gigabytes. */
  vram_gb: number;
}

/**
 * Platform rate table. All-in per-ms rate in Light.
 * Derived from RunPod community cloud rates with consistent 10-13x markup, at 100 Light/$1.
 */
export const GPU_RATE_TABLE: Record<GpuType, GpuRateEntry> = {
  'A40':            { rate_per_ms: 0.00010000,  vram_gb: 48 },
  'L40':            { rate_per_ms: 0.00020000,  vram_gb: 48 },
  'L40S':           { rate_per_ms: 0.00022000,  vram_gb: 48 },
  'A100-80GB-PCIe': { rate_per_ms: 0.00040000,  vram_gb: 80 },
  'A100-80GB-SXM':  { rate_per_ms: 0.00050000,  vram_gb: 80 },
  'H100-PCIe':      { rate_per_ms: 0.00070000,  vram_gb: 80 },
  'H100-SXM':       { rate_per_ms: 0.00090000,  vram_gb: 80 },
  'H100-NVL':       { rate_per_ms: 0.00090000,  vram_gb: 94 },
  'H200':           { rate_per_ms: 0.00120000,  vram_gb: 141 },
  'B200':           { rate_per_ms: 0.00200000,  vram_gb: 180 },
};

/** All valid GPU type strings. */
export const GPU_TYPES = Object.keys(GPU_RATE_TABLE) as GpuType[];

/** RunPod Serverless timeout buffer used for cold-start and queue overhead. */
export const GPU_COLD_START_BUFFER_MS = 30_000;

/** Bill GPU time in provider-aligned whole-second increments. */
export const GPU_BILLING_INCREMENT_MS = 1_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard: checks if a string is a valid GpuType. */
export function isValidGpuType(s: string): s is GpuType {
  return s in GPU_RATE_TABLE;
}

/** Get the platform rate per millisecond for a GPU type. */
export function getGpuRate(gpuType: GpuType): number {
  return GPU_RATE_TABLE[gpuType].rate_per_ms;
}

/** Get available VRAM in GB for a GPU type. */
export function getGpuVram(gpuType: GpuType): number {
  return GPU_RATE_TABLE[gpuType].vram_gb;
}

/** Compute GPU cost in Light for a given GPU type and duration. */
export function computeGpuCostLight(gpuType: GpuType, durationMs: number): number {
  // rate_per_ms is already in Light. Duration is rounded up to the provider
  // billing increment so short calls and cold starts do not get undercharged.
  return getGpuRate(gpuType) * computeGpuBillableDurationMs(durationMs);
}

/** Round a raw provider duration up to the configured billing increment. */
export function computeGpuBillableDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.ceil(durationMs / GPU_BILLING_INCREMENT_MS) * GPU_BILLING_INCREMENT_MS;
}

// ---------------------------------------------------------------------------
// GPU Function Lifecycle
// ---------------------------------------------------------------------------

/** Status of a GPU function through the build/benchmark pipeline. */
export type GpuStatus =
  | 'building'          // Container image being built
  | 'benchmarking'      // Benchmark runs in progress
  | 'live'              // Ready to accept calls
  | 'build_config_invalid' // Platform/provider build configuration is invalid
  | 'build_failed'      // Container build failed
  | 'benchmark_failed'; // Benchmark failed (or regression not acknowledged)

/** Internal dispatch strategy (platform-managed, not developer-facing). */
export type GpuDispatchStrategy = 'serverless' | 'reserved' | 'colocation';

/** Platform-managed base image profile for GPU app images. */
export type GpuBaseProfile = 'python-cuda' | 'torch-cuda';

export const GPU_BASE_PROFILES: GpuBaseProfile[] = ['python-cuda', 'torch-cuda'];

// ---------------------------------------------------------------------------
// Developer Config (ultralight.gpu.yaml)
// ---------------------------------------------------------------------------

/** Parsed contents of the developer's ultralight.gpu.yaml config file. */
export interface GpuConfig {
  runtime: 'gpu';
  gpu_type: GpuType;
  /** Declared app version (semver x.y.z). Optional; new apps default to 1.0.0.
   *  Parity with a Deno app's manifest.json `version`. */
  version?: string;
  /** Platform-managed base image profile. Defaults to "python-cuda". */
  base?: GpuBaseProfile;
  /** Python version. Defaults to "3.11". */
  python?: string;
  /** Max execution time in ms. Suggested by platform after benchmark, developer can override. */
  max_duration_ms?: number;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Exit codes from the container harness. Determines failure chargeability. */
export type GpuExitCode =
  | 'success'       // Function completed normally
  | 'oom'           // GPU ran out of memory (chargeable: compute only)
  | 'timeout'       // Hit max_duration_ms (chargeable: compute only)
  | 'exception'     // Unhandled Python exception (chargeable: compute only)
  | 'infra_error';  // Container/network failure (non-chargeable)

/** Result from a single GPU function execution. Returned by the container harness. */
export interface GpuExecutionResult {
  success: boolean;
  exit_code: GpuExitCode;
  /** Function return value. null on failure. */
  result: unknown;
  /** Actual GPU execution time in milliseconds (excludes cold start). */
  duration_ms: number;
  /** Provider-reported queue/cold-start delay in milliseconds. */
  delay_time_ms?: number;
  /** Provider duration charged to the caller, rounded to billing increments. */
  billable_duration_ms?: number;
  /** Billing increment used to round billable duration. */
  billing_increment_ms?: number;
  /** Peak GPU memory usage in gigabytes. 0 if not measurable (no torch). */
  peak_vram_gb: number;
  /** Stdout/stderr log lines from the container. */
  logs: string[];
  /** Error details on failure. */
  error?: {
    type: string;
    message: string;
    traceback?: string;
  };
}

/** Whether a failure should be charged to the caller. */
export type FailureChargeability = 'chargeable' | 'non_chargeable' | 'partial';

/** Map exit codes to chargeability. */
export function classifyFailure(exitCode: GpuExitCode): FailureChargeability {
  switch (exitCode) {
    case 'success':
      return 'chargeable'; // full charge (compute + developer fee)
    case 'oom':
    case 'timeout':
    case 'exception':
      return 'chargeable'; // charge compute only, refund developer fee
    case 'infra_error':
      return 'non_chargeable'; // full refund
  }
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

/** Statistics from benchmark runs (5 executions against test fixture). */
export interface BenchmarkStats {
  /** Number of benchmark runs completed. */
  runs: number;
  /** Mean execution time in ms. */
  mean_ms: number;
  /** Median execution time in ms. */
  median_ms: number;
  /** 95th percentile execution time in ms. */
  p95_ms: number;
  /** Standard deviation in ms. */
  stddev_ms: number;
  /** Coefficient of variation: (stddev / mean) * 100. Used for adaptive regression thresholds. */
  variance_pct: number;
  /** Peak VRAM usage across all runs in GB. */
  peak_vram_gb: number;
  /** Platform-suggested max_duration_ms (recommended tier). */
  suggested_max_duration_ms: number;
  /** If VRAM is over-provisioned, the suggested cheaper GPU type. */
  suggested_gpu_type?: GpuType;
  /** ISO timestamp when benchmark completed. */
  completed_at: string;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Developer-chosen pricing model for their GPU function. */
export type GpuPricingMode = 'per_call' | 'per_unit' | 'per_duration';

/** GPU-specific pricing configuration set by the developer. */
export interface GpuPricingConfig {
  mode: GpuPricingMode;
  /** Flat fee in Light per call. Used in per_call mode. */
  flat_fee_light?: number;
  /** Price in Light per unit. Used in per_unit mode. */
  unit_price_light?: number;
  /** Dot-path into the input args to extract unit count (e.g. "images.length"). Used in per_unit mode. */
  unit_count_from?: string;
  /** Human-readable unit label for marketplace display (e.g. "image", "frame"). */
  unit_label?: string;
  /** Optional markup in Light added on top of compute cost. Used in per_duration mode. */
  duration_markup_light?: number;
  /** Developer fee in Light per billable second. Used in per_duration mode. */
  duration_rate_light_per_second?: number;
}

// ---------------------------------------------------------------------------
// GPU Endpoint Record (database row)
// ---------------------------------------------------------------------------

/** Represents a gpu_endpoints table row. Maps an app+version to a provider endpoint. */
export interface GpuEndpoint {
  id: string;
  app_id: string;
  version: string;
  provider: string;
  endpoint_id: string;
  gpu_type: GpuType;
  status: 'building' | 'active' | 'error' | 'deleted';
  build_logs: string[];
  build_started_at: string;
  build_completed_at: string | null;
  last_invoked_at: string | null;
  invocation_count: number;
  created_at: string;
}
