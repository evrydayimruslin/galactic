import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_JOB_GATEWAY_URL,
  DEFAULT_JOB_TOKEN_FILE,
  loadAuth,
  resolveComputeJobEnvironment,
} from '../lib/job-context.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(testDir, '..', 'bin', 'ultralight.js');

test('Node bridge auth uses only lease token and private gateway in job mode', () => {
  const reads = [];
  const auth = loadAuth({
    env: {
      GALACTIC_LEASE_ID: 'lease_node',
      GALACTIC_JOB_TOKEN_FILE: '/run/test-token',
      GALACTIC_GATEWAY_URL: 'https://gateway.internal/v1',
      GALACTIC_TOKEN: 'gx_human_must_not_win',
      GALACTIC_API_URL: 'https://public.example',
    },
    readFileSync(path) {
      reads.push(path);
      if (path === '/run/test-token') return 'opaque_job\n';
      throw new Error(`unexpected persistent read: ${path}`);
    },
    homedir() {
      throw new Error('homedir must not be consulted in job mode');
    },
  });
  assert.deepEqual(reads, ['/run/test-token']);
  assert.deepEqual(auth, {
    token: 'opaque_job',
    apiUrl: 'https://gateway.internal/v1',
    jobMode: true,
    leaseId: 'lease_node',
  });
});

test('Node job defaults require an explicit lease marker', () => {
  assert.deepEqual(resolveComputeJobEnvironment({ GALACTIC_LEASE_ID: 'lease_default' }), {
    leaseId: 'lease_default',
    tokenFile: DEFAULT_JOB_TOKEN_FILE,
    gatewayUrl: DEFAULT_JOB_GATEWAY_URL,
  });
  assert.equal(resolveComputeJobEnvironment({}), null);
  assert.throws(
    () => resolveComputeJobEnvironment({ GALACTIC_JOB_TOKEN_FILE: '/tmp/token' }),
    /GALACTIC_LEASE_ID is required/,
  );
});

test('Node job auth fails closed when token file cannot be read', () => {
  let reads = 0;
  assert.throws(
    () => loadAuth({
      env: { GALACTIC_LEASE_ID: 'lease_missing' },
      readFileSync() {
        reads++;
        throw new Error('missing');
      },
    }),
    /Unable to read Galactic Compute job token file/,
  );
  assert.equal(reads, 1);
});

test('setup is blocked before persistent config mutation in job mode', () => {
  const home = mkdtempSync(join(tmpdir(), 'galactic-cli-job-'));
  const configPath = join(home, '.galactic', 'config.json');
  const tokenPath = join(home, 'job-token');
  mkdirSync(dirname(configPath), { recursive: true });
  const sentinel = '{"sentinel":true}\n';
  writeFileSync(configPath, sentinel);
  writeFileSync(tokenPath, 'opaque_job');

  const result = spawnSync(process.execPath, [cliEntry, 'setup', '--token', 'gx_human'], {
    env: {
      ...process.env,
      HOME: home,
      GALACTIC_LEASE_ID: 'lease_subprocess',
      GALACTIC_JOB_TOKEN_FILE: tokenPath,
      GALACTIC_GATEWAY_URL: 'https://galactic.internal/v1',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /setup.*unavailable inside a Galactic Compute job/);
  assert.equal(readFileSync(configPath, 'utf8'), sentinel);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /opaque_job|gx_human/);
});
