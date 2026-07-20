import { authenticate } from './auth.ts';
import { isAccountSessionAuthSource } from '../services/control-plane-auth.ts';
import {
  COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS,
  COMPUTE_V1_MAX_ARTIFACT_BYTES,
} from '../../shared/contracts/compute.ts';

const COMPUTE_PROFILE = 'developer-v1' as const;
const MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCATOR_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const FUNCTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const PLATFORM_FUNCTION_PATTERN = /^(?:gx|ul)\.[A-Za-z][A-Za-z0-9_.:-]{0,126}$/;
const SECRET_FILE_PREFIX = '/run/galactic/secrets/';
const INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export const COMPUTE_LAUNCH_TOOL_IDS = [
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

export type ComputeLaunchRunStatus =
  | 'queued'
  | 'reserving'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'settlement_pending';

export type ComputeLaunchSecretDelivery =
  | { kind: 'env'; envName: string }
  | { kind: 'file'; path: string };

/** Presence and delivery metadata only. There is intentionally no value field. */
export interface ComputeLaunchSecretBindingSummary {
  name: string;
  delivery: ComputeLaunchSecretDelivery;
  configured: boolean;
  version: string;
  updatedAt: string | null;
}

export interface ComputeLaunchManifestCeiling {
  enabled: boolean;
  profile: typeof COMPUTE_PROFILE | null;
  tools: string[];
  secrets: string[];
}

export type ComputeLaunchAuthorityRule = {
  callerFunction: string;
  decision: 'always' | 'never';
  action: 'platform.call';
  target: { functionName: string };
  version?: string;
} | {
  callerFunction: string;
  decision: 'always' | 'never';
  action: 'agents.call';
  target: { agentId: string; functionName: string };
  version?: string;
};

export type ComputeLaunchAuthorityRuleMutation = {
  callerFunction: string;
  decision: 'always' | 'never';
  action: 'platform.call';
  target: { functionName: string };
} | {
  callerFunction: string;
  decision: 'always' | 'never';
  action: 'agents.call';
  target: { agentId: string; functionName: string };
};

export interface ComputeLaunchSettingsView {
  settings: {
    enabled: boolean;
    profile: typeof COMPUTE_PROFILE;
    allowedTools: string[];
    secretBindings: ComputeLaunchSecretBindingSummary[];
    authorityRules: ComputeLaunchAuthorityRule[];
    limits: {
      maxTimeoutMs: number;
      maxConcurrency: number;
      maxArtifactBytes: number;
      maxArtifacts: number;
    };
    manifestCeiling: ComputeLaunchManifestCeiling;
    ownerConfirmedAt: string | null;
    updatedAt: string | null;
  };
  revision: string;
}

export interface ComputeLaunchSettingsMutation {
  expectedRevision: string;
  ownerConfirmed: true;
  settings: {
    enabled: boolean;
    profile: typeof COMPUTE_PROFILE;
    allowedTools: string[];
    secretBindings: Array<{
      name: string;
      delivery: ComputeLaunchSecretDelivery;
    }>;
    authorityRules: ComputeLaunchAuthorityRuleMutation[];
    limits: {
      maxTimeoutMs: number;
      maxConcurrency: number;
      maxArtifactBytes: number;
      maxArtifacts: number;
    };
  };
}

export interface ComputeLaunchRunSummary {
  runId: string;
  receiptId: string | null;
  receiptUrl: string | null;
  billingMode: 'wallet' | 'subscription_capacity';
  status: ComputeLaunchRunStatus;
  agentId: string;
  agentName: string;
  functionName: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  usage: {
    reserved: number;
    actual: number | null;
    trueUp: number | null;
    unit: string;
  };
  exitCode: number | null;
  infraFailure: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  artifacts: Array<{
    id: string;
    name: string;
    sizeBytes: number;
    expiresAt: string;
    url: string | null;
  }>;
  cancellable: boolean;
}

/** Opaque artifact bytes plus safe response metadata; never an R2 locator. */
export interface ComputeLaunchArtifactDownload {
  body: BodyInit;
  contentType: string;
  contentLength: number | null;
  fileName: string;
}

export interface ComputeLaunchAgentReference {
  id: string;
  ownerUserId: string;
}

/**
 * Narrow adapter between the owner HTTP facade and durable Compute services.
 * Implementations own DB joins, CAS, manifest-ceiling resolution, binding
 * reconciliation, and run/receipt/artifact projection. They must never return
 * a secret value through this interface.
 */
export interface ComputeLaunchService {
  resolveAgent(
    locator: string,
    userId: string,
  ): Promise<ComputeLaunchAgentReference | null>;
  getSettings(input: {
    userId: string;
    agentId: string;
  }): Promise<ComputeLaunchSettingsView>;
  putSettings(input: {
    userId: string;
    agentId: string;
    mutation: ComputeLaunchSettingsMutation;
  }): Promise<ComputeLaunchSettingsView>;
  listRuns(input: {
    userId: string;
    agentId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{
    runs: ComputeLaunchRunSummary[];
    nextCursor: string | null;
  }>;
  /** Idempotently cancel an active run; terminal runs are returned unchanged. */
  cancelRun(input: {
    userId: string;
    agentId: string;
    runId: string;
  }): Promise<ComputeLaunchRunSummary>;
  downloadArtifact(input: {
    userId: string;
    agentId: string;
    runId: string;
    artifactId: string;
  }): Promise<ComputeLaunchArtifactDownload>;
}

export interface ComputeLaunchHandlerDependencies {
  service?: ComputeLaunchService;
  authenticate?: (request: Request) => Promise<{
    id: string;
    authSource?: string;
  }>;
  now?: () => Date;
}

export class ComputeLaunchServiceError extends Error {
  readonly code: string;
  readonly status: number;
  readonly exposeMessage: boolean;

  constructor(input: {
    code: string;
    status: number;
    message: string;
    exposeMessage?: boolean;
  }) {
    super(input.message);
    this.name = 'ComputeLaunchServiceError';
    this.code = input.code;
    this.status = input.status;
    this.exposeMessage = input.exposeMessage === true;
  }
}

let installedComputeLaunchService: ComputeLaunchService | null = null;

/** Production wiring installs the adapter without broadening the HTTP layer. */
export function installComputeLaunchService(
  service: ComputeLaunchService,
): void {
  installedComputeLaunchService = service;
}

export function isLaunchComputePath(path: string): boolean {
  return /^\/api\/launch\/agents\/[^/]+\/compute\/(?:settings|runs(?:\/[^/]+\/(?:cancel|artifacts\/[^/]+))?)$/
    .test(path);
}

function privateJson(value: unknown, status = 200, allow?: string): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'Vary': 'Cookie, Authorization',
  });
  if (allow) headers.set('Allow', allow);
  return new Response(JSON.stringify(value), { status, headers });
}

function failure(
  code: string,
  message: string,
  status: number,
  allow?: string,
): Response {
  return privateJson({ error: message, code }, status, allow);
}

function mappedServiceFailure(error: ComputeLaunchServiceError): Response {
  const allowed = new Set([
    400,
    401,
    403,
    404,
    409,
    412,
    415,
    422,
    429,
    503,
  ]);
  const status = allowed.has(error.status) ? error.status : 500;
  const genericMessages: Record<number, string> = {
    400: 'Invalid Compute management request',
    401: 'Authentication required',
    403: 'Compute management is forbidden',
    404: 'Compute resource not found',
    409: 'Compute state changed; refresh and retry',
    412: 'Compute precondition failed',
    415: 'Content-Type must be application/json',
    422: 'Compute settings were rejected',
    429: 'Too many Compute management requests',
    503: 'Compute management is temporarily unavailable',
  };
  const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'COMPUTE_LAUNCH_FAILED';
  return failure(
    status === 500 ? 'COMPUTE_LAUNCH_FAILED' : safeCode,
    status === 500
      ? 'Compute launch request failed'
      : error.exposeMessage
      ? error.message
      : genericMessages[status] ?? 'Compute management request failed',
    status,
  );
}

function invalid(code: string, message: string): never {
  throw new ComputeLaunchServiceError({
    code,
    message,
    status: 400,
    exposeMessage: true,
  });
}

function decodeLocator(encoded: string): string {
  let locator: string;
  try {
    locator = decodeURIComponent(encoded).trim();
  } catch {
    return invalid('INVALID_AGENT_ID', 'Invalid Agent id');
  }
  if (!LOCATOR_PATTERN.test(locator)) {
    return invalid('INVALID_AGENT_ID', 'Invalid Agent id');
  }
  return locator;
}

function onlyQuery(url: URL, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key) || url.searchParams.getAll(key).length !== 1) {
      invalid('INVALID_QUERY', `Invalid query parameter: ${key}`);
    }
  }
}

function parseRunPage(url: URL): { limit: number; cursor: string | null } {
  onlyQuery(url, ['limit', 'cursor']);
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? DEFAULT_RUN_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN_LIMIT) {
    invalid(
      'INVALID_LIMIT',
      `limit must be an integer between 1 and ${MAX_RUN_LIMIT}`,
    );
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && !CURSOR_PATTERN.test(cursor)) {
    invalid('INVALID_CURSOR', 'cursor is invalid');
  }
  return { limit, cursor };
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('INVALID_BODY', `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const expected = new Set(required);
  const unknown = Object.keys(value).find((key) => !expected.has(key));
  const missing = required.find((key) => !(key in value));
  if (unknown) {
    invalid('INVALID_BODY', `Unsupported ${label} field: ${unknown}`);
  }
  if (missing) invalid('INVALID_BODY', `Missing ${label} field: ${missing}`);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]
    .trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ComputeLaunchServiceError({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Content-Type must be application/json',
      status: 415,
    });
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    invalid('BODY_TOO_LARGE', 'Request body is too large');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    invalid('BODY_TOO_LARGE', 'Request body is too large');
  }
  try {
    return asObject(JSON.parse(text || '{}'), 'Request body');
  } catch (error) {
    if (error instanceof ComputeLaunchServiceError) throw error;
    return invalid('INVALID_BODY', 'Request body must be valid JSON');
  }
}

function revision(value: unknown): string {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === 'string'
    ? value
    : '';
  if (!INTEGER_PATTERN.test(normalized)) {
    return invalid(
      'INVALID_REVISION',
      'expectedRevision must be a non-negative integer',
    );
  }
  return BigInt(normalized).toString();
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum
  ) {
    return invalid(
      'INVALID_SETTINGS',
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function parseDelivery(value: unknown): ComputeLaunchSecretDelivery {
  const delivery = asObject(value, 'Secret delivery');
  if (delivery.kind === 'env') {
    onlyKeys(delivery, ['kind', 'envName'], 'secret delivery');
    if (
      typeof delivery.envName !== 'string' ||
      !ENV_NAME_PATTERN.test(delivery.envName) ||
      ['GX_', 'GALACTIC_', 'ULTRALIGHT_'].some((prefix) =>
        (delivery.envName as string).startsWith(prefix)
      )
    ) {
      return invalid(
        'INVALID_SECRET_BINDING',
        'Secret environment destination is invalid',
      );
    }
    return { kind: 'env', envName: delivery.envName };
  }
  if (delivery.kind === 'file') {
    onlyKeys(delivery, ['kind', 'path'], 'secret delivery');
    const path = typeof delivery.path === 'string' ? delivery.path : '';
    const basename = path.slice(SECRET_FILE_PREFIX.length);
    if (
      !path.startsWith(SECRET_FILE_PREFIX) || !basename || basename === '.' ||
      basename === '..' || basename.includes('/') || basename.includes('\\') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(basename) ||
      basename.toLowerCase().includes('job-token')
    ) {
      return invalid(
        'INVALID_SECRET_BINDING',
        `Secret file destination must be directly under ${SECRET_FILE_PREFIX}`,
      );
    }
    return { kind: 'file', path };
  }
  return invalid('INVALID_SECRET_BINDING', 'Secret delivery kind is invalid');
}

function parseSettingsMutation(
  body: Record<string, unknown>,
): ComputeLaunchSettingsMutation {
  onlyKeys(
    body,
    ['expectedRevision', 'ownerConfirmed', 'settings'],
    'request',
  );
  if (body.ownerConfirmed !== true) {
    invalid('OWNER_CONFIRMATION_REQUIRED', 'ownerConfirmed must be true');
  }
  const settings = asObject(body.settings, 'settings');
  onlyKeys(
    settings,
    [
      'enabled',
      'profile',
      'allowedTools',
      'secretBindings',
      'authorityRules',
      'limits',
    ],
    'settings',
  );
  if (typeof settings.enabled !== 'boolean') {
    invalid('INVALID_SETTINGS', 'enabled must be a boolean');
  }
  if (settings.profile !== COMPUTE_PROFILE) {
    invalid('INVALID_PROFILE', `profile must be ${COMPUTE_PROFILE}`);
  }
  if (
    !Array.isArray(settings.allowedTools) ||
    settings.allowedTools.length > 64 ||
    settings.allowedTools.some((tool) => typeof tool !== 'string' || !TOOL_PATTERN.test(tool)) ||
    new Set(settings.allowedTools).size !== settings.allowedTools.length
  ) {
    invalid(
      'INVALID_TOOLS',
      'allowedTools must contain at most 64 unique semantic tool IDs',
    );
  }
  if (
    !Array.isArray(settings.secretBindings) ||
    settings.secretBindings.length > 50
  ) {
    invalid(
      'INVALID_SECRET_BINDING',
      'secretBindings must contain at most 50 mappings',
    );
  }
  const names = new Set<string>();
  const destinations = new Set<string>();
  const bindings = settings.secretBindings.map((raw) => {
    const binding = asObject(raw, 'Secret binding');
    onlyKeys(binding, ['name', 'delivery'], 'secret binding');
    if (
      typeof binding.name !== 'string' ||
      !SECRET_NAME_PATTERN.test(binding.name)
    ) {
      return invalid(
        'INVALID_SECRET_BINDING',
        'Secret binding name is invalid',
      );
    }
    if (names.has(binding.name)) {
      return invalid(
        'INVALID_SECRET_BINDING',
        'Secret binding names must be unique',
      );
    }
    names.add(binding.name);
    const delivery = parseDelivery(binding.delivery);
    const destination = delivery.kind === 'env'
      ? `env:${delivery.envName}`
      : `file:${delivery.path}`;
    if (destinations.has(destination)) {
      return invalid(
        'INVALID_SECRET_BINDING',
        'Secret destinations must be unique',
      );
    }
    destinations.add(destination);
    return { name: binding.name, delivery };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (
    !Array.isArray(settings.authorityRules) ||
    settings.authorityRules.length > 200
  ) {
    invalid(
      'INVALID_AUTHORITY_RULE',
      'authorityRules must contain at most 200 exact rules',
    );
  }
  const authorityKeys = new Set<string>();
  const authorityRules = settings.authorityRules.map((raw) => {
    const rule = asObject(raw, 'Authority rule');
    onlyKeys(
      rule,
      ['callerFunction', 'decision', 'action', 'target'],
      'authority rule',
    );
    if (
      typeof rule.callerFunction !== 'string' ||
      !FUNCTION_NAME_PATTERN.test(rule.callerFunction)
    ) invalid('INVALID_AUTHORITY_RULE', 'Authority callerFunction is invalid');
    if (
      rule.decision !== 'always' && rule.decision !== 'never'
    ) {
      invalid('INVALID_AUTHORITY_RULE', 'Authority decision is invalid');
    }
    const target = asObject(rule.target, 'Authority target');
    let normalized: ComputeLaunchAuthorityRuleMutation;
    if (rule.action === 'platform.call') {
      onlyKeys(target, ['functionName'], 'platform authority target');
      if (
        typeof target.functionName !== 'string' ||
        !PLATFORM_FUNCTION_PATTERN.test(target.functionName) ||
        target.functionName.includes('*')
      ) {
        invalid(
          'INVALID_AUTHORITY_RULE',
          'platform.call requires one exact Galactic platform function',
        );
      }
      normalized = {
        callerFunction: rule.callerFunction,
        decision: rule.decision,
        action: 'platform.call',
        target: { functionName: target.functionName },
      };
    } else if (rule.action === 'agents.call') {
      onlyKeys(target, ['agentId', 'functionName'], 'Agent authority target');
      if (
        typeof target.agentId !== 'string' ||
        !UUID_PATTERN.test(target.agentId) ||
        typeof target.functionName !== 'string' ||
        !FUNCTION_NAME_PATTERN.test(target.functionName) ||
        target.functionName.includes('*')
      ) {
        invalid(
          'INVALID_AUTHORITY_RULE',
          'agents.call requires one exact Agent id and function',
        );
      }
      normalized = {
        callerFunction: rule.callerFunction,
        decision: rule.decision,
        action: 'agents.call',
        target: {
          agentId: target.agentId,
          functionName: target.functionName,
        },
      };
    } else {
      return invalid(
        'INVALID_AUTHORITY_RULE',
        'Authority action must be platform.call or agents.call',
      );
    }
    const key = JSON.stringify([
      normalized.callerFunction,
      normalized.action,
      normalized.target,
    ]);
    if (authorityKeys.has(key)) {
      return invalid(
        'INVALID_AUTHORITY_RULE',
        'Authority targets must be unique per caller',
      );
    }
    authorityKeys.add(key);
    return normalized;
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const limits = asObject(settings.limits, 'limits');
  onlyKeys(
    limits,
    ['maxTimeoutMs', 'maxConcurrency', 'maxArtifactBytes', 'maxArtifacts'],
    'limits',
  );
  return {
    expectedRevision: revision(body.expectedRevision),
    ownerConfirmed: true,
    settings: {
      enabled: settings.enabled,
      profile: COMPUTE_PROFILE,
      allowedTools: [...settings.allowedTools].sort() as string[],
      secretBindings: bindings,
      authorityRules,
      limits: {
        maxTimeoutMs: boundedInteger(
          limits.maxTimeoutMs,
          'maxTimeoutMs',
          1_000,
          COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS,
        ),
        maxConcurrency: boundedInteger(
          limits.maxConcurrency,
          'maxConcurrency',
          1,
          32,
        ),
        maxArtifactBytes: boundedInteger(
          limits.maxArtifactBytes,
          'maxArtifactBytes',
          1,
          COMPUTE_V1_MAX_ARTIFACT_BYTES,
        ),
        maxArtifacts: boundedInteger(
          limits.maxArtifacts,
          'maxArtifacts',
          1,
          1_000,
        ),
      },
    },
  };
}

function enforceManifestCeiling(
  mutation: ComputeLaunchSettingsMutation,
  current: ComputeLaunchSettingsView,
): void {
  const ceiling = current.settings.manifestCeiling;
  if (
    mutation.settings.enabled &&
    (!ceiling.enabled || ceiling.profile !== mutation.settings.profile)
  ) {
    invalid(
      'COMPUTE_NOT_DECLARED',
      'The live Agent release does not authorize this Compute profile',
    );
  }
  const tools = new Set(ceiling.tools);
  const outsideTool = mutation.settings.allowedTools.find((tool) => !tools.has(tool));
  if (outsideTool) {
    invalid(
      'TOOLS_OUTSIDE_MANIFEST',
      `Tool ${outsideTool} is outside the live Agent release Compute ceiling`,
    );
  }
  const secrets = new Set(ceiling.secrets);
  const outsideSecret = mutation.settings.secretBindings.find((binding) =>
    !secrets.has(binding.name)
  );
  if (outsideSecret) {
    invalid(
      'SECRET_OUTSIDE_MANIFEST',
      `Secret ${outsideSecret.name} is outside the live Agent release Compute ceiling`,
    );
  }
}

function projectDelivery(value: ComputeLaunchSecretDelivery) {
  return value.kind === 'env'
    ? { kind: 'env' as const, envName: value.envName }
    : { kind: 'file' as const, path: value.path };
}

function projectSettings(view: ComputeLaunchSettingsView) {
  return {
    settings: {
      enabled: view.settings.enabled,
      profile: view.settings.profile,
      allowedTools: [...view.settings.allowedTools],
      secretBindings: view.settings.secretBindings.map((binding) => ({
        name: binding.name,
        delivery: projectDelivery(binding.delivery),
        configured: binding.configured,
        version: binding.version,
        updatedAt: binding.updatedAt,
      })),
      authorityRules: view.settings.authorityRules.map((rule) => ({
        callerFunction: rule.callerFunction,
        decision: rule.decision,
        action: rule.action,
        target: rule.action === 'platform.call' ? { functionName: rule.target.functionName } : {
          agentId: rule.target.agentId,
          functionName: rule.target.functionName,
        },
        ...(rule.version === undefined ? {} : { version: rule.version }),
      })),
      limits: {
        maxTimeoutMs: view.settings.limits.maxTimeoutMs,
        maxConcurrency: view.settings.limits.maxConcurrency,
        maxArtifactBytes: view.settings.limits.maxArtifactBytes,
        maxArtifacts: view.settings.limits.maxArtifacts,
      },
      manifestCeiling: {
        enabled: view.settings.manifestCeiling.enabled,
        profile: view.settings.manifestCeiling.profile,
        tools: [...view.settings.manifestCeiling.tools],
        secrets: [...view.settings.manifestCeiling.secrets],
      },
      ownerConfirmedAt: view.settings.ownerConfirmedAt,
      updatedAt: view.settings.updatedAt,
    },
    revision: view.revision,
  };
}

function artifactDownloadPath(
  agentId: string,
  runId: string,
  artifactId: string,
): string | null {
  if (
    !UUID_PATTERN.test(agentId) || !UUID_PATTERN.test(runId) ||
    !UUID_PATTERN.test(artifactId)
  ) return null;
  return `/api/launch/agents/${encodeURIComponent(agentId)}/compute/runs/${
    encodeURIComponent(runId)
  }/artifacts/${encodeURIComponent(artifactId)}`;
}

function projectRun(run: ComputeLaunchRunSummary, ownedAgentId: string) {
  return {
    runId: run.runId,
    receiptId: run.receiptId,
    receiptUrl: run.receiptUrl,
    billingMode: run.billingMode,
    status: run.status,
    agentId: ownedAgentId,
    agentName: run.agentName,
    functionName: run.functionName,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    usage: {
      reserved: run.usage.reserved,
      actual: run.usage.actual,
      trueUp: run.usage.trueUp,
      unit: run.usage.unit,
    },
    exitCode: run.exitCode,
    infraFailure: run.infraFailure
      ? {
        code: run.infraFailure.code,
        message: run.infraFailure.message,
        retryable: run.infraFailure.retryable,
      }
      : null,
    artifacts: run.artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      sizeBytes: artifact.sizeBytes,
      expiresAt: artifact.expiresAt,
      url: artifactDownloadPath(ownedAgentId, run.runId, artifact.id),
    })),
    cancellable: run.cancellable,
  };
}

function artifactResponse(
  artifact: ComputeLaunchArtifactDownload,
  artifactId: string,
): Response {
  const safeType = /^[!#$&^_.+\-A-Za-z0-9]+\/[!#$&^_.+\-A-Za-z0-9]+$/
      .test(artifact.contentType)
    ? artifact.contentType
    : 'application/octet-stream';
  const trimmedName = artifact.fileName.trim();
  const safeName = trimmedName && trimmedName.length <= 240 &&
      !/[\u0000-\u001f\u007f/\\]/u.test(trimmedName)
    ? trimmedName
    : `artifact-${artifactId}`;
  const headers = new Headers({
    'Content-Type': safeType,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Cache-Control': 'private, no-store',
    'Vary': 'Cookie, Authorization',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
  });
  if (
    artifact.contentLength !== null &&
    Number.isSafeInteger(artifact.contentLength) && artifact.contentLength >= 0
  ) {
    headers.set('Content-Length', String(artifact.contentLength));
  }
  return new Response(artifact.body, { status: 200, headers });
}

async function requireAccountSession(
  request: Request,
  authenticateRequest: (
    request: Request,
  ) => Promise<{ id: string; authSource?: string }>,
): Promise<{ id: string; authSource?: string }> {
  let user: { id: string; authSource?: string };
  try {
    user = await authenticateRequest(request);
  } catch {
    throw new ComputeLaunchServiceError({
      code: 'AUTHENTICATION_REQUIRED',
      status: 401,
      message: 'Authentication required',
    });
  }
  if (!isAccountSessionAuthSource(user.authSource)) {
    throw new ComputeLaunchServiceError({
      code: 'ACCOUNT_SESSION_REQUIRED',
      status: 403,
      message: 'Compute management requires an account session',
    });
  }
  return user;
}

async function requireOwnedAgent(
  service: ComputeLaunchService,
  userId: string,
  encodedLocator: string,
): Promise<ComputeLaunchAgentReference> {
  const agent = await service.resolveAgent(
    decodeLocator(encodedLocator),
    userId,
  );
  if (!agent || agent.ownerUserId !== userId) {
    throw new ComputeLaunchServiceError({
      code: 'AGENT_NOT_FOUND',
      status: 404,
      message: 'Agent not found',
    });
  }
  if (!UUID_PATTERN.test(agent.id)) {
    throw new ComputeLaunchServiceError({
      code: 'COMPUTE_SERVICE_INVALID_RESPONSE',
      status: 503,
      message: 'Compute management is temporarily unavailable',
    });
  }
  return agent;
}

export async function handleLaunchComputeRoute(
  request: Request,
  path: string,
  dependencies: ComputeLaunchHandlerDependencies = {},
): Promise<Response> {
  if (!isLaunchComputePath(path)) {
    return failure('NOT_FOUND', 'Launch endpoint not found', 404);
  }
  try {
    const authenticateRequest = dependencies.authenticate ??
      (async (value) => await authenticate(value) as { id: string; authSource?: string });
    const user = await requireAccountSession(request, authenticateRequest);
    const service = dependencies.service ?? installedComputeLaunchService;
    if (!service) {
      throw new ComputeLaunchServiceError({
        code: 'COMPUTE_SERVICE_UNAVAILABLE',
        status: 503,
        message: 'Compute management is temporarily unavailable',
      });
    }
    const settingsMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/compute\/settings$/,
    );
    const runsMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/compute\/runs$/,
    );
    const cancelMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/compute\/runs\/([^/]+)\/cancel$/,
    );
    const artifactMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/compute\/runs\/([^/]+)\/artifacts\/([^/]+)$/,
    );
    const encodedLocator = settingsMatch?.[1] ?? runsMatch?.[1] ??
      cancelMatch?.[1] ?? artifactMatch?.[1];
    if (!encodedLocator) {
      return failure('NOT_FOUND', 'Launch endpoint not found', 404);
    }
    const agent = await requireOwnedAgent(service, user.id, encodedLocator);
    const url = new URL(request.url);
    const generatedAt = (dependencies.now ?? (() => new Date()))()
      .toISOString();

    if (settingsMatch) {
      onlyQuery(url, []);
      if (request.method !== 'GET' && request.method !== 'PUT') {
        return failure(
          'METHOD_NOT_ALLOWED',
          'Method not allowed for Compute settings',
          405,
          'GET, PUT',
        );
      }
      if (request.method === 'GET') {
        return privateJson({
          ...projectSettings(
            await service.getSettings({
              userId: user.id,
              agentId: agent.id,
            }),
          ),
          generatedAt,
        });
      }
      const mutation = parseSettingsMutation(await readBody(request));
      const current = await service.getSettings({
        userId: user.id,
        agentId: agent.id,
      });
      enforceManifestCeiling(mutation, current);
      const updated = await service.putSettings({
        userId: user.id,
        agentId: agent.id,
        mutation,
      });
      return privateJson({ ...projectSettings(updated), generatedAt });
    }

    if (runsMatch) {
      if (request.method !== 'GET') {
        return failure(
          'METHOD_NOT_ALLOWED',
          'Method not allowed for Compute runs',
          405,
          'GET',
        );
      }
      const page = parseRunPage(url);
      const result = await service.listRuns({
        userId: user.id,
        agentId: agent.id,
        ...page,
      });
      return privateJson({
        runs: result.runs.map((run) => projectRun(run, agent.id)),
        next_cursor: result.nextCursor,
        generatedAt,
      });
    }

    if (artifactMatch) {
      onlyQuery(url, []);
      if (request.method !== 'GET') {
        return failure(
          'METHOD_NOT_ALLOWED',
          'Method not allowed for Compute artifact download',
          405,
          'GET',
        );
      }
      let runId = '';
      let artifactId = '';
      try {
        runId = decodeURIComponent(artifactMatch[2]).trim();
        artifactId = decodeURIComponent(artifactMatch[3]).trim();
      } catch {
        // Rejected below.
      }
      if (!UUID_PATTERN.test(runId)) {
        invalid('INVALID_RUN_ID', 'Invalid Compute run id');
      }
      if (!UUID_PATTERN.test(artifactId)) {
        invalid('INVALID_ARTIFACT_ID', 'Invalid Compute artifact id');
      }
      return artifactResponse(
        await service.downloadArtifact({
          userId: user.id,
          agentId: agent.id,
          runId,
          artifactId,
        }),
        artifactId,
      );
    }

    onlyQuery(url, []);
    if (request.method !== 'POST') {
      return failure(
        'METHOD_NOT_ALLOWED',
        'Method not allowed for Compute run cancellation',
        405,
        'POST',
      );
    }
    let runId = '';
    try {
      runId = decodeURIComponent(cancelMatch![2]).trim();
    } catch {
      // Rejected below.
    }
    if (!UUID_PATTERN.test(runId)) {
      invalid('INVALID_RUN_ID', 'Invalid Compute run id');
    }
    const cancelBody = await readBody(request);
    onlyKeys(cancelBody, [], 'cancellation');
    return privateJson(
      projectRun(
        await service.cancelRun({
          userId: user.id,
          agentId: agent.id,
          runId,
        }),
        agent.id,
      ),
    );
  } catch (error) {
    if (error instanceof ComputeLaunchServiceError) {
      return mappedServiceFailure(error);
    }
    // Service failures can carry provider/R2 details. Keep the HTTP/logging
    // boundary opaque; the adapter should emit separately redacted telemetry.
    console.error('[LAUNCH COMPUTE] Unexpected internal failure');
    return failure(
      'COMPUTE_LAUNCH_FAILED',
      'Compute launch request failed',
      500,
    );
  }
}
