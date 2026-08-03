// Pillar P3: the envelope store's contract — owner-safe sanitization
// (I10), lazy TTL settle, CAS resolution with idempotent replay (I5), and
// exactly-once resumption through the held->queued flip (I9).

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  type ApprovalRow,
  deriveEnvelopeStatus,
  projectEnvelope,
  resolveApproval,
  sanitizeProposal,
} from "./agent-approvals.ts";
import { PolicyConflictError } from "./policy-gate.ts";

function withFetchStub(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
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

function approvalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "appr-1",
    app_id: "app-1",
    user_id: "user-1",
    owner_id: "user-1",
    status: "pending",
    revision: "rev-1",
    job_id: "job-1",
    release_id: "rel-1",
    release_version: "1.2.0",
    function_name: "send_reply",
    consequence: "external_side_effect",
    input_hash: "hash-1",
    trigger: "schedule",
    run_id: "exec-1",
    routine_id: "routine-1",
    routine_run_id: "run-1",
    trace_id: null,
    policy_revision: "prev-1",
    source: { kind: "routine_wake" },
    proposal: { argKeys: ["to"], preview: { to: "a@b.c" }, lossless: true },
    resolved_by: null,
    created_at: "2026-08-03T00:00:00.000Z",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    resolved_at: null,
    ...overrides,
  };
}

const NOOP_DEPS = {
  reviseHeldJobArgs: () => Promise.resolve(true),
  resumeHeldJob: () => Promise.resolve(true),
  denyHeldJob: () => Promise.resolve(true),
};

Deno.test("sanitizer: redacts secret keys, clips strings, bounds depth", () => {
  const { argKeys, preview, lossless } = sanitizeProposal({
    to: "customer@example.com",
    api_key: "sk-live-123",
    body: "x".repeat(500),
    nested: { deep: { deeper: { beyond: true } } },
    items: Array.from({ length: 20 }, (_, i) => i),
  });
  assertEquals(argKeys, ["to", "api_key", "body", "nested", "items"]);
  assertEquals(preview.to, "customer@example.com");
  assertEquals(preview.api_key, "•••");
  assert(String(preview.body).length < 200);
  assert(String(preview.body).endsWith("…"));
  assertEquals(lossless, false);
  const items = preview.items as unknown[];
  assertEquals(items.length, 9);
  assertEquals(items[8], "… 12 more");
});

Deno.test("sanitizer: lossless only when nothing was touched", () => {
  const clean = sanitizeProposal({ to: "a@b.c", count: 3 });
  assertEquals(clean.lossless, true);
  assertEquals(clean.preview, { to: "a@b.c", count: 3 });
});

Deno.test("projection: resuming envelopes follow the resumed job's terminal status", () => {
  const row = approvalRow({ status: "resuming" });
  assertEquals(deriveEnvelopeStatus(row, "running"), "resuming");
  assertEquals(deriveEnvelopeStatus(row, "completed"), "completed");
  assertEquals(deriveEnvelopeStatus(row, "failed"), "failed");
  assertEquals(projectEnvelope(row, "completed").status, "completed");
  assertEquals(projectEnvelope(approvalRow()).status, "pending");
});

Deno.test("resolve approve: CAS transition + held->queued resumption", async () => {
  const calls: string[] = [];
  await withFetchStub(
    (url, init) => {
      if (init.method === undefined || init.method === "GET") {
        return new Response(JSON.stringify([approvalRow()]), { status: 200 });
      }
      assertEquals(init.method, "PATCH");
      assertEquals(url.searchParams.get("status"), "eq.pending");
      assertEquals(url.searchParams.get("revision"), "eq.rev-1");
      const body = JSON.parse(String(init.body));
      assertEquals(body.status, "resuming");
      return new Response(
        JSON.stringify([approvalRow({ status: "resuming", revision: body.revision })]),
        { status: 200 },
      );
    },
    async () => {
      const resolved = await resolveApproval(
        {
          userId: "user-1",
          appId: "app-1",
          approvalId: "appr-1",
          action: "approve",
          expectedRevision: "rev-1",
          idempotencyKey: "idem-1",
        },
        {
          ...NOOP_DEPS,
          resumeHeldJob: (jobId) => {
            calls.push(`resume:${jobId}`);
            return Promise.resolve(true);
          },
        },
      );
      assertEquals(resolved.status, "resuming");
      assertEquals(calls, ["resume:job-1"]);
    },
  );
});

Deno.test("resolve reject: denies the held job and witnesses the non-action", async () => {
  const calls: string[] = [];
  await withFetchStub(
    (_url, init) => {
      if (init.method === undefined || init.method === "GET") {
        return new Response(JSON.stringify([approvalRow()]), { status: 200 });
      }
      const body = JSON.parse(String(init.body));
      assertEquals(body.status, "rejected");
      return new Response(
        JSON.stringify([approvalRow({ status: "rejected", revision: body.revision })]),
        { status: 200 },
      );
    },
    async () => {
      const resolved = await resolveApproval(
        {
          userId: "user-1",
          appId: "app-1",
          approvalId: "appr-1",
          action: "reject",
          expectedRevision: "rev-1",
          idempotencyKey: "idem-2",
        },
        {
          ...NOOP_DEPS,
          denyHeldJob: (jobId) => {
            calls.push(`deny:${jobId}`);
            return Promise.resolve(true);
          },
          recordResolutionEffect: (row, outcome) => {
            calls.push(`witness:${row.function_name}:${outcome}`);
            return Promise.resolve();
          },
        },
      );
      assertEquals(resolved.status, "rejected");
      assertEquals(calls, [
        "deny:job-1",
        "witness:send_reply:rejected by owner",
      ]);
    },
  );
});

Deno.test("resolve: stale revision and already-resolved conflict; replay returns", async () => {
  await withFetchStub(
    () => new Response(JSON.stringify([approvalRow()]), { status: 200 }),
    async () => {
      await assertRejects(
        () =>
          resolveApproval(
            {
              userId: "user-1",
              appId: "app-1",
              approvalId: "appr-1",
              action: "approve",
              expectedRevision: "rev-STALE",
              idempotencyKey: "idem-3",
            },
            NOOP_DEPS,
          ),
        PolicyConflictError,
      );
    },
  );
  await withFetchStub(
    () =>
      new Response(
        JSON.stringify([approvalRow({
          status: "rejected",
          resolved_by: { kind: "user", idempotencyKey: "idem-4" },
        })]),
        { status: 200 },
      ),
    async () => {
      // Same idempotency key -> the landed write returns as-is.
      const replay = await resolveApproval(
        {
          userId: "user-1",
          appId: "app-1",
          approvalId: "appr-1",
          action: "reject",
          expectedRevision: "rev-1",
          idempotencyKey: "idem-4",
        },
        NOOP_DEPS,
      );
      assertEquals(replay.status, "rejected");
      // A different key against a resolved row conflicts.
      await assertRejects(
        () =>
          resolveApproval(
            {
              userId: "user-1",
              appId: "app-1",
              approvalId: "appr-1",
              action: "reject",
              expectedRevision: "rev-1",
              idempotencyKey: "idem-5",
            },
            NOOP_DEPS,
          ),
        PolicyConflictError,
      );
    },
  );
});

Deno.test("resolve: expiry settles and conflicts instead of resuming", async () => {
  const patches: string[] = [];
  await withFetchStub(
    (_url, init) => {
      if (init.method === undefined || init.method === "GET") {
        return new Response(
          JSON.stringify([approvalRow({
            expires_at: new Date(Date.now() - 1000).toISOString(),
          })]),
          { status: 200 },
        );
      }
      patches.push(JSON.parse(String(init.body)).status);
      return new Response("[]", { status: 200 });
    },
    async () => {
      await assertRejects(
        () =>
          resolveApproval(
            {
              userId: "user-1",
              appId: "app-1",
              approvalId: "appr-1",
              action: "approve",
              expectedRevision: "rev-1",
              idempotencyKey: "idem-6",
            },
            NOOP_DEPS,
          ),
        PolicyConflictError,
      );
      assertEquals(patches, ["expired"]);
    },
  );
});

Deno.test("resolve revise: replaces held input before the transition", async () => {
  const order: string[] = [];
  await withFetchStub(
    (_url, init) => {
      if (init.method === undefined || init.method === "GET") {
        return new Response(JSON.stringify([approvalRow()]), { status: 200 });
      }
      order.push("transition");
      const body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify([approvalRow({ status: "resuming", revision: body.revision })]),
        { status: 200 },
      );
    },
    async () => {
      await resolveApproval(
        {
          userId: "user-1",
          appId: "app-1",
          approvalId: "appr-1",
          action: "revise",
          expectedRevision: "rev-1",
          idempotencyKey: "idem-7",
          revisedInput: { to: "corrected@example.com" },
        },
        {
          ...NOOP_DEPS,
          reviseHeldJobArgs: (jobId, args) => {
            order.push(`revise:${jobId}:${String(args.to)}`);
            return Promise.resolve(true);
          },
          resumeHeldJob: (jobId) => {
            order.push(`resume:${jobId}`);
            return Promise.resolve(true);
          },
        },
      );
      assertEquals(order, [
        "revise:job-1:corrected@example.com",
        "transition",
        "resume:job-1",
      ]);
    },
  );
});
