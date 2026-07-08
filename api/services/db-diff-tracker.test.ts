import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { consumeDbDiff, recordDbMutation } from "./db-diff-tracker.ts";

Deno.test("db-diff-tracker: tallies ops + rows globally and by table; consume clears", () => {
  const id = crypto.randomUUID();
  recordDbMutation(id, "insert", "emails", 1);
  recordDbMutation(id, "insert", "emails", 2);
  recordDbMutation(id, "update", "emails", 3);
  recordDbMutation(id, "delete", "labels", 1);
  recordDbMutation(id, "upsert", "labels", 0);

  const tally = consumeDbDiff(id);
  assert(tally);
  assertEquals(tally.inserts, 2);
  assertEquals(tally.updates, 1);
  assertEquals(tally.deletes, 1);
  assertEquals(tally.upserts, 1);
  assertEquals(tally.rows_written, 1 + 2 + 3 + 1 + 0);
  assertEquals(tally.by_table.emails, {
    inserts: 2,
    updates: 1,
    deletes: 0,
    upserts: 0,
    rows: 6,
  });
  assertEquals(tally.by_table.labels, {
    inserts: 0,
    updates: 0,
    deletes: 1,
    upserts: 1,
    rows: 1,
  });

  // Consumed — a second read must not double-count.
  assertEquals(consumeDbDiff(id), null);
});

Deno.test("db-diff-tracker: a read-only wake (no mutations) consumes to null", () => {
  assertEquals(consumeDbDiff(crypto.randomUUID()), null);
  assertEquals(consumeDbDiff(null), null);
  assertEquals(consumeDbDiff(undefined), null);
});

Deno.test("db-diff-tracker: missing execution id records nothing", () => {
  recordDbMutation(null, "insert", "emails", 5);
  recordDbMutation(undefined, "insert", "emails", 5);
  // Nothing to leak into any real id.
  const id = crypto.randomUUID();
  assertEquals(consumeDbDiff(id), null);
});

Deno.test("db-diff-tracker: non-positive / non-finite row counts add ops but zero rows", () => {
  const id = crypto.randomUUID();
  recordDbMutation(id, "delete", "emails", 0);
  recordDbMutation(id, "delete", "emails", -4);
  recordDbMutation(id, "delete", "emails", Number.NaN);
  const tally = consumeDbDiff(id);
  assert(tally);
  assertEquals(tally.deletes, 3);
  assertEquals(tally.rows_written, 0);
});

Deno.test("db-diff-tracker: executions are isolated by id", () => {
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  recordDbMutation(a, "insert", "t", 1);
  recordDbMutation(b, "update", "t", 9);
  assertEquals(consumeDbDiff(a)?.inserts, 1);
  assertEquals(consumeDbDiff(b)?.updates, 1);
});

Deno.test("db-diff-tracker: by_table is bounded; overflow folds into (other)", () => {
  const id = crypto.randomUUID();
  // 32-table cap; write to 40 distinct tables.
  for (let i = 0; i < 40; i++) {
    recordDbMutation(id, "insert", `table_${i}`, 1);
  }
  const tally = consumeDbDiff(id);
  assert(tally);
  // 32 named buckets + the (other) fold = 33 keys max.
  assert(Object.keys(tally.by_table).length <= 33);
  assert(tally.by_table["(other)"]);
  // Global totals are unaffected by the cap.
  assertEquals(tally.inserts, 40);
  assertEquals(tally.rows_written, 40);
});

Deno.test("db-diff-tracker: blank table name buckets under (unknown)", () => {
  const id = crypto.randomUUID();
  recordDbMutation(id, "insert", "", 1);
  const tally = consumeDbDiff(id);
  assert(tally);
  assertEquals(tally.by_table["(unknown)"]?.inserts, 1);
});
