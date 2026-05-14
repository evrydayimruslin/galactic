// OnboardingWizard — Platform Guide. Choreographed 4-stop tour that ends in
// a live composer; sending the first message dissolves the wizard into chat.
// Visual port of handoff/mockups/onboarding.jsx (AFTER variant).
//
// The wizard still drives sidebar highlights via onHighlight, and onComplete
// accepts an optional draft prompt — App.tsx routes to chat with that prompt
// pre-seeded so the tour's last action becomes the user's first message.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import E3Mark from './ui/E3Mark';
import Spark from './ui/Spark';
import { IconWrench, IconStore, IconSettings } from './ui/icons';
import { SYSTEM_AGENTS } from '../lib/systemAgents';

export type OnboardingHighlight = 'none' | 'tools' | 'chat-command' | 'agents';

interface OnboardingWizardProps {
  onComplete: (navigateTo?: 'chat' | 'tools', draftPrompt?: string) => void;
  onHighlight: (highlight: OnboardingHighlight) => void;
}

const STEPS = ['welcome', 'apps', 'ways', 'build'] as const;
const HIGHLIGHTS: OnboardingHighlight[] = ['none', 'tools', 'chat-command', 'agents'];

const AGENT_ICONS = {
  Wrench: IconWrench,
  Store: IconStore,
  Settings: IconSettings,
} as const;

// ── Typing wordmark — used on the welcome screen ─────────────────────────
function TypingWordmark({ replayKey }: { replayKey: number }) {
  const target = 'Ultralight';
  const [n, setN] = useState(0);

  useEffect(() => {
    setN(0);
    const t = setInterval(() => {
      setN(prev => {
        if (prev >= target.length) {
          clearInterval(t);
          return prev;
        }
        return prev + 1;
      });
    }, 70);
    return () => clearInterval(t);
  }, [replayKey]);

  return (
    <span className="inline-flex items-center gap-2">
      {/* Optical-center pull: orbit + outer dots extend higher than cap-height. */}
      <span className="inline-flex" style={{ marginTop: 4 }}>
        <E3Mark size={42} color="#0a0a0a" />
      </span>
      <span className="font-bold leading-none tracking-[-0.03em] text-ul-text" style={{ fontSize: 36 }}>
        {target.slice(0, n)}
        {n < target.length && (
          <span
            className="inline-block align-middle bg-ul-text"
            style={{
              width: 2,
              height: 28,
              marginLeft: 2,
              animation: 'ul-caret 1s steps(1) infinite',
            }}
          />
        )}
      </span>
    </span>
  );
}

// ── Mini three-dot mark — used inside pre-installed app tiles ─────────────
function MiniMark({ size = 28, accent, idx = 0 }: { size?: number; accent: string; idx?: number }) {
  const r = size * 0.11;
  const cx = size / 2;
  const dy = size * 0.18;
  const positions = [
    { x: cx, y: cx - dy * 1.1 },
    { x: cx - dy, y: cx + dy * 0.5 },
    { x: cx + dy, y: cx + dy * 0.5 },
  ];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {positions.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={r}
          fill={i === idx ? accent : 'rgba(0,0,0,0.16)'}
          style={{ transition: 'fill 320ms ease' }}
        />
      ))}
    </svg>
  );
}

// ── Staggered tile wrapper ────────────────────────────────────────────────
function Tile({
  active,
  delay,
  children,
  className,
  style,
}: {
  active: boolean;
  delay: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={className}
      style={{
        ...style,
        opacity: active ? 1 : 0,
        transform: active ? 'translateY(0)' : 'translateY(8px)',
        transition: `opacity 480ms cubic-bezier(.2,.9,.3,1) ${delay}ms, transform 480ms cubic-bezier(.2,.9,.3,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

export default function OnboardingWizard({ onComplete, onHighlight }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const [stepKey, setStepKey] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLInputElement | null>(null);

  // Re-trigger the staggered entrance whenever the step (or step replay) advances.
  useEffect(() => {
    setReveal(false);
    const t = setTimeout(() => setReveal(true), 80);
    return () => clearTimeout(t);
  }, [stepKey]);

  const goTo = useCallback((n: number) => {
    setStep(n);
    setStepKey(k => k + 1);
    onHighlight(HIGHLIGHTS[n] ?? 'none');
  }, [onHighlight]);

  const skip = useCallback(() => {
    onHighlight('none');
    onComplete();
  }, [onComplete, onHighlight]);

  const sendDraft = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onHighlight('none');
    onComplete('chat', trimmed);
  }, [draft, onComplete, onHighlight]);

  // Pre-installed apps tiles — colored dots cycle through the three agent hues.
  const apps = [
    { name: 'Email Ops',     desc: 'Approval workflows for your inbox', accent: '#3b82f6' },
    { name: 'Private Tutor', desc: 'Quizzes that find your weak spots', accent: '#722F37' },
    { name: 'Recipe Box',    desc: "Recipes from what's in the fridge", accent: '#004225' },
  ];

  // Builder roles — pull from the canonical system-agent table so colors and
  // icons stay in sync with the sidebar.
  const builder = SYSTEM_AGENTS[0]; // tool_builder
  const dealer = SYSTEM_AGENTS[1];  // tool_marketer
  const manager = SYSTEM_AGENTS[2]; // platform_manager
  const builderRoles = [
    { agent: builder, title: 'Tool Maker',     role: 'builds it', desc: 'Describe what you want. It writes, tests, deploys — in chat.' },
    { agent: dealer,  title: 'Tool Dealer',    role: 'sells it',  desc: 'Lists to the marketplace, sets your price. Real Stripe payouts.' },
    { agent: manager, title: 'Platform Guide', role: 'tunes it',  desc: 'Spend caps, permissions, receipts. Quietly running.' },
  ];

  return (
    <div className="absolute inset-0 z-40 bg-white flex flex-col">
      {/* Draggable title bar region */}
      <div className="h-toolbar flex-shrink-0" data-tauri-drag-region />

      {/* Stage */}
      <div className="flex-1 flex flex-col items-center justify-center px-7 overflow-y-auto text-center">

        {/* ── Step 0: Welcome — typing wordmark ─────────────────────────── */}
        {step === 0 && (
          <div key={stepKey} className="max-w-[480px]">
            <div
              className="mb-5"
              style={{
                opacity: reveal ? 1 : 0,
                transform: reveal ? 'translateY(0)' : 'translateY(6px)',
                transition: 'opacity 600ms ease, transform 600ms ease',
              }}
            >
              <TypingWordmark replayKey={stepKey} />
            </div>
            <Tile active={reveal} delay={900}>
              <p className="text-body text-ul-text-secondary leading-relaxed">
                A platform where every app works with chat — and anyone can build, share, and sell apps.
              </p>
            </Tile>
            <Tile active={reveal} delay={1200} style={{ marginTop: 24 }}>
              <p className="text-micro text-ul-text-muted font-mono tracking-wider">
                4 stops · ~30 seconds
              </p>
            </Tile>
          </div>
        )}

        {/* ── Step 1: Pre-installed apps ─────────────────────────────────── */}
        {step === 1 && (
          <div key={stepKey} className="w-full max-w-[580px] text-left">
            <Tile active={reveal} delay={0}>
              <p className="text-nano font-semibold tracking-[0.16em] text-ul-success-hover uppercase">
                Pre-installed · 18 tools
              </p>
            </Tile>
            <Tile active={reveal} delay={120} style={{ marginTop: 8 }}>
              <h1 className="text-h1 text-ul-text">Your apps are ready.</h1>
            </Tile>
            <Tile active={reveal} delay={240} style={{ marginTop: 8 }}>
              <p className="text-small text-ul-text-secondary leading-relaxed">
                Start using them in chat right away — every one signed and metered in{' '}
                <span className="font-semibold text-ul-text">✦Light</span>.
              </p>
            </Tile>

            <div className="grid grid-cols-3 gap-3 mt-6">
              {apps.map((a, i) => (
                <Tile key={a.name} active={reveal} delay={420 + i * 120}>
                  <div
                    className="bg-white rounded-card p-3.5 flex flex-col gap-2"
                    style={{
                      boxShadow: '0 1px 0 rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.05)',
                      height: 130,
                    }}
                  >
                    <MiniMark size={28} accent={a.accent} idx={i} />
                    <div className="text-small font-semibold mt-auto text-ul-text">{a.name}</div>
                    <div className="text-micro text-ul-text-muted leading-relaxed">{a.desc}</div>
                  </div>
                </Tile>
              ))}
            </div>

            <Tile active={reveal} delay={900} style={{ marginTop: 16 }}>
              <p className="text-micro text-ul-text-muted font-mono">
                + Memory Wiki · Smart Budget · Reading List · 15 more
              </p>
            </Tile>
          </div>
        )}

        {/* ── Step 2: Two surfaces — Command + Chat ──────────────────────── */}
        {step === 2 && (
          <div key={stepKey} className="w-full max-w-[600px] text-left">
            <Tile active={reveal} delay={0}>
              <p className="text-nano font-semibold tracking-[0.16em] text-ul-success-hover uppercase">
                How it works
              </p>
            </Tile>
            <Tile active={reveal} delay={120} style={{ marginTop: 8 }}>
              <h1 className="text-h1 text-ul-text">Two surfaces, one platform.</h1>
            </Tile>
            <Tile active={reveal} delay={240} style={{ marginTop: 8 }}>
              <p className="text-small text-ul-text-secondary leading-relaxed">
                Command is your dashboard. Chat is your conversation. Same apps. Same wallet.
              </p>
            </Tile>

            <div className="grid grid-cols-2 gap-3.5 mt-6">
              {/* Command — real-feeling dashboard tile */}
              <Tile active={reveal} delay={420}>
                <div
                  className="bg-white rounded-card flex flex-col overflow-hidden"
                  style={{
                    boxShadow: '0 1px 0 rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.05)',
                    height: 220,
                  }}
                >
                  <div className="flex items-center gap-2 px-3 py-2.5 border-b border-ul-border">
                    <span className="w-[18px] h-[18px] rounded-xs bg-ul-bg-raised flex items-center justify-center text-ul-text">
                      <IconSettings size={11} />
                    </span>
                    <span className="text-micro font-semibold">Command</span>
                    <span className="ml-auto text-nano font-mono text-ul-text-muted tracking-wider uppercase">Today</span>
                  </div>
                  <div className="flex-1 p-2.5 grid grid-cols-2 gap-2">
                    <div className="bg-ul-bg-raised rounded-md px-2.5 py-2 flex flex-col justify-between">
                      <div className="text-nano font-mono text-ul-text-muted tracking-wider uppercase">Light</div>
                      <div className="text-body font-bold tracking-tight tabular-nums">✦12.402</div>
                      <div className="text-nano text-ul-success-hover font-mono tabular-nums">+0.084 24h</div>
                    </div>
                    <div className="bg-ul-bg-raised rounded-md px-2.5 py-2 flex flex-col justify-between">
                      <div className="text-nano font-mono text-ul-text-muted tracking-wider uppercase">Approvals</div>
                      <div className="text-body font-bold tracking-tight tabular-nums">3</div>
                      <div className="flex gap-1">
                        <span className="rounded-sm" style={{ width: 14, height: 4, background: '#f59e0b' }} />
                        <span className="rounded-sm" style={{ width: 14, height: 4, background: '#3b82f6' }} />
                        <span className="rounded-sm" style={{ width: 14, height: 4, background: '#722F37' }} />
                      </div>
                    </div>
                    <div className="col-span-2 bg-ul-bg-raised rounded-md px-2.5 py-2">
                      <div className="flex items-center justify-between">
                        <div className="text-nano font-mono text-ul-text-muted tracking-wider uppercase">Calls / 24h</div>
                        <div className="text-micro font-bold tabular-nums">1,284</div>
                      </div>
                      <div className="flex items-end gap-[2px] mt-1.5" style={{ height: 26 }}>
                        {[6,9,5,12,18,10,14,22,15,11,8,17,24,19,13,9,11,16,21,15].map((h, i) => (
                          <span
                            key={i}
                            className="flex-1 bg-ul-text rounded-[1px]"
                            style={{ height: `${h*100/24}%`, opacity: 0.7 }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </Tile>

              {/* Chat — real conversation tile with a tool receipt */}
              <Tile active={reveal} delay={520}>
                <div
                  className="bg-white rounded-card flex flex-col overflow-hidden"
                  style={{
                    boxShadow: '0 1px 0 rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.05)',
                    height: 220,
                  }}
                >
                  <div className="flex items-center gap-2 px-3 py-2.5 border-b border-ul-border">
                    <span className="w-[18px] h-[18px] rounded-xs bg-ul-bg-raised flex items-center justify-center text-ul-text">
                      <IconStore size={11} />
                    </span>
                    <span className="text-micro font-semibold">Private Tutor</span>
                    <span className="w-[5px] h-[5px] rounded-full bg-ul-success-hover" />
                    <span className="ml-auto text-nano font-mono text-ul-text-muted tracking-wider uppercase">Live</span>
                  </div>
                  <div className="flex-1 p-2.5 flex flex-col gap-2 overflow-hidden">
                    <div className="self-end bg-ul-text text-white px-2.5 py-1 rounded-xl text-micro max-w-[85%]">
                      quiz me on Spanish irregular verbs
                    </div>
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-ul-bg-raised rounded-sm text-nano font-mono max-w-[85%]">
                      <span
                        className="w-[10px] h-[10px] rounded-full bg-ul-success-hover inline-flex items-center justify-center"
                      >
                        <svg width="6" height="6" viewBox="0 0 8 8" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
                          <path d="M1.5 4 L3.3 5.8 L6.5 2.5" />
                        </svg>
                      </span>
                      <span className="text-ul-text">private_tutor.start</span>
                      <span className="text-ul-text-muted">·</span>
                      <span className="text-ul-text-muted">✦0.001</span>
                    </div>
                    <div className="text-micro text-ul-text leading-relaxed">
                      Let&apos;s start with <strong>tener</strong>. How would you say
                    </div>
                    <div className="text-micro text-ul-text leading-relaxed">
                      &ldquo;I have two brothers&rdquo;?
                    </div>
                  </div>
                  <div className="px-2.5 py-2 border-t border-ul-border flex items-center gap-1.5">
                    <span className="flex-1 text-nano text-ul-text-muted italic">Type your answer…</span>
                    <span className="text-nano font-mono text-ul-text-muted px-1.5 py-0.5 bg-ul-bg-raised rounded-xs">↵</span>
                  </div>
                </div>
              </Tile>
            </div>
          </div>
        )}

        {/* ── Step 3: Three builder roles + composer ─────────────────────── */}
        {step === 3 && (
          <div key={stepKey} className="w-full max-w-[620px] text-left">
            <Tile active={reveal} delay={0}>
              <p className="text-nano font-semibold tracking-[0.16em] text-ul-success-hover uppercase">
                For builders
              </p>
            </Tile>
            <Tile active={reveal} delay={120} style={{ marginTop: 8 }}>
              <h1 className="text-h1 text-ul-text">Three guides. One pipeline.</h1>
            </Tile>
            <Tile active={reveal} delay={240} style={{ marginTop: 8 }}>
              <p className="text-small text-ul-text-secondary leading-relaxed">
                Hosting, database, auth, payments — automatic. You write the logic. They handle the rest.
              </p>
            </Tile>

            <div className="grid grid-cols-3 gap-3 mt-6">
              {builderRoles.map((f, i) => {
                const Icon = AGENT_ICONS[f.agent.icon as keyof typeof AGENT_ICONS] ?? IconWrench;
                return (
                  <Tile key={f.title} active={reveal} delay={420 + i * 140}>
                    <div
                      className="bg-white rounded-card p-4 flex flex-col"
                      style={{
                        boxShadow: '0 1px 0 rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.05)',
                        height: 168,
                      }}
                    >
                      <div
                        className="rounded-md flex items-center justify-center text-white"
                        style={{ width: 32, height: 32, background: f.agent.accent }}
                      >
                        <Icon size={16} />
                      </div>
                      <div className="mt-3">
                        <div className="text-small font-bold text-ul-text">{f.title}</div>
                        <div className="text-micro text-ul-text-muted font-mono">{f.role}</div>
                      </div>
                      <div className="text-micro text-ul-text-secondary leading-relaxed mt-2.5">
                        {f.desc}
                      </div>
                    </div>
                  </Tile>
                );
              })}
            </div>

            <Tile active={reveal} delay={900} style={{ marginTop: 24 }}>
              <div
                className="bg-ul-bg-raised rounded-card p-3 flex items-center gap-2.5"
                style={{ boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.04)' }}
              >
                <Spark size={16} color="#999999" />
                <input
                  ref={composerRef}
                  type="text"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && draft.trim()) {
                      e.preventDefault();
                      sendDraft();
                    }
                  }}
                  placeholder="Try it: deploy a hello-world tool…"
                  aria-label="Onboarding composer"
                  className="flex-1 bg-transparent outline-none border-none text-small text-ul-text"
                />
                <button
                  type="button"
                  disabled={!draft.trim()}
                  onClick={sendDraft}
                  className={`px-3 py-1.5 text-nano font-semibold font-mono rounded-sm border-none ${
                    draft.trim()
                      ? 'bg-ul-text text-white cursor-pointer'
                      : 'bg-ul-bg-active text-ul-text-muted cursor-not-allowed'
                  }`}
                >
                  send ↵
                </button>
              </div>
              <p className="text-micro text-ul-text-muted font-mono mt-1.5">
                Your first message ends the tour and starts the work.
              </p>
            </Tile>
          </div>
        )}
      </div>

      {/* ── Footer — rhythm bar + nav ─────────────────────────────────────── */}
      <div className="flex-shrink-0 px-5 pt-3.5 pb-4 flex flex-col gap-3">
        <div className="flex gap-1">
          {STEPS.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goTo(i)}
              className="flex-1 bg-transparent border-none p-0 cursor-pointer"
              aria-label={`Go to stop ${i + 1}`}
            >
              <div
                className="w-full rounded-sm"
                style={{
                  height: 3,
                  background: i <= step ? '#0a0a0a' : 'rgba(0,0,0,0.08)',
                  transition: 'background 320ms ease',
                }}
              />
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="text-micro text-ul-text-muted font-mono">
            {step + 1} / {STEPS.length} · {STEPS[step]}
          </div>

          <div className="flex items-center gap-2">
            {step < STEPS.length - 1 && (
              <button
                type="button"
                onClick={skip}
                className="text-micro text-ul-text-muted hover:text-ul-text-secondary transition-colors bg-transparent border-none cursor-pointer px-2"
              >
                Skip
              </button>
            )}
            {step > 0 && (
              <button
                type="button"
                onClick={() => goTo(step - 1)}
                className="text-small text-ul-text-secondary bg-transparent border-none px-3 py-1.5 cursor-pointer"
              >
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => goTo(step + 1)}
                className="bg-ul-text text-white border-none px-4 py-2 text-small font-medium rounded-md cursor-pointer inline-flex items-center gap-1.5"
              >
                {step === 0 ? 'Begin' : 'Next'}
                <span className="font-mono text-micro opacity-70">→</span>
              </button>
            ) : (
              <span className="text-micro text-ul-text-muted font-mono self-center">
                ↵ to begin
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
