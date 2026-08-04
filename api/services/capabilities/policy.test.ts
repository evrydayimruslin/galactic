import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { CapabilityError } from "../../../shared/contracts/capabilities.ts";
import type { PolicyDraftRow } from "../agent-policy-drafts.ts";
import {
  POLICY_STARTER_GUARDED_GROUPS,
  POLICY_STARTER_TEMPLATE,
  policyCapability,
} from "./policy.ts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const APP = { id: "00000000-0000-4000-8000-00000000000a", owner_id: OWNER };

function projection(overrides: Record<string, unknown>) {
  return {
    agentId: APP.id,
    functionName: "fn",
    consequence: "read",
    policy: "free",
    revision: "rev-1",
    declaredReleaseId: "",
    declaredReleaseVersion: "",
    declarationHash: "hash-1",
    updatedAt: "2026-08-03T21:00:00.000Z",
    updatedBy: { kind: "system", source: "release_default" },
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
}

function draftRow(overrides: Partial<PolicyDraftRow> = {}): PolicyDraftRow {
  return {
    id: "draft-1",
    appId: APP.id,
    userId: OWNER,
    sentence: "sending anything to a human",
    template: null,
    params: {},
    attribution: {},
    status: "proposed",
    createdAt: "2026-08-03T21:00:00.000Z",
    updatedAt: "2026-08-03T21:00:00.000Z",
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    resolveApp: (userId: string, locator: string) => {
      if (userId !== OWNER || locator !== APP.id) {
        throw new CapabilityError("forbidden", "You do not own this Agent.");
      }
      return Promise.resolve(APP);
    },
    declaredFunctions: () => [
      { name: "send_email", annotations: { openWorldHint: true } },
      { name: "charge_card", priced: true },
      { name: "list_invoices", annotations: { readOnlyHint: true } },
      { name: "record_note" },
    ],
    // deno-lint-ignore no-explicit-any
    ...(overrides as any),
  };
}

const ownerCtx = { userId: OWNER, provisional: false, authSource: "supabase" };
const handoffCtx = {
  userId: OWNER,
  provisional: true,
  authSource: "builder_handoff",
};

Deno.test("gx.policy guards its templates and its verbs", () => {
  assertEquals(POLICY_STARTER_TEMPLATE, "ask-before-consequential-v1");
  assertEquals([...POLICY_STARTER_GUARDED_GROUPS], [
    "spend",
    "external_side_effect",
  ]);
});

Deno.test("read merges overlay projections with drafts and states the owner-only line", async () => {
  const result = await policyCapability(
    { action: "read", agent_id: APP.id },
    // deno-lint-ignore no-explicit-any
    ownerCtx as any,
    deps({
      projections: () =>
        Promise.resolve([
          projection({ functionName: "send_email", consequence: "external_side_effect" }),
        ]),
      listDrafts: () => Promise.resolve([draftRow()]),
    }),
  );
  // deno-lint-ignore no-explicit-any
  const policies = (result as any).policies;
  assertEquals(policies.length, 1);
  assertEquals(policies[0].functionName, "send_email");
  // deno-lint-ignore no-explicit-any
  assertEquals((result as any).drafts[0].id, "draft-1");
  assert(String((result as any).note).includes("owner-only"));
});

Deno.test("attach_template asks the guarded groups, skips the rest, and records the draft", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const drafts: Array<Record<string, unknown>> = [];
  const result = await policyCapability(
    {
      action: "attach_template",
      agent_id: APP.id,
      seed: "sending anything to a human",
    },
    // deno-lint-ignore no-explicit-any
    handoffCtx as any,
    deps({
      projections: () =>
        Promise.resolve([
          projection({
            functionName: "send_email",
            consequence: "external_side_effect",
          }),
          projection({
            functionName: "charge_card",
            consequence: "spend",
            policy: "free",
            revision: "rev-cc",
            updatedBy: { kind: "user", userId: OWNER },
          }),
          projection({ functionName: "list_invoices", consequence: "read" }),
          projection({
            functionName: "record_note",
            consequence: "internal_write",
          }),
          projection({
            functionName: "already_held",
            consequence: "external_side_effect",
            policy: "ask",
          }),
        ]),
      setPolicy: (input: Record<string, unknown>) => {
        writes.push(input);
        return Promise.resolve({} as never);
      },
      createDraft: (input: Record<string, unknown>) => {
        drafts.push(input);
        return Promise.resolve(draftRow({ id: "draft-t" }));
      },
    }),
  );

  assertEquals(writes.length, 2);
  const byName = new Map(writes.map((w) => [w.functionName, w]));
  // Default rows create (expectedRevision null); stored rows CAS on revision.
  assertEquals(byName.get("send_email")?.expectedRevision, null);
  assertEquals(byName.get("charge_card")?.expectedRevision, "rev-cc");
  for (const write of writes) {
    assertEquals(write.policy, "ask");
    // deno-lint-ignore no-explicit-any
    assertEquals((write.actor as any).via, "gx.policy");
    // deno-lint-ignore no-explicit-any
    assertEquals((write.actor as any).kind, "agent");
  }

  // deno-lint-ignore no-explicit-any
  const out = result as any;
  assertEquals(out.written.length, 2);
  assert(
    out.skipped.some((s: { functionName: string }) =>
      s.functionName === "list_invoices"
    ),
  );
  assert(
    out.skipped.some((s: { functionName: string }) =>
      s.functionName === "already_held"
    ),
  );
  assertEquals(out.draftId, "draft-t");
  // deno-lint-ignore no-explicit-any
  assertEquals((drafts[0].params as any).seed, "sending anything to a human");
});

Deno.test("attach_template refuses an undeclared Agent and unknown templates", async () => {
  await assertRejects(
    () =>
      policyCapability(
        { action: "attach_template", agent_id: APP.id },
        // deno-lint-ignore no-explicit-any
        ownerCtx as any,
        deps({ declaredFunctions: () => [] }),
      ),
    CapabilityError,
    "declares no functions",
  );
  await assertRejects(
    () =>
      policyCapability(
        { action: "attach_template", agent_id: APP.id, template: "nope" },
        // deno-lint-ignore no-explicit-any
        ownerCtx as any,
        deps(),
      ),
    CapabilityError,
    "Unknown template",
  );
});

Deno.test("propose stores an uncompiled agent-attributed draft; nothing compiles", async () => {
  const drafts: Array<Record<string, unknown>> = [];
  const result = await policyCapability(
    { action: "propose", agent_id: APP.id, sentence: "refunding over €50" },
    // deno-lint-ignore no-explicit-any
    handoffCtx as any,
    deps({
      createDraft: (input: Record<string, unknown>) => {
        drafts.push(input);
        return Promise.resolve(draftRow({ id: "draft-p" }));
      },
    }),
  );
  // deno-lint-ignore no-explicit-any
  assertEquals((result as any).draftId, "draft-p");
  assertEquals(drafts[0].template, null);
  // deno-lint-ignore no-explicit-any
  assertEquals((drafts[0].attribution as any).kind, "agent");
  // deno-lint-ignore no-explicit-any
  assert(String((result as any).note).includes("owner's readback"));
});

Deno.test("ownership and auth planes hold: foreign agents and odd sources refuse", async () => {
  await assertRejects(
    () =>
      policyCapability(
        { action: "read", agent_id: "someone-elses-agent" },
        // deno-lint-ignore no-explicit-any
        ownerCtx as any,
        deps(),
      ),
    CapabilityError,
    "do not own",
  );
  await assertRejects(
    () =>
      policyCapability(
        { action: "read", agent_id: APP.id },
        // deno-lint-ignore no-explicit-any
        { userId: OWNER, provisional: false, authSource: "page_share" } as any,
        deps(),
      ),
    CapabilityError,
    "owner or its build session",
  );
});
