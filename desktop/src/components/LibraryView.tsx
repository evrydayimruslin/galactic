// LibraryView — the Tools page rendered natively.
//
// Ports `LibraryHybrid` from handoff/mockups/library-screens.jsx (the
// final variant chosen by design; see DESIGN-FOLLOWUPS.md A5).
//
// Layout: Library / Shared tab toggle, search + kind/sort filters, then
// sections: Running now / Pinned / Your tools / Installed.
//
// Data: `ul.discover({ scope: 'library' })` via /mcp/platform JSON-RPC.
// The response shape historically wraps results under `results` or
// `library_results`; we accept either and map to a flexible row shape.
//
// Scope notes (called out in PR description, see DESIGN-FOLLOWUPS.md):
//   - Running indicator: no per-app "is running" BE signal today; the
//     section renders empty until that flag exists.
//   - Pinned: no BE pin flag today; section renders empty.
//   - Shared tab: empty-state placeholder; full Shared listing is a
//     follow-up batch.
//   - Sort dropdown: static UI only.
//   - Kind filter dropdown: static UI only.

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import Glyph, { deriveGlyph, deriveTone } from './ui/Glyph';
import { fetchFromApi, getToken } from '../lib/storage';

// ── Row shape (FE-internal; tolerant of varying BE response keys) ─────

interface LibraryRow {
  id: string;
  name: string;
  slug?: string;
  description: string;
  version?: string;
  fns?: number;
  calls?: string;
  last?: string;
  status: 'private' | 'published' | 'installed';
  owner?: string;
  isOwned: boolean;
  glyph: string;
  tone: string;
}

// ── Discover library fetch ────────────────────────────────────────────

interface DiscoverResult {
  id?: string;
  app_id?: string;
  name?: string;
  slug?: string;
  description?: string;
  version?: string;
  current_version?: string;
  visibility?: string;
  owner_id?: string;
  owner_handle?: string;
  exports?: string[];
  fns?: number;
  total_runs?: number;
  runs_30d?: number;
  last_used_at?: string;
  last_build_at?: string;
  is_owner?: boolean;
}

interface DiscoverEnvelope {
  results?: DiscoverResult[];
  library_results?: DiscoverResult[];
  apps?: DiscoverResult[];
}

async function fetchLibraryApps(query: string): Promise<DiscoverResult[]> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetchFromApi('/mcp/platform', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'library',
      method: 'tools/call',
      params: {
        name: 'ul.discover',
        arguments: { scope: 'library', query: query || undefined },
      },
    }),
  });
  if (!res.ok) throw new Error(`discover failed: ${res.status}`);
  const data = await res.json() as { result?: { content?: { text?: string }[] } };
  const text = data.result?.content?.[0]?.text;
  if (!text) return [];
  const parsed = JSON.parse(text) as DiscoverEnvelope;
  return parsed.results || parsed.library_results || parsed.apps || [];
}

// ── Row mapping (BE result -> render shape) ───────────────────────────

function formatCalls(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatRelative(iso: string | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(diff / 86_400_000);
  const w = Math.floor(diff / (7 * 86_400_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString();
}

function mapResultToRow(r: DiscoverResult, currentUserId: string | null): LibraryRow {
  const id = r.id || r.app_id || r.slug || r.name || crypto.randomUUID();
  const name = r.name || r.slug || 'Unnamed';
  const isOwned = r.is_owner ?? (currentUserId !== null && r.owner_id === currentUserId);
  const visibility = r.visibility;
  const status: LibraryRow['status'] = !isOwned
    ? 'installed'
    : visibility === 'public' || visibility === 'unlisted'
      ? 'published'
      : 'private';
  return {
    id,
    name,
    slug: r.slug,
    description: r.description || '',
    version: r.current_version || r.version,
    fns: r.fns ?? (Array.isArray(r.exports) ? r.exports.length : undefined),
    calls: formatCalls(r.runs_30d ?? r.total_runs),
    last: formatRelative(r.last_used_at || r.last_build_at),
    status,
    owner: r.owner_handle,
    isOwned,
    glyph: deriveGlyph(name),
    tone: deriveTone(id),
  };
}

// ── Owner / status badge ──────────────────────────────────────────────

function OwnerBadge({ row }: { row: LibraryRow }) {
  if (row.status === 'published') {
    return (
      <span className="inline-flex items-center gap-1 text-nano font-mono text-ul-success-strong bg-ul-success-soft px-1.5 py-0.5 rounded-xs uppercase font-semibold tracking-wider">
        <span className="w-1 h-1 rounded-full bg-ul-success-strong" />
        Published
      </span>
    );
  }
  if (row.status === 'private') {
    return (
      <span className="text-nano font-mono text-ul-text-secondary bg-ul-bg-active px-1.5 py-0.5 rounded-xs uppercase font-semibold tracking-wider">
        Private
      </span>
    );
  }
  return (
    <span className="text-nano font-mono text-ul-text-secondary border border-ul-border px-1.5 py-0.5 rounded-xs tracking-wider">
      by {row.owner ? `@${row.owner}` : 'others'}
    </span>
  );
}

// ── Row + Section primitives ──────────────────────────────────────────

function Row({
  row,
  running = false,
  onOpen,
}: {
  row: LibraryRow;
  running?: boolean;
  onOpen?: () => void;
}) {
  return (
    <div
      onClick={onOpen}
      className={`grid grid-cols-[40px_minmax(0,1fr)_70px_70px_70px] gap-4 items-center px-3.5 py-3.5 rounded-pill ${onOpen ? 'cursor-pointer' : ''} hover:bg-ul-bg-subtle transition-colors`}
    >
      <div className="relative">
        <Glyph glyph={row.glyph} tone={row.tone} size={36} />
        {running && (
          <span
            className="absolute -right-0.5 -bottom-0.5 w-[11px] h-[11px] rounded-full bg-ul-success border-2 border-ul-bg animate-pulse-slow"
          />
        )}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <span className="text-body font-semibold text-ul-text tracking-tight">{row.name}</span>
          {row.version && (
            <span className="text-nano font-mono text-ul-text-muted">{row.version}</span>
          )}
          <OwnerBadge row={row} />
        </div>
        <div className="text-caption text-ul-text-secondary leading-tight truncate">
          {row.description}
        </div>
      </div>
      <div className="text-right font-mono text-micro text-ul-text-secondary tabular-nums">
        {row.fns ?? '—'}
      </div>
      <div className="text-right font-mono text-micro text-ul-text-secondary tabular-nums">
        {row.calls ?? '—'}
      </div>
      <div className="text-right font-mono text-nano text-ul-text-muted">
        {row.last ?? '—'}
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  count,
  action,
}: {
  title: string;
  count: string;
  action?: string;
}) {
  return (
    <div className="flex items-baseline justify-between px-3.5 pt-5 pb-1">
      <div className="flex items-baseline gap-2">
        <span className="text-micro font-mono text-ul-text font-semibold uppercase tracking-widest">
          {title}
        </span>
        <span className="text-nano font-mono text-ul-text-muted">{count}</span>
      </div>
      {action && (
        <span className="text-micro text-ul-text-secondary cursor-pointer">{action}</span>
      )}
    </div>
  );
}

// ── LibraryView ───────────────────────────────────────────────────────

interface LibraryViewProps {
  /** Optional click handler — when provided, rows become navigable to the
   *  tool detail page. Wired by App.tsx from useAppState.navigateToToolDetail. */
  onOpenTool?: (appId: string, appName: string) => void;
}

export default function LibraryView({ onOpenTool }: LibraryViewProps = {}) {
  const [tab, setTab] = useState<'Library' | 'Shared'>('Library');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // Load current user id for owner classification
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

  // Fetch library on mount + when search query stabilizes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const handle = setTimeout(() => {
      fetchLibraryApps(query)
        .then((results) => {
          if (cancelled) return;
          setRows(results.map((r) => mapResultToRow(r, currentUserId)));
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setError(err.message);
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
        });
    }, query ? 200 : 0);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [query, currentUserId]);

  // Group rows for the Library tab
  const groups = useMemo(() => {
    const yours = rows.filter((r) => r.isOwned);
    const installed = rows.filter((r) => !r.isOwned);
    // Pinned + Running are deferred — no BE signal today.
    return { yours, installed, pinned: [] as LibraryRow[], running: [] as LibraryRow[] };
  }, [rows]);

  const subline =
    tab === 'Shared'
      ? 'Shared listing arrives in a follow-up batch.'
      : loading
        ? 'Loading library…'
        : error
          ? `Failed to load: ${error}`
          : `${rows.length} in library · ${groups.yours.length} yours · ${groups.installed.length} installed`;

  return (
    <div className="bg-ul-bg h-full overflow-auto">
      {/* Header */}
      <div className="px-8 pt-6 pb-0">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <h1 className="text-h2 text-ul-text tracking-tight">Tools</h1>
            <div className="text-caption text-ul-text-secondary mt-0.5">{subline}</div>
          </div>
          <div className="flex gap-1.5">
            {(['Library', 'Shared'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-micro font-mono uppercase tracking-wider px-3 py-1.5 rounded-sm border cursor-pointer transition-colors ${
                  tab === t
                    ? 'bg-ul-text text-white border-ul-text'
                    : 'bg-ul-bg text-ul-text-secondary border-ul-border hover:bg-ul-bg-hover'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Search + filter row */}
        <div className="flex gap-2 mb-2">
          <div className="flex-1 flex items-center gap-2 px-3.5 py-2.5 border border-ul-border rounded-pill bg-ul-bg-raised">
            <Search className="w-3.5 h-3.5 text-ul-text-muted flex-shrink-0" strokeWidth={1.5} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tab === 'Shared' ? 'Search shared tools…' : 'Search tools, fns, or descriptions…'}
              className="flex-1 border-none outline-none bg-transparent text-small text-ul-text"
              disabled={tab === 'Shared'}
            />
          </div>
          {/* Kind + sort dropdowns — UI-only in 3a; wired in a later batch. */}
          <button
            disabled
            className="px-3.5 py-2.5 border border-ul-border rounded-pill bg-ul-bg text-caption font-mono text-ul-text-secondary cursor-not-allowed opacity-60"
            title="Kind filter — coming soon"
          >
            kind ▾
          </button>
          <button
            disabled
            className="px-3.5 py-2.5 border border-ul-border rounded-pill bg-ul-bg text-caption font-mono text-ul-text-secondary cursor-not-allowed opacity-60"
            title="Sort — coming soon"
          >
            sort: recent ▾
          </button>
        </div>
      </div>

      {/* Column headers */}
      <div className="px-8">
        <div className="grid grid-cols-[40px_minmax(0,1fr)_70px_70px_70px] gap-4 px-3.5 py-2 border-b border-ul-border text-nano font-mono text-ul-text-muted uppercase tracking-widest">
          <div></div>
          <div></div>
          <div className="text-right">Fns</div>
          <div className="text-right">Calls</div>
          <div className="text-right">Last</div>
        </div>
      </div>

      {/* Body */}
      {tab === 'Library' && (
        <div className="px-[18px] pb-8">
          {loading && rows.length === 0 ? (
            <div className="px-3.5 py-6 text-caption text-ul-text-muted">Loading…</div>
          ) : error ? (
            <div className="px-3.5 py-6 text-caption text-ul-error">{error}</div>
          ) : rows.length === 0 ? (
            <div className="px-3.5 py-6 text-caption text-ul-text-muted">
              {query ? 'No tools match your search.' : 'No tools in your library yet.'}
            </div>
          ) : (
            <>
              {/* Running + Pinned sections render only when BE signal lands; see PR notes. */}
              {groups.yours.length > 0 && (
                <>
                  <SectionHeader title="Your tools" count={String(groups.yours.length)} />
                  {groups.yours.map((r) => (
                    <Row key={r.id} row={r} onOpen={onOpenTool ? () => onOpenTool(r.id, r.name) : undefined} />
                  ))}
                </>
              )}
              {groups.installed.length > 0 && (
                <>
                  <SectionHeader
                    title="Installed"
                    count={`${groups.installed.length} from others`}
                    action="Manage →"
                  />
                  {groups.installed.map((r) => (
                    <Row key={r.id} row={r} onOpen={onOpenTool ? () => onOpenTool(r.id, r.name) : undefined} />
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'Shared' && (
        <div className="px-8 py-12">
          <div className="text-caption text-ul-text-secondary">
            Shared tools listing arrives in a follow-up batch. For now, see your
            library above.
          </div>
        </div>
      )}
    </div>
  );
}
