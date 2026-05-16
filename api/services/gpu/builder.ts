// GPU Compute Runtime - Container Builder Service.
// Orchestrates platform-owned image builds and RunPod endpoint creation.

import type { GpuConfig } from "./types.ts";
import type { App } from "../../../shared/types/index.ts";
import { getGPUProvider } from "./provider-singleton.ts";
import { resolveRunPodTemplateResolution } from "./runpod.ts";
import { createAppsService } from "../apps.ts";
import { createR2Service } from "../storage.ts";
import { getEnv } from "../../lib/env.ts";
import { setAppStorageBytes } from "../storage-quota.ts";
import {
  buildTargetImageRef,
  dispatchGpuImageBuild,
  type GpuImageBuildCallbackPayload,
  resolveGpuImageBuildReadiness,
} from "./image-builder.ts";
import {
  getGpuSupportDisabledMessage,
  isGpuSupportEnabled,
} from "./feature-flag.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GpuBuildPreflightResult {
  ok: boolean;
  status: "ready" | "build_config_invalid";
  message: string;
  template_mode?: "image" | "per_app" | "shared";
  build_mode?: "ghcr_image" | "runpod_template";
}

export class GpuBuildPreflightError extends Error {
  readonly status = 503;
  readonly gpuStatus = "build_config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "GpuBuildPreflightError";
  }
}

export function resolveGpuBuildPreflight(
  appId: string,
  version: string,
): GpuBuildPreflightResult {
  if (!isGpuSupportEnabled()) {
    return {
      ok: false,
      status: "build_config_invalid",
      message: getGpuSupportDisabledMessage("GPU deployments"),
    };
  }

  if (!getEnv("RUNPOD_API_KEY")) {
    return {
      ok: false,
      status: "build_config_invalid",
      message:
        "GPU compute is not configured. RUNPOD_API_KEY environment variable is required.",
    };
  }

  const imageReadiness = resolveGpuImageBuildReadiness();
  if (imageReadiness.ok) {
    if (!getEnv("RUNPOD_CONTAINER_REGISTRY_AUTH_ID")) {
      return {
        ok: false,
        status: "build_config_invalid",
        message:
          "GPU image build requires RUNPOD_CONTAINER_REGISTRY_AUTH_ID so RunPod can pull private GHCR images.",
      };
    }
    return {
      ok: true,
      status: "ready",
      message: "GPU image build configuration is ready.",
      template_mode: "image",
      build_mode: "ghcr_image",
    };
  }

  try {
    const resolution = resolveRunPodTemplateResolution({
      appId,
      version,
      baseImage: getEnv("RUNPOD_BASE_IMAGE") || undefined,
      platformUrl: getEnv("PLATFORM_URL") || getEnv("APP_URL") || undefined,
      gpuSecret: getEnv("GPU_INTERNAL_SECRET") || undefined,
      sharedTemplateId: getEnv("RUNPOD_TEMPLATE_ID") || undefined,
      allowSharedTemplateFallback:
        getEnv("RUNPOD_ALLOW_SHARED_TEMPLATE_FALLBACK") === "true",
    });

    return {
      ok: true,
      status: "ready",
      message: resolution.mode === "shared"
        ? resolution.warning
        : "GPU build configuration is ready.",
      template_mode: resolution.mode,
      build_mode: "runpod_template",
    };
  } catch (err) {
    return {
      ok: false,
      status: "build_config_invalid",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function assertGpuBuildPreflight(
  appId: string,
  version: string,
): GpuBuildPreflightResult {
  const preflight = resolveGpuBuildPreflight(appId, version);
  if (!preflight.ok) {
    throw new GpuBuildPreflightError(preflight.message);
  }
  return preflight;
}

/**
 * Trigger an async GPU build.
 *
 * Preferred path:
 *   1. package developer code into a Docker build context,
 *   2. dispatch GitHub Actions to build/push a GHCR image,
 *   3. wait for the callback to create the RunPod endpoint.
 *
 * Legacy path:
 *   create a RunPod template from a shared runtime image and load code from R2
 *   on worker startup.
 */
export async function triggerGpuBuild(
  appId: string,
  version: string,
  files: Array<{ name: string; content: string }>,
  config: GpuConfig,
): Promise<void> {
  const appsService = createAppsService();
  const buildLogs: string[] = [];

  try {
    buildLogs.push(`[build] Starting GPU build for ${appId}@${version}`);
    buildLogs.push(`[build] GPU type: ${config.gpu_type}`);
    buildLogs.push(`[build] Python: ${config.python || "3.11"}`);
    buildLogs.push(`[build] Files: ${files.length}`);

    const preflight = assertGpuBuildPreflight(appId, version);
    buildLogs.push(
      `[build] Preflight ready (${preflight.build_mode || "unknown"}/${
        preflight.template_mode || "unknown"
      })`,
    );

    // Keep a source bundle for audit/debugging and as the legacy runtime input.
    const bundle = {
      files: Object.fromEntries(
        files.map((f) => {
          const fileName = f.name.split("/").pop() || f.name;
          return [fileName, f.content];
        }),
      ),
      version,
      created_at: new Date().toISOString(),
    };
    const r2 = createR2Service();
    const bundleKey = `apps/${appId}/${version}/_bundle.json`;
    const bundleBytes = new TextEncoder().encode(JSON.stringify(bundle));
    await r2.uploadFile(bundleKey, {
      name: "_bundle.json",
      content: bundleBytes,
      contentType: "application/json",
    });
    buildLogs.push(
      `[build] Code bundle uploaded to R2: ${bundleKey} (${bundleBytes.length} bytes)`,
    );

    const hasRequirements = files.some((f) => {
      const fileName = f.name.split("/").pop() || f.name;
      return fileName === "requirements.txt";
    });
    const dockerfile = generateDockerfile(config, hasRequirements);
    buildLogs.push("[build] Reference Dockerfile generated");

    if (preflight.build_mode === "ghcr_image") {
      const imageBuild = await dispatchGpuImageBuild({
        appId,
        version,
        files,
        config,
        buildLogs,
      });

      await storeBuildArtifacts(
        appId,
        version,
        imageBuild.dockerfile,
        buildLogs,
      );
      buildLogs.push("[build] Build artifacts stored to R2");

      await appsService.update(appId, {
        gpu_image_ref: imageBuild.targetImage,
        gpu_base_profile: config.base || "python-cuda",
        gpu_build_provider: "github_actions",
        gpu_build_run_id: imageBuild.buildId,
        gpu_build_started_at: new Date().toISOString(),
        gpu_build_finished_at: null,
        gpu_build_error: null,
      } as Partial<App>);

      await insertGpuBuildEvent({
        appId,
        version,
        runId: imageBuild.buildId,
        stage: "dispatch",
        status: "dispatched",
        message:
          `Dispatched GitHub Actions image build for ${imageBuild.targetImage}`,
        metadata: {
          target_image: imageBuild.targetImage,
          base_image: imageBuild.baseImage,
          context_expires_at: imageBuild.expiresAt,
        },
      });

      console.log(
        `[GPU-BUILD] Image build dispatched for ${appId}: ${imageBuild.targetImage}`,
      );
      return;
    }

    const provider = getGPUProvider();
    const buildResult = await provider.buildContainer({
      appId,
      version,
      codeFiles: files,
      config,
      requirements: files.find((f) => {
        const fileName = f.name.split("/").pop() || f.name;
        return fileName === "requirements.txt";
      })?.content,
    });

    buildLogs.push(
      `[build] RunPod endpoint created: ${buildResult.endpointId}`,
    );
    buildLogs.push(...buildResult.buildLogs);

    await storeBuildArtifacts(appId, version, dockerfile, buildLogs);
    buildLogs.push("[build] Build artifacts stored to R2");

    await appsService.update(appId, {
      gpu_endpoint_id: buildResult.endpointId,
      gpu_build_provider: "runpod_template",
    } as Partial<App>);
    buildLogs.push("[build] App record updated with endpoint ID");

    await insertGpuEndpoint(
      appId,
      version,
      buildResult.endpointId,
      config.gpu_type,
      buildLogs,
      { buildProvider: "runpod_template" },
    );

    console.log(
      `[GPU-BUILD] Build complete for ${appId}, endpoint: ${buildResult.endpointId}`,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    buildLogs.push(`[build] ERROR: ${errorMsg}`);
    console.error(`[GPU-BUILD] Build failed for ${appId}:`, err);

    try {
      await appsService.update(appId, {
        gpu_status: err instanceof GpuBuildPreflightError
          ? "build_config_invalid"
          : "build_failed",
        gpu_build_error: errorMsg,
        gpu_build_finished_at: new Date().toISOString(),
      } as Partial<App>);
    } catch (updateErr) {
      console.error(
        `[GPU-BUILD] Failed to update status for ${appId}:`,
        updateErr,
      );
    }

    try {
      await storeBuildArtifacts(appId, version, "", buildLogs);
    } catch {
      // Logging failure should not mask build failure.
    }
  }
}

export async function completeGpuImageBuild(
  payload: GpuImageBuildCallbackPayload,
): Promise<
  { ok: boolean; status: string; endpointId?: string; message: string }
> {
  const appId = payload.app_id || "";
  const version = payload.version || "";
  const runId = payload.build_id || "";
  const status = payload.status || "";
  const buildLogs: string[] = [
    `[build] GitHub Actions callback received for ${appId}@${version}`,
    `[build] Status: ${status}`,
  ];

  if (!appId || !version || !runId) {
    return {
      ok: false,
      status: "invalid_callback",
      message: "GPU image build callback missing app_id, version, or build_id.",
    };
  }

  const appsService = createAppsService();
  const app = await appsService.findById(appId);
  if (!app) {
    await insertGpuBuildEvent({
      appId,
      version,
      runId,
      stage: "callback",
      status: "not_found",
      message: "App not found for GPU image build callback.",
      metadata: payload as Record<string, unknown>,
    });
    return { ok: false, status: "not_found", message: "App not found." };
  }

  const imageRef = payload.image_ref || app.gpu_image_ref ||
    buildTargetImageRef(appId, version);
  const imageDigest = payload.image_digest || undefined;
  const imageSizeBytes = normalizeNonNegativeInteger(payload.image_size_bytes);
  const config = app.gpu_config as GpuConfig | null;

  if (status !== "success") {
    const errorMessage = payload.error || "GPU image build failed.";
    buildLogs.push(`[build] ERROR: ${errorMessage}`);
    await appsService.update(appId, {
      gpu_status: "build_failed",
      gpu_build_error: errorMessage,
      gpu_build_finished_at: new Date().toISOString(),
    } as Partial<App>);
    await insertGpuBuildEvent({
      appId,
      version,
      runId,
      stage: "build",
      status: "failed",
      message: errorMessage,
      metadata: payload as Record<string, unknown>,
    });
    await storeBuildArtifacts(appId, version, "", buildLogs).catch(() => {});
    return { ok: false, status: "build_failed", message: errorMessage };
  }

  if (!config || config.runtime !== "gpu" || !config.gpu_type) {
    const message =
      "GPU image build completed, but app GPU config is missing or invalid.";
    buildLogs.push(`[build] ERROR: ${message}`);
    await appsService.update(appId, {
      gpu_status: "build_config_invalid",
      gpu_build_error: message,
      gpu_build_finished_at: new Date().toISOString(),
    } as Partial<App>);
    await insertGpuBuildEvent({
      appId,
      version,
      runId,
      stage: "callback",
      status: "invalid_config",
      message,
      metadata: payload as Record<string, unknown>,
    });
    await storeBuildArtifacts(appId, version, "", buildLogs).catch(() => {});
    return { ok: false, status: "build_config_invalid", message };
  }

  const provider = getGPUProvider();
  const buildResult = await provider.buildContainer({
    appId,
    version,
    codeFiles: [],
    config,
    imageRef,
    imageDigest,
  });
  buildLogs.push(`[build] RunPod endpoint created: ${buildResult.endpointId}`);
  buildLogs.push(...buildResult.buildLogs);

  const buildCostLight = await chargeGpuImageBuildCost(app, payload, true);
  const imageUserStorageBytes = computeGpuImageUserStorageBytes(
    config,
    imageSizeBytes,
  );

  await appsService.update(appId, {
    gpu_endpoint_id: buildResult.endpointId,
    gpu_image_ref: imageRef,
    gpu_image_digest: imageDigest || null,
    gpu_base_profile: config.base || "python-cuda",
    gpu_build_provider: "github_actions",
    gpu_build_run_id: runId,
    gpu_build_cost_light: buildCostLight,
    gpu_build_finished_at: new Date().toISOString(),
    gpu_build_error: null,
    gpu_image_size_bytes: imageSizeBytes,
    gpu_image_user_storage_bytes: imageUserStorageBytes,
  } as Partial<App>);

  if (imageUserStorageBytes > 0) {
    const sourceBytes = normalizeNonNegativeInteger(app.storage_bytes);
    await setAppStorageBytes(
      app.owner_id,
      appId,
      sourceBytes + imageUserStorageBytes,
    ).catch((err) => {
      console.error(
        `[GPU-BUILD] Failed to account GPU image storage for ${appId}:`,
        err,
      );
    });
  }

  await insertGpuEndpoint(
    appId,
    version,
    buildResult.endpointId,
    config.gpu_type,
    buildLogs,
    {
      imageRef,
      imageDigest,
      baseProfile: config.base || "python-cuda",
      buildProvider: "github_actions",
      buildRunId: runId,
      buildCostLight,
      imageSizeBytes,
      imageUserStorageBytes,
    },
  );
  await insertGpuBuildEvent({
    appId,
    version,
    runId,
    stage: "provision",
    status: "endpoint_created",
    message: `RunPod endpoint created: ${buildResult.endpointId}`,
    metadata: {
      image_ref: imageRef,
      image_digest: imageDigest,
      image_size_bytes: imageSizeBytes,
      image_user_storage_bytes: imageUserStorageBytes,
      build_cost_light: buildCostLight,
    },
  });
  await storeBuildArtifacts(appId, version, "", buildLogs).catch(() => {});

  return {
    ok: true,
    status: "endpoint_created",
    endpointId: buildResult.endpointId,
    message: `RunPod endpoint created: ${buildResult.endpointId}`,
  };
}

// ---------------------------------------------------------------------------
// Dockerfile Generation
// ---------------------------------------------------------------------------

export function generateDockerfile(
  config: GpuConfig,
  hasRequirements: boolean,
): string {
  const pythonVersion = config.python || "3.11";

  const lines = [
    "# Ultralight GPU Container - auto-generated reference",
    `# GPU: ${config.gpu_type} | Python: ${pythonVersion}`,
    `# Generated: ${new Date().toISOString()}`,
    "",
    `FROM python:${pythonVersion}-slim-bookworm`,
    "",
    "# Install CUDA runtime + RunPod SDK (base layer - cached)",
    "RUN pip install --no-cache-dir runpod",
    "",
  ];

  if (hasRequirements) {
    lines.push(
      "# Install developer dependencies",
      "COPY requirements.txt /app/requirements.txt",
      "RUN pip install --no-cache-dir -r /app/requirements.txt",
      "",
    );
  }

  lines.push(
    "# Copy developer code",
    "COPY . /app",
    "WORKDIR /app",
    "",
    "# Copy platform harness (entry point)",
    "COPY harness.py /app/harness.py",
    "",
    'CMD ["python", "-u", "/app/harness.py"]',
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function storeBuildArtifacts(
  appId: string,
  version: string,
  dockerfile: string,
  buildLogs: string[],
): Promise<void> {
  const r2 = createR2Service();
  const prefix = `apps/${appId}/${version}/_build/`;
  const artifacts: Array<
    { name: string; content: Uint8Array; contentType: string }
  > = [];

  if (dockerfile) {
    artifacts.push({
      name: "Dockerfile",
      content: new TextEncoder().encode(dockerfile),
      contentType: "text/plain",
    });
  }

  artifacts.push({
    name: "build.log",
    content: new TextEncoder().encode(buildLogs.join("\n")),
    contentType: "text/plain",
  });

  await r2.uploadFiles(prefix, artifacts);
}

interface InsertGpuEndpointMetadata {
  imageRef?: string;
  imageDigest?: string;
  baseProfile?: string;
  buildProvider?: string;
  buildRunId?: string;
  buildCostLight?: number;
  imageSizeBytes?: number;
  imageUserStorageBytes?: number;
}

async function insertGpuEndpoint(
  appId: string,
  version: string,
  endpointId: string,
  gpuType: string,
  buildLogs: string[],
  metadata: InsertGpuEndpointMetadata = {},
): Promise<void> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error(
      "[GPU-BUILD] Supabase not configured, skipping gpu_endpoints insert",
    );
    return;
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/gpu_endpoints`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${supabaseKey}`,
      "apikey": supabaseKey,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      app_id: appId,
      version,
      provider: "runpod",
      endpoint_id: endpointId,
      gpu_type: gpuType,
      status: "building",
      build_logs: buildLogs,
      build_started_at: new Date().toISOString(),
      image_ref: metadata.imageRef,
      image_digest: metadata.imageDigest,
      base_profile: metadata.baseProfile,
      build_provider: metadata.buildProvider,
      build_run_id: metadata.buildRunId,
      build_cost_light: metadata.buildCostLight,
      image_size_bytes: metadata.imageSizeBytes,
      image_user_storage_bytes: metadata.imageUserStorageBytes,
    }),
  });

  if (!response.ok) {
    console.error(
      `[GPU-BUILD] Failed to insert gpu_endpoints row: ${await response
        .text()}`,
    );
  }
}

async function insertGpuBuildEvent(input: {
  appId: string;
  version: string;
  runId?: string;
  stage: string;
  status: string;
  message?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error(
      "[GPU-BUILD] Supabase not configured, skipping gpu_build_events insert",
    );
    return;
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/gpu_build_events`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${supabaseKey}`,
      "apikey": supabaseKey,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      app_id: input.appId,
      version: input.version,
      provider: "github_actions",
      run_id: input.runId,
      stage: input.stage,
      status: input.status,
      message: input.message,
      metadata: input.metadata || {},
    }),
  });

  if (!response.ok) {
    console.error(
      `[GPU-BUILD] Failed to insert gpu_build_events row: ${await response
        .text()}`,
    );
  }
}

function computeGpuImageUserStorageBytes(
  config: GpuConfig,
  imageSizeBytes: number,
): number {
  if (imageSizeBytes <= 0) return 0;
  const baseSizeEnv = (config.base || "python-cuda") === "torch-cuda"
    ? getEnv("GPU_BASE_IMAGE_TORCH_CUDA_SIZE_BYTES")
    : getEnv("GPU_BASE_IMAGE_PYTHON_CUDA_SIZE_BYTES");
  const baseSizeBytes = normalizeNonNegativeInteger(Number(baseSizeEnv || 0));
  return Math.max(0, imageSizeBytes - baseSizeBytes);
}

async function chargeGpuImageBuildCost(
  app: App,
  payload: GpuImageBuildCallbackPayload,
  successful: boolean,
): Promise<number> {
  if (!successful) return 0;

  const lightPerMinute = Number(getEnv("GPU_BUILD_LIGHT_PER_MINUTE") || 0);
  if (!Number.isFinite(lightPerMinute) || lightPerMinute <= 0) {
    return 0;
  }

  const buildSeconds = normalizeNonNegativeInteger(payload.build_seconds);
  const billedMinutes = Math.max(1, Math.ceil(buildSeconds / 60));
  const estimatedCostLight =
    Math.round(billedMinutes * lightPerMinute * 10000) / 10000;

  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    console.error(
      "[GPU-BUILD] Supabase not configured, skipping image build debit",
    );
    return 0;
  }

  const headers = {
    "Authorization": `Bearer ${supabaseKey}`,
    "apikey": supabaseKey,
    "Content-Type": "application/json",
  };

  const debitResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/debit_light`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      p_user_id: app.owner_id,
      p_amount_light: estimatedCostLight,
      p_reason: "gpu_image_build",
      p_update_billed_at: false,
      p_allow_partial: true,
      p_app_id: app.id,
      p_function_name: null,
      p_metadata: {
        build_id: payload.build_id,
        version: payload.version,
        image_ref: payload.image_ref,
        image_digest: payload.image_digest,
        build_seconds: buildSeconds,
        billed_minutes: billedMinutes,
        light_per_minute: lightPerMinute,
      },
    }),
  });

  if (!debitResponse.ok) {
    console.error(
      `[GPU-BUILD] Image build debit failed for ${app.owner_id}:`,
      await debitResponse.text(),
    );
    return 0;
  }

  const rows = await debitResponse.json() as Array<{
    new_balance: number;
    amount_debited?: number;
  }>;
  const actualCostLight = typeof rows[0]?.amount_debited === "number"
    ? rows[0].amount_debited
    : estimatedCostLight;

  fetch(`${supabaseUrl}/rest/v1/billing_transactions`, {
    method: "POST",
    headers: { ...headers, "Prefer": "return=minimal" },
    body: JSON.stringify({
      user_id: app.owner_id,
      type: "charge",
      category: "gpu_image_build",
      description: `GPU image build - ${app.name || app.slug}@${
        payload.version || ""
      }`,
      app_id: app.id,
      app_name: app.name || app.slug,
      amount_cents: 0,
      amount_light: -actualCostLight,
      balance_after_light: rows[0]?.new_balance,
      metadata: {
        build_id: payload.build_id,
        version: payload.version,
        image_ref: payload.image_ref,
        image_digest: payload.image_digest,
        build_seconds: buildSeconds,
        billed_minutes: billedMinutes,
        light_per_minute: lightPerMinute,
      },
    }),
  }).catch(() => {});

  return actualCostLight;
}

function normalizeNonNegativeInteger(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}
