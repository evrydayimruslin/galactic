#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateRolloutState } from './verify-api-compute-rollout-state.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const NONNEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const LIGHT = /^(?:0|[1-9][0-9]*)\.[0-9]{12}$/u;
const EMPTY_SHA256 = createHash('sha256').update('', 'utf8').digest('hex');
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const CERTIFICATION_KIND = 'galactic_compute_deployed_certification';
const RUN_SET_KIND = 'galactic_compute_certification_run_set';
const IDENTITY_KIND = 'galactic_compute_canary_identity';
const VERIFICATION_KIND = 'galactic_compute_certification_verification';
const FIXTURE_FUNCTION = 'run_compute_certification';
const POLICY_FUNCTION = 'run_compute_policy_probe';
const POLICY_BASELINE = 'free';
const FIXED_ARTIFACT_SHA256 = '6ad9b8ea5280658dc4b229a2b6180d530c4d3824b541d218266ea6049e8b763b';
const COMPUTE_RATE_VERSION = 'compute-rate-v1';
const COMPUTE_RATE_LIGHT_PER_MS = '0.000002056000';
const COMPUTE_TEARDOWN_ALLOWANCE_MS = 15_000;

const SCENARIOS = Object.freeze([
  'sync_toolchain',
  'async_echo',
  'browser_https',
  'artifact_producer',
  'artifact_consumer',
  'exit_23',
  'timeout',
  'cancellable',
  'https_egress_boundaries',
  'raw_tcp_denied',
]);

const PROFILES = Object.freeze({
  'staging-full': Object.freeze({ target: 'staging', policy: 'canary' }),
  'production-canary': Object.freeze({ target: 'production', policy: 'canary' }),
  'production-global': Object.freeze({ target: 'production', policy: 'global' }),
});

const TARGET_WORKERS = Object.freeze({
  staging: Object.freeze({
    api: 'ultralight-api-staging',
    compute: 'galactic-compute-staging',
  }),
  production: Object.freeze({
    api: 'ultralight-api',
    compute: 'galactic-compute',
  }),
});

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
const CANCELLATION_KEYS = [
  'firstCallReceiptId',
  'replayCallReceiptId',
  'startedAt',
  'startedStatusCallReceiptId',
];
const POLICY_KEYS = [
  'baseline_policy',
  'cleanup',
  'free',
  'function_name',
  'off',
  'prior_routine_run_count',
  'routine_id',
];
const POLICY_FREE_KEYS = ['compute_run_id', 'observed_states', 'status'];
const POLICY_OFF_KEYS = [
  'compute_run_admitted',
  'error_code',
  'routine_run_id',
  'routine_status',
];
const POLICY_CLEANUP_KEYS = ['policy', 'routine_paused'];
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
const IDENTITY_KEYS = [
  'agent_id',
  'allowlist_entry',
  'kind',
  'owner_id',
  'schema_version',
  'target',
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

function fail(message) {
  throw new Error(`Compute certification evidence is invalid: ${message}`);
}

function record(value, expectedKeys, label) {
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

function validCalendarTimestamp(value, { utcOnly = false } = {}) {
  if (typeof value !== 'string') return false;
  const pattern = utcOnly
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/u
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

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} is not a boolean`);
  return value;
}

function emptyArray(value, label) {
  if (!Array.isArray(value) || value.length !== 0) {
    fail(`${label} must be empty`);
  }
}

function exactArray(value, expected, label) {
  if (
    !Array.isArray(value) || value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${label} does not match the fixed certification contract`);
  }
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

function expectedScenarioOutcome(scenario) {
  if (scenario === 'exit_23') {
    return { publicStatus: 'completed', exitCode: 23, state: 'succeeded' };
  }
  if (scenario === 'timeout') {
    return { publicStatus: 'failed', exitCode: null, state: 'failed' };
  }
  if (scenario === 'cancellable') {
    return { publicStatus: 'cancelled', exitCode: null, state: 'cancelled' };
  }
  return { publicStatus: 'completed', exitCode: 0, state: 'succeeded' };
}

function expectedArtifactPaths(scenario) {
  if (scenario === 'artifact_producer') {
    return ['output/certification-artifact.bin'];
  }
  if (scenario === 'artifact_consumer') {
    return [
      'output/artifact-consumer.json',
      'output/certification-artifact.bin',
    ];
  }
  if (scenario === 'browser_https') {
    return ['output/browser-https.json', 'output/browser-https.png'];
  }
  return [];
}

function validatePublicArtifact(value, scenario, finishedAt) {
  const artifact = record(value, ARTIFACT_KEYS, `${scenario} artifact`);
  const size = positiveInteger(artifact.size_bytes, `${scenario} artifact size`);
  const expiresAt = timestamp(
    artifact.expires_at,
    `${scenario} artifact expiry`,
    { utcOnly: true },
  );
  if (expiresAt <= finishedAt) {
    fail(`${scenario} artifact expiry is not after completion`);
  }
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
  const download = record(value, DOWNLOAD_KEYS, label);
  if (
    positiveInteger(download.byteLength, `${label} byte length`) !==
      artifact.size_bytes ||
    sha256(download.sha256, `${label} digest`) !== artifact.sha256
  ) {
    fail(`${label} does not match the public artifact`);
  }
}

function validateScenario(value, expectedScenario, suiteTimes, receiptIds) {
  const conditional = [];
  if (
    expectedScenario === 'artifact_producer' ||
    expectedScenario === 'artifact_consumer' ||
    expectedScenario === 'browser_https'
  ) conditional.push('artifact_download');
  if (expectedScenario === 'cancellable') conditional.push('cancellation');
  const scenario = record(
    value,
    [...SCENARIO_KEYS, ...conditional],
    `${expectedScenario} scenario`,
  );
  if (scenario.scenario !== expectedScenario) {
    fail('scenario order or identity changed');
  }
  const expected = expectedScenarioOutcome(expectedScenario);
  if (
    scenario.status !== expected.publicStatus ||
    scenario.exit_code !== expected.exitCode
  ) {
    fail(`${expectedScenario} terminal result is incorrect`);
  }
  const runId = uuid(scenario.run_id, `${expectedScenario} run id`);
  const receiptId = uuid(scenario.receipt_id, `${expectedScenario} receipt id`);
  const startReceipt = uuid(
    scenario.start_call_receipt_id,
    `${expectedScenario} start call receipt id`,
  );
  const statusReceipt = uuid(
    scenario.status_call_receipt_id,
    `${expectedScenario} status call receipt id`,
  );
  receiptIds.push(receiptId, startReceipt, statusReceipt);
  const allowedStates = new Set([
    'queued',
    'reserving',
    'starting',
    'running',
    'settlement_pending',
    'completed',
    'failed',
    'cancelled',
  ]);
  if (
    !Array.isArray(scenario.observed_states) ||
    scenario.observed_states.length === 0 ||
    scenario.observed_states.some((state) => !allowedStates.has(state)) ||
    scenario.observed_states.at(-1) !== expected.publicStatus
  ) {
    fail(`${expectedScenario} observed state history is invalid`);
  }
  const times = record(
    scenario.timestamps,
    SCENARIO_TIMESTAMP_KEYS,
    `${expectedScenario} timestamps`,
  );
  const createdAt = timestamp(
    times.created_at,
    `${expectedScenario} creation timestamp`,
    { utcOnly: true },
  );
  const startedAt = timestamp(
    times.started_at,
    `${expectedScenario} start timestamp`,
    { utcOnly: true },
  );
  const finishedAt = timestamp(
    times.finished_at,
    `${expectedScenario} finish timestamp`,
    { utcOnly: true },
  );
  if (
    createdAt < suiteTimes.startedAt || createdAt > startedAt ||
    startedAt > finishedAt || finishedAt > suiteTimes.generatedAt
  ) {
    fail(`${expectedScenario} timestamp ordering is invalid`);
  }
  sha256(scenario.stdout_sha256, `${expectedScenario} stdout digest`);
  const stderr = sha256(
    scenario.stderr_sha256,
    `${expectedScenario} stderr digest`,
  );
  if (
    !['timeout', 'cancellable'].includes(expectedScenario) &&
    stderr !== EMPTY_SHA256
  ) {
    fail(`${expectedScenario} stderr was not empty`);
  }
  if (!Array.isArray(scenario.artifacts)) {
    fail(`${expectedScenario} artifacts must be an array`);
  }
  const artifacts = scenario.artifacts.map((artifact) =>
    validatePublicArtifact(artifact, expectedScenario, finishedAt)
  );
  exactArray(
    artifacts.map((artifact) => artifact.path).sort(),
    expectedArtifactPaths(expectedScenario),
    `${expectedScenario} artifact paths`,
  );
  unique(artifacts.map((artifact) => artifact.artifact_id), `${expectedScenario} artifacts`);

  if (expectedScenario === 'artifact_producer') {
    if (artifacts[0].sha256 !== FIXED_ARTIFACT_SHA256) {
      fail('artifact producer digest changed');
    }
    validateDownload(
      scenario.artifact_download,
      artifacts[0],
      'artifact producer download',
    );
  } else if (
    expectedScenario === 'artifact_consumer' ||
    expectedScenario === 'browser_https'
  ) {
    if (
      !Array.isArray(scenario.artifact_download) ||
      scenario.artifact_download.length !== artifacts.length
    ) {
      fail(`${expectedScenario} download proof count is incorrect`);
    }
    scenario.artifact_download.forEach((download, index) =>
      validateDownload(download, artifacts[index], `${expectedScenario} download`)
    );
  }
  if (expectedScenario === 'artifact_consumer') {
    const roundTrip = artifacts.find((artifact) =>
      artifact.path === 'output/certification-artifact.bin'
    );
    if (roundTrip?.sha256 !== FIXED_ARTIFACT_SHA256) {
      fail('artifact consumer did not preserve the producer digest');
    }
  }
  if (expectedScenario === 'cancellable') {
    const cancellation = record(
      scenario.cancellation,
      CANCELLATION_KEYS,
      'cancellation proof',
    );
    const first = uuid(cancellation.firstCallReceiptId, 'first cancellation receipt');
    const replay = uuid(cancellation.replayCallReceiptId, 'replay cancellation receipt');
    const startedStatus = uuid(
      cancellation.startedStatusCallReceiptId,
      'running-status call receipt',
    );
    const cancellationStartedAt = timestamp(
      cancellation.startedAt,
      'cancellation body start',
      { utcOnly: true },
    );
    receiptIds.push(first, replay, startedStatus);
    if (
      first === replay || cancellationStartedAt !== startedAt ||
      !scenario.observed_states.includes('running')
    ) {
      fail('cancellation did not prove a running Compute body');
    }
  }
  return { ...scenario, run_id: runId, receipt_id: receiptId, artifacts };
}

function validatePolicyPillar(value) {
  const policy = record(value, POLICY_KEYS, 'Policy Pillar evidence');
  if (
    policy.function_name !== POLICY_FUNCTION ||
    policy.baseline_policy !== POLICY_BASELINE
  ) {
    fail('Policy Pillar identity or baseline is invalid');
  }
  const routineId = uuid(policy.routine_id, 'Policy Pillar routine id');
  nonnegativeInteger(
    policy.prior_routine_run_count,
    'Policy Pillar prior run count',
  );
  const free = record(policy.free, POLICY_FREE_KEYS, 'free-policy proof');
  const freeRunId = uuid(free.compute_run_id, 'free-policy Compute run id');
  const allowedStates = new Set([
    'queued',
    'reserving',
    'starting',
    'running',
    'settlement_pending',
    'completed',
  ]);
  if (
    free.status !== 'completed' ||
    !Array.isArray(free.observed_states) ||
    free.observed_states.length === 0 ||
    free.observed_states.some((state) => !allowedStates.has(state)) ||
    free.observed_states.at(-1) !== 'completed'
  ) {
    fail('free policy did not complete one Compute run');
  }
  const off = record(policy.off, POLICY_OFF_KEYS, 'off-policy proof');
  const offRoutineRunId = uuid(off.routine_run_id, 'off-policy routine run id');
  if (
    off.routine_status !== 'failed' || off.error_code !== 'policy_off' ||
    off.compute_run_admitted !== false
  ) {
    fail('off policy did not return the exact Policy Pillar denial');
  }
  const cleanup = record(
    policy.cleanup,
    POLICY_CLEANUP_KEYS,
    'Policy Pillar cleanup',
  );
  if (
    cleanup.routine_paused !== true ||
    cleanup.policy !== POLICY_BASELINE
  ) {
    fail('Policy Pillar cleanup was not verified');
  }
  if (new Set([routineId, freeRunId, offRoutineRunId]).size !== 3) {
    fail('Policy Pillar reused an execution identity');
  }
  return { ...policy, freeRunId, routineId, offRoutineRunId };
}

function validateSuite(value, expected) {
  const suite = record(value, SUITE_KEYS, 'suite evidence');
  if (
    suite.schema_version !== 1 || suite.kind !== CERTIFICATION_KIND ||
    suite.verified !== true || suite.operator_snapshot_required !== true ||
    suite.target !== expected.target || suite.profile !== expected.profile ||
    suite.candidate_sha !== expected.candidateSha ||
    suite.workflow_run_id !== expected.workflowRunId ||
    suite.function_name !== FIXTURE_FUNCTION
  ) {
    fail('suite provenance or verification metadata is incorrect');
  }
  const agentId = uuid(suite.agent_id, 'suite Agent id');
  const fixtureReceipt = uuid(
    suite.fixture_identity_call_receipt_id,
    'fixture identity call receipt id',
  );
  const marker =
    `galactic-compute-certification-v1:${expected.candidateSha}:${expected.workflowRunId}\n`;
  if (
    sha256(suite.marker_sha256, 'suite marker digest') !==
      createHash('sha256').update(marker, 'utf8').digest('hex')
  ) {
    fail('suite marker is not bound to this dispatch');
  }
  const startedAt = timestamp(suite.started_at, 'suite start', { utcOnly: true });
  const generatedAt = timestamp(
    suite.generated_at,
    'suite generation',
    { utcOnly: true },
  );
  if (generatedAt < startedAt) fail('suite generation predates its start');
  const cleanup = record(suite.cleanup, CLEANUP_KEYS, 'suite cleanup');
  positiveInteger(cleanup.settings_revision, 'cleanup settings revision');
  if (
    cleanup.active_compute_runs_remaining !== 0 ||
    cleanup.active_routine_runs_remaining !== 0 ||
    cleanup.compute_policy_disabled !== true ||
    cleanup.policy_probe_paused_and_free !== true
  ) {
    fail('suite cleanup was not fully verified');
  }
  if (!Array.isArray(suite.scenarios) || suite.scenarios.length !== SCENARIOS.length) {
    fail('suite scenario cardinality changed');
  }
  const receiptIds = [fixtureReceipt];
  const scenarios = suite.scenarios.map((scenario, index) =>
    validateScenario(
      scenario,
      SCENARIOS[index],
      { startedAt, generatedAt },
      receiptIds,
    )
  );
  unique(scenarios.map((scenario) => scenario.run_id), 'scenario runs');
  unique(receiptIds, 'certification receipts');
  const allArtifactIds = scenarios.flatMap((scenario) =>
    scenario.artifacts.map((artifact) => artifact.artifact_id)
  );
  unique(allArtifactIds, 'public output artifacts');
  const policy = validatePolicyPillar(suite.policy_pillar);
  if (scenarios.some((scenario) => scenario.run_id === policy.freeRunId)) {
    fail('Policy Pillar and direct scenarios reused a run');
  }
  return {
    ...suite,
    agentId,
    startedAt,
    generatedAt,
    scenarios,
    policy,
    certificationReceiptIds: receiptIds,
  };
}

function validateRunSet(value, suite, expected) {
  const runSet = record(value, RUN_SET_KEYS, 'run-set evidence');
  const expectedRunIds = [
    ...suite.scenarios.map((scenario) => scenario.run_id),
    suite.policy.freeRunId,
  ];
  if (
    runSet.schema_version !== 1 || runSet.kind !== RUN_SET_KIND ||
    runSet.target !== expected.target ||
    runSet.candidate_sha !== expected.candidateSha ||
    runSet.workflow_run_id !== expected.workflowRunId ||
    runSet.agent_id !== suite.agentId || runSet.since !== suite.started_at ||
    runSet.generated_at !== suite.generated_at
  ) {
    fail('run set is not bound to the suite');
  }
  exactArray(runSet.run_ids, expectedRunIds, 'run-set identities');
  runSet.run_ids.forEach((runId) => uuid(runId, 'run-set run id'));
  unique(runSet.run_ids, 'run set');
  return { ...runSet, run_ids: expectedRunIds };
}

function validateIdentity(value, suite, expected) {
  const identity = record(value, IDENTITY_KEYS, 'canary identity');
  const ownerId = uuid(identity.owner_id, 'canary owner id');
  const agentId = uuid(identity.agent_id, 'canary Agent id');
  if (
    identity.schema_version !== 1 || identity.kind !== IDENTITY_KIND ||
    identity.target !== expected.target || agentId !== suite.agentId ||
    identity.allowlist_entry !== `${ownerId}/${agentId}`
  ) {
    fail('canary identity is not bound to the certification principal');
  }
  return { ...identity, ownerId, agentId };
}

function validatePromotedState(value, identity, expected) {
  let state;
  try {
    state = validateRolloutState(value);
  } catch {
    fail('promoted rollout state is invalid');
  }
  const profile = PROFILES[expected.profile];
  const target = TARGET_WORKERS[expected.target];
  if (
    state.phase !== 'promoted' || state.target !== expected.target ||
    state.policy !== profile.policy || state.dispatch.git_sha !== expected.candidateSha ||
    state.dispatch.workflow_run_id !== expected.workflowRunId ||
    state.certification_principal !== identity.allowlist_entry ||
    state.api.worker !== target.api || state.compute.worker !== target.compute
  ) {
    fail('promoted rollout state does not match the certification dispatch');
  }
  if (profile.policy === 'canary') {
    exactArray(
      state.canary_allowlist,
      [identity.allowlist_entry],
      'promoted canary allowlist',
    );
  } else {
    exactArray(state.canary_allowlist, [], 'promoted global allowlist');
  }
  return state;
}

function validateSnapshotArtifact(value, runLabel) {
  const artifact = record(
    value,
    SNAPSHOT_ARTIFACT_KEYS,
    `${runLabel} snapshot artifact`,
  );
  const validState = artifact.direction === 'output'
    ? artifact.state === 'ready'
    : artifact.direction === 'input' &&
      ['ready', 'deleted'].includes(artifact.state);
  if (!validState || artifact.object_deleted !== false) {
    fail(`${runLabel} snapshot artifact lifecycle is invalid`);
  }
  positiveInteger(artifact.state_version, `${runLabel} artifact state version`);
  const size = positiveInteger(artifact.size_bytes, `${runLabel} artifact size`);
  timestamp(artifact.expires_at, `${runLabel} artifact expiry`);
  return {
    ...artifact,
    artifact_id: uuid(artifact.artifact_id, `${runLabel} artifact id`),
    sha256: sha256(artifact.sha256, `${runLabel} artifact digest`),
    size_bytes: size,
  };
}

function validateAccounting(run, runLabel) {
  const cardinality = record(run.cardinality, CARDINALITY_KEYS, `${runLabel} cardinality`);
  const counts = Object.fromEntries(
    CARDINALITY_KEYS.map((key) => [
      key,
      nonnegativeInteger(cardinality[key], `${runLabel} ${key}`),
    ]),
  );
  if (
    counts.budget_rows !== 1 || counts.receipt_rows !== 1 ||
    counts.token_rows < 1 ||
    counts.artifact_rows !==
      counts.input_artifact_rows + counts.output_artifact_rows ||
    counts.projected_artifact_rows !== counts.artifact_rows
  ) {
    fail(`${runLabel} persistence cardinality is not conserved`);
  }

  const backing = record(run.backing, BACKING_KEYS, `${runLabel} backing`);
  for (const key of BACKING_KEYS) boolean(backing[key], `${runLabel} ${key}`);
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
    if (backing[key] !== true) fail(`${runLabel} backing identity is inconsistent`);
  }

  const budget = record(run.budget, BUDGET_KEYS, `${runLabel} budget`);
  const receipt = record(run.receipt, RECEIPT_KEYS, `${runLabel} receipt`);
  if (
    budget.status !== 'settled' ||
    budget.billing_mode !== run.billing_mode ||
    receipt.billing_mode !== run.billing_mode || receipt.id !== run.receipt_id ||
    receipt.outcome !== run.state ||
    budget.rate_version !== COMPUTE_RATE_VERSION ||
    budget.rate_light_per_ms !== COMPUTE_RATE_LIGHT_PER_MS ||
    receipt.rate_version !== COMPUTE_RATE_VERSION
  ) {
    fail(`${runLabel} settlement identity or state is inconsistent`);
  }
  const reserved = light(budget.reserved_light, `${runLabel} budget reserved Light`);
  const actual = light(budget.actual_light, `${runLabel} budget actual Light`);
  const released = light(budget.released_light, `${runLabel} budget released Light`);
  const receiptReserved = light(
    receipt.reserved_light,
    `${runLabel} receipt reserved Light`,
  );
  const receiptActual = light(receipt.actual_light, `${runLabel} receipt actual Light`);
  const receiptReleased = light(
    receipt.released_light,
    `${runLabel} receipt released Light`,
  );
  if (
    reserved !== receiptReserved || actual !== receiptActual ||
    released !== receiptReleased
  ) {
    fail(`${runLabel} budget and receipt accounting differ`);
  }
  timestamp(budget.expires_at, `${runLabel} budget expiry`);
  timestamp(budget.settled_at, `${runLabel} budget settlement`);
  timestamp(receipt.created_at, `${runLabel} receipt creation`);
  if (receipt.worker_wall_ms === null || budget.actual_wall_ms === null) {
    fail(`${runLabel} did not execute a billable body`);
  }
  const workerWall = nonnegativeInteger(
    receipt.worker_wall_ms,
    `${runLabel} worker wall milliseconds`,
  );
  const actualWall = nonnegativeInteger(
    budget.actual_wall_ms,
    `${runLabel} actual wall milliseconds`,
  );
  const reservedWall = positiveInteger(
    budget.reserved_wall_ms,
    `${runLabel} reserved wall milliseconds`,
  );
  const budgetTeardown = nonnegativeInteger(
    budget.teardown_allowance_ms,
    `${runLabel} budget teardown allowance`,
  );
  const receiptTeardown = nonnegativeInteger(
    receipt.teardown_allowance_ms,
    `${runLabel} receipt teardown allowance`,
  );
  const billedWall = nonnegativeInteger(
    receipt.billed_wall_ms,
    `${runLabel} billed wall milliseconds`,
  );
  const expectedBilled = run.billing_mode === 'wallet'
    ? Math.min(workerWall, reservedWall)
    : workerWall;
  const rate = light(
    budget.rate_light_per_ms,
    `${runLabel} budget rate Light per millisecond`,
  );
  if (
    actualWall !== workerWall ||
    budgetTeardown !== COMPUTE_TEARDOWN_ALLOWANCE_MS ||
    receiptTeardown !== budgetTeardown || billedWall !== expectedBilled ||
    reserved !== BigInt(reservedWall) * rate ||
    actual !== BigInt(expectedBilled) * rate
  ) {
    fail(`${runLabel} tariff or wall accounting is inconsistent`);
  }

  if (run.billing_mode === 'wallet') {
    if (
      actual > reserved || actual + released !== reserved ||
      backing.run_capacity_reservation !== false ||
      backing.budget_hold !== true ||
      backing.budget_capacity_reservation !== false ||
      backing.receipt_hold !== true ||
      backing.receipt_capacity_reservation !== false ||
      backing.receipt_cloud_usage_event !== true ||
      receipt.capacity_settlement_status !== 'not_applicable'
    ) {
      fail(`${runLabel} wallet accounting or backing is invalid`);
    }
  } else if (run.billing_mode === 'subscription_capacity') {
    const expectedReleased = reserved > actual ? reserved - actual : 0n;
    if (
      released !== expectedReleased ||
      backing.run_capacity_reservation !== true ||
      backing.budget_hold !== false ||
      backing.budget_capacity_reservation !== true ||
      backing.receipt_hold !== false ||
      backing.receipt_capacity_reservation !== true ||
      backing.receipt_cloud_usage_event !== false ||
      receipt.capacity_settlement_status !== 'settled'
    ) {
      fail(`${runLabel} capacity accounting or backing is invalid`);
    }
  } else {
    fail(`${runLabel} billing mode is unsupported`);
  }
  return counts;
}

function validateSnapshotRun(value, index, context) {
  const runLabel = `selected run ${index + 1}`;
  const run = record(value, RUN_KEYS, runLabel);
  const expectedRunId = context.runSet.run_ids[index];
  if (
    uuid(run.run_id, `${runLabel} id`) !== expectedRunId ||
    uuid(run.owner_id, `${runLabel} owner id`) !== context.identity.ownerId ||
    uuid(run.agent_id, `${runLabel} Agent id`) !== context.identity.agentId ||
    uuid(run.capacity_agent_id, `${runLabel} capacity Agent id`) !==
      context.identity.agentId ||
    digest(run.environment_digest, `${runLabel} environment digest`) !==
      context.promoted.environment_digest
  ) {
    fail(`${runLabel} principal, order, or environment binding is incorrect`);
  }
  const isPolicy = index === SCENARIOS.length;
  const scenario = isPolicy ? null : context.suite.scenarios[index];
  const expectedState = isPolicy ? 'succeeded' : expectedScenarioOutcome(scenario.scenario).state;
  if (
    run.caller_function !== (isPolicy ? POLICY_FUNCTION : FIXTURE_FUNCTION) ||
    run.state !== expectedState ||
    !['succeeded', 'failed', 'cancelled', 'expired', 'revoked'].includes(run.state)
  ) {
    fail(`${runLabel} terminal state or caller is incorrect`);
  }
  positiveInteger(run.state_version, `${runLabel} state version`);
  sha256(run.directive_hash, `${runLabel} directive hash`);
  sha256(run.request_hash, `${runLabel} request hash`);
  const createdAt = timestamp(run.created_at, `${runLabel} creation`);
  const updatedAt = timestamp(run.updated_at, `${runLabel} update`);
  const expiresAt = timestamp(run.expires_at, `${runLabel} expiry`);
  const startedAt = run.started_at === null ? null : timestamp(run.started_at, `${runLabel} start`);
  const finishedAt = timestamp(run.finished_at, `${runLabel} finish`);
  if (
    createdAt < context.suite.startedAt || createdAt > updatedAt ||
    expiresAt <= createdAt || finishedAt < createdAt || finishedAt > updatedAt ||
    (startedAt !== null && (startedAt < createdAt || startedAt > finishedAt))
  ) {
    fail(`${runLabel} timestamp ordering is invalid`);
  }
  emptyArray(run.violations, `${runLabel} violations`);
  if (
    nonnegativeInteger(
      run.terminal_active_token_count,
      `${runLabel} terminal active token count`,
    ) !== 0
  ) {
    fail(`${runLabel} retains an active execution token`);
  }
  const receiptId = uuid(run.receipt_id, `${runLabel} reserved receipt id`);
  const counts = validateAccounting(run, runLabel);
  const artifacts = Array.isArray(run.artifacts)
    ? run.artifacts.map((artifact) => validateSnapshotArtifact(artifact, runLabel))
    : fail(`${runLabel} artifacts must be an array`);
  unique(artifacts.map((artifact) => artifact.artifact_id), `${runLabel} artifacts`);
  for (let index = 1; index < artifacts.length; index += 1) {
    const previous = `${artifacts[index - 1].direction}:${artifacts[index - 1].artifact_id}`;
    const current = `${artifacts[index].direction}:${artifacts[index].artifact_id}`;
    if (current <= previous) {
      fail(`${runLabel} snapshot artifacts are not canonically ordered`);
    }
  }
  if (artifacts.length !== counts.artifact_rows) {
    fail(`${runLabel} artifact cardinality does not match its projection`);
  }
  const input = artifacts.filter((artifact) => artifact.direction === 'input');
  const output = artifacts.filter((artifact) => artifact.direction === 'output');
  if (
    input.length !== counts.input_artifact_rows ||
    output.length !== counts.output_artifact_rows
  ) {
    fail(`${runLabel} artifact direction cardinality is inconsistent`);
  }
  if (scenario !== null) {
    if (receiptId !== scenario.receipt_id) {
      fail(`${runLabel} receipt is not bound to the public scenario`);
    }
    const publicById = new Map(
      scenario.artifacts.map((artifact) => [artifact.artifact_id, artifact]),
    );
    if (output.length !== publicById.size) {
      fail(`${runLabel} output artifact projection is incomplete`);
    }
    for (const artifact of output) {
      const publicArtifact = publicById.get(artifact.artifact_id);
      if (
        publicArtifact === undefined || artifact.sha256 !== publicArtifact.sha256 ||
        artifact.size_bytes !== publicArtifact.size_bytes
      ) {
        fail(`${runLabel} output artifact differs from the public proof`);
      }
    }
    if (scenario.scenario === 'artifact_consumer') {
      if (
        input.length !== 1 || input[0].sha256 !== FIXED_ARTIFACT_SHA256 ||
        input[0].size_bytes !==
          context.suite.scenarios[3].artifacts[0].size_bytes
      ) {
        fail('artifact consumer input alias is not bound to the producer');
      }
    } else if (input.length !== 0) {
      fail(`${runLabel} has an unexpected input artifact alias`);
    }
  } else if (artifacts.length !== 0) {
    fail('Policy Pillar run produced unexpected artifacts');
  }
  return { ...run, receiptId, artifacts };
}

function validateSnapshot(value, context) {
  const snapshot = record(value, SNAPSHOT_KEYS, 'operator snapshot');
  if (
    snapshot.schema_version !== 1 || snapshot.owner_id !== context.identity.ownerId ||
    snapshot.agent_id !== context.identity.agentId || snapshot.latch_state !== 'clear'
  ) {
    fail('operator snapshot principal or latch state is incorrect');
  }
  const generatedAt = timestamp(snapshot.generated_at, 'snapshot generation');
  const since = timestamp(snapshot.since, 'snapshot observation window');
  if (
    since !== context.suite.startedAt || generatedAt < context.suite.generatedAt
  ) {
    fail('operator snapshot observation window is not bound to the suite');
  }
  const expectedCount = context.runSet.run_ids.length;
  if (
    nonnegativeInteger(
        snapshot.requested_run_count,
        'snapshot requested run count',
      ) !== expectedCount ||
    nonnegativeInteger(
        snapshot.selected_run_count,
        'snapshot selected run count',
      ) !== expectedCount ||
    !Array.isArray(snapshot.runs) || snapshot.runs.length !== expectedCount
  ) {
    fail('operator snapshot did not select every requested run');
  }
  emptyArray(snapshot.violations, 'snapshot violations');
  const health = record(snapshot.health, HEALTH_KEYS, 'snapshot health');
  for (const key of HEALTH_KEYS.filter((key) => key !== 'violations')) {
    if (nonnegativeInteger(health[key], `snapshot health ${key}`) !== 0) {
      fail('snapshot health is not clean');
    }
  }
  emptyArray(health.violations, 'snapshot health violations');
  const runs = snapshot.runs.map((run, index) => validateSnapshotRun(run, index, context));
  unique(runs.map((run) => run.receiptId), 'selected run receipts');
  if (context.suite.certificationReceiptIds.includes(runs.at(-1).receiptId)) {
    fail('Policy Pillar receipt reused a certification call identity');
  }
  const allArtifactIds = runs.flatMap((run) =>
    run.artifacts.map((artifact) => artifact.artifact_id)
  );
  unique(allArtifactIds, 'snapshot artifacts');
  return { ...snapshot, generatedAt, runs };
}

export function validateComputeCertificationEvidence({
  suiteEvidence,
  runSetEvidence,
  operatorSnapshot,
  canaryIdentity,
  promotedState,
  expectedTarget,
  expectedProfile,
  expectedCandidateSha,
  expectedWorkflowRunId,
}) {
  const profile = PROFILES[expectedProfile];
  if (!profile || profile.target !== expectedTarget) {
    fail('expected profile and target are incompatible');
  }
  if (typeof expectedCandidateSha !== 'string' || !GIT_SHA.test(expectedCandidateSha)) {
    fail('expected candidate SHA is malformed');
  }
  if (
    typeof expectedWorkflowRunId !== 'string' ||
    !POSITIVE_INTEGER.test(expectedWorkflowRunId)
  ) {
    fail('expected workflow run id is malformed');
  }
  const expected = {
    target: expectedTarget,
    profile: expectedProfile,
    candidateSha: expectedCandidateSha,
    workflowRunId: expectedWorkflowRunId,
  };
  const suite = validateSuite(suiteEvidence, expected);
  const runSet = validateRunSet(runSetEvidence, suite, expected);
  const identity = validateIdentity(canaryIdentity, suite, expected);
  const promoted = validatePromotedState(promotedState, identity, expected);
  const snapshot = validateSnapshot(operatorSnapshot, {
    suite,
    runSet,
    identity,
    promoted,
  });
  const browser = suite.scenarios[2];
  const consumer = suite.scenarios[4];
  return {
    schema_version: 1,
    kind: VERIFICATION_KIND,
    verified: true,
    target: expectedTarget,
    profile: expectedProfile,
    candidate_sha: expectedCandidateSha,
    workflow_run_id: expectedWorkflowRunId,
    owner_id: identity.ownerId,
    agent_id: identity.agentId,
    environment_digest: promoted.environment_digest,
    promoted_api_version_id: promoted.api.version_id,
    promoted_compute_version_id: promoted.compute.version_id,
    suite_generated_at: new Date(suite.generatedAt).toISOString(),
    snapshot_generated_at: new Date(snapshot.generatedAt).toISOString(),
    scenario_run_ids: suite.scenarios.map((scenario) => scenario.run_id),
    policy_compute_run_id: suite.policy.freeRunId,
    compute_receipt_ids: snapshot.runs.map((run) => run.receiptId),
    artifact_digests: {
      deterministic_fixture: FIXED_ARTIFACT_SHA256,
      browser: browser.artifacts.map((artifact) => artifact.sha256).sort(),
      consumer: consumer.artifacts.map((artifact) => artifact.sha256).sort(),
    },
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

export function verifyComputeCertificationEvidence({
  suiteEvidencePath,
  runSetPath,
  operatorSnapshotPath,
  canaryIdentityPath,
  promotedStatePath,
  outputPath,
  expectedTarget,
  expectedProfile,
  expectedCandidateSha,
  expectedWorkflowRunId,
}) {
  const inputPaths = [
    suiteEvidencePath,
    runSetPath,
    operatorSnapshotPath,
    canaryIdentityPath,
    promotedStatePath,
  ].map((path) => resolve(path));
  const destination = resolve(outputPath);
  if (
    new Set(inputPaths).size !== inputPaths.length ||
    inputPaths.includes(destination)
  ) {
    fail('evidence input and output paths must be distinct');
  }
  const result = validateComputeCertificationEvidence({
    suiteEvidence: readJson(inputPaths[0], 'suite evidence'),
    runSetEvidence: readJson(inputPaths[1], 'run-set evidence'),
    operatorSnapshot: readJson(inputPaths[2], 'operator snapshot'),
    canaryIdentity: readJson(inputPaths[3], 'canary identity'),
    promotedState: readJson(inputPaths[4], 'promoted rollout state'),
    expectedTarget,
    expectedProfile,
    expectedCandidateSha,
    expectedWorkflowRunId,
  });
  try {
    writeDeterministicJson(destination, result);
  } catch {
    fail('combined verification output could not be written');
  }
  return result;
}

export function computeCertificationValidatorArgs(argv) {
  const required = new Set([
    '--suite-evidence',
    '--run-set',
    '--operator-snapshot',
    '--canary-identity',
    '--promoted-state',
    '--expected-target',
    '--expected-profile',
    '--expected-candidate-sha',
    '--expected-workflow-run-id',
    '--output',
  ]);
  if (argv.length !== required.size * 2) {
    fail('command-line arguments are incomplete');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !required.has(flag) || values.has(flag) || typeof value !== 'string' ||
      value.length === 0 || value.startsWith('--')
    ) {
      fail('command-line arguments are malformed');
    }
    values.set(flag, value);
  }
  if ([...required].some((flag) => !values.has(flag))) {
    fail('command-line arguments are incomplete');
  }
  return {
    suiteEvidencePath: resolve(values.get('--suite-evidence')),
    runSetPath: resolve(values.get('--run-set')),
    operatorSnapshotPath: resolve(values.get('--operator-snapshot')),
    canaryIdentityPath: resolve(values.get('--canary-identity')),
    promotedStatePath: resolve(values.get('--promoted-state')),
    outputPath: resolve(values.get('--output')),
    expectedTarget: values.get('--expected-target'),
    expectedProfile: values.get('--expected-profile'),
    expectedCandidateSha: values.get('--expected-candidate-sha'),
    expectedWorkflowRunId: values.get('--expected-workflow-run-id'),
  };
}

function main(argv) {
  verifyComputeCertificationEvidence(computeCertificationValidatorArgs(argv));
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
