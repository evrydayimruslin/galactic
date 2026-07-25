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
// Release-only reviewed promotion:
//   GALACTIC_OWNER_ACCESS_TOKEN=<ephemeral account JWT> \
//   node scripts/smoke/interface-deploy-smoke.mjs ... \
//     --promote-reviewed \
//     --reviewed-permission compute:exec \
//     --reviewed-function run_compute_smoke \
//     --reviewed-compute-profile developer-v1 \
//     --reviewed-compute-tools shell \
//     --reviewed-compute-secrets none
//
// --app-id (or GALACTIC_SMOKE_APP_ID) keeps it idempotent: re-deploys the exact
// tested source to the same PRIVATE app. The server's source+live-attestation
// dedup keeps routine CI runs from consuming the connected-builder staged-
// version allowance.
// The token needs upload scope; Agent visibility always stays private.
// --promote-reviewed makes only the exact tested version live.
//
// FAIL-CLOSED: with no app id resolved the smoke ABORTS instead of minting a
// fresh app — silently creating a new "Interface Demo" every run is exactly the
// bug that accumulated dozens of duplicates. Pass --allow-create only for the
// one-time bootstrap of the fixed fixture (then set GALACTIC_SMOKE_APP_ID).

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../analysis/_shared.mjs';
import {
  computeRawSourceHash,
  fixtureRefreshPlan,
  nextFixtureVersion,
  promotionAction,
  reviewedPromotionConfig,
  validatePromotedComputeFixture,
  validateReviewedComputeManifest,
  validateStagedPromotion,
} from './interface-deploy-promotion.mjs';

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
const ownerAccessToken = String(
  process.env.GALACTIC_OWNER_ACCESS_TOKEN || '',
).trim();

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

const reviewedPromotion = reviewedPromotionConfig({
  args,
  ownerAccessToken,
  appId,
  allowCreate,
});
// gx.test/gx.upload deliberately remain on the connected-builder credential:
// that is what persists a verified test proof and enforces the staged-version
// ceiling. The owner bearer is used only for reviewed Home reads/promotion.
const toolToken = token;
const projectionToken = reviewedPromotion.enabled
  ? reviewedPromotion.ownerAccessToken
  : token;

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

if (reviewedPromotion.enabled) {
  const manifestFile = files.find((file) => file.path === 'manifest.json');
  if (!manifestFile) {
    throw new Error('Reviewed fixture promotion requires manifest.json.');
  }
  validateReviewedComputeManifest(manifestFile.content);
}

async function callTool(name, toolArgs, authorizationToken = toolToken) {
  const res = await fetch(`${apiBase}/mcp/platform`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authorizationToken}`,
    },
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

async function requestJson(path, {
  authorizationToken = projectionToken,
  method = 'GET',
  body,
  label,
} = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${authorizationToken}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseBody = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${label || 'Fixture request'} failed (HTTP ${res.status}).`);
  }
  if (!responseBody || typeof responseBody !== 'object') {
    throw new Error(`${label || 'Fixture request'} returned invalid JSON.`);
  }
  return responseBody;
}

let reviewedState = null;
if (reviewedPromotion.enabled) {
  const sourceHash = computeRawSourceHash(files);
  const [fixture, home] = await Promise.all([
    requestJson(`/api/apps/${encodeURIComponent(appId)}`, {
      label: 'Reviewed fixture version lookup',
    }),
    requestJson(`/api/launch/agents/${encodeURIComponent(appId)}/home`, {
      label: 'Reviewed fixture release lookup',
    }),
  ]);
  reviewedState = {
    sourceHash,
    fixture,
    home,
    plan: fixtureRefreshPlan({
      app: fixture,
      home,
      appId,
      sourceHash,
    }),
  };
}

// 1. Test the exact bundle. Connected builders must prove successful execution
// before upload; the returned proof is owner-, source-, and mode-bound.
let testAttestation = '';
if (!reviewedState || reviewedState.plan.action === 'upload') {
  try {
    const tested = await callTool('gx.test', {
      files,
      function_name: 'get_greeting',
      test_args: { name: 'smoke' },
    });
    testAttestation = String(tested?.test_attestation || '');
    check(
      'gx.test attestation',
      Boolean(testAttestation),
      JSON.stringify(tested?.error ?? tested ?? null).slice(0, 500),
    );
  } catch (err) {
    check('gx.test attestation', false, String(err?.message || err));
  }
} else {
  check(
    reviewedState.plan.action === 'reuse_live'
      ? 'exact tested source already live'
      : 'exact tested source already staged',
    true,
  );
}

// 2. Upload (private). Exercises bundle parse (__filename) + interface stamping.
// Existing fixtures intentionally omit an explicit version: byte-identical
// source with a valid live-bundle attestation deduplicates without consuming a
// staged-version slot. The one-time bootstrap below still creates one new
// version to exercise the interface re-version regression explicitly.
let result = null;
if (!reviewedState || reviewedState.plan.action === 'upload') {
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
    if (reviewedState) {
      uploadArgs.version = reviewedState.plan.version;
    }
    result = await callTool('gx.upload', uploadArgs);
    check('gx.upload', true);
  } catch (err) {
    check('gx.upload', false, String(err?.message || err));
  }
} else {
  result = {
    app_id: appId,
    slug: reviewedState.fixture.slug || '',
    version: reviewedState.plan.version,
    live_version: reviewedState.fixture.current_version,
    is_live: reviewedState.plan.action === 'reuse_live',
    reused: true,
  };
}
const id = result?.app_id || result?.id || '';
const slug = result?.slug || '';
check('upload returned an app id', Boolean(id), JSON.stringify(result || {}).slice(0, 200));

// Release-only: the short-lived owner account session explicitly reviews and
// promotes this exact tested source. Reuse happens only by raw source hash; a
// new upload uses an explicit version above every retained version but remains
// subject to the connected-builder three-draft ceiling. A full unrelated draft
// set fails closed without deletion. Agent Home supplies optimistic CAS,
// idempotency, and executable-bundle reconciliation for the promotion.
if (reviewedPromotion.enabled && id) {
  try {
    let promotedHome = reviewedState.home;
    if (reviewedState.plan.action !== 'reuse_live') {
      const stagedHome = reviewedState.plan.action === 'promote_candidate'
        ? reviewedState.home
        : await requestJson(
          `/api/launch/agents/${encodeURIComponent(id)}/home`,
          { label: 'Reviewed fixture candidate lookup' },
        );
      const reviewedHome = reviewedState.plan.action === 'upload'
        ? validateStagedPromotion({
          upload: result,
          home: stagedHome,
          appId,
          version: reviewedState.plan.version,
          sourceHash: reviewedState.sourceHash,
        })
        : stagedHome;
      promotedHome = await requestJson(
        `/api/launch/agents/${encodeURIComponent(id)}/home/actions`,
        {
          method: 'POST',
          body: promotionAction(
            reviewedHome,
            reviewedState.plan.version,
            randomUUID(),
          ),
          label: 'Reviewed fixture promotion',
        },
      );
    }
    const [liveApp, liveHome, liveFunctions, liveSettings] = await Promise.all([
      requestJson(`/api/apps/${encodeURIComponent(id)}`, {
        label: 'Promoted fixture projection',
      }),
      requestJson(`/api/launch/agents/${encodeURIComponent(id)}/home`, {
        label: 'Promoted Agent Home projection',
      }),
      requestJson(`/api/launch/agents/${encodeURIComponent(id)}/functions`, {
        label: 'Promoted fixture functions',
      }),
      requestJson(
        `/api/launch/agents/${encodeURIComponent(id)}/compute/settings`,
        { label: 'Promoted fixture Compute ceiling' },
      ),
    ]);
    validatePromotedComputeFixture({
      app: liveApp,
      home: liveHome,
      functions: liveFunctions,
      settings: liveSettings,
      appId,
      version: reviewedState.plan.version,
      sourceHash: reviewedState.sourceHash,
    });
    check(
      reviewedState.plan.action === 'reuse_live'
        ? 'reviewed exact version reused'
        : 'reviewed exact version promoted',
      promotedHome?.release?.live?.version === reviewedState.plan.version,
      'Owner-session response did not identify the reviewed live version.',
    );
    check('live executable version verified', true);
    check('live run_compute_smoke exposed', true);
    check('live shell-only no-secret Compute ceiling verified', true);
  } catch (err) {
    check(
      'reviewed exact version promoted',
      false,
      String(err?.message || err),
    );
  }
}

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
    const projection = await requestJson(
      `/api/apps/${encodeURIComponent(id)}`,
      {
        authorizationToken: token,
        label: 'Bootstrap fixture version lookup',
      },
    );
    const nextVersion = nextFixtureVersion(projection);
    await callTool('gx.upload', {
      files,
      test_attestation: testAttestation,
      name: 'Interface Demo (smoke)',
      visibility: 'private',
      app_id: id,
      version: nextVersion,
    }, token);
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
