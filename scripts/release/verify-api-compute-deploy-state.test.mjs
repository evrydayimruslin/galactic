import assert from "node:assert/strict";
import { test } from "node:test";
import {
  verifyApiComputeDeployState,
} from "./verify-api-compute-deploy-state.mjs";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const SHA = "a".repeat(40);
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

function status(overrides = {}) {
  return {
    versions: [{ version_id: VERSION_ID, percentage: 100 }],
    ...overrides,
  };
}

function version({
  plane = false,
  enabled = "0",
  digest = ZERO_DIGEST,
  tag = `api-${SHA}`,
  target = "production",
} = {}) {
  const staging = target === "staging";
  const bindings = [
    { type: "plain_text", name: "COMPUTE_ENABLED", text: enabled },
    {
      type: "plain_text",
      name: "COMPUTE_ENVIRONMENT_DIGEST",
      text: digest,
    },
    {
      type: "plain_text",
      name: "COMPUTE_ROLLOUT_MODE",
      text: "canary",
    },
    {
      type: "plain_text",
      name: "COMPUTE_CANARY_ALLOWLIST",
      text: "",
    },
    {
      type: "queue",
      name: "COMPUTE_QUEUE",
      queue_name: staging ? "galactic-compute-staging" : "galactic-compute",
    },
    {
      type: "r2_bucket",
      name: "COMPUTE_ARTIFACTS",
      bucket_name: staging
        ? "galactic-compute-artifacts-staging"
        : "galactic-compute-artifacts",
    },
  ];
  if (plane) {
    bindings.push({
      type: "service",
      name: "COMPUTE_PLANE",
      service: staging ? "galactic-compute-staging" : "galactic-compute",
      entrypoint: "ComputePlane",
    });
  }
  return {
    id: VERSION_ID,
    annotations: { "workers/tag": tag },
    resources: { bindings },
  };
}

test("accepts a legitimate pre-bootstrap API state", () => {
  assert.deepEqual(
    verifyApiComputeDeployState({
      mode: "pre-bootstrap",
      target: "production",
      status: status(),
      version: {
        id: VERSION_ID,
        resources: { bindings: [] },
      },
    }),
    { versionId: VERSION_ID },
  );
});

test("accepts an exact admission-off bootstrap deployment", () => {
  assert.deepEqual(
    verifyApiComputeDeployState({
      mode: "bootstrap",
      target: "production",
      status: status(),
      version: version(),
      expectedTag: `api-${SHA}`,
    }),
    { versionId: VERSION_ID },
  );
});

test("accepts a bound admission-off deployment", () => {
  assert.deepEqual(
    verifyApiComputeDeployState({
      mode: "bound",
      target: "production",
      status: status(),
      version: version({
        plane: true,
        digest: `sha256:${"b".repeat(64)}`,
      }),
      expectedTag: `api-${SHA}`,
    }),
    { versionId: VERSION_ID },
  );
});

test("validates exact staging Compute resource targets", () => {
  assert.deepEqual(
    verifyApiComputeDeployState({
      mode: "bound",
      target: "staging",
      status: status(),
      version: version({
        plane: true,
        digest: `sha256:${"c".repeat(64)}`,
        target: "staging",
      }),
      expectedTag: `api-${SHA}`,
    }),
    { versionId: VERSION_ID },
  );
});

for (
  const [name, mode, state, detail] of [
    [
      "gradual deployment",
      "bootstrap",
      status({
        versions: [
          { version_id: VERSION_ID, percentage: 50 },
          {
            version_id: "22222222-2222-4222-8222-222222222222",
            percentage: 50,
          },
        ],
      }),
      version(),
    ],
    [
      "enabled admission",
      "bootstrap",
      status(),
      version({ enabled: "1" }),
    ],
    [
      "wrong release tag",
      "bootstrap",
      status(),
      version({ tag: `api-${"b".repeat(40)}` }),
    ],
    [
      "Compute Plane in bootstrap mode",
      "bootstrap",
      status(),
      version({ plane: true }),
    ],
    [
      "missing Compute Plane in bound mode",
      "bound",
      status(),
      version(),
    ],
  ]
) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () =>
        verifyApiComputeDeployState({
          mode,
          target: "production",
          status: state,
          version: detail,
          expectedTag: `api-${SHA}`,
        }),
      /deployment state is invalid/u,
    );
  });
}

test("rejects a previously bound API as a bootstrap candidate", () => {
  assert.throws(
    () =>
      verifyApiComputeDeployState({
        mode: "pre-bootstrap",
        target: "production",
        status: status(),
        version: version({ plane: true }),
      }),
    /unexpectedly has a Compute Plane binding/u,
  );
});

for (const enabled of ["1", "true", "banana"]) {
  test(`rejects legacy pre-bootstrap admission value ${enabled}`, () => {
    assert.throws(
      () =>
        verifyApiComputeDeployState({
          mode: "pre-bootstrap",
          target: "production",
          status: status(),
          version: version({ enabled }),
        }),
      /admission is enabled/u,
    );
  });
}

test("accepts an absent legacy pre-bootstrap admission binding", () => {
  assert.deepEqual(
    verifyApiComputeDeployState({
      mode: "pre-bootstrap",
      target: "production",
      status: status(),
      version: {
        id: VERSION_ID,
        resources: { bindings: [] },
      },
    }),
    { versionId: VERSION_ID },
  );
});

for (
  const [name, mode, binding] of [
    [
      "wrong-type Compute Plane in bootstrap mode",
      "bootstrap",
      { type: "plain_text", name: "COMPUTE_PLANE", text: "none" },
    ],
    [
      "wrong-type Compute Plane in bound mode",
      "bound",
      { type: "plain_text", name: "COMPUTE_PLANE", text: "none" },
    ],
    [
      "wrong-type duplicate Compute Queue",
      "bootstrap",
      { type: "plain_text", name: "COMPUTE_QUEUE", text: "wrong" },
    ],
    [
      "wrong-type duplicate Compute artifact binding",
      "bootstrap",
      {
        type: "plain_text",
        name: "COMPUTE_ARTIFACTS",
        text: "wrong",
      },
    ],
    [
      "wrong-type duplicate Compute admission binding",
      "bootstrap",
      { type: "secret_text", name: "COMPUTE_ENABLED" },
    ],
  ]
) {
  test(`rejects ${name}`, () => {
    const detail = version({ plane: mode === "bound" });
    detail.resources.bindings.push(binding);
    assert.throws(
      () =>
        verifyApiComputeDeployState({
          mode,
          target: "production",
          status: status(),
          version: detail,
          expectedTag: `api-${SHA}`,
        }),
      /deployment state is invalid/u,
    );
  });
}
