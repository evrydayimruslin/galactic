#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACTOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const VERSION_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CANARY_ENTRY = new RegExp(
  `^${ACTOR_UUID.source.slice(1, -1)}\/${ACTOR_UUID.source.slice(1, -1)}$`,
  'u',
);
const CODE_ETAG_MAX_LENGTH = 256;
const POLICY_BINDING_NAMES = new Set([
  'COMPUTE_ENABLED',
  'COMPUTE_ENVIRONMENT_DIGEST',
  'COMPUTE_ROLLOUT_MODE',
  'COMPUTE_CANARY_ALLOWLIST',
  'COMPUTE_CERTIFICATION_PRINCIPAL',
]);
const PHASES = new Set([
  'captured',
  'fenced',
  'inspected',
  'promoted',
  'revalidated',
  'reverted',
  'uploaded',
]);
const POLICIES = new Set(['off', 'canary', 'global']);
const API_NOT_YET_DEPLOYED_PHASES = new Set(['revalidated', 'uploaded']);
const SOURCE_REQUIRED_PHASES = new Set([
  'promoted',
  'revalidated',
  'uploaded',
]);
const SOURCE_FORBIDDEN_PHASES = new Set(['captured', 'inspected']);
const FENCEABLE_PHASES = new Set([
  'captured',
  'fenced',
  'inspected',
  'promoted',
  'reverted',
]);
const LEGAL_UPLOAD_TRANSITIONS = new Set([
  'captured:off->canary',
  'inspected:canary->global',
  'inspected:canary->off',
  'inspected:global->off',
]);

const TARGETS = Object.freeze({
  production: Object.freeze({
    apiWorker: 'ultralight-api',
    computeWorker: 'galactic-compute',
    computeQueue: 'galactic-compute',
    artifactBucket: 'galactic-compute-artifacts',
    sessionWorker: 'galactic-gx-test-session',
  }),
  staging: Object.freeze({
    apiWorker: 'ultralight-api-staging',
    computeWorker: 'galactic-compute-staging',
    computeQueue: 'galactic-compute-staging',
    artifactBucket: 'galactic-compute-artifacts-staging',
    sessionWorker: 'galactic-gx-test-session-staging',
  }),
});

const STATE_KEYS = [
  'api',
  'canary_allowlist',
  'certification_principal',
  'compute',
  'dispatch',
  'environment_digest',
  'kind',
  'phase',
  'policy',
  'schema_version',
  'source_api_version_id',
  'target',
  'verified',
];
const WORKER_STATE_KEYS = [
  'code_etag',
  'compatibility_sha256',
  'deployment_id',
  'version_id',
  'version_tag',
  'worker',
];
const DISPATCH_KEYS = [
  'git_sha',
  'repository',
  'run_attempt',
  'workflow_run_id',
];

function fail(message) {
  throw new Error(`API Compute rollout state is invalid: ${message}`);
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const row = record(value, label);
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
  return row;
}

function targetState(target) {
  const selected = TARGETS[target];
  if (!selected) fail(`unsupported target ${String(target)}`);
  return selected;
}

function versionUuid(value, label) {
  if (typeof value !== 'string' || !VERSION_UUID.test(value)) {
    fail(`${label} is not a canonical version UUID`);
  }
  return value;
}

function versionTag(value, label) {
  if (typeof value !== 'string' || !VERSION_TAG.test(value)) {
    fail(`${label} is malformed`);
  }
  return value;
}

function digest(value, label) {
  if (
    typeof value !== 'string' || !DIGEST.test(value) || value === ZERO_DIGEST
  ) {
    fail(`${label} is not a canonical sha256 digest`);
  }
  return value;
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if ((codePoint >= 0 && codePoint <= 31) || codePoint === 127) return true;
  }
  return false;
}

function codeEtag(version, label) {
  const value = version?.resources?.script?.etag;
  if (
    typeof value !== 'string' || value.length < 1 ||
    value.length > CODE_ETAG_MAX_LENGTH || containsControlCharacter(value)
  ) {
    fail(`${label} code ETag is unavailable or malformed`);
  }
  return value;
}

function canonicalValue(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalValue(entry, `${label}[${index}]`));
  }
  if (typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      output[key] = canonicalValue(value[key], `${label}.${key}`);
    }
    return output;
  }
  fail(`${label} contains an unsupported value`);
}

function hashCanonical(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value, 'compatibility')), 'utf8')
    .digest('hex');
}

function bindingList(version, label) {
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings)) fail(`${label} bindings are unavailable`);
  const names = [];
  for (const binding of bindings) {
    const row = record(binding, `${label} binding`);
    if (typeof row.name !== 'string' || row.name.length < 1) {
      fail(`${label} contains a binding without a name`);
    }
    names.push(row.name);
  }
  if (new Set(names).size !== names.length) {
    fail(`${label} contains duplicate binding names`);
  }
  return bindings;
}

function exactBinding(version, name, type, label) {
  const matches = bindingList(version, label).filter((binding) => binding?.name === name);
  if (matches.length !== 1 || matches[0]?.type !== type) {
    fail(`${label} must contain exactly one ${name} ${type} binding`);
  }
  return matches[0];
}

function plainValue(version, name, label) {
  const binding = exactBinding(version, name, 'plain_text', label);
  if (typeof binding.text !== 'string') {
    fail(`${label} ${name} value is unavailable`);
  }
  return binding.text;
}

function optionalPlainValue(version, name, label) {
  const matches = bindingList(version, label).filter((binding) =>
    binding?.name === name
  );
  if (matches.length === 0) return { present: false, value: null };
  if (matches.length !== 1 || matches[0]?.type !== 'plain_text' ||
    typeof matches[0]?.text !== 'string') {
    fail(`${label} must contain at most one ${name} plain_text binding`);
  }
  return { present: true, value: matches[0].text };
}

function normalizedCanaryAllowlist(value, { allowUnknown = false } = {}) {
  if (value === '') return [];
  if (typeof value !== 'string') fail('canary allowlist is not a string');
  const entries = value.split(',');
  if (
    entries.length !== 1 || entries.some((entry) => !CANARY_ENTRY.test(entry)) ||
    new Set(entries).size !== entries.length
  ) {
    fail('canary policy must contain exactly one canonical owner/Agent pair');
  }
  if (!allowUnknown && entries[0] !== value) {
    fail('canary allowlist is not canonical');
  }
  return entries;
}

function normalizedCertificationPrincipal(value) {
  if (value === '' || value === null) return null;
  if (typeof value !== 'string' || !CANARY_ENTRY.test(value)) {
    fail('certification principal is not one canonical owner/Agent pair');
  }
  return value;
}

function policyForVersion(version, label) {
  const enabled = plainValue(version, 'COMPUTE_ENABLED', label);
  const environmentDigest = digest(
    plainValue(version, 'COMPUTE_ENVIRONMENT_DIGEST', label),
    `${label} Compute environment digest`,
  );
  const rolloutMode = plainValue(version, 'COMPUTE_ROLLOUT_MODE', label);
  const rawAllowlist = plainValue(
    version,
    'COMPUTE_CANARY_ALLOWLIST',
    label,
  );
  const principalBinding = optionalPlainValue(
    version,
    'COMPUTE_CERTIFICATION_PRINCIPAL',
    label,
  );
  const certificationPrincipal = normalizedCertificationPrincipal(
    principalBinding.value,
  );

  if (
    enabled === '0' && rolloutMode === 'canary' && rawAllowlist === '' &&
    certificationPrincipal === null
  ) {
    return {
      policy: 'off',
      canaryAllowlist: [],
      certificationPrincipal,
      certificationBindingPresent: principalBinding.present,
      environmentDigest,
    };
  }
  if (
    enabled === '1' && rolloutMode === 'global' && rawAllowlist === '' &&
    certificationPrincipal !== null
  ) {
    return {
      policy: 'global',
      canaryAllowlist: [],
      certificationPrincipal,
      certificationBindingPresent: principalBinding.present,
      environmentDigest,
    };
  }
  if (enabled === '1' && rolloutMode === 'canary') {
    const canaryAllowlist = normalizedCanaryAllowlist(rawAllowlist, {
      allowUnknown: true,
    });
    if (certificationPrincipal !== canaryAllowlist[0]) {
      fail('canary certification principal must equal its admission allowlist');
    }
    return {
      policy: 'canary',
      canaryAllowlist,
      certificationPrincipal,
      certificationBindingPresent: principalBinding.present,
      environmentDigest,
    };
  }
  fail(`${label} does not carry a canonical OFF, canary, or global policy`);
}

function expectedPolicy(
  policy,
  rawCanaryAllowlist,
  rawCertificationPrincipal = '',
) {
  if (!POLICIES.has(policy)) fail(`unsupported policy ${String(policy)}`);
  const canaryAllowlist = normalizedCanaryAllowlist(rawCanaryAllowlist);
  const certificationPrincipal = normalizedCertificationPrincipal(
    rawCertificationPrincipal,
  );
  if (policy === 'canary' && canaryAllowlist.length !== 1) {
    fail('enabled canary policy requires one owner/Agent pair');
  }
  if (policy !== 'canary' && canaryAllowlist.length !== 0) {
    fail(`${policy} policy requires an empty canary allowlist`);
  }
  if (policy === 'off' && certificationPrincipal !== null) {
    fail('off policy requires an empty certification principal');
  }
  if (policy !== 'off' && certificationPrincipal === null) {
    fail(`${policy} policy requires one certification principal`);
  }
  if (
    policy === 'canary' && certificationPrincipal !== canaryAllowlist[0]
  ) {
    fail('canary certification principal must equal its admission allowlist');
  }
  return { policy, canaryAllowlist, certificationPrincipal };
}

function assertExpectedPolicy(actual, expected, label) {
  if (
    actual.policy !== expected.policy ||
    JSON.stringify(actual.canaryAllowlist) !==
      JSON.stringify(expected.canaryAllowlist) ||
    actual.certificationPrincipal !== expected.certificationPrincipal
  ) {
    fail(`${label} policy does not match the requested ${expected.policy} state`);
  }
}

function normalizeScriptRuntime(version, label) {
  const runtime = record(
    version?.resources?.script_runtime,
    `${label} script runtime`,
  );
  const exports = record(runtime.exports, `${label} script exports`);
  const gxSession = record(
    exports.GxTestSession,
    `${label} GxTestSession export`,
  );
  if (
    gxSession.type !== 'durable-object' || gxSession.storage !== 'sqlite' ||
    ![undefined, 'created'].includes(gxSession.state) ||
    [
      'container',
      'limits',
      'transfer_from',
      'renamed_from',
      'renamed_to',
      'transferred_to',
    ].some((key) => gxSession[key] !== undefined)
  ) {
    fail(`${label} does not retain the source-owned SQLite GxTestSession export`);
  }
  const normalized = canonicalValue(runtime, `${label} script runtime`);
  normalized.exports.GxTestSession.state = 'created';
  return normalized;
}

function sortedBindings(version, label, excludedNames = new Set()) {
  return bindingList(version, label)
    .filter((binding) => !excludedNames.has(binding.name))
    .map((binding) => canonicalValue(binding, `${label} binding`))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
}

function normalizedResources(
  version,
  label,
  { excludedBindingNames = new Set(), normalizeApiRuntime = false } = {},
) {
  const resources = record(version?.resources, `${label} resources`);
  const normalized = {};
  for (const key of Object.keys(resources).sort()) {
    if (key === 'bindings') {
      normalized.bindings = sortedBindings(
        version,
        label,
        excludedBindingNames,
      );
    } else if (key === 'script_runtime' && normalizeApiRuntime) {
      normalized.script_runtime = normalizeScriptRuntime(version, label);
    } else {
      normalized[key] = canonicalValue(
        resources[key],
        `${label} resources.${key}`,
      );
    }
  }
  if (!Object.hasOwn(normalized, 'bindings')) {
    fail(`${label} resources do not contain bindings`);
  }
  if (!Object.hasOwn(normalized, 'script')) {
    fail(`${label} resources do not contain script metadata`);
  }
  if (!Object.hasOwn(normalized, 'script_runtime')) {
    fail(`${label} resources do not contain script runtime metadata`);
  }
  return normalized;
}

function apiCompatibility(version, target, label) {
  const expected = targetState(target);
  const plane = exactBinding(version, 'COMPUTE_PLANE', 'service', label);
  if (
    plane.service !== expected.computeWorker || plane.entrypoint !== 'ComputePlane'
  ) fail(`${label} COMPUTE_PLANE binding does not match ${target}`);
  const queue = exactBinding(version, 'COMPUTE_QUEUE', 'queue', label);
  if (queue.queue_name !== expected.computeQueue) {
    fail(`${label} COMPUTE_QUEUE binding does not match ${target}`);
  }
  const artifacts = exactBinding(
    version,
    'COMPUTE_ARTIFACTS',
    'r2_bucket',
    label,
  );
  if (artifacts.bucket_name !== expected.artifactBucket) {
    fail(`${label} COMPUTE_ARTIFACTS binding does not match ${target}`);
  }
  const session = exactBinding(
    version,
    'GX_TEST_SESSION',
    'durable_object_namespace',
    label,
  );
  if (
    session.class_name !== 'GxTestSession' ||
    session.script_name !== expected.sessionWorker
  ) fail(`${label} GX_TEST_SESSION binding does not match ${target}`);

  return hashCanonical({
    resources: normalizedResources(version, label, {
      excludedBindingNames: POLICY_BINDING_NAMES,
      normalizeApiRuntime: true,
    }),
  });
}

function computeCompatibility(version, target, label) {
  const expected = targetState(target);
  const controlPlane = exactBinding(
    version,
    'CONTROL_PLANE',
    'service',
    label,
  );
  if (
    controlPlane.service !== expected.apiWorker ||
    controlPlane.entrypoint !== 'ComputeControlPlane'
  ) fail(`${label} CONTROL_PLANE binding does not match ${target}`);
  const artifacts = exactBinding(
    version,
    'COMPUTE_ARTIFACTS',
    'r2_bucket',
    label,
  );
  if (artifacts.bucket_name !== expected.artifactBucket) {
    fail(`${label} COMPUTE_ARTIFACTS binding does not match ${target}`);
  }
  return hashCanonical({
    resources: normalizedResources(version, label),
  });
}

function stableDeployment(
  status,
  label,
  { expectedVersionId = null, expectedDeploymentId = null } = {},
) {
  const row = record(status, `${label} deployment status`);
  const deploymentId = versionUuid(row.id, `${label} deployment id`);
  const versions = row.versions;
  if (!Array.isArray(versions) || versions.length !== 1) {
    fail(`${label} deployment must contain exactly one version`);
  }
  const versionId = versionUuid(
    versions[0]?.version_id,
    `${label} deployed version id`,
  );
  if (Number(versions[0]?.percentage) !== 100) {
    fail(`${label} deployment version is not at exactly 100% traffic`);
  }
  if (expectedVersionId !== null && versionId !== expectedVersionId) {
    fail(`${label} deployment version changed`);
  }
  if (
    expectedDeploymentId !== null && deploymentId !== expectedDeploymentId
  ) fail(`${label} deployment id changed`);
  return { deploymentId, versionId };
}

export function verifyWranglerVersionDeployOutput({
  content,
  expectedWorker,
  expectedEnvironment,
  expectedVersionId,
}) {
  if (
    typeof content !== 'string' ||
    typeof expectedWorker !== 'string' || expectedWorker.length === 0 ||
    typeof expectedEnvironment !== 'string'
  ) fail('Wrangler version-deploy output arguments are malformed');
  versionUuid(expectedVersionId, 'deployed API version id');

  const lines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  let records;
  try {
    records = lines.map((line) => JSON.parse(line));
  } catch {
    fail('Wrangler version-deploy output is not valid NDJSON');
  }
  if (
    records.length !== 2 ||
    records.some((entry) => entry === null || typeof entry !== 'object' || Array.isArray(entry))
  ) {
    fail(
      'Wrangler must emit exactly one session record and one version-deploy record',
    );
  }

  const [session, deployment] = records;
  const args = session.command_line_args;
  const indexes = (flag) =>
    Array.isArray(args) ? args.flatMap((entry, index) => entry === flag ? [index] : []) : [];
  const envIndexes = indexes('--env');
  const nameIndexes = indexes('--name');
  if (
    session.type !== 'wrangler-session' || session.version !== 1 ||
    typeof session.wrangler_version !== 'string' ||
    session.wrangler_version.length === 0 ||
    !Array.isArray(args) || !args.every((entry) => typeof entry === 'string') ||
    args[0] !== 'versions' || args[1] !== 'deploy' ||
    args[2] !== `${expectedVersionId}@100%` ||
    args.filter((entry) => entry === `${expectedVersionId}@100%`).length !== 1 ||
    envIndexes.length !== 1 ||
    args[envIndexes[0] + 1] !== expectedEnvironment ||
    nameIndexes.length !== 1 || args[nameIndexes[0] + 1] !== expectedWorker ||
    indexes('--yes').length !== 1 || indexes('--dry-run').length !== 0 ||
    typeof session.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(session.timestamp))
  ) fail('Wrangler session record does not describe the exact versions deploy');

  if (
    deployment.type !== 'version-deploy' || deployment.version !== 1 ||
    deployment.worker_name !== expectedWorker ||
    ![null, 'string'].includes(
      deployment.worker_tag === null ? null : typeof deployment.worker_tag,
    ) ||
    (typeof deployment.worker_tag === 'string' &&
      deployment.worker_tag.length === 0) ||
    deployment.version_traffic === null ||
    typeof deployment.version_traffic !== 'object' ||
    Array.isArray(deployment.version_traffic) ||
    Object.keys(deployment.version_traffic).length !== 0 ||
    typeof deployment.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(deployment.timestamp))
  ) fail('Wrangler version-deploy record does not match the reviewed command');

  return versionUuid(deployment.deployment_id, 'Wrangler deployment id');
}

function verifyVersionIdentity(version, expectedId, expectedTag, label) {
  const row = record(version, `${label} version detail`);
  if (row.id !== expectedId) fail(`${label} detail does not match ${expectedId}`);
  const tag = versionTag(row?.annotations?.['workers/tag'], `${label} tag`);
  if (expectedTag !== null && tag !== expectedTag) {
    fail(`${label} tag does not match ${expectedTag}`);
  }
  return tag;
}

export function rolloutDispatchFromEnv(env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  const workflowRunId = env.GITHUB_RUN_ID;
  const runAttempt = env.GITHUB_RUN_ATTEMPT;
  const gitSha = env.GITHUB_SHA;
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) {
    fail('GITHUB_REPOSITORY is malformed');
  }
  if (typeof workflowRunId !== 'string' || !POSITIVE_INTEGER.test(workflowRunId)) {
    fail('GITHUB_RUN_ID is malformed');
  }
  if (typeof runAttempt !== 'string' || !POSITIVE_INTEGER.test(runAttempt)) {
    fail('GITHUB_RUN_ATTEMPT is malformed');
  }
  if (typeof gitSha !== 'string' || !GIT_SHA.test(gitSha)) {
    fail('GITHUB_SHA is malformed');
  }
  return {
    repository,
    workflow_run_id: workflowRunId,
    run_attempt: runAttempt,
    git_sha: gitSha,
  };
}

function validateDispatch(value) {
  const row = exactKeys(value, DISPATCH_KEYS, 'rollout dispatch');
  return rolloutDispatchFromEnv({
    GITHUB_REPOSITORY: row.repository,
    GITHUB_RUN_ID: row.workflow_run_id,
    GITHUB_RUN_ATTEMPT: row.run_attempt,
    GITHUB_SHA: row.git_sha,
  });
}

function sameDispatch(left, right) {
  return DISPATCH_KEYS.every((key) => left[key] === right[key]);
}

function workerState({
  worker,
  versionId,
  versionTag: tag,
  deploymentId,
  codeEtag: etag,
  compatibilitySha256,
}) {
  return {
    worker,
    version_id: versionId,
    version_tag: tag,
    deployment_id: deploymentId,
    code_etag: etag,
    compatibility_sha256: compatibilitySha256,
  };
}

function stateResult({
  phase,
  target,
  policy,
  canaryAllowlist,
  certificationPrincipal,
  environmentDigest,
  dispatch,
  api,
  compute,
  sourceApiVersionId = null,
}) {
  if (!PHASES.has(phase)) fail(`unsupported phase ${String(phase)}`);
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_state',
    verified: true,
    phase,
    target,
    policy,
    canary_allowlist: [...canaryAllowlist],
    certification_principal: certificationPrincipal,
    environment_digest: environmentDigest,
    dispatch,
    api,
    compute,
    source_api_version_id: sourceApiVersionId,
  };
}

function validateWorkerState(value, expectedWorker, label, allowNoDeployment) {
  const row = exactKeys(value, WORKER_STATE_KEYS, label);
  if (row.worker !== expectedWorker) fail(`${label} worker is incorrect`);
  versionUuid(row.version_id, `${label} version id`);
  versionTag(row.version_tag, `${label} version tag`);
  if (row.deployment_id === null) {
    if (!allowNoDeployment) fail(`${label} deployment id is missing`);
  } else {
    versionUuid(row.deployment_id, `${label} deployment id`);
  }
  if (
    typeof row.code_etag !== 'string' || row.code_etag.length < 1 ||
    row.code_etag.length > CODE_ETAG_MAX_LENGTH ||
    containsControlCharacter(row.code_etag)
  ) fail(`${label} code ETag is malformed`);
  if (
    typeof row.compatibility_sha256 !== 'string' ||
    !HEX_SHA256.test(row.compatibility_sha256)
  ) fail(`${label} compatibility digest is malformed`);
  return row;
}

export function validateRolloutState(value) {
  const row = exactKeys(value, STATE_KEYS, 'rollout state');
  if (
    row.schema_version !== 1 ||
    row.kind !== 'galactic_compute_rollout_state' ||
    row.verified !== true || !PHASES.has(row.phase) ||
    !POLICIES.has(row.policy)
  ) fail('rollout state metadata is invalid');
  const target = targetState(row.target);
  const expected = expectedPolicy(
    row.policy,
    Array.isArray(row.canary_allowlist) ? row.canary_allowlist.join(',') : null,
    row.certification_principal,
  );
  if (
    !Array.isArray(row.canary_allowlist) ||
    JSON.stringify(row.canary_allowlist) !==
      JSON.stringify(expected.canaryAllowlist) ||
    row.certification_principal !== expected.certificationPrincipal
  ) fail('rollout state canary allowlist is malformed');
  digest(row.environment_digest, 'rollout state environment digest');
  const dispatch = validateDispatch(row.dispatch);
  const allowNoApiDeployment = row.phase === 'uploaded' ||
    row.phase === 'revalidated';
  const api = validateWorkerState(
    row.api,
    target.apiWorker,
    'rollout API state',
    allowNoApiDeployment,
  );
  const compute = validateWorkerState(
    row.compute,
    target.computeWorker,
    'rollout Compute state',
    false,
  );
  if (
    row.source_api_version_id !== null &&
    !VERSION_UUID.test(row.source_api_version_id)
  ) fail('rollout source API version id is malformed');
  const apiMustBeUndeployed = API_NOT_YET_DEPLOYED_PHASES.has(row.phase);
  if ((api.deployment_id === null) !== apiMustBeUndeployed) {
    fail(`rollout ${row.phase} API deployment state is invalid`);
  }
  if (
    SOURCE_REQUIRED_PHASES.has(row.phase) &&
    row.source_api_version_id === null
  ) fail(`rollout ${row.phase} source API version id is required`);
  if (
    SOURCE_FORBIDDEN_PHASES.has(row.phase) &&
    row.source_api_version_id !== null
  ) fail(`rollout ${row.phase} source API version id must be empty`);
  if (row.source_api_version_id === api.version_id) {
    fail('rollout source and candidate API version ids must be distinct');
  }
  return { ...row, dispatch, api, compute };
}

export function verifyRolloutLivePair({
  target,
  phase,
  expectedPolicy: requestedPolicy = null,
  expectedCanaryAllowlist = null,
  expectedCertificationPrincipal = null,
  apiStatus,
  apiVersion,
  computeStatus,
  computeVersion,
  expectedApiTag = null,
  expectedApiVersionId = null,
  expectedComputeVersionId = null,
  expectedApiDeploymentId = null,
  expectedComputeDeploymentId = null,
  dispatch = rolloutDispatchFromEnv(),
}) {
  const names = targetState(target);
  if (!PHASES.has(phase) || ['uploaded', 'revalidated'].includes(phase)) {
    fail(`unsupported live phase ${String(phase)}`);
  }
  validateDispatch(dispatch);
  const apiDeployment = stableDeployment(apiStatus, 'API', {
    expectedVersionId: expectedApiVersionId,
    expectedDeploymentId: expectedApiDeploymentId,
  });
  const computeDeployment = stableDeployment(computeStatus, 'Compute', {
    expectedVersionId: expectedComputeVersionId,
    expectedDeploymentId: expectedComputeDeploymentId,
  });
  const apiTag = verifyVersionIdentity(
    apiVersion,
    apiDeployment.versionId,
    expectedApiTag,
    'API',
  );
  const computeTag = verifyVersionIdentity(
    computeVersion,
    computeDeployment.versionId,
    null,
    'Compute',
  );
  const actualPolicy = policyForVersion(apiVersion, 'API');
  if (requestedPolicy !== null) {
    assertExpectedPolicy(
      actualPolicy,
      expectedPolicy(
        requestedPolicy,
        expectedCanaryAllowlist ?? '',
        expectedCertificationPrincipal ??
          (requestedPolicy === 'off'
            ? ''
            : actualPolicy.certificationPrincipal ?? ''),
      ),
      'API',
    );
  }
  const computeDigest = digest(
    plainValue(
      computeVersion,
      'COMPUTE_ENVIRONMENT_DIGEST',
      'Compute',
    ),
    'Compute environment digest',
  );
  if (actualPolicy.environmentDigest !== computeDigest) {
    fail('API and Compute environment digests differ');
  }

  return stateResult({
    phase,
    target,
    policy: actualPolicy.policy,
    canaryAllowlist: actualPolicy.canaryAllowlist,
    certificationPrincipal: actualPolicy.certificationPrincipal,
    environmentDigest: computeDigest,
    dispatch,
    api: workerState({
      worker: names.apiWorker,
      versionId: apiDeployment.versionId,
      versionTag: apiTag,
      deploymentId: apiDeployment.deploymentId,
      codeEtag: codeEtag(apiVersion, 'API'),
      compatibilitySha256: apiCompatibility(apiVersion, target, 'API'),
    }),
    compute: workerState({
      worker: names.computeWorker,
      versionId: computeDeployment.versionId,
      versionTag: computeTag,
      deploymentId: computeDeployment.deploymentId,
      codeEtag: codeEtag(computeVersion, 'Compute'),
      compatibilitySha256: computeCompatibility(
        computeVersion,
        target,
        'Compute',
      ),
    }),
  });
}

export function verifyRolloutUploadedApi({
  target,
  baselineState,
  uploadedVersion,
  expectedVersionId,
  expectedVersionTag,
  expectedPolicy: requestedPolicy,
  expectedCanaryAllowlist = '',
  expectedCertificationPrincipal = '',
  dispatch = rolloutDispatchFromEnv(),
}) {
  const names = targetState(target);
  const baseline = validateRolloutState(baselineState);
  const currentDispatch = validateDispatch(dispatch);
  if (baseline.target !== target) fail('upload baseline target changed');
  if (!sameDispatch(baseline.dispatch, currentDispatch)) {
    fail('upload baseline was not captured in this workflow dispatch');
  }
  const requested = expectedPolicy(
    requestedPolicy,
    expectedCanaryAllowlist,
    expectedCertificationPrincipal,
  );
  const transition = `${baseline.phase}:${baseline.policy}->${requested.policy}`;
  if (!LEGAL_UPLOAD_TRANSITIONS.has(transition)) {
    fail(
      `upload transition ${baseline.phase} ${baseline.policy}->${requested.policy} is not allowed`,
    );
  }
  versionUuid(expectedVersionId, 'uploaded API version id');
  versionTag(expectedVersionTag, 'uploaded API version tag');
  if (expectedVersionId === baseline.api.version_id) {
    fail('uploaded API version must be distinct from its baseline');
  }
  verifyVersionIdentity(
    uploadedVersion,
    expectedVersionId,
    expectedVersionTag,
    'uploaded API',
  );
  const actualPolicy = policyForVersion(uploadedVersion, 'uploaded API');
  assertExpectedPolicy(
    actualPolicy,
    requested,
    'uploaded API',
  );
  if (!actualPolicy.certificationBindingPresent) {
    fail('uploaded API is missing the certification principal binding');
  }
  if (actualPolicy.environmentDigest !== baseline.environment_digest) {
    fail('uploaded API changed the Compute environment digest');
  }
  const uploadedEtag = codeEtag(uploadedVersion, 'uploaded API');
  if (uploadedEtag !== baseline.api.code_etag) {
    fail('uploaded API changed Worker script bytes');
  }
  const compatibility = apiCompatibility(
    uploadedVersion,
    target,
    'uploaded API',
  );
  if (compatibility !== baseline.api.compatibility_sha256) {
    fail('uploaded API changed non-policy Worker resources');
  }

  return stateResult({
    phase: 'uploaded',
    target,
    policy: actualPolicy.policy,
    canaryAllowlist: actualPolicy.canaryAllowlist,
    certificationPrincipal: actualPolicy.certificationPrincipal,
    environmentDigest: baseline.environment_digest,
    dispatch: currentDispatch,
    api: workerState({
      worker: names.apiWorker,
      versionId: expectedVersionId,
      versionTag: expectedVersionTag,
      deploymentId: null,
      codeEtag: uploadedEtag,
      compatibilitySha256: compatibility,
    }),
    compute: baseline.compute,
    sourceApiVersionId: baseline.api.version_id,
  });
}

export function verifyRolloutPromotedPair({
  target,
  candidateState,
  apiStatus,
  apiVersion,
  computeStatus,
  computeVersion,
  expectedApiDeploymentId,
  phase = 'promoted',
  dispatch = rolloutDispatchFromEnv(),
}) {
  const candidate = validateRolloutState(candidateState);
  const currentDispatch = validateDispatch(dispatch);
  if (
    candidate.target !== target || candidate.phase !== 'uploaded' ||
    !sameDispatch(candidate.dispatch, currentDispatch)
  ) fail('promoted candidate is not an upload from this dispatch');
  const live = verifyRolloutLivePair({
    target,
    phase,
    expectedPolicy: candidate.policy,
    expectedCanaryAllowlist: candidate.canary_allowlist.join(','),
    expectedCertificationPrincipal: candidate.certification_principal,
    apiStatus,
    apiVersion,
    computeStatus,
    computeVersion,
    expectedApiTag: candidate.api.version_tag,
    expectedApiVersionId: candidate.api.version_id,
    expectedComputeVersionId: candidate.compute.version_id,
    expectedApiDeploymentId,
    expectedComputeDeploymentId: candidate.compute.deployment_id,
    dispatch: currentDispatch,
  });
  if (
    live.api.code_etag !== candidate.api.code_etag ||
    live.api.compatibility_sha256 !== candidate.api.compatibility_sha256 ||
    live.compute.version_tag !== candidate.compute.version_tag ||
    live.compute.code_etag !== candidate.compute.code_etag ||
    live.compute.compatibility_sha256 !==
      candidate.compute.compatibility_sha256
  ) fail('promoted API/Compute bytes or compatibility changed');
  return {
    ...live,
    source_api_version_id: candidate.source_api_version_id,
  };
}

export function verifyRolloutRevertedPair({
  target,
  anchorState,
  apiStatus,
  apiVersion,
  computeStatus,
  computeVersion,
  expectedApiDeploymentId,
  dispatch = rolloutDispatchFromEnv(),
}) {
  const anchor = validateRolloutState(anchorState);
  const currentDispatch = validateDispatch(dispatch);
  if (
    anchor.target !== target || anchor.policy !== 'off' ||
    !['captured', 'revalidated', 'uploaded'].includes(anchor.phase) ||
    !sameDispatch(anchor.dispatch, currentDispatch)
  ) fail('rollback anchor was not verified as OFF in this dispatch');
  const live = verifyRolloutLivePair({
    target,
    phase: 'reverted',
    expectedPolicy: 'off',
    expectedCanaryAllowlist: '',
    expectedCertificationPrincipal: '',
    apiStatus,
    apiVersion,
    computeStatus,
    computeVersion,
    expectedApiTag: anchor.api.version_tag,
    expectedApiVersionId: anchor.api.version_id,
    expectedComputeVersionId: anchor.compute.version_id,
    expectedApiDeploymentId,
    expectedComputeDeploymentId: anchor.compute.deployment_id,
    dispatch: currentDispatch,
  });
  if (
    live.environment_digest !== anchor.environment_digest ||
    live.api.code_etag !== anchor.api.code_etag ||
    live.api.compatibility_sha256 !== anchor.api.compatibility_sha256 ||
    live.compute.version_tag !== anchor.compute.version_tag ||
    live.compute.code_etag !== anchor.compute.code_etag ||
    live.compute.compatibility_sha256 !==
      anchor.compute.compatibility_sha256
  ) fail('reverted API/Compute state does not match the OFF anchor');
  return {
    ...live,
    source_api_version_id: anchor.source_api_version_id,
  };
}

export function verifyRolloutFencedState({
  expectedState,
  phase = 'fenced',
  apiStatus,
  apiVersion,
  computeStatus,
  computeVersion,
  dispatch = rolloutDispatchFromEnv(),
}) {
  const expected = validateRolloutState(expectedState);
  const currentDispatch = validateDispatch(dispatch);
  if (!FENCEABLE_PHASES.has(expected.phase)) {
    fail(`rollout ${expected.phase} state is not a live fence source`);
  }
  if (!sameDispatch(expected.dispatch, currentDispatch)) {
    fail('fenced state was not captured in this workflow dispatch');
  }
  const live = verifyRolloutLivePair({
    target: expected.target,
    phase,
    expectedPolicy: expected.policy,
    expectedCanaryAllowlist: expected.canary_allowlist.join(','),
    expectedCertificationPrincipal: expected.certification_principal,
    apiStatus,
    apiVersion,
    computeStatus,
    computeVersion,
    expectedApiTag: expected.api.version_tag,
    expectedApiVersionId: expected.api.version_id,
    expectedComputeVersionId: expected.compute.version_id,
    expectedApiDeploymentId: expected.api.deployment_id,
    expectedComputeDeploymentId: expected.compute.deployment_id,
    dispatch: currentDispatch,
  });
  if (
    live.environment_digest !== expected.environment_digest ||
    live.api.code_etag !== expected.api.code_etag ||
    live.api.compatibility_sha256 !== expected.api.compatibility_sha256 ||
    live.compute.version_tag !== expected.compute.version_tag ||
    live.compute.code_etag !== expected.compute.code_etag ||
    live.compute.compatibility_sha256 !==
      expected.compute.compatibility_sha256
  ) fail('fenced API/Compute state changed');
  return {
    ...live,
    source_api_version_id: expected.source_api_version_id,
  };
}

export function verifyRolloutRevalidatedOffAnchor({
  priorAnchorState,
  currentState,
  offApiVersion,
  dispatch = rolloutDispatchFromEnv(),
}) {
  const prior = validateRolloutState(priorAnchorState);
  const current = validateRolloutState(currentState);
  const currentDispatch = validateDispatch(dispatch);
  if (
    prior.policy !== 'off' ||
    !['captured', 'revalidated'].includes(prior.phase)
  ) fail('rollback anchor is not a captured admission-OFF state');
  if (!sameDispatch(prior.dispatch, currentDispatch)) {
    fail('rollback anchor was not captured in this workflow dispatch');
  }
  if (current.phase !== 'fenced') {
    fail('current rollout state is not the just-fenced live state');
  }
  if (prior.target !== current.target) fail('rollback anchor target changed');
  if (!sameDispatch(current.dispatch, currentDispatch)) {
    fail('current state was not fenced in this dispatch');
  }
  if (!['canary', 'global'].includes(current.policy)) {
    fail('current fenced rollout is not admission-enabled');
  }
  if (current.source_api_version_id !== prior.api.version_id) {
    fail('current fenced rollout does not descend from the rollback anchor');
  }
  verifyVersionIdentity(
    offApiVersion,
    prior.api.version_id,
    prior.api.version_tag,
    'rollback API',
  );
  const policy = policyForVersion(offApiVersion, 'rollback API');
  assertExpectedPolicy(policy, expectedPolicy('off', ''), 'rollback API');
  if (
    policy.environmentDigest !== current.environment_digest ||
    policy.environmentDigest !== prior.environment_digest ||
    codeEtag(offApiVersion, 'rollback API') !== prior.api.code_etag ||
    apiCompatibility(offApiVersion, prior.target, 'rollback API') !==
      prior.api.compatibility_sha256 ||
    current.api.code_etag !== prior.api.code_etag ||
    current.api.compatibility_sha256 !== prior.api.compatibility_sha256 ||
    current.compute.version_id !== prior.compute.version_id ||
    current.compute.version_tag !== prior.compute.version_tag ||
    current.compute.deployment_id !== prior.compute.deployment_id ||
    current.compute.code_etag !== prior.compute.code_etag ||
    current.compute.compatibility_sha256 !==
      prior.compute.compatibility_sha256
  ) fail('rollback anchor is incompatible with the current API/Compute pair');

  return stateResult({
    phase: 'revalidated',
    target: prior.target,
    policy: 'off',
    canaryAllowlist: [],
    certificationPrincipal: null,
    environmentDigest: prior.environment_digest,
    dispatch: currentDispatch,
    api: { ...prior.api, deployment_id: null },
    compute: current.compute,
    sourceApiVersionId: current.api.version_id,
  });
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch {
    fail(`${label} is missing or not valid JSON`);
  }
}

function readText(path, label) {
  try {
    return readFileSync(resolve(path), 'utf8');
  } catch {
    fail(`${label} is missing or unreadable`);
  }
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
  return value;
}

export function main(argv, env = process.env) {
  const [mode] = argv;
  if (mode === 'deploy-output' && argv.length === 5) {
    return print({
      deployment_id: verifyWranglerVersionDeployOutput({
        content: readText(argv[1], 'Wrangler version-deploy output'),
        expectedWorker: argv[2],
        expectedEnvironment: argv[3],
        expectedVersionId: argv[4],
      }),
    });
  }
  const dispatch = rolloutDispatchFromEnv(env);
  if (mode === 'capture-off' && argv.length === 7) {
    return print(verifyRolloutLivePair({
      target: argv[1],
      phase: 'captured',
      expectedPolicy: 'off',
      expectedCanaryAllowlist: '',
      apiStatus: readJson(argv[2], 'API deployment status'),
      apiVersion: readJson(argv[3], 'API version detail'),
      computeStatus: readJson(argv[4], 'Compute deployment status'),
      computeVersion: readJson(argv[5], 'Compute version detail'),
      expectedApiTag: argv[6],
      dispatch,
    }));
  }
  if (mode === 'inspect' && argv.length === 6) {
    return print(verifyRolloutLivePair({
      target: argv[1],
      phase: 'inspected',
      apiStatus: readJson(argv[2], 'API deployment status'),
      apiVersion: readJson(argv[3], 'API version detail'),
      computeStatus: readJson(argv[4], 'Compute deployment status'),
      computeVersion: readJson(argv[5], 'Compute version detail'),
      dispatch,
    }));
  }
  if (mode === 'uploaded' && argv.length === 9) {
    return print(verifyRolloutUploadedApi({
      target: argv[1],
      expectedPolicy: argv[2],
      expectedCanaryAllowlist: argv[3] === '-' ? '' : argv[3],
      expectedCertificationPrincipal: argv[4] === '-' ? '' : argv[4],
      baselineState: readJson(argv[5], 'rollout baseline state'),
      uploadedVersion: readJson(argv[6], 'uploaded API version detail'),
      expectedVersionId: argv[7],
      expectedVersionTag: argv[8],
      dispatch,
    }));
  }
  if (mode === 'promoted' && argv.length === 8) {
    return print(verifyRolloutPromotedPair({
      target: argv[1],
      candidateState: readJson(argv[2], 'uploaded candidate state'),
      apiStatus: readJson(argv[3], 'API deployment status'),
      apiVersion: readJson(argv[4], 'API version detail'),
      computeStatus: readJson(argv[5], 'Compute deployment status'),
      computeVersion: readJson(argv[6], 'Compute version detail'),
      expectedApiDeploymentId: argv[7],
      dispatch,
    }));
  }
  if (mode === 'fence' && argv.length === 6) {
    return print(verifyRolloutFencedState({
      expectedState: readJson(argv[1], 'expected rollout state'),
      phase: 'fenced',
      apiStatus: readJson(argv[2], 'API deployment status'),
      apiVersion: readJson(argv[3], 'API version detail'),
      computeStatus: readJson(argv[4], 'Compute deployment status'),
      computeVersion: readJson(argv[5], 'Compute version detail'),
      dispatch,
    }));
  }
  if (mode === 'revalidate-off' && argv.length === 4) {
    return print(verifyRolloutRevalidatedOffAnchor({
      priorAnchorState: readJson(argv[1], 'prior OFF anchor'),
      currentState: readJson(argv[2], 'current rollout state'),
      offApiVersion: readJson(argv[3], 'rollback API version'),
      dispatch,
    }));
  }
  if (mode === 'reverted' && argv.length === 8) {
    return print(verifyRolloutRevertedPair({
      target: argv[1],
      anchorState: readJson(argv[2], 'OFF rollback anchor'),
      apiStatus: readJson(argv[3], 'API deployment status'),
      apiVersion: readJson(argv[4], 'API version detail'),
      computeStatus: readJson(argv[5], 'Compute deployment status'),
      computeVersion: readJson(argv[6], 'Compute version detail'),
      expectedApiDeploymentId: argv[7],
      dispatch,
    }));
  }
  fail(
    'usage: verify-api-compute-rollout-state.mjs ' +
      'capture-off <target> <api-status> <api-version> <compute-status> ' +
      '<compute-version> <expected-api-tag> | ' +
      'deploy-output <ndjson> <worker> <environment> <version-id> | ' +
      'inspect <target> <api-status> <api-version> <compute-status> ' +
      '<compute-version> | uploaded <target> <off|canary|global> ' +
      '<allowlist|-> <certification-principal|-> <baseline-state> ' +
      '<uploaded-version> <version-id> <tag> | ' +
      'promoted <target> <candidate-state> <api-status> <api-version> ' +
      '<compute-status> <compute-version> <deployment-id> | ' +
      'fence <state> <api-status> <api-version> <compute-status> ' +
      '<compute-version> | revalidate-off <prior-anchor> <current-state> ' +
      '<off-api-version> | reverted <target> <anchor-state> <api-status> ' +
      '<api-version> <compute-status> <compute-version> <deployment-id>',
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
