import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDynamicCapacityObservations } from "../../services/capacity-tail-observation.ts";

const RECEIPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

Deno.test("dynamic capacity Tail attributes exact CPU from the internal receipt header", () => {
  assertEquals(buildDynamicCapacityObservations([{
    cpuTime: 13,
    wallTime: 120_000,
    eventTimestamp: Date.parse("2026-07-18T02:00:00Z"),
    event: { request: { headers: { "X-Galactic-Capacity-Receipt": RECEIPT } } },
  }]), [{
    version: 1,
    receiptId: RECEIPT,
    cpuTimeMs: 13,
    wallTimeMs: 120_000,
    observedAt: "2026-07-18T02:00:00.000Z",
    source: "cloudflare_dynamic_tail",
  }]);
});

Deno.test("dynamic capacity Tail ignores missing and malformed receipts", () => {
  assertEquals(buildDynamicCapacityObservations([
    { cpuTime: 10 },
    { cpuTime: 20, event: { request: { headers: { "x-galactic-capacity-receipt": "bad" } } } },
  ]), []);
});

Deno.test("dynamic capacity Tail rejects tenant-forgeable log markers", () => {
  assertEquals(buildDynamicCapacityObservations([{
    cpuTimeMs: 7,
    wallTimeMs: 900,
    eventTimestamp: Date.parse("2026-07-18T02:01:00Z"),
    logs: [{
      message: [
        `GALACTIC_DYNAMIC_CAPACITY_EXECUTION_V1 {"receipt_id":"${RECEIPT}"}`,
      ],
    }],
  }]), []);
});
