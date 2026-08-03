// Pillar P2: the autonomous gate's contract — default 'free', 'off' denies,
// 'ask' dormant-allows, CAS conflicts surface as PolicyConflictError, and
// unreadable policy stores throw (the caller fails closed).

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildFunctionPolicyProjections,
  classifyFunctionConsequence,
  computeDeclarationHash,
  declaredFunctionFactsFromApp,
  defaultPolicyRevision,
  evaluateAutonomousGate,
  PolicyConflictError,
  setFunctionPolicy,
} from "./policy-gate.ts";

function withFetchStub(
  handler: (input: URL, init: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const previousEnv = globalThis.__env;
  const original = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv || {}),
    SUPABASE_URL: "https://stub.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  } as typeof globalThis.__env;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
    globalThis.__env = previousEnv;
  });
}

function policyRow(policy: "off" | "ask" | "free", revision = "rev-1") {
  return {
    app_id: "app-1",
    user_id: "user-1",
    function_name: "send_reply",
    policy,
    declaration_hash: null,
    revision,
    set_by: { kind: "owner" },
    updated_at: "2026-08-03T00:00:00.000Z",
  };
}

Deno.test("gate defaults to allow/'free' when no policy row exists", async () => {
  await withFetchStub(
    () => new Response("[]", { status: 200 }),
    async () => {
      const verdict = await evaluateAutonomousGate({
        appId: "app-1",
        functionName: "send_reply",
      });
      assertEquals(verdict, {
        verdict: "allow",
        layer: "default",
        policy: null,
        revision: null,
      });
    },
  );
});

Deno.test("gate denies on 'off' and names the deciding layer + revision", async () => {
  await withFetchStub(
    () => new Response(JSON.stringify([policyRow("off", "rev-9")]), { status: 200 }),
    async () => {
      const verdict = await evaluateAutonomousGate({
        appId: "app-1",
        functionName: "send_reply",
      });
      assertEquals(verdict, {
        verdict: "deny",
        layer: "overlay",
        policy: "off",
        revision: "rev-9",
      });
    },
  );
});

Deno.test("'ask' holds: pending work, neither executed nor denied", async () => {
  await withFetchStub(
    () => new Response(JSON.stringify([policyRow("ask", "rev-ask")]), { status: 200 }),
    async () => {
      const verdict = await evaluateAutonomousGate({
        appId: "app-1",
        functionName: "send_reply",
      });
      assertEquals(verdict, {
        verdict: "hold",
        layer: "overlay",
        policy: "ask",
        revision: "rev-ask",
      });
    },
  );
});

Deno.test("an unreadable policy store throws — callers fail closed (I2)", async () => {
  await withFetchStub(
    () => new Response("boom", { status: 500 }),
    async () => {
      await assertRejects(() =>
        evaluateAutonomousGate({ appId: "app-1", functionName: "send_reply" })
      );
    },
  );
});

Deno.test("setFunctionPolicy CAS: a stale revision surfaces as PolicyConflictError", async () => {
  await withFetchStub(
    (url, init) => {
      assertEquals(init.method, "PATCH");
      assertEquals(url.searchParams.get("revision"), "eq.stale-rev");
      return new Response("[]", { status: 200 });
    },
    async () => {
      await assertRejects(
        () =>
          setFunctionPolicy({
            userId: "user-1",
            appId: "app-1",
            functionName: "send_reply",
            policy: "off",
            expectedRevision: "stale-rev",
            actor: { kind: "owner" },
          }),
        PolicyConflictError,
      );
    },
  );
});

Deno.test("setFunctionPolicy first write POSTs and mints a fresh revision", async () => {
  await withFetchStub(
    (url, init) => {
      assertEquals(init.method, "POST");
      assertEquals(url.pathname, "/rest/v1/agent_function_policies");
      const body = JSON.parse(String(init.body));
      assertEquals(body.policy, "ask");
      assertEquals(typeof body.revision, "string");
      return new Response(JSON.stringify([{ ...policyRow("ask"), revision: body.revision }]), {
        status: 201,
      });
    },
    async () => {
      const row = await setFunctionPolicy({
        userId: "user-1",
        appId: "app-1",
        functionName: "send_reply",
        policy: "ask",
        expectedRevision: null,
        actor: { kind: "owner", id: "user-1" },
      });
      assertEquals(row.policy, "ask");
    },
  );
});

Deno.test("duplicate first write maps the 409 to PolicyConflictError", async () => {
  await withFetchStub(
    () => new Response("duplicate key", { status: 409 }),
    async () => {
      await assertRejects(
        () =>
          setFunctionPolicy({
            userId: "user-1",
            appId: "app-1",
            functionName: "send_reply",
            policy: "off",
            expectedRevision: null,
            actor: { kind: "owner" },
          }),
        PolicyConflictError,
      );
    },
  );
});

Deno.test("consequence classification: spend > read > external > internal", () => {
  assertEquals(
    classifyFunctionConsequence({
      name: "buy",
      priced: true,
      annotations: { readOnlyHint: true },
    }),
    "spend",
  );
  assertEquals(
    classifyFunctionConsequence({
      name: "peek",
      annotations: { readOnlyHint: true, openWorldHint: true },
    }),
    "read",
  );
  assertEquals(
    classifyFunctionConsequence({
      name: "send",
      annotations: { openWorldHint: true },
    }),
    "external_side_effect",
  );
  assertEquals(
    classifyFunctionConsequence({
      name: "purge",
      annotations: { destructiveHint: true },
    }),
    "external_side_effect",
  );
  assertEquals(classifyFunctionConsequence({ name: "tally" }), "internal_write");
});

Deno.test("declaration hash: key order irrelevant, content changes reset it", async () => {
  const a = await computeDeclarationHash({
    name: "send_reply",
    description: "Replies",
    inputSchema: { type: "object", properties: { to: { type: "string" } } },
  });
  const b = await computeDeclarationHash({
    inputSchema: { properties: { to: { type: "string" } }, type: "object" },
    description: "Replies",
    name: "send_reply",
  });
  assertEquals(a, b);
  const changed = await computeDeclarationHash({
    name: "send_reply",
    description: "Replies, now with escalation",
    inputSchema: { type: "object", properties: { to: { type: "string" } } },
  });
  assert(a !== changed);
  assertEquals(defaultPolicyRevision(a), `default:${a}`);
});

Deno.test("projections: defaults merge over declared functions; rows win", async () => {
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify([{
          ...policyRow("off", "rev-set"),
          set_by: { kind: "owner", userId: "user-1" },
        }]),
        { status: 200 },
      ),
    async () => {
      const projections = await buildFunctionPolicyProjections({
        userId: "user-1",
        appId: "app-1",
        functions: [
          { name: "send_reply", annotations: { openWorldHint: true } },
          { name: "check_inbox", annotations: { readOnlyHint: true } },
        ],
        release: {
          id: "rel-1",
          version: "1.2.0",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      });
      assertEquals(projections.length, 2);
      const [set, unset] = projections;
      assertEquals(set.policy, "off");
      assertEquals(set.revision, "rev-set");
      assertEquals(set.consequence, "external_side_effect");
      assertEquals(set.updatedBy, { kind: "user", userId: "user-1" });
      assertEquals(unset.policy, "free");
      assertEquals(
        unset.revision,
        defaultPolicyRevision(unset.declarationHash),
      );
      assertEquals(unset.consequence, "read");
      assertEquals(unset.updatedBy, {
        kind: "system",
        source: "release_default",
      });
      assertEquals(unset.declaredReleaseVersion, "1.2.0");
    },
  );
});

Deno.test("declared facts: one extraction home for hashes and consequence", async () => {
  const app = {
    manifest: JSON.stringify({
      functions: {
        send_reply: {
          description: "Replies to a conversation",
          parameters: {
            to: { type: "string", description: "recipient" },
            cc: { type: "string", required: false },
          },
          annotations: { openWorldHint: true, banana: "ignored" },
        },
      },
    }),
    pricing_config: { functions: { send_reply: 0 } },
  };
  const facts = declaredFunctionFactsFromApp(app, "send_reply");
  assert(facts);
  assertEquals(facts.priced, false);
  assertEquals(facts.annotations, { openWorldHint: true });
  assertEquals(
    (facts.inputSchema as { required?: string[] }).required,
    ["to"],
  );
  assertEquals(classifyFunctionConsequence(facts), "external_side_effect");
  // Absent function -> null (callers 404 rather than hashing nothing).
  assertEquals(declaredFunctionFactsFromApp(app, "missing"), null);
  const again = declaredFunctionFactsFromApp(app, "send_reply");
  assert(again);
  assertEquals(
    await computeDeclarationHash(facts),
    await computeDeclarationHash(again),
  );
});

Deno.test("decision 4: a redeclared function's free consent downgrades to hold", async () => {
  const row = {
    ...policyRow("free", "rev-f"),
    declaration_hash: "hash-OLD",
  };
  await withFetchStub(
    () => new Response(JSON.stringify([row]), { status: 200 }),
    async () => {
      const held = await evaluateAutonomousGate({
        appId: "app-1",
        functionName: "send_reply",
        currentDeclarationHash: "hash-NEW",
      });
      assertEquals(held.verdict, "hold");
      assertEquals(held.declarationChanged, true);
      const same = await evaluateAutonomousGate({
        appId: "app-1",
        functionName: "send_reply",
        currentDeclarationHash: "hash-OLD",
      });
      assertEquals(same.verdict, "allow");
      // No hash provided (or none stored): no basis to downgrade.
      const noHash = await evaluateAutonomousGate({
        appId: "app-1",
        functionName: "send_reply",
      });
      assertEquals(noHash.verdict, "allow");
    },
  );
});

Deno.test("decision 4 x I1: 'off' never widens to ask on redeclaration", async () => {
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify([{
          ...policyRow("off", "rev-o"),
          declaration_hash: "hash-OLD",
        }]),
        { status: 200 },
      ),
    async () => {
      const verdict = await evaluateAutonomousGate({
        appId: "app-1",
        functionName: "send_reply",
        currentDeclarationHash: "hash-NEW",
      });
      assertEquals(verdict.verdict, "deny");
      assertEquals(verdict.declarationChanged, undefined);
    },
  );
});
