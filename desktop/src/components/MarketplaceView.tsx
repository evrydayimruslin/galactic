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

interface MarketplaceViewProps {
  onOpenTool: (appId: string, appName: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatCount(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function formatLight(n: number | undefined | null): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
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

// ── Featured hero (one big card on top of the page) ──────────────────

function FeaturedHero({ result, onOpen }: { result: MarketplaceResult; onOpen: () => void }) {
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
          <div className="flex items-center gap-4 text-caption text-ul-text-secondary">
            <span className="inline-flex items-center gap-1.5">
              <AuthorMark result={result} size={18} />
              {/* TODO(data): author display name not in marketplace response (B10). */}
              <span className="font-mono">@{(result.slug ?? '').split('-')[0] || 'author'}</span>
            </span>
            <span className="text-ul-text-muted">·</span>
            <span className="font-mono">{formatCount(result.runs_30d)} runs/30d</span>
            {result.likes !== undefined && (
              <>
                <span className="text-ul-text-muted">·</span>
                <span className="font-mono">♥ {formatCount(result.likes)}</span>
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
      <div className="text-right text-caption text-ul-text-muted font-mono">
        {/* TODO(data): per-tool growth7d / sparkline not in marketplace response (B10). */}
        {listing?.active_bid_count !== undefined && listing.active_bid_count > 0 ? (
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

function TrendingCard({ result, onOpen }: { result: MarketplaceResult; onOpen: () => void }) {
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
          {/* TODO(data): author display name (B10). */}
          <div className="text-nano text-ul-text-muted font-mono truncate">
            @{(result.slug ?? '').split('-')[0] || 'author'}
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
        {listing?.ask_price_light !== undefined && listing.ask_price_light !== null ? (
          <span className="text-ul-text">✦{formatLight(listing.ask_price_light)}</span>
        ) : (
          <span>—</span>
        )}
      </div>
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

export default function MarketplaceView({ onOpenTool }: MarketplaceViewProps) {
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

  // Search effect (debounced)
  useEffect(() => {
    if (!query.trim()) {
      setSearch(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      searchMarketplace(query)
        .then((r) => { if (!cancelled) setSearch(r); })
        .catch(() => { if (!cancelled) setSearch(null); });
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
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
                  <TrendingCard key={r.id} result={r} onOpen={() => onPickResult(r)} />
                ))}
              </div>
            ) : search?.results?.length === 0 ? (
              <div className="text-caption text-ul-warm-ink-muted">
                No matches for "{query}".
              </div>
            ) : null}
          </div>
        ) : (
          /* Browse mode */
          <>
            {/* Featured hero */}
            {featured && !activeCategory && (
              <div className="mb-8">
                <FeaturedHero result={featured} onOpen={() => onPickResult(featured)} />
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
                    <TrendingCard key={r.id} result={r} onOpen={() => onPickResult(r)} />
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
