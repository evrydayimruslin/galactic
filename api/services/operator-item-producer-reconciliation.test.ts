// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AccountCapacityStatus } from "./account-capacity.ts";
import {
  runOperatorItemProducerReconciliationCycle,
} from "./operator-item-producer-reconciliation.ts";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Canonical Journey",
};
const NOW = new Date("2026-07-24T18:00:00.000Z");

function status(
  burst: "available" | "low" | "waiting",
  weekly: "available" | "low" | "waiting" = "available",
): AccountCapacityStatus {
  return {
    planCode: "pro",
    state: burst === "waiting" || weekly === "waiting"
      ? "waiting"
      : burst === "low" || weekly === "low"
      ? "low"
      : "available",
    activeAgentLimit: null,
    burst: {
      state: burst,
      resetsAt: "2026-07-24T20:00:00.000Z",
    },
    weekly: {
      state: weekly,
      resetsAt: "2026-07-27T00:00:00.000Z",
    },
    nextEligibleAt: null,
    limitsPublic: false,
  };
}

function ownerDiscoveryFetch(owners: string[]): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(
        JSON.stringify(owners.map((user_id) => ({ user_id }))),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    )) as typeof fetch;
}

Deno.test("operator producer sweep replays account fanout and reset recovery", async () => {
  const reconciliations: Array<{
    userId: string;
    affectedAgentIds: string[];
    waiting: boolean;
  }> = [];
  const summary = await runOperatorItemProducerReconciliationCycle({
    now: NOW,
    ownerLimit: 25,
  }, {
    fetchFn: ownerDiscoveryFetch([USER_A, USER_A, USER_B]),
    supabaseUrl: "https://supabase.test",
    serviceRoleKey: "service-role",
    getAccountStatus: (userId) =>
      Promise.resolve(
        userId === USER_A ? status("waiting") : status("available"),
      ),
    loadAffectedAgents: () => Promise.resolve([AGENT]),
    reconcileAccountUsage: (input) => {
      reconciliations.push({
        userId: input.userId,
        affectedAgentIds: input.affectedAgents.map((agent) => agent.id),
        waiting: input.status.burst.state === "waiting",
      });
      return Promise.resolve({
        reconciliation: {
          observedCount: input.status.burst.state === "waiting" ? 1 : 0,
          insertedCount: 0,
          updatedCount: input.status.burst.state === "waiting" ? 1 : 0,
          recoveredCount: input.status.burst.state === "waiting" ? 0 : 1,
          items: [],
        },
      });
    },
  });

  assertEquals(reconciliations, [
    {
      userId: USER_A,
      affectedAgentIds: [AGENT.id],
      waiting: true,
    },
    {
      userId: USER_B,
      affectedAgentIds: [AGENT.id],
      waiting: false,
    },
  ]);
  assertEquals(summary, {
    checkedAt: NOW.toISOString(),
    ownersDiscovered: 2,
    ownersReconciled: 2,
    ownersFailed: 0,
    itemsObserved: 1,
    itemsRecovered: 1,
  });
});

Deno.test("operator producer sweep isolates owners and logs codes only", async () => {
  const logs: Array<Record<string, unknown>> = [];
  const summary = await runOperatorItemProducerReconciliationCycle({
    now: NOW,
  }, {
    fetchFn: ownerDiscoveryFetch([USER_A, USER_B]),
    supabaseUrl: "https://supabase.test",
    serviceRoleKey: "service-role",
    getAccountStatus: (userId) =>
      userId === USER_A
        ? Promise.reject(new Error("sk-secret-must-not-be-logged"))
        : Promise.resolve(status("available")),
    loadAffectedAgents: () => Promise.resolve([]),
    reconcileAccountUsage: () =>
      Promise.resolve({
        reconciliation: {
          observedCount: 0,
          insertedCount: 0,
          updatedCount: 0,
          recoveredCount: 1,
          items: [],
        },
      }),
    log: (_level, _message, fields) => logs.push(fields),
  });

  assertEquals(summary.ownersReconciled, 1);
  assertEquals(summary.ownersFailed, 1);
  assertEquals(logs, [{
    userId: USER_A,
    errorCode: "Error",
  }]);
  assertEquals(JSON.stringify(logs).includes("sk-secret"), false);
});

Deno.test("operator producer sweep validates its bounded owner limit", async () => {
  let threw = false;
  try {
    await runOperatorItemProducerReconciliationCycle({
      now: NOW,
      ownerLimit: 501,
    }, {
      fetchFn: ownerDiscoveryFetch([]),
      supabaseUrl: "https://supabase.test",
      serviceRoleKey: "service-role",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
