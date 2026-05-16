// AuthorProfileView — B7 public author/seller page.
//
// Ports `BB_B7_Profile` from handoff/mockups/batch-b.jsx. Rendered for
// AppView { kind: 'author-profile', handle }. The route is internal-only
// (we're a Tauri SPA, not a web app); every `@handle` site in the FE that
// links here uses navigateToAuthorProfile rather than an anchor URL.
//
// Header / stats strip / tabs all render off a single
// AuthorProfileResponse fetched on mount. Empty / loading / error states
// keep the header skeleton so navigation back is always visible.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Sparkles } from 'lucide-react';
import {
  fetchAuthorProfile,
  type AuthorProfileResponse,
  type AuthorProfileToolSummary,
  type AuthorProfileAcquisition,
  type AuthorProfileActivityEvent,
} from '../lib/api';
import { deriveGlyph, deriveTone } from './ui/Glyph';
import { formatLightPrecise as formatLight } from '../lib/format';
import Sparkline from './marketplace/Sparkline';

interface AuthorProfileViewProps {
  handle: string;
  /** Routes a tool click back into the existing tool-detail surface. */
  onOpenTool?: (appId: string, appName: string) => void;
  /** Back-navigation hook (typically Marketplace or wherever the link
   *  originated). Optional — the breadcrumb is purely visual when unset. */
  onBack?: () => void;
}

type Tab = 'Tools' | 'Acquisitions' | 'Activity';

function formatInstallCount(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatJoinedMonth(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.max(0, Math.round((Date.now() - then) / 86_400_000));
  if (days < 1) return 'today';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export default function AuthorProfileView({ handle, onOpenTool, onBack }: AuthorProfileViewProps) {
  const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`;
  const [data, setData] = useState<AuthorProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('Tools');

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await fetchAuthorProfile(handle);
      setData(fresh);
      if (!fresh) {
        // 404 / endpoint missing during deploy gap — surface a friendly
        // empty state, not an error toast.
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load author.');
    } finally {
      setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Glyph tone — server-provided when available, deterministic fallback otherwise.
  const tone = data?.glyph_tone || deriveTone(handle);
  const monogram = useMemo(() => deriveGlyph(handle.replace(/^@/, '')), [handle]);

  const tools = data?.tools ?? [];
  const acquisitions = data?.acquisitions ?? [];
  const activity = data?.activity ?? [];
  const stats = data?.stats;

  return (
    <div className="bg-ul-bg h-full overflow-auto">
      {/* Breadcrumb — clickable when an onBack is provided. */}
      <div className="px-8 pt-5 flex items-center gap-1.5 text-nano font-mono text-ul-text-muted uppercase tracking-[0.06em]">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="bg-transparent border-none p-0 cursor-pointer inline-flex items-center gap-1 hover:text-ul-text-secondary"
          >
            <ChevronLeft className="w-3 h-3" strokeWidth={1.5} />
            <span>Marketplace</span>
          </button>
        ) : (
          <span>Marketplace</span>
        )}
        <span>·</span>
        <span>Author</span>
        <span>·</span>
        <span>{cleanHandle}</span>
      </div>

      {/* Identity header */}
      <div className="px-8 pt-5 flex gap-6 items-start">
        <div
          className="w-[84px] h-[84px] rounded-full text-white inline-flex items-center justify-center font-mono font-bold tracking-tight flex-shrink-0"
          style={{
            background: tone,
            fontSize: 30,
            letterSpacing: '-0.02em',
          }}
        >
          {monogram}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2.5 mb-1 flex-wrap">
            <div className="text-h1 tracking-tight font-bold">{cleanHandle}</div>
            {data?.verified && (
              <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-xs font-mono text-nano font-semibold uppercase tracking-[0.06em] bg-ul-success-soft text-ul-success-strong">
                <span className="w-1 h-1 rounded-full bg-ul-success" />
                Verified seller
              </span>
            )}
          </div>
          {data?.bio && (
            <p className="text-body text-ul-text leading-relaxed mb-2.5 max-w-[560px]">
              {data.bio}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3.5 text-caption text-ul-text-secondary">
            <span>Joined {formatJoinedMonth(data?.joined)}</span>
            {data?.location && (
              <>
                <span className="text-ul-text-muted">·</span>
                <span>{data.location}</span>
              </>
            )}
            {(data?.links ?? []).slice(0, 3).map((l) => (
              <span key={l.url} className="inline-flex items-center gap-2">
                <span className="text-ul-text-muted">·</span>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ul-text underline underline-offset-[3px] hover:text-ul-accent-hover"
                >
                  {l.label}
                </a>
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button
            type="button"
            disabled
            title="Subscribe to new publishes — coming soon"
            className="px-3.5 py-2 bg-ul-bg text-ul-text border border-ul-border rounded-md text-caption font-medium inline-flex items-center gap-1.5 cursor-not-allowed opacity-60"
          >
            <Sparkles className="w-3 h-3" strokeWidth={1.5} />
            Watch
          </button>
          <button
            type="button"
            disabled
            title="Direct messaging — out of scope for this batch"
            className="px-3.5 py-2 bg-ul-text text-white border-none rounded-md text-caption font-medium cursor-not-allowed opacity-60"
          >
            Message
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="mx-8 mt-6 grid grid-cols-4 border border-ul-border rounded-lg overflow-hidden">
        {[
          { l: 'Published', v: stats?.published ?? 0, sub: 'tools' },
          { l: 'Total installs', v: formatInstallCount(stats?.installs), sub: 'across all tools' },
          { l: 'Acquisitions', v: stats?.acquisitions ?? 0, sub: 'tools acquired' },
          {
            l: 'Lifetime earnings',
            v: stats?.earnings !== undefined && stats?.earnings !== null
              ? `✦${formatInstallCount(Math.round(stats.earnings))}`
              : '✦—',
            sub: stats?.earnings === null || stats?.earnings === undefined
              ? 'private to author'
              : 'visible (you are the author)',
          },
        ].map((s, i) => (
          <div
            key={s.l}
            className={`px-4 py-3.5 ${i > 0 ? 'border-l border-ul-border' : ''}`}
          >
            <div className="text-nano font-mono uppercase tracking-[0.06em] text-ul-text-muted mb-1.5">
              {s.l}
            </div>
            <div className="text-h2 font-bold tracking-tight tabular-nums leading-none">
              {s.v}
            </div>
            <div className="text-nano text-ul-text-muted mt-1">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="px-8 pt-5 flex items-center justify-between">
        <div className="flex gap-1.5">
          {(['Tools', 'Acquisitions', 'Activity'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`text-caption font-mono uppercase tracking-wider px-3 py-1.5 rounded-sm border cursor-pointer transition-colors ${
                tab === t
                  ? 'bg-ul-text text-white border-ul-text'
                  : 'bg-ul-bg text-ul-text-secondary border-ul-border hover:bg-ul-bg-hover'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {tab === 'Tools' && tools.length > 0 && (
          <div className="text-nano font-mono text-ul-text-muted">sort: most installed ▾</div>
        )}
      </div>

      {/* Body */}
      <div className="px-8 pb-10 pt-3.5">
        {loading && !data ? (
          <div className="px-3.5 py-6 text-caption text-ul-text-muted">Loading…</div>
        ) : error ? (
          <div className="px-3.5 py-6 text-caption text-ul-error">{error}</div>
        ) : tab === 'Tools' ? (
          <ToolsTab tools={tools} cleanHandle={cleanHandle} onOpenTool={onOpenTool} />
        ) : tab === 'Acquisitions' ? (
          <AcquisitionsTab items={acquisitions} cleanHandle={cleanHandle} />
        ) : (
          <ActivityTab events={activity} cleanHandle={cleanHandle} />
        )}
      </div>
    </div>
  );
}

// ── Tab bodies ────────────────────────────────────────────────────────

function ToolsTab({
  tools,
  cleanHandle,
  onOpenTool,
}: {
  tools: AuthorProfileToolSummary[];
  cleanHandle: string;
  onOpenTool?: (appId: string, appName: string) => void;
}) {
  if (tools.length === 0) {
    return (
      <div className="px-3.5 py-12 text-center text-caption text-ul-text-muted">
        {cleanHandle} hasn&apos;t published a tool yet.
      </div>
    );
  }
  return (
    <div>
      <div className="grid grid-cols-[48px_1.6fr_1fr_90px_90px_70px] gap-4 px-2 py-2 border-b border-ul-border text-nano font-mono uppercase tracking-[0.08em] text-ul-text-muted">
        <span />
        <span>Tool</span>
        <span>Tagline</span>
        <span className="text-right">Installs</span>
        <span className="text-right">✦/call</span>
        <span className="text-right">7d</span>
      </div>
      {tools.map((t, i) => {
        const tone = t.glyph_tone || deriveTone(t.id);
        const monogram = deriveGlyph(t.name);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onOpenTool?.(t.id, t.name)}
            disabled={!onOpenTool}
            className={`w-full text-left grid grid-cols-[48px_1.6fr_1fr_90px_90px_70px] gap-4 items-center px-2 py-3.5 text-small border-b border-ul-border bg-transparent ${
              onOpenTool ? 'cursor-pointer hover:bg-ul-bg-hover' : 'cursor-default'
            } ${i === tools.length - 1 ? 'border-b-0' : ''}`}
          >
            <span
              className="w-10 h-10 rounded-pill text-white inline-flex items-center justify-center font-mono font-bold flex-shrink-0"
              style={{ background: tone, fontSize: 14, letterSpacing: '-0.02em' }}
            >
              {monogram}
            </span>
            <div className="min-w-0">
              <div className="text-body font-semibold truncate">{t.name}</div>
              {t.category && (
                <div className="text-nano font-mono text-ul-text-muted mt-0.5">{t.category}</div>
              )}
            </div>
            <div className="text-caption text-ul-text-secondary truncate">{t.tagline ?? t.description ?? ''}</div>
            <div className="text-right font-mono text-caption font-medium text-ul-text tabular-nums">
              {formatInstallCount(t.installs)}
            </div>
            <div className="text-right font-mono text-micro text-ul-text-secondary tabular-nums">
              {t.call_price_light !== undefined && t.call_price_light !== null
                ? `✦${formatLight(t.call_price_light)}`
                : '—'}
            </div>
            <div className="text-right">
              {t.sparkline && t.sparkline.length >= 2 ? (
                <span
                  className={
                    (t.growth_7d ?? 0) > 0.05
                      ? 'text-ul-success-strong'
                      : (t.growth_7d ?? 0) < -0.05
                        ? 'text-ul-error'
                        : 'text-ul-text-secondary'
                  }
                >
                  <Sparkline values={t.sparkline} width={56} height={16} />
                </span>
              ) : (
                <span className="text-nano text-ul-text-muted">—</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function AcquisitionsTab({
  items,
  cleanHandle,
}: {
  items: AuthorProfileAcquisition[];
  cleanHandle: string;
}) {
  if (items.length === 0) {
    return (
      <div className="px-3.5 py-12 text-center text-caption text-ul-text-muted">
        No acquisitions yet.
      </div>
    );
  }
  return (
    <div>
      <div className="text-caption text-ul-text-secondary mb-3">
        Tools <strong className="text-ul-text font-semibold">{cleanHandle}</strong> has acquired.
        Ownership transferred from the original author — calls now route here.
      </div>
      <div className="grid grid-cols-[48px_1.4fr_1fr_110px_90px] gap-4 px-2 py-2 border-b border-ul-border text-nano font-mono uppercase tracking-[0.08em] text-ul-text-muted">
        <span />
        <span>Tool</span>
        <span>From</span>
        <span className="text-right">Acquired</span>
        <span className="text-right">Calls/wk</span>
      </div>
      {items.map((a, i) => {
        const tone = a.glyph_tone || deriveTone(a.app_id);
        const monogram = deriveGlyph(a.app_name);
        return (
          <div
            key={a.id}
            className={`grid grid-cols-[48px_1.4fr_1fr_110px_90px] gap-4 items-center px-2 py-3.5 text-small border-b border-ul-border ${
              i === items.length - 1 ? 'border-b-0' : ''
            }`}
          >
            <span
              className="w-10 h-10 rounded-pill text-white inline-flex items-center justify-center font-mono font-bold"
              style={{ background: tone, fontSize: 14, letterSpacing: '-0.02em' }}
            >
              {monogram}
            </span>
            <div className="min-w-0">
              <div className="text-body font-semibold truncate">{a.app_name}</div>
              <div className="text-nano font-mono text-ul-text-muted mt-0.5">
                {formatJoinedMonth(a.acquired_at)}
                {a.sale_price_light !== undefined && a.sale_price_light !== null && (
                  <> · ✦{formatInstallCount(a.sale_price_light)}</>
                )}
              </div>
            </div>
            <div className="text-small font-mono text-ul-text-secondary truncate">
              {a.from_handle}
            </div>
            <div className="text-right font-mono text-micro text-ul-text-secondary tabular-nums">
              {formatJoinedMonth(a.acquired_at)}
            </div>
            <div className="text-right font-mono text-caption text-ul-text font-medium tabular-nums">
              {a.calls_per_week !== undefined ? formatInstallCount(a.calls_per_week) : '—'}
            </div>
          </div>
        );
      })}
      <div className="mt-5 p-3.5 bg-ul-bg-raised border border-ul-border rounded-lg text-caption text-ul-text-secondary leading-relaxed">
        Acquisition prices and revenue figures default to <strong className="text-ul-text">private</strong>.
        The author can opt in to public revenue via the visibility settings on each tool&apos;s listing.
      </div>
    </div>
  );
}

function ActivityTab({
  events,
  cleanHandle,
}: {
  events: AuthorProfileActivityEvent[];
  cleanHandle: string;
}) {
  if (events.length === 0) {
    return (
      <div className="px-3.5 py-12 text-center text-caption text-ul-text-muted">
        No recent public activity from {cleanHandle}.
      </div>
    );
  }
  return (
    <div>
      <div className="text-caption text-ul-text-secondary mb-3.5">
        Public activity — new tools, version bumps, acquisitions. No call-by-call data.
      </div>
      {events.map((e, i) => (
        <div
          key={`${e.at}-${i}`}
          className={`grid grid-cols-[90px_1fr] gap-3.5 px-2 py-3 text-small ${
            i === events.length - 1 ? '' : 'border-b border-ul-border'
          }`}
        >
          <span className="text-nano font-mono uppercase tracking-[0.04em] text-ul-text-muted self-center">
            {formatRelative(e.at)}
          </span>
          <span className="text-ul-text">{e.text}</span>
        </div>
      ))}
    </div>
  );
}
