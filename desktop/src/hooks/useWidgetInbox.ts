// Widget inbox discovery, badge polling, and cached widget HTML loading.

import { useState, useEffect, useCallback, useRef } from 'react';
import { executeMcpTool, executeAppMcpTool } from '../lib/api';
import { fetchFromApi, getToken } from '../lib/storage';
import type { WidgetMeta } from '../../../shared/contracts/widget.ts';
import {
  discoverWidgetSources,
  recordLegacyWidgetContractObservations,
  type WidgetToolDescriptor,
} from '../lib/widgetContracts';
import { createDesktopLogger } from '../lib/logging';
import {
  coerceWidgetMetaFromPayload,
  fetchWidgetDataPayload,
  loadWidgetHtml,
  pruneStaleWidgetCaches,
  readWidgetHtmlCache,
  type WidgetAppSource,
  fetchWidgetUiPayload,
  updateWidgetHtmlCacheMeta,
  writeWidgetHtmlCache,
} from '../lib/widgetRuntime';

export type { WidgetAppSource } from '../lib/widgetRuntime';

export interface WidgetInboxState {
  sources: WidgetAppSource[];
  metas: Record<string, WidgetMeta>;
  loading: boolean;
  totalBadge: number;
  lastPoll: number;
}

const widgetInboxLogger = createDesktopLogger('WidgetInbox');

async function fetchAppVersion(appUuid: string, token: string): Promise<string | null> {
  try {
    const res = await fetchFromApi(`/api/apps/${appUuid}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const version = data?.current_version;
    return typeof version === 'string' || typeof version === 'number' ? String(version) : null;
  } catch {
    return null;
  }
}

export function useWidgetInbox() {
  const [state, setState] = useState<WidgetInboxState>({
    sources: [],
    metas: {},
    loading: true,
    totalBadge: 0,
    lastPoll: 0,
  });
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  const discoverSources = useCallback(async (): Promise<WidgetAppSource[]> => {
    const sources: WidgetAppSource[] = [];
    const token = getToken();
    if (!token) return sources;

    try {
      widgetInboxLogger.debug('Starting widget discovery');
      const libraryResult = await executeMcpTool('ul.discover', { scope: 'library' });
      if (libraryResult.isError) return sources;

      const libraryText = libraryResult.content?.[0]?.text || '';
      const library = JSON.parse(libraryText);
      const markdown = library.library || '';
      const sections = markdown.split(/^## /m).filter(Boolean);

      for (const section of sections) {
        const lines = section.split('\n');
        const name = lines[0]?.trim();
        if (!name) continue;

        const uuidMatch = section.match(/\/(?:http|mcp)\/([a-f0-9-]{36})/);
        if (!uuidMatch) continue;
        const appUuid = uuidMatch[1];

        let tools: WidgetToolDescriptor[] = [];
        try {
          const res = await fetchFromApi(`/mcp/${appUuid}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/list', params: {} }),
          });
          const data = await res.json();
          tools = data?.result?.tools || [];
        } catch { continue; }

        const appVersion = await fetchAppVersion(appUuid, token);
        const discovery = discoverWidgetSources({
          appUuid,
          appName: name,
          tools,
        });
        recordLegacyWidgetContractObservations(discovery.legacyObservations);
        if (discovery.legacyObservations.length > 0) {
          widgetInboxLogger.warn('App still exposes legacy widget contracts', {
            appName: name,
            legacyContracts: discovery.legacyObservations.map((observation) => observation.legacyFunction),
          });
        }
        sources.push(...discovery.sources.map((source) => ({ ...source, appVersion })));
      }

      // If multiple apps expose the same widget, keep the most recently discovered one.
      const seen = new Map<string, number>();
      sources.forEach((s, i) => seen.set(`${s.appName}:${s.widgetName}`, i));
      const deduped = sources.filter((s, i) => seen.get(`${s.appName}:${s.widgetName}`) === i);
      if (deduped.length < sources.length) {
        widgetInboxLogger.debug('Deduped duplicate widgets', {
          duplicateCount: sources.length - deduped.length,
        });
      }

      widgetInboxLogger.debug('Completed widget discovery', { widgetCount: deduped.length });
      return deduped;
    } catch (e) {
      widgetInboxLogger.error('Widget discovery failed', { error: e });
    }
    return sources;
  }, []);

  const pollMeta = useCallback(async (source: WidgetAppSource): Promise<WidgetMeta | null> => {
    try {
      const cached = readWidgetHtmlCache(source.appUuid, source.widgetName, source.appVersion);
      const cachedMeta = cached?.meta ?? null;

      if (source.dataFunction && source.dataFunction !== source.uiFunction) {
        const dataPayload = await fetchWidgetDataPayload(source, executeAppMcpTool);
        const dataMeta = coerceWidgetMetaFromPayload(dataPayload?.raw, source.appName, cachedMeta);
        if (dataMeta) {
          if (cached) {
            updateWidgetHtmlCacheMeta(source.appUuid, source.widgetName, source.appVersion, dataMeta);
          }
          return dataMeta;
        }
      }

      if (cachedMeta) return cachedMeta;

      const payload = await fetchWidgetUiPayload(source, executeAppMcpTool);
      if (!payload) return null;
      const uiMeta = coerceWidgetMetaFromPayload(payload.raw, source.appName, cachedMeta);
      if (payload.appHtml) {
        writeWidgetHtmlCache(source.appUuid, source.widgetName, payload.appHtml, payload.version, Date.now(), uiMeta);
      }

      return uiMeta;
    } catch {
      return null;
    }
  }, []);

  const pollAll = useCallback(async (sources: WidgetAppSource[]) => {
    if (sources.length === 0) {
      if (mountedRef.current) {
        setState(prev => ({ ...prev, loading: false, metas: {}, totalBadge: 0, lastPoll: Date.now() }));
      }
      return;
    }

    const newMetas: Record<string, WidgetMeta> = {};
    let totalBadge = 0;

    await Promise.all(
      sources.map(async (source) => {
        const key = `${source.appUuid}:${source.widgetName}`;
        const meta = await pollMeta(source);
        if (meta) {
          newMetas[key] = meta;
          totalBadge += meta.badge_count;
        }
      })
    );

    if (mountedRef.current) {
      setState(prev => ({ ...prev, metas: newMetas, totalBadge, loading: false, lastPoll: Date.now() }));
    }
  }, [pollMeta]);

  const getAppHtml = useCallback(async (source: WidgetAppSource): Promise<string | null> => {
    try {
      const result = await loadWidgetHtml(source, { executor: executeAppMcpTool });
      return result?.html ?? null;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!mountedRef.current) return;
    setState(prev => ({ ...prev, loading: true }));
    const sources = await discoverSources();
    if (!mountedRef.current) return;
    setState(prev => ({ ...prev, sources }));
    if (sources.length > 0) {
      sessionStorage.setItem('widget_sources', JSON.stringify(sources));
    } else {
      sessionStorage.removeItem('widget_sources');
    }
    const removed = pruneStaleWidgetCaches(sources);
    removed.forEach((key) => {
      widgetInboxLogger.debug('Pruned stale widget cache entry', { key });
    });
    await pollAll(sources);
  }, [discoverSources, pollAll]);

  useEffect(() => {
    mountedRef.current = true;

    const cached = sessionStorage.getItem('widget_sources');
    if (cached) {
      try {
        const cachedSources: WidgetAppSource[] = JSON.parse(cached);
        if (cachedSources.length > 0) {
          setState(prev => ({ ...prev, sources: cachedSources }));
          pollAll(cachedSources);
        }
      } catch { /* ignore corrupt cache */ }
    }

    refresh().then(() => {
      setState(prev => {
        if (prev.sources.length > 0) {
          sessionStorage.setItem('widget_sources', JSON.stringify(prev.sources));
        }
        return prev;
      });
    });

    pollTimerRef.current = setInterval(() => {
      if (mountedRef.current) {
        setState(prev => {
          if (prev.sources.length > 0) pollAll(prev.sources);
          return prev;
        });
      }
    }, 30_000);

    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  return { ...state, getAppHtml, refresh };
}
