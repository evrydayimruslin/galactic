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
    expect(deploy).toContain("schema_version: 3");
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
    const workflows = await Promise.all([
      text(".github/workflows/compute-deploy.yml"),
      text(".github/workflows/compute-admission.yml"),
    ]);
    for (const workflow of workflows) {
      expect(workflow).toContain(
        'container_application="${compute_worker}-computestandard"',
      );
      expect(workflow).toContain('"$CONTAINER_APPLICATION"');
      expect(workflow).not.toContain(
        '"$container_list" "$COMPUTE_WORKER"',
      );
    }
  });

  it("keeps checkout/schema/live-infrastructure checks out of emergency disable", async () => {
    const admission = await text(".github/workflows/compute-admission.yml");
    const resolveStart = admission.indexOf("Resolve certified OFF version from Compute release evidence");
    const certifiedCheckout = admission.indexOf("Checkout certified release source for fail-safe disable");
    const toolchainInstall = admission.indexOf("Install the action-appropriate pinned API toolchain");
    const nextStep = admission.indexOf("Verify certified versions and enable preconditions", resolveStart);
    const resolveStep = admission.slice(resolveStart, nextStep);
    const enableBranch = resolveStep.indexOf('if [ "$REQUESTED_ACTION" = "enable" ]; then');
    const localManifest = resolveStep.indexOf("local-compute-migrations.sha256");
    expect(enableBranch).toBeGreaterThan(0);
    expect(localManifest).toBeGreaterThan(enableBranch);
    expect(resolveStep).not.toContain("local_retention_hash");
    expect(certifiedCheckout).toBeGreaterThan(resolveStart);
    expect(toolchainInstall).toBeGreaterThan(certifiedCheckout);
    expect(nextStep).toBeGreaterThan(toolchainInstall);
    expect(admission).toContain("ref: ${{ steps.resolve_release.outputs.release_sha }}");
    expect(admission).toContain('pushd "$API_SOURCE_ROOT/api"');

    const resourcesStart = admission.indexOf("Verify enable-only resources and secret names");
    const resourcesEnd = admission.indexOf("Typecheck and dry-run strict enable upload", resourcesStart);
    const resourcesStep = admission.slice(resourcesStart, resourcesEnd);
    expect(resourcesStep).toContain("inputs.action == 'enable'");
    expect(resourcesStep).toContain("/domains/managed");
    expect(resourcesStep).toContain("verify-container-readiness.mjs");
  });
});
