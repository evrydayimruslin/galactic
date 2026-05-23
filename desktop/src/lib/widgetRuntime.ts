import type { WidgetMeta } from '../../../shared/contracts/widget.ts';
import { executeAppMcpTool, type WidgetPullCallMetadata } from './api';
import { createDesktopLogger } from './logging';

const widgetRuntimeLogger = createDesktopLogger('WidgetRuntime');
const WIDGET_CACHE_PREFIX = 'widget_app:';
const WIDGET_PULL_SETTINGS_PREFIX = 'widget_pull_settings:';
const WIDGET_PULL_SETTINGS_EVENT = 'ul-widget-pull-settings-changed';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export const DEFAULT_WIDGET_PULL_INTERVAL_MS = 5 * 60 * 1000;
export const WIDGET_PULL_LIGHT_PER_PULL = 0.001;
export const WIDGET_PULL_INTERVAL_OPTIONS = [
  { label: '1m', valueMs: 60 * 1000 },
  { label: '5m', valueMs: DEFAULT_WIDGET_PULL_INTERVAL_MS },
  { label: '15m', valueMs: 15 * 60 * 1000 },
  { label: '1h', valueMs: 60 * 60 * 1000 },
];

export interface WidgetAppSource {
  appUuid: string;
  appName: string;
  appSlug: string;
  appVersion?: string | null;
  widgetName: string;
  uiFunction: string;
  dataFunction: string;
}

export interface WidgetHtmlCacheEntry {
  html: string;
  version: string;
  cachedAt: number;
  meta?: WidgetMeta | null;
}

export interface WidgetUiPayload {
  raw: Record<string, unknown>;
  appHtml: string | null;
  version: string;
}

export interface WidgetDataPayload {
  raw: Record<string, unknown>;
}

export interface WidgetHtmlLoadResult {
  html: string | null;
  version: string | null;
  fromCache: boolean;
  payload?: WidgetUiPayload | null;
}

export interface WidgetPullSettings {
  enabled: boolean;
  intervalMs: number;
  lastPulledAt: number | null;
  pullCount: number;
}

export interface WidgetPullCostEstimate {
  monthlyPulls: number;
  monthlyLight: number;
}

function hasLocalStorage(): boolean {
  return typeof globalThis !== 'undefined' && 'localStorage' in globalThis;
}

interface ParsedWidgetCacheKey {
  appUuid: string;
  appVersion: string | null;
  widgetName: string;
}

function normalizeAppVersion(appVersion?: string | null): string | null {
  if (typeof appVersion !== 'string') return null;
  const trimmed = appVersion.trim();
  return trimmed || null;
}

function normalizeWidgetPullInterval(intervalMs: unknown): number {
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs)) {
    return DEFAULT_WIDGET_PULL_INTERVAL_MS;
  }
  const min = WIDGET_PULL_INTERVAL_OPTIONS[0]?.valueMs ?? DEFAULT_WIDGET_PULL_INTERVAL_MS;
  return Math.max(min, Math.round(intervalMs));
}

function normalizeWidgetPullSettings(
  raw: Partial<WidgetPullSettings> | null | undefined,
): WidgetPullSettings {
  return {
    enabled: raw?.enabled === true,
    intervalMs: normalizeWidgetPullInterval(raw?.intervalMs),
    lastPulledAt: typeof raw?.lastPulledAt === 'number' && Number.isFinite(raw.lastPulledAt)
      ? raw.lastPulledAt
      : null,
    pullCount: typeof raw?.pullCount === 'number' && Number.isFinite(raw.pullCount)
      ? Math.max(0, Math.floor(raw.pullCount))
      : 0,
  };
}

function dispatchWidgetPullSettingsChanged(): void {
  if (typeof globalThis === 'undefined' || typeof globalThis.dispatchEvent !== 'function') return;
  if (typeof CustomEvent === 'function') {
    globalThis.dispatchEvent(new CustomEvent(WIDGET_PULL_SETTINGS_EVENT));
  } else if (typeof Event === 'function') {
    globalThis.dispatchEvent(new Event(WIDGET_PULL_SETTINGS_EVENT));
  }
}

export function getWidgetSourceKey(
  source: Pick<WidgetAppSource, 'appUuid' | 'widgetName'>,
): string {
  return `${source.appUuid}:${source.widgetName}`;
}

export function getWidgetPullSettingsStorageKey(
  source: Pick<WidgetAppSource, 'appUuid' | 'widgetName'>,
): string {
  return `${WIDGET_PULL_SETTINGS_PREFIX}${getWidgetSourceKey(source)}`;
}

export function readWidgetPullSettings(
  source: Pick<WidgetAppSource, 'appUuid' | 'widgetName'>,
): WidgetPullSettings {
  if (!hasLocalStorage()) return normalizeWidgetPullSettings(null);

  try {
    const raw = globalThis.localStorage.getItem(getWidgetPullSettingsStorageKey(source));
    if (!raw) return normalizeWidgetPullSettings(null);
    const parsed = JSON.parse(raw) as Partial<WidgetPullSettings>;
    return normalizeWidgetPullSettings(parsed);
  } catch {
    return normalizeWidgetPullSettings(null);
  }
}

export function writeWidgetPullSettings(
  source: Pick<WidgetAppSource, 'appUuid' | 'widgetName'>,
  patch: Partial<WidgetPullSettings>,
): WidgetPullSettings {
  const next = normalizeWidgetPullSettings({
    ...readWidgetPullSettings(source),
    ...patch,
  });

  if (hasLocalStorage()) {
    globalThis.localStorage.setItem(
      getWidgetPullSettingsStorageKey(source),
      JSON.stringify(next),
    );
  }
  dispatchWidgetPullSettingsChanged();
  return next;
}

export function updateWidgetPullStats(
  source: Pick<WidgetAppSource, 'appUuid' | 'widgetName'>,
  now = Date.now(),
): WidgetPullSettings {
  const settings = readWidgetPullSettings(source);
  return writeWidgetPullSettings(source, {
    ...settings,
    lastPulledAt: now,
    pullCount: settings.pullCount + 1,
  });
}

export function isWidgetPullDue(settings: WidgetPullSettings, now = Date.now()): boolean {
  if (!settings.enabled) return false;
  if (!settings.lastPulledAt) return true;
  return now - settings.lastPulledAt >= settings.intervalMs;
}

export function estimateWidgetPullCost(
  settings: Pick<WidgetPullSettings, 'enabled' | 'intervalMs'>,
): WidgetPullCostEstimate {
  if (!settings.enabled) {
    return { monthlyPulls: 0, monthlyLight: 0 };
  }
  const intervalMs = normalizeWidgetPullInterval(settings.intervalMs);
  const monthlyPulls = Math.ceil(MONTH_MS / intervalMs);
  return {
    monthlyPulls,
    monthlyLight: monthlyPulls * WIDGET_PULL_LIGHT_PER_PULL,
  };
}

export function getWidgetCacheKey(
  appUuid: string,
  widgetName: string,
  appVersion?: string | null,
): string {
  const normalizedVersion = normalizeAppVersion(appVersion);
  if (!normalizedVersion) {
    return `${WIDGET_CACHE_PREFIX}${appUuid}:${widgetName}`;
  }
  return `${WIDGET_CACHE_PREFIX}${appUuid}:${normalizedVersion}:${widgetName}`;
}

function parseWidgetCacheKey(key: string): ParsedWidgetCacheKey | null {
  if (!key.startsWith(WIDGET_CACHE_PREFIX)) return null;

  const parts = key.slice(WIDGET_CACHE_PREFIX.length).split(':');
  if (parts.length === 2) {
    return {
      appUuid: parts[0],
      appVersion: null,
      widgetName: parts[1],
    };
  }

  if (parts.length === 3) {
    return {
      appUuid: parts[0],
      appVersion: parts[1],
      widgetName: parts[2],
    };
  }

  return null;
}

function parseWidgetHtmlCacheEntry(raw: string | null): WidgetHtmlCacheEntry | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<WidgetHtmlCacheEntry>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.html !== 'string' || !parsed.html) return null;

    return {
      html: parsed.html,
      version: typeof parsed.version === 'string' ? parsed.version : '1',
      cachedAt: typeof parsed.cachedAt === 'number' ? parsed.cachedAt : Date.now(),
      meta: parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)
        ? parsed.meta as WidgetMeta
        : null,
    };
  } catch {
    return null;
  }
}

function findLatestWidgetHtmlCache(
  appUuid: string,
  widgetName: string,
): WidgetHtmlCacheEntry | null {
  if (!hasLocalStorage()) return null;

  let latest: WidgetHtmlCacheEntry | null = null;
  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) {
    const key = globalThis.localStorage.key(i);
    if (!key) continue;
    const parsedKey = parseWidgetCacheKey(key);
    if (!parsedKey || parsedKey.appUuid !== appUuid || parsedKey.widgetName !== widgetName) {
      continue;
    }
    const entry = parseWidgetHtmlCacheEntry(globalThis.localStorage.getItem(key));
    if (!entry) continue;
    if (!latest || entry.cachedAt > latest.cachedAt) {
      latest = entry;
    }
  }

  return latest;
}

export function readWidgetHtmlCache(
  appUuid: string,
  widgetName: string,
  appVersion?: string | null,
): WidgetHtmlCacheEntry | null {
  if (!hasLocalStorage()) return null;

  const normalizedVersion = normalizeAppVersion(appVersion);
  if (normalizedVersion) {
    const exact = parseWidgetHtmlCacheEntry(
      globalThis.localStorage.getItem(getWidgetCacheKey(appUuid, widgetName, normalizedVersion)),
    );
    if (exact?.version === normalizedVersion) return exact;

    const legacy = parseWidgetHtmlCacheEntry(
      globalThis.localStorage.getItem(getWidgetCacheKey(appUuid, widgetName)),
    );
    if (legacy?.version === normalizedVersion) return legacy;
    return null;
  }

  const legacy = parseWidgetHtmlCacheEntry(
    globalThis.localStorage.getItem(getWidgetCacheKey(appUuid, widgetName)),
  );
  return legacy ?? findLatestWidgetHtmlCache(appUuid, widgetName);
}

export function writeWidgetHtmlCache(
  appUuid: string,
  widgetName: string,
  html: string,
  version = '1',
  cachedAt = Date.now(),
  meta?: WidgetMeta | null,
): WidgetHtmlCacheEntry {
  const entry: WidgetHtmlCacheEntry = { html, version, cachedAt, meta: meta ?? null };

  if (hasLocalStorage()) {
    globalThis.localStorage.setItem(
      getWidgetCacheKey(appUuid, widgetName, version),
      JSON.stringify(entry),
    );
    globalThis.localStorage.removeItem(getWidgetCacheKey(appUuid, widgetName));
  }

  return entry;
}

export function pruneStaleWidgetCaches(
  sources: Array<Pick<WidgetAppSource, 'appUuid' | 'widgetName' | 'appVersion'>>,
): string[] {
  if (!hasLocalStorage()) return [];

  const removed: string[] = [];

  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) {
    const key = globalThis.localStorage.key(i);
    if (!key?.startsWith(WIDGET_CACHE_PREFIX)) continue;
    const parsedKey = parseWidgetCacheKey(key);
    if (!parsedKey) continue;

    const matchingSource = sources.find((source) => {
      if (source.appUuid !== parsedKey.appUuid || source.widgetName !== parsedKey.widgetName) {
        return false;
      }
      const sourceVersion = normalizeAppVersion(source.appVersion);
      return !sourceVersion || sourceVersion === parsedKey.appVersion;
    });
    if (matchingSource) continue;

    removed.push(key);
    globalThis.localStorage.removeItem(key);
  }

  return removed;
}

function buildWidgetToolName(appSlug: string, functionName: string): string {
  return appSlug ? `${appSlug}_${functionName}` : functionName;
}

function parseJsonPayload(text: string, label: string): Record<string, unknown> | null {
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (error) {
    widgetRuntimeLogger.warn(`Failed to parse widget ${label} payload`, { error });
    return null;
  }
}

function parseWidgetUiPayload(text: string): WidgetUiPayload | null {
  const raw = parseJsonPayload(text, 'UI');
  if (!raw) return null;

  return {
    raw,
    appHtml: typeof raw.app_html === 'string' ? raw.app_html : null,
    version: typeof raw.version === 'string' || typeof raw.version === 'number'
      ? String(raw.version)
      : '1',
  };
}

export async function fetchWidgetUiPayload(
  source: Pick<WidgetAppSource, 'appUuid' | 'appSlug' | 'uiFunction'>,
  executor: typeof executeAppMcpTool = executeAppMcpTool,
  widgetPull?: WidgetPullCallMetadata | null,
): Promise<WidgetUiPayload | null> {
  const toolName = buildWidgetToolName(source.appSlug, source.uiFunction);
  const result = widgetPull
    ? await executor(source.appUuid, toolName, {}, { widgetPull })
    : await executor(source.appUuid, toolName, {});
  if (result.isError) return null;
  return parseWidgetUiPayload(result.content?.[0]?.text || '');
}

export async function fetchWidgetDataPayload(
  source: Pick<WidgetAppSource, 'appUuid' | 'appSlug' | 'dataFunction'>,
  executor: typeof executeAppMcpTool = executeAppMcpTool,
  widgetPull?: WidgetPullCallMetadata | null,
  args: Record<string, unknown> = {},
): Promise<WidgetDataPayload | null> {
  const toolName = buildWidgetToolName(source.appSlug, source.dataFunction);
  const result = widgetPull
    ? await executor(source.appUuid, toolName, args, { widgetPull })
    : await executor(source.appUuid, toolName, args);
  if (result.isError) return null;

  const raw = parseJsonPayload(result.content?.[0]?.text || '', 'data');
  return raw ? { raw } : null;
}

export function updateWidgetHtmlCacheMeta(
  appUuid: string,
  widgetName: string,
  appVersion: string | null | undefined,
  meta: WidgetMeta,
): WidgetHtmlCacheEntry | null {
  const cached = readWidgetHtmlCache(appUuid, widgetName, appVersion);
  if (!cached) return null;
  return writeWidgetHtmlCache(
    appUuid,
    widgetName,
    cached.html,
    cached.version,
    cached.cachedAt,
    meta,
  );
}

export async function loadWidgetHtml(
  source:
    & Pick<WidgetAppSource, 'appUuid' | 'appSlug' | 'widgetName' | 'uiFunction'>
    & Partial<Pick<WidgetAppSource, 'appName' | 'appVersion'>>,
  options: {
    bustCache?: boolean;
    executor?: typeof executeAppMcpTool;
    widgetPull?: WidgetPullCallMetadata | null;
  } = {},
): Promise<WidgetHtmlLoadResult | null> {
  if (!options.bustCache) {
    const cached = readWidgetHtmlCache(source.appUuid, source.widgetName, source.appVersion);
    if (cached?.html) {
      return {
        html: cached.html,
        version: cached.version,
        fromCache: true,
      };
    }
  }

  const payload = await fetchWidgetUiPayload(
    source,
    options.executor ?? executeAppMcpTool,
    options.widgetPull ?? null,
  );
  if (!payload) return null;

  if (payload.appHtml) {
    const meta = coerceWidgetMetaFromPayload(payload.raw, source.appName || source.widgetName);
    writeWidgetHtmlCache(
      source.appUuid,
      source.widgetName,
      payload.appHtml,
      payload.version,
      Date.now(),
      meta,
    );
  }

  return {
    html: payload.appHtml,
    version: payload.version,
    fromCache: false,
    payload,
  };
}

export function coerceWidgetMeta(raw: unknown, fallbackTitle: string): WidgetMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const candidate = raw as Record<string, unknown>;
  const badgeCount = candidate.badge_count;
  if (typeof badgeCount !== 'number') return null;

  return {
    title: typeof candidate.title === 'string' && candidate.title.trim()
      ? candidate.title
      : fallbackTitle,
    icon: typeof candidate.icon === 'string' && candidate.icon.trim() ? candidate.icon : '📦',
    badge_count: badgeCount,
  };
}

function firstNumericValue(values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function coerceWidgetMetaFromPayload(
  raw: unknown,
  fallbackTitle: string,
  cachedMeta?: WidgetMeta | null,
): WidgetMeta | null {
  const direct = coerceWidgetMeta(
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).meta ?? raw
      : raw,
    fallbackTitle,
  );
  if (direct) return direct;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cachedMeta ?? null;
  const candidate = raw as Record<string, unknown>;
  const counts =
    candidate.counts && typeof candidate.counts === 'object' && !Array.isArray(candidate.counts)
      ? candidate.counts as Record<string, unknown>
      : null;
  const inferredBadgeCount = firstNumericValue([
    candidate.badge_count,
    counts?.active,
    counts?.pending,
    counts?.total,
    Array.isArray(candidate.items) ? candidate.items.length : null,
    Array.isArray(candidate.sources) ? candidate.sources.length : null,
  ]);

  if (inferredBadgeCount === null) return cachedMeta ?? null;

  return {
    title: cachedMeta?.title || fallbackTitle,
    icon: cachedMeta?.icon || '📦',
    badge_count: inferredBadgeCount,
  };
}

export function buildWidgetNavigationTarget(
  source: WidgetAppSource,
  widgetName: string,
): WidgetAppSource {
  return {
    ...source,
    widgetName,
    uiFunction: `widget_${widgetName}_ui`,
    dataFunction: `widget_${widgetName}_data`,
  };
}

export function buildWidgetWindowSearchParams(
  source: WidgetAppSource,
  context?: Record<string, string>,
  surfaceId?: string,
): URLSearchParams {
  const params = new URLSearchParams({
    widget: '1',
    appUuid: source.appUuid,
    appSlug: source.appSlug,
    appName: source.appName,
    appVersion: source.appVersion || '',
    widgetName: source.widgetName,
    uiFunction: source.uiFunction,
    dataFunction: source.dataFunction,
  });

  if (surfaceId) {
    params.set('surfaceId', surfaceId);
  }

  if (context) {
    for (const [key, value] of Object.entries(context)) {
      params.set(`ctx_${key}`, value);
    }
  }

  return params;
}

export function parseWidgetSourceFromSearch(search: string): WidgetAppSource {
  const params = new URLSearchParams(search);
  return {
    appUuid: params.get('appUuid') || '',
    appSlug: params.get('appSlug') || '',
    appName: params.get('appName') || '',
    appVersion: params.get('appVersion') || null,
    widgetName: params.get('widgetName') || '',
    uiFunction: params.get('uiFunction') || '',
    dataFunction: params.get('dataFunction') || '',
  };
}

export function parseWidgetSurfaceIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const surfaceId = params.get('surfaceId');
  return surfaceId && surfaceId.trim() ? surfaceId : null;
}

export function parseWidgetContextFromSearch(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const context: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key.startsWith('ctx_')) {
      context[key.slice(4)] = value;
    }
  });
  return context;
}

function buildWidgetBridgeScript(options: {
  appUuid: string;
  appSlug: string;
  widgetName: string;
  apiBase: string;
  token: string | null;
  context?: Record<string, string>;
  surfaceId?: string;
  inlineResize?: boolean;
  widgetPull?: WidgetPullCallMetadata | null;
}): string {
  const context = options.context ?? {};
  const surfaceId = options.surfaceId || `${options.appUuid}:${options.widgetName}`;
  const widgetIntervalMs = typeof options.widgetPull?.intervalMs === 'number' &&
      Number.isFinite(options.widgetPull.intervalMs)
    ? Math.max(0, Math.round(options.widgetPull.intervalMs))
    : null;
  const widgetPullReason = options.widgetPull?.reason || 'widget_action';

  return `<script>
(function() {
  var _apiBase = ${JSON.stringify(options.apiBase)};
  var _token = ${JSON.stringify(options.token)};
  var _appUuid = ${JSON.stringify(options.appUuid)};
  var _appSlug = ${JSON.stringify(options.appSlug)};
  var _widgetName = ${JSON.stringify(options.widgetName)};
  var _surfaceId = ${JSON.stringify(surfaceId)};
  var _widgetIntervalMs = ${JSON.stringify(widgetIntervalMs)};
  var _widgetPullReason = ${JSON.stringify(widgetPullReason)};
  var _ulWidgetStateProvider = null;
  var _ulWidgetActions = {};
  var _ulWidgetCommandContext = null;

  function postWidgetMessage(type, payload) {
    parent.postMessage(Object.assign({
      type: type,
      id: _surfaceId,
      surfaceId: _surfaceId,
      surface_id: _surfaceId,
      appUuid: _appUuid,
      appSlug: _appSlug,
      widgetName: _widgetName,
      widget_id: _widgetName
    }, payload || {}), '*');
  }

  function readWidgetState() {
    if (typeof _ulWidgetStateProvider !== 'function') return null;
    try {
      var snapshot = _ulWidgetStateProvider();
      if (snapshot && typeof snapshot === 'object') {
        if (!snapshot.surface_id) snapshot.surface_id = _surfaceId;
        if (!snapshot.widget_id) snapshot.widget_id = _widgetName;
        if (!snapshot.app_id) snapshot.app_id = _appUuid;
        if (!snapshot.app_slug) snapshot.app_slug = _appSlug;
      }
      return snapshot;
    } catch (err) {
      postWidgetMessage('ul-widget-event', {
        event: {
          kind: 'error',
          label: 'Widget state provider failed',
          error: err && err.message ? err.message : String(err),
          created_at: new Date().toISOString()
        }
      });
      return null;
    }
  }

  function reportWidgetState(snapshot) {
    if (snapshot && typeof snapshot === 'object') {
      if (!snapshot.surface_id) snapshot.surface_id = _surfaceId;
      if (!snapshot.widget_id) snapshot.widget_id = _widgetName;
      if (!snapshot.app_id) snapshot.app_id = _appUuid;
      if (!snapshot.app_slug) snapshot.app_slug = _appSlug;
      postWidgetMessage('ul-widget-state', { snapshot: snapshot });
    }
    return snapshot;
  }

  function reportWidgetActions() {
    var actions = Object.keys(_ulWidgetActions).map(function(id) {
      return _ulWidgetActions[id].declaration;
    });
    postWidgetMessage('ul-widget-actions', { actions: actions });
    return actions;
  }

  window.ulAction = function(functionName, args) {
    var isPlatform = functionName.indexOf('ultralight.') === 0 || functionName.indexOf('ul.') === 0;
    var toolName = isPlatform ? functionName : (_appSlug ? (_appSlug + '_' + functionName) : functionName);
    var endpoint = isPlatform ? (_apiBase + '/mcp/platform') : (_apiBase + '/mcp/' + _appUuid);
    var callArgs = args || {};
    if (!isPlatform) {
      callArgs = Object.assign({}, callArgs, {
        _widget_pull: true,
        _widget_name: _widgetName,
        _widget_pull_reason: _widgetPullReason
      });
      if (_widgetIntervalMs !== null) callArgs._widget_interval_ms = _widgetIntervalMs;
    }
    if (_ulWidgetCommandContext) {
      callArgs = Object.assign({}, callArgs, {
        _widget_action: true,
        _widget_surface_id: _surfaceId,
        _widget_id: _widgetName,
        _widget_action_id: _ulWidgetCommandContext.actionId,
        _widget_turn_id: _ulWidgetCommandContext.turnId
      });
    }
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + _token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: { name: toolName, arguments: callArgs }
      })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.error) throw new Error(data.error.message || 'MCP error');
      var text = data.result && data.result.content && data.result.content[0] && data.result.content[0].text;
      if (!text) return null;
      try { return JSON.parse(text); } catch (e) { return text; }
    });
  };

  window.ulOpenWidget = function(widgetName, context) {
    postWidgetMessage('ul-open-widget', { widgetName: widgetName, context: context || {} });
  };

  window.ulWidgetContext = ${JSON.stringify(context)};

  window.ulWidget = {
    surfaceId: _surfaceId,
    widgetName: _widgetName,
    context: window.ulWidgetContext,
    reportState: function(snapshotOrProvider) {
      if (typeof snapshotOrProvider === 'function') {
        _ulWidgetStateProvider = snapshotOrProvider;
        return reportWidgetState(readWidgetState());
      }
      _ulWidgetStateProvider = function() { return snapshotOrProvider; };
      return reportWidgetState(snapshotOrProvider);
    },
    refreshContext: function() {
      return reportWidgetState(readWidgetState());
    },
    registerAction: function(action, handler) {
      if (!action || typeof action !== 'object' || typeof action.id !== 'string' || !action.id) {
        throw new Error('ulWidget.registerAction requires an action object with id');
      }
      _ulWidgetActions[action.id] = {
        declaration: action,
        handler: typeof handler === 'function' ? handler : null
      };
      reportWidgetActions();
      return action.id;
    },
    registerViewAction: function(action, handler) {
      var declaration = Object.assign({ mode: 'ui', confirmation: 'none' }, action || {});
      return window.ulWidget.registerAction(declaration, handler);
    },
    logEvent: function(event) {
      var payload = event && typeof event === 'object' ? event : { kind: 'system', label: String(event || '') };
      if (!payload.created_at) payload.created_at = new Date().toISOString();
      postWidgetMessage('ul-widget-event', { event: payload });
      return payload;
    }
  };

  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.type !== 'ul-widget-command') return;
    var targetSurfaceId = data.surfaceId || data.surface_id;
    if (targetSurfaceId && targetSurfaceId !== _surfaceId) return;
    var actionId = data.actionId || data.action_id;
    var turnId = data.turnId || data.turn_id;
    var entry = actionId ? _ulWidgetActions[actionId] : null;
    if (!entry || typeof entry.handler !== 'function') {
      postWidgetMessage('ul-widget-action-result', {
        result: {
          surface_id: _surfaceId,
          widget_id: _widgetName,
          action_id: actionId || '',
          turn_id: turnId,
          ok: false,
          error: actionId ? 'No live handler registered for action ' + actionId : 'Missing action id'
        }
      });
      return;
    }
    postWidgetMessage('ul-widget-event', {
      event: {
        kind: 'agent',
        action_id: actionId,
        label: 'Widget command received',
        input: data.args || {},
        created_at: new Date().toISOString()
      }
    });
    var previousCommandContext = _ulWidgetCommandContext;
    _ulWidgetCommandContext = { actionId: actionId, turnId: turnId };
    Promise.resolve()
      .then(function() {
        return entry.handler(data.args || {}, data);
      })
      .then(function(result) {
        _ulWidgetCommandContext = previousCommandContext;
        postWidgetMessage('ul-widget-action-result', {
          result: {
            surface_id: _surfaceId,
            widget_id: _widgetName,
            action_id: actionId,
            turn_id: turnId,
            ok: true,
            data: result,
            snapshot: readWidgetState() || undefined
          }
        });
      })
      .catch(function(err) {
        _ulWidgetCommandContext = previousCommandContext;
        postWidgetMessage('ul-widget-action-result', {
          result: {
            surface_id: _surfaceId,
            widget_id: _widgetName,
            action_id: actionId,
            turn_id: turnId,
            ok: false,
            error: err && err.message ? err.message : String(err),
            snapshot: readWidgetState() || undefined
          }
        });
      });
  });

  ${
    options.inlineResize
      ? `
  var styleOverride = document.createElement('style');
  styleOverride.textContent = 'html, body { height: auto !important; overflow: visible !important; }';
  (document.head || document.documentElement).appendChild(styleOverride);

  function reportHeight() {
    var h = 0;
    var children = document.body.children;
    for (var i = 0; i < children.length; i++) {
      var rect = children[i].getBoundingClientRect();
      var bottom = rect.top + rect.height;
      if (bottom > h) h = bottom;
    }
    if (h < 50) h = document.body.scrollHeight;
    h += 24;
    postWidgetMessage('ul-widget-resize', { height: Math.ceil(h) });
  }

  function startResizeObservers() {
    setTimeout(reportHeight, 100);
    new MutationObserver(function() { setTimeout(reportHeight, 50); }).observe(document.body, {
      childList: true, subtree: true, attributes: true, characterData: true
    });
    new ResizeObserver(function() { setTimeout(reportHeight, 50); }).observe(document.body);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startResizeObservers);
  } else {
    startResizeObservers();
  }

  postWidgetMessage('ul-widget-ready');
  `
      : ''
  }
})();
</script>`;
}

export function buildWidgetSrcDoc(options: {
  appHtml: string;
  appUuid: string;
  appSlug: string;
  widgetName: string;
  apiBase: string;
  token: string | null;
  context?: Record<string, string>;
  surfaceId?: string;
  inlineResize?: boolean;
  widgetPull?: WidgetPullCallMetadata | null;
}): string {
  const bridgeScript = buildWidgetBridgeScript(options);

  if (options.appHtml.includes('<head>')) {
    return options.appHtml.replace('<head>', `<head>${bridgeScript}`);
  }

  if (options.appHtml.includes('<html>')) {
    return options.appHtml.replace('<html>', `<html><head>${bridgeScript}</head>`);
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8">${bridgeScript}</head><body>${options.appHtml}</body></html>`;
}
