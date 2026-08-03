import { describe, expect, it } from 'vitest';

import type {
  LaunchApiKeySummary,
  LaunchSubscriptionResponse,
} from '../../../../shared/contracts/launch';
import {
  settingsKeyIsIdle,
  settingsPageFromPane,
  subscriptionValue,
} from './settings-studio-panel';

function key(
  createdAt: string,
  lastUsedAt: string | null = null,
): LaunchApiKeySummary {
  return {
    createdAt,
    expiresAt: null,
    id: 'key_test',
    lastUsedAt,
    name: 'Test key',
    scopes: ['apps:read'],
    tokenPrefix: 'gx_test_',
  };
}

describe('settings studio routes', () => {
  it.each([
    [null, 'root'],
    ['', 'root'],
    ['unknown', 'root'],
    ['keys', 'keys'],
    ['providers', 'providers'],
    ['byok', 'providers'],
    ['shortcuts', 'shortcuts'],
  ] as const)('maps pane %s to %s', (pane, page) => {
    expect(settingsPageFromPane(pane)).toBe(page);
  });
});

describe('idle Galactic Keys', () => {
  const now = Date.parse('2026-07-28T12:00:00.000Z');

  it('uses last-used time when a key has been used', () => {
    expect(settingsKeyIsIdle(
      key('2025-01-01T00:00:00.000Z', '2026-07-20T12:00:00.000Z'),
      now,
    )).toBe(false);
    expect(settingsKeyIsIdle(
      key('2026-07-20T12:00:00.000Z', '2026-06-01T12:00:00.000Z'),
      now,
    )).toBe(true);
  });

  it('falls back to creation time for unused keys', () => {
    expect(settingsKeyIsIdle(key('2026-07-20T12:00:00.000Z'), now))
      .toBe(false);
    expect(settingsKeyIsIdle(key('2026-06-01T12:00:00.000Z'), now))
      .toBe(true);
  });

  it('does not classify invalid timestamps as idle', () => {
    expect(settingsKeyIsIdle(key('not-a-date'), now)).toBe(false);
  });
});

describe('membership row value', () => {
  function subscription(
    overrides: Partial<LaunchSubscriptionResponse> = {},
  ): LaunchSubscriptionResponse {
    return {
      plan: 'pro',
      planName: 'Pro',
      priceCents: 2000,
      currency: 'usd',
      interval: 'month',
      status: 'active',
      currentPeriodEnd: '2026-08-16T07:00:00.000Z',
      cancelAtPeriodEnd: false,
      hasActiveSubscription: true,
      canSubscribe: false,
      canManage: true,
      capacity: {
        plan: 'pro',
        state: 'available',
        weekly: {
          state: 'available',
          resetsAt: '2026-08-05T02:50:00.000Z',
          usedPercent: 14,
        },
        nextEligibleAt: null,
        activeAgentLimit: null,
        generatedAt: '2026-08-03T00:00:00.000Z',
      },
      generatedAt: '2026-08-03T00:00:00.000Z',
      ...overrides,
    };
  }

  it('shows the full renewal date without a price', () => {
    const value = subscriptionValue(subscription());
    expect(value).toBe('renews August 16, 2026');
    expect(value).not.toContain('$');
  });

  it('says ends instead of renews when cancellation is pending', () => {
    expect(subscriptionValue(subscription({ cancelAtPeriodEnd: true })))
      .toBe('ends August 16, 2026');
  });

  it('asks for a subscription when none is active', () => {
    expect(subscriptionValue(subscription({
      hasActiveSubscription: false,
      status: 'inactive',
      currentPeriodEnd: null,
    }))).toBe('subscription required');
  });

  it('stays quiet while the subscription is loading', () => {
    expect(subscriptionValue(undefined)).toBe('Loading…');
  });

  it('reports an active term without a boundary date', () => {
    expect(subscriptionValue(subscription({ currentPeriodEnd: null })))
      .toBe('active');
  });
});
