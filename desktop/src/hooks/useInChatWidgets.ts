// In-chat widget discovery and resolution for connected apps.

import { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { executeAppMcpTool } from '../lib/api';
import { fetchFromApi, getToken } from '../lib/storage';
import {
  parseCanonicalWidgetUiToolName,
  type WidgetToolDescriptor,
} from '../lib/widgetContracts';
import { createDesktopLogger } from '../lib/logging';
import { loadWidgetHtml } from '../lib/widgetRuntime';

export interface WidgetMapping {
  appUuid: string;
  appSlug: string;
  appVersion?: string | null;
  widgetName: string;
  uiFunction: string;
  mappedFunctions: string[];
}

export interface ResolvedWidget {
  appUuid: string;
  appSlug: string;
  widgetName: string;
  html: string;
}

interface InChatWidgetState {
  mappings: Map<string, WidgetMapping>;
  ready: boolean;
}

interface InChatWidgetContextValue {
  getWidgetForFunction: (appId: string, functionName: string) => Promise<ResolvedWidget | null>;
  ready: boolean;
}

export const InChatWidgetContext = createContext<InChatWidgetContextValue>({
  getWidgetForFunction: async () => null,
  ready: false,
});

const inChatWidgetsLogger = createDesktopLogger('InChatWidgets');

async function fetchConnectedAppVersion(appUuid: string, token: string): Promise<string | null> {
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

export function useInChatWidgetContext() {
  return useContext(InChatWidgetContext);
}

/**
 * Discovers widget-capable functions across connected apps and provides
 * widget resolution for ToolCallCard rendering.
 *
 * @param connectedAppIds Array of connected app UUIDs
 */
export function useInChatWidgets(connectedAppIds: string[]) {
  const [state, setState] = useState<InChatWidgetState>({
    mappings: new Map(),
    ready: false,
  });
  const mountedRef = useRef(true);
  const discoveredRef = useRef(new Set<string>());

  const discoverAppWidgets = useCallback(async (appUuid: string): Promise<WidgetMapping[]> => {
    const token = getToken();
    if (!token) return [];

    try {
      const res = await fetchFromApi(`/mcp/${appUuid}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/list', params: {} }),
      });
      const data = await res.json();
      const tools: WidgetToolDescriptor[] = data?.result?.tools || [];
      const appVersion = await fetchConnectedAppVersion(appUuid, token);

      type ParsedUiTool = {
        tool: WidgetToolDescriptor;
        appSlug: string;
        widgetName: string;
      };
      const uiTools = tools
        .map((tool) => {
          const parsed = parseCanonicalWidgetUiToolName(tool.name);
          return parsed ? { tool, ...parsed } : null;
        })
        .filter((value): value is ParsedUiTool => value !== null);
      const mappings: WidgetMapping[] = [];

      const appSlugFromTools = uiTools[0]?.appSlug || '';
      const nonWidgetTools = tools.filter(t =>
        !t.name.includes('_widget_') && t.name.startsWith(appSlugFromTools + '_')
      );
      const allFnNames = nonWidgetTools.map(t => t.name.replace(appSlugFromTools + '_', ''));
      const isMultiWidget = uiTools.length > 1;

      for (const uiTool of uiTools) {
        const slug = uiTool.appSlug;
        const widgetName = uiTool.widgetName;

        let mappedFunctions: string[];

        if (isMultiWidget) {
          // Multi-widget app: only map functions whose names share a
          // distinguishing keyword with the widget name.
          // We exclude keywords that appear in ALL widget names (e.g. "email"
          // in both "email_inbox" and "email_faqs") since they can't disambiguate.
          const allWidgetNames = uiTools.map(t => t.widgetName);
          const allKeywords = allWidgetNames.flatMap(n => n.split('_').filter(k => k.length > 2));
          const keywordCounts = new Map<string, number>();
          for (const kw of allKeywords) {
            keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1);
          }
          const widgetKeywords = widgetName.split('_').filter(k =>
            k.length > 2 && (keywordCounts.get(k) || 0) < allWidgetNames.length
          );

          if (widgetKeywords.length === 0) {
            // No distinguishing keywords — can't auto-map, skip this widget.
            // Requires explicit manifest mapping (widget field on functions).
            continue;
          }

          mappedFunctions = allFnNames.filter(fn => {
            const fnLower = fn.toLowerCase();
            return widgetKeywords.some(kw => fnLower.includes(kw));
          });
        } else {
          mappedFunctions = allFnNames;
        }

        if (mappedFunctions.length > 0) {
          mappings.push({
            appUuid, appSlug: slug, appVersion, widgetName,
            uiFunction: `widget_${widgetName}_ui`,
            mappedFunctions,
          });
        }
      }

      return mappings;
    } catch (e) {
      inChatWidgetsLogger.warn('Failed to discover in-chat widgets for app', { appUuid, error: e });
      return [];
    }
  }, []);

  useEffect(() => {
    if (connectedAppIds.length === 0) {
      setState({ mappings: new Map(), ready: true });
      return;
    }

    mountedRef.current = true;

    const discover = async () => {
      const newMappings = new Map<string, WidgetMapping>();

      await Promise.all(
        connectedAppIds.map(async (appUuid) => {
          if (discoveredRef.current.has(appUuid)) return;
          discoveredRef.current.add(appUuid);

          const appMappings = await discoverAppWidgets(appUuid);
          for (const mapping of appMappings) {
            for (const fn of mapping.mappedFunctions) {
              newMappings.set(`${appUuid}:${fn}`, mapping);
            }
          }
        })
      );

      if (mountedRef.current) {
        setState(prev => {
          const merged = new Map(prev.mappings);
          for (const [key, val] of newMappings) {
            merged.set(key, val);
          }
          return { mappings: merged, ready: true };
        });
      }
    };

    discover();

    return () => { mountedRef.current = false; };
  }, [connectedAppIds, discoverAppWidgets]);

  const getWidgetForFunction = useCallback(async (
    appId: string,
    functionName: string,
  ): Promise<ResolvedWidget | null> => {
    const mapping = state.mappings.get(`${appId}:${functionName}`);
    if (!mapping) return null;

    try {
      const result = await loadWidgetHtml(mapping, { executor: executeAppMcpTool });
      if (result?.html) {
        return {
          appUuid: mapping.appUuid,
          appSlug: mapping.appSlug,
          widgetName: mapping.widgetName,
          html: result.html,
        };
      }

      return null;
    } catch {
      return null;
    }
  }, [state.mappings]);

  return {
    getWidgetForFunction,
    ready: state.ready,
    mappings: state.mappings,
  };
}
