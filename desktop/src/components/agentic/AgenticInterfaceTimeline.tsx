import { RefreshCw } from 'lucide-react';
import type { AgenticInterfaceTimelineComponent } from '../../../../shared/contracts/agentic-interface.ts';

function rowsFromData(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const rows = obj.items ?? obj.events ?? obj.rows;
    if (Array.isArray(rows)) return rowsFromData(rows);
  }
  return [];
}

function text(row: Record<string, unknown>, key?: string, fallback = ''): string {
  const value = key ? row[key] : undefined;
  return value === undefined || value === null ? fallback : String(value);
}

export default function AgenticInterfaceTimeline({
  component,
  data,
  loading,
  error,
  onRefresh,
}: {
  component: AgenticInterfaceTimelineComponent;
  data: unknown;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
}) {
  const rows = rowsFromData(data).slice(0, 8);
  return (
    <div className="h-full border border-ul-border bg-ul-bg rounded-md p-4 flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-small font-semibold text-ul-text truncate">{component.title || 'Timeline'}</div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="text-nano font-mono text-ul-text-muted">
            {loading ? 'loading' : rows.length}
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={() => onRefresh()}
              disabled={loading}
              className="h-6 w-6 rounded-xs border border-ul-border bg-ul-bg hover:bg-ul-bg-hover disabled:opacity-50 disabled:cursor-wait flex items-center justify-center text-ul-text-muted hover:text-ul-text transition-colors"
              aria-label="Refresh timeline data"
              title="Refresh data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.6} />
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="text-nano text-ul-error truncate mb-2">
          {error}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col gap-3">
        {rows.length === 0 ? (
          <div className="text-caption text-ul-text-muted">
            {loading ? 'Loading events...' : 'No timeline data loaded yet.'}
          </div>
        ) : rows.map((row, index) => (
          <div key={index} className="flex gap-3 min-w-0">
            <div className="w-2 h-2 rounded-full bg-ul-text-muted mt-1.5 flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-caption font-medium text-ul-text truncate">
                {text(row, component.title_field, text(row, 'title', `Event ${index + 1}`))}
              </div>
              <div className="text-nano text-ul-text-muted truncate">
                {text(row, component.time_field, text(row, 'time'))}
                {text(row, component.subtitle_field, text(row, 'subtitle')) && (
                  <span> / {text(row, component.subtitle_field, text(row, 'subtitle'))}</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
