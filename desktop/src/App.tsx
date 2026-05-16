// Root component — auth gate + view routing + sidebar + top toolbar.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  DEFAULT_HEAVY_MODEL,
  fetchFromApi,
  getToken,
  isOnboardingComplete,
  resetOnboarding,
  setOnboardingComplete,
} from './lib/storage';
import { useAppState } from './hooks/useAppState';
import { useDeepLink } from './hooks/useDeepLink';
import { useDesktopUpdater } from './hooks/useDesktopUpdater';
import { type Agent, useAgentFleet } from './hooks/useAgentFleet';
import { deriveSystemAgentId, isSystemAgentType, SYSTEM_AGENTS } from './lib/systemAgents';
import { openViewWindow } from './lib/multiWindow';
import AuthGate from './components/AuthGate';
import CmdKPalette, { buildPaletteActions } from './components/CmdKPalette';
import DesktopUpdateToast from './components/DesktopUpdateToast';
import OnboardingWizard, { type OnboardingHighlight } from './components/OnboardingWizard';
import ChatView from './components/ChatView';
import CommandHomescreen from './components/CommandHomescreen';
import LibraryView from './components/LibraryView';
import MarketplaceView from './components/MarketplaceView';
import AuthorProfileView from './components/AuthorProfileView';
import ProfileView from './components/ProfileView';
import ToolDetailView from './components/ToolDetailView';
import NavSidebar from './components/NavSidebar';
import TopToolbar from './components/TopToolbar';
import WebPanel from './components/WebPanel';
import SpendingSettings from './components/SpendingSettings';
import { createDesktopLogger } from './lib/logging';

const appLogger = createDesktopLogger('App');

/**
 * Pre-provision the user's OpenRouter key in the background.
 * Called once after login — creates a per-user sub-key via the
 * OpenRouter Management API so the first chat doesn't timeout.
 */
function provisionKeyInBackground(token: string) {
  fetchFromApi('/chat/provision-key', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.ok) {
        appLogger.debug('OpenRouter key provisioned');
      } else {
        appLogger.warn('OpenRouter key provisioning failed', { error: data.error });
      }
    })
    .catch((err) => appLogger.warn('OpenRouter key provisioning errored', { error: err }));
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingHighlight, setOnboardingHighlight] = useState<OnboardingHighlight>('none');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const desktopUpdater = useDesktopUpdater();
  const {
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
  } = useAppState();
  const {
    agents,
    deleteAgent,
    stopAgent,
    isAgentRunning,
    setActiveAgent,
    refreshAgents,
    newSession,
  } = useAgentFleet();
  const systemAgentsProvisioned = useRef(false);

  // Provision canonical system agents if they are missing from the local DB.
  const provisionSystemAgents = useCallback(async () => {
    if (systemAgentsProvisioned.current) return;
    systemAgentsProvisioned.current = true;
    try {
      const existing = await invoke<Agent[]>('db_list_system_agents');
      const existingTypes = new Set(
        existing
          .map((agent) => agent.system_agent_type)
          .filter(isSystemAgentType),
      );
      const userId = getToken() || 'default';
      let created = 0;
      for (const config of SYSTEM_AGENTS) {
        if (existingTypes.has(config.type)) continue;

        const id = await deriveSystemAgentId(userId, config.type);
        const conversationId = await deriveSystemAgentId(userId, config.type + ':conv');

        await invoke('db_create_agent', {
          id,
          conversationId,
          name: config.name,
          role: config.role,
          systemPrompt: null,
          initialTask: null,
          projectDir: null,
          model: DEFAULT_HEAVY_MODEL,
          parentAgentId: null,
          permissionLevel: 'auto_edit',
          adminNotes: null,
          endGoal: null,
          context: null,
          launchMode: 'discuss_first',
          connectedAppIds: null,
          connectedApps: null,
          isSystem: 1,
          systemAgentType: config.type,
        });
        created++;
      }

      if (created > 0) {
        appLogger.info('Provisioned missing system agents', { created });
      }
      await refreshAgents();
    } catch (err) {
      appLogger.warn('System agent provisioning failed', { error: err });
      systemAgentsProvisioned.current = false; // retry next time
    }
  }, [refreshAgents]);

  // Check for existing token on mount + provision key
  useEffect(() => {
    const token = getToken();
    if (token) {
      setAuthenticated(true);
      provisionKeyInBackground(token);
      provisionSystemAgents();
    }
    setChecking(false);
  }, [provisionSystemAgents]);

  // ── postMessage bridge from embedded web iframes ──
  // The unified /app/:id store page (loaded in WebPanel) and the Market
  // tab (loaded via /capabilities) both post messages to us. We handle:
  //   - { type: 'navigate', to: 'tool-detail', appId, appName? }
  //       → flip the current view to the store page for that app
  //   - { type: 'library-changed', ... }
  //       → no-op for now (v2 may refresh cached library state)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'navigate' && data.to === 'tool-detail' && typeof data.appId === 'string') {
        navigateToToolDetail(data.appId, typeof data.appName === 'string' ? data.appName : undefined);
      }
      // Future: library-changed could invalidate cached state in other iframes
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [navigateToToolDetail]);

  // ── Deep-link routing (Phase 3) ──
  // Listens for `ultralight://app/:id` URLs delivered by the Rust side,
  // routes them to the app-store view. URLs received before auth is ready
  // are queued and drained once `authenticated && !checking` flips true.
  useDeepLink({ navigateToToolDetail }, authenticated && !checking);

  // All hooks must be declared before any early returns
  const handleAuthenticated = useCallback(() => {
    setAuthenticated(true);
    const token = getToken();
    if (token) {
      provisionKeyInBackground(token);
      provisionSystemAgents();
    }
    // Show onboarding for first-time users
    if (!isOnboardingComplete()) {
      setShowOnboarding(true);
    }
  }, []);

  // Onboarding's step 3 composer hands off a draft prompt; the new chat
  // mounts with the draft pre-seeded as its initialMessage so the user's
  // first message ends the tour and starts the work in one motion. (E3)
  const handleOnboardingComplete = useCallback((navigateTo?: 'chat' | 'tools', draftPrompt?: string) => {
    setOnboardingComplete();
    setShowOnboarding(false);
    setOnboardingHighlight('none');
    if (navigateTo === 'tools') navigateToLibrary();
    else if (navigateTo === 'chat') navigateToNewChat(draftPrompt);
  }, [navigateToLibrary, navigateToNewChat]);

  const handleShowTutorial = useCallback(() => {
    resetOnboarding();
    setShowOnboarding(true);
  }, []);

  // Dismiss tutorial when user navigates via sidebar
  const dismissTutorial = useCallback(() => {
    if (showOnboarding) {
      setOnboardingComplete();
      setShowOnboarding(false);
      setOnboardingHighlight('none');
    }
  }, [showOnboarding]);

  const handleSelectAgent = useCallback((agentId: string) => {
    navigateToAgent(agentId);
  }, [navigateToAgent]);

  // ── Cmd+K / Ctrl+K palette ──
  // Only attaches once the user is authenticated so the keystroke doesn't
  // collide with the auth screen / onboarding wizard's own input handlers.
  useEffect(() => {
    if (!authenticated || showOnboarding) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen(open => !open);
      } else if (e.key === 'Escape' && cmdkOpen) {
        e.preventDefault();
        setCmdkOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authenticated, showOnboarding, cmdkOpen]);

  // Pull live system-agent fleet entries so the palette dispatches to the
  // user's actual agent IDs, not the canonical configs.
  const systemAgentFleet = useMemo(() => {
    const byType = new Map<string, Agent>();
    for (const a of agents) {
      if (a.system_agent_type && !byType.has(a.system_agent_type)) {
        byType.set(a.system_agent_type, a);
      }
    }
    return SYSTEM_AGENTS.map(cfg => ({ config: cfg, agent: byType.get(cfg.type) }))
      .filter((s): s is { config: typeof SYSTEM_AGENTS[number]; agent: Agent } => !!s.agent);
  }, [agents]);

  const paletteActions = useMemo(
    () =>
      buildPaletteActions({
        systemAgents: systemAgentFleet.map(s => s.config),
        onPickSystemAgent: (cfg) => {
          const entry = systemAgentFleet.find(s => s.config.type === cfg.type);
          if (entry) navigateToAgent(entry.agent.id);
        },
        onNewChat: () => {
          setActiveAgent(null);
          navigateToNewChat();
        },
        onTopUp: navigateToWallet,
        onSettings: navigateToSettings,
        onProfile: navigateToProfile,
      }),
    [systemAgentFleet, navigateToAgent, setActiveAgent, navigateToNewChat, navigateToWallet, navigateToSettings, navigateToProfile],
  );

  const [newChatKey, setNewChatKey] = useState(0);
  const handleNewAgent = useCallback(() => {
    setActiveAgent(null);
    setNewChatKey((k) => k + 1);
    navigateToNewChat();
  }, [setActiveAgent, navigateToNewChat]);

  const handleDeleteAgent = useCallback(async (id: string) => {
    await deleteAgent(id);
    // If viewing the deleted agent, go home
    if (view.kind === 'agent' && view.agentId === id) {
      navigateHome();
    }
  }, [deleteAgent, view, navigateHome]);

  const handleStopAgent = useCallback((id: string) => {
    stopAgent(id);
  }, [stopAgent]);

  const handleNewSession = useCallback(async (id: string) => {
    await newSession(id);
  }, [newSession]);

  const handleRenameAgent = useCallback(async (id: string, newName: string) => {
    await invoke('db_update_agent', {
      id,
      name: newName,
      status: null,
      adminNotes: null,
      endGoal: null,
      context: null,
      permissionLevel: null,
      model: null,
      projectDir: null,
      connectedAppIds: null,
      connectedApps: null,
      initialTask: null,
      stateSummary: null,
      systemAgentType: null,
    });
    await refreshAgents();
  }, [refreshAgents]);

  // Create a new independent session of a system agent and open it in a window
  const handleNewSystemAgentSession = useCallback(async (agentType: string, agentName: string) => {
    try {
      const id = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const config = SYSTEM_AGENTS.find((c) => c.type === agentType);
      if (!config) return;

      // Copy model from the canonical agent if it exists
      const canonical = agents.find((a) => a.is_system === 1 && a.system_agent_type === agentType);
      const model = canonical?.model || DEFAULT_HEAVY_MODEL;

      // Auto-increment instance number
      const instanceCount = agents.filter((a) => a.system_agent_type === agentType).length;
      const instanceName = `${agentName} (${instanceCount})`;

      await invoke('db_create_agent', {
        id,
        conversationId,
        name: instanceName,
        role: config.role,
        systemPrompt: null,
        initialTask: null,
        projectDir: canonical?.project_dir || null,
        model,
        parentAgentId: null,
        permissionLevel: 'auto_edit',
        adminNotes: null,
        endGoal: null,
        context: null,
        launchMode: 'discuss_first',
        connectedAppIds: null,
        connectedApps: null,
        isSystem: 1,
        systemAgentType: agentType,
      });

      await refreshAgents();
      openViewWindow({ kind: 'chat', agentId: id, agentName: instanceName });
    } catch (err) {
      appLogger.warn('Failed to create system agent session', { error: err });
    }
  }, [agents, refreshAgents]);

  // ── View caching: keep visited views mounted but hidden ──
  // Track which singleton views have been visited so we mount them once
  // and hide with CSS instead of unmounting. Agent views are cached by ID.
  // NOTE: These hooks must be before early returns to satisfy Rules of Hooks.
  const [mountedViews, setMountedViews] = useState<Set<string>>(() => new Set([view.kind]));
  const [mountedAgents, setMountedAgents] = useState<Set<string>>(() =>
    view.kind === 'agent' ? new Set([view.agentId]) : new Set()
  );

  // Update mounted sets when view changes
  useEffect(() => {
    if (view.kind === 'agent') {
      setMountedAgents((prev) => {
        if (prev.has(view.agentId)) return prev;
        return new Set(prev).add(view.agentId);
      });
    }
    // 'tool-detail' and 'author-profile' are intentionally NOT cached —
    // we unmount each visit so switching between different apps/authors
    // always refetches. Visits are short-lived (info pages) so there's
    // no perf cost.
    if (view.kind === 'tool-detail' || view.kind === 'author-profile') return;
    setMountedViews((prev) => {
      if (prev.has(view.kind)) return prev;
      return new Set(prev).add(view.kind);
    });
  }, [view]);

  // Collect the set of agent IDs we should keep cached
  // (prune agents that were deleted from the fleet)
  const agentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);
  const cachedAgentIds = useMemo(
    () => [...mountedAgents].filter((id) => agentIds.has(id)),
    [mountedAgents, agentIds],
  );

  // Loading state
  if (checking) {
    return (
      <>
        <div className='flex items-center justify-center h-full bg-white'>
          <p className='text-body text-ul-text-muted'>Loading...</p>
        </div>
        <DesktopUpdateToast updater={desktopUpdater} />
      </>
    );
  }

  // Auth gate
  if (!authenticated) {
    return (
      <>
        <AuthGate onAuthenticated={handleAuthenticated} />
        <DesktopUpdateToast updater={desktopUpdater} />
      </>
    );
  }

  // Helper: style to show/hide cached views
  const paneStyle = (visible: boolean): React.CSSProperties => ({
    display: visible ? 'flex' : 'none',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    flexDirection: 'column' as const,
  });

  return (
    <>
      <div className='flex flex-col h-full'>
        <TopToolbar />
        <div className='flex flex-1 min-h-0'>
          <NavSidebar
            agents={agents}
            activeView={view}
            isOpen={sidebarOpen}
            onboardingHighlight={onboardingHighlight}
            onShowTutorial={handleShowTutorial}
            onNavigateHome={() => {
              dismissTutorial();
              navigateHome();
            }}
            onNavigateToLibrary={() => {
              dismissTutorial();
              navigateToLibrary();
            }}
            onNavigateToMarketplace={() => {
              dismissTutorial();
              navigateToMarketplace();
            }}
            onNavigateToProfile={() => {
              dismissTutorial();
              navigateToProfile();
            }}
            onNavigateToWallet={() => {
              dismissTutorial();
              navigateToWallet();
            }}
            onNavigateToSettings={() => {
              dismissTutorial();
              navigateToSettings();
            }}
            onSelectAgent={(id) => {
              dismissTutorial();
              handleSelectAgent(id);
            }}
            onNewAgent={() => {
              dismissTutorial();
              handleNewAgent();
            }}
            onDeleteAgent={handleDeleteAgent}
            onStopAgent={handleStopAgent}
            onNewSession={handleNewSession}
            onRenameAgent={handleRenameAgent}
            isAgentRunning={isAgentRunning}
            onOpenInNewWindow={openViewWindow}
            onNewSystemAgentSession={handleNewSystemAgentSession}
          />

          {/* Content area — relative container so onboarding overlay stays within */}
          <div className='relative flex-1 flex flex-col min-w-0 min-h-0'>
            {/* Cached singleton views — mounted once, then shown/hidden */}
            {mountedViews.has('home') && (
              <div style={paneStyle(view.kind === 'home')}>
                <CommandHomescreen />
              </div>
            )}

            {mountedViews.has('library') && (
              <div style={paneStyle(view.kind === 'library')}>
                <LibraryView onOpenTool={navigateToToolDetail} />
              </div>
            )}

            {mountedViews.has('marketplace') && (
              <div style={paneStyle(view.kind === 'marketplace')}>
                <MarketplaceView onOpenTool={navigateToToolDetail} onOpenAuthor={navigateToAuthorProfile} />
              </div>
            )}

            {
              /*
          Tool detail view — NOT cached in mountedViews. Only rendered while
          the current view is 'tool-detail', so it unmounts on navigation
          away. Key on appId so switching between tools forces a fresh fetch.
        */
            }
            {view.kind === 'tool-detail' && (
              <div style={paneStyle(true)}>
                <ToolDetailView
                  key={view.appId}
                  appId={view.appId}
                  fallbackName={view.appName}
                  onOpenAuthor={navigateToAuthorProfile}
                />
              </div>
            )}

            {view.kind === 'author-profile' && (
              <div style={paneStyle(true)}>
                <AuthorProfileView
                  key={view.handle}
                  handle={view.handle}
                  onOpenTool={navigateToToolDetail}
                  onBack={navigateToMarketplace}
                />
              </div>
            )}

            {mountedViews.has('profile') && (
              <div style={paneStyle(view.kind === 'profile')}>
                <ProfileView />
              </div>
            )}

            {mountedViews.has('wallet') && (
              <div style={paneStyle(view.kind === 'wallet')}>
                <WebPanel path='/wallet' title='Wallet' />
              </div>
            )}

            {mountedViews.has('settings') && (
              <div style={paneStyle(view.kind === 'settings')}>
                <WebPanel path='/settings' title='Settings' headerExtra={<SpendingSettings />} />
              </div>
            )}

            {/* New-chat view — uses key to force fresh instance. The
                onboarding wizard can seed an initialMessage via
                navigateToNewChat(draftPrompt) so the user's first
                composer keystroke ends the tour (E3). */}
            {view.kind === 'new-chat' && (
              <div style={paneStyle(true)}>
                <ChatView
                  key={`new-chat-${newChatKey}`}
                  initialMessage={view.initialMessage}
                  onNavigateHome={navigateHome}
                  onNavigateToAgent={navigateToAgent}
                />
              </div>
            )}

            {/* Cached agent ChatViews — one per visited agent */}
            {cachedAgentIds.map((agentId) => (
              <div
                key={agentId}
                style={paneStyle(view.kind === 'agent' && view.agentId === agentId)}
              >
                <ChatView
                  agentId={agentId}
                  initialMessage={view.kind === 'agent' && view.agentId === agentId
                    ? view.initialMessage
                    : undefined}
                  onNavigateHome={navigateHome}
                  onNavigateToAgent={navigateToAgent}
                  onShowTutorial={handleShowTutorial}
                />
              </div>
            ))}

            {/* Onboarding wizard overlay — inside content area, beside sidebar */}
            {showOnboarding && (
              <OnboardingWizard
                onComplete={handleOnboardingComplete}
                onHighlight={setOnboardingHighlight}
              />
            )}
            <CmdKPalette
              open={cmdkOpen}
              onClose={() => setCmdkOpen(false)}
              actions={paletteActions}
            />
          </div>
        </div>
      </div>
      <DesktopUpdateToast updater={desktopUpdater} />
    </>
  );
}
