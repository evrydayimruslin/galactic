// GPU Compute Runtime — Provider Abstraction Layer
// Defines the interface that all GPU compute providers must implement.
// MVP: RunPod Serverless. Future: CoreWeave, Lambda, Modal, colocation.

import type { GpuConfig, GpuExecutionResult, GpuType } from "./types.ts";

// ---------------------------------------------------------------------------
// Build Parameters
// ---------------------------------------------------------------------------

/** Parameters for building a GPU container from developer code. */
export interface BuildContainerParams {
  /** Ultralight app ID. */
  appId: string;
  /** App version string (e.g. "1.0.0"). */
  version: string;
  /** Developer's code files to package into the container. */
  codeFiles: Array<{ name: string; content: string }>;
  /** Parsed ultralight.gpu.yaml config. */
  config: GpuConfig;
  /** Contents of requirements.txt, if present. */
  requirements?: string;
  /** Pre-built image ref to use for the provider template. */
  imageRef?: string;
  /** Digest of the pre-built image, if supplied by the registry builder. */
  imageDigest?: string;
}

/** Result from a successful container build. */
export interface BuildContainerResult {
  /** Provider-assigned endpoint identifier. */
  endpointId: string;
  /** Container image used by the provider template. */
  imageRef?: string;
  /** OCI image digest used by the provider template. */
  imageDigest?: string;
  /** Build log lines for developer debugging. */
  buildLogs: string[];
}

// ---------------------------------------------------------------------------
// Execution Parameters
// ---------------------------------------------------------------------------

/** Parameters for executing a function on a GPU endpoint. */
export interface ExecuteParams {
  /** Provider endpoint ID (from buildContainer). */
  endpointId: string;
  /** Python function name to invoke. */
  functionName: string;
  /** Arguments to pass to the function. */
  args: Record<string, unknown>;
  /** Hard ceiling for execution time in milliseconds. */
  maxDurationMs: number;
  /** GPU type for billing reference. */
  gpuType: GpuType;
}

// ---------------------------------------------------------------------------
// Endpoint Status
// ---------------------------------------------------------------------------

/** Current status of a provider endpoint. */
export interface EndpointStatus {
  /** Endpoint lifecycle state. */
  status: "active" | "building" | "error" | "not_found";
  /** Number of active workers (0 = cold, will need cold start). */
  workers: number;
  /** Number of requests in the provider's queue. */
  queueDepth: number;
}

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

/**
 * GPU compute provider abstraction.
 *
 * Each provider implementation handles:
 * - Container image building from developer code
 * - Serverless execution with structured result reporting
 * - Endpoint lifecycle management (status, deletion)
 *
 * The platform owns scheduling, billing, and concurrency — providers
 * only handle raw compute.
 */
export interface GPUProvider {
  /** Provider name for logging and database records (e.g. 'runpod'). */
  readonly name: string;

  /**
   * Build a container image from developer code and create a serverless endpoint.
   *
   * The container includes the platform harness for structured error reporting.
   * Build is async on the provider side — poll getEndpointStatus() for completion.
   */
  buildContainer(params: BuildContainerParams): Promise<BuildContainerResult>;

  /**
   * Execute a function on a GPU endpoint synchronously.
   *
   * Returns a structured GpuExecutionResult with duration, VRAM usage, and
   * exit code. The provider separates cold start time (delayTime) from actual
   * execution time (executionTime) — only executionTime is billed.
   *
   * Timeout: maxDurationMs + 30s buffer for cold start + network overhead.
   */
  execute(params: ExecuteParams): Promise<GpuExecutionResult>;

  /**
   * Get the current status of a provider endpoint.
   *
   * Used for health checks, warm pool decisions, and build status polling.
   */
  getEndpointStatus(endpointId: string): Promise<EndpointStatus>;

  /**
   * Delete a provider endpoint and release all associated resources.
   *
   * Called when an app is deleted, or when replacing an endpoint on version update.
   */
  deleteEndpoint(endpointId: string): Promise<void>;

  /**
   * List GPU types supported by this provider.
   *
   * Used to validate developer gpu_type selection against provider capabilities.
   */
  getSupportedGpuTypes(): GpuType[];
}
