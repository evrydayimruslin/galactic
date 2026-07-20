import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { processComputeDlqMessage } from "./compute-dlq-consumer.ts";
import type {
  ComputeTerminalizationIdentity,
  StaleComputeRunCandidate,
} from "./compute/reconciliation.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function candidate(): StaleComputeRunCandidate {
  return {
    runId: RUN_ID,
    userId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    callerFunction: "develop",
    state: "running",
    stateVersion: "5",
    claimId: "44444444-4444-4444-8444-444444444444",
    leaseId: "55555555-5555-4555-8555-555555555555",
    containerId: `run-${RUN_ID}`,
    expiresAt: "2026-07-20T01:00:00.000Z",
    claimExpiresAt: "2026-07-20T01:00:00.000Z",
    stopRequestedAt: "2026-07-20T00:00:00.000Z",
    stopReason: "compute_dispatch_dlq_exhausted",
    requiresBodyDestroy: true,
  };
}

function terminal(): ComputeTerminalizationIdentity {
  return {
    runId: RUN_ID,
    userId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    callerFunction: "develop",
    outcome: "failed",
    reason: "compute_dispatch_dlq_exhausted",
    receiptId: "66666666-6666-4666-8666-666666666666",
    replayed: false,
  };
}

Deno.test("Compute DLQ fences, destroys, settles, alerts, then acks", async () => {
  const events: string[] = [];
  const outcome = await processComputeDlqMessage({
    version: 1,
    run_id: RUN_ID,
  }, {
    fence: () => {
      events.push("fence");
      return Promise.resolve({ terminal: false as const, candidate: candidate(), replayed: false });
    },
    destroy: () => {
      events.push("destroy");
      return Promise.resolve();
    },
    terminalize: (input) => {
      events.push(`terminal:${input.bodyDestroyed}`);
      return Promise.resolve(terminal());
    },
    notify: () => {
      events.push("notify");
      return Promise.resolve();
    },
  });
  assertEquals(outcome, "ack");
  assertEquals(events, ["fence", "destroy", "terminal:true", "notify"]);
});

Deno.test("Compute DLQ retries without settlement when destroy fails", async () => {
  let terminalCalls = 0;
  const outcome = await processComputeDlqMessage({
    version: 1,
    run_id: RUN_ID,
  }, {
    fence: () => Promise.resolve({
      terminal: false as const,
      candidate: candidate(),
      replayed: true,
    }),
    destroy: () => Promise.reject(new Error("not destroyed")),
    terminalize: () => {
      terminalCalls++;
      return Promise.resolve(terminal());
    },
  });
  assertEquals(outcome, "retry");
  assertEquals(terminalCalls, 0);
});

Deno.test("Compute DLQ cleanly acks malformed and terminal replays", async () => {
  assertEquals(await processComputeDlqMessage({ run_id: RUN_ID }), "ack");
  assertEquals(await processComputeDlqMessage({ version: 1, run_id: RUN_ID }, {
    fence: () => Promise.resolve({
      terminal: true as const,
      runId: RUN_ID,
      userId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      callerFunction: "develop",
      outcome: "succeeded" as const,
      receiptId: "66666666-6666-4666-8666-666666666666",
    }),
  }), "ack");
});

Deno.test("Compute DLQ acks a run owned by another durable stop fence", async () => {
  let destroyed = false;
  const outcome = await processComputeDlqMessage({
    version: 1,
    run_id: RUN_ID,
  }, {
    fence: () => Promise.resolve({
      terminal: false as const,
      skipped: true as const,
      reason: "foreign_stop_fence" as const,
    }),
    destroy: () => {
      destroyed = true;
      return Promise.resolve();
    },
  });
  assertEquals(outcome, "ack");
  assertEquals(destroyed, false);
});
