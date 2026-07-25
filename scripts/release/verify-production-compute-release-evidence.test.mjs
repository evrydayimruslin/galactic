import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  verifyProductionComputeReleaseEvidence,
} from "./verify-production-compute-release-evidence.mjs";

const SHA = "a".repeat(40);
const TAG = "v0.4.53";
const RUN_ID = "30170000000";
const DIGEST = `sha256:${"b".repeat(64)}`;
const OFF_API_ID = "11111111-1111-4111-8111-111111111111";
const API_ID = "22222222-2222-4222-8222-222222222222";
const COMPUTE_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const COMPUTE_RUN_ID = "55555555-5555-4555-8555-555555555555";
const RECEIPT_ID = "66666666-6666-4666-8666-666666666666";
const PREFLIGHT_RUN_ID = "00000000-0000-4000-8000-000000000000";

function writeEvidenceAndBind(directory, release, preflight, smoke) {
  const preflightBytes = `${JSON.stringify(preflight)}\n`;
  release.binding_preflight.sha256 = createHash("sha256")
    .update(preflightBytes)
    .digest("hex");
  const smokeBytes = `${JSON.stringify(smoke)}\n`;
  release.admitted_smoke.sha256 = createHash("sha256")
    .update(smokeBytes)
    .digest("hex");
  writeFileSync(
    join(directory, "release.json"),
    `${JSON.stringify(release)}\n`,
  );
  writeFileSync(
    join(directory, "compute-preflight-production.json"),
    preflightBytes,
  );
  writeFileSync(join(directory, "compute-admitted-production.json"), smokeBytes);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "compute-gate-"));
  const marker =
    `galactic-compute-release-smoke-v1:${SHA}:${RUN_ID}\n`;
  const markerSha256 = createHash("sha256").update(marker).digest("hex");
  const release = {
    schema_version: 5,
    environment: "production",
    git_sha: SHA,
    git_ref: `refs/tags/${TAG}`,
    deployed_image:
      `registry.cloudflare.com/${"1".repeat(32)}/galactic-compute@${DIGEST}`,
    environment_digest: DIGEST,
    admission_enabled: true,
    rollout_mode: "global",
    canary_allowlist: [],
    certified_admission_off_api: {
      worker: "ultralight-api",
      version_id: OFF_API_ID,
      version_tag: `api-${SHA}-admission-off`,
    },
    active_api: {
      worker: "ultralight-api",
      version_id: API_ID,
      version_tag: `api-${SHA}`,
      enabled: true,
      rollout_mode: "global",
      canary_allowlist: [],
    },
    active_compute_worker: {
      worker: "galactic-compute",
      version_id: COMPUTE_ID,
      version_tag: `compute-${SHA}`,
    },
    binding_preflight: {
      evidence_file: "compute-preflight-production.json",
      verified: true,
      sha256: "",
    },
    admitted_smoke: {
      evidence_file: "compute-admitted-production.json",
      verified: true,
      sha256: "",
    },
  };
  const preflight = {
    schema_version: 1,
    kind: "galactic_compute_binding_preflight",
    verified: true,
    target: "production",
    candidate_sha: SHA,
    workflow_run_id: RUN_ID,
    agent_id: AGENT_ID,
    function_name: "run_compute_smoke",
    fixture_policy: { enabled: false, revision: "7" },
    probe: {
      action: "status",
      run_id: PREFLIGHT_RUN_ID,
      expected_http_status: 500,
      expected_public_compute_code: "COMPUTE_RUN_NOT_FOUND",
      observed_http_status: 500,
      observed_public_compute_code: "COMPUTE_RUN_NOT_FOUND",
    },
  };
  const smoke = {
    schema_version: 1,
    kind: "galactic_compute_admitted_smoke",
    verified: true,
    target: "production",
    candidate_sha: SHA,
    workflow_run_id: RUN_ID,
    agent_id: AGENT_ID,
    function_name: "run_compute_smoke",
    marker_sha256: markerSha256,
    compute_run_id: COMPUTE_RUN_ID,
    compute_receipt_id: RECEIPT_ID,
    observed_states: ["admitted", "queued", "completed"],
    result: {
      status: "completed",
      exit_code: 0,
      stdout_sha256: markerSha256,
      stdout_bytes: Buffer.byteLength(marker),
      stderr_bytes: 0,
      artifact_count: 0,
    },
    policy_cleanup: { disabled: true },
  };
  writeEvidenceAndBind(directory, release, preflight, smoke);
  return { directory, release, preflight, smoke };
}

test("accepts an exact-tag globally admitted Compute release and smoke", () => {
  const { directory } = fixture();
  try {
    const result = verifyProductionComputeReleaseEvidence({
      evidenceDirectory: directory,
      candidateSha: SHA,
      releaseTag: TAG,
      workflowRunId: RUN_ID,
    });
    assert.equal(result.verified, true);
    assert.equal(result.environment_digest, DIGEST);
    assert.equal(result.compute_run_id, COMPUTE_RUN_ID);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects admission-off release evidence", () => {
  const { directory, release } = fixture();
  try {
    release.admission_enabled = false;
    release.rollout_mode = "canary";
    writeFileSync(
      join(directory, "release.json"),
      `${JSON.stringify(release)}\n`,
    );
    assert.throws(
      () =>
        verifyProductionComputeReleaseEvidence({
          evidenceDirectory: directory,
          candidateSha: SHA,
          releaseTag: TAG,
          workflowRunId: RUN_ID,
        }),
      /does not certify global admission/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a smoke from any other workflow run", () => {
  const { directory, release, preflight, smoke } = fixture();
  try {
    smoke.workflow_run_id = "30170000001";
    writeEvidenceAndBind(directory, release, preflight, smoke);
    assert.throws(
      () =>
        verifyProductionComputeReleaseEvidence({
          evidenceDirectory: directory,
          candidateSha: SHA,
          releaseTag: TAG,
          workflowRunId: RUN_ID,
        }),
      /did not prove a clean completed execution/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a missing, altered, or non-verifying binding preflight", () => {
  const { directory, release, preflight, smoke } = fixture();
  try {
    preflight.probe.observed_public_compute_code =
      "COMPUTE_CONTROL_PLANE_UNAVAILABLE";
    writeEvidenceAndBind(directory, release, preflight, smoke);
    assert.throws(
      () =>
        verifyProductionComputeReleaseEvidence({
          evidenceDirectory: directory,
          candidateSha: SHA,
          releaseTag: TAG,
          workflowRunId: RUN_ID,
        }),
      /did not prove the admission-off RPC\/DB path/u,
    );

    preflight.probe.observed_public_compute_code = "COMPUTE_RUN_NOT_FOUND";
    writeEvidenceAndBind(directory, release, preflight, smoke);
    writeFileSync(
      join(directory, "compute-preflight-production.json"),
      `${JSON.stringify({ ...preflight, verified: false })}\n`,
    );
    assert.throws(
      () =>
        verifyProductionComputeReleaseEvidence({
          evidenceDirectory: directory,
          candidateSha: SHA,
          releaseTag: TAG,
          workflowRunId: RUN_ID,
        }),
      /bytes do not match the release binding/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects mutable image evidence or an image/digest mismatch", () => {
  const { directory, release } = fixture();
  try {
    release.deployed_image = "registry.cloudflare.com/account/latest";
    writeFileSync(
      join(directory, "release.json"),
      `${JSON.stringify(release)}\n`,
    );
    assert.throws(
      () =>
        verifyProductionComputeReleaseEvidence({
          evidenceDirectory: directory,
          candidateSha: SHA,
          releaseTag: TAG,
          workflowRunId: RUN_ID,
        }),
      /released image and immutable environment digest do not match/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
