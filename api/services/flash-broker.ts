// Flash Broker — two-stage context resolution + prompt construction.
//
// Stage 1: Flash analyzes the user's message against the function index
//          (function signatures + conventions). Identifies relevant apps.
//
// Stage 2: MAGNIFICATION — for the identified apps, pull their full D1 data
//          for this user. Flash now sees the actual database contents and can
//          resolve any reference (names, IDs, states, amounts) directly.
//
// Flash then constructs a COMPLETE prompt for the heavy model with all
// resolved data, conventions, and function signatures. The heavy model
// writes ONE recipe and it works first try.
//
// Cost: ~$0.002 per call (two Flash rounds + D1 queries), ~1-2s total.

import { getEnv } from '../lib/env.ts';
import { getFunctionIndex, rebuildFunctionIndex, type FunctionIndex } from './function-index.ts';
import { flattenCommandSurfaceInventory } from './command-surfaces.ts';
import { createR2Service } from './storage.ts';
import { getD1DatabaseId } from './d1-provisioning.ts';
import { createAppsService } from './apps.ts';
import { createEmbeddingService } from './embedding.ts';
import { fetchInferenceChatCompletion, selectInferenceModel } from './inference-client.ts';
import {
  ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL,
  ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL,
} from './platform-inference-models.ts';
import { resolveInferenceRoute, type ResolvedInferenceRoute } from './inference-route.ts';
import type { App } from '../../shared/types/index.ts';
import { buildJsonSchemaDescriptors, type AppForCodemode } from './codemode-tools.ts';
import { buildAppTrustCard, type TrustCard } from './trust.ts';
import { createLlmInvocationTelemetrySession } from './invocation-telemetry.ts';
import {
  buildAnalyzeOutputLabels,
  buildExecutionConfirmationOutputLabels,
  buildFlashInvocationMetadata,
  buildPromptBuilderOutputLabels,
  buildReadResponseOutputLabels,
  FLASH_SCHEMA_IDS,
  type FlashCapability,
  type FlashInputFeatureInput,
  type FlashSchemaId,
  type FlashTaskId,
} from './flash-finetune-metadata.ts';

// ── Types ──

/** System agent state — synced from desktop client, included in Stage 1 catalog */
export interface SystemAgentState {
  type: string;
  name: string;
  tools: string[];
  stateSummary: string | null;
  status: string;
}

export interface FlashBrokerTelemetryContext {
  traceId: string;
  conversationId?: string;
  source?: string;
}

export interface FlashCallTelemetryContext extends FlashBrokerTelemetryContext {
  userId: string;
  userEmail: string;
  source: string;
}

export interface FlashCallOptions {
  telemetry?: FlashCallTelemetryContext;
  taskId?: FlashTaskId;
  schemaId?: FlashSchemaId;
  capabilities?: readonly FlashCapability[];
  inputFeatures?: FlashInputFeatureInput | Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface FlashBrokerResult {
  needsTool: boolean;
  directResponse: string;
  model: string;
  prompt: string;
  functions: string;
  entities: Array<{
    name: string;
    type: string;
    id: string;
    appId: string;
    appName: string;
    context: string;
  }>;
  conventions: Array<{ appName: string; key: string; value: string }>;
  involvedAppIds: string[];
  toolMap: Record<string, { appId: string; appName: string; fnName: string; appSlug: string; origin: 'library' | 'marketplace' }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** System agent delegations recommended by Flash analysis */
  systemAgentDelegations?: Array<{ agentType: string; task: string; originalPrompt: string }>;
  /** Cross-session conversation search query (triggers semantic retrieval in Stage 2) */
  conversationSearch?: string;
}

/** Rolling conversation summary persisted in KV */
interface ConversationSummary {
  summary: string;           // Rolling summary, 200-500 tokens
  lastMessageIndex: number;  // How many messages are covered
  updatedAt: number;
}

interface MarketplaceCandidate {
  app: Pick<App, 'id' | 'name' | 'slug' | 'description' | 'icon_url' | 'runtime' | 'manifest' | 'exports' | 'owner_id' | 'app_type' | 'current_version' | 'version_metadata' | 'visibility' | 'download_access' | 'env_schema'>;
  similarity: number;
  keyFunctions: string[];
}

type FunctionEntry = FunctionIndex['functions'][string];

export function buildFlashCallTelemetryContext(
  telemetry: FlashBrokerTelemetryContext | undefined,
  input: { userId: string; userEmail: string; conversationId?: string },
): FlashCallTelemetryContext | undefined {
  if (!telemetry) return undefined;
  return {
    userId: input.userId,
    userEmail: input.userEmail,
    traceId: telemetry.traceId,
    conversationId: telemetry.conversationId || input.conversationId,
    source: telemetry.source || 'orchestrate',
  };
}

export type FlashEvent =
  | { type: 'analyzing'; text: string }
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
      trust_card?: TrustCard;
    }>;
  }
  | { type: 'searching'; query: string; apps: string[] }
  | { type: 'magnifying'; text: string; apps: string[] }
  | { type: 'magnified'; app: string; tables: number; rows: number }
  | { type: 'constructing'; functions: string[]; conventionCount: number }
  | { type: 'prompt_ready'; prompt: string; model: string }
  | { type: 'direct_response'; content: string }
  | { type: 'done'; result: FlashBrokerResult }
  | { type: 'error'; message: string }
  // Legacy compat
  | { type: 'prefetch_start'; text: string; queries: string[] }
  | { type: 'prefetch_result'; entities: Array<{ name: string; type: string; context: string }> };

// ── Models ──

const DEFAULT_FLASH_MODEL = ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL;
const DEFAULT_HEAVY_MODEL = ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL;
const DEFAULT_HEAVY_FLASH = ULTRALIGHT_DEEPSEEK_V4_FLASH_MODEL;
const DEFAULT_HEAVY_SONNET = ULTRALIGHT_DEEPSEEK_V4_PRO_MODEL;

// ── Flash System Prompts ──

const FLASH_ANALYZE_SYSTEM = `You are a task router for an AI agent platform. Given a user's message and a catalog of available functions, output structured JSON.

Your job:
1. Decide the response mode:
   - "direct": No app data needed (greetings, general questions)
   - "read": User wants to READ/VIEW data. You'll write the response yourself after seeing the data.
   - "write": User wants to CHANGE/CREATE/SEND something. A code-writing model will handle this.
2. Identify which APPS are relevant (by app slug) and what data to look for in each
3. For "write" mode: select the action functions needed

Output ONLY valid JSON:
{
  "mode": "read",
  "directResponse": "",
  "relevantApps": [
    { "slug": "app-exbg0f", "scope": "character Sarah, Thornvale world" }
  ],
  "actionFunctions": [],
  "systemAgentDelegations": [],
  "conversationSearch": "",
  "updatedSummary": "User exploring Story Builder characters. Asked about Sarah in the Thornvale world.",
  "contextQuery": "",
  "reasoning": "User wants to know about a character. Need to read Story Builder data."
}

Rules:
- mode="direct" ONLY for greetings and general knowledge questions that clearly have nothing to do with any app. Put answer in directResponse.
- mode="read" for: "tell me about", "show me", "how many", "what is", "list", "find", any informational query. IMPORTANT: If the user mentions a name, entity, or term that COULD exist in any app's data, ALWAYS use "read" mode — even if you're unsure which app contains it. Err on the side of "read" over "direct".
- mode="write" for: "draft", "revise", "book", "create", "send", "approve", "reject", "update", "delete", any action that changes data
- relevantApps: array of objects { "slug": "app-slug", "scope": "..." }. slug identifies the app. scope is a short hint (entity names, topics, keywords) describing what data from that app is relevant to the request — e.g. "character Sarah, Thornvale world" or "pending approvals from Mike Chen". Use null scope when the user wants a broad overview. Max 3 apps. Required for read and write modes. When uncertain, include the most likely apps.
- actionFunctions: ONLY needed for "write" mode. The WRITE functions the code model will call.
- For "read" mode, leave actionFunctions empty — you'll respond directly after seeing the data.
- systemAgentDelegations: If part or all of the task is better handled by a system agent, include delegations. Each is { "agentType": "tool_marketer", "task": "Search marketplace for ..." }. Types: tool_builder (building/testing/deploying MCP apps), tool_marketer (marketplace lifecycle — browsing, discovery, publishing, pricing, analytics), platform_manager (settings/API keys/billing/guidance). Can coexist with mode="read" or "write".
- IMPORTANT: If the user's request requires capabilities NOT FOUND in the available functions catalog, delegate to tool_marketer. Do NOT respond with "I don't have any apps for that." Instead, delegate: { "agentType": "tool_marketer", "task": "User needs [capability]. Search marketplace for tools that provide this and help them evaluate options." }. Tool Dealer will search the full marketplace, try apps, and report back.
- Command dashboards: setup, saved layouts, and "make me a dashboard" requests belong to platform_manager. Finding dashboard-ready widgets/cards belongs to tool_marketer. Building missing widgets/cards belongs to tool_builder.
- If "Local Project Files" context is provided, the user may be asking about their local codebase. For questions about project structure, code, or dependencies, use mode="read" or mode="direct" and answer from the context. For tasks that create or modify local files, use mode="write". If you're not in a tool_builder context, delegate file-modification tasks to tool_builder.
- conversationSearch: If the user references past work, a previous conversation, or something discussed before (visible in "Past Conversation Topics"), put a descriptive search query here (e.g., "auth pattern for inventory management"). Leave empty if not needed.
- updatedSummary: ALWAYS output this field. Maintain a rolling summary of this conversation. You receive the previous summary (in "Conversation Summary") and the latest exchange (in "Last Exchange"). Merge them into an updated summary (200-400 tokens max). Include: key decisions made, entities referenced by name, user preferences expressed, task progress, and commitments/follow-ups. Omit exact data values and IDs (those are available via raw history if needed). If no summary section is provided, create one from whatever conversation context is available. On the very first message with no prior context, summarize just the current request.
- contextQuery: If the user's current message references specific details from earlier in THIS conversation that aren't captured in the summary (exact values, previous results, specific numbers, "the same format as before"), put a descriptive search query here to retrieve relevant raw exchanges. Leave empty when the summary provides sufficient context. This is different from conversationSearch (which searches PAST conversations).
- NAMES OVER IDs: Always identify entities by human-readable names, not opaque IDs. When a user says "my Fantasy RPG world" or "the weather app", match by name from the catalog or data. Never ask users for UUIDs or internal IDs.
- When selecting apps for relevantApps, prefer [saved] candidates over [marketplace] candidates when both match the user's intent. Only elevate [marketplace] when it clearly fills a gap not covered by [saved] options.
- Always return valid JSON, nothing else`;

const FLASH_READ_RESPONSE_SYSTEM = `You are a helpful AI assistant responding to a user's question using live data from their apps. Write a clear, well-formatted response using markdown.

Rules:
- Use the provided app data to answer the user's question completely
- Format with markdown: headings, bold, lists, etc.
- Be concise but thorough — include all relevant details from the data
- If the data doesn't contain what the user asked about, say so clearly
- Never show raw JSON to the user — synthesize it into natural language
- Include specific names, dates, and values from the data — use human-readable names, not opaque IDs
- If there are multiple items, use numbered or bulleted lists
- If Local Project Context is provided, use it to answer questions about the user's codebase. Reference specific file names, line numbers, and code snippets when helpful.
- NAMES OVER IDs: Always refer to entities by their human-readable names. Never show UUIDs or internal IDs to the user unless they specifically ask for them.`;

const FLASH_WRITE_CONFIRM_SYSTEM = `You are confirming the result of an action that was just executed. Given the user's original request and the execution result, write a brief, clear confirmation message.

Rules:
- Be concise — 1-3 sentences
- Confirm what was done specifically (e.g., "I've revised Mike Chen's draft to include group discount information")
- If the result contains useful data, mention key details
- If there was an error, explain it clearly
- Use markdown formatting as appropriate`;

const FLASH_PROMPT_SYSTEM = `You are constructing a prompt for a code-writing AI model. Given:
1. The user's original message
2. Live data from the user's apps (magnified database contents)
3. Available functions with their signatures

Construct a COMPLETE prompt that tells the code-writing model exactly what to do. Include:
- All relevant data values from the magnified data — resolve names to IDs from the data tables so the code model has exact IDs to use in function calls
- Specific function calls to make with exact arguments
- Conventions to follow
- What to return
- NAMES OVER IDs: When the user refers to an entity by name, look up its ID from the magnified data and include BOTH in the prompt (e.g., "The world 'Fantasy RPG' (id: w123)"). The code model needs IDs for function calls, but never ask the user for an ID — always resolve it from the data yourself.

The code-writing model will receive ONLY your prompt (no system prompt) and ONE tool: ul_codemode.
It writes JavaScript using codemode.functionName(args) to execute.

When the task involves creating or modifying LOCAL PROJECT FILES (not platform apps), instruct the model to output file contents using this format in its text response (NOT in the codemode recipe):
<!-- file:write path="src/example.ts" -->
\`\`\`ts
// file content here
\`\`\`
<!-- /file:write -->
The client will parse these markers and write files to the user's local project directory.

When the task uses tools/functions, the final prompt should also tell the code-writing model:
- The execution widget carries the tool-by-tool detail. Keep narration brief and focus on why the action matters and what the result means.
- Do not repeat full argument payloads or raw execution results in narration when the UI already shows them.
- Always name each tool you use. If the prompt explicitly identifies a tool as coming from the user's library or from the marketplace, mention that origin in narration too.

Output ONLY valid JSON:
{
  "prompt": "The user wants to shorten Mike Chen's draft response.\\n\\nMike Chen's approval:\\n- ID: 4ac6c973...\\n- Current draft: [full draft text]\\n\\nConventions:\\n- Reply in guest's language\\n\\nCall codemode.app_ges2af_approvals_act({ approval_id: \\"4ac6c973...\\", action: \\"revise\\", revision: \\"[shortened version]\\" })",
  "model": "sonnet",
  "entities": [
    { "name": "Mike Chen", "type": "contact", "id": "4ac6c973...", "appId": "d90a446c...", "appName": "email-ops", "context": "Pending approval for family trip" }
  ],
  "conventions": [
    { "appName": "email-ops", "key": "reply_language", "value": "Reply in guest's language" }
  ]
}`;

// ── Magnification Config ──

/** Tables to skip during magnification (internal/system tables) */
const SKIP_TABLES = new Set([
  '_cf_KV', '_migrations', '_usage', '_analytics', '_cache', '_sessions',
  '_jobs', '_queue', '_locks', '_schema_version', 'sqlite_sequence',
]);

/** Max rows per table */
const MAX_ROWS_PER_TABLE = 30;

/** Max total characters of magnified data per app */
const MAX_CHARS_PER_APP = 8000;

// ── Main Entry (Async Generator) ──

/** System agent context — injected into Flash prompts for persona + skills */
export interface SystemAgentContext {
  type: 'tool_builder' | 'tool_marketer' | 'platform_manager';
  persona: string;
  skillsPath: string;
}

/** Scope config passed from the client — restricts which apps/functions/data are available */
export type ScopeConfig = Record<string, {
  access: 'all' | 'functions' | 'data';
  functions?: string[];
}>;

/** File attachment from chat input */
interface ChatFileAttachment {
  name: string;
  size: number;
  mimeType: string;
  content: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function buildFileContext(files: ChatFileAttachment[]): string {
  if (!files.length) return '';
  const items = files.map(f => `- ${f.name} (${formatFileSize(f.size)}, ${f.mimeType})`).join('\n');
  return `## Attached Files\nThe user attached ${files.length} file(s) with their message:\n${items}\nThe file contents are available as base64 data URLs and should be passed to the relevant app's functions (e.g. quick_start with file_content + file_name args, or ultralight.ai with multimodal content parts).\n\n`;
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

/**
 * Build multimodal content array: text prompt + image files as vision content parts.
 * Non-image files stay as metadata text (they flow to MCPs via __files).
 */
function buildMultimodalContent(textContent: string, files?: ChatFileAttachment[]): string | unknown[] {
  if (!files?.length) return textContent;

  const imageFiles = files.filter(f => IMAGE_MIMES.has(f.mimeType));
  if (imageFiles.length === 0) return textContent; // No images — keep as plain text

  const parts: unknown[] = [{ type: 'text', text: textContent }];
  for (const f of imageFiles) {
    const url = f.content.startsWith('data:') ? f.content : `data:${f.mimeType};base64,${f.content}`;
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

function countFunctionConventions(functions: FunctionIndex['functions']): number {
  return Object.values(functions).reduce((total, fn) => total + (fn.conventions?.length || 0), 0);
}

export interface PureSystemAgentDelegationInput {
  mode?: unknown;
  relevantApps?: unknown;
  actionFunctions?: unknown;
  systemAgentDelegations?: unknown;
  conversationSearch?: unknown;
  contextQuery?: unknown;
}

const PURE_SYSTEM_AGENT_TYPES = new Set([
  'tool_builder',
  'tool_marketer',
  'platform_manager',
]);

export function shouldSkipHeavyPromptForPureSystemAgentDelegation(
  input: PureSystemAgentDelegationInput,
): boolean {
  const mode = typeof input.mode === 'string' ? input.mode : 'write';
  if (mode === 'direct') return false;
  if (nonEmptyString(input.conversationSearch) || nonEmptyString(input.contextQuery)) return false;
  if (hasRelevantAppSelections(input.relevantApps)) return false;
  if (hasStringSelections(input.actionFunctions)) return false;
  return hasPureSystemAgentDelegations(input.systemAgentDelegations);
}

function hasPureSystemAgentDelegations(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  let count = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.task !== 'string' ||
      record.task.trim().length === 0 ||
      typeof record.agentType !== 'string' ||
      !PURE_SYSTEM_AGENT_TYPES.has(record.agentType)
    ) {
      return false;
    }
    count += 1;
  }
  return count > 0;
}

function hasRelevantAppSelections(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (typeof entry === 'string') return entry.trim().length > 0;
    if (!entry || typeof entry !== 'object') return false;
    const slug = (entry as Record<string, unknown>).slug;
    return typeof slug === 'string' && slug.trim().length > 0;
  });
}

function hasStringSelections(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function* runFlashBroker(
  message: string,
  userId: string,
  userEmail: string,
  conversationHistory?: Array<{ role: string; content: string }>,
  interpreterModel?: string,
  heavyModel?: string,
  scope?: ScopeConfig,
  systemAgentStates?: SystemAgentState[],
  systemAgentContext?: SystemAgentContext,
  projectContext?: string,
  conversationId?: string,
  files?: ChatFileAttachment[],
  inferenceRoute?: ResolvedInferenceRoute,
  telemetry?: FlashBrokerTelemetryContext,
): AsyncGenerator<FlashEvent> {
  let route: ResolvedInferenceRoute;
  try {
    route = inferenceRoute ?? await resolveInferenceRoute({ userId, userEmail });
  } catch (err) {
    yield {
      type: 'error',
      message: `Inference route unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  const flashModel = selectInferenceModel(route, interpreterModel || DEFAULT_FLASH_MODEL);
  const defaultHeavyModel = selectInferenceModel(route, heavyModel || DEFAULT_HEAVY_MODEL);
  const flashTelemetry = buildFlashCallTelemetryContext(telemetry, {
    userId,
    userEmail,
    conversationId,
  });

  yield { type: 'analyzing', text: 'Analyzing your request...' };

  // Load function index + system agent states + agent skills + conversation topics concurrently
  let [fnIndex, loadedSystemAgentStates, agentSkills, conversationTopics, loadedSummary] = await Promise.all([
    getFunctionIndex(userId),
    systemAgentStates ? Promise.resolve(systemAgentStates) : loadSystemAgentStates(userId),
    systemAgentContext ? loadSystemAgentSkills(systemAgentContext.type) : Promise.resolve(''),
    loadConversationTopics(userId),
    loadConversationSummary(conversationId),
  ]);

  // Auto-rebuild if empty
  if (!fnIndex || Object.keys(fnIndex.functions).length === 0) {
    try {
      fnIndex = await rebuildFunctionIndex(userId);
    } catch (err) {
      console.error('[FLASH-BROKER] Failed to rebuild function index:', err);
    }
  }

  if (!fnIndex || Object.keys(fnIndex.functions).length === 0) {
    const result: FlashBrokerResult = {
      needsTool: false,
      directResponse: "I don't have any apps or functions set up yet. Install an app to get started.",
      model: defaultHeavyModel,
      prompt: '', functions: '', entities: [], conventions: [],
      involvedAppIds: [], toolMap: {},
    };
    yield { type: 'direct_response', content: result.directResponse };
    yield { type: 'done', result };
    return;
  }

  // Keep unfiltered index for data-only app lookups (slug → appId)
  const fullFnIndex = fnIndex;

  // ── Apply scope filter — restrict the function index to scoped apps/functions ──
  // Scope keys can be app names (from library markdown) or DB slugs — build a lookup
  if (scope && Object.keys(scope).length > 0) {
    // Build name→slug and slug→name maps from the function index
    const appNameToSlug: Record<string, string> = {};
    const appSlugToName: Record<string, string> = {};
    for (const fn of Object.values(fnIndex.functions)) {
      // Extract app name from description: "[App Name] description..."
      const match = fn.description.match(/^\[([^\]]+)\]/);
      if (match) {
        appNameToSlug[match[1].toLowerCase()] = fn.appSlug;
        appSlugToName[fn.appSlug] = match[1];
      }
    }

    // Normalize scope keys to DB slugs
    const normalizedScope: typeof scope = {};
    for (const [key, cfg] of Object.entries(scope)) {
      // Try direct match (already a DB slug)
      const directMatch = Object.values(fnIndex.functions).some(fn => fn.appSlug === key);
      if (directMatch) {
        normalizedScope[key] = cfg;
      } else {
        // Try name→slug lookup (case-insensitive)
        const dbSlug = appNameToSlug[key.toLowerCase()];
        if (dbSlug) {
          normalizedScope[dbSlug] = cfg;
        } else {
          console.log(`[FLASH-BROKER] Scope key "${key}" not found in function index — skipping`);
        }
      }
    }

    const originalCount = Object.keys(fnIndex.functions).length;
    const filtered: typeof fnIndex.functions = {};
    for (const [name, fn] of Object.entries(fnIndex.functions)) {
      const appScope = normalizedScope[fn.appSlug];
      if (!appScope) continue; // App not in scope — exclude entirely
      if (appScope.access === 'data') continue; // Data-only — no functions in catalog
      // Check function-level filter
      if (appScope.functions && appScope.functions.length > 0 && !appScope.functions.includes(fn.fnName)) continue;
      filtered[name] = fn;
    }
    fnIndex = { ...fnIndex, functions: filtered };
    // Replace scope with normalized version for downstream use
    scope = Object.keys(normalizedScope).length > 0 ? normalizedScope : undefined;
    console.log(`[FLASH-BROKER] Scope applied: ${Object.keys(normalizedScope).length} apps, ${Object.keys(filtered).length}/${originalCount} functions`);
  }

  // Build conversation context from rolling summary + unsummarized exchanges
  let summaryStr = '';
  let lastExchangeStr = '';

  if (loadedSummary?.summary) {
    summaryStr = loadedSummary.summary;
    // Extract messages after lastMessageIndex as the unsummarized exchange
    const unsummarized = conversationHistory
      ? conversationHistory.slice(loadedSummary.lastMessageIndex)
      : [];
    if (unsummarized.length > 0) {
      lastExchangeStr = unsummarized.map(m => `${m.role}: ${m.content}`).join('\n');
    }
  } else if (conversationHistory && conversationHistory.length > 0) {
    // Bootstrap: no summary yet, send recent messages for initial summary creation
    lastExchangeStr = conversationHistory.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
  }

  const conversationSummary = [summaryStr, lastExchangeStr]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 2000);
  const marketplaceCandidates = scope && Object.keys(scope).length > 0
    ? []
    : await retrieveMarketplaceCandidates(
      message,
      conversationSummary,
      userId,
      fnIndex,
    );

  if (marketplaceCandidates.length > 0) {
    yield {
      type: 'ambient_suggestions',
      suggestions: marketplaceCandidates.map((candidate) => ({
        id: candidate.app.id,
        slug: candidate.app.slug,
        name: candidate.app.name,
        description: candidate.app.description || '',
        icon_url: candidate.app.icon_url,
        similarity: candidate.similarity,
        source: 'marketplace' as const,
        type: 'app' as const,
        connected: false as const,
        ...(candidate.app.runtime ? { runtime: candidate.app.runtime } : {}),
        trust_card: buildAppTrustCard(candidate.app),
      })),
    };
  }

  // Build compact catalog for Flash (function signatures + conventions only, no data)
  const catalog = buildCatalog(fnIndex, loadedSystemAgentStates, marketplaceCandidates);

  // Build persona-aware system prompt
  const analyzeSystem = systemAgentContext
    ? `You are acting as "${systemAgentContext.persona}" — a specialized system agent on the Ultralight platform.\n\n${FLASH_ANALYZE_SYSTEM}`
    : FLASH_ANALYZE_SYSTEM;

  let analyzeContent = '';
  if (scope && Object.keys(scope).length > 0) {
    const scopedNames = Object.keys(scope);
    analyzeContent += `## SESSION SCOPE\nThis session is scoped to ONLY these apps: ${scopedNames.join(', ')}. Do not reference or suggest other apps.\n\n`;
  }
  if (files?.length) analyzeContent += buildFileContext(files);
  if (projectContext) analyzeContent += `## Local Project Files\n${projectContext}\n\n`;
  if (agentSkills) analyzeContent += `## Agent Skills Reference\n${agentSkills}\n\n`;
  if (conversationTopics) analyzeContent += `## Past Conversation Topics\n${conversationTopics}\n\n`;
  if (summaryStr) analyzeContent += `## Conversation Summary\n${summaryStr}\n\n`;
  if (lastExchangeStr) analyzeContent += `## Last Exchange\n${lastExchangeStr}\n\n`;
  analyzeContent += `## Current Message\n${message}\n\n## Available Functions\n${catalog}`;

  const analyzeResult = await callFlash(flashModel, analyzeSystem, buildMultimodalContent(analyzeContent, files), route, {
    telemetry: flashTelemetry,
    taskId: 'flash_broker.analyze',
    schemaId: FLASH_SCHEMA_IDS.analyze,
    inputFeatures: {
      files,
      projectContext,
      conversationHistory,
      availableFunctionCount: Object.keys(fnIndex.functions).length,
      conventionCount: countFunctionConventions(fnIndex.functions),
      scope,
      systemAgentContext,
    },
    metadata: {
      marketplace_candidate_count: marketplaceCandidates.length,
      has_agent_skills: !!agentSkills,
      has_conversation_topics: !!conversationTopics,
      has_conversation_summary: !!summaryStr,
      has_last_exchange: !!lastExchangeStr,
    },
  });
  if (!analyzeResult) {
    const result = heuristicFallback(message, fnIndex, defaultHeavyModel);
    yield { type: 'done', result };
    return;
  }

  // Determine mode (support both old needsTool and new mode field)
  const mode = analyzeResult.mode || (analyzeResult.needsTool === false ? 'direct' : 'write');
  const rawRelevantApps = analyzeResult.relevantApps || [];
  const actionFunctions = analyzeResult.actionFunctions || [];

  // Capture system agent delegations from Flash analysis
  const systemAgentDelegations: Array<{ agentType: string; task: string; originalPrompt: string }> =
    (analyzeResult.systemAgentDelegations || [])
      .filter((d: any) => d.agentType && d.task)
      .map((d: any) => ({ agentType: d.agentType, task: d.task, originalPrompt: message }));

  // Capture conversation search query (for cross-session context retrieval)
  const conversationSearch: string | undefined = analyzeResult.conversationSearch || undefined;

  // Capture intra-conversation context query (for raw history magnification in Stage 2)
  const contextQuery: string | undefined = analyzeResult.contextQuery || undefined;

  // Persist updated rolling summary (fire-and-forget)
  const updatedSummary: string | undefined = analyzeResult.updatedSummary || undefined;
  if (loadedSummary) {
    console.log(`[FLASH-BROKER] Loaded conversation summary (${loadedSummary.summary.length} chars, covers ${loadedSummary.lastMessageIndex} messages)`);
  }
  if (updatedSummary && conversationId) {
    const env = getEnv();
    const kv = env.FN_INDEX;
    if (kv) {
      kv.put(`convo-summary:${conversationId}`, JSON.stringify({
        summary: updatedSummary,
        lastMessageIndex: conversationHistory?.length || 0,
        updatedAt: Date.now(),
      } as ConversationSummary)).catch((err: unknown) =>
        console.warn('[FLASH-BROKER] Summary KV write failed:', err)
      );
    }
  }

  // Direct response — no data needed
  if (mode === 'direct') {
    const result: FlashBrokerResult = {
      needsTool: false,
      directResponse: analyzeResult.directResponse || 'I can help with that!',
      model: defaultHeavyModel,
      prompt: '', functions: '', entities: [], conventions: [],
      involvedAppIds: [], toolMap: {},
      usage: analyzeResult._usage,
      systemAgentDelegations: systemAgentDelegations.length > 0 ? systemAgentDelegations : undefined,
      conversationSearch,
    };
    yield { type: 'direct_response', content: result.directResponse };
    yield { type: 'done', result };
    return;
  }

  // Pure system-agent routes do not need data magnification or Heavy prompt construction.
  // Mixed cases with selected apps/functions still fall through to the normal write/read path.
  if (shouldSkipHeavyPromptForPureSystemAgentDelegation({
    mode,
    relevantApps: rawRelevantApps,
    actionFunctions,
    systemAgentDelegations,
    conversationSearch,
    contextQuery,
  })) {
    const result: FlashBrokerResult = {
      needsTool: false,
      directResponse: '',
      model: defaultHeavyModel,
      prompt: '',
      functions: '',
      entities: [],
      conventions: [],
      involvedAppIds: [],
      toolMap: {},
      usage: analyzeResult._usage,
      systemAgentDelegations,
    };
    yield { type: 'done', result };
    return;
  }

  // ── Stage 2: MAGNIFICATION — pull live data from identified apps ──

  // Determine which apps to magnify
  const relevantAppSlugs: string[] = [];
  const appScopeHints: Record<string, string> = {};
  for (const entry of rawRelevantApps) {
    if (typeof entry === 'string') {
      relevantAppSlugs.push(entry);
    } else if (entry && typeof entry === 'object') {
      relevantAppSlugs.push(entry.slug);
      if (entry.scope) appScopeHints[entry.slug] = entry.scope;
    }
  }
  const provisionalFunctions = buildProvisionalFunctionEntries(marketplaceCandidates);
  const combinedFunctions: FunctionIndex['functions'] = {
    ...fnIndex.functions,
    ...provisionalFunctions,
  };
  const marketplaceCandidateBySlug = new Map(
    marketplaceCandidates.map((candidate) => [candidate.app.slug, candidate] as const)
  );

  // Resolve app slugs to app IDs
  const involvedAppIds = new Set<string>();
  const toolMap: FlashBrokerResult['toolMap'] = {};
  const appSlugToId: Record<string, string> = {};

  // First, map from action functions
  for (const fnName of actionFunctions) {
    const fn = combinedFunctions[fnName];
    if (fn) {
      toolMap[fnName] = {
        appId: fn.appId,
        appName: extractAppNameFromDescription(fn.description, fn.appSlug),
        fnName: fn.fnName,
        appSlug: fn.appSlug,
        origin: provisionalFunctions[fnName] ? 'marketplace' : 'library',
      };
      involvedAppIds.add(fn.appId);
      appSlugToId[fn.appSlug] = fn.appId;
    }
  }

  // Then, add any apps from relevantApps that aren't already included
  for (const slug of relevantAppSlugs) {
    if (!appSlugToId[slug]) {
      // Find any function with this app slug to get the appId
      const fn = Object.values(combinedFunctions).find(f => f.appSlug === slug);
      if (fn) {
        involvedAppIds.add(fn.appId);
        appSlugToId[slug] = fn.appId;
      } else {
        const marketplaceCandidate = marketplaceCandidateBySlug.get(slug);
        if (marketplaceCandidate) {
          involvedAppIds.add(marketplaceCandidate.app.id);
          appSlugToId[slug] = marketplaceCandidate.app.id;
        }
      }
    }
  }

  // Also include ALL functions for involved apps in the toolMap
  for (const [fnName, fn] of Object.entries(combinedFunctions)) {
    if (involvedAppIds.has(fn.appId) && !toolMap[fnName]) {
      toolMap[fnName] = {
        appId: fn.appId,
        appName: extractAppNameFromDescription(fn.description, fn.appSlug),
        fnName: fn.fnName,
        appSlug: fn.appSlug,
        origin: provisionalFunctions[fnName] ? 'marketplace' : 'library',
      };
    }
  }

  // ── Scope: add data-only apps to involvedAppIds (for magnification) ──
  // Data-only apps were filtered out of fnIndex, so use fullFnIndex to find their appIds
  if (scope) {
    for (const [slug, cfg] of Object.entries(scope)) {
      if (cfg.access === 'data' || cfg.access === 'all') {
        if (!appSlugToId[slug]) {
          const fn = Object.values(fullFnIndex.functions).find(f => f.appSlug === slug);
          if (fn) {
            involvedAppIds.add(fn.appId);
            appSlugToId[slug] = fn.appId;
          }
        }
      }
    }
  }

  // ── Scope: filter out apps that shouldn't be magnified ──
  if (scope && Object.keys(scope).length > 0) {
    const slugsAllowingData = new Set(
      Object.entries(scope).filter(([, cfg]) => cfg.access === 'all' || cfg.access === 'data').map(([slug]) => slug)
    );
    // Remove apps whose scope is 'functions' only (no magnification)
    for (const appId of [...involvedAppIds]) {
      const slug = Object.entries(appSlugToId).find(([, id]) => id === appId)?.[0];
      if (slug && !slugsAllowingData.has(slug)) {
        involvedAppIds.delete(appId);
      }
    }
  }

  const appIds = [...involvedAppIds];

  // Resolve human-readable app names from function descriptions
  // Descriptions are formatted as "[App Name] description..."
  // Use fullFnIndex to find names for data-only apps that were filtered out
  const appNames: Record<string, string> = {};
  const appSlugs: string[] = [];
  for (const id of appIds) {
    const fn = Object.values(combinedFunctions).find(f => f.appId === id)
      || Object.values(fullFnIndex.functions).find(f => f.appId === id);
    const candidate = marketplaceCandidates.find(entry => entry.app.id === id);
    const slug = fn?.appSlug || candidate?.app.slug || id.slice(0, 8);
    appSlugs.push(slug);
    const match = fn?.description.match(/^\[([^\]]+)\]/);
    appNames[slug] = candidate?.app.name || (match ? match[1] : slug);
  }

  yield {
    type: 'magnifying',
    text: `Loading data from ${Object.values(appNames).join(', ')}...`,
    apps: Object.values(appNames),
  };

  // Magnify: query D1 databases for each involved app
  const magnifiedData: Record<string, string> = {};
  const magnifyPromises = appIds.map(async (appId, i) => {
    const slug = appSlugs[i];
    try {
      const data = await magnifyApp(appId, userId, appScopeHints[slug]);
      magnifiedData[slug] = data.context;
      return { slug, tables: data.tableCount, rows: data.rowCount };
    } catch (err) {
      console.error(`[FLASH-BROKER] Magnification failed for ${slug}:`, err);
      magnifiedData[slug] = '(Data unavailable)';
      return { slug, tables: 0, rows: 0 };
    }
  });

  const magnifyResults = await Promise.all(magnifyPromises);
  for (const mr of magnifyResults) {
    yield { type: 'magnified', app: appNames[mr.slug] || mr.slug, tables: mr.tables, rows: mr.rows };
  }

  // ── Collect conventions for involved apps ──
  const allConventions: Array<{ appName: string; key: string; value: string }> = [];
  const seenConv = new Set<string>();
  for (const fn of Object.values(combinedFunctions)) {
    if (!involvedAppIds.has(fn.appId)) continue;
    for (const conv of fn.conventions || []) {
      if (seenConv.has(conv)) continue;
      seenConv.add(conv);
      const colonIdx = conv.indexOf(':');
      allConventions.push({
        appName: fn.appSlug,
        key: colonIdx > 0 ? conv.substring(0, colonIdx).trim() : conv,
        value: colonIdx > 0 ? conv.substring(colonIdx + 1).trim() : '',
      });
    }
  }

  // ── MODE: READ — Flash responds directly using magnified data ──
  if (mode === 'read') {
    yield { type: 'constructing', functions: [], conventionCount: allConventions.length };

    let readInput = `## User's Question\n${message}\n\n`;
    if (files?.length) readInput += buildFileContext(files);
    if (projectContext) readInput += `## Local Project Context\n${projectContext}\n\n`;
    readInput += `## Live App Data\n`;
    for (const [slug, data] of Object.entries(magnifiedData)) {
      readInput += `### ${appNames[slug] || slug}\n${data}\n\n`;
    }
    if (allConventions.length > 0) {
      readInput += `## Conventions\n`;
      for (const c of allConventions.slice(0, 10)) {
        readInput += `- [${c.appName}] ${c.key}: ${c.value}\n`;
      }
    }

    // Inject conversation context for read mode continuity
    if (summaryStr) readInput += `\n## Conversation Summary\n${summaryStr}\n`;
    if (lastExchangeStr) readInput += `\n## Last Exchange\n${lastExchangeStr}\n`;

    // Intra-conversation raw history magnification
    if (contextQuery && conversationHistory && conversationHistory.length > 0) {
      const rawContext = searchRawHistory(contextQuery, conversationHistory);
      if (rawContext) readInput += `\n## Relevant Earlier Conversation\n${rawContext}\n`;
    }

    // Cross-session context retrieval for read mode
    if (conversationSearch) {
      try {
        const { createEmbeddingService, searchConversationEmbeddings } = await import('./embedding.ts');
        const svc = createEmbeddingService();
        if (!svc) throw new Error('Embedding service unavailable');
        const { embedding } = await svc.embed(conversationSearch);
        const matches = await searchConversationEmbeddings(embedding, userId, { limit: 3, threshold: 0.55 });
        if (matches.length > 0) {
          readInput += '\n## Relevant Past Conversations\n';
          for (const m of matches) {
            readInput += `### ${m.conversation_name} (${new Date(m.created_at).toLocaleDateString()})\n${m.summary}\n\n`;
          }
        }
      } catch { /* ignore retrieval failures */ }
    }

    // Flash writes the response directly — no heavy model, plain text output
    const readSystem = systemAgentContext
      ? `You are "${systemAgentContext.persona}". ${FLASH_READ_RESPONSE_SYSTEM}`
      : FLASH_READ_RESPONSE_SYSTEM;
    const responseText = await callFlashText(flashModel, readSystem, buildMultimodalContent(readInput, files), route, {
      telemetry: flashTelemetry,
      taskId: 'flash_broker.read_response',
      schemaId: FLASH_SCHEMA_IDS.readResponse,
      inputFeatures: {
        files,
        projectContext,
        conversationHistory,
        conventionCount: allConventions.length,
        magnifiedData,
        conversationSearch,
        contextQuery,
      },
      metadata: {
        mode: 'read',
        involved_app_count: appIds.length,
      },
    })
      || "I found the data but had trouble formatting the response. Could you try rephrasing your question?";

    const result: FlashBrokerResult = {
      needsTool: false,
      directResponse: responseText,
      model: flashModel,
      prompt: '', functions: '', entities: [], conventions: allConventions.slice(0, 5),
      involvedAppIds: appIds, toolMap: {},
      usage: analyzeResult._usage,
    };
    yield { type: 'direct_response', content: responseText };
    yield { type: 'done', result };
    return;
  }

  // ── MODE: WRITE — construct prompt for Heavy model ──
  yield {
    type: 'constructing',
    functions: actionFunctions,
    conventionCount: allConventions.length,
  };

  // Build type declarations for ALL functions of involved apps
  const typeDeclLines: string[] = [];
  for (const [fnName] of Object.entries(toolMap)) {
    const fn = combinedFunctions[fnName];
    if (!fn) continue;
    const originLabel = toolMap[fnName]?.origin === 'marketplace' ? 'from marketplace' : 'from your library';
    const params = Object.entries(fn.params || {})
      .map(([p, info]) => `${p}${info.required ? '' : '?'}: ${info.type}`)
      .join(', ');
    const returns = fn.returns && fn.returns !== 'unknown' ? fn.returns : 'unknown';
    typeDeclLines.push(`  /** ${fn.description} (${originLabel}) */`);
    typeDeclLines.push(`  ${fnName}(args: { ${params} }): Promise<${returns}>;`);
  }
  const functionsDecl = typeDeclLines.length > 0
    ? `interface Codemode {\n${typeDeclLines.join('\n')}\n}`
    : '';

  // Build Flash round 2 input for prompt construction
  let promptInput = `## User's Message\n${message}\n\n`;
  if (files?.length) promptInput += buildFileContext(files);
  if (projectContext) promptInput += `## Local Project Context\n${projectContext}\n\n`;
  promptInput += `## Live App Data\n`;
  for (const [slug, data] of Object.entries(magnifiedData)) {
    promptInput += `### ${appNames[slug] || slug}\n${data}\n\n`;
  }
  promptInput += `## Available Functions\n`;
  for (const [fnName] of Object.entries(toolMap)) {
    const fn = combinedFunctions[fnName];
    if (!fn || fn.fnName === '__context') continue; // skip skill context entries
    const originLabel = toolMap[fnName]?.origin === 'marketplace' ? 'from marketplace' : 'from your library';
    const params = Object.entries(fn.params || {})
      .map(([p, info]) => `${p}${info.required ? '' : '?'}: ${info.type}`)
      .join(', ');
    const rw = isReadOnly(fnName, fn.description) ? '[READ]' : '[WRITE]';
    promptInput += `- codemode.${fnName}({ ${params} }) ${rw} [${originLabel}] — ${fn.description}\n`;
  }
  if (allConventions.length > 0) {
    promptInput += `\n## Conventions\n`;
    for (const c of allConventions.slice(0, 15)) {
      promptInput += `- [${c.appName}] ${c.key}: ${c.value}\n`;
    }
  }

  // Inject conversation context for write mode
  if (summaryStr) promptInput += `\n## Conversation Summary\n${summaryStr}\n`;
  if (lastExchangeStr) promptInput += `\n## Last Exchange\n${lastExchangeStr}\n`;

  // Intra-conversation raw history magnification for write mode
  if (contextQuery && conversationHistory && conversationHistory.length > 0) {
    const rawContext = searchRawHistory(contextQuery, conversationHistory);
    if (rawContext) promptInput += `\n## Relevant Earlier Conversation\n${rawContext}\n`;
  }

  // Flash round 2: construct the final prompt for Heavy
  const promptSystem = systemAgentContext
    ? `You are constructing a prompt for "${systemAgentContext.persona}". Include their skills and conventions in the prompt.\n\n${FLASH_PROMPT_SYSTEM}`
    : FLASH_PROMPT_SYSTEM;
  const promptResult = await callFlash(flashModel, promptSystem, buildMultimodalContent(promptInput, files), route, {
    telemetry: flashTelemetry,
    taskId: 'flash_broker.prompt_builder',
    schemaId: FLASH_SCHEMA_IDS.promptBuilder,
    inputFeatures: {
      files,
      projectContext,
      conversationHistory,
      functionCount: Object.keys(toolMap).length,
      conventionCount: allConventions.length,
      magnifiedData,
      conversationSearch,
      contextQuery,
    },
    metadata: {
      mode: 'write',
      involved_app_count: appIds.length,
      action_function_count: actionFunctions.length,
    },
  });

  let finalPrompt: string;
  let finalModel: string;
  let resolvedEntities: FlashBrokerResult['entities'] = [];
  let resolvedConventions: FlashBrokerResult['conventions'] = [];

  if (promptResult) {
    finalPrompt = promptResult.prompt || '';
    finalModel = selectInferenceModel(route, resolveModel(promptResult.model, heavyModel));
    resolvedEntities = (promptResult.entities || []).map((e: any) => ({
      name: e.name || '', type: e.type || '', id: String(e.id || ''),
      appId: e.appId || '', appName: e.appName || '', context: e.context || '',
    }));
    resolvedConventions = (promptResult.conventions || []).map((c: any) => ({
      appName: c.appName || '', key: c.key || '', value: c.value || '',
    }));
  } else {
    finalPrompt = `The user said: "${message}"\n\n`;
    for (const [slug, data] of Object.entries(magnifiedData)) {
      finalPrompt += `Data from ${slug}:\n${data}\n\n`;
    }
    finalPrompt += 'Write a codemode recipe that fulfills the user\'s request.\n';
    finalPrompt += 'Keep narration brief and focused on why the action matters.\n';
    finalPrompt += 'Do not repeat full tool arguments or raw execution results when the UI already shows them.\n';
    finalPrompt += 'Always name each tool you use; mention the origin too when it is explicitly provided.\n';
    finalModel = selectInferenceModel(route, resolveModel(analyzeResult.model, heavyModel));
  }

  yield { type: 'prompt_ready', prompt: finalPrompt.slice(0, 200) + '...', model: finalModel };

  const result: FlashBrokerResult = {
    needsTool: true,
    directResponse: '',
    model: finalModel,
    prompt: finalPrompt,
    functions: functionsDecl,
    entities: resolvedEntities,
    conventions: resolvedConventions.length > 0 ? resolvedConventions : allConventions.slice(0, 5),
    involvedAppIds: appIds,
    toolMap,
    usage: analyzeResult._usage,
    systemAgentDelegations: systemAgentDelegations.length > 0 ? systemAgentDelegations : undefined,
  };

  yield { type: 'done', result };
}

// ── Magnification: Pull live D1 data for an app ──

interface MagnifyResult {
  context: string;
  tableCount: number;
  rowCount: number;
}

/** Fetch lightweight app metadata for type checking (skill vs mcp) */
async function getAppMeta(appId: string): Promise<{ app_type: string | null; storage_key: string; name: string } | null> {
  const SUPABASE_URL = getEnv('SUPABASE_URL');
  const SUPABASE_SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/apps?id=eq.${appId}&select=app_type,storage_key,name`,
    { headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ app_type: string | null; storage_key: string; name: string }>;
  return rows[0] || null;
}

/** Magnify a skill app — fetch .md content from R2 instead of D1 */
async function magnifySkillApp(app: { storage_key: string; name: string }, scope?: string): Promise<MagnifyResult> {
  try {
    const r2 = (globalThis as any).__env?.R2_BUCKET;
    if (!r2) return { context: '(R2 not available)', tableCount: 0, rowCount: 0 };

    // List files under the app's storage key to find .md files
    const listed = await r2.list({ prefix: app.storage_key, limit: 20 });
    const mdKeys = (listed.objects || [])
      .map((o: any) => o.key as string)
      .filter((k: string) => k.endsWith('.md'));

    if (mdKeys.length === 0) {
      return { context: '(No skill content found)', tableCount: 0, rowCount: 0 };
    }

    // Read all .md files and concatenate (respect 8000 char limit)
    const MAX_CHARS = 8000;
    let content = '';
    for (const key of mdKeys) {
      const obj = await r2.get(key);
      if (!obj) continue;
      const text = await obj.text();
      if (content.length + text.length > MAX_CHARS) {
        content += text.slice(0, MAX_CHARS - content.length);
        break;
      }
      content += text + '\n\n';
    }

    return { context: content.trim(), tableCount: 0, rowCount: 0 };
  } catch (err) {
    console.error(`[MAGNIFY] Skill magnification failed for ${app.name}:`, err);
    return { context: '(Skill content unavailable)', tableCount: 0, rowCount: 0 };
  }
}

/**
 * Query an app's D1 database and return a compact context string
 * with all user-relevant data. This is the "magnification" step.
 */
async function magnifyApp(appId: string, userId: string, scope?: string): Promise<MagnifyResult> {
  // ── Skill apps: fetch .md content from R2 instead of querying D1 ──
  const appMeta = await getAppMeta(appId);
  if (appMeta?.app_type === 'skill') {
    return magnifySkillApp(appMeta, scope);
  }

  const dbId = await getD1DatabaseId(appId);
  if (!dbId) {
    return { context: '(No database provisioned)', tableCount: 0, rowCount: 0 };
  }

  const cfAccountId = getEnv('CF_ACCOUNT_ID');
  const cfApiToken = getEnv('CF_API_TOKEN');

  // Helper to query D1 via HTTP API
  async function queryD1(sql: string, params: unknown[] = []): Promise<any[]> {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/d1/database/${dbId}/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      },
    );
    if (!res.ok) return [];
    const data = await res.json() as { result?: Array<{ results?: any[] }> };
    return data.result?.[0]?.results || [];
  }

  // Extract search keywords from scope hint
  const scopeKeywords: string[] = [];
  if (scope) {
    const stopWords = new Set([
      'the','a','an','in','on','at','to','for','of','and','or','is','are',
      'was','were','from','with','about','my','their','this','that','all',
    ]);
    for (const word of scope.split(/[\s,]+/)) {
      if (word.length > 2 && !stopWords.has(word.toLowerCase())) {
        scopeKeywords.push(word);
      }
    }
  }

  // 1. Discover tables
  const tables = await queryD1("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const tableNames = tables
    .map((t: any) => t.name as string)
    .filter(name => !SKIP_TABLES.has(name) && !name.startsWith('_') && !name.startsWith('sqlite_'));

  if (tableNames.length === 0) {
    return { context: '(Empty database)', tableCount: 0, rowCount: 0 };
  }

  // 2. Sample data from each table (parallel)
  let totalRows = 0;
  let totalChars = 0;
  const sections: string[] = [];

  const samplePromises = tableNames.slice(0, 10).map(async (tableName) => {
    try {
      // Get column info
      const columns = await queryD1(`PRAGMA table_info("${tableName}")`);
      const colNames = columns.map((c: any) => c.name as string);

      let rows: any[];

      if (scopeKeywords.length > 0) {
        // Identify searchable text columns (skip IDs and timestamps)
        const textCols = colNames.filter(c =>
          !c.endsWith('_at') && !c.endsWith('_id') && c !== 'id' && c !== 'user_id' && c !== 'rowid'
        );

        if (textCols.length > 0) {
          // Build WHERE: any text column LIKE any keyword
          const conditions = scopeKeywords.flatMap(kw =>
            textCols.map(col => `"${col}" LIKE ?`)
          );
          const params = scopeKeywords.flatMap(kw =>
            textCols.map(() => `%${kw}%`)
          );

          rows = await queryD1(
            `SELECT * FROM "${tableName}" WHERE (${conditions.join(' OR ')}) ORDER BY rowid DESC LIMIT ${MAX_ROWS_PER_TABLE}`,
            params,
          );

          // Fallback: if scoped query returned too few, backfill with recent rows
          if (rows.length < 3) {
            const seenIds = new Set(rows.map((r: any) => r.id || r.rowid));
            const backfill = await queryD1(
              `SELECT * FROM "${tableName}" ORDER BY rowid DESC LIMIT ${MAX_ROWS_PER_TABLE}`,
            );
            for (const r of backfill) {
              if (!seenIds.has(r.id || r.rowid)) rows.push(r);
              if (rows.length >= MAX_ROWS_PER_TABLE) break;
            }
          }
        } else {
          // No text columns to search — fallback to recent rows
          rows = await queryD1(
            `SELECT * FROM "${tableName}" ORDER BY rowid DESC LIMIT ${MAX_ROWS_PER_TABLE}`,
          );
        }
      } else {
        // No scope — current behavior
        rows = await queryD1(
          `SELECT * FROM "${tableName}" ORDER BY rowid DESC LIMIT ${MAX_ROWS_PER_TABLE}`,
        );
      }

      return { tableName, colNames, rows };
    } catch {
      return { tableName, colNames: [], rows: [] };
    }
  });

  const samples = await Promise.all(samplePromises);

  for (const { tableName, colNames, rows } of samples) {
    if (rows.length === 0) continue;

    totalRows += rows.length;

    // Compact format: table name + column headers + rows as compact JSON
    let section = `[${tableName}] (${rows.length} rows)\n`;
    section += `Columns: ${colNames.join(', ')}\n`;

    // Compact row representation — skip large text fields
    for (const row of rows) {
      const compactRow: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 200) {
          compactRow[key] = value.slice(0, 200) + '...';
        } else {
          compactRow[key] = value;
        }
      }
      const rowStr = JSON.stringify(compactRow);
      if (totalChars + rowStr.length > MAX_CHARS_PER_APP) break;
      section += rowStr + '\n';
      totalChars += rowStr.length;
    }

    sections.push(section);
    if (totalChars > MAX_CHARS_PER_APP) break;
  }

  // Relationship expansion: follow FK columns one level deep when scoped
  if (scopeKeywords.length > 0 && totalChars < MAX_CHARS_PER_APP) {
    for (const { tableName, colNames, rows } of samples) {
      if (rows.length === 0 || totalChars >= MAX_CHARS_PER_APP) continue;

      const fkCols = colNames.filter(c => c.endsWith('_id') && c !== 'id' && c !== 'user_id');
      for (const fkCol of fkCols) {
        if (totalChars >= MAX_CHARS_PER_APP) break;

        // Infer target table: world_id → worlds, character_a_id → characters
        const base = fkCol.replace(/_id$/, '').replace(/_[a-z]$/, '');
        const targetTable = tableNames.find(t => t === base + 's' || t === base + 'es' || t === base);
        if (!targetTable) continue;

        // Skip if we already sampled this table with results
        if (samples.some(s => s.tableName === targetTable && s.rows.length > 0)) continue;

        const ids = [...new Set(rows.map((r: any) => r[fkCol]).filter(Boolean))].slice(0, 10);
        if (ids.length === 0) continue;

        try {
          const placeholders = ids.map(() => '?').join(',');
          const related = await queryD1(
            `SELECT * FROM "${targetTable}" WHERE id IN (${placeholders}) LIMIT 10`,
            ids,
          );
          if (related.length === 0) continue;

          let section = `[${targetTable}] (${related.length} related rows)\n`;
          const relCols = await queryD1(`PRAGMA table_info("${targetTable}")`);
          section += `Columns: ${relCols.map((c: any) => c.name).join(', ')}\n`;

          for (const row of related) {
            const compact: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
              compact[key] = typeof value === 'string' && value.length > 200
                ? value.slice(0, 200) + '...' : value;
            }
            const rowStr = JSON.stringify(compact);
            if (totalChars + rowStr.length > MAX_CHARS_PER_APP) break;
            section += rowStr + '\n';
            totalChars += rowStr.length;
            totalRows++;
          }
          sections.push(section);
        } catch { /* skip failed FK expansions */ }
      }
    }
  }

  return {
    context: sections.join('\n'),
    tableCount: tableNames.length,
    rowCount: totalRows,
  };
}

// ── Flash API Call ──

type FlashMessage = { role: 'system' | 'user'; content: unknown };

function createFlashTelemetrySession(
  route: ResolvedInferenceRoute,
  model: string,
  messages: FlashMessage[],
  requestParams: Record<string, unknown>,
  options?: FlashCallOptions,
) {
  if (!options?.telemetry || !options.taskId) return null;

  const metadata = buildFlashInvocationMetadata({
    taskId: options.taskId,
    schemaId: options.schemaId,
    capabilities: options.capabilities,
    inputFeatures: options.inputFeatures,
    metadata: {
      ...(options.metadata || {}),
      route: {
        provider: route.provider,
        upstream_provider: route.upstreamProvider,
        billing_mode: route.billingMode,
        billing_source: route.billingSource,
        key_source: route.keySource,
        canonical_model_id: route.canonicalModelId || null,
        billing_model_id: route.billingModelId || null,
      },
    },
  });

  return createLlmInvocationTelemetrySession({
    userId: options.telemetry.userId,
    userEmail: options.telemetry.userEmail,
    invocationId: `${options.telemetry.traceId}:${options.taskId}:${crypto.randomUUID()}`,
    traceId: options.telemetry.traceId,
    conversationId: options.telemetry.conversationId,
    source: options.telemetry.source,
    phase: options.taskId,
    provider: route.provider,
    requestedModel: model,
    resolvedModel: model,
    billingMode: route.billingMode,
    keySource: route.keySource,
    requestParams,
    messages,
    metadata,
  });
}

function buildJsonOutputLabels(taskId: FlashTaskId | undefined, output: unknown, parseSuccess: boolean): Record<string, unknown> {
  if (taskId === 'flash_broker.analyze') {
    return buildAnalyzeOutputLabels(output, { parseSuccess });
  }
  if (taskId === 'flash_broker.prompt_builder') {
    return buildPromptBuilderOutputLabels(output, { parseSuccess });
  }
  return { parse_success: parseSuccess };
}

function buildTextOutputLabels(taskId: FlashTaskId | undefined, text: string, options?: FlashCallOptions): Record<string, unknown> {
  if (taskId === 'orchestrate.execution_confirmation') {
    return buildExecutionConfirmationOutputLabels(text, {
      executionResultAvailable: options?.metadata?.execution_result_available === true,
    });
  }
  return buildReadResponseOutputLabels(text);
}

function stripInternalUsage(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy._usage;
  return copy;
}

async function callFlash(
  model: string,
  systemPrompt: string,
  userContent: string | unknown[],
  route: ResolvedInferenceRoute,
  options?: FlashCallOptions,
): Promise<any | null> {
  const messages: FlashMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const requestParams = {
    temperature: 0,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  };
  const llmTelemetry = createFlashTelemetrySession(route, model, messages, requestParams, options);
  llmTelemetry?.start();

  try {
    const response = await fetchInferenceChatCompletion(
      route,
      {
        model,
        messages,
        ...requestParams,
      },
      {
        title: 'Ultralight Flash Broker',
        referer: 'https://ultralight-api.rgn4jz429m.workers.dev',
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[FLASH-BROKER] Flash failed: ${response.status}`);
      const outputLabels = buildJsonOutputLabels(options?.taskId, null, false);
      await llmTelemetry?.finish({
        status: 'error',
        errorType: 'provider_error',
        errorMessage: `Flash failed: ${response.status}`,
        metadata: {
          output_labels: outputLabels,
          parse_success: false,
          http_status: response.status,
        },
        responseSnapshot: {
          value: {
            ok: false,
            http_status: response.status,
            body_preview: detail.slice(0, 4000),
          },
          metadata: {
            output_labels: outputLabels,
            parse_success: false,
          },
        },
      });
      return null;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string }; finish_reason?: string | null }>;
      usage?: object;
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      const outputLabels = buildJsonOutputLabels(options?.taskId, null, false);
      await llmTelemetry?.finish({
        status: 'error',
        finishReason: data.choices?.[0]?.finish_reason || null,
        usage: data.usage,
        errorType: 'empty_response',
        errorMessage: 'Flash returned no message content',
        metadata: {
          output_labels: outputLabels,
          parse_success: false,
        },
        responseSnapshot: {
          value: {
            raw_response: data,
          },
          metadata: {
            output_labels: outputLabels,
            parse_success: false,
          },
        },
      });
      return null;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      const outputLabels = buildJsonOutputLabels(options?.taskId, null, false);
      await llmTelemetry?.finish({
        status: 'error',
        finishReason: data.choices?.[0]?.finish_reason || null,
        usage: data.usage,
        errorType: 'json_parse_error',
        errorMessage: err instanceof Error ? err.message : String(err),
        metadata: {
          output_labels: outputLabels,
          parse_success: false,
        },
        responseSnapshot: {
          value: {
            raw_content: content,
            usage: data.usage || null,
          },
          metadata: {
            output_labels: outputLabels,
            parse_success: false,
          },
        },
      });
      return null;
    }
    parsed._usage = data.usage || undefined;
    const outputLabels = buildJsonOutputLabels(options?.taskId, parsed, true);
    await llmTelemetry?.finish({
      status: 'success',
      finishReason: data.choices?.[0]?.finish_reason || null,
      usage: data.usage,
      metadata: {
        output_labels: outputLabels,
        parse_success: true,
      },
      responseSnapshot: {
        value: {
          raw_content: content,
          parsed_output: stripInternalUsage(parsed),
          usage: data.usage || null,
        },
        metadata: {
          output_labels: outputLabels,
          parse_success: true,
        },
      },
    });
    return parsed;
  } catch (err) {
    console.error('[FLASH-BROKER] Flash error:', err);
    const outputLabels = buildJsonOutputLabels(options?.taskId, null, false);
    await llmTelemetry?.finish({
      status: 'error',
      errorType: 'exception',
      errorMessage: err instanceof Error ? err.message : String(err),
      metadata: {
        output_labels: outputLabels,
        parse_success: false,
      },
      responseSnapshot: {
        value: {
          error: err instanceof Error ? err.message : String(err),
        },
        metadata: {
          output_labels: outputLabels,
          parse_success: false,
        },
      },
    });
    return null;
  }
}

/**
 * Call Flash and return plain text (not JSON). Used for read responses and confirmations.
 */
export async function callFlashText(
  model: string,
  systemPrompt: string,
  userContent: string | unknown[],
  route: ResolvedInferenceRoute,
  options?: FlashCallOptions,
): Promise<string> {
  const messages: FlashMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const requestParams = {
    temperature: 0.3,
    max_tokens: 2048,
  };
  const llmTelemetry = createFlashTelemetrySession(route, model, messages, requestParams, options);
  llmTelemetry?.start();

  try {
    const response = await fetchInferenceChatCompletion(
      route,
      {
        model,
        messages,
        ...requestParams,
        // No response_format — plain text output
      },
      {
        title: 'Ultralight Flash Broker',
        referer: 'https://ultralight-api.rgn4jz429m.workers.dev',
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`[FLASH-BROKER] Flash text call failed: ${response.status}`);
      const outputLabels = buildTextOutputLabels(options?.taskId, '', options);
      await llmTelemetry?.finish({
        status: 'error',
        errorType: 'provider_error',
        errorMessage: `Flash text call failed: ${response.status}`,
        metadata: {
          output_labels: outputLabels,
          http_status: response.status,
        },
        responseSnapshot: {
          value: {
            ok: false,
            http_status: response.status,
            body_preview: detail.slice(0, 4000),
          },
          metadata: {
            output_labels: outputLabels,
          },
        },
      });
      return '';
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string }; finish_reason?: string | null }>;
      usage?: object;
    };

    const content = data.choices?.[0]?.message?.content || '';
    const outputLabels = buildTextOutputLabels(options?.taskId, content, options);
    await llmTelemetry?.finish({
      status: 'success',
      finishReason: data.choices?.[0]?.finish_reason || null,
      usage: data.usage,
      metadata: {
        output_labels: outputLabels,
      },
      responseSnapshot: {
        value: {
          raw_content: content,
          usage: data.usage || null,
        },
        metadata: {
          output_labels: outputLabels,
        },
      },
    });
    return content;
  } catch (err) {
    console.error('[FLASH-BROKER] Flash text error:', err);
    const outputLabels = buildTextOutputLabels(options?.taskId, '', options);
    await llmTelemetry?.finish({
      status: 'error',
      errorType: 'exception',
      errorMessage: err instanceof Error ? err.message : String(err),
      metadata: {
        output_labels: outputLabels,
      },
      responseSnapshot: {
        value: {
          error: err instanceof Error ? err.message : String(err),
        },
        metadata: {
          output_labels: outputLabels,
        },
      },
    });
    return '';
  }
}

// ── Catalog Builder (Stage 1 — functions + conventions only, no data) ──

function buildCatalog(
  fnIndex: FunctionIndex,
  systemAgentStates?: SystemAgentState[],
  marketplaceCandidates: MarketplaceCandidate[] = [],
): string {
  const sections: string[] = [];

  // Group functions by app
  const appFns: Record<string, Array<{ name: string; fn: FunctionIndex['functions'][string] }>> = {};
  for (const [name, fn] of Object.entries(fnIndex.functions)) {
    if (!appFns[fn.appSlug]) appFns[fn.appSlug] = [];
    appFns[fn.appSlug].push({ name, fn });
  }

  for (const [slug, fns] of Object.entries(appFns)) {
    // Skill entries — show as available context, not callable functions
    if (fns.length === 1 && fns[0].fn.fnName === '__context') {
      const desc = fns[0].fn.description.replace(/^\[[^\]]+\]\s*/, '');
      sections.push(`\n### [saved] ${slug} [SKILL/CONTEXT] — ${desc}`);
      continue;
    }

    const appDesc = fns[0]?.fn.description?.match(/^\[([^\]]+)\]/)?.[1] || slug;
    sections.push(`\n### [saved] ${slug} (${appDesc})`);
    for (const { name, fn } of fns) {
      if (fn.fnName === '__context') continue; // skip skill entries mixed in
      const params = Object.entries(fn.params || {})
        .map(([p, info]) => `${p}${info.required ? '' : '?'}: ${info.type}`)
        .join(', ');
      const returns = fn.returns && fn.returns !== 'unknown' ? ` -> ${fn.returns}` : '';
      const rw = isReadOnly(name, fn.description) ? ' [READ]' : ' [WRITE]';
      // Strip the [appName] prefix from description since we're grouping by app
      const desc = fn.description.replace(/^\[[^\]]+\]\s*/, '');
      sections.push(`- ${name}(${params})${returns}${rw} — ${desc}`);
    }

    // Add conventions for this app (deduplicated)
    const convs = new Set<string>();
    for (const { fn } of fns) {
      for (const c of fn.conventions || []) {
        if (c.length > 3 && c.length < 120) convs.add(c);
      }
    }
    if (convs.size > 0) {
      const convList = [...convs].slice(0, 5);
      sections.push(`  Conventions: ${convList.join('; ')}`);
    }
  }

  const commandCards = flattenCommandSurfaceInventory(fnIndex, {
    surfaces: ['command_card'],
    limit: 24,
  }).surfaces;
  if (commandCards.length > 0) {
    sections.push('\n## Command Dashboard Surfaces\nInstalled read-only cards available for Command dashboards:');
    for (const surface of commandCards) {
      if (surface.surface !== 'command_card') continue;
      const bits = [
        `${surface.size}`,
        surface.kind,
        surface.data_view ? `view:${surface.data_view}` : null,
      ].filter(Boolean).join(', ');
      sections.push(
        `- ${surface.app_slug}/${surface.widget_id}/${surface.card_id} (${surface.card_label}) [${bits}] — ${
          surface.description || surface.widget_label
        }`
      );
    }
  }

  // System Agents section — allows Flash to recommend delegations
  if (systemAgentStates && systemAgentStates.length > 0) {
    sections.push('\n## System Agents\nSpecialized agents you can delegate tasks to:');
    for (const sa of systemAgentStates) {
      let line = `- **${sa.name}** (${sa.type}): ${sa.tools.join(', ')}`;
      if (sa.stateSummary) line += ` | State: ${sa.stateSummary.slice(0, 200)}`;
      sections.push(line);
    }
  }

  if (marketplaceCandidates.length > 0) {
    sections.push('\n## Marketplace candidates (not yet in your library)');
    for (const candidate of marketplaceCandidates) {
      const description = candidate.app.description || 'No description available';
      const keyFns = candidate.keyFunctions.length > 0
        ? ` — key_functions: ${candidate.keyFunctions.join(', ')}`
        : '';
      sections.push(
        `- [marketplace] ${candidate.app.slug} (${candidate.app.name}) — ${description}${keyFns}`
      );
    }
  }

  return sections.join('\n');
}

function buildProvisionalFunctionEntries(
  marketplaceCandidates: MarketplaceCandidate[],
): FunctionIndex['functions'] {
  const apps: AppForCodemode[] = marketplaceCandidates
    .map((candidate) => {
      if (!candidate.app.manifest) return null;
      try {
        const manifest = typeof candidate.app.manifest === 'string'
          ? JSON.parse(candidate.app.manifest) as AppForCodemode['manifest']
          : candidate.app.manifest as AppForCodemode['manifest'];
        return {
          id: candidate.app.id,
          name: candidate.app.name,
          slug: candidate.app.slug,
          manifest,
        } satisfies AppForCodemode;
      } catch {
        return null;
      }
    })
    .filter((app): app is AppForCodemode => !!app);

  if (apps.length === 0) return {};

  const { descriptors, toolMap } = buildJsonSchemaDescriptors(apps);
  const functions: FunctionIndex['functions'] = {};

  for (const [sanitizedName, mapping] of Object.entries(toolMap)) {
    const descriptor = descriptors[sanitizedName];
    const params: FunctionEntry['params'] = {};
    const properties = descriptor?.inputSchema?.properties || {};
    const required = new Set(descriptor?.inputSchema?.required || []);

    for (const [paramName, schema] of Object.entries(properties)) {
      const typedSchema = schema as { type?: string; description?: string };
      params[paramName] = {
        type: typedSchema.type || 'unknown',
        required: required.has(paramName),
        description: typedSchema.description,
      };
    }

    functions[sanitizedName] = {
      appId: mapping.appId,
      appSlug: mapping.appSlug,
      fnName: mapping.fnName,
      description: descriptor?.description || `[${mapping.appName}] ${mapping.fnName}`,
      params,
      returns: 'unknown',
      conventions: [],
      dependsOn: [],
    };
  }

  return functions;
}

function extractAppNameFromDescription(description: string, fallbackSlug: string): string {
  const match = description.match(/^\[([^\]]+)\]/);
  return match ? match[1] : fallbackSlug;
}

async function retrieveMarketplaceCandidates(
  userMessage: string,
  conversationSummary: string,
  userId: string,
  fnIndex: FunctionIndex,
  limit = 8,
): Promise<MarketplaceCandidate[]> {
  const embedding = createEmbeddingService();
  if (!embedding) return [];

  const savedAppIds = new Set(Object.values(fnIndex.functions).map((fn) => fn.appId));
  const savedAppSlugs = new Set(Object.values(fnIndex.functions).map((fn) => fn.appSlug));
  const query = [userMessage, conversationSummary].filter(Boolean).join('\n\n').slice(0, 2000);

  try {
    const { embedding: vec } = await embedding.embed(query);
    const appsService = createAppsService();
    const matches = await appsService.searchByEmbedding(vec, userId, false, limit * 2, 0.6);

    return matches
      .filter((app) => app.app_type !== 'skill')
      .filter((app) => !savedAppIds.has(app.id) && !savedAppSlugs.has(app.slug))
      .slice(0, limit)
      .map((app) => ({
        app: {
          id: app.id,
          name: app.name,
          slug: app.slug,
          description: app.description,
          icon_url: app.icon_url,
          runtime: app.runtime,
          manifest: app.manifest,
          exports: app.exports,
          owner_id: app.owner_id,
          app_type: app.app_type,
          current_version: app.current_version,
          version_metadata: app.version_metadata,
          visibility: app.visibility,
          download_access: app.download_access,
          env_schema: app.env_schema,
        },
        similarity: app.similarity,
        keyFunctions: extractMarketplaceKeyFunctions(app),
      }));
  } catch (err) {
    console.warn('[FLASH-BROKER] Marketplace retrieval failed:', err);
    return [];
  }
}

function extractMarketplaceKeyFunctions(app: Pick<App, 'manifest' | 'exports'>): string[] {
  const fnNames = new Set<string>();

  if (app.manifest) {
    try {
      const manifest = typeof app.manifest === 'string'
        ? JSON.parse(app.manifest) as { functions?: Record<string, unknown> }
        : app.manifest as { functions?: Record<string, unknown> };

      for (const fnName of Object.keys(manifest?.functions || {})) {
        if (fnName.startsWith('widget_')) continue;
        fnNames.add(fnName);
        if (fnNames.size >= 4) break;
      }
    } catch {
      // Ignore malformed manifests — exports fallback covers this.
    }
  }

  for (const fnName of app.exports || []) {
    if (fnName.startsWith('widget_')) continue;
    fnNames.add(fnName);
    if (fnNames.size >= 4) break;
  }

  return [...fnNames];
}

// ── Helpers ──

function isReadOnly(fnName: string, description: string): boolean {
  const writePatterns = /create|update|delete|remove|add|set|send|approve|reject|revise|act|store|save|insert|modify|post|put|generate|receive/i;
  const readPatterns = /list|get|search|query|browse|count|check|view|show|find|fetch|read|load|inspect|history|context/i;
  if (writePatterns.test(fnName) || writePatterns.test(description)) return false;
  if (readPatterns.test(fnName) || readPatterns.test(description)) return true;
  return true;
}

function resolveModel(flashSuggestion: string, userPreference?: string): string {
  if (userPreference) return userPreference;
  if (flashSuggestion === 'sonnet') return DEFAULT_HEAVY_SONNET;
  if (flashSuggestion === 'flash') return DEFAULT_HEAVY_FLASH;
  if (flashSuggestion && flashSuggestion.includes('/')) return flashSuggestion;
  return DEFAULT_HEAVY_SONNET;
}

async function loadConversationTopics(userId: string): Promise<string> {
  try {
    const env = getEnv();
    const kv = env.FN_INDEX;
    if (!kv) return '';
    const data = await kv.get(`conversation-topics:${userId}`, 'json') as {
      count: number;
      recent: Array<{ id: string; name: string; timestamp: number; entities: string[] }>;
    } | null;
    if (!data?.recent?.length) return '';
    let hint = `${data.count} past conversations. Recent:\n`;
    for (const r of data.recent) {
      const date = new Date(r.timestamp).toLocaleDateString();
      hint += `- "${r.name}" (${date})${r.entities?.length ? ': ' + r.entities.join(', ') : ''}\n`;
    }
    return hint;
  } catch {
    return '';
  }
}

async function loadConversationSummary(conversationId?: string): Promise<ConversationSummary | null> {
  if (!conversationId) return null;
  try {
    const env = getEnv();
    const kv = env.FN_INDEX;
    if (!kv) return null;
    return await kv.get(`convo-summary:${conversationId}`, 'json') as ConversationSummary | null;
  } catch {
    return null;
  }
}

function searchRawHistory(
  query: string,
  history: Array<{ role: string; content: string }>,
): string {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return '';
  const scored: Array<{ score: number; text: string }> = [];
  for (let i = 0; i < history.length; i++) {
    const content = history[i].content.toLowerCase();
    const score = terms.filter(t => content.includes(t)).length;
    if (score > 0) {
      scored.push({ score, text: `${history[i].role}: ${history[i].content}` });
    }
  }
  const top = scored.sort((a, b) => b.score - a.score).slice(0, 5);
  let result = top.map(m => m.text).join('\n---\n');
  return result.length > 2500 ? result.slice(0, 2500) + '\n...(truncated)' : result;
}

async function loadSystemAgentSkills(agentType: string): Promise<string> {
  try {
    const r2 = createR2Service();
    const text = await r2.fetchTextFile(`system-agents/${agentType}/skills.md`);
    return text.length > 10000 ? text.substring(0, 10000) + '...' : text;
  } catch {
    return '';
  }
}

async function loadSystemAgentStates(userId: string): Promise<SystemAgentState[]> {
  try {
    const env = getEnv();
    const kv = env.FN_INDEX;
    if (!kv) return [];
    const data = await kv.get(`system-agents:${userId}`, 'json');
    return Array.isArray(data) ? data as SystemAgentState[] : [];
  } catch {
    return [];
  }
}


// ── Heuristic Fallback ──

function heuristicFallback(
  message: string,
  fnIndex: FunctionIndex,
  preferredModel?: string,
): FlashBrokerResult {
  const msgLower = message.toLowerCase();
  const words = msgLower.split(/\s+/);

  const greetings = ['hi', 'hello', 'hey', 'sup', 'yo', 'howdy'];
  if (words.length <= 3 && words.some(w => greetings.includes(w))) {
    return {
      needsTool: false,
      directResponse: 'Hey! How can I help you today?',
      model: preferredModel || DEFAULT_HEAVY_FLASH,
      prompt: '', functions: '', entities: [], conventions: [],
      involvedAppIds: [], toolMap: {},
    };
  }

  // Match functions by keyword overlap
  const scored: Array<{ name: string; fn: FunctionIndex['functions'][string]; score: number }> = [];
  for (const [name, fn] of Object.entries(fnIndex.functions)) {
    const descLower = fn.description.toLowerCase();
    const nameLower = name.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (word.length < 3) continue;
      if (nameLower.includes(word)) score += 3;
      if (descLower.includes(word)) score += 2;
    }
    if (score > 0) scored.push({ name, fn, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const topFunctions = scored.slice(0, 5);

  if (topFunctions.length === 0) {
    return {
      needsTool: false,
      directResponse: "I'm not sure how to help with that. Could you be more specific?",
      model: preferredModel || DEFAULT_HEAVY_FLASH,
      prompt: '', functions: '', entities: [], conventions: [],
      involvedAppIds: [], toolMap: {},
    };
  }

  const toolMap: FlashBrokerResult['toolMap'] = {};
  const involvedAppIds = new Set<string>();
  const typeDeclLines: string[] = [];

  for (const { name, fn } of topFunctions) {
    toolMap[name] = {
      appId: fn.appId,
      appName: extractAppNameFromDescription(fn.description, fn.appSlug),
      fnName: fn.fnName,
      appSlug: fn.appSlug,
      origin: 'library',
    };
    involvedAppIds.add(fn.appId);
    const params = Object.entries(fn.params || {})
      .map(([p, info]) => `${p}${info.required ? '' : '?'}: ${info.type}`)
      .join(', ');
    const returns = fn.returns && fn.returns !== 'unknown' ? fn.returns : 'unknown';
    typeDeclLines.push(`  /** ${fn.description} */`);
    typeDeclLines.push(`  ${name}(args: { ${params} }): Promise<${returns}>;`);
  }

  const fnList = topFunctions.map(f => `- codemode.${f.name}(): ${f.fn.description}`).join('\n');

  return {
    needsTool: true,
    directResponse: '',
    model: preferredModel || DEFAULT_HEAVY_FLASH,
    prompt: `The user said: "${message}"\n\nAvailable functions:\n${fnList}\n\nWrite a codemode recipe.`,
    functions: `interface Codemode {\n${typeDeclLines.join('\n')}\n}`,
    entities: [], conventions: [],
    involvedAppIds: [...involvedAppIds],
    toolMap,
  };
}
