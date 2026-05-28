import { RefreshCw } from 'lucide-react';
import type { AgenticInterfaceMetricComponent } from '../../../../shared/contracts/agentic-interface.ts';

function readValue(data: unknown, key?: string): unknown {
  if (!key || !data || typeof data !== 'object') return data;
  return (data as Record<string, unknown>)[key];
}

export default function AgenticInterfaceMetric({
  component,
  data,
  loading,
  error,
  onRefresh,
}: {
  component: AgenticInterfaceMetricComponent;
  data: unknown;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
}) {
  const value = readValue(data, component.metric_field);
  const label = readValue(data, component.label_field);
  const displayValue = value === undefined || value === null
    ? '-'
    : typeof value === 'object'
    ? JSON.stringify(value)
    : String(value);
  const displayLabel = typeof label === 'string' && label.trim()
    ? label
    : component.description;

  return (
    <div className="h-full border border-ul-border bg-ul-bg rounded-md p-4 flex flex-col justify-between relative">
      {onRefresh && (
        <button
          type="button"
          onClick={() => onRefresh()}
          disabled={loading}
          className="absolute top-3 right-3 h-6 w-6 rounded-xs border border-ul-border bg-ul-bg hover:bg-ul-bg-hover disabled:opacity-50 disabled:cursor-wait flex items-center justify-center text-ul-text-muted hover:text-ul-text transition-colors"
          aria-label="Refresh metric data"
          title="Refresh data"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.6} />
        </button>
      )}
      <div className="text-display text-ul-text tabular-nums leading-none truncate pr-7">
        {displayValue}
        {component.suffix && (
          <span className="text-h3 text-ul-text-muted ml-1">{component.suffix}</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="text-caption text-ul-text-secondary truncate">
          {component.title || 'Metric'}
        </div>
        {displayLabel && (
          <div className="text-nano text-ul-text-muted truncate mt-1">
            {displayLabel}
          </div>
        )}
        {error && (
          <div className="text-nano text-ul-error truncate mt-1">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
