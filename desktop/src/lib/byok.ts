// Server-backed BYOK provider configuration.
//
// Keys are stored and encrypted by the API service in users.byok_keys. The
// desktop app never receives plaintext keys after save; it only sends new keys
// to /api/user/byok for validation + encryption.

import type {
  ActiveBYOKProvider,
  BYOKConfig,
  BYOKProviderInfo as SharedBYOKProviderInfo,
} from '../../../shared/types/index.ts';
import { fetchFromApi, getToken } from './storage';

export type BYOKProvider = ActiveBYOKProvider;

export interface BYOKProviderInfo extends SharedBYOKProviderInfo {
  tagline: string;
  glyph: string;
  tone: string;
  keyPrefix: string;
}

export interface BYOKStatusResponse {
  enabled: boolean;
  primary_provider: ActiveBYOKProvider | null;
  configs: BYOKConfig[];
  available_providers: SharedBYOKProviderInfo[];
}

export interface BYOKMutationResponse {
  success: boolean;
  config?: BYOKConfig;
  message?: string;
}

const PROVIDER_TONES: Partial<Record<ActiveBYOKProvider, string>> = {
  openrouter: '#7c3aed',
  openai: '#0a0a0a',
  deepseek: '#1f6feb',
  nvidia: '#16a34a',
  google: '#2563eb',
  xai: '#111827',
};

function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) {
    throw new Error('Sign in before configuring BYOK providers.');
  }
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function providerGlyph(provider: SharedBYOKProviderInfo): string {
  if (provider.id === 'openrouter') return 'R';
  if (provider.id === 'openai') return 'O';
  if (provider.id === 'deepseek') return 'D';
  if (provider.id === 'nvidia') return 'N';
  if (provider.id === 'google') return 'G';
  if (provider.id === 'xai') return 'X';
  return provider.name.charAt(0).toUpperCase();
}

export function decorateBYOKProvider(provider: SharedBYOKProviderInfo): BYOKProviderInfo {
  return {
    ...provider,
    tagline: provider.description,
    glyph: providerGlyph(provider),
    tone: PROVIDER_TONES[provider.id] ?? '#6b7280',
    keyPrefix: provider.apiKeyPrefix ?? '',
  };
}

async function readJsonOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return await res.json() as T;

  let message = `Request failed (${res.status})`;
  try {
    const body = await res.json() as { error?: string; detail?: string; message?: string };
    message = body.error || body.detail || body.message || message;
  } catch {
    try {
      message = await res.text() || message;
    } catch {
      // Keep the generic status message.
    }
  }
  throw new Error(message);
}

export async function fetchBYOKConfig(): Promise<BYOKStatusResponse> {
  const res = await fetchFromApi('/api/user/byok', {
    headers: authHeaders(),
  });
  return readJsonOrThrow<BYOKStatusResponse>(res);
}

export async function saveBYOKKey(
  provider: BYOKProvider,
  apiKey: string,
  model?: string,
  validate = true,
): Promise<BYOKMutationResponse> {
  const res = await fetchFromApi('/api/user/byok', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      provider,
      api_key: apiKey,
      ...(model ? { model } : {}),
      validate,
    }),
  });
  return readJsonOrThrow<BYOKMutationResponse>(res);
}

export async function updateBYOKProvider(
  provider: BYOKProvider,
  updates: { apiKey?: string; model?: string; validate?: boolean },
): Promise<BYOKMutationResponse> {
  const res = await fetchFromApi(`/api/user/byok/${encodeURIComponent(provider)}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({
      ...(updates.apiKey ? { api_key: updates.apiKey } : {}),
      ...(updates.model !== undefined ? { model: updates.model } : {}),
      validate: updates.validate ?? true,
    }),
  });
  return readJsonOrThrow<BYOKMutationResponse>(res);
}

export async function clearBYOKKey(provider: BYOKProvider): Promise<void> {
  const res = await fetchFromApi(`/api/user/byok/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  await readJsonOrThrow<BYOKMutationResponse>(res);
}

export async function setPrimaryBYOKProvider(provider: BYOKProvider): Promise<void> {
  const res = await fetchFromApi('/api/user/byok/primary', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ provider }),
  });
  await readJsonOrThrow<BYOKMutationResponse>(res);
}
