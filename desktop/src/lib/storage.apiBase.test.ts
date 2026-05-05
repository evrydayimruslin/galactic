import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('./environment', () => ({
  DESKTOP_API_BASE: 'https://ultralight-api.rgn4jz429m.workers.dev',
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

describe('desktop api base failover', () => {
  beforeEach(() => {
    vi.resetModules();
    invokeMock.mockReset();
    vi.stubGlobal('localStorage', createLocalStorageMock());
  });

  it('keeps the direct worker base when health checks pass', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const storage = await import('./storage');
    const base = await storage.ensureApiBaseAvailable();

    expect(base).toBe('https://ultralight-api.rgn4jz429m.workers.dev');
    expect(storage.getApiBase()).toBe('https://ultralight-api.rgn4jz429m.workers.dev');
    expect(localStorage.getItem('ul_runtime_api_base')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ultralight-api.rgn4jz429m.workers.dev/health',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('does not retry requests when the direct worker origin succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const storage = await import('./storage');
    const response = await storage.fetchFromApi('/chat/models', {
      headers: { Accept: 'application/json' },
    });

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ ok: true });
    expect(storage.getApiBase()).toBe('https://ultralight-api.rgn4jz429m.workers.dev');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://ultralight-api.rgn4jz429m.workers.dev/chat/models',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });
});
