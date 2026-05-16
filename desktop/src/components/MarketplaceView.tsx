// MarketplaceView — native marketplace landing page.
//
// Ports `MMarketEditorial` from handoff/mockups/market.jsx (V1 editorial
// variant — chosen over V2 dense as the primary landing). Uses the
// warm-paper theme (per DESIGN-TOKENS-DIFF §1) since marketplace +
// acquisition share that canvas.
//
// Data: `/api/discover/marketplace?format=sections` (browse) and
// `?q=<query>` (search) — see api.ts:fetchMarketplaceBrowse /
// searchMarketplace. Newly-acquired feed from `/api/discover/newly-acquired`.
//
// Mockup fields not yet on the BE response (flagged in DESIGN-FOLLOWUPS
// B10): sparkline, growth7d, latencyP50, callPrice (per-call cost),
// author display name. Renders placeholders / TODO comments for those.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import {
  fetchMarketplaceBrowse,
  searchMarketplace,
  fetchNewlyAcquired,
  type MarketplaceBrowseResponse,
  type MarketplaceSearchResponse,
  type MarketplaceResult,
  type MarketplaceSection,
  type NewlyAcquiredEntry,
} from '../lib/api';
import Glyph, { deriveGlyph, deriveTone } from './ui/Glyph';
import Spark from './ui/Spark';
import Sparkline from './marketplace/Sparkline';
import { formatLightPrecise as formatLight, formatAuthorHandle } from '../lib/format';

interface MarketplaceViewProps {
  onOpenTool: (appId: string, appName: string) => void;
  /** Navigate to the public author profile (B7). When unset, @handle
   *  text stays inert — preserves the pre-B7 behaviour during the BE
   *  deploy gap or in surfaces that don't have routing handy. */
  onOpenAuthor?: (handle: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatCount(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}


function formatRelativeDays(iso: string | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86_400_000);
  if (d < 1) return 'today';
  if (d === 1) return '1d ago';
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

// Render a Glyph + tone derived from result.id. Author display name isn't on
// the marketplace response today (DESIGN-FOLLOWUPS B10) — we show the slug
// prefix instead, gated by a TODO.
function AuthorMark({ result, size = 20 }: { result: MarketplaceResult; size?: number }) {
  return <Glyph glyph={deriveGlyph(result.slug ?? result.name)} tone={deriveTone(result.id)} size={size} />;
}

// Author handle anchor — wraps an inline `@handle` in a clickable target
// that routes to AuthorProfileView (B7). Falls back to a plain span when
// no onOpenAuthor handler is wired (preserves pre-B7 behaviour during
// the BE deploy gap and in surfaces that don't have routing). The handle
// is normalised to include the leading `@` regardless of input.
function AuthorLink({
  result,
  onOpenAuthor,
  className,
}: {
  result: MarketplaceResult;
  onOpenAuthor?: (handle: string) => void;
  className?: string;
}) {
  const handle = formatAuthorHandle(result, { truncateAtDash: true });
  const display = `@${handle}`;
  if (!onOpenAuthor || handle === 'author') {
    return <span className={className}>{display}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpenAuthor(handle);
      }}
      className={`bg-transparent border-none p-0 cursor-pointer underline underline-offset-[3px] text-ul-text hover:text-ul-accent-hover ${className ?? ''}`}
    >
      {display}
    </button>
  );
}

// ── Featured hero (one big card on top of the page) ──────────────────

function FeaturedHero({
  result,
  onOpen,
  onOpenAuthor,
}: {
  result: MarketplaceResult;
  onOpen: () => void;
  onOpenAuthor?: (handle: string) => void;
}) {
  const tone = deriveTone(result.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left w-full rounded-xl px-8 py-9 border border-ul-border bg-ul-bg-raised relative overflow-hidden cursor-pointer transition-all duration-base hover:-translate-y-px hover:shadow-lg"
      style={{ minHeight: 200 }}
    >
      {/* Soft radial glow — accent color */}
      <div
        className="absolute -right-10 -top-10 w-60 h-60 rounded-full pointer-events-none"
        style={{ background: `radial-gradient(circle, ${tone}1f 0%, transparent 70%)` }}
      />
      <div className="relative flex items-end gap-8">
        <div className="flex-1 min-w-0">
          <div className="text-nano font-mono text-ul-text-muted uppercase tracking-widest mb-3.5">
            Featured
          </div>
          <div className="text-display text-ul-text leading-none tracking-tighter mb-2.5">
            {result.name}
          </div>
          {result.description && (
            <div className="text-body-lg text-ul-text-secondary leading-relaxed mb-4 max-w-[480px]">
              {result.description}
            </div>
          )}
          <div className="flex items-center gap-4 text-caption text-ul-text-secondary flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <AuthorMark result={result} size={18} />
              <AuthorLink result={result} onOpenAuthor={onOpenAuthor} className="font-mono" />
            </span>
            <span className="text-ul-text-muted">·</span>
            <span className="font-mono">{formatCount(result.runs_30d)} runs/30d</span>
            {result.likes !== undefined && (
              <>
                <span className="text-ul-text-muted">·</span>
                <span className="font-mono">♥ {formatCount(result.likes)}</span>
              </>
            )}
            {/* B10 — per-call price + sparkline-with-growth, rendered
                inline with the existing metadata strip when present. */}
            {result.price_per_call_light !== undefined && result.price_per_call_light !== null && (
              <>
                <span className="text-ul-text-muted">·</span>
                <span className="font-mono text-ul-text">
                  ✦{formatLight(result.price_per_call_light)}/call
                </span>
              </>
            )}
            {result.sparkline && result.sparkline.length >= 2 && (
              <>
                <span className="text-ul-text-muted">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-ul-text-muted">
                    <Sparkline values={result.sparkline} width={48} height={14} />
                  </span>
                  {result.growth_7d !== undefined && (
                    <span
                      className={`font-mono text-nano ${
                        result.growth_7d >= 0 ? 'text-ul-success-strong' : 'text-ul-error'
                      }`}
                    >
                      {result.growth_7d >= 0 ? '+' : ''}
                      {Math.round(result.growth_7d * 100)}%
                    </span>
                  )}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-2 flex-shrink-0">
          <span className="bg-ul-text text-white px-5 py-3 rounded-lg text-body font-medium inline-flex items-center gap-2">
            Open
            <span className="font-mono text-micro opacity-60">↵</span>
          </span>
        </div>
      </div>
    </button>
  );
}

// ── Billboard row (numbered top-N rank list) ─────────────────────────

function BillboardRow({ result, rank, onOpen }: { result: MarketplaceResult; rank: number; onOpen: () => void }) {
  const listing = result.marketplace;
  return (
    <div
      onClick={onOpen}
      className="grid grid-cols-[48px_minmax(0,1fr)_100px_64px] items-center gap-4 px-1 py-3.5 border-t border-ul-border cursor-pointer hover:bg-ul-bg-subtle transition-colors"
    >
      <div
        className={`font-mono text-2xl font-bold text-right tabular-nums leading-none ${
          rank <= 3 ? 'text-ul-text' : 'text-ul-text-muted'
        }`}
        style={{ letterSpacing: '-0.04em' }}
      >
        {rank}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <AuthorMark result={result} />
          <span className="text-body font-semibold tracking-tight">{result.name}</span>
        </div>
        {result.description && (
          <div className="text-small text-ul-text-secondary mt-0.5 truncate">
            {result.description}
          </div>
        )}
      </div>
      <div className="text-right text-caption text-ul-text-muted font-mono flex items-center justify-end gap-2">
        {/* B10 — sparkline + growth when BE ships them, otherwise fall back
            to active bid count or a placeholder. Renders in priority order
            so the visible signal is always the most product-relevant one. */}
        {result.sparkline && result.sparkline.length >= 2 ? (
          <>
            <span className="text-ul-text-muted">
              <Sparkline values={result.sparkline} width={48} height={14} />
            </span>
            {result.growth_7d !== undefined && (
              <span
                className={result.growth_7d >= 0 ? 'text-ul-success-strong' : 'text-ul-error'}
              >
                {result.growth_7d >= 0 ? '+' : ''}
                {Math.round(result.growth_7d * 100)}%
              </span>
            )}
          </>
        ) : listing?.active_bid_count !== undefined && listing.active_bid_count > 0 ? (
          <span className="text-ul-info">{listing.active_bid_count} bids</span>
        ) : (
          <span>—</span>
        )}
      </div>
      <div className="text-right font-mono text-caption text-ul-text-secondary tabular-nums">
        {formatCount(result.runs_30d)}
      </div>
    </div>
  );
}

// ── Category chip ────────────────────────────────────────────────────

function CategoryChip({
  title,
  count,
  active,
  onClick,
}: {
  title: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3.5 py-1.5 rounded-pill text-caption font-medium transition-colors whitespace-nowrap ${
        active
          ? 'bg-ul-text text-white border border-ul-text'
          : 'bg-ul-bg border border-ul-border text-ul-text-secondary hover:bg-ul-bg-hover'
      }`}
    >
      {title}
      {count !== undefined && count > 0 && (
        <span className="ml-1.5 text-ul-text-muted font-mono text-nano">{formatCount(count)}</span>
      )}
    </button>
  );
}

// ── Trending card (grid item under each section) ─────────────────────

function TrendingCard({
  result,
  onOpen,
  onOpenAuthor,
}: {
  result: MarketplaceResult;
  onOpen: () => void;
  onOpenAuthor?: (handle: string) => void;
}) {
  const listing = result.marketplace;
  return (
    <div
      onClick={onOpen}
      className="rounded-card border border-ul-border bg-ul-bg p-3.5 cursor-pointer transition-all duration-base hover:-translate-y-px hover:shadow-md"
    >
      <div className="flex items-center gap-2.5 mb-2.5">
        <AuthorMark result={result} size={28} />
        <div className="flex-1 min-w-0">
          <div className="text-body font-semibold truncate">{result.name}</div>
          <div className="text-nano text-ul-text-muted font-mono truncate">
            <AuthorLink result={result} onOpenAuthor={onOpenAuthor} />
          </div>
        </div>
      </div>
      {result.description && (
        <div className="text-small text-ul-text-secondary leading-tight line-clamp-2 mb-2.5">
          {result.description}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-nano font-mono text-ul-text-muted">
        <span>{formatCount(result.runs_30d)} runs</span>
        {/* B10 — prefer per-call price (mockup's primary metric); fall
            back to the listing ask when per-call isn't reported. */}
        {result.price_per_call_light !== undefined && result.price_per_call_light !== null ? (
          <span className="text-ul-text">✦{formatLight(result.price_per_call_light)}/call</span>
        ) : listing?.ask_price_light !== undefined && listing.ask_price_light !== null ? (
          <span className="text-ul-text">✦{formatLight(listing.ask_price_light)}</span>
        ) : (
          <span>—</span>
        )}
      </div>
      {/* Optional sparkline tail when B10 data is present. */}
      {result.sparkline && result.sparkline.length >= 2 && (
        <div className="mt-2 text-ul-text-muted">
          <Sparkline values={result.sparkline} width={56} height={14} />
        </div>
      )}
    </div>
  );
}

// ── Newly acquired strip (small public feed below the fold) ──────────

function NewlyAcquiredStrip({ entries, onOpenTool }: { entries: NewlyAcquiredEntry[]; onOpenTool: (id: string, name: string) => void }) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-8">
      <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-2.5">
        Newly acquired
      </div>
      <div className="flex flex-col">
        {entries.slice(0, 5).map((entry) => (
          <div
            key={entry.receipt_id}
            onClick={() => onOpenTool(entry.app_id, entry.app_name)}
            className="flex items-center gap-3 py-2 border-t border-ul-border cursor-pointer hover:bg-ul-bg-subtle transition-colors"
          >
            <Glyph glyph={deriveGlyph(entry.app_name)} tone={deriveTone(entry.app_id)} size={24} />
            <div className="flex-1 min-w-0">
              <div className="text-small text-ul-text truncate">
                {entry.app_name}
                {entry.seller?.display_name && (
                  <span className="text-ul-text-muted"> · sold by {entry.seller.display_name}</span>
                )}
                {entry.buyer?.display_name && (
                  <span className="text-ul-text-muted"> → {entry.buyer.display_name}</span>
                )}
              </div>
            </div>
            <div className="text-caption font-mono text-ul-text-secondary tabular-nums">
              ✦{formatLight(entry.sale_price_light)}
            </div>
            <div className="text-nano font-mono text-ul-text-muted w-16 text-right">
              {formatRelativeDays(entry.created_at)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── MarketplaceView ──────────────────────────────────────────────────

export default function MarketplaceView({ onOpenTool, onOpenAuthor }: MarketplaceViewProps) {
  const [browse, setBrowse] = useState<MarketplaceBrowseResponse | null>(null);
  const [search, setSearch] = useState<MarketplaceSearchResponse | null>(null);
  const [acquisitions, setAcquisitions] = useState<NewlyAcquiredEntry[]>([]);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initial browse fetch + newly-acquired feed
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchMarketplaceBrowse(), fetchNewlyAcquired(8)])
      .then(([b, a]) => {
        if (cancelled) return;
        setBrowse(b);
        setAcquisitions(a);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Search effect (debounced + cancelable). The AbortController kills the
  // outgoing fetch when the user keeps typing, so an earlier slow request
  // can't race past a newer one and clobber the rendered results.
  useEffect(() => {
    if (!query.trim()) {
      setSearch(null);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(() => {
      searchMarketplace(query, { signal: controller.signal })
        .then((r) => { if (!controller.signal.aborted) setSearch(r); })
        .catch((err) => {
          if (controller.signal.aborted) return;
          if (err && (err as Error).name === 'AbortError') return;
          setSearch(null);
        });
    }, 200);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [query]);

  // Derive a flat top-10 from all browse sections by runs_30d
  const topBillboard = useMemo<MarketplaceResult[]>(() => {
    if (!browse) return [];
    const seen = new Set<string>();
    const flat: MarketplaceResult[] = [];
    for (const section of browse.sections) {
      for (const r of section.results) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        flat.push(r);
      }
    }
    return flat.sort((a, b) => (b.runs_30d ?? 0) - (a.runs_30d ?? 0)).slice(0, 10);
  }, [browse]);

  // Featured: prefer an explicit "Featured" section, else the most-run app
  const featured = useMemo<MarketplaceResult | null>(() => {
    if (!browse) return null;
    const featSection = browse.sections.find((s) => s.type === 'featured');
    return featSection?.results[0] ?? topBillboard[0] ?? null;
  }, [browse, topBillboard]);

  // Categories surfaced from the response
  const categorySections = useMemo<MarketplaceSection[]>(() => {
    if (!browse) return [];
    return browse.sections.filter((s) => s.type === 'category' || s.type === 'skills');
  }, [browse]);

  // Category-filtered view when a chip is active
  const visibleCategorySections = useMemo(() => {
    if (!activeCategory) return categorySections;
    return categorySections.filter((s) => s.title === activeCategory);
  }, [categorySections, activeCategory]);

  const onPickResult = useCallback(
    (r: MarketplaceResult) => onOpenTool(r.id, r.name),
    [onOpenTool],
  );

  return (
    <div className="bg-ul-warm-paper h-full overflow-auto">
      <div className="max-w-[1080px] mx-auto px-8 pt-8 pb-12">
        {/* Header */}
        <div className="mb-6">
          <div className="text-micro font-mono text-ul-text-muted uppercase tracking-widest mb-1">
            Marketplace
          </div>
          <div className="text-h1 text-ul-warm-ink tracking-tighter">Find a tool</div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 px-3.5 py-2.5 border border-ul-border rounded-pill bg-ul-bg mb-5">
          <Search className="w-3.5 h-3.5 text-ul-text-muted flex-shrink-0" strokeWidth={1.5} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools by name, capability, or task…"
            className="flex-1 border-none outline-none bg-transparent text-small text-ul-warm-ink"
          />
        </div>

        {/* Category chips (browse mode only) */}
        {!query && categorySections.length > 0 && (
          <div className="flex items-center gap-1.5 mb-7 overflow-x-auto pb-1">
            <CategoryChip
              title="All"
              active={activeCategory === null}
              onClick={() => setActiveCategory(null)}
            />
            {categorySections.map((s) => (
              <CategoryChip
                key={s.title}
                title={s.title}
                count={s.results.length}
                active={activeCategory === s.title}
                onClick={() => setActiveCategory(s.title === activeCategory ? null : s.title)}
              />
            ))}
          </div>
        )}

        {/* Loading / error */}
        {loading && !browse ? (
          <div className="text-caption text-ul-warm-ink-muted">Loading marketplace…</div>
        ) : error ? (
          <div className="text-caption text-ul-error">{error}</div>
        ) : query.trim() ? (
          /* Search mode */
          <div>
            <div className="text-micro font-mono text-ul-warm-ink-muted uppercase tracking-widest mb-2.5">
              {search?.total
                ? `${search.results.length} result${search.results.length === 1 ? '' : 's'}`
                : 'Searching…'}
            </div>
            {search?.results && search.results.length > 0 ? (
              <div className="grid grid-cols-2 gap-3">
                {search.results.map((r) => (
                  <TrendingCard key={r.id} result={r} onOpen={() => onPickResult(r)} onOpenAuthor={onOpenAuthor} />
                ))}
              </div>
            ) : search?.results?.length === 0 ? (
              <div className="flex flex-col items-center text-center py-12 animate-fade-up">
                <div
                  className="w-12 h-12 rounded-full bg-white flex items-center justify-center mb-3"
                  style={{ boxShadow: '0 1px 0 rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.05)' }}
                >
                  <Spark size={22} color="#999999" />
                </div>
                <div className="text-small text-ul-warm-ink font-medium mb-1">
                  No matches for "{query}".
                </div>
                <div className="text-micro text-ul-warm-ink-muted font-mono">
                  Try fewer words, or browse trending below.
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          /* Browse mode */
          <>
            {/* Featured hero */}
            {featured && !activeCategory && (
              <div className="mb-8">
                <FeaturedHero result={featured} onOpen={() => onPickResult(featured)} onOpenAuthor={onOpenAuthor} />
              </div>
            )}

            {/* Top 10 Billboard */}
            {!activeCategory && topBillboard.length > 1 && (
              <div className="mb-9">
                <div className="text-micro font-mono text-ul-warm-ink-muted uppercase tracking-widest mb-2.5">
                  Top 10
                </div>
                <div className="border-b border-ul-border">
                  {topBillboard.map((r, i) => (
                    <BillboardRow key={r.id} result={r} rank={i + 1} onOpen={() => onPickResult(r)} />
                  ))}
                </div>
              </div>
            )}

            {/* Category sections */}
            {visibleCategorySections.map((section) => (
              <div key={section.title} className="mb-8">
                <div className="text-micro font-mono text-ul-warm-ink-muted uppercase tracking-widest mb-2.5">
                  {section.title}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {section.results.slice(0, 6).map((r) => (
                    <TrendingCard key={r.id} result={r} onOpen={() => onPickResult(r)} onOpenAuthor={onOpenAuthor} />
                  ))}
                </div>
              </div>
            ))}

            {/* Newly acquired */}
            <NewlyAcquiredStrip entries={acquisitions} onOpenTool={onOpenTool} />
          </>
        )}
      </div>
    </div>
  );
}
