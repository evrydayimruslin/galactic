import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessContainmentResults,
  callGxTest,
  containmentApiBase,
  containmentProbeFiles,
  DURABLE_OBJECT_CODE_UPDATE_RESET,
  formatGxTestHttpFailure,
  isDurableObjectCodeUpdateResetReport,
  PRODUCTION_API_BASE,
  runContainmentSmokeWithRolloutReadiness,
  safeDiagnostic,
  stagingApiBase,
} from './gx-test-containment-smoke.mjs';

const TOKEN = 'ul_test_token_that_must_not_be_serialized';
const AI_CONTENT = '{"assessment":"gx.test deterministic AI response","actions":[]}';

function successfulState(marker) {
  return {
    success: true,
    test_attestation: 'opaque-attestation',
    result: {
      before: {
        data: null,
        agent_memory: null,
        user_memory: null,
      },
      after: {
        data: { marker },
        agent_memory: { marker, scope: 'agent' },
        user_memory: { marker, scope: 'user' },
      },
      stubs: {
        ai_content: AI_CONTENT,
        ai_cost_light: 0,
        embedding: [0, 0, 0, 0],
        notification: { created: false, reason: 'test_mode' },
        runs: { runs: [] },
        compute: {
          run_id: 'test-compute-run',
          status: 'completed',
          async: false,
        },
      },
    },
  };
}

test('probe fixture is self-contained and uses only an invalid outbound domain', () => {
  const files = containmentProbeFiles();
  assert.deepEqual(files.map((file) => file.path), [
    'index.js',
    'manifest.json',
  ]);
  const combined = files.map((file) => file.content).join('\n');
  assert.match(combined, /gx-test-probe\.invalid/u);
  assert.doesNotMatch(combined, /api\.connectgalactic\.com/u);
  assert.doesNotMatch(combined, /ultralight-api-staging/u);
});

test('target validation requires an explicit exact production origin', () => {
  assert.equal(
    stagingApiBase('https://staging.example.test/'),
    'https://staging.example.test',
  );
  assert.throws(
    () => stagingApiBase('https://api.connectgalactic.com'),
    /--target production/u,
  );
  assert.equal(
    containmentApiBase(PRODUCTION_API_BASE, 'production'),
    PRODUCTION_API_BASE,
  );
  assert.throws(
    () => containmentApiBase('https://example.com', 'production'),
    /may target only/u,
  );
  assert.throws(
    () => containmentApiBase(PRODUCTION_API_BASE, 'unknown'),
    /must be staging or production/u,
  );
  assert.throws(
    () => stagingApiBase('http://staging.example.test'),
    /bare HTTPS origin/u,
  );
  assert.throws(
    () => stagingApiBase('https://staging.example.test/path'),
    /bare HTTPS origin/u,
  );
});

test('gx.test request keeps the token in the header and decodes structured content', async () => {
  let captured;
  const result = await callGxTest({
    apiBase: 'https://staging.example.test',
    token: TOKEN,
    functionName: 'state_and_stub_probe',
    testArgs: { marker: 'one' },
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return Response.json({
        jsonrpc: '2.0',
        id: 'one',
        result: {
          structuredContent: { success: true, marker: 'decoded' },
        },
      });
    },
  });

  assert.deepEqual(result, { success: true, marker: 'decoded' });
  assert.equal(captured.url, 'https://staging.example.test/mcp/platform');
  assert.equal(captured.init.headers.Authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.params.name, 'gx.test');
  assert.equal(body.params.arguments.function_name, 'state_and_stub_probe');
  assert.equal(body.params.arguments.strict, true);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test('non-2xx diagnostics expose only bounded structured JSON-RPC fields', async () => {
  const rawBodySecret = 'raw-body-value-that-must-not-appear';
  await assert.rejects(
    () => callGxTest({
      apiBase: 'https://staging.example.test',
      token: TOKEN,
      functionName: 'state_and_stub_probe',
      testArgs: { marker: 'one' },
      fetchImpl: async () => Response.json({
        jsonrpc: '2.0',
        id: 'one',
        error: {
          code: -32603,
          message: `Authentication failed for Bearer ${TOKEN}`,
          data: {
            type: 'AUTH_SERVICE_UNAVAILABLE',
            raw: rawBodySecret,
            bearer: TOKEN,
          },
        },
        ignored: rawBodySecret,
      }, { status: 503 }),
    }),
    (error) => {
      assert.match(error.message, /gx\.test\[state_and_stub_probe\]/u);
      assert.match(error.message, /HTTP 503/u);
      assert.match(error.message, /jsonrpc_code=-32603/u);
      assert.match(error.message, /type=AUTH_SERVICE_UNAVAILABLE/u);
      assert.match(error.message, /Bearer \[REDACTED\]/u);
      assert.equal(error.message.includes(TOKEN), false);
      assert.equal(error.message.includes(rawBodySecret), false);
      return true;
    },
  );
});

test('diagnostics redact bearer, API token, JWT, and secret assignments', () => {
  const jwt = 'eyJabcdefgh.ijklmnop.qrstuvwx';
  const diagnostic = safeDiagnostic(
    `Bearer ${TOKEN}; token=${TOKEN}; password=hunter2; jwt=${jwt}`,
    [TOKEN],
  );
  assert.equal(diagnostic.includes(TOKEN), false);
  assert.equal(diagnostic.includes('hunter2'), false);
  assert.equal(diagnostic.includes(jwt), false);
  assert.match(diagnostic, /\[REDACTED\]/u);

  const bounded = formatGxTestHttpFailure({
    functionName: `probe-${'x'.repeat(200)}`,
    status: 503,
    body: { error: { code: -32603, message: 'retry later' } },
  });
  assert(bounded.length < 180);
});

test('assessment requires local state, deterministic stubs, effect latches, and no cache', () => {
  const firstMarker = 'first';
  const secondMarker = 'second';
  const result = assessContainmentResults({
    first: successfulState(firstMarker),
    second: successfulState(secondMarker),
    effects: {
      success: false,
      error: 'agent_call, credentialed_http, event_publish, imap, outbound_http, smtp',
    },
    detached: {
      success: false,
      error: 'outbound_http',
    },
    cache: {
      success: true,
      test_attestation: 'opaque-attestation',
      result: { defined: true, usable: false, error_name: 'Error' },
    },
    firstMarker,
    secondMarker,
  });

  assert.equal(result.passed, true);
  assert.equal(result.checks.every((item) => item.status === 'passed'), true);
});

test('assessment fails if a caught effect attests or ambient cache is usable', () => {
  const firstMarker = 'first';
  const secondMarker = 'second';
  const result = assessContainmentResults({
    first: successfulState(firstMarker),
    second: successfulState(secondMarker),
    effects: {
      success: false,
      test_attestation: 'must-not-exist',
      error: 'outbound_http',
    },
    detached: {
      success: true,
      test_attestation: 'must-not-exist',
      result: { returned: true },
    },
    cache: {
      success: true,
      test_attestation: 'opaque-attestation',
      result: { defined: true, usable: true, deleted: false },
    },
    firstMarker,
    secondMarker,
  });

  assert.equal(result.passed, false);
  assert.deepEqual(
    result.checks
      .filter((item) => item.status === 'failed')
      .map((item) => item.name),
    [
      'caught external effects remain disqualifying',
      'detached outbound effects remain disqualifying',
      'ambient Cache API is unavailable',
    ],
  );
  assert.match(
    result.checks.find((item) =>
      item.name === 'caught external effects remain disqualifying'
    ).detail,
    /success=false; attestation=present/u,
  );
  assert.match(
    result.checks.find((item) =>
      item.name === 'ambient Cache API is unavailable'
    ).detail,
    /cache_usable=true/u,
  );
});

test('rollout readiness recognizes only Cloudflare code-update reset reports', () => {
  const resetReport = {
    passed: false,
    checks: [
      {
        status: 'failed',
        detail: `error_type=Error; error=${DURABLE_OBJECT_CODE_UPDATE_RESET}`,
      },
      {
        status: 'passed',
        detail: '',
      },
    ],
  };
  assert.equal(isDurableObjectCodeUpdateResetReport(resetReport), true);
  assert.equal(
    isDurableObjectCodeUpdateResetReport({
      passed: false,
      checks: [{
        status: 'failed',
        detail: 'missing_effects=outbound_http; error=blocked effects',
      }],
    }),
    false,
  );
  assert.equal(
    isDurableObjectCodeUpdateResetReport({
      passed: true,
      checks: [{ status: 'passed', detail: '' }],
    }),
    false,
  );
});

test('rollout readiness settles once and retries only an exact code-update reset', async () => {
  const delays = [];
  const retries = [];
  const reports = [
    {
      passed: false,
      checks: [{
        status: 'failed',
        detail: `error=${DURABLE_OBJECT_CODE_UPDATE_RESET}`,
      }],
    },
    { passed: true, checks: [{ status: 'passed', detail: '' }] },
  ];
  const calls = [];
  const result = await runContainmentSmokeWithRolloutReadiness({
    apiBase: 'https://staging.example.test',
    target: 'staging',
    token: TOKEN,
    rolloutSettleMs: 30_000,
    codeUpdateResetRetries: 2,
    codeUpdateResetDelayMs: 15_000,
    runImpl: async (input) => {
      calls.push(input);
      return reports.shift();
    },
    delayImpl: async (milliseconds) => delays.push(milliseconds),
    onRetry: (retry) => retries.push(retry),
  });

  assert.equal(result.report.passed, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(delays, [30_000, 15_000]);
  assert.equal(calls.length, 2);
  assert.deepEqual(retries, [{ attempt: 1, nextAttempt: 2, delayMs: 15_000 }]);
});

test('rollout readiness never retries a containment latch failure', async () => {
  let calls = 0;
  const report = {
    passed: false,
    checks: [{
      status: 'failed',
      detail: 'missing_effects=outbound_http; success=false',
    }],
  };
  const result = await runContainmentSmokeWithRolloutReadiness({
    codeUpdateResetRetries: 3,
    codeUpdateResetDelayMs: 15_000,
    runImpl: async () => {
      calls += 1;
      return report;
    },
    delayImpl: async () => assert.fail('unexpected delay'),
  });

  assert.equal(result.report, report);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});
