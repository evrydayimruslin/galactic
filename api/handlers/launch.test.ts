import { assertEquals } from 'https://deno.land/std@0.210.0/assert/assert_equals.ts';
import { assertStringIncludes } from 'https://deno.land/std@0.210.0/assert/assert_string_includes.ts';

import { handleLaunch } from './launch.ts';

const TEST_ENV = {
  BASE_URL: 'https://ultralight.test',
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

async function withLaunchEnv<T>(
  fn: () => Promise<T>,
  fetchMock?: typeof fetch,
  envOverrides: Record<string, string | undefined> = {},
): Promise<T> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
    ...envOverrides,
  } as typeof globalThis.__env;
  if (fetchMock) {
    globalThis.fetch = fetchMock;
  }
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.test('launch facade: install instructions expose MCP and CLI targets', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request('https://ultralight.test/api/launch/install'),
    );
    const body = await response.json() as {
      instructions: Array<{ target: string; configText?: string }>;
    };

    assertEquals(response.status, 200);
    assertEquals(
      body.instructions.map((instruction) => instruction.target),
      [
        'claude_code',
        'cursor',
        'codex',
        'openai_remote_mcp',
        'generic_mcp',
        'cli',
        'api',
      ],
    );
    assertStringIncludes(
      body.instructions[0].configText || '',
      'https://ultralight.test/mcp/platform',
    );
    const apiInstruction = body.instructions.find((instruction) => instruction.target === 'api');
    assertStringIncludes(
      apiInstruction?.configText || '',
      'https://ultralight.test/api/launch/openapi.json',
    );
  });
});

Deno.test('launch facade: install can include tool-specific handoff', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/install?tool=deploy-helper',
        ),
      );
      const body = await response.json() as {
        toolInstall?: {
          selectedToolSlug: string;
          publicToolUrl: string;
          platformMcpUrl: string;
          recommendedApiKey: {
            scopes?: string[];
            appIds?: string[];
          };
          widgetUrls: Array<{ id: string; openUrl: string; renderUrl?: string | null }>;
          agentHandoff: string[];
        } | null;
      };

      assertEquals(response.status, 200);
      assertEquals(body.toolInstall?.selectedToolSlug, 'deploy-helper');
      assertEquals(
        body.toolInstall?.publicToolUrl,
        'https://ultralight.test/tools/deploy-helper',
      );
      assertEquals(
        body.toolInstall?.platformMcpUrl,
        'https://ultralight.test/mcp/platform',
      );
      assertEquals(body.toolInstall?.recommendedApiKey.scopes, [
        'apps:call',
      ]);
      assertEquals(body.toolInstall?.recommendedApiKey.appIds, ['app-1']);
      assertEquals(body.toolInstall?.widgetUrls[0].id, 'ops');
      assertEquals(
        body.toolInstall?.widgetUrls[0].renderUrl,
        'https://ultralight.test/api/launch/tools/deploy-helper/widgets/ops/render',
      );
      assertStringIncludes(
        body.toolInstall?.agentHandoff.join('\n') || '',
        'receipt_id',
      );
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        return jsonResponse([
          {
            id: 'app-1',
            owner_id: 'owner-1',
            slug: 'deploy-helper',
            name: 'Deploy Helper',
            description: 'Deploy tools for existing agents',
            visibility: 'public',
            download_access: 'public',
            current_version: 'v1',
            manifest: {
              widgets: [{
                id: 'ops',
                label: 'Ops',
                description: 'Operations widget',
                ui_function: 'widget_ops_ui',
                data_function: 'widget_ops_data',
              }],
            },
            exports: ['widget_ops_ui', 'widget_ops_data'],
            pricing_config: {},
            gpu_pricing_config: null,
            runtime: 'deno',
            gpu_status: null,
            gpu_type: null,
            version_metadata: [],
            env_schema: {},
            tags: ['deploy'],
            category: 'devtools',
            likes: 0,
            dislikes: 0,
            weighted_likes: 0,
            weighted_dislikes: 0,
            total_runs: 0,
            runs_30d: 0,
            hosting_suspended: false,
            updated_at: '2026-06-01T00:00:00.000Z',
            created_at: '2026-06-01T00:00:00.000Z',
          },
        ]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/users?')) {
        return jsonResponse([
          {
            id: 'owner-1',
            display_name: 'Ada',
            profile_slug: 'ada',
            avatar_url: null,
          },
        ]);
      }
      return jsonResponse([]);
    },
  );
});

Deno.test('launch facade: status exposes self-describing agent links', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request('https://ultralight.test/api/launch/status'),
    );
    const body = await response.json() as {
      available: boolean;
      version: string;
      apiRoutes: string[];
      endpoints: Record<string, string>;
      capabilities: { deferred: string[] };
    };

    assertEquals(response.status, 200);
    assertEquals(body.available, true);
    assertEquals(body.version, 'launch-mvp-v1');
    assertEquals(body.endpoints.openapi, '/api/launch/openapi.json');
    assertEquals(body.endpoints.mcpPlatform, '/mcp/platform');
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/openapi.json'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('POST /api/launch/api-keys'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes(
        'POST /api/launch/tools/:id/widgets/:widgetId/render',
      ),
      true,
    );
    assertEquals(body.endpoints.apiKeys, '/api/launch/api-keys');
    assertEquals(
      body.endpoints.widgetRender,
      '/api/launch/tools/{id}/widgets/{widgetId}/render',
    );
    assertEquals(body.capabilities.deferred.includes('desktop'), true);
  });
});

Deno.test('launch facade: openapi documents curated launch and MCP paths', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request('https://ultralight.test/api/launch/openapi.json'),
    );
    const spec = await response.json() as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, unknown>;
      components?: {
        securitySchemes?: Record<string, unknown>;
        schemas?: Record<string, unknown>;
      };
      'x-launch-scope'?: { deferredCapabilities?: string[] };
    };

    assertEquals(response.status, 200);
    assertEquals(spec.openapi, '3.1.0');
    assertEquals(spec.servers[0].url, 'https://ultralight.test');
    assertEquals(Boolean(spec.paths['/api/launch/discover']), true);
    assertEquals(Boolean(spec.paths['/api/launch/api-keys']), true);
    assertEquals(Boolean(spec.paths['/api/launch/api-keys/{id}']), true);
    assertEquals(
      Boolean(spec.paths['/api/launch/tools/{id}/widgets/{widgetId}']),
      true,
    );
    assertEquals(
      Boolean(spec.paths['/api/launch/tools/{id}/widgets/{widgetId}/render']),
      true,
    );
    assertEquals(Boolean(spec.paths['/api/launch/status']), true);
    assertEquals(Boolean(spec.paths['/mcp/platform']), true);
    assertEquals(Boolean(spec.components?.securitySchemes?.bearerAuth), true);
    assertEquals(Boolean(spec.components?.schemas?.ApiKeySummary), true);
    assertEquals(Boolean(spec.components?.schemas?.TrustCard), true);
    assertEquals(Boolean(spec.components?.schemas?.WidgetDetail), true);
    assertEquals(Boolean(spec.components?.schemas?.WidgetRenderResponse), true);
    assertEquals(Boolean(spec.components?.schemas?.WalletSummary), true);
    assertEquals(
      spec['x-launch-scope']?.deferredCapabilities?.includes('desktop'),
      true,
    );
  });
});

Deno.test('launch facade: widget detail exposes render surface metadata', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/tools/deploy-helper/widgets/ops',
        ),
      );
      const body = await response.json() as {
        tool: { slug: string };
        widget: {
          summary: {
            id: string;
            detailUrl?: string;
            renderUrl?: string;
          };
          functions: {
            uiFunction?: string | null;
            dataFunction?: string | null;
          };
          renderSurface?: { htmlField?: string; authRequired?: boolean } | null;
        };
      };

      assertEquals(response.status, 200);
      assertEquals(body.tool.slug, 'deploy-helper');
      assertEquals(body.widget.summary.id, 'ops');
      assertEquals(
        body.widget.summary.detailUrl,
        '/api/launch/tools/deploy-helper/widgets/ops',
      );
      assertEquals(
        body.widget.summary.renderUrl,
        '/api/launch/tools/deploy-helper/widgets/ops/render',
      );
      assertEquals(body.widget.functions.uiFunction, 'widget_ops_ui');
      assertEquals(body.widget.functions.dataFunction, 'widget_ops_data');
      assertEquals(body.widget.renderSurface?.htmlField, 'app_html');
      assertEquals(body.widget.renderSurface?.authRequired, true);
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        return jsonResponse([
          {
            id: 'app-1',
            owner_id: 'owner-1',
            slug: 'deploy-helper',
            name: 'Deploy Helper',
            description: 'Deploy tools for existing agents',
            visibility: 'public',
            download_access: 'public',
            current_version: 'v1',
            manifest: {
              widgets: [{
                id: 'ops',
                label: 'Ops',
                description: 'Operations widget',
                ui_function: 'widget_ops_ui',
                data_function: 'widget_ops_data',
              }],
            },
            exports: ['widget_ops_ui', 'widget_ops_data'],
            pricing_config: {},
            gpu_pricing_config: null,
            runtime: 'deno',
            gpu_status: null,
            gpu_type: null,
            version_metadata: [],
            env_schema: {},
            tags: ['deploy'],
            category: 'devtools',
            likes: 0,
            dislikes: 0,
            weighted_likes: 0,
            weighted_dislikes: 0,
            total_runs: 0,
            runs_30d: 0,
            hosting_suspended: false,
            updated_at: '2026-06-01T00:00:00.000Z',
            created_at: '2026-06-01T00:00:00.000Z',
          },
        ]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/users?')) {
        return jsonResponse([
          {
            id: 'owner-1',
            display_name: 'Ada',
            profile_slug: 'ada',
            avatar_url: null,
          },
        ]);
      }
      return jsonResponse([]);
    },
  );
});

Deno.test('launch facade: widget render requires authentication', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request(
        'https://ultralight.test/api/launch/tools/deploy-helper/widgets/ops/render',
        { method: 'POST' },
      ),
    );
    const body = await response.json() as { error?: string };

    assertEquals(response.status, 401);
    assertEquals(body.error, 'Authentication required');
  });
});

Deno.test('launch facade: API key metadata requires authentication', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request('https://ultralight.test/api/launch/api-keys'),
    );
    const body = await response.json() as { error?: string };

    assertEquals(response.status, 401);
    assertEquals(body.error, 'Authentication required');
  });
});

Deno.test('launch facade: platform primitives can be query-filtered', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request(
        'https://ultralight.test/api/launch/platform-primitives?q=wallet',
      ),
    );
    const body = await response.json() as {
      suggestions: Array<{ primitive: string; similarity: number | null }>;
    };

    assertEquals(response.status, 200);
    assertEquals(body.suggestions[0].primitive, 'wallet');
  });
});

Deno.test('launch facade: builder leaderboard maps request into RPC payload', async () => {
  const calls: Array<{
    url: string;
    method?: string;
    body: Record<string, unknown>;
  }> = [];

  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/leaderboard?kind=builder&period=90d&limit=2',
        ),
      );
      const body = await response.json() as {
        kind: string;
        period: string;
        entries: Array<{
          userId: string;
          displayName?: string | null;
          value: { light: number; display: string };
          eventCount?: number;
          featuredTool?: { slug: string; name: string } | null;
        }>;
      };

      assertEquals(response.status, 200);
      assertEquals(
        calls[0].url,
        'https://supabase.test/rest/v1/rpc/get_leaderboard',
      );
      assertEquals(calls[0].method, 'POST');
      assertEquals(calls[0].body, {
        p_interval: '90d',
        p_limit: 2,
      });
      assertEquals(body.kind, 'builder');
      assertEquals(body.period, '90d');
      assertEquals(body.entries[0].userId, 'user-1');
      assertEquals(body.entries[0].displayName, 'Ada');
      assertEquals(body.entries[0].value, {
        light: 123,
        display: '123 Light',
      });
      assertEquals(body.entries[0].eventCount, 7);
      assertEquals(body.entries[0].featuredTool?.slug, 'deploy-helper');
    },
    async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({
        url,
        method: init?.method,
        body: JSON.parse(String(init?.body || '{}')),
      });
      return jsonResponse([
        {
          rank: 1,
          user_id: 'user-1',
          display_name: 'Ada',
          profile_slug: 'ada',
          earnings_light: 123,
          event_count: 7,
          featured_app_slug: 'deploy-helper',
          featured_app_name: 'Deploy Helper',
        },
      ]);
    },
  );
});

Deno.test('launch facade: discover uses semantic app and platform primitive embeddings', async () => {
  const calls: Array<{
    url: string;
    method?: string;
    body: Record<string, unknown>;
  }> = [];

  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/discover?query=deploy&limit=1',
        ),
      );
      const body = await response.json() as {
        retrieval: {
          mode: string;
          embeddingModel?: string | null;
          embeddedSources: string[];
          fallbackSources: string[];
        };
        results: Array<{
          id: string;
          relevance?: { source: string; score?: number | null };
        }>;
        platformPrimitives: Array<{
          primitive: string;
          relevance?: { source: string; score?: number | null };
        }>;
      };

      assertEquals(response.status, 200);
      const searchCall = calls.find((call) =>
        call.url === 'https://supabase.test/rest/v1/rpc/search_apps'
      );
      assertEquals(searchCall?.method, 'POST');
      assertEquals(searchCall?.body, {
        p_query_embedding: '[1,0]',
        p_user_id: '00000000-0000-0000-0000-000000000000',
        p_limit: 40,
        p_offset: 0,
      });
      assertEquals(body.retrieval.mode, 'semantic');
      assertEquals(body.retrieval.embeddingModel, 'test-embedding');
      assertEquals(body.retrieval.embeddedSources, [
        'tools',
        'platform_primitives',
        'install_docs',
      ]);
      assertEquals(body.retrieval.fallbackSources, []);
      assertEquals(body.results[0].id, 'app-1');
      assertEquals(body.results[0].relevance?.source, 'semantic');
      assertEquals(body.results[0].relevance?.score, 0.91);
      assertEquals(body.platformPrimitives[0].primitive, 'deploy');
      assertEquals(body.platformPrimitives[0].relevance?.source, 'semantic');
    },
    async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = parseJsonBody(init?.body);
      calls.push({ url, method: init?.method, body });

      if (url === 'https://openrouter.ai/api/v1/embeddings') {
        const model = 'test-embedding';
        const embedding = Array.isArray(body.input)
          ? (body.input as unknown[]).map((_, index) => ({
            embedding: index === 1 ? [1, 0] : [0, 1],
            index,
          }))
          : [{ embedding: [1, 0], index: 0 }];
        return jsonResponse({
          data: embedding,
          model,
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      if (url === 'https://supabase.test/rest/v1/rpc/search_apps') {
        return jsonResponse([{ id: 'app-1', similarity: 0.91 }]);
      }

      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        return jsonResponse([
          {
            id: 'app-1',
            owner_id: 'owner-1',
            slug: 'deploy-helper',
            name: 'Deploy Helper',
            description: 'Deploy tools for existing agents',
            visibility: 'public',
            download_access: 'public',
            current_version: 'v1',
            manifest: { widgets: [] },
            exports: ['deploy'],
            pricing_config: {},
            gpu_pricing_config: null,
            runtime: 'deno',
            gpu_status: null,
            gpu_type: null,
            version_metadata: [],
            env_schema: {},
            tags: ['deploy'],
            category: 'devtools',
            likes: 0,
            dislikes: 0,
            weighted_likes: 0,
            weighted_dislikes: 0,
            total_runs: 0,
            runs_30d: 0,
            hosting_suspended: false,
            updated_at: '2026-06-01T00:00:00.000Z',
            created_at: '2026-06-01T00:00:00.000Z',
          },
        ]);
      }

      if (url.startsWith('https://supabase.test/rest/v1/users?')) {
        return jsonResponse([
          {
            id: 'owner-1',
            display_name: 'Ada',
            profile_slug: 'ada',
            avatar_url: null,
          },
        ]);
      }

      return jsonResponse([]);
    },
    { OPENROUTER_EMBEDDING_KEY: 'embedding-key' },
  );
});

Deno.test('launch facade: mutation methods are rejected', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request('https://ultralight.test/api/launch/install', {
        method: 'POST',
      }),
    );

    assertEquals(response.status, 405);
  });
});

function parseJsonBody(
  body: BodyInit | null | undefined,
): Record<string, unknown> {
  if (typeof body !== 'string') return {};
  return JSON.parse(body) as Record<string, unknown>;
}
