import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import type { Env } from "../lib/env.ts";
import type { ComputeAdmissionInput } from "../src/bindings/compute-control-plane-adapter.ts";
import { PublicComputeControlPlaneError } from "../src/bindings/compute-control-plane-adapter.ts";
import { createComputeControlPlaneAdapter } from "./compute-orchestrator.ts";
import { ComputeControlPlaneError } from "./compute/database.ts";
import type {
  ComputeAgentPolicy,
  ComputeAgentPolicyRule,
  ComputeRun,
  ComputeRunReceipt,
  ComputeSecretBinding,
} from "./compute/types.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_ID = "55555555-5555-4555-8555-555555555555";
const EXECUTION_ID = "execution-1";
const IDEMPOTENCY_KEY = "66666666-6666-4666-8666-666666666666";
const BINDING_ID = "77777777-7777-4777-8777-777777777777";

const policy: ComputeAgentPolicy = {
  userId: USER_ID,
  agentId: AGENT_ID,
  enabled: true,
  profile: "developer-v1",
  state: "active",
  allowedTools: ["shell", "git"],
  maxTimeoutMs: 120_000,
  maxConcurrency: 1,
  maxArtifactBytes: "104857600",
  maxArtifacts: 10,
  authorityEpoch: "2",
  revision: "3",
  ownerConfirmedAt: "2026-07-20T00:00:00.000Z",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

const binding: ComputeSecretBinding = {
  id: BINDING_ID,
  userId: USER_ID,
  agentId: AGENT_ID,
  callerFunction: "develop",
  name: "GITHUB_TOKEN",
  variableName: "GITHUB_TOKEN",
  delivery: { kind: "raw_env", envName: "GITHUB_TOKEN" },
  status: "active",
  bindingVersion: "1",
  expiresAt: null,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

const authority: ComputeAgentPolicyRule = {
  id: "88888888-8888-4888-8888-888888888888",
  userId: USER_ID,
  agentId: AGENT_ID,
  callerFunction: "develop",
  decision: "always",
  authority: {
    action: "platform.call",
    target: { kind: "platform_function", functionName: "ul.upload" },
  },
  ruleVersion: "1",
  authorityEpoch: "2",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

function run(state: ComputeRun["state"] = "admitted"): ComputeRun {
  const terminal = state === "succeeded" || state === "failed" ||
    state === "cancelled" || state === "expired" || state === "revoked";
  return {
    id: RUN_ID,
    receiptId: RECEIPT_ID,
    leaseId: LEASE_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    executionId: EXECUTION_ID,
    directiveHash: "a".repeat(64),
    profile: "developer-v1",
    environmentDigest: `sha256:${"b".repeat(64)}`,
    billingMode: "wallet",
    capacityAgentId: AGENT_ID,
    capacityReservationId: null,
    request: {
      argv: ["git", "status"],
      tools: [{ id: "git" }, { id: "shell" }],
      secretBindingIds: [BINDING_ID],
      cwd: ".",
      stdin: { kind: "none" },
      capturePaths: [],
      inputArtifacts: [],
      timeoutMs: 30_000,
    },
    manifestCeiling: {
      allowedTools: ["git", "shell"],
      maxTimeoutMs: 480_000,
      revision: "1.0.0",
    },
    policyLimits: {
      allowedTools: ["git", "shell"],
      maxTimeoutMs: 120_000,
      maxConcurrency: 1,
      maxArtifactBytes: "104857600",
      maxArtifacts: 10,
      revision: "3",
    },
    authorityEpoch: "2",
    state,
    stateVersion: terminal ? "4" : "1",
    expiresAt: "2026-07-20T01:00:00.000Z",
    startedAt: terminal ? "2026-07-20T00:00:01.000Z" : null,
    finishedAt: terminal ? "2026-07-20T00:00:02.000Z" : null,
    terminalReason: null,
    exitCode: state === "succeeded" ? 0 : null,
    stdout: state === "succeeded" ? "clean\n" : null,
    stderr: state === "succeeded" ? "" : null,
    stdoutBytes: state === "succeeded" ? "6" : null,
    stderrBytes: state === "succeeded" ? "0" : null,
    stdoutTruncated: state === "succeeded" ? false : null,
    stderrTruncated: state === "succeeded" ? false : null,
    executionMetrics: terminal ? { wall_ms: 1_000 } : null,
    terminalError: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function receipt(
  outcome: ComputeRunReceipt["outcome"] = "succeeded",
): ComputeRunReceipt {
  return {
    id: RECEIPT_ID,
    runId: RUN_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    billingMode: "wallet",
    holdId: null,
    capacityAgentId: AGENT_ID,
    capacityReservationId: null,
    capacitySettlementStatus: "not_applicable",
    cloudUsageEventId: null,
    outcome,
    rateVersion: "compute-rate-v1",
    workerWallMs: "1000",
    teardownAllowanceMs: "15000",
    billedWallMs: "16000",
    reservedLight: 10,
    actualLight: 3,
    releasedLight: 7,
    createdAt: "2026-07-20T00:00:02.000Z",
  };
}

function env(): Partial<Env> {
  return {
    COMPUTE_ENABLED: "1",
    COMPUTE_ENVIRONMENT_DIGEST: `sha256:${"b".repeat(64)}`,
    COMPUTE_ROLLOUT_MODE: "global",
    COMPUTE_CANARY_ALLOWLIST: "",
    COMPUTE_JOB_TOKEN_PEPPER: "p".repeat(32),
    COMPUTE_QUEUE: { send: () => Promise.resolve() },
    COMPUTE_PLANE: {
      executeRun: () => Promise.resolve({}),
      cancelRun: () => Promise.resolve({ destroyed: true as const }),
      runtimeIdentity: () => Promise.resolve({
        profile: "developer-v1" as const,
        environmentDigest: `sha256:${"b".repeat(64)}`,
      }),
    },
    COMPUTE_ARTIFACTS: {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve({} as R2Object),
    } as unknown as R2Bucket,
  };
}

function admission(mode: "sync" | "async"): ComputeAdmissionInput {
  return {
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    executionId: EXECUTION_ID,
    executionDeadlineAtMs: Date.parse("2026-07-20T00:05:00.000Z"),
    idempotencyKey: IDEMPOTENCY_KEY,
    billingMode: "wallet",
    capacityAgentId: AGENT_ID,
    request: {
      argv: ["git", "status"],
      tools: ["shell", "git"],
      secrets: ["GITHUB_TOKEN"],
      mode,
      timeout_ms: 30_000,
    },
  };
}

function common(overrides: Record<string, unknown> = {}) {
  let current = run();
  const queued: unknown[] = [];
  const admitted: Array<Record<string, unknown>> = [];
  return {
    state: {
      get run() {
        return current;
      },
      set run(value: ComputeRun) {
        current = value;
      },
      queued,
      admitted,
    },
    deps: {
      env: env(),
      now: () => new Date("2026-07-20T00:00:00.000Z"),
      findAgent: () => Promise.resolve({
        id: AGENT_ID,
        owner_id: USER_ID,
        current_version: "1.0.0",
        manifest: JSON.stringify({
          name: "Developer",
          version: "1.0.0",
          type: "mcp",
          entry: {},
          permissions: ["compute:exec"],
          compute: {
            profile: "developer-v1",
            tools: ["shell", "git"],
            secrets: ["GITHUB_TOKEN"],
          },
          functions: {
            develop: { description: "Develop", uses_compute: true },
          },
        }),
      }),
      getPolicy: () => Promise.resolve(policy),
      listPolicyRules: () => Promise.resolve([authority]),
      listSecretBindings: () => Promise.resolve([binding]),
      admitRun: (value: Record<string, unknown>) => {
        admitted.push(value);
        return Promise.resolve({ run: current, replayed: false });
      },
      getRunView: () => Promise.resolve({
        run: current,
        artifacts: [],
        receipt: current.state === "succeeded"
          ? receipt("succeeded")
          : current.state === "cancelled"
          ? receipt("cancelled")
          : null,
      }),
      enqueue: (message: unknown) => {
        queued.push(message);
        return Promise.resolve();
      },
      execute: () => Promise.resolve({}),
      ...overrides,
    },
  };
}

Deno.test("Compute orchestrator snapshots exact manifest, policy, secret, and authority", async () => {
  const fixture = common();
  const result = await createComputeControlPlaneAdapter(
    fixture.deps,
  ).admitComputeRun(admission("async"));

  assertEquals(result.async, true);
  assertEquals(result.status, "queued");
  assertEquals(fixture.state.queued, [{ version: 1, run_id: RUN_ID }]);
  assertEquals(fixture.state.admitted[0]?.request, run().request);
  assertEquals(fixture.state.admitted[0]?.authorities, [{
    action: "platform.call",
    target: { kind: "platform_function", functionName: "ul.upload" },
    constraints: {},
  }]);
  assertEquals(
    fixture.state.admitted[0]?.environmentDigest,
    `sha256:${"b".repeat(64)}`,
  );
  assertEquals(fixture.state.admitted[0]?.billingMode, "wallet");
  assertEquals(fixture.state.admitted[0]?.capacityAgentId, AGENT_ID);
});

Deno.test("Compute orchestrator preserves trusted subscription capacity lineage", async () => {
  const fixture = common();
  const value = admission("async");
  value.billingMode = "subscription_capacity";
  value.capacityAgentId = "99999999-9999-4999-8999-999999999999";
  await createComputeControlPlaneAdapter(fixture.deps).admitComputeRun(value);
  assertEquals(
    fixture.state.admitted[0]?.billingMode,
    "subscription_capacity",
  );
  assertEquals(
    fixture.state.admitted[0]?.capacityAgentId,
    "99999999-9999-4999-8999-999999999999",
  );
});

Deno.test("sync Compute uses direct plane plus durable queue and returns terminal truth", async () => {
  const fixture = common();
  let executes = 0;
  fixture.deps.execute = () => {
    executes++;
    fixture.state.run = run("succeeded");
    return Promise.resolve({});
  };
  const result = await createComputeControlPlaneAdapter(
    fixture.deps,
  ).admitComputeRun(admission("sync"));

  assertEquals(executes, 1);
  assertEquals(fixture.state.queued.length, 1);
  assertEquals(result.async, false);
  assertEquals(result.status, "completed");
  assertEquals(result.stdout, "clean\n");
  assertEquals(
    fixture.state.admitted[0]?.expiresAt,
    "2026-07-20T00:04:30.000Z",
  );
});

Deno.test("late sync composition is refused before admission or dispatch", async () => {
  const fixture = common();
  const late = admission("sync");
  late.executionDeadlineAtMs = Date.parse("2026-07-20T00:04:29.999Z");
  const error = await assertRejects(
    () => createComputeControlPlaneAdapter(fixture.deps).admitComputeRun(late),
    PublicComputeControlPlaneError,
  );
  assertEquals(error.code, "COMPUTE_SYNC_DEADLINE_REQUIRES_ASYNC");
  assertEquals(fixture.state.admitted.length, 0);
  assertEquals(fixture.state.queued.length, 0);
});

Deno.test("Compute orchestrator exact lookups strip private run fields", async () => {
  const fixture = common();
  fixture.state.run = run("succeeded");
  const result = await createComputeControlPlaneAdapter(
    fixture.deps,
  ).getComputeRunForAgent({
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    executionId: EXECUTION_ID,
    runId: RUN_ID,
  });
  assertEquals(result.status, "completed");
  assertEquals("leaseId" in result, false);
  assertEquals("environmentDigest" in result, false);
});

Deno.test("Compute orchestrator returns an admitted run when immediate dispatch fails", async () => {
  const fixture = common({
    enqueue: () => Promise.reject(new Error("queue-secret")),
    execute: () => Promise.reject(new Error("plane-secret")),
  });
  const result = await createComputeControlPlaneAdapter(fixture.deps)
    .admitComputeRun(admission("sync"));
  assertEquals(result.run_id, RUN_ID);
  assertEquals(result.async, true);
  assertEquals(result.status, "queued");
});

Deno.test("sync Compute delays its recovery delivery so direct RPC gets first claim", async () => {
  const fixture = common();
  let options: { delaySeconds?: number } | undefined;
  fixture.deps.enqueue = (_message: unknown, value?: { delaySeconds?: number }) => {
    options = value;
    return Promise.resolve();
  };
  await createComputeControlPlaneAdapter(fixture.deps).admitComputeRun(
    admission("sync"),
  );
  assertEquals(options, { delaySeconds: 5 });
});

Deno.test("Compute canary rollout is exact to owner and Agent", async () => {
  const fixture = common();
  fixture.deps.env = {
    ...fixture.deps.env,
    COMPUTE_ROLLOUT_MODE: "canary",
    COMPUTE_CANARY_ALLOWLIST:
      "11111111-1111-4111-8111-111111111111/99999999-9999-4999-8999-999999999999",
  };
  const error = await assertRejects(
    () => createComputeControlPlaneAdapter(fixture.deps).admitComputeRun(
      admission("async"),
    ),
    PublicComputeControlPlaneError,
  );
  assertEquals(error.code, "COMPUTE_ROLLOUT_DENIED");
});

Deno.test("Compute admission rejects a deployed image identity mismatch before reservation", async () => {
  const fixture = common();
  fixture.deps.env = {
    ...fixture.deps.env,
    COMPUTE_PLANE: {
      executeRun: () => Promise.resolve(null),
      cancelRun: () => Promise.resolve({ destroyed: true as const }),
      runtimeIdentity: () => Promise.resolve({
        profile: "developer-v1" as const,
        environmentDigest: `sha256:${"c".repeat(64)}`,
      }),
    },
  };
  const error = await assertRejects(
    () => createComputeControlPlaneAdapter(fixture.deps).admitComputeRun(
      admission("async"),
    ),
    PublicComputeControlPlaneError,
  );
  assertEquals(error.code, "COMPUTE_RUNTIME_IDENTITY_MISMATCH");
  assertEquals(fixture.state.admitted.length, 0);
});

Deno.test("Compute admission preserves deterministic retention rejections", async () => {
  for (
    const code of [
      "COMPUTE_INPUT_ARTIFACT_EXPIRED",
      "COMPUTE_ARTIFACT_STORAGE_QUOTA_EXCEEDED",
    ]
  ) {
    const fixture = common({
      admitRun: () =>
        Promise.reject(new ComputeControlPlaneError({
          code,
          status: 409,
          message: `safe ${code}`,
        })),
    });
    const error = await assertRejects(
      () => createComputeControlPlaneAdapter(fixture.deps).admitComputeRun(
        admission("async"),
      ),
      PublicComputeControlPlaneError,
    );
    assertEquals(error.code, code);
    assertEquals(error.message, `safe ${code}`);
  }
});

Deno.test("Compute admission safely projects database admission guards without dispatch", async () => {
  for (
    const code of [
      "COMPUTE_EXECUTION_CALL_LIMIT",
      "COMPUTE_ADMISSION_BACKLOG_LIMIT",
      "COMPUTE_ADMISSION_RATE_LIMIT",
    ]
  ) {
    const fixture = common({
      admitRun: () =>
        Promise.reject(
          new ComputeControlPlaneError({
            code,
            status: 429,
            message: `safe ${code}`,
          }),
        ),
    });
    const error = await assertRejects(
      () =>
        createComputeControlPlaneAdapter(fixture.deps).admitComputeRun(
          admission("async"),
        ),
      PublicComputeControlPlaneError,
    );
    assertEquals(error.code, code);
    assertEquals(error.message, `safe ${code}`);
    assertEquals(fixture.state.queued.length, 0);
  }
});

Deno.test("Compute cancellation delegates to destroy-before-terminal coordinator", async () => {
  const fixture = common();
  let called = false;
  fixture.deps.cancelRunAfterDestroy = (lookup: { runId: string }) => {
    called = lookup.runId === RUN_ID;
    return Promise.resolve({
      run: run("cancelled"),
      artifacts: [],
      receipt: receipt("cancelled"),
    });
  };
  const result = await createComputeControlPlaneAdapter(
    fixture.deps,
  ).cancelComputeRunForAgent({
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    executionId: EXECUTION_ID,
    runId: RUN_ID,
  });
  assert(called);
  assertEquals(result.status, "cancelled");
});
