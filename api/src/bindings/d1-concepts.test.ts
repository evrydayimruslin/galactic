import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  applyD1ConceptIndexing,
  extractRowIds,
  parseConceptsIndex,
  planD1ConceptIndexing,
} from "./d1-concepts.ts";

const INDEX = parseConceptsIndex(["conversations.notes", "conversations.summary", "bookings.memo"]);

Deno.test("parseConceptsIndex: drops malformed entries, never throws", () => {
  const index = parseConceptsIndex([
    "conversations.notes",
    "bad entry",
    "no-dot",
    "a.b.c",
    "",
    42 as unknown as string,
  ]);
  assertEquals([...index.keys()], ["conversations"]);
  assertEquals([...index.get("conversations")!], ["notes"]);
  assertEquals(parseConceptsIndex(undefined).size, 0);
});

Deno.test("plan: non-indexed tables and non-declared columns are zero-cost", () => {
  assertEquals(
    planD1ConceptIndexing({
      index: INDEX,
      kind: "update",
      table: "guests",
      written: [{ notes: "[[x]]" }],
    }),
    { needRowIds: false, columns: [] },
  );
  assertEquals(
    planD1ConceptIndexing({
      index: INDEX,
      kind: "update",
      table: "conversations",
      written: [{ status: "closed" }],
    }),
    { needRowIds: false, columns: [] },
  );
});

Deno.test("plan: insert needs ids ONLY when a new value carries brackets", () => {
  assertEquals(
    planD1ConceptIndexing({
      index: INDEX,
      kind: "insert",
      table: "conversations",
      written: [{ notes: "plain note" }],
    }).needRowIds,
    false,
  );
  const plan = planD1ConceptIndexing({
    index: INDEX,
    kind: "insert",
    table: "conversations",
    written: [{ notes: "applied [[refund-window]]" }],
  });
  assertEquals(plan.needRowIds, true);
  assertEquals(plan.columns, ["notes"]);
});

Deno.test("plan: update needs ids whenever a declared column is WRITTEN — clearing stale mentions is the contract", () => {
  const plan = planD1ConceptIndexing({
    index: INDEX,
    kind: "update",
    table: "conversations",
    written: [{ notes: "brackets removed after re-triage" }],
  });
  assertEquals(plan.needRowIds, true);
  assertEquals(plan.columns, ["notes"]);
});

Deno.test("plan: delete needs ids whenever the table is indexed", () => {
  const plan = planD1ConceptIndexing({
    index: INDEX,
    kind: "delete",
    table: "conversations",
    written: [],
  });
  assertEquals(plan.needRowIds, true);
  assertEquals(plan.columns.sort(), ["notes", "summary"]);
});

Deno.test("extractRowIds: safe integers only", () => {
  assertEquals(
    extractRowIds([{ rowid: 4 }, { rowid: "x" }, { rowid: 7.5 }, { rowid: 9 }]),
    [4, 9],
  );
  assertEquals(extractRowIds(undefined), []);
});

interface Recorded {
  method: string;
  url: URL;
  body: unknown;
}

async function withMockedDb(
  fn: () => Promise<void>,
): Promise<Recorded[]> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.__env = {
    ...(previousEnv || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  } as typeof globalThis.__env;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (
      init?.method === "POST" && url.pathname.endsWith("agent_concepts")
    ) {
      return new Response(
        JSON.stringify([{ id: "concept-1", slug: "refund-window" }]),
        { status: 201 },
      );
    }
    return new Response("[]", { status: 201 });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
  return calls;
}

Deno.test("apply: update with brackets reindexes per (table, column, rowid)", async () => {
  const calls = await withMockedDb(() =>
    applyD1ConceptIndexing({
      userId: "user-1",
      appId: "app-1",
      table: "conversations",
      kind: "update",
      columns: ["notes"],
      written: [{ notes: "applied [[refund-window]] here" }],
      rowIds: [412, 511],
    })
  );
  const clears = calls.filter((c) => c.method === "DELETE");
  assertEquals(clears.length, 2);
  assertEquals(
    clears.map((c) => c.url.searchParams.get("surface_id")).sort(),
    ["eq.conversations.notes:412", "eq.conversations.notes:511"],
  );
  const inserts = calls.filter((c) =>
    c.method === "POST" && c.url.pathname.endsWith("agent_concept_mentions")
  );
  assertEquals(inserts.length, 2);
  const rows = inserts[0].body as Array<Record<string, unknown>>;
  assertEquals(rows[0].surface_type, "d1");
  assert(String(rows[0].block_text).includes("[[refund-window]]"));
});

Deno.test("apply: brackets edited away → mentions cleared, nothing inserted", async () => {
  const calls = await withMockedDb(() =>
    applyD1ConceptIndexing({
      userId: "user-1",
      appId: "app-1",
      table: "conversations",
      kind: "update",
      columns: ["notes"],
      written: [{ notes: "re-triaged as billing dispute, plain text" }],
      rowIds: [412],
    })
  );
  assertEquals(calls.filter((c) => c.method === "DELETE").length, 1);
  assertEquals(
    calls.filter((c) =>
      c.method === "POST" && c.url.pathname.endsWith("agent_concept_mentions")
    ).length,
    0,
  );
});

Deno.test("apply: delete clears every declared column for each row", async () => {
  const calls = await withMockedDb(() =>
    applyD1ConceptIndexing({
      userId: "user-1",
      appId: "app-1",
      table: "conversations",
      kind: "delete",
      columns: ["notes", "summary"],
      written: [],
      rowIds: [412],
    })
  );
  assertEquals(
    calls.filter((c) => c.method === "DELETE").map((c) =>
      c.url.searchParams.get("surface_id")
    ).sort(),
    ["eq.conversations.notes:412", "eq.conversations.summary:412"],
  );
});

Deno.test("apply: multi-row insert is row-aligned with RETURNING order", async () => {
  const calls = await withMockedDb(() =>
    applyD1ConceptIndexing({
      userId: "user-1",
      appId: "app-1",
      table: "conversations",
      kind: "insert",
      columns: ["notes"],
      written: [{ notes: "[[refund-window]] case" }, { notes: "plain" }],
      rowIds: [1, 2],
    })
  );
  const inserts = calls.filter((c) =>
    c.method === "POST" && c.url.pathname.endsWith("agent_concept_mentions")
  );
  assertEquals(inserts.length, 1);
  const rows = inserts[0].body as Array<Record<string, unknown>>;
  assertEquals(rows[0].surface_id, "conversations.notes:1");
});
