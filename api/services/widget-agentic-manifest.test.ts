import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  type AppManifest,
  validateManifest,
} from "../../shared/contracts/manifest.ts";

function baseManifest(overrides: Record<string, unknown> = {}): AppManifest {
  return {
    name: "Agentic Widget App",
    version: "1.0.0",
    type: "mcp",
    entry: { functions: "index.ts" },
    functions: {
      widget_email_inbox_ui: { description: "Render the email widget" },
      widget_email_inbox_data: { description: "Load email widget data" },
      search_conversations_context: { description: "Search conversations for context" },
      conversation_act: { description: "Act on a conversation" },
    },
    ...overrides,
  } as AppManifest;
}

Deno.test("agentic widget manifest: accepts read context sources and semantic actions", () => {
  const result = validateManifest(baseManifest({
    context_sources: [
      {
        id: "email_conversations",
        label: "Email conversations",
        type: "function",
        access: "read",
        searchable: true,
        function: "search_conversations_context",
        default_for_widgets: ["email_inbox"],
      },
      {
        id: "recent_threads",
        label: "Recent threads",
        type: "d1_query",
        access: "read",
        searchable: true,
        query:
          "SELECT id, subject FROM conversations WHERE user_id = :user_id AND subject LIKE :query ORDER BY updated_at DESC LIMIT :limit",
        default_for_widgets: ["email_inbox"],
      },
    ],
    widgets: [
      {
        id: "email_inbox",
        label: "Email Inbox",
        agentic: true,
        context_function: "widget_email_inbox_data",
        actions_function: "widget_email_inbox_data",
        context_sources: ["email_conversations"],
        agent_actions: [
          {
            id: "send_selected_draft",
            label: "Send selected draft",
            mode: "write",
            confirmation: "user",
            mcp: {
              function: "conversation_act",
              args_template: { action: "send" },
            },
          },
          {
            id: "show_draft_editor",
            label: "Show draft editor",
            mode: "ui",
            confirmation: "none",
            ui: {
              command: "focus",
              component_id: "draft_response",
              args_template: { focus: true },
            },
          },
        ],
      },
    ],
  }));

  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
  assertEquals(result.warnings, []);
});

Deno.test("agentic widget manifest: rejects unsafe context/action shapes", () => {
  const result = validateManifest(baseManifest({
    context_sources: [
      {
        id: "raw_query",
        label: "Raw query",
        type: "d1_query",
        access: "write",
        query: "DELETE FROM conversations WHERE user_id = :user_id",
      },
    ],
    widgets: [
      {
        id: "email_inbox",
        label: "Email Inbox",
        agentic: "yes",
        context_sources: ["missing_source"],
        agent_actions: [
          {
            id: "send",
            label: "Send",
            mode: "delete",
            ui: { command: 123 },
          },
        ],
      },
    ],
  }));

  assertEquals(result.valid, false);
  assertEquals(
    result.errors.some((error) => error.path === "context_sources.0.access"),
    true,
  );
  assertEquals(
    result.errors.some((error) =>
      error.path === "context_sources.0.query" &&
      error.message.includes("SELECT-only")
    ),
    true,
  );
  assertEquals(
    result.errors.some((error) => error.path === "widgets.0.agentic"),
    true,
  );
  assertEquals(
    result.errors.some((error) => error.path === "widgets.0.agent_actions.0.mode"),
    true,
  );
  assertEquals(
    result.errors.some((error) => error.path === "widgets.0.agent_actions.0.ui.command"),
    true,
  );
  assertEquals(
    result.warnings.some((warning) => warning.includes("missing_source")),
    true,
  );
});
