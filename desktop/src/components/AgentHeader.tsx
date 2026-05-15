// Agent header — collapsed shows name + status, expanded shows full config panel.
// Uses shared AgentConfigPanel for the config UI.
// For new chats (agent=null), creates a synthetic agent so the same panel renders.

import { useEffect, useState, useMemo, useCallback } from 'react';
import type { Agent } from '../hooks/useAgentFleet';
import BalanceIndicator from './BalanceIndicator';
import ContextIndicator from './ContextIndicator';
import AgentConfigPanel from './AgentConfigPanel';
import { openSubagentWindow, openViewWindow } from '../lib/multiWindow';
import {
  getInterpreterModel, setInterpreterModel,
  getHeavyModel, setHeavyModel,
} from '../lib/storage';

// ── Types ──

interface AgentHeaderProps {
  agent: Agent | null;
  isRunning: boolean;
  tokenCount: number;
  contextWindow: number;
  childAgents: Agent[];
  allAgents: Agent[];
  onUpdateAgent: (updates: Partial<Agent>) => Promise<void>;
  onStop: () => void;
  onNewSession: () => void;
  onShowTutorial?: () => void;
  onOpenSubagentChat?: (agentId: string) => void;
  onStopSubagent?: (agentId: string) => void;
  executeMcpTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

// ── Helpers ──

function statusDotClass(status: string): string {
  switch (status) {
    case 'running': return 'bg-ul-success';
    // TODO(token): bg-gray-300 — no exact ul-* equivalent (#d1d5db); kept raw.
    case 'pending': return 'bg-gray-300';
    case 'completed': return 'bg-ul-completed';
    case 'error': return 'bg-ul-error';
    case 'stopped': return 'bg-ul-warning';
    case 'waiting_for_approval': return 'bg-ul-warning';
    default: return 'bg-gray-300';
  }
}

function formatElapsed(createdAt: number): string {
  const diff = Date.now() - createdAt;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${hours}h ${minutes % 60}m`;
}

function formatModelChip(model: string | null): string | null {
  if (!model) return null;
  const parts = model.split(' -> ');
  const fallbackParts = model.split(' → ');
  const modelId = (parts[1] || fallbackParts[1] || parts[0] || fallbackParts[0] || model).trim();
  const name = modelId.split('/').pop() || modelId;
  return name.replace(/:nitro$/, '');
}

function formatExecuteWindowChip(seconds: number): string {
  if (seconds === 0) return 'auto';
  if (seconds === -1) return 'manual';
  return `${seconds}s`;
}

function buildNewChatAgent(): Agent {
  const flash = getInterpreterModel();
  const heavy = getHeavyModel();
  return {
    id: '__new_chat__',
    conversation_id: '',
    parent_agent_id: null,
    name: 'New Chat',
    role: 'general',
    status: 'pending',
    system_prompt: null,
    initial_task: null,
    project_dir: null,
    model: `${flash} → ${heavy}`,
    permission_level: 'auto_edit',
    execute_window_seconds: 8,
    admin_notes: null,
    end_goal: null,
    context: null,
    launch_mode: 'chat',
    connected_app_ids: null,
    connected_apps: null,
    is_system: 0,
    system_agent_type: null,
    state_summary: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

// ── Component ──

export default function AgentHeader({
  agent,
  isRunning,
  tokenCount,
  contextWindow,
  childAgents,
  allAgents,
  onUpdateAgent,
  onStop,
  onNewSession,
  onShowTutorial,
  onOpenSubagentChat,
  onStopSubagent,
  executeMcpTool,
}: AgentHeaderProps) {
  const [expanded, setExpanded] = useState(false);

  // The composer's ＋ menu (Batch 7 A4) fires `ul-open-agent-config` to ask
  // for the per-agent custom-instructions surface. We host that surface
  // inside the expanded config panel, so listening here is the cleanest
  // way to honor the request without prop-drilling through ChatView.
  useEffect(() => {
    const onOpen = () => setExpanded(true);
    window.addEventListener('ul-open-agent-config', onOpen);
    return () => window.removeEventListener('ul-open-agent-config', onOpen);
  }, []);

  // Synthetic agent for new chat — lets AgentConfigPanel render identically
  const syntheticAgent = useMemo(() => !agent ? buildNewChatAgent() : null, [agent]);
  const displayAgent = agent || syntheticAgent;

  // For new chat, intercept model updates and persist to localStorage
  const handleUpdateAgent = useCallback(async (updates: Partial<Agent>) => {
    if (agent) {
      return onUpdateAgent(updates);
    }
    // New chat — persist model changes to localStorage
    if (updates.model) {
      const parts = updates.model.split(' → ').map(s => s.trim());
      if (parts[0]) setInterpreterModel(parts[0]);
      if (parts[1]) setHeavyModel(parts[1]);
    }
  }, [agent, onUpdateAgent]);

  return (
    <div className="bg-white flex-shrink-0">
      {/* Collapsed header — always visible */}
      <header className="flex items-center justify-between px-4 h-nav">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 px-2 py-1 -mx-2"
          >
            <span className="text-h3 text-ul-text tracking-tight">
              {agent ? agent.name : 'New Chat'}
            </span>
            <svg
              width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
            >
              <path d="M3.5 5.5L7 9L10.5 5.5" />
            </svg>
          </button>
          {displayAgent && (
            <div className="hidden md:flex items-center gap-1.5">
              {formatModelChip(displayAgent.model) && (
                <span className="px-2 py-0.5 rounded-full border border-ul-border text-micro text-ul-text-muted font-mono">
                  {formatModelChip(displayAgent.model)}
                </span>
              )}
              <span className="px-2 py-0.5 rounded-full border border-ul-border text-micro text-ul-text-muted font-mono">
                {formatExecuteWindowChip(displayAgent.execute_window_seconds)}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {agent && (
            <button
              onClick={() => openViewWindow({ kind: 'chat', agentId: agent.id, agentName: agent.name })}
              className="text-caption text-ul-text-muted hover:text-ul-text transition-colors"
              title="Open in new window"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </button>
          )}
          {onShowTutorial && (
            <button
              onClick={onShowTutorial}
              className="btn btn-sm btn-secondary gap-1.5"
              title="Replay tutorial"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              Tutorial
            </button>
          )}
          <BalanceIndicator />
        </div>
      </header>

      {/* Expanded config panel — uses shared AgentConfigPanel */}
      {expanded && displayAgent && (
        <div className="px-4 pb-4 bg-white max-h-[70vh] overflow-y-auto">
          <div className="mt-1">
            <AgentConfigPanel
              agent={displayAgent}
              allAgents={allAgents}
              onUpdateAgent={handleUpdateAgent}
              onNavigateToAgent={onOpenSubagentChat}
              executeMcpTool={executeMcpTool}
            />
          </div>


          {/* Subagents */}
          {childAgents.length > 0 && (
            <div className="mt-3 pt-3 border-t border-ul-border">
              <label className="text-caption text-ul-text-muted block mb-2">
                Subagents ({childAgents.length})
              </label>
              <div className="space-y-2">
                {childAgents.map(child => (
                  <div key={child.id} className="flex items-center gap-2 px-2 py-1.5 bg-white rounded border border-ul-border">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotClass(child.status)}`} />
                    <span className="text-small text-ul-text flex-1 truncate">{child.name}</span>
                    <span className="text-caption text-ul-text-muted">{child.role}</span>
                    <button
                      onClick={() => openSubagentWindow(child.id, child.name)}
                      className="text-caption text-blue-500 hover:text-blue-700 whitespace-nowrap"
                    >
                      Open Chat ↗
                    </button>
                    {child.status === 'running' && onStopSubagent && (
                      <button
                        onClick={() => onStopSubagent(child.id)}
                        className="text-caption text-ul-error hover:text-red-700"
                      >
                        Stop
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
