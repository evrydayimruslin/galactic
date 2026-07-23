import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  type AgentOperatorStoreDependencies,
  AgentOperatorStoreError,
  formatAgentActivityCursor,
  formatAgentPreferenceRevision,
  formatFleetPreferenceRevision,
  getAgentActivityPage,
  getAgentInterfaceFavorites,
  getAgentOperatorFleetSnapshot,
  getFleetPreferences,
  initializeAgentInterfaceFavorites,
  mapAgentActivityRows,
  mapAgentOperatorFleetRows,
  parseAgentActivityCursor,
  parseAgentPreferenceRevision,
  parseFleetPreferenceRevision,
  replaceAgentInterfaceFavorites,
  replaceFleetOrder,
  replaceFleetShortcuts,
} from "./agent-operator-store.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ROUTINE_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ALERT_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-07-23T16:00:00.000Z");

interface RecordedCall {
  url: URL;
  method: string;
  body: Record<string, unknown> | null;
}

type Responder = (
  url: URL,
  method: string,
  body: Record<string, unknown> | null,
) => Response | null;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function harness(...responders: Responder[]): {
  calls: RecordedCall[];
  fetchFn: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : null;
    calls.push({ url, method, body });
    for (const responder of responders) {
      const response = responder(url, method, body);
      if (response) return response;
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  return { calls, fetchFn };
}

function dependencies(fetchFn: typeof fetch): AgentOperatorStoreDependencies {
  return {
    fetchFn,
    supabaseUrl: "https://database.example/",
    serviceRoleKey: "service-role-secret",
    clock: () => new Date(NOW),
  };
}

function rpc(name: string, response: unknown, status = 200): Responder {
  return (url, method) =>
    method === "POST" && url.pathname === `/rest/v1/rpc/${name}`
      ? json(response, status)
      : null;
}

function table(name: string, response: unknown): Responder {
  return (url, method) =>
    method === "GET" && url.pathname === `/rest/v1/${name}`
      ? json(response)
      : null;
}

function fleetRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agent_id: AGENT_ID,
    routine_count: 1,
    active_routine_count: 1,
    state: "active",
    health: "healthy",
    next_wake_at: "2026-07-23T16:05:00.000Z",
    last_run_at: "2026-07-23T15:55:00.000Z",
    deferred_wake_count: 0,
    unread_alert_count: 1,
    recent_activity: [{
      id: `alert:${ALERT_ID}`,
      kind: "alert",
      title: "Inbox needs a decision",
      summary: "One reply is waiting for review.",
      status: "open",
      routineId: ROUTINE_ID,
      createdAt: "2026-07-23T15:58:00.000Z",
    }],
    working_ready: true,
    working_exclusion_reason: null,
    attention_count: 1,
    fleet_position: 0,
    operating_summary: {
      mode: "scheduled",
      label: "Next: Check inbox",
      basis: "next_wake",
      routineId: ROUTINE_ID,
      routineName: "Check inbox",
      nextEventAt: "2026-07-23T16:05:00.000Z",
      lastObservedAt: "2026-07-23T15:55:00.000Z",
    },
    working_agent_count: 1,
    ...overrides,
  };
}

function activityRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    item_key: `run:${RUN_ID}`,
    phase: "recent",
    kind: "routine_run",
    title: "Check inbox",
    summary: "Checked 12 messages.",
    status: "succeeded",
    event_at: "2026-07-23T15:55:00.000Z",
    routine_id: ROUTINE_ID,
    source_id: RUN_ID,
    detail_url: `/agents/email-ops?pane=routines&item=${ROUTINE_ID}`,
    ...overrides,
  };
}

Deno.test("preference revision tokens are lossless and bound to their owner or Agent", async () => {
  const huge = "900719925474099312345678901";
  const agentToken = formatAgentPreferenceRevision(AGENT_ID, huge);
  const fleetToken = formatFleetPreferenceRevision(USER_ID, BigInt(huge));

  assertEquals(parseAgentPreferenceRevision(agentToken, AGENT_ID), huge);
  assertEquals(parseFleetPreferenceRevision(fleetToken, USER_ID), huge);
  await assertRejects(
    async () => parseAgentPreferenceRevision(agentToken, SECOND_AGENT_ID),
    AgentOperatorStoreError,
    "revision is invalid",
  );
  await assertRejects(
    async () => parseFleetPreferenceRevision(fleetToken, AGENT_ID),
    AgentOperatorStoreError,
    "revision is invalid",
  );
});

Deno.test("Agent favorites read is owner scoped, ordered, and preserves explicit empty", async () => {
  const database = harness(rpc(
    "get_user_agent_interface_favorites_snapshot",
    [{
      revision: 7,
      favorites_initialized_at: "2026-07-23T15:00:00.000Z",
      favorites_explicit: true,
      updated_at: "2026-07-23T15:01:00.000Z",
      favorite_interface_ids: [],
    }],
  ));
  const result = await getAgentInterfaceFavorites(
    USER_ID,
    AGENT_ID,
    dependencies(database.fetchFn),
  );

  assertEquals(result.favoriteInterfaceIds, []);
  assertEquals(result.favoritesInitialized, true);
  assertEquals(result.favoritesExplicit, true);
  assertEquals(parseAgentPreferenceRevision(result.revision, AGENT_ID), "7");
  assertEquals(database.calls.length, 1);
  assertEquals(database.calls[0].body, {
    p_user_id: USER_ID,
    p_agent_id: AGENT_ID,
  });
});

Deno.test("Agent favorites read rejects a non-owned or deleted Agent", async () => {
  const database = harness(rpc(
    "get_user_agent_interface_favorites_snapshot",
    { code: "P0001", message: "agent_not_found" },
    400,
  ));
  const failure = await assertRejects(
    () =>
      getAgentInterfaceFavorites(
        USER_ID,
        AGENT_ID,
        dependencies(database.fetchFn),
      ),
    AgentOperatorStoreError,
  );
  assertEquals(failure.code, "NOT_FOUND");
  assertEquals(failure.status, 404);
});

Deno.test("empty manifests remain uninitialized and never call the initializer RPC", async () => {
  const database = harness(rpc(
    "get_user_agent_interface_favorites_snapshot",
    [{
      revision: 1,
      favorites_initialized_at: null,
      favorites_explicit: false,
      updated_at: "2026-07-23T15:00:00.000Z",
      favorite_interface_ids: [],
    }],
  ));
  const result = await initializeAgentInterfaceFavorites(
    USER_ID,
    AGENT_ID,
    [],
    dependencies(database.fetchFn),
  );

  assertEquals(result.initializedNow, false);
  assertEquals(result.preferences.favoritesInitialized, false);
  assert(
    !database.calls.some((call) =>
      call.url.pathname.endsWith(
        "/rpc/initialize_user_agent_interface_favorites",
      )
    ),
  );
});

Deno.test("first stable Interface initialization is atomic and owner scoped", async () => {
  const database = harness(rpc(
    "initialize_user_agent_interface_favorites",
    [{
      revision: 2,
      favorite_interface_ids: ["inbox"],
      initialized_at: "2026-07-23T15:30:00.000Z",
      explicit_choice: false,
      initialized_now: true,
    }],
  ));
  const result = await initializeAgentInterfaceFavorites(
    USER_ID,
    AGENT_ID,
    ["inbox", "report"],
    dependencies(database.fetchFn),
  );

  assertEquals(result.initializedNow, true);
  assertEquals(result.preferences.favoriteInterfaceIds, ["inbox"]);
  assertEquals(result.preferences.favoritesExplicit, false);
  assertEquals(database.calls[0].body, {
    p_user_id: USER_ID,
    p_agent_id: AGENT_ID,
    p_manifest_interface_ids: ["inbox", "report"],
  });
});

Deno.test("favorite replacement sends a lossless CAS revision and returns explicit empty", async () => {
  const huge = "900719925474099312345";
  const database = harness(rpc(
    "replace_user_agent_interface_favorites",
    [{
      new_revision: huge,
      favorite_interface_ids: [],
      initialized_at: "2026-07-23T15:30:00.000Z",
    }],
  ));
  const result = await replaceAgentInterfaceFavorites(
    USER_ID,
    AGENT_ID,
    [],
    formatAgentPreferenceRevision(AGENT_ID, "9"),
    dependencies(database.fetchFn),
  );

  assertEquals(result.favoriteInterfaceIds, []);
  assertEquals(result.favoritesInitialized, true);
  assertEquals(result.favoritesExplicit, true);
  assertEquals(parseAgentPreferenceRevision(result.revision, AGENT_ID), huge);
  assertEquals(database.calls[0].body?.p_expected_revision, "9");
});

Deno.test("favorite revision conflict maps to an opaque current revision without DB details", async () => {
  const database = harness(rpc(
    "replace_user_agent_interface_favorites",
    {
      code: "P0001",
      message: "agent_preference_revision_conflict",
      details: JSON.stringify({
        expectedRevision: 4,
        currentRevision: 8,
        internal: "must not escape",
      }),
    },
    400,
  ));
  const failure = await assertRejects(
    () =>
      replaceAgentInterfaceFavorites(
        USER_ID,
        AGENT_ID,
        ["inbox"],
        formatAgentPreferenceRevision(AGENT_ID, "4"),
        dependencies(database.fetchFn),
      ),
    AgentOperatorStoreError,
  );

  assertEquals(failure.code, "REVISION_CONFLICT");
  assertEquals(failure.status, 412);
  assertEquals(
    parseAgentPreferenceRevision(failure.currentRevision!, AGENT_ID),
    "8",
  );
  assert(!failure.message.includes("internal"));
});

Deno.test("Fleet preferences read validates compact zero-based order", async () => {
  const database = harness(rpc(
    "get_user_fleet_preferences_snapshot",
    [{
      revision: 3,
      shortcuts_enabled: true,
      shortcut_map: { search: "k", alerts: "a" },
      updated_at: "2026-07-23T15:00:00.000Z",
      ordered_agent_ids: [AGENT_ID, SECOND_AGENT_ID],
      ordered_fleet_positions: [0, 1],
    }],
  ));
  const result = await getFleetPreferences(
    USER_ID,
    dependencies(database.fetchFn),
  );

  assertEquals(result.positions, [
    { agentId: AGENT_ID, fleetPosition: 0 },
    { agentId: SECOND_AGENT_ID, fleetPosition: 1 },
  ]);
  assertEquals(result.shortcutMap, { search: "k", alerts: "a" });
  assertEquals(parseFleetPreferenceRevision(result.revision, USER_ID), "3");
  assertEquals(database.calls.length, 1);
});

Deno.test("Fleet preferences reject malformed atomic ordering snapshots", async () => {
  const database = harness(rpc(
    "get_user_fleet_preferences_snapshot",
    [{
      revision: 1,
      shortcuts_enabled: true,
      shortcut_map: {},
      updated_at: "2026-07-23T15:00:00.000Z",
      ordered_agent_ids: [AGENT_ID, AGENT_ID],
      ordered_fleet_positions: [0, 1],
    }],
  ));
  const failure = await assertRejects(
    () => getFleetPreferences(USER_ID, dependencies(database.fetchFn)),
    AgentOperatorStoreError,
  );
  assertEquals(failure.code, "SERVICE_UNAVAILABLE");
});

Deno.test("Fleet preferences reject non-compact or unpaired stored positions", async () => {
  for (
    const snapshot of [
      {
        ordered_agent_ids: [AGENT_ID, SECOND_AGENT_ID],
        ordered_fleet_positions: [0, 2],
      },
      {
        ordered_agent_ids: [AGENT_ID, SECOND_AGENT_ID],
        ordered_fleet_positions: [0],
      },
    ]
  ) {
    const database = harness(rpc(
      "get_user_fleet_preferences_snapshot",
      [{
        revision: 1,
        shortcuts_enabled: true,
        shortcut_map: {},
        updated_at: "2026-07-23T15:00:00.000Z",
        ...snapshot,
      }],
    ));
    const failure = await assertRejects(
      () => getFleetPreferences(USER_ID, dependencies(database.fetchFn)),
      AgentOperatorStoreError,
    );
    assertEquals(failure.code, "SERVICE_UNAVAILABLE");
  }
});

Deno.test("Fleet replacement emits zero-based positions and owner-bound CAS", async () => {
  const database = harness(rpc("replace_user_fleet_order", [{
    new_revision: 5,
    ordered_agent_ids: [SECOND_AGENT_ID, AGENT_ID],
  }]));
  const result = await replaceFleetOrder(
    USER_ID,
    [SECOND_AGENT_ID, AGENT_ID],
    formatFleetPreferenceRevision(USER_ID, "4"),
    dependencies(database.fetchFn),
  );

  assertEquals(result.positions, [
    { agentId: SECOND_AGENT_ID, fleetPosition: 0 },
    { agentId: AGENT_ID, fleetPosition: 1 },
  ]);
  assertEquals(database.calls[0].body, {
    p_user_id: USER_ID,
    p_agent_ids: [SECOND_AGENT_ID, AGENT_ID],
    p_expected_revision: "4",
  });
});

Deno.test("Fleet shortcut replacement shares the Fleet CAS and preserves explicit disables", async () => {
  const database = harness(rpc("replace_user_fleet_shortcuts", [{
    new_revision: 6,
    shortcuts_enabled: true,
    shortcut_map: {
      search: "g",
      alerts: null,
    },
  }]));
  const result = await replaceFleetShortcuts(
    USER_ID,
    true,
    {
      search: "G",
      alerts: null,
    },
    formatFleetPreferenceRevision(USER_ID, "5"),
    dependencies(database.fetchFn),
  );

  assertEquals(result.revision, formatFleetPreferenceRevision(USER_ID, "6"));
  assertEquals(result.shortcutsEnabled, true);
  assertEquals(result.shortcutMap, { search: "g", alerts: null });
  assertEquals(database.calls[0].body, {
    p_user_id: USER_ID,
    p_shortcuts_enabled: true,
    p_shortcut_map: { search: "g", alerts: null },
    p_expected_revision: "5",
  });
});

Deno.test("Fleet shortcut replacement rejects effective collisions and maps CAS conflicts opaquely", async () => {
  await assertRejects(
    () =>
      replaceFleetShortcuts(
        USER_ID,
        true,
        { search: "a" },
        formatFleetPreferenceRevision(USER_ID, "5"),
        dependencies(harness().fetchFn),
      ),
    AgentOperatorStoreError,
    "unique after applying defaults",
  );

  const database = harness(rpc("replace_user_fleet_shortcuts", {
    code: "P0001",
    message: "fleet_preference_revision_conflict",
    details: JSON.stringify({
      expectedRevision: 5,
      currentRevision: 9,
      internal: "must not escape",
    }),
  }, 400));
  const failure = await assertRejects(
    () =>
      replaceFleetShortcuts(
        USER_ID,
        false,
        { search: null },
        formatFleetPreferenceRevision(USER_ID, "5"),
        dependencies(database.fetchFn),
      ),
    AgentOperatorStoreError,
  );

  assertEquals(failure.code, "REVISION_CONFLICT");
  assertEquals(failure.status, 412);
  assertEquals(
    failure.currentRevision,
    formatFleetPreferenceRevision(USER_ID, "9"),
  );
  assert(!failure.message.includes("internal"));
});

Deno.test("Fleet v2 snapshot maps grounded working and operating projections", async () => {
  const result = mapAgentOperatorFleetRows([fleetRow()], NOW);

  assertEquals(result.workingAgentCount, 1);
  assertEquals(result.agents[0].fleetPosition, 0);
  assertEquals(result.agents[0].workingReadiness, {
    working: true,
    ready: true,
    exclusionReason: null,
    activeRoutineCount: 1,
    totalRoutineCount: 1,
  });
  assertEquals(result.agents[0].operatingSummary.label, "Next: Check inbox");
  assertEquals(
    result.agents[0].operatingSummary.evidence.map((item) => item.kind),
    ["routine", "schedule"],
  );
  assertEquals(result.agents[0].recentActivity[0].kind, "alert");
});

Deno.test("Fleet v2 request is owner scoped and opts into operator fields", async () => {
  const database = harness(rpc("get_launch_fleet_snapshot", [fleetRow()]));
  const result = await getAgentOperatorFleetSnapshot(
    USER_ID,
    dependencies(database.fetchFn),
  );

  assertEquals(result.workingAgentCount, 1);
  assertEquals(database.calls[0].body, {
    p_user_id: USER_ID,
    p_include_operator_fields: true,
  });
});

Deno.test("Fleet mapper rejects inconsistent working count and ordering", () => {
  const failure = assertRejects(
    async () =>
      mapAgentOperatorFleetRows([
        fleetRow({ working_agent_count: 0 }),
      ], NOW),
    AgentOperatorStoreError,
  );
  return failure.then((caught) =>
    assertEquals(caught.code, "SERVICE_UNAVAILABLE")
  );
});

Deno.test("activity mapper canonicalizes raw report/incident rows to attention", () => {
  const page = mapAgentActivityRows([
    activityRow({
      item_key: `notification:${ALERT_ID}`,
      kind: "incident",
      title: "Inbox checks stopped",
      source_id: ALERT_ID,
      routine_id: ROUTINE_ID,
      detail_url: `/agents/email-ops?pane=alerts&item=${ALERT_ID}`,
    }),
  ], {
    agentId: AGENT_ID,
    recentLimit: 3,
    now: NOW,
  });

  assertEquals(page.activity.recent[0].kind, "attention");
  assertEquals(page.activity.recent[0].evidence[0].kind, "notification");
  assertEquals(page.activity.recent[0].destination, {
    href: `/agents/email-ops?pane=alerts&item=${ALERT_ID}`,
    agentId: AGENT_ID,
    pane: "alerts",
    itemId: ALERT_ID,
  });
});

Deno.test("activity destinations preserve focused Access deep links", () => {
  const page = mapAgentActivityRows([
    activityRow({
      item_key: `notification:${ALERT_ID}`,
      kind: "report",
      title: "Credential scope changed",
      source_id: ALERT_ID,
      routine_id: null,
      detail_url: "/agents/email-ops?pane=access&item=gmail",
    }),
  ], {
    agentId: AGENT_ID,
    recentLimit: 3,
    now: NOW,
  });

  assertEquals(page.activity.recent[0].destination, {
    href: "/agents/email-ops?pane=access&item=gmail",
    agentId: AGENT_ID,
    pane: "access",
    itemId: "gmail",
  });
});

Deno.test("activity mapper bounds preview and creates a lossless recent cursor", () => {
  const values = [
    activityRow({
      item_key: `scheduled:${ROUTINE_ID}:1`,
      phase: "up_next",
      kind: "scheduled_run",
      event_at: "2026-07-23T16:05:00.000Z",
      source_id: ROUTINE_ID,
    }),
    activityRow(),
    activityRow({
      item_key: `run:${ALERT_ID}`,
      source_id: ALERT_ID,
      event_at: "2026-07-23T15:54:00.000Z",
    }),
  ];
  const page = mapAgentActivityRows(values, {
    agentId: AGENT_ID,
    recentLimit: 1,
    now: NOW,
  });

  assert(page.activity.upNext);
  assertEquals(page.activity.recent.length, 1);
  assert(page.nextCursor);
  assertEquals(parseAgentActivityCursor(page.nextCursor), {
    eventAt: "2026-07-23T15:55:00.000Z",
    itemKey: `run:${RUN_ID}`,
  });
});

Deno.test("activity cursor round trips Unicode and rejects malformed tokens", async () => {
  const value = {
    eventAt: "2026-07-23T15:55:00.000Z",
    itemKey: "run:réponse:東京",
  };
  assertEquals(
    parseAgentActivityCursor(formatAgentActivityCursor(value)),
    value,
  );
  const failure = await assertRejects(
    async () => parseAgentActivityCursor("agent-activity-v1.!"),
    AgentOperatorStoreError,
  );
  assertEquals(failure.code, "INVALID_REQUEST");
});

Deno.test("activity page sends an owner-scoped +1 query and cursor pages omit upcoming", async () => {
  const cursor = formatAgentActivityCursor({
    eventAt: "2026-07-23T15:55:00.000Z",
    itemKey: `run:${RUN_ID}`,
  });
  const database = harness(rpc("get_launch_agent_activity", []));
  const page = await getAgentActivityPage({
    userId: USER_ID,
    agentId: AGENT_ID,
    recentLimit: 3,
    cursor,
  }, dependencies(database.fetchFn));

  assertEquals(page.activity.items, []);
  assertEquals(database.calls[0].body, {
    p_user_id: USER_ID,
    p_agent_id: AGENT_ID,
    p_recent_limit: 4,
    p_cursor_at: "2026-07-23T15:55:00.000Z",
    p_cursor_key: `run:${RUN_ID}`,
    p_include_upcoming: false,
  });
});

Deno.test("unsafe activity destinations fail closed", async () => {
  const failure = await assertRejects(
    async () =>
      mapAgentActivityRows([
        activityRow({ detail_url: "https://evil.example/steal" }),
      ], {
        agentId: AGENT_ID,
        recentLimit: 3,
        now: NOW,
      }),
    AgentOperatorStoreError,
  );
  assertEquals(failure.code, "SERVICE_UNAVAILABLE");
});
