// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type LaunchAgentHomeRequirement,
  OPERATOR_ISSUE_POLICY,
} from "../../shared/contracts/launch.ts";
import {
  compileOperatorItem,
  compileOperatorItems,
  OperatorIssueCompilerError,
  type OperatorIssueCompilerInput,
} from "./operator-issue-compiler.ts";

const DETECTED_AT = "2026-07-24T16:00:00.000Z";
const AGENT_A = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Canonical Journey",
};
const AGENT_B = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Inbox Agent",
};
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

function requirement(
  overrides: Partial<LaunchAgentHomeRequirement> = {},
): LaunchAgentHomeRequirement {
  return {
    id: "setting:IMAP_PASSWORD",
    actionId: "IMAP_PASSWORD",
    kind: "setting",
    label: "IMAP password",
    description: "Connect the inbox.",
    required: true,
    configured: false,
    blocking: true,
    secret: true,
    settingKey: "IMAP_PASSWORD",
    settingScope: "agent",
    input: "password",
    placeholder: null,
    help: null,
    group: "Inbox",
    destination: null,
    updatedAt: null,
    actions: ["set"],
    ...overrides,
  };
}

function setupInput(
  setupRequirement: LaunchAgentHomeRequirement,
  overrides: Partial<
    Extract<OperatorIssueCompilerInput, { condition: "setup_requirement" }>
  > = {},
): Extract<OperatorIssueCompilerInput, { condition: "setup_requirement" }> {
  return {
    condition: "setup_requirement",
    agent: AGENT_A,
    requirement: setupRequirement,
    detectedAt: DETECTED_AT,
    ...overrides,
  };
}

Deno.test("operator issue policy locks backend intent and explicit resume", () => {
  assertEquals(OPERATOR_ISSUE_POLICY.remediationAuthority, "server_registry");
  assertEquals(OPERATOR_ISSUE_POLICY.navigationContract, "semantic_target");
  assertEquals(
    OPERATOR_ISSUE_POLICY.scheduledResumeAfterRecovery,
    "explicit_owner_action",
  );
  assertEquals(
    OPERATOR_ISSUE_POLICY.blockerOrdering,
    "dependency_then_source_order",
  );
});

Deno.test("compiler produces an inline write-only secret remediation without a URL", () => {
  const item = compileOperatorItem(setupInput(requirement()));

  assertEquals(item?.itemClass, "issue");
  assertEquals(item?.diagnosis.code, "AGENT_SECRET_MISSING");
  assertEquals(item?.requiresDecision, false);
  assertEquals(item?.affectedAgents, [{
    agentId: AGENT_A.id,
    blocking: true,
  }]);
  assertEquals(item?.remediations, [{
    id:
      `agent:${AGENT_A.id}:requirement:setting%3AIMAP_PASSWORD:remediation:configure_secret`,
    key: "configure_secret",
    label: "Add IMAP password",
    description: "The value is write-only and never appears in issue data.",
    presentation: "inline",
    requiredAuthority: "account_session",
    sideEffect: "configuration_write",
    target: {
      kind: "agent_setting",
      agentId: AGENT_A.id,
      settingKey: "IMAP_PASSWORD",
      settingScope: "agent",
    },
  }]);
  assertEquals(JSON.stringify(item).includes("href"), false);
  assertEquals(JSON.stringify(item).includes("Connect the inbox."), false);
});

Deno.test("compiler omits already configured and non-actionable requirements", () => {
  assertEquals(
    compileOperatorItem(setupInput(requirement({ configured: true }))),
    null,
  );
  assertEquals(
    compileOperatorItem(setupInput(requirement({
      kind: "release",
      id: "release:1.0.0",
      actionId: "1.0.0",
      settingKey: null,
      settingScope: null,
      secret: false,
      required: false,
      blocking: false,
      actions: [],
    }))),
    null,
  );
});

Deno.test("compiler coalesces one account BYOK blocker across affected Agents", () => {
  const byok = requirement({
    id: "inference:byok",
    actionId: null,
    kind: "capability",
    label: "BYOK inference provider",
    settingKey: null,
    settingScope: null,
    secret: true,
    actions: [],
  });
  const items = compileOperatorItems([
    setupInput(byok, { agent: AGENT_A }),
    setupInput(byok, { agent: AGENT_B }),
  ]);

  assertEquals(items.length, 1);
  assertEquals(items[0]?.conditionKey, "account:byok");
  assertEquals(items[0]?.scope, { kind: "account" });
  assertEquals(items[0]?.affectedAgents, [
    { agentId: AGENT_A.id, blocking: true },
    { agentId: AGENT_B.id, blocking: true },
  ]);
  assertEquals(items[0]?.remediations[0]?.key, "configure_provider");
  assertEquals(items[0]?.requiresDecision, false);
  assertEquals(items[0]?.recovery.resumesScheduledWork, false);
});

Deno.test("compiler orders by dependency before stable source order, never by type", () => {
  const credentialKey =
    `agent:${AGENT_A.id}:requirement:setting%3AIMAP_PASSWORD`;
  const releaseKey = `agent:${AGENT_A.id}:requirement:release%3A2.0.0`;
  const items = compileOperatorItems([
    setupInput(
      requirement({
        id: "release:2.0.0",
        actionId: "2.0.0",
        kind: "release",
        label: "version 2.0.0",
        required: false,
        blocking: false,
        secret: false,
        settingKey: null,
        settingScope: null,
        actions: ["promote"],
      }),
      {
        sourceOrdinal: 0,
        dependsOnConditionKeys: [credentialKey],
      },
    ),
    setupInput(requirement(), {
      sourceOrdinal: 10,
    }),
  ]);

  assertEquals(items.map((item) => item.conditionKey), [
    credentialKey,
    releaseKey,
  ]);
});

Deno.test("compiler rejects dependency cycles", () => {
  const firstKey = `agent:${AGENT_A.id}:requirement:setting%3AFIRST`;
  const secondKey = `agent:${AGENT_A.id}:requirement:setting%3ASECOND`;
  const error = assertThrows(
    () =>
      compileOperatorItems([
        setupInput(
          requirement({
            id: "setting:FIRST",
            actionId: "FIRST",
            label: "First",
            settingKey: "FIRST",
          }),
          {
            dependsOnConditionKeys: [secondKey],
          },
        ),
        setupInput(
          requirement({
            id: "setting:SECOND",
            actionId: "SECOND",
            label: "Second",
            settingKey: "SECOND",
          }),
          {
            dependsOnConditionKeys: [firstKey],
          },
        ),
      ]),
    OperatorIssueCompilerError,
  );
  assertEquals(error.code, "DEPENDENCY_CYCLE");
});

Deno.test("paused failure combines safe diagnostics with platform-owned actions", () => {
  const item = compileOperatorItem({
    condition: "routine_paused_after_failures",
    agent: AGENT_A,
    routine: {
      id: ROUTINE_ID,
      name: "Canonical Journey Loop",
    },
    failedAttempts: 10,
    latestRunId: RUN_ID,
    diagnostic: {
      causeCode: "CONNECTION_TIMEOUT",
      summary: "The configured service did not respond",
      detail: "The latest attempt reached the connection timeout.",
      provenance: "developer",
      suggestedActions: ["open_routine", "open_logs"],
      evidence: [],
    },
    detectedAt: DETECTED_AT,
  });

  assertEquals(item?.diagnosis, {
    code: "ROUTINE_PAUSED_AFTER_FAILURES",
    causeCode: "CONNECTION_TIMEOUT",
    summary: "The configured service did not respond",
    detail: "The latest attempt reached the connection timeout.",
    provenance: "combined",
    evidence: [],
  });
  assertEquals(item?.remediations.map((action) => action.key), [
    "open_routine",
    "open_logs",
    "inspect_run",
    "run_once",
  ]);
  assertEquals(
    item?.remediations.every((action) =>
      (action.target as { kind: string }).kind !== "external_url"
    ),
    true,
    "developer hints can only reorder compiler-owned semantic targets",
  );
  assertEquals(
    item?.remediations.at(-1)?.description,
    "Runs real work and uses usage, but leaves scheduled execution paused.",
  );
  assertEquals(item?.recovery, {
    mode: "successful_verification",
    mayRecoverAutomatically: true,
    resumesScheduledWork: false,
  });
});

Deno.test("routine and account usage exhaustion compile as reports without actions", () => {
  const items = compileOperatorItems([
    {
      condition: "routine_usage_exhausted",
      agent: AGENT_A,
      routine: {
        id: ROUTINE_ID,
        name: "Canonical Journey Loop",
      },
      period: "daily",
      spent: 0.038,
      limit: 0.02,
      resetsAt: "2026-07-25T00:00:00.000Z",
      detectedAt: DETECTED_AT,
    },
    {
      condition: "account_usage_exhausted",
      affectedAgents: [AGENT_A, AGENT_B],
      period: "weekly",
      resetsAt: "2026-07-28T00:00:00.000Z",
      detectedAt: DETECTED_AT,
    },
  ]);

  assertEquals(
    items.map((item) => ({
      itemClass: item.itemClass,
      requiresAction: item.requiresAction,
      requiresDecision: item.requiresDecision,
      remediations: item.remediations,
      recovery: item.recovery,
    })),
    [
      {
        itemClass: "report",
        requiresAction: false,
        requiresDecision: false,
        remediations: [],
        recovery: {
          mode: "automatic_reset",
          mayRecoverAutomatically: true,
          resumesScheduledWork: false,
        },
      },
      {
        itemClass: "report",
        requiresAction: false,
        requiresDecision: false,
        remediations: [],
        recovery: {
          mode: "automatic_reset",
          mayRecoverAutomatically: true,
          resumesScheduledWork: false,
        },
      },
    ],
  );
});
