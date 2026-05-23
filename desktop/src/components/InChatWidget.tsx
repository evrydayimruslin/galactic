// InChatWidget — renders an MCP widget iframe inline in the conversation.
// Injects the ulAction bridge SDK so the widget can call MCP functions.
// Auto-resizes height based on iframe content.

import { useRef, useEffect, useState, useCallback } from 'react';
import { getApiBase, getToken } from '../lib/storage';
import { openWidgetWindow } from '../lib/multiWindow';
import { buildWidgetNavigationTarget, buildWidgetSrcDoc } from '../lib/widgetRuntime';
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

interface InChatWidgetProps {
  appUuid: string;
  appSlug: string;
  widgetName: string;
  appHtml: string;
  /** Maximum height before internal scrolling (default: 600px) */
  maxHeight?: number;
}

export default function InChatWidget({
  appUuid,
  appSlug,
  widgetName,
  appHtml,
  maxHeight = 2000,
}: InChatWidgetProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const surfaceIdRef = useRef<string | null>(null);
  if (!surfaceIdRef.current) {
    surfaceIdRef.current = createWidgetSurfaceId('inline', appUuid, widgetName);
  }
  const [height, setHeight] = useState(300);
  const [loaded, setLoaded] = useState(false);

  const apiBase = getApiBase();
  const token = getToken();
  const surfaceId = surfaceIdRef.current!;
  const source = {
    appUuid,
    appSlug,
    appName: widgetName,
    widgetName,
    uiFunction: `widget_${widgetName}_ui`,
    dataFunction: `widget_${widgetName}_data`,
  };

  const preparedHtml = buildWidgetSrcDoc({
    appHtml,
    appUuid,
    appSlug,
    widgetName,
    apiBase,
    token,
    surfaceId,
    inlineResize: true,
  });

  useEffect(() => {
    registerWidgetSurface({
      surfaceId,
      kind: 'inline',
      source,
    });
    return () => unregisterWidgetSurface(surfaceId);
  }, [appSlug, appUuid, surfaceId, widgetName]);

  // Listen for height reports from iframe
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== 'object') return;
      const messageSurfaceId = typeof e.data.surfaceId === 'string'
        ? e.data.surfaceId
        : typeof e.data.id === 'string'
        ? e.data.id
        : null;
      if (messageSurfaceId && messageSurfaceId !== surfaceId) return;

      handleWidgetBridgeMessage(e.data, surfaceId);

      if (e.data.type === 'ul-widget-resize' && typeof e.data.height === 'number') {
        const newHeight = Math.max(120, Math.min(e.data.height, maxHeight));
        setHeight(newHeight);
      }
      if (e.data.type === 'ul-widget-ready') {
        setLoaded(true);
        updateWidgetSurfaceStatus(surfaceId, 'ready');
      }
      if (e.data.type === 'ul-open-widget' && e.data.widgetName) {
        openWidgetWindow(buildWidgetNavigationTarget({
          appUuid,
          appSlug,
          appName: widgetName,
          widgetName,
          uiFunction: `widget_${widgetName}_ui`,
          dataFunction: `widget_${widgetName}_data`,
        }, e.data.widgetName), e.data.context);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [appSlug, appUuid, maxHeight, surfaceId, widgetName]);

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

  const handleIframeLoad = useCallback(() => {
    setLoaded(true);
    updateWidgetSurfaceStatus(surfaceId, 'ready');
  }, [surfaceId]);

  return (
    <div className="relative rounded-lg overflow-hidden border border-gray-200 bg-white shadow-sm">
      {/* Loading overlay */}
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50/80 z-10">
          <div className="w-4 h-4 rounded-full border-2 border-gray-300 border-t-gray-600 animate-spin" />
        </div>
      )}

      {/* Widget iframe */}
      <iframe
        ref={iframeRef}
        srcDoc={preparedHtml}
        sandbox="allow-scripts allow-same-origin"
        className="w-full border-0 transition-[height] duration-200"
        style={{ height: `${height}px` }}
        title={`Widget: ${widgetName}`}
        onLoad={handleIframeLoad}
      />
    </div>
  );
}
