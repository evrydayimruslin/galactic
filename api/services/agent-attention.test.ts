import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  LaunchAgentAttentionActionRequest,
} from "../../shared/contracts/launch.ts";
import {
  type AgentAttentionBriefRow,
  type AgentAttentionNotificationRow,
  AgentAttentionStoreError,
  buildAgentAttentionProjection,
  formatAgentAttentionCursor,
  readAgentAttention,
  readAgentAttentionPage,
  readOwnerAttention,
  transitionAgentAttention,
} from "./agent-attention.ts";
import {
  deriveNotificationBriefAction,
  type RawNotificationEvidence,
} from "./operator-projections.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const NOTIFICATION_ID = "33333333-3333-4333-8333-333333333333";
const ROUTINE_ID = "55555555-5555-4555-8555-555555555555";
const GRANT_ID = "66666666-6666-4666-8666-666666666666";

type EnvGlobal = typeof globalThis & { __env?: Record<string, unknown> };

function withDatabaseEnv(): () => void {
  const global = globalThis as EnvGlobal;
  const previous = global.__env;
  global.__env = {
    ...(previous || {}),
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  };
  return () => {
    global.__env = previous;
  };
}

function notification(
  overrides: Partial<AgentAttentionNotificationRow> = {},
): AgentAttentionNotificationRow {
  return {
    id: NOTIFICATION_ID,
    user_id: USER_ID,
    agent_id: AGENT_ID,
    kind: "missing_setting",
    severity: "warning",
    title: "Inbox credential missing",
    body: "The inbox cannot be checked.",
    entity_type: "setting",
    entity_id: "IMAP_PASSWORD",
    action_url: null,
    item_class: "incident",
    requires_action: true,
    lifecycle_state: "open",
    state_changed_at: "2026-07-23T10:00:00.000Z",
    snoozed_until: null,
    resolved_at: null,
    resolution_reason: null,
    archived_at: null,
    created_at: "2026-07-23T10:00:00.000Z",
    read_at: null,
    ...overrides,
  };
}

function brief(
  overrides: Partial<AgentAttentionBriefRow> = {},
): AgentAttentionBriefRow {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    notification_id: NOTIFICATION_ID,
    revision: 1,
    source_hash: "a".repeat(64),
    status: "ready",
    provider: "openai",
    model: "gpt-test",
    headline: "email-ops cannot check the inbox",
    impact: "No new email has been processed.",
    recommended_action: "Add the missing credential.",
    evidence: [{
      kind: "notification",
      sourceId: NOTIFICATION_ID,
      label: "Missing credential",
      observedAt: "2026-07-23T10:00:00.000Z",
      destination: { href: "https://attacker.example" },
    }],
    confidence: 0.9,
    action_key: "open_access_setting",
    action_parameters: {
      agentId: AGENT_ID,
      settingKey: "IMAP_PASSWORD",
      href: "https://attacker.example",
      secret: "must-never-escape",
    },
    generated_at: "2026-07-23T10:00:01.000Z",
    ...overrides,
  };
}

Deno.test("agent attention: raw notification remains useful without enrichment", () => {
  const projection = buildAgentAttentionProjection({
    agent: { id: AGENT_ID, slug: "email-ops", name: "email-ops" },
    notifications: [notification()],
    briefs: [],
    now: new Date("2026-07-23T10:01:00.000Z"),
  });
  assertEquals(projection.openCount, 1);
  assertEquals(projection.requiresDecisionCount, 1);
  assertEquals(projection.items[0]?.brief.headline, "Inbox credential missing");
  assertEquals(projection.items[0]?.enrichment.status, "raw");
  assertEquals(projection.items[0]?.actions, []);
});

Deno.test("agent attention: raw and legacy enriched text cannot expose credential-shaped values", () => {
  const secret = ["gx_", "attentionSecret123456789"].join("");
  const projection = buildAgentAttentionProjection({
    agent: { id: AGENT_ID, slug: "email-ops", name: "email-ops" },
    notifications: [notification({
      kind: `missing:${secret}`,
      title: `Inbox credential ${secret} is invalid`,
      body: `Replace token=${secret} before retrying.`,
    })],
    briefs: [brief({
      headline: `Agent rejected ${secret}`,
      impact: `The credential ${secret} is unusable.`,
      recommended_action: `Replace token=${secret}.`,
      evidence: [{
        kind: "notification",
        sourceId: NOTIFICATION_ID,
        label: `Credential ${secret}`,
      }],
    })],
  });

  const serialized = JSON.stringify(projection);
  assertEquals(serialized.includes(secret), false);
  assertEquals(serialized.includes("[redacted]"), true);
});

Deno.test("agent attention: ready brief keeps only server-allowlisted action parameters", () => {
  const projection = buildAgentAttentionProjection({
    agent: { id: AGENT_ID, slug: "email-ops", name: "email-ops" },
    notifications: [notification()],
    briefs: [brief()],
  });
  const item = projection.items[0]!;
  assertEquals(item.brief.headline, "email-ops cannot check the inbox");
  assertEquals(item.actions[0]?.parameters, {
    agentId: AGENT_ID,
    settingKey: "IMAP_PASSWORD",
  });
  assertEquals(
    item.actions[0]?.destination?.href,
    "/agents/email-ops?pane=access&item=setting%3AIMAP_PASSWORD",
  );
  assertEquals(JSON.stringify(item).includes("attacker.example"), false);
  assertEquals(JSON.stringify(item).includes("must-never-escape"), false);
});

Deno.test("agent attention: persisted secret-shaped action identifiers fail closed", () => {
  const galacticSecret = ["gx_", "persistedActionSecret123456"].join("");
  const cases = [
    {
      actionKey: "open_access_setting",
      parameterKey: "settingKey",
      expectedParameters: { agentId: AGENT_ID },
      expectedHref: "/agents/email-ops?pane=access",
    },
    {
      actionKey: "open_release_review",
      parameterKey: "releaseId",
      expectedParameters: { agentId: AGENT_ID },
      expectedHref: "/agents/email-ops?pane=settings&item=release",
    },
    {
      actionKey: "open_routine",
      parameterKey: "routineId",
      expectedParameters: null,
      expectedHref: null,
    },
    {
      actionKey: "approve_grant",
      parameterKey: "grantId",
      expectedParameters: null,
      expectedHref: null,
    },
  ] as const;

  for (const testCase of cases) {
    const projection = buildAgentAttentionProjection({
      agent: { id: AGENT_ID, slug: "email-ops", name: "email-ops" },
      notifications: [notification()],
      briefs: [brief({
        action_key: testCase.actionKey,
        action_parameters: {
          agentId: AGENT_ID,
          [testCase.parameterKey]: galacticSecret,
        },
      })],
    });
    const action = projection.items[0]?.actions[0];
    assertEquals(action?.parameters ?? null, testCase.expectedParameters);
    assertEquals(action?.destination?.href ?? null, testCase.expectedHref);
    assertEquals(JSON.stringify(projection).includes(galacticSecret), false);
  }
});

Deno.test("projection-derived setting, release, routine, and grant actions survive the persisted Attention contract", () => {
  const cases = [
    {
      notification: {
        kind: "missing_secret",
        entity_type: "setting",
        entity_id: "IMAP_PASSWORD",
      },
      expectedParameters: {
        agentId: AGENT_ID,
        settingKey: "IMAP_PASSWORD",
      },
      expectedHref:
        "/agents/email-ops?pane=access&item=setting%3AIMAP_PASSWORD",
    },
    {
      notification: {
        kind: "release_review_required",
        entity_type: "release",
        entity_id: "release-7",
      },
      expectedParameters: { agentId: AGENT_ID, releaseId: "release-7" },
      expectedHref: "/agents/email-ops?pane=settings&item=release:release-7",
    },
    {
      notification: {
        kind: "routine_failed",
        entity_type: "routine",
        entity_id: ROUTINE_ID,
      },
      expectedParameters: { agentId: AGENT_ID, routineId: ROUTINE_ID },
      expectedHref: `/agents/email-ops?pane=routines&item=${ROUTINE_ID}`,
    },
    {
      notification: {
        kind: "grant_approval_required",
        entity_type: "grant",
        entity_id: GRANT_ID,
      },
      expectedParameters: { agentId: AGENT_ID, grantId: GRANT_ID },
      expectedHref: `/agents/email-ops?pane=access&item=grant%3A${GRANT_ID}`,
    },
  ] as const;

  for (const testCase of cases) {
    const source: RawNotificationEvidence = {
      id: NOTIFICATION_ID,
      user_id: USER_ID,
      agent_id: AGENT_ID,
      severity: "warning",
      title: "Attention required",
      body: null,
      action_url: null,
      dedupe_key: `contract:${testCase.notification.kind}`,
      created_at: "2026-07-23T10:00:00.000Z",
      item_class: "incident",
      requires_action: true,
      lifecycle_state: "open",
      ...testCase.notification,
    };
    const producerAction = deriveNotificationBriefAction(source);
    if (!producerAction) {
      throw new Error(`Expected action for ${source.kind}`);
    }
    const projection = buildAgentAttentionProjection({
      agent: { id: AGENT_ID, slug: "email-ops", name: "email-ops" },
      notifications: [notification({
        kind: source.kind,
        entity_type: source.entity_type,
        entity_id: source.entity_id,
      })],
      briefs: [brief({
        action_key: producerAction.key,
        action_parameters: producerAction.parameters,
      })],
    });

    assertEquals(
      projection.items[0]?.actions[0]?.parameters,
      testCase.expectedParameters,
    );
    assertEquals(
      projection.items[0]?.actions[0]?.destination?.href,
      testCase.expectedHref,
    );
  }
});

Deno.test("agent attention: invalid or arbitrary enriched action is inert", () => {
  const projection = buildAgentAttentionProjection({
    agent: { id: AGENT_ID, slug: "email-ops", name: "email-ops" },
    notifications: [notification()],
    briefs: [brief({
      action_key: "delete_everything",
      action_parameters: { href: "https://attacker.example" },
    })],
  });
  assertEquals(projection.items[0]?.actions, []);
});

Deno.test("agent attention: read reports are omitted while open incidents remain", () => {
  const projection = buildAgentAttentionProjection({
    agent: { id: AGENT_ID, slug: "email-ops", name: "email-ops" },
    notifications: [
      notification(),
      notification({
        id: "55555555-5555-4555-8555-555555555555",
        kind: "agent_report",
        item_class: "report",
        requires_action: false,
        title: "Daily report",
        read_at: "2026-07-23T10:02:00.000Z",
      }),
    ],
  });
  assertEquals(projection.items.map((item) => item.type), ["incident"]);
});

Deno.test("owner attention: aggregates owned Agents and reactivates expired snoozes", async () => {
  const restore = withDatabaseEnv();
  const otherAgentId = "66666666-6666-4666-8666-666666666666";
  const expiredId = "77777777-7777-4777-8777-777777777777";
  const futureId = "88888888-8888-4888-8888-888888888888";
  try {
    const projection = await readOwnerAttention(
      USER_ID,
      [
        { id: AGENT_ID, slug: "email-ops", name: "Email Ops" },
        { id: otherAgentId, slug: "signal-watch", name: "Signal Watch" },
      ],
      {
        now: new Date("2026-07-23T12:00:00.000Z"),
        fetchFn: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/rpc/get_owner_attention_page")) {
            return new Response(
              JSON.stringify([{
                notifications: [
                  notification(),
                  notification({
                    id: expiredId,
                    agent_id: otherAgentId,
                    lifecycle_state: "snoozed",
                    snoozed_until: "2026-07-23T11:59:00.000Z",
                    created_at: "2026-07-23T11:00:00.000Z",
                  }),
                ],
                per_agent_counts: [
                  {
                    agent_id: AGENT_ID,
                    open_count: 1,
                    requires_decision_count: 1,
                  },
                  {
                    agent_id: otherAgentId,
                    open_count: 1,
                    requires_decision_count: 1,
                  },
                ],
                open_count: "2",
                requires_decision_count: 2,
                next_before_created_at: null,
                next_before_id: null,
              }]),
              { status: 200 },
            );
          }
          if (url.includes("/notification_briefs?")) {
            return new Response("[]", { status: 200 });
          }
          return new Response("[]", { status: 200 });
        },
      },
    );
    assertEquals(projection.openCount, 2);
    assertEquals(
      projection.entries.map((entry) => [
        entry.agent.slug,
        entry.item.notificationId,
      ]),
      [
        ["signal-watch", expiredId],
        ["email-ops", NOTIFICATION_ID],
      ],
    );
    assertEquals(
      projection.entries.some((entry) =>
        entry.item.notificationId === futureId
      ),
      false,
    );
  } finally {
    restore();
  }
});

Deno.test("owner attention uses a fixed-size owner RPC for 1,000 Agents and preserves exact counts", async () => {
  const restore = withDatabaseEnv();
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> =
    [];
  const agents = [
    { id: AGENT_ID, slug: "email-ops", name: "Email Ops" },
    ...Array.from({ length: 999 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, "0");
      return {
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
        slug: `agent-${index + 1}`,
        name: `Agent ${index + 1}`,
      };
    }),
  ];
  try {
    const projection = await readOwnerAttention(USER_ID, agents, {
      now: new Date("2026-07-23T12:00:00.000Z"),
      fetchFn: async (input, init) => {
        const url = String(input);
        const rawBody = "body" in (init || {})
          ? (init as { body?: unknown }).body
          : null;
        const body = rawBody
          ? JSON.parse(String(rawBody)) as Record<string, unknown>
          : null;
        calls.push({ url, body });
        if (url.endsWith("/rpc/get_owner_attention_page")) {
          return new Response(
            JSON.stringify([{
              notifications: [notification()],
              per_agent_counts: [{
                agent_id: AGENT_ID,
                open_count: 947,
                requires_decision_count: 613,
              }],
              open_count: 947,
              requires_decision_count: "613",
              next_before_created_at: null,
              next_before_id: null,
            }]),
            { status: 200 },
          );
        }
        if (url.includes("/notification_briefs?")) {
          return new Response("[]", { status: 200 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    assertEquals(projection.entries.length, 1);
    assertEquals(projection.openCount, 947);
    assertEquals(projection.requiresDecisionCount, 613);
    const snapshotCall = calls.find((call) =>
      call.url.endsWith("/rpc/get_owner_attention_page")
    );
    assertEquals(snapshotCall?.body, {
      p_user_id: USER_ID,
      p_now: "2026-07-23T12:00:00.000Z",
      p_limit: 200,
      p_before_created_at: null,
      p_before_id: null,
    });
    assertEquals(
      calls.some((call) => call.url.includes("agent_id=in.")),
      false,
    );
    assertEquals(
      Math.max(...calls.map((call) => call.url.length)) < 10_000,
      true,
    );
  } finally {
    restore();
  }
});

Deno.test("agent Attention reads rows and exact counts from one atomic page RPC", async () => {
  const restore = withDatabaseEnv();
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> =
    [];
  try {
    const projection = await readAgentAttention(
      USER_ID,
      { id: AGENT_ID, slug: "email-ops", name: "Email Ops" },
      {
        now: new Date("2026-07-23T12:00:00.000Z"),
        fetchFn: async (input, init) => {
          const url = String(input);
          const rawBody = "body" in (init || {})
            ? (init as { body?: unknown }).body
            : null;
          calls.push({
            url,
            body: rawBody
              ? JSON.parse(String(rawBody)) as Record<string, unknown>
              : null,
          });
          if (url.includes("/notification_briefs?")) {
            return new Response("[]", { status: 200 });
          }
          if (url.endsWith("/rpc/get_agent_attention_page")) {
            return new Response(JSON.stringify([{
              notifications: [notification()],
              open_count: 241,
              requires_decision_count: 173,
              next_before_created_at: "2026-07-23T10:00:00.000Z",
              next_before_id: NOTIFICATION_ID,
            }]), { status: 200 });
          }
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    );
    assertEquals(projection.items.length, 1);
    assertEquals(projection.openCount, 241);
    assertEquals(projection.requiresDecisionCount, 173);
    assertEquals(typeof projection.nextCursor, "string");
    assertEquals(
      calls.filter((call) =>
        call.url.endsWith("/rpc/get_agent_attention_page")
      ).map((call) => call.body),
      [{
        p_user_id: USER_ID,
        p_agent_id: AGENT_ID,
        p_now: "2026-07-23T12:00:00.000Z",
        p_limit: 200,
        p_before_created_at: null,
        p_before_id: null,
      }],
    );
  } finally {
    restore();
  }
});

Deno.test("agent Attention forwards an opaque cursor to the atomic page RPC", async () => {
  const restore = withDatabaseEnv();
  const bodies: Record<string, unknown>[] = [];
  const cursor = formatAgentAttentionCursor({
    occurredAt: "2026-07-23T10:00:00.000Z",
    notificationId: NOTIFICATION_ID,
  });
  try {
    const projection = await readAgentAttentionPage(
      USER_ID,
      { id: AGENT_ID, slug: "email-ops", name: "Email Ops" },
      { cursor, limit: 50 },
      {
        now: new Date("2026-07-23T12:00:00.000Z"),
        fetchFn: async (input, init) => {
          const url = String(input);
          if (!url.endsWith("/rpc/get_agent_attention_page")) {
            throw new Error(`Unexpected request: ${url}`);
          }
          bodies.push(
            JSON.parse(String((init as { body?: unknown })?.body)) as Record<
              string,
              unknown
            >,
          );
          return new Response(JSON.stringify([{
            notifications: [],
            open_count: 241,
            requires_decision_count: 173,
            next_before_created_at: null,
            next_before_id: null,
          }]), { status: 200 });
        },
      },
    );
    assertEquals(projection.items, []);
    assertEquals(projection.nextCursor, null);
    assertEquals(bodies, [{
      p_user_id: USER_ID,
      p_agent_id: AGENT_ID,
      p_now: "2026-07-23T12:00:00.000Z",
      p_limit: 50,
      p_before_created_at: "2026-07-23T10:00:00.000Z",
      p_before_id: NOTIFICATION_ID,
    }]);
  } finally {
    restore();
  }
});

Deno.test("agent attention: lifecycle transition is owner-scoped through RPC", async () => {
  const restore = withDatabaseEnv();
  const requestBodies: Record<string, unknown>[] = [];
  try {
    const lifecycle = await transitionAgentAttention(
      USER_ID,
      NOTIFICATION_ID,
      {
        action: "resolve",
        idempotencyKey: "attention-action-1",
        resolutionReason: "Recovered",
      },
      {
        now: new Date("2026-07-23T10:05:00.000Z"),
        fetchFn: async (_input, init) => {
          const body = "body" in (init || {})
            ? (init as { body?: unknown }).body
            : null;
          requestBodies.push(
            JSON.parse(String(body)) as Record<string, unknown>,
          );
          return new Response(
            JSON.stringify([{
              notification_id: NOTIFICATION_ID,
              item_class: "incident",
              lifecycle_state: "resolved",
              read_at: null,
              snoozed_until: null,
              resolved_at: "2026-07-23T10:05:00.000Z",
              archived_at: null,
            }]),
            { status: 200 },
          );
        },
      },
    );
    assertEquals(requestBodies[0]?.p_user_id, USER_ID);
    assertEquals(requestBodies[0]?.p_notification_id, NOTIFICATION_ID);
    assertEquals(lifecycle.state, "resolved");
    assertEquals(lifecycle.readAt, null);
  } finally {
    restore();
  }
});

Deno.test("agent attention: execute_brief cannot bypass handler allowlist", async () => {
  const restore = withDatabaseEnv();
  const request: LaunchAgentAttentionActionRequest = {
    action: "execute_brief",
    actionId: "brief:example",
    idempotencyKey: "attention-action-2",
  };
  try {
    await assertRejects(
      () =>
        transitionAgentAttention(USER_ID, NOTIFICATION_ID, request, {
          fetchFn: () => {
            throw new Error("must not reach the database");
          },
        }),
      AgentAttentionStoreError,
      "control-plane allowlist",
    );
  } finally {
    restore();
  }
});
