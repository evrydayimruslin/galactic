#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RUN_ID = /^[1-9][0-9]*$/u;
const REVISION = /^(0|[1-9][0-9]*)$/u;
const RELEASE_TAG = /^v[0-9A-Za-z][0-9A-Za-z._-]*$/u;
const BASE_IMAGE = /^docker\.io\/cloudflare\/sandbox:0\.12\.3-python@sha256:[0-9a-f]{64}$/u;
const MIGRATION_LINE = /^([0-9a-f]{64})\x20{2}(supabase\/migrations\/[0-9A-Za-z._-]+\.sql)$/u;
const BUILD_INPUT_LINE = /^([0-9a-f]{64})\x20{2}([0-9A-Za-z._\/-]+)$/u;
const IMAGE_LAYER_MEDIA_TYPES = new Set([
  'application/vnd.docker.image.rootfs.diff.tar.gzip',
  'application/vnd.oci.image.layer.v1.tar+gzip',
]);
const RETENTION_MIGRATION = 'supabase/migrations/20260720124000_compute_artifact_retention.sql';
const UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const RELEASE_KEYS = [
  'active_api',
  'active_compute_worker',
  'admission_enabled',
  'admission_mode',
  'artifact_retention',
  'artifact_storage',
  'base_image',
  'binding_preflight',
  'canary_allowlist',
  'certified_admission_off_api',
  'deployed_image',
  'environment',
  'environment_digest',
  'generated_at',
  'git_ref',
  'git_sha',
  'policy_after',
  'policy_before',
  'release_mode',
  'release_policy',
  'rollout_mode',
  'schema_migrations',
  'schema_version',
  'workflow_run_id',
];

const TARGETS = {
  staging: {
    apiWorker: 'ultralight-api-staging',
    artifactBucket: 'galactic-compute-artifacts-staging',
    computeQueue: 'galactic-compute-staging',
    computeWorker: 'galactic-compute-staging',
    gitRef: 'refs/heads/main',
    refName: 'main',
    schemaDeployJob: 'Deploy staging schema',
    schemaWorkflowPath: '.github/workflows/supabase-db.yml',
  },
  production: {
    apiWorker: 'ultralight-api',
    artifactBucket: 'galactic-compute-artifacts',
    computeQueue: 'galactic-compute',
    computeWorker: 'galactic-compute',
    schemaDeployJob: 'Deploy production schema',
    schemaWorkflowPath: '.github/workflows/supabase-production-db.yml',
  },
};

function fail(message) {
  throw new Error(`Compute rollout release evidence is invalid: ${message}`);
}

function exactObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expectedKeys, label) {
  exactObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
}

function readBytes(path, label) {
  try {
    return readFileSync(path);
  } catch {
    fail(`${label} is missing or unreadable`);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is missing or is not valid JSON`);
  }
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function prefixedHash(bytes) {
  return `sha256:${hashBytes(bytes)}`;
}

function isCanonicalUtcTimestamp(value) {
  return typeof value === 'string' &&
    UTC_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value));
}

function verifyTimestamp(value, label) {
  if (!isCanonicalUtcTimestamp(value)) {
    fail(`${label} is not a canonical UTC timestamp`);
  }
}

function verifyUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    fail(`${label} is not a canonical UUID`);
  }
}

function verifyRunIdValue(value, expected, label) {
  if (
    !(
      (typeof value === 'string' && RUN_ID.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    ) ||
    String(value) !== expected
  ) {
    fail(`${label} does not match the requested workflow run`);
  }
}

function verifyEmptyAllowlist(value, label) {
  if (!Array.isArray(value) || value.length !== 0) {
    fail(`${label} must be an empty array`);
  }
}

function readBoundJson({
  evidenceDirectory,
  binding,
  bindingKeys,
  expectedFile,
  label,
}) {
  exactKeys(binding, bindingKeys, `${label} binding`);
  if (
    binding.evidence_file !== expectedFile ||
    typeof binding.sha256 !== 'string' ||
    !HEX_SHA256.test(binding.sha256)
  ) {
    fail(`${label} binding is malformed`);
  }
  const path = resolve(evidenceDirectory, expectedFile);
  const bytes = readBytes(path, expectedFile);
  if (hashBytes(bytes) !== binding.sha256) {
    fail(`${label} bytes do not match release.json`);
  }
  return exactObject(readJson(path, expectedFile), expectedFile);
}

function expectedBinding(type, name, properties) {
  return { type, name, ...properties };
}

function verifySelectedBindings(bindings, expected, label) {
  if (!Array.isArray(bindings) || bindings.length !== expected.length) {
    fail(`${label} does not contain the exact selected bindings`);
  }
  const byName = new Map();
  for (const binding of bindings) {
    exactObject(binding, `${label} binding`);
    if (typeof binding.name !== 'string' || byName.has(binding.name)) {
      fail(`${label} contains a duplicate or unnamed binding`);
    }
    byName.set(binding.name, binding);
  }
  for (const specification of expected) {
    const binding = byName.get(specification.name);
    if (!binding) fail(`${label} is missing ${specification.name}`);
    exactKeys(binding, Object.keys(specification), `${label} ${specification.name}`);
    for (const [key, value] of Object.entries(specification)) {
      if (binding[key] !== value) {
        fail(`${label} ${specification.name} does not match the target`);
      }
    }
  }
}

function apiBindings(target, digest, { certificationPrincipal = true } = {}) {
  const bindings = [
    expectedBinding('plain_text', 'COMPUTE_ENABLED', { text: '0' }),
    expectedBinding('plain_text', 'COMPUTE_ENVIRONMENT_DIGEST', {
      text: digest,
    }),
    expectedBinding('plain_text', 'COMPUTE_ROLLOUT_MODE', {
      text: 'canary',
    }),
    expectedBinding('plain_text', 'COMPUTE_CANARY_ALLOWLIST', { text: '' }),
    ...(certificationPrincipal
      ? [expectedBinding('plain_text', 'COMPUTE_CERTIFICATION_PRINCIPAL', {
        text: '',
      })]
      : []),
    expectedBinding('service', 'COMPUTE_PLANE', {
      service: target.computeWorker,
      entrypoint: 'ComputePlane',
      environment: 'production',
    }),
    expectedBinding('queue', 'COMPUTE_QUEUE', {
      queue_name: target.computeQueue,
    }),
    expectedBinding('r2_bucket', 'COMPUTE_ARTIFACTS', {
      bucket_name: target.artifactBucket,
    }),
  ];
  return bindings;
}

function historicalCertificationPrincipalPresent(bindings, label) {
  if (!Array.isArray(bindings)) {
    fail(`${label} does not contain selected bindings`);
  }
  const matches = bindings.filter((binding) =>
    binding?.name === 'COMPUTE_CERTIFICATION_PRINCIPAL'
  );
  if (matches.length === 0) return false;
  if (
    matches.length !== 1 || matches[0]?.type !== 'plain_text' ||
    matches[0]?.text !== ''
  ) {
    fail(`${label} certification principal must be missing or exactly empty`);
  }
  return true;
}

function computeBindings(target, digest) {
  return [
    expectedBinding('plain_text', 'COMPUTE_ENVIRONMENT_DIGEST', {
      text: digest,
    }),
    expectedBinding('service', 'CONTROL_PLANE', {
      service: target.apiWorker,
      entrypoint: 'ComputeControlPlane',
      environment: 'production',
    }),
    expectedBinding('r2_bucket', 'COMPUTE_ARTIFACTS', {
      bucket_name: target.artifactBucket,
    }),
  ];
}

function verifyWorkflowRun(workflowRun, expectedRunId) {
  exactObject(workflowRun, 'Compute Deploy workflow run');
  verifyRunIdValue(workflowRun.id, expectedRunId, 'workflow run ID');
  if (
    workflowRun.event !== 'workflow_dispatch' ||
    workflowRun.conclusion !== 'success' ||
    workflowRun.path !== '.github/workflows/compute-deploy.yml' ||
    typeof workflowRun.head_sha !== 'string' ||
    !SHA.test(workflowRun.head_sha) ||
    typeof workflowRun.head_branch !== 'string' ||
    workflowRun.head_branch.length === 0
  ) {
    fail('workflow run is not a successful Compute Deploy dispatch');
  }
}

function verifyReleasePolicy({
  evidenceDirectory,
  release,
  targetName,
  target,
  workflowRun,
}) {
  const binding = exactObject(release.release_policy, 'release_policy');
  const policy = readBoundJson({
    evidenceDirectory,
    binding,
    bindingKeys: ['admission', 'artifact', 'evidence_file', 'sha256'],
    expectedFile: 'release-policy.json',
    label: 'release policy',
  });
  if (
    binding.artifact !== 'deploy_exact_candidate' ||
    binding.admission !== 'preserve_off'
  ) {
    fail('release policy binding is not preserve_off');
  }
  exactKeys(
    policy,
    ['compute', 'release_tag', 'schema_version'],
    'release-policy.json',
  );
  exactKeys(policy.compute, ['admission', 'artifact'], 'release policy compute');
  if (
    policy.schema_version !== 1 ||
    typeof policy.release_tag !== 'string' ||
    !RELEASE_TAG.test(policy.release_tag) ||
    policy.compute.artifact !== 'deploy_exact_candidate' ||
    policy.compute.admission !== 'preserve_off'
  ) {
    fail('release-policy.json is not the exact preserve_off policy');
  }

  const expectedRef = targetName === 'production'
    ? `refs/tags/${policy.release_tag}`
    : target.gitRef;
  const expectedRefName = targetName === 'production' ? policy.release_tag : target.refName;
  if (
    release.git_ref !== expectedRef ||
    workflowRun.head_branch !== expectedRefName
  ) {
    fail('release ref does not match the exact target dispatch ref');
  }
}

function verifyPolicyBindingDeclaration(binding, expectedFile, label) {
  exactKeys(
    binding,
    [
      'admission_enabled',
      'canary_allowlist',
      'evidence_file',
      'rollout_mode',
      'sha256',
    ],
    `${label} binding`,
  );
  verifyEmptyAllowlist(binding.canary_allowlist, `${label} canary allowlist`);
  if (
    binding.evidence_file !== expectedFile ||
    typeof binding.sha256 !== 'string' ||
    !HEX_SHA256.test(binding.sha256) ||
    binding.admission_enabled !== false ||
    binding.rollout_mode !== 'canary'
  ) {
    fail(`${label} does not declare exact admission-OFF policy`);
  }
}

function verifyPolicySnapshots({ evidenceDirectory, release, target }) {
  const beforeBinding = exactObject(release.policy_before, 'policy_before');
  const afterBinding = exactObject(release.policy_after, 'policy_after');
  verifyPolicyBindingDeclaration(
    beforeBinding,
    'pre-rollout-api-version.json',
    'policy before',
  );
  verifyPolicyBindingDeclaration(
    afterBinding,
    'active-preserve-off-api-version.json',
    'policy after',
  );
  const before = readBoundJson({
    evidenceDirectory,
    binding: beforeBinding,
    bindingKeys: [
      'admission_enabled',
      'canary_allowlist',
      'evidence_file',
      'rollout_mode',
      'sha256',
    ],
    expectedFile: 'pre-rollout-api-version.json',
    label: 'policy before',
  });
  const after = readBoundJson({
    evidenceDirectory,
    binding: afterBinding,
    bindingKeys: [
      'admission_enabled',
      'canary_allowlist',
      'evidence_file',
      'rollout_mode',
      'sha256',
    ],
    expectedFile: 'active-preserve-off-api-version.json',
    label: 'policy after',
  });
  exactKeys(
    before,
    [
      'admission_enabled',
      'id',
      'schema_version',
      'selected_bindings',
      'tag',
      'worker',
    ],
    'pre-rollout-api-version.json',
  );
  exactKeys(
    after,
    [
      'admission_enabled',
      'canary_allowlist',
      'id',
      'rollout_mode',
      'schema_version',
      'selected_bindings',
      'tag',
      'worker',
    ],
    'active-preserve-off-api-version.json',
  );
  verifyUuid(before.id, 'pre-rollout API version ID');
  verifyUuid(after.id, 'post-rollout API version ID');
  if (
    before.schema_version !== 1 ||
    before.worker !== target.apiWorker ||
    before.admission_enabled !== false ||
    typeof before.tag !== 'string' ||
    before.tag.length === 0
  ) {
    fail('policy-before evidence does not prove admission OFF');
  }
  const beforeDigest = Array.isArray(before.selected_bindings)
    ? before.selected_bindings.find((binding) => binding?.name === 'COMPUTE_ENVIRONMENT_DIGEST')
      ?.text
    : null;
  if (typeof beforeDigest !== 'string' || !SHA256.test(beforeDigest)) {
    fail('policy-before evidence has no immutable Compute digest');
  }
  verifySelectedBindings(
    before.selected_bindings,
    apiBindings(target, beforeDigest, {
      certificationPrincipal: historicalCertificationPrincipalPresent(
        before.selected_bindings,
        'policy-before evidence',
      ),
    }),
    'policy-before evidence',
  );

  const activeApi = release.active_api;
  if (
    after.schema_version !== 1 ||
    after.worker !== target.apiWorker ||
    after.id !== activeApi.version_id ||
    after.tag !== activeApi.version_tag ||
    after.admission_enabled !== false ||
    after.rollout_mode !== 'canary'
  ) {
    fail('policy-after evidence does not prove the exact OFF API state');
  }
  verifyEmptyAllowlist(after.canary_allowlist, 'policy-after canary allowlist');
  verifySelectedBindings(
    after.selected_bindings,
    apiBindings(target, release.environment_digest, {
      certificationPrincipal: historicalCertificationPrincipalPresent(
        after.selected_bindings,
        'policy-after evidence',
      ),
    }),
    'policy-after evidence',
  );
}

function verifyActiveCompute({ evidenceDirectory, release, target }) {
  const active = exactObject(
    release.active_compute_worker,
    'active_compute_worker',
  );
  exactKeys(
    active,
    [
      'environment_digest',
      'evidence_file',
      'sha256',
      'version_id',
      'version_tag',
      'worker',
    ],
    'active_compute_worker',
  );
  verifyUuid(active.version_id, 'active Compute version ID');
  if (
    active.worker !== target.computeWorker ||
    active.version_tag !== `compute-${release.git_sha}` ||
    active.environment_digest !== release.environment_digest
  ) {
    fail('active Compute declaration does not match the released candidate');
  }
  const evidence = readBoundJson({
    evidenceDirectory,
    binding: active,
    bindingKeys: [
      'environment_digest',
      'evidence_file',
      'sha256',
      'version_id',
      'version_tag',
      'worker',
    ],
    expectedFile: 'active-preserve-off-compute-version.json',
    label: 'active Compute evidence',
  });
  exactKeys(
    evidence,
    [
      'environment_digest',
      'id',
      'schema_version',
      'selected_bindings',
      'tag',
      'worker',
    ],
    'active-preserve-off-compute-version.json',
  );
  verifyUuid(evidence.id, 'active Compute evidence version ID');
  if (
    evidence.schema_version !== 1 ||
    evidence.worker !== target.computeWorker ||
    evidence.id !== active.version_id ||
    evidence.tag !== active.version_tag ||
    evidence.environment_digest !== release.environment_digest
  ) {
    fail('active Compute evidence does not match the released candidate');
  }
  verifySelectedBindings(
    evidence.selected_bindings,
    computeBindings(target, release.environment_digest),
    'active Compute evidence',
  );
  return active;
}

function verifyBindingPreflight({
  evidenceDirectory,
  release,
  targetName,
  expectedRunId,
}) {
  const binding = exactObject(release.binding_preflight, 'binding_preflight');
  const preflight = readBoundJson({
    evidenceDirectory,
    binding,
    bindingKeys: ['evidence_file', 'sha256', 'verified'],
    expectedFile: `compute-preflight-${targetName}.json`,
    label: 'binding preflight',
  });
  if (binding.verified !== true) fail('binding preflight is not verified');
  exactKeys(
    preflight,
    [
      'agent_id',
      'candidate_sha',
      'fixture_policy',
      'function_name',
      'generated_at',
      'kind',
      'probe',
      'schema_version',
      'target',
      'verified',
      'workflow_run_id',
    ],
    `compute-preflight-${targetName}.json`,
  );
  exactKeys(
    preflight.fixture_policy,
    ['enabled', 'revision'],
    'binding preflight fixture policy',
  );
  exactKeys(
    preflight.probe,
    [
      'action',
      'expected_http_status',
      'expected_public_compute_code',
      'observed_http_status',
      'observed_public_compute_code',
      'run_id',
    ],
    'binding preflight probe',
  );
  verifyUuid(preflight.agent_id, 'binding preflight Agent ID');
  verifyTimestamp(preflight.generated_at, 'binding preflight generated_at');
  if (
    preflight.schema_version !== 1 ||
    preflight.kind !== 'galactic_compute_binding_preflight' ||
    preflight.verified !== true ||
    preflight.target !== targetName ||
    preflight.candidate_sha !== release.git_sha ||
    preflight.workflow_run_id !== expectedRunId ||
    preflight.function_name !== 'run_compute_certification' ||
    preflight.fixture_policy.enabled !== false ||
    typeof preflight.fixture_policy.revision !== 'string' ||
    !REVISION.test(preflight.fixture_policy.revision) ||
    preflight.probe.action !== 'status' ||
    preflight.probe.run_id !== '00000000-0000-4000-8000-000000000000' ||
    preflight.probe.expected_http_status !== 500 ||
    preflight.probe.expected_public_compute_code !== 'COMPUTE_RUN_NOT_FOUND' ||
    preflight.probe.observed_http_status !== 500 ||
    preflight.probe.observed_public_compute_code !== 'COMPUTE_RUN_NOT_FOUND'
  ) {
    fail('binding preflight does not prove the exact OFF RPC/DB path');
  }
}

function verifyMigrationAndRetentionEvidence({
  evidenceDirectory,
  release,
  target,
  workflowRun,
}) {
  const migrations = exactObject(release.schema_migrations, 'schema_migrations');
  exactKeys(
    migrations,
    [
      'manifest_sha256',
      'migration_count',
      'schema_deploy_job',
      'schema_workflow_path',
      'schema_workflow_run_id',
    ],
    'schema_migrations',
  );
  if (
    typeof migrations.manifest_sha256 !== 'string' ||
    !HEX_SHA256.test(migrations.manifest_sha256) ||
    !Number.isSafeInteger(migrations.migration_count) ||
    migrations.migration_count < 1 ||
    typeof migrations.schema_workflow_run_id !== 'string' ||
    !RUN_ID.test(migrations.schema_workflow_run_id) ||
    migrations.schema_workflow_path !== target.schemaWorkflowPath ||
    migrations.schema_deploy_job !== target.schemaDeployJob
  ) {
    fail('schema migration declaration does not match the target contract');
  }

  const manifestFile = 'compute-migrations.sha256';
  const manifestBytes = readBytes(
    resolve(evidenceDirectory, manifestFile),
    manifestFile,
  );
  if (hashBytes(manifestBytes) !== migrations.manifest_sha256) {
    fail('migration manifest hash does not match release.json');
  }
  const manifest = manifestBytes.toString('utf8');
  if (!manifest.endsWith('\n') || manifest === '\n') {
    fail('migration manifest is malformed');
  }
  const matches = manifest.slice(0, -1).split('\n').map((line) => line.match(MIGRATION_LINE));
  if (
    matches.length !== migrations.migration_count ||
    matches.some((match) => match === null)
  ) {
    fail('migration manifest is malformed or has the wrong count');
  }
  const paths = matches.map((match) => match[2]);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => index > 0 && paths[index - 1] >= path)
  ) {
    fail('migration manifest is not uniquely and deterministically ordered');
  }
  const manifestHashEvidence = readBytes(
    resolve(evidenceDirectory, 'compute-migrations-manifest.sha256'),
    'compute-migrations-manifest.sha256',
  ).toString('utf8');
  if (
    manifestHashEvidence !==
      `${migrations.manifest_sha256}  compute-migrations.sha256\n`
  ) {
    fail('migration manifest checksum evidence has drifted');
  }

  const retention = exactObject(release.artifact_retention, 'artifact_retention');
  exactKeys(
    retention,
    [
      'migration_sha256',
      'owner_retained_output_bytes',
      'owner_retained_output_objects',
      'ready_output_days',
    ],
    'artifact_retention',
  );
  if (
    retention.ready_output_days !== 30 ||
    retention.owner_retained_output_bytes !== 10_737_418_240 ||
    retention.owner_retained_output_objects !== 10_000 ||
    typeof retention.migration_sha256 !== 'string' ||
    !HEX_SHA256.test(retention.migration_sha256)
  ) {
    fail('artifact retention declaration has drifted');
  }
  const retentionEntry = matches.find((match) => match[2] === RETENTION_MIGRATION);
  const retentionHashEvidence = readBytes(
    resolve(evidenceDirectory, 'compute-artifact-retention-migration.sha256'),
    'compute-artifact-retention-migration.sha256',
  ).toString('utf8');
  if (
    !retentionEntry ||
    retentionEntry[1] !== retention.migration_sha256 ||
    retentionHashEvidence !==
      `${retention.migration_sha256}  ${RETENTION_MIGRATION}\n`
  ) {
    fail('artifact retention migration evidence has drifted');
  }
  const retentionPolicy = exactObject(
    readJson(
      resolve(evidenceDirectory, 'compute-artifact-retention-policy.json'),
      'compute-artifact-retention-policy.json',
    ),
    'compute-artifact-retention-policy.json',
  );
  exactKeys(
    retentionPolicy,
    [
      'deletion_authority',
      'download_lease_seconds',
      'migration',
      'owner_retained_output_bytes',
      'owner_retained_output_objects',
      'r2_age_deletion_allowed',
      'ready_output_days',
      'schema_version',
    ],
    'compute-artifact-retention-policy.json',
  );
  if (
    retentionPolicy.schema_version !== 1 ||
    retentionPolicy.migration !== RETENTION_MIGRATION.split('/').at(-1) ||
    retentionPolicy.ready_output_days !== retention.ready_output_days ||
    retentionPolicy.owner_retained_output_bytes !==
      retention.owner_retained_output_bytes ||
    retentionPolicy.owner_retained_output_objects !==
      retention.owner_retained_output_objects ||
    retentionPolicy.download_lease_seconds !== 3_600 ||
    retentionPolicy.deletion_authority !== 'database_reconciler' ||
    retentionPolicy.r2_age_deletion_allowed !== false
  ) {
    fail('artifact retention policy has drifted');
  }

  const storage = exactObject(release.artifact_storage, 'artifact_storage');
  exactKeys(storage, ['public_access'], 'artifact_storage');
  if (storage.public_access !== false) {
    fail('artifact storage is not certified private');
  }

  const schemaRun = exactObject(
    readJson(
      resolve(evidenceDirectory, 'schema-workflow-run.json'),
      'schema-workflow-run.json',
    ),
    'schema-workflow-run.json',
  );
  exactKeys(
    schemaRun,
    [
      'conclusion',
      'created_at',
      'event',
      'head_branch',
      'head_sha',
      'id',
      'path',
      'run_attempt',
      'updated_at',
    ],
    'schema-workflow-run.json',
  );
  verifyRunIdValue(
    schemaRun.id,
    migrations.schema_workflow_run_id,
    'schema workflow run ID',
  );
  if (
    (schemaRun.event !== 'push' && schemaRun.event !== 'workflow_dispatch') ||
    schemaRun.conclusion !== 'success' ||
    schemaRun.head_sha !== release.git_sha ||
    schemaRun.head_branch !== workflowRun.head_branch ||
    schemaRun.path !== target.schemaWorkflowPath ||
    !Number.isSafeInteger(schemaRun.run_attempt) ||
    schemaRun.run_attempt < 1
  ) {
    fail('schema workflow run does not match the exact release');
  }
  verifyTimestamp(schemaRun.created_at, 'schema workflow created_at');
  verifyTimestamp(schemaRun.updated_at, 'schema workflow updated_at');

  const schemaJob = exactObject(
    readJson(
      resolve(evidenceDirectory, 'schema-workflow-job.json'),
      'schema-workflow-job.json',
    ),
    'schema-workflow-job.json',
  );
  exactKeys(
    schemaJob,
    [
      'completed_at',
      'conclusion',
      'head_sha',
      'id',
      'name',
      'run_id',
      'started_at',
      'status',
    ],
    'schema-workflow-job.json',
  );
  verifyRunIdValue(
    schemaJob.run_id,
    migrations.schema_workflow_run_id,
    'schema deploy-job run ID',
  );
  if (
    !(
      (typeof schemaJob.id === 'number' &&
        Number.isSafeInteger(schemaJob.id) && schemaJob.id > 0) ||
      (typeof schemaJob.id === 'string' && RUN_ID.test(schemaJob.id))
    ) ||
    schemaJob.name !== target.schemaDeployJob ||
    schemaJob.status !== 'completed' ||
    schemaJob.conclusion !== 'success' ||
    schemaJob.head_sha !== release.git_sha
  ) {
    fail('schema deploy job does not match the exact release');
  }
  verifyTimestamp(schemaJob.started_at, 'schema job started_at');
  verifyTimestamp(schemaJob.completed_at, 'schema job completed_at');
}

function verifyImageEvidence({ evidenceDirectory, release, target }) {
  if (
    typeof release.base_image !== 'string' ||
    !BASE_IMAGE.test(release.base_image) ||
    readBytes(resolve(evidenceDirectory, 'base-image.txt'), 'base-image.txt')
        .toString('utf8') !== `${release.base_image}\n`
  ) {
    fail('base image evidence has drifted');
  }
  if (
    typeof release.environment_digest !== 'string' ||
    !SHA256.test(release.environment_digest)
  ) {
    fail('environment digest is malformed');
  }
  const imageMatch = typeof release.deployed_image === 'string'
    ? release.deployed_image.match(
      /^registry\.cloudflare\.com\/([0-9a-f]{32})\/([a-z0-9-]+)@(sha256:[0-9a-f]{64})$/u,
    )
    : null;
  if (
    !imageMatch ||
    imageMatch[2] !== target.computeWorker ||
    imageMatch[3] !== release.environment_digest
  ) {
    fail('deployed image path and environment digest do not match');
  }

  const manifest = exactObject(
    readJson(
      resolve(evidenceDirectory, 'remote-manifest.json'),
      'remote-manifest.json',
    ),
    'remote-manifest.json',
  );
  const imageManifest = manifest.OCIManifest ?? manifest.SchemaV2Manifest;
  const descriptor = exactObject(manifest.Descriptor, 'remote manifest descriptor');
  exactKeys(
    imageManifest,
    ['config', 'layers', 'mediaType', 'schemaVersion'],
    'remote image manifest',
  );
  exactKeys(
    imageManifest.config,
    ['digest', 'mediaType', 'size'],
    'remote image config descriptor',
  );
  if (
    (manifest.OCIManifest === undefined) ===
      (manifest.SchemaV2Manifest === undefined) ||
    descriptor.digest !== release.environment_digest ||
    descriptor.mediaType !== imageManifest.mediaType ||
    descriptor.platform?.architecture !== 'amd64' ||
    descriptor.platform?.os !== 'linux' ||
    imageManifest.schemaVersion !== 2 ||
    typeof imageManifest.config.digest !== 'string' ||
    !SHA256.test(imageManifest.config.digest) ||
    !Number.isSafeInteger(imageManifest.config.size) ||
    imageManifest.config.size <= 0
  ) {
    fail('remote manifest does not bind the exact linux/amd64 release image');
  }
  const configDigest = `${imageManifest.config.digest}\n`;
  if (
    readBytes(
      resolve(evidenceDirectory, 'remote-config-digest.txt'),
      'remote-config-digest.txt',
    ).toString('utf8') !== configDigest ||
    readBytes(
      resolve(evidenceDirectory, 'local-image-id.txt'),
      'local-image-id.txt',
    ).toString('utf8') !== configDigest
  ) {
    fail('remote manifest config does not match the exact local image');
  }

  if (!Array.isArray(imageManifest.layers) || imageManifest.layers.length === 0) {
    fail('remote image manifest does not contain runtime layers');
  }
  const runtimeLayers = imageManifest.layers.map((layer, index) => {
    exactKeys(layer, ['digest', 'mediaType', 'size'], `remote image layer ${index}`);
    if (
      typeof layer.digest !== 'string' ||
      !SHA256.test(layer.digest) ||
      !IMAGE_LAYER_MEDIA_TYPES.has(layer.mediaType) ||
      !Number.isSafeInteger(layer.size) ||
      layer.size < 0
    ) {
      fail(`remote image layer ${index} is malformed`);
    }
    return {
      digest: layer.digest,
      media_type: layer.mediaType,
      size: layer.size,
    };
  });

  const buildInputs = readBytes(
    resolve(evidenceDirectory, 'build-inputs.sha256'),
    'build-inputs.sha256',
  );
  const buildInputText = buildInputs.toString('utf8');
  const buildInputLines = buildInputText.endsWith('\n')
    ? buildInputText.slice(0, -1).split('\n')
    : [];
  const buildInputPaths = new Set();
  if (buildInputLines.length === 0) {
    fail('image build-input manifest is empty or noncanonical');
  }
  for (const line of buildInputLines) {
    const match = line.match(BUILD_INPUT_LINE);
    const inputPath = match?.[2];
    if (
      !match ||
      inputPath.startsWith('/') ||
      inputPath.split('/').includes('..') ||
      buildInputPaths.has(inputPath)
    ) {
      fail('image build-input manifest is malformed or ambiguous');
    }
    buildInputPaths.add(inputPath);
  }

  const container = exactObject(
    readJson(
      resolve(evidenceDirectory, 'container-readiness.json'),
      'container-readiness.json',
    ),
    'container-readiness.json',
  );
  exactKeys(
    container,
    [
      'id',
      'image',
      'instances',
      'name',
      'schema_version',
      'state',
      'updated_at',
      'version',
    ],
    'container-readiness.json',
  );
  if (
    container.schema_version !== 1 ||
    typeof container.id !== 'string' ||
    container.id.length === 0 ||
    container.name !== `${target.computeWorker}-computestandard` ||
    (container.state !== 'active' && container.state !== 'ready') ||
    !(
      container.instances === null ||
      (Number.isSafeInteger(container.instances) && container.instances >= 0)
    ) ||
    container.image !== release.deployed_image ||
    ((typeof container.version !== 'string' &&
      typeof container.version !== 'number') ||
      String(container.version).length === 0) ||
    !(
      container.updated_at === null ||
      isCanonicalUtcTimestamp(container.updated_at)
    )
  ) {
    fail('container readiness does not prove the exact deployed image');
  }

  return {
    schema_version: 1,
    base_image: release.base_image,
    build_inputs_sha256: prefixedHash(buildInputs),
    layer_manifest_sha256: prefixedHash(
      Buffer.from(`${JSON.stringify(runtimeLayers)}\n`, 'utf8'),
    ),
    layer_count: runtimeLayers.length,
  };
}

function verifyHistoricalOffState(release, target) {
  const certified = exactObject(
    release.certified_admission_off_api,
    'certified_admission_off_api',
  );
  const active = exactObject(release.active_api, 'active_api');
  exactKeys(
    certified,
    ['version_id', 'version_tag', 'worker'],
    'certified_admission_off_api',
  );
  exactKeys(
    active,
    [
      'canary_allowlist',
      'enabled',
      'rollout_mode',
      'version_id',
      'version_tag',
      'worker',
    ],
    'active_api',
  );
  verifyUuid(certified.version_id, 'historical certified OFF API version ID');
  verifyUuid(active.version_id, 'historical active API version ID');
  verifyEmptyAllowlist(active.canary_allowlist, 'historical API canary allowlist');
  const expectedTag = `api-${release.git_sha}-admission-off`;
  if (
    certified.worker !== target.apiWorker ||
    certified.version_tag !== expectedTag ||
    active.worker !== target.apiWorker ||
    active.version_id !== certified.version_id ||
    active.version_tag !== certified.version_tag ||
    active.enabled !== false ||
    active.rollout_mode !== 'canary'
  ) {
    fail('historical API evidence does not prove admission OFF');
  }
}

export function verifyComputeRolloutReleaseEvidence({
  evidenceDirectory,
  target: targetName,
  workflowRunPath,
  expectedRunId,
}) {
  if (typeof evidenceDirectory !== 'string' || evidenceDirectory.length === 0) {
    fail('evidence directory is malformed');
  }
  if (typeof workflowRunPath !== 'string' || workflowRunPath.length === 0) {
    fail('workflow-run JSON path is malformed');
  }
  if (typeof expectedRunId !== 'string' || !RUN_ID.test(expectedRunId)) {
    fail('expected workflow run ID is malformed');
  }
  const target = TARGETS[targetName];
  if (!target) fail('target must be staging or production');

  const workflowRun = exactObject(
    readJson(resolve(workflowRunPath), 'Compute Deploy workflow-run JSON'),
    'Compute Deploy workflow run',
  );
  verifyWorkflowRun(workflowRun, expectedRunId);
  const release = exactObject(
    readJson(resolve(evidenceDirectory, 'release.json'), 'release.json'),
    'release.json',
  );
  exactKeys(release, RELEASE_KEYS, 'schema 6 release.json');
  if (
    release.schema_version !== 6 ||
    release.release_mode !== 'policy_preserved' ||
    release.admission_mode !== 'preserve_off' ||
    release.environment !== targetName ||
    release.git_sha !== workflowRun.head_sha ||
    release.workflow_run_id !== expectedRunId
  ) {
    fail('release provenance, target, schema, or mode does not match');
  }
  verifyTimestamp(release.generated_at, 'release generated_at');
  verifyEmptyAllowlist(release.canary_allowlist, 'release canary allowlist');
  if (
    release.admission_enabled !== false ||
    release.rollout_mode !== 'canary'
  ) {
    fail('release does not preserve canonical admission-OFF policy');
  }

  verifyReleasePolicy({
    evidenceDirectory,
    release,
    targetName,
    target,
    workflowRun,
  });
  const runtimeProvenance = verifyImageEvidence({
    evidenceDirectory,
    release,
    target,
  });
  verifyMigrationAndRetentionEvidence({
    evidenceDirectory,
    release,
    target,
    workflowRun,
  });
  verifyHistoricalOffState(release, target);
  verifyPolicySnapshots({ evidenceDirectory, release, target });
  const activeCompute = verifyActiveCompute({
    evidenceDirectory,
    release,
    target,
  });
  verifyBindingPreflight({
    evidenceDirectory,
    release,
    targetName,
    expectedRunId,
  });

  for (
    const forbiddenFile of [
      'active-global-api-version.json',
      `compute-admitted-${targetName}.json`,
      'post-smoke-live-fence.json',
    ]
  ) {
    if (existsSync(resolve(evidenceDirectory, forbiddenFile))) {
      fail(`preserve_off evidence contains forbidden claim ${forbiddenFile}`);
    }
  }

  return {
    schema_version: 1,
    verified: true,
    target: targetName,
    release_sha: release.git_sha,
    workflow_run_id: expectedRunId,
    environment_digest: release.environment_digest,
    deployed_image: release.deployed_image,
    runtime_provenance: runtimeProvenance,
    compute_version_id: activeCompute.version_id,
    compute_version_tag: activeCompute.version_tag,
  };
}

function main(argv) {
  if (argv.length !== 4) {
    throw new Error(
      'Usage: verify-compute-rollout-release-evidence.mjs ' +
        '<evidence-directory> <staging|production> <workflow-run-json> ' +
        '<expected-run-id>',
    );
  }
  const result = verifyComputeRolloutReleaseEvidence({
    evidenceDirectory: resolve(argv[0]),
    target: argv[1],
    workflowRunPath: resolve(argv[2]),
    expectedRunId: argv[3],
  });
  console.log(JSON.stringify(result));
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
