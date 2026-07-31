// Galactic Dynamic Worker Sandbox
// Uses Cloudflare Dynamic Workers (env.LOADER.load()) to execute app code
// in isolated V8 sandboxes. Replaces AsyncFunction which is blocked in CF Workers.
//
// Architecture:
//   setup.js  → runs FIRST, sets globalThis.ultralight with lazy getters
//   app.js    → the app's ESM bundle, captures globalThis.ultralight at init
//   wrapper.js → entry point, sets RPC env, imports app, calls target function
//
// ESM module evaluation order: imports are evaluated depth-first.
// wrapper.js imports setup.js (runs first) then app.js (runs second).
// By the time app.js captures globalThis.ultralight, the SDK is ready.

import type { ExecutionResult, RuntimeConfig } from "./sandbox.ts";
import { COMPUTE_EXEC_PERMISSION } from "../../shared/contracts/compute.ts";
import type { ResolvedCredential } from "../../shared/contracts/env.ts";
import { getEnv } from "../lib/env.ts";
import { isolateReuseEligibility } from "./isolate-reuse-eligibility.ts";
import { consumeAiSpend } from "../services/ai-spend-tracker.ts";
import { consumeDbDiff } from "../services/db-diff-tracker.ts";
import {
  deregisterExecutionContext,
  registerExecutionContext,
} from "../services/execution-context-registry.ts";
import { debitCloudOperation } from "../services/cloud-usage.ts";
import { mintSandboxAuthToken } from "../services/sandbox-actor.ts";
import {
  executedBundleVerifyMode,
  handleExecutedBundleVerdict,
  loadLiveExecutedBundle,
  loadReleaseExecutedBundle,
  loadVersionedExecutedBundle,
  verifyExecutedBundle,
} from "../services/executed-bundle.ts";
import {
  collectRuntimeDiagnosticSecrets,
  normalizeOperatorDiagnostic,
  operatorCompatibilityError,
} from "../services/operator-diagnostics.ts";
import {
  isUlTestBlockedEffect,
  isUlTestObservedEffect,
  MAX_UL_TEST_OBSERVED_EFFECTS,
  type UlTestObservedEffect,
} from "../services/ul-test-runtime.ts";
import type { GalacticStableEffectId } from "../services/galactic-agent-document.ts";
import { GALACTIC_SANDBOX_TEMPLATE_VERSION } from "./runtime-contract.ts";
// ============================================
// WARM-ISOLATE REUSE (Worker Loader get())
// ============================================

// Local SHA-256 hex — no import to keep the hot runtime path free of a cycle
// into the trust/service graph. Used only to derive the get() reuse key.
async function sha256HexLocal(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Bump whenever the generated setup.js / wrapper.js TEMPLATE, the loadConfig
// shape (compatibilityDate, limits, binding wiring), or the fetch-body contract
// changes. Folded into the reuse key so a parent-worker deploy that changes the
// isolate's generated content can never collide with a still-cached old isolate
// under the same key. (bundleHash covers app.js; this covers everything the
// runtime generates around it.)
const CAPACITY_TAIL_MARKER = "GALACTIC_CAPACITY_EXECUTION_V1 ";

function hasDeclaredEffect(
  config: Pick<RuntimeConfig, "declaredEffects">,
  effect: GalacticStableEffectId,
): boolean {
  // null/undefined is the compatibility mode for manifest-only releases.
  return config.declaredEffects == null ||
    config.declaredEffects.includes(effect);
}

function exposeEffectInSandbox(
  config: Pick<RuntimeConfig, "declaredEffects" | "testMode">,
  effect: GalacticStableEffectId,
): boolean {
  // gx.test intentionally exposes recorder-backed capabilities even when the
  // function omitted them. That is how conformance observes and rejects an
  // undeclared attempt without ever reaching a live service.
  return config.testMode === true || hasDeclaredEffect(config, effect);
}

export function resolveRpcBindingMetering(
  config: Pick<RuntimeConfig, "cloudOperationMetering">,
  useGetReuse: boolean,
): {
  operationMetering: RuntimeConfig["cloudOperationMetering"];
  requireExecCtx: boolean;
} {
  // Subscription-capacity metering owns an in-memory collector whose methods
  // are intentionally host-local. Cloudflare RPC binding props are structured
  // cloned, so passing that collector across the boundary rejects the binding
  // before Agent code can run ("addLight(...) could not be cloned"). The
  // execution-context registry already carries the complete per-call context;
  // require the opaque handle for this mode and keep the RPC props JSON-only.
  // Legacy wallet metering remains clone-safe and preserves its load()-mode
  // props fallback.
  const hasHostLocalCapacityMeter =
    typeof config.cloudOperationMetering?.capacityMeter?.addLight ===
      "function";
  return {
    operationMetering: hasHostLocalCapacityMeter
      ? null
      : config.cloudOperationMetering,
    requireExecCtx: useGetReuse || hasHostLocalCapacityMeter,
  };
}

// Reuse eligibility lives in its own dependency-light module (imported above) so
// billing imports the SAME predicate — a divergent copy is a money bug (see the
// module doc). Re-exported for the existing runtime tests + call sites.
export { isolateReuseEligibility };

/**
 * Derive the Worker Loader `get()` reuse key for an execution.
 *
 * The key uniquely determines every BAKED input to the isolate, so Cloudflare's
 * rule ("same id ⟺ same content") holds and warm reuse is safe:
 *   - `appId` + `bundleHash`  ⇒ a different app or code version ⇒ different key.
 *   - `userId`                ⇒ an isolate is NEVER shared across users. This is
 *     the isolation linchpin: any residual shared-globalThis race is intra-user
 *     misattribution at worst, never cross-tenant.
 *   - `stateFingerprint`      ⇒ any per-user baked input change (secret rotation,
 *     grant/dependency change, BYOK key, envVars, user, egress allowlist, AI
 *     route) ⇒ a fresh isolate, so a warm one never serves stale secrets/grants.
 *
 * The caller-context token's and routine context's PRESENCE are fingerprinted
 * (together they decide whether the EVENTS binding exists in the baked env),
 * but their VALUES are not — per-call identity resolves through the execution-
 * context registry, never baked content. Only functionName/args/authToken/
 * callerCtx/execCtxHandle vary within a key; those ride the fetch body.
 * Exported for unit-testing the isolation invariants.
 */
export async function deriveIsolateReuseKey(
  config: Pick<
    RuntimeConfig,
    | "appId"
    | "userId"
    | "user"
    | "envVars"
    | "permissions"
    | "declaredEffects"
    | "testMode"
    | "credentials"
    | "appCallDependencies"
    | "slotBindings"
    | "userApiKey"
    | "aiRoute"
    | "aiUnavailableReason"
    | "callerContextToken"
    | "routineContext"
    | "supabase"
    | "baseUrl"
    | "workerBaseUrl"
  >,
  esmCode: string,
  allowedDestinations: unknown,
  // Resolved binding-set state that is BAKED into loadConfig.env but not derived
  // from any other fingerprinted field: the D1 database id (lazily provisioned;
  // can transition null→id, or be re-provisioned to a new id, with no bundle
  // change) and whether the DB / MEMORY bindings were wired at all (depends on
  // getD1DatabaseId + memoryService, not just permissions). Without these, two
  // executions that differ only in binding presence/target would collide on one
  // warm isolate — a sticky "D1 not available" outage or a split-database write.
  bindingState: {
    dbId: string | null;
    hasDb: boolean;
    hasMemory: boolean;
    hasRuns: boolean;
  },
): Promise<string> {
  const bundleHash = await sha256HexLocal(esmCode);
  const stateFingerprint = await sha256HexLocal(JSON.stringify({
    // Version of the runtime-generated setup/wrapper template + loadConfig shape.
    tpl: GALACTIC_SANDBOX_TEMPLATE_VERSION,
    user: config.user ?? null,
    env: config.envVars ?? {},
    perms: [...(config.permissions ?? [])].sort(),
    effects: config.declaredEffects == null
      ? null
      : [...config.declaredEffects].sort(),
    // Changes AI/embed/notify from production RPC bindings to host-only stubs.
    testMode: config.testMode === true,
    // Credential VALUES are included: a rotation changes the fingerprint and
    // mints a fresh isolate, so a warm one never serves a stale secret.
    creds: config.credentials ?? {},
    deps: config.appCallDependencies ?? [],
    slots: config.slotBindings ?? [],
    byok: config.userApiKey ?? null,
    aiRoute: config.aiRoute ?? null,
    aiUnavailable: config.aiUnavailableReason ?? null,
    // Presence only — the token value is per-call and rides the fetch body.
    hasCallerCtx: !!config.callerContextToken,
    // Routine execution deliberately has no EVENTS binding (deferred fanout is
    // not yet attributable to the originating routine budget). This decision
    // is baked into setup.js/loadConfig.env, so routine and interactive calls
    // must never share a warm-isolate key.
    hasRoutineContext: !!config.routineContext,
    supabase: config.supabase ?? null,
    callBase: config.baseUrl || config.workerBaseUrl || "",
    dests: allowedDestinations ?? [],
    // Baked binding-set state (see param doc).
    dbId: bindingState.dbId,
    hasDb: bindingState.hasDb,
    hasMemory: bindingState.hasMemory,
    hasRuns: bindingState.hasRuns,
  }));
  return `${config.appId}:${bundleHash}:${config.userId}:${stateFingerprint}`;
}

// One captured galactic.ai() exchange, clipped in-sandbox (prompt/response
// ≤2000 chars each, ≤20 exchanges/execution). Persisted as routine_run_steps
// at settlement when the app opted into the flight recorder.
interface FlightAiExchange {
  at?: string;
  ms?: number;
  model?: string | null;
  cost_light?: number;
  prompt?: string;
  response?: string;
}

function structuredOutputErrorCode(value: unknown): string | undefined {
  return value === "invalid_output_schema" ||
      value === "structured_output_unsupported" ||
      value === "structured_output_invalid_json" ||
      value === "structured_output_schema_mismatch"
    ? value
    : undefined;
}

interface DynamicTestRuntimeSession {
  recordObservedEffect?(effect: UlTestObservedEffect): Promise<void>;
  sealAndSnapshot(): Promise<{
    blockedEffects: string[];
    observedEffects?: string[];
  }>;
  close(): Promise<void>;
}

interface DynamicTestRuntimeSessionNamespace {
  getByName(name: string): DynamicTestRuntimeSession;
}

interface DynamicTestRuntimeSnapshot {
  blockedEffects: string[];
  observedEffects: UlTestObservedEffect[];
}

const EMPTY_TEST_RUNTIME_SNAPSHOT: DynamicTestRuntimeSnapshot = {
  blockedEffects: [],
  observedEffects: [],
};

function gxTestContainmentError(blockedEffects: string[]) {
  return blockedEffects.length > 0
    ? {
      type: "GxTestEffectBlockedError",
      message: `gx.test blocked external effects without fixtures: ${
        blockedEffects.join(", ")
      }`,
      code: "GX_TEST_EFFECT_BLOCKED",
    } as const
    : undefined;
}

function normalizeTestRuntimeSnapshot(value: {
  blockedEffects?: unknown;
  observedEffects?: unknown;
}): DynamicTestRuntimeSnapshot {
  const blockedEffects = Array.isArray(value.blockedEffects)
    ? [...new Set(value.blockedEffects.filter(isUlTestBlockedEffect))].sort()
    : [];
  const observedEffects = Array.isArray(value.observedEffects)
    ? [...new Set(value.observedEffects.filter(isUlTestObservedEffect))]
      .sort()
      .slice(0, MAX_UL_TEST_OBSERVED_EFFECTS)
    : [];
  return { blockedEffects, observedEffects };
}

interface DynamicWorkerEntrypointExports {
  DatabaseBinding(
    input: {
      props: {
        databaseId: string;
        appId: string;
        userId: string;
        allowRead: boolean;
        allowWrite: boolean;
        operationMetering?: RuntimeConfig["cloudOperationMetering"];
        operationBillingConfig?: RuntimeConfig["cloudOperationBillingConfig"];
        requireExecCtx?: boolean;
      };
    },
  ): unknown;
  FixtureDatabaseBinding(
    input: {
      props: {
        appId: string;
        userId: string;
        fixtures: NonNullable<RuntimeConfig["d1Fixtures"]>;
        sessionName: string;
      };
    },
  ): unknown;
  AppDataBinding(
    input: {
      props: {
        appId: string;
        userId: string;
        allowRead: boolean;
        allowWrite: boolean;
        allowDelete: boolean;
        operationMetering?: RuntimeConfig["cloudOperationMetering"];
        operationBillingConfig?: RuntimeConfig["cloudOperationBillingConfig"];
        requireExecCtx?: boolean;
      };
    },
  ): unknown;
  MemoryBinding(
    input: {
      props: {
        userId: string;
        appId?: string | null;
        allowRead: boolean;
        allowWrite: boolean;
        operationMetering?: RuntimeConfig["cloudOperationMetering"];
        operationBillingConfig?: RuntimeConfig["cloudOperationBillingConfig"];
        requireExecCtx?: boolean;
      };
    },
  ): unknown;
  RunsBinding(
    input: {
      props: {
        appId: string;
        userId: string;
        requireExecCtx?: boolean;
      };
    },
  ): unknown;
  NotifyBinding(
    input: {
      props: {
        appId: string;
        userId: string;
        requireExecCtx?: boolean;
      };
    },
  ): unknown;
  GxTestSession: DynamicTestRuntimeSessionNamespace;
  TestAIBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  TestAppDataBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  TestMemoryBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  TestRunsBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  TestEmbedBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  TestNotifyBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  TestOutboundBinding(
    input: {
      props: {
        sessionName: string;
        fixtures: NonNullable<RuntimeConfig["httpFixtures"]>;
        allowedDestinations: string[];
      };
    },
  ): unknown;
  TestCredentialBinding(
    input: {
      props: {
        sessionName: string;
        fixtures: NonNullable<RuntimeConfig["httpFixtures"]>;
        allowedDestinations: string[];
        credentialDestinations: Record<string, string>;
      };
    },
  ): unknown;
  TestNetworkBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  TestEventsBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  TestAppCallBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  TestComputeBinding(
    input: { props: { sessionName: string } },
  ): unknown;
  ComputeBinding(input: {
    props: {
      userId: string;
      agentId: string;
      callerFunction: string;
      executionId: string;
      executionDeadlineAtMs: number;
      billingMode: "wallet" | "subscription_capacity";
      capacityAgentId: string;
      capacityReceiptId: string | null;
    };
  }): unknown;
  AIBinding(input: {
    props: {
      userId: string;
      appId: string | null;
      executionId: string | null;
      apiKey: string | null;
      provider: string | null;
      upstreamProvider: string | null;
      baseUrl: string | null;
      defaultModel: string | null;
      canonicalModelId: string | null;
      billingModelId: string | null;
      billingSource: string | null;
      keySource: string | null;
      requestDefaults: Record<string, unknown> | null;
      shouldDebitLight: boolean;
      shouldRequireBalance: boolean;
      modelPinned?: boolean;
      unavailableReason?: string | null;
      requireExecCtx?: boolean;
      routineContext?: RuntimeConfig["routineContext"] | null;
    };
  }): unknown;
  EmbedBinding(input: {
    props: {
      userId: string;
      appId: string;
      appVersion?: string | null;
      executionId?: string | null;
      userApiKey?: string | null;
      requireExecCtx?: boolean;
      routineContext?: RuntimeConfig["routineContext"] | null;
    };
  }): unknown;
  NetworkBinding(input: {
    props: {
      userId: string;
      appId: string;
      allowImap: boolean;
      allowSmtp: boolean;
      strictCredentialRoles: boolean;
      allowedDestinations: string[];
      credentials: Record<string, ResolvedCredential>;
    };
  }): unknown;
  EventsBinding(input: { props: Record<string, never> }): unknown;
  OutboundBinding(input: {
    props: {
      appId: string;
      userId: string;
      allowHttp: boolean;
      allowedDestinations: string[];
    };
  }): unknown;
  CredentialBinding(input: {
    props: {
      appId: string;
      userId: string;
      allowedDestinations: string[];
      credentials: Record<string, ResolvedCredential>;
    };
  }): unknown;
  CapacityDynamicTail(input: { props: Record<string, never> }): unknown;
}

type DynamicWorkerExecutionContext = ExecutionContext & {
  exports?: DynamicWorkerEntrypointExports;
};

export async function executeInDynamicSandbox(
  config: RuntimeConfig,
  functionName: string,
  args: unknown[],
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const testMode = config.testMode === true;
  const knownSecrets = collectRuntimeDiagnosticSecrets(config);
  const loader = globalThis.__env?.LOADER;
  // Per-execution context handle (registered before the loader fetch, resolved
  // by the bindings, deregistered in finally). Declared here so finally can
  // clean it up on every exit path.
  let execCtxHandle: string | null = null;
  // sha256 of the reuse key — set only on the warm-reuse (get) path; surfaced on
  // the ExecutionResult so settle keys the per-day load-floor dedup on the
  // DISTINCT isolate identity (once per CF-billable worker/day). Declared here so
  // both the success and error returns can carry it.
  let reuseKeyHash: string | null = null;
  let dynamicWorkerIdentityCreated = false;
  let dynamicWorkerInvoked = false;
  // Declared outside the main try so failure diagnostics can redact it even
  // when execution exits after the token was minted.
  let sandboxAuthToken: string | null = "";
  let testRuntimeSessionName: string | null = null;
  let testRuntimeSession: DynamicTestRuntimeSession | null = null;
  let testRuntimeSnapshotPromise: Promise<DynamicTestRuntimeSnapshot> | null =
    null;
  const snapshotTestRuntimeSession = (): Promise<
    DynamicTestRuntimeSnapshot
  > => {
    if (!testMode || !testRuntimeSession) {
      return Promise.resolve(EMPTY_TEST_RUNTIME_SNAPSHOT);
    }
    if (!testRuntimeSnapshotPromise) {
      testRuntimeSnapshotPromise = testRuntimeSession.sealAndSnapshot()
        .then(normalizeTestRuntimeSnapshot);
    }
    return testRuntimeSnapshotPromise;
  };

  if (config.capacityReceiptId && !testMode) {
    // The producer trace covers the entire admitted API invocation, including
    // bundle reads and validation that can fail before a Dynamic Worker starts.
    // Logging at the boundary keeps those real CPU milliseconds attributable;
    // the internal request header below correlates the child trace when present.
    console.log(
      `${CAPACITY_TAIL_MARKER}${
        JSON.stringify({
          receipt_id: config.capacityReceiptId,
        })
      }`,
    );
  }

  if (!loader) {
    return {
      success: false,
      result: null,
      logs: [],
      durationMs: Date.now() - startTime,
      aiCostLight: 0,
      ...(testMode ? { observedEffects: [] } : {}),
      error: {
        type: "RuntimeError",
        message: "Dynamic Worker LOADER binding not available",
      },
      diagnostic: normalizeOperatorDiagnostic({
        error: {
          type: "RuntimeError",
          message: "Dynamic Worker LOADER binding not available",
        },
        provenance: "platform",
        platform: {
          code: "SANDBOX_UNAVAILABLE",
          summary: "The execution sandbox is temporarily unavailable.",
          retryable: true,
        },
        knownSecrets,
      }),
    };
  }

  try {
    // 1. Get ESM bundle from KV
    const codeCacheKey = config.immutableReleaseDigest
      ? `esm:${config.appId}:release:${config.immutableReleaseDigest}`
      : config.immutableBundleVersion
      ? `esm:${config.appId}:${config.immutableBundleVersion}`
      : `esm:${config.appId}:latest`;
    if (config.cloudOperationMetering && !testMode) {
      await debitCloudOperation({
        ...config.cloudOperationMetering,
        resource: "kv_operation",
        operation: "code_cache.get",
        units: 1,
        billingConfig: config.cloudOperationBillingConfig ?? undefined,
        metadata: {
          ...(config.cloudOperationMetering.metadata ?? {}),
          key: codeCacheKey,
        },
      });
    }
    // Fetch the live bundle + its signed attestation atomically (one read), so
    // the bytes that run are exactly the bytes that get verified.
    const { code: esmCode, attestation } = config.immutableReleaseDigest
      ? await loadReleaseExecutedBundle(
        config.appId,
        config.immutableReleaseDigest,
      )
      : config.immutableBundleVersion
      ? await loadVersionedExecutedBundle(
        config.appId,
        config.immutableBundleVersion,
      )
      : await loadLiveExecutedBundle(config.appId);
    if (!esmCode) {
      // No ESM bundle — app hasn't been rebuilt. Can't execute without it.
      return {
        success: false,
        result: null,
        logs: [],
        durationMs: Date.now() - startTime,
        aiCostLight: 0,
        ...(testMode ? { observedEffects: [] } : {}),
        error: {
          type: "RuntimeError",
          message: config.immutableReleaseDigest ||
              config.immutableBundleVersion
            ? `No immutable ESM bundle found for app ${config.appId} release ${
              config.immutableReleaseDigest ??
                config.immutableBundleVersion
            }.`
            : `No ESM bundle found for app ${config.appId}. Run rebuild first.`,
        },
        diagnostic: normalizeOperatorDiagnostic({
          error: {
            type: "RuntimeError",
            message: config.immutableReleaseDigest ||
                config.immutableBundleVersion
              ? `No immutable ESM bundle found for app ${config.appId} release ${
                config.immutableReleaseDigest ??
                  config.immutableBundleVersion
              }.`
              : `No ESM bundle found for app ${config.appId}. Run rebuild first.`,
          },
          provenance: "platform",
          platform: {
            code: "RELEASE_NOT_BUILT",
            summary: "This Agent does not have an executable release.",
            detail: "Build and promote a release before running it again.",
            retryable: false,
          },
          knownSecrets,
        }),
      };
    }

    // 1b. Executed-bundle integrity: the bytes we're about to run must match the
    // attestation written atomically with them, and must not be a downgrade to an
    // old version. EXECUTED_BUNDLE_VERIFY=enforce refuses a violating bundle;
    // observe (default) only warns. Legacy (no attestation) + infra/secret errors
    // never block.
    const bundleVerifyMode = executedBundleVerifyMode();
    if (
      bundleVerifyMode !== "off" || config.routineContext ||
      config.immutableReleaseDigest
    ) {
      const verdict = await verifyExecutedBundle({
        appId: config.appId,
        esmCode,
        attestation,
        expectedVersion: config.expectedVersion,
        expectedReleaseDigest: config.immutableReleaseDigest,
      });
      if (
        handleExecutedBundleVerdict(
          config.appId,
          verdict,
          bundleVerifyMode,
          Boolean(config.routineContext || config.immutableReleaseDigest),
        )
      ) {
        return {
          success: false,
          result: null,
          logs: [],
          durationMs: Date.now() - startTime,
          aiCostLight: 0,
          ...(testMode ? { observedEffects: [] } : {}),
          error: {
            type: "IntegrityError",
            message:
              `Executed bundle failed integrity verification (${verdict.status})`,
          },
          diagnostic: normalizeOperatorDiagnostic({
            error: {
              type: "IntegrityError",
              message:
                `Executed bundle failed integrity verification (${verdict.status})`,
            },
            provenance: "platform",
            platform: {
              code: "RELEASE_INTEGRITY_FAILED",
              summary: "The executable release failed integrity verification.",
              retryable: false,
            },
            knownSecrets,
          }),
        };
      }
    }

    // 2. Build setup module — sets globalThis.ultralight with lazy getters
    // User context and env vars are baked in as literals (they're per-request constants)
    const userJson = config.user ? JSON.stringify(config.user) : "null";
    const envVarsJson = JSON.stringify(config.envVars || {});
    const callBaseUrl = JSON.stringify(
      testMode ? "" : config.baseUrl || config.workerBaseUrl || "",
    );
    // SECURITY: never inject the caller's raw bearer. App code can read this
    // value (e.g. globalThis.ultralight.call.toString()), so mint a short-lived
    // token scoped to this app's allowed call targets instead. The user's real
    // ul_ key never enters the sandbox.
    const permits = (permission: string) =>
      config.permissions.includes(permission);
    const exposesPermissionEffect = (
      effect: GalacticStableEffectId,
      permission: string,
    ) =>
      testMode ||
      (hasDeclaredEffect(config, effect) && permits(permission));
    const allowsStorageRead = exposesPermissionEffect(
      "storage.read",
      "storage:read",
    );
    const allowsStorageWrite = exposesPermissionEffect(
      "storage.write",
      "storage:write",
    );
    const allowsStorageDelete = exposesPermissionEffect(
      "storage.delete",
      "storage:delete",
    );
    const allowsMemoryRead = exposesPermissionEffect(
      "memory.read",
      "memory:read",
    );
    const allowsMemoryWrite = exposesPermissionEffect(
      "memory.write",
      "memory:write",
    );
    const allowsDatabaseRead = exposeEffectInSandbox(
      config,
      "database.read",
    );
    const allowsDatabaseWrite = exposeEffectInSandbox(
      config,
      "database.write",
    );
    const allowsRoutineRead = testMode ||
      (config.flightRecorder === true &&
        hasDeclaredEffect(config, "routine.read"));
    const allowsNotify = exposesPermissionEffect(
      "notification.owner.write",
      "notify:owner",
    );
    const allowsInferenceGenerate = exposesPermissionEffect(
      "inference.generate",
      "ai:call",
    );
    const allowsInferenceEmbed = exposesPermissionEffect(
      "inference.embed",
      "ai:embed",
    );
    const allowsCompute = exposesPermissionEffect(
      "compute.execute",
      COMPUTE_EXEC_PERMISSION,
    );
    const allowsNetworkHttp = exposesPermissionEffect(
      "network.http",
      "net:fetch",
    );
    const allowsCredentialHttp = exposesPermissionEffect(
      "credential.http",
      "net:fetch",
    );
    const allowsImap = exposesPermissionEffect(
      "email.imap.read",
      "net:connect",
    );
    const allowsSmtp = exposesPermissionEffect(
      "email.smtp.send",
      "net:connect",
    );
    const allowsEventPublish = exposeEffectInSandbox(
      config,
      "event.publish",
    );
    const hasConfiguredAppCall = permits("app:call") ||
      (config.appCallDependencies?.length ?? 0) > 0 ||
      (config.slotBindings?.length ?? 0) > 0;
    const allowsAgentCall = testMode ||
      (hasDeclaredEffect(config, "agent.call") && hasConfiguredAppCall);
    const testHasAppCall = allowsAgentCall;
    sandboxAuthToken = testMode
      ? (testHasAppCall ? "gx-test-blocked-app-call" : "")
      : await mintSandboxAuthToken({
        user: config.user,
        appId: config.appId,
        executionId: config.executionId,
        hasBroadCallPermission: config.permissions.includes("app:call"),
        dependencyAppIds: (config.appCallDependencies || [])
          .map((dependency) => dependency.app)
          .filter(Boolean),
        routineContext: config.routineContext,
        routineCapabilities: config.routineCapabilityCeiling,
      });
    const slotBindingsJson = JSON.stringify(config.slotBindings || []);
    const callDependenciesJson = JSON.stringify(
      config.appCallDependencies || [],
    );

    const setupModule = `
// Setup module — runs before app.js, sets globalThis.ultralight
// RPC bindings (__rpcEnv) are set later by wrapper.js fetch() handler.
// Lazy getters defer RPC calls until function execution time.
let __rpcEnv = {};

// Every promise returned by a host RPC or outbound fetch remains part of the
// current invocation even when tenant code forgets to await it. The wrapper
// drains this set before returning its response, so gx.test cannot seal its
// effect transcript while a fire-and-forget write is still in flight.
const __galacticPendingEffects = new Set();
const __galacticPendingAdd = Set.prototype.add.bind(
  __galacticPendingEffects,
);
const __galacticPendingDelete = Set.prototype.delete.bind(
  __galacticPendingEffects,
);
const __galacticPendingValues = Set.prototype.values.bind(
  __galacticPendingEffects,
);
const __galacticPendingSize = Object.getOwnPropertyDescriptor(
  Set.prototype,
  'size',
).get.bind(__galacticPendingEffects);
const __galacticPromiseResolve = Promise.resolve.bind(Promise);
const __galacticPromiseAllSettled = Promise.allSettled.bind(Promise);
const __galacticPromiseThen = Function.call.bind(Promise.prototype.then);
const __galacticReflectGet = Reflect.get;
const __galacticReflectApply = Reflect.apply;
const __galacticArrayFrom = Array.from;
const __GalacticProxy = Proxy;
function __trackGalacticEffectPromise(value) {
  if (!value || typeof value.then !== 'function') return value;
  const promise = __galacticPromiseResolve(value);
  __galacticPendingAdd(promise);
  // Register both outcomes without replacing the promise returned to tenant
  // code. This suppresses an unhandled-rejection race while preserving normal
  // await/catch behavior for the caller.
  __galacticPromiseThen(
    promise,
    function() { __galacticPendingDelete(promise); },
    function() { __galacticPendingDelete(promise); },
  );
  return promise;
}

const __galacticRpcProxyCache = new WeakMap();
const __galacticRpcProxyGet = WeakMap.prototype.get.bind(
  __galacticRpcProxyCache,
);
const __galacticRpcProxySet = WeakMap.prototype.set.bind(
  __galacticRpcProxyCache,
);
function __trackGalacticRpcValue(value) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) return value;
  const cached = __galacticRpcProxyGet(value);
  if (cached) return cached;
  const proxy = new __GalacticProxy(value, {
    get(target, property) {
      const member = __galacticReflectGet(target, property, target);
      if (typeof member === 'function') {
        return function(...args) {
          return __trackGalacticEffectPromise(
            __galacticReflectApply(member, target, args),
          );
        };
      }
      return __trackGalacticRpcValue(member);
    },
  });
  __galacticRpcProxySet(value, proxy);
  return proxy;
}

export function __setGalacticRpcEnv(env) {
  __rpcEnv = __trackGalacticRpcValue(env);
}

export async function __drainGalacticPendingEffects() {
  let passes = 0;
  while (__galacticPendingSize() > 0) {
    passes += 1;
    if (passes > 64) {
      throw new Error(
        'Agent kept scheduling effects after its function returned.',
      );
    }
    const pending = __galacticArrayFrom(__galacticPendingValues());
    await __galacticPromiseAllSettled(pending);
    // Let continuations register any effects they start before testing the set
    // again. The sandbox's outer deadline remains the hard upper time bound.
    await Promise.resolve();
  }
}

// Raw fetch is an effect surface too. Wrap it before app.js evaluates so even
// a captured or fire-and-forget fetch participates in the invocation drain.
const __galacticPlatformFetch = globalThis.fetch;
if (typeof __galacticPlatformFetch === 'function') {
  globalThis.fetch = function(...args) {
    return __trackGalacticEffectPromise(
      __galacticReflectApply(__galacticPlatformFetch, globalThis, args),
    );
  };
}

function __ulAllowsAppCall(targetAppId, functionName) {
  if (!${allowsAgentCall}) return false;
  if (${testMode || config.permissions.includes("app:call")}) return true;
  if (typeof targetAppId !== 'string' || typeof functionName !== 'string') return false;
  var target = targetAppId.trim();
  var fnName = functionName.trim();
  if (!target || !fnName) return false;
  var dependencies = ${callDependenciesJson};
  return dependencies.some(function(dep) {
    if (!dep || dep.access && dep.access !== 'read' && dep.access !== 'write') return false;
    if (typeof dep.app !== 'string' || dep.app.trim() !== target) return false;
    if (!Array.isArray(dep.functions)) return false;
    return dep.functions.some(function(fn) { return typeof fn === 'string' && fn.trim() === fnName; });
  });
}

// Workers RPC normalizes custom Error subclasses. The parent therefore returns
// a by-value result envelope and this untrusted isolate reconstructs the public
// SDK error locally. Only a closed COMPUTE_* code and a bounded public message
// may cross this boundary.
function __unwrapComputeRpc(envelope) {
  if (
    envelope && envelope.ok === true &&
    Object.prototype.hasOwnProperty.call(envelope, 'value')
  ) {
    return envelope.value;
  }
  if (
    envelope && envelope.ok === false && envelope.error &&
    typeof envelope.error.code === 'string' &&
    /^COMPUTE_[A-Z0-9_]{1,56}$/.test(envelope.error.code) &&
    typeof envelope.error.message === 'string' &&
    envelope.error.message.length > 0 &&
    envelope.error.message.length <= 1024
  ) {
    var expected = new Error(
      'galactic.compute failed (' + envelope.error.code + '): ' +
      envelope.error.message
    );
    expected.name = 'GalacticComputeError';
    expected.galacticDetails = { code: envelope.error.code };
    throw expected;
  }
  var unavailable = new Error(
    'galactic.compute failed (COMPUTE_CONTROL_PLANE_UNAVAILABLE): ' +
    'Galactic Compute control plane is unavailable.'
  );
  unavailable.name = 'GalacticComputeError';
  unavailable.galacticDetails = { code: 'COMPUTE_CONTROL_PLANE_UNAVAILABLE' };
  throw unavailable;
}

// Callable function object: galactic.compute(request), with status and
// cancellation methods namespaced on the same capability. All three calls go
// through the parent-isolate RPC binding. The body receives no user bearer,
// platform key, control-plane credential, lease token, or billing receipt.
function __galacticCompute(request) {
  var e = __rpcEnv;
  if (!e || !e.COMPUTE) {
    return Promise.reject(new Error('galactic.compute unavailable: add "compute:exec" to manifest permissions and run with an authenticated user context.'));
  }
  globalThis.__computeCallIndex = (globalThis.__computeCallIndex || 0) + 1;
  return e.COMPUTE.call(request || {}, globalThis.__computeCallIndex).then(__unwrapComputeRpc);
}
__galacticCompute.get = function(runId) {
  var e = __rpcEnv;
  if (!e || !e.COMPUTE) {
    return Promise.reject(new Error('galactic.compute.get unavailable: compute:exec permission and an authenticated user context are required.'));
  }
  return e.COMPUTE.get(runId).then(__unwrapComputeRpc);
};
__galacticCompute.cancel = function(runId) {
  var e = __rpcEnv;
  if (!e || !e.COMPUTE) {
    return Promise.reject(new Error('galactic.compute.cancel unavailable: compute:exec permission and an authenticated user context are required.'));
  }
  return e.COMPUTE.cancel(runId).then(__unwrapComputeRpc);
};

globalThis.ultralight = {
  get db() {
    const e = __rpcEnv;
    // Raw-SQL methods were removed in favour of the scoped structured API. Fail
    // loud with an actionable message if an old bundle still calls them.
    const __removed = function (name) {
      return function () {
        throw new Error('galactic.db.' + name + '() was removed. galactic.db is now a scoped, structured API — use galactic.db.select/first/insert/update/delete/upsert/count/batch. Raw SQL is no longer supported.');
      };
    };
    const __denied = function (effect) {
      return function () {
        throw new Error(effect + ' authority not granted for this function.');
      };
    };
    if (!e.DB) {
      const na = function () { throw new Error('D1 database not available. Add a migrations/ folder to your app.'); };
      return {
        select: na, first: na, count: na, insert: na, update: na, delete: na, upsert: na, batch: na,
        run: __removed('run'), all: __removed('all'), exec: __removed('exec'),
      };
    }
    return {
      // Reads
      select: ${
      allowsDatabaseRead
        ? "(table, query) => e.DB.select(Object.assign({ table: table }, query || {}), globalThis.__execHandle)"
        : "__denied('database.read')"
    },
      first: ${
      allowsDatabaseRead
        ? "(table, query) => e.DB.first(Object.assign({ table: table }, query || {}), globalThis.__execHandle)"
        : "__denied('database.read')"
    },
      count: ${
      allowsDatabaseRead
        ? "(table, query) => e.DB.count(Object.assign({ table: table }, query || {}), globalThis.__execHandle)"
        : "__denied('database.read')"
    },
      // Writes (user_id is injected host-side; app code never supplies it)
      insert: ${
      allowsDatabaseWrite
        ? "(table, values) => e.DB.insert({ table: table, values: values }, globalThis.__execHandle)"
        : "__denied('database.write')"
    },
      update: ${
      allowsDatabaseWrite
        ? "(table, spec) => e.DB.update(Object.assign({ table: table }, spec || {}), globalThis.__execHandle)"
        : "__denied('database.write')"
    },
      delete: ${
      allowsDatabaseWrite
        ? "(table, spec) => e.DB.delete(Object.assign({ table: table }, spec || {}), globalThis.__execHandle)"
        : "__denied('database.write')"
    },
      upsert: ${
      allowsDatabaseWrite
        ? "(table, spec) => e.DB.upsert(Object.assign({ table: table }, spec || {}), globalThis.__execHandle)"
        : "__denied('database.write')"
    },
      batch: ${
      allowsDatabaseWrite
        ? "(ops) => e.DB.batch(ops || [], globalThis.__execHandle)"
        : "__denied('database.write')"
    },
      // Removed raw-SQL surface
      run: __removed('run'), all: __removed('all'), exec: __removed('exec'),
    };
  },
  user: ${userJson},
  env: ${envVarsJson},
  isAuthenticated() { return ${config.user ? "true" : "false"}; },
  requireAuth() { ${
      config.user
        ? `return ${userJson};`
        : 'throw new Error("Authentication required.");'
    } },
  store(k, v) { if (!${allowsStorageWrite}) return Promise.reject(new Error('storage.write authority not granted for this function.')); const e = __rpcEnv; return e.DATA ? e.DATA.store(k, v, globalThis.__execHandle) : Promise.reject(new Error('Data not available')); },
  load(k) { if (!${allowsStorageRead}) return Promise.reject(new Error('storage.read authority not granted for this function.')); const e = __rpcEnv; return e.DATA ? e.DATA.load(k, globalThis.__execHandle) : Promise.resolve(null); },
  remove(k) { if (!${allowsStorageDelete}) return Promise.reject(new Error('storage.delete authority not granted for this function.')); const e = __rpcEnv; return e.DATA ? e.DATA.remove(k, globalThis.__execHandle) : Promise.reject(new Error('Data not available')); },
  list(p) { if (!${allowsStorageRead}) return Promise.reject(new Error('storage.read authority not granted for this function.')); const e = __rpcEnv; return e.DATA ? e.DATA.list(p, globalThis.__execHandle) : Promise.resolve([]); },
  query(p, o) { if (!${allowsStorageRead}) return Promise.reject(new Error('storage.read authority not granted for this function.')); const e = __rpcEnv; return e.DATA?.query?.(p, o, globalThis.__execHandle) || Promise.resolve([]); },
  remember(k, v, o) { if (!${allowsMemoryWrite}) return Promise.reject(new Error('memory.write authority not granted for this function.')); var s = (o && o.scope === 'user') ? 'user' : 'agent'; const e = __rpcEnv; return e.MEMORY ? e.MEMORY.remember(k, v, s, globalThis.__execHandle) : Promise.resolve(); },
  recall(k, o) { if (!${allowsMemoryRead}) return Promise.reject(new Error('memory.read authority not granted for this function.')); var s = (o && o.scope === 'user') ? 'user' : 'agent'; const e = __rpcEnv; return e.MEMORY ? e.MEMORY.recall(k, s, globalThis.__execHandle) : Promise.resolve(null); },
  // Flight recorder read-back: this agent's recent routine runs (+ recorded
  // steps, incl. captured ai() exchanges) for the CURRENT user. Wired only
  // when the manifest sets "flight_recorder": true.
  runs: {
    recent(o) { if (!${allowsRoutineRead}) return Promise.reject(new Error('routine.read authority not granted for this function.')); const e = __rpcEnv; if (!e.RUNS) return Promise.reject(new Error('galactic.runs unavailable: set "flight_recorder": true in the manifest.')); return e.RUNS.recent((o && o.limit) || 10, globalThis.__execHandle); },
  },
  // Owner notifications: one report to the CURRENT user's inbox bell. Kind,
  // identity, dedupe namespacing, and rate caps are enforced host-side.
  notify(o) { if (!${allowsNotify}) return Promise.reject(new Error('notification.owner.write authority not granted for this function.')); const e = __rpcEnv; return e.NOTIFY ? e.NOTIFY.notifyOwner(o || {}, globalThis.__execHandle) : Promise.reject(new Error('Notifications not available')); },
  compute: __galacticCompute,
  ai(r) { const e = __rpcEnv; if (!e.AI) return Promise.reject(new Error('galactic.ai unavailable: ai:call permission not granted or no authenticated user context.')); var __t0 = Date.now(); var __clip = function(v){ try { var s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > 2000 ? s.slice(0, 2000) + '…[truncated]' : (s || ''); } catch (_e) { return ''; } }; var __rec = function(resp, errMsg){ try { var f = globalThis.__flight; if (f && f.ai && f.ai.length < 20) f.ai.push({ at: new Date().toISOString(), ms: Date.now() - __t0, model: (resp && resp.model) || (r && r.model) || null, cost_light: (resp && resp.usage && resp.usage.cost_light) || 0, prompt: __clip(r && r.messages), response: errMsg ? ('[error] ' + __clip(errMsg)) : __clip(resp && resp.content) }); } catch (_e) {} }; return e.AI.call(r, globalThis.__execHandle).then(function(resp){ if (resp && resp.error) { __rec(null, resp.error); var err = new Error('galactic.ai failed: ' + resp.error); if (resp.error_code) err.code = resp.error_code; throw err; } try { globalThis.__aiCostLight = (globalThis.__aiCostLight || 0) + ((resp && resp.usage && resp.usage.cost_light) || 0); } catch (_e) {} __rec(resp); return resp; }); },
  embed(r) { const e = __rpcEnv; if (!e.EMBED) return Promise.reject(new Error('galactic.embed unavailable: ai:embed permission not granted or no authenticated user context.')); return e.EMBED.embed(r || {}, globalThis.__execHandle).then(function(resp){ try { globalThis.__aiCostLight = (globalThis.__aiCostLight || 0) + ((resp && resp.usage && resp.usage.cost_light) || 0); } catch (_e) {} return resp; }); },
  async call(targetAppId, functionName, callArgs) {
    if (!targetAppId || !functionName) throw new Error('target app id and function name are required');
    if (!__ulAllowsAppCall(targetAppId, functionName)) {
      throw new Error('app:call permission or a matching dependency is required');
    }
    // Per-request (set by wrapper.fetch from the request body) so a warm isolate
    // can be reused across this user's calls without baking a per-execution token
    // into module content. The token is a scoped, HMAC-signed server mint — a
    // sandbox cannot forge a valid one, and it only asserts THIS app's targets.
    var authToken = (globalThis.__ulReq && globalThis.__ulReq.authToken) || '';
    var baseUrl = ${callBaseUrl};
    var e = __rpcEnv;
    var useSelf = !!(e && e.SELF);
    if (!authToken || (!useSelf && !baseUrl)) throw new Error('Inter-app calls not available (missing baseUrl or authToken)');
    var fetchFn = useSelf ? e.SELF.fetch.bind(e.SELF) : fetch;
    var endpoint = useSelf
      ? 'https://internal/mcp/' + encodeURIComponent(targetAppId)
      : baseUrl.replace(/\\/$/, '') + '/mcp/' + encodeURIComponent(targetAppId);
    var __headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken };
    // Unforgeable caller identity (minted server-side, asserts only this app).
    // The target uses it to run the cross-Agent grant check. Per-request (from
    // the fetch body, like authToken): the token bakes in the per-call entry
    // function + incoming hop, so a value frozen into warm-reused module content
    // would report a stale hop and defeat the hop ceiling.
    var __callerCtx = (globalThis.__ulReq && globalThis.__ulReq.callerCtx) || '';
    if (__callerCtx) __headers['X-Galactic-Caller'] = __callerCtx;
    var rpcResponse = null;
    // One short in-place retry handles transient distributed concurrency
    // without re-running the caller (which may already have side effects).
    // The target's admission denial proves target code did not start.
    for (var __callAttempt = 0; __callAttempt < 2; __callAttempt++) {
      var response = await fetchFn(endpoint, {
        method: 'POST',
        headers: __headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: crypto.randomUUID(),
          method: 'tools/call',
          params: { name: functionName, arguments: callArgs || {} }
        })
      });
      if (!response.ok) {
        var errorText = await response.text().catch(function() { return response.statusText; });
        throw new Error('galactic.call failed (' + response.status + '): ' + errorText);
      }
      rpcResponse = await response.json();
      var __waitDetails = rpcResponse && rpcResponse.error && rpcResponse.error.data;
      if (__callAttempt === 0 && __waitDetails && __waitDetails.type === 'concurrency_waiting') {
        var __retryAtMs = Date.parse(__waitDetails.retry_at || '');
        var __retryDelayMs = Number.isFinite(__retryAtMs)
          ? Math.min(15000, Math.max(250, __retryAtMs - Date.now() + 50))
          : 1000;
        await new Promise(function(resolve) { setTimeout(resolve, __retryDelayMs); });
        continue;
      }
      break;
    }
    if (rpcResponse.error) {
      var __rpcDetails = rpcResponse.error.data || null;
      var __rpcType = __rpcDetails && __rpcDetails.type;
      var __rpcError = new Error('galactic.call RPC error: ' + (rpcResponse.error.message || JSON.stringify(rpcResponse.error)));
      if (__rpcType === 'agent_cap_too_low_for_request') __rpcError.name = 'AgentCapacityCapTooLowError';
      else if (__rpcType === 'agent_cap_waiting' || __rpcType === 'capacity_waiting') __rpcError.name = 'AgentCapacityWaitingError';
      else if (__rpcType === 'concurrency_waiting') __rpcError.name = 'ConcurrencyWaitingError';
      if (__rpcType && (__rpcError.name === 'AgentCapacityCapTooLowError' || __rpcError.name === 'AgentCapacityWaitingError' || __rpcError.name === 'ConcurrencyWaitingError')) __rpcError.galacticDetails = __rpcDetails;
      throw __rpcError;
    }
    var result = rpcResponse.result;
    if (result && Array.isArray(result.content)) {
      var textBlock = result.content.find(function(c) { return c && c.type === 'text'; });
      if (textBlock && textBlock.text) {
        try { return JSON.parse(textBlock.text); } catch (_) { return textBlock.text; }
      }
    }
    return result;
  },
  // Publish a pub/sub event. Unprivileged — a subscriber only receives it if
  // the USER wired a subscribe grant. Routed through the EVENTS RPC binding,
  // which verifies the signed caller context host-side to fix the emitter app +
  // user + hop unforgeably. The platform worker secret never enters the sandbox.
  // Capped per execution to bound emit storms.
  async emit(topic, payload) {
    if (!${allowsEventPublish}) throw new Error('event.publish authority not granted for this function.');
    if (${!!config
      .routineContext}) throw new Error('galactic.emit is unavailable during routine execution: deferred event fanout is not yet budget-attributed.');
    if (!topic || typeof topic !== 'string') throw new Error('emit requires a topic string');
    var e = __rpcEnv;
    if (!e || !e.EVENTS) throw new Error('emit requires an authenticated user context');
    globalThis.__emitCount = (globalThis.__emitCount || 0) + 1;
    if (globalThis.__emitCount > 50) throw new Error('emit limit reached for this execution');
    // Fail fast on an oversized payload (the server enforces a 32KB payload cap
    // authoritatively; this just avoids a wasted RPC with a clearer error).
    if (JSON.stringify(payload || {}).length > 64 * 1024) throw new Error('emit payload too large (max 32KB)');
    return await e.EVENTS.emit(topic, payload || {}, globalThis.__execHandle);
  },
  // Resolve a logical slot (declared in this Agent's manifest imports) to the
  // concrete target the user wired it to. Only the granted functions are
  // exposed; each routes through ultralight.call (grant-gated at the target).
  use(slotName) {
    var slots = ${slotBindingsJson};
    var binding = slots.find(function(s) { return s && s.slot === slotName; });
    if (!binding) {
      throw new Error('No Agent is wired to slot "' + slotName + '". Bind it on the Agent page.');
    }
    var api = {};
    (binding.functions || []).forEach(function(fn) {
      api[fn] = function(args) { return globalThis.galactic.call(binding.targetAppId, fn, args); };
    });
    return api;
  },
  // Authenticated fetch (Phase 3 vault): attach a vaulted per-user credential to
  // an outbound request BY KEY. The secret value is applied host-side in the
  // parent isolate — app code never receives it — and only reaches the
  // credential's declared destination. Returns the Response.
  async fetch(credentialKey, url, init) {
    if (!${allowsCredentialHttp}) {
      throw new Error('credential.http authority not granted for this function.');
    }
    var e = __rpcEnv;
    if (!e || !e.CREDENTIALS) {
      throw new Error('No vaulted credentials are configured for this Agent.');
    }
    return await e.CREDENTIALS.authenticatedFetch(credentialKey, url, init || {});
  },
  // net:connect — high-level protocol methods run host-side in the NET RPC
  // binding (cloudflare:sockets). No worker secret is exposed to app code.
  net: {
    async imapFetchUnseen(hostKey, port, userKey, passKey, lastUid, businessEmail, processedFlag, limit) {
      if (!${allowsImap}) throw new Error('email.imap.read authority not granted for this function.');
      var e = __rpcEnv;
      if (!e || !e.NET) throw new Error('net:connect not available');
      return await e.NET.imapFetchUnseen(hostKey, port, userKey, passKey, lastUid || 0, businessEmail || '', processedFlag || '$ULProcessed', limit || 20);
    },
    async smtpSend(hostKey, port, userKey, passKey, from, fromName, to, subject, body, inReplyTo) {
      if (!${allowsSmtp}) throw new Error('email.smtp.send authority not granted for this function.');
      var e = __rpcEnv;
      if (!e || !e.NET) throw new Error('net:connect not available');
      return await e.NET.smtpSend(hostKey, port, userKey, passKey, from, fromName || '', to, subject, body, inReplyTo || '');
    },
    connectTls() { throw new Error('Raw TCP sockets are not exposed in this runtime. Use managed email methods or HTTPS fetch.'); },
  },
};
// galactic.* is the canonical namespace; ultralight.* is a permanent alias so
// every already-deployed bundle keeps working. Same object, two names.
globalThis.galactic = globalThis.ultralight;
`;

    // 3. Build wrapper module — entry point, sets RPC env, calls function.
    // functionName + args are NOT baked here — they arrive per-request in the
    // fetch body so the isolate content is identical across this user's calls
    // (the precondition for warm reuse via loader.get()).
    const wrapperModule = `
import {
  __drainGalacticPendingEffects,
  __setGalacticRpcEnv,
} from './setup.js';
import * as appModule from './app.js';

export default {
  async fetch(request, env) {
    // A warm Worker Loader isolate may receive concurrent fetches. The SDK's
    // compatibility globals are per-isolate, so serialize each isolate's
    // request bodies: without this gate one call can overwrite another call's
    // opaque execution handle, routine context, flight capture, or logs while
    // the first is awaiting IO. Account/Agent concurrency still runs across
    // distinct isolates; correctness takes precedence over same-isolate
    // overlap until the SDK moves to request-local async context.
    const __previousExecution = globalThis.__galacticExecutionTail || Promise.resolve();
    let __releaseExecution;
    const __executionDone = new Promise(function(resolve) { __releaseExecution = resolve; });
    globalThis.__galacticExecutionTail = __previousExecution.catch(function() {}).then(function() { return __executionDone; });
    await __previousExecution.catch(function() {});
    let functionInvoked = false;
    try {
    // Set RPC bindings for lazy getters in ultralight SDK
    __setGalacticRpcEnv(env);
    // Per-request payload — the ONLY per-execution data, read fresh each fetch so
    // a warm isolate can be reused across this user's calls. functionName + args
    // select what runs; authToken is the scoped inter-app call token; callerCtx
    // is the signed caller-context header value; execCtxHandle is the opaque
    // billing-context handle (the parent registered the real context under it —
    // payer/receipt identity never enters the sandbox). The per-isolate gate
    // above prevents these compatibility globals from crossing requests.
    let __req = {};
    try { __req = await request.json(); } catch (_e) { __req = {}; }
    globalThis.__execHandle = (__req && __req.execCtxHandle) || null;
    globalThis.__ulReq = {
      authToken: (__req && __req.authToken) || '',
      callerCtx: (__req && __req.callerCtx) || '',
    };
    // Reset the per-execution accumulators. Isolates may be warm-reused
    // (loader.get), so resetting per fetch keeps per-grant AI-cap accounting
    // plus compute admission idempotency and the per-execution emit cap correct.
    globalThis.__aiCostLight = 0;
    globalThis.__emitCount = 0;
    globalThis.__computeCallIndex = 0;
    // Flight capture: bounded per-execution record of ai() exchanges (clipped
    // prompt/response), returned in the result envelope. Persistence is the
    // HOST's decision (manifest flight_recorder + routine context) — capture
    // itself is unconditional so the baked module text never varies.
    globalThis.__flight = { ai: [] };

    const logs = [];
    const con = {
      log: (...a) => logs.push({ time: new Date().toISOString(), level: 'log', message: a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') }),
      error: (...a) => logs.push({ time: new Date().toISOString(), level: 'error', message: a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') }),
      warn: (...a) => logs.push({ time: new Date().toISOString(), level: 'warn', message: a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') }),
      info: (...a) => logs.push({ time: new Date().toISOString(), level: 'info', message: a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') }),
    };
    globalThis.console = con;

    try {
      const fnName = (__req && typeof __req.functionName === 'string') ? __req.functionName : '';
      const fnArgs = (__req && Array.isArray(__req.args)) ? __req.args : [];

      let targetFn = appModule[fnName];
      if (!targetFn && appModule.default && typeof appModule.default === 'object') {
        targetFn = appModule.default[fnName];
      }

      if (!targetFn || typeof targetFn !== 'function') {
        const available = [];
        for (const k of Object.keys(appModule)) { if (typeof appModule[k] === 'function') available.push(k); }
        if (appModule.default && typeof appModule.default === 'object') {
          for (const k of Object.keys(appModule.default)) { if (typeof appModule.default[k] === 'function') available.push(k); }
        }
        return Response.json({
          success: false, functionInvoked, result: null, logs, aiCostLight: globalThis.__aiCostLight || 0, flight: globalThis.__flight,
          error: { type: 'FunctionNotFound', message: 'Function "' + fnName + '" not found. Available: ' + [...new Set(available)].join(', ') },
        });
      }

      functionInvoked = true;
      const result = await targetFn(...fnArgs);
      await __drainGalacticPendingEffects();
      return Response.json({ success: true, functionInvoked, result, logs, aiCostLight: globalThis.__aiCostLight || 0, flight: globalThis.__flight });
    } catch (err) {
      await __drainGalacticPendingEffects();
      return Response.json({
        success: false, functionInvoked, result: null, logs, aiCostLight: globalThis.__aiCostLight || 0, flight: globalThis.__flight,
        error: { type: err.name || err.constructor?.name || 'Error', message: err.message || String(err), ...(typeof err.code === 'string' ? { code: err.code } : {}), ...(err.galacticDetails ? { details: err.galacticDetails } : {}) },
      });
    }
    } finally {
      __releaseExecution();
    }
  }
};
`;

    // Warm-isolate reuse decision (needed before binding construction: reused
    // isolates get requireExecCtx bindings that refuse any RPC arriving without
    // a resolvable per-call context handle — closing the direct-binding bypass
    // where app code calls a raw binding itself, skipping the SDK's handle
    // threading, to get operations metered against a stale baked hold).
    // Compute-capable Agents intentionally stay on one fresh isolate per
    // invocation. Compute authority is fixed in the binding's trusted ctx.props;
    // reusing an isolate would retain the first invocation's function, execution,
    // deadline, and billing route. The control plane still checks every call,
    // but stale request-local identity must never reach it in the first place.
    const useGetReuse = getEnv("EXECUTED_LOADER_GET_REUSE") === "1" &&
      typeof loader.get === "function" &&
      isolateReuseEligibility(config).eligible;

    const {
      operationMetering: bindingOperationMetering,
      requireExecCtx: requireBindingExecCtx,
    } = resolveRpcBindingMetering(config, useGetReuse);

    // 4. Create RPC bindings
    const ctx = globalThis.__ctx as DynamicWorkerExecutionContext;
    const bindings: Record<string, unknown> = {};
    const hasStorageRead = allowsStorageRead;
    const hasStorageWrite = allowsStorageWrite;
    const hasStorageDelete = allowsStorageDelete;
    const hasMemory = allowsMemoryRead || allowsMemoryWrite;
    const hasDatabase = allowsDatabaseRead || allowsDatabaseWrite;
    const hasNetworkBinding = testMode || allowsImap || allowsSmtp;
    const hasInterAppCall = allowsAgentCall;

    if (testMode) {
      const requiredTestExports = [
        "TestOutboundBinding",
        "TestCredentialBinding",
        "TestEventsBinding",
        "TestAppDataBinding",
        "TestMemoryBinding",
        "TestRunsBinding",
        "TestNotifyBinding",
        "TestAIBinding",
        "TestEmbedBinding",
        "TestNetworkBinding",
        "TestAppCallBinding",
        "TestComputeBinding",
        "FixtureDatabaseBinding",
      ] as const;
      const availableExports = (ctx?.exports ?? {}) as unknown as Record<
        string,
        unknown
      >;
      const missingTestExports = requiredTestExports.filter(
        (name) => typeof availableExports[name] !== "function",
      );
      if (missingTestExports.length > 0) {
        throw new Error(
          `gx.test runtime is unavailable: missing host exports ${
            missingTestExports.join(", ")
          }`,
        );
      }

      const sessionNamespace = availableExports.GxTestSession as
        | DynamicTestRuntimeSessionNamespace
        | undefined;
      if (
        !sessionNamespace ||
        typeof sessionNamespace.getByName !== "function"
      ) {
        throw new Error(
          "gx.test runtime is unavailable: missing host export GxTestSession",
        );
      }
      testRuntimeSessionName = `gx-test-${crypto.randomUUID()}`;
      testRuntimeSession = sessionNamespace.getByName(testRuntimeSessionName);
      if (
        !testRuntimeSession ||
        typeof testRuntimeSession.sealAndSnapshot !== "function" ||
        typeof testRuntimeSession.close !== "function"
      ) {
        throw new Error(
          "gx.test runtime is unavailable: invalid state session capability",
        );
      }
    }

    const persistentTestSessionName = (): string => {
      if (!testRuntimeSessionName) {
        throw new Error("gx.test state session name is unavailable");
      }
      // Props cross the Worker Loader boundary as plain data only. Each trusted
      // test binding resolves this same name through its own host export, while
      // the caller retains the authoritative stub for snapshot and cleanup.
      return testRuntimeSessionName;
    };
    // Resolved D1 database id baked into the DB binding props — captured here so
    // the reuse key can fingerprint it (it is lazily provisioned / re-provisioned
    // independently of the bundle). null when no live DB binding is wired.
    let resolvedDbId: string | null = null;

    if (testMode && ctx?.exports?.FixtureDatabaseBinding) {
      bindings.DB = ctx.exports.FixtureDatabaseBinding({
        props: {
          appId: config.appId,
          userId: config.userId,
          // An empty fixture set still installs the padded-room binding. It
          // records the attempted DB effect, then fails closed with the normal
          // fixture-miss diagnostic instead of hiding an undeclared attempt.
          fixtures: config.d1Fixtures ?? { responses: [] },
          sessionName: persistentTestSessionName(),
        },
      });
    } else if (!testMode && hasDatabase && config.d1DataService) {
      const { getD1DatabaseId } = await import(
        "../services/d1-provisioning.ts"
      );
      const dbId = await getD1DatabaseId(config.appId);
      resolvedDbId = dbId ?? null;
      if (dbId && ctx?.exports?.DatabaseBinding) {
        bindings.DB = ctx.exports.DatabaseBinding({
          props: {
            databaseId: dbId,
            appId: config.appId,
            userId: config.userId,
            allowRead: allowsDatabaseRead,
            allowWrite: allowsDatabaseWrite,
            operationMetering: bindingOperationMetering,
            operationBillingConfig: config.cloudOperationBillingConfig,
            requireExecCtx: requireBindingExecCtx,
          },
        });
      }
    }

    if (hasStorageRead || hasStorageWrite || hasStorageDelete) {
      if (testMode) {
        if (ctx?.exports?.TestAppDataBinding) {
          bindings.DATA = ctx.exports.TestAppDataBinding({
            props: { sessionName: persistentTestSessionName() },
          });
        }
      } else if (ctx?.exports?.AppDataBinding) {
        bindings.DATA = ctx.exports.AppDataBinding({
          props: {
            appId: config.appId,
            userId: config.userId,
            allowRead: allowsStorageRead,
            allowWrite: allowsStorageWrite,
            allowDelete: allowsStorageDelete,
            operationMetering: bindingOperationMetering,
            operationBillingConfig: config.cloudOperationBillingConfig,
            requireExecCtx: requireBindingExecCtx,
          },
        });
      }
    }

    if (hasMemory) {
      if (testMode) {
        if (ctx?.exports?.TestMemoryBinding) {
          bindings.MEMORY = ctx.exports.TestMemoryBinding({
            props: { sessionName: persistentTestSessionName() },
          });
        }
      } else if (config.memoryService && ctx?.exports?.MemoryBinding) {
        bindings.MEMORY = ctx.exports.MemoryBinding({
          props: {
            userId: config.userId,
            // Agent-scoped memory by default: each agent gets its own notebook
            // keyed by appId so remember/recall can't collide across the agents
            // a user runs. scope:"user" deliberately reaches shared memory.
            appId: config.appId,
            allowRead: allowsMemoryRead,
            allowWrite: allowsMemoryWrite,
            operationMetering: bindingOperationMetering,
            operationBillingConfig: config.cloudOperationBillingConfig,
            requireExecCtx: requireBindingExecCtx,
          },
        });
      }
    }

    // Flight recorder read-back (manifest flight_recorder): the agent can list
    // its own recent routine runs + recorded steps for the CURRENT user. The
    // (appId, userId) scope is baked host-side — sandbox code cannot widen it.
    if (allowsRoutineRead) {
      if (testMode) {
        if (ctx?.exports?.TestRunsBinding) {
          bindings.RUNS = ctx.exports.TestRunsBinding({
            props: { sessionName: persistentTestSessionName() },
          });
        }
      } else if (ctx?.exports?.RunsBinding) {
        bindings.RUNS = ctx.exports.RunsBinding({
          props: {
            appId: config.appId,
            userId: config.userId,
            requireExecCtx: useGetReuse,
          },
        });
      }
    }

    // gx.test is a host-selected execution mode: declared capabilities remain
    // visible to the code, but provider/billing/inbox side effects are replaced
    // with deterministic parent-worker RPC stubs. If a test binding export is
    // missing, fail closed by leaving the capability unavailable; never fall
    // through to its production binding.
    if (allowsNotify) {
      if (config.testMode === true) {
        if (ctx?.exports?.TestNotifyBinding) {
          bindings.NOTIFY = ctx.exports.TestNotifyBinding({
            props: { sessionName: persistentTestSessionName() },
          });
        }
      } else if (ctx?.exports?.NotifyBinding) {
        // Owner notifications (manifest notify:owner): self-notification only.
        bindings.NOTIFY = ctx.exports.NotifyBinding({
          props: {
            appId: config.appId,
            userId: config.userId,
            requireExecCtx: useGetReuse,
          },
        });
      }
    }

    if (allowsInferenceGenerate) {
      if (config.testMode === true) {
        if (ctx?.exports?.TestAIBinding) {
          bindings.AI = ctx.exports.TestAIBinding({
            props: { sessionName: persistentTestSessionName() },
          });
        }
      } else if (ctx?.exports?.AIBinding) {
        bindings.AI = ctx.exports.AIBinding({
          props: {
            userId: config.userId,
            // appId is stable for the isolate's lifetime (reuse key includes the
            // app), so props are a safe legacy fallback — unlike functionName,
            // which is per-call and resolves via the execution context only.
            appId: config.appId || null,
            executionId: config.executionId || null,
            apiKey: config.aiRoute?.apiKey || config.userApiKey,
            provider: config.aiRoute?.provider || null,
            upstreamProvider: config.aiRoute?.upstreamProvider ||
              config.aiRoute?.provider || null,
            baseUrl: config.aiRoute?.baseUrl || null,
            defaultModel: config.aiRoute?.model || null,
            canonicalModelId: config.aiRoute?.canonicalModelId || null,
            billingModelId: config.aiRoute?.billingModelId || null,
            billingSource: config.aiRoute?.billingSource || null,
            keySource: config.aiRoute?.keySource || null,
            requestDefaults: config.aiRoute?.requestDefaults || null,
            shouldDebitLight: !!config.aiRoute?.shouldDebitLight,
            shouldRequireBalance: !!config.aiRoute?.shouldRequireBalance,
            modelPinned: !!config.aiRoute?.modelPinned,
            unavailableReason: config.aiUnavailableReason || null,
            routineContext: config.routineContext ?? null,
            requireExecCtx: useGetReuse,
          },
        });
      }
    }

    if (allowsInferenceEmbed) {
      if (config.testMode === true) {
        if (ctx?.exports?.TestEmbedBinding) {
          bindings.EMBED = ctx.exports.TestEmbedBinding({
            props: { sessionName: persistentTestSessionName() },
          });
        }
      } else if (ctx?.exports?.EmbedBinding) {
        bindings.EMBED = ctx.exports.EmbedBinding({
          props: {
            userId: config.userId,
            appId: config.appId,
            appVersion: config.expectedVersion ?? null,
            executionId: config.executionId ?? null,
            // Only pass a genuine user OpenRouter BYOK key; another route key
            // belongs to a different endpoint and must never be misclassified.
            userApiKey: config.aiRoute?.keySource === "user_byok" &&
                config.aiRoute?.upstreamProvider === "openrouter"
              ? config.aiRoute.apiKey
              : null,
            routineContext: config.routineContext ?? null,
            requireExecCtx: useGetReuse,
          },
        });
      }
    }

    // Events (pub/sub emit): host-side RPC binding. The signed caller-context
    // token (emitter app + user + hop, unforgeable) stays in the parent-side
    // execution registry and is resolved from the opaque handle on every emit;
    // neither it nor the platform WORKER_SECRET enters the sandbox isolate.
    // Only present for authenticated, non-routine executions.
    // Event delivery does not yet persist the originating routine/run/trace or
    // reserve downstream fanout, so routine EVENTS would escape hard budgets.
    if (testMode) {
      if (ctx?.exports?.TestEventsBinding) {
        bindings.EVENTS = ctx.exports.TestEventsBinding({
          props: { sessionName: persistentTestSessionName() },
        });
      }
    } else if (
      allowsEventPublish && config.callerContextToken &&
      !config.routineContext &&
      ctx?.exports?.EventsBinding
    ) {
      bindings.EVENTS = ctx.exports.EventsBinding({
        props: {},
      });
    }

    // Network (net:connect): IMAP/SMTP sessions run entirely host-side in the
    // Default-deny egress allowlist from the manifest (FAIL CLOSED: undefined
    // config => [] => nothing reachable). Shared by the NET (IMAP/SMTP) binding
    // and the raw-fetch OutboundBinding; a non-empty allowlist also enables
    // globalOutbound even without an explicit net:fetch permission.
    const allowedDestinations = config.allowedDestinations ?? [];

    // NetworkBinding via cloudflare:sockets — no worker secret in app code.
    if (hasNetworkBinding) {
      if (testMode) {
        if (ctx?.exports?.TestNetworkBinding) {
          bindings.NET = ctx.exports.TestNetworkBinding({
            props: { sessionName: persistentTestSessionName() },
          });
        }
      } else if (ctx?.exports?.NetworkBinding) {
        bindings.NET = ctx.exports.NetworkBinding({
          props: {
            userId: config.userId,
            appId: config.appId,
            allowImap: allowsImap,
            allowSmtp: allowsSmtp,
            strictCredentialRoles: config.declaredEffects != null,
            allowedDestinations,
            credentials: config.credentials ?? {},
          },
        });
      }
    }

    // SELF binding: only inter-app calls (ultralight.call) still route through
    // the parent worker via SELF.fetch (a direct fetch to the Worker URL goes
    // through the CDN, which blocks it). emit + net.* now use dedicated RPC
    // bindings, so net-only apps no longer receive SELF.
    const env = globalThis.__env;
    if (hasInterAppCall) {
      if (testMode) {
        if (ctx?.exports?.TestAppCallBinding) {
          bindings.SELF = ctx.exports.TestAppCallBinding({
            props: { sessionName: persistentTestSessionName() },
          });
        }
      } else if (env?.SELF) {
        bindings.SELF = env.SELF;
      }
    }

    // 5. Create Dynamic Worker
    const hasOutboundNetwork = config.declaredEffects == null
      // Preserve manifest-only behavior exactly.
      ? config.permissions.includes("net:connect") ||
        config.permissions.includes("net:fetch") ||
        hasInterAppCall ||
        allowedDestinations.length > 0
      // galactic.yaml functions receive raw outbound only for an exact network
      // effect. Email, credentialed HTTP, events, and Agent calls stay on their
      // dedicated parent-isolate bindings.
      : allowsNetworkHttp;
    const loadConfig: Parameters<typeof loader.load>[0] = {
      compatibilityDate: "2026-03-01",
      mainModule: "wrapper.js",
      modules: {
        "wrapper.js": wrapperModule,
        "setup.js": setupModule,
        "app.js": esmCode,
      },
      env: bindings,
      globalOutbound: null,
      // Tenant isolation: without explicit limits the loaded isolate inherits
      // the parent's FULL budget (30s CPU / 1000 subrequests). These are
      // deliberately generous — app CPU is pure JS compute (awaited IO costs
      // no CPU) and SDK calls route one subrequest each through the parent —
      // the point is a ceiling, not metering. Exceeding a limit kills the
      // isolate and surfaces as an execution failure. Sized conservatively
      // high until the staging smoke verifies what counts (net:fetch apps
      // make direct outbound fetches; batch/async jobs make many SDK calls).
      limits: { cpuMs: 10_000, subRequests: 512 },
      ...(!testMode && ctx?.exports?.CapacityDynamicTail
        ? { tails: [ctx.exports.CapacityDynamicTail({ props: {} })] }
        : {}),
    };
    // Network-capable apps get raw outbound fetch() — but routed through the
    // egress interceptor (OutboundBinding), which enforces an SSRF / private-
    // network block host-side so a tenant cannot pivot to loopback / RFC1918 /
    // link-local / cloud-metadata addresses. FAIL CLOSED: if the binding is
    // somehow absent, globalOutbound stays null (no raw outbound) rather than
    // falling back to `undefined`, which would restore unrestricted egress.
    // (Inter-app calls via SELF and net.* via the NET binding do NOT use raw
    // fetch, so they are unaffected by this.)
    if (testMode) {
      if (ctx?.exports?.TestOutboundBinding) {
        loadConfig.globalOutbound = ctx.exports.TestOutboundBinding({
          props: {
            sessionName: persistentTestSessionName(),
            fixtures: config.httpFixtures ?? [],
            allowedDestinations,
          },
        });
      }
    } else if (hasOutboundNetwork && ctx?.exports?.OutboundBinding) {
      loadConfig.globalOutbound = ctx.exports.OutboundBinding({
        props: {
          appId: config.appId,
          userId: config.userId,
          allowHttp: config.declaredEffects == null
            ? hasOutboundNetwork
            : allowsNetworkHttp,
          allowedDestinations,
        },
      });
    }
    // Phase 3 credential vault: per-user secrets never enter the sandbox. This
    // parent-side binding attaches a vaulted secret to an outbound request BY
    // KEY (app names it, never sees the value) and forwards via guardedFetch.
    // Added to `bindings` (loadConfig.env) before load below.
    if (testMode) {
      if (ctx?.exports?.TestCredentialBinding) {
        bindings.CREDENTIALS = ctx.exports.TestCredentialBinding({
          props: {
            sessionName: persistentTestSessionName(),
            fixtures: config.httpFixtures ?? [],
            allowedDestinations,
            credentialDestinations: config.testCredentialDestinations ?? {},
          },
        });
      }
    } else if (
      allowsCredentialHttp &&
      config.credentials && Object.keys(config.credentials).length > 0 &&
      ctx?.exports?.CredentialBinding
    ) {
      bindings.CREDENTIALS = ctx.exports.CredentialBinding({
        props: {
          appId: config.appId,
          userId: config.userId,
          allowedDestinations,
          credentials: config.credentials,
        },
      });
    }
    const executionDeadlineAtMs = Date.now() +
      (config.timeoutMs || 30_000);
    // Galactic Compute is always a parent-isolate RPC capability. Its complete
    // invocation authority is fixed in trusted ctx.props because WorkerEntrypoint
    // calls are stateless and cannot depend on this HTTP isolate's module-global
    // execution registry. The opaque public capacity receipt is retained only
    // in parent-side props for exact Tail CPU attribution; no bearer,
    // provider/platform key, hold, or secret value is cloned into the body or
    // binding props.
    if (allowsCompute) {
      if (config.testMode === true) {
        if (ctx?.exports?.TestComputeBinding) {
          bindings.COMPUTE = ctx.exports.TestComputeBinding({
            props: { sessionName: persistentTestSessionName() },
          });
        }
      } else if (config.user && ctx?.exports?.ComputeBinding) {
        bindings.COMPUTE = ctx.exports.ComputeBinding({
          props: {
            userId: config.userId,
            agentId: config.appId,
            callerFunction: functionName,
            executionId: config.executionId,
            executionDeadlineAtMs,
            billingMode: config.capacityReceiptId
              ? "subscription_capacity"
              : "wallet",
            capacityAgentId: config.capacityReceiptId
              ? (config.capacityAgentId ?? "")
              : config.appId,
            capacityReceiptId: config.capacityReceiptId ?? null,
          },
        });
      }
    }
    // Production bindings resolve the current call's billing/authority context
    // through an opaque handle. gx.test has no production binding that may
    // resolve this context, so do not create or expose a handle at all.
    if (!testMode) {
      execCtxHandle = registerExecutionContext({
        capacityReceiptId: config.capacityReceiptId ?? null,
        capacityAgentId: config.capacityAgentId ?? null,
        aiExecutionId: config.executionId,
        appId: config.appId ?? null,
        functionName: functionName ?? null,
        cloudOperationMetering: config.cloudOperationMetering,
        cloudOperationBillingConfig: config.cloudOperationBillingConfig,
        callerContextToken: config.callerContextToken ?? null,
        routineContext: config.routineContext ?? null,
        executionDeadlineAtMs,
      });
    }

    // 5b. Warm-isolate reuse (Cloudflare Worker Loader get()). Reusing a warm
    // isolate across this user's repeated calls cuts billable Dynamic Worker
    // loads from ~1/call to ~1/(app-version, user)/day, with NO change to the
    // isolation model:
    //   - userId in the key   => an isolate is NEVER shared across users.
    //   - stateFingerprint    => any change to a baked per-user input (secrets,
    //     grants/dependencies, BYOK key, envVars, user, egress allowlist, AI
    //     route) mints a fresh isolate — a rotated secret is never served stale.
    //   - bundleHash          => a code change mints a fresh isolate.
    // Per-call values (functionName/args/authToken/callerCtx/execCtxHandle) ride
    // the fetch body below, never the cached content; per-call billing context
    // resolves via the execution-context registry (requireExecCtx bindings).
    // Flag-gated: EXECUTED_LOADER_GET_REUSE=1 (default OFF; staging first).
    let worker: ReturnType<typeof loader.load>;
    if (useGetReuse) {
      const reuseKey = await deriveIsolateReuseKey(
        config,
        esmCode,
        allowedDestinations,
        {
          dbId: resolvedDbId,
          hasDb: "DB" in bindings,
          hasMemory: "MEMORY" in bindings,
          hasRuns: "RUNS" in bindings,
        },
      );
      // Hash the reuse key for the per-day load-floor dedup counter. The reuse
      // key already contains NO raw secrets (creds/BYOK are folded into the
      // sha256 stateFingerprint), but hash again for a fixed-length, opaque
      // counter component that never lands raw in the usage table.
      reuseKeyHash = await sha256HexLocal(reuseKey);
      worker = loader.get(reuseKey, () => Promise.resolve(loadConfig));
    } else {
      worker = loader.load(loadConfig);
    }
    // Once Loader returns a Worker handle, the Dynamic Worker identity/load
    // has been attempted and may be billable even if entrypoint resolution or
    // fetch fails. Mark it before either operation can throw.
    dynamicWorkerIdentityCreated = true;

    // Resolve the entrypoint before arming the fetch timer: entrypoint
    // resolution itself has no in-flight request to abort, and a thrown
    // resolution must not strand a timer in this isolate.
    const entrypoint = worker.getEntrypoint();

    // 6. Execute with timeout
    const timeoutMs = config.timeoutMs || 30_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      // Dynamic Workers bill each fetch separately. Keep this distinct from
      // Loader identity creation so entrypoint-resolution failures do not
      // invent a request or wait forever for a child Tail event that cannot
      // exist.
      dynamicWorkerInvoked = true;
      response = await entrypoint.fetch(
        new Request("http://internal/execute", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(!testMode && config.capacityReceiptId
              ? { "x-galactic-capacity-receipt": config.capacityReceiptId }
              : {}),
          },
          // Per-request payload — the only per-execution data, kept OUT of the
          // (potentially cached) isolate content so a warm isolate is reusable
          // across this user's calls. The sandbox never receives payer/receipt
          // identity — only the opaque handle.
          body: JSON.stringify({
            execCtxHandle,
            functionName,
            args,
            authToken: sandboxAuthToken || "",
            callerCtx: testMode ? "" : config.callerContextToken || "",
          }),
        }),
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const data = (await response.json()) as {
      success: boolean;
      functionInvoked?: boolean;
      result: unknown;
      logs: Array<
        {
          time: string;
          level: "log" | "error" | "warn" | "info";
          message: string;
        }
      >;
      // Sandbox-side accumulated AI cost (SDK ai() wrapper). Informational
      // only — the authoritative value is the main-isolate spend ledger below,
      // which tenant code cannot touch.
      aiCostLight?: number;
      // Flight capture (bounded, clipped in-sandbox): ai() exchanges for this
      // execution. Persisted host-side only when the app opted in via the
      // manifest flight_recorder flag and a routine context is present.
      flight?: { ai?: FlightAiExchange[] };
      error?: {
        type: string;
        message: string;
        code?: string;
        details?: unknown;
      };
    };
    // Seal the exact invocation-owned session before deciding whether the
    // result qualifies. A tenant may catch a blocked binding error, but it
    // cannot erase the session's observed-effect evidence.
    const testRuntimeSnapshot = await snapshotTestRuntimeSession();
    const { blockedEffects, observedEffects } = testRuntimeSnapshot;
    const containmentError = gxTestContainmentError(blockedEffects);
    const executionError = containmentError ?? data.error;

    // Credits actually debited for in-sandbox AI calls this execution, from
    // the binding-side ledger. Drives both the receipt and the cross-Agent
    // grant monthly cap. The sandbox-reported number is cross-checked only.
    const aiCostLight = consumeAiSpend(config.executionId);
    const reportedAiCost = typeof data.aiCostLight === "number"
      ? data.aiCostLight
      : 0;
    if (Math.abs(aiCostLight - reportedAiCost) > 1e-6) {
      console.warn(
        "[AI-SPEND] Sandbox-reported AI cost differs from debit ledger",
        {
          appId: config.appId,
          executionId: config.executionId,
          reported: reportedAiCost,
          debited: aiCostLight,
        },
      );
    }

    // Host-authoritative tally of galactic.db mutations this execution (null =
    // read-only wake). Consumed here the same way as the AI spend ledger.
    const flightDb = consumeDbDiff(config.executionId);
    const diagnostic = executionError
      ? normalizeOperatorDiagnostic({
        error: executionError,
        provenance: "developer",
        knownSecrets: [...knownSecrets, sandboxAuthToken],
      })
      : undefined;
    const errorCode = containmentError?.code ??
      structuredOutputErrorCode(executionError?.code);

    return {
      success: data.success && blockedEffects.length === 0,
      result: blockedEffects.length > 0 ? null : data.result,
      logs: data.logs || [],
      durationMs: Date.now() - startTime,
      aiCostLight,
      dynamicWorkerIdentityCreated,
      dynamicWorkerInvoked,
      functionInvoked: data.functionInvoked === true,
      ...(testMode ? { observedEffects } : {}),
      ...(Array.isArray(data.flight?.ai) && data.flight.ai.length > 0
        ? { flightAi: data.flight.ai }
        : {}),
      ...(flightDb ? { flightDb } : {}),
      ...(reuseKeyHash ? { reuseKeyHash } : {}),
      ...(diagnostic
        ? {
          error: {
            ...operatorCompatibilityError(
              diagnostic,
              executionError?.type,
              knownSecrets,
            ),
            ...(errorCode ? { code: errorCode } : {}),
          },
          diagnostic,
        }
        : {}),
    };
  } catch (err) {
    let failedTestRuntimeSnapshot = EMPTY_TEST_RUNTIME_SNAPSHOT;
    if (testMode && testRuntimeSession) {
      try {
        failedTestRuntimeSnapshot = await snapshotTestRuntimeSession();
      } catch (snapshotError) {
        console.error(
          "[GX-TEST] Failed to snapshot runtime effect evidence",
          snapshotError,
        );
      }
    }
    const entrypointResolutionFailed = dynamicWorkerIdentityCreated &&
      !dynamicWorkerInvoked;
    const timedOut = err instanceof DOMException && err.name === "AbortError";
    // A blocked external effect is disqualifying even when a later timeout,
    // loader error, or abort becomes the exception that exits the sandbox.
    // Prefer the invocation-owned containment latch over the secondary
    // platform failure so gx.test cannot lose evidence through error ordering.
    const containmentError = gxTestContainmentError(
      failedTestRuntimeSnapshot.blockedEffects,
    );
    const diagnostic = containmentError
      ? normalizeOperatorDiagnostic({
        error: containmentError,
        provenance: "developer",
        knownSecrets: [...knownSecrets, sandboxAuthToken],
      })
      : normalizeOperatorDiagnostic({
        error: err,
        provenance: "platform",
        platform: {
          code: timedOut
            ? "SANDBOX_TIMEOUT"
            : entrypointResolutionFailed
            ? "SANDBOX_ENTRYPOINT_UNAVAILABLE"
            : "SANDBOX_EXECUTION_FAILED",
          summary: timedOut
            ? "The Agent execution timed out."
            : entrypointResolutionFailed
            ? "The execution sandbox could not resolve the Agent entrypoint."
            : "The execution sandbox could not complete the run.",
          detail: entrypointResolutionFailed && err instanceof Error
            ? err.message
            : null,
          retryable: true,
        },
        knownSecrets: [...knownSecrets, sandboxAuthToken],
      });
    return {
      success: false,
      result: null,
      logs: [],
      durationMs: Date.now() - startTime,
      // An aborted/failed execution still pays for every AI call that
      // completed before the failure — report the real debited spend so the
      // receipt and grant-cap accounting stay truthful.
      aiCostLight: consumeAiSpend(config.executionId),
      dynamicWorkerIdentityCreated,
      dynamicWorkerInvoked,
      functionInvoked: false,
      ...(testMode
        ? { observedEffects: failedTestRuntimeSnapshot.observedEffects }
        : {}),
      // Likewise capture any galactic.db mutations that landed before the
      // failure (also frees the tracker entry so it can't leak).
      ...(() => {
        const flightDb = consumeDbDiff(config.executionId);
        return flightDb ? { flightDb } : {};
      })(),
      // If the loader.get() ran before the failure, CF still billed the load —
      // carry the hash so the floor still dedups on the correct isolate identity.
      ...(reuseKeyHash ? { reuseKeyHash } : {}),
      error: {
        ...operatorCompatibilityError(
          diagnostic,
          containmentError?.type ??
            (err instanceof Error ? err.name : null),
          [...knownSecrets, sandboxAuthToken],
        ),
        ...(containmentError ? { code: containmentError.code } : {}),
      },
      diagnostic,
    };
  } finally {
    // Always release the handle (success, error, abort) so a later resolve
    // fails closed and the registry never leaks entries.
    deregisterExecutionContext(execCtxHandle);
    if (testRuntimeSession) {
      try {
        await testRuntimeSession.close();
      } catch (error) {
        console.error("[GX-TEST] Failed to close runtime state session", error);
      }
    }
  }
}
