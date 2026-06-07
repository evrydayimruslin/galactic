import type { ActiveBYOKProvider, BYOKModel, BYOKProviderCapabilities } from "../types/index.ts";
export interface AITextPart {
    type: "text";
    text: string;
}
export interface AIFilePart {
    type: "file";
    data: string;
    filename?: string;
}
export type AIContentPart = AITextPart | AIFilePart;
export interface AIMessage {
    role: "system" | "user" | "assistant";
    content: string | AIContentPart[];
    cache_control?: {
        type: "ephemeral";
    };
}
export interface AITool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
export interface AIRequest {
    model?: string;
    messages: AIMessage[];
    temperature?: number;
    max_tokens?: number;
    tools?: AITool[];
}
export interface AIUsage {
    input_tokens: number;
    output_tokens: number;
    cost_light: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
}
export interface AIResponse {
    content: string;
    model: string;
    usage: AIUsage;
    error?: string;
}
export interface ChatStreamRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ChatTool[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    inference?: InferenceRoutePreference;
    trace?: ChatTraceContext;
}
export interface ChatTraceContext {
    traceId?: string;
    conversationId?: string;
    messageId?: string;
    source?: string;
}
export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
    name?: string;
}
export interface ChatTool {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}
export interface ChatToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
export interface ChatUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
}
export interface ChatBillingResult {
    cost_light: number;
    balance_after: number;
    was_depleted: boolean;
}
export interface WidgetToolInvocationTelemetryContext {
    surfaceId?: string;
    widgetId?: string;
    actionId?: string;
    turnId?: string;
}
export interface ToolInvocationTelemetryRequest {
    invocationId: string;
    traceId?: string;
    conversationId?: string;
    parentLlmInvocationId?: string;
    source: string;
    toolCallId?: string;
    toolName: string;
    toolKind?: string;
    appId?: string;
    mcpId?: string;
    functionName?: string;
    receiptId?: string;
    routineId?: string;
    routineRunId?: string;
    schemaSnapshot?: unknown;
    args?: unknown;
    result?: unknown;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    status: "success" | "error" | "aborted" | "timeout";
    errorType?: string;
    errorMessage?: string;
    widgetAction?: WidgetToolInvocationTelemetryContext;
    metadata?: Record<string, unknown>;
}
export type InferenceBillingMode = "light" | "byok";
export interface InferenceRoutePreference {
    billingMode?: InferenceBillingMode;
    provider?: ActiveBYOKProvider;
    model?: string;
    webSearchEnabled?: boolean;
}
export type ChatInferenceSelectedPreference = Required<Pick<InferenceRoutePreference, "billingMode" | "provider" | "model">> & Pick<InferenceRoutePreference, "webSearchEnabled">;
export interface ChatInferenceProviderOption {
    id: ActiveBYOKProvider;
    name: string;
    description: string;
    protocol: "openai-compatible";
    baseUrl: string;
    defaultModel: string;
    models: BYOKModel[];
    capabilities: BYOKProviderCapabilities;
    apiKeyPrefix?: string;
    docsUrl: string;
    apiKeyUrl: string;
    configured: boolean;
    primary: boolean;
    configuredModel: string | null;
    addedAt: string | null;
}
export interface ChatInferenceLightOption {
    provider: "openrouter";
    defaultModel: string;
    models: BYOKModel[];
    balanceLight: number | null;
    minimumBalanceLight: number;
    usable: boolean;
    markup: number;
    unavailableReason?: string;
}
export interface ChatInferenceOptionsResponse {
    defaultBillingMode: InferenceBillingMode;
    selected: ChatInferenceSelectedPreference;
    light: ChatInferenceLightOption;
    providers: ChatInferenceProviderOption[];
    configuredProviderIds: ActiveBYOKProvider[];
}
export declare const CHAT_MIN_BALANCE_LIGHT = 50;
export declare const CHAT_PLATFORM_MARKUP = 1;
