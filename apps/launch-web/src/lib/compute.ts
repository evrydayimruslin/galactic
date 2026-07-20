import {
  COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS,
  COMPUTE_V1_MAX_ARTIFACT_BYTES,
} from '../../../../shared/contracts/compute.ts';

export { COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS, COMPUTE_V1_MAX_ARTIFACT_BYTES };
export const COMPUTE_PROFILE = 'developer-v1' as const;

export type LaunchComputeProfile = typeof COMPUTE_PROFILE;

export type LaunchComputeRunStatus =
  | 'queued'
  | 'reserving'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'settlement_pending';

export type LaunchComputeSecretDelivery =
  | { kind: 'env'; envName: string }
  | { kind: 'file'; path: string };

export type LaunchComputeAuthorityRule = {
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

export type LaunchComputeAuthorityRuleMutation = {
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

/**
 * Presence-only view. The control plane must never put a secret value in this
 * response, logs, error details, or browser state.
 */
export interface LaunchComputeSecretBindingSummary {
  name: string;
  delivery:
    | { kind: 'env'; envName: string }
    | { kind: 'file'; path: string };
  configured: boolean;
  version: string;
  updatedAt: string | null;
}

export interface LaunchComputeLimits {
  maxTimeoutMs: number;
  maxConcurrency: number;
  maxArtifactBytes: number;
  maxArtifacts: number;
}

export interface LaunchComputeManifestCeiling {
  enabled: boolean;
  profile: LaunchComputeProfile | null;
  tools: string[];
  secrets: string[];
}

export interface LaunchComputeSettings {
  enabled: boolean;
  profile: LaunchComputeProfile;
  allowedTools: string[];
  secretBindings: LaunchComputeSecretBindingSummary[];
  authorityRules: LaunchComputeAuthorityRule[];
  limits: LaunchComputeLimits;
  manifestCeiling: LaunchComputeManifestCeiling;
  ownerConfirmedAt: string | null;
  updatedAt: string | null;
}

export interface LaunchComputeSettingsResponse {
  settings: LaunchComputeSettings;
  revision: string;
  generatedAt: string;
}

export interface LaunchComputeSettingsUpdateRequest {
  expectedRevision: string;
  ownerConfirmed: true;
  settings: {
    enabled: boolean;
    profile: LaunchComputeProfile;
    allowedTools: string[];
    secretBindings: Array<{
      name: string;
      delivery:
        | { kind: 'env'; envName: string }
        | { kind: 'file'; path: string };
    }>;
    authorityRules: LaunchComputeAuthorityRuleMutation[];
    limits: LaunchComputeLimits;
  };
}

export interface LaunchComputeUsage {
  reserved: number;
  actual: number | null;
  trueUp: number | null;
  unit: string;
}

export interface LaunchComputeRunArtifact {
  id: string;
  name: string;
  sizeBytes: number;
  expiresAt: string;
  url: string | null;
}

export interface LaunchComputeRunSummary {
  runId: string;
  receiptId: string | null;
  receiptUrl: string | null;
  billingMode: 'wallet' | 'subscription_capacity';
  status: LaunchComputeRunStatus;
  agentId: string;
  agentName: string;
  functionName: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  usage: LaunchComputeUsage;
  exitCode: number | null;
  infraFailure: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  artifacts: LaunchComputeRunArtifact[];
  cancellable: boolean;
}

export interface LaunchComputeRunsResponse {
  runs: LaunchComputeRunSummary[];
  next_cursor?: string | null;
  generatedAt: string;
}

export interface ComputeSettingsDraft {
  enabled: boolean;
  profile: LaunchComputeProfile;
  allowedTools: string[];
  secretBindings: Array<{
    name: string;
    delivery: LaunchComputeSecretDelivery;
  }>;
  authorityRules: LaunchComputeAuthorityRule[];
  maxTimeoutMs: string;
  maxConcurrency: string;
  maxArtifactBytes: string;
  maxArtifacts: string;
}

function cloneAuthorityRule(
  rule: LaunchComputeAuthorityRule,
): LaunchComputeAuthorityRule {
  return rule.action === 'platform.call'
    ? { ...rule, target: { functionName: rule.target.functionName } }
    : {
      ...rule,
      target: {
        agentId: rule.target.agentId,
        functionName: rule.target.functionName,
      },
    };
}

function authorityRuleMutation(
  rule: LaunchComputeAuthorityRule,
): LaunchComputeAuthorityRuleMutation {
  return rule.action === 'platform.call'
    ? {
      callerFunction: rule.callerFunction,
      decision: rule.decision,
      action: 'platform.call',
      target: { functionName: rule.target.functionName },
    }
    : {
      callerFunction: rule.callerFunction,
      decision: rule.decision,
      action: 'agents.call',
      target: {
        agentId: rule.target.agentId,
        functionName: rule.target.functionName,
      },
    };
}

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SECRET_FILE_PREFIX = '/run/galactic/secrets/';
const FUNCTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u;
const PLATFORM_FUNCTION_PATTERN = /^(?:gx|ul)\.[A-Za-z][A-Za-z0-9_.:-]{0,126}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function computeSettingsDraft(
  settings: LaunchComputeSettings,
): ComputeSettingsDraft {
  return {
    enabled: settings.enabled,
    profile: settings.profile,
    allowedTools: [...settings.allowedTools],
    secretBindings: settings.secretBindings.map((binding) => ({
      name: binding.name,
      delivery: { ...binding.delivery },
    })),
    authorityRules: settings.authorityRules.map(cloneAuthorityRule),
    maxTimeoutMs: String(settings.limits.maxTimeoutMs),
    maxConcurrency: String(settings.limits.maxConcurrency),
    maxArtifactBytes: String(settings.limits.maxArtifactBytes),
    maxArtifacts: String(settings.limits.maxArtifacts),
  };
}

function positiveInteger(value: string, label: string): number | string {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return `${label} must be a positive whole number.`;
  }
  return parsed;
}

export function computeSettingsRequest(
  draft: ComputeSettingsDraft,
  ceiling: LaunchComputeManifestCeiling,
  expectedRevision: string,
): { request: LaunchComputeSettingsUpdateRequest | null; errors: string[] } {
  const errors: string[] = [];
  const allowedToolSet = new Set(ceiling.tools);
  const allowedSecretSet = new Set(ceiling.secrets);

  if (!/^(?:0|[1-9][0-9]*)$/u.test(expectedRevision)) {
    errors.push('Compute settings revision is unavailable.');
  }
  if (draft.profile !== COMPUTE_PROFILE) {
    errors.push(`Unsupported Compute profile: ${draft.profile}.`);
  }
  if (
    draft.enabled && (!ceiling.enabled || ceiling.profile !== draft.profile)
  ) {
    errors.push(
      'This Agent release does not authorize the selected Compute profile.',
    );
  }
  for (const tool of draft.allowedTools) {
    if (!allowedToolSet.has(tool)) {
      errors.push(
        `Tool “${tool}” is outside this Agent release's Compute ceiling.`,
      );
    }
  }

  const secretNames = new Set<string>();
  const destinations = new Set<string>();
  for (const binding of draft.secretBindings) {
    if (!allowedSecretSet.has(binding.name)) {
      errors.push(
        `Secret “${binding.name}” is not declared by this Agent release.`,
      );
    }
    if (secretNames.has(binding.name)) {
      errors.push(
        `Secret “${binding.name}” has more than one delivery mapping.`,
      );
    }
    secretNames.add(binding.name);

    if (binding.delivery.kind === 'env') {
      const envName = binding.delivery.envName.trim();
      if (
        !ENV_NAME_PATTERN.test(envName) ||
        ['GX_', 'GALACTIC_', 'ULTRALIGHT_'].some((prefix) => envName.startsWith(prefix))
      ) {
        errors.push(
          `Environment destination for “${binding.name}” is invalid.`,
        );
      }
      const destination = `env:${envName}`;
      if (destinations.has(destination)) {
        errors.push(
          `Environment destination “${envName}” is used more than once.`,
        );
      }
      destinations.add(destination);
    } else {
      const path = binding.delivery.path.trim();
      const relative = path.slice(SECRET_FILE_PREFIX.length);
      if (
        !path.startsWith(SECRET_FILE_PREFIX) || !relative ||
        relative.includes('/') || relative === '.' || relative === '..' ||
        relative.includes('\\') ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(relative) ||
        relative.toLowerCase().includes('job-token')
      ) {
        errors.push(
          `File destination for “${binding.name}” must be directly under ${SECRET_FILE_PREFIX}.`,
        );
      }
      const destination = `file:${path}`;
      if (destinations.has(destination)) {
        errors.push(`File destination “${path}” is used more than once.`);
      }
      destinations.add(destination);
    }
  }

  if (draft.authorityRules.length > 200) {
    errors.push('Compute authority supports at most 200 exact rules.');
  }
  const authorityTargets = new Set<string>();
  for (const rule of draft.authorityRules) {
    if (!FUNCTION_NAME_PATTERN.test(rule.callerFunction)) {
      errors.push(`Caller function “${rule.callerFunction}” is invalid.`);
    }
    if (
      rule.decision !== 'always' && rule.decision !== 'never'
    ) {
      errors.push('Authority decisions must be always or never.');
    }
    if (rule.action === 'platform.call') {
      if (!PLATFORM_FUNCTION_PATTERN.test(rule.target.functionName)) {
        errors.push(
          `Platform target “${rule.target.functionName}” must be one exact gx. or ul. prefixed function; wildcards are forbidden.`,
        );
      }
    } else if (rule.action === 'agents.call') {
      if (!UUID_PATTERN.test(rule.target.agentId)) {
        errors.push(
          `Target Agent “${rule.target.agentId}” must be an exact Agent UUID.`,
        );
      }
      if (!FUNCTION_NAME_PATTERN.test(rule.target.functionName)) {
        errors.push(
          `Agent target function “${rule.target.functionName}” must be one exact function.`,
        );
      }
    } else {
      errors.push('Authority actions must be platform.call or agents.call.');
      continue;
    }
    const targetKey = JSON.stringify([
      rule.callerFunction,
      rule.action,
      rule.target,
    ]);
    if (authorityTargets.has(targetKey)) {
      errors.push(
        `Authority target for caller “${rule.callerFunction}” is listed more than once.`,
      );
    }
    authorityTargets.add(targetKey);
  }

  const timeout = positiveInteger(draft.maxTimeoutMs, 'Maximum timeout');
  const concurrency = positiveInteger(
    draft.maxConcurrency,
    'Maximum concurrency',
  );
  const artifactBytes = positiveInteger(
    draft.maxArtifactBytes,
    'Maximum artifact bytes',
  );
  const artifacts = positiveInteger(draft.maxArtifacts, 'Maximum artifacts');
  for (const candidate of [timeout, concurrency, artifactBytes, artifacts]) {
    if (typeof candidate === 'string') errors.push(candidate);
  }
  if (
    typeof timeout === 'number' &&
    timeout > COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS
  ) {
    errors.push(
      `Maximum timeout cannot exceed ${COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS} ms in developer-v1.`,
    );
  }
  if (
    typeof artifactBytes === 'number' &&
    artifactBytes > COMPUTE_V1_MAX_ARTIFACT_BYTES
  ) {
    errors.push(
      `Maximum artifact bytes cannot exceed ${COMPUTE_V1_MAX_ARTIFACT_BYTES} in developer-v1.`,
    );
  }

  if (
    errors.length > 0 || typeof timeout === 'string' ||
    typeof concurrency === 'string' || typeof artifactBytes === 'string' ||
    typeof artifacts === 'string'
  ) {
    return { request: null, errors: [...new Set(errors)] };
  }

  return {
    errors: [],
    request: {
      expectedRevision,
      ownerConfirmed: true,
      settings: {
        enabled: draft.enabled,
        profile: draft.profile,
        allowedTools: [...new Set(draft.allowedTools)].sort(),
        secretBindings: draft.secretBindings.map((binding) => ({
          name: binding.name,
          delivery: binding.delivery.kind === 'env'
            ? { kind: 'env' as const, envName: binding.delivery.envName.trim() }
            : { kind: 'file' as const, path: binding.delivery.path.trim() },
        })).sort((left, right) => left.name.localeCompare(right.name)),
        authorityRules: draft.authorityRules.map(authorityRuleMutation).sort((
          left,
          right,
        ) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        limits: {
          maxTimeoutMs: timeout,
          maxConcurrency: concurrency,
          maxArtifactBytes: artifactBytes,
          maxArtifacts: artifacts,
        },
      },
    },
  };
}

export function isComputeEndpointUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  return status === 404 || status === 501 || code === 'compute_unavailable' ||
    code === 'compute_not_enabled';
}

export function isComputeRunActive(status: LaunchComputeRunStatus): boolean {
  return status === 'queued' || status === 'reserving' ||
    status === 'starting' ||
    status === 'running' || status === 'settlement_pending';
}

/**
 * Merge a refreshed or paginated run page into the history already rendered.
 * Incoming rows win so polling can advance active runs without discarding older
 * pages the owner explicitly loaded.
 */
export function mergeComputeRunHistory(
  current: LaunchComputeRunSummary[],
  incoming: LaunchComputeRunSummary[],
): LaunchComputeRunSummary[] {
  const byRunId = new Map(current.map((run) => [run.runId, run]));
  for (const run of incoming) byRunId.set(run.runId, run);
  return [...byRunId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      const timestampOrder = rightTime - leftTime;
      if (timestampOrder !== 0) return timestampOrder;
    } else if (Number.isFinite(leftTime)) {
      return -1;
    } else if (Number.isFinite(rightTime)) {
      return 1;
    }
    return right.runId.localeCompare(left.runId);
  });
}

export function computeRunDuration(
  run: LaunchComputeRunSummary,
): number | null {
  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt;
  if (!end) return null;
  const duration = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

/** Accept only same-origin paths or HTTPS links supplied by the control plane. */
export function safeComputeLink(value: string | null): string | null {
  if (!value) return null;
  if (
    value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
  ) {
    return value;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
