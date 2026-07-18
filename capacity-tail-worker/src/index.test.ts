import {
  buildCapacityObservations,
  type TailItemLike,
} from "./index.ts";

const RECEIPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("capacity tail attributes loader Worker CPU by its host marker", () => {
  const items: TailItemLike[] = [
    {
      scriptName: "ultralight-api",
      cpuTime: 3,
      wallTime: 40,
      eventTimestamp: Date.parse("2026-07-18T00:00:00Z"),
      logs: [{
        message: [
          `GALACTIC_CAPACITY_EXECUTION_V1 {"receipt_id":"${RECEIPT}"}`,
        ],
      }],
    },
    {
      scriptName: "ultralight-api",
      cpuTime: 2,
      wallTime: 10,
      eventTimestamp: Date.parse("2026-07-18T00:00:01Z"),
      logs: [],
    },
    {
      scriptName: "dynamic-worker-tenant",
      cpuTime: 99,
      wallTime: 999,
      logs: [],
    },
  ];

  assertEquals(buildCapacityObservations(items), [{
    version: 1,
    receiptId: RECEIPT,
    cpuTimeMs: 5,
    wallTimeMs: 50,
    observedAt: "2026-07-18T00:00:01.000Z",
    source: "cloudflare_tail_parent",
  }]);
});

Deno.test("capacity tail ignores malformed and unattributed traces", () => {
  assertEquals(buildCapacityObservations([
    { cpuTime: 100, wallTime: 100 },
    {
      cpuTime: 50,
      logs: [{ message: ["GALACTIC_CAPACITY_EXECUTION_V1 not-json"] }],
    },
    {
      cpuTime: 25,
      event: { request: { headers: { "x-galactic-capacity-receipt": RECEIPT } } },
    },
  ]), []);
});

Deno.test("capacity tail rejects forged host markers from tenant scripts", () => {
  assertEquals(buildCapacityObservations([{
    scriptName: "dynamic-worker-tenant",
    cpuTime: 500,
    wallTime: 500,
    logs: [{
      message: [`GALACTIC_CAPACITY_EXECUTION_V1 {"receipt_id":"${RECEIPT}"}`],
    }],
  }]), []);
});

Deno.test("capacity tail never treats provider wall wait as CPU", () => {
  const [observation] = buildCapacityObservations([{
    scriptName: "ultralight-api",
    cpuTime: 4,
    wallTime: 120_000,
    logs: [{ message: [`GALACTIC_CAPACITY_EXECUTION_V1 {"receipt_id":"${RECEIPT}"}`] }],
  }]);
  assertEquals(observation.cpuTimeMs, 4);
  assertEquals(observation.wallTimeMs, 120_000);
});

Deno.test("capacity tail never multiplies a lifecycle across nested receipts", () => {
  const child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const observations = buildCapacityObservations([
    {
      scriptName: "ultralight-api",
      cpuTime: 3,
      wallTime: 30,
      eventTimestamp: Date.parse("2026-07-18T00:02:00Z"),
      logs: [{
        message: [`GALACTIC_CAPACITY_EXECUTION_V1 {"receipt_id":"${RECEIPT}"}`],
      }],
    },
    {
      scriptName: "ultralight-api",
      cpuTime: 4,
      wallTime: 40,
      eventTimestamp: Date.parse("2026-07-18T00:02:01Z"),
      logs: [{
        message: [`GALACTIC_CAPACITY_EXECUTION_V1 {"receipt_id":"${child}"}`],
      }],
    },
    {
      scriptName: "ultralight-api",
      cpuTime: 99,
      wallTime: 990,
      logs: [],
    },
  ]);

  assertEquals(observations.map((item) => [item.receiptId, item.cpuTimeMs]), [
    [RECEIPT, 102],
    [child, 4],
  ]);
});
