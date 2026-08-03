// Pillar P6: attribution counts come from the envelope ledger (no second
// bookkeeping), and dry-run replays recorded invocations through the SAME
// evaluator as production — deterministic rows exact, semantic rows
// honestly marked as scope, not verdicts.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import type { LaunchPolicyArtifact } from "../../shared/contracts/launch.ts";
import {
  aggregatePolicyAttribution,
  dryRunArtifacts,
} from "./policy-attribution.ts";

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

function envelopeRow(
  ruleId: string | null,
  status: string,
  policyVersion = 4,
) {
  return {
    status,
    created_at: "2026-08-03T00:00:00.000Z",
    source: ruleId
      ? {
        heldBy: {
          ruleId,
          policyVersion,
          readback: `${ruleId}: Hold …`,
        },
      }
      : { kind: "routine_wake" },
  };
}

Deno.test("attribution: counts per rule + version from envelopes; overlay holds excluded", async () => {
  await withFetchStub(
    (url) => {
      assert(url.pathname.endsWith("/agent_approvals"));
      assert(url.searchParams.get("created_at")?.startsWith("gte."));
      return new Response(
        JSON.stringify([
          envelopeRow("r1", "pending"),
          envelopeRow("r1", "rejected"),
          envelopeRow("r1", "resuming"),
          envelopeRow("r2", "pending", 5),
          envelopeRow(null, "pending"),
        ]),
        { status: 200 },
      );
    },
    async () => {
      const { rules, versions } = await aggregatePolicyAttribution(
        "user-1",
        "app-1",
      );
      assertEquals(rules, [
        {
          ruleId: "r1",
          policyVersion: 4,
          readback: "r1: Hold …",
          heldLast7d: 3,
          pendingNow: 1,
        },
        {
          ruleId: "r2",
          policyVersion: 5,
          readback: "r2: Hold …",
          heldLast7d: 1,
          pendingNow: 1,
        },
      ]);
      assertEquals(versions, [
        { policyVersion: 5, held: 1 },
        { policyVersion: 4, held: 3 },
      ]);
    },
  );
});

const PROPOSED: LaunchPolicyArtifact = {
  version: 1,
  rules: [
    {
      id: "r1",
      functionName: "issue_refund",
      effect: "hold",
      when: [{ path: "amount", op: "gt", value: 20 }],
    },
    {
      id: "r2",
      kind: "semantic",
      functionName: "send_reply",
      effect: "hold",
      criterion: "mentions a lawyer",
    },
  ],
  judge: { modelId: "m", promptVersion: 1 },
};

const HEAD: LaunchPolicyArtifact = {
  version: 1,
  rules: [
    {
      id: "r1",
      functionName: "issue_refund",
      effect: "hold",
      when: [{ path: "amount", op: "gt", value: 50 }],
    },
  ],
};

function invocation(
  id: string,
  functionName: string,
  args: Record<string, unknown>,
) {
  return {
    id,
    function_name: functionName,
    args,
    created_at: "2026-08-02T00:00:00.000Z",
  };
}

Deno.test("dry-run: tightening 50→20 surfaces exactly the newly-held rows", () => {
  const result = dryRunArtifacts(
    [
      invocation("j1", "issue_refund", { amount: 30 }), // 20<30<50: newly held
      invocation("j2", "issue_refund", { amount: 80 }), // held under both
      invocation("j3", "issue_refund", { amount: 10 }), // allowed under both
      invocation("j4", "send_reply", { body: "hello" }), // semantic scope
      invocation("j5", "check_inbox", {}), // untouched by any rule
    ],
    PROPOSED,
    HEAD,
  );
  assertEquals(result.replayed, 5);
  assertEquals(result.summary.newlyHeld, 1);
  assertEquals(result.summary.newlyDenied, 0);
  assertEquals(result.summary.wouldConsultJudge, 1);
  assertEquals(result.changed.map((row) => row.jobId), ["j1", "j4"]);
  assertEquals(result.changed[0].proposed, "hold");
  assertEquals(result.changed[0].current, "allow");
  // Semantic scope is marked, never guessed as a verdict.
  assertEquals(result.changed[1].proposed, "would_judge");
});

Deno.test("dry-run: loosening surfaces newly-allowed rows against the head", () => {
  const loosened: LaunchPolicyArtifact = {
    version: 1,
    rules: [{
      id: "r1",
      functionName: "issue_refund",
      effect: "hold",
      when: [{ path: "amount", op: "gt", value: 500 }],
    }],
  };
  const result = dryRunArtifacts(
    [invocation("j1", "issue_refund", { amount: 80 })],
    loosened,
    HEAD,
  );
  assertEquals(result.summary.newlyAllowed, 1);
  assertEquals(result.changed[0].current, "hold");
  assertEquals(result.changed[0].proposed, "allow");
  // No head at all: everything current = allow.
  const fresh = dryRunArtifacts(
    [invocation("j1", "issue_refund", { amount: 80 })],
    HEAD,
    null,
  );
  assertEquals(fresh.summary.newlyHeld, 1);
});
