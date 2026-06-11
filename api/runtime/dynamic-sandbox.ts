// Ultralight Dynamic Worker Sandbox
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
import { debitCloudOperation } from "../services/cloud-usage.ts";

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
        operationMetering?: RuntimeConfig["cloudOperationMetering"];
        operationBillingConfig?: RuntimeConfig["cloudOperationBillingConfig"];
      };
    },
  ): unknown;
  AIBinding(input: {
    props: {
      userId: string;
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
      unavailableReason?: string | null;
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
    let esmCode = await globalThis.__env?.CODE_CACHE?.get(codeCacheKey);
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

    // 2. Build setup module — sets globalThis.ultralight with lazy getters
    // User context and env vars are baked in as literals (they're per-request constants)
    const userJson = config.user ? JSON.stringify(config.user) : "null";
    const envVarsJson = JSON.stringify(config.envVars || {});
    const netBaseUrl = JSON.stringify(
      config.workerBaseUrl || config.baseUrl || "",
    );
    const netWorkerSecret = JSON.stringify(config.workerSecret || "");
    const callBaseUrl = JSON.stringify(
      config.baseUrl || config.workerBaseUrl || "",
    );
    const callAuthToken = JSON.stringify(config.authToken || "");
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
    if (!e.DB) return {
      run() { throw new Error('D1 database not available. Ensure your app has a migrations/ folder.'); },
      all() { throw new Error('D1 database not available.'); },
      first() { throw new Error('D1 database not available.'); },
      batch() { throw new Error('D1 database not available.'); },
      exec() { throw new Error('ultralight.db.exec() is not available at runtime.'); },
    };
    return {
      run: (s, p) => e.DB.run(s, p),
      all: (s, p) => e.DB.all(s, p),
      first: (s, p) => e.DB.first(s, p),
      batch: (st) => e.DB.batch(st),
      exec() { throw new Error('ultralight.db.exec() is not available at runtime.'); },
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
  remember(k, v) { if (!${
      config.permissions.includes("memory:write")
    }) return Promise.reject(new Error('memory:write permission not granted.')); const e = globalThis.__rpcEnv; return e.MEMORY ? e.MEMORY.remember(k, v) : Promise.resolve(); },
  recall(k) { if (!${
      config.permissions.includes("memory:read")
    }) return Promise.reject(new Error('memory:read permission not granted.')); const e = globalThis.__rpcEnv; return e.MEMORY ? e.MEMORY.recall(k) : Promise.resolve(null); },
  ai(r) { const e = globalThis.__rpcEnv; if (!e.AI) return Promise.resolve({ content: '', error: 'AI not available' }); return e.AI.call(r).then(function(resp){ try { globalThis.__aiCostLight = (globalThis.__aiCostLight || 0) + ((resp && resp.usage && resp.usage.cost_light) || 0); } catch (_e) {} return resp; }); },
  async call(targetAppId, functionName, callArgs) {
    if (!targetAppId || !functionName) throw new Error('target app id and function name are required');
    if (!__ulAllowsAppCall(targetAppId, functionName)) {
      throw new Error('app:call permission or a matching dependency is required');
    }
    var authToken = ${callAuthToken};
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
    if (__callerCtx) __headers['X-Ultralight-Caller'] = __callerCtx;
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
      throw new Error('ultralight.call failed (' + response.status + '): ' + errorText);
    }
    var rpcResponse = await response.json();
    if (rpcResponse.error) {
      throw new Error('ultralight.call RPC error: ' + (rpcResponse.error.message || JSON.stringify(rpcResponse.error)));
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
  // the USER wired a subscribe grant. The signed caller context (asserting this
  // app + user, unforgeably) identifies the emitter; the worker secret gates
  // the internal endpoint. Capped per execution to bound emit storms.
  async emit(topic, payload) {
    if (!topic || typeof topic !== 'string') throw new Error('emit requires a topic string');
    var __ctx = ${callerContextToken};
    if (!__ctx) throw new Error('emit requires an authenticated user context');
    globalThis.__emitCount = (globalThis.__emitCount || 0) + 1;
    if (globalThis.__emitCount > 50) throw new Error('emit limit reached for this execution');
    var __body = JSON.stringify({ topic: topic, payload: payload || {} });
    // Fail fast on an oversized payload (the server enforces a 32KB payload cap
    // authoritatively; this just avoids a wasted round-trip with a clearer error).
    if (__body.length > 64 * 1024) throw new Error('emit payload too large (max 32KB)');
    var e = globalThis.__rpcEnv;
    var fetchFn = (e && e.SELF) ? e.SELF.fetch.bind(e.SELF) : fetch;
    var resp = await fetchFn('https://internal/api/events/emit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': ${netWorkerSecret}, 'X-Ultralight-Caller': __ctx },
      body: __body
    });
    if (!resp.ok) { var t = await resp.text().catch(function() { return resp.statusText; }); throw new Error('emit failed (' + resp.status + '): ' + t); }
    return await resp.json();
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
      api[fn] = function(args) { return globalThis.ultralight.call(binding.targetAppId, fn, args); };
    });
    return api;
  },
  // net:connect — high-level protocol methods via internal HTTP (gated by permission)
  net: ${
      config.permissions.includes("net:connect")
        ? `{
    async imapFetchUnseen(host, port, user, pass, lastUid, businessEmail, processedFlag, limit) {
      var e = globalThis.__rpcEnv;
      var fetchFn = (e && e.SELF) ? e.SELF.fetch.bind(e.SELF) : fetch;
      var resp = await fetchFn('https://internal/api/net/imap-fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': ${netWorkerSecret} },
        body: JSON.stringify({ host: host, port: port, user: user, pass: pass, lastUid: lastUid || 0, businessEmail: businessEmail || '', processedFlag: processedFlag || '$ULProcessed', limit: limit || 20 }),
      });
      if (!resp.ok) { var err = await resp.text(); throw new Error('IMAP fetch failed: ' + err); }
      return await resp.json();
    },
    async smtpSend(host, port, user, pass, from, fromName, to, subject, body, inReplyTo) {
      var e = globalThis.__rpcEnv;
      var fetchFn = (e && e.SELF) ? e.SELF.fetch.bind(e.SELF) : fetch;
      var resp = await fetchFn('https://internal/api/net/smtp-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Worker-Secret': ${netWorkerSecret} },
        body: JSON.stringify({ host: host, port: port, user: user, pass: pass, from: from, fromName: fromName || '', to: to, subject: subject, body: body, inReplyTo: inReplyTo || '' }),
      });
      if (!resp.ok) { var err = await resp.text(); throw new Error('SMTP send failed: ' + err); }
      return await resp.json();
    },
    connectTls() { throw new Error('Low-level sockets not available. Use ultralight.net.imapFetchUnseen() or .smtpSend().'); },
  }`
        : `{
    imapFetchUnseen() { throw new Error('net:connect permission required.'); },
    smtpSend() { throw new Error('net:connect permission required.'); },
    connectTls() { throw new Error('net:connect permission required.'); },
  }`
    },
};
`;

    // 3. Build wrapper module — entry point, sets RPC env, calls function
    const escapedFnName = JSON.stringify(functionName);
    const escapedArgs = JSON.stringify(args);

    const wrapperModule = `
import './setup.js';
import * as appModule from './app.js';

export default {
  async fetch(request, env) {
    // Set RPC bindings for lazy getters in ultralight SDK
    globalThis.__rpcEnv = env;
    // Reset the per-execution AI-cost accumulator. Each execution runs in a
    // fresh isolate today, but resetting here keeps the per-grant cap
    // accounting correct independent of any future CF isolate reuse.
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
      const fnName = ${escapedFnName};
      const fnArgs = ${escapedArgs};

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
          operationMetering: config.cloudOperationMetering,
          operationBillingConfig: config.cloudOperationBillingConfig,
        },
      });
    }

    if (config.permissions.includes("ai:call") && ctx?.exports?.AIBinding) {
      bindings.AI = ctx.exports.AIBinding({
        props: {
          userId: config.userId,
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
          unavailableReason: config.aiUnavailableReason || null,
        },
      });
    }

    // Network: pass SELF binding so Dynamic Worker can call /api/net/* internally
    // (Direct fetch() to Worker URL goes through CDN which blocks it)
    const env = globalThis.__env;
    const hasInterAppCall = config.permissions.includes("app:call") ||
      !!config.appCallDependencies?.length;
    if (
      (config.permissions.includes("net:connect") || hasInterAppCall) &&
      env?.SELF
    ) {
      bindings.SELF = env.SELF;
    }

    // 5. Create Dynamic Worker
    const hasOutboundNetwork = config.permissions.includes("net:connect") ||
      config.permissions.includes("net:fetch") ||
      hasInterAppCall;
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
    };
    // Network-capable apps need outbound fetch() for external APIs and internal TCP endpoints.
    if (hasOutboundNetwork) loadConfig.globalOutbound = undefined;
    const worker = loader.load(loadConfig);

    // 6. Execute with timeout
    const timeoutMs = config.timeoutMs || 30_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const entrypoint = worker.getEntrypoint();
    const response = await entrypoint.fetch(
      new Request("http://internal/execute"),
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
      // Credits actually debited for in-sandbox AI calls this execution
      // (accumulated by the SDK ai() wrapper). Drives both the receipt and
      // the cross-Agent grant monthly cap.
      aiCostLight?: number;
      error?: { type: string; message: string };
    };

    return {
      success: data.success,
      result: data.result,
      logs: data.logs || [],
      durationMs: Date.now() - startTime,
      aiCostLight: typeof data.aiCostLight === "number" ? data.aiCostLight : 0,
      ...(data.error ? { error: data.error } : {}),
    };
  } catch (err) {
    return {
      success: false,
      result: null,
      logs: [],
      durationMs: Date.now() - startTime,
      aiCostLight: 0,
      error: {
        type: err instanceof Error ? err.constructor.name : "UnknownError",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
