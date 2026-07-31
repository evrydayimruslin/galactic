import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function text(path) {
  return readFile(`${repoRoot}/${path}`, "utf8");
}

describe("Compute release workflow static guards", () => {
  it("pins every action and CLI version in canonical schema deploy workflows", async () => {
    const workflows = await Promise.all([
      text(".github/workflows/supabase-db.yml"),
      text(".github/workflows/supabase-production-db.yml"),
    ]);
    for (const workflow of workflows) {
      const actions = [...workflow.matchAll(/^\s*- uses: ([^\s#]+)/gmu)].map((match) => match[1]);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.every((action) => /@[0-9a-f]{40}$/u.test(action))).toBe(true);
      expect(workflow).not.toMatch(/version:\s*latest/u);
      expect(workflow).toMatch(/version:\s*2\.109\.1/u);
    }
    await expect(text("scripts/supabase/_lib.sh")).resolves.not.toMatch(/supabase@latest/u);
  });

  it("binds Compute release evidence to all migrations and one exact schema run", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    expect(deploy).toContain("schema_workflow_run_id:");
    expect(deploy).toContain("scripts/hash-migrations.mjs");
    expect(deploy).toContain("20260720124500_compute_capacity_conservation.sql");
    expect(deploy).toContain("20260720125000_compute_execution_recovery.sql");
    expect(deploy).toContain(".schema_version = 5");
    expect(deploy).toContain("binding_preflight = {");
    expect(deploy).toContain("preflight_sha256");
    expect(deploy).toContain("schema-workflow-job.json");
  });

  it("gates rollout on API OFF, R2 privacy, and exact Container readiness", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    const offGate = deploy.indexOf("Prove the existing API is stably admission OFF");
    const rollout = deploy.indexOf("Dry-run and deploy Compute Worker");
    expect(offGate).toBeGreaterThan(0);
    expect(rollout).toBeGreaterThan(offGate);
    expect(deploy).toContain("/domains/managed");
    expect(deploy).toContain("/domains/custom");
    expect(deploy).toContain("containers list --json");
    expect(deploy).toContain("verify-container-readiness.mjs");
  });

  it("checks the exact Worker and Durable Object-derived Container application", async () => {
    const workflow = await text(".github/workflows/compute-deploy.yml");
    expect(workflow).toContain(
      'container_application="${compute_worker}-computestandard"',
    );
    expect(workflow).toContain('"$CONTAINER_APPLICATION"');
    expect(workflow).not.toContain(
      '"$container_list" "$COMPUTE_WORKER"',
    );
  });

  it("binds the exact local image to a registry SBOM without a Docker export", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    const install = deploy.indexOf("Install dependencies");
    const build = deploy.indexOf("Build and smoke exact image");
    const push = deploy.indexOf("Push image and resolve registry digest");
    const pullCredential = deploy.indexOf(
      "Issue isolated read-only registry credential for SBOM",
    );
    const sbom = deploy.indexOf("Generate image SBOM");
    const vulnerabilityGate = deploy.indexOf(
      "Gate all critical and fixable high image vulnerabilities",
    );
    const deployConfig = deploy.indexOf(
      "Build exact-digest Compute deployment config",
    );
    expect(build).toBeGreaterThan(install);
    expect(push).toBeGreaterThan(build);
    expect(pullCredential).toBeGreaterThan(push);
    expect(sbom).toBeGreaterThan(pullCredential);
    expect(vulnerabilityGate).toBeGreaterThan(sbom);
    expect(deployConfig).toBeGreaterThan(vulnerabilityGate);

    const buildStep = deploy.slice(build, push);
    expect(buildStep).toContain(
      "docker builder prune --all --force",
    );
    expect(buildStep).toContain("local-image-id.txt");
    expect(buildStep).toContain(
      "docker image inspect --format '{{.Id}}'",
    );
    expect(buildStep).toContain("base-image-id.txt");
    expect(buildStep).not.toContain("docker system prune");
    expect(buildStep).not.toContain("docker image prune");

    const pushStep = deploy.slice(push, pullCredential);
    expect(pushStep).toContain("remote_config_digest");
    expect(pushStep).toContain("local_image_id");
    expect(pushStep).toContain(
      '"The pushed manifest config does not match the exact local image."',
    );
    expect(pushStep).toContain(
      'docker image rm --force "$local_image_id"',
    );
    expect(pushStep).toContain(
      'docker image rm --force "$base_image_id"',
    );
    expect(pushStep).toContain(
      "docker logout registry.cloudflare.com",
    );
    expect(pushStep.indexOf("remote_config_digest")).toBeLessThan(
      pushStep.indexOf('docker image rm --force "$local_image_id"'),
    );
    expect(pushStep).not.toContain("docker image prune");
    expect(pushStep).not.toContain("docker system prune");

    const credentialStep = deploy.slice(pullCredential, sbom);
    expect(credentialStep).toContain("--pull");
    expect(credentialStep).not.toContain("--push");
    expect(credentialStep).toContain("--expiration-minutes 60");
    expect(credentialStep).toContain("SBOM_DOCKER_CONFIG");

    const sbomStep = deploy.slice(sbom, vulnerabilityGate);
    expect(sbomStep).toContain(
      'expected_image_id="$(cat "$EVIDENCE_DIR/local-image-id.txt")"',
    );
    expect(sbomStep).toContain(
      '"$syft_dir/syft" "registry:$REMOTE_IMAGE"',
    );
    expect(sbomStep).not.toContain('"docker:$LOCAL_IMAGE_TAG"');
    expect(sbomStep).toContain("image.syft.json");
    expect(sbomStep).toContain(
      ".source.metadata.manifestDigest == $manifest_digest",
    );
    expect(sbomStep).toContain(
      ".source.metadata.imageID == $image_id",
    );
    expect(sbomStep).toContain('"$EVIDENCE_DIR/sbom-source.json"');
    expect(sbomStep).not.toContain("docker image inspect");
    expect(sbomStep).toContain(
      'rm -rf -- "$SBOM_DOCKER_CONFIG"',
    );
    expect(deploy).toContain(
      'rm -rf -- "$RUNNER_TEMP/compute-sbom-docker"',
    );
  });

  it("keeps emergency disable source-immutable and free of enable authority", async () => {
    const admission = await text(".github/workflows/compute-admission.yml");
    const resolveStart = admission.indexOf("Resolve certified OFF version from Compute release evidence");
    const certifiedCheckout = admission.indexOf("Checkout certified release source for fail-safe disable");
    const toolchainInstall = admission.indexOf("Install the certified release API toolchain");
    const nextStep = admission.indexOf("Verify immutable certified versions", resolveStart);
    const resolveStep = admission.slice(resolveStart, nextStep);
    expect(certifiedCheckout).toBeGreaterThan(resolveStart);
    expect(toolchainInstall).toBeGreaterThan(certifiedCheckout);
    expect(nextStep).toBeGreaterThan(toolchainInstall);
    expect(admission).toContain("ref: ${{ steps.resolve_release.outputs.release_sha }}");
    expect(admission).toContain('pushd "$API_SOURCE_ROOT/api"');
    expect(resolveStep).toContain("admitted_smoke.sha256");
    expect(resolveStep).toContain("binding_preflight.sha256");
    expect(admission).not.toContain("COMPUTE_ENABLED:1");
    expect(admission).not.toContain("inputs.action");
    expect(admission).not.toContain("required_reviewers");
    expect(admission).toContain(
      'versions deploy "$CERTIFIED_OFF_API_VERSION_ID@100%"',
    );
  });

  it("enables globally only after an exact OFF baseline and compensates any ambiguous smoke", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    const certifyOff = deploy.indexOf("Certify admission-off API and exact Compute digest");
    const refreshFixture = deploy.indexOf(
      "Review, promote, and verify exact fixed Compute smoke Agent while admission is off",
    );
    const bindingPreflight = deploy.indexOf(
      "Verify the Compute binding path while admission is off",
    );
    const globalDryRun = deploy.indexOf(
      "Typecheck and dry-run global admission",
    );
    const enableGlobal = deploy.indexOf("Enable global admission from the exact certified pair");
    const verifyGlobal = deploy.indexOf("Verify exact global admission postcondition");
    const admittedSmoke = deploy.indexOf("Run one bounded admitted Compute job");
    const postSmokeFence = deploy.indexOf("Fence exact live versions after admitted smoke");
    const compensation = deploy.indexOf("Promote certified OFF version after any ambiguous global enable");
    const finalize = deploy.indexOf("Finalize globally enabled release evidence");
    expect(certifyOff).toBeGreaterThan(0);
    expect(refreshFixture).toBeGreaterThan(certifyOff);
    expect(bindingPreflight).toBeGreaterThan(refreshFixture);
    expect(globalDryRun).toBeGreaterThan(bindingPreflight);
    expect(enableGlobal).toBeGreaterThan(globalDryRun);
    expect(verifyGlobal).toBeGreaterThan(enableGlobal);
    expect(admittedSmoke).toBeGreaterThan(verifyGlobal);
    expect(postSmokeFence).toBeGreaterThan(admittedSmoke);
    expect(compensation).toBeGreaterThan(postSmokeFence);
    expect(finalize).toBeGreaterThan(compensation);
    expect(deploy).toContain('--tag "api-$GITHUB_SHA-admission-off"');
    expect(deploy).toContain("--var COMPUTE_ROLLOUT_MODE:global");
    expect(deploy).toContain("steps.post_smoke_fence.outcome != 'success'");
    expect(deploy).toContain('versions deploy "$off_api_version_id@100%"');
    expect(deploy).toContain("compute-admitted-$REQUESTED_TARGET.json");
    expect(deploy).toContain("compute-preflight-$REQUESTED_TARGET.json");
    const preflightStep = deploy.slice(bindingPreflight, globalDryRun);
    expect(preflightStep).toContain(
      "scripts/smoke/with-staging-owner-session.mjs",
    );
    expect(preflightStep).toContain(
      "scripts/smoke/compute-admitted-smoke.mjs --preflight-only",
    );
    expect(preflightStep).toContain(
      '"00000000-0000-4000-8000-000000000000"',
    );
    expect(preflightStep).toContain(
      '"COMPUTE_RUN_NOT_FOUND"',
    );
    expect(preflightStep).not.toContain("COMPUTE_ENABLED:1");
    expect(preflightStep).not.toContain("--token");
    expect(preflightStep).not.toContain("--app-id");
    expect(preflightStep).not.toContain("GALACTIC_OWNER_ACCESS_TOKEN:");
    const fixtureStep = deploy.slice(refreshFixture, enableGlobal);
    const fixtureScript = await text(
      "scripts/smoke/interface-deploy-smoke.mjs",
    );
    expect(fixtureStep).toContain(
      "scripts/smoke/with-staging-owner-session.mjs",
    );
    expect(fixtureStep).toContain("--promote-reviewed");
    expect(fixtureStep).toContain("--reviewed-permission compute:exec");
    expect(fixtureStep).toContain("--reviewed-function run_compute_smoke");
    expect(fixtureStep).toContain(
      "--reviewed-compute-profile developer-v1",
    );
    expect(fixtureStep).toContain("--reviewed-compute-tools shell");
    expect(fixtureStep).toContain("--reviewed-compute-secrets none");
    expect(fixtureStep).not.toContain("--token");
    expect(fixtureStep).not.toContain("--app-id");
    expect(fixtureStep).not.toContain("GALACTIC_OWNER_ACCESS_TOKEN:");
    expect(fixtureStep).not.toMatch(/versions\/.*DELETE/iu);
    expect(fixtureScript).toContain("const toolToken = token;");
    expect(fixtureScript).toContain("fixtureRefreshPlan({");
    expect(fixtureScript).toContain("callTool('gx.upload', uploadArgs)");
    expect(fixtureScript).not.toMatch(
      /const toolToken\s*=\s*reviewedPromotion\.ownerAccessToken/u,
    );
    expect(fixtureScript).not.toMatch(/method:\s*'DELETE'/u);
  });
});
