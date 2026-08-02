import { getEnv } from "../lib/env.ts";
import {
  CONCEPT_SLUG_PATTERN,
  type ConceptMention,
  extractConceptMentions,
} from "./concept-mentions.ts";
import { embedOwnerAgentSearchDocument } from "./agent-search.ts";
import type {
  LaunchAgentConcept,
  LaunchAgentConceptAbout,
  LaunchAgentConceptSuggestion,
} from "../../shared/contracts/launch.ts";

// WO-6 PR A store + retrieval (docs/AGENT_STUDIO_LAUNCH_WORK_ORDERS.md).
// Mentions are derived (reindex = delete + insert); concepts auto-create as
// 'provisional' on first mention so writing never errors; description edits
// re-embed via the owner's BYOK route and degrade to embedding_status
// 'pending' — an embedding hiccup must never fail a write (the
// agent_search_documents discipline).

const MENTION_GROUP_LIMIT = 12;
const RELATED_LIMIT = 8;
const GLOSSARY_LIMIT = 300;

export class AgentConceptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConceptValidationError";
  }
}

export type ConceptSurfaceType =
  | "fact"
  | "question"
  | "mission"
  | "memory"
  | "activity_summary"
  | "function_description"
  | "schema_field"
  | "concept_page"
  | "d1";

interface ConceptRow {
  id: string;
  slug: string;
  title: string | null;
  description: string | null;
  status: "provisional" | "active" | "retired";
  created_by: "owner" | "agent" | "schema" | "mention";
  aliases: string[];
  embedding_status: "none" | "pending" | "ready";
  embedding_provider: string | null;
  embedding_model: string | null;
  created_at: string;
  updated_at: string;
}

interface MentionRow {
  concept_id: string;
  surface_type: ConceptSurfaceType;
  surface_id: string;
  block_id: string;
  block_text: string;
  identity: boolean;
  release_id: string | null;
  field_path: string | null;
  created_at: string;
}

function supabaseHeaders(extra?: Record<string, string>) {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(extra || {}),
  };
}

function restUrl(path: string): string {
  return `${getEnv("SUPABASE_URL")}/rest/v1/${path}`;
}

async function readRows<T>(res: Response, what: string): Promise<T[]> {
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to ${what}: ${err}`);
  }
  return await res.json() as T[];
}

function conceptProjection(row: ConceptRow): LaunchAgentConcept {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    createdBy: row.created_by,
    aliases: row.aliases ?? [],
    embeddingStatus: row.embedding_status,
    embeddingModel: row.embedding_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Auto-create on first mention; idempotent via the unique index (the
 * WO-1/WO-5 409 pattern). Never mutates an existing concept. */
export async function ensureConcept(
  userId: string,
  appId: string,
  slug: string,
  options: { createdBy?: ConceptRow["created_by"] } = {},
): Promise<ConceptRow> {
  if (!CONCEPT_SLUG_PATTERN.test(slug)) {
    throw new AgentConceptValidationError(
      "Concept slug must be 2-63 chars of lowercase letters, digits, and hyphens.",
    );
  }
  const insert = await fetch(restUrl("agent_concepts"), {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify({
      app_id: appId,
      user_id: userId,
      slug,
      created_by: options.createdBy ?? "mention",
    }),
  });
  if (insert.ok) return ((await insert.json()) as ConceptRow[])[0];
  await insert.body?.cancel();
  const existing = await readRows<ConceptRow>(
    await fetch(
      restUrl(
        `agent_concepts?app_id=eq.${encodeURIComponent(appId)}` +
          `&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      ),
      { headers: supabaseHeaders() },
    ),
    "read concept",
  );
  if (!existing[0]) throw new Error(`Concept ${slug} could not be ensured`);
  return existing[0];
}

export interface ReindexMention extends ConceptMention {
  identity?: boolean;
  releaseId?: string | null;
  fieldPath?: string | null;
}

/**
 * Reindex one surface: mentions are a pure function of its current text.
 * Delete everything recorded for (surface_type, surface_id), ensure the
 * mentioned concepts exist, insert the fresh parse. Best-effort by design
 * at call sites — indexing must never fail the underlying write.
 */
export async function reindexSurface(
  userId: string,
  appId: string,
  surfaceType: ConceptSurfaceType,
  surfaceId: string,
  mentions: ReindexMention[],
  options: { createdBy?: ConceptRow["created_by"] } = {},
): Promise<number> {
  const del = await fetch(
    restUrl(
      `agent_concept_mentions?app_id=eq.${encodeURIComponent(appId)}` +
        `&surface_type=eq.${encodeURIComponent(surfaceType)}` +
        `&surface_id=eq.${encodeURIComponent(surfaceId)}`,
    ),
    { method: "DELETE", headers: supabaseHeaders() },
  );
  if (!del.ok) {
    const err = await del.text().catch(() => del.statusText);
    throw new Error(`Failed to clear mentions: ${err}`);
  }
  if (mentions.length === 0) return 0;
  const rows: Record<string, unknown>[] = [];
  const conceptIds = new Map<string, string>();
  for (const mention of mentions) {
    let conceptId = conceptIds.get(mention.slug);
    if (!conceptId) {
      const concept = await ensureConcept(userId, appId, mention.slug, {
        createdBy: options.createdBy,
      });
      conceptId = concept.id;
      conceptIds.set(mention.slug, conceptId);
    }
    rows.push({
      app_id: appId,
      user_id: userId,
      concept_id: conceptId,
      surface_type: surfaceType,
      surface_id: surfaceId,
      block_id: mention.blockId,
      block_text: mention.blockText,
      identity: mention.identity === true,
      release_id: mention.releaseId ?? null,
      field_path: mention.fieldPath ?? null,
    });
  }
  const insert = await fetch(restUrl("agent_concept_mentions"), {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify(rows),
  });
  if (!insert.ok) {
    const err = await insert.text().catch(() => insert.statusText);
    throw new Error(`Failed to record mentions: ${err}`);
  }
  return rows.length;
}

/** Parse + reindex a prose surface in one call — the standard hook shape.
 * Never throws: a parsing/indexing failure must not fail the write that
 * triggered it (logged, surfaced later through reindex-on-next-edit). */
export async function reindexProseSurface(
  userId: string,
  appId: string,
  surfaceType: ConceptSurfaceType,
  surfaceId: string,
  text: string,
  blockSplit: "whole" | "paragraph",
): Promise<void> {
  try {
    const mentions = extractConceptMentions(text ?? "", { blockSplit });
    await reindexSurface(userId, appId, surfaceType, surfaceId, mentions);
  } catch (err) {
    console.error(
      `[CONCEPTS] reindex ${surfaceType}:${surfaceId} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Seed a concept's description ONLY IF BLANK (the manifest declares; the
 * page lives — a later release never clobbers accumulated prose). The
 * PostgREST `description=is.null` filter makes only-if-blank atomic:
 * a non-blank page matches zero rows. Seeded pages carry
 * embedding_status 'pending' — the owner's next Studio visit (or the
 * housekeeping chore) embeds them under the BYOK route.
 */
export async function seedConceptDescription(
  userId: string,
  appId: string,
  slug: string,
  description: string,
): Promise<boolean> {
  const concept = await ensureConcept(userId, appId, slug, {
    createdBy: "schema",
  });
  const rows = await readRows<ConceptRow>(
    await fetch(
      restUrl(
        `agent_concepts?id=eq.${encodeURIComponent(concept.id)}` +
          `&description=is.null`,
      ),
      {
        method: "PATCH",
        headers: supabaseHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify({
          description: description.slice(0, 4000),
          embedding_status: "pending",
          status: concept.status === "provisional" ? "active" : concept.status,
          updated_at: new Date().toISOString(),
        }),
      },
    ),
    "seed concept description",
  );
  return rows.length > 0;
}

export async function listConcepts(
  userId: string,
  appId: string,
): Promise<
  Array<LaunchAgentConcept & { mentionCount: number }>
> {
  const [concepts, counts] = await Promise.all([
    readRows<ConceptRow>(
      await fetch(
        restUrl(
          `agent_concepts?app_id=eq.${encodeURIComponent(appId)}` +
            `&user_id=eq.${encodeURIComponent(userId)}` +
            `&order=updated_at.desc&limit=${GLOSSARY_LIMIT}`,
        ),
        { headers: supabaseHeaders() },
      ),
      "list concepts",
    ),
    readRows<{ concept_id: string }>(
      await fetch(
        restUrl(
          `agent_concept_mentions?app_id=eq.${encodeURIComponent(appId)}` +
            `&user_id=eq.${encodeURIComponent(userId)}` +
            `&select=concept_id&limit=10000`,
        ),
        { headers: supabaseHeaders() },
      ),
      "count mentions",
    ),
  ]);
  const tally = new Map<string, number>();
  for (const row of counts) {
    tally.set(row.concept_id, (tally.get(row.concept_id) ?? 0) + 1);
  }
  return concepts.map((row) => ({
    ...conceptProjection(row),
    mentionCount: tally.get(row.id) ?? 0,
  }));
}

/** Resolve a slug through aliases: exact slug first, then alias containment. */
async function resolveConcept(
  userId: string,
  appId: string,
  slug: string,
): Promise<ConceptRow | null> {
  const direct = await readRows<ConceptRow>(
    await fetch(
      restUrl(
        `agent_concepts?app_id=eq.${encodeURIComponent(appId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}` +
          `&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      ),
      { headers: supabaseHeaders() },
    ),
    "read concept",
  );
  if (direct[0]) return direct[0];
  const aliased = await readRows<ConceptRow>(
    await fetch(
      restUrl(
        `agent_concepts?app_id=eq.${encodeURIComponent(appId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}` +
          `&aliases=cs.{${encodeURIComponent(slug)}}&limit=1`,
      ),
      { headers: supabaseHeaders() },
    ),
    "read concept alias",
  );
  return aliased[0] ?? null;
}

export async function aboutConcept(
  userId: string,
  appId: string,
  slug: string,
): Promise<LaunchAgentConceptAbout | null> {
  const concept = await resolveConcept(userId, appId, slug);
  if (!concept) return null;
  const mentions = await readRows<MentionRow>(
    await fetch(
      restUrl(
        `agent_concept_mentions?app_id=eq.${encodeURIComponent(appId)}` +
          `&concept_id=eq.${encodeURIComponent(concept.id)}` +
          `&order=identity.desc,created_at.desc&limit=200`,
      ),
      { headers: supabaseHeaders() },
    ),
    "read mentions",
  );
  const groups = new Map<string, MentionRow[]>();
  for (const mention of mentions) {
    const list = groups.get(mention.surface_type) ?? [];
    if (list.length < MENTION_GROUP_LIMIT) list.push(mention);
    groups.set(mention.surface_type, list);
  }
  // Related concepts: co-mentioned on the same surfaces, ranked by overlap.
  const surfaceKeys = [
    ...new Set(mentions.map((m) => `${m.surface_type}:${m.surface_id}`)),
  ].slice(0, 50);
  const related = new Map<string, number>();
  if (surfaceKeys.length > 0) {
    const surfaceFilter = surfaceKeys
      .map((key) => key.split(":", 2))
      .map(([type, id]) =>
        `and(surface_type.eq.${type},surface_id.eq.${encodeURIComponent(id)})`
      )
      .join(",");
    const cohabitants = await readRows<{ concept_id: string }>(
      await fetch(
        restUrl(
          `agent_concept_mentions?app_id=eq.${encodeURIComponent(appId)}` +
            `&or=(${surfaceFilter})&select=concept_id&limit=2000`,
        ),
        { headers: supabaseHeaders() },
      ),
      "read co-mentions",
    ).catch(() => [] as Array<{ concept_id: string }>);
    for (const row of cohabitants) {
      if (row.concept_id === concept.id) continue;
      related.set(row.concept_id, (related.get(row.concept_id) ?? 0) + 1);
    }
  }
  let relatedConcepts: Array<{ slug: string; title: string | null }> = [];
  const relatedIds = [...related.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RELATED_LIMIT)
    .map(([id]) => id);
  if (relatedIds.length > 0) {
    const rows = await readRows<ConceptRow>(
      await fetch(
        restUrl(
          `agent_concepts?id=in.(${relatedIds.join(",")})` +
            `&select=id,slug,title,description,status,created_by,aliases,embedding_status,embedding_provider,embedding_model,created_at,updated_at`,
        ),
        { headers: supabaseHeaders() },
      ),
      "read related concepts",
    ).catch(() => [] as ConceptRow[]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    relatedConcepts = relatedIds
      .map((id) => byId.get(id))
      .filter((row): row is ConceptRow => Boolean(row))
      .map((row) => ({ slug: row.slug, title: row.title }));
  }
  return {
    concept: conceptProjection(concept),
    mentionGroups: [...groups.entries()].map(([surfaceType, rows]) => ({
      surfaceType,
      mentions: rows.map((row) => ({
        surfaceId: row.surface_id,
        blockId: row.block_id,
        blockText: row.block_text,
        identity: row.identity,
        releaseId: row.release_id,
        fieldPath: row.field_path,
        createdAt: row.created_at,
      })),
    })),
    relatedConcepts,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Owner/agent description edit. Re-embeds via the owner's BYOK route;
 * embedding failure degrades to 'pending' (write always succeeds). The
 * concept page is itself a parsed surface, so concept↔concept prose links
 * reindex here — the graph is closed under writing.
 */
export async function describeConcept(
  userId: string,
  appId: string,
  slug: string,
  input: {
    title?: string | null;
    description?: string | null;
    aliases?: string[];
    status?: "active" | "retired";
    author: "owner" | "agent";
    userEmail: string;
  },
): Promise<LaunchAgentConcept> {
  const concept = await resolveConcept(userId, appId, slug);
  if (!concept) {
    throw new AgentConceptValidationError("Concept not found.");
  }
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if ("title" in input) updates.title = input.title ?? null;
  if (input.aliases) {
    const bad = input.aliases.find((a) => !CONCEPT_SLUG_PATTERN.test(a));
    if (bad) {
      throw new AgentConceptValidationError(`Invalid alias slug: ${bad}`);
    }
    updates.aliases = input.aliases;
  }
  if (input.status) updates.status = input.status;
  if ("description" in input) {
    const description = (input.description ?? "").trim() || null;
    if (description && description.length > 4000) {
      throw new AgentConceptValidationError(
        "Concept description must be at most 4000 characters.",
      );
    }
    updates.description = description;
    if (concept.status === "provisional" && description) {
      updates.status = input.status ?? "active";
    }
    if (description) {
      const embedded = await embedOwnerAgentSearchDocument({
        userId,
        userEmail: input.userEmail,
        text: description,
      });
      if (embedded) {
        updates.embedding = `[${embedded.embedding.join(",")}]`;
        updates.embedding_status = "ready";
        updates.embedding_provider = embedded.provider;
        updates.embedding_model = embedded.model;
        updates.embedding_text_hash = embedded.textHash;
      } else {
        updates.embedding_status = "pending";
      }
    } else {
      updates.embedding = null;
      updates.embedding_status = "none";
    }
  }
  const rows = await readRows<ConceptRow>(
    await fetch(
      restUrl(
        `agent_concepts?id=eq.${encodeURIComponent(concept.id)}` +
          `&user_id=eq.${encodeURIComponent(userId)}`,
      ),
      {
        method: "PATCH",
        headers: supabaseHeaders({ Prefer: "return=representation" }),
        body: JSON.stringify(updates),
      },
    ),
    "update concept",
  );
  if (!rows[0]) throw new Error("Concept update returned no row");
  if ("description" in input) {
    await reindexProseSurface(
      userId,
      appId,
      "concept_page",
      concept.slug,
      (input.description ?? "") as string,
      "paragraph",
    );
  }
  return conceptProjection(rows[0]);
}

/** Ranked candidates for a text blob: verbatim/alias matches first
 * (deterministic basis), then semantic neighbors within one model space. */
export async function suggestConcepts(
  userId: string,
  appId: string,
  text: string,
  options: { limit?: number; userEmail?: string } = {},
): Promise<LaunchAgentConceptSuggestion[]> {
  const query = (text ?? "").trim();
  if (!query) {
    throw new AgentConceptValidationError("suggest requires non-empty text.");
  }
  const limit = Math.max(1, Math.min(options.limit ?? 8, 25));
  // Punctuation-insensitive word matching: "refund window." matches the
  // needle "refund window".
  const haystack = ` ${
    query.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim()
  } `;
  const concepts = await readRows<ConceptRow>(
    await fetch(
      restUrl(
        `agent_concepts?app_id=eq.${encodeURIComponent(appId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}` +
          `&status=neq.retired&limit=${GLOSSARY_LIMIT}`,
      ),
      { headers: supabaseHeaders() },
    ),
    "list concepts",
  );
  const suggestions = new Map<string, LaunchAgentConceptSuggestion>();
  for (const concept of concepts) {
    const needles = [
      concept.slug.replaceAll("-", " "),
      ...(concept.title ? [concept.title.toLowerCase()] : []),
      ...(concept.aliases ?? []).map((a) => a.replaceAll("-", " ")),
    ];
    const hit = needles.find((needle) =>
      needle.length > 2 && haystack.includes(` ${needle} `)
    );
    if (hit) {
      suggestions.set(concept.slug, {
        slug: concept.slug,
        title: concept.title,
        score: 1,
        basis: hit === concept.slug.replaceAll("-", " ") ||
            hit === concept.title?.toLowerCase()
          ? "verbatim"
          : "alias",
      });
    }
  }
  if (suggestions.size < limit && options.userEmail) {
    const embedded = await embedOwnerAgentSearchDocument({
      userId,
      userEmail: options.userEmail,
      text: query,
    });
    if (embedded) {
      const semantic = await readRows<
        { slug: string; title: string | null; similarity: number }
      >(
        await fetch(restUrl("rpc/suggest_agent_concepts"), {
          method: "POST",
          headers: supabaseHeaders(),
          body: JSON.stringify({
            p_app_id: appId,
            p_user_id: userId,
            p_query_embedding: `[${embedded.embedding.join(",")}]`,
            p_model: embedded.model,
            p_limit: limit,
          }),
        }),
        "suggest concepts",
      ).catch(() => []);
      for (const row of semantic) {
        if (suggestions.has(row.slug)) continue;
        suggestions.set(row.slug, {
          slug: row.slug,
          title: row.title,
          score: Math.round(row.similarity * 1000) / 1000,
          basis: "semantic",
        });
      }
    }
  }
  return [...suggestions.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
