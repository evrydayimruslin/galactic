#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureNode20, parseArgs, repoRoot } from "../analysis/_shared.mjs";
import { matchesWorkflowRunName } from "./workflow-run-name.mjs";

ensureNode20();

const REQUIRED_RUNS = [
  { name: "Staging Launch Gate", category: "staging_reference" },
  { name: "Supabase Production DB", category: "production" },
  { name: "API Deploy", category: "production" },
  { name: "Launch Web Deploy", category: "production" },
];

function printHelp() {
  console.log(
    `Usage: node scripts/release/check-production-launch-gate.mjs [options]

Options:
  --repository <owner/name>           GitHub repository (required)
  --tag <tag>                         Release tag name, e.g. v0.1.0 (required)
  --sha <sha>                         Tagged commit SHA (required)
  --write-json <path>                 Optional summary JSON output path
  --write-md <path>                   Optional summary markdown output path
  --poll-until-complete               Poll GitHub Actions until required workflows complete
  --timeout-seconds <seconds>         Poll timeout in seconds (default: 2700)
  --poll-interval-seconds <seconds>   Poll interval in seconds (default: 20)
  --help                              Show this help
`,
  );
}

const args = parseArgs(process.argv.slice(2));

if (args.has("--help")) {
  printHelp();
  process.exit(0);
}

const repository = String(args.get("--repository") || "").trim();
const releaseTag = String(args.get("--tag") || "").trim();
const candidateSha = String(args.get("--sha") || "").trim();
const outputJsonPath = typeof args.get("--write-json") === "string"
  ? resolve(repoRoot, args.get("--write-json"))
  : null;
const outputMarkdownPath = typeof args.get("--write-md") === "string"
  ? resolve(repoRoot, args.get("--write-md"))
  : null;
const pollUntilComplete = Boolean(args.has("--poll-until-complete"));
const timeoutSeconds = Number.parseInt(
  String(args.get("--timeout-seconds") || "2700"),
  10,
);
const pollIntervalSeconds = Number.parseInt(
  String(args.get("--poll-interval-seconds") || "20"),
  10,
);
const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!repository || !releaseTag || !candidateSha) {
  printHelp();
  console.error("Missing required arguments.");
  process.exit(1);
}

if (!githubToken) {
  console.error(
    "GITHUB_TOKEN (or GH_TOKEN) must be set before running the production launch gate check.",
  );
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function fetchWorkflowRuns() {
  const url = new URL(
    `https://api.github.com/repos/${repository}/actions/runs`,
  );
  url.searchParams.set("head_sha", candidateSha);
  url.searchParams.set("event", "push");
  url.searchParams.set("per_page", "100");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ultralight-production-launch-gate",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch workflow runs: ${response.status} ${await response
        .text()}`,
    );
  }

  const payload = await response.json();
  return Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
}

function pickLatestRun(runs, workflowName) {
  return runs
    .filter((run) => matchesWorkflowRunName(run.name, workflowName))
    .sort((left, right) => {
      const leftAttempt = Number(left.run_attempt || 0);
      const rightAttempt = Number(right.run_attempt || 0);
      if (rightAttempt !== leftAttempt) {
        return rightAttempt - leftAttempt;
      }
      return Number(right.id || 0) - Number(left.id || 0);
    })[0] || null;
}

function classifyRun(spec, run) {
  if (!run) {
    return {
      workflow: spec.name,
      category: spec.category,
      status: "waiting",
      conclusion: null,
      html_url: null,
      run_id: null,
      head_branch: null,
      note: "required workflow run not found yet",
    };
  }

  if (run.status !== "completed") {
    return {
      workflow: spec.name,
      category: spec.category,
      status: "waiting",
      conclusion: run.status,
      html_url: run.html_url,
      run_id: run.id,
      head_branch: run.head_branch || null,
      note: `workflow is ${run.status}`,
    };
  }

  if (run.conclusion === "success") {
    return {
      workflow: spec.name,
      category: spec.category,
      status: "passed",
      conclusion: run.conclusion,
      html_url: run.html_url,
      run_id: run.id,
      head_branch: run.head_branch || null,
      note: "workflow completed successfully",
    };
  }

  return {
    workflow: spec.name,
    category: spec.category,
    status: "failed",
    conclusion: run.conclusion,
    html_url: run.html_url,
    run_id: run.id,
    head_branch: run.head_branch || null,
    note: `workflow concluded with ${run.conclusion || "unknown"}`,
  };
}

function summarizeMarkdown({ gateResults, generatedAt }) {
  const lines = [
    "# Production Launch Gate Summary",
    "",
    `- release_tag: \`${releaseTag}\``,
    `- candidate_sha: \`${candidateSha}\``,
    `- repository: \`${repository}\``,
    `- generated_at: \`${generatedAt}\``,
    "",
    "## Staging Reference",
    "",
    "| Workflow | Status | Conclusion | Run | Note |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (
    const result of gateResults.filter((item) =>
      item.category === "staging_reference"
    )
  ) {
    const runLink = result.html_url ? `[run](${result.html_url})` : "-";
    lines.push(
      `| ${result.workflow} | ${result.status} | ${
        result.conclusion || "-"
      } | ${runLink} | ${result.note} |`,
    );
  }

  lines.push(
    "",
    "## Production Workflow Status",
    "",
    "| Workflow | Status | Conclusion | Run | Note |",
    "| --- | --- | --- | --- | --- |",
  );

  for (
    const result of gateResults.filter((item) => item.category === "production")
  ) {
    const runLink = result.html_url ? `[run](${result.html_url})` : "-";
    lines.push(
      `| ${result.workflow} | ${result.status} | ${
        result.conclusion || "-"
      } | ${runLink} | ${result.note} |`,
    );
  }

  lines.push(
    "",
    "Production promotion should not be considered complete until this gate is green and production smoke has been recorded in the release evidence directory.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

function writeOutputs(summary) {
  if (outputJsonPath) {
    mkdirSync(dirname(outputJsonPath), { recursive: true });
    writeFileSync(
      outputJsonPath,
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
  }

  if (outputMarkdownPath) {
    mkdirSync(dirname(outputMarkdownPath), { recursive: true });
    writeFileSync(outputMarkdownPath, summary.markdown, "utf8");
  }
}

try {
  const startedAt = Date.now();
  let gateResults = [];

  while (true) {
    const runs = await fetchWorkflowRuns();
    gateResults = REQUIRED_RUNS.map((spec) =>
      classifyRun(spec, pickLatestRun(runs, spec.name))
    );

    const waitingResults = gateResults.filter((result) =>
      result.status === "waiting"
    );
    const failedResults = gateResults.filter((result) =>
      result.status === "failed"
    );

    if (failedResults.length > 0) {
      break;
    }

    if (waitingResults.length === 0 || !pollUntilComplete) {
      break;
    }

    const elapsedDuringPoll = Math.floor((Date.now() - startedAt) / 1000);
    if (elapsedDuringPoll >= timeoutSeconds) {
      break;
    }

    await sleep(pollIntervalSeconds * 1000);
  }

  const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const generatedAt = new Date().toISOString();
  const failedResults = gateResults.filter((result) =>
    result.status === "failed"
  );
  const waitingResults = gateResults.filter((result) =>
    result.status === "waiting"
  );
  const passedResults = gateResults.filter((result) =>
    result.status === "passed"
  );

  let overallStatus = "passed";
  if (failedResults.length > 0) {
    overallStatus = "failed";
  } else if (waitingResults.length > 0) {
    overallStatus = "pending";
  }

  const summary = {
    generated_at: generatedAt,
    repository,
    release_tag: releaseTag,
    candidate_sha: candidateSha,
    counts: {
      passed: passedResults.length,
      failed: failedResults.length,
      waiting: waitingResults.length,
    },
    elapsed_seconds: elapsedSeconds,
    overall_status: overallStatus,
    workflows: gateResults,
  };

  summary.markdown = summarizeMarkdown({
    gateResults,
    generatedAt,
  });

  writeOutputs(summary);

  console.log(
    `Production launch gate status for ${releaseTag} (${candidateSha}): ${overallStatus}`,
  );
  for (const result of gateResults) {
    console.log(
      `- ${result.workflow}: ${result.status}${
        result.conclusion ? ` (${result.conclusion})` : ""
      }`,
    );
  }

  if (overallStatus === "failed") {
    process.exit(1);
  }

  if (overallStatus === "pending") {
    console.error(
      `Timed out waiting for required workflows after ${elapsedSeconds}s.`,
    );
    process.exit(1);
  }
} catch (error) {
  const generatedAt = new Date().toISOString();
  const summary = {
    generated_at: generatedAt,
    repository,
    release_tag: releaseTag,
    candidate_sha: candidateSha,
    counts: {
      passed: 0,
      failed: 1,
      waiting: 0,
    },
    elapsed_seconds: 0,
    overall_status: "failed",
    workflows: [],
    fatal_error: String(error instanceof Error ? error.message : error),
  };

  summary.markdown = [
    "# Production Launch Gate Summary",
    "",
    `- release_tag: \`${releaseTag}\``,
    `- candidate_sha: \`${candidateSha}\``,
    `- repository: \`${repository}\``,
    `- generated_at: \`${generatedAt}\``,
    "",
    `Fatal error: ${summary.fatal_error}`,
    "",
  ].join("\n");

  writeOutputs(summary);
  console.error(summary.fatal_error);
  process.exit(1);
}
