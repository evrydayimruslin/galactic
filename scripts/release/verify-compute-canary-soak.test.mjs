import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COMPUTE_CANARY_SOAK_MAX_BROWSER_GAP_SECONDS,
  COMPUTE_CANARY_SOAK_MAX_LIFECYCLE_GAP_SECONDS,
  COMPUTE_CANARY_SOAK_MINIMUM_SECONDS,
  computeCanarySoakValidatorArgs,
  validateComputeCanaryProbeEvidence,
  verifyComputeCanarySoak,
} from './verify-compute-canary-soak.mjs';

const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = Date.parse('2026-08-01T00:00:00.000Z');
const WORKFLOW_COMPLETED_AT = START + 6 * MINUTE;
const NOW = START + DAY + 10 * MINUTE;
const CAPTURED_AT = NOW - MINUTE;
const CANDIDATE_SHA = 'a'.repeat(40);
const PROBE_SHA = 'b'.repeat(40);
const REPOSITORY = 'galactic-org/galactic';
const CANARY_RUN_ID = '1000';
const GLOBAL_RUN_ID = '2000';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = `${OWNER_ID}/${AGENT_ID}`;

function iso(value) {
  return new Date(value).toISOString();
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function worker({
  name,
  versionId,
  deploymentId,
  tag,
  etag,
  compatibility,
}) {
  return {
    worker: name,
    version_id: versionId,
    version_tag: tag,
    deployment_id: deploymentId,
    code_etag: etag,
    compatibility_sha256: compatibility.repeat(64),
  };
}

const API_STATE = worker({
  name: 'ultralight-api',
  versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  deploymentId: 'abababab-abab-4bab-8bab-abababababab',
  tag: `api-${CANDIDATE_SHA}`,
  etag: 'api-etag',
  compatibility: '1',
});
const COMPUTE_STATE = worker({
  name: 'galactic-compute',
  versionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  deploymentId: 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
  tag: `compute-${CANDIDATE_SHA}`,
  etag: 'compute-etag',
  compatibility: '2',
});
const ENVIRONMENT_DIGEST = `sha256:${'c'.repeat(64)}`;

function dispatch(runId, sha = CANDIDATE_SHA) {
  return {
    repository: REPOSITORY,
    workflow_run_id: String(runId),
    run_attempt: '1',
    git_sha: sha,
  };
}

function rolloutState(runDispatch, policy = 'canary', phase = 'inspected') {
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_state',
    verified: true,
    phase,
    target: 'production',
    policy,
    canary_allowlist: policy === 'canary' ? [PRINCIPAL] : [],
    certification_principal: policy === 'off' ? null : PRINCIPAL,
    environment_digest: ENVIRONMENT_DIGEST,
    dispatch: runDispatch,
    api: structuredClone(API_STATE),
    compute: structuredClone(COMPUTE_STATE),
    source_api_version_id: phase === 'inspected'
      ? null
      : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };
}

function predecessorEvidence() {
  const canaryDispatch = dispatch(CANARY_RUN_ID);
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_predecessor_verification',
    verified: true,
    verified_at: iso(NOW - 2 * MINUTE),
    minimum_age_seconds: COMPUTE_CANARY_SOAK_MINIMUM_SECONDS,
    predecessor: {
      stage: 'production_canary',
      target: 'production',
      artifact_id: '3000',
      artifact_name:
        `compute-canary-rollout-production_canary-production-${CANARY_RUN_ID}-1`,
      artifact_created_at: iso(START + 5 * MINUTE),
      generated_at: iso(START),
      soak_eligible_at: iso(START + DAY),
      workflow_completed_at: iso(WORKFLOW_COMPLETED_AT),
    },
    dispatch: canaryDispatch,
    final_state: rolloutState(canaryDispatch, 'canary', 'fenced'),
  };
}

function terminalRun(index, generatedAt, offset = 0) {
  return {
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    run_id: uuid(offset + index * 10 + 1),
    receipt_id: uuid(offset + index * 10 + 2),
    state: 'completed',
    environment_digest: ENVIRONMENT_DIGEST,
    created_at: iso(generatedAt - 7 * MINUTE),
    started_at: iso(generatedAt - 6 * MINUTE),
    finished_at: iso(generatedAt - 4 * MINUTE),
  };
}

function probeEntry(index, generatedAt) {
  const mode = index % 2 === 0 ? 'browser' : 'lifecycle';
  const runId = String(10_000 + index);
  const runDispatch = dispatch(runId, PROBE_SHA);
  const lifecycle = terminalRun(index, generatedAt);
  const browser = mode === 'browser'
    ? {
      ...terminalRun(index, generatedAt + MINUTE, 50_000),
      artifacts: [
        { path: 'output/browser-https.json', sha256: 'd'.repeat(64) },
        { path: 'output/browser-https.png', sha256: 'e'.repeat(64) },
      ],
    }
    : null;
  const terminalRuns = browser ? [lifecycle, browser] : [lifecycle];
  const artifactName =
    `compute-probe-production-${CANARY_RUN_ID}-${runId}-1`;
  return {
    run: {
      id: runId,
      run_attempt: '1',
      event: 'schedule',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: PROBE_SHA,
      created_at: iso(generatedAt - 10 * MINUTE),
      run_started_at: iso(generatedAt - 9 * MINUTE),
      updated_at: iso(generatedAt + MINUTE),
    },
    artifact: {
      id: String(20_000 + index),
      name: artifactName,
      workflow_run_id: runId,
      run_attempt: '1',
      head_sha: PROBE_SHA,
      size_in_bytes: 4096,
      expired: false,
      created_at: iso(generatedAt + 90 * 1_000),
      updated_at: iso(generatedAt + 2 * MINUTE),
      expires_at: iso(NOW + 30 * DAY),
    },
    evidence: {
      schema_version: 1,
      kind: 'galactic_compute_production_probe',
      verified: true,
      outcome: 'passed',
      mode,
      target: 'production',
      started_at: iso(generatedAt - 8 * MINUTE),
      generated_at: iso(generatedAt),
      dispatch: runDispatch,
      active_rollout: {
        workflow_run_id: CANARY_RUN_ID,
        stage: 'production_canary',
        target: 'production',
        git_sha: CANDIDATE_SHA,
      },
      live_state: rolloutState(runDispatch),
      latch_state: 'clear',
      lifecycle,
      accounting: {
        snapshot_generated_at: iso(generatedAt - 2 * MINUTE),
        run_ids: terminalRuns.map((run) => run.run_id).sort(),
        receipt_ids: terminalRuns.map((run) => run.receipt_id).sort(),
        accounting_violations: 0,
        reconciliation_violations: 0,
        violations: [],
      },
      browser_artifacts: browser,
      health: {
        observed_at: iso(generatedAt - MINUTE),
        dispatch: {
          name: 'galactic-compute',
          backlog: 0,
          oldest_age_seconds: 0,
        },
        compute_dlq: {
          name: 'galactic-compute-dlq',
          baseline_count: 7,
          final_count: 7,
        },
        reconciliation_dlq: {
          name: 'galactic-compute-reconciliation-dlq',
          baseline_count: 3,
          final_count: 3,
        },
        accounting_violations: 0,
        reconciliation_violations: 0,
        violations: [],
      },
    },
  };
}

function fixture() {
  const entries = [];
  for (
    let generatedAt = START + 20 * MINUTE, index = 0;
    generatedAt <= NOW - 20 * MINUTE;
    generatedAt += 30 * MINUTE, index += 1
  ) {
    entries.push(probeEntry(index, generatedAt));
  }
  return {
    predecessor: predecessorEvidence(),
    entries,
    runs: {
      schema_version: 1,
      kind: 'galactic_compute_soak_run_inventory',
      repository: REPOSITORY,
      window_started_at: iso(WORKFLOW_COMPLETED_AT),
      window_ended_at: iso(CAPTURED_AT),
      captured_at: iso(CAPTURED_AT),
      queries: [
        {
          workflow_path: '.github/workflows/api-deploy.yml',
          total_count: 0,
          workflow_runs: [],
        },
        {
          workflow_path: '.github/workflows/compute-deploy.yml',
          total_count: 0,
          workflow_runs: [],
        },
        {
          workflow_path: '.github/workflows/compute-probe.yml',
          total_count: entries.length,
          workflow_runs: entries.map((entry) => entry.run),
        },
      ],
    },
    artifacts: {
      schema_version: 1,
      kind: 'galactic_compute_soak_artifact_inventory',
      repository: REPOSITORY,
      captured_at: iso(CAPTURED_AT),
      total_count: entries.length,
      artifacts: entries.map((entry) => entry.artifact),
    },
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function materialize(value, nowMs = NOW) {
  const directory = mkdtempSync(join(tmpdir(), 'compute-canary-soak-'));
  const evidenceDirectory = join(directory, 'probe-evidence');
  mkdirSync(evidenceDirectory);
  const predecessorPath = join(directory, 'predecessor.json');
  const runInventoryPath = join(directory, 'runs.json');
  const artifactInventoryPath = join(directory, 'artifacts.json');
  writeJson(predecessorPath, value.predecessor);
  writeJson(runInventoryPath, value.runs);
  writeJson(artifactInventoryPath, value.artifacts);
  for (const entry of value.entries) {
    const artifactDirectory = join(evidenceDirectory, entry.artifact.name);
    mkdirSync(artifactDirectory, { recursive: true });
    writeJson(join(artifactDirectory, 'compute-canary-probe.json'), entry.evidence);
  }
  return {
    predecessorPath,
    runInventoryPath,
    artifactInventoryPath,
    evidenceDirectory,
    currentGitSha: CANDIDATE_SHA,
    currentWorkflowRunId: GLOBAL_RUN_ID,
    nowMs,
  };
}

function verify(value, nowMs = NOW) {
  return verifyComputeCanarySoak(materialize(value, nowMs));
}

function removeEntry(value, index) {
  const [run] = value.runs.queries[2].workflow_runs.splice(index, 1);
  value.runs.queries[2].total_count -= 1;
  const artifactIndex = value.artifacts.artifacts.findIndex((artifact) =>
    String(artifact.workflow_run_id) === String(run.id)
  );
  value.artifacts.artifacts.splice(artifactIndex, 1);
  value.artifacts.total_count -= 1;
}

test('accepts an exact continuously healthy 24-hour production canary soak', () => {
  const value = fixture();
  const result = verify(value);
  assert.equal(result.schema_version, 1);
  assert.equal(result.kind, 'galactic_compute_canary_soak_verification');
  assert.equal(result.verified, true);
  assert.equal(result.minimum_soak_seconds, 86_400);
  assert.equal(result.soak_started_at, iso(WORKFLOW_COMPLETED_AT));
  assert.equal(
    result.soak_eligible_at,
    iso(WORKFLOW_COMPLETED_AT + DAY),
  );
  assert.equal(result.probe_count, 48);
  assert.equal(result.browser_probe_count, 24);
  assert.equal(result.accepted_probe_run_ids.length, 48);
  assert.equal(result.maximum_lifecycle_gap_seconds, 1_800);
  assert.equal(result.maximum_browser_gap_seconds, 3_600);
  assert.deepEqual(result.dlq, {
    compute: {
      name: 'galactic-compute-dlq',
      baseline_count: 7,
      final_count: 7,
    },
    reconciliation: {
      name: 'galactic-compute-reconciliation-dlq',
      baseline_count: 3,
      final_count: 3,
    },
  });
  assert.equal(result.live_state.api_version_id, API_STATE.version_id);
  assert.equal(result.live_state.compute_version_id, COMPUTE_STATE.version_id);
  assert.equal(result.live_state.certification_principal, PRINCIPAL);
});

test('exports the release thresholds as stable guards', () => {
  assert.equal(COMPUTE_CANARY_SOAK_MINIMUM_SECONDS, 86_400);
  assert.equal(COMPUTE_CANARY_SOAK_MAX_LIFECYCLE_GAP_SECONDS, 2_100);
  assert.equal(COMPUTE_CANARY_SOAK_MAX_BROWSER_GAP_SECONDS, 4_200);
});

test('strict CLI accepts every flag once and rejects ambiguity', () => {
  const args = [
    '--predecessor', 'predecessor.json',
    '--runs', 'runs.json',
    '--artifacts', 'artifacts.json',
    '--evidence-dir', 'probe-evidence',
    '--current-git-sha', CANDIDATE_SHA,
    '--current-workflow-run-id', GLOBAL_RUN_ID,
  ];
  const parsed = computeCanarySoakValidatorArgs(args);
  assert.equal(parsed.currentGitSha, CANDIDATE_SHA);
  assert.equal(parsed.currentWorkflowRunId, GLOBAL_RUN_ID);
  assert.throws(
    () => computeCanarySoakValidatorArgs(args.slice(0, -2)),
    /CLI arguments are incomplete/u,
  );
  assert.throws(
    () => computeCanarySoakValidatorArgs([
      ...args.slice(0, -2),
      '--runs', 'other.json',
    ]),
    /unknown, duplicate, or empty/u,
  );
  assert.throws(
    () => computeCanarySoakValidatorArgs([...args, '--unknown', 'value']),
    /CLI arguments are incomplete/u,
  );
});

test('accepts an explicit OFF bootstrap no-op structurally but never as soak evidence', () => {
  const value = fixture();
  const entry = value.entries[0];
  entry.evidence.outcome = 'off_noop';
  entry.evidence.mode = 'lifecycle';
  entry.evidence.active_rollout = null;
  entry.evidence.live_state = rolloutState(entry.evidence.dispatch, 'off');
  entry.evidence.lifecycle = null;
  entry.evidence.accounting = null;
  entry.evidence.browser_artifacts = null;
  entry.evidence.health = null;

  const run = {
    ...entry.run,
    id: String(entry.run.id),
    run_attempt: '1',
    createdAt: Date.parse(entry.run.created_at),
    runStartedAt: Date.parse(entry.run.run_started_at),
    updatedAt: Date.parse(entry.run.updated_at),
  };
  const artifact = {
    ...entry.artifact,
    createdAt: Date.parse(entry.artifact.created_at),
  };
  const predecessor = {
    dispatch: dispatch(CANARY_RUN_ID),
    finalState: value.predecessor.final_state,
  };
  assert.equal(
    validateComputeCanaryProbeEvidence(entry.evidence, {
      run,
      artifact,
      predecessor,
    }).outcome,
    'off_noop',
  );
  assert.throws(
    () => verify(value),
    /OFF no-op evidence cannot satisfy or occur inside an enabled soak/u,
  );
});

test('OFF no-op must be clean and cannot retain admitted-run proof', () => {
  const value = fixture();
  const entry = value.entries[0];
  entry.evidence.outcome = 'off_noop';
  entry.evidence.mode = 'lifecycle';
  entry.evidence.active_rollout = null;
  entry.evidence.live_state = rolloutState(entry.evidence.dispatch, 'off');
  entry.evidence.accounting = null;
  entry.evidence.browser_artifacts = null;
  entry.evidence.health = null;
  assert.throws(
    () => verify(value),
    /OFF probe evidence is not an explicit clean no-op/u,
  );
});

test('requires the predecessor to declare and satisfy at least 24 hours', () => {
  for (const mutate of [
    (value) => {
      value.predecessor.minimum_age_seconds = 3_600;
    },
    (value) => {
      value.predecessor.predecessor.soak_eligible_at = iso(START + HOUR);
    },
    (value) => {
      value.predecessor.verified_at = iso(START + DAY - MINUTE);
    },
  ]) {
    const value = fixture();
    mutate(value);
    assert.throws(
      () => verify(value),
      /predecessor does not prove a mature production canary/u,
    );
  }
});

test('rejects lifecycle gaps over 35 minutes and a stale final success', () => {
  const interior = fixture();
  removeEntry(interior, 10);
  assert.throws(
    () => verify(interior),
    /continuously cover at least 24 hours/u,
  );

  const staleFinal = fixture();
  removeEntry(staleFinal, staleFinal.runs.queries[2].workflow_runs.length - 1);
  assert.throws(
    () => verify(staleFinal),
    /continuously cover at least 24 hours/u,
  );
});

test('requires browser evidence every UTC hour and within the bounded gap', () => {
  const value = fixture();
  for (const entry of value.entries) {
    const generatedAt = Date.parse(entry.evidence.generated_at);
    if (generatedAt >= START + 5 * HOUR && generatedAt < START + 7 * HOUR) {
      entry.evidence.mode = 'lifecycle';
      entry.evidence.accounting.run_ids = [entry.evidence.lifecycle.run_id];
      entry.evidence.accounting.receipt_ids = [entry.evidence.lifecycle.receipt_id];
      entry.evidence.browser_artifacts = null;
    }
  }
  assert.throws(
    () => verify(value),
    /browser probe cadence exceeded|no browser probe completed/u,
  );
});

test('rejects failed, skipped, incomplete, manual, and rerun scheduled probes', () => {
  for (const [field, replacement] of [
    ['conclusion', 'failure'],
    ['conclusion', 'skipped'],
    ['status', 'in_progress'],
    ['event', 'workflow_dispatch'],
    ['run_attempt', '2'],
  ]) {
    const value = fixture();
    value.runs.queries[2].workflow_runs[4][field] = replacement;
    assert.throws(
      () => verify(value),
      /scheduled probe failed, was skipped, rerun, or is ambiguous/u,
      `${field}=${replacement}`,
    );
  }
});

test('rejects production API or Compute deployment runs overlapping the soak', () => {
  for (const queryIndex of [0, 1]) {
    const value = fixture();
    value.runs.queries[queryIndex].workflow_runs.push({
      id: String(90_000 + queryIndex),
      run_attempt: '1',
      event: queryIndex === 0 ? 'push' : 'workflow_dispatch',
      status: 'completed',
      conclusion: 'failure',
      head_branch: 'v0.4.99',
      head_sha: CANDIDATE_SHA,
      created_at: iso(START + HOUR),
      run_started_at: iso(START + HOUR + MINUTE),
      updated_at: iso(START + HOUR + 2 * MINUTE),
    });
    value.runs.queries[queryIndex].total_count = 1;
    assert.throws(
      () => verify(value),
      /ran after the production canary soak started/u,
    );
  }
});

test('rejects a pre-soak production deploy approved and run during the soak', () => {
  for (const queryIndex of [0, 1]) {
    const value = fixture();
    value.runs.queries[queryIndex].workflow_runs.push({
      id: String(90_100 + queryIndex),
      run_attempt: '1',
      event: queryIndex === 0 ? 'push' : 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'v0.4.99',
      head_sha: CANDIDATE_SHA,
      created_at: iso(START - 2 * DAY),
      run_started_at: iso(START + HOUR),
      updated_at: iso(START + HOUR + 2 * MINUTE),
    });
    value.runs.queries[queryIndex].total_count = 1;
    assert.throws(
      () => verify(value),
      /ran after the production canary soak started/u,
    );
  }
});

test('ignores staging-only API and Compute deploy workflow runs', () => {
  const value = fixture();
  for (const [queryIndex, event] of [[0, 'push'], [1, 'workflow_dispatch']]) {
    value.runs.queries[queryIndex].workflow_runs.push({
      id: String(91_000 + queryIndex),
      run_attempt: '1',
      event,
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: CANDIDATE_SHA,
      created_at: iso(START + HOUR),
      run_started_at: iso(START + HOUR + MINUTE),
      updated_at: iso(START + HOUR + 2 * MINUTE),
    });
    value.runs.queries[queryIndex].total_count = 1;
  }
  assert.equal(verify(value).verified, true);
});

test('rejects API, Compute, digest, policy, principal, and latch drift', () => {
  const cases = [
    ['API version', (evidence) => {
      evidence.live_state.api.version_id = uuid(700_001);
    }],
    ['API deployment', (evidence) => {
      evidence.live_state.api.deployment_id = uuid(700_002);
    }],
    ['Compute version', (evidence) => {
      evidence.live_state.compute.version_id = uuid(700_003);
    }],
    ['Compute deployment', (evidence) => {
      evidence.live_state.compute.deployment_id = uuid(700_004);
    }],
    ['digest', (evidence) => {
      evidence.live_state.environment_digest = `sha256:${'f'.repeat(64)}`;
      evidence.lifecycle.environment_digest = evidence.live_state.environment_digest;
      if (evidence.browser_artifacts) {
        evidence.browser_artifacts.environment_digest =
          evidence.live_state.environment_digest;
      }
    }],
    ['principal', (evidence) => {
      const other =
        '33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444';
      evidence.live_state.certification_principal = other;
      evidence.live_state.canary_allowlist = [other];
      evidence.lifecycle.owner_id = other.split('/')[0];
      evidence.lifecycle.agent_id = other.split('/')[1];
      if (evidence.browser_artifacts) {
        evidence.browser_artifacts.owner_id = other.split('/')[0];
        evidence.browser_artifacts.agent_id = other.split('/')[1];
      }
    }],
    ['latch', (evidence) => {
      evidence.latch_state = 'stopped';
    }],
  ];
  for (const [label, mutate] of cases) {
    const value = fixture();
    mutate(value.entries[8].evidence);
    assert.throws(() => verify(value), undefined, label);
  }
});

test('rejects source/canary binding drift independently of probe workflow SHA', () => {
  const value = fixture();
  value.entries[5].evidence.active_rollout.git_sha = 'f'.repeat(40);
  assert.throws(
    () => verify(value),
    /enabled probe is not bound to the production canary rollout/u,
  );

  const changedProbeWorkflowSha = fixture();
  const entry = changedProbeWorkflowSha.entries[5];
  entry.run.head_sha = '9'.repeat(40);
  entry.artifact.head_sha = entry.run.head_sha;
  entry.evidence.dispatch.git_sha = entry.run.head_sha;
  entry.evidence.live_state.dispatch.git_sha = entry.run.head_sha;
  assert.equal(verify(changedProbeWorkflowSha).verified, true);
});

test('rejects DLQ growth or counter discontinuity', () => {
  const increased = fixture();
  increased.entries[12].evidence.health.compute_dlq.final_count = 8;
  assert.throws(() => verify(increased), /Compute DLQ increased/u);

  const discontinuous = fixture();
  discontinuous.entries[12].evidence.health.compute_dlq.baseline_count = 8;
  discontinuous.entries[12].evidence.health.compute_dlq.final_count = 8;
  assert.throws(
    () => verify(discontinuous),
    /Compute DLQ counters changed during the enabled soak/u,
  );
});

test('rejects accounting, reconciliation, queue, and free-form health violations', () => {
  const cases = [
    (evidence) => {
      evidence.accounting.accounting_violations = 1;
    },
    (evidence) => {
      evidence.accounting.reconciliation_violations = 1;
    },
    (evidence) => {
      evidence.health.accounting_violations = 1;
    },
    (evidence) => {
      evidence.health.reconciliation_violations = 1;
    },
    (evidence) => {
      evidence.health.dispatch.backlog = 1;
    },
    (evidence) => {
      evidence.health.violations = ['unexpected'];
    },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value.entries[3].evidence);
    assert.throws(() => verify(value));
  }
});

test('requires complete current run and artifact inventories', () => {
  const truncatedRuns = fixture();
  truncatedRuns.runs.queries[2].total_count += 1;
  assert.throws(() => verify(truncatedRuns), /truncated/u);

  const truncatedArtifacts = fixture();
  truncatedArtifacts.artifacts.total_count += 1;
  assert.throws(() => verify(truncatedArtifacts), /truncated/u);

  const missingArtifact = fixture();
  missingArtifact.artifacts.artifacts.pop();
  missingArtifact.artifacts.total_count -= 1;
  assert.throws(
    () => verify(missingArtifact),
    /exactly one artifact per probe/u,
  );

  const stale = fixture();
  stale.runs.window_ended_at = iso(NOW - 6 * MINUTE);
  stale.runs.captured_at = stale.runs.window_ended_at;
  stale.artifacts.captured_at = stale.runs.window_ended_at;
  assert.throws(() => verify(stale), /stale, incomplete/u);
});

test('requires exact artifact provenance and schema-versioned evidence paths', () => {
  const wrongName = fixture();
  wrongName.artifacts.artifacts[0].name = 'compute-probe-production-wrong';
  assert.throws(() => verify(wrongName), /one exact GitHub artifact/u);

  const wrongHead = fixture();
  wrongHead.artifacts.artifacts[0].head_sha = 'f'.repeat(40);
  assert.throws(() => verify(wrongHead), /one exact GitHub artifact/u);

  const wrongSchema = fixture();
  wrongSchema.entries[0].evidence.schema_version = 2;
  assert.throws(() => verify(wrongSchema), /provenance or lifecycle/u);
});

test('requires terminal browser runs, exact accounted IDs, and both artifact hashes', () => {
  const missingHash = fixture();
  missingHash.entries[0].evidence.browser_artifacts.artifacts.pop();
  assert.throws(() => verify(missingHash), /exactly two artifacts/u);

  const unaccounted = fixture();
  unaccounted.entries[0].evidence.accounting.run_ids.pop();
  assert.throws(() => verify(unaccounted), /incomplete or has violations/u);

  const nonterminal = fixture();
  nonterminal.entries[0].evidence.browser_artifacts.state = 'failed';
  assert.throws(() => verify(nonterminal), /successful terminal Compute run/u);
});

test('fails closed on extra keys and malformed canonical timestamps', () => {
  const extra = fixture();
  extra.entries[0].evidence.untrusted = true;
  assert.throws(() => verify(extra), /unexpected shape/u);

  const timestamp = fixture();
  timestamp.entries[0].evidence.generated_at = '2026-08-01T00:20:00+00:00';
  assert.throws(() => verify(timestamp), /canonical UTC timestamp/u);
});
