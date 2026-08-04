// WO-F2: `galacticconnection new` — the terminal front door of the funnel.
//
// Pure Node (the funnel's first minute must not demand a runtime install).
// Everything here is dependency-injected so node:test can drive it without
// a network, a TTY, or a home directory.

export const FUNNEL_POLICY_SEED_DEFAULT = 'sending anything to a human';
export const FUNNEL_WATCH_INTERVAL_MS = 5_000;

export function parseNewArgs(args) {
  const out = { description: null, seed: undefined, watch: true, yes: false, help: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--no-watch') out.watch = false;
    else if (arg === '--yes' || arg === '-y') out.yes = true;
    else if (arg === '--ask-before') { out.seed = args[i + 1] ?? ''; i++; }
    else if (arg.startsWith('--ask-before=')) out.seed = arg.slice('--ask-before='.length);
    else positional.push(arg);
  }
  if (positional.length > 0) out.description = positional.join(' ').trim() || null;
  return out;
}

/**
 * The build brief handed to the coding agent. It carries the plan, the
 * owner's policy seed sentence, and the pairing URL — never the credential
 * (the bridge holds that; briefs land in scrollback and pasteboards).
 */
export function buildBrief({ description, policySeed, pairingUrl, platformMcpUrl }) {
  const seedLine = policySeed
    ? `The owner's boundary, in their words: the agent must ask before ${policySeed}. ` +
      `Declare the guarded action(s) in the manifest so this boundary is enforceable, ` +
      `and record the sentence verbatim in the plan.`
    : 'The owner skipped the boundary question; declare consequential actions conservatively.';
  return `You are building a persistent Galactic Agent from this plan.

PLAN: ${description}

${seedLine}

HOW TO BUILD
- Galactic platform MCP: ${platformMcpUrl} (your bridge is already authorized).
- Scaffold from the universal template, then stage source with gx.stage,
  exact-test with gx.test, and upload the candidate with gx.upload.
- The build session credential expires 60 minutes from mint; if it lapses,
  the owner runs: galacticconnection resume
- Progress is mirrored live for the owner at: ${pairingUrl}

Do not print or persist any gx_ credential. When the candidate uploads
successfully, tell the owner to open the pairing page.`;
}

export function describeStageChange(previous, next) {
  const lines = [];
  const stages = [
    ['connectedAt', 'Coding agent connected'],
    ['stagedAt', 'Source staged'],
    ['testedAt', 'Exact-tested'],
    ['uploadedAt', 'Candidate uploaded'],
    ['promotedAt', 'Deployed'],
  ];
  for (const [key, label] of stages) {
    if (next[key] && !(previous && previous[key])) lines.push(label);
  }
  if (next.claimed && !(previous && previous.claimed)) lines.push('Claimed into a fleet');
  return lines;
}

export function mergeFunnelConfig(existingConfig, minted, apiUrl) {
  const config = existingConfig && typeof existingConfig === 'object' ? { ...existingConfig } : {};
  config.api_url = config.api_url || apiUrl;
  config.funnel = {
    pairing_code: minted.pairing.code,
    pairing_url: minted.pairing.url,
    handoff_id: minted.handoff.id,
    reserved_agent_id: minted.handoff.reservedAgentId,
    credential_expires_at: minted.credential.expiresAt,
    return_window_expires_at: minted.pairing.expiresAt,
  };
  // The bridge reads config.auth.token. A funnel credential fills an empty
  // slot or replaces a prior funnel credential (resume) — a real account
  // key is never clobbered.
  if (!config.auth || !config.auth.token || config.auth.funnel === true) {
    config.auth = {
      token: minted.credential.plaintextToken,
      is_api_token: false,
      funnel: true,
      expires_at: minted.credential.expiresAt,
    };
    return { config, bridgeAuthorized: true };
  }
  return { config, bridgeAuthorized: false };
}

export async function mintViaApi({ apiUrl, description, surface, fetchFn }) {
  const response = await fetchFn(`${apiUrl}/api/launch/funnel/handoffs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, surface }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success !== true) {
    const message = body && typeof body.error === 'string'
      ? body.error
      : `mint failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

export async function resumeViaApi({ apiUrl, pairingCode, fetchFn }) {
  const response = await fetchFn(
    `${apiUrl}/api/launch/funnel/pairings/${encodeURIComponent(pairingCode)}/resume`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success !== true) {
    const message = body && typeof body.error === 'string'
      ? body.error
      : `resume failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

export async function readPairingViaApi({ apiUrl, pairingCode, fetchFn }) {
  const response = await fetchFn(
    `${apiUrl}/api/launch/funnel/pairings/${encodeURIComponent(pairingCode)}`,
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.success !== true) return null;
  return body.pairing;
}

/**
 * Watch loop: mirror stage transitions as terminal lines until the build
 * uploads (or the watcher is asked to stop). `sleep` and `fetchFn` are
 * injected; the loop never throws on transient read failures.
 */
export async function watchPairing({
  apiUrl,
  pairingCode,
  fetchFn,
  log,
  sleep,
  maxTicks = Infinity,
}) {
  let previous = null;
  let ticks = 0;
  while (ticks < maxTicks) {
    ticks += 1;
    const pairing = await readPairingViaApi({ apiUrl, pairingCode, fetchFn });
    if (pairing) {
      for (const line of describeStageChange(previous, pairing)) {
        log(`  ✓ ${line}`);
      }
      previous = pairing;
      if (pairing.uploadedAt || pairing.claimed) {
        log(`Build is ready to claim — open ${apiUrl.includes('localhost') ? '' : 'https://connectgalactic.com'}/b/${pairingCode}`);
        return previous;
      }
    }
    await sleep(FUNNEL_WATCH_INTERVAL_MS);
  }
  return previous;
}
