#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const CANARY_ENTRY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const TARGETS = {
  production: {
    computeWorker: "galactic-compute",
    computeQueue: "galactic-compute",
    artifactBucket: "galactic-compute-artifacts",
    sessionWorker: "galactic-gx-test-session",
  },
  staging: {
    computeWorker: "galactic-compute-staging",
    computeQueue: "galactic-compute-staging",
    artifactBucket: "galactic-compute-artifacts-staging",
    sessionWorker: "galactic-gx-test-session-staging",
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

function optionalPlainValue(version, name) {
  const values = namedBindings(version, name);
  if (values.length === 0) return "";
  if (
    values.length !== 1 || values[0]?.type !== "plain_text" ||
    typeof values[0]?.text !== "string"
  ) {
    fail(`expected at most one ${name} plain-text binding`);
  }
  return values[0].text;
}

function computePolicy(version) {
  const enabled = plainValue(version, "COMPUTE_ENABLED");
  const environmentDigest = plainValue(
    version,
    "COMPUTE_ENVIRONMENT_DIGEST",
  );
  const rolloutMode = plainValue(version, "COMPUTE_ROLLOUT_MODE");
  const canaryAllowlist = plainValue(version, "COMPUTE_CANARY_ALLOWLIST");
  const certificationPrincipal = optionalPlainValue(
    version,
    "COMPUTE_CERTIFICATION_PRINCIPAL",
  );

  if (!["0", "1"].includes(enabled)) {
    fail("Compute admission flag is not canonical");
  }
  if (!DIGEST.test(environmentDigest) || environmentDigest === ZERO_DIGEST) {
    fail("bound Compute environment digest is malformed or zero");
  }

  if (enabled === "0") {
    if (
      rolloutMode !== "canary" || canaryAllowlist !== "" ||
      certificationPrincipal !== ""
    ) {
      fail("disabled Compute policy must have empty admission and certification scope");
    }
  } else if (rolloutMode === "global") {
    if (canaryAllowlist !== "" || !CANARY_ENTRY.test(certificationPrincipal)) {
      fail("global Compute policy must bind one certification principal");
    }
  } else if (rolloutMode === "canary") {
    const entries = canaryAllowlist.split(",");
    if (
      entries.length < 1 ||
      entries.length > 50 ||
      entries.some((entry) => !CANARY_ENTRY.test(entry)) ||
      new Set(entries).size !== entries.length
    ) {
      fail("enabled canary Compute policy has a malformed allowlist");
    }
    if (
      entries.length !== 1 || certificationPrincipal !== entries[0]
    ) {
      fail("enabled canary Compute policy must bind its certification principal");
    }
  } else {
    fail("enabled Compute rollout mode is not canonical");
  }

  return {
    enabled,
    environmentDigest,
    rolloutMode,
    canaryAllowlist,
    certificationPrincipal,
  };
}

function verifyPreservedPolicy(actual, expected) {
  if (
    expected === null ||
    typeof expected !== "object" ||
    Array.isArray(expected)
  ) {
    fail("expected preserved Compute policy is malformed");
  }
  const keys = [
    "enabled",
    "environmentDigest",
    "rolloutMode",
    "canaryAllowlist",
    "certificationPrincipal",
  ];
  if (
    Object.keys(expected).length !== keys.length ||
    keys.some((key) => typeof expected[key] !== "string") ||
    keys.some((key) => expected[key] !== actual[key])
  ) {
    fail("deployed Compute policy does not exactly preserve the live state");
  }
}

function verifyCandidateSessionContract(version, targetState) {
  const sessionBindings = exactBindings(
    version,
    "GX_TEST_SESSION",
    "durable_object_namespace",
  );
  if (
    sessionBindings[0].class_name !== "GxTestSession" ||
    sessionBindings[0].script_name !== targetState.sessionWorker
  ) {
    fail("gx.test session binding does not match the dedicated Worker");
  }

  const sessionExport =
    version?.resources?.script_runtime?.exports?.GxTestSession;
  if (
    sessionExport === null ||
    typeof sessionExport !== "object" ||
    Array.isArray(sessionExport) ||
    sessionExport.type !== "durable-object" ||
    sessionExport.storage !== "sqlite" ||
    ![undefined, "created"].includes(sessionExport.state)
  ) {
    fail("candidate API does not retain its dormant SQLite gx.test export");
  }
}

export function verifyApiComputeDeployState({
  mode,
  target,
  status,
  version,
  expectedTag = null,
  expectedState = null,
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

  if (mode === "bootstrap" || expectedTag !== null) {
    if (
      typeof expectedTag !== "string" ||
      !/^api-[0-9a-f]{40}$/u.test(expectedTag)
    ) {
      fail("expected release tag is invalid");
    }
    if (version?.annotations?.["workers/tag"] !== expectedTag) {
      fail("deployed version tag does not match the release SHA");
    }
    verifyCandidateSessionContract(version, targetState);
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
    if (plainValue(version, "COMPUTE_ENABLED") !== "0") {
      fail("Compute admission is not disabled");
    }
    if (plainValue(version, "COMPUTE_ROLLOUT_MODE") !== "canary") {
      fail("Compute rollout mode is not canary");
    }
    if (plainValue(version, "COMPUTE_CANARY_ALLOWLIST") !== "") {
      fail("Compute canary allowlist is not empty");
    }
    if (optionalPlainValue(version, "COMPUTE_CERTIFICATION_PRINCIPAL") !== "") {
      fail("Compute certification principal is not empty");
    }
    if (planes.length !== 0) {
      fail("bootstrap API unexpectedly has a Compute Plane binding");
    }
    if (digest !== ZERO_DIGEST) {
      fail("bootstrap API does not use the zero environment digest");
    }
    return { versionId };
  }

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

  const computeState = computePolicy(version);
  if (expectedState !== null) {
    verifyPreservedPolicy(computeState, expectedState);
  }
  return { versionId, computeState };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function main(argv) {
  if (argv.length < 4 || argv.length > 7) {
    throw new Error(
      "Usage: verify-api-compute-deploy-state.mjs " +
        "<pre-bootstrap|bootstrap|bound> <production|staging> " +
        "<status-json> <version-json> [expected-tag|-] " +
        "[expected-state-json|-] [write-state-json]",
    );
  }
  const expectedState = argv[5] && argv[5] !== "-"
    ? readJson(argv[5], "Expected preserved Compute policy")
    : null;
  const result = verifyApiComputeDeployState({
    mode: argv[0],
    target: argv[1],
    status: readJson(argv[2], "Deployment status"),
    version: readJson(argv[3], "Version detail"),
    expectedTag: argv[4] && argv[4] !== "-" ? argv[4] : null,
    expectedState,
  });
  if (argv[6]) {
    if (!result.computeState) {
      throw new Error("Only a bound API has a preservable Compute policy.");
    }
    writeFileSync(
      resolve(argv[6]),
      `${JSON.stringify(result.computeState, null, 2)}\n`,
      "utf8",
    );
  }
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
