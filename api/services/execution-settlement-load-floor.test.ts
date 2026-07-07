// Per-(app,user,UTC-day) load-floor dedup (the "only the first call each day per
// user per agent pays the Dynamic Worker load fee" billing model). Gated by the
// same EXECUTED_LOADER_GET_REUSE flag as warm-isolate reuse, via
// loadFloorContext.perDayEligible. These tests pin the money-critical behavior:
// the day's FIRST loader pays the full floor, later same-day calls pay 0, and
// every uncertainty path FAILS TOWARD CHARGING (no leak).

import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertAlmostEquals } from "https://deno.land/std@0.210.0/assert/assert_almost_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { settleRuntimeCloudPreflight } from "./execution-settlement.ts";
import { settleRuntimeCloudHold } from "./cloud-usage.ts";

const FLOOR = 0.5;
// Fixed duration component for durationMs=0 at these rates (min 1 cloud unit *
// cloudUnitLightPer1k/1000). p_amount_light = DURATION_COST + effective floor,
// so we assert the FLOOR component = amount - DURATION_COST.
const DURATION_COST = 0.001;
const EPS = 1e-9;

// billingConfig fields settleRuntimeCloudHold reads.
// deno-lint-ignore no-explicit-any
const BILLING: any = {
  version: "test-v1",
  workerMsPerCloudUnit: 250,
  cloudUnitLightPer1k: 1,
  workerLoadLightPerInvocation: FLOOR,
};

function assertFloor(amount: number, expectedFloor: number, msg?: string) {
  assertAlmostEquals(amount - DURATION_COST, expectedFloor, EPS, msg);
}

// deno-lint-ignore no-explicit-any
function makePreflight(loadFloorContext: any): any {
  return {
    hold: {
      holdId: "00000000-0000-0000-0000-0000000000f1",
      expectedCloudUnits: 0,
      expectedAmountLight: FLOOR,
      payerUserId: "payer-1",
      ownerSponsoredInfra: false,
      callerInfraFallback: false,
    },
    pricing: {},
    billingConfig: BILLING,
    insufficientBalance: false,
    metadata: {},
    loadFloorContext,
  };
}

function jsonResp(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Build a fetchFn that returns `incrementCount` from increment_caller_usage (or
// a failure if incrementStatus != 200), captures every settle_cloud_usage_hold
// body, and records whether the counter was hit.
function makeFetch(opts: {
  incrementCount?: number;
  incrementStatus?: number;
  settleBodies: Array<Record<string, unknown>>;
  counterHit: { value: boolean };
}): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body && typeof init.body === "string"
      ? JSON.parse(init.body)
      : {};
    if (url.includes("/rpc/increment_caller_usage")) {
      opts.counterHit.value = true;
      if ((opts.incrementStatus ?? 200) !== 200) {
        return Promise.resolve(jsonResp({ error: "boom" }, opts.incrementStatus));
      }
      return Promise.resolve(jsonResp([{ call_count: opts.incrementCount ?? 1 }]));
    }
    if (url.includes("/rpc/settle_cloud_usage_hold")) {
      opts.settleBodies.push(body);
      return Promise.resolve(jsonResp([{
        event_id: "00000000-0000-0000-0000-0000000000e1",
        hold_id: body.p_hold_id,
        settled_amount_light: body.p_amount_light,
        released_amount_light: 0,
      }]));
    }
    return Promise.resolve(jsonResp([{}]));
  }) as typeof fetch;
}

function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.__env;
  globalThis.__env = {
    SUPABASE_URL: "https://supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
  } as unknown as typeof globalThis.__env;
  return fn().finally(() => {
    globalThis.__env = prev;
  });
}

async function settleWith(
  loadFloorContext: unknown,
  fetchOpts: { incrementCount?: number; incrementStatus?: number },
): Promise<{ amount: number; counterHit: boolean }> {
  const settleBodies: Array<Record<string, unknown>> = [];
  const counterHit = { value: false };
  const fetchFn = makeFetch({ ...fetchOpts, settleBodies, counterHit });
  await settleRuntimeCloudPreflight(
    makePreflight(loadFloorContext),
    0, // durationMs 0 → duration-cost 0 → p_amount_light == effective floor
    {},
    { fetchFn },
  );
  assertEquals(settleBodies.length, 1, "settle_cloud_usage_hold called once");
  return {
    amount: Number(settleBodies[0].p_amount_light),
    counterHit: counterHit.value,
  };
}

const ELIGIBLE = {
  appId: "00000000-0000-0000-0000-0000000000a1",
  callerUserId: "00000000-0000-0000-0000-0000000000b1",
  baseFloorLight: FLOOR,
  perDayEligible: true,
};

Deno.test("load-floor: per-day eligible, FIRST call of the day (count 1) pays the full floor", async () => {
  await withEnv(async () => {
    const r = await settleWith(ELIGIBLE, { incrementCount: 1 });
    assertFloor(r.amount, FLOOR);
    assert(r.counterHit, "the per-day counter must be consulted");
  });
});

Deno.test("load-floor: per-day eligible, LATER same-day call (count 2) pays 0 (floor released)", async () => {
  await withEnv(async () => {
    const r = await settleWith(ELIGIBLE, { incrementCount: 2 });
    assertFloor(r.amount, 0);
  });
});

Deno.test("load-floor: NOT per-day eligible → per-call floor, counter NOT consulted", async () => {
  await withEnv(async () => {
    const r = await settleWith(
      { ...ELIGIBLE, perDayEligible: false },
      { incrementCount: 2 },
    );
    assertFloor(r.amount, FLOOR, "ineligible keeps the full per-call floor");
    assertEquals(r.counterHit, false, "no per-day counter for ineligible calls");
  });
});

Deno.test("load-floor: counter RPC failure → full floor (FAIL TOWARD CHARGING, no leak)", async () => {
  await withEnv(async () => {
    const r = await settleWith(ELIGIBLE, { incrementStatus: 500 });
    assertFloor(r.amount, FLOOR);
  });
});

Deno.test("load-floor: floor OFF (config 0) → 0 floor, counter NOT consulted", async () => {
  await withEnv(async () => {
    // Realistic 'floor off' state: config floor 0 ⟹ baseFloorLight 0. The dedup
    // early-returns (no counter) and the settle charges only duration.
    const settleBodies: Array<Record<string, unknown>> = [];
    const counterHit = { value: false };
    const fetchFn = makeFetch({ incrementCount: 5, settleBodies, counterHit });
    const preflight = makePreflight({ ...ELIGIBLE, baseFloorLight: 0 });
    preflight.billingConfig = { ...BILLING, workerLoadLightPerInvocation: 0 };
    await settleRuntimeCloudPreflight(preflight, 0, {}, { fetchFn });
    assertFloor(Number(settleBodies[0].p_amount_light), 0);
    assertEquals(counterHit.value, false);
  });
});

Deno.test("load-floor: absent loadFloorContext → config per-call floor (backward compatible)", async () => {
  await withEnv(async () => {
    const r = await settleWith(undefined, { incrementCount: 9 });
    assertFloor(r.amount, FLOOR);
    assertEquals(r.counterHit, false);
  });
});

// ── settleRuntimeCloudHold override guard (the primitive) ──

async function settleFloorDirect(
  override: number | undefined,
): Promise<number> {
  const settleBodies: Array<Record<string, unknown>> = [];
  const fetchFn = makeFetch({
    settleBodies,
    counterHit: { value: false },
  });
  return await withEnv(async () => {
    await settleRuntimeCloudHold({
      holdId: "00000000-0000-0000-0000-0000000000f2",
      durationMs: 0,
      billingConfig: BILLING,
      loadFloorLightOverride: override,
    }, { fetchFn });
    return Number(settleBodies[0].p_amount_light);
  });
}

Deno.test("settleRuntimeCloudHold: override 0 charges 0; override 0.5 charges 0.5", async () => {
  assertFloor(await settleFloorDirect(0), 0);
  assertFloor(await settleFloorDirect(FLOOR), FLOOR);
});

Deno.test("settleRuntimeCloudHold: negative/NaN/undefined override falls back to config floor (never zeroes on a bad value)", async () => {
  assertFloor(await settleFloorDirect(-1), FLOOR);
  assertFloor(await settleFloorDirect(Number.NaN), FLOOR);
  assertFloor(await settleFloorDirect(undefined), FLOOR);
});
