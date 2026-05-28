import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendGeneratedInterfaceSurfaceEvent,
  appendWidgetSurfaceEvent,
  buildWidgetSurfaceCommandMessage,
  clearWidgetSurfaceRegistryForTests,
  dispatchWidgetSurfaceCommand,
  getActiveAgenticSurfaces,
  getActiveWidgetSurfaces,
  getGeneratedInterfaceSurface,
  getWidgetSurface,
  handleWidgetBridgeMessage,
  invokeWidgetSurfaceAction,
  recordWidgetActionResult,
  registerGeneratedInterfaceSurface,
  registerWidgetSurface,
  subscribeAgenticSurfaces,
  subscribeWidgetSurfaceCommands,
  subscribeWidgetSurfaces,
  unregisterWidgetSurface,
  updateGeneratedInterfaceSurfaceSnapshot,
  WIDGET_SURFACE_MAX_EVENTS,
} from "./widgetSurfaceRegistry";
import {
  buildActiveAgenticSurfaceContext,
  buildActiveWidgetContext,
  summarizeWidgetSurfaceEvents,
} from "./widgetAgentTypes";
import type { WidgetAppSource } from "./widgetRuntime";

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
  appUuid: "app-123",
  appSlug: "email-ops",
  appName: "Email Ops",
  appVersion: "5",
  widgetName: "email_inbox",
  uiFunction: "widget_email_inbox_ui",
  dataFunction: "widget_email_inbox_data",
};

describe("widget surface registry", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createLocalStorageMock());
    vi.stubGlobal("BroadcastChannel", undefined);
    clearWidgetSurfaceRegistryForTests();
  });

  it("registers active widget surfaces and applies bridge updates", () => {
    registerWidgetSurface({
      surfaceId: "surface-1",
      kind: "inline",
      source: baseSource,
      context: { thread: "abc" },
    });

    expect(getActiveWidgetSurfaces()).toHaveLength(1);
    expect(getWidgetSurface("surface-1")?.status).toBe("opening");

    expect(handleWidgetBridgeMessage({
      type: "ul-widget-state",
      surfaceId: "surface-1",
      snapshot: {
        surface_id: "surface-1",
        widget_id: "email_inbox",
        current_view: "inbox",
        selected_entities: [{ type: "conversation", id: "c1" }],
      },
    })).toBe(true);

    expect(handleWidgetBridgeMessage({
      type: "ul-widget-actions",
      actions: [{
        id: "send_selected_draft",
        label: "Send selected draft",
        mode: "write",
        confirmation: "user",
      }],
    }, "surface-1")).toBe(true);

    expect(handleWidgetBridgeMessage({
      type: "ul-widget-event",
      event: {
        kind: "user",
        label: "Opened conversation",
      },
    }, "surface-1")).toBe(true);

    const surface = getWidgetSurface("surface-1");
    expect(surface?.snapshot?.current_view).toBe("inbox");
    expect(surface?.status).toBe("ready");
    expect(surface?.actions[0]?.id).toBe("send_selected_draft");
    expect(surface?.events[0]?.label).toBe("Opened conversation");
  });

  it("registers generated interface surfaces beside widgets", () => {
    registerWidgetSurface({
      surfaceId: "surface-widget",
      kind: "window",
      source: baseSource,
    });

    registerGeneratedInterfaceSurface({
      surfaceId: "surface-generated",
      spec: {
        id: "approval_control_room",
        title: "Approval control room",
        mode: "temporary",
        components: [{
          id: "approvals-table",
          kind: "table",
          title: "Approvals",
          data_binding_id: "queue",
          action_ids: ["send_approval"],
        }],
        data_bindings: [{
          id: "queue",
          source: "literal",
          value: { items: [{ subject: "ACME budget" }] },
        }],
        actions: [{
          id: "send_approval",
          kind: "mcp_function",
          label: "Send approval",
          mode: "write",
          confirmation: "user",
          app_id: "app-email",
          function_name: "email_send_approval",
        }],
      },
    });

    expect(getActiveWidgetSurfaces().map((surface) => surface.surfaceId))
      .toEqual([
        "surface-widget",
      ]);
    expect(
      getActiveAgenticSurfaces().map((surface) => surface.surfaceId).sort(),
    ).toEqual([
      "surface-generated",
      "surface-widget",
    ]);

    const generated = getGeneratedInterfaceSurface("surface-generated");
    expect(generated?.surfaceType).toBe("generated_interface");
    expect(generated?.actions[0]?.mcp?.function).toBe("email_send_approval");

    const context = buildActiveAgenticSurfaceContext(generated!);
    expect(context.surfaceType).toBe("generated_interface");
    expect(context.interfaceId).toBe("approval_control_room");
    expect(context.actions?.[0]?.label).toBe("Send approval");
  });

  it("tracks generated interface snapshots, selected entities, edits, and events", () => {
    registerGeneratedInterfaceSurface({
      surfaceId: "surface-generated",
      spec: {
        id: "approval_control_room",
        title: "Approval control room",
        mode: "temporary",
        components: [],
      },
    });

    const generated = getGeneratedInterfaceSurface("surface-generated");
    expect(generated?.status).toBe("ready");

    appendGeneratedInterfaceSurfaceEvent("surface-generated", {
      kind: "user",
      action_id: "select_entity",
      label: "Selected approval row",
      result: { subject: "ACME budget" },
    });

    const updated = getGeneratedInterfaceSurface("surface-generated");
    expect(updated?.events[0]?.interface_id).toBe("approval_control_room");
    expect(updated?.events[0]?.widget_id).toBe("approval_control_room");

    const context = buildActiveAgenticSurfaceContext(updated!);
    expect(context.recentEventSummary).toContain("Selected approval row");
  });

  it("keeps generated interface active context fresh across refresh and action events", () => {
    registerGeneratedInterfaceSurface({
      surfaceId: "surface-generated",
      spec: {
        id: "approval_control_room",
        title: "Approval control room",
        mode: "temporary",
        data_bindings: [{
          id: "queue",
          source: "literal",
          value: { items: [{ id: "a1", subject: "Budget" }] },
        }],
        actions: [{
          id: "refresh_queue",
          kind: "refresh_binding",
          label: "Refresh queue",
          mode: "read",
          confirmation: "none",
          binding_ids: ["queue"],
        }, {
          id: "send_approval",
          kind: "mcp_function",
          label: "Send approval",
          mode: "write",
          confirmation: "user",
          app_id: "app-email",
          app_slug: "email-ops",
          function_name: "conversation_act",
        }],
        components: [{
          id: "queue_table",
          kind: "table",
          title: "Queue",
          data_binding_id: "queue",
          action_ids: ["refresh_queue", "send_approval"],
        }],
      },
    });

    updateGeneratedInterfaceSurfaceSnapshot("surface-generated", {
      surface_id: "surface-generated",
      surface_type: "generated_interface",
      widget_id: "approval_control_room",
      interface_id: "approval_control_room",
      interface_title: "Approval control room",
      current_view: "generated_interface",
      visible_components: [{
        id: "queue_table",
        type: "table",
        label: "Queue",
        actions: ["refresh_queue", "send_approval"],
        state: { row_count: 1 },
      }],
      enabled_actions: ["refresh_queue", "send_approval"],
      selected_entities: [{
        type: "selected_row",
        id: "queue_table:0",
        label: "Queue",
        value: { id: "a1" },
      }],
    });

    appendGeneratedInterfaceSurfaceEvent("surface-generated", {
      kind: "system",
      action_id: "refresh_queue",
      label: "Refresh queue",
      result: { binding_ids: ["queue"] },
      turn_id: "turn-refresh",
    });
    appendGeneratedInterfaceSurfaceEvent("surface-generated", {
      kind: "agent",
      action_id: "send_approval",
      label: "Send approval",
      result: { ok: true },
      turn_id: "turn-action",
    });

    const generated = getGeneratedInterfaceSurface("surface-generated");
    expect(generated?.snapshot?.visible_components?.[0]?.id).toBe(
      "queue_table",
    );
    expect(generated?.events.map((event) => event.action_id)).toEqual([
      "refresh_queue",
      "send_approval",
    ]);

    const context = buildActiveAgenticSurfaceContext(generated!);
    expect(context.surfaceType).toBe("generated_interface");
    expect(context.snapshot?.enabled_actions).toEqual([
      "refresh_queue",
      "send_approval",
    ]);
    expect(context.snapshot?.selected_entities?.[0]?.id).toBe("queue_table:0");
    expect(context.recentEventCount).toBe(2);
    expect(context.recentEventSummary).toContain("Refresh queue");
    expect(context.recentEventSummary).toContain("Send approval");
  });

  it("notifies subscribers and command listeners", () => {
    const surfaceCounts: number[] = [];
    const unsubscribeSurfaces = subscribeWidgetSurfaces((surfaces) => {
      surfaceCounts.push(surfaces.length);
    });

    registerWidgetSurface({
      surfaceId: "surface-1",
      kind: "window",
      source: baseSource,
    });

    const commands: string[] = [];
    const unsubscribeCommands = subscribeWidgetSurfaceCommands((command) => {
      commands.push(command.action_id);
    });

    dispatchWidgetSurfaceCommand({
      surface_id: "surface-1",
      widget_id: "email_inbox",
      action_id: "refresh",
      source: "agent",
    });

    unregisterWidgetSurface("surface-1");
    unsubscribeCommands();
    unsubscribeSurfaces();

    expect(surfaceCounts).toEqual([0, 1, 0]);
    expect(commands).toEqual(["refresh"]);
  });

  it("notifies agentic subscribers about generated interfaces without changing widget subscribers", () => {
    const widgetCounts: number[] = [];
    const agenticCounts: number[] = [];
    const unsubscribeWidgets = subscribeWidgetSurfaces((surfaces) => {
      widgetCounts.push(surfaces.length);
    });
    const unsubscribeAgentic = subscribeAgenticSurfaces((surfaces) => {
      agenticCounts.push(surfaces.length);
    });

    registerGeneratedInterfaceSurface({
      surfaceId: "surface-generated",
      spec: {
        id: "approval_control_room",
        title: "Approval control room",
        mode: "temporary",
        components: [],
      },
    });

    registerWidgetSurface({
      surfaceId: "surface-widget",
      kind: "window",
      source: baseSource,
    });

    unregisterWidgetSurface("surface-generated");
    unsubscribeAgentic();
    unsubscribeWidgets();

    expect(widgetCounts).toEqual([0, 0, 1, 1]);
    expect(agenticCounts).toEqual([0, 1, 2, 1]);
  });

  it("builds parent-to-iframe widget command messages", () => {
    expect(buildWidgetSurfaceCommandMessage({
      surface_id: "surface-1",
      widget_id: "email_inbox",
      action_id: "show_draft_editor",
      args: { focus: true },
      turn_id: "turn-1",
      source: "agent",
      agentic_surface_id: "surface-generated",
      agentic_interface_id: "email_interface",
      agentic_action_id: "send",
      agentic_component_id: "actions",
    })).toEqual({
      type: "ul-widget-command",
      surface_id: "surface-1",
      surfaceId: "surface-1",
      widget_id: "email_inbox",
      widgetId: "email_inbox",
      action_id: "show_draft_editor",
      actionId: "show_draft_editor",
      args: { focus: true },
      turn_id: "turn-1",
      turnId: "turn-1",
      source: "agent",
      agentic_surface_id: "surface-generated",
      agenticSurfaceId: "surface-generated",
      agentic_interface_id: "email_interface",
      agenticInterfaceId: "email_interface",
      agentic_action_id: "send",
      agenticActionId: "send",
      agentic_component_id: "actions",
      agenticComponentId: "actions",
    });
  });

  it("awaits widget action results and records request/result events", async () => {
    registerWidgetSurface({
      surfaceId: "surface-1",
      kind: "window",
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
          current_view: "history",
        },
      });
    });

    const result = await invokeWidgetSurfaceAction({
      surface_id: "surface-1",
      widget_id: "email_inbox",
      action_id: "load_selected_history",
      args: { conversation_id: "c1" },
      source: "agent",
    }, 1_000);

    unsubscribeCommands();

    expect(result.ok).toBe(true);
    expect(result.turn_id).toBeTruthy();
    expect(result.data).toEqual({ loaded: true });
    const surface = getWidgetSurface("surface-1");
    expect(surface?.snapshot?.current_view).toBe("history");
    expect(surface?.events.map((event) => event.action_id)).toEqual([
      "load_selected_history",
      "load_selected_history",
    ]);
    expect(surface?.events[0]?.input).toEqual({ conversation_id: "c1" });
    expect(surface?.events[0]?.turn_id).toBe(result.turn_id);
    expect(surface?.events[0]?.surface_id).toBe("surface-1");
    expect(surface?.events[0]?.widget_id).toBe("email_inbox");
    expect(surface?.events[0]?.id).toBeTruthy();
    expect(surface?.events[1]?.turn_id).toBe(result.turn_id);
  });

  it("keeps a bounded event ring buffer and summarizes recent events", () => {
    registerWidgetSurface({
      surfaceId: "surface-1",
      kind: "window",
      source: baseSource,
    });

    for (let index = 0; index < WIDGET_SURFACE_MAX_EVENTS + 5; index += 1) {
      appendWidgetSurfaceEvent("surface-1", {
        kind: index % 2 === 0 ? "agent" : "user",
        action_id: `action-${index}`,
        label: `Event ${index}`,
      });
    }

    const surface = getWidgetSurface("surface-1");
    expect(surface?.events).toHaveLength(WIDGET_SURFACE_MAX_EVENTS);
    expect(surface?.events[0]?.label).toBe("Event 5");
    expect(surface?.events[(surface?.events.length || 1) - 1]?.label).toBe(
      "Event 54",
    );
    expect(surface?.events[0]?.surface_id).toBe("surface-1");
    expect(surface?.events[0]?.widget_id).toBe("email_inbox");
    expect(surface?.events[0]?.created_at).toBeTruthy();

    const summary = summarizeWidgetSurfaceEvents(surface?.events, 3);
    expect(summary).toContain("Event 52");
    expect(summary).toContain("Event 54");
    expect(summary).not.toContain("Event 51");

    const context = buildActiveWidgetContext(surface!);
    expect(context.recentEventCount).toBe(WIDGET_SURFACE_MAX_EVENTS);
    expect(context.recentEvents).toHaveLength(10);
    expect(context.recentEventSummary).toContain("Event 54");
  });
});
