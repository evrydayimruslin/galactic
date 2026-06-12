#!/usr/bin/env node

import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ensureNode20, parseArgs, repoRoot } from '../analysis/_shared.mjs';

ensureNode20();

const args = parseArgs(process.argv.slice(2));

if (args.has('--help')) {
  console.log(`Usage: node scripts/smoke/run-release-smoke.mjs [options]

Options:
  --target <staging|production>   Release target (required)
  --url <url>                     API base URL override
  --supabase-url <url>            Expected Supabase origin for auth smoke
  --fallback-url <url>            Direct Worker fallback URL for API smoke
  --token <token>                 Bearer token for authenticated API smoke
  --model <model>                 Chat model for --exercise-chat
  --output-dir <path>             Evidence output directory (defaults to UL_LAUNCH_EVIDENCE_DIR)
  --allowed-origin <origin>       Allowed CORS origin (default: selected API origin)
  --disallowed-origin <origin>    Disallowed CORS origin (default: https://evil.example)
  --exercise-chat                 Include the real chat send
  --skip-guardrails               Skip launch guardrails
  --skip-auth                     Skip auth redirect smoke
  --skip-api                      Skip API smoke
  --skip-cors                     Skip CORS probes
  --help                          Show this help
`);
  process.exit(0);
}

const target = String(args.get('--target') || '').trim().toLowerCase();
if (!['staging', 'production'].includes(target)) {
  console.error('run-release-smoke requires --target staging or --target production.');
  process.exit(1);
}

const defaultApiBase =
  target === 'production'
    ? 'https://ultralight-api.rgn4jz429m.workers.dev'
    : 'https://ultralight-api-staging.rgn4jz429m.workers.dev';
// Both workers share the prod Supabase project for launch (the dedicated
// staging Supabase project is paused/unused — see wrangler.toml).
const defaultSupabaseUrl = 'https://uavjzycsltdnwblwutmb.supabase.co';

const apiBase = String(args.get('--url') || process.env.ULTRALIGHT_API_URL || defaultApiBase);
const supabaseUrl = String(args.get('--supabase-url') || process.env.ULTRALIGHT_SUPABASE_URL || defaultSupabaseUrl);
const fallbackUrl = String(args.get('--fallback-url') || process.env.ULTRALIGHT_FALLBACK_URL || '').trim();
const token = String(args.get('--token') || process.env.ULTRALIGHT_TOKEN || '').trim();
const chatModel = String(
  args.get('--model') || process.env.ULTRALIGHT_CHAT_MODEL || 'ultralight/deepseek-v4-flash',
);
const allowedOrigin = String(args.get('--allowed-origin') || apiBase).trim();
const disallowedOrigin = String(args.get('--disallowed-origin') || 'https://evil.example').trim();
const outputDir = String(args.get('--output-dir') || process.env.UL_LAUNCH_EVIDENCE_DIR || '').trim();
const exerciseChat = Boolean(args.has('--exercise-chat'));
const skipGuardrails = Boolean(args.has('--skip-guardrails'));
const skipAuth = Boolean(args.has('--skip-auth'));
const skipApi = Boolean(args.has('--skip-api'));
const skipCors = Boolean(args.has('--skip-cors'));

if (!outputDir) {
  console.error('run-release-smoke requires --output-dir or UL_LAUNCH_EVIDENCE_DIR.');
  process.exit(1);
}

if (!skipAuth && !supabaseUrl) {
  console.error('run-release-smoke requires --supabase-url (or ULTRALIGHT_SUPABASE_URL) unless --skip-auth is used.');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const smokeDir = resolve(outputDir, 'smoke');
mkdirSync(smokeDir, { recursive: true });

const summaryJsonPath = join(smokeDir, 'summary.json');
const summaryMdPath = join(smokeDir, 'summary.md');
const metadataPath = resolve(outputDir, 'metadata.json');
const workflowRunsPath = resolve(outputDir, 'workflow-runs.md');

function nowIso() {
  return new Date().toISOString();
}

function redactCommand(parts) {
  return parts.map((part) => {
    if (part === token && token) return '[REDACTED_TOKEN]';
    return part;
  });
}

async function runCommand({
  name,
  command,
  args: commandArgs,
  logPath,
  env = process.env,
}) {
  mkdirSync(dirname(logPath), { recursive: true });

  return new Promise((resolvePromise) => {
    const startedAt = nowIso();
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      appendFileSync(logPath, text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      appendFileSync(logPath, text);
    });

    child.on('error', (error) => {
      appendFileSync(logPath, `\n[wrapper-error] ${String(error)}\n`);
      resolvePromise({
        name,
        status: 'failed',
        started_at: startedAt,
        finished_at: nowIso(),
        exit_code: null,
        command: redactCommand([command, ...commandArgs]),
        log_path: logPath,
        stdout,
        stderr: `${stderr}\n${String(error)}`.trim(),
      });
    });

    child.on('close', (code) => {
      resolvePromise({
        name,
        status: code === 0 ? 'passed' : 'failed',
        started_at: startedAt,
        finished_at: nowIso(),
        exit_code: code,
        command: redactCommand([command, ...commandArgs]),
        log_path: logPath,
        stdout,
        stderr,
      });
    });
  });
}

async function runCurlProbe({
  name,
  url,
  origin,
  headersPath,
  bodyPath,
  expectedAllowed,
}) {
  const result = await runCommand({
    name,
    command: 'curl',
    args: [
      '-sS',
      '-D',
      headersPath,
      '-o',
      bodyPath,
      '-X',
      'OPTIONS',
      url,
      '-H',
      `Origin: ${origin}`,
      '-H',
      'Access-Control-Request-Method: POST',
    ],
    logPath: `${headersPath}.log`,
  });

  let accessControlAllowOrigin = '';
  let statusCode = '';

  if (existsSync(headersPath)) {
    const rawHeaders = readFileSync(headersPath, 'utf8');
    const lines = rawHeaders.split(/\r?\n/);
    const statusLine = lines.find((line) => line.startsWith('HTTP/'));
    if (statusLine) {
      statusCode = statusLine.split(' ')[1] || '';
    }
    const acaoLine = lines.find((line) => /^access-control-allow-origin:/i.test(line));
    if (acaoLine) {
      accessControlAllowOrigin = acaoLine.split(':').slice(1).join(':').trim();
    }
  }

  const probePassed = expectedAllowed
    ? result.status === 'passed' && accessControlAllowOrigin === origin
    : result.status === 'passed' && accessControlAllowOrigin !== origin;

  return {
    ...result,
    status: probePassed ? 'passed' : 'failed',
    curl_probe: {
      origin,
      url,
      expected: expectedAllowed ? 'allow' : 'block',
      http_status: statusCode || null,
      access_control_allow_origin: accessControlAllowOrigin || null,
      headers_path: headersPath,
      body_path: bodyPath,
    },
  };
}

async function getGitValue(argsList, fallback = null) {
  const result = await runCommand({
    name: `git ${argsList.join(' ')}`,
    command: 'git',
    args: argsList,
    logPath: join(smokeDir, `git-${argsList.join('-').replaceAll('/', '-')}.log`),
  });

  if (result.status !== 'passed') {
    return fallback;
  }

  return result.stdout.trim() || fallback;
}

async function ensureMetadata() {
  if (existsSync(metadataPath)) {
    return;
  }

  const commitSha = await getGitValue(['rev-parse', '--short', 'HEAD'], null);
  const gitRef = await getGitValue(['rev-parse', '--abbrev-ref', 'HEAD'], null);
  const candidateId = basename(resolve(outputDir));
  const metadata = {
    generated_at: nowIso(),
    target,
    candidate_id: candidateId,
    git_ref: gitRef,
    commit_sha: commitSha,
    version_tag: gitRef?.startsWith('v') ? gitRef : null,
    operator: process.env.USER || 'unknown',
  };

  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

function ensureWorkflowRunsStub() {
  if (existsSync(workflowRunsPath)) {
    return;
  }

  const initial = `# Workflow Runs\n\n- target: ${target}\n- candidate: ${basename(resolve(outputDir))}\n- add staging or production workflow links here\n`;
  writeFileSync(workflowRunsPath, initial, 'utf8');
}

function summarizeMarkdown(results) {
  const lines = [
    '# Release Smoke Summary',
    '',
    `- target: ${target}`,
    `- api: ${apiBase}`,
    `- output_dir: ${outputDir}`,
    `- generated_at: ${nowIso()}`,
    '',
    '| Step | Status | Artifact | Notes |',
    '| --- | --- | --- | --- |',
  ];

  for (const result of results) {
    const notes = [];
    if (result.skip_reason) notes.push(result.skip_reason);
    if (result.curl_probe) {
      notes.push(
        `${result.curl_probe.expected} ${result.curl_probe.origin}; ACAO=${result.curl_probe.access_control_allow_origin || '<missing>'}; status=${result.curl_probe.http_status || '<unknown>'}`,
      );
    }
    const artifactPath = result.log_path ? toMarkdownArtifactPath(result.log_path) : null;
    lines.push(
      `| ${result.name} | ${result.status} | ${artifactPath ? `[\`${artifactPath}\`](${artifactPath})` : '-'} | ${notes.join('; ') || '-'} |`,
    );
  }

  lines.push(
    '',
    'Manual desktop smoke remains separate. Record those results in `manual/desktop-smoke-notes.md` under the same evidence directory.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

function toMarkdownArtifactPath(path) {
  const resolved = resolve(path);
  const relativePath = relative(repoRoot, resolved).replaceAll('\\', '/');
  return relativePath.startsWith('..') ? resolved : relativePath;
}

function skippedResult(name, reason) {
  return {
    name,
    status: 'skipped',
    started_at: nowIso(),
    finished_at: nowIso(),
    exit_code: null,
    command: [],
    log_path: null,
    skip_reason: reason,
  };
}

await ensureMetadata();
ensureWorkflowRunsStub();

const results = [];

if (skipGuardrails) {
  results.push(skippedResult('launch-guardrails', 'skipped by flag'));
} else {
  results.push(await runCommand({
    name: 'launch-guardrails',
    command: 'node',
    args: ['scripts/checks/run-guardrail-checks.mjs'],
    logPath: join(smokeDir, 'guardrails.txt'),
  }));
}

if (skipAuth) {
  results.push(skippedResult('auth-redirect-smoke', 'skipped by flag'));
} else {
  results.push(await runCommand({
    name: 'auth-redirect-smoke',
    command: 'bash',
    args: [
      'scripts/smoke/auth-redirect-smoke.sh',
      '--url',
      apiBase,
      '--supabase-url',
      supabaseUrl,
    ],
    logPath: join(smokeDir, 'auth-redirect.log'),
  }));
}

if (skipApi) {
  results.push(skippedResult('api-smoke', 'skipped by flag'));
} else {
  const smokeArgs = ['scripts/smoke-test.sh', '--url', apiBase, '--model', chatModel];
  if (fallbackUrl) {
    smokeArgs.push('--fallback-url', fallbackUrl);
  }
  if (token) {
    smokeArgs.push('--token', token);
  }
  if (exerciseChat) {
    smokeArgs.push('--exercise-chat');
  }
  results.push(await runCommand({
    name: 'api-smoke',
    command: 'bash',
    args: smokeArgs,
    logPath: join(smokeDir, 'api-smoke.log'),
  }));
}

if (skipCors) {
  results.push(skippedResult('cors-allowed', 'skipped by flag'));
  results.push(skippedResult('cors-blocked', 'skipped by flag'));
} else {
  const corsUrl = `${apiBase}/http/test/ping`;
  results.push(await runCurlProbe({
    name: 'cors-allowed',
    url: corsUrl,
    origin: allowedOrigin,
    headersPath: join(smokeDir, 'cors-allowed.headers.txt'),
    bodyPath: join(smokeDir, 'cors-allowed.body.txt'),
    expectedAllowed: true,
  }));
  results.push(await runCurlProbe({
    name: 'cors-blocked',
    url: corsUrl,
    origin: disallowedOrigin,
    headersPath: join(smokeDir, 'cors-blocked.headers.txt'),
    bodyPath: join(smokeDir, 'cors-blocked.body.txt'),
    expectedAllowed: false,
  }));
}

const summary = {
  generated_at: nowIso(),
  target,
  api_base: apiBase,
  evidence_dir: outputDir,
  smoke_dir: smokeDir,
  results,
  counts: {
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
  },
};

writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
writeFileSync(summaryMdPath, summarizeMarkdown(results), 'utf8');

console.log(`Release smoke summary written to ${summaryJsonPath}`);
console.log(`Release smoke markdown written to ${summaryMdPath}`);
console.log(`Passed: ${summary.counts.passed}`);
console.log(`Failed: ${summary.counts.failed}`);
console.log(`Skipped: ${summary.counts.skipped}`);

if (summary.counts.failed > 0) {
  process.exit(1);
}
