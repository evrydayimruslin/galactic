#!/usr/bin/env node
// G1 smoke-suite orchestrator — runs the WHOLE smoke pass into one evidence dir
// so "run the staging smoke" is a single command. It wraps run-release-smoke
// (guardrails / auth / API / CORS / chat) and the standalone smokes
// (launch-web-pages, durable-exec, interface-deploy), records
// each one's exit code, and writes a top-level g1-smoke-suite-summary.{json,md}.
//
// A smoke is SKIPPED (not failed) when its required inputs aren't provided, so
// you can run a partial pass and fill gaps later. Exit 0 = every RUN smoke
// passed; exit 1 = a run smoke failed.
//
// Usage (staging):
//   node scripts/smoke/run-staging-smoke-suite.mjs \
//     --target staging \
//     --token <ul_ api token> \
//     --durable-app <agent id> --durable-function <fn>  # enables durable-exec
//     [--exercise-chat]                        # legacy chat only; not launch certification
//     [--output-dir <dir>]                     # default: docs/_generated/launch/<target>/<candidate-id>
//
// Evidence lands in docs/_generated/launch/<target>/<candidate-id>/ (gitignored).

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { ensureNode20, parseArgs, repoRoot } from "../analysis/_shared.mjs";

ensureNode20();
const args = parseArgs(process.argv.slice(2));

const target = String(args.get("--target") || "staging").trim().toLowerCase();
if (!["staging", "production"].includes(target)) {
  console.error("run-staging-smoke-suite requires --target staging|production");
  process.exit(1);
}
const apiBase = String(
  args.get("--url") || process.env.ULTRALIGHT_API_URL ||
    (target === "production"
      ? "https://api.connectgalactic.com"
      : "https://ultralight-api-staging.rgn4jz429m.workers.dev"),
).replace(/\/$/, "");
const supabaseUrl = String(
  args.get("--supabase-url") || process.env.ULTRALIGHT_SUPABASE_URL ||
    (target === "production"
      ? "https://uavjzycsltdnwblwutmb.supabase.co"
      : "https://mtekfhozmsboxizxxxyn.supabase.co"),
).replace(/\/$/, "");
const token = String(args.get("--token") || process.env.ULTRALIGHT_TOKEN || "").trim();
const durableApp = String(args.get("--durable-app") || "").trim();
const durableFn = String(args.get("--durable-function") || "").trim();
const exerciseChat = args.has("--exercise-chat");

function sh(cmd) {
  try { return execSync(cmd, { cwd: repoRoot }).toString().trim(); } catch { return ""; }
}
const sha = (sh("git rev-parse HEAD") || "0000000").slice(0, 7);
const day = new Date().toISOString().slice(0, 10);
const candidateId = String(args.get("--candidate-id") || `${day}-main-${sha}`).trim();
const outputDir = String(args.get("--output-dir") || "").trim() ||
  join("docs", "_generated", "launch", target, candidateId);
const smokeDir = join(outputDir, "smoke");
mkdirSync(smokeDir, { recursive: true });

function runStep({ name, command, commandArgs, env, skipReason }) {
  if (skipReason) {
    console.log(`SKIP [${name}] ${skipReason}`);
    return Promise.resolve({ name, status: "skipped", reason: skipReason });
  }
  const logPath = join(smokeDir, `${name}.log`);
  writeFileSync(logPath, "");
  console.log(`\n──────── ${name} ────────`);
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk) => { const t = chunk.toString(); process.stdout.write(t); appendFileSync(logPath, t); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      resolve({
        name,
        status: code === 0 ? "passed" : "failed",
        exit_code: code,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        log: logPath,
      });
    });
    child.on("error", (err) => {
      appendFileSync(logPath, `\n[wrapper-error] ${String(err)}\n`);
      resolve({ name, status: "failed", exit_code: null, log: logPath, error: String(err) });
    });
  });
}

const results = [];

// 1. Core release smoke (guardrails / auth / API / CORS / [chat]) — manages its
//    own evidence under <outputDir>/smoke + <outputDir>/metadata.json.
results.push(await runStep({
  name: "release-smoke",
  command: "node",
  commandArgs: [
    "scripts/smoke/run-release-smoke.mjs",
    "--target", target,
    "--url", apiBase,
    "--supabase-url", supabaseUrl,
    "--output-dir", outputDir,
    ...(token ? ["--token", token] : []),
    ...(exerciseChat ? ["--exercise-chat"] : []),
  ],
}));

// 2. Launch-web pages (SPA shell + public + authed API probes).
results.push(await runStep({
  name: "launch-web-pages",
  command: "node",
  commandArgs: [
    "scripts/smoke/launch-web-pages-smoke.mjs",
    "--target", target,
    "--api-url", apiBase,
    "--output-dir", outputDir,
    ...(token ? ["--token", token] : []),
  ],
}));

// 3. Durable-execution spine (needs a real async-capable Agent + function).
results.push(await runStep({
  name: "durable-exec",
  command: "node",
  commandArgs: [
    "scripts/smoke/durable-exec-smoke.mjs",
    "--url", apiBase,
    "--token", token,
    "--app", durableApp,
    "--function", durableFn,
  ],
  skipReason: (token && durableApp && durableFn)
    ? "" : "needs --token + --durable-app + --durable-function",
}));

// 4. Interface deploy+render (uploads the fixed reference Agent, private).
results.push(await runStep({
  name: "interface-deploy",
  command: "node",
  commandArgs: ["scripts/smoke/interface-deploy-smoke.mjs", "--url", apiBase],
  env: { ULTRALIGHT_TOKEN: token },
  skipReason: token ? "" : "needs --token (agents:build scope)",
}));

// ── Aggregate ──
const counts = {
  passed: results.filter((r) => r.status === "passed").length,
  failed: results.filter((r) => r.status === "failed").length,
  skipped: results.filter((r) => r.status === "skipped").length,
};
const summary = {
  suite: "g1-staging-smoke-suite",
  target, api: apiBase, candidate_id: candidateId, commit_sha: sh("git rev-parse HEAD"),
  generated_at: new Date().toISOString(), counts, results,
};
writeFileSync(join(outputDir, "g1-smoke-suite-summary.json"), JSON.stringify(summary, null, 2));
const md = [
  `# G1 smoke suite — ${target} — ${candidateId}`,
  ``, `API: ${apiBase}  ·  passed ${counts.passed} / failed ${counts.failed} / skipped ${counts.skipped}`,
  ``, `| smoke | status | exit | log |`, `| --- | --- | --- | --- |`,
  ...results.map((r) => `| ${r.name} | ${r.status} | ${r.exit_code ?? "-"} | ${r.log ? r.log.replace(outputDir + "/", "") : "-"} |`),
  ``, counts.skipped ? `> Skipped smokes need more inputs — see the reasons in stdout.` : ``,
].join("\n");
writeFileSync(join(outputDir, "g1-smoke-suite-summary.md"), md);

console.log(`\n════════ G1 smoke suite ════════`);
console.log(`evidence: ${outputDir}`);
console.log(`passed ${counts.passed} · failed ${counts.failed} · skipped ${counts.skipped}`);
for (const r of results) console.log(`  ${r.status.toUpperCase().padEnd(7)} ${r.name}${r.reason ? ` (${r.reason})` : ""}`);

if (counts.failed > 0) {
  console.error(`\nG1 smoke suite: ${counts.failed} smoke(s) FAILED — see logs in ${smokeDir}`);
  process.exit(1);
}
if (counts.passed === 0) {
  console.error(`\nG1 smoke suite: nothing ran (everything skipped) — provide --token and the rest.`);
  process.exit(2);
}
console.log(`\nG1 smoke suite: all run smokes passed.`);
