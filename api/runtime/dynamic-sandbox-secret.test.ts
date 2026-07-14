// Regression guard for the cross-tenant CRITICAL: the platform WORKER_SECRET
// must NEVER be interpolated into the source injected into the app sandbox.
// Before the fix, ultralight.emit / ultralight.net.* embedded the secret as a
// literal (readable via emit.toString()), which — combined with the data
// worker trusting X-Worker-Secret + a caller-supplied appId/userId — allowed a
// sandboxed app to read/write any tenant's data. emit/net now route through
// host-side RPC bindings (EVENTS / NET); the secret stays in the parent isolate.

import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { executeInDynamicSandbox } from "./dynamic-sandbox.ts";
import type { RuntimeConfig } from "./sandbox.ts";

const SECRET = "SUPER_SECRET_WORKER_VALUE_DO_NOT_LEAK_7f3a9c";

interface CapturedLoad {
  setup: string;
  wrapper: string;
  envKeys: string[];
}

function installSandboxHarness(): {
  captured: CapturedLoad;
  constructed: { events: boolean; net: boolean };
  restore: () => void;
} {
  const captured: CapturedLoad = { setup: "", wrapper: "", envKeys: [] };
  const constructed = { events: false, net: false, cred: false };

  const prevEnv = globalThis.__env;
  const prevCtx = globalThis.__ctx;
  const prevAgentSecret = Deno.env.get("AGENT_CALLER_SECRET");
  Deno.env.set("AGENT_CALLER_SECRET", "test-agent-caller-secret");

  const loader = {
    // deno-lint-ignore no-explicit-any
    load(cfg: any) {
      captured.setup = cfg?.modules?.["setup.js"] ?? "";
      captured.wrapper = cfg?.modules?.["wrapper.js"] ?? "";
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

  globalThis.__env = {
    LOADER: loader,
    CODE_CACHE: { get: () => Promise.resolve("export const noop = 1;") },
    // deno-lint-ignore no-explicit-any
  } as any;

  globalThis.__ctx = {
    exports: {
      // deno-lint-ignore no-explicit-any
      EventsBinding: (_input: any) => {
        constructed.events = true;
        return { emit: () => Promise.resolve({ ok: true, event_id: "e", rejected: null }) };
      },
      // deno-lint-ignore no-explicit-any
      NetworkBinding: (_input: any) => {
        constructed.net = true;
        return {
          imapFetchUnseen: () => Promise.resolve({ emails: [], maxUid: 0, hasMore: false }),
          smtpSend: () => Promise.resolve({ success: true }),
        };
      },
      // deno-lint-ignore no-explicit-any
      AppDataBinding: (_input: any) => ({
        store: () => Promise.resolve(),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(),
        list: () => Promise.resolve([]),
      }),
      // deno-lint-ignore no-explicit-any
      CredentialBinding: (_input: any) => {
        constructed.cred = true;
        return { authenticatedFetch: () => Promise.resolve(new Response("ok")) };
      },
    },
    waitUntil: (p: Promise<unknown>) => {
      p.catch(() => {});
    },
    // deno-lint-ignore no-explicit-any
  } as any;

  return {
    captured,
    constructed,
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
    appId: "app_secret_regression",
    userId: "user_a",
    ownerId: "user_a",
    executionId: "exec_secret_regression",
    code: "",
    permissions: ["net:connect", "storage:read"],
    userApiKey: null,
    user: { id: "user_a", email: "a@test.dev", displayName: null, tier: "free" },
    d1DataService: null,
    memoryService: null,
    envVars: {},
    callerContextToken: "gxc1.dummy-host-set-token.sig",
    workerSecret: SECRET,
    baseUrl: "https://api.test.dev",
    workerBaseUrl: "https://api.test.dev",
    // Services unused for the storage:read/net:connect path under test.
    // deno-lint-ignore no-explicit-any
  } as unknown as RuntimeConfig;
}

Deno.test("dynamic sandbox: WORKER_SECRET never enters the injected sandbox source", async () => {
  const harness = installSandboxHarness();
  try {
    const result = await executeInDynamicSandbox(baseConfig(), "noop", []);
    assertEquals(result.success, true);

    // The headline guarantee: the secret literal is absent from setup.js.
    assert(
      !harness.captured.setup.includes(SECRET),
      "WORKER_SECRET leaked into sandbox setup module source",
    );
    // The old leak vector — the secret rode in an X-Worker-Secret header that
    // was interpolated into emit/net source. That header must be gone too.
    assert(
      !harness.captured.setup.includes("X-Worker-Secret"),
      "X-Worker-Secret header still embedded in sandbox source",
    );
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic sandbox: per-call tokens ride the fetch body, never the baked module source", async () => {
  const harness = installSandboxHarness();
  try {
    const result = await executeInDynamicSandbox(baseConfig(), "noop", []);
    assertEquals(result.success, true);

    // The signed caller-context token is per-call (it bakes in hop + entry
    // function). Baked into module content, a warm-reused isolate would send a
    // STALE hop on outbound cross-Agent calls — so it must not appear in any
    // injected source (Stage 3 of the get() rearchitecture).
    const modules = harness.captured.setup + "\n" + harness.captured.wrapper;
    assert(
      !modules.includes("gxc1.dummy-host-set-token.sig"),
      "caller-context token is baked into sandbox module source",
    );
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic sandbox: emit + net route through host-side RPC bindings", async () => {
  const harness = installSandboxHarness();
  try {
    await executeInDynamicSandbox(baseConfig(), "noop", []);

    // emit goes through the EVENTS binding, not an internal fetch.
    assert(
      harness.captured.setup.includes("e.EVENTS.emit"),
      "emit no longer routes through the EVENTS RPC binding",
    );
    assert(
      !harness.captured.setup.includes("api/events/emit"),
      "emit still references the internal HTTP endpoint",
    );

    // net.* goes through the NET binding (cloudflare:sockets host-side).
    assert(
      harness.captured.setup.includes("e.NET.imapFetchUnseen"),
      "net.imapFetchUnseen no longer routes through the NET RPC binding",
    );
    assert(
      harness.captured.setup.includes("e.NET.smtpSend"),
      "net.smtpSend no longer routes through the NET RPC binding",
    );
    assert(
      !harness.captured.setup.includes("api/net/"),
      "net.* still references the internal HTTP endpoints",
    );

    // The bindings were actually constructed and handed to the isolate.
    assert(
      harness.captured.envKeys.includes("EVENTS"),
      "EVENTS binding not passed to the loaded isolate",
    );
    assert(
      harness.captured.envKeys.includes("NET"),
      "NET binding not passed to the loaded isolate",
    );
    assert(harness.constructed.events, "EventsBinding was not constructed");
    assert(harness.constructed.net, "NetworkBinding was not constructed");
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic sandbox: routines cannot emit deferred events outside their budget", async () => {
  const harness = installSandboxHarness();
  try {
    const config = {
      ...baseConfig(),
      routineContext: {
        routineId: "routine-1",
        routineRunId: "run-1",
        traceId: "trace-1",
      },
    } as RuntimeConfig;
    await executeInDynamicSandbox(config, "noop", []);

    assert(
      harness.captured.setup.includes(
        "galactic.emit is unavailable during routine execution: deferred event fanout is not yet budget-attributed.",
      ),
      "routine emit does not fail with the explicit budget-attribution error",
    );
    assert(
      !harness.captured.envKeys.includes("EVENTS"),
      "routine execution received an EVENTS binding",
    );
    assertEquals(harness.constructed.events, false);
  } finally {
    harness.restore();
  }
});

Deno.test("dynamic sandbox: per-user credential values never enter the sandbox source (Phase 3 vault)", async () => {
  const harness = installSandboxHarness();
  try {
    const PER_USER = "TOPSECRET_PER_USER_VALUE_9x2q";
    const config = {
      ...baseConfig(),
      permissions: ["net:fetch"],
      envVars: { UNIVERSAL_VAR: "safe-universal-value" },
      allowedDestinations: ["api.openai.com"],
      credentials: {
        OPENAI_KEY: {
          value: PER_USER,
          credential: {
            destination: "api.openai.com",
            inject: { as: "bearer" },
          },
        },
      },
      // deno-lint-ignore no-explicit-any
    } as unknown as RuntimeConfig;

    const result = await executeInDynamicSandbox(config, "noop", []);
    assertEquals(result.success, true);

    // Headline Phase 3 guarantee: the per-user secret VALUE is absent from the
    // sandbox source — not in ultralight.env, not anywhere.
    assert(
      !harness.captured.setup.includes(PER_USER),
      "per-user credential value leaked into sandbox setup source",
    );
    // Universal (developer-owned) vars ARE still injected as ultralight.env.
    assert(
      harness.captured.setup.includes("safe-universal-value"),
      "universal env var was not injected into the sandbox",
    );
    // The credential is reachable only via the host-side CredentialBinding.
    assert(
      harness.captured.envKeys.includes("CREDENTIALS"),
      "CredentialBinding not passed to the loaded isolate",
    );
    assert(harness.constructed.cred, "CredentialBinding was not constructed");
    assert(
      harness.captured.setup.includes("e.CREDENTIALS.authenticatedFetch"),
      "ultralight.fetch does not route through the CredentialBinding",
    );
  } finally {
    harness.restore();
  }
});
