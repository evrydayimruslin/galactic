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
import type { ResolvedCredential } from "../../shared/contracts/env.ts";
import { consumeAiSpend } from "../services/ai-spend-tracker.ts";
import { debitCloudOperation } from "../services/cloud-usage.ts";
import { mintSandboxAuthToken } from "../services/sandbox-actor.ts";
import {
  executedBundleVerifyMode,
  handleExecutedBundleVerdict,
  loadLiveExecutedBundle,
  verifyExecutedBundle,
} from "../services/executed-bundle.ts";

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

/**
 * Derive the Worker Loader `get()` reuse key for an execution.
 *
 * The key uniquely determines every BAKED input to the isolate, so Cloudflare's
 * rule ("same id ⟺ same content") holds and warm reuse is safe:
 *   - `appId` + `bundleHash`  ⇒ a different app or code version ⇒ different key.
 *   - `userId`                ⇒ an isolate is NEVER shared across users.
 *   - `stateFingerprint`      ⇒ any per-user baked input change (secret rotation,
 *     grant/dependency change, BYOK key, envVars, user, egress allowlist) ⇒ a
 *     fresh isolate, so a warm one never serves stale secrets/grants.
 * Only functionName/args/authToken vary within a key; those ride the fetch body,
 * not the cached content. Exported for unit-testing the isolation invariants.
 */
export async function deriveIsolateReuseKey(
  config: Pick<
    RuntimeConfig,
    | "appId"
    | "userId"
    | "user"
    | "envVars"
    | "permissions"
    | "credentials"
    | "appCallDependencies"
    | "slotBindings"
    | "userApiKey"
    | "aiRoute"
  >,
  esmCode: string,
  allowedDestinations: unknown,
): Promise<string> {
  const bundleHash = await sha256HexLocal(esmCode);
  const stateFingerprint = await sha256HexLocal(JSON.stringify({
    user: config.user ?? null,
    env: config.envVars ?? {},
    perms: [...(config.permissions ?? [])].sort(),
    // Credential VALUES are included: a rotation changes the fingerprint and
    // mints a fresh isolate, so a warm one never serves a stale secret.
    creds: config.credentials ?? {},
    deps: config.appCallDependencies ?? [],
    slots: config.slotBindings ?? [],
    byok: config.userApiKey ?? null,
    aiRoute: config.aiRoute ?? null,
    dests: allowedDestinations,
  }));
  return `${config.appId}:${bundleHash}:${config.userId}:${stateFingerprint}`;
}

interface DynamicWorkerEntrypointExports {
  DatabaseBinding(
    input: {
      props: {
        databaseId: string;
        appId: string;
        userId: string;
        operationMetering?: RuntimeConfig["cloudOperationMetering"];
        operationBillingConfig?: RuntimeConfig["cloudOperationBillingConfig"];
      };
    },
  ): unknown;
  FixtureDatabaseBinding(
    input: {
      props: {
        appId: string;
        userId: string;
        fixtures: NonNullable<RuntimeConfig["d1Fixtures"]>;
      };
    },
  ): unknown;
  AppDataBinding(
    input: {
      props: {
        appId: string;
        userId: string;
        operationMetering?: RuntimeConfig["cloudOperationMetering"];
        operationBillingConfig?: RuntimeConfig["cloudOperationBillingConfig"];
      };
    },
  ): unknown;
  MemoryBinding(
    input: {
      props: {
        userId: string;
        appId?: string | null;
        operationMetering?: RuntimeConfig["cloudOperationMetering"];
        operationBillingConfig?: RuntimeConfig["cloudOperationBillingConfig"];
      };
    },
  ): unknown;
  AIBinding(input: {
    props: {
      userId: string;
      executionId: string | null;
      apiKey: string | null;
      provider: string | null;
      upstreamProvider: string | null;
      baseUrl: string | null;
      defaultModel: string | null;
      canonicalModelId: string | null;
      billingModelId: string | null;
      billingSource: string | null;
      requestDefaults: Record<string, unknown> | null;
      shouldDebitLight: boolean;
      shouldRequireBalance: boolean;
      unavailableReason?: string | null;
    };
  }): unknown;
  NetworkBinding(input: {
    props: {
      userId: string;
      appId: string;
      credentials: Record<string, ResolvedCredential>;
    };
  }): unknown;
  EventsBinding(input: {
    props: {
      callerContextToken: string;
    };
  }): unknown;
  OutboundBinding(input: {
    props: {
      appId: string;
      userId: string;
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
  const loader = globalThis.__env?.LOADER;

  if (!loader) {
    return {
      success: false,
      result: null,
      logs: [],
      durationMs: Date.now() - startTime,
      aiCostLight: 0,
      error: {
        type: "RuntimeError",
        message: "Dynamic Worker LOADER binding not available",
      },
    };
  }

  try {
    // 1. Get ESM bundle from KV
    const codeCacheKey = `esm:${config.appId}:latest`;
    if (config.cloudOperationMetering) {
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
    const { code: esmCode, attestation } = await loadLiveExecutedBundle(
      config.appId,
    );
    if (!esmCode) {
      // No ESM bundle — app hasn't been rebuilt. Can't execute without it.
      return {
        success: false,
        result: null,
        logs: [],
        durationMs: Date.now() - startTime,
        aiCostLight: 0,
        error: {
          type: "RuntimeError",
          message:
            `No ESM bundle found for app ${config.appId}. Run rebuild first.`,
        },
      };
    }

    // 1b. Executed-bundle integrity: the bytes we're about to run must match the
    // attestation written atomically with them, and must not be a downgrade to an
    // old version. EXECUTED_BUNDLE_VERIFY=enforce refuses a violating bundle;
    // observe (default) only warns. Legacy (no attestation) + infra/secret errors
    // never block.
    const bundleVerifyMode = executedBundleVerifyMode();
    if (bundleVerifyMode !== "off") {
      const verdict = await verifyExecutedBundle({
        appId: config.appId,
        esmCode,
        attestation,
        expectedVersion: config.expectedVersion,
      });
      if (handleExecutedBundleVerdict(config.appId, verdict, bundleVerifyMode)) {
        return {
          success: false,
          result: null,
          logs: [],
          durationMs: Date.now() - startTime,
          aiCostLight: 0,
          error: {
            type: "IntegrityError",
            message:
              `Executed bundle failed integrity verification (${verdict.status})`,
          },
        };
      }
    }

    // 2. Build setup module — sets globalThis.ultralight with lazy getters
    // User context and env vars are baked in as literals (they're per-request constants)
    const userJson = config.user ? JSON.stringify(config.user) : "null";
    const envVarsJson = JSON.stringify(config.envVars || {});
    const callBaseUrl = JSON.stringify(
      config.baseUrl || config.workerBaseUrl || "",
    );
    // SECURITY: never inject the caller's raw bearer. App code can read this
    // value (e.g. globalThis.ultralight.call.toString()), so mint a short-lived
    // token scoped to this app's allowed call targets instead. The user's real
    // ul_ key never enters the sandbox.
    const sandboxAuthToken = await mintSandboxAuthToken({
      user: config.user,
      appId: config.appId,
      executionId: config.executionId,
      hasBroadCallPermission: config.permissions.includes("app:call"),
      dependencyAppIds: (config.appCallDependencies || [])
        .map((dependency) => dependency.app)
        .filter(Boolean),
    });
    const callerContextToken = JSON.stringify(config.callerContextToken || "");
    const slotBindingsJson = JSON.stringify(config.slotBindings || []);
    const callDependenciesJson = JSON.stringify(
      config.appCallDependencies || [],
    );

    const setupModule = `
// Setup module — runs before app.js, sets globalThis.ultralight
// RPC bindings (__rpcEnv) are set later by wrapper.js fetch() handler.
// Lazy getters defer RPC calls until function execution time.
globalThis.__rpcEnv = {};

function __ulAllowsAppCall(targetAppId, functionName) {
  if (${config.permissions.includes("app:call")}) return true;
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

globalThis.ultralight = {
  get db() {
    const e = globalThis.__rpcEnv;
    // Raw-SQL methods were removed in favour of the scoped structured API. Fail
    // loud with an actionable message if an old bundle still calls them.
    const __removed = function (name) {
      return function () {
        throw new Error('galactic.db.' + name + '() was removed. galactic.db is now a scoped, structured API — use galactic.db.select/first/insert/update/delete/upsert/count/batch. Raw SQL is no longer supported.');
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
      select: (table, query) => e.DB.select(Object.assign({ table: table }, query || {})),
      first: (table, query) => e.DB.first(Object.assign({ table: table }, query || {})),
      count: (table, query) => e.DB.count(Object.assign({ table: table }, query || {})),
      // Writes (user_id is injected host-side; app code never supplies it)
      insert: (table, values) => e.DB.insert({ table: table, values: values }),
      update: (table, spec) => e.DB.update(Object.assign({ table: table }, spec || {})),
      delete: (table, spec) => e.DB.delete(Object.assign({ table: table }, spec || {})),
      upsert: (table, spec) => e.DB.upsert(Object.assign({ table: table }, spec || {})),
      batch: (ops) => e.DB.batch(ops || []),
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
  store(k, v) { if (!${
      config.permissions.includes("storage:write")
    }) return Promise.reject(new Error('storage:write permission not granted.')); const e = globalThis.__rpcEnv; return e.DATA ? e.DATA.store(k, v) : Promise.reject(new Error('Data not available')); },
  load(k) { if (!${
      config.permissions.includes("storage:read")
    }) return Promise.reject(new Error('storage:read permission not granted.')); const e = globalThis.__rpcEnv; return e.DATA ? e.DATA.load(k) : Promise.resolve(null); },
  remove(k) { if (!${
      config.permissions.includes("storage:delete")
    }) return Promise.reject(new Error('storage:delete permission not granted.')); const e = globalThis.__rpcEnv; return e.DATA ? e.DATA.remove(k) : Promise.reject(new Error('Data not available')); },
  list(p) { if (!${
      config.permissions.includes("storage:read")
    }) return Promise.reject(new Error('storage:read permission not granted.')); const e = globalThis.__rpcEnv; return e.DATA ? e.DATA.list(p) : Promise.resolve([]); },
  query(p, o) { if (!${
      config.permissions.includes("storage:read")
    }) return Promise.reject(new Error('storage:read permission not granted.')); const e = globalThis.__rpcEnv; return e.DATA?.query?.(p, o) || Promise.resolve([]); },
  remember(k, v, o) { if (!${
      config.permissions.includes("memory:write")
    }) return Promise.reject(new Error('memory:write permission not granted.')); var s = (o && o.scope === 'user') ? 'user' : 'agent'; const e = globalThis.__rpcEnv; return e.MEMORY ? e.MEMORY.remember(k, v, s) : Promise.resolve(); },
  recall(k, o) { if (!${
      config.permissions.includes("memory:read")
    }) return Promise.reject(new Error('memory:read permission not granted.')); var s = (o && o.scope === 'user') ? 'user' : 'agent'; const e = globalThis.__rpcEnv; return e.MEMORY ? e.MEMORY.recall(k, s) : Promise.resolve(null); },
  ai(r) { const e = globalThis.__rpcEnv; if (!e.AI) return Promise.reject(new Error('galactic.ai unavailable: ai:call permission not granted or no authenticated user context.')); return e.AI.call(r).then(function(resp){ if (resp && resp.error) { throw new Error('galactic.ai failed: ' + resp.error); } try { globalThis.__aiCostLight = (globalThis.__aiCostLight || 0) + ((resp && resp.usage && resp.usage.cost_light) || 0); } catch (_e) {} return resp; }); },
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
    if (!authToken || !baseUrl) throw new Error('Inter-app calls not available (missing baseUrl or authToken)');
    var e = globalThis.__rpcEnv;
    var useSelf = !!(e && e.SELF);
    var fetchFn = useSelf ? e.SELF.fetch.bind(e.SELF) : fetch;
    var endpoint = useSelf
      ? 'https://internal/mcp/' + encodeURIComponent(targetAppId)
      : baseUrl.replace(/\\/$/, '') + '/mcp/' + encodeURIComponent(targetAppId);
    var __headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken };
    // Unforgeable caller identity (minted server-side, asserts only this app).
    // The target uses it to run the cross-Agent grant check.
    var __callerCtx = ${callerContextToken};
    if (__callerCtx) __headers['X-Galactic-Caller'] = __callerCtx;
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
    var rpcResponse = await response.json();
    if (rpcResponse.error) {
      throw new Error('galactic.call RPC error: ' + (rpcResponse.error.message || JSON.stringify(rpcResponse.error)));
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
    if (!topic || typeof topic !== 'string') throw new Error('emit requires a topic string');
    var e = globalThis.__rpcEnv;
    if (!e || !e.EVENTS) throw new Error('emit requires an authenticated user context');
    globalThis.__emitCount = (globalThis.__emitCount || 0) + 1;
    if (globalThis.__emitCount > 50) throw new Error('emit limit reached for this execution');
    // Fail fast on an oversized payload (the server enforces a 32KB payload cap
    // authoritatively; this just avoids a wasted RPC with a clearer error).
    if (JSON.stringify(payload || {}).length > 64 * 1024) throw new Error('emit payload too large (max 32KB)');
    return await e.EVENTS.emit(topic, payload || {});
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
    var e = globalThis.__rpcEnv;
    if (!e || !e.CREDENTIALS) {
      throw new Error('No vaulted credentials are configured for this Agent.');
    }
    return await e.CREDENTIALS.authenticatedFetch(credentialKey, url, init || {});
  },
  // net:connect — high-level protocol methods run host-side in the NET RPC
  // binding (cloudflare:sockets). No worker secret is exposed to app code.
  net: ${
      config.permissions.includes("net:connect")
        ? `{
    async imapFetchUnseen(hostKey, port, userKey, passKey, lastUid, businessEmail, processedFlag, limit) {
      var e = globalThis.__rpcEnv;
      if (!e || !e.NET) throw new Error('net:connect not available');
      return await e.NET.imapFetchUnseen(hostKey, port, userKey, passKey, lastUid || 0, businessEmail || '', processedFlag || '$ULProcessed', limit || 20);
    },
    async smtpSend(hostKey, port, userKey, passKey, from, fromName, to, subject, body, inReplyTo) {
      var e = globalThis.__rpcEnv;
      if (!e || !e.NET) throw new Error('net:connect not available');
      return await e.NET.smtpSend(hostKey, port, userKey, passKey, from, fromName || '', to, subject, body, inReplyTo || '');
    },
    connectTls() { throw new Error('Low-level sockets not available. Use galactic.net.imapFetchUnseen() or .smtpSend().'); },
  }`
        : `{
    imapFetchUnseen() { throw new Error('net:connect permission required.'); },
    smtpSend() { throw new Error('net:connect permission required.'); },
    connectTls() { throw new Error('net:connect permission required.'); },
  }`
    },
};
// galactic.* is the canonical namespace; ultralight.* is a permanent alias so
// every already-deployed bundle keeps working. Same object, two names.
globalThis.galactic = globalThis.ultralight;
`;

    // 3. Build wrapper module — entry point, sets RPC env, calls function.
    // functionName + args are NOT baked here anymore — they arrive per-request in
    // the fetch body so the isolate content is identical across this user's calls.
    const wrapperModule = `
import './setup.js';
import * as appModule from './app.js';

export default {
  async fetch(request, env) {
    // Set RPC bindings for lazy getters in ultralight SDK
    globalThis.__rpcEnv = env;
    // Per-request payload — the ONLY per-execution data, read fresh each fetch so
    // a warm isolate can be reused across this user's calls (get()). functionName
    // + args select what runs; authToken is the scoped inter-app call token. The
    // app:call allowlist and caller-context stay baked (parent-side), never here.
    let __req = {};
    try { __req = await request.json(); } catch (_e) { __req = {}; }
    globalThis.__ulReq = { authToken: (__req && __req.authToken) || '' };
    // Reset the per-execution AI-cost accumulator. Isolates may be warm-reused
    // (get()), so resetting here per fetch keeps per-grant cap accounting correct.
    globalThis.__aiCostLight = 0;

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
          success: false, result: null, logs, aiCostLight: globalThis.__aiCostLight || 0,
          error: { type: 'FunctionNotFound', message: 'Function "' + fnName + '" not found. Available: ' + [...new Set(available)].join(', ') },
        });
      }

      const result = await targetFn(...fnArgs);
      return Response.json({ success: true, result, logs, aiCostLight: globalThis.__aiCostLight || 0 });
    } catch (err) {
      return Response.json({
        success: false, result: null, logs, aiCostLight: globalThis.__aiCostLight || 0,
        error: { type: err.constructor?.name || 'Error', message: err.message || String(err) },
      });
    }
  }
};
`;

    // 4. Create RPC bindings
    const ctx = globalThis.__ctx as DynamicWorkerExecutionContext;
    const bindings: Record<string, unknown> = {};

    if (config.d1Fixtures && ctx?.exports?.FixtureDatabaseBinding) {
      bindings.DB = ctx.exports.FixtureDatabaseBinding({
        props: {
          appId: config.appId,
          userId: config.userId,
          fixtures: config.d1Fixtures,
        },
      });
    } else if (config.d1DataService) {
      const { getD1DatabaseId } = await import(
        "../services/d1-provisioning.ts"
      );
      const dbId = await getD1DatabaseId(config.appId);
      if (dbId && ctx?.exports?.DatabaseBinding) {
        bindings.DB = ctx.exports.DatabaseBinding({
          props: {
            databaseId: dbId,
            appId: config.appId,
            userId: config.userId,
            operationMetering: config.cloudOperationMetering,
            operationBillingConfig: config.cloudOperationBillingConfig,
          },
        });
      }
    }

    const hasStorageRead = config.permissions.includes("storage:read");
    const hasStorageWrite = config.permissions.includes("storage:write");
    const hasStorageDelete = config.permissions.includes("storage:delete");
    if (
      (hasStorageRead || hasStorageWrite || hasStorageDelete) &&
      ctx?.exports?.AppDataBinding
    ) {
      bindings.DATA = ctx.exports.AppDataBinding({
        props: {
          appId: config.appId,
          userId: config.userId,
          operationMetering: config.cloudOperationMetering,
          operationBillingConfig: config.cloudOperationBillingConfig,
        },
      });
    }

    const hasMemory = config.permissions.includes("memory:read") ||
      config.permissions.includes("memory:write");
    if (hasMemory && config.memoryService && ctx?.exports?.MemoryBinding) {
      bindings.MEMORY = ctx.exports.MemoryBinding({
        props: {
          userId: config.userId,
          // Agent-scoped memory by default: each agent gets its own notebook
          // keyed by appId so remember/recall can't collide across the agents a
          // user runs. scope:"user" still reaches the shared per-user notebook.
          appId: config.appId,
          operationMetering: config.cloudOperationMetering,
          operationBillingConfig: config.cloudOperationBillingConfig,
        },
      });
    }

    if (config.permissions.includes("ai:call") && ctx?.exports?.AIBinding) {
      bindings.AI = ctx.exports.AIBinding({
        props: {
          userId: config.userId,
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
          requestDefaults: config.aiRoute?.requestDefaults || null,
          shouldDebitLight: !!config.aiRoute?.shouldDebitLight,
          shouldRequireBalance: !!config.aiRoute?.shouldRequireBalance,
          unavailableReason: config.aiUnavailableReason || null,
        },
      });
    }

    // Events (pub/sub emit): host-side RPC binding. The signed caller-context
    // token (emitter app + user + hop, unforgeable) is passed as a prop and
    // verified inside the binding — the platform WORKER_SECRET never enters the
    // sandbox isolate. Only present for authenticated executions (the token is
    // minted only for a real user), matching the prior emit auth requirement.
    if (config.callerContextToken && ctx?.exports?.EventsBinding) {
      bindings.EVENTS = ctx.exports.EventsBinding({
        props: { callerContextToken: config.callerContextToken },
      });
    }

    // Network (net:connect): IMAP/SMTP sessions run entirely host-side in the
    // Default-deny egress allowlist from the manifest (FAIL CLOSED: undefined
    // config => [] => nothing reachable). Shared by the NET (IMAP/SMTP) binding
    // and the raw-fetch OutboundBinding; a non-empty allowlist also enables
    // globalOutbound even without an explicit net:fetch permission.
    const allowedDestinations = config.allowedDestinations ?? [];

    // NetworkBinding via cloudflare:sockets — no worker secret in app code.
    if (
      config.permissions.includes("net:connect") && ctx?.exports?.NetworkBinding
    ) {
      bindings.NET = ctx.exports.NetworkBinding({
        props: {
          userId: config.userId,
          appId: config.appId,
          credentials: config.credentials ?? {},
        },
      });
    }

    // SELF binding: only inter-app calls (ultralight.call) still route through
    // the parent worker via SELF.fetch (a direct fetch to the Worker URL goes
    // through the CDN, which blocks it). emit + net.* now use dedicated RPC
    // bindings, so net-only apps no longer receive SELF.
    const env = globalThis.__env;
    const hasInterAppCall = config.permissions.includes("app:call") ||
      !!config.appCallDependencies?.length;
    if (hasInterAppCall && env?.SELF) {
      bindings.SELF = env.SELF;
    }

    // 5. Create Dynamic Worker
    const hasOutboundNetwork = config.permissions.includes("net:connect") ||
      config.permissions.includes("net:fetch") ||
      hasInterAppCall ||
      allowedDestinations.length > 0;
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
    };
    // Network-capable apps get raw outbound fetch() — but routed through the
    // egress interceptor (OutboundBinding), which enforces an SSRF / private-
    // network block host-side so a tenant cannot pivot to loopback / RFC1918 /
    // link-local / cloud-metadata addresses. FAIL CLOSED: if the binding is
    // somehow absent, globalOutbound stays null (no raw outbound) rather than
    // falling back to `undefined`, which would restore unrestricted egress.
    // (Inter-app calls via SELF and net.* via the NET binding do NOT use raw
    // fetch, so they are unaffected by this.)
    if (hasOutboundNetwork && ctx?.exports?.OutboundBinding) {
      loadConfig.globalOutbound = ctx.exports.OutboundBinding({
        props: {
          appId: config.appId,
          userId: config.userId,
          allowedDestinations,
        },
      });
    }
    // Phase 3 credential vault: per-user secrets never enter the sandbox. This
    // parent-side binding attaches a vaulted secret to an outbound request BY
    // KEY (app names it, never sees the value) and forwards via guardedFetch.
    // Added to `bindings` (loadConfig.env) before load below.
    if (
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
    // 5b. Warm-isolate reuse (Cloudflare Worker Loader get()). Reusing a warm
    // isolate across this user's repeated calls cuts billable Dynamic Worker
    // loads from ~1/call to ~1/(app-version, user)/day, with NO change to
    // isolation:
    //   - userId in the key  ⇒ an isolate is NEVER shared across users.
    //   - stateFingerprint    ⇒ any change to a baked per-user input (secrets,
    //     grants/dependencies, BYOK key, envVars, user, egress allowlist) mints a
    //     fresh isolate — a rotated secret is never served stale.
    //   - bundleHash          ⇒ a code change mints a fresh isolate.
    // Only functionName/args/authToken vary per call, and those now ride the
    // fetch body (below), not the cached content.
    // Emit-path calls (callerContextToken present) MUST keep load(): they carry
    // an EventsBinding whose parent-side caller token is per-execution and must
    // not be reused, and it must not become a sandbox-forgeable per-request value.
    let worker: ReturnType<typeof loader.load>;
    if (config.callerContextToken) {
      worker = loader.load(loadConfig);
    } else {
      const reuseKey = await deriveIsolateReuseKey(
        config,
        esmCode,
        allowedDestinations,
      );
      worker = loader.get(reuseKey, () => Promise.resolve(loadConfig));
    }

    // 6. Execute with timeout
    const timeoutMs = config.timeoutMs || 30_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const entrypoint = worker.getEntrypoint();
    const response = await entrypoint.fetch(
      new Request("http://internal/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Per-request payload — the only per-execution data, kept OUT of the
        // cached isolate content so a warm isolate is reusable across calls.
        body: JSON.stringify({
          functionName,
          args,
          authToken: sandboxAuthToken || "",
        }),
      }),
      { signal: controller.signal },
    );
    clearTimeout(timeoutId);

    const data = (await response.json()) as {
      success: boolean;
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
      error?: { type: string; message: string };
    };

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

    return {
      success: data.success,
      result: data.result,
      logs: data.logs || [],
      durationMs: Date.now() - startTime,
      aiCostLight,
      ...(data.error ? { error: data.error } : {}),
    };
  } catch (err) {
    return {
      success: false,
      result: null,
      logs: [],
      durationMs: Date.now() - startTime,
      // An aborted/failed execution still pays for every AI call that
      // completed before the failure — report the real debited spend so the
      // receipt and grant-cap accounting stay truthful.
      aiCostLight: consumeAiSpend(config.executionId),
      error: {
        type: err instanceof Error ? err.constructor.name : "UnknownError",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
