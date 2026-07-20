import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { isComputeDlqQueueName } from "./compute-queue-routing.ts";

Deno.test("Compute DLQ routing recognizes production and staging exactly", () => {
  assertEquals(isComputeDlqQueueName("galactic-compute-dlq"), true);
  assertEquals(isComputeDlqQueueName("galactic-compute-staging-dlq"), true);
  assertEquals(isComputeDlqQueueName("galactic-compute"), false);
  assertEquals(isComputeDlqQueueName("x-galactic-compute-dlq"), false);
  assertEquals(
    isComputeDlqQueueName("galactic-compute-reconciliation-dlq"),
    false,
  );
});
