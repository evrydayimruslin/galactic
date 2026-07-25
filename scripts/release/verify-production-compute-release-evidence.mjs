#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RELEASE_TAG = /^v[0-9A-Za-z][0-9A-Za-z._-]*$/u;

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

export function verifyProductionComputeReleaseEvidence({
  evidenceDirectory,
  candidateSha,
  releaseTag,
  workflowRunId,
}) {
  if (!SHA.test(candidateSha)) fail("candidate SHA is malformed");
  if (!RELEASE_TAG.test(releaseTag)) fail("release tag is malformed");
  if (!/^[1-9][0-9]*$/u.test(workflowRunId)) {
    fail("workflow run ID is malformed");
  }

  const release = exactObject(
    readJson(resolve(evidenceDirectory, "release.json"), "release.json"),
    "release.json",
  );
  const expectedApiTag = `api-${candidateSha}`;
  const expectedOffApiTag = `${expectedApiTag}-admission-off`;
  const expectedComputeTag = `compute-${candidateSha}`;
  const expectedPreflightFile = "compute-preflight-production.json";
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

  const bindingPreflight = exactObject(
    release.binding_preflight,
    "binding_preflight",
  );
  if (
    bindingPreflight.evidence_file !== expectedPreflightFile ||
    bindingPreflight.verified !== true ||
    typeof bindingPreflight.sha256 !== "string" ||
    !HEX_SHA256.test(bindingPreflight.sha256)
  ) {
    fail("release does not bind the required admission-off binding preflight");
  }
  const preflightPath = resolve(evidenceDirectory, expectedPreflightFile);
  const preflightBytes = readBytes(preflightPath, expectedPreflightFile);
  const preflightSha256 = createHash("sha256")
    .update(preflightBytes)
    .digest("hex");
  if (preflightSha256 !== bindingPreflight.sha256) {
    fail("binding preflight bytes do not match the release binding");
  }
  const preflight = exactObject(
    readJson(preflightPath, expectedPreflightFile),
    expectedPreflightFile,
  );
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
    preflight.function_name !== "run_compute_smoke" ||
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
    active_api_version_id: activeApi.version_id,
    active_compute_version_id: activeCompute.version_id,
    compute_run_id: smoke.compute_run_id,
    compute_receipt_id: smoke.compute_receipt_id,
  };
}

function main(argv) {
  if (argv.length !== 4) {
    throw new Error(
      "Usage: verify-production-compute-release-evidence.mjs " +
        "<evidence-directory> <candidate-sha> <release-tag> <workflow-run-id>",
    );
  }
  const result = verifyProductionComputeReleaseEvidence({
    evidenceDirectory: resolve(argv[0]),
    candidateSha: argv[1],
    releaseTag: argv[2],
    workflowRunId: argv[3],
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
