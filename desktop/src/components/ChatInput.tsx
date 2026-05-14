// Chat input — premium-UI composer (Batches 2b-i + 2b-ii).
//
// Layout (mockup: handoff/mockups/composer.jsx PremiumComposer):
//   Card chrome with focused-state ring; two rows:
//     TOP    [paperclip] [textarea] [stop?] [send]
//     BOTTOM [Tool selection pill]    [Flash | Heavy pills]
//   Inline @-mention autocomplete rises above the card from useAgentFleet.
//
// Tool Selection popover renders ambient suggestions (passed in from
// useAmbientSuggestions in ChatView). Model pills fetch inference settings
// lazily on first open and persist picks via setInterpreterModel /
// setHeavyModel.

import { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowUp, Paperclip, ChevronDown, Sparkles } from 'lucide-react';
import type { Agent } from '../hooks/useAgentFleet';
import type { AmbientSuggestion } from '../types/ambientSuggestion';
import ProjectDropdown from './ProjectDropdown';
import ToolSelectionPopover from './composer/ToolSelectionPopover';
import ModelPickerPopover from './composer/ModelPickerPopover';
import {
  getInterpreterModel,
  setInterpreterModel as persistInterpreterModel,
  getHeavyModel,
  setHeavyModel as persistHeavyModel,
} from '../lib/storage';
import { fetchInferenceSettings, type InferenceSettings } from '../lib/api';

/** File attachment ready to send — base64-encoded with metadata */
export interface ChatFile {
  name: string;
  size: number;
  mimeType: string;
  content: string; // base64 data URL
}

interface ChatInputProps {
  onSend: (content: string, files?: ChatFile[]) => void;
  isLoading: boolean;
  onStop?: () => void;
  /** When true, input stays enabled during loading — sends go to queue */
  queueMode?: boolean;
  /** Current conversation's project directory */
  projectDir?: string | null;
  /** Called when user picks a new project directory */
  onProjectDirChange?: (dir: string) => void;
  /** Agent fleet for @-mention autocomplete. Falls back to no autocomplete when undefined. */
  agents?: Agent[];
  /** Ambient + connected app suggestions (from useAmbientSuggestions). */
  ambientSuggestions?: AmbientSuggestion[];
  /** When true, the Tool Selection pill shows an animated halo to signal a fresh signal. */
  ambientHasNew?: boolean;
  /** Whether the in-chat ambient panel is currently open. Drives the pill's
   *  "active" state and routes clicks: click while panel-open closes the panel. */
  toolDealerPanelOpen?: boolean;
  /** Open the in-chat ambient panel (also marks the signal as viewed). */
  onOpenToolDealerPanel?: () => void;
  /** Close the in-chat ambient panel. */
  onCloseToolDealerPanel?: () => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.ts,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.sh,.sql,.toml,.doc,.docx';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Short label for a model id (strips provider prefix + version filler). */
function formatModelLabel(model: string): string {
  // Strip provider prefix: "openrouter/anthropic/claude-haiku-4.5" -> "claude-haiku-4.5"
  const tail = model.split('/').pop() ?? model;
  // Cosmetic shortening to match mockup compactness
  return tail
    .replace(/^claude-/, '')
    .replace(/^gpt-/, 'gpt-')
    .replace(/^gemini-/, 'gem-')
    .replace(/^deepseek-/, 'ds-')
    .replace(/:nitro$/, '');
}

type SendState = 'idle' | 'armed' | 'flying' | 'landed';

interface MentionMenu {
  q: string;
  idx: number;
}

// ── ChatInput ─────────────────────────────────────────────────────────

export default function ChatInput({
  onSend,
  isLoading,
  onStop,
  queueMode = false,
  projectDir,
  onProjectDirChange,
  agents,
  ambientSuggestions = [],
  ambientHasNew = false,
  toolDealerPanelOpen = false,
  onOpenToolDealerPanel,
  onCloseToolDealerPanel,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [send, setSend] = useState<SendState>('idle');
  const [focused, setFocused] = useState(false);
  const [mention, setMention] = useState<MentionMenu | null>(null);
  const [popover, setPopover] = useState<'tools' | 'flash' | 'heavy' | null>(null);

  // Reactive model selections — read once from storage, then maintain
  // locally so picker updates re-render the pill label immediately.
  const [flashModel, setFlashModel] = useState<string>(() => getInterpreterModel());
  const [heavyModel, setHeavyModel] = useState<string>(() => getHeavyModel());

  // Inference options are lazy-loaded the first time a model popover opens,
  // then cached for the lifetime of this composer instance.
  const [inferenceOptions, setInferenceOptions] = useState<InferenceSettings | null>(null);
  const inferenceFetchedRef = useRef(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolsBtnRef = useRef<HTMLButtonElement>(null);
  const flashBtnRef = useRef<HTMLButtonElement>(null);
  const heavyBtnRef = useRef<HTMLButtonElement>(null);

  const flashLabel = formatModelLabel(flashModel);
  const heavyLabel = formatModelLabel(heavyModel);

  // Lazy-fetch inference options on first model-popover open
  useEffect(() => {
    if (popover !== 'flash' && popover !== 'heavy') return;
    if (inferenceFetchedRef.current) return;
    inferenceFetchedRef.current = true;
    fetchInferenceSettings()
      .then(setInferenceOptions)
      .catch(() => { inferenceFetchedRef.current = false; /* retry on next open */ });
  }, [popover]);

  // Handlers for model picks — write storage + update local state
  const pickFlash = useCallback((id: string) => {
    persistInterpreterModel(id);
    setFlashModel(id);
  }, []);
  const pickHeavy = useCallback((id: string) => {
    persistHeavyModel(id);
    setHeavyModel(id);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [value]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // In queue mode, input is never disabled — messages go to queue
  const inputDisabled = isLoading && !queueMode;
  const isQueueing = isLoading && queueMode;

  const hasContent = value.trim().length > 0 || files.length > 0;

  // Drive armed/idle state from content presence (not while flying/landed)
  useEffect(() => {
    setSend(s => (s === 'flying' || s === 'landed') ? s : (hasContent ? 'armed' : 'idle'));
  }, [hasContent]);

  // ── @-mention detection ───────────────────────────────────────
  useEffect(() => {
    if (!agents || agents.length === 0) {
      if (mention) setMention(null);
      return;
    }
    const match = value.match(/(^|\s)@([\w-]*)$/);
    if (match) {
      const q = match[2].toLowerCase();
      setMention(prev => prev ? { ...prev, q } : { q, idx: 0 });
    } else if (mention) {
      setMention(null);
    }
  }, [value, agents]);

  const filteredAgents = (mention && agents)
    ? agents.filter(a => a.name.toLowerCase().replace(/\s/g, '').startsWith(mention.q.replace(/\s/g, '')))
    : [];

  const applyMention = useCallback((agent: Agent) => {
    const inserted = '@' + agent.name.replace(/\s/g, '') + ' ';
    setValue(prev => prev.replace(/@([\w-]*)$/, inserted));
    setMention(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  // ── Send / launch ─────────────────────────────────────────────
  const launch = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && files.length === 0) return;
    if (isLoading && !queueMode) return;
    if (send === 'flying') return;

    setSend('flying');
    // The flying frame lingers ~180ms so the animation reads as a launch
    // before the textarea clears and the next state takes over.
    setTimeout(() => {
      onSend(trimmed || '(attached files)', files.length > 0 ? files : undefined);
      setValue('');
      setFiles([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      setSend('landed');
      setTimeout(() => setSend('idle'), 280);
    }, 180);
  }, [value, files, isLoading, queueMode, send, onSend]);

  // ── Keyboard ──────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // @-mention navigation takes precedence
    if (mention && filteredAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention(m => m ? { ...m, idx: (m.idx + 1) % filteredAgents.length } : m);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention(m => m ? { ...m, idx: (m.idx - 1 + filteredAgents.length) % filteredAgents.length } : m);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyMention(filteredAgents[mention.idx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      launch();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      launch();
    }
  };

  // ── Files ─────────────────────────────────────────────────────
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected) return;

    Array.from(selected).forEach(file => {
      if (file.size > MAX_FILE_SIZE) {
        alert(`${file.name} is too large (max ${formatSize(MAX_FILE_SIZE)})`);
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        if (!dataUrl) return;
        setFiles(prev => [...prev, {
          name: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          content: dataUrl,
        }]);
      };
      reader.readAsDataURL(file);
    });

    // Reset input so the same file can be re-selected
    e.target.value = '';
  }, []);

  const removeFile = useCallback((idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  }, []);

  // ── Send-button visuals ───────────────────────────────────────
  // Maps SendState -> Tailwind classes. Exact-hex token mapping per
  // DESIGN-TOKENS-DIFF: PC_C.text=#0a0a0a=ul-text, PC_C.mute=#999=ul-text-muted,
  // PC_C.border=rgba(0,0,0,.08)=ul-border, PC_C.blue=#3b82f6=ul-info.
  const sendClasses = (() => {
    switch (send) {
      case 'flying':
        return 'border-ul-info bg-ul-info text-white -translate-y-0.5 scale-105';
      case 'landed':
        return hasContent
          ? 'border-ul-text text-ul-text bg-transparent scale-90'
          : 'border-ul-border text-ul-text-muted bg-transparent scale-90';
      case 'armed':
        return 'border-ul-text text-ul-text bg-transparent';
      case 'idle':
      default:
        return 'border-ul-border text-ul-text-muted bg-transparent';
    }
  })();

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="bg-ul-bg px-4 pt-3 pb-4">
      <div className="max-w-narrow mx-auto">
        {/* File chips — aligned with textarea */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 pl-10">
            {files.map((f, i) => (
              <div
                key={`${f.name}-${i}`}
                // TODO(token): bg-gray-100, text-gray-600, text-gray-400 — no exact ul-* equivalents; kept raw.
                className="flex items-center gap-1.5 px-2 py-1 bg-gray-100 rounded-md text-xs text-gray-600 max-w-[200px]"
              >
                <span className="truncate">{f.name}</span>
                <span className="text-gray-400 flex-shrink-0">{formatSize(f.size)}</span>
                <button
                  onClick={() => removeFile(i)}
                  className="text-gray-400 hover:text-gray-600 flex-shrink-0 ml-0.5"
                  title="Remove"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="relative">
          {/* @-mention autocomplete — rises above the card */}
          {mention && filteredAgents.length > 0 && (
            <div className="absolute left-0 right-0 z-10 rounded-lg border border-ul-border bg-ul-bg shadow-md overflow-hidden animate-fade-up"
                 style={{ bottom: 'calc(100% + 4px)' }}>
              <div className="px-3.5 pt-2.5 pb-1 text-nano text-ul-text-muted font-mono uppercase">
                Agents
              </div>
              {filteredAgents.map((a, i) => {
                const selected = i === mention.idx;
                return (
                  <div
                    key={a.id}
                    onMouseEnter={() => setMention(m => m ? { ...m, idx: i } : m)}
                    onMouseDown={(e) => { e.preventDefault(); applyMention(a); }}
                    className={`flex items-center gap-2.5 px-3.5 py-2 cursor-pointer ${
                      selected ? 'bg-ul-bg-hover' : 'bg-transparent'
                    }`}
                  >
                    <span className="text-micro font-mono text-ul-text font-medium">
                      @{a.name}
                    </span>
                    <span className="text-caption text-ul-text-muted flex-1 truncate">
                      {a.system_agent_type ? 'System agent' : (a.role || 'Agent')}
                    </span>
                    {selected && <span className="text-nano font-mono text-ul-text-muted">↵</span>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Composer card */}
          <div
            className={`rounded-xl border bg-ul-bg transition-all ${
              focused
                ? 'border-ul-border-strong shadow-glow'
                : 'border-ul-border'
            }`}
          >
            {/* Top row — input + send */}
            <div className="flex items-end gap-2 px-3 pt-3 pb-2">
              {/* Attachment icon */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={inputDisabled}
                // TODO(token): text-gray-400 / text-gray-600 hover / hover:bg-gray-100 — no exact ul-* equivalents.
                className="flex items-center justify-center w-8 h-8 rounded-full text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-30 transition-colors flex-shrink-0 mb-[3px]"
                title="Attach file"
              >
                <Paperclip className="w-5 h-5 rotate-45 -scale-x-100" strokeWidth={1.5} />
              </button>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_TYPES}
                onChange={handleFileSelect}
                className="hidden"
              />

              <textarea
                ref={textareaRef}
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={isQueueing ? 'Queue a follow-up...' : 'Message...'}
                rows={1}
                // TODO(token): placeholder:text-gray-500 — no exact ul-* equivalent.
                className="flex-1 resize-none border-none px-0 text-small text-ul-text bg-transparent outline-none placeholder:text-gray-500 selectable"
                style={{ paddingTop: '6px', paddingBottom: '6px', lineHeight: '20px' }}
                disabled={inputDisabled}
              />

              {/* Stop button — production-only; flagged in PR for design follow-up. */}
              {isLoading && (
                <button
                  onClick={onStop}
                  // TODO(token): bg-gray-200, text-gray-500 — no exact ul-* equivalents; kept raw.
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-200 text-gray-500 hover:bg-gray-200 transition-colors flex-shrink-0 mb-0.5"
                  title="Stop"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              )}

              {/* Queue / Send */}
              {isQueueing ? (
                <button
                  onClick={launch}
                  disabled={!hasContent}
                  // TODO(token): bg-amber-500/600 hover pair — exact-match on the base (=ul-warning) but no -hover token.
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-30 transition-colors flex-shrink-0 mb-0.5"
                  title="Queue"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>
              ) : !isLoading ? (
                <button
                  onClick={launch}
                  disabled={!hasContent && send !== 'flying'}
                  className={`flex items-center justify-center w-7 h-7 rounded-full border transition-all duration-base disabled:cursor-not-allowed ${sendClasses}`}
                  title="Send"
                >
                  <ArrowUp className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
              ) : null}
            </div>

            {/* Bottom row — tools + model pills */}
            <div className="flex items-center justify-between px-2 pb-2 gap-2">
              <div className="flex items-center gap-1">
                {/* Tool selection pill — pill is a strict toggle:
                    • popover open  → close everything (popover + dealer panel)
                    • dealer panel open → close panel (no popover)
                    • neither open  → open the popover */}
                <div className="relative">
                  <button
                    ref={toolsBtnRef}
                    onClick={() => {
                      if (popover === 'tools') {
                        setPopover(null);
                        onCloseToolDealerPanel?.();
                      } else if (toolDealerPanelOpen) {
                        onCloseToolDealerPanel?.();
                      } else {
                        setPopover('tools');
                      }
                    }}
                    // TODO(token): text-[#777] (composer mute) — close to text-ul-text-secondary but not exact; kept raw.
                    className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-caption font-medium transition-colors text-[#777] ${
                      popover === 'tools' || toolDealerPanelOpen ? 'bg-ul-accent-soft' : 'bg-transparent hover:bg-ul-bg-hover'
                    }`}
                  >
                    {ambientHasNew ? (
                      // Animated halo — static inner ring + pulsing outer ring
                      // when the popover is closed. Outer ring is suppressed
                      // when the popover is already open (you're looking at it).
                      <span className="relative w-[7px] h-[7px] inline-block flex-shrink-0">
                        <span className="absolute inset-0 rounded-full border border-black/[0.55] box-border" />
                        {popover !== 'tools' && (
                          <span
                            className="absolute inset-0 rounded-full border border-black/[0.55] box-border"
                            style={{ animation: 'ul-halo 1.8s ease-out infinite' }}
                          />
                        )}
                      </span>
                    ) : (
                      <Sparkles className="w-3.5 h-3.5" strokeWidth={1.5} />
                    )}
                    <span>Tool selection</span>
                  </button>
                  <ToolSelectionPopover
                    open={popover === 'tools'}
                    onClose={() => setPopover(null)}
                    anchorRef={toolsBtnRef}
                    suggestions={ambientSuggestions}
                    onOpenPanel={onOpenToolDealerPanel}
                  />
                </div>
              </div>

              {/* Model pills — Flash | Heavy */}
              <div className="flex items-center">
                <div className="relative">
                  <button
                    ref={flashBtnRef}
                    onClick={() => setPopover(p => p === 'flash' ? null : 'flash')}
                    // TODO(token): text-[#888] (composer mute) — close to text-ul-text-muted; kept raw to match mockup exactly.
                    className={`inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-l-full text-micro transition-colors text-[#888] ${
                      popover === 'flash' ? 'bg-ul-accent-soft' : 'bg-transparent hover:bg-ul-bg-hover'
                    }`}
                    title="Flash model"
                  >
                    <span>{flashLabel}</span>
                  </button>
                  <ModelPickerPopover
                    open={popover === 'flash'}
                    onClose={() => setPopover(null)}
                    anchorRef={flashBtnRef}
                    tier="flash"
                    options={inferenceOptions}
                    selectedModel={flashModel}
                    onPick={pickFlash}
                  />
                </div>

                <span className="w-px h-3.5 bg-ul-border opacity-70" />

                <div className="relative">
                  <button
                    ref={heavyBtnRef}
                    onClick={() => setPopover(p => p === 'heavy' ? null : 'heavy')}
                    // TODO(token): text-[#888] — see above.
                    className={`inline-flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-r-full text-micro transition-colors text-[#888] ${
                      popover === 'heavy' ? 'bg-ul-accent-soft' : 'bg-transparent hover:bg-ul-bg-hover'
                    }`}
                    title="Heavy model"
                  >
                    <span>{heavyLabel}</span>
                    <ChevronDown className="w-2.5 h-2.5" strokeWidth={1.5} />
                  </button>
                  <ModelPickerPopover
                    open={popover === 'heavy'}
                    onClose={() => setPopover(null)}
                    anchorRef={heavyBtnRef}
                    tier="heavy"
                    options={inferenceOptions}
                    selectedModel={heavyModel}
                    onPick={pickHeavy}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {onProjectDirChange && (
          <div className="mt-2 pl-10">
            <ProjectDropdown
              selectedDir={projectDir ?? null}
              onSelect={(dir) => dir && onProjectDirChange(dir)}
              dropUp
              compact
            />
          </div>
        )}
      </div>
    </div>
  );
}
