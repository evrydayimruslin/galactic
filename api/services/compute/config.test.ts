import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  requireComputeAdmissionConfig,
  resolveComputeRuntimeConfig,
} from "./config.ts";

function readyEnv() {
  return {
    COMPUTE_ENABLED: "1",
    COMPUTE_ENVIRONMENT_DIGEST: `sha256:${"a".repeat(64)}`,
    COMPUTE_ROLLOUT_MODE: "global",
    COMPUTE_CANARY_ALLOWLIST: "",
    COMPUTE_JOB_TOKEN_PEPPER: "p".repeat(32),
    COMPUTE_PLANE: {
      executeRun: () => Promise.resolve(null),
      cancelRun: () => Promise.resolve({ destroyed: true as const }),
      runtimeIdentity: () => Promise.resolve({
        profile: "developer-v1" as const,
        environmentDigest: `sha256:${"a".repeat(64)}`,
      }),
    },
    COMPUTE_QUEUE: { send: () => Promise.resolve() },
    COMPUTE_ARTIFACTS: {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(null),
    },
  };
}

Deno.test("Compute admission readiness requires every private binding", () => {
  const env = readyEnv();
  assertEquals(resolveComputeRuntimeConfig(env as never), {
    enabled: true,
    environmentDigest: `sha256:${"a".repeat(64)}`,
    rolloutMode: "global",
    canaryAllowlist: [],
    ready: true,
    missing: [],
  });

  const missing = resolveComputeRuntimeConfig({
    ...env,
    COMPUTE_QUEUE: undefined,
    COMPUTE_JOB_TOKEN_PEPPER: "short",
  } as never);
  assertEquals(missing.ready, false);
  assertEquals(missing.missing, ["dispatch_queue", "token_pepper"]);
});

Deno.test("Compute canary rollout requires exact owner/Agent pairs", () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  const agent = "22222222-2222-4222-8222-222222222222";
  const ready = resolveComputeRuntimeConfig({
    ...readyEnv(),
    COMPUTE_ROLLOUT_MODE: "canary",
    COMPUTE_CANARY_ALLOWLIST: `${owner}/${agent}`,
  } as never);
  assertEquals(ready.ready, true);
  assertEquals(ready.canaryAllowlist, [`${owner}/${agent}`]);

  const invalid = resolveComputeRuntimeConfig({
    ...readyEnv(),
    COMPUTE_ROLLOUT_MODE: "canary",
    COMPUTE_CANARY_ALLOWLIST: "owner-slug/agent-slug",
  } as never);
  assertEquals(invalid.ready, false);
  assertEquals(invalid.missing.includes("rollout_policy"), true);
});

Deno.test("Compute admission flag and immutable digest fail closed", () => {
  const env = {
    ...readyEnv(),
    COMPUTE_ENABLED: "true",
    COMPUTE_ENVIRONMENT_DIGEST: "developer-v1:latest",
  };
  const config = resolveComputeRuntimeConfig(env as never);
  assertEquals(config.environmentDigest, null);
  assertEquals(config.missing.slice(0, 2), [
    "feature_flag",
    "environment_digest",
  ]);
  assertThrows(
    () => requireComputeAdmissionConfig(env as never),
    Error,
    "feature_flag,environment_digest",
  );
});
