import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  executeOperatorItemRemediation,
  OperatorItemExecutionError,
} from "./operator-item-execution.ts";
import { AgentHomeRevisionError } from "./agent-home-revision.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "22222222-2222-4222-8222-222222222222";
const ROUTINE_ID = "33333333-3333-4333-8333-333333333333";
const ITEM_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";
const LEASE_TOKEN = "77777777-7777-4777-8777-777777777777";
const IDEMPOTENCY_KEY = "88888888-8888-4888-8888-888888888888";
const REVISION = `ah1:${APP_ID}:9`;

Deno.test("operator item execution resolves the canonical target and queues one durable paused run", async () => {
  const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const response = await executeOperatorItemRemediation({
    userId: USER_ID,
    itemId: ITEM_ID,
    remediationId: "run_once:canonical",
    idempotencyKey: IDEMPOTENCY_KEY,
    expectedRevision: REVISION,
    authSource: "supabase",
  }, {
    now: () => new Date("2026-07-24T19:00:00.000Z"),
    resolve: async (input) => {
      calls.push({ kind: "resolve", input });
      return { appId: APP_ID, routineId: ROUTINE_ID };
    },
    claim: async (input) => {
      calls.push({ kind: "claim", input });
      return {
        requestId: REQUEST_ID,
        leaseToken: LEASE_TOKEN,
        isNew: true,
        status: "in_progress",
        response: {},
        requestFingerprint: "a".repeat(64),
        currentRevision: REVISION,
      };
    },
    queue: async (input) => {
      calls.push({ kind: "queue", input });
      return { runId: RUN_ID, isNew: true };
    },
    complete: async (input) => {
      calls.push({ kind: "complete", input });
      return {
        requestId: REQUEST_ID,
        status: "completed",
        response: input.response,
      };
    },
  });

  assertEquals(response, {
    itemId: ITEM_ID,
    remediationId: "run_once:canonical",
    action: "run_once",
    requestId: REQUEST_ID,
    runId: RUN_ID,
    state: "queued",
    scheduleState: "paused",
    replayed: false,
    generatedAt: "2026-07-24T19:00:00.000Z",
  });
  assertEquals(calls.map(({ kind }) => kind), [
    "resolve",
    "claim",
    "queue",
    "complete",
  ]);
  assertEquals(calls[1]?.input.requestPayload, {
    routineId: ROUTINE_ID,
    operatorItemId: ITEM_ID,
    remediationId: "run_once:canonical",
  });
  assertEquals(calls[2]?.input, {
    appId: APP_ID,
    userId: USER_ID,
    routineId: ROUTINE_ID,
    itemId: ITEM_ID,
    remediationId: "run_once:canonical",
    requestId: REQUEST_ID,
    leaseToken: LEASE_TOKEN,
    expectedRevision: REVISION,
    authSource: "supabase",
  });
});

Deno.test("operator item execution replays the original run without queueing again", async () => {
  let queued = false;
  const response = await executeOperatorItemRemediation({
    userId: USER_ID,
    itemId: ITEM_ID,
    remediationId: "run_once:canonical",
    idempotencyKey: IDEMPOTENCY_KEY,
    expectedRevision: REVISION,
    authSource: "supabase",
  }, {
    now: () => new Date("2026-07-24T19:01:00.000Z"),
    resolve: async () => ({ appId: APP_ID, routineId: ROUTINE_ID }),
    claim: async () => ({
      requestId: REQUEST_ID,
      leaseToken: LEASE_TOKEN,
      isNew: false,
      status: "completed",
      response: {
        code: "OPERATOR_ITEM_ACTION_QUEUED",
        itemId: ITEM_ID,
        remediationId: "run_once:canonical",
        action: "run_once",
        requestId: REQUEST_ID,
        runId: RUN_ID,
        state: "queued",
        scheduleState: "paused",
      },
      requestFingerprint: "b".repeat(64),
      currentRevision: REVISION,
    }),
    queue: async () => {
      queued = true;
      return { runId: RUN_ID, isNew: false };
    },
  });

  assertEquals(queued, false);
  assertEquals(response.runId, RUN_ID);
  assertEquals(response.replayed, true);
});

Deno.test("operator item execution reports an unknown acknowledgement without retrying the queued side effect", async () => {
  const error = await assertRejects(
    () =>
      executeOperatorItemRemediation({
        userId: USER_ID,
        itemId: ITEM_ID,
        remediationId: "run_once:canonical",
        idempotencyKey: IDEMPOTENCY_KEY,
        expectedRevision: REVISION,
        authSource: "supabase",
      }, {
        resolve: async () => ({ appId: APP_ID, routineId: ROUTINE_ID }),
        claim: async () => ({
          requestId: REQUEST_ID,
          leaseToken: LEASE_TOKEN,
          isNew: true,
          status: "in_progress",
          response: {},
          requestFingerprint: "c".repeat(64),
          currentRevision: REVISION,
        }),
        queue: async () => ({ runId: RUN_ID, isNew: true }),
        complete: async () => {
          throw new Error("acknowledgement lost");
        },
      }),
    OperatorItemExecutionError,
  );
  assertEquals(error.code, "STATUS_UNKNOWN");
  assertEquals(error.status, 503);
});

Deno.test("operator item execution durably fails a rejected queue claim without masking the domain error", async () => {
  const completions: Array<Record<string, unknown>> = [];
  const queueError = new AgentHomeRevisionError({
    code: "OPERATOR_ITEM_NOT_ACTIVE",
    status: 409,
    message: "This issue is no longer active.",
  });
  const error = await assertRejects(
    () =>
      executeOperatorItemRemediation({
        userId: USER_ID,
        itemId: ITEM_ID,
        remediationId: "run_once:canonical",
        idempotencyKey: IDEMPOTENCY_KEY,
        expectedRevision: REVISION,
        authSource: "supabase",
      }, {
        resolve: async () => ({ appId: APP_ID, routineId: ROUTINE_ID }),
        claim: async () => ({
          requestId: REQUEST_ID,
          leaseToken: LEASE_TOKEN,
          isNew: true,
          status: "in_progress",
          response: {},
          requestFingerprint: "d".repeat(64),
          currentRevision: REVISION,
        }),
        queue: async () => {
          throw queueError;
        },
        complete: async (input) => {
          completions.push(input);
          return {
            requestId: REQUEST_ID,
            status: "failed",
            response: input.response,
          };
        },
      }),
    AgentHomeRevisionError,
  );

  assertEquals(error, queueError);
  assertEquals(completions.length, 1);
  assertEquals(completions[0]?.status, "failed");
  assertEquals(completions[0]?.response, {
    code: "OPERATOR_ITEM_NOT_ACTIVE",
    error: "This issue is no longer active.",
    status: 409,
  });
});
