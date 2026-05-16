// ToolDetailView — native tool / app detail page.
//
// Ports `PToolPage` from handoff/mockups/tool-page.jsx. Replaces the
// embedded WebPanel /app/:appId iframe.
//
// Layout:
//   Breadcrumb · MARKETPLACE · {CATEGORY} · {NAME}
//   Avatar (Glyph) + Name + "by @owner · category" + tagline
//   [ Install ]  [ Acquire ]
//   ┌── Functions table ──────────┐  ┌─ Side rail ─┐
//   │ name(args)  ✦/call  latency │  │ For sale /  │
//   │   [expand] -> sandbox       │  │ Not for sale│
//   │ ...                         │  │ Bids list   │
//   └─────────────────────────────┘  │ Revenue     │
//   ┌── Capabilities pills ───────┐  └─────────────┘
//
// Scope notes (see DESIGN-FOLLOWUPS.md):
//   - Sandbox runner: rendered as placeholder; real `ul.call` execution
//     requires permissions handling (DESIGN-FOLLOWUPS A7).
//   - Install / Acquire button wiring: visual only — depends on the
//     AcquisitionFlow modal which lands in Batch 4c.
//
// Batch 4b retrofit:
//   - Side rail now fetches /api/marketplace/listing/{appId} and renders
//     real ask price + bids + revenue + owner admin checklist (when the
//     viewer is the owner).

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Download, MoreHorizontal } from 'lucide-react';
import { Check, X as XIcon } from 'lucide-react';
import Glyph, { deriveGlyph, deriveTone } from './ui/Glyph';
import AcquisitionFlow from './marketplace/AcquisitionFlow';
import SoldConfirmation from './marketplace/SoldConfirmation';
import { fetchFromApi, getToken } from '../lib/storage';
import { formatLightPrecise as formatLight, formatAuthorHandle } from '../lib/format';
import {
  fetchMarketplaceListing,
  setAskPrice,
  setMetricsVisibility,
  acceptBid,
  rejectBid,
  installLibraryApp,
  uninstallLibraryApp,
  type MarketplaceBid,
  type MarketplaceListingDetails,
  type MarketplaceOwnerAdminChecklistItem,
} from '../lib/api';
import type { App, SkillFunction, PermissionDeclaration } from '../../../shared/types/index';

interface ToolDetailViewProps {
  appId: string;
  /** Optional name to render while the full app payload loads. */
  fallbackName?: string;
  /** Navigate to the public author profile (B7). When unset the byline
   *  handle stays inert. */
  onOpenAuthor?: (handle: string) => void;
}

// ── Fetch ─────────────────────────────────────────────────────────────

async function fetchApp(appId: string): Promise<App | null> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchFromApi(`/api/apps/${encodeURIComponent(appId)}`, { headers });
  if (!res.ok) return null;
  const data = (await res.json()) as { app?: App } | App;
  // Tolerate either { app: App } or App at top level.
  if (data && typeof data === 'object' && 'app' in data && data.app) {
    return data.app as App;
  }
  return data as App;
}

// ── Helpers ───────────────────────────────────────────────────────────

function parseFunctionArgs(parameters: Record<string, unknown> | undefined): string {
  if (!parameters || typeof parameters !== 'object') return '()';
  const keys = Object.keys(parameters);
  if (keys.length === 0) return '()';
  return `(${keys.join(', ')})`;
}

// Permission strings look like "memory:read" / "net:api.openai.com" / "ai:call".
// Map the kind prefix to a tone + arrow glyph matching the mockup palette.
const CAP_TONES: Record<string, { tone: string; arrow: string; label: string }> = {
  read: { tone: '#3b82f6', arrow: '↘', label: 'read' },
  write: { tone: '#f59e0b', arrow: '↗', label: 'write' },
  net: { tone: '#8b5cf6', arrow: '⇄', label: 'net' },
  ai: { tone: '#7c3aed', arrow: '✦', label: 'ai' },
  memory: { tone: '#3b82f6', arrow: '↘', label: 'memory' },
  storage: { tone: '#22c55e', arrow: '↗', label: 'storage' },
  gpu: { tone: '#ef4444', arrow: '⚡', label: 'gpu' },
};

function classifyPermission(p: PermissionDeclaration): { tone: string; arrow: string; label: string; detail: string } {
  const [head, ...rest] = p.permission.split(':');
  const meta = CAP_TONES[head] ?? { tone: '#9a9a9a', arrow: '·', label: head };
  return { ...meta, detail: rest.join(':') || p.description || p.permission };
}

// ── Subcomponents ─────────────────────────────────────────────────────

function FunctionRow({
  fn,
  isLast,
  defaultOpen,
}: {
  fn: SkillFunction;
  isLast: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={isLast ? '' : 'border-b border-ul-border'}>
      <div
        onClick={() => setOpen((o) => !o)}
        className="grid grid-cols-[1fr_110px_80px_24px] items-center gap-4 py-2.5 px-1 cursor-pointer"
      >
        <div className="min-w-0">
          <div className="font-mono text-small text-ul-text font-medium">
            {fn.name}
            <span className="text-ul-text-muted font-normal">{parseFunctionArgs(fn.parameters)}</span>
          </div>
          <div className="text-caption text-ul-text-secondary mt-0.5 truncate">{fn.description}</div>
        </div>
        {/* B5 — per-function price/call from telemetry rollup. Falls
            back to the em-dash placeholder when the field is absent
            (BE staging or no recent invocations to derive from). */}
        <div className="font-mono text-caption tabular-nums text-left">
          {fn.price_per_call_light !== undefined && fn.price_per_call_light !== null ? (
            <>
              <span className="text-ul-text">✦{formatLight(fn.price_per_call_light)}</span>
              <span className="text-ul-text-muted">/call</span>
            </>
          ) : (
            <span className="text-ul-text-muted">
              ✦—<span className="text-ul-text-muted">/call</span>
            </span>
          )}
        </div>
        {/* B5 — per-function p50 latency. */}
        <div className="font-mono text-micro tabular-nums text-center">
          {fn.latency_p50_ms !== undefined && fn.latency_p50_ms !== null ? (
            <span className="text-ul-text-secondary">{Math.round(fn.latency_p50_ms)}ms</span>
          ) : (
            <span className="text-ul-text-muted">—</span>
          )}
        </div>
        <ChevronRight
          className={`w-3.5 h-3.5 text-ul-text-muted transition-transform duration-base ${open ? 'rotate-90' : ''}`}
          strokeWidth={1.5}
        />
      </div>
      {open && (
        <div className="px-1 pb-3.5 pt-1 animate-fade-up">
          <SandboxPlaceholder fn={fn} />
        </div>
      )}
    </div>
  );
}

function SandboxPlaceholder({ fn }: { fn: SkillFunction }) {
  // TODO(scope): Real `ul.call` sandbox requires per-app permission handling
  // (DESIGN-FOLLOWUPS A7). Until then, show the function signature + a
  // disabled Run button so users can see the shape of the call.
  const paramKeys =
    fn.parameters && typeof fn.parameters === 'object' ? Object.keys(fn.parameters) : [];
  return (
    <div className="border border-ul-border bg-ul-bg overflow-hidden">
      <div className="p-3.5 grid grid-cols-2 gap-4 items-stretch">
        <div className="flex flex-col">
          <div className="text-micro text-ul-text-muted mb-1.5 font-mono">arguments</div>
          <div className="flex flex-col gap-2">
            {paramKeys.length === 0 ? (
              <div className="text-caption text-ul-text-muted italic">no arguments</div>
            ) : (
              paramKeys.map((k) => (
                <label key={k} className="text-caption text-ul-text-secondary">
                  {k}
                  <input
                    disabled
                    placeholder={`(${k})`}
                    className="block w-full box-border mt-1 px-2.5 py-2 border border-ul-border text-small font-sans outline-none bg-ul-bg-subtle text-ul-text-muted"
                  />
                </label>
              ))
            )}
            <button
              disabled
              className="mt-1 w-full box-border px-3.5 py-2 bg-ul-bg text-ul-text-muted border border-ul-border text-caption font-medium cursor-not-allowed inline-flex items-center justify-center gap-1.5"
              title="Sandbox runner ships in a follow-up batch"
            >
              Run <span className="font-mono opacity-50">↵</span>
            </button>
          </div>
        </div>
        <div className="flex flex-col">
          <div className="text-micro text-ul-text-muted mb-1.5 font-mono">output sandbox</div>
          <pre className="m-0 p-2.5 bg-ul-text text-emerald-300 text-micro font-mono flex-1 leading-relaxed overflow-auto whitespace-pre-wrap">
            // Sandbox runner arrives in a follow-up batch.
          </pre>
        </div>
      </div>
    </div>
  );
}

function CapabilityPill({ cap }: { cap: PermissionDeclaration }) {
  const { tone, arrow, label, detail } = classifyPermission(cap);
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-ul-bg-raised border border-ul-border rounded-md">
      <span className="font-mono text-micro font-semibold" style={{ color: tone }}>
        {arrow} {label}
      </span>
      <span className="text-caption text-ul-text-secondary">{detail}</span>
    </div>
  );
}

// ── Side rail helpers ─────────────────────────────────────────────────


function formatRelativeHours(iso: string | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const h = Math.floor(ms / 3_600_000);
  const d = Math.floor(ms / 86_400_000);
  if (h < 1) return '<1h ago';
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  return `${Math.floor(d / 7)}w ago`;
}

function BidderMark({
  bid,
  onOpenAuthor,
}: {
  bid: MarketplaceBid;
  onOpenAuthor?: (handle: string) => void;
}) {
  const seed = bid.bidder_id || bid.bidder_email || bid.id;
  const label = bid.bidder_display_name || bid.bidder_email?.split('@')[0] || 'bidder';
  const linkable = !!onOpenAuthor && label !== 'bidder';
  return (
    <div className="flex items-center gap-1.5">
      <Glyph glyph={deriveGlyph(label)} tone={deriveTone(seed)} size={16} />
      {linkable ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenAuthor!(label);
          }}
          className="text-caption text-ul-text-secondary truncate underline underline-offset-[3px] bg-transparent border-none p-0 cursor-pointer hover:text-ul-text"
        >
          @{label}
        </button>
      ) : (
        <span className="text-caption text-ul-text-secondary truncate">@{label}</span>
      )}
    </div>
  );
}

function ChecklistDot({ status }: { status: MarketplaceOwnerAdminChecklistItem['status'] }) {
  const tone =
    status === 'ready' ? 'bg-ul-success' :
    status === 'action' ? 'bg-ul-warning' :
    status === 'blocked' ? 'bg-ul-error' :
    'bg-ul-text-muted'; // 'optional'
  return <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tone}`} />;
}

interface SideRailProps {
  appId: string;
  appName: string;
  details: MarketplaceListingDetails | null;
  loading: boolean;
  isOwner: boolean;
  onOpenAcquisition: () => void;
  onListingChanged: () => Promise<void>;
  onOpenAuthor?: (handle: string) => void;
}

// ── Seller-only ask editor ────────────────────────────────────────────

function AskEditor({
  appId,
  currentAsk,
  currentInstantBuy,
  onCommitted,
  onCancel,
}: {
  appId: string;
  currentAsk: number | null;
  currentInstantBuy: boolean;
  onCommitted: () => Promise<void>;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState<number>(currentAsk ?? 1000);
  const [instant, setInstant] = useState<boolean>(currentInstantBuy);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSave = async (clearing = false) => {
    setSubmitting(true);
    setErr(null);
    const result = await setAskPrice({
      appId,
      priceLight: clearing ? null : amount,
      instantBuy: clearing ? undefined : instant,
    });
    if (!result.ok) {
      setErr(result.errorMessage || 'Failed to save ask.');
      setSubmitting(false);
      return;
    }
    await onCommitted();
    setSubmitting(false);
  };

  return (
    <div className="px-4 py-3.5 border-b border-ul-border bg-ul-bg-raised">
      <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-2">
        {currentAsk !== null ? 'Edit ask' : 'Set ask price'}
      </div>
      <div className="flex items-center gap-2 border border-ul-border rounded-md px-2.5 py-1.5 bg-ul-bg mb-2">
        <span className="text-body font-mono">✦</span>
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
          min={1}
          step={1}
          className="flex-1 border-none outline-none text-body font-mono font-semibold tabular-nums bg-transparent"
        />
        <span className="text-nano text-ul-text-muted font-mono">Light</span>
      </div>
      <label className="flex items-center gap-2 text-caption text-ul-text-secondary cursor-pointer mb-2.5">
        <input
          type="checkbox"
          checked={instant}
          onChange={(e) => setInstant(e.target.checked)}
          className="cursor-pointer"
        />
        Allow instant buy at this price
      </label>
      {err && <div className="text-nano text-ul-error mb-2">{err}</div>}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="flex-1 px-2 py-1.5 bg-ul-bg text-ul-text border border-ul-border rounded-sm text-caption font-medium cursor-pointer hover:bg-ul-bg-hover disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void onSave(false)}
          disabled={submitting || amount <= 0}
          className="flex-[1.5] px-2 py-1.5 bg-ul-text text-white border-none rounded-sm text-caption font-medium cursor-pointer hover:bg-ul-accent-hover disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? 'Saving…' : currentAsk !== null ? 'Update ask' : 'Set ask'}
        </button>
      </div>
      {currentAsk !== null && (
        <button
          type="button"
          onClick={() => void onSave(true)}
          disabled={submitting}
          className="mt-2 w-full px-2 py-1.5 bg-transparent text-ul-text-secondary border-none text-nano font-mono uppercase tracking-wider cursor-pointer hover:text-ul-error disabled:opacity-60"
        >
          Unlist tool
        </button>
      )}
    </div>
  );
}

// ── Visibility picker (A11) ──────────────────────────────────────────
//
// The mockup ships a 4-tier visibility model — public / bid-threshold /
// hand-picked / private — but the BE only exposes a boolean `show_metrics`
// today. We render all four radios for design parity and gate the two
// unsupported tiers as "needs BE" (DESIGN-FOLLOWUPS B-section, alongside
// B7 / B8 / B10 marketplace enrichment).
//
// Public → show_metrics=true. Private → show_metrics=false. Threshold +
// Shortlist are intentionally not interactive yet.

type VisibilityMode = 'public' | 'threshold' | 'shortlist' | 'private';

interface VisibilityPickerProps {
  appId: string;
  showMetrics: boolean | undefined;
  onCommitted: () => Promise<void>;
}

function deriveMode(showMetrics: boolean | undefined): VisibilityMode {
  return showMetrics ? 'public' : 'private';
}

function VisibilityPicker({ appId, showMetrics, onCommitted }: VisibilityPickerProps) {
  const [optimistic, setOptimistic] = useState<VisibilityMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = optimistic ?? deriveMode(showMetrics);

  const pick = async (next: VisibilityMode) => {
    if (next === mode) return;
    if (next === 'threshold' || next === 'shortlist') return; // BE-gated; no-op
    setOptimistic(next);
    setSaving(true);
    setError(null);
    const result = await setMetricsVisibility({ appId, showMetrics: next === 'public' });
    if (!result.ok) {
      setError(result.errorMessage || 'Failed to update visibility.');
      setOptimistic(null);
    } else {
      await onCommitted();
      setOptimistic(null);
    }
    setSaving(false);
  };

  const options: Array<{
    id: VisibilityMode;
    label: string;
    desc: string;
    disabled?: boolean;
  }> = [
    { id: 'public',    label: 'Public',          desc: 'Anyone browsing the page sees revenue + call volume.' },
    { id: 'threshold', label: 'Bid threshold',   desc: 'Visible only after a bidder posts a minimum amount in escrow.', disabled: true },
    { id: 'shortlist', label: 'Hand-picked',     desc: 'Allowlist specific bidders by email.', disabled: true },
    { id: 'private',   label: 'Private',         desc: "No one but you sees the numbers. (Default.)" },
  ];

  return (
    <div className="px-3.5 py-3 border-t border-ul-border">
      <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-2">
        Revenue visibility
      </div>
      <div className="flex flex-col gap-1.5">
        {options.map((opt) => {
          const selected = mode === opt.id;
          return (
            <label
              key={opt.id}
              className={`flex gap-2.5 p-2 rounded-md cursor-pointer transition-colors ${
                opt.disabled
                  ? 'opacity-50 cursor-not-allowed'
                  : selected
                    ? 'bg-ul-bg-subtle border border-ul-text'
                    : 'bg-transparent border border-ul-border hover:bg-ul-bg-hover'
              }`}
            >
              <input
                type="radio"
                name={`vis-${appId}`}
                checked={selected}
                disabled={opt.disabled || saving}
                onChange={() => void pick(opt.id)}
                className="mt-0.5 flex-shrink-0 cursor-pointer disabled:cursor-not-allowed"
              />
              <div className="min-w-0 flex-1">
                <div className="text-caption font-medium text-ul-text flex items-center gap-1.5">
                  {opt.label}
                  {opt.disabled && (
                    <span className="text-nano font-mono text-ul-text-muted uppercase tracking-wider">
                      needs BE
                    </span>
                  )}
                </div>
                <div className="text-nano text-ul-text-secondary leading-relaxed mt-0.5">
                  {opt.desc}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      {error && <div className="mt-2 text-nano text-ul-error">{error}</div>}
    </div>
  );
}

function SideRail({ appId, appName, details, loading, isOwner, onOpenAcquisition, onListingChanged, onOpenAuthor }: SideRailProps) {
  const [editingAsk, setEditingAsk] = useState(false);
  // Per-bid action state — which bid is being accepted/rejected, with last error
  const [bidActionId, setBidActionId] = useState<string | null>(null);
  const [bidActionError, setBidActionError] = useState<string | null>(null);
  // Post-accept celebration overlay. Captured before listing refresh so the
  // modal can show the buyer + amount even after ownership has rolled over.
  const [soldDetails, setSoldDetails] = useState<{
    buyerHandle: string;
    amount: number;
    path: 'accepted' | 'instant';
  } | null>(null);

  if (loading && !details) {
    return (
      <aside className="sticky top-6 self-start">
        <div className="border border-ul-border rounded-lg overflow-hidden bg-ul-bg p-4">
          <div className="text-caption text-ul-text-muted">Loading listing…</div>
        </div>
      </aside>
    );
  }

  const listing = details?.listing ?? null;
  const summary = details?.marketplace_summary ?? null;
  const ask = listing?.ask_price_light ?? summary?.ask_price_light ?? null;
  const bids = (details?.bids ?? []).slice().sort((a, b) => b.amount_light - a.amount_light);
  // Owners see all open bids inline; non-owners see top 3.
  const visibleBids = isOwner ? bids : bids.slice(0, 3);
  const askExists = ask !== null && ask !== undefined && ask > 0;
  const fee = summary?.platform_fee_at_ask_light ?? null;
  const payout = summary?.seller_payout_at_ask_light ?? null;

  const onAcceptBid = async (bidId: string) => {
    setBidActionId(bidId);
    setBidActionError(null);
    // Snapshot the bid we're about to accept BEFORE the network call, so
    // SoldConfirmation has stable details to render even after the listing
    // rolls over to the new owner.
    const target = bids.find((b) => b.id === bidId);
    const buyerHandle = target?.bidder_display_name
      ? `@${target.bidder_display_name}`
      : target?.bidder_email
        ? `@${target.bidder_email.split('@')[0]}`
        : '@buyer';
    const acceptedAmount = target?.amount_light ?? 0;
    const result = await acceptBid(bidId);
    if (!result.ok) {
      setBidActionError(result.errorMessage || 'Failed to accept bid.');
      setBidActionId(null);
      return;
    }
    setSoldDetails({ buyerHandle, amount: acceptedAmount, path: 'accepted' });
    await onListingChanged();
    setBidActionId(null);
  };

  const onRejectBid = async (bidId: string) => {
    setBidActionId(bidId);
    setBidActionError(null);
    const result = await rejectBid(bidId);
    if (!result.ok) {
      setBidActionError(result.errorMessage || 'Failed to reject bid.');
      setBidActionId(null);
      return;
    }
    await onListingChanged();
    setBidActionId(null);
  };

  return (
    <aside className="sticky top-6 self-start">
      <div className="border border-ul-border rounded-lg overflow-hidden bg-ul-bg">
        {/* Ask header — owner gets the editor inline */}
        {isOwner && editingAsk ? (
          <AskEditor
            appId={appId}
            currentAsk={ask}
            currentInstantBuy={!!listing?.instant_buy}
            onCancel={() => setEditingAsk(false)}
            onCommitted={async () => {
              await onListingChanged();
              setEditingAsk(false);
            }}
          />
        ) : askExists ? (
          <div className="px-4 py-3.5 border-b border-ul-border bg-ul-bg-raised">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest">
                For sale · ask
              </div>
              {isOwner && (
                <button
                  type="button"
                  onClick={() => setEditingAsk(true)}
                  className="text-nano font-mono text-ul-text-secondary bg-transparent border-none cursor-pointer hover:text-ul-text underline"
                >
                  Edit
                </button>
              )}
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-h2 font-bold font-mono tabular-nums tracking-tight">
                ✦{formatLight(ask)}
              </span>
              {listing?.instant_buy && (
                <span className="text-nano font-mono text-ul-success-strong uppercase tracking-wider">
                  instant
                </span>
              )}
            </div>
            {/* Fee + payout — visible to owner only */}
            {isOwner && fee !== null && payout !== null && (
              <div className="mt-2 text-nano font-mono text-ul-text-muted leading-relaxed">
                Platform fee ✦{formatLight(fee)} · payout ✦{formatLight(payout)}
              </div>
            )}
          </div>
        ) : (
          <div className="px-4 py-3.5 border-b border-ul-border bg-ul-bg-raised">
            <div className="flex items-center justify-between mb-1">
              <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest">
                Not for sale
              </div>
              {isOwner && (
                <button
                  type="button"
                  onClick={() => setEditingAsk(true)}
                  className="text-nano font-mono text-ul-text-secondary bg-transparent border-none cursor-pointer hover:text-ul-text underline"
                >
                  Set ask
                </button>
              )}
            </div>
            <div className="text-small text-ul-text-secondary leading-tight">
              {isOwner
                ? 'No ask set. Buyers can still post bids on this tool.'
                : "Owner hasn't set an ask. Place a bid — if it's accepted, ownership transfers."}
            </div>
          </div>
        )}

        {/* Bids */}
        <div className="px-3.5 py-3">
          <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-2">
            {bids.length > 0
              ? (isOwner ? `Open bids · ${bids.length}` : askExists ? `Place a bid · ${bids.length} open` : `Open bids · ${bids.length}`)
              : 'No open bids yet'}
          </div>
          {bidActionError && (
            <div className="text-nano text-ul-error mb-2">{bidActionError}</div>
          )}
          {visibleBids.length > 0 && (
            <div className="flex flex-col gap-2 mb-2">
              {visibleBids.map((bid) => (
                <div key={bid.id} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <BidderMark bid={bid} onOpenAuthor={onOpenAuthor} />
                  </div>
                  <div className="font-mono text-caption text-ul-text tabular-nums flex-shrink-0">
                    ✦{formatLight(bid.amount_light)}
                  </div>
                  {isOwner && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => void onAcceptBid(bid.id)}
                        disabled={bidActionId !== null}
                        className="w-6 h-6 rounded-full bg-ul-success-soft text-ul-success-strong flex items-center justify-center cursor-pointer hover:opacity-80 disabled:opacity-40 disabled:cursor-wait"
                        title="Accept bid (transfers ownership)"
                      >
                        <Check className="w-3 h-3" strokeWidth={2.5} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void onRejectBid(bid.id)}
                        disabled={bidActionId !== null}
                        className="w-6 h-6 rounded-full bg-ul-error-soft text-ul-error flex items-center justify-center cursor-pointer hover:opacity-80 disabled:opacity-40 disabled:cursor-wait"
                        title="Decline bid (refunds escrow)"
                      >
                        <XIcon className="w-3 h-3" strokeWidth={2.5} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {!isOwner && (
            <button
              type="button"
              onClick={onOpenAcquisition}
              className="bg-transparent text-ul-text border-none p-0 text-caption font-medium underline cursor-pointer hover:text-ul-text-secondary"
            >
              {askExists ? 'See all bids →' : bids.length > 0 ? 'See all bids →' : 'Place a bid →'}
            </button>
          )}
        </div>

        {/* Visibility picker — owner-only, drives the existing show_metrics
            boolean (4-tier picker per A11 mockup; threshold + shortlist
            tiers are gated until BE supports them). */}
        {isOwner && (
          <VisibilityPicker
            appId={appId}
            showMetrics={summary?.show_metrics}
            onCommitted={onListingChanged}
          />
        )}

        {/* Revenue / owner admin */}
        {isOwner && details?.owner_admin && details.owner_admin.checklist && details.owner_admin.checklist.length > 0 ? (
          <div className="px-3.5 py-3 border-t border-ul-border bg-ul-bg-raised">
            <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-2">
              Seller checklist
            </div>
            <div className="flex flex-col gap-1.5 mb-2">
              {details.owner_admin.checklist.slice(0, 5).map((item) => (
                <div key={item.id} className="flex items-center gap-2 text-caption">
                  <ChecklistDot status={item.status} />
                  <span className={item.status === 'ready' ? 'text-ul-text-muted line-through' : 'text-ul-text'}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
            {details.owner_admin.balance_light !== undefined && (
              <div className="text-nano font-mono text-ul-text-muted mt-2">
                Balance ✦{formatLight(details.owner_admin.balance_light)}
                {details.owner_admin.total_earned_light !== undefined &&
                  ` · earned ✦${formatLight(details.owner_admin.total_earned_light)}`}
              </div>
            )}
          </div>
        ) : !isOwner ? (
          /* Non-owner: short visibility note. Owners see the picker above. */
          <div className="px-3.5 py-2.5 border-t border-ul-border text-micro text-ul-text-muted italic leading-relaxed">
            {summary?.show_metrics
              ? 'Sales metrics visible on this tool — view from the metrics endpoint.'
              : 'Revenue is private.'}
          </div>
        ) : null}
      </div>
      {soldDetails && (
        <SoldConfirmation
          toolName={appName}
          buyerHandle={soldDetails.buyerHandle}
          amount={soldDetails.amount}
          path={soldDetails.path}
          onClose={() => setSoldDetails(null)}
        />
      )}
    </aside>
  );
}

// ── Install button + kebab (B11) ──────────────────────────────────────
//
// State machine:
//   idle → installing → installed
//                     │
//                     └─► (on error) idle  + inline error
//
// `installed` shows an inline kebab next to the checkmark. The kebab
// popover offers Uninstall (functional) and three placeholder actions —
// Update available / Pin / Settings — gated behind BE work that hasn't
// landed (DESIGN-FOLLOWUPS B11).

type InstallState = 'idle' | 'installing' | 'installed';

function InstallButton({
  app,
  initialInstalled,
  onChanged,
}: {
  app: App | null;
  initialInstalled: boolean;
  onChanged?: (installed: boolean) => void;
}) {
  const [state, setState] = useState<InstallState>(initialInstalled ? 'installed' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLButtonElement | null>(null);

  // Sync external state changes (e.g. ToolDetailView refetched the app
  // and the `is_installed` flag flipped from elsewhere). Don't clobber
  // an in-flight installing/uninstalling transition.
  useEffect(() => {
    if (state === 'installing') return;
    setState(initialInstalled ? 'installed' : 'idle');
  }, [initialInstalled, state]);

  // Close the kebab menu on document click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const onInstall = async () => {
    if (!app || state !== 'idle') return;
    setState('installing');
    setError(null);
    const result = await installLibraryApp(app.id);
    if (!result.ok) {
      setError(result.errorMessage || "Couldn't install. Try again.");
      setState('idle');
      return;
    }
    setState('installed');
    onChanged?.(true);
  };

  const onUninstall = async () => {
    if (!app) return;
    setMenuOpen(false);
    const previousState = state;
    setState('idle');
    setError(null);
    const result = await uninstallLibraryApp(app.id);
    if (!result.ok) {
      setError(result.errorMessage || 'Failed to uninstall.');
      setState(previousState);
      return;
    }
    onChanged?.(false);
  };

  if (state === 'installing') {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <button
          disabled
          className="px-5 py-3 bg-ul-text text-white border-none rounded-lg text-body font-medium inline-flex items-center justify-center gap-2 cursor-wait opacity-90"
        >
          <span
            className="inline-block w-3 h-3 rounded-full animate-spin"
            style={{
              borderWidth: '1.5px',
              borderStyle: 'solid',
              borderColor: 'rgba(255,255,255,0.35)',
              borderTopColor: '#fff',
              animationDuration: '0.75s',
            }}
            aria-hidden
          />
          Installing…
        </button>
      </div>
    );
  }

  if (state === 'installed') {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <div className="flex items-stretch">
          <span className="px-5 py-3 bg-ul-bg text-ul-text border border-ul-border rounded-l-lg text-body font-medium inline-flex items-center justify-center gap-1.5">
            <Check className="w-3.5 h-3.5" strokeWidth={2} />
            Installed
          </span>
          <div className="relative">
            <button
              ref={kebabRef}
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              title="Installed-tool actions"
              aria-label="Installed-tool actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="h-full px-2.5 bg-ul-bg text-ul-text-secondary border border-l-0 border-ul-border rounded-r-lg cursor-pointer inline-flex items-center justify-center hover:bg-ul-bg-hover"
            >
              <MoreHorizontal className="w-4 h-4" strokeWidth={1.5} />
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute z-20 right-0 top-full mt-1.5 w-[180px] bg-ul-bg border border-ul-border rounded-md shadow-md ring-1 ring-black/[0.02] py-1 animate-fade-up"
              >
                <button
                  type="button"
                  onClick={() => void onUninstall()}
                  role="menuitem"
                  className="w-full text-left px-3 py-1.5 text-caption text-ul-text bg-transparent border-none cursor-pointer hover:bg-ul-bg-hover"
                >
                  Uninstall
                </button>
                <KebabPlaceholderRow label="Update available" hint="Pending BE: version-pin detection" />
                <KebabPlaceholderRow label="Pin" hint="Pending BE: pin flag (DESIGN-FOLLOWUPS B11)" />
                <KebabPlaceholderRow label="Settings" hint="Pending BE: per-app settings surface" />
              </div>
            )}
          </div>
        </div>
        {error && (
          <span className="text-nano text-ul-error">{error}</span>
        )}
      </div>
    );
  }

  // idle
  const installCount = app?.total_runs ?? 0;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        disabled={!app}
        onClick={() => void onInstall()}
        className="px-5 py-3 bg-ul-text text-white border-none rounded-lg text-body font-medium cursor-pointer inline-flex items-center justify-center gap-1.5 hover:bg-ul-accent-hover disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Download className="w-3.5 h-3.5" strokeWidth={2} />
        <span>Install</span>
        {installCount > 0 && (
          <span className="font-mono font-normal text-small opacity-60">
            ({installCount.toLocaleString()})
          </span>
        )}
      </button>
      {error && (
        <span className="text-nano text-ul-error">{error}</span>
      )}
    </div>
  );
}

function KebabPlaceholderRow({ label, hint }: { label: string; hint: string }) {
  return (
    <button
      type="button"
      disabled
      title={hint}
      role="menuitem"
      className="w-full text-left px-3 py-1.5 text-caption text-ul-text-muted bg-transparent border-none cursor-not-allowed"
    >
      {label}
    </button>
  );
}

// ── ToolDetailView ────────────────────────────────────────────────────

export default function ToolDetailView({ appId, fallbackName, onOpenAuthor }: ToolDetailViewProps) {
  const [app, setApp] = useState<App | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<MarketplaceListingDetails | null>(null);
  const [listingLoading, setListingLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // Load current user id for owner classification (e.g. "is this me viewing my own tool?")
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetchFromApi('/api/user', { headers: { 'Authorization': `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { id?: string } | null) => {
        if (data?.id) setCurrentUserId(data.id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListingLoading(true);
    setError(null);
    // Fetch app metadata + marketplace listing in parallel. Either may
    // fail independently — listing is allowed to be null for unlisted apps.
    Promise.all([fetchApp(appId), fetchMarketplaceListing(appId)])
      .then(([appResult, listingResult]) => {
        if (cancelled) return;
        if (!appResult) {
          setError('Tool not found');
        } else {
          setApp(appResult);
        }
        setListing(listingResult);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setListingLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [appId]);

  const isOwner = !!(app && currentUserId && app.owner_id === currentUserId);
  const [acquisitionOpen, setAcquisitionOpen] = useState(false);

  const refetchListing = useCallback(async () => {
    const fresh = await fetchMarketplaceListing(appId);
    setListing(fresh);
  }, [appId]);

  const displayName = app?.name || fallbackName || 'Loading…';
  const functions = app?.skills_parsed?.functions ?? [];
  const permissions = app?.declared_permissions ?? app?.skills_parsed?.permissions ?? [];
  const tagline = app?.description || app?.skills_parsed?.description || '';
  const category = app?.category || 'tool';
  const slug = app?.slug || appId;

  return (
    <div className="bg-ul-bg h-full overflow-auto font-sans">
      <div className="max-w-[1080px] mx-auto px-8 pt-8 pb-16">
        {/* Breadcrumb */}
        <div className="text-micro font-mono text-ul-text-muted mb-4 tracking-wider">
          MARKETPLACE · {category.toUpperCase()} · {slug.toUpperCase()}
        </div>

        {/* Title + tagline + actions */}
        <div className="mb-9 max-w-[720px]">
          <div className="flex items-center gap-3.5 mb-3">
            <Glyph glyph={deriveGlyph(displayName)} tone={deriveTone(app?.id || appId)} size={44} />
            <div>
              <div className="text-h1 text-ul-text leading-none tracking-tighter">{displayName}</div>
              <div className="text-small text-ul-text-secondary mt-1">
                {app ? (
                  <>
                    by{' '}
                    {(() => {
                      const handle = formatAuthorHandle(app, { fallback: 'owner' });
                      if (!onOpenAuthor || handle === 'owner') {
                        return <span>@{handle}</span>;
                      }
                      return (
                        <button
                          type="button"
                          onClick={() => onOpenAuthor(handle)}
                          className="bg-transparent border-none p-0 cursor-pointer underline underline-offset-[3px] text-ul-text hover:text-ul-accent-hover"
                        >
                          @{handle}
                        </button>
                      );
                    })()}
                    {' '}· {category}
                  </>
                ) : (
                  <>&nbsp;</>
                )}
              </div>
            </div>
          </div>
          {tagline && (
            <div className="text-body-lg text-ul-text leading-relaxed mb-4">{tagline}</div>
          )}
          {/* Install + Acquire. Install runs the B11 state machine
              against /api/user/library/install. Acquire is unchanged
              per the addendum (acquire is a paid ownership transfer,
              install is the free save-to-library affordance). */}
          <div className="flex gap-2 items-start">
            <InstallButton
              app={app}
              initialInstalled={!!app?.is_installed}
              onChanged={(installed) => setApp((prev) => (prev ? { ...prev, is_installed: installed } : prev))}
            />
            <button
              disabled={!app || isOwner}
              onClick={() => setAcquisitionOpen(true)}
              className="px-5 py-3 bg-ul-bg text-ul-text border border-ul-border rounded-lg text-body font-medium cursor-pointer inline-flex items-center justify-center gap-1.5 hover:bg-ul-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
              title={isOwner ? "You're the owner of this tool" : undefined}
            >
              <span>Acquire</span>
              <span className="text-ul-text-muted font-mono font-normal text-small">
                {listing?.listing?.ask_price_light
                  ? `(✦${formatLight(listing.listing.ask_price_light)})`
                  : '(make offer)'}
              </span>
            </button>
          </div>
        </div>

        {/* Loading / error states */}
        {loading && !app ? (
          <div className="text-caption text-ul-text-muted">Loading tool…</div>
        ) : error ? (
          <div className="text-caption text-ul-error">{error}</div>
        ) : app ? (
          <div className="grid grid-cols-[1fr_320px] gap-8 items-start">
            <div className="min-w-0">
              {/* Functions */}
              <div className="mb-8">
                <div className="mb-2">
                  <div className="grid grid-cols-[1fr_110px_80px_24px] gap-4 px-1 pb-2 border-b border-ul-border text-micro font-mono text-ul-text-muted uppercase tracking-wider">
                    <span>Function ({functions.length})</span>
                    <span className="text-left">Price/call</span>
                    <span className="text-center">Latency</span>
                    <span></span>
                  </div>
                </div>
                <div>
                  {functions.length === 0 ? (
                    <div className="px-1 py-3.5 text-caption text-ul-text-muted">
                      No function metadata published yet.
                    </div>
                  ) : (
                    functions.map((f, i) => (
                      <FunctionRow
                        key={f.name}
                        fn={f}
                        isLast={i === functions.length - 1}
                        defaultOpen={i === 0}
                      />
                    ))
                  )}
                </div>
              </div>

              {/* Capabilities */}
              <div>
                <div className="text-body-lg font-semibold tracking-tight mb-3">Capabilities</div>
                {permissions.length === 0 ? (
                  <div className="text-caption text-ul-text-muted">No capabilities declared.</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {permissions.map((c, i) => (
                      <CapabilityPill key={i} cap={c} />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <SideRail
              appId={appId}
              appName={app?.name ?? fallbackName ?? 'tool'}
              details={listing}
              loading={listingLoading}
              isOwner={isOwner}
              onOpenAcquisition={() => setAcquisitionOpen(true)}
              onListingChanged={refetchListing}
              onOpenAuthor={onOpenAuthor}
            />
          </div>
        ) : null}
      </div>

      {acquisitionOpen && app && (
        <AcquisitionFlow
          appId={app.id}
          appName={app.name}
          currentUserId={currentUserId}
          initialListing={listing}
          onClose={() => setAcquisitionOpen(false)}
          onAcquired={() => { void refetchListing(); }}
          onOpenAuthor={onOpenAuthor}
        />
      )}
    </div>
  );
}
