import type {
  ComputeArtifact,
  ComputePublicErrorAction,
  ComputeRequest,
  ComputeResult,
  ComputeRun,
  ComputeRunStatus,
} from "../../../shared/contracts/compute.ts";
import {
  COMPUTE_ADMISSION_DISABLED_ACTION,
  COMPUTE_ADMISSION_DISABLED_CODE,
  COMPUTE_ADMISSION_DISABLED_HINT,
  COMPUTE_ADMISSION_DISABLED_MESSAGE,
  normalizeComputePublicError,
} from "../../../shared/contracts/compute.ts";
import {
  type ComputeControlPlaneActor,
  type ComputeControlPlaneAdapter,
  PublicComputeControlPlaneError,
} from "./compute-control-plane-adapter.ts";

export interface ComputeBindingProps {
  /** Host-authenticated human owner; never taken from sandbox input. */
  userId: string;
  /** The currently executing Agent/app; never taken from sandbox input. */
  agentId: string;
  /** Host-selected exported function; never taken from a Compute request. */
  callerFunction: string;
  /** Parent Agent execution used for admission idempotency and ownership. */
  executionId: string;
  /** Absolute parent execution deadline, fixed before the binding is created. */
  executionDeadlineAtMs: number;
  /** Trusted billing route inherited from the enclosing Agent execution. */
  billingMode: "wallet" | "subscription_capacity";
  /** Root Agent whose account/Agent capacity pool owns the Compute lease. */
  capacityAgentId: string;
  /**
   * Public receipt used only to attribute this distinct RPC TailItem to the
   * enclosing subscription-capacity execution. Never returned to the body.
   */
  capacityReceiptId: string | null;
  /**
   * Fresh 256-bit parent-generated key for authenticating the one public
   * admission-disabled envelope across the stateless WorkerEntrypoint boundary.
   * It is trusted binding state, never request/body data.
   */
  admissionDisabledProofKey: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PLANE_UNAVAILABLE_CODE = "COMPUTE_CONTROL_PLANE_UNAVAILABLE";
const CONTROL_PLANE_UNAVAILABLE_MESSAGE =
  "Galactic Compute control plane is unavailable.";
const CAPACITY_TAIL_MARKER = "GALACTIC_CAPACITY_EXECUTION_V1 ";
const ADMISSION_DISABLED_PROOF_KEY_RE = /^[0-9a-f]{64}$/;
const ADMISSION_DISABLED_PROOF_DOMAIN =
  "galactic-compute-admission-disabled-proof-v1";

const PUBLIC_RUN_STATUSES = new Set<ComputeRunStatus>([
  "queued",
  "reserving",
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "settlement_pending",
]);

const PUBLIC_REQUEST_FIELDS = new Set([
  "argv",
  "tools",
  "profile",
  "mode",
  "cwd",
  "stdin",
  "timeout_ms",
  "secrets",
  "capture_paths",
  "input_artifacts",
]);
const PUBLIC_INPUT_ARTIFACT_FIELDS = new Set(["artifact_id", "mount_path"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 512,
): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalString(
  value: unknown,
  maxLength = 1_000_000,
): string | undefined {
  return typeof value === "string" && value.length <= maxLength
    ? value
    : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function validateComputeCapacityAttribution(
  props: ComputeBindingProps,
): void {
  const subscription = props.billingMode === "subscription_capacity";
  const wallet = props.billingMode === "wallet";
  if (
    !UUID_RE.test(props.agentId) ||
    !UUID_RE.test(props.capacityAgentId) ||
    (!wallet && !subscription) ||
    (wallet &&
      (props.capacityAgentId !== props.agentId ||
        props.capacityReceiptId !== null)) ||
    (subscription &&
      (typeof props.capacityReceiptId !== "string" ||
        !UUID_RE.test(props.capacityReceiptId)))
  ) {
    throw new Error("galactic.compute capacity attribution is invalid.");
  }
}

function resolveComputeExecution(
  props: ComputeBindingProps,
): {
  actor: ComputeControlPlaneActor;
  executionDeadlineAtMs: number;
  billingMode: "wallet" | "subscription_capacity";
  capacityAgentId: string;
} {
  if (!UUID_RE.test(props.userId) || !UUID_RE.test(props.agentId)) {
    throw new Error("galactic.compute trusted identity is invalid.");
  }
  if (!UUID_RE.test(props.executionId)) {
    throw new Error("galactic.compute trusted execution identity is invalid.");
  }
  if (!ADMISSION_DISABLED_PROOF_KEY_RE.test(props.admissionDisabledProofKey)) {
    throw new Error("galactic.compute public error proof is invalid.");
  }
  const callerFunction = requiredString(
    props.callerFunction,
    "galactic.compute caller function",
    256,
  );
  if (
    typeof props.executionDeadlineAtMs !== "number" ||
    !Number.isFinite(props.executionDeadlineAtMs) ||
    props.executionDeadlineAtMs <= Date.now()
  ) {
    throw new Error(
      "galactic.compute execution deadline is invalid or expired.",
    );
  }
  validateComputeCapacityAttribution(props);
  return {
    actor: {
      userId: props.userId,
      agentId: props.agentId,
      callerFunction,
      executionId: props.executionId,
    },
    executionDeadlineAtMs: Math.floor(props.executionDeadlineAtMs),
    billingMode: props.billingMode,
    capacityAgentId: props.capacityAgentId,
  };
}

/**
 * A ctx.exports RPC invocation is a distinct Cloudflare TailItem. Mark it at
 * method entry so the enclosing subscription-capacity execution owns all of
 * its CPU, including adapter construction and failed operations. The receipt
 * is public correlation data and never enters the tenant body or RPC result.
 */
export function markComputeBindingCapacity(
  props: ComputeBindingProps,
): void {
  validateComputeCapacityAttribution(props);
  if (props.capacityReceiptId) {
    console.log(
      `${CAPACITY_TAIL_MARKER}${
        JSON.stringify({ receipt_id: props.capacityReceiptId })
      }`,
    );
  }
}

export function resolveComputeActor(
  props: ComputeBindingProps,
): ComputeControlPlaneActor {
  return resolveComputeExecution(props).actor;
}

/**
 * Copy only the public request contract. Reject unsupported fields here as
 * well as in the authoritative admission service: silently discarding a typo
 * would make Agent code believe an unenforced option took effect.
 */
export function projectComputeRequest(value: unknown): ComputeRequest {
  const input = record(value, "galactic.compute request");
  const unsupported = Object.keys(input).find((key) =>
    !PUBLIC_REQUEST_FIELDS.has(key)
  );
  if (unsupported) {
    throw new Error(`Unsupported galactic.compute field: ${unsupported}`);
  }
  const projected: Record<string, unknown> = {
    argv: Array.isArray(input.argv) ? [...input.argv] : input.argv,
    tools: Array.isArray(input.tools) ? [...input.tools] : input.tools,
  };
  for (
    const key of [
      "profile",
      "mode",
      "cwd",
      "stdin",
      "timeout_ms",
    ] as const
  ) {
    if (input[key] !== undefined) projected[key] = input[key];
  }
  if (input.secrets !== undefined) {
    projected.secrets = Array.isArray(input.secrets)
      ? [...input.secrets]
      : input.secrets;
  }
  if (input.capture_paths !== undefined) {
    projected.capture_paths = Array.isArray(input.capture_paths)
      ? [...input.capture_paths]
      : input.capture_paths;
  }
  if (input.input_artifacts !== undefined) {
    projected.input_artifacts = Array.isArray(input.input_artifacts)
      ? input.input_artifacts.map((artifact) => {
        if (
          artifact === null || typeof artifact !== "object" ||
          Array.isArray(artifact)
        ) {
          return artifact;
        }
        const item = artifact as Record<string, unknown>;
        const unsupportedArtifactField = Object.keys(item).find((key) =>
          !PUBLIC_INPUT_ARTIFACT_FIELDS.has(key)
        );
        if (unsupportedArtifactField) {
          throw new Error(
            `Unsupported input artifact field: ${unsupportedArtifactField}`,
          );
        }
        return {
          artifact_id: item.artifact_id,
          mount_path: item.mount_path,
        };
      })
      : input.input_artifacts;
  }
  return projected as unknown as ComputeRequest;
}

/**
 * A function may launch more than one body, so its parent execution UUID alone
 * is not a sufficient admission key. Derive a stable UUID from the parent and
 * the SDK's per-execution call index: retries replay the same admission, while
 * distinct calls cannot collide. The database still checks the request hash.
 */
export async function deriveComputeIdempotencyKey(
  executionId: string,
  callIndex: unknown,
): Promise<string> {
  if (
    typeof callIndex !== "number" || !Number.isSafeInteger(callIndex) ||
    callIndex < 1 || callIndex > 1_000_000
  ) {
    throw new Error("galactic.compute call index is missing or invalid.");
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `galactic-compute-admission-v1\0${executionId}\0${callIndex}`,
      ),
    ),
  );
  // RFC 4122 variant + version-5-shaped deterministic UUID. SHA-256 supplies
  // the digest; the version nibble communicates name-derived semantics.
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(
    digest.slice(0, 16),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20, 32)}`;
}

function sanitizeArtifact(value: unknown): ComputeArtifact {
  const artifact = record(value, "compute artifact");
  const expiresAt = requiredString(artifact.expires_at, "artifact expires_at");
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("compute artifact expires_at is invalid.");
  }
  return {
    artifact_id: requiredString(artifact.artifact_id, "artifact_id"),
    path: requiredString(artifact.path, "artifact path", 4_096),
    size_bytes: optionalFiniteNumber(artifact.size_bytes) ?? 0,
    sha256: requiredString(artifact.sha256, "artifact sha256", 128),
    expires_at: expiresAt,
  };
}

/**
 * Allowlist the response fields that may enter an untrusted body. Internal
 * lease/job tokens, placement metadata, provider keys, and adapter-specific
 * fields are removed even if an integration accidentally returns them.
 */
export function sanitizeComputeRun(value: unknown): ComputeRun {
  const run = record(value, "Galactic Compute control-plane response");
  const status = run.status;
  if (
    typeof status !== "string" ||
    !PUBLIC_RUN_STATUSES.has(status as ComputeRunStatus)
  ) {
    throw new Error(
      "Galactic Compute control-plane response has an invalid status",
    );
  }
  const tools = Array.isArray(run.tools)
    ? run.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const output: ComputeRun = {
    run_id: requiredString(run.run_id, "run_id"),
    receipt_id: requiredString(run.receipt_id, "receipt_id"),
    status: status as ComputeRunStatus,
    profile: requiredString(
      run.profile,
      "profile",
      64,
    ) as ComputeRun["profile"],
    tools,
    created_at: requiredString(run.created_at, "created_at", 128),
  };

  const startedAt = optionalString(run.started_at, 128);
  const finishedAt = optionalString(run.finished_at, 128);
  const stdout = optionalString(run.stdout);
  const stderr = optionalString(run.stderr);
  const error = optionalString(run.error, 16_384);
  const exitCode = optionalFiniteNumber(run.exit_code);
  if (startedAt !== undefined) output.started_at = startedAt;
  if (finishedAt !== undefined) output.finished_at = finishedAt;
  if (exitCode !== undefined) output.exit_code = exitCode;
  if (stdout !== undefined) output.stdout = stdout;
  if (stderr !== undefined) output.stderr = stderr;
  if (error !== undefined) output.error = error;
  if (Array.isArray(run.artifacts)) {
    output.artifacts = run.artifacts.map(sanitizeArtifact);
  }
  return output;
}

function publicBindingError(error: unknown): PublicComputeControlPlaneError {
  if (error instanceof PublicComputeControlPlaneError) {
    const safe = normalizeComputePublicError({
      code: error.code,
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
      ...(error.action !== undefined ? { action: error.action } : {}),
    });
    if (safe) {
      return new PublicComputeControlPlaneError(safe.code, safe.message, {
        ...(safe.hint !== undefined ? { hint: safe.hint } : {}),
        ...(safe.action !== undefined ? { action: safe.action } : {}),
      });
    }
  }
  // Do not stringify the original exception: control-plane/database errors may
  // contain private transport details. The host can correlate via its own logs.
  return new PublicComputeControlPlaneError(
    CONTROL_PLANE_UNAVAILABLE_CODE,
    CONTROL_PLANE_UNAVAILABLE_MESSAGE,
  );
}

export type ComputeBindingRpcResult<T> =
  | { ok: true; value: T }
  | {
    ok: false;
    error: {
      code: string;
      message: string;
      hint?: string;
      action?: ComputePublicErrorAction;
      /** Internal transport proof; setup.js validates then strips it. */
      proof?: string;
    };
  };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function admissionDisabledProofPayload(callIndex: number): string {
  return [
    ADMISSION_DISABLED_PROOF_DOMAIN,
    COMPUTE_ADMISSION_DISABLED_CODE,
    COMPUTE_ADMISSION_DISABLED_MESSAGE,
    COMPUTE_ADMISSION_DISABLED_HINT,
    COMPUTE_ADMISSION_DISABLED_ACTION,
    String(callIndex),
  ].join("\0");
}

/**
 * Create the capability proof consumed by generated setup.js. Exported only so
 * the generated-runtime parity/security tests can exercise the real boundary.
 */
export async function createComputeAdmissionDisabledProof(
  proofKey: string,
  callIndex: unknown,
): Promise<string | null> {
  if (
    !ADMISSION_DISABLED_PROOF_KEY_RE.test(proofKey) ||
    typeof callIndex !== "number" || !Number.isSafeInteger(callIndex) ||
    callIndex < 1 || callIndex > 1_000_000
  ) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(proofKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(admissionDisabledProofPayload(callIndex)),
  )));
}

interface CaptureComputeBindingRpcOptions {
  admissionDisabledProofKey?: string;
  admissionCallIndex?: unknown;
}

/**
 * Workers RPC does not preserve custom Error subclasses or their fields.
 * Transport the public result/error as plain data and reconstruct the SDK
 * error inside the Dynamic Worker instead.
 */
export async function captureComputeBindingRpc<T>(
  operation: () => Promise<T>,
  options: CaptureComputeBindingRpcOptions = {},
): Promise<ComputeBindingRpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const safe = publicBindingError(error);
    const proof = safe.code === COMPUTE_ADMISSION_DISABLED_CODE
      ? await createComputeAdmissionDisabledProof(
        options.admissionDisabledProofKey ?? "",
        options.admissionCallIndex,
      )
      : null;
    return {
      ok: false,
      error: {
        code: safe.code,
        message: safe.message,
        ...(safe.hint !== undefined ? { hint: safe.hint } : {}),
        ...(safe.action !== undefined ? { action: safe.action } : {}),
        ...(proof ? { proof } : {}),
      },
    };
  }
}

export interface ComputeBindingOperations {
  call(
    request: unknown,
    callIndex?: number,
  ): Promise<ComputeResult>;
  get(runId: unknown): Promise<ComputeRun>;
  cancel(runId: unknown): Promise<ComputeRun>;
}

export function createComputeBindingOperations(
  props: ComputeBindingProps,
  adapter: ComputeControlPlaneAdapter,
): ComputeBindingOperations {
  const lookup = async (
    method: "get" | "cancel",
    runIdValue: unknown,
  ): Promise<ComputeRun> => {
    try {
      const runId = requiredString(runIdValue, "compute run id", 128);
      const actor = resolveComputeActor(props);
      const result = method === "get"
        ? await adapter.getComputeRunForAgent({ ...actor, runId })
        : await adapter.cancelComputeRunForAgent({ ...actor, runId });
      return sanitizeComputeRun(result);
    } catch (error) {
      throw publicBindingError(error);
    }
  };

  return {
    async call(request, callIndex) {
      try {
        const execution = resolveComputeExecution(props);
        const actor = execution.actor;
        const result = await adapter.admitComputeRun({
          ...actor,
          executionDeadlineAtMs: execution.executionDeadlineAtMs,
          billingMode: execution.billingMode,
          capacityAgentId: execution.capacityAgentId,
          idempotencyKey: await deriveComputeIdempotencyKey(
            actor.executionId,
            callIndex,
          ),
          request: projectComputeRequest(request),
        });
        const run = sanitizeComputeRun(result);
        return {
          ...run,
          async:
            record(result, "Galactic Compute control-plane response").async ===
              true,
        } as ComputeResult;
      } catch (error) {
        throw publicBindingError(error);
      }
    },
    get(runId) {
      return lookup("get", runId);
    },
    cancel(runId) {
      return lookup("cancel", runId);
    },
  };
}
