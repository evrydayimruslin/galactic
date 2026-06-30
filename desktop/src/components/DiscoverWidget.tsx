import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { fetchFromApi, getToken } from '../lib/storage';
import type {
  AmbientMarketplaceSummary,
  AmbientSuggestion,
  AmbientTrustCard,
} from '../types/ambientSuggestion';

type DiscoverResult = AmbientSuggestion;
const GPU_SUPPORT_ENABLED = import.meta.env.VITE_UL_GPU_SUPPORT_ENABLED === 'true';

export type DiscoverWidgetMode =
  | { kind: 'inline'; query?: string }
  | { kind: 'ambient'; suggestions: AmbientSuggestion[] };

interface DiscoverWidgetProps {
  mode: DiscoverWidgetMode;
  onInjectScope: (apps: Array<{ id: string; slug: string; name: string; access: string }>) => void;
  onAcceptSuggestions?: (suggestions: AmbientSuggestion[]) => void;
  onDismissSuggestion?: (suggestion: AmbientSuggestion) => void;
}

function asTrustCard(value: unknown): AmbientTrustCard | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as AmbientTrustCard;
}

function asMarketplaceSummary(value: unknown): AmbientMarketplaceSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AmbientMarketplaceSummary;
}

function trustCapabilityLabels(trust?: AmbientTrustCard): string[] {
  const summary = trust?.capability_summary || {};
  return [
    summary.ai ? 'AI' : '',
    summary.network ? 'Network' : '',
    summary.storage ? 'Storage' : '',
    summary.memory ? 'Memory' : '',
    GPU_SUPPORT_ENABLED && summary.gpu ? 'GPU' : '',
  ].filter(Boolean);
}

function formatLightAmount(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M Light`;
  if (abs >= 5_000) return `${sign}${(abs / 1_000).toFixed(1)}K Light`;
  if (Number.isInteger(abs)) return `${sign}${abs} Light`;
  return `${sign}${abs.toFixed(2)} Light`;
}

function suggestionAppSlug(result: DiscoverResult): string {
  if (result.target?.kind === 'app' && result.target.appSlug) return result.target.appSlug;
  return result.app_slug || result.slug || result.id;
}

async function searchDiscoverResults(query: string): Promise<DiscoverResult[]> {
  const token = getToken();
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [libraryRes, marketRes] = await Promise.all([
    fetchFromApi('/mcp/platform', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: '1', method: 'tools/call',
        params: { name: 'ul.discover', arguments: { scope: 'library', query } },
      }),
    }),
    fetchFromApi('/mcp/platform', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: '2', method: 'tools/call',
        params: { name: 'ul.discover', arguments: { scope: 'appstore', query, limit: 10 } },
      }),
    }),
  ]);

  const unified: DiscoverResult[] = [];
  const seen = new Set<string>();

  try {
    const libData = await libraryRes.json();
    const libText = libData.result?.content?.[0]?.text;
    if (libText) {
      const parsed = JSON.parse(libText);
      const libResults = parsed.results || parsed.library_results || [];
      for (const result of libResults) {
        if (!result.id || seen.has(result.id)) continue;
        seen.add(result.id);
        unified.push({
          id: result.id,
          name: result.name,
          slug: result.slug,
          description: result.description || '',
          type: result.app_type === 'skill' ? 'skill' : 'app',
          runtime: result.runtime,
          source: 'library',
          connected: true,
          icon_url: result.icon_url || null,
          trust_card: asTrustCard(result.trust_card),
          marketplace: asMarketplaceSummary(result.marketplace),
        });
      }
    }
  } catch {
    // Continue with marketplace results.
  }

  try {
    const marketData = await marketRes.json();
    const marketText = marketData.result?.content?.[0]?.text;
    if (marketText) {
      const parsed = JSON.parse(marketText);
      for (const result of (parsed.results || [])) {
        if (!result.id || seen.has(result.id)) continue;
        seen.add(result.id);
        unified.push({
          id: result.id,
          name: result.name,
          slug: result.slug,
          description: result.description || '',
          type: result.app_type === 'skill' ? 'skill' : 'app',
          runtime: result.runtime,
          source: result.connected ? 'library' : 'marketplace',
          connected: !!result.connected,
          icon_url: result.icon_url || null,
          trust_card: asTrustCard(result.trust_card),
          marketplace: asMarketplaceSummary(result.marketplace),
        });
      }
    }
  } catch {
    // Surface what we have.
  }

  return unified;
}

export default function DiscoverWidget({
  mode,
  onInjectScope,
  onAcceptSuggestions,
  onDismissSuggestion,
}: DiscoverWidgetProps) {
  const inlineQuery = mode.kind === 'inline' ? mode.query || '' : '';
  const ambientSeed = mode.kind === 'ambient' ? mode.suggestions : [];
  const [query, setQuery] = useState(inlineQuery);
  const [results, setResults] = useState<DiscoverResult[]>(ambientSeed);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState(false);
  const [searched, setSearched] = useState(mode.kind === 'ambient' && ambientSeed.length > 0);

  const title = useMemo(
    () => mode.kind === 'ambient' ? 'Suggested tools for this conversation' : 'Find the right tools',
    [mode.kind],
  );

  const search = useCallback(async (nextQuery: string) => {
    if (!nextQuery.trim()) return;
    setLoading(true);
    setSearched(true);

    try {
      setResults(await searchDiscoverResults(nextQuery));
    } catch (err) {
      console.error('[DiscoverWidget] Search failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setAdded(false);
    setSelected(new Set());
    if (mode.kind === 'ambient') {
      setQuery('');
      setResults(ambientSeed);
      setSearched(ambientSeed.length > 0);
      return;
    }

    setQuery(inlineQuery);
    if (inlineQuery) {
      void search(inlineQuery);
    } else {
      setResults([]);
      setSearched(false);
    }
  }, [mode.kind, ambientSeed, inlineQuery, search]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAdd = () => {
    const apps = results
      .filter((result) => selected.has(result.id) && result.type === 'app')
      .map((result) => ({ id: result.id, slug: suggestionAppSlug(result), name: result.name, access: 'all' }));
    if (apps.length === 0) return;

    if (mode.kind === 'ambient') {
      onAcceptSuggestions?.(
        results.filter((result) => selected.has(result.id) && result.type === 'app'),
      );
    }
    onInjectScope(apps);
    setAdded(true);
  };

  const dismissAmbientSuggestion = (result: DiscoverResult) => {
    onDismissSuggestion?.(result);
    setResults((prev) => prev.filter((entry) => entry.id !== result.id));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(result.id);
      return next;
    });
  };

  const renderTrustSummary = (result: DiscoverResult) => {
    if (result.type !== 'app' || !result.trust_card) return null;
    const labels = trustCapabilityLabels(result.trust_card);
    const accessText = labels.length > 0 ? labels.slice(0, 3).join(', ') : 'No broad access';
    const extra = labels.length > 3 ? ` +${labels.length - 3}` : '';
    const signed = !!result.trust_card.signed_manifest;

    return (
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
          signed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
        }`}>
          {signed ? 'Source signed' : 'Legacy'}
        </span>
        <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
          {accessText}{extra}
        </span>
        {result.trust_card.execution_receipts?.enabled && (
          <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
            Receipts
          </span>
        )}
      </div>
    );
  };

  const renderMarketplaceSummary = (result: DiscoverResult) => {
    const marketplace = result.marketplace;
    if (result.type !== 'app' || !marketplace) return null;

    const hasAsk = typeof marketplace.ask_price_light === 'number'
      && Number.isFinite(marketplace.ask_price_light);
    const hasBid = typeof marketplace.highest_bid_light === 'number'
      && Number.isFinite(marketplace.highest_bid_light);

    let label = '';
    let tone = 'bg-gray-100 text-gray-600';

    if (marketplace.status === 'sold') {
      label = 'Acquired';
    } else if (marketplace.status === 'ineligible') {
      label = 'Not tradable';
      tone = 'bg-red-50 text-red-700';
    } else if (hasAsk) {
      label = marketplace.instant_buy
        ? `Acquire ${formatLightAmount(marketplace.ask_price_light!)}`
        : `Listed ${formatLightAmount(marketplace.ask_price_light!)}`;
      tone = marketplace.instant_buy
        ? 'bg-emerald-100 text-emerald-700'
        : 'bg-gray-100 text-gray-700';
    } else if (hasBid) {
      label = `Top bid ${formatLightAmount(marketplace.highest_bid_light!)}`;
    } else if (marketplace.status === 'open_to_offers') {
      label = 'Open to offers';
    }

    if (!label) return null;

    return (
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
        {label}
      </span>
    );
  };

  if (added) {
    return (
      <div className="rounded-xl border border-ul-border bg-ul-bg-raised p-5 text-center">
        <div className="mb-2 text-lg">&#10003;</div>
        <p className="text-small font-medium text-ul-text">
          {selected.size} tool{selected.size !== 1 ? 's' : ''} added to this conversation
        </p>
        <p className="mt-1 text-caption text-ul-text-muted">
          They&apos;ll be available on your next message.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-ul-border bg-white overflow-hidden shadow-sm">
      <div className="border-b border-ul-border px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <p className="text-small font-medium text-ul-text">{title}</p>
            <p className="text-caption text-ul-text-muted">
              {mode.kind === 'ambient'
                ? 'Fresh marketplace matches from the current conversation.'
                : 'Search your library and the marketplace together.'}
            </p>
          </div>
          {mode.kind === 'ambient' && results.length > 0 && (
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
              {results.length} suggestion{results.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search(query)}
            placeholder={mode.kind === 'ambient' ? 'Search more tools...' : 'Search tools and skills...'}
            className="input flex-1"
          />
          <button
            onClick={() => void search(query)}
            disabled={loading || !query.trim()}
            className="btn btn-primary btn-sm"
          >
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>
      </div>

      {results.length > 0 && (
        <div className="max-h-[320px] overflow-y-auto">
          {results.map((result) => (
            <button
              key={result.id}
              onClick={() => toggleSelect(result.id)}
              className={`w-full border-b border-ul-border px-4 py-3 text-left transition-colors last:border-b-0 ${
                selected.has(result.id) ? 'bg-emerald-50' : 'hover:bg-ul-bg-raised'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                  selected.has(result.id) ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300'
                }`}>
                  {selected.has(result.id) && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M2 5L4 7L8 3" />
                    </svg>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-small font-medium text-ul-text">{result.name}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      result.source === 'library'
                        ? 'bg-emerald-100 text-emerald-700'
                        : result.source === 'shared'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-600'
                    }`}>
                      {result.source === 'library' ? 'Installed' : result.source === 'shared' ? 'Shared' : 'Marketplace'}
                    </span>
                    {result.type === 'skill' && (
                      <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
                        Skill
                      </span>
                    )}
                    {GPU_SUPPORT_ENABLED && result.runtime === 'gpu' && (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        GPU
                      </span>
                    )}
                    {renderMarketplaceSummary(result)}
                  </div>

                  <p className="mt-0.5 truncate text-caption font-normal text-ul-text-muted">
                    {result.description}
                  </p>
                  {renderTrustSummary(result)}
                </div>

                {mode.kind === 'ambient' && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      dismissAmbientSuggestion(result);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      e.stopPropagation();
                      dismissAmbientSuggestion(result);
                    }}
                    className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded border border-transparent text-ul-text-muted hover:border-ul-border hover:bg-white hover:text-ul-text"
                    aria-label={`Dismiss ${result.name}`}
                    title="Dismiss suggestion"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={1.6} />
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {searched && !loading && results.length === 0 && (
        <div className="p-6 text-center text-small text-ul-text-muted">
          {mode.kind === 'ambient'
            ? 'Suggestions will appear here when Flash finds marketplace matches.'
            : 'No tools found. Try a different search.'}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex items-center justify-between border-t border-ul-border bg-ul-bg-raised p-3">
          <span className="text-caption text-ul-text-secondary">{selected.size} selected</span>
          <button onClick={handleAdd} className="btn btn-primary btn-sm">
            Add to conversation
          </button>
        </div>
      )}
    </div>
  );
}
