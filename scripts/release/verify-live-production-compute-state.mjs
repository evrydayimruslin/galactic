#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyContainerReadiness } from "../../compute-worker/scripts/verify-container-readiness.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function exactStableVersion(status, expectedId, label) {
  if (
    !status || !Array.isArray(status.versions) ||
    status.versions.length !== 1 ||
    Number(status.versions[0]?.percentage) !== 100 ||
    status.versions[0]?.version_id !== expectedId
  ) {
    fail(`${label} is not the exact stable 100% version`);
  }
}

function bindings(version) {
  const values = version?.resources?.bindings;
  if (!Array.isArray(values)) fail("Worker version bindings are unavailable");
  return values;
}

function plainText(version, name, label) {
  const values = bindings(version)
    .filter((binding) =>
      binding?.type === "plain_text" && binding?.name === name
    )
    .map((binding) => binding.text);
  if (values.length !== 1 || typeof values[0] !== "string") {
    fail(`${label} must contain exactly one ${name} plain-text binding`);
  }
  return values[0];
}

function exactNamedBinding(version, name, predicate, label) {
  const values = bindings(version).filter((binding) => binding?.name === name);
  if (values.length !== 1 || !predicate(values[0])) {
    fail(`${label} must contain exactly one valid ${name} binding`);
  }
}

export function verifyLiveProductionComputeState({
  apiStatus,
  apiVersion,
  computeStatus,
  computeVersion,
  containerList,
  sessionStatus,
  sessionVersion,
  releaseVerification,
  candidateSha,
  admissionMode,
}) {
  if (!SHA.test(candidateSha)) fail("candidate SHA is malformed");
  if (admissionMode !== "preserve_off" && admissionMode !== "enable_global") {
    fail("admission mode is unsupported");
  }
  if (
    releaseVerification?.verified !== true ||
    releaseVerification?.environment !== "production" ||
    releaseVerification?.candidate_sha !== candidateSha ||
    !UUID.test(releaseVerification?.active_api_version_id || "") ||
    !UUID.test(releaseVerification?.active_compute_version_id || "") ||
    !DIGEST.test(releaseVerification?.environment_digest || "") ||
    typeof releaseVerification?.deployed_image !== "string" ||
    !/^registry\.cloudflare\.com\/[0-9a-f]{32}\/galactic-compute@sha256:[0-9a-f]{64}$/u
      .test(releaseVerification.deployed_image) ||
    !releaseVerification.deployed_image.endsWith(
      `@${releaseVerification.environment_digest}`,
    )
  ) {
    fail("release verification does not identify an exact production pair");
  }

  const apiId = releaseVerification.active_api_version_id;
  const computeId = releaseVerification.active_compute_version_id;
  const digest = releaseVerification.environment_digest;
  const container = verifyContainerReadiness(
    containerList,
    "galactic-compute-computestandard",
    releaseVerification.deployed_image,
  );
  exactStableVersion(apiStatus, apiId, "API");
  exactStableVersion(computeStatus, computeId, "Compute Worker");
  const sessionId = sessionStatus?.versions?.[0]?.version_id;
  if (!UUID.test(sessionId || "")) {
    fail("gx.test session Worker does not identify one valid version");
  }
  exactStableVersion(
    sessionStatus,
    sessionId,
    "gx.test session Worker",
  );

  const expectedApiTag = admissionMode === "preserve_off"
    ? `api-${candidateSha}-admission-off`
    : `api-${candidateSha}`;
  const expectedComputeTag = `compute-${candidateSha}`;
  const expectedSessionTag = `gx-test-session-${candidateSha}`;
  if (
    apiVersion?.id !== apiId ||
    apiVersion?.annotations?.["workers/tag"] !== expectedApiTag
  ) {
    fail("live API version identity does not match release evidence");
  }
  if (
    computeVersion?.id !== computeId ||
    computeVersion?.annotations?.["workers/tag"] !== expectedComputeTag
  ) {
    fail("live Compute version identity does not match release evidence");
  }
  if (
    sessionVersion?.id !== sessionId ||
    sessionVersion?.annotations?.["workers/tag"] !== expectedSessionTag
  ) {
    fail("live gx.test session Worker identity does not match the candidate");
  }

  const expectedEnabled = admissionMode === "preserve_off" ? "0" : "1";
  const expectedRollout = admissionMode === "preserve_off"
    ? "canary"
    : "global";
  if (
    plainText(apiVersion, "COMPUTE_ENABLED", "API") !== expectedEnabled ||
    plainText(apiVersion, "COMPUTE_ENVIRONMENT_DIGEST", "API") !== digest ||
    plainText(apiVersion, "COMPUTE_ROLLOUT_MODE", "API") !==
      expectedRollout ||
    plainText(apiVersion, "COMPUTE_CANARY_ALLOWLIST", "API") !== ""
  ) {
    fail("live API Compute policy does not match release evidence");
  }
  exactNamedBinding(
    apiVersion,
    "COMPUTE_PLANE",
    (binding) =>
      binding?.type === "service" &&
      binding?.service === "galactic-compute" &&
      binding?.entrypoint === "ComputePlane",
    "API",
  );
  exactNamedBinding(
    apiVersion,
    "COMPUTE_QUEUE",
    (binding) =>
      binding?.type === "queue" &&
      binding?.queue_name === "galactic-compute",
    "API",
  );
  exactNamedBinding(
    apiVersion,
    "COMPUTE_ARTIFACTS",
    (binding) =>
      binding?.type === "r2_bucket" &&
      binding?.bucket_name === "galactic-compute-artifacts",
    "API",
  );
  exactNamedBinding(
    apiVersion,
    "GX_TEST_SESSION",
    (binding) =>
      binding?.type === "durable_object_namespace" &&
      binding?.class_name === "GxTestSession" &&
      binding?.script_name === "galactic-gx-test-session",
    "API",
  );

  if (
    plainText(
      computeVersion,
      "COMPUTE_ENVIRONMENT_DIGEST",
      "Compute Worker",
    ) !== digest
  ) {
    fail("live Compute digest does not match release evidence");
  }
  exactNamedBinding(
    computeVersion,
    "CONTROL_PLANE",
    (binding) =>
      binding?.type === "service" &&
      binding?.service === "ultralight-api" &&
      binding?.entrypoint === "ComputeControlPlane",
    "Compute Worker",
  );
  exactNamedBinding(
    computeVersion,
    "COMPUTE_ARTIFACTS",
    (binding) =>
      binding?.type === "r2_bucket" &&
      binding?.bucket_name === "galactic-compute-artifacts",
    "Compute Worker",
  );

  return {
    schema_version: 1,
    verified: true,
    candidate_sha: candidateSha,
    admission_mode: admissionMode,
    environment_digest: digest,
    deployed_image: releaseVerification.deployed_image,
    active_api_version_id: apiId,
    active_compute_version_id: computeId,
    active_gx_test_session_version_id: sessionId,
    active_container_application_id: container.id,
    active_container_application_version: container.version,
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    fail(`${label} is unreadable: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

function main(argv) {
  if (argv.length !== 10) {
    fail(
      "Usage: verify-live-production-compute-state.mjs " +
        "<api-status> <api-version> <compute-status> <compute-version> " +
        "<container-list> <session-status> <session-version> <release-verification> " +
        "<candidate-sha> <preserve_off|enable_global>",
    );
  }
  const result = verifyLiveProductionComputeState({
    apiStatus: readJson(argv[0], "API status"),
    apiVersion: readJson(argv[1], "API version"),
    computeStatus: readJson(argv[2], "Compute status"),
    computeVersion: readJson(argv[3], "Compute version"),
    containerList: readJson(argv[4], "Container application list"),
    sessionStatus: readJson(argv[5], "gx.test session Worker status"),
    sessionVersion: readJson(argv[6], "gx.test session Worker version"),
    releaseVerification: readJson(argv[7], "release verification"),
    candidateSha: argv[8],
    admissionMode: argv[9],
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
