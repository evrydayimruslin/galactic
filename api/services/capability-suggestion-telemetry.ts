import { getEnv } from "../lib/env.ts";
import {
  getAnalyticsIdentity,
  isExplicitlyDisabled,
  sha256Text,
} from "./analytics-identity.ts";
import { rebuildFunctionIndex } from "./function-index.ts";
import { createServerLogger } from "./logging.ts";
import type { SuggestionSource } from "../../shared/contracts/suggestions.ts";

type JsonRecord = Record<string, unknown>;

export const CAPABILITY_SUGGESTION_EVENT_TYPES = [
  "suggested",
  "viewed",
  "accepted",
  "dismissed",
  "installed",
  "used",
  "failed",
  "weak_match",
  "no_match",
] as const;

export type CapabilitySuggestionEventType =
  typeof CAPABILITY_SUGGESTION_EVENT_TYPES[number];

export interface CapabilitySuggestionCandidateInput {
  suggestionId?: string;
  appId?: string | null;
  appSlug?: string | null;
  appName?: string | null;
  appType?: string | null;
  suggestionSource?: SuggestionSource | null;
  rank?: number | null;
  similarity?: number | null;
  keyFunctions?: string[];
  metadata?: JsonRecord;
}

export interface CapabilitySuggestionSetInput {
  userId: string;
  intentId?: string;
  suggestionSetId?: string;
  conversationId?: string;
  traceId?: string;
  messageId?: string;
  source?: string;
  intentType?: string;
  intentSummary?: string;
  queryText?: string;
  retrievalSource?: string;
  candidateCount?: number;
  weakMatch?: boolean;
  noMatch?: boolean;
  suggestions: CapabilitySuggestionCandidateInput[];
  metadata?: JsonRecord;
}

export interface CapabilitySuggestionSetRecord {
  intentId: string;
  suggestionSetId: string;
  suggestions: Array<
    CapabilitySuggestionCandidateInput & { suggestionId: string }
  >;
}

export interface CapabilitySuggestionEventInput {
  userId: string;
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
  metadata?: JsonRecord;
}

export interface CapabilityGapShortcomingInput {
  userId: string;
  sessionId?: string;
  summary: string;
  context?: JsonRecord;
}

const suggestionTelemetryLogger = createServerLogger("CAPABILITY-SUGGESTIONS");

function telemetryEnabled(): boolean {
  return !isExplicitlyDisabled(getEnv("CHAT_CAPTURE_ENABLED"));
}

function supabaseReady(): boolean {
  return !!getEnv("SUPABASE_URL") && !!getEnv("SUPABASE_SERVICE_ROLE_KEY");
}

function dbHeaders(prefer = "return=minimal"): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    "Prefer": prefer,
  };
}

function asUuid(value?: string | null): string | null {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
    ? value
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeJson(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {
      _serialization_error: true,
      preview: String(value).slice(0, 1000),
    };
  }
}

function trimText(value: string | undefined, maxLength: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

async function postRows(
  table: string,
  rows: unknown,
  opts: { prefer?: string; onConflict?: string } = {},
): Promise<void> {
  const url = new URL(`${getEnv("SUPABASE_URL")}/rest/v1/${table}`);
  if (opts.onConflict) url.searchParams.set("on_conflict", opts.onConflict);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: dbHeaders(opts.prefer),
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to insert ${table}: ${response.status} ${await response.text()}`,
    );
  }
}

async function analyticsIdentityFor(userId: string): Promise<{
  anonUserId: string;
  pepperVersion: string;
}> {
  const identity = await getAnalyticsIdentity(userId);
  await postRows("capture_subjects", {
    anon_user_id: identity.anonUserId,
    user_id: userId,
    pepper_version: identity.pepperVersion,
    last_seen_at: new Date().toISOString(),
    metadata: {},
  }, {
    prefer: "return=minimal,resolution=merge-duplicates",
    onConflict: "anon_user_id",
  });
  return identity;
}

async function sha256Nullable(value: string | null): Promise<string | null> {
  return value ? await sha256Text(value) : null;
}

export async function recordCapabilitySuggestionSet(
  input: CapabilitySuggestionSetInput,
): Promise<CapabilitySuggestionSetRecord> {
  const intentId = input.intentId || crypto.randomUUID();
  const suggestionSetId = input.suggestionSetId || crypto.randomUUID();
  const suggestions = input.suggestions.map((suggestion, index) => ({
    ...suggestion,
    suggestionId: suggestion.suggestionId || crypto.randomUUID(),
    rank: suggestion.rank ?? index + 1,
  }));

  const output = { intentId, suggestionSetId, suggestions };
  if (!telemetryEnabled() || !supabaseReady()) return output;

  try {
    const identity = await analyticsIdentityFor(input.userId);
    const queryText = trimText(input.queryText, 4000);
    const querySha256 = await sha256Nullable(queryText);
    const similarities = suggestions
      .map((suggestion) => finiteNumber(suggestion.similarity))
      .filter((value): value is number => value !== null);
    const topSimilarity = similarities.length > 0
      ? Math.max(...similarities)
      : null;
    const minSimilarity = similarities.length > 0
      ? Math.min(...similarities)
      : null;
    const now = new Date().toISOString();

    await postRows("capability_intents", {
      id: intentId,
      user_id: input.userId,
      anon_user_id: identity.anonUserId,
      conversation_id: input.conversationId || null,
      trace_id: asUuid(input.traceId),
      message_id: input.messageId || null,
      source: input.source || "orchestrate",
      intent_type: input.intentType || "ambient_tool_suggestion",
      intent_summary: trimText(input.intentSummary, 1000),
      query_text: queryText,
      query_sha256: querySha256,
      metadata: safeJson(input.metadata || {}),
      created_at: now,
    }, {
      prefer: "return=minimal,resolution=merge-duplicates",
      onConflict: "id",
    });

    await postRows("capability_suggestion_sets", {
      id: suggestionSetId,
      intent_id: intentId,
      user_id: input.userId,
      anon_user_id: identity.anonUserId,
      conversation_id: input.conversationId || null,
      trace_id: asUuid(input.traceId),
      message_id: input.messageId || null,
      source: input.source || "flash_broker",
      retrieval_source: input.retrievalSource ||
        "ambient_marketplace_embedding",
      query_text: queryText,
      query_sha256: querySha256,
      candidate_count: input.candidateCount ?? suggestions.length,
      suggestion_count: suggestions.length,
      top_similarity: topSimilarity,
      min_similarity: minSimilarity,
      weak_match: input.weakMatch === true,
      no_match: input.noMatch === true || suggestions.length === 0,
      metadata: safeJson(input.metadata || {}),
      created_at: now,
    }, {
      prefer: "return=minimal,resolution=merge-duplicates",
      onConflict: "id",
    });

    if (suggestions.length > 0) {
      await postRows(
        "capability_suggestions",
        suggestions.map((suggestion) => ({
          id: suggestion.suggestionId,
          suggestion_set_id: suggestionSetId,
          intent_id: intentId,
          user_id: input.userId,
          anon_user_id: identity.anonUserId,
          conversation_id: input.conversationId || null,
          trace_id: asUuid(input.traceId),
          message_id: input.messageId || null,
          app_id: asUuid(suggestion.appId),
          app_slug: suggestion.appSlug || null,
          app_name: suggestion.appName || null,
          app_type: suggestion.appType || "app",
          suggestion_source: suggestion.suggestionSource || "marketplace",
          rank: suggestion.rank,
          similarity: finiteNumber(suggestion.similarity),
          key_functions: safeJson(suggestion.keyFunctions || []),
          metadata: safeJson(suggestion.metadata || {}),
          created_at: now,
        })),
        {
          prefer: "return=minimal,resolution=merge-duplicates",
          onConflict: "id",
        },
      );

      await postRows(
        "capability_suggestion_events",
        suggestions.map((suggestion) => ({
          event_type: "suggested",
          intent_id: intentId,
          suggestion_set_id: suggestionSetId,
          suggestion_id: suggestion.suggestionId,
          user_id: input.userId,
          anon_user_id: identity.anonUserId,
          conversation_id: input.conversationId || null,
          trace_id: asUuid(input.traceId),
          message_id: input.messageId || null,
          app_id: asUuid(suggestion.appId),
          app_slug: suggestion.appSlug || null,
          event_source: "server",
          metadata: safeJson({
            rank: suggestion.rank,
            similarity: suggestion.similarity ?? null,
          }),
          created_at: now,
        })),
      );
    }

    if (input.weakMatch || input.noMatch || suggestions.length === 0) {
      await postRows("capability_suggestion_events", {
        event_type: input.noMatch || suggestions.length === 0
          ? "no_match"
          : "weak_match",
        intent_id: intentId,
        suggestion_set_id: suggestionSetId,
        user_id: input.userId,
        anon_user_id: identity.anonUserId,
        conversation_id: input.conversationId || null,
        trace_id: asUuid(input.traceId),
        message_id: input.messageId || null,
        event_source: "server",
        metadata: safeJson({
          candidate_count: input.candidateCount ?? suggestions.length,
          suggestion_count: suggestions.length,
          top_similarity: topSimilarity,
          min_similarity: minSimilarity,
        }),
        created_at: now,
      });
    }
  } catch (err) {
    suggestionTelemetryLogger.warn(
      "Failed to record capability suggestion set",
      {
        intent_id: intentId,
        suggestion_set_id: suggestionSetId,
        error: err,
      },
    );
  }

  return output;
}

export async function recordCapabilitySuggestionEvent(
  input: CapabilitySuggestionEventInput,
): Promise<{ eventId: string; libraryInstalled: boolean }> {
  const eventId = crypto.randomUUID();
  let libraryInstalled = false;
  if (!telemetryEnabled() || !supabaseReady()) {
    return { eventId, libraryInstalled };
  }

  try {
    const identity = await analyticsIdentityFor(input.userId);

    if (
      input.eventType === "accepted" &&
      input.installOnAccept !== false &&
      asUuid(input.appId)
    ) {
      libraryInstalled = await installAcceptedSuggestionApp(
        input.userId,
        input.appId!,
      );
    }

    await postRows("capability_suggestion_events", {
      id: eventId,
      event_type: input.eventType,
      intent_id: asUuid(input.intentId),
      suggestion_set_id: asUuid(input.suggestionSetId),
      suggestion_id: asUuid(input.suggestionId),
      user_id: input.userId,
      anon_user_id: identity.anonUserId,
      conversation_id: input.conversationId || null,
      trace_id: asUuid(input.traceId),
      message_id: input.messageId || null,
      app_id: asUuid(input.appId),
      app_slug: input.appSlug || null,
      event_source: input.eventSource || "client",
      library_installed: libraryInstalled,
      metadata: safeJson(input.metadata || {}),
    });
  } catch (err) {
    suggestionTelemetryLogger.warn(
      "Failed to record capability suggestion event",
      {
        event_id: eventId,
        event_type: input.eventType,
        suggestion_id: input.suggestionId,
        error: err,
      },
    );
  }

  return { eventId, libraryInstalled };
}

export async function recordCapabilityGapShortcoming(
  input: CapabilityGapShortcomingInput,
): Promise<void> {
  if (!telemetryEnabled() || !supabaseReady()) return;
  const summary = trimText(input.summary, 500);
  if (!summary || summary.length < 5) return;

  try {
    await postRows("shortcomings", {
      user_id: input.userId,
      session_id: input.sessionId || null,
      type: "capability_gap",
      summary,
      context: safeJson(input.context || {}),
    });
  } catch (err) {
    suggestionTelemetryLogger.warn(
      "Failed to record capability gap shortcoming",
      {
        error: err,
      },
    );
  }
}

export async function installAcceptedSuggestionApp(
  userId: string,
  appId: string,
  source = "ambient_suggestion_accept",
): Promise<boolean> {
  const appUuid = asUuid(appId);
  if (!appUuid) return false;
  if (!supabaseReady()) return false;

  const response = await fetch(
    `${getEnv("SUPABASE_URL")}/rest/v1/user_app_library`,
    {
      method: "POST",
      headers: dbHeaders("resolution=merge-duplicates,return=minimal"),
      body: JSON.stringify({
        user_id: userId,
        app_id: appUuid,
        source,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to install accepted suggestion: ${await response.text()}`,
    );
  }

  rebuildFunctionIndex(userId).catch((err) =>
    suggestionTelemetryLogger.warn(
      "Failed to rebuild function index after suggestion accept",
      {
        user_id: userId,
        app_id: appUuid,
        error: err,
      },
    )
  );

  return true;
}
