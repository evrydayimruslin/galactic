import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildComputeWorkerRefreshEvidence,
  computeWorkerVersionFingerprint,
  verifyComputeWorkerRefreshEvidence,
} from './verify-compute-worker-refresh-evidence.mjs';

const REFRESH_SHA = 'a'.repeat(40);
const RELEASE_SHA = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const SOURCE_RUN_ID = '30646319201';
const REFRESH_RUN_ID = '30990000001';
const GENERATED_AT = '2026-08-05T18:00:00Z';
const REPOSITORY = 'evrydayimruslin/galactic';
const IDS = Object.freeze({
  apiVersion: '11111111-1111-4111-8111-111111111111',
  apiDeployment: '22222222-2222-4222-8222-222222222222',
  beforeVersion: '33333333-3333-4333-8333-333333333333',
  beforeDeployment: '44444444-4444-4444-8444-444444444444',
  afterVersion: '55555555-5555-4555-8555-555555555555',
  afterDeployment: '66666666-6666-4666-8666-666666666666',
});

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(directory, name, value) {
  writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function workerState({
  worker,
  versionId,
  versionTag,
  deploymentId,
  codeEtag,
  compatibility,
}) {
  return {
    worker,
    version_id: versionId,
    version_tag: versionTag,
    deployment_id: deploymentId,
    code_etag: codeEtag,
    compatibility_sha256: compatibility,
  };
}

function rolloutState({ after = false, apiEtag = 'api-code-etag' } = {}) {
  return {
    schema_version: 1,
    kind: 'galactic_compute_rollout_state',
    verified: true,
    phase: 'inspected',
    target: 'staging',
    policy: 'off',
    canary_allowlist: [],
    certification_principal: null,
    environment_digest: DIGEST,
    dispatch: {
      repository: REPOSITORY,
      workflow_run_id: REFRESH_RUN_ID,
      run_attempt: '1',
      git_sha: REFRESH_SHA,
    },
    api: workerState({
      worker: 'ultralight-api-staging',
      versionId: IDS.apiVersion,
      versionTag: `api-${RELEASE_SHA}-admission-off`,
      deploymentId: IDS.apiDeployment,
      codeEtag: apiEtag,
      compatibility: 'd'.repeat(64),
    }),
    compute: workerState({
      worker: 'galactic-compute-staging',
      versionId: after ? IDS.afterVersion : IDS.beforeVersion,
      versionTag: after
        ? `compute-${REFRESH_SHA}-worker-refresh`
        : `compute-${RELEASE_SHA}`,
      deploymentId: after ? IDS.afterDeployment : IDS.beforeDeployment,
      codeEtag: after ? 'compute-code-after' : 'compute-code-before',
      compatibility: after ? 'e'.repeat(64) : 'f'.repeat(64),
    }),
    source_api_version_id: null,
  };
}

function computeVersion({ after = false, setting = 'stable' } = {}) {
  const state = rolloutState({ after });
  return {
    id: state.compute.version_id,
    annotations: { 'workers/tag': state.compute.version_tag },
    resources: {
      script: {
        etag: state.compute.code_etag,
        handlers: ['queue'],
        placement_mode: 'smart',
      },
      bindings: [
        {
          type: 'plain_text',
          name: 'COMPUTE_ENVIRONMENT_DIGEST',
          text: DIGEST,
        },
        {
          type: 'service',
          name: 'CONTROL_PLANE',
          service: 'ultralight-api-staging',
          entrypoint: 'ComputeControlPlane',
        },
        {
          type: 'r2_bucket',
          name: 'COMPUTE_ARTIFACTS',
          bucket_name: 'galactic-compute-artifacts-staging',
        },
        {
          type: 'plain_text',
          name: 'UNCHANGED_COMPUTE_SETTING',
          text: setting,
        },
      ],
      script_runtime: {
        exports: { ComputePlane: { type: 'worker-entrypoint' } },
      },
    },
  };
}

function container({ version = '7', instances = 0 } = {}) {
  return {
    schema_version: 1,
    id: 'container-application-id',
    name: 'galactic-compute-staging-computestandard',
    state: 'ready',
    instances,
    image:
      `registry.cloudflare.com/${'1'.repeat(32)}/galactic-compute-staging@${DIGEST}`,
    version,
    updated_at: '2026-08-05T17:00:00Z',
  };
}

function sourceRelease() {
  return {
    schema_version: 1,
    verified: true,
    target: 'staging',
    release_sha: RELEASE_SHA,
    workflow_run_id: SOURCE_RUN_ID,
    environment_digest: DIGEST,
    deployed_image:
      `registry.cloudflare.com/${'1'.repeat(32)}/galactic-compute-staging@${DIGEST}`,
    compute_version_id: IDS.beforeVersion,
    compute_version_tag: `compute-${RELEASE_SHA}`,
  };
}

function request() {
  return {
    schema_version: 1,
    kind: 'galactic_compute_worker_refresh_request',
    target: 'staging',
    confirmation: 'refresh-staging-compute',
    source_compute_release_run_id: SOURCE_RUN_ID,
    dispatch: {
      repository: REPOSITORY,
      workflow_run_id: REFRESH_RUN_ID,
      run_attempt: '1',
      git_sha: REFRESH_SHA,
      git_ref: 'refs/heads/main',
    },
  };
}

function workflowRun() {
  return {
    id: Number(REFRESH_RUN_ID),
    run_attempt: 1,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    path: '.github/workflows/compute-worker-refresh.yml',
    head_sha: REFRESH_SHA,
    head_branch: 'main',
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
  };
}

function writeManifest(directory) {
  const files = [
    'after-container-readiness.json',
    'after-state.json',
    'after-worker-fingerprint.json',
    'before-container-readiness.json',
    'before-state.json',
    'before-worker-fingerprint.json',
    'refresh.json',
    'request.json',
    'source-release-verification.json',
  ];
  writeFileSync(
    join(directory, 'evidence.sha256'),
    files.map((name) =>
      `${hash(readFileSync(join(directory, name)))}  ./${name}`
    ).join('\n') + '\n',
  );
}

function fixture(mutator = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'compute-worker-refresh-'));
  try {
    const values = {
    request: request(),
    source: sourceRelease(),
    beforeState: rolloutState(),
    afterState: rolloutState({ after: true }),
    beforeVersion: computeVersion(),
    afterVersion: computeVersion({ after: true }),
    beforeContainer: container(),
    afterContainer: container({ instances: 1 }),
    workflowRun: workflowRun(),
    };
    mutator(values);
    writeJson(directory, 'request.json', values.request);
    writeJson(directory, 'source-release-verification.json', values.source);
    writeJson(directory, 'before-state.json', values.beforeState);
    writeJson(directory, 'after-state.json', values.afterState);
    writeJson(
      directory,
      'before-worker-fingerprint.json',
      computeWorkerVersionFingerprint({
        target: 'staging',
        version: values.beforeVersion,
      }),
    );
    writeJson(
      directory,
      'after-worker-fingerprint.json',
      computeWorkerVersionFingerprint({
        target: 'staging',
        version: values.afterVersion,
      }),
    );
    writeJson(directory, 'before-container-readiness.json', values.beforeContainer);
    writeJson(directory, 'after-container-readiness.json', values.afterContainer);
    const refresh = buildComputeWorkerRefreshEvidence({
      evidenceDirectory: directory,
      target: 'staging',
      sourceComputeReleaseRunId: SOURCE_RUN_ID,
      generatedAt: GENERATED_AT,
    });
    writeJson(directory, 'refresh.json', refresh);
    writeManifest(directory);
    writeJson(directory, 'workflow-run.json', values.workflowRun);
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test('fingerprints Worker code separately from deployment configuration', () => {
  const before = computeWorkerVersionFingerprint({
    target: 'staging',
    version: computeVersion(),
  });
  const after = computeWorkerVersionFingerprint({
    target: 'staging',
    version: computeVersion({ after: true }),
  });
  assert.notEqual(before.version_id, after.version_id);
  assert.notEqual(before.code_etag, after.code_etag);
  assert.equal(before.configuration_sha256, after.configuration_sha256);
});

test('builds and verifies a Worker-only refresh chained to release evidence', (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = verifyComputeWorkerRefreshEvidence({
    evidenceDirectory: directory,
    target: 'staging',
    workflowRunPath: join(directory, 'workflow-run.json'),
    expectedRunId: REFRESH_RUN_ID,
    expectedSourceComputeReleaseRunId: SOURCE_RUN_ID,
  });
  assert.equal(result.verified, true);
  assert.equal(result.environment_digest, DIGEST);
  assert.equal(result.source_compute_version_id, IDS.beforeVersion);
  assert.equal(result.compute_version_id, IDS.afterVersion);
  assert.equal(result.git_sha, REFRESH_SHA);
});

test('rejects non-code Compute configuration drift', () => {
  assert.throws(() => {
    fixture((values) => {
      values.afterVersion = computeVersion({ after: true, setting: 'drifted' });
    });
  }, /Compute Worker refresh evidence is invalid: before\/after evidence/u);
});

test('rejects any API mutation during the refresh', () => {
  assert.throws(() => {
    fixture((values) => {
      values.afterState = rolloutState({ after: true, apiEtag: 'changed-api' });
    });
  }, /Compute Worker refresh evidence is invalid: before\/after evidence/u);
});

test('rejects a changed Container application version', () => {
  assert.throws(() => {
    fixture((values) => {
      values.afterContainer = container({ version: '8' });
    });
  }, /Compute Worker refresh evidence is invalid: before\/after evidence/u);
});

test('rejects evidence changed after the deterministic manifest was written', (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const after = JSON.parse(
    readFileSync(join(directory, 'after-state.json'), 'utf8'),
  );
  after.compute.code_etag = 'tampered';
  writeJson(directory, 'after-state.json', after);
  assert.throws(() =>
    verifyComputeWorkerRefreshEvidence({
      evidenceDirectory: directory,
      target: 'staging',
      workflowRunPath: join(directory, 'workflow-run.json'),
      expectedRunId: REFRESH_RUN_ID,
      expectedSourceComputeReleaseRunId: SOURCE_RUN_ID,
    }), /evidence\.sha256 does not match after-state\.json/u);
});
