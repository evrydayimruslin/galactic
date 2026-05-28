import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

import type { AgenticInterfaceSpec } from "../../shared/contracts/agentic-interface.ts";
import { flattenCommandSurfaceInventory } from "./command-surfaces.ts";
import { executeAgenticInterfaceAction } from "./agentic-interface-actions.ts";
import type { FunctionIndex } from "./function-index.ts";

const fnIndex: FunctionIndex = {
  functions: {
    email_ops_list_approvals: {
      appId: "app-email",
      appSlug: "email-ops",
      fnName: "list_approvals",
      description: "List pending email approvals",
      params: {},
      returns: "Approval[]",
      conventions: [],
      dependsOn: [],
    },
    email_ops_send_approval: {
      appId: "app-email",
      appSlug: "email-ops",
      fnName: "send_approval",
      description: "Send or approve an email approval",
      params: { approval_id: { type: "string", required: true } },
      returns: "Approval",
      conventions: [],
      dependsOn: [],
    },
  },
  widgets: [{
    name: "email_approvals",
    label: "Email Approvals",
    description: "Review pending approvals",
    appId: "app-email",
    appSlug: "email-ops",
    appName: "Email Ops",
    uiFunction: "widget_email_approvals_ui",
    dataFunction: "widget_email_approvals_data",
    agentActions: [{
      id: "mark_reviewed",
      label: "Mark reviewed",
      mode: "write",
      confirmation: "user",
      mcp: { function: "send_approval" },
    }],
    cards: [{
      id: "pending_approvals",
      label: "Pending Approvals",
      description: "Drafts waiting for review",
      size: "2x1",
      render: "native",
      kind: "list",
      dataView: "pending",
    }],
  }],
  contextSources: [],
  routines: [],
  types: "",
  updatedAt: "2026-05-27T00:00:00.000Z",
};

const inventory = flattenCommandSurfaceInventory(fnIndex);

function specWithActions(
  actions: AgenticInterfaceSpec["actions"],
): AgenticInterfaceSpec {
  return {
    id: "email_interface",
    title: "Email Interface",
    mode: "temporary",
    actions,
    components: [{
      id: "actions",
      kind: "action_bar",
      action_ids: (actions || []).map((action) => action.id),
    }],
  };
}

Deno.test("agentic interface actions: write MCP actions require confirmation and carry audit metadata", async () => {
  const calls: Array<{
    appId: string;
    appSlug?: string;
    functionName: string;
    args?: Record<string, unknown>;
  }> = [];
  const spec = specWithActions([{
    id: "send",
    kind: "mcp_function",
    label: "Send",
    mode: "write",
    confirmation: "user",
    app_id: "app-email",
    app_slug: "email-ops",
    function_name: "send_approval",
  }]);

  const pending = await executeAgenticInterfaceAction("user-1", {
    spec,
    action_id: "send",
    args: { approval_id: "approval-1" },
    surface_id: "surface-generated",
    turn_id: "turn-1",
  }, {
    getFunctionIndex: () => Promise.resolve(fnIndex),
    getCommandSurfaceInventory: () => Promise.resolve(inventory),
    executeAppFunction: (input) => {
      calls.push(input);
      return Promise.resolve({ ok: true });
    },
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(pending.status, "requires_confirmation");
  assertEquals(calls.length, 0);

  const executed = await executeAgenticInterfaceAction("user-1", {
    spec,
    action_id: "send",
    args: { approval_id: "approval-1" },
    confirmed: true,
    surface_id: "surface-generated",
    turn_id: "turn-1",
    component_id: "actions",
  }, {
    getFunctionIndex: () => Promise.resolve(fnIndex),
    getCommandSurfaceInventory: () => Promise.resolve(inventory),
    executeAppFunction: (input) => {
      calls.push(input);
      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      });
    },
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(executed.status, "ok");
  assertEquals(executed.result, { ok: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].functionName, "email-ops_send_approval");
  assertEquals(calls[0].args, {
    approval_id: "approval-1",
    _agentic_surface_action: true,
    _agentic_surface_id: "surface-generated",
    _agentic_interface_id: "email_interface",
    _agentic_action_id: "send",
    _agentic_turn_id: "turn-1",
    _agentic_component_id: "actions",
  });
});

Deno.test("agentic interface actions: read MCP actions execute without confirmation", async () => {
  const spec = specWithActions([{
    id: "list",
    kind: "mcp_function",
    label: "List",
    mode: "read",
    confirmation: "none",
    app_id: "app-email",
    app_slug: "email-ops",
    function_name: "list_approvals",
    args_template: { status: "pending" },
  }]);

  const result = await executeAgenticInterfaceAction("user-1", {
    spec,
    action_id: "list",
    args: { limit: 2 },
    surface_id: "surface-generated",
    turn_id: "turn-2",
  }, {
    getFunctionIndex: () => Promise.resolve(fnIndex),
    getCommandSurfaceInventory: () => Promise.resolve(inventory),
    executeAppFunction: (input) => {
      assertEquals(input.args?.status, "pending");
      assertEquals(input.args?.limit, 2);
      return Promise.resolve({ data: [{ id: "approval-1" }] });
    },
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(result.status, "ok");
  assertEquals(result.result, [{ id: "approval-1" }]);
});

Deno.test("agentic interface actions: widget actions either execute locally or return client action details", async () => {
  const spec = specWithActions([{
    id: "review",
    kind: "widget_action",
    label: "Review",
    mode: "write",
    confirmation: "user",
    app_id: "app-email",
    app_slug: "email-ops",
    widget_id: "email_approvals",
    action_id: "mark_reviewed",
    args_template: { source: "agentic_interface" },
  }]);

  const pending = await executeAgenticInterfaceAction("user-1", {
    spec,
    action_id: "review",
    confirmed: true,
    args: { approval_id: "approval-1" },
    surface_id: "surface-generated",
    turn_id: "turn-3",
  }, {
    getFunctionIndex: () => Promise.resolve(fnIndex),
    getCommandSurfaceInventory: () => Promise.resolve(inventory),
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(pending.status, "client_action_required");
  assertEquals(pending.widget_action?.action_id, "mark_reviewed");
  assertEquals(pending.widget_action?.args, {
    source: "agentic_interface",
    approval_id: "approval-1",
  });

  const executed = await executeAgenticInterfaceAction("user-1", {
    spec,
    action_id: "review",
    confirmed: true,
    args: { approval_id: "approval-1" },
    surface_id: "surface-generated",
    turn_id: "turn-3",
  }, {
    getFunctionIndex: () => Promise.resolve(fnIndex),
    getCommandSurfaceInventory: () => Promise.resolve(inventory),
    executeWidgetAction: (input) => {
      assertEquals(input.widgetId, "email_approvals");
      assertEquals(input.actionId, "mark_reviewed");
      assertEquals(input.audit.action_id, "review");
      return Promise.resolve({ ok: true });
    },
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(executed.status, "ok");
  assertEquals(executed.result, { ok: true });
});

Deno.test("agentic interface actions: refresh, select, and open actions return auditable UI results", async () => {
  const spec: AgenticInterfaceSpec = {
    id: "email_interface",
    title: "Email Interface",
    mode: "temporary",
    data_bindings: [{
      id: "pending_card",
      source: "command_card",
      app_id: "app-email",
      app_slug: "email-ops",
      widget_id: "email_approvals",
      card_id: "pending_approvals",
    }],
    actions: [{
      id: "refresh_pending",
      kind: "refresh_binding",
      label: "Refresh pending",
      mode: "read",
      confirmation: "none",
      binding_ids: ["pending_card"],
    }, {
      id: "select_pending",
      kind: "select_entity",
      label: "Select pending",
      mode: "ui",
      confirmation: "none",
      component_id: "pending",
    }, {
      id: "open_inbox",
      kind: "open_widget",
      label: "Open inbox",
      mode: "ui",
      confirmation: "none",
      app_id: "app-email",
      app_slug: "email-ops",
      widget_id: "email_approvals",
    }],
    components: [{
      id: "pending",
      kind: "table",
      title: "Pending",
      data_binding_id: "pending_card",
      action_ids: ["refresh_pending", "select_pending", "open_inbox"],
    }],
  };

  const deps = {
    getFunctionIndex: () => Promise.resolve(fnIndex),
    getCommandSurfaceInventory: () => Promise.resolve(inventory),
    now: () => new Date("2026-05-27T12:00:00.000Z"),
    randomUUID: () => "turn-generated",
  };

  const refresh = await executeAgenticInterfaceAction("user-1", {
    spec,
    action_id: "refresh_pending",
    surface_id: "surface-generated",
  }, deps);
  assertEquals(refresh.status, "ok");
  assertEquals(refresh.refreshed_binding_ids, ["pending_card"]);
  assertEquals(refresh.audit.turn_id, "turn-generated");
  assertEquals(refresh.audit.surface_id, "surface-generated");

  const select = await executeAgenticInterfaceAction("user-1", {
    spec,
    action_id: "select_pending",
    args: { id: "approval-1" },
    surface_id: "surface-generated",
    component_id: "pending",
  }, deps);
  assertEquals(select.status, "ok");
  assertEquals(select.selected_entity?.component_id, "pending");
  assertEquals(select.selected_entity?.args, { id: "approval-1" });
  assertEquals(select.audit.component_id, "pending");

  const open = await executeAgenticInterfaceAction("user-1", {
    spec,
    action_id: "open_inbox",
    surface_id: "surface-generated",
  }, deps);
  assertEquals(open.status, "ok");
  assertEquals(open.open_widget?.widget_id, "email_approvals");
  assertEquals(open.audit.interface_id, "email_interface");
});
