// Context Resolver — Flash Broker (Phase 4B)
// Uses a small, fast LLM (Gemini Flash Lite) to resolve task context.
// Given a user prompt + function index, the flash model:
//   1. Identifies which functions are relevant
//   2. Resolves entity references (names, emails → IDs)
//   3. Selects conventions that apply
//   4. Suggests which model should handle the task
//   5. Summarizes conversation history (if provided)
//
// This replaces the heuristic keyword-matching approach with ~95% accuracy
// at a cost of ~$0.001 per call and ~400-600ms latency.

import { type FunctionIndex, getFunctionIndex } from './function-index.ts';
import { type EntityIndex, getEntityIndex } from './entity-index.ts';
import { deductChatCost } from './chat-billing.ts';
import { fetchInferenceChatCompletion, selectInferenceModel } from './inference-client.ts';
import { type ResolvedInferenceRoute, resolveInferenceRoute } from './inference-route.ts';
import { ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL } from './platform-inference-models.ts';

// ── Types ──

export interface TaskContext {
  entities: Array<{
    name: string; // display label
    match: string; // what the flash model identified
    type: string; // entity type (approval, conversation, room, etc.)
    id: string; // row ID or identifier
    appId: string;
    appName: string;
    context: string; // human-readable context
  }>;
  functions: Array<{
    name: string; // sanitized codemode name
    appId: string;
    description: string;
    returns: string;
    conventions: string[];
    dependsOn: string[];
  }>;
  conventions: Array<{ appName: string; key: string; value: string }>;
  promptBlock: string; // formatted for system prompt injection
  modelSuggestion?: string; // flash broker's model recommendation
}

// ── Flash Broker System Prompt ──

const FLASH_BROKER_SYSTEM =
  `You are a context resolver for an AI agent platform. Given a user's message and a catalog of available functions + data entities, output structured JSON that tells the execution model exactly what it needs.

Your job:
1. Identify which functions from the catalog are relevant to this task
2. Resolve any entity references (names, emails, subjects) to specific IDs from the entity data
3. Select relevant conventions/rules that apply
4. Suggest a model (flash for simple data queries, sonnet for complex multi-step tasks)

Output ONLY valid JSON matching this schema:
{
  "functions": ["function_name_1", "function_name_2"],
  "entities": [
    { "name": "Mike Chen", "type": "approval", "id": "abc123", "appName": "email-ops", "context": "Pending reply, high priority" }
  ],
  "conventions": [
    { "appName": "email-ops", "key": "reply_language", "value": "Reply in guest's language" }
  ],
  "modelSuggestion": "sonnet",
  "reasoning": "User wants to draft a response which requires understanding context and writing"
}

Rules:
- Only include functions that are DIRECTLY needed for this task
- For entities, match names/emails/subjects from the entity data to the user's prompt
- Pick at most 5-8 most relevant functions
- Pick at most 3-5 most relevant conventions
- modelSuggestion: "flash" for simple queries (list, show, check), "sonnet" for complex tasks (draft, create, multi-step)
- If no entities match, return empty entities array
- Always return valid JSON, nothing else`;

// ── Main Resolver ──

/**
 * Resolve task context using a flash model broker.
 * Loads indexes from KV, sends to flash model, returns structured context.
 */
export async function resolveContext(
  prompt: string,
  userId: string,
  userEmail: string,
  conversationHistory?: string,
  inferenceRoute?: ResolvedInferenceRoute,
): Promise<TaskContext> {
  // Load indexes concurrently
  const [fnIndex, entityIndex] = await Promise.all([
    getFunctionIndex(userId),
    getEntityIndex(userId),
  ]);

  if (!fnIndex || Object.keys(fnIndex.functions).length === 0) {
    return { entities: [], functions: [], conventions: [], promptBlock: '' };
  }

  // Build the catalog for the flash model
  const catalog = buildCatalog(fnIndex, entityIndex);

  let route: ResolvedInferenceRoute;
  try {
    route = inferenceRoute ?? await resolveInferenceRoute({ userId, userEmail });
  } catch (err) {
    console.warn('[CONTEXT] Inference route unavailable; using heuristic fallback:', err);
    return heuristicFallback(prompt, fnIndex, entityIndex);
  }

  // Call flash model
  const flashResult = await callFlashBroker(prompt, catalog, route, userId, conversationHistory);

  if (!flashResult) {
    // Flash model failed — fall back to heuristic matching
    return heuristicFallback(prompt, fnIndex, entityIndex);
  }

  // Map flash model output to TaskContext
  const functions: TaskContext['functions'] = [];
  for (const fnName of flashResult.functions || []) {
    const fn = fnIndex.functions[fnName];
    if (fn) {
      functions.push({
        name: fnName,
        appId: fn.appId,
        description: fn.description,
        returns: fn.returns || 'unknown',
        conventions: fn.conventions || [],
        dependsOn: fn.dependsOn || [],
      });
    }
  }

  const entities: TaskContext['entities'] = (flashResult.entities || []).map((e: any) => ({
    name: e.name || '',
    match: e.name || '',
    type: e.type || '',
    id: String(e.id || ''),
    appId: e.appId || '',
    appName: e.appName || '',
    context: e.context || '',
  }));

  const conventions: TaskContext['conventions'] = (flashResult.conventions || []).map((c: any) => ({
    appName: c.appName || '',
    key: c.key || '',
    value: c.value || '',
  }));

  const promptBlock = formatContextBlock(entities, functions, conventions);

  return {
    entities,
    functions,
    conventions,
    promptBlock,
    modelSuggestion: flashResult.modelSuggestion,
  };
}

// ── Flash Model Call ──

interface FlashBrokerResult {
  functions: string[];
  entities: Array<
    { name: string; type: string; id: string; appId?: string; appName?: string; context?: string }
  >;
  conventions: Array<{ appName: string; key: string; value: string }>;
  modelSuggestion: string;
  reasoning?: string;
}

async function callFlashBroker(
  prompt: string,
  catalog: string,
  route: ResolvedInferenceRoute,
  userId: string,
  conversationHistory?: string,
): Promise<FlashBrokerResult | null> {
  const userMessage = conversationHistory
    ? `## Conversation History (condensed)\n${conversationHistory}\n\n## Current Message\n${prompt}\n\n## Available Functions & Entities\n${catalog}`
    : `## User Message\n${prompt}\n\n## Available Functions & Entities\n${catalog}`;
  const model = selectInferenceModel(route, ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL);

  try {
    const response = await fetchInferenceChatCompletion(
      route,
      {
        model,
        messages: [
          { role: 'system', content: FLASH_BROKER_SYSTEM },
          { role: 'user', content: userMessage },
        ],
        temperature: 0, // Deterministic — same input always gives same output
        max_tokens: 1024,
        response_format: { type: 'json_object' },
      },
      {
        title: 'Ultralight Context Broker',
        referer: 'https://ultralight-api.rgn4jz429m.workers.dev',
      },
    );

    if (!response.ok) {
      console.error(`[CONTEXT] Flash broker failed: ${response.status}`);
      return null;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        total_cost?: number;
      };
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    if (route.shouldDebitLight && data.usage) {
      deductChatCost(
        userId,
        {
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0,
          total_tokens: data.usage.total_tokens ||
            (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0),
          prompt_cache_hit_tokens: data.usage.prompt_cache_hit_tokens,
          prompt_cache_miss_tokens: data.usage.prompt_cache_miss_tokens,
        },
        route.billingModelId ?? data.model ?? model,
        data.usage.total_cost,
        {
          provider: route.provider,
          upstream_provider: route.upstreamProvider,
          upstream_model: data.model || model,
          canonical_model_id: route.canonicalModelId ?? null,
          source: 'context_resolver',
        },
        { billingSource: route.billingSource },
      ).catch((err) => console.error('[CONTEXT] Light debit failed:', err));
    }

    // Parse JSON response
    const parsed = JSON.parse(content) as FlashBrokerResult;
    return parsed;
  } catch (err) {
    console.error('[CONTEXT] Flash broker error:', err);
    return null;
  }
}

// ── Catalog Builder ──

/**
 * Build a compact catalog string for the flash model.
 * Includes function signatures with descriptions, and entity data if available.
 */
function buildCatalog(fnIndex: FunctionIndex, entityIndex: EntityIndex | null): string {
  const sections: string[] = [];

  // Functions section — compact, NO conventions inline (saves ~5K tokens)
  sections.push('### Functions');
  for (const [name, fn] of Object.entries(fnIndex.functions)) {
    const params = Object.entries(fn.params || {})
      .map(([p, info]) => `${p}${info.required ? '' : '?'}: ${info.type}`)
      .join(', ');
    const returns = fn.returns && fn.returns !== 'unknown' ? ` → ${fn.returns}` : '';
    sections.push(`- ${name}(${params})${returns} — ${fn.description}`);
  }

  // Conventions section — deduplicated, compact, max 10
  const conventionMap = new Map<string, string>();
  for (const fn of Object.values(fnIndex.functions)) {
    for (const conv of fn.conventions || []) {
      const colonIdx = conv.indexOf(':');
      const key = colonIdx > 0 ? conv.substring(0, colonIdx).trim() : conv;
      if (!conventionMap.has(key) && key.length > 2) {
        const value = colonIdx > 0 ? conv.substring(colonIdx + 1).trim() : '';
        // Skip very long conventions (summaries), keep short actionable ones
        if (value.length < 120) {
          conventionMap.set(key, `[${fn.appSlug}] ${key}: ${value}`);
        }
      }
    }
  }
  if (conventionMap.size > 0) {
    sections.push('\n### Key Conventions');
    const convArray = [...conventionMap.values()].slice(0, 10);
    for (const conv of convArray) {
      sections.push(`- ${conv}`);
    }
  }

  // Entity data section
  if (entityIndex && entityIndex.entities.length > 0) {
    sections.push('\n### Known Entities (from app databases)');
    for (const entity of entityIndex.entities.slice(0, 30)) {
      const fields = Object.entries(entity.fields || {})
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ');
      sections.push(
        `- [${entity.appSlug}/${entity.table}] id=${entity.rowId}: ${entity.label} (${fields})`,
      );
    }
  }

  // Widgets
  if (fnIndex.widgets?.length > 0) {
    sections.push('\n### Widgets');
    for (const w of fnIndex.widgets) {
      sections.push(`- {{widget:${w.name}:${w.appId}}} — ${w.label}`);
      if (w.cards?.length) {
        const cards = w.cards.map((card) => `${card.id} (${card.size})`).join(', ');
        sections.push(`  Command cards: ${cards}`);
      }
    }
  }

  return sections.join('\n');
}

// ── Heuristic Fallback ──

/**
 * Simple keyword-based fallback when flash model is unavailable.
 */
function heuristicFallback(
  prompt: string,
  fnIndex: FunctionIndex,
  entityIndex: EntityIndex | null,
): TaskContext {
  const promptLower = prompt.toLowerCase();
  const words = promptLower.split(/\s+/);

  // Match functions by keyword overlap
  const matchedFunctions: TaskContext['functions'] = [];
  for (const [name, fn] of Object.entries(fnIndex.functions)) {
    const descLower = fn.description.toLowerCase();
    const nameLower = name.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (word.length < 3) continue;
      if (nameLower.includes(word)) score += 3;
      if (descLower.includes(word)) score += 2;
    }
    if (score > 0) {
      matchedFunctions.push({
        name,
        appId: fn.appId,
        description: fn.description,
        returns: fn.returns || 'unknown',
        conventions: fn.conventions || [],
        dependsOn: fn.dependsOn || [],
        _score: score,
      } as any);
    }
  }

  // Sort by score, take top 8
  matchedFunctions.sort((a: any, b: any) => (b._score || 0) - (a._score || 0));
  const topFunctions = matchedFunctions.slice(0, 8).map((f) => {
    const { _score, ...rest } = f as any;
    return rest;
  });

  // Collect conventions
  const conventions: TaskContext['conventions'] = [];
  const seen = new Set<string>();
  for (const fn of topFunctions) {
    for (const conv of fn.conventions) {
      if (seen.has(conv)) continue;
      seen.add(conv);
      const colonIdx = conv.indexOf(':');
      conventions.push({
        appName: fn.appId,
        key: colonIdx > 0 ? conv.substring(0, colonIdx).trim() : conv,
        value: colonIdx > 0 ? conv.substring(colonIdx + 1).trim() : '',
      });
    }
  }

  const promptBlock = formatContextBlock([], topFunctions, conventions.slice(0, 5));
  return {
    entities: [],
    functions: topFunctions,
    conventions: conventions.slice(0, 5),
    promptBlock,
  };
}

// ── Formatting ──

function formatContextBlock(
  entities: TaskContext['entities'],
  functions: TaskContext['functions'],
  conventions: TaskContext['conventions'],
): string {
  if (entities.length === 0 && functions.length === 0) return '';

  const lines: string[] = ['## Task Context', ''];

  if (entities.length > 0) {
    lines.push('**Entities (pre-resolved from your data):**');
    for (const e of entities) {
      lines.push(`- ${e.name} → ${e.type} id="${e.id}" in ${e.appName}. ${e.context}`);
    }
    lines.push('');
  }

  if (functions.length > 0) {
    lines.push('**Relevant Functions:**');
    for (const f of functions) {
      let line = `- \`codemode.${f.name}()\``;
      if (f.returns && f.returns !== 'unknown') {
        line += ` → \`${f.returns}\``;
      }
      line += ` — ${f.description}`;
      lines.push(line);
      if (f.dependsOn.length > 0) {
        lines.push(`  ↳ Needs: ${f.dependsOn.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (conventions.length > 0) {
    lines.push('**Conventions:**');
    for (const c of conventions) {
      lines.push(`- [${c.appName}] ${c.key}: ${c.value}`);
    }
    lines.push('');
  }

  lines.push(
    'Use the entity IDs above directly — no need to query for them. Write ONE codemode recipe.',
  );

  return lines.join('\n');
}
