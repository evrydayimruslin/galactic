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
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
          },
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

function persistentRoutineRow(): Record<string, unknown> {
  return {
    id: 'routine-1',
    user_id: 'user-1',
    composer_app_id: 'app-private-1',
    composer_app_slug: 'private-helper',
    template_id: 'monitor',
    template_version: 'v1',
    name: 'Private monitor',
    description: 'Checks the private system',
    intent: 'Watch the private system and report meaningful changes.',
    handler_function: 'inspect',
    status: 'paused',
    schedule: { type: 'interval', every_seconds: 300 },
    config: { secret_value: 'must-not-leak' },
    budget_policy: {
      max_light_per_run: 10,
      max_light_per_day: 50,
      max_light_per_month: 500,
      max_calls_per_run: 12,
    },
    approval_policy: { require_user_approval: true },
    max_concurrency: 1,
    next_run_at: null,
    last_run_at: '2026-07-14T12:00:00.000Z',
    last_success_at: null,
    last_error_at: '2026-07-14T12:00:00.000Z',
    failure_count: 1,
    created_by_trace_id: 'trace-created',
    metadata: {
      secret_value: 'must-not-leak',
      auto_pause: { reason: 'consecutive_failures' },
    },
    created_at: '2026-07-14T10:00:00.000Z',
    updated_at: '2026-07-14T12:00:00.000Z',
    deleted_at: null,
  };
}

function persistentRoutineCapabilityRow(): Record<string, unknown> {
  return {
    id: 'capability-1',
    routine_id: 'routine-1',
    user_id: 'user-1',
    app_id: 'app-private-1',
    app_ref: 'private-helper',
    function_name: 'inspect',
    access: 'read',
    required: true,
    purpose: 'Read current private status',
    approved: false,
    approved_at: null,
    approved_by_user_id: null,
    pricing_snapshot: {},
    constraints: {},
    metadata: {},
    created_at: '2026-07-14T10:00:00.000Z',
    updated_at: '2026-07-14T10:00:00.000Z',
  };
}

function persistentRoutineRunRow(): Record<string, unknown> {
  return {
    id: 'run-1',
    routine_id: 'routine-1',
    user_id: 'user-1',
    status: 'failed',
    trigger: 'scheduled',
    trace_id: 'trace-run',
    started_at: '2026-07-14T11:59:00.000Z',
    completed_at: '2026-07-14T12:00:00.000Z',
    duration_ms: 60_000,
    total_light: 2,
    summary: 'Inbox delivery did not complete.',
    error: { code: 'inbox_unavailable', message: 'must-not-leak' },
    run_config: { secret_value: 'must-not-leak' },
    metadata: { secret_value: 'must-not-leak' },
    created_at: '2026-07-14T11:59:00.000Z',
  };
}

// Legacy-format API token (plaintext column) so the api_token auth path can be
// exercised without reproducing salted-hash material in tests.
const TEST_API_TOKEN = `ul_${'a'.repeat(32)}`;

function apiTokenAuthMock(): typeof fetch {
  return (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ||
      (input instanceof Request ? input.method : 'GET');
    if (url.startsWith('https://supabase.test/rest/v1/user_api_tokens?')) {
      if (method === 'PATCH') {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({
        id: 'token-1',
        user_id: 'user-1',
        token_hash: null,
        token_salt: null,
        plaintext_token: TEST_API_TOKEN,
        scopes: ['*'],
        app_ids: null,
        function_names: null,
        expires_at: null,
      });
    }
    if (url.startsWith('https://supabase.test/rest/v1/users?')) {
      return jsonResponse({
        id: 'user-1',
        email: 'agent@example.com',
        tier: 'free',
        provisional: false,
        last_active_at: null,
      });
    }
    return jsonResponse([]);
  }) as typeof fetch;
}

function byokUserRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'user-1',
    email: 'founder@example.com',
    display_name: 'Founder',
    avatar_url: null,
    tier: 'free',
    country: null,
    featured_app_id: null,
    profile_slug: 'founder',
    byok_enabled: false,
    byok_provider: null,
    byok_keys: null,
    ...overrides,
  };
}

function byokSessionMock(
  profile: Record<string, unknown>,
  balanceLight = 5000,
): typeof fetch {
  return (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://supabase.test/auth/v1/user') {
      return jsonResponse({
        id: 'user-1',
        email: 'founder@example.com',
        user_metadata: {},
      });
    }
    if (url.includes('/rest/v1/users?') && url.includes('byok_keys')) {
      return jsonResponse([profile]);
    }
    if (
      url.includes('/rest/v1/users?') &&
      url.includes('select=balance_light')
    ) {
      return jsonResponse([{ balance_light: balanceLight }]);
    }
    if (url.includes('/rest/v1/users?') && url.includes('select=id')) {
      return jsonResponse([{ id: 'user-1' }]);
    }
    if (url.includes('/rest/v1/users?') && url.includes('select=tier')) {
      return jsonResponse([{ tier: 'free' }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;
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
        'prompt',
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
    // The agent prompt must carry every install path plus first actions.
    const promptInstruction = body.instructions.find((instruction) =>
      instruction.target === 'prompt'
    );
    assertStringIncludes(promptInstruction?.configText || '', 'claude mcp add');
    assertStringIncludes(
      promptInstruction?.configText || '',
      'npx galacticconnection setup --token $GALACTIC_API_KEY',
    );
    assertStringIncludes(promptInstruction?.configText || '', 'gx.discover');
    assertStringIncludes(
      promptInstruction?.configText || '',
      '"Authorization":"Bearer $GALACTIC_API_KEY"',
    );
    // First-contact UX: the prompt must drive the private persistent-Agent
    // conjuring flow and stop at the owner activation boundary.
    assertStringIncludes(
      promptInstruction?.configText || '',
      'one useful full-time Agent',
    );
    assertStringIncludes(
      promptInstruction?.configText || '',
      'explicit review of capabilities',
    );
    assertEquals(
      (promptInstruction?.configText || '').includes('public marketplace'),
      false,
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

Deno.test({
  name:
    'launch facade: notifications route rejects api_token/actor callers (account session only)',
  // The api_token auth path lazily creates a module-cached supabase-js client
  // whose timer outlives the test (same pattern as the BYOK/wallet launch tests).
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLaunchEnv(async () => {
      for (const method of ['GET', 'PATCH'] as const) {
        const response = await handleLaunch(
          new Request('https://ultralight.test/api/launch/notifications', {
            method,
            headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
            ...(method === 'PATCH'
              ? { body: JSON.stringify({ all: true }) }
              : {}),
          }),
        );
        // An api_token (and by the same guard, routine_actor/sandbox_actor) must
        // NOT read the owner's inbox or mark alerts read — that path is
        // gx.notifications, not the website route.
        assertEquals(response.status, 403);
      }
    }, apiTokenAuthMock());
  },
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
          agentMcpUrl: string;
          mcpConfigText: string;
          connectPrompt: string;
          recommendedApiKey: {
            scopes?: string[];
            appIds?: string[];
          };
          agentHandoff: string[];
        } | null;
      };

      assertEquals(response.status, 200);
      assertEquals(body.toolInstall?.selectedToolSlug, 'deploy-helper');
      assertEquals(
        body.toolInstall?.publicToolUrl,
        'https://ultralight.test/agents/deploy-helper',
      );
      assertEquals(
        body.toolInstall?.platformMcpUrl,
        'https://ultralight.test/mcp/platform',
      );
      assertEquals(
        body.toolInstall?.agentMcpUrl,
        'https://ultralight.test/mcp/app-1',
      );
      assertEquals(body.toolInstall?.recommendedApiKey.scopes, [
        'apps:call',
      ]);
      assertEquals(body.toolInstall?.recommendedApiKey.appIds, ['app-1']);
      assertEquals('widgetUrls' in (body.toolInstall || {}), false);
      assertStringIncludes(
        body.toolInstall?.agentHandoff.join('\n') || '',
        'receipt_id',
      );
      // The per-agent prompt installs the dedicated endpoint, named by slug.
      assertStringIncludes(
        body.toolInstall?.connectPrompt || '',
        'claude mcp add --transport http --scope user deploy-helper https://ultralight.test/mcp/app-1',
      );
      assertStringIncludes(
        body.toolInstall?.connectPrompt || '',
        '"Authorization":"Bearer $GALACTIC_API_KEY"',
      );
      assertStringIncludes(
        body.toolInstall?.mcpConfigText || '',
        '"deploy-helper"',
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
      endpoints: Record<string, string | undefined>;
      compatibilityPublicRoutes: string[];
      capabilities: { included: string[]; deferred: string[] };
      policy: {
        access: string;
        activationAuthority: string;
        budgetEnforcement: string;
      };
    };

    assertEquals(response.status, 200);
    assertEquals(body.available, true);
    assertEquals(body.version, 'persistent-agent-mvp-v1');
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
      body.apiRoutes.some((route) => route.includes('/widgets')),
      false,
    );
    assertEquals(
      body.apiRoutes.some((route) => route.includes('/skills')),
      false,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/agents/:id/functions'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes(
        'POST /api/launch/agents/:id/functions/:functionName/run',
      ),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/agents/:id/caller-permissions'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes(
        'PATCH /api/launch/agents/:id/caller-permissions',
      ),
      true,
    );
    assertEquals(body.endpoints.apiKeys, '/api/launch/api-keys');
    assertEquals(body.endpoints.byok, '/api/launch/byok');
    assertEquals(
      body.endpoints.inferenceOptions,
      '/api/launch/inference-options',
    );
    assertEquals(body.apiRoutes.includes('GET /api/launch/byok'), true);
    assertEquals(
      body.apiRoutes.includes('PUT /api/launch/byok/:provider'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('DELETE /api/launch/byok/:provider'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('POST /api/launch/byok/primary'),
      true,
    );
    assertEquals(
      body.apiRoutes.includes('GET /api/launch/inference-options'),
      true,
    );
    assertEquals(body.endpoints.widgetRender, undefined);
    assertEquals(body.endpoints.widgetDetail, undefined);
    assertEquals(body.endpoints.toolSkills, undefined);
    assertEquals(body.endpoints.skillPull, undefined);
    assertEquals(
      body.endpoints.agentFunctions,
      '/api/launch/agents/{id}/functions',
    );
    assertEquals(
      body.endpoints.functionRun,
      '/api/launch/agents/{id}/functions/{functionName}/run',
    );
    assertEquals(
      body.endpoints.callerPermissions,
      '/api/launch/agents/{id}/caller-permissions',
    );
    assertEquals(
      body.endpoints.walletTopUpQuote,
      '/api/launch/wallet/topup/quote?amount_credits=2500&method=card',
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
      '/api/launch/wallet/earnings?agent={agentId}&limit=25&cursor={cursor}',
    );
    assertEquals(body.policy.access, 'private_owner_only');
    assertEquals(body.policy.activationAuthority, 'account_session');
    assertEquals(body.policy.budgetEnforcement, 'hard_pre_execution');
    assertEquals(body.capabilities.deferred.includes('marketplace'), true);
    assertEquals(body.capabilities.included.includes('credits_balance'), true);
    assertEquals(body.capabilities.included.includes('full_time_routines'), true);
    assertEquals(body.capabilities.included.includes('byok'), true);
    assertEquals(body.capabilities.included.includes('credits_wallet'), false);
    assertEquals(body.capabilities.deferred.includes('byok'), false);
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
    assertEquals(Boolean(spec.paths['/api/launch/byok']), true);
    assertEquals(Boolean(spec.paths['/api/launch/byok/{provider}']), true);
    assertEquals(Boolean(spec.paths['/api/launch/byok/primary']), true);
    assertEquals(Boolean(spec.paths['/api/launch/inference-options']), true);
    assertEquals(
      Object.keys(spec.paths).some((path) => path.includes('/widgets')),
      false,
    );
    assertEquals(
      Object.keys(spec.paths).some((path) => path.includes('/skills')),
      false,
    );
    assertEquals(Boolean(spec.paths['/api/launch/agents/{id}/functions']), true);
    assertEquals(
      Boolean(
        spec.paths['/api/launch/agents/{id}/functions/{functionName}/run'],
      ),
      true,
    );
    assertEquals(
      Boolean(spec.paths['/api/launch/agents/{id}/caller-permissions']),
      true,
    );
    assertEquals(Boolean(spec.paths['/api/launch/status']), true);
    assertEquals(Boolean(spec.paths['/mcp/platform']), true);
    assertEquals(Boolean(spec.components?.securitySchemes?.bearerAuth), true);
    assertEquals(Boolean(spec.components?.schemas?.ApiKeySummary), true);
    assertEquals(
      Boolean(spec.components?.schemas?.CallerFunctionPermissions),
      true,
    );
    assertEquals(Boolean(spec.components?.schemas?.TrustCard), true);
    assertEquals(
      Object.keys(spec.components?.schemas || {}).some((name) =>
        name.includes('Widget') || name.includes('Skill')
      ),
      false,
    );
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
    assertEquals(Boolean(spec.components?.schemas?.ByokSummary), true);
    assertEquals(Boolean(spec.components?.schemas?.ByokProviderOption), true);
    assertEquals(Boolean(spec.components?.schemas?.ByokUpsertRequest), true);
    assertEquals(Boolean(spec.components?.schemas?.ByokMutation), true);
    assertEquals(Boolean(spec.components?.schemas?.InferenceOptions), true);
    assertEquals(
      spec['x-launch-scope']?.deferredCapabilities?.includes('marketplace'),
      true,
    );
    assertEquals(
      spec['x-launch-scope']?.compatibilityPublicRoutes?.includes('/discover'),
      true,
    );
  });
});

Deno.test('launch facade: widget and skill endpoints are removed', async () => {
  await withLaunchEnv(async () => {
    const removedGetEndpoints = [
      '/api/launch/tools/deploy-helper/widgets',
      '/api/launch/tools/deploy-helper/widgets/ops',
      '/api/launch/tools/deploy-helper/skills',
    ];
    for (const endpoint of removedGetEndpoints) {
      const response = await handleLaunch(
        new Request(`https://ultralight.test${endpoint}`),
      );
      const body = await response.json() as { error?: string };

      assertEquals(response.status, 404, endpoint);
      assertEquals(body.error, 'Launch endpoint not found', endpoint);
    }

    const removedPostEndpoints = [
      '/api/launch/tools/deploy-helper/widgets/ops/render',
      '/api/launch/tools/deploy-helper/skills/context/pull',
    ];
    for (const endpoint of removedPostEndpoints) {
      const response = await handleLaunch(
        new Request(`https://ultralight.test${endpoint}`, { method: 'POST' }),
      );
      await response.body?.cancel();

      assertEquals(response.status, 405, endpoint);
    }
  });
});

Deno.test('launch facade: public slug lookups avoid uuid id comparisons', async () => {
  await withLaunchEnv(
    async () => {
      const endpoints = [
        '/api/launch/tools/deploy-helper',
        '/api/launch/tools/deploy-helper/functions',
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

function interfaceTestApp(): Record<string, unknown> {
  const app = launchPermissionTestApp();
  const manifest = app.manifest as Record<string, unknown>;
  manifest.interfaces = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      description: 'Live overview',
      entry: 'interfaces/dashboard.html',
      // ghostFunction is not a manifest function — must be pruned from the
      // exposed bridge allowlist.
      functions: ['deploy', 'ghostFunction'],
      min_height: 320,
      hash: 'a'.repeat(64),
    },
    {
      id: 'unstamped',
      label: 'Unstamped',
      entry: 'interfaces/unstamped.html',
      functions: ['deploy'],
      // No server-stamped hash (pre-PR2 manifest / GPU upload): nothing the
      // sandbox worker can serve, so it must not be exposed.
    },
  ];
  return app;
}

function interfaceTestFetchMock(
  app: Record<string, unknown>,
): typeof fetch {
  return ((input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
      return Promise.resolve(jsonResponse([app]));
    }
    if (url.startsWith('https://supabase.test/rest/v1/users?')) {
      return Promise.resolve(jsonResponse([
        { id: 'owner-1', display_name: 'Ada', profile_slug: 'ada', avatar_url: null },
      ]));
    }
    return Promise.resolve(jsonResponse([]));
  }) as typeof fetch;
}

Deno.test('launch facade: agent detail exposes hash-stamped interfaces with pruned allowlists', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/agents/deploy-helper'),
      );
      const body = await response.json() as {
        agent?: { interfaces?: unknown[] };
        tool?: { interfaces?: unknown[] };
        error?: string;
      };

      assertEquals(response.status, 200, body.error || '');
      assertEquals(body.agent?.interfaces, [
        {
          id: 'dashboard',
          label: 'Dashboard',
          description: 'Live overview',
          url: `https://interfaces.test/i/app-1/${'a'.repeat(64)}`,
          functions: ['deploy'],
          minHeight: 320,
        },
      ]);
      // Deprecated alias carries the same payload.
      assertEquals(body.tool?.interfaces, body.agent?.interfaces);
    },
    interfaceTestFetchMock(interfaceTestApp()),
    { INTERFACE_SANDBOX_BASE_URL: 'https://interfaces.test/' },
  );
});

Deno.test('launch facade: interfaces fail closed without a sandbox base URL', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/agents/deploy-helper'),
      );
      const body = await response.json() as {
        agent?: { interfaces?: unknown };
      };

      assertEquals(response.status, 200);
      assertEquals(body.agent?.interfaces, undefined);
    },
    interfaceTestFetchMock(interfaceTestApp()),
    { INTERFACE_SANDBOX_BASE_URL: undefined },
  );
});

Deno.test('launch facade: agents without interfaces omit the field', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/agents/deploy-helper'),
      );
      const body = await response.json() as {
        agent?: { interfaces?: unknown };
      };

      assertEquals(response.status, 200);
      assertEquals(body.agent?.interfaces, undefined);
    },
    interfaceTestFetchMock(launchPermissionTestApp()),
    { INTERFACE_SANDBOX_BASE_URL: 'https://interfaces.test' },
  );
});

Deno.test('launch facade: owners can preview private tools', async () => {
  await withLaunchEnv(
    async () => {
      const endpoints = [
        '/api/launch/tools/private-helper',
        '/api/launch/tools/private-helper/functions',
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
          tool?: { relationship?: string; slug?: string };
        };

        assertEquals(response.status, 200, `${endpoint}: ${body.error || ''}`);
        assertEquals(body.tool?.slug, 'private-helper');
        assertEquals(body.tool?.relationship, 'owner');
        if (endpoint.endsWith('/functions')) {
          assertEquals(
            body.functions?.map((entry) => entry.name),
            ['deploy', 'inspect', 'widget_ops_data', 'widget_ops_ui'],
          );
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

Deno.test('launch facade: owner routine overview is live, bounded, and secret-free', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/agents/private-helper/routine',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as {
        routine?: {
          mission?: string;
          intervalSeconds?: number;
          budgets?: Record<string, number>;
          capabilities?: Array<{ id: string; approved: boolean }>;
          blockers?: Array<{ code: string; capabilityIds?: string[] }>;
          autoPauseReason?: string | null;
          recentRuns?: Array<{ errorCode?: string | null }>;
        } | null;
      };

      assertEquals(response.status, 200);
      assertEquals(
        body.routine?.mission,
        'Watch the private system and report meaningful changes.',
      );
      assertEquals(body.routine?.intervalSeconds, 300);
      assertEquals(body.routine?.budgets, {
        maxLightPerRun: 10,
        maxLightPerDay: 50,
        maxLightPerMonth: 500,
        maxCallsPerRun: 12,
      });
      assertEquals(body.routine?.capabilities, [{
        id: 'capability-1',
        appId: 'app-private-1',
        appRef: 'private-helper',
        functionName: 'inspect',
        access: 'read',
        required: true,
        purpose: 'Read current private status',
        approved: false,
        approvedAt: null,
      }]);
      assertEquals(body.routine?.blockers?.[0]?.code, 'pending_required_capabilities');
      assertEquals(body.routine?.blockers?.[0]?.capabilityIds, ['capability-1']);
      assertEquals(body.routine?.autoPauseReason, 'consecutive_failures');
      assertEquals(body.routine?.recentRuns?.[0]?.errorCode, 'inbox_unavailable');
      const serialized = JSON.stringify(body);
      assertEquals(serialized.includes('must-not-leak'), false);
      assertEquals(serialized.includes('run_config'), false);
      assertEquals(serialized.includes('metadata'), false);
      assertEquals(serialized.includes('secret_value'), false);
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
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        return jsonResponse([privateOwnerTestApp()]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/user_routines?')) {
        return new URL(url).searchParams.get('select') === 'id'
          ? jsonResponse([{ id: 'routine-1' }])
          : jsonResponse([persistentRoutineRow()]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/routine_capabilities?')) {
        return jsonResponse([persistentRoutineCapabilityRow()]);
      }
      if (
        url.startsWith('https://supabase.test/rest/v1/routine_dashboard_bindings?')
      ) {
        return jsonResponse([]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/routine_runs?')) {
        return jsonResponse([persistentRoutineRunRow()]);
      }
      return jsonResponse([]);
    },
  );
});

Deno.test('launch facade: routine patch persists only mission, interval, and finite ceilings', async () => {
  let routine = persistentRoutineRow();
  let routinePatch: Record<string, unknown> | null = null;
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/agents/private-helper/routine',
          {
            method: 'PATCH',
            headers: {
              Authorization: 'Bearer browser-session-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              mission: 'Check the private system every ten minutes.',
              intervalSeconds: 600,
              budgets: {
                maxLightPerRun: 8,
                maxLightPerDay: 40,
                maxLightPerMonth: 400,
                maxCallsPerRun: 10,
              },
            }),
          },
        ),
      );
      const body = await response.json() as {
        routine?: { mission?: string; intervalSeconds?: number } | null;
      };

      assertEquals(response.status, 200);
      assertEquals(body.routine?.mission, 'Check the private system every ten minutes.');
      assertEquals(body.routine?.intervalSeconds, 600);
      assertEquals(routinePatch?.intent, 'Check the private system every ten minutes.');
      assertEquals(routinePatch?.schedule, { type: 'interval', every_seconds: 600 });
      assertEquals(routinePatch?.budget_policy, {
        max_light_per_run: 8,
        max_light_per_day: 40,
        max_light_per_month: 400,
        max_calls_per_run: 10,
      });
      assertEquals('metadata' in (routinePatch || {}), false);
      assertEquals('config' in (routinePatch || {}), false);
      assertEquals('status' in (routinePatch || {}), false);
    },
    async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
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
      if (url.startsWith('https://supabase.test/rest/v1/apps?')) {
        return jsonResponse([privateOwnerTestApp()]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/user_routines?')) {
        if (method === 'PATCH') {
          routinePatch = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
          routine = { ...routine, ...routinePatch };
          return jsonResponse([routine]);
        }
        return new URL(url).searchParams.get('select') === 'id'
          ? jsonResponse([{ id: 'routine-1' }])
          : jsonResponse([routine]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/routine_capabilities?')) {
        return jsonResponse([persistentRoutineCapabilityRow()]);
      }
      if (
        url.startsWith('https://supabase.test/rest/v1/routine_dashboard_bindings?')
      ) {
        return jsonResponse([]);
      }
      if (url.startsWith('https://supabase.test/rest/v1/routine_runs?')) {
        return jsonResponse([]);
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
      assertEquals(body.error, 'Agent not found');
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

Deno.test('launch facade: tool functions expose pricing, schemas, and policy', async () => {
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
          annotations?: {
            readOnlyHint?: boolean;
            destructiveHint?: boolean;
          } | null;
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
          agentPermission?: { policy: string; source: string } | null;
        }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.tool.slug, 'deploy-helper');
      assertEquals('widgets' in body.tool, false);
      assertEquals(body.functions.map((entry) => entry.name), [
        'deploy',
        'inspect',
        'widget_ops_data',
        'widget_ops_ui',
      ]);
      assertEquals(
        body.functions.some((entry) => 'widgetIds' in entry),
        false,
      );
      const deploy = body.functions[0];
      assertEquals(deploy.description, 'Deploy code');
      assertEquals(Boolean(deploy.inputSchema?.properties?.repo), true);
      assertEquals(deploy.inputSchema?.required, ['repo']);
      assertEquals(deploy.outputSchema?.type, 'object');
      assertEquals(deploy.annotations?.readOnlyHint, false);
      assertEquals(deploy.annotations?.destructiveHint, true);
      assertEquals(deploy.pricing?.defaultCallPrice?.light, 3);
      assertEquals(deploy.accessPolicy?.configured, true);
      assertEquals(deploy.accessPolicy?.mode, 'module');
      assertEquals(deploy.accessPolicy?.module, 'policy.ts');
      assertEquals(deploy.accessPolicy?.exportName, 'planAccess');
      assertEquals(deploy.accessPolicy?.execution, 'runtime_policy');
      assertEquals(deploy.agentPermission?.policy, 'always');
      assertEquals(deploy.agentPermission?.source, 'explicit');
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

Deno.test('launch facade: wallet top-up quote accepts amount_credits and emits both aliases', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/wallet/topup/quote?amount_credits=10000&method=ach',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as {
        quote: {
          method: string;
          methodLabel: string;
          amountCredits: number;
          amountLight: number;
          creditsPerDollar: number;
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
      assertEquals(body.quote.amountCredits, 10000);
      assertEquals(body.quote.amountLight, 10000);
      assertEquals(body.quote.creditsPerDollar, 100);
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
        items: Array<{
          id: string;
          amount: { credits: number; light: number; display: string };
          createdAt?: string | null;
        }>;
        page: { limit: number; hasMore: boolean; nextCursor?: string | null };
      };

      assertEquals(response.status, 200);
      assertEquals(body.kind, 'transactions');
      assertEquals(body.items.map((item) => item.id), ['tx-1', 'tx-2']);
      assertEquals(body.items[0].amount, {
        credits: 1000,
        light: 1000,
        display: '1,000 credits',
      });
      assertEquals(body.items[1].amount.credits, body.items[1].amount.light);
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
          value: { credits: number; light: number; display: string };
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
        credits: 123,
        light: 123,
        display: '123 credits',
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
      assertEquals('widgets' in body.results[0], false);
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

Deno.test('launch facade: wallet top-up quote still accepts deprecated amount_light', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/wallet/topup/quote?amount_light=2500&method=card',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as {
        quote: { amountCredits: number; amountLight: number };
      };

      assertEquals(response.status, 200);
      assertEquals(body.quote.amountCredits, 2500);
      assertEquals(body.quote.amountLight, 2500);
    },
    byokSessionMock(byokUserRow()),
  );
});

Deno.test({
  name:
    'launch facade: byok and inference endpoints require an account session',
  // The api_token auth path constructs a supabase-js client whose auth
  // auto-refresh interval cannot be stopped from test code.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLaunchEnv(
      async () => {
        const attempts: Array<{ path: string; init?: RequestInit }> = [
          { path: '/api/launch/byok' },
          {
            path: '/api/launch/byok/openrouter',
            init: {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apiKey: 'sk-or-test', validate: false }),
            },
          },
          { path: '/api/launch/byok/openrouter', init: { method: 'DELETE' } },
          {
            path: '/api/launch/byok/primary',
            init: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider: 'openrouter' }),
            },
          },
          { path: '/api/launch/inference-options' },
        ];

        for (const attempt of attempts) {
          const init = attempt.init || {};
          const response = await handleLaunch(
            new Request(`https://ultralight.test${attempt.path}`, {
              ...init,
              headers: {
                ...(init.headers || {}),
                Authorization: `Bearer ${TEST_API_TOKEN}`,
              },
            }),
          );
          const body = await response.json() as { error?: string };

          assertEquals(response.status, 403, attempt.path);
          assertStringIncludes(
            body.error || '',
            'account session',
            attempt.path,
          );
        }
      },
      apiTokenAuthMock(),
    );
  },
});

Deno.test({
  name: 'launch facade: routine lifecycle rejects connected-agent API keys',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLaunchEnv(
      async () => {
        const attempts: Array<{ method: string; body?: unknown }> = [
          { method: 'GET' },
          {
            method: 'PATCH',
            body: { mission: 'Silently widen authority' },
          },
          {
            method: 'POST',
            body: { action: 'activate' },
          },
        ];
        for (const attempt of attempts) {
          const suffix = attempt.method === 'POST' ? '/actions' : '';
          const response = await handleLaunch(
            new Request(
              `https://ultralight.test/api/launch/agents/private-helper/routine${suffix}`,
              {
                method: attempt.method,
                headers: {
                  Authorization: `Bearer ${TEST_API_TOKEN}`,
                  'Content-Type': 'application/json',
                },
                ...(attempt.body ? { body: JSON.stringify(attempt.body) } : {}),
              },
            ),
          );
          const body = await response.json() as { error?: string };
          assertEquals(response.status, 403, attempt.method);
          assertStringIncludes(body.error || '', 'account session');
        }
      },
      apiTokenAuthMock(),
    );
  },
});

Deno.test('launch facade: byok summary lists providers without key material', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/byok', {
          headers: { Authorization: 'Bearer browser-session-token' },
        }),
      );
      const raw = await response.text();
      const body = JSON.parse(raw) as {
        enabled: boolean;
        primaryProvider: string | null;
        providers: Array<{
          id: string;
          name: string;
          configured: boolean;
          primary: boolean;
          model?: string | null;
          defaultModel?: string | null;
        }>;
      };

      assertEquals(response.status, 200);
      assertEquals(body.enabled, true);
      assertEquals(body.primaryProvider, 'openrouter');
      assertEquals(body.providers.length, 8);
      const openrouter = body.providers.find((p) => p.id === 'openrouter');
      assertEquals(openrouter?.configured, true);
      assertEquals(openrouter?.primary, true);
      assertEquals(openrouter?.model, 'openai/gpt-4o-mini');
      const openai = body.providers.find((p) => p.id === 'openai');
      assertEquals(openai?.configured, false);
      assertEquals(openai?.primary, false);
      // Key material must never leave the server.
      assertEquals(raw.includes('sk-or-secret-key-value'), false);
      assertEquals(raw.includes('encrypted'), false);
    },
    byokSessionMock(byokUserRow({
      byok_enabled: true,
      byok_provider: 'openrouter',
      byok_keys: {
        openrouter: {
          encrypted_key: 'sk-or-secret-key-value',
          model: 'openai/gpt-4o-mini',
          added_at: '2026-06-01T00:00:00.000Z',
        },
      },
    })),
  );
});

Deno.test('launch facade: inference options report credits billing without byok', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/inference-options', {
          headers: { Authorization: 'Bearer browser-session-token' },
        }),
      );
      const body = await response.json() as {
        billingMode: string;
        primaryProvider: string | null;
        configuredProviders: string[];
        credits: {
          spendable: number | null;
          minimumForPlatformInference: number;
          usable: boolean;
          display: string;
        };
      };

      assertEquals(response.status, 200);
      assertEquals(body.billingMode, 'credits');
      assertEquals(body.primaryProvider, null);
      assertEquals(body.configuredProviders, []);
      assertEquals(body.credits.spendable, 5000);
      assertEquals(body.credits.minimumForPlatformInference, 25);
      assertEquals(body.credits.usable, true);
      assertEquals(body.credits.display, '5,000 credits');
    },
    byokSessionMock(byokUserRow(), 5000),
  );
});

Deno.test('launch facade: inference options report byok billing when primary configured', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/inference-options', {
          headers: { Authorization: 'Bearer browser-session-token' },
        }),
      );
      const body = await response.json() as {
        billingMode: string;
        primaryProvider: string | null;
        configuredProviders: string[];
        credits: { spendable: number | null; usable: boolean };
      };

      assertEquals(response.status, 200);
      assertEquals(body.billingMode, 'byok');
      assertEquals(body.primaryProvider, 'openrouter');
      assertEquals(body.configuredProviders, ['openrouter']);
      assertEquals(body.credits.spendable, 0);
      assertEquals(body.credits.usable, false);
    },
    byokSessionMock(
      byokUserRow({
        byok_enabled: true,
        byok_provider: 'openrouter',
        byok_keys: {
          openrouter: {
            encrypted_key: 'sk-or-secret-key-value',
            model: null,
            added_at: '2026-06-01T00:00:00.000Z',
          },
        },
      }),
      0,
    ),
  );
});

function parseJsonBody(
  body: BodyInit | null | undefined,
): Record<string, unknown> {
  if (typeof body !== 'string') return {};
  return JSON.parse(body) as Record<string, unknown>;
}

Deno.test("launch facade: legacy /tools and /agent-permissions paths still serve (rename aliases)", async () => {
  await withLaunchEnv(async () => {
    // Admin route must be reachable on BOTH canonical and legacy paths
    // (regression: the rename once left the admin matcher on the old path,
    // 404ing both forms). Unauthenticated -> 401 proves the handler matched.
    const adminCanonical = await handleLaunch(
      new Request("https://ultralight.test/api/launch/admin/agents/app-1"),
    );
    await adminCanonical.body?.cancel();
    assertEquals(adminCanonical.status, 401);

    const adminLegacy = await handleLaunch(
      new Request("https://ultralight.test/api/launch/admin/tools/app-1"),
    );
    await adminLegacy.body?.cancel();
    assertEquals(adminLegacy.status, 401);
  });
});

Deno.test("launch facade: legacy alias block 2", async () => {
  await withLaunchEnv(async () => {
    // Legacy paths must normalize onto canonical handlers: these auth-gated
    // routes return 401 (handler reached), not the route-level 404.
    const legacyRun = await handleLaunch(
      new Request(
        "https://ultralight.test/api/launch/tools/deploy-helper/functions/run_check/run",
        { method: "POST", body: "{}" },
      ),
    );
    await legacyRun.body?.cancel();
    assertEquals(legacyRun.status, 401);

    const legacyPerms = await handleLaunch(
      new Request(
        "https://ultralight.test/api/launch/tools/deploy-helper/agent-permissions",
      ),
    );
    await legacyPerms.body?.cancel();
    assertEquals(legacyPerms.status, 401);

    const canonicalPerms = await handleLaunch(
      new Request(
        "https://ultralight.test/api/launch/agents/deploy-helper/caller-permissions",
      ),
    );
    await canonicalPerms.body?.cancel();
    assertEquals(canonicalPerms.status, 401);
  });
});

// ---------------------------------------------------------------------------
// Phase 4b: cross-Agent grant / wiring / settings facade endpoints.
// ---------------------------------------------------------------------------

function grantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    user_id: 'user-1',
    caller_app_id: 'caller-app-id',
    caller_function: '',
    slot: '',
    target_app_id: 'target-app-id',
    target_function: 'deploy',
    mode: 'call',
    status: 'active',
    monthly_cap_credits: 5000,
    spent_credits_period: 0,
    period_start: '2026-06-01T00:00:00.000Z',
    constraints: {},
    created_by: 'user',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

// Session-auth mock for grant routes: resolves the account session and serves
// agent_function_grants + apps handle joins. No live DB required.
function grantSessionMock(grants: Record<string, unknown>[] = []): typeof fetch {
  return (async (input: Request | URL | string) => {
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
    if (url.includes('/rest/v1/agent_function_grants?')) {
      return jsonResponse(grants);
    }
    if (url.includes('/rest/v1/apps?')) {
      return jsonResponse([
        { id: 'caller-app-id', slug: 'caller', name: 'Caller' },
        { id: 'target-app-id', slug: 'target', name: 'Target' },
      ]);
    }
    return jsonResponse([]);
  }) as typeof fetch;
}

Deno.test({
  name: 'launch facade: grant, wiring, and settings routes require an account session',
  // The api_token auth path constructs a supabase-js client whose auth
  // auto-refresh interval cannot be stopped from test code.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withLaunchEnv(
      async () => {
        const attempts: Array<{ path: string; init?: RequestInit }> = [
          { path: '/api/launch/grants' },
          {
            path: '/api/launch/grants',
            init: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                callerAppId: 'caller-app-id',
                targetAppId: 'target-app-id',
                targetFunction: 'deploy',
              }),
            },
          },
          {
            path: '/api/launch/grants/11111111-1111-4111-8111-111111111111',
            init: {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'revoked' }),
            },
          },
          {
            path: '/api/launch/grants/11111111-1111-4111-8111-111111111111',
            init: { method: 'DELETE' },
          },
          {
            path:
              '/api/launch/grants/11111111-1111-4111-8111-111111111111/approve',
            init: {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            },
          },
          { path: '/api/launch/wiring/targets' },
          { path: '/api/launch/agents/deploy-helper/wiring' },
          { path: '/api/launch/agents/deploy-helper/caller-trust' },
          { path: '/api/launch/settings' },
          {
            path: '/api/launch/settings',
            init: {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentGrantAutoApprove: true }),
            },
          },
        ];

        for (const attempt of attempts) {
          const init = attempt.init || {};
          const response = await handleLaunch(
            new Request(`https://ultralight.test${attempt.path}`, {
              ...init,
              headers: {
                ...(init.headers || {}),
                Authorization: `Bearer ${TEST_API_TOKEN}`,
              },
            }),
          );
          const body = await response.json() as { error?: string };

          assertEquals(response.status, 403, `${attempt.init?.method || 'GET'} ${attempt.path}`);
          assertStringIncludes(
            body.error || '',
            'account session',
            attempt.path,
          );
        }
      },
      apiTokenAuthMock(),
    );
  },
});

Deno.test('launch facade: grants list returns AgentGrantListResponse shape', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/grants', {
          headers: { Authorization: 'Bearer browser-session-token' },
        }),
      );
      const body = await response.json() as {
        grants: Array<{
          id: string;
          status: string;
          targetFunction: string;
          callerApp: { id: string; name: string | null };
          targetApp: { id: string; name: string | null };
        }>;
        generatedAt: string;
      };

      assertEquals(response.status, 200);
      assertEquals(Array.isArray(body.grants), true);
      assertEquals(typeof body.generatedAt, 'string');
      assertEquals(body.grants.length, 1);
      assertEquals(body.grants[0].id, '11111111-1111-4111-8111-111111111111');
      assertEquals(body.grants[0].status, 'active');
      assertEquals(body.grants[0].targetFunction, 'deploy');
      // Agent handles are joined so the UI can render names without N lookups.
      assertEquals(body.grants[0].callerApp.name, 'Caller');
      assertEquals(body.grants[0].targetApp.name, 'Target');
    },
    grantSessionMock([grantRow()]),
  );
});

Deno.test('launch facade: grants status filter rejects unknown values', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request(
          'https://ultralight.test/api/launch/grants?status=bogus',
          { headers: { Authorization: 'Bearer browser-session-token' } },
        ),
      );
      const body = await response.json() as { error?: string };
      assertEquals(response.status, 400);
      assertStringIncludes(body.error || '', 'status must be one of');
    },
    grantSessionMock([grantRow()]),
  );
});

Deno.test('launch facade: settings report the agentic-approval preference', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/settings', {
          headers: { Authorization: 'Bearer browser-session-token' },
        }),
      );
      const body = await response.json() as {
        agentGrantAutoApprove: boolean;
        generatedAt: string;
      };
      assertEquals(response.status, 200);
      assertEquals(typeof body.agentGrantAutoApprove, 'boolean');
      assertEquals(typeof body.generatedAt, 'string');
    },
    (async (input: Request | URL | string) => {
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
      if (
        url.includes('/rest/v1/users?') &&
        url.includes('agent_grant_autoapprove')
      ) {
        return jsonResponse([{ agent_grant_autoapprove: true }]);
      }
      return jsonResponse([]);
    }) as typeof fetch,
  );
});

Deno.test('launch facade: status and openapi advertise grant/wiring routes', async () => {
  await withLaunchEnv(async () => {
    const statusResponse = await handleLaunch(
      new Request('https://ultralight.test/api/launch/status'),
    );
    const status = await statusResponse.json() as {
      apiRoutes: string[];
      endpoints: Record<string, string | undefined>;
    };
    assertEquals(statusResponse.status, 200);
    assertEquals(status.endpoints.grants !== undefined, true);
    assertEquals(status.endpoints.wiring, '/api/launch/agents/{id}/wiring');
    assertEquals(
      status.endpoints.callerTrust,
      '/api/launch/agents/{id}/caller-trust',
    );
    assertEquals(status.endpoints.wiringTargets, '/api/launch/wiring/targets?q={query}');
    assertEquals(status.endpoints.settings, '/api/launch/settings');
    assertEquals(status.apiRoutes.includes('GET /api/launch/grants'), true);
    assertEquals(status.apiRoutes.includes('POST /api/launch/grants'), true);
    assertEquals(
      status.apiRoutes.includes('POST /api/launch/grants/:id/approve'),
      true,
    );
    assertEquals(
      status.apiRoutes.includes('DELETE /api/launch/grants/:id'),
      true,
    );
    assertEquals(
      status.apiRoutes.includes('GET /api/launch/agents/:id/wiring'),
      true,
    );
    assertEquals(
      status.apiRoutes.includes('GET /api/launch/agents/:id/caller-trust'),
      true,
    );
    assertEquals(status.apiRoutes.includes('GET /api/launch/settings'), true);
    assertEquals(status.apiRoutes.includes('PATCH /api/launch/settings'), true);

    const openapiResponse = await handleLaunch(
      new Request('https://ultralight.test/api/launch/openapi.json'),
    );
    const spec = await openapiResponse.json() as {
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    assertEquals(openapiResponse.status, 200);
    assertEquals(Boolean(spec.paths['/api/launch/grants']), true);
    assertEquals(Boolean(spec.paths['/api/launch/grants/{id}']), true);
    assertEquals(Boolean(spec.paths['/api/launch/grants/{id}/approve']), true);
    assertEquals(Boolean(spec.paths['/api/launch/agents/{id}/wiring']), true);
    assertEquals(
      Boolean(spec.paths['/api/launch/agents/{id}/caller-trust']),
      true,
    );
    assertEquals(Boolean(spec.paths['/api/launch/wiring/targets']), true);
    assertEquals(Boolean(spec.paths['/api/launch/settings']), true);
    assertEquals(
      Boolean(spec.components?.schemas?.AgentGrantSummary),
      true,
    );
    assertEquals(
      Boolean(spec.components?.schemas?.AgentGrantListResponse),
      true,
    );
    assertEquals(Boolean(spec.components?.schemas?.AgentWiringView), true);
    assertEquals(
      Boolean(spec.components?.schemas?.AgentCallerTrustSummary),
      true,
    );
  });
});

// ── Durable async job polling (GET /api/launch/jobs/:id) ──

function jobSessionMock(rows: unknown[]): typeof fetch {
  return (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://supabase.test/auth/v1/user') {
      return jsonResponse({
        id: 'user-1',
        email: 'founder@example.com',
        user_metadata: {},
      });
    }
    if (url.includes('/rest/v1/async_jobs?')) {
      // The handler must scope the read to the session user.
      assertStringIncludes(url, 'user_id=eq.user-1');
      return jsonResponse(rows);
    }
    if (url.includes('/rest/v1/users?')) {
      return jsonResponse([{ id: 'user-1' }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;
}

const JOB_ID = '7f1e6f0a-2b3c-4d5e-8f90-123456789abc';

Deno.test('launch facade: job status requires authentication', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request(`https://ultralight.test/api/launch/jobs/${JOB_ID}`),
    );
    assertEquals(response.status, 401);
  }, jobSessionMock([]));
});

Deno.test('launch facade: job status rejects non-uuid ids', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request('https://ultralight.test/api/launch/jobs/not-a-uuid', {
        headers: { Authorization: 'Bearer browser-session-token' },
      }),
    );
    const body = await response.json() as { error?: string };
    assertEquals(response.status, 400);
    assertStringIncludes(body.error || '', 'Invalid job id');
  }, jobSessionMock([]));
});

Deno.test('launch facade: job status 404s for unknown (or other-user) jobs', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request(`https://ultralight.test/api/launch/jobs/${JOB_ID}`, {
        headers: { Authorization: 'Bearer browser-session-token' },
      }),
    );
    assertEquals(response.status, 404);
  }, jobSessionMock([]));
});

Deno.test('launch facade: completed job returns the LaunchJobStatusResponse shape', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request(`https://ultralight.test/api/launch/jobs/${JOB_ID}`, {
        headers: { Authorization: 'Bearer browser-session-token' },
      }),
    );
    const body = await response.json() as Record<string, unknown>;
    assertEquals(response.status, 200);
    assertEquals(body.jobId, JOB_ID);
    assertEquals(body.status, 'completed');
    assertEquals(body.result, { answer: 42 });
    assertEquals(body.error, null);
    assertEquals(body.aiCostCredits, 1.5);
    assertEquals(body.executionId, 'exec-1');
    assertEquals(typeof body.generatedAt, 'string');
  }, jobSessionMock([{
    id: JOB_ID,
    status: 'completed',
    result: { answer: 42 },
    result_r2_key: null,
    error: null,
    duration_ms: 1234,
    ai_cost_light: 1.5,
    execution_id: 'exec-1',
    created_at: '2026-06-11T00:00:00Z',
    completed_at: '2026-06-11T00:01:00Z',
  }]));
});

Deno.test('launch facade: queued job reports queued (never failed) with no result/error', async () => {
  await withLaunchEnv(async () => {
    const response = await handleLaunch(
      new Request(`https://ultralight.test/api/launch/jobs/${JOB_ID}`, {
        headers: { Authorization: 'Bearer browser-session-token' },
      }),
    );
    const body = await response.json() as Record<string, unknown>;
    assertEquals(response.status, 200);
    assertEquals(body.status, 'queued');
    assertEquals(body.result, null);
    assertEquals(body.error, null);
  }, jobSessionMock([{
    id: JOB_ID,
    status: 'queued',
    result: null,
    result_r2_key: null,
    error: null,
    duration_ms: null,
    ai_cost_light: 0,
    execution_id: 'exec-1',
    created_at: '2026-06-11T00:00:00Z',
    completed_at: null,
  }]));
});

// ---- Library folders (Phase 2) ---------------------------------------------

const FOLDER_APP_ID = '11111111-1111-4111-8111-111111111111';
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';

type CapturedFolderReq = { url: string; method: string; body: unknown };

function folderSessionMock(
  captured: CapturedFolderReq[],
  opts: {
    existingFolders?: Array<{ id: string; name: string; position: number }>;
    folderPostStatus?: number;
    memberPostStatus?: number;
  } = {},
): typeof fetch {
  return (async (input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ||
      (input instanceof Request ? input.method : 'GET');
    const rawBody = init?.body;
    const parsedBody = typeof rawBody === 'string' ? JSON.parse(rawBody) : null;
    if (url === 'https://supabase.test/auth/v1/user') {
      return jsonResponse({
        id: 'user-1',
        email: 'founder@example.com',
        user_metadata: {},
      });
    }
    if (url.includes('/rest/v1/users?')) {
      return jsonResponse([{
        id: 'user-1',
        email: 'founder@example.com',
        tier: 'free',
        provisional: false,
        last_active_at: null,
      }]);
    }
    if (url.startsWith('https://supabase.test/rest/v1/library_folders')) {
      captured.push({ url, method, body: parsedBody });
      if (method === 'GET') return jsonResponse(opts.existingFolders ?? []);
      if (method === 'POST') {
        return jsonResponse([{
          id: FOLDER_ID,
          name: (parsedBody as { name?: string })?.name ?? 'Folder',
          position: (parsedBody as { position?: number })?.position ?? 0,
        }], opts.folderPostStatus ?? 201);
      }
      if (method === 'PATCH') {
        return jsonResponse([{ id: FOLDER_ID, name: 'Renamed', position: 0 }]);
      }
      if (method === 'DELETE') return jsonResponse([{ id: FOLDER_ID }]);
    }
    if (
      url.startsWith('https://supabase.test/rest/v1/library_folder_members')
    ) {
      captured.push({ url, method, body: parsedBody });
      if (method === 'GET') return jsonResponse([]);
      return jsonResponse([], opts.memberPostStatus ?? 200);
    }
    return jsonResponse([]);
  }) as typeof fetch;
}

function browserFolderRequest(
  path: string,
  method: string,
  body?: unknown,
): Request {
  return new Request(`https://ultralight.test${path}`, {
    method,
    headers: {
      Authorization: 'Bearer browser-session-token',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test('launch folders: create stamps the session owner, ignoring the body', async () => {
  const captured: CapturedFolderReq[] = [];
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        browserFolderRequest('/api/launch/folders', 'POST', {
          scope: 'owned',
          name: 'Tools',
          owner_user_id: 'attacker-user',
        }),
      );
      assertEquals(response.status, 201);
      const post = captured.find((c) => c.method === 'POST');
      const body = post?.body as Record<string, unknown> | undefined;
      // The owner is taken from the authenticated session, never the request body.
      assertEquals(body?.owner_user_id, 'user-1');
      assertEquals(body?.scope, 'owned');
      assertEquals(body?.name, 'Tools');
    },
    folderSessionMock(captured),
  );
});

Deno.test('launch folders: organizing requires an account session', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        new Request('https://ultralight.test/api/launch/folders', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ scope: 'owned', name: 'Tools' }),
        }),
      );
      assertEquals(response.status, 403);
    },
    apiTokenAuthMock(),
  );
});

Deno.test('launch folders: move and uncategorize stay owner-scoped', async () => {
  const captured: CapturedFolderReq[] = [];
  await withLaunchEnv(
    async () => {
      const move = await handleLaunch(
        browserFolderRequest('/api/launch/folders/members', 'PUT', {
          scope: 'owned',
          app_id: FOLDER_APP_ID,
          folder_id: FOLDER_ID,
        }),
      );
      assertEquals(move.status, 200);
      const post = captured.find((c) => c.method === 'POST');
      assertEquals(
        (post?.body as Record<string, unknown>)?.owner_user_id,
        'user-1',
      );

      const clear = await handleLaunch(
        browserFolderRequest('/api/launch/folders/members', 'PUT', {
          scope: 'owned',
          app_id: FOLDER_APP_ID,
          folder_id: null,
        }),
      );
      assertEquals(clear.status, 200);
      const del = captured.find((c) => c.method === 'DELETE');
      assertStringIncludes(del?.url ?? '', 'owner_user_id=eq.user-1');
      assertStringIncludes(del?.url ?? '', `app_id=eq.${FOLDER_APP_ID}`);
    },
    folderSessionMock(captured),
  );
});

Deno.test('launch folders: rename and delete filter by owner in the query', async () => {
  const captured: CapturedFolderReq[] = [];
  await withLaunchEnv(
    async () => {
      const rename = await handleLaunch(
        browserFolderRequest(`/api/launch/folders/${FOLDER_ID}`, 'PATCH', {
          name: 'Renamed',
        }),
      );
      assertEquals(rename.status, 200);
      const patch = captured.find((c) => c.method === 'PATCH');
      assertStringIncludes(patch?.url ?? '', 'owner_user_id=eq.user-1');
      assertStringIncludes(patch?.url ?? '', `id=eq.${FOLDER_ID}`);

      const del = await handleLaunch(
        browserFolderRequest(`/api/launch/folders/${FOLDER_ID}`, 'DELETE'),
      );
      assertEquals(del.status, 200);
      const delReq = captured.find((c) => c.method === 'DELETE');
      assertStringIncludes(delReq?.url ?? '', 'owner_user_id=eq.user-1');
      assertStringIncludes(delReq?.url ?? '', `id=eq.${FOLDER_ID}`);
    },
    folderSessionMock(captured),
  );
});

Deno.test('launch folders: a non-uuid folder id is a 404, not a query', async () => {
  await withLaunchEnv(
    async () => {
      const response = await handleLaunch(
        browserFolderRequest('/api/launch/folders/not-a-uuid', 'PATCH', {
          name: 'x',
        }),
      );
      assertEquals(response.status, 404);
    },
    folderSessionMock([]),
  );
});
