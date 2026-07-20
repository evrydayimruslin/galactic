import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

import {
  notifyComputeDispatchDeadLetter,
  notifyComputeInfrastructureFailure,
  notifyComputeSettlementPending,
} from "./alerts.ts";
import { createNotification } from "../notifications.ts";

const run = {
  runId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  callerFunction: "developer",
};

Deno.test("Compute alerts preserve Agent attribution and stable dedupe", async () => {
  const rows: Array<Record<string, unknown>> = [];
  const createNotificationFn: typeof createNotification = (input) => {
    rows.push(input as unknown as Record<string, unknown>);
    return Promise.resolve(null);
  };

  await notifyComputeInfrastructureFailure(run, {
    code: "image_unavailable",
    message: "Developer image could not start.",
    retryable: true,
  }, { createNotificationFn });
  await notifyComputeSettlementPending(run, { createNotificationFn });
  await notifyComputeDispatchDeadLetter(run, { createNotificationFn });

  assertEquals(rows.map((row) => row.agentId), [run.agentId, run.agentId, run.agentId]);
  assertEquals(rows.map((row) => row.entityId), [run.runId, run.runId, run.runId]);
  assertEquals(rows.map((row) => row.severity), ["warning", "critical", "critical"]);
  assertEquals(rows.map((row) => row.dedupeKey), [
    `compute:failure:${run.runId}:image_unavailable`,
    `compute:settlement-pending:${run.runId}`,
    `compute:dispatch-dead-letter:${run.runId}`,
  ]);
});
