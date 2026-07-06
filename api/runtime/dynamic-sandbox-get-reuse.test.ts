// Behavior of the EXECUTED_LOADER_GET_REUSE flag flip (Stage 3 of the get()
// rearchitecture): flag OFF (default) → loader.load() exactly as before; flag
// ON + eligible → loader.get(reuseKey, cb); ineligible executions (anonymous
// user, fixture-backed) stay on load() even with the flag ON. Also pins the
// reuse PRECONDITIONS: per-call data (functionName/args/authToken/callerCtx/
// execCtxHandle) rides the fetch body and never appears in the baked module
// content, and reusable-isolate bindings are constructed with requireExecCtx.

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assertNotEquals } from "https://deno.land/std@0.210.0/assert/assert_not_equals.ts";
import {
  deriveIsolateReuseKey,
  executeInDynamicSandbox,
} from "./dynamic-sandbox.ts";
import type { RuntimeConfig } from "./sandbox.ts";

const BUNDLE_CODE = "export const noop = 1;";
const CALLER_CTX = "gxc1.distinctive-caller-ctx-value-3k9q.sig";

interface Captured {
  loadCalls: number;
  getCalls: number;
  getIds: string[];
  cbInvocations: number;
  modules: Record<string, string>;
  requestBodies: unknown[];
  bindingProps: Record<string, unknown>;
}

function installHarness(): { captured: Captured; restore: () => void } {
  const captured: Captured = {
    loadCalls: 0,
    getCalls: 0,
    cbInvocations: 0,
    getIds: [],
    modules: {},
    requestBodies: [],
    bindingProps: {},
  };

  const prevEnv = globalThis.__env;
  const prevCtx = globalThis.__ctx;
  const prevAgentSecret = Deno.env.get("AGENT_CALLER_SECRET");
  Deno.env.set("AGENT_CALLER_SECRET", "test-agent-caller-secret");

  const entrypointFor = () => ({
    getEntrypoint() {
      return {
        fetch: async (request: Request) => {
          captured.requestBodies.push(await request.json().catch(() => null));
          return new Response(
            JSON.stringify({
              success: true,
              result: "ok",
              logs: [],
              aiCostLight: 0,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        },
      };
    },
  });

  const loader = {
    // deno-lint-ignore no-explicit-any
    load(cfg: any) {
      captured.loadCalls += 1;
      captured.modules = cfg?.modules ?? {};
      return entrypointFor();
    },
    // Faithful to the real Cloudflare Worker Loader get(): the callback runs
    // ONCE per id (cold start); a warm hit REPLAYS the frozen modules/env and
    // ignores the callback. Per-call data must therefore reach the frozen
    // isolate through the fetch body, never the cached content.
    // deno-lint-ignore no-explicit-any
    cache: new Map<string, any>(),
    // deno-lint-ignore no-explicit-any
    get(id: string, cb: () => Promise<any>) {
      captured.getCalls += 1;
      captured.getIds.push(id);
      // deno-lint-ignore no-explicit-any
      const self = this as any;
      return {
        getEntrypoint() {
          return {
            fetch: async (request: Request) => {
              if (!self.cache.has(id)) {
                captured.cbInvocations += 1;
                self.cache.set(id, await cb());
              }
              const cfg = self.cache.get(id);
              // Frozen content from the FIRST load for this id.
              captured.modules = cfg?.modules ?? {};
              captured.requestBodies.push(
                await request.json().catch(() => null),
              );
              return new Response(
                JSON.stringify({
                  success: true,
                  result: "ok",
                  logs: [],
                  aiCostLight: 0,
                }),
                { headers: { "Content-Type": "application/json" } },
              );
            },
          };
        },
      };
    },
  };

  globalThis.__env = {
    LOADER: loader,
    CODE_CACHE: { get: () => Promise.resolve(BUNDLE_CODE) },
    EXECUTED_LOADER_GET_REUSE: "1",
    // deno-lint-ignore no-explicit-any
  } as any;

  globalThis.__ctx = {
    exports: {
      // deno-lint-ignore no-explicit-any
      AppDataBinding: (input: any) => {
        captured.bindingProps.DATA = input?.props;
        return {
          store: () => Promise.resolve(),
          load: () => Promise.resolve(null),
          remove: () => Promise.resolve(),
          list: () => Promise.resolve([]),
        };
      },
      // deno-lint-ignore no-explicit-any
      EventsBinding: (input: any) => {
        captured.bindingProps.EVENTS = input?.props;
        return {
          emit: () =>
            Promise.resolve({ ok: true, event_id: "e", rejected: null }),
        };
      },
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
      if (prevAgentSecret === undefined) Deno.env.delete("AGENT_CALLER_SECRET");
      else Deno.env.set("AGENT_CALLER_SECRET", prevAgentSecret);
    },
  };
}

function baseConfig(): RuntimeConfig {
  return {
    appId: "app_get_reuse",
    userId: "user_a",
    ownerId: "user_a",
    executionId: "exec_get_reuse",
    code: "",
    permissions: ["storage:read"],
    userApiKey: null,
    user: {
      id: "user_a",
      email: "a@test.dev",
      displayName: null,
      tier: "free",
    },
    d1DataService: null,
    memoryService: null,
    envVars: {},
    callerContextToken: CALLER_CTX,
    baseUrl: "https://api.test.dev",
    workerBaseUrl: "https://api.test.dev",
    // Services unused for this path.
  } as unknown as RuntimeConfig;
}

Deno.test("get reuse: flag ON + eligible → loader.get with the derived reuse key; load() not used", async () => {
  const harness = installHarness();
  try {
    const config = baseConfig();
    const result = await executeInDynamicSandbox(
      config,
      "reuseProbeFn__unique",
      [{ marker: "arg-value-77" }],
    );
    assertEquals(result.success, true);
    assertEquals(harness.captured.getCalls, 1);
    assertEquals(harness.captured.loadCalls, 0);
    // The id is exactly the audited derivation (appId:bundleHash:userId:fp).
    const expected = await deriveIsolateReuseKey(config, BUNDLE_CODE, [], {
      dbId: null,
      hasDb: false,
      hasMemory: false,
    });
    assertEquals(harness.captured.getIds[0], expected);
  } finally {
    harness.restore();
  }
});

Deno.test("get reuse: flag OFF (default) → loader.load, get() never called", async () => {
  const harness = installHarness();
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis.__env as any).EXECUTED_LOADER_GET_REUSE = "";
    const result = await executeInDynamicSandbox(baseConfig(), "noop", []);
    assertEquals(result.success, true);
    assertEquals(harness.captured.loadCalls, 1);
    assertEquals(harness.captured.getCalls, 0);
  } finally {
    harness.restore();
  }
});

Deno.test("get reuse: anonymous user stays on load() even with the flag ON", async () => {
  const harness = installHarness();
  try {
    const config = baseConfig();
    config.userId = "00000000-0000-0000-0000-000000000000";
    config.user = null;
    config.callerContextToken = undefined;
    const result = await executeInDynamicSandbox(config, "noop", []);
    assertEquals(result.success, true);
    assertEquals(harness.captured.loadCalls, 1);
    assertEquals(harness.captured.getCalls, 0);
  } finally {
    harness.restore();
  }
});

Deno.test("get reuse: fixture-backed execution (gx.test) stays on load() even with the flag ON", async () => {
  const harness = installHarness();
  try {
    const config = baseConfig();
    // deno-lint-ignore no-explicit-any
    (config as any).d1Fixtures = { tables: {} };
    const result = await executeInDynamicSandbox(config, "noop", []);
    assertEquals(result.success, true);
    assertEquals(harness.captured.loadCalls, 1);
    assertEquals(harness.captured.getCalls, 0);
  } finally {
    harness.restore();
  }
});

Deno.test("get reuse: per-call data rides the fetch body, NOT the baked module content", async () => {
  const harness = installHarness();
  try {
    const config = baseConfig();
    await executeInDynamicSandbox(
      config,
      "reuseProbeFn__unique",
      [{ marker: "arg-value-77" }],
    );

    // Body carries everything per-call.
    const body = harness.captured.requestBodies[0] as {
      execCtxHandle?: string;
      functionName?: string;
      args?: unknown[];
      authToken?: string;
      callerCtx?: string;
    };
    assert(body, "fetch body missing");
    assertEquals(body.functionName, "reuseProbeFn__unique");
    assertEquals(body.args, [{ marker: "arg-value-77" }]);
    assertEquals(body.callerCtx, CALLER_CTX);
    assert(
      typeof body.execCtxHandle === "string" && body.execCtxHandle.length >= 32,
      "execCtxHandle missing from the per-request body",
    );
    assert(typeof body.authToken === "string");

    // The baked content is call-independent: none of the per-call values may
    // appear in ANY module (the precondition for same-key ⟺ same-content).
    const allModules = Object.values(harness.captured.modules).join("\n");
    assert(
      !allModules.includes("reuseProbeFn__unique"),
      "functionName is baked into module content — breaks warm reuse",
    );
    assert(
      !allModules.includes("arg-value-77"),
      "call args are baked into module content — breaks warm reuse",
    );
    assert(
      !allModules.includes(CALLER_CTX),
      "caller-context token is baked into module content — a warm isolate " +
        "would reuse a stale hop",
    );
  } finally {
    harness.restore();
  }
});

Deno.test("get reuse: reusable-isolate bindings are constructed with requireExecCtx (bypass fail-closed)", async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(baseConfig(), "noop", []);
    const dataProps = harness.captured.bindingProps.DATA as {
      requireExecCtx?: boolean;
    };
    const eventsProps = harness.captured.bindingProps.EVENTS as {
      requireExecCtx?: boolean;
    };
    assertEquals(dataProps?.requireExecCtx, true);
    assertEquals(eventsProps?.requireExecCtx, true);
  } finally {
    harness.restore();
  }
});

Deno.test("get reuse: flag OFF keeps requireExecCtx false (today's binding behavior preserved)", async () => {
  const harness = installHarness();
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis.__env as any).EXECUTED_LOADER_GET_REUSE = "";
    await executeInDynamicSandbox(baseConfig(), "noop", []);
    const dataProps = harness.captured.bindingProps.DATA as {
      requireExecCtx?: boolean;
    };
    assertEquals(dataProps?.requireExecCtx, false);
  } finally {
    harness.restore();
  }
});

Deno.test("get reuse: same config → same key across calls; different user → different key", async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(baseConfig(), "fnA", [1]);
    await executeInDynamicSandbox(baseConfig(), "fnB", [2]);
    assertEquals(harness.captured.getCalls, 2);
    // Different function + args, same user/app/code → SAME isolate id. This is
    // the whole point: per-call data no longer forces a fresh load.
    assertEquals(harness.captured.getIds[0], harness.captured.getIds[1]);

    const other = baseConfig();
    other.userId = "user_b";
    // deno-lint-ignore no-explicit-any
    (other as any).user = {
      id: "user_b",
      email: "b@test.dev",
      displayName: null,
      tier: "free",
    };
    await executeInDynamicSandbox(other, "fnA", [1]);
    assertEquals(harness.captured.getCalls, 3);
    assertNotEquals(harness.captured.getIds[2], harness.captured.getIds[0]);
  } finally {
    harness.restore();
  }
});

Deno.test("get reuse: WARM HIT — callback runs once (frozen isolate); per-call body still reaches the second fetch", async () => {
  const harness = installHarness();
  try {
    // Two executions of the SAME (app, user, code) → SAME reuse id. The mock
    // caches by id like the real loader, so the build callback fires only on
    // the first (cold) call; the second is a warm hit against frozen content.
    await executeInDynamicSandbox(baseConfig(), "coldFn", [{ n: 1 }]);
    await executeInDynamicSandbox(baseConfig(), "warmFn", [{ n: 2 }]);

    assertEquals(harness.captured.getCalls, 2); // two get() dispatches
    assertEquals(harness.captured.getIds[0], harness.captured.getIds[1]);
    assertEquals(
      harness.captured.cbInvocations,
      1,
      "the loader build callback must fire ONCE per id (warm hit reuses frozen content)",
    );

    // The frozen module content is call 1's and carries NEITHER call's per-call
    // data (functionName/args ride the body).
    const allModules = Object.values(harness.captured.modules).join("\n");
    assert(!allModules.includes("coldFn"));
    assert(!allModules.includes("warmFn"));

    // Yet the SECOND (warm) fetch still received call 2's body — the frozen
    // isolate reads per-call data fresh each request.
    const secondBody = harness.captured.requestBodies[1] as {
      functionName?: string;
      args?: unknown[];
    };
    assertEquals(secondBody.functionName, "warmFn");
    assertEquals(secondBody.args, [{ n: 2 }]);
  } finally {
    harness.restore();
  }
});
