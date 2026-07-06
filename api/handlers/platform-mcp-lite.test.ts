import { assertEquals } from 'https://deno.land/std@0.210.0/assert/assert_equals.ts';
import { assert } from 'https://deno.land/std@0.210.0/assert/assert.ts';

import { getPlatformTools } from './platform-mcp.ts';

// The launch-core set advertised by the lite manifest (must match
// LAUNCH_CORE_TOOLS in platform-mcp.ts; advertised with the gx.* prefix).
const CORE = [
  'gx.call',
  'gx.codemode',
  'gx.consent',
  'gx.discover',
  'gx.grants',
  'gx.job',
  'gx.memory',
  'gx.secrets',
  'gx.set',
  'gx.test',
  'gx.upload',
  'gx.verify',
].sort();

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const prev = globalThis.__env;
  globalThis.__env = env as typeof globalThis.__env;
  try {
    return fn();
  } finally {
    globalThis.__env = prev;
  }
}

function names(provisional = false): string[] {
  return getPlatformTools({ provisional }).map((t) => t.name).sort();
}

Deno.test('lite manifest (default ON) advertises only the launch-core tools', () => {
  withEnv({}, () => {
    assertEquals(names(), CORE);
    // Demoted tools are hidden from tools/list.
    assert(!names().includes('gx.marketplace'));
    assert(!names().includes('gx.wallet'));
    assert(!names().includes('gx.routine'));
    // ul.auth.link is provisional-only — hidden for authenticated sessions.
    assert(!names().includes('gx.auth.link'));
    // PR1: legacy names are gone from the advertised list.
    assert(!names().includes('gx.connect'));
    assert(!names().includes('gx.connections'));
  });
});

Deno.test('lite manifest adds ul.auth.link for provisional sessions', () => {
  withEnv({}, () => {
    assert(names(true).includes('gx.auth.link'));
    // Still no demoted tools.
    assert(!names(true).includes('gx.marketplace'));
  });
});

Deno.test('PLATFORM_MCP_LITE=0 restores the full manifest', () => {
  withEnv({ PLATFORM_MCP_LITE: '0' }, () => {
    const full = names();
    assert(full.includes('gx.marketplace'));
    assert(full.includes('gx.wallet'));
    assert(full.includes('gx.routine'));
    assert(full.includes('gx.secrets'));
    // ul.auth.link still gated to provisional even with lite off.
    assert(!full.includes('gx.auth.link'));
    assert(names(true).includes('gx.auth.link'));
    // PR1: legacy connect/connections never advertised, even in full mode.
    assert(!full.includes('gx.connect'));
    assert(!full.includes('gx.connections'));
  });
});
