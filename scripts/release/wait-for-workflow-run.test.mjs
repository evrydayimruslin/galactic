import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWorkflowRun,
  pickMatchingWorkflowRun,
} from "./wait-for-workflow-run.mjs";

const candidate = {
  workflowName: "API Deploy",
  sha: "abc123",
  refName: "v0.4.39",
  event: "push",
};

test("selects only the exact SHA, ref, event, and workflow", () => {
  const picked = pickMatchingWorkflowRun({
    ...candidate,
    runs: [
      { id: 1, name: "API Deploy", head_sha: "abc123", head_branch: "main", event: "push" },
      { id: 2, name: "API Deploy", head_sha: "other", head_branch: "v0.4.39", event: "push" },
      { id: 3, name: "API Deploy", head_sha: "abc123", head_branch: "v0.4.39", event: "workflow_dispatch" },
      { id: 4, name: "Launch Web Deploy", head_sha: "abc123", head_branch: "v0.4.39", event: "push" },
      { id: 5, name: "API Deploy", head_sha: "abc123", head_branch: "v0.4.39", event: "push" },
    ],
  });
  assert.equal(picked?.id, 5);
});

test("prefers the latest rerun attempt", () => {
  const picked = pickMatchingWorkflowRun({
    ...candidate,
    runs: [
      { id: 10, run_attempt: 1, name: "API Deploy", head_sha: "abc123", head_branch: "v0.4.39", event: "push" },
      { id: 9, run_attempt: 2, name: "API Deploy", head_sha: "abc123", head_branch: "v0.4.39", event: "push" },
    ],
  });
  assert.equal(picked?.id, 9);
});

test("classifies missing, active, successful, and failed runs", () => {
  assert.equal(classifyWorkflowRun(null), "waiting");
  assert.equal(classifyWorkflowRun({ status: "in_progress" }), "waiting");
  assert.equal(
    classifyWorkflowRun({ status: "completed", conclusion: "success" }),
    "passed",
  );
  assert.equal(
    classifyWorkflowRun({ status: "completed", conclusion: "cancelled" }),
    "failed",
  );
});
