// MCP (Model Context Protocol) Handler
// Implements JSON-RPC 2.0 protocol for tool discovery and execution
// Spec: https://modelcontextprotocol.io/specification/draft/server/tools

import { error, json } from "./response.ts";
import { createAppsService } from "../services/apps.ts";
import {
  createAppDataService,
  createWorkerAppDataService,
} from "../services/appdata.ts";
import { createMeteredAppDataService } from "../services/appdata-metered.ts";
import { checkRateLimit } from "../services/ratelimit.ts";
import { checkAndIncrementWeeklyCalls } from "../services/weekly-calls.ts";
import {
  checkProvisionalDailyLimit,
  updateLastActive,
} from "../services/provisional.ts";
import { getPermissionsForUser } from "./user.ts";
import type { Tier } from "../../shared/contracts/runtime.ts";
import { type UserContext } from "../runtime/sandbox.ts";
import { isolateReuseEligibility } from "../runtime/isolate-reuse-eligibility.ts";
import {
  createRuntimeAIContext,
  createUnavailableAIService,
} from "../services/runtime-ai.ts";
import { resolveFunctionInferenceOverride } from "../services/function-inference-overrides.ts";
import { getPermissionCache } from "../services/permission-cache.ts";
import { resolveInternalMcpCall } from "../services/internal-mcp.ts";
import {
  createMemoryService,
  type MemoryService as MemoryServiceImpl,
} from "../services/memory.ts";
import {
  findPermissionRowForFunction,
  getMcpFunctionNameAliases,
  permissionSetAllowsFunction,
  toRawMcpFunctionName,
} from "../services/mcp-function-names.ts";
import {
  isFreeModeEnabled,
  isFunctionBlockedInFreeMode,
} from "../services/free-mode.ts";
import { peekCallerUsage } from "../services/cloud-usage.ts";
import { executeGpuFunction } from "../services/gpu/executor.ts";
import { acquireGpuSlot } from "../services/gpu/concurrency.ts";
import {
  buildGpuNotReadyMessage,
  buildGpuStatusDiagnostics,
} from "../services/gpu/status.ts";
import {
  getGpuSupportDisabledMessage,
  isGpuSupportEnabled,
} from "../services/gpu/feature-flag.ts";
import {
  createRuntimeOperationMeteringContext,
  debitWidgetPullUsage,
  preflightRuntimeCloudHold,
  settleAndLogAppExecution,
  settleAndLogGpuExecution,
  settleRuntimeCloudPreflight,
} from "../services/execution-settlement.ts";
import {
  type AgenticSurfaceActionCallMetadata,
  createExecutionReceiptId,
  type WidgetActionCallMetadata,
} from "../services/call-logger.ts";
import {
  AppContractMigrationRequiredError,
  logAppContractResolution,
  requireManifestFunctionContracts,
  resolveAppFunctionContracts,
} from "../services/app-contracts.ts";
import {
  buildMissingAppSecretsErrorDetails,
  buildMissingAppSecretsMessage,
  createAppD1Resources,
  MAX_ASYNC_EXECUTION_MS,
  resolveAppRuntimeEnvVars,
  resolveAppSupabaseConfig,
  resolveFunctionExecutionPolicy,
  resolveRuntimeAppCallDependencies,
  resolveStrictManifestPermissions,
  SupabaseConfigMigrationRequiredError,
} from "../services/app-runtime-resources.ts";
import { getManifestAllowedDestinations } from "../services/trust.ts";
import {
  ANONYMOUS_USER_ID,
  callerHasAppAccess,
  callerHasFunctionAccess,
  callerHasRequiredScope,
  callerUsesApiToken,
  callerUsesRoutineActorToken,
  callerUsesSandboxActorToken,
  type RequestCallerContext,
  resolveRequestCallerContext,
  deriveCallerEconomicState,
} from "../services/request-caller-context.ts";
import {
  type RoutineTraceContext,
  routineTraceContextFromCaller,
} from "../services/routine-trace.ts";
import {
  createPendingGrantRequest,
  recordGrantSpend,
  resolveCallerGrant,
  resolveCallerGrantBindings,
} from "../services/agent-grants.ts";
import {
  mintCallerContextToken,
  verifyCallerContextToken,
} from "../services/agent-caller-context.ts";
import {
  AGENT_CALLER_CONTEXT_HEADER,
  MAX_AGENT_CALL_HOP_DEPTH,
} from "../../shared/contracts/agent-grants.ts";
import type {
  MCPContent,
  MCPJsonSchema,
  MCPResourceContent,
  MCPResourceDescriptor,
  MCPServerInfo,
  MCPTool,
  MCPToolCallRequest,
  MCPToolCallResponse,
  MCPToolsListResponse,
} from "../../shared/contracts/mcp.ts";
import type { AppManifest } from "../../shared/contracts/manifest.ts";
import {
  manifestToMCPTools,
  parseManifestCallRateLimit,
} from "../../shared/contracts/manifest.ts";
import type {
  AIContentPart,
  AIRequest,
  AIResponse,
} from "../../shared/contracts/ai.ts";
import type { WidgetAppResponse } from "../../shared/contracts/widget.ts";
import type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../shared/contracts/jsonrpc.ts";
import { normalizeJsonRpcResponseId } from "../../shared/contracts/jsonrpc.ts";
import type { App, BYOKProvider } from "../../shared/types/index.ts";
import { getEnv, getExecQueue } from "../lib/env.ts";
import {
  buildCallerPermissionConfigureUrl,
  enforceCallerFunctionPermission,
} from "../services/caller-function-permissions.ts";
import { emptyHealth, getAppHealth, isRecentlyHealthy } from "../services/app-health.ts";

// ============================================
// MEMORY SERVICE (lazy singleton)
// ============================================

let _memoryService: MemoryServiceImpl | null = null;
function getMemoryService(): MemoryServiceImpl | null {
  if (!_memoryService) {
    try {
      _memoryService = createMemoryService();
    } catch (err) {
      console.error("Failed to create MemoryService:", err);
    }
  }
  return _memoryService;
}

function requestBaseUrl(request: Request): string {
  const configured = getEnv("BASE_URL");
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  const proto = request.headers.get("x-forwarded-proto") ||
    (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function appDisplayName(app: App): string {
  return app.name || app.slug || app.id;
}

// Skills.md is the auto-generated function documentation. Resource listing,
// counts, skills.json, and resources/read must all agree, so this keys
// strictly on generated content being present — app_type='skill' apps
// without generated docs advertise nothing (their content ships through the
// skills_index/skill_reader function convention instead).
function hasSkillContext(app: App): boolean {
  return Boolean(app.skills_md?.trim());
}

function buildSkillsDiscoveryPayload(
  app: App,
  appId: string,
): Record<string, unknown> {
  return {
    app_id: appId,
    app_name: appDisplayName(app),
    description: app.description,
    skills_md_resource_uri: `galactic://app/${appId}/skills.md`,
    note:
      "Full skill documentation can be read for free from the skills.md resource.",
  };
}

// ============================================
// KV INDEX HELPERS (fire-and-forget content table upserts for search)
// ============================================

/**
 * Upsert a content row for an app KV entry with NULL embedding.
 * The background embedding processor fills the embedding later.
 */
async function indexAppKV(
  appId: string,
  appOwnerId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  const embeddingText = typeof value === "string"
    ? value
    : JSON.stringify(value);
  // Skip very large values to prevent content table bloat
  if (embeddingText.length > 50_000) return;

  const slug = `${appId}/${key}`;
  const row = {
    owner_id: appOwnerId,
    type: "app_kv",
    slug: slug,
    title: key,
    description: `App data: ${key}`,
    visibility: "private",
    size: new TextEncoder().encode(embeddingText).length,
    embedding_text: embeddingText.split(/\s+/).slice(0, 6000).join(" "),
    embedding: null,
    updated_at: new Date().toISOString(),
  };

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/content?on_conflict=owner_id,type,slug`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify(row),
    },
  );
  if (!res.ok) {
    console.error("[KV-INDEX] Content upsert failed:", await res.text());
  }
}

/**
 * Upsert a content row for a user KV entry with NULL embedding.
 */
async function indexUserKV(
  userId: string,
  scope: string,
  key: string,
  value: unknown,
): Promise<void> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  const embeddingText = typeof value === "string"
    ? value
    : JSON.stringify(value);
  if (embeddingText.length > 50_000) return;

  const slug = `${scope}/${key}`;
  const row = {
    owner_id: userId,
    type: "user_kv",
    slug: slug,
    title: key,
    description: `User data: ${scope}/${key}`,
    visibility: "private",
    size: new TextEncoder().encode(embeddingText).length,
    embedding_text: embeddingText.split(/\s+/).slice(0, 6000).join(" "),
    embedding: null,
    updated_at: new Date().toISOString(),
  };

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/content?on_conflict=owner_id,type,slug`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify(row),
    },
  );
  if (!res.ok) {
    console.error(
      "[KV-INDEX] User KV content upsert failed:",
      await res.text(),
    );
  }
}

/**
 * Delete a content index row for a removed KV entry.
 */
async function removeKVIndex(
  ownerId: string,
  type: string,
  slug: string,
): Promise<void> {
  const SUPABASE_URL = getEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  await fetch(
    `${SUPABASE_URL}/rest/v1/content?owner_id=eq.${ownerId}&type=eq.${type}&slug=eq.${
      encodeURIComponent(slug)
    }`,
    {
      method: "DELETE",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "return=minimal",
      },
    },
  );
}

function toTier(value: string): Tier {
  return value === "free" ||
      value === "fun" ||
      value === "pro" ||
      value === "scale" ||
      value === "enterprise"
    ? value
    : "free";
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function isAiContentPartArray(value: unknown): value is AIContentPart[] {
  return Array.isArray(value) && value.every((part) => {
    if (!part || typeof part !== "object") {
      return false;
    }
    const candidate = part as Record<string, unknown>;
    if (candidate.type === "text") {
      return typeof candidate.text === "string";
    }
    if (candidate.type === "file") {
      return typeof candidate.data === "string";
    }
    return false;
  });
}

function isWidgetAppResponse(value: unknown): value is WidgetAppResponse {
  return typeof value === "object" &&
    value !== null &&
    "app_html" in value &&
    typeof (value as { app_html?: unknown }).app_html === "string";
}

function toAiMessages(value: unknown): AIRequest["messages"] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const messages: AIRequest["messages"] = [];
  for (const message of value) {
    if (!message || typeof message !== "object") {
      return null;
    }

    const candidate = message as Record<string, unknown>;
    if (
      candidate.role !== "system" && candidate.role !== "user" &&
      candidate.role !== "assistant"
    ) {
      return null;
    }

    const content = candidate.content;
    if (typeof content !== "string" && !isAiContentPartArray(content)) {
      return null;
    }

    messages.push({
      role: candidate.role,
      content,
      ...(candidate.cache_control &&
          typeof candidate.cache_control === "object" &&
          (candidate.cache_control as Record<string, unknown>).type ===
            "ephemeral"
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    });
  }

  return messages;
}

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const AUTH_REQUIRED = -32001;
const NOT_FOUND = -32002;
const RATE_LIMITED = -32000;
const PAYMENT_REQUIRED = -32004;

// Session sequence counters — tracks call order within a session.
// Key: sessionId → next sequence number. Auto-expires after 1 hour.
const sessionSequences = new Map<string, { seq: number; lastUsed: number }>();

function nextSequenceNumber(sessionId: string | undefined): number | undefined {
  if (!sessionId) return undefined;
  const now = Date.now();
  const entry = sessionSequences.get(sessionId);
  const seq = entry ? entry.seq + 1 : 1;
  sessionSequences.set(sessionId, { seq, lastUsed: now });
  // Lazy cleanup: purge stale sessions every 100 calls
  if (sessionSequences.size > 100 && Math.random() < 0.1) {
    const cutoff = now - 3_600_000; // 1 hour
    for (const [k, v] of sessionSequences) {
      if (v.lastUsed < cutoff) sessionSequences.delete(k);
    }
  }
  return seq;
}

// ============================================
// SDK TOOLS DEFINITIONS
// Always included in every app's tool list
// ============================================

const SDK_TOOLS: MCPTool[] = [
  // ---- Data Storage ----
  {
    name: "ultralight.store",
    title: "Store Data",
    description:
      "Store a value in app-scoped persistent storage. Data is partitioned per user.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            'Storage key. Supports "/" for hierarchy (e.g., "users/123/profile").',
        },
        value: {
          description: "JSON-serializable value to store.",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "ultralight.load",
    title: "Load Data",
    description: "Load a value from app-scoped storage by key.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Storage key to retrieve.",
        },
      },
      required: ["key"],
    },
    outputSchema: {
      description: "The stored value, or null if not found.",
    },
  },
  {
    name: "ultralight.list",
    title: "List Keys",
    description: "List all keys in storage, optionally filtered by prefix.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description:
            'Optional prefix filter (e.g., "users/" to list all user keys).',
        },
      },
    },
    outputSchema: {
      type: "array",
      items: { type: "string" },
      description: "Array of matching keys.",
    },
  },
  {
    name: "ultralight.query",
    title: "Query Data",
    description: "Query storage with filtering, sorting, and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description: "Key prefix to query.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return.",
        },
        offset: {
          type: "number",
          description: "Number of results to skip.",
        },
      },
      required: ["prefix"],
    },
    outputSchema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: {},
          updatedAt: { type: "string" },
        },
      },
    },
  },
  {
    name: "ultralight.remove",
    title: "Remove Data",
    description: "Remove a key from storage.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Storage key to remove.",
        },
      },
      required: ["key"],
    },
  },

  // ---- User Memory (Cross-App) ----
  {
    name: "ultralight.remember",
    title: "Remember (Cross-App)",
    description:
      "Store a value in user's cross-app memory. Defaults to app-scoped (app:{appId}). Use scope='user' for memory shared across all apps.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Memory key.",
        },
        value: {
          description: "JSON-serializable value to remember.",
        },
        scope: {
          type: "string",
          description:
            "Memory scope. Defaults to 'app:{appId}'. Use 'user' for cross-app memory.",
        },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "ultralight.recall",
    title: "Recall (Cross-App)",
    description:
      "Retrieve a value from user's cross-app memory. Defaults to app-scoped. Use scope='user' for cross-app memory.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Memory key to recall.",
        },
        scope: {
          type: "string",
          description:
            "Memory scope. Defaults to 'app:{appId}'. Use 'user' for cross-app memory.",
        },
      },
      required: ["key"],
    },
    outputSchema: {
      description: "The remembered value, or null if not found.",
    },
  },

  // ---- AI ----
  {
    name: "ultralight.ai",
    title: "Call AI Model",
    description:
      "Call an AI model using BYOK when configured, otherwise credits-billed platform inference.",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: {
                type: "string",
                enum: ["system", "user", "assistant"],
              },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
          description: "Conversation messages.",
        },
        model: {
          type: "string",
          description:
            "Model ID. Credits-billed calls may request any OpenRouter-compatible model; BYOK calls use the configured provider model.",
        },
        temperature: {
          type: "number",
          description: "Sampling temperature (0-2).",
        },
        max_tokens: {
          type: "number",
          description: "Maximum tokens to generate.",
        },
      },
      required: ["messages"],
    },
    outputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        model: { type: "string" },
        usage: {
          type: "object",
          properties: {
            input_tokens: { type: "number" },
            output_tokens: { type: "number" },
            cost_light: { type: "number" },
          },
        },
      },
    },
  },

  // ---- Inter-App Calls ----
  {
    name: "ultralight.call",
    title: "Call Another App",
    description:
      "Call a function on another Galactic app. Uses the current user's auth context — " +
      "the called app sees the same user. Accepts app ID or slug as the target.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: {
          type: "string",
          description: "App ID or slug of the target app.",
        },
        function_name: {
          type: "string",
          description:
            'Function name to call on the target app (unprefixed, e.g. "doThing" not "app-slug_doThing").',
        },
        args: {
          type: "object",
          description: "Arguments to pass to the function.",
          additionalProperties: true,
        },
      },
      required: ["app_id", "function_name"],
    },
    outputSchema: {
      description: "The return value from the called function.",
    },
  },

  // ---- Async Job Polling ----
  {
    name: "ultralight.job",
    title: "Check Async Job Status",
    description:
      "Check the status of a queued/running async execution. Functions that " +
      "run asynchronously return { _async: true, job_id } immediately — poll " +
      "this tool with that job_id until status is completed or failed.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job_id from an async function-call envelope.",
        },
      },
      required: ["job_id"],
    },
    outputSchema: {
      description:
        "Job status: { job_id, status: queued|running|completed|failed, " +
        "result?, error?, logs?, duration_ms?, ai_cost_light?, " +
        "execution_id? (links to the execution receipt and AI-spend ledger), " +
        "elapsed_seconds?, message? }.",
    },
  },
];

// ============================================
// MAIN MCP HANDLER
// ============================================

/**
 * Handle MCP JSON-RPC requests
 * POST /mcp/:appId
 */
export async function handleMcp(
  request: Request,
  appId: string,
): Promise<Response> {
  const method = request.method;

  // Streamable HTTP transport: GET opens SSE stream (not supported yet), DELETE terminates session
  if (method === "DELETE") {
    // Session termination — we're stateless, so just acknowledge
    return new Response(null, { status: 200 });
  }

  if (method === "GET") {
    // SSE stream for server-initiated notifications — not supported yet
    return new Response(
      JSON.stringify({
        error: "SSE stream not supported. Use POST for MCP requests.",
      }),
      {
        status: 405,
        headers: {
          "Allow": "POST, DELETE",
          "Content-Type": "application/json",
        },
      },
    );
  }

  if (method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed." }), {
      status: 405,
      headers: {
        "Allow": "POST, GET, DELETE",
        "Content-Type": "application/json",
      },
    });
  }

  // Streamable HTTP: read client protocol version (don't enforce — backward compatible)
  const _clientProtocolVersion = request.headers.get("MCP-Protocol-Version");

  // Parse JSON-RPC request
  let rpcRequest: JsonRpcRequest;
  try {
    rpcRequest = await request.json();
  } catch {
    return jsonRpcErrorResponse(null, PARSE_ERROR, "Parse error: Invalid JSON");
  }

  // Validate JSON-RPC format
  if (rpcRequest.jsonrpc !== "2.0" || !rpcRequest.method) {
    return jsonRpcErrorResponse(
      rpcRequest.id ?? null,
      INVALID_REQUEST,
      "Invalid Request: Missing jsonrpc version or method",
    );
  }

  // Phase 2A+2B: Authenticate user AND load app in parallel (independent calls)
  const appsService = createAppsService();
  let userId: string;
  let user: UserContext | null = null;
  const requestUrl = new URL(request.url);
  const rejectedQueryToken = !request.headers.get("Authorization") &&
    requestUrl.searchParams.has("token");

  // Run auth and app lookup concurrently — they have no dependency on each other
  let callerContext: RequestCallerContext;
  let app: App | null;

  try {
    [callerContext, app] = await Promise.all([
      resolveRequestCallerContext(request, { authSourcePolicy: "bearer_only" }),
      appsService.findById(appId),
    ]);
  } catch (authErr) {
    // If findById fails it throws, but authenticate errors are the common case
    let message = authErr instanceof Error
      ? authErr.message
      : "Authentication required";

    // Classify the auth error for client-side handling
    let errorType = "AUTH_REQUIRED";
    if (rejectedQueryToken) {
      errorType = "AUTH_QUERY_TOKEN_UNSUPPORTED";
      message =
        "Query-string token auth is no longer supported. Use Authorization: Bearer <token>.";
    } else if (message.includes("expired")) {
      errorType = "AUTH_TOKEN_EXPIRED";
    } else if (
      message.includes("Missing") || message.includes("invalid authorization")
    ) {
      errorType = "AUTH_MISSING_TOKEN";
    } else if (message.includes("Invalid JWT") || message.includes("decode")) {
      errorType = "AUTH_INVALID_TOKEN";
    } else if (message.includes("Invalid or expired API token")) {
      errorType = "AUTH_API_TOKEN_INVALID";
    }

    console.error(`MCP auth failed [${errorType}]:`, message, {
      appId,
      method: rpcRequest.method,
      hasAuthHeader: !!request.headers.get("Authorization"),
    });

    const reqUrl = new URL(request.url);
    const host = request.headers.get("host") || reqUrl.host;
    const proto = request.headers.get("x-forwarded-proto") ||
      (host.includes("localhost") ? "http" : "https");
    const baseUrl = `${proto}://${host}`;
    const authErrorResponse = jsonRpcErrorResponse(
      rpcRequest.id,
      -32001,
      message,
      { type: errorType },
    );
    // MCP spec: 401 must include WWW-Authenticate pointing to resource metadata
    const authHeaders = new Headers(authErrorResponse.headers);
    authHeaders.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
    );
    return new Response(authErrorResponse.body, {
      status: 401,
      headers: authHeaders,
    });
  }

  // Process auth result
  userId = callerContext.userId;
  user = callerContext.user;

  // Cross-Agent caller identity: a valid X-Galactic-Caller header means this
  // request is one Agent calling another on behalf of the user. The token is
  // unforgeable (HMAC, server-only secret) and asserts the caller app id, the
  // user, the executing caller function, and the call-chain hop. We verify it
  // here and attach callerApp so handleToolsCall can run the grant check.
  const callerCtxHeader = request.headers.get(AGENT_CALLER_CONTEXT_HEADER);
  if (callerCtxHeader) {
    const verified = await verifyCallerContextToken(callerCtxHeader);
    if (!verified.claims) {
      // Present-but-invalid (tampered / expired / hop-exceeded) must fail
      // closed — never silently downgrade to a direct user call.
      return jsonRpcErrorResponse(
        rpcRequest.id,
        -32004,
        verified.error === "hop_exceeded"
          ? `Cross-Agent call chain exceeded the maximum depth of ${MAX_AGENT_CALL_HOP_DEPTH}.`
          : "Invalid or expired cross-Agent caller context.",
        { type: "AGENT_CALLER_CONTEXT_INVALID", reason: verified.error },
      );
    }
    // The signed user must match the authenticated user — a caller context
    // cannot act for a different user than the forwarded bearer.
    if (verified.claims.userId !== userId) {
      return jsonRpcErrorResponse(
        rpcRequest.id,
        -32004,
        "Cross-Agent caller context does not match the authenticated user.",
        { type: "AGENT_CALLER_CONTEXT_USER_MISMATCH" },
      );
    }
    callerContext.callerApp = {
      appId: verified.claims.callerAppId,
      callerFunction: verified.claims.callerFunction,
      hop: verified.claims.hop,
    };
  }

  // Confused-deputy guard (fail closed): a sandbox_actor token is minted ONLY
  // for the sandbox's outbound galactic.call(), which ALWAYS attaches a signed
  // X-Galactic-Caller context. A sandbox_actor token that reaches this per-app
  // chokepoint WITHOUT one means app code hand-rolled the request (e.g. via the
  // raw SELF binding + baked bearer), deliberately omitting the header to skip
  // the authoritative cross-Agent grant check. Reject it here rather than let it
  // fall through to the per-function ask/never policy (which an attacker could
  // otherwise satisfy with a forged X-Galactic-Confirm header). Scoped to
  // sandbox_actor ONLY: routine_actor legitimately posts headerless to its own
  // composer app (routine-executor), and user gateway API tokens make direct
  // headerless calls — neither can hand-roll a sandbox bearer.
  if (
    !callerContext.callerApp &&
    callerUsesSandboxActorToken(callerContext)
  ) {
    return jsonRpcErrorResponse(
      rpcRequest.id,
      -32004,
      "Cross-Agent caller context is required for this call. Use galactic.call() so the request carries a signed caller identity.",
      { type: "AGENT_CALLER_CONTEXT_REQUIRED" },
    );
  }

  // Update last_active_at for provisional users (fire-and-forget)
  if (callerContext.authUser?.provisional) {
    updateLastActive(userId);
  }

  // Validate app result
  if (!app) {
    return jsonRpcErrorResponse(rpcRequest.id, -32002, "App not found");
  }
  if (app.runtime === "gpu" && !isGpuSupportEnabled()) {
    return jsonRpcErrorResponse(
      rpcRequest.id,
      INTERNAL_ERROR,
      getGpuSupportDisabledMessage("GPU runtime execution"),
      { type: "GPU_SUPPORT_DISABLED", app_id: app.id },
    );
  }

  // Token scoping: if the API token is scoped to specific apps, enforce it
  if (!callerHasAppAccess(callerContext, [appId, app.slug, app.id])) {
    const scopedApps = callerContext.tokenAppIds?.join(", ") || "none";
    return jsonRpcErrorResponse(
      rpcRequest.id,
      -32003,
      `Token not authorized for this app. Scoped to: ${scopedApps}`,
    );
  }

  // Scope enforcement: require apps:call scope for tools/call
  if (rpcRequest.method === "tools/call") {
    if (!callerHasRequiredScope(callerContext, "apps:call")) {
      return jsonRpcErrorResponse(
        rpcRequest.id,
        -32003,
        "Token missing required scope: apps:call",
      );
    }
  }

  // Phase 2B: Run gate checks in parallel — rate limit, weekly calls, per-app RL, permissions
  // All depend on userId (from auth) and app (from findById), both now resolved
  {
    const isToolsCall = rpcRequest.method === "tools/call";
    const isNonOwner = app.owner_id !== userId;
    const rlConfig = app.rate_limit_config as {
      calls_per_minute?: number;
      calls_per_day?: number;
    } | null;
    // Dual-path (mirrors pricing): the gx.set config wins per field; where a
    // field is unset, fall through to the deployed manifest's app-level
    // rate_limit. Only parse the manifest when gx.set doesn't cover both fields.
    const manifestRl =
      (rlConfig?.calls_per_minute != null && rlConfig?.calls_per_day != null)
        ? null
        : parseManifestCallRateLimit(app.manifest);
    const effCallsPerMinute = rlConfig?.calls_per_minute ??
      manifestRl?.calls_per_minute;
    const effCallsPerDay = rlConfig?.calls_per_day ?? manifestRl?.calls_per_day;
    const endpointRateLimitOptions = isToolsCall
      ? { mode: "fail_closed" as const, resource: "MCP tools/call rate limit" }
      : undefined;

    // Build array of gate checks to run in parallel
    const gateChecks = await Promise.all([
      // [0] Per-endpoint rate limit (always)
      checkRateLimit(
        userId,
        `mcp:${rpcRequest.method}`,
        undefined,
        undefined,
        endpointRateLimitOptions,
      ),
      // [1] Weekly call limit (tools/call only)
      isToolsCall
        ? checkAndIncrementWeeklyCalls(
          userId,
          toTier(user?.tier || callerContext.authUser?.tier || "free"),
          {
            mode: "fail_closed",
            resource: "MCP weekly call limit",
          },
        )
        : null,
      // [2] Per-app minute rate limit (tools/call, non-owner, gx.set or manifest)
      isToolsCall && isNonOwner && effCallsPerMinute
        ? checkRateLimit(
          userId,
          `app:${appId}:minute`,
          effCallsPerMinute,
          1,
          {
            mode: "fail_closed",
            resource: "MCP app minute rate limit",
          },
        )
        : null,
      // [3] Per-app daily rate limit (tools/call, non-owner, gx.set or manifest)
      isToolsCall && isNonOwner && effCallsPerDay
        ? checkRateLimit(
          userId,
          `app:${appId}:day`,
          effCallsPerDay,
          1440,
          {
            mode: "fail_closed",
            resource: "MCP app daily rate limit",
          },
        )
        : null,
      // [4] Visibility/permissions (private apps, non-owner)
      app.visibility === "private" && isNonOwner
        ? getPermissionsForUser(
          userId,
          app.id,
          app.owner_id,
          app.visibility,
          app.slug,
        )
        : undefined,
      // [5] Provisional daily call limit (tools/call, provisional users only)
      isToolsCall && user?.provisional
        ? checkProvisionalDailyLimit(userId)
        : null,
    ]);

    // Check results — return first error found
    const [endpointRL, weeklyRL, appMinuteRL, appDayRL, perms, provisionalRL] =
      gateChecks;

    if (!endpointRL.allowed) {
      if (endpointRL.reason === "service_unavailable") {
        return jsonRpcErrorResponse(
          rpcRequest.id,
          INTERNAL_ERROR,
          "Usage controls are temporarily unavailable. Please try again shortly.",
        );
      }
      return jsonRpcErrorResponse(
        rpcRequest.id,
        RATE_LIMITED,
        `Rate limit exceeded. Try again after ${endpointRL.resetAt.toISOString()}`,
      );
    }
    if (weeklyRL && !weeklyRL.allowed) {
      if (weeklyRL.reason === "service_unavailable") {
        return jsonRpcErrorResponse(
          rpcRequest.id,
          INTERNAL_ERROR,
          "Usage controls are temporarily unavailable. Please try again shortly.",
        );
      }
      return jsonRpcErrorResponse(
        rpcRequest.id,
        RATE_LIMITED,
        `Too many requests. Please try again later or upgrade to Pro.`,
      );
    }
    if (appMinuteRL && !appMinuteRL.allowed) {
      if (appMinuteRL.reason === "service_unavailable") {
        return jsonRpcErrorResponse(
          rpcRequest.id,
          INTERNAL_ERROR,
          "App usage controls are temporarily unavailable. Please try again shortly.",
        );
      }
      return jsonRpcErrorResponse(
        rpcRequest.id,
        RATE_LIMITED,
        `App rate limit exceeded (${
          rlConfig!.calls_per_minute
        }/min). Try again after ${appMinuteRL.resetAt.toISOString()}`,
      );
    }
    if (appDayRL && !appDayRL.allowed) {
      if (appDayRL.reason === "service_unavailable") {
        return jsonRpcErrorResponse(
          rpcRequest.id,
          INTERNAL_ERROR,
          "App usage controls are temporarily unavailable. Please try again shortly.",
        );
      }
      return jsonRpcErrorResponse(
        rpcRequest.id,
        RATE_LIMITED,
        `App daily limit exceeded (${
          rlConfig!.calls_per_day
        }/day). Try again tomorrow.`,
      );
    }
    if (perms !== undefined && perms !== null && perms.allowed.size === 0) {
      return jsonRpcErrorResponse(rpcRequest.id, -32002, "App not found");
    }
    if (provisionalRL && !provisionalRL.allowed) {
      if (provisionalRL.reason === "service_unavailable") {
        return jsonRpcErrorResponse(
          rpcRequest.id,
          INTERNAL_ERROR,
          "Provisional usage controls are temporarily unavailable. Please try again shortly.",
        );
      }
      return jsonRpcErrorResponse(
        rpcRequest.id,
        RATE_LIMITED,
        `Provisional account daily limit reached (50 calls/day). Sign in at connectgalactic.com to unlock full access.`,
      );
    }
  }

  // Route to method handler
  const { method: rpcMethod, params, id } = rpcRequest;

  try {
    switch (rpcMethod) {
      case "initialize": {
        const response = handleInitialize(id, appId, app);
        // Streamable HTTP: assign a session ID on initialize
        const sessionId = crypto.randomUUID();
        const headers = new Headers(response.headers);
        headers.set("Mcp-Session-Id", sessionId);
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      }

      case "notifications/initialized":
        // Client acknowledgment after initialize — no response body needed
        return new Response(null, { status: 202 });

      case "tools/list":
        return await handleToolsList(id, app, params, userId, callerContext);

      case "tools/call":
        return await handleToolsCall(
          id,
          app,
          params,
          userId,
          user,
          request,
          callerContext,
        );

      case "resources/list":
        return handleResourcesList(id, appId, app);

      case "resources/read":
        return await handleResourcesRead(id, appId, app, params, userId);

      default:
        return jsonRpcErrorResponse(
          id,
          METHOD_NOT_FOUND,
          `Method not found: ${rpcMethod}`,
        );
    }
  } catch (err) {
    console.error(`MCP ${rpcMethod} error:`, err);
    return jsonRpcErrorResponse(
      id,
      INTERNAL_ERROR,
      `Internal error: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

// ============================================
// METHOD HANDLERS
// ============================================

/**
 * Handle initialize request - return server capabilities
 */
function handleInitialize(
  id: JsonRpcId,
  appId: string,
  app: App,
): Response {
  let instructions: string;

  if (app.skills_md) {
    // Skills.md is free documentation — always inline it in full.
    instructions = app.skills_md;
  } else {
    // Skills.md not yet generated — use description + resource directive
    instructions = (app.description ||
      `${app.name || app.slug} — an Galactic MCP server.`) +
      `\n\nRead the galactic://app/${appId}/manifest.json resource for function definitions and schemas.`;
  }

  const result: MCPServerInfo = {
    protocolVersion: "2025-03-26",
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
    serverInfo: {
      name: app.name || app.slug,
      version: "1.0.0",
    },
    instructions: instructions,
  };

  return jsonRpcResponse(id, result);
}

/**
 * Handle resources/list request - return available resources for this app
 */
function handleResourcesList(
  id: JsonRpcId,
  appId: string,
  app: App,
): Response {
  const resources: MCPResourceDescriptor[] = [];

  // Skills.md is auto-generated function documentation, served free in full.
  if (hasSkillContext(app)) {
    resources.push({
      uri: `galactic://app/${appId}/skills.json`,
      name: `${app.name || app.slug} — Skill Metadata`,
      description:
        "Machine-readable pointer to the free skills.md documentation resource.",
      mimeType: "application/json",
    });
    resources.push({
      uri: `galactic://app/${appId}/skills.md`,
      name: `${app.name || app.slug} — Skills & Usage Guide`,
      description:
        "Auto-generated usage documentation for this app's functions. Always served in full, free of charge.",
      mimeType: "text/markdown",
    });
  }

  // Phase 1B: Manifest — structured function schemas + app metadata
  resources.push({
    uri: `galactic://app/${appId}/manifest.json`,
    name: `${app.name || app.slug} — App Manifest`,
    description:
      "Function definitions, parameter schemas, and app configuration. Machine-readable complement to skills.md.",
    mimeType: "application/json",
  });

  // Phase 2A: Storage — browsable app data
  resources.push({
    uri: `galactic://app/${appId}/data`,
    name: `${app.name || app.slug} — Stored Data`,
    description:
      "List of all storage keys for this app. Read individual keys at galactic://app/{appId}/data/{key}.",
    mimeType: "application/json",
  });

  return jsonRpcResponse(id, { resources });
}

/**
 * Handle resources/read request - return resource content
 */
async function handleResourcesRead(
  id: JsonRpcId,
  appId: string,
  app: App,
  params: unknown,
  userId?: string,
): Promise<Response> {
  const readParams = params as { uri?: string } | undefined;
  const uri = readParams?.uri;

  if (!uri) {
    return jsonRpcErrorResponse(
      id,
      INVALID_PARAMS,
      "Missing required parameter: uri",
    );
  }

  // Skills.md — auto-generated function documentation, always served in full
  const expectedSkillsUri = `galactic://app/${appId}/skills.md`;
  if (uri === expectedSkillsUri) {
    const skillsMd = hasSkillContext(app) ? app.skills_md : null;
    if (!skillsMd) {
      return jsonRpcErrorResponse(
        id,
        -32002,
        "Skill context not yet generated for this app",
      );
    }

    const contents: MCPResourceContent[] = [{
      uri: uri,
      mimeType: "text/markdown",
      text: skillsMd,
    }];

    return jsonRpcResponse(id, { contents });
  }

  const expectedSkillsJsonUri = `galactic://app/${appId}/skills.json`;
  if (uri === expectedSkillsJsonUri) {
    if (!hasSkillContext(app)) {
      return jsonRpcErrorResponse(
        id,
        -32002,
        "Skill context not yet generated for this app",
      );
    }

    const contents: MCPResourceContent[] = [{
      uri: uri,
      mimeType: "application/json",
      text: JSON.stringify(
        buildSkillsDiscoveryPayload(app, appId),
        null,
        2,
      ),
    }];

    return jsonRpcResponse(id, { contents });
  }

  // Phase 1B: Manifest — structured function schemas + runtime metadata
  if (uri === `galactic://app/${appId}/manifest.json`) {
    let manifest: Record<string, unknown> = {};
    if (app.manifest) {
      try {
        manifest = JSON.parse(app.manifest);
      } catch { /* invalid manifest JSON, return empty */ }
    }
    // Enrich with runtime metadata
    manifest._meta = {
      app_id: appId,
      name: app.name,
      slug: app.slug,
      version: app.current_version || null,
      visibility: app.visibility || null,
      exports: app.exports || [],
      total_runs: app.total_runs || 0,
    };

    const contents: MCPResourceContent[] = [{
      uri: uri,
      mimeType: "application/json",
      text: JSON.stringify(manifest, null, 2),
    }];
    return jsonRpcResponse(id, { contents });
  }

  // Phase 2A: Storage key listing
  if (uri === `galactic://app/${appId}/data`) {
    if (!userId) {
      return jsonRpcErrorResponse(
        id,
        AUTH_REQUIRED,
        "Authentication required to access app storage",
      );
    }
    try {
      const appData = createAppDataService(appId, userId, {
        operationMetering: {
          payerUserId: userId,
          callerUserId: userId,
          ownerUserId: app.owner_id,
          appId,
          source: "mcp_resource",
          metadata: {
            surface: "mcp_resources_read",
            uri,
          },
        },
      });
      const keys = await appData.list();
      const contents: MCPResourceContent[] = [{
        uri: uri,
        mimeType: "application/json",
        text: JSON.stringify({ keys, count: keys.length }),
      }];
      return jsonRpcResponse(id, { contents });
    } catch (err) {
      return jsonRpcErrorResponse(
        id,
        INTERNAL_ERROR,
        `Failed to list storage keys: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    }
  }

  // Phase 2A: Individual storage key read
  const dataPrefix = `galactic://app/${appId}/data/`;
  if (uri.startsWith(dataPrefix)) {
    if (!userId) {
      return jsonRpcErrorResponse(
        id,
        AUTH_REQUIRED,
        "Authentication required to access app storage",
      );
    }
    const key = decodeURIComponent(uri.slice(dataPrefix.length));
    if (!key) {
      return jsonRpcErrorResponse(id, INVALID_PARAMS, "Missing key in URI");
    }
    try {
      const appData = createAppDataService(appId, userId, {
        operationMetering: {
          payerUserId: userId,
          callerUserId: userId,
          ownerUserId: app.owner_id,
          appId,
          source: "mcp_resource",
          metadata: {
            surface: "mcp_resources_read",
            uri,
          },
        },
      });
      const value = await appData.load(key);
      if (value === null || value === undefined) {
        return jsonRpcErrorResponse(
          id,
          NOT_FOUND,
          `Storage key not found: ${key}`,
        );
      }
      const contents: MCPResourceContent[] = [{
        uri: uri,
        mimeType: "application/json",
        text: JSON.stringify(value),
      }];
      return jsonRpcResponse(id, { contents });
    } catch (err) {
      return jsonRpcErrorResponse(
        id,
        INTERNAL_ERROR,
        `Failed to read storage key: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    }
  }

  return jsonRpcErrorResponse(id, -32002, `Resource not found: ${uri}`);
}

/**
 * Handle tools/list request - return available tools
 */
async function handleToolsList(
  id: JsonRpcId,
  app: App,
  params?: { cursor?: string },
  callerUserId?: string,
  callerContext?: RequestCallerContext,
): Promise<Response> {
  if (app.runtime === "gpu" && !isGpuSupportEnabled()) {
    return jsonRpcErrorResponse(
      id,
      INTERNAL_ERROR,
      getGpuSupportDisabledMessage("GPU runtime execution"),
      { type: "GPU_SUPPORT_DISABLED", app_id: app.id },
    );
  }

  const tools: MCPTool[] = [];
  let manifestTools: MCPTool[] = [];

  try {
    const contractResolution = requireManifestFunctionContracts(app);
    logAppContractResolution({
      appId: app.id,
      ownerId: app.owner_id,
      appSlug: app.slug,
      runtime: app.runtime,
      surface: "mcp_tools_list",
      source: contractResolution.source,
      legacySourceDetected: contractResolution.legacySourceDetected,
      functionCount: contractResolution.functions.length,
      manifestBacked: contractResolution.manifestBacked,
      migrationRequired: contractResolution.migrationRequired,
    });

    const manifest = contractResolution.manifest as AppManifest;
    manifestTools = manifestToMCPTools(manifest, app.id, app.slug);
    tools.push(...manifestTools);
  } catch (err) {
    if (err instanceof AppContractMigrationRequiredError) {
      const legacyResolution = resolveAppFunctionContracts(app, {
        allowLegacySkills: true,
        allowLegacyExports: true,
        allowGpuExports: isGpuSupportEnabled(),
      });
      logAppContractResolution({
        appId: app.id,
        ownerId: app.owner_id,
        appSlug: app.slug,
        runtime: app.runtime,
        surface: "mcp_tools_list",
        source: "none",
        legacySourceDetected: legacyResolution.legacySourceDetected,
        functionCount: 0,
        manifestBacked: false,
        migrationRequired: true,
        note: "manifest_required",
      });
      return jsonRpcErrorResponse(id, INVALID_REQUEST, err.message);
    }
    throw err;
  }

  // Permission filtering for private apps: only show allowed functions to non-owners
  if (callerUserId && app.visibility === "private") {
    const permsResult = await getPermissionsForUser(
      callerUserId,
      app.id,
      app.owner_id,
      app.visibility,
      app.slug,
    );
    if (permsResult !== null) {
      // Filter tools to only include allowed functions
      // SDK tools (ultralight.*) are always shown
      const filteredTools = tools.filter((tool) =>
        tool.name.startsWith("ultralight.") ||
        permissionSetAllowsFunction(app.slug, permsResult.allowed, tool.name)
      );
      tools.length = 0;
      tools.push(...filteredTools);
    }
  }

  // Free Mode discovery filter (docs/FREE_MODE_DESIGN.md): hide functions a
  // free-mode caller would be blocked from calling (paid, or AI without BYOK),
  // so the agent never lists them as callable. Self-calls (owner) pass through.
  if (isFreeModeEnabled() && callerContext?.freeMode) {
    // Peek the caller's free-allowance counters so priced functions they can
    // still run for free stay visible (Phase 3). One read per tools/list; a
    // failure falls back to conservative "priced == hidden" (usage = null).
    const usage = await peekCallerUsage(app.id, callerContext.userId)
      .catch(() => null);
    const visible = tools.filter((tool) =>
      tool.name.startsWith("ultralight.") ||
      !isFunctionBlockedInFreeMode(
        app,
        toRawMcpFunctionName(app.slug, tool.name),
        { userId: callerContext.userId, byokPresent: callerContext.byokPresent },
        usage,
      )
    );
    tools.length = 0;
    tools.push(...visible);
  }

  // Add SDK tools (always included)
  tools.push(...SDK_TOOLS);

  // ── GPU tool enrichment ──
  // If this is a GPU app, annotate tools with cost + latency hints
  if (app.runtime === "gpu") {
    const gpuType = app.gpu_type || "GPU";
    const benchmark = app.gpu_benchmark as Record<string, unknown> | null;

    for (const tool of tools) {
      // Skip SDK tools
      if (tool.name.startsWith("ultralight.")) continue;

      // Add GPU context to description
      const avgMs = benchmark?.mean_ms as number | undefined;
      const avgDisplay = avgMs ? `~${(avgMs / 1000).toFixed(1)}s` : "variable";
      const gpuSuffix = `\n\n⚡ GPU function (${gpuType}, ${avgDisplay})`;
      tool.description = (tool.description || "") + gpuSuffix;

      // Set annotations: GPU tools are never read-only, not idempotent, open-world
      tool.annotations = {
        ...tool.annotations,
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
    }
  }

  const result: MCPToolsListResponse = {
    tools,
    // No pagination for now
  };

  return jsonRpcResponse(id, result);
}

/**
 * Handle tools/call request - execute a tool
 */
async function handleToolsCall(
  id: JsonRpcId,
  app: App,
  params: unknown,
  userId: string,
  user: UserContext | null,
  request: Request,
  callerContext: RequestCallerContext,
): Promise<Response> {
  // Validate params
  const callParams = params as MCPToolCallRequest | undefined;
  if (!callParams?.name) {
    return jsonRpcErrorResponse(id, INVALID_PARAMS, "Missing tool name");
  }

  const { name, arguments: args } = callParams;

  // Check if it's an SDK tool (always allowed) — supports both ultralight.* and ul.* prefixes
  if (name.startsWith("ultralight.") || name.startsWith("ul.")) {
    return await executeSDKTool(
      id,
      name,
      args || {},
      app.id,
      app.owner_id,
      userId,
      user,
      request,
      callerContext,
    );
  }

  // Token function scoping: if the API token restricts callable functions, enforce it
  const rawName = toRawMcpFunctionName(app.slug, name);
  if (
    !callerHasFunctionAccess(
      callerContext,
      getMcpFunctionNameAliases(app.slug, name),
    )
  ) {
    const scopedFunctions = callerContext.tokenFunctionNames?.join(", ") ||
      "none";
    return jsonRpcErrorResponse(
      id,
      -32003,
      `Token not authorized for function '${rawName}'. Scoped to: ${scopedFunctions}`,
    );
  }

  // Cross-Agent grant check (P5): when this call comes from another Agent
  // (verified caller context present), the user grant is AUTHORITATIVE for the
  // A→B hop — it does not additionally require the connected-agent policy. A
  // call with no active grant is denied and a pending request is recorded so
  // it surfaces in the user's approval inbox.
  let callerGrantId: string | null = null;
  if (callerContext.callerApp) {
    const caller = callerContext.callerApp;
    // An Agent never needs a grant to call its own functions.
    if (caller.appId !== app.id) {
      const resolution = await resolveCallerGrant({
        userId,
        callerAppId: caller.appId,
        callerFunction: caller.callerFunction,
        targetAppId: app.id,
        targetFunction: rawName,
      });
      if (!resolution.allowed) {
        // Only seed a pending request for a real function — never let a
        // caller spam the approval inbox with bogus target function names.
        const knownExports = Array.isArray(app.exports) ? app.exports : [];
        if (
          resolution.reason === "no_grant" && knownExports.length > 0 &&
          !knownExports.includes(rawName)
        ) {
          return jsonRpcErrorResponse(id, INVALID_PARAMS, `Unknown tool: ${name}`);
        }
        let pendingRequestId = resolution.pendingRequestId ?? null;
        if (resolution.reason === "no_grant") {
          pendingRequestId = await createPendingGrantRequest({
            userId,
            callerAppId: caller.appId,
            callerFunction: caller.callerFunction,
            targetAppId: app.id,
            targetFunction: rawName,
          });
        }
        const message = resolution.reason === "cap_exceeded"
          ? `This cross-Agent connection has reached its monthly credit cap for ${rawName}.`
          : `Your connected Agent has not been granted permission to call ${rawName} on this Agent.`;
        return jsonRpcErrorResponse(id, -32003, message, {
          type: resolution.reason === "cap_exceeded"
            ? "AGENT_GRANT_CAP_EXCEEDED"
            : "AGENT_GRANT_REQUIRED",
          callerAppId: caller.appId,
          targetAppId: app.id,
          functionName: rawName,
          pendingRequestId,
          configureUrl: buildCallerPermissionConfigureUrl(
            requestBaseUrl(request),
            app.id,
            rawName,
          ),
        });
      }
      callerGrantId = resolution.grant?.id ?? null;
    }
  } else if (
    callerUsesApiToken(callerContext) ||
    callerUsesRoutineActorToken(callerContext) ||
    callerUsesSandboxActorToken(callerContext)
  ) {
    // Direct call from the user's connected agent (no caller-Agent context):
    // the existing always/ask/never policy governs. A sandbox_actor with no
    // caller context means app code bypassed the SDK's call() (which always
    // attaches one), so subject it to the same per-function policy.
    const permission = await enforceCallerFunctionPermission({
      userId,
      appId: app.id,
      functionName: rawName,
      configureUrl: buildCallerPermissionConfigureUrl(
        requestBaseUrl(request),
        app.id,
        rawName,
      ),
      resolveTargetHealthGreen: async () => {
        const map = await getAppHealth([app.id]);
        return isRecentlyHealthy(map.get(app.id) ?? emptyHealth());
      },
      // One-shot user consent, forwarded by the gx.call gateway. Satisfies "ask"
      // for this single call only (never overrides "never"). Honored ONLY for a
      // user-originated gateway API token: an actor token (sandbox/routine) can
      // read request headers and its own baked bearer, so trusting its
      // X-Galactic-Confirm would let app code self-approve. Headerless
      // sandbox_actor calls are already rejected above; this is defense in depth
      // and also blocks a routine_actor from self-approving an "ask" function.
      confirmed: callerUsesApiToken(callerContext) &&
        request.headers.get("X-Galactic-Confirm") === "1",
    });
    if (!permission.allowed) {
      return jsonRpcErrorResponse(
        id,
        permission.rpcCode,
        permission.message,
        permission.details,
      );
    }
  }

  // Permission check: for private apps, verify non-owner has access to this function
  // Also enforce granular constraints (IP, time window, budget, expiry, arg whitelist) — Pro feature
  if (app.visibility === "private") {
    const permsResult = await getPermissionsForUser(
      userId,
      app.id,
      app.owner_id,
      app.visibility,
      app.slug,
    );
    if (permsResult !== null) {
      if (!permissionSetAllowsFunction(app.slug, permsResult.allowed, name)) {
        return jsonRpcErrorResponse(
          id,
          -32003,
          `Permission denied: you do not have access to '${rawName}'. Ask the app owner to grant you access.`,
        );
      }

      // Enforce granular constraints on the matching permission row
      const { checkConstraints } = await import("../services/constraints.ts");
      const matchingRow = findPermissionRowForFunction(
        app.slug,
        permsResult.rows,
        name,
      );
      if (matchingRow) {
        const clientIp =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request.headers.get("x-real-ip") ||
          null;
        // Pass call arguments for argument-value whitelist enforcement
        const callArgs = (args && typeof args === "object")
          ? args as Record<string, unknown>
          : undefined;
        const constraintResult = checkConstraints(
          matchingRow,
          clientIp,
          undefined,
          callArgs,
        );
        if (!constraintResult.allowed) {
          return jsonRpcErrorResponse(
            id,
            -32003,
            `Permission denied: ${constraintResult.reason}`,
          );
        }

        // Increment budget_used atomically if budget_limit is set
        if (matchingRow.budget_limit !== null && matchingRow.budget_limit > 0) {
          const sbUrl = getEnv("SUPABASE_URL");
          const sbKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
          try {
            // Use Supabase RPC for atomic increment to avoid race conditions
            const rpcRes = await fetch(
              `${sbUrl}/rest/v1/rpc/increment_budget_used`,
              {
                method: "POST",
                headers: {
                  "apikey": sbKey,
                  "Authorization": `Bearer ${sbKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  p_user_id: userId,
                  p_app_id: app.id,
                  p_function_name: matchingRow.function_name,
                }),
              },
            );
            if (!rpcRes.ok) {
              // Fallback: use PostgREST PATCH with atomic SQL expression
              // PostgREST doesn't support SET col = col + 1 directly,
              // so we await the non-atomic version but log a warning
              console.warn(
                "Budget RPC not available, falling back to non-atomic increment",
              );
              await fetch(
                `${sbUrl}/rest/v1/user_app_permissions?granted_to_user_id=eq.${userId}&app_id=eq.${app.id}&function_name=eq.${
                  encodeURIComponent(matchingRow.function_name)
                }`,
                {
                  method: "PATCH",
                  headers: {
                    "apikey": sbKey,
                    "Authorization": `Bearer ${sbKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    budget_used: (matchingRow.budget_used || 0) + 1,
                    updated_at: new Date().toISOString(),
                  }),
                },
              );
            }
          } catch (err) {
            console.error("Budget increment failed:", err);
          }

          // Keep permission cache in sync with local budget increment
          getPermissionCache().incrementBudget(
            userId,
            app.id,
            matchingRow.function_name,
            app.slug,
          );
        }
      }
    }
  }

  // Determine the actual function name to execute from canonical manifest contracts only.
  let functionName = rawName;
  let manifest: AppManifest;
  try {
    const contractResolution = requireManifestFunctionContracts(app);
    logAppContractResolution({
      appId: app.id,
      ownerId: app.owner_id,
      appSlug: app.slug,
      runtime: app.runtime,
      surface: "mcp_tools_call",
      source: contractResolution.source,
      legacySourceDetected: contractResolution.legacySourceDetected,
      functionCount: contractResolution.functions.length,
      manifestBacked: contractResolution.manifestBacked,
      migrationRequired: contractResolution.migrationRequired,
    });
    manifest = contractResolution.manifest as AppManifest;
  } catch (err) {
    if (err instanceof AppContractMigrationRequiredError) {
      const legacyResolution = resolveAppFunctionContracts(app, {
        allowLegacySkills: true,
        allowLegacyExports: true,
        allowGpuExports: isGpuSupportEnabled(),
      });
      logAppContractResolution({
        appId: app.id,
        ownerId: app.owner_id,
        appSlug: app.slug,
        runtime: app.runtime,
        surface: "mcp_tools_call",
        source: "none",
        legacySourceDetected: legacyResolution.legacySourceDetected,
        functionCount: 0,
        manifestBacked: false,
        migrationRequired: true,
        note: "manifest_required",
      });
      return jsonRpcErrorResponse(id, INVALID_REQUEST, err.message);
    }
    throw err;
  }

  if (!manifest.functions || !(functionName in manifest.functions)) {
    return jsonRpcErrorResponse(id, INVALID_PARAMS, `Unknown tool: ${name}`);
  }

  // Extract agent meta (e.g. _user_query, _session_id) before passing to sandbox
  const { extractCallMeta } = await import("../services/call-logger.ts");
  const {
    cleanArgs,
    userQuery,
    sessionId,
    widgetPull,
    widgetAction,
    agenticSurfaceAction,
  } = extractCallMeta(args || {});

  // Extract auth token from request for inter-app calls (ultralight.call)
  const authToken = request.headers.get("Authorization")?.slice(7) || undefined;

  // Execute app function via sandbox
  return await executeAppFunction(
    id,
    functionName,
    cleanArgs,
    app,
    userId,
    user,
    callerContext,
    {
      userQuery,
      sessionId,
      authToken,
      widgetPull,
      widgetAction,
      agenticSurfaceAction,
      routineContext: routineTraceContextFromCaller(callerContext),
      // Cross-Agent attribution: the grant authorizing this call (for spend
      // accounting) and the inbound hop (so this Agent's own sub-calls mint a
      // token at hop + 1).
      callerGrantId,
      incomingHop: callerContext.callerApp?.hop ?? 0,
    },
  );
}

// ============================================
// TOOL EXECUTION
// ============================================

/**
 * Execute an SDK tool (ultralight.*)
 */
async function executeSDKTool(
  id: JsonRpcId,
  toolName: string,
  args: Record<string, unknown>,
  appId: string,
  appOwnerId: string,
  userId: string,
  user: UserContext | null,
  request: Request | undefined,
  callerContext: RequestCallerContext,
): Promise<Response> {
  try {
    // Create app data service — use Worker-backed service if configured (native R2, ~10x faster)
    // Wrap with metered service when userId is present to track user data storage.
    const sdkOperationMetering = {
      payerUserId: userId,
      callerUserId: userId,
      ownerUserId: appOwnerId,
      appId,
      functionName: toolName,
      source: "mcp_sdk",
      metadata: {
        surface: "mcp_sdk",
        tool_name: toolName,
      },
    };
    const _workerUrl = getEnv("WORKER_DATA_URL");
    const _workerSecret = getEnv("WORKER_SECRET");
    const _rawAppDataService = (_workerUrl && _workerSecret)
      ? createWorkerAppDataService(appId, userId, _workerUrl, _workerSecret, {
        operationMetering: sdkOperationMetering,
      })
      : createAppDataService(appId, userId, {
        operationMetering: sdkOperationMetering,
      });
    const appDataService = userId
      ? createMeteredAppDataService(_rawAppDataService, userId)
      : _rawAppDataService;

    let result: unknown;

    switch (toolName) {
      // Storage
      case "ultralight.store": {
        const storeKey = args.key as string;
        await appDataService.store(storeKey, args.value);
        // Index KV data for semantic search (fire-and-forget)
        indexAppKV(appId, appOwnerId, storeKey, args.value).catch((err) =>
          console.error("[KV-INDEX] App KV index failed:", err)
        );
        result = { success: true };
        break;
      }

      case "ultralight.load":
        result = await appDataService.load(args.key as string);
        break;

      case "ultralight.list":
        result = await appDataService.list(args.prefix as string | undefined);
        break;

      case "ultralight.query":
        result = await appDataService.query(args.prefix as string, {
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        });
        break;

      case "ultralight.remove": {
        const removeKey = args.key as string;
        await appDataService.remove(removeKey);
        // Clean up content index (fire-and-forget)
        removeKVIndex(appOwnerId, "app_kv", `${appId}/${removeKey}`).catch(
          (err) => console.error("[KV-INDEX] App KV remove failed:", err),
        );
        result = { success: true };
        break;
      }

      // Memory (cross-app)
      case "ultralight.remember": {
        const memService = getMemoryService();
        if (!memService) {
          result = { success: false, error: "Memory service not available" };
          break;
        }
        const scope = args.scope as string || `app:${appId}`;
        const rememberKey = args.key as string;
        await memService.remember(userId, scope, rememberKey, args.value);
        // Index user KV data for semantic search (fire-and-forget)
        indexUserKV(userId, scope, rememberKey, args.value).catch((err) =>
          console.error("[KV-INDEX] User KV index failed:", err)
        );
        result = { success: true, key: rememberKey, scope };
        break;
      }

      case "ultralight.recall": {
        const memService = getMemoryService();
        if (!memService) {
          result = null;
          break;
        }
        const scope = args.scope as string || `app:${appId}`;
        result = await memService.recall(userId, scope, args.key as string);
        break;
      }

      // AI
      case "ultralight.ai": {
        const aiMessages = toAiMessages(args.messages);
        if (!aiMessages) {
          result = {
            content: "",
            model: "none",
            usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
            error:
              "Invalid messages payload. Expected an array of AI messages.",
          };
          break;
        }

        // Make the AI call
        try {
          const runtimeAI = await createRuntimeAIContext(callerContext.user, {
            freeMode: callerContext.freeMode,
          });
          result = await runtimeAI.aiService.call({
            messages: aiMessages,
            model: args.model as string | undefined,
            temperature: args.temperature as number | undefined,
            max_tokens: args.max_tokens as number | undefined,
            tools: args.tools as
              | Array<
                {
                  name: string;
                  description: string;
                  parameters: Record<string, unknown>;
                }
              >
              | undefined,
          });
        } catch (aiError) {
          result = {
            content: "",
            model: args.model || "unknown",
            usage: { input_tokens: 0, output_tokens: 0, cost_light: 0 },
            error: aiError instanceof Error
              ? aiError.message
              : "AI call failed",
          };
        }
        break;
      }

      // Inter-app calls
      case "ultralight.call": {
        const targetAppId = args.app_id as string;
        const targetFn = args.function_name as string;
        const callArgs = (args.args as Record<string, unknown>) || {};

        if (!targetAppId || !targetFn) {
          result = { error: "app_id and function_name are required" };
          break;
        }

        const baseUrl = getEnv("BASE_URL");
        const authToken = request?.headers.get("Authorization")?.slice(7);

        if (!baseUrl || !authToken) {
          result = {
            error:
              "Inter-app calls not available (missing baseUrl or authToken)",
          };
          break;
        }

        // Make JSON-RPC call to target app's MCP endpoint
        const rpcRequest = {
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: {
            name: targetFn,
            arguments: callArgs,
          },
        };

        // SELF binding: same-worker public-hostname fetch is blocked by the
        // CDN (error 1042); helper validates + encodes the target id.
        const internalCall = resolveInternalMcpCall(targetAppId, { baseUrl });
        const callResponse = await internalCall.fetchFn(internalCall.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${authToken}`,
          },
          body: JSON.stringify(rpcRequest),
        });

        if (!callResponse.ok) {
          const errText = await callResponse.text().catch(() =>
            callResponse.statusText
          );
          result = {
            error: `Call failed (${callResponse.status}): ${errText}`,
          };
          break;
        }

        const rpcResponse = await readJsonResponse<JsonRpcResponse>(
          callResponse,
        );
        if (rpcResponse.error) {
          result = {
            error: `RPC error: ${
              rpcResponse.error.message || JSON.stringify(rpcResponse.error)
            }`,
            details: rpcResponse.error.data,
          };
          break;
        }

        // Unwrap MCP tool result
        const callResult = rpcResponse.result as
          | MCPToolCallResponse
          | undefined;
        if (callResult?.content && Array.isArray(callResult.content)) {
          const textBlock = callResult.content.find((c) => c.type === "text");
          if (textBlock?.text) {
            try {
              result = JSON.parse(textBlock.text);
            } catch {
              result = textBlock.text;
            }
          } else {
            result = callResult;
          }
        } else {
          result = callResult;
        }
        break;
      }

      // Async job polling — mirrors ul.job from platform-mcp
      case "ultralight.job":
      case "ul.job": {
        const jobId = args.job_id as string;
        if (!jobId) {
          result = { error: "Missing required: job_id" };
          break;
        }
        const { getJob } = await import("../services/async-jobs.ts");
        const job = await getJob(jobId, userId);
        if (!job) {
          result = { error: `Job ${jobId} not found` };
          break;
        }
        if (job.status === "queued") {
          result = {
            job_id: jobId,
            status: "queued",
            message:
              "Waiting to be picked up. Poll again in a few seconds.",
          };
        } else if (job.status === "running") {
          const elapsed = Date.now() - new Date(job.created_at).getTime();
          result = {
            job_id: jobId,
            status: "running",
            elapsed_seconds: Math.round(elapsed / 1000),
            message: "Still running. Poll again in a few seconds.",
          };
        } else if (job.status === "completed") {
          result = {
            job_id: jobId,
            status: "completed",
            duration_ms: job.duration_ms,
            result: job.result,
            logs: job.logs,
            ai_cost_light: job.ai_cost_light,
            // Links this job to its execution receipt and AI-spend ledger.
            execution_id: job.execution_id,
          };
        } else {
          result = {
            job_id: jobId,
            status: "failed",
            duration_ms: job.duration_ms,
            error: job.error,
            // AI calls that completed before the failure were still billed.
            ai_cost_light: job.ai_cost_light,
            logs: job.logs,
            execution_id: job.execution_id,
          };
        }
        break;
      }

      default:
        return jsonRpcErrorResponse(
          id,
          INVALID_PARAMS,
          `Unknown SDK tool: ${toolName}`,
        );
    }

    return jsonRpcResponse(id, formatToolResult(result));
  } catch (err) {
    console.error(`SDK tool ${toolName} error:`, err);
    return jsonRpcResponse(id, formatToolError(err));
  }
}

/**
 * Execute an app-specific function
 */
/**
 * Handle GPU function execution — dispatches to RunPod instead of Deno sandbox.
 * Called early in executeAppFunction before code fetching (GPU apps have no JS code).
 */
async function handleGpuExecution(
  id: JsonRpcId,
  app: App,
  functionName: string,
  args: Record<string, unknown>,
  userId: string,
  user: UserContext | null,
  meta?: {
    userQuery?: string;
    sessionId?: string;
    authToken?: string;
    widgetPull?: { widgetName?: string; intervalMs?: number; reason?: string };
    widgetAction?: WidgetActionCallMetadata;
    agenticSurfaceAction?: AgenticSurfaceActionCallMetadata;
    routineContext?: RoutineTraceContext;
    callerAppId?: string | null;
    callChainDepth?: number | null;
  },
): Promise<Response> {
  if (!isGpuSupportEnabled()) {
    return jsonRpcErrorResponse(
      id,
      -32603,
      getGpuSupportDisabledMessage("GPU runtime execution"),
      { type: "GPU_SUPPORT_DISABLED", app_id: app.id },
    );
  }

  if (app.gpu_status !== "live") {
    return jsonRpcErrorResponse(
      id,
      -32603,
      buildGpuNotReadyMessage(app.gpu_status),
      buildGpuStatusDiagnostics(app.gpu_status, { appId: app.id }),
    );
  }

  // Acquire concurrency slot (429 if full after 5s wait)
  let gpuSlot;
  try {
    gpuSlot = await acquireGpuSlot(
      app.gpu_endpoint_id as string,
      (app.gpu_concurrency_limit as number) || 5,
    );
  } catch (_concurrencyErr) {
    return jsonRpcErrorResponse(
      id,
      -32000,
      "GPU function is at capacity. Please try again in a few seconds.",
      { type: "GPU_CONCURRENCY_LIMIT" },
    );
  }

  try {
    // Execute on GPU
    const receiptId = createExecutionReceiptId();
    const gpuExecStart = Date.now();
    const gpuResult = await executeGpuFunction({
      app,
      functionName,
      args,
      executionId: crypto.randomUUID(),
    });
    const gpuExecDuration = Date.now() - gpuExecStart;

    const gpuCallSource = user?.provisional ? "onboarding_template" : undefined;
    const { settlement: gpuSettlement } = await settleAndLogGpuExecution({
      receiptId,
      userId,
      user,
      app,
      functionName,
      inputArgs: args,
      method: "tools/call",
      callerAppId: meta?.callerAppId ?? null,
      callChainDepth: meta?.callChainDepth ?? null,
      gpuResult,
      durationMs: gpuExecDuration,
      sessionId: meta?.sessionId,
      sequenceNumber: nextSequenceNumber(meta?.sessionId),
      userQuery: meta?.userQuery,
      source: gpuCallSource,
      routineContext: meta?.routineContext,
      widgetAction: meta?.widgetAction,
      agenticSurfaceAction: meta?.agenticSurfaceAction,
    });

    if (gpuSettlement?.insufficientBalance) {
      return jsonRpcResponse(id, {
        isError: true,
        content: [{
          type: "text",
          text: gpuSettlement.insufficientBalanceMessage!,
        }],
      });
    }

    // Return result (same format as Deno sandbox)
    if (gpuResult.success) {
      return jsonRpcResponse(
        id,
        formatToolResult(gpuResult.result, gpuResult.logs, receiptId),
      );
    } else {
      return jsonRpcResponse(id, formatToolError(gpuResult.error, receiptId));
    }
  } finally {
    gpuSlot.release();
  }
}

async function executeAppFunction(
  id: JsonRpcId,
  functionName: string,
  args: Record<string, unknown>,
  app: App,
  userId: string,
  user: UserContext | null,
  callerContext: RequestCallerContext,
  meta?: {
    userQuery?: string;
    sessionId?: string;
    authToken?: string;
    widgetPull?: { widgetName?: string; intervalMs?: number; reason?: string };
    widgetAction?: WidgetActionCallMetadata;
    agenticSurfaceAction?: AgenticSurfaceActionCallMetadata;
    routineContext?: RoutineTraceContext;
    callerGrantId?: string | null;
    incomingHop?: number;
    // Skip the durable async dispatch: event-bus deliveries and queue-consumer
    // executions consume results inline — handing them a job envelope would
    // read as a timeout (deliveries) or recurse (consumer).
    disableAsyncPromotion?: boolean;
    // Set by the queue consumer: record the execution outcome on this job row
    // (full fidelity — result, logs, duration, AI spend) after settlement.
    queuedJobId?: string | null;
    // Queue-consumer executions reuse the job row's execution_id so the job,
    // receipt, and AI-spend ledger entries all link to one execution.
    executionId?: string;
    // Queue-consumer executions run with an extended sandbox budget.
    executionTimeoutMs?: number;
  },
): Promise<Response> {
  try {
    // The reserved _async argument is platform routing, never function input —
    // strip it before ANY execution branch (GPU included) sees the args.
    const asyncOptIn = args._async === true;
    if ("_async" in args) delete args._async;

    // ── GPU Runtime Branch (early return) ──
    // Must check BEFORE code fetching since GPU apps don't have JS code in R2.
    if (app.runtime === "gpu") {
      return await handleGpuExecution(
        id,
        app,
        functionName,
        args,
        userId,
        user,
        {
          ...meta,
          callerAppId: callerContext.callerApp?.appId ?? null,
          callChainDepth: callerContext.callerApp?.hop ?? null,
        },
      );
    }

    // ── Durable async dispatch ──
    // Declared-async functions (manifest execution.class) and caller opt-ins
    // (the reserved _async argument) are ENQUEUED instead of executed: the
    // caller gets a job envelope in milliseconds and the queue consumer runs
    // the execution with an extended budget. Async is decided here, at
    // dispatch time, never mid-flight — a mid-execution handoff would mean
    // re-running a non-idempotent function (double side effects/billing).
    //
    // Callers that consume results inline never get a job envelope: routine
    // handlers treat one as a failure and their retry machinery would enqueue
    // duplicate executions; sandbox dependency calls surface it as the
    // dependency's return value, and the sandbox's own bounded budget
    // (30s/120s) cannot usefully poll a multi-minute job — both run
    // synchronously.
    const callerCanPoll = callerContext.authSource !== "routine_actor" &&
      callerContext.authSource !== "sandbox_actor";
    if (!meta?.disableAsyncPromotion && !meta?.queuedJobId && callerCanPoll) {
      const executionPolicy = resolveFunctionExecutionPolicy(app, functionName);
      if (executionPolicy.async || asyncOptIn) {
        const queue = getExecQueue();
        // No queue bound (local dev/tests): fall through to synchronous
        // execution rather than failing the call.
        if (queue) {
          const { createQueuedJob, reclaimJobForSyncFallback } = await import(
            "../services/async-jobs.ts"
          );
          const jobId = await createQueuedJob({
            appId: app.id,
            userId,
            ownerId: app.owner_id,
            functionName,
            args,
            callerAppId: callerContext.callerApp?.appId ?? null,
            callerGrantId: meta?.callerGrantId ?? null,
            hop: callerContext.callerApp?.hop ?? meta?.incomingHop ?? null,
            meta: {
              sessionId: meta?.sessionId,
              userQuery: meta?.userQuery,
              executionTimeoutMs: executionPolicy.timeoutMs,
            },
          });
          let enqueued = false;
          try {
            await queue.send({ jobId });
            enqueued = true;
          } catch (err) {
            // A send() throw does NOT prove non-delivery — the broker may
            // have accepted the message. Only execute synchronously if we
            // win the row back through the same 'queued' status filter the
            // consumer claims through; otherwise the consumer owns it and
            // running here would double-execute.
            console.error("[MCP] EXEC_QUEUE send failed:", err);
            const reclaimed = await reclaimJobForSyncFallback(jobId, {
              type: "QueueError",
              message: err instanceof Error ? err.message : String(err),
            }).catch(() => false);
            if (!reclaimed) enqueued = true;
          }
          if (enqueued) {
            return jsonRpcResponse(id, {
              content: [{
                type: "text",
                text: JSON.stringify({
                  _async: true,
                  job_id: jobId,
                  status: "queued",
                  message:
                    `Execution queued. Poll with ultralight.job({ job_id: "${jobId}" }) on this connection (gx.job on the platform MCP) to get the result.`,
                }),
              }],
              structuredContent: {
                _async: true,
                job_id: jobId,
                status: "queued",
              },
              isError: false,
            });
          }
        }
      }
    }

    // Phase 2C: Run independent setup tasks in parallel
    // - User profile for BYOK (~30ms)
    // - Env var decryption (CPU-only, ~0ms)
    // - Per-user secrets fetch (~30ms, conditional)
    // - Supabase config fetch (~30ms, conditional)
    //
    // NOTE: no R2 entry-code fetch here. The dynamic sandbox executes only
    // the KV ESM bundle (esm:{appId}:latest) and errors with "Run rebuild
    // first" when it's missing — the old per-call R2 read was dead weight.
    const runtimeEnvPromise = resolveAppRuntimeEnvVars(app, userId);

    // --- Supabase config fetch (conditional) ---
    const supabaseConfigPromise = resolveAppSupabaseConfig(app);

    // Await all parallel tasks
    let envResolution;
    let supabaseConfig;
    let d1DataService;
    try {
      [envResolution, supabaseConfig, { d1DataService }] = await Promise
        .all([
          runtimeEnvPromise,
          supabaseConfigPromise,
          createAppD1Resources(app),
        ]);
    } catch (err) {
      if (err instanceof SupabaseConfigMigrationRequiredError) {
        return jsonRpcErrorResponse(id, INVALID_REQUEST, err.message);
      }
      throw err;
    }

    const { envVars, credentials, missingRequiredSecrets } = envResolution;

    // Convert args object to array (positional arguments)
    // For now, pass as single object argument
    // Always pass args object so functions can destructure (even if empty)
    const argsArray = [args];

    if (missingRequiredSecrets.length > 0) {
      return jsonRpcErrorResponse(
        id,
        -32006,
        buildMissingAppSecretsMessage(missingRequiredSecrets),
        buildMissingAppSecretsErrorDetails(app.id, missingRequiredSecrets),
      );
    }

    // ── Deno Sandbox Path (existing, unchanged) ──
    // Execute in sandbox (local — Worker handles data layer only)
    const baseUrl = getEnv("BASE_URL") || undefined;
    // workerBaseUrl not needed — SELF service binding handles internal routing

    const memService = getMemoryService();
    const memoryAdapter = memService
      ? {
        remember: async (key: string, value: unknown) => {
          await memService.remember(userId, `app:${app.id}`, key, value);
        },
        recall: async (key: string) => {
          return await memService.recall(userId, `app:${app.id}`, key);
        },
      }
      : null;

    // AI-capable apps get a longer timeout (120s) since AI calls are inherently slow
    const permissions = resolveStrictManifestPermissions(app).permissions;
    const manifestDependencies = resolveRuntimeAppCallDependencies(
      app,
      callerContext,
    );
    // P5: a user's active cross-Agent grants (and slot bindings) let granted
    // calls be EXPRESSED in-sandbox even when the developer never declared
    // them; the target still authorizes each call via the grant check. One
    // indexed read derives both the dependency set and the slot bindings.
    let grantDependencies: typeof manifestDependencies = [];
    let slotBindings: Awaited<
      ReturnType<typeof resolveCallerGrantBindings>
    >["slots"] = [];
    let callerContextToken: string | undefined;
    if (userId && userId !== ANONYMOUS_USER_ID) {
      try {
        const bindings = await resolveCallerGrantBindings(userId, app.id);
        grantDependencies = bindings.dependencies;
        slotBindings = bindings.slots;
      } catch (err) {
        console.warn("[MCP] Failed to resolve cross-Agent grants:", err);
      }
      // Mint the unforgeable caller context this Agent attaches to ITS OWN
      // outbound cross-Agent calls. Best-effort: a missing signing secret
      // disables outbound grant-gated calls rather than failing this call.
      try {
        callerContextToken = await mintCallerContextToken({
          callerAppId: app.id,
          userId,
          callerFunction: functionName,
          incomingHop: meta?.incomingHop ?? 0,
        });
      } catch (err) {
        console.warn("[MCP] Failed to mint caller context token:", err);
      }
    }
    const appCallDependencies = [...manifestDependencies, ...grantDependencies];
    // Queue-consumer executions (meta.executionTimeoutMs) get an extended
    // budget, hard-capped at the platform ceiling; sync requests keep the
    // 120s (AI) / 30s windows. The same value sizes the cloud-usage hold.
    const timeoutMs = meta?.executionTimeoutMs
      ? Math.min(meta.executionTimeoutMs, MAX_ASYNC_EXECUTION_MS)
      : permissions.includes("ai:call")
      ? 120_000
      : 30_000;
    const inferenceSelection = permissions.includes("ai:call")
      ? await resolveFunctionInferenceOverride({
        userId,
        appId: app.id,
        functionName,
      })
      : null;
    const runtimeAI = permissions.includes("ai:call")
      ? await createRuntimeAIContext(user, {
        freeMode: callerContext.freeMode,
        inferenceSelection,
      })
      : {
        route: null,
        resolvedRoute: null,
        userApiKey: null,
        aiService: createUnavailableAIService(
          "ai:call permission not granted.",
        ),
        unavailableReason: "ai:call permission not granted.",
      };

    const executionId = meta?.executionId ?? crypto.randomUUID();
    const receiptId = createExecutionReceiptId();
    const widgetPull = meta?.widgetPull;
    const widgetAction = meta?.widgetAction;
    const agenticSurfaceAction = meta?.agenticSurfaceAction;
    const callMethod = widgetPull ? "widget_pull" : "tools/call";
    const widgetPullMetadata = widgetPull
      ? {
        widget_name: widgetPull.widgetName,
        widget_interval_ms: widgetPull.intervalMs,
        widget_pull_reason: widgetPull.reason,
      }
      : {};
    const widgetActionMetadata = widgetAction
      ? {
        widget_action: true,
        widget_surface_id: widgetAction.surfaceId,
        widget_id: widgetAction.widgetId,
        widget_action_id: widgetAction.actionId,
        widget_turn_id: widgetAction.turnId,
      }
      : {};
    const agenticSurfaceActionMetadata = agenticSurfaceAction
      ? {
        agentic_surface_action: true,
        agentic_surface_id: agenticSurfaceAction.surfaceId,
        agentic_interface_id: agenticSurfaceAction.interfaceId,
        agentic_action_id: agenticSurfaceAction.actionId,
        agentic_turn_id: agenticSurfaceAction.turnId,
        agentic_component_id: agenticSurfaceAction.componentId,
      }
      : {};
    const cloudPreflight = await preflightRuntimeCloudHold({
      app,
      userId,
      functionName,
      inputArgs: args,
      receiptId,
      method: callMethod,
      timeoutMs,
      callerAuthState: "authenticated",
      callerAppId: callerContext.callerApp?.appId ?? null,
      routineContext: meta?.routineContext,
      freeMode: callerContext.freeMode,
      byokPresent: callerContext.byokPresent,
      // Per-day load-floor dedup eligibility — uses the SAME predicate the
      // runtime uses to choose loader.get() vs load() (incl. GRANT-resolved
      // deps/slots, invisible to the manifest), so billing can never deem an app
      // per-day-eligible that the runtime keeps on load() (where CF bills the
      // load fee per call). Flag-gated to match the runtime's useGetReuse.
      reuseEligibleForBilling: getEnv("EXECUTED_LOADER_GET_REUSE") === "1" &&
        isolateReuseEligibility({
          userId,
          permissions,
          appCallDependencies,
          slotBindings,
        }).eligible,
    });
    if (cloudPreflight.insufficientBalance) {
      const widgetBalanceMessage = widgetPull
        ? cloudPreflight.insufficientBalanceCode ===
            "owner_sponsor_light_required"
          ? "The app owner needs credits balance before this widget can refresh."
          : "Credits balance is required to refresh this widget."
        : null;
      return jsonRpcErrorResponse(
        id,
        -32009,
        widgetBalanceMessage || cloudPreflight.insufficientBalanceMessage ||
          "Credits balance required to call this app.",
        {
          type: cloudPreflight.insufficientBalanceCode || "LIGHT_REQUIRED",
          receipt_id: receiptId,
          settlement: {
            ...cloudPreflight.metadata,
            ...(widgetPull
              ? {
                widget_pull: true,
                ...widgetPullMetadata,
              }
              : {}),
            ...widgetActionMetadata,
            ...agenticSurfaceActionMetadata,
          },
        },
      );
    }

    const widgetPullUsage = widgetPull
      ? await (async () => {
        try {
          return await debitWidgetPullUsage({
            preflight: cloudPreflight,
            app,
            userId,
            functionName,
            receiptId,
            widgetName: widgetPull.widgetName,
            widgetIntervalMs: widgetPull.intervalMs,
            widgetPullReason: widgetPull.reason,
            routineContext: meta?.routineContext,
          });
        } catch (err) {
          console.error("[PRICING] Widget pull usage debit failed:", err);
          const ownerSponsored = cloudPreflight.hold?.ownerSponsoredInfra ===
            true;
          return jsonRpcErrorResponse(
            id,
            -32009,
            ownerSponsored
              ? "The app owner needs credits balance before this widget can refresh."
              : "Credits balance is required to refresh this widget.",
            {
              type: ownerSponsored
                ? "owner_sponsor_light_required"
                : "caller_light_required",
              receipt_id: receiptId,
              settlement: {
                ...cloudPreflight.metadata,
                widget_pull: true,
                ...widgetPullMetadata,
                ...widgetActionMetadata,
                ...agenticSurfaceActionMetadata,
              },
            },
          );
        }
      })()
      : null;
    if (widgetPullUsage instanceof Response) {
      return widgetPullUsage;
    }

    const cloudOperationMetering = createRuntimeOperationMeteringContext({
      preflight: cloudPreflight,
      app,
      userId,
      functionName,
      receiptId,
      method: callMethod,
      metadata: {
        surface: "mcp_tools_call",
        ...widgetPullMetadata,
        ...widgetActionMetadata,
        ...agenticSurfaceActionMetadata,
        widget_pull_event_id: widgetPullUsage?.eventId,
        widget_pull_cloud_units: widgetPullUsage?.cloudUnits,
        widget_pull_amount_light: widgetPullUsage?.amountLight,
      },
      routineContext: meta?.routineContext,
    });
    // Use Worker-backed data service if configured (native R2 bindings, ~10x faster)
    // Wrap with metered service when userId is present to track user data storage.
    const _wUrl = getEnv("WORKER_DATA_URL");
    const _wSecret = getEnv("WORKER_SECRET");
    const _rawAppDataService2 = (_wUrl && _wSecret)
      ? createWorkerAppDataService(app.id, userId, _wUrl, _wSecret, {
        operationMetering: cloudOperationMetering,
        billingConfig: cloudPreflight.billingConfig,
      })
      : createAppDataService(app.id, userId, {
        operationMetering: cloudOperationMetering,
        billingConfig: cloudPreflight.billingConfig,
      });
    const appDataService = userId
      ? createMeteredAppDataService(_rawAppDataService2, userId)
      : _rawAppDataService2;

    const sandboxConfig = {
      appId: app.id,
      userId,
      ownerId: app.owner_id,
      expectedVersion: app.current_version || undefined,
      executionId,
      // Unused by the dynamic sandbox (it executes the KV ESM bundle); kept
      // only to satisfy RuntimeConfig until the legacy Deno path is removed.
      code: "",
      permissions,
      allowedDestinations: getManifestAllowedDestinations(app.manifest),
      userApiKey: runtimeAI.userApiKey,
      aiUnavailableReason: runtimeAI.unavailableReason,
      aiRoute: runtimeAI.route,
      user,
      appDataService,
      d1DataService,
      memoryService: memoryAdapter,
      aiService: runtimeAI.aiService as {
        call: (request: AIRequest, apiKey: string) => Promise<AIResponse>;
      },
      envVars,
      credentials,
      supabase: supabaseConfig,
      baseUrl,
      authToken: meta?.authToken,
      appCallDependencies,
      callerContextToken,
      slotBindings,
      workerSecret: getEnv("WORKER_SECRET") || undefined,
      timeoutMs,
      cloudOperationMetering,
      cloudOperationBillingConfig: cloudPreflight.billingConfig,
    };

    // Helper: run billing + logging after execution completes (used by both sync and async paths)
    const runPostExecution = async (
      result: {
        success: boolean;
        result: unknown;
        error?: unknown;
        logs: Array<{ time: string; level: string; message: string }>;
        durationMs: number;
        aiCostLight: number;
      },
    ) => {
      const callSource = widgetPull
        ? "widget_pull"
        : user?.provisional
        ? "onboarding_template"
        : undefined;
      const cloudSettlement = await settleRuntimeCloudPreflight(
        cloudPreflight,
        result.durationMs,
        {
          success: result.success,
          error_message: result.success ? null : String(result.error),
          ...widgetPullMetadata,
          ...widgetActionMetadata,
          ...agenticSurfaceActionMetadata,
          widget_pull_event_id: widgetPullUsage?.eventId,
          widget_pull_cloud_units: widgetPullUsage?.cloudUnits,
          widget_pull_amount_light: widgetPullUsage?.amountLight,
          ...(meta?.routineContext
            ? {
              routine_id: meta.routineContext.routineId,
              routine_run_id: meta.routineContext.routineRunId,
              trace_id: meta.routineContext.traceId ?? null,
            }
            : {}),
        },
      );
      const { settlement } = await settleAndLogAppExecution({
        receiptId,
        userId,
        user,
        app,
        functionName,
        method: callMethod,
        success: result.success,
        durationMs: result.durationMs,
        errorMessage: result.success ? undefined : String(result.error),
        source: callSource,
        inputArgs: args,
        outputResult: result.success ? result.result : result.error,
      runtimeLogs: result.logs,
        aiCostLight: result.aiCostLight || 0,
        sessionId: meta?.sessionId,
        sequenceNumber: nextSequenceNumber(meta?.sessionId),
        userQuery: meta?.userQuery,
        callerAuthState: "authenticated",
        callerAppId: callerContext.callerApp?.appId ?? null,
        callChainDepth: callerContext.callerApp?.hop ?? null,
        runtimePricingPreflight: cloudPreflight.pricing,
        runtimeCloudSettlement: cloudSettlement,
        routineContext: meta?.routineContext,
        widgetAction: meta?.widgetAction,
        agenticSurfaceAction: meta?.agenticSurfaceAction,
      });

      // P5: attribute the credits this cross-Agent call consumed to its grant's
      // monthly window (drives the per-grant spend cap). Best-effort.
      if (meta?.callerGrantId) {
        const grantSpend = (settlement?.chargedLight ?? 0) +
          (result.aiCostLight || 0);
        if (grantSpend > 0) {
          await recordGrantSpend(meta.callerGrantId, grantSpend);
        }
      }

      return settlement;
    };

    // Start execution (Dynamic Worker sandbox — avoids `new Function()` restriction on CF Workers)
    const { executeInDynamicSandbox } = await import(
      "../runtime/dynamic-sandbox.ts"
    );
    const executionPromise = executeInDynamicSandbox(
      sandboxConfig,
      functionName,
      argsArray,
    );

    // Synchronous execution. Sync calls complete (or fail honestly at their
    // timeout) within the request — the old mid-flight "promotion" race is
    // gone: it could never deliver a result (sub-isolates die with the parent
    // response; waitUntil caps at ~30s) and only produced zombie job rows.
    // Long work goes through the dispatch-time queue branch above instead.
    const result = await executionPromise;
    const settlement = await runPostExecution(result);

    // Durable-job bookkeeping: a queue-consumer execution records its outcome
    // on the job row with full fidelity (result, logs, duration, AI spend).
    if (meta?.queuedJobId) {
      const { completeJob, failJob } = await import(
        "../services/async-jobs.ts"
      );
      if (result.success && settlement.insufficientBalance) {
        await failJob(meta.queuedJobId, {
          type: settlement.insufficientBalanceCode || "LIGHT_REQUIRED",
          message: settlement.insufficientBalanceMessage ||
            "Credits balance required to call this app.",
        }, result.durationMs, {
          aiCostLight: result.aiCostLight,
          logs: result.logs,
        });
      } else {
        await completeJob(meta.queuedJobId, {
          success: result.success,
          result: result.success ? result.result : result.error,
          logs: result.logs,
          durationMs: result.durationMs,
          aiCostLight: result.aiCostLight,
        });
      }
    }

    if (result.success && settlement.insufficientBalance) {
      return jsonRpcErrorResponse(
        id,
        -32009,
        settlement.insufficientBalanceMessage ||
          "Credits balance required to call this app.",
        {
          type: settlement.insufficientBalanceCode || "LIGHT_REQUIRED",
          receipt_id: receiptId,
          settlement: settlement.metadata,
        },
      );
    }

    // Fire-and-forget: rebuild entity index after successful execution
    if (result.success) {
      import("../services/entity-index.ts")
        .then(({ rebuildEntityIndex }) => rebuildEntityIndex(userId))
        .catch((err) =>
          console.error("[MCP] Entity index rebuild failed:", err)
        );
    }

    if (result.success) {
      // Auto-stamp widget responses with app version for client cache busting
      if (isWidgetAppResponse(result.result)) {
        result.result.version = app.current_version || "1";
      }
      return jsonRpcResponse(
        id,
        formatToolResult(result.result, result.logs, receiptId),
      );
    } else {
      return jsonRpcResponse(id, formatToolError(result.error, receiptId));
    }
  } catch (err) {
    console.error(`App function ${functionName} error:`, err);
    return jsonRpcResponse(id, formatToolError(err));
  }
}

// ============================================
// EVENT DELIVERY (Phase 4.5 / P5 pub/sub)
// ============================================

// Invoke a subscriber's handler for a delivered event. The dispatcher has
// ALREADY authorized (resolved the active subscribe grant + checked its cap),
// so this reuses executeAppFunction's full billing / settlement / attribution /
// recordGrantSpend path WITHOUT re-running the chokepoint — caller_app_id is
// the emitter, the spend lands on the subscribe grant's monthly cap, and the
// hop is carried so a handler that re-emits stays bounded.
export async function executeEventDelivery(input: {
  subscriberAppId: string;
  targetFunction: string;
  payload: Record<string, unknown>;
  userId: string;
  emitterAppId: string;
  grantId: string;
  hop: number;
}): Promise<{ success: boolean; receiptId: string | null; error?: string }> {
  const appsService = createAppsService();
  const app = await appsService.findById(input.subscriberAppId);
  if (!app || app.deleted_at) {
    return { success: false, receiptId: null, error: "Subscriber Agent not found" };
  }

  let user: UserContext | null = null;
  let econ = deriveCallerEconomicState(null);
  try {
    const { createUserService } = await import("../services/user.ts");
    const profile = await createUserService().getUser(input.userId);
    if (profile) {
      user = {
        id: profile.id,
        email: profile.email,
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
        tier: profile.tier,
      };
      econ = deriveCallerEconomicState(profile);
    }
  } catch (err) {
    console.warn("[EVENT-DELIVERY] Failed to load user context:", err);
  }

  const callerContext: RequestCallerContext = {
    authState: "authenticated",
    authSource: "routine_actor",
    authUser: null,
    userId: input.userId,
    user,
    userProfile: null,
    userApiKey: null,
    ...econ,
    tokenAppIds: null,
    tokenFunctionNames: null,
    // The verified emitter identity drives attribution + the subscriber's own
    // outbound caller-context (minted at hop + 1 inside executeAppFunction).
    callerApp: {
      appId: input.emitterAppId,
      callerFunction: null,
      hop: input.hop,
    },
  };

  const response = await executeAppFunction(
    crypto.randomUUID(),
    input.targetFunction,
    input.payload,
    app,
    input.userId,
    user,
    callerContext,
    {
      callerGrantId: input.grantId,
      incomingHop: input.hop,
      sessionId: undefined,
      disableAsyncPromotion: true,
    },
  );

  try {
    const body = await response.json() as JsonRpcResponse;
    return parseDeliveryOutcome(body);
  } catch {
    return { success: false, receiptId: null, error: "Unreadable delivery response" };
  }
}

// Interpret a delivery invocation's JSON-RPC body. Exported for tests.
// Execution failures surface as tool RESULTS with isError: true (the JSON-RPC
// layer succeeded; the function did not — formatToolError shape). Treating
// them as success would mask every handler failure as a delivered event.
export function parseDeliveryOutcome(
  body: JsonRpcResponse,
): { success: boolean; receiptId: string | null; error?: string } {
  if (body.error) {
    return {
      success: false,
      // Billing-relevant errors (e.g. -32009 insufficient balance AFTER a
      // settled execution) carry the receipt in error.data — keep the link.
      receiptId: extractReceiptIdFromResult(
        (body.error as { data?: unknown }).data,
      ),
      error: body.error.message || "Delivery failed",
    };
  }
  const receiptId = extractReceiptIdFromResult(body.result);
  const toolResult = body.result as
    | {
      isError?: boolean;
      structuredContent?: {
        error?: unknown;
        _async?: unknown;
        job_id?: unknown;
        status?: unknown;
      };
      content?: Array<{ type?: string; text?: string }>;
    }
    | undefined;
  // An async-promotion envelope means the handler did NOT complete within the
  // delivery window — recording it as delivered would mask a timeout. Defense
  // in depth: deliveries pass disableAsyncPromotion so this shape should never
  // occur; match the FULL platform envelope so a tenant result that merely
  // echoes `_async: true` (e.g. proxying an inner promoted call) is less
  // likely to collide. (PR3's queue-backed execution replaces this entirely.)
  const sc = toolResult?.structuredContent;
  if (
    sc?._async === true && typeof sc.job_id === "string" &&
    sc.status === "running"
  ) {
    return {
      success: false,
      receiptId,
      error: "Delivery handler exceeded the synchronous execution window",
    };
  }
  if (toolResult?.isError) {
    const structuredError = toolResult.structuredContent?.error;
    const error = typeof structuredError === "string" && structuredError
      ? structuredError
      : toolResult.content?.find((c) => c.type === "text" && c.text)?.text ||
        "Delivery handler failed";
    return { success: false, receiptId, error };
  }
  return { success: true, receiptId };
}

// ============================================
// QUEUED EXECUTION (PR3 durable async)
// ============================================

// Run a queue-claimed job through the full execution pipeline. Mirrors
// executeEventDelivery: caller context is rebuilt from the persisted scalars
// (the user's bearer token never rides the queue — queued executions cannot
// make as-the-user calls; grant-gated cross-Agent calls are unaffected since
// the caller token is minted fresh in-pipeline). The job outcome is recorded
// on the row INSIDE executeAppFunction (meta.queuedJobId) with full fidelity;
// this wrapper only handles can't-even-start failures.
export async function executeQueuedJob(
  job: import("../services/async-jobs.ts").AsyncJob,
): Promise<void> {
  const { failJobIfActive } = await import("../services/async-jobs.ts");
  const startedAt = Date.now();

  const appsService = createAppsService();
  const app = await appsService.findById(job.app_id);
  if (!app || app.deleted_at) {
    await failJobIfActive(job.id, {
      type: "AppNotFound",
      message: "The Agent for this job no longer exists",
    }, Date.now() - startedAt);
    return;
  }

  // GPU apps cannot be queued at dispatch (the GPU branch precedes the queue
  // branch), so a GPU runtime here means the app changed between enqueue and
  // claim. The GPU pipeline has no job bookkeeping — running it would bill an
  // execution whose result the row could never report. Refuse instead.
  if (app.runtime === "gpu") {
    await failJobIfActive(job.id, {
      type: "AppRuntimeChanged",
      message:
        "The Agent switched to the GPU runtime after this job was queued — re-run the function directly",
    }, Date.now() - startedAt);
    return;
  }

  let user: UserContext | null = null;
  let econ = deriveCallerEconomicState(null);
  try {
    const { createUserService } = await import("../services/user.ts");
    const profile = await createUserService().getUser(job.user_id);
    if (profile) {
      user = {
        id: profile.id,
        email: profile.email,
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
        tier: profile.tier,
      };
      econ = deriveCallerEconomicState(profile);
    }
  } catch (err) {
    console.warn("[QUEUE-EXEC] Failed to load user context:", err);
  }

  const callerContext: RequestCallerContext = {
    authState: "authenticated",
    authSource: "routine_actor",
    authUser: null,
    userId: job.user_id,
    user,
    userProfile: null,
    userApiKey: null,
    ...econ,
    tokenAppIds: null,
    tokenFunctionNames: null,
    callerApp: job.caller_app_id
      ? {
        appId: job.caller_app_id,
        callerFunction: null,
        hop: job.hop ?? 1,
      }
      : undefined,
  };

  // Cross-Agent jobs were grant-checked at dispatch, but the queue introduces
  // a dispatch→execution gap synchronous calls never had: re-check that the
  // grant is still active so a revocation between enqueue and claim is
  // honored (cap accounting still happens in-pipeline via callerGrantId).
  if (job.caller_grant_id) {
    try {
      const { getGrant } = await import("../services/agent-grants.ts");
      const grant = await getGrant(job.user_id, job.caller_grant_id);
      if (!grant || grant.status !== "active") {
        await failJobIfActive(job.id, {
          type: "GrantRevoked",
          message:
            "The cross-Agent grant for this job was revoked before it executed",
        }, Date.now() - startedAt);
        return;
      }
    } catch (err) {
      console.warn("[QUEUE-EXEC] Grant re-check failed, refusing to run:", err);
      await failJobIfActive(job.id, {
        type: "GrantCheckFailed",
        message: "Could not verify the cross-Agent grant for this job",
      }, Date.now() - startedAt);
      return;
    }
  }

  const metaTimeout = job.meta &&
      typeof job.meta.executionTimeoutMs === "number"
    ? job.meta.executionTimeoutMs
    : null;

  const response = await executeAppFunction(
    crypto.randomUUID(),
    job.function_name,
    (job.args && typeof job.args === "object" ? job.args : {}) as Record<
      string,
      unknown
    >,
    app,
    job.user_id,
    user,
    callerContext,
    {
      callerGrantId: job.caller_grant_id,
      incomingHop: job.hop ?? undefined,
      sessionId: typeof job.meta?.sessionId === "string"
        ? job.meta.sessionId
        : undefined,
      userQuery: typeof job.meta?.userQuery === "string"
        ? job.meta.userQuery
        : undefined,
      disableAsyncPromotion: true,
      queuedJobId: job.id,
      executionId: job.execution_id || undefined,
      executionTimeoutMs: metaTimeout ?? undefined,
    },
  );

  // The job row was finalized inside executeAppFunction (meta.queuedJobId).
  // A failure surfacing HERE means the pipeline threw before the bookkeeping:
  // JSON-RPC errors (missing secrets, preflight insufficient balance) AND
  // thrown errors the outer catch formats as isError tool RESULTS (D1/env
  // resolution, settlement throws) — the same shape lesson as deliveries, so
  // reuse parseDeliveryOutcome. failJobIfActive's status guard makes this a
  // no-op whenever the in-pipeline bookkeeping already settled the row.
  try {
    const body = await response.json() as JsonRpcResponse;
    const outcome = parseDeliveryOutcome(body);
    if (!outcome.success) {
      const errorData = body.error?.data as { type?: unknown } | undefined;
      await failJobIfActive(job.id, {
        type: typeof errorData?.type === "string" && errorData.type
          ? errorData.type
          : "ExecutionError",
        message: outcome.error || "Queued execution failed",
      }, Date.now() - startedAt);
    }
  } catch {
    await failJobIfActive(job.id, {
      type: "ExecutionError",
      message: "Unreadable queued execution response",
    }, Date.now() - startedAt);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractReceiptIdFromResult(result: unknown): string | null {
  // executeAppFunction stamps the receipt id into structuredContent (success:
  // attachExecutionReceipt; failure: formatToolError) — read it from there,
  // with the top level kept as a defensive fallback. Must be a uuid — the
  // deliveries.receipt_id column rejects anything else, and a failed PATCH
  // would otherwise leave the delivery row stuck 'pending'.
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const structured = (r.structuredContent && typeof r.structuredContent === "object")
    ? r.structuredContent as Record<string, unknown>
    : null;
  for (const candidate of [
    structured?.receipt_id,
    structured?.receiptId,
    r.receipt_id,
    r.receiptId,
  ]) {
    if (typeof candidate === "string" && UUID_RE.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ============================================
// HELPERS
// ============================================

/**
 * Convert SkillFunction to MCPTool format
 */
/**
 * Format successful tool result for MCP response
 */
function formatToolResult(
  result: unknown,
  logs?: Array<{ message: string }> | string[],
  receiptId?: string,
): MCPToolCallResponse {
  const content: MCPContent[] = [];
  const responseResult = receiptId
    ? attachExecutionReceipt(result, receiptId)
    : result;

  // Add result as text
  if (result !== undefined && result !== null) {
    content.push({
      type: "text",
      text: typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2),
    });
  }

  // Add logs if present
  const logMessages =
    logs?.map((log) => typeof log === "string" ? log : log.message) || [];
  if (logMessages.length > 0) {
    content.push({
      type: "text",
      text: `\n--- Logs ---\n${logMessages.join("\n")}`,
    });
  }

  if (receiptId) {
    content.push({
      type: "text",
      text: `\n--- Receipt ---\n${receiptId}`,
    });
  }

  return {
    content,
    structuredContent: responseResult,
    isError: false,
  };
}

function attachExecutionReceipt(result: unknown, receiptId: string): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), receipt_id: receiptId };
  }
  return { result, receipt_id: receiptId };
}

/**
 * Format tool error for MCP response
 */
function formatToolError(
  err: unknown,
  receiptId?: string,
): MCPToolCallResponse {
  const message = err instanceof Error
    ? err.message
    : (err as { message?: string })?.message || String(err);

  return {
    content: [
      {
        type: "text",
        text: `Error: ${message}`,
      },
      ...(receiptId
        ? [{
          type: "text" as const,
          text: `\n--- Receipt ---\n${receiptId}`,
        }]
        : []),
    ],
    structuredContent: receiptId
      ? { error: message, receipt_id: receiptId }
      : undefined,
    isError: true,
  };
}

/**
 * Create JSON-RPC success response
 */
function jsonRpcResponse(id: JsonRpcId, result: unknown): Response {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: normalizeJsonRpcResponseId(id),
    result,
  };

  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Create JSON-RPC error response
 */
function jsonRpcErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): Response {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: normalizeJsonRpcResponseId(id),
    error: { code, message, data },
  };

  return new Response(JSON.stringify(response), {
    status: code === RATE_LIMITED
      ? 429
      : code === PAYMENT_REQUIRED
      ? 402
      : code < 0
      ? 400
      : 500,
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================
// WELL-KNOWN MCP DISCOVERY
// ============================================

/**
 * Handle MCP discovery endpoint
 * GET /a/:appId/.well-known/mcp.json
 */
export async function handleMcpDiscovery(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const appsService = createAppsService();
    const app = await appsService.findById(appId);

    if (!app) {
      return error("App not found", 404);
    }

    // Check visibility for private apps
    if (app.visibility === "private") {
      try {
        const caller = await resolveRequestCallerContext(request, {
          authSourcePolicy: "bearer_or_cookie",
        });
        if (caller.userId !== app.owner_id) {
          return error("App not found", 404);
        }
      } catch {
        return error("App not found", 404);
      }
    }

    const contractResolution = resolveAppFunctionContracts(app);
    logAppContractResolution({
      appId: app.id,
      ownerId: app.owner_id,
      appSlug: app.slug,
      runtime: app.runtime,
      surface: "mcp_discovery",
      source: contractResolution.source,
      legacySourceDetected: contractResolution.legacySourceDetected,
      functionCount: contractResolution.functions.length,
      manifestBacked: contractResolution.manifestBacked,
      migrationRequired: contractResolution.migrationRequired,
    });

    // Count tools using canonical manifest-backed contracts only.
    const appToolsCount = contractResolution.manifestBacked
      ? contractResolution.functions.length
      : 0;
    const totalTools = appToolsCount + SDK_TOOLS.length;

    const response = {
      name: app.name || app.slug,
      description: app.description || undefined,
      transport: {
        type: "http-post",
        url: `/mcp/${appId}`,
      },
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      tools_count: totalTools,
      app_tools: appToolsCount,
      sdk_tools: SDK_TOOLS.length,
      resources_count: 2 + (hasSkillContext(app) ? 2 : 0),
      contract_source: contractResolution.manifestBacked
        ? "manifest"
        : (contractResolution.legacySourceDetected || "none"),
      manifest_backed: contractResolution.manifestBacked,
      migration_required: contractResolution.migrationRequired,
      contract_message: contractResolution.message || undefined,
    };

    return json(response);
  } catch (err) {
    console.error("MCP discovery error:", err);
    return error("Failed to get MCP info", 500);
  }
}
