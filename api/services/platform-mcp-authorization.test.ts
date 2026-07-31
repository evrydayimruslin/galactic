import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  authorizePlatformMcpTool,
  canApiTokenManageAgentVisibility,
  canApiTokenStageExistingRuntime,
  filterPlatformMcpToolsForAuth,
  isApiTokenPlatformAuth,
  PLATFORM_MCP_SCOPES,
  type PlatformMcpAuthContext,
  shouldAutoLiveExistingUpload,
  violatesPrivateAgentCreationPolicy,
} from "./platform-mcp-authorization.ts";

const apiToken = (scopes: string[]) => ({
  authSource: "api_token" as const,
  scopes,
});

type BuilderHandoff = NonNullable<
  PlatformMcpAuthContext["builderHandoff"]
>;

const builderHandoff = (options: {
  intent: BuilderHandoff["intent"];
  status?: BuilderHandoff["status"];
  targetAppId?: string | null;
  boundAppId?: string | null;
  bundleId?: string | null;
  sourceHash?: string | null;
  testAttestationDigest?: string | null;
  scopes?: string[];
}): PlatformMcpAuthContext => {
  const targetAppId = options.targetAppId ?? null;
  return {
    authSource: "builder_handoff",
    scopes: options.scopes ?? [
      PLATFORM_MCP_SCOPES.read,
      PLATFORM_MCP_SCOPES.build,
      `handoff:${options.intent}`,
    ],
    tokenId: "builder-handoff-token-1",
    tokenAppIds: targetAppId ? [targetAppId] : null,
    builderHandoff: {
      id: "10000000-0000-4000-8000-000000000001",
      candidateSetId: "10000000-0000-4000-8000-000000000002",
      intent: options.intent,
      status: options.status ?? "connected",
      targetAppId,
      boundAppId: options.boundAppId === undefined
        ? targetAppId
        : options.boundAppId,
      bundleId: options.bundleId ?? null,
      sourceHash: options.sourceHash ?? null,
      attestationId: null,
      testAttestationDigest: options.testAttestationDigest ?? null,
      documentDigest: null,
      reportDigest: null,
      releaseDigest: null,
      baseVersion: null,
      baseSourceHash: null,
      baseReleaseDigest: null,
      baseStateDigest: null,
    },
  };
};

const BUNDLE_ID = `gxb1_${"a".repeat(64)}`;
const OTHER_BUNDLE_ID = `gxb1_${"b".repeat(64)}`;
const TEST_ATTESTATION = "gxt2.test-attestation";

Deno.test("platform MCP auth: authenticated source remains authoritative across transports", () => {
  assertEquals(isApiTokenPlatformAuth({ authSource: "api_token" }), true);
  assertEquals(isApiTokenPlatformAuth({ authSource: "builder_handoff" }), true);
  assertEquals(isApiTokenPlatformAuth({ authSource: "supabase" }), false);
  assertEquals(isApiTokenPlatformAuth({}), false);
});

Deno.test("platform MCP scopes: apps:call stays a call-only compatibility credential", () => {
  const auth = apiToken([PLATFORM_MCP_SCOPES.call]);

  for (const tool of ["gx.call", "gx.job", "gx.discover", "gx.verify"]) {
    assert(
      authorizePlatformMcpTool({ requestedName: tool, auth }).allowed,
      `${tool} should remain available to an apps:call key`,
    );
  }

  for (
    const tool of [
      "gx.upload",
      "gx.test",
      "gx.stage",
      "gx.project",
      "gx.set",
      "gx.secrets",
      "gx.grants",
      "gx.routine",
    ]
  ) {
    const decision = authorizePlatformMcpTool({ requestedName: tool, auth });
    assertEquals(decision.allowed, false, `${tool} must fail closed`);
    assertStringIncludes(decision.reason || "", "missing required scope");
  }
});

Deno.test("platform MCP scopes: legacy wildcard does not imply new control-plane scopes", () => {
  const auth = apiToken(["*"]);

  assertEquals(
    authorizePlatformMcpTool({ requestedName: "gx.call", auth }).allowed,
    true,
    "legacy wildcard keys retain Agent read/call compatibility",
  );
  for (
    const tool of [
      "gx.upload",
      "gx.stage",
      "gx.project",
      "gx.grants",
      "gx.routine",
    ]
  ) {
    const decision = authorizePlatformMcpTool({ requestedName: tool, auth });
    assertEquals(decision.allowed, false);
    assertStringIncludes(decision.reason || "", "Legacy wildcard");
  }
});

Deno.test("platform MCP scopes: builder/operator capabilities remain bounded by owner-session approvals", () => {
  const auth = apiToken([
    PLATFORM_MCP_SCOPES.read,
    PLATFORM_MCP_SCOPES.call,
    PLATFORM_MCP_SCOPES.build,
    PLATFORM_MCP_SCOPES.operate,
  ]);

  for (
    const input of [
      { requestedName: "gx.upload", args: { visibility: "private" } },
      { requestedName: "gx.stage", args: { files: [] } },
      { requestedName: "gx.project", args: { app_id: "agent-1" } },
      { requestedName: "gx.set", args: { version: "1.2.3" } },
      { requestedName: "gx.secrets", args: { app_id: "agent-1" } },
      { requestedName: "gx.grants", args: { action: "propose" } },
      {
        requestedName: "gx.routine",
        args: { action: "create", activate: false },
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
        requestedName: "gx.secrets",
        args: { app_id: "agent-1", secrets: { API_KEY: "secret" } },
      },
      { requestedName: "gx.grants", args: { action: "approve" } },
      { requestedName: "gx.grants", args: { action: "set_cap" } },
      { requestedName: "gx.routine", args: { action: "resume" } },
      { requestedName: "gx.routine", args: { action: "run_now" } },
      {
        requestedName: "gx.routine",
        args: { action: "create", approve_capabilities: true },
      },
      {
        requestedName: "gx.routine",
        args: {
          action: "create",
          capabilities: [{ app_ref: "target", approved: true }],
        },
      },
      {
        requestedName: "gx.routine",
        args: { action: "update", budget_policy: { max_light_per_day: 10 } },
      },
      {
        requestedName: "gx.routine",
        args: { action: "update", intent: "a different standing job" },
      },
      {
        requestedName: "gx.routine",
        args: { action: "update", schedule: { every_minutes: 1 } },
      },
      {
        requestedName: "gx.routine",
        args: { action: "update", metadata: { budget_spend: {} } },
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

Deno.test("platform MCP scopes: tools/list projection only advertises callable tools", () => {
  const tools = [
    { name: "gx.discover" },
    { name: "gx.call" },
    { name: "gx.upload" },
    { name: "gx.secrets" },
    { name: "gx.grants" },
  ];
  const filtered = filterPlatformMcpToolsForAuth(
    tools,
    apiToken([PLATFORM_MCP_SCOPES.call]),
  );
  assertEquals(filtered.map((tool) => tool.name), ["gx.discover", "gx.call"]);

  // Account sessions are not narrowed by API-key scopes.
  assertEquals(
    filterPlatformMcpToolsForAuth(tools, { authSource: "supabase" }),
    tools,
  );
});

Deno.test("platform MCP scopes: Agent-scoped builder keys cannot cross their assigned Agent", () => {
  const auth = {
    ...apiToken([
      PLATFORM_MCP_SCOPES.read,
      PLATFORM_MCP_SCOPES.build,
    ]),
    tokenAppIds: ["agent-1"],
  };

  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.project",
      args: { app_id: "agent-1" },
      auth,
    }).allowed,
    true,
  );
  for (
    const input of [
      { requestedName: "gx.project", args: {} },
      { requestedName: "gx.project", args: { app_id: "agent-2" } },
      { requestedName: "gx.upload", args: { bundle_id: "bundle-1" } },
      {
        requestedName: "gx.upload",
        args: { app_id: "agent-2", bundle_id: "bundle-1" },
      },
      { requestedName: "gx.discover", args: { scope: "inspect" } },
      {
        requestedName: "gx.discover",
        args: { scope: "inspect", app_id: "agent-2" },
      },
      { requestedName: "gx.discover", args: { scope: "library" } },
    ]
  ) {
    const decision = authorizePlatformMcpTool({ ...input, auth });
    assertEquals(decision.allowed, false);
    assertStringIncludes(decision.reason || "", "Agent");
  }
});

Deno.test("platform MCP scopes: durable new-Agent handoffs expose only their bounded build path", () => {
  const connectedAuth = builderHandoff({ intent: "agent" });
  const tools = [
    { name: "gx.discover" },
    { name: "gx.scaffold" },
    { name: "gx.lint" },
    { name: "gx.stage" },
    { name: "gx.test" },
    { name: "gx.upload" },
    { name: "gx.project" },
    { name: "gx.download" },
    { name: "gx.set" },
    { name: "gx.call" },
    { name: "gx.secrets" },
    { name: "resources/read" },
  ];
  assertEquals(
    filterPlatformMcpToolsForAuth(tools, connectedAuth).map((tool) =>
      tool.name
    ),
    [
      "gx.discover",
      "gx.scaffold",
      "gx.lint",
      "gx.stage",
      "gx.test",
      "gx.upload",
    ],
  );

  for (
    const input of [
      { requestedName: "gx.discover", args: { scope: "tools" } },
      { requestedName: "gx.scaffold", args: {} },
      { requestedName: "gx.lint", args: { files: [] } },
      { requestedName: "gx.stage", args: { files: [] } },
    ]
  ) {
    assert(
      authorizePlatformMcpTool({ ...input, auth: connectedAuth }).allowed,
      `${input.requestedName} should be available before staging completes`,
    );
  }

  const stagedAuth = builderHandoff({
    intent: "agent",
    status: "staged",
    bundleId: BUNDLE_ID,
  });
  assert(
    authorizePlatformMcpTool({
      requestedName: "gx.test",
      args: { bundle_id: BUNDLE_ID },
      auth: stagedAuth,
    }).allowed,
  );

  const testedAuth = builderHandoff({
    intent: "agent",
    status: "tested",
    bundleId: BUNDLE_ID,
    testAttestationDigest: TEST_ATTESTATION,
  });
  assert(
    authorizePlatformMcpTool({
      requestedName: "gx.upload",
      args: {
        bundle_id: BUNDLE_ID,
        test_attestation: TEST_ATTESTATION,
      },
      auth: testedAuth,
    }).allowed,
  );

  for (
    const input of [
      { requestedName: "gx.discover", args: { scope: "library" } },
      {
        requestedName: "gx.discover",
        args: { scope: "inspect", app_id: "agent-1" },
      },
      { requestedName: "gx.project", args: { app_id: "agent-1" } },
      { requestedName: "gx.download", args: { app_id: "agent-1" } },
      {
        requestedName: "gx.set",
        args: { app_id: "agent-1", version: "1.2.3" },
      },
      { requestedName: "gx.call", args: { app_id: "agent-1" } },
      { requestedName: "gx.secrets", args: { app_id: "agent-1" } },
      { requestedName: "resources/read", args: {} },
    ]
  ) {
    assertEquals(
      authorizePlatformMcpTool({ ...input, auth: connectedAuth }).allowed,
      false,
      `${input.requestedName} must remain unavailable to a new-Agent handoff`,
    );
  }

  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.upload",
      args: {
        app_id: "agent-1",
        bundle_id: BUNDLE_ID,
        test_attestation: TEST_ATTESTATION,
      },
      auth: testedAuth,
    }).allowed,
    false,
    "a new-Agent handoff cannot submit into an existing Agent",
  );
});

Deno.test("platform MCP scopes: durable extension handoffs inspect and submit only their exact Agent", () => {
  const connectedAuth = builderHandoff({
    intent: "interface",
    targetAppId: "agent-1",
  });
  const tools = [
    { name: "gx.discover" },
    { name: "gx.project" },
    { name: "gx.download" },
    { name: "gx.scaffold" },
    { name: "gx.lint" },
    { name: "gx.stage" },
    { name: "gx.test" },
    { name: "gx.upload" },
    { name: "gx.set" },
    { name: "gx.call" },
    { name: "gx.secrets" },
    { name: "resources/read" },
  ];
  assertEquals(
    filterPlatformMcpToolsForAuth(tools, connectedAuth).map((tool) =>
      tool.name
    ),
    [
      "gx.discover",
      "gx.project",
      "gx.download",
      "gx.scaffold",
      "gx.lint",
      "gx.stage",
      "gx.test",
      "gx.upload",
    ],
  );

  for (
    const input of [
      { requestedName: "gx.discover", args: { scope: "tools" } },
      {
        requestedName: "gx.discover",
        args: { scope: "inspect", app_id: "agent-1" },
      },
      { requestedName: "gx.project", args: { app_id: "agent-1" } },
      { requestedName: "gx.download", args: { app_id: "agent-1" } },
    ]
  ) {
    assert(
      authorizePlatformMcpTool({ ...input, auth: connectedAuth }).allowed,
      `${input.requestedName} should work for the exact assigned Agent`,
    );
  }

  for (
    const input of [
      { requestedName: "gx.discover", args: { scope: "inspect" } },
      {
        requestedName: "gx.discover",
        args: { scope: "inspect", app_id: "agent-2" },
      },
      { requestedName: "gx.discover", args: { scope: "library" } },
      { requestedName: "gx.project", args: {} },
      { requestedName: "gx.project", args: { app_id: "agent-2" } },
      { requestedName: "gx.download", args: {} },
      { requestedName: "gx.download", args: { app_id: "agent-2" } },
    ]
  ) {
    assertEquals(
      authorizePlatformMcpTool({ ...input, auth: connectedAuth }).allowed,
      false,
      `${input.requestedName} must not escape the assigned Agent`,
    );
  }

  const testedAuth = builderHandoff({
    intent: "interface",
    status: "tested",
    targetAppId: "agent-1",
    bundleId: BUNDLE_ID,
    testAttestationDigest: TEST_ATTESTATION,
  });
  assert(
    authorizePlatformMcpTool({
      requestedName: "gx.upload",
      args: {
        app_id: "agent-1",
        bundle_id: BUNDLE_ID,
        test_attestation: TEST_ATTESTATION,
      },
      auth: testedAuth,
    }).allowed,
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.upload",
      args: {
        app_id: "agent-2",
        bundle_id: BUNDLE_ID,
        test_attestation: TEST_ATTESTATION,
      },
      auth: testedAuth,
    }).allowed,
    false,
    "candidate submission must use the exact assigned Agent",
  );
});

Deno.test("platform MCP scopes: workspace handoffs cannot upload or enumerate account data", () => {
  const connectedAuth = builderHandoff({ intent: "connect" });
  const tools = [
    { name: "gx.discover" },
    { name: "gx.scaffold" },
    { name: "gx.lint" },
    { name: "gx.stage" },
    { name: "gx.test" },
    { name: "gx.upload" },
    { name: "gx.project" },
    { name: "gx.download" },
  ];
  assertEquals(
    filterPlatformMcpToolsForAuth(tools, connectedAuth).map((tool) =>
      tool.name
    ),
    [
      "gx.discover",
      "gx.scaffold",
      "gx.lint",
    ],
  );
  assert(
    authorizePlatformMcpTool({
      requestedName: "gx.discover",
      args: { scope: "tools" },
      auth: connectedAuth,
    }).allowed,
  );
  for (
    const args of [
      { scope: "library" },
      { scope: "appstore" },
      { scope: "inspect", app_id: "agent-1" },
    ]
  ) {
    assertEquals(
      authorizePlatformMcpTool({
        requestedName: "gx.discover",
        args,
        auth: connectedAuth,
      }).allowed,
      false,
    );
  }
  for (
    const input of [
      { requestedName: "gx.stage", args: { files: [] } },
      { requestedName: "gx.test", args: { bundle_id: BUNDLE_ID } },
    ]
  ) {
    assertEquals(
      authorizePlatformMcpTool({
        ...input,
        auth: connectedAuth,
      }).allowed,
      false,
      "workspace connection handoffs are inspection-only",
    );
  }

  const testedAuth = builderHandoff({
    intent: "connect",
    status: "tested",
    bundleId: BUNDLE_ID,
    testAttestationDigest: TEST_ATTESTATION,
  });
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.upload",
      args: {
        bundle_id: BUNDLE_ID,
        test_attestation: TEST_ATTESTATION,
      },
      auth: testedAuth,
    }).allowed,
    false,
    "workspace connection handoffs never submit candidates",
  );
});

Deno.test("platform MCP scopes: handoff lifecycle binds staging, tests, and uploads to one bundle", () => {
  const stagedAuth = builderHandoff({
    intent: "agent",
    status: "staged",
    bundleId: BUNDLE_ID,
  });
  const testedAuth = builderHandoff({
    intent: "agent",
    status: "tested",
    bundleId: BUNDLE_ID,
    testAttestationDigest: TEST_ATTESTATION,
  });

  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.stage",
      args: { files: [] },
      auth: testedAuth,
    }).allowed,
    false,
    "a tested handoff cannot restage source",
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.test",
      args: { files: [], bundle_id: BUNDLE_ID },
      auth: stagedAuth,
    }).allowed,
    false,
    "handoff testing never accepts direct files",
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.upload",
      args: {
        files: [],
        bundle_id: BUNDLE_ID,
        test_attestation: TEST_ATTESTATION,
      },
      auth: testedAuth,
    }).allowed,
    false,
    "handoff uploads never accept direct files",
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.test",
      args: { bundle_id: OTHER_BUNDLE_ID },
      auth: stagedAuth,
    }).allowed,
    false,
    "gx.test cannot switch away from the staged bundle",
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.upload",
      args: {
        bundle_id: OTHER_BUNDLE_ID,
        test_attestation: TEST_ATTESTATION,
      },
      auth: testedAuth,
    }).allowed,
    false,
    "gx.upload cannot switch away from the tested bundle",
  );
  assertEquals(
    authorizePlatformMcpTool({
      requestedName: "gx.upload",
      args: { bundle_id: BUNDLE_ID },
      auth: testedAuth,
    }).allowed,
    false,
    "gx.upload requires a test attestation",
  );
});

Deno.test("platform MCP scopes: forged or malformed handoff markers fail closed", () => {
  const tools = [
    { name: "gx.discover" },
    { name: "gx.stage" },
    { name: "gx.upload" },
  ];
  for (
    const scopes of [
      [
        PLATFORM_MCP_SCOPES.read,
        PLATFORM_MCP_SCOPES.build,
        "handoff:interface",
      ],
      [
        PLATFORM_MCP_SCOPES.read,
        PLATFORM_MCP_SCOPES.build,
        "handoff:not-real",
      ],
      [
        PLATFORM_MCP_SCOPES.read,
        PLATFORM_MCP_SCOPES.build,
        "handoff:interface",
        "handoff:routine",
      ],
    ]
  ) {
    const auth = apiToken(scopes);
    assertEquals(filterPlatformMcpToolsForAuth(tools, auth), []);
    const decision = authorizePlatformMcpTool({
      requestedName: "gx.discover",
      args: { scope: "tools" },
      auth,
    });
    assertEquals(decision.allowed, false);
    assertStringIncludes(decision.reason || "", "durable coding-agent handoff");
  }

  const mismatchedContext = builderHandoff({
    intent: "interface",
    targetAppId: "agent-1",
    scopes: [
      PLATFORM_MCP_SCOPES.read,
      PLATFORM_MCP_SCOPES.build,
      "handoff:routine",
    ],
  });
  assertEquals(filterPlatformMcpToolsForAuth(tools, mismatchedContext), []);
  const decision = authorizePlatformMcpTool({
    requestedName: "gx.discover",
    args: { scope: "tools" },
    auth: mismatchedContext,
  });
  assertEquals(decision.allowed, false);
  assertStringIncludes(decision.reason || "", "durable coding-agent handoff");
});

Deno.test("platform MCP scopes: deferred marketplace and publication families stay account-only", () => {
  const auth = apiToken([
    PLATFORM_MCP_SCOPES.read,
    PLATFORM_MCP_SCOPES.call,
    PLATFORM_MCP_SCOPES.build,
    PLATFORM_MCP_SCOPES.operate,
  ]);
  const tools = [
    { name: "gx.call" },
    { name: "gx.wallet" },
    { name: "gx.marketplace" },
    { name: "gx.permissions" },
    { name: "gx.markdown.publish" },
    { name: "gx.emit" },
    { name: "gx.command" },
  ];
  assertEquals(
    filterPlatformMcpToolsForAuth(tools, auth).map((tool) => tool.name),
    ["gx.call"],
  );
  for (const tool of ["gx.emit", "gx.command", "gx.marketplace"]) {
    const decision = authorizePlatformMcpTool({
      requestedName: tool,
      auth,
    });
    assertEquals(decision.allowed, false);
    assertStringIncludes(decision.reason || "", "not available to API keys");
  }
});

Deno.test("platform MCP scopes: Conjure creates private Agents without changing legacy apps", () => {
  assertEquals(violatesPrivateAgentCreationPolicy({}), false);
  assertEquals(
    violatesPrivateAgentCreationPolicy({ visibility: "unlisted" }),
    true,
  );
  assertEquals(
    violatesPrivateAgentCreationPolicy({ visibility: "published" }),
    true,
  );
  assertEquals(
    violatesPrivateAgentCreationPolicy({
      appId: "existing-agent",
      visibility: "public",
    }),
    false,
    "version uploads do not mutate an existing Agent's legacy visibility",
  );
});

Deno.test("platform MCP scopes: connected builders stage existing private Agents and never auto-live", () => {
  assertEquals(canApiTokenManageAgentVisibility("private"), true);
  assertEquals(canApiTokenManageAgentVisibility("unlisted"), false);
  assertEquals(canApiTokenManageAgentVisibility("public"), false);
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
    "account-session developer iteration keeps its legacy auto-live flow",
  );
  assertEquals(
    canApiTokenStageExistingRuntime({ currentRuntime: "deno" }),
    true,
  );
  assertEquals(
    canApiTokenStageExistingRuntime({ currentRuntime: "gpu" }),
    false,
  );
  assertEquals(
    canApiTokenStageExistingRuntime({
      currentRuntime: "deno",
      uploadContainsGpuConfig: true,
    }),
    false,
  );
});
