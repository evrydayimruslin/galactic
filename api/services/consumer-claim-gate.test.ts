// Pillar P3.5: the claim-point gate — one evaluator for every autonomous
// path. User-plane and already-approved work passes untouched; Off denies
// with a witnessed non-action before tenant code runs; ask (and decision
// 4's declaration drift) parks the claimed row and files the envelope; a
// 'resuming' envelope is the owner's authorization and proceeds.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import type { AsyncJob } from "./async-jobs.ts";
import { gateClaimedAutonomousJob } from "./consumer-claim-gate.ts";

interface Route {
  match: (url: URL, init: RequestInit) => boolean;
  respond: (url: URL, init: RequestInit) => Response;
}

function withRoutes(
  routes: Route[],
  run: () => Promise<void>,
): Promise<{ log: string[] }> {
  const previousEnv = globalThis.__env;
  const original = globalThis.fetch;
  const log: string[] = [];
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
    const request = init ?? {};
    log.push(`${request.method ?? "GET"} ${url.pathname}`);
    const route = routes.find((r) => r.match(url, request));
    if (!route) {
      throw new Error(`Unstubbed fetch: ${request.method} ${url.href}`);
    }
    return Promise.resolve(route.respond(url, request));
  }) as typeof fetch;
  return run().then(() => ({ log })).finally(() => {
    globalThis.fetch = original;
    globalThis.__env = previousEnv;
  });
}

function job(overrides: Partial<AsyncJob> = {}): AsyncJob {
  return {
    id: "job-1",
    app_id: "app-1",
    user_id: "user-1",
    owner_id: "owner-1",
    function_name: "send_reply",
    status: "running",
    args: { to: "a@b.c" },
    execution_id: "exec-1",
    trigger: "schedule",
    meta: {},
    ...overrides,
  } as unknown as AsyncJob;
}

function policyRoute(rows: unknown[]): Route {
  return {
    match: (url) => url.pathname.endsWith("/agent_function_policies"),
    respond: () => new Response(JSON.stringify(rows), { status: 200 }),
  };
}

const APP_ROUTE: Route = {
  match: (url) => url.pathname.endsWith("/apps"),
  respond: () =>
    new Response(
      JSON.stringify([{
        owner_id: "owner-1",
        pricing_config: null,
        manifest: JSON.stringify({
          functions: {
            send_reply: {
              description: "Replies",
              parameters: { to: { type: "string" } },
              annotations: { openWorldHint: true },
            },
          },
        }),
      }]),
      { status: 200 },
    ),
};

function envelopeLookupRoute(rows: unknown[]): Route {
  return {
    match: (url, init) =>
      url.pathname.endsWith("/agent_approvals") &&
      (init.method === undefined || init.method === "GET"),
    respond: () => new Response(JSON.stringify(rows), { status: 200 }),
  };
}

Deno.test("user-plane and already-approved jobs pass without any reads", async () => {
  const { log } = await withRoutes([], async () => {
    assertEquals(
      await gateClaimedAutonomousJob(job({ trigger: "interface" } as never)),
      "proceed",
    );
    assertEquals(
      await gateClaimedAutonomousJob(
        job({ meta: { approvalHold: true } } as never),
      ),
      "proceed",
    );
  });
  assertEquals(log, []);
});

function policySetRoute(rows: unknown[]): Route {
  return {
    match: (url) => url.pathname.endsWith("/agent_policy_sets"),
    respond: () => new Response(JSON.stringify(rows), { status: 200 }),
  };
}

const HOLD_RULE_HEAD = {
  app_id: "app-1",
  user_id: "user-1",
  version: 3,
  source: [],
  artifact: {
    version: 1,
    rules: [{
      id: "r1",
      functionName: "send_reply",
      effect: "hold",
      when: [{ path: "to", op: "contains", value: "@competitor.com" }],
    }],
  },
  compile_model: "claude-sonnet-5",
  created_at: "2026-08-03T00:00:00.000Z",
};

Deno.test("no policy row and no compiled rules: proceed after two reads", async () => {
  const { log } = await withRoutes(
    [policyRoute([]), policySetRoute([])],
    async () => {
      assertEquals(await gateClaimedAutonomousJob(job()), "proceed");
    },
  );
  // One overlay read + one policy-set head read — the full policy plane.
  assertEquals(log.length, 2);
});

Deno.test("P4: a matching predicate holds the claim and names the rule", async () => {
  const writes: Record<string, unknown>[] = [];
  const routes: Route[] = [
    policyRoute([]),
    policySetRoute([HOLD_RULE_HEAD]),
    APP_ROUTE,
    envelopeLookupRoute([]),
    {
      match: (url, init) =>
        url.pathname.endsWith("/async_jobs") && init.method === "PATCH",
      respond: (_url, init) => {
        writes.push({ kind: "job", status: JSON.parse(String(init.body)).status });
        return new Response(JSON.stringify([{ id: "job-1" }]), { status: 200 });
      },
    },
    {
      match: (url, init) =>
        url.pathname.endsWith("/agent_approvals") && init.method === "POST",
      respond: (_url, init) => {
        const body = JSON.parse(String(init.body));
        writes.push({
          kind: "envelope",
          policyRevision: body.policy_revision,
          heldBy: (body.source as { heldBy?: { ruleId?: string } }).heldBy
            ?.ruleId,
        });
        return new Response(JSON.stringify([body]), { status: 201 });
      },
    },
  ];
  await withRoutes(routes, async () => {
    assertEquals(
      await gateClaimedAutonomousJob(
        job({ args: { to: "sales@competitor.com" } } as never),
      ),
      "held",
    );
  });
  assertEquals(writes, [
    { kind: "job", status: "held" },
    { kind: "envelope", policyRevision: "policyset:v3:r1", heldBy: "r1" },
  ]);
});

Deno.test("P4: non-matching args pass the predicate layer untouched", async () => {
  await withRoutes(
    [policyRoute([]), policySetRoute([HOLD_RULE_HEAD])],
    async () => {
      assertEquals(
        await gateClaimedAutonomousJob(
          job({ args: { to: "customer@example.com" } } as never),
        ),
        "proceed",
      );
    },
  );
});

Deno.test("P4: a deny rule settles the claim with a rule-attributed witness", async () => {
  const writes: string[] = [];
  const denyHead = {
    ...HOLD_RULE_HEAD,
    artifact: {
      version: 1,
      rules: [{
        id: "r1",
        functionName: "send_reply",
        effect: "deny",
        when: [{ path: "to", op: "contains", value: "@competitor.com" }],
      }],
    },
  };
  const routes: Route[] = [
    policyRoute([]),
    policySetRoute([denyHead]),
    {
      match: (url, init) =>
        url.pathname.endsWith("/async_jobs") && init.method === "PATCH",
      respond: (_url, init) => {
        writes.push(`job:${JSON.parse(String(init.body)).status}`);
        return new Response(JSON.stringify([{ id: "job-1" }]), { status: 200 });
      },
    },
    {
      match: (url, init) =>
        url.pathname.endsWith("/agent_effect_events") &&
        init.method === "POST",
      respond: (_url, init) => {
        const events = JSON.parse(String(init.body)) as Array<
          { channel?: string }
        >;
        writes.push(`witness:${events[0]?.channel}`);
        return new Response("[]", { status: 201 });
      },
    },
  ];
  await withRoutes(routes, async () => {
    assertEquals(
      await gateClaimedAutonomousJob(
        job({ args: { to: "x@competitor.com" } } as never),
      ),
      "denied",
    );
  });
  assertEquals(writes, ["job:denied", "witness:policy:rule:r1"]);
});

Deno.test("Off denies before tenant code: row settles, witness records it", async () => {
  const patched: Record<string, unknown>[] = [];
  const routes: Route[] = [
    policyRoute([{
      app_id: "app-1",
      function_name: "send_reply",
      policy: "off",
      declaration_hash: null,
      revision: "rev-1",
      set_by: {},
      updated_at: "2026-08-03T00:00:00.000Z",
    }]),
    APP_ROUTE,
    {
      match: (url, init) =>
        url.pathname.endsWith("/async_jobs") && init.method === "PATCH",
      respond: (url, init) => {
        patched.push({
          status: JSON.parse(String(init.body)).status,
          filter: url.searchParams.get("status"),
        });
        return new Response(JSON.stringify([{ id: "job-1" }]), { status: 200 });
      },
    },
    {
      match: (url) => url.pathname.endsWith("/agent_effect_events"),
      respond: () => new Response("[]", { status: 201 }),
    },
  ];
  await withRoutes(routes, async () => {
    assertEquals(await gateClaimedAutonomousJob(job()), "denied");
  });
  assertEquals(patched, [{ status: "denied", filter: "eq.running" }]);
});

Deno.test("ask parks the claimed row and files the envelope once", async () => {
  const writes: Record<string, unknown>[] = [];
  const routes: Route[] = [
    policyRoute([{
      app_id: "app-1",
      function_name: "send_reply",
      policy: "ask",
      declaration_hash: null,
      revision: "rev-a",
      set_by: {},
      updated_at: "2026-08-03T00:00:00.000Z",
    }]),
    APP_ROUTE,
    envelopeLookupRoute([]),
    {
      match: (url, init) =>
        url.pathname.endsWith("/async_jobs") && init.method === "PATCH",
      respond: (url, init) => {
        writes.push({
          kind: "job",
          status: JSON.parse(String(init.body)).status,
          filter: url.searchParams.get("status"),
        });
        return new Response(JSON.stringify([{ id: "job-1" }]), { status: 200 });
      },
    },
    {
      match: (url, init) =>
        url.pathname.endsWith("/agent_approvals") && init.method === "POST",
      respond: (_url, init) => {
        const body = JSON.parse(String(init.body));
        writes.push({
          kind: "envelope",
          run_id: body.run_id,
          trigger: body.trigger,
          consequence: body.consequence,
        });
        return new Response(JSON.stringify([body]), { status: 201 });
      },
    },
  ];
  await withRoutes(routes, async () => {
    assertEquals(await gateClaimedAutonomousJob(job()), "held");
  });
  assertEquals(writes, [
    { kind: "job", status: "held", filter: "eq.running" },
    {
      kind: "envelope",
      run_id: "exec-1",
      trigger: "schedule",
      consequence: "external_side_effect",
    },
  ]);
});

Deno.test("a 'resuming' envelope IS the authorization: re-claimed job proceeds", async () => {
  const routes: Route[] = [
    policyRoute([{
      app_id: "app-1",
      function_name: "send_reply",
      policy: "ask",
      declaration_hash: null,
      revision: "rev-a",
      set_by: {},
      updated_at: "2026-08-03T00:00:00.000Z",
    }]),
    APP_ROUTE,
    envelopeLookupRoute([{ id: "appr-1", status: "resuming" }]),
  ];
  const { log } = await withRoutes(routes, async () => {
    assertEquals(await gateClaimedAutonomousJob(job()), "proceed");
  });
  // No PATCH, no second envelope.
  assert(!log.some((line) => line.startsWith("PATCH")));
  assert(!log.some((line) => line.startsWith("POST /rest/v1/agent_approvals")));
});

Deno.test("decision 4 at claim: free consent under a changed declaration holds", async () => {
  const writes: string[] = [];
  const routes: Route[] = [
    policyRoute([{
      app_id: "app-1",
      function_name: "send_reply",
      policy: "free",
      declaration_hash: "hash-OLD",
      revision: "rev-f",
      set_by: {},
      updated_at: "2026-08-03T00:00:00.000Z",
    }]),
    APP_ROUTE,
    envelopeLookupRoute([]),
    {
      match: (url, init) =>
        url.pathname.endsWith("/async_jobs") && init.method === "PATCH",
      respond: (_url, init) => {
        writes.push(`job:${JSON.parse(String(init.body)).status}`);
        return new Response(JSON.stringify([{ id: "job-1" }]), { status: 200 });
      },
    },
    {
      match: (url, init) =>
        url.pathname.endsWith("/agent_approvals") && init.method === "POST",
      respond: (_url, init) => {
        writes.push("envelope");
        return new Response(JSON.stringify([JSON.parse(String(init.body))]), {
          status: 201,
        });
      },
    },
  ];
  await withRoutes(routes, async () => {
    assertEquals(await gateClaimedAutonomousJob(job()), "held");
  });
  assertEquals(writes, ["job:held", "envelope"]);
});

Deno.test("fail closed: an unreadable policy store parks the job", async () => {
  const writes: string[] = [];
  const routes: Route[] = [
    {
      match: (url) => url.pathname.endsWith("/agent_function_policies"),
      respond: () => new Response("boom", { status: 500 }),
    },
    {
      match: (url, init) =>
        url.pathname.endsWith("/async_jobs") && init.method === "PATCH",
      respond: (_url, init) => {
        writes.push(`job:${JSON.parse(String(init.body)).status}`);
        return new Response(JSON.stringify([{ id: "job-1" }]), { status: 200 });
      },
    },
  ];
  await withRoutes(routes, async () => {
    assertEquals(await gateClaimedAutonomousJob(job()), "held");
  });
  assertEquals(writes, ["job:held"]);
});
