import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  loadAndValidateStagedMigrations,
  strictAdditiveMigrationErrors,
} from "./staged-migrations.ts";

class FakeR2 {
  constructor(private readonly files: Record<string, string>) {}
  listFiles(prefix: string): Promise<string[]> {
    return Promise.resolve(
      Object.keys(this.files).filter((key) => key.startsWith(prefix)),
    );
  }
  fetchTextFile(key: string): Promise<string> {
    const value = this.files[key];
    if (value === undefined) return Promise.reject(new Error("not found"));
    return Promise.resolve(value);
  }
}

const PREFIX = "apps/app-1/1.2.3/";

Deno.test("staged migrations: reloads and accepts strictly additive SQL", async () => {
  const r2 = new FakeR2({
    [`${PREFIX}index.ts`]: "export const run = () => true;",
    [`${PREFIX}migrations/001_journal.sql`]: `
      CREATE TABLE journal (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX idx_journal_user ON journal(user_id);
    `,
  });
  const result = await loadAndValidateStagedMigrations(r2, PREFIX);
  assertEquals(result.migrations.length, 1);
  assertEquals(strictAdditiveMigrationErrors(result), []);
});

Deno.test("staged migrations: connected promotion rejects warnings and errors", async () => {
  const r2 = new FakeR2({
    [`${PREFIX}nested/migrations/001_rename.sql`]:
      "ALTER TABLE journal RENAME COLUMN body TO content;",
    [`${PREFIX}nested/migrations/002_drop.sql`]: "DROP TABLE journal;",
  });
  const result = await loadAndValidateStagedMigrations(r2, PREFIX);
  const strictErrors = strictAdditiveMigrationErrors(result);
  assert(strictErrors.some((message) => message.includes("RENAME")));
  assert(strictErrors.some((message) => message.includes("DROP TABLE")));
});

Deno.test("staged migrations: comment-aware allowlist accepts additive DDL", async () => {
  const r2 = new FakeR2({
    [`${PREFIX}migrations/001_comments.sql`]: `
      CREATE/**/TABLE journal (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        body TEXT DEFAULT 'CREATE TABLE fake (id); DROP TABLE; PRAGMA; ATTACH DATABASE; DELETE FROM remain inert here'
      );
      CREATE/* between allowed keywords */INDEX idx_journal_user
        ON/**/journal(user_id);
      CREATE UNIQUE INDEX idx_journal_body ON journal(body);
      ALTER/* safe */TABLE journal ADD/**/COLUMN summary TEXT DEFAULT 'x;y';
    `,
  });
  const result = await loadAndValidateStagedMigrations(r2, PREFIX);
  assertEquals(strictAdditiveMigrationErrors(result), []);
});

Deno.test("staged migrations: comments cannot bypass tenant schema checks", async () => {
  const r2 = new FakeR2({
    [`${PREFIX}migrations/001_missing_owner.sql`]: `
      CREATE/**/TABLE journal (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL
      );
    `,
  });
  const result = await loadAndValidateStagedMigrations(r2, PREFIX);
  const strictErrors = strictAdditiveMigrationErrors(result);
  assert(
    strictErrors.some((message) => message.includes("user_id TEXT NOT NULL")),
  );
});

Deno.test("staged migrations: quoted and qualified tables retain tenant checks", async () => {
  const safe = new FakeR2({
    [`${PREFIX}migrations/001_quoted.sql`]: `
      CREATE TABLE [journal] (
        [id] TEXT PRIMARY KEY,
        [user_id] TEXT NOT NULL
      );
      CREATE INDEX [idx_journal_user] ON [journal]([user_id]);
      CREATE TABLE main.notes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL
      );
      CREATE INDEX main.idx_notes_user ON main.notes(user_id);
    `,
  });
  const safeResult = await loadAndValidateStagedMigrations(safe, PREFIX);
  assertEquals(strictAdditiveMigrationErrors(safeResult), []);

  const unsafe = new FakeR2({
    [`${PREFIX}migrations/001_quoted.sql`]: `
      CREATE TABLE [journal] ([id] TEXT PRIMARY KEY);
      CREATE INDEX [idx_journal_id] ON [journal]([id]);
    `,
  });
  const unsafeResult = await loadAndValidateStagedMigrations(unsafe, PREFIX);
  assert(
    strictAdditiveMigrationErrors(unsafeResult).some((message) =>
      message.includes('Table "journal" must include')
    ),
  );
});

Deno.test("staged migrations: comment-separated destructive keywords fail closed", async () => {
  const r2 = new FakeR2({
    [`${PREFIX}migrations/001_drop.sql`]: "DROP/**/TABLE journal;",
  });
  const result = await loadAndValidateStagedMigrations(r2, PREFIX);
  const strictErrors = strictAdditiveMigrationErrors(result);
  assert(strictErrors.some((message) => message.includes("DROP TABLE")));
  assert(strictErrors.some((message) => message.includes("is not allowed")));
});

Deno.test("staged migrations: bracket identifiers cannot conceal a second statement", async () => {
  const r2 = new FakeR2({
    [`${PREFIX}migrations/001_bracket.sql`]:
      "CREATE TABLE [journal]]; DROP TABLE journal; --] (user_id TEXT NOT NULL);",
  });
  const result = await loadAndValidateStagedMigrations(r2, PREFIX);
  const strictErrors = strictAdditiveMigrationErrors(result);
  assert(
    strictErrors.some((message) =>
      message.includes("statement 2") && message.includes("DROP TABLE JOURNAL")
    ),
  );
});

Deno.test("staged migrations: allowlist rejects every non-additive statement class", async () => {
  const rejected = [
    ["update", "UPDATE journal SET body = 'changed'"],
    ["insert", "INSERT INTO journal (body) VALUES ('changed')"],
    ["delete", "DELETE FROM journal"],
    ["drop-view", "DROP VIEW journal_view"],
    [
      "trigger",
      "CREATE TRIGGER journal_trigger AFTER INSERT ON journal BEGIN SELECT 1; END",
    ],
    ["view", "CREATE VIEW journal_view AS SELECT * FROM journal"],
    ["virtual-table", "CREATE VIRTUAL TABLE journal_search USING fts5(body)"],
    ["pragma", "PRAGMA foreign_keys = OFF"],
    ["attach", "ATTACH DATABASE 'other.db' AS other"],
    ["detach", "DETACH DATABASE other"],
    ["vacuum", "VACUUM"],
    ["reindex", "REINDEX journal"],
    ["select", "SELECT 1"],
  ] as const;

  for (const [name, sql] of rejected) {
    const r2 = new FakeR2({
      [`${PREFIX}migrations/001_${name}.sql`]: sql,
    });
    const result = await loadAndValidateStagedMigrations(r2, PREFIX);
    const strictErrors = strictAdditiveMigrationErrors(result);
    assert(
      strictErrors.some((message) => message.includes("is not allowed")),
      `${name} unexpectedly passed: ${JSON.stringify(strictErrors)}`,
    );
  }
});

Deno.test("staged migrations: rejects disallowed second statement after safe DDL", async () => {
  const r2 = new FakeR2({
    [`${PREFIX}migrations/001_multi.sql`]: `
      CREATE TABLE journal (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        body TEXT DEFAULT 'not a delimiter; still the default'
      );
      CREATE INDEX idx_journal_user ON journal(user_id);
      UPDATE journal SET body = 'mutated';
    `,
  });
  const result = await loadAndValidateStagedMigrations(r2, PREFIX);
  const strictErrors = strictAdditiveMigrationErrors(result);
  assert(
    strictErrors.some((message) =>
      message.includes("statement 3") && message.includes("UPDATE JOURNAL SET")
    ),
  );
});

Deno.test("staged migrations: CREATE TABLE AS SELECT and non-ADD ALTER are rejected", async () => {
  const r2 = new FakeR2({
    [`${PREFIX}migrations/001_create_as.sql`]:
      "CREATE TABLE copied AS SELECT * FROM journal;",
    [`${PREFIX}migrations/002_alter.sql`]:
      "ALTER TABLE journal RENAME COLUMN body TO content;",
    [`${PREFIX}migrations/003_multiple_add.sql`]:
      "ALTER TABLE journal ADD COLUMN summary TEXT, DROP COLUMN body;",
  });
  const result = await loadAndValidateStagedMigrations(r2, PREFIX);
  const strictErrors = strictAdditiveMigrationErrors(result);
  assert(
    strictErrors.some((message) => message.includes("CREATE TABLE AS SELECT")),
  );
  assert(strictErrors.some((message) => message.includes("only ADD [COLUMN]")));
  assert(strictErrors.some((message) => message.includes("only one column")));
});

Deno.test("staged migrations: malformed comments, quotes, and NUL bytes fail closed", async () => {
  const malformed = [
    ["comment", "CREATE TABLE journal (user_id TEXT NOT NULL /* never closes"],
    ["quote", "ALTER TABLE journal ADD COLUMN body TEXT DEFAULT 'never closes"],
    ["nul", "ALTER TABLE journal ADD COLUMN body TEXT\0DROP TABLE journal"],
  ] as const;

  for (const [name, sql] of malformed) {
    const r2 = new FakeR2({
      [`${PREFIX}migrations/001_${name}.sql`]: sql,
    });
    const result = await loadAndValidateStagedMigrations(r2, PREFIX);
    const strictErrors = strictAdditiveMigrationErrors(result);
    assert(
      strictErrors.some((message) =>
        message.includes("unterminated") || message.includes("NUL bytes")
      ),
      `${name} unexpectedly passed: ${JSON.stringify(strictErrors)}`,
    );
  }
});

Deno.test("staged migrations: duplicate normalized filenames fail closed", async () => {
  const r2 = new FakeR2({
    [`${PREFIX}a/migrations/001_init.sql`]: "SELECT 1;",
    [`${PREFIX}b/migrations/001_init.sql`]: "SELECT 1;",
  });
  let error = "";
  try {
    await loadAndValidateStagedMigrations(r2, PREFIX);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  assert(error.includes("Duplicate staged migration filename"));
});
