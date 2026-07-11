import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

type Row = Record<string, unknown>;

class MemoryDb {
  tables = new Map<string, Row[]>();

  private rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  private matches(row: Row, where: Row = {}): boolean {
    for (const [key, expected] of Object.entries(where || {})) {
      if (key === "_or") {
        if (!(expected as Row[]).some((part) => this.matches(row, part))) {
          return false;
        }
        continue;
      }
      const actual = row[key];
      if (
        expected && typeof expected === "object" &&
        !Array.isArray(expected)
      ) {
        const op = expected as Row;
        if ("in" in op && !(op.in as unknown[]).includes(actual)) return false;
        if (op.isNull === true && actual !== null && actual !== undefined) {
          return false;
        }
        if ("lte" in op && String(actual || "") > String(op.lte || "")) {
          return false;
        }
        continue;
      }
      if (actual !== expected) return false;
    }
    return true;
  }

  async insert(table: string, values: Row | Row[]) {
    const rows = Array.isArray(values) ? values : [values];
    this.rows(table).push(...rows.map((row) => ({ ...row })));
    return { success: true, id: rows[0]?.id };
  }

  async select(table: string, query: Row = {}) {
    let rows = this.rows(table).filter((row) =>
      this.matches(row, query.where as Row || {})
    ).map((
      row,
    ) => ({ ...row }));
    const order = query.orderBy as { column: string; dir: string } | undefined;
    if (order) {
      rows.sort((a, b) =>
        String(a[order.column] || "").localeCompare(
          String(b[order.column] || ""),
        ) * (order.dir === "desc" ? -1 : 1)
      );
    }
    const offset = Number(query.offset || 0);
    const limit = Number(query.limit || rows.length);
    rows = rows.slice(offset, offset + limit);
    const columns = query.columns as string[] | undefined;
    if (columns) {
      rows = rows.map((row) =>
        Object.fromEntries(columns.map((column) => [column, row[column]]))
      );
    }
    return rows;
  }

  async first(table: string, query: Row = {}) {
    return (await this.select(table, { ...query, limit: 1 }))[0] || null;
  }

  async count(table: string, query: Row = {}) {
    return (await this.select(table, query)).length;
  }

  async update(table: string, spec: Row) {
    let changed = 0;
    for (const row of this.rows(table)) {
      if (!this.matches(row, spec.where as Row || {})) continue;
      Object.assign(row, spec.set as Row || {});
      changed++;
    }
    return { success: true, meta: { rows_written: changed } };
  }

  async delete(table: string, spec: Row) {
    const rows = this.rows(table);
    const keep = rows.filter((row) =>
      !this.matches(row, spec.where as Row || {})
    );
    this.tables.set(table, keep);
    return { success: true, meta: { rows_written: rows.length - keep.length } };
  }

  async upsert(table: string, spec: Row) {
    const values = spec.values as Row;
    const keys = spec.onConflict as string[];
    const existing = this.rows(table).find((row) =>
      keys.every((key) => row[key] === values[key])
    );
    if (existing) Object.assign(existing, spec.set as Row || {});
    else this.rows(table).push({ ...values });
    return { success: true, id: existing?.id || values.id };
  }
}

const db = new MemoryDb();
let embedFails = false;

(globalThis as unknown as { galactic: unknown }).galactic = {
  db,
  embed: async ({ input }: { input: string }) => {
    if (embedFails) throw new Error("embedding unavailable");
    const text = input.toLowerCase();
    const embedding = [
      text.includes("agent") ? 1 : 0.1,
      text.includes("memory") || text.includes("canon") ? 1 : 0.1,
      text.includes("email") ? 1 : 0.1,
    ];
    return {
      embedding,
      model: "openai/text-embedding-3-small",
      dimensions: embedding.length,
      usage: { input_tokens: 10, total_tokens: 10, cost_light: 0 },
    };
  },
};

const canon = await import("./index.ts");

Deno.test("Galactic Canon lifecycle preserves revisions, tags, comments, search, and supersession", async () => {
  const created = await canon.canon_create({
    title: "Full-time agent context is pull-based",
    statement:
      "Full-time agents explicitly retrieve D1 state, memory, and recent runs on each wake.",
    rationale: "This keeps wake context bounded and application-specific.",
    consequences: "Agent developers must design their retrieval loop.",
    tags: ["Full-time Agents", "Architecture"],
    author_type: "collaborative",
    author_label: "Russell + Codex",
    source_ref: "task:canon-design",
    evidence: [{ type: "file", ref: "api/services/routine-executor.ts" }],
  }) as Row;
  const first = created.decision as Row;
  const firstId = String(first.id);
  assertEquals(first.embedding_status, "ready");
  assertEquals((created.tags as Row[]).map((tag) => tag.slug).sort(), [
    "architecture",
    "full-time-agents",
  ]);
  assertEquals((created.revisions as Row[]).length, 1);
  assertEquals((created.evidence as Row[]).length, 1);

  const updated = await canon.canon_update({
    decision_id: firstId,
    rationale:
      "Bounded, explicit retrieval keeps context relevant and auditable.",
    tags: ["Full-time Agents", "Context"],
    change_comment: "Clarified the context-budget rationale.",
    author_type: "agent",
    author_label: "Codex",
  }) as Row;
  assertEquals((updated.revisions as Row[]).length, 2);
  assertEquals((updated.tags as Row[]).map((tag) => tag.slug).sort(), [
    "context",
    "full-time-agents",
  ]);

  await canon.canon_comment_add({
    decision_id: firstId,
    kind: "implementation",
    body: "The scaffold reads its D1 journal and flight recorder explicitly.",
    author_type: "agent",
    author_label: "Codex",
    include_in_context: true,
  });
  const withComment = await canon.canon_get({ decision_id: firstId }) as Row;
  assertEquals((withComment.comments as Row[]).length, 1);

  const search = await canon.canon_search({
    query: "How should agents retrieve memory and context?",
    limit: 5,
  }) as Row;
  assertEquals(search.method, "hybrid");
  assertEquals((search.decisions as Row[])[0].id, firstId);

  const replacement = await canon.canon_create({
    title: "Routine context policy",
    statement:
      "Routine agents use explicit retrieval now and may adopt a bounded platform context envelope later.",
    rationale: "Preserves current control while leaving a standard path open.",
    tags: ["Full-time Agents", "Context"],
  }) as Row;
  const replacementId = String((replacement.decision as Row).id);
  await canon.canon_supersede({
    decision_id: firstId,
    replacement_id: replacementId,
    note: "The replacement records the intended platform evolution.",
  });
  const historical = await canon.canon_get({ decision_id: firstId }) as Row;
  assertEquals((historical.decision as Row).status, "superseded");
  assertEquals(
    ((historical.relations as Row).incoming as Row[])[0].relation_type,
    "supersedes",
  );

  const context = await canon.canon_context({
    query: "full-time agent context",
    include_comments: true,
    limit: 10,
  }) as Row;
  const contextRows = context.decisions as Row[];
  assert(contextRows.some((decision) => decision.id === replacementId));
  assert(!contextRows.some((decision) => decision.id === firstId));
});

Deno.test("Galactic Canon keeps writes when embedding fails and supports repair", async () => {
  embedFails = true;
  const created = await canon.canon_create({
    title: "Embedding failures do not block Canon writes",
    statement:
      "Canonical decisions remain durable when semantic indexing fails.",
    tags: ["Reliability"],
  }) as Row;
  const id = String((created.decision as Row).id);
  assertEquals((created.decision as Row).embedding_status, "failed");

  embedFails = false;
  const repaired = await canon.canon_reembed({ decision_id: id }) as Row;
  assertEquals((repaired.decisions as Row[])[0].embedding_status, "ready");
});
