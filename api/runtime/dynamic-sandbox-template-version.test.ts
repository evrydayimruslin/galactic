// Automated guard for GALACTIC_SANDBOX_TEMPLATE_VERSION. That
// constant is folded into the get() reuse key so a parent-worker deploy that
// changes the GENERATED setup.js / wrapper.js can never collide with a still-
// cached old warm isolate under an unchanged key. But the version is a MANUAL
// constant -- nothing otherwise forces a bump when the template changes. This
// test snapshots the generated modules for a fixed config: any edit to the
// setup/wrapper template (or the fixed config below) flips the hash and fails
// LOUDLY, with a message telling the developer to bump the shared version.
// It also asserts the template is DETERMINISTIC (two runs -> identical bytes),
// the precondition for "same reuse key => same isolate content".

import { assert } from "https://deno.land/std@0.210.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.210.0/assert/assert_equals.ts";
import ts from "typescript";
import { executeInDynamicSandbox } from "./dynamic-sandbox.ts";
import { GALACTIC_SANDBOX_TEMPLATE_VERSION } from "./runtime-contract.ts";
import type { RuntimeConfig } from "./sandbox.ts";

// Bump this in lockstep with GALACTIC_SANDBOX_TEMPLATE_VERSION whenever the
// generated setup.js / wrapper.js template changes.
const PINNED_TEMPLATE_VERSION = "2026-08-02.knowledge-binding.v26";

// Stable separator between the two captured modules for the snapshot hash.
const SEP = "\n----MODULE-BOUNDARY----\n";

interface Captured {
  setup: string;
  wrapper: string;
  runs: number;
}

function installHarness(
  responseBody: Record<string, unknown> = {
    success: true,
    result: "ok",
    logs: [],
    aiCostLight: 0,
  },
): { captured: Captured; restore: () => void } {
  const captured: Captured = { setup: "", wrapper: "", runs: 0 };
  const prevEnv = globalThis.__env;
  const prevCtx = globalThis.__ctx;
  const prevAgentSecret = Deno.env.get("AGENT_CALLER_SECRET");
  Deno.env.set("AGENT_CALLER_SECRET", "test-agent-caller-secret");

  const loader = {
    // deno-lint-ignore no-explicit-any
    load(cfg: any) {
      captured.runs += 1;
      captured.setup = cfg?.modules?.["setup.js"] ?? "";
      captured.wrapper = cfg?.modules?.["wrapper.js"] ?? "";
      return {
        getEntrypoint() {
          return {
            fetch: () =>
              Promise.resolve(
                new Response(
                  JSON.stringify(responseBody),
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
      AppDataBinding: (_i: any) => ({
        store: () => Promise.resolve(),
        load: () => Promise.resolve(null),
        remove: () => Promise.resolve(),
        list: () => Promise.resolve([]),
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
      if (prevAgentSecret === undefined) Deno.env.delete("AGENT_CALLER_SECRET");
      else Deno.env.set("AGENT_CALLER_SECRET", prevAgentSecret);
    },
  };
}

// Fixed, fully-deterministic config. Changing THIS also flips the hash -- keep
// it stable; it is not meant to vary.
function fixedConfig(): RuntimeConfig {
  return {
    appId: "app_template_guard",
    userId: "user_fixed",
    ownerId: "user_fixed",
    executionId: "exec_fixed",
    code: "",
    permissions: ["storage:read", "storage:write", "memory:read"],
    userApiKey: null,
    user: {
      id: "user_fixed",
      email: "f@test.dev",
      displayName: null,
      tier: "free",
    },
    d1DataService: null,
    memoryService: null,
    envVars: { PUBLIC_VAR: "public-value" },
    baseUrl: "https://api.test.dev",
    workerBaseUrl: "https://api.test.dev",
    slotBindings: [],
    appCallDependencies: [],
    // deno-lint-ignore no-explicit-any
  } as unknown as RuntimeConfig;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("sandbox template: generation is deterministic for a fixed config", async () => {
  const h = installHarness();
  try {
    await executeInDynamicSandbox(fixedConfig(), "noop", []);
    const first = h.captured.setup + SEP + h.captured.wrapper;
    await executeInDynamicSandbox(fixedConfig(), "noop", []);
    const second = h.captured.setup + SEP + h.captured.wrapper;
    assertEquals(
      first,
      second,
      "generated setup/wrapper must be byte-identical across runs (same reuse " +
        "key => same content); a non-deterministic template breaks warm reuse",
    );
  } finally {
    h.restore();
  }
});

Deno.test("sandbox template: warm-isolate requests serialize compatibility globals", async () => {
  const h = installHarness();
  try {
    await executeInDynamicSandbox(fixedConfig(), "noop", []);
    assert(
      h.captured.wrapper.includes("globalThis.__galacticExecutionTail"),
      "wrapper must maintain a per-isolate request gate",
    );
    assert(
      h.captured.wrapper.includes("await __previousExecution"),
      "wrapper must acquire the gate before assigning request globals",
    );
    assert(
      h.captured.wrapper.includes("__releaseExecution();"),
      "wrapper must release the gate in a finally block",
    );
  } finally {
    h.restore();
  }
});

Deno.test("sandbox template: fire-and-forget effects drain before the transcript seals", async () => {
  const h = installHarness();
  try {
    await executeInDynamicSandbox(fixedConfig(), "noop", []);
    assert(
      h.captured.setup.includes("__galacticPendingEffects"),
      "setup must retain promises for host RPC and outbound effects",
    );
    assert(
      h.captured.setup.includes("export function __setGalacticRpcEnv"),
      "RPC bindings must enter the module-private pending-effect tracker",
    );
    assert(
      h.captured.wrapper.includes(
        "await __drainGalacticPendingEffects()",
      ),
      "wrapper must drain effects before returning an execution envelope",
    );
    assert(
      !h.captured.setup.includes("globalThis.__rpcEnv") &&
        !h.captured.wrapper.includes("globalThis.__rpcEnv"),
      "tenant code must never receive the raw or proxied RPC environment",
    );
    assert(
      !h.captured.setup.includes(
        "globalThis.__galacticDrainPendingEffects",
      ),
      "tenant code must not be able to replace the transcript drain",
    );
  } finally {
    h.restore();
  }
});

Deno.test("sandbox template: structured-output error codes cross the worker boundary", async () => {
  const h = installHarness();
  try {
    await executeInDynamicSandbox(fixedConfig(), "noop", []);
    assert(
      h.captured.setup.includes("err.code = resp.error_code"),
      "SDK wrapper must copy AI response error_code onto the thrown Error",
    );
    assert(
      h.captured.wrapper.includes(
        "typeof err.code === 'string' ? { code: err.code }",
      ),
      "execution envelope must preserve a thrown Error code",
    );
  } finally {
    h.restore();
  }
});

Deno.test("dynamic sandbox: execution result preserves worker error code", async () => {
  const h = installHarness({
    success: false,
    result: null,
    logs: [],
    aiCostLight: 0,
    error: {
      type: "Error",
      message: "Structured output failed",
      code: "structured_output_schema_mismatch",
    },
  });
  try {
    const result = await executeInDynamicSandbox(fixedConfig(), "noop", []);
    assertEquals(result.success, false);
    assertEquals(result.error?.code, "structured_output_schema_mismatch");
  } finally {
    h.restore();
  }
});

Deno.test("sandbox template: every generated JavaScript module parses", async () => {
  const h = installHarness();
  try {
    await executeInDynamicSandbox(fixedConfig(), "noop", []);
    for (
      const [name, source] of [
        ["setup.js", h.captured.setup],
        ["wrapper.js", h.captured.wrapper],
      ] as const
    ) {
      const transpiled = ts.transpileModule(source, {
        fileName: name,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
        },
        reportDiagnostics: true,
      });
      assertEquals(
        (transpiled.diagnostics ?? [])
          .filter((diagnostic) =>
            diagnostic.category === ts.DiagnosticCategory.Error
          )
          .map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
          ),
        [],
        `${name} must be valid JavaScript before it is sent to Worker Loader`,
      );
    }
  } finally {
    h.restore();
  }
});

Deno.test("sandbox template: snapshot pinned -- a template change must bump the shared runtime contract", async () => {
  const h = installHarness();
  try {
    await executeInDynamicSandbox(fixedConfig(), "noop", []);
    const hash = await sha256Hex(h.captured.setup + SEP + h.captured.wrapper);
    // The pinned hash below is tied to PINNED_TEMPLATE_VERSION. If this assertion
    // fails, the generated setup.js/wrapper.js template (or the fixed config)
    // changed. If it was a real TEMPLATE edit: (1) bump
    // GALACTIC_SANDBOX_TEMPLATE_VERSION in runtime-contract.ts AND
    // PINNED_TEMPLATE_VERSION here, then (2) update TEMPLATE_HASH below. This
    // forces both the reuse key and qualification runtime revision to rotate.
    const TEMPLATE_HASH =
      "2514a7593b9964283e7f9b34e2dbba3853e0cf78a7696ec4eb8d17a632a1be55";
    assertEquals(
      PINNED_TEMPLATE_VERSION,
      GALACTIC_SANDBOX_TEMPLATE_VERSION,
      "PINNED_TEMPLATE_VERSION drifted from the pinned literal",
    );
    assertEquals(
      hash,
      TEMPLATE_HASH,
      "Generated sandbox template changed. If you edited the setup/wrapper " +
        "template or loadConfig shape, bump " +
        "GALACTIC_SANDBOX_TEMPLATE_VERSION (+ the pins in this test). " +
        "See the comment above.",
    );
  } finally {
    h.restore();
  }
});
