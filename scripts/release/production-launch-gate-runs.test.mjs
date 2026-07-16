import assert from "node:assert/strict";
import test from "node:test";

import { pickLatestWorkflowRun } from "./production-launch-gate-runs.mjs";

const releaseTag = "v0.4.35";

test("accepts an exact-SHA manual staging gate and picks the latest attempt", () => {
  const spec = {
    name: "Staging Launch Gate",
    category: "staging_reference",
    allowedEvents: ["push", "workflow_dispatch"],
  };
  const picked = pickLatestWorkflowRun({
    spec,
    releaseTag,
    runs: [
      { id: 10, name: spec.name, event: "push", run_attempt: 1, head_branch: "main" },
      { id: 11, name: spec.name, event: "workflow_dispatch", run_attempt: 2, head_branch: "main" },
    ],
  });
  assert.equal(picked.id, 11);
});

test("production evidence must come from the release tag push", () => {
  const spec = {
    name: "API Deploy",
    category: "production",
    allowedEvents: ["push"],
  };
  const picked = pickLatestWorkflowRun({
    spec,
    releaseTag,
    runs: [
      { id: 20, name: spec.name, event: "workflow_dispatch", head_branch: releaseTag },
      { id: 21, name: spec.name, event: "push", head_branch: "main" },
      { id: 22, name: spec.name, event: "push", head_branch: releaseTag },
    ],
  });
  assert.equal(picked.id, 22);
});

test("returns null when only manual or wrong-ref production runs exist", () => {
  const spec = {
    name: "Launch Web Deploy",
    category: "production",
    allowedEvents: ["push"],
  };
  assert.equal(
    pickLatestWorkflowRun({
      spec,
      releaseTag,
      runs: [
        { id: 30, name: spec.name, event: "workflow_dispatch", head_branch: releaseTag },
        { id: 31, name: spec.name, event: "push", head_branch: "main" },
      ],
    }),
    null,
  );
});
