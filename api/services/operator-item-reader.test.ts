// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  LaunchOperatorAttentionEntry,
  LaunchOperatorItem,
} from "../../shared/contracts/launch.ts";
import { compileOperatorItems } from "./operator-issue-compiler.ts";
import {
  isOperatorAttentionCursor,
  OperatorItemReadError,
  operatorItemReadFailureStage,
  readOperatorAttentionPage,
} from "./operator-item-reader.ts";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_A = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "canonical-journey",
  name: "Canonical Journey",
};
const AGENT_B = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "inbox",
  name: "Inbox Agent",
};
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const DETECTED_AT = "2026-07-24T18:00:00.000Z";

Deno.test("operator item reader exposes only allowlisted rollout failure stages", () => {
  assertEquals(
    operatorItemReadFailureStage(
      new OperatorItemReadError(
        "INVALID_RESPONSE",
        "Operator item 0 diagnosis is invalid.",
        503,
      ),
    ),
    "item_diagnosis_invalid",
  );
  assertEquals(
    operatorItemReadFailureStage(
      new OperatorItemReadError(
        "READ_FAILED",
        "upstream body must never be copied",
        503,
      ),
    ),
    "rpc_read_failed",
  );
  assertEquals(
    operatorItemReadFailureStage(new Error("secret-shaped arbitrary error")),
    "unknown",
  );
});

function entry(): LaunchOperatorAttentionEntry {
  const candidate = compileOperatorItems([
    {
      condition: "account_byok_missing",
      affectedAgents: [
        { id: AGENT_A.id, name: AGENT_A.name },
        { id: AGENT_B.id, name: AGENT_B.name },
      ],
      detectedAt: DETECTED_AT,
    },
  ])[0]!;
  return {
    item: { ...candidate, id: ITEM_ID } as LaunchOperatorItem,
    attention: {
      state: "open",
      readAt: null,
      snoozedUntil: null,
      dismissedAt: null,
    },
  };
}

function snapshot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items: [entry()],
    per_agent_counts: [
      {
        agent_id: AGENT_A.id,
        open_count: 1,
        requires_decision_count: 0,
        blocking_count: 1,
      },
      {
        agent_id: AGENT_B.id,
        open_count: 1,
        requires_decision_count: 0,
        blocking_count: 1,
      },
    ],
    open_count: 1,
    requires_decision_count: 0,
    blocking_count: 1,
    next_source_key: null,
    next_source_ordinal: null,
    next_detected_at: null,
    next_id: null,
    ...overrides,
  };
}

const dependencies = {
  supabaseUrl: "https://supabase.test",
  serviceRoleKey: "service-role-test",
  now: new Date("2026-07-24T19:00:00.000Z"),
};

Deno.test("operator item reader returns one shared condition with exact unique and fanout counts", async () => {
  let request: Request | null = null;
  const projection = await readOperatorAttentionPage(
    USER_ID,
    [AGENT_A, AGENT_B],
    null,
    { limit: 25 },
    {
      ...dependencies,
      fetchFn: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(Response.json([snapshot()]));
      },
    },
  );

  assertEquals(projection.openCount, 1);
  assertEquals(projection.blockingCount, 1);
  assertEquals(projection.items.length, 1);
  assertEquals(projection.items[0]?.item.scope, { kind: "account" });
  assertEquals(projection.items[0]?.item.affectedAgents.length, 2);
  assertEquals(projection.agentCounts.map((count) => count.openCount), [1, 1]);
  assertEquals(
    request?.url,
    "https://supabase.test/rest/v1/rpc/get_operator_attention_page",
  );
  assertEquals(
    request?.headers.get("authorization"),
    "Bearer service-role-test",
  );
  assertEquals(request?.headers.get("cache-control"), "no-store");
  const body = JSON.parse(await request!.text());
  assertEquals(body, {
    p_user_id: USER_ID,
    p_agent_id: null,
    p_now: "2026-07-24T19:00:00.000Z",
    p_limit: 25,
    p_after_source_key: null,
    p_after_source_ordinal: null,
    p_after_detected_at: null,
    p_after_id: null,
  });
});

Deno.test("operator item reader round-trips an opaque producer-order cursor", async () => {
  const first = await readOperatorAttentionPage(
    USER_ID,
    [AGENT_A, AGENT_B],
    null,
    {},
    {
      ...dependencies,
      fetchFn: () =>
        Promise.resolve(Response.json([snapshot({
          next_source_key: "setup.account",
          next_source_ordinal: 0,
          next_detected_at: DETECTED_AT,
          next_id: ITEM_ID,
        })])),
    },
  );
  assertEquals(isOperatorAttentionCursor(first.nextCursor), true);

  let body: Record<string, unknown> | null = null;
  await readOperatorAttentionPage(
    USER_ID,
    [AGENT_A, AGENT_B],
    null,
    { cursor: first.nextCursor },
    {
      ...dependencies,
      fetchFn: (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Promise.resolve(Response.json([snapshot()]));
      },
    },
  );
  assertEquals(body?.p_after_source_key, "setup.account");
  assertEquals(body?.p_after_source_ordinal, 0);
  assertEquals(body?.p_after_detected_at, DETECTED_AT);
  assertEquals(body?.p_after_id, ITEM_ID);
});

Deno.test("operator item reader scopes Agent pages at the database boundary", async () => {
  let body: Record<string, unknown> | null = null;
  const projection = await readOperatorAttentionPage(
    USER_ID,
    [AGENT_A],
    AGENT_A.id,
    {},
    {
      ...dependencies,
      fetchFn: (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Promise.resolve(Response.json([snapshot({
          per_agent_counts: [{
            agent_id: AGENT_A.id,
            open_count: 1,
            requires_decision_count: 0,
            blocking_count: 1,
          }],
        })]));
      },
    },
  );
  assertEquals(body?.p_agent_id, AGENT_A.id);
  assertEquals(projection.agentCounts.map((count) => count.agent.id), [
    AGENT_A.id,
  ]);
});

Deno.test("operator item reader rejects malformed cursors before database access", async () => {
  let fetched = false;
  const error = await assertRejects(
    () =>
      readOperatorAttentionPage(
        USER_ID,
        [AGENT_A],
        AGENT_A.id,
        { cursor: "attention-v1.not-canonical" },
        {
          ...dependencies,
          fetchFn: () => {
            fetched = true;
            return Promise.resolve(Response.json([snapshot()]));
          },
        },
      ),
    OperatorItemReadError,
  );
  assertEquals(error.code, "INVALID_REQUEST");
  assertEquals(error.status, 400);
  assertEquals(fetched, false);
});

Deno.test("operator item reader fails closed on secret-bearing diagnostics", async () => {
  const unsafe = entry();
  unsafe.item.diagnosis.summary =
    "Provider rejected api_key=sk-projected-secret-123456789";
  const error = await assertRejects(
    () =>
      readOperatorAttentionPage(
        USER_ID,
        [AGENT_A, AGENT_B],
        null,
        {},
        {
          ...dependencies,
          fetchFn: () =>
            Promise.resolve(Response.json([snapshot({ items: [unsafe] })])),
        },
      ),
    OperatorItemReadError,
  );
  assertEquals(error.code, "INVALID_RESPONSE");
  assertStringIncludes(error.message, "secret-safe");
});

Deno.test("operator item reader rejects untrusted evidence destinations", async () => {
  const wrongPane = entry();
  wrongPane.item.diagnosis.evidence.push({
    kind: "setting",
    sourceId: "provider",
    label: "Provider settings",
    observedAt: DETECTED_AT,
    destination: {
      href: `/agents/${AGENT_A.id}/access`,
      agentId: AGENT_A.id,
      pane: "external" as never,
    },
  });
  const paneError = await assertRejects(
    () =>
      readOperatorAttentionPage(
        USER_ID,
        [AGENT_A, AGENT_B],
        null,
        {},
        {
          ...dependencies,
          fetchFn: () =>
            Promise.resolve(Response.json([snapshot({ items: [wrongPane] })])),
        },
      ),
    OperatorItemReadError,
  );
  assertStringIncludes(paneError.message, "destination pane");

  const crossAgent = entry();
  crossAgent.item.diagnosis.evidence.push({
    kind: "setting",
    sourceId: "provider",
    label: "Provider settings",
    observedAt: DETECTED_AT,
    destination: {
      href: "/agents/44444444-4444-4444-8444-444444444444/access",
      agentId: "44444444-4444-4444-8444-444444444444",
      pane: "access",
    },
  });
  const scopeError = await assertRejects(
    () =>
      readOperatorAttentionPage(
        USER_ID,
        [AGENT_A, AGENT_B],
        null,
        {},
        {
          ...dependencies,
          fetchFn: () =>
            Promise.resolve(Response.json([snapshot({ items: [crossAgent] })])),
        },
      ),
    OperatorItemReadError,
  );
  assertStringIncludes(scopeError.message, "crosses Agent scope");
});

Deno.test("operator item reader rejects arbitrary remediation fields and unknown Agent aggregates", async () => {
  const unsafe = entry();
  (unsafe.item.remediations[0]!.target as unknown as Record<string, unknown>)
    .url = "https://attacker.example";
  await assertRejects(
    () =>
      readOperatorAttentionPage(
        USER_ID,
        [AGENT_A, AGENT_B],
        null,
        {},
        {
          ...dependencies,
          fetchFn: () =>
            Promise.resolve(Response.json([snapshot({ items: [unsafe] })])),
        },
      ),
    OperatorItemReadError,
  );

  const error = await assertRejects(
    () =>
      readOperatorAttentionPage(
        USER_ID,
        [AGENT_A],
        AGENT_A.id,
        {},
        {
          ...dependencies,
          fetchFn: () =>
            Promise.resolve(Response.json([snapshot({
              per_agent_counts: [{
                agent_id: AGENT_B.id,
                open_count: 1,
                requires_decision_count: 0,
                blocking_count: 1,
              }],
            })])),
        },
      ),
    OperatorItemReadError,
  );
  assertEquals(error.code, "INVALID_RESPONSE");
  assertStringIncludes(error.message, "owner-scoped");
});
