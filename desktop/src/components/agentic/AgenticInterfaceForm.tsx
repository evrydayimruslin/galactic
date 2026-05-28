import { useMemo, useState } from 'react';
import type {
  AgenticInterfaceAction,
  AgenticInterfaceFormComponent,
} from '../../../../shared/contracts/agentic-interface.ts';
import type { AgenticInterfaceActionState } from './AgenticInterfaceHost';

export default function AgenticInterfaceForm({
  component,
  actions,
  actionStates,
  onAction,
  onValuesChange,
}: {
  component: AgenticInterfaceFormComponent;
  actions: AgenticInterfaceAction[];
  actionStates?: Record<string, AgenticInterfaceActionState>;
  onAction?: (action: AgenticInterfaceAction, args?: Record<string, unknown>) => void;
  onValuesChange?: (values: Record<string, string>) => void;
}) {
  const initial = useMemo(() => {
    const values: Record<string, string> = {};
    for (const field of component.fields) {
      values[field.id] = field.default_value === undefined ? '' : String(field.default_value);
    }
    return values;
  }, [component.fields]);
  const [values, setValues] = useState(initial);
  const submitAction = actions.find((action) => action.id === component.submit_action_id);
  const submitState = submitAction ? actionStates?.[submitAction.id] : undefined;
  const running = submitState?.status === 'running';

  const updateField = (fieldId: string, value: string) => {
    setValues((current) => {
      const next = { ...current, [fieldId]: value };
      onValuesChange?.(next);
      return next;
    });
  };

  return (
    <form
      className="h-full border border-ul-border bg-ul-bg rounded-md p-4 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitAction && !running) onAction?.(submitAction, values);
      }}
    >
      <div>
        <div className="text-small font-semibold text-ul-text truncate">{component.title || 'Form'}</div>
        {component.description && (
          <div className="text-caption text-ul-text-muted truncate mt-0.5">{component.description}</div>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-2">
        {component.fields.map((field) => (
          <label key={field.id} className="text-caption text-ul-text-secondary">
            <span className="block text-nano font-mono uppercase tracking-widest text-ul-text-muted mb-1">
              {field.label}
            </span>
            {field.type === 'textarea' ? (
              <textarea
                value={values[field.id] ?? ''}
                required={field.required}
                onChange={(event) => updateField(field.id, event.target.value)}
                className="w-full min-h-[70px] rounded-sm border border-ul-border bg-ul-bg-raised px-2.5 py-2 text-caption text-ul-text outline-none focus:border-ul-text resize-none"
              />
            ) : (
              <input
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'}
                value={values[field.id] ?? ''}
                required={field.required}
                onChange={(event) => updateField(field.id, event.target.value)}
                className="w-full h-9 rounded-sm border border-ul-border bg-ul-bg-raised px-2.5 text-caption text-ul-text outline-none focus:border-ul-text"
              />
            )}
          </label>
        ))}
      </div>
      <button
        type="submit"
        disabled={!submitAction || running}
        className="self-start px-3 py-2 rounded-md bg-ul-text text-white text-caption font-mono disabled:opacity-40 disabled:cursor-not-allowed hover:bg-ul-accent-hover"
      >
        {running ? 'Running...' : submitAction?.label || 'Submit'}
      </button>
      {submitState?.status === 'error' && submitState.error && (
        <div className="text-caption text-ul-error">{submitState.error}</div>
      )}
      {submitState?.status === 'ok' && (
        <div className="text-caption text-ul-success">Done</div>
      )}
    </form>
  );
}
