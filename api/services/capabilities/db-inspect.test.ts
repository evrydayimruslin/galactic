// Tests for db-inspect — asserting the safety invariants: owner-only access, and
// that "rows" reads are user_id-scoped (owner-own-rows), never cross-user.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { inspectAppDatabase } from "./db-inspect.ts";
import { CapabilityError } from "../../../shared/contracts/capabilities.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const DBID = "db-abc";

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

const ENV = {
  SUPABASE_URL: "https://db.example",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
  CF_ACCOUNT_ID: "acct",
  CF_API_TOKEN: "cf",
};

function d1(results: unknown[]) {
  return new Response(
    JSON.stringify({ success: true, errors: [], result: [{ success: true, results, meta: {} }] }),
    { status: 200 },
  );
}

// Build a fetch stub. `app` is the row findById returns (null → not found);
// `dbId` is what getD1DatabaseId resolves. D1 queries are routed by SQL; every
// D1 SQL string is captured into `sql`.
function makeStub(opts: { app: Record<string, unknown> | null; dbId: string | null; sql: string[] }): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/rest/v1/apps")) {
      if (url.includes("select=d1_database_id")) {
        return Promise.resolve(
          new Response(JSON.stringify(opts.dbId ? [{ d1_database_id: opts.dbId, d1_status: "ready" }] : []), { status: 200 }),
        );
      }
      // findById / findBySlug
      return Promise.resolve(new Response(JSON.stringify(opts.app ? [opts.app] : []), { status: 200 }));
    }
    if (url.includes("/d1/database/") && url.endsWith("/query")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params?: unknown[] };
      opts.sql.push(body.sql);
      if (body.sql.includes("sqlite_master")) {
        return Promise.resolve(d1([{ name: "notes" }, { name: "_usage" }]));
      }
      if (body.sql.includes("PRAGMA table_info")) {
        return Promise.resolve(d1([
          { name: "id", type: "TEXT", notnull: 1, pk: 1 },
          { name: "user_id", type: "TEXT", notnull: 1, pk: 0 },
          { name: "body", type: "TEXT", notnull: 0, pk: 0 },
        ]));
      }
      if (body.sql.includes("COUNT(*)")) return Promise.resolve(d1([{ count: 42 }]));
      // the buildSelect owner-rows query — capture params too via the last entry
      (opts as { lastParams?: unknown[] }).lastParams = body.params;
      return Promise.resolve(d1([{ id: "1", user_id: OWNER, body: "hi" }]));
    }
    throw new Error("unexpected fetch: " + url);
  };
}

async function withStub(
  opts: { app: Record<string, unknown> | null; dbId: string | null; sql: string[] },
  run: () => Promise<void>,
) {
  const oe = g.__env, of = g.fetch;
  g.__env = ENV;
  g.fetch = makeStub(opts);
  try {
    await run();
  } finally {
    g.__env = oe;
    g.fetch = of;
  }
}

const ownedApp = { id: "app-1", owner_id: OWNER, slug: "my-app", visibility: "private" };

Deno.test("db-inspect: app_id is required", async () => {
  await withStub({ app: ownedApp, dbId: DBID, sql: [] }, async () => {
    await assertRejects(() => inspectAppDatabase(OWNER, {}) as Promise<unknown>, CapabilityError, "app_id is required");
  });
});

Deno.test("db-inspect: non-owner is forbidden", async () => {
  const otherApp = { ...ownedApp, owner_id: "someone-else" };
  await withStub({ app: otherApp, dbId: DBID, sql: [] }, async () => {
    await assertRejects(() => inspectAppDatabase(OWNER, { app_id: "app-1" }) as Promise<unknown>, CapabilityError, "do not own");
  });
});

Deno.test("db-inspect: unprovisioned db returns provisioned:false", async () => {
  await withStub({ app: ownedApp, dbId: null, sql: [] }, async () => {
    const r = await inspectAppDatabase(OWNER, { app_id: "app-1" }) as { provisioned: boolean };
    assertEquals(r.provisioned, false);
  });
});

Deno.test("db-inspect: schema lists user tables + columns, drops system tables", async () => {
  await withStub({ app: ownedApp, dbId: DBID, sql: [] }, async () => {
    const r = await inspectAppDatabase(OWNER, { app_id: "app-1", action: "schema" }) as {
      tables: { name: string; columns: { name: string }[] }[];
    };
    assertEquals(r.tables.map((t) => t.name), ["notes"]); // _usage filtered out
    assertEquals(r.tables[0].columns.map((c) => c.name), ["id", "user_id", "body"]);
  });
});

Deno.test("db-inspect: counts returns per-table row counts", async () => {
  await withStub({ app: ownedApp, dbId: DBID, sql: [] }, async () => {
    const r = await inspectAppDatabase(OWNER, { app_id: "app-1", action: "counts" }) as {
      counts: { table: string; rows: number }[];
    };
    assertEquals(r.counts, [{ table: "notes", rows: 42 }]);
  });
});

Deno.test("db-inspect: rows is user_id-scoped (owner-own-rows, never cross-user)", async () => {
  const opts = { app: ownedApp, dbId: DBID, sql: [] as string[] };
  await withStub(opts, async () => {
    const r = await inspectAppDatabase(OWNER, { app_id: "app-1", action: "rows", table: "notes" }) as {
      scope: string;
      rows: unknown[];
    };
    assertEquals(r.scope, "own_rows");
    assertEquals(r.rows.length, 1);
    // The generated SELECT MUST scope on user_id, with the caller's id in params.
    const selectSql = opts.sql.find((s) => s.includes("notes") && !s.includes("sqlite_master"))!;
    assertStringIncludes(selectSql, "user_id");
    assert(((opts as { lastParams?: unknown[] }).lastParams ?? []).includes(OWNER), "caller userId must be a bound param");
  });
});

Deno.test("db-inspect: rows on an unknown table is not_found", async () => {
  await withStub({ app: ownedApp, dbId: DBID, sql: [] }, async () => {
    await assertRejects(
      () => inspectAppDatabase(OWNER, { app_id: "app-1", action: "rows", table: "nope" }) as Promise<unknown>,
      CapabilityError,
      "Table not found",
    );
  });
});

Deno.test("db-inspect: invalid action is rejected", async () => {
  await withStub({ app: ownedApp, dbId: DBID, sql: [] }, async () => {
    await assertRejects(
      () => inspectAppDatabase(OWNER, { app_id: "app-1", action: "drop" }) as Promise<unknown>,
      CapabilityError,
      "Invalid action",
    );
  });
});
