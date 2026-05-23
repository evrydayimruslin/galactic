import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  buildAnalyzeOutputLabels,
  buildExecutionConfirmationOutputLabels,
  buildFlashInputFeatures,
  buildFlashInvocationMetadata,
  buildPromptBuilderOutputLabels,
  buildReadResponseOutputLabels,
  FLASH_SCHEMA_IDS,
  getDefaultFlashCapabilities,
  getFlashTaskOutputShape,
  getFlashTaskSchemaId,
  inferFlashEscalationTarget,
  mapSystemAgentToEscalationTarget,
  normalizeFlashMode,
  normalizeSystemAgentType,
  uniqueFlashCapabilities,
} from "./flash-finetune-metadata.ts";

Deno.test("flash finetune metadata: schema and output shape mappings are stable", () => {
  assertEquals(
    getFlashTaskSchemaId("flash_broker.analyze"),
    FLASH_SCHEMA_IDS.analyze,
  );
  assertEquals(
    getFlashTaskSchemaId("flash_broker.read_response"),
    FLASH_SCHEMA_IDS.readResponse,
  );
  assertEquals(
    getFlashTaskSchemaId("flash_broker.prompt_builder"),
    FLASH_SCHEMA_IDS.promptBuilder,
  );
  assertEquals(
    getFlashTaskSchemaId("orchestrate.execution_confirmation"),
    FLASH_SCHEMA_IDS.executionConfirmation,
  );
  assertEquals(
    getFlashTaskSchemaId("flash_broker.heuristic_fallback"),
    FLASH_SCHEMA_IDS.heuristicFallback,
  );

  assertEquals(getFlashTaskOutputShape("flash_broker.analyze"), "json");
  assertEquals(getFlashTaskOutputShape("flash_broker.read_response"), "text");
  assertEquals(getFlashTaskOutputShape("flash_broker.prompt_builder"), "json");
  assertEquals(
    getFlashTaskOutputShape("orchestrate.execution_confirmation"),
    "text",
  );
  assertEquals(
    getFlashTaskOutputShape("flash_broker.heuristic_fallback"),
    "structured_fallback",
  );
});

Deno.test("flash finetune metadata: default task capabilities match current Flash responsibilities", () => {
  assertEquals(getDefaultFlashCapabilities("flash_broker.analyze"), [
    "turn_mode_classification",
    "escalation_selection",
    "system_agent_delegation",
    "app_relevance_selection",
    "function_selection",
    "magnification_planning",
    "conversation_search_planning",
    "conversation_summary_update",
    "json_structured_output",
  ]);
  assertEquals(getDefaultFlashCapabilities("flash_broker.prompt_builder"), [
    "heavy_prompt_construction",
    "entity_resolution",
    "schema_conditioning",
    "json_structured_output",
  ]);
  assertEquals(
    uniqueFlashCapabilities([
      "json_structured_output",
      "entity_resolution",
      "json_structured_output",
    ]),
    ["json_structured_output", "entity_resolution"],
  );
});

Deno.test("flash finetune metadata: mode and system-agent normalization are conservative", () => {
  assertEquals(normalizeFlashMode("direct"), "direct");
  assertEquals(normalizeFlashMode("read"), "read");
  assertEquals(normalizeFlashMode("write"), "write");
  assertEquals(normalizeFlashMode("other"), "unknown");

  assertEquals(normalizeSystemAgentType("tool_builder"), "tool_builder");
  assertEquals(normalizeSystemAgentType("tool_marketer"), "tool_marketer");
  assertEquals(
    normalizeSystemAgentType("platform_manager"),
    "platform_manager",
  );
  assertEquals(normalizeSystemAgentType("sales_agent"), "unknown");

  assertEquals(mapSystemAgentToEscalationTarget("tool_builder"), "tool_maker");
  assertEquals(
    mapSystemAgentToEscalationTarget("tool_marketer"),
    "tool_dealer",
  );
  assertEquals(
    mapSystemAgentToEscalationTarget("platform_manager"),
    "platform_guide",
  );
  assertEquals(mapSystemAgentToEscalationTarget("sales_agent"), "unknown");
});

Deno.test("flash finetune metadata: escalation target inference covers direct/read/write", () => {
  assertEquals(inferFlashEscalationTarget({ mode: "direct" }), "none");
  assertEquals(
    inferFlashEscalationTarget({ mode: "read" }),
    "flash_read_response",
  );
  assertEquals(inferFlashEscalationTarget({ mode: "write" }), "heavy_codemode");
  assertEquals(inferFlashEscalationTarget({ needsTool: false }), "none");
  assertEquals(
    inferFlashEscalationTarget({ needsTool: true }),
    "heavy_codemode",
  );
  assertEquals(inferFlashEscalationTarget({}), "unknown");
});

Deno.test("flash finetune metadata: escalation target inference covers pure system-agent targets", () => {
  assertEquals(
    inferFlashEscalationTarget({
      mode: "direct",
      systemAgentDelegations: [{ agentType: "tool_marketer" }],
    }),
    "tool_dealer",
  );
  assertEquals(
    inferFlashEscalationTarget({
      mode: "direct",
      systemAgentDelegations: [{ agentType: "tool_builder" }],
    }),
    "tool_maker",
  );
  assertEquals(
    inferFlashEscalationTarget({
      mode: "direct",
      systemAgentDelegations: [{ agentType: "platform_manager" }],
    }),
    "platform_guide",
  );
});

Deno.test("flash finetune metadata: escalation target inference marks mixed paths", () => {
  assertEquals(
    inferFlashEscalationTarget({
      mode: "write",
      systemAgentDelegations: [{ agentType: "tool_builder" }],
    }),
    "mixed",
  );
  assertEquals(
    inferFlashEscalationTarget({
      mode: "read",
      systemAgentDelegations: [{ agentType: "tool_marketer" }],
    }),
    "mixed",
  );
  assertEquals(
    inferFlashEscalationTarget({
      mode: "direct",
      systemAgentDelegations: [
        { agentType: "tool_marketer" },
        { agentType: "platform_manager" },
      ],
    }),
    "mixed",
  );
  assertEquals(
    inferFlashEscalationTarget({
      mode: "direct",
      systemAgentDelegations: [{ agentType: "unknown_agent" }],
    }),
    "unknown",
  );
});

Deno.test("flash finetune metadata: input feature builder summarizes context without storing content", () => {
  assertEquals(
    buildFlashInputFeatures({
      files: [
        { name: "notes.txt", mimeType: "text/plain", content: "hello" },
        {
          name: "diagram.png",
          mimeType: "image/png",
          content: "data:image/png;base64,abc",
        },
      ],
      projectContext: "src/index.ts",
      conversationHistory: [{ role: "user", content: "hi" }, {
        role: "assistant",
        content: "hello",
      }],
      availableFunctionCount: 12.8,
      functionCount: 3,
      conventionCount: 2,
      scope: { notes: { access: "all" } },
      systemAgentContext: { persona: "Tool Maker" },
      magnifiedData: {
        notes: "abc",
        tasks: "hello",
      },
      conversationSearch: true,
      contextQuery: "Sarah notes",
      activeWidgetContexts: [{ surfaceId: "surface-1" }],
      activeWidgetContextBlock: "## Active Widget Context\n### Inbox\n",
    }),
    {
      has_files: true,
      has_image_files: true,
      file_count: 2,
      has_project_context: true,
      conversation_history_count: 2,
      available_function_count: 12,
      function_count: 3,
      convention_count: 2,
      scope_mode: "scoped",
      has_system_agent_context: true,
      magnified_app_count: 2,
      magnified_context_bytes: 8,
      conversation_search_requested: true,
      context_query_present: true,
      has_active_widget_context: true,
      active_widget_context_count: 1,
      active_widget_context_bytes: 35,
    },
  );
});

Deno.test("flash finetune metadata: analyze output labels derive route and selection fields", () => {
  assertEquals(
    buildAnalyzeOutputLabels({
      mode: "write",
      relevantApps: ["notes", "tasks"],
      actionFunctions: ["notes_create"],
      systemAgentDelegations: [],
      conversationSearch: true,
      updatedSummary: "User is planning launch.",
      contextQuery: "launch notes",
      directResponse: "",
    }),
    {
      parse_success: true,
      mode: "write",
      escalation_target: "heavy_codemode",
      relevant_app_count: 2,
      action_function_count: 1,
      system_agent_delegation_count: 0,
      conversation_search_requested: true,
      context_query_present: true,
      updated_summary_present: true,
      direct_response_present: false,
      fallback_used: false,
    },
  );

  assertEquals(
    buildAnalyzeOutputLabels(null, { parseSuccess: false, fallbackUsed: true }),
    {
      parse_success: false,
      mode: "unknown",
      escalation_target: "unknown",
      relevant_app_count: 0,
      action_function_count: 0,
      system_agent_delegation_count: 0,
      conversation_search_requested: false,
      context_query_present: false,
      updated_summary_present: false,
      direct_response_present: false,
      fallback_used: true,
    },
  );
});

Deno.test("flash finetune metadata: prompt-builder and text labels summarize outputs", () => {
  assertEquals(
    buildPromptBuilderOutputLabels({
      prompt: "Use notes_create with project id p1.",
      model: "ultralight/deepseek-v4-pro",
      entities: [{ name: "Launch", id: "p1" }],
      conventions: [{ key: "tone", value: "brief" }],
    }),
    {
      parse_success: true,
      selected_heavy_model: "ultralight/deepseek-v4-pro",
      entity_count: 1,
      convention_count: 1,
      prompt_bytes: 36,
      prompt_present: true,
      fallback_used: false,
    },
  );

  assertEquals(buildReadResponseOutputLabels("Done."), {
    parse_success: true,
    nonempty_response: true,
    response_bytes: 5,
  });
  assertEquals(
    buildExecutionConfirmationOutputLabels("Created the task.", {
      executionResultAvailable: true,
    }),
    {
      parse_success: true,
      nonempty_response: true,
      response_bytes: 17,
      execution_result_available: true,
    },
  );
});

Deno.test("flash finetune metadata: invocation metadata builds a stable training envelope", () => {
  assertEquals(
    buildFlashInvocationMetadata({
      taskId: "flash_broker.analyze",
      capabilities: ["system_agent_delegation", "json_structured_output"],
      inputFeatures: {
        files: [{ mimeType: "image/png" }],
        projectContext: "package.json",
        availableFunctionCount: 5,
      },
      outputLabels: {
        escalation_target: "tool_dealer",
      },
      metadata: {
        route_provider: "ultralight",
      },
    }),
    {
      route_provider: "ultralight",
      tier: "flash",
      component_id: "flash_broker.analyze",
      schema_id: "flash_broker.analyze.v1",
      output_shape: "json",
      capabilities: [
        "turn_mode_classification",
        "escalation_selection",
        "system_agent_delegation",
        "app_relevance_selection",
        "function_selection",
        "magnification_planning",
        "conversation_search_planning",
        "conversation_summary_update",
        "json_structured_output",
        "multimodal_context",
        "project_context_conditioning",
      ],
      input_features: {
        has_files: true,
        has_image_files: true,
        file_count: 1,
        has_project_context: true,
        conversation_history_count: 0,
        available_function_count: 5,
        function_count: 0,
        convention_count: 0,
        scope_mode: "none",
        has_system_agent_context: false,
        magnified_app_count: 0,
        magnified_context_bytes: 0,
        conversation_search_requested: false,
        context_query_present: false,
        has_active_widget_context: false,
        active_widget_context_count: 0,
        active_widget_context_bytes: 0,
      },
      output_labels: {
        escalation_target: "tool_dealer",
      },
    },
  );
});
