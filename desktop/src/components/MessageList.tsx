// Scrollable message thread with auto-scroll on new content.

import { useEffect, useRef, useState } from 'react';
import type { Message } from '../hooks/useChat';
import type { SystemAgentConfig } from '../lib/systemAgents';
import MessageBubble from './MessageBubble';
import ConstellationHero from './ui/ConstellationHero';

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  /** When set, renders a personalised welcome screen instead of the generic empty state */
  systemAgent?: SystemAgentConfig;
  /** Fires a starter prompt as if the user typed it */
  onStarterClick?: (prompt: string) => void;
  /** Fired from the generic-empty constellation hero — navigates to that system agent's chat. */
  onPickSystemAgent?: (agent: SystemAgentConfig) => void;
}

export default function MessageList({ messages, isLoading, systemAgent, onStarterClick, onPickSystemAgent }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  // Track message IDs we've already rendered, so animate-msg-rise only fires
  // on newly appended bubbles (not on first paint of a loaded thread).
  // Lazy init seeds with every existing ID so the initial pass renders silently.
  const [seenIds] = useState<Set<string>>(() => new Set(messages.map(m => m.id)));
  const newIds = new Set<string>();
  for (const msg of messages) {
    if (!seenIds.has(msg.id)) {
      newIds.add(msg.id);
    }
  }
  useEffect(() => {
    newIds.forEach(id => seenIds.add(id));
  });

  // Build tool results map: tool_call_id → result content
  const toolResults = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults.set(msg.tool_call_id, msg.content);
    }
  }

  // Track if user has scrolled up manually
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      userScrolled.current = scrollHeight - scrollTop - clientHeight > 80;
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll to bottom on new messages (unless user scrolled up)
  useEffect(() => {
    if (!userScrolled.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Filter out tool messages (they render inside ToolCallCard)
  const visibleMessages = messages.filter(m => m.role !== 'tool');

  if (visibleMessages.length === 0) {
    // System agent: personalised welcome with starter prompts
    if (systemAgent) {
      const { welcome, name } = systemAgent;
      return (
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center max-w-md">
            <h2 className="text-h3 text-ul-text mb-2">{name}</h2>
            <p className="text-body text-ul-text-muted mb-6">
              {welcome.greeting}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {welcome.starters.map(s => (
                <button
                  key={s.label}
                  onClick={() => onStarterClick?.(s.prompt)}
                  className="px-3 py-1.5 text-caption rounded-full border border-ul-border
                             text-ul-text-muted hover:text-ul-text hover:border-ul-text
                             transition-colors cursor-pointer bg-transparent"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      );
    }

    // Generic empty state — the product constellation. Picking a dot routes
    // the user into that system agent's chat (handled by ChatView upstream).
    return (
      <div className="flex-1 min-h-0">
        <ConstellationHero onPickAgent={onPickSystemAgent} />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 py-4"
    >
      <div className="max-w-narrow mx-auto">
        {visibleMessages.map(msg => (
          <MessageBubble
            key={msg.id}
            message={msg}
            toolResults={toolResults}
            toolsExecuting={isLoading}
            isNew={newIds.has(msg.id)}
          />
        ))}

        {/* Persistent working indicator — visible entire time agent is active */}
        {isLoading && (
          <div className="flex items-center gap-2 py-3 px-1">
            <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-200 border-t-gray-500 animate-spin flex-shrink-0" />
            <span className="text-caption text-ul-text-muted">Working...</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
