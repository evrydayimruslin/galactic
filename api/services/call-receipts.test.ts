import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import { buildCallReceipt } from "./call-receipts.ts";

Deno.test("call receipts: combines app economics with cloud usage resource breakdown", () => {
  const receipt = buildCallReceipt(
    {
      id: "receipt-123",
      app_price_light: 20,
      app_charge_light: 20,
      platform_fee_light: 3,
      developer_net_light: 17,
      cloud_payer_user_id: "caller-123",
      cloud_owner_sponsored: false,
    },
    [
      {
        id: "event-worker",
        receipt_id: "receipt-123",
        source: "tools/call",
        resource: "worker_execution",
        units: 375,
        cloud_units: 2,
        amount_light: 0.002,
      },
      {
        id: "event-r2",
        receipt_id: "receipt-123",
        source: "tools/call",
        resource: "r2_operation",
        units: 3,
        cloud_units: 3,
        amount_light: 0.003,
      },
      {
        id: "event-d1-read",
        receipt_id: "receipt-123",
        source: "tools/call",
        resource: "d1_read",
        units: 250,
        cloud_units: 3,
        amount_light: 0.003,
      },
    ],
  );

  assertEquals(receipt.app_price_light, 20);
  assertEquals(receipt.app_charge_light, 20);
  assertEquals(receipt.platform_fee_light, 3);
  assertEquals(receipt.developer_net_light, 17);
  assertEquals(receipt.infra_light, 0.008);
  assertEquals(receipt.total_light, 20.008);
  assertEquals(receipt.cloud_units, 8);
  assertEquals(receipt.worker_units.milliseconds, 375);
  assertEquals(receipt.worker_units.cloud_units, 2);
  assertEquals(receipt.r2_ops.operations, 3);
  assertEquals(receipt.d1_reads.rows, 250);
  assertEquals(receipt.cloud_usage_event_ids, [
    "event-worker",
    "event-r2",
    "event-d1-read",
  ]);
  assertEquals(receipt.caller_infra_fallback, false);
});

Deno.test("call receipts: marks caller-funded infra fallback for free calls", () => {
  const receipt = buildCallReceipt(
    {
      id: "receipt-free-fallback",
      user_id: "caller-123",
      app_price_light: 0,
      app_charge_light: 0,
      free_call: true,
      cloud_payer_user_id: "caller-123",
      cloud_owner_sponsored: false,
    },
    [
      {
        id: "event-worker-fallback",
        receipt_id: "receipt-free-fallback",
        source: "tools/call",
        resource: "worker_execution",
        units: 300,
        cloud_units: 2,
        amount_light: 0.002,
        metadata: { caller_infra_fallback: true },
      },
    ],
  );

  assertEquals(receipt.free_call, true);
  assertEquals(receipt.app_charge_light, 0);
  assertEquals(receipt.infra_light, 0.002);
  assertEquals(receipt.total_light, 0.002);
  assertEquals(receipt.owner_sponsored_infra, false);
  assertEquals(receipt.caller_infra_fallback, true);
});
