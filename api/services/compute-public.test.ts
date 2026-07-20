import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import type { ManifestComputeConfig } from "../../shared/contracts/compute.ts";
import {
  computeDirectiveHash,
  computeRunExpiresAt,
  computeSyncRunExpiresAt,
  ComputePublicRequestError,
  normalizePublicComputeRequest,
  projectPublicComputeRun,
  selectComputeRunAuthorities,
} from "./compute-public.ts";
import type {
  ComputeAgentPolicy,
  ComputeAgentPolicyRule,
  ComputeArtifact,
  ComputeRun,
  ComputeSecretBinding,
} from "./compute/types.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";

const manifest: ManifestComputeConfig = {
  profile: "developer-v1",
  tools: ["browser", "shell"],
  secrets: ["GITHUB_TOKEN"],
};

const policy: ComputeAgentPolicy = {
  userId: USER_ID,
  agentId: AGENT_ID,
  enabled: true,
  profile: "developer-v1",
  state: "active",
  allowedTools: ["browser", "shell"],
  maxTimeoutMs: 120_000,
  maxConcurrency: 1,
  maxArtifactBytes: "104857600",
  maxArtifacts: 10,
  authorityEpoch: "1",
  revision: "1",
  ownerConfirmedAt: "2026-07-19T00:00:00.000Z",
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
};

const secret: ComputeSecretBinding = {
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
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
};

Deno.test("public request intersects manifest, owner policy, and caller secret bindings", () => {
  assertEquals(normalizePublicComputeRequest({
    request: {
      argv: ["gh", "repo", "view"],
      tools: ["shell"],
      secrets: ["GITHUB_TOKEN"],
      capture_paths: ["out/report.json"],
      timeout_ms: 30_000,
    },
    manifest,
    manifestRevision: "1.2.3",
    policy,
    callerFunction: "develop",
    secretBindings: [secret],
    now: new Date("2026-07-19T00:00:00.000Z"),
  }), {
    mode: "sync",
    executionRequest: {
      argv: ["gh", "repo", "view"],
      tools: [{ id: "shell" }],
      secretBindingIds: [BINDING_ID],
      cwd: ".",
      stdin: { kind: "none" },
      capturePaths: ["out/report.json"],
      inputArtifacts: [],
      timeoutMs: 30_000,
    },
    manifestCeiling: {
      allowedTools: ["browser", "shell"],
      maxTimeoutMs: 480_000,
      revision: "1.2.3",
    },
  });
});

Deno.test("public request rejects hidden widening and unconfigured secrets", () => {
  for (const request of [
    { argv: ["echo"], tools: ["office"] },
    { argv: ["echo"], tools: ["shell"], secrets: ["OPENAI_API_KEY"] },
    { argv: ["echo"], tools: ["shell"], user_id: USER_ID },
  ]) {
    assertThrows(
      () => normalizePublicComputeRequest({
        request,
        manifest,
        manifestRevision: "1.2.3",
        policy,
        callerFunction: "develop",
        secretBindings: [secret],
      }),
      ComputePublicRequestError,
    );
  }
});

Deno.test("sync Compute is bounded by the parent lifetime; longer jobs must be async", () => {
  const request = {
    argv: ["sleep", "100"],
    tools: ["shell"],
    timeout_ms: 120_000,
  };
  assertThrows(
    () => normalizePublicComputeRequest({
      request,
      manifest,
      manifestRevision: "1.2.3",
      policy,
      callerFunction: "develop",
      secretBindings: [],
    }),
    ComputePublicRequestError,
    "use mode async",
  );
  assertEquals(
    normalizePublicComputeRequest({
      request: { ...request, mode: "async" },
      manifest,
      manifestRevision: "1.2.3",
      policy,
      callerFunction: "develop",
      secretBindings: [],
    }).mode,
    "async",
  );
});

Deno.test("sync Compute expiry is fenced to a parent deadline before admission", () => {
  const now = new Date("2026-07-19T00:00:00.000Z");
  assertEquals(
    computeSyncRunExpiresAt({
      now,
      timeoutMs: 30_000,
      executionDeadlineAtMs: now.getTime() + 300_000,
    }),
    "2026-07-19T00:04:30.000Z",
  );
  assertThrows(
    () => computeSyncRunExpiresAt({
      now,
      timeoutMs: 30_000,
      executionDeadlineAtMs: now.getTime() + 269_999,
    }),
    ComputePublicRequestError,
    "use mode async",
  );
});

Deno.test("async Compute fails closed above the Queue-backed v1 ceiling", () => {
  assertThrows(
    () => normalizePublicComputeRequest({
      request: {
        argv: ["sleep", "481"],
        tools: ["shell"],
        mode: "async",
        timeout_ms: 480_001,
      },
      manifest,
      manifestRevision: "1.2.3",
      policy: { ...policy, maxTimeoutMs: 480_000 },
      callerFunction: "develop",
      secretBindings: [secret],
    }),
    ComputePublicRequestError,
  );
});

Deno.test("only always authority is snapped and gx aliases become canonical ul names", () => {
  const base = {
    id: crypto.randomUUID(),
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    ruleVersion: "1",
    authorityEpoch: "1",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const rules: ComputeAgentPolicyRule[] = [
    {
      ...base,
      decision: "always",
      authority: {
        action: "platform.call",
        target: { kind: "platform_function", functionName: "gx.upload" },
      },
    },
    {
      ...base,
      id: crypto.randomUUID(),
      decision: "ask",
      authority: {
        action: "platform.call",
        target: { kind: "platform_function", functionName: "gx.call" },
      },
    },
  ];
  assertEquals(selectComputeRunAuthorities(rules, "develop"), [{
    action: "platform.call",
    target: { kind: "platform_function", functionName: "ul.upload" },
    constraints: {},
  }]);
});

Deno.test("directive hashes are canonical and expiry includes queue and body allowances", async () => {
  assertEquals(
    await computeDirectiveHash({ b: 2, a: { d: 4, c: 3 } }),
    await computeDirectiveHash({ a: { c: 3, d: 4 }, b: 2 }),
  );
  assertEquals(
    computeRunExpiresAt(new Date("2026-07-19T00:00:00.000Z"), 60_000),
    "2026-07-19T00:19:30.000Z",
  );
});

Deno.test("public projection removes lease and storage internals", () => {
  const run: ComputeRun = {
    id: crypto.randomUUID(),
    receiptId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    executionId: crypto.randomUUID(),
    directiveHash: "a".repeat(64),
    profile: "developer-v1",
    environmentDigest: `sha256:${"b".repeat(64)}`,
    billingMode: "wallet",
    capacityAgentId: AGENT_ID,
    capacityReservationId: null,
    request: {
      argv: ["echo", "ok"],
      tools: [{ id: "shell" }],
      secretBindingIds: [BINDING_ID],
      cwd: ".",
      stdin: { kind: "none" },
      capturePaths: ["out.txt"],
      inputArtifacts: [],
      timeoutMs: 30_000,
    },
    manifestCeiling: {
      allowedTools: ["shell"],
      maxTimeoutMs: 480_000,
      revision: "1.2.3",
    },
    policyLimits: {
      allowedTools: ["shell"],
      maxTimeoutMs: 120_000,
      maxConcurrency: 1,
      maxArtifactBytes: "104857600",
      maxArtifacts: 10,
      revision: "1",
    },
    authorityEpoch: "1",
    state: "succeeded",
    stateVersion: "4",
    expiresAt: "2026-07-19T01:00:00.000Z",
    startedAt: "2026-07-19T00:00:01.000Z",
    finishedAt: "2026-07-19T00:00:02.000Z",
    terminalReason: null,
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    stdoutBytes: "3",
    stderrBytes: "0",
    stdoutTruncated: false,
    stderrTruncated: false,
    executionMetrics: {},
    terminalError: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:02.000Z",
  };
  const pending = projectPublicComputeRun({ run });
  assertEquals(pending.status, "settlement_pending");
  const projected = projectPublicComputeRun({
    run,
    receipt: { capacitySettlementStatus: "not_applicable" } as never,
  });
  assertEquals(projected.status, "completed");
  assertEquals(projected.stdout, "ok\n");
  assertEquals("lease_id" in projected, false);
  assertEquals("environment_digest" in projected, false);

  const artifact: ComputeArtifact = {
    id: crypto.randomUUID(),
    runId: run.id,
    userId: USER_ID,
    sourceArtifactId: null,
    direction: "output",
    mountPath: null,
    logicalName: "out.txt",
    mediaType: "text/plain",
    storageKey: `compute-v1/${USER_ID}/${AGENT_ID}/${run.id}/outputs/out.txt`,
    sha256: "c".repeat(64),
    sizeBytes: "3",
    state: "ready",
    stateVersion: "2",
    expiresAt: "2026-07-20T00:00:00.000Z",
    retentionProtectedUntil: null,
    objectDeletedAt: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:02.000Z",
  };
  const available = projectPublicComputeRun({
    run,
    receipt: {} as never,
    artifacts: [artifact],
    now: new Date("2026-07-19T23:59:59.000Z"),
  });
  assertEquals(available.artifacts, [{
    artifact_id: artifact.id,
    path: "out.txt",
    size_bytes: 3,
    sha256: artifact.sha256,
    expires_at: artifact.expiresAt,
  }]);
  const expired = projectPublicComputeRun({
    run,
    receipt: {} as never,
    artifacts: [artifact],
    now: new Date(artifact.expiresAt!),
  });
  assertEquals(expired.artifacts, undefined);
});
