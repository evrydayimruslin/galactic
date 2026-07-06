// Bundler Service
// Uses esbuild-wasm to bundle user code with npm dependencies.
// Runs at upload time to create a single self-contained bundle.
// MCP-only: no ESM browser bundle generation.
//
// Cloudflare Workers compatible — no filesystem or subprocess usage.
// All file operations are in-memory via esbuild's virtual filesystem plugin.

import * as esbuild from 'esbuild-wasm';

// ============================================
// TYPES
// ============================================

export interface BundleResult {
  success: boolean;
  code: string;           // IIFE format for MCP sandbox execution
  esmCode?: string;       // ESM format for Dynamic Worker loading (populated when bundling succeeds)
  errors: string[];
  warnings: string[];
  hasExternalImports: boolean;
}

export interface FileInput {
  name: string;
  content: string;
}

// ============================================
// ESBUILD INITIALIZATION
// ============================================

let esbuildInitialized = false;

async function ensureEsbuild(): Promise<void> {
  if (esbuildInitialized) return;

  try {
    // Polyfill: esbuild-wasm needs performance.now() for timing
    if (typeof globalThis.performance === 'undefined') {
      (globalThis as any).performance = { now: () => Date.now() };
    }

    // Polyfill: esbuild-wasm references __filename/__dirname (Node.js APIs) not available in Workers
    if (typeof (globalThis as any).__filename === 'undefined') {
      (globalThis as any).__filename = '/worker.js';
      (globalThis as any).__dirname = '/';
    }

    if (typeof (globalThis as any).Deno !== 'undefined') {
      // Deno: import map points 'esbuild-wasm' → npm:esbuild-wasm.
      // Let esbuild-wasm auto-locate its .wasm file from the npm package.
      await esbuild.initialize({ worker: false });
    } else {
      // CF Workers: load the wrangler-bundled .wasm module via a separate
      // loader file with a static import so wrangler can attach the wasm asset.
      // api/deno.check.json maps that wasm import to a source stub for Deno's
      // analyzer; the production Worker build still sees the real wasm import.
      const loaderMod = await import('./esbuild-wasm-loader.ts');
      const wasmModule = loaderMod.default;
      await esbuild.initialize({
        wasmModule,
        worker: false,  // CF Workers don't support Web Worker API — run on main thread
      });
    }
    esbuildInitialized = true;
  } catch (err) {
    // If already initialized (e.g., hot reload), ignore
    if (String(err).includes('already been called')) {
      esbuildInitialized = true;
    } else {
      throw err;
    }
  }
}

// ============================================
// VIRTUAL FILESYSTEM PLUGIN
// ============================================

/**
 * Resolve a relative import path against the virtual file system.
 * Handles: './foo', './foo.ts', '../bar', etc.
 */
function resolveVirtualPath(
  importPath: string,
  importer: string,
  files: FileInput[],
): string {
  // External/CDN imports pass through
  if (importPath.startsWith('http://') || importPath.startsWith('https://')) {
    return importPath;
  }

  // Resolve relative to importer
  let resolved = importPath;
  if (importPath.startsWith('./') || importPath.startsWith('../')) {
    const importerDir = importer.includes('/') ? importer.substring(0, importer.lastIndexOf('/')) : '.';
    const parts = [...importerDir.split('/'), ...importPath.split('/')];
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') { normalized.pop(); continue; }
      normalized.push(part);
    }
    resolved = normalized.join('/');
  }

  // Try exact match, then with extensions
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx'];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (files.some(f => f.name === candidate)) return candidate;
  }

  // Try index files
  for (const ext of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
    const candidate = resolved + ext;
    if (files.some(f => f.name === candidate)) return candidate;
  }

  return resolved;
}

/**
 * Get esbuild loader from file extension.
 */
function getLoader(path: string): esbuild.Loader {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.jsx')) return 'jsx';
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  return 'js';
}

/**
 * esbuild plugin that resolves imports against an in-memory file map.
 * No filesystem access needed.
 */
function createVirtualFsPlugin(files: FileInput[]): esbuild.Plugin {
  return {
    name: 'virtual-fs',
    setup(build) {
      // Mark all local files as virtual
      build.onResolve({ filter: /.*/ }, (args) => {
        // Let external URLs pass through (esm.sh CDN)
        if (args.path.startsWith('http://') || args.path.startsWith('https://')) {
          return { path: args.path, external: true };
        }

        // node: builtins are external
        if (args.path.startsWith('node:')) {
          return { path: args.path, external: true };
        }

        // 'ultralight' is always external (provided by sandbox runtime)
        if (args.path === 'ultralight') {
          return { path: args.path, external: true };
        }

        // Resolve against virtual filesystem
        const resolved = resolveVirtualPath(args.path, args.importer || '', files);

        // If it's a known local file, load from virtual fs
        if (files.some(f => f.name === resolved)) {
          return { path: resolved, namespace: 'virtual' };
        }

        // Unknown external import — transform to CDN URL.
        // SECURITY (#25): the resulting `import ... from "https://esm.sh/<pkg>"`
        // stays as an EXTERNAL specifier in the emitted bundle, so the executed-
        // bundle attestation hashes the import STATEMENT, not the third-party
        // bytes esm.sh serves (unpinned: no exact version, no SRI), and those
        // bytes are never safety-scanned. At runtime workerd resolves this
        // specifier through the sandbox globalOutbound: non-network apps
        // (globalOutbound=null) fail to load; network apps load it ONLY if they
        // allowlisted esm.sh (default-deny egress). Flag it so callers can
        // surface "imports remote code" on the disclosure/trust surface.
        if (!args.path.startsWith('./') && !args.path.startsWith('../')) {
          return {
            path: `https://esm.sh/${args.path}`,
            external: true,
            warnings: [{
              text: `Imports remote npm package "${args.path}" from esm.sh at ` +
                `runtime; those bytes are not scanned and not covered by the ` +
                `executed-bundle attestation. Vendor it into your source to ` +
                `keep the app fully self-contained.`,
            }],
          };
        }

        return { path: resolved, namespace: 'virtual' };
      });

      // Load files from virtual filesystem
      build.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
        const file = files.find(f => f.name === args.path);
        if (!file) {
          return { errors: [{ text: `File not found in virtual fs: ${args.path}` }] };
        }
        return {
          contents: file.content,
          loader: getLoader(args.path),
        };
      });
    },
  };
}

// ============================================
// MAIN BUNDLE FUNCTION
// ============================================

/**
 * Bundle user code using esbuild-wasm (in-memory, no filesystem).
 * - Resolves and inlines ALL imports (npm and relative)
 * - Outputs a single self-contained IIFE bundle
 * - Critical: IIFE format required for sandbox execution via AsyncFunction
 */
export async function bundleCode(
  files: FileInput[],
  entryPoint: string,
): Promise<BundleResult> {
  const entryFile = files.find(f => f.name === entryPoint);
  if (!entryFile) {
    return {
      success: false,
      code: '',
      errors: [`Entry point not found: ${entryPoint}`],
      warnings: [],
      hasExternalImports: false,
    };
  }

  const hasExternalImports = detectExternalImports(entryFile.content);
  const hasAnyImports = detectAnyImports(entryFile.content);
  const isTypeScript = entryPoint.endsWith('.ts') || entryPoint.endsWith('.tsx');

  // If no imports AND not TypeScript, return code as-is (no bundling needed)
  // TypeScript files always need transpilation even without imports
  if (!hasAnyImports && !isTypeScript) {
    return {
      success: true,
      code: entryFile.content,
      errors: [],
      warnings: [],
      hasExternalImports: false,
    };
  }

  try {
    await ensureEsbuild();

    // Detect React/JSX project for loader configuration
    const isReactProject = entryPoint.endsWith('.tsx') || entryPoint.endsWith('.jsx') ||
      files.some(f => f.name.endsWith('.tsx') || f.name.endsWith('.jsx')) ||
      files.some(f => f.content.includes('from "react"') || f.content.includes("from 'react'"));

    const buildOptions: esbuild.BuildOptions = {
      entryPoints: [entryPoint],
      bundle: true,
      format: 'iife',
      globalName: '__exports',
      platform: 'browser',
      target: 'esnext',
      write: false,             // Return in-memory, no filesystem
      minifySyntax: true,
      external: ['ultralight'],
      plugins: [createVirtualFsPlugin(files)],
    };

    // Add JSX support if needed
    if (isReactProject) {
      buildOptions.jsx = 'automatic';
      buildOptions.jsxImportSource = 'https://esm.sh/react';
    }

    const result = await esbuild.build(buildOptions);

    const outputCode = result.outputFiles?.[0]?.text || '';
    const processedCode = postProcessBundle(outputCode);

    // Also produce ESM bundle for Dynamic Worker loading.
    // The runtime at api/runtime/dynamic-sandbox.ts loads from KV `esm:{appId}:latest`
    // which is written from this esmCode — if this silently fails, the runtime
    // will keep serving whatever bundle was there before. Log errors visibly so
    // upload handlers can surface them and fall back to direct transform.
    let esmCode: string | undefined;
    try {
      const esmResult = await bundleCodeESM(files, entryPoint);
      if (esmResult.success) {
        esmCode = esmResult.code;
      } else {
        console.warn('[BUNDLER] ESM bundle reported failure:', esmResult.errors.join('; '));
      }
    } catch (esmErr) {
      console.warn('[BUNDLER] ESM bundle threw:', esmErr instanceof Error ? esmErr.message : String(esmErr));
      // ESM bundling is non-fatal here — upload handler has a transform fallback
    }

    // A React/JSX app is bundled with jsxImportSource=esm.sh/react, which
    // injects a remote `import ... from "https://esm.sh/react/jsx-runtime"`
    // into the output even when the source has no explicit import — so it emits
    // remote code just like a bare-npm import (#25). detectExternalImports scans
    // SOURCE and misses this, so flag it here and warn the developer.
    const jsxRemoteWarning = isReactProject
      ? ['This app renders JSX/React, which is bundled with a remote import from ' +
         'esm.sh/react at runtime; those bytes are not scanned and not covered by ' +
         'the executed-bundle attestation. Vendor React into your source to keep ' +
         'the app fully self-contained.']
      : [];
    return {
      success: result.errors.length === 0,
      code: processedCode,
      esmCode,
      errors: result.errors.map(e => e.text),
      warnings: [...result.warnings.map(e => e.text), ...jsxRemoteWarning],
      hasExternalImports: hasExternalImports || isReactProject,
    };
  } catch (err) {
    return {
      success: false,
      code: '',
      errors: [err instanceof Error ? err.message : String(err)],
      warnings: [],
      hasExternalImports,
    };
  }
}

// ============================================
// ESM BUNDLE FUNCTION (for Dynamic Workers)
// ============================================

/**
 * Bundle user code as ESM module for Dynamic Worker loading.
 * Same as bundleCode() but outputs ES module format instead of IIFE.
 * The `ultralight` global is expected to be provided by the Dynamic Worker runtime.
 */
export async function bundleCodeESM(
  files: FileInput[],
  entryPoint: string,
): Promise<BundleResult> {
  const entryFile = files.find(f => f.name === entryPoint);
  if (!entryFile) {
    return {
      success: false,
      code: '',
      errors: [`Entry point not found: ${entryPoint}`],
      warnings: [],
      hasExternalImports: false,
    };
  }

  const hasExternalImports = detectExternalImports(entryFile.content);
  const hasAnyImports = detectAnyImports(entryFile.content);
  const isTypeScript = entryPoint.endsWith('.ts') || entryPoint.endsWith('.tsx');

  if (!hasAnyImports && !isTypeScript) {
    // Wrap plain JS in ESM exports
    return {
      success: true,
      code: entryFile.content + '\n',
      errors: [],
      warnings: [],
      hasExternalImports: false,
    };
  }

  try {
    await ensureEsbuild();

    const isReactProject = entryPoint.endsWith('.tsx') || entryPoint.endsWith('.jsx') ||
      files.some(f => f.name.endsWith('.tsx') || f.name.endsWith('.jsx')) ||
      files.some(f => f.content.includes('from "react"') || f.content.includes("from 'react'"));

    const buildOptions: esbuild.BuildOptions = {
      entryPoints: [entryPoint],
      bundle: true,
      format: 'esm',           // ESM for Dynamic Worker modules
      platform: 'browser',
      target: 'esnext',
      write: false,
      minifySyntax: true,
      external: ['ultralight'], // Provided by Dynamic Worker runtime
      plugins: [createVirtualFsPlugin(files)],
    };

    if (isReactProject) {
      buildOptions.jsx = 'automatic';
      buildOptions.jsxImportSource = 'https://esm.sh/react';
    }

    const result = await esbuild.build(buildOptions);
    const outputCode = result.outputFiles?.[0]?.text || '';

    // See bundleCode: a React/JSX app emits a remote esm.sh/react import that
    // detectExternalImports (source-only) misses. Flag it + warn (#25).
    const jsxRemoteWarning = isReactProject
      ? ['This app renders JSX/React, which is bundled with a remote import from ' +
         'esm.sh/react at runtime; those bytes are not scanned and not covered by ' +
         'the executed-bundle attestation. Vendor React into your source to keep ' +
         'the app fully self-contained.']
      : [];
    return {
      success: result.errors.length === 0,
      code: postProcessBundle(outputCode),
      errors: result.errors.map(e => e.text),
      warnings: [...result.warnings.map(e => e.text), ...jsxRemoteWarning],
      hasExternalImports: hasExternalImports || isReactProject,
    };
  } catch (err) {
    return {
      success: false,
      code: '',
      errors: [err instanceof Error ? err.message : String(err)],
      warnings: [],
      hasExternalImports,
    };
  }
}

// ============================================
// IMPORT DETECTION
// ============================================

/**
 * Detect if code has ANY imports (relative or external)
 * Used to determine if bundling is needed at all
 */
function detectAnyImports(code: string): boolean {
  const importRegex = /import\s+.*?\s+from\s+['"][^'"]+['"]/;
  const bareImportRegex = /import\s+['"][^'"]+['"]/;
  return importRegex.test(code) || bareImportRegex.test(code);
}

/**
 * Detect if code has external (npm) imports
 */
function detectExternalImports(code: string): boolean {
  const importRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(code)) !== null) {
    const importPath = match[1];
    if (importPath.startsWith('./') || importPath.startsWith('../')) continue;
    if (importPath.startsWith('https://deno.land/')) continue;
    return true;
  }

  if (/require\s*\(\s*['"][^'"]+['"]\s*\)/.test(code)) return true;

  return false;
}

// ============================================
// POST-PROCESSING
// ============================================

/**
 * Post-process bundled code for our runtime
 */
function postProcessBundle(code: string): string {
  // Remove any import.meta references that might cause issues
  let processed = code.replace(/import\.meta\.url/g, '"file://ultralight-app"');
  return processed;
}

// ============================================
// QUICK BUNDLE (no esbuild)
// ============================================

/**
 * Quick bundle using in-memory transformation (no esbuild)
 * For simple cases without npm dependencies
 */
export function quickBundle(files: FileInput[], entryPoint: string): BundleResult {
  const entryFile = files.find(f => f.name === entryPoint);

  if (!entryFile) {
    return {
      success: false,
      code: '',
      errors: [`Entry point not found: ${entryPoint}`],
      warnings: [],
      hasExternalImports: false,
    };
  }

  let bundledCode = entryFile.content;

  // Find local imports and inline them
  const localImportRegex = /import\s+(\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]\.\/([^'"]+)['"]/g;
  const imports: Array<{ statement: string; path: string }> = [];

  let match;
  while ((match = localImportRegex.exec(entryFile.content)) !== null) {
    imports.push({ statement: match[0], path: match[2] });
  }

  // Inline local files (simple approach)
  for (const imp of imports) {
    let localPath = imp.path;
    if (!localPath.endsWith('.ts') && !localPath.endsWith('.js')) {
      localPath += '.ts';
    }

    const localFile = files.find(f => f.name === localPath || f.name === imp.path + '.js');
    if (localFile) {
      bundledCode = bundledCode.replace(imp.statement, '');
      bundledCode = `// Inlined from ${localPath}\n${localFile.content}\n\n${bundledCode}`;
    }
  }

  return {
    success: true,
    code: bundledCode,
    errors: [],
    warnings: [],
    hasExternalImports: detectExternalImports(entryFile.content),
  };
}
