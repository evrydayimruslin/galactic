// Free Mode predicates (docs/FREE_MODE_DESIGN.md). Leaf module — depends only on
// env + manifest helpers, so both the execution path and the inference route can
// import it without a cycle.

import type { AppManifest } from '../../shared/contracts/manifest.ts';
import type { App, AppPricingConfig } from '../../shared/types/index.ts';
import {
  getCallPriceLight,
  getFreeCalls,
  getFreeCallsScope,
} from '../../shared/types/index.ts';
import { getEnv } from '../lib/env.ts';
import { getManifestPermissions } from './trust.ts';
import { parseAppManifest } from './app-settings.ts';

/**
 * A caller's free-allowance counters for one app: counter_key -> call_count.
 * Produced by `peekCallerUsage` (cloud-usage.ts) from the Phase 3 peek RPC and
 * passed into the discovery filter so it can honour remaining free calls.
 */
export type CallerUsage = ReadonlyMap<string, number>;

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
 * Whether the app prices calls through a `module` access policy — dev code that
 * decides the price at call time. We can't classify those cheaply at discovery
 * (it would mean running the sandboxed policy per function), so in Free Mode we
 * hide the whole app's functions. The Phase-1 hold gate still evaluates the
 * module precisely if an agent calls one anyway, so this only affects what's
 * *suggested*, and it fails safe toward blocking.
 */
function hasModuleAccessPolicy(manifest: AppManifest | string | null | undefined): boolean {
  return parseAppManifest(manifest)?.access_policy?.mode === 'module';
}

/**
 * Whether the caller still has free-call allowance left for this function, given
 * their current usage counters (from the Phase 3 peek RPC). The counter key
 * mirrors `getStaticSubjectFreeQuotaCounterKey` (access-policy.ts): the shared
 * `__app__` key for app-scope allowances, else the function name. Without usage
 * data (peek not run, or it failed) we can't prove headroom, so we report none —
 * the conservative Phase-2 behaviour.
 */
function hasFreeAllowanceRemaining(
  pricing: AppPricingConfig | null | undefined,
  functionName: string,
  usage: CallerUsage | null | undefined,
): boolean {
  const limit = getFreeCalls(pricing, functionName);
  if (limit <= 0 || !usage) return false;
  const counterKey = getFreeCallsScope(pricing) === 'app' ? '__app__' : functionName;
  return (usage.get(counterKey) ?? 0) < limit;
}

/**
 * Whether a free-mode caller would be blocked from calling this function — the
 * discovery-filter mirror of the Phase 1 execution gates. Hide it from
 * tools/list / inspect if it's paid (and the caller has no free-call headroom
 * left), priced by a module access policy, or an inference function without a
 * BYOK key. Self-calls (the owner) are never hidden.
 *
 * Pass `usage` (the caller's allowance counters from the Phase 3 peek RPC) to
 * honour remaining free calls: a priced function the caller can still run for
 * free stays visible. Omit it (or pass null) to fall back to the conservative
 * "priced == hidden" behaviour.
 */
export function isFunctionBlockedInFreeMode(
  app: FreeModeApp,
  functionName: string,
  caller: { userId: string; byokPresent: boolean },
  usage?: CallerUsage | null,
): boolean {
  if (caller.userId === app.owner_id) return false;
  if (hasModuleAccessPolicy(app.manifest)) return true;
  if (
    getCallPriceLight(app.pricing_config, functionName) > 0 &&
    !hasFreeAllowanceRemaining(app.pricing_config, functionName, usage)
  ) {
    return true;
  }
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
