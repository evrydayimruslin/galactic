// API client for Ultralight chat endpoints
// All requests route through the Ultralight server proxy (auth + billing).

import type {
  ChatInferenceOptionsResponse,
  ChatInferenceProviderOption,
  InferenceBillingMode,
  InferenceRoutePreference,
  ToolInvocationTelemetryRequest,
} from "../../../shared/contracts/ai.ts";
import type {
  AgenticInterfaceAction,
  AgenticInterfaceDataBindingSource,
  AgenticInterfaceDroppedItem,
  AgenticInterfaceSpec,
  AgenticInterfaceValidationResult,
  AgenticInterfaceVerificationResult,
  AgenticInterfaceWarning,
} from "../../../shared/contracts/agentic-interface.ts";
import {
  type ActiveBYOKProvider,
  BYOK_PROVIDERS,
} from "../../../shared/types/index.ts";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_HEAVY_MODEL,
  DEFAULT_INTERPRETER_MODEL,
  fetchFromApi,
  getToken,
} from "./storage";
import { type ChatStreamEvent, parseSSEStream } from "./sse";
import type { ToolUsed } from "../types/executionPlan";
import type { AmbientSuggestion } from "../types/ambientSuggestion";
import type { ActiveWidgetContext } from "./widgetAgentTypes";
import { createDesktopLogger } from "./logging";
import { formatLightCompact as formatLight } from "./format";

// ── Types ──

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface ApiError {
  error: string;
  detail?: string;
  code?: string;
  balance_light?: number;
  minimum_light?: number;
  topup_url?: string;
  allowed_models?: string[];
  resetAt?: string;
}

export interface WidgetPullCallMetadata {
  widgetName?: string;
  intervalMs?: number;
  reason?: string;
}

export interface AppMcpToolCallOptions {
  widgetPull?: WidgetPullCallMetadata | null;
}

/** Fallback model list when server is unreachable */
const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: DEFAULT_INTERPRETER_MODEL,
    name: "DeepSeek V4 Flash",
    provider: "deepseek",
  },
  { id: DEFAULT_HEAVY_MODEL, name: "DeepSeek V4 Pro", provider: "deepseek" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
  { id: "openai/gpt-4o", name: "GPT-4o", provider: "openai" },
  {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    provider: "google",
  },
  {
    id: "x-ai/grok-4.20-reasoning",
    name: "Grok 4.20 Reasoning",
    provider: "x-ai",
  },
];

const apiLogger = createDesktopLogger("api");

function withAppMcpCallMetadata(
  args: Record<string, unknown>,
  options?: AppMcpToolCallOptions,
): Record<string, unknown> {
  const widgetPull = options?.widgetPull;
  if (!widgetPull) return args;

  return {
    ...args,
    _widget_pull: true,
    ...(widgetPull.widgetName ? { _widget_name: widgetPull.widgetName } : {}),
    ...(typeof widgetPull.intervalMs === "number" &&
        Number.isFinite(widgetPull.intervalMs)
      ? { _widget_interval_ms: Math.max(0, Math.round(widgetPull.intervalMs)) }
      : {}),
    ...(widgetPull.reason ? { _widget_pull_reason: widgetPull.reason } : {}),
  };
}

export type InferenceSettings = ChatInferenceOptionsResponse;
export type InferenceSetupState =
  | "ready"
  | "needs_light_balance"
  | "needs_byok_key"
  | "needs_inference_setup";

export type InferenceSetupAction =
  | "open_settings"
  | "open_wallet"
  | "use_light";

export interface InferenceSetupPrompt {
  state: Exclude<InferenceSetupState, "ready">;
  title: string;
  message: string;
  primaryAction: {
    label: string;
    action: InferenceSetupAction;
  };
  secondaryAction?: {
    label: string;
    action: InferenceSetupAction;
  };
}

export interface InferenceProviderChoice {
  key: string;
  billingMode: InferenceBillingMode;
  provider: ActiveBYOKProvider;
  label: string;
  description: string;
  usable: boolean;
  configured: boolean;
  reason?: string;
}

export interface InferenceModelOption extends ModelInfo {
  billingMode: InferenceBillingMode;
  providerName: string;
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
}

type ModelDetailInput = Pick<
  InferenceModelOption,
  "contextWindow" | "inputPrice" | "outputPrice"
>;

function modelNameFromId(id: string): string {
  return id.split("/").pop()?.replace(/:nitro$/, "") || id;
}

function providerModelOptions(
  provider: ChatInferenceProviderOption,
  billingMode: InferenceBillingMode,
): InferenceModelOption[] {
  return provider.models.map((model) => ({
    id: model.id,
    name: model.name || modelNameFromId(model.id),
    provider: provider.id,
    providerName: provider.name,
    billingMode,
    contextWindow: model.contextWindow,
    inputPrice: model.inputPrice,
    outputPrice: model.outputPrice,
  }));
}

function buildFallbackInferenceSettings(): InferenceSettings {
  const providers = Object.values(BYOK_PROVIDERS).map((provider) => ({
    id: provider.id,
    name: provider.name,
    description: provider.description,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    models: provider.models,
    capabilities: provider.capabilities,
    apiKeyPrefix: provider.apiKeyPrefix,
    docsUrl: provider.docsUrl,
    apiKeyUrl: provider.apiKeyUrl,
    configured: false,
    primary: false,
    configuredModel: null,
    addedAt: null,
  }));

  return {
    defaultBillingMode: "light",
    selected: {
      billingMode: "light",
      provider: "openrouter",
      model: DEFAULT_CHAT_MODEL,
    },
    light: {
      provider: "openrouter",
      defaultModel: DEFAULT_CHAT_MODEL,
      models: BYOK_PROVIDERS.openrouter.models,
      balanceLight: null,
      minimumBalanceLight: 50,
      usable: false,
      markup: 1,
      unavailableReason: "Inference settings unavailable",
    },
    providers,
    configuredProviderIds: [],
  };
}

// ── Headers ──

function authHeaders(): Record<string, string> {
  const token = getToken();
  if (!token) throw new Error("Not authenticated");
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function claimReferralToken(claimToken: string): Promise<boolean> {
  const token = getToken();
  if (!token || !claimToken) return false;

  const res = await fetchFromApi("/auth/referral-claim", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ claim_token: claimToken }),
  });
  return res.ok;
}

// ── Chat Stream ──

/**
 * Stream a chat completion from the Ultralight proxy.
 * Returns an async iterator of ChatStreamEvents.
 */
export async function* streamChat(opts: {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  temperature?: number;
  max_tokens?: number;
  inference?: InferenceRoutePreference;
  trace?: {
    traceId?: string;
    conversationId?: string;
    messageId?: string;
    source?: string;
  };
}): AsyncGenerator<ChatStreamEvent> {
  let res: Response;
  try {
    res = await fetchFromApi("/chat/stream", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.max_tokens ?? 4096,
        inference: opts.inference,
        trace: opts.trace,
      }),
    });
  } catch (err) {
    yield {
      type: "error",
      error: `Network error: ${
        err instanceof Error ? err.message : "Connection failed"
      }. Check your internet connection.`,
    };
    return;
  }

  // Handle non-streaming error responses
  if (!res.ok) {
    let apiError: ApiError;
    try {
      apiError = await res.json() as ApiError;
    } catch {
      apiError = { error: `HTTP ${res.status}: ${res.statusText}` };
    }

    yield {
      type: "error",
      error: formatApiError(apiError, res.status),
    };
    return;
  }

  if (!res.body) {
    yield { type: "error", error: "No response body" };
    return;
  }

  // Parse the SSE stream
  yield* parseSSEStream(res.body);
}

/**
 * Best-effort telemetry for local desktop tool execution.
 * Tool calls happen outside the API worker, so this posts full args/results
 * after completion without affecting the active chat loop.
 */
export async function recordToolInvocationTelemetry(
  payload: ToolInvocationTelemetryRequest,
): Promise<void> {
  try {
    await fetchFromApi("/chat/tool-invocation", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    apiLogger.warn("Failed to record tool invocation telemetry", {
      error: err,
    });
  }
}

// ── Models List ──

/**
 * Fetch available models from the server.
 */
export async function fetchModels(): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const token = getToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const res = await fetchFromApi("/chat/models", { headers });
    if (!res.ok) {
      throw new Error(`Failed to fetch models: ${res.status}`);
    }

    const data = await res.json() as { models: ModelInfo[] };
    return data.models;
  } catch {
    return FALLBACK_MODELS;
  }
}

// ── Inference Settings ──

/**
 * Fetch provider-aware inference settings for the signed-in user.
 * Falls back to the static first-tier registry so UI controls can still render offline.
 */
export async function fetchInferenceSettings(): Promise<InferenceSettings> {
  const token = getToken();
  if (!token) return buildFallbackInferenceSettings();

  try {
    const res = await fetchFromApi("/chat/inference-options", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch inference settings: ${res.status}`);
    }
    return await res.json() as InferenceSettings;
  } catch (err) {
    apiLogger.warn("Falling back to static inference settings", { error: err });
    return buildFallbackInferenceSettings();
  }
}

export function getInferenceProviderChoices(
  settings: InferenceSettings,
): InferenceProviderChoice[] {
  const lightReason = settings.light.unavailableReason ||
    (settings.light.balanceLight !== null
      ? `Light balance below ${settings.light.minimumBalanceLight}`
      : "Light balance unavailable");

  return [
    {
      key: "light:openrouter",
      billingMode: "light",
      provider: "openrouter",
      label: "Light balance",
      description: "Platform inference through OpenRouter at pass-through cost",
      usable: settings.light.usable,
      configured: true,
      reason: settings.light.usable ? undefined : lightReason,
    },
    ...settings.providers.map((provider) => ({
      key: `byok:${provider.id}`,
      billingMode: "byok" as const,
      provider: provider.id,
      label: provider.name,
      description: provider.description,
      usable: provider.configured,
      configured: provider.configured,
      reason: provider.configured ? undefined : "API key not configured",
    })),
  ];
}

export function getUsableInferenceProviderChoices(
  settings: InferenceSettings,
): InferenceProviderChoice[] {
  return getInferenceProviderChoices(settings).filter((choice) =>
    choice.usable
  );
}

export function getEffectiveInferencePreference(
  settings: InferenceSettings,
  preference: InferenceRoutePreference = {},
): Required<InferenceRoutePreference> {
  const billingMode = preference.billingMode || settings.selected.billingMode;

  if (billingMode === "light") {
    return {
      billingMode: "light",
      provider: "openrouter",
      model: preference.model || settings.light.defaultModel ||
        DEFAULT_CHAT_MODEL,
    };
  }

  const requestedProvider = preference.provider;
  const selectedProvider = requestedProvider || settings.selected.provider;
  const selectedProviderOption = settings.providers.find((option) =>
    option.id === selectedProvider
  );
  const provider = requestedProvider
    ? selectedProviderOption
    : selectedProviderOption && selectedProviderOption.configured
    ? selectedProviderOption
    : settings.providers.find((option) => option.primary) ||
      settings.providers.find((option) => option.configured) ||
      selectedProviderOption;

  return {
    billingMode: "byok",
    provider: provider?.id || selectedProvider,
    model: preference.model || provider?.configuredModel ||
      provider?.defaultModel ||
      settings.selected.model,
  };
}

export function getInferenceModelOptions(
  settings: InferenceSettings,
  preference: InferenceRoutePreference = {},
): InferenceModelOption[] {
  const effective = getEffectiveInferencePreference(settings, preference);

  if (effective.billingMode === "light") {
    const openrouter = settings.providers.find((provider) =>
      provider.id === "openrouter"
    );
    if (openrouter) {
      return providerModelOptions({
        ...openrouter,
        models: settings.light.models,
      }, "light");
    }
    return settings.light.models.map((model) => ({
      id: model.id,
      name: model.name || modelNameFromId(model.id),
      provider: "openrouter",
      providerName: "OpenRouter",
      billingMode: "light",
      contextWindow: model.contextWindow,
      inputPrice: model.inputPrice,
      outputPrice: model.outputPrice,
    }));
  }

  const provider = settings.providers.find((option) =>
    option.id === effective.provider
  );
  return provider ? providerModelOptions(provider, "byok") : [];
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(value);
}

function formatUsd(value: number): string {
  if (value >= 10) return `$${value.toFixed(0)}`;
  if (value >= 1) {
    return `$${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  return `$${value.toFixed(2)}`;
}

export function formatInferenceModelContext(
  contextWindow?: number,
): string | null {
  if (!contextWindow || contextWindow <= 0) return null;
  return `${compactNumber(contextWindow)} ctx`;
}

export function formatInferenceModelPrice(
  inputPrice?: number,
  outputPrice?: number,
): string | null {
  if (inputPrice === undefined && outputPrice === undefined) return null;
  if (inputPrice !== undefined && outputPrice !== undefined) {
    return `${formatUsd(inputPrice)} in / ${formatUsd(outputPrice)} out per 1M`;
  }
  if (inputPrice !== undefined) return `${formatUsd(inputPrice)} input per 1M`;
  return `${formatUsd(outputPrice!)} output per 1M`;
}

export function describeInferenceModel(
  model?: ModelDetailInput | null,
): string {
  if (!model) return "Model details unavailable";

  const details = [
    formatInferenceModelContext(model.contextWindow),
    formatInferenceModelPrice(model.inputPrice, model.outputPrice),
  ].filter(Boolean);

  return details.length > 0 ? details.join(" | ") : "Provider pricing varies";
}

export function getInferenceSetupState(
  settings: InferenceSettings,
  preference: InferenceRoutePreference = {},
): InferenceSetupState {
  const effective = getEffectiveInferencePreference(settings, preference);

  if (effective.billingMode === "light") {
    if (settings.light.usable) return "ready";
    return settings.configuredProviderIds.length > 0
      ? "needs_light_balance"
      : "needs_inference_setup";
  }

  const provider = settings.providers.find((option) =>
    option.id === effective.provider
  );
  return provider?.configured ? "ready" : "needs_byok_key";
}

export function buildInferenceSetupPrompt(
  settings: InferenceSettings,
  preference: InferenceRoutePreference = {},
): InferenceSetupPrompt | null {
  const state = getInferenceSetupState(settings, preference);
  if (state === "ready") return null;

  const effective = getEffectiveInferencePreference(settings, preference);
  const selectedProvider = settings.providers.find((provider) =>
    provider.id === effective.provider
  );
  const configuredProviders = settings.providers.filter((provider) =>
    provider.configured
  );

  if (state === "needs_light_balance") {
    const balanceText = settings.light.balanceLight === null
      ? "Your Light balance could not be verified."
      : `Your Light balance is ${
        formatLight(settings.light.balanceLight)
      }; chat needs at least ${
        formatLight(settings.light.minimumBalanceLight)
      }.`;
    return {
      state,
      title: "Light balance needed",
      message:
        `${balanceText} Add Light or switch to a configured BYOK provider before sending.`,
      primaryAction: { label: "Add Light", action: "open_wallet" },
      secondaryAction: configuredProviders.length > 0
        ? { label: "Manage providers", action: "open_settings" }
        : undefined,
    };
  }

  if (state === "needs_byok_key") {
    return {
      state,
      title: "Provider key needed",
      message: `${
        selectedProvider?.name || effective.provider
      } is selected for BYOK inference, but no API key is configured for it.`,
      primaryAction: { label: "Add provider key", action: "open_settings" },
      secondaryAction: settings.light.usable
        ? { label: "Use Light balance", action: "use_light" }
        : undefined,
    };
  }

  return {
    state,
    title: "Inference setup needed",
    message: "Add a provider API key or add Light before starting a chat.",
    primaryAction: { label: "Add provider key", action: "open_settings" },
    secondaryAction: { label: "Add Light", action: "open_wallet" },
  };
}

// ── Function Index (per-user typed function catalog for codemode) ──

export interface FunctionIndex {
  functions: Record<string, {
    appId: string;
    appSlug: string;
    fnName: string;
    description: string;
    params: Record<
      string,
      { type: string; required?: boolean; description?: string }
    >;
    returns?: string;
    conventions?: string[];
    dependsOn?: string[];
  }>;
  widgets: Array<{
    name: string;
    appId: string;
    appSlug?: string;
    appName?: string;
    label: string;
    description?: string;
    uiFunction?: string;
    dataFunction?: string;
    dependencies?: Array<{ app: string; functions: string[]; access?: "read" }>;
    agentic?: boolean;
    contextFunction?: string;
    actionsFunction?: string;
    contextSources?: string[];
    agentActions?: Array<{
      id: string;
      label: string;
      description?: string;
      mode: "read" | "write" | "ui";
      confirmation?: "none" | "user" | "high_risk";
      args_schema?: Record<string, unknown>;
      mcp?: { function: string; args_template?: Record<string, unknown> };
      ui?: { command?: string; component_id?: string; args_template?: Record<string, unknown> };
      expected_result?: string;
    }>;
    cards?: Array<{
      id: string;
      label: string;
      description?: string;
      size: string;
      render: "native";
      kind?: string;
      dataView?: string;
      dataFunction?: string;
      refreshIntervalS?: number;
      dependencies?: Array<
        { app: string; functions: string[]; access?: "read" }
      >;
    }>;
  }>;
  contextSources?: Array<{
    id: string;
    appId: string;
    appSlug: string;
    appName?: string;
    label: string;
    description?: string;
    type: "d1_table" | "d1_query" | "function";
    access: "read";
    searchable?: boolean;
    defaultForWidgets?: string[];
    tables?: string[];
    query?: string;
    function?: string;
    redactions?: Array<{ field?: string; pattern?: string; replacement?: string }>;
  }>;
  routines?: Array<{
    id: string;
    label: string;
    description?: string;
    appId: string;
    appSlug: string;
    appName: string;
    handler: string;
  }>;
  types: string;
  updatedAt: string | null;
}

const FN_INDEX_CACHE_KEY = "ul_fn_index";

/**
 * Fetch the user's function index from the server, with localStorage caching.
 * Returns cached version if available and less than 5 minutes old.
 */
export async function fetchFunctionIndex(
  forceRefresh = false,
): Promise<FunctionIndex | null> {
  // Check cache first
  if (!forceRefresh) {
    try {
      const cached = localStorage.getItem(FN_INDEX_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as FunctionIndex & {
          _cachedAt?: number;
        };
        const age = Date.now() - (parsed._cachedAt || 0);
        if (age < 5 * 60 * 1000) { // 5 minutes
          return parsed;
        }
      }
    } catch { /* cache corrupt */ }
  }

  // Fetch from server
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetchFromApi("/chat/function-index", {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const index = await res.json() as FunctionIndex;

    // Cache with timestamp
    try {
      localStorage.setItem(
        FN_INDEX_CACHE_KEY,
        JSON.stringify({ ...index, _cachedAt: Date.now() }),
      );
    } catch { /* storage full */ }

    return index;
  } catch {
    return null;
  }
}

export interface CommandDashboardLayout {
  dashboard_key: string;
  cards: Array<{
    instance_id: string;
    app_id: string;
    app_slug?: string;
    widget_id: string;
    card_id: string;
    position: { x: number; y: number };
    size: string;
    config?: Record<string, unknown>;
  }>;
}

export interface StoredCommandDashboardLayout {
  dashboard_key: string;
  title: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  is_default: boolean;
  card_count: number;
  layout: CommandDashboardLayout;
  created_at: string | null;
  updated_at: string | null;
}

export type CommandDashboardSummary = Omit<
  StoredCommandDashboardLayout,
  "layout"
>;

export interface CommandDashboardMetadataInput {
  dashboard_key?: string;
  title?: string | null;
  description?: string | null;
  icon?: string | null;
  sort_order?: number;
  is_default?: boolean;
  layout?: CommandDashboardLayout;
}

export interface AgenticInterfacePlannerResult {
  draft_spec: AgenticInterfaceSpec;
  normalized_spec: AgenticInterfaceSpec;
  validation: AgenticInterfaceValidationResult;
  verification: AgenticInterfaceVerificationResult;
  rationale: string[];
  warnings: AgenticInterfaceWarning[];
  dropped: AgenticInterfaceDroppedItem[];
  planner: {
    version: string;
    policy: string;
    context_summary: Record<string, unknown>;
  };
  inventory: {
    surfaces_considered: number;
    functions_considered: number;
    context_sources_considered: number;
    saved_dashboards_considered: number;
    data_preview_rows?: number;
  };
  data_preview?: {
    context: string;
    sourceCount: number;
    rowCount: number;
    errors: string[];
  };
  persisted: boolean;
}

export interface AgenticInterfaceSummary {
  id: string;
  interface_key: string;
  title: string;
  description: string | null;
  icon: string | null;
  source_prompt: string | null;
  mode: "saved";
  status: "active" | "archived";
  component_count: number;
  action_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface StoredAgenticInterface extends AgenticInterfaceSummary {
  stored_spec: AgenticInterfaceSpec;
  normalized_spec: AgenticInterfaceSpec;
  verification: AgenticInterfaceVerificationResult;
  warnings: AgenticInterfaceWarning[];
  dropped: AgenticInterfaceDroppedItem[];
}

export interface AgenticInterfaceSaveInput {
  interface_key?: string;
  title?: string | null;
  description?: string | null;
  icon?: string | null;
  spec: AgenticInterfaceSpec;
  source_prompt?: string | null;
  status?: "active" | "archived";
}

export interface AgenticInterfaceBindingData {
  binding_id: string;
  source: AgenticInterfaceDataBindingSource;
  label?: string;
  status: "ok" | "error" | "skipped";
  data: unknown;
  raw?: unknown;
  row_count?: number;
  refreshed_at: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface AgenticInterfaceDataResult {
  spec_id: string;
  title: string;
  bindings: Record<string, AgenticInterfaceBindingData>;
  binding_order: string[];
  errors: string[];
  row_count: number;
  refreshed_at: string;
}

export interface AgenticInterfaceActionExecutionContext {
  surfaceId?: string;
  turnId: string;
  componentId?: string;
  confirmed?: boolean;
}

export interface AgenticInterfaceActionExecutionResult {
  spec_id: string;
  action_id: string;
  kind: AgenticInterfaceAction["kind"];
  mode: AgenticInterfaceAction["mode"];
  confirmation?: AgenticInterfaceAction["confirmation"];
  status: "ok" | "error" | "requires_confirmation" | "client_action_required";
  result?: unknown;
  error?: string;
  refreshed_binding_ids?: string[];
  open_widget?: {
    app_id: string;
    app_slug?: string;
    widget_id: string;
    context?: Record<string, string>;
  };
  widget_action?: {
    app_id?: string;
    app_slug?: string;
    widget_id: string;
    action_id: string;
    surface_id?: string;
    args: Record<string, unknown>;
  };
  selected_entity?: {
    component_id?: string;
    args: Record<string, unknown>;
  };
  audit: {
    surface_id?: string;
    interface_id: string;
    action_id: string;
    turn_id: string;
    component_id?: string;
  };
  executed_at: string;
}

function parseMcpJsonContent<T>(result: McpToolResult): T {
  if (result.isError) {
    const message = result.content.find((entry) => entry.text)?.text || "Tool call failed";
    throw new Error(message);
  }
  const text = result.content.find((entry) => entry.type === "text" && entry.text)?.text;
  if (!text) throw new Error("Tool response did not include JSON content");
  return JSON.parse(text) as T;
}

async function parseApiJsonOrThrow<T>(res: Response, fallback: string): Promise<T> {
  if (res.ok) return await res.json() as T;
  const body = await res.json().catch(() => null) as ApiError | null;
  throw new Error(body?.error || body?.detail || `${fallback} (${res.status})`);
}

export async function generateCommandInterface(input: {
  prompt: string;
  mode?: "temporary" | "saved";
  max_components?: number;
  include_data_preview?: boolean;
  app_id?: string;
  app_slug?: string;
  app_scope?: Record<string, unknown>;
}): Promise<AgenticInterfacePlannerResult> {
  const result = await executeMcpTool("ul.command", {
    action: "interface",
    prompt: input.prompt,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.max_components ? { max_components: input.max_components } : {}),
    ...(input.include_data_preview !== undefined
      ? { include_data_preview: input.include_data_preview }
      : {}),
    ...(input.app_id ? { app_id: input.app_id } : {}),
    ...(input.app_slug ? { app_slug: input.app_slug } : {}),
    ...(input.app_scope ? { app_scope: input.app_scope } : {}),
  });
  return parseMcpJsonContent<AgenticInterfacePlannerResult>(result);
}

export async function fetchAgenticInterfaceData(input: {
  spec: AgenticInterfaceSpec;
  binding_ids?: string[];
  query?: string;
  max_rows_per_binding?: number;
}): Promise<AgenticInterfaceDataResult> {
  const result = await executeMcpTool("ul.command", {
    action: "interface_data",
    spec: input.spec,
    ...(input.binding_ids?.length ? { binding_ids: input.binding_ids } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.max_rows_per_binding !== undefined
      ? { max_rows_per_binding: input.max_rows_per_binding }
      : {}),
  });
  return parseMcpJsonContent<AgenticInterfaceDataResult>(result);
}

export async function executeAgenticInterfaceAction(input: {
  spec: AgenticInterfaceSpec;
  action_id: string;
  args?: Record<string, unknown>;
  confirmed?: boolean;
  surface_id?: string;
  turn_id?: string;
  component_id?: string;
}): Promise<AgenticInterfaceActionExecutionResult> {
  const result = await executeMcpTool("ul.command", {
    action: "interface_action",
    spec: input.spec,
    action_id: input.action_id,
    ...(input.args ? { args: input.args } : {}),
    ...(input.confirmed !== undefined ? { confirmed: input.confirmed } : {}),
    ...(input.surface_id ? { surface_id: input.surface_id } : {}),
    ...(input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(input.component_id ? { component_id: input.component_id } : {}),
  });
  return parseMcpJsonContent<AgenticInterfaceActionExecutionResult>(result);
}

export async function fetchAgenticInterfaces(): Promise<AgenticInterfaceSummary[]> {
  const token = getToken();
  if (!token) return [];
  const res = await fetchFromApi("/api/user/agentic-interfaces", {
    headers: { "Authorization": `Bearer ${token}` },
  });
  const data = await parseApiJsonOrThrow<{ interfaces?: AgenticInterfaceSummary[] }>(
    res,
    "Failed to load saved interfaces",
  );
  return data.interfaces || [];
}

export async function fetchAgenticInterface(
  interfaceKey: string,
): Promise<StoredAgenticInterface> {
  const token = getToken();
  if (!token) throw new Error("Sign in to load saved interfaces");
  const res = await fetchFromApi(
    `/api/user/agentic-interfaces/${encodeURIComponent(interfaceKey)}`,
    {
      headers: { "Authorization": `Bearer ${token}` },
    },
  );
  return await parseApiJsonOrThrow<StoredAgenticInterface>(
    res,
    "Failed to load saved interface",
  );
}

export async function saveAgenticInterface(
  input: AgenticInterfaceSaveInput,
): Promise<StoredAgenticInterface> {
  const token = getToken();
  if (!token) throw new Error("Sign in to save generated interfaces");
  const res = await fetchFromApi("/api/user/agentic-interfaces", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  return await parseApiJsonOrThrow<StoredAgenticInterface>(
    res,
    "Failed to save generated interface",
  );
}

export async function updateAgenticInterface(
  interfaceKey: string,
  input: Partial<AgenticInterfaceSaveInput>,
): Promise<StoredAgenticInterface> {
  const token = getToken();
  if (!token) throw new Error("Sign in to update saved interfaces");
  const res = await fetchFromApi(
    `/api/user/agentic-interfaces/${encodeURIComponent(interfaceKey)}`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  return await parseApiJsonOrThrow<StoredAgenticInterface>(
    res,
    "Failed to update saved interface",
  );
}

export async function deleteAgenticInterface(
  interfaceKey: string,
): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  const res = await fetchFromApi(
    `/api/user/agentic-interfaces/${encodeURIComponent(interfaceKey)}`,
    {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` },
    },
  );
  if (!res.ok) return false;
  return true;
}

export function savedAgenticInterfaceToPlannerResult(
  saved: StoredAgenticInterface,
): AgenticInterfacePlannerResult {
  return {
    draft_spec: saved.stored_spec,
    normalized_spec: saved.normalized_spec,
    validation: saved.verification.validation,
    verification: saved.verification,
    rationale: [`Loaded saved interface "${saved.title}".`],
    warnings: saved.warnings,
    dropped: saved.dropped,
    planner: {
      version: "saved",
      policy: "Saved verified specs are re-verified against current installed apps, widgets, context sources, and MCP functions on load.",
      context_summary: {
        interface_key: saved.interface_key,
        status: saved.status,
        updated_at: saved.updated_at,
      },
    },
    inventory: {
      surfaces_considered: 0,
      functions_considered: 0,
      context_sources_considered: 0,
      saved_dashboards_considered: 0,
    },
    persisted: true,
  };
}

export async function fetchCommandWidgets(): Promise<
  Pick<FunctionIndex, "widgets" | "updatedAt"> | null
> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi("/api/user/command-widgets", {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as {
    widgets?: FunctionIndex["widgets"];
    updated_at?: string;
  };
  return {
    widgets: data.widgets || [],
    updatedAt: data.updated_at || null,
  };
}

export async function fetchCommandDashboardLayout(
  dashboardKey = "command_home",
): Promise<StoredCommandDashboardLayout | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi(
    `/api/user/command-dashboard?dashboard_key=${
      encodeURIComponent(dashboardKey)
    }`,
    {
      headers: { "Authorization": `Bearer ${token}` },
    },
  );
  if (!res.ok) return null;
  return await res.json() as StoredCommandDashboardLayout;
}

export async function fetchCommandDashboards(): Promise<
  CommandDashboardSummary[] | null
> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi("/api/user/command-dashboards", {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as { dashboards?: CommandDashboardSummary[] };
  return data.dashboards || [];
}

export async function createCommandDashboard(
  input: CommandDashboardMetadataInput,
): Promise<StoredCommandDashboardLayout | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi("/api/user/command-dashboards", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  return await res.json() as StoredCommandDashboardLayout;
}

export async function updateCommandDashboard(
  dashboardKey: string,
  input: Omit<CommandDashboardMetadataInput, "dashboard_key" | "layout">,
): Promise<StoredCommandDashboardLayout | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi(
    `/api/user/command-dashboards/${encodeURIComponent(dashboardKey)}`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) return null;
  return await res.json() as StoredCommandDashboardLayout;
}

export async function deleteCommandDashboard(
  dashboardKey: string,
): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  const res = await fetchFromApi(
    `/api/user/command-dashboards/${encodeURIComponent(dashboardKey)}`,
    {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${token}` },
    },
  );
  return res.ok;
}

export async function saveCommandDashboardLayout(
  layout: CommandDashboardLayout,
): Promise<StoredCommandDashboardLayout | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi("/api/user/command-dashboard", {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      dashboard_key: layout.dashboard_key,
      layout,
    }),
  });
  if (!res.ok) return null;
  return await res.json() as StoredCommandDashboardLayout;
}

export type RoutineMonitorHealth =
  | "active"
  | "paused"
  | "running"
  | "needs_approval"
  | "error";

export type RoutineMonitorStatus =
  | "active"
  | "paused"
  | "disabled"
  | "deleted"
  | "error";

export interface RoutineRunSummary {
  id: string;
  routine_id: string;
  status: string;
  trigger: string;
  trace_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  total_light: number;
  summary: string | null;
  error: Record<string, unknown> | null;
  created_at: string;
}

export interface RoutineMonitorAction {
  id: "pause" | "resume" | "run_now";
  label: string;
  method: "PATCH" | "POST";
  endpoint: string;
  body?: Record<string, unknown>;
}

export interface RoutineMonitorItem {
  id: string;
  user_id: string;
  composer_app_id: string | null;
  composer_app_slug: string | null;
  template_id: string;
  template_version: string | null;
  name: string;
  description: string | null;
  intent: string | null;
  handler_function: string;
  status: RoutineMonitorStatus;
  schedule: Record<string, unknown>;
  config: Record<string, unknown>;
  budget_policy: Record<string, unknown>;
  approval_policy: Record<string, unknown>;
  max_concurrency: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
  health: RoutineMonitorHealth;
  approved_capability_count: number;
  pending_capability_count: number;
  capability_count: number;
  last_run: RoutineRunSummary | null;
  recent_runs: RoutineRunSummary[];
  failures_24h: number;
  spend_light_24h: number;
  spend_light_30d: number;
  actions: RoutineMonitorAction[];
}

export interface RoutineMonitorSummary {
  total: number;
  active: number;
  paused: number;
  error: number;
  pending_approvals: number;
  failures_24h: number;
  spend_light_24h: number;
  spend_light_30d: number;
  next_run_at: string | null;
  last_run_at: string | null;
}

export interface RoutineMonitorResponse {
  summary: RoutineMonitorSummary;
  routines: RoutineMonitorItem[];
  cards: Record<string, unknown>;
  generated_at: string;
}

export async function fetchRoutineMonitor(): Promise<
  RoutineMonitorResponse | null
> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi("/api/user/routines", {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await res.json() as RoutineMonitorResponse;
}

export async function updateRoutineMonitorStatus(
  routineId: string,
  action: "pause" | "resume",
): Promise<RoutineMonitorItem | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi(
    `/api/user/routines/${encodeURIComponent(routineId)}`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action }),
    },
  );
  if (!res.ok) return null;
  const data = await res.json() as { routine?: RoutineMonitorItem };
  return data.routine ?? null;
}

export async function runRoutineNow(
  routineId: string,
): Promise<RoutineRunSummary | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi(
    `/api/user/routines/${encodeURIComponent(routineId)}/run`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
    },
  );
  if (!res.ok) return null;
  const data = await res.json() as { run?: RoutineRunSummary };
  return data.run ?? null;
}

// ── Marketplace ──
//
// Wraps the /api/discover/marketplace browse + search endpoints and
// /api/discover/newly-acquired feed. Response shapes are intentionally
// loose since the BE may evolve them; the FE renders what it understands
// and ignores extras.

export interface MarketplaceListingSnapshot {
  eligible?: boolean;
  status?: 'ineligible' | 'unlisted' | 'open_to_offers' | 'listed' | 'sold';
  ask_price_light?: number | null;
  floor_price_light?: number | null;
  instant_buy?: boolean;
  show_metrics?: boolean;
  active_bid_count?: number;
  highest_bid_light?: number | null;
  platform_fee_at_ask_light?: number | null;
  seller_payout_at_ask_light?: number | null;
  listing_note?: string | null;
  updated_at?: string | null;
}

export interface MarketplaceTrustSnapshot {
  signed_manifest?: boolean;
  runtime?: string | null;
  permissions?: string[];
  capability_summary?: {
    ai?: boolean;
    network?: boolean;
    storage?: boolean;
    memory?: boolean;
    gpu?: boolean;
  };
  required_secrets?: string[];
}

export interface MarketplaceResult {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  type?: 'app' | 'page' | 'skill';
  mcp_endpoint?: string;
  url?: string;
  likes?: number;
  runs_30d?: number;
  fully_native?: boolean;
  had_external_db?: boolean;
  runtime?: string;
  gpu_type?: string;
  gpu_status?: string;
  trust_card?: MarketplaceTrustSnapshot;
  marketplace?: MarketplaceListingSnapshot;
  tags?: string[];
  final_score?: number;
  similarity?: number;
  // ── B10 enrichment (optional; renders only when present) ──
  /** Daily run counts for the last 7 days, oldest first. Used for sparklines. */
  sparkline?: number[];
  /** Percent change vs the prior 7d (0.18 = +18%, -0.05 = -5%). */
  growth_7d?: number;
  /** Median request latency in milliseconds (overlaps with B5 source). */
  latency_p50_ms?: number;
  /** Per-function average cost in Light from the manifest pricing config. */
  price_per_call_light?: number;
  /** Owner's display name; FE falls back to slug-prefix via formatAuthorHandle. */
  author_display_name?: string;
}

export interface MarketplaceSection {
  title: string;
  type: 'featured' | 'category' | 'skills' | string;
  results: MarketplaceResult[];
}

export interface MarketplaceBrowseResponse {
  mode: 'browse';
  sections: MarketplaceSection[];
  total: number;
}

export interface MarketplaceSearchResponse {
  mode: 'search';
  results: MarketplaceResult[];
  total: number;
}

export type MarketplaceResponse = MarketplaceBrowseResponse | MarketplaceSearchResponse;

export async function fetchMarketplaceBrowse(options?: {
  type?: 'all' | 'apps' | 'skills';
  runtime?: 'all' | 'gpu' | 'deno';
  limit?: number;
}): Promise<MarketplaceBrowseResponse | null> {
  const params = new URLSearchParams({ format: 'sections' });
  if (options?.type) params.set('type', options.type);
  if (options?.runtime) params.set('runtime', options.runtime);
  if (options?.limit) params.set('limit', String(options.limit));

  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetchFromApi(`/api/discover/marketplace?${params.toString()}`, { headers });
  if (!res.ok) return null;
  const data = await res.json() as MarketplaceResponse;
  return data.mode === 'browse' ? data : null;
}

export async function searchMarketplace(query: string, options?: {
  type?: 'all' | 'apps' | 'skills';
  runtime?: 'all' | 'gpu' | 'deno';
  limit?: number;
  /** Cancel in-flight fetches when a newer query supersedes this one. */
  signal?: AbortSignal;
}): Promise<MarketplaceSearchResponse | null> {
  const params = new URLSearchParams({ q: query });
  if (options?.type) params.set('type', options.type);
  if (options?.runtime) params.set('runtime', options.runtime);
  if (options?.limit) params.set('limit', String(options.limit));

  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetchFromApi(`/api/discover/marketplace?${params.toString()}`, {
    headers,
    signal: options?.signal,
  });
  if (!res.ok) return null;
  const data = await res.json() as MarketplaceResponse;
  return data.mode === 'search' ? data : null;
}

// ── Marketplace listing detail (used by ToolDetailView side rail) ──

export interface MarketplaceBid {
  id: string;
  bidder_id?: string;
  bidder_email?: string;
  bidder_display_name?: string;
  amount_light: number;
  message?: string | null;
  status?: 'active' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  created_at?: string;
  expires_at?: string | null;
}

export interface MarketplaceOwnerAdminChecklistItem {
  id: string;
  label: string;
  status: 'ready' | 'action' | 'blocked' | 'optional';
  detail?: string;
  action?: string;
}

export interface MarketplaceOwnerAdmin {
  payout_connected?: boolean;
  payout_onboarded?: boolean;
  payouts_enabled?: boolean;
  balance_light?: number;
  total_earned_light?: number;
  referral?: {
    id: string;
    app_id: string;
    publisher_user_id: string;
    slug: string;
    url: string;
    status: 'active' | 'disabled';
    created_at: string;
  } | null;
  checklist?: MarketplaceOwnerAdminChecklistItem[];
  recommended_action_id?: string;
  recommended_action?: string;
}

export interface MarketplaceListingDetails {
  listing?: {
    id?: string;
    app_id: string;
    owner_id?: string;
    ask_price_light?: number | null;
    floor_price_light?: number | null;
    instant_buy?: boolean;
    status?: 'ineligible' | 'unlisted' | 'open_to_offers' | 'listed' | 'sold';
    listing_note?: string | null;
    provenance?: unknown[];
    updated_at?: string;
  } | null;
  bids: MarketplaceBid[];
  app?: {
    id: string;
    name: string;
    slug: string;
    owner_id?: string;
    total_runs?: number;
    runs_30d?: number;
    description?: string;
    trust_card?: MarketplaceTrustSnapshot;
  };
  owner_admin?: MarketplaceOwnerAdmin;
  marketplace_summary?: MarketplaceListingSnapshot & {
    blockers?: string[];
  };
}

export async function fetchMarketplaceListing(appId: string): Promise<MarketplaceListingDetails | null> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetchFromApi(`/api/marketplace/listing/${encodeURIComponent(appId)}`, { headers });
  if (!res.ok) return null;
  return await res.json() as MarketplaceListingDetails;
}

export interface PlaceBidResult {
  ok: boolean;
  bid_id?: string;
  amount_light?: number;
  errorMessage?: string;
  errorStatus?: number;
}

/** POST /api/marketplace/bid — escrows the bid amount and creates an active bid.
 *  Returns ok=false with errorStatus + errorMessage on failure (e.g. 402 insufficient,
 *  409 already-active-bid). Cancel via cancelBid() to release escrow. */
export async function placeBid(input: {
  appId: string;
  amountLight: number;
  message?: string;
  expiresInHours?: number;
}): Promise<PlaceBidResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/marketplace/bid', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: input.appId,
      amount_light: input.amountLight,
      message: input.message,
      expires_in_hours: input.expiresInHours,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorStatus: res.status, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as { bid_id?: string; amount_light?: number };
  return { ok: true, bid_id: data.bid_id, amount_light: data.amount_light };
}

/** POST /api/marketplace/cancel — bidder withdraws their own active bid, refunds escrow. */
export async function cancelBid(bidId: string): Promise<{ ok: boolean; errorMessage?: string }> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/marketplace/cancel', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bid_id: bidId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  return { ok: true };
}

// ── Seller actions ──

export interface SetAskPriceResult {
  ok: boolean;
  listing_id?: string;
  app_id?: string;
  ask_price_light?: number | null;
  floor_price_light?: number | null;
  instant_buy?: boolean;
  errorStatus?: number;
  errorMessage?: string;
}

/** POST /api/marketplace/ask — owner sets / updates / clears the ask price.
 *  Pass priceLight=null to unlist (clear the ask). */
export async function setAskPrice(input: {
  appId: string;
  priceLight: number | null;
  floorLight?: number;
  instantBuy?: boolean;
  note?: string;
}): Promise<SetAskPriceResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/marketplace/ask', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: input.appId,
      price_light: input.priceLight,
      floor_light: input.floorLight,
      instant_buy: input.instantBuy,
      note: input.note,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorStatus: res.status, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as Omit<SetAskPriceResult, 'ok' | 'errorStatus' | 'errorMessage'>;
  return { ok: true, ...data };
}

export interface AcceptBidResult {
  ok: boolean;
  sale_id?: string;
  app_id?: string;
  seller_id?: string;
  buyer_id?: string;
  sale_price_light?: number;
  platform_fee_light?: number;
  seller_payout_light?: number;
  fee_would_have_been_light?: number;
  fee_waived_light?: number;
  waiver_source?: string | null;
  waiver_event_id?: string | null;
  errorStatus?: number;
  errorMessage?: string;
}

/** POST /api/marketplace/accept — owner accepts a bid. Atomic ownership
 *  transfer + Light debit (buyer) + credit (seller). */
export async function acceptBid(bidId: string): Promise<AcceptBidResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/marketplace/accept', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bid_id: bidId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorStatus: res.status, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as Omit<AcceptBidResult, 'ok' | 'errorStatus' | 'errorMessage'>;
  return { ok: true, ...data };
}

/** POST /api/marketplace/reject — owner declines a bid, refunds escrow. */
export async function rejectBid(bidId: string): Promise<{ ok: boolean; errorMessage?: string }> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/marketplace/reject', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bid_id: bidId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  return { ok: true };
}

/** PATCH /api/marketplace/metrics-visibility — owner toggles whether the
 *  listing exposes 30d revenue + call-volume to prospective bidders. The BE
 *  surface is a boolean (`show_metrics`); the FE picker exposes a 4-tier
 *  model (public / threshold / shortlist / private) per the addendum, but
 *  only public ↔ private map to BE state today. Threshold + shortlist are
 *  rendered for design parity and gated as "BE work needed" until B-section
 *  follow-ups land. */
export async function setMetricsVisibility(input: {
  appId: string;
  showMetrics: boolean;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/marketplace/metrics-visibility', {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: input.appId, show_metrics: input.showMetrics }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  return { ok: true };
}

export interface InstantAcquireResult {
  ok: boolean;
  sale_id?: string;
  app_id?: string;
  sale_price_light?: number;
  platform_fee_light?: number;
  seller_payout_light?: number;
  fee_would_have_been_light?: number;
  fee_waived_light?: number;
  waiver_source?: string | null;
  waiver_event_id?: string | null;
  errorStatus?: number;
  errorMessage?: string;
}

/** POST /api/marketplace/acquire — atomic instant-buy at the ask price.
 *  Only allowed when listing.instant_buy === true. */
export async function instantAcquire(appId: string): Promise<InstantAcquireResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/marketplace/acquire', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorStatus: res.status, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as Omit<InstantAcquireResult, 'ok' | 'errorStatus' | 'errorMessage'>;
  return { ok: true, ...data };
}

export interface NewlyAcquiredEntry {
  receipt_id: string;
  sale_id: string;
  type: 'acquisition';
  app_id: string;
  app_name: string;
  app_slug?: string;
  app_url?: string;
  sale_price_light: number;
  created_at: string;
  receipt_url?: string;
  buyer?: { user_id: string; display_name?: string; profile_slug?: string; avatar_url?: string };
  seller?: { user_id: string; display_name?: string; profile_slug?: string; avatar_url?: string };
}

export async function fetchNewlyAcquired(limit = 10): Promise<NewlyAcquiredEntry[]> {
  const res = await fetchFromApi(`/api/discover/newly-acquired?limit=${limit}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) return [];
  const data = await res.json() as NewlyAcquiredEntry[] | { results?: NewlyAcquiredEntry[] };
  return Array.isArray(data) ? data : (data.results ?? []);
}

// ── Usage time-series (B12) ──
//
// `GET /api/usage?range=7d|30d|90d|1y&groupBy=app` returns server-side
// aggregated usage broken down per app. Replaces the legacy 7-day
// client-side strip in Profile → Balance (which summed the last 50
// transactions and lied as soon as usage activity grew dense).
//
// Buckets:
//   7d  → daily         (7 buckets,  labels: M T W T F S S)
//   30d → daily         (30 buckets, labels: every-4th-day numeric)
//   90d → weekly        (13 buckets, labels: W1 … W13)
//   1y  → monthly       (12 buckets, labels: Jun … May)
//
// BE aggregates the heavier ranges (90d, 1y) so payload stays small.
// FE-first with graceful fallback: returns null on non-200 and
// UsageChart renders an empty-state message ("No usage in the last
// {range}.") while keeping the range selector usable, so the user
// can retry once BE rolls out.

export type UsageRange = '7d' | '30d' | '90d' | '1y';

export interface UsageBucket {
  /** X-axis label, pre-formatted by the BE to match the range type. */
  label: string;
  /** Per-app spend totals (✦) keyed by app_id. */
  values: Record<string, number>;
}

export interface UsageAppInfo {
  id: string;
  name: string;
  tone?: string;   // hex — data, not a design token
  glyph?: string;  // 1-3 char monogram
}

export interface UsageSeriesResponse {
  range: UsageRange;
  buckets: UsageBucket[];
  totals: {
    spend: number;
    avgPerDay: number;
    priorSpend: number;
    /** Percent change vs the same-length prior window (18 = +18%). */
    deltaPct: number;
  };
  apps: UsageAppInfo[];
}

export async function fetchUsageSeries(
  range: UsageRange,
  options: { groupBy?: 'app' | 'category' } = {},
): Promise<UsageSeriesResponse | null> {
  const token = getToken();
  if (!token) return null;
  const params = new URLSearchParams({ range });
  if (options.groupBy) params.set('groupBy', options.groupBy);
  const res = await fetchFromApi(`/api/usage?${params.toString()}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await res.json() as UsageSeriesResponse;
}

// ── Library install / uninstall (B11) ──
//
// `POST /api/user/library/install` and `…/uninstall` toggle the
// user_app_library join row for the current user. Idempotent — re-
// installing returns the existing row, re-uninstalling a missing row
// is a no-op. Used by ToolDetailView's install state machine.
//
// FE-first with graceful fallback: a non-200 leaves the button in the
// `idle` state and surfaces the error inline so the user can retry.

export interface InstallLibraryAppResult {
  ok: boolean;
  /** Server timestamp of the join row (existing on idempotent re-install
   *  so the FE can show "installed N min ago" without an extra fetch). */
  installed_at?: string;
  errorMessage?: string;
}

export async function installLibraryApp(appId: string): Promise<InstallLibraryAppResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/user/library/install', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json().catch(() => ({})) as Partial<InstallLibraryAppResult>;
  return { ok: true, ...data };
}

export async function uninstallLibraryApp(appId: string): Promise<{ ok: boolean; errorMessage?: string }> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/user/library/uninstall', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  return { ok: true };
}

export type CapabilitySuggestionEventType =
  | 'viewed'
  | 'accepted'
  | 'dismissed'
  | 'installed'
  | 'used'
  | 'failed';

export interface CapabilitySuggestionEventInput {
  eventType: CapabilitySuggestionEventType;
  intentId?: string;
  suggestionSetId?: string;
  suggestionId?: string;
  conversationId?: string;
  traceId?: string;
  messageId?: string;
  appId?: string;
  appSlug?: string;
  eventSource?: string;
  installOnAccept?: boolean;
  metadata?: Record<string, unknown>;
}

export async function recordCapabilitySuggestionEvent(
  input: CapabilitySuggestionEventInput,
): Promise<{ ok: boolean; eventId?: string; libraryInstalled?: boolean; errorMessage?: string }> {
  try {
    const res = await fetchFromApi('/chat/capability-suggestion-event', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        event_type: input.eventType,
        intent_id: input.intentId,
        suggestion_set_id: input.suggestionSetId,
        suggestion_id: input.suggestionId,
        conversation_id: input.conversationId,
        trace_id: input.traceId,
        message_id: input.messageId,
        app_id: input.appId,
        app_slug: input.appSlug,
        event_source: input.eventSource || 'desktop',
        install_on_accept: input.installOnAccept,
        metadata: input.metadata,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, errorMessage: text || `Failed (${res.status})` };
    }
    const data = await res.json().catch(() => ({})) as {
      event_id?: string;
      library_installed?: boolean;
    };
    return {
      ok: true,
      eventId: data.event_id,
      libraryInstalled: data.library_installed,
    };
  } catch (err) {
    return {
      ok: false,
      errorMessage: err instanceof Error ? err.message : 'Suggestion telemetry failed',
    };
  }
}

// ── Author profile (B7) ──
//
// `GET /api/author/:handle` returns the public author page payload
// described in the Batch B addendum. FE-first with graceful fallback —
// on any non-200 we return null and AuthorProfileView surfaces an
// empty-with-header state so the page is still navigable during the
// BE deploy gap.
//
// `earnings` is server-side-masked to null for non-owners; the FE never
// computes the unmasked value.

export interface AuthorProfileLink {
  label: string;
  url: string;
}

export interface AuthorProfileToolSummary {
  id: string;
  name: string;
  slug?: string;
  tagline?: string;
  description?: string;
  category?: string;
  installs?: number;
  call_price_light?: number;
  /** 7d daily-bucket trend, oldest first. Same shape as MarketplaceResult.sparkline. */
  sparkline?: number[];
  growth_7d?: number;
  glyph_tone?: string;
}

export interface AuthorProfileAcquisition {
  id: string;
  app_id: string;
  app_name: string;
  app_slug?: string;
  glyph_tone?: string;
  from_handle: string;
  /** Sale price; null when the seller hasn't opted in to public revenue. */
  sale_price_light?: number | null;
  acquired_at: string;
  calls_per_week?: number;
}

export interface AuthorProfileActivityEvent {
  /** ISO timestamp. */
  at: string;
  /** `"published" | "version_bump" | "acquired" | "joined"` — free-form for forward-compat. */
  kind: string;
  /** Human-readable description rendered as-is in the timeline. */
  text: string;
}

export interface AuthorProfileResponse {
  handle: string;
  display_name?: string | null;
  bio?: string | null;
  location?: string | null;
  joined?: string | null;            // ISO timestamp
  links?: AuthorProfileLink[];
  glyph_tone?: string | null;        // hex
  verified?: boolean;
  stats?: {
    published: number;
    installs: number;
    acquisitions: number;
    /** null for non-owners — BE masks server-side per the spec. */
    earnings: number | null;
  };
  tools?: AuthorProfileToolSummary[];
  acquisitions?: AuthorProfileAcquisition[];
  activity?: AuthorProfileActivityEvent[];
}

export async function fetchAuthorProfile(handle: string): Promise<AuthorProfileResponse | null> {
  const token = getToken();
  // Strip the leading @ if present — endpoint expects the raw handle.
  const clean = handle.startsWith('@') ? handle.slice(1) : handle;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchFromApi(`/api/author/${encodeURIComponent(clean)}`, { headers });
  if (!res.ok) return null;
  return await res.json() as AuthorProfileResponse;
}

// ── Acquisition handoff banners (G1 + G2) ──
//
// Two feeds for the post-acceptance moments: sales the current user
// closed as the seller (G1 SellerLibraryBanner), and acquisitions they
// completed as the buyer (G2 BuyerLibraryBanner). Both wrap the same
// BE row shape — the difference is which side made the move and which
// dismissed-at column is checked.
//
// FE returns an empty list on any non-200 response, so banners simply
// don't render during the BE-deploy gap. No flash, no error UI.

export interface HandoffBannerItem {
  sale_id: string;
  app_id: string;
  app_name: string;
  app_slug: string;
  /** For G1 (seller side): the buyer's display handle. */
  buyer_handle?: string;
  /** For G2 (buyer side): the prior owner's display handle. */
  prior_owner_handle?: string;
  sale_price_light: number;
  /** ISO timestamp. `acquired_at` on the buyer feed, `sold_at` on the
   *  seller feed — BE may use either field name; FE prefers acquired_at
   *  when present, falls back to sold_at. */
  acquired_at?: string;
  sold_at?: string;
  path: 'accepted' | 'instant';
}

export async function fetchRecentlySold(): Promise<HandoffBannerItem[]> {
  const token = getToken();
  if (!token) return [];
  const res = await fetchFromApi('/api/marketplace/recently-sold', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json() as { items?: HandoffBannerItem[] } | HandoffBannerItem[];
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function fetchRecentlyAcquired(): Promise<HandoffBannerItem[]> {
  const token = getToken();
  if (!token) return [];
  const res = await fetchFromApi('/api/marketplace/recently-acquired', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json() as { items?: HandoffBannerItem[] } | HandoffBannerItem[];
  return Array.isArray(data) ? data : (data.items ?? []);
}

export async function dismissHandoffBanner(input: {
  saleId: string;
  side: 'seller' | 'buyer';
}): Promise<{ ok: boolean; errorMessage?: string }> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/marketplace/handoff-banner-dismiss', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sale_id: input.saleId, side: input.side }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  return { ok: true };
}

// ── Profile + Light balance + transactions + earnings ──
//
// All endpoints under /api/user/* return shapes that match the BE today
// (commits 29c7d7e, b13a946, cd63ec8, bc2dbfc). FE renders what it
// understands and tolerates extras.

export interface UserProfile {
  id: string;
  email: string;
  display_name?: string | null;
  avatar_url?: string | null;
  tier?: string;
  country?: string | null;
  featured_app_id?: string | null;
  profile_slug?: string | null;
  byok_enabled?: boolean;
  byok_provider?: string | null;
  created_at?: string;
  /** B14 rollup — exact counts of apps owned + apps acquired by this user.
   *  Optional so FE keeps falling back to the noisy proxies until BE deploys. */
  stats?: {
    published_app_count: number;
    acquired_app_count: number;
  };
}

export async function fetchUserProfile(): Promise<UserProfile | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi('/api/user', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await res.json() as UserProfile;
}

export interface UserHosting {
  balance_light?: number;
  escrow_light?: number;
  deposit_balance_light?: number;
  earned_balance_light?: number;
  escrow_deposit_light?: number;
  escrow_earned_light?: number;
  auto_add_earnings_to_balance?: boolean;
  auto_topup_threshold_light?: number | null;
  auto_topup_amount_light?: number | null;
}

export async function fetchUserHosting(): Promise<UserHosting | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi('/api/user/hosting', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await res.json() as UserHosting;
}

export interface BillingTransaction {
  id?: string;
  user_id?: string;
  type?: 'charge' | 'credit' | 'deposit' | 'refund' | 'transfer' | string;
  category?: string;
  description?: string | null;
  amount_cents?: number;
  balance_after?: number | null;
  amount_light?: number;
  balance_after_light?: number | null;
  billing_config_version?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface UserTransactionsResponse {
  transactions: BillingTransaction[];
  total: number;
  current_rate?: Record<string, number | null>;
}

export async function fetchUserTransactions(options?: {
  limit?: number;
  offset?: number;
  category?: string;
}): Promise<UserTransactionsResponse | null> {
  const token = getToken();
  if (!token) return null;
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  if (options?.category) params.set('category', options.category);
  const qs = params.toString();
  const res = await fetchFromApi(
    `/api/user/transactions${qs ? `?${qs}` : ''}`,
    { headers: { 'Authorization': `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  return await res.json() as UserTransactionsResponse;
}

export interface UserEarnings {
  total_earned_light: number;
  balance_light: number;
  deposit_balance_light: number;
  earned_balance_light: number;
  total_withdrawn_light: number;
  withdrawable_light: number;
  auto_add_earnings_to_balance: boolean;
  period: string;
  period_earned_light: number;
  period_transfers: number;
  by_app: Array<{ app_id: string; earned_light: number; call_count: number }>;
  recent: Array<{
    amount_light: number;
    app_id: string;
    function_name?: string | null;
    reason?: string | null;
    created_at: string;
  }>;
}

export async function fetchUserEarnings(period: '7d' | '30d' | '90d' | 'all' = '30d'): Promise<UserEarnings | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi(`/api/user/earnings?period=${period}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await res.json() as UserEarnings;
}

export interface ConnectStatus {
  connected: boolean;
  onboarded: boolean;
  payouts_enabled: boolean;
  account_id?: string | null;
  country?: string | null;
  default_currency?: string | null;
  withdrawable_earnings_light?: number;
}

export async function fetchConnectStatus(): Promise<ConnectStatus | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi('/api/user/connect/status', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await res.json() as ConnectStatus;
}

// ── Add Light (wallet purchases + earnings transfer) ──

export interface WalletExpressIntentResult {
  ok: boolean;
  publishable_key?: string;
  client_secret?: string;
  payment_intent_id?: string;
  stripe_customer_id?: string;
  amount_cents?: number;
  light_amount?: number;
  wallet_light_per_usd?: number;
  billing_config_version?: number;
  errorStatus?: number;
  errorMessage?: string;
}

/** POST /api/user/wallet/express-checkout-intent — creates a Stripe
 *  PaymentIntent for an Apple/Google Pay wallet checkout. The caller
 *  then completes the payment via Stripe.js (loaded separately). */
export async function createWalletExpressIntent(input: {
  amountCents: number;
  source?: 'web' | 'desktop';
  termsAccepted: boolean;
}): Promise<WalletExpressIntentResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/user/wallet/express-checkout-intent', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount_cents: input.amountCents,
      source: input.source ?? 'desktop',
      terms_accepted: input.termsAccepted,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorStatus: res.status, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as Omit<WalletExpressIntentResult, 'ok' | 'errorStatus' | 'errorMessage'>;
  return { ok: true, ...data };
}

export interface WireTransferIntentResult {
  ok: boolean;
  payment_intent_id?: string;
  client_secret?: string;
  amount_cents?: number;
  light_amount?: number;
  wire_light_per_usd?: number;
  bank_transfer_instructions?: {
    bank_name?: string;
    account_number?: string;
    routing_number?: string;
    swift_code?: string;
    reference?: string;
    [k: string]: unknown;
  };
  errorStatus?: number;
  errorMessage?: string;
}

/** POST /api/user/wallet/wire-transfer-intent — initiates a manual ACH
 *  wire transfer purchase. Response includes wire-transfer instructions
 *  the FE displays for the user to complete from their bank. */
export async function createWireTransferIntent(input: {
  amountCents: number;
  source?: 'web' | 'desktop';
  termsAccepted: boolean;
}): Promise<WireTransferIntentResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/user/wallet/wire-transfer-intent', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount_cents: input.amountCents,
      source: input.source ?? 'desktop',
      terms_accepted: input.termsAccepted,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorStatus: res.status, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as Omit<WireTransferIntentResult, 'ok' | 'errorStatus' | 'errorMessage'>;
  return { ok: true, ...data };
}

export interface ConvertEarningsResult {
  ok: boolean;
  success?: boolean;
  conversion_id?: string;
  converted_light?: number;
  balance_light?: number;
  deposit_balance_light?: number;
  earned_balance_light?: number;
  errorStatus?: number;
  errorMessage?: string;
}

/** POST /api/user/earnings/convert-to-balance — moves earned Light into
 *  spendable balance. 1:1, no fees. Pass `convertAll: true` to move
 *  everything, or `amountLight` for a specific amount. */
export async function convertEarningsToBalance(input: {
  amountLight?: number;
  convertAll?: boolean;
  termsAccepted: boolean;
}): Promise<ConvertEarningsResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/user/earnings/convert-to-balance', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount_light: input.amountLight,
      convert_all: input.convertAll,
      terms_accepted: input.termsAccepted,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorStatus: res.status, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as Omit<ConvertEarningsResult, 'ok' | 'errorStatus' | 'errorMessage'>;
  return { ok: true, ...data };
}

// ── Payouts (Stripe Connect onboarding + withdraw + history) ──

export interface ConnectOnboardResult {
  ok: boolean;
  onboarding_url?: string;
  account_id?: string;
  errorMessage?: string;
}

/** POST /api/user/connect/onboard — creates / resumes Stripe Connect
 *  Express onboarding. The FE opens onboarding_url in the user's
 *  browser; Stripe redirects back to the platform after completion. */
export async function startConnectOnboard(input: { country?: string }): Promise<ConnectOnboardResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/user/connect/onboard', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: input.country }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as Omit<ConnectOnboardResult, 'ok' | 'errorMessage'>;
  return { ok: true, ...data };
}

export interface PayoutWithdrawResult {
  ok: boolean;
  success?: boolean;
  payout_id?: string;
  estimated_arrival?: string;
  fee_breakdown?: Record<string, number>;
  payout_schedule?: { release_at?: string; scheduled_date?: string };
  errorMessage?: string;
}

/** POST /api/user/connect/withdraw — request a payout in ✦Light to the
 *  seller's connected bank. Creates a `payouts` row with status='held';
 *  background processor releases on the configured schedule. */
export async function requestPayoutWithdrawal(input: {
  amountLight: number;
  termsAccepted: boolean;
}): Promise<PayoutWithdrawResult> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/user/connect/withdraw', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount_light: input.amountLight,
      terms_accepted: input.termsAccepted,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as Omit<PayoutWithdrawResult, 'ok' | 'errorMessage'>;
  return { ok: true, ...data };
}

export interface PayoutRow {
  id: string;
  amount_light: number;
  status: 'held' | 'releasing' | 'paid' | 'failed' | 'cancelled' | string;
  created_at: string;
  release_at?: string | null;
  stripe_transfer_id?: string | null;
  stripe_payout_id?: string | null;
  stripe_fee_cents?: number | null;
  net_cents?: number | null;
}

/** GET /api/user/connect/payouts — historical payout list. */
export async function fetchPayoutHistory(limit = 20): Promise<PayoutRow[]> {
  const token = getToken();
  if (!token) return [];
  const res = await fetchFromApi(`/api/user/connect/payouts?limit=${limit}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json() as { payouts?: PayoutRow[] } | PayoutRow[];
  if (Array.isArray(data)) return data;
  return data.payouts ?? [];
}

/** PATCH /api/user/earnings/auto-add — toggle auto-conversion of future
 *  earnings into spendable balance. */
export async function toggleAutoAddEarnings(enabled: boolean): Promise<{ ok: boolean; errorMessage?: string }> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/user/earnings/auto-add', {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  return { ok: true };
}

// ── Profile + billing address mutations (Settings tab) ──

export interface UpdateUserProfileInput {
  display_name?: string;
  country?: string;
  featured_app_id?: string | null;
}

/** PATCH /api/user — update display name / country / featured app. */
export async function updateUserProfile(input: UpdateUserProfileInput): Promise<{ ok: boolean; profile?: UserProfile; errorMessage?: string }> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  const res = await fetchFromApi('/api/user', {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  const data = await res.json() as UserProfile;
  return { ok: true, profile: data };
}

export interface BillingAddress {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  source?: string;
  version?: number;
}

export async function fetchBillingAddress(): Promise<BillingAddress | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetchFromApi('/api/user/billing-address', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as { billing_address?: BillingAddress } | BillingAddress;
  if (data && typeof data === 'object' && 'billing_address' in data && data.billing_address) {
    return data.billing_address;
  }
  return data as BillingAddress;
}

export async function updateBillingAddress(input: BillingAddress): Promise<{ ok: boolean; errorMessage?: string }> {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Not signed in' };
  // BE expects camelCase per the audit (name, line1, line2, city, state, postalCode, country).
  const res = await fetchFromApi('/api/user/billing-address', {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      line1: input.line1,
      line2: input.line2,
      city: input.city,
      state: input.state,
      postalCode: input.postal_code,
      country: input.country,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, errorMessage: text || `Failed (${res.status})` };
  }
  return { ok: true };
}

// ── Task Context (per-request entity + function resolution) ──

export interface TaskContext {
  entities: Array<{
    name: string;
    match: string;
    type: string;
    id: string;
    appId: string;
    appName: string;
    context: string;
  }>;
  functions: Array<{
    name: string;
    appId: string;
    description: string;
    returns: string;
    conventions: string[];
    dependsOn: string[];
  }>;
  conventions: Array<{ appName: string; key: string; value: string }>;
  promptBlock: string;
  modelSuggestion?: string; // flash broker's recommendation: "flash" or "sonnet"
}

/**
 * Resolve task context for a user prompt.
 * POSTs the prompt to /chat/context and returns matched entities,
 * functions, conventions, and a formatted promptBlock for system prompt injection.
 */
export async function fetchTaskContext(
  prompt: string,
): Promise<TaskContext | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const res = await fetchFromApi("/chat/context", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) return null;
    return await res.json() as TaskContext;
  } catch {
    return null;
  }
}

// ── MCP Tool Execution ──

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class ExecutionPlanRequestError extends Error {
  status: number;
  detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "ExecutionPlanRequestError";
    this.status = status;
    this.detail = detail;
  }
}

async function buildExecutionPlanRequestError(
  res: Response,
): Promise<ExecutionPlanRequestError> {
  const fallback = `Execution plan request failed (${res.status})`;
  const text = await res.text().catch(() => "");

  if (!text) {
    return new ExecutionPlanRequestError(fallback, res.status);
  }

  try {
    const parsed = JSON.parse(text) as { error?: string; detail?: string };
    return new ExecutionPlanRequestError(
      parsed.error || fallback,
      res.status,
      parsed.detail || text,
    );
  } catch {
    return new ExecutionPlanRequestError(text, res.status, text);
  }
}

/**
 * Execute an MCP tool call via the platform endpoint.
 */
export async function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const res = await fetchFromApi("/mcp/platform", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return {
      content: [{
        type: "text",
        text: `Tool error (${res.status}): ${errText}`,
      }],
      isError: true,
    };
  }

  const data = await res.json() as {
    result?: McpToolResult;
    error?: { message: string };
  };

  if (data.error) {
    return {
      content: [{ type: "text", text: `Tool error: ${data.error.message}` }],
      isError: true,
    };
  }

  return data.result ||
    { content: [{ type: "text", text: "No result" }], isError: true };
}

/**
 * Call a specific app's MCP endpoint directly (bypasses ul.call prefix issues).
 * toolName must be the slug-prefixed name (e.g., "app-7vftmp_widget_email_inbox_ui").
 */
export async function executeAppMcpTool(
  appUuid: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: AppMcpToolCallOptions,
): Promise<McpToolResult> {
  const res = await fetchFromApi(`/mcp/${appUuid}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: withAppMcpCallMetadata(args, options),
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return {
      content: [{
        type: "text",
        text: `Tool error (${res.status}): ${errText}`,
      }],
      isError: true,
    };
  }

  const data = await res.json() as {
    result?: McpToolResult;
    error?: { message: string };
  };

  if (data.error) {
    return {
      content: [{ type: "text", text: `Tool error: ${data.error.message}` }],
      isError: true,
    };
  }

  return data.result ||
    { content: [{ type: "text", text: "No result" }], isError: true };
}

// ── Balance Check ──

/**
 * Get current balance via MCP wallet tool.
 */
export async function fetchBalance(): Promise<number | null> {
  try {
    const result = await executeMcpTool("ul.wallet", { action: "status" });
    const text = result.content?.[0]?.text || "";
    const match = text.match(/(\d+\.?\d*)\s*light/i) ||
      text.match(/balance[:\s]*✦?(\d+\.?\d*)/i);
    if (match) {
      return parseFloat(match[1]);
    }
    return null;
  } catch {
    return null;
  }
}

// ── Orchestrate Stream ──

export interface OrchestrateEvent {
  type:
    // Flash phase
    | "flash_status"
    | "ambient_suggestions"
    | "flash_search"
    | "flash_found"
    | "flash_context"
    | "flash_prompt"
    | "flash_direct"
    // Heavy phase
    | "heavy_status"
    | "heavy_text"
    | "heavy_recipe"
    // Execution phase
    | "plan_ready"
    | "plan_cancelled"
    | "exec_start"
    | "exec_result"
    // System agent delegation
    | "system_agent_spawn"
    // Meta
    | "usage"
    | "done"
    | "error"
    // Legacy compat
    | "status"
    | "text"
    | "tool_start"
    | "result";
  text?: string;
  content?: string;
  name?: string;
  code?: string;
  data?: unknown;
  flash?: unknown;
  heavy?: unknown;
  message?: string;
  status?: number;
  error?: string;
  balance_light?: number;
  minimum_light?: number;
  topup_url?: string;
  allowed_models?: string[];
  resetAt?: string;
  query?: string;
  apps?: string[];
  intent_id?: string;
  suggestion_set_id?: string;
  suggestions?: AmbientSuggestion[];
  entity?: string;
  detail?: string;
  functions?: string[];
  conventions?: number;
  prompt?: string;
  model?: string;
  /** System agent delegation fields */
  agentType?: string;
  task?: string;
  originalPrompt?: string;
  plan?: {
    id: string;
    recipe: string;
    tools_used: ToolUsed[];
    total_cost_light: number;
    created_at: number;
  };
  planId?: string;
  reason?: string;
}

/**
 * Stream events from the /chat/orchestrate SSE endpoint.
 * The server handles routing, tool execution, and model selection —
 * the client just consumes the event stream.
 */
export async function* streamOrchestrate(opts: {
  message: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  interpreterModel?: string;
  heavyModel?: string;
  inference?: InferenceRoutePreference;
  scope?: Record<
    string,
    {
      access: "all" | "functions" | "data";
      functions?: string[];
      conventions?: Record<string, string>;
    }
  >;
  /** Behavioral instructions from the agent's admin notes */
  adminNotes?: string;
  systemAgentStates?: Array<
    {
      type: string;
      name: string;
      tools: string[];
      stateSummary: string | null;
      status: string;
    }
  >;
  systemAgentContext?: { type: string; persona: string; skillsPath: string };
  /** Local project file context gathered client-side for Tool Maker */
  projectContext?: string;
  /** Active widget surfaces supplied by widget-local composers. */
  activeWidgetContexts?: ActiveWidgetContext[];
  /** Conversation ID for rolling summary persistence */
  conversationId?: string;
  /** Stable local message IDs for server-side capture idempotency */
  userMessageId?: string;
  assistantMessageId?: string;
  /** Attached files (base64 data URLs) */
  files?: Array<
    { name: string; size: number; mimeType: string; content: string }
  >;
}): AsyncGenerator<OrchestrateEvent> {
  let res: Response;
  try {
    res = await fetchFromApi("/chat/orchestrate", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(opts),
    });
  } catch (err) {
    yield {
      type: "error",
      message: `Network error: ${
        err instanceof Error ? err.message : "Connection failed"
      }`,
    };
    return;
  }

  if (!res.ok) {
    let apiError: ApiError;
    try {
      apiError = await res.json() as ApiError;
    } catch {
      apiError = { error: `HTTP ${res.status}: ${res.statusText}` };
    }
    yield {
      type: "error",
      message: formatApiError(apiError, res.status),
      status: res.status,
      code: apiError.code,
      detail: apiError.detail,
      balance_light: apiError.balance_light,
      minimum_light: apiError.minimum_light,
      topup_url: apiError.topup_url,
      allowed_models: apiError.allowed_models,
      resetAt: apiError.resetAt,
    };
    return;
  }

  if (!res.body) {
    yield { type: "error", message: "No response body" };
    return;
  }

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { type: "done" };
          return;
        }
        try {
          yield JSON.parse(data) as OrchestrateEvent;
        } catch {
          // Skip unparseable lines
        }
      }
    }
  }
}

export async function confirmExecutionPlan(planId: string): Promise<void> {
  const res = await fetchFromApi(`/chat/plan/${planId}/confirm`, {
    method: "POST",
    headers: authHeaders(),
  });

  if (!res.ok) {
    throw await buildExecutionPlanRequestError(res);
  }
}

export async function cancelExecutionPlan(planId: string): Promise<void> {
  const res = await fetchFromApi(`/chat/plan/${planId}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });

  if (!res.ok) {
    throw await buildExecutionPlanRequestError(res);
  }
}

// ── Conversation Embedding ──

/** Embed a conversation summary for cross-session semantic search */
export async function embedConversation(opts: {
  conversationId: string;
  conversationName: string;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await fetchFromApi("/api/user/conversation-embedding", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(opts),
    });
  } catch (err) {
    apiLogger.warn("Failed to embed conversation", { error: err });
  }
}

// ── System Agent State Sync ──

/** Sync system agent states to server KV for Flash's Context Index */
export async function syncSystemAgentStates(
  states: Array<
    {
      type: string;
      name: string;
      tools: string[];
      stateSummary: string | null;
      status: string;
    }
  >,
): Promise<void> {
  try {
    await fetchFromApi("/api/user/system-agent-states", {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ states }),
    });
  } catch (err) {
    apiLogger.warn("Failed to sync system agent states", { error: err });
  }
}

// ── Helpers ──

function formatApiError(err: ApiError, status: number): string {
  // Include server detail if available
  const detail = err.detail ? ` (${err.detail})` : "";

  switch (status) {
    case 401:
      return `Authentication failed${detail}`;
    case 402:
      return `Insufficient balance (${
        formatLight(err.balance_light || 0)
      } remaining). Add Light from Wallet.`;
    case 403:
      return err.error || "Access denied. A full account is required for chat.";
    case 429:
      return `Rate limit exceeded.${
        err.resetAt
          ? ` Try again at ${new Date(err.resetAt).toLocaleTimeString()}.`
          : ""
      }`;
    case 503:
      return "Chat service is temporarily unavailable. Please try again shortly.";
    default:
      return err.error || `Request failed (${status})`;
  }
}
