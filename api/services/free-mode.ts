// Free Mode predicates (docs/FREE_MODE_DESIGN.md). Leaf module — depends only on
// env + manifest helpers, so both the execution path and the inference route can
// import it without a cycle.

import type { AppManifest } from '../../shared/contracts/manifest.ts';
import type { App } from '../../shared/types/index.ts';
import { getCallPriceLight } from '../../shared/types/index.ts';
import { getEnv } from '../lib/env.ts';
import { getManifestPermissions } from './trust.ts';
import { parseAppManifest } from './app-settings.ts';

/**
 * Master switch for Free Mode *enforcement*. Default OFF — the gates are inert
 * until enabled, so Phase 1 ships dark. The economic-state signals and the
 * uses_inference flag (Phase 0) are always computed; this flag only governs
 * whether the paid-call and AI gates actually block.
 */
export function isFreeModeEnabled(): boolean {
  const raw = (getEnv('FREE_MODE') || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * Whether a function uses inference (galactic.ai()), for the Free Mode AI gate.
 * Reads the upload-derived per-function `uses_inference` flag. Conservative
 * backfill: if the app declares `ai:call` but a function carries no explicit
 * flag (manifest predates Phase 0), treat it as inference. Apps that don't
 * declare `ai:call` cannot run inference at all — the runtime AI binding is
 * gated on that permission — so they are always false.
 */
export function functionUsesInference(
  manifest: AppManifest | string | null | undefined,
  functionName: string,
): boolean {
  if (!getManifestPermissions(manifest).includes('ai:call')) return false;
  const fn = parseAppManifest(manifest)?.functions?.[functionName];
  if (typeof fn?.uses_inference === 'boolean') return fn.uses_inference;
  return true;
}

type FreeModeApp = Pick<App, 'pricing_config' | 'manifest' | 'owner_id'>;

/**
 * Whether a free-mode caller would be blocked from calling this function — the
 * discovery-filter mirror of the Phase 1 execution gates. Hide it from
 * tools/list / inspect if it's paid (list price > 0) or an inference function
 * without a BYOK key. Self-calls (the owner) are never hidden. Until the Phase 3
 * peek RPC, a priced function with a free-call allowance is treated as paid
 * (hidden in discovery, still callable + honored at execution — the safe gap).
 */
export function isFunctionBlockedInFreeMode(
  app: FreeModeApp,
  functionName: string,
  caller: { userId: string; byokPresent: boolean },
): boolean {
  if (caller.userId === app.owner_id) return false;
  if (getCallPriceLight(app.pricing_config, functionName) > 0) return true;
  if (!caller.byokPresent && functionUsesInference(app.manifest, functionName)) {
    return true;
  }
  return false;
}

/**
 * The agent-facing Free Mode notice (D-tell). Prepended to the platform docs and
 * inspect output so a connected agent knows why paid/AI tools vanished and what
 * to tell the user. Dollars only — never leak the internal Light unit.
 */
export function freeModeNotice(topUpUrl: string): string {
  return [
    '> ⚠️ **Free mode is active** — the wallet balance is under $0.25.',
    '> Paid functions are hidden from your tool list, and AI functions are',
    '> unavailable without a BYOK key; calling a blocked function is refused.',
    '> Only free functions run. To restore full access, tell the user to add',
    `> credits at ${topUpUrl} (or add a BYOK provider key in Settings).`,
  ].join('\n');
}
