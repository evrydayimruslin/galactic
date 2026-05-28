import { RefreshCw } from 'lucide-react';
import type { AgenticInterfaceTableComponent } from '../../../../shared/contracts/agentic-interface.ts';

function rowsFromData(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const rows = obj.rows ?? obj.items ?? obj.results;
    if (Array.isArray(rows)) return rowsFromData(rows);
  }
  return [];
}

function inferColumns(rows: Array<Record<string, unknown>>) {
  const first = rows[0] || {};
  return Object.keys(first).slice(0, 5).map((key) => ({ id: key, label: key.replace(/_/g, ' '), field: key }));
}

function cell(row: Record<string, unknown>, field?: string): string {
  if (!field) return '';
  const value = row[field];
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export default function AgenticInterfaceTable({
  component,
  data,
  loading,
  error,
  onRefresh,
  selectedRowIndex,
  onSelectRow,
}: {
  component: AgenticInterfaceTableComponent;
  data: unknown;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  selectedRowIndex?: number | null;
  onSelectRow?: (row: Record<string, unknown>, index: number) => void;
}) {
  const rows = rowsFromData(data).slice(0, 8);
  const columns = component.columns?.length ? component.columns : inferColumns(rows);

  return (
    <div className="h-full border border-ul-border bg-ul-bg rounded-md overflow-hidden flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-ul-border flex items-center justify-between gap-3">
        <div className="text-small font-semibold text-ul-text truncate">{component.title || 'Table'}</div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="text-nano font-mono text-ul-text-muted">
            {loading ? 'loading' : `${rows.length} rows`}
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={() => onRefresh()}
              disabled={loading}
              className="h-6 w-6 rounded-xs border border-ul-border bg-ul-bg hover:bg-ul-bg-hover disabled:opacity-50 disabled:cursor-wait flex items-center justify-center text-ul-text-muted hover:text-ul-text transition-colors"
              aria-label="Refresh table data"
              title="Refresh data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.6} />
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="px-4 py-2 border-b border-ul-border text-nano text-ul-error truncate">
          {error}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="p-4 text-caption text-ul-text-muted">
            {loading ? 'Loading rows...' : 'No table data loaded yet.'}
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="bg-ul-bg-subtle sticky top-0">
              <tr>
                {columns.map((column) => (
                  <th key={column.id} className="px-3 py-2 text-nano font-mono uppercase tracking-widest text-ul-text-muted border-b border-ul-border">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => {
                const selected = selectedRowIndex === rowIndex;
                return (
                  <tr
                    key={rowIndex}
                    tabIndex={component.selectable === false ? undefined : 0}
                    onClick={() => component.selectable !== false && onSelectRow?.(row, rowIndex)}
                    onKeyDown={(event) => {
                      if (component.selectable === false) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelectRow?.(row, rowIndex);
                      }
                    }}
                    className={component.selectable === false
                      ? ''
                      : `cursor-pointer focus:outline-none focus:bg-ul-bg-active ${selected ? 'bg-ul-bg-active' : 'hover:bg-ul-bg-hover'}`}
                  >
                    {columns.map((column) => (
                      <td key={column.id} className="px-3 py-2 text-caption text-ul-text-secondary border-b border-ul-border max-w-[180px] truncate">
                        {cell(row, column.field || column.id)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
