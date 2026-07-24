// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import type {
  LaunchAgentPane,
  LaunchAgentSearchRequest,
  LaunchAgentSearchSubjectKind,
} from "../../shared/contracts/launch.ts";
import type {
  ResolvedInferenceRoute,
  ResolveInferenceRouteParams,
} from "./inference-route.ts";
import {
  type AgentSearchDependencies,
  AgentSearchServiceError,
  embedOwnerAgentSearchDocument,
  searchOwnerAgentNavigation,
} from "./agent-search.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-07-23T18:00:00.000Z");

interface RecordedCall {
  url: URL;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

interface DatabaseHarnessOptions {
  lexical?: unknown;
  hybrid?: unknown;
  apps?: unknown;
  owner?: unknown;
  lexicalStatus?: number;
  hybridStatus?: number;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function databaseHarness(options: DatabaseHarnessOptions = {}): {
  calls: RecordedCall[];
  fetchFn: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : null;
    calls.push({ url, method, headers, body });

    if (url.pathname.endsWith("/rpc/search_agent_documents")) {
      return Promise.resolve(json(
        options.lexical ?? [],
        options.lexicalStatus ?? 200,
      ));
    }
    if (url.pathname.endsWith("/rpc/search_agent_documents_hybrid")) {
      return Promise.resolve(json(
        options.hybrid ?? [],
        options.hybridStatus ?? 200,
      ));
    }
    if (url.pathname.endsWith("/users")) {
      return Promise.resolve(json(
        options.owner ?? [{ id: USER_ID, email: "owner@example.com" }],
      ));
    }
    if (url.pathname.endsWith("/apps")) {
      return Promise.resolve(json(
        options.apps ?? [{
          id: AGENT_ID,
          slug: "email-ops",
          name: "email-ops",
        }],
      ));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  return { calls, fetchFn };
}

function deps(
  fetchFn: typeof fetch,
  overrides: Partial<AgentSearchDependencies> = {},
): AgentSearchDependencies {
  return {
    fetchFn,
    supabaseUrl: "https://database.example/",
    serviceRoleKey: "service-role-secret",
    clock: () => new Date(NOW),
    semanticEnabled: false,
    ...overrides,
  };
}

function documentId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function searchRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    document_id: documentId(1),
    agent_id: AGENT_ID,
    agent_slug: "email-ops",
    subject_type: "function",
    subject_id: "send_reply",
    title: "Send reply",
    breadcrumb: "email-ops / Functions",
    snippet: "Send an approved email reply.",
    route: "/agents/email-ops?pane=functions&item=send_reply",
    rank: 9.5,
    ...overrides,
  };
}

function hybridRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const row = searchRow(overrides);
  delete row.rank;
  return {
    lexical_rank: 1,
    similarity: 0.8,
    combined_rank: 3.4,
    ...row,
  };
}

function byokRoute(
  overrides: Partial<ResolvedInferenceRoute> = {},
): ResolvedInferenceRoute {
  return {
    billingMode: "byok",
    provider: "openai",
    upstreamProvider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "owner-byok-secret",
    model: "gpt-4o-mini",
    keySource: "user_byok",
    billingSource: "none",
    shouldRequireBalance: false,
    shouldDebitLight: false,
    ...overrides,
  };
}

async function assertInvalid(
  request: unknown,
  userId = USER_ID,
): Promise<void> {
  const error = await assertRejects(
    () =>
      searchOwnerAgentNavigation(
        userId,
        request as LaunchAgentSearchRequest,
        deps(
          (() => {
            throw new Error("validation must precede I/O");
          }) as typeof fetch,
        ),
      ),
    AgentSearchServiceError,
  );
  assertEquals(error.code, "INVALID_REQUEST");
  assertEquals(error.status, 400);
}

Deno.test("agent search strictly validates the shared request and rejects unsupported cursors", async () => {
  await assertInvalid({ query: "" });
  await assertInvalid({ query: "hello\nworld" });
  await assertInvalid({ query: "x".repeat(301) });
  await assertInvalid({ query: "mail", agentId: "not-a-uuid" });
  await assertInvalid({ query: "mail", kinds: [] });
  await assertInvalid({ query: "mail", kinds: ["agent", "agent"] });
  await assertInvalid({ query: "mail", kinds: ["secret"] });
  await assertInvalid({ query: "mail", limit: 0 });
  await assertInvalid({ query: "mail", limit: 1.5 });
  await assertInvalid({ query: "mail", limit: 101 });
  await assertInvalid({ query: "mail", limit: null });
  await assertInvalid({ query: "mail", cursor: "opaque-but-unsupported" });
  await assertInvalid({ query: "mail" }, "not-a-user-id");
  await assertInvalid(null);
});

Deno.test("agent search always performs owner-scoped lexical retrieval and returns only safe navigation fields", async () => {
  const database = databaseHarness({
    lexical: [searchRow({
      secret_value: "never-return-this",
      raw_run_args: { password: "never-return-this" },
      raw_run_result: "third-party content",
      arbitrary_metadata: { access_token: "never-return-this" },
      snippet: "  Send\tan\napproved reply.  ",
    })],
  });

  const response = await searchOwnerAgentNavigation(
    USER_ID,
    {
      query: "  Send reply  ",
      agentId: AGENT_ID,
      kinds: ["function"],
      limit: 7,
    },
    deps(database.fetchFn),
  );

  assertEquals(database.calls.map((call) => call.url.pathname), [
    "/rest/v1/rpc/search_agent_documents",
    "/rest/v1/apps",
  ]);
  assertEquals(database.calls[0].body, {
    p_user_id: USER_ID,
    p_query: "Send reply",
    p_limit: 7,
    p_agent_id: AGENT_ID,
    p_subject_types: ["function"],
  });
  assertEquals(database.calls[0].headers.get("apikey"), "service-role-secret");

  const appQuery = database.calls[1].url.searchParams;
  assertEquals(appQuery.get("owner_id"), `eq.${USER_ID}`);
  assertEquals(appQuery.get("visibility"), "eq.private");
  assertEquals(appQuery.get("deleted_at"), "is.null");
  assertEquals(appQuery.get("id"), `in.(${AGENT_ID})`);
  assertEquals(appQuery.get("select"), "id,slug,name");

  assertEquals(response, {
    query: "Send reply",
    results: [{
      id: documentId(1),
      kind: "function",
      agent: {
        id: AGENT_ID,
        slug: "email-ops",
        name: "email-ops",
      },
      title: "Send reply",
      summary: "Send an approved reply.",
      destination: {
        href: "/agents/email-ops?pane=functions&item=send_reply",
        agentId: AGENT_ID,
        pane: "functions",
        itemId: "send_reply",
      },
      score: 9.5,
    }],
    generatedAt: NOW.toISOString(),
  });
  const serialized = JSON.stringify(response);
  assert(!serialized.includes("never-return-this"));
  assert(!serialized.includes("third-party content"));
  assert(!("cursor" in response));
});

Deno.test("agent search invokes a stored Worker fetch without a receiver", async () => {
  const database = databaseHarness({ lexical: [] });
  let receiver: unknown = "not-called";
  const receiverSensitiveFetch = (function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    receiver = this;
    if (this !== undefined) {
      throw new TypeError("Illegal invocation");
    }
    return database.fetchFn(input, init);
  }) as typeof fetch;

  const response = await searchOwnerAgentNavigation(
    USER_ID,
    { query: "mail" },
    deps(receiverSensitiveFetch),
  );

  assertEquals(receiver, undefined);
  assertEquals(response.results, []);
  assertEquals(database.calls.length, 1);
});

Deno.test("agent search maps every supported subject to a stable internal destination", async () => {
  const cases: Array<{
    kind: LaunchAgentSearchSubjectKind;
    pane: LaunchAgentPane;
    itemRequired: boolean;
  }> = [
    { kind: "agent", pane: "overview", itemRequired: false },
    { kind: "directive", pane: "overview", itemRequired: false },
    { kind: "interface", pane: "interfaces", itemRequired: true },
    { kind: "routine", pane: "routines", itemRequired: true },
    { kind: "function", pane: "functions", itemRequired: true },
    { kind: "function_field", pane: "functions", itemRequired: true },
    { kind: "attention", pane: "alerts", itemRequired: true },
    { kind: "run", pane: "compute", itemRequired: true },
    { kind: "release", pane: "settings", itemRequired: true },
    { kind: "setting", pane: "access", itemRequired: true },
    { kind: "authority", pane: "access", itemRequired: true },
  ];
  const lexical = cases.map(({ kind, pane, itemRequired }, index) => {
    const subjectId = `${kind}-${index}`;
    const query = new URLSearchParams({ pane });
    if (itemRequired) {
      query.set(
        "item",
        kind === "release" ? `release:${subjectId}` : subjectId,
      );
    }
    return searchRow({
      document_id: documentId(index + 1),
      subject_type: kind,
      subject_id: subjectId,
      title: kind,
      route: `/agents/email-ops?${query}`,
      rank: cases.length - index,
    });
  });
  const database = databaseHarness({ lexical });

  const response = await searchOwnerAgentNavigation(
    USER_ID,
    { query: "agent", limit: cases.length },
    deps(database.fetchFn),
  );

  assertEquals(response.results.length, cases.length);
  for (const [index, expected] of cases.entries()) {
    const result = response.results[index];
    assertEquals(result.kind, expected.kind);
    assertEquals(result.destination.pane, expected.pane);
    assertEquals(
      result.destination.itemId,
      expected.itemRequired
        ? expected.kind === "release"
          ? `release:${expected.kind}-${index}`
          : `${expected.kind}-${index}`
        : undefined,
    );
    assert(result.destination.href.startsWith("/agents/email-ops?pane="));
    assert(!result.destination.href.includes("://"));
  }
});

Deno.test("agent search canonicalizes a persisted raw release route during re-projection", async () => {
  const database = databaseHarness({
    lexical: [searchRow({
      subject_type: "release",
      subject_id: "2.4.0",
      title: "Live release 2.4.0",
      route: "/agents/email-ops?pane=settings&item=2.4.0",
    })],
  });

  const response = await searchOwnerAgentNavigation(
    USER_ID,
    { query: "release", kinds: ["release"] },
    deps(database.fetchFn),
  );

  assertEquals(response.results[0]?.destination, {
    href: "/agents/email-ops?pane=settings&item=release%3A2.4.0",
    agentId: AGENT_ID,
    pane: "settings",
    itemId: "release:2.4.0",
  });
});

Deno.test("agent search drops a result absent from owner-private Agent hydration", async () => {
  const database = databaseHarness({
    lexical: [searchRow()],
    apps: [],
  });
  const response = await searchOwnerAgentNavigation(
    USER_ID,
    { query: "reply" },
    deps(database.fetchFn),
  );
  assertEquals(response.results, []);
});

Deno.test("agent search rejects external, cross-Agent, and kind-mismatched destinations", async () => {
  for (
    const route of [
      "https://attacker.example/agents/email-ops?pane=functions&item=send_reply",
      "/agents/other-agent?pane=functions&item=send_reply",
      "/agents/email-ops?pane=settings&item=send_reply",
      "/agents/email-ops?pane=functions&item=different",
      "/agents/email-ops?pane=functions&item=send_reply&redirect=https://evil.example",
    ]
  ) {
    const database = databaseHarness({
      lexical: [searchRow({ route })],
    });
    const error = await assertRejects(
      () =>
        searchOwnerAgentNavigation(
          USER_ID,
          { query: "reply" },
          deps(database.fetchFn),
        ),
      AgentSearchServiceError,
    );
    assertEquals(error.code, "SERVICE_UNAVAILABLE");
  }
});

Deno.test("agent search augments lexical ranking with an owner BYOK hybrid query while retaining exact matches", async () => {
  const lexicalExact = searchRow({
    document_id: documentId(1),
    title: "Send reply",
    rank: 13.5,
  });
  const semanticOnly = hybridRow({
    document_id: documentId(2),
    subject_id: "draft_response",
    title: "Draft response",
    route: "/agents/email-ops?pane=functions&item=draft_response",
    combined_rank: 2.9,
  });
  const hybridExact = hybridRow({
    document_id: documentId(1),
    title: "Send reply",
    combined_rank: 10,
  });
  const database = databaseHarness({
    lexical: [lexicalExact],
    hybrid: [semanticOnly, hybridExact],
  });
  const routeCalls: ResolveInferenceRouteParams[] = [];
  let embeddedQuery = "";

  const response = await searchOwnerAgentNavigation(
    USER_ID,
    { query: "reply email", kinds: ["function"], limit: 10 },
    deps(database.fetchFn, {
      semanticEnabled: true,
      resolveRoute: (params) => {
        routeCalls.push(params);
        return Promise.resolve(byokRoute());
      },
      embedQuery: (query, route) => {
        embeddedQuery = query;
        assertEquals(route.keySource, "user_byok");
        return Promise.resolve(Array(1536).fill(0.001));
      },
    }),
  );

  assertEquals(embeddedQuery, "reply email");
  assertEquals(routeCalls.length, 1);
  assertEquals(routeCalls[0].userId, USER_ID);
  assertEquals(routeCalls[0].userEmail, "owner@example.com");
  assertEquals(routeCalls[0].byokOnly, true);
  assertEquals(routeCalls[0].selection, undefined);

  assertEquals(database.calls.map((call) => call.url.pathname), [
    "/rest/v1/rpc/search_agent_documents",
    "/rest/v1/users",
    "/rest/v1/rpc/search_agent_documents_hybrid",
    "/rest/v1/apps",
  ]);
  const hybridCall = database.calls[2];
  assertEquals(hybridCall.body?.p_user_id, USER_ID);
  assertEquals(hybridCall.body?.p_query, "reply email");
  assertEquals(hybridCall.body?.p_subject_types, ["function"]);
  assertEquals(hybridCall.body?.p_min_similarity, 0.25);
  const vector = hybridCall.body?.p_query_embedding;
  assertEquals(typeof vector, "string");
  assertStringIncludes(String(vector), "[0.001,0.001");
  assertEquals(String(vector).split(",").length, 1536);

  assertEquals(response.results.map((result) => result.id), [
    documentId(1),
    documentId(2),
  ]);
  assertEquals(response.results.map((result) => result.score), [13.5, 2.9]);
});

Deno.test("agent search never uses a non-BYOK route and falls back to lexical navigation", async () => {
  const database = databaseHarness({ lexical: [searchRow()] });
  const routeCalls: ResolveInferenceRouteParams[] = [];
  let embedCalls = 0;

  const response = await searchOwnerAgentNavigation(
    USER_ID,
    { query: "reply" },
    deps(database.fetchFn, {
      semanticEnabled: true,
      resolveRoute: (params) => {
        routeCalls.push(params);
        return Promise.resolve(byokRoute({
          billingMode: "light",
          provider: "ultralight",
          upstreamProvider: "openrouter",
          keySource: "platform_openrouter",
          billingSource: "openrouter",
          shouldRequireBalance: true,
          shouldDebitLight: true,
        }));
      },
      embedQuery: () => {
        embedCalls += 1;
        return Promise.resolve(Array(1536).fill(0));
      },
    }),
  );

  assertEquals(response.results.length, 1);
  assertEquals(embedCalls, 0);
  assertEquals(routeCalls.length, 3);
  assert(routeCalls.every((params) => params.byokOnly === true));
  assert(
    !database.calls.some((call) =>
      call.url.pathname.endsWith("/search_agent_documents_hybrid")
    ),
  );
});

Deno.test("agent search gracefully falls back when embedding or hybrid retrieval is unavailable", async () => {
  const embeddingFailureDatabase = databaseHarness({
    lexical: [searchRow()],
  });
  const embeddingFallback = await searchOwnerAgentNavigation(
    USER_ID,
    { query: "reply" },
    deps(embeddingFailureDatabase.fetchFn, {
      semanticEnabled: true,
      resolveRoute: () => Promise.resolve(byokRoute()),
      embedQuery: () => Promise.reject(new Error("provider secret body")),
    }),
  );
  assertEquals(embeddingFallback.results.length, 1);
  assert(
    !embeddingFailureDatabase.calls.some((call) =>
      call.url.pathname.endsWith("/search_agent_documents_hybrid")
    ),
  );

  const hybridFailureDatabase = databaseHarness({
    lexical: [searchRow()],
    hybrid: { message: "database secret body" },
    hybridStatus: 503,
  });
  const hybridFallback = await searchOwnerAgentNavigation(
    USER_ID,
    { query: "reply" },
    deps(hybridFailureDatabase.fetchFn, {
      semanticEnabled: true,
      resolveRoute: () => Promise.resolve(byokRoute()),
      embedQuery: () => Promise.resolve(Array(1536).fill(0)),
    }),
  );
  assertEquals(hybridFallback.results.length, 1);
  assert(
    hybridFailureDatabase.calls.some((call) =>
      call.url.pathname.endsWith("/search_agent_documents_hybrid")
    ),
  );
});

Deno.test("agent search sends BYOK only to the fixed provider embedding endpoint", async () => {
  const database = databaseHarness({
    lexical: [searchRow()],
    hybrid: [hybridRow()],
  });
  const providerCalls: RecordedCall[] = [];
  const providerFetchFn = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    providerCalls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body
        ? JSON.parse(String(init.body)) as Record<string, unknown>
        : null,
    });
    return Promise.resolve(json({
      data: [{ embedding: Array(1536).fill(0.0005), index: 0 }],
    }));
  }) as typeof fetch;

  await searchOwnerAgentNavigation(
    USER_ID,
    { query: "reply" },
    deps(database.fetchFn, {
      semanticEnabled: true,
      providerFetchFn,
      resolveRoute: () =>
        Promise.resolve(byokRoute({
          provider: "openrouter",
          upstreamProvider: "openrouter",
          baseUrl: "https://attacker-controlled.example/v1",
        })),
    }),
  );

  assertEquals(providerCalls.length, 1);
  assertEquals(
    providerCalls[0].url.toString(),
    "https://openrouter.ai/api/v1/embeddings",
  );
  assertEquals(
    providerCalls[0].headers.get("Authorization"),
    "Bearer owner-byok-secret",
  );
  assertEquals(providerCalls[0].body, {
    model: "openai/text-embedding-3-small",
    input: "reply",
    encoding_format: "float",
    dimensions: 1536,
  });
  assertEquals(
    database.calls[0].headers.get("Authorization"),
    "Bearer service-role-secret",
  );
  assert(!providerCalls[0].headers.has("apikey"));
});

Deno.test("search document embeddings reject non-BYOK routes and fail open without a provider call", async () => {
  let providerCalled = false;
  const embedding = await embedOwnerAgentSearchDocument(
    {
      userId: USER_ID,
      userEmail: "owner@example.com",
      text: "email-ops Inbox triage",
    },
    {
      resolveRoute: () =>
        Promise.resolve(byokRoute({
          billingMode: "light",
          keySource: "platform_openrouter",
          billingSource: "openrouter",
        })),
      providerFetchFn: () => {
        providerCalled = true;
        return Promise.resolve(json({}));
      },
    },
  );

  assertEquals(embedding, null);
  assertEquals(providerCalled, false);
});

Deno.test("search document embeddings return only safe metadata from an owner BYOK call", async () => {
  const embedding = await embedOwnerAgentSearchDocument(
    {
      userId: USER_ID,
      userEmail: "owner@example.com",
      text: "  email-ops   Inbox triage  ",
    },
    {
      resolveRoute: () => Promise.resolve(byokRoute({ provider: "openai" })),
      embedQuery: (text, route) => {
        assertEquals(text, "email-ops Inbox triage");
        assertEquals(route.keySource, "user_byok");
        return Promise.resolve(Array(1_536).fill(0.25));
      },
    },
  );

  assertEquals(embedding?.provider, "openai");
  assertEquals(embedding?.model, "text-embedding-3-small");
  assertEquals(embedding?.embedding.length, 1_536);
  assertEquals(embedding?.textHash.length, 64);
  assert(!JSON.stringify(embedding).includes("owner-byok-secret"));
});

Deno.test("agent search surfaces lexical persistence failure without leaking response content", async () => {
  const database = databaseHarness({
    lexical: {
      message: "secret database detail",
      raw_run_result: "private run output",
    },
    lexicalStatus: 500,
  });
  const error = await assertRejects(
    () =>
      searchOwnerAgentNavigation(
        USER_ID,
        { query: "reply" },
        deps(database.fetchFn),
      ),
    AgentSearchServiceError,
  );
  assertEquals(error.code, "SERVICE_UNAVAILABLE");
  assert(!error.message.includes("secret database detail"));
  assert(!error.message.includes("private run output"));
});

Deno.test("agent search rejects invalid semantic vectors and preserves lexical results", async () => {
  const database = databaseHarness({ lexical: [searchRow()] });
  for (
    const embedding of [
      [0, 1],
      [...Array(1535).fill(0), Number.NaN],
      [...Array(1535).fill(0), Number.POSITIVE_INFINITY],
    ]
  ) {
    const response = await searchOwnerAgentNavigation(
      USER_ID,
      { query: "reply" },
      deps(database.fetchFn, {
        semanticEnabled: true,
        resolveRoute: () => Promise.resolve(byokRoute()),
        embedQuery: () => Promise.resolve(embedding),
      }),
    );
    assertEquals(response.results.length, 1);
  }
});

Deno.test("agent search keeps cross-owner-looking RPC rows out when owner metadata disagrees", async () => {
  const database = databaseHarness({
    lexical: [searchRow({
      agent_id: SECOND_AGENT_ID,
      agent_slug: "other-agent",
      route: "/agents/other-agent?pane=functions&item=send_reply",
    })],
    apps: [{
      id: SECOND_AGENT_ID,
      slug: "different-agent",
      name: "Different Agent",
    }],
  });
  const response = await searchOwnerAgentNavigation(
    USER_ID,
    { query: "reply" },
    deps(database.fetchFn),
  );
  assertEquals(response.results, []);
});
