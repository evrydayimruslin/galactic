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
const OTHER_DIGEST = `sha256:${'4'.repeat(64)}`;
const RUNTIME_PROVENANCE = {
  schema_version: 1,
  base_image: `docker.io/cloudflare/sandbox:0.12.3-python@sha256:${'5'.repeat(64)}`,
  build_inputs_sha256: `sha256:${'6'.repeat(64)}`,
  layer_manifest_sha256: `sha256:${'7'.repeat(64)}`,
  layer_count: 45,
};
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const ALLOWLIST_ENTRY = `${OWNER_ID}/${AGENT_ID}`;
const API_ID = '33333333-3333-4333-8333-333333333333';
const CANDIDATE_API_ID = '44444444-4444-4444-8444-444444444444';
const RECOVERY_OFF_API_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const COMPUTE_ID = '55555555-5555-4555-8555-555555555555';
const SOURCE_COMPUTE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const API_DEPLOYMENT_ID = '66666666-6666-4666-8666-666666666666';
const CANDIDATE_DEPLOYMENT_ID = '77777777-7777-4777-8777-777777777777';
const COMPUTE_DEPLOYMENT_ID = '88888888-8888-4888-8888-888888888888';
const COMPUTE_RUN_ID = '99999999-9999-4999-8999-999999999999';
const NOW_MS = Date.parse('2030-01-01T00:00:00.000Z');
const GENERATED_AT = '2020-01-02T12:00:00.000Z';
const SOAK_ELIGIBLE_AT = '2020-01-03T12:00:00.000Z';
const FIXED_ARTIFACT_SHA256 =
  '6ad9b8ea5280658dc4b229a2b6180d530c4d3824b541d218266ea6049e8b763b';

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

function uuid(index) {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
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
    certification_principal: policy === 'off' ? null : ALLOWLIST_ENTRY,
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
  const soakEligibleAt = stage === 'production_canary' ? '2020-01-02T08:00:00.000Z' : null;
  const finalState = rolloutState({
    stage,
    target: priorTarget,
    stateDispatch: priorDispatch,
  });
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_predecessor_verification',
    verified: true,
    verified_at: stage === 'production_canary'
      ? '2020-01-02T11:00:00.000Z'
      : '2020-01-01T11:00:00.000Z',
    minimum_age_seconds: stage === 'production_canary' ? 86_400 : 0,
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
      workflow_completed_at: stage === 'production_canary'
        ? '2020-01-01T08:02:00.000Z'
        : '2020-01-01T10:02:00.000Z',
    },
    dispatch: priorDispatch,
    compute_release: computeReleaseVerification(priorTarget, finalState),
    final_state: finalState,
  };
}

function activeSoakVerification(prior, currentDispatch) {
  const acceptedProbeRunIds = ['61000000001', '61000000002', '61000000003'];
  const browserProbeRunIds = ['61000000002'];
  return {
    schema_version: 1,
    kind: 'galactic_compute_canary_soak_verification',
    verified: true,
    verified_at: '2020-01-02T11:59:00.000Z',
    target: 'production',
    repository: currentDispatch.repository,
    candidate_sha: currentDispatch.git_sha,
    production_canary_workflow_run_id: prior.dispatch.workflow_run_id,
    current_workflow_run_id: currentDispatch.workflow_run_id,
    soak_started_at: prior.predecessor.workflow_completed_at,
    soak_eligible_at: '2020-01-02T08:02:00.000Z',
    minimum_soak_seconds: 86_400,
    accepted_probe_run_ids: acceptedProbeRunIds,
    probe_count: acceptedProbeRunIds.length,
    browser_probe_run_ids: browserProbeRunIds,
    browser_probe_count: browserProbeRunIds.length,
    first_probe_at: '2020-01-01T08:10:00.000Z',
    final_probe_at: '2020-01-02T11:55:00.000Z',
    maximum_lifecycle_gap_seconds: 1_800,
    maximum_browser_gap_seconds: 3_600,
    live_state: {
      api_version_id: prior.final_state.api.version_id,
      api_deployment_id: prior.final_state.api.deployment_id,
      compute_version_id: prior.final_state.compute.version_id,
      compute_deployment_id: prior.final_state.compute.deployment_id,
      environment_digest: prior.final_state.environment_digest,
      policy: prior.final_state.policy,
      canary_allowlist: prior.final_state.canary_allowlist,
      certification_principal: prior.final_state.certification_principal,
    },
    dlq: {
      compute: {
        name: 'galactic-compute-dlq',
        baseline_count: 0,
        final_count: 0,
      },
      reconciliation: {
        name: 'galactic-compute-reconciliation-dlq',
        baseline_count: 0,
        final_count: 0,
      },
    },
    accounting_violations: 0,
    reconciliation_violations: 0,
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

function deployedCertification(stage, target, certificationDispatch, finalState) {
  const profile = {
    staging_canary: 'staging-full',
    production_canary: 'production-canary',
    production_global: 'production-global',
  }[stage];
  return {
    schema_version: 1,
    kind: 'galactic_compute_certification_verification',
    verified: true,
    target,
    profile,
    candidate_sha: certificationDispatch.git_sha,
    workflow_run_id: certificationDispatch.workflow_run_id,
    owner_id: OWNER_ID,
    agent_id: AGENT_ID,
    environment_digest: finalState.environment_digest,
    promoted_api_version_id: finalState.api.version_id,
    promoted_compute_version_id: finalState.compute.version_id,
    suite_generated_at: '2020-01-02T11:59:30.000Z',
    snapshot_generated_at: '2020-01-02T11:59:45.000Z',
    scenario_run_ids: Array.from({ length: 10 }, (_, index) => uuid(100 + index)),
    policy_compute_run_id: uuid(200),
    compute_receipt_ids: Array.from({ length: 11 }, (_, index) =>
      uuid(300 + index)
    ),
    artifact_digests: {
      deterministic_fixture: FIXED_ARTIFACT_SHA256,
      browser: ['1'.repeat(64), '2'.repeat(64)],
      consumer: [FIXED_ARTIFACT_SHA256, 'd'.repeat(64)],
    },
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
    runtime_provenance: RUNTIME_PROVENANCE,
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
    updated_at: '2020-01-02T12:02:00.000Z',
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
  const identity = contract.policy !== 'off' ? canaryIdentity(target) : null;
  const certification = contract.policy !== 'off'
    ? deployedCertification(stage, target, currentDispatch, finalState)
    : null;
  const releaseVerification = computeReleaseVerification(target, finalState);
  const priorStage = priorStageFor(stage, target);
  const prior = priorStage ? predecessorVerification(priorStage, target) : null;
  const activeSoak = stage === 'production_global'
    ? activeSoakVerification(prior, currentDispatch)
    : null;

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
    compute_worker_refresh: null,
    rollback_anchor: {
      evidence_file: 'rollback-anchor.json',
      sha256: writeJson(directory, 'rollback-anchor.json', rollbackAnchor),
    },
    active_state: {
      evidence_file: 'final-state.json',
      sha256: writeJson(directory, 'final-state.json', finalState),
    },
    active_soak: activeSoak
      ? {
        evidence_file: 'soak-verification.json',
        sha256: writeJson(
          directory,
          'soak-verification.json',
          activeSoak,
        ),
        production_canary_workflow_run_id: prior.dispatch.workflow_run_id,
      }
      : null,
    canary_identity: identity
      ? {
        evidence_file: 'canary-identity.json',
        sha256: writeJson(directory, 'canary-identity.json', identity),
      }
      : null,
    deployed_certification: certification
      ? {
        evidence_file: `compute-certification-verification-${target}.json`,
        sha256: writeJson(
          directory,
          `compute-certification-verification-${target}.json`,
          certification,
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
    certification,
    releaseVerification,
    prior,
    activeSoak,
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
    minimumAgeSeconds: '86400',
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
      assert.deepEqual(
        result.compute_release.runtime_provenance,
        RUNTIME_PROVENANCE,
      );
      assert.deepEqual(result.final_state, fixture.finalState);
    } finally {
      dispose(fixture);
    }
  }
});

test('accepts target-specific image digests when runtime provenance is identical', () => {
  const fixture = createFixture('production_canary');
  try {
    fixture.prior.final_state.environment_digest = OTHER_DIGEST;
    fixture.prior.compute_release.environment_digest = OTHER_DIGEST;
    fixture.prior.compute_release.deployed_image =
      `registry.cloudflare.com/${'1'.repeat(32)}/galactic-compute-staging@${OTHER_DIGEST}`;
    rebind(
      fixture,
      'predecessor',
      'predecessor-verification.json',
      fixture.prior,
    );
    persist(fixture);

    const result = verify(fixture);
    assert.equal(result.final_state.environment_digest, DIGEST);
    assert.equal(
      result.compute_release.runtime_provenance.layer_manifest_sha256,
      RUNTIME_PROVENANCE.layer_manifest_sha256,
    );
  } finally {
    dispose(fixture);
  }
});

test('accepts a hash-bound Worker refresh between image release and canary', () => {
  const fixture = createFixture('staging_canary');
  try {
    const sourceTag = `compute-${RELEASE_SHA}`;
    fixture.releaseVerification.compute_version_id = SOURCE_COMPUTE_ID;
    fixture.releaseVerification.compute_version_tag = sourceTag;
    rebind(
      fixture,
      'compute_release',
      'compute-release-verification.json',
      fixture.releaseVerification,
    );
    const refresh = {
      schema_version: 1,
      verified: true,
      target: 'staging',
      workflow_run_id: '30990000001',
      git_sha: GIT_SHA,
      source_compute_release_run_id:
        fixture.releaseVerification.workflow_run_id,
      source_release_sha: fixture.releaseVerification.release_sha,
      environment_digest: DIGEST,
      deployed_image: fixture.releaseVerification.deployed_image,
      source_compute_version_id: SOURCE_COMPUTE_ID,
      source_compute_version_tag: sourceTag,
      source_compute_code_etag: 'source-compute-code-etag',
      compute_version_id: fixture.finalState.compute.version_id,
      compute_version_tag: fixture.finalState.compute.version_tag,
      compute_code_etag: fixture.finalState.compute.code_etag,
      compute_configuration_sha256: 'f'.repeat(64),
    };
    fixture.rollout.compute_worker_refresh = {
      evidence_file: 'compute-worker-refresh-verification.json',
      sha256: writeJson(
        fixture.directory,
        'compute-worker-refresh-verification.json',
        refresh,
      ),
      workflow_run_id: refresh.workflow_run_id,
      source_compute_release_run_id: refresh.source_compute_release_run_id,
    };
    persist(fixture);
    assert.equal(verify(fixture, { minimumAgeSeconds: '0' }).verified, true);

    refresh.source_compute_release_run_id = '29000000001';
    rebind(
      fixture,
      'compute_worker_refresh',
      'compute-worker-refresh-verification.json',
      refresh,
    );
    persist(fixture);
    assert.throws(
      () => verify(fixture, { minimumAgeSeconds: '0' }),
      /Compute rollout predecessor is invalid/u,
    );
  } finally {
    dispose(fixture);
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

test('rejects canary identity and deployed-certification drift', () => {
  const cases = [
    ['missing canary identity', (fixture) => {
      fixture.rollout.canary_identity = null;
    }],
    ['wrong identity target', (fixture) => fixture.identity.target = 'staging'],
    ['wrong allowlist identity', (fixture) => {
      fixture.identity.allowlist_entry = `${OWNER_ID}/${COMPUTE_RUN_ID}`;
    }],
    ['certification not verified', (fixture) => {
      fixture.certification.verified = false;
    }],
    ['wrong certification SHA', (fixture) => {
      fixture.certification.candidate_sha = RELEASE_SHA;
    }],
    ['wrong certification run', (fixture) => {
      fixture.certification.workflow_run_id = '31000000001';
    }],
    ['wrong certification Agent', (fixture) => {
      fixture.certification.agent_id = OWNER_ID;
    }],
    ['wrong certification profile', (fixture) => {
      fixture.certification.profile = 'production-global';
    }],
    ['missing scenario execution', (fixture) => {
      fixture.certification.scenario_run_ids.pop();
    }],
    ['wrong promoted API', (fixture) => {
      fixture.certification.promoted_api_version_id = API_ID;
    }],
    ['wrong artifact digest', (fixture) => {
      fixture.certification.artifact_digests.deterministic_fixture =
        'f'.repeat(64);
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
        'deployed_certification',
        'compute-certification-verification-production.json',
        fixture.certification,
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

test('requires hash-bound active-soak proof for production_global', () => {
  const cases = [
    ['missing active soak', (fixture) => {
      fixture.rollout.active_soak = null;
    }],
    ['wrong referenced canary run', (fixture) => {
      fixture.rollout.active_soak.production_canary_workflow_run_id =
        '30000000001';
    }],
    ['unverified soak', (fixture) => {
      fixture.activeSoak.verified = false;
    }],
    ['wrong soak candidate SHA', (fixture) => {
      fixture.activeSoak.candidate_sha = RELEASE_SHA;
    }],
    ['wrong global workflow run', (fixture) => {
      fixture.activeSoak.current_workflow_run_id = '31000000001';
    }],
    ['lifecycle gap above limit', (fixture) => {
      fixture.activeSoak.maximum_lifecycle_gap_seconds = 2_101;
    }],
    ['verification before soak eligibility', (fixture) => {
      fixture.activeSoak.verified_at = '2020-01-02T07:59:59.000Z';
    }],
    ['uncovered initial lifecycle gap', (fixture) => {
      fixture.activeSoak.first_probe_at = '2020-01-01T08:37:01.000Z';
    }],
    ['stale final lifecycle probe', (fixture) => {
      fixture.activeSoak.final_probe_at = '2020-01-02T11:23:59.000Z';
    }],
    ['missing browser coverage', (fixture) => {
      fixture.activeSoak.browser_probe_run_ids = [];
      fixture.activeSoak.browser_probe_count = 0;
    }],
    ['live Compute drift', (fixture) => {
      fixture.activeSoak.live_state.compute_version_id = API_ID;
    }],
    ['Compute DLQ growth', (fixture) => {
      fixture.activeSoak.dlq.compute.final_count = 1;
    }],
    ['accounting violation', (fixture) => {
      fixture.activeSoak.accounting_violations = 1;
    }],
    ['verification after rollout commit', (fixture) => {
      fixture.activeSoak.verified_at = '2020-01-02T12:00:01.000Z';
    }],
  ];
  for (const [name, mutate] of cases) {
    const fixture = createFixture('production_global');
    try {
      mutate(fixture);
      if (fixture.rollout.active_soak !== null) {
        rebind(
          fixture,
          'active_soak',
          'soak-verification.json',
          fixture.activeSoak,
        );
      }
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
    ageFixture.workflowRun.updated_at = new Date(tooRecent + 200).toISOString();
    persist(ageFixture);
    assert.throws(
      () => verify(ageFixture),
      /minimum age and soak eligibility/u,
    );

    soakFixture.rollout.generated_at = new Date(NOW_MS - 7_200_000).toISOString();
    soakFixture.rollout.soak_eligible_at = new Date(NOW_MS + 1_000).toISOString();
    soakFixture.artifactList.artifacts[0].created_at = new Date(NOW_MS - 7_199_900).toISOString();
    soakFixture.workflowRun.updated_at = new Date(NOW_MS - 7_199_800).toISOString();
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
