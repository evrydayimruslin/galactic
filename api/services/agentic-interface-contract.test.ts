import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  type AgenticInterfaceComponent,
  type AgenticInterfaceDataBinding,
  type AgenticInterfaceSpec,
  validateAgenticInterfaceSpec,
} from "../../shared/contracts/agentic-interface.ts";

function validSpec(
  overrides: Partial<AgenticInterfaceSpec> = {},
): AgenticInterfaceSpec {
  return {
    id: "interface-email-approvals",
    title: "Email approvals",
    mode: "temporary",
    intent: "Review pending email drafts and act on selected conversations.",
    scope: {
      app_slugs: ["email-ops"],
      widget_ids: ["email_inbox"],
    },
    data_bindings: [
      {
        id: "pending_threads",
        source: "context_source",
        app_id: "app-email",
        app_slug: "email-ops",
        context_source_id: "email_recent_threads",
        query: "pending approvals",
        max_rows: 10,
      },
      {
        id: "urgent_count",
        source: "command_card",
        app_id: "app-email",
        app_slug: "email-ops",
        widget_id: "email_inbox",
        card_id: "urgent_threads",
        data_view: "urgent_threads",
      },
    ],
    actions: [
      {
        id: "open_email_widget",
        kind: "open_widget",
        label: "Open widget",
        mode: "ui",
        confirmation: "none",
        app_id: "app-email",
        app_slug: "email-ops",
        widget_id: "email_inbox",
      },
      {
        id: "send_selected_draft",
        kind: "mcp_function",
        label: "Send selected draft",
        mode: "write",
        confirmation: "user",
        app_id: "app-email",
        app_slug: "email-ops",
        function_name: "conversation_act",
        args_template: { action: "send" },
      },
    ],
    components: [
      {
        id: "urgent_metric",
        kind: "metric",
        title: "Urgent",
        data_binding_id: "urgent_count",
      },
      {
        id: "pending_table",
        kind: "table",
        title: "Pending threads",
        data_binding_id: "pending_threads",
        action_ids: ["open_email_widget", "send_selected_draft"],
        selectable: true,
        columns: [
          { id: "subject", label: "Subject", field: "subject" },
          { id: "sender", label: "Sender", field: "sender" },
        ],
      },
      {
        id: "actions",
        kind: "action_bar",
        action_ids: ["open_email_widget", "send_selected_draft"],
      },
      {
        id: "email_widget",
        kind: "widget_embed",
        app_id: "app-email",
        app_slug: "email-ops",
        widget_id: "email_inbox",
      },
    ],
    provenance: {
      prompt: "Make me an interface for pending email approvals.",
      source: "command",
    },
    ...overrides,
  };
}

Deno.test("agentic interface contract: accepts a minimal generated workspace", () => {
  const result = validateAgenticInterfaceSpec(validSpec());

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
  assertEquals(result.warnings, []);
  assertEquals(result.spec?.components.length, 4);
});

Deno.test("agentic interface contract: rejects unknown components and bindings", () => {
  const spec = validSpec({
    data_bindings: [
      {
        id: "bad_binding",
        source: "mcp_function",
        app_id: "app-email",
        function_name: "delete_everything",
      } as unknown as AgenticInterfaceDataBinding,
    ],
    components: [
      {
        id: "mystery",
        kind: "kanban",
        data_binding_id: "missing_binding",
      } as unknown as AgenticInterfaceComponent,
    ],
  });

  const result = validateAgenticInterfaceSpec(spec);

  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((error) =>
      error.path === "data_bindings.0.source" &&
      error.message.includes("command_card")
    ),
    true,
  );
  assertEquals(
    result.errors.some((error) =>
      error.path === "components.0.kind" &&
      error.message.includes("metric")
    ),
    true,
  );
});

Deno.test("agentic interface contract: rejects missing ids and unsafe write actions", () => {
  const spec = validSpec({
    components: [
      {
        id: "",
        kind: "form",
        fields: [],
        submit_action_id: "missing_action",
      } as unknown as AgenticInterfaceComponent,
    ],
    actions: [
      {
        id: "unsafe_send",
        kind: "mcp_function",
        label: "Unsafe send",
        mode: "write",
        confirmation: "none",
        app_id: "app-email",
        function_name: "conversation_act",
      },
    ],
  });

  const result = validateAgenticInterfaceSpec(spec);

  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((error) => error.path === "components.0.id"),
    true,
  );
  assertEquals(
    result.errors.some((error) => error.path === "components.0.fields"),
    true,
  );
  assertEquals(
    result.errors.some((error) =>
      error.path === "components.0.submit_action_id"
    ),
    true,
  );
  assertEquals(
    result.errors.some((error) =>
      error.path === "actions.0.confirmation" &&
      error.message.includes("write actions")
    ),
    true,
  );
});
