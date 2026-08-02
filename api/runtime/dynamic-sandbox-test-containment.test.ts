import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { executeInDynamicSandbox } from "./dynamic-sandbox.ts";
import type { RuntimeConfig } from "./sandbox.ts";
import { assertBindingEffectAuthority } from "../src/bindings/function-authority.ts";
import { TestRuntimeStateStore } from "../services/test-state-store.ts";
import {
  blockUlTestEffect,
  UL_TEST_BLOCKED_EFFECTS,
  UL_TEST_OBSERVED_EFFECTS,
  type UlTestObservedEffect,
} from "../services/ul-test-runtime.ts";

const CREDENTIAL_SECRET = "credential-secret-must-never-enter-test-bindings";
const REAL_SELF = { tag: "production-self", fetch: () => Promise.reject() };
const HTTP_FIXTURES: NonNullable<RuntimeConfig["httpFixtures"]> = [
  {
    id: "raw-health",
    kind: "raw",
    request: {
      method: "GET",
      url: "https://api.example.test/health",
    },
    response: {
      status: 200,
      headers: {},
      body_text: "ok",
    },
  },
  {
    id: "credential-profile",
    kind: "credential",
    credential_key: "API_TOKEN",
    request: {
      method: "GET",
      url: "https://api.example.test/profile",
    },
    response: {
      status: 200,
      headers: {},
      body_text: "{}",
    },
  },
];

Deno.test("function authority parent binding gate fails before an undeclared effect", () => {
  for (
    const effect of [
      "storage.read",
      "storage.write",
      "storage.delete",
      "database.read",
      "database.write",
      "memory.read",
      "memory.write",
      "network.http",
      "email.imap.read",
      "email.smtp.send",
    ]
  ) {
    assertThrows(
      () => assertBindingEffectAuthority(false, effect),
      Error,
      `${effect} authority not granted for this function.`,
    );
  }
});

Deno.test("function authority parent binding gate preserves legacy and explicit grants", () => {
  assertEquals(
    assertBindingEffectAuthority(undefined, "storage.read"),
    undefined,
  );
  assertEquals(assertBindingEffectAuthority(true, "storage.read"), undefined);
});

type HarnessMode =
  | "success"
  | "developer_error"
  | "caught_blocked_outbound"
  | "caught_blocked_connect"
  | "blocked_then_hang"
  | "hang"
  | "throw_load";

class LocalTestRuntimeSession {
  readonly state = new TestRuntimeStateStore();
  closeCalls = 0;
  disposeCalls = 0;
  sealed = false;

  dup(): LocalTestRuntimeSession {
    return this;
  }

  storeAppData(key: string, value: unknown): Promise<void> {
    this.state.storeAppData(key, value);
    return Promise.resolve();
  }

  loadAppData(key: string): Promise<unknown> {
    return Promise.resolve(this.state.loadAppData(key));
  }

  removeAppData(key: string): Promise<void> {
    this.state.removeAppData(key);
    return Promise.resolve();
  }

  listAppData(prefix?: string): Promise<string[]> {
    return Promise.resolve(this.state.listAppData(prefix));
  }

  rememberMemory(
    scope: "agent" | "user",
    key: string,
    value: unknown,
  ): Promise<void> {
    this.state.rememberMemory(scope, key, value);
    return Promise.resolve();
  }

  recallMemory(scope: "agent" | "user", key: string): Promise<unknown> {
    return Promise.resolve(this.state.recallMemory(scope, key));
  }

  recordBlockedEffect(
    effect: typeof UL_TEST_BLOCKED_EFFECTS[
      keyof typeof UL_TEST_BLOCKED_EFFECTS
    ],
  ): Promise<void> {
    this.state.recordBlockedEffect(effect);
    return Promise.resolve();
  }

  recordObservedEffect(effect: UlTestObservedEffect): Promise<void> {
    this.state.recordObservedEffect(effect);
    return Promise.resolve();
  }

  sealAndSnapshot(): Promise<{
    blockedEffects: string[];
    observedEffects: string[];
  }> {
    this.sealed = true;
    return Promise.resolve({
      blockedEffects: this.state.blockedEffects(),
      observedEffects: this.state.observedEffects(),
    });
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.state.close();
    return Promise.resolve();
  }

  [Symbol.dispose](): void {
    this.disposeCalls += 1;
  }
}

interface CapturedContainment {
  constructors: Record<string, number>;
  bindingProps: Record<string, unknown>;
  env: Record<string, unknown>;
  globalOutbound: unknown;
  modules: Record<string, string>;
  tails: unknown[];
  requestBodies: Array<Record<string, unknown>>;
  requestHeaders: Array<Record<string, string>>;
  sessionNames: string[];
  sessions: LocalTestRuntimeSession[];
  loadCalls: number;
}

function installContainmentHarness(options: {
  includeTestExports: boolean;
  mode?: HarnessMode;
}): { captured: CapturedContainment; restore(): void } {
  const mode = options.mode ?? "success";
  const captured: CapturedContainment = {
    constructors: {},
    bindingProps: {},
    env: {},
    globalOutbound: null,
    modules: {},
    tails: [],
    requestBodies: [],
    requestHeaders: [],
    sessionNames: [],
    sessions: [],
    loadCalls: 0,
  };
  const sessionsByName = new Map<string, LocalTestRuntimeSession>();
  const previousEnv = globalThis.__env;
  const previousCtx = globalThis.__ctx;
  const previousCallerSecret = Deno.env.get("AGENT_CALLER_SECRET");
  Deno.env.set("AGENT_CALLER_SECRET", "containment-caller-secret");

  const count = (name: string, props: unknown, value: unknown): unknown => {
    captured.constructors[name] = (captured.constructors[name] ?? 0) + 1;
    captured.bindingProps[name] = props;
    return value;
  };
  const getTestSession = (name: string): LocalTestRuntimeSession => {
    let session = sessionsByName.get(name);
    if (!session) {
      session = new LocalTestRuntimeSession();
      sessionsByName.set(name, session);
      captured.sessionNames.push(name);
      captured.sessions.push(session);
    }
    return session;
  };
  const resolveTestSession = (
    props: { sessionName?: unknown } | null | undefined,
  ): LocalTestRuntimeSession => {
    const sessionName = props?.sessionName;
    if (typeof sessionName !== "string") {
      throw new Error("test binding did not receive a session name");
    }
    const session = sessionsByName.get(sessionName);
    if (!session) {
      throw new Error(`unknown gx.test session: ${sessionName}`);
    }
    return session;
  };
  const productionBinding = (name: string) =>
  // deno-lint-ignore no-explicit-any
  (input: any) =>
    count(name, input?.props, {
      tag: `production-${name}`,
      store: () => Promise.resolve(),
      load: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      recent: () => Promise.resolve([]),
      call: () => Promise.resolve({}),
      embed: () => Promise.resolve({}),
      notifyOwner: () => Promise.resolve({}),
      authenticatedFetch: () => Promise.resolve(new Response("production")),
      imapFetchUnseen: () => Promise.resolve({ emails: [] }),
      smtpSend: () => Promise.resolve({ success: true }),
      emit: () => Promise.resolve({ ok: true }),
      fetch: () => Promise.resolve(new Response("production")),
    });
  const testBinding = (name: string) =>
  // deno-lint-ignore no-explicit-any
  (input: any) => {
    resolveTestSession(input?.props);
    return count(name, input?.props, {
      tag: `test-${name}`,
      store: () => Promise.resolve(),
      load: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      recent: () => Promise.resolve([]),
      call: () => Promise.resolve({}),
      get: () => Promise.resolve({}),
      cancel: () => Promise.resolve({}),
      embed: () => Promise.resolve({}),
      notifyOwner: () => Promise.resolve({}),
      authenticatedFetch: () => Promise.reject(new Error("blocked")),
      imapFetchUnseen: () => Promise.reject(new Error("blocked")),
      smtpSend: () => Promise.reject(new Error("blocked")),
      emit: () => Promise.reject(new Error("blocked")),
      fetch: () => Promise.reject(new Error("blocked")),
    });
  };

  const testOutboundBinding =
    // deno-lint-ignore no-explicit-any
    (input: any) => {
      const session = resolveTestSession(input?.props);
      return count("TestOutboundBinding", input?.props, {
        tag: "test-TestOutboundBinding",
        fetch: () =>
          blockUlTestEffect(
            session,
            UL_TEST_BLOCKED_EFFECTS.outboundHttp,
          ),
        connect: () =>
          blockUlTestEffect(
            session,
            UL_TEST_BLOCKED_EFFECTS.outboundTcp,
          ),
      });
    };

  const loader = {
    // deno-lint-ignore no-explicit-any
    load(config: any) {
      captured.loadCalls += 1;
      captured.env = config?.env ?? {};
      captured.globalOutbound = config?.globalOutbound ?? null;
      captured.modules = config?.modules ?? {};
      captured.tails = config?.tails ?? [];
      if (mode === "throw_load") throw new Error("loader failed");
      return {
        getEntrypoint() {
          return {
            async fetch(
              request: Request,
              options?: { signal?: AbortSignal },
            ) {
              captured.requestHeaders.push(Object.fromEntries(request.headers));
              const body = await request.json() as Record<string, unknown>;
              captured.requestBodies.push(body);
              if (mode === "blocked_then_hang") {
                const outbound = captured.globalOutbound as {
                  fetch(request: Request): Promise<Response>;
                };
                try {
                  await outbound.fetch(
                    new Request("https://should-never-resolve.example.test"),
                  );
                } catch {
                  // The later abort must not erase the host-side blocked-effect
                  // latch recorded by this failed request.
                }
              }
              if (mode === "hang" || mode === "blocked_then_hang") {
                await captured.sessions[0]?.recordObservedEffect(
                  UL_TEST_OBSERVED_EFFECTS.inferenceGenerate,
                );
                await new Promise<never>((_resolve, reject) => {
                  const signal = options?.signal;
                  const abort = () =>
                    reject(new DOMException("Aborted", "AbortError"));
                  if (signal?.aborted) {
                    abort();
                  } else {
                    signal?.addEventListener("abort", abort, { once: true });
                  }
                });
              }
              if (mode === "caught_blocked_outbound") {
                const outbound = captured.globalOutbound as {
                  fetch(request: Request): Promise<Response>;
                };
                try {
                  await outbound.fetch(
                    new Request("https://should-never-resolve.example.test"),
                  );
                } catch {
                  // Tenant code can catch a binding error. The host latch must
                  // still make the overall execution fail.
                }
              }
              if (mode === "caught_blocked_connect") {
                const outbound = captured.globalOutbound as {
                  connect(socket: unknown): Promise<void>;
                };
                try {
                  await outbound.connect({});
                } catch {
                  // A missing/blocked TCP fixture remains disqualifying even
                  // when tenant code handles the SDK error.
                }
              }
              return Response.json(
                mode === "developer_error"
                  ? {
                    success: false,
                    result: null,
                    logs: [],
                    aiCostLight: 0,
                    error: {
                      type: "DeveloperError",
                      message: "intentional developer error",
                    },
                  }
                  : {
                    success: true,
                    result: "ok",
                    logs: [],
                    aiCostLight: 0,
                  },
              );
            },
          };
        },
      };
    },
    get() {
      throw new Error("gx.test must never use loader.get");
    },
  };

  const productionExports = {
    DatabaseBinding: productionBinding("DatabaseBinding"),
    AppDataBinding: productionBinding("AppDataBinding"),
    MemoryBinding: productionBinding("MemoryBinding"),
    RunsBinding: productionBinding("RunsBinding"),
    AIBinding: productionBinding("AIBinding"),
    EmbedBinding: productionBinding("EmbedBinding"),
    NotifyBinding: productionBinding("NotifyBinding"),
    ComputeBinding: productionBinding("ComputeBinding"),
    NetworkBinding: productionBinding("NetworkBinding"),
    EventsBinding: productionBinding("EventsBinding"),
    OutboundBinding: productionBinding("OutboundBinding"),
    CredentialBinding: productionBinding("CredentialBinding"),
    CapacityDynamicTail: productionBinding("CapacityDynamicTail"),
  };
  const testExports = options.includeTestExports
    ? {
      FixtureDatabaseBinding: testBinding("FixtureDatabaseBinding"),
      TestAppDataBinding: testBinding("TestAppDataBinding"),
      TestMemoryBinding: testBinding("TestMemoryBinding"),
      TestRunsBinding: testBinding("TestRunsBinding"),
      TestKnowledgeBinding: testBinding("TestKnowledgeBinding"),
      TestAIBinding: testBinding("TestAIBinding"),
      TestEmbedBinding: testBinding("TestEmbedBinding"),
      TestNotifyBinding: testBinding("TestNotifyBinding"),
      TestComputeBinding: testBinding("TestComputeBinding"),
      TestNetworkBinding: testBinding("TestNetworkBinding"),
      TestEventsBinding: testBinding("TestEventsBinding"),
      TestCredentialBinding: testBinding("TestCredentialBinding"),
      TestAppCallBinding: testBinding("TestAppCallBinding"),
      TestOutboundBinding: testOutboundBinding,
    }
    : {};

  globalThis.__env = {
    LOADER: loader,
    GX_TEST_SESSION: {
      getByName: (name: string) => getTestSession(name),
    },
    SELF: REAL_SELF,
    CODE_CACHE: {
      get: () => Promise.resolve("export const noop = 1;"),
    },
    EXECUTED_LOADER_GET_REUSE: "1",
    AGENT_CALLER_SECRET: "containment-caller-secret",
    TRUST_SIGNING_SECRET: "containment-trust-secret",
    // deno-lint-ignore no-explicit-any
  } as any;
  globalThis.__ctx = {
    exports: { ...productionExports, ...testExports },
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

function maximalConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    appId: "00000000-0000-4000-8000-000000000101",
    userId: "00000000-0000-4000-8000-000000000102",
    ownerId: "00000000-0000-4000-8000-000000000102",
    executionId: crypto.randomUUID(),
    code: "",
    permissions: [
      "storage:read",
      "storage:write",
      "storage:delete",
      "memory:read",
      "memory:write",
      "net:connect",
      "net:fetch",
      "app:call",
      "notify:owner",
      "ai:call",
      "ai:embed",
      "compute:exec",
    ],
    testMode: true,
    flightRecorder: true,
    allowedDestinations: ["api.example.test"],
    credentials: {
      API_TOKEN: {
        value: CREDENTIAL_SECRET,
        credential: {
          destination: "api.example.test",
          inject: { as: "bearer" },
        },
      },
    },
    userApiKey: "provider-key-must-not-enter-test-bindings",
    user: {
      id: "00000000-0000-4000-8000-000000000102",
      email: "owner@example.test",
      displayName: null,
      tier: "pro",
    },
    authToken: "human-bearer-must-not-enter-test-bindings",
    callerContextToken: "real-caller-token-must-not-enter-test-bindings",
    baseUrl: "https://api.connectgalactic.com",
    workerBaseUrl: "https://worker.connectgalactic.com",
    appCallDependencies: [{
      app: "00000000-0000-4000-8000-000000000103",
      functions: ["run"],
    }],
    // Deliberately truthy: test mode must not provision or bind live D1/memory.
    d1DataService: {} as RuntimeConfig["d1DataService"],
    d1Fixtures: { responses: [] },
    httpFixtures: HTTP_FIXTURES,
    testCredentialDestinations: {
      API_TOKEN: "api.example.test",
    },
    memoryService: {
      remember: () => Promise.resolve(),
      recall: () => Promise.resolve("live-memory"),
    },
    appDataService: {
      store: () => Promise.resolve(),
      load: () => Promise.resolve("live-data"),
      remove: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      query: () => Promise.resolve([]),
      batchStore: () => Promise.resolve(),
      batchLoad: () => Promise.resolve([]),
      batchRemove: () => Promise.resolve(),
    },
    aiService: {
      call: () => Promise.reject(new Error("production AI called")),
    },
    envVars: {},
    capacityReceiptId: "00000000-0000-4000-8000-000000000104",
    capacityAgentId: "00000000-0000-4000-8000-000000000101",
    ...overrides,
  } as RuntimeConfig;
}

const PRODUCTION_CONSTRUCTORS = [
  "DatabaseBinding",
  "AppDataBinding",
  "MemoryBinding",
  "RunsBinding",
  "AIBinding",
  "EmbedBinding",
  "NotifyBinding",
  "ComputeBinding",
  "NetworkBinding",
  "EventsBinding",
  "OutboundBinding",
  "CredentialBinding",
] as const;

Deno.test("gx.test maximal authority installs only test bindings", async () => {
  const harness = installContainmentHarness({ includeTestExports: true });
  try {
    let capacityDebits = 0;
    const config = maximalConfig({
      // Recorder-backed gx.test capabilities stay visible even when this exact
      // function declares nothing, so undeclared attempts become evidence.
      declaredEffects: [],
      cloudOperationMetering: {
        capacityMeter: {
          addLight: () => {
            capacityDebits += 1;
          },
        },
      } as unknown as RuntimeConfig["cloudOperationMetering"],
    });
    const result = await executeInDynamicSandbox(config, "noop", []);
    assertEquals(result.success, true);

    for (const name of PRODUCTION_CONSTRUCTORS) {
      assertEquals(
        harness.captured.constructors[name] ?? 0,
        0,
        `${name} must not be constructed in gx.test`,
      );
    }
    for (
      const name of [
        "FixtureDatabaseBinding",
        "TestAppDataBinding",
        "TestMemoryBinding",
        "TestRunsBinding",
        "TestKnowledgeBinding",
        "TestAIBinding",
        "TestEmbedBinding",
        "TestNotifyBinding",
        "TestComputeBinding",
        "TestNetworkBinding",
        "TestEventsBinding",
        "TestCredentialBinding",
        "TestAppCallBinding",
        "TestOutboundBinding",
      ]
    ) {
      assertEquals(
        harness.captured.constructors[name],
        1,
        `${name} must be selected in gx.test`,
      );
    }
    assertEquals(
      (harness.captured.env.SELF as { tag?: string })?.tag,
      "test-TestAppCallBinding",
    );
    assertEquals(
      (harness.captured.globalOutbound as { tag?: string })?.tag,
      "test-TestOutboundBinding",
    );
    assertEquals(harness.captured.tails, []);
    assertEquals(
      (harness.captured.bindingProps["TestOutboundBinding"] as {
        fixtures?: unknown;
      }).fixtures,
      HTTP_FIXTURES,
    );
    assertEquals(
      (harness.captured.bindingProps["TestCredentialBinding"] as {
        fixtures?: unknown;
        credentialDestinations?: unknown;
      }).fixtures,
      HTTP_FIXTURES,
    );
    assertEquals(
      (harness.captured.bindingProps["TestCredentialBinding"] as {
        credentialDestinations?: unknown;
      }).credentialDestinations,
      { API_TOKEN: "api.example.test" },
    );

    const serializedProps = JSON.stringify(harness.captured.bindingProps);
    assertEquals(serializedProps.includes(CREDENTIAL_SECRET), false);
    assertEquals(
      serializedProps.includes("provider-key-must-not-enter"),
      false,
    );
    assertEquals(
      serializedProps.includes("human-bearer-must-not-enter"),
      false,
    );
    assertEquals(
      serializedProps.includes("real-caller-token-must-not-enter"),
      false,
    );

    const body = harness.captured.requestBodies[0];
    assertEquals(body.authToken, "gx-test-blocked-app-call");
    assertEquals(body.callerCtx, "");
    assertEquals(body.execCtxHandle, null);
    assertEquals(capacityDebits, 0);
    assertEquals(
      harness.captured.requestHeaders[0]["x-galactic-capacity-receipt"],
      undefined,
    );
    assertEquals(harness.captured.sessions.length, 1);
    const sessionName = harness.captured.sessionNames[0];
    assert(sessionName?.startsWith("gx-test-"));
    for (
      const name of [
        "FixtureDatabaseBinding",
        "TestAppDataBinding",
        "TestMemoryBinding",
        "TestRunsBinding",
        "TestKnowledgeBinding",
        "TestAIBinding",
        "TestEmbedBinding",
        "TestNotifyBinding",
        "TestComputeBinding",
        "TestNetworkBinding",
        "TestEventsBinding",
        "TestCredentialBinding",
        "TestAppCallBinding",
        "TestOutboundBinding",
      ]
    ) {
      const props = harness.captured.bindingProps[name] as {
        sessionName?: unknown;
        session?: unknown;
      };
      assertEquals(
        props.sessionName,
        sessionName,
        `${name} must share the invocation-owned session name`,
      );
      assertEquals(
        "session" in props,
        false,
        `${name} must not receive a nested session capability`,
      );
    }
    assertEquals(result.observedEffects, []);
    assertEquals(harness.captured.sessions[0].sealed, true);
    assertEquals(harness.captured.sessions[0].closeCalls, 1);
    assertEquals(harness.captured.sessions[0].disposeCalls, 0);
  } finally {
    harness.restore();
  }
});

Deno.test("gx.test installs an empty D1 fixture recorder when no fixtures were declared", async () => {
  const harness = installContainmentHarness({ includeTestExports: true });
  try {
    const result = await executeInDynamicSandbox(
      maximalConfig({ d1Fixtures: null }),
      "noop",
      [],
    );
    assertEquals(result.success, true);
    assertEquals(
      (harness.captured.bindingProps["FixtureDatabaseBinding"] as {
        fixtures?: unknown;
      }).fixtures,
      { responses: [] },
    );
  } finally {
    harness.restore();
  }
});

Deno.test("gx.test never falls back when test binding exports are missing", async () => {
  const harness = installContainmentHarness({ includeTestExports: false });
  try {
    const result = await executeInDynamicSandbox(
      maximalConfig(),
      "noop",
      [],
    );
    assertEquals(result.success, false);
    for (const name of PRODUCTION_CONSTRUCTORS) {
      assertEquals(harness.captured.constructors[name] ?? 0, 0);
    }
    assertEquals(harness.captured.loadCalls, 0);
    assertEquals(Object.keys(harness.captured.env), []);
    assertEquals(harness.captured.globalOutbound, null);
    assertEquals(harness.captured.tails, []);
  } finally {
    harness.restore();
  }
});

Deno.test("production mode activates the containment harness tripwires", async () => {
  const harness = installContainmentHarness({ includeTestExports: true });
  try {
    const config = maximalConfig({
      testMode: false,
      // Avoid the live D1 lookup in this constructor-selection negative control.
      d1DataService: null,
    });
    const result = await executeInDynamicSandbox(config, "noop", []);
    assertEquals(result.success, true);
    for (
      const name of [
        "AppDataBinding",
        "MemoryBinding",
        "RunsBinding",
        "AIBinding",
        "EmbedBinding",
        "NotifyBinding",
        "ComputeBinding",
        "NetworkBinding",
        "EventsBinding",
        "OutboundBinding",
        "CredentialBinding",
        "CapacityDynamicTail",
      ]
    ) {
      assertEquals(
        harness.captured.constructors[name],
        1,
        `${name} tripwire was not activated`,
      );
    }
    assertEquals(harness.captured.env.SELF, REAL_SELF);
    assertEquals(
      (harness.captured.globalOutbound as { tag?: string })?.tag,
      "production-OutboundBinding",
    );
    assertEquals(harness.captured.tails.length, 1);
  } finally {
    harness.restore();
  }
});

Deno.test("production function authority removes every undeclared effect binding", async () => {
  const harness = installContainmentHarness({ includeTestExports: true });
  try {
    const result = await executeInDynamicSandbox(
      maximalConfig({
        testMode: false,
        declaredEffects: [],
        capacityReceiptId: undefined,
        d1DataService: null,
      }),
      "noop",
      [],
    );
    assertEquals(result.success, true);
    for (const name of PRODUCTION_CONSTRUCTORS) {
      assertEquals(
        harness.captured.constructors[name] ?? 0,
        0,
        `${name} must not be exposed without a declared function effect`,
      );
    }
    assertEquals(Object.keys(harness.captured.env), []);
    assertEquals(harness.captured.globalOutbound, null);
    const setup = harness.captured.modules["setup.js"];
    assert(setup.includes("select: __denied('database.read')"));
    assert(setup.includes("insert: __denied('database.write')"));
  } finally {
    harness.restore();
  }
});

Deno.test("production function authority selects dedicated non-permission bindings exactly", async () => {
  const harness = installContainmentHarness({ includeTestExports: true });
  try {
    const result = await executeInDynamicSandbox(
      maximalConfig({
        testMode: false,
        declaredEffects: [
          "routine.read",
          "event.publish",
          "credential.http",
          "email.smtp.send",
        ],
        capacityReceiptId: undefined,
        d1DataService: null,
      }),
      "noop",
      [],
    );
    assertEquals(result.success, true);
    assertEquals(Object.keys(harness.captured.env).sort(), [
      "CREDENTIALS",
      "EVENTS",
      "NET",
      "RUNS",
    ]);
    assertEquals(harness.captured.globalOutbound, null);
    assertEquals(harness.captured.env.SELF, undefined);
    assertEquals(
      harness.captured.constructors["CredentialBinding"],
      1,
    );
    assertEquals(harness.captured.constructors["NetworkBinding"], 1);
    assertEquals(harness.captured.constructors["EventsBinding"], 1);
    assertEquals(harness.captured.constructors["RunsBinding"], 1);
    assertEquals(harness.captured.bindingProps["NetworkBinding"], {
      userId: "00000000-0000-4000-8000-000000000102",
      appId: "00000000-0000-4000-8000-000000000101",
      allowImap: false,
      allowSmtp: true,
      strictCredentialRoles: true,
      allowedDestinations: ["api.example.test"],
      credentials: maximalConfig().credentials,
    });
    const setup = harness.captured.modules["setup.js"];
    assert(setup.includes("if (!false) throw new Error('email.imap.read"));
    assert(setup.includes("if (!true) throw new Error('email.smtp.send"));
  } finally {
    harness.restore();
  }
});

Deno.test("production raw outbound requires the exact network effect", async () => {
  const harness = installContainmentHarness({ includeTestExports: true });
  try {
    await executeInDynamicSandbox(
      maximalConfig({
        testMode: false,
        declaredEffects: ["network.http"],
        capacityReceiptId: undefined,
        d1DataService: null,
      }),
      "noop",
      [],
    );
    assertEquals(
      (harness.captured.globalOutbound as { tag?: string })?.tag,
      "production-OutboundBinding",
    );
    assertEquals(harness.captured.env.CREDENTIALS, undefined);
    assertEquals(harness.captured.env.NET, undefined);
    assertEquals(
      (harness.captured.bindingProps["OutboundBinding"] as {
        allowHttp?: boolean;
      }).allowHttp,
      true,
    );
  } finally {
    harness.restore();
  }
});

Deno.test("production network.tcp remains reserved and exposes no raw socket capability", async () => {
  const harness = installContainmentHarness({ includeTestExports: true });
  try {
    await executeInDynamicSandbox(
      maximalConfig({
        testMode: false,
        declaredEffects: ["network.tcp"],
        capacityReceiptId: undefined,
        d1DataService: null,
      }),
      "noop",
      [],
    );
    assertEquals(harness.captured.globalOutbound, null);
    assertEquals(harness.captured.env.NET, undefined);
    assertEquals(harness.captured.constructors["NetworkBinding"] ?? 0, 0);
    assertEquals(harness.captured.constructors["OutboundBinding"] ?? 0, 0);
    assert(
      harness.captured.modules["setup.js"].includes(
        "Raw TCP sockets are not exposed in this runtime",
      ),
    );
  } finally {
    harness.restore();
  }
});

Deno.test("caught HTTP and TCP effects still fail gx.test and close the session", async () => {
  for (
    const [mode, expectedEffect] of [
      ["caught_blocked_outbound", "outbound_http"],
      ["caught_blocked_connect", "outbound_tcp"],
    ] as const
  ) {
    const harness = installContainmentHarness({
      includeTestExports: true,
      mode,
    });
    try {
      const result = await executeInDynamicSandbox(
        maximalConfig(),
        "noop",
        [],
      );
      assertEquals(result.success, false);
      assertEquals(result.error?.code, "GX_TEST_EFFECT_BLOCKED");
      assert(result.error?.message.includes(expectedEffect));
      assertEquals(
        result.observedEffects,
        [
          expectedEffect === "outbound_http"
            ? UL_TEST_OBSERVED_EFFECTS.networkHttp
            : UL_TEST_OBSERVED_EFFECTS.networkTcp,
        ],
      );
      assertEquals(harness.captured.sessions.length, 1);
      assertEquals(harness.captured.sessions[0].sealed, true);
      assertEquals(harness.captured.sessions[0].closeCalls, 1);
      assertEquals(harness.captured.sessions[0].disposeCalls, 0);
    } finally {
      harness.restore();
    }
  }
});

Deno.test("gx.test state cleans up after developer and loader failures", async () => {
  for (const mode of ["developer_error", "throw_load"] as const) {
    const harness = installContainmentHarness({
      includeTestExports: true,
      mode,
    });
    try {
      const result = await executeInDynamicSandbox(
        maximalConfig(),
        "noop",
        [],
      );
      assertEquals(result.success, false);
      assertEquals(harness.captured.sessions.length, 1);
      assertEquals(harness.captured.sessions[0].closeCalls, 1);
      assertEquals(harness.captured.sessions[0].disposeCalls, 0);
    } finally {
      harness.restore();
    }
  }
});

Deno.test("gx.test state cleans up after an aborted timeout", async () => {
  const harness = installContainmentHarness({
    includeTestExports: true,
    mode: "hang",
  });
  try {
    const result = await executeInDynamicSandbox(
      maximalConfig({ timeoutMs: 5 }),
      "noop",
      [],
    );
    assertEquals(result.success, false);
    assertEquals(result.observedEffects, [
      UL_TEST_OBSERVED_EFFECTS.inferenceGenerate,
    ]);
    assertEquals(harness.captured.sessions.length, 1);
    assertEquals(harness.captured.sessions[0].closeCalls, 1);
    assertEquals(harness.captured.sessions[0].disposeCalls, 0);
  } finally {
    harness.restore();
  }
});

Deno.test("blocked effects remain disqualifying when execution later times out", async () => {
  const harness = installContainmentHarness({
    includeTestExports: true,
    mode: "blocked_then_hang",
  });
  try {
    const result = await executeInDynamicSandbox(
      maximalConfig({ timeoutMs: 5 }),
      "noop",
      [],
    );
    assertEquals(result.success, false);
    assertEquals(result.error?.code, "GX_TEST_EFFECT_BLOCKED");
    assert(result.error?.message.includes("outbound_http"));
    assertEquals(result.observedEffects, [
      UL_TEST_OBSERVED_EFFECTS.inferenceGenerate,
      UL_TEST_OBSERVED_EFFECTS.networkHttp,
    ]);
    assertEquals(harness.captured.sessions.length, 1);
    assertEquals(harness.captured.sessions[0].sealed, true);
    assertEquals(harness.captured.sessions[0].closeCalls, 1);
    assertEquals(harness.captured.sessions[0].disposeCalls, 0);
  } finally {
    harness.restore();
  }
});

Deno.test("reused execution ids still receive distinct invocation-owned sessions", async () => {
  const harness = installContainmentHarness({ includeTestExports: true });
  const config = maximalConfig();
  try {
    const first = await executeInDynamicSandbox(config, "noop", []);
    const second = await executeInDynamicSandbox(config, "noop", []);
    assertEquals(first.success, true);
    assertEquals(second.success, true);
    assertEquals(harness.captured.sessions.length, 2);
    assertEquals(new Set(harness.captured.sessionNames).size, 2);
    assert(
      harness.captured.sessions[0] !== harness.captured.sessions[1],
      "each run must own a distinct session object",
    );
    for (const session of harness.captured.sessions) {
      assertEquals(session.closeCalls, 1);
      assertEquals(session.disposeCalls, 0);
    }
  } finally {
    harness.restore();
  }
});
