// GPU Compute Runtime — RunPod Serverless Provider Implementation
// Implements GPUProvider for RunPod's Serverless GPU infrastructure.
// Uses RunPod REST API (rest.runpod.io) for endpoint management
// and RunPod Serverless API (api.runpod.ai) for job execution.

import type { GpuExecutionResult, GpuExitCode, GpuType } from "./types.ts";
import {
  computeGpuBillableDurationMs,
  GPU_BILLING_INCREMENT_MS,
  GPU_COLD_START_BUFFER_MS,
  GPU_TYPES,
} from "./types.ts";
import type {
  BuildContainerParams,
  BuildContainerResult,
  EndpointStatus,
  ExecuteParams,
  GPUProvider,
} from "./provider.ts";
import { getEnv } from "../../lib/env.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** RunPod REST API for endpoint management (CRUD). */
const RUNPOD_REST_BASE = "https://rest.runpod.io/v1";

/** RunPod GraphQL API for template management. */
const RUNPOD_GRAPHQL_BASE = "https://api.runpod.io/graphql";

/** RunPod Serverless API for job execution. */
const RUNPOD_API_BASE = "https://api.runpod.ai/v2";

/** Max retries on 5xx from RunPod. */
const MAX_RETRIES = 1;

/** Delay between retries in ms. */
const RETRY_DELAY_MS = 2_000;

/**
 * Map our GpuType identifiers to RunPod's gpuTypeIds format.
 * RunPod uses full NVIDIA display names in their API.
 */
const GPU_TYPE_TO_RUNPOD: Record<GpuType, string> = {
  "A40": "NVIDIA A40",
  "L40": "NVIDIA L40",
  "L40S": "NVIDIA L40S",
  "A100-80GB-PCIe": "NVIDIA A100 80GB PCIe",
  "A100-80GB-SXM": "NVIDIA A100-SXM4-80GB",
  "H100-PCIe": "NVIDIA H100 80GB HBM3",
  "H100-SXM": "NVIDIA H100 80GB HBM3",
  "H100-NVL": "NVIDIA H100 NVL",
  "H200": "NVIDIA H200",
  "B200": "NVIDIA B200",
};

export interface RunPodTemplateResolutionInput {
  appId: string;
  version: string;
  baseImage?: string;
  platformUrl?: string;
  gpuSecret?: string;
  sharedTemplateId?: string;
  allowSharedTemplateFallback?: boolean;
}

export type RunPodTemplateResolution =
  | {
    mode: "per_app";
    imageName: string;
    codeUrl: string;
    env: Record<string, string>;
  }
  | {
    mode: "shared";
    templateId: string;
    warning: string;
  };

export function resolveRunPodTemplateResolution(
  input: RunPodTemplateResolutionInput,
): RunPodTemplateResolution {
  const baseImage = input.baseImage || "";
  const platformUrl = (input.platformUrl || "").replace(/\/+$/, "");
  const gpuSecret = input.gpuSecret || "";
  const sharedTemplateId = input.sharedTemplateId || "";
  const allowSharedTemplateFallback =
    input.allowSharedTemplateFallback === true;

  if (baseImage && platformUrl && gpuSecret) {
    const codeUrl =
      `${platformUrl}/internal/gpu/code/${input.appId}/${input.version}`;
    return {
      mode: "per_app",
      imageName: baseImage,
      codeUrl,
      env: {
        ULTRALIGHT_CODE_URL: codeUrl,
        ULTRALIGHT_PLATFORM_SECRET: gpuSecret,
        ULTRALIGHT_APP_ID: input.appId,
        ULTRALIGHT_VERSION: input.version,
      },
    };
  }

  const missing = [
    !baseImage ? "RUNPOD_BASE_IMAGE" : null,
    !platformUrl ? "PLATFORM_URL or APP_URL" : null,
    !gpuSecret ? "GPU_INTERNAL_SECRET" : null,
  ].filter((value): value is string => !!value);

  if (!allowSharedTemplateFallback) {
    throw new Error(
      "GPU build requires per-app template injection. Missing: " +
        `${missing.join(", ")}. Configure those env vars or explicitly set ` +
        "RUNPOD_ALLOW_SHARED_TEMPLATE_FALLBACK=true to use the legacy shared template path.",
    );
  }

  if (!sharedTemplateId) {
    throw new Error(
      "RUNPOD_ALLOW_SHARED_TEMPLATE_FALLBACK=true requires RUNPOD_TEMPLATE_ID to be configured.",
    );
  }

  return {
    mode: "shared",
    templateId: sharedTemplateId,
    warning:
      `Using legacy shared template fallback because per-app template injection is unavailable. ` +
      `Missing: ${missing.join(", ")}.`,
  };
}

// ---------------------------------------------------------------------------
// RunPod API Types (response shapes from RunPod)
// ---------------------------------------------------------------------------

/** RunPod /runsync response. */
interface RunPodSyncResponse {
  id: string;
  status:
    | "COMPLETED"
    | "FAILED"
    | "TIMED_OUT"
    | "CANCELLED"
    | "IN_QUEUE"
    | "IN_PROGRESS";
  /** Cold start / queue delay in milliseconds. */
  delayTime?: number;
  /** Actual execution time in milliseconds. */
  executionTime?: number;
  /** Output from the worker handler (our harness JSON). */
  output?: RunPodHarnessOutput | null;
  /** Error details if status is FAILED. */
  error?: string;
}

/** Shape returned by our Python container harness inside RunPod output. */
interface RunPodHarnessOutput {
  success: boolean;
  exit_code: GpuExitCode;
  result: unknown;
  duration_ms: number;
  peak_vram_gb: number;
  logs: string[];
  error?: {
    type: string;
    message: string;
    traceback?: string;
  };
}

/** RunPod endpoint object from REST API. */
interface RunPodEndpoint {
  id: string;
  name: string;
  workersMin: number;
  workersMax: number;
  idleTimeout: number;
  executionTimeoutMs: number;
  gpuTypeIds: string[];
  scalerType: string;
  scalerValue: number;
  workers?: Array<{ status?: string }>;
}

/** RunPod /health response (inferred from docs + community). */
interface RunPodHealthResponse {
  jobs: {
    completed: number;
    failed: number;
    inProgress: number;
    inQueue: number;
    retried: number;
  };
  workers: {
    idle: number;
    initializing: number;
    ready: number;
    running: number;
    throttled: number;
  };
}

interface RunPodGraphQLError {
  message: string;
}

interface RunPodGraphQLResponse<T> {
  data?: T;
  errors?: RunPodGraphQLError[];
}

interface RunPodTiming {
  executionDurationMs: number;
  delayTimeMs: number;
  billableDurationMs: number;
}

function positiveMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function getRunPodTiming(
  response: RunPodSyncResponse,
  harnessDurationMs?: number,
): RunPodTiming {
  const executionDurationMs = positiveMs(harnessDurationMs) ||
    positiveMs(response.executionTime);
  const delayTimeMs = positiveMs(response.delayTime);
  return {
    executionDurationMs,
    delayTimeMs,
    billableDurationMs: computeGpuBillableDurationMs(delayTimeMs + executionDurationMs),
  };
}

// ---------------------------------------------------------------------------
// RunPod Provider Implementation
// ---------------------------------------------------------------------------

export class RunPodProvider implements GPUProvider {
  readonly name = "runpod";
  private apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("RunPod API key is required");
    }
    this.apiKey = apiKey;
  }

  // -----------------------------------------------------------------------
  // buildContainer
  // -----------------------------------------------------------------------

  async buildContainer(
    params: BuildContainerParams,
  ): Promise<BuildContainerResult> {
    const { appId, version, config } = params;
    const buildLogs: string[] = [];

    const runpodGpuType = GPU_TYPE_TO_RUNPOD[config.gpu_type];
    if (!runpodGpuType) {
      throw new Error(`Unsupported GPU type for RunPod: ${config.gpu_type}`);
    }

    buildLogs.push(`[build] Starting container build for ${appId}@${version}`);
    buildLogs.push(
      `[build] GPU type: ${config.gpu_type} → RunPod: ${runpodGpuType}`,
    );
    buildLogs.push(`[build] Python: ${config.python || "3.11"}`);

    // Phase 2 will handle actual Docker image building and template creation.
    // For Phase 1, we create the endpoint with a placeholder template.
    // The builder service (Phase 2) will:
    //   1. Generate Dockerfile from base image + developer code + harness
    //   2. Build and push to container registry
    //   3. Create RunPod template from the pushed image
    //   4. Create endpoint from the template
    //
    // For now, we validate the endpoint creation API flow.

    const templateId = await this.getOrCreateTemplate(params, buildLogs);

    // Create serverless endpoint
    const endpoint = await this.createEndpoint({
      name: `ul-${appId.slice(0, 8)}-${version}`,
      templateId,
      gpuTypeIds: [runpodGpuType],
      scalerType: "QUEUE_DELAY",
      scalerValue: 4,
      workersMin: 0,
      workersMax: 5, // Default concurrency, configurable later
      idleTimeout: 5,
      executionTimeoutMs: (config.max_duration_ms || 60_000) +
        GPU_COLD_START_BUFFER_MS,
    });

    buildLogs.push(`[build] RunPod endpoint created: ${endpoint.id}`);
    buildLogs.push(`[build] Endpoint name: ${endpoint.name}`);

    return {
      endpointId: endpoint.id,
      buildLogs,
    };
  }

  // -----------------------------------------------------------------------
  // execute
  // -----------------------------------------------------------------------

  async execute(params: ExecuteParams): Promise<GpuExecutionResult> {
    const { endpointId, functionName, args, maxDurationMs } = params;

    const url = `${RUNPOD_API_BASE}/${endpointId}/runsync`;
    const timeoutMs = maxDurationMs + GPU_COLD_START_BUFFER_MS;

    const body = {
      input: {
        function: functionName,
        args,
        max_duration_ms: maxDurationMs,
      },
      policy: {
        executionTimeout: timeoutMs,
      },
    };

    const response = await this.fetchWithRetry<RunPodSyncResponse>(url, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs,
    });

    return this.mapRunPodResponse(response);
  }

  // -----------------------------------------------------------------------
  // getEndpointStatus
  // -----------------------------------------------------------------------

  async getEndpointStatus(endpointId: string): Promise<EndpointStatus> {
    // Try health endpoint first (gives worker/queue info)
    try {
      const health = await this.fetchRunPod<RunPodHealthResponse>(
        `${RUNPOD_API_BASE}/${endpointId}/health`,
        { method: "GET" },
      );

      const totalWorkers = (health.workers?.ready || 0) +
        (health.workers?.running || 0) +
        (health.workers?.idle || 0);

      const queueDepth = health.jobs?.inQueue || 0;

      return {
        status: "active",
        workers: totalWorkers,
        queueDepth,
      };
    } catch (err) {
      // If health check fails, try the REST API for endpoint info
      try {
        const endpoint = await this.fetchRunPod<RunPodEndpoint>(
          `${RUNPOD_REST_BASE}/endpoints/${endpointId}`,
          { method: "GET" },
        );

        if (!endpoint || !endpoint.id) {
          return { status: "not_found", workers: 0, queueDepth: 0 };
        }

        return {
          status: "active",
          workers: endpoint.workers?.length || 0,
          queueDepth: 0,
        };
      } catch (innerErr) {
        // Both failed — endpoint probably doesn't exist
        const errMsg = innerErr instanceof Error
          ? innerErr.message
          : String(innerErr);
        if (errMsg.includes("404") || errMsg.includes("Not Found")) {
          return { status: "not_found", workers: 0, queueDepth: 0 };
        }
        return { status: "error", workers: 0, queueDepth: 0 };
      }
    }
  }

  // -----------------------------------------------------------------------
  // deleteEndpoint
  // -----------------------------------------------------------------------

  async deleteEndpoint(endpointId: string): Promise<void> {
    await this.fetchRunPod<void>(
      `${RUNPOD_REST_BASE}/endpoints/${endpointId}`,
      { method: "DELETE" },
    );
  }

  // -----------------------------------------------------------------------
  // getSupportedGpuTypes
  // -----------------------------------------------------------------------

  getSupportedGpuTypes(): GpuType[] {
    return [...GPU_TYPES];
  }

  // -----------------------------------------------------------------------
  // Private: Template Management
  // -----------------------------------------------------------------------

  /**
   * Create a per-app RunPod template with env vars pointing to the app's code.
   *
   * Uses the shared base Docker image (RUNPOD_BASE_IMAGE) but creates a unique
   * template per app+version with environment variables that tell the harness
   * where to download the developer's code from R2.
   *
   * Shared-template fallback is disabled by default because the harness must be
   * given an app-specific code URL to avoid running baked-in placeholder code.
   */
  private async getOrCreateTemplate(
    params: BuildContainerParams,
    buildLogs: string[],
  ): Promise<string> {
    const allowSharedTemplateFallback =
      getEnv("RUNPOD_ALLOW_SHARED_TEMPLATE_FALLBACK") === "true";
    const templateResolution = resolveRunPodTemplateResolution({
      appId: params.appId,
      version: params.version,
      baseImage: getEnv("RUNPOD_BASE_IMAGE"),
      platformUrl: getEnv("PLATFORM_URL") || getEnv("APP_URL"),
      gpuSecret: getEnv("GPU_INTERNAL_SECRET"),
      sharedTemplateId: getEnv("RUNPOD_TEMPLATE_ID"),
      allowSharedTemplateFallback,
    });

    if (templateResolution.mode === "per_app") {
      try {
        buildLogs.push(
          `[build] Creating per-app template for ${params.appId}@${params.version}`,
        );
        buildLogs.push(`[build] Base image: ${templateResolution.imageName}`);
        buildLogs.push(`[build] Code URL: ${templateResolution.codeUrl}`);

        const templateName = `ul-${params.appId.slice(0, 8)}-${params.version}`
          .slice(0, 191);
        const template = await this.createTemplate({
          name: templateName,
          imageName: templateResolution.imageName,
          isServerless: true,
          env: templateResolution.env,
          containerDiskInGb: 20,
        });

        buildLogs.push(`[build] Per-app template created: ${template.id}`);
        return template.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!allowSharedTemplateFallback) {
          buildLogs.push(
            `[build] ERROR: Per-app template creation failed: ${msg}`,
          );
          throw new Error(
            "Per-app GPU template creation failed and shared fallback is disabled. " +
              `Original error: ${msg}`,
          );
        }
        buildLogs.push(
          `[build] WARNING: Per-app template creation failed: ${msg}`,
        );
        buildLogs.push(
          "[build] Falling back to legacy shared template because RUNPOD_ALLOW_SHARED_TEMPLATE_FALLBACK=true",
        );
        const sharedTemplateId = getEnv("RUNPOD_TEMPLATE_ID");
        if (!sharedTemplateId) {
          throw new Error(
            "RUNPOD_ALLOW_SHARED_TEMPLATE_FALLBACK=true requires RUNPOD_TEMPLATE_ID to be configured.",
          );
        }
        buildLogs.push(
          `[build] Using shared template (fallback): ${sharedTemplateId}`,
        );
        return sharedTemplateId;
      }
    }

    buildLogs.push(`[build] WARNING: ${templateResolution.warning}`);
    buildLogs.push(
      `[build] Using shared template (fallback): ${templateResolution.templateId}`,
    );
    return templateResolution.templateId;
  }

  /**
   * Create a RunPod template via GraphQL API.
   *
   * Uses GraphQL instead of REST because RunPod's REST API has a bug where
   * serverless templates reject volumeInGb even when not specified (defaults to 20).
   * The GraphQL API requires explicit volumeInGb: 0 for serverless templates, which works.
   */
  private async createTemplate(config: {
    name: string;
    imageName: string;
    isServerless: boolean;
    env: Record<string, string>;
    containerDiskInGb: number;
  }): Promise<{ id: string; name: string }> {
    const envArray = Object.entries(config.env).map(([key, value]) =>
      `{key: "${key}", value: "${value.replace(/"/g, '\\"')}"}`
    ).join(", ");

    const mutation = `mutation {
      saveTemplate(input: {
        name: "${config.name.replace(/"/g, '\\"')}",
        imageName: "${config.imageName.replace(/"/g, '\\"')}",
        isServerless: ${config.isServerless},
        containerDiskInGb: ${config.containerDiskInGb},
        volumeInGb: 0,
        dockerArgs: "",
        env: [${envArray}]
      }) {
        id
        name
        imageName
        isServerless
      }
    }`;

    const response = await this.fetchGraphQL<{
      saveTemplate: {
        id: string;
        name: string;
        imageName: string;
        isServerless: boolean;
      };
    }>(mutation);

    return response.saveTemplate;
  }

  /**
   * Delete a RunPod template via GraphQL API.
   * Template must not be in use by any endpoints.
   */
  async deleteTemplate(templateName: string): Promise<void> {
    const mutation = `mutation {
      deleteTemplate(templateName: "${templateName.replace(/"/g, '\\"')}")
    }`;
    await this.fetchGraphQL(mutation);
  }

  // -----------------------------------------------------------------------
  // Private: Endpoint Creation
  // -----------------------------------------------------------------------

  private async createEndpoint(config: {
    name: string;
    templateId: string;
    gpuTypeIds: string[];
    scalerType: string;
    scalerValue: number;
    workersMin: number;
    workersMax: number;
    idleTimeout: number;
    executionTimeoutMs: number;
  }): Promise<RunPodEndpoint> {
    return this.fetchRunPod<RunPodEndpoint>(
      `${RUNPOD_REST_BASE}/endpoints`,
      {
        method: "POST",
        body: JSON.stringify(config),
      },
    );
  }

  // -----------------------------------------------------------------------
  // Private: Response Mapping
  // -----------------------------------------------------------------------

  /**
   * Map a RunPod /runsync response to our GpuExecutionResult.
   *
   * RunPod reports delayTime (queue/cold-start) and executionTime separately.
   * We pass both through to billing and round delay + execution to the provider
   * billing increment so cold starts do not become platform losses.
   */
  private mapRunPodResponse(response: RunPodSyncResponse): GpuExecutionResult {
    // If harness output is present and structured, use it directly
    if (
      response.output && typeof response.output === "object" &&
      "exit_code" in response.output
    ) {
      const harness = response.output as RunPodHarnessOutput;
      const timing = getRunPodTiming(response, harness.duration_ms);
      return {
        success: harness.success,
        exit_code: harness.exit_code,
        result: harness.result,
        duration_ms: timing.executionDurationMs,
        delay_time_ms: timing.delayTimeMs,
        billable_duration_ms: timing.billableDurationMs,
        billing_increment_ms: GPU_BILLING_INCREMENT_MS,
        peak_vram_gb: harness.peak_vram_gb || 0,
        logs: harness.logs || [],
        error: harness.error,
      };
    }

    // No harness output — map RunPod status to our exit codes
    switch (response.status) {
      case "COMPLETED":
        {
          const timing = getRunPodTiming(response);
          return {
            success: true,
            exit_code: "success",
            result: response.output,
            duration_ms: timing.executionDurationMs,
            delay_time_ms: timing.delayTimeMs,
            billable_duration_ms: timing.billableDurationMs,
            billing_increment_ms: GPU_BILLING_INCREMENT_MS,
            peak_vram_gb: 0,
            logs: [],
          };
        }

      case "TIMED_OUT":
        {
          const timing = getRunPodTiming(response);
          return {
            success: false,
            exit_code: "timeout",
            result: null,
            duration_ms: timing.executionDurationMs,
            delay_time_ms: timing.delayTimeMs,
            billable_duration_ms: timing.billableDurationMs,
            billing_increment_ms: GPU_BILLING_INCREMENT_MS,
            peak_vram_gb: 0,
            logs: [],
            error: {
              type: "TimeoutError",
              message: `Execution timed out after ${timing.executionDurationMs}ms`,
            },
          };
        }

      case "FAILED":
        {
          const timing = getRunPodTiming(response);
          return {
            success: false,
            exit_code: this.classifyRunPodError(response.error),
            result: null,
            duration_ms: timing.executionDurationMs,
            delay_time_ms: timing.delayTimeMs,
            billable_duration_ms: timing.billableDurationMs,
            billing_increment_ms: GPU_BILLING_INCREMENT_MS,
            peak_vram_gb: 0,
            logs: [],
            error: {
              type: "RunPodError",
              message: response.error || "Unknown RunPod execution error",
            },
          };
        }

      case "CANCELLED":
        return {
          success: false,
          exit_code: "infra_error",
          result: null,
          duration_ms: 0,
          delay_time_ms: positiveMs(response.delayTime),
          billable_duration_ms: 0,
          billing_increment_ms: GPU_BILLING_INCREMENT_MS,
          peak_vram_gb: 0,
          logs: [],
          error: {
            type: "CancelledError",
            message: "Job was cancelled",
          },
        };

      default:
        // IN_QUEUE or IN_PROGRESS shouldn't reach here on /runsync,
        // but handle defensively
        return {
          success: false,
          exit_code: "infra_error",
          result: null,
          duration_ms: 0,
          delay_time_ms: positiveMs(response.delayTime),
          billable_duration_ms: 0,
          billing_increment_ms: GPU_BILLING_INCREMENT_MS,
          peak_vram_gb: 0,
          logs: [],
          error: {
            type: "UnexpectedStatus",
            message: `Unexpected RunPod status: ${response.status}`,
          },
        };
    }
  }

  /**
   * Classify a RunPod error string into our exit code taxonomy.
   * OOM errors from RunPod/CUDA are distinguishable by error message patterns.
   */
  private classifyRunPodError(error?: string): GpuExitCode {
    if (!error) return "exception";

    const lower = error.toLowerCase();
    // OOM: match CUDA memory errors specifically, not all CUDA errors
    if (
      lower.includes("out of memory") ||
      lower.includes("oom") ||
      (lower.includes("cuda") &&
        (lower.includes("memory") || lower.includes("alloc")))
    ) {
      return "oom";
    }
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return "timeout";
    }
    // CUDA non-memory errors are infrastructure issues (driver, init, etc.)
    if (
      lower.includes("cuda error") ||
      lower.includes("cuda driver") ||
      lower.includes("cuda init") ||
      lower.includes("container") ||
      lower.includes("worker") ||
      lower.includes("network") ||
      lower.includes("failed to start")
    ) {
      return "infra_error";
    }
    return "exception";
  }

  // -----------------------------------------------------------------------
  // Private: HTTP Helpers
  // -----------------------------------------------------------------------

  /**
   * Make an authenticated request to RunPod's GraphQL API.
   * Used for template management (create/delete).
   */
  private async fetchGraphQL<T>(query: string): Promise<T> {
    const url = `${RUNPOD_GRAPHQL_BASE}?api_key=${this.apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });

      const json = await response.json() as RunPodGraphQLResponse<T>;

      if (json.errors && json.errors.length > 0) {
        const messages = json.errors.map((e: { message: string }) => e.message)
          .join("; ");
        throw new Error(`RunPod GraphQL error: ${messages}`);
      }

      if (json.data === undefined) {
        throw new Error("RunPod GraphQL response missing data");
      }

      return json.data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Make an authenticated request to RunPod API.
   * Throws on non-2xx responses with descriptive error messages.
   */
  private async fetchRunPod<T>(
    url: string,
    options: {
      method: string;
      body?: string;
      timeoutMs?: number;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = options.timeoutMs || 30_000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: options.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;

        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message ||
            errorText;
        } catch {
          errorMessage = errorText;
        }

        throw new Error(
          `RunPod API error (${response.status}): ${errorMessage}`,
        );
      }

      // DELETE returns no body
      if (options.method === "DELETE") {
        return undefined as unknown as T;
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch with retry on 5xx errors. No retry on 4xx (client errors).
   */
  private async fetchWithRetry<T>(
    url: string,
    options: {
      method: string;
      body?: string;
      timeoutMs?: number;
    },
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.fetchRunPod<T>(url, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Only retry on 5xx (match status codes like "(500)", "(502)", etc.)
        const is5xx = /\(5\d{2}\)/.test(lastError.message);
        if (!is5xx || attempt === MAX_RETRIES) {
          throw lastError;
        }

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }

    throw lastError || new Error("RunPod request failed after retries");
  }
}
