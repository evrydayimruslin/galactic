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
    expect(deploy).toContain(".schema_version = 6");
    expect(deploy).toContain("binding_preflight = {");
    expect(deploy).toContain("preflight_sha256");
    expect(deploy).toContain("schema-workflow-job.json");
  });

  it("locks production Compute admission to the immutable release policy", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    const launchGate = await text(
      ".github/workflows/launch-gate-production.yml",
    );
    const policy = JSON.parse(await text("release-policy.json"));
    expect(policy).toEqual({
      schema_version: 1,
      release_tag: "v0.4.73",
      compute: {
        artifact: "deploy_exact_candidate",
        admission: "preserve_off",
      },
    });
    expect(deploy).toMatch(
      /admission_mode:\n\s+description:[^\n]+\n\s+required: true\n\s+default: preserve_off\n\s+type: choice\n\s+options:\n\s+- preserve_off\n\s+- enable_global/u,
    );
    expect(deploy).not.toMatch(/^\s+- global$/mu);
    expect(deploy).toContain(
      '[ "$REQUESTED_ADMISSION_MODE" != "$policy_admission_mode" ]',
    );
    expect(deploy).toContain(
      '[ "$GITHUB_REF" != "refs/tags/$policy_release_tag" ]',
    );
    expect(deploy).toContain(
      '[ "$GITHUB_REF_NAME" != "$policy_release_tag" ]',
    );
    expect(deploy).toContain(
      'cp "$release_policy" "$EVIDENCE_DIR/release-policy.json"',
    );
    expect(deploy).toContain(
      'sha256sum "$EVIDENCE_DIR/release-policy.json"',
    );
    expect(launchGate).toContain("Validate immutable release policy");
    expect(launchGate).toContain(
      '${{ steps.policy.outputs.admission_mode }}',
    );
    expect(launchGate).toContain("--timeout-seconds 12600");
    expect(launchGate).toContain("timeout-minutes: 220");
  });

  it("rolls back the dedicated gx.test session Worker with a failed API rollout", async () => {
    const apiDeploy = await text(".github/workflows/api-deploy.yml");
    for (const target of ["staging", "production"]) {
      const jobStart = apiDeploy.indexOf(`deploy_${target}:`);
      const nextJob = apiDeploy.indexOf("\n  deploy_", jobStart + 1);
      const job = apiDeploy.slice(
        jobStart,
        nextJob === -1 ? apiDeploy.length : nextJob,
      );
      expect(jobStart).toBeGreaterThan(0);
      expect(job).toContain(
        `Capture prior stable ${target} gx.test session Worker`,
      );
      expect(job).toContain("id: capture_gx_test_session");
      expect(job).toContain(
        "scripts/release/classify-cloudflare-worker-lookup.mjs",
      );
      expect(job).toContain('echo "had_prior=false"');
      expect(job).toContain('echo "had_prior=true"');
      expect(job).toContain('echo "version_id=$version_id"');
      expect(job).toContain("id: deploy_gx_test_session");
      expect(job).toContain('echo "attempted=true"');
      expect(job).toContain("id: verify_gx_test_session");
      expect(job).toContain(
        '.resources.script_runtime.exports.GxTestSession.type == "durable-object"',
      );
      expect(job).toContain(
        '.resources.script_runtime.exports.GxTestSession.storage == "sqlite"',
      );
      expect(job).toContain(
        `Verify still-live ${target} API with candidate gx.test session Worker`,
      );
      expect(job).toContain(
        "id: verify_gx_test_session_compatibility",
      );
      if (target === "staging") {
        expect(job).toMatch(
          /if: >-\n\s+steps\.capture_gx_test_session\.outputs\.had_prior == 'true' &&\n\s+github\.event_name != 'workflow_dispatch'/u,
        );
      } else {
        expect(job).toContain(
          "if: steps.capture_gx_test_session.outputs.had_prior == 'true'",
        );
      }
      expect(job).toContain(
        `Restore prior ${target} gx.test session Worker after a failed rollout`,
      );
      expect(job).toContain("id: restore_api");
      expect(job).toContain(
        "steps.capture_gx_test_session.outputs.had_prior == 'true'",
      );
      expect(job).toContain(
        "steps.deploy_gx_test_session.outputs.attempted == 'true'",
      );
      expect(job).toContain(
        "steps.deploy_worker.outputs.attempted != 'true'",
      );
      expect(job).toContain(
        "steps.restore_api.outcome == 'success'",
      );
      expect(job).toContain(
        'echo "PREVIOUS_API_VERSION_ID=$version_id" >> "$GITHUB_ENV"',
      );
      expect(job).not.toContain(
        "steps.compute_target.outputs.mode == 'bound' &&\n" +
          "              steps.deploy_worker.outputs.attempted == 'true'",
      );
      expect(job).toContain(
        'if [ "${{ steps.compute_target.outputs.mode }}" = "bound" ]; then',
      );
      expect(job).toContain(
        `pre-bootstrap ${target} "$status" "$version"`,
      );
      for (const failedStep of [
        "deploy_gx_test_session",
        "verify_gx_test_session",
        "verify_gx_test_session_compatibility",
        "deploy_worker",
        "verify_deploy",
        "verify_gx_test_containment",
      ]) {
        expect(job).toContain(
          `steps.${failedStep}.outcome != 'success'`,
        );
      }
      expect(job).toContain(
        '"$PREVIOUS_GX_TEST_SESSION_VERSION_ID@100%"',
      );
      expect(job).toContain(
        ".versions[0].version_id == $id",
      );
      expect(
        job.indexOf(`Restore prior ${target} gx.test session Worker`),
      ).toBeGreaterThan(
        job.indexOf(`Restore prior ${target} API`),
      );
      expect(
        job.indexOf(
          `Verify still-live ${target} API with candidate gx.test session Worker`,
        ),
      ).toBeLessThan(
        job.indexOf(`Deploy ${target} worker`),
      );
    }
  });

  it("binds canonical Supabase secrets atomically to manual staging deploys", async () => {
    const apiDeploy = await text(".github/workflows/api-deploy.yml");
    const stagingStart = apiDeploy.indexOf("  deploy_staging:");
    const productionStart = apiDeploy.indexOf("  deploy_production:");
    const stagingJob = apiDeploy.slice(stagingStart, productionStart);
    const productionJob = apiDeploy.slice(productionStart);
    const prepareStep =
      "Prepare canonical staging Supabase secrets for candidate deploy";
    const prepareStart = stagingJob.indexOf(prepareStep);
    const prepareEnd = stagingJob.indexOf("\n      - name:", prepareStart);
    const prepareBlock = stagingJob.slice(prepareStart, prepareEnd);

    expect(stagingStart).toBeGreaterThan(0);
    expect(productionStart).toBeGreaterThan(stagingStart);
    expect(prepareStart).toBeGreaterThan(0);
    expect(stagingJob).toMatch(
      /Prepare canonical staging Supabase secrets for candidate deploy\n\s+if: github\.event_name == 'workflow_dispatch'/u,
    );
    expect(prepareBlock).toContain(
      "STAGING_SUPABASE_SECRETS_FILE: ${{ runner.temp }}/galactic-staging-supabase-secrets.json",
    );
    expect(prepareBlock).toContain("--prepare-deploy");
    expect(prepareBlock).not.toContain("ULTRALIGHT_TOKEN");
    expect(prepareBlock).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(stagingJob).toContain(
      'secret_file="$RUNNER_TEMP/galactic-staging-supabase-secrets.json"',
    );
    expect(stagingJob).toContain(
      `[ "$(stat -c '%a' "$secret_file")" = "600" ]`,
    );
    expect(stagingJob).toContain(
      'secret_args=(--secrets-file "$secret_file")',
    );
    expect(stagingJob).toContain(
      '"${secret_args[@]}" "${compute_args[@]}"',
    );
    expect(stagingJob).toMatch(
      /Remove prepared staging Supabase secret file\n\s+if: always\(\) && github\.event_name == 'workflow_dispatch'/u,
    );
    expect(stagingJob).toContain("--cleanup-deploy");
    expect(stagingJob).not.toContain("--apply");
    expect(productionJob).not.toContain(prepareStep);
    expect(productionJob).not.toContain(
      "reconcile-staging-supabase-secrets.mjs",
    );
    expect(productionJob).not.toContain(
      "galactic-staging-supabase-secrets.json",
    );
  });

  it("gates rollout on API OFF, R2 privacy, and exact Container readiness", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    const offGate = deploy.indexOf(
      "Capture the stable API and Compute rollback pair before mutation",
    );
    const rollout = deploy.indexOf("Dry-run and deploy Compute Worker");
    expect(offGate).toBeGreaterThan(0);
    expect(rollout).toBeGreaterThan(offGate);
    expect(deploy).toContain("/domains/managed");
    expect(deploy).toContain("/domains/custom");
    expect(deploy).toContain("containers list --json");
    expect(deploy).toContain("verify-container-readiness.mjs");
  });

  it("creates a compatible admission-OFF rollback baseline before Compute mutation", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    const inspect = deploy.indexOf(
      "Inspect the current-source API and Compute pair",
    );
    const container = deploy.indexOf(
      "Verify the current exact container before any API mutation",
    );
    const upload = deploy.indexOf(
      "Upload and verify a no-traffic admission-OFF API bridge",
    );
    const promote = deploy.indexOf(
      "Promote the exact verified admission-OFF API bridge",
    );
    const verify = deploy.indexOf(
      "Verify the promoted admission-OFF API bridge",
    );
    const preflight = deploy.indexOf(
      "Verify the admission-OFF binding path before Compute mutation",
    );
    const reassert = deploy.indexOf(
      "Reassert the exact OFF bridge after an ambiguous promotion",
    );
    const capture = deploy.indexOf(
      "Capture the stable API and Compute rollback pair before mutation",
    );
    const build = deploy.indexOf("Build and smoke exact image");
    const inspectBlock = deploy.slice(inspect, container);
    const uploadBlock = deploy.slice(upload, promote);
    const promoteBlock = deploy.slice(promote, verify);
    const verifyBlock = deploy.slice(verify, preflight);
    const preflightBlock = deploy.slice(preflight, reassert);
    const reassertBlock = deploy.slice(reassert, capture);

    expect(inspect).toBeGreaterThan(0);
    expect(container).toBeGreaterThan(inspect);
    expect(upload).toBeGreaterThan(container);
    expect(promote).toBeGreaterThan(upload);
    expect(verify).toBeGreaterThan(promote);
    expect(preflight).toBeGreaterThan(verify);
    expect(reassert).toBeGreaterThan(preflight);
    expect(capture).toBeGreaterThan(reassert);
    expect(build).toBeGreaterThan(capture);
    expect(inspectBlock).toContain("id: inspect_off_bridge");
    expect(inspectBlock).toContain(
      'current "$REQUESTED_TARGET" "api-$GITHUB_SHA"',
    );
    expect(inspectBlock).toContain(
      'if [ "$REQUESTED_TARGET" = "production" ]',
    );
    expect(inspectBlock).toContain(
      "Production must already have a current-source admission-OFF rollback pair.",
    );
    expect(uploadBlock).toContain("id: upload_off_bridge");
    expect(uploadBlock).toContain("inputs.target == 'staging'");
    expect(uploadBlock).toContain(
      "steps.inspect_off_bridge.outputs.policy == 'global'",
    );
    expect(uploadBlock).toContain("npx wrangler versions upload");
    expect(uploadBlock).toContain("WRANGLER_OUTPUT_FILE_PATH");
    expect(uploadBlock).toContain(
      'node "$GITHUB_WORKSPACE/scripts/release/verify-api-compute-off-bridge.mjs"',
    );
    expect(uploadBlock).toContain(
      'upload-output "$upload_output" "$API_WORKER" staging',
    );
    expect(uploadBlock).toContain('--tag "$bridge_tag"');
    expect(uploadBlock).toContain("--var COMPUTE_ENABLED:0");
    expect(uploadBlock).toContain(
      '--var "COMPUTE_ENVIRONMENT_DIGEST:$CURRENT_COMPUTE_DIGEST"',
    );
    expect(uploadBlock).toContain("--var COMPUTE_ROLLOUT_MODE:canary");
    expect(uploadBlock).toContain("--var COMPUTE_CANARY_ALLOWLIST:");
    expect(uploadBlock).toContain("--keep-vars --strict");
    expect(uploadBlock).toContain(
      'uploaded "$REQUESTED_TARGET" "$current_state"',
    );
    expect(uploadBlock).toContain('echo "verified=true"');
    expect(uploadBlock).not.toContain("npx wrangler deploy");
    expect(promoteBlock).toContain("id: promote_off_bridge");
    expect(promoteBlock).toContain(
      'cmp --silent',
    );
    expect(promoteBlock).toContain(
      'echo "attempted=true" >> "$GITHUB_OUTPUT"',
    );
    expect(promoteBlock).toContain(
      'npx wrangler versions deploy "$BRIDGE_VERSION_ID@100%"',
    );
    expect(promoteBlock.indexOf('echo "attempted=true"')).toBeLessThan(
      promoteBlock.indexOf(
        'npx wrangler versions deploy "$BRIDGE_VERSION_ID@100%"',
      ),
    );
    expect(verifyBlock).toContain(
      'promoted "$REQUESTED_TARGET" "$bridge_state"',
    );
    expect(verifyBlock).toContain("for read_attempt in {1..12}");
    expect(verifyBlock).toContain(
      '.versions[0].version_id == $id',
    );
    expect(verifyBlock).toContain("verify-container-readiness.mjs");
    expect(preflightBlock).toContain(
      "compute-admitted-smoke.mjs --preflight-only",
    );
    expect(preflightBlock).toContain(
      '.fixture_policy.enabled == false',
    );
    expect(reassertBlock).toContain(
      "steps.upload_off_bridge.outputs.verified == 'true'",
    );
    expect(reassertBlock).toContain(
      "steps.promote_off_bridge.outputs.attempted == 'true'",
    );
    expect(reassertBlock).toContain(
      "steps.verify_off_binding_before_mutation.outcome != 'success'",
    );
    expect(reassertBlock).toContain(
      'npx wrangler versions deploy "$BRIDGE_VERSION_ID@100%"',
    );
    expect(reassertBlock).toContain(
      "for promotion_attempt in {1..3}",
    );
    expect(reassertBlock).toContain("set +e");
    expect(reassertBlock).toContain('promotion_rc="${PIPESTATUS[0]}"');
    expect(reassertBlock).toContain(
      "CRITICAL: the exact admission-OFF API bridge could not be reasserted.",
    );
    expect(reassertBlock).toContain(
      'promoted "$REQUESTED_TARGET"',
    );
    expect(reassertBlock).not.toContain("PRIOR_API_VERSION_ID");
    expect(deploy.slice(inspect, capture)).not.toContain(
      "--var COMPUTE_ENABLED:1",
    );
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

  it("scans the exact Compute CI rootfs without exporting or copying the image", async () => {
    const workflow = await text(".github/workflows/compute-ci.yml");
    const build = workflow.indexOf("Build immutable-input image");
    const smoke = workflow.indexOf("Smoke actual image");
    const prepare = workflow.indexOf("Prepare exact image for no-copy SBOM");
    const sbom = workflow.indexOf(
      "Generate no-copy rootfs SBOM and provenance evidence",
    );
    const cleanup = workflow.indexOf("Release exact CI image storage");
    const vulnerabilityGate = workflow.indexOf(
      "Gate all critical and fixable high image vulnerabilities",
    );
    expect(smoke).toBeGreaterThan(build);
    expect(prepare).toBeGreaterThan(smoke);
    expect(sbom).toBeGreaterThan(prepare);
    expect(cleanup).toBeGreaterThan(sbom);
    expect(vulnerabilityGate).toBeGreaterThan(cleanup);

    const prepareStep = workflow.slice(prepare, sbom);
    expect(prepareStep).toContain("docker builder prune --all --force");
    expect(prepareStep).toContain("pre-sbom-prune-disk.txt");
    expect(prepareStep).toContain("post-sbom-prune-disk.txt");
    expect(prepareStep).not.toContain("docker system prune");
    expect(prepareStep).not.toContain("docker image prune");

    const sbomStep = workflow.slice(sbom, cleanup);
    expect(sbomStep).toContain('docker run --rm');
    expect(sbomStep).toContain('--read-only');
    expect(sbomStep).toContain('--network none');
    expect(sbomStep).toContain('--cap-drop ALL');
    expect(sbomStep).toContain('--cap-add DAC_READ_SEARCH');
    expect(
      [...sbomStep.matchAll(/--cap-add ([A-Z_]+)/gu)].map(
        (match) => match[1],
      ),
    ).toEqual(["DAC_READ_SEARCH"]);
    expect(sbomStep).toContain('--security-opt no-new-privileges=true');
    expect(sbomStep).toContain('--user 0:0');
    expect(sbomStep).toContain(
      '--tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m',
    );
    expect(sbomStep).toContain(
      'src=$syft_dir/syft,dst=/__galactic_syft,readonly',
    );
    expect(sbomStep).toContain(
      'install -d -m 0777 "$syft_output_dir"',
    );
    expect(sbomStep).toContain(
      'src=$syft_output_dir,dst=/__galactic_output',
    );
    expect(sbomStep).not.toContain(
      'src=$EVIDENCE_DIR,dst=/__galactic',
    );
    expect(sbomStep).toContain('--entrypoint /__galactic_syft');
    expect(sbomStep).toContain('"$expected_image_id"');
    expect(sbomStep).toContain('"dir:/"');
    expect(sbomStep).toContain("--exclude './proc/**'");
    expect(sbomStep).not.toContain('"docker:$IMAGE_TAG"');
    expect(sbomStep).not.toContain('"registry:');
    expect(sbomStep).not.toContain("docker save");
    expect(sbomStep).not.toContain("docker push");
    expect(sbomStep).toContain(
      '-o "syft-json=/__galactic_output/image.syft.json"',
    );
    expect(sbomStep).toContain(
      '-o "spdx-json=/__galactic_output/image.raw.spdx.json"',
    );
    expect(sbomStep).toContain(
      'mv "$syft_output_dir/image.syft.json" "$EVIDENCE_DIR/image.syft.json"',
    );
    expect(sbomStep).toContain('rmdir "$syft_output_dir"');
    expect(sbomStep).toContain("image.syft.json");
    expect(sbomStep).toContain(
      '.source.type == "directory"',
    );
    expect(sbomStep).toContain(".source.version == $source_version");
    expect(sbomStep).toContain("post-scan-image-id.txt");
    expect(sbomStep).toContain(
      'sbom_mode: "mounted_rootfs_ci_vulnerability_inventory"',
    );
    expect(sbomStep).toContain("release_attestation: false");

    const cleanupStep = workflow.slice(cleanup, vulnerabilityGate);
    expect(cleanupStep).toContain('docker image rm --force "$local_image_id"');
    expect(cleanupStep).toContain('docker image rm --force "$base_image_id"');
    expect(cleanupStep).not.toContain("docker system prune");
    expect(cleanupStep).not.toContain("docker image prune");
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
    expect(resolveStep).toContain(".schema_version == 6");
    expect(resolveStep).toContain('.admission_mode == "preserve_off"');
    expect(resolveStep).toContain('.release_mode == "policy_preserved"');
    expect(resolveStep).toContain(
      '.active_api.version_id ==\n                   .certified_admission_off_api.version_id',
    );
    expect(resolveStep).toContain(
      '.release_policy.evidence_file == "release-policy.json"',
    );
    expect(resolveStep).toContain(
      'actual_policy_sha256="$(sha256sum "$release_policy_path"',
    );
    expect(resolveStep).toContain(
      '[ "$release_schema_version" = "5" ] ||',
    );
    expect(resolveStep).toContain(
      '[ "$release_schema_version" = "6" ]',
    );
    expect(resolveStep).toContain(
      'cp "$release_dir/release-policy.json"',
    );
    expect(resolveStep).toContain(
      "release_admission_mode=preserve_off",
    );
    expect(admission).not.toContain("COMPUTE_ENABLED:1");
    expect(admission).not.toContain("inputs.action");
    expect(admission).not.toContain("required_reviewers");
    expect(admission).toContain(
      'versions deploy "$CERTIFIED_OFF_API_VERSION_ID@100%"',
    );
  });

  it("runs Compute last and restores the captured stable pair after any mutation failure", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    const waitForDeploys = deploy.indexOf(
      "Wait for every exact-tag production deploy before Compute mutation",
    );
    const captureStable = deploy.indexOf(
      "Capture the stable API and Compute rollback pair before mutation",
    );
    const deployCompute = deploy.indexOf("Dry-run and deploy Compute Worker");
    const certifyOff = deploy.indexOf("Certify admission-off API and exact Compute digest");
    const refreshFixture = deploy.indexOf(
      "Review, promote, and verify exact fixed Compute smoke Agent while admission is off",
    );
    const bindingPreflight = deploy.indexOf(
      "Verify the Compute binding path while admission is off",
    );
    const preserveOff = deploy.indexOf(
      "Finalize policy-preserving admission-OFF release evidence",
    );
    const globalDryRun = deploy.indexOf(
      "Typecheck and dry-run global admission",
    );
    const enableGlobal = deploy.indexOf("Enable global admission from the exact certified pair");
    const verifyGlobal = deploy.indexOf("Verify exact global admission postcondition");
    const admittedSmoke = deploy.indexOf("Run one bounded admitted Compute job");
    const postSmokeFence = deploy.indexOf("Fence exact live versions after admitted smoke");
    const finalize = deploy.indexOf("Finalize globally enabled release evidence");
    const compensation = deploy.indexOf(
      "Restore the stable API and Compute pair after any release failure",
    );
    expect(waitForDeploys).toBeGreaterThan(0);
    expect(captureStable).toBeGreaterThan(waitForDeploys);
    expect(deployCompute).toBeGreaterThan(captureStable);
    expect(certifyOff).toBeGreaterThan(0);
    expect(certifyOff).toBeGreaterThan(deployCompute);
    expect(refreshFixture).toBeGreaterThan(certifyOff);
    expect(bindingPreflight).toBeGreaterThan(refreshFixture);
    expect(preserveOff).toBeGreaterThan(bindingPreflight);
    expect(globalDryRun).toBeGreaterThan(preserveOff);
    expect(enableGlobal).toBeGreaterThan(globalDryRun);
    expect(verifyGlobal).toBeGreaterThan(enableGlobal);
    expect(admittedSmoke).toBeGreaterThan(verifyGlobal);
    expect(postSmokeFence).toBeGreaterThan(admittedSmoke);
    expect(finalize).toBeGreaterThan(postSmokeFence);
    expect(compensation).toBeGreaterThan(finalize);
    expect(deploy).toContain('--tag "api-$GITHUB_SHA-admission-off"');
    expect(deploy).toContain("--var COMPUTE_ROLLOUT_MODE:global");
    expect(deploy).toContain("steps.capture_stable.outputs.captured == 'true'");
    expect(deploy).toContain(
      "steps.deploy_compute.outputs.attempted == 'true'",
    );
    expect(deploy).toContain(
      "steps.certify_off.outputs.attempted == 'true'",
    );
    expect(deploy).toContain(
      "steps.enable_global.outputs.attempted == 'true'",
    );
    expect(deploy).toContain(
      'versions deploy "$PRE_ROLLOUT_API_VERSION_ID@100%"',
    );
    expect(deploy).toContain(
      'versions deploy "$PRE_ROLLOUT_COMPUTE_VERSION_ID@100%"',
    );
    expect(deploy).toContain(
      '"$EVIDENCE_DIR/pre-rollout-container-readiness.json"',
    );
    expect(deploy).toContain(
      "PRE_ROLLOUT_CONTAINER_IMAGE=$pre_rollout_image",
    );
    expect(deploy).toContain("ROLLBACK_CONFIG=$rollback_config");
    expect(deploy).toContain(
      '--config "$ROLLBACK_CONFIG"',
    );
    expect(deploy).toContain("--containers-rollout=gradual");
    expect(deploy).toContain(
      '"$EVIDENCE_DIR/compensating-container-readiness.json"',
    );
    expect(deploy).toContain("compensating-stable-pair.json");
    expect(deploy).not.toContain(
      "Promote certified OFF version after any ambiguous global enable",
    );
    expect(deploy).toContain("compute-admitted-$REQUESTED_TARGET.json");
    expect(deploy).toContain("compute-preflight-$REQUESTED_TARGET.json");
    for (const [workflow, name] of [
      ["supabase-production-db.yml", "Supabase Production DB"],
      ["api-deploy.yml", "API Deploy"],
      ["launch-web-deploy.yml", "Launch Web Deploy"],
      ["interfaces-worker-deploy.yml", "Interfaces Worker Deploy"],
    ]) {
      expect(deploy).toContain(
        `wait_for_deploy ${workflow} "${name}"`,
      );
    }
    const preflightStep = deploy.slice(bindingPreflight, preserveOff);
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
    const preserveStep = deploy.slice(preserveOff, globalDryRun);
    expect(preserveStep).toContain(
      "if: inputs.admission_mode == 'preserve_off'",
    );
    expect(preserveStep).toContain(".schema_version = 6");
    expect(preserveStep).toContain('.admission_mode = "preserve_off"');
    expect(preserveStep).toContain('.release_mode = "policy_preserved"');
    expect(preserveStep).toContain("policy_before = {");
    expect(preserveStep).toContain("policy_after = {");
    expect(preserveStep).toContain("release_policy = {");
    expect(preserveStep).toContain(
      "active-preserve-off-compute-version.json",
    );
    expect(preserveStep).not.toContain("COMPUTE_ENABLED:1");
    expect(preserveStep).not.toContain(
      "scripts/smoke/compute-admitted-smoke.mjs\n",
    );
    for (const [start, end] of [
      [globalDryRun, enableGlobal],
      [enableGlobal, verifyGlobal],
      [verifyGlobal, admittedSmoke],
      [admittedSmoke, postSmokeFence],
      [postSmokeFence, finalize],
    ]) {
      expect(deploy.slice(start, end)).toContain("enable_global");
    }
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

  it("launch gate fences exact live API, Compute, and gx.test evidence after every deploy", async () => {
    const launchGate = await text(
      ".github/workflows/launch-gate-production.yml",
    );
    const gateHelper = await text(
      "scripts/release/check-production-launch-gate.mjs",
    );
    const evidence = launchGate.indexOf(
      "Verify exact-tag Compute release evidence",
    );
    const liveFence = launchGate.indexOf(
      "Verify exact live API, Compute, and gx.test session versions after every deploy",
    );
    expect(liveFence).toBeGreaterThan(evidence);
    expect(launchGate).toContain("environment: production");
    expect(launchGate).toContain(
      "verify-live-production-compute-state.mjs",
    );
    expect(launchGate).toContain(
      "/tmp/production-live-compute-state-verification.json",
    );
    expect(launchGate).toContain(
      "--name galactic-gx-test-session --json",
    );
    expect(launchGate).toContain(
      'npx wrangler containers list --json > "$container_list"',
    );
    expect(launchGate).toContain(
      "Verify final production gx.test containment",
    );
    expect(launchGate).toContain(
      "/tmp/production-gx-test-containment.json",
    );
    expect(launchGate).toContain(
      "Verify final production Compute artifact privacy",
    );
    expect(launchGate).toContain(
      "compute-worker/scripts/verify-r2-private.mjs",
    );
    expect(launchGate).toContain(
      "/r2/buckets/galactic-compute-artifacts/domains/managed",
    );
    expect(launchGate).toContain(
      "/r2/buckets/galactic-compute-artifacts/domains/custom",
    );
    expect(gateHelper).toContain('name: "Interfaces Worker Deploy"');
  });
});
