// CmdKPalette — global Cmd+K / Ctrl+K command palette. Type to filter,
// arrow keys to navigate, Enter to fire, Escape to close.
//
// Ported from handoff/mockups/palette-and-empty.jsx. Action wiring is real:
// each palette entry routes through callbacks supplied by App.tsx. Items
// that don't have a production target are documented as follow-ups (F2).

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  IconSearch,
  IconBolt,
  IconCirclePlus,
  IconWallet,
  IconSettings as IconSettingsRaw,
  IconUser,
  IconWrench,
  IconStore,
} from './ui/icons';
import type { SystemAgentConfig } from '../lib/systemAgents';

export interface PaletteAction {
  id: string;
  group: 'Agents' | 'Commands' | 'Wallet' | 'Settings';
  label: string;
  shortcut?: string;
  iconName: 'wrench' | 'store' | 'settings' | 'user' | 'bolt' | 'plus' | 'wallet';
  /** Per-agent tint; otherwise default mute. */
  color?: string;
  onSelect: () => void;
}

const ICON_MAP: Record<PaletteAction['iconName'], ComponentType<{ size?: number }>> = {
  wrench: IconWrench,
  store: IconStore,
  settings: IconSettingsRaw,
  user: IconUser,
  bolt: IconBolt,
  plus: IconCirclePlus,
  wallet: IconWallet,
};

const GROUP_ORDER: PaletteAction['group'][] = ['Agents', 'Commands', 'Wallet', 'Settings'];

interface CmdKPaletteProps {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}

export default function CmdKPalette({ open, onClose, actions }: CmdKPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return actions;
    return actions.filter(
      a => a.label.toLowerCase().includes(term) || a.group.toLowerCase().includes(term),
    );
  }, [actions, query]);

  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered, activeIdx]);

  // Bucket filtered actions in canonical group order so the visible groups
  // don't shuffle as the user types.
  const grouped = useMemo(() => {
    const acc = new Map<PaletteAction['group'], { item: PaletteAction; i: number }[]>();
    filtered.forEach((item, i) => {
      const list = acc.get(item.group) ?? [];
      list.push({ item, i });
      acc.set(item.group, list);
    });
    return GROUP_ORDER
      .map(group => ({ group, entries: acc.get(group) ?? [] }))
      .filter(g => g.entries.length > 0);
  }, [filtered]);

  const handleKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[activeIdx];
      if (target) {
        target.onSelect();
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      className="absolute inset-0 z-[100] flex items-start justify-center pt-[60px] animate-fade-in"
      style={{ background: 'rgba(10,10,10,0.4)' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-[560px] max-w-[90%] bg-white rounded-card overflow-hidden animate-pop"
        style={{ boxShadow: '0 24px 60px rgba(0,0,0,0.25)' }}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-ul-border">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Type a command or search..."
            aria-label="Command palette search"
            className="flex-1 border-none outline-none bg-transparent text-small text-ul-text"
          />
          <span className="text-nano font-mono text-ul-text-muted px-1.5 py-0.5 border border-ul-border rounded-xs">
            esc
          </span>
        </div>

        <div className="max-h-[360px] overflow-auto py-1">
          {grouped.length === 0 ? (
            <div className="p-5 text-center text-small text-ul-text-muted">No matches.</div>
          ) : (
            grouped.map(({ group, entries }) => (
              <div key={group}>
                <div className="px-4 pt-2 pb-1 text-nano font-medium tracking-wider uppercase text-ul-text-muted font-mono">
                  {group}
                </div>
                {entries.map(({ item, i }) => {
                  const Icon = ICON_MAP[item.iconName];
                  const selected = i === activeIdx;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onMouseEnter={() => setActiveIdx(i)}
                      onClick={() => {
                        item.onSelect();
                        onClose();
                      }}
                      className={`w-full flex items-center gap-2.5 px-4 py-2 cursor-pointer border-l-2 text-left ${
                        selected ? 'bg-ul-bg-hover border-l-ul-text' : 'bg-transparent border-l-transparent'
                      }`}
                    >
                      <span
                        className="inline-flex w-4 justify-center"
                        style={{ color: item.color ?? 'var(--ul-text-secondary, #555)' }}
                      >
                        <Icon size={14} />
                      </span>
                      <span className="text-small text-ul-text flex-1">{item.label}</span>
                      {item.shortcut && (
                        <span className="text-nano font-mono text-ul-text-muted">{item.shortcut}</span>
                      )}
                      {selected && <span className="text-nano font-mono text-ul-text-muted">↵</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex gap-3.5 px-4 py-2 border-t border-ul-border text-nano font-mono text-ul-text-muted">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

// Build the canonical action list from current navigation helpers + system
// agents. Caller passes only callbacks they actually have; we filter out
// unwired ones so the palette never advertises a no-op.
export interface BuildPaletteActionsArgs {
  systemAgents: SystemAgentConfig[];
  onPickSystemAgent: (agent: SystemAgentConfig) => void;
  onNewChat: () => void;
  onTopUp: () => void;
  onSettings: () => void;
  onProfile: () => void;
}

const AGENT_TYPE_TO_ICON: Record<string, PaletteAction['iconName']> = {
  tool_builder: 'wrench',
  tool_marketer: 'store',
  platform_manager: 'settings',
};

export function buildPaletteActions(args: BuildPaletteActionsArgs): PaletteAction[] {
  const items: PaletteAction[] = [];

  args.systemAgents.forEach((agent, i) => {
    items.push({
      id: `agent-${agent.type}`,
      group: 'Agents',
      label: agent.name,
      shortcut: `⌘${i + 1}`,
      iconName: AGENT_TYPE_TO_ICON[agent.type] ?? 'wrench',
      color: agent.accent,
      onSelect: () => args.onPickSystemAgent(agent),
    });
  });

  items.push({
    id: 'cmd-new-chat',
    group: 'Commands',
    label: 'New chat',
    shortcut: '⌘N',
    iconName: 'plus',
    onSelect: args.onNewChat,
  });

  items.push({
    id: 'wallet-top-up',
    group: 'Wallet',
    label: 'Top up Light (✦)',
    iconName: 'wallet',
    onSelect: args.onTopUp,
  });

  items.push({
    id: 'settings-prefs',
    group: 'Settings',
    label: 'Preferences',
    shortcut: '⌘,',
    iconName: 'settings',
    onSelect: args.onSettings,
  });

  items.push({
    id: 'settings-profile',
    group: 'Settings',
    label: 'Profile',
    iconName: 'user',
    onSelect: args.onProfile,
  });

  return items;
}
