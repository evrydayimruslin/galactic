import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import type { ResolvedHttpRoutePolicy } from "./http-policy.ts";
import {
  resolveHttpCallerAuthOptions,
  resolveHttpRuntimeCallContext,
  validateHttpRouteExecutionPolicy,
} from "./http-execution-policy.ts";
import type { RequestCallerContext } from "./request-caller-context.ts";

const ownerApp = { owner_id: "owner-123", runtime: "deno" as const };

function policy(
  overrides: Partial<ResolvedHttpRoutePolicy>,
): ResolvedHttpRoutePolicy {
  return {
    declared: true,
    functionName: "webhook",
    auth: "user",
    methods: ["POST"],
    cors: null,
    rateLimit: null,
    billing: "caller",
    dataScope: "app",
    ...overrides,
  };
}

function caller(
  overrides: Partial<RequestCallerContext>,
): RequestCallerContext {
  return {
    authState: "authenticated",
    authUser: null,
    userId: "caller-123",
    user: {
      id: "caller-123",
      email: "caller@example.com",
      displayName: null,
      avatarUrl: null,
      tier: "free",
      provisional: false,
    },
    userProfile: null,
    userApiKey: null,
    tokenAppIds: null,
    tokenFunctionNames: null,
    scopes: undefined,
    ...overrides,
  };
}

Deno.test("http execution policy: public routes allow anonymous and ignore non-platform auth headers", () => {
  const options = resolveHttpCallerAuthOptions(policy({
    auth: "public",
    billing: "owner",
    dataScope: "app",
  }));

  assertEquals(options, {
    allowAnonymous: true,
    invalidAuthPolicy: "ignore",
  });
});

Deno.test("http execution policy: authenticated routes preserve strict auth", () => {
  const options = resolveHttpCallerAuthOptions(policy({ auth: "user" }));

  assertEquals(options, {
    allowAnonymous: false,
    invalidAuthPolicy: "throw",
  });
});

Deno.test("http execution policy: public routes are owner-billed app-scope calls", () => {
  const context = resolveHttpRuntimeCallContext(
    policy({ auth: "public", billing: "owner", dataScope: "app" }),
    ownerApp,
    caller({
      authState: "anonymous",
      userId: "00000000-0000-0000-0000-000000000000",
      user: null,
    }),
  );

  assertEquals(context, {
    publicRoute: true,
    ownerBilled: true,
    enforceTokenScopes: false,
    payerUserId: "owner-123",
    envUserId: null,
    appDataUserId: undefined,
    sandboxUserId: "anonymous",
  });
});

Deno.test("http execution policy: user data scope partitions app data by authenticated caller", () => {
  const context = resolveHttpRuntimeCallContext(
    policy({ auth: "user", billing: "caller", dataScope: "user" }),
    ownerApp,
    caller({}),
  );

  assertEquals(context.payerUserId, "caller-123");
  assertEquals(context.envUserId, "caller-123");
  assertEquals(context.appDataUserId, "caller-123");
  assertEquals(context.sandboxUserId, "caller-123");
  assertEquals(context.enforceTokenScopes, true);
});

Deno.test("http execution policy: rejects unsafe or unsupported public route policies", () => {
  assertEquals(
    validateHttpRouteExecutionPolicy(
      policy({ auth: "public", billing: "caller", dataScope: "app" }),
      ownerApp,
    )?.message,
    "Public HTTP routes must use owner billing.",
  );

  assertEquals(
    validateHttpRouteExecutionPolicy(
      policy({ auth: "public", billing: "owner", dataScope: "user" }),
      ownerApp,
    )?.message,
    "Public HTTP routes must use app data scope.",
  );

  assertEquals(
    validateHttpRouteExecutionPolicy(
      policy({ auth: "public", billing: "owner", dataScope: "app" }),
      { owner_id: "owner-123", runtime: "gpu" },
    )?.message,
    "Owner-billed HTTP routes are not yet supported for GPU apps.",
  );
});
