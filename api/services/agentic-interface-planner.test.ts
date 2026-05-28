import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  buildAgenticInterfacePlanFromFunctionIndex,
  planAgenticInterface,
} from "./agentic-interface-planner.ts";
import { flattenCommandSurfaceInventory } from "./command-surfaces.ts";
import type { FunctionIndex } from "./function-index.ts";

const fnIndex: FunctionIndex = {
  functions: {
    email_ops_list_approvals: {
      appId: "app-email",
      appSlug: "email-ops",
      fnName: "list_approvals",
      description: "List pending email approvals and draft replies",
      params: {
        status: {
          type: "string",
          required: false,
          description: "Approval status",
        },
      },
      returns: "Approval[]",
      conventions: [],
      dependsOn: [],
    },
    email_ops_approval_act: {
      appId: "app-email",
      appSlug: "email-ops",
      fnName: "approval_act",
      description: "Approve, reject, revise, or send pending email approvals",
      params: {
        approval_id: {
          type: "string",
          required: true,
          description: "Approval ID",
        },
        action: {
          type: "string",
          required: true,
          description: "Action to perform",
        },
      },
      returns: "ApprovalActionResult",
      conventions: [],
      dependsOn: ["email_ops_list_approvals"],
    },
    study_coach_list_courses: {
      appId: "app-study",
      appSlug: "study-coach",
      fnName: "list_courses",
      description: "List study coach courses and progress",
      params: {},
      returns: "Course[]",
      conventions: [],
      dependsOn: [],
    },
  },
  widgets: [{
    name: "email_approvals",
    label: "Email Approvals",
    description: "Review and act on draft approvals",
    appId: "app-email",
    appSlug: "email-ops",
    appName: "Email Ops",
    uiFunction: "widget_email_approvals_ui",
    dataFunction: "widget_email_approvals_data",
    agentic: true,
    cards: [{
      id: "pending_approvals",
      label: "Pending Approvals",
      description: "Drafts waiting for review",
      size: "2x1",
      render: "native",
      kind: "list",
      dataView: "pending",
      refreshIntervalS: 60,
    }],
  }, {
    name: "course_progress",
    label: "Course Progress",
    appId: "app-study",
    appSlug: "study-coach",
    appName: "Study Coach",
    uiFunction: "widget_course_progress_ui",
    dataFunction: "widget_course_progress_data",
    cards: [{
      id: "active_courses",
      label: "Active Courses",
      size: "2x1",
      render: "native",
      kind: "table",
    }],
  }],
  contextSources: [{
    id: "approval_threads",
    appId: "app-email",
    appSlug: "email-ops",
    appName: "Email Ops",
    label: "Approval Threads",
    description: "Searchable email approval threads in D1",
    type: "d1_table",
    access: "read",
    searchable: true,
    tables: ["approval_threads"],
  }],
  routines: [],
  types: "",
  updatedAt: "2026-05-27T00:00:00.000Z",
};

function objectHasUnsafeUiKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(objectHasUnsafeUiKey);
  for (const [key, nested] of Object.entries(value)) {
    if (
      ["html", "react", "css", "dom_selector", "selector", "script"].includes(
        key,
      )
    ) {
      return true;
    }
    if (objectHasUnsafeUiKey(nested)) return true;
  }
  return false;
}

Deno.test("agentic interface planner: drafts a valid spec from command cards and MCP functions", () => {
  const result = buildAgenticInterfacePlanFromFunctionIndex(fnIndex, {
    prompt: "email approvals",
    max_components: 6,
  }, {
    dashboards: [{
      dashboard_key: "ops",
      title: "Ops",
      description: null,
      icon: null,
      sort_order: 0,
      is_default: false,
      card_count: 1,
      created_at: null,
      updated_at: null,
    }],
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(result.validation.valid, true);
  assertEquals(result.persisted, false);
  assert(result.normalized_spec);
  assert(
    result.draft_spec.data_bindings?.some((binding) =>
      binding.source === "command_card" &&
      binding.card_id === "pending_approvals"
    ),
  );
  assert(
    result.draft_spec.actions?.some((action) =>
      action.kind === "mcp_function" &&
      action.function_name === "approval_act" &&
      action.mode === "write" &&
      action.confirmation === "user"
    ),
  );
  assert(
    result.draft_spec.components.some((component) =>
      component.kind === "widget_embed" &&
      component.widget_id === "email_approvals"
    ),
  );
  assertEquals(objectHasUnsafeUiKey(result.draft_spec), false);
  assert(result.rationale.length > 0);
});

Deno.test("agentic interface planner: scopes inventory and can include safe data preview metadata", async () => {
  const result = await planAgenticInterface("user-1", {
    prompt: "email approvals",
    app_scope: { app_slugs: ["email-ops"] },
    include_data_preview: true,
  }, {
    getFunctionIndex: () => Promise.resolve(fnIndex),
    getCommandSurfaceInventory: (_userId, options) =>
      Promise.resolve(flattenCommandSurfaceInventory(fnIndex, options)),
    listDashboards: () => Promise.resolve({ dashboards: [] }),
    magnifyContextSources: () =>
      Promise.resolve({
        context: '### Courses\n{"title":"Biology"}',
        sourceCount: 1,
        rowCount: 1,
        errors: [],
      }),
    now: () => new Date("2026-05-27T12:00:00.000Z"),
  });

  assertEquals(result.validation.valid, true);
  assertEquals(result.draft_spec.scope?.app_slugs, ["email-ops"]);
  assertEquals(result.inventory.data_preview_rows, 1);
  assertEquals(result.data_preview?.rowCount, 1);
});

function generationHintFixture(includeHints: boolean): FunctionIndex {
  const generationHints = includeHints
    ? {
      tags: ["approval"],
      preferred_component: "table" as const,
      entity_types: ["approval"],
      prompt_examples: ["review pending approvals"],
      suggested_components: [{
        kind: "detail" as const,
        title: "Selected approval",
        description: "Show the selected approval and supporting details.",
      }],
    }
    : undefined;
  return {
    functions: {
      workflows_search_items: {
        appId: "app-workflows",
        appSlug: "workflows",
        fnName: "search_items",
        description: "Search queue items",
        params: {},
        returns: "Item[]",
        conventions: [],
        dependsOn: [],
        ...(includeHints
          ? {
            generationHints: {
              tags: ["approval"],
              preferred_component: "list" as const,
              entity_types: ["approval"],
              safe_default_filters: { status: "pending" },
            },
          }
          : {}),
      },
    },
    widgets: [{
      name: "operations",
      label: "Operations",
      description: "Shared operational queue",
      appId: "app-workflows",
      appSlug: "workflows",
      appName: "Workflow Tools",
      uiFunction: "widget_operations_ui",
      dataFunction: "widget_operations_data",
      cards: [{
        id: "queue",
        label: "Queue",
        description: "Items waiting in a shared queue",
        size: "2x1",
        render: "native",
        kind: "summary",
        ...(generationHints ? { generationHints } : {}),
      }],
    }],
    contextSources: [],
    routines: [],
    types: "",
    updatedAt: "2026-05-27T00:00:00.000Z",
  };
}

Deno.test("agentic interface planner: generation hints improve selection and component shape", () => {
  const unhinted = buildAgenticInterfacePlanFromFunctionIndex(
    generationHintFixture(false),
    { prompt: "approval", max_components: 4 },
  );
  assertEquals(
    unhinted.draft_spec.data_bindings?.some((binding) =>
      binding.source === "command_card" && binding.card_id === "queue"
    ) || false,
    false,
  );

  const hinted = buildAgenticInterfacePlanFromFunctionIndex(
    generationHintFixture(true),
    { prompt: "approval", max_components: 4 },
  );
  const cardBinding = hinted.draft_spec.data_bindings?.find((binding) =>
    binding.source === "command_card" && binding.card_id === "queue"
  );
  assert(cardBinding);
  const cardComponent = hinted.draft_spec.components.find((component) =>
    component.data_binding_id === cardBinding.id
  );
  assertEquals(cardComponent?.kind, "table");
  assert(
    hinted.draft_spec.components.some((component) =>
      component.title === "Selected approval" && component.kind === "detail"
    ),
  );
  const readBinding = hinted.draft_spec.data_bindings?.find((binding) =>
    binding.source === "mcp_read_function" &&
    binding.function_name === "search_items"
  );
  assert(readBinding);
  if (readBinding.source === "mcp_read_function") {
    assertEquals(readBinding.args, { status: "pending" });
  }
  assert(hinted.rationale.some((entry) => entry.includes("generation hints")));
});

Deno.test("agentic interface planner: unmatched prompts become safe typed empty states", () => {
  const result = buildAgenticInterfacePlanFromFunctionIndex({
    functions: {},
    widgets: [],
    contextSources: [],
    routines: [],
    types: "",
    updatedAt: "2026-05-27T00:00:00.000Z",
  }, {
    prompt: "launch control telemetry",
    max_components: 4,
  });

  assertEquals(result.validation.valid, true);
  assertEquals(result.verification.verified, true);
  assertEquals(result.normalized_spec.components[0]?.kind, "text");
  assertEquals(result.normalized_spec.data_bindings, undefined);
  assertEquals(result.normalized_spec.actions, undefined);
  assert(
    result.warnings.some((warning) => warning.code === "no_matching_inventory"),
  );
});
