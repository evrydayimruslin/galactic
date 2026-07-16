#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ensureNode20, parseArgs, repoRoot } from "../analysis/_shared.mjs";

ensureNode20();

function printHelp() {
  console.log(`Usage: node scripts/ops/init-release-packet.mjs [options]

Options:
  --target <staging|production>   Release target label (default: staging)
  --candidate-id <id>             Candidate identifier (default: inferred from output dir)
  --git-ref <ref>                 Git ref label such as main or refs/tags/v0.1.0
  --commit-sha <sha>              Candidate commit SHA
  --version-tag <tag>             Version tag such as v0.1.0
  --operator <name>               Operator name or redacted id (default: $USER)
  --release-lead <name>           Release decision owner
  --rollback-owner <name>         Rollback execution owner
  --communications-owner <name>   Launch/status communications owner
  --output-dir <path>             Output directory (defaults to $UL_LAUNCH_EVIDENCE_DIR)
  --force                         Overwrite existing release-packet.md
  --help                          Show this help
`);
}

const args = parseArgs(process.argv.slice(2));

if (args.has("--help")) {
  printHelp();
  process.exit(0);
}

const target = String(args.get("--target") || "staging").trim();
const operator = String(args.get("--operator") || process.env.USER || "unknown")
  .trim();
const releaseLead = String(args.get("--release-lead") || "Russell In").trim();
const rollbackOwner = String(args.get("--rollback-owner") || "Russell In").trim();
const communicationsOwner = String(
  args.get("--communications-owner") || "Russell In",
).trim();
const force = Boolean(args.has("--force"));
const configuredOutput = String(args.get("--output-dir") || "").trim();
const envOutput = process.env.UL_LAUNCH_EVIDENCE_DIR
  ? resolve(repoRoot, process.env.UL_LAUNCH_EVIDENCE_DIR)
  : "";
const outputDir = configuredOutput
  ? resolve(repoRoot, configuredOutput)
  : envOutput;

if (!outputDir) {
  printHelp();
  console.error(
    "An output directory is required. Pass --output-dir or set UL_LAUNCH_EVIDENCE_DIR.",
  );
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const inferredCandidateId = basename(outputDir);
const candidateId = String(args.get("--candidate-id") || inferredCandidateId)
  .trim();
const gitRef = String(
  args.get("--git-ref") ||
    (target === "production" ? "refs/tags/<tag>" : "main"),
).trim();
const commitSha = String(args.get("--commit-sha") || "<commit-sha>").trim();
const versionTag = String(
  args.get("--version-tag") || (target === "production" ? "<version-tag>" : ""),
).trim();

const packetPath = resolve(outputDir, "release-packet.md");

if (existsSync(packetPath) && !force) {
  console.log(`Skipped existing file: ${packetPath}`);
  process.exit(0);
}

const packet = `# Release Packet

- target: ${target}
- candidate_id: ${candidateId}
- commit_sha: ${commitSha}
- git_ref: ${gitRef}
- version_tag: ${versionTag || "n/a"}
- prepared_at: ${new Date().toISOString()}
- prepared_by: ${operator}

## Decision Summary

- decision: pending
- release lead: ${releaseLead}
- rollback owner: ${rollbackOwner}
- communications owner: ${communicationsOwner}
- stop-ship items present: unknown
- release summary:

## Candidate Identity

| Field | Value |
| --- | --- |
| Target | ${target} |
| Candidate ID | ${candidateId} |
| Commit SHA | ${commitSha} |
| Git ref | ${gitRef} |
| Version tag | ${versionTag || "n/a"} |
| Evidence root | ${outputDir} |
| Metadata file | metadata.json |

## Automated Proof

### Required workflow runs

| Workflow | Status | URL | Notes |
| --- | --- | --- | --- |
| API CI | pending | | |
| Launch Guardrails | pending | | |
| ${
  target === "production" ? "Supabase Production DB" : "Supabase DB"
} | pending | | |
| API Deploy | pending | | |
| Launch Web Deploy | pending | | |
| Desktop build/release | not-applicable | | Deferred from persistent-Agent web/API launch |
| ${
  target === "production" ? "Production Launch Gate" : "Staging Launch Gate"
} | pending | | |

### Smoke artifacts

| Artifact | Path | Result | Notes |
| --- | --- | --- | --- |
| Guardrails | smoke/guardrails.txt | pending | |
| Auth redirect smoke | smoke/auth-redirect.log | pending | |
| API smoke | smoke/api-smoke.log | pending | |
| CORS allowed probe | smoke/cors-allowed.* | pending | |
| CORS blocked probe | smoke/cors-blocked.* | pending | |
| Smoke summary | smoke/summary.md | pending | |

### Audit outputs

List only the audits relevant to this candidate.

| Audit | Path | Result | Notes |
| --- | --- | --- | --- |
| Supabase config audit | audits/supabase-audit.json | not-applicable | |
| Manifest coverage audit | audits/manifest-coverage-audit.json | not-applicable | |
| Token compatibility audit | audits/token-compat-audit.json | not-applicable | |
| Secret crypto audit | audits/secret-crypto-audit.json | not-applicable | |

## Manual Checks

### Canonical product checks

| Check | Result | Evidence | Notes |
| --- | --- | --- | --- |
| Sign in and account projection | pending | manual/canonical-journey.md | |
| Conjure, test, upload fixed private Agent | pending | smoke/interface-deploy.log | |
| Configure mission/cadence/authority | pending | manual/canonical-journey.md | |
| Activate, wake, observe report | pending | manual/canonical-journey.md | |
| Capacity state/reset projection | pending | smoke/launch-web-pages.md | |
| Subscription checkout/portal | pending | manual/canonical-journey.md | |
| Desktop/updater | not-applicable | | Deferred from launch scope |

### Recovery evidence

| Exercise | Result | Evidence | Notes |
| --- | --- | --- | --- |
| Backup / restore drill | pending | restore-drill/notes.md | |
| Rollback rehearsal | pending | rollback-rehearsal/notes.md | |

## Unresolved Exceptions

List only what is still relevant to this candidate.

| Exception | Class | Evidence | Decision |
| --- | --- | --- | --- |
| Shared R2 object store | launch exception | docs/ENVIRONMENT_ISOLATION_MATRIX.md | pending |
| Shared KV cache/index | launch exception | docs/ENVIRONMENT_ISOLATION_MATRIX.md | pending |
| Production-only secondary worker, if touched | explicit exception or stop-ship | docs/ENVIRONMENT_ISOLATION_MATRIX.md | not-applicable |

## Scorecard Review

| Class | Result | Evidence | Notes |
| --- | --- | --- | --- |
| Repo-backed items reviewed | pending | docs/LAUNCH_SCORECARD.md | |
| Operational items backed by candidate evidence | pending | docs/LAUNCH_SCORECARD.md + local packet artifacts | |
| Launch exceptions explicitly accepted or cleared | pending | docs/LAUNCH_SCORECARD.md + docs/ENVIRONMENT_ISOLATION_MATRIX.md | |
| Signoff policy satisfied | pending | docs/LAUNCH_SIGNOFF_POLICY.md | |

## Go / No-Go Checklist

- [ ] required workflow runs succeeded
- [ ] required smoke passed
- [ ] canonical website + connected-agent journey completed
- [ ] required audits reviewed
- [ ] restore / rollback evidence reviewed when in scope
- [ ] unresolved exceptions explicitly accepted or cleared
- [ ] scorecard reviewed per the launch signoff policy
- [ ] rollback owner is identified
- [ ] communications owner is identified

## Final Signoff

- decision time:
- approver:
- rollback owner: ${rollbackOwner}
- communications owner: ${communicationsOwner}
- announcement blocked until production smoke complete: ${
  target === "production" ? "yes" : "n/a"
}
- follow-up issues opened:
`;

writeFileSync(packetPath, packet, "utf8");
console.log(`Wrote ${packetPath}`);
