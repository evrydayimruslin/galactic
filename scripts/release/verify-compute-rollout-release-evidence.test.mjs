import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyComputeRolloutReleaseEvidence } from './verify-compute-rollout-release-evidence.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = '9'.repeat(40);
const RUN_ID = '30170000000';
const OTHER_RUN_ID = '30170000001';
const SCHEMA_RUN_ID = '30160000000';
const TAG = 'v0.4.99';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const PREVIOUS_DIGEST = `sha256:${'c'.repeat(64)}`;
const BASE_IMAGE = `docker.io/cloudflare/sandbox:0.12.3-python@sha256:${'d'.repeat(64)}`;
const RETENTION_MIGRATION = 'supabase/migrations/20260720124000_compute_artifact_retention.sql';
const RETENTION_SHA = 'e'.repeat(64);
const OTHER_MIGRATION_SHA = 'f'.repeat(64);
const HISTORICAL_API_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_HISTORICAL_API_ID = '22222222-2222-4222-8222-222222222222';
const PREVIOUS_API_ID = '33333333-3333-4333-8333-333333333333';
const COMPUTE_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const SCRIPT = fileURLToPath(
  new URL('./verify-compute-rollout-release-evidence.mjs', import.meta.url),
);

const TARGETS = {
  staging: {
    apiWorker: 'ultralight-api-staging',
    artifactBucket: 'galactic-compute-artifacts-staging',
    computeQueue: 'galactic-compute-staging',
    computeWorker: 'galactic-compute-staging',
    ref: 'refs/heads/main',
    refName: 'main',
    schemaJob: 'Deploy staging schema',
    schemaPath: '.github/workflows/supabase-db.yml',
  },
  production: {
    apiWorker: 'ultralight-api',
    artifactBucket: 'galactic-compute-artifacts',
    computeQueue: 'galactic-compute',
    computeWorker: 'galactic-compute',
    ref: `refs/tags/${TAG}`,
    refName: TAG,
    schemaJob: 'Deploy production schema',
    schemaPath: '.github/workflows/supabase-production-db.yml',
  },
};

function bytes(value) {
  return `${JSON.stringify(value)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(directory, file, value) {
  const content = bytes(value);
  writeFileSync(join(directory, file), content);
  return sha256(content);
}

function plain(name, text) {
  return { type: 'plain_text', name, text };
}

function apiBindings(target, digest) {
  return [
    plain('COMPUTE_ENABLED', '0'),
    plain('COMPUTE_ENVIRONMENT_DIGEST', digest),
    plain('COMPUTE_ROLLOUT_MODE', 'canary'),
    plain('COMPUTE_CANARY_ALLOWLIST', ''),
    plain('COMPUTE_CERTIFICATION_PRINCIPAL', ''),
    {
      type: 'service',
      name: 'COMPUTE_PLANE',
      service: target.computeWorker,
      entrypoint: 'ComputePlane',
      environment: 'production',
    },
    {
      type: 'queue',
      name: 'COMPUTE_QUEUE',
      queue_name: target.computeQueue,
    },
    {
      type: 'r2_bucket',
      name: 'COMPUTE_ARTIFACTS',
      bucket_name: target.artifactBucket,
    },
  ];
}

function computeBindings(target, digest) {
  return [
    plain('COMPUTE_ENVIRONMENT_DIGEST', digest),
    {
      type: 'service',
      name: 'CONTROL_PLANE',
      service: target.apiWorker,
      entrypoint: 'ComputeControlPlane',
      environment: 'production',
    },
    {
      type: 'r2_bucket',
      name: 'COMPUTE_ARTIFACTS',
      bucket_name: target.artifactBucket,
    },
  ];
}

function createFixture(targetName = 'production') {
  const directory = mkdtempSync(join(tmpdir(), 'compute-rollout-release-'));
  const target = TARGETS[targetName];
  const workflowRunPath = join(directory, 'workflow-run.json');
  const workflowRun = {
    id: Number(RUN_ID),
    event: 'workflow_dispatch',
    conclusion: 'success',
    head_sha: SHA,
    head_branch: target.refName,
    path: '.github/workflows/compute-deploy.yml',
  };
  const releasePolicy = {
    schema_version: 1,
    release_tag: TAG,
    compute: {
      admission: 'preserve_off',
      artifact: 'deploy_exact_candidate',
    },
  };
  const policyBefore = {
    schema_version: 1,
    worker: target.apiWorker,
    id: PREVIOUS_API_ID,
    tag: 'api-previous-admission-off',
    admission_enabled: false,
    selected_bindings: apiBindings(target, PREVIOUS_DIGEST),
  };
  const policyAfter = {
    schema_version: 1,
    worker: target.apiWorker,
    id: HISTORICAL_API_ID,
    tag: `api-${SHA}-admission-off`,
    admission_enabled: false,
    rollout_mode: 'canary',
    canary_allowlist: [],
    selected_bindings: apiBindings(target, DIGEST),
  };
  const computeEvidence = {
    schema_version: 1,
    worker: target.computeWorker,
    id: COMPUTE_ID,
    tag: `compute-${SHA}`,
    environment_digest: DIGEST,
    selected_bindings: computeBindings(target, DIGEST),
  };
  const preflight = {
    schema_version: 1,
    kind: 'galactic_compute_binding_preflight',
    verified: true,
    target: targetName,
    candidate_sha: SHA,
    workflow_run_id: RUN_ID,
    agent_id: AGENT_ID,
    function_name: 'run_compute_certification',
    fixture_policy: { enabled: false, revision: '7' },
    probe: {
      action: 'status',
      run_id: '00000000-0000-4000-8000-000000000000',
      expected_http_status: 500,
      expected_public_compute_code: 'COMPUTE_RUN_NOT_FOUND',
      observed_http_status: 500,
      observed_public_compute_code: 'COMPUTE_RUN_NOT_FOUND',
    },
    generated_at: '2026-07-31T11:50:00.000Z',
  };
  const migrationManifest = `${RETENTION_SHA}  ${RETENTION_MIGRATION}\n` +
    `${OTHER_MIGRATION_SHA}  supabase/migrations/20260720124500_compute_capacity_conservation.sql\n`;
  const migrationManifestSha = sha256(migrationManifest);

  writeFileSync(join(directory, 'base-image.txt'), `${BASE_IMAGE}\n`);
  writeFileSync(
    join(directory, 'compute-migrations.sha256'),
    migrationManifest,
  );
  writeFileSync(
    join(directory, 'compute-migrations-manifest.sha256'),
    `${migrationManifestSha}  compute-migrations.sha256\n`,
  );
  writeFileSync(
    join(directory, 'compute-artifact-retention-migration.sha256'),
    `${RETENTION_SHA}  ${RETENTION_MIGRATION}\n`,
  );
  writeJson(directory, 'compute-artifact-retention-policy.json', {
    schema_version: 1,
    migration: RETENTION_MIGRATION.split('/').at(-1),
    ready_output_days: 30,
    owner_retained_output_bytes: 10_737_418_240,
    owner_retained_output_objects: 10_000,
    download_lease_seconds: 3_600,
    deletion_authority: 'database_reconciler',
    r2_age_deletion_allowed: false,
  });
  writeJson(directory, 'schema-workflow-run.json', {
    id: Number(SCHEMA_RUN_ID),
    event: 'push',
    conclusion: 'success',
    head_sha: SHA,
    head_branch: target.refName,
    path: target.schemaPath,
    run_attempt: 1,
    created_at: '2026-07-31T11:00:00Z',
    updated_at: '2026-07-31T11:01:00Z',
  });
  writeJson(directory, 'schema-workflow-job.json', {
    id: 30160000001,
    run_id: Number(SCHEMA_RUN_ID),
    name: target.schemaJob,
    status: 'completed',
    conclusion: 'success',
    head_sha: SHA,
    started_at: '2026-07-31T11:00:10Z',
    completed_at: '2026-07-31T11:00:50Z',
  });
  writeJson(directory, 'container-readiness.json', {
    schema_version: 1,
    id: 'container-application-id',
    name: `${target.computeWorker}-computestandard`,
    state: 'ready',
    instances: 1,
    image: `registry.cloudflare.com/${'1'.repeat(32)}/${target.computeWorker}@${DIGEST}`,
    version: 7,
    updated_at: '2026-07-31T11:30:00.822000128Z',
  });

  const release = {
    schema_version: 6,
    release_mode: 'policy_preserved',
    admission_mode: 'preserve_off',
    workflow_run_id: RUN_ID,
    environment: targetName,
    git_sha: SHA,
    git_ref: target.ref,
    base_image: BASE_IMAGE,
    deployed_image: `registry.cloudflare.com/${'1'.repeat(32)}/${target.computeWorker}@${DIGEST}`,
    environment_digest: DIGEST,
    admission_enabled: false,
    rollout_mode: 'canary',
    canary_allowlist: [],
    certified_admission_off_api: {
      worker: target.apiWorker,
      version_id: HISTORICAL_API_ID,
      version_tag: `api-${SHA}-admission-off`,
    },
    active_api: {
      worker: target.apiWorker,
      version_id: HISTORICAL_API_ID,
      version_tag: `api-${SHA}-admission-off`,
      enabled: false,
      rollout_mode: 'canary',
      canary_allowlist: [],
    },
    active_compute_worker: {
      worker: target.computeWorker,
      version_id: COMPUTE_ID,
      version_tag: `compute-${SHA}`,
      environment_digest: DIGEST,
      evidence_file: 'active-preserve-off-compute-version.json',
      sha256: writeJson(
        directory,
        'active-preserve-off-compute-version.json',
        computeEvidence,
      ),
    },
    policy_before: {
      evidence_file: 'pre-rollout-api-version.json',
      sha256: writeJson(
        directory,
        'pre-rollout-api-version.json',
        policyBefore,
      ),
      admission_enabled: false,
      rollout_mode: 'canary',
      canary_allowlist: [],
    },
    policy_after: {
      evidence_file: 'active-preserve-off-api-version.json',
      sha256: writeJson(
        directory,
        'active-preserve-off-api-version.json',
        policyAfter,
      ),
      admission_enabled: false,
      rollout_mode: 'canary',
      canary_allowlist: [],
    },
    binding_preflight: {
      evidence_file: `compute-preflight-${targetName}.json`,
      sha256: writeJson(
        directory,
        `compute-preflight-${targetName}.json`,
        preflight,
      ),
      verified: true,
    },
    release_policy: {
      evidence_file: 'release-policy.json',
      sha256: writeJson(directory, 'release-policy.json', releasePolicy),
      artifact: 'deploy_exact_candidate',
      admission: 'preserve_off',
    },
    schema_migrations: {
      manifest_sha256: migrationManifestSha,
      migration_count: 2,
      schema_workflow_run_id: SCHEMA_RUN_ID,
      schema_workflow_path: target.schemaPath,
      schema_deploy_job: target.schemaJob,
    },
    artifact_storage: { public_access: false },
    artifact_retention: {
      ready_output_days: 30,
      owner_retained_output_bytes: 10_737_418_240,
      owner_retained_output_objects: 10_000,
      migration_sha256: RETENTION_SHA,
    },
    generated_at: '2026-07-31T12:00:00Z',
  };

  const fixture = {
    directory,
    workflowRunPath,
    workflowRun,
    targetName,
    target,
    release,
    releasePolicy,
    policyBefore,
    policyAfter,
    computeEvidence,
    preflight,
  };
  persist(fixture);
  return fixture;
}

function persist(fixture) {
  writeJson(fixture.directory, 'release.json', fixture.release);
  writeFileSync(fixture.workflowRunPath, bytes(fixture.workflowRun));
}

function rebind(fixture, bindingName, file, value) {
  fixture.release[bindingName].sha256 = writeJson(
    fixture.directory,
    file,
    value,
  );
}

function verify(fixture, overrides = {}) {
  return verifyComputeRolloutReleaseEvidence({
    evidenceDirectory: fixture.directory,
    target: fixture.targetName,
    workflowRunPath: fixture.workflowRunPath,
    expectedRunId: RUN_ID,
    ...overrides,
  });
}

function dispose(fixture) {
  rmSync(fixture.directory, { recursive: true, force: true });
}

test('accepts exact schema-6 evidence with Cloudflare nanosecond timestamps', () => {
  for (const targetName of ['staging', 'production']) {
    const fixture = createFixture(targetName);
    try {
      assert.deepEqual(verify(fixture), {
        schema_version: 1,
        verified: true,
        target: targetName,
        release_sha: SHA,
        workflow_run_id: RUN_ID,
        environment_digest: DIGEST,
        deployed_image: `registry.cloudflare.com/${
          '1'.repeat(32)
        }/${fixture.target.computeWorker}@${DIGEST}`,
        compute_version_id: COMPUTE_ID,
        compute_version_tag: `compute-${SHA}`,
      });
    } finally {
      dispose(fixture);
    }
  }
});

test('accepts historical OFF snapshots without the certification principal', () => {
  const fixture = createFixture();
  try {
    fixture.policyBefore.selected_bindings =
      fixture.policyBefore.selected_bindings.filter((binding) =>
        binding.name !== 'COMPUTE_CERTIFICATION_PRINCIPAL'
      );
    rebind(
      fixture,
      'policy_before',
      'pre-rollout-api-version.json',
      fixture.policyBefore,
    );
    fixture.policyAfter.selected_bindings =
      fixture.policyAfter.selected_bindings.filter((binding) =>
        binding.name !== 'COMPUTE_CERTIFICATION_PRINCIPAL'
      );
    rebind(
      fixture,
      'policy_after',
      'active-preserve-off-api-version.json',
      fixture.policyAfter,
    );
    persist(fixture);
    assert.equal(verify(fixture).verified, true);
  } finally {
    dispose(fixture);
  }
});

test('never returns or derives rollback state from the historical OFF API', () => {
  const fixture = createFixture();
  try {
    const original = verify(fixture);
    assert.deepEqual(Object.keys(original), [
      'schema_version',
      'verified',
      'target',
      'release_sha',
      'workflow_run_id',
      'environment_digest',
      'deployed_image',
      'compute_version_id',
      'compute_version_tag',
    ]);
    assert.equal(JSON.stringify(original).includes(HISTORICAL_API_ID), false);

    fixture.release.certified_admission_off_api.version_id = OTHER_HISTORICAL_API_ID;
    fixture.release.active_api.version_id = OTHER_HISTORICAL_API_ID;
    fixture.policyAfter.id = OTHER_HISTORICAL_API_ID;
    rebind(
      fixture,
      'policy_after',
      'active-preserve-off-api-version.json',
      fixture.policyAfter,
    );
    persist(fixture);
    assert.deepEqual(verify(fixture), original);
  } finally {
    dispose(fixture);
  }
});

test('CLI emits only the sanitized verified Compute identity', () => {
  const fixture = createFixture('staging');
  try {
    const result = spawnSync(process.execPath, [
      SCRIPT,
      fixture.directory,
      'staging',
      fixture.workflowRunPath,
      RUN_ID,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), verify(fixture));
    assert.equal(result.stdout.includes(HISTORICAL_API_ID), false);
  } finally {
    dispose(fixture);
  }
});

test('rejects workflow and release provenance drift', () => {
  const cases = [
    {
      name: 'wrong target',
      run(fixture) {
        return verify(fixture, { target: 'staging' });
      },
    },
    {
      name: 'wrong expected run',
      run(fixture) {
        return verify(fixture, { expectedRunId: OTHER_RUN_ID });
      },
    },
    {
      name: 'wrong workflow run ID',
      mutate(fixture) {
        fixture.workflowRun.id = Number(OTHER_RUN_ID);
      },
    },
    {
      name: 'wrong workflow path',
      mutate(fixture) {
        fixture.workflowRun.path = '.github/workflows/compute-ci.yml';
      },
    },
    {
      name: 'wrong workflow event',
      mutate(fixture) {
        fixture.workflowRun.event = 'push';
      },
    },
    {
      name: 'failed workflow',
      mutate(fixture) {
        fixture.workflowRun.conclusion = 'failure';
      },
    },
    {
      name: 'wrong release SHA',
      mutate(fixture) {
        fixture.release.git_sha = OTHER_SHA;
      },
    },
    {
      name: 'wrong release run ID',
      mutate(fixture) {
        fixture.release.workflow_run_id = OTHER_RUN_ID;
      },
    },
    {
      name: 'wrong production ref',
      mutate(fixture) {
        fixture.release.git_ref = 'refs/heads/main';
      },
    },
    {
      name: 'wrong production ref name',
      mutate(fixture) {
        fixture.workflowRun.head_branch = 'main';
      },
    },
  ];
  for (const scenario of cases) {
    const fixture = createFixture();
    try {
      scenario.mutate?.(fixture);
      persist(fixture);
      assert.throws(
        () => scenario.run ? scenario.run(fixture) : verify(fixture),
        /Compute rollout release evidence is invalid/u,
        scenario.name,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('rejects hash, digest, image, binding, and policy tampering', () => {
  const cases = [
    {
      name: 'tampered active Compute bytes',
      mutate(fixture) {
        fixture.computeEvidence.tag = 'compute-tampered';
        writeJson(
          fixture.directory,
          'active-preserve-off-compute-version.json',
          fixture.computeEvidence,
        );
      },
    },
    {
      name: 'wrong declared hash',
      mutate(fixture) {
        fixture.release.active_compute_worker.sha256 = '0'.repeat(64);
      },
    },
    {
      name: 'wrong Compute digest',
      mutate(fixture) {
        fixture.computeEvidence.environment_digest = PREVIOUS_DIGEST;
        rebind(
          fixture,
          'active_compute_worker',
          'active-preserve-off-compute-version.json',
          fixture.computeEvidence,
        );
      },
    },
    {
      name: 'wrong control-plane binding',
      mutate(fixture) {
        fixture.computeEvidence.selected_bindings[1].service = 'wrong-api';
        rebind(
          fixture,
          'active_compute_worker',
          'active-preserve-off-compute-version.json',
          fixture.computeEvidence,
        );
      },
    },
    {
      name: 'wrong control-plane environment',
      mutate(fixture) {
        fixture.computeEvidence.selected_bindings[1].environment = 'staging';
        rebind(
          fixture,
          'active_compute_worker',
          'active-preserve-off-compute-version.json',
          fixture.computeEvidence,
        );
      },
    },
    {
      name: 'wrong artifact binding',
      mutate(fixture) {
        fixture.computeEvidence.selected_bindings[2].bucket_name = 'wrong-bucket';
        rebind(
          fixture,
          'active_compute_worker',
          'active-preserve-off-compute-version.json',
          fixture.computeEvidence,
        );
      },
    },
    {
      name: 'wrong deployed image path',
      mutate(fixture) {
        fixture.release.deployed_image = `registry.cloudflare.com/${
          '1'.repeat(32)
        }/wrong-worker@${DIGEST}`;
      },
    },
    {
      name: 'wrong deployed image digest',
      mutate(fixture) {
        fixture.release.deployed_image = `registry.cloudflare.com/${
          '1'.repeat(32)
        }/galactic-compute@${PREVIOUS_DIGEST}`;
      },
    },
    {
      name: 'tampered release policy bytes',
      mutate(fixture) {
        fixture.releasePolicy.compute.admission = 'enable_global';
        writeJson(
          fixture.directory,
          'release-policy.json',
          fixture.releasePolicy,
        );
      },
    },
    {
      name: 'wrong preserve policy',
      mutate(fixture) {
        fixture.releasePolicy.compute.admission = 'enable_global';
        rebind(
          fixture,
          'release_policy',
          'release-policy.json',
          fixture.releasePolicy,
        );
      },
    },
    {
      name: 'wrong production policy tag',
      mutate(fixture) {
        fixture.releasePolicy.release_tag = 'v0.4.100';
        rebind(
          fixture,
          'release_policy',
          'release-policy.json',
          fixture.releasePolicy,
        );
      },
    },
  ];
  for (const scenario of cases) {
    const fixture = createFixture();
    try {
      scenario.mutate(fixture);
      persist(fixture);
      assert.throws(
        () => verify(fixture),
        /Compute rollout release evidence is invalid/u,
        scenario.name,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('rejects non-OFF policy snapshots and preflight drift', () => {
  const cases = [
    {
      name: 'tampered policy-before bytes',
      mutate(fixture) {
        fixture.policyBefore.selected_bindings[0].text = '1';
        writeJson(
          fixture.directory,
          'pre-rollout-api-version.json',
          fixture.policyBefore,
        );
      },
    },
    {
      name: 'enabled policy before',
      mutate(fixture) {
        fixture.policyBefore.selected_bindings[0].text = '1';
        rebind(
          fixture,
          'policy_before',
          'pre-rollout-api-version.json',
          fixture.policyBefore,
        );
      },
    },
    {
      name: 'global policy after',
      mutate(fixture) {
        fixture.policyAfter.rollout_mode = 'global';
        rebind(
          fixture,
          'policy_after',
          'active-preserve-off-api-version.json',
          fixture.policyAfter,
        );
      },
    },
    {
      name: 'nonempty historical certification principal',
      mutate(fixture) {
        fixture.policyBefore.selected_bindings.find((binding) =>
          binding.name === 'COMPUTE_CERTIFICATION_PRINCIPAL'
        ).text = 'owner/agent';
        rebind(
          fixture,
          'policy_before',
          'pre-rollout-api-version.json',
          fixture.policyBefore,
        );
      },
    },
    {
      name: 'nonempty post-rollout certification principal',
      mutate(fixture) {
        fixture.policyAfter.selected_bindings.find((binding) =>
          binding.name === 'COMPUTE_CERTIFICATION_PRINCIPAL'
        ).text = 'owner/agent';
        rebind(
          fixture,
          'policy_after',
          'active-preserve-off-api-version.json',
          fixture.policyAfter,
        );
      },
    },
    {
      name: 'wrong preflight target',
      mutate(fixture) {
        fixture.preflight.target = 'staging';
        rebind(
          fixture,
          'binding_preflight',
          'compute-preflight-production.json',
          fixture.preflight,
        );
      },
    },
    {
      name: 'wrong preflight SHA',
      mutate(fixture) {
        fixture.preflight.candidate_sha = OTHER_SHA;
        rebind(
          fixture,
          'binding_preflight',
          'compute-preflight-production.json',
          fixture.preflight,
        );
      },
    },
    {
      name: 'wrong preflight run',
      mutate(fixture) {
        fixture.preflight.workflow_run_id = OTHER_RUN_ID;
        rebind(
          fixture,
          'binding_preflight',
          'compute-preflight-production.json',
          fixture.preflight,
        );
      },
    },
    {
      name: 'failed preflight probe',
      mutate(fixture) {
        fixture.preflight.probe.observed_public_compute_code = 'COMPUTE_CONTROL_PLANE_UNAVAILABLE';
        rebind(
          fixture,
          'binding_preflight',
          'compute-preflight-production.json',
          fixture.preflight,
        );
      },
    },
  ];
  for (const scenario of cases) {
    const fixture = createFixture();
    try {
      scenario.mutate(fixture);
      persist(fixture);
      assert.throws(
        () => verify(fixture),
        /Compute rollout release evidence is invalid/u,
        scenario.name,
      );
    } finally {
      dispose(fixture);
    }
  }
});

test('rejects mode, schema, shape, privacy, and retention drift', () => {
  const cases = [
    {
      name: 'global admission mode',
      mutate(fixture) {
        fixture.release.admission_mode = 'enable_global';
      },
    },
    {
      name: 'old release schema',
      mutate(fixture) {
        fixture.release.schema_version = 5;
      },
    },
    {
      name: 'extra release key',
      mutate(fixture) {
        fixture.release.rollback_api_version_id = HISTORICAL_API_ID;
      },
    },
    {
      name: 'extra nested key',
      mutate(fixture) {
        fixture.release.active_compute_worker.rollback = true;
      },
    },
    {
      name: 'array in place of object',
      mutate(fixture) {
        fixture.release.release_policy = [];
      },
    },
    {
      name: 'public artifact storage',
      mutate(fixture) {
        fixture.release.artifact_storage.public_access = true;
      },
    },
    {
      name: 'retention policy drift',
      mutate(fixture) {
        fixture.release.artifact_retention.ready_output_days = 31;
      },
    },
    {
      name: 'schema workflow path drift',
      mutate(fixture) {
        fixture.release.schema_migrations.schema_workflow_path =
          '.github/workflows/supabase-db.yml';
      },
    },
    {
      name: 'forbidden admitted claim',
      mutate(fixture) {
        writeJson(fixture.directory, 'compute-admitted-production.json', {});
      },
    },
  ];
  for (const scenario of cases) {
    const fixture = createFixture();
    try {
      scenario.mutate(fixture);
      persist(fixture);
      assert.throws(
        () => verify(fixture),
        /Compute rollout release evidence is invalid/u,
        scenario.name,
      );
    } finally {
      dispose(fixture);
    }
  }
});
