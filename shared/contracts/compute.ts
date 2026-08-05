import { validateEnvVarKey } from './env.ts';

/** The only manifest/runtime permission that admits Galactic Compute. */
export const COMPUTE_EXEC_PERMISSION = 'compute:exec' as const;

/**
 * Public admission-off response. Keep this copy centralized: the API binding,
 * Dynamic Worker SDK, MCP response, and CLI must not drift or reveal which
 * internal admission fence (operator flag or emergency stop) is active.
 */
export const COMPUTE_ADMISSION_DISABLED_CODE =
  'COMPUTE_ADMISSION_DISABLED' as const;
export const COMPUTE_ADMISSION_DISABLED_MESSAGE =
  'Galactic Compute is not accepting new jobs right now.' as const;
export const COMPUTE_ADMISSION_DISABLED_HINT =
  'Try again later. This request did not start a Compute job.' as const;
export const COMPUTE_ADMISSION_DISABLED_ACTION = 'retry_later' as const;

export type ComputePublicErrorAction =
  typeof COMPUTE_ADMISSION_DISABLED_ACTION;

/** Closed, secret-safe error data that may cross into Agent code and MCP. */
export interface ComputePublicErrorDetails {
  code: string;
  hint?: string;
  action?: ComputePublicErrorAction;
}

/** Binding transport shape; `message` remains the human-facing primary copy. */
export interface ComputePublicError extends ComputePublicErrorDetails {
  message: string;
}

const COMPUTE_PUBLIC_ERROR_CODE_PATTERN = /^COMPUTE_[A-Z0-9_]{1,56}$/u;
const COMPUTE_PUBLIC_ERROR_MESSAGE_MAX_LENGTH = 1_024;

function computeErrorRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactComputeErrorKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Normalize the only public Compute error wire shape. Optional guidance is
 * deliberately code-specific: a new action or arbitrary hint cannot become a
 * platform instruction merely by satisfying a broad string grammar.
 */
export function normalizeComputePublicError(
  value: unknown,
): ComputePublicError | null {
  const input = computeErrorRecord(value);
  if (!input) return null;
  if (
    typeof input.code !== 'string' ||
    !COMPUTE_PUBLIC_ERROR_CODE_PATTERN.test(input.code) ||
    typeof input.message !== 'string' ||
    input.message.length === 0 ||
    input.message.length > COMPUTE_PUBLIC_ERROR_MESSAGE_MAX_LENGTH
  ) {
    return null;
  }

  if (input.code === COMPUTE_ADMISSION_DISABLED_CODE) {
    if (
      !hasExactComputeErrorKeys(input, ['code', 'message', 'hint', 'action']) ||
      input.message !== COMPUTE_ADMISSION_DISABLED_MESSAGE ||
      input.hint !== COMPUTE_ADMISSION_DISABLED_HINT ||
      input.action !== COMPUTE_ADMISSION_DISABLED_ACTION
    ) {
      return null;
    }
    return {
      code: COMPUTE_ADMISSION_DISABLED_CODE,
      message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
      hint: COMPUTE_ADMISSION_DISABLED_HINT,
      action: COMPUTE_ADMISSION_DISABLED_ACTION,
    };
  }

  // PR1 has one reviewed action. Other errors remain code + message only.
  if (!hasExactComputeErrorKeys(input, ['code', 'message'])) return null;
  return { code: input.code, message: input.message };
}

export function computePublicErrorDetails(
  value: ComputePublicError,
): ComputePublicErrorDetails {
  return {
    code: value.code,
    ...(value.hint !== undefined ? { hint: value.hint } : {}),
    ...(value.action !== undefined ? { action: value.action } : {}),
  };
}

/** Validate a details-only projection received by an MCP or CLI boundary. */
export function normalizeComputePublicErrorDetails(
  value: unknown,
): ComputePublicErrorDetails | null {
  const input = computeErrorRecord(value);
  if (!input || typeof input.code !== 'string') return null;
  if (input.code === COMPUTE_ADMISSION_DISABLED_CODE) {
    return hasExactComputeErrorKeys(input, ['code', 'hint', 'action']) &&
        input.hint === COMPUTE_ADMISSION_DISABLED_HINT &&
        input.action === COMPUTE_ADMISSION_DISABLED_ACTION
      ? {
        code: COMPUTE_ADMISSION_DISABLED_CODE,
        hint: COMPUTE_ADMISSION_DISABLED_HINT,
        action: COMPUTE_ADMISSION_DISABLED_ACTION,
      }
      : null;
  }
  if (
    !COMPUTE_PUBLIC_ERROR_CODE_PATTERN.test(input.code) ||
    !hasExactComputeErrorKeys(input, ['code'])
  ) {
    return null;
  }
  return { code: input.code };
}

/**
 * Compute profiles are immutable, versioned platform contracts. Callers never
 * provide an image name or digest directly.
 */
export const COMPUTE_PROFILES = ['developer-v1'] as const;
export type ComputeProfile = typeof COMPUTE_PROFILES[number];
export const DEFAULT_COMPUTE_PROFILE: ComputeProfile = 'developer-v1';

/**
 * V1 async jobs are driven by a push Queue consumer with a 15-minute wall
 * limit. Eight minutes leaves the reserved 195s startup envelope plus bounded
 * artifact/finalization/destruction time inside that hard platform boundary.
 */
export const COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS = 480_000;

/**
 * Aggregate input/output artifact budget exposed by developer-v1. The first
 * production body uses Cloudflare standard-1 storage, so this deliberately
 * leaves most of the writable disk for the image, browser profiles, office
 * conversions, package caches, and command scratch space. The executor also
 * verifies live free space before it copies any input object into a body.
 */
export const COMPUTE_V1_MAX_ARTIFACT_BYTES = 1_073_741_824;

/** Ready output bytes remain available for this fixed v1 retention window. */
export const COMPUTE_V1_ARTIFACT_RETENTION_DAYS = 30;

/** Hard per-owner physical retained-output quota; input aliases count zero. */
export const COMPUTE_V1_RETAINED_OUTPUT_MAX_BYTES = 10_737_418_240;
export const COMPUTE_V1_RETAINED_OUTPUT_MAX_OBJECTS = 10_000;

/**
 * Immutable semantic catalog baked into the developer-v1 image. These labels
 * are disclosure/admission identifiers, not package names or install input.
 * Unknown IDs fail closed in v1; signed extension packs are a later protocol.
 */
export const DEVELOPER_V1_COMPUTE_TOOLS = [
  'shell',
  'browser',
  'office',
  'media',
  'pdf',
  'ocr',
  'data',
  'databases',
  'transfer',
  'git',
  'coding.claude',
  'coding.codex',
  'galactic',
] as const;
export type DeveloperV1ComputeTool = typeof DEVELOPER_V1_COMPUTE_TOOLS[number];
const DEVELOPER_V1_COMPUTE_TOOL_SET = new Set<string>(
  DEVELOPER_V1_COMPUTE_TOOLS,
);

/**
 * Semantic tool identifiers name capabilities from the platform tool catalog,
 * not packages, binaries, image tags, or arbitrary install instructions. The
 * catalog performs the final existence check; this grammar keeps declarations
 * canonical and safe to hash before that resolution exists.
 */
export type ComputeToolId = string;
export const COMPUTE_TOOL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const COMPUTE_MAX_TOOLS = 32;
export const COMPUTE_MAX_TOOL_ID_LENGTH = 64;
export const COMPUTE_MAX_SECRETS = 50;

export function isComputeProfile(value: unknown): value is ComputeProfile {
  return typeof value === 'string' &&
    (COMPUTE_PROFILES as readonly string[]).includes(value);
}

export function isComputeToolId(value: unknown): value is ComputeToolId {
  return typeof value === 'string' &&
    value.length <= COMPUTE_MAX_TOOL_ID_LENGTH &&
    COMPUTE_TOOL_ID_PATTERN.test(value);
}

export function isDeveloperV1ComputeTool(
  value: unknown,
): value is DeveloperV1ComputeTool {
  return isComputeToolId(value) && DEVELOPER_V1_COMPUTE_TOOL_SET.has(value);
}

/** Owner-reviewed ceiling for compute requests made by this Agent. */
export interface ManifestComputeConfig {
  profile: ComputeProfile;
  tools: ComputeToolId[];
  /**
   * Agent secret NAMES eligible for explicit delivery to a one-shot body.
   * Values never belong in a manifest or compute request.
   */
  secrets?: string[];
}

/** Parse an already-declared manifest compute ceiling defensively. */
export function normalizeManifestComputeConfig(
  value: unknown,
): ManifestComputeConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!isComputeProfile(raw.profile) || !Array.isArray(raw.tools)) return null;
  if (
    raw.tools.length > COMPUTE_MAX_TOOLS ||
    raw.tools.some((tool) => !isDeveloperV1ComputeTool(tool))
  ) {
    return null;
  }
  if (
    raw.secrets !== undefined &&
    (!Array.isArray(raw.secrets) || raw.secrets.length > COMPUTE_MAX_SECRETS ||
      raw.secrets.some((secret) => typeof secret !== 'string' || !validateEnvVarKey(secret).valid))
  ) {
    return null;
  }

  return {
    profile: raw.profile,
    tools: [...new Set(raw.tools as string[])].sort(),
    ...(raw.secrets ? { secrets: [...new Set(raw.secrets as string[])].sort() } : {}),
  };
}

export type ComputeExecutionMode = 'sync' | 'async';

export interface ComputeInputArtifact {
  artifact_id: string;
  mount_path: string;
}

export interface ComputeArtifact {
  artifact_id: string;
  path: string;
  size_bytes: number;
  sha256: string;
  /** Exact control-plane expiry. Admission and downloads fail after this time. */
  expires_at: string;
}

/** Start one disposable, durable compute run. */
export interface ComputeRequest {
  argv: [string, ...string[]];
  /** Semantic capabilities required by this run. */
  tools: ComputeToolId[];
  profile?: ComputeProfile;
  /** Explicit Agent secret names; raw values are never accepted here. */
  secrets?: string[];
  mode?: ComputeExecutionMode;
  cwd?: string;
  stdin?: string;
  timeout_ms?: number;
  input_artifacts?: ComputeInputArtifact[];
  capture_paths?: string[];
}

export type ComputeRunStatus =
  | 'queued'
  | 'reserving'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'settlement_pending';

export interface ComputeRun {
  run_id: string;
  receipt_id: string;
  status: ComputeRunStatus;
  profile: ComputeProfile;
  tools: ComputeToolId[];
  created_at: string;
  started_at?: string;
  finished_at?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  artifacts?: ComputeArtifact[];
  error?: string;
}

export interface ComputeSyncResult extends ComputeRun {
  async: false;
  status: 'completed' | 'failed' | 'cancelled' | 'settlement_pending';
}

export interface ComputeAcceptedResult extends ComputeRun {
  async: true;
  status: 'queued' | 'reserving' | 'starting' | 'running';
}

export type ComputeResult = ComputeSyncResult | ComputeAcceptedResult;

/**
 * Callable in-Agent binding: `galactic.compute(request)`. Status and
 * cancellation stay namespaced on that same function object.
 */
export interface ComputeBinding {
  (request: ComputeRequest): Promise<ComputeResult>;
  get(runId: string): Promise<ComputeRun>;
  cancel(runId: string): Promise<ComputeRun>;
}
