// Free Mode predicates (docs/FREE_MODE_DESIGN.md). Leaf module — depends only on
// env + manifest helpers, so both the execution path and the inference route can
// import it without a cycle.

import type { AppManifest } from '../../shared/contracts/manifest.ts';
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
