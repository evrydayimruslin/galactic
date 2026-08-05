#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateRolloutState } from './verify-api-compute-rollout-state.mjs';

const GIT_SHA = /^[0-9a-f]{40}$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERSION_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UTC_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const WORKFLOW_PATH = '.github/workflows/compute-worker-refresh.yml';
const REFRESH_KIND = 'galactic_compute_worker_refresh';
const REQUEST_KIND = 'galactic_compute_worker_refresh_request';
const FINGERPRINT_KIND = 'galactic_compute_worker_version_fingerprint';

const TARGETS = Object.freeze({
  staging: Object.freeze({
    apiWorker: 'ultralight-api-staging',
    computeWorker: 'galactic-compute-staging',
    gitRef: 'refs/heads/main',
    headBranch: 'main',
  }),
  production: Object.freeze({
    apiWorker: 'ultralight-api',
    computeWorker: 'galactic-compute',
    gitRefPattern: /^refs\/tags\/v[0-9A-Za-z][0-9A-Za-z._-]*$/u,
    headBranchPattern: /^v[0-9A-Za-z][0-9A-Za-z._-]*$/u,
  }),
});

const SUCCESS_FILES = Object.freeze([
  'after-container-readiness.json',
  'after-state.json',
  'after-worker-fingerprint.json',
  'before-container-readiness.json',
  'before-state.json',
  'before-worker-fingerprint.json',
  'refresh.json',
  'request.json',
  'source-release-verification.json',
]);

function fail(message) {
  throw new Error(`Compute Worker refresh evidence is invalid: ${message}`);
}

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const row = record(value, label);
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has an unexpected shape`);
  }
  return row;
}

function readBytes(path, label) {
  try {
    return readFileSync(resolve(path));
  } catch {
    fail(`${label} is missing or unreadable`);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch {
    fail(`${label} is missing or not valid JSON`);
  }
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashFile(path, label) {
  return hashBytes(readBytes(path, label));
}

function canonicalValue(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalValue(entry, `${label}[${index}]`));
  }
  if (typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      output[key] = canonicalValue(value[key], `${label}.${key}`);
    }
    return output;
  }
  fail(`${label} contains an unsupported value`);
}

function hashCanonical(value) {
  return hashBytes(Buffer.from(JSON.stringify(canonicalValue(value, 'value'))));
}

function canonicalTimestamp(value, label) {
  if (
    typeof value !== 'string' || !UTC_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(`${label} is not a canonical UTC timestamp`);
  }
  return value;
}

function positiveRunId(value, label) {
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) {
    fail(`${label} is not a positive workflow run ID`);
  }
  return value;
}

function gitSha(value, label) {
  if (typeof value !== 'string' || !GIT_SHA.test(value)) {
    fail(`${label} is not a full lowercase git SHA`);
  }
  return value;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    fail(`${label} is not a canonical UUID`);
  }
  return value;
}

function versionTag(value, label) {
  if (typeof value !== 'string' || !VERSION_TAG.test(value)) {
    fail(`${label} is malformed`);
  }
  return value;
}

function targetContract(target) {
  const contract = TARGETS[target];
  if (!contract) fail('target must be staging or production');
  return contract;
}

function validateGitRef(target, gitRef, label) {
  const contract = targetContract(target);
  if (
    (target === 'staging' && gitRef !== contract.gitRef) ||
    (target === 'production' &&
      (typeof gitRef !== 'string' || !contract.gitRefPattern.test(gitRef)))
  ) {
    fail(`${label} is not an allowed ${target} ref`);
  }
  return gitRef;
}

function validateDispatch(value, { includeRef = false } = {}) {
  const keys = [
    'git_sha',
    ...(includeRef ? ['git_ref'] : []),
    'repository',
    'run_attempt',
    'workflow_run_id',
  ];
  const row = exactKeys(value, keys, 'refresh dispatch');
  if (typeof row.repository !== 'string' || !REPOSITORY.test(row.repository)) {
    fail('refresh dispatch repository is malformed');
  }
  positiveRunId(row.workflow_run_id, 'refresh dispatch workflow run ID');
  positiveRunId(row.run_attempt, 'refresh dispatch run attempt');
  gitSha(row.git_sha, 'refresh dispatch git SHA');
  return row;
}

function validateRequest(value, target, sourceRunId) {
  const row = exactKeys(
    value,
    [
      'confirmation',
      'dispatch',
      'kind',
      'schema_version',
      'source_compute_release_run_id',
      'target',
    ],
    'request.json',
  );
  const dispatch = validateDispatch(row.dispatch, { includeRef: true });
  validateGitRef(target, dispatch.git_ref, 'request git ref');
  if (
    row.schema_version !== 1 || row.kind !== REQUEST_KIND ||
    row.target !== target || row.confirmation !== `refresh-${target}-compute` ||
    row.source_compute_release_run_id !== sourceRunId
  ) {
    fail('request does not match the selected target or source release');
  }
  return { ...row, dispatch };
}

function validateSourceRelease(value, target, sourceRunId) {
  const row = exactKeys(
    value,
    [
      'compute_version_id',
      'compute_version_tag',
      'deployed_image',
      'environment_digest',
      'release_sha',
      'schema_version',
      'target',
      'verified',
      'workflow_run_id',
    ],
    'source-release-verification.json',
  );
  const contract = targetContract(target);
  const digest = typeof row.environment_digest === 'string' &&
      DIGEST.test(row.environment_digest)
    ? row.environment_digest
    : fail('source release environment digest is malformed');
  const imageMatch = typeof row.deployed_image === 'string'
    ? row.deployed_image.match(
      /^registry\.cloudflare\.com\/([0-9a-f]{32})\/([a-z0-9-]+)@(sha256:[0-9a-f]{64})$/u,
    )
    : null;
  uuid(row.compute_version_id, 'source Compute version ID');
  versionTag(row.compute_version_tag, 'source Compute version tag');
  gitSha(row.release_sha, 'source release SHA');
  positiveRunId(row.workflow_run_id, 'source release workflow run ID');
  if (
    row.schema_version !== 1 || row.verified !== true ||
    row.target !== target || row.workflow_run_id !== sourceRunId ||
    !imageMatch || imageMatch[2] !== contract.computeWorker ||
    imageMatch[3] !== digest
  ) {
    fail('source release does not certify the selected Compute image');
  }
  return row;
}

function normalizeConfigurationResources(resources) {
  const normalized = canonicalValue(resources, 'Compute resources');
  const script = record(normalized.script, 'Compute script metadata');
  delete script.etag;
  if (!Array.isArray(normalized.bindings)) {
    fail('Compute resources do not contain bindings');
  }
  normalized.bindings.sort((left, right) => {
    const leftName = typeof left?.name === 'string' ? left.name : '';
    const rightName = typeof right?.name === 'string' ? right.name : '';
    return leftName.localeCompare(rightName, 'en') ||
      JSON.stringify(left).localeCompare(JSON.stringify(right), 'en');
  });
  return normalized;
}

export function computeWorkerVersionFingerprint({ target, version }) {
  const contract = targetContract(target);
  const row = record(version, 'Compute version detail');
  const resources = record(row.resources, 'Compute version resources');
  const script = record(resources.script, 'Compute script metadata');
  uuid(row.id, 'Compute version ID');
  const tag = versionTag(
    record(row.annotations, 'Compute version annotations')['workers/tag'],
    'Compute version tag',
  );
  if (
    typeof script.etag !== 'string' || script.etag.length === 0 ||
    script.etag.length > 256 || /[\u0000-\u001f\u007f]/u.test(script.etag)
  ) {
    fail('Compute code ETag is malformed');
  }
  const names = Array.isArray(resources.bindings)
    ? resources.bindings.map((binding) => binding?.name)
    : [];
  if (
    names.filter((name) => name === 'COMPUTE_ENVIRONMENT_DIGEST').length !== 1 ||
    names.filter((name) => name === 'CONTROL_PLANE').length !== 1 ||
    names.filter((name) => name === 'COMPUTE_ARTIFACTS').length !== 1
  ) {
    fail('Compute version does not contain the exact required bindings');
  }
  const controlPlane = resources.bindings.find(
    (binding) => binding?.name === 'CONTROL_PLANE',
  );
  if (
    controlPlane?.type !== 'service' ||
    controlPlane.service !== contract.apiWorker ||
    controlPlane.entrypoint !== 'ComputeControlPlane'
  ) {
    fail('Compute control-plane binding does not match the target');
  }
  return {
    schema_version: 1,
    kind: FINGERPRINT_KIND,
    target,
    worker: contract.computeWorker,
    version_id: row.id,
    version_tag: tag,
    code_etag: script.etag,
    configuration_sha256: hashCanonical(
      normalizeConfigurationResources(resources),
    ),
  };
}

function validateFingerprint(value, target, label) {
  const row = exactKeys(
    value,
    [
      'code_etag',
      'configuration_sha256',
      'kind',
      'schema_version',
      'target',
      'version_id',
      'version_tag',
      'worker',
    ],
    label,
  );
  const contract = targetContract(target);
  uuid(row.version_id, `${label} version ID`);
  versionTag(row.version_tag, `${label} version tag`);
  if (
    row.schema_version !== 1 || row.kind !== FINGERPRINT_KIND ||
    row.target !== target || row.worker !== contract.computeWorker ||
    typeof row.code_etag !== 'string' || row.code_etag.length === 0 ||
    typeof row.configuration_sha256 !== 'string' ||
    !HEX_SHA256.test(row.configuration_sha256)
  ) {
    fail(`${label} metadata is malformed`);
  }
  return row;
}

function validateContainer(value, target, expectedImage, label) {
  const row = exactKeys(
    value,
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
    label,
  );
  const contract = targetContract(target);
  if (
    row.schema_version !== 1 || typeof row.id !== 'string' || row.id.length === 0 ||
    row.name !== `${contract.computeWorker}-computestandard` ||
    !['active', 'ready'].includes(row.state) || row.image !== expectedImage ||
    !(row.instances === null ||
      (Number.isSafeInteger(row.instances) && row.instances >= 0)) ||
    !(['string', 'number'].includes(typeof row.version)) ||
    String(row.version).length === 0 ||
    !(row.updated_at === null ||
      (typeof row.updated_at === 'string' && UTC_TIMESTAMP.test(row.updated_at) &&
        Number.isFinite(Date.parse(row.updated_at))))
  ) {
    fail(`${label} does not prove the exact ready container application`);
  }
  return row;
}

function sameDispatch(stateDispatch, requestDispatch) {
  return ['repository', 'workflow_run_id', 'run_attempt', 'git_sha'].every(
    (key) => stateDispatch[key] === requestDispatch[key],
  );
}

function stateReference(directory, name) {
  return {
    evidence_file: name,
    sha256: hashFile(resolve(directory, name), name),
  };
}

export function buildComputeWorkerRefreshEvidence({
  evidenceDirectory,
  target,
  sourceComputeReleaseRunId,
  generatedAt,
}) {
  const directory = resolve(evidenceDirectory);
  targetContract(target);
  positiveRunId(sourceComputeReleaseRunId, 'source Compute release run ID');
  canonicalTimestamp(generatedAt, 'refresh generated_at');

  const request = validateRequest(
    readJson(resolve(directory, 'request.json'), 'request.json'),
    target,
    sourceComputeReleaseRunId,
  );
  const source = validateSourceRelease(
    readJson(
      resolve(directory, 'source-release-verification.json'),
      'source-release-verification.json',
    ),
    target,
    sourceComputeReleaseRunId,
  );
  const before = validateRolloutState(
    readJson(resolve(directory, 'before-state.json'), 'before-state.json'),
  );
  const after = validateRolloutState(
    readJson(resolve(directory, 'after-state.json'), 'after-state.json'),
  );
  const beforeFingerprint = validateFingerprint(
    readJson(
      resolve(directory, 'before-worker-fingerprint.json'),
      'before-worker-fingerprint.json',
    ),
    target,
    'before Worker fingerprint',
  );
  const afterFingerprint = validateFingerprint(
    readJson(
      resolve(directory, 'after-worker-fingerprint.json'),
      'after-worker-fingerprint.json',
    ),
    target,
    'after Worker fingerprint',
  );
  const beforeContainer = validateContainer(
    readJson(
      resolve(directory, 'before-container-readiness.json'),
      'before-container-readiness.json',
    ),
    target,
    source.deployed_image,
    'before container readiness',
  );
  const afterContainer = validateContainer(
    readJson(
      resolve(directory, 'after-container-readiness.json'),
      'after-container-readiness.json',
    ),
    target,
    source.deployed_image,
    'after container readiness',
  );

  const expectedTag = `compute-${request.dispatch.git_sha}-worker-refresh`;
  if (
    before.phase !== 'inspected' || after.phase !== 'inspected' ||
    before.target !== target || after.target !== target ||
    before.policy !== 'off' || after.policy !== 'off' ||
    before.canary_allowlist.length !== 0 || after.canary_allowlist.length !== 0 ||
    before.certification_principal !== null ||
    after.certification_principal !== null ||
    before.environment_digest !== source.environment_digest ||
    after.environment_digest !== source.environment_digest ||
    !sameDispatch(before.dispatch, request.dispatch) ||
    !sameDispatch(after.dispatch, request.dispatch) ||
    JSON.stringify(before.api) !== JSON.stringify(after.api) ||
    before.compute.version_id !== source.compute_version_id ||
    before.compute.version_tag !== source.compute_version_tag ||
    after.compute.worker !== before.compute.worker ||
    after.compute.version_id === before.compute.version_id ||
    after.compute.deployment_id === before.compute.deployment_id ||
    after.compute.version_tag !== expectedTag ||
    after.compute.code_etag === before.compute.code_etag ||
    beforeFingerprint.version_id !== before.compute.version_id ||
    beforeFingerprint.version_tag !== before.compute.version_tag ||
    beforeFingerprint.code_etag !== before.compute.code_etag ||
    afterFingerprint.version_id !== after.compute.version_id ||
    afterFingerprint.version_tag !== after.compute.version_tag ||
    afterFingerprint.code_etag !== after.compute.code_etag ||
    beforeFingerprint.configuration_sha256 !==
      afterFingerprint.configuration_sha256 ||
    beforeContainer.id !== afterContainer.id ||
    beforeContainer.name !== afterContainer.name ||
    beforeContainer.image !== afterContainer.image ||
    String(beforeContainer.version) !== String(afterContainer.version)
  ) {
    fail('before/after evidence does not prove one Worker-code-only refresh');
  }

  return {
    schema_version: 1,
    kind: REFRESH_KIND,
    verified: true,
    target,
    generated_at: generatedAt,
    dispatch: request.dispatch,
    source_compute_release: {
      evidence_file: 'source-release-verification.json',
      sha256: hashFile(
        resolve(directory, 'source-release-verification.json'),
        'source-release-verification.json',
      ),
      workflow_run_id: source.workflow_run_id,
      release_sha: source.release_sha,
    },
    environment_digest: source.environment_digest,
    deployed_image: source.deployed_image,
    before: {
      state: stateReference(directory, 'before-state.json'),
      worker_fingerprint: stateReference(
        directory,
        'before-worker-fingerprint.json',
      ),
      container: stateReference(directory, 'before-container-readiness.json'),
      compute_version_id: before.compute.version_id,
      compute_version_tag: before.compute.version_tag,
      compute_code_etag: before.compute.code_etag,
      compute_configuration_sha256:
        beforeFingerprint.configuration_sha256,
    },
    after: {
      state: stateReference(directory, 'after-state.json'),
      worker_fingerprint: stateReference(
        directory,
        'after-worker-fingerprint.json',
      ),
      container: stateReference(directory, 'after-container-readiness.json'),
      compute_version_id: after.compute.version_id,
      compute_version_tag: after.compute.version_tag,
      compute_code_etag: after.compute.code_etag,
      compute_configuration_sha256: afterFingerprint.configuration_sha256,
    },
    invariants: {
      admission_policy: 'off',
      api_worker_unchanged: true,
      compute_configuration_unchanged: true,
      container_application_unchanged: true,
      container_image_unchanged: true,
    },
  };
}

function verifyWorkflowRun(workflowRun, target, refresh) {
  const row = record(workflowRun, 'Compute Worker Refresh workflow run');
  const contract = targetContract(target);
  if (
    String(row.id) !== refresh.dispatch.workflow_run_id ||
    String(row.run_attempt) !== refresh.dispatch.run_attempt ||
    row.event !== 'workflow_dispatch' || row.conclusion !== 'success' ||
    row.status !== 'completed' || row.path !== WORKFLOW_PATH ||
    row.head_sha !== refresh.dispatch.git_sha ||
    row.repository?.full_name !== refresh.dispatch.repository ||
    row.head_repository?.full_name !== refresh.dispatch.repository ||
    (target === 'staging' && row.head_branch !== contract.headBranch) ||
    (target === 'production' &&
      (typeof row.head_branch !== 'string' ||
        !contract.headBranchPattern.test(row.head_branch) ||
        refresh.dispatch.git_ref !== `refs/tags/${row.head_branch}`))
  ) {
    fail('workflow run is not the successful protected refresh dispatch');
  }
}

function verifyManifest(directory) {
  const manifest = readFileSync(resolve(directory, 'evidence.sha256'), 'utf8');
  const lines = manifest.endsWith('\n')
    ? manifest.slice(0, -1).split('\n')
    : fail('evidence.sha256 is not newline terminated');
  const expectedNames = [...SUCCESS_FILES].sort();
  if (lines.length !== expectedNames.length) {
    fail('evidence.sha256 does not bind the exact successful evidence files');
  }
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([0-9a-f]{64})  \.\/([A-Za-z0-9._-]+)$/u);
    if (!match || match[2] !== expectedNames[index]) {
      fail('evidence.sha256 is malformed or not deterministically ordered');
    }
    if (match[1] !== hashFile(resolve(directory, match[2]), match[2])) {
      fail(`evidence.sha256 does not match ${match[2]}`);
    }
  }
}

export function verifyComputeWorkerRefreshEvidence({
  evidenceDirectory,
  target,
  workflowRunPath,
  expectedRunId,
  expectedSourceComputeReleaseRunId,
}) {
  const directory = resolve(evidenceDirectory);
  positiveRunId(expectedRunId, 'expected refresh workflow run ID');
  positiveRunId(
    expectedSourceComputeReleaseRunId,
    'expected source Compute release run ID',
  );
  verifyManifest(directory);
  const refresh = exactKeys(
    readJson(resolve(directory, 'refresh.json'), 'refresh.json'),
    [
      'after',
      'before',
      'deployed_image',
      'dispatch',
      'environment_digest',
      'generated_at',
      'invariants',
      'kind',
      'schema_version',
      'source_compute_release',
      'target',
      'verified',
    ],
    'refresh.json',
  );
  const rebuilt = buildComputeWorkerRefreshEvidence({
    evidenceDirectory: directory,
    target,
    sourceComputeReleaseRunId: expectedSourceComputeReleaseRunId,
    generatedAt: refresh.generated_at,
  });
  if (JSON.stringify(refresh) !== JSON.stringify(rebuilt)) {
    fail('refresh.json does not match its bound evidence files');
  }
  if (
    refresh.schema_version !== 1 || refresh.kind !== REFRESH_KIND ||
    refresh.verified !== true || refresh.target !== target ||
    refresh.dispatch.workflow_run_id !== expectedRunId
  ) {
    fail('refresh provenance does not match the requested workflow run');
  }
  const workflowRun = readJson(workflowRunPath, 'refresh workflow-run JSON');
  verifyWorkflowRun(workflowRun, target, refresh);
  return {
    schema_version: 1,
    verified: true,
    target,
    workflow_run_id: expectedRunId,
    git_sha: refresh.dispatch.git_sha,
    source_compute_release_run_id:
      refresh.source_compute_release.workflow_run_id,
    source_release_sha: refresh.source_compute_release.release_sha,
    environment_digest: refresh.environment_digest,
    deployed_image: refresh.deployed_image,
    source_compute_version_id: refresh.before.compute_version_id,
    source_compute_version_tag: refresh.before.compute_version_tag,
    source_compute_code_etag: refresh.before.compute_code_etag,
    compute_version_id: refresh.after.compute_version_id,
    compute_version_tag: refresh.after.compute_version_tag,
    compute_code_etag: refresh.after.compute_code_etag,
    compute_configuration_sha256:
      refresh.after.compute_configuration_sha256,
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main(argv) {
  if (argv[0] === 'fingerprint' && argv.length === 3) {
    print(computeWorkerVersionFingerprint({
      target: argv[1],
      version: readJson(argv[2], 'Compute version JSON'),
    }));
    return;
  }
  if (argv[0] === 'build' && argv.length === 5) {
    print(buildComputeWorkerRefreshEvidence({
      evidenceDirectory: argv[1],
      target: argv[2],
      sourceComputeReleaseRunId: argv[3],
      generatedAt: argv[4],
    }));
    return;
  }
  if (argv[0] === 'verify' && argv.length === 6) {
    print(verifyComputeWorkerRefreshEvidence({
      evidenceDirectory: argv[1],
      target: argv[2],
      workflowRunPath: argv[3],
      expectedRunId: argv[4],
      expectedSourceComputeReleaseRunId: argv[5],
    }));
    return;
  }
  fail(
    'usage: fingerprint <target> <version-json> | build <evidence-dir> ' +
      '<target> <source-release-run-id> <generated-at> | verify ' +
      '<evidence-dir> <target> <workflow-run-json> <refresh-run-id> ' +
      '<source-release-run-id>',
  );
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
