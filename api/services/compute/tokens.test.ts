import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  COMPUTE_JOB_TOKEN_AUDIENCE,
  introspectComputeJobToken,
  introspectComputeJobTokenPrincipal,
  listComputeJobTokenAuthorities,
  parseComputeJobToken,
  prepareComputeJobToken,
  verifyPreparedComputeJobToken,
} from "./tokens.ts";

const PEPPER = "compute-token-test-pepper-at-least-32-characters";
const CONTAINER_ID = "container-developer-v1-abc123";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const AUTHORITY_ID = "55555555-5555-4555-8555-555555555555";

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function allowedPrincipal(extra: Record<string, unknown> = {}) {
  return {
    allowed: true,
    code: "ok",
    run_id: RUN_ID,
    agent_id: AGENT_ID,
    user_id: USER_ID,
    caller_function: "orchestrate",
    authority_id: AUTHORITY_ID,
    expires_at: "2026-07-20T00:00:00.000Z",
    ...extra,
  };
}

Deno.test("compute job token is opaque, 256-bit, hash-only material", async () => {
  const first = await prepareComputeJobToken({ tokenPepper: PEPPER });
  const second = await prepareComputeJobToken({ tokenPepper: PEPPER });
  const parsed = parseComputeJobToken(first.token);
  assert(parsed);
  assertEquals(parsed.lookupId, first.lookupId);
  assertEquals(parsed.secret.length, 43);
  assertEquals(first.digest.length, 64);
  assertNotEquals(first.token, second.token);
  assertNotEquals(first.digest, second.digest);
  assert(await verifyPreparedComputeJobToken(first.token, first.digest, PEPPER));
  assertEquals(
    await verifyPreparedComputeJobToken(second.token, first.digest, PEPPER),
    false,
  );
});

Deno.test("exact token authorization binds trusted container and never sends bearer", async () => {
  const prepared = await prepareComputeJobToken({ tokenPepper: PEPPER });
  let requestBody: Record<string, unknown> | null = null;
  const decision = await introspectComputeJobToken({
    token: prepared.token,
    containerId: CONTAINER_ID,
    authority: {
      action: "agents.call",
      target: {
        kind: "agent_function",
        agentId: AGENT_ID,
        functionName: "deploy",
      },
      constraints: { maxCalls: 1 },
    },
  }, {
    tokenPepper: PEPPER,
    supabaseUrl: "https://supabase.example",
    serviceRoleKey: "service-role",
    fetchFn: mockFetch((url, init) => {
      assert(url.endsWith("/rest/v1/rpc/authorize_compute_job_token"));
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(allowedPrincipal()), { status: 200 });
    }),
  });
  assertEquals(decision.allowed, true);
  assertEquals(decision.runId, RUN_ID);
  assert(requestBody);
  assertEquals(requestBody.p_audience, COMPUTE_JOB_TOKEN_AUDIENCE);
  assertEquals(requestBody.p_container_id, CONTAINER_ID);
  assertEquals(requestBody.p_action, "agents.call");
  assertEquals(requestBody.p_target_agent_id, AGENT_ID);
  assertEquals(requestBody.p_target_function, "deploy");
  assertEquals(requestBody.p_constraints, { maxCalls: 1 });
  assertEquals(requestBody.p_token_digest, prepared.digest);
  assertEquals(JSON.stringify(requestBody).includes(prepared.token), false);
});

Deno.test("principal introspection is container-bound and returns no authority list", async () => {
  const prepared = await prepareComputeJobToken({ tokenPepper: PEPPER });
  let requestBody: Record<string, unknown> | null = null;
  const principal = await introspectComputeJobTokenPrincipal({
    token: prepared.token,
    containerId: CONTAINER_ID,
  }, {
    tokenPepper: PEPPER,
    supabaseUrl: "https://supabase.example",
    serviceRoleKey: "service-role",
    fetchFn: mockFetch((_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(allowedPrincipal({ authority_id: null })), {
        status: 200,
      });
    }),
  });
  assertEquals(principal.allowed, true);
  assertEquals(principal.authorityId, null);
  assert(requestBody);
  assertEquals(requestBody.p_container_id, CONTAINER_ID);
  assertEquals(Object.hasOwn(requestBody, "p_lease_id"), false);
});

Deno.test("server-only token snapshot validates and canonicalizes every authority", async () => {
  const prepared = await prepareComputeJobToken({ tokenPepper: PEPPER });
  const snapshot = await listComputeJobTokenAuthorities({
    token: prepared.token,
    containerId: CONTAINER_ID,
  }, {
    tokenPepper: PEPPER,
    supabaseUrl: "https://supabase.example",
    serviceRoleKey: "service-role",
    fetchFn: mockFetch(() =>
      new Response(JSON.stringify(allowedPrincipal({
        authority_id: null,
        authorities: [{
          id: AUTHORITY_ID,
          action: "platform.call",
          resource_kind: "platform_function",
          target_agent_id: null,
          target_function: "artifacts.get",
          constraints: {},
        }],
      })), { status: 200 })
    ),
  });
  assertEquals(snapshot.principal.allowed, true);
  assertEquals(snapshot.authorities, [{
    id: AUTHORITY_ID,
    authority: {
      action: "platform.call",
      target: { kind: "platform_function", functionName: "artifacts.get" },
      constraints: {},
    },
  }]);
});

Deno.test("malformed compute token fails locally without database access", async () => {
  let called = false;
  const decision = await introspectComputeJobToken({
    token: "gx_human-key",
    containerId: CONTAINER_ID,
    authority: { action: "budget.read", target: { kind: "run" } },
  }, {
    tokenPepper: PEPPER,
    supabaseUrl: "https://supabase.example",
    serviceRoleKey: "service-role",
    fetchFn: mockFetch(() => {
      called = true;
      return new Response("[]");
    }),
  });
  assertEquals(decision.code, "token_invalid");
  assertEquals(called, false);
});

Deno.test("trusted container identity rejects controls before database access", async () => {
  const prepared = await prepareComputeJobToken({ tokenPepper: PEPPER });
  await assertRejects(
    () => introspectComputeJobTokenPrincipal({
      token: prepared.token,
      containerId: "container\nforged",
    }, {
      tokenPepper: PEPPER,
      supabaseUrl: "https://supabase.example",
      serviceRoleKey: "service-role",
      fetchFn: mockFetch(() => new Response("[]")),
    }),
    Error,
    "containerId is invalid",
  );
});
