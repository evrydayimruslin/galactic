import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type { AgenticInterfaceSpec } from "../../shared/contracts/agentic-interface.ts";
import { flattenCommandSurfaceInventory } from "./command-surfaces.ts";
import { verifyAgenticInterfaceSpec } from "./agentic-interface-validate.ts";
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
      params: {
        approval_id: { type: "string", required: true },
      },
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
  contextSources: [
    {
      id: "approval_threads",
      appId: "app-email",
      appSlug: "email-ops",
      appName: "Email Ops",
      label: "Approval Threads",
      type: "d1_table",
      access: "read",
      searchable: true,
      tables: ["approval_threads"],
    },
    {
      id: "private_threads",
      appId: "app-email",
      appSlug: "email-ops",
      appName: "Email Ops",
      label: "Private Threads",
      type: "d1_table",
      access: "write",
      tables: ["private_threads"],
    } as unknown as FunctionIndex["contextSources"][number],
  ],
  routines: [],
  types: "",
  updatedAt: "2026-05-27T00:00:00.000Z",
};

const inventory = flattenCommandSurfaceInventory(fnIndex);

function baseSpec(
  overrides: Partial<AgenticInterfaceSpec> = {},
): AgenticInterfaceSpec {
  return {
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
      id: "send",
      kind: "mcp_function",
      label: "Send",
      mode: "write",
      confirmation: "user",
      app_id: "app-email",
      app_slug: "email-ops",
      function_name: "send_approval",
    }],
    components: [{
      id: "pending",
      kind: "list",
      title: "Pending",
      data_binding_id: "pending_card",
      action_ids: ["send"],
    }],
    ...overrides,
  };
}

function objectHasUnsafeUiKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(objectHasUnsafeUiKey);
  for (const [key, nested] of Object.entries(value)) {
    if (
      [
        "html",
        "app_html",
        "react",
        "jsx",
        "css",
        "style",
        "script",
        "dom_selector",
        "selector",
        "iframe",
      ].includes(key)
    ) return true;
    if (objectHasUnsafeUiKey(nested)) return true;
  }
  return false;
}

Deno.test("agentic interface verifier: drops hallucinated card, widget, function, and component references", () => {
  const result = verifyAgenticInterfaceSpec(
    baseSpec({
      data_bindings: [{
        id: "bad_card",
        source: "command_card",
        app_id: "missing-app",
        widget_id: "missing_widget",
        card_id: "missing_card",
      }],
      actions: [{
        id: "bad_open",
        kind: "open_widget",
        label: "Open missing",
        mode: "ui",
        app_id: "missing-app",
        widget_id: "missing_widget",
      }],
      components: [{
        id: "bad_component",
        kind: "table",
        data_binding_id: "bad_card",
      }],
    }),
    { fnIndex, inventory },
  );

  assertEquals(result.verified, true);
  assertEquals(result.spec.components[0].kind, "text");
  assertEquals(result.spec.data_bindings, undefined);
  assertEquals(result.spec.actions, undefined);
  assert(
    result.dropped.some((item) => item.reason.includes("unknown command card")),
  );
  assert(result.dropped.some((item) => item.reason.includes("unknown widget")));
});

Deno.test("agentic interface verifier: strips raw UI shapes before render", () => {
  const result = verifyAgenticInterfaceSpec(
    baseSpec({
      data_bindings: [{
        id: "literal_html",
        source: "literal",
        value: { html: "<script>alert(1)</script>" },
      }],
      actions: [
        {
          id: "styled_action",
          kind: "mcp_function",
          label: "Styled action",
          mode: "read",
          confirmation: "none",
          app_id: "app-email",
          app_slug: "email-ops",
          function_name: "list_approvals",
          args_template: { style: "display:none" },
        } as unknown as NonNullable<AgenticInterfaceSpec["actions"]>[number],
      ],
      components: [
        {
          id: "raw_component",
          kind: "table",
          data_binding_id: "literal_html",
          react: "<Unsafe />",
        } as unknown as AgenticInterfaceSpec["components"][number],
      ],
    }),
    { fnIndex, inventory },
  );

  assertEquals(result.verified, true);
  assertEquals(objectHasUnsafeUiKey(result.spec), false);
  assert(result.dropped.some((item) => item.kind === "data_binding"));
  assert(result.dropped.some((item) => item.kind === "action"));
  assert(result.dropped.some((item) => item.kind === "component"));
  assert(
    result.spec.components.some((component) =>
      component.kind === "text" && component.id === "verified_empty_state"
    ),
  );
});

Deno.test("agentic interface verifier: read bindings cannot call write-like MCP functions", () => {
  const result = verifyAgenticInterfaceSpec(
    baseSpec({
      data_bindings: [{
        id: "unsafe_read",
        source: "mcp_read_function",
        app_id: "app-email",
        app_slug: "email-ops",
        function_name: "send_approval",
      }],
      components: [{
        id: "unsafe_table",
        kind: "table",
        data_binding_id: "unsafe_read",
      }],
    }),
    { fnIndex, inventory },
  );

  assertEquals(result.verified, true);
  assertEquals(result.spec.data_bindings, undefined);
  assert(result.dropped.some((item) => item.reason.includes("write-like MCP")));
});

Deno.test("agentic interface verifier: write actions get confirmation and raw UI fields are stripped", () => {
  const result = verifyAgenticInterfaceSpec(
    baseSpec({
      actions: [
        {
          id: "unsafe_write",
          kind: "mcp_function",
          label: "Unsafe write",
          mode: "read",
          confirmation: "none",
          app_id: "app-email",
          app_slug: "email-ops",
          function_name: "send_approval",
          args_template: { approval_id: "{{selected.id}}" },
          html: "<button>send</button>",
        } as unknown as NonNullable<AgenticInterfaceSpec["actions"]>[number],
      ],
    }),
    { fnIndex, inventory },
  );

  assertEquals(result.verified, true);
  assertEquals(result.spec.actions, undefined);
  assert(result.dropped.some((item) => item.reason.includes("unsafe")));

  const safeResult = verifyAgenticInterfaceSpec(
    baseSpec({
      actions: [{
        id: "safe_write",
        kind: "mcp_function",
        label: "Safe write",
        mode: "read",
        confirmation: "none",
        app_id: "app-email",
        app_slug: "email-ops",
        function_name: "send_approval",
        args_template: { approval_id: "{{selected.id}}" },
      }],
    }),
    { fnIndex, inventory },
  );

  const [action] = safeResult.spec.actions || [];
  assertEquals(action?.mode, "write");
  assertEquals(action?.confirmation, "user");
  assert(
    safeResult.warnings.some((warning) =>
      warning.code === "write_confirmation_normalized"
    ),
  );
});

Deno.test("agentic interface verifier: applies caps and rejects unreadable context sources", () => {
  const manyComponents = Array.from({ length: 8 }, (_, index) => ({
    id: `component_${index}`,
    kind: "text" as const,
    text: `Component ${index}`,
  }));

  const result = verifyAgenticInterfaceSpec(
    baseSpec({
      data_bindings: [{
        id: "private",
        source: "context_source",
        app_id: "app-email",
        app_slug: "email-ops",
        context_source_id: "private_threads",
      }],
      actions: [],
      components: manyComponents,
    }),
    {
      fnIndex,
      inventory,
      options: { maxComponents: 3 },
    },
  );

  assertEquals(result.verified, true);
  assertEquals(result.spec.components.length, 3);
  assertEquals(result.spec.data_bindings, undefined);
  assert(
    result.warnings.some((warning) =>
      warning.code === "component_limit_applied"
    ),
  );
  assert(
    result.dropped.some((item) =>
      item.reason.includes("non-readable context source")
    ),
  );
});
