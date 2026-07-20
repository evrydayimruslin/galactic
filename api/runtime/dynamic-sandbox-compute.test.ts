import { assert, assertEquals } from 'https://deno.land/std@0.210.0/assert/mod.ts';
import { executeInDynamicSandbox } from './dynamic-sandbox.ts';
import type { RuntimeConfig } from './sandbox.ts';

interface CapturedComputeRuntime {
  setup: string;
  envKeys: string[];
  productionProps: Record<string, unknown> | null;
  productionBindings: number;
  testBindings: number;
}

function installHarness(): {
  captured: CapturedComputeRuntime;
  restore(): void;
} {
  const captured: CapturedComputeRuntime = {
    setup: '',
    envKeys: [],
    productionProps: null,
    productionBindings: 0,
    testBindings: 0,
  };
  const previousEnv = globalThis.__env;
  const previousCtx = globalThis.__ctx;
  const previousCallerSecret = Deno.env.get('AGENT_CALLER_SECRET');
  Deno.env.set('AGENT_CALLER_SECRET', 'compute-runtime-test-secret');

  const loader = {
    // deno-lint-ignore no-explicit-any
    load(config: any) {
      captured.setup = config?.modules?.['setup.js'] ?? '';
      captured.envKeys = Object.keys(config?.env ?? {});
      return {
        getEntrypoint() {
          return {
            fetch: () =>
              Promise.resolve(Response.json({
                success: true,
                result: 'ok',
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
    CODE_CACHE: {
      get: () => Promise.resolve('export const noop = 1;'),
    },
    AGENT_CALLER_SECRET: 'compute-runtime-test-secret',
    TRUST_SIGNING_SECRET: 'compute-runtime-trust-secret',
    // deno-lint-ignore no-explicit-any
  } as any;
  globalThis.__ctx = {
    exports: {
      // deno-lint-ignore no-explicit-any
      ComputeBinding: (input: any) => {
        captured.productionBindings += 1;
        captured.productionProps = input?.props ?? null;
        return {
          call: () => Promise.resolve({}),
          get: () => Promise.resolve({}),
          cancel: () => Promise.resolve({}),
        };
      },
      TestComputeBinding: () => {
        captured.testBindings += 1;
        return {
          call: () => Promise.resolve({}),
          get: () => Promise.resolve({}),
          cancel: () => Promise.resolve({}),
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
        Deno.env.delete('AGENT_CALLER_SECRET');
      } else {
        Deno.env.set('AGENT_CALLER_SECRET', previousCallerSecret);
      }
    },
  };
}

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    appId: '00000000-0000-4000-8000-000000000010',
    userId: '00000000-0000-4000-8000-000000000011',
    ownerId: '00000000-0000-4000-8000-000000000011',
    executionId: '00000000-0000-4000-8000-000000000012',
    code: '',
    permissions: ['compute:exec'],
    userApiKey: 'provider-key-must-not-enter-compute-binding',
    user: {
      id: '00000000-0000-4000-8000-000000000011',
      email: 'owner@example.test',
      displayName: null,
      tier: 'pro',
    },
    authToken: 'ul_human_bearer_must_not_enter_compute_binding',
    workerSecret: 'platform-worker-secret-must-not-enter-compute-binding',
    d1DataService: null,
    memoryService: null,
    envVars: {},
    ...overrides,
    // Services are unused by this capture-only harness.
  } as unknown as RuntimeConfig;
}

Deno.test('dynamic compute: callable SDK plus get/cancel use only the host RPC binding', async () => {
  const harness = installHarness();
  try {
    const result = await executeInDynamicSandbox(config(), 'noop', []);
    assertEquals(result.success, true);
    assert(harness.captured.envKeys.includes('COMPUTE'));
    assertEquals(harness.captured.productionBindings, 1);
    assertEquals(harness.captured.productionProps, {
      userId: '00000000-0000-4000-8000-000000000011',
      agentId: '00000000-0000-4000-8000-000000000010',
    });

    const setup = harness.captured.setup;
    assert(setup.includes('compute: __galacticCompute'));
    assert(
      setup.includes(
        'e.COMPUTE.call(request || {}, globalThis.__execHandle, globalThis.__computeCallIndex)',
      ),
    );
    assert(setup.includes('e.COMPUTE.get(runId, globalThis.__execHandle)'));
    assert(setup.includes('e.COMPUTE.cancel(runId, globalThis.__execHandle)'));
    assertEquals(setup.includes('ul_human_bearer_must_not_enter'), false);
    assertEquals(
      setup.includes('platform-worker-secret-must-not-enter'),
      false,
    );
    assertEquals(setup.includes('provider-key-must-not-enter'), false);
  } finally {
    harness.restore();
  }
});

Deno.test('dynamic compute: unauthenticated execution receives no production binding', async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(config({ user: null }), 'noop', []);
    assertEquals(harness.captured.envKeys.includes('COMPUTE'), false);
    assertEquals(harness.captured.productionBindings, 0);
  } finally {
    harness.restore();
  }
});

Deno.test('dynamic compute: missing compute:exec permission receives no binding', async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(config({ permissions: [] }), 'noop', []);
    assertEquals(harness.captured.envKeys.includes('COMPUTE'), false);
    assertEquals(harness.captured.productionBindings, 0);
    assertEquals(harness.captured.testBindings, 0);
  } finally {
    harness.restore();
  }
});

Deno.test('dynamic compute: gx.test uses a no-side-effect binding', async () => {
  const harness = installHarness();
  try {
    await executeInDynamicSandbox(config({ testMode: true }), 'noop', []);
    assert(harness.captured.envKeys.includes('COMPUTE'));
    assertEquals(harness.captured.productionBindings, 0);
    assertEquals(harness.captured.testBindings, 1);
  } finally {
    harness.restore();
  }
});
