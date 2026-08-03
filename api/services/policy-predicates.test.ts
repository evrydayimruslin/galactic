// Pillar P4: the compiled-predicate layer's contract — the validation
// floor rejects with precise errors, the readback is a deterministic code
// template, evaluation is first-match with honest missing-path semantics,
// the version insert is CAS-by-primary-key, and the compiler is BYOK with
// clarification-fails-the-save.

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import type {
  LaunchPolicyArtifact,
} from "../../shared/contracts/launch.ts";
import type { DeclaredFunctionFacts } from "./policy-gate.ts";
import { PolicyConflictError } from "./policy-gate.ts";
import {
  compilePolicyText,
  evaluatePolicyRules,
  insertPolicySet,
  PolicyCompileError,
  renderPolicyReadback,
  validatePolicyArtifact,
} from "./policy-predicates.ts";

const FACTS: DeclaredFunctionFacts[] = [
  {
    name: "issue_refund",
    description: "Refunds a customer",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        currency: { type: "string" },
        customer: {
          type: "object",
          properties: { tier: { type: "string" } },
        },
      },
    },
    annotations: { openWorldHint: true },
  },
  {
    name: "send_reply",
    description: "Replies to a conversation",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, body: { type: "string" } },
    },
  },
];

function artifact(
  rules: LaunchPolicyArtifact["rules"],
): LaunchPolicyArtifact {
  return { version: 1, rules };
}

const HOLD_OVER_50 = {
  id: "r1",
  functionName: "issue_refund",
  effect: "hold" as const,
  when: [{ path: "amount", op: "gt" as const, value: 50 }],
};

Deno.test("validator: accepts a well-formed artifact including nested paths", () => {
  const result = validatePolicyArtifact(
    artifact([
      HOLD_OVER_50,
      {
        id: "r2",
        functionName: "issue_refund",
        effect: "deny",
        when: [
          { path: "customer.tier", op: "eq", value: "free" },
          { path: "amount", op: "gte", value: 100 },
        ],
      },
    ]),
    FACTS,
  );
  assertEquals(result, { ok: true });
});

Deno.test("validator: precise errors for unknown function, path, op, and type misuse", () => {
  const result = validatePolicyArtifact(
    artifact([
      { id: "r1", functionName: "refnds", effect: "hold", when: [
        { path: "amount", op: "gt", value: 50 },
      ] },
      { id: "r2", functionName: "issue_refund", effect: "hold", when: [
        { path: "amonut", op: "gt", value: 50 },
      ] },
      { id: "r3", functionName: "issue_refund", effect: "hold", when: [
        { path: "currency", op: "gt", value: 50 },
      ] },
      { id: "r4", functionName: "issue_refund", effect: "hold", when: [
        { path: "amount", op: "near" as never, value: 50 },
      ] },
      { id: "bad id", functionName: "issue_refund", effect: "allow" as never, when: [
        { path: "amount", op: "exists", value: 1 },
      ] },
    ]),
    FACTS,
  );
  assert(!result.ok);
  const text = result.errors.join("\n");
  assert(text.includes("'refnds' is not declared"));
  assert(text.includes("'amonut' is not declared"));
  assert(text.includes("declared string, not a number"));
  assert(text.includes("unknown op 'near'"));
  assert(text.includes("id must match"));
  assert(text.includes("never allow (I1)"));
  assert(text.includes("exists takes no value"));
});

Deno.test("readback: deterministic code templates, one line per rule", () => {
  const lines = renderPolicyReadback(artifact([
    HOLD_OVER_50,
    {
      id: "r2",
      functionName: "send_reply",
      effect: "deny",
      when: [{ path: "to", op: "contains", value: "@competitor.com" }],
    },
  ]));
  assertEquals(lines, [
    "r1: Hold every `issue_refund` call whose `amount` is greater than 50 — " +
    "you approve each one in Approvals before it runs.",
    'r2: Never run `send_reply` whose `to` contains "@competitor.com" — ' +
    "each attempt is recorded as a deliberate non-action.",
  ]);
  assertEquals(renderPolicyReadback(artifact([])), [
    "No compiled rules — the Capabilities switches and the release ceiling still apply.",
  ]);
});

Deno.test("evaluator: first match wins; AND semantics; scoped by function", () => {
  const rules = artifact([
    {
      id: "r1",
      functionName: "issue_refund",
      effect: "deny",
      when: [
        { path: "amount", op: "gt", value: 500 },
      ],
    },
    { ...HOLD_OVER_50, id: "r2" },
  ]);
  assertEquals(
    evaluatePolicyRules(rules, "issue_refund", { amount: 600 })?.rule.id,
    "r1",
  );
  assertEquals(
    evaluatePolicyRules(rules, "issue_refund", { amount: 80 })?.rule.id,
    "r2",
  );
  assertEquals(evaluatePolicyRules(rules, "issue_refund", { amount: 20 }), null);
  assertEquals(evaluatePolicyRules(rules, "send_reply", { amount: 900 }), null);
});

Deno.test("evaluator: missing paths are false for comparisons, explicit via exists/absent", () => {
  const compare = artifact([HOLD_OVER_50]);
  // A call without `amount` is not "over 50" — no surprise holds on
  // optional args; presence semantics use exists/absent.
  assertEquals(evaluatePolicyRules(compare, "issue_refund", {}), null);
  const absent = artifact([{
    id: "r1",
    functionName: "issue_refund",
    effect: "hold",
    when: [{ path: "currency", op: "absent" }],
  }]);
  assertEquals(
    evaluatePolicyRules(absent, "issue_refund", {})?.rule.id,
    "r1",
  );
  assertEquals(
    evaluatePolicyRules(absent, "issue_refund", { currency: "EUR" }),
    null,
  );
  // Type mismatch never matches numeric ops.
  assertEquals(
    evaluatePolicyRules(compare, "issue_refund", { amount: "600" }),
    null,
  );
});

function withFetchStub(
  handler: (url: URL, init: RequestInit) => Response,
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
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    return Promise.resolve(handler(url, init ?? {}));
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
    globalThis.__env = previousEnv;
  });
}

Deno.test("insert: version = head+1; duplicate key maps to PolicyConflictError", async () => {
  let posted: Record<string, unknown> | null = null;
  await withFetchStub(
    (_url, init) => {
      posted = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify([{ ...posted, created_at: "2026-08-03T00:00:00Z" }]),
        { status: 201 },
      );
    },
    async () => {
      const saved = await insertPolicySet({
        appId: "app-1",
        userId: "user-1",
        expectedHeadVersion: 3,
        source: [{ text: "hold refunds over 50", ruleIds: ["r1"] }],
        artifact: artifact([HOLD_OVER_50]),
        compileModel: "claude-sonnet-5",
        createdBy: "user-1",
      });
      assertEquals((posted as Record<string, unknown>).version, 4);
      assertEquals(saved.version, 4);
      assertEquals(saved.readback.length, 1);
    },
  );
  await withFetchStub(
    () => new Response("duplicate key", { status: 409 }),
    async () => {
      await assertRejects(
        () =>
          insertPolicySet({
            appId: "app-1",
            userId: "user-1",
            expectedHeadVersion: 3,
            source: [],
            artifact: artifact([]),
            compileModel: "m",
            createdBy: "user-1",
          }),
        PolicyConflictError,
      );
    },
  );
});

const ROUTE_STUB = { billingMode: "byok", model: "claude-sonnet-5" } as never;

Deno.test("compiler: happy path — fenced JSON tolerated, artifact validated, model recorded", async () => {
  const result = await compilePolicyText(
    {
      userId: "user-1",
      userEmail: "o@example.com",
      text: "Never issue refunds over 50 without asking me",
      facts: FACTS,
    },
    {
      resolveRoute: () => Promise.resolve(ROUTE_STUB),
      fetchCompletion: (_route, body) => {
        const request = body as { messages: Array<{ content: string }> };
        assert(request.messages[1].content.includes("amount (number)"));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: "anthropic/claude-sonnet-5",
              choices: [{
                message: {
                  content: '```json\n{"rules": [{"id": "r1", ' +
                    '"functionName": "issue_refund", "effect": "hold", ' +
                    '"when": [{"path": "amount", "op": "gt", "value": 50}], ' +
                    '"note": "refunds over 50 ask first"}]}\n```',
                },
              }],
            }),
            { status: 200 },
          ),
        );
      },
    },
  );
  assertEquals(result.artifact.rules[0].id, "r1");
  assertEquals(result.compileModel, "anthropic/claude-sonnet-5");
  assertEquals(result.source, [{
    text: "Never issue refunds over 50 without asking me",
    ruleIds: ["r1"],
  }]);
});

Deno.test("compiler: clarification, invalid output, and missing BYOK all fail the save", async () => {
  const clarify = await assertRejects(
    () =>
      compilePolicyText(
        { userId: "u", userEmail: "e", text: "be careful", facts: FACTS },
        {
          resolveRoute: () => Promise.resolve(ROUTE_STUB),
          fetchCompletion: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  choices: [{
                    message: {
                      content:
                        '{"clarificationNeeded": "Which function should be careful, and about what threshold?"}',
                    },
                  }],
                }),
                { status: 200 },
              ),
            ),
        },
      ),
    PolicyCompileError,
  );
  assertEquals((clarify as PolicyCompileError).kind, "clarification");

  const invalid = await assertRejects(
    () =>
      compilePolicyText(
        { userId: "u", userEmail: "e", text: "hold refnds", facts: FACTS },
        {
          resolveRoute: () => Promise.resolve(ROUTE_STUB),
          fetchCompletion: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  choices: [{
                    message: {
                      content: '{"rules": [{"id": "r1", "functionName": ' +
                        '"refnds", "effect": "hold", "when": [{"path": "x", ' +
                        '"op": "gt", "value": 1}]}]}',
                    },
                  }],
                }),
                { status: 200 },
              ),
            ),
        },
      ),
    PolicyCompileError,
  );
  assertEquals((invalid as PolicyCompileError).kind, "invalid");
  assert(
    (invalid as PolicyCompileError).errors.join("").includes("not declared"),
  );

  const { InferenceRouteError } = await import("./inference-route.ts");
  const noByok = await assertRejects(
    () =>
      compilePolicyText(
        { userId: "u", userEmail: "e", text: "x", facts: FACTS },
        {
          resolveRoute: () =>
            Promise.reject(
              new InferenceRouteError("byok_provider_not_configured", "no", 409),
            ),
          fetchCompletion: () => Promise.reject(new Error("unreachable")),
        },
      ),
    PolicyCompileError,
  );
  assertEquals((noByok as PolicyCompileError).kind, "no_byok");
});
