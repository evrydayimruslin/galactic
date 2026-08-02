import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  answerAgentKnowledgeQuestion,
  askAgentKnowledgeQuestion,
  dismissAgentKnowledgeQuestion,
  formatKnowledgeFactsBlock,
  knowledgeQuestionHash,
  slugifyFactTitle,
  upsertAgentKnowledgeFact,
} from "./agent-knowledge.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

interface Recorded {
  method: string;
  url: URL;
  body: Record<string, unknown> | null;
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

function questionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "question-1",
    question: "What is the refund window?",
    context: null,
    status: "open",
    ask_count: 1,
    blocking: false,
    first_asked_at: "2026-08-01T10:00:00.000Z",
    last_asked_at: "2026-08-01T10:00:00.000Z",
    answered_fact_id: null,
    ...overrides,
  };
}

function factRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "fact-1",
    slug: "refund-window",
    title: "Refund window",
    content: "14 days on flexible rates; non-refundable rates never refund.",
    source: "owner",
    status: "active",
    revision: 1,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

Deno.test("knowledgeQuestionHash normalizes whitespace and case", async () => {
  const a = await knowledgeQuestionHash("  What is the  Refund Window? ");
  const b = await knowledgeQuestionHash("what is the refund window?");
  assertEquals(a, b);
  assert(/^[0-9a-f]{64}$/.test(a));
});

Deno.test("ask: first ask inserts; blocking mints ONE deduped alert", async () => {
  const { result, calls } = await withMockedDb(
    (call) => {
      if (call.method === "POST" && call.url.pathname.includes("/rpc/")) {
        return new Response("[]", { status: 200 });
      }
      if (call.method === "POST") {
        return new Response(
          JSON.stringify([questionRow({ blocking: true })]),
          { status: 201 },
        );
      }
      return new Response("[]", { status: 200 });
    },
    () =>
      askAgentKnowledgeQuestion("user-1", "app-1", {
        question: "What is the refund window?",
        blocking: true,
      }),
  );
  assertEquals(result.deduped, false);
  assertEquals(result.question.blocking, true);
  const notifyCall = calls.find((call) =>
    call.url.pathname.includes("create_user_notification_episode")
  );
  assert(notifyCall, "blocking ask must mint the alert pointer");
  assertEquals(
    notifyCall.body?.p_dedupe_key,
    "knowledge_question:app-1:question-1",
  );
});

Deno.test("ask: duplicate increments ask_count, escalates blocking, never duplicates", async () => {
  const { result, calls } = await withMockedDb(
    (call) => {
      if (call.method === "POST" && call.url.pathname.includes("/rpc/")) {
        return new Response("[]", { status: 200 });
      }
      if (
        call.method === "POST" &&
        call.url.pathname.endsWith("agent_knowledge_questions")
      ) {
        return new Response(
          JSON.stringify({ code: "23505" }),
          { status: 409 },
        );
      }
      if (call.method === "PATCH") {
        assertEquals(call.body?.ask_count, 2);
        // Escalate-only: blocking:true survives a non-blocking repeat.
        assertEquals(call.body?.blocking, true);
        return new Response(
          JSON.stringify([
            questionRow({ ask_count: 2, blocking: true }),
          ]),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify([questionRow({ blocking: true })]),
        { status: 200 },
      );
    },
    () =>
      askAgentKnowledgeQuestion("user-1", "app-1", {
        question: "What is the refund window?",
        blocking: false,
      }),
  );
  assertEquals(result.deduped, true);
  assertEquals(result.question.askCount, 2);
  assert(calls.some((call) => call.method === "PATCH"));
});

Deno.test("answer: creates the fact, closes the question, resolves the alert", async () => {
  const { result, calls } = await withMockedDb(
    (call) => {
      if (call.url.pathname.includes("resolve_notification_incident")) {
        assertEquals(
          call.body?.p_dedupe_key,
          "knowledge_question:app-1:question-1",
        );
        return new Response("1", { status: 200 });
      }
      if (
        call.method === "GET" &&
        call.url.pathname.endsWith("agent_knowledge_questions")
      ) {
        return new Response(JSON.stringify([questionRow()]), { status: 200 });
      }
      if (
        call.method === "GET" &&
        call.url.pathname.endsWith("agent_knowledge_facts")
      ) {
        return new Response("[]", { status: 200 });
      }
      if (
        call.method === "POST" &&
        call.url.pathname.endsWith("agent_knowledge_facts")
      ) {
        return new Response(JSON.stringify([factRow()]), { status: 201 });
      }
      if (
        call.method === "PATCH" &&
        call.url.pathname.endsWith("agent_knowledge_questions")
      ) {
        assertEquals(call.body?.status, "answered");
        assertEquals(call.body?.answered_fact_id, "fact-1");
        return new Response(
          JSON.stringify([
            questionRow({ status: "answered", answered_fact_id: "fact-1" }),
          ]),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    },
    () =>
      answerAgentKnowledgeQuestion("user-1", "app-1", "question-1", {
        content: "14 days on flexible rates; non-refundable rates never refund.",
      }),
  );
  assertEquals(result.question.status, "answered");
  assertEquals(result.fact.slug, "refund-window");
  assert(
    calls.some((call) =>
      call.url.pathname.includes("resolve_notification_incident")
    ),
    "answering must resolve the alert pointer",
  );
});

Deno.test("dismiss: only open questions; resolves the alert pointer", async () => {
  const { result } = await withMockedDb(
    (call) => {
      if (call.url.pathname.includes("resolve_notification_incident")) {
        return new Response("1", { status: 200 });
      }
      if (call.method === "PATCH") {
        assert(call.url.searchParams.get("status") === "eq.open");
        return new Response(
          JSON.stringify([questionRow({ status: "dismissed" })]),
          { status: 200 },
        );
      }
      return new Response("[]", { status: 200 });
    },
    () => dismissAgentKnowledgeQuestion("user-1", "app-1", "question-1"),
  );
  assertEquals(result.status, "dismissed");
});

Deno.test("upsert: existing slug updates content and bumps revision", async () => {
  const { result } = await withMockedDb(
    (call) => {
      if (call.method === "GET") {
        return new Response(
          JSON.stringify([{ id: "fact-1", revision: 3 }]),
          { status: 200 },
        );
      }
      if (call.method === "PATCH") {
        assertEquals(call.body?.revision, 4);
        return new Response(
          JSON.stringify([factRow({ revision: 4, content: "Updated." })]),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected ${call.method}`);
    },
    () =>
      upsertAgentKnowledgeFact("user-1", "app-1", {
        slug: "refund-window",
        content: "Updated.",
      }),
  );
  assertEquals(result.revision, 4);
});

Deno.test("validation failures are loud and typed", async () => {
  await assertRejects(
    () =>
      upsertAgentKnowledgeFact("user-1", "app-1", {
        slug: "Bad Slug!",
        content: "x",
      }),
    Error,
    "slug",
  );
  await assertRejects(
    () => askAgentKnowledgeQuestion("user-1", "app-1", { question: "" }),
    Error,
    "1-500",
  );
});

Deno.test("facts block injects stable ids and skips retired facts", () => {
  const block = formatKnowledgeFactsBlock([
    {
      id: "1",
      slug: "check-out",
      title: "Check-out",
      content: "By 11:00. Late check-out to 13:00 is EUR 40.",
      source: "owner",
      status: "active",
      revision: 2,
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "2",
      slug: "old-rate",
      title: null,
      content: "Retired.",
      source: "owner",
      status: "retired",
      revision: 1,
      createdAt: "",
      updatedAt: "",
    },
  ]);
  assert(block.startsWith("## Working knowledge"));
  assert(block.includes("[fact:check-out] Check-out: By 11:00."));
  assert(!block.includes("old-rate"));
  assertEquals(slugifyFactTitle("Do we allow dogs??"), "do-we-allow-dogs");
});
