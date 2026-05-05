#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensureNode20, parseArgs } from '../analysis/_shared.mjs';

ensureNode20();

const args = parseArgs(process.argv.slice(2));

if (args.has('--help')) {
  console.log(`Usage: node scripts/smoke/chat-capture-smoke.mjs [options]

Checks that the chat capture schema is present and, optionally, exercises one
real /chat/orchestrate request and verifies captured rows in Supabase.

Options:
  --target <staging|production>    Target defaults for API/Supabase URLs (default: staging)
  --url <url>                      API base URL override
  --supabase-url <url>             Supabase project URL override
  --service-role-key <key>          Supabase service role key override
  --token <token>                  Bearer token for /chat/orchestrate
  --model <model>                  Light-routed model for the smoke prompt
  --conversation-id <id>           Validate an existing or deterministic conversation ID
  --exercise-orchestrate           Send one real orchestration request
  --allow-missing-artifacts        Do not fail if project/upload artifacts are absent
  --poll-attempts <n>              Capture polling attempts (default: 15)
  --poll-ms <n>                    Delay between polling attempts (default: 2000)
  --timeout-ms <n>                 API request timeout (default: 120000)
  --write-json <path>              Write machine-readable summary
  --help                           Show this help

Environment:
  ULTRALIGHT_API_URL
  ULTRALIGHT_TOKEN
  ULTRALIGHT_CHAT_MODEL
  ULTRALIGHT_SUPABASE_URL or SUPABASE_URL
  ULTRALIGHT_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY
`);
  process.exit(0);
}

const target = String(args.get('--target') || 'staging').trim().toLowerCase();
if (!['staging', 'production'].includes(target)) {
  console.error('--target must be staging or production.');
  process.exit(1);
}

const defaultApiBase = target === 'production'
  ? 'https://ultralight-api.rgn4jz429m.workers.dev'
  : 'https://ultralight-api-staging.rgn4jz429m.workers.dev';
const defaultSupabaseUrl = target === 'production'
  ? 'https://uavjzycsltdnwblwutmb.supabase.co'
  : 'https://vonlzcnwxbwaxlbngjre.supabase.co';

const apiBase = trimTrailingSlash(
  String(args.get('--url') || process.env.ULTRALIGHT_API_URL || defaultApiBase),
);
const supabaseUrl = trimTrailingSlash(
  String(
    args.get('--supabase-url') ||
      process.env.ULTRALIGHT_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      defaultSupabaseUrl,
  ),
);
const serviceRoleKey = String(
  args.get('--service-role-key') ||
    process.env.ULTRALIGHT_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '',
).trim();
const token = String(args.get('--token') || process.env.ULTRALIGHT_TOKEN || '').trim();
const model = String(
  args.get('--model') ||
    process.env.ULTRALIGHT_CHAT_MODEL ||
    'google/gemini-3.1-flash-lite-preview:nitro',
).trim();
const exerciseOrchestrate = Boolean(args.has('--exercise-orchestrate'));
const requireArtifacts = !args.has('--allow-missing-artifacts');
const conversationId = String(
  args.get('--conversation-id') || `capture-smoke-${Date.now()}-${randomUUID()}`,
);
const userMessageId = `capture-smoke-user-${randomUUID()}`;
const assistantMessageId = `capture-smoke-assistant-${randomUUID()}`;
const pollAttempts = positiveInt(args.get('--poll-attempts'), 15);
const pollMs = positiveInt(args.get('--poll-ms'), 2000);
const timeoutMs = positiveInt(args.get('--timeout-ms'), 120000);
const writeJsonPath = args.get('--write-json')
  ? resolve(String(args.get('--write-json')))
  : null;

if (!serviceRoleKey) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY or ULTRALIGHT_SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

if (exerciseOrchestrate && !token) {
  console.error('--exercise-orchestrate requires ULTRALIGHT_TOKEN or --token.');
  process.exit(1);
}

const checks = [];

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function record(name, status, details = {}) {
  checks.push({ name, status, ...details });
  const marker = status === 'passed' ? 'PASS' : status === 'skipped' ? 'SKIP' : 'FAIL';
  const suffix = details.message ? ` - ${details.message}` : '';
  console.log(`[${marker}] ${name}${suffix}`);
}

function supabaseHeaders(extra = {}) {
  return {
    'apikey': serviceRoleKey,
    'Authorization': `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}

async function supabaseGet(path, params = {}) {
  const url = new URL(`${supabaseUrl}/rest/v1/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: supabaseHeaders({ 'Prefer': 'count=exact' }),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    json,
    count: parseContentRangeCount(response.headers.get('content-range')),
  };
}

function parseContentRangeCount(value) {
  if (!value) return null;
  const match = value.match(/\/(\d+|\*)$/);
  if (!match || match[1] === '*') return null;
  return Number.parseInt(match[1], 10);
}

async function checkTable(table, select) {
  const result = await supabaseGet(table, { select, limit: '1' });
  if (result.ok) {
    record(`schema:${table}`, 'passed', { status_code: result.status });
    return true;
  }
  record(`schema:${table}`, 'failed', {
    status_code: result.status,
    message: result.text.slice(0, 300),
  });
  return false;
}

async function countRows(table, filters) {
  const params = { select: '*', limit: '1' };
  for (const [key, value] of Object.entries(filters)) {
    params[key] = `eq.${value}`;
  }
  const result = await supabaseGet(table, params);
  if (!result.ok) {
    throw new Error(`${table} query failed: ${result.status} ${result.text}`);
  }
  return result.count ?? (Array.isArray(result.json) ? result.json.length : 0);
}

function smokeProjectContext() {
  return [
    'Capture smoke project context.',
    `conversation_id=${conversationId}`,
    'This validates that project context is stored as a linked artifact.',
  ].join('\n');
}

function smokeFile() {
  const text = [
    'Capture smoke uploaded file.',
    `conversation_id=${conversationId}`,
    `created_at=${nowIso()}`,
  ].join('\n');
  return {
    name: 'capture-smoke.txt',
    size: Buffer.byteLength(text, 'utf8'),
    mimeType: 'text/plain',
    content: `data:text/plain;base64,${Buffer.from(text, 'utf8').toString('base64')}`,
  };
}

async function exerciseCapture() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}/chat/orchestrate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: [
          `Capture smoke test ${conversationId}.`,
          'Reply with one short sentence and do not call tools.',
        ].join(' '),
        conversationHistory: [
          { role: 'user', content: 'Earlier capture smoke context.' },
        ],
        inference: {
          billingMode: 'light',
          provider: 'openrouter',
          model,
        },
        conversationId,
        userMessageId,
        assistantMessageId,
        projectContext: smokeProjectContext(),
        files: [smokeFile()],
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    const events = parseSseEvents(text);
    const errorEvent = events.find((event) => event?.type === 'error');

    if (!response.ok || errorEvent) {
      record('api:orchestrate', 'failed', {
        status_code: response.status,
        event_count: events.length,
        message: errorEvent?.message || text.slice(0, 300),
      });
      return false;
    }

    record('api:orchestrate', 'passed', {
      status_code: response.status,
      event_count: events.length,
      conversation_id: conversationId,
    });
    return true;
  } catch (error) {
    record('api:orchestrate', 'failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseEvents(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      events.push({ type: 'parse_error', raw: data.slice(0, 200) });
    }
  }
  return events;
}

async function pollCaptureRows() {
  let latest = null;
  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    latest = {
      chat_threads: await countRows('chat_threads', { conversation_id: conversationId }),
      chat_messages: await countRows('chat_messages', { conversation_id: conversationId }),
      chat_events: await countRows('chat_events', { conversation_id: conversationId }),
      capture_artifacts: await countRows('capture_artifacts', { conversation_id: conversationId }),
      capture_artifact_links: await countRows('capture_artifact_links', { conversation_id: conversationId }),
    };

    const coreReady = latest.chat_threads >= 1 &&
      latest.chat_messages >= 2 &&
      latest.chat_events >= 1;
    const artifactsReady = !requireArtifacts ||
      (latest.capture_artifacts >= 1 && latest.capture_artifact_links >= 1);

    if (coreReady && artifactsReady) {
      record('capture:rows', 'passed', {
        conversation_id: conversationId,
        counts: latest,
      });
      return true;
    }

    if (attempt < pollAttempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  }

  record('capture:rows', 'failed', {
    conversation_id: conversationId,
    counts: latest,
    message: requireArtifacts
      ? 'Expected thread, messages, events, artifacts, and artifact links.'
      : 'Expected thread, messages, and events.',
  });
  return false;
}

const startedAt = nowIso();

console.log('Chat Capture Smoke');
console.log(`target=${target}`);
console.log(`api=${apiBase}`);
console.log(`supabase=${supabaseUrl}`);
console.log(`conversation_id=${conversationId}`);

const schemaOk = await Promise.all([
  checkTable('capture_subjects', 'anon_user_id'),
  checkTable('chat_threads', 'conversation_id'),
  checkTable('chat_messages', 'message_id'),
  checkTable('chat_events', 'id'),
  checkTable('capture_artifacts', 'id'),
  checkTable('capture_artifact_links', 'id'),
  checkTable('capture_access_audit', 'id'),
  checkTable('derived_signals', 'id'),
]).then((results) => results.every(Boolean));

let exerciseOk = true;
let rowsOk = true;
if (exerciseOrchestrate && schemaOk) {
  exerciseOk = await exerciseCapture();
  rowsOk = exerciseOk ? await pollCaptureRows() : false;
} else if (args.has('--conversation-id') && schemaOk) {
  rowsOk = await pollCaptureRows();
} else {
  record('api:orchestrate', 'skipped', {
    message: 'Pass --exercise-orchestrate or --conversation-id to validate writes.',
  });
}

const summary = {
  generated_at: nowIso(),
  started_at: startedAt,
  target,
  api_base: apiBase,
  supabase_url: supabaseUrl,
  conversation_id: conversationId,
  exercise_orchestrate: exerciseOrchestrate,
  require_artifacts: requireArtifacts,
  checks,
  counts: {
    passed: checks.filter((item) => item.status === 'passed').length,
    failed: checks.filter((item) => item.status === 'failed').length,
    skipped: checks.filter((item) => item.status === 'skipped').length,
  },
};

if (writeJsonPath) {
  mkdirSync(dirname(writeJsonPath), { recursive: true });
  writeFileSync(writeJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`summary_json=${writeJsonPath}`);
}

if (!schemaOk || !exerciseOk || !rowsOk || summary.counts.failed > 0) {
  process.exit(1);
}
