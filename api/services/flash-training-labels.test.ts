import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  deriveFlashOutcomeLabels,
  deriveFlashOutcomeLabelsForInvocations,
  FLASH_OUTCOME_LABEL_TAXONOMY_VERSION,
  getFlashComponentId,
  isFlashInvocation,
} from "./flash-training-labels.ts";
import type {
  CaptureEventRow,
  ExecutionFailureRow,
  LlmInvocationRow,
  ToolInvocationRow,
  TrainingAnnotationRow,
} from "./capture-inspection.ts";

const TRACE_ID = "00000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "conv-flash-labels";

function invocation(
  overrides: Partial<LlmInvocationRow> = {},
): LlmInvocationRow {
  return {
    id: "row-llm-1",
    invocation_id: "flash-invocation-1",
    trace_id: TRACE_ID,
    conversation_id: CONVERSATION_ID,
    anon_user_id: "anon-1",
    source: "orchestrate",
    phase: "flash_broker.analyze",
    provider: "ultralight",
    requested_model: "deepseek-v4-flash",
    resolved_model: "deepseek-v4-flash",
    billing_mode: "light",
    key_source: "platform_deepseek",
    request_params: {},
    context_snapshot_id: "snapshot-1",
    context_sha256: "context-hash",
    context_bytes: 100,
    context_message_count: 2,
    tool_schema_count: 0,
    started_at: "2026-05-06T10:00:00Z",
    completed_at: "2026-05-06T10:00:01Z",
    duration_ms: 1000,
    status: "success",
    finish_reason: "stop",
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    cost_light: null,
    error_type: null,
    error_message: null,
    metadata: {
      tier: "flash",
      component_id: "flash_broker.analyze",
      schema_id: "flash_broker.analyze.v1",
      parse_success: true,
      output_labels: {
        parse_success: true,
        mode: "write",
        escalation_target: "heavy_codemode",
        relevant_app_count: 2,
        action_function_count: 1,
      },
    },
    ...overrides,
  };
}

function event(
  type: string,
  sequence: number,
  payload: Record<string, unknown> = {},
): CaptureEventRow {
  return {
    id: `event-${sequence}`,
    trace_id: TRACE_ID,
    conversation_id: CONVERSATION_ID,
    message_id: "assistant-message",
    anon_user_id: "anon-1",
    event_type: type,
    event_sequence: sequence,
    payload: { type, ...payload },
    payload_sha256: `event-hash-${sequence}`,
    created_at: `2026-05-06T10:00:0${sequence}Z`,
  };
}

function tool(
  status: string,
  overrides: Partial<ToolInvocationRow> = {},
): ToolInvocationRow {
  return {
    id: `tool-${status}`,
    invocation_id: `tool-${status}`,
    trace_id: TRACE_ID,
    conversation_id: CONVERSATION_ID,
    parent_llm_invocation_id: "heavy-invocation-1",
    anon_user_id: "anon-1",
    source: "orchestrate",
    tool_call_id: "tool-call-1",
    tool_name: "ul_codemode",
    tool_kind: "server_recipe",
    app_id: null,
    mcp_id: null,
    function_name: "ul_codemode",
    schema_snapshot: {},
    args_preview: {},
    args_artifact_id: null,
    args_sha256: null,
    args_bytes: 0,
    result_preview: {},
    result_artifact_id: null,
    result_sha256: null,
    result_bytes: 0,
    started_at: "2026-05-06T10:00:05Z",
    completed_at: "2026-05-06T10:00:06Z",
    duration_ms: 1000,
    status,
    error_type: status === "success" ? null : "recipe_execution_error",
    error_message: status === "success" ? null : "Recipe failed",
    metadata: {},
    ...overrides,
  };
}

function failure(
  overrides: Partial<ExecutionFailureRow> = {},
): ExecutionFailureRow {
  return {
    id: "failure-1",
    failure_id: "failure-1",
    trace_id: TRACE_ID,
    conversation_id: CONVERSATION_ID,
    invocation_id: "flash-invocation-1",
    anon_user_id: "anon-1",
    source: "orchestrate",
    phase: "flash_broker.analyze",
    failure_type: "json_parse_error",
    severity: "warn",
    message: "bad json",
    retryable: null,
    aborted_by: null,
    metadata: {},
    created_at: "2026-05-06T10:00:02Z",
    ...overrides,
  };
}

function annotation(
  overrides: Partial<TrainingAnnotationRow> = {},
): TrainingAnnotationRow {
  return {
    id: "annotation-1",
    target_type: "llm_invocation",
    target_id: "flash-invocation-1",
    conversation_id: CONVERSATION_ID,
    message_id: null,
    llm_invocation_id: "flash-invocation-1",
    tool_invocation_id: null,
    artifact_id: null,
    annotation_type: "quality",
    label: "accept",
    confidence: 0.95,
    payload: {},
    taxonomy_version: "manual.v1",
    classifier_model: null,
    classifier_version: null,
    status: "reviewed",
    reviewed_by: null,
    reviewed_at: null,
    metadata: {},
    created_at: "2026-05-06T10:00:07Z",
    ...overrides,
  };
}

Deno.test("flash training labels: identifies Flash invocations by metadata or phase", () => {
  assertEquals(isFlashInvocation(invocation()), true);
  assertEquals(getFlashComponentId(invocation()), "flash_broker.analyze");
  assertEquals(
    isFlashInvocation(invocation({
      phase: "flash_broker.read_response",
      metadata: {},
    })),
    true,
  );
  assertEquals(
    isFlashInvocation(invocation({
      phase: "heavy_model",
      metadata: { tier: "heavy", component_id: "heavy_model" },
    })),
    false,
  );
});

Deno.test("flash training labels: derives downstream Heavy and execution success labels", () => {
  const result = deriveFlashOutcomeLabels(invocation(), {
    events: [
      event("flash_prompt", 1),
      event("heavy_status", 2),
      event("heavy_text", 3),
      event("plan_ready", 4, {
        plan: {
          tools_used: [{ fnName: "notes_create" }],
        },
      }),
      event("exec_start", 5),
      event("exec_result", 6, { data: { ok: true } }),
      event("done", 7),
    ],
    toolInvocations: [tool("success")],
    trainingAnnotations: [annotation()],
  });

  assertEquals(result.taxonomy_version, FLASH_OUTCOME_LABEL_TAXONOMY_VERSION);
  assertEquals(result.component_id, "flash_broker.analyze");
  assertEquals(result.labels.provider_success, true);
  assertEquals(result.labels.parse_success, true);
  assertEquals(result.labels.model_output_escalation_target, "heavy_codemode");
  assertEquals(result.labels.downstream_heavy_called, true);
  assertEquals(result.labels.downstream_recipe_parsed, true);
  assertEquals(result.labels.downstream_execution_success, true);
  assertEquals(result.labels.downstream_tool_success_count, 1);
  assertEquals(result.labels.planned_tool_names, ["notes_create"]);
  assertEquals(result.labels.training_candidate, true);
  assertEquals(result.labels.needs_human_review, false);
});

Deno.test("flash training labels: marks errors and failures as needing review", () => {
  const result = deriveFlashOutcomeLabels(
    invocation({
      status: "error",
      error_type: "json_parse_error",
      metadata: {
        tier: "flash",
        component_id: "flash_broker.analyze",
        parse_success: false,
        output_labels: { parse_success: false },
      },
    }),
    {
      events: [
        event("flash_status", 1),
        event("error", 2, { message: "Flash broker failed" }),
        event("done", 3),
      ],
      executionFailures: [failure()],
    },
  );

  assertEquals(result.labels.provider_success, false);
  assertEquals(result.labels.parse_success, false);
  assertEquals(result.labels.downstream_user_visible_error, true);
  assertEquals(result.labels.downstream_error_count, 1);
  assertEquals(result.labels.downstream_failure_count, 1);
  assertEquals(result.labels.downstream_failure_types, ["json_parse_error"]);
  assertEquals(result.labels.training_candidate, false);
  assertEquals(result.labels.needs_human_review, true);
});

Deno.test("flash training labels: prompt-builder needs parsed recipe and no tool errors", () => {
  const promptInvocation = invocation({
    phase: "flash_broker.prompt_builder",
    metadata: {
      tier: "flash",
      component_id: "flash_broker.prompt_builder",
      schema_id: "flash_broker.prompt_builder.v1",
      parse_success: true,
      output_labels: {
        parse_success: true,
        prompt_present: true,
      },
    },
  });

  const result = deriveFlashOutcomeLabels(promptInvocation, {
    events: [
      event("flash_prompt", 1),
      event("heavy_recipe", 2),
      event("plan_ready", 3),
      event("exec_start", 4),
      event("exec_result", 5),
      event("done", 6),
    ],
    toolInvocations: [tool("error")],
  });

  assertEquals(result.labels.downstream_recipe_parsed, true);
  assertEquals(result.labels.downstream_tool_error_count, 1);
  assertEquals(result.labels.training_candidate, false);
  assertEquals(result.labels.needs_human_review, true);
});

Deno.test("flash training labels: derives labels only for Flash invocations in batch helper", () => {
  const results = deriveFlashOutcomeLabelsForInvocations([
    invocation({ invocation_id: "flash-1" }),
    invocation({
      invocation_id: "heavy-1",
      phase: "heavy_model",
      metadata: { tier: "heavy", component_id: "heavy_model" },
    }),
    invocation({
      invocation_id: "flash-2",
      phase: "orchestrate.execution_confirmation",
      metadata: { component_id: "orchestrate.execution_confirmation" },
    }),
  ], {
    events: [event("done", 1)],
  });

  assertEquals(results.map((result) => result.invocation_id), [
    "flash-1",
    "flash-2",
  ]);
});
