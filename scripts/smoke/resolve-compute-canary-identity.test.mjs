import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  COMPUTE_CANARY_IDENTITY_KIND,
  computeCanaryIdentityConfigFromCli,
  computeCanaryIdentityEvidence,
  computeCanaryIdentityOutputPath,
  resolveComputeCanaryIdentity,
  writeComputeCanaryIdentityEvidence,
} from './resolve-compute-canary-identity.mjs';
import { PRODUCTION_API_BASE, STAGING_API_BASE } from './with-staging-owner-session.mjs';

const OWNER_ID = '7A2F16E1-C578-4C9B-9DB7-6B3F49703FE0';
const AGENT_ID = 'DA122721-E66B-4D3E-B107-B9841C7F7162';
const CANONICAL_OWNER_ID = OWNER_ID.toLowerCase();
const CANONICAL_AGENT_ID = AGENT_ID.toLowerCase();
const TOKEN = 'api-token-that-must-never-be-written-or-logged';

function ownerProof(overrides = {}) {
  return {
    id: OWNER_ID,
    email: 'owner@example.test',
    smokeAgentId: AGENT_ID,
    ...overrides,
  };
}

test('derives one exact canonical owner/Agent allowlist identity', () => {
  assert.deepEqual(
    computeCanaryIdentityEvidence({
      target: 'production',
      owner: ownerProof(),
    }),
    {
      schema_version: 1,
      kind: COMPUTE_CANARY_IDENTITY_KIND,
      target: 'production',
      owner_id: CANONICAL_OWNER_ID,
      agent_id: CANONICAL_AGENT_ID,
      allowlist_entry: `${CANONICAL_OWNER_ID}/${CANONICAL_AGENT_ID}`,
    },
  );
});

for (
  const [label, owner] of [
    ['null proof', null],
    ['array proof', []],
    ['missing owner', ownerProof({ id: undefined })],
    ['malformed owner', ownerProof({ id: 'not-a-uuid' })],
    [
      'unsupported owner UUID version',
      ownerProof({ id: '7a2f16e1-c578-0c9b-9db7-6b3f49703fe0' }),
    ],
    ['owner newline', ownerProof({ id: `${CANONICAL_OWNER_ID}\n` })],
    ['missing Agent', ownerProof({ smokeAgentId: undefined })],
    ['malformed Agent', ownerProof({ smokeAgentId: 'not-a-uuid' })],
    [
      'unsupported Agent UUID version',
      ownerProof({
        smokeAgentId: 'da122721-e66b-0d3e-b107-b9841c7f7162',
      }),
    ],
    [
      'comma-injected Agent',
      ownerProof({ smokeAgentId: `${CANONICAL_AGENT_ID},${CANONICAL_AGENT_ID}` }),
    ],
  ]
) {
  test(`fails closed on ${label}`, () => {
    assert.throws(
      () => computeCanaryIdentityEvidence({ target: 'staging', owner }),
      /Compute canary/u,
    );
  });
}

test('fails closed on unsupported targets without echoing their value', () => {
  const hostile = `${TOKEN}\nproduction`;
  assert.throws(
    () => computeCanaryIdentityEvidence({ target: hostile, owner: ownerProof() }),
    (error) => {
      assert.equal(error.message, 'Compute canary target is invalid.');
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
});

test('accepts only normalized absolute output paths without control characters', () => {
  const valid = join(tmpdir(), 'compute-canary-identity.json');
  assert.equal(computeCanaryIdentityOutputPath(valid), valid);
  for (
    const invalid of [
      'relative.json',
      `${valid}\nleak`,
      `${valid}\rleak`,
      `${valid}\0leak`,
      `${valid} `,
      `${tmpdir()}/nested/../identity.json`,
      '/',
    ]
  ) {
    assert.throws(
      () => computeCanaryIdentityOutputPath(invalid),
      /output path is invalid/u,
    );
  }
});

test('writes exact token-free JSON with a trailing newline and mode 0600', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galactic-canary-identity-'));
  const outputPath = join(directory, 'identity.json');
  try {
    const calls = [];
    const evidence = await resolveComputeCanaryIdentity({
      target: 'staging',
      apiToken: TOKEN,
      smokeAgentId: AGENT_ID,
      outputPath,
      resolveOwner: async (input) => {
        calls.push(input);
        return ownerProof();
      },
    });
    assert.deepEqual(calls, [{
      target: 'staging',
      apiBase: STAGING_API_BASE,
      apiToken: TOKEN,
      smokeAgentId: CANONICAL_AGENT_ID,
    }]);
    const bytes = await readFile(outputPath, 'utf8');
    assert.equal(bytes.endsWith('\n'), true);
    assert.equal(bytes.endsWith('\n\n'), false);
    assert.deepEqual(JSON.parse(bytes), evidence);
    assert.equal(bytes.includes(TOKEN), false);
    assert.equal(bytes.includes('owner@example.test'), false);
    assert.equal((await lstat(outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses the pinned production origin and rejects a mismatched owner proof', async () => {
  const calls = [];
  await assert.rejects(
    resolveComputeCanaryIdentity({
      target: 'production',
      apiToken: TOKEN,
      smokeAgentId: AGENT_ID,
      outputPath: join(tmpdir(), 'must-not-write-canary-identity.json'),
      resolveOwner: async (input) => {
        calls.push(input);
        return ownerProof({
          smokeAgentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        });
      },
      writeEvidence: async () => {
        assert.fail('mismatched proof must not be written');
      },
    }),
    /does not match the requested Agent/u,
  );
  assert.equal(calls[0].apiBase, PRODUCTION_API_BASE);
});

test('collapses resolver failures so tokens cannot escape through errors', async () => {
  let writes = 0;
  await assert.rejects(
    resolveComputeCanaryIdentity({
      target: 'production',
      apiToken: TOKEN,
      smokeAgentId: AGENT_ID,
      outputPath: join(tmpdir(), 'must-not-write-canary-identity.json'),
      resolveOwner: async () => {
        throw new Error(`upstream echoed ${TOKEN}`);
      },
      writeEvidence: async () => {
        writes += 1;
      },
    }),
    (error) => {
      assert.equal(error.message, 'Compute canary identity resolution failed.');
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(writes, 0);
});

test('collapses publisher failures so tokens cannot escape through errors', async () => {
  await assert.rejects(
    resolveComputeCanaryIdentity({
      target: 'production',
      apiToken: TOKEN,
      smokeAgentId: AGENT_ID,
      outputPath: join(tmpdir(), 'must-not-write-canary-identity.json'),
      resolveOwner: async () => ownerProof(),
      writeEvidence: async () => {
        throw new Error(`publisher echoed ${TOKEN}`);
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        'Compute canary identity evidence could not be written.',
      );
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
});

test('cleans temporary evidence after an atomic publication failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galactic-canary-failure-'));
  const outputPath = join(directory, 'identity.json');
  const evidence = computeCanaryIdentityEvidence({
    target: 'staging',
    owner: ownerProof(),
  });
  let cleanedPath = null;
  try {
    await assert.rejects(
      writeComputeCanaryIdentityEvidence(outputPath, evidence, {
        randomUuidImpl: () => '11111111-1111-4111-8111-111111111111',
        renameImpl: async () => {
          throw new Error(`rename leaked ${TOKEN}`);
        },
        unlinkImpl: async (path) => {
          cleanedPath = path;
          await rm(path, { force: true });
        },
      }),
      (error) => {
        assert.equal(
          error.message,
          'Compute canary identity evidence could not be written.',
        );
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      },
    );
    assert.equal(
      cleanedPath,
      join(
        directory,
        '.identity.json.11111111-1111-4111-8111-111111111111.tmp',
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects hostile temporary names before touching the filesystem', async () => {
  const evidence = computeCanaryIdentityEvidence({
    target: 'staging',
    owner: ownerProof(),
  });
  let writes = 0;
  await assert.rejects(
    writeComputeCanaryIdentityEvidence(
      join(tmpdir(), 'must-not-write-hostile-temporary.json'),
      evidence,
      {
        randomUuidImpl: () => `../${TOKEN}\n`,
        writeFileImpl: async () => {
          writes += 1;
        },
      },
    ),
    (error) => {
      assert.equal(
        error.message,
        'Compute canary identity temporary id is not a canonical canary UUID.',
      );
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(writes, 0);
});

test('CLI configuration keeps credentials in env and rejects hostile paths', () => {
  const outputPath = join(tmpdir(), 'compute-canary-cli.json');
  assert.deepEqual(
    computeCanaryIdentityConfigFromCli(
      ['--target', 'production', '--output', outputPath],
      {
        ULTRALIGHT_TOKEN: TOKEN,
        GALACTIC_SMOKE_APP_ID: AGENT_ID,
      },
    ),
    {
      target: 'production',
      outputPath,
      apiToken: TOKEN,
      smokeAgentId: CANONICAL_AGENT_ID,
    },
  );
  assert.throws(
    () =>
      computeCanaryIdentityConfigFromCli(
        ['--target', 'production', '--output', `${outputPath}\n${TOKEN}`],
        {
          ULTRALIGHT_TOKEN: TOKEN,
          GALACTIC_SMOKE_APP_ID: AGENT_ID,
        },
      ),
    (error) => {
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.throws(
    () =>
      computeCanaryIdentityConfigFromCli(
        ['--target', 'production', '--output', outputPath, TOKEN],
        {
          ULTRALIGHT_TOKEN: TOKEN,
          GALACTIC_SMOKE_APP_ID: AGENT_ID,
        },
      ),
    (error) => {
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
});

test('writer rejects schema drift before touching the destination', async () => {
  const evidence = {
    ...computeCanaryIdentityEvidence({ target: 'staging', owner: ownerProof() }),
    unexpected: TOKEN,
  };
  let writes = 0;
  await assert.rejects(
    writeComputeCanaryIdentityEvidence(
      join(tmpdir(), 'must-not-write-schema-drift.json'),
      evidence,
      {
        writeFileImpl: async () => {
          writes += 1;
        },
      },
    ),
    (error) => {
      assert.equal(error.message, 'Compute canary identity evidence is invalid.');
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(writes, 0);
});
