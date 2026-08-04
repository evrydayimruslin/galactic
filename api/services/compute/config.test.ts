import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  computeAdmissionFlagState,
  requireComputeAdmissionConfig,
  resolveComputeRuntimeConfig,
} from "./config.ts";

function readyEnv() {
  const owner = "11111111-1111-4111-8111-111111111111";
  const agent = "22222222-2222-4222-8222-222222222222";
  return {
    COMPUTE_ENABLED: "1",
    COMPUTE_ENVIRONMENT_DIGEST: `sha256:${"a".repeat(64)}`,
    COMPUTE_ROLLOUT_MODE: "global",
    COMPUTE_CANARY_ALLOWLIST: "",
    COMPUTE_CERTIFICATION_PRINCIPAL: `${owner}/${agent}`,
    SUPABASE_SERVICE_ROLE_KEY: "s".repeat(32),
    COMPUTE_EMERGENCY_STOP_TOKEN: "e".repeat(32),
    COMPUTE_CERTIFICATION_TOKEN: "c".repeat(32),
    COMPUTE_JOB_TOKEN_PEPPER: "p".repeat(32),
    COMPUTE_PLANE: {
      executeRun: () => Promise.resolve(null),
      cancelRun: () => Promise.resolve({ destroyed: true as const }),
      runtimeIdentity: () =>
        Promise.resolve({
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
  assertEquals(missing.missing, [
    "dispatch_queue",
    "token_pepper",
    "privileged_credentials",
  ]);
});

Deno.test("Compute admission requires every privileged credential", () => {
  for (
    const name of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "COMPUTE_EMERGENCY_STOP_TOKEN",
      "COMPUTE_CERTIFICATION_TOKEN",
      "COMPUTE_JOB_TOKEN_PEPPER",
    ] as const
  ) {
    const config = resolveComputeRuntimeConfig({
      ...readyEnv(),
      [name]: undefined,
    } as never);
    assertEquals(config.ready, false, name);
    assertEquals(config.missing.includes("privileged_credentials"), true, name);
  }
});

Deno.test("Compute admission rejects unusable operator token configuration", () => {
  for (const value of [" ".repeat(32), "x".repeat(513)]) {
    for (
      const name of [
        "COMPUTE_EMERGENCY_STOP_TOKEN",
        "COMPUTE_CERTIFICATION_TOKEN",
      ] as const
    ) {
      const config = resolveComputeRuntimeConfig({
        ...readyEnv(),
        [name]: value,
      } as never);
      assertEquals(config.ready, false, `${name}:${value.length}`);
      assertEquals(
        config.missing.includes("privileged_credentials"),
        true,
        name,
      );
    }
  }
});

Deno.test("Compute admission rejects collisions between operator credentials", () => {
  for (
    const name of [
      "COMPUTE_EMERGENCY_STOP_TOKEN",
      "SUPABASE_SERVICE_ROLE_KEY",
    ] as const
  ) {
    const config = resolveComputeRuntimeConfig({
      ...readyEnv(),
      [name]: "c".repeat(32),
    } as never);
    assertEquals(config.ready, false, name);
    assertEquals(config.missing.includes("credential_isolation"), true, name);
  }
});

Deno.test("Compute admission rejects a job-token pepper shared with another privileged lane", () => {
  const pepper = "shared-compute-secret-0123456789abcdef";
  const config = resolveComputeRuntimeConfig({
    ...readyEnv(),
    COMPUTE_JOB_TOKEN_PEPPER: pepper,
    COMPUTE_CERTIFICATION_TOKEN: pepper,
  } as never);
  assertEquals(config.ready, false);
  assertEquals(config.missing.includes("credential_isolation"), true);
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

  for (
    const principal of [
      "",
      "33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444",
    ]
  ) {
    const mismatch = resolveComputeRuntimeConfig({
      ...readyEnv(),
      COMPUTE_ROLLOUT_MODE: "canary",
      COMPUTE_CANARY_ALLOWLIST: `${owner}/${agent}`,
      COMPUTE_CERTIFICATION_PRINCIPAL: principal,
    } as never);
    assertEquals(mismatch.ready, false, principal);
    assertEquals(mismatch.missing.includes("rollout_policy"), true);
  }
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

Deno.test("Compute admission flag classification accepts only canonical bindings", () => {
  assertEquals(computeAdmissionFlagState({ COMPUTE_ENABLED: "1" }), "enabled");
  assertEquals(computeAdmissionFlagState({ COMPUTE_ENABLED: "0" }), "disabled");
  for (const COMPUTE_ENABLED of ["", "true", "false", " 0", "1 ", "01"]) {
    assertEquals(computeAdmissionFlagState({ COMPUTE_ENABLED }), "invalid");
  }
  assertEquals(computeAdmissionFlagState({}), "invalid");
  assertEquals(computeAdmissionFlagState(null), "invalid");
  assertEquals(computeAdmissionFlagState(undefined), "invalid");
});
