// ConstellationHero — the "empty chat" hero. Reads as the product
// constellation: typing wordmark, slow orbit ellipse + center Light spark,
// three system-agent dot buttons in a triangle.
//
// Ported from handoff/mockups/palette-and-empty.jsx (ConstellationHero).
// Used by MessageList's generic empty state when no system agent is
// active — picking a dot navigates straight into that agent's chat.

import { useEffect, useState, useMemo } from 'react';
import Spark from './Spark';
import { IconWrench, IconStore, IconSettings } from './icons';
import type { SystemAgentConfig } from '../../lib/systemAgents';
import { SYSTEM_AGENTS } from '../../lib/systemAgents';

interface ConstellationHeroProps {
  /** Bump to re-trigger the typing + stagger sequence. */
  replayKey?: number;
  /** Subtitle below the wordmark. Defaults to the mockup copy. */
  subtitle?: string;
  /** Fires when the user picks one of the three agent dots. */
  onPickAgent?: (agent: SystemAgentConfig) => void;
}

const AGENT_ICONS = {
  Wrench: IconWrench,
  Store: IconStore,
  Settings: IconSettings,
} as const;

// Triangle layout: top, bottom-right, bottom-left. The mockup pairs each
// position with a specific agent — we follow the same ordering so the colors
// (deep-green top, wine bottom-right, blue bottom-left) read as a constant.
const SLOTS: { left: number; top: number; labelDx: number; labelDy: number; agentIndex: number }[] = [
  { left: 30,  top: 95, labelDx: 56,  labelDy: 28, agentIndex: 2 }, // bottom-left  → platform_manager
  { left: 142, top: 12, labelDx: 28,  labelDy: 62, agentIndex: 0 }, // top          → tool_builder
  { left: 254, top: 95, labelDx: -12, labelDy: 28, agentIndex: 1 }, // bottom-right → tool_marketer
];

export default function ConstellationHero({
  replayKey = 0,
  subtitle = 'Three agents are ready. Pick one.',
  onPickAgent,
}: ConstellationHeroProps) {
  const wordmark = 'Ultralight';
  const [typed, setTyped] = useState(0);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    setTyped(0);
    setPhase(0);
    let i = 0;
    const typer = setInterval(() => {
      i++;
      setTyped(i);
      if (i >= wordmark.length) clearInterval(typer);
    }, 80);
    const t1 = setTimeout(() => setPhase(1), 900);  // subtitle
    const t2 = setTimeout(() => setPhase(2), 1400); // orbit
    const t3 = setTimeout(() => setPhase(3), 1800); // first dot
    const t4 = setTimeout(() => setPhase(4), 2050);
    const t5 = setTimeout(() => setPhase(5), 2300);
    return () => {
      clearInterval(typer);
      [t1, t2, t3, t4, t5].forEach(clearTimeout);
    };
  }, [replayKey]);

  // Map agent index → real SystemAgentConfig (pulled live so the icon, color,
  // and name stay aligned with NavSidebar).
  const slots = useMemo(
    () =>
      SLOTS.map(slot => ({
        ...slot,
        agent: SYSTEM_AGENTS[slot.agentIndex],
      })).filter((s): s is typeof SLOTS[number] & { agent: SystemAgentConfig } => Boolean(s.agent)),
    [],
  );

  return (
    <div className="h-full flex flex-col items-center justify-center px-10 bg-white relative">
      <div className="flex items-center gap-3.5 mb-3">
        <Spark size={36} color="#0a0a0a" />
        <span className="text-ul-text font-bold leading-none tracking-[-0.03em]" style={{ fontSize: 36 }}>
          {wordmark.slice(0, typed)}
          {typed < wordmark.length && (
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
      </div>

      {phase >= 1 && (
        <div className="text-small text-ul-text-secondary mb-9 animate-fade-up">
          {subtitle}
        </div>
      )}

      <div className="relative" style={{ width: 320, height: 240 }}>
        {phase >= 2 && (
          <svg
            width="320"
            height="240"
            viewBox="0 0 320 240"
            className="absolute inset-0 animate-fade-in"
            aria-hidden="true"
          >
            <g style={{ transformOrigin: '160px 120px', animation: 'ul-orbit 60s linear infinite' }}>
              <ellipse
                cx="160"
                cy="120"
                rx="130"
                ry="80"
                fill="none"
                stroke="#0a0a0a"
                strokeOpacity="0.25"
                strokeWidth="1"
                strokeDasharray="2 6"
              />
            </g>
            <g style={{ transformOrigin: '160px 120px', animation: 'ul-spark-pulse 3.6s ease-in-out infinite' }}>
              <circle cx="160" cy="120" r="6" fill="#0a0a0a" />
            </g>
          </svg>
        )}

        {slots.map((slot, i) => {
          if (phase < 3 + i) return null;
          const Icon = AGENT_ICONS[slot.agent.icon as keyof typeof AGENT_ICONS] ?? IconWrench;
          return (
            <button
              key={slot.agent.type}
              type="button"
              onClick={() => onPickAgent?.(slot.agent)}
              className="absolute rounded-full bg-white border border-ul-border flex items-center justify-center cursor-pointer transition-all duration-base hover:scale-[1.08]"
              style={{
                left: slot.left,
                top: slot.top,
                width: 56,
                height: 56,
                color: slot.agent.accent,
                boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
                animation: 'ul-dot-arrive 360ms cubic-bezier(0.2,0.9,0.3,1)',
              }}
              aria-label={`Start chat with ${slot.agent.name}`}
            >
              <Icon size={20} />
            </button>
          );
        })}

        {slots.map((slot, i) => {
          if (phase < 3 + i) return null;
          return (
            <div
              key={`label-${slot.agent.type}`}
              className="absolute text-micro font-mono text-ul-text-muted whitespace-nowrap animate-fade-in"
              style={{
                left: slot.left + slot.labelDx,
                top: slot.top + slot.labelDy,
                animationDelay: '200ms',
                animationFillMode: 'both',
              }}
            >
              {slot.agent.name}
            </div>
          );
        })}
      </div>
    </div>
  );
}
