import type {
  ComputeArtifact,
  ComputeRequest,
  ComputeResult,
  ComputeRun,
  ComputeRunStatus,
} from '../../../shared/contracts/compute.ts';
import { resolveExecutionContext } from '../../services/execution-context-registry.ts';
import {
  type ComputeControlPlaneActor,
  type ComputeControlPlaneAdapter,
  PublicComputeControlPlaneError,
  requireComputeControlPlaneAdapter,
} from './compute-control-plane-adapter.ts';

export interface ComputeBindingProps {
  /** Host-authenticated human owner; never taken from sandbox input. */
  userId: string;
  /** The currently executing Agent/app; never taken from sandbox input. */
  agentId: string;
}

interface ResolvedComputeExecution {
  actor: ComputeControlPlaneActor;
  executionDeadlineAtMs: number;
  billingMode: 'wallet' | 'subscription_capacity';
  capacityAgentId: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PUBLIC_RUN_STATUSES = new Set<ComputeRunStatus>([
  'queued',
  'reserving',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'settlement_pending',
]);

const PUBLIC_REQUEST_FIELDS = new Set([
  'argv',
  'tools',
  'profile',
  'mode',
  'cwd',
  'stdin',
  'timeout_ms',
  'secrets',
  'capture_paths',
  'input_artifacts',
]);
const PUBLIC_INPUT_ARTIFACT_FIELDS = new Set(['artifact_id', 'mount_path']);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 512,
): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalString(
  value: unknown,
  maxLength = 1_000_000,
): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Resolve the opaque per-execution handle entirely in the parent isolate.
 * Compute never falls back to frozen binding props: all operations require a
 * live handle, even on a cold/non-reused Dynamic Worker.
 */
function resolveComputeExecution(
  props: ComputeBindingProps,
  execCtxHandle: string | null | undefined,
): ResolvedComputeExecution {
  const execution = resolveExecutionContext(execCtxHandle);
  if (!execution) {
    throw new Error(
      'galactic.compute requires the current execution context; the handle is missing, expired, or unknown.',
    );
  }
  if (execution.appId !== props.agentId) {
    throw new Error(
      'galactic.compute execution context does not belong to this Agent.',
    );
  }
  if (!execution.functionName || !execution.aiExecutionId) {
    throw new Error('galactic.compute execution context is incomplete.');
  }
  if (
    typeof execution.executionDeadlineAtMs !== 'number' ||
    !Number.isFinite(execution.executionDeadlineAtMs)
  ) {
    throw new Error('galactic.compute execution deadline is unavailable.');
  }
  const billingMode = execution.capacityReceiptId
    ? 'subscription_capacity' as const
    : 'wallet' as const;
  const capacityAgentId = execution.capacityAgentId || props.agentId;
  if (!UUID_RE.test(capacityAgentId)) {
    throw new Error('galactic.compute capacity attribution is unavailable.');
  }
  if (billingMode === 'subscription_capacity' && !execution.capacityAgentId) {
    throw new Error('galactic.compute capacity attribution is unavailable.');
  }
  return {
    actor: {
      userId: props.userId,
      agentId: props.agentId,
      callerFunction: execution.functionName,
      executionId: execution.aiExecutionId,
    },
    executionDeadlineAtMs: Math.floor(execution.executionDeadlineAtMs),
    billingMode,
    capacityAgentId,
  };
}

export function resolveComputeActor(
  props: ComputeBindingProps,
  execCtxHandle: string | null | undefined,
): ComputeControlPlaneActor {
  return resolveComputeExecution(props, execCtxHandle).actor;
}

/**
 * Copy only the public request contract. Reject unsupported fields here as
 * well as in the authoritative admission service: silently discarding a typo
 * would make Agent code believe an unenforced option took effect.
 */
export function projectComputeRequest(value: unknown): ComputeRequest {
  const input = record(value, 'galactic.compute request');
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
      'profile',
      'mode',
      'cwd',
      'stdin',
      'timeout_ms',
    ] as const
  ) {
    if (input[key] !== undefined) projected[key] = input[key];
  }
  if (input.secrets !== undefined) {
    projected.secrets = Array.isArray(input.secrets) ? [...input.secrets] : input.secrets;
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
          artifact === null || typeof artifact !== 'object' ||
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
    typeof callIndex !== 'number' || !Number.isSafeInteger(callIndex) ||
    callIndex < 1 || callIndex > 1_000_000
  ) {
    throw new Error('galactic.compute call index is missing or invalid.');
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
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
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20, 32)
  }`;
}

function sanitizeArtifact(value: unknown): ComputeArtifact {
  const artifact = record(value, 'compute artifact');
  const expiresAt = requiredString(artifact.expires_at, 'artifact expires_at');
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('compute artifact expires_at is invalid.');
  }
  return {
    artifact_id: requiredString(artifact.artifact_id, 'artifact_id'),
    path: requiredString(artifact.path, 'artifact path', 4_096),
    size_bytes: optionalFiniteNumber(artifact.size_bytes) ?? 0,
    sha256: requiredString(artifact.sha256, 'artifact sha256', 128),
    expires_at: expiresAt,
  };
}

/**
 * Allowlist the response fields that may enter an untrusted body. Internal
 * lease/job tokens, placement metadata, provider keys, and adapter-specific
 * fields are removed even if an integration accidentally returns them.
 */
export function sanitizeComputeRun(value: unknown): ComputeRun {
  const run = record(value, 'Galactic Compute control-plane response');
  const status = run.status;
  if (
    typeof status !== 'string' ||
    !PUBLIC_RUN_STATUSES.has(status as ComputeRunStatus)
  ) {
    throw new Error(
      'Galactic Compute control-plane response has an invalid status',
    );
  }
  const tools = Array.isArray(run.tools)
    ? run.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const output: ComputeRun = {
    run_id: requiredString(run.run_id, 'run_id'),
    receipt_id: requiredString(run.receipt_id, 'receipt_id'),
    status: status as ComputeRunStatus,
    profile: requiredString(
      run.profile,
      'profile',
      64,
    ) as ComputeRun['profile'],
    tools,
    created_at: requiredString(run.created_at, 'created_at', 128),
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

function publicBindingError(error: unknown): Error {
  if (error instanceof PublicComputeControlPlaneError) {
    const out = new Error(
      `galactic.compute failed (${error.code}): ${error.message}`,
    );
    out.name = 'GalacticComputeError';
    return out;
  }
  // Do not stringify the original exception: control-plane/database errors may
  // contain private transport details. The host can correlate via its own logs.
  const out = new Error('galactic.compute failed: control plane unavailable.');
  out.name = 'GalacticComputeError';
  return out;
}

export interface ComputeBindingOperations {
  call(
    request: unknown,
    execCtxHandle?: string,
    callIndex?: number,
  ): Promise<ComputeResult>;
  get(runId: unknown, execCtxHandle?: string): Promise<ComputeRun>;
  cancel(runId: unknown, execCtxHandle?: string): Promise<ComputeRun>;
}

export function createComputeBindingOperations(
  props: ComputeBindingProps,
  adapter: ComputeControlPlaneAdapter = requireComputeControlPlaneAdapter(),
): ComputeBindingOperations {
  const lookup = async (
    method: 'get' | 'cancel',
    runIdValue: unknown,
    execCtxHandle?: string,
  ): Promise<ComputeRun> => {
    const runId = requiredString(runIdValue, 'compute run id', 128);
    const actor = resolveComputeActor(props, execCtxHandle);
    try {
      const result = method === 'get'
        ? await adapter.getComputeRunForAgent({ ...actor, runId })
        : await adapter.cancelComputeRunForAgent({ ...actor, runId });
      return sanitizeComputeRun(result);
    } catch (error) {
      throw publicBindingError(error);
    }
  };

  return {
    async call(request, execCtxHandle, callIndex) {
      const execution = resolveComputeExecution(props, execCtxHandle);
      const actor = execution.actor;
      try {
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
          async: record(result, 'Galactic Compute control-plane response').async ===
            true,
        } as ComputeResult;
      } catch (error) {
        throw publicBindingError(error);
      }
    },
    get(runId, execCtxHandle) {
      return lookup('get', runId, execCtxHandle);
    },
    cancel(runId, execCtxHandle) {
      return lookup('cancel', runId, execCtxHandle);
    },
  };
}
