import { describe, expect, it } from 'vitest';
import { resolveDesktopEnvironment } from './environment';

describe('resolveDesktopEnvironment', () => {
  it('defaults production builds to the production API base', () => {
    expect(resolveDesktopEnvironment({ PROD: true })).toEqual({
      environment: 'production',
      apiBase: 'https://ultralight-api.rgn4jz429m.workers.dev',
    });
  });

  it('uses the staging API base for staging builds', () => {
    expect(resolveDesktopEnvironment({ PROD: true, VITE_UL_ENVIRONMENT: 'staging' })).toEqual({
      environment: 'staging',
      apiBase: 'https://ultralight-api-staging.rgn4jz429m.workers.dev',
    });
  });

  it('allows development builds to override the API base explicitly', () => {
    expect(resolveDesktopEnvironment({
      DEV: true,
      VITE_UL_ENVIRONMENT: 'development',
      VITE_UL_API_BASE: 'http://localhost:8787',
    })).toEqual({
      environment: 'development',
      apiBase: 'http://localhost:8787',
    });
  });

  it('defaults development builds to the direct worker API base', () => {
    expect(resolveDesktopEnvironment({
      DEV: true,
      VITE_UL_ENVIRONMENT: 'development',
    })).toEqual({
      environment: 'development',
      apiBase: 'https://ultralight-api.rgn4jz429m.workers.dev',
    });
  });

  it('rejects unsupported environment labels', () => {
    expect(() => resolveDesktopEnvironment({
      VITE_UL_ENVIRONMENT: 'preview',
    })).toThrow(/Unsupported VITE_UL_ENVIRONMENT/);
  });

  it('rejects prod and staging builds that point at the wrong backend', () => {
    expect(() => resolveDesktopEnvironment({
      PROD: true,
      VITE_UL_ENVIRONMENT: 'production',
      VITE_UL_API_BASE: 'https://ultralight-api-staging.rgn4jz429m.workers.dev',
    })).toThrow(/production builds must use https:\/\/ultralight-api\.rgn4jz429m\.workers\.dev/);
  });
});
