// Desktop storage wrapper for auth token and preferences.
// Long-lived auth tokens live in the OS keychain; non-secret prefs stay in localStorage.
// The primary API base is build-pinned via src/lib/environment.ts. Legacy builds
// can still fail over when the old vanity domain is misrouted at the edge.

import { invoke } from '@tauri-apps/api/core';
import type { InferenceRoutePreference } from '../../../shared/contracts/ai.ts';
import { isActiveBYOKProvider } from '../../../shared/types/index.ts';
import { DESKTOP_API_BASE } from './environment';
import { createDesktopLogger } from './logging';

const STORAGE_KEYS = {
  token: 'ul_token',
  model: 'ul_model',
  interpreterModel: 'ul_interpreter_model',
  heavyModel: 'ul_heavy_model',
  inferencePreference: 'ul_inference_preference',
  autoApproveLight: 'ul_auto_approve_light',
  onboardingComplete: 'ul_onboarding_complete',
} as const;

export const DEFAULT_INTERPRETER_MODEL = 'deepseek/deepseek-v4-flash';
export const DEFAULT_HEAVY_MODEL = 'deepseek/deepseek-v4-pro';
export const DEFAULT_CHAT_MODEL = DEFAULT_INTERPRETER_MODEL;

const LEGACY_API_BASE_STORAGE_KEY = 'ul_api_base';
const RUNTIME_API_BASE_STORAGE_KEY = 'ul_runtime_api_base';
const AUTH_STORAGE_MIGRATION_MARKER = 'ul_auth_storage_migrated_v1';
const SECURE_STORAGE_COMMANDS = {
  get: 'secure_get_auth_token',
  set: 'secure_set_auth_token',
  clear: 'secure_clear_auth_token',
} as const;
const API_BASE_FAILOVERS: Record<string, string[]> = {
  'https://api.ultralight.dev': ['https://ultralight-api.rgn4jz429m.workers.dev'],
};
const API_HEALTHCHECK_TIMEOUT_MS = 2500;

let cachedToken: string | null = null;
let hydratePromise: Promise<void> | null = null;
let apiBaseProbePromise: Promise<string> | null = null;
const storageLogger = createDesktopLogger('storage');

const KNOWN_API_BASES = Array.from(new Set([
  DESKTOP_API_BASE,
  ...(API_BASE_FAILOVERS[DESKTOP_API_BASE] || []),
]));

function readRuntimeApiBase(): string {
  try {
    const stored = localStorage.getItem(RUNTIME_API_BASE_STORAGE_KEY);
    if (stored && KNOWN_API_BASES.includes(stored)) {
      return stored;
    }
    if (stored) {
      localStorage.removeItem(RUNTIME_API_BASE_STORAGE_KEY);
    }
  } catch {
    // Ignore localStorage access errors and fall back to the build-pinned base.
  }

  return DESKTOP_API_BASE;
}

let cachedApiBase = readRuntimeApiBase();

function hasCompletedAuthStorageMigration(): boolean {
  try {
    return localStorage.getItem(AUTH_STORAGE_MIGRATION_MARKER) === '1';
  } catch {
    return false;
  }
}

function markAuthStorageMigrationComplete(): void {
  try {
    localStorage.setItem(AUTH_STORAGE_MIGRATION_MARKER, '1');
  } catch {
    // Ignore localStorage access errors; secure storage remains canonical.
  }
}

function secureStorageError(action: 'load' | 'save' | 'clear', error: unknown): Error {
  storageLogger.error('Failed to access secure auth token storage', { action, error });

  switch (action) {
    case 'load':
      return new Error('Unable to access secure desktop sign-in storage.');
    case 'save':
      return new Error('Unable to save your sign-in token securely on this device.');
    case 'clear':
      return new Error('Unable to clear your saved sign-in token securely.');
  }
}

async function readSecureToken(): Promise<string | null> {
  try {
    return await invoke<string | null>(SECURE_STORAGE_COMMANDS.get);
  } catch (error) {
    throw secureStorageError('load', error);
  }
}

async function writeSecureToken(token: string): Promise<void> {
  try {
    await invoke(SECURE_STORAGE_COMMANDS.set, { token });
  } catch (error) {
    throw secureStorageError('save', error);
  }
}

async function removeSecureToken(): Promise<void> {
  try {
    await invoke(SECURE_STORAGE_COMMANDS.clear);
  } catch (error) {
    throw secureStorageError('clear', error);
  }
}

async function awaitHydration(): Promise<void> {
  if (hydratePromise) {
    await hydratePromise;
  }
}

function persistRuntimeApiBase(base: string): void {
  cachedApiBase = base;

  try {
    if (base === DESKTOP_API_BASE) {
      localStorage.removeItem(RUNTIME_API_BASE_STORAGE_KEY);
    } else {
      localStorage.setItem(RUNTIME_API_BASE_STORAGE_KEY, base);
    }
  } catch {
    // Ignore localStorage access errors; in-memory failover is still useful.
  }
}

function buildApiUrl(base: string, path: string): string {
  return new URL(path, base).toString();
}

function shouldRetryAgainstFailover(response: Response): boolean {
  const server = response.headers.get('server')?.toLowerCase() || '';
  const xCache = response.headers.get('x-cache')?.toLowerCase() || '';
  const isEdgeFailure = server.includes('cloudfront') || xCache.includes('error from cloudfront');

  return isEdgeFailure && (response.status === 403 || response.status >= 500);
}

async function probeApiBase(base: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_HEALTHCHECK_TIMEOUT_MS);

  try {
    const response = await fetch(buildApiUrl(base, '/health'), {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureApiBaseAvailable(force = false): Promise<string> {
  if (apiBaseProbePromise && !force) {
    return apiBaseProbePromise;
  }

  apiBaseProbePromise = (async () => {
    const candidates = Array.from(new Set([
      DESKTOP_API_BASE,
      cachedApiBase,
      ...KNOWN_API_BASES,
    ]));

    for (const base of candidates) {
      if (await probeApiBase(base)) {
        if (base !== cachedApiBase) {
          storageLogger.warn('Switching desktop API base', { base });
        }
        persistRuntimeApiBase(base);
        return base;
      }
    }

    return cachedApiBase;
  })().finally(() => {
    apiBaseProbePromise = null;
  });

  return apiBaseProbePromise;
}

export async function fetchFromApi(path: string, init?: RequestInit): Promise<Response> {
  const base = await ensureApiBaseAvailable();

  try {
    const response = await fetch(buildApiUrl(base, path), init);
    if (shouldRetryAgainstFailover(response)) {
      const failoverBase = await ensureApiBaseAvailable(true);
      if (failoverBase !== base) {
        return fetch(buildApiUrl(failoverBase, path), init);
      }
    }
    return response;
  } catch (error) {
    const failoverBase = await ensureApiBaseAvailable(true);
    if (failoverBase !== base) {
      return fetch(buildApiUrl(failoverBase, path), init);
    }
    throw error;
  }
}

export async function hydrateSecureStorage(): Promise<void> {
  if (hydratePromise) {
    return hydratePromise;
  }

  hydratePromise = (async () => {
    // Old builds stored the API base in localStorage, which let stale
    // overrides silently point prod desktop builds at the wrong backend.
    localStorage.removeItem(LEGACY_API_BASE_STORAGE_KEY);

    const secureToken = await readSecureToken();
    if (secureToken) {
      cachedToken = secureToken;
      localStorage.removeItem(STORAGE_KEYS.token);
      markAuthStorageMigrationComplete();
      return;
    }

    if (hasCompletedAuthStorageMigration()) {
      cachedToken = null;
      localStorage.removeItem(STORAGE_KEYS.token);
      return;
    }

    const legacyToken = localStorage.getItem(STORAGE_KEYS.token);
    if (!legacyToken) {
      cachedToken = null;
      localStorage.removeItem(STORAGE_KEYS.token);
      markAuthStorageMigrationComplete();
      return;
    }

    await writeSecureToken(legacyToken);
    cachedToken = legacyToken;
    localStorage.removeItem(STORAGE_KEYS.token);
    markAuthStorageMigrationComplete();
  })().catch((error) => {
    hydratePromise = null;
    throw error;
  });

  return hydratePromise;
}

export function getToken(): string | null {
  return cachedToken;
}

export async function setToken(token: string): Promise<void> {
  await awaitHydration();
  await writeSecureToken(token);
  cachedToken = token;
  localStorage.removeItem(STORAGE_KEYS.token);
  markAuthStorageMigrationComplete();
}

export async function clearToken(): Promise<void> {
  await awaitHydration();
  await removeSecureToken();
  cachedToken = null;
  localStorage.removeItem(STORAGE_KEYS.token);
  markAuthStorageMigrationComplete();
}

export function getModel(): string {
  return localStorage.getItem(STORAGE_KEYS.model) || DEFAULT_CHAT_MODEL;
}

export function setModel(model: string): void {
  localStorage.setItem(STORAGE_KEYS.model, model);
}

// Two-model architecture: interpreter (Flash) + heavy
export function getInterpreterModel(): string {
  return localStorage.getItem(STORAGE_KEYS.interpreterModel) || DEFAULT_INTERPRETER_MODEL;
}
export function setInterpreterModel(model: string): void {
  localStorage.setItem(STORAGE_KEYS.interpreterModel, model);
}
export function getHeavyModel(): string {
  return localStorage.getItem(STORAGE_KEYS.heavyModel) || DEFAULT_HEAVY_MODEL;
}
export function setHeavyModel(model: string): void {
  localStorage.setItem(STORAGE_KEYS.heavyModel, model);
}

function coerceInferencePreference(raw: unknown): InferenceRoutePreference | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  const billingMode = candidate.billingMode === 'light' || candidate.billingMode === 'byok'
    ? candidate.billingMode
    : undefined;
  if (candidate.provider !== undefined && !isActiveBYOKProvider(candidate.provider)) {
    return null;
  }
  const provider = isActiveBYOKProvider(candidate.provider) ? candidate.provider : undefined;
  const model = typeof candidate.model === 'string' && candidate.model.trim()
    ? candidate.model.trim()
    : undefined;
  const webSearchEnabled = typeof candidate.webSearchEnabled === 'boolean'
    ? candidate.webSearchEnabled
    : undefined;

  if (!billingMode && !provider && !model && webSearchEnabled === undefined) return null;

  const preference: InferenceRoutePreference = {};
  if (billingMode) preference.billingMode = billingMode;
  if (provider) preference.provider = provider;
  if (model) preference.model = model;
  if (webSearchEnabled !== undefined) preference.webSearchEnabled = webSearchEnabled;
  return preference;
}

function dispatchInferencePreferenceChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('ul-inference-preference-changed'));
}

export function getInferencePreference(): InferenceRoutePreference | null {
  const raw = localStorage.getItem(STORAGE_KEYS.inferencePreference);
  if (!raw) return null;

  try {
    const parsed = coerceInferencePreference(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // Clear malformed preferences and fall back to server-selected routing.
  }

  localStorage.removeItem(STORAGE_KEYS.inferencePreference);
  return null;
}

export function setInferencePreference(preference: InferenceRoutePreference): void {
  const parsed = coerceInferencePreference(preference);
  if (!parsed) {
    localStorage.removeItem(STORAGE_KEYS.inferencePreference);
    dispatchInferencePreferenceChanged();
    return;
  }

  localStorage.setItem(STORAGE_KEYS.inferencePreference, JSON.stringify(parsed));
  dispatchInferencePreferenceChanged();
}

export function clearInferencePreference(): void {
  localStorage.removeItem(STORAGE_KEYS.inferencePreference);
  dispatchInferencePreferenceChanged();
}

export function getApiBase(): string {
  return cachedApiBase;
}

export function getAutoApproveLight(): number {
  const val = localStorage.getItem(STORAGE_KEYS.autoApproveLight);
  return val ? parseFloat(val) : 25; // default ✦25
}

export function setAutoApproveLight(light: number): void {
  localStorage.setItem(STORAGE_KEYS.autoApproveLight, String(light));
}

// Onboarding completion is stored as an ISO timestamp string rather than
// just '1'. Reading code falls back to the legacy boolean form so users
// who completed onboarding in earlier builds aren't re-prompted.
//
// Per DESIGN-FOLLOWUPS E1/E2: localStorage is the right home until/unless
// the BE grows an onboarding_completed_at column on the user profile.
// The timestamp is the foothold for E2 — a future "returning user but
// long-time-no-see" variant can compare it to a freshness window.

export function isOnboardingComplete(): boolean {
  const raw = localStorage.getItem(STORAGE_KEYS.onboardingComplete);
  return raw !== null && raw !== '';
}

export function setOnboardingComplete(): void {
  localStorage.setItem(STORAGE_KEYS.onboardingComplete, new Date().toISOString());
}

export function getOnboardingCompletedAt(): Date | null {
  const raw = localStorage.getItem(STORAGE_KEYS.onboardingComplete);
  if (!raw || raw === '1') return null; // legacy boolean form — no timestamp on record
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resetOnboarding(): void {
  localStorage.removeItem(STORAGE_KEYS.onboardingComplete);
}
