import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  computeGpuCallCost,
  estimateMaxGpuCost,
  settleGpuExecution,
} from "./billing.ts";
import { computeGpuCostLight } from "./types.ts";
import type { GpuExecuteResult } from "./executor.ts";
import type { App } from "../../../shared/types/index.ts";

const TEST_ENV = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

async function withMockedEnv<T>(fn: () => Promise<T> | T): Promise<T> {
  const globalWithEnv = globalThis as typeof globalThis & { __env?: Record<string, unknown> };
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

function createGpuApp(gpuPricingConfig: Record<string, unknown> | null = null): App {
  return {
    id: "app_gpu",
    owner_id: "owner_gpu",
    slug: "gpu-app",
    name: "GPU App",
    runtime: "gpu",
    gpu_type: "A40",
    gpu_status: "live",
    gpu_pricing_config: gpuPricingConfig,
    gpu_max_duration_ms: 60_000,
  } as unknown as App;
}

function createGpuResult(overrides: Partial<GpuExecuteResult> = {}): GpuExecuteResult {
  const billableDurationMs = overrides.billableDurationMs ?? 3_000;
  return {
    success: true,
    result: { ok: true },
    logs: [],
    durationMs: 2_700,
    executionDurationMs: 1_500,
    delayTimeMs: 600,
    billableDurationMs,
    billingIncrementMs: 1_000,
    exitCode: "success",
    peakVramGb: 12,
    gpuType: "A40",
    gpuCostLight: computeGpuCostLight("A40", billableDurationMs),
    ...overrides,
  };
}

Deno.test("gpu billing: compute pass-through is always separate from per-duration developer fees", () => {
  const app = createGpuApp({
    mode: "per_duration",
    duration_rate_light_per_second: 2,
    duration_markup_light: 1,
  });
  const result = createGpuResult();

  const breakdown = computeGpuCallCost(app, "render", {}, result);

  assertEquals(breakdown.computeCostLight, 0.3);
  assertEquals(breakdown.developerFeeLight, 7);
  assertEquals(breakdown.totalCostLight, 7.3);
  assertEquals(breakdown.billableDurationMs, 3_000);
  assertEquals(breakdown.delayTimeMs, 600);
});

Deno.test("gpu billing: max estimates include cold-start buffer and billed-second rounding", () => {
  const app = createGpuApp({
    mode: "per_duration",
    duration_rate_light_per_second: 1,
    duration_markup_light: 2,
  });

  assertEquals(estimateMaxGpuCost(app, "render", {}), 101);
});

Deno.test("gpu billing: settlement preflights total balance before charging", async () => {
  await withMockedEnv(async () => {
    const calls: string[] = [];
    const result = await settleGpuExecution(
      "caller_gpu",
      createGpuApp({ mode: "per_call", flat_fee_light: 10 }),
      "render",
      {},
      createGpuResult(),
      {
        fetchFn: async (input) => {
          const url = String(input);
          calls.push(url);
          if (url.includes("/rest/v1/users")) {
            return new Response(JSON.stringify([{ balance_light: 5 }]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          throw new Error(`Unexpected fetch after insufficient balance: ${url}`);
        },
      },
    );

    assertEquals(result.insufficientBalance, true);
    assertEquals(result.chargedLight, 0);
    assertEquals(calls.some((url) => url.includes("/rpc/")), false);
  });
});

Deno.test("gpu billing: settlement debits compute before developer transfer with rich timing metadata", async () => {
  await withMockedEnv(async () => {
    const rpcBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = createGpuResult();
    const settlement = await settleGpuExecution(
      "caller_gpu",
      createGpuApp({ mode: "per_duration", duration_rate_light_per_second: 2, duration_markup_light: 1 }),
      "render",
      {},
      result,
      {
        fetchFn: async (input, init) => {
          const url = String(input);
          const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
          rpcBodies.push({ url, body });

          if (url.includes("/rest/v1/users")) {
            return new Response(JSON.stringify([{ balance_light: 100 }]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/rpc/debit_light")) {
            return new Response(JSON.stringify([{
              old_balance: 100,
              new_balance: 99.7,
              was_depleted: false,
              amount_debited: 0.3,
            }]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url.includes("/billing_transactions")) {
            return new Response("{}", { status: 201 });
          }
          if (url.includes("/rpc/transfer_light")) {
            return new Response(JSON.stringify([{
              from_new_balance: 92.7,
              to_new_balance: 6.3,
              platform_fee: 0.7,
            }]), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        },
      },
    );

    assertEquals(settlement.computeChargedLight, 0.3);
    assertEquals(settlement.developerFeeChargedLight, 7);
    assertEquals(settlement.chargedLight, 7.3);

    const debitCall = rpcBodies.find((call) => call.url.includes("/rpc/debit_light"));
    const transferCall = rpcBodies.find((call) => call.url.includes("/rpc/transfer_light"));
    assert(debitCall);
    assert(transferCall);
    assert(rpcBodies.indexOf(debitCall) < rpcBodies.indexOf(transferCall));
    assertEquals(debitCall.body.p_allow_partial, false);
    assertEquals(debitCall.body.p_amount_light, 0.3);
    assertEquals((debitCall.body.p_metadata as Record<string, unknown>).billable_duration_ms, 3_000);
    assertEquals((debitCall.body.p_metadata as Record<string, unknown>).delay_time_ms, 600);
    assertEquals(transferCall.body.p_amount_light, 7);
  });
});
