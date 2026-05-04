// Orchestrator — server-side Flash orchestration engine.
//
// The full pipeline:
//   1. Flash broker analyzes the message (yields live events)
//   2. Flash requests prefetch queries (read-only data gathering)
//   3. Server executes prefetch in Dynamic Worker
//   4. Flash sees results, constructs final prompt + selects model
//   5. Heavy model writes ONE recipe (streamed to client)
//   6. Recipe executes in Dynamic Worker
//   7. Result streams back
//
// The client sees every step live: Flash searching, finding entities,
// loading conventions, choosing a model, then the heavy model writing.

import { getEnv } from '../lib/env.ts';
import { runFlashBroker, type FlashBrokerResult, type SystemAgentState, type SystemAgentContext } from './flash-broker.ts';
import { executeDynamicCodeMode } from '../runtime/dynamic-executor.ts';
import { getD1DatabaseId } from './d1-provisioning.ts';
import { createAppsService } from './apps.ts';
import { registerExecutionPlanGate } from './plan-gate.ts';
import { fetchInferenceChatCompletion, selectInferenceModel } from './inference-client.ts';
import { resolveInferenceRoute, type ResolvedInferenceRoute } from './inference-route.ts';
import type { ChatUsage } from '../../shared/contracts/ai.ts';
import { getCallPriceLight, type AppPricingConfig } from '../../shared/types/index.ts';
import { calculateCostLight } from './chat-billing.ts';
import { scheduleCaptureTask } from './chat-capture.ts';
import {
  createLlmInvocationTelemetrySession,
  recordToolInvocationTelemetry,
} from './invocation-telemetry.ts';

// ── Types ──

export type OrchestrateEvent =
  // Flash phase events (visible to user as "Flash thinking")
  | { type: 'flash_status'; text: string }
  | {
    type: 'ambient_suggestions';
    suggestions: Array<{
      id: string;
      slug: string;
      name: string;
      description: string;
      icon_url: string | null;
      similarity: number;
      source: 'marketplace';
      type: 'app';
      connected: false;
      runtime?: string;
      trust_card?: unknown;
    }>;
  }
  | { type: 'flash_search'; query: string; apps: string[] }
  | { type: 'flash_found'; entity: string; detail: string }
  | { type: 'flash_context'; functions: string[]; conventions: number }
  | { type: 'flash_prompt'; prompt: string; model: string }
  | { type: 'flash_direct'; content: string }
  // Heavy model phase events
  | { type: 'heavy_status'; text: string; model: string }
  | { type: 'heavy_text'; content: string }
  | { type: 'heavy_recipe'; code: string }
  // Execution phase events
  | {
    type: 'plan_ready';
    plan: {
      id: string;
      recipe: string;
      tools_used: Array<{
        appId: string;
        appName: string;
        appSlug: string;
        origin: 'library' | 'marketplace';
        fnName: string;
        args: Record<string, unknown>;
        cost_light: number;
      }>;
      total_cost_light: number;
      created_at: number;
    };
  }
  | { type: 'plan_cancelled'; planId: string; reason?: string }
  | { type: 'exec_start' }
  | { type: 'exec_result'; data: unknown }
  // System agent delegation
  | { type: 'system_agent_spawn'; agentType: string; task: string; originalPrompt: string }
  // Meta events
  | { type: 'usage'; flash: object; heavy: object }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** File attachment sent from the desktop client */
export interface ChatFileAttachment {
  name: string;
  size: number;
  mimeType: string;
  content: string; // base64 data URL
}

export interface OrchestrateRequest {
  message: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  interpreterModel?: string;  // Flash broker model
  heavyModel?: string;        // Recipe writer model
  scope?: Record<string, { access: 'all' | 'functions' | 'data'; functions?: string[] }>;
  systemAgentStates?: SystemAgentState[];
  systemAgentContext?: SystemAgentContext;
  /** Local project file context gathered client-side (directory tree, config files, relevant source) */
  projectContext?: string;
  /** Conversation ID for rolling summary persistence */
  conversationId?: string;
  /** Attached files from the chat input */
  files?: ChatFileAttachment[];
}

export interface OrchestrateOptions {
  inferenceRoute?: ResolvedInferenceRoute;
  telemetry?: {
    traceId: string;
    conversationId?: string;
    source?: string;
  };
}

// ── Main Orchestration Loop ──

/**
 * Server-side orchestration: analyze, plan, execute, respond.
 * Yields SSE events as an async generator — every step visible to the user.
 */
export async function* orchestrate(
  request: OrchestrateRequest,
  userId: string,
  userEmail: string,
  options: OrchestrateOptions = {},
): AsyncGenerator<OrchestrateEvent> {
  const { message, conversationHistory, interpreterModel, heavyModel, scope, systemAgentStates, systemAgentContext, projectContext, conversationId, files } = request;

  let inferenceRoute: ResolvedInferenceRoute;
  try {
    inferenceRoute = options.inferenceRoute ?? await resolveInferenceRoute({ userId, userEmail });
  } catch (err) {
    yield { type: 'error', message: `Inference route unavailable: ${err instanceof Error ? err.message : String(err)}` };
    yield { type: 'done' };
    return;
  }

  // ── Phase 1: Flash Broker (yields live events) ──

  let brokerResult: FlashBrokerResult;
  try {
    const flashGen = runFlashBroker(
      message,
      userId,
      userEmail,
      conversationHistory,
      interpreterModel,
      heavyModel,
      scope,
      systemAgentStates,
      systemAgentContext,
      projectContext,
      conversationId,
      files,
      inferenceRoute,
    );

    // Forward Flash events to client as they happen
    for await (const event of flashGen) {
      switch (event.type) {
        case 'analyzing':
          yield { type: 'flash_status', text: event.text || 'Analyzing your request...' };
          break;
        case 'ambient_suggestions':
          yield { type: 'ambient_suggestions', suggestions: event.suggestions || [] };
          break;
        case 'searching':
          yield { type: 'flash_search', query: event.query || '', apps: event.apps || [] };
          break;
        case 'magnifying':
          yield { type: 'flash_status', text: event.text || 'Loading app data...' };
          break;
        case 'magnified':
          yield { type: 'flash_found', entity: event.app || '', detail: `${event.tables} tables, ${event.rows} rows` };
          break;
        case 'prefetch_start':
          yield { type: 'flash_status', text: event.text || 'Gathering data...' };
          break;
        case 'prefetch_result':
          if (event.entities && event.entities.length > 0) {
            for (const e of event.entities) {
              yield { type: 'flash_found', entity: e.name, detail: e.context || e.type };
            }
          }
          break;
        case 'constructing':
          yield {
            type: 'flash_context',
            functions: event.functions || [],
            conventions: event.conventionCount || 0,
          };
          break;
        case 'prompt_ready':
          yield {
            type: 'flash_prompt',
            prompt: event.prompt || '',
            model: event.model || '',
          };
          break;
        case 'direct_response':
          yield { type: 'flash_direct', content: event.content || '' };
          break;
        case 'done':
          brokerResult = event.result!;
          break;
        case 'error':
          yield { type: 'error', message: event.message || 'Flash broker failed' };
          yield { type: 'done' };
          return;
      }
    }

    // Safety check — if we never got a 'done' event
    if (!brokerResult!) {
      yield { type: 'error', message: 'Flash broker completed without result' };
      yield { type: 'done' };
      return;
    }
  } catch (err) {
    yield { type: 'error', message: `Flash broker failed: ${err instanceof Error ? err.message : String(err)}` };
    yield { type: 'done' };
    return;
  }

  // ── System Agent Delegations (if Flash recommended any) ──
  if (brokerResult.systemAgentDelegations?.length) {
    for (const d of brokerResult.systemAgentDelegations) {
      // Tool Dealer discovery: render inline discover widget instead of spawning agent chat
      if (d.agentType === 'tool_marketer' && d.task) {
        // Extract search intent from the task description
        const searchQuery = d.task
          .replace(/^User needs?\s*/i, '')
          .replace(/\.\s*Search marketplace.*$/i, '')
          .replace(/\.\s*Help them.*$/i, '')
          .trim();
        yield {
          type: 'flash_direct' as const,
          content: `I'll help you find the right tools.\n\n{{discover:${searchQuery || d.originalPrompt}}}`,
        };
        yield { type: 'done' };
        return; // Don't continue to heavy model — discovery widget handles the UX
      }

      yield { type: 'system_agent_spawn' as const, agentType: d.agentType, task: d.task, originalPrompt: d.originalPrompt };
    }
  }

  // ── Cross-Session Conversation Retrieval (if Flash requested it) ──
  if (brokerResult.conversationSearch) {
    try {
      yield { type: 'flash_status', text: 'Searching past conversations...' };
      const conversationContext = await retrieveConversationHistory(brokerResult.conversationSearch, userId);
      if (conversationContext) {
        // For write mode, inject into the prompt; for read mode, already handled in flash-broker
        if (brokerResult.needsTool) {
          brokerResult.prompt = conversationContext + '\n\n' + brokerResult.prompt;
        }
      }
    } catch (err) {
      console.warn('[orchestrate] Conversation retrieval failed:', err);
    }
  }

  // ── Phase 2: Direct response (Flash handled it, no heavy model needed) ──
  // Note: flash_direct was already yielded by the Flash broker event forwarding above.
  // We just need to emit usage and done.
  if (!brokerResult.needsTool) {
    if (brokerResult.usage) {
      yield { type: 'usage', flash: brokerResult.usage, heavy: {} };
    }
    yield { type: 'done' };
    return;
  }

  // ── Phase 2.4: Local Project Context ──
  // Client-gathered project files (directory tree, config, relevant source) — injected into heavy model prompt
  if (projectContext) {
    brokerResult.prompt = `## Local Project Context\n${projectContext}\n\n` + brokerResult.prompt;
  }

  // ── Phase 2.5: System Agent Magnification ──
  // For system agents, pull agent-type-specific data (source code, marketplace data, etc.)
  if (systemAgentContext) {
    try {
      const extraContext = await magnifyForSystemAgent(systemAgentContext.type, brokerResult, userId);
      if (extraContext) {
        brokerResult.prompt = extraContext + '\n\n' + brokerResult.prompt;
      }
    } catch (err) {
      console.warn('[orchestrate] System agent magnification failed:', err);
    }
  }

  // ── Phase 3: Heavy Model ──
  const modelId = selectInferenceModel(inferenceRoute, brokerResult.model);
  yield { type: 'heavy_status', text: `Writing with ${modelDisplayName(modelId)}...`, model: modelId };

  const codemodeToolDef = buildCodemodeToolDef(brokerResult, files);

  // Heavy model gets Flash's prompt as the ONLY user message — NO system prompt
  // Include image files as multimodal content so Heavy can see them
  let heavyContent: unknown = brokerResult.prompt;
  if (files?.length) {
    const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
    const imageFiles = files.filter(f => IMAGE_MIMES.has(f.mimeType));
    if (imageFiles.length > 0) {
      const parts: unknown[] = [{ type: 'text', text: brokerResult.prompt }];
      for (const f of imageFiles) {
        const url = f.content.startsWith('data:') ? f.content : `data:${f.mimeType};base64,${f.content}`;
        parts.push({ type: 'image_url', image_url: { url } });
      }
      heavyContent = parts;
    }
  }
  const heavyMessages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: heavyContent },
  ];

  let heavyUsage: object = {};

  try {
    // ── Call 1: Heavy model writes recipe (or responds directly) ──
    const call1Result = await callHeavyModel(inferenceRoute, modelId, heavyMessages, [codemodeToolDef], {
      userId,
      userEmail,
      traceId: options.telemetry?.traceId || crypto.randomUUID(),
      conversationId,
      source: options.telemetry?.source || 'orchestrate',
      requestedModel: brokerResult.model,
      phase: 'orchestrate_heavy',
    });

    // Stream text deltas from call 1
    for (const delta of call1Result.textDeltas) {
      yield { type: 'heavy_text', content: delta };
    }

    heavyUsage = call1Result.usage || {};

    // ── Phase 4: Execute recipe + synthesis ──
    if (call1Result.toolCall) {
      const recipeCode = call1Result.toolCall.code;
      const planId = crypto.randomUUID();
      const createdAt = Date.now();
      const plan = await buildExecutionPlan(planId, recipeCode, brokerResult, userId, createdAt);
      const decisionPromise = registerExecutionPlanGate(planId, userId);

      yield { type: 'plan_ready', plan };

      const decision = await decisionPromise;
      if (decision.status !== 'confirmed') {
        yield {
          type: 'plan_cancelled',
          planId,
          reason: decision.status === 'timeout' ? 'timed_out' : 'cancelled',
        };
        yield { type: 'done' };
        return;
      }

      yield { type: 'exec_start' };

      let execResultData: unknown = null;
      let execError: string | undefined;
      const execStartedAt = new Date().toISOString();
      const execStartMs = Date.now();
      const execInvocationId = `${options.telemetry?.traceId || crypto.randomUUID()}:exec:${planId}`;

      try {
        const execResult = await executeRecipe(recipeCode, brokerResult, userId, userEmail, files);
        if (execResult.error) {
          execError = execResult.error;
        } else {
          execResultData = execResult.result;
        }

        scheduleCaptureTask(recordToolInvocationTelemetry({
          userId,
          invocationId: execInvocationId,
          traceId: options.telemetry?.traceId,
          conversationId,
          parentLlmInvocationId: call1Result.invocationId,
          source: options.telemetry?.source || 'orchestrate',
          toolCallId: call1Result.toolCall?.id,
          toolName: 'ul_codemode',
          toolKind: 'server_recipe',
          functionName: 'ul_codemode',
          schemaSnapshot: codemodeToolDef,
          args: {
            plan_id: planId,
            recipe: recipeCode,
            tools_used: plan.tools_used,
            attached_files: files?.map((file) => ({
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
            })) || [],
          },
          result: execResult,
          startedAt: execStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - execStartMs,
          status: execResult.error ? 'error' : 'success',
          errorType: execResult.error ? 'recipe_execution_error' : undefined,
          errorMessage: execResult.error,
          metadata: {
            plan_id: planId,
            total_cost_light: plan.total_cost_light,
          },
        }));
      } catch (err) {
        execError = err instanceof Error ? err.message : String(err);
        scheduleCaptureTask(recordToolInvocationTelemetry({
          userId,
          invocationId: execInvocationId,
          traceId: options.telemetry?.traceId,
          conversationId,
          parentLlmInvocationId: call1Result.invocationId,
          source: options.telemetry?.source || 'orchestrate',
          toolCallId: call1Result.toolCall?.id,
          toolName: 'ul_codemode',
          toolKind: 'server_recipe',
          functionName: 'ul_codemode',
          schemaSnapshot: codemodeToolDef,
          args: {
            plan_id: planId,
            recipe: recipeCode,
            tools_used: plan.tools_used,
          },
          result: {
            error: execError,
          },
          startedAt: execStartedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - execStartMs,
          status: 'error',
          errorType: err instanceof Error ? err.constructor.name : 'Error',
          errorMessage: execError,
          metadata: {
            plan_id: planId,
            total_cost_light: plan.total_cost_light,
          },
        }));
      }

      if (execError) {
        yield { type: 'error', message: `Recipe error: ${execError}` };
      } else {
        yield { type: 'exec_result', data: execResultData };

        // ── Flash writes the confirmation ──
        // Instead of calling Heavy again, Flash summarizes what happened.
        const resultStr = typeof execResultData === 'string'
          ? execResultData
          : JSON.stringify(execResultData, null, 2);
        const truncatedResult = resultStr.length > 4000
          ? resultStr.slice(0, 4000) + '\n...(truncated)'
          : resultStr;

        const { callFlashText } = await import('./flash-broker.ts');
        const confirmInput = `## User's Request\n${request.message}\n\n## Execution Result\n${truncatedResult}`;
        const CONFIRM_SYSTEM = 'You are confirming the result of an action. Write a brief, clear confirmation (1-3 sentences) of what was done. Include specific details from the result. Use markdown formatting.';

        const interpreterModel = selectInferenceModel(
          inferenceRoute,
          request.interpreterModel || 'google/gemini-3.1-flash-lite-preview:nitro',
        );
        const confirmation = await callFlashText(
          interpreterModel,
          CONFIRM_SYSTEM,
          confirmInput,
          inferenceRoute,
        );

        if (confirmation) {
          yield { type: 'heavy_text', content: confirmation };
        }
      }
    }
  } catch (err) {
    yield { type: 'error', message: `Orchestration error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── Phase 5: Usage ──
  if (brokerResult.usage || Object.keys(heavyUsage).length > 0) {
    yield { type: 'usage', flash: brokerResult.usage || {}, heavy: heavyUsage };
  }

  yield { type: 'done' };
}

// ── Heavy Model SSE Stream Parser ──

interface StreamResult {
  invocationId?: string;
  textDeltas: string[];
  fullText: string;
  toolCall: { name: string; code: string; id: string } | null;
  usage: object | null;
  finishReason: string | null;
}

interface PlannedToolUse {
  appId: string;
  appName: string;
  appSlug: string;
  origin: 'library' | 'marketplace';
  fnName: string;
  args: Record<string, unknown>;
  cost_light: number;
}

interface DynamicWorkerExports {
  DatabaseBinding(input: { props: Record<string, unknown> }): unknown;
  AppDataBinding(input: { props: Record<string, unknown> }): unknown;
}

/**
 * Call the heavy model and parse its streaming response.
 */
async function callHeavyModel(
  route: ResolvedInferenceRoute,
  modelId: string,
  messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>,
  tools: object[],
  telemetry?: {
    userId: string;
    userEmail: string;
    traceId: string;
    conversationId?: string;
    source: string;
    requestedModel?: string;
    phase: string;
  },
): Promise<StreamResult> {
  const requestBody = {
    model: modelId,
    messages,
    tools,
    temperature: 0.3,
    max_tokens: 4096,
    stream: true,
    stream_options: { include_usage: true },
  };
  const telemetryInvocationId = telemetry
    ? `${telemetry.traceId}:${telemetry.phase}:${crypto.randomUUID()}`
    : undefined;
  const llmTelemetry = telemetry && telemetryInvocationId
    ? createLlmInvocationTelemetrySession({
      userId: telemetry.userId,
      userEmail: telemetry.userEmail,
      invocationId: telemetryInvocationId,
      traceId: telemetry.traceId,
      conversationId: telemetry.conversationId,
      source: telemetry.source,
      phase: telemetry.phase,
      provider: route.provider,
      requestedModel: telemetry.requestedModel || modelId,
      resolvedModel: modelId,
      billingMode: route.billingMode,
      keySource: route.keySource,
      requestParams: {
        temperature: requestBody.temperature,
        max_tokens: requestBody.max_tokens,
        stream: true,
        stream_options: requestBody.stream_options,
      },
      messages,
      tools,
      metadata: {
        orchestrator_call: 'heavy_model',
      },
    })
    : null;
  llmTelemetry?.start();

  const response = await fetchInferenceChatCompletion(
    route,
    requestBody,
    {
      title: 'Ultralight Chat',
      referer: 'https://ultralight.dev',
    },
  );

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    if (llmTelemetry) {
      scheduleCaptureTask(llmTelemetry.finish({
        status: 'error',
        errorType: 'provider_response',
        errorMessage: `Heavy model error (${response.status}): ${errText}`,
        metadata: {
          provider: route.provider,
          model: modelId,
          status: response.status,
        },
      }));
    }
    throw new Error(`Heavy model error (${response.status}): ${errText}`);
  }

  if (!response.body) {
    if (llmTelemetry) {
      scheduleCaptureTask(llmTelemetry.finish({
        status: 'error',
        errorType: 'provider_empty_body',
        errorMessage: 'No response body from heavy model',
        metadata: {
          provider: route.provider,
          model: modelId,
        },
      }));
    }
    throw new Error('No response body from heavy model');
  }

  try {
    const result = await streamHeavyModel(response.body);
    if (llmTelemetry) {
      const chatUsage = usageAsChatUsage(result.usage);
      scheduleCaptureTask(llmTelemetry.finish({
        status: 'success',
        finishReason: result.finishReason,
        usage: result.usage || {},
        costLight: chatUsage
          ? calculateCostLight(chatUsage, modelId, usageTotalCost(result.usage), {
            billingSource: route.billingSource,
          })
          : null,
        metadata: {
          provider: route.provider,
          model: modelId,
          tool_call_id: result.toolCall?.id || null,
          tool_call_name: result.toolCall?.name || null,
        },
      }));
    }
    return { ...result, invocationId: telemetryInvocationId };
  } catch (err) {
    if (llmTelemetry) {
      scheduleCaptureTask(llmTelemetry.finish({
        status: 'error',
        errorType: err instanceof Error ? err.constructor.name : 'stream_parse_error',
        errorMessage: err instanceof Error ? err.message : String(err),
        metadata: {
          provider: route.provider,
          model: modelId,
        },
      }));
    }
    throw err;
  }
}

/**
 * Parse the heavy model's SSE stream.
 * Handles multiple parallel tool calls by merging them into a single recipe.
 */
async function streamHeavyModel(
  body: ReadableStream<Uint8Array>,
  _onDelta?: (delta: string) => void,
): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  const textDeltas: string[] = [];
  let fullText = '';
  // Track per-index tool calls (handles parallel tool_calls)
  const toolCalls = new Map<number, { name: string; args: string; id: string }>();
  let usage: object | null = null;
  let finishReason: string | null = null;
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        if (!data) continue;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: object;
          };

          const delta = parsed.choices?.[0]?.delta;
          if (parsed.choices?.[0]?.finish_reason) {
            finishReason = parsed.choices[0].finish_reason;
          }

          if (delta?.content) {
            textDeltas.push(delta.content);
            fullText += delta.content;
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, { name: '', args: '', id: '' });
              }
              const entry = toolCalls.get(idx)!;
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }

          if (parsed.usage) usage = parsed.usage;
        } catch {
          // Skip malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Merge all tool calls into a single recipe
  let toolCall: StreamResult['toolCall'] = null;
  if (toolCalls.size > 0) {
    const codeSnippets: string[] = [];

    for (const [, entry] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!entry.args) continue;
      try {
        const args = JSON.parse(entry.args) as { code?: string; recipe?: string };
        const code = args.code || args.recipe || '';
        if (code) codeSnippets.push(code);
      } catch {
        // If individual parse fails, try using raw
        if (entry.args.length > 10) codeSnippets.push(entry.args);
      }
    }

    // Get the tool call ID from the first entry
    const firstEntry = [...toolCalls.values()][0];
    const callId = firstEntry?.id || `call_${Date.now()}`;

    if (codeSnippets.length === 1) {
      toolCall = { name: 'ul_codemode', code: codeSnippets[0], id: callId };
    } else if (codeSnippets.length > 1) {
      const merged = `// Merged ${codeSnippets.length} parallel tool calls\nconst results = await Promise.all([\n${codeSnippets.map((c) => `  (async () => { ${c.replace(/^return\s+/, 'return ')} })().catch(e => ({ _error: e.message }))`).join(',\n')}\n]);\nreturn results;`;
      toolCall = { name: 'ul_codemode', code: merged, id: callId };
      console.log(`[ORCHESTRATOR] Merged ${codeSnippets.length} parallel tool calls into single recipe`);
    }
  }

  return { textDeltas, fullText, toolCall, usage, finishReason };
}

function usageAsChatUsage(usage: object | null): ChatUsage | null {
  const candidate = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
  } | null;
  if (!candidate) return null;
  const promptTokens = typeof candidate.prompt_tokens === 'number' ? candidate.prompt_tokens : 0;
  const completionTokens = typeof candidate.completion_tokens === 'number' ? candidate.completion_tokens : 0;
  const totalTokens = typeof candidate.total_tokens === 'number' ? candidate.total_tokens : promptTokens + completionTokens;
  if (totalTokens <= 0) return null;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(typeof candidate.prompt_cache_hit_tokens === 'number'
      ? { prompt_cache_hit_tokens: candidate.prompt_cache_hit_tokens }
      : {}),
    ...(typeof candidate.prompt_cache_miss_tokens === 'number'
      ? { prompt_cache_miss_tokens: candidate.prompt_cache_miss_tokens }
      : {}),
  };
}

function usageTotalCost(usage: object | null): number | undefined {
  const candidate = usage as { total_cost?: unknown } | null;
  return typeof candidate?.total_cost === 'number' ? candidate.total_cost : undefined;
}

async function buildExecutionPlan(
  planId: string,
  recipeCode: string,
  brokerResult: FlashBrokerResult,
  userId: string,
  createdAt: number,
): Promise<{
  id: string;
  recipe: string;
  tools_used: PlannedToolUse[];
  total_cost_light: number;
  created_at: number;
}> {
  const calls = extractCodemodeCalls(recipeCode);
  const uniqueAppIds = [...new Set(
    calls
      .map(call => brokerResult.toolMap[call.toolName]?.appId)
      .filter((appId): appId is string => !!appId)
  )];

  const appMap = await loadExecutionPlanApps(uniqueAppIds);
  const toolsUsed: PlannedToolUse[] = [];
  for (const call of calls) {
    const mapping = brokerResult.toolMap[call.toolName];
    if (!mapping) continue;

    const app = appMap.get(mapping.appId);
    const appName = app?.name || mapping.appName || titleizeSlug(mapping.appSlug);
    const appSlug = app?.slug || mapping.appSlug;
    const costLight = app && app.owner_id !== userId
      ? getCallPriceLight(app.pricing_config as AppPricingConfig | null | undefined, mapping.fnName)
      : 0;

    toolsUsed.push({
      appId: mapping.appId,
      appName,
      appSlug,
      origin: mapping.origin,
      fnName: mapping.fnName,
      args: parseToolArgsSource(call.argsSource),
      cost_light: costLight,
    });
  }

  return {
    id: planId,
    recipe: recipeCode,
    tools_used: toolsUsed,
    total_cost_light: toolsUsed.reduce((sum, tool) => sum + tool.cost_light, 0),
    created_at: createdAt,
  };
}

async function loadExecutionPlanApps(appIds: string[]): Promise<Map<string, {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  pricing_config: unknown;
}>> {
  if (appIds.length === 0) {
    return new Map();
  }

  let appsService: ReturnType<typeof createAppsService>;
  try {
    appsService = createAppsService();
  } catch {
    return new Map();
  }
  const entries = await Promise.all(
    appIds.map(async (appId) => [appId, await appsService.findById(appId)] as const)
  );

  const appMap = new Map<string, {
    id: string;
    name: string;
    slug: string;
    owner_id: string;
    pricing_config: unknown;
  }>();

  for (const [appId, app] of entries) {
    if (!app) continue;
    appMap.set(appId, {
      id: app.id,
      name: app.name,
      slug: app.slug,
      owner_id: app.owner_id,
      pricing_config: app.pricing_config,
    });
  }

  return appMap;
}

function extractCodemodeCalls(code: string): Array<{ toolName: string; argsSource: string }> {
  const calls: Array<{ toolName: string; argsSource: string }> = [];
  let searchFrom = 0;

  while (searchFrom < code.length) {
    const marker = code.indexOf('codemode.', searchFrom);
    if (marker === -1) break;

    const nameStart = marker + 'codemode.'.length;
    let nameEnd = nameStart;
    while (/[A-Za-z0-9_]/.test(code[nameEnd] || '')) {
      nameEnd += 1;
    }

    const toolName = code.slice(nameStart, nameEnd);
    let cursor = nameEnd;
    while (/\s/.test(code[cursor] || '')) cursor += 1;

    if (!toolName || code[cursor] !== '(') {
      searchFrom = nameEnd;
      continue;
    }

    const callBounds = sliceBalancedParens(code, cursor);
    if (!callBounds) {
      searchFrom = cursor + 1;
      continue;
    }

    calls.push({ toolName, argsSource: callBounds.inner.trim() });
    searchFrom = callBounds.endIndex;
  }

  return calls;
}

function sliceBalancedParens(
  source: string,
  openParenIndex: number,
): { inner: string; endIndex: number } | null {
  let depth = 0;
  let quote: '"' | '\'' | '`' | null = null;
  let escaped = false;

  for (let i = openParenIndex; i < source.length; i += 1) {
    const char = source[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }

    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          inner: source.slice(openParenIndex + 1, i),
          endIndex: i + 1,
        };
      }
    }
  }

  return null;
}

function parseToolArgsSource(argsSource: string): Record<string, unknown> {
  if (!argsSource.trim()) return {};

  try {
    return JSON.parse(argsSource) as Record<string, unknown>;
  } catch {
    // Fall through to loose object-literal normalization.
  }

  const normalized = argsSource
    .trim()
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"');

  try {
    return JSON.parse(normalized) as Record<string, unknown>;
  } catch {
    return { _source: argsSource.trim() };
  }
}

function titleizeSlug(slug: string): string {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// ── Recipe Execution ──

async function executeRecipe(
  code: string,
  brokerResult: FlashBrokerResult,
  userId: string,
  userEmail: string,
  files?: ChatFileAttachment[],
): Promise<{ result: unknown; error?: string; logs: string[] }> {
  const appIds = brokerResult.involvedAppIds;

  const toolMap: Record<string, { appId: string; fnName: string }> = {};
  for (const [name, mapping] of Object.entries(brokerResult.toolMap)) {
    toolMap[name] = { appId: mapping.appId, fnName: mapping.fnName };
  }

  // Load ESM bundles from KV (parallel)
  const bundleEntries = await Promise.all(
    appIds.map(async (appId) => {
      const bundle = await globalThis.__env.CODE_CACHE.get(`esm:${appId}:latest`);
      return [appId, bundle] as const;
    }),
  );
  const appBundles: Record<string, string> = {};
  for (const [appId, bundle] of bundleEntries) {
    if (bundle) appBundles[appId] = bundle as string;
  }

  // Create RPC bindings (parallel)
  const bindings: Record<string, unknown> = {};
  const dbIdEntries = await Promise.all(
    appIds.map(async (appId) => {
      const dbId = await getD1DatabaseId(appId);
      return [appId, dbId] as const;
    }),
  );

  const dynamicExports = getDynamicWorkerExports();
  for (const [appId, dbId] of dbIdEntries) {
    const safeId = appId.replace(/-/g, '_');
    if (dbId) {
      bindings[`DB_${safeId}`] = dynamicExports.DatabaseBinding({
        props: { databaseId: dbId, appId, userId },
      });
    }
    bindings[`DATA_${safeId}`] = dynamicExports.AppDataBinding({
      props: { appId, userId },
    });
  }

  console.log(`[ORCHESTRATOR] Executing recipe: ${appIds.length} apps, ${Object.keys(appBundles).length} bundles`);

  return await executeDynamicCodeMode({
    code,
    toolMap,
    appBundles,
    bindings,
    userContext: { id: userId, email: userEmail },
    timeoutMs: 60_000,
    files,
  });
}

function getDynamicWorkerExports(): DynamicWorkerExports {
  const ctx = globalThis.__ctx as unknown as { exports?: DynamicWorkerExports };
  if (!ctx.exports) {
    throw new Error('Dynamic worker exports are unavailable');
  }
  return ctx.exports;
}

// ── Tool Definition Builder ──

function buildCodemodeToolDef(brokerResult: FlashBrokerResult, files?: ChatFileAttachment[]): object {
  const fnList = Object.entries(brokerResult.toolMap)
    .map(([name]) => `codemode.${name}()`)
    .join(', ');

  let description = `Execute a JavaScript recipe. Available functions: ${fnList}.`;

  if (files?.length) {
    description += `\n\nUser attached files — available as the \`__files\` array. Each file has { name, size, mimeType, content (base64 data URL) }.`;
    for (const f of files) {
      description += `\n- __files[${files.indexOf(f)}]: "${f.name}" (${f.mimeType}, ${f.size} bytes)`;
    }
    description += `\nPass file content to functions like: codemode.quick_start({ topic: "...", file_content: __files[0].content, file_name: __files[0].name })`;
  }

  if (brokerResult.functions) {
    description += `\n\nType declarations:\n${brokerResult.functions}`;
  }

  if (brokerResult.entities.length > 0) {
    description += '\n\nPre-resolved entities:';
    for (const e of brokerResult.entities) {
      description += `\n- ${e.name} -> ${e.type} id="${e.id}" in ${e.appName}`;
      if (e.context) description += ` (${e.context})`;
    }
  }

  if (brokerResult.conventions.length > 0) {
    description += '\n\nConventions to follow:';
    for (const c of brokerResult.conventions) {
      description += `\n- [${c.appName}] ${c.key}: ${c.value}`;
    }
  }

  return {
    type: 'function',
    function: {
      name: 'ul_codemode',
      description,
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'JavaScript recipe code. Use codemode.fn_name(args) to call functions. The code is the body of an async function — use `return` to return the result. Do NOT use import/require.',
          },
        },
        required: ['code'],
      },
    },
  };
}

// ── Cross-Session Conversation Retrieval ──

async function retrieveConversationHistory(searchQuery: string, userId: string): Promise<string> {
  try {
    const { createEmbeddingService, searchConversationEmbeddings } = await import('./embedding.ts');
    const svc = createEmbeddingService();
    if (!svc) return '';
    const { embedding } = await svc.embed(searchQuery);
    const matches = await searchConversationEmbeddings(embedding, userId, { limit: 3, threshold: 0.55 });
    if (matches.length === 0) return '';
    let context = '## Relevant Past Conversations\n';
    for (const m of matches) {
      const date = new Date(m.created_at).toLocaleDateString();
      context += `### ${m.conversation_name} (${date})\n${m.summary}\n\n`;
    }
    return context;
  } catch {
    return '';
  }
}

// ── System Agent Magnification ──
// Pulls agent-type-specific data server-side before the heavy model call.

async function magnifyForSystemAgent(
  agentType: string,
  brokerResult: FlashBrokerResult,
  userId: string,
): Promise<string> {
  switch (agentType) {
    case 'tool_builder': {
      // Download source code for the target app (if extending/modifying an existing app)
      const appId = brokerResult.involvedAppIds?.[0];
      if (!appId) return '';
      try {
        const { executeDownload } = await import('../handlers/platform-mcp.ts');
        const source = await executeDownload(userId, { app_id: appId });
        const sourceStr = typeof source === 'string' ? source : JSON.stringify(source, null, 2);
        // Also get D1 schema if app has a database
        let schemaStr = '';
        try {
          const dbId = await getD1DatabaseId(appId);
          if (dbId) {
            const env = getEnv();
            const cfAccountId = env.CF_ACCOUNT_ID;
            const cfApiToken = env.CF_API_TOKEN;
            if (cfAccountId && cfApiToken) {
              const schemaRes = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/d1/database/${dbId}/query`,
                {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sql: "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL" }),
                }
              );
              const schemaData = await schemaRes.json() as { result?: Array<{ results?: Array<{ sql: string }> }> };
              const tables = schemaData.result?.[0]?.results || [];
              schemaStr = tables.map((t: { sql: string }) => t.sql).join('\n\n');
            }
          }
        } catch { /* no D1 schema available */ }
        return `## Current App Source Code\n${sourceStr.slice(0, 12000)}${schemaStr ? `\n\n## D1 Database Schema\n${schemaStr}` : ''}`;
      } catch {
        return '';
      }
    }
    case 'tool_marketer':
    case 'platform_manager':
      // These agents get their context from Skills.md + Flash's existing magnification
      return '';
    default:
      return '';
  }
}

function modelDisplayName(modelId: string): string {
  if (modelId.includes('claude-sonnet-4')) return 'Claude Sonnet 4.6';
  if (modelId.includes('claude')) return 'Claude';
  if (modelId.includes('gemini-3.1-flash-lite')) return 'Gemini Flash Lite';
  if (modelId.includes('gemini')) return 'Gemini';
  if (modelId.includes('gpt-4')) return 'GPT-4o';
  if (modelId.includes('deepseek')) return 'DeepSeek';
  const parts = modelId.split('/');
  return parts[parts.length - 1] || modelId;
}
