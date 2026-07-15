import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  authorizePlatformMcpTool,
  canApiTokenStageExistingRuntime,
  canApiTokenManageAgentVisibility,
  filterPlatformMcpToolsForAuth,
  isApiTokenPlatformAuth,
  PLATFORM_MCP_SCOPES,
  shouldAutoLiveExistingUpload,
  violatesPrivateAgentCreationPolicy,
} from "./platform-mcp-authorization.ts";

const apiToken = (scopes: string[]) => ({
  authSource: "api_token" as const,
  scopes,
});

Deno.test("platform MCP auth: authenticated source remains authoritative across transports", () => {
  assertEquals(isApiTokenPlatformAuth({ authSource: "api_token" }), true);
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
  for (const tool of ["gx.upload", "gx.grants", "gx.routine"]) {
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
      { requestedName: "gx.set", args: { version: "1.2.3" } },
      { requestedName: "gx.secrets", args: { app_id: "agent-1" } },
      { requestedName: "gx.grants", args: { action: "propose" } },
      {
        requestedName: "gx.routine",
        args: { action: "create", activate: false },
      },
      { requestedName: "gx.routine", args: { action: "pause" } },
      { requestedName: "gx.notifications", args: { action: "list" } },
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
