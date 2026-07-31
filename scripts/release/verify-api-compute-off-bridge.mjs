#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const CURRENT_SOURCE_TAG = /^api-[0-9a-f]{40}$/u;

const TARGETS = {
  production: {
    apiWorker: "ultralight-api",
    computeWorker: "galactic-compute",
    computeQueue: "galactic-compute",
    artifactBucket: "galactic-compute-artifacts",
    sessionWorker: "galactic-gx-test-session",
  },
  staging: {
    apiWorker: "ultralight-api-staging",
    computeWorker: "galactic-compute-staging",
    computeQueue: "galactic-compute-staging",
    artifactBucket: "galactic-compute-artifacts-staging",
    sessionWorker: "galactic-gx-test-session-staging",
  },
};

function fail(message) {
  throw new Error(`API Compute OFF bridge state is invalid: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function verifyWranglerVersionUploadOutput({
  content,
  expectedWorker,
  expectedEnvironment,
}) {
  if (
    typeof content !== "string" ||
    typeof expectedWorker !== "string" ||
    expectedWorker.length === 0 ||
    typeof expectedEnvironment !== "string" ||
    expectedEnvironment.length === 0
  ) {
    fail("Wrangler version-upload output arguments are malformed");
  }

  const lines = content.split(/\r?\n/u).filter((line) =>
    line.trim().length > 0
  );
  let records;
  try {
    records = lines.map((line) => JSON.parse(line));
  } catch (error) {
    fail(`Wrangler version-upload output is not valid NDJSON: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }

  if (
    records.length !== 2 ||
    !isRecord(records[0]) ||
    !isRecord(records[1])
  ) {
    fail(
      "Wrangler must emit exactly one session record and one version-upload record",
    );
  }
  const [session, upload] = records;
  if (
    session.type !== "wrangler-session" ||
    session.version !== 1 ||
    typeof session.wrangler_version !== "string" ||
    session.wrangler_version.length === 0 ||
    !Array.isArray(session.command_line_args) ||
    !session.command_line_args.every((value) => typeof value === "string") ||
    session.command_line_args[0] !== "versions" ||
    session.command_line_args[1] !== "upload" ||
    typeof session.timestamp !== "string" ||
    !Number.isFinite(Date.parse(session.timestamp))
  ) {
    fail("Wrangler session record does not describe versions upload");
  }
  if (
    upload.type !== "version-upload" ||
    upload.version !== 1 ||
    upload.worker_name !== expectedWorker ||
    upload.wrangler_environment !== expectedEnvironment ||
    upload.worker_name_overridden !== false ||
    typeof upload.version_id !== "string" ||
    !UUID.test(upload.version_id) ||
    typeof upload.timestamp !== "string" ||
    !Number.isFinite(Date.parse(upload.timestamp))
  ) {
    fail("Wrangler version-upload record does not match the reviewed command");
  }
  return upload.version_id;
}

function targetState(target) {
  const state = TARGETS[target];
  if (!state) fail(`unsupported target ${String(target)}`);
  return state;
}

function stableVersionId(status, label) {
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  const percentage = versions.length === 1
    ? Number(versions[0]?.percentage)
    : Number.NaN;
  const versionId = versions[0]?.version_id;
  if (
    versions.length !== 1 ||
    !Number.isFinite(percentage) ||
    percentage !== 100 ||
    typeof versionId !== "string" ||
    !UUID.test(versionId)
  ) {
    fail(
      `${label} deployment must contain exactly one valid version at 100% traffic`,
    );
  }
  return versionId;
}

function versionTag(version, label) {
  const tag = version?.annotations?.["workers/tag"];
  if (tag === undefined) return null;
  if (typeof tag !== "string" || tag.length === 0) {
    fail(`${label} version tag is malformed`);
  }
  return tag;
}

function verifyVersionIdentity(version, expectedId, label, expectedTag = null) {
  if (!isRecord(version) || version.id !== expectedId) {
    fail(`${label} version detail does not match version ${expectedId}`);
  }
  const actualTag = versionTag(version, label);
  if (expectedTag !== null && actualTag !== expectedTag) {
    fail(`${label} version tag does not match ${expectedTag}`);
  }
  return actualTag;
}

function bindingList(version, label) {
  const values = version?.resources?.bindings;
  if (!Array.isArray(values)) fail(`${label} bindings are unavailable`);
  return values;
}

function exactBinding(version, name, type, label) {
  const values = bindingList(version, label).filter(
    (binding) => binding?.name === name,
  );
  if (values.length !== 1 || values[0]?.type !== type) {
    fail(`${label} must contain exactly one ${name} ${type} binding`);
  }
  return values[0];
}

function plainValue(version, name, label) {
  const binding = exactBinding(version, name, "plain_text", label);
  if (typeof binding.text !== "string") {
    fail(`${label} ${name} plain-text value is unavailable`);
  }
  return binding.text;
}

function validDigest(value, label) {
  if (!DIGEST.test(value) || value === ZERO_DIGEST) {
    fail(`${label} must be a nonzero sha256 digest`);
  }
  return value;
}

function apiPolicy(version, label) {
  const enabled = plainValue(version, "COMPUTE_ENABLED", label);
  const environmentDigest = validDigest(
    plainValue(version, "COMPUTE_ENVIRONMENT_DIGEST", label),
    `${label} Compute environment digest`,
  );
  const rolloutMode = plainValue(version, "COMPUTE_ROLLOUT_MODE", label);
  const canaryAllowlist = plainValue(
    version,
    "COMPUTE_CANARY_ALLOWLIST",
    label,
  );

  if (
    enabled === "1" &&
    rolloutMode === "global" &&
    canaryAllowlist === ""
  ) {
    return {
      mode: "global",
      enabled,
      rollout_mode: rolloutMode,
      canary_allowlist: canaryAllowlist,
      environment_digest: environmentDigest,
    };
  }
  if (
    enabled === "0" &&
    rolloutMode === "canary" &&
    canaryAllowlist === ""
  ) {
    return {
      mode: "off",
      enabled,
      rollout_mode: rolloutMode,
      canary_allowlist: canaryAllowlist,
      environment_digest: environmentDigest,
    };
  }
  fail(
    `${label} policy must be exactly global (1/global/empty) or OFF (0/canary/empty)`,
  );
}

function secretTextBindingNames(version, label) {
  const names = bindingList(version, label)
    .filter((binding) => binding?.type === "secret_text")
    .map((binding) => binding?.name);
  if (
    names.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(names).size !== names.length
  ) {
    fail(`${label} secret_text binding names must be nonempty and unique`);
  }
  return names.toSorted();
}

function gxTestSessionExport(version, label) {
  const sessionExport =
    version?.resources?.script_runtime?.exports?.GxTestSession;
  if (
    !isRecord(sessionExport) ||
    sessionExport.type !== "durable-object" ||
    sessionExport.storage !== "sqlite" ||
    ![undefined, "created"].includes(sessionExport.state) ||
    sessionExport.container !== undefined ||
    sessionExport.limits !== undefined ||
    sessionExport.transfer_from !== undefined ||
    sessionExport.renamed_from !== undefined ||
    sessionExport.renamed_to !== undefined ||
    sessionExport.transferred_to !== undefined
  ) {
    fail(
      `${label} must retain a source-owned GxTestSession durable-object SQLite export`,
    );
  }
  return {
    type: "durable-object",
    storage: "sqlite",
    state: "created",
  };
}

function apiCompatibility(version, target, label) {
  const state = targetState(target);
  const plane = exactBinding(version, "COMPUTE_PLANE", "service", label);
  if (
    plane.service !== state.computeWorker ||
    plane.entrypoint !== "ComputePlane"
  ) {
    fail(`${label} COMPUTE_PLANE binding does not match the reviewed target`);
  }

  const queue = exactBinding(version, "COMPUTE_QUEUE", "queue", label);
  if (queue.queue_name !== state.computeQueue) {
    fail(`${label} COMPUTE_QUEUE binding does not match the reviewed target`);
  }

  const artifacts = exactBinding(
    version,
    "COMPUTE_ARTIFACTS",
    "r2_bucket",
    label,
  );
  if (artifacts.bucket_name !== state.artifactBucket) {
    fail(
      `${label} COMPUTE_ARTIFACTS binding does not match the reviewed target`,
    );
  }

  const session = exactBinding(
    version,
    "GX_TEST_SESSION",
    "durable_object_namespace",
    label,
  );
  if (
    session.class_name !== "GxTestSession" ||
    session.script_name !== state.sessionWorker
  ) {
    fail(`${label} GX_TEST_SESSION binding does not match the reviewed target`);
  }

  return {
    compute_plane: {
      service: plane.service,
      entrypoint: plane.entrypoint,
    },
    compute_queue: { queue_name: queue.queue_name },
    compute_artifacts: { bucket_name: artifacts.bucket_name },
    gx_test_session: {
      class_name: session.class_name,
      script_name: session.script_name,
    },
    gx_test_session_export: gxTestSessionExport(version, label),
  };
}

function computeCompatibility(version, target, label) {
  const state = targetState(target);
  const controlPlane = exactBinding(
    version,
    "CONTROL_PLANE",
    "service",
    label,
  );
  if (
    controlPlane.service !== state.apiWorker ||
    controlPlane.entrypoint !== "ComputeControlPlane"
  ) {
    fail(`${label} CONTROL_PLANE binding does not match the reviewed target`);
  }
  const artifacts = exactBinding(
    version,
    "COMPUTE_ARTIFACTS",
    "r2_bucket",
    label,
  );
  if (artifacts.bucket_name !== state.artifactBucket) {
    fail(
      `${label} COMPUTE_ARTIFACTS binding does not match the reviewed target`,
    );
  }
  return {
    control_plane: {
      service: controlPlane.service,
      entrypoint: controlPlane.entrypoint,
    },
    compute_artifacts: { bucket_name: artifacts.bucket_name },
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedApiCompatibility(target) {
  const state = targetState(target);
  return {
    compute_plane: {
      service: state.computeWorker,
      entrypoint: "ComputePlane",
    },
    compute_queue: { queue_name: state.computeQueue },
    compute_artifacts: { bucket_name: state.artifactBucket },
    gx_test_session: {
      class_name: "GxTestSession",
      script_name: state.sessionWorker,
    },
    gx_test_session_export: {
      type: "durable-object",
      storage: "sqlite",
      state: "created",
    },
  };
}

function expectedComputeCompatibility(target) {
  const state = targetState(target);
  return {
    control_plane: {
      service: state.apiWorker,
      entrypoint: "ComputeControlPlane",
    },
    compute_artifacts: { bucket_name: state.artifactBucket },
  };
}

function validatedSecretNameSnapshot(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(value).size !== value.length ||
    !sameJson(value, value.toSorted())
  ) {
    fail(`${label} secret_text binding snapshot is malformed`);
  }
  return value;
}

function validateCompatibilityState(state, target, allowedPhases) {
  if (
    !isRecord(state) ||
    state.schema_version !== 1 ||
    state.verified !== true ||
    !allowedPhases.includes(state.phase) ||
    state.target !== target ||
    !["global", "off"].includes(state.policy) ||
    !isRecord(state.api) ||
    !isRecord(state.compute) ||
    !UUID.test(state.api.version_id || "") ||
    !UUID.test(state.compute.version_id || "") ||
    !validDigest(state.environment_digest, "state environment digest") ||
    !CURRENT_SOURCE_TAG.test(
      state.phase === "current" ? state.api.version_tag || "" :
        state.prior_api_version_tag || "",
    )
  ) {
    fail("compatibility state is malformed");
  }
  if (
    !sameJson(state.api.compatibility, expectedApiCompatibility(target)) ||
    !sameJson(
      state.compute.compatibility,
      expectedComputeCompatibility(target),
    )
  ) {
    fail("compatibility state binding/export snapshot is malformed");
  }
  validatedSecretNameSnapshot(
    state.api.secret_text_binding_names,
    "compatibility state API",
  );
  if (
    state.api.version_tag !== null &&
    (typeof state.api.version_tag !== "string" || state.api.version_tag === "")
  ) {
    fail("compatibility state API version tag is malformed");
  }
  if (
    state.compute.version_tag !== null &&
    (
      typeof state.compute.version_tag !== "string" ||
      state.compute.version_tag === ""
    )
  ) {
    fail("compatibility state Compute version tag is malformed");
  }
  return state;
}

function baseResult({
  phase,
  target,
  policy,
  environmentDigest,
  apiId,
  apiTag,
  apiCompatibilitySnapshot,
  secretNames,
  computeId,
  computeTag,
  computeCompatibilitySnapshot,
  priorApiId,
  priorApiTag,
}) {
  const result = {
    schema_version: 1,
    verified: true,
    phase,
    target,
    policy,
    environment_digest: environmentDigest,
    api: {
      version_id: apiId,
      version_tag: apiTag,
      compatibility: apiCompatibilitySnapshot,
      secret_text_binding_names: secretNames,
    },
    compute: {
      version_id: computeId,
      version_tag: computeTag,
      compatibility: computeCompatibilitySnapshot,
    },
  };
  if (priorApiId !== undefined) result.prior_api_version_id = priorApiId;
  if (priorApiTag !== undefined) result.prior_api_version_tag = priorApiTag;
  return result;
}

export function verifyCurrentPair({
  target,
  expectedApiTag,
  apiStatus,
  apiVersion,
  computeStatus,
  computeVersion,
}) {
  targetState(target);
  if (
    typeof expectedApiTag !== "string" ||
    !CURRENT_SOURCE_TAG.test(expectedApiTag)
  ) {
    fail("expected current API source tag must be api-<40 lowercase hex SHA>");
  }

  const apiId = stableVersionId(apiStatus, "API");
  const computeId = stableVersionId(computeStatus, "Compute");
  const apiTag = verifyVersionIdentity(
    apiVersion,
    apiId,
    "current API",
    expectedApiTag,
  );
  const computeTag = verifyVersionIdentity(
    computeVersion,
    computeId,
    "current Compute",
  );
  const policy = apiPolicy(apiVersion, "current API");
  const computeDigest = validDigest(
    plainValue(
      computeVersion,
      "COMPUTE_ENVIRONMENT_DIGEST",
      "current Compute",
    ),
    "current Compute environment digest",
  );
  if (policy.environment_digest !== computeDigest) {
    fail("current API and Compute environment digests do not match");
  }

  return baseResult({
    phase: "current",
    target,
    policy: policy.mode,
    environmentDigest: computeDigest,
    apiId,
    apiTag,
    apiCompatibilitySnapshot: apiCompatibility(
      apiVersion,
      target,
      "current API",
    ),
    secretNames: secretTextBindingNames(apiVersion, "current API"),
    computeId,
    computeTag,
    computeCompatibilitySnapshot: computeCompatibility(
      computeVersion,
      target,
      "current Compute",
    ),
  });
}

export function verifyUploadedBridge({
  target,
  currentState,
  uploadedVersion,
  expectedVersionId,
  expectedVersionTag,
}) {
  const current = validateCompatibilityState(
    currentState,
    target,
    ["current"],
  );
  if (current.policy !== "global") {
    fail("an uploaded OFF bridge may only be derived from a global current API");
  }
  if (
    typeof expectedVersionId !== "string" ||
    !UUID.test(expectedVersionId)
  ) {
    fail("expected uploaded API version ID is malformed");
  }
  if (
    typeof expectedVersionTag !== "string" ||
    expectedVersionTag.length === 0
  ) {
    fail("expected uploaded API version tag is malformed");
  }
  const uploadedTag = verifyVersionIdentity(
    uploadedVersion,
    expectedVersionId,
    "uploaded API",
    expectedVersionTag,
  );
  const policy = apiPolicy(uploadedVersion, "uploaded API");
  if (policy.mode !== "off") {
    fail("uploaded API policy is not OFF");
  }
  if (policy.environment_digest !== current.environment_digest) {
    fail("uploaded API Compute digest does not match the current pair");
  }
  const compatibility = apiCompatibility(
    uploadedVersion,
    target,
    "uploaded API",
  );
  if (!sameJson(compatibility, current.api.compatibility)) {
    fail("uploaded API bindings/export do not match the current API");
  }
  const secretNames = secretTextBindingNames(uploadedVersion, "uploaded API");
  if (!sameJson(secretNames, current.api.secret_text_binding_names)) {
    fail(
      "uploaded API secret_text binding names do not exactly match the current API",
    );
  }

  return baseResult({
    phase: "uploaded",
    target,
    policy: "off",
    environmentDigest: current.environment_digest,
    apiId: expectedVersionId,
    apiTag: uploadedTag,
    apiCompatibilitySnapshot: compatibility,
    secretNames,
    computeId: current.compute.version_id,
    computeTag: current.compute.version_tag,
    computeCompatibilitySnapshot: current.compute.compatibility,
    priorApiId: current.api.version_id,
    priorApiTag: current.api.version_tag,
  });
}

export function verifyPromotedBridge({
  target,
  bridgeState,
  apiStatus,
  apiVersion,
  computeStatus,
  computeVersion,
}) {
  const bridge = validateCompatibilityState(
    bridgeState,
    target,
    ["current", "uploaded"],
  );
  if (bridge.policy !== "off") {
    fail("promoted bridge state is not admission-OFF");
  }

  const apiId = stableVersionId(apiStatus, "promoted API");
  if (apiId !== bridge.api.version_id) {
    fail(
      "promoted API deployment does not contain the exact validated OFF bridge",
    );
  }
  const computeId = stableVersionId(computeStatus, "post-promotion Compute");
  if (computeId !== bridge.compute.version_id) {
    fail("Compute deployment changed during OFF bridge promotion");
  }
  verifyVersionIdentity(
    apiVersion,
    bridge.api.version_id,
    "promoted API",
    bridge.api.version_tag,
  );
  const computeTag = verifyVersionIdentity(
    computeVersion,
    bridge.compute.version_id,
    "post-promotion Compute",
  );
  if (computeTag !== bridge.compute.version_tag) {
    fail("Compute version tag changed during OFF bridge promotion");
  }

  const policy = apiPolicy(apiVersion, "promoted API");
  if (
    policy.mode !== "off" ||
    policy.environment_digest !== bridge.environment_digest
  ) {
    fail("promoted API does not retain the validated OFF policy and digest");
  }
  const apiCompatibilitySnapshot = apiCompatibility(
    apiVersion,
    target,
    "promoted API",
  );
  const secretNames = secretTextBindingNames(apiVersion, "promoted API");
  if (
    !sameJson(apiCompatibilitySnapshot, bridge.api.compatibility) ||
    !sameJson(secretNames, bridge.api.secret_text_binding_names)
  ) {
    fail("promoted API does not exactly match the validated OFF bridge");
  }

  const computeDigest = validDigest(
    plainValue(
      computeVersion,
      "COMPUTE_ENVIRONMENT_DIGEST",
      "post-promotion Compute",
    ),
    "post-promotion Compute environment digest",
  );
  const computeCompatibilitySnapshot = computeCompatibility(
    computeVersion,
    target,
    "post-promotion Compute",
  );
  if (
    computeDigest !== bridge.environment_digest ||
    !sameJson(
      computeCompatibilitySnapshot,
      bridge.compute.compatibility,
    )
  ) {
    fail("Compute detail changed during OFF bridge promotion");
  }

  return baseResult({
    phase: "promoted",
    target,
    policy: "off",
    environmentDigest: bridge.environment_digest,
    apiId: bridge.api.version_id,
    apiTag: bridge.api.version_tag,
    apiCompatibilitySnapshot,
    secretNames,
    computeId: bridge.compute.version_id,
    computeTag: bridge.compute.version_tag,
    computeCompatibilitySnapshot,
    priorApiId: bridge.prior_api_version_id,
    priorApiTag: bridge.prior_api_version_tag,
  });
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

function readText(path, label) {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch (error) {
    fail(`${label} is unreadable: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

export function main(argv) {
  const [mode] = argv;
  let result;
  if (mode === "upload-output" && argv.length === 4) {
    result = verifyWranglerVersionUploadOutput({
      content: readText(argv[1], "Wrangler version-upload output"),
      expectedWorker: argv[2],
      expectedEnvironment: argv[3],
    });
    console.log(result);
    return result;
  } else if (mode === "current" && argv.length === 7) {
    result = verifyCurrentPair({
      target: argv[1],
      expectedApiTag: argv[2],
      apiStatus: readJson(argv[3], "API deployment status"),
      apiVersion: readJson(argv[4], "API version detail"),
      computeStatus: readJson(argv[5], "Compute deployment status"),
      computeVersion: readJson(argv[6], "Compute version detail"),
    });
  } else if (mode === "uploaded" && argv.length === 6) {
    result = verifyUploadedBridge({
      target: argv[1],
      currentState: readJson(argv[2], "current compatibility state"),
      uploadedVersion: readJson(argv[3], "uploaded API version detail"),
      expectedVersionId: argv[4],
      expectedVersionTag: argv[5],
    });
  } else if (mode === "promoted" && argv.length === 7) {
    result = verifyPromotedBridge({
      target: argv[1],
      bridgeState: readJson(argv[2], "validated OFF bridge state"),
      apiStatus: readJson(argv[3], "API deployment status"),
      apiVersion: readJson(argv[4], "API version detail"),
      computeStatus: readJson(argv[5], "Compute deployment status"),
      computeVersion: readJson(argv[6], "Compute version detail"),
    });
  } else {
    fail(
      "usage: verify-api-compute-off-bridge.mjs " +
        "upload-output <wrangler-output> <expected-worker> " +
        "<expected-environment> | " +
        "current <production|staging> <expected-api-tag> " +
        "<api-status> <api-version> <compute-status> <compute-version> | " +
        "uploaded <production|staging> <current-state> <uploaded-version> " +
        "<expected-version-id> <expected-version-tag> | " +
        "promoted <production|staging> <bridge-state> <api-status> " +
        "<api-version> <compute-status> <compute-version>",
    );
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
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
