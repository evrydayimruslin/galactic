import type { ActiveBYOKProvider, BYOKModel, BYOKProviderCapabilities } from '../types/index.ts';

export interface AITextPart {
  type: 'text';
  text: string;
}

export interface AIFilePart {
  type: 'file';
  data: string;
  filename?: string;
}

export type AIContentPart = AITextPart | AIFilePart;

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | AIContentPart[];
  cache_control?: { type: 'ephemeral' };
}

export interface AITool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AIOutputSchema {
  /** Provider-visible name. Starts with letter/_; then alphanumeric/_/-, max 64. */
  name: string;
  /** JSON Schema enforced by the provider and verified again by Galactic. */
  schema: Record<string, unknown> | boolean;
  /** Structured output is always strict. Omit or set true. */
  strict?: true;
}

export type AIStructuredOutputErrorCode =
  | 'invalid_output_schema'
  | 'structured_output_unsupported'
  | 'structured_output_invalid_json'
  | 'structured_output_schema_mismatch';

export interface AIRequest {
  model?: string;
  messages: AIMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: AITool[];
  output_schema?: AIOutputSchema;
}

export type AIStructuredRequest = Omit<AIRequest, 'output_schema'> & {
  output_schema: AIOutputSchema;
};

export interface AIUsage {
  input_tokens: number;
  output_tokens: number;
  cost_light: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface AIResponse<Output = unknown> {
  content: string;
  model: string;
  usage: AIUsage;
  /** Parsed, schema-validated value when output_schema was supplied. */
  output?: Output;
  error?: string;
  error_code?: AIStructuredOutputErrorCode;
}

/**
 * A successful SDK call with output_schema always includes the locally
 * verified value. Runtime SDK implementations throw before returning error
 * responses, so callers can consume output without an optional-value branch.
 */
export type AIStructuredResponse<Output = unknown> = AIResponse<Output> & {
  output: Output;
};

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
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatToolCall {
  id: string;
  type: 'function';
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
  status: 'success' | 'error' | 'aborted' | 'timeout';
  errorType?: string;
  errorMessage?: string;
  widgetAction?: WidgetToolInvocationTelemetryContext;
  metadata?: Record<string, unknown>;
}

export type InferenceBillingMode = 'light' | 'byok';

export interface InferenceRoutePreference {
  billingMode?: InferenceBillingMode;
  provider?: ActiveBYOKProvider;
  model?: string;
  webSearchEnabled?: boolean;
}

export type ChatInferenceSelectedPreference =
  & Required<
    Pick<InferenceRoutePreference, 'billingMode' | 'provider' | 'model'>
  >
  & Pick<InferenceRoutePreference, 'webSearchEnabled'>;

export interface ChatInferenceProviderOption {
  id: ActiveBYOKProvider;
  name: string;
  description: string;
  protocol: 'openai-compatible';
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
  provider: 'openrouter';
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

// Single unified threshold (25 Light = $0.25). Below it a caller is in "free
// mode": platform inference is unavailable (BYOK only) and paid app calls are
// blocked. This is the canonical source — CHAT_MIN_BALANCE_LIGHT aliases it.
export const FREE_MODE_BALANCE_LIGHT = 25;
/** @deprecated Use FREE_MODE_BALANCE_LIGHT. Kept as the platform-inference-floor name. */
export const CHAT_MIN_BALANCE_LIGHT = FREE_MODE_BALANCE_LIGHT;
// Platform inference is resold through OpenRouter; users pay the upstream cost
// plus a 10% platform upcharge when billed in credits (Light). BYOK routes are
// never marked up (they don't pass through this multiplier).
export const CHAT_PLATFORM_MARKUP = 1.1;
