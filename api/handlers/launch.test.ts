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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function launchPermissionTestApp(): Record<string, unknown> {
  return {
    id: 'app-1',
    owner_id: 'owner-1',
    slug: 'deploy-helper',
    name: 'Deploy Helper',
    description: 'Deploy tools for existing agents',
    visibility: 'public',
    download_access: 'public',
    current_version: 'v1',
    manifest: {
      access_policy: {
        mode: 'module',
        module: 'policy.ts',
        export: 'planAccess',
      },
      functions: {
        deploy: {
          description: 'Deploy code',
          parameters: {
            repo: {
              type: 'string',
              description: 'Repository URL',
            },
            dry_run: {
              type: 'boolean',
              description: 'Validate without deploying',
              required: false,
            },
          },
          returns: {
            type: 'object',
            description: 'Deployment result',
          },
        },
        inspect: { description: 'Inspect state' },
      },
      widgets: [{
        id: 'ops',
        label: 'Ops',
        description: 'Operations widget',
        ui_function: 'widget_ops_ui',
        data_function: 'widget_ops_data',
      }],
    },
    exports: ['deploy', 'inspect', 'widget_ops_ui', 'widget_ops_data'],
    pricing_config: {
      default_price_light: 1,
      default_skill_pull_price_light: 2,
      functions: {
        deploy: 3,
        inspect: { price_light: 0 },
      },
      skills: {
        context: { price_light: 2, free_pulls: 1 },
      },
    },
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
  };
}

function privateOwnerTestApp(): Record<string, unknown> {
  return {
    ...launchPermissionTestApp(),
    id: 'app-private-1',
    owner_id: 'user-1',
    slug: 'private-helper',
    name: 'Private Helper',
    description: 'Private owner-only preview tool',
    visibility: 'private',
  };
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
    assertStringIncludes(
      apiInstruction?.configText || '',
      'https://ultralight.test/api/launch/store?query=deploy',
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
          widgetUrls: Array<
            { id: string; openUrl: string; renderUrl?: string | null }
          >;
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
      compatibilityPublicRoutes: string[];
      capabilities: { deferred: string[] };
    };

    assertEquals(response.status, 200);
    assertEquals(body.available, true);
    assertEquals(body.version, 'launch-mvp-v1');
    assertEquals(body.endpoints.openapi, '/api/launch/openapi.json');
    assertEquals(body.endpoints.mcpPlatform, '/mcp/platform');
    assertEquals(body.compatibilityPublicRoutes.includes('/discover'), true);
    assertEquals(body.endpoints.store, '/api/launch/store?query={query}');
    assertEquals(body.endpoints.discover, '/api/launch/discover?query={query}');
    assertEquals(
      body.endpoints.discoverAlias,
      '/api/launch/discover?query={query}',
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/openapi.json'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/store'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('POST /api/launch/api-keys'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/wallet/topup/quote'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('POST /api/launch/wallet/topup/intent'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/wallet/transactions'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/wallet/earnings'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes(
        'POST /api/launch/tools/:id/widgets/:widgetId/render',
      ),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/tools/:id/functions'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes(
        'POST /api/launch/tools/:id/functions/:functionName/run',
      ),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/tools/:id/skills'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes(
        'POST /api/launch/tools/:id/skills/:skillId/pull',
      ),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/tools/:id/agent-permissions'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes(
        'PATCH /api/launch/tools/:id/agent-permissions',
      ),
      true,
    );
    assertEquals(body.endpoints.apiKeys, '/api/launch/api-keys');
    assertEquals(
      body.endpoints.widgetRender,
      '/api/launch/tools/{id}/widgets/{widgetId}/render',
    );
    assertEquals(
      body.endpoints.toolFunctions,
      '/api/launch/tools/{id}/functions',
    );
    assertEquals(
      body.endpoints.functionRun,
      '/api/launch/tools/{id}/functions/{functionName}/run',
    );
    assertEquals(
      body.endpoints.toolSkills,
      '/api/launch/tools/{id}/skills',
    );
    assertEquals(
      body.endpoints.skillPull,
      '/api/launch/tools/{id}/skills/{skillId}/pull',
    );
    assertEquals(
      body.endpoints.agentPermissions,
      '/api/launch/tools/{id}/agent-permissions',
    );
    assertEquals(
      body.endpoints.walletTopUpQuote,
      '/api/launch/wallet/topup/quote?amount_light=2500&method=card',
    );
    assertEquals(
      body.endpoints.walletTopUpIntent,
      '/api/launch/wallet/topup/intent',
    );
    assertEquals(
      body.endpoints.walletTransactions,
      '/api/launch/wallet/transactions?limit=25&cursor={cursor}',
    );
    assertEquals(
      body.endpoints.walletEarnings,
      '/api/launch/wallet/earnings?tool={toolId}&limit=25&cursor={cursor}',
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
      'x-launch-scope'?: {
        deferredCapabilities?: string[];
        compatibilityPublicRoutes?: string[];
      };
    };

    assertEquals(response.status, 200);
    assertEquals(spec.openapi, '3.1.0');
    assertEquals(spec.servers[0].url, 'https://ultralight.test');
    assertEquals(Boolean(spec.paths['/api/launch/store']), true);
    assertEquals(Boolean(spec.paths['/api/launch/discover']), true);
    assertEquals(Boolean(spec.paths['/api/launch/wallet/transactions']), true);
    assertEquals(Boolean(spec.paths['/api/launch/wallet/receipts']), true);
    assertEquals(Boolean(spec.paths['/api/launch/wallet/earnings']), true);
    assertEquals(Boolean(spec.paths['/api/launch/wallet/payouts']), true);
    assertEquals(Boolean(spec.paths['/api/launch/wallet/topup/quote']), true);
    assertEquals(Boolean(spec.paths['/api/launch/wallet/topup/intent']), true);
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
    assertEquals(Boolean(spec.paths['/api/launch/tools/{id}/functions']), true);
    assertEquals(
      Boolean(
        spec.paths['/api/launch/tools/{id}/functions/{functionName}/run'],
      ),
      true,
    );
    assertEquals(Boolean(spec.paths['/api/launch/tools/{id}/skills']), true);
    assertEquals(
      Boolean(spec.paths['/api/launch/tools/{id}/skills/{skillId}/pull']),
      true,
    );
    assertEquals(
      Boolean(spec.paths['/api/launch/tools/{id}/agent-permissions']),
      true,
    );
    assertEquals(Boolean(spec.paths['/api/launch/status']), true);
    assertEquals(Boolean(spec.paths['/mcp/platform']), true);
    assertEquals(Boolean(spec.components?.securitySchemes?.bearerAuth), true);
    assertEquals(Boolean(spec.components?.schemas?.ApiKeySummary), true);
    assertEquals(
      Boolean(spec.components?.schemas?.AgentFunctionPermissions),
      true,
    );
    assertEquals(Boolean(spec.components?.schemas?.ToolSkillsResponse), true);
    assertEquals(Boolean(spec.components?.schemas?.TrustCard), true);
    assertEquals(Boolean(spec.components?.schemas?.WidgetDetail), true);
    assertEquals(Boolean(spec.components?.schemas?.WidgetRenderResponse), true);
    assertEquals(
      Boolean(spec.components?.schemas?.ToolFunctionsResponse),
      true,
    );
    assertEquals(Boolean(spec.components?.schemas?.FunctionRunResponse), true);
    assertEquals(Boolean(spec.components?.schemas?.WalletSummary), true);
    assertEquals(Boolean(spec.components?.schemas?.WalletPage), true);
    assertEquals(Boolean(spec.components?.schemas?.WalletTransaction), true);
    assertEquals(Boolean(spec.components?.schemas?.WalletEarning), true);
    assertEquals(Boolean(spec.components?.schemas?.WalletFundingQuote), true);
    assertEquals(
      spec['x-launch-scope']?.deferredCapabilities?.includes('desktop'),
      true,
    );
    assertEquals(
      spec['x-launch-scope']?.compatibilityPublicRoutes?.includes('/discover'),
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

Deno.test('launch facade: public slug lookups avoid uuid id comparisons', async () => {
  await withLaunchEnv(
    async () => {
      const endpoints = [
        '/api/launch/tools/deploy-helper',
        '/api/launch/tools/deploy-helper/widgets',
        '/api/launch/tools/deploy-helper/widgets/ops',
        '/api/launch/tools/deploy-helper/functions',
        '/api/launch/tools/deploy-helper/skills',
      ];

      for (const endpoint of endpoints) {
        const response = await handleLaunch(
          new Request(`https://ultralight.test${endpoint}`),
        );
        const body = await response.json() as {
          tool?: { slug?: string };
          error?: string;
        };

        assertEquals(response.status, 200, `${endpoint}: ${body.error || ''}`);
        assertEquals(body.tool?.slug, 'deploy-helper');
      }
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        const parsed = new URL(url);
        const orParam = parsed.searchParams.get('or') || '';
        if (orParam.includes('id.eq.deploy-helper')) {
          return jsonResponse(
            { error: 'invalid input syntax for type uuid: "deploy-helper"' },
            400,
          );
        }
        if (parsed.searchParams.get('slug') === 'eq.deploy-helper') {
          return jsonResponse([launchPermissionTestApp()]);
        }
        return jsonResponse([]);
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

Deno.test('launch facade: owners can preview private tools and widgets', async () => {
  await withLaunchEnv(
    async () => {
      const endpoints = [
        '/api/launch/tools/private-helper',
        '/api/launch/tools/private-helper/widgets',
        '/api/launch/tools/private-helper/widgets/ops',
        '/api/launch/tools/private-helper/functions',
        '/api/launch/tools/private-helper/skills',
      ];

      for (const endpoint of endpoints) {
        const response = await handleLaunch(
          new Request(`https://ultralight.test${endpoint}`, {
            headers: { Authorization: 'Bearer browser-session-token' },
          }),
        );
        const body = await response.json() as {
          error?: string;
          functions?: Array<{ name: string }>;
          skills?: Array<{ id: string }>;
          tool?: { relationship?: string; slug?: string };
          widget?: { summary?: { id?: string } };
          widgets?: Array<{ id: string }>;
        };

        assertEquals(response.status, 200, `${endpoint}: ${body.error || ''}`);
        assertEquals(body.tool?.slug, 'private-helper');
        assertEquals(body.tool?.relationship, 'owner');
        if (endpoint.endsWith('/widgets')) {
          assertEquals(body.widgets?.[0]?.id, 'ops');
        }
        if (endpoint.endsWith('/widgets/ops')) {
          assertEquals(body.widget?.summary?.id, 'ops');
        }
        if (endpoint.endsWith('/functions')) {
          assertEquals(
            body.functions?.map((entry) => entry.name),
            ['deploy', 'inspect', 'widget_ops_data', 'widget_ops_ui'],
          );
        }
        if (endpoint.endsWith('/skills')) {
          assertEquals(body.skills?.[0]?.id, 'context');
        }
      }
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://supabase.test/auth/v1/user') {
        return jsonResponse({
          id: 'user-1',
          email: 'founder@example.com',
          user_metadata: {},
        });
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=id')) {
        return jsonResponse([{ id: 'user-1' }]);
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=tier')) {
        return jsonResponse([{ tier: 'free' }]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/user_app_library?')) {
        return jsonResponse([]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        if (url.includes('owner_id=eq.user-1')) {
          return jsonResponse([privateOwnerTestApp()]);
        }
        return jsonResponse([]);
      }
      if (
        url.startsWith(
          'https://supabase.test/rest/v1/user_agent_permission_defaults?',
        )
      ) {
        return jsonResponse([{ user_id: 'user-1', default_policy: 'ask' }]);
      }
      if (
        url.startsWith(
          'https://supabase.test/rest/v1/user_agent_function_permissions?',
        )
      ) {
        return jsonResponse([]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/users?')) {
        return jsonResponse([
          {
            id: 'user-1',
            display_name: 'Founder',
            profile_slug: 'founder',
            avatar_url: null,
          },
        ]);
      }
      return jsonResponse([]);
    },
  );
});

Deno.test('launch facade: unauthenticated private previews stay hidden', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/tools/private-helper'),
      );
      const body = await response.json() as { error?: string };

      assertEquals(response.status, 404);
      assertEquals(body.error, 'Tool not found');
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        return jsonResponse([]);
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

Deno.test('launch facade: tool functions expose pricing, schemas, widgets, and policy', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/tools/deploy-helper/functions',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as {
        tool: { slug: string };
        functions: Array<{
          name: string;
          description?: string | null;
          inputSchema?: {
            properties?: Record<string, unknown>;
            required?: string[];
          } | null;
          outputSchema?: Record<string, unknown> | null;
          pricing?: {
            defaultCallPrice?: { light: number; display: string } | null;
          } | null;
          accessPolicy?: {
            configured: boolean;
            mode: string;
            module: string | null;
            exportName: string;
            execution: string;
          } | null;
          widgetIds?: string[];
          agentPermission?: { policy: string; source: string } | null;
        }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.tool.slug, 'deploy-helper');
      assertEquals(body.functions.map((entry) => entry.name), [
        'deploy',
        'inspect',
        'widget_ops_data',
        'widget_ops_ui',
      ]);
      const deploy = body.functions[0];
      assertEquals(deploy.description, 'Deploy code');
      assertEquals(Boolean(deploy.inputSchema?.properties?.repo), true);
      assertEquals(deploy.inputSchema?.required, ['repo']);
      assertEquals(deploy.outputSchema?.type, 'object');
      assertEquals(deploy.pricing?.defaultCallPrice?.light, 3);
      assertEquals(deploy.accessPolicy?.configured, true);
      assertEquals(deploy.accessPolicy?.mode, 'module');
      assertEquals(deploy.accessPolicy?.module, 'policy.ts');
      assertEquals(deploy.accessPolicy?.exportName, 'planAccess');
      assertEquals(deploy.accessPolicy?.execution, 'runtime_policy');
      assertEquals(deploy.agentPermission?.policy, 'always');
      assertEquals(deploy.agentPermission?.source, 'explicit');
      const widgetUi = body.functions.find((entry) => entry.name === 'widget_ops_ui');
      assertEquals(widgetUi?.widgetIds, ['ops']);
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://supabase.test/auth/v1/user') {
        return jsonResponse({
          id: 'user-1',
          email: 'founder@example.com',
          user_metadata: {},
        });
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=id')) {
        return jsonResponse([{ id: 'user-1' }]);
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=tier')) {
        return jsonResponse([{ tier: 'free' }]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/user_app_library?')) {
        return jsonResponse([]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        if (url.includes('owner_id=eq.user-1')) return jsonResponse([]);
        return jsonResponse([launchPermissionTestApp()]);
      }
      if (
        url.startsWith(
          'https://supabase.test/rest/v1/user_agent_permission_defaults?',
        )
      ) {
        return jsonResponse([{ user_id: 'user-1', default_policy: 'ask' }]);
      }
      if (
        url.startsWith(
          'https://supabase.test/rest/v1/user_agent_function_permissions?',
        )
      ) {
        return jsonResponse([{
          app_id: 'app-1',
          function_name: 'deploy',
          policy: 'always',
        }]);
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

Deno.test('launch facade: tool skills expose context pricing and pull URL', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/tools/deploy-helper/skills',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as {
        tool: { slug: string };
        skills: Array<{
          id: string;
          semanticDescription: string;
          pricing?: {
            pullPrice?: { light: number; display: string } | null;
            freePulls: number;
            monetized: boolean;
          } | null;
          accessPolicy?: {
            configured: boolean;
            mode: string;
            module: string | null;
            exportName: string;
            execution: string;
          } | null;
          pullUrl: string;
        }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.tool.slug, 'deploy-helper');
      assertEquals(body.skills[0].id, 'context');
      assertEquals(body.skills[0].pricing?.pullPrice?.light, 2);
      assertEquals(body.skills[0].accessPolicy?.configured, true);
      assertEquals(body.skills[0].accessPolicy?.execution, 'runtime_policy');
      assertEquals(body.skills[0].pricing?.freePulls, 1);
      assertEquals(body.skills[0].pricing?.monetized, true);
      assertEquals(
        body.skills[0].pullUrl,
        '/api/launch/tools/deploy-helper/skills/context/pull',
      );
      assertEquals(
        body.skills[0].semanticDescription.includes('Deploy Helper'),
        true,
      );
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://supabase.test/auth/v1/user') {
        return jsonResponse({
          id: 'user-1',
          email: 'founder@example.com',
          user_metadata: {},
        });
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=id')) {
        return jsonResponse([{ id: 'user-1' }]);
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=tier')) {
        return jsonResponse([{ tier: 'free' }]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/user_app_library?')) {
        return jsonResponse([]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        if (url.includes('owner_id=eq.user-1')) return jsonResponse([]);
        return jsonResponse([launchPermissionTestApp()]);
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

Deno.test('launch facade: function run requires authentication', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request(
        'https://ultralight.test/api/launch/tools/deploy-helper/functions/deploy/run',
        { method: 'POST', body: JSON.stringify({ args: {} }) },
      ),
    );
    const body = await response.json() as { error?: string };

    assertEquals(response.status, 401);
    assertEquals(body.error, 'Authentication required');
  });
});

Deno.test('launch facade: agent permissions list tool functions and policies', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/tools/deploy-helper/agent-permissions',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as {
        tool: { slug: string };
        defaultPolicy: string;
        permissions: Array<{
          functionName: string;
          policy: string;
          source: string;
        }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.tool.slug, 'deploy-helper');
      assertEquals(body.defaultPolicy, 'ask');
      assertEquals(body.permissions.map((entry) => entry.functionName), [
        'deploy',
        'inspect',
        'widget_ops_data',
        'widget_ops_ui',
      ]);
      assertEquals(body.permissions[0].policy, 'always');
      assertEquals(body.permissions[0].source, 'explicit');
      assertEquals(body.permissions[1].policy, 'ask');
      assertEquals(body.permissions[1].source, 'default');
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://supabase.test/auth/v1/user') {
        return jsonResponse({
          id: 'user-1',
          email: 'founder@example.com',
          user_metadata: {},
        });
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=id')) {
        return jsonResponse([{ id: 'user-1' }]);
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=tier')) {
        return jsonResponse([{ tier: 'free' }]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/user_app_library?')) {
        return jsonResponse([]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        if (url.includes('owner_id=eq.user-1')) return jsonResponse([]);
        return jsonResponse([launchPermissionTestApp()]);
      }
      if (
        url.startsWith(
          'https://supabase.test/rest/v1/user_agent_permission_defaults?',
        )
      ) {
        return jsonResponse([{ user_id: 'user-1', default_policy: 'ask' }]);
      }
      if (
        url.startsWith(
          'https://supabase.test/rest/v1/user_agent_function_permissions?',
        )
      ) {
        return jsonResponse([{
          app_id: 'app-1',
          function_name: 'deploy',
          policy: 'always',
        }]);
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

Deno.test('launch facade: agent permissions patch upserts policy rows', async () => {
  const writes: Array<{ url: string; body: unknown }> = [];
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/tools/deploy-helper/agent-permissions',
          {
            method: 'PATCH',
            headers: {
              Authorization: 'Bearer browser-session-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              defaultPolicy: 'ask',
              permissions: [{ functionName: 'deploy', policy: 'always' }],
            }),
          },
        ),
      );
      const body = await response.json() as {
        defaultPolicy: string;
        permissions: Array<{ functionName: string; policy: string }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.defaultPolicy, 'ask');
      assertEquals(body.permissions[0].policy, 'always');
      assertEquals(writes.length, 2);
      assertEquals(
        writes[0].url,
        'https://supabase.test/rest/v1/user_agent_permission_defaults?on_conflict=user_id',
      );
      assertEquals(
        writes[1].url,
        'https://supabase.test/rest/v1/user_agent_function_permissions?on_conflict=user_id,app_id,function_name',
      );
    },
    async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === 'POST') {
        writes.push({
          url,
          body: JSON.parse(String(init.body)),
        });
        return new Response(null, { status: 204 });
      }
      if (url === 'https://supabase.test/auth/v1/user') {
        return jsonResponse({
          id: 'user-1',
          email: 'founder@example.com',
          user_metadata: {},
        });
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=id')) {
        return jsonResponse([{ id: 'user-1' }]);
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=tier')) {
        return jsonResponse([{ tier: 'free' }]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/user_app_library?')) {
        return jsonResponse([]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        if (url.includes('owner_id=eq.user-1')) return jsonResponse([]);
        return jsonResponse([launchPermissionTestApp()]);
      }
      if (
        url.startsWith(
          'https://supabase.test/rest/v1/user_agent_permission_defaults?',
        )
      ) {
        return jsonResponse([{ user_id: 'user-1', default_policy: 'ask' }]);
      }
      if (
        url.startsWith(
          'https://supabase.test/rest/v1/user_agent_function_permissions?',
        )
      ) {
        return jsonResponse([{
          app_id: 'app-1',
          function_name: 'deploy',
          policy: 'always',
        }]);
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

Deno.test('launch facade: wallet top-up quote uses launch gross-up math', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/wallet/topup/quote?amount_light=10000&method=ach',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as {
        quote: {
          method: string;
          methodLabel: string;
          amountLight: number;
          lightPerDollar: number;
          baseAmountCents: number;
          processingFeeCents: number;
          totalAmountCents: number;
        };
        presets: Array<{ light: number; label: string }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.quote.method, 'ach');
      assertEquals(body.quote.methodLabel, 'Bank (ACH)');
      assertEquals(body.quote.amountLight, 10000);
      assertEquals(body.quote.lightPerDollar, 100);
      assertEquals(body.quote.baseAmountCents, 10000);
      assertEquals(body.quote.processingFeeCents, 81);
      assertEquals(body.quote.totalAmountCents, 10081);
      assertEquals(body.presets.map((preset) => preset.light), [
        1000,
        2500,
        5000,
        10000,
      ]);
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://supabase.test/auth/v1/user') {
        return jsonResponse({
          id: 'user-1',
          email: 'founder@example.com',
          user_metadata: {},
        });
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=id')) {
        return jsonResponse([{ id: 'user-1' }]);
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=tier')) {
        return jsonResponse([{ tier: 'free' }]);
      }
      return jsonResponse([]);
    },
  );
});

Deno.test('launch facade: wallet transactions support cursor pagination', async () => {
  const transactionUrls: string[] = [];
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/wallet/transactions?limit=2&cursor=2026-06-06T10:00:00.000Z',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as {
        kind: string;
        items: Array<{ id: string; createdAt?: string | null }>;
        page: { limit: number; hasMore: boolean; nextCursor?: string | null };
      };

      assertEquals(response.status, 200);
      assertEquals(body.kind, 'transactions');
      assertEquals(body.items.map((item) => item.id), ['tx-1', 'tx-2']);
      assertEquals(body.page.limit, 2);
      assertEquals(body.page.hasMore, true);
      assertEquals(body.page.nextCursor, '2026-06-06T09:58:00.000Z');
      assertStringIncludes(transactionUrls[0], 'limit=3');
      assertStringIncludes(
        transactionUrls[0],
        'created_at=lt.2026-06-06T10:00:00.000Z',
      );
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const decodedUrl = decodeURIComponent(url);
      if (url === 'https://supabase.test/auth/v1/user') {
        return jsonResponse({
          id: 'user-1',
          email: 'founder@example.com',
          user_metadata: {},
        });
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=id')) {
        return jsonResponse([{ id: 'user-1' }]);
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=tier')) {
        return jsonResponse([{ tier: 'free' }]);
      }
      if (
        decodedUrl.startsWith(
          'https://supabase.test/rest/v1/billing_transactions?',
        )
      ) {
        transactionUrls.push(decodedUrl);
        return jsonResponse([
          {
            id: 'tx-1',
            type: 'credit',
            category: 'topup',
            description: 'Added Light',
            amount_light: 1000,
            balance_after_light: 5000,
            app_id: null,
            app_name: null,
            created_at: '2026-06-06T09:59:00.000Z',
          },
          {
            id: 'tx-2',
            type: 'debit',
            category: 'tool_call',
            description: 'Tool call',
            amount_light: -5,
            balance_after_light: 4995,
            app_id: 'app-1',
            app_name: 'Deploy Helper',
            created_at: '2026-06-06T09:58:00.000Z',
          },
          {
            id: 'tx-3',
            type: 'debit',
            category: 'tool_call',
            description: 'Older tool call',
            amount_light: -2,
            balance_after_light: 4993,
            app_id: 'app-2',
            app_name: 'Inspect Helper',
            created_at: '2026-06-06T09:57:00.000Z',
          },
        ]);
      }
      return jsonResponse([]);
    },
  );
});

Deno.test('launch facade: wallet earnings can filter by tool', async () => {
  const transferUrls: string[] = [];
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/wallet/earnings?tool=app-1&limit=2',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as {
        kind: string;
        items: Array<{ appId?: string | null; reason: string }>;
        page: { limit: number; hasMore: boolean; nextCursor?: string | null };
      };

      assertEquals(response.status, 200);
      assertEquals(body.kind, 'earnings');
      assertEquals(body.items.length, 1);
      assertEquals(body.items[0].appId, 'app-1');
      assertEquals(body.items[0].reason, 'app_call');
      assertEquals(body.page.limit, 2);
      assertEquals(body.page.hasMore, false);
      assertStringIncludes(transferUrls[0], 'app_id=eq.app-1');
      assertStringIncludes(
        transferUrls[0],
        'reason=not.in.(withdrawal,withdrawal_refund)',
      );
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const decodedUrl = decodeURIComponent(url);
      if (url === 'https://supabase.test/auth/v1/user') {
        return jsonResponse({
          id: 'user-1',
          email: 'founder@example.com',
          user_metadata: {},
        });
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=id')) {
        return jsonResponse([{ id: 'user-1' }]);
      }
      if (url.includes('/rest/v1/users?') && url.includes('select=tier')) {
        return jsonResponse([{ tier: 'free' }]);
      }
      if (decodedUrl.startsWith('https://supabase.test/rest/v1/transfers?')) {
        transferUrls.push(decodedUrl);
        return jsonResponse([
          {
            amount_light: 7,
            app_id: 'app-1',
            function_name: 'deploy',
            reason: 'app_call',
            created_at: '2026-06-06T09:59:00.000Z',
          },
        ]);
      }
      return jsonResponse([]);
    },
  );
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

Deno.test('launch facade: store uses semantic app and platform primitive embeddings', async () => {
  const calls: Array<{
    url: string;
    method?: string;
    body: Record<string, unknown>;
  }> = [];

  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/store?query=deploy&limit=1',
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

Deno.test('launch facade: discover remains a compatibility alias for store', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/discover?query=deploy&limit=1',
        ),
      );
      const body = await response.json() as {
        query?: string | null;
        results: Array<{ id: string }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.query, 'deploy');
      assertEquals(body.results[0].id, 'app-1');
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
