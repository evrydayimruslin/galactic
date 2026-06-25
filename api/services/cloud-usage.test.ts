import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";
import {
  calcD1ReadCloudUnits,
  calcD1WriteCloudUnits,
  calcOperationCloudUnits,
  calculateCloudUsageLight,
  calcWorkerCloudUnits,
  CloudUsageRpcError,
  createCloudUsageHold,
  createRuntimeCloudHold,
  debitCloudOperation,
  debitCloudUsage,
  debitD1Usage,
  peekCallerUsage,
  recordCloudUsageEvent,
  releaseCloudUsageHold,
  settleCloudUsageHold,
  settleRuntimeCloudHold,
} from "./cloud-usage.ts";

Deno.test("cloud usage billing uses exact fractional Light per cloud unit", () => {
  assertEquals(calculateCloudUsageLight(1), 0.001);
  assertEquals(calculateCloudUsageLight(250), 0.25);
  assertEquals(calculateCloudUsageLight(3, 2), 0.006);
  assertEquals(calcWorkerCloudUnits(0), 1);
  assertEquals(calcWorkerCloudUnits(1), 1);
  assertEquals(calcWorkerCloudUnits(250), 1);
  assertEquals(calcWorkerCloudUnits(251), 2);
  assertEquals(calcWorkerCloudUnits(30_000), 120);
  assertEquals(calcWorkerCloudUnits(120_000), 480);
  assertEquals(calcOperationCloudUnits(0, 1), 0);
  assertEquals(calcOperationCloudUnits(1, 1), 1);
  assertEquals(calcOperationCloudUnits(3, 2), 2);
  assertEquals(calcD1ReadCloudUnits(0), 0);
  assertEquals(calcD1ReadCloudUnits(1), 1);
  assertEquals(calcD1ReadCloudUnits(100), 1);
  assertEquals(calcD1ReadCloudUnits(101), 2);
  assertEquals(calcD1WriteCloudUnits(0), 0);
  assertEquals(calcD1WriteCloudUnits(3), 3);
});

Deno.test("cloud usage debit calls atomic no-partial RPC with fractional amount", async () => {
  const previousEnv = globalThis.__env;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });

    return Promise.resolve(
      new Response(
        JSON.stringify([{
          event_id: "00000000-0000-0000-0000-000000000301",
          old_balance: 10,
          new_balance: 9.999,
          amount_debited: 0.001,
          deposit_debited: 0.001,
          earned_debited: 0,
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await debitCloudUsage({
      payerUserId: "00000000-0000-0000-0000-000000000101",
      callerUserId: "00000000-0000-0000-0000-000000000102",
      ownerUserId: "00000000-0000-0000-0000-000000000103",
      appId: "00000000-0000-0000-0000-000000000201",
      functionName: "run",
      receiptId: "receipt-123",
      source: "mcp",
      resource: "worker_execution",
      units: 1,
      cloudUnits: 1,
      amountLight: 0.001,
      billingConfigVersion: 2,
      metadata: { trace_id: "trace-123" },
    }, { fetchFn });

    assertEquals(result.amountDebited, 0.001);
    assertEquals(
      calls[0].url,
      "https://supabase.example/rest/v1/rpc/debit_cloud_usage",
    );
    assertEquals(calls[0].body.p_amount_light, 0.001);
    assertEquals(calls[0].body.p_cloud_units, 1);
    assertEquals(calls[0].body.p_allow_partial, undefined);
    assertEquals(
      calls[0].body.p_idempotency_key,
      "cloud_usage_debit:receipt-123:00000000-0000-0000-0000-000000000101:00000000-0000-0000-0000-000000000201:run:mcp:worker_execution",
    );
    assertEquals(calls[0].body.p_metadata, { trace_id: "trace-123" });
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("cloud operation debit applies R2/KV operation unit config", async () => {
  const previousEnv = globalThis.__env;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });

    return Promise.resolve(
      new Response(
        JSON.stringify([{
          event_id: "00000000-0000-0000-0000-000000000701",
          old_balance: 10,
          new_balance: 9.998,
          amount_debited: 0.002,
          deposit_debited: 0.002,
          earned_debited: 0,
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await debitCloudOperation({
      payerUserId: "00000000-0000-0000-0000-000000000101",
      callerUserId: "00000000-0000-0000-0000-000000000102",
      ownerUserId: "00000000-0000-0000-0000-000000000103",
      appId: "00000000-0000-0000-0000-000000000201",
      source: "storage",
      resource: "r2_operation",
      operation: "put",
      units: 3,
      billingConfig: {
        version: 9,
        cloudUnitLightPer1k: 1,
        r2OpsPerCloudUnit: 2,
        kvOpsPerCloudUnit: 1,
      },
      metadata: { key: "apps/app-1/index.js" },
    }, { fetchFn });

    assertEquals(result?.amountDebited, 0.002);
    assertEquals(calls[0].body.p_units, 3);
    assertEquals(calls[0].body.p_cloud_units, 2);
    assertEquals(calls[0].body.p_amount_light, 0.002);
    assertEquals(calls[0].body.p_billing_config_version, 9);
    assertEquals(calls[0].body.p_idempotency_key, null);
    assertEquals(calls[0].body.p_metadata, {
      key: "apps/app-1/index.js",
      operation: "put",
      operations_per_cloud_unit: 2,
    });
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("cloud operation debits within one receipt get unique idempotency keys per call", async () => {
  // Pins the repeated-operation billing semantics: cloud_usage_events
  // enforces a UNIQUE idempotency key and the debit RPC dedups known keys by
  // returning the prior response, so without a per-call discriminator every
  // same-operation debit after the first in an execution was silently
  // dropped (N store puts billed as one).
  const previousEnv = globalThis.__env;
  const keys: Array<string | null> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    keys.push(body.p_idempotency_key ?? null);
    return Promise.resolve(
      new Response(
        JSON.stringify([{
          event_id: "00000000-0000-0000-0000-000000000702",
          old_balance: 10,
          new_balance: 9.999,
          amount_debited: 0.001,
          deposit_debited: 0.001,
          earned_debited: 0,
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  const receiptId = `receipt-${crypto.randomUUID()}`;
  const baseParams = {
    payerUserId: "00000000-0000-0000-0000-000000000101",
    appId: "00000000-0000-0000-0000-000000000201",
    functionName: "syncFiles",
    source: "storage",
    resource: "r2_operation" as const,
    operation: "put",
    units: 1,
    receiptId,
  };

  try {
    await debitCloudOperation(baseParams, { fetchFn });
    await debitCloudOperation(baseParams, { fetchFn });
    await debitCloudOperation(baseParams, { fetchFn });
    // A different operation type sequences independently.
    await debitCloudOperation({ ...baseParams, operation: "get" }, { fetchFn });
    // An explicit caller-supplied key passes through untouched.
    await debitCloudOperation(
      { ...baseParams, idempotencyKey: "explicit-key-1" },
      { fetchFn },
    );

    assertEquals(keys.length, 5);
    // First call keeps the legacy key shape (no discriminator suffix).
    const first = String(keys[0]);
    assertEquals(first.startsWith("cloud_operation:"), true);
    assertEquals(first.includes(":c"), false);
    // Every same-operation repeat gets a DISTINCT key.
    assertEquals(new Set(keys.slice(0, 3)).size, 3);
    assertEquals(String(keys[1]).startsWith(`${first}:c`), true);
    assertEquals(String(keys[2]).startsWith(`${first}:c`), true);
    // The other operation starts its own sequence with a legacy-shaped key.
    assertEquals(String(keys[3]).endsWith(":get"), true);
    assertEquals(keys[4], "explicit-key-1");
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("D1 usage debit emits exact read and write cloud usage events", async () => {
  const previousEnv = globalThis.__env;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });

    return Promise.resolve(
      new Response(
        JSON.stringify([{
          event_id: body.p_resource === "d1_read"
            ? "00000000-0000-0000-0000-000000000801"
            : "00000000-0000-0000-0000-000000000802",
          old_balance: 10,
          new_balance: 9,
          amount_debited: Number(body.p_amount_light),
          deposit_debited: Number(body.p_amount_light),
          earned_debited: 0,
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await debitD1Usage({
      payerUserId: "00000000-0000-0000-0000-000000000101",
      callerUserId: "00000000-0000-0000-0000-000000000102",
      ownerUserId: "00000000-0000-0000-0000-000000000103",
      appId: "00000000-0000-0000-0000-000000000201",
      functionName: "search",
      receiptId: "receipt-d1",
      source: "tools/call",
      operation: "select",
      rowsRead: 250,
      rowsWritten: 3,
      billingConfig: {
        version: 10,
        cloudUnitLightPer1k: 1,
        d1ReadRowsPerCloudUnit: 100,
        d1WriteRowsPerCloudUnit: 1,
      },
      metadata: { sql_operation: "select" },
    }, { fetchFn });

    assertEquals(result?.rowsRead, 250);
    assertEquals(result?.rowsWritten, 3);
    assertEquals(result?.readCloudUnits, 3);
    assertEquals(result?.writeCloudUnits, 3);
    assertEquals(result?.amountLight, 0.006);
    assertEquals(calls.map((call) => call.body.p_resource), [
      "d1_read",
      "d1_write",
    ]);
    assertEquals(calls[0].body.p_units, 250);
    assertEquals(calls[0].body.p_cloud_units, 3);
    assertEquals(calls[0].body.p_amount_light, 0.003);
    assertEquals(calls[0].body.p_billing_config_version, 10);
    assertEquals(
      calls[0].body.p_idempotency_key,
      "d1_usage:receipt-d1:00000000-0000-0000-0000-000000000101:00000000-0000-0000-0000-000000000201:search:tools%2Fcall:select:read",
    );
    assertEquals(calls[1].body.p_units, 3);
    assertEquals(calls[1].body.p_cloud_units, 3);
    assertEquals(calls[1].body.p_amount_light, 0.003);
    assertEquals(calls[1].body.p_billing_config_version, 10);
    assertEquals(
      calls[1].body.p_idempotency_key,
      "d1_usage:receipt-d1:00000000-0000-0000-0000-000000000101:00000000-0000-0000-0000-000000000201:search:tools%2Fcall:select:write",
    );
    assertEquals(calls[0].body.p_metadata.rows_per_cloud_unit, 100);
    assertEquals(calls[1].body.p_metadata.rows_per_cloud_unit, 1);
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("cloud usage hold lifecycle maps reserve, settle, and release RPCs", async () => {
  const previousEnv = globalThis.__env;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });

    if (url.endsWith("/rpc/create_cloud_usage_hold")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([{
            hold_id: "00000000-0000-0000-0000-000000000401",
            old_balance: 2,
            new_balance: 1.75,
            held_amount_light: 0.25,
            held_deposit_light: 0.25,
            held_earned_light: 0,
          }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    if (url.endsWith("/rpc/settle_cloud_usage_hold")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([{
            event_id: "00000000-0000-0000-0000-000000000402",
            hold_id: "00000000-0000-0000-0000-000000000401",
            settled_amount_light: 0.1,
            released_amount_light: 0.15,
          }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        JSON.stringify([{
          hold_id: "00000000-0000-0000-0000-000000000403",
          released_amount_light: 0.25,
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const hold = await createCloudUsageHold({
      payerUserId: "00000000-0000-0000-0000-000000000101",
      source: "http",
      resource: "worker_execution",
      expectedUnits: 250,
      expectedCloudUnits: 250,
      expectedAmountLight: 0.25,
      expiresAt: "2026-05-05T12:00:00Z",
    }, { fetchFn });
    const settlement = await settleCloudUsageHold({
      holdId: hold.holdId,
      units: 100,
      cloudUnits: 100,
      amountLight: 0.1,
      metadata: { status: "ok" },
    }, { fetchFn });
    const release = await releaseCloudUsageHold({
      holdId: "00000000-0000-0000-0000-000000000403",
      metadata: { reason: "timeout" },
    }, { fetchFn });

    assertEquals(hold.heldAmountLight, 0.25);
    assertEquals(settlement.releasedAmountLight, 0.15);
    assertEquals(release.releasedAmountLight, 0.25);
    assertEquals(calls[0].body.p_expected_amount_light, 0.25);
    assertEquals(calls[0].body.p_idempotency_key, null);
    assertEquals(calls[1].body.p_amount_light, 0.1);
    assertEquals(
      calls[1].body.p_idempotency_key,
      "cloud_hold_settlement:00000000-0000-0000-0000-000000000401",
    );
    assertEquals(calls[2].body.p_metadata, { reason: "timeout" });
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("runtime cloud hold reserves timeout amount and settles exact duration", async () => {
  const previousEnv = globalThis.__env;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });

    if (url.endsWith("/rpc/create_app_call_runtime_cloud_hold")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([{
            hold_id: "00000000-0000-0000-0000-000000000601",
            payer_user_id: "00000000-0000-0000-0000-000000000101",
            sponsor_user_id: null,
            app_price_light: 3,
            app_charge_light: 3,
            free_call: false,
            free_call_count: null,
            free_call_limit: 0,
            old_balance: 10,
            new_balance: 9.94,
            held_amount_light: 0.06,
            held_deposit_light: 0.06,
            held_earned_light: 0,
          }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        JSON.stringify([{
          event_id: "00000000-0000-0000-0000-000000000602",
          hold_id: "00000000-0000-0000-0000-000000000601",
          settled_amount_light: 0.006,
          released_amount_light: 0.054,
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const hold = await createRuntimeCloudHold({
      callerUserId: "00000000-0000-0000-0000-000000000101",
      ownerUserId: "00000000-0000-0000-0000-000000000102",
      appId: "00000000-0000-0000-0000-000000000201",
      functionName: "run",
      receiptId: "receipt-runtime",
      source: "run",
      timeoutMs: 30_000,
      appPriceLight: 3,
      billingConfig: {
        version: 12,
        workerMsPerCloudUnit: 1_000,
        cloudUnitLightPer1k: 2,
      },
    }, { fetchFn });
    const settlement = await settleRuntimeCloudHold({
      holdId: hold.holdId,
      durationMs: 2_001,
      billingConfig: {
        workerMsPerCloudUnit: 1_000,
        cloudUnitLightPer1k: 2,
      },
    }, { fetchFn });

    assertEquals(hold.expectedCloudUnits, 30);
    assertEquals(hold.expectedAmountLight, 0.06);
    assertEquals(calls[0].body.p_expected_units, 30_000);
    assertEquals(calls[0].body.p_expected_cloud_units, 30);
    assertEquals(calls[0].body.p_expected_amount_light, 0.06);
    assertEquals(calls[0].body.p_billing_config_version, 12);
    assertEquals(
      calls[0].body.p_idempotency_key,
      "runtime_cloud_hold:receipt-runtime:00000000-0000-0000-0000-000000000101:00000000-0000-0000-0000-000000000102:00000000-0000-0000-0000-000000000201:run:run",
    );
    assertEquals(settlement.cloudUnits, 3);
    assertEquals(settlement.amountLight, 0.006);
    assertEquals(calls[1].body.p_units, 2_001);
    assertEquals(calls[1].body.p_cloud_units, 3);
    assertEquals(calls[1].body.p_amount_light, 0.006);
    assertEquals(
      calls[1].body.p_idempotency_key,
      "runtime_cloud_settlement:00000000-0000-0000-0000-000000000601",
    );
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("runtime cloud hold marks caller-funded free-call infra fallback", async () => {
  const previousEnv = globalThis.__env;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });

    return Promise.resolve(
      new Response(
        JSON.stringify([{
          hold_id: "00000000-0000-0000-0000-000000000701",
          payer_user_id: "00000000-0000-0000-0000-000000000101",
          sponsor_user_id: null,
          app_price_light: 0,
          app_charge_light: 0,
          free_call: true,
          free_call_count: null,
          free_call_limit: 0,
          old_balance: 10,
          new_balance: 9.88,
          held_amount_light: 0.12,
          held_deposit_light: 0.12,
          held_earned_light: 0,
        }]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const hold = await createRuntimeCloudHold({
      callerUserId: "00000000-0000-0000-0000-000000000101",
      ownerUserId: "00000000-0000-0000-0000-000000000102",
      appId: "00000000-0000-0000-0000-000000000201",
      functionName: "run",
      receiptId: "receipt-runtime-fallback",
      source: "run",
      timeoutMs: 30_000,
      appPriceLight: 0,
    }, { fetchFn });

    assertEquals(hold.freeCall, true);
    assertEquals(hold.appChargeLight, 0);
    assertEquals(hold.payerUserId, "00000000-0000-0000-0000-000000000101");
    assertEquals(hold.ownerSponsoredInfra, false);
    assertEquals(hold.callerInfraFallback, true);
    assertEquals(calls[0].body.p_app_price_light, 0);
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("cloud usage event client accepts scalar RPC response", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = (() =>
    Promise.resolve(
      new Response(JSON.stringify("00000000-0000-0000-0000-000000000501"), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;

  try {
    const eventId = await recordCloudUsageEvent({
      payerUserId: "00000000-0000-0000-0000-000000000101",
      source: "storage",
      resource: "storage_at_rest",
      units: 1,
      cloudUnits: 1,
      amountLight: 0.001,
    }, { fetchFn });

    assertEquals(eventId, "00000000-0000-0000-0000-000000000501");
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("cloud usage RPC failures surface status and RPC name", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = (() =>
    Promise.resolve(
      new Response("Insufficient available balance", { status: 400 }),
    )) as typeof fetch;

  try {
    const error = await assertRejects(
      () =>
        debitCloudUsage({
          payerUserId: "00000000-0000-0000-0000-000000000101",
          source: "mcp",
          resource: "worker_execution",
          units: 1,
          cloudUnits: 1,
          amountLight: 0.001,
        }, { fetchFn }),
      CloudUsageRpcError,
    );

    assertEquals(error.rpc, "debit_cloud_usage");
    assertEquals(error.status, 400);
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("peekCallerUsage maps the peek RPC rows to a counter->count map", async () => {
  const previousEnv = globalThis.__env;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    calls.push({ url, body });
    return Promise.resolve(
      new Response(
        JSON.stringify([
          { counter_key: "__app__", call_count: 4 },
          { counter_key: "metered", call_count: 1 },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;

  try {
    const usage = await peekCallerUsage(
      "00000000-0000-0000-0000-000000000201",
      "00000000-0000-0000-0000-000000000102",
      { fetchFn },
    );
    assertEquals(
      calls[0].url,
      "https://supabase.example/rest/v1/rpc/peek_app_caller_usage",
    );
    assertEquals(calls[0].body.p_app_id, "00000000-0000-0000-0000-000000000201");
    assertEquals(calls[0].body.p_user_id, "00000000-0000-0000-0000-000000000102");
    assertEquals(usage.get("__app__"), 4);
    assertEquals(usage.get("metered"), 1);
    assertEquals(usage.get("missing"), undefined);
  } finally {
    globalThis.__env = previousEnv;
  }
});

Deno.test("peekCallerUsage returns an empty map when the caller has no counters", async () => {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;

  const fetchFn = (() =>
    Promise.resolve(
      new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;

  try {
    const usage = await peekCallerUsage("app", "user", { fetchFn });
    assertEquals(usage.size, 0);
  } finally {
    globalThis.__env = previousEnv;
  }
});
