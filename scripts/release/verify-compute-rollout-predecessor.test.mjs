import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyComputeRolloutPredecessor } from './verify-compute-rollout-predecessor.mjs';

const SCRIPT = fileURLToPath(
  new URL('./verify-compute-rollout-predecessor.mjs', import.meta.url),
);
const GIT_SHA = 'a'.repeat(40);
const RECOVERY_SOURCE_SHA = 'f'.repeat(40);
const RELEASE_SHA = 'b'.repeat(40);
const RUN_ID = '31000000000';
const RUN_ATTEMPT = '2';
const ARTIFACT_ID = '41000000000';
const REPOSITORY_ID = '51000000000';
const REPOSITORY = 'evrydayimruslin/galactic';
const DIGEST = `sha256:${'c'.repeat(64)}`;
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const ALLOWLIST_ENTRY = `${OWNER_ID}/${AGENT_ID}`;
const API_ID = '33333333-3333-4333-8333-333333333333';
const CANDIDATE_API_ID = '44444444-4444-4444-8444-444444444444';
const RECOVERY_OFF_API_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COMPUTE_ID = '55555555-5555-4555-8555-555555555555';
const API_DEPLOYMENT_ID = '66666666-6666-4666-8666-666666666666';
const CANDIDATE_DEPLOYMENT_ID = '77777777-7777-4777-8777-777777777777';
const COMPUTE_DEPLOYMENT_ID = '88888888-8888-4888-8888-888888888888';
const COMPUTE_RUN_ID = '99999999-9999-4999-8999-999999999999';
const COMPUTE_RECEIPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const START_RECEIPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STATUS_RECEIPT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW_MS = Date.parse('2030-01-01T00:00:00.000Z');
const GENERATED_AT = '2020-01-02T12:00:00.000Z';
const SOAK_ELIGIBLE_AT = '2020-01-02T13:00:00.000Z';

const TARGETS = {
  staging: {
    apiWorker: 'ultralight-api-staging',
    computeWorker: 'galactic-compute-staging',
  },
  production: {
    apiWorker: 'ultralight-api',
    computeWorker: 'galactic-compute',
  },
};

const STAGES = {
  staging_canary: {
    target: 'staging',
    policy: 'canary',
    phase: 'fenced',
    predecessor: null,
  },
  production_canary: {
    target: 'production',
    policy: 'canary',
    phase: 'fenced',
    predecessor: 'staging_canary',
  },
  production_global: {
    target: 'production',
    policy: 'global',
    phase: 'fenced',
    predecessor: 'production_canary',
  },
  revert_off: {
    target: null,
    policy: 'off',
    phase: 'fenced',
    predecessor: 'enabled',
  },
};

function jsonBytes(value) {
  return `${JSON.stringify(value)}\n`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(directory, file, value) {
  const content = jsonBytes(value);
  writeFileSync(join(directory, file), content);
  return hash(content);
}

function dispatch(runId = RUN_ID, runAttempt = RUN_ATTEMPT) {
  return {
    repository: REPOSITORY,
    workflow_run_id: runId,
    run_attempt: runAttempt,
    git_sha: GIT_SHA,
  };
}

function workerState(worker, {
  versionId,
  versionTag,
  deploymentId,
  codeEtag,
  compatibilitySha256,
}) {
  return {
    worker,
    version_id: versionId,
    version_tag: versionTag,
    deployment_id: deploymentId,
    code_etag: codeEtag,
    compatibility_sha256: compatibilitySha256,
  };
}

function rolloutState({
  stage,
  target,
  stateDispatch,
  anchor = false,
}) {
  const contract = STAGES[stage];
  const policy = anchor ? 'off' : contract.policy;
  const phase = anchor ? 'captured' : contract.phase;
  const names = TARGETS[target];
  const canaryAllowlist = policy === 'canary' ? [ALLOWLIST_ENTRY] : [];
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_state',
    verified: true,
    phase,
    target,
    policy,
    canary_allowlist: canaryAllowlist,
    environment_digest: DIGEST,
    dispatch: stateDispatch,
    api: workerState(names.apiWorker, {
      versionId: anchor || policy === 'off' ? API_ID : CANDIDATE_API_ID,
      versionTag: anchor || policy === 'off'
        ? `api-${'1'.repeat(40)}-off`
        : `api-${'2'.repeat(40)}-${policy}`,
      deploymentId: anchor
        ? API_DEPLOYMENT_ID
        : policy === 'off'
        ? API_DEPLOYMENT_ID
        : CANDIDATE_DEPLOYMENT_ID,
      codeEtag: 'api-code-etag',
      compatibilitySha256: 'd'.repeat(64),
    }),
    compute: workerState(names.computeWorker, {
      versionId: COMPUTE_ID,
      versionTag: `compute-${'3'.repeat(40)}`,
      deploymentId: COMPUTE_DEPLOYMENT_ID,
      codeEtag: 'compute-code-etag',
      compatibilitySha256: 'e'.repeat(64),
    }),
    source_api_version_id: anchor ? null : policy === 'off' ? CANDIDATE_API_ID : API_ID,
  };
}

function priorStageFor(stage, target) {
  if (stage === 'production_canary') return 'staging_canary';
  if (stage === 'production_global') return 'production_canary';
  if (stage === 'revert_off') {
    return target === 'staging' ? 'staging_canary' : 'production_global';
  }
  return null;
}

function predecessorVerification(stage, target, {
  runId = '30000000000',
  runAttempt = '1',
} = {}) {
  const priorTarget = STAGES[stage].target ?? target;
  const priorDispatch = dispatch(runId, runAttempt);
  const generatedAt = stage === 'production_canary'
    ? '2020-01-01T08:00:00.000Z'
    : '2020-01-01T10:00:00.000Z';
  const soakEligibleAt = stage === 'production_canary' ? '2020-01-01T09:00:00.000Z' : null;
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_predecessor_verification',
    verified: true,
    verified_at: '2020-01-01T11:00:00.000Z',
    minimum_age_seconds: stage === 'production_canary' ? 3_600 : 0,
    predecessor: {
      stage,
      target: priorTarget,
      artifact_id: '40000000000',
      artifact_name: `compute-canary-rollout-${stage}-${priorTarget}-${runId}-${runAttempt}`,
      artifact_created_at: stage === 'production_canary'
        ? '2020-01-01T08:01:00.000Z'
        : '2020-01-01T10:01:00.000Z',
      generated_at: generatedAt,
      soak_eligible_at: soakEligibleAt,
    },
    dispatch: priorDispatch,
    final_state: rolloutState({
      stage,
      target: priorTarget,
      stateDispatch: priorDispatch,
    }),
  };
}

function canaryIdentity(target) {
  return {
    schema_version: 1,
    kind: 'galactic_compute_canary_identity',
    target,
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    allowlist_entry: ALLOWLIST_ENTRY,
  };
}

function admittedSmoke(target, smokeDispatch, identity = null) {
  const marker =
    `galactic-compute-release-smoke-v1:${smokeDispatch.git_sha}:${smokeDispatch.workflow_run_id}\n`;
  const markerSha256 = hash(marker);
  return {
    schema_version: 1,
    kind: 'galactic_compute_admitted_smoke',
    verified: true,
    target,
    candidate_sha: smokeDispatch.git_sha,
    workflow_run_id: smokeDispatch.workflow_run_id,
    agent_id: identity?.agent_id ?? AGENT_ID,
    function_name: 'run_compute_smoke',
    marker_sha256: markerSha256,
    compute_run_id: COMPUTE_RUN_ID,
    compute_receipt_id: COMPUTE_RECEIPT_ID,
    start_receipt_id: START_RECEIPT_ID,
    status_receipt_id: STATUS_RECEIPT_ID,
    observed_states: ['queued', 'settlement_pending', 'completed'],
    billing_mode: 'subscription_capacity',
    usage: { reserved: 0.5, actual: 0.25, trueUp: -0.25, unit: 'Light' },
    timestamps: {
      createdAt: '2020-01-02T11:57:00.000Z',
      startedAt: '2020-01-02T11:58:00.000Z',
      finishedAt: '2020-01-02T11:59:00.000Z',
    },
    result: {
      status: 'completed',
      exit_code: 0,
      stdout_sha256: markerSha256,
      stderr_bytes: 0,
      artifact_count: 0,
    },
    policy_cleanup: { disabled: true, revision: '8' },
    generated_at: '2020-01-02T11:59:30.000Z',
  };
}

function computeReleaseVerification(target, finalState) {
  const names = TARGETS[target];
  return {
    schema_version: 1,
    verified: true,
    target,
    release_sha: RELEASE_SHA,
    workflow_run_id: '29000000000',
    environment_digest: DIGEST,
    deployed_image: `registry.cloudflare.com/${'1'.repeat(32)}/${names.computeWorker}@${DIGEST}`,
    compute_version_id: finalState.compute.version_id,
    compute_version_tag: finalState.compute.version_tag,
  };
}

function createFixture(
  stage = 'production_canary',
  requestedTarget = null,
  { apiUploadSourceSha = GIT_SHA } = {},
) {
  const contract = STAGES[stage];
  const target = requestedTarget ?? contract.target;
  if (!target) throw new Error('test target is required');
  const directory = mkdtempSync(join(tmpdir(), 'compute-rollout-predecessor-'));
  const runJsonPath = join(directory, 'run.json');
  const artifactListJsonPath = join(directory, 'artifacts.json');
  const currentDispatch = dispatch();
  const workflowRun = {
    id: Number(RUN_ID),
    run_attempt: Number(RUN_ATTEMPT),
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/compute-canary-rollout.yml',
    head_sha: GIT_SHA,
    head_branch: 'main',
    repository: { id: Number(REPOSITORY_ID), full_name: REPOSITORY },
    head_repository: { id: Number(REPOSITORY_ID), full_name: REPOSITORY },
  };
  const artifactName = `compute-canary-rollout-${stage}-${target}-${RUN_ID}-${RUN_ATTEMPT}`;
  const artifactList = {
    total_count: 1,
    artifacts: [{
      id: Number(ARTIFACT_ID),
      name: artifactName,
      expired: false,
      created_at: '2020-01-02T12:01:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
      workflow_run: {
        id: Number(RUN_ID),
        repository_id: Number(REPOSITORY_ID),
        head_repository_id: Number(REPOSITORY_ID),
        head_branch: 'main',
        head_sha: GIT_SHA,
      },
    }],
  };
  const rollbackAnchor = rolloutState({
    stage,
    target,
    stateDispatch: currentDispatch,
    anchor: true,
  });
  const finalState = rolloutState({
    stage,
    target,
    stateDispatch: currentDispatch,
  });
  if (stage === 'revert_off') {
    finalState.source_api_version_id = null;
  }
  const identity = contract.policy === 'canary' ? canaryIdentity(target) : null;
  const smoke = contract.policy !== 'off' ? admittedSmoke(target, currentDispatch, identity) : null;
  const releaseVerification = computeReleaseVerification(target, finalState);
  const priorStage = priorStageFor(stage, target);
  const prior = priorStage ? predecessorVerification(priorStage, target) : null;

  const rollout = {
    schema_version: 1,
    kind: 'galactic_compute_canary_rollout',
    verified: true,
    stage,
    target,
    outcome: 'committed',
    generated_at: GENERATED_AT,
    soak_eligible_at: stage === 'production_canary' ? SOAK_ELIGIBLE_AT : null,
    dispatch: currentDispatch,
    api_upload_source_sha: apiUploadSourceSha,
    compute_release: {
      evidence_file: 'compute-release-verification.json',
      sha256: writeJson(
        directory,
        'compute-release-verification.json',
        releaseVerification,
      ),
      workflow_run_id: releaseVerification.workflow_run_id,
    },
    rollback_anchor: {
      evidence_file: 'rollback-anchor.json',
      sha256: writeJson(directory, 'rollback-anchor.json', rollbackAnchor),
    },
    active_state: {
      evidence_file: 'final-state.json',
      sha256: writeJson(directory, 'final-state.json', finalState),
    },
    canary_identity: identity
      ? {
        evidence_file: 'canary-identity.json',
        sha256: writeJson(directory, 'canary-identity.json', identity),
      }
      : null,
    admitted_smoke: smoke
      ? {
        evidence_file: `compute-admitted-${target}.json`,
        sha256: writeJson(
          directory,
          `compute-admitted-${target}.json`,
          smoke,
        ),
      }
      : null,
    predecessor: prior
      ? {
        evidence_file: 'predecessor-verification.json',
        sha256: writeJson(
          directory,
          'predecessor-verification.json',
          prior,
        ),
        workflow_run_id: prior.dispatch.workflow_run_id,
        stage: prior.predecessor.stage,
        target: prior.predecessor.target,
      }
      : null,
  };
  const fixture = {
    directory,
    runJsonPath,
    artifactListJsonPath,
    stage,
    target,
    workflowRun,
    artifactList,
    rollout,
    rollbackAnchor,
    finalState,
    identity,
    smoke,
    releaseVerification,
    prior,
  };
  persist(fixture);
  return fixture;
}

function persist(fixture) {
  writeFileSync(fixture.runJsonPath, jsonBytes(fixture.workflowRun));
  writeFileSync(
    fixture.artifactListJsonPath,
    jsonBytes(fixture.artifactList),
  );
  writeFileSync(
    join(fixture.directory, 'rollout.json'),
    jsonBytes(fixture.rollout),
  );
}

function rebind(fixture, field, file, value) {
  fixture.rollout[field].sha256 = writeJson(fixture.directory, file, value);
}

function verify(fixture, overrides = {}) {
  return verifyComputeRolloutPredecessor({
    evidenceDirectory: fixture.directory,
    runJsonPath: fixture.runJsonPath,
    artifactListJsonPath: fixture.artifactListJsonPath,
    expectedRunId: RUN_ID,
    expectedStage: fixture.stage,
    expectedTarget: fixture.target,
    currentGitSha: GIT_SHA,
    minimumAgeSeconds: '3600',
    nowMs: NOW_MS,
    ...overrides,
  });
}

function dispose(fixture) {
  rmSync(fixture.directory, { recursive: true, force: true });
}

test('accepts the complete stage lineage and both revert targets', () => {
  const cases = [
    ['staging_canary', 'staging'],
    ['production_canary', 'production'],
    ['production_global', 'production'],
    ['revert_off', 'staging'],
    ['revert_off', 'production'],
  ];
  for (const [stage, target] of cases) {
    const fixture = createFixture(stage, target);
    try {
      let result;
      try {
        result = verify(fixture);
      } catch (error) {
        error.message = `${stage}/${target}: ${error.message}`;
        throw error;
      }
      assert.equal(result.schema_version, 1);
      assert.equal(result.verified, true);
      assert.equal(result.predecessor.stage, stage);
      assert.equal(result.predecessor.target, target);
      assert.equal(result.predecessor.artifact_id, ARTIFACT_ID);
      assert.equal(result.dispatch.workflow_run_id, RUN_ID);
      assert.deepEqual(result.final_state, fixture.finalState);
    } finally {
      dispose(fixture);
    }
  }
});

test('accepts predecessor-less revert evidence for killed-run recovery', () => {
  for (const target of ['staging', 'production']) {
    const fixture = createFixture('revert_off', target, {
      apiUploadSourceSha: RECOVERY_SOURCE_SHA,
    });
    try {
      const recoveryTag = `api-${RECOVERY_SOURCE_SHA.slice(0, 12)}-recovery-off`;
      fixture.rollbackAnchor.phase = 'uploaded';
      fixture.rollbackAnchor.api.version_id = RECOVERY_OFF_API_ID;
      fixture.rollbackAnchor.api.version_tag = recoveryTag;
      fixture.rollbackAnchor.api.deployment_id = null;
      fixture.rollbackAnchor.source_api_version_id = CANDIDATE_API_ID;
      fixture.finalState.api.version_id = RECOVERY_OFF_API_ID;
      fixture.finalState.api.version_tag = recoveryTag;
      fixture.finalState.api.deployment_id = CANDIDATE_DEPLOYMENT_ID;
      fixture.finalState.source_api_version_id = CANDIDATE_API_ID;
      fixture.rollout.predecessor = null;
      rebind(
        fixture,
        'rollback_anchor',
        'rollback-anchor.json',
        fixture.rollbackAnchor,
      );
      rebind(
        fixture,
        'active_state',
        'final-state.json',
        fixture.finalState,
      );
      persist(fixture);
      const result = verify(fixture, { minimumAgeSeconds: '0' });
      assert.equal(result.verified, true);
      assert.equal(result.predecessor.stage, 'revert_off');
      assert.equal(result.predecessor.target, target);
      assert.notEqual(
        fixture.rollout.api_upload_source_sha,
        fixture.rollout.dispatch.git_sha,
      );
      assert.equal(fixture.rollbackAnchor.phase, 'uploaded');
      assert.equal(fixture.rollbackAnchor.api.deployment_id, null);
      assert.equal(
        result.final_state.api.version_id,
        fixture.rollbackAnchor.api.version_id,
      );
      assert.equal(
        result.final_state.source_api_version_id,
        fixture.rollbackAnchor.source_api_version_id,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('accepts an uploaded OFF anchor and production canary revert predecessor', () => {
  const uploadedAnchor = createFixture('production_global');
  const canaryRevert = createFixture('revert_off', 'production');
  try {
    uploadedAnchor.rollbackAnchor.phase = 'uploaded';
    uploadedAnchor.rollbackAnchor.api.version_id = RECOVERY_OFF_API_ID;
    uploadedAnchor.rollbackAnchor.api.version_tag = 'api-uploaded-off';
    uploadedAnchor.rollbackAnchor.api.deployment_id = null;
    uploadedAnchor.rollbackAnchor.source_api_version_id = API_ID;
    rebind(
      uploadedAnchor,
      'rollback_anchor',
      'rollback-anchor.json',
      uploadedAnchor.rollbackAnchor,
    );
    persist(uploadedAnchor);
    assert.equal(verify(uploadedAnchor).verified, true);

    canaryRevert.prior = predecessorVerification(
      'production_canary',
      'production',
    );
    canaryRevert.prior.verified_at = '2020-01-01T08:30:00.000Z';
    canaryRevert.prior.minimum_age_seconds = 0;
    canaryRevert.rollout.predecessor = {
      evidence_file: 'predecessor-verification.json',
      sha256: writeJson(
        canaryRevert.directory,
        'predecessor-verification.json',
        canaryRevert.prior,
      ),
      workflow_run_id: canaryRevert.prior.dispatch.workflow_run_id,
      stage: 'production_canary',
      target: 'production',
    };
    persist(canaryRevert);
    assert.equal(verify(canaryRevert).verified, true);
  } finally {
    dispose(uploadedAnchor);
    dispose(canaryRevert);
  }
});

test('CLI emits the sanitized predecessor identity and final state', () => {
  const fixture = createFixture('staging_canary');
  try {
    const result = spawnSync(process.execPath, [
      SCRIPT,
      fixture.directory,
      fixture.runJsonPath,
      fixture.artifactListJsonPath,
      RUN_ID,
      fixture.stage,
      fixture.target,
      GIT_SHA,
      '0',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output), [
      'schema_version',
      'kind',
      'verified',
      'verified_at',
      'minimum_age_seconds',
      'predecessor',
      'dispatch',
      'final_state',
    ]);
    assert.equal(output.predecessor.artifact_name.includes(RUN_ID), true);
    assert.deepEqual(output.final_state, fixture.finalState);
  } finally {
    dispose(fixture);
  }
});

test('rejects workflow provenance and same-repository drift', () => {
  const cases = [
    ['wrong run id', (fixture) => fixture.workflowRun.id = 31000000001],
    ['wrong attempt', (fixture) => fixture.workflowRun.run_attempt = 3],
    ['wrong event', (fixture) => fixture.workflowRun.event = 'push'],
    ['incomplete run', (fixture) => fixture.workflowRun.status = 'in_progress'],
    ['failed run', (fixture) => fixture.workflowRun.conclusion = 'failure'],
    ['wrong path', (fixture) => {
      fixture.workflowRun.path = '.github/workflows/compute-deploy.yml';
    }],
    ['wrong SHA', (fixture) => fixture.workflowRun.head_sha = 'f'.repeat(40)],
    ['wrong repository', (fixture) => {
      fixture.workflowRun.head_repository.full_name = 'attacker/fork';
    }],
    ['wrong repository id', (fixture) => {
      fixture.workflowRun.head_repository.id = 51000000001;
    }],
  ];
  for (const [name, mutate] of cases) {
    const fixture = createFixture();
    try {
      mutate(fixture);
      persist(fixture);
      assert.throws(
        () => verify(fixture),
        /Compute rollout predecessor is invalid/u,
        name,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('rejects missing, duplicate, expired, or cross-run artifacts', () => {
  const cases = [
    ['missing artifact', (fixture) => {
      fixture.artifactList.artifacts = [];
      fixture.artifactList.total_count = 0;
    }],
    ['duplicate artifact', (fixture) => {
      fixture.artifactList.artifacts.push(
        structuredClone(fixture.artifactList.artifacts[0]),
      );
      fixture.artifactList.total_count = 2;
    }],
    ['expired flag', (fixture) => {
      fixture.artifactList.artifacts[0].expired = true;
    }],
    ['expired timestamp', (fixture) => {
      fixture.artifactList.artifacts[0].expires_at = '2029-12-31T23:59:59.000Z';
    }],
    ['wrong artifact run', (fixture) => {
      fixture.artifactList.artifacts[0].workflow_run.id = 31000000001;
    }],
    ['wrong artifact SHA', (fixture) => {
      fixture.artifactList.artifacts[0].workflow_run.head_sha = 'f'.repeat(40);
    }],
    ['wrong artifact name', (fixture) => {
      fixture.artifactList.artifacts[0].name += '-other';
    }],
  ];
  for (const [name, mutate] of cases) {
    const fixture = createFixture();
    try {
      mutate(fixture);
      persist(fixture);
      assert.throws(
        () => verify(fixture),
        /Compute rollout predecessor is invalid/u,
        name,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('rejects rollout schema, dispatch, outcome, and hash tampering', () => {
  const cases = [
    ['wrong schema', (fixture) => fixture.rollout.schema_version = 2],
    ['wrong kind', (fixture) => fixture.rollout.kind = 'other'],
    ['not verified', (fixture) => fixture.rollout.verified = false],
    ['wrong outcome', (fixture) => fixture.rollout.outcome = 'reverted'],
    ['wrong stage', (fixture) => fixture.rollout.stage = 'production_global'],
    ['wrong target', (fixture) => fixture.rollout.target = 'staging'],
    ['wrong dispatch run', (fixture) => {
      fixture.rollout.dispatch.workflow_run_id = '31000000001';
    }],
    ['wrong dispatch attempt', (fixture) => {
      fixture.rollout.dispatch.run_attempt = '3';
    }],
    ['malformed API upload source SHA', (fixture) => {
      fixture.rollout.api_upload_source_sha = 'not-a-sha';
    }],
    ['non-revert API upload source drift', (fixture) => {
      fixture.rollout.api_upload_source_sha = RECOVERY_SOURCE_SHA;
    }],
    ['extra key', (fixture) => fixture.rollout.rollback_api = API_ID],
    ['tampered anchor bytes', (fixture) => {
      fixture.rollbackAnchor.api.version_tag = 'tampered-anchor';
      writeJson(fixture.directory, 'rollback-anchor.json', fixture.rollbackAnchor);
    }],
    ['wrong active hash', (fixture) => {
      fixture.rollout.active_state.sha256 = '0'.repeat(64);
    }],
  ];
  for (const [name, mutate] of cases) {
    const fixture = createFixture();
    try {
      mutate(fixture);
      persist(fixture);
      assert.throws(
        () => verify(fixture),
        /Compute rollout predecessor is invalid/u,
        name,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('rejects final-state policy, target, dispatch, digest, or Compute drift', () => {
  const cases = [
    ['wrong policy', (fixture) => fixture.finalState.policy = 'global'],
    ['wrong phase', (fixture) => fixture.finalState.phase = 'promoted'],
    ['wrong target', (fixture) => fixture.finalState.target = 'staging'],
    ['wrong final dispatch', (fixture) => {
      fixture.finalState.dispatch.workflow_run_id = '31000000001';
    }],
    ['zero digest', (fixture) => {
      fixture.finalState.environment_digest = `sha256:${'0'.repeat(64)}`;
    }],
    ['changed Compute', (fixture) => {
      fixture.finalState.compute.version_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    }],
    ['changed API code', (fixture) => {
      fixture.finalState.api.code_etag = 'different-code';
    }],
    ['missing rollback source lineage', (fixture) => {
      fixture.finalState.source_api_version_id = null;
    }],
    ['unrelated rollback source lineage', (fixture) => {
      fixture.finalState.source_api_version_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    }],
  ];
  for (const [name, mutate] of cases) {
    const fixture = createFixture();
    try {
      mutate(fixture);
      rebind(fixture, 'active_state', 'final-state.json', fixture.finalState);
      persist(fixture);
      assert.throws(
        () => verify(fixture),
        /Compute rollout predecessor is invalid/u,
        name,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('rejects canary identity and admitted-smoke drift', () => {
  const cases = [
    ['missing canary identity', (fixture) => {
      fixture.rollout.canary_identity = null;
    }],
    ['wrong identity target', (fixture) => fixture.identity.target = 'staging'],
    ['wrong allowlist identity', (fixture) => {
      fixture.identity.allowlist_entry = `${OWNER_ID}/${COMPUTE_RUN_ID}`;
    }],
    ['smoke not verified', (fixture) => fixture.smoke.verified = false],
    ['wrong smoke SHA', (fixture) => fixture.smoke.candidate_sha = RELEASE_SHA],
    ['wrong smoke run', (fixture) => {
      fixture.smoke.workflow_run_id = '31000000001';
    }],
    ['wrong smoke Agent', (fixture) => fixture.smoke.agent_id = OWNER_ID],
    ['nonterminal smoke', (fixture) => {
      fixture.smoke.observed_states = ['queued', 'running'];
    }],
    ['failed result', (fixture) => fixture.smoke.result.exit_code = 1],
    ['cleanup enabled', (fixture) => {
      fixture.smoke.policy_cleanup.disabled = false;
    }],
  ];
  for (const [name, mutate] of cases) {
    const fixture = createFixture('production_canary');
    try {
      mutate(fixture);
      if (fixture.rollout.canary_identity !== null) {
        rebind(
          fixture,
          'canary_identity',
          'canary-identity.json',
          fixture.identity,
        );
      }
      rebind(
        fixture,
        'admitted_smoke',
        'compute-admitted-production.json',
        fixture.smoke,
      );
      persist(fixture);
      assert.throws(
        () => verify(fixture),
        /Compute rollout predecessor is invalid/u,
        name,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('rejects Compute release and predecessor lineage drift', () => {
  const cases = [
    ['wrong release target', (fixture) => {
      fixture.releaseVerification.target = 'staging';
    }],
    ['wrong release digest', (fixture) => {
      fixture.releaseVerification.environment_digest = `sha256:${'f'.repeat(64)}`;
    }],
    ['wrong release Compute id', (fixture) => {
      fixture.releaseVerification.compute_version_id = API_ID;
    }],
    ['wrong release run metadata', (fixture) => {
      fixture.rollout.compute_release.workflow_run_id = '29000000001';
    }],
    ['wrong predecessor stage', (fixture) => {
      fixture.prior.predecessor.stage = 'production_global';
    }],
    ['wrong predecessor target', (fixture) => {
      fixture.prior.predecessor.target = 'staging';
    }],
    ['wrong predecessor repository', (fixture) => {
      fixture.prior.dispatch.repository = 'attacker/fork';
      fixture.prior.final_state.dispatch.repository = 'attacker/fork';
    }],
    ['wrong predecessor SHA', (fixture) => {
      fixture.prior.dispatch.git_sha = 'f'.repeat(40);
      fixture.prior.final_state.dispatch.git_sha = 'f'.repeat(40);
    }],
    ['wrong predecessor reference metadata', (fixture) => {
      fixture.rollout.predecessor.workflow_run_id = '30000000001';
    }],
  ];
  for (const [name, mutate] of cases) {
    const fixture = createFixture('production_global');
    try {
      mutate(fixture);
      rebind(
        fixture,
        'compute_release',
        'compute-release-verification.json',
        fixture.releaseVerification,
      );
      rebind(
        fixture,
        'predecessor',
        'predecessor-verification.json',
        fixture.prior,
      );
      persist(fixture);
      assert.throws(
        () => verify(fixture),
        /Compute rollout predecessor is invalid/u,
        name,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('enforces both minimum age and soak eligibility for production_canary', () => {
  const ageFixture = createFixture('production_canary');
  const soakFixture = createFixture('production_canary');
  try {
    const tooRecent = NOW_MS - 1_000;
    ageFixture.rollout.generated_at = new Date(tooRecent).toISOString();
    ageFixture.rollout.soak_eligible_at = new Date(tooRecent + 3_600_000).toISOString();
    ageFixture.artifactList.artifacts[0].created_at = new Date(tooRecent + 100).toISOString();
    persist(ageFixture);
    assert.throws(
      () => verify(ageFixture),
      /minimum age and soak eligibility/u,
    );

    soakFixture.rollout.generated_at = new Date(NOW_MS - 7_200_000).toISOString();
    soakFixture.rollout.soak_eligible_at = new Date(NOW_MS + 1_000).toISOString();
    soakFixture.artifactList.artifacts[0].created_at = new Date(NOW_MS - 7_199_900).toISOString();
    persist(soakFixture);
    assert.throws(
      () => verify(soakFixture),
      /minimum age and soak eligibility/u,
    );
  } finally {
    dispose(ageFixture);
    dispose(soakFixture);
  }
});

test('rejects illegal stage transitions and cross-target revert predecessors', () => {
  const productionCanary = createFixture('production_canary');
  const productionGlobal = createFixture('production_global');
  const stagingRevert = createFixture('revert_off', 'staging');
  const firstStage = createFixture('staging_canary');
  try {
    productionCanary.prior.predecessor.stage = 'production_canary';
    productionCanary.prior.predecessor.target = 'production';
    productionCanary.prior.final_state = rolloutState({
      stage: 'production_canary',
      target: 'production',
      stateDispatch: productionCanary.prior.dispatch,
    });
    rebind(
      productionCanary,
      'predecessor',
      'predecessor-verification.json',
      productionCanary.prior,
    );
    productionCanary.rollout.predecessor.stage = 'production_canary';
    productionCanary.rollout.predecessor.target = 'production';
    persist(productionCanary);
    assert.throws(
      () => verify(productionCanary),
      /Compute rollout predecessor is invalid/u,
    );

    productionGlobal.prior.predecessor.stage = 'staging_canary';
    productionGlobal.prior.predecessor.target = 'staging';
    productionGlobal.prior.dispatch = dispatch('30000000000', '1');
    productionGlobal.prior.final_state = rolloutState({
      stage: 'staging_canary',
      target: 'staging',
      stateDispatch: productionGlobal.prior.dispatch,
    });
    productionGlobal.prior.predecessor.artifact_name =
      'compute-canary-rollout-staging_canary-staging-30000000000-1';
    productionGlobal.prior.predecessor.soak_eligible_at = null;
    productionGlobal.prior.minimum_age_seconds = 0;
    rebind(
      productionGlobal,
      'predecessor',
      'predecessor-verification.json',
      productionGlobal.prior,
    );
    productionGlobal.rollout.predecessor.stage = 'staging_canary';
    productionGlobal.rollout.predecessor.target = 'staging';
    persist(productionGlobal);
    assert.throws(
      () => verify(productionGlobal),
      /Compute rollout predecessor is invalid/u,
    );

    stagingRevert.prior.predecessor.target = 'production';
    stagingRevert.prior.predecessor.stage = 'production_global';
    stagingRevert.prior.final_state = rolloutState({
      stage: 'production_global',
      target: 'production',
      stateDispatch: stagingRevert.prior.dispatch,
    });
    stagingRevert.prior.predecessor.artifact_name =
      'compute-canary-rollout-production_global-production-30000000000-1';
    rebind(
      stagingRevert,
      'predecessor',
      'predecessor-verification.json',
      stagingRevert.prior,
    );
    stagingRevert.rollout.predecessor.stage = 'production_global';
    stagingRevert.rollout.predecessor.target = 'production';
    persist(stagingRevert);
    assert.throws(
      () => verify(stagingRevert),
      /Compute rollout predecessor is invalid/u,
    );

    firstStage.prior = predecessorVerification(
      'staging_canary',
      'staging',
    );
    firstStage.rollout.predecessor = {
      evidence_file: 'predecessor-verification.json',
      sha256: writeJson(
        firstStage.directory,
        'predecessor-verification.json',
        firstStage.prior,
      ),
      workflow_run_id: firstStage.prior.dispatch.workflow_run_id,
      stage: 'staging_canary',
      target: 'staging',
    };
    persist(firstStage);
    assert.throws(
      () => verify(firstStage),
      /must not bind predecessor verification/u,
    );
  } finally {
    dispose(productionCanary);
    dispose(productionGlobal);
    dispose(stagingRevert);
    dispose(firstStage);
  }
});
