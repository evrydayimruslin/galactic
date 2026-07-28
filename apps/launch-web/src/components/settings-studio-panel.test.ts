import { describe, expect, it } from 'vitest';

import type { LaunchApiKeySummary } from '../../../../shared/contracts/launch';
import {
  settingsKeyIsIdle,
  settingsPageFromPane,
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
