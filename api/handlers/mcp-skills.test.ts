import { assertEquals } from 'https://deno.land/std@0.210.0/assert/assert_equals.ts';
import { assertStringIncludes } from 'https://deno.land/std@0.210.0/assert/assert_string_includes.ts';

import { handleMcp } from './mcp.ts';

const APP_ID = 'skill-app';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CALLER_ID = '22222222-2222-4222-8222-222222222222';
const CALLER_TOKEN = 'caller-token';
const FULL_SKILL_BODY = 'FULL_SKILL_CONTEXT_BODY';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rpcRequest(method: string, params?: unknown) {
  return { jsonrpc: '2.0', id: 'test-rpc', method, params };
}

function mcpRequest(method: string, params?: unknown): Request {
  return new Request(`https://ultralight.test/mcp/${APP_ID}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CALLER_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rpcRequest(method, params)),
  });
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function installMcpSkillHarness(): () => void {
  const originalFetch = globalThis.fetch;
  const originalEnv = globalThis.__env
    ? { ...globalThis.__env as Record<string, unknown> }
    : undefined;

  const app = {
    id: APP_ID,
    owner_id: OWNER_ID,
    slug: 'paid-skill',
    name: 'Paid Skill',
    description: 'Summarizes launch billing behavior.',
    visibility: 'public',
    runtime: 'deno',
    app_type: 'mcp',
    storage_key: 'apps/paid-skill',
    skills_md: `# Paid Skill\n\n${FULL_SKILL_BODY}`,
    manifest: JSON.stringify({
      name: 'Paid Skill',
      version: '1.0.0',
      type: 'mcp',
      entry: { functions: 'index.ts' },
      functions: {
        summarize_billing: {
          description: 'Summarize launch billing behavior.',
          parameters: {},
        },
      },
      // Legacy manifest skill declarations are still valid manifest input,
      // but no longer gate skills_md behind a monetized preview.
      skills: {
        context: {
          name: 'Launch billing context',
          description: 'Full launch billing workflow context.',
          semantic_description: 'Paid context for launch billing agents.',
          resource: 'skills.md',
          format: 'markdown',
        },
      },
    }),
    // Legacy monetized skill-pull pricing must no longer gate documentation.
    pricing_config: {
      default_price_light: 0,
      default_skill_pull_price_light: 25,
      default_free_skill_pulls: 0,
    },
    rate_limit_config: null,
  };
  const user = {
    id: CALLER_ID,
    email: 'caller@example.com',
    display_name: 'Caller',
    avatar_url: null,
    tier: 'pro',
    country: null,
    featured_app_id: null,
    profile_slug: null,
    byok_enabled: false,
    byok_provider: null,
    byok_keys: null,
  };

  globalThis.__env = {
    ...(originalEnv || {}),
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    SUPABASE_ANON_KEY: 'anon-key',
    BASE_URL: 'https://ultralight.test',
    ENVIRONMENT: 'test',
  } as typeof globalThis.__env;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url || String(input));
    const method = init?.method || request?.method || 'GET';

    if (url.pathname === '/auth/v1/user') {
      return jsonResponse({
        id: CALLER_ID,
        email: 'caller@example.com',
        user_metadata: {},
      });
    }

    if (url.pathname === '/rest/v1/users') {
      return jsonResponse([user]);
    }

    if (url.pathname === '/rest/v1/pending_permissions') {
      return jsonResponse([]);
    }

    if (url.pathname === '/rest/v1/apps' && method === 'GET') {
      return jsonResponse([app]);
    }

    if (url.pathname === '/rest/v1/rpc/check_rate_limit') {
      return jsonResponse(true);
    }

    if (url.pathname === '/rest/v1/rpc/increment_weekly_calls') {
      return jsonResponse([{ current_count: 1 }]);
    }

    throw new Error(`Unexpected ${method} ${url.pathname}${url.search}`);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
    if (originalEnv) {
      globalThis.__env = originalEnv as typeof globalThis.__env;
    }
  };
}

Deno.test('MCP tools/list no longer exposes skill SDK tools', async () => {
  const cleanup = installMcpSkillHarness();
  try {
    const toolsPayload = await parseJson(
      await handleMcp(mcpRequest('tools/list'), APP_ID),
    );
    const tools = (toolsPayload.result as Record<string, unknown>)
      .tools as Array<{ name: string }>;
    const toolNames = tools.map((tool) => tool.name);

    assertEquals(toolNames.includes('ultralight.getSkills'), false);
    assertEquals(toolNames.includes('ultralight.pullSkill'), false);
    // App functions and the rest of the SDK surface remain available.
    assertEquals(toolNames.includes('paid-skill_summarize_billing'), true);
    assertEquals(toolNames.includes('ultralight.store'), true);
  } finally {
    cleanup();
  }
});

Deno.test('MCP serves full skills_md for free with no preview gating', async () => {
  const cleanup = installMcpSkillHarness();
  try {
    // initialize: skills_md is always inlined in full.
    const initPayload = await parseJson(
      await handleMcp(mcpRequest('initialize'), APP_ID),
    );
    const instructions = ((initPayload.result as Record<string, unknown>)
      .instructions || '') as string;
    assertStringIncludes(instructions, FULL_SKILL_BODY);
    assertEquals(instructions.includes('ultralight.pullSkill'), false);
    assertEquals(instructions.includes('ultralight.getSkills'), false);

    // resources/read skills.md: full content, no payment required.
    const resourcePayload = await parseJson(
      await handleMcp(
        mcpRequest('resources/read', {
          uri: `galactic://app/${APP_ID}/skills.md`,
        }),
        APP_ID,
      ),
    );
    const resourceText = ((resourcePayload.result as Record<string, unknown>)
      .contents as Array<{ text?: string }>)[0].text || '';
    assertStringIncludes(resourceText, FULL_SKILL_BODY);
    assertEquals(resourceText.includes('ultralight.pullSkill'), false);

    // resources/read skills.json: discovery payload no longer references
    // pull tooling or pricing.
    const discoveryPayload = await parseJson(
      await handleMcp(
        mcpRequest('resources/read', {
          uri: `galactic://app/${APP_ID}/skills.json`,
        }),
        APP_ID,
      ),
    );
    const discoveryText = ((discoveryPayload.result as Record<string, unknown>)
      .contents as Array<{ text?: string }>)[0].text || '';
    assertEquals(discoveryText.includes('ultralight.pullSkill'), false);
    const discovery = JSON.parse(discoveryText) as Record<string, unknown>;
    assertEquals(discovery.app_id, APP_ID);
    assertEquals(
      discovery.skills_md_resource_uri,
      `galactic://app/${APP_ID}/skills.md`,
    );
  } finally {
    cleanup();
  }
});

Deno.test('MCP tools/call rejects removed skill SDK tools', async () => {
  const cleanup = installMcpSkillHarness();
  try {
    for (const name of ['ultralight.getSkills', 'ultralight.pullSkill']) {
      const payload = await parseJson(
        await handleMcp(
          mcpRequest('tools/call', { name, arguments: {} }),
          APP_ID,
        ),
      );
      const rpcError = payload.error as { message?: string } | undefined;
      assertEquals(payload.result, undefined);
      assertStringIncludes(rpcError?.message || '', 'Unknown SDK tool');
    }
  } finally {
    cleanup();
  }
});
