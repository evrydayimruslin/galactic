import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { recoverAdmittedComputeDispatches } from "./compute-dispatch-recovery.ts";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

Deno.test("Compute dispatch recovery requeues unique admitted runs", async () => {
  const messages: unknown[] = [];
  const result = await recoverAdmittedComputeDispatches({}, {
    now: () => new Date("2026-07-20T00:00:00.000Z"),
    listCandidates: ({ now, limit }) => {
      assertEquals(now, "2026-07-20T00:00:00.000Z");
      assertEquals(limit, 100);
      return Promise.resolve([RUN_A, RUN_A, RUN_B]);
    },
    enqueue: (message) => {
      messages.push(message);
      return message.run_id === RUN_B
        ? Promise.reject(new Error("queue unavailable"))
        : Promise.resolve();
    },
  });
  assertEquals(messages, [
    { version: 1, run_id: RUN_A },
    { version: 1, run_id: RUN_B },
  ]);
  assertEquals(result, { candidates: 2, enqueued: 1, failed: 1 });
});

Deno.test("Compute dispatch recovery rejects invalid candidate identity", async () => {
  await assertRejects(() => recoverAdmittedComputeDispatches({}, {
    listCandidates: () => Promise.resolve(["body-controlled"]),
    enqueue: () => Promise.resolve(),
  }));
});
