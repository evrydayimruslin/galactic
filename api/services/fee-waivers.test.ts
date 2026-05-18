import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  getFeeWaiverLeaderboard,
  getPublisherFeeWaiverCredit,
  grantPublisherFeeWaiverCredit,
  parseFeeWaiverLeaderboardQuery,
} from "./fee-waivers.ts";
import { RequestValidationError } from "./request-validation.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};
const PUBLISHER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
  }
}

Deno.test("fee waivers: grants publisher credit through the atomic RPC", async () => {
  await withEnv(async () => {
    let rpcBody: Record<string, unknown> = {};
    const result = await grantPublisherFeeWaiverCredit({
      publisherUserId: PUBLISHER_ID,
      amountLight: 25.5,
      reason: "launch_reward",
      createdByUserId: ADMIN_ID,
      referenceTable: "admin_rewards",
      referenceId: "33333333-3333-4333-8333-333333333333",
      metadata: { campaign: "launch" },
    }, {
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        assertEquals(url.pathname, "/rest/v1/rpc/grant_publisher_fee_credit");
        rpcBody = JSON.parse(String(init?.body));
        return jsonResponse([{
          publisher_user_id: PUBLISHER_ID,
          balance_light: 40.5,
          lifetime_granted_light: 65.5,
          lifetime_spent_light: 25,
          ledger_id: "44444444-4444-4444-8444-444444444444",
          amount_light: 25.5,
          reason: "launch_reward",
          created_at: "2026-05-18T12:00:00Z",
        }]);
      },
    });

    assertEquals(rpcBody?.p_publisher_user_id, PUBLISHER_ID);
    assertEquals(rpcBody?.p_amount_light, 25.5);
    assertEquals(rpcBody?.p_created_by_user_id, ADMIN_ID);
    assertEquals(result.account.balance_light, 40.5);
    assertEquals(result.account.lifetime_granted_light, 65.5);
    assertEquals(result.ledger_entry.amount_light, 25.5);
    assertEquals(result.ledger_entry.metadata, { campaign: "launch" });
  });
});

Deno.test("fee waivers: returns an empty credit account with recent ledger rows", async () => {
  await withEnv(async () => {
    const seen = new Set<string>();
    const summary = await getPublisherFeeWaiverCredit(PUBLISHER_ID, {
      ledgerLimit: 5,
      fetchFn: async (input) => {
        const url = new URL(String(input));
        seen.add(url.pathname);
        if (url.pathname === "/rest/v1/publisher_fee_credit_accounts") {
          assertEquals(url.searchParams.get("publisher_user_id"), `eq.${PUBLISHER_ID}`);
          return jsonResponse([]);
        }
        if (url.pathname === "/rest/v1/publisher_fee_credit_ledger") {
          assertEquals(url.searchParams.get("limit"), "5");
          return jsonResponse([{
            id: "55555555-5555-4555-8555-555555555555",
            publisher_user_id: PUBLISHER_ID,
            amount_light: -1.5,
            balance_after_light: 0,
            kind: "spend",
            reason: "platform_fee_waiver",
            reference_table: "transfers",
            reference_id: "66666666-6666-4666-8666-666666666666",
            created_by_user_id: null,
            metadata: { reason: "tool_call" },
            created_at: "2026-05-18T12:05:00Z",
          }]);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });

    assertEquals(seen.has("/rest/v1/publisher_fee_credit_accounts"), true);
    assertEquals(seen.has("/rest/v1/publisher_fee_credit_ledger"), true);
    assertEquals(summary.account.balance_light, 0);
    assertEquals(summary.account.lifetime_granted_light, 0);
    assertEquals(summary.ledger[0].kind, "spend");
    assertEquals(summary.ledger[0].amount_light, -1.5);
  });
});

Deno.test("fee waivers: leaderboard period maps to waived-fee RPC only", async () => {
  await withEnv(async () => {
    let rpcBody: Record<string, unknown> = {};
    const leaderboard = await getFeeWaiverLeaderboard({
      period: "90d",
      limit: 10,
      now: () => new Date("2026-05-18T00:00:00Z"),
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        assertEquals(url.pathname, "/rest/v1/rpc/get_fee_waiver_leaderboard");
        rpcBody = JSON.parse(String(init?.body));
        return jsonResponse([{
          rank: 1,
          publisher_user_id: PUBLISHER_ID,
          display_name: "Publisher",
          avatar_url: null,
          profile_slug: "publisher",
          fee_waived_light: 42,
          event_count: 3,
          referral_waived_light: 30,
          fee_credit_waived_light: 12,
          marketplace_waived_light: 15,
          tool_call_waived_light: 25,
          gpu_developer_fee_waived_light: 2,
          first_waived_at: "2026-04-01T00:00:00Z",
          last_waived_at: "2026-05-17T00:00:00Z",
        }]);
      },
    });

    assertEquals(rpcBody?.p_since, "2026-02-17T00:00:00.000Z");
    assertEquals(rpcBody?.p_limit, 10);
    assertEquals(leaderboard.period, "90d");
    assertEquals(leaderboard.entries[0].fee_waived_light, 42);
    assertEquals(leaderboard.entries[0].marketplace_waived_light, 15);
  });
});

Deno.test("fee waivers: leaderboard query rejects unknown periods", () => {
  try {
    parseFeeWaiverLeaderboardQuery(
      new URL("https://example.com/api/marketplace/fee-waiver-leaderboard?period=7d"),
    );
    throw new Error("expected validation failure");
  } catch (err) {
    assertEquals(err instanceof RequestValidationError, true);
  }
});
