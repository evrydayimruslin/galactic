// WO-F2: pure-Node tests for the funnel front door. Run with:
//   node --test tests/funnel-new.node.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildBrief,
  describeStageChange,
  FUNNEL_POLICY_SEED_DEFAULT,
  mergeFunnelConfig,
  parseNewArgs,
  watchPairing,
} from '../lib/funnel-new.mjs';

function minted(overrides = {}) {
  return {
    pairing: {
      code: 'abcdefghjkmnpqrs2345',
      url: 'https://connectgalactic.com/b/abcdefghjkmnpqrs2345',
      expiresAt: '2026-08-10T21:00:00.000Z',
    },
    handoff: {
      id: 'session-1',
      status: 'created',
      reservedAgentId: 'agent-1',
      createdAt: '2026-08-03T21:00:00.000Z',
      expiresAt: '2026-08-03T22:00:00.000Z',
    },
    credential: {
      id: 'token-1',
      tokenPrefix: 'gx_abcd',
      plaintextToken: 'gx_secret_credential_value',
      scopes: ['builder'],
      appIds: null,
      createdAt: '2026-08-03T21:00:00.000Z',
      expiresAt: '2026-08-03T22:00:00.000Z',
    },
    platformMcpUrl: 'https://api.connectgalactic.com/mcp/platform',
    ...overrides,
  };
}

test('parseNewArgs reads the plan, the seed, and the switches', () => {
  const parsed = parseNewArgs([
    'chase', 'overdue', 'invoices',
    '--ask-before', 'sending email',
    '--no-watch',
    '-y',
  ]);
  assert.equal(parsed.description, 'chase overdue invoices');
  assert.equal(parsed.seed, 'sending email');
  assert.equal(parsed.watch, false);
  assert.equal(parsed.yes, true);

  assert.equal(parseNewArgs([]).description, null);
  assert.equal(parseNewArgs(['--ask-before=x']).seed, 'x');
  assert.equal(parseNewArgs(['--help']).help, true);
});

test('the brief carries plan, seed, and pairing URL — never the credential', () => {
  const brief = buildBrief({
    description: 'chase overdue invoices',
    policySeed: 'sending anything to a human',
    pairingUrl: 'https://connectgalactic.com/b/abc',
    platformMcpUrl: 'https://api.connectgalactic.com/mcp/platform',
  });
  assert.ok(brief.includes('chase overdue invoices'));
  assert.ok(brief.includes('must ask before sending anything to a human'));
  assert.ok(brief.includes('https://connectgalactic.com/b/abc'));
  assert.ok(brief.includes('galacticconnection resume'));
  assert.ok(!brief.includes('gx_secret'));

  const skipped = buildBrief({
    description: 'x',
    policySeed: null,
    pairingUrl: 'u',
    platformMcpUrl: 'm',
  });
  assert.ok(skipped.includes('skipped the boundary question'));
});

test('mergeFunnelConfig fills an empty slot, upgrades funnel, never clobbers a real key', () => {
  const fresh = mergeFunnelConfig(null, minted(), 'https://api.example');
  assert.equal(fresh.bridgeAuthorized, true);
  assert.equal(fresh.config.auth.token, 'gx_secret_credential_value');
  assert.equal(fresh.config.auth.funnel, true);
  assert.equal(fresh.config.funnel.pairing_code, 'abcdefghjkmnpqrs2345');

  const resumed = mergeFunnelConfig(
    fresh.config,
    minted({
      credential: { ...minted().credential, plaintextToken: 'gx_second' },
    }),
    'https://api.example',
  );
  assert.equal(resumed.bridgeAuthorized, true);
  assert.equal(resumed.config.auth.token, 'gx_second');

  const real = mergeFunnelConfig(
    { auth: { token: 'gx_real_account_key', is_api_token: true } },
    minted(),
    'https://api.example',
  );
  assert.equal(real.bridgeAuthorized, false);
  assert.equal(real.config.auth.token, 'gx_real_account_key');
  assert.equal(real.config.funnel.pairing_code, 'abcdefghjkmnpqrs2345');
});

test('describeStageChange announces only fresh transitions', () => {
  const before = { connectedAt: 't1', stagedAt: null, uploadedAt: null };
  const after = { connectedAt: 't1', stagedAt: 't2', uploadedAt: null };
  assert.deepEqual(describeStageChange(before, after), ['Source staged']);
  assert.deepEqual(
    describeStageChange(null, { connectedAt: 't1' }),
    ['Coding agent connected'],
  );
  assert.deepEqual(describeStageChange(after, after), []);
});

test('watchPairing mirrors transitions and stops at upload', async () => {
  const states = [
    { connectedAt: null, stagedAt: null, testedAt: null, uploadedAt: null, claimed: false },
    { connectedAt: 't1', stagedAt: null, testedAt: null, uploadedAt: null, claimed: false },
    { connectedAt: 't1', stagedAt: 't2', testedAt: 't3', uploadedAt: 't4', claimed: false },
  ];
  let call = 0;
  const lines = [];
  const result = await watchPairing({
    apiUrl: 'https://api.example',
    pairingCode: 'abcdefghjkmnpqrs2345',
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          success: true,
          pairing: states[Math.min(call++, states.length - 1)],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    log: (line) => lines.push(line),
    sleep: async () => {},
    maxTicks: 10,
  });
  assert.equal(result.uploadedAt, 't4');
  assert.ok(lines.some((line) => line.includes('Coding agent connected')));
  assert.ok(lines.some((line) => line.includes('Candidate uploaded')));
  assert.ok(lines.some((line) => line.includes('/b/abcdefghjkmnpqrs2345')));
  assert.ok(call <= 4, 'stops polling once uploaded');
});
