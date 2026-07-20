import type { Env } from "../../lib/env.ts";

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CANARY_ENTRY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ComputeRuntimeConfig {
  enabled: boolean;
  environmentDigest: string | null;
  rolloutMode: "canary" | "global" | null;
  canaryAllowlist: string[];
  ready: boolean;
  missing: Array<
    | "feature_flag"
    | "environment_digest"
    | "execution_plane"
    | "dispatch_queue"
    | "artifact_bucket"
    | "token_pepper"
    | "rollout_policy"
  >;
}

/**
 * One fail-closed readiness decision for admission. Existing runs may still
 * drain through private lifecycle/gateway handlers while `enabled` is false;
 * only creation is gated by this result.
 */
export function resolveComputeRuntimeConfig(
  env: Partial<Env> | null | undefined,
): ComputeRuntimeConfig {
  const enabled = env?.COMPUTE_ENABLED === "1";
  const rawDigest = typeof env?.COMPUTE_ENVIRONMENT_DIGEST === "string"
    ? env.COMPUTE_ENVIRONMENT_DIGEST.trim().toLowerCase()
    : "";
  const environmentDigest = IMAGE_DIGEST_PATTERN.test(rawDigest)
    ? rawDigest
    : null;
  const rolloutMode = env?.COMPUTE_ROLLOUT_MODE === "canary" ||
      env?.COMPUTE_ROLLOUT_MODE === "global"
    ? env.COMPUTE_ROLLOUT_MODE
    : null;
  const rawCanaries = typeof env?.COMPUTE_CANARY_ALLOWLIST === "string"
    ? env.COMPUTE_CANARY_ALLOWLIST.split(",").map((entry) =>
      entry.trim().toLowerCase()
    ).filter(Boolean)
    : [];
  const canaryAllowlist = Array.from(new Set(rawCanaries));
  const missing: ComputeRuntimeConfig["missing"] = [];
  if (!enabled) missing.push("feature_flag");
  if (!environmentDigest) missing.push("environment_digest");
  if (
    !rolloutMode ||
    (rolloutMode === "canary" &&
      (canaryAllowlist.length === 0 ||
        canaryAllowlist.some((entry) => !CANARY_ENTRY_PATTERN.test(entry))))
  ) missing.push("rollout_policy");
  if (
    !env?.COMPUTE_PLANE ||
    typeof env.COMPUTE_PLANE.executeRun !== "function" ||
    typeof env.COMPUTE_PLANE.cancelRun !== "function" ||
    typeof env.COMPUTE_PLANE.runtimeIdentity !== "function"
  ) missing.push("execution_plane");
  if (!env?.COMPUTE_QUEUE || typeof env.COMPUTE_QUEUE.send !== "function") {
    missing.push("dispatch_queue");
  }
  if (
    !env?.COMPUTE_ARTIFACTS ||
    typeof env.COMPUTE_ARTIFACTS.get !== "function" ||
    typeof env.COMPUTE_ARTIFACTS.put !== "function"
  ) missing.push("artifact_bucket");
  if (
    typeof env?.COMPUTE_JOB_TOKEN_PEPPER !== "string" ||
    env.COMPUTE_JOB_TOKEN_PEPPER.length < 32
  ) missing.push("token_pepper");
  return {
    enabled,
    environmentDigest,
    rolloutMode,
    canaryAllowlist,
    ready: missing.length === 0,
    missing,
  };
}

export function requireComputeAdmissionConfig(
  env: Partial<Env> | null | undefined,
): ComputeRuntimeConfig & {
  ready: true;
  environmentDigest: string;
  rolloutMode: "canary" | "global";
} {
  const config = resolveComputeRuntimeConfig(env);
  if (!config.ready || !config.environmentDigest) {
    throw new Error(
      `Galactic Compute admission is unavailable (${config.missing.join(",")}).`,
    );
  }
  return config as ComputeRuntimeConfig & {
    ready: true;
    environmentDigest: string;
    rolloutMode: "canary" | "global";
  };
}
