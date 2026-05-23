// BYOK provider key store + verify probe.
//
// Backs B16. Keys live in the OS keychain (one entry per provider) via
// the secure_get_secret / secure_set_secret / secure_clear_secret Tauri
// commands we added in src-tauri/src/secure_storage.rs. We diverged from
// the addendum's `~/.ultralight/byok.json chmod 600` filesystem
// suggestion because the OS keychain is strictly more secure on macOS /
// Windows / Linux and we already use it for the auth token — adding
// another file-on-disk surface would have been a regression.
//
// Verify-on-save hits each provider's `/v1/models` endpoint directly
// from the desktop process. CSP additions for the four hostnames live in
// desktop/src-tauri/tauri.conf.json.

import { invoke } from '@tauri-apps/api/core';

// ── Provider registry ────────────────────────────────────────────────

export type BYOKProvider = 'anthropic' | 'openai' | 'openrouter' | 'deepseek';

export interface BYOKProviderInfo {
  id: BYOKProvider;
  name: string;
  /** One-line tagline shown when no key is configured. */
  tagline: string;
  /** Single-letter monogram for the row glyph. */
  glyph: string;
  /** Brand-ish tone. Data, not a design token (per Glyph convention). */
  tone: string;
  /** Expected prefix on the API key — used both for placeholder text and
   *  as a sanity check on the masked-display fallback when the BE has a
   *  cached key but the keychain doesn't (shouldn't happen, but keeps
   *  the UI from rendering a partial mask). */
  keyPrefix: string;
  /** Account name passed to the Tauri secure_storage commands. Allowlisted
   *  on the Rust side. */
  account: string;
  /** Probe URL hit on verify-on-save. */
  probeUrl: string;
  /** Header carrying the key on the probe request. */
  authHeader: 'Authorization' | 'x-api-key';
  /** Strategy for forming the auth value:
   *    'bearer' → `Authorization: Bearer ${key}`
   *    'raw'    → `x-api-key: ${key}`  (Anthropic's convention) */
  authStrategy: 'bearer' | 'raw';
  /** Anthropic also requires `anthropic-version` on every request. */
  extraHeaders?: Record<string, string>;
  /** Desktop-only capability hints for UI features that may use the key directly. */
  capabilities: {
    verify: boolean;
    realtime: boolean;
  };
}

export const BYOK_PROVIDERS: BYOKProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    tagline: 'Claude family',
    glyph: 'A',
    tone: '#C8642C',
    keyPrefix: 'sk-ant-',
    account: 'byok_anthropic',
    probeUrl: 'https://api.anthropic.com/v1/models',
    authHeader: 'x-api-key',
    authStrategy: 'raw',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    capabilities: { verify: true, realtime: false },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    tagline: 'GPT models',
    glyph: 'O',
    tone: '#0a0a0a',
    keyPrefix: 'sk-',
    account: 'byok_openai',
    probeUrl: 'https://api.openai.com/v1/models',
    authHeader: 'Authorization',
    authStrategy: 'bearer',
    capabilities: { verify: true, realtime: true },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    tagline: '200+ models, one bill',
    glyph: 'R',
    tone: '#7c3aed',
    keyPrefix: 'sk-or-',
    account: 'byok_openrouter',
    probeUrl: 'https://openrouter.ai/api/v1/models',
    authHeader: 'Authorization',
    authStrategy: 'bearer',
    capabilities: { verify: true, realtime: false },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    tagline: 'DeepSeek-V3, R1',
    glyph: 'D',
    tone: '#1f6feb',
    keyPrefix: 'sk-',
    account: 'byok_deepseek',
    probeUrl: 'https://api.deepseek.com/v1/models',
    authHeader: 'Authorization',
    authStrategy: 'bearer',
    capabilities: { verify: true, realtime: false },
  },
];

export function findProvider(id: BYOKProvider): BYOKProviderInfo {
  const p = BYOK_PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown BYOK provider: ${id}`);
  return p;
}

// ── Keychain wrappers ────────────────────────────────────────────────

export async function getBYOKKey(provider: BYOKProvider): Promise<string | null> {
  const info = findProvider(provider);
  try {
    return await invoke<string | null>('secure_get_secret', { account: info.account });
  } catch {
    // Keychain access failures usually mean the user denied the prompt;
    // surface as "no key" so the UI shows the empty-state CTA.
    return null;
  }
}

export async function setBYOKKey(provider: BYOKProvider, value: string): Promise<void> {
  const info = findProvider(provider);
  await invoke('secure_set_secret', { account: info.account, value });
}

export async function clearBYOKKey(provider: BYOKProvider): Promise<void> {
  const info = findProvider(provider);
  await invoke('secure_clear_secret', { account: info.account });
}

// ── Verify-on-save ───────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean;
  /** HTTP status from the probe, when one was received. */
  status?: number;
  /** Human-readable message for inline display below the input. */
  message?: string;
}

export async function verifyBYOKKey(
  provider: BYOKProvider,
  key: string,
): Promise<VerifyResult> {
  const info = findProvider(provider);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(info.extraHeaders ?? {}),
  };
  headers[info.authHeader] =
    info.authStrategy === 'bearer' ? `Bearer ${key}` : key;

  try {
    const res = await fetch(info.probeUrl, { method: 'GET', headers });
    if (res.ok) return { ok: true, status: res.status };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        message: `That key didn't authenticate against ${info.name}. Check it and try again.`,
      };
    }
    return {
      ok: false,
      status: res.status,
      message: `Verification failed (${res.status}). Check your key and network.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error
        ? `Couldn't reach ${info.name}: ${err.message}`
        : `Couldn't reach ${info.name}.`,
    };
  }
}

// ── Display helpers ──────────────────────────────────────────────────

/** Format a raw key value as the spec's masked form:
 *  first 7 chars + 13 bullets + last 4 chars (e.g. `sk-ant-•••••••••••••a9c4`).
 *  Shorter keys collapse to "•••" so we never accidentally expose more
 *  than the safe head + tail. */
export function maskBYOKKey(value: string): string {
  if (value.length < 12) return '•••';
  return value.slice(0, 7) + '•••••••••••••' + value.slice(-4);
}
