import { assertEquals, assertRejects } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { revokeAgentComputeBeforeDeletion } from "./compute-agent-deletion.ts";
import type { ComputeAgentPolicy, ComputeRun } from "./compute/types.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const policy = {
  state: "active",
  authorityEpoch: "4",
} as ComputeAgentPolicy;
const run = {
  id: RUN_ID,
  userId: USER_ID,
  agentId: AGENT_ID,
  callerFunction: "develop",
  state: "running",
  stateVersion: "8",
} as ComputeRun;

Deno.test("Agent deletion revokes, destroys, then terminalizes Compute", async () => {
  const events: string[] = [];
  await revokeAgentComputeBeforeDeletion({ userId: USER_ID, agentId: AGENT_ID }, {
    getPolicy: () => Promise.resolve(policy),
    revokePolicy: (input) => {
      events.push(`revoke:${input.expectedAuthorityEpoch}`);
      return Promise.resolve({ state: "revoked", authorityEpoch: "5" });
    },
    listActiveRuns: () => Promise.resolve([run]),
    env: {
      COMPUTE_PLANE: {
        runtimeIdentity: () => Promise.resolve({
          profile: "developer-v1",
          environmentDigest: `sha256:${"a".repeat(64)}`,
        }),
        executeRun: () => Promise.resolve(null),
        cancelRun: () => {
          events.push("destroy");
          return Promise.resolve({ destroyed: true });
        },
      },
    },
    terminalize: (input) => {
      events.push(`terminal:${input.bodyDestroyed}:${input.expectedStateVersion}`);
      return Promise.resolve({} as never);
    },
  });
  assertEquals(events, ["revoke:4", "destroy", "terminal:true:8"]);
});

Deno.test("Agent deletion fails closed when an active body cannot be destroyed", async () => {
  await assertRejects(() => revokeAgentComputeBeforeDeletion({
    userId: USER_ID,
    agentId: AGENT_ID,
  }, {
    getPolicy: () => Promise.resolve({ ...policy, state: "revoked" }),
    listActiveRuns: () => Promise.resolve([run]),
    env: {},
  }), Error, "deletion is blocked");
});
