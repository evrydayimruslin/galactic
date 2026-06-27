// Canonical URL helpers.
//
// Single source of truth for the public base URL. Used by share links,
// OpenGraph tags, email templates, deep-link fallbacks, and anywhere we
// need to generate a user-facing link to the platform.
//
// When a vanity domain lands, change CANONICAL_BASE and every consumer
// updates in lockstep — no scattering of hardcoded URLs across handlers.

export const CANONICAL_BASE = 'https://api.ultralightagent.com';

/** The launch-web site origin (the root domain — the API lives on `api.`). */
export const SITE_BASE = CANONICAL_BASE.replace('://api.', '://');

/** Wallet / account page where a user adds credits (Free Mode top-up link). */
export function walletUrl(): string {
  return `${SITE_BASE}/account`;
}

/** Canonical public store page URL for an app (by id or slug). */
export function appStoreUrl(idOrSlug: string): string {
  return `${CANONICAL_BASE}/app/${idOrSlug}`;
}

/** Canonical download page URL, optionally with a pending-install hint. */
export function downloadUrl(opts: { app?: string } = {}): string {
  const qs = opts.app ? `?app=${encodeURIComponent(opts.app)}` : '';
  return `${CANONICAL_BASE}/download${qs}`;
}

/** Canonical deep-link URL for opening a page inside the desktop app. */
export function deepLinkAppUrl(appId: string, opts: { refClaim?: string | null } = {}): string {
  const qs = opts.refClaim ? `?ref_claim=${encodeURIComponent(opts.refClaim)}` : '';
  return `galactic://app/${appId}${qs}`;
}
