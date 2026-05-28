import { FolderOpen, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { AgenticInterfaceSummary } from '../../lib/api';

interface AgenticInterfaceLibraryProps {
  interfaces: AgenticInterfaceSummary[];
  loading?: boolean;
  saving?: boolean;
  activeKey?: string | null;
  hasCurrent?: boolean;
  error?: string | null;
  onSaveCurrent?: () => void;
  onOpen?: (interfaceKey: string) => void;
  onDelete?: (interfaceKey: string) => void;
  onRefresh?: () => void;
}

function formatCount(summary: AgenticInterfaceSummary): string {
  const components = summary.component_count === 1 ? '1 component' : `${summary.component_count} components`;
  const actions = summary.action_count === 1 ? '1 action' : `${summary.action_count} actions`;
  return `${components} / ${actions}`;
}

export default function AgenticInterfaceLibrary({
  interfaces,
  loading = false,
  saving = false,
  activeKey = null,
  hasCurrent = false,
  error = null,
  onSaveCurrent,
  onOpen,
  onDelete,
  onRefresh,
}: AgenticInterfaceLibraryProps) {
  if (!loading && interfaces.length === 0 && !hasCurrent && !error) {
    return null;
  }

  return (
    <section className="px-[22px] pt-1 pb-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-small font-semibold text-ul-text">Saved Interfaces</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSaveCurrent}
            disabled={!hasCurrent || saving}
            className="h-8 inline-flex items-center gap-1.5 rounded-md border border-ul-border bg-ul-bg px-3 text-caption font-mono text-ul-text-secondary hover:bg-ul-bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
            title="Save current generated interface"
          >
            <Save className="h-3.5 w-3.5" strokeWidth={1.6} />
            {saving ? 'Saving' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-ul-border bg-ul-bg text-ul-text-muted hover:bg-ul-bg-hover hover:text-ul-text disabled:opacity-45"
            title="Refresh saved interfaces"
            aria-label="Refresh saved interfaces"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-2 rounded-md border border-ul-warning/20 bg-ul-warning/10 px-3 py-2 text-caption text-ul-text-secondary">
          {error}
        </div>
      )}

      {interfaces.length > 0 && (
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {interfaces.map((item) => {
            const active = activeKey === item.interface_key;
            return (
              <article
                key={item.interface_key}
                className={`rounded-md border px-3 py-2 bg-ul-bg ${
                  active ? 'border-ul-info/40 ring-1 ring-ul-info/20' : 'border-ul-border'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onOpen?.(item.interface_key)}
                    className="min-w-0 flex-1 text-left group"
                    title={`Open ${item.title}`}
                  >
                    <div className="flex items-center gap-2">
                      <FolderOpen
                        className="h-3.5 w-3.5 text-ul-text-muted group-hover:text-ul-text"
                        strokeWidth={1.5}
                      />
                      <span className="truncate text-small font-semibold text-ul-text">
                        {item.title}
                      </span>
                    </div>
                    <div className="mt-1 text-caption text-ul-text-muted">
                      {formatCount(item)}
                    </div>
                    {item.description && (
                      <div className="mt-1 line-clamp-1 text-caption text-ul-text-secondary">
                        {item.description}
                      </div>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete?.(item.interface_key)}
                    className="h-7 w-7 shrink-0 rounded-md border border-ul-border text-ul-text-muted hover:text-ul-error hover:bg-ul-bg-hover inline-flex items-center justify-center"
                    title={`Delete ${item.title}`}
                    aria-label={`Delete ${item.title}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
