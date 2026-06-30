// Gate test for the owner-only ADMIN runtime binding (Slice B.3). The binding can
// mutate platform-wide defaults, so it must be wired ONLY when the platform owner
// runs one of their OWN Agents. A third-party Agent run by the owner, a non-owner,
// or an unconfigured owner id must all NOT receive it. This asserts the exact gate
// by inspecting which RPC bindings were handed to the dynamic-worker loader.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { executeInDynamicSandbox } from "./dynamic-sandbox.ts";
import type { RuntimeConfig } from "./sandbox.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "33333333-3333-4333-8333-333333333333";
const NON_OWNER = "44444444-4444-4444-8444-444444444444";

function installHarness(platformOwnerId: string | undefined): {
  captured: { envKeys: string[] };
  restore: () => void;
} {
  const captured = { envKeys: [] as string[] };
  const prevEnv = globalThis.__env;
  const prevCtx = globalThis.__ctx;

  const loader = {
    // deno-lint-ignore no-explicit-any
    load(cfg: any) {
      captured.envKeys = Object.keys(cfg?.env ?? {});
      return {
        getEntrypoint() {
          return {
            fetch: () =>
              Promise.resolve(
                new Response(
                  JSON.stringify({
                    success: true,
                    result: "ok",
                    logs: [],
                    aiCostLight: 0,
                  }),
                  { headers: { "Content-Type": "application/json" } },
                ),
              ),
          };
        },
      };
    },
  };

  // deno-lint-ignore no-explicit-any
  const env: any = {
    LOADER: loader,
    CODE_CACHE: { get: () => Promise.resolve("export const noop = 1;") },
    AGENT_CALLER_SECRET: "test-agent-caller-secret",
  };
  if (platformOwnerId !== undefined) env.PLATFORM_OWNER_USER_ID = platformOwnerId;
  globalThis.__env = env;

  globalThis.__ctx = {
    exports: {
      // deno-lint-ignore no-explicit-any
      AdminBinding: (_input: any) => ({
        defaultsList: () => Promise.resolve({ defaults: [] }),
        defaultsAdd: () => Promise.resolve({}),
        defaultsRemove: () => Promise.resolve({}),
      }),
    },
    waitUntil: (p: Promise<unknown>) => {
      p.catch(() => {});
    },
    // deno-lint-ignore no-explicit-any
  } as any;

  return {
    captured,
    restore: () => {
      globalThis.__env = prevEnv;
      globalThis.__ctx = prevCtx;
    },
  };
}

function config(
  userId: string,
  ownerId: string,
  allowPlatformAdmin = false,
): RuntimeConfig {
  return {
    appId: "app_admin_gate",
    userId,
    ownerId,
    allowPlatformAdmin,
    executionId: "exec_admin_gate",
    code: "",
    permissions: [],
    userApiKey: null,
    user: { id: userId, email: "u@test.dev", displayName: null, tier: "free" },
    d1DataService: null,
    memoryService: null,
    envVars: {},
    callerContextToken: "gxc1.dummy.sig",
    workerSecret: "irrelevant",
    baseUrl: "https://api.test.dev",
    workerBaseUrl: "https://api.test.dev",
    // deno-lint-ignore no-explicit-any
  } as unknown as RuntimeConfig;
}

Deno.test("ADMIN gate: wired when the platform owner runs their OWN published Agent", async () => {
  const h = installHarness(OWNER);
  try {
    await executeInDynamicSandbox(config(OWNER, OWNER, true), "noop", []);
    assert(
      h.captured.envKeys.includes("ADMIN"),
      "ADMIN must be wired for an owner-owned published execution",
    );
  } finally {
    h.restore();
  }
});

Deno.test("ADMIN gate: NOT wired for an ephemeral/test execution (no allowPlatformAdmin) even as owner-own-app", async () => {
  // The gx.test / ephemeral-code executor runs untrusted code with
  // ownerId === userId but never sets allowPlatformAdmin. The owner testing such
  // code must NOT reach platform admin (the confused-deputy guard).
  const h = installHarness(OWNER);
  try {
    await executeInDynamicSandbox(config(OWNER, OWNER, false), "noop", []);
    assert(
      !h.captured.envKeys.includes("ADMIN"),
      "ADMIN must NOT be wired without the allowPlatformAdmin opt-in",
    );
  } finally {
    h.restore();
  }
});

Deno.test("ADMIN gate: NOT wired when the owner runs a THIRD-PARTY Agent", async () => {
  const h = installHarness(OWNER);
  try {
    await executeInDynamicSandbox(config(OWNER, OTHER_OWNER, true), "noop", []);
    assert(
      !h.captured.envKeys.includes("ADMIN"),
      "ADMIN must NOT be wired when the Agent is owned by someone else",
    );
  } finally {
    h.restore();
  }
});

Deno.test("ADMIN gate: NOT wired for a non-owner user", async () => {
  const h = installHarness(OWNER);
  try {
    await executeInDynamicSandbox(config(NON_OWNER, NON_OWNER, true), "noop", []);
    assert(
      !h.captured.envKeys.includes("ADMIN"),
      "ADMIN must NOT be wired for a non-owner",
    );
  } finally {
    h.restore();
  }
});

Deno.test("ADMIN gate: NOT wired when PLATFORM_OWNER_USER_ID is unconfigured", async () => {
  const h = installHarness(undefined);
  try {
    await executeInDynamicSandbox(config(OWNER, OWNER, true), "noop", []);
    assert(
      !h.captured.envKeys.includes("ADMIN"),
      "ADMIN must NOT be wired when no platform owner is configured",
    );
  } finally {
    h.restore();
  }
});
