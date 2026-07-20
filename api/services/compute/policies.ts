import {
  authorityFromDatabaseValue,
  authorityToDatabaseValue,
  canonicalizeComputeAuthority,
  requireComputeCallerFunction,
  requireComputeUuid,
} from './authority.ts';
import {
  callComputeRpc,
  type ComputeDatabaseDeps,
  firstComputeRow,
  integerString,
  nullableString,
  queryComputeRows,
  requiredString,
} from './database.ts';
import type {
  ComputeAgentPolicy,
  ComputeAgentPolicyRule,
  ComputeAuthority,
  ComputeAuthorityDecision,
  ComputeSecretBinding,
} from './types.ts';
import { DEVELOPER_V1_TOOL_IDS } from './types.ts';
import {
  canonicalizeComputeAgentWideSecretBinding,
  type ComputeAgentWideSecretBindingInput,
  mapComputeSecretBindingRow,
} from './secrets.ts';
import { COMPUTE_V1_MAX_ARTIFACT_BYTES } from '../../../shared/contracts/compute.ts';

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function policyEpoch(value: string | number | bigint | undefined): string | null {
  if (value === undefined) return null;
  const normalized = String(value);
  if (!POSITIVE_INTEGER.test(normalized)) {
    throw new Error('expectedPolicyEpoch must be a positive integer');
  }
  return BigInt(normalized).toString();
}

function policyRevision(value: string | number | bigint): string {
  const normalized = String(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error('expectedRevision must be a non-negative integer');
  }
  return BigInt(normalized).toString();
}

function responseRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Replace Compute configuration returned invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

export interface ReplaceComputeAgentConfigurationInput {
  userId: string;
  agentId: string;
  enabled: boolean;
  allowedTools: string[];
  maxTimeoutMs: number;
  maxConcurrency: number;
  maxArtifactBytes: string | number | bigint;
  maxArtifacts: number;
  ownerConfirmedAt: string | null;
  /** Exact live uses_compute callers, supplied by the trusted manifest adapter. */
  callerFunctions: string[];
  authorityRules: Array<{
    callerFunction: string;
    decision: ComputeAuthorityDecision;
    authority: ComputeAuthority | unknown;
  }>;
  /** Agent-wide selections; SQL replicates them identically to every live caller. */
  secretBindings: ComputeAgentWideSecretBindingInput[] | unknown[];
  expectedRevision: string | number | bigint;
  expectedAuthorityEpoch: string | number | bigint;
}

export interface ReplacedComputeAgentConfiguration {
  policy: ComputeAgentPolicy;
  authorityRules: ComputeAgentPolicyRule[];
  secretBindings: ComputeSecretBinding[];
}

export async function replaceComputeAgentConfiguration(
  input: ReplaceComputeAgentConfigurationInput,
  deps: ComputeDatabaseDeps = {},
): Promise<ReplacedComputeAgentConfiguration> {
  if (typeof input.enabled !== 'boolean') throw new Error('enabled is required');
  const userId = requireComputeUuid(input.userId, 'userId');
  const agentId = requireComputeUuid(input.agentId, 'agentId');
  const tools = Array.from(new Set(input.allowedTools)).sort();
  if (
    tools.length < 1 || tools.length > 64 ||
    tools.some((tool) => !(DEVELOPER_V1_TOOL_IDS as readonly string[]).includes(tool))
  ) throw new Error('allowedTools must contain exact semantic tool IDs');
  const callerFunctions = Array.from(
    new Set(input.callerFunctions.map(requireComputeCallerFunction)),
  ).sort();
  if (callerFunctions.length !== input.callerFunctions.length || callerFunctions.length > 128) {
    throw new Error('callerFunctions must contain at most 128 unique exact names');
  }
  if (input.enabled && callerFunctions.length === 0) {
    throw new Error('enabled Compute requires at least one live caller function');
  }
  if (!Array.isArray(input.authorityRules) || input.authorityRules.length > 256) {
    throw new Error('authorityRules must contain at most 256 entries');
  }
  const ruleKeys = new Set<string>();
  const authorityRules = input.authorityRules.map((rule) => {
    const callerFunction = requireComputeCallerFunction(rule.callerFunction);
    if (!callerFunctions.includes(callerFunction)) {
      throw new Error('every authority rule must name a live Compute caller');
    }
    const decision = policyDecision(rule.decision);
    const authority = authorityToDatabaseValue(
      canonicalizeComputeAuthority(rule.authority),
    );
    const row = {
      caller_function: callerFunction,
      decision,
      ...authority,
    };
    const key = JSON.stringify([
      callerFunction,
      authority.action,
      authority.resource_kind,
      authority.target_agent_id,
      authority.target_function,
    ]);
    if (ruleKeys.has(key)) throw new Error('authorityRules contains a duplicate exact target');
    ruleKeys.add(key);
    return row;
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (!Array.isArray(input.secretBindings) || input.secretBindings.length > 50) {
    throw new Error('secretBindings must contain at most 50 entries');
  }
  if (callerFunctions.length === 0 && input.secretBindings.length > 0) {
    throw new Error('secretBindings require at least one live Compute caller');
  }
  const secretNames = new Set<string>();
  const secretDestinations = new Set<string>();
  const secretVariables = new Set<string>();
  const secretBindings = input.secretBindings.map((value) => {
    const binding = canonicalizeComputeAgentWideSecretBinding(value);
    if (secretNames.has(binding.name)) throw new Error('secret binding names must be unique');
    secretNames.add(binding.name);
    if (secretVariables.has(binding.variableName)) {
      throw new Error('one Agent Variable may have only one Compute delivery mapping');
    }
    secretVariables.add(binding.variableName);
    const destination = binding.delivery.kind === 'raw_env'
      ? `env:${binding.delivery.envName}`
      : `file:${binding.delivery.fileName}`;
    if (secretDestinations.has(destination)) {
      throw new Error('secret binding destinations must be unique');
    }
    secretDestinations.add(destination);
    return {
      name: binding.name,
      variable_name: binding.variableName,
      delivery: binding.delivery.kind,
      env_name: binding.delivery.kind === 'raw_env' ? binding.delivery.envName : null,
      file_name: binding.delivery.kind === 'raw_file' ? binding.delivery.fileName : null,
      expires_at: binding.expiresAt,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  let ownerConfirmedAt: string | null = null;
  if (input.ownerConfirmedAt !== null) {
    if (!Number.isFinite(Date.parse(input.ownerConfirmedAt))) {
      throw new Error('ownerConfirmedAt must be an ISO timestamp or null');
    }
    ownerConfirmedAt = new Date(input.ownerConfirmedAt).toISOString();
  }
  if (input.enabled && ownerConfirmedAt === null) {
    throw new Error('enabled Compute requires owner confirmation');
  }
  const maxArtifactBytes = String(input.maxArtifactBytes);
  if (
    !/^[1-9][0-9]*$/.test(maxArtifactBytes) ||
    BigInt(maxArtifactBytes) > BigInt(COMPUTE_V1_MAX_ARTIFACT_BYTES)
  ) {
    throw new Error('maxArtifactBytes must be a positive integer no greater than 1 GiB');
  }
  const payload = await callComputeRpc('replace_compute_agent_configuration', {
    p_user_id: userId,
    p_agent_id: agentId,
    p_enabled: input.enabled,
    p_allowed_tools: tools,
    p_max_timeout_ms: positiveNumber(input.maxTimeoutMs, 'maxTimeoutMs'),
    p_max_concurrency: positiveNumber(input.maxConcurrency, 'maxConcurrency'),
    p_max_artifact_bytes: maxArtifactBytes,
    p_max_artifacts: positiveNumber(input.maxArtifacts, 'maxArtifacts'),
    p_owner_confirmed_at: ownerConfirmedAt,
    p_caller_functions: callerFunctions,
    p_authority_rules: authorityRules,
    p_secret_bindings: secretBindings,
    p_expected_revision: policyRevision(input.expectedRevision),
    p_expected_authority_epoch: policyRevision(input.expectedAuthorityEpoch),
  }, deps);
  const row = firstComputeRow(payload, 'Replace Compute configuration');
  const policy = mapPolicy(responseRecord(row.policy, 'policy'));
  const rules = Array.isArray(row.authority_rules)
    ? row.authority_rules.map((value) =>
      mapPolicyRule(responseRecord(value, 'authority rule'), policy.authorityEpoch)
    )
    : [];
  const bindings = Array.isArray(row.secret_bindings)
    ? row.secret_bindings.map((value) =>
      mapComputeSecretBindingRow(responseRecord(value, 'secret binding'))
    )
    : [];
  return { policy, authorityRules: rules, secretBindings: bindings };
}

function policyDecision(value: unknown): ComputeAuthorityDecision {
  if (value === 'always' || value === 'never') {
    return value;
  }
  throw new Error('decision must be always or never');
}

function mapPolicyRule(
  row: Record<string, unknown>,
  policyEpochOverride?: string,
): ComputeAgentPolicyRule {
  const operation = 'Compute Agent policy';
  return {
    id: requiredString(row, 'id', operation),
    userId: requiredString(row, 'user_id', operation),
    agentId: requiredString(row, 'agent_id', operation),
    callerFunction: requiredString(row, 'caller_function', operation),
    decision: policyDecision(row.decision),
    authority: authorityFromDatabaseValue(row),
    ruleVersion: integerString(row, 'rule_version', operation),
    authorityEpoch: policyEpochOverride ??
      integerString(row, 'authority_epoch', operation),
    createdAt: requiredString(row, 'created_at', operation),
    updatedAt: requiredString(row, 'updated_at', operation),
  };
}

export async function putComputeAgentPolicyRule(input: {
  userId: string;
  agentId: string;
  callerFunction: string;
  decision: ComputeAuthorityDecision;
  authority: ComputeAuthority | unknown;
  expectedAuthorityEpoch?: string | number | bigint;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeAgentPolicyRule> {
  const userId = requireComputeUuid(input.userId, 'userId');
  const agentId = requireComputeUuid(input.agentId, 'agentId');
  const callerFunction = requireComputeCallerFunction(input.callerFunction);
  const decision = policyDecision(input.decision);
  const authority = authorityToDatabaseValue(
    canonicalizeComputeAuthority(input.authority),
  );
  const payload = await callComputeRpc('put_compute_agent_authority_rule', {
    p_user_id: userId,
    p_agent_id: agentId,
    p_caller_function: callerFunction,
    p_decision: decision,
    p_action: authority.action,
    p_resource_kind: authority.resource_kind,
    p_target_agent_id: authority.target_agent_id,
    p_target_function: authority.target_function,
    p_constraints: authority.constraints,
    p_expected_authority_epoch: policyEpoch(input.expectedAuthorityEpoch),
  }, deps);
  return mapPolicyRule(firstComputeRow(payload, 'Put Compute Agent policy'));
}

export async function listComputeAgentPolicyRules(input: {
  userId: string;
  agentId: string;
  callerFunction?: string;
  includeRevoked?: boolean;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeAgentPolicyRule[]> {
  const userId = requireComputeUuid(input.userId, 'userId');
  const agentId = requireComputeUuid(input.agentId, 'agentId');
  const policy = await getComputeAgentPolicy({ userId, agentId }, deps);
  if (!policy) return [];
  const filters = [
    `user_id=eq.${encodeURIComponent(userId)}`,
    `agent_id=eq.${encodeURIComponent(agentId)}`,
    'select=*',
    'order=caller_function.asc,action.asc,created_at.asc',
  ];
  if (input.callerFunction !== undefined) {
    filters.push(
      `caller_function=eq.${
        encodeURIComponent(requireComputeCallerFunction(input.callerFunction))
      }`,
    );
  }
  if (!input.includeRevoked) filters.push('status=eq.active');
  const rows = await queryComputeRows(
    `compute_agent_authority_rules?${filters.join('&')}`,
    deps,
  );
  return rows.map((row) => mapPolicyRule(row, policy.authorityEpoch));
}

function mapPolicy(row: Record<string, unknown>): ComputeAgentPolicy {
  const operation = 'Compute Agent policy';
  const profile = requiredString(row, 'profile', operation);
  if (profile !== 'developer-v1') {
    throw new Error('Compute Agent policy returned an unsupported profile');
  }
  const state = requiredString(row, 'state', operation);
  if (state !== 'active' && state !== 'paused' && state !== 'revoked') {
    throw new Error('Compute Agent policy returned an invalid state');
  }
  return {
    userId: requiredString(row, 'user_id', operation),
    agentId: requiredString(row, 'agent_id', operation),
    enabled: row.enabled === true,
    profile,
    state,
    allowedTools: stringArray(row.allowed_tools, 'allowed_tools'),
    maxTimeoutMs: positiveNumber(row.max_timeout_ms, 'max_timeout_ms'),
    maxConcurrency: positiveNumber(row.max_concurrency, 'max_concurrency'),
    maxArtifactBytes: integerString(row, 'max_artifact_bytes', operation),
    maxArtifacts: positiveNumber(row.max_artifacts, 'max_artifacts'),
    authorityEpoch: integerString(row, 'authority_epoch', operation),
    revision: integerString(row, 'revision', operation),
    ownerConfirmedAt: nullableString(row, 'owner_confirmed_at'),
    createdAt: requiredString(row, 'created_at', operation),
    updatedAt: requiredString(row, 'updated_at', operation),
  };
}

function positiveNumber(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Compute Agent policy returned invalid ${field}`);
  }
  return number;
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) || value.length < 1 ||
    value.some((entry) => typeof entry !== 'string' || !entry)
  ) throw new Error(`Compute Agent policy returned invalid ${field}`);
  return value as string[];
}

export async function putComputeAgentPolicySettings(input: {
  userId: string;
  agentId: string;
  enabled: boolean;
  allowedTools: string[];
  maxTimeoutMs: number;
  maxConcurrency: number;
  maxArtifactBytes: string | number | bigint;
  maxArtifacts: number;
  ownerConfirmedAt: string | null;
  expectedRevision: string | number | bigint;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeAgentPolicy> {
  if (typeof input.enabled !== 'boolean') throw new Error('enabled is required');
  const tools = Array.from(new Set(input.allowedTools)).sort();
  if (
    tools.length < 1 || tools.length > 64 ||
    tools.some((tool) => !(DEVELOPER_V1_TOOL_IDS as readonly string[]).includes(tool))
  ) throw new Error('allowedTools must contain exact semantic tool IDs');
  const maxTimeoutMs = positiveNumber(input.maxTimeoutMs, 'maxTimeoutMs');
  const maxConcurrency = positiveNumber(input.maxConcurrency, 'maxConcurrency');
  const maxArtifacts = positiveNumber(input.maxArtifacts, 'maxArtifacts');
  const maxArtifactBytes = String(input.maxArtifactBytes);
  if (
    !/^[1-9][0-9]*$/.test(maxArtifactBytes) ||
    BigInt(maxArtifactBytes) > BigInt(COMPUTE_V1_MAX_ARTIFACT_BYTES)
  ) {
    throw new Error('maxArtifactBytes must be a positive integer no greater than 1 GiB');
  }
  let ownerConfirmedAt: string | null = null;
  if (input.ownerConfirmedAt !== null) {
    if (!Number.isFinite(Date.parse(input.ownerConfirmedAt))) {
      throw new Error('ownerConfirmedAt must be an ISO timestamp or null');
    }
    ownerConfirmedAt = new Date(input.ownerConfirmedAt).toISOString();
  }
  if (input.enabled && ownerConfirmedAt === null) {
    throw new Error('enabled Compute requires owner confirmation');
  }
  const payload = await callComputeRpc('put_compute_agent_policy_settings', {
    p_user_id: requireComputeUuid(input.userId, 'userId'),
    p_agent_id: requireComputeUuid(input.agentId, 'agentId'),
    p_enabled: input.enabled,
    p_allowed_tools: tools,
    p_max_timeout_ms: maxTimeoutMs,
    p_max_concurrency: maxConcurrency,
    p_max_artifact_bytes: maxArtifactBytes,
    p_max_artifacts: maxArtifacts,
    p_owner_confirmed_at: ownerConfirmedAt,
    p_expected_revision: policyRevision(input.expectedRevision),
  }, deps);
  return mapPolicy(firstComputeRow(payload, 'Put Compute Agent settings'));
}

export async function getComputeAgentPolicy(input: {
  userId: string;
  agentId: string;
}, deps: ComputeDatabaseDeps = {}): Promise<ComputeAgentPolicy | null> {
  const userId = requireComputeUuid(input.userId, 'userId');
  const agentId = requireComputeUuid(input.agentId, 'agentId');
  const rows = await queryComputeRows(
    `compute_agent_policies?user_id=eq.${encodeURIComponent(userId)}` +
      `&agent_id=eq.${encodeURIComponent(agentId)}&select=*&limit=1`,
    deps,
  );
  return rows[0] ? mapPolicy(rows[0]) : null;
}

export async function setComputeAgentPolicyState(input: {
  userId: string;
  agentId: string;
  state: 'active' | 'paused' | 'revoked';
  expectedAuthorityEpoch: string | number | bigint;
}, deps: ComputeDatabaseDeps = {}): Promise<{
  state: 'active' | 'paused' | 'revoked';
  authorityEpoch: string;
}> {
  if (
    input.state !== 'active' && input.state !== 'paused' &&
    input.state !== 'revoked'
  ) throw new Error('invalid Compute Agent policy state');
  const payload = await callComputeRpc('set_compute_agent_policy_state', {
    p_user_id: requireComputeUuid(input.userId, 'userId'),
    p_agent_id: requireComputeUuid(input.agentId, 'agentId'),
    p_state: input.state,
    p_expected_authority_epoch: policyEpoch(input.expectedAuthorityEpoch),
  }, deps);
  const row = firstComputeRow(payload, 'Set Compute Agent policy state');
  const state = requiredString(
    row,
    'state',
    'Set Compute Agent policy state',
  );
  if (state !== 'active' && state !== 'paused' && state !== 'revoked') {
    throw new Error('Compute Agent policy returned an invalid state');
  }
  return {
    state,
    authorityEpoch: integerString(
      row,
      'authority_epoch',
      'Set Compute Agent policy state',
    ),
  };
}
