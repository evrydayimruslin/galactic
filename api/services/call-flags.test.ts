// Receipt-verified call flags (Phase 3) tests. Proves a flag is accepted ONLY
// for a real, recent receipt the flagger made and does not own — every other
// case is rejected with a reason (never throws, never silently counts).

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { recordCallFlag } from "./call-flags.ts";

interface MockOpts {
  receipt?: Record<string, unknown> | null; // mcp_call_logs row (null => not found)
  ownerId?: string | null; // apps.owner_id for the target
  ownerLookupFails?: boolean; // owner lookup returns non-2xx
  writeOk?: boolean;
}

function install(opts: MockOpts): { restore: () => void; posted: unknown[] } {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const prevEnv = g.__env;
  const prevFetch = globalThis.fetch;
  const posted: unknown[] = [];
  g.__env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "k" };
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/mcp_call_logs?")) {
      return Promise.resolve(
        new Response(JSON.stringify(opts.receipt ? [opts.receipt] : []), { status: 200 }),
      );
    }
    if (u.includes("/apps?")) {
      if (opts.ownerLookupFails) {
        return Promise.resolve(new Response("err", { status: 500 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify([{ owner_id: opts.ownerId ?? null }]), { status: 200 }),
      );
    }
    if (u.includes("/app_call_flags")) {
      posted.push(init?.body ? JSON.parse(String(init.body)) : null);
      return Promise.resolve(new Response(null, { status: opts.writeOk === false ? 500 : 200 }));
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof globalThis.fetch;
  return {
    restore: () => { g.__env = prevEnv; globalThis.fetch = prevFetch; },
    posted,
  };
}

const RECENT = () => new Date(Date.now() - 60_000).toISOString();

Deno.test("flag: real recent receipt, made by user, not self => ok + written", async () => {
  const m = install({
    receipt: { id: "r1", user_id: "u1", app_id: "app_a", function_name: "search", success: true, created_at: RECENT(), call_charge_light: 0.5 },
    ownerId: "someone_else",
  });
  try {
    const r = await recordCallFlag({ receiptId: "r1", userId: "u1", status: "negative", weight: 1 });
    assertEquals(r.ok, true);
    assertEquals(r.app_id, "app_a");
    assertEquals(r.status, "negative");
    assertEquals(m.posted.length, 1);
    // deno-lint-ignore no-explicit-any
    assertEquals((m.posted[0] as any).receipt_id, "r1");
    // deno-lint-ignore no-explicit-any
    assertEquals((m.posted[0] as any).app_id, "app_a");
  } finally {
    m.restore();
  }
});

Deno.test("flag: unknown receipt => receipt_not_found (no write)", async () => {
  const m = install({ receipt: null });
  try {
    const r = await recordCallFlag({ receiptId: "rX", userId: "u1", status: "positive", weight: 1 });
    assertEquals(r.ok, false);
    assertEquals(r.reason, "receipt_not_found");
    assertEquals(m.posted.length, 0);
  } finally {
    m.restore();
  }
});

Deno.test("flag: receipt belongs to another user => receipt_not_yours", async () => {
  const m = install({
    receipt: { id: "r1", user_id: "OTHER", app_id: "app_a", function_name: "x", success: true, created_at: RECENT(), call_charge_light: 1 },
    ownerId: "someone_else",
  });
  try {
    const r = await recordCallFlag({ receiptId: "r1", userId: "u1", status: "positive", weight: 1 });
    assertEquals(r.ok, false);
    assertEquals(r.reason, "receipt_not_yours");
    assertEquals(m.posted.length, 0);
  } finally {
    m.restore();
  }
});

Deno.test("flag: stale receipt (>24h) => receipt_stale", async () => {
  const m = install({
    receipt: { id: "r1", user_id: "u1", app_id: "app_a", function_name: "x", success: true, created_at: new Date(Date.now() - 48 * 3600_000).toISOString(), call_charge_light: 1 },
    ownerId: "someone_else",
  });
  try {
    const r = await recordCallFlag({ receiptId: "r1", userId: "u1", status: "positive", weight: 1 });
    assertEquals(r.ok, false);
    assertEquals(r.reason, "receipt_stale");
    assertEquals(m.posted.length, 0);
  } finally {
    m.restore();
  }
});

Deno.test("flag: free / zero-charge call => free_call (no write, no price floor to farm)", async () => {
  const m = install({
    receipt: { id: "r1", user_id: "u1", app_id: "app_a", function_name: "x", success: true, created_at: RECENT(), call_charge_light: 0 },
    ownerId: "someone_else",
  });
  try {
    const r = await recordCallFlag({ receiptId: "r1", userId: "u1", status: "positive", weight: 1 });
    assertEquals(r.ok, false);
    assertEquals(r.reason, "free_call");
    assertEquals(m.posted.length, 0);
  } finally {
    m.restore();
  }
});

Deno.test("flag: owner lookup failure => lookup_failed, fails CLOSED (no write)", async () => {
  const m = install({
    receipt: { id: "r1", user_id: "u1", app_id: "app_a", function_name: "x", success: true, created_at: RECENT(), call_charge_light: 1 },
    ownerLookupFails: true,
  });
  try {
    const r = await recordCallFlag({ receiptId: "r1", userId: "u1", status: "positive", weight: 1 });
    assertEquals(r.ok, false);
    assertEquals(r.reason, "lookup_failed");
    assertEquals(m.posted.length, 0); // never written when self-check can't run
  } finally {
    m.restore();
  }
});

Deno.test("flag: flagger owns the target Agent => self_flag (anti-inflation)", async () => {
  const m = install({
    receipt: { id: "r1", user_id: "u1", app_id: "app_a", function_name: "x", success: true, created_at: RECENT(), call_charge_light: 1 },
    ownerId: "u1", // the flagger owns the target
  });
  try {
    const r = await recordCallFlag({ receiptId: "r1", userId: "u1", status: "positive", weight: 1 });
    assertEquals(r.ok, false);
    assertEquals(r.reason, "self_flag");
    assertEquals(m.posted.length, 0);
  } finally {
    m.restore();
  }
});

Deno.test("flag: write failure surfaces write_failed", async () => {
  const m = install({
    receipt: { id: "r1", user_id: "u1", app_id: "app_a", function_name: "x", success: true, created_at: RECENT(), call_charge_light: 1 },
    ownerId: "someone_else",
    writeOk: false,
  });
  try {
    const r = await recordCallFlag({ receiptId: "r1", userId: "u1", status: "positive", weight: 1 });
    assertEquals(r.ok, false);
    assertEquals(r.reason, "write_failed");
  } finally {
    m.restore();
  }
});
