import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createPolicyDraft,
  listPolicyDrafts,
  PolicyDraftError,
} from "./agent-policy-drafts.ts";

function options(state: {
  requests: Array<{ method: string; url: string; body: unknown }>;
  rows?: unknown[];
  failStatus?: number;
}) {
  return {
    supabaseUrl: "https://supabase.example.test",
    serviceRoleKey: "service-role-test-key",
    now: () => new Date("2026-08-03T22:00:00.000Z"),
    randomUUID: () => "00000000-0000-4000-8000-0000000000dd",
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body)
        : undefined;
      state.requests.push({ method, url, body });
      if (state.failStatus) {
        return new Response("{}", { status: state.failStatus });
      }
      if (method === "POST") return Response.json([body]);
      return Response.json(state.rows ?? []);
    }) as typeof fetch,
  };
}

Deno.test("createPolicyDraft stores a bounded, attributed proposed draft", async () => {
  const state = { requests: [] as Array<{ method: string; url: string; body: unknown }> };
  const draft = await createPolicyDraft({
    appId: "app-1",
    userId: "user-1",
    sentence: "  refunding over €50  ",
    attribution: { kind: "agent", via: "gx.policy" },
  }, options(state));
  assertEquals(draft.sentence, "refunding over €50");
  assertEquals(draft.status, "proposed");
  assertEquals(draft.template, null);
  const body = state.requests[0].body as Record<string, unknown>;
  assertEquals(body.status, "proposed");
  assertEquals(
    (body.attribution as Record<string, unknown>).via,
    "gx.policy",
  );

  await assertRejects(
    () =>
      createPolicyDraft({
        appId: "app-1",
        userId: "user-1",
        sentence: "   ",
        attribution: {},
      }, options({ requests: [] })),
    PolicyDraftError,
    "bounded",
  );
});

Deno.test("listPolicyDrafts scopes by agent and fails closed", async () => {
  const state = {
    requests: [] as Array<{ method: string; url: string; body: unknown }>,
    rows: [{
      id: "d1",
      app_id: "app-1",
      user_id: "user-1",
      sentence: "s",
      template: "ask-before-consequential-v1",
      params: {},
      attribution: {},
      status: "proposed",
      created_at: "2026-08-03T22:00:00.000Z",
      updated_at: "2026-08-03T22:00:00.000Z",
    }],
  };
  const rows = await listPolicyDrafts("app-1", options(state));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].template, "ask-before-consequential-v1");
  assertEquals(
    state.requests[0].url.includes("app_id=eq.app-1"),
    true,
  );

  await assertRejects(
    () => listPolicyDrafts("app-1", options({ requests: [], failStatus: 500 })),
    PolicyDraftError,
    "rejected",
  );
});
