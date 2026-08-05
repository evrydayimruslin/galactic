import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/compute-canary-rollout.yml", import.meta.url),
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
