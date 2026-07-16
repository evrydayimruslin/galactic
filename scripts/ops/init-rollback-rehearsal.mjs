#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { ensureNode20, parseArgs, repoRoot } from '../analysis/_shared.mjs';

ensureNode20();

function printHelp() {
  console.log(`Usage: node scripts/ops/init-rollback-rehearsal.mjs [options]

Options:
  --target <staging|production>   Rehearsal target label (default: production)
  --candidate-id <id>             Candidate identifier (default: inferred from output dir)
  --output-dir <path>             Output directory (defaults to $UL_LAUNCH_EVIDENCE_DIR/rollback-rehearsal)
  --operator <name>               Operator name or redacted id (default: $USER)
  --force                         Overwrite existing scaffold files
  --help                          Show this help
`);
}

const args = parseArgs(process.argv.slice(2));

if (args.has('--help')) {
  printHelp();
  process.exit(0);
}

const target = String(args.get('--target') || 'production').trim();
const operator = String(args.get('--operator') || process.env.USER || 'unknown').trim();
const force = Boolean(args.has('--force'));

const configuredOutput = String(args.get('--output-dir') || '').trim();
const envOutput = process.env.UL_LAUNCH_EVIDENCE_DIR
  ? resolve(repoRoot, process.env.UL_LAUNCH_EVIDENCE_DIR, 'rollback-rehearsal')
  : '';
const outputDir = configuredOutput
  ? resolve(repoRoot, configuredOutput)
  : envOutput;

if (!outputDir) {
  printHelp();
  console.error('An output directory is required. Pass --output-dir or set UL_LAUNCH_EVIDENCE_DIR.');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const inferredCandidateId = basename(outputDir) === 'rollback-rehearsal'
  ? basename(dirname(outputDir))
  : basename(outputDir);
const candidateId = String(args.get('--candidate-id') || inferredCandidateId).trim();

const metadataPath = resolve(outputDir, 'metadata.json');
const notesPath = resolve(outputDir, 'notes.md');

function writeIfAllowed(path, content) {
  if (existsSync(path) && !force) {
    console.log(`Skipped existing file: ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  console.log(`Wrote ${path}`);
}

const metadata = {
  generated_at: new Date().toISOString(),
  rehearsal_type: 'rollback_rehearsal',
  status: 'prepared',
  target,
  candidate_id: candidateId,
  operator,
  scenarios: [
    'bad_staging_deploy',
    'bad_production_api_deploy',
    'bad_production_db_migration',
    'bad_launch_pages_deploy',
  ],
  artifact_paths: {
    notes: 'notes.md',
  },
};

const notes = `# Rollback Rehearsal Notes

- generated_at: ${metadata.generated_at}
- candidate_id: ${candidateId}
- target: ${target}
- operator: ${operator}

## Preconditions

- [ ] release topology reviewed
- [ ] release runbook reviewed
- [ ] backup / restore drill reviewed for DB recovery path
- [ ] current staging and production gate workflow names confirmed

## Scenario 1: Bad Staging Deploy

- trigger we are simulating:
- first safe action:
- who communicates / where:
- preferred recovery path:
- do-not-do warnings:
- time to identify correct playbook:
- issues found:

## Scenario 2: Bad Production API Deploy

- trigger we are simulating:
- first safe action:
- who communicates / where:
- preferred recovery path:
- do-not-do warnings:
- time to identify correct playbook:
- issues found:

## Scenario 3: Bad Production DB Migration

- trigger we are simulating:
- first safe action:
- who communicates / where:
- preferred recovery path:
- when backup / restore drill evidence is consulted:
- do-not-do warnings:
- time to identify correct playbook:
- issues found:

## Scenario 4: Bad Launch Pages Deploy

- trigger we are simulating:
- first safe action:
- who communicates / where:
- preferred recovery path:
- how the last known-good Pages deployment is identified:
- do-not-do warnings:
- time to identify correct playbook:
- issues found:

Desktop release/updater: not applicable to the persistent-Agent launch.

## Cross-Cutting Gaps

- missing workflow links:
- missing permissions:
- unclear runbook wording:
- tooling that would help:

## Final Outcome

- outcome: pass / fail / partial
- release-scorecard impact:
- follow-up owner:
`;

writeIfAllowed(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
writeIfAllowed(notesPath, notes);
