import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { handleDiscover } from "./discover.ts";

const TEST_ENV = {
  BASE_URL: "https://ultralight.test",
  OPENROUTER_EMBEDDING_KEY: "embedding-key",
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function parseJsonBody(
  body: BodyInit | null | undefined,
): Record<string, unknown> {
  if (!body || typeof body !== "string") return {};
  return JSON.parse(body) as Record<string, unknown>;
}

async function withDiscoverEnv<T>(
  fn: () => Promise<T>,
  fetchMock: typeof fetch,
): Promise<T> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  globalThis.fetch = fetchMock;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

Deno.test("/api/discover uses subject semantic index and returns inspect hints for legacy skill subjects", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  await withDiscoverEnv(
    async () => {
      const response = await handleDiscover(
        new Request(
          "https://ultralight.test/api/discover?q=citation+context&limit=1",
        ),
      );
      const body = await response.json() as {
        results: Array<{
          id: string;
          matched_subject?: {
            source: string;
            type: string;
            id: string;
            label?: string | null;
            preview?: string | null;
            next_action?: { kind: string; endpoint?: string };
          };
        }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.results[0].id, "app-1");
      assertEquals(
        body.results[0].matched_subject?.source,
        "tool_semantic_embedding",
      );
      assertEquals(body.results[0].matched_subject?.type, "skill");
      assertEquals(body.results[0].matched_subject?.id, "context");
      assertEquals(
        body.results[0].matched_subject?.preview,
        "Citation workflow preview.",
      );
      assertEquals(
        body.results[0].matched_subject?.next_action?.kind,
        "inspect_tool",
      );
      assertEquals(
        body.results[0].matched_subject?.next_action?.endpoint,
        "/mcp/app-1",
      );
      assertEquals(
        calls.some((call) => call.url.endsWith("/rest/v1/rpc/search_apps")),
        false,
      );
    },
    async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = parseJsonBody(init?.body);
      calls.push({ url, body });

      if (url === "https://openrouter.ai/api/v1/embeddings") {
        return jsonResponse({
          data: [{ embedding: [1, 0], index: 0 }],
          model: "test-embedding",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      if (
        url ===
          "https://supabase.test/rest/v1/rpc/search_tool_semantic_embeddings"
      ) {
        return jsonResponse([{
          embedding_id: "embedding-1",
          app_id: "app-1",
          app_version: "v1",
          subject_type: "skill",
          subject_id: "skill:context",
          subject_label: "Research context",
          embedding_text: "Skill preview metadata only.",
          embedding_text_hash: "hash-1",
          model: "test-embedding",
          provider: "openrouter",
          embedding_charge_id: "charge-1",
          status: "ready",
          metadata: {
            label: "Research context",
            description: "Paid research planning context.",
            semantic_description:
              "Context for citation-heavy research planning.",
            preview: "Citation workflow preview.",
          },
          similarity: 0.93,
          app_name: "Research Helper",
          app_slug: "research-helper",
          app_description: "Plans citation-heavy research.",
          app_owner_id: "owner-1",
          app_visibility: "public",
          app_current_version: "v1",
        }]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/apps?")) {
        return jsonResponse([{
          id: "app-1",
          env_schema: {},
          manifest: {},
          likes: 2,
          dislikes: 0,
          weighted_likes: 4,
          weighted_dislikes: 0,
          runs_30d: 8,
        }]);
      }

      return jsonResponse([]);
    },
  );
});

Deno.test("/api/discover falls back to legacy aggregate app embeddings when subject index is empty", async () => {
  await withDiscoverEnv(
    async () => {
      const response = await handleDiscover(
        new Request("https://ultralight.test/api/discover?q=deploy&limit=1"),
      );
      const body = await response.json() as {
        results: Array<{
          id: string;
          matched_subject?: { source: string; type: string };
        }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.results[0].id, "app-legacy");
      assertEquals(
        body.results[0].matched_subject?.source,
        "legacy_app_embedding",
      );
      assertEquals(body.results[0].matched_subject?.type, "app");
    },
    async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = parseJsonBody(init?.body);

      if (url === "https://openrouter.ai/api/v1/embeddings") {
        return jsonResponse({
          data: [{ embedding: [1, 0], index: 0 }],
          model: "test-embedding",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      if (
        url ===
          "https://supabase.test/rest/v1/rpc/search_tool_semantic_embeddings"
      ) {
        return jsonResponse([]);
      }

      if (url === "https://supabase.test/rest/v1/rpc/search_apps") {
        return jsonResponse([{
          id: "app-legacy",
          owner_id: "owner-legacy",
          slug: "deploy-helper",
          name: "Deploy Helper",
          description: "Deploy code from an agent.",
          visibility: "public",
          likes: 1,
          dislikes: 0,
          similarity: 0.88,
          hosting_suspended: false,
        }]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/apps?")) {
        return jsonResponse([{
          id: "app-legacy",
          env_schema: {},
          manifest: {},
          likes: 1,
          dislikes: 0,
          weighted_likes: 1,
          weighted_dislikes: 0,
          runs_30d: 3,
        }]);
      }

      return jsonResponse([]);
    },
  );
});
