import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/compute-canary-rollout.yml", import.meta.url),
  "utf8",
);
const workerRefreshWorkflow = readFileSync(
  new URL("../../.github/workflows/compute-worker-refresh.yml", import.meta.url),
  "utf8",
);

function namedStepBlocks(source) {
  const starts = [...source.matchAll(/^      - name: /gmu)].map(
    (match) => match.index,
  );
  return starts.map((start, index) =>
    source.slice(start, starts[index + 1] ?? source.length),
  );
}

test("every rollout step using BASELINE_POLICY binds the captured baseline output", () => {
  const steps = namedStepBlocks(workflow).filter((step) =>
    step.includes("$BASELINE_POLICY"),
  );

  assert.ok(steps.length > 0, "expected rollout steps to use BASELINE_POLICY");
  for (const step of steps) {
    const name = step.match(/^      - name: (.+)$/mu)?.[1] ?? "unnamed step";
    assert.match(
      step,
      /^          BASELINE_POLICY: \$\{\{ steps\.baseline\.outputs\.policy \}\}$/mu,
      `${name} must bind BASELINE_POLICY before its strict shell reads it`,
    );
  }
});

test("routine provisioning is fenced before any admission version upload", () => {
  const refresh = workflow.indexOf(
    "      - name: Refresh the fixed certification fixture",
  );
  const routine = workflow.indexOf(
    "      - name: Ensure the fixed certification routine is paused and ready",
  );
  const upload = workflow.indexOf(
    "      - name: Upload and byte-verify rollback and desired policy versions",
  );
  assert.ok(refresh >= 0, "fixture refresh step is missing");
  assert.ok(routine > refresh, "routine preflight must follow fixture refresh");
  assert.ok(upload > routine, "routine preflight must precede version upload");

  const [refreshStep] = namedStepBlocks(workflow).filter((step) =>
    step.includes("name: Refresh the fixed certification fixture")
  );
  assert.ok(refreshStep, "fixture refresh step is missing");
  assert.match(
    refreshStep,
    /--reviewed-permission compute:exec,notify:owner \\/u,
  );

  const [routineStep] = namedStepBlocks(workflow).filter((step) =>
    step.includes(
      "name: Ensure the fixed certification routine is paused and ready",
    )
  );
  assert.ok(routineStep, "routine preflight step is missing");
  assert.match(routineStep, /inputs\.stage != 'revert_off'/u);
  assert.match(
    routineStep,
    /with-staging-owner-session\.mjs \\\n+            --target "\$REQUESTED_TARGET"/u,
  );
  assert.match(
    routineStep,
    /ensure-compute-certification-routine\.mjs \\\n+              --output "\$routine_preflight"/u,
  );
  assert.match(
    routineStep,
    /galactic_compute_certification_routine_preflight/u,
  );
  assert.match(routineStep, /\.function_policy == "free"/u);
  assert.match(routineStep, /\.active_run_count == 0/u);
  assert.match(routineStep, /stat -c '%a'/u);
});

test("post-promotion latch verification pins and stabilizes the exact candidate", () => {
  const [step] = namedStepBlocks(workflow).filter((candidate) =>
    candidate.includes(
      "name: Verify the emergency-stop latch after promotion",
    )
  );
  assert.ok(step, "post-promotion latch step is missing");
  assert.match(step, /umask 077/u);
  assert.match(
    step,
    /CANDIDATE_API_VERSION_ID: \$\{\{ steps\.prepare\.outputs\.candidate_version_id \}\}/u,
  );
  assert.match(step, /Cloudflare-Workers-Version-Overrides/u);
  assert.match(step, /for attempt in \{1\.\.12\}/u);
  assert.match(step, /consecutive=0/u);
  assert.match(step, /\[ "\$consecutive" -ge 3 \]/u);
  assert.match(step, /\$\{status_file%\.json\}-attempt-/u);
  assert.match(step, /"\$attempt_file" enabled clear/u);
  assert.match(step, /"\$attempt_file" disabled clear/u);
  assert.match(step, /if \[ "\$attempt" -lt 12 \]; then\n\s+sleep 5/u);
  assert.match(step, /"\$status_file" enabled clear/u);
  assert.doesNotMatch(step, /sleep (?:[6-9]|[1-9][0-9])/u);
});

test("certification and final read fences stay pinned to the promoted candidate", () => {
  const steps = namedStepBlocks(workflow);
  const [suite] = steps.filter((step) =>
    step.includes("name: Run the deployed Compute certification suite")
  );
  const [snapshot] = steps.filter((step) =>
    step.includes("name: Read the least-privilege Compute certification snapshot")
  );
  const [finalLatch] = steps.filter((step) =>
    step.includes("name: Final emergency-stop latch fence after certification")
  );
  assert.ok(suite && snapshot && finalLatch, "candidate-pinned steps are missing");
  assert.match(
    suite,
    /COMPUTE_CERTIFICATION_API_VERSION_ID: \$\{\{ steps\.prepare\.outputs\.candidate_version_id \}\}/u,
  );
  for (const step of [snapshot, finalLatch]) {
    assert.match(
      step,
      /CANDIDATE_API_VERSION_ID: \$\{\{ steps\.prepare\.outputs\.candidate_version_id \}\}/u,
    );
    assert.match(step, /Cloudflare-Workers-Version-Overrides/u);
  }
});

test("every OFF transition waits only for the exact enabled predecessor", () => {
  for (const name of [
    "Verify the emergency-stop latch after promotion",
    "Verify the emergency-stop latch after OFF compensation",
    "Verify the emergency-stop latch after unpublished-evidence OFF restore",
  ]) {
    const [step] = namedStepBlocks(workflow).filter((candidate) =>
      candidate.includes(`name: ${name}`)
    );
    assert.ok(step, `${name} step is missing`);
    assert.match(step, /umask 077/u);
    assert.match(step, /for attempt in \{1\.\.12\}/u);
    assert.match(step, /\$\{status_file%\.json\}-attempt-/u);
    assert.match(step, /"\$attempt_file" disabled clear/u);
    assert.match(step, /"\$attempt_file" enabled clear/u);
    assert.match(step, /Cache-Control: no-cache/u);
    assert.match(step, /if \[ "\$attempt" -lt 12 \]; then\n\s+sleep 5/u);
    assert.doesNotMatch(step, /sleep (?:[6-9]|[1-9][0-9])/u);
  }
});

test("Worker refresh reuses the certified digest and fails back to this dispatch's version", () => {
  assert.match(workerRefreshWorkflow, /compute_release_run_id:/u);
  assert.match(workerRefreshWorkflow, /predecessor_worker_refresh_run_id:/u);
  assert.match(workerRefreshWorkflow, /schema_version: 3/u);
  assert.match(workerRefreshWorkflow, /worker_transition/u);
  assert.match(
    workerRefreshWorkflow,
    /group: api-\$\{\{ inputs\.target \}\}-deploy/u,
  );
  assert.match(
    workerRefreshWorkflow,
    /verify-compute-rollout-release-evidence\.mjs/u,
  );
  assert.match(
    workerRefreshWorkflow,
    /git merge-base --is-ancestor "\$predecessor_sha" "\$GITHUB_SHA"/u,
  );
  assert.match(
    workerRefreshWorkflow,
    /verify-compute-worker-refresh-evidence\.mjs \\\n+\s+verify "\$predecessor_artifact_dir"/u,
  );
  assert.match(
    workerRefreshWorkflow,
    /Live Compute does not match the verified predecessor Worker refresh/u,
  );
  assert.match(
    workerRefreshWorkflow,
    /image = "\.\/images\/standard\/Dockerfile"/u,
  );
  assert.match(workerRefreshWorkflow, /--containers-rollout=none/u);
  assert.doesNotMatch(workerRefreshWorkflow, /--containers-rollout=(?:gradual|immediate)/u);
  assert.doesNotMatch(workerRefreshWorkflow, /docker (?:build|push)/u);
  assert.match(
    workerRefreshWorkflow,
    /before-container-readiness\.json/u,
  );
  assert.match(
    workerRefreshWorkflow,
    /after-container-readiness\.json/u,
  );
  assert.match(
    workerRefreshWorkflow,
    /verify-compute-worker-refresh-evidence\.mjs \\\n+\s+build/u,
  );
  assert.match(
    workerRefreshWorkflow,
    /PREVIOUS_COMPUTE_VERSION_ID: \$\{\{ steps\.before\.outputs\.previous_compute_version_id \}\}/u,
  );
  assert.match(
    workerRefreshWorkflow,
    /versions deploy "\$PREVIOUS_COMPUTE_VERSION_ID@100%"/u,
  );
  assert.match(workerRefreshWorkflow, /steps\.upload_evidence\.outcome != 'success'/u);

  assert.match(workflow, /compute_worker_refresh_run_id:/u);
  assert.match(
    workflow,
    /verify-compute-worker-refresh-evidence\.mjs \\\n+\s+verify/u,
  );
  assert.match(workflow, /compute_worker_refresh: \$compute_worker_refresh/u);
  assert.match(
    workflow,
    /Live Compute does not match the verified image release and Worker refresh chain/u,
  );
});
