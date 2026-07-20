import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  handleComputePrivateGatewayRequest,
  handleTrustedComputeLifecycleRequest,
  type ComputePrivateGatewayDeps,
} from "./compute-private-gateway.ts";
import type { ComputeJobTokenIntrospection } from "./compute/tokens.ts";
import type {
  ComputeArtifact,
  ComputeAuthority,
  ComputeRun,
  ComputeRunBudgetReservation,
} from "./compute/types.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const IDEMPOTENCY_ID = "66666666-6666-4666-8666-666666666666";
const CAPACITY_AGENT_ID = "99999999-9999-4999-8999-999999999998";
const TOKEN = "opaque-compute-job-token";
const CONTAINER_ID = "sandbox-run-333";
const DIGEST = "a".repeat(64);

function digestBuffer(hex: string): ArrayBuffer {
  return Uint8Array.from(
    hex.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  ).buffer;
}

function introspection(
  overrides: Partial<ComputeJobTokenIntrospection> = {},
): ComputeJobTokenIntrospection {
  return {
    allowed: true,
    code: "ok",
    runId: RUN_ID,
    agentId: AGENT_ID,
    userId: USER_ID,
    callerFunction: "develop",
    authorityId: "77777777-7777-4777-8777-777777777777",
    expiresAt: "2026-07-20T02:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<ComputeRun> = {}): ComputeRun {
  return {
    id: RUN_ID,
    receiptId: RECEIPT_ID,
    leaseId: "88888888-8888-4888-8888-888888888888",
    userId: USER_ID,
    agentId: AGENT_ID,
    callerFunction: "develop",
    executionId: "execution-server-derived",
    directiveHash: "b".repeat(64),
    profile: "developer-v1",
    environmentDigest: `sha256:${"c".repeat(64)}`,
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
      maxTimeoutMs: 60_000,
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
    state: "running",
    stateVersion: "3",
    expiresAt: "2026-07-20T02:00:00.000Z",
    startedAt: "2026-07-20T01:00:00.000Z",
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
    createdAt: "2026-07-20T00:59:00.000Z",
    updatedAt: "2026-07-20T01:00:00.000Z",
    ...overrides,
  };
}

function artifact(overrides: Partial<ComputeArtifact> = {}): ComputeArtifact {
  return {
    id: ARTIFACT_ID,
    runId: RUN_ID,
    userId: USER_ID,
    sourceArtifactId: null,
    direction: "output",
    mountPath: null,
    logicalName: "report.pdf",
    mediaType: "application/pdf",
    storageKey:
      `compute-v1/${USER_ID}/${AGENT_ID}/${RUN_ID}/outputs/gx-${ARTIFACT_ID}`,
    sha256: DIGEST,
    sizeBytes: "3",
    state: "pending",
    stateVersion: "1",
    expiresAt: null,
    retentionProtectedUntil: null,
    objectDeletedAt: null,
    createdAt: "2026-07-20T01:00:00.000Z",
    updatedAt: "2026-07-20T01:00:00.000Z",
    ...overrides,
  };
}

function privateRequest(
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  headers.set("x-galactic-container-id", CONTAINER_ID);
  return new Request(`https://galactic.internal${path}`, { ...init, headers });
}

function authorizedDeps(
  extra: ComputePrivateGatewayDeps = {},
): ComputePrivateGatewayDeps {
  return {
    authorizeExact: () => Promise.resolve(introspection()),
    getRun: () => Promise.resolve(run()),
    ...extra,
  };
}

Deno.test("private Compute gateway rejects missing token/container before persistence", async () => {
  let calls = 0;
  const response = await handleComputePrivateGatewayRequest(
    new Request("https://galactic.internal/v1/budget"),
    {
      authorizeExact: () => {
        calls += 1;
        return Promise.resolve(introspection());
      },
    },
  );
  assertEquals(response.status, 401);
  assertEquals(calls, 0);
});

Deno.test("budget is caller-current and omits wallet hold identity", async () => {
  const authorities: ComputeAuthority[] = [];
  const budget: ComputeRunBudgetReservation = {
    id: "99999999-9999-4999-8999-999999999999",
    runId: RUN_ID,
    billingMode: "wallet",
    holdId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    capacityAgentId: AGENT_ID,
    capacityReservationId: null,
    rateVersion: "compute-rate-v1",
    rateLightPerMs: 0.000002056,
    reservedWallMs: "257000",
    reservedLight: 0.528392,
    actualWallMs: null,
    actualLight: 0,
    releasedLight: 0,
    status: "reserved",
    expiresAt: "2026-07-20T02:00:00.000Z",
  };
  const response = await handleComputePrivateGatewayRequest(
    privateRequest("/v1/budget?run_id=attacker", { method: "GET" }),
    authorizedDeps({
      authorizeExact: (input) => {
        authorities.push(input.authority as ComputeAuthority);
        return Promise.resolve(introspection());
      },
      getBudget: (owner) => {
        assertEquals(owner, {
          runId: RUN_ID,
          userId: USER_ID,
          agentId: AGENT_ID,
          callerFunction: "develop",
        });
        return Promise.resolve(budget);
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(authorities, [{
    action: "budget.read",
    target: { kind: "run" },
    constraints: {},
  }]);
  const body = await response.json() as Record<string, unknown>;
  assertEquals(body.run_id, RUN_ID);
  assertEquals("hold_id" in body, false);
  assertEquals(JSON.stringify(body).includes(budget.holdId), false);
});

Deno.test("MCP strips the job bearer and re-introspects platform plus exact Agent call", async () => {
  const checked: ComputeAuthority[] = [];
  let downstreamAuthorization: string | null = "not-called";
  let observedExecutionId = "";
  const response = await handleComputePrivateGatewayRequest(
    privateRequest("/v1/mcp/platform", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "gx.call", arguments: {} },
      }),
    }),
    authorizedDeps({
      getRun: () => Promise.resolve(run({ capacityAgentId: CAPACITY_AGENT_ID })),
      introspectPrincipal: () => Promise.resolve({
        principal: introspection(),
        authorities: [{
          id: "77777777-7777-4777-8777-777777777777",
          authority: {
            action: "platform.call",
            target: { kind: "platform_function", functionName: "ul.call" },
            constraints: {},
          },
        }],
      }),
      authorizeExact: (input) => {
        checked.push(input.authority as ComputeAuthority);
        return Promise.resolve(introspection());
      },
      resolveUser: () => Promise.resolve({
        id: USER_ID,
        email: "owner@example.com",
        displayName: "Owner",
        avatarUrl: null,
        tier: "pro",
      }),
      dispatchAgentFunction: async (call, principal, deps) => {
        observedExecutionId = principal.executionId;
        assertEquals(call.userId, USER_ID);
        assertEquals(principal.capacityAgentId, CAPACITY_AGENT_ID);
        assert(await deps.authorizeExact({
          targetAgentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          functionName: "summarize",
        }));
        return { ok: true };
      },
      dispatchPlatformMcp: async (request, principal) => {
        downstreamAuthorization = request.headers.get("authorization");
        assertEquals(principal.allowedPlatformFunctions, ["ul.call"]);
        assertEquals(principal.computeAttribution, {
          runId: RUN_ID,
          sourceAgentId: AGENT_ID,
          capacityAgentId: CAPACITY_AGENT_ID,
          callerFunction: "develop",
        });
        const result = await principal.executeAgentFunction?.({
          userId: USER_ID,
          requestedAgentId: "target",
          agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          functionName: "summarize",
          args: { text: "hello" },
          confirmed: true,
        });
        return new Response(JSON.stringify(result));
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(downstreamAuthorization, null);
  assertEquals(observedExecutionId, "execution-server-derived");
  assertEquals(checked, [
    {
      action: "platform.call",
      target: { kind: "platform_function", functionName: "ul.call" },
      constraints: {},
    },
    {
      action: "agents.call",
      target: {
        kind: "agent_function",
        agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        functionName: "summarize",
      },
      constraints: {},
    },
  ]);
});

Deno.test("MCP exact denial occurs before platform dispatch", async () => {
  let dispatches = 0;
  const response = await handleComputePrivateGatewayRequest(
    privateRequest("/v1/mcp/platform", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "gx.upload", arguments: {} },
      }),
    }),
    authorizedDeps({
      introspectPrincipal: () => Promise.resolve({
        principal: introspection(),
        authorities: [],
      }),
      authorizeExact: () => Promise.resolve(introspection({
        allowed: false,
        code: "authority_denied",
        authorityId: null,
      })),
      dispatchPlatformMcp: () => {
        dispatches += 1;
        return Promise.resolve(new Response("unexpected"));
      },
    }),
  );
  assertEquals(response.status, 403);
  assertEquals(dispatches, 0);
});

Deno.test("artifact pull can read only a ready input alias for the current run", async () => {
  let requestedKey = "";
  const input = artifact({
    direction: "input",
    mountPath: "inputs/source.csv",
    logicalName: "source.csv",
    mediaType: "text/csv",
    storageKey: `compute-v1/${USER_ID}/${AGENT_ID}/${RUN_ID}/inputs/${ARTIFACT_ID}`,
    state: "ready",
    sizeBytes: "3",
  });
  const response = await handleComputePrivateGatewayRequest(
    privateRequest(`/v1/artifacts/${ARTIFACT_ID}`, { method: "GET" }),
    authorizedDeps({
      getInputArtifact: (owner) => {
        assertEquals(owner.sourceArtifactId, ARTIFACT_ID);
        assertEquals(owner.runId, RUN_ID);
        assertEquals(owner.userId, USER_ID);
        return Promise.resolve(input);
      },
      artifactBucket: {
        get(key) {
          requestedKey = key;
          return Promise.resolve({
            body: new Response(new Uint8Array([1, 2, 3])).body!,
            size: 3,
            checksums: { sha256: digestBuffer(DIGEST) },
          } as R2ObjectBody);
        },
        put: () => Promise.resolve(null as never),
        delete: () => Promise.resolve(),
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(requestedKey, input.storageKey);
  assertEquals(response.headers.get("x-galactic-sha256"), DIGEST);
  assertEquals(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

Deno.test("artifact push is pending -> checksum-bound R2 put -> ready CAS", async () => {
  const transitions: Array<Record<string, unknown>> = [];
  let putKey = "";
  let putDigest: unknown;
  let putBytes = new Uint8Array();
  const ids = [ARTIFACT_ID];
  const pending = artifact();
  const ready = artifact({
    state: "ready",
    stateVersion: "2",
    expiresAt: "2026-08-19T01:00:00.000Z",
  });
  const response = await handleComputePrivateGatewayRequest(
    privateRequest("/v1/artifacts?name=report.pdf", {
      method: "PUT",
      headers: {
        "content-type": "application/pdf",
        "content-length": "3",
        "x-galactic-sha256": DIGEST,
        "x-galactic-idempotency-key": IDEMPOTENCY_ID,
      },
      body: new Uint8Array([1, 2, 3]),
    }),
    authorizedDeps({
      createUuid: () => ids.shift()!,
      registerArtifact: (input) => {
        assertEquals(input.artifactId, ARTIFACT_ID);
        assertEquals(input.idempotencyKey, IDEMPOTENCY_ID);
        assertEquals(input.sizeBytes, 3);
        return Promise.resolve({ artifact: pending, replayed: false });
      },
      transitionArtifact: (input) => {
        transitions.push(input as unknown as Record<string, unknown>);
        return Promise.resolve(ready);
      },
      artifactBucket: {
        get: () => Promise.resolve(null),
        async put(key, value, options) {
          putKey = key;
          putDigest = options?.sha256;
          putBytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
          return null as never;
        },
        delete: () => Promise.resolve(),
      },
    }),
  );
  assertEquals(response.status, 201);
  assertEquals(putKey, pending.storageKey);
  assertEquals(putDigest, DIGEST);
  assertEquals(putBytes, new Uint8Array([1, 2, 3]));
  assertEquals(transitions.length, 1);
  assertEquals(transitions[0].expectedState, "pending");
  assertEquals(transitions[0].toState, "ready");
  const payload = await response.json() as Record<string, unknown>;
  assertEquals(payload.artifact_id, ARTIFACT_ID);
  assertEquals(payload.expires_at, ready.expiresAt);
});

Deno.test("pending artifact replay writes the originally reserved R2 key", async () => {
  const proposedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const pending = artifact();
  const ready = artifact({
    state: "ready",
    stateVersion: "2",
    expiresAt: "2026-08-19T01:00:00.000Z",
  });
  let proposedKey = "";
  let putKey = "";
  const response = await handleComputePrivateGatewayRequest(
    privateRequest("/v1/artifacts?name=report.pdf", {
      method: "PUT",
      headers: {
        "content-type": "application/pdf",
        "content-length": "3",
        "x-galactic-sha256": DIGEST,
        "x-galactic-idempotency-key": IDEMPOTENCY_ID,
      },
      body: new Uint8Array([1, 2, 3]),
    }),
    authorizedDeps({
      createUuid: () => proposedId,
      registerArtifact: (input) => {
        proposedKey = input.storageKey;
        return Promise.resolve({ artifact: pending, replayed: true });
      },
      transitionArtifact: () => Promise.resolve(ready),
      artifactBucket: {
        get: () => Promise.resolve(null),
        async put(key) {
          putKey = key;
          return null as never;
        },
        delete: () => Promise.resolve(),
      },
    }),
  );
  assertEquals(response.status, 201);
  assert(proposedKey.endsWith(`/gx-${proposedId}`));
  assertEquals(putKey, pending.storageKey);
});

Deno.test("failed artifact storage is deleted and pending metadata is tombstoned", async () => {
  let deletes = 0;
  let tombstones = 0;
  let confirmations = 0;
  const ids = [ARTIFACT_ID];
  const response = await handleComputePrivateGatewayRequest(
    privateRequest("/v1/artifacts?name=report.pdf", {
      method: "PUT",
      headers: {
        "content-type": "application/pdf",
        "content-length": "3",
        "x-galactic-sha256": DIGEST,
        "x-galactic-idempotency-key": IDEMPOTENCY_ID,
      },
      body: new Uint8Array([1, 2, 3]),
    }),
    authorizedDeps({
      createUuid: () => ids.shift()!,
      registerArtifact: () => Promise.resolve({
        artifact: artifact(),
        replayed: false,
      }),
      getArtifact: () => Promise.resolve(artifact()),
      transitionArtifact: (input) => {
        if (input.toState === "deleted") tombstones += 1;
        return Promise.resolve(artifact({ state: "deleted", stateVersion: "2" }));
      },
      confirmArtifactObjectDeleted: () => {
        confirmations += 1;
        return Promise.resolve(artifact({
          state: "deleted",
          stateVersion: "2",
          objectDeletedAt: "2026-07-20T01:01:00.000Z",
        }));
      },
      artifactBucket: {
        get: () => Promise.resolve(null),
        put: () => Promise.reject(new Error("checksum mismatch")),
        delete: () => {
          deletes += 1;
          return Promise.resolve();
        },
      },
    }),
  );
  assertEquals(response.status, 502);
  assertEquals(deletes, 1);
  assertEquals(tombstones, 1);
  assertEquals(confirmations, 1);
});

Deno.test("lost ready-CAS response never deletes a committed artifact", async () => {
  let deletes = 0;
  const response = await handleComputePrivateGatewayRequest(
    privateRequest("/v1/artifacts?name=report.pdf", {
      method: "PUT",
      headers: {
        "content-type": "application/pdf",
        "content-length": "3",
        "x-galactic-sha256": DIGEST,
        "x-galactic-idempotency-key": IDEMPOTENCY_ID,
      },
      body: new Uint8Array([1, 2, 3]),
    }),
    authorizedDeps({
      createUuid: () => ARTIFACT_ID,
      registerArtifact: () => Promise.resolve({
        artifact: artifact(),
        replayed: false,
      }),
      transitionArtifact: () => Promise.reject(new Error("response lost")),
      getArtifact: () => Promise.resolve(artifact({
        state: "ready",
        stateVersion: "2",
      })),
      artifactBucket: {
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(null as never),
        delete: () => {
          deletes += 1;
          return Promise.resolve();
        },
      },
    }),
  );
  assertEquals(response.status, 200);
  assertEquals(deletes, 0);
  assertEquals((await response.json() as Record<string, unknown>).state, "ready");
});

Deno.test("named lifecycle seam rejects bearers and normalizes Worker receipts", async () => {
  const bearer = await handleTrustedComputeLifecycleRequest(
    privateRequest(`/internal/compute/runs/${RUN_ID}/complete`, {
      method: "POST",
    }),
    {
      internalRequestHandler: () => Promise.resolve(new Response("unexpected")),
    },
  );
  assertEquals(bearer.status, 403);

  let verified = false;
  let hasMaterializer = false;
  const response = await handleTrustedComputeLifecycleRequest(
    new Request(
      `https://galactic.internal/internal/compute/runs/${RUN_ID}/complete`,
      { method: "POST", body: "{}" },
    ),
    {
      internalRequestHandler: async (_request, deps) => {
        verified = await deps.verifyServiceBindingRequest?.(_request) === true;
        hasMaterializer = typeof deps.materializeSecretValues === "function";
        return new Response(JSON.stringify({
          id: RECEIPT_ID,
          runId: RUN_ID,
          outcome: "succeeded",
        }), { headers: { "content-type": "application/json" } });
      },
    },
  );
  assertEquals(response.status, 200);
  assert(verified);
  assert(hasMaterializer);
  assertEquals(await response.json(), {
    receipt_id: RECEIPT_ID,
    run_id: RUN_ID,
    status: "succeeded",
  });
});
