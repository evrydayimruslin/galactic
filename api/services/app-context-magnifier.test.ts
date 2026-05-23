import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  isSelectOnlyContextQuery,
  magnifyContextSources,
  prepareDeclaredContextQuery,
} from "./app-context-magnifier.ts";

function d1Response(results: Record<string, unknown>[]) {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    result: [{
      success: true,
      results,
      meta: {
        changes: 0,
        last_row_id: 0,
        duration: 1,
        rows_read: results.length,
        rows_written: 0,
      },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

Deno.test("app context magnifier: validates SELECT-only declared queries", async () => {
  assertEquals(isSelectOnlyContextQuery("SELECT * FROM threads"), true);
  assertEquals(isSelectOnlyContextQuery("WITH recent AS (SELECT * FROM threads) SELECT * FROM recent"), true);
  assertEquals(isSelectOnlyContextQuery("SELECT * FROM threads; DROP TABLE threads"), false);
  assertEquals(isSelectOnlyContextQuery("UPDATE threads SET subject = 'x'"), false);

  assertThrows(
    () =>
      prepareDeclaredContextQuery({
        id: "unsafe",
        query: "SELECT * FROM threads WHERE user_id = ?",
      }, { userId: "user-1", query: "acme", limit: 5 }),
    Error,
    "named placeholders",
  );
  assertThrows(
    () =>
      prepareDeclaredContextQuery({
        id: "missing-user",
        query: "SELECT * FROM threads",
      }, { userId: "user-1", query: "acme", limit: 5 }),
    Error,
    ":user_id",
  );
});

Deno.test("app context magnifier: searches declared D1 tables with user isolation and redaction", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fetchFn = ((_: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as {
      sql: string;
      params?: unknown[];
    };
    calls.push({ sql: body.sql, params: body.params || [] });

    if (body.sql.startsWith("PRAGMA table_info")) {
      return Promise.resolve(d1Response([
        { name: "id" },
        { name: "user_id" },
        { name: "subject" },
        { name: "email" },
        { name: "body" },
        { name: "updated_at" },
      ]));
    }

    if (body.sql.includes("LIKE")) {
      return Promise.resolve(d1Response([{
        id: "thread-1",
        user_id: "user-1",
        subject: "ACME follow-up",
        email: "sarah@example.com",
        body: "Need approval before sending.",
      }]));
    }

    return Promise.resolve(d1Response([]));
  }) as typeof fetch;

  const result = await magnifyContextSources([{
    id: "threads",
    appId: "app-email",
    appSlug: "email",
    appName: "Email",
    label: "Email threads",
    type: "d1_table",
    access: "read",
    searchable: true,
    tables: ["threads"],
    redactions: [{ field: "email" }],
  }], {
    userId: "user-1",
    query: "ACME approval",
    fetchFn,
    databaseIdByApp: () => Promise.resolve("db-email"),
  });

  assertEquals(result.sourceCount, 1);
  assertEquals(result.rowCount, 1);
  assert(result.context.includes("ACME follow-up"));
  assert(result.context.includes("[redacted]"));
  assertEquals(result.context.includes("sarah@example.com"), false);
  assertEquals(result.context.includes("user-1"), false);
  assertEquals(calls.some((call) => call.params[0] === "user-1"), true);
});

Deno.test("app context magnifier: executes declared D1 query placeholders", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fetchFn = ((_: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as {
      sql: string;
      params?: unknown[];
    };
    calls.push({ sql: body.sql, params: body.params || [] });
    return Promise.resolve(d1Response([{ id: "thread-2", subject: "Budget" }]));
  }) as typeof fetch;

  const result = await magnifyContextSources([{
    id: "thread_search",
    appId: "app-email",
    appSlug: "email",
    appName: "Email",
    label: "Thread search",
    type: "d1_query",
    access: "read",
    query:
      "SELECT id, subject FROM threads WHERE user_id = :user_id AND subject LIKE :query LIMIT :limit",
  }], {
    userId: "user-1",
    query: "budget",
    fetchFn,
    databaseIdByApp: () => Promise.resolve("db-email"),
  });

  assertEquals(result.sourceCount, 1);
  assertEquals(calls[0].sql.includes(":user_id"), false);
  assertEquals(calls[0].params, ["user-1", "%budget%", 12, 12]);
  assert(result.context.includes("Budget"));
});
