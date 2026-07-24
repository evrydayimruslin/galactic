#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

const TARGETS = {
  production: {
    computeWorker: "galactic-compute",
    computeQueue: "galactic-compute",
    artifactBucket: "galactic-compute-artifacts",
  },
  staging: {
    computeWorker: "galactic-compute-staging",
    computeQueue: "galactic-compute-staging",
    artifactBucket: "galactic-compute-artifacts-staging",
  },
};

function fail(message) {
  throw new Error(`API Compute deployment state is invalid: ${message}`);
}

function stableVersionId(status) {
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  if (
    versions.length !== 1 ||
    Number(versions[0]?.percentage) !== 100 ||
    typeof versions[0]?.version_id !== "string" ||
    !UUID.test(versions[0].version_id)
  ) {
    fail("expected exactly one stable 100% version");
  }
  return versions[0].version_id.toLowerCase();
}

function namedBindings(version, name) {
  return Array.isArray(version?.resources?.bindings)
    ? version.resources.bindings.filter((binding) => binding?.name === name)
    : [];
}

function exactBindings(version, name, type, expectedCount = 1) {
  const values = namedBindings(version, name);
  if (
    values.length !== expectedCount ||
    values.some((binding) => binding?.type !== type)
  ) {
    fail(
      `expected exactly ${expectedCount} ${name} ${type} binding` +
        `${expectedCount === 1 ? "" : "s"}`,
    );
  }
  return values;
}

function plainValue(version, name) {
  const values = exactBindings(version, name, "plain_text");
  if (typeof values[0].text !== "string") {
    fail(`expected exactly one ${name} plain-text binding`);
  }
  return values[0].text;
}

export function verifyApiComputeDeployState({
  mode,
  target,
  status,
  version,
  expectedTag = null,
}) {
  if (!["pre-bootstrap", "bootstrap", "bound"].includes(mode)) {
    fail(`unsupported mode ${String(mode)}`);
  }
  const targetState = TARGETS[target];
  if (!targetState) fail(`unsupported target ${String(target)}`);

  const versionId = stableVersionId(status);
  if (
    typeof version?.id !== "string" ||
    version.id.toLowerCase() !== versionId
  ) {
    fail("version detail does not match the stable deployment");
  }

  const planes = namedBindings(version, "COMPUTE_PLANE");
  const enabled = namedBindings(version, "COMPUTE_ENABLED");
  if (mode === "pre-bootstrap") {
    if (planes.length !== 0) {
      fail("pre-bootstrap API unexpectedly has a Compute Plane binding");
    }
    if (
      enabled.length > 1 ||
      (
        enabled.length === 1 &&
        (enabled[0]?.type !== "plain_text" || enabled[0]?.text !== "0")
      )
    ) {
      fail("pre-bootstrap API admission is enabled");
    }
    return { versionId };
  }

  if (
    typeof expectedTag !== "string" ||
    !/^api-[0-9a-f]{40}$/u.test(expectedTag)
  ) {
    fail("expected release tag is invalid");
  }
  if (version?.annotations?.["workers/tag"] !== expectedTag) {
    fail("deployed version tag does not match the release SHA");
  }
  if (plainValue(version, "COMPUTE_ENABLED") !== "0") {
    fail("Compute admission is not disabled");
  }
  if (plainValue(version, "COMPUTE_ROLLOUT_MODE") !== "canary") {
    fail("Compute rollout mode is not canary");
  }
  if (plainValue(version, "COMPUTE_CANARY_ALLOWLIST") !== "") {
    fail("Compute canary allowlist is not empty");
  }

  const digest = plainValue(version, "COMPUTE_ENVIRONMENT_DIGEST");
  if (!DIGEST.test(digest)) {
    fail("Compute environment digest is malformed");
  }

  const queues = exactBindings(version, "COMPUTE_QUEUE", "queue");
  if (queues[0].queue_name !== targetState.computeQueue) {
    fail("Compute Queue binding does not match the reviewed target");
  }
  const artifacts = exactBindings(
    version,
    "COMPUTE_ARTIFACTS",
    "r2_bucket",
  );
  if (artifacts[0].bucket_name !== targetState.artifactBucket) {
    fail("Compute artifact binding does not match the reviewed target");
  }

  if (mode === "bootstrap") {
    if (planes.length !== 0) {
      fail("bootstrap API unexpectedly has a Compute Plane binding");
    }
    if (digest !== ZERO_DIGEST) {
      fail("bootstrap API does not use the zero environment digest");
    }
  } else {
    const servicePlanes = exactBindings(
      version,
      "COMPUTE_PLANE",
      "service",
    );
    if (
      servicePlanes[0].service !== targetState.computeWorker ||
      servicePlanes[0].entrypoint !== "ComputePlane"
    ) {
      fail("Compute Plane binding does not match the reviewed target");
    }
  }

  return { versionId };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function main(argv) {
  if (argv.length < 4 || argv.length > 5) {
    throw new Error(
      "Usage: verify-api-compute-deploy-state.mjs " +
        "<pre-bootstrap|bootstrap|bound> <production|staging> " +
        "<status-json> <version-json> [expected-tag]",
    );
  }
  const result = verifyApiComputeDeployState({
    mode: argv[0],
    target: argv[1],
    status: readJson(argv[2], "Deployment status"),
    version: readJson(argv[3], "Version detail"),
    expectedTag: argv[4] ?? null,
  });
  console.log(result.versionId);
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
