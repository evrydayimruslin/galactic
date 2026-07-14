// Embedding Service
// Uses OpenRouter to generate embeddings for semantic search
// Default model: text-embedding-3-small (OpenAI via OpenRouter)

import { getEnv } from "../lib/env.ts";
import type {
  AppManifest,
  ManifestFunction,
} from "../../shared/contracts/manifest.ts";
import type { ParsedSkills } from "../../shared/types/index.ts";
import { buildEconomicIdempotencyKey } from "./economic-idempotency.ts";
import {
  type EmbeddingChargeResult,
  recordEmbeddingGenerationCharge,
} from "./embedding-billing.ts";

// ============================================
// TYPES
// ============================================

export interface EmbeddingConfig {
  apiKey: string;
  model?: string;
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

// "skill" and "widget" are legacy row values: generation no longer emits them
// and default searches no longer request them, but existing rows keep them
// (no migration) and search results may still surface them when requested.
export type ToolSemanticSubjectType =
  | "app"
  | "function"
  | "skill"
  | "widget"
  | "platform_primitive";

export type ToolSemanticEmbeddingStatus =
  | "pending"
  | "ready"
  | "failed"
  | "disabled";

export interface ToolSemanticEmbeddingUpsertParams {
  appId?: string | null;
  appVersion?: string | null;
  subjectType: ToolSemanticSubjectType;
  subjectId: string;
  embedding?: number[] | null;
  embeddingText: string;
  embeddingTextHash?: string | null;
  model: string;
  provider?: string | null;
  embeddingChargeId?: string | null;
  status?: ToolSemanticEmbeddingStatus;
  metadata?: Record<string, unknown>;
}

export interface ToolSemanticEmbeddingRow {
  id: string;
  app_id: string | null;
  app_version: string;
  subject_type: ToolSemanticSubjectType;
  subject_id: string;
  embedding_text: string;
  embedding_text_hash: string;
  model: string;
  provider: string;
  embedding_charge_id: string | null;
  status: ToolSemanticEmbeddingStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ToolSemanticEmbeddingSearchOptions {
  limit?: number;
  threshold?: number;
  subjectTypes?: ToolSemanticSubjectType[];
  appVersion?: string | null;
  visibility?: string[] | null;
  includePlatformPrimitives?: boolean;
}

export interface ToolSemanticEmbeddingAppInfo {
  id: string;
  owner_id: string;
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  tags?: string[] | null;
  manifest?: unknown;
  skills_parsed?: ParsedSkills | null;
  skills_md?: string | null;
  current_version?: string | null;
  app_type?: string | null;
}

export interface ToolSemanticEmbeddingSubject {
  subjectType: ToolSemanticSubjectType;
  subjectId: string;
  label: string;
  embeddingText: string;
  metadata: Record<string, unknown>;
}

export interface ToolSemanticEmbeddingSubjectResult {
  subjectType: ToolSemanticSubjectType;
  subjectId: string;
  embeddingTextHash: string;
  status: ToolSemanticEmbeddingStatus | "skipped";
  rowId: string | null;
  embeddingChargeId: string | null;
  chargeStatus: EmbeddingChargeResult["status"] | "not_attempted" | null;
  embedding?: number[] | null;
  error?: string | null;
}

export interface ToolSemanticEmbeddingGenerationResult {
  appId: string;
  appVersion: string;
  subjects: ToolSemanticEmbeddingSubjectResult[];
  appEmbedding: ToolSemanticEmbeddingSubjectResult | null;
  readyCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface GenerateToolSemanticEmbeddingsParams {
  app: ToolSemanticEmbeddingAppInfo;
  appVersion?: string | null;
  manifest?: AppManifest | null;
  skillsParsed?: ParsedSkills | null;
  searchHints?: string[] | null;
  embeddingService?: Pick<EmbeddingService, "embed"> | null;
  recordCharge?: typeof recordEmbeddingGenerationCharge;
  upsertEmbedding?: typeof upsertToolSemanticEmbedding;
}

export interface ToolSemanticEmbeddingSearchResult {
  embedding_id: string;
  app_id: string | null;
  app_version: string;
  subject_type: ToolSemanticSubjectType;
  subject_id: string;
  subject_label: string | null;
  embedding_text: string;
  embedding_text_hash: string;
  model: string;
  provider: string;
  embedding_charge_id: string | null;
  status: ToolSemanticEmbeddingStatus;
  metadata: Record<string, unknown>;
  similarity: number;
  app_name: string | null;
  app_slug: string | null;
  app_description: string | null;
  app_owner_id: string | null;
  app_visibility: string | null;
  app_current_version: string | null;
}

interface SupabaseRpcDeps {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  supabaseKey?: string;
}

// ============================================
// CONSTANTS
// ============================================

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_MODEL = "openai/text-embedding-3-small";
const DEFAULT_EMBEDDING_PROVIDER = "openrouter";
const TOOL_SEMANTIC_EMBEDDING_MAX_WORDS = 6000;

interface EmbeddingApiResponse {
  data?: Array<{ embedding: number[]; index: number }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

function toPgVector(embedding: number[]): string {
  return `[${embedding.filter(Number.isFinite).join(",")}]`;
}

function getSupabaseRpcConfig(deps: SupabaseRpcDeps = {}): {
  supabaseUrl: string;
  supabaseKey: string;
  fetchFn: typeof fetch;
} {
  const supabaseUrl = deps.supabaseUrl || getEnv("SUPABASE_URL");
  const supabaseKey = deps.supabaseKey || getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase credentials not configured");
  }

  return {
    supabaseUrl,
    supabaseKey,
    fetchFn: deps.fetchFn || fetch,
  };
}

export async function hashEmbeddingText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

function truncateEmbeddingText(text: string): string {
  return text.split(/\s+/).slice(0, TOOL_SEMANTIC_EMBEDDING_MAX_WORDS).join(
    " ",
  );
}

function stringifySchema(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseStoredManifest(value: unknown): AppManifest | null {
  const candidate = typeof value === "string"
    ? (() => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })()
    : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  return candidate as AppManifest;
}

function appendLine(parts: string[], label: string, value: unknown): void {
  const text = cleanText(value);
  if (text) parts.push(`${label}: ${text}`);
}

function generationHintsText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const hints = value as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(hints.tags) && hints.tags.length > 0) {
    parts.push(
      `tags ${hints.tags.filter((tag) => typeof tag === "string").join(", ")}`,
    );
  }
  appendLine(parts, "preferred component", hints.preferred_component);
  if (
    Array.isArray(hints.entity_types) && hints.entity_types.length > 0
  ) {
    parts.push(
      `entity types ${
        hints.entity_types.filter((entry) => typeof entry === "string").join(
          ", ",
        )
      }`,
    );
  }
  appendLine(parts, "action group", hints.action_group);
  if (Array.isArray(hints.prompt_examples) && hints.prompt_examples.length) {
    parts.push(
      `examples ${
        hints.prompt_examples.filter((entry) => typeof entry === "string")
          .slice(0, 3).join(" | ")
      }`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function manifestFunctionText(
  app: ToolSemanticEmbeddingAppInfo,
  name: string,
  fn: ManifestFunction,
): string {
  const parts = [
    `Tool: ${app.name || app.slug || app.id}`,
    `Function: ${name}`,
  ];
  appendLine(parts, "Tool description", app.description);
  appendLine(parts, "Function description", fn.description);
  const params = fn.parameters || {};
  const paramText = Object.entries(params).map(([paramName, param]) => {
    const schemaText = stringifySchema(param);
    return schemaText ? `${paramName} ${schemaText}` : paramName;
  });
  if (paramText.length > 0) parts.push(`Parameters: ${paramText.join("; ")}`);
  if (fn.returns) {
    parts.push(`Returns: ${stringifySchema(fn.returns) || fn.returns.type}`);
  }
  if (fn.examples?.length) {
    parts.push(`Examples: ${fn.examples.slice(0, 3).join(" | ")}`);
  }
  appendLine(
    parts,
    "Generation hints",
    generationHintsText(fn.generation_hints),
  );
  return truncateEmbeddingText(parts.filter(Boolean).join("\n"));
}

function parsedFunctionText(
  app: ToolSemanticEmbeddingAppInfo,
  fn: ParsedSkills["functions"][number],
): string {
  const parts = [
    `Tool: ${app.name || app.slug || app.id}`,
    `Function: ${fn.name}`,
  ];
  appendLine(parts, "Tool description", app.description);
  appendLine(parts, "Function description", fn.description);
  const params = fn.parameters && typeof fn.parameters === "object"
    ? Object.entries(fn.parameters as Record<string, unknown>).map((
      [name, schema],
    ) => `${name} ${stringifySchema(schema) || ""}`.trim())
    : [];
  if (params.length > 0) parts.push(`Parameters: ${params.join("; ")}`);
  return truncateEmbeddingText(parts.filter(Boolean).join("\n"));
}

export function buildToolSemanticEmbeddingSubjects(input: {
  app: ToolSemanticEmbeddingAppInfo;
  manifest?: AppManifest | null;
  skillsParsed?: ParsedSkills | null;
  searchHints?: string[] | null;
}): ToolSemanticEmbeddingSubject[] {
  const manifest = input.manifest ?? parseStoredManifest(input.app.manifest);
  const skillsParsed = input.skillsParsed ?? input.app.skills_parsed ?? null;
  const app = input.app;
  const subjects: ToolSemanticEmbeddingSubject[] = [];

  const appParts = [
    `Tool: ${app.name || app.slug || app.id}`,
  ];
  appendLine(appParts, "Description", app.description);
  const hints = input.searchHints ?? app.tags ?? [];
  if (hints.length > 0) appParts.push(`Keywords: ${hints.join(", ")}`);
  if (manifest?.functions) {
    appParts.push(`Functions: ${Object.keys(manifest.functions).join(", ")}`);
  } else if (skillsParsed?.functions?.length) {
    appParts.push(
      `Functions: ${skillsParsed.functions.map((fn) => fn.name).join(", ")}`,
    );
  }
  if (manifest?.skills) {
    appParts.push(`Skills: ${Object.keys(manifest.skills).join(", ")}`);
  }
  subjects.push({
    subjectType: "app",
    subjectId: "app",
    label: app.name || app.slug || app.id,
    embeddingText: truncateEmbeddingText(appParts.filter(Boolean).join("\n")),
    metadata: {
      label: app.name || app.slug || app.id,
      slug: app.slug || null,
      app_type: app.app_type || null,
      source: "tool_semantic_embedding",
    },
  });

  if (manifest?.functions) {
    for (const [name, fn] of Object.entries(manifest.functions)) {
      subjects.push({
        subjectType: "function",
        subjectId: `function:${name}`,
        label: name,
        embeddingText: manifestFunctionText(app, name, fn),
        metadata: {
          label: name,
          name,
          description: fn.description || null,
          source: "tool_semantic_embedding",
        },
      });
    }
  } else if (skillsParsed?.functions?.length) {
    for (const fn of skillsParsed.functions) {
      subjects.push({
        subjectType: "function",
        subjectId: `function:${fn.name}`,
        label: fn.name,
        embeddingText: parsedFunctionText(app, fn),
        metadata: {
          label: fn.name,
          name: fn.name,
          description: fn.description || null,
          source: "tool_semantic_embedding",
          legacy_source: "skills_parsed",
        },
      });
    }
  }

  return subjects.filter((subject) => subject.embeddingText.trim().length > 0);
}

function subjectChargeIdempotencyKey(input: {
  appId: string;
  appVersion: string;
  model: string;
  subject: ToolSemanticEmbeddingSubject;
  embeddingTextHash: string;
}): string {
  return buildEconomicIdempotencyKey("embedding_generation", [
    input.appId,
    input.appVersion,
    input.model,
    input.subject.subjectType,
    input.subject.subjectId,
    input.embeddingTextHash,
  ]) ||
    `embedding_generation:${input.appId}:${input.appVersion}:${input.subject.subjectType}:${input.subject.subjectId}:${input.embeddingTextHash}`;
}

export async function generateToolSemanticEmbeddingsForApp(
  params: GenerateToolSemanticEmbeddingsParams,
): Promise<ToolSemanticEmbeddingGenerationResult> {
  const appVersion = params.appVersion || params.app.current_version ||
    "unversioned";
  const subjects = buildToolSemanticEmbeddingSubjects({
    app: params.app,
    manifest: params.manifest,
    skillsParsed: params.skillsParsed,
    searchHints: params.searchHints,
  });
  const embeddingService = params.embeddingService === undefined
    ? createEmbeddingService()
    : params.embeddingService;
  const recordCharge = params.recordCharge ?? recordEmbeddingGenerationCharge;
  const upsertEmbedding = params.upsertEmbedding ?? upsertToolSemanticEmbedding;

  const results: ToolSemanticEmbeddingSubjectResult[] = [];

  if (!embeddingService) {
    for (const subject of subjects) {
      results.push({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        embeddingTextHash: await hashEmbeddingText(subject.embeddingText),
        status: "skipped",
        rowId: null,
        embeddingChargeId: null,
        chargeStatus: "not_attempted",
        error: "embedding_service_unavailable",
      });
    }
    return summarizeToolSemanticEmbeddingGeneration(
      params.app.id,
      appVersion,
      results,
    );
  }

  for (const subject of subjects) {
    const embeddingTextHash = await hashEmbeddingText(subject.embeddingText);
    let embeddingResult: EmbeddingResult | null = null;
    try {
      embeddingResult = await embeddingService.embed(subject.embeddingText);
    } catch (err) {
      const row = await upsertFailedToolSemanticEmbedding({
        upsertEmbedding,
        params,
        appVersion,
        subject,
        embeddingTextHash,
        model: DEFAULT_MODEL,
        failureStage: "provider",
        error: err,
      });
      results.push({
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        embeddingTextHash,
        status: "failed",
        rowId: row?.id || null,
        embeddingChargeId: null,
        chargeStatus: "not_attempted",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const charge = await recordCharge({
      publisherUserId: params.app.owner_id,
      appId: params.app.id,
      appVersion,
      model: embeddingResult.model,
      promptTokens: embeddingResult.usage.prompt_tokens,
      totalTokens: embeddingResult.usage.total_tokens,
      idempotencyKey: subjectChargeIdempotencyKey({
        appId: params.app.id,
        appVersion,
        model: embeddingResult.model,
        subject,
        embeddingTextHash,
      }),
      metadata: {
        source: "tool_semantic_embedding",
        subject_type: subject.subjectType,
        subject_id: subject.subjectId,
        embedding_text_hash: embeddingTextHash,
        embedding_text_bytes: new TextEncoder().encode(subject.embeddingText)
          .byteLength,
      },
    });
    const chargeOk = charge?.status === "charged" ||
      charge?.status === "no_charge";
    const row = await upsertEmbedding({
      appId: params.app.id,
      appVersion,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      embedding: embeddingResult.embedding,
      embeddingText: subject.embeddingText,
      embeddingTextHash,
      model: embeddingResult.model,
      provider: DEFAULT_EMBEDDING_PROVIDER,
      embeddingChargeId: charge?.chargeId || null,
      status: chargeOk ? "ready" : "failed",
      metadata: {
        ...subject.metadata,
        source: "tool_semantic_embedding",
        charge_status: charge?.status || "failed",
        embedding_text_bytes: new TextEncoder().encode(subject.embeddingText)
          .byteLength,
      },
    });
    results.push({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      embeddingTextHash,
      status: chargeOk ? "ready" : "failed",
      rowId: row.id,
      embeddingChargeId: charge?.chargeId || null,
      chargeStatus: charge?.status || "failed",
      embedding: chargeOk ? embeddingResult.embedding : null,
      error: chargeOk ? null : "embedding_charge_not_collected",
    });
  }

  return summarizeToolSemanticEmbeddingGeneration(
    params.app.id,
    appVersion,
    results,
  );
}

async function upsertFailedToolSemanticEmbedding(input: {
  upsertEmbedding: typeof upsertToolSemanticEmbedding;
  params: GenerateToolSemanticEmbeddingsParams;
  appVersion: string;
  subject: ToolSemanticEmbeddingSubject;
  embeddingTextHash: string;
  model: string;
  failureStage: string;
  error: unknown;
}): Promise<ToolSemanticEmbeddingRow | null> {
  try {
    return await input.upsertEmbedding({
      appId: input.params.app.id,
      appVersion: input.appVersion,
      subjectType: input.subject.subjectType,
      subjectId: input.subject.subjectId,
      embedding: null,
      embeddingText: input.subject.embeddingText,
      embeddingTextHash: input.embeddingTextHash,
      model: input.model,
      provider: DEFAULT_EMBEDDING_PROVIDER,
      status: "failed",
      metadata: {
        ...input.subject.metadata,
        source: "tool_semantic_embedding",
        failure_stage: input.failureStage,
        error: input.error instanceof Error
          ? input.error.message
          : String(input.error),
      },
    });
  } catch (err) {
    console.error("[EMBEDDING] Failed to store failed semantic row:", err);
    return null;
  }
}

function summarizeToolSemanticEmbeddingGeneration(
  appId: string,
  appVersion: string,
  subjects: ToolSemanticEmbeddingSubjectResult[],
): ToolSemanticEmbeddingGenerationResult {
  return {
    appId,
    appVersion,
    subjects,
    appEmbedding:
      subjects.find((subject) =>
        subject.subjectType === "app" && subject.subjectId === "app"
      ) || null,
    readyCount: subjects.filter((subject) => subject.status === "ready").length,
    failedCount: subjects.filter((subject) => subject.status === "failed")
      .length,
    skippedCount: subjects.filter((subject) => subject.status === "skipped")
      .length,
  };
}

// ============================================
// EMBEDDING SERVICE
// ============================================

export class EmbeddingService {
  private apiKey: string;
  private model: string;

  constructor(config: EmbeddingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || DEFAULT_MODEL;
  }

  /**
   * Generate embedding for a single text input
   */
  async embed(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<EmbeddingResult> {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://api.ultralightagent.com",
        "X-Title": "Galactic",
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embedding API error: ${response.status} - ${error}`);
    }

    const result = await response.json() as EmbeddingApiResponse;

    if (!result.data?.[0]?.embedding) {
      throw new Error("Invalid embedding response: missing embedding data");
    }

    return {
      embedding: result.data[0].embedding,
      model: result.model || this.model,
      usage: {
        prompt_tokens: result.usage?.prompt_tokens ?? 0,
        total_tokens: result.usage?.total_tokens ?? 0,
      },
    };
  }

  /**
   * Generate embeddings for multiple texts (batch)
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    // OpenRouter supports batch embeddings
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://api.ultralightagent.com",
        "X-Title": "Galactic",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embedding API error: ${response.status} - ${error}`);
    }

    const result = await response.json() as EmbeddingApiResponse;

    if (!result.data || !Array.isArray(result.data)) {
      throw new Error("Invalid embedding response: missing data array");
    }

    // Sort by index to ensure correct order
    const sortedData = result.data.sort((
      a: { index: number },
      b: { index: number },
    ) => a.index - b.index);

    return sortedData.map((item: { embedding: number[] }) => ({
      embedding: item.embedding,
      model: result.model || this.model,
      usage: {
        prompt_tokens: Math.floor(
          (result.usage?.prompt_tokens || 0) / texts.length,
        ),
        total_tokens: Math.floor(
          (result.usage?.total_tokens || 0) / texts.length,
        ),
      },
    }));
  }
}

// ============================================
// FACTORY
// ============================================

/**
 * Create an embedding service using the best available API key.
 *
 * Key priority:
 *   1. User's BYOK key (direct OpenRouter API key)
 *   2. OPENROUTER_EMBEDDING_KEY — dedicated platform embedding key (regular API key)
 *
 * Note: OPENROUTER_API_KEY is often a provisioning key (used to create per-user sub-keys)
 * which cannot call the embeddings endpoint. It is intentionally not used here.
 */
export function createEmbeddingService(
  userApiKey?: string,
): EmbeddingService | null {
  // Try user's BYOK key first
  if (userApiKey) {
    return new EmbeddingService({ apiKey: userApiKey });
  }

  // Try dedicated embedding key (regular API key, not provisioning key)
  const embeddingKey = getEnv("OPENROUTER_EMBEDDING_KEY");
  if (embeddingKey) {
    return new EmbeddingService({ apiKey: embeddingKey });
  }

  return null;
}

/**
 * Check if embedding service is available
 */
export function isEmbeddingAvailable(userApiKey?: string): boolean {
  if (userApiKey) return true;
  return !!getEnv("OPENROUTER_EMBEDDING_KEY");
}

// ============================================
// EMBEDDING STORAGE (Supabase)
// ============================================

/**
 * Store embedding for an app in Supabase
 * Uses the skills_embedding column with pgvector
 */
export async function storeAppEmbedding(
  appId: string,
  embedding: number[],
): Promise<void> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase credentials not configured");
  }

  const vectorString = toPgVector(embedding);

  const response = await fetch(`${supabaseUrl}/rest/v1/apps?id=eq.${appId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${supabaseKey}`,
      "apikey": supabaseKey,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      skills_embedding: vectorString,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to store embedding: ${response.status} - ${error}`);
  }
}

export async function upsertToolSemanticEmbedding(
  params: ToolSemanticEmbeddingUpsertParams,
  deps: SupabaseRpcDeps = {},
): Promise<ToolSemanticEmbeddingRow> {
  const { supabaseUrl, supabaseKey, fetchFn } = getSupabaseRpcConfig(deps);
  if (params.status === "ready" || params.status === undefined) {
    if (!params.embedding || params.embedding.length === 0) {
      throw new Error("Ready tool semantic embeddings require a vector");
    }
  }
  const embeddingTextHash = params.embeddingTextHash ||
    await hashEmbeddingText(params.embeddingText);
  const response = await fetchFn(
    `${supabaseUrl}/rest/v1/rpc/upsert_tool_semantic_embedding`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_app_id: params.appId ?? null,
        p_app_version: params.appVersion || "unversioned",
        p_subject_type: params.subjectType,
        p_subject_id: params.subjectId,
        p_embedding: params.embedding ? toPgVector(params.embedding) : null,
        p_embedding_text: params.embeddingText,
        p_embedding_text_hash: embeddingTextHash,
        p_model: params.model,
        p_provider: params.provider || DEFAULT_EMBEDDING_PROVIDER,
        p_embedding_charge_id: params.embeddingChargeId ?? null,
        p_status: params.status || "ready",
        p_metadata: params.metadata || {},
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Failed to upsert tool semantic embedding: ${response.status} - ${error}`,
    );
  }

  const payload = await response.json() as
    | ToolSemanticEmbeddingRow[]
    | ToolSemanticEmbeddingRow;
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row) {
    throw new Error("Failed to upsert tool semantic embedding: empty response");
  }
  return row;
}

export async function searchToolSemanticEmbeddings(
  queryEmbedding: number[],
  options: ToolSemanticEmbeddingSearchOptions = {},
  deps: SupabaseRpcDeps = {},
): Promise<ToolSemanticEmbeddingSearchResult[]> {
  const { supabaseUrl, supabaseKey, fetchFn } = getSupabaseRpcConfig(deps);
  const response = await fetchFn(
    `${supabaseUrl}/rest/v1/rpc/search_tool_semantic_embeddings`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_query_embedding: toPgVector(queryEmbedding),
        p_match_threshold: options.threshold ?? 0.35,
        p_match_count: options.limit ?? 20,
        p_subject_types: options.subjectTypes ?? null,
        p_app_version: options.appVersion ?? null,
        p_visibility: options.visibility ?? ["public"],
        p_include_platform_primitives: options.includePlatformPrimitives ??
          true,
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Failed to search tool semantic embeddings: ${response.status} - ${error}`,
    );
  }

  return await response.json() as ToolSemanticEmbeddingSearchResult[];
}

/**
 * Search apps by semantic similarity using subject-level embeddings.
 * Returns one row per app, ranked by the best matching subject.
 */
export async function searchAppsByToolSemanticEmbedding(
  queryEmbedding: number[],
  options: ToolSemanticEmbeddingSearchOptions = {},
  deps: SupabaseRpcDeps = {},
): Promise<ToolSemanticEmbeddingSearchResult[]> {
  const matches = await searchToolSemanticEmbeddings(
    queryEmbedding,
    {
      ...options,
      subjectTypes: options.subjectTypes ||
        ["app", "function", "platform_primitive"],
      includePlatformPrimitives: false,
    },
    deps,
  );
  const bestByApp = new Map<string, ToolSemanticEmbeddingSearchResult>();
  for (const match of matches) {
    if (!match.app_id) continue;
    const existing = bestByApp.get(match.app_id);
    if (!existing || match.similarity > existing.similarity) {
      bestByApp.set(match.app_id, match);
    }
  }
  return Array.from(bestByApp.values()).sort((a, b) =>
    b.similarity - a.similarity
  );
}

/**
 * Search apps by semantic similarity using the legacy aggregate app embedding.
 * Uses the search_apps RPC function with pgvector.
 */
export async function searchAppsByEmbedding(
  queryEmbedding: number[],
  userId: string,
  options: {
    limit?: number;
    threshold?: number;
  } = {},
): Promise<
  Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    is_public: boolean;
    owner_id: string;
    similarity: number;
  }>
> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase credentials not configured");
  }

  const { limit = 20, threshold = 0.5 } = options;
  const vectorString = toPgVector(queryEmbedding);

  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/search_apps`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${supabaseKey}`,
      "apikey": supabaseKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_query_embedding: vectorString,
      p_user_id: userId,
      p_limit: limit,
      p_offset: 0,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to search apps: ${response.status} - ${error}`);
  }

  const results = await response.json() as Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    is_public: boolean;
    owner_id: string;
    similarity: number;
  }>;

  return results.filter((row) => row.similarity >= threshold);
}

/**
 * Clear embedding for an app
 * Used when skills are deleted or app is unpublished
 */
export async function clearAppEmbedding(appId: string): Promise<void> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase credentials not configured");
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/apps?id=eq.${appId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${supabaseKey}`,
      "apikey": supabaseKey,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({
      skills_embedding: null,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to clear embedding: ${response.status} - ${error}`);
  }
}

// ============================================
// CONVERSATION EMBEDDING (Supabase pgvector)
// ============================================

/**
 * Store/upsert embedding for a conversation summary.
 * Used for cross-session semantic search in the Flash pipeline.
 */
export async function storeConversationEmbedding(
  userId: string,
  conversationId: string,
  conversationName: string,
  summary: string,
  metadata: Record<string, unknown>,
  embedding: number[],
): Promise<void> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase credentials not configured");
  }

  const vectorString = toPgVector(embedding);

  const response = await fetch(
    `${supabaseUrl}/rest/v1/conversation_embeddings`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        user_id: userId,
        conversation_id: conversationId,
        conversation_name: conversationName,
        summary,
        metadata,
        embedding: vectorString,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Failed to store conversation embedding: ${response.status} - ${error}`,
    );
  }
}

/**
 * Semantic search across user's conversation history.
 * Returns top-k conversations ranked by cosine similarity.
 */
export async function searchConversationEmbeddings(
  queryEmbedding: number[],
  userId: string,
  options: { limit?: number; threshold?: number } = {},
): Promise<
  Array<{
    conversation_id: string;
    conversation_name: string;
    summary: string;
    metadata: Record<string, unknown>;
    similarity: number;
    created_at: string;
  }>
> {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseKey) return [];

  const { limit = 3, threshold = 0.5 } = options;
  const vectorString = toPgVector(queryEmbedding);

  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/search_conversation_embeddings`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${supabaseKey}`,
        "apikey": supabaseKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_query_embedding: vectorString,
        p_user_id: userId,
        p_match_threshold: threshold,
        p_match_count: limit,
      }),
    },
  );

  if (!response.ok) {
    console.warn(`Conversation embedding search failed: ${response.status}`);
    return [];
  }

  return await response.json();
}
