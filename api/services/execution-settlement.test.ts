import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertMatch } from "https://deno.land/std@0.210.0/assert/assert_match.ts";
import {
  buildExecutionTelemetry,
  debitWidgetPullUsage,
  logExecutionResult,
  settleAndLogAppExecution,
  settleAppCall,
  settleCallerAppCharge,
} from "./execution-settlement.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

async function withMockedEnv<T>(fn: () => Promise<T> | T): Promise<T> {
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  globalWithEnv.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  };

  try {
    return await fn();
  } finally {
    globalWithEnv.__env = previousEnv;
  }
}

function createTestApp(pricingConfig?: Record<string, unknown>) {
  return {
    id: "app_123",
    owner_id: "owner_123",
    slug: "test-app",
    name: "Test App",
    hosting_suspended: false,
    pricing_config: pricingConfig || null,
  } as any;
}

Deno.test("settleCallerAppCharge skips transfer when the call is still within the free tier", async () => {
  await withMockedEnv(async () => {
    const calls: string[] = [];
    const result = await settleCallerAppCharge({
      app: createTestApp({ default_price_light: 5, default_free_calls: 1 }),
      userId: "user_123",
      functionName: "search",
      inputArgs: { query: "hello" },
      successful: true,
    }, {
      fetchFn: async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/rpc/increment_caller_usage")) {
          return new Response(JSON.stringify([{ call_count: 1 }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    assertEquals(result.chargedLight, 0);
    assertEquals(result.insufficientBalance, false);
    assertEquals(
      calls.some((url) => url.includes("/rpc/transfer_light")),
      false,
    );
  });
});

Deno.test("settleCallerAppCharge reports insufficient balance when transfer RPC returns no rows", async () => {
  await withMockedEnv(async () => {
    const result = await settleCallerAppCharge({
      app: createTestApp({ default_price_light: 7 }),
      userId: "user_456",
      functionName: "search",
      inputArgs: { query: "world" },
      successful: true,
    }, {
      fetchFn: async (input, init) => {
        const url = String(input);
        if (url.includes("/rpc/transfer_light")) {
          const body = JSON.parse(String(init?.body));
          assertEquals(body.p_reason, "tool_call");
          assertEquals(body.p_app_id, "app_123");
          assertEquals(body.p_function_name, "search");
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    assertEquals(result.chargedLight, 0);
    assertEquals(result.insufficientBalance, true);
  });
});

Deno.test("settleAndLogAppExecution settles app pricing across run/http style calls", async () => {
  await withMockedEnv(async () => {
    let logged: Record<string, unknown> | null = null;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await settleAndLogAppExecution({
      receiptId: "receipt-run-1",
      app: createTestApp({ default_price_light: 10 }),
      userId: "user_run",
      user: {
        id: "user_run",
        email: "runner@example.test",
        displayName: "Runner",
        avatarUrl: null,
        tier: "pro",
      },
      functionName: "search",
      inputArgs: { query: "pricing" },
      method: "run",
      success: true,
      durationMs: 120,
      outputResult: { ok: true },
      callerAuthState: "authenticated",
    }, {
      fetchFn: async (input, init) => {
        const url = String(input);
        const body = init?.body
          ? JSON.parse(String(init.body)) as Record<string, unknown>
          : {};
        calls.push({ url, body });
        if (url.includes("/rpc/transfer_light")) {
          assertEquals(body.p_from_user, "user_run");
          assertEquals(body.p_to_user, "owner_123");
          assertEquals(body.p_amount_light, 10);
          assertEquals(body.p_function_name, "search");
          return new Response(
            JSON.stringify([{
              from_new_balance: 90,
              to_new_balance: 8.5,
              platform_fee: 1.5,
              transfer_id: "transfer-run-1",
            }]),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      logMcpCallFn: (entry) => {
        logged = entry as unknown as Record<string, unknown>;
      },
    });

    assertEquals(result.settlement.appChargeLight, 10);
    assertEquals(result.settlement.platformFeeLight, 1.5);
    assertEquals(result.settlement.developerRevenueLight, 8.5);
    assertEquals(result.settlement.insufficientBalance, false);
    assertEquals(calls.length, 1);
    assert(logged !== null);
    const loggedEntry = logged as Record<string, unknown>;
    assertEquals(loggedEntry.method, "run");
    assertEquals(loggedEntry.callChargeLight, 10);
    assertEquals(loggedEntry.appPriceLight, 10);
    assertEquals(loggedEntry.appChargeLight, 10);
    assertEquals(loggedEntry.infraChargeLight, 0);
    assertEquals(loggedEntry.platformFeeLight, 1.5);
    assertEquals(loggedEntry.developerNetLight, 8.5);
    assertEquals(loggedEntry.freeCall, false);
  });
});

Deno.test("settleAppCall uses owner sponsorship for free-call infra", async () => {
  await withMockedEnv(async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const settlement = await settleAppCall({
      receiptId: "receipt-free-1",
      app: createTestApp({ default_price_light: 5, default_free_calls: 1 }),
      userId: "user_free",
      functionName: "search",
      inputArgs: { query: "free" },
      successful: true,
      method: "http",
      callerAuthState: "authenticated",
      infraCharge: {
        amountLight: 0.12,
        units: 120,
        cloudUnits: 120,
        resource: "worker_execution",
      },
    }, {
      fetchFn: async (input, init) => {
        const url = String(input);
        const body = init?.body
          ? JSON.parse(String(init.body)) as Record<string, unknown>
          : {};
        calls.push({ url, body });
        if (url.includes("/rpc/increment_caller_usage")) {
          return new Response(JSON.stringify([{ current_count: 1 }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/rpc/debit_cloud_usage")) {
          assertEquals(body.p_payer_user_id, "owner_123");
          assertEquals(body.p_sponsor_user_id, "owner_123");
          assertEquals(body.p_caller_user_id, "user_free");
          assertEquals(body.p_amount_light, 0.12);
          return new Response(
            JSON.stringify([{
              event_id: "event-free-1",
              old_balance: 10,
              new_balance: 9.88,
              amount_debited: 0.12,
              deposit_debited: 0.12,
              earned_debited: 0,
            }]),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    assertEquals(settlement.freeCall, true);
    assertEquals(settlement.appChargeLight, 0);
    assertEquals(settlement.infraChargeLight, 0.12);
    assertEquals(settlement.infraPayerUserId, "owner_123");
    assertEquals(settlement.ownerSponsoredInfra, true);
    assertEquals(
      calls.some((call) => call.url.includes("/rpc/transfer_light")),
      false,
    );
  });
});

Deno.test("settleAppCall gates free calls when owner sponsorship has no Light", async () => {
  await withMockedEnv(async () => {
    const settlement = await settleAppCall({
      receiptId: "receipt-free-2",
      app: createTestApp({ default_price_light: 0 }),
      userId: "user_free",
      functionName: "search",
      inputArgs: { query: "free" },
      successful: true,
      method: "http",
      callerAuthState: "authenticated",
      infraCharge: {
        amountLight: 0.12,
        units: 120,
        cloudUnits: 120,
        resource: "worker_execution",
      },
    }, {
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("/rpc/debit_cloud_usage")) {
          return new Response("Insufficient available balance", {
            status: 400,
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    assertEquals(settlement.insufficientBalance, true);
    assertEquals(
      settlement.insufficientBalanceCode,
      "owner_sponsor_light_required",
    );
    assertEquals(settlement.chargedLight, 0);
    assertMatch(
      settlement.insufficientBalanceMessage || "",
      /Add Light/,
    );
  });
});

Deno.test("settleAppCall keeps free app charge zero when caller funds infra fallback", async () => {
  await withMockedEnv(async () => {
    const settlement = await settleAppCall({
      receiptId: "receipt-free-fallback",
      app: createTestApp({ default_price_light: 0 }),
      userId: "user_free",
      functionName: "search",
      inputArgs: { query: "free" },
      successful: true,
      method: "http",
      callerAuthState: "authenticated",
      runtimePricingPreflight: {
        appPriceLight: 0,
        appChargeLight: 0,
        freeCall: true,
        freeCallCount: null,
        freeCallLimit: 0,
      },
      runtimeCloudSettlement: {
        holdId: "hold-free-fallback",
        eventId: "event-free-fallback",
        payerUserId: "user_free",
        ownerSponsoredInfra: false,
        callerInfraFallback: true,
        cloudUnits: 120,
        amountLight: 0.12,
        settledAmountLight: 0.12,
        releasedAmountLight: 0,
      },
    });

    assertEquals(settlement.freeCall, true);
    assertEquals(settlement.appChargeLight, 0);
    assertEquals(settlement.infraChargeLight, 0.12);
    assertEquals(settlement.chargedLight, 0.12);
    assertEquals(settlement.infraPayerUserId, "user_free");
    assertEquals(settlement.ownerSponsoredInfra, false);
    assertEquals(settlement.callerInfraFallback, true);
    assertEquals(settlement.metadata.caller_infra_fallback, true);
  });
});

Deno.test("debitWidgetPullUsage records one widget pull cloud unit with runtime payer", async () => {
  await withMockedEnv(async () => {
    let debitBody: Record<string, unknown> | null = null;
    const result = await debitWidgetPullUsage({
      preflight: {
        hold: {
          holdId: "hold_widget_1",
          payerUserId: "user_widget",
          sponsorUserId: null,
          ownerSponsoredInfra: false,
        },
        billingConfig: {
          version: 23,
          widgetPullsPerCloudUnit: 1,
          cloudUnitLightPer1k: 1,
        },
      } as any,
      app: {
        id: "app_widget",
        owner_id: "owner_widget",
        slug: "widget-app",
      },
      userId: "user_widget",
      functionName: "widget_email_inbox_data",
      receiptId: "receipt-widget-1",
      widgetName: "email_inbox",
      widgetIntervalMs: 300_000,
      widgetPullReason: "scheduled",
    }, {
      fetchFn: async (input, init) => {
        const url = String(input);
        if (url.includes("/rpc/debit_cloud_usage")) {
          debitBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            JSON.stringify([{
              event_id: "event-widget-1",
              old_balance: 10,
              new_balance: 9.999,
              amount_debited: 0.001,
              deposit_debited: 0.001,
              earned_debited: 0,
            }]),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    assert(result !== null);
    assertEquals(result.eventId, "event-widget-1");
    assertEquals(result.payerUserId, "user_widget");
    assertEquals(result.ownerSponsoredInfra, false);
    assertEquals(result.units, 1);
    assertEquals(result.cloudUnits, 1);
    assertEquals(result.amountLight, 0.001);

    assert(debitBody !== null);
    const body = debitBody as Record<string, unknown>;
    assertEquals(body.p_source, "widget_pull");
    assertEquals(body.p_resource, "widget_pull");
    assertEquals(body.p_payer_user_id, "user_widget");
    assertEquals(body.p_caller_user_id, "user_widget");
    assertEquals(body.p_owner_user_id, "owner_widget");
    assertEquals(body.p_units, 1);
    assertEquals(body.p_cloud_units, 1);
    assertEquals(body.p_amount_light, 0.001);
    const metadata = body.p_metadata as Record<string, unknown>;
    assertEquals(metadata.widget_name, "email_inbox");
    assertEquals(metadata.widget_interval_ms, 300_000);
    assertEquals(metadata.widget_pull_reason, "scheduled");
    assertEquals(metadata.runtime_cloud_hold_id, "hold_widget_1");
  });
});

Deno.test("logExecutionResult records computed telemetry alongside the provided context", () => {
  let logged: Record<string, unknown> | null = null;
  logExecutionResult({
    userId: "user_789",
    appId: "app_123",
    appName: "Test App",
    functionName: "search",
    method: "tools/call",
    success: true,
    durationMs: 150,
    outputResult: { ok: true, value: 42 },
    callChargeLight: 3,
    appPriceLight: 5,
    appChargeLight: 3,
    infraChargeLight: 0.001,
    platformFeeLight: 0.45,
    developerNetLight: 2.55,
    freeCall: true,
    freeCallCount: 1,
    freeCallLimit: 3,
  }, {
    logMcpCallFn: (entry) => {
      logged = entry as unknown as Record<string, unknown>;
    },
  });

  assert(logged !== null);
  const loggedEntry = logged as Record<string, unknown>;
  assertEquals(loggedEntry.callChargeLight, 3);
  assertEquals(loggedEntry.appPriceLight, 5);
  assertEquals(loggedEntry.appChargeLight, 3);
  assertEquals(loggedEntry.infraChargeLight, 0.001);
  assertEquals(loggedEntry.platformFeeLight, 0.45);
  assertEquals(loggedEntry.developerNetLight, 2.55);
  assertEquals(loggedEntry.freeCall, true);
  assertEquals(loggedEntry.freeCallCount, 1);
  assertEquals(loggedEntry.freeCallLimit, 3);
  assertEquals(loggedEntry.method, "tools/call");
  assert(typeof loggedEntry.responseSizeBytes === "number");
  assert((loggedEntry.responseSizeBytes as number) > 0);
  assert(typeof loggedEntry.executionCostEstimateLight === "number");
});

Deno.test("buildExecutionTelemetry estimates size and cost from the serialized result", () => {
  const telemetry = buildExecutionTelemetry(
    { ok: true, items: [1, 2, 3] },
    250,
  );

  assert(telemetry.responseSizeBytes > 0);
  assert(telemetry.executionCostEstimateLight > 0);
});
