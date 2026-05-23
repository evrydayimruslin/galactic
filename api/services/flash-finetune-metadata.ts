type JsonRecord = Record<string, unknown>;

export const FLASH_TIER = "flash" as const;

export const FLASH_TASK_IDS = [
  "flash_broker.analyze",
  "flash_broker.read_response",
  "flash_broker.prompt_builder",
  "orchestrate.execution_confirmation",
  "flash_broker.heuristic_fallback",
] as const;

export type FlashTaskId = typeof FLASH_TASK_IDS[number];

export const FLASH_SCHEMA_IDS = {
  analyze: "flash_broker.analyze.v1",
  readResponse: "flash_broker.read_response.v1",
  promptBuilder: "flash_broker.prompt_builder.v1",
  executionConfirmation: "orchestrate.execution_confirmation.v1",
  heuristicFallback: "flash_broker.heuristic_fallback.v1",
} as const;

export type FlashSchemaId =
  typeof FLASH_SCHEMA_IDS[keyof typeof FLASH_SCHEMA_IDS];

export const FLASH_CAPABILITIES = [
  "turn_mode_classification",
  "escalation_selection",
  "system_agent_delegation",
  "app_relevance_selection",
  "function_selection",
  "magnification_planning",
  "conversation_search_planning",
  "conversation_summary_update",
  "grounded_read_answer",
  "heavy_prompt_construction",
  "entity_resolution",
  "schema_conditioning",
  "execution_confirmation",
  "json_structured_output",
  "multimodal_context",
  "project_context_conditioning",
  "widget_context_conditioning",
  "heuristic_fallback",
] as const;

export type FlashCapability = typeof FLASH_CAPABILITIES[number];

export const FLASH_ESCALATION_TARGETS = [
  "none",
  "flash_read_response",
  "heavy_codemode",
  "tool_dealer",
  "tool_maker",
  "platform_guide",
  "mixed",
  "unknown",
] as const;

export type FlashEscalationTarget = typeof FLASH_ESCALATION_TARGETS[number];

export const FLASH_OUTPUT_SHAPES = [
  "json",
  "text",
  "structured_fallback",
] as const;

export type FlashOutputShape = typeof FLASH_OUTPUT_SHAPES[number];

export type FlashMode = "direct" | "read" | "write" | "unknown";

export type FlashSystemAgentType =
  | "tool_builder"
  | "tool_marketer"
  | "platform_manager"
  | "unknown";

export interface FlashSystemAgentDelegationLike {
  agentType?: unknown;
  task?: unknown;
  originalPrompt?: unknown;
}

export interface FlashEscalationInput {
  mode?: unknown;
  needsTool?: unknown;
  systemAgentDelegations?: unknown;
}

export interface FlashInputFeatureInput {
  files?: unknown;
  projectContext?: unknown;
  conversationHistory?: unknown;
  availableFunctionCount?: unknown;
  functionCount?: unknown;
  conventionCount?: unknown;
  scope?: unknown;
  systemAgentContext?: unknown;
  magnifiedData?: unknown;
  conversationSearch?: unknown;
  contextQuery?: unknown;
  activeWidgetContexts?: unknown;
  activeWidgetContextBlock?: unknown;
}

export interface FlashInputFeatures extends JsonRecord {
  has_files: boolean;
  has_image_files: boolean;
  file_count: number;
  has_project_context: boolean;
  conversation_history_count: number;
  available_function_count: number;
  function_count: number;
  convention_count: number;
  scope_mode: "none" | "scoped" | "unknown";
  has_system_agent_context: boolean;
  magnified_app_count: number;
  magnified_context_bytes: number;
  conversation_search_requested: boolean;
  context_query_present: boolean;
  has_active_widget_context: boolean;
  active_widget_context_count: number;
  active_widget_context_bytes: number;
}

export interface FlashInvocationMetadata extends JsonRecord {
  tier: typeof FLASH_TIER;
  component_id: FlashTaskId;
  schema_id: FlashSchemaId;
  output_shape: FlashOutputShape;
  capabilities: FlashCapability[];
  input_features: FlashInputFeatures | JsonRecord;
  output_labels?: JsonRecord;
}

export interface BuildFlashInvocationMetadataInput {
  taskId: FlashTaskId;
  schemaId?: FlashSchemaId;
  capabilities?: readonly FlashCapability[];
  inputFeatures?: FlashInputFeatureInput | JsonRecord;
  outputLabels?: JsonRecord;
  metadata?: JsonRecord;
}

export interface FlashAnalyzeOutputLabels extends JsonRecord {
  parse_success: boolean;
  mode: FlashMode;
  escalation_target: FlashEscalationTarget;
  relevant_app_count: number;
  action_function_count: number;
  system_agent_delegation_count: number;
  conversation_search_requested: boolean;
  context_query_present: boolean;
  updated_summary_present: boolean;
  direct_response_present: boolean;
  fallback_used: boolean;
}

export interface FlashPromptBuilderOutputLabels extends JsonRecord {
  parse_success: boolean;
  selected_heavy_model: string | null;
  entity_count: number;
  convention_count: number;
  prompt_bytes: number;
  prompt_present: boolean;
  fallback_used: boolean;
}

export interface FlashTextOutputLabels extends JsonRecord {
  parse_success: boolean;
  nonempty_response: boolean;
  response_bytes: number;
}

const DEFAULT_CAPABILITIES_BY_TASK: Record<
  FlashTaskId,
  readonly FlashCapability[]
> = {
  "flash_broker.analyze": [
    "turn_mode_classification",
    "escalation_selection",
    "system_agent_delegation",
    "app_relevance_selection",
    "function_selection",
    "magnification_planning",
    "conversation_search_planning",
    "conversation_summary_update",
    "json_structured_output",
  ],
  "flash_broker.read_response": [
    "grounded_read_answer",
  ],
  "flash_broker.prompt_builder": [
    "heavy_prompt_construction",
    "entity_resolution",
    "schema_conditioning",
    "json_structured_output",
  ],
  "orchestrate.execution_confirmation": [
    "execution_confirmation",
  ],
  "flash_broker.heuristic_fallback": [
    "heuristic_fallback",
  ],
};

const SCHEMA_ID_BY_TASK: Record<FlashTaskId, FlashSchemaId> = {
  "flash_broker.analyze": FLASH_SCHEMA_IDS.analyze,
  "flash_broker.read_response": FLASH_SCHEMA_IDS.readResponse,
  "flash_broker.prompt_builder": FLASH_SCHEMA_IDS.promptBuilder,
  "orchestrate.execution_confirmation": FLASH_SCHEMA_IDS.executionConfirmation,
  "flash_broker.heuristic_fallback": FLASH_SCHEMA_IDS.heuristicFallback,
};

const OUTPUT_SHAPE_BY_TASK: Record<FlashTaskId, FlashOutputShape> = {
  "flash_broker.analyze": "json",
  "flash_broker.read_response": "text",
  "flash_broker.prompt_builder": "json",
  "orchestrate.execution_confirmation": "text",
  "flash_broker.heuristic_fallback": "structured_fallback",
};

const SYSTEM_AGENT_ESCALATION_TARGETS: Record<
  Exclude<FlashSystemAgentType, "unknown">,
  Exclude<
    FlashEscalationTarget,
    "none" | "flash_read_response" | "heavy_codemode" | "mixed" | "unknown"
  >
> = {
  tool_builder: "tool_maker",
  tool_marketer: "tool_dealer",
  platform_manager: "platform_guide",
};

export function getFlashTaskSchemaId(taskId: FlashTaskId): FlashSchemaId {
  return SCHEMA_ID_BY_TASK[taskId];
}

export function getFlashTaskOutputShape(taskId: FlashTaskId): FlashOutputShape {
  return OUTPUT_SHAPE_BY_TASK[taskId];
}

export function getDefaultFlashCapabilities(
  taskId: FlashTaskId,
): FlashCapability[] {
  return [...DEFAULT_CAPABILITIES_BY_TASK[taskId]];
}

export function uniqueFlashCapabilities(
  capabilities: readonly FlashCapability[],
): FlashCapability[] {
  return [...new Set(capabilities)];
}

export function normalizeFlashMode(value: unknown): FlashMode {
  return value === "direct" || value === "read" || value === "write"
    ? value
    : "unknown";
}

export function normalizeSystemAgentType(value: unknown): FlashSystemAgentType {
  return value === "tool_builder" || value === "tool_marketer" ||
      value === "platform_manager"
    ? value
    : "unknown";
}

export function mapSystemAgentToEscalationTarget(
  value: unknown,
): Exclude<
  FlashEscalationTarget,
  "none" | "flash_read_response" | "heavy_codemode" | "mixed"
> {
  const agentType = normalizeSystemAgentType(value);
  return agentType === "unknown"
    ? "unknown"
    : SYSTEM_AGENT_ESCALATION_TARGETS[agentType];
}

export function inferFlashEscalationTarget(
  input: FlashEscalationInput,
): FlashEscalationTarget {
  const modeTarget = inferModeEscalationTarget(input.mode, input.needsTool);
  const delegationTargets = getSystemAgentDelegationTargets(
    input.systemAgentDelegations,
  );

  if (delegationTargets.length === 0) return modeTarget;
  if (delegationTargets.includes("unknown")) return "unknown";
  if (delegationTargets.length > 1) return "mixed";
  if (modeTarget === "heavy_codemode" || modeTarget === "flash_read_response") {
    return "mixed";
  }
  return delegationTargets[0];
}

export function buildFlashInputFeatures(
  input: FlashInputFeatureInput = {},
): FlashInputFeatures {
  const files = asArray(input.files);
  const magnifiedData = asRecord(input.magnifiedData);
  const activeWidgetContexts = asArray(input.activeWidgetContexts);
  const activeWidgetContextBlock = typeof input.activeWidgetContextBlock === "string"
    ? input.activeWidgetContextBlock
    : "";

  return {
    has_files: files.length > 0,
    has_image_files: files.some(isImageLikeFile),
    file_count: files.length,
    has_project_context: hasNonEmptyText(input.projectContext),
    conversation_history_count: asArray(input.conversationHistory).length,
    available_function_count: toNonNegativeInteger(
      input.availableFunctionCount,
    ),
    function_count: toNonNegativeInteger(input.functionCount),
    convention_count: toNonNegativeInteger(input.conventionCount),
    scope_mode: inferScopeMode(input.scope),
    has_system_agent_context: isNonNullObject(input.systemAgentContext),
    magnified_app_count: Object.keys(magnifiedData).length,
    magnified_context_bytes: sumStringBytes(Object.values(magnifiedData)),
    conversation_search_requested: Boolean(input.conversationSearch),
    context_query_present: hasNonEmptyText(input.contextQuery),
    has_active_widget_context: activeWidgetContexts.length > 0 ||
      hasNonEmptyText(activeWidgetContextBlock),
    active_widget_context_count: activeWidgetContexts.length,
    active_widget_context_bytes: byteLength(activeWidgetContextBlock),
  };
}

export function buildAnalyzeOutputLabels(
  output: unknown,
  options: { parseSuccess?: boolean; fallbackUsed?: boolean } = {},
): FlashAnalyzeOutputLabels {
  const record = asRecord(output);
  const parseSuccess = options.parseSuccess ?? Object.keys(record).length > 0;
  const mode = normalizeFlashMode(record.mode);
  const delegations = asArray(record.systemAgentDelegations);

  return {
    parse_success: parseSuccess,
    mode,
    escalation_target: inferFlashEscalationTarget({
      mode: record.mode,
      needsTool: record.needsTool,
      systemAgentDelegations: record.systemAgentDelegations,
    }),
    relevant_app_count: asArray(record.relevantApps).length,
    action_function_count: asArray(record.actionFunctions).length,
    system_agent_delegation_count: delegations.length,
    conversation_search_requested: Boolean(record.conversationSearch),
    context_query_present: hasNonEmptyText(record.contextQuery),
    updated_summary_present: hasNonEmptyText(record.updatedSummary),
    direct_response_present: hasNonEmptyText(record.directResponse),
    fallback_used: Boolean(options.fallbackUsed),
  };
}

export function buildPromptBuilderOutputLabels(
  output: unknown,
  options: { parseSuccess?: boolean; fallbackUsed?: boolean } = {},
): FlashPromptBuilderOutputLabels {
  const record = asRecord(output);
  const prompt = typeof record.prompt === "string" ? record.prompt : "";

  return {
    parse_success: options.parseSuccess ?? Object.keys(record).length > 0,
    selected_heavy_model:
      typeof record.model === "string" && record.model.trim()
        ? record.model
        : null,
    entity_count: asArray(record.entities).length,
    convention_count: asArray(record.conventions).length,
    prompt_bytes: byteLength(prompt),
    prompt_present: prompt.trim().length > 0,
    fallback_used: Boolean(options.fallbackUsed),
  };
}

export function buildReadResponseOutputLabels(
  text: unknown,
  options: { parseSuccess?: boolean } = {},
): FlashTextOutputLabels {
  const response = typeof text === "string" ? text : "";
  return {
    parse_success: options.parseSuccess ?? true,
    nonempty_response: response.trim().length > 0,
    response_bytes: byteLength(response),
  };
}

export function buildExecutionConfirmationOutputLabels(
  text: unknown,
  options: { parseSuccess?: boolean; executionResultAvailable?: boolean } = {},
): FlashTextOutputLabels & { execution_result_available: boolean } {
  return {
    ...buildReadResponseOutputLabels(text, options),
    execution_result_available: Boolean(options.executionResultAvailable),
  };
}

export function buildFlashInvocationMetadata(
  input: BuildFlashInvocationMetadataInput,
): FlashInvocationMetadata {
  const schemaId = input.schemaId ?? getFlashTaskSchemaId(input.taskId);
  const capabilities = uniqueFlashCapabilities([
    ...getDefaultFlashCapabilities(input.taskId),
    ...(input.capabilities || []),
    ...inferInputFeatureCapabilities(input.inputFeatures),
  ]);

  return {
    ...(input.metadata || {}),
    tier: FLASH_TIER,
    component_id: input.taskId,
    schema_id: schemaId,
    output_shape: getFlashTaskOutputShape(input.taskId),
    capabilities,
    input_features: isFlashInputFeatureInput(input.inputFeatures)
      ? buildFlashInputFeatures(input.inputFeatures)
      : (input.inputFeatures || {}),
    ...(input.outputLabels ? { output_labels: input.outputLabels } : {}),
  };
}

function inferModeEscalationTarget(
  modeValue: unknown,
  needsTool: unknown,
): FlashEscalationTarget {
  const mode = normalizeFlashMode(modeValue);
  if (mode === "direct") return "none";
  if (mode === "read") return "flash_read_response";
  if (mode === "write") return "heavy_codemode";
  if (needsTool === false) return "none";
  if (needsTool === true) return "heavy_codemode";
  return "unknown";
}

function getSystemAgentDelegationTargets(
  value: unknown,
): FlashEscalationTarget[] {
  const targets = asArray(value)
    .map((delegation) =>
      mapSystemAgentToEscalationTarget(asRecord(delegation).agentType)
    );
  return uniqueStrings(targets) as FlashEscalationTarget[];
}

function inferInputFeatureCapabilities(
  input: FlashInputFeatureInput | JsonRecord | undefined,
): FlashCapability[] {
  if (!input) return [];
  const features = isFlashInputFeatureInput(input)
    ? buildFlashInputFeatures(input)
    : input;
  const capabilities: FlashCapability[] = [];
  if (features.has_image_files === true || features.has_files === true) {
    capabilities.push("multimodal_context");
  }
  if (features.has_project_context === true) {
    capabilities.push("project_context_conditioning");
  }
  if (features.has_active_widget_context === true) {
    capabilities.push("widget_context_conditioning");
  }
  return capabilities;
}

function isFlashInputFeatureInput(
  input: unknown,
): input is FlashInputFeatureInput {
  if (!isNonNullObject(input)) return false;
  return [
    "files",
    "projectContext",
    "conversationHistory",
    "availableFunctionCount",
    "functionCount",
    "conventionCount",
    "scope",
    "systemAgentContext",
    "magnifiedData",
    "conversationSearch",
    "contextQuery",
    "activeWidgetContexts",
    "activeWidgetContextBlock",
  ].some((key) => key in input);
}

function inferScopeMode(scope: unknown): FlashInputFeatures["scope_mode"] {
  if (scope === undefined || scope === null) return "none";
  if (!isNonNullObject(scope)) return "unknown";
  return Object.keys(scope).length > 0 ? "scoped" : "none";
}

function asRecord(value: unknown): JsonRecord {
  return isNonNullObject(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isNonNullObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasNonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function toNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function isImageLikeFile(value: unknown): boolean {
  const file = asRecord(value);
  const mimeType = typeof file.mimeType === "string" ? file.mimeType : "";
  const content = typeof file.content === "string" ? file.content : "";
  return mimeType.startsWith("image/") || content.startsWith("data:image/");
}

function sumStringBytes(values: unknown[]): number {
  return values.reduce<number>(
    (total, value) =>
      total + byteLength(typeof value === "string" ? value : ""),
    0,
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
