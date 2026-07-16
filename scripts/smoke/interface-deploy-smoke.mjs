#!/usr/bin/env node
// Interface DEPLOY+RENDER smoke — the end-to-end developer happy-path that
// silently broke (the CLI dropped interfaces/*.html client-side; the TS parser
// crashed on Node's __filename server-side) yet still passed `test:full`,
// because nothing actually deployed an interface agent and checked it renders.
//
// This tests and uploads the reference interface agent through gx.test →
// gx.upload and asserts:
//   1. the interface HTML is in the bundle (guards the CLI .html-drop class)
//   2. gx.test issues a source-bound upload attestation
//   3. gx.upload succeeds (guards the server __filename / bundle-parse class)
//   4. the launch facade returns the interface with a sandbox url + functions
//      (guards hash-stamping + facade exposure)
//   5. the sandbox worker serves the artifact: 200, text/html, non-empty
//      (guards R2 + interfaces-worker)
//   6. (opt-in --exercise-run, costs a function call) a bridge function runs
//
// Usage:
//   GALACTIC_TOKEN=gx_... node scripts/smoke/interface-deploy-smoke.mjs \
//     [--url https://api.connectgalactic.com] [--app-id <id>] \
//     [--dir examples/interface-demo] [--exercise-run] [--allow-create]
//
// --app-id (or GALACTIC_SMOKE_APP_ID) keeps it idempotent: re-deploys the exact
// tested source to the same PRIVATE app. The server's source+live-attestation
// dedup keeps routine CI runs from consuming the connected-builder staged-
// version allowance.
// The token needs upload scope; the agent stays private (never goes live).
//
// FAIL-CLOSED: with no app id resolved the smoke ABORTS instead of minting a
// fresh app — silently creating a new "Interface Demo" every run is exactly the
// bug that accumulated dozens of duplicates. Pass --allow-create only for the
// one-time bootstrap of the fixed fixture (then set GALACTIC_SMOKE_APP_ID).

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../analysis/_shared.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = parseArgs(process.argv.slice(2));
const apiBase = String(
  args.get('--url') || process.env.GALACTIC_API_URL || process.env.ULTRALIGHT_API_URL ||
    'https://api.connectgalactic.com',
).replace(/\/$/, '');
const token = String(
  args.get('--token') || process.env.GALACTIC_TOKEN || process.env.ULTRALIGHT_TOKEN || '',
).trim();
const appId = String(
  args.get('--app-id') || process.env.GALACTIC_SMOKE_APP_ID ||
    process.env.ULTRALIGHT_SMOKE_APP_ID || '',
).trim();
const dir = String(args.get('--dir') || 'examples/interface-demo').trim();
const exerciseRun = args.has('--exercise-run');
const allowCreate = args.has('--allow-create');

if (!token) {
  console.error('interface-deploy-smoke requires GALACTIC_TOKEN (upload-scoped) or --token');
  process.exit(2);
}

// Fail-closed: never silently mint a new app. Without a fixed app id every run
// creates a duplicate "Interface Demo" (the manifest name wins server-side, so
// even a distinct --name does not separate them). Require an explicit opt-in to
// create, which is only ever used once to seed GALACTIC_SMOKE_APP_ID.
if (!appId && !allowCreate) {
  console.error(
    'interface-deploy-smoke: no app id resolved (set GALACTIC_SMOKE_APP_ID or pass --app-id).\n' +
    'Refusing to create a new app — that is the duplicate-Interface-Demo bug.\n' +
    'For the one-time fixture bootstrap, re-run with --allow-create.',
  );
  process.exit(2);
}

let failures = 0;
function check(step, cond, detail = '') {
  if (cond) console.log(`PASS [${step}]`);
  else {
    failures += 1;
    console.error(`FAIL [${step}] ${detail}`);
  }
}

// Collect the agent's files the way an upload does: recurse, keep source +
// .html. Deliberately independent of the CLI so this also asserts that the
// interface entry file is present (the bug was a silent drop of .html).
const allowed = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.css', '.html']);
const ignore = new Set(['node_modules', '.git', '.ultralight', 'dist', 'build']);
const absDir = join(repoRoot, dir);
const files = [];
(function walk(p) {
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, entry.name);
    if (entry.isDirectory()) {
      if (!ignore.has(entry.name)) walk(full);
    } else {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (allowed.has(ext)) {
        files.push({
          path: relative(absDir, full).split(/[\\/]/).join('/'),
          content: readFileSync(full, 'utf8'),
        });
      }
    }
  }
})(absDir);

check(
  'interface HTML in bundle',
  files.some((f) => f.path.endsWith('.html')),
  `collected: ${files.map((f) => f.path).join(', ')}`,
);

async function callTool(name, toolArgs) {
  const res = await fetch(`${apiBase}/mcp/platform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: toolArgs } }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} non-JSON: ${text.slice(0, 300)}`); }
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  const r = body.result;
  if (!r) throw new Error(`no result: ${text.slice(0, 300)}`);
  if (r.isError) throw new Error(r.content?.[0]?.text || 'tool error');
  if (r.structuredContent !== undefined) return r.structuredContent;
  const txt = r.content?.[0]?.text;
  try { return txt ? JSON.parse(txt) : r; } catch { return { text: txt }; }
}

const canonicalVersion = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

function incrementVersion(version) {
  const parts = version.split('.').map(Number);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] < 999_999_999) {
      parts[i] += 1;
      return parts.join('.');
    }
    parts[i] = 0;
  }
  throw new Error('smoke fixture exhausted the canonical version range');
}

async function nextFixtureVersion(locator) {
  const res = await fetch(`${apiBase}/api/apps/${encodeURIComponent(locator)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`could not read fixture versions: HTTP ${res.status}`);
  }
  const versions = [...new Set([
    ...(Array.isArray(body.versions) ? body.versions : []),
    body.current_version,
  ])].filter((version) => canonicalVersion.test(String(version)));
  if (versions.length === 0) return '1.0.1';
  versions.sort((a, b) => {
    const left = String(a).split('.').map(Number);
    const right = String(b).split('.').map(Number);
    return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  });
  return incrementVersion(String(versions.at(-1)));
}

// 1. Test the exact bundle. Connected builders must prove successful execution
// before upload; the returned proof is owner-, source-, and mode-bound.
let testAttestation = '';
try {
  const tested = await callTool('gx.test', {
    files,
    function_name: 'get_greeting',
    test_args: { name: 'smoke' },
  });
  testAttestation = String(tested?.test_attestation || '');
  check('gx.test attestation', Boolean(testAttestation));
} catch (err) {
  check('gx.test attestation', false, String(err?.message || err));
}

// 2. Upload (private). Exercises bundle parse (__filename) + interface stamping.
// Existing fixtures intentionally omit an explicit version: byte-identical
// source with a valid live-bundle attestation deduplicates without consuming a
// staged-version slot. The one-time bootstrap below still creates one new
// version to exercise the interface re-version regression explicitly.
let result = null;
try {
  const uploadArgs = {
    files,
    test_attestation: testAttestation,
    name: 'Interface Demo (smoke)',
    visibility: 'private',
  };
  if (appId) {
    uploadArgs.app_id = appId;
  }
  result = await callTool('gx.upload', uploadArgs);
  check('gx.upload', true);
} catch (err) {
  check('gx.upload', false, String(err?.message || err));
}
const id = result?.app_id || result?.id || '';
const slug = result?.slug || '';
check('upload returned an app id', Boolean(id), JSON.stringify(result || {}).slice(0, 200));

// 3. Launch facade exposes the interface (hash stamped + surfaced).
let iface = null;
if (id || slug) {
  try {
    const detail = await fetch(`${apiBase}/api/launch/agents/${slug || id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const agent = detail.agent || detail.tool || {};
    iface = (agent.interfaces || [])[0] || null;
    check('launch facade returns interface', Boolean(iface?.url), `interfaces: ${JSON.stringify(agent.interfaces ?? null)}`);
    check(
      'interface declares functions',
      Array.isArray(iface?.functions) && iface.functions.length > 0,
      JSON.stringify(iface?.functions ?? null),
    );
  } catch (err) {
    check('launch facade returns interface', false, String(err?.message || err));
  }
}

// 4. Sandbox worker serves the artifact.
if (iface?.url) {
  try {
    const a = await fetch(iface.url);
    const ct = a.headers.get('content-type') || '';
    const html = await a.text();
    check('artifact serves 200', a.status === 200, `status ${a.status}`);
    check('artifact is text/html', ct.startsWith('text/html'), ct);
    check('artifact non-empty', html.length > 200, `len ${html.length}`);
  } catch (err) {
    check('artifact serves 200', false, String(err?.message || err));
  }
}

// 5. One-time bootstrap re-version guard: upload the same files as a NEW
// version and assert the interface SURVIVES. Re-versioning used to persist an
// unstamped manifest and drop the interface. Routine fixed-fixture runs prove
// the verified idempotent redeploy path above without filling its three staged
// version slots.
if (id && !appId) {
  try {
    const nextVersion = await nextFixtureVersion(id);
    await callTool('gx.upload', {
      files,
      test_attestation: testAttestation,
      name: 'Interface Demo (smoke)',
      visibility: 'private',
      app_id: id,
      version: nextVersion,
    });
    const after = await fetch(`${apiBase}/api/launch/agents/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const agent2 = after.agent || after.tool || {};
    const iface2 = (agent2.interfaces || [])[0] || null;
    check('interface survives re-version', Boolean(iface2?.url), `interfaces after re-upload: ${JSON.stringify(agent2.interfaces ?? null)}`);
  } catch (err) {
    check('interface survives re-version', false, String(err?.message || err));
  }
} else if (id) {
  check(
    'verified redeploy preserves interface',
    Boolean(iface?.url),
    `interfaces after redeploy: ${JSON.stringify(iface ?? null)}`,
  );
}

// 6. (opt-in) a function actually runs — via the agent's own MCP endpoint,
// which an API token CAN call (the launch-web /functions/:fn/run path requires
// a browser account session, so it 403s for tokens). Best-effort/informational:
// it costs a function call and is not part of the deploy+render pass/fail gate.
if (exerciseRun && id) {
  try {
    const res = await fetch(`${apiBase}/mcp/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_greeting', arguments: { name: 'smoke' } },
      }),
    });
    const out = await res.text();
    console.log(out.includes('Hello') ? 'PASS [function run get_greeting]' : `INFO [function run] status ${res.status} ${out.slice(0, 200)}`);
  } catch (err) {
    console.log(`INFO [function run] ${String(err?.message || err)}`);
  }
}

if (failures > 0) {
  console.error(`interface-deploy-smoke: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`interface-deploy-smoke: all checks passed${id ? ` (app ${id})` : ''}`);
