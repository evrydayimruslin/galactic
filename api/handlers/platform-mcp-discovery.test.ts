import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { executeDiscoverAppstore } from "./platform-mcp.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

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

async function withPlatformDiscoverEnv<T>(
  fn: () => Promise<T>,
  fetchMock: typeof fetch,
): Promise<T> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv || {}),
    BASE_URL: "https://ultralight.test",
    OPENROUTER_EMBEDDING_KEY: "embedding-key",
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  } as typeof globalThis.__env;
  globalThis.fetch = fetchMock;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

Deno.test("platform MCP appstore discovery returns subject-level function call hints", async () => {
  await withPlatformDiscoverEnv(
    async () => {
      const result = await executeDiscoverAppstore(USER_ID, {
        query: "deploy repository dry run",
        limit: 1,
        types: ["app"],
      }) as {
        mode: string;
        results: Array<{
          id: string;
          matched_subject?: {
            source: string;
            type: string;
            id: string;
            next_action?: {
              kind: string;
              function_name?: string;
              endpoint?: string;
            };
          };
        }>;
      };

      assertEquals(result.mode, "search");
      assertEquals(result.results[0].id, "app-1");
      assertEquals(
        result.results[0].matched_subject?.source,
        "tool_semantic_embedding",
      );
      assertEquals(result.results[0].matched_subject?.type, "function");
      assertEquals(result.results[0].matched_subject?.id, "deploy");
      assertEquals(
        result.results[0].matched_subject?.next_action?.kind,
        "call_function",
      );
      assertEquals(
        result.results[0].matched_subject?.next_action?.function_name,
        "deploy",
      );
      assertEquals(
        result.results[0].matched_subject?.next_action?.endpoint,
        "/mcp/app-1",
      );
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
        assertEquals(body.p_subject_types, [
          "app",
          "function",
          "platform_primitive",
        ]);
        return jsonResponse([{
          embedding_id: "embedding-1",
          app_id: "app-1",
          app_version: "v1",
          subject_type: "function",
          subject_id: "function:deploy",
          subject_label: "deploy",
          embedding_text: "Function deploy metadata.",
          embedding_text_hash: "hash-1",
          model: "test-embedding",
          provider: "openrouter",
          embedding_charge_id: "charge-1",
          status: "ready",
          metadata: {
            label: "deploy",
            name: "deploy",
            description: "Deploy a repository from an agent.",
          },
          similarity: 0.92,
          app_name: "Deploy Helper",
          app_slug: "deploy-helper",
          app_description: "Deploys code from agents.",
          app_owner_id: "owner-1",
          app_visibility: "public",
          app_current_version: "v1",
        }]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/user_app_blocks")) {
        return jsonResponse([]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/user_content_blocks")) {
        return jsonResponse([]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/apps?")) {
        return jsonResponse([{
          id: "app-1",
          name: "Deploy Helper",
          slug: "deploy-helper",
          env_schema: {},
          manifest: {
            functions: {
              deploy: { description: "Deploy a repository from an agent." },
            },
          },
          current_version: "v1",
          version_metadata: [],
          runtime: "deno",
          visibility: "public",
          download_access: "public",
          had_external_db: false,
        }]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/user_app_secrets")) {
        return jsonResponse([]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/app_listings")) {
        return jsonResponse([]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/app_bids")) {
        return jsonResponse([]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/appstore_queries")) {
        return jsonResponse([]);
      }

      if (url.startsWith("https://supabase.test/rest/v1/app_impressions")) {
        return jsonResponse([]);
      }

      return jsonResponse([]);
    },
  );
});

Deno.test("platform MCP appstore discovery falls back to inspect_tool for legacy skill subjects", async () => {
  await withPlatformDiscoverEnv(
    async () => {
      const result = await executeDiscoverAppstore(USER_ID, {
        query: "citation context",
        limit: 1,
        types: ["app"],
      }) as {
        mode: string;
        results: Array<{
          id: string;
          matched_subject?: {
            type: string;
            id: string;
            next_action?: {
              kind: string;
              endpoint?: string;
            };
          };
        }>;
      };

      assertEquals(result.mode, "search");
      assertEquals(result.results[0].id, "app-1");
      assertEquals(result.results[0].matched_subject?.type, "skill");
      assertEquals(result.results[0].matched_subject?.id, "context");
      assertEquals(
        result.results[0].matched_subject?.next_action?.kind,
        "inspect_tool",
      );
      assertEquals(
        result.results[0].matched_subject?.next_action?.endpoint,
        "/mcp/app-1",
      );
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);

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
          name: "Research Helper",
          slug: "research-helper",
          env_schema: {},
          manifest: {},
          current_version: "v1",
          version_metadata: [],
          runtime: "deno",
          visibility: "public",
          download_access: "public",
          had_external_db: false,
        }]);
      }

      return jsonResponse([]);
    },
  );
});
