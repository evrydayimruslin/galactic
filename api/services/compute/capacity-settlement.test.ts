import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  buildComputeCapacitySettlementIntent,
  computeCapacitySettlementInputFromIntent,
  MAX_COMPUTE_CAPACITY_SETTLEMENT_INTENT_BYTES,
  parseComputeCapacitySettlementIntent,
  settleComputeCapacityFromTerminalPayload,
  settleOrDeferComputeCapacity,
} from "./capacity-settlement.ts";

const INPUT = {
  runId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  receiptId: "33333333-3333-4333-8333-333333333333",
  reservationId: "44444444-4444-4444-8444-444444444444",
  actualLight: 0.4321,
};

Deno.test("Compute capacity settlement intent is compact, exact, and secret-free", () => {
  const intent = buildComputeCapacitySettlementIntent(INPUT);
  const encoded = JSON.stringify(intent);
  assert(
    new TextEncoder().encode(encoded).byteLength <
      MAX_COMPUTE_CAPACITY_SETTLEMENT_INTENT_BYTES,
  );
  assertEquals(parseComputeCapacitySettlementIntent(JSON.parse(encoded)), intent);
  assertEquals(computeCapacitySettlementInputFromIntent(intent), INPUT);
  assertEquals(encoded.includes("argv"), false);
  assertEquals(encoded.includes("secret"), false);
});

Deno.test("Compute capacity settlement is direct-first", async () => {
  let direct = 0;
  let queued = 0;
  assertEquals(await settleOrDeferComputeCapacity(INPUT, {
    settle: (value) => {
      direct += 1;
      assertEquals(value, INPUT);
      return Promise.resolve();
    },
    queue: {
      send: () => {
        queued += 1;
        return Promise.resolve();
      },
    },
  }), { deferred: false });
  assertEquals(direct, 1);
  assertEquals(queued, 0);
});

Deno.test("Compute capacity settlement durably defers the exact receipt facts", async () => {
  let queued: unknown;
  assertEquals(await settleOrDeferComputeCapacity(INPUT, {
    settle: () => Promise.reject(new Error("database unavailable")),
    queue: {
      send: (body) => {
        queued = body;
        return Promise.resolve();
      },
    },
  }), { deferred: true });
  const intent = parseComputeCapacitySettlementIntent(queued);
  assert(intent);
  assertEquals(computeCapacitySettlementInputFromIntent(intent), INPUT);
});

Deno.test("Compute capacity settlement fails closed without durable handoff", async () => {
  await assertRejects(
    () => settleOrDeferComputeCapacity(INPUT, {
      settle: () => Promise.reject(new Error("database unavailable")),
      queue: { send: () => Promise.reject(new Error("queue unavailable")) },
    }),
    Error,
    "could not be persisted safely",
  );
});

Deno.test("terminal payload settlement is exact and marks a direct success", async () => {
  const receipt: Record<string, unknown> = {
    id: INPUT.receiptId,
    run_id: INPUT.runId,
    user_id: INPUT.userId,
    billing_mode: "subscription_capacity",
    capacity_reservation_id: INPUT.reservationId,
    capacity_settlement_status: "pending",
    actual_light: INPUT.actualLight,
  };
  const result = await settleComputeCapacityFromTerminalPayload({ receipt }, {
    settle: (value) => {
      assertEquals(value, INPUT);
      return Promise.resolve();
    },
  });
  assertEquals(result, { applicable: true, deferred: false });
  assertEquals(receipt.capacity_settlement_status, "settled");
});

Deno.test("pre-body subscription terminalization needs no capacity settlement", async () => {
  let settled = false;
  const result = await settleComputeCapacityFromTerminalPayload({
    receipt: {
      id: INPUT.receiptId,
      run_id: INPUT.runId,
      user_id: INPUT.userId,
      billing_mode: "subscription_capacity",
      capacity_reservation_id: null,
      capacity_settlement_status: "not_applicable",
      actual_light: 0,
    },
  }, {
    settle: () => {
      settled = true;
      return Promise.resolve();
    },
  });
  assertEquals(result, { applicable: false, deferred: false });
  assertEquals(settled, false);
});

Deno.test("subscription not_applicable cannot conceal a reservation", async () => {
  await assertRejects(
    () => settleComputeCapacityFromTerminalPayload({
      receipt: {
        id: INPUT.receiptId,
        run_id: INPUT.runId,
        user_id: INPUT.userId,
        billing_mode: "subscription_capacity",
        capacity_reservation_id: INPUT.reservationId,
        capacity_settlement_status: "not_applicable",
        actual_light: 0,
      },
    }),
    Error,
    "inconsistent capacity backing",
  );
});
