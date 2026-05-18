import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { handleAdmin } from "./admin.ts";
import { handleUser } from "./user.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};
const PUBLISHER_ID = "11111111-1111-4111-8111-111111111111";

interface FeeCreditHandlerBody {
  success?: boolean;
  account: { balance_light: number };
  ledger: Array<{ kind: string }>;
  ledger_entry?: { kind: string };
}

interface LeaderboardHandlerBody {
  period: string;
  entries: Array<{ rank: number; fee_waived_light: number }>;
}

interface PayoutReconciliationBody {
  fee_waivers: {
    event_count: number;
    fee_would_have_been_light: number;
    fee_waived_light: number;
    platform_fee_charged_light: number;
    by_source: Record<string, { fee_waived_light: number }>;
    by_transaction_kind: Record<string, { fee_waived_light: number }>;
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withHandlerMocks<T>(
  fetchFn: typeof fetch,
  fn: () => Promise<T>,
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  globalThis.fetch = fetchFn;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.__env = previousEnv;
  }
}

Deno.test("admin fee waiver credits: grant endpoint writes through RPC", async () => {
  const calls: string[] = [];
  await withHandlerMocks(async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/rest/v1/rpc/check_rate_limit") {
      return jsonResponse(true);
    }
    if (url.pathname === "/rest/v1/rpc/grant_publisher_fee_credit") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assertEquals(body.p_publisher_user_id, PUBLISHER_ID);
      assertEquals(body.p_amount_light, 100);
      assertEquals(body.p_reason, "launch_reward");
      return jsonResponse([{
        publisher_user_id: PUBLISHER_ID,
        balance_light: 100,
        lifetime_granted_light: 100,
        lifetime_spent_light: 0,
        ledger_id: "22222222-2222-4222-8222-222222222222",
        amount_light: 100,
        reason: "launch_reward",
        created_at: "2026-05-18T12:00:00Z",
      }]);
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const response = await handleAdmin(
      new Request("https://example.com/api/admin/fee-waiver-credits/grant", {
        method: "POST",
        headers: {
          "Authorization": "Bearer service-role-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          publisher_user_id: PUBLISHER_ID,
          amount_light: 100,
          reason: "launch_reward",
        }),
      }),
    );
    assertEquals(response.status, 201);
    const body = await response.json() as FeeCreditHandlerBody;
    assertEquals(body.success, true);
    assertEquals(body.account.balance_light, 100);
  });
  assertEquals(calls, ["/rest/v1/rpc/grant_publisher_fee_credit"]);
});

Deno.test("admin fee waiver credits: inspect endpoint returns account and ledger", async () => {
  await withHandlerMocks(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/publisher_fee_credit_accounts") {
      assertEquals(url.searchParams.get("publisher_user_id"), `eq.${PUBLISHER_ID}`);
      return jsonResponse([{
        publisher_user_id: PUBLISHER_ID,
        balance_light: 10,
        lifetime_granted_light: 15,
        lifetime_spent_light: 5,
        metadata: {},
        created_at: "2026-05-18T12:00:00Z",
        updated_at: "2026-05-18T12:05:00Z",
      }]);
    }
    if (url.pathname === "/rest/v1/publisher_fee_credit_ledger") {
      assertEquals(url.searchParams.get("limit"), "2");
      return jsonResponse([{
        id: "33333333-3333-4333-8333-333333333333",
        publisher_user_id: PUBLISHER_ID,
        amount_light: 15,
        balance_after_light: 15,
        kind: "grant",
        reason: "admin_reward",
        reference_table: null,
        reference_id: null,
        created_by_user_id: null,
        metadata: {},
        created_at: "2026-05-18T12:00:00Z",
      }]);
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const response = await handleAdmin(
      new Request(
        `https://example.com/api/admin/fee-waiver-credits/${PUBLISHER_ID}?ledger_limit=2`,
        { headers: { "Authorization": "Bearer service-role-key" } },
      ),
    );
    assertEquals(response.status, 200);
    const body = await response.json() as FeeCreditHandlerBody;
    assertEquals(body.account.balance_light, 10);
    assertEquals(body.ledger[0].kind, "grant");
  });
});

Deno.test("marketplace fee waiver leaderboard: public route returns waived-fee rankings", async () => {
  await withHandlerMocks(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/rpc/get_fee_waiver_leaderboard") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assertEquals(body.p_since, null);
      assertEquals(body.p_limit, 3);
      return jsonResponse([{
        rank: 1,
        publisher_user_id: PUBLISHER_ID,
        display_name: "Publisher",
        avatar_url: null,
        profile_slug: "publisher",
        fee_waived_light: 12,
        event_count: 2,
        referral_waived_light: 12,
        fee_credit_waived_light: 0,
        marketplace_waived_light: 4,
        tool_call_waived_light: 8,
        gpu_developer_fee_waived_light: 0,
        first_waived_at: "2026-05-01T00:00:00Z",
        last_waived_at: "2026-05-18T00:00:00Z",
      }]);
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const response = await handleUser(
      new Request(
        "https://example.com/api/marketplace/fee-waiver-leaderboard?period=all&limit=3",
      ),
    );
    assertEquals(response.status, 200);
    const body = await response.json() as LeaderboardHandlerBody;
    assertEquals(body.period, "all");
    assertEquals(body.entries[0].fee_waived_light, 12);
    assertEquals(body.entries[0].rank, 1);
  });
});

Deno.test("admin payout reconciliation includes fee-waiver totals", async () => {
  await withHandlerMocks(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/users") {
      return jsonResponse([{
        total_earned_light: 100,
        earned_balance_light: 40,
      }]);
    }
    if (url.pathname === "/rest/v1/payouts") {
      return jsonResponse([]);
    }
    if (url.pathname === "/rest/v1/payout_runs") {
      return jsonResponse([]);
    }
    if (url.pathname === "/rest/v1/platform_fee_waiver_events") {
      return jsonResponse([
        {
          id: "44444444-4444-4444-8444-444444444444",
          created_at: "2026-05-18T12:00:00Z",
          payer_user_id: "55555555-5555-4555-8555-555555555555",
          publisher_user_id: PUBLISHER_ID,
          app_id: "66666666-6666-4666-8666-666666666666",
          transaction_kind: "tool_call",
          gross_light: 100,
          fee_rate: 0.15,
          fee_would_have_been_light: 15,
          fee_waived_light: 15,
          platform_fee_charged_light: 0,
          waiver_source: "referral_grant",
        },
        {
          id: "77777777-7777-4777-8777-777777777777",
          created_at: "2026-05-18T12:01:00Z",
          payer_user_id: "88888888-8888-4888-8888-888888888888",
          publisher_user_id: PUBLISHER_ID,
          app_id: "99999999-9999-4999-8999-999999999999",
          transaction_kind: "marketplace_sale",
          gross_light: 100,
          fee_rate: 0.15,
          fee_would_have_been_light: 15,
          fee_waived_light: 5,
          platform_fee_charged_light: 10,
          waiver_source: "publisher_fee_credit",
        },
      ]);
    }
    throw new Error(`Unexpected fetch ${url}`);
  }, async () => {
    const response = await handleAdmin(
      new Request("https://example.com/api/admin/payouts/reconciliation", {
        headers: { "Authorization": "Bearer service-role-key" },
      }),
    );
    assertEquals(response.status, 200);
    const body = await response.json() as PayoutReconciliationBody;
    assertEquals(body.fee_waivers.event_count, 2);
    assertEquals(body.fee_waivers.fee_would_have_been_light, 30);
    assertEquals(body.fee_waivers.fee_waived_light, 20);
    assertEquals(body.fee_waivers.platform_fee_charged_light, 10);
    assertEquals(body.fee_waivers.by_source.referral_grant.fee_waived_light, 15);
    assertEquals(body.fee_waivers.by_source.publisher_fee_credit.fee_waived_light, 5);
    assertEquals(body.fee_waivers.by_transaction_kind.marketplace_sale.fee_waived_light, 5);
  });
});
