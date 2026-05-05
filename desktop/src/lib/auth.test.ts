import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDesktopEmbedUrl,
  buildDesktopLoginUrl,
  requestDesktopEmbedBridgeToken,
} from './auth';

describe('desktop auth helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the desktop OAuth login URL with the polling parameters', () => {
    const url = new URL(buildDesktopLoginUrl(
      'https://ultralight-api.rgn4jz429m.workers.dev',
      'session-123',
      'secret-hash',
    ));

    expect(url.origin).toBe('https://ultralight-api.rgn4jz429m.workers.dev');
    expect(url.pathname).toBe('/auth/login');
    expect(url.searchParams.get('desktop_session')).toBe('session-123');
    expect(url.searchParams.get('desktop_poll_secret_hash')).toBe('secret-hash');
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  it('requests account selection for the switch-account flow', () => {
    const url = new URL(buildDesktopLoginUrl(
      'https://ultralight-api-staging.rgn4jz429m.workers.dev',
      'session-abc',
      'hash-xyz',
      { forceAccountSelection: true },
    ));

    expect(url.origin).toBe('https://ultralight-api-staging.rgn4jz429m.workers.dev');
    expect(url.searchParams.get('prompt')).toBe('select_account');
  });

  it('builds desktop embed URLs with a bridge token fragment', () => {
    const url = new URL(buildDesktopEmbedUrl(
      'https://ultralight-api.rgn4jz429m.workers.dev',
      '/settings',
      'ul_embed_abc123',
      42,
    ));

    expect(url.origin).toBe('https://ultralight-api.rgn4jz429m.workers.dev');
    expect(url.pathname).toBe('/settings');
    expect(url.searchParams.get('embed')).toBe('1');
    expect(url.searchParams.get('_v')).toBe('42');
    expect(url.searchParams.get('token')).toBeNull();
    expect(url.hash).toBe('#bridge_token=ul_embed_abc123');
  });

  it('requests a desktop embed bridge token from the auth endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      bridge_token: 'ul_embed_issued',
      expires_in: 60,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const session = await requestDesktopEmbedBridgeToken(
      'https://ultralight-api.rgn4jz429m.workers.dev',
      'jwt-token',
    );

    expect(session).toEqual({
      bridgeToken: 'ul_embed_issued',
      expiresIn: 60,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/auth/embed/bridge', 'https://ultralight-api.rgn4jz429m.workers.dev'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
});
