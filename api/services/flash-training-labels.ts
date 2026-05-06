import type {
  CaptureEventRow,
  ExecutionFailureRow,
  LlmInvocationRow,
  ToolInvocationRow,
  TrainingAnnotationRow,
} from "./capture-inspection.ts";

type JsonRecord = Record<string, unknown>;

export const FLASH_OUTCOME_LABEL_TAXONOMY_VERSION = "flash-outcome-labels.v1";

export interface FlashOutcomeLabelRows {
  events?: CaptureEventRow[];
  toolInvocations?: ToolInvocationRow[];
  executionFailures?: ExecutionFailureRow[];
  trainingAnnotations?: TrainingAnnotationRow[];
}

export interface FlashOutcomeLabelResult {
  taxonomy_version: typeof FLASH_OUTCOME_LABEL_TAXONOMY_VERSION;
  invocation_id: string;
  component_id: string;
  labels: JsonRecord;
}

const FLASH_COMPONENT_IDS = new Set<string>([
  "flash_broker.analyze",
  "flash_broker.read_response",
  "flash_broker.prompt_builder",
  "orchestrate.execution_confirmation",
  "flash_broker.heuristic_fallback",
]);

export function isFlashInvocation(
  invocation: Pick<LlmInvocationRow, "phase" | "metadata">,
): boolean {
  const metadata = asRecord(invocation.metadata);
  const componentId = getFlashComponentId(invocation);
  return metadata.tier === "flash" || FLASH_COMPONENT_IDS.has(componentId);
}

export function getFlashComponentId(
  invocation: Pick<LlmInvocationRow, "phase" | "metadata">,
): string {
  const metadata = asRecord(invocation.metadata);
  return stringFrom(metadata.component_id) || stringFrom(invocation.phase) ||
    "unknown";
}

export function deriveFlashOutcomeLabels(
  invocation: Pick<
    LlmInvocationRow,
    | "invocation_id"
    | "trace_id"
    | "conversation_id"
    | "phase"
    | "provider"
    | "requested_model"
    | "resolved_model"
    | "status"
    | "finish_reason"
    | "usage"
    | "duration_ms"
    | "error_type"
    | "error_message"
    | "metadata"
  >,
  rows: FlashOutcomeLabelRows = {},
): FlashOutcomeLabelResult {
  const componentId = getFlashComponentId(invocation);
  const outputLabels = asRecord(asRecord(invocation.metadata).output_labels);
  const matchingEvents = scopedEvents(invocation, rows.events || []);
  const eventSummary = summarizeEvents(matchingEvents);
  const matchingTools = scopedToolInvocations(
    invocation,
    rows.toolInvocations || [],
  );
  const toolSummary = summarizeToolInvocations(matchingTools);
  const matchingFailures = scopedFailures(
    invocation,
    rows.executionFailures || [],
  );
  const failureSummary = summarizeExecutionFailures(matchingFailures);
  const matchingAnnotations = scopedAnnotations(
    invocation,
    rows.trainingAnnotations || [],
  );
  const annotationSummary = summarizeAnnotations(matchingAnnotations);
  const providerSuccess = invocation.status === "success";
  const parseSuccess =
    booleanFrom(asRecord(invocation.metadata).parse_success) ??
      booleanFrom(outputLabels.parse_success) ??
      (providerSuccess && !invocation.error_type);

  const labels: JsonRecord = {
    component_id: componentId,
    schema_id: stringFrom(asRecord(invocation.metadata).schema_id) || null,
    provider: invocation.provider || null,
    requested_model: invocation.requested_model || null,
    resolved_model: invocation.resolved_model || null,
    invocation_status: invocation.status,
    provider_success: providerSuccess,
    parse_success: parseSuccess,
    finish_reason: invocation.finish_reason || null,
    error_type: invocation.error_type || null,
    error_message_present: !!invocation.error_message,
    duration_ms: numberFrom(invocation.duration_ms),
    prompt_tokens: numberFrom(asRecord(invocation.usage).prompt_tokens),
    completion_tokens: numberFrom(asRecord(invocation.usage).completion_tokens),
    total_tokens: numberFrom(asRecord(invocation.usage).total_tokens),
    ...prefixRecord(outputLabels, "model_output"),
    ...eventSummary,
    ...toolSummary,
    ...failureSummary,
    ...annotationSummary,
  };

  labels.training_candidate = isTrainingCandidate(labels, componentId);
  labels.needs_human_review = needsHumanReview(labels);

  return {
    taxonomy_version: FLASH_OUTCOME_LABEL_TAXONOMY_VERSION,
    invocation_id: invocation.invocation_id,
    component_id: componentId,
    labels,
  };
}

export function deriveFlashOutcomeLabelsForInvocations(
  invocations: Array<Parameters<typeof deriveFlashOutcomeLabels>[0]>,
  rows: FlashOutcomeLabelRows = {},
): FlashOutcomeLabelResult[] {
  return invocations
    .filter(isFlashInvocation)
    .map((invocation) => deriveFlashOutcomeLabels(invocation, rows));
}

function summarizeEvents(events: CaptureEventRow[]): JsonRecord {
  const sorted = [...events].sort(compareEvents);
  const eventTypes = sorted.map((event) => event.event_type);
  const eventTypeSet = new Set(eventTypes);
  const execStartIndex = eventTypes.indexOf("exec_start");
  const errorEvents = sorted.filter((event) => event.event_type === "error");
  const errorsAfterExecutionStart = execStartIndex >= 0
    ? sorted.slice(execStartIndex).filter((event) =>
      event.event_type === "error"
    )
    : [];
  const planReadyEvents = sorted.filter((event) =>
    event.event_type === "plan_ready"
  );
  const planReadyPayload = asRecord(planReadyEvents[0]?.payload);
  const plan = asRecord(planReadyPayload.plan);
  const toolsUsed = asArray(plan.tools_used);

  return {
    event_count: sorted.length,
    first_event_type: eventTypes[0] || null,
    last_event_type: eventTypes[eventTypes.length - 1] || null,
    downstream_done: eventTypeSet.has("done"),
    downstream_heavy_called: eventTypeSet.has("heavy_status") ||
      eventTypeSet.has("heavy_text") ||
      eventTypeSet.has("heavy_recipe") ||
      eventTypeSet.has("plan_ready"),
    downstream_heavy_text_event_count:
      eventTypes.filter((type) => type === "heavy_text").length,
    downstream_plan_ready: eventTypeSet.has("plan_ready"),
    downstream_plan_cancelled: eventTypeSet.has("plan_cancelled"),
    downstream_recipe_available: eventTypeSet.has("heavy_recipe") ||
      eventTypeSet.has("plan_ready"),
    downstream_recipe_parsed: eventTypeSet.has("plan_ready"),
    downstream_execution_started: eventTypeSet.has("exec_start"),
    downstream_execution_success: eventTypeSet.has("exec_result") &&
      errorsAfterExecutionStart.length === 0,
    downstream_exec_result_available: eventTypeSet.has("exec_result"),
    downstream_user_visible_error: errorEvents.length > 0,
    downstream_error_count: errorEvents.length,
    downstream_error_messages: errorEvents
      .map((event) => stringFrom(asRecord(event.payload).message))
      .filter(Boolean)
      .slice(0, 5),
    flash_direct_emitted: eventTypeSet.has("flash_direct"),
    flash_direct_event_count:
      eventTypes.filter((type) => type === "flash_direct").length,
    system_agent_spawn_count:
      eventTypes.filter((type) => type === "system_agent_spawn").length,
    planned_tool_count: toolsUsed.length,
    planned_tool_names: toolsUsed
      .map((tool) =>
        stringFrom(asRecord(tool).fnName) || stringFrom(asRecord(tool).fn_name)
      )
      .filter(Boolean),
  };
}

function summarizeToolInvocations(tools: ToolInvocationRow[]): JsonRecord {
  const successCount = tools.filter((tool) => tool.status === "success").length;
  const errorTools = tools.filter((tool) => tool.status !== "success");
  return {
    downstream_tool_invocation_count: tools.length,
    downstream_tool_success_count: successCount,
    downstream_tool_error_count: errorTools.length,
    downstream_tool_names: uniqueStrings(
      tools.map((tool) => tool.function_name || tool.tool_name).filter(Boolean),
    ),
    downstream_tool_error_types: uniqueStrings(
      errorTools.map((tool) => tool.error_type).filter(Boolean),
    ),
  };
}

function summarizeExecutionFailures(
  failures: ExecutionFailureRow[],
): JsonRecord {
  return {
    downstream_failure_count: failures.length,
    downstream_failure_types: uniqueStrings(
      failures.map((failure) => failure.failure_type).filter(Boolean),
    ),
    downstream_failure_phases: uniqueStrings(
      failures.map((failure) => failure.phase).filter(Boolean),
    ),
  };
}

function summarizeAnnotations(
  annotations: TrainingAnnotationRow[],
): JsonRecord {
  const reviewed = annotations.filter((annotation) =>
    annotation.status !== "pending_review"
  );
  const rejected = annotations.filter((annotation) =>
    annotation.status === "rejected" || annotation.label === "reject" ||
    annotation.label === "rejected"
  );
  return {
    annotation_count: annotations.length,
    reviewed_annotation_count: reviewed.length,
    rejected_annotation_count: rejected.length,
    annotation_labels: uniqueStrings(
      annotations.map((annotation) => annotation.label).filter(Boolean),
    ),
    annotation_types: uniqueStrings(
      annotations.map((annotation) => annotation.annotation_type).filter(
        Boolean,
      ),
    ),
    annotation_statuses: uniqueStrings(
      annotations.map((annotation) => annotation.status).filter(Boolean),
    ),
  };
}

function scopedEvents(
  invocation: Pick<LlmInvocationRow, "trace_id" | "conversation_id">,
  events: CaptureEventRow[],
): CaptureEventRow[] {
  return events.filter((event) => sameTraceOrConversation(invocation, event));
}

function scopedToolInvocations(
  invocation: Pick<
    LlmInvocationRow,
    "trace_id" | "conversation_id" | "invocation_id"
  >,
  tools: ToolInvocationRow[],
): ToolInvocationRow[] {
  return tools.filter((tool) =>
    tool.parent_llm_invocation_id === invocation.invocation_id ||
    sameTraceOrConversation(invocation, tool)
  );
}

function scopedFailures(
  invocation: Pick<
    LlmInvocationRow,
    "trace_id" | "conversation_id" | "invocation_id"
  >,
  failures: ExecutionFailureRow[],
): ExecutionFailureRow[] {
  return failures.filter((failure) =>
    failure.invocation_id === invocation.invocation_id ||
    sameTraceOrConversation(invocation, failure)
  );
}

function scopedAnnotations(
  invocation: Pick<LlmInvocationRow, "invocation_id" | "conversation_id">,
  annotations: TrainingAnnotationRow[],
): TrainingAnnotationRow[] {
  return annotations.filter((annotation) =>
    annotation.llm_invocation_id === invocation.invocation_id ||
    annotation.target_id === invocation.invocation_id ||
    (!!invocation.conversation_id &&
      annotation.conversation_id === invocation.conversation_id)
  );
}

function sameTraceOrConversation(
  invocation: Pick<LlmInvocationRow, "trace_id" | "conversation_id">,
  row: { trace_id?: string | null; conversation_id?: string | null },
): boolean {
  if (invocation.trace_id && row.trace_id) {
    return invocation.trace_id === row.trace_id;
  }
  if (invocation.conversation_id && row.conversation_id) {
    return invocation.conversation_id === row.conversation_id;
  }
  return false;
}

function compareEvents(a: CaptureEventRow, b: CaptureEventRow): number {
  if (a.event_sequence !== b.event_sequence) {
    return a.event_sequence - b.event_sequence;
  }
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}

function isTrainingCandidate(labels: JsonRecord, componentId: string): boolean {
  if (
    labels.rejected_annotation_count &&
    numberFrom(labels.rejected_annotation_count) > 0
  ) return false;
  if (labels.provider_success !== true || labels.parse_success !== true) {
    return false;
  }
  if (numberFrom(labels.downstream_failure_count) > 0) return false;
  if (numberFrom(labels.downstream_tool_error_count) > 0) return false;
  if (labels.downstream_user_visible_error === true) return false;
  if (componentId === "flash_broker.prompt_builder") {
    return labels.downstream_recipe_parsed === true;
  }
  return true;
}

function needsHumanReview(labels: JsonRecord): boolean {
  if (labels.training_candidate !== true) return true;
  if (numberFrom(labels.annotation_count) === 0) return true;
  return false;
}

function prefixRecord(record: JsonRecord, prefix: string): JsonRecord {
  const prefixed: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    prefixed[`${prefix}_${key}`] = value;
  }
  return prefixed;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringFrom(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanFrom(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values.filter((value): value is string =>
        typeof value === "string" && value.length > 0
      ),
    ),
  ];
}
