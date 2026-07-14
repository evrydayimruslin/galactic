import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertMatch } from "https://deno.land/std@0.210.0/assert/assert_match.ts";
import {
  buildExecutionTelemetry,
  debitWidgetPullUsage,
  logExecutionResult,
  preflightRuntimeCloudHold,
  settleAndLogAppExecution,
  settleAppCall,
  settleCallerAppCharge,
} from "./execution-settlement.ts";
import { __setSalesTaxRateTableForTest } from "./sales-tax.ts";
import { invalidateBillingConfigCache } from "./billing-config.ts";

const HOLD_ROW = {
  hold_id: "00000000-0000-0000-0000-000000000601",
  payer_user_id: "user_tax",
  sponsor_user_id: null,
  app_price_light: 100,
  app_charge_light: 100,
  free_call: false,
  free_call_count: null,
  free_call_limit: 0,
  old_balance: 0,
  new_balance: 0,
  held_amount_light: 0.06,
  held_deposit_light: 0.06,
  held_earned_light: 0,
};

function holdFetch(
  newBalance: number,
  onRelease: () => void,
): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rpc/create_app_call_runtime_cloud_hold")) {
      return Promise.resolve(
        Response.json([{ ...HOLD_ROW, new_balance: newBalance }]),
      );
    }
    if (url.includes("/rpc/release_cloud_usage_hold")) {
      onRelease();
      return Promise.resolve(
        Response.json([{
          hold_id: HOLD_ROW.hold_id,
          released_amount_light: HOLD_ROW.held_amount_light,
        }]),
      );
    }
    if (url.includes("/platform_billing_config")) {
      return Promise.resolve(Response.json([{ id: "singleton", version: 1 }]));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

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

Deno.test("settleAppCall fails CLOSED when the settlement backend is unavailable (no free giveaway)", async () => {
  // Force the !supabase branch by running with SUPABASE_* unset. A paid call
  // must be BLOCKED with a distinct, retryable code — not silently run free,
  // which would give the developer's paid work away as a "successful" call.
  const globalWithEnv = globalThis as typeof globalThis & {
    __env?: Record<string, unknown>;
  };
  const previousEnv = globalWithEnv.__env;
  globalWithEnv.__env = {
    ...(previousEnv || {}),
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
  };
  try {
    const result = await settleAppCall({
      app: createTestApp({ default_price_light: 10 }),
      userId: "user_settlement_down",
      functionName: "search",
      inputArgs: { query: "x" },
      successful: true,
      callerAuthState: "authenticated",
    }, {
      fetchFn: async (input) => {
        throw new Error(`No settlement fetch should occur: ${String(input)}`);
      },
    });

    assertEquals(result.insufficientBalance, true);
    assertEquals(result.insufficientBalanceCode, "settlement_unavailable");
    assertEquals(result.chargedLight, 0);
    assertEquals(result.developerRevenueLight, 0);
    assertMatch(
      result.insufficientBalanceMessage ?? "",
      /temporarily unavailable/i,
    );
  } finally {
    globalWithEnv.__env = previousEnv;
  }
});

Deno.test("settleAppCall preserves waived fee fields from transfer RPC", async () => {
  await withMockedEnv(async () => {
    const result = await settleAppCall({
      app: createTestApp({ default_price_light: 10 }),
      userId: "user_waived",
      functionName: "search",
      inputArgs: { query: "waived" },
      successful: true,
    }, {
      fetchFn: async (input, init) => {
        const url = String(input);
        if (url.includes("/rpc/transfer_light")) {
          const body = JSON.parse(String(init?.body));
          assertEquals(body.p_amount_light, 10);
          return new Response(
            JSON.stringify([{
              from_new_balance: 90,
              to_new_balance: 10,
              platform_fee: 0,
              transfer_id: "transfer-waived-1",
              fee_would_have_been: 1.5,
              fee_waived: 1.5,
              waiver_source: "referral_grant",
              waiver_event_id: "waiver-event-1",
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

    assertEquals(result.platformFeeLight, 0);
    assertEquals(result.developerRevenueLight, 10);
    assertEquals(result.feeWouldHaveBeenLight, 1.5);
    assertEquals(result.feeWaivedLight, 1.5);
    assertEquals(result.waiverSource, "referral_grant");
    assertEquals(result.waiverEventId, "waiver-event-1");
    assertEquals(result.metadata.fee_waived_light, 1.5);
  });
});

Deno.test("settleAppCall charges per-transaction sales tax on the app charge", async () => {
  await withMockedEnv(async () => {
    __setSalesTaxRateTableForTest({ US: { states: { CA: 1000 } } }); // 10%
    try {
      let taxDebit: Record<string, unknown> | null = null;
      const result = await settleAppCall({
        app: createTestApp({ default_price_light: 10 }),
        userId: "user_tax",
        functionName: "search",
        inputArgs: { query: "taxed" },
        successful: true,
        receiptId: "receipt-tax-1",
      }, {
        resolveBuyerTaxLocationFn: () =>
          Promise.resolve({
            location: { country: "US", state: "CA" },
            addressId: "addr_ca",
            version: 4,
          }),
        fetchFn: async (input, init) => {
          const url = String(input);
          if (url.includes("/rpc/transfer_light")) {
            return new Response(
              JSON.stringify([{
                from_new_balance: 90,
                to_new_balance: 10,
                platform_fee: 2,
                transfer_id: "transfer-tax-1",
              }]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes("/rpc/debit_light")) {
            taxDebit = JSON.parse(String(init?.body));
            return new Response(
              JSON.stringify([{ amount_debited: 1, new_balance: 89 }]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          throw new Error(`Unexpected fetch: ${url}`);
        },
      });

      assertEquals(result.taxStatus, "collected");
      assertEquals(result.taxableAmountLight, 10);
      assertEquals(result.taxAmountLight, 1);
      assertEquals(result.buyerBillingAddressId, "addr_ca");
      assertEquals(result.buyerBillingAddressVersion, 4);
      assert(taxDebit, "debit_light should have been called");
      assertEquals((taxDebit as Record<string, unknown>).p_amount_light, 1);
      assertEquals((taxDebit as Record<string, unknown>).p_reason, "sales_tax");
    } finally {
      __setSalesTaxRateTableForTest();
    }
  });
});

Deno.test("settleAppCall does not tax a buyer in an unconfigured location", async () => {
  await withMockedEnv(async () => {
    __setSalesTaxRateTableForTest({ US: { states: { CA: 1000 } } });
    try {
      let debitCalled = false;
      const result = await settleAppCall({
        app: createTestApp({ default_price_light: 10 }),
        userId: "user_untaxed",
        functionName: "search",
        inputArgs: { query: "untaxed" },
        successful: true,
        receiptId: "receipt-tax-2",
      }, {
        // Buyer is in TX (not in the table) — rate resolves to 0.
        resolveBuyerTaxLocationFn: () =>
          Promise.resolve({
            location: { country: "US", state: "TX" },
            addressId: "addr_tx",
            version: 1,
          }),
        fetchFn: async (input) => {
          const url = String(input);
          if (url.includes("/rpc/transfer_light")) {
            return new Response(
              JSON.stringify([{
                from_new_balance: 90,
                to_new_balance: 10,
                platform_fee: 2,
                transfer_id: "transfer-tax-2",
              }]),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (url.includes("/rpc/debit_light")) {
            debitCalled = true;
            return new Response(JSON.stringify([{ amount_debited: 0 }]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        },
      });

      assertEquals(result.taxStatus, "not_collecting");
      assertEquals(result.taxAmountLight, 0);
      assertEquals(debitCalled, false);
    } finally {
      __setSalesTaxRateTableForTest();
    }
  });
});

Deno.test("preflightRuntimeCloudHold rejects when balance can't cover app charge + tax", async () => {
  await withMockedEnv(async () => {
    invalidateBillingConfigCache();
    __setSalesTaxRateTableForTest({ US: { states: { CA: 1000 } } }); // 10%
    try {
      let released = false;
      // appCharge 100, tax 10 → need 110; only 105 left after the infra hold.
      const result = await preflightRuntimeCloudHold({
        app: createTestApp({ default_price_light: 100 }),
        userId: "user_tax",
        functionName: "run",
        inputArgs: {},
        method: "run",
        timeoutMs: 30_000,
        callerAuthState: "authenticated",
      }, {
        resolveBuyerTaxLocationFn: () =>
          Promise.resolve({
            location: { country: "US", state: "CA" },
            addressId: "addr_ca",
            version: 1,
          }),
        fetchFn: holdFetch(105, () => {
          released = true;
        }),
      });

      assertEquals(result.insufficientBalance, true);
      assertEquals(result.insufficientBalanceCode, "caller_light_required");
      assertEquals(result.metadata.sales_tax_light, 10);
      assertEquals(released, true);
    } finally {
      __setSalesTaxRateTableForTest();
      invalidateBillingConfigCache();
    }
  });
});

Deno.test("preflightRuntimeCloudHold allows when balance covers app charge + tax", async () => {
  await withMockedEnv(async () => {
    invalidateBillingConfigCache();
    __setSalesTaxRateTableForTest({ US: { states: { CA: 1000 } } });
    try {
      let released = false;
      const result = await preflightRuntimeCloudHold({
        app: createTestApp({ default_price_light: 100 }),
        userId: "user_tax",
        functionName: "run",
        inputArgs: {},
        method: "run",
        timeoutMs: 30_000,
        callerAuthState: "authenticated",
      }, {
        resolveBuyerTaxLocationFn: () =>
          Promise.resolve({
            location: { country: "US", state: "CA" },
            addressId: "addr_ca",
            version: 1,
          }),
        fetchFn: holdFetch(500, () => {
          released = true;
        }),
      });

      assertEquals(result.insufficientBalance, false);
      assertEquals(result.hold?.appChargeLight, 100);
      assertEquals(released, false);
    } finally {
      __setSalesTaxRateTableForTest();
      invalidateBillingConfigCache();
    }
  });
});

Deno.test("preflightRuntimeCloudHold fails closed when runtime policy denies", async () => {
  await withMockedEnv(async () => {
    const result = await preflightRuntimeCloudHold({
      app: {
        ...createTestApp({ default_price_light: 5 }),
        manifest: {
          access_policy: {
            mode: "module",
            module: "policy.ts",
            export: "planAccess",
          },
        },
      },
      userId: "user_denied",
      functionName: "search",
      inputArgs: { query: "blocked" },
      receiptId: "receipt-denied-1",
      method: "run",
      timeoutMs: 30_000,
      callerAuthState: "authenticated",
    }, {
      accessPolicyExecutor: async () => ({
        effect: "deny",
        reason: "Search is disabled for this account.",
      }),
    });

    assertEquals(result.hold, null);
    assertEquals(result.insufficientBalance, true);
    assertEquals(result.insufficientBalanceCode, "access_policy_denied");
    assertEquals(
      result.insufficientBalanceMessage,
      "Search is disabled for this account.",
    );
    assertEquals(result.pricing.policySource, "runtime_policy");
    assertEquals(result.metadata.access_policy_denied, true);
    assertEquals(result.metadata.access_policy_executed, true);
  });
});

Deno.test("preflightRuntimeCloudHold applies runtime policy pricing before auth gating", async () => {
  await withMockedEnv(async () => {
    const result = await preflightRuntimeCloudHold({
      app: {
        ...createTestApp({ default_price_light: 0 }),
        manifest: {
          access_policy: {
            mode: "module",
            module: "policy.ts",
            export: "planAccess",
          },
        },
      },
      userId: "anonymous",
      functionName: "search",
      inputArgs: { query: "paid by policy" },
      receiptId: "receipt-policy-price-1",
      method: "run",
      timeoutMs: 30_000,
      callerAuthState: "anonymous",
    }, {
      accessPolicyExecutor: async () => ({
        effect: "allow",
        price_light: 13,
        charge_light: 13,
        metadata: { policy_rule: "paid_anonymous_gate" },
      }),
    });

    assertEquals(result.hold, null);
    assertEquals(result.insufficientBalance, true);
    assertEquals(result.insufficientBalanceCode, "caller_auth_required");
    assertEquals(result.pricing.appPriceLight, 13);
    assertEquals(result.pricing.appChargeLight, 13);
    assertEquals(result.pricing.policySource, "runtime_policy");
    assertEquals(result.metadata.app_price_light, 13);
    assertEquals(result.metadata.policy_rule, "paid_anonymous_gate");
  });
});

Deno.test("settleAndLogAppExecution settles app pricing across run/http style calls", async () => {
  await withMockedEnv(async () => {
    let logged: Record<string, unknown> | null = null;
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const routineContext = {
      routineId: "00000000-0000-4000-8000-000000000101",
      routineRunId: "00000000-0000-4000-8000-000000000102",
      traceId: "00000000-0000-4000-8000-000000000103",
    };
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
      routineContext,
      runtimeCloudSettlement: {
        holdId: "hold-run-1",
        eventId: "cloud-event-run-1",
        payerUserId: "user_run",
        ownerSponsoredInfra: false,
        callerInfraFallback: false,
        cloudUnits: 20,
        amountLight: 2,
        settledAmountLight: 2,
        releasedAmountLight: 0,
        billingConfigVersion: 1,
      },
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
          assertEquals(
            body.p_idempotency_key,
            "tool_call_transfer:receipt-run-1:user_run:app_123:search:tool_call",
          );
          assertEquals(
            (body.p_metadata as Record<string, unknown>).routine_id,
            routineContext.routineId,
          );
          return new Response(
            JSON.stringify([{
              from_new_balance: 90,
              to_new_balance: 8.5,
              platform_fee: 1.5,
              transfer_id: "transfer-run-1",
              fee_would_have_been: 1.5,
              fee_waived: 0,
              waiver_source: null,
            }]),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.includes("/rpc/record_routine_call_contribution")) {
          assertEquals(body.p_routine_id, routineContext.routineId);
          assertEquals(body.p_routine_run_id, routineContext.routineRunId);
          assertEquals(body.p_user_id, "user_run");
          assertEquals(body.p_app_id, "app_123");
          assertEquals(body.p_app_ref, "test-app");
          assertEquals(body.p_function_name, "search");
          assertEquals(body.p_receipt_id, "receipt-run-1");
          assertEquals(body.p_status, "succeeded");
          assertEquals(body.p_cost_light, 12);
          assertEquals(
            (body.p_metadata as Record<string, unknown>).trace_id,
            routineContext.traceId,
          );
          return new Response(
            JSON.stringify([{
              step_id: "00000000-0000-4000-8000-000000000104",
              step_index: 0,
              total_light: 12,
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
    assertEquals(result.settlement.feeWouldHaveBeenLight, 1.5);
    assertEquals(result.settlement.feeWaivedLight, 0);
    assertEquals(result.settlement.insufficientBalance, false);
    assertEquals(result.routineStep?.step_index, 0);
    assertEquals(result.routineStep?.total_light, 12);
    assertEquals(calls.length, 2);
    assert(logged !== null);
    const loggedEntry = logged as Record<string, unknown>;
    assertEquals(loggedEntry.method, "run");
    assertEquals(loggedEntry.callChargeLight, 10);
    assertEquals(loggedEntry.appPriceLight, 10);
    assertEquals(loggedEntry.appChargeLight, 10);
    assertEquals(loggedEntry.infraChargeLight, 2);
    assertEquals(loggedEntry.platformFeeLight, 1.5);
    assertEquals(loggedEntry.developerNetLight, 8.5);
    assertEquals(loggedEntry.freeCall, false);
    assertEquals(loggedEntry.routineId, routineContext.routineId);
    assertEquals(loggedEntry.routineRunId, routineContext.routineRunId);
    assertEquals(loggedEntry.traceId, routineContext.traceId);
  });
});

Deno.test("settleAndLogAppExecution applies charged spend when contribution telemetry fails", async () => {
  await withMockedEnv(async () => {
    const routineContext = {
      routineId: "00000000-0000-4000-8000-000000000201",
      routineRunId: "00000000-0000-4000-8000-000000000202",
      traceId: "00000000-0000-4000-8000-000000000203",
    };
    let fallbackSettled = false;

    const result = await settleAndLogAppExecution({
      receiptId: "receipt-run-fallback-1",
      app: createTestApp({ default_price_light: 10 }),
      userId: "user_run",
      user: null,
      functionName: "search",
      inputArgs: { query: "pricing" },
      method: "run",
      success: true,
      durationMs: 120,
      outputResult: { ok: true },
      callerAuthState: "authenticated",
      routineContext,
      runtimePricingPreflight: {
        appPriceLight: 10,
        appChargeLight: 10,
        freeCall: false,
        freeCallCount: null,
        freeCallLimit: 0,
        freeCallCounterKey: null,
        policySource: "static_config",
        routineBudgetReservation: {
          id: "00000000-0000-4000-8000-000000000204",
          key: "app:receipt-run-fallback-1",
          reservedLight: 10,
          callsUsed: 1,
          callsLimit: 25,
          lightUsed: 0,
          lightReserved: 10,
          lightLimit: 100,
        },
      },
    }, {
      fetchFn: async (input, init) => {
        const url = String(input);
        const body = init?.body
          ? JSON.parse(String(init.body)) as Record<string, unknown>
          : {};
        if (url.includes("/rpc/transfer_light")) {
          return Response.json([{
            from_new_balance: 90,
            to_new_balance: 8.5,
            platform_fee: 1.5,
            transfer_id: "transfer-run-fallback-1",
            fee_would_have_been: 1.5,
            fee_waived: 0,
            waiver_source: null,
          }]);
        }
        if (url.includes("/rpc/record_routine_call_contribution")) {
          return new Response("telemetry unavailable", { status: 503 });
        }
        if (url.includes("/rpc/settle_routine_run_budget_reservation")) {
          assertEquals(body.p_actual_light, 10);
          assertEquals(body.p_apply_spend, true);
          fallbackSettled = true;
          return Response.json(true);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
      logMcpCallFn: () => {},
    });

    assertEquals(result.settlement.appChargeLight, 10);
    assertEquals(result.routineStep, undefined);
    assertEquals(fallbackSettled, true);
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
        billingConfigVersion: 31,
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
          assertEquals(body.p_billing_config_version, 31);
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
    assertEquals(settlement.billingConfigVersion, 31);
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
        billingConfigVersion: 32,
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
    assertEquals(settlement.billingConfigVersion, 32);
    assertMatch(
      settlement.insufficientBalanceMessage || "",
      /Add credits/,
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
        freeCallCounterKey: null,
        policySource: "static_config",
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
        billingConfigVersion: 42,
      },
    });

    assertEquals(settlement.freeCall, true);
    assertEquals(settlement.appChargeLight, 0);
    assertEquals(settlement.infraChargeLight, 0.12);
    assertEquals(settlement.chargedLight, 0.12);
    assertEquals(settlement.infraPayerUserId, "user_free");
    assertEquals(settlement.ownerSponsoredInfra, false);
    assertEquals(settlement.callerInfraFallback, true);
    assertEquals(settlement.billingConfigVersion, 42);
    assertEquals(settlement.metadata.caller_infra_fallback, true);
    assertEquals(settlement.metadata.billing_config_version, 42);
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

Deno.test("routine widget pulls are platform-sponsored micro-operations", async () => {
  let fetchCalls = 0;
  const result = await debitWidgetPullUsage({
    preflight: {
      hold: {
        holdId: "hold_widget_routine",
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
    receiptId: "receipt-widget-routine",
    routineContext: {
      routineId: "00000000-0000-4000-8000-000000000201",
      routineRunId: "00000000-0000-4000-8000-000000000202",
      traceId: "00000000-0000-4000-8000-000000000203",
    },
  }, {
    fetchFn: (() => {
      fetchCalls += 1;
      throw new Error("routine widget pull must not reach billing RPC");
    }) as typeof fetch,
  });

  assertEquals(result, null);
  assertEquals(fetchCalls, 0);
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
    billingConfigVersion: 42,
    platformFeeLight: 0.45,
    developerNetLight: 2.55,
    freeCall: true,
    freeCallCount: 1,
    freeCallLimit: 3,
    widgetAction: {
      surfaceId: "surface-1",
      widgetId: "email_inbox",
      actionId: "send_selected_draft",
      turnId: "turn-1",
    },
    agenticSurfaceAction: {
      surfaceId: "surface-generated",
      interfaceId: "email_interface",
      actionId: "send",
      turnId: "turn-agentic-1",
      componentId: "actions",
    },
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
  assertEquals(loggedEntry.billingConfigVersion, 42);
  assertEquals(loggedEntry.platformFeeLight, 0.45);
  assertEquals(loggedEntry.developerNetLight, 2.55);
  assertEquals(loggedEntry.freeCall, true);
  assertEquals(loggedEntry.freeCallCount, 1);
  assertEquals(loggedEntry.freeCallLimit, 3);
  assertEquals(loggedEntry.widgetAction, {
    surfaceId: "surface-1",
    widgetId: "email_inbox",
    actionId: "send_selected_draft",
    turnId: "turn-1",
  });
  assertEquals(loggedEntry.agenticSurfaceAction, {
    surfaceId: "surface-generated",
    interfaceId: "email_interface",
    actionId: "send",
    turnId: "turn-agentic-1",
    componentId: "actions",
  });
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

Deno.test("free mode: preflight blocks an inference function without BYOK", async () => {
  await withMockedEnv(async () => {
    invalidateBillingConfigCache();
    (globalThis as typeof globalThis & { __env?: Record<string, unknown> })
      .__env!.FREE_MODE = "1";
    const result = await preflightRuntimeCloudHold({
      app: {
        ...createTestApp({ default_price_light: 0 }),
        manifest: JSON.stringify({
          permissions: ["ai:call"],
          functions: { chat: { uses_inference: true } },
        }),
      } as unknown as Parameters<typeof preflightRuntimeCloudHold>[0]["app"],
      userId: "user_free",
      functionName: "chat",
      inputArgs: {},
      method: "run",
      timeoutMs: 30_000,
      callerAuthState: "authenticated",
      freeMode: true,
      byokPresent: false,
    });
    assertEquals(result.insufficientBalance, true);
    assertEquals(result.insufficientBalanceCode, "free_mode_ai_requires_byok");
  });
});

Deno.test("free mode: an inference function WITH BYOK is not gated", async () => {
  await withMockedEnv(async () => {
    invalidateBillingConfigCache();
    (globalThis as typeof globalThis & { __env?: Record<string, unknown> })
      .__env!.FREE_MODE = "1";
    const result = await preflightRuntimeCloudHold({
      app: {
        ...createTestApp({ default_price_light: 0 }),
        manifest: JSON.stringify({
          permissions: ["ai:call"],
          functions: { chat: { uses_inference: true } },
        }),
      } as unknown as Parameters<typeof preflightRuntimeCloudHold>[0]["app"],
      userId: "user_free",
      functionName: "chat",
      inputArgs: {},
      method: "run",
      timeoutMs: 30_000,
      callerAuthState: "authenticated",
      freeMode: true,
      byokPresent: true,
    }, {
      // Free, owner-sponsored call -> the hold succeeds; the AI gate must not fire.
      fetchFn: holdFetch(5000, () => {}),
    });
    assertEquals(result.insufficientBalance, false);
  });
});

Deno.test("free mode: a hold free_mode_blocked maps to free_mode_paid_blocked", async () => {
  await withMockedEnv(async () => {
    invalidateBillingConfigCache();
    (globalThis as typeof globalThis & { __env?: Record<string, unknown> })
      .__env!.FREE_MODE = "1";
    const result = await preflightRuntimeCloudHold({
      app: createTestApp({ default_price_light: 50 }),
      userId: "user_free",
      functionName: "run",
      inputArgs: {},
      method: "run",
      timeoutMs: 30_000,
      callerAuthState: "authenticated",
      freeMode: true,
      byokPresent: false,
    }, {
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("/rpc/create_app_call_runtime_cloud_hold")) {
          return new Response("free_mode_blocked: paid call requires credits", {
            status: 400,
            headers: { "Content-Type": "text/plain" },
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });
    assertEquals(result.insufficientBalance, true);
    assertEquals(result.insufficientBalanceCode, "free_mode_paid_blocked");
  });
});

Deno.test("settleAndLogAppExecution persists flight-recorded ai exchanges as routine run steps", async () => {
  await withMockedEnv(async () => {
    const contributions: Array<Record<string, unknown>> = [];
    const routineContext = {
      routineId: "00000000-0000-4000-8000-000000000201",
      routineRunId: "00000000-0000-4000-8000-000000000202",
      traceId: "00000000-0000-4000-8000-000000000203",
    };
    await settleAndLogAppExecution({
      receiptId: "receipt-flight-1",
      app: createTestApp(),
      userId: "user_flight",
      user: {
        id: "user_flight",
        email: "flight@example.test",
        displayName: "Flight",
        avatarUrl: null,
        tier: "pro",
      },
      functionName: "tick",
      inputArgs: {},
      method: "run",
      success: true,
      durationMs: 1500,
      outputResult: { ok: true },
      callerAuthState: "authenticated",
      routineContext,
      flightAiExchanges: [
        {
          at: "2026-07-07T12:00:01.000Z",
          ms: 800,
          model: "deepseek-v4-flash",
          cost_light: 0.12,
          prompt: '[{"role":"user","content":"Goal: triage inbox"}]',
          response: "Plan: archive 3, reply 1",
        },
        {
          ms: 300,
          model: null,
          prompt: '[{"role":"user","content":"Draft the reply"}]',
          response: "[error] rate limited",
        },
      ],
    }, {
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body
          ? JSON.parse(String(init.body)) as Record<string, unknown>
          : {};
        if (url.includes("/rpc/record_routine_call_contribution")) {
          contributions.push(body);
          return new Response(
            JSON.stringify([{
              step_id: crypto.randomUUID(),
              step_index: contributions.length,
              total_light: 0,
            }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/platform_billing_config")) {
          return new Response(
            JSON.stringify([{ id: "singleton", version: 1 }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Free app: no transfer RPC expected; tolerate incidental reads.
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    // 1 handler contribution + 2 ai exchanges, all through the same RPC so
    // step indexes can never collide.
    const aiSteps = contributions.filter((body) =>
      body.p_function_name === "galactic.ai"
    );
    assertEquals(contributions.length, 3);
    assertEquals(aiSteps.length, 2);
    assertEquals(aiSteps[0].p_routine_run_id, routineContext.routineRunId);
    // ai exchanges are recorded at zero cost — spend already rides the
    // handler's contribution.
    assertEquals(aiSteps[0].p_cost_light, 0);
    assertEquals(
      (aiSteps[0].p_args_preview as Record<string, unknown>).prompt,
      '[{"role":"user","content":"Goal: triage inbox"}]',
    );
    assertEquals(
      (aiSteps[0].p_result_preview as Record<string, unknown>).response,
      "Plan: archive 3, reply 1",
    );
    assertEquals(
      (aiSteps[0].p_metadata as Record<string, unknown>).kind,
      "ai_exchange",
    );
    assertEquals(
      (aiSteps[0].p_metadata as Record<string, unknown>).cost_light,
      0.12,
    );
    // Failed exchanges are recorded too — that is when the reasoning matters.
    assertEquals(
      (aiSteps[1].p_result_preview as Record<string, unknown>).response,
      "[error] rate limited",
    );
  });
});

Deno.test("settleAndLogAppExecution persists the db-diff tally as a galactic.db step", async () => {
  await withMockedEnv(async () => {
    const contributions: Array<Record<string, unknown>> = [];
    const routineContext = {
      routineId: "00000000-0000-4000-8000-000000000301",
      routineRunId: "00000000-0000-4000-8000-000000000302",
      traceId: "00000000-0000-4000-8000-000000000303",
    };
    await settleAndLogAppExecution({
      receiptId: "receipt-dbdiff-1",
      app: createTestApp(),
      userId: "user_dbdiff",
      user: {
        id: "user_dbdiff",
        email: "dbdiff@example.test",
        displayName: "DbDiff",
        avatarUrl: null,
        tier: "pro",
      },
      functionName: "tick",
      inputArgs: {},
      method: "run",
      success: true,
      durationMs: 900,
      outputResult: { ok: true },
      callerAuthState: "authenticated",
      routineContext,
      flightDbTally: {
        inserts: 3,
        updates: 1,
        deletes: 0,
        upserts: 0,
        rows_written: 4,
        by_table: {
          emails: { inserts: 3, updates: 1, deletes: 0, upserts: 0, rows: 4 },
        },
      },
    }, {
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body
          ? JSON.parse(String(init.body)) as Record<string, unknown>
          : {};
        if (url.includes("/rpc/record_routine_call_contribution")) {
          contributions.push(body);
          return new Response(
            JSON.stringify([{
              step_id: crypto.randomUUID(),
              step_index: contributions.length,
              total_light: 0,
            }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/platform_billing_config")) {
          return new Response(
            JSON.stringify([{ id: "singleton", version: 1 }]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    const dbSteps = contributions.filter((body) =>
      body.p_function_name === "galactic.db"
    );
    assertEquals(dbSteps.length, 1);
    assertEquals(dbSteps[0].p_routine_run_id, routineContext.routineRunId);
    // Zero cost — the diff step is evidence, not a charge.
    assertEquals(dbSteps[0].p_cost_light, 0);
    const meta = dbSteps[0].p_metadata as Record<string, unknown>;
    assertEquals(meta.kind, "db_diff");
    assertEquals(meta.inserts, 3);
    assertEquals(meta.rows_written, 4);
    assertEquals(
      (meta.by_table as Record<string, unknown>).emails,
      { inserts: 3, updates: 1, deletes: 0, upserts: 0, rows: 4 },
    );
  });
});

Deno.test("settleAndLogAppExecution ignores flight exchanges without a routine context", async () => {
  await withMockedEnv(async () => {
    const contributionUrls: string[] = [];
    await settleAndLogAppExecution({
      receiptId: "receipt-flight-2",
      app: createTestApp(),
      userId: "user_flight",
      user: null,
      functionName: "tick",
      inputArgs: {},
      method: "run",
      success: true,
      durationMs: 100,
      outputResult: { ok: true },
      callerAuthState: "authenticated",
      flightAiExchanges: [{ prompt: "p", response: "r" }],
    }, {
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/rpc/record_routine_call_contribution")) {
          contributionUrls.push(url);
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    // No routine context → nothing to attach the steps to → no RPC.
    assertEquals(contributionUrls, []);
  });
});
