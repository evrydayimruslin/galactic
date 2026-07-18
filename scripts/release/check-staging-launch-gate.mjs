#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ensureNode20, parseArgs, repoRoot } from "../analysis/_shared.mjs";

ensureNode20();

const WORKFLOW_SPECS = [
  {
    name: "API CI",
    patterns: [
      "api/**",
      "capacity-tail-worker/**",
      "apps/**",
      "shared/**",
      "scripts/checks/**",
      "supabase/**",
      "scripts/supabase/**",
      "migration-*.sql",
      ".github/workflows/api-ci.yml",
    ],
  },
  {
    name: "Launch Guardrails",
    patterns: [
      "api/**",
      "capacity-tail-worker/**",
      "desktop/**",
      "shared/**",
      "sdk/**",
      "web/**",
      "scripts/checks/**",
      "migration-*.sql",
      ".gitignore",
      ".nvmrc",
      ".github/workflows/launch-guardrails.yml",
    ],
  },
  {
    name: "Supabase DB",
    patterns: [
      "supabase/**",
      "scripts/supabase/**",
      ".github/workflows/supabase-db.yml",
    ],
  },
  {
    name: "API Deploy",
    patterns: [
      "api/**",
      "capacity-tail-worker/**",
      "shared/**",
      ".github/workflows/api-deploy.yml",
    ],
  },
  {
    name: "Launch Web Deploy",
    patterns: [
      "apps/launch-web/**",
      "shared/contracts/launch.ts",
      "scripts/release/wait-for-workflow-run.mjs",
      "scripts/release/wait-for-workflow-run.test.mjs",
      ".github/workflows/launch-web-deploy.yml",
    ],
  },
];

function printHelp() {
  console.log(
    `Usage: node scripts/release/check-staging-launch-gate.mjs [options]

Options:
  --repository <owner/name>           GitHub repository (required)
  --sha <sha>                         Candidate commit SHA (required)
  --base <sha>                        Base SHA for changed-file comparison
  --changed-files-file <path>         Newline-delimited changed files (required)
  --write-json <path>                 Optional summary JSON output path
  --write-md <path>                   Optional summary markdown output path
  --poll-until-complete               Poll GitHub Actions until expected workflows complete
  --timeout-seconds <seconds>         Poll timeout in seconds (default: 1800)
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
const candidateSha = String(args.get("--sha") || "").trim();
const baseSha = String(args.get("--base") || "").trim() || null;
const changedFilesFile = String(args.get("--changed-files-file") || "").trim();
const outputJsonPath = typeof args.get("--write-json") === "string"
  ? resolve(repoRoot, args.get("--write-json"))
  : null;
const outputMarkdownPath = typeof args.get("--write-md") === "string"
  ? resolve(repoRoot, args.get("--write-md"))
  : null;
const pollUntilComplete = Boolean(args.has("--poll-until-complete"));
const timeoutSeconds = Number.parseInt(
  String(args.get("--timeout-seconds") || "1800"),
  10,
);
const pollIntervalSeconds = Number.parseInt(
  String(args.get("--poll-interval-seconds") || "20"),
  10,
);
const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!repository || !candidateSha || !changedFilesFile) {
  printHelp();
  console.error("Missing required arguments.");
  process.exit(1);
}

if (!githubToken) {
  console.error(
    "GITHUB_TOKEN (or GH_TOKEN) must be set before running the staging launch gate check.",
  );
  process.exit(1);
}

function normalizeChangedFiles(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function matchesPattern(file, pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return file.startsWith(`${prefix}/`);
  }

  if (pattern === "migration-*.sql") {
    return /^migration-[^/]+\.sql$/.test(file);
  }

  return file === pattern;
}

function workflowExpected(spec, changedFiles) {
  return changedFiles.some((file) =>
    spec.patterns.some((pattern) => matchesPattern(file, pattern))
  );
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
  url.searchParams.set("branch", "main");
  url.searchParams.set("per_page", "100");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ultralight-staging-launch-gate",
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
    .filter((run) => run.name === workflowName)
    .sort((left, right) => {
      const leftAttempt = Number(left.run_attempt || 0);
      const rightAttempt = Number(right.run_attempt || 0);
      if (rightAttempt !== leftAttempt) {
        return rightAttempt - leftAttempt;
      }
      return Number(right.id || 0) - Number(left.id || 0);
    })[0] || null;
}

function classifyRun(spec, run, expected) {
  if (!expected) {
    return {
      workflow: spec.name,
      expected: false,
      status: "not_required",
      conclusion: null,
      html_url: null,
      run_id: null,
      note: "not triggered by this candidate file set",
    };
  }

  if (!run) {
    return {
      workflow: spec.name,
      expected: true,
      status: "waiting",
      conclusion: null,
      html_url: null,
      run_id: null,
      note: "expected workflow run not found yet",
    };
  }

  if (run.status !== "completed") {
    return {
      workflow: spec.name,
      expected: true,
      status: "waiting",
      conclusion: run.status,
      html_url: run.html_url,
      run_id: run.id,
      note: `workflow is ${run.status}`,
    };
  }

  if (run.conclusion === "success") {
    return {
      workflow: spec.name,
      expected: true,
      status: "passed",
      conclusion: run.conclusion,
      html_url: run.html_url,
      run_id: run.id,
      note: "workflow completed successfully",
    };
  }

  return {
    workflow: spec.name,
    expected: true,
    status: "failed",
    conclusion: run.conclusion,
    html_url: run.html_url,
    run_id: run.id,
    note: `workflow concluded with ${run.conclusion || "unknown"}`,
  };
}

function summarizeMarkdown({ changedFiles, gateResults, generatedAt }) {
  const lines = [
    "# Staging Launch Gate Summary",
    "",
    `- candidate_sha: \`${candidateSha}\``,
    `- base_sha: \`${baseSha || "unknown"}\``,
    `- repository: \`${repository}\``,
    `- generated_at: \`${generatedAt}\``,
    "",
    "## Changed Files",
    "",
  ];

  if (changedFiles.length === 0) {
    lines.push("- none detected");
  } else {
    for (const file of changedFiles) {
      lines.push(`- \`${file}\``);
    }
  }

  lines.push(
    "",
    "## Workflow Status",
    "",
    "| Workflow | Expected | Status | Conclusion | Run | Note |",
    "| --- | --- | --- | --- | --- | --- |",
  );

  for (const result of gateResults) {
    const runLink = result.html_url ? `[run](${result.html_url})` : "-";
    lines.push(
      `| ${result.workflow} | ${
        result.expected ? "yes" : "no"
      } | ${result.status} | ${
        result.conclusion || "-"
      } | ${runLink} | ${result.note} |`,
    );
  }

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

const changedFilesText = await import("node:fs/promises").then(({ readFile }) =>
  readFile(changedFilesFile, "utf8")
);
const changedFiles = normalizeChangedFiles(changedFilesText);
const expectedWorkflows = WORKFLOW_SPECS.filter((spec) =>
  workflowExpected(spec, changedFiles)
);

try {
  const startedAt = Date.now();
  let runs = [];
  let gateResults = [];

  while (true) {
    runs = await fetchWorkflowRuns();
    gateResults = WORKFLOW_SPECS.map((spec) =>
      classifyRun(
        spec,
        pickLatestRun(runs, spec.name),
        expectedWorkflows.some((expected) => expected.name === spec.name),
      )
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
  const notRequiredResults = gateResults.filter((result) =>
    result.status === "not_required"
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
    candidate_sha: candidateSha,
    base_sha: baseSha,
    changed_files: changedFiles,
    expected_workflows: expectedWorkflows.map((spec) => spec.name),
    counts: {
      passed: passedResults.length,
      failed: failedResults.length,
      waiting: waitingResults.length,
      not_required: notRequiredResults.length,
    },
    elapsed_seconds: elapsedSeconds,
    overall_status: overallStatus,
    workflows: gateResults,
  };

  summary.markdown = summarizeMarkdown({
    changedFiles,
    gateResults,
    generatedAt,
  });

  writeOutputs(summary);

  console.log(
    `Staging launch gate status for ${candidateSha}: ${overallStatus}`,
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
    candidate_sha: candidateSha,
    base_sha: baseSha,
    changed_files: changedFiles,
    expected_workflows: expectedWorkflows.map((spec) => spec.name),
    counts: {
      passed: 0,
      failed: 1,
      waiting: 0,
      not_required: 0,
    },
    elapsed_seconds: 0,
    overall_status: "failed",
    workflows: [],
    fatal_error: String(error instanceof Error ? error.message : error),
  };

  summary.markdown = [
    "# Staging Launch Gate Summary",
    "",
    `- candidate_sha: \`${candidateSha}\``,
    `- base_sha: \`${baseSha || "unknown"}\``,
    `- repository: \`${repository}\``,
    `- generated_at: \`${generatedAt}\``,
    "",
    "## Changed Files",
    "",
    ...(changedFiles.length > 0
      ? changedFiles.map((file) => `- \`${file}\``)
      : ["- none detected"]),
    "",
    "## Expected Workflows",
    "",
    ...(expectedWorkflows.length > 0
      ? expectedWorkflows.map((spec) => `- ${spec.name}`)
      : ["- none"]),
    "",
    `Fatal error: ${summary.fatal_error}`,
    "",
  ].join("\n");

  writeOutputs(summary);
  console.error(summary.fatal_error);
  process.exit(1);
}
