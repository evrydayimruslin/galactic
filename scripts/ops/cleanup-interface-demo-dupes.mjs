#!/usr/bin/env node
// One-shot maintenance: collapse the duplicate "Interface Demo" agents down to a
// single keeper. The interface deploy smoke ran for months without a fixed app
// id, and because the server takes the app name from the manifest (so a distinct
// --name is ignored), every run minted a new private app all titled
// "Interface Demo". This enumerates the owner's library, keeps ONE, and
// soft-deletes the rest (DELETE /api/apps/:id sets deleted_at — reversible).
//
// Usage:
//   GALACTIC_TOKEN=gx_... node scripts/ops/cleanup-interface-demo-dupes.mjs            # dry run
//   GALACTIC_TOKEN=gx_... node scripts/ops/cleanup-interface-demo-dupes.mjs --yes      # delete
//   [--url https://api.connectgalactic.com] [--keep <app-id>] [--name "Interface Demo"]
//
// Token resolution: --token, then GALACTIC_TOKEN / ULTRALIGHT_TOKEN, then the CLI
// config at ~/.galactic/config.json (legacy ~/.ultralight/config.json).
// The token must be an UPLOAD/owner-scoped token for the account that owns them.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const apiBase = String(
  val('--url') || process.env.GALACTIC_API_URL || 'https://api.connectgalactic.com',
).replace(/\/$/, '');
const targetName = String(val('--name') || 'Interface Demo');
const apply = has('--yes');

// Default keeper: the app wired into the local example rc, so local `galactic
// upload` and the CI smoke converge on the same fixture.
function localRcAppId() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const name of ['.galacticrc.json', '.ultralightrc.json']) {
    try {
      const rc = JSON.parse(readFileSync(join(repoRoot, 'examples/interface-demo', name), 'utf8'));
      if (rc?.app_id) return String(rc.app_id);
    } catch { /* next */ }
  }
  return undefined;
}

function resolveToken() {
  const direct = val('--token') || process.env.GALACTIC_TOKEN || process.env.ULTRALIGHT_TOKEN;
  if (direct) return String(direct).trim();
  for (const p of [join(homedir(), '.galactic', 'config.json'), join(homedir(), '.ultralight', 'config.json')]) {
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      if (cfg?.auth?.token) return String(cfg.auth.token).trim();
    } catch { /* next */ }
  }
  return '';
}

const token = resolveToken();
if (!token) {
  console.error('No token. Set GALACTIC_TOKEN, pass --token, or `galactic login` first.');
  process.exit(2);
}
const wantKeeper = val('--keep') || process.env.KEEP_APP_ID || localRcAppId();

const authHeaders = { Authorization: `Bearer ${token}` };

async function listOwned() {
  const r = await fetch(`${apiBase}/api/launch/library`, { headers: authHeaders });
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { throw new Error(`library HTTP ${r.status}: ${txt.slice(0, 200)}`); }
  if (!Array.isArray(body.owned)) throw new Error(`library HTTP ${r.status}: ${txt.slice(0, 200)}`);
  return body.owned;
}

async function deleteApp(id) {
  const r = await fetch(`${apiBase}/api/apps/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  const txt = await r.text();
  return { ok: r.ok, status: r.status, body: txt.slice(0, 160) };
}

const owned = await listOwned();
const demos = owned.filter((a) => (a.name || '') === targetName);
console.log(`Owned apps: ${owned.length} | "${targetName}": ${demos.length}`);
if (demos.length === 0) { console.log('Nothing to do.'); process.exit(0); }

// Pick the keeper.
let keeper = demos.find((d) => d.id === wantKeeper);
if (!keeper) {
  // Oldest by updatedAt (the launch summary's timestamp) so the keeper is stable.
  keeper = [...demos].sort((a, b) =>
    String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))[0];
  if (wantKeeper) console.log(`Requested keeper ${wantKeeper} not in library; falling back to oldest.`);
}
console.log(`Keeper: ${keeper.id}  (slug=${keeper.slug || '?'}, visibility=${keeper.visibility || '?'})`);

const toDelete = demos.filter((d) => d.id !== keeper.id);
console.log(`${apply ? 'Deleting' : 'Would delete'} ${toDelete.length} duplicate(s):`);

let okCount = 0, failCount = 0;
for (const d of toDelete) {
  if (!apply) {
    console.log(`  - ${d.id} (${d.visibility || '?'})`);
    continue;
  }
  const res = await deleteApp(d.id);
  if (res.ok) { okCount++; console.log(`  ✓ ${d.id}`); }
  else { failCount++; console.log(`  ✗ ${d.id} — HTTP ${res.status} ${res.body}`); }
}

console.log();
if (!apply) {
  console.log(`Dry run. Re-run with --yes to soft-delete ${toDelete.length} app(s).`);
} else {
  console.log(`Done. Deleted ${okCount}, failed ${failCount}, kept 1 (${keeper.id}).`);
}
console.log(`\nSet the CI fixture secret:\n  gh secret set GALACTIC_SMOKE_APP_ID --body ${keeper.id}`);
