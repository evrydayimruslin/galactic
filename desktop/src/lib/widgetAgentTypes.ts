import type {
  ActiveWidgetContext,
  WidgetActionDeclaration,
  WidgetActionInvocation,
  WidgetActionResult,
  WidgetStateSnapshot,
  WidgetSurfaceKind,
  WidgetSurfaceEvent,
  WidgetSurfaceStatus,
} from '../../../shared/contracts/widget.ts';
import type { WidgetAppSource, WidgetDataPayload } from './widgetRuntime';

export type { ActiveWidgetContext, WidgetSurfaceKind, WidgetSurfaceStatus };

export interface ActiveWidgetSurface {
  surfaceId: string;
  kind: WidgetSurfaceKind;
  source: WidgetAppSource;
  context?: Record<string, string>;
  status: WidgetSurfaceStatus;
  snapshot: WidgetStateSnapshot | null;
  actions: WidgetActionDeclaration[];
  events: WidgetSurfaceEvent[];
  latestDataPayload?: WidgetDataPayload | null;
  registeredAt: number;
  updatedAt: number;
}

export interface RegisterWidgetSurfaceInput {
  surfaceId?: string;
  kind: WidgetSurfaceKind;
  source: WidgetAppSource;
  context?: Record<string, string>;
  latestDataPayload?: WidgetDataPayload | null;
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
