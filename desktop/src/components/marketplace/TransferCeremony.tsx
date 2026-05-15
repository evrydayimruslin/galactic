// TransferCeremony — buyer-side post-acquisition celebration.
//
// Consolidates the addendum's 3E (ATransferCeremony) + 3E3 (AHandoffCeremony)
// moments into a single staged-reveal panel: lockup, receipt log, and a
// dismiss CTA. We skip the multi-page paging of the original mockup
// (continue → keys panel) — the receipt log makes the same story land in
// one screen.
//
// Backdrop is the dark ul-text canvas so the moment feels distinct from
// the rest of the app. Reveal cascades on mount via Tailwind animations
// already in the design system (animate-fade-up, animate-fade-in).
//
// Used by AcquisitionFlow when an instant-buy or bid-equals-ask completes;
// SideRail's accept-bid path uses SoldConfirmation (the seller variant)
// instead.

import { useEffect, useState } from 'react';
import { formatLightPrecise as formatLight } from '../../lib/format';
import Glyph, { deriveGlyph, deriveTone } from '../ui/Glyph';

interface TransferCeremonyProps {
  toolName: string;
  /** Previous owner — handle/slug to show on the left of the lockup. */
  fromHandle: string;
  /** New owner — handle/slug to show on the right of the lockup. */
  toHandle: string;
  /** Light amount that changed hands. */
  amount: number;
  /** Active install count for the "N installs migrated" log line. Optional;
   *  hides the line when unknown. */
  installCount?: number;
  /** Drives copy: "you just bought" vs "a new tool · in your hands". */
  path: 'accepted' | 'instant';
  /** Fired when the user dismisses the ceremony. */
  onDone: () => void;
}

function formatInstallCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export default function TransferCeremony({
  toolName,
  fromHandle,
  toHandle,
  amount,
  installCount,
  path,
  onDone,
}: TransferCeremonyProps) {
  const [stage, setStage] = useState(0);

  // Stage 0 → 1 (lockup + numbers reveal) → 2 (receipt log). Auto-paced; the
  // user can dismiss at any time via the bottom CTA. We don't gate the CTA
  // on stage because some users will want to skip the animation.
  useEffect(() => {
    const t1 = setTimeout(() => setStage(1), 280);
    const t2 = setTimeout(() => setStage(2), 1500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const eyebrow = path === 'instant'
    ? 'You just bought · the keys are warm'
    : 'A new tool · in your hands';

  const receiptLog: string[] = [
    path === 'instant'
      ? `payment cleared  ✦${formatLight(amount)} → ${fromHandle}`
      : `escrow released  ✦${formatLight(amount)} → ${fromHandle}`,
    `manifest re-signed  admin keys → ${toHandle}`,
    installCount !== undefined
      ? `catalog updated  ${formatInstallCount(installCount)} installs migrated`
      : 'catalog updated',
    'revenue redirected  next call → you',
  ];

  return (
    <div className="flex-1 flex flex-col bg-ul-text text-white px-8 py-10 overflow-y-auto">
      <div className="flex-1 flex flex-col items-center justify-center max-w-[560px] mx-auto w-full">
        <div
          className="text-nano font-mono uppercase tracking-[0.1em] mb-4 transition-opacity duration-700"
          style={{ color: 'rgba(255,255,255,0.45)', opacity: stage >= 1 ? 1 : 0 }}
        >
          {eyebrow}
        </div>

        <div
          className="text-display font-bold font-mono tracking-tight mb-7 transition-all duration-700"
          style={{
            opacity: stage >= 1 ? 1 : 0,
            transform: stage >= 1 ? 'translateY(0)' : 'translateY(8px)',
          }}
        >
          {toolName}
        </div>

        {/* Lockup — from glyph, animated path, to glyph */}
        <div className="flex items-center justify-center gap-6 mb-9">
          <div
            className="flex flex-col items-center gap-2 transition-opacity duration-700"
            style={{ opacity: stage >= 1 ? 0.45 : 1 }}
          >
            <Glyph
              glyph={deriveGlyph(fromHandle)}
              tone={deriveTone(fromHandle)}
              size={48}
            />
            <span className="text-micro font-mono" style={{ color: 'rgba(255,255,255,0.55)' }}>
              {fromHandle}
            </span>
          </div>

          <div className="relative w-[140px] h-12 flex items-center">
            <div
              className="absolute left-0 right-0 top-1/2 h-px"
              style={{ background: 'rgba(255,255,255,0.18)' }}
            />
            <div
              className="absolute left-0 top-1/2 h-px transition-[width] duration-[1200ms]"
              style={{
                background: 'rgba(255,255,255,0.85)',
                width: stage >= 1 ? '100%' : '0%',
                transitionTimingFunction: 'cubic-bezier(0.65, 0, 0.35, 1)',
                transitionDelay: '200ms',
              }}
            />
            {/* Courier spark — travels from left to right. */}
            <span
              aria-hidden
              className="absolute top-1/2 text-body"
              style={{
                transform: 'translate(-50%, -50%)',
                opacity: stage >= 1 ? 1 : 0,
                left: stage >= 1 ? '100%' : '0%',
                color: '#fff',
                textShadow: '0 0 8px rgba(255,255,255,0.4)',
                transition: 'left 1200ms cubic-bezier(0.65, 0, 0.35, 1) 200ms, opacity 200ms ease-out 200ms',
              }}
            >
              ✦
            </span>
          </div>

          <div
            className="flex flex-col items-center gap-2 transition-transform duration-700"
            style={{
              transform: stage >= 1 ? 'scale(1.06)' : 'scale(1)',
              transitionDelay: '1200ms',
            }}
          >
            <div className="relative">
              <Glyph
                glyph={deriveGlyph(toHandle)}
                tone={deriveTone(toHandle)}
                size={48}
              />
              <div
                className="absolute -inset-1.5 rounded-full transition-all duration-700"
                style={{
                  border: '1px solid rgba(255,255,255,0.35)',
                  opacity: stage >= 1 ? 1 : 0,
                  transform: stage >= 1 ? 'scale(1)' : 'scale(0.9)',
                  transitionDelay: '1200ms',
                }}
              />
            </div>
            <span
              className="text-micro font-mono transition-colors duration-700"
              style={{
                color: stage >= 1 ? '#fff' : 'rgba(255,255,255,0.6)',
                fontWeight: stage >= 1 ? 600 : 400,
                transitionDelay: '1200ms',
              }}
            >
              {toHandle} <span style={{ opacity: 0.6, fontWeight: 400 }}>· you</span>
            </span>
          </div>
        </div>

        {/* Receipt log — staggered reveal of the four state changes. */}
        <div
          className="w-full max-w-[420px] rounded-[12px] px-5 py-4 mb-7 transition-all duration-700"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.10)',
            opacity: stage >= 2 ? 1 : 0,
            transform: stage >= 2 ? 'translateY(0)' : 'translateY(8px)',
          }}
        >
          <div
            className="text-nano font-mono uppercase tracking-[0.1em] mb-2.5"
            style={{ color: 'rgba(255,255,255,0.45)' }}
          >
            What just changed
          </div>
          <div className="flex flex-col gap-1.5 text-micro font-mono leading-relaxed">
            {receiptLog.map((line, i) => (
              <div
                key={line}
                className="flex items-baseline gap-2"
                style={{
                  color: 'rgba(255,255,255,0.65)',
                  opacity: stage >= 2 ? 1 : 0,
                  transform: stage >= 2 ? 'translateY(0)' : 'translateY(4px)',
                  transition: `opacity 400ms ease-out ${i * 80}ms, transform 400ms ease-out ${i * 80}ms`,
                }}
              >
                <span className="text-ul-success flex-shrink-0">✓</span>
                <span>{line}</span>
              </div>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={onDone}
          className="bg-white text-ul-text border-none px-6 py-3 rounded-md text-caption font-semibold cursor-pointer hover:opacity-90 transition-opacity inline-flex items-center gap-2"
        >
          Open admin panel <span aria-hidden>→</span>
        </button>
        <div
          className="mt-2.5 text-nano font-mono"
          style={{ color: 'rgba(255,255,255,0.3)', letterSpacing: '0.06em' }}
        >
          existing installs continue uninterrupted
        </div>
      </div>
    </div>
  );
}
