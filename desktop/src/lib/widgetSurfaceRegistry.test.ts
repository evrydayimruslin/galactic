import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendWidgetSurfaceEvent,
  buildWidgetSurfaceCommandMessage,
  clearWidgetSurfaceRegistryForTests,
  dispatchWidgetSurfaceCommand,
  getActiveWidgetSurfaces,
  getWidgetSurface,
  handleWidgetBridgeMessage,
  invokeWidgetSurfaceAction,
  recordWidgetActionResult,
  registerWidgetSurface,
  subscribeWidgetSurfaceCommands,
  subscribeWidgetSurfaces,
  unregisterWidgetSurface,
  WIDGET_SURFACE_MAX_EVENTS,
} from './widgetSurfaceRegistry';
import {
  buildActiveWidgetContext,
  summarizeWidgetSurfaceEvents,
} from './widgetAgentTypes';
import type { WidgetAppSource } from './widgetRuntime';

function createLocalStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => {
      store.clear();
    }),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
  } as Storage;
}

const baseSource: WidgetAppSource = {
  appUuid: 'app-123',
  appSlug: 'email-ops',
  appName: 'Email Ops',
  appVersion: '5',
  widgetName: 'email_inbox',
  uiFunction: 'widget_email_inbox_ui',
  dataFunction: 'widget_email_inbox_data',
};

describe('widget surface registry', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageMock());
    vi.stubGlobal('BroadcastChannel', undefined);
    clearWidgetSurfaceRegistryForTests();
  });

  it('registers active widget surfaces and applies bridge updates', () => {
    registerWidgetSurface({
      surfaceId: 'surface-1',
      kind: 'inline',
      source: baseSource,
      context: { thread: 'abc' },
    });

    expect(getActiveWidgetSurfaces()).toHaveLength(1);
    expect(getWidgetSurface('surface-1')?.status).toBe('opening');

    expect(handleWidgetBridgeMessage({
      type: 'ul-widget-state',
      surfaceId: 'surface-1',
      snapshot: {
        surface_id: 'surface-1',
        widget_id: 'email_inbox',
        current_view: 'inbox',
        selected_entities: [{ type: 'conversation', id: 'c1' }],
      },
    })).toBe(true);

    expect(handleWidgetBridgeMessage({
      type: 'ul-widget-actions',
      actions: [{
        id: 'send_selected_draft',
        label: 'Send selected draft',
        mode: 'write',
        confirmation: 'user',
      }],
    }, 'surface-1')).toBe(true);

    expect(handleWidgetBridgeMessage({
      type: 'ul-widget-event',
      event: {
        kind: 'user',
        label: 'Opened conversation',
      },
    }, 'surface-1')).toBe(true);

    const surface = getWidgetSurface('surface-1');
    expect(surface?.snapshot?.current_view).toBe('inbox');
    expect(surface?.status).toBe('ready');
    expect(surface?.actions[0]?.id).toBe('send_selected_draft');
    expect(surface?.events[0]?.label).toBe('Opened conversation');
  });

  it('notifies subscribers and command listeners', () => {
    const surfaceCounts: number[] = [];
    const unsubscribeSurfaces = subscribeWidgetSurfaces((surfaces) => {
      surfaceCounts.push(surfaces.length);
    });

    registerWidgetSurface({
      surfaceId: 'surface-1',
      kind: 'window',
      source: baseSource,
    });

    const commands: string[] = [];
    const unsubscribeCommands = subscribeWidgetSurfaceCommands((command) => {
      commands.push(command.action_id);
    });

    dispatchWidgetSurfaceCommand({
      surface_id: 'surface-1',
      widget_id: 'email_inbox',
      action_id: 'refresh',
      source: 'agent',
    });

    unregisterWidgetSurface('surface-1');
    unsubscribeCommands();
    unsubscribeSurfaces();

    expect(surfaceCounts).toEqual([0, 1, 0]);
    expect(commands).toEqual(['refresh']);
  });

  it('builds parent-to-iframe widget command messages', () => {
    expect(buildWidgetSurfaceCommandMessage({
      surface_id: 'surface-1',
      widget_id: 'email_inbox',
      action_id: 'show_draft_editor',
      args: { focus: true },
      turn_id: 'turn-1',
      source: 'agent',
    })).toEqual({
      type: 'ul-widget-command',
      surface_id: 'surface-1',
      surfaceId: 'surface-1',
      widget_id: 'email_inbox',
      widgetId: 'email_inbox',
      action_id: 'show_draft_editor',
      actionId: 'show_draft_editor',
      args: { focus: true },
      turn_id: 'turn-1',
      turnId: 'turn-1',
      source: 'agent',
    });
  });

  it('awaits widget action results and records request/result events', async () => {
    registerWidgetSurface({
      surfaceId: 'surface-1',
      kind: 'window',
      source: baseSource,
    });

    const unsubscribeCommands = subscribeWidgetSurfaceCommands((command) => {
      recordWidgetActionResult(command.surface_id, {
        surface_id: command.surface_id,
        widget_id: command.widget_id,
        action_id: command.action_id,
        turn_id: command.turn_id,
        ok: true,
        data: { loaded: true },
        snapshot: {
          widget_id: command.widget_id,
          current_view: 'history',
        },
      });
    });

    const result = await invokeWidgetSurfaceAction({
      surface_id: 'surface-1',
      widget_id: 'email_inbox',
      action_id: 'load_selected_history',
      args: { conversation_id: 'c1' },
      source: 'agent',
    }, 1_000);

    unsubscribeCommands();

    expect(result.ok).toBe(true);
    expect(result.turn_id).toBeTruthy();
    expect(result.data).toEqual({ loaded: true });
    const surface = getWidgetSurface('surface-1');
    expect(surface?.snapshot?.current_view).toBe('history');
    expect(surface?.events.map((event) => event.action_id)).toEqual([
      'load_selected_history',
      'load_selected_history',
    ]);
    expect(surface?.events[0]?.input).toEqual({ conversation_id: 'c1' });
    expect(surface?.events[0]?.turn_id).toBe(result.turn_id);
    expect(surface?.events[0]?.surface_id).toBe('surface-1');
    expect(surface?.events[0]?.widget_id).toBe('email_inbox');
    expect(surface?.events[0]?.id).toBeTruthy();
    expect(surface?.events[1]?.turn_id).toBe(result.turn_id);
  });

  it('keeps a bounded event ring buffer and summarizes recent events', () => {
    registerWidgetSurface({
      surfaceId: 'surface-1',
      kind: 'window',
      source: baseSource,
    });

    for (let index = 0; index < WIDGET_SURFACE_MAX_EVENTS + 5; index += 1) {
      appendWidgetSurfaceEvent('surface-1', {
        kind: index % 2 === 0 ? 'agent' : 'user',
        action_id: `action-${index}`,
        label: `Event ${index}`,
      });
    }

    const surface = getWidgetSurface('surface-1');
    expect(surface?.events).toHaveLength(WIDGET_SURFACE_MAX_EVENTS);
    expect(surface?.events[0]?.label).toBe('Event 5');
    expect(surface?.events[(surface?.events.length || 1) - 1]?.label).toBe('Event 54');
    expect(surface?.events[0]?.surface_id).toBe('surface-1');
    expect(surface?.events[0]?.widget_id).toBe('email_inbox');
    expect(surface?.events[0]?.created_at).toBeTruthy();

    const summary = summarizeWidgetSurfaceEvents(surface?.events, 3);
    expect(summary).toContain('Event 52');
    expect(summary).toContain('Event 54');
    expect(summary).not.toContain('Event 51');

    const context = buildActiveWidgetContext(surface!);
    expect(context.recentEventCount).toBe(WIDGET_SURFACE_MAX_EVENTS);
    expect(context.recentEvents).toHaveLength(10);
    expect(context.recentEventSummary).toContain('Event 54');
  });
});
