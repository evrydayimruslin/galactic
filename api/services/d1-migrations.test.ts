import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertStringIncludes } from "https://deno.land/std@0.210.0/assert/assert_string_includes.ts";
import {
  MAX_MIGRATION_FILE_BYTES,
  validateMigrationSchema,
} from "./d1-migrations.ts";

Deno.test("migration validator: a well-formed per-user table passes", () => {
  const result = validateMigrationSchema(
    `CREATE TABLE notes (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       body TEXT
     );
     CREATE INDEX idx_notes_user ON notes(user_id);`,
  );
  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("migration validator: a table without user_id is rejected", () => {
  const result = validateMigrationSchema(
    `CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);`,
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.errors.join(" "), "user_id");
});

Deno.test("migration validator: user_id requirement cannot be satisfied by a substring column", () => {
  // `not_user_id` contains the substring "user_id" but is not the required
  // column — the old /user_id/i.test check would have wrongly accepted this.
  const result = validateMigrationSchema(
    `CREATE TABLE notes (id TEXT PRIMARY KEY, not_user_id TEXT NOT NULL, body TEXT);`,
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.errors.join(" "), "user_id");
});

Deno.test("migration validator: a real user_id column is accepted even with a decoy default", () => {
  const result = validateMigrationSchema(
    `CREATE TABLE notes (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL DEFAULT 'x',
       label TEXT DEFAULT 'user_id'
     );
     CREATE INDEX idx_notes_user ON notes(user_id);`,
  );
  assertEquals(result.valid, true);
});

Deno.test("migration validator: ALTER TABLE ... DROP COLUMN is rejected", () => {
  const result = validateMigrationSchema(
    `ALTER TABLE notes DROP COLUMN body;`,
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.errors.join(" "), "DROP COLUMN");
});

Deno.test("migration validator: INSERT into a reserved _-table is rejected", () => {
  const result = validateMigrationSchema(
    `INSERT INTO _usage (user_id, rows_read_total) VALUES ('victim', 999);`,
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.errors.join(" "), "_usage");
});

Deno.test("migration validator: UPDATE/DELETE against a reserved _-table is rejected", () => {
  const upd = validateMigrationSchema(`UPDATE _migrations SET applied = 1;`);
  assertEquals(upd.valid, false);
  assertStringIncludes(upd.errors.join(" "), "_migrations");

  const del = validateMigrationSchema(`DELETE FROM _usage WHERE user_id = 'x';`);
  assertEquals(del.valid, false);
  assertStringIncludes(del.errors.join(" "), "_usage");
});

Deno.test("migration validator: an oversized file is rejected before any regex runs (ReDoS guard)", () => {
  // Build a file just over the per-file cap out of many ALTER TABLE statements
  // with no DROP COLUMN — the exact shape that made the old unbounded lazy
  // regex quadratic. The size guard must reject it up front.
  const stmt = "ALTER TABLE x ADD COLUMN y TEXT;\n";
  const repeats = Math.ceil((MAX_MIGRATION_FILE_BYTES + 1) / stmt.length);
  const huge = stmt.repeat(repeats);
  const result = validateMigrationSchema(huge);
  assertEquals(result.valid, false);
  assertStringIncludes(result.errors.join(" "), "too large");
});

Deno.test("migration validator: semicolons inside string literals do not split statements", () => {
  // A legit INSERT into a NON-reserved table whose value contains ';' and even
  // the text 'DROP COLUMN' inside a string must not trip the destructive check.
  const result = validateMigrationSchema(
    `CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, body TEXT);
     CREATE INDEX idx_notes_user ON notes(user_id);
     INSERT INTO notes (id, user_id, body) VALUES ('1', 'u1', 'a; b DROP COLUMN c');`,
  );
  assertEquals(result.valid, true);
});
