/**
 * Agent Flow Tests for Ultralight Platform
 *
 * SPEC-DRIVEN: These tests define the IDEAL agent experience.
 * Tests that fail represent gaps to be built. Tests that pass confirm correctness.
 *
 * Section 1: CLI Source Verification — correctness guards (all should pass)
 * Section 2: Discovery Response Shape — what agents need from search results
 * Section 3: Featured, Status, OpenAPI — operational endpoints
 * Section 4: Structured Errors — machine-readable error responses
 * Section 5: MCP Config Generator — ready-to-paste client configs
 * Section 6: OAuth Metadata — agent auth discovery
 * Section 7: MCP Protocol — JSON-RPC correctness
 * Section 8: Per-App MCP & Well-Known — app-level access
 *
 * Usage:
 *   deno test --allow-net --allow-read --allow-env cli/tests/agent-flows.test.ts
 *
 * Environment:
 *   UL_TOKEN       — API token for authenticated tests (optional, tests skip if not set)
 *   UL_TEST_APP    — A known public app ID for per-app tests (optional)
 *   UL_API_URL     — Override API URL (default: https://ultralight-api.rgn4jz429m.workers.dev)
 *   UL_LIVE_API_TESTS=1 — Run live API specs against UL_API_URL
 */

import {
  assertEquals,
  assertExists,
  assert,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

const API = Deno.env.get('UL_API_URL') || 'https://ultralight-api.rgn4jz429m.workers.dev';
const TOKEN = Deno.env.get('UL_TOKEN');
const TEST_APP = Deno.env.get('UL_TEST_APP') || 'cd118f84-fbca-4cb3-a680-3974585bc319';
const LIVE_API_TESTS = Deno.env.get('UL_LIVE_API_TESTS') === '1';

// ============================================
// 1. CLI SOURCE VERIFICATION (No network needed)
//    These are correctness guards — all should pass.
// ============================================

Deno.test('CLI: all callTool() calls use ul.* prefix, not platform.*', async () => {
  const cliSource = await Deno.readTextFile('./cli/mod.ts');

  const platformCalls = cliSource.match(/callTool\(\s*['"]platform\./g);
  assertEquals(
    platformCalls,
    null,
    `Found ${platformCalls?.length || 0} callTool('platform.*') calls — should be 0. ` +
    `Matches: ${platformCalls?.join(', ')}`
  );

  const ulCalls = cliSource.match(/callTool\(\s*['"]ul\./g);
  assert(
    ulCalls !== null && ulCalls.length >= 10,
    `Expected 10+ callTool('ul.*') calls, found ${ulCalls?.length || 0}`
  );
});

Deno.test('CLI: test command uses test_args parameter, not args', async () => {
  const cliSource = await Deno.readTextFile('./cli/mod.ts');

  assertStringIncludes(cliSource, 'test_args', 'Missing test_args in CLI source');

  const brokenPattern = cliSource.match(/toolArgs\.args\s*=/g);
  assertEquals(
    brokenPattern,
    null,
    `Found old toolArgs.args = pattern — should use test_args instead`
  );
});

Deno.test('CLI: init template uses single-args-object pattern', async () => {
  const cliSource = await Deno.readTextFile('./cli/mod.ts');

  assertStringIncludes(
    cliSource,
    'args: { name?: string }',
    'Init basic template missing single-args-object pattern: (args: { name?: string })'
  );

  const oldPattern = cliSource.match(/export function hello\(name:\s*string/);
  assertEquals(
    oldPattern,
    null,
    'Init template still has old positional parameter pattern: hello(name: string ...)'
  );
});

Deno.test('CLI: upload calls ul.upload, not platform.apps.create', async () => {
  const cliSource = await Deno.readTextFile('./cli/mod.ts');

  assert(
    !cliSource.includes('platform.apps.create'),
    'Found old platform.apps.create reference — should use ul.upload'
  );

  assertStringIncludes(cliSource, "'ul.upload'", 'Missing ul.upload call in upload command');
});

Deno.test('CLI: run command uses per-app MCP endpoint via callAppTool', async () => {
  const cliSource = await Deno.readTextFile('./cli/mod.ts');

  assert(
    !cliSource.includes('platform.run'),
    'Found old platform.run reference — should use callAppTool for per-app MCP'
  );

  assertStringIncludes(cliSource, 'callAppTool', 'Missing callAppTool for run command');
});

Deno.test('CLI: whoami uses REST GET /api/user, not MCP tool', async () => {
  const cliSource = await Deno.readTextFile('./cli/mod.ts');

  assert(
    !cliSource.includes('platform.user.profile'),
    'Found old platform.user.profile reference — should use restGet(/api/user)'
  );

  assertStringIncludes(cliSource, "restGet('/api/user')", 'Missing restGet /api/user call in whoami');
});

Deno.test('CLI: version is 1.3.0', async () => {
  const cliSource = await Deno.readTextFile('./cli/mod.ts');
  assertStringIncludes(cliSource, "const VERSION = '1.3.0'", 'CLI version should be 1.3.0');

  const pkgJson = JSON.parse(await Deno.readTextFile('./cli/package.json'));
  assertEquals(pkgJson.version, '1.3.0', 'package.json version should be 1.3.0');
});

Deno.test('CLI: all expected commands are registered', async () => {
  const cliSource = await Deno.readTextFile('./cli/mod.ts');

  const expectedCommands = [
    'init', 'login', 'logout', 'whoami', 'upload',
    'apps', 'draft', 'docs', 'set', 'permissions',
    'test', 'lint', 'scaffold', 'run', 'discover',
    'logs', 'health', 'config', 'help', 'version',
  ];

  assertStringIncludes(cliSource, 'download: downloadCmd', 'Missing download command registration');

  for (const cmd of expectedCommands) {
    assert(
      cliSource.includes(`  ${cmd}`) || cliSource.includes(`${cmd}:`),
      `Missing command registration: ${cmd}`
    );
  }
});

Deno.test('CLI: api.ts has restGet, callAppTool, listAppTools methods', async () => {
  const apiSource = await Deno.readTextFile('./cli/api.ts');

  assertStringIncludes(apiSource, 'async restGet(', 'Missing restGet method in api.ts');
  assertStringIncludes(apiSource, 'async callAppTool(', 'Missing callAppTool method in api.ts');
  assertStringIncludes(apiSource, 'async listAppTools(', 'Missing listAppTools method in api.ts');
  assertStringIncludes(apiSource, 'getApiUrl()', 'Missing getApiUrl method in api.ts');
  assertStringIncludes(apiSource, 'isAuthenticated()', 'Missing isAuthenticated method in api.ts');
});

Deno.test('CLI: callAppTool calls per-app endpoint /mcp/{appId}', async () => {
  const apiSource = await Deno.readTextFile('./cli/api.ts');

  assertStringIncludes(
    apiSource,
    '`${this.apiUrl}/mcp/${appId}`',
    'callAppTool must call per-app endpoint /mcp/{appId}'
  );
});

Deno.test('CLI: no remaining platform.* tool references anywhere', async () => {
  const cliSource = await Deno.readTextFile('./cli/mod.ts');
  const apiSource = await Deno.readTextFile('./cli/api.ts');
  const combined = cliSource + apiSource;

  const lines = combined.split('\n');
  const badLines: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    if (line.includes("'platform.") || line.includes('"platform.')) {
      badLines.push(line.trim());
    }
  }

  assertEquals(
    badLines.length,
    0,
    `Found ${badLines.length} remaining platform.* references in non-comment code:\n${badLines.join('\n')}`
  );
});

// ============================================
// 2. DISCOVERY RESPONSE SHAPE
//    What agents need from search results.
//    An agent should be able to: discover → auth → connect.
// ============================================

Deno.test({
  name: 'SPEC: discovery search returns correct response shape',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/discover?q=hello`);
    // Accept 200 or 429 (rate limited)
    assert(res.status === 200 || res.status === 429, `Expected 200 or 429, got ${res.status}`);
    if (res.status !== 200) { await res.body?.cancel(); return; }

    const data = await res.json();
    assertEquals(data.mode, 'search', 'mode should be "search"');
    assertEquals(data.query, 'hello', 'query should echo back');
    assertExists(data.query_id, 'query_id must exist (UUID)');
    assertEquals(data.authenticated, false, 'authenticated should be false without auth header');
    assert(Array.isArray(data.results), 'results must be an array');
    assertExists(data.total, 'total count must exist');
  },
});

Deno.test({
  name: 'SPEC: each discovery result includes mcp_endpoint AND http_endpoint',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/discover?q=hello`);
    if (res.status !== 200) { await res.body?.cancel(); return; }
    const data = await res.json();
    if (data.results.length === 0) return; // No results to check

    const first = data.results[0];
    // Required fields every agent needs
    assertExists(first.id, 'result must have id');
    assertExists(first.name, 'result must have name');
    assertExists(first.slug, 'result must have slug');
    assertEquals(typeof first.fully_native, 'boolean', 'fully_native must be boolean');

    // MCP endpoint — the primary way agents connect
    assertExists(first.mcp_endpoint, 'result must have mcp_endpoint');
    assert(
      String(first.mcp_endpoint).startsWith('/mcp/'),
      `mcp_endpoint should start with /mcp/, got: ${first.mcp_endpoint}`
    );

    // HTTP endpoint — for agents/scripts that can't do MCP
    assertExists(first.http_endpoint, 'result must have http_endpoint — agents need both MCP and HTTP paths');
    assert(
      String(first.http_endpoint).startsWith('/http/'),
      `http_endpoint should start with /http/, got: ${first.http_endpoint}`
    );
  },
});

Deno.test({
  name: 'SPEC: discovery _links includes auth endpoint for agent onboarding',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/discover?q=hello`);
    if (res.status !== 200) { await res.body?.cancel(); return; }
    const data = await res.json();

    assertExists(data._links, 'response must include _links for HATEOAS navigation');
    assertExists(data._links.openapi, '_links must include openapi');
    assertExists(data._links.mcp_platform, '_links must include mcp_platform');

    // The critical gap: agents discover apps but don't know how to authenticate
    assertEquals(
      data._links.auth,
      '/.well-known/oauth-authorization-server',
      '_links.auth must point to OAuth metadata so agents can self-onboard'
    );
  },
});

Deno.test({
  name: 'SPEC: authenticated discovery results include is_owner flag',
  ignore: !LIVE_API_TESTS || !TOKEN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/discover?q=hello`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    if (res.status !== 200) { await res.body?.cancel(); return; }
    const data = await res.json();

    assertEquals(data.authenticated, true, 'authenticated should be true with valid token');

    if (data.results.length > 0) {
      const first = data.results[0];
      assertEquals(
        typeof first.is_owner,
        'boolean',
        'Authenticated results must include is_owner boolean so agents know which apps they manage'
      );
    }
  },
});

// ============================================
// 3. FEATURED, STATUS, OPENAPI
//    Operational endpoints agents use for health and discovery.
// ============================================

Deno.test({
  name: 'SPEC: featured endpoint returns ranked results',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/discover/featured`);
    assert(res.status === 200 || res.status === 429, `Expected 200 or 429, got ${res.status}`);
    if (res.status !== 200) { await res.text(); return; }

    const data = await res.json();
    assertEquals(data.mode, 'featured', 'mode should be "featured"');
    assert(Array.isArray(data.results), 'results must be an array');
  },
});

Deno.test({
  name: 'SPEC: status endpoint returns operational metrics',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/discover/status`);
    assertEquals(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();

    // Existing fields
    assertEquals(typeof data.available, 'boolean', 'available must be boolean');

    // New operational metrics agents need to assess platform health
    assertEquals(
      typeof data.app_count,
      'number',
      'status must include app_count — agents need to know if the platform has content'
    );
    assertEquals(
      typeof data.version,
      'string',
      'status must include version — agents need to know API version for compatibility'
    );
    assertExists(
      data.timestamp,
      'status must include timestamp — agents need to know response freshness'
    );
  },
});

Deno.test({
  name: 'SPEC: OpenAPI spec is valid 3.1.0 with documented paths',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/discover/openapi.json`);
    assertEquals(res.status, 200, `Expected 200, got ${res.status}`);

    const spec = await res.json();
    assertEquals(spec.openapi, '3.1.0', 'OpenAPI version should be 3.1.0');
    assertExists(spec.paths, 'OpenAPI spec must have paths');
    assertExists(spec.paths['/api/discover'], 'OpenAPI spec must document /api/discover');
  },
});

// ============================================
// 4. STRUCTURED ERRORS
//    Agents need machine-readable error codes to self-recover.
//    Plain text errors force agents to pattern-match strings.
// ============================================

Deno.test({
  name: 'SPEC: missing query returns structured error with code and docs_url',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/discover`);
    assertEquals(res.status, 400, `Expected 400, got ${res.status}`);
    const data = await res.json();

    // Must have machine-readable code (not just a string message)
    assertEquals(
      data.code,
      'MISSING_QUERY',
      'Error must include code: "MISSING_QUERY" — agents need structured codes to handle errors programmatically'
    );
    assertExists(data.error, 'Error must include human-readable error message');
    assertEquals(
      data.docs_url,
      '/api/discover/openapi.json',
      'Error must include docs_url so agents can self-recover'
    );
  },
});

Deno.test({
  name: 'SPEC: short query returns structured error with code',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/discover?q=x`);
    assertEquals(res.status, 400, `Expected 400, got ${res.status}`);
    const data = await res.json();

    assertEquals(
      data.code,
      'QUERY_TOO_SHORT',
      'Error must include code: "QUERY_TOO_SHORT"'
    );
    assertExists(data.error, 'Error must include human-readable error message');
    assertExists(data.docs_url, 'Error must include docs_url');
  },
});

// ============================================
// 5. MCP CONFIG GENERATOR
//    Agents need ready-to-paste configs to set up MCP clients.
//    Today they must manually construct JSON — that's a blocker.
// ============================================

Deno.test({
  name: 'SPEC: GET /api/mcp-config/{appId} returns Claude Desktop config',
  ignore: !LIVE_API_TESTS || !TOKEN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/mcp-config/${TEST_APP}`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    assertEquals(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();

    // Claude Desktop expects { mcpServers: { "name": { url, transport } } }
    assertExists(
      data.mcpServers,
      'Config must have mcpServers key — this is the Claude Desktop format'
    );
    const serverNames = Object.keys(data.mcpServers);
    assert(serverNames.length > 0, 'mcpServers must have at least one entry');

    const server = data.mcpServers[serverNames[0]];
    assertExists(server.url, 'Server config must include url');
    assertStringIncludes(server.url, '/mcp/', 'url must point to MCP endpoint');
  },
});

Deno.test({
  name: 'SPEC: GET /api/mcp-config/{appId}?client=cursor returns Cursor config',
  ignore: !LIVE_API_TESTS || !TOKEN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/api/mcp-config/${TEST_APP}?client=cursor`, {
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    assertEquals(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();

    // Cursor expects { mcp: { servers: { "name": { url, type } } } }
    assertExists(
      data.mcp,
      'Config must have mcp key — this is the Cursor format'
    );
    assertExists(data.mcp.servers, 'mcp must have servers object');
    const serverNames = Object.keys(data.mcp.servers);
    assert(serverNames.length > 0, 'mcp.servers must have at least one entry');

    const server = data.mcp.servers[serverNames[0]];
    assertExists(server.url, 'Server config must include url');
  },
});

// ============================================
// 6. OAUTH METADATA
//    Agents need to discover auth flows automatically.
// ============================================

Deno.test({
  name: 'SPEC: OAuth authorization server metadata has required fields',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/.well-known/oauth-authorization-server`);
    assertEquals(res.status, 200, `Expected 200, got ${res.status}`);

    const meta = await res.json();
    assertExists(meta.authorization_endpoint, 'Must have authorization_endpoint');
    assertExists(meta.token_endpoint, 'Must have token_endpoint');
    assertExists(meta.registration_endpoint, 'Must have registration_endpoint');
    assert(
      Array.isArray(meta.code_challenge_methods_supported) &&
      meta.code_challenge_methods_supported.includes('S256'),
      'Must support S256 PKCE'
    );
  },
});

Deno.test({
  name: 'SPEC: OAuth protected resource metadata exists',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/.well-known/oauth-protected-resource`);
    assert(
      res.status === 200 || res.status === 404,
      `Expected 200 or 404, got ${res.status}`
    );
    await res.text();
  },
});

Deno.test({
  name: 'SPEC: dynamic client registration returns client_id',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Ultralight Spec Test',
        redirect_uris: ['http://localhost:9999/callback'],
      }),
    });
    assert(res.status === 200 || res.status === 201, `Expected 200 or 201, got ${res.status}`);

    const data = await res.json();
    assertExists(data.client_id, 'Registration must return client_id');
  },
});

// ============================================
// 7. MCP PROTOCOL
//    JSON-RPC 2.0 correctness for agent communication.
// ============================================

Deno.test({
  name: 'SPEC: platform MCP initialize returns protocol version',
  ignore: !LIVE_API_TESTS || !TOKEN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/mcp/platform`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assertEquals(res.status, 200);

    const data = await res.json();
    assertExists(data.result, 'initialize must return result');
    assertExists(data.result.protocolVersion, 'result must have protocolVersion');
    assertExists(data.result.capabilities, 'result must have capabilities');
  },
});

Deno.test({
  name: 'SPEC: platform MCP tools/list returns 20+ ul.* tools',
  ignore: !LIVE_API_TESTS || !TOKEN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/mcp/platform`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assertEquals(res.status, 200);

    const data = await res.json();
    const tools = data.result?.tools || [];
    const ulTools = tools.filter((t: { name: string }) => t.name.startsWith('ul.'));
    assert(
      ulTools.length >= 20,
      `Expected 20+ ul.* tools, got ${ulTools.length}`
    );
  },
});

Deno.test({
  name: 'SPEC: invalid token returns 401',
  ignore: !LIVE_API_TESTS,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/mcp/platform`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid_token_12345',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    await res.text();
    assertEquals(res.status, 401, `Expected 401 for invalid token, got ${res.status}`);
  },
});

// ============================================
// 8. PER-APP MCP & WELL-KNOWN
//    App-level agent access.
// ============================================

Deno.test({
  name: 'SPEC: per-app MCP initialize works',
  ignore: !LIVE_API_TESTS || !TOKEN || !TEST_APP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/mcp/${TEST_APP}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assertEquals(res.status, 200);

    const data = await res.json();
    assertExists(data.result?.protocolVersion, 'Per-app initialize must return protocolVersion');
  },
});

Deno.test({
  name: 'SPEC: per-app MCP tools/list returns app functions',
  ignore: !LIVE_API_TESTS || !TOKEN || !TEST_APP,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/mcp/${TEST_APP}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assertEquals(res.status, 200);

    const data = await res.json();
    const tools = data.result?.tools || [];
    assert(tools.length > 0, 'Per-app tools/list must return at least 1 tool');
  },
});

Deno.test({
  name: 'SPEC: per-app .well-known/mcp.json has transport config',
  ignore: !LIVE_API_TESTS || !TOKEN,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const res = await fetch(`${API}/a/${TEST_APP}/.well-known/mcp.json`, {
      headers: TOKEN ? { 'Authorization': `Bearer ${TOKEN}` } : {},
    });
    assertEquals(res.status, 200, `Expected 200, got ${res.status}`);

    const config = await res.json();
    assertExists(config.name, 'MCP config must have name');
    assertExists(config.transport, 'MCP config must have transport');
    assertExists(config.transport?.url, 'transport must have url');
  },
});
