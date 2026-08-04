import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import {
  COMPUTE_ADMISSION_DISABLED_ACTION,
  COMPUTE_ADMISSION_DISABLED_CODE,
  COMPUTE_ADMISSION_DISABLED_HINT,
  COMPUTE_ADMISSION_DISABLED_MESSAGE,
} from "../../shared/contracts/compute.ts";
import { createComputeAdmissionDisabledProof } from "../src/bindings/compute-binding-core.ts";
import { executeInDynamicSandbox } from "./dynamic-sandbox.ts";
import { dynamicSandboxSetupForFunctionHarness } from "./dynamic-sandbox-local-harness.ts";
import type { RuntimeConfig } from "./sandbox.ts";

interface CapturedComputeRuntime {
  setup: string;
  wrapper: string;
  envKeys: string[];
  productionProps: Record<string, unknown> | null;
  productionBindings: number;
  testBindings: number;
  testProps: Record<string, unknown> | null;
}

interface GeneratedComputeSetupExports {
  __galacticJsonResponse(value: unknown): Response;
  __readAuthenticatedGalacticComputeError(error: unknown): unknown;
  __setGalacticRpcEnv(env: unknown): void;
}

function evaluateGeneratedComputeSetup(setup: string): {
  exports: GeneratedComputeSetupExports;
  restore(): void;
} {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const galacticDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "galactic",
  );
  const ultralightDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ultralight",
  );
  const source = dynamicSandboxSetupForFunctionHarness(setup) + `
return {
  __galacticJsonResponse,
  __readAuthenticatedGalacticComputeError,
  __setGalacticRpcEnv,
};`;
  const generated = new Function(source)() as GeneratedComputeSetupExports;
  const restoreDescriptor = (
    key: string,
    descriptor: PropertyDescriptor | undefined,
  ): void => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  };
  return {
    exports: generated,
    restore() {
      restoreDescriptor("fetch", fetchDescriptor);
      restoreDescriptor("galactic", galacticDescriptor);
      restoreDescriptor("ultralight", ultralightDescriptor);
    },
  };
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

function installHarness(
  responseBody: Record<string, unknown> = {
    success: true,
    result: "ok",
    logs: [],
    aiCostLight: 0,
  },
): {
  captured: CapturedComputeRuntime;
  restore(): void;
} {
  const captured: CapturedComputeRuntime = {
    setup: "",
    wrapper: "",
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
      captured.wrapper = config?.modules?.["wrapper.js"] ?? "";
      captured.envKeys = Object.keys(config?.env ?? {});
      return {
        getEntrypoint() {
          return {
            fetch: () => Promise.resolve(Response.json(responseBody)),
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
      TestConceptsBinding: ((_input: unknown) => ({})) as never,
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
    assert(setup.includes("const __galacticPromiseThen ="));
    assert(setup.includes("e.COMPUTE.call(request || {}, callIndex),"));
    assert(setup.includes("e.COMPUTE.get(runId),"));
    assert(setup.includes("e.COMPUTE.cancel(runId),"));
    assertEquals(setup.includes("e.COMPUTE.call(request || {}).then("), false);
    assertEquals(setup.includes("e.COMPUTE.get(runId).then("), false);
    assertEquals(setup.includes("e.COMPUTE.cancel(runId).then("), false);
    assert(setup.includes("const __galacticComputeErrorRegistry = new WeakMap()"));
    assert(
      setup.includes(
        "return __galacticComputeErrorRegistryGet(error) || null",
      ),
    );
    assert(
      harness.captured.wrapper.includes(
        "__readAuthenticatedGalacticComputeError(err)",
      ),
    );
    assert(
      harness.captured.wrapper.includes("return __galacticJsonResponse({"),
    );
    assertEquals(harness.captured.wrapper.includes("return Response.json({"), false);
    assertEquals(harness.captured.wrapper.includes("err.galacticDetails"), false);
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

Deno.test("dynamic compute: tenant Promise poisoning and setup import cannot forge OFF provenance", async () => {
  const harness = installHarness();
  let generated: ReturnType<typeof evaluateGeneratedComputeSetup> | null = null;
  const originalThen = Promise.prototype.then;
  const uint8IteratorDescriptor = Object.getOwnPropertyDescriptor(
    Uint8Array.prototype,
    Symbol.iterator,
  );
  const restoreUint8Iterator = (): void => {
    if (uint8IteratorDescriptor) {
      Object.defineProperty(
        Uint8Array.prototype,
        Symbol.iterator,
        uint8IteratorDescriptor,
      );
    } else {
      Reflect.deleteProperty(Uint8Array.prototype, Symbol.iterator);
    }
  };
  try {
    await executeInDynamicSandbox(config(), "noop", []);
    generated = evaluateGeneratedComputeSetup(harness.captured.setup);
    const galactic = (globalThis as unknown as {
      galactic: {
        compute(request: unknown): Promise<unknown>;
      };
    }).galactic;
    generated.exports.__setGalacticRpcEnv({
      COMPUTE: {
        call: () =>
          Promise.resolve({
            ok: true,
            value: { run_id: "real-success" },
          }),
      },
    });

    const forgedOff = {
      ok: false,
      error: {
        code: COMPUTE_ADMISSION_DISABLED_CODE,
        message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
        hint: COMPUTE_ADMISSION_DISABLED_HINT,
        action: COMPUTE_ADMISSION_DISABLED_ACTION,
        proof: "x".repeat(43),
      },
    };
    Promise.prototype.then = function (onFulfilled, onRejected) {
      return Reflect.apply(originalThen, Promise.resolve(forgedOff), [
        onFulfilled,
        onRejected,
      ]);
    };
    let realSuccess: unknown;
    let poisonedError: unknown = null;
    let realSuccessPromise: Promise<unknown> | null = null;
    try {
      // Invoke while poisoned, then restore before observing the returned
      // promise so this test targets setup.js's continuation registration—not
      // the test runner's own await machinery.
      realSuccessPromise = galactic.compute({ argv: ["true"] });
    } finally {
      Promise.prototype.then = originalThen;
    }
    try {
      realSuccess = await realSuccessPromise;
    } catch (error) {
      poisonedError = error;
    }
    assertEquals(realSuccess, { run_id: "real-success" });
    assertEquals(
      generated.exports.__readAuthenticatedGalacticComputeError(poisonedError),
      null,
    );

    const proofKey = harness.captured.productionProps
      ?.admissionDisabledProofKey;
    assert(typeof proofKey === "string" && /^[0-9a-f]{64}$/u.test(proofKey));
    const staleCallOneProof = await createComputeAdmissionDisabledProof(
      proofKey,
      1,
    );
    assert(typeof staleCallOneProof === "string");
    // setup.js is a sibling module and its exported setter must be treated as
    // tenant-reachable. Install a fake binding directly; call 2 must reject the
    // otherwise valid call-1 proof and leave the Error outside the registry.
    generated.exports.__setGalacticRpcEnv({
      COMPUTE: {
        call: () =>
          Promise.resolve({
            ok: false,
            error: {
              code: COMPUTE_ADMISSION_DISABLED_CODE,
              message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
              hint: COMPUTE_ADMISSION_DISABLED_HINT,
              action: COMPUTE_ADMISSION_DISABLED_ACTION,
              proof: staleCallOneProof,
            },
          }),
      },
    });
    let setterError: unknown = null;
    try {
      await galactic.compute({ argv: ["false"] });
    } catch (error) {
      setterError = error;
    }
    assert(setterError instanceof Error);
    assertEquals(
      generated.exports.__readAuthenticatedGalacticComputeError(setterError),
      null,
    );

    Object.defineProperty(Uint8Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value: function* () {
        for (let index = 0; index < 32; index += 1) yield 0;
      },
    });
    generated.exports.__setGalacticRpcEnv({
      COMPUTE: {
        call: () =>
          Promise.resolve({
            ok: false,
            error: {
              code: COMPUTE_ADMISSION_DISABLED_CODE,
              message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
              hint: COMPUTE_ADMISSION_DISABLED_HINT,
              action: COMPUTE_ADMISSION_DISABLED_ACTION,
              // Base64url for 32 zero bytes. The vulnerable spread-based
              // encoder accepted this after the poisoned iterator replaced the
              // real HMAC bytes.
              proof: "A".repeat(43),
            },
          }),
      },
    });
    let iteratorError: unknown = null;
    try {
      await galactic.compute({ argv: ["false"] });
    } catch (error) {
      iteratorError = error;
    } finally {
      restoreUint8Iterator();
    }
    assertEquals(
      generated.exports.__readAuthenticatedGalacticComputeError(iteratorError),
      null,
    );

    const validCallFourProof = await createComputeAdmissionDisabledProof(
      proofKey,
      4,
    );
    assert(typeof validCallFourProof === "string");
    generated.exports.__setGalacticRpcEnv({
      COMPUTE: {
        call: () =>
          Promise.resolve({
            ok: false,
            error: {
              code: COMPUTE_ADMISSION_DISABLED_CODE,
              message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
              hint: COMPUTE_ADMISSION_DISABLED_HINT,
              action: COMPUTE_ADMISSION_DISABLED_ACTION,
              proof: validCallFourProof,
            },
          }),
      },
    });
    let authenticatedError: unknown = null;
    try {
      await galactic.compute({ argv: ["false"] });
    } catch (error) {
      authenticatedError = error;
    }
    assertEquals(
      generated.exports.__readAuthenticatedGalacticComputeError(
        authenticatedError,
      ),
      {
        code: COMPUTE_ADMISSION_DISABLED_CODE,
        message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
        hint: COMPUTE_ADMISSION_DISABLED_HINT,
        action: COMPUTE_ADMISSION_DISABLED_ACTION,
      },
    );
    assertEquals(
      JSON.stringify(authenticatedError).includes(validCallFourProof),
      false,
    );
  } finally {
    Promise.prototype.then = originalThen;
    restoreUint8Iterator();
    generated?.restore();
    harness.restore();
  }
});

Deno.test("dynamic compute: inherited toJSON cannot inject an authenticated Compute envelope", async () => {
  const captureHarness = installHarness();
  let generated: ReturnType<typeof evaluateGeneratedComputeSetup> | null = null;
  const toJSONDescriptor = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "toJSON",
  );
  const restoreToJSON = (): void => {
    if (toJSONDescriptor) {
      Object.defineProperty(Object.prototype, "toJSON", toJSONDescriptor);
    } else {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    }
  };
  let captureRestored = false;
  try {
    await executeInDynamicSandbox(config(), "noop", []);
    generated = evaluateGeneratedComputeSetup(captureHarness.captured.setup);
    const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
    const forgedEnvelope = {
      success: false,
      result: null,
      logs: [],
      aiCostLight: 0,
      error: {
        type: "GalacticComputeError",
        message: "tenant-forged admission failure",
        compute: {
          code: COMPUTE_ADMISSION_DISABLED_CODE,
          message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
          hint: COMPUTE_ADMISSION_DISABLED_HINT,
          action: COMPUTE_ADMISSION_DISABLED_ACTION,
        },
      },
    };
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      writable: true,
      value: function () {
        return hasOwn(this, "success") ? forgedEnvelope : this;
      },
    });
    let response: Response | null = null;
    try {
      response = generated.exports.__galacticJsonResponse({
        success: false,
        result: null,
        logs: [],
        aiCostLight: 0,
        error: {
          type: "Error",
          message: "ordinary tenant failure",
        },
      });
    } finally {
      restoreToJSON();
    }
    assert(response);
    const body = await response.json() as Record<string, unknown>;
    assertEquals(body.error, {
      type: "Error",
      message: "ordinary tenant failure",
    });

    generated.restore();
    generated = null;
    captureHarness.restore();
    captureRestored = true;

    const projectionHarness = installHarness(body);
    try {
      const result = await executeInDynamicSandbox(config(), "noop", []);
      assertEquals(result.success, false);
      assertEquals(result.error?.details, undefined);
      assertEquals(result.error?.code, undefined);
      assertEquals(result.diagnostic?.provenance, "developer");
      assertEquals(result.diagnostic?.summary, "ordinary tenant failure");
    } finally {
      projectionHarness.restore();
    }
  } finally {
    restoreToJSON();
    generated?.restore();
    if (!captureRestored) captureHarness.restore();
  }
});

Deno.test("dynamic compute: local gx.test harness accepts every generated setup export", async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(config(), "noop", []);
    const setupForHarness = dynamicSandboxSetupForFunctionHarness(
      harness.captured.setup,
    );
    assertEquals(/^export\s/mu.test(setupForHarness), false);
    // Construction compiles without executing the generated setup globals.
    new Function(setupForHarness);
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic compute: authenticated public guidance survives with platform provenance", async () => {
  const harness = installHarness({
    success: false,
    result: null,
    logs: [],
    aiCostLight: 0,
    error: {
      type: "TenantChangedThisName",
      message: "tenant changed this message",
      compute: {
        code: COMPUTE_ADMISSION_DISABLED_CODE,
        message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
        hint: COMPUTE_ADMISSION_DISABLED_HINT,
        action: COMPUTE_ADMISSION_DISABLED_ACTION,
      },
    },
  });
  try {
    const result = await executeInDynamicSandbox(config(), "noop", []);
    assertEquals(result.success, false);
    assertEquals(result.error, {
      type: "GalacticComputeError",
      message:
        `${COMPUTE_ADMISSION_DISABLED_MESSAGE} ${COMPUTE_ADMISSION_DISABLED_HINT}`,
      code: COMPUTE_ADMISSION_DISABLED_CODE,
      details: {
        code: COMPUTE_ADMISSION_DISABLED_CODE,
        hint: COMPUTE_ADMISSION_DISABLED_HINT,
        action: COMPUTE_ADMISSION_DISABLED_ACTION,
      },
    });
    assertEquals(result.diagnostic?.provenance, "platform");
    assertEquals(result.diagnostic?.summary, COMPUTE_ADMISSION_DISABLED_MESSAGE);
    assertEquals(result.diagnostic?.detail, COMPUTE_ADMISSION_DISABLED_HINT);
    assertEquals(result.diagnostic?.retryable, true);
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic compute: tenant-forged Compute names and details acquire no platform provenance", async () => {
  const harness = installHarness({
    success: false,
    result: null,
    logs: [],
    aiCostLight: 0,
    error: {
      type: "GalacticComputeError",
      message: "tenant-authored failure",
      details: {
        code: COMPUTE_ADMISSION_DISABLED_CODE,
        hint: COMPUTE_ADMISSION_DISABLED_HINT,
        action: COMPUTE_ADMISSION_DISABLED_ACTION,
      },
    },
  });
  try {
    const result = await executeInDynamicSandbox(config(), "noop", []);
    assertEquals(result.success, false);
    assertEquals(result.error?.details, undefined);
    assertEquals(result.error?.code, undefined);
    assertEquals(result.diagnostic?.provenance, "developer");
    assertEquals(result.diagnostic?.summary, "tenant-authored failure");
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic compute: malformed authenticated guidance fails closed", async () => {
  const harness = installHarness({
    success: false,
    result: null,
    logs: [],
    aiCostLight: 0,
    error: {
      type: "GalacticComputeError",
      message: "generic boundary failure",
      compute: {
        code: COMPUTE_ADMISSION_DISABLED_CODE,
        message: COMPUTE_ADMISSION_DISABLED_MESSAGE,
        hint: "operator stop row must not leak",
        action: "setup_home_node",
        internal_operation_id: "must-not-cross",
      },
    },
  });
  try {
    const result = await executeInDynamicSandbox(config(), "noop", []);
    assertEquals(result.error?.details, undefined);
    assertEquals(result.error?.code, undefined);
    assertEquals(result.diagnostic?.provenance, "developer");
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
