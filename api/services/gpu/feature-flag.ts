import { getEnv } from "../../lib/env.ts";

export const GPU_SUPPORT_FLAG_ENV = "GPU_SUPPORT_ENABLED";

const ENABLED_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

export function isGpuSupportEnabled(): boolean {
  return ENABLED_VALUES.has(getEnv(GPU_SUPPORT_FLAG_ENV).trim().toLowerCase());
}

export function getGpuSupportDisabledMessage(capability = "GPU support"): string {
  return `${capability} is disabled for the MVP launch. Set ${GPU_SUPPORT_FLAG_ENV}=true to re-enable GPU deployments and runtime execution.`;
}

export function createGpuSupportDisabledError(
  capability = "GPU support",
): Error & { status: number } {
  const err = new Error(getGpuSupportDisabledMessage(capability)) as Error & {
    status: number;
  };
  err.status = 503;
  return err;
}

export function assertGpuSupportEnabled(capability = "GPU support"): void {
  if (!isGpuSupportEnabled()) {
    throw createGpuSupportDisabledError(capability);
  }
}

type GpuTrustCardLike = {
  runtime?: string | null;
  permissions?: string[];
  capability_summary?: Record<string, unknown>;
};

export function sanitizeGpuTrustCard<T extends GpuTrustCardLike | null | undefined>(
  trustCard: T,
): T {
  if (isGpuSupportEnabled() || !trustCard) return trustCard;

  return {
    ...trustCard,
    runtime: trustCard.runtime === "gpu" ? "deno" : trustCard.runtime,
    permissions: Array.isArray(trustCard.permissions)
      ? trustCard.permissions.filter((permission) => permission !== "gpu:execute")
      : trustCard.permissions,
    capability_summary: trustCard.capability_summary
      ? { ...trustCard.capability_summary, gpu: false }
      : trustCard.capability_summary,
  } as T;
}
