import {
  assertEquals,
  assertObjectMatch,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type { AgenticInterfaceSpec } from "../../shared/contracts/agentic-interface.ts";
import { flattenCommandSurfaceInventory } from "./command-surfaces.ts";
import { resolveAgenticInterfaceData } from "./agentic-interface-data.ts";
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
  contextSources: [{
    id: "approval_threads",
    appId: "app-email",
    appSlug: "email-ops",
    appName: "Email Ops",
    label: "Approval Threads",
    type: "d1_table",
    access: "read",
    searchable: true,
    tables: ["approval_threads"],
    redactions: [{ field: "secret" }],
  }],
  routines: [],
  types: "",
  updatedAt: "2026-05-27T00:00:00.000Z",
};

const inventory = flattenCommandSurfaceInventory(fnIndex);

Deno.test("agentic interface data: resolves literals and declared context rows", async () => {
  const spec: AgenticInterfaceSpec = {
    id: "email_interface",
    title: "Email Interface",
    mode: "temporary",
    data_bindings: [{
      id: "static",
      source: "literal",
      value: { metric: 3 },
    }, {
      id: "threads",
      source: "context_source",
      app_id: "app-email",
      app_slug: "email-ops",
      context_source_id: "approval_threads",
      query: "budget",
      max_rows: 2,
    }],
    components: [{
      id: "thread_table",
      kind: "table",
      title: "Threads",
      data_binding_id: "threads",
    }],
  };

  const result = await resolveAgenticInterfaceData("user-1", { spec }, {
    getFunctionIndex: () => Promise.resolve(fnIndex),
    getCommandSurfaceInventory: () => Promise.resolve(inventory),
    readContextSourceRows: (_source, options) =>
      Promise.resolve({
        source: fnIndex.contextSources[0],
        rows: [{ id: "t1", subject: options.query, secret: "[redacted]" }],
        rowCount: 1,
        errors: [],
      }),
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(result.spec_id, "email_interface");
  assertEquals(result.bindings.static.data, { metric: 3 });
  assertEquals(result.bindings.threads.status, "ok");
  assertEquals(result.bindings.threads.row_count, 1);
  assertObjectMatch(result.bindings.threads.data as Record<string, unknown>, {
    rows: [{ id: "t1", subject: "budget", secret: "[redacted]" }],
  });
});

Deno.test("agentic interface data: resolves command card and MCP read bindings through app functions", async () => {
  const calls: Array<{
    appId: string;
    appSlug?: string;
    functionName: string;
    args?: Record<string, unknown>;
  }> = [];
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
      data_view: "pending",
    }, {
      id: "approvals",
      source: "mcp_read_function",
      app_id: "app-email",
      app_slug: "email-ops",
      function_name: "list_approvals",
      args: { status: "pending" },
    }],
    components: [{
      id: "pending",
      kind: "list",
      title: "Pending",
      data_binding_id: "pending_card",
    }, {
      id: "approvals",
      kind: "table",
      title: "Approvals",
      data_binding_id: "approvals",
    }],
  };

  const result = await resolveAgenticInterfaceData("user-1", { spec }, {
    getFunctionIndex: () => Promise.resolve(fnIndex),
    getCommandSurfaceInventory: () => Promise.resolve(inventory),
    executeAppFunction: (input) => {
      calls.push(input);
      if (input.functionName.includes("widget_email_approvals_data")) {
        return Promise.resolve({ body: { items: [{ subject: "Budget" }] } });
      }
      return Promise.resolve({ data: [{ id: "a1", subject: "Budget" }] });
    },
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(calls, [{
    appId: "app-email",
    appSlug: "email-ops",
    functionName: "email-ops_widget_email_approvals_data",
    args: { card_id: "pending_approvals", data_view: "pending" },
  }, {
    appId: "app-email",
    appSlug: "email-ops",
    functionName: "email-ops_list_approvals",
    args: { status: "pending" },
  }]);
  assertEquals(result.bindings.pending_card.data, {
    items: [{ subject: "Budget" }],
  });
  assertEquals(result.bindings.approvals.data, [{
    id: "a1",
    subject: "Budget",
  }]);
});

Deno.test("agentic interface data: tolerates saved specs after bindings disappear", async () => {
  const spec: AgenticInterfaceSpec = {
    id: "stale_interface",
    title: "Stale Interface",
    mode: "saved",
    data_bindings: [{
      id: "missing_card",
      source: "command_card",
      app_id: "missing-app",
      app_slug: "missing",
      widget_id: "missing_widget",
      card_id: "missing_card",
    }],
    components: [{
      id: "missing_table",
      kind: "table",
      title: "Missing",
      data_binding_id: "missing_card",
    }],
  };

  const result = await resolveAgenticInterfaceData("user-1", { spec }, {
    getFunctionIndex: () =>
      Promise.resolve({
        functions: {},
        widgets: [],
        contextSources: [],
        routines: [],
        types: "",
        updatedAt: "2026-05-27T12:00:00.000Z",
      }),
    getCommandSurfaceInventory: () =>
      Promise.resolve({
        query: null,
        surfaces: [],
        totals: { widgets: 0, command_cards: 0, apps: 0 },
        updated_at: "2026-05-27T12:00:00.000Z",
      }),
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(result.spec_id, "stale_interface");
  assertEquals(result.binding_order, []);
  assertEquals(result.bindings, {});
  assertEquals(result.row_count, 0);
});
