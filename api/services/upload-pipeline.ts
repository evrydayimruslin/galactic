// Upload Pipeline — Shared processing stages for all upload paths
//
// Eliminates code path divergence by providing a single pipeline that:
// - Detects runtime (GPU vs Deno)
// - Parses and validates manifest
// - Detects entry file
// - Extracts exports
// - Bundles code (Deno only)
// - Runs safety scan
// - Extracts and validates D1 migrations
// - Provisions D1 and runs migrations SYNCHRONOUSLY (eager, not lazy)
//
// All upload handlers (form upload, programmatic upload, MCP version update,
// draft upload) call this pipeline instead of duplicating logic.

import type { BuildLogEntry } from '../../shared/types/index.ts';
import type { AppManifest } from '../../shared/contracts/manifest.ts';
import { validateManifest } from '../../shared/contracts/manifest.ts';
import { bundleCode } from './bundler.ts';
import {
  hydrateManifestForSource,
  upsertManifestUploadFile,
} from './app-manifest-generation.ts';
import { generateGpuManifest } from './trust.ts';
import {
  parseMigrationFiles,
  validateMigrationSchema,
  runMigrations,
  updateMigrationVersion,
  type MigrationFile,
  type MigrationResult,
} from './d1-migrations.ts';
import { provisionD1ForApp, type D1ProvisionResult } from './d1-provisioning.ts';
import { detectGpuConfig, parseGpuConfig } from './gpu/config.ts';
import type { GpuConfig } from './gpu/types.ts';
import {
  getGpuSupportDisabledMessage,
  isGpuSupportEnabled,
} from './gpu/feature-flag.ts';

// ============================================
// TYPES
// ============================================

export interface PipelineFile {
  name: string;
  content: string;
}

export interface PipelineOptions {
  /** Override app type from caller (e.g. 'mcp') */
  appType?: string;
  /** Override functions entry from caller */
  functionsEntry?: string;
  /** Override name from caller */
  name?: string;
  /** Override description from caller */
  description?: string;
  /** Override version for generated manifests */
  version?: string;
}

export interface D1Status {
  provisioned: boolean;
  status: 'ready' | 'failed' | 'skipped';
  database_id?: string;
  migrations_applied: number;
  migrations_skipped: number;
  migration_errors: string[];
  error?: string;
}

export interface PipelineResult {
  // Runtime detection
  runtime: 'deno' | 'gpu';
  gpuConfig?: GpuConfig;

  // Manifest
  manifest: AppManifest | null;

  // Entry + exports
  entryFile: PipelineFile;
  exports: string[];

  // Bundled code (Deno only)
  bundledCode: string;
  esmBundledCode?: string;
  bundleUsed: boolean;

  // Safety
  safetyPassed: boolean;
  safetyWarnings: number;

  // D1 migrations (extracted and validated, not yet provisioned)
  migrations: MigrationFile[];
  hasMigrations: boolean;

  // Files prepared for R2 upload
  filesToUpload: Array<{ name: string; content: Uint8Array; contentType: string }>;

  // Normalized entry file name
  normalizedEntryName: string;

  // Build logs
  buildLogs: BuildLogEntry[];
}

// ============================================
// HELPERS
// ============================================

function getContentType(filename: string): string {
  if (filename.endsWith('.tsx')) return 'text/typescript-jsx';
  if (filename.endsWith('.ts')) return 'text/typescript';
  if (filename.endsWith('.jsx')) return 'text/javascript-jsx';
  if (filename.endsWith('.js')) return 'application/javascript';
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.md')) return 'text/markdown';
  if (filename.endsWith('.css')) return 'text/css';
  if (filename.endsWith('.sql')) return 'text/plain';
  return 'text/plain';
}

export function extractExports(code: string): string[] {
  const exports: string[] = [];
  const functionRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
  let match;
  while ((match = functionRegex.exec(code)) !== null) exports.push(match[1]);

  const constRegex = /export\s+(?:const|let|var)\s+(\w+)\s*=/g;
  while ((match = constRegex.exec(code)) !== null) exports.push(match[1]);

  const namedExportRegex = /export\s*\{([^}]+)\}/g;
  while ((match = namedExportRegex.exec(code)) !== null) {
    const names = match[1].split(',').map((s) => s.trim().split(' as ')[0].trim());
    exports.push(...names);
  }

  if (/export\s+default/.test(code)) exports.push('default');

  return [...new Set(exports)];
}

function normalizeFileName(files: PipelineFile[], name: string): string {
  const parts = name.split('/');
  if (parts.length > 1) {
    const firstPart = files[0]?.name.split('/')[0];
    const allSameRoot = files.every(f => f.name.startsWith(firstPart + '/'));
    if (allSameRoot && parts[0] === firstPart) {
      return parts.slice(1).join('/');
    }
  }
  return name;
}

// ============================================
// STAGE 1: RUNTIME DETECTION
// ============================================

interface RuntimeDetection {
  runtime: 'deno' | 'gpu';
  gpuConfig?: GpuConfig;
}

function detectRuntime(files: PipelineFile[]): RuntimeDetection {
  const gpuYamlContent = detectGpuConfig(files);
  if (gpuYamlContent) {
    if (!isGpuSupportEnabled()) {
      throw new Error(getGpuSupportDisabledMessage('GPU deployments'));
    }
    const gpuValidation = parseGpuConfig(gpuYamlContent);
    if (!gpuValidation.valid) {
      throw new Error(`Invalid ultralight.gpu.yaml: ${gpuValidation.errors.join(', ')}`);
    }
    return { runtime: 'gpu', gpuConfig: gpuValidation.config! };
  }
  return { runtime: 'deno' };
}

// ============================================
// STAGE 2: MANIFEST PARSING
// ============================================

function parseManifest(files: PipelineFile[], options: PipelineOptions): AppManifest | null {
  const manifestFile = files.find(f => {
    const fileName = f.name.split('/').pop() || f.name;
    return fileName === 'manifest.json';
  });

  let manifest: AppManifest | null = null;

  if (manifestFile) {
    try {
      const manifestJson = JSON.parse(manifestFile.content);
      const validation = validateManifest(manifestJson);
      if (!validation.valid) {
        throw new Error(
          `Invalid manifest.json: ${validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join(', ')}`,
        );
      }
      manifest = validation.manifest!;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Failed to parse manifest.json');
    }
  }

  // Apply option overrides
  if (options.appType || options.functionsEntry) {
    const appType = options.appType === 'mcp' ? 'mcp' : 'mcp';
    const base: AppManifest = manifest ? { ...manifest } : {
      name: options.name || 'Untitled App',
      version: '1.0.0',
      type: appType,
      entry: {},
    };
    if (options.appType === 'mcp') base.type = 'mcp';
    if (options.functionsEntry) base.entry.functions = options.functionsEntry;
    if (options.description) base.description = options.description;
    manifest = base;
  }

  return manifest;
}

// ============================================
// STAGE 3: ENTRY FILE DETECTION
// ============================================

function detectEntryFile(
  files: PipelineFile[],
  manifest: AppManifest | null,
): { entryFile: PipelineFile; functionsFile?: PipelineFile } {
  let entryFile: PipelineFile | undefined;
  let functionsFile: PipelineFile | undefined;

  // Manifest-specified entry
  if (manifest && manifest.entry.functions) {
    functionsFile = files.find(f => {
      const fileName = f.name.split('/').pop() || f.name;
      return fileName === manifest!.entry.functions;
    });
    if (!functionsFile) {
      throw new Error(`Functions entry file not found: ${manifest.entry.functions}`);
    }
    entryFile = functionsFile;
  }

  // Auto-detect fallback
  if (!entryFile) {
    const entryFileNames = ['index.tsx', 'index.ts', 'index.jsx', 'index.js'];
    entryFile = files.find(f => {
      const fileName = f.name.split('/').pop() || f.name;
      return entryFileNames.includes(fileName);
    });
  }

  if (!entryFile) {
    throw new Error('Entry file required. Provide manifest.json with entry.functions, or include index.ts/tsx/js/jsx');
  }

  return { entryFile, functionsFile };
}

// ============================================
// STAGE 4: EXPORT EXTRACTION
// ============================================

function extractExportsFromManifestOrCode(
  manifest: AppManifest | null,
  entryFileContent: string,
): string[] {
  if (manifest?.functions) {
    return Object.keys(manifest.functions);
  }
  return extractExports(entryFileContent);
}

// ============================================
// STAGE 5: CODE BUNDLING
// ============================================

async function bundleEntryFile(
  files: PipelineFile[],
  entryFileName: string,
  entryFileContent: string,
  log: (level: BuildLogEntry['level'], message: string) => void,
): Promise<{ bundledCode: string; esmBundledCode?: string; bundleUsed: boolean }> {
  log('info', 'Bundling code...');
  try {
    const bundleResult = await bundleCode(files, entryFileName);
    if (!bundleResult.success) {
      for (const err of bundleResult.errors) log('error', err);
      throw new Error('Build failed: ' + bundleResult.errors.join(', '));
    }
    for (const warn of bundleResult.warnings) log('warn', warn);

    if (bundleResult.code !== entryFileContent) {
      log('success', 'Bundle complete (IIFE + ESM)');
      return { bundledCode: bundleResult.code, esmBundledCode: bundleResult.esmCode, bundleUsed: true };
    }
    log('success', 'No bundling needed (no imports)');
    return { bundledCode: entryFileContent, bundleUsed: false };
  } catch (err) {
    log('warn', `Bundling skipped: ${err instanceof Error ? err.message : String(err)}`);
    return { bundledCode: entryFileContent, bundleUsed: false };
  }
}

// ============================================
// STAGE 6: SAFETY SCAN
// ============================================

async function runSafetyScanStage(
  files: PipelineFile[],
  log: (level: BuildLogEntry['level'], message: string) => void,
): Promise<{ passed: boolean; warnings: number }> {
  log('info', 'Running safety scan...');
  const { runSafetyScan } = await import('./integrity.ts');
  const result = runSafetyScan(files);

  if (!result.passed) {
    const errorSummary = result.issues
      .filter(i => i.severity === 'error')
      .map(i => `[${i.rule}] ${i.message}`)
      .join('; ');
    throw new Error(`Upload blocked by safety scan: ${errorSummary}`);
  }

  for (const warn of result.issues.filter(i => i.severity === 'warning')) {
    log('warn', `[${warn.rule}] ${warn.message}`);
  }
  log('success', `Safety scan passed (${result.summary.warnings} warnings)`);

  return { passed: true, warnings: result.summary.warnings };
}

// ============================================
// STAGE 7: D1 MIGRATION EXTRACTION + VALIDATION
// ============================================

function extractMigrations(
  files: PipelineFile[],
  log: (level: BuildLogEntry['level'], message: string) => void,
): MigrationFile[] {
  const migrationFileMap: Record<string, string> = {};

  for (const file of files) {
    const pathParts = file.name.split('/');
    const migrationsIdx = pathParts.indexOf('migrations');
    if (migrationsIdx !== -1 && pathParts.length > migrationsIdx + 1) {
      const migrationFilename = pathParts.slice(migrationsIdx + 1).join('/');
      if (migrationFilename.endsWith('.sql')) {
        migrationFileMap[migrationFilename] = file.content;
      }
    }
  }

  if (Object.keys(migrationFileMap).length === 0) return [];

  const parsed = parseMigrationFiles(migrationFileMap);

  // Validate each migration
  for (const migration of parsed) {
    const validation = validateMigrationSchema(migration.sql);
    if (!validation.valid) {
      throw new Error(`Migration ${migration.filename} validation failed: ${validation.errors.join('; ')}`);
    }
    for (const warning of validation.warnings) {
      log('warn', `[Migration] ${warning}`);
    }
  }

  log('info', `Found ${parsed.length} migration(s): ${parsed.map(m => m.filename).join(', ')}`);
  return parsed;
}

// ============================================
// STAGE 8: FILE PREPARATION FOR R2
// ============================================

function prepareFilesForUpload(
  files: PipelineFile[],
  entryFile: PipelineFile,
  bundledCode: string,
  esmBundledCode: string | undefined,
  bundleUsed: boolean,
  normalizedEntryName: string,
  manifest: AppManifest | null,
): Array<{ name: string; content: Uint8Array; contentType: string }> {
  if (bundleUsed) {
    return upsertManifestUploadFile(
      [
      // Bundled entry (IIFE)
      { name: normalizedEntryName, content: new TextEncoder().encode(bundledCode), contentType: getContentType(normalizedEntryName) },
      // ESM bundle for browser rendering
      ...(esmBundledCode ? [{
        name: normalizedEntryName.replace(/\.(tsx?|jsx?)$/, '.esm.js'),
        content: new TextEncoder().encode(esmBundledCode),
        contentType: 'application/javascript',
      }] : []),
      // Original source (for docs/parsing)
      { name: `_source_${normalizedEntryName}`, content: new TextEncoder().encode(entryFile.content), contentType: getContentType(normalizedEntryName) },
      // Remaining files
      ...files
        .filter(f => f.name !== entryFile.name)
        .map(f => ({
          name: normalizeFileName(files, f.name),
          content: new TextEncoder().encode(f.content),
          contentType: getContentType(f.name),
        })),
      ],
      manifest,
      (manifestJson) => ({
        name: 'manifest.json',
        content: new TextEncoder().encode(manifestJson),
        contentType: 'application/json',
      }),
    );
  }

  return upsertManifestUploadFile(
    files.map(f => ({
      name: normalizeFileName(files, f.name),
      content: new TextEncoder().encode(f.content),
      contentType: getContentType(f.name),
    })),
    manifest,
    (manifestJson) => ({
      name: 'manifest.json',
      content: new TextEncoder().encode(manifestJson),
      contentType: 'application/json',
    }),
  );
}

// ============================================
// STAGE 9: D1 PROVISIONING (called separately after app record exists)
// ============================================

/**
 * Provision D1 and run migrations SYNCHRONOUSLY.
 * Called by the upload handler AFTER the app record is created (needs appId).
 * Returns status for inclusion in the upload response.
 */
export async function provisionAndMigrate(
  appId: string,
  migrations: MigrationFile[],
): Promise<D1Status> {
  if (migrations.length === 0) {
    return { provisioned: false, status: 'skipped', migrations_applied: 0, migrations_skipped: 0, migration_errors: [] };
  }

  try {
    const provision = await provisionD1ForApp(appId);

    if (provision.status !== 'ready' || !provision.databaseId) {
      return {
        provisioned: false,
        status: 'failed',
        migrations_applied: 0,
        migrations_skipped: 0,
        migration_errors: [],
        error: provision.error || 'D1 provisioning failed',
      };
    }

    const migrationResult = await runMigrations(provision.databaseId, migrations);

    if (migrationResult.errors.length > 0) {
      console.error(`[D1-MIGRATIONS] Errors for app ${appId}:`, migrationResult.errors);
      return {
        provisioned: true,
        status: 'failed',
        database_id: provision.databaseId,
        migrations_applied: migrationResult.applied,
        migrations_skipped: migrationResult.skipped,
        migration_errors: migrationResult.errors,
        error: migrationResult.errors.join('; '),
      };
    }

    await updateMigrationVersion(appId, migrationResult.lastVersion);
    console.log(`[D1-MIGRATIONS] App ${appId}: ${migrationResult.applied} applied, ${migrationResult.skipped} skipped`);

    return {
      provisioned: true,
      status: 'ready',
      database_id: provision.databaseId,
      migrations_applied: migrationResult.applied,
      migrations_skipped: migrationResult.skipped,
      migration_errors: [],
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[D1-MIGRATIONS] Error for app ${appId}:`, errMsg);
    return {
      provisioned: false,
      status: 'failed',
      migrations_applied: 0,
      migrations_skipped: 0,
      migration_errors: [errMsg],
      error: errMsg,
    };
  }
}

// ============================================
// MAIN PIPELINE
// ============================================

/**
 * Process uploaded files through all validation, bundling, and preparation stages.
 *
 * Returns everything needed to:
 * 1. Upload files to R2
 * 2. Create/update the app record
 * 3. Provision D1 (via provisionAndMigrate, called separately)
 *
 * Does NOT handle: auth, rate limiting, quota checks, R2 upload, DB writes,
 * skills generation, or any post-upload side effects. Callers are responsible
 * for those, using the pipeline result.
 */
export async function processUploadPipeline(
  files: PipelineFile[],
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const buildLogs: BuildLogEntry[] = [];
  const log = (level: BuildLogEntry['level'], message: string) => {
    buildLogs.push({ time: new Date().toISOString(), level, message });
  };

  log('info', `Processing ${files.length} files...`);

  // Stage 1: Runtime detection
  const { runtime, gpuConfig } = detectRuntime(files);

  if (runtime === 'gpu') {
    // GPU apps: minimal processing — validate main.py, extract exports
    const hasMainPy = files.some(f => (f.name.split('/').pop() || f.name) === 'main.py');
    if (!hasMainPy) throw new Error('GPU functions require a main.py file');

    let gpuExports: string[] = ['main'];
    const testFixture = files.find(f => (f.name.split('/').pop() || f.name) === 'test_fixture.json');
    if (testFixture) {
      try {
        const fixture = JSON.parse(testFixture.content);
        if (typeof fixture === 'object' && fixture !== null) gpuExports = Object.keys(fixture);
      } catch { /* non-fatal */ }
    }

    const mainPy = files.find(f => (f.name.split('/').pop() || f.name) === 'main.py')!;
    const manifest = generateGpuManifest({
      name: options.name || 'Untitled GPU App',
      version: options.version || '1.0.0',
      description: options.description || null,
      exports: gpuExports,
    });
    const filesToUpload = upsertManifestUploadFile(files.map(f => ({
      name: f.name,
      content: new TextEncoder().encode(f.content),
      contentType: f.name.endsWith('.py') ? 'text/x-python' : 'text/plain',
    })), manifest, (manifestJson) => ({
      name: 'manifest.json',
      content: new TextEncoder().encode(manifestJson),
      contentType: 'application/json',
    }));

    // D1 migrations not supported for GPU apps
    if (files.some(f => f.name.includes('migrations/') && f.name.endsWith('.sql'))) {
      log('warn', 'D1 migrations detected in GPU app — D1 is not supported for GPU runtime');
    }

    return {
      runtime: 'gpu',
      gpuConfig,
      manifest,
      entryFile: mainPy,
      exports: gpuExports,
      bundledCode: mainPy.content,
      bundleUsed: false,
      safetyPassed: true,
      safetyWarnings: 0,
      migrations: [],
      hasMigrations: false,
      filesToUpload,
      normalizedEntryName: 'main.py',
      buildLogs,
    };
  }

  // Stage 2: Manifest parsing
  let manifest = parseManifest(files, options);
  if (manifest) log('info', `Manifest: ${manifest.name} (type: ${manifest.type})`);

  // Stage 3: Entry file detection
  const { entryFile } = detectEntryFile(files, manifest);
  const normalizedEntryName = normalizeFileName(files, entryFile.name);
  log('info', `Entry: ${entryFile.name} → ${normalizedEntryName}`);

  const hydratedManifest = await hydrateManifestForSource({
    app: {
      name: manifest?.name || options.name || 'Untitled App',
      slug: options.name || 'uploaded-app',
      description: options.description || manifest?.description || null,
    },
    existingManifest: manifest,
    sourceCode: entryFile.content,
    filename: normalizedEntryName,
    version: manifest?.version || options.version || '1.0.0',
  });
  manifest = hydratedManifest.manifest;
  if (hydratedManifest.source !== 'uploaded') {
    const manifestMessage = hydratedManifest.source === 'merged'
      ? 'Normalized manifest-backed contracts from uploaded manifest and source code'
      : 'Generated manifest-backed contracts from source code';
    log('info', manifestMessage);
  }
  for (const parseError of hydratedManifest.parseResult.parseErrors) {
    log('warn', `[Manifest] ${parseError}`);
  }
  for (const parseWarning of hydratedManifest.parseResult.parseWarnings) {
    log('warn', `[Manifest] ${parseWarning}`);
  }

  // Stage 4: Export extraction
  const exports = extractExportsFromManifestOrCode(manifest, entryFile.content);
  log('success', `Exports: ${exports.length} (${exports.slice(0, 5).join(', ')}${exports.length > 5 ? '...' : ''})`);

  // Stage 5: Code bundling
  const { bundledCode, esmBundledCode, bundleUsed } = await bundleEntryFile(
    files, entryFile.name, entryFile.content, log,
  );

  // Stage 6: Safety scan
  const { passed: safetyPassed, warnings: safetyWarnings } = await runSafetyScanStage(files, log);

  // Stage 7: D1 migration extraction + validation
  const migrations = extractMigrations(files, log);

  // Stage 8: File preparation
  const filesToUpload = prepareFilesForUpload(
    files, entryFile, bundledCode, esmBundledCode, bundleUsed, normalizedEntryName, manifest,
  );

  log('success', 'Pipeline complete');

  return {
    runtime: 'deno',
    manifest,
    entryFile,
    exports,
    bundledCode,
    esmBundledCode,
    bundleUsed,
    safetyPassed,
    safetyWarnings,
    migrations,
    hasMigrations: migrations.length > 0,
    filesToUpload,
    normalizedEntryName,
    buildLogs,
  };
}
