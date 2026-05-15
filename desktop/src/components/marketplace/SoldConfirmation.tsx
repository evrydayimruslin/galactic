// SoldConfirmation — seller-side compact "sold" celebration.
//
// 3E1 ASellerSold from the addendum. Replaces the silent listing refresh
// that used to follow the accept-bid click. The vibe is satisfaction, not
// surprise — the seller chose this — so the screen is one big number, one
// brief receipt strip, and two outbound buttons. No animation theatre.
//
// Mounted as a modal overlay (using the shared ui/Modal chrome) over
// ToolDetailView when the owner clicks the green-check Accept button on
// any open bid; closing returns them to the listing, which by then has
// rolled over to the new owner via the listing refresh.

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import Modal from '../ui/Modal';
import { formatLightPrecise as formatLight } from '../../lib/format';

interface SoldConfirmationProps {
  toolName: string;
  /** New owner — bidder handle (e.g. "@arbiter"). */
  buyerHandle: string;
  /** Light amount received. */
  amount: number;
  /** Drives copy variant: instant means buyer took ask, accepted means
   *  seller picked a bid. The seller-side screen surfaces this so the
   *  recap reflects who initiated. */
  path: 'accepted' | 'instant';
  onClose: () => void;
}

// Light easing — count up from zero to target over ~1.2s.
function useCountUp(target: number, durationMs = 1200): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf: number | null = null;
    let start = 0;
    const step = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(target * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [target, durationMs]);
  return value;
}

export default function SoldConfirmation({
  toolName,
  buyerHandle,
  amount,
  path,
  onClose,
}: SoldConfirmationProps) {
  const counted = useCountUp(amount);
  const headline = path === 'instant' ? 'Bought at ask' : 'Sold';
  const verb = path === 'instant' ? 'just took your ask on' : 'now owns';

  return (
    <Modal onClose={onClose} surface="plain" radius="xl" maxWidth="md" maxHeight="auto">
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 w-8 h-8 rounded-full text-ul-text-muted hover:bg-ul-bg-hover flex items-center justify-center cursor-pointer z-10"
        title="Close"
      >
        <X className="w-4 h-4" strokeWidth={1.5} />
      </button>

      <div className="p-8 pb-7">
        <div className="text-nano font-mono uppercase tracking-[0.1em] text-ul-text-muted mb-3">
          {headline} · {toolName}
        </div>

        <div className="text-display font-bold font-mono tabular-nums tracking-tight mb-3 leading-none">
          ✦{formatLight(Math.round(counted))}
        </div>

        <p className="text-body text-ul-text-secondary leading-relaxed mb-5">
          settled to your wallet. <strong className="text-ul-text">{buyerHandle}</strong>{' '}
          {verb} <strong className="text-ul-text">{toolName}</strong>.
        </p>

        <div
          className="text-micro font-mono text-ul-text-muted leading-relaxed mb-6"
          style={{ borderTop: '1px solid var(--ul-border, rgba(0,0,0,0.08))', paddingTop: 12 }}
        >
          admin keys re-signed · revenue stream redirected · existing installs continue uninterrupted
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-3 py-2.5 bg-ul-text text-white border-none rounded-md text-caption font-medium cursor-pointer hover:bg-ul-accent-hover"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
