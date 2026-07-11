// Galactic Canon — authoritative project decisions for connected agents.
//
// Canon is intentionally deterministic. Connected agents perform the
// reasoning; Canon provides durable, versioned decisions, bounded retrieval,
// semantic ranking, provenance, and a human interface over the same tools.

const galactic = (globalThis as unknown as { galactic: any }).galactic;

type JsonObject = Record<string, unknown>;
type AuthorType = "human" | "agent" | "collaborative";
type DecisionStatus = "active" | "superseded" | "archived";

interface DecisionRow extends JsonObject {
  id: string;
  title: string;
  statement: string;
  rationale: string;
  alternatives: string;
  consequences: string;
  status: DecisionStatus;
  decided_at: string;
  effective_at?: string | null;
  last_reviewed_at?: string | null;
  review_due_at?: string | null;
  superseded_at?: string | null;
  archived_at?: string | null;
  author_type: AuthorType;
  author_label: string;
  source_ref?: string | null;
  metadata: string;
  embedding?: string | null;
  embedding_model?: string | null;
  embedding_dimensions?: number | null;
  embedding_version: number;
  embedding_hash?: string | null;
  embedding_status: "pending" | "ready" | "failed" | "disabled";
  embedding_error?: string | null;
  embedded_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface TagRow extends JsonObject {
  id: string;
  name: string;
  slug: string;
  description: string;
  color?: string | null;
  archived_at?: string | null;
}

interface EvidenceInput {
  type?: string;
  label?: string;
  ref: string;
  metadata?: JsonObject;
}

const DECISION_COLUMNS = [
  "id",
  "title",
  "statement",
  "rationale",
  "alternatives",
  "consequences",
  "status",
  "decided_at",
  "effective_at",
  "last_reviewed_at",
  "review_due_at",
  "superseded_at",
  "archived_at",
  "author_type",
  "author_label",
  "source_ref",
  "metadata",
  "embedding_model",
  "embedding_dimensions",
  "embedding_version",
  "embedding_hash",
  "embedding_status",
  "embedding_error",
  "embedded_at",
  "created_at",
  "updated_at",
];

const SEARCH_COLUMNS = [...DECISION_COLUMNS, "embedding"];
const EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_VERSION = 1;
const MAX_SEARCH_CANDIDATES = 500;

function now(): string {
  return new Date().toISOString();
}

function requiredString(value: unknown, name: string, max = 20_000): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  if (text.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return text;
}

function optionalString(value: unknown, max = 20_000): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > max) throw new Error(`value exceeds ${max} characters`);
  return text || null;
}

function timestamp(value: unknown, fallback?: string): string | null {
  if (value === undefined || value === null || value === "") {
    return fallback ?? null;
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }
  return parsed.toISOString();
}

function authorType(value: unknown): AuthorType {
  if (value === "human" || value === "agent" || value === "collaborative") {
    return value;
  }
  return "collaborative";
}

function safeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeTag(value: unknown): { name: string; slug: string } | null {
  const name = typeof value === "string" ? value.trim().slice(0, 80) : "";
  if (!name) return null;
  const slug = name.toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug ? { name, slug } : null;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator ? dot / denominator : 0;
}

function parseEmbedding(value: unknown): number[] | null {
  const parsed = safeJson<unknown>(value, null);
  if (!Array.isArray(parsed)) return null;
  const vector = parsed.map(Number);
  return vector.length && vector.every(Number.isFinite) ? vector : null;
}

function publicDecision(row: DecisionRow): JsonObject {
  return {
    ...row,
    metadata: safeJson<JsonObject>(row.metadata, {}),
  };
}

async function ensureTags(values: unknown): Promise<TagRow[]> {
  const normalized = Array.isArray(values)
    ? values.map(normalizeTag).filter((
      v,
    ): v is { name: string; slug: string } => !!v)
    : [];
  const bySlug = new Map(normalized.map((tag) => [tag.slug, tag]));
  const tags = [...bySlug.values()];
  if (!tags.length) return [];

  const existing = await galactic.db.select("tags", {
    where: {
      slug: { in: tags.map((tag) => tag.slug) },
      archived_at: { isNull: true },
    },
    limit: Math.max(tags.length, 1),
  }) as TagRow[];
  const existingSlugs = new Set(existing.map((tag) => tag.slug));
  for (const tag of tags) {
    if (existingSlugs.has(tag.slug)) continue;
    await galactic.db.upsert("tags", {
      values: {
        id: crypto.randomUUID(),
        name: tag.name,
        slug: tag.slug,
        description: "",
        color: null,
        archived_at: null,
        created_at: now(),
        updated_at: now(),
      },
      onConflict: ["slug"],
      set: { name: tag.name, archived_at: null, updated_at: now() },
    });
  }
  return await galactic.db.select("tags", {
    where: {
      slug: { in: tags.map((tag) => tag.slug) },
      archived_at: { isNull: true },
    },
    orderBy: { column: "name", dir: "asc" },
    limit: Math.max(tags.length, 1),
  }) as TagRow[];
}

async function replaceDecisionTags(
  decisionId: string,
  values: unknown,
): Promise<TagRow[]> {
  const tags = await ensureTags(values);
  await galactic.db.delete("decision_tags", {
    where: { decision_id: decisionId },
  });
  if (tags.length) {
    const ts = now();
    await galactic.db.insert(
      "decision_tags",
      tags.map((tag) => ({
        id: `${decisionId}:${tag.id}`,
        decision_id: decisionId,
        tag_id: tag.id,
        created_at: ts,
        updated_at: ts,
      })),
    );
  }
  return tags;
}

async function tagsForDecisionIds(
  decisionIds: string[],
): Promise<Map<string, TagRow[]>> {
  const result = new Map<string, TagRow[]>();
  for (const id of decisionIds) result.set(id, []);
  if (!decisionIds.length) return result;
  const links = await galactic.db.select("decision_tags", {
    columns: ["decision_id", "tag_id"],
    where: { decision_id: { in: decisionIds } },
    limit: Math.max(1, decisionIds.length * 50),
  }) as Array<{ decision_id: string; tag_id: string }>;
  const tagIds = [...new Set(links.map((link) => link.tag_id))];
  if (!tagIds.length) return result;
  const tags = await galactic.db.select("tags", {
    where: { id: { in: tagIds } },
    limit: tagIds.length,
  }) as TagRow[];
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  for (const link of links) {
    const tag = byId.get(link.tag_id);
    if (tag) result.get(link.decision_id)?.push(tag);
  }
  for (const value of result.values()) {
    value.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}

function embeddingText(decision: DecisionRow, tags: TagRow[]): string {
  return [
    `Title: ${decision.title}`,
    `Decision: ${decision.statement}`,
    decision.rationale ? `Rationale: ${decision.rationale}` : "",
    decision.alternatives ? `Alternatives: ${decision.alternatives}` : "",
    decision.consequences ? `Consequences: ${decision.consequences}` : "",
    tags.length ? `Tags: ${tags.map((tag) => tag.name).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

async function embedDecision(
  decision: DecisionRow,
  tags: TagRow[],
  force = false,
): Promise<void> {
  const input = embeddingText(decision, tags);
  const hash = await sha256(input);
  if (
    !force && decision.embedding_status === "ready" &&
    decision.embedding_hash === hash
  ) return;
  await galactic.db.update("decisions", {
    set: {
      embedding_status: "pending",
      embedding_hash: hash,
      embedding_error: null,
      updated_at: now(),
    },
    where: { id: decision.id },
  });
  try {
    const response = await galactic.embed({ input, model: EMBEDDING_MODEL });
    await galactic.db.update("decisions", {
      set: {
        embedding: JSON.stringify(response.embedding),
        embedding_model: response.model || EMBEDDING_MODEL,
        embedding_dimensions: response.dimensions || response.embedding.length,
        embedding_version: EMBEDDING_VERSION,
        embedding_hash: hash,
        embedding_status: "ready",
        embedding_error: null,
        embedded_at: now(),
        updated_at: now(),
      },
      where: { id: decision.id },
    });
  } catch (error) {
    await galactic.db.update("decisions", {
      set: {
        embedding_status: "failed",
        embedding_hash: hash,
        embedding_error: String(error).slice(0, 500),
        updated_at: now(),
      },
      where: { id: decision.id },
    });
  }
}

async function reembedDecisionIds(decisionIds: string[]): Promise<number> {
  const ids = [...new Set(decisionIds)].slice(0, 100);
  if (!ids.length) return 0;
  const rows = await galactic.db.select("decisions", {
    columns: DECISION_COLUMNS,
    where: { id: { in: ids } },
    limit: ids.length,
  }) as DecisionRow[];
  const tagMap = await tagsForDecisionIds(rows.map((row) => row.id));
  for (const row of rows) {
    await embedDecision(row, tagMap.get(row.id) || [], true);
  }
  return rows.length;
}

async function revisionNumber(decisionId: string): Promise<number> {
  return (await galactic.db.count("decision_revisions", {
    where: { decision_id: decisionId },
  })) +
    1;
}

function revisionSnapshot(decision: DecisionRow, tags: TagRow[]): JsonObject {
  return {
    ...publicDecision(decision),
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name, slug: tag.slug })),
  };
}

async function recordRevision(
  decision: DecisionRow,
  tags: TagRow[],
  changedFields: string[],
  changeComment: string | null,
  author: { type: AuthorType; label: string },
): Promise<void> {
  const ts = now();
  await galactic.db.insert("decision_revisions", {
    id: crypto.randomUUID(),
    decision_id: decision.id,
    revision_num: await revisionNumber(decision.id),
    snapshot: JSON.stringify(revisionSnapshot(decision, tags)),
    changed_fields: JSON.stringify(changedFields),
    change_comment: changeComment,
    author_type: author.type,
    author_label: author.label,
    created_at: ts,
    updated_at: ts,
  });
}

async function decisionRow(
  id: string,
  includeEmbedding = false,
): Promise<DecisionRow> {
  const row = await galactic.db.first("decisions", {
    columns: includeEmbedding ? SEARCH_COLUMNS : DECISION_COLUMNS,
    where: { id },
  }) as DecisionRow | null;
  if (!row) throw new Error(`Decision not found: ${id}`);
  return row;
}

async function decisionDetails(
  id: string,
  includeRevisions = true,
): Promise<JsonObject> {
  const decision = await decisionRow(id);
  const tags = (await tagsForDecisionIds([id])).get(id) || [];
  const [comments, relationsFrom, relationsTo, evidence, revisions] =
    await Promise.all([
      galactic.db.select("decision_comments", {
        where: { decision_id: id, deleted_at: { isNull: true } },
        orderBy: { column: "created_at", dir: "asc" },
        limit: 200,
      }),
      galactic.db.select("decision_relations", {
        where: { from_decision_id: id },
        orderBy: { column: "created_at", dir: "asc" },
        limit: 200,
      }),
      galactic.db.select("decision_relations", {
        where: { to_decision_id: id },
        orderBy: { column: "created_at", dir: "asc" },
        limit: 200,
      }),
      galactic.db.select("decision_evidence", {
        where: { decision_id: id },
        orderBy: { column: "created_at", dir: "asc" },
        limit: 200,
      }),
      includeRevisions
        ? galactic.db.select("decision_revisions", {
          where: { decision_id: id },
          orderBy: { column: "revision_num", dir: "desc" },
          limit: 100,
        })
        : Promise.resolve([]),
    ]);
  return {
    decision: publicDecision(decision),
    tags,
    comments,
    relations: { outgoing: relationsFrom, incoming: relationsTo },
    evidence: (evidence as JsonObject[]).map((item) => ({
      ...item,
      metadata: safeJson<JsonObject>(item.metadata, {}),
    })),
    revisions: (revisions as JsonObject[]).map((item) => ({
      ...item,
      snapshot: safeJson<JsonObject>(item.snapshot, {}),
      changed_fields: safeJson<string[]>(item.changed_fields, []),
    })),
  };
}

async function addEvidence(
  decisionId: string,
  evidence: EvidenceInput[],
): Promise<void> {
  const valid = evidence.filter((item) =>
    item && typeof item.ref === "string" && item.ref.trim()
  );
  if (!valid.length) return;
  const ts = now();
  await galactic.db.insert(
    "decision_evidence",
    valid.map((item) => ({
      id: crypto.randomUUID(),
      decision_id: decisionId,
      evidence_type:
        ["pr", "commit", "file", "url", "task", "run", "reference"].includes(
            item.type || "",
          )
          ? item.type
          : "reference",
      label: optionalString(item.label, 200) || "",
      ref: requiredString(item.ref, "evidence.ref", 2_000),
      metadata: JSON.stringify(item.metadata || {}),
      created_at: ts,
      updated_at: ts,
    })),
  );
}

export async function canon_create(args: {
  title: string;
  statement: string;
  rationale?: string;
  alternatives?: string;
  consequences?: string;
  tags?: string[];
  decided_at?: string;
  effective_at?: string;
  review_due_at?: string;
  author_type?: AuthorType;
  author_label?: string;
  source_ref?: string;
  metadata?: JsonObject;
  evidence?: EvidenceInput[];
}): Promise<unknown> {
  const ts = now();
  const id = crypto.randomUUID();
  const row: DecisionRow = {
    id,
    title: requiredString(args?.title, "title", 300),
    statement: requiredString(args?.statement, "statement"),
    rationale: optionalString(args?.rationale) || "",
    alternatives: optionalString(args?.alternatives) || "",
    consequences: optionalString(args?.consequences) || "",
    status: "active",
    decided_at: timestamp(args?.decided_at, ts)!,
    effective_at: timestamp(args?.effective_at),
    last_reviewed_at: null,
    review_due_at: timestamp(args?.review_due_at),
    superseded_at: null,
    archived_at: null,
    author_type: authorType(args?.author_type),
    author_label: optionalString(args?.author_label, 160) || "",
    source_ref: optionalString(args?.source_ref, 2_000),
    metadata: JSON.stringify(args?.metadata || {}),
    embedding: null,
    embedding_model: null,
    embedding_dimensions: null,
    embedding_version: EMBEDDING_VERSION,
    embedding_hash: null,
    embedding_status: "pending",
    embedding_error: null,
    embedded_at: null,
    created_at: ts,
    updated_at: ts,
  };
  await galactic.db.insert("decisions", row);
  const tags = await replaceDecisionTags(id, args?.tags || []);
  await addEvidence(id, args?.evidence || []);
  await recordRevision(row, tags, ["created"], "Initial canonical decision", {
    type: row.author_type,
    label: row.author_label,
  });
  await embedDecision(row, tags);
  return await decisionDetails(id);
}

export async function canon_get(
  args: { decision_id: string; include_revisions?: boolean },
): Promise<unknown> {
  return await decisionDetails(
    requiredString(args?.decision_id, "decision_id", 100),
    args?.include_revisions !== false,
  );
}

export async function canon_update(args: {
  decision_id: string;
  title?: string;
  statement?: string;
  rationale?: string;
  alternatives?: string;
  consequences?: string;
  tags?: string[];
  decided_at?: string;
  effective_at?: string | null;
  last_reviewed_at?: string | null;
  review_due_at?: string | null;
  author_type?: AuthorType;
  author_label?: string;
  source_ref?: string | null;
  metadata?: JsonObject;
  change_comment?: string;
}): Promise<unknown> {
  const id = requiredString(args?.decision_id, "decision_id", 100);
  const before = await decisionRow(id);
  const set: JsonObject = {};
  const changed: string[] = [];
  const textFields = [
    "title",
    "statement",
    "rationale",
    "alternatives",
    "consequences",
  ] as const;
  for (const field of textFields) {
    if (args[field] === undefined) continue;
    const value = field === "title"
      ? requiredString(args[field], field, 300)
      : field === "statement"
      ? requiredString(args[field], field)
      : optionalString(args[field]) || "";
    if (value !== before[field]) {
      set[field] = value;
      changed.push(field);
    }
  }
  for (
    const field of [
      "decided_at",
      "effective_at",
      "last_reviewed_at",
      "review_due_at",
    ] as const
  ) {
    if (args[field] === undefined) continue;
    const value = timestamp(args[field]);
    if (value !== before[field]) {
      set[field] = value;
      changed.push(field);
    }
  }
  if (args.author_type !== undefined) {
    const value = authorType(args.author_type);
    if (value !== before.author_type) {
      set.author_type = value;
      changed.push("author_type");
    }
  }
  if (args.author_label !== undefined) {
    const value = optionalString(args.author_label, 160) || "";
    if (value !== before.author_label) {
      set.author_label = value;
      changed.push("author_label");
    }
  }
  if (args.source_ref !== undefined) {
    const value = optionalString(args.source_ref, 2_000);
    if (value !== before.source_ref) {
      set.source_ref = value;
      changed.push("source_ref");
    }
  }
  if (args.metadata !== undefined) {
    const value = JSON.stringify(args.metadata || {});
    if (value !== before.metadata) {
      set.metadata = value;
      changed.push("metadata");
    }
  }
  let tags = (await tagsForDecisionIds([id])).get(id) || [];
  if (args.tags !== undefined) {
    tags = await replaceDecisionTags(id, args.tags);
    changed.push("tags");
  }
  if (!changed.length) return await decisionDetails(id);
  set.updated_at = now();
  await galactic.db.update("decisions", { set, where: { id } });
  const updated = await decisionRow(id);
  await recordRevision(
    updated,
    tags,
    [...new Set(changed)],
    optionalString(args.change_comment, 2_000),
    {
      type: authorType(args.author_type ?? updated.author_type),
      label: optionalString(args.author_label ?? updated.author_label, 160) ||
        "",
    },
  );
  if (
    changed.some((field) =>
      [
        "title",
        "statement",
        "rationale",
        "alternatives",
        "consequences",
        "tags",
      ].includes(field)
    )
  ) {
    await embedDecision(updated, tags);
  }
  return await decisionDetails(id);
}

export async function canon_list(args?: {
  status?: DecisionStatus | "all";
  tags?: string[];
  review_due_before?: string;
  limit?: number;
  offset?: number;
}): Promise<unknown> {
  const limit = Math.min(200, Math.max(1, Number(args?.limit) || 50));
  const offset = Math.max(0, Number(args?.offset) || 0);
  const where: JsonObject = {};
  if (args?.status && args.status !== "all") where.status = args.status;
  if (args?.review_due_before) {
    where.review_due_at = { lte: timestamp(args.review_due_before) };
  }
  const rows = await galactic.db.select("decisions", {
    columns: DECISION_COLUMNS,
    where,
    orderBy: { column: "updated_at", dir: "desc" },
    limit: Math.min(MAX_SEARCH_CANDIDATES, limit + offset + 200),
  }) as DecisionRow[];
  const tagMap = await tagsForDecisionIds(rows.map((row) => row.id));
  const wanted = uniqueStrings(args?.tags).map((tag) => normalizeTag(tag)?.slug)
    .filter(Boolean);
  const filtered = wanted.length
    ? rows.filter((row) => {
      const slugs = new Set((tagMap.get(row.id) || []).map((tag) => tag.slug));
      return wanted.every((slug) => slugs.has(slug!));
    })
    : rows;
  const page = filtered.slice(offset, offset + limit).map((row) => ({
    ...publicDecision(row),
    tags: tagMap.get(row.id) || [],
  }));
  return {
    decisions: page,
    count: page.length,
    has_more: filtered.length > offset + limit,
  };
}

function lexicalScore(
  query: string,
  decision: DecisionRow,
  tags: TagRow[],
): number {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) =>
    term.length > 1
  );
  if (!terms.length) return 0;
  const fields = [
    [decision.title, 4],
    [decision.statement, 3],
    [decision.rationale, 1.5],
    [decision.alternatives, 1],
    [decision.consequences, 1.5],
    [tags.map((tag) => `${tag.name} ${tag.slug}`).join(" "), 2],
  ] as Array<[string, number]>;
  let score = 0;
  for (const term of terms) {
    for (const [field, weight] of fields) {
      if (field.toLowerCase().includes(term)) score += weight;
    }
  }
  return score / terms.length;
}

export async function canon_search(args: {
  query: string;
  tags?: string[];
  status?: DecisionStatus | "all";
  limit?: number;
  threshold?: number;
}): Promise<unknown> {
  const query = requiredString(args?.query, "query", 4_000);
  const limit = Math.min(50, Math.max(1, Number(args?.limit) || 12));
  const threshold = Math.max(0, Math.min(1, Number(args?.threshold) || 0.2));
  const where: JsonObject = {};
  if (args?.status && args.status !== "all") where.status = args.status;
  else if (!args?.status) where.status = "active";
  const rows = await galactic.db.select("decisions", {
    columns: SEARCH_COLUMNS,
    where,
    orderBy: { column: "updated_at", dir: "desc" },
    limit: MAX_SEARCH_CANDIDATES,
  }) as DecisionRow[];
  const tagMap = await tagsForDecisionIds(rows.map((row) => row.id));
  const wanted = uniqueStrings(args?.tags).map((tag) => normalizeTag(tag)?.slug)
    .filter(Boolean);
  const candidates = wanted.length
    ? rows.filter((row) => {
      const slugs = new Set((tagMap.get(row.id) || []).map((tag) => tag.slug));
      return wanted.every((slug) => slugs.has(slug!));
    })
    : rows;

  let queryEmbedding: number[] | null = null;
  try {
    const response = await galactic.embed({
      input: query,
      model: EMBEDDING_MODEL,
    });
    queryEmbedding = response.embedding;
  } catch {
    // Lexical fallback is a first-class path, not a failed search.
  }

  const scored = candidates.map((row) => {
    const tags = tagMap.get(row.id) || [];
    const lexical = lexicalScore(query, row, tags);
    const vector = queryEmbedding ? parseEmbedding(row.embedding) : null;
    const semantic = queryEmbedding && vector
      ? cosineSimilarity(queryEmbedding, vector)
      : 0;
    const score = queryEmbedding && vector
      ? semantic * 0.8 + Math.min(1, lexical / 8) * 0.2
      : Math.min(1, lexical / 8);
    return { row, tags, score, semantic, lexical };
  }).filter((item) => item.score >= threshold || item.lexical > 0)
    .sort((a, b) =>
      b.score - a.score || b.row.updated_at.localeCompare(a.row.updated_at)
    )
    .slice(0, limit)
    .map((item) => ({
      ...publicDecision(item.row),
      tags: item.tags,
      relevance: Math.round(item.score * 1000) / 1000,
      semantic_similarity: item.semantic
        ? Math.round(item.semantic * 1000) / 1000
        : null,
    }));
  return {
    query,
    decisions: scored,
    count: scored.length,
    method: queryEmbedding ? "hybrid" : "lexical",
    candidates_considered: candidates.length,
  };
}

export async function canon_context(args: {
  query: string;
  tags?: string[];
  status?: DecisionStatus | "all";
  limit?: number;
  max_chars?: number;
  include_comments?: boolean;
}): Promise<unknown> {
  const limit = Math.min(30, Math.max(1, Number(args?.limit) || 15));
  const maxChars = Math.min(
    40_000,
    Math.max(2_000, Number(args?.max_chars) || 12_000),
  );
  const search = await canon_search({
    query: args?.query,
    tags: args?.tags,
    status: args?.status,
    limit,
    threshold: 0.1,
  }) as { method: string; decisions: JsonObject[] };
  const packets: JsonObject[] = [];
  let chars = 0;
  for (const decision of search.decisions) {
    const id = String(decision.id);
    const [relations, evidence, comments] = await Promise.all([
      galactic.db.select("decision_relations", {
        where: { _or: [{ from_decision_id: id }, { to_decision_id: id }] },
        limit: 50,
      }),
      galactic.db.select("decision_evidence", {
        columns: ["evidence_type", "label", "ref"],
        where: { decision_id: id },
        limit: 50,
      }),
      args?.include_comments
        ? galactic.db.select("decision_comments", {
          columns: [
            "id",
            "kind",
            "body",
            "author_type",
            "author_label",
            "created_at",
            "resolved_at",
          ],
          where: {
            decision_id: id,
            deleted_at: { isNull: true },
            include_in_context: 1,
          },
          orderBy: { column: "created_at", dir: "asc" },
          limit: 50,
        })
        : Promise.resolve([]),
    ]);
    const packet = {
      id,
      title: decision.title,
      decision: decision.statement,
      rationale: decision.rationale,
      consequences: decision.consequences,
      status: decision.status,
      decided_at: decision.decided_at,
      effective_at: decision.effective_at,
      review_due_at: decision.review_due_at,
      tags: decision.tags,
      relations,
      evidence,
      comments,
      relevance: decision.relevance,
    };
    const size = JSON.stringify(packet).length;
    if (packets.length && chars + size > maxChars) break;
    packets.push(packet);
    chars += size;
  }
  return {
    query: args?.query,
    retrieval_method: search.method,
    decisions: packets,
    count: packets.length,
    chars,
    instruction:
      "Treat active Canon decisions as development constraints. Explain conflicts before departing from them. Superseded decisions are historical context, not current instruction.",
  };
}

export async function canon_supersede(args: {
  decision_id: string;
  replacement_id: string;
  note?: string;
  author_type?: AuthorType;
  author_label?: string;
}): Promise<unknown> {
  const oldId = requiredString(args?.decision_id, "decision_id", 100);
  const replacementId = requiredString(
    args?.replacement_id,
    "replacement_id",
    100,
  );
  if (oldId === replacementId) {
    throw new Error("A decision cannot supersede itself");
  }
  const oldDecision = await decisionRow(oldId);
  await decisionRow(replacementId);
  const ts = now();
  await galactic.db.upsert("decision_relations", {
    values: {
      id: `${replacementId}:supersedes:${oldId}`,
      from_decision_id: replacementId,
      to_decision_id: oldId,
      relation_type: "supersedes",
      note: optionalString(args?.note, 2_000),
      created_at: ts,
      updated_at: ts,
    },
    onConflict: ["from_decision_id", "to_decision_id", "relation_type"],
    set: { note: optionalString(args?.note, 2_000), updated_at: ts },
  });
  await galactic.db.update("decisions", {
    set: { status: "superseded", superseded_at: ts, updated_at: ts },
    where: { id: oldId },
  });
  const updated = {
    ...oldDecision,
    status: "superseded",
    superseded_at: ts,
    updated_at: ts,
  } as DecisionRow;
  const tags = (await tagsForDecisionIds([oldId])).get(oldId) || [];
  await recordRevision(
    updated,
    tags,
    ["status", "superseded_at"],
    optionalString(args?.note, 2_000),
    {
      type: authorType(args?.author_type),
      label: optionalString(args?.author_label, 160) || "",
    },
  );
  return {
    superseded: await decisionDetails(oldId, false),
    replacement: await decisionDetails(replacementId, false),
  };
}

export async function canon_archive(args: {
  decision_id: string;
  reason?: string;
  author_type?: AuthorType;
  author_label?: string;
}): Promise<unknown> {
  const id = requiredString(args?.decision_id, "decision_id", 100);
  const before = await decisionRow(id);
  const ts = now();
  await galactic.db.update("decisions", {
    set: { status: "archived", archived_at: ts, updated_at: ts },
    where: { id },
  });
  const updated = {
    ...before,
    status: "archived",
    archived_at: ts,
    updated_at: ts,
  } as DecisionRow;
  const tags = (await tagsForDecisionIds([id])).get(id) || [];
  await recordRevision(
    updated,
    tags,
    ["status", "archived_at"],
    optionalString(args?.reason, 2_000),
    {
      type: authorType(args?.author_type),
      label: optionalString(args?.author_label, 160) || "",
    },
  );
  return await decisionDetails(id);
}

export async function canon_comment_add(args: {
  decision_id: string;
  body: string;
  kind?: string;
  author_type?: AuthorType;
  author_label?: string;
  source_ref?: string;
  include_in_context?: boolean;
}): Promise<unknown> {
  const decisionId = requiredString(args?.decision_id, "decision_id", 100);
  await decisionRow(decisionId);
  const kinds = [
    "note",
    "question",
    "implementation",
    "outcome",
    "clarification",
  ];
  const ts = now();
  const row = {
    id: crypto.randomUUID(),
    decision_id: decisionId,
    kind: kinds.includes(args?.kind || "") ? args.kind : "note",
    body: requiredString(args?.body, "body", 20_000),
    author_type: authorType(args?.author_type),
    author_label: optionalString(args?.author_label, 160) || "",
    source_ref: optionalString(args?.source_ref, 2_000),
    include_in_context: args?.include_in_context ? 1 : 0,
    resolved_at: null,
    deleted_at: null,
    created_at: ts,
    updated_at: ts,
  };
  await galactic.db.insert("decision_comments", row);
  return row;
}

export async function canon_comment_update(args: {
  comment_id: string;
  body?: string;
  kind?: string;
  include_in_context?: boolean;
  resolved?: boolean;
  delete?: boolean;
}): Promise<unknown> {
  const id = requiredString(args?.comment_id, "comment_id", 100);
  const existing = await galactic.db.first("decision_comments", {
    where: { id },
  }) as
    | JsonObject
    | null;
  if (!existing) throw new Error(`Comment not found: ${id}`);
  const set: JsonObject = { updated_at: now() };
  if (args.body !== undefined) {
    set.body = requiredString(args.body, "body", 20_000);
  }
  if (args.kind !== undefined) {
    const kinds = [
      "note",
      "question",
      "implementation",
      "outcome",
      "clarification",
    ];
    if (!kinds.includes(args.kind)) throw new Error("Invalid comment kind");
    set.kind = args.kind;
  }
  if (args.include_in_context !== undefined) {
    set.include_in_context = args.include_in_context ? 1 : 0;
  }
  if (args.resolved !== undefined) {
    set.resolved_at = args.resolved ? now() : null;
  }
  if (args.delete) set.deleted_at = now();
  await galactic.db.update("decision_comments", { set, where: { id } });
  return await galactic.db.first("decision_comments", { where: { id } });
}

export async function canon_relation_add(args: {
  from_decision_id: string;
  to_decision_id: string;
  relation_type: string;
  note?: string;
}): Promise<unknown> {
  const fromId = requiredString(
    args?.from_decision_id,
    "from_decision_id",
    100,
  );
  const toId = requiredString(args?.to_decision_id, "to_decision_id", 100);
  if (fromId === toId) throw new Error("A decision cannot relate to itself");
  await Promise.all([decisionRow(fromId), decisionRow(toId)]);
  const types = ["related_to", "depends_on", "implements", "conflicts_with"];
  if (!types.includes(args?.relation_type)) {
    throw new Error(`relation_type must be one of: ${types.join(", ")}`);
  }
  const ts = now();
  const row = {
    id: `${fromId}:${args.relation_type}:${toId}`,
    from_decision_id: fromId,
    to_decision_id: toId,
    relation_type: args.relation_type,
    note: optionalString(args?.note, 2_000),
    created_at: ts,
    updated_at: ts,
  };
  await galactic.db.upsert("decision_relations", {
    values: row,
    onConflict: ["from_decision_id", "to_decision_id", "relation_type"],
    set: { note: row.note, updated_at: ts },
  });
  return row;
}

export async function canon_relation_remove(
  args: { relation_id: string },
): Promise<unknown> {
  const id = requiredString(args?.relation_id, "relation_id", 400);
  const relation = await galactic.db.first("decision_relations", {
    where: { id },
  }) as JsonObject | null;
  if (!relation) throw new Error(`Relationship not found: ${id}`);
  if (relation.relation_type === "supersedes") {
    throw new Error(
      "Supersession relationships are canonical history and cannot be removed.",
    );
  }
  const result = await galactic.db.delete("decision_relations", {
    where: { id },
  });
  return { removed: true, relation_id: id, result };
}

export async function canon_evidence_add(args: {
  decision_id: string;
  type?: string;
  label?: string;
  ref: string;
  metadata?: JsonObject;
}): Promise<unknown> {
  const decisionId = requiredString(args?.decision_id, "decision_id", 100);
  await decisionRow(decisionId);
  await addEvidence(decisionId, [{
    type: args?.type,
    label: args?.label,
    ref: requiredString(args?.ref, "ref", 2_000),
    metadata: args?.metadata,
  }]);
  const rows = await galactic.db.select("decision_evidence", {
    where: { decision_id: decisionId },
    orderBy: { column: "created_at", dir: "desc" },
    limit: 1,
  });
  return rows[0];
}

export async function canon_evidence_remove(
  args: { evidence_id: string },
): Promise<unknown> {
  const id = requiredString(args?.evidence_id, "evidence_id", 100);
  const result = await galactic.db.delete("decision_evidence", {
    where: { id },
  });
  return { removed: true, evidence_id: id, result };
}

export async function canon_tags(args?: {
  action?: "list" | "upsert" | "archive";
  tag_id?: string;
  name?: string;
  description?: string;
  color?: string;
}): Promise<unknown> {
  const action = args?.action || "list";
  if (action === "list") {
    const tags = await galactic.db.select("tags", {
      where: { archived_at: { isNull: true } },
      orderBy: { column: "name", dir: "asc" },
      limit: 500,
    });
    return { tags, count: tags.length };
  }
  if (action === "archive") {
    const id = requiredString(args?.tag_id, "tag_id", 100);
    const links = await galactic.db.select("decision_tags", {
      columns: ["decision_id"],
      where: { tag_id: id },
      limit: 100,
    }) as Array<{ decision_id: string }>;
    await galactic.db.update("tags", {
      set: { archived_at: now(), updated_at: now() },
      where: { id },
    });
    await galactic.db.delete("decision_tags", { where: { tag_id: id } });
    const reembedded = await reembedDecisionIds(
      links.map((link) => link.decision_id),
    );
    return { archived: true, tag_id: id, reembedded };
  }
  const normalized = normalizeTag(args?.name);
  if (!normalized) throw new Error("name is required");
  const ts = now();
  if (args?.tag_id) {
    const links = await galactic.db.select("decision_tags", {
      columns: ["decision_id"],
      where: { tag_id: args.tag_id },
      limit: 100,
    }) as Array<{ decision_id: string }>;
    await galactic.db.update("tags", {
      set: {
        name: normalized.name,
        slug: normalized.slug,
        description: optionalString(args.description, 1_000) || "",
        color: optionalString(args.color, 40),
        archived_at: null,
        updated_at: ts,
      },
      where: { id: args.tag_id },
    });
    const tag = await galactic.db.first("tags", {
      where: { id: args.tag_id },
    });
    await reembedDecisionIds(links.map((link) => link.decision_id));
    return tag;
  }
  const tags = await ensureTags([normalized.name]);
  const tag = tags[0];
  if (
    tag &&
    (args?.description !== undefined || args?.color !== undefined)
  ) {
    await galactic.db.update("tags", {
      set: {
        description: optionalString(args?.description, 1_000) || "",
        color: optionalString(args?.color, 40),
        updated_at: ts,
      },
      where: { id: tag.id },
    });
  }
  return tag
    ? await galactic.db.first("tags", { where: { id: tag.id } })
    : null;
}

export async function canon_reembed(args?: {
  decision_id?: string;
  failed_only?: boolean;
  limit?: number;
}): Promise<unknown> {
  const limit = Math.min(100, Math.max(1, Number(args?.limit) || 25));
  const where: JsonObject = {};
  if (args?.decision_id) where.id = args.decision_id;
  else if (args?.failed_only !== false) where.embedding_status = "failed";
  const rows = await galactic.db.select("decisions", {
    columns: DECISION_COLUMNS,
    where,
    orderBy: { column: "updated_at", dir: "asc" },
    limit,
  }) as DecisionRow[];
  const tagMap = await tagsForDecisionIds(rows.map((row) => row.id));
  for (const row of rows) {
    await embedDecision(row, tagMap.get(row.id) || [], true);
  }
  const statuses = rows.length
    ? await galactic.db.select("decisions", {
      columns: ["id", "embedding_status", "embedding_error", "embedded_at"],
      where: { id: { in: rows.map((row) => row.id) } },
      limit: rows.length,
    })
    : [];
  return { attempted: rows.length, decisions: statuses };
}

export async function canon_status(_args?: {}): Promise<unknown> {
  const [active, superseded, archived, failedEmbeddings, tags, comments] =
    await Promise.all([
      galactic.db.count("decisions", { where: { status: "active" } }),
      galactic.db.count("decisions", { where: { status: "superseded" } }),
      galactic.db.count("decisions", { where: { status: "archived" } }),
      galactic.db.count("decisions", { where: { embedding_status: "failed" } }),
      galactic.db.count("tags", { where: { archived_at: { isNull: true } } }),
      galactic.db.count("decision_comments", {
        where: { deleted_at: { isNull: true } },
      }),
    ]);
  const due = await galactic.db.select("decisions", {
    columns: ["id", "title", "review_due_at"],
    where: { status: "active", review_due_at: { lte: now() } },
    orderBy: { column: "review_due_at", dir: "asc" },
    limit: 50,
  });
  return {
    decisions: {
      active,
      superseded,
      archived,
      total: active + superseded + archived,
    },
    tags,
    comments,
    failed_embeddings: failedEmbeddings,
    review_due: due,
  };
}
