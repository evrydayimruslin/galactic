// App health (Phase 1 trust signal) tests. Proves the BINARY derivation: a
// window below the min-call OR min-distinct-payer floor is no_data (never red);
// a healthy ratio with enough independent payers is green; a degraded ratio is
// red; the empty default is all-no_data; and the batched query maps rows by
// app_id.

import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import {
  deriveHealthWindows,
  emptyHealth,
  getAppHealth,
  isRecentlyHealthy,
} from "./app-health.ts";

const ALL_NO_DATA = {
  "1h": "no_data",
  "24h": "no_data",
  "7d": "no_data",
  "30d": "no_data",
} as const;

// Convenience: a fully-zeroed row, override the windows under test.
function row(overrides: Record<string, number>) {
  return {
    calls_1h: 0, ok_1h: 0, payers_1h: 0,
    calls_24h: 0, ok_24h: 0, payers_24h: 0,
    calls_7d: 0, ok_7d: 0, payers_7d: 0,
    calls_30d: 0, ok_30d: 0, payers_30d: 0,
    ...overrides,
  };
}

Deno.test("app-health: isRecentlyHealthy is freshest-window green (no_data/red => not healthy)", () => {
  const H = (o: Record<string, string> = {}) => ({ "1h": "no_data", "24h": "no_data", "7d": "no_data", "30d": "no_data", ...o }) as ReturnType<typeof emptyHealth>;
  assertEquals(isRecentlyHealthy(H({ "24h": "green" })), true);
  assertEquals(isRecentlyHealthy(H({ "24h": "red", "7d": "green" })), false); // now-broken
  assertEquals(isRecentlyHealthy(H({ "7d": "green" })), true); // 24h no_data, 7d green
  assertEquals(isRecentlyHealthy(H()), false); // unproven
  assertEquals(isRecentlyHealthy(H({ "7d": "red" })), false);
});

Deno.test("app-health: empty default is all no_data", () => {
  assertEquals(emptyHealth(), { ...ALL_NO_DATA });
});

Deno.test("app-health: below the 5-call floor is no_data, never red", () => {
  // 0/4 would be a 0% success rate, but with too few calls we WITHHOLD a verdict
  // rather than smear a brand-new or low-traffic Agent red.
  const w = deriveHealthWindows(row({
    calls_1h: 4, ok_1h: 0, payers_1h: 4,
    calls_24h: 1, ok_24h: 1, payers_24h: 1,
    calls_30d: 4, ok_30d: 4, payers_30d: 4,
  }));
  assertEquals(w["1h"], "no_data");
  assertEquals(w["24h"], "no_data");
  assertEquals(w["7d"], "no_data");
  assertEquals(w["30d"], "no_data");
});

Deno.test("app-health: enough calls but a single payer is no_data (sybil floor)", () => {
  // 10/10 perfect success, but all from ONE non-owner identity — a single
  // sock-puppet payer. Must NOT be green; withhold until >= 2 distinct payers.
  const w = deriveHealthWindows(row({ calls_30d: 10, ok_30d: 10, payers_30d: 1 }));
  assertEquals(w["30d"], "no_data");
  // Same calls with a second distinct payer flips it green.
  const w2 = deriveHealthWindows(row({ calls_30d: 10, ok_30d: 10, payers_30d: 2 }));
  assertEquals(w2["30d"], "green");
});

Deno.test("app-health: at/above 95% success (with >=2 payers) is green, below is red", () => {
  const w = deriveHealthWindows(row({
    calls_1h: 100, ok_1h: 95, payers_1h: 5, // exactly threshold + payers => green
    calls_24h: 100, ok_24h: 94, payers_24h: 5, // just under => red
    calls_7d: 5, ok_7d: 5, payers_7d: 2, // 100% at both floors => green
    calls_30d: 10, ok_30d: 9, payers_30d: 3, // 90% => red
  }));
  assertEquals(w["1h"], "green");
  assertEquals(w["24h"], "red");
  assertEquals(w["7d"], "green");
  assertEquals(w["30d"], "red");
});

Deno.test("app-health: getAppHealth returns empty map for no ids (no fetch)", async () => {
  const map = await getAppHealth([]);
  assertEquals(map.size, 0);
});

Deno.test("app-health: getAppHealth maps view rows by app_id", async () => {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const prevEnv = g.__env;
  const prevFetch = globalThis.fetch;
  g.__env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "k" };
  globalThis.fetch = ((_url: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify([
          {
            app_id: "app_a",
            calls_1h: 10, ok_1h: 10, payers_1h: 3,
            calls_24h: 0, ok_24h: 0, payers_24h: 0,
            calls_7d: 0, ok_7d: 0, payers_7d: 0,
            calls_30d: 0, ok_30d: 0, payers_30d: 0,
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )) as typeof globalThis.fetch;
  try {
    const map = await getAppHealth(["app_a", "app_missing", "app_a"]);
    assertEquals(map.size, 1);
    assertEquals(map.get("app_a")?.["1h"], "green");
    assertEquals(map.get("app_a")?.["24h"], "no_data");
    assertEquals(map.has("app_missing"), false);
  } finally {
    g.__env = prevEnv;
    globalThis.fetch = prevFetch;
  }
});

Deno.test("app-health: PostgREST string-typed counts are coerced, not string-compared", async () => {
  // PostgREST returns bigint count(*) as JSON STRINGS ("10","10","3"); the
  // derivation must Number()-coerce them, not do "10"/"10" math.
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const prevEnv = g.__env;
  const prevFetch = globalThis.fetch;
  g.__env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "k" };
  globalThis.fetch = ((_url: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify([
          {
            app_id: "app_s",
            calls_1h: "10", ok_1h: "10", payers_1h: "3",
            calls_24h: "0", ok_24h: "0", payers_24h: "0",
            calls_7d: "0", ok_7d: "0", payers_7d: "0",
            calls_30d: "0", ok_30d: "0", payers_30d: "0",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )) as typeof globalThis.fetch;
  try {
    const map = await getAppHealth(["app_s"]);
    assertEquals(map.get("app_s")?.["1h"], "green");
  } finally {
    g.__env = prevEnv;
    globalThis.fetch = prevFetch;
  }
});

Deno.test("app-health: getAppHealth degrades to empty on a failed query", async () => {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const prevEnv = g.__env;
  const prevFetch = globalThis.fetch;
  g.__env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "k" };
  globalThis.fetch = (() =>
    Promise.resolve(new Response("nope", { status: 500 }))) as typeof globalThis.fetch;
  try {
    const map = await getAppHealth(["app_a"]);
    assertEquals(map.size, 0); // caller defaults these to emptyHealth()
  } finally {
    g.__env = prevEnv;
    globalThis.fetch = prevFetch;
  }
});
