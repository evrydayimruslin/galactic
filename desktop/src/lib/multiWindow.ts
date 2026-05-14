// Multi-window management — opens subagent chats, widget apps, and any view in separate Tauri windows.
// Uses @tauri-apps/api/webviewWindow to create new windows.

import { WebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';
import { buildWidgetWindowSearchParams, type WidgetAppSource } from './widgetRuntime';

/** Any view that can be opened in its own window. */
export type PopoutView =
  | { kind: 'home' }
  | { kind: 'library' }
  | { kind: 'marketplace' }
  | { kind: 'profile' }
  | { kind: 'wallet' }
  | { kind: 'settings' }
  | { kind: 'chat'; agentId: string; agentName: string };

/**
 * Open a new window for a subagent's chat.
 * If a window with the same label already exists, focuses it instead.
 */
export async function openSubagentWindow(agentId: string, agentName: string): Promise<void> {
  const label = `subagent-${agentId.slice(0, 8)}`;

  // Check if window already exists — focus it if so
  const existingWindows = await getAllWebviewWindows();
  const existing = existingWindows.find(w => w.label === label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  // Create new window with subagent query param
  const _webview = new WebviewWindow(label, {
    url: `index.html?subagent=${encodeURIComponent(agentId)}`,
    title: `${agentName} — Ultralight`,
    width: 700,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    center: true,
    decorations: true,
    resizable: true,
  });

  // No need to await — window opens asynchronously
}

/**
 * Open a new window for a widget app.
 * Passes WidgetAppSource fields via query params; the window reads
 * the token from shared secure storage-backed state and apiBase from the
 * build-pinned desktop environment, then fetches its own HTML.
 */
export async function openWidgetWindow(source: WidgetAppSource, context?: Record<string, string>): Promise<void> {
  // Include context in label so different contexts open different windows
  const ctxSuffix = context ? '-' + Object.values(context).join('').slice(0, 8) : '';
  const label = `widget-${source.appUuid.slice(0, 8)}-${source.widgetName}${ctxSuffix}`;

  const existingWindows = await getAllWebviewWindows();
  const existing = existingWindows.find(w => w.label === label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const params = buildWidgetWindowSearchParams(source, context);

  const _webview = new WebviewWindow(label, {
    url: `index.html?${params.toString()}`,
    title: `${source.appName} — Ultralight`,
    width: 800,
    height: 650,
    minWidth: 450,
    minHeight: 350,
    center: true,
    decorations: true,
    resizable: true,
  });
}

const VIEW_TITLES: Record<string, string> = {
  home: 'Command',
  library: 'Tools',
  marketplace: 'Market',
  profile: 'Profile',
  wallet: 'Wallet',
  settings: 'Settings',
};

/**
 * Open any view in its own window.
 * Singleton views (home, capabilities, etc.) allow one instance; chats allow one per agent.
 */
export async function openViewWindow(popout: PopoutView): Promise<void> {
  const label = popout.kind === 'chat'
    ? `chat-${popout.agentId.slice(0, 8)}`
    : `view-${popout.kind}`;

  const existingWindows = await getAllWebviewWindows();
  const existing = existingWindows.find(w => w.label === label);
  if (existing) {
    await existing.setFocus();
    return;
  }

  const params = new URLSearchParams({ view: popout.kind });
  if (popout.kind === 'chat') {
    params.set('agentId', popout.agentId);
    params.set('agentName', popout.agentName);
  }

  const title = popout.kind === 'chat'
    ? `${popout.agentName} — Ultralight`
    : `${VIEW_TITLES[popout.kind] || popout.kind} — Ultralight`;

  const _webview = new WebviewWindow(label, {
    url: `index.html?${params.toString()}`,
    title,
    width: 900,
    height: 700,
    minWidth: 500,
    minHeight: 400,
    center: true,
    decorations: true,
    resizable: true,
  });
}
