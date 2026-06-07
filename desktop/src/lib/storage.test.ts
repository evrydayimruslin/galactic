import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => {
      store.clear();
    }),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
  } as Storage;
}

describe('secure desktop storage', () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    vi.stubGlobal('localStorage', createLocalStorageMock());
  });

  it('hydrates from secure storage and clears any legacy token copy', async () => {
    localStorage.setItem('ul_token', 'legacy-token');
    localStorage.setItem('ul_api_base', 'https://ultralight-api-staging.rgn4jz429m.workers.dev');
    invokeMock.mockResolvedValueOnce('secure-token');

    const storage = await import('./storage');
    await storage.hydrateSecureStorage();

    expect(storage.getToken()).toBe('secure-token');
    expect(localStorage.getItem('ul_token')).toBeNull();
    expect(localStorage.getItem('ul_api_base')).toBeNull();
    expect(localStorage.getItem('ul_auth_storage_migrated_v1')).toBe('1');
    expect(invokeMock).toHaveBeenCalledWith('secure_get_auth_token');
  });

  it('migrates a legacy localStorage token into secure storage once and records completion', async () => {
    localStorage.setItem('ul_token', 'legacy-token');
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(undefined);

    const storage = await import('./storage');
    await storage.hydrateSecureStorage();

    expect(storage.getToken()).toBe('legacy-token');
    expect(localStorage.getItem('ul_token')).toBeNull();
    expect(localStorage.getItem('ul_auth_storage_migrated_v1')).toBe('1');
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'secure_get_auth_token');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'secure_set_auth_token', {
      token: 'legacy-token',
    });
  });

  it('does not re-import a legacy localStorage token after the migration marker is set', async () => {
    localStorage.setItem('ul_auth_storage_migrated_v1', '1');
    localStorage.setItem('ul_token', 'stale-legacy-token');
    invokeMock.mockResolvedValueOnce(null);

    const storage = await import('./storage');
    await storage.hydrateSecureStorage();

    expect(storage.getToken()).toBeNull();
    expect(localStorage.getItem('ul_token')).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('secure_get_auth_token');
  });

  it('writes and clears tokens through secure storage after hydration', async () => {
    invokeMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const storage = await import('./storage');
    await storage.hydrateSecureStorage();
    await storage.setToken('fresh-token');
    await storage.clearToken();

    expect(storage.getToken()).toBeNull();
    expect(localStorage.getItem('ul_auth_storage_migrated_v1')).toBe('1');
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'secure_get_auth_token');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'secure_set_auth_token', {
      token: 'fresh-token',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'secure_clear_auth_token');
  });

  it('uses DeepSeek defaults for chat, interpreter, and heavy model slots', async () => {
    const storage = await import('./storage');

    expect(storage.getModel()).toBe('deepseek/deepseek-v4-flash');
    expect(storage.getInterpreterModel()).toBe('deepseek/deepseek-v4-flash');
    expect(storage.getHeavyModel()).toBe('deepseek/deepseek-v4-pro');
  });

  it('persists and validates inference route preferences', async () => {
    const storage = await import('./storage');

    storage.setInferencePreference({
      billingMode: 'byok',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      webSearchEnabled: true,
    });

    expect(storage.getInferencePreference()).toEqual({
      billingMode: 'byok',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      webSearchEnabled: true,
    });

    localStorage.setItem('ul_inference_preference', JSON.stringify({
      billingMode: 'byok',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    }));

    expect(storage.getInferencePreference()).toBeNull();
    expect(localStorage.getItem('ul_inference_preference')).toBeNull();

    localStorage.setItem('ul_inference_preference', '{bad json');
    expect(storage.getInferencePreference()).toBeNull();
    expect(localStorage.getItem('ul_inference_preference')).toBeNull();
  });
});
