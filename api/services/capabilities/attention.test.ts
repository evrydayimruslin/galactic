// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  type CapabilityContext,
  CapabilityError,
} from "../../../shared/contracts/capabilities.ts";
import type { LaunchOperatorAttentionProjection } from "../../../shared/contracts/launch.ts";
import { attentionCapability } from "./attention.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
const AGENTS = [{
  id: AGENT_ID,
  slug: "inbox-keeper",
  name: "Inbox Keeper",
}];
const PROJECTION = {
  contractVersion: 1,
  items: [],
  agentCounts: [],
  openCount: 0,
  requiresDecisionCount: 0,
  blockingCount: 0,
  nextCursor: null,
  available: true,
  unavailableReason: null,
  generatedAt: "2026-07-24T18:00:00.000Z",
} as unknown as LaunchOperatorAttentionProjection;

function context(
  authSource: CapabilityContext["authSource"],
): CapabilityContext {
  return {
    userId: USER_ID,
    provisional: false,
    authSource,
    surface: "mcp",
  };
}

Deno.test("attention capability returns the canonical projection for MCP clients", async () => {
  let captured: unknown[] = [];
  const result = await attentionCapability(
    {
      action: "list",
      agent_id: AGENT_ID,
      limit: 25,
      cursor: "opaque-cursor",
    },
    context("api_token"),
    {
      listAgents: () => Promise.resolve(AGENTS),
      read: ((
        userId: string,
        agents: unknown,
        agentId: string | null,
        options: unknown,
      ) => {
        captured = [userId, agents, agentId, options];
        return Promise.resolve(PROJECTION);
      }) as never,
    },
  );

  assertEquals(result, PROJECTION);
  assertEquals(captured, [
    USER_ID,
    AGENTS,
    AGENT_ID,
    { cursor: "opaque-cursor", limit: 25 },
  ]);
});

Deno.test("attention capability rejects cross-owner Agent filters", async () => {
  await assertRejects(
    () =>
      attentionCapability(
        {
          action: "list",
          agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        context("api_token"),
        {
          listAgents: () => Promise.resolve(AGENTS),
          read: (() => Promise.resolve(PROJECTION)) as never,
        },
      ),
    CapabilityError,
    "Agent not found",
  );
});

Deno.test("attention capability keeps connected tokens read-only", async () => {
  for (const action of ["mark_read", "dismiss", "run_once"]) {
    await assertRejects(
      () =>
        attentionCapability(
          {
            action,
            item_id: ITEM_ID,
          },
          context("api_token"),
          {
            listAgents: () => Promise.resolve(AGENTS),
          },
        ),
      CapabilityError,
      "account session",
    );
  }
  await assertRejects(
    () =>
      attentionCapability({ action: "list" }, context("routine_actor"), {
        listAgents: () => Promise.resolve(AGENTS),
      }),
    CapabilityError,
    "account operator",
  );
});

Deno.test("attention capability delegates presentation state without changing issue truth", async () => {
  let input: unknown = null;
  const result = await attentionCapability(
    {
      action: "snooze",
      item_id: ITEM_ID,
      snoozed_until: "2026-07-25T18:00:00.000Z",
    },
    context("supabase"),
    {
      applyAttention: ((value: unknown) => {
        input = value;
        return Promise.resolve({
          itemId: ITEM_ID,
          attention: {
            state: "snoozed",
            readAt: null,
            snoozedUntil: "2026-07-25T18:00:00.000Z",
            dismissedAt: null,
          },
        });
      }) as never,
    },
  );

  assertEquals(input, {
    userId: USER_ID,
    itemId: ITEM_ID,
    action: "snooze",
    snoozedUntil: "2026-07-25T18:00:00.000Z",
  });
  assertEquals((result as { itemId: string }).itemId, ITEM_ID);
});

Deno.test("attention run_once forwards only canonical action identifiers", async () => {
  let input: Record<string, unknown> | null = null;
  await attentionCapability(
    {
      action: "run_once",
      item_id: ITEM_ID,
      remediation_id: "remediation:routine-run-once",
      idempotency_key: IDEMPOTENCY_KEY,
      expected_revision: "revision-7",
      agent_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      routine_id: "untrusted-routine",
    },
    context("supabase"),
    {
      execute: ((value: Record<string, unknown>) => {
        input = value;
        return Promise.resolve({
          itemId: ITEM_ID,
          remediationId: "remediation:routine-run-once",
          action: "run_once",
          requestId: IDEMPOTENCY_KEY,
          runId: "55555555-5555-4555-8555-555555555555",
          state: "queued",
          scheduleState: "paused",
          replayed: false,
          generatedAt: "2026-07-24T18:00:00.000Z",
        });
      }) as never,
    },
  );

  assertEquals(input, {
    userId: USER_ID,
    itemId: ITEM_ID,
    remediationId: "remediation:routine-run-once",
    idempotencyKey: IDEMPOTENCY_KEY,
    expectedRevision: "revision-7",
    authSource: "supabase",
  });
});
