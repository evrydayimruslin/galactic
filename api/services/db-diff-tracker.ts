// Main-isolate ledger of galactic.db mutations actually executed per execution.
//
// The DatabaseBinding runs in the MAIN worker isolate (ctx.exports loopback) and
// records each write's D1 `meta.changes` here, keyed by executionId, as the op
// completes. executeInDynamicSandbox consumes the accumulated tally when it
// builds the ExecutionResult, and it is persisted into the flight recorder as a
// routine_run_step for opted-in routines.
//
// This lives HOST-SIDE (not an in-sandbox shim mirroring globalThis.__flight)
// on purpose: the flight recorder is an audit/evidence surface, so the "what
// changed" count must be authoritative and out of tenant reach — app code could
// under-report a shim. Same rationale + shape as ai-spend-tracker.ts.

export type DbMutationOp = "insert" | "update" | "delete" | "upsert";

export interface DbTableTally {
  inserts: number;
  updates: number;
  deletes: number;
  upserts: number;
  rows: number;
}

export interface DbDiffTally {
  inserts: number;
  updates: number;
  deletes: number;
  upserts: number;
  rows_written: number;
  by_table: Record<string, DbTableTally>;
}

// by_table is bounded so a wake touching many tables can't blow up the step
// metadata; overflow folds into a single "(other)" bucket.
const BY_TABLE_CAP = 32;
const OTHER_TABLE = "(other)";
const UNKNOWN_TABLE = "(unknown)";

const diffs = new Map<string, { tally: DbDiffTally; at: number }>();

// Executions are short-lived (≤120s); entries are consumed at result build.
// The TTL sweep only backstops a mutation that lands after its execution already
// aborted + consumed — bound the map so those can't leak. Mirrors ai-spend-tracker.
const ENTRY_TTL_MS = 15 * 60 * 1000;
const SWEEP_THRESHOLD = 1_000;

function emptyTally(): DbDiffTally {
  return {
    inserts: 0,
    updates: 0,
    deletes: 0,
    upserts: 0,
    rows_written: 0,
    by_table: {},
  };
}

function emptyTableTally(): DbTableTally {
  return { inserts: 0, updates: 0, deletes: 0, upserts: 0, rows: 0 };
}

const OP_FIELD: Record<DbMutationOp, keyof DbTableTally & keyof DbDiffTally> = {
  insert: "inserts",
  update: "updates",
  delete: "deletes",
  upsert: "upserts",
};

function tableBucket(tally: DbDiffTally, table: string): DbTableTally {
  const key = table && typeof table === "string" ? table : UNKNOWN_TABLE;
  const existing = tally.by_table[key];
  if (existing) return existing;
  // At cap and this is a new table → fold into "(other)".
  if (Object.keys(tally.by_table).length >= BY_TABLE_CAP) {
    tally.by_table[OTHER_TABLE] ??= emptyTableTally();
    return tally.by_table[OTHER_TABLE];
  }
  const fresh = emptyTableTally();
  tally.by_table[key] = fresh;
  return fresh;
}

export function recordDbMutation(
  executionId: string | null | undefined,
  op: DbMutationOp,
  table: string,
  rowsChanged: number | null | undefined,
): void {
  if (!executionId) return;
  if (diffs.size >= SWEEP_THRESHOLD) sweep();
  const rows = typeof rowsChanged === "number" && Number.isFinite(rowsChanged) &&
      rowsChanged > 0
    ? rowsChanged
    : 0;
  const entry = diffs.get(executionId) ?? { tally: emptyTally(), at: Date.now() };
  const field = OP_FIELD[op];
  entry.tally[field] += 1;
  entry.tally.rows_written += rows;
  const bucket = tableBucket(entry.tally, table);
  bucket[field] += 1;
  bucket.rows += rows;
  entry.at = Date.now();
  diffs.set(executionId, entry);
}

// Read-and-clear. Returns null when nothing was recorded (no galactic.db writes,
// read-only wake) so callers can skip persistence entirely.
export function consumeDbDiff(
  executionId: string | null | undefined,
): DbDiffTally | null {
  if (!executionId) return null;
  const entry = diffs.get(executionId);
  if (!entry) return null;
  diffs.delete(executionId);
  const t = entry.tally;
  const anyOps = t.inserts + t.updates + t.deletes + t.upserts > 0;
  return anyOps ? t : null;
}

function sweep(): void {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  for (const [key, entry] of diffs) {
    if (entry.at < cutoff) diffs.delete(key);
  }
}
