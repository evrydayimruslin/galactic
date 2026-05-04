import type { WidgetMeta } from '../../../shared/contracts/widget.ts';
import { executeAppMcpTool } from './api';
import { createDesktopLogger } from './logging';

const widgetRuntimeLogger = createDesktopLogger('WidgetRuntime');
const WIDGET_CACHE_PREFIX = 'widget_app:';

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
    if (!parsedKey || parsedKey.appUuid !== appUuid || parsedKey.widgetName !== widgetName) continue;
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
      if (source.appUuid !== parsedKey.appUuid || source.widgetName !== parsedKey.widgetName) return false;
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
): Promise<WidgetUiPayload | null> {
  const result = await executor(
    source.appUuid,
    buildWidgetToolName(source.appSlug, source.uiFunction),
    {},
  );
  if (result.isError) return null;
  return parseWidgetUiPayload(result.content?.[0]?.text || '');
}

export async function fetchWidgetDataPayload(
  source: Pick<WidgetAppSource, 'appUuid' | 'appSlug' | 'dataFunction'>,
  executor: typeof executeAppMcpTool = executeAppMcpTool,
): Promise<WidgetDataPayload | null> {
  const result = await executor(
    source.appUuid,
    buildWidgetToolName(source.appSlug, source.dataFunction),
    {},
  );
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
  source: Pick<WidgetAppSource, 'appUuid' | 'appSlug' | 'widgetName' | 'uiFunction'>
    & Partial<Pick<WidgetAppSource, 'appName' | 'appVersion'>>,
  options: {
    bustCache?: boolean;
    executor?: typeof executeAppMcpTool;
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

  const payload = await fetchWidgetUiPayload(source, options.executor ?? executeAppMcpTool);
  if (!payload) return null;

  if (payload.appHtml) {
    const meta = coerceWidgetMetaFromPayload(payload.raw, source.appName || source.widgetName);
    writeWidgetHtmlCache(source.appUuid, source.widgetName, payload.appHtml, payload.version, Date.now(), meta);
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
    icon: typeof candidate.icon === 'string' && candidate.icon.trim()
      ? candidate.icon
      : '📦',
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
  const counts = candidate.counts && typeof candidate.counts === 'object' && !Array.isArray(candidate.counts)
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
  inlineResize?: boolean;
}): string {
  const context = options.context ?? {};

  return `<script>
(function() {
  var _apiBase = ${JSON.stringify(options.apiBase)};
  var _token = ${JSON.stringify(options.token)};
  var _appUuid = ${JSON.stringify(options.appUuid)};
  var _appSlug = ${JSON.stringify(options.appSlug)};
  var _widgetName = ${JSON.stringify(options.widgetName)};

  window.ulAction = function(functionName, args) {
    var isPlatform = functionName.indexOf('ultralight.') === 0 || functionName.indexOf('ul.') === 0;
    var toolName = isPlatform ? functionName : (_appSlug ? (_appSlug + '_' + functionName) : functionName);
    var endpoint = isPlatform ? (_apiBase + '/mcp/platform') : (_apiBase + '/mcp/' + _appUuid);
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + _token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: { name: toolName, arguments: args || {} }
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
    parent.postMessage({ type: 'ul-open-widget', widgetName: widgetName, context: context || {} }, '*');
  };

  window.ulWidgetContext = ${JSON.stringify(context)};

  ${options.inlineResize ? `
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
    parent.postMessage({ type: 'ul-widget-resize', height: Math.ceil(h), id: _appUuid + ':' + _widgetName }, '*');
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

  parent.postMessage({ type: 'ul-widget-ready', id: _appUuid + ':' + _widgetName }, '*');
  ` : ''}
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
  inlineResize?: boolean;
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
