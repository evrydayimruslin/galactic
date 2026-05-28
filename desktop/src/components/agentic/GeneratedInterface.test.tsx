import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgenticInterfacePlannerResult } from "../../lib/api";
import GeneratedInterface from "./GeneratedInterface";
import { requiresAgenticActionConfirmation } from "./AgenticInterfaceHost";

const result: AgenticInterfacePlannerResult = {
  draft_spec: {} as AgenticInterfacePlannerResult["draft_spec"],
  normalized_spec: {
    id: "kitchen_sink",
    title: "Kitchen Sink",
    description: "Every primitive",
    mode: "temporary",
    data_bindings: [{
      id: "items",
      source: "literal",
      value: {
        metric: 12,
        label: "Open",
        items: [{
          primary: "Approval",
          secondary: "From Jordan",
          trailing: "now",
          subject: "Budget",
          sender: "Jordan",
          status: "pending",
          time: "10:00",
          title: "Reviewed",
          subtitle: "Draft ready",
        }],
        subject: "Budget",
        sender: "Jordan",
      },
    }],
    actions: [{
      id: "open_widget",
      kind: "open_widget",
      label: "Open widget",
      mode: "ui",
      confirmation: "none",
      app_id: "app-email",
      app_slug: "email-ops",
      widget_id: "email_approvals",
    }, {
      id: "send",
      kind: "mcp_function",
      label: "Send",
      mode: "write",
      confirmation: "user",
      app_id: "app-email",
      app_slug: "email-ops",
      function_name: "send_approval",
    }],
    components: [
      {
        id: "metric",
        kind: "metric",
        title: "Metric",
        data_binding_id: "items",
        metric_field: "metric",
        label_field: "label",
      },
      {
        id: "list",
        kind: "list",
        title: "List",
        data_binding_id: "items",
        primary_field: "primary",
        secondary_field: "secondary",
      },
      {
        id: "table",
        kind: "table",
        title: "Table",
        data_binding_id: "items",
        columns: [{ id: "subject", label: "Subject", field: "subject" }, {
          id: "status",
          label: "Status",
          field: "status",
        }],
        selectable: true,
      },
      {
        id: "detail",
        kind: "detail",
        title: "Detail",
        data_binding_id: "items",
        fields: [{ id: "sender", label: "Sender" }],
      },
      {
        id: "form",
        kind: "form",
        title: "Form",
        fields: [{ id: "reply", label: "Reply", type: "textarea" }],
        submit_action_id: "send",
      },
      {
        id: "actions",
        kind: "action_bar",
        title: "Actions",
        action_ids: ["open_widget", "send"],
      },
      {
        id: "timeline",
        kind: "timeline",
        title: "Timeline",
        data_binding_id: "items",
        time_field: "time",
        title_field: "title",
        subtitle_field: "subtitle",
      },
      {
        id: "card",
        kind: "card_ref",
        title: "Card",
        app_id: "app-email",
        app_slug: "email-ops",
        widget_id: "email_approvals",
        card_id: "pending_approvals",
        size: "2x1",
      },
      {
        id: "widget",
        kind: "widget_embed",
        title: "Widget",
        app_id: "app-email",
        app_slug: "email-ops",
        widget_id: "email_approvals",
      },
      { id: "routine", kind: "routine_panel", title: "Routine" },
      { id: "text", kind: "text", title: "Note", text: "Plain typed text" },
    ],
  },
  validation: { valid: true, errors: [], warnings: [] },
  verification: {
    verified: true,
    spec: {} as AgenticInterfacePlannerResult["normalized_spec"],
    validation: { valid: true, errors: [], warnings: [] },
    warnings: [],
    dropped: [],
  },
  rationale: ["fixture"],
  warnings: [],
  dropped: [],
  planner: {
    version: "test",
    policy: "typed only",
    context_summary: {
      surfaces: [],
      functions: [],
      context_sources: [],
      saved_dashboards: [],
    },
  },
  inventory: {
    surfaces_considered: 0,
    functions_considered: 0,
    context_sources_considered: 0,
    saved_dashboards_considered: 0,
  },
  persisted: false,
};

describe("GeneratedInterface", () => {
  it("renders typed primitives without arbitrary HTML output", () => {
    const html = renderToStaticMarkup(<GeneratedInterface result={result} />);

    expect(html).toContain("Kitchen Sink");
    expect(html).toContain("Metric");
    expect(html).toContain("Approval");
    expect(html).toContain("Subject");
    expect(html).toContain("Sender");
    expect(html).toContain("Reply");
    expect(html).toContain("Send");
    expect(html).toContain("Reviewed");
    expect(html).toContain("pending_approvals");
    expect(html).toContain("Open widget");
    expect(html).toContain("Routine");
    expect(html).toContain("Plain typed text");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("requires confirmation for generated write actions only", () => {
    expect(
      requiresAgenticActionConfirmation(result.normalized_spec.actions![0]),
    ).toBe(false);
    expect(
      requiresAgenticActionConfirmation(result.normalized_spec.actions![1]),
    ).toBe(true);
  });

  it("renders a verified stale interface without crashing on missing bindings or actions", () => {
    const staleResult: AgenticInterfacePlannerResult = {
      ...result,
      normalized_spec: {
        id: "stale_interface",
        title: "Stale Interface",
        mode: "saved",
        components: [{
          id: "missing_table",
          kind: "table",
          title: "Missing Table",
          data_binding_id: "missing_binding",
          action_ids: ["missing_action"],
        }, {
          id: "safe_note",
          kind: "text",
          title: "Safe fallback",
          text: "Some capabilities are no longer installed.",
        }],
      },
      warnings: [{
        code: "capability_missing",
        message: "Some source capabilities are unavailable.",
      }],
      dropped: [{
        kind: "data_binding",
        path: "data_bindings.0",
        reason: "unknown command card reference",
        id: "missing_binding",
      }],
    };

    const html = renderToStaticMarkup(
      <GeneratedInterface result={staleResult} />,
    );

    expect(html).toContain("Stale Interface");
    expect(html).toContain("Missing Table");
    expect(html).toContain("Safe fallback");
    expect(html).toContain("Some capabilities are no longer installed.");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });
});
