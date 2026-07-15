import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertRejects } from "https://deno.land/std@0.210.0/assert/assert_rejects.ts";

import {
  createSandboxActorToken,
  isSandboxActorToken,
  mintSandboxAuthToken,
  SANDBOX_ACTOR_TOKEN_PREFIX,
  verifySandboxActorToken,
} from "./sandbox-actor.ts";
import { authenticateRequest } from "./request-auth.ts";
import {
  callerCanInvokeMcpTool,
  callerWithinRoutineCapabilityCeiling,
} from "./request-caller-context.ts";
import { routineTraceContextFromCaller } from "./routine-trace.ts";

// WORKER_SECRET is deliberately DIFFERENT from the signing secret: it is the
// secret that IS exposed to sandbox code, and must not be able to forge tokens.
const TEST_ENV = {
  AGENT_CALLER_SECRET: "sandbox-actor-secret-1",
  WORKER_SECRET: "worker-secret-sandbox-exposed",
};

async function withEnv<T>(
  fn: () => Promise<T>,
  overrides: Record<string, string> = {},
): Promise<T> {
  const previousEnv = globalThis.__env;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
    ...overrides,
  } as typeof globalThis.__env;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
  }
}

const USER = { id: "user-1", email: "dev@example.com", tier: "pro" };

Deno.test("signed actors cannot use synthetic MCP SDK tools", () => {
  const sdkTools = [
    "ultralight.ai",
    "ultralight.store",
    "ultralight.remove",
    "ultralight.remember",
  ];
  for (const authSource of ["routine_actor", "sandbox_actor"] as const) {
    for (const tool of sdkTools) {
      assertEquals(
        callerCanInvokeMcpTool({
          authState: "authenticated",
          authSource,
        }, tool),
        false,
        `${authSource} unexpectedly reached ${tool}`,
      );
    }
    assertEquals(
      callerCanInvokeMcpTool({
        authState: "authenticated",
        authSource,
      }, "approved_tenant_export"),
      true,
    );
  }
});

Deno.test("sandbox actor keeps the tenant-export self-call exception", () => {
  const caller = {
    authState: "authenticated" as const,
    authSource: "sandbox_actor" as const,
    routineContext: {
      routineId: "routine-1",
      routineRunId: "run-1",
      traceId: "trace-1",
    },
    routineCapabilityCeiling: [],
    routineActor: undefined,
    sandboxActor: {
      appId: "app-a",
    },
  };
  assertEquals(
    callerCanInvokeMcpTool(caller, "approved_tenant_export"),
    true,
  );
  assertEquals(
    callerWithinRoutineCapabilityCeiling(
      caller,
      ["app-a"],
      ["approved_tenant_export"],
    ),
    true,
  );
});

Deno.test("sandbox actor: mint then verify round-trips identity + scope", async () => {
  await withEnv(async () => {
    const nowMs = Date.UTC(2026, 5, 11, 12, 0, 0);
    const { token, claims } = await createSandboxActorToken({
      user: USER,
      appId: "app-a",
      allowedAppIds: ["app-b", "app-c"],
      executionId: "exec-9",
      nowMs,
    });

    assert(token.startsWith(SANDBOX_ACTOR_TOKEN_PREFIX));
    assertEquals(claims.user_id, "user-1");
    assertEquals(claims.user_email, "dev@example.com");
    assertEquals(claims.user_tier, "pro");
    assertEquals(claims.app_id, "app-a");
    // The executing app is always included so self-calls work.
    assertEquals(claims.app_ids.sort(), ["app-a", "app-b", "app-c"]);
    assertEquals(claims.scopes, ["apps:call"]);
    assertEquals(claims.jti, "exec-9");
    assertEquals(claims.routine_id, undefined);
    assertEquals(claims.routine_run_id, undefined);
    assertEquals(claims.trace_id, undefined);

    const verified = await verifySandboxActorToken(token, nowMs);
    assert(verified !== null);
    assertEquals(verified?.claims.app_ids.sort(), ["app-a", "app-b", "app-c"]);
  });
});

Deno.test("sandbox actor: signed routine attribution survives repeated Agent hops", async () => {
  await withEnv(async () => {
    const routineContext = {
      routineId: "routine-immutable",
      routineRunId: "run-immutable",
      traceId: "trace-immutable",
    };
    const routineCapabilities = [
      {
        app_id: "app-b",
        app_ref: "agent-b",
        function_name: "read_b",
        access: "read" as const,
        required: true,
      },
      {
        app_id: "app-c",
        app_ref: "agent-c",
        function_name: "write_c",
        access: "write" as const,
        required: true,
      },
    ];
    const firstHop = await mintSandboxAuthToken({
      user: USER,
      appId: "app-a",
      executionId: "exec-a",
      hasBroadCallPermission: false,
      dependencyAppIds: ["app-b"],
      routineContext,
      routineCapabilities,
    });
    assert(firstHop !== null);

    const firstAuth = await authenticateRequest(
      new Request("https://ultralight.test/mcp/app-b", {
        method: "POST",
        headers: { Authorization: `Bearer ${firstHop}` },
      }),
      "bearer_only",
    );
    assertEquals(firstAuth.authSource, "sandbox_actor");
    assertEquals(firstAuth.routineContext, routineContext);
    assertEquals(firstAuth.routineCapabilityCeiling, routineCapabilities);
    // Attribution does not turn a downstream bearer into a root routine actor;
    // it must not gain the handler self-invocation bypass or capability policy.
    assertEquals(firstAuth.routineActor, undefined);
    assertEquals(
      routineTraceContextFromCaller({
        routineContext: firstAuth.routineContext,
        routineActor: firstAuth.routineActor,
      }),
      routineContext,
    );

    // App B executes and calls App C: the host re-mints a new app-scoped token
    // from authenticated server context, preserving the same routine identity.
    const secondHop = await mintSandboxAuthToken({
      user: USER,
      appId: "app-b",
      executionId: "exec-b",
      hasBroadCallPermission: false,
      dependencyAppIds: ["app-c"],
      routineContext: firstAuth.routineContext,
      routineCapabilities: firstAuth.routineCapabilityCeiling,
    });
    assert(secondHop !== null);
    const verified = await verifySandboxActorToken(secondHop!);
    assertEquals(verified?.claims.routine_id, routineContext.routineId);
    assertEquals(verified?.claims.routine_run_id, routineContext.routineRunId);
    assertEquals(verified?.claims.trace_id, routineContext.traceId);
    assertEquals(verified?.claims.app_id, "app-b");
    assertEquals(verified?.claims.app_ids.sort(), [
      "agent-b",
      "agent-c",
      "app-b",
      "app-c",
    ]);
    assertEquals(verified?.claims.function_names.sort(), ["read_b", "write_c"]);
    assertEquals(verified?.claims.routine_capabilities, routineCapabilities);

    const secondAuth = await authenticateRequest(
      new Request("https://ultralight.test/mcp/app-c", {
        method: "POST",
        headers: { Authorization: `Bearer ${secondHop}` },
      }),
      "bearer_only",
    );
    // Exact-pair enforcement: the flattened token scopes contain both app and
    // function names, but may not authorize their unapproved cross-product.
    assertEquals(
      callerWithinRoutineCapabilityCeiling(
        secondAuth,
        ["app-c", "agent-c"],
        ["write_c"],
      ),
      true,
    );
    assertEquals(
      callerWithinRoutineCapabilityCeiling(
        secondAuth,
        ["app-c", "agent-c"],
        ["read_b"],
      ),
      false,
    );
    // Signed executing-app identity allows self calls without widening the
    // routine to any other Agent/function pair.
    assertEquals(
      callerWithinRoutineCapabilityCeiling(
        secondAuth,
        ["app-b"],
        ["local_helper"],
      ),
      true,
    );
  });
});

Deno.test("sandbox actor: tenant-shaped identity fields cannot override host routine context", async () => {
  await withEnv(async () => {
    // A tenant-controlled object may contain look-alike snake_case fields, but
    // the mint reads routine attribution exclusively from the host-only option.
    const tenantShapedUser = {
      ...USER,
      routine_id: "routine-forged-by-app",
      routine_run_id: "run-forged-by-app",
      trace_id: "trace-forged-by-app",
    };
    const token = await mintSandboxAuthToken({
      user: tenantShapedUser,
      appId: "app-a",
      hasBroadCallPermission: true,
      dependencyAppIds: [],
      routineContext: {
        routineId: "routine-host",
        routineRunId: "run-host",
        traceId: "trace-host",
      },
    });
    const verified = await verifySandboxActorToken(token!);
    assertEquals(verified?.claims.routine_id, "routine-host");
    assertEquals(verified?.claims.routine_run_id, "run-host");
    assertEquals(verified?.claims.trace_id, "trace-host");
  });
});

Deno.test("sandbox actor: host refuses partial routine attribution", async () => {
  await withEnv(async () => {
    await assertRejects(
      () =>
        createSandboxActorToken({
          user: USER,
          appId: "app-a",
          routineContext: {
            routineId: "routine-1",
            routineRunId: "",
          },
        }),
      Error,
      "routineContext requires routineId and routineRunId",
    );
  });
});

Deno.test("sandbox actor: broad app:call permission mints an unrestricted token", async () => {
  await withEnv(async () => {
    const token = await mintSandboxAuthToken({
      user: USER,
      appId: "app-a",
      hasBroadCallPermission: true,
      dependencyAppIds: ["app-b"],
    });
    assert(token !== null);
    const verified = await verifySandboxActorToken(token!);
    assertEquals(verified?.claims.app_ids, ["*"]);
  });
});

Deno.test("sandbox actor: dependency-scoped mint restricts to declared apps", async () => {
  await withEnv(async () => {
    const token = await mintSandboxAuthToken({
      user: USER,
      appId: "app-a",
      hasBroadCallPermission: false,
      dependencyAppIds: ["app-b"],
    });
    const verified = await verifySandboxActorToken(token!);
    assertEquals(verified?.claims.app_ids.sort(), ["app-a", "app-b"]);
  });
});

Deno.test("sandbox actor: anonymous execution mints no token", async () => {
  await withEnv(async () => {
    const token = await mintSandboxAuthToken({
      user: null,
      appId: "app-a",
      hasBroadCallPermission: true,
      dependencyAppIds: [],
    });
    assertEquals(token, null);
  });
});

Deno.test("sandbox actor: the minted token is NOT the caller's raw ul_ key", async () => {
  await withEnv(async () => {
    // Simulate the old leak: the caller's real key would have been injected.
    const rawUserKey = "ul_realfullscopekey1234567890abcdef";
    const token = await mintSandboxAuthToken({
      user: USER,
      appId: "app-a",
      hasBroadCallPermission: true,
      dependencyAppIds: [],
    });
    assert(token !== null);
    assert(!token!.includes(rawUserKey));
    assert(token!.startsWith(SANDBOX_ACTOR_TOKEN_PREFIX));
    // It must not be usable as / mistaken for a long-lived ul_ API token.
    assert(!token!.startsWith("ul_"));
  });
});

Deno.test("sandbox actor: tampered claims fail verification", async () => {
  await withEnv(async () => {
    const { token } = await createSandboxActorToken({
      user: USER,
      appId: "app-a",
      allowedAppIds: ["app-b"],
    });
    const [body, sig] = token.slice(SANDBOX_ACTOR_TOKEN_PREFIX.length).split(
      ".",
    );
    // Re-encode claims with a widened scope, keep the original signature.
    const forgedClaims = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(body.replaceAll("-", "+").replaceAll("_", "/")),
          (ch) => ch.charCodeAt(0),
        ),
      ),
    );
    forgedClaims.app_ids = ["*"];
    const forgedBody = btoa(JSON.stringify(forgedClaims))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    const forged = `${SANDBOX_ACTOR_TOKEN_PREFIX}${forgedBody}.${sig}`;
    assertEquals(await verifySandboxActorToken(forged), null);
  });
});

Deno.test("sandbox actor: a token signed with WORKER_SECRET cannot be forged", async () => {
  // The threat: sandbox code CAN read WORKER_SECRET. Simulate it forging a
  // wide-open token by HMAC-signing crafted claims with WORKER_SECRET, exactly
  // as malicious app code would. Verification (which uses AGENT_CALLER_SECRET,
  // never WORKER_SECRET) must reject it.
  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const sign = async (payload: string, secret: string) => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return b64url(
      new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
      ),
    );
  };

  await withEnv(async () => {
    const nowSec = Math.floor(Date.UTC(2026, 5, 11, 12, 0, 0) / 1000);
    const claims = {
      typ: "ultralight.sandbox_actor",
      ver: 1,
      jti: "forged",
      sub: "user-1",
      user_id: "user-1",
      user_email: "dev@example.com",
      user_tier: "pro",
      provisional: false,
      app_id: "app-a",
      app_ids: ["*"],
      function_names: ["*"],
      scopes: ["apps:call"],
      iat: nowSec,
      exp: nowSec + 300,
    };
    const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
    const forged = `${SANDBOX_ACTOR_TOKEN_PREFIX}${body}.${
      await sign(body, TEST_ENV.WORKER_SECRET)
    }`;
    assertEquals(
      await verifySandboxActorToken(forged, Date.UTC(2026, 5, 11, 12, 0, 0)),
      null,
    );
  });
});

Deno.test("sandbox actor: expired token fails verification", async () => {
  await withEnv(async () => {
    const nowMs = Date.UTC(2026, 5, 11, 12, 0, 0);
    const { token } = await createSandboxActorToken({
      user: USER,
      appId: "app-a",
      allowedAppIds: ["app-b"],
      expiresInSeconds: 60,
      nowMs,
    });
    const later = nowMs + 61_000;
    assertEquals(await verifySandboxActorToken(token, later), null);
  });
});

Deno.test("sandbox actor: prefix does not collide with ul_ or routine/caller tokens", () => {
  assert(isSandboxActorToken("gxe_v1_abc.def"));
  assert(!isSandboxActorToken("ul_apikey"));
  assert(!isSandboxActorToken("gxr_v1_routine.sig"));
  assert(!isSandboxActorToken("gxc1.caller.sig"));
});

Deno.test("sandbox actor: authenticateRequest resolves user + app scope", async () => {
  await withEnv(async () => {
    const { token } = await createSandboxActorToken({
      user: USER,
      appId: "app-a",
      allowedAppIds: ["app-b"],
    });
    const user = await authenticateRequest(
      new Request("https://ultralight.test/mcp/app-b", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      "bearer_only",
    );
    assertEquals(user.id, "user-1");
    assertEquals(user.authSource, "sandbox_actor");
    assertEquals(user.tokenAppIds?.sort(), ["app-a", "app-b"]);
    assertEquals(user.scopes, ["apps:call"]);
    assertEquals(user.routineContext, undefined);
    assertEquals(user.routineActor, undefined);
  });
});
