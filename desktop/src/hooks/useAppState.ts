// Central app state — manages view routing + navigation history + project selection.

import { useState, useCallback, useRef } from 'react';

// ── Types ──

export type AppView =
  | { kind: 'home' }
  | { kind: 'agent'; agentId: string; initialMessage?: string }
  | { kind: 'new-chat' }
  | { kind: 'library' }
  | { kind: 'tool-detail'; appId: string; appName?: string }
  | { kind: 'profile' }
  | { kind: 'wallet' }
  | { kind: 'settings' };

export interface UseAppStateReturn {
  view: AppView;
  navigateHome: () => void;
  navigateToAgent: (agentId: string, initialMessage?: string) => void;
  navigateToNewChat: () => void;
  navigateToLibrary: () => void;
  navigateToToolDetail: (appId: string, appName?: string) => void;
  navigateToProfile: () => void;
  navigateToWallet: () => void;
  navigateToSettings: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

// ── Storage keys ──

const STORAGE_VIEW = 'ul_current_view';

function getStoredView(): AppView {
  try {
    const raw = localStorage.getItem(STORAGE_VIEW);
    if (raw) {
      const parsed = JSON.parse(raw) as AppView;
      if (parsed && typeof parsed.kind === 'string') return parsed;
    }
  } catch {
    // ignore
  }
  return { kind: 'home' };
}

function storeView(view: AppView) {
  try {
    localStorage.setItem(STORAGE_VIEW, JSON.stringify(view));
  } catch {
    // ignore
  }
}

// ── Helpers ──

const MAX_HISTORY = 50;

function viewsEqual(a: AppView, b: AppView): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'agent' && b.kind === 'agent') return a.agentId === b.agentId;
  if (a.kind === 'tool-detail' && b.kind === 'tool-detail') return a.appId === b.appId;
  return true;
}

// ── Hook ──

export function useAppState(): UseAppStateReturn {
  const initialView = useRef(getStoredView()).current;
  const historyRef = useRef<{ stack: AppView[]; index: number }>({
    stack: [initialView],
    index: 0,
  });
  const [view, setView] = useState<AppView>(initialView);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  const syncState = useCallback(() => {
    const h = historyRef.current;
    const current = h.stack[h.index];
    setView(current);
    storeView(current);
    setCanGoBack(h.index > 0);
    setCanGoForward(h.index < h.stack.length - 1);
  }, []);

  const navigate = useCallback((newView: AppView) => {
    const h = historyRef.current;
    // Skip if navigating to same view
    if (viewsEqual(h.stack[h.index], newView)) return;
    // Truncate forward history and push
    h.stack = [...h.stack.slice(0, h.index + 1), newView];
    h.index = h.stack.length - 1;
    // Cap history size
    if (h.stack.length > MAX_HISTORY) {
      h.stack = h.stack.slice(-MAX_HISTORY);
      h.index = h.stack.length - 1;
    }
    syncState();
  }, [syncState]);

  const goBack = useCallback(() => {
    const h = historyRef.current;
    if (h.index > 0) {
      h.index -= 1;
      syncState();
    }
  }, [syncState]);

  const goForward = useCallback(() => {
    const h = historyRef.current;
    if (h.index < h.stack.length - 1) {
      h.index += 1;
      syncState();
    }
  }, [syncState]);

  const navigateHome = useCallback(() => navigate({ kind: 'home' }), [navigate]);
  const navigateToAgent = useCallback((agentId: string, initialMessage?: string) => navigate({ kind: 'agent', agentId, initialMessage }), [navigate]);
  const navigateToNewChat = useCallback(() => navigate({ kind: 'new-chat' }), [navigate]);
  const navigateToLibrary = useCallback(() => navigate({ kind: 'library' }), [navigate]);
  const navigateToToolDetail = useCallback((appId: string, appName?: string) => navigate({ kind: 'tool-detail', appId, appName }), [navigate]);
  const navigateToProfile = useCallback(() => navigate({ kind: 'profile' }), [navigate]);
  const navigateToWallet = useCallback(() => navigate({ kind: 'wallet' }), [navigate]);
  const navigateToSettings = useCallback(() => navigate({ kind: 'settings' }), [navigate]);

  return {
    view,
    navigateHome,
    navigateToAgent,
    navigateToNewChat,
    navigateToLibrary,
    navigateToToolDetail,
    navigateToProfile,
    navigateToWallet,
    navigateToSettings,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
  };
}
