import { RefreshCw } from 'lucide-react';
import type { AgenticInterfaceDetailComponent } from '../../../../shared/contracts/agentic-interface.ts';

function objectData(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) return data[0] && typeof data[0] === 'object' ? data[0] as Record<string, unknown> : {};
  if (data && typeof data === 'object') return data as Record<string, unknown>;
  return {};
}

function valueText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export default function AgenticInterfaceDetail({
  component,
  data,
  loading,
  error,
  onRefresh,
}: {
  component: AgenticInterfaceDetailComponent;
  data: unknown;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
}) {
  const row = objectData(data);
  const fields = component.fields?.length
    ? component.fields
    : Object.keys(row).slice(0, 8).map((key) => ({ id: key, label: key.replace(/_/g, ' ') }));

  return (
    <div className="h-full border border-ul-border bg-ul-bg rounded-md p-4 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-small font-semibold text-ul-text truncate">{component.title || 'Details'}</div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {loading && <div className="text-nano font-mono text-ul-text-muted">loading</div>}
          {onRefresh && (
            <button
              type="button"
              onClick={() => onRefresh()}
              disabled={loading}
              className="h-6 w-6 rounded-xs border border-ul-border bg-ul-bg hover:bg-ul-bg-hover disabled:opacity-50 disabled:cursor-wait flex items-center justify-center text-ul-text-muted hover:text-ul-text transition-colors"
              aria-label="Refresh detail data"
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
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        {fields.length === 0 ? (
          <div className="text-caption text-ul-text-muted col-span-2">
            {loading ? 'Loading details...' : 'No detail data loaded yet.'}
          </div>
        ) : (
          fields.map((field) => (
            <div key={field.id} className="min-w-0">
              <div className="text-nano font-mono uppercase tracking-widest text-ul-text-muted truncate">
                {field.label}
              </div>
              <div className="text-caption text-ul-text-secondary truncate">
                {valueText(row[field.id])}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
