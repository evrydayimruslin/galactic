// WO-6 D1 tier-1 (option C): concept indexing for manifest-declared D1 text
// columns, with EXACT row identity via `RETURNING rowid` on mutations.
//
// Mentions are derived — a pure function of each (row, column)'s current
// text. Exact affected-row ids make the contract airtight: an UPDATE that
// edits brackets away clears its stale mentions, and a DELETE removes the
// row's mentions entirely. The planning half here is pure (unit-tested);
// the apply half performs best-effort reindexing that must never fail or
// slow the tenant write it rides on (bracket/declared-column prefilters
// keep the common path zero-cost).

import {
  extractConceptMentions,
} from "../../services/concept-mentions.ts";
import type { ReindexMention } from "../../services/agent-concepts.ts";

const ENTRY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

export type D1ConceptsIndex = Map<string, Set<string>>;

/** Parse manifest `concepts_index` entries ("table.column"). Invalid entries
 * are dropped, never thrown — a bad manifest line must not break the
 * database binding. */
export function parseConceptsIndex(
  entries: readonly string[] | undefined | null,
): D1ConceptsIndex {
  const index: D1ConceptsIndex = new Map();
  for (const raw of entries ?? []) {
    if (typeof raw !== "string" || !ENTRY_PATTERN.test(raw.trim())) continue;
    const [table, column] = raw.trim().split(".", 2);
    const set = index.get(table) ?? new Set<string>();
    set.add(column);
    index.set(table, set);
  }
  return index;
}

export type D1MutationKind = "insert" | "update" | "upsert" | "delete";

export interface D1ConceptPlan {
  /** Append `RETURNING rowid` and run the apply step afterwards. */
  needRowIds: boolean;
  /** Declared columns this mutation writes (empty for delete). */
  columns: string[];
}

/**
 * Decide whether a mutation needs exact row identity. The asymmetry is the
 * point: INSERT indexes only when a new value actually contains brackets
 * (nothing prior to clear), while UPDATE/UPSERT need row ids whenever a
 * declared column is WRITTEN at all — the new value may have removed
 * brackets, and clearing stale mentions is the contract. DELETE needs ids
 * whenever the table is indexed.
 */
export function planD1ConceptIndexing(input: {
  index: D1ConceptsIndex;
  kind: D1MutationKind;
  table: string;
  /** Written column values: insert rows merged, or the update/upsert SET. */
  written: readonly Record<string, unknown>[];
}): D1ConceptPlan {
  const declared = input.index.get(input.table);
  if (!declared || declared.size === 0) {
    return { needRowIds: false, columns: [] };
  }
  if (input.kind === "delete") {
    return { needRowIds: true, columns: [...declared] };
  }
  const columns = [...declared].filter((column) =>
    input.written.some((row) =>
      Object.prototype.hasOwnProperty.call(row, column)
    )
  );
  if (columns.length === 0) return { needRowIds: false, columns: [] };
  if (input.kind === "insert") {
    const anyBrackets = columns.some((column) =>
      input.written.some((row) => {
        const value = row[column];
        return typeof value === "string" && value.includes("[[");
      })
    );
    return { needRowIds: anyBrackets, columns: anyBrackets ? columns : [] };
  }
  return { needRowIds: true, columns };
}

export function extractRowIds(
  results: readonly Record<string, unknown>[] | undefined,
): number[] {
  const ids: number[] = [];
  for (const row of results ?? []) {
    const value = row.rowid;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      ids.push(value);
    }
  }
  return ids;
}

/**
 * Apply after a successful mutation. Best-effort by contract: any failure
 * logs and returns — indexing never fails the tenant write. surface_id is
 * per (table, column, rowid) so replacing one column's mentions never
 * touches a sibling column's.
 */
export async function applyD1ConceptIndexing(input: {
  userId: string;
  appId: string;
  table: string;
  kind: D1MutationKind;
  columns: readonly string[];
  /** Row-aligned written values for insert (one per rowid); single SET row
   * for update/upsert (applies to every affected rowid); ignored for
   * delete. */
  written: readonly Record<string, unknown>[];
  rowIds: readonly number[];
}): Promise<void> {
  try {
    const { reindexSurface } = await import(
      "../../services/agent-concepts.ts"
    );
    for (let i = 0; i < input.rowIds.length; i++) {
      const rowId = input.rowIds[i];
      const row = input.kind === "insert"
        ? input.written[i] ?? input.written[0] ?? {}
        : input.written[0] ?? {};
      for (const column of input.columns) {
        const surfaceId = `${input.table}.${column}:${rowId}`;
        let mentions: ReindexMention[] = [];
        if (input.kind !== "delete") {
          const value = row[column];
          if (typeof value === "string" && value.includes("[[")) {
            mentions = extractConceptMentions(value, { blockSplit: "whole" });
          }
        }
        await reindexSurface(
          input.userId,
          input.appId,
          "d1",
          surfaceId,
          mentions,
        );
      }
    }
  } catch (err) {
    console.error(
      "[CONCEPTS] d1 reindex failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
