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
