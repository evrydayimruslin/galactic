import type {
  ActiveSurfaceType,
  ActiveWidgetContext,
  WidgetActionDeclaration,
  WidgetActionInvocation,
  WidgetActionResult,
  WidgetStateSnapshot,
  WidgetSurfaceKind,
  WidgetSurfaceEvent,
  WidgetSurfaceStatus,
} from '../../../shared/contracts/widget.ts';
import type {
  AgenticInterfaceAction,
  AgenticInterfaceSpec,
} from '../../../shared/contracts/agentic-interface.ts';
import type { WidgetAppSource, WidgetDataPayload } from './widgetRuntime';

export type { ActiveWidgetContext, WidgetSurfaceKind, WidgetSurfaceStatus };

export interface ActiveSurfaceBase {
  surfaceId: string;
  kind: WidgetSurfaceKind;
  surfaceType: ActiveSurfaceType;
  status: WidgetSurfaceStatus;
  snapshot: WidgetStateSnapshot | null;
  actions: WidgetActionDeclaration[];
  events: WidgetSurfaceEvent[];
  latestDataPayload?: WidgetDataPayload | null;
  registeredAt: number;
  updatedAt: number;
}

export interface ActiveWidgetSurface extends ActiveSurfaceBase {
  surfaceType: 'widget';
  source: WidgetAppSource;
  context?: Record<string, string>;
}

export interface GeneratedInterfaceSurfaceSource {
  id: string;
  title: string;
  description?: string;
  mode: AgenticInterfaceSpec['mode'];
}

export interface ActiveGeneratedInterfaceSurface extends ActiveSurfaceBase {
  surfaceType: 'generated_interface';
  kind: 'generated_interface';
  generatedInterface: GeneratedInterfaceSurfaceSource;
}

export type ActiveAgenticSurface =
  | ActiveWidgetSurface
  | ActiveGeneratedInterfaceSurface;

export interface RegisterWidgetSurfaceInput {
  surfaceId?: string;
  kind: WidgetSurfaceKind;
  source: WidgetAppSource;
  context?: Record<string, string>;
  latestDataPayload?: WidgetDataPayload | null;
}

export interface RegisterGeneratedInterfaceSurfaceInput {
  surfaceId?: string;
  spec: AgenticInterfaceSpec;
  status?: WidgetSurfaceStatus;
  snapshot?: WidgetStateSnapshot | null;
}

export type WidgetBridgeMessage =
  | {
    type: 'ul-widget-state';
    surfaceId?: string;
    surface_id?: string;
    snapshot?: WidgetStateSnapshot;
    state?: WidgetStateSnapshot;
  }
  | {
    type: 'ul-widget-actions';
    surfaceId?: string;
    surface_id?: string;
    actions?: WidgetActionDeclaration[];
  }
  | {
    type: 'ul-widget-event';
    surfaceId?: string;
    surface_id?: string;
    event?: WidgetSurfaceEvent;
  }
  | {
    type: 'ul-widget-action-result';
    surfaceId?: string;
    surface_id?: string;
    result?: WidgetActionResult;
  };

export type WidgetSurfaceCommand = WidgetActionInvocation;

export type WidgetSurfaceListener = (surfaces: ActiveWidgetSurface[]) => void;

export type AgenticSurfaceListener = (surfaces: ActiveAgenticSurface[]) => void;

export type WidgetSurfaceCommandListener = (command: WidgetSurfaceCommand) => void;

const MAX_EVENT_SUMMARY_ITEMS = 6;

function oneLine(value: unknown, maxChars = 120): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const normalized = (text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > maxChars
    ? `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
    : normalized;
}

function summarizeWidgetSurfaceEvent(event: WidgetSurfaceEvent): string {
  const parts: string[] = [event.kind];
  if (event.action_id) parts.push(`action=${oneLine(event.action_id, 60)}`);
  if (event.label) parts.push(oneLine(event.label, 100));
  if (event.error) parts.push(`error=${oneLine(event.error, 100)}`);
  if (event.result !== undefined && event.error === undefined) {
    parts.push(`result=${oneLine(event.result, 120)}`);
  }
  return parts.join(' - ');
}

export function isWidgetSurface(surface: ActiveAgenticSurface): surface is ActiveWidgetSurface {
  return surface.surfaceType === 'widget';
}

export function isGeneratedInterfaceSurface(
  surface: ActiveAgenticSurface,
): surface is ActiveGeneratedInterfaceSurface {
  return surface.surfaceType === 'generated_interface';
}

export function agenticInterfaceActionsToWidgetActions(
  actions: AgenticInterfaceAction[] | undefined,
): WidgetActionDeclaration[] {
  return (actions || []).map((action) => {
    const declaration: WidgetActionDeclaration = {
      id: action.id,
      label: action.label,
      description: action.description,
      mode: action.mode,
      confirmation: action.confirmation,
      args_schema: action.args_schema,
      expected_result: action.expected_result,
    };
    if (action.kind === 'mcp_function') {
      declaration.mcp = {
        function: action.function_name,
        args_template: action.args_template,
      };
    } else if (action.kind === 'open_widget') {
      declaration.ui = {
        command: 'open_widget',
        component_id: action.widget_id,
        args_template: action.context,
      };
    } else if (action.kind === 'widget_action') {
      declaration.ui = {
        command: action.action_id,
        component_id: action.surface_id || action.widget_id,
        args_template: action.args_template,
      };
    } else if (action.kind === 'refresh_binding') {
      declaration.ui = {
        command: 'refresh_binding',
        args_template: { binding_ids: action.binding_ids },
      };
    } else if (action.kind === 'select_entity') {
      declaration.ui = {
        command: 'select_entity',
        component_id: action.component_id,
        args_template: action.args_template,
      };
    }
    return declaration;
  });
}

export function summarizeWidgetSurfaceEvents(
  events: WidgetSurfaceEvent[] | undefined,
  maxItems = MAX_EVENT_SUMMARY_ITEMS,
): string {
  const recentEvents = Array.isArray(events)
    ? events.slice(-Math.max(1, maxItems))
    : [];
  if (recentEvents.length === 0) return '';
  return recentEvents.map(summarizeWidgetSurfaceEvent).join('\n');
}

export function buildActiveWidgetContext(surface: ActiveWidgetSurface): ActiveWidgetContext {
  const recentEvents = surface.events.slice(-10);
  return {
    surfaceId: surface.surfaceId,
    surfaceType: 'widget',
    kind: surface.kind,
    appId: surface.source.appUuid,
    appSlug: surface.source.appSlug,
    appName: surface.source.appName,
    widgetId: surface.source.widgetName,
    widgetName: surface.source.widgetName,
    title: surface.snapshot?.title || surface.source.appName,
    context: surface.context,
    status: surface.status,
    snapshot: surface.snapshot,
    actions: surface.actions,
    recentEvents,
    recentEventSummary: summarizeWidgetSurfaceEvents(surface.events),
    recentEventCount: surface.events.length,
    latestDataPayload: surface.latestDataPayload?.raw ?? null,
    updatedAt: surface.updatedAt,
  };
}

export function buildActiveAgenticSurfaceContext(
  surface: ActiveAgenticSurface,
): ActiveWidgetContext {
  if (isWidgetSurface(surface)) return buildActiveWidgetContext(surface);

  const recentEvents = surface.events.slice(-10);
  return {
    surfaceId: surface.surfaceId,
    surfaceType: 'generated_interface',
    kind: 'generated_interface',
    appId: 'generated-interface',
    appSlug: 'generated-interface',
    appName: 'Generated Interface',
    widgetId: surface.generatedInterface.id,
    widgetName: surface.generatedInterface.title,
    interfaceId: surface.generatedInterface.id,
    interfaceTitle: surface.generatedInterface.title,
    interfaceMode: surface.generatedInterface.mode,
    title: surface.snapshot?.title || surface.generatedInterface.title,
    status: surface.status,
    snapshot: surface.snapshot,
    actions: surface.actions,
    recentEvents,
    recentEventSummary: summarizeWidgetSurfaceEvents(surface.events),
    recentEventCount: surface.events.length,
    latestDataPayload: surface.latestDataPayload?.raw ?? null,
    updatedAt: surface.updatedAt,
  };
}
