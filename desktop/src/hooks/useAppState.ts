// Central app state — manages view routing + navigation history + project selection.

import { useState, useCallback, useRef } from 'react';

// ── Types ──

export type AppView =
  | { kind: 'home' }
  | { kind: 'agent'; agentId: string; initialMessage?: string }
  | { kind: 'new-chat'; initialMessage?: string }
  | { kind: 'library' }
  | { kind: 'marketplace' }
  | { kind: 'tool-detail'; appId: string; appName?: string }
  | { kind: 'author-profile'; handle: string }
  | { kind: 'profile' }
  | { kind: 'wallet' }
  | { kind: 'settings' };

export interface UseAppStateReturn {
  view: AppView;
  navigateHome: () => void;
  navigateToAgent: (agentId: string, initialMessage?: string) => void;
  navigateToNewChat: (initialMessage?: string) => void;
  navigateToLibrary: () => void;
  navigateToMarketplace: () => void;
  navigateToToolDetail: (appId: string, appName?: string) => void;
  navigateToAuthorProfile: (handle: string) => void;
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
  if (a.kind === 'author-profile' && b.kind === 'author-profile') return a.handle === b.handle;
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
  const navigateToNewChat = useCallback(
    (initialMessage?: string) => navigate({ kind: 'new-chat', initialMessage }),
    [navigate],
  );
  const navigateToLibrary = useCallback(() => navigate({ kind: 'library' }), [navigate]);
  const navigateToMarketplace = useCallback(() => navigate({ kind: 'marketplace' }), [navigate]);
  const navigateToToolDetail = useCallback((appId: string, appName?: string) => navigate({ kind: 'tool-detail', appId, appName }), [navigate]);
  const navigateToAuthorProfile = useCallback((handle: string) => navigate({ kind: 'author-profile', handle }), [navigate]);
  const navigateToProfile = useCallback(() => navigate({ kind: 'profile' }), [navigate]);
  const navigateToWallet = useCallback(() => navigate({ kind: 'wallet' }), [navigate]);
  const navigateToSettings = useCallback(() => navigate({ kind: 'settings' }), [navigate]);

  return {
    view,
    navigateHome,
    navigateToAgent,
    navigateToNewChat,
    navigateToLibrary,
    navigateToMarketplace,
    navigateToToolDetail,
    navigateToAuthorProfile,
    navigateToProfile,
    navigateToWallet,
    navigateToSettings,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
  };
}
