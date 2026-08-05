#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateRolloutState } from './verify-api-compute-rollout-state.mjs';
import { verifyComputeEmergencyStopStatus } from './verify-compute-emergency-stop-status.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const NONNEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const LIGHT = /^(?:0|[1-9][0-9]*)\.[0-9]{12}$/u;
const EMPTY_SHA256 = createHash('sha256').update('', 'utf8').digest('hex');
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const MAX_PROBE_DURATION_MS = 35 * 60 * 1_000;
const FIXTURE_FUNCTION = 'run_compute_certification';
const COMPUTE_RATE_VERSION = 'compute-rate-v1';
const COMPUTE_RATE_LIGHT_PER_MS = '0.000002056000';
const COMPUTE_TEARDOWN_ALLOWANCE_MS = 15_000;

const PREDECESSOR_KIND = 'galactic_compute_rollout_predecessor_verification';
const SUITE_KIND = 'galactic_compute_deployed_certification';
const RUN_SET_KIND = 'galactic_compute_certification_run_set';
const QUEUE_HEALTH_KIND = 'galactic_compute_queue_health';
const PROBE_KIND = 'galactic_compute_production_probe';

const MODES = Object.freeze({
  lifecycle: Object.freeze({
    profile: 'probe-lifecycle',
    scenarios: Object.freeze(['async_echo']),
  }),
  browser: Object.freeze({
    profile: 'probe',
    scenarios: Object.freeze(['async_echo', 'browser_https']),
  }),
});

const PREDECESSOR_KEYS = [
  'dispatch',
  'final_state',
  'kind',
  'minimum_age_seconds',
  'predecessor',
  'schema_version',
  'verified',
  'verified_at',
];
const PREDECESSOR_REFERENCE_KEYS = [
  'artifact_created_at',
  'artifact_id',
  'artifact_name',
  'generated_at',
  'soak_eligible_at',
  'stage',
  'target',
  'workflow_completed_at',
];
const DISPATCH_KEYS = [
  'git_sha',
  'repository',
  'run_attempt',
  'workflow_run_id',
];
const SUITE_KEYS = [
  'agent_id',
  'candidate_sha',
  'cleanup',
  'fixture_identity_call_receipt_id',
  'function_name',
  'generated_at',
  'kind',
  'marker_sha256',
  'operator_snapshot_required',
  'policy_pillar',
  'profile',
  'scenarios',
  'schema_version',
  'started_at',
  'target',
  'verified',
  'workflow_run_id',
];
const CLEANUP_KEYS = [
  'active_compute_runs_remaining',
  'active_routine_runs_remaining',
  'compute_policy_disabled',
  'policy_probe_paused_and_free',
  'settings_revision',
];
const SCENARIO_KEYS = [
  'artifacts',
  'exit_code',
  'observed_states',
  'receipt_id',
  'run_id',
  'scenario',
  'start_call_receipt_id',
  'status',
  'status_call_receipt_id',
  'stderr_sha256',
  'stdout_sha256',
  'timestamps',
];
const SCENARIO_TIMESTAMP_KEYS = ['created_at', 'finished_at', 'started_at'];
const ARTIFACT_KEYS = [
  'artifact_id',
  'expires_at',
  'path',
  'sha256',
  'size_bytes',
];
const DOWNLOAD_KEYS = ['byteLength', 'sha256'];
const RUN_SET_KEYS = [
  'agent_id',
  'candidate_sha',
  'generated_at',
  'kind',
  'run_ids',
  'schema_version',
  'since',
  'target',
  'workflow_run_id',
];
const SNAPSHOT_KEYS = [
  'agent_id',
  'generated_at',
  'health',
  'latch_state',
  'owner_id',
  'requested_run_count',
  'runs',
  'schema_version',
  'selected_run_count',
  'since',
  'violations',
];
const HEALTH_KEYS = [
  'dlq_fenced_runs',
  'old_settlement_pending',
  'receipt_mismatches',
  'stale_nonterminal_runs',
  'stale_pending_artifacts',
  'terminal_active_tokens',
  'terminal_input_aliases',
  'terminal_reserved_budgets',
  'unreconciled_deleted_outputs',
  'violations',
];
const RUN_KEYS = [
  'agent_id',
  'artifacts',
  'backing',
  'billing_mode',
  'budget',
  'caller_function',
  'capacity_agent_id',
  'cardinality',
  'created_at',
  'directive_hash',
  'environment_digest',
  'expires_at',
  'finished_at',
  'owner_id',
  'receipt',
  'receipt_id',
  'request_hash',
  'run_id',
  'started_at',
  'state',
  'state_version',
  'terminal_active_token_count',
  'updated_at',
  'violations',
];
const CARDINALITY_KEYS = [
  'artifact_rows',
  'budget_rows',
  'input_artifact_rows',
  'output_artifact_rows',
  'projected_artifact_rows',
  'receipt_rows',
  'token_rows',
];
const BACKING_KEYS = [
  'budget_capacity_agent_match',
  'budget_capacity_reservation',
  'budget_hold',
  'budget_matches_run_capacity',
  'budget_owner_match',
  'receipt_capacity_agent_match',
  'receipt_capacity_reservation',
  'receipt_cloud_usage_event',
  'receipt_hold',
  'receipt_matches_budget_hold',
  'receipt_matches_run_capacity',
  'receipt_principal_match',
  'run_capacity_reservation',
];
const BUDGET_KEYS = [
  'actual_light',
  'actual_wall_ms',
  'billing_mode',
  'expires_at',
  'rate_light_per_ms',
  'rate_version',
  'released_light',
  'reserved_light',
  'reserved_wall_ms',
  'settled_at',
  'status',
  'teardown_allowance_ms',
];
const RECEIPT_KEYS = [
  'actual_light',
  'billed_wall_ms',
  'billing_mode',
  'capacity_settlement_status',
  'created_at',
  'id',
  'outcome',
  'rate_version',
  'released_light',
  'reserved_light',
  'teardown_allowance_ms',
  'worker_wall_ms',
];
const SNAPSHOT_ARTIFACT_KEYS = [
  'artifact_id',
  'direction',
  'expires_at',
  'object_deleted',
  'sha256',
  'size_bytes',
  'state',
  'state_version',
];
const CONTAINER_KEYS = [
  'id',
  'image',
  'instances',
  'name',
  'schema_version',
  'state',
  'updated_at',
  'version',
];
const QUEUE_HEALTH_KEYS = [
  'compute_dlq',
  'dispatch',
  'kind',
  'observed_at',
  'reconciliation_dlq',
  'schema_version',
  'target',
  'verified',
];
const QUEUE_DISPATCH_KEYS = ['backlog', 'name', 'oldest_age_seconds'];
const QUEUE_DLQ_KEYS = ['baseline_count', 'final_count', 'name'];

function fail(message) {
  throw new Error(`Compute production probe evidence is invalid: ${message}`);
}

function exactRecord(value, expectedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is missing or is not valid JSON`);
  }
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    fail(`${label} is not a canonical UUID`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${label} is not a canonical SHA-256`);
  }
  return value;
}

function digest(value, label) {
  if (
    typeof value !== 'string' || !DIGEST.test(value) || value === ZERO_DIGEST
  ) {
    fail(`${label} is not a nonzero immutable digest`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (
    !(
      (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
      (typeof value === 'string' && POSITIVE_INTEGER.test(value) &&
        Number.isSafeInteger(Number(value)))
    )
  ) {
    fail(`${label} is not a positive integer`);
  }
  return Number(value);
}

function nonnegativeInteger(value, label) {
  if (
    !(
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === 'string' && NONNEGATIVE_INTEGER.test(value) &&
        Number.isSafeInteger(Number(value)))
    )
  ) {
    fail(`${label} is not a nonnegative integer`);
  }
  return Number(value);
}

function exactNumericZero(value, label) {
  if (value !== 0) fail(`${label} must be the exact numeric zero`);
}

function validCalendarTimestamp(value, { utcOnly = false } = {}) {
  if (typeof value !== 'string') return false;
  const pattern = utcOnly
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
  const match = value.match(pattern);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 ||
    second > 59
  ) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return false;
  if (!utcOnly && match[8] !== undefined) {
    const offsetHours = Number(match[9]);
    const offsetMinutes = Number(match[10]);
    if (
      offsetHours > 14 || offsetMinutes > 59 ||
      (offsetHours === 14 && offsetMinutes !== 0)
    ) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function timestamp(value, label, options) {
  if (!validCalendarTimestamp(value, options)) {
    fail(`${label} is not a valid timestamp`);
  }
  return Date.parse(value);
}

function exactArray(value, expected, label) {
  if (
    !Array.isArray(value) || value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${label} does not match the fixed probe contract`);
  }
}

function emptyArray(value, label) {
  exactArray(value, [], label);
}

function unique(values, label) {
  if (new Set(values).size !== values.length) {
    fail(`${label} contains a duplicate identity`);
  }
}

function light(value, label) {
  if (typeof value !== 'string' || !LIGHT.test(value)) {
    fail(`${label} is not a fixed-precision Light value`);
  }
  return BigInt(value.replace('.', ''));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function dispatchRecord(value, label) {
  const dispatch = exactRecord(value, DISPATCH_KEYS, label);
  if (
    typeof dispatch.repository !== 'string' ||
    !REPOSITORY.test(dispatch.repository) ||
    typeof dispatch.workflow_run_id !== 'string' ||
    !POSITIVE_INTEGER.test(dispatch.workflow_run_id) ||
    typeof dispatch.run_attempt !== 'string' ||
    !POSITIVE_INTEGER.test(dispatch.run_attempt) ||
    typeof dispatch.git_sha !== 'string' || !GIT_SHA.test(dispatch.git_sha)
  ) {
    fail(`${label} is malformed`);
  }
  return dispatch;
}

function sameDispatch(left, right) {
  return DISPATCH_KEYS.every((key) => left[key] === right[key]);
}

function rolloutState(value, label) {
  try {
    return validateRolloutState(value);
  } catch {
    fail(`${label} is not a canonical rollout state`);
  }
}

function validatePredecessor(value) {
  const verification = exactRecord(value, PREDECESSOR_KEYS, 'predecessor verification');
  const predecessor = exactRecord(
    verification.predecessor,
    PREDECESSOR_REFERENCE_KEYS,
    'predecessor verification reference',
  );
  const dispatch = dispatchRecord(verification.dispatch, 'predecessor dispatch');
  const generatedAt = timestamp(predecessor.generated_at, 'predecessor generation');
  const artifactCreatedAt = timestamp(
    predecessor.artifact_created_at,
    'predecessor artifact creation',
  );
  const soakEligibleAt = timestamp(
    predecessor.soak_eligible_at,
    'predecessor soak eligibility',
  );
  const workflowCompletedAt = timestamp(
    predecessor.workflow_completed_at,
    'predecessor workflow completion',
  );
  const verifiedAt = timestamp(verification.verified_at, 'predecessor verification time');
  nonnegativeInteger(
    verification.minimum_age_seconds,
    'predecessor minimum age seconds',
  );
  if (
    verification.schema_version !== 1 ||
    verification.kind !== PREDECESSOR_KIND ||
    verification.verified !== true ||
    predecessor.stage !== 'production_canary' ||
    predecessor.target !== 'production' ||
    typeof predecessor.artifact_id !== 'string' ||
    !POSITIVE_INTEGER.test(predecessor.artifact_id) ||
    predecessor.artifact_name !==
      `compute-canary-rollout-production_canary-production-${dispatch.workflow_run_id}-${dispatch.run_attempt}` ||
    generatedAt > artifactCreatedAt ||
    artifactCreatedAt > workflowCompletedAt ||
    workflowCompletedAt > verifiedAt ||
    soakEligibleAt < generatedAt
  ) {
    fail('predecessor verification does not prove one production canary artifact');
  }
  const finalState = rolloutState(
    verification.final_state,
    'predecessor final rollout state',
  );
  if (
    finalState.phase !== 'fenced' || finalState.target !== 'production' ||
    finalState.policy !== 'canary' || !sameDispatch(finalState.dispatch, dispatch) ||
    finalState.api.worker !== 'ultralight-api' ||
    finalState.compute.worker !== 'galactic-compute' ||
    finalState.certification_principal === null
  ) {
    fail('predecessor final state is not the active production canary');
  }
  exactArray(
    finalState.canary_allowlist,
    [finalState.certification_principal],
    'predecessor canary allowlist',
  );
  const [ownerId, agentId] = finalState.certification_principal.split('/');
  uuid(ownerId, 'predecessor owner id');
  uuid(agentId, 'predecessor Agent id');
  return {
    dispatch,
    finalState,
    predecessor,
    ownerId,
    agentId,
    generatedAt,
    verifiedAt,
  };
}

function validateLiveStates({
  initialLiveState,
  finalLiveState,
  predecessor,
  expectedDispatch,
  expectedOutcome,
}) {
  const initial = rolloutState(initialLiveState, 'initial live state');
  const final = rolloutState(finalLiveState, 'final live state');
  if (
    initial.phase !== 'inspected' || final.phase !== 'inspected' ||
    initial.target !== 'production' || final.target !== 'production' ||
    !sameDispatch(initial.dispatch, expectedDispatch) ||
    !sameDispatch(final.dispatch, expectedDispatch) ||
    !sameJson(initial, final)
  ) {
    fail('initial and final live states do not prove one unchanged probe dispatch');
  }
  const canary = predecessor?.finalState ?? null;
  if (expectedOutcome === 'passed') {
    if (
      canary === null ||
      final.environment_digest !== canary.environment_digest ||
      !sameJson(final.compute, canary.compute) ||
      final.policy !== 'canary' ||
      final.certification_principal !== canary.certification_principal ||
      !sameJson(final.canary_allowlist, canary.canary_allowlist) ||
      !sameJson(final.api, canary.api)
    ) {
      fail('admitted probe state is not the exact production canary');
    }
  } else {
    if (
      final.policy !== 'off' || final.certification_principal !== null ||
      final.canary_allowlist.length !== 0
    ) {
      fail('OFF no-op does not prove the exact disabled live policy');
    }
    if (
      canary !== null &&
      (
        final.environment_digest !== canary.environment_digest ||
        !sameJson(final.compute, canary.compute) ||
        final.api.worker !== canary.api.worker ||
        final.api.code_etag !== canary.api.code_etag ||
        final.api.compatibility_sha256 !== canary.api.compatibility_sha256
      )
    ) {
      fail('OFF no-op does not preserve the canary code and Compute identity');
    }
  }
  return final;
}

function validatePublicArtifact(value, scenario, finishedAt) {
  const artifact = exactRecord(value, ARTIFACT_KEYS, `${scenario} artifact`);
  const size = positiveInteger(artifact.size_bytes, `${scenario} artifact size`);
  const expiresAt = timestamp(
    artifact.expires_at,
    `${scenario} artifact expiry`,
    { utcOnly: true },
  );
  if (expiresAt <= finishedAt) fail(`${scenario} artifact expires before completion`);
  if (typeof artifact.path !== 'string' || artifact.path.length === 0) {
    fail(`${scenario} artifact path is malformed`);
  }
  return {
    ...artifact,
    artifact_id: uuid(artifact.artifact_id, `${scenario} artifact id`),
    sha256: sha256(artifact.sha256, `${scenario} artifact digest`),
    size_bytes: size,
  };
}

function validateDownload(value, artifact, label) {
  const download = exactRecord(value, DOWNLOAD_KEYS, label);
  if (
    positiveInteger(download.byteLength, `${label} byte length`) !== artifact.size_bytes ||
    sha256(download.sha256, `${label} digest`) !== artifact.sha256
  ) {
    fail(`${label} does not match its public artifact`);
  }
}

function validateScenario(value, expectedScenario, suiteTimes, receiptIds) {
  const expectedKeys = expectedScenario === 'browser_https'
    ? [...SCENARIO_KEYS, 'artifact_download']
    : SCENARIO_KEYS;
  const scenario = exactRecord(value, expectedKeys, `${expectedScenario} scenario`);
  if (
    scenario.scenario !== expectedScenario || scenario.status !== 'completed' ||
    scenario.exit_code !== 0
  ) {
    fail(`${expectedScenario} did not complete successfully`);
  }
  const runId = uuid(scenario.run_id, `${expectedScenario} run id`);
  const receiptId = uuid(scenario.receipt_id, `${expectedScenario} receipt id`);
  receiptIds.push(
    receiptId,
    uuid(scenario.start_call_receipt_id, `${expectedScenario} start receipt id`),
    uuid(scenario.status_call_receipt_id, `${expectedScenario} status receipt id`),
  );
  const allowedStates = new Set([
    'queued',
    'reserving',
    'starting',
    'running',
    'settlement_pending',
    'completed',
  ]);
  if (
    !Array.isArray(scenario.observed_states) ||
    scenario.observed_states.length < 2 ||
    scenario.observed_states.some((state) => !allowedStates.has(state)) ||
    scenario.observed_states.at(-1) !== 'completed'
  ) {
    fail(`${expectedScenario} lifecycle history is incomplete`);
  }
  const times = exactRecord(
    scenario.timestamps,
    SCENARIO_TIMESTAMP_KEYS,
    `${expectedScenario} timestamps`,
  );
  const createdAt = timestamp(
    times.created_at,
    `${expectedScenario} creation`,
    { utcOnly: true },
  );
  const startedAt = timestamp(
    times.started_at,
    `${expectedScenario} start`,
    { utcOnly: true },
  );
  const finishedAt = timestamp(
    times.finished_at,
    `${expectedScenario} finish`,
    { utcOnly: true },
  );
  if (
    createdAt < suiteTimes.startedAt || createdAt > startedAt ||
    startedAt > finishedAt || finishedAt > suiteTimes.generatedAt
  ) {
    fail(`${expectedScenario} timestamps are out of order`);
  }
  sha256(scenario.stdout_sha256, `${expectedScenario} stdout digest`);
  if (sha256(scenario.stderr_sha256, `${expectedScenario} stderr digest`) !== EMPTY_SHA256) {
    fail(`${expectedScenario} wrote to stderr`);
  }
  if (!Array.isArray(scenario.artifacts)) {
    fail(`${expectedScenario} artifacts must be an array`);
  }
  const artifacts = scenario.artifacts.map((artifact) =>
    validatePublicArtifact(artifact, expectedScenario, finishedAt)
  );
  const expectedPaths = expectedScenario === 'browser_https'
    ? ['output/browser-https.json', 'output/browser-https.png']
    : [];
  exactArray(
    artifacts.map((artifact) => artifact.path).sort(),
    expectedPaths,
    `${expectedScenario} artifact paths`,
  );
  unique(artifacts.map((artifact) => artifact.artifact_id), `${expectedScenario} artifacts`);
  if (expectedScenario === 'browser_https') {
    unique(artifacts.map((artifact) => artifact.sha256), 'browser artifact digests');
    if (
      !Array.isArray(scenario.artifact_download) ||
      scenario.artifact_download.length !== artifacts.length
    ) {
      fail('browser download proof is incomplete');
    }
    scenario.artifact_download.forEach((download, index) =>
      validateDownload(download, artifacts[index], 'browser artifact download')
    );
  }
  return {
    ...scenario,
    runId,
    receiptId,
    createdAt,
    startedAt,
    finishedAt,
    artifacts,
  };
}

function validateSuite(value, context) {
  const suite = exactRecord(value, SUITE_KEYS, 'probe suite');
  if (
    suite.schema_version !== 1 || suite.kind !== SUITE_KIND ||
    suite.verified !== true || suite.operator_snapshot_required !== true ||
    suite.target !== 'production' || suite.profile !== context.mode.profile ||
    suite.candidate_sha !== context.predecessor.dispatch.git_sha ||
    suite.workflow_run_id !== context.expectedDispatch.workflow_run_id ||
    suite.agent_id !== context.predecessor.agentId ||
    suite.function_name !== FIXTURE_FUNCTION || suite.policy_pillar !== null
  ) {
    fail('probe suite provenance or profile is incorrect');
  }
  uuid(suite.agent_id, 'probe suite Agent id');
  const receiptIds = [
    uuid(
      suite.fixture_identity_call_receipt_id,
      'probe fixture identity receipt id',
    ),
  ];
  const marker =
    `galactic-compute-certification-v1:${suite.candidate_sha}:${suite.workflow_run_id}\n`;
  if (
    sha256(suite.marker_sha256, 'probe suite marker digest') !==
      createHash('sha256').update(marker, 'utf8').digest('hex')
  ) {
    fail('probe suite marker is not bound to the canary and probe dispatch');
  }
  const startedAt = timestamp(suite.started_at, 'probe suite start', { utcOnly: true });
  const generatedAt = timestamp(
    suite.generated_at,
    'probe suite generation',
    { utcOnly: true },
  );
  if (
    startedAt !== context.startedAt || generatedAt < startedAt ||
    generatedAt - startedAt > MAX_PROBE_DURATION_MS
  ) {
    fail('probe suite is outside the bounded dispatch window');
  }
  const cleanup = exactRecord(suite.cleanup, CLEANUP_KEYS, 'probe suite cleanup');
  positiveInteger(cleanup.settings_revision, 'probe cleanup settings revision');
  if (
    cleanup.active_compute_runs_remaining !== 0 ||
    cleanup.active_routine_runs_remaining !== 0 ||
    cleanup.compute_policy_disabled !== true ||
    cleanup.policy_probe_paused_and_free !== true
  ) {
    fail('probe suite cleanup is not owner-fenced and fully drained');
  }
  if (
    !Array.isArray(suite.scenarios) ||
    suite.scenarios.length !== context.mode.scenarios.length
  ) {
    fail('probe suite scenario cardinality is incorrect');
  }
  const scenarios = suite.scenarios.map((scenario, index) =>
    validateScenario(
      scenario,
      context.mode.scenarios[index],
      { startedAt, generatedAt },
      receiptIds,
    )
  );
  unique(scenarios.map((scenario) => scenario.runId), 'probe scenario runs');
  unique(receiptIds, 'probe call and Compute receipts');
  unique(
    scenarios.flatMap((scenario) =>
      scenario.artifacts.map((artifact) => artifact.artifact_id)
    ),
    'probe public artifacts',
  );
  return { ...suite, startedAt, generatedAt, scenarios };
}

function validateRunSet(value, suite, context) {
  const runSet = exactRecord(value, RUN_SET_KEYS, 'probe run set');
  const expectedRunIds = suite.scenarios.map((scenario) => scenario.runId);
  if (
    runSet.schema_version !== 1 || runSet.kind !== RUN_SET_KIND ||
    runSet.target !== 'production' ||
    runSet.candidate_sha !== context.predecessor.dispatch.git_sha ||
    runSet.workflow_run_id !== context.expectedDispatch.workflow_run_id ||
    runSet.agent_id !== suite.agent_id || runSet.since !== suite.started_at ||
    runSet.generated_at !== suite.generated_at
  ) {
    fail('probe run set is not bound to the exact suite');
  }
  exactArray(runSet.run_ids, expectedRunIds, 'probe run set identities');
  runSet.run_ids.forEach((runId) => uuid(runId, 'probe run-set run id'));
  unique(runSet.run_ids, 'probe run set');
  return runSet;
}

function validateSnapshotArtifact(value, label) {
  const artifact = exactRecord(value, SNAPSHOT_ARTIFACT_KEYS, `${label} artifact`);
  if (
    artifact.direction !== 'output' || artifact.state !== 'ready' ||
    artifact.object_deleted !== false
  ) {
    fail(`${label} output artifact lifecycle is not ready`);
  }
  positiveInteger(artifact.state_version, `${label} artifact state version`);
  const size = positiveInteger(artifact.size_bytes, `${label} artifact size`);
  timestamp(artifact.expires_at, `${label} artifact expiry`);
  return {
    ...artifact,
    artifact_id: uuid(artifact.artifact_id, `${label} artifact id`),
    sha256: sha256(artifact.sha256, `${label} artifact digest`),
    size_bytes: size,
  };
}

function validateAccounting(run, label) {
  const cardinality = exactRecord(run.cardinality, CARDINALITY_KEYS, `${label} cardinality`);
  const counts = Object.fromEntries(CARDINALITY_KEYS.map((key) => [
    key,
    nonnegativeInteger(cardinality[key], `${label} ${key}`),
  ]));
  if (
    counts.budget_rows !== 1 || counts.receipt_rows !== 1 ||
    counts.token_rows < 1 || counts.input_artifact_rows !== 0 ||
    counts.artifact_rows !== counts.output_artifact_rows ||
    counts.projected_artifact_rows !== counts.artifact_rows
  ) {
    fail(`${label} persistence cardinality is not conserved`);
  }
  const backing = exactRecord(run.backing, BACKING_KEYS, `${label} backing`);
  for (const key of BACKING_KEYS) {
    if (typeof backing[key] !== 'boolean') fail(`${label} backing is malformed`);
  }
  for (
    const key of [
      'budget_matches_run_capacity',
      'receipt_matches_run_capacity',
      'receipt_matches_budget_hold',
      'budget_owner_match',
      'budget_capacity_agent_match',
      'receipt_principal_match',
      'receipt_capacity_agent_match',
    ]
  ) {
    if (backing[key] !== true) fail(`${label} accounting identity is inconsistent`);
  }
  const budget = exactRecord(run.budget, BUDGET_KEYS, `${label} budget`);
  const receipt = exactRecord(run.receipt, RECEIPT_KEYS, `${label} receipt`);
  if (
    budget.status !== 'settled' || budget.billing_mode !== run.billing_mode ||
    receipt.billing_mode !== run.billing_mode || receipt.id !== run.receipt_id ||
    receipt.outcome !== 'succeeded' ||
    budget.rate_version !== COMPUTE_RATE_VERSION ||
    budget.rate_light_per_ms !== COMPUTE_RATE_LIGHT_PER_MS ||
    receipt.rate_version !== COMPUTE_RATE_VERSION
  ) {
    fail(`${label} settlement identity is inconsistent`);
  }
  const reserved = light(budget.reserved_light, `${label} reserved Light`);
  const actual = light(budget.actual_light, `${label} actual Light`);
  const released = light(budget.released_light, `${label} released Light`);
  if (
    reserved !== light(receipt.reserved_light, `${label} receipt reserved Light`) ||
    actual !== light(receipt.actual_light, `${label} receipt actual Light`) ||
    released !== light(receipt.released_light, `${label} receipt released Light`)
  ) {
    fail(`${label} budget and receipt accounting differ`);
  }
  timestamp(budget.expires_at, `${label} budget expiry`);
  timestamp(budget.settled_at, `${label} budget settlement`);
  timestamp(receipt.created_at, `${label} receipt creation`);
  if (receipt.worker_wall_ms === null || budget.actual_wall_ms === null) {
    fail(`${label} did not execute a billable Compute body`);
  }
  const workerWall = nonnegativeInteger(receipt.worker_wall_ms, `${label} worker wall ms`);
  const actualWall = nonnegativeInteger(budget.actual_wall_ms, `${label} actual wall ms`);
  const reservedWall = positiveInteger(budget.reserved_wall_ms, `${label} reserved wall ms`);
  const teardown = nonnegativeInteger(
    budget.teardown_allowance_ms,
    `${label} teardown allowance`,
  );
  const receiptTeardown = nonnegativeInteger(
    receipt.teardown_allowance_ms,
    `${label} receipt teardown allowance`,
  );
  const billedWall = nonnegativeInteger(receipt.billed_wall_ms, `${label} billed wall ms`);
  const expectedBilled = run.billing_mode === 'wallet'
    ? Math.min(workerWall, reservedWall)
    : workerWall;
  const rate = light(budget.rate_light_per_ms, `${label} rate`);
  if (
    actualWall !== workerWall || teardown !== COMPUTE_TEARDOWN_ALLOWANCE_MS ||
    receiptTeardown !== teardown || billedWall !== expectedBilled ||
    reserved !== BigInt(reservedWall) * rate ||
    actual !== BigInt(expectedBilled) * rate
  ) {
    fail(`${label} tariff or wall-time accounting is inconsistent`);
  }
  if (run.billing_mode === 'wallet') {
    if (
      actual > reserved || actual + released !== reserved ||
      backing.run_capacity_reservation !== false || backing.budget_hold !== true ||
      backing.budget_capacity_reservation !== false ||
      backing.receipt_hold !== true ||
      backing.receipt_capacity_reservation !== false ||
      backing.receipt_cloud_usage_event !== true ||
      receipt.capacity_settlement_status !== 'not_applicable'
    ) {
      fail(`${label} wallet settlement or backing is invalid`);
    }
  } else if (run.billing_mode === 'subscription_capacity') {
    const expectedReleased = reserved > actual ? reserved - actual : 0n;
    if (
      released !== expectedReleased ||
      backing.run_capacity_reservation !== true || backing.budget_hold !== false ||
      backing.budget_capacity_reservation !== true ||
      backing.receipt_hold !== false ||
      backing.receipt_capacity_reservation !== true ||
      backing.receipt_cloud_usage_event !== false ||
      receipt.capacity_settlement_status !== 'settled'
    ) {
      fail(`${label} capacity settlement or backing is invalid`);
    }
  } else {
    fail(`${label} billing mode is unsupported`);
  }
  return counts;
}

function validateSnapshotRun(value, index, context) {
  const label = `probe selected run ${index + 1}`;
  const run = exactRecord(value, RUN_KEYS, label);
  const scenario = context.suite.scenarios[index];
  if (
    uuid(run.run_id, `${label} id`) !== scenario.runId ||
    uuid(run.receipt_id, `${label} receipt id`) !== scenario.receiptId ||
    uuid(run.owner_id, `${label} owner id`) !== context.predecessor.ownerId ||
    uuid(run.agent_id, `${label} Agent id`) !== context.predecessor.agentId ||
    uuid(run.capacity_agent_id, `${label} capacity Agent id`) !==
      context.predecessor.agentId ||
    digest(run.environment_digest, `${label} environment digest`) !==
      context.liveState.environment_digest ||
    run.caller_function !== FIXTURE_FUNCTION || run.state !== 'succeeded'
  ) {
    fail(`${label} principal, receipt, environment, or terminal state drifted`);
  }
  positiveInteger(run.state_version, `${label} state version`);
  sha256(run.directive_hash, `${label} directive hash`);
  sha256(run.request_hash, `${label} request hash`);
  const createdAt = timestamp(run.created_at, `${label} creation`);
  const startedAt = timestamp(run.started_at, `${label} start`);
  const finishedAt = timestamp(run.finished_at, `${label} finish`);
  const updatedAt = timestamp(run.updated_at, `${label} update`);
  const expiresAt = timestamp(run.expires_at, `${label} expiry`);
  if (
    createdAt !== scenario.createdAt || startedAt !== scenario.startedAt ||
    finishedAt !== scenario.finishedAt || createdAt > startedAt ||
    startedAt > finishedAt || finishedAt > updatedAt || expiresAt <= createdAt
  ) {
    fail(`${label} is not timestamp-bound to the public lifecycle`);
  }
  emptyArray(run.violations, `${label} violations`);
  exactNumericZero(run.terminal_active_token_count, `${label} active token count`);
  const counts = validateAccounting(run, label);
  if (!Array.isArray(run.artifacts)) fail(`${label} artifacts must be an array`);
  const artifacts = run.artifacts.map((artifact) => validateSnapshotArtifact(artifact, label));
  unique(artifacts.map((artifact) => artifact.artifact_id), `${label} artifacts`);
  for (let artifactIndex = 1; artifactIndex < artifacts.length; artifactIndex += 1) {
    const previous = `${artifacts[artifactIndex - 1].direction}:${artifacts[artifactIndex - 1].artifact_id}`;
    const current = `${artifacts[artifactIndex].direction}:${artifacts[artifactIndex].artifact_id}`;
    if (current <= previous) fail(`${label} artifacts are not canonically ordered`);
  }
  if (artifacts.length !== counts.artifact_rows) {
    fail(`${label} artifact projection cardinality drifted`);
  }
  const publicById = new Map(
    scenario.artifacts.map((artifact) => [artifact.artifact_id, artifact]),
  );
  if (artifacts.length !== publicById.size) {
    fail(`${label} output artifact projection is incomplete`);
  }
  for (const artifact of artifacts) {
    const publicArtifact = publicById.get(artifact.artifact_id);
    if (
      publicArtifact === undefined || artifact.sha256 !== publicArtifact.sha256 ||
      artifact.size_bytes !== publicArtifact.size_bytes
    ) {
      fail(`${label} output artifact differs from the public proof`);
    }
  }
  return { ...run, createdAt, startedAt, finishedAt, artifacts };
}

function validateSnapshot(value, context) {
  const snapshot = exactRecord(value, SNAPSHOT_KEYS, 'probe operator snapshot');
  if (
    snapshot.schema_version !== 1 || snapshot.owner_id !== context.predecessor.ownerId ||
    snapshot.agent_id !== context.predecessor.agentId ||
    snapshot.latch_state !== 'clear'
  ) {
    fail('probe snapshot principal or emergency-stop latch is incorrect');
  }
  const generatedAt = timestamp(snapshot.generated_at, 'probe snapshot generation');
  const since = timestamp(snapshot.since, 'probe snapshot window');
  if (
    since !== context.suite.startedAt || generatedAt < context.suite.generatedAt ||
    generatedAt - context.suite.startedAt > MAX_PROBE_DURATION_MS
  ) {
    fail('probe snapshot is outside the exact suite window');
  }
  const count = context.runSet.run_ids.length;
  if (
    snapshot.requested_run_count !== count || snapshot.selected_run_count !== count ||
    !Array.isArray(snapshot.runs) || snapshot.runs.length !== count
  ) {
    fail('probe snapshot did not select the exact bounded run set');
  }
  emptyArray(snapshot.violations, 'probe snapshot violations');
  const health = exactRecord(snapshot.health, HEALTH_KEYS, 'probe snapshot health');
  for (const key of HEALTH_KEYS.filter((key) => key !== 'violations')) {
    exactNumericZero(health[key], `probe snapshot health ${key}`);
  }
  emptyArray(health.violations, 'probe snapshot health violations');
  const runs = snapshot.runs.map((run, index) =>
    validateSnapshotRun(run, index, context)
  );
  unique(runs.map((run) => run.receipt_id), 'probe selected receipts');
  unique(
    runs.flatMap((run) => run.artifacts.map((artifact) => artifact.artifact_id)),
    'probe snapshot artifacts',
  );
  return { ...snapshot, generatedAt, runs };
}

function validateContainerReadiness(value, environmentDigest) {
  const container = exactRecord(value, CONTAINER_KEYS, 'container readiness');
  const expectedImage = new RegExp(
    `^registry\\.cloudflare\\.com/[0-9a-f]{32}/galactic-compute@${environmentDigest}$`,
    'u',
  );
  if (
    container.schema_version !== 1 || typeof container.id !== 'string' ||
    container.id.length === 0 ||
    container.name !== 'galactic-compute-computestandard' ||
    !['active', 'ready'].includes(container.state) ||
    typeof container.image !== 'string' || !expectedImage.test(container.image) ||
    !(
      (typeof container.version === 'string' || typeof container.version === 'number') &&
      String(container.version).length > 0
    )
  ) {
    fail('container readiness does not prove the exact production image digest');
  }
  if (
    container.instances !== null &&
    !(
      typeof container.instances === 'number' &&
      Number.isSafeInteger(container.instances) && container.instances >= 0
    )
  ) {
    fail('container readiness instance count is malformed');
  }
  if (container.updated_at !== null) {
    timestamp(container.updated_at, 'container readiness update');
  }
  return container;
}

function validateQueueHealth(value) {
  const health = exactRecord(value, QUEUE_HEALTH_KEYS, 'queue health');
  if (
    health.schema_version !== 1 || health.kind !== QUEUE_HEALTH_KIND ||
    health.verified !== true || health.target !== 'production'
  ) {
    fail('queue health metadata is incorrect');
  }
  const observedAt = timestamp(health.observed_at, 'queue health observation');
  const dispatch = exactRecord(health.dispatch, QUEUE_DISPATCH_KEYS, 'dispatch queue health');
  if (dispatch.name !== 'galactic-compute') {
    fail('queue health dispatch identity is incorrect');
  }
  exactNumericZero(dispatch.backlog, 'dispatch queue backlog');
  exactNumericZero(dispatch.oldest_age_seconds, 'dispatch oldest message age');
  const dlq = (value, expectedName, label) => {
    const row = exactRecord(value, QUEUE_DLQ_KEYS, label);
    const baseline = nonnegativeInteger(row.baseline_count, `${label} baseline`);
    const final = nonnegativeInteger(row.final_count, `${label} final`);
    if (row.name !== expectedName || final !== baseline) {
      fail(`${label} identity drifted or increased during the probe`);
    }
    return { name: row.name, baseline_count: baseline, final_count: final };
  };
  return {
    observedAt,
    observed_at: new Date(observedAt).toISOString(),
    dispatch: {
      name: dispatch.name,
      backlog: 0,
      oldest_age_seconds: 0,
    },
    compute_dlq: dlq(
      health.compute_dlq,
      'galactic-compute-dlq',
      'Compute DLQ health',
    ),
    reconciliation_dlq: dlq(
      health.reconciliation_dlq,
      'galactic-compute-reconciliation-dlq',
      'reconciliation DLQ health',
    ),
  };
}

function terminalMarker(run, scenario, context) {
  return {
    owner_id: context.predecessor.ownerId,
    agent_id: context.predecessor.agentId,
    run_id: scenario.runId,
    receipt_id: scenario.receiptId,
    state: 'completed',
    environment_digest: context.liveState.environment_digest,
    created_at: new Date(run.createdAt).toISOString(),
    started_at: new Date(run.startedAt).toISOString(),
    finished_at: new Date(run.finishedAt).toISOString(),
  };
}

export function validateComputeProbeEvidence({
  predecessorVerification = null,
  initialLiveState,
  suiteEvidence = null,
  runSetEvidence = null,
  operatorSnapshot = null,
  finalLiveState,
  containerReadiness,
  queueHealth,
  emergencyStopStatus,
  expectedMode,
  expectedOutcome,
  expectedRepository,
  expectedWorkflowRunId,
  expectedRunAttempt,
  expectedGitSha,
  expectedStartedAt,
}) {
  const mode = MODES[expectedMode];
  if (!mode) fail('expected probe mode is unsupported');
  if (!['passed', 'off_noop'].includes(expectedOutcome)) {
    fail('expected probe outcome is unsupported');
  }
  if (expectedOutcome === 'off_noop' && expectedMode !== 'lifecycle') {
    fail('OFF no-op must use lifecycle mode');
  }
  const expectedDispatch = dispatchRecord({
    repository: expectedRepository,
    workflow_run_id: expectedWorkflowRunId,
    run_attempt: expectedRunAttempt,
    git_sha: expectedGitSha,
  }, 'expected probe dispatch');
  const startedAt = timestamp(expectedStartedAt, 'expected probe start', { utcOnly: true });
  if (expectedOutcome === 'passed' && predecessorVerification === null) {
    fail('passed probe requires a production-canary predecessor');
  }
  const predecessor = predecessorVerification === null
    ? null
    : validatePredecessor(predecessorVerification);
  if (
    predecessor !== null &&
    (
      predecessor.dispatch.repository !== expectedDispatch.repository ||
      predecessor.dispatch.workflow_run_id === expectedDispatch.workflow_run_id ||
      predecessor.verifiedAt > startedAt
    )
  ) {
    fail('probe dispatch is not a distinct run of the active canary lineage');
  }
  const liveState = validateLiveStates({
    initialLiveState,
    finalLiveState,
    predecessor,
    expectedDispatch,
    expectedOutcome,
  });
  validateContainerReadiness(containerReadiness, liveState.environment_digest);
  const queue = validateQueueHealth(queueHealth);
  let emergency;
  try {
    emergency = verifyComputeEmergencyStopStatus({
      status: emergencyStopStatus,
      expectedAdmissionState: expectedOutcome === 'passed' ? 'enabled' : 'disabled',
      expectedLatchState: 'clear',
    });
  } catch {
    fail('emergency-stop status does not prove a clear latch and expected admission state');
  }
  if (emergency.latchState !== 'clear') {
    fail('emergency-stop latch is not clear');
  }
  if (
    queue.observedAt < startedAt ||
    queue.observedAt - startedAt > MAX_PROBE_DURATION_MS
  ) {
    fail('queue health observation is outside the bounded probe window');
  }

  let suite = null;
  let runSet = null;
  let snapshot = null;
  let lifecycle = null;
  let accounting = null;
  let browserArtifacts = null;
  let markerHealth = null;
  const latchState = 'clear';

  if (expectedOutcome === 'off_noop') {
    if (
      suiteEvidence !== null || runSetEvidence !== null ||
      operatorSnapshot !== null
    ) {
      fail('OFF no-op must not consume or label admitted suite evidence');
    }
  } else {
    if (
      suiteEvidence === null || runSetEvidence === null ||
      operatorSnapshot === null
    ) {
      fail('passed probe requires suite, run-set, and operator evidence');
    }
    const context = { mode, predecessor, expectedDispatch, startedAt, liveState };
    suite = validateSuite(suiteEvidence, context);
    runSet = validateRunSet(runSetEvidence, suite, context);
    snapshot = validateSnapshot(operatorSnapshot, { ...context, suite, runSet });
    if (queue.observedAt < snapshot.generatedAt) {
      fail('queue health was observed before terminal accounting');
    }
    const lifecycleScenario = suite.scenarios[0];
    lifecycle = terminalMarker(snapshot.runs[0], lifecycleScenario, context);
    const runIds = snapshot.runs.map((run) => run.run_id).sort();
    const receiptIds = snapshot.runs.map((run) => run.receipt_id).sort();
    unique(runIds, 'probe accounting run ids');
    unique(receiptIds, 'probe accounting receipt ids');
    accounting = {
      snapshot_generated_at: new Date(snapshot.generatedAt).toISOString(),
      run_ids: runIds,
      receipt_ids: receiptIds,
      accounting_violations: 0,
      reconciliation_violations: 0,
      violations: [],
    };
    if (expectedMode === 'browser') {
      const scenario = suite.scenarios[1];
      browserArtifacts = {
        ...terminalMarker(snapshot.runs[1], scenario, context),
        artifacts: scenario.artifacts
          .map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      };
    }
    markerHealth = {
      observed_at: queue.observed_at,
      dispatch: queue.dispatch,
      compute_dlq: queue.compute_dlq,
      reconciliation_dlq: queue.reconciliation_dlq,
      accounting_violations: 0,
      reconciliation_violations: 0,
      violations: [],
    };
  }

  return {
    schema_version: 1,
    kind: PROBE_KIND,
    verified: true,
    outcome: expectedOutcome,
    mode: expectedMode,
    target: 'production',
    started_at: new Date(startedAt).toISOString(),
    generated_at: queue.observed_at,
    dispatch: { ...expectedDispatch },
    active_rollout: predecessor === null
      ? null
      : {
          workflow_run_id: predecessor.dispatch.workflow_run_id,
          stage: predecessor.predecessor.stage,
          target: predecessor.predecessor.target,
          git_sha: predecessor.dispatch.git_sha,
        },
    live_state: liveState,
    latch_state: latchState,
    lifecycle,
    accounting,
    browser_artifacts: browserArtifacts,
    health: markerHealth,
  };
}

function writeDeterministicJson(path, value) {
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, destination);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

export function verifyComputeProbeEvidence({
  predecessorVerificationPath = null,
  initialLiveStatePath,
  suiteEvidencePath = null,
  runSetPath = null,
  operatorSnapshotPath = null,
  finalLiveStatePath,
  containerReadinessPath,
  queueHealthPath,
  emergencyStopStatusPath,
  outputPath,
  expectedMode,
  expectedOutcome,
  expectedRepository,
  expectedWorkflowRunId,
  expectedRunAttempt,
  expectedGitSha,
  expectedStartedAt,
}) {
  const requiredInputPaths = [
    initialLiveStatePath,
    finalLiveStatePath,
    containerReadinessPath,
    queueHealthPath,
    emergencyStopStatusPath,
  ].map((path) => resolve(path));
  const predecessorPath = predecessorVerificationPath === null
    ? null
    : resolve(predecessorVerificationPath);
  const admittedPaths = [suiteEvidencePath, runSetPath, operatorSnapshotPath]
    .filter((path) => path !== null)
    .map((path) => resolve(path));
  const allInputPaths = [
    ...(predecessorPath === null ? [] : [predecessorPath]),
    ...requiredInputPaths,
    ...admittedPaths,
  ];
  const destination = resolve(outputPath);
  if (
    new Set(allInputPaths).size !== allInputPaths.length ||
    allInputPaths.includes(destination)
  ) {
    fail('probe evidence input and output paths must be distinct');
  }
  const result = validateComputeProbeEvidence({
    predecessorVerification: predecessorPath === null
      ? null
      : readJson(predecessorPath, 'predecessor verification'),
    initialLiveState: readJson(requiredInputPaths[0], 'initial live state'),
    suiteEvidence: suiteEvidencePath === null
      ? null
      : readJson(resolve(suiteEvidencePath), 'probe suite'),
    runSetEvidence: runSetPath === null
      ? null
      : readJson(resolve(runSetPath), 'probe run set'),
    operatorSnapshot: operatorSnapshotPath === null
      ? null
      : readJson(resolve(operatorSnapshotPath), 'probe operator snapshot'),
    finalLiveState: readJson(requiredInputPaths[1], 'final live state'),
    containerReadiness: readJson(requiredInputPaths[2], 'container readiness'),
    queueHealth: readJson(requiredInputPaths[3], 'queue health'),
    emergencyStopStatus: readJson(requiredInputPaths[4], 'emergency-stop status'),
    expectedMode,
    expectedOutcome,
    expectedRepository,
    expectedWorkflowRunId,
    expectedRunAttempt,
    expectedGitSha,
    expectedStartedAt,
  });
  try {
    writeDeterministicJson(destination, result);
  } catch {
    fail('probe verification output could not be written');
  }
  return result;
}

const BASE_FLAGS = new Set([
  '--initial-live-state',
  '--final-live-state',
  '--container-readiness',
  '--queue-health',
  '--emergency-stop-status',
  '--expected-mode',
  '--expected-outcome',
  '--expected-repository',
  '--expected-workflow-run-id',
  '--expected-run-attempt',
  '--expected-git-sha',
  '--started-at',
  '--output',
]);
const ADMITTED_FLAGS = new Set([
  '--suite-evidence',
  '--run-set',
  '--operator-snapshot',
]);
const OPTIONAL_FLAGS = new Set(['--predecessor-verification']);

export function computeProbeValidatorArgs(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) {
    fail('command-line arguments are malformed');
  }
  const allowed = new Set([...BASE_FLAGS, ...ADMITTED_FLAGS, ...OPTIONAL_FLAGS]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(flag) || values.has(flag) || typeof value !== 'string' ||
      value.length === 0 || value.startsWith('--')
    ) {
      fail('command-line arguments are malformed');
    }
    values.set(flag, value);
  }
  if ([...BASE_FLAGS].some((flag) => !values.has(flag))) {
    fail('command-line arguments are incomplete');
  }
  const outcome = values.get('--expected-outcome');
  const admittedCount = [...ADMITTED_FLAGS].filter((flag) => values.has(flag)).length;
  if (
    (outcome === 'passed' &&
      (admittedCount !== ADMITTED_FLAGS.size ||
        !values.has('--predecessor-verification'))) ||
    (outcome === 'off_noop' && admittedCount !== 0)
  ) {
    fail('command-line evidence does not match the requested outcome');
  }
  return {
    predecessorVerificationPath: values.has('--predecessor-verification')
      ? resolve(values.get('--predecessor-verification'))
      : null,
    initialLiveStatePath: resolve(values.get('--initial-live-state')),
    suiteEvidencePath: values.has('--suite-evidence')
      ? resolve(values.get('--suite-evidence'))
      : null,
    runSetPath: values.has('--run-set') ? resolve(values.get('--run-set')) : null,
    operatorSnapshotPath: values.has('--operator-snapshot')
      ? resolve(values.get('--operator-snapshot'))
      : null,
    finalLiveStatePath: resolve(values.get('--final-live-state')),
    containerReadinessPath: resolve(values.get('--container-readiness')),
    queueHealthPath: resolve(values.get('--queue-health')),
    emergencyStopStatusPath: resolve(values.get('--emergency-stop-status')),
    outputPath: resolve(values.get('--output')),
    expectedMode: values.get('--expected-mode'),
    expectedOutcome: outcome,
    expectedRepository: values.get('--expected-repository'),
    expectedWorkflowRunId: values.get('--expected-workflow-run-id'),
    expectedRunAttempt: values.get('--expected-run-attempt'),
    expectedGitSha: values.get('--expected-git-sha'),
    expectedStartedAt: values.get('--started-at'),
  };
}

function main(argv) {
  verifyComputeProbeEvidence(computeProbeValidatorArgs(argv));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
