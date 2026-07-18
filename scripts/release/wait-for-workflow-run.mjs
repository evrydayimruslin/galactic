#!/usr/bin/env node

import process from "node:process";
import { ensureNode20, parseArgs } from "../analysis/_shared.mjs";

ensureNode20();

export function pickMatchingWorkflowRun({
  runs,
  workflowName,
  sha,
  refName,
  event,
}) {
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run?.name === workflowName)
    .filter((run) => run?.head_sha === sha)
    .filter((run) => run?.head_branch === refName)
    .filter((run) => run?.event === event)
    .sort((left, right) => {
      const attemptDelta = Number(right.run_attempt || 0) -
        Number(left.run_attempt || 0);
      return attemptDelta || Number(right.id || 0) - Number(left.id || 0);
    })[0] || null;
}

export function classifyWorkflowRun(run) {
  if (!run || run.status !== "completed") return "waiting";
  return run.conclusion === "success" ? "passed" : "failed";
}

function usage() {
  console.log(`Usage: node scripts/release/wait-for-workflow-run.mjs [options]

Options:
  --repository <owner/name>          GitHub repository
  --workflow <file-or-id>            Workflow file or id
  --workflow-name <name>             Static workflow name
  --sha <sha>                        Exact candidate SHA
  --ref-name <branch-or-tag>         Exact head branch/tag name
  --event <event>                    Exact event (default: push)
  --timeout-seconds <seconds>        Bounded wait (default: 2400)
  --poll-interval-seconds <seconds>  Poll interval (default: 20)
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("--help")) {
    usage();
    return;
  }

  const repository = String(args.get("--repository") || "").trim();
  const workflow = String(args.get("--workflow") || "").trim();
  const workflowName = String(args.get("--workflow-name") || "").trim();
  const sha = String(args.get("--sha") || "").trim();
  const refName = String(args.get("--ref-name") || "").trim();
  const event = String(args.get("--event") || "push").trim();
  const timeoutSeconds = Number.parseInt(
    String(args.get("--timeout-seconds") || "2400"),
    10,
  );
  const pollIntervalSeconds = Number.parseInt(
    String(args.get("--poll-interval-seconds") || "20"),
    10,
  );
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

  if (!repository || !workflow || !workflowName || !sha || !refName || !token) {
    usage();
    throw new Error("Missing workflow wait arguments or GH_TOKEN/GITHUB_TOKEN.");
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("--timeout-seconds must be a positive integer.");
  }
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new Error("--poll-interval-seconds must be a positive integer.");
  }

  const encodedWorkflow = encodeURIComponent(workflow);
  const startedAt = Date.now();
  while (true) {
    const url = new URL(
      `https://api.github.com/repos/${repository}/actions/workflows/${encodedWorkflow}/runs`,
    );
    url.searchParams.set("head_sha", sha);
    url.searchParams.set("event", event);
    url.searchParams.set("per_page", "20");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "galactic-release-order-gate",
      },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub workflow lookup failed: ${response.status} ${await response.text()}`,
      );
    }

    const payload = await response.json();
    const run = pickMatchingWorkflowRun({
      runs: payload.workflow_runs,
      workflowName,
      sha,
      refName,
      event,
    });
    const state = classifyWorkflowRun(run);
    if (state === "passed") {
      console.log(
        `${workflowName} succeeded for ${refName}@${sha}: ${run.html_url || run.id}`,
      );
      return;
    }
    if (state === "failed") {
      throw new Error(
        `${workflowName} concluded ${run.conclusion || "unsuccessfully"} for ${refName}@${sha}: ${run.html_url || run.id}`,
      );
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedSeconds >= timeoutSeconds) {
      throw new Error(
        `Timed out after ${elapsedSeconds}s waiting for ${workflowName} at ${refName}@${sha}.`,
      );
    }
    console.log(
      `Waiting for ${workflowName} at ${refName}@${sha} (${run?.status || "missing"}; ${elapsedSeconds}s/${timeoutSeconds}s).`,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, pollIntervalSeconds * 1000)
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
