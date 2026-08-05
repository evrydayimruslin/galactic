import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function text(path) {
  return readFile(`${repoRoot}/${path}`, "utf8");
}

describe("Compute release workflow static guards", () => {
  it("refreshes Worker code without rebuilding or rolling the certified Container", async () => {
    const refresh = await text(".github/workflows/compute-worker-refresh.yml");
    expect(refresh).toContain("compute_release_run_id:");
    expect(refresh).toContain("predecessor_worker_refresh_run_id:");
    expect(refresh).toContain(
      "verify-compute-rollout-release-evidence.mjs",
    );
    expect(refresh).toContain("--containers-rollout=none");
    expect(refresh).toContain(
      'git merge-base --is-ancestor "$predecessor_sha" "$GITHUB_SHA"',
    );
    expect(refresh).toContain(
      "Live Compute does not match the verified predecessor Worker refresh",
    );
    expect(refresh).not.toMatch(/--containers-rollout=(?:gradual|immediate)/u);
    expect(refresh).not.toMatch(/docker (?:build|push)/u);
    expect(refresh).toContain("before-worker-fingerprint.json");
    expect(refresh).toContain("after-worker-fingerprint.json");
    expect(refresh).toContain("before-container-readiness.json");
    expect(refresh).toContain("after-container-readiness.json");
    expect(refresh).toContain(
      'versions deploy "$PREVIOUS_COMPUTE_VERSION_ID@100%"',
    );
    expect(refresh).toContain("steps.upload_evidence.outcome != 'success'");
  });

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
    expect(deploy).not.toContain(".schema_version = 5");
    expect(deploy).toContain(".schema_version = 6");
    expect(deploy).toContain("binding_preflight = {");
    expect(deploy).toContain("preflight_sha256");
    expect(deploy).toContain("schema-workflow-job.json");
  });

  it("keeps Compute releases explicit and separate from ordinary release tags", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    const launchGate = await text(
      ".github/workflows/launch-gate-production.yml",
    );
    const launchGateHelper = await text(
      "scripts/release/check-production-launch-gate.mjs",
    );
    const policy = JSON.parse(await text("release-policy.json"));
    expect(policy).toEqual({
      schema_version: 1,
      release_tag: "v0.4.80",
      compute: {
        artifact: "deploy_exact_candidate",
        admission: "preserve_off",
      },
    });
    expect(deploy).toMatch(/on:\n\s+workflow_dispatch:/u);
    expect(deploy).toMatch(
      /admission_mode:\n\s+description:[^\n]+\n\s+required: true\n\s+default: preserve_off\n\s+type: choice\n\s+options:\n\s+- preserve_off/u,
    );
    expect(deploy).not.toContain("enable_global");
    expect(deploy).not.toMatch(/^\s+- global$/mu);
    expect(deploy).toContain("compute-canary-rollout.yml");
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
    expect(launchGate).not.toContain("Validate immutable release policy");
    expect(launchGate).not.toContain("Verify exact-tag Compute release evidence");
    expect(launchGateHelper).not.toMatch(/name:\s*['"]Compute Deploy['"]/u);
    expect(launchGate).toContain("--timeout-seconds 4800");
    expect(launchGate).toContain("timeout-minutes: 90");
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

  it("preserves all five Compute policy bindings across ordinary API deploys", async () => {
    const apiDeploy = await text(".github/workflows/api-deploy.yml");
    const stateVerifier = await text(
      "scripts/release/verify-api-compute-deploy-state.mjs",
    );
    expect(apiDeploy).toContain("Wrangler Dry Run (Compute disabled)");
    expect(apiDeploy).toContain("--var COMPUTE_CERTIFICATION_PRINCIPAL:");
    expect(stateVerifier).toContain("certificationPrincipal");
    expect(stateVerifier).toContain("COMPUTE_CERTIFICATION_PRINCIPAL");

    for (const target of ["staging", "production"]) {
      const jobStart = apiDeploy.indexOf(`  deploy_${target}:`);
      const nextJob = apiDeploy.indexOf("\n  deploy_", jobStart + 1);
      const job = apiDeploy.slice(
        jobStart,
        nextJob === -1 ? apiDeploy.length : nextJob,
      );
      const captureStart = job.indexOf(
        `Capture exact live ${target} Compute policy`,
      );
      const captureEnd = job.indexOf("\n      - name:", captureStart);
      const capture = job.slice(captureStart, captureEnd);
      const deployStart = job.indexOf(`Deploy ${target} worker`);
      const deployEnd = job.indexOf("\n      - name:", deployStart);
      const deployment = job.slice(deployStart, deployEnd);

      expect(jobStart).toBeGreaterThan(0);
      expect(captureStart).toBeGreaterThan(0);
      expect(deployStart).toBeGreaterThan(captureStart);
      expect(capture).toContain(
        `PRESERVED_COMPUTE_CERTIFICATION_PRINCIPAL=$(jq -er '.certificationPrincipal' "$state")`,
      );
      expect(deployment).toContain(
        "--var COMPUTE_CERTIFICATION_PRINCIPAL:",
      );
      expect(deployment).toContain(
        '--var "COMPUTE_CERTIFICATION_PRINCIPAL:' +
          '$PRESERVED_COMPUTE_CERTIFICATION_PRINCIPAL"',
      );
      expect(job).toContain(
        `$RUNNER_TEMP/${target}-api-live-compute-state.json`,
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

  it("runs Compute last, remains admission-OFF, and restores the captured stable pair after any mutation failure", async () => {
    const deploy = await text(".github/workflows/compute-deploy.yml");
    const waitForDeploys = deploy.indexOf(
      "Wait for every exact-tag production deploy before Compute mutation",
    );
    const captureStable = deploy.indexOf(
      "Capture the stable API and Compute rollback pair before mutation",
    );
    const prepareFixture = deploy.indexOf(
      "Prepare exact fixed Compute certification Agent for OFF binding preflight",
    );
    const verifyOffBinding = deploy.indexOf(
      "Verify the admission-OFF binding path before Compute mutation",
    );
    const deployCompute = deploy.indexOf("Dry-run and deploy Compute Worker");
    const certifyOff = deploy.indexOf("Certify admission-off API and exact Compute digest");
    const refreshFixture = deploy.indexOf(
      "Review, promote, and verify exact fixed Compute certification Agent while admission is off",
    );
    const bindingPreflight = deploy.indexOf(
      "Verify the Compute binding path while admission is off",
    );
    const preserveOff = deploy.indexOf(
      "Finalize policy-preserving admission-OFF release evidence",
    );
    const compensation = deploy.indexOf(
      "Restore the stable API and Compute pair after any release failure",
    );
    expect(waitForDeploys).toBeGreaterThan(0);
    expect(prepareFixture).toBeGreaterThan(waitForDeploys);
    expect(verifyOffBinding).toBeGreaterThan(prepareFixture);
    expect(captureStable).toBeGreaterThan(verifyOffBinding);
    expect(captureStable).toBeGreaterThan(waitForDeploys);
    expect(deployCompute).toBeGreaterThan(captureStable);
    expect(certifyOff).toBeGreaterThan(0);
    expect(certifyOff).toBeGreaterThan(deployCompute);
    expect(refreshFixture).toBeGreaterThan(certifyOff);
    expect(bindingPreflight).toBeGreaterThan(refreshFixture);
    expect(preserveOff).toBeGreaterThan(bindingPreflight);
    expect(compensation).toBeGreaterThan(preserveOff);
    expect(deploy).toContain('--tag "api-$GITHUB_SHA-admission-off"');
    expect(deploy).not.toContain("--var COMPUTE_ROLLOUT_MODE:global");
    expect(deploy).not.toContain("COMPUTE_ENABLED:1");
    expect(deploy).not.toContain("enable_global");
    expect(deploy).toContain("compute-canary-rollout.yml");
    const offWrites = deploy.match(/--var COMPUTE_ENABLED:0/gu) ?? [];
    const clearedCertificationPrincipals = deploy.match(
      /--var COMPUTE_CERTIFICATION_PRINCIPAL:/gu,
    ) ?? [];
    expect(offWrites.length).toBeGreaterThan(0);
    expect(clearedCertificationPrincipals).toHaveLength(offWrites.length);
    expect(deploy).toContain(
      'value("COMPUTE_CERTIFICATION_PRINCIPAL") == ""',
    );
    expect(deploy).toContain(
      'optional_value("COMPUTE_CERTIFICATION_PRINCIPAL") == ""',
    );
    expect(
      deploy.match(/\.name == "COMPUTE_CERTIFICATION_PRINCIPAL"/gu) ?? [],
    ).toHaveLength(3);
    for (const removedStep of [
      "Typecheck and dry-run global admission",
      "Enable global admission from the exact certified pair",
      "Verify exact global admission postcondition",
      "Run one bounded admitted Compute job",
      "Fence exact live versions after admitted smoke",
      "Finalize globally enabled release evidence",
    ]) {
      expect(deploy).not.toContain(removedStep);
    }
    expect(deploy).toContain("steps.capture_stable.outputs.captured == 'true'");
    expect(deploy).toContain(
      "steps.deploy_compute.outputs.attempted == 'true'",
    );
    expect(deploy).toContain(
      "steps.certify_off.outputs.attempted == 'true'",
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
    expect(deploy).not.toContain("compute-admitted-$REQUESTED_TARGET.json");
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
      "GALACTIC_SMOKE_FIXTURE: compute-certification",
    );
    expect(preflightStep).toContain(
      '.function_name == "run_compute_certification"',
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
    const preserveStep = deploy.slice(preserveOff, compensation);
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
    const prepareFixtureStep = deploy.slice(prepareFixture, verifyOffBinding);
    const fixtureStep = deploy.slice(refreshFixture, bindingPreflight);
    const fixtureScript = await text(
      "scripts/smoke/interface-deploy-smoke.mjs",
    );
    for (const step of [prepareFixtureStep, fixtureStep]) {
      expect(step).toContain(
        "scripts/smoke/with-staging-owner-session.mjs",
      );
      expect(step).toContain("--dir examples/compute-certification");
      expect(step).toContain("--promote-reviewed");
      expect(step).toContain("--reviewed-fixture compute-certification");
      expect(step).toContain(
        "--reviewed-permission compute:exec,notify:owner",
      );
      expect(step).toContain(
        "--reviewed-function run_compute_certification",
      );
      expect(step).toContain("--reviewed-compute-profile developer-v1");
      expect(step).toContain("--reviewed-compute-tools browser,shell");
      expect(step).toContain("--reviewed-compute-secrets none");
      expect(step).not.toContain("--token");
      expect(step).not.toContain("--app-id");
      expect(step).not.toContain("GALACTIC_OWNER_ACCESS_TOKEN:");
      expect(step).not.toMatch(/versions\/.*DELETE/iu);
    }
    expect(fixtureScript).toContain("const toolToken = token;");
    expect(fixtureScript).toContain("fixtureRefreshPlan({");
    expect(fixtureScript).toContain("callTool('gx.upload', uploadArgs)");
    expect(fixtureScript).not.toMatch(
      /const toolToken\s*=\s*reviewedPromotion\.ownerAccessToken/u,
    );
    expect(fixtureScript).not.toMatch(/method:\s*'DELETE'/u);
  });

  it("ordinary launch tags fence the API and gx.test session without mutating Compute", async () => {
    const launchGate = await text(
      ".github/workflows/launch-gate-production.yml",
    );
    const gateHelper = await text(
      "scripts/release/check-production-launch-gate.mjs",
    );
    const liveFence = launchGate.indexOf(
      "Verify exact live API and gx.test session versions",
    );
    expect(liveFence).toBeGreaterThan(0);
    expect(launchGate).toContain("environment: production");
    expect(launchGate).toContain("node-version-file: api/.nvmrc");
    expect(launchGate).not.toContain("node-version-file: .nvmrc");
    expect(launchGate).toContain(
      "verify-production-api-release-state.mjs",
    );
    expect(launchGate).toContain(
      "/tmp/production-api-release-verification.json",
    );
    expect(launchGate).toContain(
      "--name galactic-gx-test-session --json",
    );
    expect(launchGate).not.toContain("npx wrangler containers list");
    expect(launchGate).toContain(
      "Verify final production gx.test containment",
    );
    expect(launchGate).toContain(
      "/tmp/production-gx-test-containment.json",
    );
    expect(launchGate).not.toContain("Verify final production Compute artifact privacy");
    expect(launchGate).not.toContain("verify-live-production-compute-state.mjs");
    expect(launchGate).not.toContain("galactic-compute");
    expect(gateHelper).not.toMatch(/name:\s*['"]Compute Deploy['"]/u);
    expect(gateHelper).toMatch(/name:\s*['"]Interfaces Worker Deploy['"]/u);
  });
});

function workflowSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : -1;
  return source.slice(start, end < 0 ? source.length : end);
}

function rolloutStep(source, name) {
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/\n      - (?:name:|uses:)/u);
  return source.slice(
    start,
    next < 0 ? source.length : start + marker.length + next,
  );
}

function shellLogicalLines(source) {
  return source
    .replace(/\\\r?\n\s*/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("Compute canary rollout workflow static guards", () => {
  it("is manual-only with exactly four stages, shared API locks, and immutable refs", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const apiDeploy = await text(".github/workflows/api-deploy.yml");
    const triggers = workflowSlice(workflow, "on:\n", "permissions:");
    const triggerKeys = [...triggers.matchAll(/^  ([a-z_]+):/gmu)].map(
      (match) => match[1],
    );
    const stageInput = workflowSlice(
      workflow,
      "      stage:\n",
      "      revert_target:\n",
    );
    const stages = [...stageInput.matchAll(/^          - ([^\s#]+)\s*$/gmu)].map(
      (match) => match[1],
    );
    const jobs = workflow.slice(workflow.indexOf("jobs:\n"));
    const jobKeys = [...jobs.matchAll(/^  ([A-Za-z0-9_-]+):$/gmu)].map(
      (match) => match[1],
    );
    const request = rolloutStep(
      workflow,
      "Validate request and configure the exact target",
    );

    expect(triggerKeys).toEqual(["workflow_dispatch"]);
    expect(stages).toEqual([
      "staging_canary",
      "production_canary",
      "production_global",
      "revert_off",
    ]);
    expect(jobKeys).toEqual(["rollout"]);
    expect(workflow).toContain(
      "group: api-${{ (inputs.stage == 'staging_canary' || (inputs.stage == 'revert_off' && inputs.revert_target == 'staging')) && 'staging' || 'production' }}-deploy",
    );
    expect(workflow).toContain("cancel-in-progress: false");
    expect(apiDeploy).toContain("group: api-staging-deploy");
    expect(apiDeploy).toContain("group: api-production-deploy");
    expect(request).toContain("expected_ref=refs/heads/main");
    expect(request).toContain("expected_ref=tag");
    expect(request).toContain("refs/tags/v*)");
    expect(request).toContain('git rev-parse "$GITHUB_REF^{commit}"');
    expect(request).toContain('[ "$resolved_tag_sha" = "$GITHUB_SHA" ]');
    expect(request).toContain('[ "$GITHUB_REF" != "$expected_ref" ]');
    expect(workflow).toContain("diagnostic_safe_terminal_error:");
    expect(workflow).toContain("default: false");
    expect(request).toContain(
      '[ "$REQUESTED_STAGE" != "staging_canary" ]',
    );
    expect(request).toContain(
      "Safe terminal-error diagnostics are staging_canary-only.",
    );
    expect(workflow).toContain(
      "COMPUTE_CERTIFICATION_LOG_SAFE_TERMINAL_ERROR: ${{ inputs.diagnostic_safe_terminal_error && '1' || '0' }}",
    );
    expect(workflow).not.toContain("CERTIFIED_OFF_API_VERSION_ID");
    expect(workflow).not.toContain("certified_admission_off_api");
  });

  it("requires successful Compute Deploy evidence, production hygiene, and exact predecessor provenance", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const releaseVerifier = await text(
      "scripts/release/verify-compute-rollout-release-evidence.mjs",
    );
    const predecessorVerifier = await text(
      "scripts/release/verify-compute-rollout-predecessor.mjs",
    );
    const release = rolloutStep(
      workflow,
      "Enforce production hygiene and verify Compute release evidence",
    );
    const request = rolloutStep(
      workflow,
      "Validate request and configure the exact target",
    );
    const predecessor = rolloutStep(
      workflow,
      "Download and verify the predecessor stage",
    );

    expect(release).toContain(
      '"repos/$GITHUB_REPOSITORY/actions/runs/$COMPUTE_RELEASE_RUN_ID_INPUT"',
    );
    expect(release).toContain("gh run download");
    expect(release).toContain(
      "scripts/release/verify-compute-rollout-release-evidence.mjs",
    );
    expect(releaseVerifier).toContain("workflowRun.event !== 'workflow_dispatch'");
    expect(releaseVerifier).toContain("workflowRun.conclusion !== 'success'");
    expect(releaseVerifier).toContain(
      "workflowRun.path !== '.github/workflows/compute-deploy.yml'",
    );
    expect(releaseVerifier).toContain("admission_mode");
    expect(releaseVerifier).toContain("preserve_off");

    expect(release).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/pulls/172"',
    );
    expect(release).toContain('[ "$REQUESTED_TARGET" = "production" ]');
    expect(release).toContain(
      "PR #172 must be merged or closed before production canary work.",
    );
    expect(predecessor).toContain("predecessor_stage=staging_canary");
    expect(predecessor).toContain("predecessor_stage=production_canary");
    expect(predecessor).toContain("predecessor_target=production");
    expect(predecessor).toContain("minimum_age=86400");
    expect(predecessor).toContain(
      "inputs.predecessor_rollout_run_id != ''",
    );
    expect(request).toContain("predecessor_required=false");
    expect(request).toContain(
      "predecessor_rollout_run_id must be a positive run ID when supplied.",
    );
    expect(request).toContain("recovery_source_sha is valid only for revert_off.");
    expect(request).toContain('git cat-file -e "$RECOVERY_SOURCE_SHA_INPUT^{commit}"');
    expect(request).toContain("git merge-base --is-ancestor");
    expect(request).toContain("API_UPLOAD_SOURCE_SHA=$upload_source_sha");
    expect(workflow).toContain(
      'short_sha="${API_UPLOAD_SOURCE_SHA:0:12}"',
    );
    expect(workflow).not.toContain('short_sha="${GITHUB_SHA:0:12}"');
    expect(workflow).toContain(
      '--arg api_upload_source_sha "$API_UPLOAD_SOURCE_SHA"',
    );
    expect(workflow).toContain(
      'api_upload_source_sha: $api_upload_source_sha',
    );
    expect(workflow).toContain('git archive "$RECOVERY_SOURCE_SHA_INPUT" |');
    expect(workflow).toContain(
      'npm --prefix "$recovery_api" ci --ignore-scripts',
    );
    expect(predecessor).toContain(
      "scripts/release/verify-compute-rollout-predecessor.mjs",
    );
    expect(predecessor).toContain(
      '"$predecessor_target" "$GITHUB_SHA" "$minimum_age"',
    );
    expect(predecessorVerifier).toContain(
      "const WORKFLOW_PATH = '.github/workflows/compute-canary-rollout.yml'",
    );
    expect(predecessorVerifier).toContain(
      "workflowRun.status !== 'completed'",
    );
    expect(predecessorVerifier).toContain(
      "workflowRun.conclusion !== 'success'",
    );
    expect(predecessorVerifier).toContain(
      "headRepository.full_name !== repository.full_name",
    );
    expect(predecessorVerifier).toContain(
      "expected exactly one uniquely named predecessor artifact",
    );
    expect(predecessorVerifier).toContain(
      "production_canary has not satisfied minimum age and soak eligibility",
    );
    expect(workflow).toContain(
      'date -u -d "$generated_at + 86400 seconds"',
    );
  });

  it("verifies a complete 24-hour active soak before exposing mutation credentials", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const soakVerifier = await text(
      "scripts/release/verify-compute-canary-soak.mjs",
    );
    const soakContract = await import(
      new URL(
        "../../scripts/release/verify-compute-canary-soak.mjs",
        import.meta.url,
      )
    );
    const soakAt = workflow.indexOf(
      "Verify the active production canary soak",
    );
    const predecessorAt = workflow.indexOf(
      "Download and verify the predecessor stage",
    );
    const baselineAt = workflow.indexOf(
      "Inspect and bind the exact live API/Compute pair",
    );
    const soak = rolloutStep(
      workflow,
      "Verify the active production canary soak",
    );

    expect(soakAt).toBeGreaterThan(0);
    expect(soakAt).toBeGreaterThan(predecessorAt);
    expect(soakAt).toBeLessThan(baselineAt);
    expect(soak).toContain("inputs.stage == 'production_global'");
    expect(soak).toContain(
      "scripts/release/verify-compute-canary-soak.mjs",
    );
    expect(soak).toContain("86400");
    expect(soak).toContain("2100");
    expect(soak).toContain(".predecessor.workflow_completed_at");
    expect(soak).toContain("compute-probe-production-");
    expect(soak).toContain("soak-verification.json");
    const fetchStart = soak.indexOf("fetch_workflow_page_set() {");
    const fetchEnd = soak.indexOf("normalize_workflow_query() {");
    const fetch = soak.slice(fetchStart, fetchEnd);
    expect(fetchStart).toBeGreaterThan(0);
    expect(fetchEnd).toBeGreaterThan(fetchStart);
    expect(fetch).toContain(
      'if [ "$workflow_file" = "compute-probe.yml" ]; then',
    );
    expect(fetch.match(/created=>=/gu)).toHaveLength(1);
    expect(fetch).toContain(
      "Fetch every retained deploy run so",
    );
    expect(fetch).toMatch(
      /return[\s\S]*gh api --method GET --paginate "\$endpoint"[\s\S]*-f per_page=100 > "\$output"/u,
    );
    expect(soak).toContain('echo "verified=true" >> "$GITHUB_OUTPUT"');
    expect(soak).not.toContain("secrets.");
    expect(soak).not.toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(soak).not.toContain("COMPUTE_EMERGENCY_STOP_TOKEN");
    expect(soak).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(soak).not.toContain("ULTRALIGHT_TOKEN");
    expect(soak).not.toContain("GALACTIC_SMOKE_APP_ID");
    expect(workflow).toContain("active_soak:");
    expect(baselineAt).toBeGreaterThan(soakAt);
    expect(soakContract.COMPUTE_CANARY_SOAK_MINIMUM_SECONDS).toBe(86_400);
    expect(
      soakContract.COMPUTE_CANARY_SOAK_MAX_LIFECYCLE_GAP_SECONDS,
    ).toBe(2_100);
    expect(soakContract.COMPUTE_CANARY_SOAK_MAX_BROWSER_GAP_SECONDS).toBe(
      4_200,
    );
    expect(soakVerifier).toContain("requireBrowserInEveryCompleteUtcHour");
    for (const failure of [
      "a scheduled probe failed, was skipped, rerun, or is ambiguous",
      "ran after the production canary soak started",
      "probe API, Compute, digest, policy, or principal drifted",
      "OFF no-op evidence cannot satisfy or occur inside an enabled soak",
      "counters changed during the enabled soak",
      "probe accounting violations",
      "probe reconciliation violations",
      "health accounting violations",
      "health reconciliation violations",
    ]) {
      expect(soakVerifier).toContain(failure);
    }
    expect(soakVerifier).toContain("assertStableDlq");
  });

  it("limits mutation to exact API policy-version upload/deploy commands with explicit environments", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const lines = shellLogicalLines(workflow);
    const mutationCommands = lines.filter((line) =>
      /\bnpx wrangler (?:versions (?:upload|deploy)|deploy\b|rollback\b)/u
        .test(line)
    );
    const apiCommands = lines.filter((line) =>
      line.includes("npx wrangler") &&
      line.includes("--config wrangler.toml")
    );
    const variableNames = [...workflow.matchAll(
      /--var\s+"?([A-Z][A-Z0-9_]*):/gu,
    )].map((match) => match[1]);
    const counts = Object.fromEntries(
      [...new Set(variableNames)].map((name) => [
        name,
        variableNames.filter((value) => value === name).length,
      ]),
    );

    expect(mutationCommands).toHaveLength(5);
    expect(
      mutationCommands.filter((line) =>
        line.includes("npx wrangler versions upload")
      ),
    ).toHaveLength(2);
    expect(
      mutationCommands.filter((line) =>
        line.includes("npx wrangler versions deploy")
      ),
    ).toHaveLength(3);
    expect(mutationCommands.every((line) =>
      line.includes("--config wrangler.toml") &&
      line.includes('--env "$API_WRANGLER_ENV"')
    )).toBe(true);
    expect(apiCommands.length).toBeGreaterThan(10);
    expect(apiCommands.every((line) =>
      line.includes('--env "$API_WRANGLER_ENV"')
    )).toBe(true);
    expect(workflow).toContain("wrangler_env=staging");
    expect(workflow).toMatch(/^\s*wrangler_env=$/mu);
    expect(counts).toEqual({
      COMPUTE_ENABLED: 2,
      COMPUTE_ENVIRONMENT_DIGEST: 2,
      COMPUTE_ROLLOUT_MODE: 2,
      COMPUTE_CANARY_ALLOWLIST: 2,
      COMPUTE_CERTIFICATION_PRINCIPAL: 2,
    });
    expect(workflow.match(/--keep-vars --strict/gu)).toHaveLength(2);
    expect(workflow).not.toMatch(/\bnpx wrangler deploy(?:\s|$)/u);
    expect(workflow).not.toMatch(/\bnpx wrangler rollback(?:\s|$)/u);
    expect(workflow).not.toMatch(/\bnpx wrangler (?:versions )?(?:upload|deploy)[^\n]*--config "?\$COMPUTE_CONFIG/iu);
    expect(workflow).not.toMatch(
      /\bdocker\b|\bbuildx?\b|\bpush\b|dockerfile|\bsbom\b|\bsyft\b|\bgrype\b/iu,
    );
    expect(workflow).not.toMatch(/\bdocker\s+push\b|\bwrangler\s+secret\b/iu);
    expect(workflow).toContain(
      'certification_principal="$(jq -er \'.allowlist_entry\' "$EVIDENCE_DIR/canary-identity.json")"',
    );
    expect(workflow).toContain("certification_principal,");
    expect(workflow).toContain(
      'upload_policy rollback off 0 canary "" ""',
    );
  });

  it("keeps Cloudflare, emergency-latch, and owner credentials in separate steps", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const jobEnv = workflowSlice(workflow, "    env:\n", "    steps:\n");
    const stepNames = [...workflow.matchAll(/^      - name: (.+)$/gmu)].map(
      (match) => match[1],
    );
    const secretRefs = (step) => [...new Set(
      [...step.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map((match) => match[1]),
    )].sort();
    const cloudflare = new Set([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
    ]);
    const owner = /^(?:SUPABASE_|ULTRALIGHT_TOKEN|GALACTIC_SMOKE_APP_ID)/u;

    expect(jobEnv).not.toContain("secrets.");
    for (const name of stepNames) {
      const secrets = secretRefs(rolloutStep(workflow, name));
      const domains = [
        secrets.some((value) => cloudflare.has(value)),
        secrets.includes("COMPUTE_EMERGENCY_STOP_TOKEN"),
        secrets.includes("COMPUTE_CERTIFICATION_TOKEN"),
        secrets.some((value) => owner.test(value)),
      ].filter(Boolean);
      expect(domains.length, name).toBeLessThanOrEqual(1);
    }

    const exactSecrets = (name, expected) => {
      expect(secretRefs(rolloutStep(workflow, name)), name).toEqual(
        [...expected].sort(),
      );
    };
    exactSecrets("Re-fence every live dependency immediately before mutation", [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
    ]);
    exactSecrets(
      "Re-fence the emergency-stop latch immediately before mutation",
      ["COMPUTE_EMERGENCY_STOP_TOKEN"],
    );
    exactSecrets("Restore this dispatch's exact OFF anchor after any failure", [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
    ]);
    exactSecrets("Verify the emergency-stop latch after OFF compensation", [
      "COMPUTE_EMERGENCY_STOP_TOKEN",
    ]);
    exactSecrets("Restore OFF if committed evidence was not published", [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
    ]);
    exactSecrets(
      "Verify the emergency-stop latch after unpublished-evidence OFF restore",
      ["COMPUTE_EMERGENCY_STOP_TOKEN"],
    );
    exactSecrets("Read the least-privilege Compute certification snapshot", [
      "COMPUTE_CERTIFICATION_TOKEN",
    ]);
    const certificationSnapshot = rolloutStep(
      workflow,
      "Read the least-privilege Compute certification snapshot",
    );
    expect(certificationSnapshot).not.toContain("COMPUTE_EMERGENCY_STOP_TOKEN");
    expect(certificationSnapshot).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(certificationSnapshot).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(certificationSnapshot).not.toContain("ULTRALIGHT_TOKEN");

    const identity = rolloutStep(
      workflow,
      "Resolve the fixed certification owner/Agent pair",
    );
    expect(identity).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(identity).not.toContain("SUPABASE_STAGING_PROJECT_ID");
    expect(identity).not.toContain("SUPABASE_PRODUCTION_PROJECT_ID");
  });

  it("captures and re-fences a same-dispatch OFF anchor before a marked, structured promotion", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const stateVerifier = await text(
      "scripts/release/verify-api-compute-rollout-state.mjs",
    );
    const baselineAt = workflow.indexOf(
      "Inspect and bind the exact live API/Compute pair",
    );
    const prepareAt = workflow.indexOf(
      "Upload and byte-verify rollback and desired policy versions",
    );
    const fenceAt = workflow.indexOf(
      "Re-fence every live dependency immediately before mutation",
    );
    const latchFenceAt = workflow.indexOf(
      "Re-fence the emergency-stop latch immediately before mutation",
    );
    const promoteAt = workflow.indexOf(
      "Promote the exact verified policy version at 100 percent",
    );
    const prepare = rolloutStep(
      workflow,
      "Upload and byte-verify rollback and desired policy versions",
    );
    const fence = rolloutStep(
      workflow,
      "Re-fence every live dependency immediately before mutation",
    );
    const latchFence = rolloutStep(
      workflow,
      "Re-fence the emergency-stop latch immediately before mutation",
    );
    const promote = rolloutStep(
      workflow,
      "Promote the exact verified policy version at 100 percent",
    );
    const verify = rolloutStep(
      workflow,
      "Verify the exact promoted API/Compute pair",
    );
    const baseline = rolloutStep(
      workflow,
      "Inspect and bind the exact live API/Compute pair",
    );
    const finalFence = rolloutStep(
      workflow,
      "Final exact live fence after certification",
    );

    expect(baselineAt).toBeGreaterThan(0);
    expect(prepareAt).toBeGreaterThan(baselineAt);
    expect(fenceAt).toBeGreaterThan(prepareAt);
    expect(latchFenceAt).toBeGreaterThan(fenceAt);
    expect(promoteAt).toBeGreaterThan(latchFenceAt);
    expect(prepare).toContain('rollback_anchor="$EVIDENCE_DIR/rollback-anchor.json"');
    expect(prepare).toContain('cp "$baseline" "$rollback_anchor"');
    expect(prepare).toContain(
      'upload_policy rollback off 0 canary "" ""',
    );
    expect(prepare).not.toContain("predecessor-rollout.json");
    expect(prepare).not.toContain("CERTIFIED_OFF_API_VERSION_ID");
    expect(stateVerifier).toContain(
      "upload baseline was not captured in this workflow dispatch",
    );
    expect(stateVerifier).toContain(
      "rollback anchor was not verified as OFF in this dispatch",
    );
    expect(prepare).toContain("WRANGLER_OUTPUT_FILE_PATH");
    expect(prepare).toContain(
      "verify-api-compute-off-bridge.mjs",
    );
    expect(prepare).toContain(
      'upload-output "$upload_output" "$API_WORKER" "$API_WRANGLER_ENV"',
    );
    expect(prepare).toContain('pushd "$API_UPLOAD_DIR"');
    expect(prepare).toContain(
      "verify-api-compute-rollout-state.mjs",
    );
    expect(prepare).toContain(
      'uploaded "$REQUESTED_TARGET" "$policy"',
    );
    expect(fence).toContain('fence "$baseline"');
    expect(fence).toContain("verify_uploaded_again");
    expect(latchFence).toContain("emergency-stop-pre-promotion.json");
    expect(latchFence).toContain("steps.fence.outputs.verified == 'true'");
    expect(latchFence).toContain('echo "verified=true" >> "$GITHUB_OUTPUT"');
    expect(promote).toContain("steps.fence.outputs.verified == 'true'");
    expect(promote).toContain("steps.latch_fence.outputs.verified == 'true'");
    expect(promote).toContain('echo "attempted=true" >> "$GITHUB_OUTPUT"');
    expect(promote).toContain('> "$EVIDENCE_DIR/mutation-attempted"');
    expect(promote.indexOf("mutation-attempted")).toBeLessThan(
      promote.indexOf("npx wrangler versions deploy"),
    );
    expect(promote).toContain("WRANGLER_OUTPUT_FILE_PATH");
    expect(promote).toContain(
      'deploy-output "$deploy_output" "$API_WORKER"',
    );
    expect(verify).toContain("(.versions | length) == 1");
    expect(verify).toContain("((.versions[0].percentage | tonumber) == 100)");
    expect(verify).toContain(".versions[0].version_id == $version");
    expect(verify).toContain(".id == $deployment");
    expect(verify).toContain("promoted-state.json");
    expect(verify).toContain("steps.promote.outcome == 'success'");
    expect(verify).toContain("steps.promote.outputs.attempted == 'true'");
    expect(baseline).toContain("(.versions | length) == 1");
    expect(baseline).toContain(
      "((.versions[0].percentage | tonumber) == 100)",
    );
    expect(finalFence).toContain(
      "verify-api-compute-rollout-state.mjs",
    );
    expect(finalFence).toContain('fence "$expected_state"');
  });

  it("orders emergency-latch release behind a verified flag-OFF state", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const preflightAt = workflow.indexOf("Preflight the emergency-stop latch");
    const prepareAt = workflow.indexOf(
      "Upload and byte-verify rollback and desired policy versions",
    );
    const verifyAt = workflow.indexOf(
      "Verify the exact promoted API/Compute pair",
    );
    const verifyLatchAt = workflow.indexOf(
      "Verify the emergency-stop latch after promotion",
    );
    const postRevertReleaseAt = workflow.indexOf(
      "Release a completed latch after revert_off",
    );
    const preflight = rolloutStep(workflow, "Preflight the emergency-stop latch");
    const releaseWhileOff = rolloutStep(
      workflow,
      "Release a completed latch while the live API is OFF",
    );
    const verifyLatch = rolloutStep(
      workflow,
      "Verify the emergency-stop latch after promotion",
    );
    const postRevertRelease = rolloutStep(
      workflow,
      "Release a completed latch after revert_off",
    );

    expect(preflightAt).toBeGreaterThan(0);
    expect(preflightAt).toBeLessThan(prepareAt);
    expect(preflight).toContain(
      "An active emergency stop blocks every rollout transition.",
    );
    expect(releaseWhileOff).toContain(
      "steps.baseline.outputs.policy == 'off'",
    );
    expect(releaseWhileOff).toContain("inputs.stage != 'revert_off'");
    expect(releaseWhileOff).toContain(
      '"$after_file" disabled clear',
    );
    expect(verifyLatchAt).toBeGreaterThan(verifyAt);
    expect(postRevertReleaseAt).toBeGreaterThan(verifyLatchAt);
    expect(verifyLatch).toContain(
      '"$status_file" disabled completed "$operation_id"',
    );
    expect(verifyLatch).toContain('"$status_file" disabled clear');
    expect(postRevertRelease).toContain("inputs.stage == 'revert_off'");

    const revertCleanup = rolloutStep(
      workflow,
      "Clean the fixed certification fixture after revert_off",
    );
    expect(revertCleanup).toContain("inputs.stage == 'revert_off'");
    expect(revertCleanup).toContain('revert_target == \'staging\'');
    expect(revertCleanup).toContain('revert_target == \'production\'');
    expect(revertCleanup).toContain(
      "compute-certification-suite.mjs --cleanup-only",
    );
    expect(revertCleanup).not.toContain("run_compute_certification");
    expect(postRevertRelease).toContain(
      '"$after_file" disabled clear',
    );
  });

  it("binds every enabled stage to the closed full-suite fixture and combined deployed evidence", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const identityResolver = await text(
      "scripts/smoke/resolve-compute-canary-identity.mjs",
    );
    const inputs = workflowSlice(workflow, "    inputs:\n", "permissions:");
    const identityAt = workflow.indexOf(
      "Resolve the fixed certification owner/Agent pair",
    );
    const refreshAt = workflow.indexOf(
      "Refresh the fixed certification fixture",
    );
    const prepareAt = workflow.indexOf(
      "Upload and byte-verify rollback and desired policy versions",
    );
    const suiteAt = workflow.indexOf(
      "Run the deployed Compute certification suite",
    );
    const snapshotAt = workflow.indexOf(
      "Read the least-privilege Compute certification snapshot",
    );
    const certificationAt = workflow.indexOf(
      "Verify combined deployed Compute certification evidence",
    );
    const finalFenceAt = workflow.indexOf(
      "Final exact live fence after certification",
    );
    const identity = rolloutStep(
      workflow,
      "Resolve the fixed certification owner/Agent pair",
    );
    const refresh = rolloutStep(
      workflow,
      "Refresh the fixed certification fixture",
    );
    const prepare = rolloutStep(
      workflow,
      "Upload and byte-verify rollback and desired policy versions",
    );
    const suite = rolloutStep(
      workflow,
      "Run the deployed Compute certification suite",
    );
    const snapshot = rolloutStep(
      workflow,
      "Read the least-privilege Compute certification snapshot",
    );
    const certification = rolloutStep(
      workflow,
      "Verify combined deployed Compute certification evidence",
    );
    const finalFence = rolloutStep(
      workflow,
      "Final exact live fence after certification",
    );
    const finalLatchFence = rolloutStep(
      workflow,
      "Final emergency-stop latch fence after certification",
    );

    expect(inputs).not.toMatch(/owner_id|agent_id|canary_allowlist/iu);
    expect(inputs).not.toMatch(
      /^\s{6}(?:owner|agent|canary|allowlist)[A-Za-z0-9_-]*:/imu,
    );
    expect(identityAt).toBeGreaterThan(0);
    expect(refreshAt).toBeGreaterThan(identityAt);
    expect(prepareAt).toBeGreaterThan(refreshAt);
    expect(suiteAt).toBeGreaterThan(prepareAt);
    expect(snapshotAt).toBeGreaterThan(suiteAt);
    expect(certificationAt).toBeGreaterThan(snapshotAt);
    expect(finalFenceAt).toBeGreaterThan(certificationAt);
    expect(workflow).toContain("certification_profile=staging-full");
    expect(workflow).toContain("certification_profile=production-canary");
    expect(workflow).toContain("certification_profile=production-global");
    expect(workflow).toContain(
      'echo "COMPUTE_CERTIFICATION_PROFILE=$certification_profile"',
    );
    expect(identity).toContain("if: inputs.stage != 'revert_off'");
    expect(identity).toContain("ULTRALIGHT_TOKEN_STAGING");
    expect(identity).toContain("GALACTIC_SMOKE_APP_ID_STAGING");
    expect(identity).toContain("ULTRALIGHT_TOKEN");
    expect(identity).toContain("GALACTIC_SMOKE_APP_ID");
    expect(identity).toContain(
      "scripts/smoke/resolve-compute-canary-identity.mjs",
    );
    expect(identity).not.toContain("SUPABASE_ACCESS_TOKEN");
    expect(refresh).toContain(
      "scripts/smoke/with-staging-owner-session.mjs",
    );
    expect(refresh).toContain("SUPABASE_ACCESS_TOKEN");
    expect(refresh).toContain(
      "steps.canary_identity.outputs.verified == 'true'",
    );
    expect(refresh).toContain("--dir examples/compute-certification");
    expect(refresh).toContain("--reviewed-fixture compute-certification");
    expect(refresh).toContain("--reviewed-function run_compute_certification");
    expect(refresh).toContain("--reviewed-compute-tools browser,shell");
    expect(refresh).toContain("--reviewed-compute-secrets none");
    expect(identityResolver).toContain("resolveSmokeOwner");
    expect(identityResolver).toContain("allowlist_entry: allowlistEntry");
    expect(prepare).toContain(
      'allowlist="$(jq -er \'.allowlist_entry\' "$EVIDENCE_DIR/canary-identity.json")"',
    );
    expect(suite).toContain("compute-certification-suite.mjs");
    expect(suite).toContain("galactic_compute_deployed_certification");
    expect(suite).toContain("(.scenarios | length) == 10");
    expect(suite).toContain("(.run_ids | length) == 11");
    expect(suite).toContain(".cleanup.active_compute_runs_remaining == 0");
    expect(suite).toContain(".cleanup.active_routine_runs_remaining == 0");
    expect(suite).toContain(".cleanup.compute_policy_disabled == true");
    expect(suite).not.toContain("for attempt in 1 2");
    expect(snapshot).toContain("COMPUTE_CERTIFICATION_TOKEN");
    expect(snapshot).toContain("/api/admin/compute/certification");
    expect(snapshot).toContain("owner_id: $identity[0].owner_id");
    expect(snapshot).toContain("run_ids: $run_set[0].run_ids");
    expect(snapshot).toContain("since: $run_set[0].since");
    expect(snapshot).toContain("unset COMPUTE_CERTIFICATION_TOKEN");
    expect(certification).toContain(
      "scripts/release/verify-compute-certification-evidence.mjs",
    );
    for (const flag of [
      "--suite-evidence",
      "--run-set",
      "--operator-snapshot",
      "--canary-identity",
      "--promoted-state",
      "--expected-target",
      "--expected-profile",
      "--expected-candidate-sha",
      "--expected-workflow-run-id",
      "--output",
    ]) {
      expect(certification).toContain(flag);
    }
    expect(workflow).toContain("deployed_certification: $deployed_certification");
    expect(workflow).not.toContain("admitted_smoke:");
    expect(workflow).not.toContain("compute-admitted-smoke.mjs");
    expect(finalFence).toContain(
      "verify-api-compute-rollout-state.mjs",
    );
    expect(finalFence).toContain('fence "$expected_state"');
    expect(finalFence).toContain("final-container-readiness.json");
    expect(finalLatchFence).toContain("emergency-stop-final.json");
  });

  it("compensates only to this dispatch's OFF anchor and never releases the latch", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const compensation = rolloutStep(
      workflow,
      "Restore this dispatch's exact OFF anchor after any failure",
    );
    const compensationLatch = rolloutStep(
      workflow,
      "Verify the emergency-stop latch after OFF compensation",
    );
    const compensationFixture = rolloutStep(
      workflow,
      "Clean the fixed certification fixture after OFF compensation",
    );
    const manifest = rolloutStep(
      workflow,
      "Write deterministic evidence manifest",
    );
    const unpublishedRestore = rolloutStep(
      workflow,
      "Restore OFF if committed evidence was not published",
    );
    const unpublishedLatch = rolloutStep(
      workflow,
      "Verify the emergency-stop latch after unpublished-evidence OFF restore",
    );
    const unpublishedFixture = rolloutStep(
      workflow,
      "Clean the fixed certification fixture after unpublished restore",
    );

    expect(compensation).toContain("always()");
    expect(compensation).toContain("steps.promote.outputs.attempted == 'true'");
    expect(compensation).toContain("steps.finalize.outcome != 'success'");
    expect(compensation).toContain(
      "ROLLBACK_VERSION_ID: ${{ steps.prepare.outputs.rollback_version_id }}",
    );
    expect(compensation).toContain(
      '"$EVIDENCE_DIR/rollback-anchor.json"',
    );
    expect(compensation).toContain("for promotion_attempt in 1 2 3");
    expect(compensation).toContain(
      'npx wrangler versions deploy "$ROLLBACK_VERSION_ID@100%"',
    );
    expect(compensation).toContain("WRANGLER_OUTPUT_FILE_PATH");
    expect(compensation).toContain(
      'deploy-output "$deploy_output" "$API_WORKER"',
    );
    expect(compensation).toContain("(.versions | length) == 1");
    expect(compensation).toContain(
      "((.versions[0].percentage | tonumber) == 100)",
    );
    expect(compensation).toContain(
      'reverted "$REQUESTED_TARGET"',
    );
    expect(compensationFixture).toContain(
      "inputs.stage == 'revert_off' && inputs.revert_target == 'staging'",
    );
    expect(compensationFixture).toContain(
      "inputs.stage == 'revert_off' && inputs.revert_target == 'production'",
    );
    expect(compensationFixture).not.toContain(
      "inputs.stage != 'staging_canary' && secrets.SUPABASE_PRODUCTION_PROJECT_ID",
    );
    expect(compensationFixture).toContain(
      "compute-certification-suite.mjs --cleanup-only",
    );
    expect(compensationFixture).toContain(
      "steps.compensate.outputs.verified == 'true'",
    );
    expect(compensationFixture).not.toContain("steps.compensate_latch");
    expect(compensationLatch).toContain(
      "steps.compensate.outputs.verified == 'true'",
    );
    expect(compensationLatch).toContain(
      "emergency-stop-after-compensation.json",
    );
    expect(compensationLatch).toContain("for attempt in {1..12}");
    expect(compensationLatch).toContain('"$attempt_file" enabled clear');
    expect(compensationLatch).toContain('"$attempt_file" disabled clear');
    expect(compensationLatch).toContain("Cache-Control: no-cache");
    expect(compensationLatch).not.toMatch(/emergency-stop\/[^\s]+\/release/u);
    expect(compensationLatch).not.toContain("RELEASE_COMPUTE_STOP");
    expect(compensationLatch).not.toContain("-X POST");
    expect(manifest).toContain("off_restore_outcome");
    expect(manifest).toContain("latch_verification_outcome");
    expect(manifest).toContain("fixture_cleanup_outcome");
    expect(unpublishedRestore).toContain("steps.finalize.outcome == 'success'");
    expect(unpublishedRestore).toContain("steps.manifest.outcome != 'success'");
    expect(unpublishedRestore).toContain(
      "steps.upload_evidence.outcome != 'success'",
    );
    expect(unpublishedLatch).toContain(
      "steps.unpublished_restore.outputs.verified == 'true'",
    );
    expect(unpublishedLatch).toContain("for attempt in {1..12}");
    expect(unpublishedLatch).toContain('"$attempt_file" enabled clear');
    expect(unpublishedLatch).toContain('"$attempt_file" disabled clear');
    expect(unpublishedLatch).toContain("Cache-Control: no-cache");
    expect(unpublishedFixture).toContain(
      "steps.unpublished_restore_latch.outputs.verified == 'true'",
    );
    expect(unpublishedFixture).toContain(
      "compute-certification-suite.mjs --cleanup-only",
    );

    const orderedSteps = [
      "Restore this dispatch's exact OFF anchor after any failure",
      "Verify the emergency-stop latch after OFF compensation",
      "Clean the fixed certification fixture after OFF compensation",
      "Write deterministic evidence manifest",
      "Upload private rollout evidence",
      "Restore OFF if committed evidence was not published",
      "Verify the emergency-stop latch after unpublished-evidence OFF restore",
      "Clean the fixed certification fixture after unpublished restore",
    ].map((name) => workflow.indexOf(`      - name: ${name}`));
    expect(orderedSteps.every((position) => position > 0)).toBe(true);
    expect(orderedSteps).toEqual([...orderedSteps].sort((a, b) => a - b));
  });

  it("pins all actions and retains hashed private evidence for 90 days", async () => {
    const workflow = await text(
      ".github/workflows/compute-canary-rollout.yml",
    );
    const actionUses = [...workflow.matchAll(/\buses:\s+([^\s#]+)/gu)].map(
      (match) => match[1],
    );
    const evidence = rolloutStep(workflow, "Write deterministic evidence manifest");
    const upload = rolloutStep(workflow, "Upload private rollout evidence");
    const permissions = workflowSlice(workflow, "permissions:\n", "jobs:\n");

    expect(actionUses).toHaveLength(3);
    expect(actionUses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
    expect(permissions).toMatch(/^  contents: read$/mu);
    expect(permissions).toMatch(/^  actions: read$/mu);
    expect(permissions).not.toMatch(/write|id-token/iu);
    expect(evidence).toContain("find . -type f ! -name evidence.sha256 -print0");
    expect(evidence).toContain("LC_ALL=C sort -z");
    expect(evidence).toContain("xargs -0 sha256sum");
    expect(upload).toContain("if: always()");
    expect(upload).toContain("actions/upload-artifact@");
    expect(upload).toContain("path: compute-rollout-evidence");
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).toContain("retention-days: 90");
  });
});

describe("Compute production probe workflow static guards", () => {
  it("uses jq null-input mode for every slurp-only assertion", async () => {
    for (const path of [
      ".github/workflows/compute-canary-rollout.yml",
      ".github/workflows/compute-probe.yml",
    ]) {
      const lines = (await text(path)).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.includes("</dev/null")) continue;
        let commandIndex = index;
        while (commandIndex >= 0 && !/^\s+jq\s/u.test(lines[commandIndex])) {
          commandIndex -= 1;
        }
        expect(commandIndex, `${path}:${index + 1}`).toBeGreaterThanOrEqual(0);
        expect(lines[commandIndex], `${path}:${index + 1}`).toMatch(
          /^\s+jq -ne\s/u,
        );
      }
    }
  });

  it("runs isolated lifecycle and browser probes on the active-soak cadence", async () => {
    const workflow = await text(".github/workflows/compute-probe.yml");
    const triggers = workflowSlice(workflow, "on:\n", "permissions:");
    const permissions = workflowSlice(workflow, "permissions:\n", "jobs:\n");
    const actionUses = [...workflow.matchAll(/\buses:\s+([^\s#]+)/gu)].map(
      (match) => match[1],
    );

    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).toContain("schedule:");
    expect(triggers).toMatch(/cron:\s*['"]\*\/15 \* \* \* \*['"]/u);
    expect(triggers).toMatch(/cron:\s*['"]7 \* \* \* \*['"]/u);
    expect(workflow).toContain("environment: production-compute-probe");
    expect(workflow).toContain("group: compute-production-probe");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(permissions).toMatch(/^  contents: read$/mu);
    expect(permissions).toMatch(/^  actions: read$/mu);
    expect(permissions).not.toMatch(/write|id-token/iu);
    expect(actionUses.length).toBeGreaterThan(0);
    expect(actionUses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
    expect(workflow).toContain("probe-lifecycle");
    expect(workflow).toContain("probe");
    expect(workflow).toContain("browser_https");
  });

  it("authenticates the selected rollout before executing its source", async () => {
    const workflow = await text(".github/workflows/compute-probe.yml");
    const resolve = rolloutStep(
      workflow,
      "Resolve the active production canary",
    );
    const fetchAt = resolve.indexOf(
      'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id"',
    );
    const validateAt = resolve.indexOf('--arg run_id "$run_id"');
    const tagAt = resolve.indexOf('git show-ref --verify --quiet "$tag_ref"');
    const ancestryAt = resolve.indexOf(
      'git merge-base --is-ancestor "$git_sha" "$GITHUB_SHA"',
    );
    const downloadAt = resolve.indexOf('gh run download "$run_id"');
    const immutableCheckoutAt = workflow.indexOf(
      "Check out the immutable canary source",
    );

    expect(fetchAt).toBeGreaterThan(0);
    expect(validateAt).toBeGreaterThan(fetchAt);
    expect(tagAt).toBeGreaterThan(validateAt);
    expect(ancestryAt).toBeGreaterThan(tagAt);
    expect(downloadAt).toBeGreaterThan(ancestryAt);
    expect(immutableCheckoutAt).toBeGreaterThan(
      workflow.indexOf("Resolve the active production canary"),
    );
    expect(resolve).toContain('.event == "workflow_dispatch"');
    expect(resolve).toContain('.status == "completed"');
    expect(resolve).toContain('.conclusion == "success"');
    expect(resolve).toContain(
      '.path == ".github/workflows/compute-canary-rollout.yml"',
    );
    expect(resolve).toContain('test("^[0-9a-f]{40}$")');
    expect(resolve).toContain(
      'test("^v[0-9A-Za-z][0-9A-Za-z._-]*$")',
    );
    expect(resolve).toContain('.repository.full_name == $repository');
    expect(resolve).toContain('.head_repository.full_name == $repository');
    expect(resolve).toContain('.head_repository.id == .repository.id');
    expect(resolve).toContain('tag_ref="refs/tags/$head_branch"');
    expect(resolve).toContain(
      'resolved_tag_sha="$(git rev-parse "${tag_ref}^{commit}")"',
    );
    expect(resolve).toContain('[ "$resolved_tag_sha" = "$git_sha" ]');
  });

  it("uses only the dedicated read-only Cloudflare token and contains no rollout mutation path", async () => {
    const workflow = await text(".github/workflows/compute-probe.yml");
    const inspect = rolloutStep(
      workflow,
      "Inspect and bind the live production API/Compute pair",
    );
    const logicalLines = shellLogicalLines(workflow);
    const mutationCommands = logicalLines.filter((line) =>
      /\bnpx wrangler (?:versions (?:upload|deploy)|deploy\b|rollback\b|secret\b)/u
        .test(line)
    );

    expect(workflow).toContain("secrets.COMPUTE_PROBE_CLOUDFLARE_TOKEN");
    expect(workflow).not.toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(workflow).not.toContain("COMPUTE_EMERGENCY_STOP_TOKEN");
    expect(mutationCommands).toEqual([]);
    expect(inspect).toContain(
      "CLOUDFLARE_API_TOKEN: ${{ secrets.COMPUTE_PROBE_CLOUDFLARE_TOKEN }}",
    );
    expect(inspect).not.toContain(
      "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
    );
  });

  it("binds each admitted probe to live state, queue health, receipts, and a final fence", async () => {
    const workflow = await text(".github/workflows/compute-probe.yml");
    const probeVerifier = await text(
      "scripts/release/verify-compute-probe-evidence.mjs",
    );
    const resolveAt = workflow.indexOf("Resolve the active production canary");
    const inspectAt = workflow.indexOf(
      "Inspect and bind the live production API/Compute pair",
    );
    const suiteAt = workflow.indexOf("Run the deployed Compute probe suite");
    const snapshotAt = workflow.indexOf(
      "Read the least-privilege Compute certification snapshot",
    );
    const finalFenceAt = workflow.indexOf(
      "Final exact live fence after probe",
    );
    const verifyAt = workflow.indexOf("Verify Compute probe evidence");
    const manifestAt = workflow.indexOf(
      "Write deterministic probe evidence manifest",
    );
    const uploadAt = workflow.indexOf("Upload private probe evidence");
    const orderedSteps = [
      resolveAt,
      inspectAt,
      suiteAt,
      snapshotAt,
      finalFenceAt,
      verifyAt,
      manifestAt,
      uploadAt,
    ];
    const inspect = rolloutStep(
      workflow,
      "Inspect and bind the live production API/Compute pair",
    );
    const suite = rolloutStep(
      workflow,
      "Run the deployed Compute probe suite",
    );
    const snapshot = rolloutStep(
      workflow,
      "Read the least-privilege Compute certification snapshot",
    );
    const finalFence = rolloutStep(
      workflow,
      "Final exact live fence after probe",
    );
    const verify = rolloutStep(workflow, "Verify Compute probe evidence");

    expect(orderedSteps.every((position) => position > 0)).toBe(true);
    expect(orderedSteps).toEqual([...orderedSteps].sort((a, b) => a - b));
    expect(inspect).toContain("verify-api-compute-rollout-state.mjs");
    expect(workflow).toContain("queue-health.json");
    expect(suite).toContain("compute-certification-suite.mjs");
    expect(suite).toContain("probe-lifecycle");
    expect(suite).toContain("probe");
    expect(snapshot).toContain("COMPUTE_CERTIFICATION_TOKEN");
    expect(snapshot).toContain("/api/admin/compute/certification");
    expect(snapshot).not.toContain("COMPUTE_PROBE_CLOUDFLARE_TOKEN");
    expect(finalFence).toContain("verify-api-compute-rollout-state.mjs");
    expect(finalFence).toContain("final-live-state.json");
    expect(verify).toContain("verify-compute-probe-evidence.mjs");
    expect(verify).toContain("live-state.json");
    expect(verify).toContain("queue-health.json");
    expect(verify).toContain("compute-canary-probe.json");
    expect(verify).toContain(
      "galactic_compute_production_global_observation",
    );
    expect(verify).toContain("($initial[0] == $final[0])");
    expect(probeVerifier).toContain("--expected-outcome");
    expect(probeVerifier).toContain("--expected-mode");
    expect(probeVerifier).toContain("galactic_compute_production_probe");
    expect(probeVerifier).toContain("off_noop");
    expect(probeVerifier).toContain("browser_artifacts");
    expect(probeVerifier).toContain("reconciliation");
    for (const field of [
      "certification_principal",
      "oldest_age_seconds",
      "baseline_count",
      "final_count",
      "dlq_fenced_runs",
    ]) {
      expect(probeVerifier).toContain(field);
    }
  });

  it("records OFF as a successful non-admitting no-op and retains hashed evidence for 30 days", async () => {
    const workflow = await text(".github/workflows/compute-probe.yml");
    const suite = rolloutStep(
      workflow,
      "Run the deployed Compute probe suite",
    );
    const manifest = rolloutStep(
      workflow,
      "Write deterministic probe evidence manifest",
    );
    const upload = rolloutStep(workflow, "Upload private probe evidence");
    const verify = rolloutStep(workflow, "Verify Compute probe evidence");
    const offBranch = verify.slice(
      verify.indexOf("            off)"),
      verify.indexOf("            global)"),
    );

    expect(workflow).toContain("off_noop");
    expect(suite).toMatch(/if: .*\.outputs\.policy == 'canary'/u);
    expect(offBranch).toMatch(
      /off\)[\s\S]*--expected-mode lifecycle[\s\S]*--expected-outcome off_noop/u,
    );
    expect(offBranch).not.toContain("--predecessor-verification");
    expect(manifest).toContain("find . -type f ! -name evidence.sha256 -print0");
    expect(manifest).toContain("LC_ALL=C sort -z");
    expect(manifest).toContain("xargs -0 sha256sum");
    expect(upload).toContain("if: always()");
    expect(upload).toContain("compute-probe-production-");
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).toContain("retention-days: 30");
  });
});
