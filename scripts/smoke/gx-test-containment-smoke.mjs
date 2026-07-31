#!/usr/bin/env node
// Deployed gx.test containment certification.
//
// This exercises the deployed Dynamic Worker / ctx.exports RPC graph, not the
// local mocks. It intentionally does not upload an Agent and never serializes a
// returned test attestation. The connected-builder token is accepted only via
// ULTRALIGHT_TOKEN so it cannot leak through the process list.
//
// Usage:
//   ULTRALIGHT_TOKEN=ul_... \
//     node scripts/smoke/gx-test-containment-smoke.mjs \
//       [--target staging|production] \
//       [--url https://ultralight-api-staging.rgn4jz429m.workers.dev] \
//       [--output /path/to/gx-test-containment.json]

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../analysis/_shared.mjs';

export const STAGING_API_BASE = 'https://ultralight-api-staging.rgn4jz429m.workers.dev';
export const PRODUCTION_API_BASE = 'https://api.connectgalactic.com';
const REQUEST_TIMEOUT_MS = 90_000;
const REQUIRED_BLOCKED_EFFECTS = Object.freeze([
  'agent_call',
  'credentialed_http',
  'event_publish',
  'imap',
  'outbound_http',
  'smtp',
]);

function manifest() {
  return {
    name: 'gx.test containment probe',
    version: '1.0.0',
    description: 'Ephemeral deployed probe for the gx.test containment boundary.',
    type: 'mcp',
    entry: { functions: 'index.js' },
    flight_recorder: true,
    permissions: [
      'storage:read',
      'storage:write',
      'memory:read',
      'memory:write',
      'ai:call',
      'ai:embed',
      'notify:owner',
      'net:fetch',
      'net:connect',
      'app:call',
      'compute:exec',
    ],
    compute: {
      profile: 'developer-v1',
      tools: ['shell'],
      secrets: [],
    },
    network: {
      allowed_destinations: ['gx-test-probe.invalid'],
    },
    functions: {
      state_and_stub_probe: {
        description: 'Checks invocation-local state and deterministic host-only stubs.',
        uses_compute: true,
        parameters: {
          marker: {
            type: 'string',
            description: 'Unique public smoke marker.',
            required: true,
          },
        },
        returns: { type: 'object', description: 'Containment probe result.' },
      },
      caught_effects_probe: {
        description: 'Attempts and catches every externally-effectful Galactic surface.',
        parameters: {
          marker: {
            type: 'string',
            description: 'Unique public smoke marker.',
            required: true,
          },
        },
        returns: { type: 'object', description: 'Unreachable success result.' },
      },
      detached_effect_probe: {
        description: 'Starts an unawaited outbound request to test evidence drain ordering.',
        parameters: {},
        returns: { type: 'object', description: 'Unreachable success result.' },
      },
      cache_capability_probe: {
        description: 'Checks whether the ambient Cache API can escape gx.test isolation.',
        parameters: {
          marker: {
            type: 'string',
            description: 'Unique cache key marker.',
            required: true,
          },
        },
        returns: { type: 'object', description: 'Cache capability result.' },
      },
    },
  };
}

const PROBE_SOURCE = `
export async function state_and_stub_probe(input = {}) {
  const marker = String(input.marker || "");
  const before = {
    data: await galactic.load("containment/state"),
    agent_memory: await galactic.recall("containment-memory"),
    user_memory: await galactic.recall("containment-memory", { scope: "user" }),
  };

  await galactic.store("containment/state", { marker });
  await galactic.remember("containment-memory", { marker, scope: "agent" });
  await galactic.remember(
    "containment-memory",
    { marker, scope: "user" },
    { scope: "user" },
  );

  const ai = await galactic.ai({
    messages: [{ role: "user", content: "containment probe" }],
  });
  const embedding = await galactic.embed({ input: "containment probe" });
  const notification = await galactic.notify({
    kind: "report",
    title: "gx.test containment probe",
    body: "must never be delivered",
  });
  const runs = await galactic.runs.recent({ limit: 1 });
  const compute = await galactic.compute({
    argv: ["cat"],
    tools: ["shell"],
    profile: "developer-v1",
    mode: "sync",
    stdin: "gx.test containment probe",
    timeout_ms: 1_000,
  });

  return {
    before: before,
    after: {
      data: await galactic.load("containment/state"),
      agent_memory: await galactic.recall("containment-memory"),
      user_memory: await galactic.recall("containment-memory", { scope: "user" }),
    },
    stubs: {
      ai_content: ai && ai.content,
      ai_cost_light: ai && ai.usage && ai.usage.cost_light,
      embedding: embedding && embedding.embedding,
      notification: notification,
      runs: runs,
      compute: {
        run_id: compute && compute.run_id,
        status: compute && compute.status,
        async: compute && compute.async,
      },
    },
  };
}

async function caught(task) {
  try {
    await task();
  } catch {
    return true;
  }
  return false;
}

export async function caught_effects_probe(input = {}) {
  const marker = String(input.marker || "");
  const caughtEffects = {
    outbound_http: await caught(() =>
      fetch("https://gx-test-probe.invalid/http", {
        method: "POST",
        body: "must never leave gx.test",
      })
    ),
    credentialed_http: await caught(() =>
      galactic.fetch(
        "SMOKE_CREDENTIAL",
        "https://gx-test-probe.invalid/credential",
        { method: "POST", body: "must never leave gx.test" },
      )
    ),
    imap: await caught(() =>
      galactic.net.imapFetchUnseen(
        "IMAP_HOST",
        993,
        "IMAP_USER",
        "IMAP_PASSWORD",
        0,
        "",
        "$GXTest",
        1,
      )
    ),
    smtp: await caught(() =>
      galactic.net.smtpSend(
        "SMTP_HOST",
        465,
        "SMTP_USER",
        "SMTP_PASSWORD",
        "owner@example.invalid",
        "gx.test",
        "recipient@example.invalid",
        "must not send",
        "must never leave gx.test",
      )
    ),
    event_publish: await caught(() =>
      galactic.emit("gx.test.containment." + marker, { blocked: true })
    ),
    agent_call: await caught(() =>
      galactic.call(
        "00000000-0000-4000-8000-000000000000",
        "must_not_run",
        {},
      )
    ),
  };
  return { caughtEffects: caughtEffects };
}

export async function detached_effect_probe() {
  void fetch("https://gx-test-probe.invalid/detached", {
    method: "POST",
    body: "must never leave gx.test",
  }).catch(() => {});
  await Promise.resolve();
  return { returned: true };
}

export async function cache_capability_probe(input = {}) {
  if (typeof caches === "undefined") {
    return { defined: false, usable: false };
  }
  const marker = encodeURIComponent(String(input.marker || ""));
  const key = new Request(
    "https://gx-test-probe.invalid/cache/" + marker,
    { method: "GET" },
  );
  try {
    await caches.default.match(key);
    // Delete only a cryptographically unique, never-written key. A successful
    // call still proves the tenant received an ambient stateful capability.
    const deleted = await caches.default.delete(key);
    return { defined: true, usable: true, deleted: deleted };
  } catch (error) {
    return {
      defined: true,
      usable: false,
      error_name: error && error.name ? String(error.name) : "Error",
    };
  }
}

// Strict gx.test lint requires an Agent UI surface even though this deployment
// probe never invokes it. Keep the probe deployable without adding any new
// capability or state to the containment exercise.
export async function ui() {
  return http.html("<!doctype html><title>gx.test containment probe</title>");
}
`;

export function containmentProbeFiles() {
  return [
    { path: 'index.js', content: PROBE_SOURCE },
    { path: 'manifest.json', content: JSON.stringify(manifest(), null, 2) },
  ];
}

function requiredString(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function containmentTarget(value) {
  const target = String(value || 'staging').trim().toLowerCase();
  if (target !== 'staging' && target !== 'production') {
    throw new Error('gx.test containment target must be staging or production.');
  }
  return target;
}

export function containmentApiBase(value, target = 'staging') {
  const resolvedTarget = containmentTarget(target);
  const defaultBase = resolvedTarget === 'production'
    ? PRODUCTION_API_BASE
    : STAGING_API_BASE;
  const label = resolvedTarget === 'production'
    ? 'Production API URL'
    : 'Staging API URL';
  const normalized = requiredString(value || defaultBase, label)
    .replace(/\/+$/u, '');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    parsed.pathname !== '/'
  ) {
    throw new Error(`${label} must be a bare HTTPS origin.`);
  }
  if (
    resolvedTarget === 'production' &&
    normalized !== PRODUCTION_API_BASE
  ) {
    throw new Error(
      `Production gx.test containment may target only ${PRODUCTION_API_BASE}.`,
    );
  }
  if (resolvedTarget === 'staging' && normalized === PRODUCTION_API_BASE) {
    throw new Error(
      'Production gx.test containment requires --target production.',
    );
  }
  return normalized;
}

export function stagingApiBase(value) {
  return containmentApiBase(value, 'staging');
}

export function safeDiagnostic(value, secrets = []) {
  let text = value instanceof Error ? value.message : String(value || '');
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, '[REDACTED]');
  }
  text = text
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:ul|gx)_[A-Za-z0-9._~-]{12,}\b/gu, '[REDACTED_TOKEN]')
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      '[REDACTED_JWT]',
    )
    .replace(
      /\b(api[_-]?key|authorization|password|secret|token)\s*[:=]\s*["']?[^\s,"';}]+/giu,
      '$1=[REDACTED]',
    );
  return text.slice(0, 500);
}

function safeCallLabel(value, secrets = []) {
  const redacted = safeDiagnostic(value, secrets)
    .replace(/[^A-Za-z0-9_.:[\]-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 80);
  return redacted || 'unknown';
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/**
 * Extract only a bounded JSON-RPC diagnostic. Never serialize the response
 * body: auth gateways and intermediaries can put credentials in arbitrary
 * fields that are not safe CI output.
 */
export function formatGxTestHttpFailure({
  functionName,
  status,
  body,
  secrets = [],
}) {
  const label = safeCallLabel(functionName, secrets);
  const error = record(record(body)?.error);
  const data = record(error?.data);
  const parts = [
    `gx.test[${label}] returned HTTP ${Number.isInteger(status) ? status : 'unknown'}`,
  ];
  if (typeof error?.code === 'number' && Number.isFinite(error.code)) {
    parts.push(`jsonrpc_code=${error.code}`);
  }
  if (typeof data?.type === 'string' && data.type.trim()) {
    parts.push(`type=${safeCallLabel(data.type, secrets)}`);
  }
  if (typeof error?.message === 'string' && error.message.trim()) {
    parts.push(`message=${safeDiagnostic(error.message, secrets).slice(0, 240)}`);
  }
  return `${parts.join('; ')}.`;
}

function decodeToolResult(responseBody, secrets = []) {
  if (responseBody?.error) {
    throw new Error(
      `MCP error: ${safeDiagnostic(
        responseBody.error.message || 'unknown',
        secrets,
      )}`,
    );
  }
  const result = responseBody?.result;
  if (!result) throw new Error('MCP response did not include a result.');
  if (result.isError) {
    throw new Error(
      safeDiagnostic(result.content?.[0]?.text || 'gx.test failed', secrets),
    );
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find?.((item) => item?.type === 'text')?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export async function callGxTest({
  apiBase,
  token,
  functionName,
  testArgs,
  fetchImpl = fetch,
}) {
  let response;
  try {
    response = await fetchImpl(`${apiBase}/mcp/platform`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: {
          name: 'gx.test',
          arguments: {
            files: containmentProbeFiles(),
            function_name: functionName,
            strict: true,
            ...(testArgs ? { test_args: testArgs } : {}),
          },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const label = safeCallLabel(functionName, [token]);
    throw new Error(
      `gx.test[${label}] request failed: ${safeDiagnostic(error, [token])}`,
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    const label = safeCallLabel(functionName, [token]);
    throw new Error(
      `gx.test[${label}] returned non-JSON (HTTP ${response.status}).`,
    );
  }
  if (!response.ok) {
    throw new Error(formatGxTestHttpFailure({
      functionName,
      status: response.status,
      body,
      secrets: [token],
    }));
  }
  return decodeToolResult(body, [token]);
}

function hasAttestation(result) {
  return typeof result?.test_attestation === 'string' &&
    result.test_attestation.length > 0;
}

function nullState(value) {
  return value?.data === null &&
    value?.agent_memory === null &&
    value?.user_memory === null;
}

function expectedAfter(value, marker) {
  return value?.data?.marker === marker &&
    value?.agent_memory?.marker === marker &&
    value?.agent_memory?.scope === 'agent' &&
    value?.user_memory?.marker === marker &&
    value?.user_memory?.scope === 'user';
}

function expectedStubs(value) {
  return value?.ai_content ===
      '{"assessment":"gx.test deterministic AI response","actions":[]}' &&
    value?.ai_cost_light === 0 &&
    Array.isArray(value?.embedding) &&
    value.embedding.length === 4 &&
    value.embedding.every((item) => item === 0) &&
    value?.notification?.created === false &&
    value?.notification?.reason === 'test_mode' &&
    Array.isArray(value?.runs?.runs) &&
    value.runs.runs.length === 0 &&
    value?.compute?.run_id === 'test-compute-run' &&
    value?.compute?.status === 'completed' &&
    value?.compute?.async === false;
}

function check(name, passed, detail) {
  return {
    name,
    status: passed ? 'passed' : 'failed',
    ...(!passed && detail ? { detail } : {}),
  };
}

function resultDiagnostic(value) {
  if (!value || typeof value !== 'object') return 'result=missing';
  const parts = [
    `success=${
      value.success === true
        ? 'true'
        : value.success === false
          ? 'false'
          : 'missing'
    }`,
    `attestation=${hasAttestation(value) ? 'present' : 'absent'}`,
  ];
  if (typeof value.runtime_invoked === 'boolean') {
    parts.push(`runtime_invoked=${value.runtime_invoked}`);
  }
  if (value.lint_passed === false) {
    const lintRules = Array.isArray(value.lint?.issues)
      ? value.lint.issues
          .filter((issue) => issue?.severity === 'error')
          .map((issue) => String(issue?.rule || 'unknown'))
          .slice(0, 10)
      : [];
    parts.push(`strict_lint=${lintRules.join(',') || 'failed'}`);
  }
  if (typeof value.error_code === 'string') {
    parts.push(`error_code=${safeDiagnostic(value.error_code)}`);
  }
  if (typeof value.error_type === 'string') {
    parts.push(`error_type=${safeDiagnostic(value.error_type)}`);
  }
  if (typeof value.error === 'string') {
    parts.push(`error=${safeDiagnostic(value.error)}`);
  }
  return parts.join('; ');
}

function stateDiagnostic(value, marker) {
  return [
    resultDiagnostic(value),
    `before_empty=${nullState(value?.result?.before)}`,
    `after_matches=${expectedAfter(value?.result?.after, marker)}`,
  ].join('; ');
}

export function assessContainmentResults({
  first,
  second,
  effects,
  detached,
  cache,
  firstMarker,
  secondMarker,
}) {
  const effectError = String(effects?.error || '');
  const checks = [
    check(
      'invocation-local DATA and MEMORY round-trip',
      first?.success === true &&
        hasAttestation(first) &&
        nullState(first.result?.before) &&
        expectedAfter(first.result?.after, firstMarker),
      stateDiagnostic(first, firstMarker),
    ),
    check(
      'fresh invocation starts with empty DATA and MEMORY',
      second?.success === true &&
        hasAttestation(second) &&
        nullState(second.result?.before) &&
        expectedAfter(second.result?.after, secondMarker),
      stateDiagnostic(second, secondMarker),
    ),
    check(
      'AI, embeddings, notifications, and run history use test stubs',
      expectedStubs(first?.result?.stubs) &&
        expectedStubs(second?.result?.stubs),
      [
        `first_stubs=${expectedStubs(first?.result?.stubs)}`,
        `second_stubs=${expectedStubs(second?.result?.stubs)}`,
        `first_${resultDiagnostic(first)}`,
        `second_${resultDiagnostic(second)}`,
      ].join('; '),
    ),
    check(
      'caught external effects remain disqualifying',
      effects?.success === false &&
        !hasAttestation(effects) &&
        REQUIRED_BLOCKED_EFFECTS.every((effect) => effectError.includes(effect)),
      [
        `missing_effects=${
          REQUIRED_BLOCKED_EFFECTS
            .filter((effect) => !effectError.includes(effect))
            .join(',') || 'none'
        }`,
        resultDiagnostic(effects),
      ].join('; '),
    ),
    check(
      'detached outbound effects remain disqualifying',
      detached?.success === false &&
        !hasAttestation(detached) &&
        String(detached?.error || '').includes('outbound_http'),
      resultDiagnostic(detached),
    ),
    check(
      'ambient Cache API is unavailable',
      cache?.success === true &&
        hasAttestation(cache) &&
        cache?.result?.usable === false,
      [
        resultDiagnostic(cache),
        `cache_defined=${cache?.result?.defined === true}`,
        `cache_usable=${cache?.result?.usable === true}`,
      ].join('; '),
    ),
  ];
  return {
    passed: checks.every((item) => item.status === 'passed'),
    checks,
  };
}

export async function runContainmentSmoke({
  apiBase,
  target = 'staging',
  token,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  const resolvedTarget = containmentTarget(target);
  const resolvedApiBase = containmentApiBase(apiBase, resolvedTarget);
  const resolvedToken = requiredString(token, 'ULTRALIGHT_TOKEN');
  const nonce = randomUUID();
  const firstMarker = `${nonce}-first`;
  const secondMarker = `${nonce}-second`;

  const call = (functionName, testArgs) =>
    callGxTest({
      apiBase: resolvedApiBase,
      token: resolvedToken,
      functionName,
      testArgs,
      fetchImpl,
    });

  // Keep these sequential. Beyond making evidence easier to diagnose, the
  // second state call is specifically proving a previous session was closed.
  const first = await call('state_and_stub_probe', { marker: firstMarker });
  const second = await call('state_and_stub_probe', { marker: secondMarker });
  const effects = await call('caught_effects_probe', { marker: nonce });
  const detached = await call('detached_effect_probe');
  const cache = await call('cache_capability_probe', { marker: nonce });
  const assessment = assessContainmentResults({
    first,
    second,
    effects,
    detached,
    cache,
    firstMarker,
    secondMarker,
  });

  return {
    schema_version: 1,
    suite: 'gx-test-containment',
    target: resolvedTarget,
    api_origin: resolvedApiBase,
    generated_at: now().toISOString(),
    passed: assessment.passed,
    checks: assessment.checks,
    // Deliberately no raw tool responses, source, bearer, or test attestation.
    evidence_policy: 'redacted-no-attestations',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('--token')) {
    throw new Error(
      'Pass ULTRALIGHT_TOKEN through the environment, not the command line.',
    );
  }
  const target = containmentTarget(
    args.get('--target') || process.env.GX_TEST_CONTAINMENT_TARGET || 'staging',
  );
  const apiBase = containmentApiBase(
    args.get('--url') || process.env.ULTRALIGHT_API_URL,
    target,
  );
  const token = requiredString(
    process.env.ULTRALIGHT_TOKEN,
    'ULTRALIGHT_TOKEN',
  );
  const report = await runContainmentSmoke({ apiBase, target, token });
  for (const item of report.checks) {
    const output = `${item.status.toUpperCase()} [${item.name}]`;
    if (item.status === 'passed') console.log(output);
    else console.error(`${output}${item.detail ? ` ${item.detail}` : ''}`);
  }

  const outputPath = String(args.get('--output') || '').trim();
  if (outputPath) {
    const absolute = resolve(outputPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`evidence: ${absolute}`);
  }
  if (!report.passed) process.exitCode = 1;
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`gx.test containment smoke failed: ${safeDiagnostic(error)}`);
    process.exitCode = 1;
  });
}
