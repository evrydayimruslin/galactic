import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { FunnelSessionError } from "./funnel-sessions.ts";
import {
  FUNNEL_TRIAL_RUN_LIMIT,
  FUNNEL_TRIAL_TRIGGER,
  runFunnelTrialByPairing,
} from "./funnel-trial.ts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const APP_ID = "00000000-0000-4000-8000-00000000000a";
const CODE = "abcdefghjkmnpqrs2345";

interface StubState {
  funnelRows: Record<string, unknown>[];
  sessionRows: Record<string, unknown>[];
  appRows: Record<string, unknown>[];
  approvalRows: Record<string, unknown>[];
  draftRows: Record<string, unknown>[];
}

function state(overrides: Partial<StubState> = {}): StubState {
  return {
    funnelRows: [{
      provisional_owner_id: OWNER,
      handoff_session_id: "session-1",
      claimed_at: null,
      expires_at: "2099-01-01T00:00:00.000Z",
    }],
    sessionRows: [{ uploaded_app_id: APP_ID, uploaded_version: "1.0.0" }],
    appRows: [{
      id: APP_ID,
      owner_id: OWNER,
      manifest: {
        functions: {
          send_email: { annotations: { openWorldHint: true } },
          list_invoices: { annotations: { readOnlyHint: true } },
        },
      },
    }],
    approvalRows: [],
    draftRows: [],
    ...overrides,
  };
}

function options(s: StubState) {
  return {
    supabaseUrl: "https://supabase.example.test",
    serviceRoleKey: "service-role-test-key",
    fetchFn: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rest/v1/funnel_sessions?")) {
        return Response.json(s.funnelRows);
      }
      if (url.includes("/rest/v1/builder_handoff_sessions?")) {
        return Response.json(s.sessionRows);
      }
      if (url.includes("/rest/v1/apps?")) return Response.json(s.appRows);
      if (url.includes("/rest/v1/agent_approvals?")) {
        return Response.json(s.approvalRows);
      }
      if (url.includes("/rest/v1/agent_policy_drafts?")) {
        return Response.json(s.draftRows);
      }
      throw new Error(`Unexpected trial-test request: ${url}`);
    }) as typeof fetch,
  };
}

function deps(collect: {
  jobs: Array<Record<string, unknown>>;
  envelopes: Array<Record<string, unknown>>;
}, projections: Array<Record<string, unknown>>) {
  return {
    // deno-lint-ignore no-explicit-any
    projections: () => Promise.resolve(projections as any),
    createJob: (params: Record<string, unknown>) => {
      collect.jobs.push(params);
      return Promise.resolve("job-1");
    },
    createEnvelope: (input: Record<string, unknown>) => {
      collect.envelopes.push(input);
      return Promise.resolve({
        id: "env-1",
        created_at: "2026-08-03T23:00:00.000Z",
        expires_at: "2026-08-10T23:00:00.000Z",
        // deno-lint-ignore no-explicit-any
      } as any);
    },
    randomUUID: () => "00000000-0000-4000-8000-0000000000ee",
  };
}

function askProjection(overrides: Record<string, unknown> = {}) {
  return {
    functionName: "send_email",
    consequence: "external_side_effect",
    policy: "ask",
    revision: "rev-ask",
    declarationHash: "hash-1",
    ...overrides,
  };
}

Deno.test("run files a held-from-birth job and a real envelope; nothing executes", async () => {
  const collect = { jobs: [], envelopes: [] } as {
    jobs: Array<Record<string, unknown>>;
    envelopes: Array<Record<string, unknown>>;
  };
  const card = await runFunnelTrialByPairing(
    CODE,
    options(state()),
    deps(collect, [askProjection()]),
  );

  assertEquals(collect.jobs.length, 1);
  const job = collect.jobs[0];
  assertEquals(job.heldForApproval, true);
  assertEquals(job.trigger, FUNNEL_TRIAL_TRIGGER);
  assertEquals(job.functionName, "send_email");
  assertEquals(job.userId, OWNER);
  assertEquals((job.meta as Record<string, unknown>).funnel_trial, true);

  assertEquals(collect.envelopes.length, 1);
  const envelope = collect.envelopes[0];
  assertEquals(envelope.jobId, "job-1");
  assertEquals(envelope.policyRevision, "rev-ask");
  assertEquals(envelope.releaseVersion, "1.0.0");
  assertEquals(envelope.consequence, "external_side_effect");

  assertEquals(card.envelopeId, "env-1");
  assertEquals(card.status, "pending");
});

Deno.test("run refuses without an ask posture, an upload, or under the ceiling", async () => {
  const noAsk = await assertRejects(
    () =>
      runFunnelTrialByPairing(
        CODE,
        options(state()),
        deps({ jobs: [], envelopes: [] }, [
          askProjection({ policy: "free" }),
        ]),
      ),
    FunnelSessionError,
  );
  assert(String(noAsk.message).includes("attach the starter policy"));

  const noUpload = await assertRejects(
    () =>
      runFunnelTrialByPairing(
        CODE,
        options(state({
          sessionRows: [{ uploaded_app_id: null, uploaded_version: null }],
        })),
        deps({ jobs: [], envelopes: [] }, [askProjection()]),
      ),
    FunnelSessionError,
  );
  assert(String(noUpload.message).includes("finish the build"));

  const atCeiling = await assertRejects(
    () =>
      runFunnelTrialByPairing(
        CODE,
        options(state({
          approvalRows: Array.from(
            { length: FUNNEL_TRIAL_RUN_LIMIT },
            (_, index) => ({
              id: `env-${index}`,
              function_name: "send_email",
              consequence: "external_side_effect",
              status: "pending",
              created_at: "2026-08-03T22:00:00.000Z",
              expires_at: null,
            }),
          ),
        })),
        deps({ jobs: [], envelopes: [] }, [askProjection()]),
      ),
    FunnelSessionError,
  );
  assert(String(atCeiling.message).includes("ceiling"));
});

Deno.test("run refuses claimed and unknown pairings", async () => {
  const claimed = await assertRejects(
    () =>
      runFunnelTrialByPairing(
        CODE,
        options(state({
          funnelRows: [{
            provisional_owner_id: OWNER,
            handoff_session_id: "session-1",
            claimed_at: "2026-08-03T22:00:00.000Z",
            expires_at: "2099-01-01T00:00:00.000Z",
          }],
        })),
        deps({ jobs: [], envelopes: [] }, [askProjection()]),
      ),
    FunnelSessionError,
  );
  assertEquals((claimed as FunnelSessionError).code, "already_claimed");

  const unknown = await assertRejects(
    () =>
      runFunnelTrialByPairing(
        CODE,
        options(state({ funnelRows: [] })),
        deps({ jobs: [], envelopes: [] }, [askProjection()]),
      ),
    FunnelSessionError,
  );
  assertEquals((unknown as FunnelSessionError).code, "not_found");
});
