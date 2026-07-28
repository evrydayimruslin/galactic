// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  LaunchAgentHomeRequirement,
} from "../../shared/contracts/launch.ts";
import type {
  ReconcileOperatorItemsInput,
  ReconcileOperatorItemsResult,
} from "./operator-item-persistence.ts";
import {
  OPERATOR_ITEM_SOURCE,
  reconcileAccountByokOperatorItem,
  reconcileAccountUsageOperatorItems,
  reconcileAgentSetupOperatorItems,
  reconcileRoutineUsageOperatorItem,
  recordRoutinePausedOperatorItem,
  recoverRoutineHealthOperatorItem,
  runOperatorItemProducerBestEffort,
  scheduleOperatorItemProducer,
} from "./operator-item-producers.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
const OBSERVED_AT = "2026-07-24T18:00:00.000Z";

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

function captureReconciliations(): {
  calls: ReconcileOperatorItemsInput[];
  reconcile: (
    input: ReconcileOperatorItemsInput,
  ) => Promise<ReconcileOperatorItemsResult>;
} {
  const calls: ReconcileOperatorItemsInput[] = [];
  return {
    calls,
    reconcile(input) {
      calls.push(input);
      return Promise.resolve({
        observedCount: input.items.length,
        insertedCount: input.items.length,
        updatedCount: 0,
        recoveredCount: 0,
        items: input.items.map((item, index) => ({
          id: `${
            String(index + 1).padStart(8, "0")
          }-0000-4000-8000-000000000000`,
          conditionKey: item.conditionKey,
          created: true,
        })),
      });
    },
  };
}

Deno.test("operator producers: Agent setup owns only local requirements", async () => {
  const captured = captureReconciliations();
  await reconcileAgentSetupOperatorItems({
    userId: USER_ID,
    agent: AGENT_A,
    requirements: [
      requirement(),
      requirement({
        id: "inference:byok",
        actionId: null,
        kind: "capability",
        label: "BYOK inference provider",
        settingKey: null,
        settingScope: null,
        input: null,
        secret: true,
        actions: [],
      }),
      requirement({
        id: "reporting:galactic_inbox",
        actionId: null,
        kind: "capability",
        label: "Galactic inbox reporting",
        settingKey: null,
        settingScope: null,
        input: null,
        secret: false,
        actions: [],
      }),
    ],
    observedAt: OBSERVED_AT,
  }, captured);

  assertEquals(captured.calls.length, 1);
  assertEquals(
    captured.calls[0]?.sourceKey,
    OPERATOR_ITEM_SOURCE.agentSetup(AGENT_A.id),
  );
  assertEquals(captured.calls[0]?.completeSnapshot, true);
  assertEquals(
    captured.calls[0]?.items.map((item) => item.diagnosis.code),
    ["AGENT_SECRET_MISSING", "AGENT_REPORTING_NOT_CONFIGURED"],
  );
  assertEquals(
    captured.calls[0]?.items.map((item) => item.ordering.sourceOrdinal),
    [0, 1],
  );
});

Deno.test("operator producers: account BYOK is one stable shared blocker", async () => {
  const captured = captureReconciliations();
  await reconcileAccountByokOperatorItem({
    userId: USER_ID,
    configured: false,
    affectedAgents: [AGENT_B, AGENT_A, AGENT_B],
    observedAt: OBSERVED_AT,
  }, captured);

  const open = captured.calls[0]!;
  assertEquals(open.sourceKey, OPERATOR_ITEM_SOURCE.accountByok);
  assertEquals(open.completeSnapshot, true);
  assertEquals(open.items.length, 1);
  assertEquals(open.items[0]?.conditionKey, "account:byok");
  assertEquals(open.items[0]?.affectedAgents, [
    { agentId: AGENT_A.id, blocking: true },
    { agentId: AGENT_B.id, blocking: true },
  ]);

  await reconcileAccountByokOperatorItem({
    userId: USER_ID,
    configured: true,
    affectedAgents: [AGENT_A, AGENT_B],
    observedAt: "2026-07-24T18:01:00.000Z",
  }, captured);
  assertEquals(captured.calls[1]?.items, []);
  assertEquals(captured.calls[1]?.completeSnapshot, true);
});

Deno.test("operator producers: paused routine is partial and run-specific", async () => {
  const captured = captureReconciliations();
  await recordRoutinePausedOperatorItem({
    userId: USER_ID,
    agent: AGENT_A,
    routine: { id: ROUTINE_ID, name: "Canonical Journey Loop" },
    failedAttempts: 10,
    latestRunId: RUN_ID,
    diagnostic: {
      version: 1,
      code: "DEVELOPER_ERROR",
      causeCode: "CONNECTION_TIMEOUT",
      summary: "The configured service did not respond.",
      detail: "The connection timed out after the bounded attempt.",
      provenance: "developer",
      retryable: true,
      suggestedActions: [],
      redacted: false,
    },
    observedAt: OBSERVED_AT,
  }, captured);

  const call = captured.calls[0]!;
  assertEquals(
    call.sourceKey,
    OPERATOR_ITEM_SOURCE.routineHealth(ROUTINE_ID),
  );
  assertEquals(call.completeSnapshot, false);
  assertEquals(call.items[0]?.diagnosis, {
    code: "ROUTINE_PAUSED_AFTER_FAILURES",
    causeCode: "CONNECTION_TIMEOUT",
    summary: "The configured service did not respond.",
    detail: "The connection timed out after the bounded attempt.",
    provenance: "combined",
    evidence: [{
      kind: "run",
      sourceId: RUN_ID,
      label: "Latest failed run",
      observedAt: OBSERVED_AT,
    }],
  });
});

Deno.test("operator producers: successful verification recovers only the routine health source", async () => {
  const captured = captureReconciliations();
  await recoverRoutineHealthOperatorItem({
    userId: USER_ID,
    routineId: ROUTINE_ID,
    observedAt: "2026-07-24T18:05:00.000Z",
  }, captured);

  assertEquals(captured.calls, [{
    userId: USER_ID,
    sourceKey: OPERATOR_ITEM_SOURCE.routineHealth(ROUTINE_ID),
    items: [],
    observedAt: "2026-07-24T18:05:00.000Z",
    completeSnapshot: true,
  }]);
});

Deno.test("operator producers: routine usage complete snapshots recover at recheck", async () => {
  const captured = captureReconciliations();
  const base = {
    userId: USER_ID,
    agent: AGENT_A,
    routine: { id: ROUTINE_ID, name: "Canonical Journey Loop" },
    observedAt: OBSERVED_AT,
  };
  await reconcileRoutineUsageOperatorItem({
    ...base,
    gate: {
      period: "daily" as const,
      spent: 0.038,
      limit: 0.02,
      resetsAt: "2026-07-25T00:00:00.000Z",
    },
  }, captured);
  await reconcileRoutineUsageOperatorItem({
    ...base,
    observedAt: "2026-07-25T00:01:00.000Z",
    gate: null,
  }, captured);

  assertEquals(
    captured.calls[0]?.items[0]?.diagnosis.code,
    "ROUTINE_USAGE_EXHAUSTED",
  );
  assertEquals(captured.calls[1]?.items, []);
  assertEquals(captured.calls[1]?.completeSnapshot, true);
});

Deno.test("operator producers: account usage emits only the weekly window", async () => {
  const captured = captureReconciliations();
  await reconcileAccountUsageOperatorItems({
    userId: USER_ID,
    status: {
      weekly: {
        state: "waiting",
        resetsAt: "2026-07-27T00:00:00.000Z",
      },
    },
    affectedAgents: [AGENT_B, AGENT_A],
    observedAt: OBSERVED_AT,
  }, captured);

  const items = captured.calls[0]!.items;
  assertEquals(items.map((item) => item.conditionKey), [
    "account:usage:weekly:2026-07-27T00%3A00%3A00.000Z",
  ]);
  assertEquals(
    items.map((item) => item.affectedAgents.map((agent) => agent.agentId)),
    [[AGENT_A.id, AGENT_B.id]],
  );
});

Deno.test("operator producers: best-effort isolation never logs an error message", async () => {
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  await runOperatorItemProducerBestEffort(
    OPERATOR_ITEM_SOURCE.accountByok,
    () =>
      Promise.reject(
        new Error("sk-secret-that-must-never-appear"),
      ),
    (message, fields) => logs.push({ message, fields }),
  );

  assertEquals(logs, [{
    message: "[OPERATOR-ITEMS] producer reconciliation failed",
    fields: {
      sourceKey: OPERATOR_ITEM_SOURCE.accountByok,
      errorCode: "Error",
    },
  }]);
  assertEquals(JSON.stringify(logs).includes("sk-secret"), false);
});

Deno.test("operator producers: non-Worker scheduling has an owned lifetime", async () => {
  const priorContext = (globalThis as {
    __ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).__ctx;
  delete (globalThis as { __ctx?: unknown }).__ctx;
  let completed = false;
  try {
    await scheduleOperatorItemProducer(
      OPERATOR_ITEM_SOURCE.accountByok,
      async () => {
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("owned"),
        );
        completed = true;
      },
    );
  } finally {
    if (priorContext) {
      (globalThis as { __ctx?: typeof priorContext }).__ctx = priorContext;
    }
  }
  assertEquals(completed, true);
});

Deno.test("operator producers: Worker scheduling extends lifetime without blocking", async () => {
  const priorContext = (globalThis as {
    __ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).__ctx;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ownedTasks: Promise<unknown>[] = [];
  let completed = false;
  (globalThis as {
    __ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).__ctx = {
    waitUntil(promise) {
      ownedTasks.push(promise);
    },
  };
  try {
    await scheduleOperatorItemProducer(
      OPERATOR_ITEM_SOURCE.accountUsage,
      async () => {
        await gate;
        completed = true;
      },
    );
    assertEquals(completed, false);
    assertEquals(ownedTasks.length, 1);
    release();
    await Promise.all(ownedTasks);
    assertEquals(completed, true);
  } finally {
    if (priorContext) {
      (globalThis as { __ctx?: typeof priorContext }).__ctx = priorContext;
    } else {
      delete (globalThis as { __ctx?: unknown }).__ctx;
    }
  }
});
