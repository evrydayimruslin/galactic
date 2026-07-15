import assert from "node:assert/strict";
import test from "node:test";
import { matchesWorkflowRunName } from "./workflow-run-name.mjs";

test("matches a workflow's static name", () => {
  assert.equal(matchesWorkflowRunName("API Deploy", "API Deploy"), true);
});

test("matches a dynamic run title for the workflow", () => {
  assert.equal(
    matchesWorkflowRunName(
      "Staging launch gate (fcc2969a9eda205c034a55e5f420901e6d646f76)",
      "Staging Launch Gate",
    ),
    true,
  );
});

test("does not match unrelated workflows with a common prefix", () => {
  assert.equal(
    matchesWorkflowRunName("API Deploy Preview", "API Deploy"),
    false,
  );
});
