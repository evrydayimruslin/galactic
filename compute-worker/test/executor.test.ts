import { describe, expect, it, vi } from "vitest";
import type {
  ClaimedComputeRun,
  ComputeArtifactBucket,
  ComputeExecutionSession,
  ClaimComputeRunResponse,
  ComputeSandboxStub,
  Env,
  PreparedComputeLease,
} from "../src/contracts";
import {
  boundedArtifactStream,
  cancelComputeSandbox,
  ComputeRunBusyError,
  executeComputeRun,
  parseDispatchMessage,
  sandboxContainerIdForRun,
  sandboxIdForRun,
  validateClaimedRun,
  validatePreparedLease,
} from "../src/executor";

vi.mock("@cloudflare/sandbox", () => ({ getSandbox: vi.fn() }));

const RUN_ID = "00000000-0000-4000-8000-000000000010";
const LEASE_ID = "00000000-0000-4000-8000-000000000011";
const RECEIPT_ID = "00000000-0000-4000-8000-000000000012";
const JOB_TOKEN = "job_test_token";
const DEVELOPER_SECRET = "developer-secret";
const CONTAINER_ID = "a".repeat(64);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function claimedRun(overrides: Partial<ClaimedComputeRun> = {}): ClaimedComputeRun {
  return {
    run_id: RUN_ID,
    account_id: "00000000-0000-4000-8000-000000000001",
    agent_id: "app-demo",
    function_name: "research",
    execution_id: null,
    profile: "developer-v1",
    environment_digest: `sha256:${"b".repeat(64)}`,
    argv: ["printf", "hello"],
    cwd: ".",
    stdin: null,
    timeout_ms: 10_000,
    capture_paths: [],
    max_artifacts: 10,
    max_artifact_bytes: 104_857_600,
    input_artifacts: [],
    toolpacks: [],
    started_at: null,
    lease_expires_at: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function preparedLease(
  overrides: Partial<PreparedComputeLease> = {},
): PreparedComputeLease {
  return {
    lease_id: LEASE_ID,
    job_token: JOB_TOKEN,
    expires_at: "2099-01-01T00:00:00.000Z",
    reserved_wall_ms: 207_000,
    gateway_url: "https://galactic.internal/v1",
    secrets: [{
      binding_id: "secret-1",
      version: 1,
      destination: { kind: "env", name: "ANTHROPIC_API_KEY" },
      value: DEVELOPER_SECRET,
    }],
    ...overrides,
  };
}

interface SessionOptions {
  stdout?: string;
  stderr?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  waitForAbort?: boolean;
  writeError?: { path: string; message: string };
  captureKind?: "missing" | "unsafe" | "file" | "directory";
  captureSize?: number;
  onUserExec?: () => void;
  beforeWriteCompletes?: (path: string) => Promise<void> | void;
  workspaceAvailableKiB?: number;
}

function makeSession(
  events: string[],
  options: SessionOptions = {},
): ComputeExecutionSession {
  const files = new Map<string, string>();
  return {
    id: `lease-${RUN_ID}`,
    async mkdir(path) {
      events.push(`mkdir:${path}`);
    },
    async writeFile(path, content) {
      events.push(`write:${path}`);
      if (options.writeError?.path === path) {
        throw new Error(options.writeError.message);
      }
      await options.beforeWriteCompletes?.(path);
      files.set(path, typeof content === "string" ? content : "<stream>");
      events.push(`write-complete:${path}`);
    },
    async exec(command, execOptions) {
      if (execOptions?.origin === "user") {
        events.push("exec:user");
        options.onUserExec?.();
        if (options.waitForAbort) {
          return await new Promise((resolve, reject) => {
            const signal = execOptions.signal;
            if (signal?.aborted) return reject(new Error("command aborted"));
            signal?.addEventListener(
              "abort",
              () => reject(new Error("command aborted")),
              { once: true },
            );
          });
        }
        const stdout = options.stdout ?? "hello";
        const stderr = options.stderr ?? "";
        files.set("/tmp/galactic-output/exit-code", "0");
        files.set("/tmp/galactic-output/stdout", stdout);
        files.set("/tmp/galactic-output/stderr", stderr);
        files.set(
          "/tmp/galactic-output/stdout-bytes",
          String(options.stdoutBytes ?? new TextEncoder().encode(stdout).byteLength),
        );
        files.set(
          "/tmp/galactic-output/stderr-bytes",
          String(options.stderrBytes ?? new TextEncoder().encode(stderr).byteLength),
        );
        return { success: true, exitCode: 0, stdout: "", stderr: "" };
      }
      events.push(`exec:${command.split(" ")[0]}`);
      if (command.startsWith("df -Pk")) {
        return {
          success: true,
          exitCode: 0,
          stdout: String(options.workspaceAvailableKiB ?? 4 * 1024 * 1024),
          stderr: "",
        };
      }
      if (command.startsWith("resolved=")) {
        return {
          success: true,
          exitCode: 0,
          stdout: options.captureKind ?? "missing",
          stderr: "",
        };
      }
      if (command.startsWith("stat -c")) {
        return {
          success: true,
          exitCode: 0,
          stdout: String(options.captureSize ?? 0),
          stderr: "",
        };
      }
      if (command.startsWith("sha256sum")) {
        return {
          success: true,
          exitCode: 0,
          stdout: "a".repeat(64),
          stderr: "",
        };
      }
      return { success: true, exitCode: 0, stdout: "", stderr: "" };
    },
    async readFile(path) {
      return { content: files.get(path) ?? "" };
    },
    async readFileStream() {
      const bytes = options.captureSize ?? 0;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (bytes > 0) controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
    },
  };
}

interface HarnessOptions {
  run?: Partial<ClaimedComputeRun>;
  lease?: Partial<PreparedComputeLease>;
  claim?: ClaimComputeRunResponse;
  failCreate?: boolean;
  session?: SessionOptions;
  operationFailures?: Record<string, number>;
  operationTransportFailures?: Record<string, number>;
  heartbeat?: { cancelled: boolean; expires_at: string };
  destroyFailures?: number;
  beforeCreate?: () => Promise<void>;
  bucketObjects?: Map<string, string>;
}

function makeHarness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const requests: Array<{ operation: string; body: unknown }> = [];
  const puts: Array<{ key: string; options?: { sha256?: string } }> = [];
  const bucketObjects = options.bucketObjects ?? new Map<string, string>();
  const session = makeSession(events, options.session);
  let destroyFailures = options.destroyFailures ?? 0;
  const sandbox: ComputeSandboxStub = {
    async createSession() {
      events.push("sandbox:create");
      await options.beforeCreate?.();
      if (options.failCreate) throw new Error("container unavailable");
      return session;
    },
    async deleteSession() {
      events.push("sandbox:delete-session");
    },
    async destroy() {
      events.push("sandbox:destroy");
      if (destroyFailures > 0) {
        destroyFailures -= 1;
        throw new Error("destroy unavailable");
      }
    },
    async getContainerPlacementId() {
      return "placement-a";
    },
  };
  const failures = { ...(options.operationFailures ?? {}) };
  const transportFailures = { ...(options.operationTransportFailures ?? {}) };
  const controlPlane = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const path = new URL(String(input)).pathname;
      const operation = path.split("/").at(-1) ?? "";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ operation, body });
      events.push(`control:${operation}`);
      if ((transportFailures[operation] ?? 0) > 0) {
        transportFailures[operation] = (transportFailures[operation] ?? 0) - 1;
        throw new Error("service-binding response lost after commit");
      }
      if ((failures[operation] ?? 0) > 0) {
        failures[operation] = (failures[operation] ?? 0) - 1;
        return json({ error: `${JOB_TOKEN} ${DEVELOPER_SECRET}` }, 503);
      }
      if (operation === "claim") {
        return json(options.claim ?? {
          claimed: true,
          recovered: false,
          run: claimedRun(options.run),
        });
      }
      if (operation === "prepare-lease") return json(preparedLease(options.lease));
      if (operation === "complete") {
        return json({ receipt_id: RECEIPT_ID, run_id: RUN_ID, status: "succeeded" });
      }
      if (operation === "fail") {
        return json({ receipt_id: RECEIPT_ID, run_id: RUN_ID, status: "failed" });
      }
      if (operation === "heartbeat") {
        return json(options.heartbeat ?? {
          cancelled: false,
          expires_at: "2099-01-01T00:00:00.000Z",
        });
      }
      if (operation === "reserve-output") {
        return json({
          artifact_id: body.artifact_id,
          state: "pending",
          state_version: "1",
          object_key: body.object_key,
          sha256: body.sha256,
          size_bytes: body.size_bytes,
          replayed: false,
        });
      }
      if (operation === "commit-output") {
        return json({
          artifact_id: body.artifact_id,
          state: "ready",
          state_version: "2",
          object_key: `committed/${String(body.artifact_id)}`,
          sha256: body.sha256,
          size_bytes: body.size_bytes,
        });
      }
      return json({}, 404);
    },
  };
  const bucket: ComputeArtifactBucket = {
    async get(key) {
      const value = bucketObjects.get(key);
      if (value === undefined) {
        if (!key.startsWith("_galactic-control/")) events.push("r2:get");
        return null;
      }
      const encoded = new TextEncoder().encode(value);
      return {
        size: encoded.byteLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded);
            controller.close();
          },
        }),
      };
    },
    async put(key, value, putOptions) {
      if (key.startsWith("_galactic-control/")) {
        events.push("checkpoint:put");
        if (typeof value === "string") bucketObjects.set(key, value);
        return;
      }
      events.push("r2:put");
      puts.push({ key, ...(putOptions ? { options: putOptions } : {}) });
      if (typeof value === "string") bucketObjects.set(key, value);
    },
    async delete(key) {
      if (key.startsWith("_galactic-control/")) events.push("checkpoint:delete");
      bucketObjects.delete(key);
    },
  };
  const env = {
    CONTROL_PLANE: controlPlane,
    COMPUTE_ARTIFACTS: bucket,
    COMPUTE_STANDARD: {
      idFromName(name: string) {
        if (name !== `run-${RUN_ID}`) throw new Error("unexpected Sandbox name");
        return { toString: () => CONTAINER_ID };
      },
    } as unknown as DurableObjectNamespace,
    ENVIRONMENT: "staging",
    COMPUTE_ENVIRONMENT_DIGEST: `sha256:${"b".repeat(64)}`,
    HEARTBEAT_INTERVAL_MS: "60000",
    MAX_OUTPUT_BYTES: "128",
  } as Env;
  const delays: number[] = [];
  const dependencies = {
    sandboxForRun: () => {
      events.push("sandbox:resolve");
      return sandbox;
    },
    now: () => 1_000,
    finalizationDelay: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
  };
  return {
    env,
    events,
    requests,
    puts,
    sandbox,
    dependencies,
    delays,
    bucketObjects,
  };
}

function operations(
  requests: Array<{ operation: string }>,
  name: string,
): number {
  return requests.filter((request) => request.operation === name).length;
}

describe("compute boundary validation", () => {
  it("strictly validates versioned dispatches and derives one sandbox per run", () => {
    expect(parseDispatchMessage({ version: 1, run_id: RUN_ID })).toEqual({
      version: 1,
      run_id: RUN_ID,
    });
    expect(sandboxIdForRun(RUN_ID)).toBe(`run-${RUN_ID}`);
    expect(sandboxContainerIdForRun({
      idFromName(name: string) {
        expect(name).toBe(`run-${RUN_ID}`);
        return { toString: () => CONTAINER_ID } as DurableObjectId;
      },
    }, RUN_ID)).toBe(CONTAINER_ID);
    for (const invalid of [
      { version: 2, run_id: RUN_ID },
      { version: 1, run_id: RUN_ID, authority: "ambient" },
      [1, RUN_ID],
      null,
    ]) expect(() => parseDispatchMessage(invalid)).toThrow();
  });

  it("revalidates claimed paths, limits, identity, and rejects every v1 toolpack", () => {
    expect(validateClaimedRun(claimedRun(), RUN_ID).run_id).toBe(RUN_ID);
    expect(() => validateClaimedRun(claimedRun({ run_id: LEASE_ID }), RUN_ID)).toThrow(
      "does not match",
    );
    expect(() => validateClaimedRun(claimedRun({ cwd: "../escape" }), RUN_ID)).toThrow();
    expect(() => validateClaimedRun(claimedRun({ argv: [] as never }), RUN_ID)).toThrow();
    expect(() => validateClaimedRun(claimedRun({
      started_at: "not-a-time",
    }), RUN_ID)).toThrow("start time");
    expect(() => validateClaimedRun(claimedRun({
      max_artifact_bytes: 1_073_741_825,
    }), RUN_ID)).toThrow("artifact policy snapshot");
    expect(() => validateClaimedRun(claimedRun({
      toolpacks: [{
        name: "looks-valid",
        version: "1.0.0",
        object_key: "packs/looks-valid",
        sha256: "a".repeat(64),
        size_bytes: 10,
      }],
    }), RUN_ID)).toThrow("does not accept toolpacks");
  });

  it("requires a private lease gateway and unique non-reserved secret destinations", () => {
    expect(validatePreparedLease(preparedLease()).lease_id).toBe(LEASE_ID);
    expect(() => validatePreparedLease(preparedLease({
      gateway_url: "https://api.connectgalactic.com/v1" as never,
    }))).toThrow("private");
    expect(() => validatePreparedLease(preparedLease({
      secrets: [{
        binding_id: "secret-1",
        version: 1,
        destination: { kind: "env", name: "GALACTIC_API_KEY" },
        value: "forbidden",
      }],
    }))).toThrow("reserved");
  });
});

describe("compute executor lifecycle", () => {
  it("reserves before even resolving Sandbox, completes, and destroys first", async () => {
    const harness = makeHarness();
    const receipt = await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(receipt?.status).toBe("succeeded");
    expect(harness.events.indexOf("control:prepare-lease")).toBeLessThan(
      harness.events.indexOf("sandbox:resolve"),
    );
    expect(harness.events.indexOf("sandbox:resolve")).toBeLessThan(
      harness.events.indexOf("sandbox:create"),
    );
    expect(harness.events.indexOf("write:/run/galactic/job-token")).toBeGreaterThan(
      harness.events.indexOf("control:prepare-lease"),
    );
    expect(harness.events.indexOf("sandbox:delete-session")).toBeLessThan(
      harness.events.indexOf("sandbox:destroy"),
    );
    expect(harness.events.indexOf("sandbox:destroy")).toBeLessThan(
      harness.events.indexOf("control:complete"),
    );
    expect(harness.events.indexOf("checkpoint:put")).toBeLessThan(
      harness.events.indexOf("control:complete"),
    );
    expect(harness.events.indexOf("checkpoint:delete")).toBeGreaterThan(
      harness.events.indexOf("control:complete"),
    );
    const prepare = harness.requests.find((request) => request.operation === "prepare-lease");
    expect(prepare?.body).toEqual({ container_id: CONTAINER_ID });
    const complete = harness.requests.find((request) => request.operation === "complete");
    expect(complete?.body).toMatchObject({
      lease_id: LEASE_ID,
      exit_code: 0,
      stdout: "hello",
      outputs: [],
    });
  });

  it("cancellation during startup waits for unwind and performs a final destroy", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const abort = new AbortController();
    const harness = makeHarness({ beforeCreate: () => createGate });
    const execution = executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      { ...harness.dependencies, externalAbortSignal: abort.signal },
    );
    await vi.waitFor(() => {
      expect(harness.events).toContain("sandbox:create");
    });
    abort.abort("owner cancelled");
    releaseCreate();
    const receipt = await execution;
    expect(receipt?.status).toBe("failed");
    const failIndex = harness.events.lastIndexOf("control:fail");
    expect(failIndex).toBeGreaterThan(-1);
    expect(harness.events.slice(0, failIndex)).toContain("sandbox:destroy");
    expect(
      harness.requests.find((request) => request.operation === "fail")?.body,
    ).toMatchObject({ code: "cancelled" });
  });

  it("freshly destroys after a late Sandbox write revives an interrupted body", async () => {
    const secretPath = "/run/galactic/secrets/provider-key";
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const abort = new AbortController();
    const harness = makeHarness({
      lease: {
        secrets: [{
          binding_id: "secret-1",
          version: 1,
          destination: { kind: "file", path: "provider-key" },
          value: DEVELOPER_SECRET,
        }],
      },
      session: {
        beforeWriteCompletes: async (path) => {
          if (path !== secretPath) return;
          markWriteStarted();
          await writeGate;
        },
      },
    });
    const execution = executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      { ...harness.dependencies, externalAbortSignal: abort.signal },
    );
    await writeStarted;
    abort.abort("owner cancelled");
    await vi.waitFor(() => {
      expect(harness.events).toContain("sandbox:destroy");
    });
    releaseWrite();

    const receipt = await execution;
    expect(receipt?.status).toBe("failed");
    const lastWrite = harness.events.indexOf(`write-complete:${secretPath}`);
    const destroys = harness.events.flatMap((event, index) =>
      event === "sandbox:destroy" ? [index] : []
    );
    expect(destroys.length).toBeGreaterThanOrEqual(2);
    expect(destroys.at(-1)).toBeGreaterThan(lastWrite);
    expect(destroys.at(-1)).toBeLessThan(
      harness.events.indexOf("control:fail"),
    );
  });

  it("rejects a prepared lease that widens the claimed reservation", async () => {
    const harness = makeHarness({
      run: { lease_expires_at: "2098-01-01T00:00:00.000Z" },
      lease: { expires_at: "2099-01-01T00:00:00.000Z" },
    });
    const receipt = await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(receipt?.status).toBe("failed");
    expect(harness.events).not.toContain("sandbox:resolve");
  });

  it("never resolves a body or checkpoints a lease-less prepare failure", async () => {
    const harness = makeHarness({ operationFailures: { "prepare-lease": 1 } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(executeComputeRun(
        harness.env,
        { version: 1, run_id: RUN_ID },
        harness.dependencies,
      )).rejects.toThrow("control plane prepare-lease failed (503)");
    } finally {
      log.mockRestore();
    }
    expect(harness.events).not.toContain("sandbox:resolve");
    expect(harness.events).not.toContain("sandbox:destroy");
    expect(harness.requests.map((request) => request.operation)).toEqual([
      "claim",
      "prepare-lease",
    ]);
    expect(harness.bucketObjects.size).toBe(0);
  });

  it("recovers a committed prepare whose response was lost without replaying a lease-less failure", async () => {
    const bucketObjects = new Map<string, string>();
    const first = makeHarness({
      bucketObjects,
      operationTransportFailures: { "prepare-lease": 1 },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(executeComputeRun(
        first.env,
        { version: 1, run_id: RUN_ID },
        first.dependencies,
      )).rejects.toThrow(
        "control plane prepare-lease response was not observed",
      );
    } finally {
      log.mockRestore();
    }
    expect(first.requests.map((request) => request.operation)).toEqual([
      "claim",
      "prepare-lease",
    ]);
    expect(bucketObjects.size).toBe(0);
    expect(first.events).not.toContain("sandbox:resolve");

    const redelivery = makeHarness({
      bucketObjects,
      claim: {
        claimed: true,
        recovered: true,
        run: claimedRun({ started_at: new Date(500).toISOString() }),
      },
    });
    const receipt = await executeComputeRun(
      redelivery.env,
      { version: 1, run_id: RUN_ID },
      redelivery.dependencies,
    );
    expect(receipt?.status).toBe("succeeded");
    expect(redelivery.events.indexOf("sandbox:destroy")).toBeLessThan(
      redelivery.events.indexOf("control:prepare-lease"),
    );
  });

  it("acks duplicate delivery without resolving or destroying the active body", async () => {
    const harness = makeHarness({
      claim: { claimed: false, reason: "already_claimed" },
    });
    const receipt = await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(receipt).toBeNull();
    expect(harness.requests.map((request) => request.operation)).toEqual(["claim"]);
    expect(harness.events).not.toContain("sandbox:resolve");
  });

  it("destroys a recovered live body before rotating lease material", async () => {
    const harness = makeHarness({
      claim: {
        claimed: true,
        recovered: true,
        run: claimedRun({ started_at: new Date(500).toISOString() }),
      },
    });
    const receipt = await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(receipt?.status).toBe("succeeded");
    const firstResolve = harness.events.indexOf("sandbox:resolve");
    const firstDestroy = harness.events.indexOf("sandbox:destroy");
    expect(firstResolve).toBeGreaterThan(-1);
    expect(firstDestroy).toBeGreaterThan(firstResolve);
    expect(firstDestroy).toBeLessThan(
      harness.events.indexOf("control:prepare-lease"),
    );
    expect(harness.events.indexOf("control:prepare-lease")).toBeLessThan(
      harness.events.indexOf("sandbox:create"),
    );
    const completion = harness.requests.find((request) =>
      request.operation === "complete"
    );
    expect(completion?.body).toMatchObject({
      metrics: { started_at: new Date(500).toISOString(), wall_ms: 500 },
    });
  });

  it("retries a run deferred by the Agent concurrency ceiling", async () => {
    const harness = makeHarness({
      claim: { claimed: false, reason: "busy" },
    });
    await expect(executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    )).rejects.toBeInstanceOf(ComputeRunBusyError);
    expect(harness.requests.map((request) => request.operation)).toEqual(["claim"]);
    expect(harness.events).not.toContain("sandbox:resolve");
  });

  it("finalizes image startup failures and still destroys the body", async () => {
    const harness = makeHarness({ failCreate: true });
    const receipt = await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(receipt?.status).toBe("failed");
    const failure = harness.requests.find((request) => request.operation === "fail");
    expect(failure?.body).toMatchObject({ code: "image_unavailable" });
    expect(harness.events.indexOf("sandbox:destroy")).toBeLessThan(
      harness.events.indexOf("control:fail"),
    );
  });

  it("rejects input staging when live workspace space cannot retain scratch headroom", async () => {
    const harness = makeHarness({
      run: {
        input_artifacts: [{
          artifact_id: "00000000-0000-4000-8000-000000000099",
          object_key: "compute/input.bin",
          path: "input.bin",
          sha256: "a".repeat(64),
          size_bytes: 1024 * 1024,
        }],
      },
      session: { workspaceAvailableKiB: 512 * 1024 },
    });
    const receipt = await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(receipt?.status).toBe("failed");
    expect(harness.events).not.toContain("r2:get");
    const failure = harness.requests.find((request) => request.operation === "fail");
    expect(failure?.body).toMatchObject({
      code: "artifact_error",
      message: "workspace does not have enough free space for declared input artifacts",
    });
    expect(harness.events.indexOf("sandbox:destroy")).toBeLessThan(
      harness.events.indexOf("control:fail"),
    );
  });

  it("retries terminal completion without falling through to fail", async () => {
    const harness = makeHarness({ operationFailures: { complete: 2 } });
    const receipt = await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(receipt?.status).toBe("succeeded");
    expect(operations(harness.requests, "complete")).toBe(3);
    expect(operations(harness.requests, "fail")).toBe(0);
    expect(harness.delays).toEqual([250, 500]);
  });

  it("never changes an uncertain exhausted completion into failure", async () => {
    const harness = makeHarness({ operationFailures: { complete: 3 } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(executeComputeRun(
        harness.env,
        { version: 1, run_id: RUN_ID },
        harness.dependencies,
      )).rejects.toThrow("control plane complete failed (503)");
    } finally {
      log.mockRestore();
    }
    expect(operations(harness.requests, "complete")).toBe(3);
    expect(operations(harness.requests, "fail")).toBe(0);
    expect(operations(harness.requests, "complete")).toBe(3);
  });

  it("durably replays an uncertain completion before claim on redelivery", async () => {
    const bucketObjects = new Map<string, string>();
    const first = makeHarness({
      bucketObjects,
      operationFailures: { complete: 3 },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(executeComputeRun(
        first.env,
        { version: 1, run_id: RUN_ID },
        first.dependencies,
      )).rejects.toThrow("control plane complete failed (503)");
    } finally {
      log.mockRestore();
    }
    expect(bucketObjects.size).toBe(1);

    const redelivery = makeHarness({
      bucketObjects,
      claim: { claimed: false, reason: "already_claimed" },
    });
    const receipt = await executeComputeRun(
      redelivery.env,
      { version: 1, run_id: RUN_ID },
      redelivery.dependencies,
    );
    expect(receipt?.status).toBe("succeeded");
    expect(redelivery.requests.map((request) => request.operation)).toEqual([
      "complete",
    ]);
    expect(redelivery.events).not.toContain("sandbox:resolve");
    expect(bucketObjects.size).toBe(0);
  });

  it("retries failure finalization", async () => {
    const harness = makeHarness({
      failCreate: true,
      operationFailures: { fail: 2 },
    });
    const receipt = await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(receipt?.status).toBe("failed");
    expect(operations(harness.requests, "fail")).toBe(3);
    expect(harness.delays).toEqual([250, 500]);
  });

  it("durably replays an uncertain failure before claim on redelivery", async () => {
    const bucketObjects = new Map<string, string>();
    const first = makeHarness({
      bucketObjects,
      failCreate: true,
      operationFailures: { fail: 3 },
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(executeComputeRun(
        first.env,
        { version: 1, run_id: RUN_ID },
        first.dependencies,
      )).rejects.toThrow("control plane fail failed (503)");
    } finally {
      log.mockRestore();
    }
    expect(bucketObjects.size).toBe(1);

    const redelivery = makeHarness({
      bucketObjects,
      claim: { claimed: false, reason: "already_claimed" },
    });
    const receipt = await executeComputeRun(
      redelivery.env,
      { version: 1, run_id: RUN_ID },
      redelivery.dependencies,
    );
    expect(receipt?.status).toBe("failed");
    expect(redelivery.requests.map((request) => request.operation)).toEqual([
      "fail",
    ]);
    expect(redelivery.events).not.toContain("sandbox:resolve");
    expect(bucketObjects.size).toBe(0);
  });

  it("destroys the whole body when heartbeat observes cancellation", async () => {
    const harness = makeHarness({
      session: { waitForAbort: true },
      heartbeat: { cancelled: true, expires_at: "2099-01-01T00:00:00.000Z" },
    });
    harness.env.HEARTBEAT_INTERVAL_MS = "1";
    const receipt = await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(receipt?.status).toBe("failed");
    const failure = harness.requests.find((request) => request.operation === "fail");
    expect(failure?.body).toMatchObject({ code: "cancelled" });
    expect(harness.events.indexOf("sandbox:destroy")).toBeLessThan(
      harness.events.indexOf("control:fail"),
    );
  });

  it("destroys the whole body when the execution deadline fires", async () => {
    vi.useFakeTimers();
    let markUserExecStarted!: () => void;
    const userExecStarted = new Promise<void>((resolve) => {
      markUserExecStarted = resolve;
    });
    const harness = makeHarness({
      run: { timeout_ms: 1_000 },
      session: { waitForAbort: true, onUserExec: markUserExecStarted },
    });
    const execution = executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    try {
      await userExecStarted;
      await vi.advanceTimersByTimeAsync(1_001);
      const receipt = await execution;
      expect(receipt?.status).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
    const failure = harness.requests.find((request) => request.operation === "fail");
    expect(failure?.body).toMatchObject({ code: "deadline_exceeded" });
    expect(harness.events.indexOf("sandbox:destroy")).toBeLessThan(
      harness.events.indexOf("control:fail"),
    );
  });

  it("redacts lease credentials from success output and failure messages", async () => {
    const success = makeHarness({
      session: {
        stdout: `${JOB_TOKEN} ${DEVELOPER_SECRET}`,
        stderr: DEVELOPER_SECRET,
      },
    });
    await executeComputeRun(
      success.env,
      { version: 1, run_id: RUN_ID },
      success.dependencies,
    );
    const completion = success.requests.find((request) => request.operation === "complete");
    expect(JSON.stringify(completion?.body)).not.toContain(JOB_TOKEN);
    expect(JSON.stringify(completion?.body)).not.toContain(DEVELOPER_SECRET);
    expect(JSON.stringify(completion?.body)).toContain("[REDACTED]");

    const failure = makeHarness({
      session: {
        writeError: {
          path: "/run/galactic/job-token",
          message: `could not write ${JOB_TOKEN} with ${DEVELOPER_SECRET}`,
        },
      },
    });
    await executeComputeRun(
      failure.env,
      { version: 1, run_id: RUN_ID },
      failure.dependencies,
    );
    const failed = failure.requests.find((request) => request.operation === "fail");
    expect(JSON.stringify(failed?.body)).not.toContain(JOB_TOKEN);
    expect(JSON.stringify(failed?.body)).not.toContain(DEVELOPER_SECRET);
    expect(JSON.stringify(failed?.body)).toContain("[REDACTED]");
  });

  it("retains bounded output and records original byte counts", async () => {
    const harness = makeHarness({
      session: { stdout: "abcd", stdoutBytes: 10 },
    });
    harness.env.MAX_OUTPUT_BYTES = "4";
    await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    const completion = harness.requests.find((request) => request.operation === "complete");
    expect(completion?.body).toMatchObject({
      stdout: "abcd",
      metrics: { stdout_bytes: 10, stdout_truncated: true },
    });
  });

  it("does not capture workspace links or special files", async () => {
    const harness = makeHarness({
      run: { capture_paths: ["reports/latest"] },
      session: { captureKind: "unsafe" },
    });
    await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(harness.puts).toHaveLength(0);
    const completion = harness.requests.find((request) => request.operation === "complete");
    expect(JSON.stringify(completion?.body)).toContain("contains a link");
  });

  it("asks R2 to verify the frozen output digest", async () => {
    const harness = makeHarness({
      run: { capture_paths: ["reports/result.bin"] },
      session: { captureKind: "file", captureSize: 2 },
    });
    await executeComputeRun(
      harness.env,
      { version: 1, run_id: RUN_ID },
      harness.dependencies,
    );
    expect(harness.puts).toHaveLength(1);
    expect(harness.puts[0]?.options?.sha256).toBe("a".repeat(64));
    expect(harness.events.indexOf("control:reserve-output")).toBeLessThan(
      harness.events.indexOf("r2:put"),
    );
    expect(harness.events.indexOf("r2:put")).toBeLessThan(
      harness.events.indexOf("control:commit-output"),
    );
  });
});

describe("destruction and artifact stream caps", () => {
  it("retries whole-body destruction for explicit cancellation", async () => {
    const harness = makeHarness({ destroyFailures: 2 });
    await cancelComputeSandbox(harness.env, RUN_ID, {
      sandboxForRun: () => harness.sandbox,
    });
    expect(harness.events.filter((event) => event === "sandbox:destroy")).toHaveLength(3);
  });

  it("rejects an artifact stream that grows after measurement", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    const bounded = boundedArtifactStream(source, 2, 2);
    await expect(new Response(bounded).arrayBuffer()).rejects.toThrow(
      "artifact changed",
    );
  });
});
