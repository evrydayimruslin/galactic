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
const CERTIFICATION_KIND = 'galactic_compute_certification_verification';
const FIXED_ARTIFACT_SHA256 =
  '6ad9b8ea5280658dc4b229a2b6180d530c4d3824b541d218266ea6049e8b763b';

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
    deployedCertification: true,
    certificationProfile: 'staging-full',
    predecessor: null,
    soakRequired: false,
  }),
  production_canary: Object.freeze({
    target: 'production',
    policy: 'canary',
    phase: 'fenced',
    canaryIdentity: true,
    deployedCertification: true,
    certificationProfile: 'production-canary',
    predecessor: 'staging_canary',
    soakRequired: true,
  }),
  production_global: Object.freeze({
    target: 'production',
    policy: 'global',
    phase: 'fenced',
    canaryIdentity: true,
    deployedCertification: true,
    certificationProfile: 'production-global',
    predecessor: 'production_canary',
    soakRequired: false,
  }),
  revert_off: Object.freeze({
    target: null,
    policy: 'off',
    phase: 'fenced',
    canaryIdentity: false,
    deployedCertification: false,
    certificationProfile: null,
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
  'active_soak',
  'api_upload_source_sha',
  'canary_identity',
  'compute_release',
  'deployed_certification',
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
  'workflow_completed_at',
];
const CERTIFICATION_KEYS = [
  'agent_id',
  'artifact_digests',
  'candidate_sha',
  'compute_receipt_ids',
  'environment_digest',
  'kind',
  'owner_id',
  'policy_compute_run_id',
  'profile',
  'promoted_api_version_id',
  'promoted_compute_version_id',
  'scenario_run_ids',
  'schema_version',
  'snapshot_generated_at',
  'suite_generated_at',
  'target',
  'verified',
  'workflow_run_id',
];
const CERTIFICATION_ARTIFACT_DIGEST_KEYS = [
  'browser',
  'consumer',
  'deterministic_fixture',
];
const ACTIVE_SOAK_REFERENCE_KEYS = [
  'evidence_file',
  'production_canary_workflow_run_id',
  'sha256',
];
const ACTIVE_SOAK_KEYS = [
  'accepted_probe_run_ids',
  'accounting_violations',
  'browser_probe_count',
  'browser_probe_run_ids',
  'candidate_sha',
  'current_workflow_run_id',
  'dlq',
  'final_probe_at',
  'first_probe_at',
  'kind',
  'live_state',
  'maximum_browser_gap_seconds',
  'maximum_lifecycle_gap_seconds',
  'minimum_soak_seconds',
  'probe_count',
  'production_canary_workflow_run_id',
  'reconciliation_violations',
  'repository',
  'schema_version',
  'soak_eligible_at',
  'soak_started_at',
  'target',
  'verified',
  'verified_at',
];
const ACTIVE_SOAK_LIVE_STATE_KEYS = [
  'api_deployment_id',
  'api_version_id',
  'canary_allowlist',
  'certification_principal',
  'compute_deployment_id',
  'compute_version_id',
  'environment_digest',
  'policy',
];
const ACTIVE_SOAK_DLQ_KEYS = ['compute', 'reconciliation'];
const ACTIVE_SOAK_DLQ_ENTRY_KEYS = [
  'baseline_count',
  'final_count',
  'name',
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
    finalState.certification_principal !== allowlistEntry ||
    (finalState.policy === 'canary' &&
      (finalState.canary_allowlist.length !== 1 ||
        finalState.canary_allowlist[0] !== allowlistEntry))
  ) {
    fail('certification identity does not match the exact final principal');
  }
  return row;
}

function validateDeployedCertification({
  verification,
  stage,
  target,
  dispatch,
  identity,
  finalState,
  rolloutAt,
}) {
  const contract = stageContract(stage, target);
  const row = exactKeys(
    verification,
    CERTIFICATION_KEYS,
    'deployed certification',
  );
  const artifactDigests = exactKeys(
    row.artifact_digests,
    CERTIFICATION_ARTIFACT_DIGEST_KEYS,
    'deployed certification artifact digests',
  );
  const ownerId = canonicalUuid(row.owner_id, 'certification owner id');
  const agentId = canonicalUuid(row.agent_id, 'certification Agent id');
  const principal = `${ownerId}/${agentId}`;
  const suiteGeneratedAt = timestamp(
    row.suite_generated_at,
    'certification suite generated_at',
  );
  const snapshotGeneratedAt = timestamp(
    row.snapshot_generated_at,
    'certification snapshot generated_at',
  );
  const scenarioRunIds = Array.isArray(row.scenario_run_ids)
    ? row.scenario_run_ids.map((runId) =>
      canonicalUuid(runId, 'certification scenario run id')
    )
    : fail('certification scenario run ids are malformed');
  const receiptIds = Array.isArray(row.compute_receipt_ids)
    ? row.compute_receipt_ids.map((receiptId) =>
      canonicalUuid(receiptId, 'certification Compute receipt id')
    )
    : fail('certification Compute receipt ids are malformed');
  canonicalUuid(row.policy_compute_run_id, 'certification policy run id');
  canonicalUuid(
    row.promoted_api_version_id,
    'certification promoted API version id',
  );
  canonicalUuid(
    row.promoted_compute_version_id,
    'certification promoted Compute version id',
  );
  const browserDigests = Array.isArray(artifactDigests.browser)
    ? artifactDigests.browser
    : fail('certification browser digests are malformed');
  const consumerDigests = Array.isArray(artifactDigests.consumer)
    ? artifactDigests.consumer
    : fail('certification consumer digests are malformed');
  for (const value of [...browserDigests, ...consumerDigests]) {
    if (typeof value !== 'string' || !HEX_SHA256.test(value)) {
      fail('certification artifact digest is malformed');
    }
  }
  const sortedUnique = (values) =>
    values.length === new Set(values).size &&
    JSON.stringify(values) === JSON.stringify([...values].sort());
  if (
    row.schema_version !== 1 || row.kind !== CERTIFICATION_KIND ||
    row.verified !== true || row.target !== target ||
    row.profile !== contract.certificationProfile ||
    row.candidate_sha !== dispatch.git_sha ||
    row.workflow_run_id !== dispatch.workflow_run_id ||
    principal !== finalState.certification_principal ||
    (identity !== null &&
      (identity.owner_id !== ownerId || identity.agent_id !== agentId)) ||
    row.environment_digest !== finalState.environment_digest ||
    row.promoted_api_version_id !== finalState.api.version_id ||
    row.promoted_compute_version_id !== finalState.compute.version_id ||
    scenarioRunIds.length !== 10 ||
    new Set(scenarioRunIds).size !== scenarioRunIds.length ||
    scenarioRunIds.includes(row.policy_compute_run_id) ||
    receiptIds.length !== 11 ||
    new Set(receiptIds).size !== receiptIds.length ||
    suiteGeneratedAt > snapshotGeneratedAt || snapshotGeneratedAt > rolloutAt ||
    artifactDigests.deterministic_fixture !== FIXED_ARTIFACT_SHA256 ||
    browserDigests.length !== 2 || consumerDigests.length !== 2 ||
    !sortedUnique(browserDigests) || !sortedUnique(consumerDigests) ||
    !consumerDigests.includes(FIXED_ARTIFACT_SHA256)
  ) {
    fail('deployed certification does not match the committed release state');
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

function positiveRunIdArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((entry, index) => {
    if (typeof entry !== 'string' || !POSITIVE_INTEGER.test(entry)) {
      fail(`${label} ${index} is not a positive workflow run id`);
    }
    return entry;
  });
  if (new Set(rows).size !== rows.length) {
    fail(`${label} contains duplicate workflow run ids`);
  }
  return rows;
}

function validateActiveSoak({
  verification,
  reference,
  predecessorVerification,
  dispatch,
  rolloutAt,
}) {
  const row = exactKeys(
    verification,
    ACTIVE_SOAK_KEYS,
    'active soak verification',
  );
  const liveState = exactKeys(
    row.live_state,
    ACTIVE_SOAK_LIVE_STATE_KEYS,
    'active soak live state',
  );
  const dlq = exactKeys(row.dlq, ACTIVE_SOAK_DLQ_KEYS, 'active soak DLQ');
  const computeDlq = exactKeys(
    dlq.compute,
    ACTIVE_SOAK_DLQ_ENTRY_KEYS,
    'active soak Compute DLQ',
  );
  const reconciliationDlq = exactKeys(
    dlq.reconciliation,
    ACTIVE_SOAK_DLQ_ENTRY_KEYS,
    'active soak reconciliation DLQ',
  );
  const acceptedProbeRunIds = positiveRunIdArray(
    row.accepted_probe_run_ids,
    'active soak accepted probe run ids',
  );
  const browserProbeRunIds = positiveRunIdArray(
    row.browser_probe_run_ids,
    'active soak browser probe run ids',
  );
  const verifiedAt = timestamp(row.verified_at, 'active soak verified_at');
  const soakStartedAt = timestamp(
    row.soak_started_at,
    'active soak started_at',
  );
  const soakEligibleAt = timestamp(
    row.soak_eligible_at,
    'active soak eligible_at',
  );
  const firstProbeAt = timestamp(
    row.first_probe_at,
    'active soak first_probe_at',
  );
  const finalProbeAt = timestamp(
    row.final_probe_at,
    'active soak final_probe_at',
  );
  const minimumSoakSeconds = nonnegativeIntegerValue(
    row.minimum_soak_seconds,
    'active soak minimum seconds',
  );
  const maximumLifecycleGapSeconds = nonnegativeIntegerValue(
    row.maximum_lifecycle_gap_seconds,
    'active soak maximum lifecycle gap',
  );
  const maximumBrowserGapSeconds = nonnegativeIntegerValue(
    row.maximum_browser_gap_seconds,
    'active soak maximum browser gap',
  );
  const probeCount = nonnegativeIntegerValue(
    row.probe_count,
    'active soak probe count',
  );
  const browserProbeCount = nonnegativeIntegerValue(
    row.browser_probe_count,
    'active soak browser probe count',
  );
  const accountingViolations = nonnegativeIntegerValue(
    row.accounting_violations,
    'active soak accounting violations',
  );
  const reconciliationViolations = nonnegativeIntegerValue(
    row.reconciliation_violations,
    'active soak reconciliation violations',
  );
  const productionCanaryRunId = positiveIntegerValue(
    row.production_canary_workflow_run_id,
    'active soak production canary run id',
  );
  const currentWorkflowRunId = positiveIntegerValue(
    row.current_workflow_run_id,
    'active soak current workflow run id',
  );
  const priorState = predecessorVerification.finalState;
  const priorWorkflowCompletedAt = timestamp(
    predecessorVerification.predecessor.workflow_completed_at,
    'production canary workflow_completed_at',
  );
  const effectiveSoakEligibleAt = priorWorkflowCompletedAt + 86_400_000;
  const browserIdsAreAccepted = browserProbeRunIds.every((runId) =>
    acceptedProbeRunIds.includes(runId)
  );
  const validDlq = (entry, expectedName) =>
    entry.name === expectedName &&
    nonnegativeIntegerValue(
      entry.baseline_count,
      `${expectedName} baseline count`,
    ) === nonnegativeIntegerValue(
      entry.final_count,
      `${expectedName} final count`,
    );
  if (
    row.schema_version !== 1 ||
    row.kind !== 'galactic_compute_canary_soak_verification' ||
    row.verified !== true || row.target !== 'production' ||
    row.repository !== dispatch.repository ||
    row.candidate_sha !== dispatch.git_sha ||
    productionCanaryRunId !== predecessorVerification.dispatch.workflow_run_id ||
    productionCanaryRunId !== reference.production_canary_workflow_run_id ||
    currentWorkflowRunId !== dispatch.workflow_run_id ||
    row.soak_started_at !==
      predecessorVerification.predecessor.workflow_completed_at ||
    row.soak_eligible_at !== new Date(effectiveSoakEligibleAt).toISOString() ||
    minimumSoakSeconds !== 86_400 ||
    maximumLifecycleGapSeconds > 2_100 ||
    maximumBrowserGapSeconds > 4_200 ||
    probeCount !== acceptedProbeRunIds.length || probeCount === 0 ||
    browserProbeCount !== browserProbeRunIds.length || browserProbeCount === 0 ||
    !browserIdsAreAccepted || accountingViolations !== 0 ||
    reconciliationViolations !== 0 ||
    soakStartedAt !== priorWorkflowCompletedAt ||
    soakEligibleAt !== effectiveSoakEligibleAt ||
    verifiedAt < soakEligibleAt || verifiedAt - soakStartedAt < 86_400_000 ||
    firstProbeAt < soakStartedAt ||
    firstProbeAt - soakStartedAt > 2_100_000 ||
    finalProbeAt < firstProbeAt || finalProbeAt > verifiedAt ||
    verifiedAt - finalProbeAt > 2_100_000 || verifiedAt > rolloutAt ||
    liveState.api_version_id !== priorState.api.version_id ||
    liveState.api_deployment_id !== priorState.api.deployment_id ||
    liveState.compute_version_id !== priorState.compute.version_id ||
    liveState.compute_deployment_id !== priorState.compute.deployment_id ||
    liveState.environment_digest !== priorState.environment_digest ||
    liveState.policy !== priorState.policy ||
    JSON.stringify(liveState.canary_allowlist) !==
      JSON.stringify(priorState.canary_allowlist) ||
    liveState.certification_principal !== priorState.certification_principal ||
    !validDlq(computeDlq, 'galactic-compute-dlq') ||
    !validDlq(
      reconciliationDlq,
      'galactic-compute-reconciliation-dlq',
    )
  ) {
    fail('active soak does not prove the exact mature production canary');
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
  const workflowCompletedAt = timestamp(
    predecessor.workflow_completed_at,
    `${label} predecessor workflow_completed_at`,
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
    generatedAt > artifactCreatedAt || artifactCreatedAt > workflowCompletedAt ||
    workflowCompletedAt > verifiedAt ||
    (contract.soakRequired && soakEligibleAt === null) ||
    (predecessor.stage === 'production_canary' &&
      (verifiedAt - workflowCompletedAt < minimumAgeSeconds * 1_000 ||
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
  const workflowCompletedAt = timestamp(
    workflowRun.updated_at,
    'workflow run updated_at',
  );
  if (workflowCompletedAt > nowMs) {
    fail('workflow completion time is in the future');
  }
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
    generatedAt > artifact.artifactCreatedAtMs ||
    artifact.artifactCreatedAtMs > workflowCompletedAt
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
    (nowMs - workflowCompletedAt < minimumAge * 1_000 ||
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
  if (contract.deployedCertification) {
    if (rollout.deployed_certification === null) {
      fail(`${expectedStage} requires deployed certification evidence`);
    }
    validateDeployedCertification({
      verification: boundJson(
        evidenceDirectory,
        rollout.deployed_certification,
        `compute-certification-verification-${expectedTarget}.json`,
        'deployed certification',
      ),
      stage: expectedStage,
      target: expectedTarget,
      dispatch,
      identity,
      finalState,
      rolloutAt: generatedAt,
    });
  } else if (rollout.deployed_certification !== null) {
    fail(`${expectedStage} must not bind deployed certification evidence`);
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

  let predecessorVerification = null;
  if (contract.predecessor !== null && rollout.predecessor !== null) {
    const predecessorReference = exactKeys(
      rollout.predecessor,
      ['evidence_file', 'sha256', 'stage', 'target', 'workflow_run_id'],
      'predecessor reference',
    );
    predecessorVerification = validatePredecessorTransition({
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

  if (expectedStage === 'production_global') {
    if (rollout.active_soak === null || predecessorVerification === null) {
      fail('production_global requires active production soak evidence');
    }
    const activeSoakReference = exactKeys(
      rollout.active_soak,
      ACTIVE_SOAK_REFERENCE_KEYS,
      'active soak reference',
    );
    if (
      activeSoakReference.production_canary_workflow_run_id !==
        predecessorVerification.dispatch.workflow_run_id
    ) {
      fail('active soak reference names the wrong production canary run');
    }
    validateActiveSoak({
      verification: boundJson(
        evidenceDirectory,
        activeSoakReference,
        'soak-verification.json',
        'active soak verification',
        ACTIVE_SOAK_REFERENCE_KEYS,
      ),
      reference: activeSoakReference,
      predecessorVerification,
      dispatch,
      rolloutAt: generatedAt,
    });
  } else if (rollout.active_soak !== null) {
    fail(`${expectedStage} must not bind active production soak evidence`);
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
      workflow_completed_at: workflowRun.updated_at,
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
