import type { AgenticInterfaceAction } from '../../../../shared/contracts/agentic-interface.ts';
import type { AgenticInterfaceActionState } from './AgenticInterfaceHost';

export default function AgenticInterfaceActionBar({
  actions,
  actionStates,
  onAction,
}: {
  actions: AgenticInterfaceAction[];
  actionStates?: Record<string, AgenticInterfaceActionState>;
  onAction?: (action: AgenticInterfaceAction) => void;
}) {
  return (
    <div className="h-full border border-ul-border bg-ul-bg rounded-md p-3 flex items-center gap-2 overflow-x-auto">
      {actions.length === 0 ? (
        <span className="text-caption text-ul-text-muted">No verified actions.</span>
      ) : (
        actions.map((action) => {
          const write = action.mode === 'write';
          const state = actionStates?.[action.id];
          const running = state?.status === 'running';
          return (
            <div key={action.id} className="flex flex-col gap-1 min-w-0">
              <button
                type="button"
                onClick={() => onAction?.(action)}
                disabled={running}
                className={`px-3 py-2 rounded-md border text-caption font-mono whitespace-nowrap transition-colors disabled:opacity-60 disabled:cursor-wait ${
                  write
                    ? 'border-ul-error/25 text-ul-error bg-ul-error/5 hover:bg-ul-error/10'
                    : 'border-ul-border text-ul-text-secondary bg-ul-bg-raised hover:bg-ul-bg-hover'
                }`}
                title={action.description || action.expected_result || action.label}
              >
                {running ? 'Running...' : action.label}
                {write && !running && <span className="ml-2 text-nano uppercase">{action.confirmation || 'confirm'}</span>}
              </button>
              {state?.status === 'error' && state.error && (
                <span className="max-w-[220px] truncate text-nano text-ul-error">{state.error}</span>
              )}
              {state?.status === 'ok' && (
                <span className="text-nano text-ul-success">Done</span>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
