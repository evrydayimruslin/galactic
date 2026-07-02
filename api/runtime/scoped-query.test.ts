import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertThrows } from "https://deno.land/std@0.210.0/assert/assert_throws.ts";
import { assertStringIncludes } from "https://deno.land/std@0.210.0/assert/assert_string_includes.ts";

import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  buildUpsert,
  ScopedQueryError,
} from "../src/bindings/scoped-query.ts";

const UID = "user-abc";

// ── INSERT ──

Deno.test("insert injects user_id and parameterizes values", () => {
  const { sql, params } = buildInsert(
    { table: "items", values: { name: "Widget", qty: 3 } },
    UID,
  );
  assertEquals(
    sql,
    `INSERT INTO "items" ("name", "qty", "user_id") VALUES (?, ?, ?)`,
  );
  assertEquals(params, ["Widget", 3, UID]);
});

Deno.test("insert ignores an app-supplied user_id (cannot forge ownership)", () => {
  const { sql, params } = buildInsert(
    { table: "items", values: { name: "X", user_id: "victim" } },
    UID,
  );
  // "victim" never reaches params; the caller's UID is used instead.
  assertEquals(sql, `INSERT INTO "items" ("name", "user_id") VALUES (?, ?)`);
  assertEquals(params, ["X", UID]);
});

Deno.test("insert supports multiple rows with a user_id per row", () => {
  const { sql, params } = buildInsert(
    { table: "items", values: [{ name: "A" }, { name: "B" }] },
    UID,
  );
  assertEquals(
    sql,
    `INSERT INTO "items" ("name", "user_id") VALUES (?, ?), (?, ?)`,
  );
  assertEquals(params, ["A", UID, "B", UID]);
});

// ── SELECT ──

Deno.test("select always scopes to the caller (user_id last)", () => {
  const { sql, params } = buildSelect({ table: "items" }, UID);
  assertEquals(sql, `SELECT "t0".* FROM "items" AS "t0" WHERE "t0"."user_id" = ?`);
  assertEquals(params, [UID]);
});

Deno.test("select where: equality, operators, in, null, _or", () => {
  const a = buildSelect(
    { table: "items", where: { status: "active", qty: { gte: 5 } } },
    UID,
  );
  assertEquals(
    a.sql,
    `SELECT "t0".* FROM "items" AS "t0" WHERE "t0"."status" = ? AND "t0"."qty" >= ? AND "t0"."user_id" = ?`,
  );
  assertEquals(a.params, ["active", 5, UID]);

  const b = buildSelect(
    { table: "items", where: { id: { in: ["a", "b"] }, note: null } },
    UID,
  );
  assertEquals(
    b.sql,
    `SELECT "t0".* FROM "items" AS "t0" WHERE "t0"."id" IN (?, ?) AND "t0"."note" IS NULL AND "t0"."user_id" = ?`,
  );
  assertEquals(b.params, ["a", "b", UID]);

  const c = buildSelect(
    { table: "items", where: { _or: [{ a: 1 }, { b: 2 }] } },
    UID,
  );
  assertEquals(
    c.sql,
    `SELECT "t0".* FROM "items" AS "t0" WHERE (("t0"."a" = ?) OR ("t0"."b" = ?)) AND "t0"."user_id" = ?`,
  );
  assertEquals(c.params, [1, 2, UID]);
});

Deno.test("select columns, aggregates, groupBy, orderBy, pagination", () => {
  const { sql, params } = buildSelect(
    {
      table: "txns",
      columns: [
        "category",
        { fn: "sum", column: "amount", as: "total" },
        { fn: "count", as: "n" },
      ],
      where: { type: "expense" },
      groupBy: ["category"],
      orderBy: [{ as: "total", dir: "desc" }],
      limit: 10,
      offset: 20,
    },
    UID,
  );
  assertEquals(
    sql,
    `SELECT "t0"."category", SUM("t0"."amount") AS "total", COUNT(*) AS "n" FROM "txns" AS "t0" ` +
      `WHERE "t0"."type" = ? AND "t0"."user_id" = ? GROUP BY "t0"."category" ORDER BY "total" DESC LIMIT 10 OFFSET 20`,
  );
  assertEquals(params, ["expense", UID]);
});

Deno.test("select with a join scopes EVERY table by user_id", () => {
  const { sql, params } = buildSelect(
    {
      table: "conversations",
      columns: [
        { table: "base", column: "id", as: "cid" },
        { table: "versions", column: "body" },
      ],
      joins: [
        {
          table: "versions",
          on: { column: "id", foreignColumn: "conversation_id" },
        },
      ],
      where: { "versions.status": "final" },
    },
    UID,
  );
  // Joined table is scoped in its ON clause (not WHERE) so LEFT JOINs keep their
  // semantics; params follow placeholder order: join scope, then WHERE.
  assertEquals(
    sql,
    `SELECT "t0"."id" AS "cid", "t1"."body" FROM "conversations" AS "t0" ` +
      `JOIN "versions" AS "t1" ON "t0"."id" = "t1"."conversation_id" AND "t1"."user_id" = ? ` +
      `WHERE "t1"."status" = ? AND "t0"."user_id" = ?`,
  );
  assertEquals(params, [UID, "final", UID]);
});

Deno.test("left join scopes the joined table in ON (preserves outer-join semantics)", () => {
  const { sql, params } = buildSelect(
    {
      table: "pages",
      joins: [{
        table: "links",
        type: "left",
        on: { column: "id", foreignColumn: "page_id" },
      }],
    },
    UID,
  );
  // Joined table scoped in the ON clause...
  assertStringIncludes(
    sql,
    `LEFT JOIN "links" AS "t1" ON "t0"."id" = "t1"."page_id" AND "t1"."user_id" = ?`,
  );
  // ...and NOT re-scoped in WHERE (that would filter out unmatched rows, i.e.
  // silently demote the LEFT JOIN to an INNER JOIN).
  const whereClause = sql.slice(sql.indexOf(" WHERE "));
  assertStringIncludes(whereClause, `"t0"."user_id" = ?`);
  if (whereClause.includes(`"t1"."user_id"`)) {
    throw new Error("joined table re-scoped in WHERE — LEFT JOIN demoted to INNER");
  }
  assertEquals(params, [UID, UID]); // t1 (ON), t0 (WHERE)
});

Deno.test("having filters by an aggregate output alias (not a base column)", () => {
  const { sql, params } = buildSelect(
    {
      table: "txns",
      columns: [{ fn: "sum", column: "amount", as: "total" }],
      groupBy: ["category"],
      having: { total: { gt: 15 } },
    },
    UID,
  );
  // HAVING references the SELECT alias "total", which SQLite accepts — NOT
  // "t0"."total" (which would be "no such column").
  assertStringIncludes(sql, `HAVING "total" > ?`);
  assertEquals(params, [UID, 15]);
});

Deno.test("boolean values are coerced to 1/0 (D1 has no boolean bind type)", () => {
  const ins = buildInsert({ table: "tasks", values: { title: "x", done: true } }, UID);
  assertEquals(ins.params, ["x", 1, UID]);
  const sel = buildSelect({ table: "tasks", where: { done: false } }, UID);
  assertEquals(sel.params, [0, UID]);
});

Deno.test("limit/offset reject out-of-range integers (no scientific notation in SQL)", () => {
  assertThrows(() => buildSelect({ table: "t", limit: 1e21 }, UID), ScopedQueryError);
  assertThrows(() => buildSelect({ table: "t", offset: 1e21 }, UID), ScopedQueryError);
  assertThrows(() => buildSelect({ table: "t", limit: -1 }, UID), ScopedQueryError);
  assertThrows(() => buildSelect({ table: "t", limit: 1.5 }, UID), ScopedQueryError);
});

Deno.test("rejects a qualified user_id key in a filter (dotted-guard)", () => {
  for (
    const where of [
      { "base.user_id": "victim" },
      { "items.user_id": "victim" },
    ] as const
  ) {
    assertThrows(
      () => buildSelect({ table: "items", where }, UID),
      ScopedQueryError,
      "user_id",
    );
  }
});

// ── COUNT ──

Deno.test("count builds a scoped COUNT with optional distinct", () => {
  assertEquals(
    buildCount({ table: "items" }, UID).sql,
    `SELECT COUNT(*) AS count FROM "items" AS "t0" WHERE "t0"."user_id" = ?`,
  );
  assertEquals(
    buildCount({ table: "logs", column: "day", distinct: true }, UID).sql,
    `SELECT COUNT(DISTINCT "t0"."day") AS count FROM "logs" AS "t0" WHERE "t0"."user_id" = ?`,
  );
});

// ── UPDATE / DELETE ──

Deno.test("update scopes the where and rejects changing user_id", () => {
  const { sql, params } = buildUpdate(
    { table: "items", set: { name: "New" }, where: { id: "x" } },
    UID,
  );
  assertEquals(
    sql,
    `UPDATE "items" SET "name" = ? WHERE "id" = ? AND "user_id" = ?`,
  );
  assertEquals(params, ["New", "x", UID]);

  assertThrows(
    () => buildUpdate({ table: "items", set: { user_id: "victim" } }, UID),
    ScopedQueryError,
    "user_id",
  );
});

Deno.test("update supports increment / max / min expressions", () => {
  assertEquals(
    buildUpdate({ table: "c", set: { n: { op: "increment", value: 1 } } }, UID)
      .sql,
    `UPDATE "c" SET "n" = "n" + ? WHERE "user_id" = ?`,
  );
  assertEquals(
    buildUpdate({ table: "c", set: { hi: { op: "max", value: 9 } } }, UID).sql,
    `UPDATE "c" SET "hi" = MAX("hi", ?) WHERE "user_id" = ?`,
  );
});

Deno.test("delete is always scoped to the caller", () => {
  const { sql, params } = buildDelete(
    { table: "items", where: { id: "x" } },
    UID,
  );
  assertEquals(sql, `DELETE FROM "items" WHERE "id" = ? AND "user_id" = ?`);
  assertEquals(params, ["x", UID]);

  // Even with no filter, delete cannot exceed the caller's own rows.
  assertEquals(
    buildDelete({ table: "items" }, UID).sql,
    `DELETE FROM "items" WHERE "user_id" = ?`,
  );
});

// ── UPSERT ──

Deno.test("upsert forces user_id into the conflict target and update set", () => {
  const { sql, params } = buildUpsert(
    {
      table: "imap_sync_state",
      values: { last_uid: 42 },
      onConflict: ["user_id"],
      set: { last_uid: { op: "max", value: 42 } },
    },
    UID,
  );
  assertEquals(
    sql,
    `INSERT INTO "imap_sync_state" ("last_uid", "user_id") VALUES (?, ?) ` +
      `ON CONFLICT ("user_id") DO UPDATE SET "last_uid" = MAX("last_uid", ?)`,
  );
  assertEquals(params, [42, UID, 42]);
});

Deno.test("upsert default set uses excluded.* for non-conflict columns", () => {
  const { sql } = buildUpsert(
    { table: "profiles", values: { key: "k", name: "N" }, onConflict: ["key"] },
    UID,
  );
  assertEquals(
    sql,
    `INSERT INTO "profiles" ("key", "name", "user_id") VALUES (?, ?, ?) ` +
      `ON CONFLICT ("key", "user_id") DO UPDATE SET "name" = excluded."name"`,
  );
});

// ── Injection / validation battery ──

Deno.test("rejects raw SQL / malicious identifiers", () => {
  const bad = [
    () => buildSelect({ table: "SELECT * FROM secrets" }, UID),
    () => buildSelect({ table: "items; DROP TABLE items" }, UID),
    () => buildSelect({ table: "items", columns: ["name); DROP"] }, UID),
    () => buildSelect({ table: 'items" --' }, UID),
    () => buildInsert({ table: "items", values: { "a\"b": 1 } }, UID),
    () => buildUpdate({ table: "items", set: { "x=1;--": 1 } }, UID),
  ];
  for (const fn of bad) assertThrows(fn, ScopedQueryError);
});

Deno.test("rejects system tables and non-primitive values", () => {
  assertThrows(() => buildSelect({ table: "_migrations" }, UID), ScopedQueryError);
  assertThrows(() => buildSelect({ table: "_usage" }, UID), ScopedQueryError);
  assertThrows(
    () =>
      buildInsert(
        { table: "items", values: { blob: { nested: true } as unknown as string } },
        UID,
      ),
    ScopedQueryError,
  );
});

Deno.test("rejects user_id inside a where filter", () => {
  assertThrows(
    () => buildSelect({ table: "items", where: { user_id: "victim" } }, UID),
    ScopedQueryError,
    "user_id",
  );
});

// ── Property invariant: no value leaks into SQL, user_id scoped per table ──

Deno.test("invariant: values are always parameters, never inline; every table is user-scoped", () => {
  const secret = "p4ssw0rd!'; DROP--";
  const cases = [
    buildInsert({ table: "items", values: { note: secret } }, UID),
    buildSelect({ table: "items", where: { note: secret } }, UID),
    buildSelect({
      table: "a",
      joins: [{ table: "b", on: { column: "id", foreignColumn: "a_id" } }],
      where: { note: secret },
    }, UID),
    buildUpdate({ table: "items", set: { note: secret }, where: { id: secret } }, UID),
    buildDelete({ table: "items", where: { note: secret } }, UID),
    buildUpsert({ table: "items", values: { k: "x", note: secret }, onConflict: ["k"] }, UID),
    buildCount({ table: "items", where: { note: secret } }, UID),
  ];
  for (const { sql, params } of cases) {
    // No provided value appears literally in the SQL text.
    if (sql.includes(secret)) throw new Error(`value leaked into SQL: ${sql}`);
    if (sql.includes(UID)) throw new Error(`userId leaked into SQL: ${sql}`);
    // Placeholder count matches params length.
    const placeholders = (sql.match(/\?/g) || []).length;
    assertEquals(placeholders, params.length, sql);
    // The caller's scope is enforced (user_id predicate present).
    assertStringIncludes(sql, `"user_id"`);
    // And the caller's id is the value used for scoping.
    if (!params.includes(UID)) throw new Error(`scope param missing: ${sql}`);
  }
});
