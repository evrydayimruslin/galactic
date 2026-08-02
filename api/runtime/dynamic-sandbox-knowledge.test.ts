// WO-5 PR B: the KNOWLEDGE binding's wiring contract in the dynamic sandbox.
//
// Capture-only harness (pattern: dynamic-sandbox-compute.test.ts): asserts
// (1) production wiring freezes (appId, userId) host-side, (2) declared
// database authority gates the binding's existence, (3) gx.test mode uses
// ONLY the deterministic Test binding, never the production one.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { executeInDynamicSandbox } from "./dynamic-sandbox.ts";
import type { RuntimeConfig } from "./sandbox.ts";

interface CapturedKnowledgeRuntime {
  setup: string;
  envKeys: string[];
  productionProps: Record<string, unknown> | null;
  productionBindings: number;
  testBindings: number;
  testProps: Record<string, unknown> | null;
}

class KnowledgeTestSession {
  dup(): KnowledgeTestSession {
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
  captured: CapturedKnowledgeRuntime;
  restore(): void;
} {
  const captured: CapturedKnowledgeRuntime = {
    setup: "",
    envKeys: [],
    productionProps: null,
    productionBindings: 0,
    testBindings: 0,
    testProps: null,
  };
  const testSessions = new Map<string, KnowledgeTestSession>();
  const getTestSession = (name: string): KnowledgeTestSession => {
    let session = testSessions.get(name);
    if (!session) {
      session = new KnowledgeTestSession();
      testSessions.set(name, session);
    }
    return session;
  };
  const previousEnv = globalThis.__env;
  const previousCtx = globalThis.__ctx;
  const previousCallerSecret = Deno.env.get("AGENT_CALLER_SECRET");
  Deno.env.set("AGENT_CALLER_SECRET", "knowledge-runtime-test-secret");

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
    AGENT_CALLER_SECRET: "knowledge-runtime-test-secret",
    TRUST_SIGNING_SECRET: "knowledge-runtime-trust-secret",
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
      ComputeBinding: () => ({
        call: () => Promise.resolve({ ok: true, value: {} }),
        get: () => Promise.resolve({ ok: true, value: {} }),
        cancel: () => Promise.resolve({ ok: true, value: {} }),
      }),
      // deno-lint-ignore no-explicit-any
      TestComputeBinding: (input: any) => {
        const sessionName = input?.props?.sessionName;
        if (
          typeof sessionName !== "string" ||
          !testSessions.has(sessionName)
        ) {
          throw new Error("test compute binding received an unknown session");
        }
        return {
          call: () => Promise.resolve({ ok: true, value: {} }),
          get: () => Promise.resolve({ ok: true, value: {} }),
          cancel: () => Promise.resolve({ ok: true, value: {} }),
        };
      },
      // deno-lint-ignore no-explicit-any
      KnowledgeBinding: (input: any) => {
        captured.productionBindings += 1;
        captured.productionProps = input?.props ?? null;
        return {
          ask: () =>
            Promise.resolve({
              questionId: "q",
              deduped: false,
              askCount: 1,
              status: "open",
            }),
          facts: () => Promise.resolve({ facts: [], block: "" }),
        };
      },
      // deno-lint-ignore no-explicit-any
      TestConceptsBinding: (_input: unknown) => ({}),
      TestKnowledgeBinding: (input: any) => {
        captured.testProps = input?.props ?? null;
        const sessionName = input?.props?.sessionName;
        if (
          typeof sessionName !== "string" ||
          !testSessions.has(sessionName)
        ) {
          throw new Error(
            "test knowledge binding received an unknown session",
          );
        }
        captured.testBindings += 1;
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
    appId: "00000000-0000-4000-8000-000000000020",
    userId: "00000000-0000-4000-8000-000000000021",
    ownerId: "00000000-0000-4000-8000-000000000021",
    executionId: "00000000-0000-4000-8000-000000000022",
    code: "",
    permissions: [],
    userApiKey: "provider-key-must-not-enter-knowledge-binding",
    user: {
      id: "00000000-0000-4000-8000-000000000021",
      email: "owner@example.test",
      displayName: null,
      tier: "pro",
    },
    authToken: "ul_human_bearer_must_not_enter_knowledge_binding",
    workerSecret: "platform-worker-secret-must-not-enter-knowledge-binding",
    d1DataService: null,
    memoryService: null,
    envVars: {},
    ...overrides,
    // Services are unused by this capture-only harness.
  } as unknown as RuntimeConfig;
}

Deno.test("dynamic knowledge: production wiring freezes (appId, userId) host-side", async () => {
  const harness = installHarness();
  try {
    // declaredEffects null = manifest-compatibility mode, same posture as
    // the database binding itself.
    const result = await executeInDynamicSandbox(config(), "noop", []);
    assertEquals(result.success, true);
    assert(harness.captured.envKeys.includes("KNOWLEDGE"));
    assertEquals(harness.captured.productionBindings, 1);
    assertEquals(
      harness.captured.productionProps?.appId,
      "00000000-0000-4000-8000-000000000020",
    );
    assertEquals(
      harness.captured.productionProps?.userId,
      "00000000-0000-4000-8000-000000000021",
    );
    // The generated SDK surface exists and speaks the authority language.
    assert(harness.captured.setup.includes("knowledge:"));
    assert(harness.captured.setup.includes("KNOWLEDGE.ask("));
    assert(
      harness.captured.setup.includes(
        "galactic.knowledge.ask requires database.write authority",
      ),
    );
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic knowledge: no declared database authority, no binding", async () => {
  const harness = installHarness();
  try {
    const result = await executeInDynamicSandbox(
      config({ declaredEffects: ["storage.read"] } as Partial<RuntimeConfig>),
      "noop",
      [],
    );
    assertEquals(result.success, true);
    assert(!harness.captured.envKeys.includes("KNOWLEDGE"));
    assertEquals(harness.captured.productionBindings, 0);
    assertEquals(harness.captured.testBindings, 0);
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic knowledge: gx.test mode uses only the deterministic stub", async () => {
  const harness = installHarness();
  try {
    // Binding wiring is the contract under test; the capture harness does
    // not emulate the full gx.test seal flow, so (like the compute test)
    // the execution result itself is not asserted here.
    await executeInDynamicSandbox(
      config({ testMode: true } as Partial<RuntimeConfig>),
      "noop",
      [],
    );
    assertEquals(harness.captured.productionBindings, 0);
    assertEquals(harness.captured.testBindings, 1);
    assert(
      typeof harness.captured.testProps?.sessionName === "string" &&
        harness.captured.testProps.sessionName.startsWith("gx-test-"),
    );
  } finally {
    harness.restore();
  }
});
