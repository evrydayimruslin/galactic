import { getSandbox } from "@cloudflare/sandbox";
import type {
  ClaimedComputeRun,
  CompleteComputeRunRequest,
  ComputeDispatchMessage,
  ComputeExecutionMetrics,
  ComputeExecutionSession,
  ComputeOutputArtifact,
  ComputeRunReceipt,
  ComputeSandboxStub,
  ComputeSecretBinding,
  Env,
  FailComputeRunRequest,
  PreparedComputeLease,
} from "./contracts";
import { COMPUTE_MESSAGE_VERSION } from "./contracts";
import {
  COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS,
  COMPUTE_V1_MAX_ARTIFACT_BYTES,
} from "../../shared/contracts/compute";
import {
  ControlPlaneClient,
} from "./control-plane";
import { ComputeRunBusyError } from "./errors";
import {
  BoundedText,
  artifactObjectKey,
  assertOpaqueId,
  assertSecretEnvName,
  assertSha256,
  assertUuid,
  parentDirectory,
  secretPath,
  shellQuote,
  workspacePath,
} from "./security";

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES_CEILING = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_CAPTURE_BYTES = 250 * 1024 * 1024;
const MAX_ARGV = 128;
const MAX_ARG_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_WORKSPACE_PATHS = 100;
const MAX_INPUT_ARTIFACT_BYTES = COMPUTE_V1_MAX_ARTIFACT_BYTES;
const MAX_TOTAL_INPUT_BYTES = COMPUTE_V1_MAX_ARTIFACT_BYTES;
const WORKSPACE_FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
const MAX_SECRET_BINDINGS = 50;
const MAX_SECRET_VALUE_BYTES = 1024 * 1024;
const MAX_TOTAL_SECRET_BYTES = 4 * 1024 * 1024;
const MAX_RUN_TIMEOUT_MS = COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS;
const TEARDOWN_ALLOWANCE_MS = 15_000;
const MAX_RESERVED_WALL_MS = MAX_RUN_TIMEOUT_MS + 195_000 +
  TEARDOWN_ALLOWANCE_MS;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DESTROY_TIMEOUT_MS = 15_000;
const DELETE_SESSION_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_FINALIZATION_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const FINALIZATION_CHECKPOINT_PREFIX =
  "_galactic-control/v1/compute-finalization/";

type ComputeFinalizationCheckpoint =
  | {
    version: 1;
    run_id: string;
    operation: "complete";
    body: CompleteComputeRunRequest;
  }
  | {
    version: 1;
    run_id: string;
    operation: "fail";
    body: FailComputeRunRequest;
  };

export interface ExecuteDependencies {
  sandboxForRun?: (env: Env, runId: string) => ComputeSandboxStub;
  now?: () => number;
  finalizationDelay?: (milliseconds: number) => Promise<void>;
  /** Set only by the per-run Durable Object cancellation coordinator. */
  externalAbortSignal?: AbortSignal;
}

export { ComputeRunBusyError } from "./errors";

interface CapturedText {
  value: string;
  bytes: number;
  truncated: boolean;
}

interface CaptureResult {
  outputs: ComputeOutputArtifact[];
  warnings: string[];
}

export function parseDispatchMessage(value: unknown): ComputeDispatchMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid compute dispatch");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "run_id" || keys[1] !== "version") {
    throw new Error("compute dispatch contains unsupported fields");
  }
  if (input.version !== COMPUTE_MESSAGE_VERSION || typeof input.run_id !== "string") {
    throw new Error("unsupported compute dispatch");
  }
  return { version: COMPUTE_MESSAGE_VERSION, run_id: assertUuid(input.run_id, "run id") };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertObjectKey(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertSize(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} is outside the supported range`);
  }
  return value as number;
}

/** Revalidate the private control-plane payload before it can reach Sandbox. */
export function validateClaimedRun(
  value: ClaimedComputeRun,
  expectedRunId: string,
): ClaimedComputeRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("claimed compute run is invalid");
  }
  const runId = assertUuid(value.run_id, "claimed run id");
  if (runId !== assertUuid(expectedRunId, "dispatch run id")) {
    throw new Error("claimed run does not match dispatch");
  }
  assertOpaqueId(value.account_id, "account id");
  assertOpaqueId(value.agent_id, "agent id");
  if (
    typeof value.function_name !== "string" || value.function_name.length < 1 ||
    value.function_name.length > 256 || /[\u0000-\u001f\u007f]/.test(value.function_name)
  ) throw new Error("function name is invalid");
  if (value.execution_id !== null) assertUuid(value.execution_id, "execution id");
  if (value.profile !== "developer-v1") throw new Error("compute profile is unsupported");
  if (!IMAGE_DIGEST_PATTERN.test(value.environment_digest)) {
    throw new Error("compute environment digest is invalid");
  }
  if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > MAX_ARGV) {
    throw new Error(`argv must contain 1-${MAX_ARGV} arguments`);
  }
  for (const [index, argument] of value.argv.entries()) {
    if (
      typeof argument !== "string" || argument.length < 1 || argument.length > 4096 ||
      argument.includes("\0")
    ) throw new Error(`argv[${index}] is invalid`);
  }
  if (byteLength(JSON.stringify(value.argv)) > MAX_ARG_BYTES) {
    throw new Error("argv is too large");
  }
  if (value.cwd !== ".") workspacePath(value.cwd);
  if (value.stdin !== null && typeof value.stdin !== "string") {
    throw new Error("stdin must be text or null");
  }
  if (value.stdin !== null && byteLength(value.stdin) > MAX_STDIN_BYTES) {
    throw new Error("stdin is too large");
  }
  if (
    !Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 1_000 ||
    value.timeout_ms > MAX_RUN_TIMEOUT_MS
  ) throw new Error("timeout is outside the developer-v1 range");
  if (
    !Number.isSafeInteger(value.max_artifacts) || value.max_artifacts < 1 ||
    value.max_artifacts > 1_000 ||
    !Number.isSafeInteger(value.max_artifact_bytes) ||
    value.max_artifact_bytes < 1 || value.max_artifact_bytes > MAX_INPUT_ARTIFACT_BYTES
  ) throw new Error("artifact policy snapshot is invalid");
  if (
    !Array.isArray(value.capture_paths) ||
    value.capture_paths.length > Math.min(MAX_WORKSPACE_PATHS, value.max_artifacts)
  ) {
    throw new Error("capture paths exceed the supported limit");
  }
  const capturePaths = new Set<string>();
  for (const path of value.capture_paths) {
    workspacePath(path);
    if (capturePaths.has(path)) throw new Error("capture paths must be unique");
    capturePaths.add(path);
  }
  if (
    !Array.isArray(value.input_artifacts) ||
    value.input_artifacts.length > Math.min(MAX_WORKSPACE_PATHS, value.max_artifacts)
  ) {
    throw new Error("input artifacts exceed the supported limit");
  }
  let totalInputBytes = 0;
  const inputIds = new Set<string>();
  const inputPaths = new Set<string>();
  for (const [index, input] of value.input_artifacts.entries()) {
    const label = `input artifact ${index}`;
    const artifactId = assertUuid(input.artifact_id, `${label} id`);
    assertObjectKey(input.object_key, `${label} object key`);
    workspacePath(input.path);
    assertSha256(input.sha256, `${label} hash`);
    const size = assertSize(input.size_bytes, MAX_INPUT_ARTIFACT_BYTES, `${label} size`);
    totalInputBytes += size;
    if (
      totalInputBytes > MAX_TOTAL_INPUT_BYTES ||
      totalInputBytes > value.max_artifact_bytes
    ) {
      throw new Error("input artifacts exceed the total size limit");
    }
    if (inputIds.has(artifactId) || inputPaths.has(input.path)) {
      throw new Error("input artifact IDs and paths must be unique");
    }
    inputIds.add(artifactId);
    inputPaths.add(input.path);
  }
  if (!Array.isArray(value.toolpacks) || value.toolpacks.length !== 0) {
    throw new Error("developer-v1 does not accept toolpacks");
  }
  if (
    typeof value.lease_expires_at !== "string" ||
    !Number.isFinite(Date.parse(value.lease_expires_at))
  ) throw new Error("claimed lease expiry is invalid");
  if (
    value.started_at !== null &&
    (typeof value.started_at !== "string" || !Number.isFinite(Date.parse(value.started_at)))
  ) throw new Error("claimed start time is invalid");
  return value;
}

/** Validate one-time lease material before creating the body. */
export function validatePreparedLease(value: PreparedComputeLease): PreparedComputeLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("prepared compute lease is invalid");
  }
  assertUuid(value.lease_id, "lease id");
  if (
    typeof value.job_token !== "string" || value.job_token.length < 1 ||
    value.job_token.length > 16_384 || /[\r\n\0]/.test(value.job_token)
  ) throw new Error("job token is invalid");
  if (
    typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at))
  ) throw new Error("lease expiry is invalid");
  if (
    !Number.isSafeInteger(value.reserved_wall_ms) || value.reserved_wall_ms < 1 ||
    value.reserved_wall_ms > MAX_RESERVED_WALL_MS
  ) throw new Error("reserved wall budget is invalid");
  if (value.gateway_url !== "https://galactic.internal/v1") {
    throw new Error("lease gateway must be private");
  }
  if (!Array.isArray(value.secrets) || value.secrets.length > MAX_SECRET_BINDINGS) {
    throw new Error("secret bindings exceed the supported limit");
  }
  let totalSecretBytes = 0;
  const destinations = new Set<string>();
  for (const [index, secret] of value.secrets.entries()) {
    assertOpaqueId(secret.binding_id, `secret binding ${index} id`);
    if (!Number.isSafeInteger(secret.version) || secret.version < 1) {
      throw new Error(`secret binding ${index} version is invalid`);
    }
    if (typeof secret.value !== "string") throw new Error(`secret binding ${index} is invalid`);
    const size = byteLength(secret.value);
    if (size > MAX_SECRET_VALUE_BYTES) throw new Error(`secret binding ${index} is too large`);
    totalSecretBytes += size;
    if (totalSecretBytes > MAX_TOTAL_SECRET_BYTES) throw new Error("secret bindings are too large");
    const destination = secret.destination.kind === "env"
      ? `env:${assertSecretEnvName(secret.destination.name)}`
      : `file:${secretPath(secret.destination.path)}`;
    if (destinations.has(destination)) throw new Error("secret destinations must be unique");
    destinations.add(destination);
  }
  return value;
}

export function sandboxIdForRun(runId: string): string {
  return `run-${assertUuid(runId, "run id")}`;
}

/**
 * Cloudflare's outbound ContainerProxy identifies a Sandbox with the backing
 * Durable Object id (`this.ctx.id.toString()`), not the human-readable name
 * passed to getSandbox(). Derive that same id before lease preparation so the
 * opaque job token is bound to the exact identity the private proxy will
 * attest later.
 */
export function sandboxContainerIdForRun(
  namespace: Pick<DurableObjectNamespace, "idFromName">,
  runId: string,
): string {
  return namespace.idFromName(sandboxIdForRun(runId)).toString();
}

function defaultSandboxForRun(env: Env, runId: string): ComputeSandboxStub {
  return getSandbox(env.COMPUTE_STANDARD as never, sandboxIdForRun(runId), {
    transport: "rpc",
    keepAlive: false,
    sleepAfter: "1m",
    enableDefaultSession: false,
    normalizeId: true,
    containerTimeouts: {
      instanceGetTimeoutMS: 45_000,
      portReadyTimeoutMS: 150_000,
      waitIntervalMS: 500,
    },
  }) as unknown as ComputeSandboxStub;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

async function verifyFileHash(
  session: ComputeExecutionSession,
  path: string,
  expected: string,
): Promise<void> {
  const result = await session.exec(
    `sha256sum -- ${shellQuote(path)} | cut -d ' ' -f 1`,
    { origin: "internal", timeout: 30_000 },
  );
  const actual = result.stdout.trim().toLowerCase();
  if (!result.success || actual !== assertSha256(expected, "artifact hash")) {
    throw new Error("artifact integrity verification failed");
  }
}

async function stageInputs(
  env: Env,
  session: ComputeExecutionSession,
  run: ClaimedComputeRun,
): Promise<void> {
  await session.mkdir("/workspace", { recursive: true });
  await session.mkdir("/tmp/galactic-inputs", { recursive: true });
  for (const input of run.input_artifacts) {
    const object = await env.COMPUTE_ARTIFACTS.get(input.object_key);
    if (!object) throw new Error("input artifact not found");
    if (object.size !== input.size_bytes) throw new Error("input artifact size mismatch");
    const destination = workspacePath(input.path);
    await session.mkdir(parentDirectory(destination), { recursive: true });
    await session.writeFile(destination, object.body);
    await verifyFileHash(session, destination, input.sha256);
  }
}

/**
 * Cloudflare Container disk is shared by the immutable image and writable
 * workspace. Policy byte limits alone cannot know the live free space left by
 * a particular image digest, so measure it before copying any R2 object and
 * retain scratch capacity for browsers, office conversions, package caches,
 * captures, and teardown metadata.
 */
async function requireWorkspaceCapacity(
  session: ComputeExecutionSession,
  run: ClaimedComputeRun,
): Promise<void> {
  const result = await session.exec(
    "df -Pk -- /workspace | awk 'END { print $4 }'",
    { origin: "internal", timeout: 10_000 },
  );
  const availableKiB = Number(result.stdout.trim());
  if (
    !result.success || !Number.isSafeInteger(availableKiB) || availableKiB < 0 ||
    availableKiB > Math.floor(Number.MAX_SAFE_INTEGER / 1024)
  ) {
    throw new Error("workspace free-space preflight failed");
  }
  const requiredBytes = run.input_artifacts.reduce(
    (total, artifact) => total + artifact.size_bytes,
    WORKSPACE_FREE_SPACE_RESERVE_BYTES,
  );
  if (availableKiB * 1024 < requiredBytes) {
    throw new Error(
      "workspace does not have enough free space for declared input artifacts",
    );
  }
}

async function installLeaseMaterial(
  session: ComputeExecutionSession,
  run: ClaimedComputeRun,
  lease: PreparedComputeLease,
): Promise<Record<string, string>> {
  await session.mkdir("/run/galactic/secrets", { recursive: true });
  await session.mkdir("/tmp/galactic-home/config", { recursive: true });
  await session.mkdir("/tmp/galactic-home/cache", { recursive: true });
  await session.writeFile("/run/galactic/job-token", lease.job_token);
  const chmodTargets = ["/run/galactic/job-token"];
  const env: Record<string, string> = {
    GALACTIC_GATEWAY_URL: lease.gateway_url,
    GALACTIC_JOB_TOKEN_FILE: "/run/galactic/job-token",
    GALACTIC_RUN_ID: run.run_id,
    GALACTIC_LEASE_ID: lease.lease_id,
    HOME: "/tmp/galactic-home",
    TMPDIR: "/tmp",
    XDG_CONFIG_HOME: "/tmp/galactic-home/config",
    XDG_CACHE_HOME: "/tmp/galactic-home/cache",
    PATH: [
      "/opt/galactic/bin",
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ].join(":"),
  };
  const writes: Promise<unknown>[] = [];
  for (const secret of lease.secrets) {
    const write = installSecretBinding(env, chmodTargets, secret, session);
    if (write) writes.push(write);
  }
  await Promise.all(writes);
  const chmod = await session.exec(
    `chmod 0600 -- ${chmodTargets.map(shellQuote).join(" ")}`,
    { origin: "internal", timeout: 10_000 },
  );
  if (!chmod.success) throw new Error("secret permission setup failed");
  return env;
}

function installSecretBinding(
  env: Record<string, string>,
  chmodTargets: string[],
  secret: ComputeSecretBinding,
  session: ComputeExecutionSession,
): Promise<unknown> | undefined {
  if (secret.destination.kind === "env") {
    env[assertSecretEnvName(secret.destination.name)] = secret.value;
    return undefined;
  }
  const path = secretPath(secret.destination.path);
  chmodTargets.push(path);
  return session.mkdir(parentDirectory(path), { recursive: true })
    .then(() => session.writeFile(path, secret.value));
}

// Drain both pipes for the full lifetime of the command while retaining only
// the configured prefix. `head` is not sufficient here: closing its pipe at
// the limit would SIGPIPE the user's process and change command semantics.
const BOUNDED_COMMAND_RUNNER = `
import json, os, selectors, signal, subprocess, sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    spec = json.load(handle)

limit = int(spec["output_limit"])
stdin_handle = open(spec["stdin_path"], "rb") if spec["stdin_path"] else subprocess.DEVNULL
process = None

def terminate_group(signum, _frame):
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, terminate_group)
signal.signal(signal.SIGINT, terminate_group)

try:
    process = subprocess.Popen(
        spec["argv"],
        stdin=stdin_handle,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        close_fds=True,
    )
    selector = selectors.DefaultSelector()
    outputs = {}
    counts = {process.stdout: 0, process.stderr: 0}
    stored = {process.stdout: 0, process.stderr: 0}
    for stream, path in (
        (process.stdout, spec["stdout_path"]),
        (process.stderr, spec["stderr_path"]),
    ):
        outputs[stream] = open(path, "wb")
        selector.register(stream, selectors.EVENT_READ)

    while selector.get_map():
        for key, _events in selector.select(timeout=1):
            stream = key.fileobj
            chunk = os.read(stream.fileno(), 65536)
            if not chunk:
                selector.unregister(stream)
                outputs[stream].close()
                continue
            counts[stream] += len(chunk)
            remaining = max(0, limit - stored[stream])
            if remaining:
                kept = chunk[:remaining]
                outputs[stream].write(kept)
                stored[stream] += len(kept)

    exit_code = process.wait()
    if exit_code < 0:
        exit_code = min(255, 128 + abs(exit_code))
    with open(spec["exit_path"], "w", encoding="ascii") as handle:
        handle.write(str(exit_code))
    with open(spec["stdout_bytes_path"], "w", encoding="ascii") as handle:
        handle.write(str(counts[process.stdout]))
    with open(spec["stderr_bytes_path"], "w", encoding="ascii") as handle:
        handle.write(str(counts[process.stderr]))
finally:
    if stdin_handle is not subprocess.DEVNULL:
        stdin_handle.close()
`;

async function executeCommand(
  session: ComputeExecutionSession,
  run: ClaimedComputeRun,
  executionEnv: Record<string, string>,
  signal: AbortSignal,
  outputLimit: number,
): Promise<{ exitCode: number; stdout: CapturedText; stderr: CapturedText }> {
  const outputRoot = "/tmp/galactic-output";
  await session.mkdir(outputRoot, { recursive: true });
  if (run.stdin !== null) {
    await session.writeFile("/run/galactic/stdin", run.stdin);
  }
  const runnerPath = "/run/galactic/command-runner.py";
  const specPath = "/run/galactic/command.json";
  await session.writeFile(runnerPath, BOUNDED_COMMAND_RUNNER);
  await session.writeFile(specPath, JSON.stringify({
    argv: run.argv,
    stdin_path: run.stdin === null ? null : "/run/galactic/stdin",
    output_limit: outputLimit,
    stdout_path: `${outputRoot}/stdout`,
    stderr_path: `${outputRoot}/stderr`,
    stdout_bytes_path: `${outputRoot}/stdout-bytes`,
    stderr_bytes_path: `${outputRoot}/stderr-bytes`,
    exit_path: `${outputRoot}/exit-code`,
  }));
  const cwd = run.cwd === "." ? "/workspace" : workspacePath(run.cwd);
  await session.mkdir(cwd, { recursive: true });
  // Await the SDK operation itself, rather than racing it with a local abort
  // promise. The signal and SDK timeout still interrupt the process, but the
  // executor must not begin its authoritative final destroy while an in-flight
  // Sandbox call can still settle and auto-start the container again.
  const execution = await session.exec(
    `python3 ${shellQuote(runnerPath)} ${shellQuote(specPath)}`,
    {
      cwd,
      env: executionEnv,
      timeout: run.timeout_ms,
      signal,
      origin: "user",
    },
  );
  if (signal.aborted) {
    throw new Error(String(signal.reason ?? "compute execution aborted"));
  }
  if (!execution.success) throw new Error("bounded command runner failed");
  const exit = await session.readFile(`${outputRoot}/exit-code`, { encoding: "utf8" });
  const exitCode = Number(exit.content.trim());
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error("compute command did not produce a valid exit code");
  }
  const [stdout, stderr] = await Promise.all([
    readRunnerCapturedText(
      session,
      `${outputRoot}/stdout`,
      `${outputRoot}/stdout-bytes`,
      outputLimit,
      "stdout",
    ),
    readRunnerCapturedText(
      session,
      `${outputRoot}/stderr`,
      `${outputRoot}/stderr-bytes`,
      outputLimit,
      "stderr",
    ),
  ]);
  return { exitCode, stdout, stderr };
}

async function readRunnerCapturedText(
  session: ComputeExecutionSession,
  path: string,
  bytesPath: string,
  limit: number,
  label: string,
): Promise<CapturedText> {
  const [result, measured] = await Promise.all([
    session.readFile(path, { encoding: "utf8" }),
    session.readFile(bytesPath, { encoding: "utf8" }),
  ]);
  const bytes = Number(measured.content.trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`could not measure ${label}`);
  }
  const bounded = new BoundedText(limit);
  bounded.append(result.content);
  return {
    value: bounded.value,
    bytes,
    truncated: bytes > limit || bounded.truncated,
  };
}

/** Enforce the already-measured artifact size again while R2 consumes it. */
export function boundedArtifactStream(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  maximumBytes: number,
): ReadableStream<Uint8Array> {
  if (
    !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
    !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 ||
    expectedBytes > maximumBytes
  ) throw new Error("invalid artifact stream limit");
  let seen = 0;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expectedBytes || seen > maximumBytes) {
        controller.error(new Error("artifact changed while uploading"));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (seen !== expectedBytes) {
        controller.error(new Error("artifact changed while uploading"));
      }
    },
  }));
}

async function captureOutputs(
  env: Env,
  session: ComputeExecutionSession,
  run: ClaimedComputeRun,
  client: ControlPlaneClient,
  leaseId: string,
): Promise<CaptureResult> {
  const outputs: ComputeOutputArtifact[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  const perArtifactLimit = Math.min(MAX_CAPTURE_BYTES, run.max_artifact_bytes);
  const aggregateLimit = Math.min(MAX_TOTAL_CAPTURE_BYTES, run.max_artifact_bytes);
  for (const [index, relative] of run.capture_paths.entries()) {
    const source = workspacePath(relative);
    const kind = await session.exec(
      [
        `resolved=$(realpath -e -- ${shellQuote(source)} 2>/dev/null) || { printf missing; exit 0; }`,
        `case "$resolved" in /workspace|/workspace/*) ;; *) printf unsafe; exit 0 ;; esac`,
        `if test -L ${shellQuote(source)}; then printf unsafe`,
        `elif test -d ${shellQuote(source)}; then if find ${shellQuote(source)} -xdev ! -type f ! -type d -print -quit | grep -q .; then printf unsafe; else printf directory; fi`,
        `elif test -f ${shellQuote(source)}; then printf file`,
        "else printf unsafe; fi",
      ].join("; "),
      { origin: "internal", timeout: 10_000 },
    );
    const artifactKind = kind.stdout.trim();
    if (artifactKind === "missing") {
      warnings.push(`capture path not found: ${relative}`);
      continue;
    }
    if (artifactKind === "unsafe") {
      warnings.push(`capture path contains a link, special file, or escapes workspace: ${relative}`);
      continue;
    }
    if (!kind.success || (artifactKind !== "file" && artifactKind !== "directory")) {
      warnings.push(`capture path could not be inspected: ${relative}`);
      continue;
    }
    let uploadPath = `/tmp/galactic-output/capture-${index}.file`;
    let archive: ComputeOutputArtifact["archive"] = "none";
    let mediaType = mediaTypeFor(relative);
    if (artifactKind === "directory") {
      uploadPath = `/tmp/galactic-output/capture-${index}.tar.gz`;
      const fileBlocks = Math.ceil((perArtifactLimit + 1) / 512);
      const pack = await session.exec(
        `(ulimit -f ${fileBlocks}; exec tar --create --gzip --file ${shellQuote(uploadPath)} --directory /workspace -- ${shellQuote(relative)})`,
        { origin: "internal", timeout: 120_000 },
      );
      if (!pack.success) {
        warnings.push(`capture path could not be archived: ${relative}`);
        continue;
      }
      archive = "tar.gz";
      mediaType = "application/gzip";
    } else {
      const freeze = await session.exec(
        `head -c ${perArtifactLimit + 1} -- ${shellQuote(source)} > ${shellQuote(uploadPath)}`,
        { origin: "internal", timeout: 120_000 },
      );
      if (!freeze.success) {
        warnings.push(`capture path could not be frozen: ${relative}`);
        continue;
      }
    }
    const sizeResult = await session.exec(`stat -c %s -- ${shellQuote(uploadPath)}`, {
      origin: "internal",
      timeout: 10_000,
    });
    const size = Number(sizeResult.stdout.trim());
    if (!sizeResult.success || !Number.isInteger(size) || size < 0) {
      warnings.push(`capture path size unavailable: ${relative}`);
      continue;
    }
    if (size > perArtifactLimit || totalBytes + size > aggregateLimit) {
      warnings.push(`capture path exceeds artifact limit: ${relative}`);
      continue;
    }
    const hash = await session.exec(
      `sha256sum -- ${shellQuote(uploadPath)} | cut -d ' ' -f 1`,
      { origin: "internal", timeout: 30_000 },
    );
    const sha256 = hash.stdout.trim().toLowerCase();
    if (!hash.success) throw new Error("output artifact hashing failed");
    assertSha256(sha256, "output artifact hash");
    const artifactId = crypto.randomUUID();
    const objectKey = artifactObjectKey({
      accountId: run.account_id,
      agentId: run.agent_id,
      runId: run.run_id,
      artifactId,
      index,
      name: archive === "tar.gz" ? `${relative}.tar.gz` : relative,
    });
    const output: ComputeOutputArtifact = {
      artifact_id: artifactId,
      path: relative,
      object_key: objectKey,
      sha256,
      size_bytes: size,
      media_type: mediaType,
      archive,
    };
    const reserved = await client.reserveOutput(leaseId, output);
    if (
      reserved.state === "ready" && reserved.sha256 === sha256 &&
      reserved.size_bytes === size
    ) {
      outputs.push(output);
      totalBytes += size;
      continue;
    }
    if (reserved.state !== "pending") {
      throw new Error("output artifact reservation is not writable");
    }
    try {
      const stream = boundedArtifactStream(
        await session.readFileStream(uploadPath),
        size,
        perArtifactLimit,
      );
      await env.COMPUTE_ARTIFACTS.put(objectKey, stream, {
        httpMetadata: { contentType: mediaType },
        sha256,
        customMetadata: {
          run_id: run.run_id,
          agent_id: run.agent_id,
          sha256,
        },
      });
      const committed = await client.commitOutput(leaseId, output);
      if (
        committed.state !== "ready" || committed.sha256 !== sha256 ||
        committed.size_bytes !== size
      ) throw new Error("output artifact did not commit exactly");
    } catch (error) {
      // A commit response can be lost after SQL commits. Read authoritative
      // state before compensation; never delete an object referenced by ready
      // metadata.
      const current = await client.outputStatus(leaseId, artifactId)
        .catch(() => null);
      if (
        current?.state === "ready" && current.sha256 === sha256 &&
        current.size_bytes === size
      ) {
        outputs.push(output);
        totalBytes += size;
        continue;
      }
      if (current?.state === "pending") {
        const abandoned = await client.abandonOutput(leaseId, artifactId)
          .catch(() => null);
        if (abandoned?.state === "deleted") {
          await env.COMPUTE_ARTIFACTS.delete(objectKey).catch(() => undefined);
        } else if (
          abandoned?.state === "ready" && abandoned.sha256 === sha256 &&
          abandoned.size_bytes === size
        ) {
          outputs.push(output);
          totalBytes += size;
          continue;
        }
      } else if (current?.state === "deleted") {
        await env.COMPUTE_ARTIFACTS.delete(objectKey).catch(() => undefined);
      }
      throw error;
    }
    outputs.push(output);
    totalBytes += size;
  }
  return { outputs, warnings };
}

function mediaTypeFor(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1);
  return ({
    json: "application/json",
    csv: "text/csv",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    zip: "application/zip",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

async function heartbeatUntilStopped(
  client: ControlPlaneClient,
  leaseId: string,
  intervalMs: number,
  stop: AbortSignal,
  onTermination: (reason: string) => Promise<void>,
): Promise<void> {
  while (!stop.aborted) {
    const status = await client.heartbeat(leaseId);
    const expiresAt = Date.parse(status.expires_at);
    if (!Number.isFinite(expiresAt)) throw new Error("compute heartbeat returned invalid expiry");
    if (status.cancelled || expiresAt <= Date.now()) {
      await onTermination(status.cancelled ? "compute run cancelled" : "compute lease expired");
      return;
    }
    await abortableDelay(intervalMs, stop);
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedDeleteSession(
  sandbox: ComputeSandboxStub,
  sessionId: string,
): Promise<void> {
  await withTimeout(
    Promise.resolve(sandbox.deleteSession(sessionId)).then(() => undefined),
    DELETE_SESSION_TIMEOUT_MS,
    "compute session deletion timed out",
  );
}

async function boundedDestroy(sandbox: ComputeSandboxStub): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await withTimeout(
        sandbox.destroy(),
        Math.floor(DESTROY_TIMEOUT_MS / 3),
        "compute body destruction timed out",
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function retryFinalization<T>(
  operation: () => Promise<T>,
  delay: (milliseconds: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(250 * 2 ** attempt);
    }
  }
  throw lastError;
}

function finalizationCheckpointKey(runId: string): string {
  return `${FINALIZATION_CHECKPOINT_PREFIX}${assertUuid(runId, "run id")}.json`;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function validateFinalizationCheckpoint(
  value: unknown,
  expectedRunId: string,
): ComputeFinalizationCheckpoint {
  const checkpoint = objectRecord(value, "compute finalization checkpoint");
  const keys = Object.keys(checkpoint).sort();
  if (
    keys.length !== 4 || keys[0] !== "body" || keys[1] !== "operation" ||
    keys[2] !== "run_id" || keys[3] !== "version" || checkpoint.version !== 1 ||
    (checkpoint.operation !== "complete" && checkpoint.operation !== "fail") ||
    typeof checkpoint.run_id !== "string" ||
    assertUuid(checkpoint.run_id, "checkpoint run id") !==
      assertUuid(expectedRunId, "dispatch run id")
  ) {
    throw new Error("compute finalization checkpoint is invalid");
  }
  const body = objectRecord(checkpoint.body, "compute finalization body");
  if (checkpoint.operation === "complete") {
    if (typeof body.lease_id !== "string") {
      throw new Error("compute completion checkpoint is invalid");
    }
    assertUuid(body.lease_id, "checkpoint lease id");
    if (
      !Number.isSafeInteger(body.exit_code) || (body.exit_code as number) < 0 ||
      (body.exit_code as number) > 255 || typeof body.stdout !== "string" ||
      typeof body.stderr !== "string" || !Array.isArray(body.outputs)
    ) throw new Error("compute completion checkpoint is invalid");
    objectRecord(body.metrics, "compute completion metrics");
    return checkpoint as unknown as ComputeFinalizationCheckpoint;
  }
  if (body.lease_id !== undefined) {
    if (typeof body.lease_id !== "string") {
      throw new Error("compute failure checkpoint is invalid");
    }
    assertUuid(body.lease_id, "checkpoint lease id");
  }
  if (typeof body.code !== "string" || typeof body.message !== "string") {
    throw new Error("compute failure checkpoint is invalid");
  }
  if (body.metrics !== undefined) {
    objectRecord(body.metrics, "compute failure metrics");
  }
  return checkpoint as unknown as ComputeFinalizationCheckpoint;
}

async function boundedStreamText(
  stream: ReadableStream<Uint8Array>,
  declaredSize: number,
): Promise<string> {
  if (
    !Number.isSafeInteger(declaredSize) || declaredSize < 1 ||
    declaredSize > MAX_FINALIZATION_CHECKPOINT_BYTES
  ) throw new Error("compute finalization checkpoint size is invalid");
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > declaredSize || total > MAX_FINALIZATION_CHECKPOINT_BYTES) {
        await reader.cancel("checkpoint exceeds its declared size").catch(() => undefined);
        throw new Error("compute finalization checkpoint size mismatch");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (total !== declaredSize) {
    throw new Error("compute finalization checkpoint size mismatch");
  }
  return text;
}

async function loadFinalizationCheckpoint(
  env: Env,
  runId: string,
): Promise<ComputeFinalizationCheckpoint | null> {
  const object = await env.COMPUTE_ARTIFACTS.get(finalizationCheckpointKey(runId));
  if (!object) return null;
  const text = await boundedStreamText(object.body, object.size);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("compute finalization checkpoint is not valid JSON");
  }
  return validateFinalizationCheckpoint(value, runId);
}

async function saveFinalizationCheckpoint(
  env: Env,
  checkpoint: ComputeFinalizationCheckpoint,
): Promise<void> {
  const value = JSON.stringify(checkpoint);
  if (byteLength(value) > MAX_FINALIZATION_CHECKPOINT_BYTES) {
    throw new Error("compute finalization checkpoint exceeds the durable limit");
  }
  await env.COMPUTE_ARTIFACTS.put(
    finalizationCheckpointKey(checkpoint.run_id),
    value,
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        galactic_control_record: "compute-finalization-v1",
        run_id: checkpoint.run_id,
      },
    },
  );
}

async function replayFinalizationCheckpoint(
  env: Env,
  client: ControlPlaneClient,
  runId: string,
  delay: (milliseconds: number) => Promise<void>,
): Promise<ComputeRunReceipt | null> {
  const checkpoint = await loadFinalizationCheckpoint(env, runId);
  if (!checkpoint) return null;
  const receipt = await retryFinalization(
    () => checkpoint.operation === "complete"
      ? client.complete(checkpoint.body)
      : client.fail(checkpoint.body),
    delay,
  );
  // Treat deletion as part of the durable handoff. If it fails, Queue retries
  // and replays the now-idempotent terminal RPC instead of leaving an
  // unbounded private control record behind.
  await env.COMPUTE_ARTIFACTS.delete(finalizationCheckpointKey(runId));
  return receipt;
}

function leaseSecretValues(lease?: PreparedComputeLease): string[] {
  return lease
    ? [lease.job_token, ...lease.secrets.map((secret) => secret.value)]
      .filter((value) => value.length > 0)
      .sort((a, b) => b.length - a.length)
    : [];
}

export function redactLeaseSecrets(
  value: string,
  lease?: PreparedComputeLease,
): string {
  let redacted = value;
  for (const secret of leaseSecretValues(lease)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function redactCapturedText(
  captured: CapturedText,
  lease: PreparedComputeLease,
  limit: number,
): CapturedText {
  const bounded = new BoundedText(limit);
  bounded.append(redactLeaseSecrets(captured.value, lease));
  return {
    value: bounded.value,
    bytes: captured.bytes,
    truncated: captured.truncated || bounded.truncated,
  };
}

function safeFailureMessage(error: unknown, lease?: PreparedComputeLease): string {
  const raw = error instanceof Error ? error.message : "unknown compute failure";
  const bounded = new BoundedText(500);
  bounded.append(redactLeaseSecrets(raw, lease));
  return bounded.value;
}

export async function executeComputeRun(
  env: Env,
  dispatchInput: unknown,
  dependencies: ExecuteDependencies = {},
): Promise<ComputeRunReceipt | null> {
  const dispatch = parseDispatchMessage(dispatchInput);
  const client = new ControlPlaneClient(env.CONTROL_PLANE, dispatch.run_id);
  const finalizationDelay = dependencies.finalizationDelay ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  // A terminal request is durably checkpointed before its first control-plane
  // call. Replay it before claim so a lost finalization response can never be
  // mistaken for an active duplicate and ACKed with its result discarded.
  const recoveredReceipt = await replayFinalizationCheckpoint(
    env,
    client,
    dispatch.run_id,
    finalizationDelay,
  );
  if (recoveredReceipt) return recoveredReceipt;
  const claim = await client.claim();
  if (!claim.claimed) {
    // `already_claimed` is an idempotent duplicate. `busy` is categorically
    // different: acking it would strand an admitted run forever, so surface a
    // retryable delivery error to the queue consumer.
    if (claim.reason === "busy") throw new ComputeRunBusyError();
    return null;
  }

  const now = dependencies.now ?? Date.now;
  const run = claim.run;
  // Reserve the entire bounded lease and mint its container-bound token before
  // even resolving the Sandbox stub. getSandbox/DO access is therefore never
  // the operation that discovers an unfunded or cancelled run.
  let startedAtMs = now();
  let sandbox: ComputeSandboxStub | undefined;
  let session: ComputeExecutionSession | undefined;
  let lease: PreparedComputeLease | undefined;
  let finalized = false;
  let terminalFinalizationStarted = false;
  let leasePreparationInFlight = false;
  let phase: "reservation" | "image" | "artifacts" | "secrets" | "execution" =
    "reservation";
  const heartbeatStop = new AbortController();
  const execution = new AbortController();
  let heartbeat: Promise<void> | undefined;
  let heartbeatError: unknown;
  let bodyDestroyError: unknown;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let leaseExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  let reservationTimer: ReturnType<typeof setTimeout> | undefined;
  let interruptDestroyPromise: Promise<void> | undefined;
  let finalCleanupPromise: Promise<void> | undefined;
  const interruptBody = (): Promise<void> => {
    // Once final cleanup is registered, it owns the authority boundary. Do not
    // start a concurrent early destroy (and do not await final cleanup from a
    // heartbeat that final cleanup itself is awaiting).
    if (finalCleanupPromise) return Promise.resolve();
    if (!sandbox) return Promise.resolve();
    interruptDestroyPromise ??= (async () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (leaseExpiryTimer !== undefined) clearTimeout(leaseExpiryTimer);
      if (reservationTimer !== undefined) clearTimeout(reservationTimer);
      if (session) {
        await boundedDeleteSession(sandbox, session.id).catch(() => undefined);
      }
      await boundedDestroy(sandbox);
    })();
    return interruptDestroyPromise;
  };
  const cleanupBody = (): Promise<void> => {
    finalCleanupPromise ??= (async () => {
      // No later coordinator abort may start another early destroy while this
      // serialized final revocation is in progress.
      externalAbort?.removeEventListener("abort", abortFromCoordinator);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (leaseExpiryTimer !== undefined) clearTimeout(leaseExpiryTimer);
      if (reservationTimer !== undefined) clearTimeout(reservationTimer);
      heartbeatStop.abort();
      if (heartbeat) await heartbeat.catch(() => undefined);
      await interruptDestroyPromise?.catch(() => undefined);
      if (!sandbox) return;
      if (session) {
        await boundedDeleteSession(sandbox, session.id).catch(() => undefined);
      }
      // Always issue a FRESH whole-body destroy after every sequential SDK call
      // and heartbeat has unwound. An earlier interrupt can race a late
      // write/exec that auto-starts Sandbox; reusing its resolved promise would
      // falsely settle while a revived body still holds lease material.
      await boundedDestroy(sandbox);
    })();
    return finalCleanupPromise;
  };
  const externalAbort = dependencies.externalAbortSignal;
  const abortFromCoordinator = () => {
    execution.abort("compute run cancelled by control plane");
    void interruptBody().catch((error) => {
      bodyDestroyError = error;
    });
  };
  if (externalAbort?.aborted) abortFromCoordinator();
  else externalAbort?.addEventListener("abort", abortFromCoordinator, { once: true });

  try {
    validateClaimedRun(run, dispatch.run_id);
    if (claim.recovered && run.started_at !== null) {
      startedAtMs = Date.parse(run.started_at);
    }
    if (run.environment_digest !== env.COMPUTE_ENVIRONMENT_DIGEST) {
      throw new Error("compute environment identity mismatch");
    }
    if (claim.recovered) {
      // The prior invocation may have committed lease material before losing
      // its response. Revoke the exact deterministic body before asking the
      // control plane to rotate the one-time token or rematerialize secrets.
      phase = "image";
      sandbox = (dependencies.sandboxForRun ?? defaultSandboxForRun)(
        env,
        dispatch.run_id,
      );
      await boundedDestroy(sandbox);
      phase = "reservation";
    }
    leasePreparationInFlight = true;
    lease = validatePreparedLease(
      await client.prepareLease(
        sandboxContainerIdForRun(env.COMPUTE_STANDARD, dispatch.run_id),
      ),
    );
    leasePreparationInFlight = false;
    if (Date.parse(lease.expires_at) <= now()) {
      throw new Error("prepared compute lease is already expired");
    }
    if (Date.parse(lease.expires_at) > Date.parse(run.lease_expires_at)) {
      throw new Error("prepared compute lease exceeds the claimed reservation");
    }
    // The SQL lease expiry can be shorter than the generic reservation for a
    // synchronous call because it is fenced to the parent Dynamic Worker
    // deadline. Enforce that absolute fence immediately, including while the
    // Container is still starting; the periodic heartbeat is only a backstop.
    leaseExpiryTimer = setTimeout(() => {
      execution.abort("compute lease expired");
      void interruptBody().catch((error) => {
        bodyDestroyError = error;
      });
    }, Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(1, Date.parse(lease.expires_at) - now()),
    ));
    const reservationRemainingMs = lease.reserved_wall_ms -
      TEARDOWN_ALLOWANCE_MS -
      Math.max(0, now() - startedAtMs);
    if (reservationRemainingMs <= 0) {
      execution.abort("compute reservation deadline exceeded");
      throw new Error("compute reservation expired before body startup");
    }
    reservationTimer = setTimeout(() => {
      execution.abort("compute reservation deadline exceeded");
      void interruptBody().catch((error) => {
        bodyDestroyError = error;
      });
    }, reservationRemainingMs);
    heartbeat = heartbeatUntilStopped(
      client,
      lease.lease_id,
      positiveInteger(
        env.HEARTBEAT_INTERVAL_MS,
        DEFAULT_HEARTBEAT_INTERVAL_MS,
        60_000,
      ),
      heartbeatStop.signal,
      async (reason) => {
        execution.abort(reason);
        try {
          await interruptBody();
        } catch (error) {
          bodyDestroyError = error;
        }
      },
    ).catch(async (error) => {
      heartbeatError = error;
      execution.abort("compute heartbeat failed");
      try {
        await interruptBody();
      } catch (destroyError) {
        bodyDestroyError = destroyError;
      }
    });
    if (execution.signal.aborted) {
      throw new Error(String(execution.signal.reason));
    }
    phase = "image";
    sandbox ??= (dependencies.sandboxForRun ?? defaultSandboxForRun)(
      env,
      dispatch.run_id,
    );
    if (execution.signal.aborted) {
      await interruptBody();
      throw new Error(String(execution.signal.reason));
    }
    session = await sandbox.createSession({
      id: `lease-${dispatch.run_id}`,
      name: "galactic-compute-v1",
      cwd: "/workspace",
      isolation: true,
      commandTimeoutMs: run.timeout_ms,
    });
    if (execution.signal.aborted) {
      throw new Error(String(execution.signal.reason));
    }
    phase = "artifacts";
    await requireWorkspaceCapacity(session, run);
    await stageInputs(env, session, run);
    if (execution.signal.aborted) {
      throw new Error(String(execution.signal.reason));
    }
    phase = "secrets";
    const executionEnv = await installLeaseMaterial(session, run, lease);
    if (execution.signal.aborted) {
      throw new Error(String(execution.signal.reason));
    }
    phase = "execution";
    const remainingLeaseMs = Date.parse(lease.expires_at) - now();
    if (remainingLeaseMs <= 0) {
      execution.abort("compute lease expired");
      throw new Error("compute lease expired before execution");
    }
    const deadlineMs = Math.max(1, Math.min(run.timeout_ms, remainingLeaseMs));
    const deadlineReason = remainingLeaseMs <= run.timeout_ms
      ? "compute lease expired"
      : "compute deadline exceeded";
    deadlineTimer = setTimeout(
      () => {
        execution.abort(deadlineReason);
        void interruptBody().catch((error) => {
          bodyDestroyError = error;
        });
      },
      deadlineMs,
    );
    const outputLimit = positiveInteger(
      env.MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES_CEILING,
    );
    const command = await executeCommand(
      session,
      run,
      executionEnv,
      execution.signal,
      outputLimit,
    );
    if (heartbeatError) throw heartbeatError;
    if (bodyDestroyError) throw bodyDestroyError;
    if (execution.signal.aborted) {
      throw new Error(String(execution.signal.reason ?? "compute execution aborted"));
    }
    const capture = await captureOutputs(
      env,
      session,
      run,
      client,
      lease.lease_id,
    );
    if (execution.signal.aborted) {
      throw new Error(String(execution.signal.reason ?? "compute execution aborted"));
    }
    const placement = await sandbox.getContainerPlacementId();
    // Revoke the body before terminal settlement. This both measures the full
    // billable lifetime and guarantees no process remains alive with a token
    // after the control plane marks that token/run terminal.
    await cleanupBody();
    const finishedAtMs = now();
    const stdout = redactCapturedText(command.stdout, lease, outputLimit);
    const commandStderr = redactCapturedText(command.stderr, lease, outputLimit);
    const stderrOutput = new BoundedText(outputLimit);
    stderrOutput.append(commandStderr.value);
    if (capture.warnings.length > 0) {
      if (commandStderr.value) stderrOutput.append("\n");
      stderrOutput.append(redactLeaseSecrets(capture.warnings.join("\n"), lease));
    }
    const metrics: ComputeExecutionMetrics = {
      started_at: new Date(startedAtMs).toISOString(),
      finished_at: new Date(finishedAtMs).toISOString(),
      wall_ms: Math.max(0, finishedAtMs - startedAtMs),
      container_placement_id: placement ?? null,
      stdout_bytes: command.stdout.bytes,
      stderr_bytes: command.stderr.bytes,
      stdout_truncated: stdout.truncated,
      stderr_truncated: commandStderr.truncated || stderrOutput.truncated,
    };
    const completion: CompleteComputeRunRequest = {
      lease_id: lease.lease_id,
      exit_code: command.exitCode,
      stdout: stdout.value,
      stderr: stderrOutput.value,
      outputs: capture.outputs,
      metrics,
    };
    terminalFinalizationStarted = true;
    await saveFinalizationCheckpoint(env, {
      version: 1,
      run_id: dispatch.run_id,
      operation: "complete",
      body: completion,
    });
    const receipt = await retryFinalization(
      () => client.complete(completion),
      finalizationDelay,
    );
    await env.COMPUTE_ARTIFACTS.delete(
      finalizationCheckpointKey(dispatch.run_id),
    );
    finalized = true;
    return receipt;
  } catch (error) {
    // Never translate an exhausted `complete` retry into `fail`: the complete
    // call may have committed and only lost its response. A different terminal
    // operation would risk double settlement or changing a successful outcome.
    if (terminalFinalizationStarted) throw error;
    // Any lease-less prepare failure is commit-ambiguous: the database may now
    // hold a running lease whose opaque token response was lost. Never persist
    // a lease-less failure checkpoint (it cannot pass the running-row lease
    // fence and would replay forever before claim). Queue redelivery instead
    // reaches live-claim recovery, destroys the old body, and rotates the token.
    if (claim.recovered && lease === undefined) throw error;
    if (leasePreparationInFlight && lease === undefined) throw error;
    const aborted = execution.signal.aborted;
    const reason = String(execution.signal.reason ?? "");
    const code = aborted
      ? reason.includes("cancel")
        ? "cancelled" as const
        : reason.includes("deadline") || reason.includes("expired")
        ? "deadline_exceeded" as const
        : "internal_error" as const
      : phase === "reservation"
      ? "internal_error" as const
      : phase === "image"
      ? "image_unavailable" as const
      : phase === "artifacts"
      ? "artifact_error" as const
      : phase === "secrets"
      ? "secret_error" as const
      : "execution_error" as const;
    await cleanupBody();
    const finishedAtMs = now();
    terminalFinalizationStarted = true;
    const failure: FailComputeRunRequest = {
      ...(lease ? { lease_id: lease.lease_id } : {}),
      code,
      message: safeFailureMessage(error, lease),
      metrics: {
        started_at: new Date(startedAtMs).toISOString(),
        finished_at: new Date(finishedAtMs).toISOString(),
        wall_ms: Math.max(0, finishedAtMs - startedAtMs),
      },
    };
    await saveFinalizationCheckpoint(env, {
      version: 1,
      run_id: dispatch.run_id,
      operation: "fail",
      body: failure,
    });
    const receipt = await retryFinalization(
      () => client.fail(failure),
      finalizationDelay,
    );
    await env.COMPUTE_ARTIFACTS.delete(
      finalizationCheckpointKey(dispatch.run_id),
    );
    finalized = true;
    return receipt;
  } finally {
    externalAbort?.removeEventListener("abort", abortFromCoordinator);
    await cleanupBody();
    if (!finalized) {
      console.error(JSON.stringify({ event: "compute.finalization_missing", run_id: dispatch.run_id }));
    }
  }
}

export async function cancelComputeSandbox(
  env: Env,
  runId: string,
  dependencies: Pick<ExecuteDependencies, "sandboxForRun"> = {},
): Promise<void> {
  const canonicalRunId = assertUuid(runId, "run id");
  const sandbox = (dependencies.sandboxForRun ?? defaultSandboxForRun)(
    env,
    canonicalRunId,
  );
  await boundedDestroy(sandbox);
}
