import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.210.0/assert/mod.ts";

import { executeComputeAgentFunction } from "./agent-call-executor.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const CAPACITY_AGENT_ID = "44444444-4444-4444-8444-444444444444";

const principal = {
  userId: USER_ID,
  user: {
    id: USER_ID,
    email: "owner@example.com",
    displayName: "Owner",
    avatarUrl: null,
    tier: "pro",
    provisional: false,
  },
  sourceAgentId: SOURCE_ID,
  capacityAgentId: CAPACITY_AGENT_ID,
  callerFunction: "developer",
  executionId: "execution-1",
};

const call = {
  userId: USER_ID,
  requestedAgentId: "target-agent",
  agentId: TARGET_ID,
  functionName: "summarize",
  args: { text: "hello" },
  confirmed: true,
};

Deno.test("Compute Agent call authorizes before minting or dispatch", async () => {
  const actions: string[] = [];
  await assertRejects(
    () =>
      executeComputeAgentFunction(call, principal, {
        authorizeExact: () => {
          actions.push("authorize");
          return Promise.resolve(false);
        },
        mintActorToken: () => {
          actions.push("mint");
          return Promise.resolve("actor-token");
        },
        resolveInternalCall: () => {
          actions.push("dispatch");
          throw new Error("must not dispatch");
        },
      }),
    Error,
    "not authorized",
  );
  assertEquals(actions, ["authorize"]);
});

Deno.test("Compute Agent call keeps host tokens private and ignores body confirmation", async () => {
  let request: Request | null = null;
  const result = await executeComputeAgentFunction(call, principal, {
    authorizeExact: () => Promise.resolve(true),
    mintActorToken: (input) => {
      assertEquals(input.appId, SOURCE_ID);
      assertEquals(input.hasBroadCallPermission, false);
      assertEquals(input.dependencyAppIds, [TARGET_ID]);
      return Promise.resolve("host-only-actor-token");
    },
    mintCallerToken: (input) => {
      assertEquals(input.callerAppId, SOURCE_ID);
      assertEquals(input.capacityAgentId, CAPACITY_AGENT_ID);
      assertEquals(input.callerFunction, "developer");
      return Promise.resolve("host-only-caller-token");
    },
    resolveInternalCall: () => ({
      url: `https://internal/mcp/${TARGET_ID}`,
      fetchFn: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(new Response(JSON.stringify({
          result: { content: [{ type: "text", text: '{"ok":true}' }] },
        }), { headers: { "content-type": "application/json" } }));
      },
    }),
  });

  assertEquals(result, { ok: true });
  const sent = request as Request | null;
  if (!sent) throw new Error("Agent call was not dispatched");
  assertEquals(sent.headers.get("Authorization"), "Bearer host-only-actor-token");
  assertEquals(sent.headers.get("X-Galactic-Caller"), "host-only-caller-token");
  assertEquals(sent.headers.get("X-Galactic-Confirm"), null);
  const payload = await sent.json() as { params?: unknown };
  assertEquals(payload.params, {
    name: "summarize",
    arguments: { text: "hello" },
  });
});

Deno.test("Compute Agent call rejects a mismatched job user", async () => {
  await assertRejects(
    () =>
      executeComputeAgentFunction(
        { ...call, userId: "55555555-5555-4555-8555-555555555555" },
        principal,
        { authorizeExact: () => Promise.resolve(true) },
      ),
    Error,
    "does not match",
  );
});
