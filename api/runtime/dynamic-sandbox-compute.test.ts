import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { executeInDynamicSandbox } from "./dynamic-sandbox.ts";
import type { RuntimeConfig } from "./sandbox.ts";

interface CapturedComputeRuntime {
  setup: string;
  envKeys: string[];
  productionProps: Record<string, unknown> | null;
  productionBindings: number;
  testBindings: number;
  testProps: Record<string, unknown> | null;
}

class ComputeTestSession {
  dup(): ComputeTestSession {
    return this;
  }

  sealAndSnapshot(): Promise<{ blockedEffects: string[] }> {
    return Promise.resolve({ blockedEffects: [] });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  [Symbol.dispose](): void {
    // Local harness owns no remote capability graph.
  }
}

function installHarness(): {
  captured: CapturedComputeRuntime;
  restore(): void;
} {
  const captured: CapturedComputeRuntime = {
    setup: "",
    envKeys: [],
    productionProps: null,
    productionBindings: 0,
    testBindings: 0,
    testProps: null,
  };
  const testSessions = new Map<string, ComputeTestSession>();
  const getTestSession = (name: string): ComputeTestSession => {
    let session = testSessions.get(name);
    if (!session) {
      session = new ComputeTestSession();
      testSessions.set(name, session);
    }
    return session;
  };
  const previousEnv = globalThis.__env;
  const previousCtx = globalThis.__ctx;
  const previousCallerSecret = Deno.env.get("AGENT_CALLER_SECRET");
  Deno.env.set("AGENT_CALLER_SECRET", "compute-runtime-test-secret");

  const loader = {
    // deno-lint-ignore no-explicit-any
    load(config: any) {
      captured.setup = config?.modules?.["setup.js"] ?? "";
      captured.envKeys = Object.keys(config?.env ?? {});
      return {
        getEntrypoint() {
          return {
            fetch: () =>
              Promise.resolve(Response.json({
                success: true,
                result: "ok",
                logs: [],
                aiCostLight: 0,
              })),
          };
        },
      };
    },
  };

  globalThis.__env = {
    LOADER: loader,
    GX_TEST_SESSION: {
      getByName: (name: string) => getTestSession(name),
    },
    CODE_CACHE: {
      get: () => Promise.resolve("export const noop = 1;"),
    },
    AGENT_CALLER_SECRET: "compute-runtime-test-secret",
    TRUST_SIGNING_SECRET: "compute-runtime-trust-secret",
    // deno-lint-ignore no-explicit-any
  } as any;
  globalThis.__ctx = {
    exports: {
      FixtureDatabaseBinding: () => ({}),
      TestOutboundBinding: () => ({
        fetch: () => Promise.reject(new Error("gx.test outbound blocked")),
        connect: () => Promise.reject(new Error("gx.test connect blocked")),
      }),
      TestCredentialBinding: () => ({
        authenticatedFetch: () =>
          Promise.reject(new Error("gx.test credentials blocked")),
      }),
      TestEventsBinding: () => ({
        emit: () => Promise.reject(new Error("gx.test event blocked")),
      }),
      TestAppDataBinding: () => ({
        store: () => Promise.resolve(),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(),
        list: () => Promise.resolve([]),
      }),
      TestMemoryBinding: () => ({
        remember: () => Promise.resolve(),
        recall: () => Promise.resolve(null),
      }),
      TestRunsBinding: () => ({
        recent: () => Promise.resolve({ runs: [] }),
      }),
      // deno-lint-ignore no-explicit-any
      TestKnowledgeBinding: (input: any) => {
        const sessionName = input?.props?.sessionName;
        if (
          typeof sessionName !== "string" || !testSessions.has(sessionName)
        ) {
          throw new Error(
            "test knowledge binding received an unknown session",
          );
        }
        return {
          ask: () =>
            Promise.resolve({
              questionId: "ul-test-knowledge-question",
              deduped: false,
              askCount: 1,
              status: "open",
            }),
          facts: () => Promise.resolve({ facts: [], block: "" }),
        };
      },
      TestNotifyBinding: () => ({
        notifyOwner: () => Promise.resolve({ created: false }),
      }),
      TestAIBinding: () => ({
        call: () => Promise.resolve({ content: "" }),
      }),
      TestEmbedBinding: () => ({
        embed: () => Promise.resolve({ embedding: [], usage: {} }),
      }),
      TestNetworkBinding: () => ({
        imapFetchUnseen: () =>
          Promise.reject(new Error("gx.test IMAP blocked")),
        smtpSend: () => Promise.reject(new Error("gx.test SMTP blocked")),
      }),
      TestAppCallBinding: () => ({
        fetch: () => Promise.reject(new Error("gx.test Agent call blocked")),
      }),
      // deno-lint-ignore no-explicit-any
      ComputeBinding: (input: any) => {
        captured.productionBindings += 1;
        captured.productionProps = input?.props ?? null;
        return {
          call: () => Promise.resolve({ ok: true, value: {} }),
          get: () => Promise.resolve({ ok: true, value: {} }),
          cancel: () => Promise.resolve({ ok: true, value: {} }),
        };
      },
      // deno-lint-ignore no-explicit-any
      TestComputeBinding: (input: any) => {
        captured.testProps = input?.props ?? null;
        const sessionName = input?.props?.sessionName;
        if (
          typeof sessionName !== "string" ||
          !testSessions.has(sessionName)
        ) {
          throw new Error("test compute binding received an unknown session");
        }
        captured.testBindings += 1;
        return {
          call: () => Promise.resolve({ ok: true, value: {} }),
          get: () => Promise.resolve({ ok: true, value: {} }),
          cancel: () => Promise.resolve({ ok: true, value: {} }),
        };
      },
    },
    waitUntil: (promise: Promise<unknown>) => promise.catch(() => {}),
    // deno-lint-ignore no-explicit-any
  } as any;

  return {
    captured,
    restore() {
      globalThis.__env = previousEnv;
      globalThis.__ctx = previousCtx;
      if (previousCallerSecret === undefined) {
        Deno.env.delete("AGENT_CALLER_SECRET");
      } else {
        Deno.env.set("AGENT_CALLER_SECRET", previousCallerSecret);
      }
    },
  };
}

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    appId: "00000000-0000-4000-8000-000000000010",
    userId: "00000000-0000-4000-8000-000000000011",
    ownerId: "00000000-0000-4000-8000-000000000011",
    executionId: "00000000-0000-4000-8000-000000000012",
    code: "",
    permissions: ["compute:exec"],
    userApiKey: "provider-key-must-not-enter-compute-binding",
    user: {
      id: "00000000-0000-4000-8000-000000000011",
      email: "owner@example.test",
      displayName: null,
      tier: "pro",
    },
    authToken: "ul_human_bearer_must_not_enter_compute_binding",
    workerSecret: "platform-worker-secret-must-not-enter-compute-binding",
    d1DataService: null,
    memoryService: null,
    envVars: {},
    ...overrides,
    // Services are unused by this capture-only harness.
  } as unknown as RuntimeConfig;
}

Deno.test("dynamic compute: callable SDK plus get/cancel use only the host RPC binding", async () => {
  const harness = installHarness();
  try {
    const result = await executeInDynamicSandbox(config(), "noop", []);
    assertEquals(result.success, true);
    assert(harness.captured.envKeys.includes("COMPUTE"));
    assertEquals(harness.captured.productionBindings, 1);
    assertEquals(
      harness.captured.productionProps?.userId,
      "00000000-0000-4000-8000-000000000011",
    );
    assertEquals(
      harness.captured.productionProps?.agentId,
      "00000000-0000-4000-8000-000000000010",
    );
    assertEquals(harness.captured.productionProps?.callerFunction, "noop");
    assertEquals(
      harness.captured.productionProps?.executionId,
      "00000000-0000-4000-8000-000000000012",
    );
    assertEquals(harness.captured.productionProps?.billingMode, "wallet");
    assertEquals(
      harness.captured.productionProps?.capacityAgentId,
      "00000000-0000-4000-8000-000000000010",
    );
    assertEquals(harness.captured.productionProps?.capacityReceiptId, null);
    assert(
      typeof harness.captured.productionProps?.executionDeadlineAtMs ===
          "number" &&
        harness.captured.productionProps.executionDeadlineAtMs > Date.now(),
    );

    const setup = harness.captured.setup;
    assert(setup.includes("compute: __galacticCompute"));
    assert(
      setup.includes(
        "e.COMPUTE.call(request || {}, globalThis.__computeCallIndex).then(__unwrapComputeRpc)",
      ),
    );
    assert(setup.includes("e.COMPUTE.get(runId).then(__unwrapComputeRpc)"));
    assert(setup.includes("e.COMPUTE.cancel(runId).then(__unwrapComputeRpc)"));
    assertEquals(
      setup.includes("e.COMPUTE.call(request || {}, globalThis.__execHandle"),
      false,
    );
    assertEquals(
      setup.includes("e.COMPUTE.get(runId, globalThis.__execHandle)"),
      false,
    );
    assertEquals(setup.includes("ul_human_bearer_must_not_enter"), false);
    assertEquals(
      setup.includes("platform-worker-secret-must-not-enter"),
      false,
    );
    assertEquals(setup.includes("provider-key-must-not-enter"), false);
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic compute: unauthenticated execution receives no production binding", async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(config({ user: null }), "noop", []);
    assertEquals(harness.captured.envKeys.includes("COMPUTE"), false);
    assertEquals(harness.captured.productionBindings, 0);
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic compute: subscription receipt stays in trusted parent props", async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(
      config({
        capacityReceiptId: "00000000-0000-4000-8000-000000000013",
        capacityAgentId: "00000000-0000-4000-8000-000000000014",
      }),
      "noop",
      [],
    );
    assertEquals(
      harness.captured.productionProps?.billingMode,
      "subscription_capacity",
    );
    assertEquals(
      harness.captured.productionProps?.capacityAgentId,
      "00000000-0000-4000-8000-000000000014",
    );
    assertEquals(
      harness.captured.productionProps?.capacityReceiptId,
      "00000000-0000-4000-8000-000000000013",
    );
    const serialized = JSON.stringify(harness.captured.productionProps);
    assertEquals(serialized.includes("provider-key"), false);
    assertEquals(serialized.includes("human_bearer"), false);
    assertEquals(serialized.includes("platform-worker-secret"), false);
    assertEquals(
      harness.captured.setup.includes(
        "00000000-0000-4000-8000-000000000013",
      ),
      false,
    );
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic compute: missing compute:exec permission receives no binding", async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(config({ permissions: [] }), "noop", []);
    assertEquals(harness.captured.envKeys.includes("COMPUTE"), false);
    assertEquals(harness.captured.productionBindings, 0);
    assertEquals(harness.captured.testBindings, 0);
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic compute: gx.test uses a no-side-effect binding", async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(config({ testMode: true }), "noop", []);
    assert(harness.captured.envKeys.includes("COMPUTE"));
    assertEquals(harness.captured.productionBindings, 0);
    assertEquals(harness.captured.testBindings, 1);
    assert(
      typeof harness.captured.testProps?.sessionName === "string" &&
        harness.captured.testProps.sessionName.startsWith("gx-test-"),
    );
    assertEquals("session" in (harness.captured.testProps ?? {}), false);
  } finally {
    harness.restore();
  }
});
