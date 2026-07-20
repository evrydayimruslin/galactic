import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { ComputeLaunchServiceError } from "../handlers/launch-compute.ts";
import {
  createComputeLaunchCancellationOrchestrator,
  createComputeLaunchService,
  type ComputeLaunchCancellationInput,
} from "./compute-launch-service.ts";
import type {
  ComputeAgentPolicy,
  ComputeAgentPolicyRule,
  ComputeArtifact,
  ComputeRun,
  ComputeSecretBinding,
} from "./compute/types.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const EXPIRED_ARTIFACT_ID = "99999999-9999-4999-8999-999999999999";
const TARGET_AGENT_ID = "66666666-6666-4666-8666-666666666666";
const BINDING_A = "77777777-7777-4777-8777-777777777777";
const BINDING_B = "88888888-8888-4888-8888-888888888888";
const CREATED_AT = "2026-07-20T00:00:00.000Z";

const manifest = JSON.stringify({
  name: "Compute Agent",
  version: "1.2.3",
  type: "mcp",
  entry: { functions: "index.ts" },
  permissions: ["compute:exec"],
  compute: {
    profile: "developer-v1",
    tools: ["browser", "shell"],
    secrets: ["ANTHROPIC_API_KEY"],
  },
  functions: {
    develop: { description: "Develop", uses_compute: true },
    review: { description: "Review", uses_compute: true },
    status: { description: "Status", uses_compute: false },
  },
});

function appRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    owner_id: USER_ID,
    slug: "compute-agent",
    name: "Compute Agent",
    current_version: "1.2.3",
    manifest,
    env_vars: { ANTHROPIC_API_KEY: "encrypted-secret-value" },
    ...overrides,
  };
}

function policy(overrides: Partial<ComputeAgentPolicy> = {}): ComputeAgentPolicy {
  return {
    userId: USER_ID,
    agentId: AGENT_ID,
    enabled: true,
    profile: "developer-v1",
    state: "active",
    allowedTools: ["browser", "shell"],
    maxTimeoutMs: 120_000,
    maxConcurrency: 2,
    maxArtifactBytes: "104857600",
    maxArtifacts: 10,
    authorityEpoch: "7",
    revision: "3",
    ownerConfirmedAt: "2026-07-19T00:00:00.000Z",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function rule(
  overrides: Partial<ComputeAgentPolicyRule> = {},
): ComputeAgentPolicyRule {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    decision: "always",
    authority: {
      action: "platform.call",
      target: { kind: "platform_function", functionName: "gx.upload" },
      constraints: {},
    },
    ruleVersion: "4",
    authorityEpoch: "7",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function secret(
  callerFunction: string,
  id: string,
  overrides: Partial<ComputeSecretBinding> = {},
): ComputeSecretBinding {
  return {
    id,
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction,
    name: "ANTHROPIC_API_KEY",
    variableName: "ANTHROPIC_API_KEY",
    delivery: { kind: "raw_env", envName: "ANTHROPIC_API_KEY" },
    status: "active",
    bindingVersion: "2",
    expiresAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function artifact(
  overrides: Partial<ComputeArtifact> = {},
): ComputeArtifact {
  return {
    id: ARTIFACT_ID,
    runId: RUN_ID,
    userId: USER_ID,
    sourceArtifactId: null,
    direction: "output",
    mountPath: null,
    logicalName: "report.txt",
    mediaType: "text/plain",
    storageKey: `compute-v1/${USER_ID}/${AGENT_ID}/${RUN_ID}/outputs/report.txt`,
    sha256: "a".repeat(64),
    sizeBytes: "5",
    state: "ready",
    stateVersion: "1",
    expiresAt: "2099-07-20T00:00:00.000Z",
    retentionProtectedUntil: null,
    objectDeletedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function artifactRow(value: ComputeArtifact): Record<string, unknown> {
  return {
    id: value.id,
    run_id: value.runId,
    user_id: value.userId,
    source_artifact_id: value.sourceArtifactId,
    direction: value.direction,
    mount_path: value.mountPath,
    logical_name: value.logicalName,
    media_type: value.mediaType,
    storage_key: value.storageKey,
    sha256: value.sha256,
    size_bytes: value.sizeBytes,
    state: value.state,
    state_version: value.stateVersion,
    expires_at: value.expiresAt,
    retention_protected_until: value.retentionProtectedUntil,
    object_deleted_at: value.objectDeletedAt,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

function ownerRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    receipt_id: RECEIPT_ID,
    billing_mode: "wallet",
    caller_function: "develop",
    state: "running",
    state_version: "4",
    stop_requested_at: null,
    created_at: CREATED_AT,
    started_at: "2026-07-20T00:00:01.000Z",
    finished_at: null,
    terminal_reason: null,
    terminal_error: null,
    exit_code: null,
    artifacts: [],
    receipt: null,
    budget: {
      reserved_light: 1.25,
      actual_light: 0,
      released_light: 0,
      status: "reserved",
    },
    ...overrides,
  };
}

function computeRun(overrides: Partial<ComputeRun> = {}): ComputeRun {
  return {
    id: RUN_ID,
    receiptId: RECEIPT_ID,
    leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    executionId: "execution-1",
    directiveHash: "a".repeat(64),
    profile: "developer-v1",
    environmentDigest: `sha256:${"b".repeat(64)}`,
    billingMode: "wallet",
    capacityAgentId: AGENT_ID,
    capacityReservationId: null,
    request: {
      argv: ["true"],
      tools: [{ id: "shell" }],
      secretBindingIds: [],
      cwd: ".",
      stdin: { kind: "none" },
      capturePaths: [],
      inputArtifacts: [],
      timeoutMs: 60_000,
    },
    manifestCeiling: {
      allowedTools: ["shell"],
      maxTimeoutMs: 480_000,
      revision: "1.2.3",
    },
    policyLimits: {
      allowedTools: ["shell"],
      maxTimeoutMs: 60_000,
      maxConcurrency: 1,
      maxArtifactBytes: "104857600",
      maxArtifacts: 10,
      revision: "3",
    },
    authorityEpoch: "7",
    state: "running",
    stateVersion: "4",
    expiresAt: "2026-07-20T01:00:00.000Z",
    stopRequestedAt: null,
    stopReason: null,
    startedAt: "2026-07-20T00:00:01.000Z",
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
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function runDatabaseRow(run: ComputeRun): Record<string, unknown> {
  return {
    id: run.id,
    receipt_id: run.receiptId,
    lease_id: run.leaseId,
    user_id: run.userId,
    agent_id: run.agentId,
    caller_function: run.callerFunction,
    execution_id: run.executionId,
    directive_hash: run.directiveHash,
    profile: run.profile,
    environment_digest: run.environmentDigest,
    billing_mode: run.billingMode,
    capacity_agent_id: run.capacityAgentId,
    capacity_reservation_id: run.capacityReservationId,
    execution_request: run.request,
    manifest_ceiling: run.manifestCeiling,
    policy_limits_snapshot: run.policyLimits,
    authority_epoch: run.authorityEpoch,
    state: run.state,
    state_version: run.stateVersion,
    expires_at: run.expiresAt,
    stop_requested_at: run.stopRequestedAt,
    stop_reason: run.stopReason,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    terminal_reason: run.terminalReason,
    exit_code: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    stdout_bytes: run.stdoutBytes,
    stderr_bytes: run.stderrBytes,
    stdout_truncated: run.stdoutTruncated,
    stderr_truncated: run.stderrTruncated,
    execution_metrics: run.executionMetrics,
    terminal_error: run.terminalError,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

function baseOperations(overrides: Record<string, unknown> = {}) {
  return {
    queryRows: async (path: string) => path.startsWith("apps?") ? [appRow()] : [],
    getPolicy: async () => policy(),
    listPolicyRules: async () => [rule()],
    listSecretBindings: async () => [
      secret("develop", BINDING_A),
      secret("review", BINDING_B),
    ],
    replaceConfiguration: async () => ({
      policy: policy({ revision: "4", authorityEpoch: "8" }),
      authorityRules: [rule({ authorityEpoch: "8" })],
      secretBindings: [
        secret("develop", BINDING_A, { bindingVersion: "3" }),
        secret("review", BINDING_B, { bindingVersion: "3" }),
      ],
    }),
    getRun: async () => computeRun(),
    leaseArtifactDownload: async () => artifact(),
    getArtifactObject: async () => null,
    ...overrides,
  };
}

Deno.test("Compute Launch resolves IDs and slugs inside the authenticated owner scope", async () => {
  const paths: string[] = [];
  const service = createComputeLaunchService({
    operations: baseOperations({
      queryRows: async (path: string) => {
        paths.push(path);
        return [appRow()];
      },
    }),
  });
  assertEquals(await service.resolveAgent(AGENT_ID, USER_ID), {
    id: AGENT_ID,
    ownerUserId: USER_ID,
  });
  assertEquals(await service.resolveAgent("compute-agent", USER_ID), {
    id: AGENT_ID,
    ownerUserId: USER_ID,
  });
  assert(paths.every((path) =>
    path.includes(`owner_id=eq.${encodeURIComponent(USER_ID)}`)
  ));
});

Deno.test("Compute Launch settings collapse Agent-wide secrets without returning values", async () => {
  const service = createComputeLaunchService({ operations: baseOperations() });
  const view = await service.getSettings({ userId: USER_ID, agentId: AGENT_ID });

  assertEquals(view.revision, "3");
  assertEquals(view.settings.manifestCeiling, {
    enabled: true,
    profile: "developer-v1",
    tools: ["browser", "shell"],
    secrets: ["ANTHROPIC_API_KEY"],
  });
  assertEquals(view.settings.secretBindings, [{
    name: "ANTHROPIC_API_KEY",
    delivery: { kind: "env", envName: "ANTHROPIC_API_KEY" },
    configured: true,
    version: "2",
    updatedAt: CREATED_AT,
  }]);
  assertEquals(view.settings.authorityRules[0], {
    callerFunction: "develop",
    decision: "always",
    action: "platform.call",
    target: { functionName: "ul.upload" },
    version: "4",
  });
  assert(!JSON.stringify(view).includes("encrypted-secret-value"));
  assert(!JSON.stringify(view).includes("variableName"));
});

Deno.test("Compute Launch rejects inconsistent secret copies as a control-plane integrity failure", async () => {
  const service = createComputeLaunchService({
    operations: baseOperations({
      listSecretBindings: async () => [
        secret("develop", BINDING_A),
        secret("review", BINDING_B, {
          delivery: { kind: "raw_file", fileName: "anthropic" },
        }),
      ],
    }),
  });
  const error = await assertRejects(
    () => service.getSettings({ userId: USER_ID, agentId: AGENT_ID }),
    ComputeLaunchServiceError,
  );
  assertEquals(error.code, "COMPUTE_CONFIGURATION_INTEGRITY_ERROR");
  assertEquals(error.status, 503);
});

Deno.test("Compute Launch whole settings PUT rechecks the live ceiling and passes both CAS fences", async () => {
  const replacements: Record<string, unknown>[] = [];
  const replacementResult = {
    policy: policy({ revision: "4", authorityEpoch: "8" }),
    authorityRules: [rule({ authorityEpoch: "8" })],
    secretBindings: [
      secret("develop", BINDING_A, { bindingVersion: "3" }),
      secret("review", BINDING_B, { bindingVersion: "3" }),
    ],
  };
  const service = createComputeLaunchService({
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    operations: baseOperations({
      replaceConfiguration: async (input: Record<string, unknown>) => {
        replacements.push(input);
        return replacementResult;
      },
    }),
  });
  const view = await service.putSettings({
    userId: USER_ID,
    agentId: AGENT_ID,
    mutation: {
      expectedRevision: "3",
      ownerConfirmed: true,
      settings: {
        enabled: true,
        profile: "developer-v1",
        allowedTools: ["shell"],
        secretBindings: [{
          name: "ANTHROPIC_API_KEY",
          delivery: {
            kind: "file",
            path: "/run/galactic/secrets/anthropic-key",
          },
        }],
        authorityRules: [{
          callerFunction: "develop",
          decision: "always",
          action: "agents.call",
          target: { agentId: TARGET_AGENT_ID, functionName: "review" },
        }],
        limits: {
          maxTimeoutMs: 60_000,
          maxConcurrency: 1,
          maxArtifactBytes: 5_000_000,
          maxArtifacts: 5,
        },
      },
    },
  });

  assertEquals(view.revision, "4");
  assertEquals(replacements.length, 1);
  const replacement = replacements[0];
  assertEquals(replacement.expectedRevision, "3");
  assertEquals(replacement.expectedAuthorityEpoch, "7");
  assertEquals(replacement.callerFunctions, ["develop", "review"]);
  assertEquals(replacement.ownerConfirmedAt, "2026-07-20T12:00:00.000Z");
  assertEquals(replacement.secretBindings, [{
    name: "ANTHROPIC_API_KEY",
    variableName: "ANTHROPIC_API_KEY",
    delivery: { kind: "raw_file", fileName: "anthropic-key" },
    expiresAt: null,
  }]);
  assertEquals(replacement.authorityRules, [{
    callerFunction: "develop",
    decision: "always",
    authority: {
      action: "agents.call",
      target: {
        kind: "agent_function",
        agentId: TARGET_AGENT_ID,
        functionName: "review",
      },
      constraints: {},
    },
  }]);
});

Deno.test("Compute Launch rejects a stale settings revision before whole replacement", async () => {
  let replaced = false;
  const service = createComputeLaunchService({
    operations: baseOperations({
      replaceConfiguration: async () => {
        replaced = true;
        throw new Error("must not run");
      },
    }),
  });
  const error = await assertRejects(
    () => service.putSettings({
      userId: USER_ID,
      agentId: AGENT_ID,
      mutation: {
        expectedRevision: "2",
        ownerConfirmed: true,
        settings: {
          enabled: false,
          profile: "developer-v1",
          allowedTools: ["shell"],
          secretBindings: [],
          authorityRules: [],
          limits: {
            maxTimeoutMs: 60_000,
            maxConcurrency: 1,
            maxArtifactBytes: 5_000_000,
            maxArtifacts: 5,
          },
        },
      },
    }),
    ComputeLaunchServiceError,
  );
  assertEquals(error.code, "COMPUTE_POLICY_CONFLICT");
  assertEquals(replaced, false);
});

Deno.test("Compute Launch history uses an opaque stable cursor and returns no artifact locator", async () => {
  const olderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const paths: string[] = [];
  let page = [
    ownerRunRow({
      artifacts: [
        artifactRow(artifact()),
        artifactRow(artifact({
          id: EXPIRED_ARTIFACT_ID,
          expiresAt: "2026-07-20T11:59:59.000Z",
        })),
      ],
      receipt: {
        id: RECEIPT_ID,
        capacity_settlement_status: "not_applicable",
        reserved_light: 1.25,
        actual_light: 0.5,
        released_light: 0.75,
      },
      budget: null,
      state: "succeeded",
      finished_at: "2026-07-20T00:00:03.000Z",
      exit_code: 0,
    }),
    ownerRunRow({
      id: olderId,
      receipt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      created_at: "2026-07-19T23:00:00.000Z",
    }),
  ];
  const service = createComputeLaunchService({
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    operations: baseOperations({
      queryRows: async (path: string) => {
        paths.push(path);
        if (path.startsWith("apps?")) return [appRow()];
        return page;
      },
    }),
  });
  const first = await service.listRuns({
    userId: USER_ID,
    agentId: AGENT_ID,
    limit: 1,
    cursor: null,
  });
  assertEquals(first.runs[0].status, "completed");
  assertEquals(first.runs[0].usage, {
    reserved: 1.25,
    actual: 0.5,
    trueUp: -0.75,
    unit: "Light",
  });
  assertEquals(first.runs[0].artifacts, [{
    id: ARTIFACT_ID,
    name: "report.txt",
    sizeBytes: 5,
    expiresAt: "2099-07-20T00:00:00.000Z",
    url: null,
  }]);
  assert(first.nextCursor !== null);
  assert(!JSON.stringify(first).includes("compute-v1/"));
  const firstRunQuery = paths.find((path) => path.startsWith("compute_runs?"));
  assert(firstRunQuery);
  assert(!decodeURIComponent(firstRunQuery).includes("storage_key"));

  page = [];
  await service.listRuns({
    userId: USER_ID,
    agentId: AGENT_ID,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert(paths.at(-1)!.includes("created_at.lt."));
  assert(paths.at(-1)!.includes(`id.lt.${RUN_ID}`));
});

Deno.test("Compute Launch keeps subscription receipts pending and never fabricates a wallet link", async () => {
  const service = createComputeLaunchService({
    operations: baseOperations({
      queryRows: (path: string) => Promise.resolve(
        path.startsWith("apps?")
          ? [appRow()]
          : [ownerRunRow({
            billing_mode: "subscription_capacity",
            state: "succeeded",
            finished_at: "2026-07-20T00:00:03.000Z",
            receipt: {
              id: RECEIPT_ID,
              capacity_settlement_status: "pending",
              reserved_light: 0.49344,
              actual_light: 0.6,
              released_light: 0,
            },
            budget: null,
          })],
      ),
    }),
  });
  const page = await service.listRuns({
    userId: USER_ID,
    agentId: AGENT_ID,
    limit: 10,
    cursor: null,
  });
  assertEquals(page.runs[0].billingMode, "subscription_capacity");
  assertEquals(page.runs[0].status, "settlement_pending");
  assertEquals(page.runs[0].receiptUrl, null);
  assertEquals(page.runs[0].usage.trueUp, 0.6 - 0.49344);
});

Deno.test("Compute Launch cancellation delegates the fenced destroy/settle sequence and reloads terminal state", async () => {
  const order: string[] = [];
  let cancelled = false;
  const service = createComputeLaunchService({
    cancellation: {
      async cancelActiveRun(input: ComputeLaunchCancellationInput) {
        order.push(`cancel:${input.run.id}`);
        cancelled = true;
      },
    },
    operations: baseOperations({
      queryRows: async (path: string) => {
        if (path.startsWith("apps?")) return [appRow()];
        order.push(cancelled ? "reload-terminal" : "load-active");
        return [cancelled
          ? ownerRunRow({
            state: "cancelled",
            state_version: "6",
            stop_requested_at: "2026-07-20T00:00:02.000Z",
            finished_at: "2026-07-20T00:00:03.000Z",
            terminal_reason: "owner_cancelled",
            receipt: {
              id: RECEIPT_ID,
              capacity_settlement_status: "not_applicable",
              reserved_light: 1.25,
              actual_light: 1.25,
              released_light: 0,
            },
            budget: null,
          })
          : ownerRunRow()];
      },
    }),
  });
  const result = await service.cancelRun({
    userId: USER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
  });
  assertEquals(order, ["load-active", `cancel:${RUN_ID}`, "reload-terminal"]);
  assertEquals(result.status, "cancelled");
  assertEquals(result.cancellable, false);
});

Deno.test("Compute Launch production cancellation fences, destroys, then terminalizes", async () => {
  const order: string[] = [];
  const running = computeRun();
  const fenced = computeRun({
    stateVersion: "5",
    stopRequestedAt: "2026-07-20T00:00:02.000Z",
    stopReason: "owner_cancelled",
  });
  const cancelled = computeRun({
    state: "cancelled",
    stateVersion: "6",
    stopRequestedAt: "2026-07-20T00:00:02.000Z",
    stopReason: "owner_cancelled",
    finishedAt: "2026-07-20T00:00:03.000Z",
    terminalReason: "owner_cancelled",
  });
  const fetchFn = async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    if (url.endsWith("/rpc/request_compute_run_cancellation")) {
      order.push("fence");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assertEquals(body.p_run_id, RUN_ID);
      return Response.json({ ...runDatabaseRow(fenced), replayed: false });
    }
    if (url.endsWith("/rpc/terminalize_compute_run_cancellation")) {
      order.push("terminalize");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assertEquals(body.p_expected_state_version, "5");
      assertEquals(body.p_body_destroyed, true);
      return Response.json({
        ...runDatabaseRow(cancelled),
        receipt: {
          id: RECEIPT_ID,
          run_id: RUN_ID,
          user_id: USER_ID,
          agent_id: AGENT_ID,
          billing_mode: "wallet",
          hold_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          capacity_agent_id: AGENT_ID,
          capacity_reservation_id: null,
          capacity_settlement_status: "not_applicable",
          cloud_usage_event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          outcome: "cancelled",
          rate_version: "compute-rate-v1",
          worker_wall_ms: null,
          teardown_allowance_ms: "15000",
          billed_wall_ms: "257000",
          reserved_light: 1.25,
          actual_light: 1.25,
          released_light: 0,
          created_at: "2026-07-20T00:00:03.000Z",
        },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const orchestrator = createComputeLaunchCancellationOrchestrator({
    bodyDestroyer: {
      async destroyRunBody(runId) {
        assertEquals(runId, RUN_ID);
        order.push("destroy");
      },
    },
    database: {
      supabaseUrl: "https://database.invalid",
      serviceRoleKey: "service-role-test-only",
      fetchFn: fetchFn as typeof fetch,
    },
  });
  await orchestrator.cancelActiveRun({
    userId: USER_ID,
    agentId: AGENT_ID,
    run: running,
  });
  assertEquals(order, ["fence", "destroy", "terminalize"]);
});

Deno.test("Compute Launch artifact download requires exact ready output metadata and streams without a locator", async () => {
  const objectBytes = new TextEncoder().encode("hello");
  const checksum = new Uint8Array(32).fill(0xaa).buffer;
  let requestedKey = "";
  const service = createComputeLaunchService({
    operations: baseOperations({
      queryRows: async (path: string) => path.startsWith("apps?")
        ? [appRow()]
        : [ownerRunRow()],
      getArtifactObject: async (storageKey: string) => {
        requestedKey = storageKey;
        return {
          body: new Blob([objectBytes]).stream(),
          size: objectBytes.byteLength,
          checksums: { sha256: checksum },
        } as unknown as R2ObjectBody;
      },
    }),
  });
  const download = await service.downloadArtifact({
    userId: USER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    artifactId: ARTIFACT_ID,
  });
  assertEquals(await new Response(download.body).text(), "hello");
  assertEquals(download, {
    body: download.body,
    contentType: "text/plain",
    contentLength: 5,
    fileName: "report.txt",
  });
  assert(requestedKey.startsWith(`compute-v1/${USER_ID}/${AGENT_ID}/${RUN_ID}/`));
  assertEquals("storageKey" in download, false);

  const denied = createComputeLaunchService({
    operations: baseOperations({
      queryRows: async (path: string) => path.startsWith("apps?")
        ? [appRow()]
        : [ownerRunRow()],
      leaseArtifactDownload: async () => artifact({ direction: "input" }),
    }),
  });
  const error = await assertRejects(
    () => denied.downloadArtifact({
      userId: USER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
    }),
    ComputeLaunchServiceError,
  );
  assertEquals(error.code, "COMPUTE_ARTIFACT_NOT_FOUND");
});

Deno.test("Compute Launch artifact download accepts trusted SHA-256 metadata fallback", async () => {
  const objectBytes = new TextEncoder().encode("hello");
  const service = createComputeLaunchService({
    operations: baseOperations({
      queryRows: async (path: string) => path.startsWith("apps?")
        ? [appRow()]
        : [ownerRunRow()],
      getArtifactObject: async () => ({
        body: new Blob([objectBytes]).stream(),
        size: objectBytes.byteLength,
        customMetadata: { sha256: "a".repeat(64) },
      } as unknown as R2ObjectBody),
    }),
  });

  const download = await service.downloadArtifact({
    userId: USER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    artifactId: ARTIFACT_ID,
  });
  assertEquals(await new Response(download.body).text(), "hello");
});

Deno.test("Compute Launch artifact download rejects absent or conflicting R2 digests", async () => {
  const objectBytes = new TextEncoder().encode("hello");
  const matchingChecksum = new Uint8Array(32).fill(0xaa).buffer;
  const mismatchedChecksum = new Uint8Array(32).fill(0xbb).buffer;
  const objects = [
    {
      body: new Blob([objectBytes]).stream(),
      size: objectBytes.byteLength,
    },
    {
      body: new Blob([objectBytes]).stream(),
      size: objectBytes.byteLength,
      checksums: { sha256: mismatchedChecksum },
    },
    {
      body: new Blob([objectBytes]).stream(),
      size: objectBytes.byteLength,
      checksums: { sha256: matchingChecksum },
      customMetadata: { sha256: "b".repeat(64) },
    },
  ];

  for (const object of objects) {
    const service = createComputeLaunchService({
      operations: baseOperations({
        queryRows: async (path: string) => path.startsWith("apps?")
          ? [appRow()]
          : [ownerRunRow()],
        getArtifactObject: async () => object as unknown as R2ObjectBody,
      }),
    });
    const error = await assertRejects(
      () => service.downloadArtifact({
        userId: USER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        artifactId: ARTIFACT_ID,
      }),
      ComputeLaunchServiceError,
    );
    assertEquals(error.code, "COMPUTE_ARTIFACT_UNAVAILABLE");
  }
});

Deno.test("Compute Launch never reads R2 when the download lease is expired", async () => {
  let objectRead = false;
  const service = createComputeLaunchService({
    operations: baseOperations({
      queryRows: async (path: string) => path.startsWith("apps?")
        ? [appRow()]
        : [ownerRunRow()],
      leaseArtifactDownload: async () => null,
      getArtifactObject: async () => {
        objectRead = true;
        return null;
      },
    }),
  });
  const error = await assertRejects(
    () => service.downloadArtifact({
      userId: USER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
    }),
    ComputeLaunchServiceError,
  );
  assertEquals(error.code, "COMPUTE_ARTIFACT_NOT_FOUND");
  assertEquals(objectRead, false);
});
