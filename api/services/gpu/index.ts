// GPU Compute Runtime — Module Entry Point
// Re-exports for GPU helpers and provider access.

export { getGPUProvider, isGpuAvailable } from './provider-singleton.ts';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

// Types — everything other modules need
export type {
  GpuType,
  GpuRateEntry,
  GpuStatus,
  GpuConfig,
  GpuExitCode,
  GpuExecutionResult,
  GpuDispatchStrategy,
  GpuPricingMode,
  GpuPricingConfig,
  GpuEndpoint,
  BenchmarkStats,
  FailureChargeability,
} from './types.ts';

// Constants and helpers
export {
  GPU_RATE_TABLE,
  GPU_TYPES,
  GPU_BILLING_INCREMENT_MS,
  GPU_COLD_START_BUFFER_MS,
  isValidGpuType,
  getGpuRate,
  getGpuVram,
  computeGpuBillableDurationMs,
  computeGpuCostLight,
  classifyFailure,
} from './types.ts';

// Provider interface
export type {
  GPUProvider,
  BuildContainerParams,
  BuildContainerResult,
  ExecuteParams,
  EndpointStatus,
} from './provider.ts';

// RunPod implementation (for direct access / testing)
export { RunPodProvider } from './runpod.ts';

// Config parser (Phase 2A)
export { detectGpuConfig, parseGpuConfig } from './config.ts';
export type { GpuConfigValidation } from './config.ts';

// Container builder (Phase 2C)
export { triggerGpuBuild, generateDockerfile } from './builder.ts';

// Benchmark pipeline (Phase 2E)
export { startGpuBuildProcessorJob, computeBenchmarkStats } from './benchmark.ts';

// Executor (Phase 3A)
export { executeGpuFunction } from './executor.ts';
export type { GpuExecuteParams, GpuExecuteResult } from './executor.ts';

// Concurrency tracker (Phase 3B)
export { acquireGpuSlot, releaseGpuSlot, getGpuConcurrency, GpuConcurrencyError } from './concurrency.ts';
export type { GpuSlot } from './concurrency.ts';

// Billing (Phase 3C)
export { computeGpuCallCost, settleGpuExecution, estimateMaxGpuCost, extractUnitCount } from './billing.ts';
export type { GpuCostBreakdown, GpuSettlementResult } from './billing.ts';

// Pricing display (Phase 4A)
export { formatGpuPricing, formatGpuCostEstimate } from './pricing-display.ts';
export type { GpuPricingDisplay } from './pricing-display.ts';

// Reliability (Phase 4B)
export { getGpuReliability, refreshGpuReliabilityView } from './reliability.ts';
export type { GpuReliabilityStats } from './reliability.ts';
