import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";

import {
  buildCallerPermissionConfigureUrl,
  enforceCallerFunctionPermission,
  listCallerFunctionPermissions,
  updateCallerFunctionPermissions,
} from "./caller-function-permissions.ts";

const TEST_ENV = {
  BASE_URL: "https://ultralight.test",
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

async function withEnv<T>(
  fn: () => Promise<T>,
  fetchMock?: typeof fetch,
): Promise<T> {
  const previousEnv = globalThis.__env;
  const previousFetch = globalThis.fetch;
  globalThis.__env = {
    ...(previousEnv || {}),
    ...TEST_ENV,
  } as typeof globalThis.__env;
  if (fetchMock) globalThis.fetch = fetchMock;
  try {
    return await fn();
  } finally {
    globalThis.__env = previousEnv;
    globalThis.fetch = previousFetch;
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("agent function permissions: default ask blocks external execution", async () => {
  await withEnv(
    async () => {
      const configureUrl = buildCallerPermissionConfigureUrl(
        "https://ultralight.test",
        "app-1",
        "deploy",
      );
      const result = await enforceCallerFunctionPermission({
        userId: "user-1",
        appId: "app-1",
        functionName: "deploy",
        configureUrl,
      });

      assertEquals(result.allowed, false);
      if (!result.allowed) {
        assertEquals(result.errorType, "AGENT_PERMISSION_REQUIRED");
        assertEquals(result.details.type, "permission_required");
        assertEquals(result.details.policy, "ask");
        assertEquals(result.details.configureUrl, configureUrl);
      }
    },
    async () => jsonResponse([]),
  );
});

function alwaysPolicy(healthGate: boolean): typeof fetch {
  return (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/rest/v1/user_agent_permission_defaults?")) {
      return jsonResponse([{ user_id: "user-1", default_policy: "ask" }]);
    }
    if (url.includes("/rest/v1/user_agent_function_permissions?")) {
      return jsonResponse([{
        app_id: "app-1",
        function_name: "deploy",
        policy: "always",
        health_gate: healthGate,
        updated_at: "2026-06-06T15:00:00.000Z",
      }]);
    }
    return jsonResponse([]);
  }) as typeof fetch;
}

Deno.test("agent function permissions: ungated always allows execution", async () => {
  await withEnv(
    async () => {
      const result = await enforceCallerFunctionPermission({
        userId: "user-1",
        appId: "app-1",
        functionName: "deploy",
        configureUrl: "https://ultralight.test/settings",
      });
      assertEquals(result.allowed, true);
      if (result.allowed) {
        assertEquals(result.resolution.policy, "always");
        assertEquals(result.resolution.healthGate, false);
      }
    },
    alwaysPolicy(false),
  );
});

Deno.test("agent function permissions: health-gated always allows a healthy target", async () => {
  await withEnv(
    async () => {
      const result = await enforceCallerFunctionPermission({
        userId: "user-1",
        appId: "app-1",
        functionName: "deploy",
        configureUrl: "https://ultralight.test/settings",
        resolveTargetHealthGreen: async () => true,
      });
      assertEquals(result.allowed, true);
    },
    alwaysPolicy(true),
  );
});

Deno.test("agent function permissions: health-gated always asks when target is NOT healthy", async () => {
  await withEnv(
    async () => {
      const result = await enforceCallerFunctionPermission({
        userId: "user-1",
        appId: "app-1",
        functionName: "deploy",
        configureUrl: "https://ultralight.test/settings",
        resolveTargetHealthGreen: async () => false,
      });
      assertEquals(result.allowed, false);
      if (!result.allowed) {
        assertEquals(result.errorType, "AGENT_PERMISSION_REQUIRED");
        assertEquals(result.details.type, "permission_required");
        assertEquals(result.details.policy, "ask");
        // The block is tagged as health-gate-driven, not an explicit ask.
        assertEquals(
          (result.details as { reason?: string }).reason,
          "health_gate",
        );
      }
    },
    alwaysPolicy(true),
  );
});

Deno.test("agent function permissions: health-gated always with NO resolver fails closed (asks)", async () => {
  await withEnv(
    async () => {
      const result = await enforceCallerFunctionPermission({
        userId: "user-1",
        appId: "app-1",
        functionName: "deploy",
        configureUrl: "https://ultralight.test/settings",
        // no resolveTargetHealthGreen => treated as not-green => ask
      });
      assertEquals(result.allowed, false);
    },
    alwaysPolicy(true),
  );
});

Deno.test("agent function permissions: list resolves explicit and default policies", async () => {
  await withEnv(
    async () => {
      const result = await listCallerFunctionPermissions({
        userId: "user-1",
        appId: "app-1",
        functionNames: ["inspect", "deploy"],
      });

      assertEquals(result.defaultPolicy, "never");
      assertEquals(result.permissions.map((entry) => entry.functionName), [
        "deploy",
        "inspect",
      ]);
      assertEquals(result.permissions[0].policy, "always");
      assertEquals(result.permissions[0].source, "explicit");
      assertEquals(result.permissions[1].policy, "never");
      assertEquals(result.permissions[1].source, "default");
    },
    async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rest/v1/user_agent_permission_defaults?")) {
        return jsonResponse([{ user_id: "user-1", default_policy: "never" }]);
      }
      if (url.includes("/rest/v1/user_agent_function_permissions?")) {
        return jsonResponse([{
          app_id: "app-1",
          function_name: "deploy",
          policy: "always",
        }]);
      }
      return jsonResponse([]);
    },
  );
});

Deno.test("agent function permissions: update upserts default and function overrides", async () => {
  const writes: Array<{ url: string; body: unknown }> = [];
  await withEnv(
    async () => {
      await updateCallerFunctionPermissions({
        userId: "user-1",
        appId: "app-1",
        defaultPolicy: "ask",
        permissions: [{ functionName: "deploy", policy: "always" }],
        allowedFunctionNames: ["deploy"],
      });

      assertEquals(writes.length, 2);
      assertEquals(
        writes[0].url,
        "https://supabase.test/rest/v1/user_agent_permission_defaults?on_conflict=user_id",
      );
      assertEquals(writes[0].body, [{
        user_id: "user-1",
        default_policy: "ask",
      }]);
      assertEquals(
        writes[1].url,
        "https://supabase.test/rest/v1/user_agent_function_permissions?on_conflict=user_id,app_id,function_name",
      );
      assertEquals(writes[1].body, [{
        user_id: "user-1",
        app_id: "app-1",
        function_name: "deploy",
        policy: "always",
      }]);
    },
    async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === "POST") {
        writes.push({
          url,
          body: JSON.parse(String(init.body)),
        });
      }
      return new Response(null, { status: 204 });
    },
  );
});

Deno.test("agent function permissions: update writes health_gate when provided", async () => {
  const writes: Array<{ url: string; body: unknown }> = [];
  await withEnv(
    async () => {
      await updateCallerFunctionPermissions({
        userId: "user-1",
        appId: "app-1",
        permissions: [{
          functionName: "deploy",
          policy: "always",
          healthGate: false,
        }],
      });

      assertEquals(writes.length, 1);
      assertEquals(writes[0].body, [{
        user_id: "user-1",
        app_id: "app-1",
        function_name: "deploy",
        policy: "always",
        health_gate: false,
      }]);
    },
    async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === "POST") {
        writes.push({ url, body: JSON.parse(String(init.body)) });
      }
      return new Response(null, { status: 204 });
    },
  );
});

Deno.test("agent function permissions: confirm satisfies ask (allow once)", async () => {
  await withEnv(
    async () => {
      const result = await enforceCallerFunctionPermission({
        userId: "user-1",
        appId: "app-1",
        functionName: "deploy",
        configureUrl: "https://ultralight.test/settings",
        confirmed: true,
      });
      assertEquals(result.allowed, true);
      if (result.allowed) assertEquals(result.resolution.policy, "ask");
    },
    async () => jsonResponse([]), // no explicit rows -> default "ask"
  );
});

Deno.test("agent function permissions: confirm does NOT override never", async () => {
  await withEnv(
    async () => {
      const result = await enforceCallerFunctionPermission({
        userId: "user-1",
        appId: "app-1",
        functionName: "deploy",
        configureUrl: "https://ultralight.test/settings",
        confirmed: true,
      });
      assertEquals(result.allowed, false);
      if (!result.allowed) {
        assertEquals(result.details.policy, "never");
        // The bounce is a diagnostic: it names the policy and the way out.
        assertEquals(result.message.includes('"never"'), true);
        assertEquals(result.message.includes("gx.consent"), true);
      }
    },
    (async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/rest/v1/user_agent_permission_defaults?")) {
        return jsonResponse([{ user_id: "user-1", default_policy: "never" }]);
      }
      return jsonResponse([]);
    }) as typeof fetch,
  );
});

Deno.test("agent function permissions: confirm satisfies a health-gated ask", async () => {
  await withEnv(
    async () => {
      const result = await enforceCallerFunctionPermission({
        userId: "user-1",
        appId: "app-1",
        functionName: "deploy",
        configureUrl: "https://ultralight.test/settings",
        confirmed: true,
        // Target is NOT healthy, so an "always" policy degrades to ask — which
        // the one-shot consent then satisfies.
        resolveTargetHealthGreen: async () => false,
      });
      assertEquals(result.allowed, true);
      if (result.allowed) assertEquals(result.resolution.policy, "always");
    },
    alwaysPolicy(true),
  );
});
