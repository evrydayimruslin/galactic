import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("ordinary production releases do not require a Compute deployment", async () => {
  const gate = await readFile(
    new URL("./check-production-launch-gate.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(gate, /name:\s*['"]Compute Deploy['"]/u);
  assert.match(gate, /name:\s*['"]API Deploy['"]/u);
  assert.match(gate, /name:\s*['"]Supabase Production DB['"]/u);
  assert.match(gate, /name:\s*['"]Launch Web Deploy['"]/u);
});

test("Compute CI automates contracts while keeping image certification manual", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/compute-ci.yml", import.meta.url),
    "utf8",
  );
  const triggerBlock = workflow.slice(
    workflow.indexOf("on:"),
    workflow.indexOf("permissions:"),
  );

  assert.match(triggerBlock, /workflow_dispatch:\s*\{\}/u);
  assert.match(triggerBlock, /pull_request:/u);
  assert.match(triggerBlock, /push:/u);

  const contractsJob = workflow.slice(
    workflow.indexOf("  contracts:"),
    workflow.indexOf("  image:"),
  );
  const imageJob = workflow.slice(workflow.indexOf("  image:"));

  assert.doesNotMatch(contractsJob, /github\.event_name\s*==\s*['"]workflow_dispatch['"]/u);
  assert.match(imageJob, /if:\s*github\.event_name\s*==\s*['"]workflow_dispatch['"]/u);
  assert.match(imageJob, /needs:\s*contracts/u);
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
