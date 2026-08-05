import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  computeCertificationValidatorArgs,
  validateComputeCertificationEvidence,
  verifyComputeCertificationEvidence,
} from './verify-compute-certification-evidence.mjs';

const CANDIDATE_SHA = 'a'.repeat(40);
const WORKFLOW_RUN_ID = '123456789';
const ENVIRONMENT_DIGEST = `sha256:${'b'.repeat(64)}`;
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_ARTIFACT_SHA256 = '6ad9b8ea5280658dc4b229a2b6180d530c4d3824b541d218266ea6049e8b763b';
const STARTED_AT = '2026-08-04T12:00:00.000Z';
const GENERATED_AT = '2026-08-04T13:00:00.000Z';
const SNAPSHOT_AT = '2026-08-04T13:01:00+00:00';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

const SCENARIOS = [
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
];

function id(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function artifact(idIndex, path, sha, size) {
  return {
    artifact_id: id(idIndex),
    path,
    size_bytes: size,
    sha256: sha,
    expires_at: '2026-09-04T12:00:00.000Z',
  };
}

function scenarioArtifacts(scenario) {
  if (scenario === 'browser_https') {
    return [
      artifact(501, 'output/browser-https.png', hash('browser-png'), 1234),
      artifact(502, 'output/browser-https.json', hash('browser-json'), 87),
    ];
  }
  if (scenario === 'artifact_producer') {
    return [
      artifact(
        503,
        'output/certification-artifact.bin',
        FIXED_ARTIFACT_SHA256,
        61,
      ),
    ];
  }
  if (scenario === 'artifact_consumer') {
    return [
      artifact(
        504,
        'output/certification-artifact.bin',
        FIXED_ARTIFACT_SHA256,
        61,
      ),
      artifact(505, 'output/artifact-consumer.json', hash('consumer-json'), 94),
    ];
  }
  return [];
}

function scenarioOutcome(scenario) {
  if (scenario === 'exit_23') {
    return { status: 'completed', exitCode: 23, state: 'succeeded' };
  }
  if (scenario === 'timeout') {
    return { status: 'failed', exitCode: null, state: 'failed' };
  }
  if (scenario === 'cancellable') {
    return { status: 'cancelled', exitCode: null, state: 'cancelled' };
  }
  return { status: 'completed', exitCode: 0, state: 'succeeded' };
}

function scenarioEvidence(scenario, index) {
  const outcome = scenarioOutcome(scenario);
  const artifacts = scenarioArtifacts(scenario);
  const value = {
    scenario,
    run_id: id(10 + index),
    receipt_id: id(100 + index),
    start_call_receipt_id: id(200 + index),
    status_call_receipt_id: id(300 + index),
    status: outcome.status,
    exit_code: outcome.exitCode,
    observed_states: ['queued', 'running', outcome.status],
    timestamps: {
      created_at: `2026-08-04T12:${String(index).padStart(2, '0')}:01.000Z`,
      started_at: `2026-08-04T12:${String(index).padStart(2, '0')}:02.000Z`,
      finished_at: `2026-08-04T12:${String(index).padStart(2, '0')}:03.000Z`,
    },
    stdout_sha256: hash(`${scenario}-stdout`),
    stderr_sha256: ['timeout', 'cancellable'].includes(scenario)
      ? hash(`${scenario}-stderr`)
      : EMPTY_SHA256,
    artifacts,
  };
  if (scenario === 'artifact_producer') {
    value.artifact_download = {
      byteLength: artifacts[0].size_bytes,
      sha256: artifacts[0].sha256,
    };
  }
  if (scenario === 'artifact_consumer' || scenario === 'browser_https') {
    value.artifact_download = artifacts.map((entry) => ({
      byteLength: entry.size_bytes,
      sha256: entry.sha256,
    }));
  }
  if (scenario === 'cancellable') {
    value.cancellation = {
      firstCallReceiptId: id(401),
      replayCallReceiptId: id(402),
      startedAt: value.timestamps.started_at,
      startedStatusCallReceiptId: id(403),
    };
  }
  return value;
}

function suiteEvidence(profile, target) {
  const scenarios = SCENARIOS.map(scenarioEvidence);
  const marker = `galactic-compute-certification-v1:${CANDIDATE_SHA}:${WORKFLOW_RUN_ID}\n`;
  return {
    schema_version: 1,
    kind: 'galactic_compute_deployed_certification',
    verified: true,
    target,
    profile,
    candidate_sha: CANDIDATE_SHA,
    workflow_run_id: WORKFLOW_RUN_ID,
    agent_id: AGENT_ID,
    function_name: 'run_compute_certification',
    fixture_identity_call_receipt_id: id(400),
    marker_sha256: hash(marker),
    started_at: STARTED_AT,
    scenarios,
    policy_pillar: {
      function_name: 'run_compute_policy_probe',
      routine_id: id(600),
      baseline_policy: 'free',
      free: {
        compute_run_id: id(20),
        status: 'completed',
        observed_states: ['queued', 'running', 'completed'],
      },
      off: {
        routine_run_id: id(601),
        routine_status: 'failed',
        error_code: 'policy_off',
        compute_run_admitted: false,
      },
      cleanup: { routine_paused: true, policy: 'free' },
      prior_routine_run_count: 2,
    },
    operator_snapshot_required: true,
    cleanup: {
      active_compute_runs_remaining: 0,
      active_routine_runs_remaining: 0,
      compute_policy_disabled: true,
      policy_probe_paused_and_free: true,
      settings_revision: '4',
    },
    generated_at: GENERATED_AT,
  };
}

function runSetEvidence(suite) {
  return {
    schema_version: 1,
    kind: 'galactic_compute_certification_run_set',
    target: suite.target,
    candidate_sha: CANDIDATE_SHA,
    workflow_run_id: WORKFLOW_RUN_ID,
    agent_id: AGENT_ID,
    since: STARTED_AT,
    run_ids: [
      ...suite.scenarios.map((scenario) => scenario.run_id),
      suite.policy_pillar.free.compute_run_id,
    ],
    generated_at: GENERATED_AT,
  };
}

function canaryIdentity(target) {
  return {
    schema_version: 1,
    kind: 'galactic_compute_canary_identity',
    target,
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    allowlist_entry: `${OWNER_ID}/${AGENT_ID}`,
  };
}

function worker(worker, versionIndex, deploymentIndex) {
  return {
    worker,
    version_id: id(versionIndex),
    version_tag: `${worker}-${CANDIDATE_SHA}`,
    deployment_id: id(deploymentIndex),
    code_etag: `${worker}-etag`,
    compatibility_sha256: hash(`${worker}-compatibility`),
  };
}

function promotedState(target, policy) {
  const staging = target === 'staging';
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_state',
    verified: true,
    phase: 'promoted',
    target,
    policy,
    canary_allowlist: policy === 'canary' ? [`${OWNER_ID}/${AGENT_ID}`] : [],
    certification_principal: `${OWNER_ID}/${AGENT_ID}`,
    environment_digest: ENVIRONMENT_DIGEST,
    dispatch: {
      repository: 'evrydayimruslin/galactic',
      workflow_run_id: WORKFLOW_RUN_ID,
      run_attempt: '1',
      git_sha: CANDIDATE_SHA,
    },
    api: worker(staging ? 'ultralight-api-staging' : 'ultralight-api', 700, 701),
    compute: worker(
      staging ? 'galactic-compute-staging' : 'galactic-compute',
      702,
      703,
    ),
    source_api_version_id: id(704),
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

function snapshotArtifact(publicArtifact, direction = 'output', idOverride = null) {
  return {
    artifact_id: idOverride ?? publicArtifact.artifact_id,
    direction,
    state: direction === 'input' ? 'deleted' : 'ready',
    state_version: '2',
    sha256: publicArtifact.sha256,
    size_bytes: String(publicArtifact.size_bytes),
    expires_at: '2026-09-04T12:00:00+00:00',
    object_deleted: false,
  };
}

function snapshotRun(runId, receiptId, state, index, scenario = null) {
  const publicArtifacts = scenario?.artifacts ?? [];
  const artifacts = publicArtifacts.map((entry) => snapshotArtifact(entry));
  if (scenario?.scenario === 'artifact_consumer') {
    artifacts.unshift(snapshotArtifact(
      {
        artifact_id: id(506),
        sha256: FIXED_ARTIFACT_SHA256,
        size_bytes: 61,
      },
      'input',
      id(506),
    ));
  }
  const inputs = artifacts.filter((entry) => entry.direction === 'input').length;
  const outputs = artifacts.length - inputs;
  const created = `2026-08-04T12:${String(index).padStart(2, '0')}:01+00:00`;
  const started = `2026-08-04T12:${String(index).padStart(2, '0')}:02+00:00`;
  const finished = `2026-08-04T12:${String(index).padStart(2, '0')}:03+00:00`;
  return {
    run_id: runId,
    receipt_id: receiptId,
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    caller_function: scenario === null ? 'run_compute_policy_probe' : 'run_compute_certification',
    state,
    state_version: '5',
    billing_mode: 'wallet',
    capacity_agent_id: AGENT_ID,
    environment_digest: ENVIRONMENT_DIGEST,
    directive_hash: hash(`directive-${index}`),
    request_hash: hash(`request-${index}`),
    created_at: created,
    updated_at: finished,
    expires_at: '2026-08-04T14:00:00+00:00',
    started_at: started,
    finished_at: finished,
    cardinality: {
      budget_rows: 1,
      receipt_rows: 1,
      token_rows: 1,
      artifact_rows: artifacts.length,
      input_artifact_rows: inputs,
      output_artifact_rows: outputs,
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
      settled_at: finished,
    },
    receipt: {
      id: receiptId,
      outcome: state,
      billing_mode: 'wallet',
      rate_version: 'compute-rate-v1',
      capacity_settlement_status: 'not_applicable',
      reserved_light: '0.433816000000',
      actual_light: '0.002056000000',
      released_light: '0.431760000000',
      worker_wall_ms: '1000',
      teardown_allowance_ms: '15000',
      billed_wall_ms: '1000',
      created_at: finished,
    },
    terminal_active_token_count: 0,
    artifacts,
    violations: [],
  };
}

function operatorSnapshot(suite, runSet) {
  const runs = suite.scenarios.map((scenario, index) =>
    snapshotRun(
      scenario.run_id,
      scenario.receipt_id,
      scenarioOutcome(scenario.scenario).state,
      index,
      scenario,
    )
  );
  runs.push(snapshotRun(runSet.run_ids.at(-1), id(110), 'succeeded', 10));
  return {
    schema_version: 1,
    generated_at: SNAPSHOT_AT,
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    since: '2026-08-04T12:00:00+00:00',
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

function fixture(profile = 'production-canary') {
  const target = profile === 'staging-full' ? 'staging' : 'production';
  const policy = profile === 'production-global' ? 'global' : 'canary';
  const suite = suiteEvidence(profile, target);
  const runSet = runSetEvidence(suite);
  return {
    args: {
      suiteEvidence: suite,
      runSetEvidence: runSet,
      operatorSnapshot: operatorSnapshot(suite, runSet),
      canaryIdentity: canaryIdentity(target),
      promotedState: promotedState(target, policy),
      expectedTarget: target,
      expectedProfile: profile,
      expectedCandidateSha: CANDIDATE_SHA,
      expectedWorkflowRunId: WORKFLOW_RUN_ID,
    },
  };
}

function clone(value) {
  return structuredClone(value);
}

test('strictly verifies each deployable certification profile', () => {
  for (
    const profile of [
      'staging-full',
      'production-canary',
      'production-global',
    ]
  ) {
    const { args } = fixture(profile);
    const result = validateComputeCertificationEvidence(args);
    assert.equal(result.schema_version, 1);
    assert.equal(result.kind, 'galactic_compute_certification_verification');
    assert.equal(result.verified, true);
    assert.equal(result.profile, profile);
    assert.equal(result.environment_digest, ENVIRONMENT_DIGEST);
    assert.deepEqual(result.scenario_run_ids, args.runSetEvidence.run_ids.slice(0, 10));
    assert.equal(result.policy_compute_run_id, args.runSetEvidence.run_ids[10]);
    assert.equal(result.compute_receipt_ids.length, 11);
    assert.equal(result.artifact_digests.deterministic_fixture, FIXED_ARTIFACT_SHA256);
  }
});

test('fails closed across provenance, suite, run-set, snapshot, and rollout drift', async (t) => {
  const cases = [
    ['suite extra field', (args) => {
      args.suiteEvidence.private = 'value';
    }],
    ['suite false', (args) => {
      args.suiteEvidence.verified = false;
    }],
    ['wrong marker', (args) => {
      args.suiteEvidence.marker_sha256 = 'f'.repeat(64);
    }],
    ['cleanup enabled', (args) => {
      args.suiteEvidence.cleanup.compute_policy_disabled = false;
    }],
    ['cleanup missing active Compute drain proof', (args) => {
      delete args.suiteEvidence.cleanup.active_compute_runs_remaining;
    }],
    ['cleanup missing active routine drain proof', (args) => {
      delete args.suiteEvidence.cleanup.active_routine_runs_remaining;
    }],
    ['cleanup has an active Compute run', (args) => {
      args.suiteEvidence.cleanup.active_compute_runs_remaining = 1;
    }],
    ['cleanup has an active routine run', (args) => {
      args.suiteEvidence.cleanup.active_routine_runs_remaining = 1;
    }],
    ['cleanup Compute drain proof is not an exact numeric zero', (args) => {
      args.suiteEvidence.cleanup.active_compute_runs_remaining = '0';
    }],
    ['cleanup routine drain proof is not an exact numeric zero', (args) => {
      args.suiteEvidence.cleanup.active_routine_runs_remaining = '0';
    }],
    ['cleanup has an unexpected field', (args) => {
      args.suiteEvidence.cleanup.unverified = true;
    }],
    ['scenario reordered', (args) => {
      [args.suiteEvidence.scenarios[0], args.suiteEvidence.scenarios[1]] = [
        args.suiteEvidence.scenarios[1],
        args.suiteEvidence.scenarios[0],
      ];
    }],
    ['duplicate scenario run', (args) => {
      args.suiteEvidence.scenarios[1].run_id = args.suiteEvidence.scenarios[0].run_id;
    }],
    ['duplicate receipt', (args) => {
      args.suiteEvidence.scenarios[1].receipt_id = args.suiteEvidence.scenarios[0].receipt_id;
    }],
    ['wrong exit', (args) => {
      args.suiteEvidence.scenarios[5].exit_code = 0;
    }],
    ['producer digest', (args) => {
      args.suiteEvidence.scenarios[3].artifacts[0].sha256 = 'f'.repeat(64);
      args.suiteEvidence.scenarios[3].artifact_download.sha256 = 'f'.repeat(64);
    }],
    ['consumer digest', (args) => {
      args.suiteEvidence.scenarios[4].artifacts[0].sha256 = 'f'.repeat(64);
      args.suiteEvidence.scenarios[4].artifact_download[0].sha256 = 'f'.repeat(64);
    }],
    ['browser name', (args) => {
      args.suiteEvidence.scenarios[2].artifacts[0].path = 'output/other.png';
    }],
    ['cancellation replay', (args) => {
      args.suiteEvidence.scenarios[7].cancellation.replayCallReceiptId =
        args.suiteEvidence.scenarios[7].cancellation.firstCallReceiptId;
    }],
    ['cancellation before body start', (args) => {
      args.suiteEvidence.scenarios[7].observed_states = ['queued', 'cancelled'];
    }],
    ['cancellation start timestamp drift', (args) => {
      args.suiteEvidence.scenarios[7].cancellation.startedAt =
        args.suiteEvidence.scenarios[7].timestamps.created_at;
    }],
    ['policy free denied', (args) => {
      args.suiteEvidence.policy_pillar.free.status = 'failed';
    }],
    ['policy off admitted', (args) => {
      args.suiteEvidence.policy_pillar.off.compute_run_admitted = true;
    }],
    ['policy off unrelated failure', (args) => {
      args.suiteEvidence.policy_pillar.off.error_code = 'unknown_error';
    }],
    ['policy off generic skip', (args) => {
      args.suiteEvidence.policy_pillar.off.routine_status = 'skipped';
    }],
    ['policy baseline is not the managed value', (args) => {
      args.suiteEvidence.policy_pillar.baseline_policy = 'ask';
    }],
    ['policy cleanup drifts from the managed baseline', (args) => {
      args.suiteEvidence.policy_pillar.cleanup.policy = 'off';
    }],
    ['run set order', (args) => {
      args.runSetEvidence.run_ids.reverse();
    }],
    ['identity owner', (args) => {
      args.canaryIdentity.owner_id = id(999);
    }],
    ['promoted phase', (args) => {
      args.promotedState.phase = 'fenced';
    }],
    ['promoted digest', (args) => {
      args.promotedState.environment_digest = `sha256:${'c'.repeat(64)}`;
    }],
    ['snapshot extra field', (args) => {
      args.operatorSnapshot.raw_command = 'secret';
    }],
    ['snapshot owner', (args) => {
      args.operatorSnapshot.owner_id = id(998);
    }],
    ['latch active', (args) => {
      args.operatorSnapshot.latch_state = 'active';
    }],
    ['missing selected run', (args) => {
      args.operatorSnapshot.runs.pop();
      args.operatorSnapshot.selected_run_count -= 1;
    }],
    ['health drift', (args) => {
      args.operatorSnapshot.health.receipt_mismatches = 1;
    }],
    ['top violation', (args) => {
      args.operatorSnapshot.violations = ['EMERGENCY_STOP_LATCH_SET'];
    }],
    ['nonterminal run', (args) => {
      args.operatorSnapshot.runs[0].state = 'running';
      args.operatorSnapshot.runs[0].receipt.outcome = 'running';
    }],
    ['run violation', (args) => {
      args.operatorSnapshot.runs[0].violations = ['BILLING_BACKING_INVALID'];
    }],
    ['active token', (args) => {
      args.operatorSnapshot.runs[0].terminal_active_token_count = 1;
    }],
    ['receipt mismatch', (args) => {
      args.operatorSnapshot.runs[0].receipt_id = id(997);
      args.operatorSnapshot.runs[0].receipt.id = id(997);
    }],
    ['accounting mismatch', (args) => {
      args.operatorSnapshot.runs[0].budget.released_light = '0.700000000000';
      args.operatorSnapshot.runs[0].receipt.released_light = '0.700000000000';
    }],
    ['backing mismatch', (args) => {
      args.operatorSnapshot.runs[0].backing.receipt_cloud_usage_event = false;
    }],
    ['tariff mismatch', (args) => {
      args.operatorSnapshot.runs[0].budget.rate_light_per_ms =
        '0.000002057000';
    }],
    ['billed wall mismatch', (args) => {
      args.operatorSnapshot.runs[0].receipt.billed_wall_ms = '16000';
    }],
    ['cardinality mismatch', (args) => {
      args.operatorSnapshot.runs[2].cardinality.artifact_rows = 1;
    }],
    ['artifact hash mismatch', (args) => {
      args.operatorSnapshot.runs[2].artifacts[0].sha256 = 'e'.repeat(64);
    }],
    ['consumer input mismatch', (args) => {
      args.operatorSnapshot.runs[4].artifacts[0].sha256 = 'd'.repeat(64);
    }],
    ['deleted output', (args) => {
      args.operatorSnapshot.runs[2].artifacts[0].state = 'deleted';
    }],
    ['deleted input object', (args) => {
      args.operatorSnapshot.runs[4].artifacts[0].object_deleted = true;
    }],
    ['environment digest mismatch', (args) => {
      args.operatorSnapshot.runs[6].environment_digest = `sha256:${'d'.repeat(64)}`;
    }],
    ['snapshot predates suite', (args) => {
      args.operatorSnapshot.generated_at = '2026-08-04T12:59:59+00:00';
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const args = clone(fixture().args);
      mutate(args);
      assert.throws(
        () => validateComputeCertificationEvidence(args),
        /^Error: Compute certification evidence is invalid:/u,
      );
    });
  }
});

test('accepts conserved subscription-capacity accounting', () => {
  const { args } = fixture();
  const run = args.operatorSnapshot.runs[0];
  run.billing_mode = 'subscription_capacity';
  run.backing = {
    ...run.backing,
    run_capacity_reservation: true,
    budget_hold: false,
    budget_capacity_reservation: true,
    receipt_hold: false,
    receipt_capacity_reservation: true,
    receipt_cloud_usage_event: false,
  };
  Object.assign(run.budget, {
    billing_mode: 'subscription_capacity',
    actual_wall_ms: '300000',
    reserved_light: '0.433816000000',
    actual_light: '0.616800000000',
    released_light: '0.000000000000',
  });
  Object.assign(run.receipt, {
    billing_mode: 'subscription_capacity',
    capacity_settlement_status: 'settled',
    reserved_light: '0.433816000000',
    actual_light: '0.616800000000',
    released_light: '0.000000000000',
    worker_wall_ms: '300000',
    billed_wall_ms: '300000',
  });
  assert.equal(validateComputeCertificationEvidence(args).verified, true);
});

test('errors never echo private evidence values', () => {
  const { args } = fixture();
  const privateValue = 'private-owner-value-that-must-not-leak';
  args.operatorSnapshot.owner_id = privateValue;
  assert.throws(
    () => validateComputeCertificationEvidence(args),
    (error) =>
      error instanceof Error &&
      error.message.startsWith('Compute certification evidence is invalid:') &&
      !error.message.includes(privateValue),
  );
});

test('writes one deterministic private combined verification artifact', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'compute-certification-validator-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { args } = fixture();
  const paths = {
    suiteEvidencePath: join(directory, 'suite.json'),
    runSetPath: join(directory, 'run-set.json'),
    operatorSnapshotPath: join(directory, 'snapshot.json'),
    canaryIdentityPath: join(directory, 'identity.json'),
    promotedStatePath: join(directory, 'promoted.json'),
    outputPath: join(directory, 'combined.json'),
  };
  for (
    const [path, value] of [
      [paths.suiteEvidencePath, args.suiteEvidence],
      [paths.runSetPath, args.runSetEvidence],
      [paths.operatorSnapshotPath, args.operatorSnapshot],
      [paths.canaryIdentityPath, args.canaryIdentity],
      [paths.promotedStatePath, args.promotedState],
    ]
  ) {
    writeFileSync(path, `${JSON.stringify(value)}\n`);
  }
  const options = {
    ...paths,
    expectedTarget: args.expectedTarget,
    expectedProfile: args.expectedProfile,
    expectedCandidateSha: CANDIDATE_SHA,
    expectedWorkflowRunId: WORKFLOW_RUN_ID,
  };
  const first = verifyComputeCertificationEvidence(options);
  const firstBytes = readFileSync(paths.outputPath, 'utf8');
  const second = verifyComputeCertificationEvidence(options);
  const secondBytes = readFileSync(paths.outputPath, 'utf8');
  assert.deepEqual(second, first);
  assert.equal(secondBytes, firstBytes);
  assert.equal(statSync(paths.outputPath).mode & 0o777, 0o600);
});

test('requires each named CLI flag exactly once and runs end to end', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'compute-certification-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { args } = fixture();
  const inputs = [
    ['suite.json', args.suiteEvidence],
    ['run-set.json', args.runSetEvidence],
    ['snapshot.json', args.operatorSnapshot],
    ['identity.json', args.canaryIdentity],
    ['promoted.json', args.promotedState],
  ];
  for (const [name, value] of inputs) {
    writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`);
  }
  const output = join(directory, 'verified.json');
  const argv = [
    '--suite-evidence',
    join(directory, 'suite.json'),
    '--run-set',
    join(directory, 'run-set.json'),
    '--operator-snapshot',
    join(directory, 'snapshot.json'),
    '--canary-identity',
    join(directory, 'identity.json'),
    '--promoted-state',
    join(directory, 'promoted.json'),
    '--expected-target',
    'production',
    '--expected-profile',
    'production-canary',
    '--expected-candidate-sha',
    CANDIDATE_SHA,
    '--expected-workflow-run-id',
    WORKFLOW_RUN_ID,
    '--output',
    output,
  ];
  assert.equal(computeCertificationValidatorArgs(argv).outputPath, output);
  assert.throws(
    () => computeCertificationValidatorArgs(argv.slice(2)),
    /arguments are incomplete/u,
  );
  assert.throws(
    () => computeCertificationValidatorArgs([...argv.slice(0, -2), '--run-set', output]),
    /arguments are malformed/u,
  );
  const run = spawnSync(
    process.execPath,
    ['scripts/release/verify-compute-certification-evidence.mjs', ...argv],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).verified, true);
});
