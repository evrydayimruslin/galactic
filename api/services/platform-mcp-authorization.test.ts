import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.210.0/assert/mod.ts';

import {
  authorizePlatformMcpTool,
  canApiTokenManageAgentVisibility,
  canApiTokenStageExistingRuntime,
  filterPlatformMcpToolsForAuth,
  isApiTokenPlatformAuth,
  PLATFORM_MCP_SCOPES,
  shouldAutoLiveExistingUpload,
  violatesPrivateAgentCreationPolicy,
} from './platform-mcp-authorization.ts';

const apiToken = (scopes: string[]) => ({
  authSource: 'api_token' as const,
  scopes,
});

Deno.test('platform MCP auth: authenticated source remains authoritative across transports', () => {
  assertEquals(isApiTokenPlatformAuth({ authSource: 'api_token' }), true);
  assertEquals(isApiTokenPlatformAuth({ authSource: 'supabase' }), false);
  assertEquals(isApiTokenPlatformAuth({}), false);
});

Deno.test('platform MCP scopes: apps:call stays a call-only compatibility credential', () => {
  const auth = apiToken([PLATFORM_MCP_SCOPES.call]);

  for (const tool of ['gx.call', 'gx.job', 'gx.discover', 'gx.verify']) {
    assert(
      authorizePlatformMcpTool({ requestedName: tool, auth }).allowed,
      `${tool} should remain available to an apps:call key`,
    );
  }

  for (
    const tool of [
      'gx.upload',
      'gx.test',
      'gx.stage',
      'gx.project',
      'gx.set',
      'gx.secrets',
      'gx.grants',
      'gx.routine',
    ]
  ) {
    const decision = authorizePlatformMcpTool({ requestedName: tool, auth });
    assertEquals(decision.allowed, false, `${tool} must fail closed`);
    assertStringIncludes(decision.reason || '', 'missing required scope');
  }
});

Deno.test('platform MCP scopes: legacy wildcard does not imply new control-plane scopes', () => {
  const auth = apiToken(['*']);

  assertEquals(
    authorizePlatformMcpTool({ requestedName: 'gx.call', auth }).allowed,
    true,
    'legacy wildcard keys retain Agent read/call compatibility',
  );
  for (
    const tool of [
      'gx.upload',
      'gx.stage',
      'gx.project',
      'gx.grants',
      'gx.routine',
    ]
  ) {
    const decision = authorizePlatformMcpTool({ requestedName: tool, auth });
    assertEquals(decision.allowed, false);
    assertStringIncludes(decision.reason || '', 'Legacy wildcard');
  }
});

Deno.test('platform MCP scopes: builder/operator capabilities remain bounded by owner-session approvals', () => {
  const auth = apiToken([
    PLATFORM_MCP_SCOPES.read,
    PLATFORM_MCP_SCOPES.call,
    PLATFORM_MCP_SCOPES.build,
    PLATFORM_MCP_SCOPES.operate,
  ]);

  for (
    const input of [
      { requestedName: 'gx.upload', args: { visibility: 'private' } },
      { requestedName: 'gx.stage', args: { files: [] } },
      { requestedName: 'gx.project', args: { app_id: 'agent-1' } },
      { requestedName: 'gx.set', args: { version: '1.2.3' } },
      { requestedName: 'gx.secrets', args: { app_id: 'agent-1' } },
      { requestedName: 'gx.grants', args: { action: 'propose' } },
      {
        requestedName: 'gx.routine',
        args: { action: 'create', activate: false },
      },
      { requestedName: "gx.routine", args: { action: "pause" } },
      { requestedName: "gx.notifications", args: { action: "list" } },
      { requestedName: "gx.attention", args: { action: "list" } },
    ]
  ) {
    assert(
      authorizePlatformMcpTool({ ...input, auth }).allowed,
      `${input.requestedName} should be available within its bounded action`,
    );
  }

  for (
    const input of [
      {
        requestedName: 'gx.secrets',
        args: { app_id: 'agent-1', secrets: { API_KEY: 'secret' } },
      },
      { requestedName: 'gx.grants', args: { action: 'approve' } },
      { requestedName: 'gx.grants', args: { action: 'set_cap' } },
      { requestedName: 'gx.routine', args: { action: 'resume' } },
      { requestedName: 'gx.routine', args: { action: 'run_now' } },
      {
        requestedName: 'gx.routine',
        args: { action: 'create', approve_capabilities: true },
      },
      {
        requestedName: 'gx.routine',
        args: {
          action: 'create',
          capabilities: [{ app_ref: 'target', approved: true }],
        },
      },
      {
        requestedName: 'gx.routine',
        args: { action: 'update', budget_policy: { max_light_per_day: 10 } },
      },
      {
        requestedName: 'gx.routine',
        args: { action: 'update', intent: 'a different standing job' },
      },
      {
        requestedName: 'gx.routine',
        args: { action: 'update', schedule: { every_minutes: 1 } },
      },
      {
        requestedName: 'gx.routine',
        args: { action: 'update', metadata: { budget_spend: {} } },
      },
      { requestedName: "gx.notifications", args: { action: "mark_read" } },
      { requestedName: "gx.attention", args: { action: "dismiss" } },
      { requestedName: "gx.attention", args: { action: "run_once" } },
      { requestedName: "gx.logs", args: { resolve_event_id: "event-1" } },
      { requestedName: "gx.db", args: { action: "support_read" } },
      { requestedName: "gx.discover", args: { scope: "appstore" } },
      { requestedName: "ul.discover.appstore", args: {} },
      { requestedName: "gx.upload", args: { type: "page" } },
      { requestedName: "gx.set", args: { visibility: "private" } },
      { requestedName: "gx.set", args: { download_access: "public" } },
      { requestedName: "gx.set", args: { visibility: "unlisted" } },
      { requestedName: "ul.set.visibility", args: { visibility: "published" } },
    ]
  ) {
    const decision = authorizePlatformMcpTool({ ...input, auth });
    assertEquals(decision.allowed, false);
    assertEquals(decision.accountSessionRequired, true);
  }
});

Deno.test('platform MCP scopes: tools/list projection only advertises callable tools', () => {
  const tools = [
    { name: 'gx.discover' },
    { name: 'gx.call' },
    { name: 'gx.upload' },
    { name: 'gx.secrets' },
    { name: 'gx.grants' },
  ];
  const filtered = filterPlatformMcpToolsForAuth(
    tools,
    apiToken([PLATFORM_MCP_SCOPES.call]),
  );
  assertEquals(filtered.map((tool) => tool.name), ['gx.discover', 'gx.call']);

  // Account sessions are not narrowed by API-key scopes.
  assertEquals(
    filterPlatformMcpToolsForAuth(tools, { authSource: 'supabase' }),
    tools,
  );
});

Deno.test('platform MCP scopes: Agent-scoped builder keys cannot cross their assigned Agent', () => {
  const auth = {
    ...apiToken([
      PLATFORM_MCP_SCOPES.read,
      PLATFORM_MCP_SCOPES.build,
    ]),
    tokenAppIds: ['agent-1'],
  };

  assertEquals(
    authorizePlatformMcpTool({
      requestedName: 'gx.project',
      args: { app_id: 'agent-1' },
      auth,
    }).allowed,
    true,
  );
  for (
    const input of [
      { requestedName: 'gx.project', args: {} },
      { requestedName: 'gx.project', args: { app_id: 'agent-2' } },
      { requestedName: 'gx.upload', args: { bundle_id: 'bundle-1' } },
      {
        requestedName: 'gx.upload',
        args: { app_id: 'agent-2', bundle_id: 'bundle-1' },
      },
      { requestedName: 'gx.discover', args: { scope: 'inspect' } },
      {
        requestedName: 'gx.discover',
        args: { scope: 'inspect', app_id: 'agent-2' },
      },
      { requestedName: 'gx.discover', args: { scope: 'library' } },
    ]
  ) {
    const decision = authorizePlatformMcpTool({ ...input, auth });
    assertEquals(decision.allowed, false);
    assertStringIncludes(decision.reason || '', 'Agent');
  }
});

Deno.test('platform MCP scopes: handoff credentials expose only their bounded build path', () => {
  const auth = {
    ...apiToken([
      PLATFORM_MCP_SCOPES.read,
      PLATFORM_MCP_SCOPES.build,
      'handoff:interface',
    ]),
    tokenAppIds: ['agent-1'],
  };
  const tools = [
    { name: 'gx.discover' },
    { name: 'gx.project' },
    { name: 'gx.stage' },
    { name: 'gx.test' },
    { name: 'gx.upload' },
    { name: 'gx.set' },
    { name: 'gx.health' },
    { name: 'gx.gaps' },
    { name: 'gx.shortcomings' },
    { name: 'gx.db' },
    { name: 'gx.logs' },
    { name: 'gx.routine' },
  ];
  assertEquals(
    filterPlatformMcpToolsForAuth(tools, auth).map((tool) => tool.name),
    [
      'gx.discover',
      'gx.project',
      'gx.stage',
      'gx.test',
      'gx.upload',
    ],
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: 'gx.discover',
      args: { scope: 'inspect', app_id: 'agent-1' },
      auth,
    }).allowed,
    true,
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: 'gx.upload',
      args: { app_id: 'agent-1', bundle_id: 'bundle-1' },
      auth,
    }).allowed,
    true,
  );
  for (
    const input of [
      { requestedName: 'gx.upload', args: { bundle_id: 'bundle-1' } },
      {
        requestedName: 'gx.discover',
        args: { scope: 'inspect', app_id: 'agent-2' },
      },
      { requestedName: 'gx.set', args: { app_id: 'agent-1', version: '1.2.3' } },
      { requestedName: 'gx.health', args: { app_id: 'agent-1' } },
      { requestedName: 'gx.gaps', args: { app_id: 'agent-1' } },
      { requestedName: 'gx.shortcomings', args: { app_id: 'agent-1' } },
      { requestedName: 'gx.db', args: { action: 'schema' } },
      { requestedName: 'gx.discover', args: { scope: 'library' } },
    ]
  ) {
    assertEquals(
      authorizePlatformMcpTool({ ...input, auth }).allowed,
      false,
    );
  }
});

Deno.test('platform MCP scopes: new-Agent handoffs cannot mutate an existing Agent', () => {
  const auth = apiToken([
    PLATFORM_MCP_SCOPES.read,
    PLATFORM_MCP_SCOPES.build,
    'handoff:agent',
  ]);
  assertEquals(
    filterPlatformMcpToolsForAuth([
      { name: 'gx.discover' },
      { name: 'gx.stage' },
      { name: 'gx.test' },
      { name: 'gx.upload' },
    ], auth).map((tool) => tool.name),
    ['gx.discover', 'gx.stage', 'gx.test'],
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: 'gx.discover',
      args: { scope: 'library' },
      auth,
    }).allowed,
    true,
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: 'gx.upload',
      args: { bundle_id: 'bundle-1', name: 'existing-agent' },
      auth,
    }).allowed,
    false,
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: 'gx.set',
      args: { app_id: 'agent-1', version: '1.0.0' },
      auth,
    }).allowed,
    false,
  );
});

Deno.test('platform MCP scopes: malformed handoff markers fail closed', () => {
  const tools = [{ name: 'gx.discover' }, { name: 'gx.upload' }];
  for (
    const scopes of [
      [
        PLATFORM_MCP_SCOPES.read,
        PLATFORM_MCP_SCOPES.build,
        'handoff:not-real',
      ],
      [
        PLATFORM_MCP_SCOPES.read,
        PLATFORM_MCP_SCOPES.build,
        'handoff:interface',
        'handoff:routine',
      ],
    ]
  ) {
    const auth = apiToken(scopes);
    assertEquals(filterPlatformMcpToolsForAuth(tools, auth), []);
    const decision = authorizePlatformMcpTool({
      requestedName: 'gx.upload',
      args: { app_id: 'agent-1', bundle_id: 'bundle-1' },
      auth,
    });
    assertEquals(decision.allowed, false);
    assertStringIncludes(decision.reason || '', 'invalid');
  }
});

Deno.test('platform MCP scopes: deferred marketplace and publication families stay account-only', () => {
  const auth = apiToken([
    PLATFORM_MCP_SCOPES.read,
    PLATFORM_MCP_SCOPES.call,
    PLATFORM_MCP_SCOPES.build,
    PLATFORM_MCP_SCOPES.operate,
  ]);
  const tools = [
    { name: 'gx.call' },
    { name: 'gx.wallet' },
    { name: 'gx.marketplace' },
    { name: 'gx.permissions' },
    { name: 'gx.markdown.publish' },
    { name: 'gx.emit' },
    { name: 'gx.command' },
  ];
  assertEquals(
    filterPlatformMcpToolsForAuth(tools, auth).map((tool) => tool.name),
    ['gx.call'],
  );
  for (const tool of ['gx.emit', 'gx.command', 'gx.marketplace']) {
    const decision = authorizePlatformMcpTool({
      requestedName: tool,
      auth,
    });
    assertEquals(decision.allowed, false);
    assertStringIncludes(decision.reason || '', 'not available to API keys');
  }
});

Deno.test('platform MCP scopes: Conjure creates private Agents without changing legacy apps', () => {
  assertEquals(violatesPrivateAgentCreationPolicy({}), false);
  assertEquals(
    violatesPrivateAgentCreationPolicy({ visibility: 'unlisted' }),
    true,
  );
  assertEquals(
    violatesPrivateAgentCreationPolicy({ visibility: 'published' }),
    true,
  );
  assertEquals(
    violatesPrivateAgentCreationPolicy({
      appId: 'existing-agent',
      visibility: 'public',
    }),
    false,
    "version uploads do not mutate an existing Agent's legacy visibility",
  );
});

Deno.test('platform MCP scopes: connected builders stage existing private Agents and never auto-live', () => {
  assertEquals(canApiTokenManageAgentVisibility('private'), true);
  assertEquals(canApiTokenManageAgentVisibility('unlisted'), false);
  assertEquals(canApiTokenManageAgentVisibility('public'), false);
  assertEquals(
    shouldAutoLiveExistingUpload({
      callerIsApiToken: true,
      requestedAutoLive: true,
      uploadedByName: true,
    }),
    false,
  );
  assertEquals(
    shouldAutoLiveExistingUpload({
      callerIsApiToken: false,
      uploadedByName: true,
    }),
    true,
    'account-session developer iteration keeps its legacy auto-live flow',
  );
  assertEquals(
    canApiTokenStageExistingRuntime({ currentRuntime: 'deno' }),
    true,
  );
  assertEquals(
    canApiTokenStageExistingRuntime({ currentRuntime: 'gpu' }),
    false,
  );
  assertEquals(
    canApiTokenStageExistingRuntime({
      currentRuntime: 'deno',
      uploadContainsGpuConfig: true,
    }),
    false,
  );
});
