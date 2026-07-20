import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  materializeComputeRunSecrets,
} from "./compute-secret-materializer.ts";
import type { PreparedComputeSecretDescriptor } from "./compute/runs.ts";
import type { ComputeRun } from "./compute/types.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function run(): ComputeRun {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    receiptId: "44444444-4444-4444-8444-444444444444",
    leaseId: "55555555-5555-4555-8555-555555555555",
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    executionId: "66666666-6666-4666-8666-666666666666",
    directiveHash: "a".repeat(64),
    profile: "developer-v1",
    environmentDigest: `sha256:${"b".repeat(64)}`,
    billingMode: "wallet",
    capacityAgentId: AGENT_ID,
    capacityReservationId: null,
    request: {
      argv: ["true"],
      tools: [{ id: "shell" }],
      secretBindingIds: ["77777777-7777-4777-8777-777777777777"],
      cwd: ".",
      stdin: { kind: "none" },
      capturePaths: [],
      inputArtifacts: [],
      timeoutMs: 60_000,
    },
    manifestCeiling: {
      allowedTools: ["shell"],
      maxTimeoutMs: 480_000,
      revision: "1.0.0",
    },
    policyLimits: {
      allowedTools: ["shell"],
      maxTimeoutMs: 60_000,
      maxConcurrency: 1,
      maxArtifactBytes: "104857600",
      maxArtifacts: 10,
      revision: "1",
    },
    authorityEpoch: "1",
    state: "provisioning",
    stateVersion: "2",
    expiresAt: "2026-07-20T01:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    terminalReason: null,
    exitCode: null,
    stdout: null,
    stderr: null,
    stdoutBytes: null,
    stderrBytes: null,
    stdoutTruncated: null,
    stderrTruncated: null,
    executionMetrics: null,
    terminalError: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function descriptor(
  overrides: Partial<PreparedComputeSecretDescriptor> = {},
): PreparedComputeSecretDescriptor {
  return {
    bindingId: "77777777-7777-4777-8777-777777777777",
    bindingVersion: "3",
    name: "GitHub",
    variableName: "GITHUB_TOKEN",
    delivery: { kind: "raw_env", envName: "GITHUB_TOKEN" },
    ...overrides,
  };
}

Deno.test("Compute secret materializer selects only snapshotted Agent Variables", async () => {
  const result = await materializeComputeRunSecrets({
    run: run(),
    descriptors: [descriptor()],
  }, {
    findAgent: () => Promise.resolve({
      id: AGENT_ID,
      owner_id: USER_ID,
      env_vars: { encrypted: "opaque" },
    }),
    resolveAgentVariables: () => Promise.resolve({
      GITHUB_TOKEN: "github-secret",
      OPENAI_API_KEY: "must-not-escape",
    }),
  });

  assertEquals(result, [{
    bindingId: "77777777-7777-4777-8777-777777777777",
    bindingVersion: "3",
    value: "github-secret",
  }]);
  assertEquals(JSON.stringify(result).includes("must-not-escape"), false);
});

Deno.test("Compute secret materializer rejects owner mismatch and missing values", async () => {
  await assertRejects(() => materializeComputeRunSecrets({
    run: run(),
    descriptors: [descriptor()],
  }, {
    findAgent: () => Promise.resolve({
      id: AGENT_ID,
      owner_id: "99999999-9999-4999-8999-999999999999",
      env_vars: {},
    }),
    resolveAgentVariables: () => Promise.resolve({ GITHUB_TOKEN: "secret" }),
  }));

  await assertRejects(() => materializeComputeRunSecrets({
    run: run(),
    descriptors: [descriptor()],
  }, {
    findAgent: () => Promise.resolve({
      id: AGENT_ID,
      owner_id: USER_ID,
      env_vars: {},
    }),
    resolveAgentVariables: () => Promise.resolve({}),
  }));
});

Deno.test("Compute secret materializer rejects duplicate descriptor snapshots", async () => {
  await assertRejects(() => materializeComputeRunSecrets({
    run: run(),
    descriptors: [
      descriptor(),
      descriptor({ bindingId: "88888888-8888-4888-8888-888888888888" }),
    ],
  }, {
    findAgent: () => Promise.resolve({
      id: AGENT_ID,
      owner_id: USER_ID,
      env_vars: {},
    }),
    resolveAgentVariables: () => Promise.resolve({ GITHUB_TOKEN: "secret" }),
  }));
});
