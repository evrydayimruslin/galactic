#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateRolloutState } from './verify-api-compute-rollout-state.mjs';

const GIT_SHA = /^[0-9a-f]{40}$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const NONNEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const WORKFLOW_PATH = '.github/workflows/compute-canary-rollout.yml';
const ROLLOUT_KIND = 'galactic_compute_canary_rollout';
const VERIFICATION_KIND = 'galactic_compute_rollout_predecessor_verification';

const TARGETS = Object.freeze({
  staging: Object.freeze({ computeWorker: 'galactic-compute-staging' }),
  production: Object.freeze({ computeWorker: 'galactic-compute' }),
});

const STAGES = Object.freeze({
  staging_canary: Object.freeze({
    target: 'staging',
    policy: 'canary',
    phase: 'fenced',
    canaryIdentity: true,
    admittedSmoke: true,
    predecessor: null,
    soakRequired: false,
  }),
  production_canary: Object.freeze({
    target: 'production',
    policy: 'canary',
    phase: 'fenced',
    canaryIdentity: true,
    admittedSmoke: true,
    predecessor: 'staging_canary',
    soakRequired: true,
  }),
  production_global: Object.freeze({
    target: 'production',
    policy: 'global',
    phase: 'fenced',
    canaryIdentity: false,
    admittedSmoke: true,
    predecessor: 'production_canary',
    soakRequired: false,
  }),
  revert_off: Object.freeze({
    target: null,
    policy: 'off',
    phase: 'fenced',
    canaryIdentity: false,
    admittedSmoke: false,
    predecessor: 'optional_same_target_enabled',
    soakRequired: false,
  }),
});

const DISPATCH_KEYS = [
  'git_sha',
  'repository',
  'run_attempt',
  'workflow_run_id',
];
const REFERENCE_KEYS = ['evidence_file', 'sha256'];
const ROLLOUT_KEYS = [
  'active_state',
  'admitted_smoke',
  'api_upload_source_sha',
  'canary_identity',
  'compute_release',
  'dispatch',
  'generated_at',
  'kind',
  'outcome',
  'predecessor',
  'rollback_anchor',
  'schema_version',
  'soak_eligible_at',
  'stage',
  'target',
  'verified',
];
const VERIFICATION_KEYS = [
  'dispatch',
  'final_state',
  'kind',
  'minimum_age_seconds',
  'predecessor',
  'schema_version',
  'verified',
  'verified_at',
];
const PREDECESSOR_KEYS = [
  'artifact_created_at',
  'artifact_id',
  'artifact_name',
  'generated_at',
  'soak_eligible_at',
  'stage',
  'target',
];

function fail(message) {
  throw new Error(`Compute rollout predecessor is invalid: ${message}`);
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expectedKeys, label) {
  const row = record(value, label);
  const actual = Object.keys(row).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
  return row;
}

function readBytes(path, label) {
  try {
    return readFileSync(path);
  } catch {
    fail(`${label} is missing or unreadable`);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is missing or is not valid JSON`);
  }
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function timestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const normalized = Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  const expected = typeof value === 'string' && !value.includes('.')
    ? normalized.replace('.000Z', 'Z')
    : normalized;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(parsed) ||
    expected !== value
  ) {
    fail(`${label} is not a canonical UTC timestamp`);
  }
  return parsed;
}

function positiveIntegerValue(value, label) {
  if (
    !(
      (typeof value === 'string' && POSITIVE_INTEGER.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    )
  ) {
    fail(`${label} is not a positive integer`);
  }
  return String(value);
}

function nonnegativeIntegerValue(value, label) {
  if (
    !(
      (typeof value === 'string' && NONNEGATIVE_INTEGER.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    )
  ) {
    fail(`${label} is not a nonnegative integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail(`${label} exceeds the safe range`);
  return number;
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    fail(`${label} is not a canonical UUID`);
  }
  return value;
}

function canonicalDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value) || value === ZERO_DIGEST) {
    fail(`${label} is not a nonzero immutable digest`);
  }
  return value;
}

function stageContract(stage, target) {
  const contract = STAGES[stage];
  if (!contract) fail('expected stage is unsupported');
  if (!TARGETS[target]) fail('expected target must be staging or production');
  if (contract.target !== null && contract.target !== target) {
    fail(`${stage} must target ${contract.target}`);
  }
  return contract;
}

function dispatchRecord(value, label) {
  const dispatch = exactKeys(value, DISPATCH_KEYS, label);
  if (
    typeof dispatch.repository !== 'string' ||
    !REPOSITORY.test(dispatch.repository) ||
    typeof dispatch.workflow_run_id !== 'string' ||
    !POSITIVE_INTEGER.test(dispatch.workflow_run_id) ||
    typeof dispatch.run_attempt !== 'string' ||
    !POSITIVE_INTEGER.test(dispatch.run_attempt) ||
    typeof dispatch.git_sha !== 'string' ||
    !GIT_SHA.test(dispatch.git_sha)
  ) {
    fail(`${label} is malformed`);
  }
  return dispatch;
}

function sameDispatch(left, right) {
  return DISPATCH_KEYS.every((key) => left[key] === right[key]);
}

function sameRepositoryAndSha(left, right) {
  return left.repository === right.repository && left.git_sha === right.git_sha;
}

function workflowDispatch({ run, expectedRunId, currentGitSha }) {
  const workflowRun = record(run, 'workflow run');
  const runId = positiveIntegerValue(workflowRun.id, 'workflow run id');
  const runAttempt = positiveIntegerValue(
    workflowRun.run_attempt,
    'workflow run attempt',
  );
  const repository = record(workflowRun.repository, 'workflow repository');
  const headRepository = record(
    workflowRun.head_repository,
    'workflow head repository',
  );
  if (
    runId !== expectedRunId ||
    workflowRun.event !== 'workflow_dispatch' ||
    workflowRun.status !== 'completed' ||
    workflowRun.conclusion !== 'success' ||
    workflowRun.path !== WORKFLOW_PATH ||
    workflowRun.head_sha !== currentGitSha ||
    typeof workflowRun.head_branch !== 'string' ||
    workflowRun.head_branch.length === 0 ||
    typeof repository.full_name !== 'string' ||
    !REPOSITORY.test(repository.full_name) ||
    headRepository.full_name !== repository.full_name ||
    positiveIntegerValue(repository.id, 'workflow repository id') !==
      positiveIntegerValue(headRepository.id, 'workflow head repository id')
  ) {
    fail('workflow run is not the exact successful same-repository dispatch');
  }
  return {
    repository: repository.full_name,
    workflow_run_id: runId,
    run_attempt: runAttempt,
    git_sha: currentGitSha,
  };
}

function artifactForDispatch({
  artifactList,
  dispatch,
  stage,
  target,
  workflowRun,
  nowMs,
}) {
  const list = exactKeys(
    artifactList,
    ['artifacts', 'total_count'],
    'artifact list',
  );
  if (
    !Number.isSafeInteger(list.total_count) ||
    list.total_count < 0 ||
    !Array.isArray(list.artifacts) ||
    list.total_count < list.artifacts.length
  ) {
    fail('artifact list is malformed');
  }
  const expectedName =
    `compute-canary-rollout-${stage}-${target}-${dispatch.workflow_run_id}-${dispatch.run_attempt}`;
  const matches = list.artifacts.filter((artifact) =>
    record(artifact, 'workflow artifact').name === expectedName
  );
  if (matches.length !== 1) {
    fail('expected exactly one uniquely named predecessor artifact');
  }
  const artifact = matches[0];
  const artifactRun = exactKeys(
    artifact.workflow_run,
    [
      'head_branch',
      'head_repository_id',
      'head_sha',
      'id',
      'repository_id',
    ],
    'artifact workflow_run',
  );
  const artifactId = positiveIntegerValue(artifact.id, 'artifact id');
  const createdAt = timestamp(artifact.created_at, 'artifact created_at');
  const expiresAt = timestamp(artifact.expires_at, 'artifact expires_at');
  if (
    artifact.expired !== false ||
    expiresAt <= nowMs ||
    createdAt >= expiresAt ||
    positiveIntegerValue(artifactRun.id, 'artifact workflow run id') !==
      dispatch.workflow_run_id ||
    artifactRun.head_sha !== dispatch.git_sha ||
    artifactRun.head_branch !== workflowRun.head_branch ||
    positiveIntegerValue(
        artifactRun.repository_id,
        'artifact repository id',
      ) !== positiveIntegerValue(
        workflowRun.repository.id,
        'workflow repository id',
      ) ||
    positiveIntegerValue(
        artifactRun.head_repository_id,
        'artifact head repository id',
      ) !== positiveIntegerValue(
        workflowRun.head_repository.id,
        'workflow head repository id',
      )
  ) {
    fail('predecessor artifact is expired or belongs to another run');
  }
  return {
    artifactId,
    artifactName: expectedName,
    artifactCreatedAt: artifact.created_at,
    artifactCreatedAtMs: createdAt,
  };
}

function boundJson(
  evidenceDirectory,
  reference,
  expectedFile,
  label,
  referenceKeys = REFERENCE_KEYS,
) {
  const binding = exactKeys(reference, referenceKeys, `${label} reference`);
  if (
    binding.evidence_file !== expectedFile ||
    typeof binding.sha256 !== 'string' ||
    !HEX_SHA256.test(binding.sha256)
  ) {
    fail(`${label} reference is malformed`);
  }
  const path = resolve(evidenceDirectory, expectedFile);
  const bytes = readBytes(path, expectedFile);
  if (hashBytes(bytes) !== binding.sha256) {
    fail(`${label} bytes do not match rollout.json`);
  }
  try {
    return record(JSON.parse(bytes.toString('utf8')), expectedFile);
  } catch {
    fail(`${expectedFile} is not valid JSON`);
  }
}

function validateState(value, label) {
  try {
    return validateRolloutState(value);
  } catch {
    fail(`${label} is not a valid rollout state`);
  }
}

function validateStageFinalState(state, stage, target, dispatch, label) {
  const contract = stageContract(stage, target);
  const finalState = validateState(state, label);
  const finalDispatch = dispatchRecord(finalState.dispatch, `${label} dispatch`);
  if (
    finalState.target !== target ||
    finalState.policy !== contract.policy ||
    finalState.phase !== contract.phase ||
    !sameDispatch(finalDispatch, dispatch)
  ) {
    fail(`${label} does not match the stage, target, policy, and dispatch`);
  }
  canonicalDigest(finalState.environment_digest, `${label} environment digest`);
  if (
    contract.policy === 'canary' && finalState.canary_allowlist.length !== 1
  ) {
    fail(`${label} must carry one canary allowlist identity`);
  }
  if (
    contract.policy !== 'canary' && finalState.canary_allowlist.length !== 0
  ) {
    fail(`${label} must carry an empty canary allowlist`);
  }
  return finalState;
}

function validateRollbackAnchor(state, target, dispatch) {
  const anchor = validateState(state, 'rollback anchor');
  const anchorDispatch = dispatchRecord(anchor.dispatch, 'rollback anchor dispatch');
  if (
    anchor.target !== target ||
    anchor.policy !== 'off' ||
    !['captured', 'uploaded'].includes(anchor.phase) ||
    anchor.canary_allowlist.length !== 0 ||
    !sameDispatch(anchorDispatch, dispatch)
  ) {
    fail('rollback anchor is not the same-dispatch captured/uploaded OFF state');
  }
  canonicalDigest(anchor.environment_digest, 'rollback anchor environment digest');
  return anchor;
}

function assertPolicyOnlyTransition(anchor, finalState) {
  const expectedSource = anchor.phase === 'uploaded'
    ? anchor.source_api_version_id
    : finalState.policy === 'off'
    ? null
    : anchor.api.version_id;
  if (
    finalState.source_api_version_id !== expectedSource ||
    finalState.environment_digest !== anchor.environment_digest ||
    JSON.stringify(finalState.compute) !== JSON.stringify(anchor.compute) ||
    finalState.api.code_etag !== anchor.api.code_etag ||
    finalState.api.compatibility_sha256 !== anchor.api.compatibility_sha256
  ) {
    fail(
      'final state breaks rollback lineage or changes Compute/non-policy API compatibility',
    );
  }
}

function validateCanaryIdentity(identity, target, finalState) {
  const row = exactKeys(
    identity,
    [
      'agent_id',
      'allowlist_entry',
      'kind',
      'owner_id',
      'schema_version',
      'target',
    ],
    'canary-identity.json',
  );
  const ownerId = canonicalUuid(row.owner_id, 'canary owner id');
  const agentId = canonicalUuid(row.agent_id, 'canary Agent id');
  const allowlistEntry = `${ownerId}/${agentId}`;
  if (
    row.schema_version !== 1 ||
    row.kind !== 'galactic_compute_canary_identity' ||
    row.target !== target ||
    row.allowlist_entry !== allowlistEntry ||
    finalState.canary_allowlist.length !== 1 ||
    finalState.canary_allowlist[0] !== allowlistEntry
  ) {
    fail('canary identity does not match the exact final allowlist');
  }
  return row;
}

function validateAdmittedSmoke({ smoke, target, dispatch, identity, rolloutAt }) {
  const row = exactKeys(
    smoke,
    [
      'agent_id',
      'billing_mode',
      'candidate_sha',
      'compute_receipt_id',
      'compute_run_id',
      'function_name',
      'generated_at',
      'kind',
      'marker_sha256',
      'observed_states',
      'policy_cleanup',
      'result',
      'schema_version',
      'start_receipt_id',
      'status_receipt_id',
      'target',
      'timestamps',
      'usage',
      'verified',
      'workflow_run_id',
    ],
    'admitted smoke',
  );
  const result = exactKeys(
    row.result,
    [
      'artifact_count',
      'exit_code',
      'status',
      'stderr_bytes',
      'stdout_sha256',
    ],
    'admitted smoke result',
  );
  const cleanup = exactKeys(
    row.policy_cleanup,
    ['disabled', 'revision'],
    'admitted smoke cleanup',
  );
  const usage = exactKeys(
    row.usage,
    ['actual', 'reserved', 'trueUp', 'unit'],
    'admitted smoke usage',
  );
  const timestamps = exactKeys(
    row.timestamps,
    ['createdAt', 'finishedAt', 'startedAt'],
    'admitted smoke timestamps',
  );
  const agentId = canonicalUuid(row.agent_id, 'admitted smoke Agent id');
  for (
    const [value, label] of [
      [row.compute_run_id, 'admitted smoke Compute run id'],
      [row.compute_receipt_id, 'admitted smoke Compute receipt id'],
      [row.start_receipt_id, 'admitted smoke start receipt id'],
      [row.status_receipt_id, 'admitted smoke status receipt id'],
    ]
  ) canonicalUuid(value, label);
  const generatedAt = timestamp(row.generated_at, 'admitted smoke generated_at');
  const createdAt = timestamp(timestamps.createdAt, 'admitted smoke createdAt');
  const startedAt = timestamp(timestamps.startedAt, 'admitted smoke startedAt');
  const finishedAt = timestamp(timestamps.finishedAt, 'admitted smoke finishedAt');
  const marker =
    `galactic-compute-release-smoke-v1:${dispatch.git_sha}:${dispatch.workflow_run_id}\n`;
  const markerSha256 = createHash('sha256').update(marker).digest('hex');
  if (
    row.schema_version !== 1 ||
    row.kind !== 'galactic_compute_admitted_smoke' ||
    row.verified !== true ||
    row.target !== target ||
    row.candidate_sha !== dispatch.git_sha ||
    row.workflow_run_id !== dispatch.workflow_run_id ||
    row.function_name !== 'run_compute_smoke' ||
    (identity && agentId !== identity.agent_id) ||
    row.marker_sha256 !== markerSha256 ||
    !Array.isArray(row.observed_states) ||
    row.observed_states.length === 0 ||
    row.observed_states.at(-1) !== 'completed' ||
    !row.observed_states.every((state) => typeof state === 'string' && state.length > 0) ||
    typeof row.billing_mode !== 'string' ||
    row.billing_mode.length === 0 ||
    result.status !== 'completed' ||
    result.exit_code !== 0 ||
    result.stdout_sha256 !== markerSha256 ||
    result.stderr_bytes !== 0 ||
    result.artifact_count !== 0 ||
    cleanup.disabled !== true ||
    typeof cleanup.revision !== 'string' ||
    !NONNEGATIVE_INTEGER.test(cleanup.revision) ||
    ![usage.reserved, usage.actual, usage.trueUp].every(Number.isFinite) ||
    typeof usage.unit !== 'string' ||
    usage.unit.length === 0 ||
    Math.abs((usage.actual - usage.reserved) - usage.trueUp) > 1e-9 ||
    createdAt > startedAt ||
    startedAt > finishedAt ||
    generatedAt < finishedAt ||
    generatedAt > rolloutAt
  ) {
    fail('admitted smoke is not a clean terminal same-dispatch execution');
  }
  return row;
}

function validateComputeReleaseVerification({ verification, target, finalState }) {
  const row = exactKeys(
    verification,
    [
      'compute_version_id',
      'compute_version_tag',
      'deployed_image',
      'environment_digest',
      'release_sha',
      'schema_version',
      'target',
      'verified',
      'workflow_run_id',
    ],
    'compute release verification',
  );
  const digest = canonicalDigest(
    row.environment_digest,
    'compute release environment digest',
  );
  canonicalUuid(row.compute_version_id, 'compute release version id');
  const imageMatch = typeof row.deployed_image === 'string'
    ? row.deployed_image.match(
      /^registry\.cloudflare\.com\/([0-9a-f]{32})\/([a-z0-9-]+)@(sha256:[0-9a-f]{64})$/u,
    )
    : null;
  if (
    row.schema_version !== 1 ||
    row.verified !== true ||
    row.target !== target ||
    typeof row.release_sha !== 'string' ||
    !GIT_SHA.test(row.release_sha) ||
    typeof row.workflow_run_id !== 'string' ||
    !POSITIVE_INTEGER.test(row.workflow_run_id) ||
    row.compute_version_id !== finalState.compute.version_id ||
    row.compute_version_tag !== finalState.compute.version_tag ||
    digest !== finalState.environment_digest ||
    !imageMatch ||
    imageMatch[2] !== TARGETS[target].computeWorker ||
    imageMatch[3] !== digest
  ) {
    fail('compute release verification does not match the final Compute state');
  }
  return row;
}

function validateVerificationOutput(value, label) {
  const row = exactKeys(value, VERIFICATION_KEYS, label);
  const predecessor = exactKeys(
    row.predecessor,
    PREDECESSOR_KEYS,
    `${label} predecessor`,
  );
  const dispatch = dispatchRecord(row.dispatch, `${label} dispatch`);
  const contract = stageContract(predecessor.stage, predecessor.target);
  const generatedAt = timestamp(
    predecessor.generated_at,
    `${label} predecessor generated_at`,
  );
  const artifactCreatedAt = timestamp(
    predecessor.artifact_created_at,
    `${label} predecessor artifact_created_at`,
  );
  const verifiedAt = timestamp(row.verified_at, `${label} verified_at`);
  const minimumAgeSeconds = nonnegativeIntegerValue(
    row.minimum_age_seconds,
    `${label} minimum age`,
  );
  let soakEligibleAt = null;
  if (predecessor.soak_eligible_at !== null) {
    soakEligibleAt = timestamp(
      predecessor.soak_eligible_at,
      `${label} soak_eligible_at`,
    );
    if (soakEligibleAt < generatedAt) {
      fail(`${label} soak eligibility precedes predecessor generation`);
    }
  }
  if (
    row.schema_version !== 1 ||
    row.kind !== VERIFICATION_KIND ||
    row.verified !== true ||
    typeof predecessor.artifact_id !== 'string' ||
    !POSITIVE_INTEGER.test(predecessor.artifact_id) ||
    predecessor.artifact_name !==
      `compute-canary-rollout-${predecessor.stage}-${predecessor.target}-${dispatch.workflow_run_id}-${dispatch.run_attempt}` ||
    generatedAt > artifactCreatedAt ||
    generatedAt > verifiedAt ||
    (contract.soakRequired && soakEligibleAt === null) ||
    (predecessor.stage === 'production_canary' &&
      (verifiedAt - artifactCreatedAt < minimumAgeSeconds * 1_000 ||
        (minimumAgeSeconds > 0 && verifiedAt < soakEligibleAt)))
  ) {
    fail(`${label} does not prove a valid predecessor artifact`);
  }
  const finalState = validateStageFinalState(
    row.final_state,
    predecessor.stage,
    predecessor.target,
    dispatch,
    `${label} final state`,
  );
  return {
    row,
    predecessor,
    dispatch,
    finalState,
    verifiedAt,
  };
}

function validatePredecessorTransition({
  verification,
  stage,
  target,
  dispatch,
  rolloutAt,
}) {
  const prior = validateVerificationOutput(
    verification,
    'predecessor-verification.json',
  );
  if (
    !sameRepositoryAndSha(prior.dispatch, dispatch) ||
    prior.verifiedAt > rolloutAt
  ) {
    fail('predecessor verification does not belong to this release lineage');
  }
  if (stage === 'production_canary') {
    if (
      prior.predecessor.stage !== 'staging_canary' ||
      prior.predecessor.target !== 'staging'
    ) fail('production_canary must consume staging_canary');
    return prior;
  }
  if (stage === 'production_global') {
    if (
      prior.predecessor.stage !== 'production_canary' ||
      prior.predecessor.target !== 'production'
    ) fail('production_global must consume production_canary');
    return prior;
  }
  if (stage === 'revert_off') {
    const allowed = target === 'staging'
      ? ['staging_canary']
      : ['production_canary', 'production_global'];
    if (
      prior.predecessor.target !== target ||
      !allowed.includes(prior.predecessor.stage)
    ) {
      fail('revert_off must consume a same-target canary or global predecessor');
    }
    return prior;
  }
  fail(`${stage} must not contain predecessor verification`);
}

export function verifyComputeRolloutPredecessor({
  evidenceDirectory,
  runJsonPath,
  artifactListJsonPath,
  expectedRunId,
  expectedStage,
  expectedTarget,
  currentGitSha,
  minimumAgeSeconds,
  nowMs = Date.now(),
}) {
  if (typeof evidenceDirectory !== 'string' || evidenceDirectory.length === 0) {
    fail('evidence directory is malformed');
  }
  if (typeof runJsonPath !== 'string' || runJsonPath.length === 0) {
    fail('run JSON path is malformed');
  }
  if (
    typeof artifactListJsonPath !== 'string' ||
    artifactListJsonPath.length === 0
  ) {
    fail('artifact-list JSON path is malformed');
  }
  if (typeof expectedRunId !== 'string' || !POSITIVE_INTEGER.test(expectedRunId)) {
    fail('expected run id is malformed');
  }
  if (typeof currentGitSha !== 'string' || !GIT_SHA.test(currentGitSha)) {
    fail('current git SHA is malformed');
  }
  const minimumAge = nonnegativeIntegerValue(
    minimumAgeSeconds,
    'minimum age seconds',
  );
  if (
    !Number.isSafeInteger(nowMs) || nowMs <= 0 ||
    !Number.isFinite(new Date(nowMs).getTime())
  ) fail('current time is malformed');
  const contract = stageContract(expectedStage, expectedTarget);
  const workflowRun = record(
    readJson(resolve(runJsonPath), 'workflow run JSON'),
    'workflow run JSON',
  );
  const dispatch = workflowDispatch({
    run: workflowRun,
    expectedRunId,
    currentGitSha,
  });
  const artifactList = record(
    readJson(resolve(artifactListJsonPath), 'artifact-list JSON'),
    'artifact-list JSON',
  );
  const artifact = artifactForDispatch({
    artifactList,
    dispatch,
    stage: expectedStage,
    target: expectedTarget,
    workflowRun,
    nowMs,
  });

  const rollout = record(
    readJson(resolve(evidenceDirectory, 'rollout.json'), 'rollout.json'),
    'rollout.json',
  );
  exactKeys(rollout, ROLLOUT_KEYS, 'rollout.json');
  const rolloutDispatch = dispatchRecord(rollout.dispatch, 'rollout dispatch');
  const generatedAt = timestamp(rollout.generated_at, 'rollout generated_at');
  if (
    rollout.schema_version !== 1 ||
    rollout.kind !== ROLLOUT_KIND ||
    rollout.verified !== true ||
    rollout.outcome !== 'committed' ||
    rollout.stage !== expectedStage ||
    rollout.target !== expectedTarget ||
    !sameDispatch(rolloutDispatch, dispatch) ||
    generatedAt > nowMs ||
    generatedAt > artifact.artifactCreatedAtMs
  ) {
    fail('rollout.json does not prove the expected committed dispatch');
  }
  if (
    typeof rollout.api_upload_source_sha !== 'string' ||
    !GIT_SHA.test(rollout.api_upload_source_sha) ||
    (expectedStage !== 'revert_off' &&
      rollout.api_upload_source_sha !== dispatch.git_sha)
  ) {
    fail('rollout.json has invalid API upload source provenance');
  }

  let soakEligibleAt = null;
  if (rollout.soak_eligible_at !== null) {
    soakEligibleAt = timestamp(
      rollout.soak_eligible_at,
      'rollout soak_eligible_at',
    );
    if (soakEligibleAt < generatedAt) {
      fail('rollout soak eligibility precedes artifact generation');
    }
  }
  if (contract.soakRequired && soakEligibleAt === null) {
    fail('production_canary must declare soak_eligible_at');
  }
  if (!contract.soakRequired && rollout.soak_eligible_at !== null) {
    fail(`${expectedStage} must use a null soak_eligible_at`);
  }
  if (
    expectedStage === 'production_canary' &&
    (nowMs - artifact.artifactCreatedAtMs < minimumAge * 1_000 ||
      (minimumAge > 0 && nowMs < soakEligibleAt))
  ) {
    fail('production_canary has not satisfied minimum age and soak eligibility');
  }

  const rollbackAnchor = validateRollbackAnchor(
    boundJson(
      evidenceDirectory,
      rollout.rollback_anchor,
      'rollback-anchor.json',
      'rollback anchor',
    ),
    expectedTarget,
    dispatch,
  );
  const finalState = validateStageFinalState(
    boundJson(
      evidenceDirectory,
      rollout.active_state,
      'final-state.json',
      'final state',
    ),
    expectedStage,
    expectedTarget,
    dispatch,
    'final state',
  );
  assertPolicyOnlyTransition(rollbackAnchor, finalState);

  let identity = null;
  if (contract.canaryIdentity) {
    if (rollout.canary_identity === null) {
      fail(`${expectedStage} requires canary identity evidence`);
    }
    identity = validateCanaryIdentity(
      boundJson(
        evidenceDirectory,
        rollout.canary_identity,
        'canary-identity.json',
        'canary identity',
      ),
      expectedTarget,
      finalState,
    );
  } else if (rollout.canary_identity !== null) {
    fail(`${expectedStage} must not bind canary identity evidence`);
  }
  if (contract.admittedSmoke) {
    if (rollout.admitted_smoke === null) {
      fail(`${expectedStage} requires admitted smoke evidence`);
    }
    validateAdmittedSmoke({
      smoke: boundJson(
        evidenceDirectory,
        rollout.admitted_smoke,
        `compute-admitted-${expectedTarget}.json`,
        'admitted smoke',
      ),
      target: expectedTarget,
      dispatch,
      identity,
      rolloutAt: generatedAt,
    });
  } else if (rollout.admitted_smoke !== null) {
    fail(`${expectedStage} must not bind admitted smoke evidence`);
  }
  if (rollout.compute_release === null) {
    fail('rollout must bind Compute release verification');
  }
  const computeReleaseReference = exactKeys(
    rollout.compute_release,
    ['evidence_file', 'sha256', 'workflow_run_id'],
    'compute release reference',
  );
  const computeReleaseVerification = validateComputeReleaseVerification({
    verification: boundJson(
      evidenceDirectory,
      computeReleaseReference,
      'compute-release-verification.json',
      'compute release verification',
      ['evidence_file', 'sha256', 'workflow_run_id'],
    ),
    target: expectedTarget,
    finalState,
  });
  if (
    typeof computeReleaseReference.workflow_run_id !== 'string' ||
    !POSITIVE_INTEGER.test(computeReleaseReference.workflow_run_id) ||
    computeReleaseReference.workflow_run_id !==
      computeReleaseVerification.workflow_run_id
  ) {
    fail('compute release reference has the wrong workflow run id');
  }

  if (contract.predecessor !== null && rollout.predecessor !== null) {
    const predecessorReference = exactKeys(
      rollout.predecessor,
      ['evidence_file', 'sha256', 'stage', 'target', 'workflow_run_id'],
      'predecessor reference',
    );
    const predecessorVerification = validatePredecessorTransition({
      verification: boundJson(
        evidenceDirectory,
        predecessorReference,
        'predecessor-verification.json',
        'predecessor verification',
        ['evidence_file', 'sha256', 'stage', 'target', 'workflow_run_id'],
      ),
      stage: expectedStage,
      target: expectedTarget,
      dispatch,
      rolloutAt: generatedAt,
    });
    if (
      predecessorReference.stage !==
        predecessorVerification.predecessor.stage ||
      predecessorReference.target !==
        predecessorVerification.predecessor.target ||
      predecessorReference.workflow_run_id !==
        predecessorVerification.dispatch.workflow_run_id
    ) {
      fail('predecessor reference metadata does not match its evidence');
    }
  } else if (contract.predecessor === 'optional_same_target_enabled') {
    // A first canary can be killed after Cloudflare accepts the mutation but
    // before GitHub publishes successful evidence. The recovery revert must
    // remain independently usable and will derive a fresh OFF anchor from the
    // exact live pair rather than trusting a cancelled run.
  } else if (contract.predecessor !== null) {
    if (rollout.predecessor === null) {
      fail(`${expectedStage} requires predecessor verification`);
    }
  } else if (rollout.predecessor !== null) {
    fail('staging_canary must not bind predecessor verification');
  }

  return {
    schema_version: 1,
    kind: VERIFICATION_KIND,
    verified: true,
    verified_at: new Date(nowMs).toISOString(),
    minimum_age_seconds: minimumAge,
    predecessor: {
      stage: expectedStage,
      target: expectedTarget,
      artifact_id: artifact.artifactId,
      artifact_name: artifact.artifactName,
      artifact_created_at: artifact.artifactCreatedAt,
      generated_at: rollout.generated_at,
      soak_eligible_at: rollout.soak_eligible_at,
    },
    dispatch,
    final_state: finalState,
  };
}

function main(argv) {
  if (argv.length !== 8) {
    throw new Error(
      'Usage: verify-compute-rollout-predecessor.mjs ' +
        '<evidence-dir> <run-json> <artifact-list-json> <expected-run-id> ' +
        '<expected-stage> <expected-target> <current-git-sha> ' +
        '<minimum-age-seconds>',
    );
  }
  const result = verifyComputeRolloutPredecessor({
    evidenceDirectory: resolve(argv[0]),
    runJsonPath: resolve(argv[1]),
    artifactListJsonPath: resolve(argv[2]),
    expectedRunId: argv[3],
    expectedStage: argv[4],
    expectedTarget: argv[5],
    currentGitSha: argv[6],
    minimumAgeSeconds: argv[7],
  });
  console.log(JSON.stringify(result));
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
