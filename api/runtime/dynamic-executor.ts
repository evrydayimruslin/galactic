// Dynamic Worker Executor — runs agent-written JavaScript recipes in
// a Cloudflare Dynamic Worker isolate with in-process MCP function calls.
//
// Replaces the AsyncFunction-based codemode-executor.ts for the ul.codemode path.
// App code is pre-compiled to ESM and loaded as modules into the Dynamic Worker.
// Each function call is a direct in-process import, not an HTTP round-trip.
//
// Falls back to the existing HTTP-based executor if LOADER binding is unavailable.

import type { ExecuteResult } from './codemode-executor.ts';
import {
  type BundleAttestation,
  executedBundleVerifyMode,
  handleExecutedBundleVerdict,
  verifyExecutedBundle,
} from '../services/executed-bundle.ts';

// ============================================
// TYPES
// ============================================

export interface DynamicExecuteOptions {
  /** Recipe code (agent-written JavaScript) */
  code: string;
  /** Tool map: sanitized name → { appId, fnName } */
  toolMap: Record<string, { appId: string; fnName: string }>;
  /** Pre-compiled ESM bundles: appId → ESM code string */
  appBundles: Record<string, string>;
  /** Signed integrity attestations per appBundle (from loadLiveExecutedBundle). */
  appAttestations?: Record<string, BundleAttestation | null>;
  /** RPC binding stubs (DB, DATA, AI, MEMORY per app) */
  bindings: Record<string, unknown>;
  /** User context (id, email, etc.) — needed by app code that accesses ultralight.user */
  userContext?: { id: string; email: string; displayName?: string | null; avatarUrl?: string | null; tier?: string } | null;
  /** App environment variables */
  envVars?: Record<string, string>;
  /** Execution timeout in ms (default 60s) */
  timeoutMs?: number;
  /** Attached files from chat input — available as `__files` in recipe code */
  files?: Array<{ name: string; size: number; mimeType: string; content: string }>;
}

// ============================================
// MAIN EXECUTOR
// ============================================

/**
 * Execute a recipe in a Dynamic Worker isolate.
 *
 * The recipe code runs in a fresh V8 isolate with:
 * - Pre-compiled app bundles loaded as ESM modules
 * - RPC binding stubs for DB, data, AI, memory (no credentials exposed)
 * - globalOutbound: null (no raw network access)
 *
 * Each codemode.fn_name() call is a direct in-process function call (~5ms)
 * instead of an HTTP round-trip (~500ms).
 */
export async function executeDynamicCodeMode(
  options: DynamicExecuteOptions,
): Promise<ExecuteResult> {
  const { code, toolMap, appBundles, appAttestations, bindings, userContext, envVars, timeoutMs = 60_000, files } = options;
  const loader = globalThis.__env?.LOADER;

  if (!loader) {
    // Fallback: no LOADER binding (local dev or feature not available)
    // Delegate to the HTTP-based executor
    console.warn('[DYNAMIC] LOADER binding not available, falling back to HTTP executor');
    const { executeCodeMode } = await import('./codemode-executor.ts');
    const { buildToolFunctions } = await import('../services/codemode-tools.ts');
    const { getEnv } = await import('../lib/env.ts');

    // Build HTTP-based tool functions (existing path)
    const baseUrl = getEnv('BASE_URL');
    // Note: authToken would need to be passed in; for fallback this is acceptable
    const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const [name, mapping] of Object.entries(toolMap)) {
      fns[name] = async (..._incomingArgs: unknown[]) => {
        throw new Error(`Dynamic Worker fallback: ${mapping.fnName} not available without LOADER`);
      };
    }
    return await executeCodeMode(code, fns, timeoutMs);
  }

  // Executed-bundle integrity: each appBundle here is the live esm:{appId}:latest
  // pointer; verify every one against its atomically-loaded attestation so
  // codemode and the Flash orchestrator can't run a tampered bundle that the
  // direct gx.call path would refuse — same observe -> enforce policy. No
  // expectedVersion is threaded here (would need a per-app DB read on a multi-app
  // hot path), so the non-blocking version-skew DETECTION is direct-path-only;
  // sig + hash (the hard blocks) are enforced on every path.
  const bundleVerifyMode = executedBundleVerifyMode();
  if (bundleVerifyMode !== 'off') {
    for (const [appId, bundle] of Object.entries(appBundles)) {
      const verdict = await verifyExecutedBundle({
        appId,
        esmCode: bundle,
        attestation: appAttestations?.[appId] ?? null,
      });
      if (handleExecutedBundleVerdict(appId, verdict, bundleVerifyMode)) {
        return {
          result: undefined,
          error:
            `Executed bundle failed integrity verification for ${appId} (${verdict.status})`,
          logs: [],
        };
      }
    }
  }

  // Build the recipe modules (entry + isolated user-recipe module)
  const { entry: recipeModule, recipe: recipeUserModule } = buildRecipeModule(
    code,
    toolMap,
    files,
  );

  // Setup module: sets globalThis.ultralight with lazy getters
  // MUST run before any app module that captures globalThis.ultralight at init time
  const userJson = userContext ? JSON.stringify(userContext) : 'null';
  const envVarsJson = JSON.stringify(envVars || {});
  const setupModule = `
globalThis.__rpcEnv = {};
globalThis.ultralight = {
  get db() {
    const e = globalThis.__rpcEnv;
    const __removed = function (name) {
      return function () {
        throw new Error('galactic.db.' + name + '() was removed. Use the scoped structured API: galactic.db.select/first/insert/update/delete/upsert/count/batch.');
      };
    };
    if (!e.DB) {
      const na = function () { throw new Error('D1 not available'); };
      return {
        select: na, first: na, count: na, insert: na, update: na, delete: na, upsert: na, batch: na,
        run: __removed('run'), all: __removed('all'), exec: __removed('exec'),
      };
    }
    return {
      select: (table, query) => e.DB.select(Object.assign({ table: table }, query || {})),
      first: (table, query) => e.DB.first(Object.assign({ table: table }, query || {})),
      count: (table, query) => e.DB.count(Object.assign({ table: table }, query || {})),
      insert: (table, values) => e.DB.insert({ table: table, values: values }),
      update: (table, spec) => e.DB.update(Object.assign({ table: table }, spec || {})),
      delete: (table, spec) => e.DB.delete(Object.assign({ table: table }, spec || {})),
      upsert: (table, spec) => e.DB.upsert(Object.assign({ table: table }, spec || {})),
      batch: (ops) => e.DB.batch(ops || []),
      run: __removed('run'), all: __removed('all'), exec: __removed('exec'),
    };
  },
  user: ${userJson},
  env: ${envVarsJson},
  isAuthenticated() { return ${userContext ? 'true' : 'false'}; },
  requireAuth() { ${userContext ? `return ${userJson};` : 'throw new Error("Auth required.");'} },
  store(k, v) { return globalThis.__rpcEnv.DATA?.store(k, v) || Promise.reject('Data not available'); },
  load(k) { return globalThis.__rpcEnv.DATA?.load(k) || Promise.resolve(null); },
  remove(k) { return globalThis.__rpcEnv.DATA?.remove(k) || Promise.reject('Data not available'); },
  list(p) { return globalThis.__rpcEnv.DATA?.list(p) || Promise.resolve([]); },
  remember(k, v) { return globalThis.__rpcEnv.MEMORY?.remember(k, v) || Promise.resolve(); },
  recall(k) { return globalThis.__rpcEnv.MEMORY?.recall(k) || Promise.resolve(null); },
  ai(r) { return globalThis.__rpcEnv.AI?.call(r) || Promise.resolve({ content: '', error: 'AI not available' }); },
  call() { throw new Error('galactic.call() not available in codemode sandbox'); },
};
// Galactic rename: galactic.* is the new SDK namespace (alias of ultralight.*).
globalThis.galactic = globalThis.ultralight;
`;

  // Build modules map: setup + recipe entry + isolated user recipe + bundles
  const modules: Record<string, string> = {
    'setup.js': setupModule,
    'recipe.js': recipeModule,
    'recipe-user.js': recipeUserModule,
  };
  for (const [appId, bundle] of Object.entries(appBundles)) {
    const safeId = appId.replace(/-/g, '_');
    modules[`app_${safeId}.js`] = bundle;
  }

  try {
    // Create Dynamic Worker with sandboxed environment
    const worker = loader.load({
      compatibilityDate: '2026-03-01',
      mainModule: 'recipe.js',
      modules,
      env: bindings,
      globalOutbound: null,  // Block ALL network access
      // Tenant isolation: codemode recipes are pure compute over binding RPC
      // (network blocked above) — a bounded ceiling instead of inheriting the
      // parent's full budget. Whether ctx.exports RPC counts against
      // subRequests is unverified (staging smoke); sized so a legitimate
      // multi-record recipe cannot trip it either way.
      limits: { cpuMs: 10_000, subRequests: 128 },
    });

    // Execute with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Must call getEntrypoint() first, then fetch() on the entrypoint
      const entrypoint = worker.getEntrypoint();
      const response = await entrypoint.fetch(
        new Request('http://internal/execute'),
        { signal: controller.signal },
      );
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        return { result: undefined, error: `Dynamic Worker error (${response.status}): ${errText}`, logs: [] };
      }

      const data = await response.json() as { result: unknown; error?: string; logs: string[] };
      return {
        result: data.result,
        error: data.error,
        logs: data.logs || [],
      };
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof Error && err.name === 'AbortError') {
        return { result: undefined, error: `Recipe execution timed out after ${timeoutMs / 1000}s`, logs: [] };
      }
      throw err;
    }
  } catch (err) {
    return {
      result: undefined,
      error: err instanceof Error ? err.message : String(err),
      logs: [],
    };
  }
}

// ============================================
// RECIPE MODULE BUILDER
// ============================================

/**
 * Build the ESM entry module for the Dynamic Worker.
 *
 * This module:
 * 1. Imports pre-compiled app bundles as ESM modules
 * 2. Constructs the `codemode` namespace from the tool map
 * 3. Wraps each tool function to set up the `ultralight` SDK from env bindings
 * 4. Executes the agent's recipe code as an async function body
 * 5. Returns { result, logs } as JSON response
 */
function buildRecipeModule(
  recipeCode: string,
  toolMap: Record<string, { appId: string; fnName: string }>,
  files?: Array<{ name: string; size: number; mimeType: string; content: string }>,
): { entry: string; recipe: string } {
  // Collect unique app IDs
  const appIds = [...new Set(Object.values(toolMap).map(t => t.appId))];

  // Generate import statements for each app bundle
  const imports = appIds.map(id => {
    const safeId = id.replace(/-/g, '_');
    return `import * as app_${safeId} from './app_${safeId}.js';`;
  });

  // Generate codemode namespace entries
  // Each tool function switches globalThis.__rpcEnv to the correct app's bindings
  // before calling the app function, so ultralight.db resolves to the right D1 database.
  const toolEntries = Object.entries(toolMap).map(([sanitizedName, mapping]) => {
    const safeAppId = mapping.appId.replace(/-/g, '_');
    return `    ${sanitizedName}: async (args) => {
      // Switch RPC env to this app's bindings
      globalThis.__rpcEnv = {
        DB: env['DB_${safeAppId}'],
        DATA: env['DATA_${safeAppId}'],
        MEMORY: env['MEMORY'],
        AI: env['AI'],
      };
      const fn = app_${safeAppId}['${mapping.fnName}'];
      if (!fn) throw new Error('Function ${mapping.fnName} not found in app ${mapping.appId}');
      return await fn(args);
    }`;
  });

  // SECURITY (P5 / Phase 4c): the user recipe lives in its OWN module that
  // imports NO app bundles and receives the FILTERED `codemode` namespace as a
  // parameter. This prevents the recipe from reaching a dropped function via
  // lexical access to an `app_<id>` namespace — it can ONLY call what survives
  // the access filter, via codemode.<fn>. The entry module imports the bundles
  // (to build codemode) and the isolated recipe, then invokes it.
  const recipe = `// Auto-generated user recipe — imports NO app bundles by design.
export default async function __ulRecipe(codemode, console, __files) {
${recipeCode}
}
`;

  const entry = `// Auto-generated Dynamic Worker recipe entry module
// setup.js MUST be imported first — sets globalThis.ultralight with lazy getters
import './setup.js';
import __ulRecipe from './recipe-user.js';
${imports.join('\n')}

export default {
  async fetch(request, env) {
    // Set default RPC env for lazy getters in globalThis.ultralight
    globalThis.__rpcEnv = env;

    // Build codemode namespace — each function switches __rpcEnv to its app's bindings
    const codemode = {
${toolEntries.join(',\n')}
    };

    const logs = [];
    const sandboxConsole = {
      log: (...args) => logs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')),
      warn: (...args) => logs.push('[warn] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')),
      error: (...args) => logs.push('[error] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')),
    };

    // Attached files from chat input — available as __files in recipe code
    const __files = ${files?.length ? JSON.stringify(files) : '[]'};

    try {
      // The recipe runs in its own module scope — only codemode/console/__files
      // (plus globalThis.ultralight) are reachable; app_* bundles are not.
      const result = await __ulRecipe(codemode, sandboxConsole, __files);
      return Response.json({ result, logs });
    } catch (err) {
      return Response.json({
        result: undefined,
        error: err instanceof Error ? err.message : String(err),
        logs,
      });
    }
  }
};
`;
  return { entry, recipe };
}
