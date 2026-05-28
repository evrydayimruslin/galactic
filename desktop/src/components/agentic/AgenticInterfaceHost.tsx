import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  AgenticInterfaceAction,
  AgenticInterfaceComponent,
  AgenticInterfaceDataBinding,
  AgenticInterfaceField,
  AgenticInterfaceLayoutItem,
  AgenticInterfaceSpec,
} from '../../../../shared/contracts/agentic-interface.ts';
import type {
  WidgetDataRef,
  WidgetPendingEdit,
  WidgetStateSnapshot,
  WidgetSurfaceEvent,
  WidgetVisibleComponent,
} from '../../../../shared/contracts/widget.ts';
import type { AgenticInterfaceBindingData } from '../../lib/api';
import type { AgenticInterfaceActionExecutionContext } from '../../lib/api';
import AgenticInterfaceActionBar from './AgenticInterfaceActionBar';
import AgenticInterfaceCardRef from './AgenticInterfaceCardRef';
import AgenticInterfaceDetail from './AgenticInterfaceDetail';
import AgenticInterfaceForm from './AgenticInterfaceForm';
import AgenticInterfaceList from './AgenticInterfaceList';
import AgenticInterfaceMetric from './AgenticInterfaceMetric';
import AgenticInterfaceTable from './AgenticInterfaceTable';
import AgenticInterfaceTimeline from './AgenticInterfaceTimeline';
import AgenticInterfaceWidgetEmbed from './AgenticInterfaceWidgetEmbed';

export interface AgenticOpenWidgetRequest {
  appId: string;
  appSlug?: string;
  widgetId: string;
  context?: Record<string, string>;
}

export type AgenticInterfaceRenderBindingState = AgenticInterfaceBindingData & {
  loading?: boolean;
};

export type AgenticInterfaceActionRunStatus = 'idle' | 'running' | 'ok' | 'error' | 'cancelled';

export interface AgenticInterfaceActionState {
  status: AgenticInterfaceActionRunStatus;
  label?: string;
  error?: string;
  result?: unknown;
  turnId?: string;
  updatedAt?: string;
}

export type AgenticInterfaceActionHandler = (
  action: AgenticInterfaceAction,
  args: Record<string, unknown> | undefined,
  context: AgenticInterfaceActionExecutionContext,
) => unknown | Promise<unknown>;

export function requiresAgenticActionConfirmation(action: AgenticInterfaceAction): boolean {
  return action.mode === 'write' && action.confirmation !== 'none';
}

function bindingData(
  spec: AgenticInterfaceSpec,
  bindingId?: string,
  bindingValues?: Record<string, unknown>,
): unknown {
  if (!bindingId) return null;
  if (
    bindingValues &&
    Object.prototype.hasOwnProperty.call(bindingValues, bindingId)
  ) {
    return bindingValues[bindingId];
  }
  const binding = spec.data_bindings?.find((entry) => entry.id === bindingId);
  if (!binding) return null;
  if (binding.source === 'literal') return binding.value;
  return {
    binding: binding.label || binding.id,
    source: binding.source,
    status: 'pending_data_engine',
  };
}

function bindingDataRef(binding?: AgenticInterfaceDataBinding): WidgetDataRef | null {
  if (!binding) return null;
  const ref: WidgetDataRef = {
    type: binding.source,
    id: binding.id,
    label: binding.label || binding.id,
  };
  if (binding.source === 'context_source') {
    ref.table = binding.context_source_id;
  } else if (binding.source === 'literal') {
    ref.value = binding.value;
  } else if (binding.source === 'mcp_read_function') {
    ref.field = binding.function_name;
  } else if (binding.source === 'command_card') {
    ref.table = binding.card_id;
  }
  return ref;
}

function actionIdsForComponent(component: AgenticInterfaceComponent): string[] {
  const actionIds = [...(component.action_ids || [])];
  if (component.kind === 'form' && component.submit_action_id) {
    actionIds.push(component.submit_action_id);
  }
  return [...new Set(actionIds)];
}

function visibleComponentState(
  component: AgenticInterfaceComponent,
  selectedRows: Record<string, SelectedRow>,
  formValues: Record<string, Record<string, string>>,
  bindingStates?: Record<string, AgenticInterfaceRenderBindingState>,
  actionStates?: Record<string, AgenticInterfaceActionState>,
): Record<string, unknown> | undefined {
  const state: Record<string, unknown> = {};
  const selectedRow = selectedRows[component.id];
  if (selectedRow) state.selected_row_index = selectedRow.index;
  const bindingState = component.data_binding_id
    ? bindingStates?.[component.data_binding_id]
    : undefined;
  if (bindingState) {
    state.data_status = bindingState.loading ? 'loading' : bindingState.status;
    if (typeof bindingState.row_count === 'number') {
      state.row_count = bindingState.row_count;
    }
    if (bindingState.error) state.error = bindingState.error;
  }
  const componentActionStates: Record<string, string> = {};
  for (const actionId of actionIdsForComponent(component)) {
    const actionState = actionStates?.[actionId];
    if (actionState?.status && actionState.status !== 'idle') {
      componentActionStates[actionId] = actionState.status;
    }
  }
  if (Object.keys(componentActionStates).length > 0) {
    state.action_status = componentActionStates;
  }
  const values = formValues[component.id];
  if (values) {
    const dirtyFields = Object.entries(values)
      .filter(([, value]) => value.trim() !== '')
      .map(([fieldId]) => fieldId);
    if (dirtyFields.length > 0) state.dirty_fields = dirtyFields;
  }
  return Object.keys(state).length ? state : undefined;
}

function componentDataRefs(
  spec: AgenticInterfaceSpec,
  component: AgenticInterfaceComponent,
): WidgetDataRef[] {
  const refs = [...(component.data_refs || [])];
  const binding = spec.data_bindings?.find((entry) => entry.id === component.data_binding_id);
  const bindingRef = bindingDataRef(binding);
  if (bindingRef) refs.push(bindingRef);
  return refs;
}

function visibleComponents(
  spec: AgenticInterfaceSpec,
  selectedRows: Record<string, SelectedRow>,
  formValues: Record<string, Record<string, string>>,
  bindingStates?: Record<string, AgenticInterfaceRenderBindingState>,
  actionStates?: Record<string, AgenticInterfaceActionState>,
): WidgetVisibleComponent[] {
  return spec.components.map((component) => ({
    id: component.id,
    type: component.kind,
    label: component.title || component.id,
    purpose: component.description,
    data_refs: componentDataRefs(spec, component),
    actions: actionIdsForComponent(component),
    state: visibleComponentState(component, selectedRows, formValues, bindingStates, actionStates),
  }));
}

function visibleDataRefs(spec: AgenticInterfaceSpec): WidgetDataRef[] {
  const refs: WidgetDataRef[] = [];
  for (const binding of spec.data_bindings || []) {
    const ref = bindingDataRef(binding);
    if (ref) refs.push(ref);
  }
  for (const component of spec.components) {
    refs.push(...(component.data_refs || []));
  }
  return refs.slice(0, 40);
}

interface SelectedRow {
  index: number;
  row: Record<string, unknown>;
  componentTitle?: string;
}

function selectedEntities(selectedRows: Record<string, SelectedRow>): WidgetDataRef[] {
  return Object.entries(selectedRows).map(([componentId, selected]) => ({
    type: 'selected_row',
    id: `${componentId}:${selected.index}`,
    label: selected.componentTitle || componentId,
    value: selected.row,
  }));
}

function fieldById(fields: AgenticInterfaceField[], fieldId: string): AgenticInterfaceField | undefined {
  return fields.find((field) => field.id === fieldId);
}

function pendingEdits(
  spec: AgenticInterfaceSpec,
  formValues: Record<string, Record<string, string>>,
): WidgetPendingEdit[] {
  const edits: WidgetPendingEdit[] = [];
  for (const component of spec.components) {
    if (component.kind !== 'form') continue;
    const values = formValues[component.id];
    if (!values) continue;
    for (const [fieldId, value] of Object.entries(values)) {
      const field = fieldById(component.fields, fieldId);
      const defaultValue = field?.default_value === undefined ? '' : String(field.default_value);
      if (value === defaultValue || value.trim() === '') continue;
      edits.push({
        field: `${component.id}.${fieldId}`,
        label: field?.label || fieldId,
        value,
        dirty: true,
        entity: field?.data_ref,
      });
    }
  }
  return edits;
}

function layoutStyle(component: AgenticInterfaceComponent, index: number, item?: AgenticInterfaceLayoutItem): CSSProperties {
  const layout = item || component.layout;
  if (layout?.w || layout?.h) {
    return {
      gridColumn: `span ${Math.max(1, Math.min(4, layout.w || 2))}`,
      gridRow: `span ${Math.max(1, Math.min(4, layout.h || 1))}`,
    };
  }
  if (component.kind === 'metric') return { gridColumn: 'span 1', gridRow: 'span 1' };
  if (component.kind === 'action_bar') return { gridColumn: 'span 4', gridRow: 'span 1' };
  if (component.kind === 'widget_embed' || component.kind === 'table') {
    return { gridColumn: 'span 2', gridRow: 'span 2' };
  }
  return { gridColumn: `span ${index === 0 ? 2 : 2}`, gridRow: 'span 1' };
}

export default function AgenticInterfaceHost({
  spec,
  surfaceId,
  surfaceErrors,
  bindingValues,
  bindingStates,
  onAction,
  onOpenWidget,
  onRefreshAll,
  onRefreshBinding,
  onSnapshotChange,
  onSurfaceEvent,
}: {
  spec: AgenticInterfaceSpec;
  surfaceId?: string;
  surfaceErrors?: string[];
  bindingValues?: Record<string, unknown>;
  bindingStates?: Record<string, AgenticInterfaceRenderBindingState>;
  onAction?: AgenticInterfaceActionHandler;
  onOpenWidget?: (request: AgenticOpenWidgetRequest) => void;
  onRefreshAll?: () => void | Promise<void>;
  onRefreshBinding?: (bindingId: string) => void | Promise<void>;
  onSnapshotChange?: (snapshot: WidgetStateSnapshot) => void;
  onSurfaceEvent?: (event: WidgetSurfaceEvent) => void;
}) {
  const actionsById = useMemo(() => {
    const map = new Map<string, AgenticInterfaceAction>();
    for (const action of spec.actions || []) map.set(action.id, action);
    return map;
  }, [spec.actions]);
  const [selectedRows, setSelectedRows] = useState<Record<string, SelectedRow>>({});
  const [formValues, setFormValues] = useState<Record<string, Record<string, string>>>({});
  const [actionStates, setActionStates] = useState<Record<string, AgenticInterfaceActionState>>({});
  const layoutById = useMemo(() => {
    const map = new Map<string, AgenticInterfaceLayoutItem>();
    for (const item of spec.layout?.items || []) map.set(item.component_id, item);
    return map;
  }, [spec.layout?.items]);

  const enabledActionIds = useMemo(() => (spec.actions || []).map((action) => action.id), [spec.actions]);
  const snapshotErrors = useMemo(() => {
    const bindingErrors = Object.values(bindingStates || {})
      .filter((binding) => binding.error)
      .map((binding) => `${binding.label || binding.binding_id}: ${binding.error}`);
    const actionErrors = Object.entries(actionStates)
      .filter(([, state]) => state.status === 'error' && state.error)
      .map(([actionId, state]) => `${state.label || actionId}: ${state.error}`);
    return [...(surfaceErrors || []), ...bindingErrors, ...actionErrors];
  }, [actionStates, bindingStates, surfaceErrors]);

  const snapshot = useMemo<WidgetStateSnapshot>(() => ({
    surface_id: surfaceId,
    surface_type: 'generated_interface',
    widget_id: spec.id,
    interface_id: spec.id,
    interface_title: spec.title,
    title: spec.title,
    summary: spec.description || spec.intent,
    current_view: 'generated_interface',
    visible_components: visibleComponents(spec, selectedRows, formValues, bindingStates, actionStates),
    visible_data_refs: visibleDataRefs(spec),
    selected_entities: selectedEntities(selectedRows),
    pending_edits: pendingEdits(spec, formValues),
    enabled_actions: enabledActionIds,
    errors: snapshotErrors,
    updated_at: new Date().toISOString(),
  }), [
    bindingStates,
    actionStates,
    enabledActionIds,
    formValues,
    selectedRows,
    snapshotErrors,
    spec,
    surfaceId,
  ]);

  useEffect(() => {
    onSnapshotChange?.(snapshot);
  }, [onSnapshotChange, snapshot]);

  const setActionState = useCallback((action: AgenticInterfaceAction, state: AgenticInterfaceActionState) => {
    setActionStates((current) => ({
      ...current,
      [action.id]: {
        label: action.label,
        updatedAt: new Date().toISOString(),
        ...state,
      },
    }));
  }, []);

  const handleAction = useCallback(async (
    action: AgenticInterfaceAction,
    args?: Record<string, unknown>,
    componentId?: string,
  ) => {
    const turnId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${action.id}-${Date.now()}`;
    onSurfaceEvent?.({
      kind: action.kind === 'open_widget' ? 'navigation' : 'user',
      action_id: action.id,
      label: action.label,
      input: args,
      turn_id: turnId,
      created_at: new Date().toISOString(),
    });
    if (action.kind === 'open_widget') {
      onOpenWidget?.({
        appId: action.app_id,
        appSlug: action.app_slug,
        widgetId: action.widget_id,
        context: action.context,
      });
      setActionState(action, { status: 'ok', turnId, result: { widget_id: action.widget_id } });
      return;
    }
    if (action.kind === 'refresh_binding') {
      const ids = action.binding_ids || [];
      setActionState(action, { status: 'running', turnId });
      if (ids.length === 0) {
        await onRefreshAll?.();
      } else {
        for (const bindingId of ids) await onRefreshBinding?.(bindingId);
      }
      setActionState(action, { status: 'ok', turnId, result: { binding_ids: ids } });
      onSurfaceEvent?.({
        kind: 'system',
        action_id: action.id,
        label: action.label,
        result: { binding_ids: ids },
        turn_id: turnId,
        created_at: new Date().toISOString(),
      });
      return;
    }
    if (action.kind === 'select_entity') {
      setActionState(action, { status: 'ok', turnId, result: args || {} });
      onSurfaceEvent?.({
        kind: 'system',
        action_id: action.id,
        label: action.label,
        result: { component_id: action.component_id, args: args || {} },
        turn_id: turnId,
        created_at: new Date().toISOString(),
      });
      return;
    }
    const needsConfirmation = requiresAgenticActionConfirmation(action);
    if (needsConfirmation) {
      const label = action.confirmation === 'high_risk'
        ? `${action.label} is high-risk. Continue?`
        : `${action.label} will run a write action. Continue?`;
      const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(label)
        : false;
      if (!confirmed) {
        setActionState(action, { status: 'cancelled', turnId });
        onSurfaceEvent?.({
          kind: 'system',
          action_id: action.id,
          label: action.label,
          result: { cancelled: true },
          turn_id: turnId,
          created_at: new Date().toISOString(),
        });
        return;
      }
    }
    setActionState(action, { status: 'running', turnId });
    try {
      if (!onAction) {
        throw new Error('Generated interface action runner is not configured.');
      }
      const result = await onAction(action, args, {
        surfaceId,
        turnId,
        componentId,
        confirmed: needsConfirmation,
      });
      setActionState(action, { status: 'ok', turnId, result });
      onSurfaceEvent?.({
        kind: 'agent',
        action_id: action.id,
        label: action.label,
        result,
        turn_id: turnId,
        created_at: new Date().toISOString(),
      });
      if (action.kind === 'mcp_function' || action.kind === 'widget_action') {
        void onRefreshAll?.();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generated interface action failed.';
      setActionState(action, { status: 'error', error: message, turnId });
      onSurfaceEvent?.({
        kind: 'error',
        action_id: action.id,
        label: action.label,
        error: message,
        turn_id: turnId,
        created_at: new Date().toISOString(),
      });
    }
  }, [
    onAction,
    onOpenWidget,
    onRefreshAll,
    onRefreshBinding,
    onSurfaceEvent,
    setActionState,
    surfaceId,
  ]);

  const renderComponent = (component: AgenticInterfaceComponent, index: number) => {
    const data = bindingData(spec, component.data_binding_id, bindingValues);
    const bindingState = component.data_binding_id
      ? bindingStates?.[component.data_binding_id]
      : undefined;
    const refreshBinding = component.data_binding_id && onRefreshBinding
      ? () => onRefreshBinding(component.data_binding_id!)
      : undefined;
    const componentActions = (component.action_ids || [])
      .map((actionId) => actionsById.get(actionId))
      .filter((action): action is AgenticInterfaceAction => !!action);

    switch (component.kind) {
      case 'metric':
        return (
          <AgenticInterfaceMetric
            component={component}
            data={data}
            loading={bindingState?.loading}
            error={bindingState?.error}
            onRefresh={refreshBinding}
          />
        );
      case 'list':
        return (
          <AgenticInterfaceList
            component={component}
            data={data}
            loading={bindingState?.loading}
            error={bindingState?.error}
            onRefresh={refreshBinding}
          />
        );
      case 'table':
        return (
          <AgenticInterfaceTable
            component={component}
            data={data}
            loading={bindingState?.loading}
            error={bindingState?.error}
            onRefresh={refreshBinding}
            selectedRowIndex={selectedRows[component.id]?.index ?? null}
            onSelectRow={(row, rowIndex) => {
              setSelectedRows((current) => ({
                ...current,
                [component.id]: {
                  index: rowIndex,
                  row,
                  componentTitle: component.title,
                },
              }));
              onSurfaceEvent?.({
                kind: 'user',
                action_id: 'select_entity',
                label: `Selected ${component.title || component.id} row ${rowIndex + 1}`,
                result: { component_id: component.id, row_index: rowIndex, row },
                created_at: new Date().toISOString(),
              });
            }}
          />
        );
      case 'detail':
        return (
          <AgenticInterfaceDetail
            component={component}
            data={data}
            loading={bindingState?.loading}
            error={bindingState?.error}
            onRefresh={refreshBinding}
          />
        );
      case 'form':
        return (
          <AgenticInterfaceForm
            component={component}
            actions={spec.actions || []}
            actionStates={actionStates}
            onAction={(action, args) => void handleAction(action, args, component.id)}
            onValuesChange={(values) => {
              setFormValues((current) => ({ ...current, [component.id]: values }));
            }}
          />
        );
      case 'action_bar':
        return (
          <AgenticInterfaceActionBar
            actions={componentActions}
            actionStates={actionStates}
            onAction={(action) => void handleAction(action, undefined, component.id)}
          />
        );
      case 'timeline':
        return (
          <AgenticInterfaceTimeline
            component={component}
            data={data}
            loading={bindingState?.loading}
            error={bindingState?.error}
            onRefresh={refreshBinding}
          />
        );
      case 'card_ref':
        return <AgenticInterfaceCardRef component={component} onOpenWidget={onOpenWidget} />;
      case 'widget_embed':
        return <AgenticInterfaceWidgetEmbed component={component} onOpenWidget={onOpenWidget} />;
      case 'routine_panel':
        return (
          <div className="h-full border border-ul-border bg-ul-bg rounded-md p-4">
            <div className="text-small font-semibold text-ul-text">{component.title || 'Routine panel'}</div>
            <div className="text-caption text-ul-text-muted mt-1">Routine rendering lands in a later pass.</div>
          </div>
        );
      case 'text':
        return (
          <div className="h-full border border-ul-border bg-ul-bg rounded-md p-4">
            <div className="text-small font-semibold text-ul-text">{component.title || 'Note'}</div>
            <div className="text-caption text-ul-text-secondary mt-2 whitespace-pre-wrap">{component.text}</div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className="grid grid-cols-4 gap-3.5"
      style={{ gridAutoRows: '132px' }}
      data-agentic-interface-id={spec.id}
    >
      {spec.components.map((component, index) => (
        <div key={component.id} style={layoutStyle(component, index, layoutById.get(component.id))} className="min-w-0 min-h-0">
          {renderComponent(component, index)}
        </div>
      ))}
    </div>
  );
}
