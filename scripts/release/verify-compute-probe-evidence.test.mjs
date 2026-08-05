import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  computeProbeValidatorArgs,
  validateComputeProbeEvidence,
  verifyComputeProbeEvidence,
} from './verify-compute-probe-evidence.mjs';

const CANARY_SHA = 'a'.repeat(40);
const PROBE_SHA = 'b'.repeat(40);
const ENVIRONMENT_DIGEST = `sha256:${'c'.repeat(64)}`;
const REPOSITORY = 'evrydayimruslin/galactic';
const CANARY_RUN_ID = '123456789';
const PROBE_RUN_ID = '987654321';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = `${OWNER_ID}/${AGENT_ID}`;
const STARTED_AT = '2026-08-04T12:00:00.000Z';
const SUITE_GENERATED_AT = '2026-08-04T12:02:00.000Z';
const SNAPSHOT_AT = '2026-08-04T12:03:00+00:00';
const OBSERVED_AT = '2026-08-04T12:04:00Z';
const EMPTY_SHA256 = createHash('sha256').update('', 'utf8').digest('hex');

function id(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function dispatch(runId, sha) {
  return {
    repository: REPOSITORY,
    workflow_run_id: runId,
    run_attempt: '1',
    git_sha: sha,
  };
}

function worker(workerName, versionIndex, deploymentIndex, sha = CANARY_SHA) {
  return {
    worker: workerName,
    version_id: id(versionIndex),
    version_tag: `${workerName}-${sha}`,
    deployment_id: id(deploymentIndex),
    code_etag: `${workerName}-etag`,
    compatibility_sha256: hash(`${workerName}-compatibility`),
  };
}

function canaryState(phase, stateDispatch = dispatch(CANARY_RUN_ID, CANARY_SHA)) {
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_state',
    verified: true,
    phase,
    target: 'production',
    policy: 'canary',
    canary_allowlist: [PRINCIPAL],
    certification_principal: PRINCIPAL,
    environment_digest: ENVIRONMENT_DIGEST,
    dispatch: stateDispatch,
    api: worker('ultralight-api', 700, 701),
    compute: worker('galactic-compute', 702, 703),
    source_api_version_id: phase === 'inspected' ? null : id(704),
  };
}

function offState() {
  const canary = canaryState('inspected', dispatch(PROBE_RUN_ID, PROBE_SHA));
  return {
    ...canary,
    policy: 'off',
    canary_allowlist: [],
    certification_principal: null,
    api: {
      ...canary.api,
      version_id: id(710),
      version_tag: `ultralight-api-${PROBE_SHA}-admission-off`,
      deployment_id: id(711),
    },
  };
}

function predecessorVerification() {
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_predecessor_verification',
    verified: true,
    verified_at: '2026-08-04T11:02:00Z',
    minimum_age_seconds: 0,
    predecessor: {
      stage: 'production_canary',
      target: 'production',
      artifact_id: '555',
      artifact_name:
        `compute-canary-rollout-production_canary-production-${CANARY_RUN_ID}-1`,
      artifact_created_at: '2026-08-04T11:01:00Z',
      generated_at: '2026-08-04T11:00:00Z',
      soak_eligible_at: '2026-08-05T11:00:00Z',
      workflow_completed_at: '2026-08-04T11:02:00Z',
    },
    dispatch: dispatch(CANARY_RUN_ID, CANARY_SHA),
    final_state: canaryState('fenced'),
  };
}

function artifact(index, path, content) {
  return {
    artifact_id: id(index),
    path,
    size_bytes: content.length,
    sha256: hash(content),
    expires_at: '2026-09-04T12:00:00.000Z',
  };
}

function scenarioEvidence(name, index) {
  const artifacts = name === 'browser_https'
    ? [
        artifact(501, 'output/browser-https.json', 'browser-json'),
        artifact(502, 'output/browser-https.png', 'browser-png'),
      ]
    : [];
  const minute = String(index).padStart(2, '0');
  const scenario = {
    scenario: name,
    run_id: id(10 + index),
    receipt_id: id(100 + index),
    start_call_receipt_id: id(200 + index),
    status_call_receipt_id: id(300 + index),
    status: 'completed',
    exit_code: 0,
    observed_states: ['queued', 'running', 'completed'],
    timestamps: {
      created_at: `2026-08-04T12:${minute}:01.000Z`,
      started_at: `2026-08-04T12:${minute}:02.000Z`,
      finished_at: `2026-08-04T12:${minute}:03.000Z`,
    },
    stdout_sha256: hash(`${name}-stdout`),
    stderr_sha256: EMPTY_SHA256,
    artifacts,
  };
  if (name === 'browser_https') {
    scenario.artifact_download = artifacts.map((entry) => ({
      byteLength: entry.size_bytes,
      sha256: entry.sha256,
    }));
  }
  return scenario;
}

function suiteEvidence(mode) {
  const profile = mode === 'browser' ? 'probe' : 'probe-lifecycle';
  const scenarios = mode === 'browser'
    ? [scenarioEvidence('async_echo', 0), scenarioEvidence('browser_https', 1)]
    : [scenarioEvidence('async_echo', 0)];
  const marker = `galactic-compute-certification-v1:${CANARY_SHA}:${PROBE_RUN_ID}\n`;
  return {
    schema_version: 1,
    kind: 'galactic_compute_deployed_certification',
    verified: true,
    target: 'production',
    profile,
    candidate_sha: CANARY_SHA,
    workflow_run_id: PROBE_RUN_ID,
    agent_id: AGENT_ID,
    function_name: 'run_compute_certification',
    fixture_identity_call_receipt_id: id(400),
    marker_sha256: hash(marker),
    started_at: STARTED_AT,
    scenarios,
    policy_pillar: null,
    operator_snapshot_required: true,
    cleanup: {
      active_compute_runs_remaining: 0,
      active_routine_runs_remaining: 0,
      compute_policy_disabled: true,
      policy_probe_paused_and_free: true,
      settings_revision: '4',
    },
    generated_at: SUITE_GENERATED_AT,
  };
}

function runSetEvidence(suite) {
  return {
    schema_version: 1,
    kind: 'galactic_compute_certification_run_set',
    target: 'production',
    candidate_sha: CANARY_SHA,
    workflow_run_id: PROBE_RUN_ID,
    agent_id: AGENT_ID,
    since: STARTED_AT,
    run_ids: suite.scenarios.map((scenario) => scenario.run_id),
    generated_at: SUITE_GENERATED_AT,
  };
}

function backing() {
  return {
    run_capacity_reservation: false,
    budget_hold: true,
    budget_capacity_reservation: false,
    receipt_hold: true,
    receipt_capacity_reservation: false,
    receipt_cloud_usage_event: true,
    budget_matches_run_capacity: true,
    receipt_matches_run_capacity: true,
    receipt_matches_budget_hold: true,
    budget_owner_match: true,
    budget_capacity_agent_match: true,
    receipt_principal_match: true,
    receipt_capacity_agent_match: true,
  };
}

function snapshotArtifact(publicArtifact) {
  return {
    artifact_id: publicArtifact.artifact_id,
    direction: 'output',
    state: 'ready',
    state_version: '2',
    sha256: publicArtifact.sha256,
    size_bytes: String(publicArtifact.size_bytes),
    expires_at: '2026-09-04T12:00:00+00:00',
    object_deleted: false,
  };
}

function snapshotRun(scenario, index) {
  const artifacts = scenario.artifacts.map(snapshotArtifact);
  return {
    run_id: scenario.run_id,
    receipt_id: scenario.receipt_id,
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    caller_function: 'run_compute_certification',
    state: 'succeeded',
    state_version: '5',
    billing_mode: 'wallet',
    capacity_agent_id: AGENT_ID,
    environment_digest: ENVIRONMENT_DIGEST,
    directive_hash: hash(`directive-${index}`),
    request_hash: hash(`request-${index}`),
    created_at: scenario.timestamps.created_at,
    updated_at: scenario.timestamps.finished_at,
    expires_at: '2026-08-04T14:00:00+00:00',
    started_at: scenario.timestamps.started_at,
    finished_at: scenario.timestamps.finished_at,
    cardinality: {
      budget_rows: 1,
      receipt_rows: 1,
      token_rows: 1,
      artifact_rows: artifacts.length,
      input_artifact_rows: 0,
      output_artifact_rows: artifacts.length,
      projected_artifact_rows: artifacts.length,
    },
    backing: backing(),
    budget: {
      status: 'settled',
      billing_mode: 'wallet',
      rate_version: 'compute-rate-v1',
      rate_light_per_ms: '0.000002056000',
      actual_wall_ms: '1000',
      reserved_wall_ms: '211000',
      teardown_allowance_ms: '15000',
      reserved_light: '0.433816000000',
      actual_light: '0.002056000000',
      released_light: '0.431760000000',
      expires_at: '2026-08-04T14:00:00+00:00',
      settled_at: scenario.timestamps.finished_at,
    },
    receipt: {
      id: scenario.receipt_id,
      outcome: 'succeeded',
      billing_mode: 'wallet',
      rate_version: 'compute-rate-v1',
      capacity_settlement_status: 'not_applicable',
      reserved_light: '0.433816000000',
      actual_light: '0.002056000000',
      released_light: '0.431760000000',
      worker_wall_ms: '1000',
      teardown_allowance_ms: '15000',
      billed_wall_ms: '1000',
      created_at: scenario.timestamps.finished_at,
    },
    terminal_active_token_count: 0,
    artifacts,
    violations: [],
  };
}

function operatorSnapshot(suite) {
  const runs = suite.scenarios.map(snapshotRun);
  return {
    schema_version: 1,
    generated_at: SNAPSHOT_AT,
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    since: STARTED_AT,
    latch_state: 'clear',
    requested_run_count: runs.length,
    selected_run_count: runs.length,
    runs,
    health: {
      stale_nonterminal_runs: 0,
      old_settlement_pending: 0,
      terminal_reserved_budgets: 0,
      receipt_mismatches: 0,
      terminal_active_tokens: 0,
      dlq_fenced_runs: 0,
      stale_pending_artifacts: 0,
      unreconciled_deleted_outputs: 0,
      terminal_input_aliases: 0,
      violations: [],
    },
    violations: [],
  };
}

function containerReadiness() {
  return {
    schema_version: 1,
    id: 'production-container-application',
    name: 'galactic-compute-computestandard',
    state: 'ready',
    instances: 7,
    image:
      `registry.cloudflare.com/${'1'.repeat(32)}/galactic-compute@${ENVIRONMENT_DIGEST}`,
    version: 12,
    updated_at: '2026-08-04T11:59:00Z',
  };
}

function queueHealth() {
  return {
    schema_version: 1,
    kind: 'galactic_compute_queue_health',
    verified: true,
    target: 'production',
    observed_at: OBSERVED_AT,
    dispatch: {
      name: 'galactic-compute',
      backlog: 0,
      oldest_age_seconds: 0,
    },
    compute_dlq: {
      name: 'galactic-compute-dlq',
      baseline_count: 4,
      final_count: 4,
    },
    reconciliation_dlq: {
      name: 'galactic-compute-reconciliation-dlq',
      baseline_count: 2,
      final_count: 2,
    },
  };
}

function emergencyStopStatus(admissionState) {
  return {
    schema_version: 1,
    admission_state: admissionState,
    latch_state: 'clear',
    operation_id: null,
    cutoff_at: null,
    target_count: null,
    terminalized_count: null,
    pending_target_count: null,
    created_at: null,
    updated_at: null,
    completed_at: null,
  };
}

function fixture(mode = 'lifecycle') {
  const suite = suiteEvidence(mode);
  const runSet = runSetEvidence(suite);
  return {
    predecessorVerification: predecessorVerification(),
    initialLiveState: canaryState('inspected', dispatch(PROBE_RUN_ID, PROBE_SHA)),
    suiteEvidence: suite,
    runSetEvidence: runSet,
    operatorSnapshot: operatorSnapshot(suite),
    finalLiveState: canaryState('inspected', dispatch(PROBE_RUN_ID, PROBE_SHA)),
    containerReadiness: containerReadiness(),
    queueHealth: queueHealth(),
    emergencyStopStatus: emergencyStopStatus('enabled'),
    expectedMode: mode,
    expectedOutcome: 'passed',
    expectedRepository: REPOSITORY,
    expectedWorkflowRunId: PROBE_RUN_ID,
    expectedRunAttempt: '1',
    expectedGitSha: PROBE_SHA,
    expectedStartedAt: STARTED_AT,
  };
}

function offFixture({ withPredecessor = false } = {}) {
  return {
    predecessorVerification: withPredecessor ? predecessorVerification() : null,
    initialLiveState: offState(),
    suiteEvidence: null,
    runSetEvidence: null,
    operatorSnapshot: null,
    finalLiveState: offState(),
    containerReadiness: containerReadiness(),
    queueHealth: queueHealth(),
    emergencyStopStatus: emergencyStopStatus('disabled'),
    expectedMode: 'lifecycle',
    expectedOutcome: 'off_noop',
    expectedRepository: REPOSITORY,
    expectedWorkflowRunId: PROBE_RUN_ID,
    expectedRunAttempt: '1',
    expectedGitSha: PROBE_SHA,
    expectedStartedAt: STARTED_AT,
  };
}

test('emits strict lifecycle and browser production probe markers', () => {
  for (const mode of ['lifecycle', 'browser']) {
    const result = validateComputeProbeEvidence(fixture(mode));
    assert.deepEqual(Object.keys(result).sort(), [
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
    ]);
    assert.equal(result.kind, 'galactic_compute_production_probe');
    assert.equal(result.outcome, 'passed');
    assert.equal(result.dispatch.git_sha, PROBE_SHA);
    assert.equal(result.active_rollout.git_sha, CANARY_SHA);
    assert.equal(result.lifecycle.owner_id, OWNER_ID);
    assert.equal(result.lifecycle.environment_digest, ENVIRONMENT_DIGEST);
    assert.deepEqual(result.accounting.run_ids, [...result.accounting.run_ids].sort());
    assert.deepEqual(
      result.accounting.receipt_ids,
      [...result.accounting.receipt_ids].sort(),
    );
    assert.equal(result.health.compute_dlq.baseline_count, 4);
    assert.equal(result.health.compute_dlq.final_count, 4);
    if (mode === 'browser') {
      assert.deepEqual(
        result.browser_artifacts.artifacts.map((entry) => entry.path),
        ['output/browser-https.json', 'output/browser-https.png'],
      );
      assert.equal(result.browser_artifacts.owner_id, OWNER_ID);
      assert.equal(result.accounting.run_ids.length, 2);
    } else {
      assert.equal(result.browser_artifacts, null);
      assert.equal(result.accounting.run_ids.length, 1);
    }
  }
});

test('emits an explicit OFF bootstrap no-op without inventing active rollout evidence', () => {
  const result = validateComputeProbeEvidence(offFixture());
  assert.equal(result.outcome, 'off_noop');
  assert.equal(result.active_rollout, null);
  assert.equal(result.live_state.policy, 'off');
  assert.equal(result.live_state.certification_principal, null);
  assert.deepEqual(result.live_state.canary_allowlist, []);
  assert.equal(result.latch_state, 'clear');
  assert.equal(result.lifecycle, null);
  assert.equal(result.accounting, null);
  assert.equal(result.browser_artifacts, null);
  assert.equal(result.health, null);
});

test('accepts an OFF no-op bound to an existing canary without labeling it enabled', () => {
  const result = validateComputeProbeEvidence(offFixture({ withPredecessor: true }));
  assert.equal(result.outcome, 'off_noop');
  assert.equal(result.active_rollout.git_sha, CANARY_SHA);
  assert.equal(result.lifecycle, null);
});

test('fails closed across lineage, live state, runtime, suite, and accounting drift', async (t) => {
  const cases = [
    ['predecessor metadata', (args) => {
      args.predecessorVerification.predecessor.stage = 'production_global';
    }],
    ['predecessor principal', (args) => {
      args.predecessorVerification.final_state.certification_principal =
        `${OWNER_ID}/${id(999)}`;
    }],
    ['live principal', (args) => {
      args.finalLiveState.certification_principal = `${OWNER_ID}/${id(998)}`;
    }],
    ['live digest', (args) => {
      args.finalLiveState.environment_digest = `sha256:${'d'.repeat(64)}`;
    }],
    ['final worker drift', (args) => {
      args.finalLiveState.compute.version_id = id(997);
    }],
    ['live dispatch', (args) => {
      args.finalLiveState.dispatch.workflow_run_id = '44';
    }],
    ['active latch', (args) => {
      args.emergencyStopStatus.latch_state = 'active';
      args.emergencyStopStatus.operation_id = id(996);
    }],
    ['wrong admission preflight', (args) => {
      args.emergencyStopStatus.admission_state = 'disabled';
    }],
    ['container digest', (args) => {
      args.containerReadiness.image = args.containerReadiness.image.replace(
        ENVIRONMENT_DIGEST,
        `sha256:${'e'.repeat(64)}`,
      );
    }],
    ['queue backlog', (args) => {
      args.queueHealth.dispatch.backlog = 1;
    }],
    ['queue age', (args) => {
      args.queueHealth.dispatch.oldest_age_seconds = 1;
    }],
    ['Compute DLQ increase', (args) => {
      args.queueHealth.compute_dlq.final_count = 5;
    }],
    ['reconciliation DLQ increase', (args) => {
      args.queueHealth.reconciliation_dlq.final_count = 3;
    }],
    ['wrong suite profile', (args) => {
      args.suiteEvidence.profile = 'production-canary';
    }],
    ['suite candidate follows probe head', (args) => {
      args.suiteEvidence.candidate_sha = PROBE_SHA;
    }],
    ['suite marker drift', (args) => {
      args.suiteEvidence.marker_sha256 = 'f'.repeat(64);
    }],
    ['Policy Pillar included', (args) => {
      args.suiteEvidence.policy_pillar = {};
    }],
    ['cleanup leaves run', (args) => {
      args.suiteEvidence.cleanup.active_compute_runs_remaining = 1;
    }],
    ['run set expanded', (args) => {
      args.runSetEvidence.run_ids.push(id(995));
    }],
    ['snapshot missing run', (args) => {
      args.operatorSnapshot.runs.pop();
      args.operatorSnapshot.selected_run_count -= 1;
    }],
    ['snapshot health failure', (args) => {
      args.operatorSnapshot.health.receipt_mismatches = 1;
    }],
    ['DLQ-fenced run', (args) => {
      args.operatorSnapshot.health.dlq_fenced_runs = 1;
      args.operatorSnapshot.health.violations = ['DLQ_FENCED_RUNS'];
    }],
    ['nonterminal selected run', (args) => {
      args.operatorSnapshot.runs[0].state = 'running';
      args.operatorSnapshot.runs[0].receipt.outcome = 'running';
    }],
    ['active token', (args) => {
      args.operatorSnapshot.runs[0].terminal_active_token_count = 1;
    }],
    ['receipt mismatch', (args) => {
      args.operatorSnapshot.runs[0].receipt_id = id(994);
      args.operatorSnapshot.runs[0].receipt.id = id(994);
    }],
    ['accounting conservation', (args) => {
      args.operatorSnapshot.runs[0].budget.released_light = '0.700000000000';
      args.operatorSnapshot.runs[0].receipt.released_light = '0.700000000000';
    }],
    ['tariff drift', (args) => {
      args.operatorSnapshot.runs[0].budget.rate_light_per_ms = '0.000002057000';
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const args = clone(fixture('browser'));
      mutate(args);
      assert.throws(
        () => validateComputeProbeEvidence(args),
        /^Error: Compute production probe evidence is invalid:/u,
      );
    });
  }
});

test('fails closed on browser proof detachment and artifact drift', async (t) => {
  const cases = [
    ['browser scenario omitted', (args) => {
      args.suiteEvidence.scenarios.pop();
      args.runSetEvidence.run_ids.pop();
      args.operatorSnapshot.runs.pop();
      args.operatorSnapshot.requested_run_count = 1;
      args.operatorSnapshot.selected_run_count = 1;
    }],
    ['browser path drift', (args) => {
      args.suiteEvidence.scenarios[1].artifacts[0].path = 'output/other.json';
    }],
    ['browser hash drift', (args) => {
      args.operatorSnapshot.runs[1].artifacts[0].sha256 = 'f'.repeat(64);
    }],
    ['browser download drift', (args) => {
      args.suiteEvidence.scenarios[1].artifact_download[0].byteLength += 1;
    }],
    ['duplicate browser digest', (args) => {
      const scenario = args.suiteEvidence.scenarios[1];
      scenario.artifacts[1].sha256 = scenario.artifacts[0].sha256;
      scenario.artifact_download[1].sha256 = scenario.artifacts[0].sha256;
      args.operatorSnapshot.runs[1].artifacts[1].sha256 =
        scenario.artifacts[0].sha256;
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const args = clone(fixture('browser'));
      mutate(args);
      assert.throws(() => validateComputeProbeEvidence(args));
    });
  }
});

test('OFF no-op rejects admitted evidence, policy drift, and uncleared latch', async (t) => {
  const cases = [
    ['admitted suite', (args) => {
      args.suiteEvidence = fixture().suiteEvidence;
    }],
    ['enabled live state', (args) => {
      args.initialLiveState = fixture().initialLiveState;
      args.finalLiveState = fixture().finalLiveState;
    }],
    ['final API code drift with predecessor', (args) => {
      args.finalLiveState.api.code_etag = 'different-code';
    }, true],
    ['active latch', (args) => {
      args.emergencyStopStatus.latch_state = 'completed';
    }],
    ['browser-labeled no-op', (args) => {
      args.expectedMode = 'browser';
    }],
  ];
  for (const [name, mutate, withPredecessor = false] of cases) {
    await t.test(name, () => {
      const args = clone(offFixture({ withPredecessor }));
      mutate(args);
      assert.throws(() => validateComputeProbeEvidence(args));
    });
  }
});

test('errors do not echo private evidence values', () => {
  const args = fixture();
  const privateValue = 'private-owner-token-like-value';
  args.operatorSnapshot.owner_id = privateValue;
  assert.throws(
    () => validateComputeProbeEvidence(args),
    (error) =>
      error instanceof Error &&
      error.message.startsWith('Compute production probe evidence is invalid:') &&
      !error.message.includes(privateValue),
  );
});

function writeFixture(directory, args, { off = false } = {}) {
  const inputs = {
    initialLiveStatePath: join(directory, 'live-state.json'),
    finalLiveStatePath: join(directory, 'final-live-state.json'),
    containerReadinessPath: join(directory, 'container-readiness.json'),
    queueHealthPath: join(directory, 'queue-health.json'),
    emergencyStopStatusPath: join(directory, 'emergency-stop-status.json'),
  };
  const values = [
    [inputs.initialLiveStatePath, args.initialLiveState],
    [inputs.finalLiveStatePath, args.finalLiveState],
    [inputs.containerReadinessPath, args.containerReadiness],
    [inputs.queueHealthPath, args.queueHealth],
    [inputs.emergencyStopStatusPath, args.emergencyStopStatus],
  ];
  if (args.predecessorVerification !== null) {
    inputs.predecessorVerificationPath = join(directory, 'predecessor-verification.json');
    values.push([inputs.predecessorVerificationPath, args.predecessorVerification]);
  }
  if (!off) {
    inputs.suiteEvidencePath = join(directory, 'suite.json');
    inputs.runSetPath = join(directory, 'run-set.json');
    inputs.operatorSnapshotPath = join(directory, 'snapshot.json');
    values.push(
      [inputs.suiteEvidencePath, args.suiteEvidence],
      [inputs.runSetPath, args.runSetEvidence],
      [inputs.operatorSnapshotPath, args.operatorSnapshot],
    );
  }
  for (const [path, value] of values) {
    writeFileSync(path, `${JSON.stringify(value)}\n`);
  }
  return inputs;
}

test('writes one deterministic private self-contained marker', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'compute-probe-validator-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const args = fixture('browser');
  const paths = writeFixture(directory, args);
  const outputPath = join(directory, 'compute-canary-probe.json');
  const options = {
    ...paths,
    outputPath,
    expectedMode: args.expectedMode,
    expectedOutcome: args.expectedOutcome,
    expectedRepository: args.expectedRepository,
    expectedWorkflowRunId: args.expectedWorkflowRunId,
    expectedRunAttempt: args.expectedRunAttempt,
    expectedGitSha: args.expectedGitSha,
    expectedStartedAt: args.expectedStartedAt,
  };
  const first = verifyComputeProbeEvidence(options);
  const firstBytes = readFileSync(outputPath, 'utf8');
  const second = verifyComputeProbeEvidence(options);
  assert.deepEqual(second, first);
  assert.equal(readFileSync(outputPath, 'utf8'), firstBytes);
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
});

function cliArgv(directory, args, paths, output) {
  const argv = [
    '--initial-live-state', paths.initialLiveStatePath,
    '--final-live-state', paths.finalLiveStatePath,
    '--container-readiness', paths.containerReadinessPath,
    '--queue-health', paths.queueHealthPath,
    '--emergency-stop-status', paths.emergencyStopStatusPath,
    '--expected-mode', args.expectedMode,
    '--expected-outcome', args.expectedOutcome,
    '--expected-repository', args.expectedRepository,
    '--expected-workflow-run-id', args.expectedWorkflowRunId,
    '--expected-run-attempt', args.expectedRunAttempt,
    '--expected-git-sha', args.expectedGitSha,
    '--started-at', args.expectedStartedAt,
    '--output', output,
  ];
  if (paths.predecessorVerificationPath) {
    argv.push('--predecessor-verification', paths.predecessorVerificationPath);
  }
  if (args.expectedOutcome === 'passed') {
    argv.push(
      '--suite-evidence', paths.suiteEvidencePath,
      '--run-set', paths.runSetPath,
      '--operator-snapshot', paths.operatorSnapshotPath,
    );
  }
  return argv;
}

test('parses outcome-specific CLI evidence and runs both outcomes end to end', (t) => {
  for (const [name, args] of [
    ['passed', fixture()],
    ['off', offFixture()],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), `compute-probe-cli-${name}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const paths = writeFixture(directory, args, { off: name === 'off' });
    const output = join(directory, 'compute-canary-probe.json');
    const argv = cliArgv(directory, args, paths, output);
    const parsed = computeProbeValidatorArgs(argv);
    assert.equal(parsed.expectedOutcome, args.expectedOutcome);
    const run = spawnSync(
      process.execPath,
      [join(import.meta.dirname, 'verify-compute-probe-evidence.mjs'), ...argv],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).outcome, args.expectedOutcome);
  }
});

test('CLI requires predecessor and admitted evidence only for passed probes', () => {
  const args = fixture();
  const directory = '/tmp/compute-probe-arg-contract';
  const paths = {
    predecessorVerificationPath: `${directory}/predecessor.json`,
    initialLiveStatePath: `${directory}/initial.json`,
    finalLiveStatePath: `${directory}/final.json`,
    containerReadinessPath: `${directory}/container.json`,
    queueHealthPath: `${directory}/queue.json`,
    emergencyStopStatusPath: `${directory}/emergency.json`,
    suiteEvidencePath: `${directory}/suite.json`,
    runSetPath: `${directory}/run-set.json`,
    operatorSnapshotPath: `${directory}/snapshot.json`,
  };
  const passed = cliArgv(directory, args, paths, `${directory}/output.json`);
  assert.throws(
    () => computeProbeValidatorArgs(passed.filter((entry) =>
      entry !== '--predecessor-verification' && entry !== paths.predecessorVerificationPath
    )),
    /does not match the requested outcome/u,
  );
  const off = offFixture();
  const offArgs = cliArgv(directory, off, paths, `${directory}/off.json`);
  assert.throws(
    () => computeProbeValidatorArgs([
      ...offArgs,
      '--suite-evidence',
      paths.suiteEvidencePath,
    ]),
    /does not match the requested outcome/u,
  );
  assert.throws(
    () => computeProbeValidatorArgs([...passed, '--expected-mode', 'browser']),
    /arguments are malformed/u,
  );
});
