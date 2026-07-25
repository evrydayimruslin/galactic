// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  LaunchAgentHomeRequirement,
  LaunchOperatorItemCandidate,
} from "../../shared/contracts/launch.ts";
import {
  compileOperatorItem,
  compileOperatorItems,
} from "./operator-issue-compiler.ts";
import {
  OperatorItemPersistenceError,
  reconcileOperatorItems,
} from "./operator-item-persistence.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_A = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Canonical Journey",
};
const AGENT_B = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Inbox Agent",
};
const OBSERVED_AT = "2026-07-24T18:00:00.000Z";
const DETECTED_AT = "2026-07-24T17:59:00.000Z";

function byokRequirement(): LaunchAgentHomeRequirement {
  return {
    id: "inference:byok",
    actionId: null,
    kind: "capability",
    label: "BYOK inference provider",
    description: null,
    required: true,
    configured: false,
    blocking: true,
    secret: true,
    settingKey: null,
    settingScope: null,
    input: null,
    placeholder: null,
    help: null,
    group: "Inference",
    destination: null,
    updatedAt: null,
    actions: [],
  };
}

function secretRequirement(): LaunchAgentHomeRequirement {
  return {
    id: "setting:IMAP_PASSWORD",
    actionId: "IMAP_PASSWORD",
    kind: "setting",
    label: "IMAP password",
    description: null,
    required: true,
    configured: false,
    blocking: true,
    secret: true,
    settingKey: "IMAP_PASSWORD",
    settingScope: "agent",
    input: "password",
    placeholder: null,
    help: null,
    group: "Inbox",
    destination: null,
    updatedAt: null,
    actions: ["set"],
  };
}

function byokItem(): LaunchOperatorItemCandidate {
  return compileOperatorItems([
    {
      condition: "setup_requirement",
      agent: AGENT_A,
      requirement: byokRequirement(),
      detectedAt: DETECTED_AT,
    },
    {
      condition: "setup_requirement",
      agent: AGENT_B,
      requirement: byokRequirement(),
      detectedAt: DETECTED_AT,
    },
  ])[0]!;
}

function secretItem(): LaunchOperatorItemCandidate {
  return compileOperatorItem({
    condition: "setup_requirement",
    agent: AGENT_A,
    requirement: secretRequirement(),
    detectedAt: DETECTED_AT,
  })!;
}

function responseFor(items: readonly LaunchOperatorItemCandidate[]): Response {
  return Response.json({
    observedCount: items.length,
    insertedCount: items.length,
    updatedCount: 0,
    recoveredCount: 0,
    items: items.map((item, index) => ({
      id: `${index + 1}`.padStart(8, "0") +
        "-0000-4000-8000-000000000000",
      conditionKey: item.conditionKey,
      created: true,
    })),
  });
}

Deno.test("operator persistence writes one coalesced account blocker with exact fanout", async () => {
  const item = byokItem();
  let request: Request | null = null;
  const result = await reconcileOperatorItems(
    {
      userId: USER_ID,
      sourceKey: "agent_setup_reconciler",
      items: [item],
      observedAt: OBSERVED_AT,
      completeSnapshot: true,
    },
    {
      supabaseUrl: "https://supabase.test",
      serviceRoleKey: "service-role-test",
      fetchFn: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(responseFor([item]));
      },
    },
  );

  assertEquals(result.observedCount, 1);
  assertEquals(result.insertedCount, 1);
  assertEquals(result.items[0]?.conditionKey, "account:byok");
  assertEquals(
    request?.url,
    "https://supabase.test/rest/v1/rpc/reconcile_operator_items",
  );
  assertEquals(request?.method, "POST");
  assertEquals(request?.headers.get("cache-control"), "no-store");
  const body = JSON.parse(await request!.text());
  assertEquals(body.p_user_id, USER_ID);
  assertEquals(body.p_source_key, "agent_setup_reconciler");
  assertEquals(body.p_complete_snapshot, true);
  assertEquals(/^[0-9a-f]{64}$/u.test(body.p_snapshot_hash), true);
  assertEquals(body.p_items.length, 1);
  assertEquals(body.p_items[0].id, undefined);
  assertEquals(body.p_items[0].conditionKey, "account:byok");
  assertEquals(body.p_items[0].affectedAgents, [
    { agentId: AGENT_A.id, blocking: true },
    { agentId: AGENT_B.id, blocking: true },
  ]);
  assertEquals(
    /^[0-9a-f]{64}$/u.test(body.p_items[0].definitionHash),
    true,
  );
  assertEquals(JSON.stringify(body.p_items[0]).includes("url"), false);
});

Deno.test("operator persistence invokes a stored Worker fetch without a receiver", async () => {
  const item = byokItem();
  let receiver: unknown = "not-called";
  const receiverSensitiveFetch = (function (
    this: unknown,
  ) {
    receiver = this;
    if (this !== undefined) {
      throw new TypeError("Illegal invocation");
    }
    return Promise.resolve(responseFor([item]));
  }) as typeof fetch;

  await reconcileOperatorItems(
    {
      userId: USER_ID,
      sourceKey: "agent_setup_reconciler",
      items: [item],
      observedAt: OBSERVED_AT,
      completeSnapshot: true,
    },
    {
      supabaseUrl: "https://supabase.test",
      serviceRoleKey: "service-role-test",
      fetchFn: receiverSensitiveFetch,
    },
  );

  assertEquals(receiver, undefined);
});

Deno.test("operator persistence allows an empty complete snapshot to recover a source", async () => {
  let body: Record<string, unknown> | null = null;
  const result = await reconcileOperatorItems(
    {
      userId: USER_ID,
      sourceKey: "agent_setup_reconciler",
      items: [],
      observedAt: OBSERVED_AT,
      completeSnapshot: true,
    },
    {
      supabaseUrl: "https://supabase.test/",
      serviceRoleKey: "service-role-test",
      fetchFn: (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Promise.resolve(
          Response.json({
            observedCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            recoveredCount: 2,
            items: [],
          }),
        );
      },
    },
  );

  assertEquals(result.recoveredCount, 2);
  assertEquals(body?.p_items, []);
  assertEquals(body?.p_complete_snapshot, true);
});

Deno.test("operator persistence rejects unregistered targets before database access", async () => {
  const item = structuredClone(secretItem());
  const target = item.remediations[0]!.target as unknown as Record<
    string,
    unknown
  >;
  target.url = "https://attacker.example/collect";
  let fetched = false;
  const error = await assertRejects(
    () =>
      reconcileOperatorItems(
        {
          userId: USER_ID,
          sourceKey: "agent_setup_reconciler",
          items: [item],
          observedAt: OBSERVED_AT,
          completeSnapshot: false,
        },
        {
          supabaseUrl: "https://supabase.test",
          serviceRoleKey: "service-role-test",
          fetchFn: () => {
            fetched = true;
            return Promise.resolve(responseFor([item]));
          },
        },
      ),
    OperatorItemPersistenceError,
  );
  assertEquals(error.code, "UNSAFE_ITEM");
  assertEquals(fetched, false);
});

Deno.test("operator persistence rejects cross-Agent remediation targets", async () => {
  const item = structuredClone(secretItem());
  const remediation = item.remediations[0]!;
  if ("agentId" in remediation.target) {
    remediation.target.agentId = AGENT_B.id;
  }
  const error = await assertRejects(
    () =>
      reconcileOperatorItems(
        {
          userId: USER_ID,
          sourceKey: "agent_setup_reconciler",
          items: [item],
          observedAt: OBSERVED_AT,
          completeSnapshot: false,
        },
        {
          supabaseUrl: "https://supabase.test",
          serviceRoleKey: "service-role-test",
          fetchFn: () => Promise.resolve(responseFor([item])),
        },
      ),
    OperatorItemPersistenceError,
  );
  assertEquals(error.code, "UNSAFE_ITEM");
  assertEquals(
    error.message,
    "Remediation target is outside the affected Agent scope.",
  );
});

Deno.test("operator persistence rejects secret-shaped diagnosis and future detection", async () => {
  const secret = structuredClone(secretItem());
  secret.diagnosis.detail = [
    "Credential ",
    "ghp_",
    "fakeCredential123456789012345",
  ].join("");
  const unsafe = await assertRejects(
    () =>
      reconcileOperatorItems({
        userId: USER_ID,
        sourceKey: "agent_setup_reconciler",
        items: [secret],
        observedAt: OBSERVED_AT,
        completeSnapshot: false,
      }),
    OperatorItemPersistenceError,
  );
  assertEquals(unsafe.code, "UNSAFE_ITEM");

  const future = structuredClone(secretItem());
  future.detectedAt = "2026-07-24T18:00:01.000Z";
  const invalid = await assertRejects(
    () =>
      reconcileOperatorItems({
        userId: USER_ID,
        sourceKey: "agent_setup_reconciler",
        items: [future],
        observedAt: OBSERVED_AT,
        completeSnapshot: false,
      }),
    OperatorItemPersistenceError,
  );
  assertEquals(invalid.code, "INVALID_INPUT");
});

Deno.test("operator persistence fails closed on database and response errors", async () => {
  const item = byokItem();
  const database = await assertRejects(
    () =>
      reconcileOperatorItems(
        {
          userId: USER_ID,
          sourceKey: "agent_setup_reconciler",
          items: [item],
          observedAt: OBSERVED_AT,
          completeSnapshot: false,
        },
        {
          supabaseUrl: "https://supabase.test",
          serviceRoleKey: "service-role-test",
          fetchFn: () =>
            Promise.resolve(
              Response.json({ message: "details stay private" }, {
                status: 409,
              }),
            ),
        },
      ),
    OperatorItemPersistenceError,
  );
  assertEquals(database.code, "PERSISTENCE_FAILED");
  assertEquals(database.message.includes("details stay private"), false);

  const response = await assertRejects(
    () =>
      reconcileOperatorItems(
        {
          userId: USER_ID,
          sourceKey: "agent_setup_reconciler",
          items: [item],
          observedAt: OBSERVED_AT,
          completeSnapshot: false,
        },
        {
          supabaseUrl: "https://supabase.test",
          serviceRoleKey: "service-role-test",
          fetchFn: () =>
            Promise.resolve(Response.json({
              observedCount: 1,
              insertedCount: 0,
              updatedCount: 0,
              recoveredCount: 0,
              items: [],
            })),
        },
      ),
    OperatorItemPersistenceError,
  );
  assertEquals(response.code, "INVALID_RESPONSE");

  const unreadable = await assertRejects(
    () =>
      reconcileOperatorItems(
        {
          userId: USER_ID,
          sourceKey: "agent_setup_reconciler",
          items: [item],
          observedAt: OBSERVED_AT,
          completeSnapshot: false,
        },
        {
          supabaseUrl: "https://supabase.test",
          serviceRoleKey: "service-role-test",
          fetchFn: () =>
            Promise.resolve({
              ok: true,
              text: () => Promise.reject(new Error("connection closed")),
            } as Response),
        },
      ),
    OperatorItemPersistenceError,
  );
  assertEquals(unreadable.code, "PERSISTENCE_FAILED");
});
