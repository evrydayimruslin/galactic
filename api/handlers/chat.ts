// Chat Stream Handler
// Authenticated streaming proxy to OpenAI-compatible providers.
// Light mode uses Ultralight platform keys; BYOK mode uses the user's provider key.
//
// Architecture: Client-side tool dispatch — the Tauri app
// handles the tool-use loop. This endpoint is a billing/auth proxy that
// streams tokens and captures usage for post-stream cost deduction.

import { authenticate } from "./auth.ts";
import { error, json } from "./response.ts";
import { checkRateLimit } from "../services/ratelimit.ts";
import {
  calculateCostLight,
  checkChatBalance,
  deductChatCost,
} from "../services/chat-billing.ts";
import { getOrCreateOpenRouterKey } from "../services/openrouter-keys.ts";
import { fetchInferenceChatCompletion } from "../services/inference-client.ts";
import {
  InferenceRouteError,
  resolveInferenceRoute,
} from "../services/inference-route.ts";
import { buildInferenceOptions } from "../services/inference-options.ts";
import type { SystemAgentContext } from "../services/flash-broker.ts";
import {
  CHAT_MIN_BALANCE_LIGHT,
  type ChatStreamRequest,
  type ChatUsage,
  type InferenceRoutePreference,
  type ToolInvocationTelemetryRequest,
} from "../../shared/contracts/ai.ts";
import type { ActiveWidgetContext } from "../../shared/contracts/widget.ts";
import { createServerLogger } from "../services/logging.ts";
import { isValidModelId } from "../services/model-validation.ts";
import {
  createChatStreamCaptureSession,
  createOrchestrateCaptureSession,
  scheduleCaptureTask,
} from "../services/chat-capture.ts";
import {
  createLlmInvocationTelemetrySession,
  recordToolInvocationTelemetry,
} from "../services/invocation-telemetry.ts";
import { recordCapabilitySuggestionEvent } from "../services/capability-suggestion-telemetry.ts";
import { validateCapabilitySuggestionEventRequest } from "../services/capability-suggestion-validation.ts";
import { RequestValidationError } from "../services/request-validation.ts";

const chatLogger = createServerLogger("CHAT");
const TOOL_TELEMETRY_STATUSES = new Set([
  "success",
  "error",
  "aborted",
  "timeout",
]);

async function enforceChatGuards(
  userId: string,
  resource: string,
  options: { requireBalance?: boolean } = {},
): Promise<{ balance: number | null } | Response> {
  const rateResult = await checkRateLimit(
    userId,
    "chat:stream",
    undefined,
    undefined,
    {
      mode: "fail_closed",
      resource,
    },
  );
  if (!rateResult.allowed) {
    if (rateResult.reason === "service_unavailable") {
      return json({
        error:
          "Chat is temporarily unavailable while usage controls recover. Please try again shortly.",
      }, 503);
    }

    return json(
      {
        error: "Rate limit exceeded",
        resetAt: rateResult.resetAt.toISOString(),
      },
      429,
    );
  }

  if (options.requireBalance === false) {
    chatLogger.info("Skipped chat balance gate for non-Light inference route", {
      user_id: userId,
      resource,
    });
    return { balance: null };
  }

  try {
    const balance = await checkChatBalance(userId);
    chatLogger.info("Checked chat balance", {
      user_id: userId,
      balance_light: balance,
      minimum_light: CHAT_MIN_BALANCE_LIGHT,
      resource,
    });

    if (balance < CHAT_MIN_BALANCE_LIGHT) {
      return json({
        error: "Insufficient balance",
        balance_light: balance,
        minimum_light: CHAT_MIN_BALANCE_LIGHT,
        topup_url: "/wallet",
      }, 402);
    }

    return { balance };
  } catch (err) {
    chatLogger.error("Balance check unavailable; blocking chat request", {
      user_id: userId,
      resource,
      error: err,
    });
    return json({
      error:
        "Billing service temporarily unavailable. Please try again shortly.",
    }, 503);
  }
}

// ============================================
// POST /chat/stream — Streaming proxy
// ============================================

export async function handleChatStream(request: Request): Promise<Response> {
  // ── 1. Auth ──
  const authHeader = request.headers.get("Authorization");
  chatLogger.info("Chat auth attempt", {
    authorization_present: !!authHeader,
  });

  let user: { id: string; email: string; tier: string; provisional?: boolean };
  try {
    user = await authenticate(request);
    chatLogger.info("Chat auth succeeded", {
      user_id: user.id,
      tier: user.tier,
      provisional: !!user.provisional,
    });
  } catch (err) {
    chatLogger.warn("Chat auth failed", {
      error: err,
    });
    return json({
      error: "Unauthorized",
      detail: err instanceof Error ? err.message : "Auth failed",
    }, 401);
  }

  // Block provisional users (no balance, no billing)
  if (user.provisional) {
    chatLogger.info("Blocked provisional user from chat", { user_id: user.id });
    return json({
      error:
        "Chat requires a full account. Sign in at ultralight-api.rgn4jz429m.workers.dev",
    }, 403);
  }

  // ── 2. Parse & validate request body ──
  let body: ChatStreamRequest;
  try {
    body = await request.json() as ChatStreamRequest;
    chatLogger.info("Parsed chat request body", {
      user_id: user.id,
      model: body.model,
      message_count: body.messages?.length ?? 0,
      tool_count: body.tools?.length || 0,
    });
  } catch (parseErr) {
    chatLogger.warn("Chat JSON parse failed", { error: parseErr });
    return error("Invalid JSON body", 400);
  }

  if (!body.model || typeof body.model !== "string") {
    chatLogger.warn("Chat request missing model field", { user_id: user.id });
    return error("model is required", 400);
  }
  if (!isValidModelId(body.model)) {
    chatLogger.warn("Chat request used invalid model id format", {
      user_id: user.id,
      model: body.model,
    });
    return json({
      error:
        `Invalid model ID format: ${body.model}. Expected a provider-native model ID`,
    }, 400);
  }
  if (body.inference?.model && !isValidModelId(body.inference.model)) {
    return json({
      error:
        `Invalid model ID format: ${body.inference.model}. Expected a provider-native model ID`,
    }, 400);
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return error("messages array is required and must not be empty", 400);
  }
  for (const msg of body.messages) {
    if (
      !msg.role || !["system", "user", "assistant", "tool"].includes(msg.role)
    ) {
      return error(`Invalid message role: ${msg.role}`, 400);
    }
  }

  // ── 3. Resolve inference route ──
  let route: Awaited<ReturnType<typeof resolveInferenceRoute>>;
  try {
    route = await resolveInferenceRoute({
      userId: user.id,
      userEmail: user.email,
      requestedModel: body.model,
      selection: body.inference,
    });
    chatLogger.info("Resolved chat inference route", {
      user_id: user.id,
      provider: route.provider,
      upstream_provider: route.upstreamProvider,
      billing_mode: route.billingMode,
      key_source: route.keySource,
      model: route.model,
      canonical_model_id: route.canonicalModelId,
      require_balance: route.shouldRequireBalance,
      debit_light: route.shouldDebitLight,
    });
  } catch (err) {
    chatLogger.error("Failed to resolve chat inference route", {
      user_id: user.id,
      error: err,
    });

    if (err instanceof InferenceRouteError) {
      return json({
        error: "Chat service unavailable",
        code: err.code,
        detail: err.message,
      }, err.status);
    }

    return json({
      error: "Chat service unavailable",
      detail: err instanceof Error
        ? err.message
        : "Inference route resolution failed",
    }, 503);
  }

  // ── 4. Rate limit + conditional balance gate ──
  const guardResult = await enforceChatGuards(user.id, "chat stream", {
    requireBalance: route.shouldRequireBalance,
  });
  if (guardResult instanceof Response) {
    return guardResult;
  }

  const captureTraceId = body.trace?.traceId || crypto.randomUUID();
  const captureConversationId = body.trace?.conversationId || captureTraceId;
  const captureAssistantMessageId = body.trace?.messageId ||
    crypto.randomUUID();
  const captureSource = body.trace?.source || "chat_stream";
  const captureSession = createChatStreamCaptureSession({
    userId: user.id,
    userEmail: user.email,
    conversationId: captureConversationId,
    assistantMessageId: captureAssistantMessageId,
    traceId: captureTraceId,
    source: captureSource,
    messages: body.messages,
    tools: body.tools,
    requestedModel: body.model,
    resolvedModel: route.model,
    provider: route.provider,
    billingMode: route.billingMode,
    keySource: route.keySource,
    inference: body.inference,
    temperature: body.temperature ?? 0.7,
    maxTokens: body.max_tokens ?? 4096,
  });
  captureSession?.start();

  // ── 5. Forward to the resolved OpenAI-compatible provider with streaming ──
  const providerBody = {
    model: route.model,
    messages: body.messages,
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens ?? 4096,
    stream: true,
    stream_options: { include_usage: true },
    ...(body.tools && body.tools.length > 0 ? { tools: body.tools } : {}),
  };

  const llmTelemetry = createLlmInvocationTelemetrySession({
    userId: user.id,
    userEmail: user.email,
    invocationId: captureTraceId,
    traceId: captureTraceId,
    conversationId: captureConversationId,
    source: captureSource,
    phase: "chat_stream",
    provider: route.provider,
    requestedModel: body.model,
    resolvedModel: route.model,
    billingMode: route.billingMode,
    keySource: route.keySource,
    requestParams: {
      temperature: body.temperature ?? 0.7,
      max_tokens: body.max_tokens ?? 4096,
      stream: true,
      stream_options: { include_usage: true },
      inference: body.inference ?? null,
    },
    messages: body.messages,
    tools: body.tools,
    metadata: {
      assistant_message_id: captureAssistantMessageId,
      tool_schema_count: body.tools?.length || 0,
    },
  });
  llmTelemetry?.start();

  chatLogger.info("Forwarding chat request to AI provider", {
    user_id: user.id,
    provider: route.provider,
    upstream_provider: route.upstreamProvider,
    billing_mode: route.billingMode,
    model: route.model,
    message_count: body.messages.length,
  });

  let providerRes: Response;
  try {
    providerRes = await fetchInferenceChatCompletion(route, providerBody, {
      title: "Ultralight Chat",
    });
    chatLogger.info("AI provider responded to chat request", {
      user_id: user.id,
      provider: route.provider,
      model: route.model,
      status: providerRes.status,
    });
  } catch (err) {
    chatLogger.error("AI provider fetch failed", {
      user_id: user.id,
      provider: route.provider,
      model: route.model,
      error: err,
    });
    captureSession?.observeError(
      err instanceof Error ? err.message : "fetch failed",
      {
        phase: "provider_fetch",
        provider: route.provider,
        model: route.model,
      },
    );
    if (captureSession) {
      scheduleCaptureTask(captureSession.finish("provider_fetch_error"));
    }
    if (llmTelemetry) {
      scheduleCaptureTask(llmTelemetry.finish({
        status: "error",
        errorType: "provider_fetch",
        errorMessage: err instanceof Error ? err.message : "fetch failed",
        metadata: {
          provider: route.provider,
          model: route.model,
        },
      }));
    }
    return json({
      error: "Upstream service unavailable",
      detail: err instanceof Error ? err.message : "fetch failed",
    }, 502);
  }

  // Handle non-streaming error from provider
  if (!providerRes.ok) {
    let errMsg = "Upstream error";
    try {
      const errBody = await providerRes.json() as {
        error?: { message?: string };
      };
      errMsg = errBody?.error?.message || errMsg;
      chatLogger.warn("AI provider returned an error response", {
        user_id: user.id,
        provider: route.provider,
        model: route.model,
        status: providerRes.status,
        upstream_message: errMsg,
      });
    } catch { /* use default */ }
    captureSession?.observeError(errMsg, {
      phase: "provider_response",
      provider: route.provider,
      model: route.model,
      status: providerRes.status,
    });
    if (captureSession) {
      scheduleCaptureTask(captureSession.finish("provider_error"));
    }
    if (llmTelemetry) {
      scheduleCaptureTask(llmTelemetry.finish({
        status: "error",
        errorType: "provider_response",
        errorMessage: errMsg,
        metadata: {
          provider: route.provider,
          model: route.model,
          status: providerRes.status,
        },
      }));
    }
    return json(
      {
        error: errMsg,
        detail: `${route.provider} returned ${providerRes.status}`,
      },
      providerRes.status >= 500 ? 502 : providerRes.status,
    );
  }

  if (!providerRes.body) {
    captureSession?.observeError("No response body from upstream", {
      phase: "provider_response",
      provider: route.provider,
      model: route.model,
    });
    if (captureSession) {
      scheduleCaptureTask(captureSession.finish("provider_empty_body"));
    }
    if (llmTelemetry) {
      scheduleCaptureTask(llmTelemetry.finish({
        status: "error",
        errorType: "provider_empty_body",
        errorMessage: "No response body from upstream",
        metadata: {
          provider: route.provider,
          model: route.model,
        },
      }));
    }
    return error("No response body from upstream", 502);
  }

  // ── 6. Create pass-through transform that captures usage ──
  let capturedUsage: ChatUsage | null = null;
  let capturedTotalCost: number | undefined = undefined;
  let capturedFinishReason: string | null = null;
  const userId = user.id;
  const model = route.model;
  const billingModel = route.billingModelId ?? route.model;
  const provider = route.provider;
  const shouldDebitLight = route.shouldDebitLight;
  const decoder = new TextDecoder();
  let sseBuffer = "";

  function processProviderSseLine(line: string): void {
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as {
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
          total_cost?: number;
        };
      };
      captureSession?.observeProviderChunk(parsed);
      if (parsed.usage) {
        const promptTokens = parsed.usage.prompt_tokens || 0;
        const completionTokens = parsed.usage.completion_tokens || 0;
        capturedUsage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: parsed.usage.total_tokens ||
            promptTokens + completionTokens,
          prompt_cache_hit_tokens: parsed.usage.prompt_cache_hit_tokens,
          prompt_cache_miss_tokens: parsed.usage.prompt_cache_miss_tokens,
        };
        if (parsed.usage.total_cost !== undefined) {
          capturedTotalCost = parsed.usage.total_cost;
        }
      }
      const finishReason =
        (parsed as { choices?: Array<{ finish_reason?: string | null }> })
          .choices?.[0]?.finish_reason;
      if (finishReason) {
        capturedFinishReason = finishReason;
      }
    } catch {
      // Not valid JSON yet — keep streaming bytes to the client regardless.
    }
  }

  function processProviderSseText(text: string, final = false): void {
    sseBuffer += text;
    const lines = sseBuffer.split("\n");
    sseBuffer = final ? "" : lines.pop() || "";
    for (const line of lines) processProviderSseLine(line);
  }

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(
      chunk: Uint8Array,
      controller: TransformStreamDefaultController<Uint8Array>,
    ) {
      // Pass chunk through immediately (zero added latency)
      controller.enqueue(chunk);

      // Best-effort parse of SSE data lines to capture usage from final chunk
      try {
        processProviderSseText(decoder.decode(chunk, { stream: true }));
      } catch {
        // Decode error — data still passes through to client
      }
    },

    flush() {
      try {
        processProviderSseText(decoder.decode(), true);
      } catch {
        // Decode error at stream end — data already passed through to client
      }

      if (capturedUsage && capturedUsage.total_tokens > 0 && shouldDebitLight) {
        deductChatCost(
          userId,
          capturedUsage,
          billingModel,
          capturedTotalCost,
          {
            traceId: captureTraceId,
            conversationId: captureConversationId,
            messageId: captureAssistantMessageId,
            source: captureSource,
            provider,
            upstream_provider: route.upstreamProvider,
            upstream_model: model,
            canonical_model_id: route.canonicalModelId ?? null,
          },
          { billingSource: route.billingSource },
        )
          .then((result) => {
            chatLogger.info("Post-stream chat billing succeeded", {
              user_id: userId,
              model: billingModel,
              upstream_model: model,
              cost_light: result.cost_light,
              prompt_tokens: capturedUsage!.prompt_tokens,
              prompt_cache_hit_tokens: capturedUsage!.prompt_cache_hit_tokens,
              prompt_cache_miss_tokens: capturedUsage!.prompt_cache_miss_tokens,
              completion_tokens: capturedUsage!.completion_tokens,
              total_tokens: capturedUsage!.total_tokens,
              balance_depleted: result.was_depleted,
            });
          })
          .catch((err) => {
            chatLogger.error("Post-stream chat billing failed", {
              user_id: userId,
              model,
              error: err,
            });
          });
      } else if (capturedUsage && capturedUsage.total_tokens > 0) {
        chatLogger.info("Skipped post-stream Light debit for BYOK chat route", {
          user_id: userId,
          provider,
          model,
          prompt_tokens: capturedUsage.prompt_tokens,
          completion_tokens: capturedUsage.completion_tokens,
          total_tokens: capturedUsage.total_tokens,
        });
      } else {
        chatLogger.warn("No usage captured for completed chat stream", {
          user_id: userId,
          model,
        });
      }
      if (captureSession) {
        scheduleCaptureTask(captureSession.finish("stream_flush"));
      }
      if (llmTelemetry) {
        scheduleCaptureTask(llmTelemetry.finish({
          status: "success",
          finishReason: capturedFinishReason,
          usage: capturedUsage
            ? {
              ...capturedUsage,
              total_cost: capturedTotalCost ?? null,
            }
            : {},
          costLight: capturedUsage
            ? calculateCostLight(
              capturedUsage,
              billingModel,
              capturedTotalCost,
              {
                billingSource: route.billingSource,
              },
            )
            : null,
          metadata: {
            provider,
            upstream_provider: route.upstreamProvider,
            model,
            billing_model: billingModel,
            canonical_model_id: route.canonicalModelId ?? null,
            should_debit_light: shouldDebitLight,
            assistant_message_id: captureAssistantMessageId,
          },
        }));
      }
    },
  });

  // Pipe provider response through the transform (runs in background)
  providerRes.body.pipeTo(transformStream.writable).catch((err) => {
    chatLogger.error("Chat stream pipe failed", {
      user_id: userId,
      model,
      error: err,
    });
    captureSession?.observeError(
      err instanceof Error ? err.message : String(err),
      {
        phase: "stream_pipe",
        provider,
        model,
      },
    );
    if (captureSession) {
      scheduleCaptureTask(captureSession.finish("pipe_error"));
    }
    if (llmTelemetry) {
      scheduleCaptureTask(llmTelemetry.finish({
        status: "error",
        errorType: "stream_pipe",
        errorMessage: err instanceof Error ? err.message : String(err),
        usage: capturedUsage
          ? {
            ...capturedUsage,
            total_cost: capturedTotalCost ?? null,
          }
          : {},
        metadata: {
          provider,
          model,
          assistant_message_id: captureAssistantMessageId,
        },
      }));
    }
  });

  // ── 7. Return streaming response ──
  return new Response(transformStream.readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Prevent DigitalOcean/nginx buffering
    },
  });
}

// ============================================
// GET /chat/models — Available model list
// ============================================

export async function handleChatModels(request: Request): Promise<Response> {
  // Optional auth — rate limit by user ID or IP
  let userId: string;
  try {
    const user = await authenticate(request);
    userId = user.id;
  } catch {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "anonymous";
    userId = ip;
  }

  const rateResult = await checkRateLimit(userId, "chat:models");
  if (!rateResult.allowed) {
    return json({ error: "Rate limit exceeded" }, 429);
  }

  // Suggested models — not an allowlist, just popular options for the UI
  const suggested = [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "google/gemini-3.1-flash-lite-preview:nitro",
    "openai/gpt-4o",
    "google/gemini-2.5-pro-preview-05-06",
    "deepseek/deepseek-chat",
    "meta-llama/llama-3.1-405b-instruct",
    "qwen/qwen3-235b-a22b",
  ];
  const models = suggested.map((id) => {
    const [provider, name] = id.split("/");
    return { id, name, provider };
  });

  return json({ models });
}

// ============================================
// GET /chat/inference-options — User-specific inference options
// ============================================

export async function handleChatInferenceOptions(
  request: Request,
): Promise<Response> {
  let user: { id: string; email: string; provisional?: boolean };
  try {
    user = await authenticate(request);
  } catch (err) {
    return json({
      error: "Unauthorized",
      detail: err instanceof Error ? err.message : "Auth failed",
    }, 401);
  }

  if (user.provisional) {
    return json(
      { error: "A full account is required for inference options." },
      403,
    );
  }

  const rateResult = await checkRateLimit(user.id, "chat:models");
  if (!rateResult.allowed) {
    return json({ error: "Rate limit exceeded" }, 429);
  }

  try {
    return json(await buildInferenceOptions({ userId: user.id }));
  } catch (err) {
    chatLogger.error("Failed to build inference options", {
      user_id: user.id,
      error: err,
    });
    return json({
      error: "Inference options unavailable",
      detail: err instanceof Error
        ? err.message
        : "Failed to load inference options",
    }, 500);
  }
}

// ============================================
// GET /chat/function-index — Per-user function index for codemode
// ============================================

/**
 * Returns the user's function index: all available app functions
 * with TypeScript type declarations for codemode recipes.
 * Cached in R2, rebuilt on app upload/version change.
 */
export async function handleFunctionIndex(request: Request): Promise<Response> {
  const { authenticate } = await import("./auth.ts");
  const user = await authenticate(request);
  if (!user) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { getFunctionIndex, rebuildFunctionIndex } = await import(
    "../services/function-index.ts"
  );

  // Try to read cached index
  let index = await getFunctionIndex(user.id);

  // If no index exists, build it on demand
  if (!index) {
    try {
      index = await rebuildFunctionIndex(user.id);
    } catch (err) {
      chatLogger.error("Failed to build function index on demand", {
        user_id: user.id,
        error: err,
      });
      return json({
        functions: {},
        widgets: [],
        contextSources: [],
        routines: [],
        types: "",
        updatedAt: null,
      });
    }
  }

  return json(index);
}

// ============================================
// POST /chat/context — Resolve task context for a prompt
// ============================================

/**
 * Given a user prompt, resolves relevant entities, functions, and conventions
 * from pre-built indexes. Returns a TaskContext with a formatted promptBlock
 * for system prompt injection.
 */
export async function handleChatContext(request: Request): Promise<Response> {
  // Auth
  let user: { id: string; email: string; tier: string; provisional?: boolean };
  try {
    user = await authenticate(request);
  } catch (err) {
    return json({
      error: "Unauthorized",
      detail: err instanceof Error ? err.message : "Auth failed",
    }, 401);
  }

  // Parse body
  let body: { prompt: string };
  try {
    body = await request.json() as { prompt: string };
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body.prompt || typeof body.prompt !== "string") {
    return error("prompt is required", 400);
  }

  // Resolve context
  try {
    const { resolveContext } = await import("../services/context-resolver.ts");
    const context = await resolveContext(body.prompt, user.id, user.email);
    return json(context);
  } catch (err) {
    chatLogger.error("Chat context resolution failed", {
      user_id: user.id,
      error: err,
    });
    return json({
      entities: [],
      functions: [],
      conventions: [],
      promptBlock: "",
    });
  }
}

// ============================================
// POST /chat/tool-invocation — Client-side tool telemetry
// ============================================

/**
 * Records local desktop tool execution telemetry. Tool execution happens on
 * the client, so this endpoint receives the full args/result after the call.
 */
export async function handleToolInvocationTelemetry(
  request: Request,
): Promise<Response> {
  let user: { id: string; email: string; tier: string; provisional?: boolean };
  try {
    user = await authenticate(request);
  } catch (err) {
    return json({
      error: "Unauthorized",
      detail: err instanceof Error ? err.message : "Auth failed",
    }, 401);
  }

  if (user.provisional) {
    return json({ error: "Telemetry requires a full account." }, 403);
  }

  let body: ToolInvocationTelemetryRequest;
  try {
    body = await request.json() as ToolInvocationTelemetryRequest;
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body.invocationId || typeof body.invocationId !== "string") {
    return error("invocationId is required", 400);
  }
  if (!body.source || typeof body.source !== "string") {
    return error("source is required", 400);
  }
  if (!body.toolName || typeof body.toolName !== "string") {
    return error("toolName is required", 400);
  }
  if (!TOOL_TELEMETRY_STATUSES.has(body.status)) {
    return error("status must be success, error, aborted, or timeout", 400);
  }

  await recordToolInvocationTelemetry({
    userId: user.id,
    invocationId: body.invocationId,
    traceId: body.traceId,
    conversationId: body.conversationId,
    parentLlmInvocationId: body.parentLlmInvocationId,
    source: body.source,
    toolCallId: body.toolCallId,
    toolName: body.toolName,
    toolKind: body.toolKind,
    appId: body.appId,
    mcpId: body.mcpId,
    functionName: body.functionName,
    receiptId: body.receiptId,
    routineId: body.routineId,
    routineRunId: body.routineRunId,
    schemaSnapshot: body.schemaSnapshot,
    args: body.args,
    result: body.result,
    startedAt: body.startedAt,
    completedAt: body.completedAt,
    durationMs: body.durationMs,
    status: body.status,
    errorType: body.errorType,
    errorMessage: body.errorMessage,
    widgetAction: body.widgetAction,
    metadata: body.metadata,
  });

  return json({ success: true });
}

// ============================================
// POST /chat/capability-suggestion-event — Ambient suggestion telemetry
// ============================================

/**
 * Records client-side lifecycle events for ambient capability suggestions.
 * Accepting a suggestion also saves the suggested app to the user's library.
 */
export async function handleCapabilitySuggestionEventTelemetry(
  request: Request,
): Promise<Response> {
  let user: { id: string; email: string; tier: string; provisional?: boolean };
  try {
    user = await authenticate(request);
  } catch (err) {
    return json({
      error: "Unauthorized",
      detail: err instanceof Error ? err.message : "Auth failed",
    }, 401);
  }

  if (user.provisional) {
    return json({ error: "Telemetry requires a full account." }, 403);
  }

  let body: Awaited<ReturnType<typeof validateCapabilitySuggestionEventRequest>>;
  try {
    body = await validateCapabilitySuggestionEventRequest(request);
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    return error("Invalid request body", 400);
  }

  const result = await recordCapabilitySuggestionEvent({
    userId: user.id,
    eventType: body.eventType,
    intentId: body.intentId,
    suggestionSetId: body.suggestionSetId,
    suggestionId: body.suggestionId,
    conversationId: body.conversationId,
    traceId: body.traceId,
    messageId: body.messageId,
    appId: body.appId,
    appSlug: body.appSlug,
    eventSource: body.eventSource,
    installOnAccept: body.installOnAccept,
    metadata: body.metadata,
  });

  return json({
    success: true,
    event_id: result.eventId,
    library_installed: result.libraryInstalled,
  });
}

// ============================================
// POST /chat/provision-key — Pre-provision OpenRouter key
// ============================================

/**
 * Create per-user OpenRouter key ahead of first chat.
 * Called by the desktop app after login so the key is ready
 * when the user sends their first message (avoids 504 timeout).
 */
export async function handleProvisionKey(request: Request): Promise<Response> {
  // Auth
  let user: { id: string; email: string; tier: string; provisional?: boolean };
  try {
    user = await authenticate(request);
  } catch (err) {
    return json({
      error: "Unauthorized",
      detail: err instanceof Error ? err.message : "Auth failed",
    }, 401);
  }

  if (user.provisional) {
    return json({ error: "Full account required" }, 403);
  }

  // Get or create key
  try {
    await getOrCreateOpenRouterKey(user.id, user.email);
    chatLogger.info("Provisioned OpenRouter key", { user_id: user.id });
    return json({ ok: true, provisioned: true });
  } catch (err) {
    chatLogger.error("Key provisioning failed", {
      user_id: user.id,
      error: err,
    });
    return json({
      ok: false,
      error: err instanceof Error ? err.message : "Key provisioning failed",
    }, 500);
  }
}

// ============================================
// POST /chat/orchestrate — Server-side Flash orchestration
// ============================================

/**
 * Server-side orchestration endpoint.
 * Replaces the client-side agent loop with Flash broker + heavy model + recipe execution.
 * Returns an SSE stream of typed orchestration events.
 */
export async function handleOrchestrate(request: Request): Promise<Response> {
  // ── 1. Auth ──
  let user: { id: string; email: string; tier: string; provisional?: boolean };
  try {
    user = await authenticate(request);
  } catch (err) {
    return json({
      error: "Unauthorized",
      detail: err instanceof Error ? err.message : "Auth failed",
    }, 401);
  }

  if (user.provisional) {
    return json({ error: "Orchestration requires a full account." }, 403);
  }

  // ── 2. Parse request body ──
  let body: {
    message: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    preferredModel?: string;
    interpreterModel?: string;
    heavyModel?: string;
    inference?: InferenceRoutePreference;
    scope?: Record<
      string,
      { access: "all" | "functions" | "data"; functions?: string[] }
    >;
    systemAgentContext?: SystemAgentContext;
    projectContext?: string;
    activeWidgetContexts?: ActiveWidgetContext[];
    conversationId?: string;
    userMessageId?: string;
    assistantMessageId?: string;
    files?: Array<
      { name: string; size: number; mimeType: string; content: string }
    >;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!body.message || typeof body.message !== "string") {
    return error("message is required", 400);
  }
  const activeWidgetContexts = Array.isArray(body.activeWidgetContexts)
    ? body.activeWidgetContexts
    : undefined;
  if (body.inference?.model && !isValidModelId(body.inference.model)) {
    return json({
      error:
        `Invalid model ID format: ${body.inference.model}. Expected a provider-native model ID`,
    }, 400);
  }

  // ── 3. Resolve inference route ──
  let route: Awaited<ReturnType<typeof resolveInferenceRoute>>;
  try {
    route = await resolveInferenceRoute({
      userId: user.id,
      userEmail: user.email,
      selection: body.inference,
    });
    chatLogger.info("Resolved orchestration inference route", {
      user_id: user.id,
      provider: route.provider,
      upstream_provider: route.upstreamProvider,
      billing_mode: route.billingMode,
      key_source: route.keySource,
      model: route.model,
      canonical_model_id: route.canonicalModelId,
      require_balance: route.shouldRequireBalance,
      debit_light: route.shouldDebitLight,
    });
  } catch (err) {
    chatLogger.error("Failed to resolve orchestration inference route", {
      user_id: user.id,
      error: err,
    });

    if (err instanceof InferenceRouteError) {
      return json({
        error: "Orchestration service unavailable",
        code: err.code,
        detail: err.message,
      }, err.status);
    }

    return json({
      error: "Orchestration service unavailable",
      detail: err instanceof Error
        ? err.message
        : "Inference route resolution failed",
    }, 503);
  }

  // ── 4. Rate limit + conditional balance gate ──
  const guardResult = await enforceChatGuards(user.id, "chat orchestration", {
    requireBalance: route.shouldRequireBalance,
  });
  if (guardResult instanceof Response) {
    return guardResult;
  }

  // ── 5. Stream orchestration events as SSE ──
  const { orchestrate } = await import("../services/orchestrator.ts");
  const captureConversationId = body.conversationId || crypto.randomUUID();
  const captureTraceId = crypto.randomUUID();
  const captureUserMessageId = body.userMessageId || crypto.randomUUID();
  const captureAssistantMessageId = body.assistantMessageId || crypto.randomUUID();
  const captureSession = createOrchestrateCaptureSession({
    userId: user.id,
    userEmail: user.email,
    conversationId: captureConversationId,
    userMessageId: captureUserMessageId,
    assistantMessageId: captureAssistantMessageId,
    traceId: captureTraceId,
    message: body.message,
    conversationHistory: body.conversationHistory,
    interpreterModel: body.interpreterModel,
    heavyModel: body.heavyModel || body.preferredModel,
    inference: body.inference,
    scope: body.scope,
    systemAgentContext: body.systemAgentContext,
    projectContext: body.projectContext,
    activeWidgetContexts,
    files: body.files,
  });
  captureSession?.start();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (
          const event of orchestrate(
            {
              message: body.message,
              conversationHistory: body.conversationHistory,
              interpreterModel: body.interpreterModel,
              heavyModel: body.heavyModel || body.preferredModel,
              scope: body.scope,
              systemAgentContext: body.systemAgentContext,
              projectContext: body.projectContext,
              activeWidgetContexts,
              conversationId: captureConversationId,
              userMessageId: captureUserMessageId,
              files: body.files,
            },
            user.id,
            user.email,
            {
              inferenceRoute: route,
              telemetry: {
                traceId: captureTraceId,
                conversationId: captureConversationId,
                source: "orchestrate",
              },
            },
          )
        ) {
          captureSession?.observeEvent(event);
          const sseData = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(sseData));

          // Close stream on done or error
          if (event.type === "done") {
            if (captureSession) {
              scheduleCaptureTask(captureSession.finish("done"));
            }
            controller.close();
            return;
          }
        }
        // Safety close if generator ends without 'done'
        const doneEvent = { type: "done" as const };
        captureSession?.observeEvent(doneEvent);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(doneEvent)}\n\n`),
        );
        if (captureSession) {
          scheduleCaptureTask(captureSession.finish("generator_end"));
        }
        controller.close();
      } catch (err) {
        const errEvent = {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        captureSession?.observeEvent(errEvent);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(errEvent)}\n\n`),
        );
        const doneEvent = { type: "done" as const };
        captureSession?.observeEvent(doneEvent);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(doneEvent)}\n\n`),
        );
        if (captureSession) {
          scheduleCaptureTask(captureSession.finish("handler_error"));
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

// ============================================
// POST /chat/plan/:id/confirm — resume pending execution
// ============================================

export async function handlePlanConfirm(
  request: Request,
  planId: string,
): Promise<Response> {
  let user: { id: string; email: string; tier: string; provisional?: boolean };
  try {
    user = await authenticate(request);
  } catch (err) {
    return json({
      error: "Unauthorized",
      detail: err instanceof Error ? err.message : "Auth failed",
    }, 401);
  }

  const { confirmExecutionPlanGate } = await import("../services/plan-gate.ts");
  const result = await confirmExecutionPlanGate(planId, user.id);
  if (!result.ok) {
    return json({ error: result.message }, result.status);
  }

  return json({ ok: true, status: result.message, planId });
}

// ============================================
// POST /chat/plan/:id/cancel — cancel pending execution
// ============================================

export async function handlePlanCancel(
  request: Request,
  planId: string,
): Promise<Response> {
  let user: { id: string; email: string; tier: string; provisional?: boolean };
  try {
    user = await authenticate(request);
  } catch (err) {
    return json({
      error: "Unauthorized",
      detail: err instanceof Error ? err.message : "Auth failed",
    }, 401);
  }

  const { cancelExecutionPlanGate } = await import("../services/plan-gate.ts");
  const result = await cancelExecutionPlanGate(planId, user.id);
  if (!result.ok) {
    return json({ error: result.message }, result.status);
  }

  return json({ ok: true, status: result.message, planId });
}
