import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  claimReferralToken: vi.fn(),
}));

import { parseDeepLink } from './useDeepLink';

describe('parseDeepLink', () => {
  it('preserves referral claim tokens on app deep links', () => {
    expect(parseDeepLink('ultralight://app/app-123?ref_claim=token.payload')).toEqual({
      kind: 'tool-detail',
      appId: 'app-123',
      referralClaimToken: 'token.payload',
    });
  });

  it('parses plain app deep links without referral state', () => {
    expect(parseDeepLink('ultralight://app/app-123')).toEqual({
      kind: 'tool-detail',
      appId: 'app-123',
      referralClaimToken: undefined,
    });
  });
});
