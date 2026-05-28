import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import type {
  AgenticInterfaceSpec,
} from '../../../../shared/contracts/agentic-interface.ts';
import type {
  WidgetStateSnapshot,
  WidgetSurfaceEvent,
} from '../../../../shared/contracts/widget.ts';
import type { AgenticInterfacePlannerResult } from '../../lib/api';
import {
  appendGeneratedInterfaceSurfaceEvent,
  createGeneratedInterfaceSurfaceId,
  registerGeneratedInterfaceSurface,
  unregisterAgenticSurface,
  updateGeneratedInterfaceSurfaceSnapshot,
} from '../../lib/widgetSurfaceRegistry';
import AgenticInterfaceHost, {
  type AgenticInterfaceActionHandler,
  type AgenticOpenWidgetRequest,
} from './AgenticInterfaceHost';
import { useAgenticInterfaceData } from './useAgenticInterfaceData';

export default function GeneratedInterface({
  result,
  onAction,
  onOpenWidget,
}: {
  result: AgenticInterfacePlannerResult;
  onAction?: AgenticInterfaceActionHandler;
  onOpenWidget?: (request: AgenticOpenWidgetRequest) => void;
}) {
  const spec: AgenticInterfaceSpec = result.normalized_spec;
  const data = useAgenticInterfaceData(spec);
  const issueCount = result.warnings.length + result.dropped.length + data.errors.length;
  const surfaceId = useMemo(() => createGeneratedInterfaceSurfaceId(spec.id), [spec.id]);
  const surfaceErrors = useMemo(() => [
    ...result.warnings.map((warning) => `${warning.code}: ${warning.message}`),
    ...result.dropped.map((item) => `dropped ${item.kind}: ${item.reason}`),
    ...data.errors,
  ], [data.errors, result.dropped, result.warnings]);

  useEffect(() => {
    registerGeneratedInterfaceSurface({
      surfaceId,
      spec,
      status: 'ready',
    });
    return () => unregisterAgenticSurface(surfaceId);
  }, [spec, surfaceId]);

  const handleSnapshotChange = useCallback((snapshot: WidgetStateSnapshot) => {
    updateGeneratedInterfaceSurfaceSnapshot(surfaceId, snapshot);
  }, [surfaceId]);

  const handleSurfaceEvent = useCallback((event: WidgetSurfaceEvent) => {
    appendGeneratedInterfaceSurfaceEvent(surfaceId, event);
  }, [surfaceId]);

  return (
    <section className="px-[22px] pt-2 pb-3">
      <div className="border border-ul-border bg-ul-bg-raised rounded-md overflow-hidden">
        <div className="px-4 py-3 border-b border-ul-border flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-micro font-mono uppercase tracking-widest text-ul-text-muted mb-1">
              Generated interface
            </div>
            <h2 className="text-h3 text-ul-text tracking-tight truncate">{spec.title}</h2>
            {spec.description && (
              <p className="text-caption text-ul-text-secondary mt-1 line-clamp-2">
                {spec.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-nano font-mono uppercase tracking-wider text-ul-text-muted bg-ul-bg-active px-2 py-1 rounded-xs">
              {spec.mode}
            </span>
            <button
              type="button"
              onClick={() => void data.refreshAll()}
              disabled={data.isLoading}
              className="h-6 w-6 rounded-xs border border-ul-border bg-ul-bg hover:bg-ul-bg-hover disabled:opacity-50 disabled:cursor-wait flex items-center justify-center text-ul-text-muted hover:text-ul-text transition-colors"
              aria-label="Refresh interface data"
              title="Refresh data"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${data.isLoading ? 'animate-spin' : ''}`} strokeWidth={1.6} />
            </button>
            {issueCount > 0 && (
              <details className="relative">
                <summary className="list-none cursor-pointer text-nano font-mono uppercase tracking-wider text-ul-warning bg-ul-warning/10 border border-ul-warning/20 px-2 py-1 rounded-xs flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" strokeWidth={1.5} />
                  {issueCount}
                </summary>
                <div className="absolute right-0 mt-2 w-[320px] max-h-[240px] overflow-auto z-20 border border-ul-border bg-ul-bg rounded-md shadow-lg p-3">
                  {result.warnings.map((warning, index) => (
                    <div key={`warning-${index}`} className="text-caption text-ul-text-secondary mb-2 last:mb-0">
                      <span className="font-mono text-ul-text-muted">{warning.code}</span>
                      <span> / {warning.message}</span>
                    </div>
                  ))}
                  {result.dropped.map((item, index) => (
                    <div key={`dropped-${index}`} className="text-caption text-ul-text-secondary mb-2 last:mb-0">
                      <span className="font-mono text-ul-text-muted">dropped {item.kind}</span>
                      <span> / {item.reason}</span>
                    </div>
                  ))}
                  {data.errors.map((error, index) => (
                    <div key={`data-error-${index}`} className="text-caption text-ul-error mb-2 last:mb-0">
                      {error}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
        <div className="p-4">
          <AgenticInterfaceHost
            spec={spec}
            surfaceId={surfaceId}
            surfaceErrors={surfaceErrors}
            bindingValues={data.dataByBindingId}
            bindingStates={data.bindings}
            onAction={onAction}
            onOpenWidget={onOpenWidget}
            onRefreshAll={data.refreshAll}
            onRefreshBinding={data.refreshBinding}
            onSnapshotChange={handleSnapshotChange}
            onSurfaceEvent={handleSurfaceEvent}
          />
        </div>
      </div>
    </section>
  );
}
