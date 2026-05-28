import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type {
  AgenticInterfaceComponentKind,
  AgenticInterfaceSpec,
} from "../../shared/contracts/agentic-interface.ts";
import {
  type AgenticInterfacePlannerResult,
  buildAgenticInterfacePlanFromFunctionIndex,
} from "./agentic-interface-planner.ts";
import {
  type AppForCodemode,
  buildJsonSchemaDescriptors,
} from "./codemode-tools.ts";
import { flattenCommandSurfaceInventory } from "./command-surfaces.ts";
import { verifyAgenticInterfaceSpec } from "./agentic-interface-validate.ts";
import type { FunctionIndex } from "./function-index.ts";

const COMPONENT_KINDS = new Set<AgenticInterfaceComponentKind>([
  "metric",
  "list",
  "table",
  "detail",
  "form",
  "action_bar",
  "timeline",
  "card_ref",
  "widget_embed",
  "routine_panel",
  "text",
]);

const emailOpsApp: AppForCodemode = {
  id: "app-email",
  name: "Email Ops",
  slug: "email-ops",
  manifest: {
    context_sources: [{
      id: "email_recent_threads",
      label: "Recent email threads",
      description:
        "Recent guest conversations, statuses, languages, and draft context.",
      type: "d1_query",
      access: "read",
      searchable: true,
      query:
        "SELECT id, subject FROM conversations WHERE user_id = :user_id AND subject LIKE :query ORDER BY updated_at DESC LIMIT :limit",
      default_for_widgets: ["email_inbox"],
      generation_hints: {
        tags: ["email", "guest", "approvals"],
        preferred_component: "table",
        entity_types: ["conversation", "draft"],
        safe_default_filters: { limit: 10 },
        prompt_examples: ["review pending guest email approvals"],
      },
    }],
    widgets: [{
      id: "email_inbox",
      label: "Email Approvals",
      description: "Review and act on guest draft approvals.",
      ui_function: "widget_email_inbox_ui",
      data_function: "widget_email_inbox_data",
      agentic: true,
      context_sources: ["email_recent_threads"],
      generation_hints: {
        tags: ["email approvals", "draft review"],
        preferred_component: "widget_embed",
        entity_types: ["conversation", "draft"],
        action_group: "draft_review",
      },
      cards: [{
        id: "drafts_queue",
        label: "Drafts Queue",
        description: "Guest draft replies waiting for approval.",
        size: "2x2",
        render: "native",
        kind: "list",
        data_view: "drafts_queue",
        generation_hints: {
          tags: ["approval queue", "guest drafts"],
          preferred_component: "table",
          entity_types: ["conversation", "draft"],
          suggested_components: [{
            kind: "detail",
            title: "Selected draft",
            description: "Show the selected guest draft and thread details.",
          }],
        },
      }, {
        id: "inbox_volume",
        label: "Inbox Volume",
        size: "2x1",
        render: "native",
        kind: "metric",
        data_view: "inbox_volume",
        generation_hints: {
          tags: ["email volume"],
          preferred_component: "metric",
          entity_types: ["conversation"],
        },
      }],
      agent_actions: [{
        id: "send_selected_draft",
        label: "Send selected draft",
        mode: "write",
        confirmation: "user",
        mcp: {
          function: "conversation_act",
          args_template: { action: "send" },
        },
      }],
    }],
    functions: {
      conversations_list: {
        description: "List active guest conversations and draft approvals.",
        parameters: {
          status: { type: "string", description: "Conversation status" },
          limit: { type: "number", description: "Maximum conversations" },
        },
        returns: { type: "array", description: "Conversation rows" },
        generation_hints: {
          tags: ["email", "approval queue"],
          preferred_component: "table",
          entity_types: ["conversation", "draft"],
          safe_default_filters: { status: "active", limit: 10 },
        },
      },
      conversation_history: {
        description: "Get full version history for a guest conversation.",
        parameters: {
          conversation_id: { type: "string", required: true },
        },
        returns: { type: "array", description: "Version history" },
        generation_hints: {
          tags: ["history", "versions"],
          preferred_component: "timeline",
          entity_types: ["conversation_version"],
        },
      },
      conversation_act: {
        description:
          "Take action on a conversation: send, discard, restore, save_edit, regenerate, or followup_draft.",
        parameters: {
          conversation_id: { type: "string", required: true },
          action: { type: "string", required: true },
        },
        returns: { type: "object", description: "Conversation action result" },
        generation_hints: {
          tags: ["send", "approve", "draft action"],
          action_group: "draft_review",
          entity_types: ["conversation", "draft"],
        },
      },
    },
  },
};

const studyCoachApp: AppForCodemode = {
  id: "app-study",
  name: "Study Coach",
  slug: "study-coach",
  manifest: {
    context_sources: [{
      id: "study_subject_progress",
      label: "Study subject progress",
      description: "Subjects, mastery, strengths, and weaknesses.",
      type: "d1_query",
      access: "read",
      searchable: true,
      query:
        "SELECT id, name FROM subjects WHERE user_id = :user_id AND name LIKE :query ORDER BY updated_at DESC LIMIT :limit",
      default_for_widgets: ["progress", "quiz"],
      generation_hints: {
        tags: ["study", "mastery", "weaknesses"],
        preferred_component: "table",
        entity_types: ["subject", "student_profile"],
        safe_default_filters: { limit: 10 },
      },
    }, {
      id: "study_recent_quizzes",
      label: "Recent quiz history",
      description: "Recent quiz sessions, scores, and weak areas.",
      type: "d1_query",
      access: "read",
      searchable: true,
      query:
        "SELECT id, status FROM quiz_sessions WHERE user_id = :user_id AND status LIKE :query ORDER BY started_at DESC LIMIT :limit",
      default_for_widgets: ["progress", "quiz"],
      generation_hints: {
        tags: ["quiz history", "scores"],
        preferred_component: "timeline",
        entity_types: ["quiz_session"],
      },
    }],
    widgets: [{
      id: "progress",
      label: "Study Progress",
      description: "Track mastery, weak concepts, and next lessons.",
      ui_function: "widget_progress_ui",
      data_function: "widget_progress_data",
      agentic: true,
      context_sources: ["study_subject_progress", "study_recent_quizzes"],
      generation_hints: {
        tags: ["study progress", "weak concepts"],
        preferred_component: "widget_embed",
        entity_types: ["subject", "quiz_session", "lesson"],
      },
      cards: [{
        id: "subject_mastery",
        label: "Subject Mastery",
        description: "Compare subjects by mastery and weakness.",
        size: "2x2",
        render: "native",
        kind: "table",
        data_view: "subject_mastery",
        generation_hints: {
          tags: ["mastery", "weak concepts"],
          preferred_component: "table",
          entity_types: ["subject"],
        },
      }, {
        id: "recent_quizzes",
        label: "Recent Quizzes",
        size: "2x1",
        render: "native",
        kind: "timeline",
        data_view: "recent_quizzes",
        generation_hints: {
          tags: ["quiz scores"],
          preferred_component: "timeline",
          entity_types: ["quiz_session"],
        },
      }],
    }],
    functions: {
      status: {
        description:
          "Overview of subjects, mastery levels, recent quiz scores, and weak areas.",
        parameters: {
          subject_id: { type: "string", description: "Subject filter" },
        },
        returns: { type: "object", description: "Study status" },
        generation_hints: {
          tags: ["study progress", "weaknesses"],
          preferred_component: "table",
          entity_types: ["subject", "student_profile"],
        },
      },
      study: {
        description:
          "Get concepts to review next, prioritized by spaced repetition.",
        parameters: {
          limit: { type: "number", description: "Maximum concepts" },
        },
        returns: { type: "array", description: "Review concepts" },
        generation_hints: {
          tags: ["review queue", "weak concepts"],
          preferred_component: "list",
          entity_types: ["concept"],
          safe_default_filters: { limit: 10 },
        },
      },
      start_quiz: {
        description: "Start an interactive quiz session for weak concepts.",
        parameters: {
          subject_id: { type: "string", description: "Subject id" },
          count: { type: "number", description: "Question count" },
        },
        returns: { type: "object", description: "Quiz session" },
        generation_hints: {
          tags: ["quiz", "practice"],
          preferred_component: "form",
          action_group: "quiz_flow",
          entity_types: ["quiz_session", "concept"],
        },
      },
      generate_lesson: {
        description:
          "Create a personalized lesson targeting specific weak concepts.",
        parameters: {
          subject_id: { type: "string", description: "Subject id" },
        },
        returns: { type: "object", description: "Lesson" },
        generation_hints: {
          tags: ["lesson", "weak concepts"],
          preferred_component: "form",
          action_group: "lesson_flow",
          entity_types: ["lesson", "concept"],
        },
      },
    },
  },
};

function functionIndexFromApps(apps: AppForCodemode[]): FunctionIndex {
  const descriptors = buildJsonSchemaDescriptors(apps);
  const appById = new Map(apps.map((app) => [app.id, app]));
  const functions: FunctionIndex["functions"] = {};

  for (const [sanitizedName, mapping] of Object.entries(descriptors.toolMap)) {
    const app = appById.get(mapping.appId);
    const fn = app?.manifest.functions?.[mapping.fnName];
    const params = descriptors.descriptors[sanitizedName]?.inputSchema
      ?.properties || {};
    const returns = typeof fn?.returns === "object" && fn.returns
      ? fn.returns.description || fn.returns.type || "unknown"
      : "unknown";
    functions[sanitizedName] = {
      appId: mapping.appId,
      appSlug: mapping.appSlug,
      fnName: mapping.fnName,
      description: fn?.description || mapping.fnName,
      params,
      returns,
      conventions: [],
      dependsOn: [],
      ...(mapping.generationHints
        ? { generationHints: mapping.generationHints }
        : {}),
    };
  }

  return {
    functions,
    widgets: descriptors.widgets,
    contextSources: descriptors.contextSources,
    routines: descriptors.routines,
    types: "",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };
}

function emptyFunctionIndex(): FunctionIndex {
  return {
    functions: {},
    widgets: [],
    contextSources: [],
    routines: [],
    types: "",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };
}

function hasUnsafeUiKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasUnsafeUiKey);
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
    if (hasUnsafeUiKey(nested)) return true;
  }
  return false;
}

function assertRenderableShape(spec: AgenticInterfaceSpec) {
  const componentIds = new Set(
    spec.components.map((component) => component.id),
  );
  const bindingIds = new Set(
    (spec.data_bindings || []).map((binding) => binding.id),
  );
  const actionIds = new Set((spec.actions || []).map((action) => action.id));

  for (const component of spec.components) {
    assert(
      COMPONENT_KINDS.has(component.kind),
      `unknown component kind ${component.kind}`,
    );
    if (component.data_binding_id) {
      assert(
        bindingIds.has(component.data_binding_id),
        `unknown binding ${component.data_binding_id}`,
      );
    }
    for (const actionId of component.action_ids || []) {
      assert(actionIds.has(actionId), `unknown action ${actionId}`);
    }
    if (component.kind === "form" && component.submit_action_id) {
      assert(
        actionIds.has(component.submit_action_id),
        `unknown submit action ${component.submit_action_id}`,
      );
    }
  }

  for (const item of spec.layout?.items || []) {
    assert(
      componentIds.has(item.component_id),
      `unknown layout component ${item.component_id}`,
    );
  }
}

function assertSeatbeltResult(
  label: string,
  result: AgenticInterfacePlannerResult,
) {
  assertEquals(result.validation.valid, true, `${label}: draft validation`);
  assertEquals(result.verification.verified, true, `${label}: verification`);
  assertEquals(result.dropped, [], `${label}: unexpected dropped items`);
  assertEquals(
    hasUnsafeUiKey(result.normalized_spec),
    false,
    `${label}: raw UI key`,
  );
  assert(
    result.normalized_spec.components.length > 0,
    `${label}: no components`,
  );
  assertRenderableShape(result.normalized_spec);

  for (const action of result.normalized_spec.actions || []) {
    if (action.mode === "write") {
      assert(
        action.confirmation && action.confirmation !== "none",
        `${label}: unsafe write action ${action.id}`,
      );
    }
  }
}

Deno.test("agentic interface fixtures: prompt matrix produces verified renderable specs", () => {
  const cases = [{
    label: "Email Ops only",
    fnIndex: functionIndexFromApps([emailOpsApp]),
    prompt: "review pending guest email approvals",
    expectedSlugs: ["email-ops"],
  }, {
    label: "Study Coach only",
    fnIndex: functionIndexFromApps([studyCoachApp]),
    prompt: "show weak concepts study progress and quiz history",
    expectedSlugs: ["study-coach"],
  }, {
    label: "Mixed Email Ops and Study Coach",
    fnIndex: functionIndexFromApps([emailOpsApp, studyCoachApp]),
    prompt: "show email approvals and study weak concepts",
    expectedSlugs: ["email-ops", "study-coach"],
  }];

  for (const testCase of cases) {
    const result = buildAgenticInterfacePlanFromFunctionIndex(
      testCase.fnIndex,
      {
        prompt: testCase.prompt,
        max_components: 10,
      },
    );
    assertSeatbeltResult(testCase.label, result);
    for (const appSlug of testCase.expectedSlugs) {
      assert(
        result.normalized_spec.scope?.app_slugs?.includes(appSlug),
        `${testCase.label}: expected ${appSlug} in scope`,
      );
    }
  }
});

Deno.test("agentic interface fixtures: no-match prompt returns typed safe empty state", () => {
  const result = buildAgenticInterfacePlanFromFunctionIndex(
    emptyFunctionIndex(),
    {
      prompt: "build a rocket telemetry command center",
      max_components: 4,
    },
  );

  assertEquals(result.validation.valid, true);
  assertEquals(result.verification.verified, true);
  assertEquals(result.normalized_spec.data_bindings, undefined);
  assertEquals(result.normalized_spec.actions, undefined);
  assertEquals(result.normalized_spec.components[0]?.kind, "text");
  assertEquals(hasUnsafeUiKey(result.normalized_spec), false);
  assert(
    result.warnings.some((warning) => warning.code === "no_matching_inventory"),
  );
  assertRenderableShape(result.normalized_spec);
});

Deno.test("agentic interface fixtures: saved spec re-verifies after original app is missing", () => {
  const emailIndex = functionIndexFromApps([emailOpsApp]);
  const planned = buildAgenticInterfacePlanFromFunctionIndex(emailIndex, {
    prompt: "review pending guest email approvals",
    mode: "saved",
    max_components: 8,
  });
  assertSeatbeltResult("saved source", planned);

  const changedIndex = functionIndexFromApps([studyCoachApp]);
  const changedInventory = flattenCommandSurfaceInventory(changedIndex);
  const reverification = verifyAgenticInterfaceSpec(planned.normalized_spec, {
    fnIndex: changedIndex,
    inventory: changedInventory,
  });

  assertEquals(reverification.verified, true);
  assert(reverification.dropped.length > 0);
  assert(
    reverification.dropped.some((item) =>
      item.reason.includes("unknown command card") ||
      item.reason.includes("unknown widget") ||
      item.reason.includes("unknown MCP")
    ),
  );
  assertEquals(hasUnsafeUiKey(reverification.spec), false);
  assertRenderableShape(reverification.spec);
  assert(
    reverification.spec.components.some((component) =>
      component.kind === "text"
    ),
  );
});
