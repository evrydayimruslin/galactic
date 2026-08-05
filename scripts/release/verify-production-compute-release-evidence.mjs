#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RELEASE_TAG = /^v[0-9A-Za-z][0-9A-Za-z._-]*$/u;
const BASE_IMAGE =
  /^docker\.io\/cloudflare\/sandbox:0\.12\.3-python@sha256:[0-9a-f]{64}$/u;
const MIGRATION_LINE =
  /^([0-9a-f]{64})  (supabase\/migrations\/[0-9A-Za-z._-]+\.sql)$/u;
const RETENTION_MIGRATION =
  "supabase/migrations/20260720124000_compute_artifact_retention.sql";
const PRODUCTION_SCHEMA_WORKFLOW =
  ".github/workflows/supabase-production-db.yml";
const PRODUCTION_SCHEMA_JOB = "Deploy production schema";

function fail(message) {
  throw new Error(`Production Compute release evidence is invalid: ${message}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is missing or is not valid JSON`);
  }
}

function readBytes(path, label) {
  try {
    return readFileSync(path);
  } catch {
    fail(`${label} is missing or unreadable`);
  }
}

function readUtf8(path, label) {
  return readBytes(path, label).toString("utf8");
}

function exactObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) {
    fail(`${label} is not a canonical UUID`);
  }
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

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyBoundJson({
  evidenceDirectory,
  binding,
  expectedFile,
  label,
}) {
  exactKeys(
    binding,
    ["evidence_file", "sha256", "verified"],
    `${label} binding`,
  );
  if (
    binding.evidence_file !== expectedFile ||
    binding.verified !== true ||
    typeof binding.sha256 !== "string" ||
    !HEX_SHA256.test(binding.sha256)
  ) {
    fail(`release does not bind the required ${label}`);
  }
  const path = resolve(evidenceDirectory, expectedFile);
  const bytes = readBytes(path, expectedFile);
  if (hashBytes(bytes) !== binding.sha256) {
    fail(`${label} bytes do not match the release binding`);
  }
  return exactObject(readJson(path, expectedFile), expectedFile);
}

function selectedPlainTextValue(record, name, label) {
  if (!Array.isArray(record.selected_bindings)) {
    fail(`${label} selected_bindings must be an array`);
  }
  const values = record.selected_bindings
    .filter((binding) =>
      binding?.type === "plain_text" && binding?.name === name
    )
    .map((binding) => binding.text);
  if (values.length !== 1 || typeof values[0] !== "string") {
    fail(`${label} must contain exactly one ${name} plain-text binding`);
  }
  return values[0];
}

function optionalSelectedPlainTextValue(record, name, label) {
  if (!Array.isArray(record.selected_bindings)) {
    fail(`${label} selected_bindings must be an array`);
  }
  const matches = record.selected_bindings.filter((binding) =>
    binding?.name === name
  );
  if (matches.length === 0) return null;
  if (
    matches.length !== 1 || matches[0]?.type !== "plain_text" ||
    typeof matches[0]?.text !== "string"
  ) {
    fail(`${label} must contain at most one ${name} plain-text binding`);
  }
  return matches[0].text;
}

function hasExactlyOneSelectedBinding(record, predicate, label) {
  if (!Array.isArray(record.selected_bindings)) {
    fail(`${label} selected_bindings must be an array`);
  }
  if (record.selected_bindings.filter(predicate).length !== 1) {
    fail(`${label} is missing an exact required binding`);
  }
}

function verifyImageIdentity(release) {
  const expectedImage =
    /^registry\.cloudflare\.com\/[0-9a-f]{32}\/galactic-compute@(sha256:[0-9a-f]{64})$/u;
  const imageMatch = typeof release.deployed_image === "string"
    ? release.deployed_image.match(expectedImage)
    : null;
  if (
    typeof release.environment_digest !== "string" ||
    !SHA256.test(release.environment_digest) ||
    !imageMatch ||
    imageMatch[1] !== release.environment_digest
  ) {
    fail("released image and immutable environment digest do not match");
  }
}

function verifyPreserveOffPlatformEvidence({
  release,
  evidenceDirectory,
  candidateSha,
}) {
  if (
    typeof release.base_image !== "string" ||
    !BASE_IMAGE.test(release.base_image) ||
    readUtf8(resolve(evidenceDirectory, "base-image.txt"), "base-image.txt") !==
      `${release.base_image}\n`
  ) {
    fail("schema 6 base image is not an exact reviewed digest");
  }

  const migrations = exactObject(
    release.schema_migrations,
    "schema_migrations",
  );
  exactKeys(
    migrations,
    [
      "manifest_sha256",
      "migration_count",
      "schema_deploy_job",
      "schema_workflow_path",
      "schema_workflow_run_id",
    ],
    "schema_migrations",
  );
  if (
    typeof migrations.manifest_sha256 !== "string" ||
    !HEX_SHA256.test(migrations.manifest_sha256) ||
    !Number.isSafeInteger(migrations.migration_count) ||
    migrations.migration_count < 1 ||
    typeof migrations.schema_workflow_run_id !== "string" ||
    !/^[1-9][0-9]*$/u.test(migrations.schema_workflow_run_id) ||
    migrations.schema_workflow_path !== PRODUCTION_SCHEMA_WORKFLOW ||
    migrations.schema_deploy_job !== PRODUCTION_SCHEMA_JOB
  ) {
    fail("schema 6 migration declaration is malformed");
  }

  const manifestFile = "compute-migrations.sha256";
  const manifestBytes = readBytes(
    resolve(evidenceDirectory, manifestFile),
    manifestFile,
  );
  const manifest = manifestBytes.toString("utf8");
  if (!manifest.endsWith("\n") || hashBytes(manifestBytes) !==
    migrations.manifest_sha256) {
    fail("migration manifest bytes do not match release.json");
  }
  const migrationLines = manifest.slice(0, -1).split("\n");
  const parsedMigrations = migrationLines.map((line) => line.match(MIGRATION_LINE));
  if (
    parsedMigrations.length !== migrations.migration_count ||
    parsedMigrations.some((match) => match === null)
  ) {
    fail("migration manifest is malformed or has the wrong count");
  }
  const migrationPaths = parsedMigrations.map((match) => match[2]);
  if (
    new Set(migrationPaths).size !== migrationPaths.length ||
    migrationPaths.some(
      (path, index) =>
        index > 0 && migrationPaths[index - 1].localeCompare(path, "en") >= 0,
    )
  ) {
    fail("migration manifest is not uniquely and deterministically ordered");
  }
  const manifestHashEvidence = readUtf8(
    resolve(evidenceDirectory, "compute-migrations-manifest.sha256"),
    "compute-migrations-manifest.sha256",
  );
  if (
    manifestHashEvidence !==
      `${migrations.manifest_sha256}  ${manifestFile}\n`
  ) {
    fail("migration manifest checksum evidence does not match release.json");
  }

  const retention = exactObject(
    release.artifact_retention,
    "artifact_retention",
  );
  exactKeys(
    retention,
    [
      "migration_sha256",
      "owner_retained_output_bytes",
      "owner_retained_output_objects",
      "ready_output_days",
    ],
    "artifact_retention",
  );
  if (
    retention.ready_output_days !== 30 ||
    retention.owner_retained_output_bytes !== 10_737_418_240 ||
    retention.owner_retained_output_objects !== 10_000 ||
    typeof retention.migration_sha256 !== "string" ||
    !HEX_SHA256.test(retention.migration_sha256)
  ) {
    fail("schema 6 artifact retention declaration is not the reviewed policy");
  }
  const retentionManifestEntry = parsedMigrations.find(
    (match) => match[2] === RETENTION_MIGRATION,
  );
  if (
    !retentionManifestEntry ||
    retentionManifestEntry[1] !== retention.migration_sha256 ||
    readUtf8(
      resolve(
        evidenceDirectory,
        "compute-artifact-retention-migration.sha256",
      ),
      "compute-artifact-retention-migration.sha256",
    ) !== `${retention.migration_sha256}  ${RETENTION_MIGRATION}\n`
  ) {
    fail("artifact retention migration is not bound to the migration manifest");
  }

  const retentionPolicy = exactObject(
    readJson(
      resolve(evidenceDirectory, "compute-artifact-retention-policy.json"),
      "compute-artifact-retention-policy.json",
    ),
    "compute-artifact-retention-policy.json",
  );
  exactKeys(
    retentionPolicy,
    [
      "deletion_authority",
      "download_lease_seconds",
      "migration",
      "owner_retained_output_bytes",
      "owner_retained_output_objects",
      "r2_age_deletion_allowed",
      "ready_output_days",
      "schema_version",
    ],
    "compute-artifact-retention-policy.json",
  );
  if (
    retentionPolicy.schema_version !== 1 ||
    retentionPolicy.migration !== RETENTION_MIGRATION.split("/").at(-1) ||
    retentionPolicy.ready_output_days !== retention.ready_output_days ||
    retentionPolicy.owner_retained_output_bytes !==
      retention.owner_retained_output_bytes ||
    retentionPolicy.owner_retained_output_objects !==
      retention.owner_retained_output_objects ||
    retentionPolicy.download_lease_seconds !== 3_600 ||
    retentionPolicy.deletion_authority !== "database_reconciler" ||
    retentionPolicy.r2_age_deletion_allowed !== false
  ) {
    fail("artifact retention policy evidence does not match release.json");
  }

  const storage = exactObject(release.artifact_storage, "artifact_storage");
  exactKeys(storage, ["public_access"], "artifact_storage");
  if (storage.public_access !== false) {
    fail("schema 6 artifact storage is not certified private");
  }

  const schemaRun = exactObject(
    readJson(
      resolve(evidenceDirectory, "schema-workflow-run.json"),
      "schema-workflow-run.json",
    ),
    "schema-workflow-run.json",
  );
  exactKeys(
    schemaRun,
    [
      "conclusion",
      "created_at",
      "event",
      "head_branch",
      "head_sha",
      "id",
      "path",
      "run_attempt",
      "updated_at",
    ],
    "schema-workflow-run.json",
  );
  if (
    String(schemaRun.id) !== migrations.schema_workflow_run_id ||
    (schemaRun.event !== "push" && schemaRun.event !== "workflow_dispatch") ||
    schemaRun.conclusion !== "success" ||
    schemaRun.head_sha !== candidateSha ||
    schemaRun.path !== migrations.schema_workflow_path ||
    !Number.isSafeInteger(schemaRun.run_attempt) ||
    schemaRun.run_attempt < 1
  ) {
    fail("schema workflow run evidence does not match the exact release");
  }

  const schemaJob = exactObject(
    readJson(
      resolve(evidenceDirectory, "schema-workflow-job.json"),
      "schema-workflow-job.json",
    ),
    "schema-workflow-job.json",
  );
  exactKeys(
    schemaJob,
    [
      "completed_at",
      "conclusion",
      "head_sha",
      "id",
      "name",
      "run_id",
      "started_at",
      "status",
    ],
    "schema-workflow-job.json",
  );
  if (
    String(schemaJob.run_id) !== migrations.schema_workflow_run_id ||
    schemaJob.name !== migrations.schema_deploy_job ||
    schemaJob.status !== "completed" ||
    schemaJob.conclusion !== "success" ||
    schemaJob.head_sha !== candidateSha
  ) {
    fail("schema deploy-job evidence does not match the exact release");
  }

  const container = exactObject(
    readJson(
      resolve(evidenceDirectory, "container-readiness.json"),
      "container-readiness.json",
    ),
    "container-readiness.json",
  );
  exactKeys(
    container,
    [
      "id",
      "image",
      "instances",
      "name",
      "schema_version",
      "state",
      "updated_at",
      "version",
    ],
    "container-readiness.json",
  );
  if (
    container.schema_version !== 1 ||
    typeof container.id !== "string" ||
    container.id.length === 0 ||
    container.name !== "galactic-compute-computestandard" ||
    (container.state !== "active" && container.state !== "ready") ||
    container.image !== release.deployed_image ||
    ((typeof container.version !== "string" &&
      typeof container.version !== "number") ||
      String(container.version).length === 0)
  ) {
    fail("container readiness does not prove the exact released image");
  }
}

function verifyBindingPreflight({
  evidenceDirectory,
  binding,
  candidateSha,
  workflowRunId,
}) {
  const expectedPreflightFile = "compute-preflight-production.json";
  const preflight = verifyBoundJson({
    evidenceDirectory,
    binding,
    expectedFile: expectedPreflightFile,
    label: "admission-off binding preflight",
  });
  const preflightFixturePolicy = exactObject(
    preflight.fixture_policy,
    "binding preflight fixture policy",
  );
  const preflightProbe = exactObject(
    preflight.probe,
    "binding preflight probe",
  );
  exactUuid(preflight.agent_id, "binding preflight Agent ID");
  if (
    preflight.schema_version !== 1 ||
    preflight.kind !== "galactic_compute_binding_preflight" ||
    preflight.verified !== true ||
    preflight.target !== "production" ||
    preflight.candidate_sha !== candidateSha ||
    String(preflight.workflow_run_id) !== workflowRunId ||
    preflight.function_name !== "run_compute_certification" ||
    preflightFixturePolicy.enabled !== false ||
    !/^(0|[1-9][0-9]*)$/u.test(String(preflightFixturePolicy.revision)) ||
    preflightProbe.action !== "status" ||
    preflightProbe.run_id !==
      "00000000-0000-4000-8000-000000000000" ||
    preflightProbe.expected_http_status !== 500 ||
    preflightProbe.expected_public_compute_code !==
      "COMPUTE_RUN_NOT_FOUND" ||
    preflightProbe.observed_http_status !== 500 ||
    preflightProbe.observed_public_compute_code !==
      "COMPUTE_RUN_NOT_FOUND"
  ) {
    fail("binding preflight did not prove the admission-off RPC/DB path");
  }
}

function verifyPolicySnapshotBinding({
  evidenceDirectory,
  binding,
  expectedFile,
  label,
}) {
  exactKeys(
    binding,
    [
      "admission_enabled",
      "canary_allowlist",
      "evidence_file",
      "rollout_mode",
      "sha256",
    ],
    `${label} declaration`,
  );
  if (
    binding.evidence_file !== expectedFile ||
    typeof binding.sha256 !== "string" ||
    !HEX_SHA256.test(binding.sha256) ||
    binding.admission_enabled !== false ||
    binding.rollout_mode !== "canary" ||
    !Array.isArray(binding.canary_allowlist) ||
    binding.canary_allowlist.length !== 0
  ) {
    fail(`${label} does not declare admission-OFF canary policy`);
  }
  const path = resolve(evidenceDirectory, expectedFile);
  const bytes = readBytes(path, expectedFile);
  if (hashBytes(bytes) !== binding.sha256) {
    fail(`${label} bytes do not match the release binding`);
  }
  return exactObject(readJson(path, expectedFile), expectedFile);
}

function verifyPreserveOffEvidence({
  release,
  evidenceDirectory,
  candidateSha,
  releaseTag,
  workflowRunId,
}) {
  exactKeys(
    release,
    [
      "active_api",
      "active_compute_worker",
      "admission_enabled",
      "admission_mode",
      "artifact_retention",
      "artifact_storage",
      "base_image",
      "binding_preflight",
      "canary_allowlist",
      "certified_admission_off_api",
      "deployed_image",
      "environment",
      "environment_digest",
      "generated_at",
      "git_ref",
      "git_sha",
      "policy_after",
      "policy_before",
      "release_mode",
      "release_policy",
      "rollout_mode",
      "schema_migrations",
      "schema_version",
      "workflow_run_id",
    ],
    "schema 6 release.json",
  );
  if (
    release.schema_version !== 6 ||
    release.release_mode !== "policy_preserved" ||
    release.admission_mode !== "preserve_off" ||
    release.environment !== "production" ||
    release.git_sha !== candidateSha ||
    release.git_ref !== `refs/tags/${releaseTag}` ||
    String(release.workflow_run_id) !== workflowRunId
  ) {
    fail("schema 6 release provenance or mode does not match the exact tag");
  }
  if (
    release.admission_enabled !== false ||
    release.rollout_mode !== "canary" ||
    !Array.isArray(release.canary_allowlist) ||
    release.canary_allowlist.length !== 0
  ) {
    fail("schema 6 release does not preserve admission-OFF canary policy");
  }
  verifyImageIdentity(release);
  verifyPreserveOffPlatformEvidence({
    release,
    evidenceDirectory,
    candidateSha,
  });

  const expectedOffApiTag = `api-${candidateSha}-admission-off`;
  const expectedComputeTag = `compute-${candidateSha}`;
  const offApi = exactObject(
    release.certified_admission_off_api,
    "certified_admission_off_api",
  );
  const activeApi = exactObject(release.active_api, "active_api");
  const activeCompute = exactObject(
    release.active_compute_worker,
    "active_compute_worker",
  );
  exactKeys(
    offApi,
    ["version_id", "version_tag", "worker"],
    "certified_admission_off_api",
  );
  exactKeys(
    activeApi,
    [
      "canary_allowlist",
      "enabled",
      "rollout_mode",
      "version_id",
      "version_tag",
      "worker",
    ],
    "active_api",
  );
  exactKeys(
    activeCompute,
    [
      "environment_digest",
      "evidence_file",
      "sha256",
      "version_id",
      "version_tag",
      "worker",
    ],
    "active_compute_worker",
  );
  exactUuid(offApi.version_id, "certified OFF API version ID");
  exactUuid(activeApi.version_id, "active API version ID");
  exactUuid(activeCompute.version_id, "active Compute version ID");
  if (
    offApi.worker !== "ultralight-api" ||
    offApi.version_tag !== expectedOffApiTag ||
    activeApi.worker !== "ultralight-api" ||
    activeApi.version_id !== offApi.version_id ||
    activeApi.version_tag !== expectedOffApiTag ||
    activeApi.enabled !== false ||
    activeApi.rollout_mode !== "canary" ||
    !Array.isArray(activeApi.canary_allowlist) ||
    activeApi.canary_allowlist.length !== 0 ||
    activeCompute.worker !== "galactic-compute" ||
    activeCompute.version_tag !== expectedComputeTag ||
    activeCompute.environment_digest !== release.environment_digest
  ) {
    fail("schema 6 active API/Compute versions do not match the OFF release");
  }

  const releasePolicyBinding = exactObject(
    release.release_policy,
    "release_policy",
  );
  exactKeys(
    releasePolicyBinding,
    ["admission", "artifact", "evidence_file", "sha256"],
    "release_policy",
  );
  if (
    releasePolicyBinding.evidence_file !== "release-policy.json" ||
    typeof releasePolicyBinding.sha256 !== "string" ||
    !HEX_SHA256.test(releasePolicyBinding.sha256) ||
    releasePolicyBinding.artifact !== "deploy_exact_candidate" ||
    releasePolicyBinding.admission !== "preserve_off"
  ) {
    fail("schema 6 release does not bind the preserve_off release policy");
  }
  const releasePolicyPath = resolve(
    evidenceDirectory,
    releasePolicyBinding.evidence_file,
  );
  const releasePolicyBytes = readBytes(
    releasePolicyPath,
    releasePolicyBinding.evidence_file,
  );
  if (hashBytes(releasePolicyBytes) !== releasePolicyBinding.sha256) {
    fail("release policy bytes do not match the release binding");
  }
  const releasePolicy = exactObject(
    readJson(releasePolicyPath, releasePolicyBinding.evidence_file),
    releasePolicyBinding.evidence_file,
  );
  exactKeys(
    releasePolicy,
    ["compute", "release_tag", "schema_version"],
    "release-policy.json",
  );
  exactKeys(
    releasePolicy.compute,
    ["admission", "artifact"],
    "release-policy.json compute policy",
  );
  if (
    releasePolicy.schema_version !== 1 ||
    releasePolicy.release_tag !== releaseTag ||
    releasePolicy.compute.artifact !== "deploy_exact_candidate" ||
    releasePolicy.compute.admission !== "preserve_off"
  ) {
    fail("release-policy.json does not match the exact preserve_off tag");
  }

  const policyBefore = verifyPolicySnapshotBinding({
    evidenceDirectory,
    binding: exactObject(release.policy_before, "policy_before"),
    expectedFile: "pre-rollout-api-version.json",
    label: "pre-rollout policy",
  });
  exactUuid(policyBefore.id, "pre-rollout API version ID");
  const beforeCertificationPrincipal = optionalSelectedPlainTextValue(
    policyBefore,
    "COMPUTE_CERTIFICATION_PRINCIPAL",
    "pre-rollout policy",
  );
  if (
    policyBefore.schema_version !== 1 ||
    policyBefore.worker !== "ultralight-api" ||
    policyBefore.admission_enabled !== false ||
    selectedPlainTextValue(
      policyBefore,
      "COMPUTE_ENABLED",
      "pre-rollout policy",
    ) !== "0" ||
    selectedPlainTextValue(
      policyBefore,
      "COMPUTE_ROLLOUT_MODE",
      "pre-rollout policy",
    ) !== "canary" ||
    selectedPlainTextValue(
      policyBefore,
      "COMPUTE_CANARY_ALLOWLIST",
      "pre-rollout policy",
    ) !== "" ||
    (beforeCertificationPrincipal !== null &&
      beforeCertificationPrincipal !== "") ||
    !SHA256.test(
      selectedPlainTextValue(
        policyBefore,
        "COMPUTE_ENVIRONMENT_DIGEST",
        "pre-rollout policy",
      ),
    )
  ) {
    fail("pre-rollout evidence does not prove admission-OFF canary policy");
  }

  const policyAfter = verifyPolicySnapshotBinding({
    evidenceDirectory,
    binding: exactObject(release.policy_after, "policy_after"),
    expectedFile: "active-preserve-off-api-version.json",
    label: "post-rollout policy",
  });
  exactKeys(
    policyAfter,
    [
      "admission_enabled",
      "canary_allowlist",
      "id",
      "rollout_mode",
      "schema_version",
      "selected_bindings",
      "tag",
      "worker",
    ],
    "active-preserve-off-api-version.json",
  );
  exactUuid(policyAfter.id, "post-rollout API version ID");
  const afterCertificationPrincipal = optionalSelectedPlainTextValue(
    policyAfter,
    "COMPUTE_CERTIFICATION_PRINCIPAL",
    "post-rollout policy",
  );
  if (
    policyAfter.schema_version !== 1 ||
    policyAfter.worker !== "ultralight-api" ||
    policyAfter.id !== activeApi.version_id ||
    policyAfter.tag !== expectedOffApiTag ||
    policyAfter.admission_enabled !== false ||
    policyAfter.rollout_mode !== "canary" ||
    !Array.isArray(policyAfter.canary_allowlist) ||
    policyAfter.canary_allowlist.length !== 0 ||
    selectedPlainTextValue(
      policyAfter,
      "COMPUTE_ENABLED",
      "post-rollout policy",
    ) !== "0" ||
    selectedPlainTextValue(
      policyAfter,
      "COMPUTE_ENVIRONMENT_DIGEST",
      "post-rollout policy",
    ) !== release.environment_digest ||
    selectedPlainTextValue(
      policyAfter,
      "COMPUTE_ROLLOUT_MODE",
      "post-rollout policy",
    ) !== "canary" ||
    selectedPlainTextValue(
      policyAfter,
      "COMPUTE_CANARY_ALLOWLIST",
      "post-rollout policy",
    ) !== "" ||
    (afterCertificationPrincipal !== null &&
      afterCertificationPrincipal !== "")
  ) {
    fail("post-rollout evidence does not prove the exact OFF API version");
  }
  hasExactlyOneSelectedBinding(
    policyAfter,
    (binding) =>
      binding?.type === "service" &&
      binding?.name === "COMPUTE_PLANE" &&
      binding?.service === "galactic-compute" &&
      binding?.entrypoint === "ComputePlane",
    "post-rollout policy",
  );
  hasExactlyOneSelectedBinding(
    policyAfter,
    (binding) =>
      binding?.type === "queue" &&
      binding?.name === "COMPUTE_QUEUE" &&
      binding?.queue_name === "galactic-compute",
    "post-rollout policy",
  );
  hasExactlyOneSelectedBinding(
    policyAfter,
    (binding) =>
      binding?.type === "r2_bucket" &&
      binding?.name === "COMPUTE_ARTIFACTS" &&
      binding?.bucket_name === "galactic-compute-artifacts",
    "post-rollout policy",
  );

  if (
    activeCompute.evidence_file !==
      "active-preserve-off-compute-version.json" ||
    typeof activeCompute.sha256 !== "string" ||
    !HEX_SHA256.test(activeCompute.sha256)
  ) {
    fail("active Compute version is not bound to exact live evidence");
  }
  const computeEvidencePath = resolve(
    evidenceDirectory,
    activeCompute.evidence_file,
  );
  const computeEvidenceBytes = readBytes(
    computeEvidencePath,
    activeCompute.evidence_file,
  );
  if (hashBytes(computeEvidenceBytes) !== activeCompute.sha256) {
    fail("active Compute evidence bytes do not match the release binding");
  }
  const computeEvidence = exactObject(
    readJson(computeEvidencePath, activeCompute.evidence_file),
    activeCompute.evidence_file,
  );
  exactKeys(
    computeEvidence,
    [
      "environment_digest",
      "id",
      "schema_version",
      "selected_bindings",
      "tag",
      "worker",
    ],
    "active-preserve-off-compute-version.json",
  );
  exactUuid(computeEvidence.id, "live Compute evidence version ID");
  if (
    computeEvidence.schema_version !== 1 ||
    computeEvidence.worker !== "galactic-compute" ||
    computeEvidence.id !== activeCompute.version_id ||
    computeEvidence.tag !== expectedComputeTag ||
    computeEvidence.environment_digest !== release.environment_digest ||
    selectedPlainTextValue(
      computeEvidence,
      "COMPUTE_ENVIRONMENT_DIGEST",
      "active Compute evidence",
    ) !== release.environment_digest
  ) {
    fail("active Compute evidence does not prove the exact released version");
  }
  hasExactlyOneSelectedBinding(
    computeEvidence,
    (binding) =>
      binding?.type === "service" &&
      binding?.name === "CONTROL_PLANE" &&
      binding?.service === "ultralight-api" &&
      binding?.entrypoint === "ComputeControlPlane",
    "active Compute evidence",
  );
  hasExactlyOneSelectedBinding(
    computeEvidence,
    (binding) =>
      binding?.type === "r2_bucket" &&
      binding?.name === "COMPUTE_ARTIFACTS" &&
      binding?.bucket_name === "galactic-compute-artifacts",
    "active Compute evidence",
  );

  verifyBindingPreflight({
    evidenceDirectory,
    binding: exactObject(release.binding_preflight, "binding_preflight"),
    candidateSha,
    workflowRunId,
  });
  for (const unexpectedFile of [
    "active-global-api-version.json",
    "compute-admitted-production.json",
    "post-smoke-live-fence.json",
  ]) {
    if (existsSync(resolve(evidenceDirectory, unexpectedFile))) {
      fail(`schema 6 evidence contains forbidden global claim ${unexpectedFile}`);
    }
  }

  return {
    schema_version: 1,
    verified: true,
    environment: "production",
    release_tag: releaseTag,
    candidate_sha: candidateSha,
    compute_release_run_id: workflowRunId,
    admission_mode: "preserve_off",
    environment_digest: release.environment_digest,
    deployed_image: release.deployed_image,
    active_api_version_id: activeApi.version_id,
    active_compute_version_id: activeCompute.version_id,
  };
}

export function verifyProductionComputeReleaseEvidence({
  evidenceDirectory,
  candidateSha,
  releaseTag,
  workflowRunId,
  expectedAdmissionMode,
}) {
  if (!SHA.test(candidateSha)) fail("candidate SHA is malformed");
  if (!RELEASE_TAG.test(releaseTag)) fail("release tag is malformed");
  if (!/^[1-9][0-9]*$/u.test(workflowRunId)) {
    fail("workflow run ID is malformed");
  }
  if (
    expectedAdmissionMode !== "preserve_off" &&
    expectedAdmissionMode !== "enable_global"
  ) {
    fail("expected admission mode must be preserve_off or enable_global");
  }

  const release = exactObject(
    readJson(resolve(evidenceDirectory, "release.json"), "release.json"),
    "release.json",
  );
  if (expectedAdmissionMode === "preserve_off") {
    return verifyPreserveOffEvidence({
      release,
      evidenceDirectory,
      candidateSha,
      releaseTag,
      workflowRunId,
    });
  }

  const expectedApiTag = `api-${candidateSha}`;
  const expectedOffApiTag = `${expectedApiTag}-admission-off`;
  const expectedComputeTag = `compute-${candidateSha}`;
  const expectedSmokeFile = "compute-admitted-production.json";

  if (
    release.schema_version !== 5 ||
    release.environment !== "production" ||
    release.git_sha !== candidateSha ||
    release.git_ref !== `refs/tags/${releaseTag}`
  ) {
    fail("release provenance or schema does not match the exact tag");
  }
  if (
    release.admission_enabled !== true ||
    release.rollout_mode !== "global" ||
    !Array.isArray(release.canary_allowlist) ||
    release.canary_allowlist.length !== 0
  ) {
    fail("release does not certify global admission with an empty allowlist");
  }
  verifyImageIdentity(release);

  const offApi = exactObject(
    release.certified_admission_off_api,
    "certified_admission_off_api",
  );
  const activeApi = exactObject(release.active_api, "active_api");
  const activeCompute = exactObject(
    release.active_compute_worker,
    "active_compute_worker",
  );
  exactUuid(offApi.version_id, "certified OFF API version ID");
  exactUuid(activeApi.version_id, "active API version ID");
  exactUuid(activeCompute.version_id, "active Compute version ID");
  if (
    offApi.version_id === activeApi.version_id ||
    offApi.worker !== "ultralight-api" ||
    offApi.version_tag !== expectedOffApiTag ||
    activeApi.worker !== "ultralight-api" ||
    activeApi.version_tag !== expectedApiTag ||
    activeApi.enabled !== true ||
    activeApi.rollout_mode !== "global" ||
    !Array.isArray(activeApi.canary_allowlist) ||
    activeApi.canary_allowlist.length !== 0 ||
    activeCompute.worker !== "galactic-compute" ||
    activeCompute.version_tag !== expectedComputeTag
  ) {
    fail("certified API/Compute versions do not match the release");
  }

  verifyBindingPreflight({
    evidenceDirectory,
    binding: exactObject(release.binding_preflight, "binding_preflight"),
    candidateSha,
    workflowRunId,
  });

  const admittedSmoke = exactObject(
    release.admitted_smoke,
    "admitted_smoke",
  );
  if (
    admittedSmoke.evidence_file !== expectedSmokeFile ||
    admittedSmoke.verified !== true ||
    typeof admittedSmoke.sha256 !== "string" ||
    !HEX_SHA256.test(admittedSmoke.sha256)
  ) {
    fail("release does not bind the required admitted-job smoke");
  }
  const smokePath = resolve(evidenceDirectory, expectedSmokeFile);
  const smokeBytes = readBytes(smokePath, expectedSmokeFile);
  const smokeSha256 = createHash("sha256").update(smokeBytes).digest("hex");
  if (smokeSha256 !== admittedSmoke.sha256) {
    fail("admitted-job smoke bytes do not match the release binding");
  }
  const smoke = exactObject(
    readJson(smokePath, expectedSmokeFile),
    expectedSmokeFile,
  );
  const result = exactObject(smoke.result, "admitted smoke result");
  const cleanup = exactObject(
    smoke.policy_cleanup,
    "admitted smoke policy cleanup",
  );
  exactUuid(smoke.agent_id, "admitted smoke Agent ID");
  exactUuid(smoke.compute_run_id, "admitted smoke Compute run ID");
  exactUuid(smoke.compute_receipt_id, "admitted smoke receipt ID");
  const expectedMarker =
    `galactic-compute-release-smoke-v1:${candidateSha}:${workflowRunId}\n`;
  const expectedMarkerSha256 = createHash("sha256")
    .update(expectedMarker, "utf8")
    .digest("hex");
  const expectedMarkerBytes = Buffer.byteLength(expectedMarker, "utf8");
  if (
    smoke.schema_version !== 1 ||
    smoke.kind !== "galactic_compute_admitted_smoke" ||
    smoke.verified !== true ||
    smoke.target !== "production" ||
    smoke.candidate_sha !== candidateSha ||
    String(smoke.workflow_run_id) !== workflowRunId ||
    smoke.function_name !== "run_compute_smoke" ||
    typeof smoke.marker_sha256 !== "string" ||
    smoke.marker_sha256 !== expectedMarkerSha256 ||
    !Array.isArray(smoke.observed_states) ||
    !smoke.observed_states.includes("completed") ||
    result.status !== "completed" ||
    result.exit_code !== 0 ||
    typeof result.stdout_sha256 !== "string" ||
    result.stdout_sha256 !== expectedMarkerSha256 ||
    (
      Object.hasOwn(result, "stdout_bytes") &&
      result.stdout_bytes !== expectedMarkerBytes
    ) ||
    result.stderr_bytes !== 0 ||
    result.artifact_count !== 0 ||
    cleanup.disabled !== true
  ) {
    fail("admitted-job smoke did not prove a clean completed execution");
  }

  return {
    schema_version: 1,
    verified: true,
    environment: "production",
    release_tag: releaseTag,
    candidate_sha: candidateSha,
    compute_release_run_id: workflowRunId,
    environment_digest: release.environment_digest,
    deployed_image: release.deployed_image,
    active_api_version_id: activeApi.version_id,
    active_compute_version_id: activeCompute.version_id,
    compute_run_id: smoke.compute_run_id,
    compute_receipt_id: smoke.compute_receipt_id,
  };
}

function main(argv) {
  if (argv.length !== 5) {
    throw new Error(
      "Usage: verify-production-compute-release-evidence.mjs " +
        "<evidence-directory> <candidate-sha> <release-tag> <workflow-run-id> " +
        "<preserve_off|enable_global>",
    );
  }
  const result = verifyProductionComputeReleaseEvidence({
    evidenceDirectory: resolve(argv[0]),
    candidateSha: argv[1],
    releaseTag: argv[2],
    workflowRunId: argv[3],
    expectedAdmissionMode: argv[4],
  });
  console.log(JSON.stringify(result, null, 2));
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
