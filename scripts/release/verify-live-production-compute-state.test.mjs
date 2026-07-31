import assert from "node:assert/strict";
import test from "node:test";

import { verifyLiveProductionComputeState } from "./verify-live-production-compute-state.mjs";

const SHA = "a".repeat(40);
const API_ID = "11111111-1111-4111-8111-111111111111";
const COMPUTE_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE =
  `registry.cloudflare.com/${"c".repeat(32)}/galactic-compute@${DIGEST}`;

function fixture(admissionMode = "preserve_off") {
  const apiTag = admissionMode === "preserve_off"
    ? `api-${SHA}-admission-off`
    : `api-${SHA}`;
  return {
    candidateSha: SHA,
    admissionMode,
    apiStatus: {
      versions: [{ version_id: API_ID, percentage: 100 }],
    },
    computeStatus: {
      versions: [{ version_id: COMPUTE_ID, percentage: 100 }],
    },
    sessionStatus: {
      versions: [{ version_id: SESSION_ID, percentage: 100 }],
    },
    containerList: [{
      id: "container-application-id",
      name: "galactic-compute-computestandard",
      state: "ready",
      instances: 1,
      image: IMAGE,
      version: 7,
      updated_at: "2026-07-31T12:00:00Z",
    }],
    releaseVerification: {
      verified: true,
      environment: "production",
      candidate_sha: SHA,
      environment_digest: DIGEST,
      deployed_image: IMAGE,
      active_api_version_id: API_ID,
      active_compute_version_id: COMPUTE_ID,
    },
    apiVersion: {
      id: API_ID,
      annotations: { "workers/tag": apiTag },
      resources: {
        bindings: [
          {
            type: "plain_text",
            name: "COMPUTE_ENABLED",
            text: admissionMode === "preserve_off" ? "0" : "1",
          },
          {
            type: "plain_text",
            name: "COMPUTE_ENVIRONMENT_DIGEST",
            text: DIGEST,
          },
          {
            type: "plain_text",
            name: "COMPUTE_ROLLOUT_MODE",
            text: admissionMode === "preserve_off" ? "canary" : "global",
          },
          {
            type: "plain_text",
            name: "COMPUTE_CANARY_ALLOWLIST",
            text: "",
          },
          {
            type: "service",
            name: "COMPUTE_PLANE",
            service: "galactic-compute",
            entrypoint: "ComputePlane",
          },
          {
            type: "queue",
            name: "COMPUTE_QUEUE",
            queue_name: "galactic-compute",
          },
          {
            type: "r2_bucket",
            name: "COMPUTE_ARTIFACTS",
            bucket_name: "galactic-compute-artifacts",
          },
          {
            type: "durable_object_namespace",
            name: "GX_TEST_SESSION",
            class_name: "GxTestSession",
            script_name: "galactic-gx-test-session",
          },
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
          {
            type: "plain_text",
            name: "COMPUTE_ENVIRONMENT_DIGEST",
            text: DIGEST,
          },
          {
            type: "service",
            name: "CONTROL_PLANE",
            service: "ultralight-api",
            entrypoint: "ComputeControlPlane",
          },
          {
            type: "r2_bucket",
            name: "COMPUTE_ARTIFACTS",
            bucket_name: "galactic-compute-artifacts",
          },
        ],
      },
    },
    sessionVersion: {
      id: SESSION_ID,
      annotations: { "workers/tag": `gx-test-session-${SHA}` },
      resources: {
        bindings: [],
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
  };
}

test("accepts exact live preserve_off and enable_global pairs", () => {
  for (const mode of ["preserve_off", "enable_global"]) {
    const result = verifyLiveProductionComputeState(fixture(mode));
    assert.equal(result.verified, true);
    assert.equal(result.admission_mode, mode);
    assert.equal(result.active_api_version_id, API_ID);
    assert.equal(result.active_compute_version_id, COMPUTE_ID);
    assert.equal(result.active_gx_test_session_version_id, SESSION_ID);
    assert.equal(
      result.active_container_application_id,
      "container-application-id",
    );
  }
});

test("rejects drift from the exact stable version IDs", () => {
  const input = fixture();
  input.apiStatus.versions[0].version_id =
    "33333333-3333-4333-8333-333333333333";
  assert.throws(
    () => verifyLiveProductionComputeState(input),
    /API is not the exact stable 100% version/u,
  );
});

test("rejects API policy or Compute binding drift", () => {
  const policyDrift = fixture();
  policyDrift.apiVersion.resources.bindings.find(
    (binding) => binding.name === "COMPUTE_ENABLED",
  ).text = "1";
  assert.throws(
    () => verifyLiveProductionComputeState(policyDrift),
    /live API Compute policy does not match/u,
  );

  const bindingDrift = fixture();
  bindingDrift.computeVersion.resources.bindings =
    bindingDrift.computeVersion.resources.bindings.filter(
      (binding) => binding.name !== "CONTROL_PLANE",
    );
  assert.throws(
    () => verifyLiveProductionComputeState(bindingDrift),
    /exactly one valid CONTROL_PLANE binding/u,
  );
});

test("rejects duplicate security-critical bindings", () => {
  const input = fixture();
  input.apiVersion.resources.bindings.push({
    type: "plain_text",
    name: "COMPUTE_ENABLED",
    text: "0",
  });
  assert.throws(
    () => verifyLiveProductionComputeState(input),
    /exactly one COMPUTE_ENABLED/u,
  );

  const serviceDuplicate = fixture();
  serviceDuplicate.computeVersion.resources.bindings.push({
    type: "service",
    name: "CONTROL_PLANE",
    service: "attacker-controlled-api",
    entrypoint: "ComputeControlPlane",
  });
  assert.throws(
    () => verifyLiveProductionComputeState(serviceDuplicate),
    /exactly one valid CONTROL_PLANE binding/u,
  );
});

test("rejects gx.test session Worker or API binding drift", () => {
  const workerDrift = fixture();
  workerDrift.sessionVersion.annotations["workers/tag"] =
    `gx-test-session-${"c".repeat(40)}`;
  assert.throws(
    () => verifyLiveProductionComputeState(workerDrift),
    /session Worker identity does not match/u,
  );

  const statusDrift = fixture();
  statusDrift.sessionStatus.versions[0].percentage = 50;
  assert.throws(
    () => verifyLiveProductionComputeState(statusDrift),
    /session Worker is not the exact stable 100% version/u,
  );

  const bindingDrift = fixture();
  bindingDrift.apiVersion.resources.bindings.find(
    (binding) => binding.name === "GX_TEST_SESSION",
  ).script_name = "attacker-session-worker";
  assert.throws(
    () => verifyLiveProductionComputeState(bindingDrift),
    /exactly one valid GX_TEST_SESSION binding/u,
  );

  const apiExportDrift = fixture();
  apiExportDrift.apiVersion.resources.script_runtime.exports.GxTestSession
    .storage = "legacy-kv";
  assert.throws(
    () => verifyLiveProductionComputeState(apiExportDrift),
    /API rollback anchor must export GxTestSession with SQLite storage/u,
  );

  const workerExportDrift = fixture();
  delete workerExportDrift.sessionVersion.resources.script_runtime.exports
    .GxTestSession;
  assert.throws(
    () => verifyLiveProductionComputeState(workerExportDrift),
    /session Worker must export GxTestSession with SQLite storage/u,
  );
});

test("rejects live Container image or readiness drift", () => {
  const imageDrift = fixture();
  imageDrift.containerList[0].image =
    imageDrift.containerList[0].image.replace(/b+$/u, "d".repeat(64));
  assert.throws(
    () => verifyLiveProductionComputeState(imageDrift),
    /does not reference the released image digest/u,
  );

  const readinessDrift = fixture();
  readinessDrift.containerList[0].state = "degraded";
  assert.throws(
    () => verifyLiveProductionComputeState(readinessDrift),
    /waiting for active or ready/u,
  );
});
