import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWidgetNavigationTarget,
  buildWidgetSrcDoc,
  buildWidgetWindowSearchParams,
  coerceWidgetMeta,
  coerceWidgetMetaFromPayload,
  estimateWidgetPullCost,
  fetchWidgetDataPayload,
  getWidgetCacheKey,
  getWidgetPullSettingsStorageKey,
  loadWidgetHtml,
  parseWidgetContextFromSearch,
  parseWidgetSurfaceIdFromSearch,
  parseWidgetSourceFromSearch,
  pruneStaleWidgetCaches,
  readWidgetHtmlCache,
  readWidgetPullSettings,
  updateWidgetPullStats,
  WIDGET_PULL_LIGHT_PER_PULL,
  type WidgetAppSource,
  writeWidgetHtmlCache,
  writeWidgetPullSettings,
} from './widgetRuntime';

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

const baseSource: WidgetAppSource = {
  appUuid: 'app-123',
  appSlug: 'email-ops',
  appName: 'Email Ops',
  appVersion: '5',
  widgetName: 'email_inbox',
  uiFunction: 'widget_email_inbox_ui',
  dataFunction: 'widget_email_inbox_data',
};

describe('widget runtime helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageMock());
  });

  it('reads and writes widget html cache entries with one shared format', () => {
    writeWidgetHtmlCache(
      'app-123',
      'email_inbox',
      '<div>hi</div>',
      '7',
      123,
      { title: 'Inbox', icon: '📥', badge_count: 2 },
    );

    expect(readWidgetHtmlCache('app-123', 'email_inbox')).toEqual({
      html: '<div>hi</div>',
      version: '7',
      cachedAt: 123,
      meta: { title: 'Inbox', icon: '📥', badge_count: 2 },
    });
    expect(readWidgetHtmlCache('app-123', 'email_inbox', '8')).toBeNull();
    expect(localStorage.getItem(getWidgetCacheKey('app-123', 'email_inbox', '7'))).toContain(
      '"version":"7"',
    );
  });

  it('prunes stale widget caches using the shared source inventory', () => {
    writeWidgetHtmlCache('app-123', 'email_inbox', '<div>keep</div>', '5');
    writeWidgetHtmlCache('app-999', 'old_widget', '<div>drop</div>');

    const removed = pruneStaleWidgetCaches([
      { appUuid: 'app-123', widgetName: 'email_inbox', appVersion: '5' },
    ]);

    expect(removed).toEqual([getWidgetCacheKey('app-999', 'old_widget', '1')]);
    expect(readWidgetHtmlCache('app-999', 'old_widget')).toBeNull();
    expect(readWidgetHtmlCache('app-123', 'email_inbox')?.html).toBe('<div>keep</div>');
  });

  it('loads widget html from cache before calling the executor', async () => {
    writeWidgetHtmlCache('app-123', 'email_inbox', '<div>cached</div>', '5');
    const executor = vi.fn();

    const result = await loadWidgetHtml(baseSource, {
      executor: executor as never,
    });

    expect(result).toEqual({
      html: '<div>cached</div>',
      version: '5',
      fromCache: true,
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it('loads widget html fresh and rewrites the shared cache format', async () => {
    const executor = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          app_html: '<div>fresh</div>',
          version: '9',
          meta: { title: 'Inbox', icon: '📥', badge_count: 3 },
        }),
      }],
    });

    const result = await loadWidgetHtml(baseSource, {
      bustCache: true,
      executor,
    });

    expect(result?.html).toBe('<div>fresh</div>');
    expect(result?.fromCache).toBe(false);
    expect(readWidgetHtmlCache('app-123', 'email_inbox')).toEqual({
      html: '<div>fresh</div>',
      version: '9',
      cachedAt: expect.any(Number),
      meta: { title: 'Inbox', icon: '📥', badge_count: 3 },
    });
  });

  it('loads widget data payloads without fetching the html shell', async () => {
    const executor = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({ counts: { active: 4, total: 10 } }),
      }],
    });

    const payload = await fetchWidgetDataPayload(baseSource, executor);

    expect(payload?.raw).toEqual({ counts: { active: 4, total: 10 } });
    expect(executor).toHaveBeenCalledWith('app-123', 'email-ops_widget_email_inbox_data', {});
  });

  it('attaches widget pull metadata to explicit data pulls', async () => {
    const executor = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({ counts: { active: 2 } }),
      }],
    });

    const payload = await fetchWidgetDataPayload(baseSource, executor, {
      widgetName: 'email_inbox',
      intervalMs: 300_000,
      reason: 'scheduled',
    });

    expect(payload?.raw).toEqual({ counts: { active: 2 } });
    expect(executor).toHaveBeenCalledWith(
      'app-123',
      'email-ops_widget_email_inbox_data',
      {},
      {
        widgetPull: {
          widgetName: 'email_inbox',
          intervalMs: 300_000,
          reason: 'scheduled',
        },
      },
    );
  });

  it('passes command card data-view args through widget data pulls', async () => {
    const executor = vi.fn().mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({ card_id: 'inbox_volume', body: { kind: 'metric', metric: 22 } }),
      }],
    });

    const payload = await fetchWidgetDataPayload(
      baseSource,
      executor,
      {
        widgetName: 'email_inbox',
        intervalMs: 300_000,
        reason: 'scheduled',
      },
      { card_id: 'inbox_volume', data_view: 'inbox_volume' },
    );

    expect(payload?.raw).toEqual({ card_id: 'inbox_volume', body: { kind: 'metric', metric: 22 } });
    expect(executor).toHaveBeenCalledWith(
      'app-123',
      'email-ops_widget_email_inbox_data',
      { card_id: 'inbox_volume', data_view: 'inbox_volume' },
      {
        widgetPull: {
          widgetName: 'email_inbox',
          intervalMs: 300_000,
          reason: 'scheduled',
        },
      },
    );
  });

  it('persists widget pull settings and projects fractional Light cost', () => {
    expect(readWidgetPullSettings(baseSource)).toEqual({
      enabled: false,
      intervalMs: 300_000,
      lastPulledAt: null,
      pullCount: 0,
    });

    const enabled = writeWidgetPullSettings(baseSource, {
      enabled: true,
      intervalMs: 60_000,
    });
    expect(enabled.enabled).toBe(true);
    expect(localStorage.getItem(getWidgetPullSettingsStorageKey(baseSource))).toContain(
      '"enabled":true',
    );

    const estimate = estimateWidgetPullCost(enabled);
    expect(estimate.monthlyPulls).toBe(43_200);
    expect(estimate.monthlyLight).toBe(estimate.monthlyPulls * WIDGET_PULL_LIGHT_PER_PULL);

    const pulled = updateWidgetPullStats(baseSource, 123_456);
    expect(pulled.pullCount).toBe(1);
    expect(pulled.lastPulledAt).toBe(123_456);
  });

  it('builds widget navigation targets and shared query params consistently', () => {
    const target = buildWidgetNavigationTarget(baseSource, 'approval_queue');
    const params = buildWidgetWindowSearchParams(target, { thread: 'abc' }, 'surface-123');

    expect(target).toEqual({
      ...baseSource,
      widgetName: 'approval_queue',
      uiFunction: 'widget_approval_queue_ui',
      dataFunction: 'widget_approval_queue_data',
    });
    expect(parseWidgetSourceFromSearch(`?${params.toString()}`)).toEqual(target);
    expect(parseWidgetContextFromSearch(`?${params.toString()}`)).toEqual({ thread: 'abc' });
    expect(parseWidgetSurfaceIdFromSearch(`?${params.toString()}`)).toBe('surface-123');
  });

  it('builds shared widget srcDoc for fullscreen and inline runtimes', () => {
    const fullscreen = buildWidgetSrcDoc({
      appHtml: '<html><head></head><body><div>Hello</div></body></html>',
      appUuid: 'app-123',
      appSlug: 'email-ops',
      widgetName: 'email_inbox',
      apiBase: 'https://api.example.com',
      token: 'secret-token',
      surfaceId: 'surface-fullscreen',
    });
    const inline = buildWidgetSrcDoc({
      appHtml: '<div>Hello</div>',
      appUuid: 'app-123',
      appSlug: '',
      widgetName: 'email_inbox',
      apiBase: 'https://api.example.com',
      token: 'secret-token',
      surfaceId: 'surface-inline',
      inlineResize: true,
    });

    expect(fullscreen).toContain('window.ulAction');
    expect(fullscreen).toContain('window.ulOpenWidget');
    expect(fullscreen).toContain('window.ulWidget');
    expect(fullscreen).toContain('registerViewAction');
    expect(fullscreen).toContain('ul-widget-command');
    expect(fullscreen).toContain('"https://api.example.com"');
    expect(fullscreen).toContain('"surface-fullscreen"');
    expect(fullscreen).toContain('_widget_pull');
    expect(fullscreen).toContain('_widget_name');
    expect(fullscreen).toContain('_widget_action_id');
    expect(fullscreen).toContain('_widget_turn_id');
    expect(inline).toContain('ul-widget-resize');
    expect(inline).toContain('"surface-inline"');
    expect(inline).toContain('window.ulWidgetContext');
  });

  it('coerces widget meta with sensible fallbacks', () => {
    expect(coerceWidgetMeta({ badge_count: 2 }, 'Email Ops')).toEqual({
      title: 'Email Ops',
      icon: '📦',
      badge_count: 2,
    });
    expect(coerceWidgetMetaFromPayload(
      { counts: { active: 7 } },
      'Email Ops',
      { title: 'Inbox', icon: '📥', badge_count: 1 },
    )).toEqual({
      title: 'Inbox',
      icon: '📥',
      badge_count: 7,
    });
  });
});
