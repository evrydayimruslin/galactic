import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  buildToolSemanticEmbeddingSubjects,
  createEmbeddingService,
  generateToolSemanticEmbeddingsForApp,
  hashEmbeddingText,
  isEmbeddingAvailable,
  searchAppsByEmbedding,
  searchAppsByToolSemanticEmbedding,
  searchToolSemanticEmbeddings,
  type ToolSemanticEmbeddingUpsertParams,
  upsertToolSemanticEmbedding,
} from "./embedding.ts";
import { recordEmbeddingGenerationCharge } from "./embedding-billing.ts";

function withEnv(env: Record<string, unknown>, fn: () => void): void {
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  globalWithEnv.__env = {
    ...(previousEnv || {}),
    ...env,
  };

  try {
    fn();
  } finally {
    globalWithEnv.__env = previousEnv;
  }
}

Deno.test("embedding service ignores OpenRouter management key fallback", () => {
  withEnv({
    OPENROUTER_API_KEY: "or-management-key",
    OPENROUTER_EMBEDDING_KEY: "",
  }, () => {
    assertEquals(createEmbeddingService(), null);
    assertEquals(isEmbeddingAvailable(), false);
  });
});

Deno.test("embedding service uses dedicated embedding key or user key", () => {
  withEnv({
    OPENROUTER_API_KEY: "or-management-key",
    OPENROUTER_EMBEDDING_KEY: "or-embedding-key",
  }, () => {
    assertEquals(createEmbeddingService() !== null, true);
    assertEquals(isEmbeddingAvailable(), true);
  });

  withEnv({
    OPENROUTER_API_KEY: "",
    OPENROUTER_EMBEDDING_KEY: "",
  }, () => {
    assertEquals(createEmbeddingService("or-user-key") !== null, true);
    assertEquals(isEmbeddingAvailable("or-user-key"), true);
  });
});

Deno.test("embedding billing sends deterministic idempotency key", async () => {
  const previousEnv = globalThis.__env;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    OPENROUTER_EMBEDDING_LIGHT_PER_1K_TOKENS: "2",
  } as unknown as typeof globalThis.__env;

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });
    return Promise.resolve(
      new Response(
        JSON.stringify([{
          charge_id: "charge-123",
          amount_light: 3,
          amount_debited_light: 3,
          status: "charged",
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await recordEmbeddingGenerationCharge({
      publisherUserId: "publisher_123",
      appId: "app_123",
      appVersion: "v1",
      model: "openai/text-embedding-3-small",
      promptTokens: 100,
      totalTokens: 1500,
      metadata: { source: "generate_skills_for_version" },
      fetchFn,
    });

    assertEquals(result?.status, "charged");
    assertEquals(
      calls[0].body.p_idempotency_key,
      "embedding_generation:app_123:v1:openai%2Ftext-embedding-3-small:generate_skills_for_version",
    );
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("tool semantic embedding upsert sends versioned subject payload", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });
    return Promise.resolve(
      new Response(
        JSON.stringify([{
          id: "embedding-row-123",
          app_id: "app-123",
          app_version: "v1",
          subject_type: "skill",
          subject_id: "skill:research",
          embedding_text: "Research workflow context",
          embedding_text_hash: "hash-skill",
          model: "openai/text-embedding-3-small",
          provider: "openrouter",
          embedding_charge_id: null,
          status: "ready",
          metadata: { label: "research" },
          created_at: "2026-06-08T00:00:00Z",
          updated_at: "2026-06-08T00:00:00Z",
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  const row = await upsertToolSemanticEmbedding(
    {
      appId: "app-123",
      appVersion: "v1",
      subjectType: "skill",
      subjectId: "skill:research",
      embedding: [1, Number.NaN, 0.5],
      embeddingText: "Research workflow context",
      embeddingTextHash: "hash-skill",
      model: "openai/text-embedding-3-small",
      metadata: { label: "research" },
    },
    {
      supabaseUrl: "https://supabase.example",
      supabaseKey: "service-role",
      fetchFn,
    },
  );

  assertEquals(row.id, "embedding-row-123");
  assertEquals(
    calls[0].url,
    "https://supabase.example/rest/v1/rpc/upsert_tool_semantic_embedding",
  );
  assertEquals(calls[0].body.p_app_id, "app-123");
  assertEquals(calls[0].body.p_app_version, "v1");
  assertEquals(calls[0].body.p_subject_type, "skill");
  assertEquals(calls[0].body.p_subject_id, "skill:research");
  assertEquals(calls[0].body.p_embedding, "[1,0.5]");
  assertEquals(calls[0].body.p_embedding_text_hash, "hash-skill");
  assertEquals(calls[0].body.p_provider, "openrouter");
});

Deno.test("tool semantic embedding upsert hashes text when no hash is supplied", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ body });
    return Promise.resolve(
      new Response(
        JSON.stringify([{
          id: "embedding-row-456",
          app_id: null,
          app_version: "platform",
          subject_type: "platform_primitive",
          subject_id: "wallet",
          embedding_text: "hello",
          embedding_text_hash: body.p_embedding_text_hash,
          model: "model",
          provider: "openrouter",
          embedding_charge_id: null,
          status: "ready",
          metadata: {},
          created_at: "2026-06-08T00:00:00Z",
          updated_at: "2026-06-08T00:00:00Z",
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  await upsertToolSemanticEmbedding(
    {
      appVersion: "platform",
      subjectType: "platform_primitive",
      subjectId: "wallet",
      embedding: [1],
      embeddingText: "hello",
      model: "model",
    },
    {
      supabaseUrl: "https://supabase.example",
      supabaseKey: "service-role",
      fetchFn,
    },
  );

  assertEquals(
    calls[0].body.p_embedding_text_hash,
    await hashEmbeddingText("hello"),
  );
});

Deno.test("tool semantic embedding search sends subject filters", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });
    return Promise.resolve(
      new Response(
        JSON.stringify([{
          embedding_id: "embedding-1",
          app_id: "app-1",
          app_version: "v1",
          subject_type: "function",
          subject_id: "function:search",
          subject_label: "search",
          embedding_text: "Search records",
          embedding_text_hash: "hash-function",
          model: "model",
          provider: "openrouter",
          embedding_charge_id: null,
          status: "ready",
          metadata: {},
          similarity: 0.91,
          app_name: "Search Tool",
          app_slug: "search-tool",
          app_description: null,
          app_owner_id: "owner-1",
          app_visibility: "public",
          app_current_version: "v1",
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  const rows = await searchToolSemanticEmbeddings(
    [0.25, 0.75],
    {
      limit: 7,
      threshold: 0.42,
      subjectTypes: ["function", "skill"],
      appVersion: "v1",
      visibility: ["public", "unlisted"],
      includePlatformPrimitives: false,
    },
    {
      supabaseUrl: "https://supabase.example",
      supabaseKey: "service-role",
      fetchFn,
    },
  );

  assertEquals(rows[0].subject_type, "function");
  assertEquals(calls[0].body.p_query_embedding, "[0.25,0.75]");
  assertEquals(calls[0].body.p_match_threshold, 0.42);
  assertEquals(calls[0].body.p_match_count, 7);
  assertEquals(calls[0].body.p_subject_types, ["function", "skill"]);
  assertEquals(calls[0].body.p_app_version, "v1");
  assertEquals(calls[0].body.p_visibility, ["public", "unlisted"]);
  assertEquals(calls[0].body.p_include_platform_primitives, false);
});

Deno.test("tool semantic app search dedupes to the best subject per app", async () => {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ body });
    return Promise.resolve(
      new Response(
        JSON.stringify([
          {
            embedding_id: "embedding-low",
            app_id: "app-1",
            app_version: "v1",
            subject_type: "app",
            subject_id: "app",
            subject_label: "app",
            embedding_text: "App summary",
            embedding_text_hash: "hash-app",
            model: "model",
            provider: "openrouter",
            embedding_charge_id: null,
            status: "ready",
            metadata: {},
            similarity: 0.51,
            app_name: "Search Tool",
            app_slug: "search-tool",
            app_description: null,
            app_owner_id: "owner-1",
            app_visibility: "public",
            app_current_version: "v1",
          },
          {
            embedding_id: "embedding-high",
            app_id: "app-1",
            app_version: "v1",
            subject_type: "function",
            subject_id: "function:research",
            subject_label: "research",
            embedding_text: "Research records",
            embedding_text_hash: "hash-research",
            model: "model",
            provider: "openrouter",
            embedding_charge_id: null,
            status: "ready",
            metadata: {},
            similarity: 0.92,
            app_name: "Search Tool",
            app_slug: "search-tool",
            app_description: null,
            app_owner_id: "owner-1",
            app_visibility: "public",
            app_current_version: "v1",
          },
          {
            embedding_id: "embedding-other",
            app_id: "app-2",
            app_version: "v1",
            subject_type: "function",
            subject_id: "function:rank",
            subject_label: "rank",
            embedding_text: "Rank records",
            embedding_text_hash: "hash-rank",
            model: "model",
            provider: "openrouter",
            embedding_charge_id: null,
            status: "ready",
            metadata: {},
            similarity: 0.7,
            app_name: "Rank Tool",
            app_slug: "rank-tool",
            app_description: null,
            app_owner_id: "owner-2",
            app_visibility: "public",
            app_current_version: "v1",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  const rows = await searchAppsByToolSemanticEmbedding(
    [1],
    { limit: 10 },
    {
      supabaseUrl: "https://supabase.example",
      supabaseKey: "service-role",
      fetchFn,
    },
  );

  assertEquals(calls[0].body.p_subject_types, [
    "app",
    "function",
    "platform_primitive",
  ]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].embedding_id, "embedding-high");
  assertEquals(rows[0].subject_type, "function");
  assertEquals(rows[1].app_id, "app-2");
});

Deno.test("legacy app embedding search sends current search_apps RPC args", async () => {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  const calls: Array<{ body: Record<string, unknown> }> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;
  globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) => {
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ body });
    return Promise.resolve(
      new Response(
        JSON.stringify([
          {
            id: "app-keep",
            name: "Keep",
            slug: "keep",
            description: null,
            is_public: true,
            owner_id: "owner",
            similarity: 0.8,
          },
          {
            id: "app-drop",
            name: "Drop",
            slug: "drop",
            description: null,
            is_public: true,
            owner_id: "owner",
            similarity: 0.2,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const rows = await searchAppsByEmbedding(
      [0.1, Number.NaN, 0.2],
      "user-123",
      { limit: 5, threshold: 0.5 },
    );

    assertEquals(calls[0].body.p_query_embedding, "[0.1,0.2]");
    assertEquals(calls[0].body.p_user_id, "user-123");
    assertEquals(calls[0].body.p_limit, 5);
    assertEquals(calls[0].body.p_offset, 0);
    assertEquals(rows.map((row) => row.id), ["app-keep"]);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
});

Deno.test("tool semantic subject builder emits only app and function rows", () => {
  const subjects = buildToolSemanticEmbeddingSubjects({
    app: {
      id: "app-123",
      owner_id: "owner-123",
      slug: "research-tool",
      name: "Research Tool",
      description: "Find and rank research sources.",
      tags: ["research", "ranking"],
    },
    manifest: {
      name: "Research Tool",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {
        search: {
          description: "Search records and return ranked matches.",
          parameters: {
            query: { type: "string", description: "Search query" },
          },
        },
      },
      skills: {
        research: {
          name: "Research workflow",
          description: "How to plan research tasks.",
          semantic_description: "Context for research planning and citations.",
          resource: "skills.md",
        },
      },
      widgets: [{
        id: "results",
        label: "Results",
        description: "Review ranked search results.",
        data_function: "search",
        agent_actions: [{
          id: "open",
          label: "Open result",
          mode: "read",
          description: "Open a selected result.",
        }],
      }],
    },
  });

  assertEquals(
    subjects.map((subject) => `${subject.subjectType}:${subject.subjectId}`),
    [
      "app:app",
      "function:function:search",
    ],
  );
  const appSubject = subjects.find((subject) => subject.subjectId === "app");
  assertEquals(appSubject?.embeddingText.includes("Skills: research"), true);
  assertEquals(appSubject?.embeddingText.includes("Widgets:"), false);
});

Deno.test("tool semantic embedding generation charges and upserts each subject idempotently", async () => {
  const chargeCalls: Array<Record<string, unknown>> = [];
  const upsertCalls: ToolSemanticEmbeddingUpsertParams[] = [];
  let embedIndex = 0;

  const result = await generateToolSemanticEmbeddingsForApp({
    app: {
      id: "app-123",
      owner_id: "owner-123",
      slug: "research-tool",
      name: "Research Tool",
      description: "Find and rank research sources.",
    },
    appVersion: "1.0.0",
    manifest: {
      name: "Research Tool",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {
        search: { description: "Search records." },
      },
      skills: {
        context: {
          description: "Research context.",
          semantic_description: "How to use research context.",
          resource: "skills.md",
        },
      },
    },
    embeddingService: {
      embed: async () => {
        embedIndex++;
        return {
          embedding: [embedIndex, 0],
          model: "test-model",
          usage: { prompt_tokens: 2, total_tokens: 4 },
        };
      },
    },
    recordCharge: async (input) => {
      chargeCalls.push(input as unknown as Record<string, unknown>);
      return {
        chargeId: `charge-${chargeCalls.length}`,
        amountLight: 0,
        amountDebitedLight: 0,
        status: "no_charge",
      };
    },
    upsertEmbedding: async (input) => {
      upsertCalls.push(input);
      return {
        id: `row-${upsertCalls.length}`,
        app_id: input.appId || null,
        app_version: input.appVersion || "unversioned",
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        embedding_text: input.embeddingText,
        embedding_text_hash: input.embeddingTextHash ||
          await hashEmbeddingText(input.embeddingText),
        model: input.model,
        provider: input.provider || "openrouter",
        embedding_charge_id: input.embeddingChargeId || null,
        status: input.status || "ready",
        metadata: input.metadata || {},
        created_at: "2026-06-08T00:00:00Z",
        updated_at: "2026-06-08T00:00:00Z",
      };
    },
  });

  assertEquals(result.readyCount, 2);
  assertEquals(result.failedCount, 0);
  assertEquals(result.appEmbedding?.embedding, [1, 0]);
  assertEquals(upsertCalls.map((call) => call.subjectType), [
    "app",
    "function",
  ]);
  assertEquals(upsertCalls.map((call) => call.embeddingChargeId), [
    "charge-1",
    "charge-2",
  ]);
  assertEquals(
    String(chargeCalls[1].idempotencyKey).includes("function%3Asearch"),
    true,
  );
});

Deno.test("tool semantic embedding generation records failed rows for provider errors", async () => {
  const upsertCalls: ToolSemanticEmbeddingUpsertParams[] = [];

  const result = await generateToolSemanticEmbeddingsForApp({
    app: {
      id: "app-123",
      owner_id: "owner-123",
      slug: "broken-tool",
      name: "Broken Tool",
      description: "Provider failure fixture.",
    },
    appVersion: "1.0.0",
    manifest: {
      name: "Broken Tool",
      version: "1.0.0",
      type: "mcp",
      entry: { functions: "index.ts" },
      functions: {
        run: { description: "Run the tool." },
      },
    },
    embeddingService: {
      embed: () => Promise.reject(new Error("provider unavailable")),
    },
    recordCharge: async () => {
      throw new Error("charge should not be attempted");
    },
    upsertEmbedding: async (input) => {
      upsertCalls.push(input);
      return {
        id: `row-${upsertCalls.length}`,
        app_id: input.appId || null,
        app_version: input.appVersion || "unversioned",
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        embedding_text: input.embeddingText,
        embedding_text_hash: input.embeddingTextHash ||
          await hashEmbeddingText(input.embeddingText),
        model: input.model,
        provider: input.provider || "openrouter",
        embedding_charge_id: input.embeddingChargeId || null,
        status: input.status || "failed",
        metadata: input.metadata || {},
        created_at: "2026-06-08T00:00:00Z",
        updated_at: "2026-06-08T00:00:00Z",
      };
    },
  });

  assertEquals(result.readyCount, 0);
  assertEquals(result.failedCount, 2);
  assertEquals(upsertCalls.length, 2);
  assertEquals(upsertCalls[0].status, "failed");
  assertEquals(upsertCalls[0].embedding, null);
  assertEquals(upsertCalls[0].metadata?.failure_stage, "provider");
});
