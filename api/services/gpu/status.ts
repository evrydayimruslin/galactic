import type { AppGpuStatus } from "../../../shared/types/index.ts";

export type GpuStatusPhase =
  | "unbuilt"
  | "building"
  | "benchmarking"
  | "ready"
  | "failed"
  | "misconfigured";

export interface GpuStatusDetails {
  status: string | null;
  phase: GpuStatusPhase;
  ready: boolean;
  transient: boolean;
  requires_reupload: boolean;
  requires_platform_fix: boolean;
  detail: string;
  remediation: string;
}

export interface GpuStatusDiagnostics extends GpuStatusDetails {
  type: "GPU_STATUS";
  app_id?: string;
  inspect_command: string | null;
}

export function resolveGpuStatusDetails(
  status: AppGpuStatus | string | null | undefined,
): GpuStatusDetails {
  const resolvedStatus = typeof status === "string" ? status : null;

  switch (resolvedStatus) {
    case "building":
      return {
        status: resolvedStatus,
        phase: "building",
        ready: false,
        transient: true,
        requires_reupload: false,
        requires_platform_fix: false,
        detail: "Container build is still in progress.",
        remediation: "Wait for the build to finish, then try again.",
      };
    case "benchmarking":
      return {
        status: resolvedStatus,
        phase: "benchmarking",
        ready: false,
        transient: true,
        requires_reupload: false,
        requires_platform_fix: false,
        detail: "Benchmark validation is still in progress.",
        remediation: "Wait for benchmarking to finish, then try again.",
      };
    case "build_failed":
      return {
        status: resolvedStatus,
        phase: "failed",
        ready: false,
        transient: false,
        requires_reupload: true,
        requires_platform_fix: false,
        detail: "The last container build failed.",
        remediation: "Re-upload the GPU app after fixing the build issue.",
      };
    case "benchmark_failed":
      return {
        status: resolvedStatus,
        phase: "failed",
        ready: false,
        transient: false,
        requires_reupload: true,
        requires_platform_fix: false,
        detail: "The benchmark step failed.",
        remediation:
          "Re-upload the GPU app after fixing the benchmark or runtime issue.",
      };
    case "build_config_invalid":
      return {
        status: resolvedStatus,
        phase: "misconfigured",
        ready: false,
        transient: false,
        requires_reupload: false,
        requires_platform_fix: true,
        detail: "The platform GPU build configuration is invalid.",
        remediation:
          "Fix the platform GPU environment or template configuration, then re-upload to retry.",
      };
    case "live":
      return {
        status: resolvedStatus,
        phase: "ready",
        ready: true,
        transient: false,
        requires_reupload: false,
        requires_platform_fix: false,
        detail: "GPU function is ready.",
        remediation: "No action needed.",
      };
    default:
      return {
        status: resolvedStatus,
        phase: "unbuilt",
        ready: false,
        transient: false,
        requires_reupload: true,
        requires_platform_fix: false,
        detail: "The GPU function has not been built yet.",
        remediation:
          "Upload or re-upload the GPU app after the GPU build configuration is fixed.",
      };
  }
}

export function buildGpuStatusDiagnostics(
  status: AppGpuStatus | string | null | undefined,
  options: { appId?: string } = {},
): GpuStatusDiagnostics {
  const details = resolveGpuStatusDetails(status);

  return {
    type: "GPU_STATUS",
    ...details,
    app_id: options.appId,
    inspect_command: options.appId
      ? `gx.discover({ scope: "inspect", app_id: "${options.appId}" })`
      : null,
  };
}

export function buildGpuNotReadyMessage(
  status: AppGpuStatus | string | null | undefined,
): string {
  const details = resolveGpuStatusDetails(status);
  return `GPU function is not ready (status: ${
    details.status ?? "null"
  }). ${details.detail} ${details.remediation}`;
}

export function buildGpuPublishBlockerMessage(
  status: AppGpuStatus | string | null | undefined,
): string {
  const details = resolveGpuStatusDetails(status);
  return `Cannot publish GPU app until gpu_status is 'live' (current: ${
    details.status ?? "null"
  }). ${details.detail} ${details.remediation}`;
}
