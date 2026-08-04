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
const TAG = "v0.4.73";
const RUN_ID = "30170000000";
const DIGEST = `sha256:${"b".repeat(64)}`;
const PREVIOUS_DIGEST = `sha256:${"c".repeat(64)}`;
const BASE_IMAGE =
  `docker.io/cloudflare/sandbox:0.12.3-python@sha256:${"d".repeat(64)}`;
const RETENTION_MIGRATION =
  "supabase/migrations/20260720124000_compute_artifact_retention.sql";
const RETENTION_SHA = "e".repeat(64);
const OTHER_MIGRATION_SHA = "f".repeat(64);
const SCHEMA_RUN_ID = "30160000000";
const OFF_API_ID = "11111111-1111-4111-8111-111111111111";
const API_ID = "22222222-2222-4222-8222-222222222222";
const COMPUTE_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const COMPUTE_RUN_ID = "55555555-5555-4555-8555-555555555555";
const RECEIPT_ID = "66666666-6666-4666-8666-666666666666";
const PREFLIGHT_RUN_ID = "00000000-0000-4000-8000-000000000000";

function jsonBytes(value) {
  return `${JSON.stringify(value)}\n`;
}

function bindJson(directory, file, value) {
  const bytes = jsonBytes(value);
  writeFileSync(join(directory, file), bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

function writeRelease(directory, release) {
  writeFileSync(join(directory, "release.json"), jsonBytes(release));
}

function preflightFixture() {
  return {
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
}

function globalFixture() {
  const directory = mkdtempSync(join(tmpdir(), "compute-global-gate-"));
  const marker =
    `galactic-compute-release-smoke-v1:${SHA}:${RUN_ID}\n`;
  const markerSha256 = createHash("sha256").update(marker).digest("hex");
  const preflight = preflightFixture();
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
      sha256: bindJson(
        directory,
        "compute-preflight-production.json",
        preflight,
      ),
    },
    admitted_smoke: {
      evidence_file: "compute-admitted-production.json",
      verified: true,
      sha256: bindJson(
        directory,
        "compute-admitted-production.json",
        smoke,
      ),
    },
  };
  writeRelease(directory, release);
  return { directory, release, preflight, smoke };
}

function preserveOffFixture() {
  const directory = mkdtempSync(join(tmpdir(), "compute-preserve-gate-"));
  const preflight = preflightFixture();
  const releasePolicy = {
    schema_version: 1,
    release_tag: TAG,
    compute: {
      artifact: "deploy_exact_candidate",
      admission: "preserve_off",
    },
  };
  const policyBefore = {
    schema_version: 1,
    worker: "ultralight-api",
    id: API_ID,
    tag: "api-previous-admission-off",
    admission_enabled: false,
    selected_bindings: [
      { type: "plain_text", name: "COMPUTE_ENABLED", text: "0" },
      {
        type: "plain_text",
        name: "COMPUTE_ENVIRONMENT_DIGEST",
        text: PREVIOUS_DIGEST,
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
        type: "plain_text",
        name: "COMPUTE_CERTIFICATION_PRINCIPAL",
        text: "",
      },
    ],
  };
  const policyAfter = {
    schema_version: 1,
    worker: "ultralight-api",
    id: OFF_API_ID,
    tag: `api-${SHA}-admission-off`,
    admission_enabled: false,
    rollout_mode: "canary",
    canary_allowlist: [],
    selected_bindings: [
      { type: "plain_text", name: "COMPUTE_ENABLED", text: "0" },
      {
        type: "plain_text",
        name: "COMPUTE_ENVIRONMENT_DIGEST",
        text: DIGEST,
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
        type: "plain_text",
        name: "COMPUTE_CERTIFICATION_PRINCIPAL",
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
    ],
  };
  const computeEvidence = {
    schema_version: 1,
    worker: "galactic-compute",
    id: COMPUTE_ID,
    tag: `compute-${SHA}`,
    environment_digest: DIGEST,
    selected_bindings: [
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
  };
  const migrationManifest =
    `${RETENTION_SHA}  ${RETENTION_MIGRATION}\n` +
    `${OTHER_MIGRATION_SHA}  supabase/migrations/20260720124500_compute_capacity_conservation.sql\n`;
  const migrationManifestSha = createHash("sha256")
    .update(migrationManifest)
    .digest("hex");
  writeFileSync(join(directory, "base-image.txt"), `${BASE_IMAGE}\n`);
  writeFileSync(
    join(directory, "compute-migrations.sha256"),
    migrationManifest,
  );
  writeFileSync(
    join(directory, "compute-migrations-manifest.sha256"),
    `${migrationManifestSha}  compute-migrations.sha256\n`,
  );
  writeFileSync(
    join(directory, "compute-artifact-retention-migration.sha256"),
    `${RETENTION_SHA}  ${RETENTION_MIGRATION}\n`,
  );
  bindJson(directory, "compute-artifact-retention-policy.json", {
    schema_version: 1,
    migration: RETENTION_MIGRATION.split("/").at(-1),
    ready_output_days: 30,
    owner_retained_output_bytes: 10_737_418_240,
    owner_retained_output_objects: 10_000,
    download_lease_seconds: 3_600,
    deletion_authority: "database_reconciler",
    r2_age_deletion_allowed: false,
  });
  bindJson(directory, "schema-workflow-run.json", {
    id: Number(SCHEMA_RUN_ID),
    event: "push",
    conclusion: "success",
    head_sha: SHA,
    head_branch: TAG,
    path: ".github/workflows/supabase-production-db.yml",
    run_attempt: 1,
    created_at: "2026-07-31T11:00:00Z",
    updated_at: "2026-07-31T11:01:00Z",
  });
  bindJson(directory, "schema-workflow-job.json", {
    id: 30160000001,
    run_id: Number(SCHEMA_RUN_ID),
    name: "Deploy production schema",
    status: "completed",
    conclusion: "success",
    head_sha: SHA,
    started_at: "2026-07-31T11:00:10Z",
    completed_at: "2026-07-31T11:00:50Z",
  });
  bindJson(directory, "container-readiness.json", {
    schema_version: 1,
    id: "container-application-id",
    name: "galactic-compute-computestandard",
    state: "ready",
    instances: 1,
    image:
      `registry.cloudflare.com/${"1".repeat(32)}/galactic-compute@${DIGEST}`,
    version: 7,
    updated_at: "2026-07-31T11:30:00Z",
  });
  const release = {
    schema_version: 6,
    release_mode: "policy_preserved",
    admission_mode: "preserve_off",
    workflow_run_id: RUN_ID,
    environment: "production",
    git_sha: SHA,
    git_ref: `refs/tags/${TAG}`,
    base_image: BASE_IMAGE,
    deployed_image:
      `registry.cloudflare.com/${"1".repeat(32)}/galactic-compute@${DIGEST}`,
    environment_digest: DIGEST,
    admission_enabled: false,
    rollout_mode: "canary",
    canary_allowlist: [],
    certified_admission_off_api: {
      worker: "ultralight-api",
      version_id: OFF_API_ID,
      version_tag: `api-${SHA}-admission-off`,
    },
    active_api: {
      worker: "ultralight-api",
      version_id: OFF_API_ID,
      version_tag: `api-${SHA}-admission-off`,
      enabled: false,
      rollout_mode: "canary",
      canary_allowlist: [],
    },
    active_compute_worker: {
      worker: "galactic-compute",
      version_id: COMPUTE_ID,
      version_tag: `compute-${SHA}`,
      environment_digest: DIGEST,
      evidence_file: "active-preserve-off-compute-version.json",
      sha256: bindJson(
        directory,
        "active-preserve-off-compute-version.json",
        computeEvidence,
      ),
    },
    policy_before: {
      evidence_file: "pre-rollout-api-version.json",
      sha256: bindJson(
        directory,
        "pre-rollout-api-version.json",
        policyBefore,
      ),
      admission_enabled: false,
      rollout_mode: "canary",
      canary_allowlist: [],
    },
    policy_after: {
      evidence_file: "active-preserve-off-api-version.json",
      sha256: bindJson(
        directory,
        "active-preserve-off-api-version.json",
        policyAfter,
      ),
      admission_enabled: false,
      rollout_mode: "canary",
      canary_allowlist: [],
    },
    binding_preflight: {
      evidence_file: "compute-preflight-production.json",
      sha256: bindJson(
        directory,
        "compute-preflight-production.json",
        preflight,
      ),
      verified: true,
    },
    release_policy: {
      evidence_file: "release-policy.json",
      sha256: bindJson(directory, "release-policy.json", releasePolicy),
      artifact: "deploy_exact_candidate",
      admission: "preserve_off",
    },
    schema_migrations: {
      manifest_sha256: migrationManifestSha,
      migration_count: 2,
      schema_workflow_run_id: SCHEMA_RUN_ID,
      schema_workflow_path: ".github/workflows/supabase-production-db.yml",
      schema_deploy_job: "Deploy production schema",
    },
    artifact_storage: { public_access: false },
    artifact_retention: {
      ready_output_days: 30,
      owner_retained_output_bytes: 10_737_418_240,
      owner_retained_output_objects: 10_000,
      migration_sha256: RETENTION_SHA,
    },
    generated_at: "2026-07-31T12:00:00Z",
  };
  writeRelease(directory, release);
  return {
    directory,
    release,
    releasePolicy,
    preflight,
    policyBefore,
    policyAfter,
    computeEvidence,
  };
}

function verify(directory, expectedAdmissionMode) {
  return verifyProductionComputeReleaseEvidence({
    evidenceDirectory: directory,
    candidateSha: SHA,
    releaseTag: TAG,
    workflowRunId: RUN_ID,
    expectedAdmissionMode,
  });
}

test("accepts exact-tag schema 5 globally admitted evidence", () => {
  const { directory } = globalFixture();
  try {
    const result = verify(directory, "enable_global");
    assert.equal(result.verified, true);
    assert.equal(result.environment_digest, DIGEST);
    assert.equal(result.compute_run_id, COMPUTE_RUN_ID);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts exact-tag schema 6 preserve_off evidence", () => {
  const { directory } = preserveOffFixture();
  try {
    const result = verify(directory, "preserve_off");
    assert.equal(result.verified, true);
    assert.equal(result.admission_mode, "preserve_off");
    assert.equal(result.active_api_version_id, OFF_API_ID);
    assert.equal(result.active_compute_version_id, COMPUTE_ID);
    assert.equal(Object.hasOwn(result, "compute_run_id"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts a historical OFF snapshot without a certification principal", () => {
  const fixture = preserveOffFixture();
  try {
    fixture.policyBefore.selected_bindings =
      fixture.policyBefore.selected_bindings.filter((binding) =>
        binding.name !== "COMPUTE_CERTIFICATION_PRINCIPAL"
      );
    fixture.release.policy_before.sha256 = bindJson(
      fixture.directory,
      "pre-rollout-api-version.json",
      fixture.policyBefore,
    );
    writeRelease(fixture.directory, fixture.release);
    assert.equal(verify(fixture.directory, "preserve_off").verified, true);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("accepts a historical post-rollout OFF snapshot without a principal", () => {
  const fixture = preserveOffFixture();
  try {
    fixture.policyAfter.selected_bindings =
      fixture.policyAfter.selected_bindings.filter((binding) =>
        binding.name !== "COMPUTE_CERTIFICATION_PRINCIPAL"
      );
    fixture.release.policy_after.sha256 = bindJson(
      fixture.directory,
      "active-preserve-off-api-version.json",
      fixture.policyAfter,
    );
    writeRelease(fixture.directory, fixture.release);
    assert.equal(verify(fixture.directory, "preserve_off").verified, true);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects a nonempty post-rollout certification principal", () => {
  const fixture = preserveOffFixture();
  try {
    fixture.policyAfter.selected_bindings.find((binding) =>
      binding.name === "COMPUTE_CERTIFICATION_PRINCIPAL"
    ).text = "owner/agent";
    fixture.release.policy_after.sha256 = bindJson(
      fixture.directory,
      "active-preserve-off-api-version.json",
      fixture.policyAfter,
    );
    writeRelease(fixture.directory, fixture.release);
    assert.throws(
      () => verify(fixture.directory, "preserve_off"),
      /post-rollout/u,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects incomplete preserve_off platform and schema evidence", () => {
  const cases = [
    {
      message: /base image is not an exact reviewed digest/u,
      mutate({ directory }) {
        writeFileSync(join(directory, "base-image.txt"), "mutable:latest\n");
      },
    },
    {
      message: /artifact storage is not certified private/u,
      mutate({ release }) {
        release.artifact_storage.public_access = true;
      },
    },
    {
      message: /schema workflow run evidence does not match the exact release/u,
      mutate({ directory }) {
        bindJson(directory, "schema-workflow-run.json", {
          id: Number(SCHEMA_RUN_ID),
          event: "push",
          conclusion: "success",
          head_sha: "9".repeat(40),
          head_branch: TAG,
          path: ".github/workflows/supabase-production-db.yml",
          run_attempt: 1,
          created_at: "2026-07-31T11:00:00Z",
          updated_at: "2026-07-31T11:01:00Z",
        });
      },
    },
    {
      message: /artifact retention policy evidence does not match release\.json/u,
      mutate({ directory }) {
        bindJson(directory, "compute-artifact-retention-policy.json", {
          schema_version: 1,
          migration: RETENTION_MIGRATION.split("/").at(-1),
          ready_output_days: 30,
          owner_retained_output_bytes: 10_737_418_240,
          owner_retained_output_objects: 10_000,
          download_lease_seconds: 3_600,
          deletion_authority: "database_reconciler",
          r2_age_deletion_allowed: true,
        });
      },
    },
    {
      message: /container readiness does not prove the exact released image/u,
      mutate({ directory }) {
        bindJson(directory, "container-readiness.json", {
          schema_version: 1,
          id: "container-application-id",
          name: "galactic-compute-computestandard",
          state: "ready",
          instances: 1,
          image:
            `registry.cloudflare.com/${"1".repeat(32)}/galactic-compute@sha256:${"9".repeat(64)}`,
          version: 7,
          updated_at: "2026-07-31T11:30:00Z",
        });
      },
    },
  ];

  for (const { message, mutate } of cases) {
    const fixture = preserveOffFixture();
    try {
      mutate(fixture);
      writeRelease(fixture.directory, fixture.release);
      assert.throws(
        () => verify(fixture.directory, "preserve_off"),
        message,
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("rejects unsupported or cross-mode evidence", () => {
  const global = globalFixture();
  const preserved = preserveOffFixture();
  try {
    assert.throws(
      () => verify(global.directory, "global"),
      /expected admission mode must be preserve_off or enable_global/u,
    );
    assert.throws(
      () => verify(global.directory, "preserve_off"),
      /schema 6 release\.json has an unexpected shape/u,
    );
    assert.throws(
      () => verify(preserved.directory, "enable_global"),
      /release provenance or schema does not match the exact tag/u,
    );
  } finally {
    rmSync(global.directory, { recursive: true, force: true });
    rmSync(preserved.directory, { recursive: true, force: true });
  }
});

test("rejects preserve_off evidence with an admitted/global claim", () => {
  const { directory, release } = preserveOffFixture();
  try {
    release.admitted_smoke = {
      evidence_file: "compute-admitted-production.json",
      sha256: "f".repeat(64),
      verified: true,
    };
    writeRelease(directory, release);
    assert.throws(
      () => verify(directory, "preserve_off"),
      /schema 6 release\.json has an unexpected shape/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a changed or structurally expanded release policy", () => {
  const { directory, release, releasePolicy } = preserveOffFixture();
  try {
    writeFileSync(
      join(directory, "release-policy.json"),
      `${JSON.stringify(releasePolicy, null, 2)}\n`,
    );
    assert.throws(
      () => verify(directory, "preserve_off"),
      /release policy bytes do not match the release binding/u,
    );

    releasePolicy.unexpected = true;
    release.release_policy.sha256 = bindJson(
      directory,
      "release-policy.json",
      releasePolicy,
    );
    writeRelease(directory, release);
    assert.throws(
      () => verify(directory, "preserve_off"),
      /release-policy\.json has an unexpected shape/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects disagreement between embedded and raw preserve policy", () => {
  const { directory, release, releasePolicy } = preserveOffFixture();
  try {
    releasePolicy.compute.admission = "enable_global";
    release.release_policy.sha256 = bindJson(
      directory,
      "release-policy.json",
      releasePolicy,
    );
    writeRelease(directory, release);
    assert.throws(
      () => verify(directory, "preserve_off"),
      /release-policy\.json does not match the exact preserve_off tag/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a preserve_off active API that differs from the certified OFF API", () => {
  const { directory, release } = preserveOffFixture();
  try {
    release.active_api.version_id = API_ID;
    writeRelease(directory, release);
    assert.throws(
      () => verify(directory, "preserve_off"),
      /active API\/Compute versions do not match the OFF release/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects admission-off global evidence under enable_global mode", () => {
  const { directory, release } = globalFixture();
  try {
    release.admission_enabled = false;
    release.rollout_mode = "canary";
    writeRelease(directory, release);
    assert.throws(
      () => verify(directory, "enable_global"),
      /does not certify global admission/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a global smoke from any other workflow run", () => {
  const { directory, release, smoke } = globalFixture();
  try {
    smoke.workflow_run_id = "30170000001";
    release.admitted_smoke.sha256 = bindJson(
      directory,
      "compute-admitted-production.json",
      smoke,
    );
    writeRelease(directory, release);
    assert.throws(
      () => verify(directory, "enable_global"),
      /did not prove a clean completed execution/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a non-verifying binding preflight in either mode", () => {
  const global = globalFixture();
  const preserved = preserveOffFixture();
  try {
    for (const fixture of [global, preserved]) {
      fixture.preflight.probe.observed_public_compute_code =
        "COMPUTE_CONTROL_PLANE_UNAVAILABLE";
      fixture.release.binding_preflight.sha256 = bindJson(
        fixture.directory,
        "compute-preflight-production.json",
        fixture.preflight,
      );
      writeRelease(fixture.directory, fixture.release);
    }
    assert.throws(
      () => verify(global.directory, "enable_global"),
      /did not prove the admission-off RPC\/DB path/u,
    );
    assert.throws(
      () => verify(preserved.directory, "preserve_off"),
      /did not prove the admission-off RPC\/DB path/u,
    );
  } finally {
    rmSync(global.directory, { recursive: true, force: true });
    rmSync(preserved.directory, { recursive: true, force: true });
  }
});

test("rejects mutable image evidence or an image/digest mismatch", () => {
  const { directory, release } = globalFixture();
  try {
    release.deployed_image = "registry.cloudflare.com/account/latest";
    writeRelease(directory, release);
    assert.throws(
      () => verify(directory, "enable_global"),
      /released image and immutable environment digest do not match/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
