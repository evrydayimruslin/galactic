import { RefreshCw } from 'lucide-react';
import type { AgenticInterfaceListComponent } from '../../../../shared/contracts/agentic-interface.ts';

function rowsFromData(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const items = obj.items ?? obj.rows ?? obj.results;
    if (Array.isArray(items)) return rowsFromData(items);
  }
  return [];
}

function field(row: Record<string, unknown>, key?: string): string {
  if (!key) return '';
  const value = row[key];
  return value === undefined || value === null ? '' : String(value);
}

export default function AgenticInterfaceList({
  component,
  data,
  loading,
  error,
  onRefresh,
}: {
  component: AgenticInterfaceListComponent;
  data: unknown;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
}) {
  const rows = rowsFromData(data).slice(0, component.max_items ?? 8);
  return (
    <div className="h-full border border-ul-border bg-ul-bg rounded-md p-4 flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-small font-semibold text-ul-text truncate">{component.title || 'List'}</div>
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
              aria-label="Refresh list data"
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
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col gap-2">
        {rows.length === 0 ? (
          <div className="text-caption text-ul-text-muted">
            {loading ? 'Loading rows...' : 'No rows loaded yet.'}
          </div>
        ) : (
          rows.map((row, index) => (
            <div key={index} className="border-b border-ul-border last:border-b-0 pb-2 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-caption font-medium text-ul-text truncate">
                    {field(row, component.primary_field) || field(row, 'primary') || field(row, 'title') || `Item ${index + 1}`}
                  </div>
                  <div className="text-nano text-ul-text-muted truncate">
                    {field(row, component.secondary_field) || field(row, 'secondary') || field(row, 'subtitle')}
                  </div>
                </div>
                <div className="text-nano font-mono text-ul-text-muted flex-shrink-0">
                  {field(row, component.trailing_field) || field(row, 'trailing')}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
