// Main chat interface — assembles message list + input + sidebar.

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useChat } from '../hooks/useChat';
import { useMcp } from '../hooks/useMcp';
import { useLocalTools, type AgentToolContext } from '../hooks/useLocalTools';
import { useProjectDir } from '../hooks/useProjectDir';
import { usePermissions } from '../hooks/usePermissions';
import { useConversations } from '../hooks/useConversations';
import { useAgentFleet } from '../hooks/useAgentFleet';
import MessageList from './MessageList';
import ChatInput, { type ChatFile } from './ChatInput';
import PermissionModal from './PermissionModal';
import SpendingApprovalModal from './SpendingApprovalModal';
import AgentHeader from './AgentHeader';
import DiscoverWidget from './DiscoverWidget';
import {
  DEFAULT_HEAVY_MODEL,
  DEFAULT_INTERPRETER_MODEL,
  clearToken,
  fetchFromApi,
  getToken,
  getApiBase,
  getModel,
  getInterpreterModel,
  getHeavyModel,
  getInferencePreference,
  setInferencePreference,
} from '../lib/storage';
import { getContextWindow } from '../lib/tokens';
import { buildSystemPrompt, buildCodeModeAppsPrompt } from '../lib/systemPrompt';
import { SYSTEM_AGENTS } from '../lib/systemAgents';
import { gatherProjectContext } from '../lib/projectContext';
import { parseFileOperations } from '../lib/parseFileOps';
import { updateSystemAgentState, maybeEmbedConversation } from '../lib/agentStateSummary';
import {
  buildInferenceSetupPrompt,
  confirmExecutionPlan,
  fetchFunctionIndex,
  fetchInferenceSettings,
  fetchTaskContext,
  streamOrchestrate,
  streamChat,
  type InferenceSetupAction,
  type InferenceSetupPrompt,
} from '../lib/api';
import type { ExecutionPlan } from '../types/executionPlan';
import { agentRunner } from '../lib/agentRunner';
import { dispatchAmbientSuggestions, useAmbientSuggestions } from '../hooks/useAmbientSuggestions';
import { createDesktopLogger } from '../lib/logging';
import { openViewWindow } from '../lib/multiWindow';
import type { AmbientSuggestion } from '../types/ambientSuggestion';
import { subscribeAgenticSurfaces } from '../lib/widgetSurfaceRegistry';
import {
  buildActiveAgenticSurfaceContext,
  type ActiveAgenticSurface,
} from '../lib/widgetAgentTypes';

/** Map flash broker's model suggestion to a real OpenRouter model ID */
function resolveModelFromBroker(suggestion?: string): string | undefined {
  if (!suggestion) return undefined;
  switch (suggestion.toLowerCase()) {
    case 'flash':
      return DEFAULT_INTERPRETER_MODEL;
    case 'sonnet':
    case 'opus':
      return DEFAULT_HEAVY_MODEL;
    default:
      // If the broker returns a full model ID, use it directly
      if (suggestion.includes('/')) return suggestion;
      return undefined;
  }
}

/** Parse "flash → heavy" model string from agent record, falling back to localStorage globals */
function parseAgentModels(agentModel: string | null): { interpreter: string; heavy: string } {
  if (agentModel) {
    const parts = agentModel.split('→').map(s => s.trim());
    if (parts[0] && parts[1]) return { interpreter: parts[0], heavy: parts[1] };
    if (parts[0]) return { interpreter: parts[0], heavy: getHeavyModel() };
  }
  return { interpreter: getInterpreterModel(), heavy: getHeavyModel() };
}

interface ChatViewProps {
  agentId?: string | null;
  /** Initial message to send automatically when navigating with a new session instruction */
  initialMessage?: string;
  onNavigateHome?: () => void;
  onNavigateToAgent?: (agentId: string) => void;
  onShowTutorial?: () => void;
}

const chatViewLogger = createDesktopLogger('ChatView');

export default function ChatView({
  agentId,
  initialMessage,
  onNavigateHome,
  onNavigateToAgent,
  onShowTutorial,
}: ChatViewProps = {}) {
  const { tools: mcpTools, executeToolCall: executeMcpTool } = useMcp();
  const { tools: localTools, executeToolCall: executeLocalTool, isLocalTool } = useLocalTools();
  const { projectDir, pickDirectory } = useProjectDir();
  const {
    level: permissionLevel,
    setLevel: setPermissionLevel,
    pendingRequest,
    checkPermission,
    allow,
    alwaysAllow,
    deny,
    pendingSpending,
    approveSpending,
    denySpending,
  } = usePermissions();
  const {
    conversations: _conversations,
    activeId,
    createConversation,
    loadConversation,
    switchConversation,
    saveMessages,
    deleteConversation: _deleteConversation,
    refreshList: _refreshList,
    searchConversations: _searchConversations,
  } = useConversations();
  const {
    agents,
    activeAgent,
    createAgent,
    startAgent,
    stopAgent,
    deleteAgent,
    setActiveAgent,
    refreshAgents,
    isAgentRunning,
    newSession,
  } = useAgentFleet();

  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [inferenceNotice, setInferenceNotice] = useState<InferenceSetupPrompt | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [ambientOpen, setAmbientOpen] = useState(false);
  const {
    suggestions: ambientSuggestions,
    hasNew: ambientHasNew,
    markViewed: markAmbientViewed,
    dismissSuggestion: dismissAmbientSuggestion,
    acceptSuggestion: acceptAmbientSuggestion,
  } = useAmbientSuggestions();

  // Per-conversation project directory (persisted to agent DB record)
  const [conversationProjectDir, setConversationProjectDir] = useState<string | null>(null);
  const conversationProjectDirRef = useRef<string | null>(null);
  const pendingFilesRef = useRef<ChatFile[] | null>(null);
  useEffect(() => { conversationProjectDirRef.current = conversationProjectDir; }, [conversationProjectDir]);

  // Track whether the active conversation uses the orchestrate endpoint (no local agent loop)
  const isOrchestratedRef = useRef(false);

  // Signal for force-saving after orchestrate stream completes
  const orchestrateSaveNeeded = useRef(false);

  // Pre-chat connected apps (legacy — kept for backwards compat)
  const [preChatApps, setPreChatApps] = useState<Array<{ id: string; name: string; description: string | null; functionCount: number }>>([]);
  const [preChatAppQuery, setPreChatAppQuery] = useState('');
  const [preChatAppResults, setPreChatAppResults] = useState<Array<{ id: string; name: string; description: string | null; functionCount: number }>>([]);
  const [preChatSearching, setPreChatSearching] = useState(false);
  const preChatSearchRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Pre-chat scope (for new chats — restricts apps/functions/data before agent creation)
  interface PreChatScopeFn { name: string; description: string; selected: boolean }
  interface PreChatScopeApp {
    id: string;
    slug: string;
    name: string;
    access: 'all' | 'functions' | 'data';
    functions: PreChatScopeFn[];
    expanded: boolean;
  }
  interface PreChatAppEntry { id: string; slug: string; name: string; description: string | null; functions: PreChatScopeFn[] }
  const [preChatScope, setPreChatScope] = useState<PreChatScopeApp[]>([]);
  const [preChatAllApps, setPreChatAllApps] = useState<PreChatAppEntry[]>([]);
  const [preChatAppsLoading, setPreChatAppsLoading] = useState(false);

  // Refs for stable closure access in callbacks (activeAgent, preChatScope)
  const preChatScopeRef = useRef(preChatScope);
  preChatScopeRef.current = preChatScope;
  const activeAgentRef = useRef(activeAgent);
  activeAgentRef.current = activeAgent;
  const activeAgenticSurfacesRef = useRef<ActiveAgenticSurface[]>([]);

  useEffect(() => subscribeAgenticSurfaces((surfaces) => {
    activeAgenticSurfacesRef.current = surfaces;
  }), []);

  // Fetch all user apps for pre-chat scope dropdown (once)
  const preChatAppsFetchedRef = useRef(false);
  useEffect(() => {
    if (!executeMcpTool || preChatAppsFetchedRef.current) return;
    preChatAppsFetchedRef.current = true;
    setPreChatAppsLoading(true);
    executeMcpTool('ul_discover', { scope: 'library' })
      .then(result => {
        const parsed = JSON.parse(result);
        let apps: PreChatAppEntry[] = [];

        // Shape 1: structured array in .library (no library.md fallback)
        if (Array.isArray(parsed.library)) {
          apps = parsed.library
            .filter((r: { type?: string }) => r.type === 'app')
            .map((r: { id: string; slug?: string; name: string; description?: string }) => ({
              id: r.id, slug: r.slug || r.id, name: r.name, description: r.description || null, functions: [],
            }));
        }
        // Shape 2: markdown string in .library — parse "## app-slug\nDescription\n\nFunctions:\n- fn(args): desc"
        else if (typeof parsed.library === 'string') {
          const md = parsed.library as string;
          const sections = md.split(/^## /gm).filter(Boolean);
          for (const section of sections) {
            const lines = section.split('\n');
            const name = lines[0]?.trim();
            if (!name) continue;
            if (name.startsWith('#') || name === 'Saved Apps' || name === 'Saved Pages' || name === 'Library') continue;
            const desc = lines[1]?.trim() || null;
            // Parse functions: lines starting with "- fn_name(args): description"
            const fns: PreChatScopeFn[] = [];
            for (const line of lines) {
              const fnMatch = line.match(/^- (\w+)\(.*?\)(?::\s*(.*))?$/);
              if (fnMatch) {
                fns.push({ name: fnMatch[1], description: fnMatch[2] || '', selected: true });
              }
            }
            apps.push({ id: name, slug: name, name, description: desc, functions: fns });
          }
        }
        // Shape 3: .results array (query search response)
        else if (parsed.results) {
          apps = parsed.results.map((r: { id: string; slug?: string; name: string; description?: string }) => ({
            id: r.id, slug: r.slug || r.id, name: r.name, description: r.description || null, functions: [],
          }));
        }

        // Deduplicate by slug
        const seen = new Set<string>();
        apps = apps.filter(a => { if (seen.has(a.slug)) return false; seen.add(a.slug); return true; });
        chatViewLogger.debug('Loaded scope apps for dropdown', { count: apps.length });
        setPreChatAllApps(apps);
      })
      .catch(err => {
        chatViewLogger.error('Failed to load scope apps', { error: err });
        setPreChatAllApps([]);
      })
      .finally(() => setPreChatAppsLoading(false));
  }, [executeMcpTool]);

  // Detect if we're in a system agent context (routes through Flash pipeline instead of agent loop)
  const systemAgentConfig = useMemo(() => {
    if (!activeAgent?.is_system || !activeAgent.system_agent_type) return null;
    return SYSTEM_AGENTS.find(c => c.type === activeAgent.system_agent_type) || null;
  }, [activeAgent?.is_system, activeAgent?.system_agent_type]);

  const systemAgentContext = useMemo(() => {
    if (!systemAgentConfig) return null;
    return { type: systemAgentConfig.type, persona: systemAgentConfig.persona, skillsPath: systemAgentConfig.skillsPath };
  }, [systemAgentConfig]);

  // Build system prompt — regular agents only (system agents use Flash persona injection server-side)
  const baseSystemPrompt = useMemo(() => buildSystemPrompt(conversationProjectDir, getModel()), [conversationProjectDir]);
  const [systemPrompt, setSystemPrompt] = useState(baseSystemPrompt);

  // Keep in sync when conversationProjectDir changes
  useEffect(() => {
    setSystemPrompt(buildSystemPrompt(conversationProjectDir, getModel()));
  }, [conversationProjectDir]);

  // Merge tool sets — system agents don't need tools (Flash handles them server-side)
  const allTools = useMemo(() => {
    if (conversationProjectDir) {
      return [...mcpTools, ...localTools];
    }
    return mcpTools;
  }, [mcpTools, localTools, conversationProjectDir]);


  // Ref for stable tool call reference (avoids stale closures in spawned agents)
  const handleToolCallRef = useRef<(name: string, args: Record<string, unknown>) => Promise<string>>(null!);

  // Unified tool executor — routes to local or MCP, with permission gate
  const handleToolCall = useCallback(async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> => {
    // Only gate local tools (MCP platform tools go through server-side auth)
    if (isLocalTool(name)) {
      if (!conversationProjectDirRef.current) {
        return 'Error: No project directory selected. Please open a folder first.';
      }

      // Permission check — may show modal and block until user responds
      const allowed = await checkPermission(name, args);
      if (!allowed) {
        return 'Permission denied by user.';
      }

      // Build agent context for JS-handled tools (spawn_agent, check_agent, update_card_status, card reports)
      const agentCtx: AgentToolContext = {
        createAgent,
        startAgent,
        parentAgentId: activeAgent?.id ?? null,
        currentAgentId: activeAgent?.id ?? null,
        currentCardId: null, // Card ID is passed through the agent's initial_task as [Card: <id>]
        tools: allTools,
        onToolCall: (n, a) => handleToolCallRef.current(n, a),
        abortCurrentRun: () => {
          if (activeAgent) {
            agentRunner.stop(activeAgent.id);
          }
        },
      };

      return executeLocalTool(name, args, conversationProjectDirRef.current!, agentCtx);
    }
    // Fall through to MCP tools
    return executeMcpTool(name, args);
  }, [isLocalTool, checkPermission, executeLocalTool, executeMcpTool, createAgent, startAgent, activeAgent, allTools]);

  // Keep ref in sync for spawned agents
  handleToolCallRef.current = handleToolCall;

  const {
    messages,
    isLoading,
    error,
    tokenCount,
    sendMessage: chatSendMessage,
    loadMessages,
    clearMessages: chatClearMessages,
    clearError,
    stopGeneration,
    appendMessage,
    updateStreamContent,
  } = useChat({
    systemPrompt,
    tools: allTools,
    onToolCall: handleToolCall,
    conversationId: activeId,
    captureSource: 'chat_view',
  });

  // Whether the pending permission request maps to a tool call already in
  // the message stream. If so, the matching ToolCallCard surfaces the grant
  // buttons inline (A7) and we suppress the modal overlay below.
  const hasInlinePermissionCard = useMemo(() => {
    if (!pendingRequest) return false;
    return messages.some(
      m =>
        m.role === 'assistant' &&
        m.tool_calls?.some(tc => tc.function.name === pendingRequest.toolName),
    );
  }, [pendingRequest, messages]);

  const contextWindow = getContextWindow(getModel());

  // Ref for stable closure access to current messages
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Track previous messages length for auto-save
  const prevMessageCountRef = useRef(0);

  // Auto-save messages when they change
  useEffect(() => {
    if (!activeId || messages.length === 0) return;
    // Only save when message count increases (new messages added)
    if (messages.length > prevMessageCountRef.current) {
      saveMessages(activeId, messages);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages, activeId, saveMessages]);

  // Re-save all messages when streaming completes to capture final content
  // (streaming updates content in-place without changing array length)
  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading && activeId && messages.length > 0) {
      saveMessages(activeId, messages, true);
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, activeId, messages, saveMessages]);

  // Force-save after orchestrate stream completes
  // The orchestrate path uses updateStreamContent (in-place updates) which
  // doesn't change message count, so the auto-save effects don't trigger.
  useEffect(() => {
    if (orchestrateSaveNeeded.current && activeId && messages.length > 0) {
      orchestrateSaveNeeded.current = false;
      saveMessages(activeId, messages, true);
    }
  }, [messages, activeId, saveMessages]);

  // Reset message count tracking when conversation changes
  useEffect(() => {
    prevMessageCountRef.current = messages.length;
  }, [activeId]);

  useEffect(() => {
    if (ambientOpen) {
      markAmbientViewed();
    }
  }, [ambientOpen, markAmbientViewed]);

  // Load agent conversation when agentId prop changes
  useEffect(() => {
    if (!agentId) return;
    const agent = agents.find(a => a.id === agentId);
    if (agent) {
      // Reset orchestrated flag when switching agents — ensures we load from DB
      isOrchestratedRef.current = false;
      setActiveAgent(agent);
      setConversationProjectDir(agent.project_dir);
      loadConversation(agent.conversation_id).then(msgs => {
        loadMessages(msgs);
        switchConversation(agent.conversation_id);
        prevMessageCountRef.current = msgs.length;
      });
      // Sync queued messages from agentRunner
      setQueuedMessages(agentRunner.getQueue(agentId));
    }
  }, [agentId, agents, setActiveAgent, loadConversation, loadMessages, switchConversation]);

  // Default to global CWD for new chats (no agent yet)
  useEffect(() => {
    if (!agentId && projectDir) setConversationProjectDir(projectDir);
  }, [agentId, projectDir]);

  // Auto-send initialMessage when navigating with new session instruction
  const initialMessageSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialMessage && activeAgent && activeId && initialMessage !== initialMessageSentRef.current) {
      initialMessageSentRef.current = initialMessage;
      // Small delay to ensure conversation is loaded before sending
      const timer = setTimeout(() => {
        sendMessage(initialMessage);
      }, 100);
      return () => clearTimeout(timer);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, activeAgent, activeId]);

  // Subscribe to agentRunner events for the active agent — live message updates
  useEffect(() => {
    if (!activeAgent) return;
    const agentId = activeAgent.id;

    const unsubscribe = agentRunner.on((event) => {
      if ('agentId' in event && event.agentId !== agentId) return;

      switch (event.type) {
        case 'message_added':
          appendMessage(event.message as import('../hooks/useChat').Message);
          break;
        case 'stream_delta':
          updateStreamContent(event.assistantId, event.content);
          break;
        case 'message_queued':
        case 'queue_changed':
          setQueuedMessages(agentRunner.getQueue(agentId));
          break;
      }
    });

    return unsubscribe;
  }, [activeAgent, appendMessage, updateStreamContent]);

  // Whether the active agent is managed by agentRunner (background agent with run entry)
  const isRunnerManaged = activeAgent ? agentRunner.hasRun(activeAgent.id) : false;
  // Composite loading state: useChat loading OR agentRunner running
  const isActive = isLoading || (activeAgent ? isAgentRunning(activeAgent.id) : false);

  // Pre-chat connected apps search (debounced)
  useEffect(() => {
    if (preChatSearchRef.current) clearTimeout(preChatSearchRef.current);
    const q = preChatAppQuery.trim();
    if (!q || q.length < 2) {
      setPreChatAppResults([]);
      return;
    }

    preChatSearchRef.current = setTimeout(async () => {
      setPreChatSearching(true);
      try {
        const result = await executeMcpTool('ul_discover', { scope: 'library', query: q });
        const parsed = JSON.parse(result);
        const results = (parsed.results || [])
          .filter((r: { id: string }) => !preChatApps.some(a => a.id === r.id))
          .map((r: { id: string; name: string; description?: string; function_count?: number }) => ({
            id: r.id,
            name: r.name,
            description: r.description || null,
            functionCount: r.function_count || 0,
          }));
        setPreChatAppResults(results);
      } catch {
        setPreChatAppResults([]);
      } finally {
        setPreChatSearching(false);
      }
    }, 400);

    return () => { if (preChatSearchRef.current) clearTimeout(preChatSearchRef.current); };
  }, [preChatAppQuery, executeMcpTool, preChatApps]);

  // Helper: run the orchestrate SSE stream and feed events into the chat UI
  const runOrchestrateStream = useCallback(async (
    content: string,
    history?: Array<{ role: string; content: string }>,
    conversationIdOverride?: string,
  ) => {
    const userMsg: import('../hooks/useChat').Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: content.trim(),
      created_at: Date.now(),
    };
    appendMessage(userMsg);

    const assistantId = crypto.randomUUID();
    let assistantContent = '';
    let statusHint = '';  // Subtle animated status during Flash phase
    let currentPlanId: string | null = null;

    const updateUI = () => {
      if (assistantContent) {
        // Once real content arrives, show only the content
        updateStreamContent(assistantId, assistantContent);
      } else if (statusHint) {
        // During Flash phase, show a subtle status hint
        updateStreamContent(assistantId, `\u200B${statusHint}`);
      }
    };

    // Build scope from agent's connected_apps config, or from pre-chat scope (first message)
    // Use refs to avoid stale closure issues
    const currentAgent = activeAgentRef.current;
    const currentPreChatScope = preChatScopeRef.current;
    let scope: Record<string, { access: 'all' | 'functions' | 'data'; functions?: string[]; conventions?: Record<string, string> }> | undefined;
    if (currentAgent?.connected_apps) {
      try {
        const parsed = JSON.parse(currentAgent.connected_apps);
        const apps = parsed.apps || parsed;
        const scopeEntries = Object.entries(apps as Record<string, { slug?: string; access?: string; selected_functions?: string[]; conventions?: Record<string, string> }>);
        if (scopeEntries.length > 0) {
          scope = {};
          for (const [, cfg] of scopeEntries) {
            const slug = cfg.slug;
            if (!slug) continue;
            const access = (cfg.access || 'all') as 'all' | 'functions' | 'data';
            const fns = cfg.selected_functions && cfg.selected_functions.length > 0 ? cfg.selected_functions : undefined;
            const conventions = cfg.conventions && Object.keys(cfg.conventions).length > 0 ? cfg.conventions : undefined;
            scope[slug] = { access, functions: fns, conventions };
          }
          if (Object.keys(scope).length === 0) scope = undefined;
        }
      } catch { /* no scope */ }
    } else if (currentPreChatScope.length > 0) {
      // First message — agent just created, activeAgent state not yet updated
      scope = {};
      for (const s of currentPreChatScope) {
        const selectedFns = s.functions.filter(f => f.selected).map(f => f.name);
        scope[s.slug] = {
          access: s.access,
          functions: selectedFns.length > 0 && selectedFns.length < s.functions.length ? selectedFns : undefined,
        };
      }
    }
    if (scope) {
      chatViewLogger.debug('Sending scope with orchestrate request', {
        scopes: Object.keys(scope),
      });
    }

    // Gather system agent states for Flash's Context Index
    const systemAgentStates = agents
      .filter(a => a.is_system === 1 && a.system_agent_type)
      .map(a => {
        const config = SYSTEM_AGENTS.find(c => c.type === a.system_agent_type);
        return {
          type: a.system_agent_type!,
          name: a.name,
          // Flash resolves effective system-agent tools server-side now.
          tools: [],
          stateSummary: a.state_summary,
          status: a.status,
        };
      });

    // Gather local project context if a project dir is set
    let projectContext: string | undefined;
    if (conversationProjectDirRef.current) {
      try {
        projectContext = await gatherProjectContext(conversationProjectDirRef.current, content);
      } catch (err) {
        chatViewLogger.warn('Context gathering failed', { error: err });
      }
    }

    const agentModels = parseAgentModels(currentAgent?.model || null);
    const executeWindowSeconds = currentAgent?.execute_window_seconds ?? 8;
    const resolvedConversationId = conversationIdOverride || activeId || currentAgent?.conversation_id || assistantId;
    const inference = getInferencePreference() ?? undefined;
    const activeWidgetContexts = activeAgenticSurfacesRef.current
      .map(buildActiveAgenticSurfaceContext);

    // Attach pending files (from ChatInput)
    const chatFiles = pendingFilesRef.current || undefined;
    pendingFilesRef.current = null;

    for await (const event of streamOrchestrate({
      message: content,
      conversationHistory: history,
      interpreterModel: agentModels.interpreter,
      heavyModel: agentModels.heavy,
      inference,
      scope,
      adminNotes: currentAgent?.admin_notes || undefined,
      systemAgentStates: systemAgentStates.length > 0 ? systemAgentStates : undefined,
      systemAgentContext: systemAgentContext || undefined,
      projectContext,
      conversationId: conversationIdOverride || activeId || undefined,
      userMessageId: userMsg.id,
      assistantMessageId: assistantId,
      files: chatFiles,
      activeWidgetContexts: activeWidgetContexts.length > 0 ? activeWidgetContexts : undefined,
    })) {
      switch (event.type) {
        case 'ambient_suggestions':
          if (event.suggestions?.length) {
            dispatchAmbientSuggestions(event.suggestions.map((suggestion) => ({
              ...suggestion,
              intent_id: suggestion.intent_id || event.intent_id,
              suggestion_set_id: suggestion.suggestion_set_id || event.suggestion_set_id,
              conversation_id: resolvedConversationId,
              message_id: userMsg.id,
            })));
          }
          break;
        // Flash phase — show subtle status hints
        case 'flash_status':
          statusHint = event.text || 'Thinking...';
          updateUI();
          break;
        case 'flash_search':
          statusHint = `Searching ${(event.apps || []).join(', ')}...`;
          updateUI();
          break;
        case 'flash_found':
          statusHint = `Found ${event.entity}`;
          updateUI();
          break;
        case 'flash_context':
          statusHint = 'Preparing response...';
          updateUI();
          break;
        case 'flash_prompt':
          statusHint = 'Writing...';
          updateUI();
          break;

        // Flash answered directly
        case 'flash_direct':
          statusHint = '';
          assistantContent += event.content || '';
          updateUI();
          break;

        // Heavy model streaming — real content
        case 'heavy_status':
          if (!assistantContent) {
            statusHint = event.text || 'Writing...';
            updateUI();
          }
          break;
        case 'heavy_text':
          statusHint = '';
          assistantContent += event.content || '';
          updateUI();
          break;
        case 'heavy_recipe':
          break; // Don't show recipe code

        // Execution
        case 'plan_ready': {
          if (!event.plan) break;

          currentPlanId = event.plan.id;
          const fireAt = executeWindowSeconds >= 0
            ? Date.now() + Math.max(executeWindowSeconds, 0) * 1000
            : null;

          const localPlan: ExecutionPlan = {
            id: event.plan.id,
            conversation_id: resolvedConversationId,
            message_id: assistantId,
            recipe: event.plan.recipe,
            tools_used: event.plan.tools_used,
            total_cost_light: event.plan.total_cost_light,
            created_at: event.plan.created_at,
            window_seconds: executeWindowSeconds,
            fire_at: fireAt ?? undefined,
            status: 'pending',
            result: undefined,
            fired_at: undefined,
            completed_at: undefined,
          };

          try {
            await invoke('db_create_execution_plan', { plan: localPlan });
          } catch (err) {
            chatViewLogger.error('Failed to persist execution plan', {
              error: err,
              planId: event.plan.id,
            });
          }

          assistantContent += assistantContent
            ? `\n\n{{exec:${event.plan.id}}}`
            : `{{exec:${event.plan.id}}}`;
          updateUI();

          break;
        }
        case 'plan_cancelled':
          statusHint = '';
          if (currentPlanId || event.planId) {
            const cancellationResult = event.reason === 'timed_out'
              ? 'Execution window expired before approval.'
              : 'Execution was cancelled before any tools ran.';
            try {
              await invoke('db_update_execution_plan_status', {
                id: event.planId || currentPlanId,
                status: 'cancelled',
                result: cancellationResult,
                fireAt: null,
                firedAt: null,
                completedAt: Date.now(),
              });
            } catch (err) {
              chatViewLogger.warn('Failed to persist cancelled execution plan', {
                error: err,
                planId: event.planId || currentPlanId,
              });
            }
          }
          updateUI();
          break;
        case 'exec_start':
          if (currentPlanId) {
            try {
              await invoke('db_update_execution_plan_status', {
                id: currentPlanId,
                status: 'executing',
                result: null,
                fireAt: null,
                firedAt: Date.now(),
                completedAt: null,
              });
            } catch (err) {
              chatViewLogger.warn('Failed to persist executing execution plan state', {
                error: err,
                planId: currentPlanId,
              });
            }
          }
          if (assistantContent) {
            // Already have text from heavy model, just wait
          } else {
            statusHint = 'Running...';
            updateUI();
          }
          break;
        case 'exec_result': {
          // Recipe result is internal — don't show raw JSON to the user.
          // The heavy model's text response is the user-facing output.
          statusHint = '';
          if (currentPlanId) {
            let serializedResult = '';
            try {
              serializedResult = typeof event.data === 'string'
                ? event.data
                : JSON.stringify(event.data, null, 2);
            } catch {
              serializedResult = String(event.data);
            }

            try {
              await invoke('db_update_execution_plan_status', {
                id: currentPlanId,
                status: 'completed',
                result: serializedResult || null,
                fireAt: null,
                firedAt: null,
                completedAt: Date.now(),
              });
            } catch (err) {
              chatViewLogger.warn('Failed to persist completed execution plan state', {
                error: err,
                planId: currentPlanId,
              });
            }
          }
          updateUI();
          break;
        }

        // System agent delegation
        case 'system_agent_spawn': {
          const targetAgent = agents.find(
            a => a.is_system === 1 && a.system_agent_type === event.agentType
          );
          if (targetAgent && event.task) {
            const targetConfig = SYSTEM_AGENTS.find(c => c.type === targetAgent.system_agent_type);
            if (targetConfig) {
              // Fire delegated orchestrate via the system agent's Flash pipeline (async)
              // Pass originalPrompt so the system agent sees the user's exact words
              runDelegatedOrchestrate(targetAgent, targetConfig, event.task, event.originalPrompt, conversationProjectDirRef.current);
            }
            assistantContent += `\n\n> Delegating to **${targetAgent.name}**: ${event.task}`;
            updateUI();
          }
          break;
        }

        // Legacy compat
        case 'status':
          statusHint = event.text || '';
          updateUI();
          break;
        case 'text':
          statusHint = '';
          assistantContent += event.content || '';
          updateUI();
          break;
        case 'tool_start': break;
        case 'result': {
          const rs = typeof event.data === 'string' ? event.data : JSON.stringify(event.data, null, 2);
          if (rs && rs !== 'null') assistantContent += `\n\`\`\`json\n${rs}\n\`\`\``;
          updateUI();
          break;
        }

        case 'usage':
          chatViewLogger.debug('Received orchestrate usage event', {
            flash: event.flash,
            heavy: event.heavy,
          });
          break;
        case 'error':
          statusHint = '';
          assistantContent += `\n\n**Error:** ${event.message || 'Unknown error'}`;
          updateUI();
          break;
        case 'done':
          statusHint = '';
          updateUI();
          // Fire-and-forget: embed conversation for cross-session semantic search
          if (activeAgentRef.current && messages.length >= 5) {
            const agent = activeAgentRef.current;
            maybeEmbedConversation(
              agent.conversation_id,
              agent.name,
              messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
            ).catch(() => {});
          }
          break;
      }
    }

    appendMessage({
      id: assistantId,
      role: 'assistant',
      content: assistantContent,
      created_at: Date.now(),
    });

    // Execute local file operations from the model's response
    if (conversationProjectDirRef.current && assistantContent) {
      const fileOps = parseFileOperations(assistantContent);
      if (fileOps.length > 0) {
        for (const op of fileOps) {
          try {
            const allowed = await checkPermission('file_write', { path: op.path, content: op.content });
            if (!allowed) continue;
            await invoke('file_write', {
              projectRoot: conversationProjectDirRef.current,
              path: op.path,
              content: op.content,
            });
            chatViewLogger.debug('Wrote file from assistant operation', { path: op.path });
          } catch (err) {
            chatViewLogger.warn('Failed to write file from assistant operation', {
              path: op.path,
              error: err,
            });
          }
        }
      }
    }

    // Signal that a force-save is needed after the next render
    orchestrateSaveNeeded.current = true;
  }, [appendMessage, updateStreamContent]);

  // Send message — routes through agentRunner for background agents, useChat for interactive
  // Helper: run delegated orchestrate for a system agent (fire-and-forget)
  const runDelegatedOrchestrate = useCallback(async (
    agent: typeof agents[0],
    config: typeof SYSTEM_AGENTS[0],
    task: string,
    originalPrompt?: string,
    callingProjectDir?: string | null,
  ) => {
    try {
      // Inherit project directory from the calling conversation if target agent doesn't have one
      if (callingProjectDir && !agent.project_dir) {
        await invoke('db_update_agent', {
          id: agent.id,
          status: null, name: null, adminNotes: null, endGoal: null,
          context: null, permissionLevel: null, model: null,
          projectDir: callingProjectDir,
          connectedAppIds: null, connectedApps: null,
          initialTask: null, stateSummary: null, systemAgentType: null,
        });
        chatViewLogger.debug('Inherited project directory for delegated agent', {
          projectDir: callingProjectDir,
          agentName: agent.name,
        });
      }

      // Build the message for the system agent — includes both routing context and original prompt
      const delegationMessage = originalPrompt && originalPrompt !== task
        ? `## User's Original Request\n${originalPrompt}\n\n## Routing Context\n${task}`
        : task;

      // Save task as user message in system agent's conversation
      await invoke('db_save_message', {
        message: {
          id: crypto.randomUUID(),
          conversation_id: agent.conversation_id,
          role: 'user',
          content: delegationMessage,
          tool_calls: null,
          tool_call_id: null,
          usage: null,
          cost_light: null,
          created_at: Date.now(),
          sort_order: Date.now(),
        },
      });

      // Gather local project context for delegated agent
      let delegatedProjectContext: string | undefined;
      if (callingProjectDir) {
        try {
          delegatedProjectContext = await gatherProjectContext(callingProjectDir, delegationMessage);
        } catch (err) {
          chatViewLogger.warn('Delegated context gathering failed', { error: err });
        }
      }

      // Run orchestrate with the system agent's context and its configured models
      const sysModels = parseAgentModels(agent.model || null);
      const inference = getInferencePreference() ?? undefined;
      let resultContent = '';
      for await (const ev of streamOrchestrate({
        message: delegationMessage,
        interpreterModel: sysModels.interpreter,
        heavyModel: sysModels.heavy,
        inference,
        adminNotes: agent.admin_notes || undefined,
        systemAgentContext: { type: config.type, persona: config.persona, skillsPath: config.skillsPath },
        projectContext: delegatedProjectContext,
        conversationId: activeId || undefined,
      })) {
        if (ev.type === 'flash_direct' || ev.type === 'heavy_text') {
          resultContent += ev.content || '';
        } else if (ev.type === 'plan_ready' && ev.plan?.id) {
          try {
            await confirmExecutionPlan(ev.plan.id);
          } catch (err) {
            chatViewLogger.warn('Failed to auto-confirm delegated execution plan', {
              error: err,
              planId: ev.plan.id,
            });
          }
        }
      }

      // Save result as assistant message in system agent's conversation
      if (resultContent) {
        await invoke('db_save_message', {
          message: {
            id: crypto.randomUUID(),
            conversation_id: agent.conversation_id,
            role: 'assistant',
            content: resultContent,
            tool_calls: null,
            tool_call_id: null,
            usage: null,
            cost_light: null,
            created_at: Date.now(),
            sort_order: Date.now(),
          },
        });
      }

      // Update state summary
      await updateSystemAgentState(agent.id, [
        { role: 'user', content: task },
        { role: 'assistant', content: resultContent },
      ]);
    } catch (err) {
      chatViewLogger.warn('Delegated orchestrate failed', { error: err, agentId: agent.id });
    }
  }, [agents]);

  const ensureInferenceReady = useCallback(async (): Promise<boolean> => {
    const settings = await fetchInferenceSettings();
    const notice = buildInferenceSetupPrompt(settings, getInferencePreference() ?? {});
    setInferenceNotice(notice);
    return notice === null;
  }, []);

  const sendMessage = useCallback(async (content: string, files?: ChatFile[]) => {
    if (!(await ensureInferenceReady())) {
      return;
    }

    // Stash files on ref so runOrchestrateStream can pick them up
    pendingFilesRef.current = files || null;

    // System agents always route through Flash orchestrate pipeline
    if (systemAgentContext && activeAgent) {
      const history = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }));
      await runOrchestrateStream(content, history, activeId || activeAgent.conversation_id);
      pendingFilesRef.current = null;
      return;
    }

    // If there's an active agent managed by agentRunner, route through it
    if (activeAgent && isRunnerManaged) {
      if (agentRunner.isRunning(activeAgent.id)) {
        // Agent is busy — queue the message
        agentRunner.queueMessage(activeAgent.id, content);
      } else {
        // Agent is idle — resume with follow-up
        await agentRunner.resume(activeAgent.id, content);
      }
      return;
    }

    // Follow-up in an orchestrated conversation — stream without recreating agent
    if (activeAgent && isOrchestratedRef.current) {
      const history = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));
      await runOrchestrateStream(content, history, activeId || activeAgent.conversation_id);
      return;
    }

    // Interactive path — first message creates agent, then streams via orchestrate
    let convId = activeId;
    if (!convId) {

      // ── ALL chats use server-side orchestration ──
      // Flash broker handles context resolution, model selection, and prompt construction.
      // Heavy model writes ONE recipe. Dynamic Worker executes it. No client-side agent loop.
      {
        isOrchestratedRef.current = true;

        // Build connected_apps from pre-chat scope if any (use ref for fresh value)
        const scopeSnapshot = preChatScopeRef.current;
        let connectedApps: string | undefined;
        let connectedAppIds: string | undefined;
        if (scopeSnapshot.length > 0) {
          const appsConfig: Record<string, { name: string; slug: string; access: string; selected_functions: string[]; conventions: Record<string, string> }> = {};
          for (const s of scopeSnapshot) {
            const selectedFns = s.functions.filter(f => f.selected).map(f => f.name);
            appsConfig[s.id] = { name: s.name, slug: s.slug, access: s.access, selected_functions: selectedFns, conventions: {} };
          }
          connectedApps = JSON.stringify({ apps: appsConfig });
          connectedAppIds = JSON.stringify(scopeSnapshot.map(s => s.id));
        }

        const agent = await createAgent({
          name: content.slice(0, 40).replace(/\n/g, ' '),
          role: 'general',
          initialTask: content,
          systemPrompt: '',  // Server constructs the prompt via Flash broker
          projectDir: conversationProjectDirRef.current,
          model: `${getInterpreterModel()} → ${getHeavyModel()}`,
          parentAgentId: null,
          connectedAppIds: connectedAppIds || (preChatApps.length > 0 ? JSON.stringify(preChatApps.map(a => a.id)) : undefined),
          connectedApps,
        });
        setActiveAgent(agent);
        switchConversation(agent.conversation_id);
        convId = agent.conversation_id;
        setPreChatApps([]);
        setPreChatAppQuery('');
        setPreChatAppResults([]);
        setPreChatScope([]);

        // Stream FIRST, then navigate — keeps this ChatView mounted during streaming
        await runOrchestrateStream(content, undefined, convId || undefined);

        // Generate a nice title asynchronously (don't block navigation)
        (async () => {
          try {
            let title = '';
            for await (const ev of streamChat({
              model: getInterpreterModel(),
              messages: [{ role: 'user', content: `Generate a short title (3-6 words, no quotes) for a chat that starts with this message:\n\n${content.slice(0, 200)}` }],
              temperature: 0.3,
              max_tokens: 30,
              inference: getInferencePreference() ?? undefined,
              trace: {
                conversationId: convId || agent.conversation_id,
                source: 'title_generation',
              },
            })) {
              if (ev.type === 'delta') title += ev.content || '';
            }
            title = title.trim().replace(/^["']|["']$/g, '');
            if (title && title.length > 0 && title.length < 60) {
              await invoke('db_update_agent', {
                id: agent.id, name: title, status: null, adminNotes: null,
                endGoal: null, context: null, permissionLevel: null, model: null,
                projectDir: null, connectedAppIds: null, connectedApps: null,
                initialTask: null, stateSummary: null, systemAgentType: null,
              });
              refreshAgents();
            }
          } catch (err) {
            chatViewLogger.warn('Title generation failed', { error: err, agentId: agent.id });
          }
        })();

        // Force-save messages to DB before navigating (navigation remounts ChatView)
        const currentMessages = messagesRef.current;
        if (currentMessages.length > 0) {
          await saveMessages(agent.conversation_id, currentMessages, true);
        }

        // Navigate to the agent view (causes remount — new instance loads saved messages from DB)
        if (onNavigateToAgent) onNavigateToAgent(agent.id);
        return;
      }

    }
    // This shouldn't be reached — orchestrate path returns above
    await chatSendMessage(content);
  }, [activeAgent, isRunnerManaged, activeId, createAgent, systemPrompt, chatSendMessage, switchConversation, setActiveAgent, onNavigateToAgent, preChatApps, messages, runOrchestrateStream, ensureInferenceReady]);

  // New agent (from sidebar [+])
  const handleNewAgent = useCallback(() => {
    chatClearMessages();
    switchConversation(null);
    setActiveAgent(null);
    setAmbientOpen(false);
    prevMessageCountRef.current = 0;
    isOrchestratedRef.current = false;
    setPreChatApps([]);
    setPreChatAppQuery('');
    setPreChatAppResults([]);
    setPreChatScope([]);
  }, [chatClearMessages, switchConversation, setActiveAgent]);

  // Select agent from sidebar
  const handleSelectAgent = useCallback(async (selectedAgentId: string) => {
    const agent = agents.find(a => a.id === selectedAgentId);
    if (!agent) return;
    if (agent.conversation_id === activeId) return;

    setActiveAgent(agent);
    setAmbientOpen(false);
    const msgs = await loadConversation(agent.conversation_id);
    loadMessages(msgs);
    switchConversation(agent.conversation_id);
    prevMessageCountRef.current = msgs.length;

    if (onNavigateToAgent) onNavigateToAgent(agent.id);
  }, [agents, activeId, setActiveAgent, loadConversation, loadMessages, switchConversation, onNavigateToAgent]);

  // Delete agent
  const handleDeleteAgent = useCallback(async (id: string) => {
    const agent = agents.find(a => a.id === id);
    await deleteAgent(id);
    if (agent && agent.conversation_id === activeId) {
      chatClearMessages();
      setActiveAgent(null);
      prevMessageCountRef.current = 0;
    }
  }, [agents, activeId, deleteAgent, chatClearMessages, setActiveAgent]);

  // Stop agent
  const handleStopAgent = useCallback((id: string) => {
    stopAgent(id);
  }, [stopAgent]);

  const handleSignOut = useCallback(async () => {
    const token = getToken();
    try {
      if (token) {
        const response = await fetchFromApi('/auth/signout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          chatViewLogger.warn('Desktop sign-out did not fully revoke the upstream session');
        }
      }
    } catch (error) {
      chatViewLogger.warn('Desktop sign-out request failed', { error });
    }

    try {
      await clearToken();
      window.location.reload();
    } catch (error) {
      chatViewLogger.error('Failed to clear secure desktop token', { error });
      setDiagnostics('Unable to clear your saved sign-in token securely. Please try again.');
    }
  }, []);

  const handleInferenceNoticeAction = useCallback((action: InferenceSetupAction) => {
    if (action === 'use_light') {
      setInferencePreference({ billingMode: 'light', provider: 'openrouter' });
      setInferenceNotice(null);
      return;
    }
    void openViewWindow(action === 'open_wallet' ? { kind: 'wallet' } : { kind: 'settings' });
  }, []);

  // Child agents of current active agent
  const childAgents = useMemo(() => {
    if (!activeAgent) return [];
    return agents.filter(a => a.parent_agent_id === activeAgent.id);
  }, [agents, activeAgent]);

  // All agents for team search in AgentHeader

  // Handle agent updates from header config panel
  const handleUpdateAgent = useCallback(async (updates: Partial<import('../hooks/useAgentFleet').Agent>) => {
    if (!activeAgent) return;
    await invoke('db_update_agent', {
      id: activeAgent.id,
      status: updates.status ?? null,
      name: updates.name ?? null,
      adminNotes: updates.admin_notes ?? null,
      endGoal: updates.end_goal ?? null,
      context: updates.context ?? null,
      permissionLevel: updates.permission_level ?? null,
      executeWindowSeconds: updates.execute_window_seconds ?? null,
      model: updates.model ?? null,
      projectDir: updates.project_dir ?? null,
      connectedAppIds: updates.connected_app_ids ?? null,
      connectedApps: updates.connected_apps ?? null,
      initialTask: updates.initial_task ?? null,
    });
    await refreshAgents();
  }, [activeAgent, refreshAgents]);

  // ── Scope injection from DiscoverWidget ──
  // Listens for custom event dispatched when user selects apps from inline discover widget
  useEffect(() => {
    const handler = async (e: Event) => {
      const { apps } = (e as CustomEvent).detail as { apps: Array<{ id: string; slug: string; name: string; access: string }> };
      if (!activeAgent || !apps?.length) return;

      const current = JSON.parse(activeAgent.connected_apps || '{"apps":{}}');
      if (!current.apps) current.apps = {};
      for (const app of apps) {
        current.apps[app.id] = {
          name: app.name,
          slug: app.slug,
          access: app.access || 'all',
          selected_functions: [],
          conventions: {},
        };
      }
      await handleUpdateAgent({ connected_apps: JSON.stringify(current) });
      chatViewLogger.debug('Injected apps into scope from discover widget', { count: apps.length });
    };

    window.addEventListener('ul-inject-scope', handler);
    return () => window.removeEventListener('ul-inject-scope', handler);
  }, [activeAgent, handleUpdateAgent]);

  const injectAmbientSuggestionScope = useCallback((suggestions: AmbientSuggestion[]) => {
    const apps = suggestions
      .filter((suggestion) => suggestion.type === 'app')
      .map((suggestion) => ({
        id: suggestion.id,
        slug: suggestion.slug,
        name: suggestion.name,
        access: 'all',
      }));
    if (apps.length === 0) return;

    window.dispatchEvent(new CustomEvent('ul-inject-scope', { detail: { apps } }));
  }, []);

  const handleAcceptAmbientSuggestion = useCallback((suggestion: AmbientSuggestion, surface = 'composer') => {
    acceptAmbientSuggestion(suggestion, surface);
    injectAmbientSuggestionScope([suggestion]);
    setAmbientOpen(false);
  }, [acceptAmbientSuggestion, injectAmbientSuggestionScope]);

  const handleAcceptAmbientSuggestions = useCallback((suggestions: AmbientSuggestion[], surface = 'ambient_panel') => {
    for (const suggestion of suggestions) {
      acceptAmbientSuggestion(suggestion, surface);
    }
  }, [acceptAmbientSuggestion]);

  // Handle project directory changes — update local state + persist to DB
  const handleProjectDirChange = useCallback(async (dir: string) => {
    setConversationProjectDir(dir);
    if (activeAgent) {
      await handleUpdateAgent({ project_dir: dir });
    }
  }, [activeAgent, handleUpdateAgent]);

  // Show "needs folder" banner for Tool Maker when no project dir is set
  const showNeedsFolderBanner = !conversationProjectDir && systemAgentContext?.type === 'tool_builder';

  const handleBannerSelectFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select Project Directory' });
      if (selected && typeof selected === 'string') {
        handleProjectDirChange(selected);
      }
    } catch (err) {
      chatViewLogger.error('Folder picker error', { error: err });
    }
  }, [handleProjectDirChange]);

  // Reset agent session — clear messages, keep identity/config
  const handleNewSession = useCallback(async () => {
    if (!activeAgent) return;
    await newSession(activeAgent.id);
    chatClearMessages();
    prevMessageCountRef.current = 0;
  }, [activeAgent, newSession, chatClearMessages]);

  const runDiagnostics = async () => {
    setDiagnostics('Running preflight checks...');
    try {
      const token = getToken();
      const res = await fetchFromApi('/debug/chat-preflight', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      const items = data.checks || data.steps || [];
      const lines = items.map((s: { check?: string; step?: string; result: string; ok: boolean }) =>
        `${s.ok ? '✓' : '✗'} ${s.check || s.step}: ${s.result}`
      );
      setDiagnostics(lines.join('\n') || JSON.stringify(data, null, 2));
    } catch (err) {
      setDiagnostics(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-w-0 h-full">
      {/* Agent Header */}
      <AgentHeader
        agent={activeAgent}
        isRunning={activeAgent ? isAgentRunning(activeAgent.id) : false}
        tokenCount={tokenCount}
        contextWindow={contextWindow}
        childAgents={childAgents}
        allAgents={agents}
        onUpdateAgent={handleUpdateAgent}
        onStop={() => activeAgent && stopAgent(activeAgent.id)}
        onNewSession={handleNewSession}
        onShowTutorial={activeAgent?.system_agent_type === 'platform_manager' ? onShowTutorial : undefined}
        onOpenSubagentChat={onNavigateToAgent}
        onStopSubagent={stopAgent}
        executeMcpTool={executeMcpTool}
      />


      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-ul-error-soft border-b border-ul-border">
          <div className="flex items-center justify-between">
            <p className="text-small text-ul-error">{error}</p>
            <div className="flex items-center gap-2">
              <button onClick={runDiagnostics} className="text-caption text-ul-text-secondary hover:underline">
                Diagnose
              </button>
              <button onClick={handleSignOut} className="text-caption text-ul-error hover:underline">
                Sign in again
              </button>
              <button onClick={() => { clearError(); setDiagnostics(null); }} className="text-caption text-ul-error hover:underline">
                Dismiss
              </button>
            </div>
          </div>
          {diagnostics && (
            <pre className="mt-2 p-2 bg-white rounded text-xs text-ul-text-secondary font-mono whitespace-pre-wrap border border-ul-border">
              {diagnostics}
            </pre>
          )}
        </div>
      )}

      {/* Messages */}
      <MessageList
        messages={messages}
        isLoading={isActive}
        systemAgent={systemAgentConfig || undefined}
        onStarterClick={sendMessage}
        onPickSystemAgent={(cfg) => {
          const provisioned = agents.find(
            (a) => a.system_agent_type === cfg.type,
          );
          if (provisioned && onNavigateToAgent) onNavigateToAgent(provisioned.id);
        }}
        pendingPermission={pendingRequest}
        onAllowPermission={allow}
        onAlwaysAllowPermission={alwaysAllow}
        onDenyPermission={deny}
      />

      {/* Queued messages indicator — uses the warning token family so it
          collapses onto the same amber the composer queue-send button
          uses (A2). Folds the addendum's D row for #fef3c7 banner fill. */}
      {queuedMessages.length > 0 && (
        <div className="px-4 py-2 bg-ul-warning-soft border-t border-ul-warning/20">
          <div className="max-w-narrow mx-auto">
            <p className="text-caption font-medium text-ul-warning-hover mb-1">
              Queued ({queuedMessages.length})
            </p>
            {queuedMessages.map((msg, i) => (
              <div key={i} className="flex items-center justify-between gap-2 py-1">
                <p className="text-caption text-ul-warning-hover truncate flex-1">
                  {msg.length > 80 ? msg.slice(0, 80) + '...' : msg}
                </p>
                <button
                  onClick={() => {
                    if (activeAgent) {
                      agentRunner.dequeueMessage(activeAgent.id, i);
                    }
                  }}
                  className="text-ul-warning hover:text-ul-warning-hover flex-shrink-0"
                  title="Remove from queue"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}


      {/* Needs-folder banner — warning-soft + warning-hover collapses onto
          the same token family as the queued banner and the composer
          queue-send (A2). */}
      {showNeedsFolderBanner && (
        <div className="px-4 py-2 border-t border-ul-warning/20 bg-ul-warning-soft">
          <div className="max-w-narrow mx-auto flex items-center gap-3">
            <svg className="w-4.5 h-4.5 text-ul-warning-hover flex-shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
            </svg>
            <span className="flex-1 text-small text-ul-warm-ink">A project folder is needed to write and read files</span>
            <button
              onClick={handleBannerSelectFolder}
              className="px-3 py-1 text-caption font-medium rounded-md border border-ul-warning-hover text-ul-warning-hover bg-white hover:bg-ul-warning-hover hover:text-white transition-colors flex-shrink-0"
            >
              Select Folder
            </button>
          </div>
        </div>
      )}

      {inferenceNotice && (
        <div className="fixed bottom-5 right-5 z-40 w-[min(420px,calc(100vw-2rem))] border border-ul-warning/30 bg-white shadow-[0_18px_48px_rgba(0,0,0,0.14)]">
          <div className="flex items-start gap-3 p-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center border border-ul-warning/30 bg-ul-warning-soft">
              <svg className="h-4 w-4 text-ul-warning-hover" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-small font-medium text-ul-text">{inferenceNotice.title}</div>
                  <div className="mt-0.5 text-caption leading-5 text-ul-text-secondary">{inferenceNotice.message}</div>
                </div>
                <button
                  onClick={() => setInferenceNotice(null)}
                  className="text-ul-text-muted hover:text-ul-text-secondary"
                  title="Dismiss"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                {inferenceNotice.secondaryAction && (
                  <button
                    onClick={() => handleInferenceNoticeAction(inferenceNotice.secondaryAction!.action)}
                    className="px-3 py-1 text-caption font-medium border border-ul-border text-ul-text-secondary bg-white hover:border-ul-border-strong transition-colors"
                  >
                    {inferenceNotice.secondaryAction.label}
                  </button>
                )}
                <button
                  onClick={() => handleInferenceNoticeAction(inferenceNotice.primaryAction.action)}
                  className="px-3 py-1 text-caption font-medium border border-ul-text bg-ul-text text-white hover:bg-black transition-colors"
                >
                  {inferenceNotice.primaryAction.label}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {ambientOpen && (
        <div className="border-t border-ul-border bg-white/95 px-4 py-3">
          <div className="max-w-narrow mx-auto">
            <DiscoverWidget
              mode={{ kind: 'ambient', suggestions: ambientSuggestions }}
              onAcceptSuggestions={(suggestions) => {
                handleAcceptAmbientSuggestions(suggestions, 'ambient_panel');
              }}
              onDismissSuggestion={(suggestion) => {
                dismissAmbientSuggestion(suggestion, 'ambient_panel');
              }}
              onInjectScope={(apps) => {
                window.dispatchEvent(new CustomEvent('ul-inject-scope', { detail: { apps } }));
                setAmbientOpen(false);
                markAmbientViewed();
              }}
            />
          </div>
        </div>
      )}

      {/* Input — `initialDraft` is only meaningful on first mount of a
          new-chat ChatView (the wizard's E3 seeded prompt). It's ignored
          for active agents, which surface initialMessage via auto-send. */}
      <ChatInput
        agents={agents}
        initialDraft={!activeAgent ? initialMessage : undefined}
        onSend={sendMessage}
        isLoading={isActive}
        onStop={() => {
          if (activeAgent && isAgentRunning(activeAgent.id)) {
            stopAgent(activeAgent.id);
          } else {
            stopGeneration();
          }
        }}
        queueMode={isRunnerManaged}
        projectDir={conversationProjectDir}
        onProjectDirChange={handleProjectDirChange}
        ambientSuggestions={ambientSuggestions}
        ambientHasNew={ambientHasNew}
        toolDealerPanelOpen={ambientOpen}
        onOpenToolDealerPanel={() => {
          markAmbientViewed('ambient_panel');
          setAmbientOpen(true);
        }}
        onCloseToolDealerPanel={() => setAmbientOpen(false)}
        onViewToolSuggestions={() => markAmbientViewed('composer_popover')}
        onAcceptToolSuggestion={(suggestion) => handleAcceptAmbientSuggestion(suggestion, 'composer_popover')}
        onDismissToolSuggestion={(suggestion) => dismissAmbientSuggestion(suggestion, 'composer_popover')}
        queuedCount={queuedMessages.length}
        onEditCustomInstructions={() => {
          // AgentHeader listens for this event and expands the config panel
          // (where the per-agent admin_notes / custom-instructions field
          // lives). Avoids prop-drilling expanded-state through ChatView.
          window.dispatchEvent(new CustomEvent('ul-open-agent-config'));
        }}
      />

      {/* Permission modal overlay — A7 routes tool-call permission asks to
          an inline card, so the modal only renders when there's no visible
          tool-call card matching the request (e.g. a permission check that
          fires before any AccumulatedToolCall enters the message stream). */}
      {pendingRequest && !hasInlinePermissionCard && (
        <PermissionModal
          request={pendingRequest}
          onAllow={allow}
          onAlwaysAllow={alwaysAllow}
          onDeny={deny}
        />
      )}

      {/* Spending approval modal */}
      {pendingSpending && (
        <SpendingApprovalModal
          request={pendingSpending}
          onApprove={approveSpending}
          onDeny={denySpending}
        />
      )}
    </div>
  );
}
