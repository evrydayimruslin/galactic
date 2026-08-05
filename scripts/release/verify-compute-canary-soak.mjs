#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateRolloutState } from './verify-api-compute-rollout-state.mjs';

export const COMPUTE_CANARY_SOAK_MINIMUM_SECONDS = 24 * 60 * 60;
export const COMPUTE_CANARY_SOAK_MAX_LIFECYCLE_GAP_SECONDS = 35 * 60;
export const COMPUTE_CANARY_SOAK_MAX_BROWSER_GAP_SECONDS = 70 * 60;

const MAX_INVENTORY_STALENESS_MS = 5 * 60 * 1_000;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const NONNEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const RELEASE_TAG = /^v[0-9A-Za-z][0-9A-Za-z._-]*$/u;
const PROBE_WORKFLOW = '.github/workflows/compute-probe.yml';
const API_DEPLOY_WORKFLOW = '.github/workflows/api-deploy.yml';
const COMPUTE_DEPLOY_WORKFLOW = '.github/workflows/compute-deploy.yml';
const COMPUTE_WORKER_REFRESH_WORKFLOW =
  '.github/workflows/compute-worker-refresh.yml';
const WORKFLOW_PATHS = Object.freeze([
  API_DEPLOY_WORKFLOW,
  COMPUTE_DEPLOY_WORKFLOW,
  PROBE_WORKFLOW,
  COMPUTE_WORKER_REFRESH_WORKFLOW,
]);
const PREDECESSOR_KIND = 'galactic_compute_rollout_predecessor_verification';
const PROBE_KIND = 'galactic_compute_production_probe';
const RUN_INVENTORY_KIND = 'galactic_compute_soak_run_inventory';
const ARTIFACT_INVENTORY_KIND = 'galactic_compute_soak_artifact_inventory';
const VERIFICATION_KIND = 'galactic_compute_canary_soak_verification';
const PROBE_FILE = 'compute-canary-probe.json';
const PRODUCTION_DISPATCH_QUEUE = 'galactic-compute';
const PRODUCTION_COMPUTE_DLQ = 'galactic-compute-dlq';
const PRODUCTION_RECONCILIATION_DLQ =
  'galactic-compute-reconciliation-dlq';
const EXPECTED_BROWSER_PATHS = Object.freeze([
  'output/browser-https.json',
  'output/browser-https.png',
]);

const DISPATCH_KEYS = [
  'git_sha',
  'repository',
  'run_attempt',
  'workflow_run_id',
];
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
const RUN_INVENTORY_KEYS = [
  'captured_at',
  'kind',
  'queries',
  'repository',
  'schema_version',
  'window_ended_at',
  'window_started_at',
];
const RUN_QUERY_KEYS = ['total_count', 'workflow_path', 'workflow_runs'];
const RUN_KEYS = [
  'conclusion',
  'created_at',
  'event',
  'head_branch',
  'head_sha',
  'id',
  'run_attempt',
  'run_started_at',
  'status',
  'updated_at',
];
const ARTIFACT_INVENTORY_KEYS = [
  'artifacts',
  'captured_at',
  'kind',
  'repository',
  'schema_version',
  'total_count',
];
const ARTIFACT_KEYS = [
  'created_at',
  'expired',
  'expires_at',
  'head_sha',
  'id',
  'name',
  'run_attempt',
  'size_in_bytes',
  'updated_at',
  'workflow_run_id',
];
const PROBE_KEYS = [
  'accounting',
  'active_rollout',
  'browser_artifacts',
  'dispatch',
  'generated_at',
  'health',
  'kind',
  'latch_state',
  'lifecycle',
  'live_state',
  'mode',
  'outcome',
  'schema_version',
  'started_at',
  'target',
  'verified',
];
const ACTIVE_ROLLOUT_KEYS = [
  'git_sha',
  'stage',
  'target',
  'workflow_run_id',
];
const TERMINAL_RUN_KEYS = [
  'agent_id',
  'created_at',
  'environment_digest',
  'finished_at',
  'owner_id',
  'receipt_id',
  'run_id',
  'started_at',
  'state',
];
const ACCOUNTING_KEYS = [
  'accounting_violations',
  'receipt_ids',
  'reconciliation_violations',
  'run_ids',
  'snapshot_generated_at',
  'violations',
];
const BROWSER_KEYS = [...TERMINAL_RUN_KEYS, 'artifacts'];
const BROWSER_ARTIFACT_KEYS = ['path', 'sha256'];
const HEALTH_KEYS = [
  'accounting_violations',
  'compute_dlq',
  'dispatch',
  'observed_at',
  'reconciliation_dlq',
  'reconciliation_violations',
  'violations',
];
const DISPATCH_HEALTH_KEYS = ['backlog', 'name', 'oldest_age_seconds'];
const DLQ_KEYS = ['baseline_count', 'final_count', 'name'];

function fail(message) {
  throw new Error(`Compute canary soak is invalid: ${message}`);
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

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is missing or is not valid JSON`);
  }
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

function positiveInteger(value, label) {
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

function nonnegativeInteger(value, label) {
  if (
    !(
      (typeof value === 'string' && NONNEGATIVE_INTEGER.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    )
  ) {
    fail(`${label} is not a nonnegative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} exceeds the safe range`);
  return parsed;
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    fail(`${label} is not a canonical UUID`);
  }
  return value;
}

function dispatch(value, label) {
  const row = exactKeys(value, DISPATCH_KEYS, label);
  if (
    typeof row.repository !== 'string' || !REPOSITORY.test(row.repository) ||
    typeof row.git_sha !== 'string' || !GIT_SHA.test(row.git_sha)
  ) {
    fail(`${label} repository or git SHA is malformed`);
  }
  return {
    repository: row.repository,
    workflow_run_id: positiveInteger(
      row.workflow_run_id,
      `${label} workflow run id`,
    ),
    run_attempt: positiveInteger(row.run_attempt, `${label} run attempt`),
    git_sha: row.git_sha,
  };
}

function sameDispatch(left, right) {
  return DISPATCH_KEYS.every((key) => left[key] === right[key]);
}

function emptyArray(value, label) {
  if (!Array.isArray(value) || value.length !== 0) {
    fail(`${label} must be an empty array`);
  }
}

function canonicalUniqueUuidArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const rows = value.map((item, index) => canonicalUuid(item, `${label} ${index}`));
  if (
    rows.length !== new Set(rows).size ||
    JSON.stringify(rows) !== JSON.stringify([...rows].sort())
  ) {
    fail(`${label} must be unique and canonically sorted`);
  }
  return rows;
}

function semanticLiveState(state) {
  return {
    target: state.target,
    policy: state.policy,
    canary_allowlist: state.canary_allowlist,
    certification_principal: state.certification_principal,
    environment_digest: state.environment_digest,
    api: state.api,
    compute: state.compute,
  };
}

function validatePredecessor(value, currentGitSha, nowMs) {
  const row = exactKeys(value, PREDECESSOR_KEYS, 'predecessor verification');
  const predecessor = exactKeys(
    row.predecessor,
    PREDECESSOR_REFERENCE_KEYS,
    'predecessor reference',
  );
  const predecessorDispatch = dispatch(row.dispatch, 'predecessor dispatch');
  const verifiedAt = timestamp(row.verified_at, 'predecessor verified_at');
  const generatedAt = timestamp(
    predecessor.generated_at,
    'production canary generated_at',
  );
  const artifactCreatedAt = timestamp(
    predecessor.artifact_created_at,
    'production canary artifact_created_at',
  );
  const soakEligibleAt = timestamp(
    predecessor.soak_eligible_at,
    'production canary soak_eligible_at',
  );
  const workflowCompletedAt = timestamp(
    predecessor.workflow_completed_at,
    'production canary workflow_completed_at',
  );
  const minimumAgeSeconds = nonnegativeInteger(
    row.minimum_age_seconds,
    'predecessor minimum age seconds',
  );
  const artifactId = positiveInteger(
    predecessor.artifact_id,
    'predecessor artifact id',
  );
  if (
    row.schema_version !== 1 || row.kind !== PREDECESSOR_KIND ||
    row.verified !== true || predecessor.stage !== 'production_canary' ||
    predecessor.target !== 'production' ||
    predecessorDispatch.git_sha !== currentGitSha ||
    predecessor.artifact_name !==
      `compute-canary-rollout-production_canary-production-${predecessorDispatch.workflow_run_id}-${predecessorDispatch.run_attempt}` ||
    generatedAt > artifactCreatedAt ||
    artifactCreatedAt > workflowCompletedAt ||
    workflowCompletedAt > verifiedAt ||
    verifiedAt > nowMs || soakEligibleAt < generatedAt ||
    soakEligibleAt - generatedAt <
      COMPUTE_CANARY_SOAK_MINIMUM_SECONDS * 1_000 ||
    minimumAgeSeconds < COMPUTE_CANARY_SOAK_MINIMUM_SECONDS ||
    verifiedAt < soakEligibleAt || nowMs < soakEligibleAt ||
    nowMs - workflowCompletedAt <
      COMPUTE_CANARY_SOAK_MINIMUM_SECONDS * 1_000
  ) {
    fail('predecessor does not prove a mature production canary');
  }
  let finalState;
  try {
    finalState = validateRolloutState(row.final_state);
  } catch {
    fail('predecessor final state is invalid');
  }
  if (
    finalState.phase !== 'fenced' || finalState.target !== 'production' ||
    finalState.policy !== 'canary' ||
    finalState.canary_allowlist.length !== 1 ||
    finalState.canary_allowlist[0] !== finalState.certification_principal ||
    !sameDispatch(finalState.dispatch, predecessorDispatch)
  ) {
    fail('predecessor final state is not the exact production canary');
  }
  return {
    artifactId,
    dispatch: predecessorDispatch,
    finalState,
    rolloutGeneratedAt: generatedAt,
    soakStartedAt: workflowCompletedAt,
    soakStartedAtText: predecessor.workflow_completed_at,
    soakEligibleAt: workflowCompletedAt +
      COMPUTE_CANARY_SOAK_MINIMUM_SECONDS * 1_000,
    soakEligibleAtText: new Date(
      workflowCompletedAt + COMPUTE_CANARY_SOAK_MINIMUM_SECONDS * 1_000,
    ).toISOString(),
  };
}

function validateRun(value, workflowPath, inventoryEndMs, label) {
  const row = exactKeys(value, RUN_KEYS, label);
  const id = positiveInteger(row.id, `${label} id`);
  const runAttempt = positiveInteger(row.run_attempt, `${label} attempt`);
  const createdAt = timestamp(row.created_at, `${label} created_at`);
  const runStartedAt = timestamp(row.run_started_at, `${label} run_started_at`);
  const updatedAt = timestamp(row.updated_at, `${label} updated_at`);
  if (
    typeof row.head_sha !== 'string' || !GIT_SHA.test(row.head_sha) ||
    typeof row.head_branch !== 'string' || row.head_branch.length === 0 ||
    typeof row.event !== 'string' || row.event.length === 0 ||
    typeof row.status !== 'string' || row.status.length === 0 ||
    !(
      row.conclusion === null ||
      (typeof row.conclusion === 'string' && row.conclusion.length > 0)
    ) ||
    createdAt > runStartedAt || runStartedAt > updatedAt ||
    updatedAt > inventoryEndMs
  ) {
    fail(`${label} lifecycle or provenance is malformed`);
  }
  return {
    ...row,
    id,
    run_attempt: runAttempt,
    workflow_path: workflowPath,
    createdAt,
    runStartedAt,
    updatedAt,
  };
}

function isProductionDeploymentRun(run, workflowPath) {
  if (!RELEASE_TAG.test(run.head_branch)) return false;
  if (workflowPath === API_DEPLOY_WORKFLOW) return run.event === 'push';
  if (
    workflowPath === COMPUTE_DEPLOY_WORKFLOW ||
    workflowPath === COMPUTE_WORKER_REFRESH_WORKFLOW
  ) {
    return run.event === 'workflow_dispatch';
  }
  return false;
}

function validateRunInventory(value, predecessor, nowMs) {
  const row = exactKeys(value, RUN_INVENTORY_KEYS, 'run inventory');
  const windowStartedAt = timestamp(
    row.window_started_at,
    'run inventory window_started_at',
  );
  const windowEndedAt = timestamp(
    row.window_ended_at,
    'run inventory window_ended_at',
  );
  const capturedAt = timestamp(row.captured_at, 'run inventory captured_at');
  if (
    row.schema_version !== 1 || row.kind !== RUN_INVENTORY_KIND ||
    row.repository !== predecessor.dispatch.repository ||
    row.window_started_at !== predecessor.soakStartedAtText ||
    windowEndedAt !== capturedAt || capturedAt > nowMs ||
    nowMs - capturedAt > MAX_INVENTORY_STALENESS_MS ||
    windowEndedAt - windowStartedAt <
      COMPUTE_CANARY_SOAK_MINIMUM_SECONDS * 1_000 ||
    !Array.isArray(row.queries) ||
    row.queries.length !== WORKFLOW_PATHS.length
  ) {
    fail('run inventory is stale, incomplete, or covers the wrong window');
  }
  const runsByWorkflow = new Map();
  const allRunIds = new Set();
  row.queries.forEach((queryValue, index) => {
    const query = exactKeys(
      queryValue,
      RUN_QUERY_KEYS,
      `run inventory query ${index}`,
    );
    const expectedPath = WORKFLOW_PATHS[index];
    if (
      query.workflow_path !== expectedPath ||
      !Array.isArray(query.workflow_runs) ||
      nonnegativeInteger(query.total_count, `${expectedPath} total_count`) !==
        query.workflow_runs.length
    ) {
      fail(`${expectedPath} inventory is truncated or out of canonical order`);
    }
    const runs = query.workflow_runs.map((run, runIndex) =>
      validateRun(run, expectedPath, windowEndedAt, `${expectedPath} run ${runIndex}`)
    );
    for (const run of runs) {
      if (allRunIds.has(run.id)) fail('run inventory contains a duplicate run id');
      allRunIds.add(run.id);
    }
    runsByWorkflow.set(expectedPath, runs);
  });

  for (const workflow of [
    API_DEPLOY_WORKFLOW,
    COMPUTE_DEPLOY_WORKFLOW,
    COMPUTE_WORKER_REFRESH_WORKFLOW,
  ]) {
    const overlapping = runsByWorkflow.get(workflow).filter((run) =>
      isProductionDeploymentRun(run, workflow) &&
      run.createdAt <= windowEndedAt && run.updatedAt >= windowStartedAt
    );
    if (overlapping.length !== 0) {
      fail(`${workflow} ran after the production canary soak started`);
    }
  }

  const probes = runsByWorkflow.get(PROBE_WORKFLOW).filter((run) =>
    run.createdAt <= windowEndedAt && run.updatedAt >= windowStartedAt
  );
  if (probes.length === 0) fail('run inventory contains no scheduled probes');
  for (const run of probes) {
    if (
      run.event !== 'schedule' || run.status !== 'completed' ||
      run.conclusion !== 'success' || run.run_attempt !== '1'
    ) {
      fail('a scheduled probe failed, was skipped, rerun, or is ambiguous');
    }
  }
  return { capturedAt, probes, windowEndedAt, windowStartedAt };
}

function validateArtifact(value, nowMs, label) {
  const row = exactKeys(value, ARTIFACT_KEYS, label);
  const createdAt = timestamp(row.created_at, `${label} created_at`);
  const updatedAt = timestamp(row.updated_at, `${label} updated_at`);
  const expiresAt = timestamp(row.expires_at, `${label} expires_at`);
  const artifact = {
    ...row,
    id: positiveInteger(row.id, `${label} id`),
    workflow_run_id: positiveInteger(
      row.workflow_run_id,
      `${label} workflow run id`,
    ),
    run_attempt: positiveInteger(row.run_attempt, `${label} run attempt`),
    size_in_bytes: positiveInteger(row.size_in_bytes, `${label} size`),
    createdAt,
    updatedAt,
    expiresAt,
  };
  if (
    row.expired !== false || expiresAt <= nowMs ||
    createdAt > updatedAt || updatedAt >= expiresAt ||
    typeof row.head_sha !== 'string' || !GIT_SHA.test(row.head_sha) ||
    typeof row.name !== 'string'
  ) {
    fail(`${label} is expired or malformed`);
  }
  return artifact;
}

function validateArtifactInventory(value, predecessor, runInventory, nowMs) {
  const row = exactKeys(
    value,
    ARTIFACT_INVENTORY_KEYS,
    'artifact inventory',
  );
  const capturedAt = timestamp(
    row.captured_at,
    'artifact inventory captured_at',
  );
  if (
    row.schema_version !== 1 || row.kind !== ARTIFACT_INVENTORY_KIND ||
    row.repository !== predecessor.dispatch.repository || capturedAt > nowMs ||
    nowMs - capturedAt > MAX_INVENTORY_STALENESS_MS ||
    Math.abs(capturedAt - runInventory.capturedAt) > 60 * 1_000 ||
    !Array.isArray(row.artifacts) ||
    nonnegativeInteger(row.total_count, 'artifact inventory total_count') !==
      row.artifacts.length
  ) {
    fail('artifact inventory is stale, truncated, or belongs to another repository');
  }
  const artifacts = row.artifacts.map((artifact, index) =>
    validateArtifact(artifact, nowMs, `probe artifact ${index}`)
  );
  if (artifacts.length !== runInventory.probes.length) {
    fail('artifact inventory does not contain exactly one artifact per probe');
  }
  const byRun = new Map();
  for (const artifact of artifacts) {
    if (byRun.has(artifact.workflow_run_id)) {
      fail('artifact inventory contains more than one artifact for a probe');
    }
    byRun.set(artifact.workflow_run_id, artifact);
  }
  for (const run of runInventory.probes) {
    const artifact = byRun.get(run.id);
    const expectedName =
      `compute-probe-production-${predecessor.dispatch.workflow_run_id}-${run.id}-${run.run_attempt}`;
    if (
      !artifact || artifact.name !== expectedName ||
      artifact.run_attempt !== run.run_attempt ||
      artifact.head_sha !== run.head_sha || artifact.createdAt < run.createdAt ||
      artifact.createdAt > runInventory.capturedAt
    ) {
      fail(`probe ${run.id} does not have its one exact GitHub artifact`);
    }
  }
  return byRun;
}

function validateTerminalRun(value, label) {
  const row = exactKeys(value, TERMINAL_RUN_KEYS, label);
  const ownerId = canonicalUuid(row.owner_id, `${label} owner id`);
  const agentId = canonicalUuid(row.agent_id, `${label} Agent id`);
  const runId = canonicalUuid(row.run_id, `${label} run id`);
  const receiptId = canonicalUuid(row.receipt_id, `${label} receipt id`);
  const createdAt = timestamp(row.created_at, `${label} created_at`);
  const startedAt = timestamp(row.started_at, `${label} started_at`);
  const finishedAt = timestamp(row.finished_at, `${label} finished_at`);
  if (
    row.state !== 'completed' || createdAt > startedAt ||
    startedAt > finishedAt ||
    typeof row.environment_digest !== 'string'
  ) {
    fail(`${label} is not a successful terminal Compute run`);
  }
  return {
    ...row,
    ownerId,
    agentId,
    runId,
    receiptId,
    createdAt,
    startedAt,
    finishedAt,
  };
}

function validateAccounting(value, terminalRuns, generatedAt) {
  const row = exactKeys(value, ACCOUNTING_KEYS, 'probe accounting snapshot');
  const snapshotGeneratedAt = timestamp(
    row.snapshot_generated_at,
    'probe accounting snapshot generated_at',
  );
  const runIds = canonicalUniqueUuidArray(row.run_ids, 'accounting run ids');
  const receiptIds = canonicalUniqueUuidArray(
    row.receipt_ids,
    'accounting receipt ids',
  );
  const expectedRunIds = terminalRuns.map((run) => run.runId).sort();
  const expectedReceiptIds = terminalRuns.map((run) => run.receiptId).sort();
  if (
    JSON.stringify(runIds) !== JSON.stringify(expectedRunIds) ||
    JSON.stringify(receiptIds) !== JSON.stringify(expectedReceiptIds) ||
    nonnegativeInteger(
        row.accounting_violations,
        'probe accounting violations',
      ) !== 0 ||
    nonnegativeInteger(
        row.reconciliation_violations,
        'probe reconciliation violations',
      ) !== 0 ||
    snapshotGeneratedAt < Math.max(...terminalRuns.map((run) => run.finishedAt)) ||
    snapshotGeneratedAt > generatedAt
  ) {
    fail('probe accounting snapshot is incomplete or has violations');
  }
  emptyArray(row.violations, 'probe accounting violations list');
  return row;
}

function validateBrowser(value) {
  const row = exactKeys(value, BROWSER_KEYS, 'browser probe');
  const terminal = validateTerminalRun(
    Object.fromEntries(TERMINAL_RUN_KEYS.map((key) => [key, row[key]])),
    'browser probe',
  );
  if (!Array.isArray(row.artifacts) || row.artifacts.length !== 2) {
    fail('browser probe must bind exactly two artifacts');
  }
  const artifacts = row.artifacts.map((value, index) => {
    const artifact = exactKeys(
      value,
      BROWSER_ARTIFACT_KEYS,
      `browser artifact ${index}`,
    );
    if (
      typeof artifact.path !== 'string' ||
      typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)
    ) {
      fail(`browser artifact ${index} is malformed`);
    }
    return artifact;
  });
  if (
    JSON.stringify(artifacts.map((artifact) => artifact.path)) !==
      JSON.stringify(EXPECTED_BROWSER_PATHS) ||
    new Set(artifacts.map((artifact) => artifact.sha256)).size !== 2
  ) {
    fail('browser artifact hashes are missing, duplicated, or out of order');
  }
  return terminal;
}

function validateDlq(value, expectedName, label) {
  const row = exactKeys(value, DLQ_KEYS, label);
  const baselineCount = nonnegativeInteger(
    row.baseline_count,
    `${label} baseline count`,
  );
  const finalCount = nonnegativeInteger(row.final_count, `${label} final count`);
  if (row.name !== expectedName || finalCount !== baselineCount) {
    fail(`${label} increased or names the wrong queue`);
  }
  return { name: row.name, baselineCount, finalCount };
}

function validateHealth(value, startedAt, generatedAt) {
  const row = exactKeys(value, HEALTH_KEYS, 'probe health');
  const observedAt = timestamp(row.observed_at, 'probe health observed_at');
  const dispatchHealth = exactKeys(
    row.dispatch,
    DISPATCH_HEALTH_KEYS,
    'dispatch queue health',
  );
  if (
    dispatchHealth.name !== PRODUCTION_DISPATCH_QUEUE ||
    nonnegativeInteger(dispatchHealth.backlog, 'dispatch queue backlog') !== 0 ||
    nonnegativeInteger(
        dispatchHealth.oldest_age_seconds,
        'dispatch queue oldest age',
      ) !== 0 ||
    nonnegativeInteger(
        row.accounting_violations,
        'health accounting violations',
      ) !== 0 ||
    nonnegativeInteger(
        row.reconciliation_violations,
        'health reconciliation violations',
      ) !== 0 ||
    observedAt < startedAt || observedAt > generatedAt
  ) {
    fail('probe health reports backlog, violations, or invalid timing');
  }
  emptyArray(row.violations, 'probe health violations');
  return {
    observedAt,
    computeDlq: validateDlq(
      row.compute_dlq,
      PRODUCTION_COMPUTE_DLQ,
      'Compute DLQ',
    ),
    reconciliationDlq: validateDlq(
      row.reconciliation_dlq,
      PRODUCTION_RECONCILIATION_DLQ,
      'reconciliation DLQ',
    ),
  };
}

export function validateComputeCanaryProbeEvidence(
  value,
  { run, artifact, predecessor },
) {
  const row = exactKeys(value, PROBE_KEYS, 'probe evidence');
  const probeDispatch = dispatch(row.dispatch, 'probe dispatch');
  const activeRollout = row.active_rollout === null
    ? null
    : exactKeys(
      row.active_rollout,
      ACTIVE_ROLLOUT_KEYS,
      'probe active rollout',
    );
  const startedAt = timestamp(row.started_at, 'probe started_at');
  const generatedAt = timestamp(row.generated_at, 'probe generated_at');
  const activeWorkflowRunId = activeRollout === null
    ? null
    : positiveInteger(
      activeRollout.workflow_run_id,
      'active rollout workflow run id',
    );
  let liveState;
  try {
    liveState = validateRolloutState(row.live_state);
  } catch {
    fail('probe live state is invalid');
  }
  if (
    row.schema_version !== 1 || row.kind !== PROBE_KIND ||
    row.verified !== true || row.target !== 'production' ||
    !['passed', 'off_noop'].includes(row.outcome) ||
    !['lifecycle', 'browser'].includes(row.mode) ||
    row.latch_state !== 'clear' || startedAt > generatedAt ||
    probeDispatch.repository !== predecessor.dispatch.repository ||
    probeDispatch.workflow_run_id !== run.id ||
    probeDispatch.run_attempt !== run.run_attempt ||
    probeDispatch.git_sha !== run.head_sha ||
    liveState.phase !== 'inspected' || liveState.target !== 'production' ||
    !sameDispatch(liveState.dispatch, probeDispatch) ||
    startedAt < run.runStartedAt || generatedAt > run.updatedAt ||
    generatedAt > artifact.createdAt
  ) {
    fail('probe evidence provenance or lifecycle is incorrect');
  }

  if (row.outcome === 'off_noop') {
    if (
      row.mode !== 'lifecycle' || liveState.policy !== 'off' ||
      liveState.canary_allowlist.length !== 0 ||
      liveState.certification_principal !== null || row.lifecycle !== null ||
      row.accounting !== null || row.browser_artifacts !== null ||
      row.health !== null ||
      (activeRollout !== null &&
        (activeWorkflowRunId !== predecessor.dispatch.workflow_run_id ||
          activeRollout.stage !== 'production_canary' ||
          activeRollout.target !== 'production' ||
          activeRollout.git_sha !== predecessor.dispatch.git_sha))
    ) {
      fail('OFF probe evidence is not an explicit clean no-op');
    }
    return {
      outcome: row.outcome,
      mode: row.mode,
      generatedAt,
      generatedAtText: row.generated_at,
      liveState,
      runId: run.id,
    };
  }

  if (
    activeRollout === null ||
    activeWorkflowRunId !== predecessor.dispatch.workflow_run_id ||
    activeRollout.stage !== 'production_canary' ||
    activeRollout.target !== 'production' ||
    activeRollout.git_sha !== predecessor.dispatch.git_sha
  ) {
    fail('enabled probe is not bound to the production canary rollout');
  }

  if (
    JSON.stringify(semanticLiveState(liveState)) !==
      JSON.stringify(semanticLiveState(predecessor.finalState))
  ) {
    fail('probe API, Compute, digest, policy, or principal drifted');
  }
  const lifecycle = validateTerminalRun(row.lifecycle, 'lifecycle probe');
  const terminalRuns = [lifecycle];
  let browser = null;
  if (row.mode === 'browser') {
    browser = validateBrowser(row.browser_artifacts);
    terminalRuns.push(browser);
  } else if (row.browser_artifacts !== null) {
    fail('lifecycle probe must not carry browser evidence');
  }
  for (const terminal of terminalRuns) {
    if (
      `${terminal.ownerId}/${terminal.agentId}` !==
        liveState.certification_principal ||
      terminal.environment_digest !== liveState.environment_digest ||
      terminal.createdAt < startedAt || terminal.finishedAt > generatedAt
    ) {
      fail('terminal probe run does not match the live principal and digest');
    }
  }
  validateAccounting(row.accounting, terminalRuns, generatedAt);
  const health = validateHealth(row.health, startedAt, generatedAt);
  return {
    outcome: row.outcome,
    mode: row.mode,
    generatedAt,
    generatedAtText: row.generated_at,
    health,
    liveState,
    runId: run.id,
  };
}

function maximumGap(points, startMs, endMs) {
  const boundaries = [startMs, ...points, endMs];
  let maximum = 0;
  for (let index = 1; index < boundaries.length; index += 1) {
    maximum = Math.max(maximum, boundaries[index] - boundaries[index - 1]);
  }
  return maximum;
}

function requireBrowserInEveryCompleteUtcHour(browserTimes, startMs, endMs) {
  let hourStart = Math.ceil(startMs / 3_600_000) * 3_600_000;
  while (hourStart + 3_600_000 <= endMs) {
    if (
      !browserTimes.some((time) =>
        time >= hourStart && time < hourStart + 3_600_000
      )
    ) {
      fail(`no browser probe completed in UTC hour ${new Date(hourStart).toISOString()}`);
    }
    hourStart += 3_600_000;
  }
}

function assertStableDlq(probes, selector, label) {
  const first = selector(probes[0]);
  for (const probe of probes) {
    const current = selector(probe);
    if (
      current.name !== first.name ||
      current.baselineCount !== first.baselineCount ||
      current.finalCount !== first.finalCount
    ) {
      fail(`${label} counters changed during the enabled soak`);
    }
  }
  return first;
}

export function verifyComputeCanarySoak({
  predecessorPath,
  runInventoryPath,
  artifactInventoryPath,
  evidenceDirectory,
  currentGitSha,
  currentWorkflowRunId,
  nowMs = Date.now(),
}) {
  for (const [value, label] of [
    [predecessorPath, 'predecessor path'],
    [runInventoryPath, 'run inventory path'],
    [artifactInventoryPath, 'artifact inventory path'],
    [evidenceDirectory, 'evidence directory'],
  ]) {
    if (typeof value !== 'string' || value.length === 0) fail(`${label} is malformed`);
  }
  if (typeof currentGitSha !== 'string' || !GIT_SHA.test(currentGitSha)) {
    fail('current git SHA is malformed');
  }
  const globalWorkflowRunId = positiveInteger(
    currentWorkflowRunId,
    'current workflow run id',
  );
  if (
    !Number.isSafeInteger(nowMs) || nowMs <= 0 ||
    !Number.isFinite(new Date(nowMs).getTime())
  ) fail('current time is malformed');

  const predecessor = validatePredecessor(
    readJson(resolve(predecessorPath), 'predecessor verification'),
    currentGitSha,
    nowMs,
  );
  if (globalWorkflowRunId === predecessor.dispatch.workflow_run_id) {
    fail('global and production canary workflow run ids must differ');
  }
  const runInventory = validateRunInventory(
    readJson(resolve(runInventoryPath), 'run inventory'),
    predecessor,
    nowMs,
  );
  const artifacts = validateArtifactInventory(
    readJson(resolve(artifactInventoryPath), 'artifact inventory'),
    predecessor,
    runInventory,
    nowMs,
  );

  const probes = runInventory.probes.map((run) => {
    const artifact = artifacts.get(run.id);
    const path = resolve(evidenceDirectory, artifact.name, PROBE_FILE);
    return validateComputeCanaryProbeEvidence(
      readJson(path, `${artifact.name}/${PROBE_FILE}`),
      { run, artifact, predecessor },
    );
  }).sort((left, right) => left.generatedAt - right.generatedAt);
  if (probes.some((probe) => probe.outcome !== 'passed')) {
    fail('OFF no-op evidence cannot satisfy or occur inside an enabled soak');
  }
  for (let index = 1; index < probes.length; index += 1) {
    if (probes[index].generatedAt <= probes[index - 1].generatedAt) {
      fail('probe completion timestamps are duplicated or out of order');
    }
  }
  const lifecycleTimes = probes.map((probe) => probe.generatedAt);
  const lifecycleGap = maximumGap(
    lifecycleTimes,
    predecessor.soakStartedAt,
    nowMs,
  );
  if (
    nowMs - predecessor.soakStartedAt <
      COMPUTE_CANARY_SOAK_MINIMUM_SECONDS * 1_000 ||
    lifecycleGap > COMPUTE_CANARY_SOAK_MAX_LIFECYCLE_GAP_SECONDS * 1_000
  ) {
    fail('enabled lifecycle probes do not continuously cover at least 24 hours');
  }
  const browserProbes = probes.filter((probe) => probe.mode === 'browser');
  if (browserProbes.length === 0) fail('soak contains no browser probes');
  const browserTimes = browserProbes.map((probe) => probe.generatedAt);
  const browserGap = maximumGap(
    browserTimes,
    predecessor.soakStartedAt,
    nowMs,
  );
  if (browserGap > COMPUTE_CANARY_SOAK_MAX_BROWSER_GAP_SECONDS * 1_000) {
    fail('browser probe cadence exceeded its bounded hourly gap');
  }
  requireBrowserInEveryCompleteUtcHour(
    browserTimes,
    predecessor.soakStartedAt,
    nowMs,
  );

  const computeDlq = assertStableDlq(
    probes,
    (probe) => probe.health.computeDlq,
    'Compute DLQ',
  );
  const reconciliationDlq = assertStableDlq(
    probes,
    (probe) => probe.health.reconciliationDlq,
    'reconciliation DLQ',
  );
  const firstProbe = probes[0];
  const finalProbe = probes.at(-1);
  return {
    schema_version: 1,
    kind: VERIFICATION_KIND,
    verified: true,
    verified_at: new Date(nowMs).toISOString(),
    target: 'production',
    repository: predecessor.dispatch.repository,
    candidate_sha: predecessor.dispatch.git_sha,
    production_canary_workflow_run_id: predecessor.dispatch.workflow_run_id,
    current_workflow_run_id: globalWorkflowRunId,
    soak_started_at: predecessor.soakStartedAtText,
    soak_eligible_at: predecessor.soakEligibleAtText,
    minimum_soak_seconds: COMPUTE_CANARY_SOAK_MINIMUM_SECONDS,
    accepted_probe_run_ids: probes.map((probe) => probe.runId),
    probe_count: probes.length,
    browser_probe_run_ids: browserProbes.map((probe) => probe.runId),
    browser_probe_count: browserProbes.length,
    first_probe_at: firstProbe.generatedAtText,
    final_probe_at: finalProbe.generatedAtText,
    maximum_lifecycle_gap_seconds: Math.ceil(lifecycleGap / 1_000),
    maximum_browser_gap_seconds: Math.ceil(browserGap / 1_000),
    live_state: {
      api_version_id: predecessor.finalState.api.version_id,
      api_deployment_id: predecessor.finalState.api.deployment_id,
      compute_version_id: predecessor.finalState.compute.version_id,
      compute_deployment_id: predecessor.finalState.compute.deployment_id,
      environment_digest: predecessor.finalState.environment_digest,
      policy: predecessor.finalState.policy,
      canary_allowlist: predecessor.finalState.canary_allowlist,
      certification_principal:
        predecessor.finalState.certification_principal,
    },
    dlq: {
      compute: {
        name: computeDlq.name,
        baseline_count: computeDlq.baselineCount,
        final_count: computeDlq.finalCount,
      },
      reconciliation: {
        name: reconciliationDlq.name,
        baseline_count: reconciliationDlq.baselineCount,
        final_count: reconciliationDlq.finalCount,
      },
    },
    accounting_violations: 0,
    reconciliation_violations: 0,
  };
}

export function computeCanarySoakValidatorArgs(argv) {
  const expectedFlags = [
    '--artifacts',
    '--current-git-sha',
    '--current-workflow-run-id',
    '--evidence-dir',
    '--predecessor',
    '--runs',
  ];
  if (!Array.isArray(argv) || argv.length !== expectedFlags.length * 2) {
    fail('CLI arguments are incomplete');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !expectedFlags.includes(flag) || values.has(flag) ||
      typeof value !== 'string' || value.length === 0 || value.startsWith('--')
    ) {
      fail('CLI contains an unknown, duplicate, or empty argument');
    }
    values.set(flag, value);
  }
  if (values.size !== expectedFlags.length) fail('CLI arguments are incomplete');
  return {
    predecessorPath: resolve(values.get('--predecessor')),
    runInventoryPath: resolve(values.get('--runs')),
    artifactInventoryPath: resolve(values.get('--artifacts')),
    evidenceDirectory: resolve(values.get('--evidence-dir')),
    currentGitSha: values.get('--current-git-sha'),
    currentWorkflowRunId: values.get('--current-workflow-run-id'),
  };
}

function main(argv) {
  const result = verifyComputeCanarySoak(
    computeCanarySoakValidatorArgs(argv),
  );
  console.log(JSON.stringify(result));
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
