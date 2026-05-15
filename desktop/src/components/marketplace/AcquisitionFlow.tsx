// AcquisitionFlow — buyer-side modal for placing a bid or instant-buying.
//
// Ports `AOrderBook` (line 11) and `APlaceBid` (line 122) from
// handoff/mockups/acquisition.jsx, combined into a multi-step modal so the
// buyer can move from "review order book" -> "bid amount form" ->
// "confirmation" without switching surfaces.
//
// Steps:
//   1. `review` — order book view: ASK row + bid rows + comparable
//      acquisitions. "Acquire at ask" instant-buys (when allowed);
//      "Place a bid" advances to step 2.
//   2. `bid` — bid amount form with escrow explanation + insufficient-
//      balance check. Submit hits POST /api/marketplace/bid.
//   3. `confirmation` — success state, "Back to order book" returns to
//      step 1 with refreshed bid list.
//
// Seller-side accept/decline flow ships in Batch 4d.

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, X } from 'lucide-react';
import {
  placeBid,
  cancelBid,
  instantAcquire,
  fetchMarketplaceListing,
  type MarketplaceListingDetails,
  type MarketplaceBid,
} from '../../lib/api';
import Glyph, { deriveGlyph, deriveTone } from '../ui/Glyph';
import Modal from '../ui/Modal';
import { formatLightPrecise as formatLight } from '../../lib/format';

interface AcquisitionFlowProps {
  appId: string;
  appName: string;
  currentUserId: string | null;
  /** Optional initial listing — saves a fetch round trip if the parent already
   *  has it (e.g. ToolDetailView). The modal will still re-fetch on bid actions
   *  so the book stays fresh. */
  initialListing?: MarketplaceListingDetails | null;
  onClose: () => void;
  /** Called after a successful instant-buy or bid acceptance. The parent should
   *  invalidate any cached listing for this app + close the modal. */
  onAcquired?: () => void;
}

type Step = 'review' | 'bid' | 'manage' | 'confirmation';
type Outcome = 'bid-placed' | 'instant-bought' | 'bid-updated' | 'bid-withdrawn';

// ── Helpers ───────────────────────────────────────────────────────────


function hoursAgo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return '<1h ago';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function isYourBid(bid: MarketplaceBid, userId: string | null): boolean {
  return !!(userId && bid.bidder_id === userId);
}

// ── Modal chrome ──────────────────────────────────────────────────────

function ModalCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className="absolute top-4 right-4 w-8 h-8 rounded-full text-ul-text-muted hover:bg-ul-bg-hover flex items-center justify-center cursor-pointer"
      title="Close"
    >
      <X className="w-4 h-4" strokeWidth={1.5} />
    </button>
  );
}

// ── Step 1: review (order book) ──────────────────────────────────────

interface ReviewStepProps {
  appId: string;
  appName: string;
  listing: MarketplaceListingDetails | null;
  currentUserId: string | null;
  onPlaceBid: () => void;
  onInstantBuy: () => void;
  instantBuying: boolean;
  instantBuyError: string | null;
  onManageBid: () => void;
}

function ReviewStep({
  appId,
  appName,
  listing,
  currentUserId,
  onPlaceBid,
  onInstantBuy,
  instantBuying,
  instantBuyError,
  onManageBid,
}: ReviewStepProps) {
  const ask = listing?.listing?.ask_price_light ?? null;
  const instant = !!listing?.listing?.instant_buy;
  const bids = (listing?.bids ?? []).slice().sort((a, b) => b.amount_light - a.amount_light);
  const topBid = bids[0]?.amount_light ?? null;
  const summary = listing?.marketplace_summary;
  const ownerHandle = listing?.app?.slug ?? appName;

  return (
    <div className="flex-1 overflow-y-auto px-8 py-7 relative">
      <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest mb-3">
        Acquire · {appName.toUpperCase()}
      </div>
      <div className="flex items-end justify-between gap-6 mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-1.5">
            <Glyph glyph={deriveGlyph(ownerHandle)} tone={deriveTone(appId)} size={32} />
            <div className="text-h2 font-bold tracking-tight truncate">{appName}</div>
          </div>
          <div className="text-small text-ul-warm-ink-muted">
            {listing?.app?.runs_30d !== undefined
              ? `${listing.app.runs_30d.toLocaleString()} runs/30d`
              : ''}
            {listing?.app?.runs_30d !== undefined && listing?.app?.description ? ' · ' : ''}
            {listing?.app?.description}
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {ask !== null && ask > 0 && instant ? (
            <button
              type="button"
              onClick={onInstantBuy}
              disabled={instantBuying}
              className="px-4 py-2.5 bg-ul-text text-white rounded-lg text-caption font-medium cursor-pointer hover:bg-ul-accent-hover disabled:opacity-60 disabled:cursor-wait"
            >
              {instantBuying ? 'Acquiring…' : `Acquire at ask · ✦${formatLight(ask)}`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onPlaceBid}
            className="px-4 py-2.5 bg-ul-bg text-ul-text border border-ul-border rounded-lg text-caption font-medium cursor-pointer hover:bg-ul-bg-hover"
          >
            Place a bid
          </button>
        </div>
      </div>

      {instantBuyError && (
        <div className="mb-4 px-3.5 py-2.5 border border-ul-error/30 bg-ul-error-soft rounded-md text-caption text-ul-error">
          {instantBuyError}
        </div>
      )}

      {/* Stats strip */}
      {ask !== null && ask > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-7">
          <StatTile label="Asking price" value={`✦${formatLight(ask)}`} />
          <StatTile label="Top bid" value={topBid !== null ? `✦${formatLight(topBid)}` : '—'} />
          <StatTile
            label={summary?.show_metrics ? '30d activity' : 'Revenue & volume'}
            value={summary?.show_metrics
              ? `${listing?.app?.runs_30d?.toLocaleString() ?? '—'} runs`
              : 'Private'}
            faded={!summary?.show_metrics}
          />
        </div>
      )}

      {/* Order book */}
      <div className="border border-ul-border rounded-lg overflow-hidden bg-ul-bg">
        <div className="px-4 py-2.5 border-b border-ul-border bg-ul-bg-raised grid grid-cols-[40px_minmax(0,1fr)_100px_110px] gap-3 text-nano font-mono text-ul-text-muted uppercase tracking-widest">
          <span></span>
          <span>Bidder</span>
          <span className="text-right">Bid</span>
          <span className="text-center">Placed</span>
        </div>
        {ask !== null && ask > 0 && (
          <div className="px-4 py-2.5 grid grid-cols-[40px_minmax(0,1fr)_100px_110px] gap-3 items-center bg-ul-success-soft border-b border-ul-border">
            <span className="font-mono text-nano text-ul-success-strong font-semibold tracking-widest">
              ASK
            </span>
            <div className="flex items-center gap-2 min-w-0">
              <Glyph glyph={deriveGlyph(ownerHandle)} tone={deriveTone(appId)} size={18} />
              <span className="text-caption font-medium truncate">
                @{ownerHandle}
                <span className="text-ul-text-muted ml-1.5 font-normal">· owner</span>
              </span>
            </div>
            <span className="font-mono text-body font-bold text-right tabular-nums">
              ✦{formatLight(ask)}
            </span>
            <div className="flex justify-center">
              {instant ? (
                <button
                  type="button"
                  onClick={onInstantBuy}
                  disabled={instantBuying}
                  className="font-mono text-nano px-3 py-1 bg-ul-text text-white rounded-sm font-medium cursor-pointer hover:bg-ul-accent-hover disabled:opacity-60"
                >
                  Take
                </button>
              ) : (
                <span className="font-mono text-nano text-ul-text-muted">offers only</span>
              )}
            </div>
          </div>
        )}
        {bids.length === 0 ? (
          <div className="px-4 py-5 text-caption text-ul-warm-ink-muted text-center">
            No open bids yet.
          </div>
        ) : (
          bids.map((bid, i) => {
            const yours = isYourBid(bid, currentUserId);
            const seed = bid.bidder_id || bid.bidder_email || bid.id;
            const label = bid.bidder_display_name || bid.bidder_email?.split('@')[0] || 'bidder';
            return (
              <div
                key={bid.id}
                className={`px-4 py-2.5 grid grid-cols-[40px_minmax(0,1fr)_100px_110px] gap-3 items-center ${
                  i === bids.length - 1 ? '' : 'border-b border-ul-border'
                } ${yours ? 'bg-ul-info-soft' : ''}`}
              >
                <span className="font-mono text-micro text-ul-text-muted tabular-nums">
                  #{i + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Glyph glyph={deriveGlyph(label)} tone={deriveTone(seed)} size={18} />
                    <span className="text-caption font-medium truncate">@{label}</span>
                    {yours && (
                      <span className="text-nano font-mono text-ul-info bg-ul-info-soft px-1.5 py-px rounded-xs tracking-widest uppercase">
                        you
                      </span>
                    )}
                  </div>
                  {bid.message && (
                    <div className="text-micro text-ul-text-muted mt-0.5 ml-6 italic truncate">
                      "{bid.message}"
                    </div>
                  )}
                </div>
                <span className="font-mono text-caption text-right tabular-nums">
                  ✦{formatLight(bid.amount_light)}
                </span>
                <div className="flex justify-center">
                  {yours ? (
                    <button
                      type="button"
                      onClick={onManageBid}
                      className="font-mono text-nano px-3 py-1 bg-ul-bg text-ul-text border border-ul-border rounded-sm cursor-pointer hover:bg-ul-bg-hover"
                    >
                      Manage
                    </button>
                  ) : (
                    <span className="text-nano text-ul-text-muted font-mono">
                      {hoursAgo(bid.created_at)}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value, faded = false }: { label: string; value: string; faded?: boolean }) {
  return (
    <div className={`p-3.5 border border-ul-border rounded-md bg-ul-bg-raised ${faded ? 'border-dashed' : ''}`}>
      <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest mb-1.5">
        {label}
      </div>
      <div className={`text-body-lg font-bold font-mono tabular-nums ${faded ? 'text-ul-text-muted italic font-normal text-caption' : ''}`}>
        {value}
      </div>
    </div>
  );
}

// ── Step 2: bid amount form ──────────────────────────────────────────

interface BidStepProps {
  appName: string;
  listing: MarketplaceListingDetails | null;
  onBack: () => void;
  onSubmit: (amount: number, message: string | undefined, willAcquire: boolean) => Promise<void>;
  submitting: boolean;
  submitError: string | null;
}

function BidStep({ appName, listing, onBack, onSubmit, submitting, submitError }: BidStepProps) {
  const ask = listing?.listing?.ask_price_light ?? null;
  const topBid = (listing?.bids ?? [])
    .slice()
    .sort((a, b) => b.amount_light - a.amount_light)[0]?.amount_light ?? 0;
  const minBid = listing?.listing?.floor_price_light ?? 1;
  const initialAmount = Math.max(minBid, Math.min(ask ?? topBid + 10, topBid > 0 ? topBid + 10 : (ask ?? 100)));
  const [amount, setAmount] = useState<number>(initialAmount);
  const [message, setMessage] = useState('');

  const willAcquire = ask !== null && amount >= ask && (listing?.listing?.instant_buy ?? false);
  const validAmount = amount > 0 && amount >= minBid;
  const aboveTop = topBid > 0 && amount > topBid;
  const percentBelow = topBid > 0 && amount <= topBid ? Math.round((100 * (topBid - amount)) / topBid) : 0;

  return (
    <div className="flex-1 overflow-y-auto px-8 py-7 relative">
      <button
        type="button"
        onClick={onBack}
        className="bg-transparent border-none text-caption text-ul-warm-ink-muted cursor-pointer mb-4 inline-flex items-center gap-1.5 hover:text-ul-warm-ink"
      >
        <ArrowLeft className="w-3 h-3" strokeWidth={1.5} />
        Back
      </button>
      <div className="text-h2 font-bold tracking-tight mb-1.5">Place a bid on {appName}</div>
      <div className="text-small text-ul-warm-ink-muted mb-7 leading-relaxed">
        If accepted, ownership of <strong>{appName}</strong> transfers to you.
        Existing users keep their installs running unchanged.
      </div>

      <div className="mb-5">
        <label className="text-micro font-mono text-ul-text-muted uppercase tracking-widest block mb-2">
          Bid amount
        </label>
        <div className="flex items-center gap-2 border border-ul-border rounded-lg px-3.5 py-3 bg-ul-bg">
          <span className="text-body-lg font-mono">✦</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
            className="flex-1 border-none outline-none text-body-lg font-mono font-semibold tabular-nums bg-transparent"
            min={minBid}
            step={1}
          />
          <span className="text-micro text-ul-text-muted font-mono">Light</span>
        </div>
        <div className="flex justify-between text-micro text-ul-text-muted mt-2 font-mono gap-2">
          <span>
            {ask !== null && <>Ask <strong className="text-ul-text">✦{formatLight(ask)}</strong></>}
            {ask !== null && topBid > 0 && <> · </>}
            {topBid > 0 && <>Top bid <strong className="text-ul-text">✦{formatLight(topBid)}</strong></>}
          </span>
          <span>
            {willAcquire
              ? <strong className="text-ul-success-strong">Matches ask</strong>
              : aboveTop
                ? <strong className="text-ul-success">Top of book</strong>
                : topBid > 0
                  ? `${percentBelow}% below top`
                  : ''}
          </span>
        </div>
      </div>

      <div className="mb-5">
        <label className="text-micro font-mono text-ul-text-muted uppercase tracking-widest block mb-2">
          Message <span className="text-ul-text-muted lowercase">(optional)</span>
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="Add context for the seller…"
          className="w-full border border-ul-border rounded-lg px-3.5 py-2.5 text-small text-ul-text bg-ul-bg outline-none resize-none placeholder:text-ul-text-muted"
        />
      </div>

      <div className={`p-3 rounded-md text-caption leading-relaxed mb-4 ${
        willAcquire
          ? 'bg-ul-success-soft border border-ul-success/20 text-ul-success-strong'
          : 'bg-ul-bg-raised text-ul-warm-ink-muted'
      }`}>
        {willAcquire ? (
          <>
            <strong>This bid matches the ask.</strong> Submitting will acquire{' '}
            {appName} immediately — ownership transfers atomically and{' '}
            ✦{formatLight(amount)} is debited from your wallet.
          </>
        ) : (
          <>
            ✦{formatLight(amount)} is escrowed from your wallet for the duration
            of the bid. Withdraw anytime to release. On accept, ownership transfers atomically.
          </>
        )}
      </div>

      {submitError && (
        <div className="mb-4 px-3.5 py-2.5 border border-ul-error/30 bg-ul-error-soft rounded-md text-caption text-ul-error">
          {submitError}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="flex-1 px-3 py-3 bg-ul-bg text-ul-text border border-ul-border rounded-lg text-caption font-medium cursor-pointer hover:bg-ul-bg-hover disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void onSubmit(amount, message.trim() || undefined, willAcquire)}
          disabled={!validAmount || submitting}
          className={`flex-[2] px-3 py-3 text-white rounded-lg text-body font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
            willAcquire ? 'bg-ul-success-strong hover:opacity-90' : 'bg-ul-text hover:bg-ul-accent-hover'
          }`}
        >
          {submitting
            ? (willAcquire ? 'Acquiring…' : 'Placing…')
            : willAcquire
              ? `Buy now · ✦${formatLight(amount)}`
              : `Place bid · ✦${formatLight(amount)}`}
        </button>
      </div>
    </div>
  );
}

// ── Step 2b: manage own bid (cancel-and-replace) ─────────────────────
//
// 3C from the addendum. The BE has no in-place "edit bid" route — the user
// confirmed cancel-then-place is acceptable — so this step runs two BE calls
// when the amount changes: cancelBid + placeBid. Withdraw just runs cancelBid
// and resolves to the bid-withdrawn outcome.

interface ManageBidStepProps {
  appName: string;
  listing: MarketplaceListingDetails | null;
  ownBid: MarketplaceBid;
  onBack: () => void;
  onUpdate: (newAmount: number, message: string | undefined, willAcquire: boolean) => Promise<void>;
  onWithdraw: () => Promise<void>;
  submitting: boolean;
  submitError: string | null;
}

function ManageBidStep({
  appName,
  listing,
  ownBid,
  onBack,
  onUpdate,
  onWithdraw,
  submitting,
  submitError,
}: ManageBidStepProps) {
  const ask = listing?.listing?.ask_price_light ?? null;
  const minBid = listing?.listing?.floor_price_light ?? 1;
  const maxBid = ask ?? Number.MAX_SAFE_INTEGER;
  const original = ownBid.amount_light;
  const [amount, setAmount] = useState<number>(original);
  const [message, setMessage] = useState<string>(ownBid.message ?? '');
  const diff = amount - original;
  const willAcquire = ask !== null && amount >= ask && (listing?.listing?.instant_buy ?? false);
  const validAmount = amount >= minBid && amount <= maxBid;
  const noChange = diff === 0 && message === (ownBid.message ?? '');

  // Rank projection — where the new amount lands in the order book.
  const projectedRank = (() => {
    const others = (listing?.bids ?? []).filter((b) => b.id !== ownBid.id);
    const all = [...others.map((b) => b.amount_light), amount].sort((a, b) => b - a);
    return all.indexOf(amount) + 1;
  })();

  const setSafe = (v: number) => {
    setAmount(Math.max(minBid, Math.min(maxBid, Math.round(v))));
  };

  return (
    <div className="flex-1 overflow-y-auto px-8 py-7 relative">
      <button
        type="button"
        onClick={onBack}
        className="bg-transparent border-none text-caption text-ul-warm-ink-muted cursor-pointer mb-4 inline-flex items-center gap-1.5 hover:text-ul-warm-ink"
      >
        <ArrowLeft className="w-3 h-3" strokeWidth={1.5} />
        Back
      </button>
      <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest mb-2">
        Manage bid
      </div>
      <div className="text-h2 font-bold tracking-tight mb-1.5">Your bid on {appName}</div>
      <div className="text-small text-ul-warm-ink-muted mb-6 leading-relaxed">
        Adjust the amount or withdraw. Editing cancels the current bid and re-places it at the new
        amount — the BE settles the wallet diff atomically.
      </div>

      {/* Original bid summary */}
      <div className="border border-ul-border rounded-lg p-3.5 mb-5 bg-ul-bg-raised flex items-center justify-between gap-4">
        <div>
          <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest mb-1">
            Current bid
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-body-lg font-bold font-mono tabular-nums">
              ✦{formatLight(original)}
            </span>
            <span className="text-nano font-mono text-ul-text-muted">
              placed {hoursAgo(ownBid.created_at)}
            </span>
          </div>
        </div>
        {ownBid.message && (
          <div className="text-micro text-ul-text-secondary italic max-w-[200px] text-right leading-relaxed">
            "{ownBid.message}"
          </div>
        )}
      </div>

      {/* Edit amount */}
      <div className="mb-5">
        <div className="flex justify-between mb-2 text-micro font-mono text-ul-text-muted uppercase tracking-widest">
          <span>New amount</span>
          <span>
            {ask !== null ? `${Math.round((amount / ask) * 100)}% of ask · ` : ''}proj. rank #{projectedRank}
          </span>
        </div>
        <div className="flex items-center gap-2 border border-ul-border rounded-lg px-3.5 py-3 bg-ul-bg">
          <span className="text-body-lg font-mono">✦</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setSafe(Number(e.target.value) || 0)}
            className="flex-1 border-none outline-none text-body-lg font-mono font-semibold tabular-nums bg-transparent"
            min={minBid}
            max={maxBid}
            step={1}
          />
          <span className="text-micro text-ul-text-muted font-mono">Light</span>
        </div>
        <div className="flex justify-between text-micro text-ul-text-muted mt-2 font-mono gap-2">
          <span>min ✦{formatLight(minBid)}</span>
          {ask !== null && <span>ask ✦{formatLight(ask)}</span>}
        </div>
      </div>

      {/* Message */}
      <div className="mb-5">
        <label className="text-micro font-mono text-ul-text-muted uppercase tracking-widest block mb-2">
          Message <span className="text-ul-text-muted lowercase">(optional)</span>
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="Add context for the seller…"
          className="w-full border border-ul-border rounded-lg px-3.5 py-2.5 text-small text-ul-text bg-ul-bg outline-none resize-none placeholder:text-ul-text-muted"
        />
      </div>

      {/* Wallet diff */}
      <div className="border border-ul-border rounded-lg p-3.5 mb-5">
        <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-2.5">
          Wallet settlement
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-caption font-mono tabular-nums">
          <span className="text-ul-warm-ink-muted">Bid change ({formatLight(original)} → {formatLight(amount)})</span>
          <span className={`text-right font-semibold ${
            diff > 0 ? 'text-ul-error' : diff < 0 ? 'text-ul-success-strong' : 'text-ul-text-muted'
          }`}>
            {diff > 0 ? `−✦${formatLight(diff)}` : diff < 0 ? `+✦${formatLight(-diff)}` : '—'}
          </span>
        </div>
        <div className="text-nano text-ul-text-muted leading-relaxed mt-2">
          Withdraw releases escrow instantly. Editing runs as cancel + re-place;
          the bid's placement timestamp resets.
        </div>
      </div>

      {willAcquire && (
        <div className="mb-4 p-3 rounded-md bg-ul-success-soft border border-ul-success/20 text-caption text-ul-success-strong leading-relaxed">
          <strong>This matches the ask.</strong> Submitting will acquire {appName} immediately — ownership
          transfers atomically and ✦{formatLight(amount)} is debited from your wallet.
        </div>
      )}

      {submitError && (
        <div className="mb-4 px-3.5 py-2.5 border border-ul-error/30 bg-ul-error-soft rounded-md text-caption text-ul-error">
          {submitError}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void onWithdraw()}
          disabled={submitting}
          className="px-3.5 py-3 bg-ul-bg text-ul-error border border-ul-error/30 rounded-lg text-caption font-medium cursor-pointer hover:bg-ul-error-soft disabled:opacity-60"
        >
          Withdraw entirely
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="flex-1 px-3 py-3 bg-ul-bg text-ul-text border border-ul-border rounded-lg text-caption font-medium cursor-pointer hover:bg-ul-bg-hover disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void onUpdate(amount, message.trim() || undefined, willAcquire)}
          disabled={noChange || !validAmount || submitting}
          className={`flex-[1.4] px-3 py-3 text-white rounded-lg text-body font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
            willAcquire ? 'bg-ul-success-strong hover:opacity-90' : 'bg-ul-text hover:bg-ul-accent-hover'
          }`}
        >
          {submitting
            ? 'Updating…'
            : noChange
              ? 'No change'
              : willAcquire
                ? `Buy now · ✦${formatLight(amount)}`
                : diff > 0
                  ? `Raise · escrow ✦${formatLight(diff)}`
                  : `Lower · refund ✦${formatLight(-diff)}`}
        </button>
      </div>
    </div>
  );
}

// ── Step 3: confirmation ─────────────────────────────────────────────

function ConfirmationStep({
  appName,
  outcome,
  amount,
  onReturn,
  onDone,
}: {
  appName: string;
  outcome: Outcome;
  amount: number;
  onReturn: () => void;
  onDone: () => void;
}) {
  const headline =
    outcome === 'instant-bought' ? 'Acquired' :
    outcome === 'bid-placed'     ? 'Bid placed' :
    outcome === 'bid-updated'    ? 'Bid updated' :
                                   'Bid withdrawn';

  const showReturn = outcome === 'bid-placed' || outcome === 'bid-updated';

  return (
    <div className="flex-1 flex items-center justify-center px-8 py-12">
      <div className="max-w-md text-center animate-fade-up">
        <div className="w-14 h-14 rounded-full bg-ul-success-soft inline-flex items-center justify-center mb-4 animate-ring-resolve">
          <Check className="w-6 h-6 text-ul-success-strong" strokeWidth={2.5} />
        </div>
        <div className="text-h2 font-bold tracking-tight mb-2">{headline}</div>
        <div className="text-small text-ul-warm-ink-muted leading-relaxed mb-5">
          {outcome === 'instant-bought' && (
            <>You now own <strong>{appName}</strong>. ✦{formatLight(amount)} debited.</>
          )}
          {outcome === 'bid-placed' && (
            <>
              Your bid of <strong className="font-mono text-ul-text">✦{formatLight(amount)}</strong>{' '}
              for <strong>{appName}</strong> is live. The seller has been notified. Withdraw
              anytime before acceptance.
            </>
          )}
          {outcome === 'bid-updated' && (
            <>
              Your bid on <strong>{appName}</strong> is now{' '}
              <strong className="font-mono text-ul-text">✦{formatLight(amount)}</strong>. Wallet
              settled the difference; the seller sees the new amount on next refresh.
            </>
          )}
          {outcome === 'bid-withdrawn' && (
            <>
              Your <strong className="font-mono text-ul-text">✦{formatLight(amount)}</strong> is
              back in your wallet. The bid on <strong>{appName}</strong> is gone.
            </>
          )}
        </div>
        <div className="flex justify-center gap-2">
          {showReturn && (
            <button
              type="button"
              onClick={onReturn}
              className="px-4 py-2.5 bg-ul-bg text-ul-text border border-ul-border rounded-lg text-caption font-medium cursor-pointer hover:bg-ul-bg-hover"
            >
              Back to order book
            </button>
          )}
          <button
            type="button"
            onClick={onDone}
            className="px-4 py-2.5 bg-ul-text text-white border-none rounded-lg text-caption font-medium cursor-pointer hover:bg-ul-accent-hover"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── AcquisitionFlow ───────────────────────────────────────────────────

export default function AcquisitionFlow({
  appId,
  appName,
  currentUserId,
  initialListing,
  onClose,
  onAcquired,
}: AcquisitionFlowProps) {
  const [step, setStep] = useState<Step>('review');
  const [listing, setListing] = useState<MarketplaceListingDetails | null>(initialListing ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [instantBuying, setInstantBuying] = useState(false);
  const [instantBuyError, setInstantBuyError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>('bid-placed');
  const [submittedAmount, setSubmittedAmount] = useState<number>(0);

  const refreshListing = useCallback(async () => {
    const fresh = await fetchMarketplaceListing(appId);
    if (fresh) setListing(fresh);
  }, [appId]);

  // Re-fetch when the app changes, OR on mount if no initial listing was
  // provided. Parents reusing the modal across appIds will get a fresh
  // listing automatically.
  useEffect(() => {
    if (!initialListing) {
      void refreshListing();
    }
  }, [appId, initialListing, refreshListing]);

  const onSubmitBid = async (amount: number, message: string | undefined, willAcquire: boolean) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (willAcquire) {
        const result = await instantAcquire(appId);
        if (!result.ok) {
          setSubmitError(result.errorMessage || 'Instant acquire failed.');
          return;
        }
        setOutcome('instant-bought');
      } else {
        const result = await placeBid({ appId, amountLight: amount, message });
        if (!result.ok) {
          setSubmitError(result.errorMessage || 'Failed to place bid.');
          return;
        }
        setOutcome('bid-placed');
      }
      setSubmittedAmount(amount);
      setStep('confirmation');
      await refreshListing();
      onAcquired?.();
    } finally {
      setSubmitting(false);
    }
  };

  const onInstantBuyFromReview = async () => {
    setInstantBuying(true);
    setInstantBuyError(null);
    try {
      const result = await instantAcquire(appId);
      if (!result.ok) {
        setInstantBuyError(result.errorMessage || 'Instant acquire failed.');
        return;
      }
      setOutcome('instant-bought');
      setSubmittedAmount(result.sale_price_light ?? 0);
      setStep('confirmation');
      await refreshListing();
      onAcquired?.();
    } finally {
      setInstantBuying(false);
    }
  };

  // Identify the viewer's own bid in the current listing (if any). The
  // Manage button only renders for the owning bidder, so existence implies
  // editability — but we re-fetch listing state before opening the manage
  // step so the user never sees stale data.
  const ownBid = listing?.bids?.find((b) => isYourBid(b, currentUserId)) ?? null;

  const onUpdateOwnBid = async (newAmount: number, message: string | undefined, willAcquire: boolean) => {
    if (!ownBid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (willAcquire) {
        // Buying-at-ask short-circuits the edit: drop the bid, hit acquire.
        const cancelled = await cancelBid(ownBid.id);
        if (!cancelled.ok) {
          setSubmitError(cancelled.errorMessage || 'Failed to release current bid.');
          return;
        }
        const bought = await instantAcquire(appId);
        if (!bought.ok) {
          setSubmitError(bought.errorMessage || 'Instant acquire failed.');
          return;
        }
        setOutcome('instant-bought');
        setSubmittedAmount(bought.sale_price_light ?? newAmount);
      } else {
        // Cancel + place. We let the BE settle the wallet diff atomically;
        // there's a small window where both calls are mid-flight, but the
        // listing fetch on completion shows the user's actual final state.
        const cancelled = await cancelBid(ownBid.id);
        if (!cancelled.ok) {
          setSubmitError(cancelled.errorMessage || 'Failed to release current bid.');
          return;
        }
        const placed = await placeBid({ appId, amountLight: newAmount, message });
        if (!placed.ok) {
          setSubmitError(placed.errorMessage || 'Failed to re-place bid.');
          return;
        }
        setOutcome('bid-updated');
        setSubmittedAmount(newAmount);
      }
      setStep('confirmation');
      await refreshListing();
      onAcquired?.();
    } finally {
      setSubmitting(false);
    }
  };

  const onWithdrawOwnBid = async () => {
    if (!ownBid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await cancelBid(ownBid.id);
      if (!result.ok) {
        setSubmitError(result.errorMessage || 'Failed to withdraw bid.');
        return;
      }
      setOutcome('bid-withdrawn');
      setSubmittedAmount(ownBid.amount_light);
      setStep('confirmation');
      await refreshListing();
      onAcquired?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} surface="paper" radius="xl" maxWidth="3xl" maxHeight="tall">
      <ModalCloseButton onClose={onClose} />
      {step === 'review' && (
        <ReviewStep
          appId={appId}
          appName={appName}
          listing={listing}
          currentUserId={currentUserId}
          onPlaceBid={() => { setSubmitError(null); setStep('bid'); }}
          onInstantBuy={onInstantBuyFromReview}
          instantBuying={instantBuying}
          instantBuyError={instantBuyError}
          onManageBid={() => { setSubmitError(null); setStep('manage'); }}
        />
      )}
      {step === 'bid' && (
        <BidStep
          appName={appName}
          listing={listing}
          onBack={() => { setSubmitError(null); setStep('review'); }}
          onSubmit={onSubmitBid}
          submitting={submitting}
          submitError={submitError}
        />
      )}
      {step === 'manage' && ownBid && (
        <ManageBidStep
          appName={appName}
          listing={listing}
          ownBid={ownBid}
          onBack={() => { setSubmitError(null); setStep('review'); }}
          onUpdate={onUpdateOwnBid}
          onWithdraw={onWithdrawOwnBid}
          submitting={submitting}
          submitError={submitError}
        />
      )}
      {step === 'confirmation' && (
        <ConfirmationStep
          appName={appName}
          outcome={outcome}
          amount={submittedAmount}
          onReturn={() => setStep('review')}
          onDone={onClose}
        />
      )}
    </Modal>
  );
}
