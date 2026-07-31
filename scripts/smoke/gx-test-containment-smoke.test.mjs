import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessContainmentResults,
  callGxTest,
  containmentApiBase,
  containmentProbeFiles,
  PRODUCTION_API_BASE,
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
