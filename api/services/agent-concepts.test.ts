import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  aboutConcept,
  describeConcept,
  ensureConcept,
  reindexSurface,
  suggestConcepts,
} from "./agent-concepts.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

interface Recorded {
  method: string;
  url: URL;
  body: unknown;
}

async function withMockedDb<T>(
  handler: (call: Recorded) => Response,
  fn: () => Promise<T>,
): Promise<{ result: T; calls: Recorded[] }> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const calls: Recorded[] = [];
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const call: Recorded = {
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

function conceptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "concept-1",
    slug: "refund-window",
    title: null,
    description: null,
    status: "provisional",
    created_by: "mention",
    aliases: [],
    embedding_status: "none",
    embedding_provider: null,
    embedding_model: null,
    created_at: "2026-08-02T10:00:00.000Z",
    updated_at: "2026-08-02T10:00:00.000Z",
    ...overrides,
  };
}

Deno.test("ensureConcept: duplicate insert resolves to the existing row", async () => {
  const { result } = await withMockedDb(
    (call) =>
      call.method === "POST"
        ? new Response(JSON.stringify({ code: "23505" }), { status: 409 })
        : new Response(JSON.stringify([conceptRow()]), { status: 200 }),
    () => ensureConcept("user-1", "app-1", "refund-window"),
  );
  assertEquals(result.id, "concept-1");
});

Deno.test("reindexSurface: delete-then-insert with identity provenance", async () => {
  const { calls } = await withMockedDb(
    (call) => {
      if (call.method === "DELETE") return new Response(null, { status: 204 });
      if (
        call.method === "POST" &&
        call.url.pathname.endsWith("agent_concepts")
      ) {
        return new Response(JSON.stringify([conceptRow()]), { status: 201 });
      }
      return new Response("[]", { status: 201 });
    },
    () =>
      reindexSurface("user-1", "app-1", "schema_field", "issue_refund", [{
        slug: "refund-window",
        blockId: "refund_window",
        blockText: "The window in which refunds are honored.",
        identity: true,
        releaseId: "rel-1",
        fieldPath: "args.refund_window",
      }]),
  );
  const del = calls.find((c) => c.method === "DELETE");
  assert(del, "reindex must clear the surface first");
  assertEquals(del.url.searchParams.get("surface_type"), "eq.schema_field");
  const insert = calls.find((c) =>
    c.method === "POST" && c.url.pathname.endsWith("agent_concept_mentions")
  );
  const rows = insert?.body as Array<Record<string, unknown>>;
  assertEquals(rows[0].identity, true);
  assertEquals(rows[0].release_id, "rel-1");
  assertEquals(rows[0].field_path, "args.refund_window");
});

Deno.test("describeConcept: unresolvable BYOK route degrades to pending, never fails", async () => {
  const { result, calls } = await withMockedDb(
    (call) => {
      if (
        call.method === "GET" &&
        call.url.pathname.endsWith("agent_concepts") &&
        call.url.searchParams.get("slug") === "eq.refund-window"
      ) {
        return new Response(JSON.stringify([conceptRow()]), { status: 200 });
      }
      if (call.method === "PATCH") {
        const body = call.body as Record<string, unknown>;
        assertEquals(body.embedding_status, "pending");
        assertEquals(body.status, "active");
        return new Response(
          JSON.stringify([conceptRow({
            description: body.description,
            status: "active",
            embedding_status: "pending",
          })]),
          { status: 200 },
        );
      }
      if (call.method === "DELETE") return new Response(null, { status: 204 });
      // Everything else (BYOK route resolution probes, mention inserts).
      return new Response("[]", { status: 200 });
    },
    () =>
      describeConcept("user-1", "app-1", "refund-window", {
        description: "Money-back window. Differs from [[cancellation-policy]].",
        author: "owner",
        userEmail: "owner@example.com",
      }),
  );
  assertEquals(result.embeddingStatus, "pending");
  assertEquals(result.status, "active");
  // The concept page is itself a parsed surface: the edit reindexed it.
  const pageClear = calls.find((c) =>
    c.method === "DELETE" &&
    c.url.searchParams.get("surface_type") === "eq.concept_page"
  );
  assert(pageClear, "description edit must reindex the concept_page surface");
});

Deno.test("suggestConcepts: verbatim and alias matches rank before semantic", async () => {
  const { result } = await withMockedDb(
    (call) => {
      if (
        call.method === "GET" && call.url.pathname.endsWith("agent_concepts")
      ) {
        return new Response(
          JSON.stringify([
            conceptRow({
              id: "c1",
              slug: "refund-window",
              title: "Refund window",
              status: "active",
            }),
            conceptRow({
              id: "c2",
              slug: "billing-dispute",
              aliases: ["money-back"],
              status: "active",
            }),
            conceptRow({ id: "c3", slug: "parking", status: "active" }),
          ]),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    },
    () =>
      suggestConcepts(
        "user-1",
        "app-1",
        "The guest wants their money back within the refund window.",
      ),
  );
  assertEquals(result.map((s) => s.slug).sort(), [
    "billing-dispute",
    "refund-window",
  ]);
  assertEquals(
    result.find((s) => s.slug === "refund-window")?.basis,
    "verbatim",
  );
  assertEquals(
    result.find((s) => s.slug === "billing-dispute")?.basis,
    "alias",
  );
});

Deno.test("aboutConcept: groups mentions by surface, identity first", async () => {
  const { result } = await withMockedDb(
    (call) => {
      if (
        call.method === "GET" && call.url.pathname.endsWith("agent_concepts")
      ) {
        return new Response(JSON.stringify([conceptRow()]), { status: 200 });
      }
      if (call.url.pathname.endsWith("agent_concept_mentions")) {
        return new Response(
          JSON.stringify([
            {
              concept_id: "concept-1",
              surface_type: "schema_field",
              surface_id: "issue_refund",
              block_id: "refund_window",
              block_text: "The refund window field.",
              identity: true,
              release_id: "rel-1",
              field_path: "args.refund_window",
              created_at: "2026-08-02T10:00:00.000Z",
            },
            {
              concept_id: "concept-1",
              surface_type: "fact",
              surface_id: "check-out",
              block_id: "b0",
              block_text: "Late [[refund-window]] note.",
              identity: false,
              release_id: null,
              field_path: null,
              created_at: "2026-08-02T09:00:00.000Z",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    },
    () => aboutConcept("user-1", "app-1", "refund-window"),
  );
  assert(result);
  assertEquals(result.mentionGroups.length, 2);
  assertEquals(result.mentionGroups[0].surfaceType, "schema_field");
  assertEquals(result.mentionGroups[0].mentions[0].identity, true);
  assertEquals(
    result.mentionGroups[0].mentions[0].fieldPath,
    "args.refund_window",
  );
});
