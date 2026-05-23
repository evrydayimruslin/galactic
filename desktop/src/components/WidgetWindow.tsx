// WidgetWindow — standalone window for a widget app, opened via multiWindow.
// Reads WidgetAppSource from query params, shared auth state from secure storage,
// and the API base from the build-pinned desktop environment.
// Includes a refresh button to re-fetch the widget HTML from the MCP.

import { useState, useEffect, useRef, useCallback } from 'react';
import { getApiBase, getToken } from '../lib/storage';
import { openWidgetWindow } from '../lib/multiWindow';
import {
  buildWidgetNavigationTarget,
  buildWidgetSrcDoc,
  loadWidgetHtml,
  parseWidgetContextFromSearch,
  parseWidgetSurfaceIdFromSearch,
  parseWidgetSourceFromSearch,
  readWidgetPullSettings,
  updateWidgetPullStats,
} from '../lib/widgetRuntime';
import {
  buildWidgetSurfaceCommandMessage,
  createWidgetSurfaceId,
  handleWidgetBridgeMessage,
  registerWidgetSurface,
  unregisterWidgetSurface,
  updateWidgetSurfaceStatus,
  WIDGET_SURFACE_COMMAND_EVENT,
} from '../lib/widgetSurfaceRegistry';
import type { WidgetSurfaceCommand } from '../lib/widgetAgentTypes';
import { createDesktopLogger } from '../lib/logging';
import DesktopAsyncState from './DesktopAsyncState';
import WidgetComposer from './widgets/WidgetComposer';
import WidgetEventLog from './widgets/WidgetEventLog';

const widgetWindowLogger = createDesktopLogger('WidgetWindow');

export default function WidgetWindow() {
  const source = useRef(parseWidgetSourceFromSearch(window.location.search)).current;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const surfaceId = useRef(
    parseWidgetSurfaceIdFromSearch(window.location.search) ||
      createWidgetSurfaceId('window', source.appUuid, source.widgetName),
  ).current;
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [iframeError, setIframeError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const widgetContext = useRef(parseWidgetContextFromSearch(window.location.search)).current;

  const fetchHtml = useCallback(async (bustCache = false) => {
    setLoading(true);
    setError(null);
    setIframeError(false);

    try {
      const widgetSettings = readWidgetPullSettings(source);
      const result = await loadWidgetHtml(source, {
        bustCache,
        widgetPull: {
          widgetName: source.widgetName,
          intervalMs: widgetSettings.intervalMs,
          reason: bustCache ? 'manual_refresh' : 'open',
        },
      });
      if (!result) {
        setError('Failed to load widget');
      } else if (result.html) {
        setHtml(result.html);
        if (!result.fromCache) {
          updateWidgetPullStats(source);
        }
      } else {
        setError('Widget returned no HTML');
      }
    } catch (e) {
      setError('Failed to fetch widget');
      widgetWindowLogger.error('Failed to fetch widget HTML', {
        error: e,
        widgetName: source.widgetName,
        appUuid: source.appUuid,
      });
    }
    setLoading(false);
  }, [source]);

  useEffect(() => { fetchHtml(); }, [fetchHtml]);

  // Build iframe srcDoc with bridge SDK injected
  const preparedHtml = (() => {
    if (!html) return null;

    const apiBase = getApiBase();
    const token = getToken();

    return buildWidgetSrcDoc({
      appHtml: html,
      appUuid: source.appUuid,
      appSlug: source.appSlug,
      widgetName: source.widgetName,
      apiBase,
      token,
      context: widgetContext,
      surfaceId,
      widgetPull: {
        widgetName: source.widgetName,
        intervalMs: readWidgetPullSettings(source).intervalMs,
        reason: 'widget_action',
      },
    });
  })();

  useEffect(() => {
    registerWidgetSurface({
      surfaceId,
      kind: 'window',
      source,
      context: widgetContext,
    });
    return () => unregisterWidgetSurface(surfaceId);
  }, [source, surfaceId, widgetContext]);

  // Listen for widget-to-widget navigation requests from iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data && typeof e.data === 'object') {
        const messageSurfaceId = typeof e.data.surfaceId === 'string'
          ? e.data.surfaceId
          : typeof e.data.id === 'string'
          ? e.data.id
          : null;
        if (messageSurfaceId && messageSurfaceId !== surfaceId) return;

        handleWidgetBridgeMessage(e.data, surfaceId);
        if (e.data.type === 'ul-widget-ready') {
          updateWidgetSurfaceStatus(surfaceId, 'ready');
        }
      }
      if (e.data?.type === 'ul-open-widget' && e.data.widgetName) {
        const target = buildWidgetNavigationTarget(source, e.data.widgetName);
        openWidgetWindow(target, e.data.context);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [source, surfaceId]);

  useEffect(() => {
    const handleCommand = (event: Event) => {
      const command = (event as CustomEvent<WidgetSurfaceCommand>).detail;
      if (!command || command.surface_id !== surfaceId) return;
      iframeRef.current?.contentWindow?.postMessage(
        buildWidgetSurfaceCommandMessage(command),
        '*',
      );
    };

    window.addEventListener(WIDGET_SURFACE_COMMAND_EVENT, handleCommand);
    return () => window.removeEventListener(WIDGET_SURFACE_COMMAND_EVENT, handleCommand);
  }, [surfaceId]);


  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 bg-white shrink-0"
           data-tauri-drag-region="true">
        <span className="text-sm font-medium text-gray-900 select-none">
          {source.appName}
        </span>
        <button
          onClick={() => fetchHtml(true)}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors disabled:opacity-40"
          title="Refresh widget"
        >
          <svg className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {loading && !error && !preparedHtml && (
          <DesktopAsyncState
            kind="loading"
            title={`Loading ${source.appName || 'widget'}`}
            message="Opening the latest widget view from your connected app."
          />
        )}
        {!loading && error && (
          <DesktopAsyncState
            kind="error"
            title="Widget unavailable"
            message={error}
            actionLabel="Retry"
            onAction={() => {
              void fetchHtml(true);
            }}
          />
        )}
        {!loading && !error && !preparedHtml && (
          <DesktopAsyncState
            kind="empty"
            title="No widget UI returned"
            message="This widget is reachable, but it did not return a visual surface yet."
            actionLabel="Refresh"
            onAction={() => {
              void fetchHtml(true);
            }}
          />
        )}
        {!loading && !error && iframeError && (
          <DesktopAsyncState
            kind="error"
            title="Widget view unavailable"
            message="The widget shell could not finish loading."
            actionLabel="Retry"
            onAction={() => {
              setIframeError(false);
              setReloadKey((value) => value + 1);
            }}
          />
        )}
        {preparedHtml && !iframeError && (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            srcDoc={preparedHtml}
            sandbox="allow-scripts allow-same-origin"
            className="w-full h-full border-0"
            title={`Widget: ${source.widgetName}`}
            onError={() => {
              setIframeError(true);
              widgetWindowLogger.error('Widget iframe error', {
                widgetName: source.widgetName,
                appUuid: source.appUuid,
              });
            }}
            onLoad={() => {
              updateWidgetSurfaceStatus(surfaceId, 'ready');
            }}
          />
        )}
      </div>
      <WidgetEventLog surfaceId={surfaceId} />
      <WidgetComposer surfaceId={surfaceId} source={source} context={widgetContext} />
    </div>
  );
}
