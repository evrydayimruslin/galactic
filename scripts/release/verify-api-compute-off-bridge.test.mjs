import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyCurrentPair,
  verifyPromotedBridge,
  verifyUploadedBridge,
} from "./verify-api-compute-off-bridge.mjs";

const SHA = "a".repeat(40);
const SOURCE_TAG = `api-${SHA}`;
const BRIDGE_TAG = `${SOURCE_TAG}-pre-off`;
const API_ID = "11111111-1111-4111-8111-111111111111";
const COMPUTE_ID = "22222222-2222-4222-8222-222222222222";
const BRIDGE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const DIGEST = `sha256:${"b".repeat(64)}`;

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

function policyBinding(name, text) {
  return { type: "plain_text", name, text };
}

function fixture(policy = "global", target = "production") {
  const names = TARGETS[target];
  const enabled = policy === "global" ? "1" : "0";
  const rolloutMode = policy === "global" ? "global" : "canary";
  return {
    target,
    expectedApiTag: SOURCE_TAG,
    apiStatus: {
      versions: [{ version_id: API_ID, percentage: 100 }],
    },
    computeStatus: {
      versions: [{ version_id: COMPUTE_ID, percentage: "100" }],
    },
    apiVersion: {
      id: API_ID,
      annotations: { "workers/tag": SOURCE_TAG },
      resources: {
        bindings: [
          policyBinding("COMPUTE_ENABLED", enabled),
          policyBinding("COMPUTE_ENVIRONMENT_DIGEST", DIGEST),
          policyBinding("COMPUTE_ROLLOUT_MODE", rolloutMode),
          policyBinding("COMPUTE_CANARY_ALLOWLIST", ""),
          {
            type: "service",
            name: "COMPUTE_PLANE",
            service: names.computeWorker,
            entrypoint: "ComputePlane",
          },
          {
            type: "queue",
            name: "COMPUTE_QUEUE",
            queue_name: names.computeQueue,
          },
          {
            type: "r2_bucket",
            name: "COMPUTE_ARTIFACTS",
            bucket_name: names.artifactBucket,
          },
          {
            type: "durable_object_namespace",
            name: "GX_TEST_SESSION",
            class_name: "GxTestSession",
            script_name: names.sessionWorker,
          },
          { type: "secret_text", name: "SUPABASE_SERVICE_ROLE_KEY" },
          { type: "secret_text", name: "STRIPE_SECRET_KEY" },
        ],
        script_runtime: {
          exports: {
            GxTestSession: {
              type: "durable-object",
              storage: "sqlite",
              state: "created",
            },
          },
        },
      },
    },
    computeVersion: {
      id: COMPUTE_ID,
      annotations: { "workers/tag": `compute-${SHA}` },
      resources: {
        bindings: [
          policyBinding("COMPUTE_ENVIRONMENT_DIGEST", DIGEST),
          {
            type: "service",
            name: "CONTROL_PLANE",
            service: names.apiWorker,
            entrypoint: "ComputeControlPlane",
          },
          {
            type: "r2_bucket",
            name: "COMPUTE_ARTIFACTS",
            bucket_name: names.artifactBucket,
          },
        ],
      },
    },
  };
}

function binding(version, name) {
  return version.resources.bindings.find((value) => value.name === name);
}

function uploadedFixture(target = "production") {
  const currentInput = fixture("global", target);
  const currentState = verifyCurrentPair(currentInput);
  const uploadedVersion = structuredClone(currentInput.apiVersion);
  uploadedVersion.id = BRIDGE_ID;
  uploadedVersion.annotations["workers/tag"] = BRIDGE_TAG;
  binding(uploadedVersion, "COMPUTE_ENABLED").text = "0";
  binding(uploadedVersion, "COMPUTE_ROLLOUT_MODE").text = "canary";
  return { currentInput, currentState, uploadedVersion };
}

function verifyUpload(input) {
  return verifyUploadedBridge({
    target: input.currentInput.target,
    currentState: input.currentState,
    uploadedVersion: input.uploadedVersion,
    expectedVersionId: BRIDGE_ID,
    expectedVersionTag: BRIDGE_TAG,
  });
}

test("accepts and promotes a compatible global API through an uploaded OFF bridge", () => {
  const input = uploadedFixture();
  const current = input.currentState;
  assert.equal(current.policy, "global");
  assert.equal(current.api.version_tag, SOURCE_TAG);
  assert.deepEqual(current.api.secret_text_binding_names, [
    "STRIPE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);

  const bridge = verifyUpload(input);
  assert.equal(bridge.phase, "uploaded");
  assert.equal(bridge.policy, "off");
  assert.equal(bridge.api.version_id, BRIDGE_ID);
  assert.equal(bridge.compute.version_id, COMPUTE_ID);

  const result = verifyPromotedBridge({
    target: input.currentInput.target,
    bridgeState: bridge,
    apiStatus: { versions: [{ version_id: BRIDGE_ID, percentage: 100 }] },
    apiVersion: input.uploadedVersion,
    computeStatus: input.currentInput.computeStatus,
    computeVersion: input.currentInput.computeVersion,
  });
  assert.equal(result.phase, "promoted");
  assert.equal(result.api.version_id, BRIDGE_ID);
  assert.equal(result.compute.version_id, COMPUTE_ID);
});

test("accepts an exact already-OFF current source without uploading a bridge", () => {
  for (const target of ["production", "staging"]) {
    const input = fixture("off", target);
    const current = verifyCurrentPair(input);
    assert.equal(current.policy, "off");
    const result = verifyPromotedBridge({
      target,
      bridgeState: current,
      apiStatus: input.apiStatus,
      apiVersion: input.apiVersion,
      computeStatus: input.computeStatus,
      computeVersion: input.computeVersion,
    });
    assert.equal(result.policy, "off");
    assert.equal(result.target, target);
  }
});

test("rejects an old source version even when its policy is already OFF", () => {
  const input = fixture("off");
  input.apiVersion.annotations["workers/tag"] = `api-${"c".repeat(40)}`;
  assert.throws(
    () => verifyCurrentPair(input),
    /current API version tag does not match/u,
  );
});

for (
  const [name, mutate] of [
    [
      "enabled canary",
      (input) => {
        binding(input.apiVersion, "COMPUTE_ROLLOUT_MODE").text = "canary";
      },
    ],
    [
      "global allowlist",
      (input) => {
        binding(input.apiVersion, "COMPUTE_CANARY_ALLOWLIST").text =
          "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
      },
    ],
    [
      "OFF allowlist",
      (input) => {
        binding(input.apiVersion, "COMPUTE_ENABLED").text = "0";
        binding(input.apiVersion, "COMPUTE_ROLLOUT_MODE").text = "canary";
        binding(input.apiVersion, "COMPUTE_CANARY_ALLOWLIST").text = "owner/agent";
      },
    ],
  ]
) {
  test(`rejects ${name} as a current API policy`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(
      () => verifyCurrentPair(input),
      /policy must be exactly global.*or OFF/u,
    );
  });
}

for (
  const [name, mutate, error] of [
    [
      "a zero API digest",
      (input) => {
        binding(input.apiVersion, "COMPUTE_ENVIRONMENT_DIGEST").text =
          `sha256:${"0".repeat(64)}`;
      },
      /nonzero sha256 digest/u,
    ],
    [
      "a zero Compute digest",
      (input) => {
        binding(input.computeVersion, "COMPUTE_ENVIRONMENT_DIGEST").text =
          `sha256:${"0".repeat(64)}`;
      },
      /nonzero sha256 digest/u,
    ],
    [
      "mismatched API and Compute digests",
      (input) => {
        binding(input.computeVersion, "COMPUTE_ENVIRONMENT_DIGEST").text =
          `sha256:${"c".repeat(64)}`;
      },
      /digests do not match/u,
    ],
  ]
) {
  test(`rejects ${name}`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyCurrentPair(input), error);
  });
}

test("rejects mixed or partial API and Compute deployments", () => {
  const mixedApi = fixture();
  mixedApi.apiStatus.versions = [
    { version_id: API_ID, percentage: 50 },
    { version_id: OTHER_ID, percentage: 50 },
  ];
  assert.throws(
    () => verifyCurrentPair(mixedApi),
    /API deployment must contain exactly one valid version at 100%/u,
  );

  const partialCompute = fixture();
  partialCompute.computeStatus.versions[0].percentage = 99.99;
  assert.throws(
    () => verifyCurrentPair(partialCompute),
    /Compute deployment must contain exactly one valid version at 100%/u,
  );
});

for (
  const [name, mutate, error] of [
    [
      "API service",
      (input) => {
        binding(input.apiVersion, "COMPUTE_PLANE").service = "wrong-compute";
      },
      /COMPUTE_PLANE binding does not match/u,
    ],
    [
      "API queue",
      (input) => {
        binding(input.apiVersion, "COMPUTE_QUEUE").queue_name = "wrong-queue";
      },
      /COMPUTE_QUEUE binding does not match/u,
    ],
    [
      "API R2 bucket",
      (input) => {
        binding(input.apiVersion, "COMPUTE_ARTIFACTS").bucket_name =
          "wrong-bucket";
      },
      /COMPUTE_ARTIFACTS binding does not match/u,
    ],
    [
      "GX session namespace",
      (input) => {
        binding(input.apiVersion, "GX_TEST_SESSION").script_name =
          "wrong-session-worker";
      },
      /GX_TEST_SESSION binding does not match/u,
    ],
    [
      "Compute control plane",
      (input) => {
        binding(input.computeVersion, "CONTROL_PLANE").service = "wrong-api";
      },
      /CONTROL_PLANE binding does not match/u,
    ],
    [
      "Compute R2 bucket",
      (input) => {
        binding(input.computeVersion, "COMPUTE_ARTIFACTS").bucket_name =
          "wrong-bucket";
      },
      /COMPUTE_ARTIFACTS binding does not match/u,
    ],
  ]
) {
  test(`rejects a wrong ${name} binding`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => verifyCurrentPair(input), error);
  });
}

test("rejects duplicate critical bindings", () => {
  const input = fixture();
  input.apiVersion.resources.bindings.push({
    ...binding(input.apiVersion, "COMPUTE_QUEUE"),
  });
  assert.throws(
    () => verifyCurrentPair(input),
    /exactly one COMPUTE_QUEUE queue binding/u,
  );
});

test("rejects a current API without the source-owned GxTestSession export", () => {
  const missing = fixture();
  delete missing.apiVersion.resources.script_runtime.exports.GxTestSession;
  assert.throws(
    () => verifyCurrentPair(missing),
    /source-owned GxTestSession durable-object SQLite export/u,
  );

  const transfer = fixture();
  transfer.apiVersion.resources.script_runtime.exports.GxTestSession = {
    type: "durable-object",
    storage: "sqlite",
    state: "expecting-transfer",
    transfer_from: "old-api",
  };
  assert.throws(
    () => verifyCurrentPair(transfer),
    /source-owned GxTestSession durable-object SQLite export/u,
  );
});

test("rejects a changed Compute deployment or detail after promotion", () => {
  const input = uploadedFixture();
  const bridge = verifyUpload(input);
  const args = {
    target: input.currentInput.target,
    bridgeState: bridge,
    apiStatus: { versions: [{ version_id: BRIDGE_ID, percentage: 100 }] },
    apiVersion: input.uploadedVersion,
    computeStatus: input.currentInput.computeStatus,
    computeVersion: input.currentInput.computeVersion,
  };

  const changedStatus = structuredClone(args);
  changedStatus.computeStatus.versions[0].version_id = OTHER_ID;
  assert.throws(
    () => verifyPromotedBridge(changedStatus),
    /Compute deployment changed during OFF bridge promotion/u,
  );

  const changedDetail = structuredClone(args);
  binding(changedDetail.computeVersion, "COMPUTE_ARTIFACTS").bucket_name =
    "wrong-bucket";
  assert.throws(
    () => verifyPromotedBridge(changedDetail),
    /post-promotion Compute COMPUTE_ARTIFACTS binding does not match/u,
  );
});

test("rejects a different or mixed API deployment after promotion", () => {
  const input = uploadedFixture();
  const bridge = verifyUpload(input);
  const args = {
    target: input.currentInput.target,
    bridgeState: bridge,
    apiStatus: { versions: [{ version_id: BRIDGE_ID, percentage: 100 }] },
    apiVersion: input.uploadedVersion,
    computeStatus: input.currentInput.computeStatus,
    computeVersion: input.currentInput.computeVersion,
  };

  const different = structuredClone(args);
  different.apiStatus.versions[0].version_id = API_ID;
  assert.throws(
    () => verifyPromotedBridge(different),
    /does not contain the exact validated OFF bridge/u,
  );

  const mixed = structuredClone(args);
  mixed.apiStatus.versions = [
    { version_id: BRIDGE_ID, percentage: 50 },
    { version_id: API_ID, percentage: 50 },
  ];
  assert.throws(
    () => verifyPromotedBridge(mixed),
    /promoted API deployment must contain exactly one valid version at 100%/u,
  );
});

for (
  const [name, mutate, error] of [
    [
      "unexpected ID",
      (args) => {
        args.expectedVersionId = OTHER_ID;
      },
      /uploaded API version detail does not match/u,
    ],
    [
      "unexpected tag",
      (args) => {
        args.uploadedVersion.annotations["workers/tag"] = "wrong-tag";
      },
      /uploaded API version tag does not match/u,
    ],
    [
      "global policy",
      (args) => {
        binding(args.uploadedVersion, "COMPUTE_ENABLED").text = "1";
        binding(args.uploadedVersion, "COMPUTE_ROLLOUT_MODE").text = "global";
      },
      /uploaded API policy is not OFF/u,
    ],
    [
      "different digest",
      (args) => {
        binding(args.uploadedVersion, "COMPUTE_ENVIRONMENT_DIGEST").text =
          `sha256:${"d".repeat(64)}`;
      },
      /digest does not match the current pair/u,
    ],
    [
      "wrong queue binding",
      (args) => {
        binding(args.uploadedVersion, "COMPUTE_QUEUE").queue_name =
          "wrong-queue";
      },
      /uploaded API COMPUTE_QUEUE binding does not match/u,
    ],
    [
      "missing GX export",
      (args) => {
        delete args.uploadedVersion.resources.script_runtime.exports
          .GxTestSession;
      },
      /source-owned GxTestSession durable-object SQLite export/u,
    ],
    [
      "missing secret",
      (args) => {
        args.uploadedVersion.resources.bindings =
          args.uploadedVersion.resources.bindings.filter(
            (value) => value.name !== "STRIPE_SECRET_KEY",
          );
      },
      /secret_text binding names do not exactly match/u,
    ],
    [
      "extra secret",
      (args) => {
        args.uploadedVersion.resources.bindings.push({
          type: "secret_text",
          name: "ATTACKER_SECRET",
        });
      },
      /secret_text binding names do not exactly match/u,
    ],
    [
      "duplicate secret",
      (args) => {
        args.uploadedVersion.resources.bindings.push({
          type: "secret_text",
          name: "STRIPE_SECRET_KEY",
        });
      },
      /secret_text binding names must be nonempty and unique/u,
    ],
  ]
) {
  test(`rejects a bad uploaded bridge with ${name}`, () => {
    const input = uploadedFixture();
    const args = {
      target: input.currentInput.target,
      currentState: input.currentState,
      uploadedVersion: input.uploadedVersion,
      expectedVersionId: BRIDGE_ID,
      expectedVersionTag: BRIDGE_TAG,
    };
    mutate(args);
    assert.throws(() => verifyUploadedBridge(args), error);
  });
}

test("rejects an uploaded bridge when the current API was already OFF", () => {
  const input = fixture("off");
  const currentState = verifyCurrentPair(input);
  const uploadedVersion = structuredClone(input.apiVersion);
  uploadedVersion.id = BRIDGE_ID;
  uploadedVersion.annotations["workers/tag"] = BRIDGE_TAG;
  assert.throws(
    () =>
      verifyUploadedBridge({
        target: input.target,
        currentState,
        uploadedVersion,
        expectedVersionId: BRIDGE_ID,
        expectedVersionTag: BRIDGE_TAG,
      }),
    /may only be derived from a global current API/u,
  );
});
