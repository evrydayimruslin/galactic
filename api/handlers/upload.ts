// Upload Handler
// Processes file uploads, validates, bundles, stores to R2, creates app record
// Supports both new app creation and draft uploads for existing apps

import { error, json } from './response.ts';
import type { AppManifest } from '../../shared/contracts/manifest.ts';
import {
  resolveManifestEnvSchema,
  validateManifest,
} from '../../shared/contracts/manifest.ts';
import type { BuildLogEntry, UploadResponse } from '../../shared/types/index.ts';
import {
  ALLOWED_EXTENSIONS,
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_SIZE_BYTES,
} from '../../shared/types/index.ts';
import { createR2Service, type FileUpload } from '../services/storage.ts';
import { createAppsService } from '../services/apps.ts';
import { bundleCode, quickBundle } from '../services/bundler.ts';
import { authenticate } from './auth.ts';
import {
  checkVisibilityAllowed,
  checkPublishDeposit,
  checkAppLimit,
  getUserTier,
} from '../services/tier-enforcement.ts';
import {
  generateSkillsForVersion,
  rebuildUserLibrary,
} from '../services/library.ts';
import { checkStorageQuota, recordUploadStorage, formatBytes } from '../services/storage-quota.ts';
import { detectGpuConfig, parseGpuConfig } from '../services/gpu/config.ts';
import type { GpuConfig } from '../services/gpu/types.ts';
import { assertGpuBuildPreflight } from '../services/gpu/builder.ts';
import {
  parseMigrationFiles,
  validateMigrationSchema,
  runMigrations,
  updateMigrationVersion,
  type MigrationFile,
} from '../services/d1-migrations.ts';
import { provisionD1ForApp, getD1DatabaseId } from '../services/d1-provisioning.ts';
import {
  validateProgrammaticUploadOptions,
  validateUploadFormMetadata,
} from '../services/platform-request-validation.ts';
import { withSensitiveRouteRateLimit } from '../services/sensitive-route-rate-limit.ts';
import {
  hydrateManifestForSource,
  upsertManifestUploadFile,
} from '../services/app-manifest-generation.ts';
import {
  buildVersionMetadataEntry,
  buildVersionTrustMetadata,
} from '../services/trust.ts';
import { createServerLogger } from '../services/logging.ts';

// Export file type for programmatic uploads
export interface UploadFile {
  name: string;
  content: string;
  size: number;
}

// Draft upload response type
interface DraftUploadResponse {
  app_id: string;
  draft_version: string;
  draft_storage_key: string;
  exports: string[];
  build_success: boolean;
  build_logs: BuildLogEntry[];
  message: string;
}

const uploadLogger = createServerLogger('UPLOAD');
const integrityLogger = createServerLogger('INTEGRITY');
const gpuBuildLogger = createServerLogger('GPU-BUILD');
const skillsLogger = createServerLogger('SKILLS');

function createHttpError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function parseUploadedManifest(
  files: Array<{ name: string; content: string }>,
): AppManifest | null {
  const manifestFile = files.find((file) => {
    const fileName = file.name.split('/').pop() || file.name;
    return fileName === 'manifest.json';
  });

  if (!manifestFile) {
    return null;
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestFile.content);
  } catch (err) {
    throw createHttpError(
      `Failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }

  const validation = validateManifest(manifestJson);
  if (!validation.valid) {
    throw createHttpError(
      `Invalid manifest.json: ${validation.errors.map((entry) => `${entry.path}: ${entry.message}`).join(', ')}`,
      400,
    );
  }

  return validation.manifest || null;
}

function assertUploadQuota(quotaCheck: {
  allowed: boolean;
  used_bytes: number;
  limit_bytes: number;
  remaining_bytes: number;
  reason?: 'quota_exceeded' | 'service_unavailable';
}, totalUploadBytes: number): void {
  if (quotaCheck.allowed) {
    return;
  }

  if (quotaCheck.reason === 'service_unavailable') {
    throw createHttpError('Storage usage service unavailable. Please try again shortly.', 503);
  }

  throw createHttpError(
    `Storage soft-cap check failed. Using ${formatBytes(quotaCheck.used_bytes)} of ${formatBytes(quotaCheck.limit_bytes)}. ` +
      `This upload requires ${formatBytes(totalUploadBytes)}.`,
    413,
  );
}

export async function handleUpload(request: Request): Promise<Response> {
  try {
    uploadLogger.info('Upload request received', {
      method: request.method,
      content_type: request.headers.get('content-type') || '',
      content_length: request.headers.get('content-length') || '',
      header_names: Array.from(request.headers.keys()),
    });

    // Authenticate user - required for upload
    let userId: string;
    try {
      const user = await authenticate(request);
      userId = user.id;
      uploadLogger.info('Upload request authenticated', { user_id: userId });
    } catch (authErr: unknown) {
      uploadLogger.warn('Upload authentication failed', { error: authErr });
      return error('Authentication required. Please sign in to upload.', 401);
    }
    // Note: FK constraint on apps.owner_id has been removed, so no user record needed

    return await withSensitiveRouteRateLimit(userId, 'upload:create', async () => {
    // Parse multipart form data
    const formData = await request.formData();
    const files: File[] = [];
    let rawProvidedName: string | undefined;
    let rawProvidedDescription: string | undefined;
    let rawProvidedAppType: string | undefined;
    let rawProvidedFunctionsEntry: string | undefined;

    for (const [name, value] of formData.entries()) {
      if (value instanceof File) {
        files.push(value);
      } else if (name === 'name' && typeof value === 'string') {
        rawProvidedName = value;
      } else if (name === 'description' && typeof value === 'string') {
        rawProvidedDescription = value;
      } else if (name === 'app_type' && typeof value === 'string') {
        rawProvidedAppType = value;
      } else if (name === 'functions_entry' && typeof value === 'string') {
        rawProvidedFunctionsEntry = value;
      }
    }

    const {
      name: providedName,
      description: providedDescription,
      appType: providedAppType,
      functionsEntry: providedFunctionsEntry,
    } = validateUploadFormMetadata({
      name: rawProvidedName,
      description: rawProvidedDescription,
      app_type: rawProvidedAppType,
      functions_entry: rawProvidedFunctionsEntry,
    });

    // Validate file count
    if (files.length === 0) {
      return error('No files uploaded');
    }
    if (files.length > MAX_FILES_PER_UPLOAD) {
      return error(`Maximum ${MAX_FILES_PER_UPLOAD} files allowed`);
    }

    // Validate file types and size
    let totalSize = 0;
    const validatedFiles: Array<{ name: string; content: string }> = [];

    for (const file of files) {
      // Check extension
      const hasValidExt = ALLOWED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
      if (!hasValidExt) {
        return error(`File type not allowed: ${file.name}`);
      }

      // Check size
      totalSize += file.size;
      if (totalSize > MAX_UPLOAD_SIZE_BYTES) {
        return error(`Total upload size exceeds ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB limit`);
      }

      // Read content
      const content = await file.text();
      validatedFiles.push({ name: file.name, content });
    }

    // Build logs — declared early so migration validation can log too
    const buildLogs: BuildLogEntry[] = [];
    const log = (level: BuildLogEntry['level'], message: string) => {
      buildLogs.push({ time: new Date().toISOString(), level, message });
    };

    // Check for manifest.json (v2 architecture)
    const manifestFile = validatedFiles.find((f) => {
      const fileName = f.name.split('/').pop() || f.name;
      return fileName === 'manifest.json';
    });

    let manifest: AppManifest | null = null;
    if (manifestFile) {
      try {
        const manifestJson = JSON.parse(manifestFile.content);
        const validation = validateManifest(manifestJson);
        if (!validation.valid) {
          return error(`Invalid manifest.json: ${validation.errors.map(e => `${e.path}: ${e.message}`).join(', ')}`, 400);
        }
        manifest = validation.manifest!;
        uploadLogger.info('Upload manifest detected', {
          manifest_name: manifest.name,
          manifest_type: manifest.type,
        });
      } catch (parseErr) {
        return error(`Failed to parse manifest.json: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`, 400);
      }
    }

    // D1 migrations — extract and validate migrations/ folder
    const migrationFileMap: Record<string, string> = {};
    let parsedMigrations: MigrationFile[] = [];

    for (const file of validatedFiles) {
      // Match files like "migrations/001_initial.sql" (with or without leading path)
      const pathParts = file.name.split('/');
      const migrationsIdx = pathParts.indexOf('migrations');
      if (migrationsIdx !== -1 && pathParts.length > migrationsIdx + 1) {
        const migrationFilename = pathParts.slice(migrationsIdx + 1).join('/');
        if (migrationFilename.endsWith('.sql')) {
          migrationFileMap[migrationFilename] = file.content;
        }
      }
    }

    if (Object.keys(migrationFileMap).length > 0) {
      try {
        parsedMigrations = parseMigrationFiles(migrationFileMap);
      } catch (parseErr) {
        return error(
          `Invalid migration files: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          400,
        );
      }

      // Validate each migration for Ultralight conventions (user_id, no DROP, etc.)
      for (const migration of parsedMigrations) {
        const validation = validateMigrationSchema(migration.sql);
        if (!validation.valid) {
          return error(
            `Migration ${migration.filename} validation failed: ${validation.errors.join('; ')}`,
            400,
          );
        }
        if (validation.warnings.length > 0) {
          for (const warning of validation.warnings) {
            buildLogs.push({ time: new Date().toISOString(), level: 'warn', message: `[Migration] ${warning}` });
          }
        }
      }

      buildLogs.push({
        time: new Date().toISOString(),
        level: 'info',
        message: `Found ${parsedMigrations.length} migration(s): ${parsedMigrations.map(m => m.filename).join(', ')}`,
      });
    }

    // GPU runtime detection — check for ultralight.gpu.yaml
    const gpuYamlContent = detectGpuConfig(validatedFiles);
    let gpuConfig: GpuConfig | null = null;

    if (gpuYamlContent) {
      const gpuValidation = parseGpuConfig(gpuYamlContent);
      if (!gpuValidation.valid) {
        return error(
          `Invalid ultralight.gpu.yaml: ${gpuValidation.errors.join(', ')}`,
          400,
        );
      }
      gpuConfig = gpuValidation.config!;
      uploadLogger.info('GPU upload config detected', {
        gpu_type: gpuConfig.gpu_type,
        python: gpuConfig.python || '3.11',
      });
    }

    // --- GPU UPLOAD BRANCH ---
    // If ultralight.gpu.yaml is present, handle as GPU function.
    // Skips JS bundling and safety scan. Returns early.
    if (gpuConfig) {
      // Require main.py as entry point
      const mainPy = validatedFiles.find((f) => {
        const fileName = f.name.split('/').pop() || f.name;
        return fileName === 'main.py';
      });
      if (!mainPy) {
        return error('GPU functions require a main.py file', 400);
      }

      // Extract function names from test_fixture.json if available
      const testFixtureFile = validatedFiles.find((f) => {
        const fileName = f.name.split('/').pop() || f.name;
        return fileName === 'test_fixture.json';
      });
      let gpuExports: string[] = ['main'];
      if (testFixtureFile) {
        try {
          const fixture = JSON.parse(testFixtureFile.content);
          if (typeof fixture === 'object' && fixture !== null) {
            gpuExports = Object.keys(fixture);
          }
        } catch {
          // Invalid test fixture JSON is non-fatal — use default
        }
      }

      // Build logs
      const buildLogs: BuildLogEntry[] = [];
      const log = (level: BuildLogEntry['level'], message: string) => {
        buildLogs.push({ time: new Date().toISOString(), level, message });
      };

      log('info', `GPU function detected: ${gpuConfig.gpu_type}`);
      log('info', `Python version: ${gpuConfig.python || '3.11'}`);
      log('info', `Files: ${validatedFiles.length}`);

      // Generate app ID and version
      const appId = crypto.randomUUID();
      const version = '1.0.0';
      const slug = generateSlug(validatedFiles.find((f) => f.name === 'package.json')?.content);
      const appName = providedName || slug;
      const appDescription = providedDescription || null;

      // Initialize services
      const r2Service = createR2Service();
      const appsService = createAppsService();

      // Normalize file names (reuse existing logic)
      const normalizeFileName = (name: string): string => {
        const parts = name.split('/');
        if (parts.length > 1) {
          const firstPart = validatedFiles[0]?.name.split('/')[0];
          const allSameRoot = validatedFiles.every(f => f.name.startsWith(firstPart + '/'));
          if (allSameRoot && parts[0] === firstPart) {
            return parts.slice(1).join('/');
          }
        }
        return name;
      };

      // Prepare files for upload (raw, no bundling)
      const filesToUpload = validatedFiles.map(f => ({
        name: normalizeFileName(f.name),
        content: new TextEncoder().encode(f.content),
        contentType: getContentType(f.name),
      }));

      // Check app count limit
      const appLimitErr = await checkAppLimit(userId);
      if (appLimitErr) {
        throw new Error(appLimitErr);
      }

      // Read storage soft-cap status before upload; product storage caps do not block.
      const totalUploadBytes = filesToUpload.reduce((sum, f) => sum + f.content.byteLength, 0);
      const quotaCheck = await checkStorageQuota(userId, totalUploadBytes, {
        mode: 'fail_closed',
        resource: 'GPU app upload',
      });
      assertUploadQuota(quotaCheck, totalUploadBytes);

      try {
        assertGpuBuildPreflight(appId, version);
      } catch (err) {
        throw createHttpError(
          err instanceof Error ? err.message : 'GPU build preflight failed',
          typeof err === 'object' && err !== null && 'status' in err
            ? Number((err as { status?: number }).status) || 503
            : 503,
        );
      }

      // Upload raw files to R2 (no bundling for GPU functions)
      log('info', 'Uploading GPU function files to storage...');
      const storageKey = `apps/${appId}/${version}/`;
      await r2Service.uploadFiles(storageKey, filesToUpload);
      log('success', 'Upload complete');

      // Create app record with GPU fields
      const versionTrust = await buildVersionTrustMetadata({
        appId,
        version,
        runtime: 'gpu',
        manifest,
        files: filesToUpload,
        storageKey,
      });
      log('info', 'Creating app record...');
      await appsService.create({
        id: appId,
        owner_id: userId,
        slug,
        name: appName,
        description: appDescription,
        storage_key: storageKey,
        exports: gpuExports,
        manifest: manifest ? JSON.stringify(manifest) : null,
        env_schema: manifest ? resolveManifestEnvSchema(manifest) : {},
        app_type: null,
        // GPU-specific fields
        runtime: 'gpu',
        gpu_type: gpuConfig.gpu_type,
        gpu_status: 'building',
        gpu_config: gpuConfig as unknown as Record<string, unknown>,
        gpu_max_duration_ms: gpuConfig.max_duration_ms || null,
        gpu_concurrency_limit: 5,
        version_metadata: [
          buildVersionMetadataEntry(version, totalUploadBytes, versionTrust),
        ],
      });
      log('success', 'App record created with gpu_status: building');
      await recordUploadStorage(userId, appId, version, totalUploadBytes);

      // Fire-and-forget: trigger async container build
      import('../services/gpu/builder.ts').then(({ triggerGpuBuild }) => {
        triggerGpuBuild(appId, version, validatedFiles.map(f => ({
          name: normalizeFileName(f.name),
          content: f.content,
        })), gpuConfig!).catch(err =>
          gpuBuildLogger.error('GPU build trigger failed', { app_id: appId, version, error: err })
        );
      }).catch(err => gpuBuildLogger.error('GPU builder import failed', { app_id: appId, error: err }));

      log('success', 'GPU build triggered in background');

      const response: UploadResponse = {
        app_id: appId,
        slug,
        version,
        url: `/a/${appId}`,
        exports: gpuExports,
        build_success: true,
        build_logs: buildLogs,
      };

      return json(response, 201);
    }
    // --- END GPU UPLOAD BRANCH ---

    // Override manifest with form fields if provided (form fields take precedence)
    // This allows users to specify entry points without creating a manifest.json
    if (providedAppType === 'mcp' || providedFunctionsEntry) {
      const formManifest: AppManifest = manifest ? { ...manifest } : {
        name: providedName || 'Untitled App',
        version: '1.0.0',
        type: 'mcp',
        entry: {},
      };

      // Override with form field values
      if (providedFunctionsEntry) {
        formManifest.entry.functions = providedFunctionsEntry;
      }
      if (providedName) {
        formManifest.name = providedName;
      }
      if (providedDescription) {
        formManifest.description = providedDescription;
      }

      manifest = formManifest;
      uploadLogger.info('Applied form-provided manifest override', {
        manifest_type: manifest.type,
        entry: manifest.entry,
      });
    }

    // Determine entry file based on manifest, form fields, or fallback to auto-detection
    let entryFile: { name: string; content: string } | undefined;
    let functionsFile: { name: string; content: string } | undefined;

    if (manifest && manifest.entry.functions) {
      // Use manifest-specified entry points
      functionsFile = validatedFiles.find((f) => {
        const fileName = f.name.split('/').pop() || f.name;
        return fileName === manifest!.entry.functions;
      });
      if (!functionsFile) {
        return error(`Functions entry file not found: ${manifest.entry.functions}`);
      }
      entryFile = functionsFile;
    }

    // Auto-detect entry file if not resolved from manifest
    if (!entryFile) {
      const entryFileNames = ['index.tsx', 'index.ts', 'index.jsx', 'index.js'];
      entryFile = validatedFiles.find((f) => {
        const fileName = f.name.split('/').pop() || f.name;
        return entryFileNames.includes(fileName);
      });
    }

    if (!entryFile) {
      uploadLogger.warn('Upload rejected because no entry file was found', {
        file_names: validatedFiles.map((f) => f.name),
      });
      return error('Entry file required. Either provide manifest.json or include index.ts/index.tsx');
    }
    uploadLogger.info('Resolved upload entry file', { entry_file: entryFile.name });

    const normalizeFileName = (name: string): string => {
      const parts = name.split('/');
      if (parts.length > 1) {
        const firstPart = validatedFiles[0]?.name.split('/')[0];
        const allSameRoot = validatedFiles.every(f => f.name.startsWith(firstPart + '/'));
        if (allSameRoot && parts[0] === firstPart) {
          return parts.slice(1).join('/');
        }
      }
      return name;
    };

    const normalizedEntryName = normalizeFileName(entryFile.name);
    const manifestHydration = await hydrateManifestForSource({
      app: {
        name: manifest?.name || providedName || 'Untitled App',
        slug: providedName || 'uploaded-app',
        description: providedDescription || manifest?.description || null,
      },
      existingManifest: manifest,
      sourceCode: entryFile.content,
      filename: normalizedEntryName,
      version: manifest?.version || '1.0.0',
    });
    manifest = manifestHydration.manifest;

    log('info', `Starting build for ${validatedFiles.length} files...`);

    if (manifest) {
      log('info', `Using manifest.json (type: ${manifest.type})`);
    }
    if (manifestHydration.source !== 'uploaded') {
      log(
        'info',
        manifestHydration.source === 'merged'
          ? 'Normalized manifest-backed contracts from uploaded manifest and source code'
          : 'Generated manifest-backed contracts from source code',
      );
    }
    for (const parseError of manifestHydration.parseResult.parseErrors) {
      log('warn', `[Manifest] ${parseError}`);
    }
    for (const parseWarning of manifestHydration.parseResult.parseWarnings) {
      log('warn', `[Manifest] ${parseWarning}`);
    }

    // Extract exports - prefer manifest declarations over code parsing
    log('info', 'Determining exports...');
    const exports = manifest?.functions ? Object.keys(manifest.functions) : [];
    log('success', `Found ${exports.length} functions from manifest: ${exports.join(', ')}`);

    // ── Skill upload path — simplified, no bundling/manifest/D1 ──
    if (providedAppType === 'skill') {
      const appId = crypto.randomUUID();
      const version = '1.0.0';
      const slug = generateSlug();
      const appName = providedName || validatedFiles[0]?.name.replace(/\.\w+$/, '') || slug;
      // Summary: first 200 chars of the primary .md file content
      const mdFile = validatedFiles.find(f => f.name.endsWith('.md')) || validatedFiles[0];
      const mdContent = mdFile?.content || '';
      const summary = providedDescription || mdContent.replace(/^#[^\n]*\n/, '').trim().slice(0, 200);

      const r2Service = createR2Service();
      const appsService = createAppsService();

      // Store files in R2
      const storageKey = `apps/${appId}/${version}/`;
      const filesToUpload: FileUpload[] = validatedFiles.map(f => ({
        name: f.name,
        content: new TextEncoder().encode(f.content),
        contentType: getContentType(f.name),
      }));
      const totalUploadBytes = filesToUpload.reduce((sum, f) => sum + f.content.byteLength, 0);
      const quotaCheck = await checkStorageQuota(userId, totalUploadBytes, {
        mode: 'fail_closed',
        resource: 'skill upload',
      });
      assertUploadQuota(quotaCheck, totalUploadBytes);
      await r2Service.uploadFiles(storageKey, filesToUpload);
      log('success', 'Skill files uploaded to R2');

      // Create app record
      const versionTrust = await buildVersionTrustMetadata({
        appId,
        version,
        runtime: 'skill',
        manifest: null,
        files: filesToUpload,
        storageKey,
      });
      await appsService.create({
        id: appId,
        owner_id: userId,
        slug,
        name: appName,
        description: summary,
        storage_key: storageKey,
        exports: [],
        manifest: null,
        app_type: 'skill',
        version_metadata: [
          buildVersionMetadataEntry(version, totalUploadBytes, versionTrust),
        ],
      });
      log('success', `Skill app created: ${appName}`);
      await recordUploadStorage(userId, appId, version, totalUploadBytes);

      // Rebuild function index to include the new skill
      import('../services/function-index.ts').then(m => m.rebuildFunctionIndex(userId))
        .catch(err => uploadLogger.error('Function index rebuild failed after skill upload', {
          user_id: userId,
          error: err,
        }));

      return json({
        id: appId,
        slug,
        name: appName,
        description: summary,
        version,
        app_type: 'skill',
        logs: buildLogs,
      });
    }

    // Bundle the code
    // IMPORTANT: We must bundle ALL imports (relative and external) into a single file
    // because data URL imports cannot resolve relative paths
    log('info', 'Bundling code...');
    let bundledCode = entryFile.content;  // IIFE format for MCP sandbox
    let esmBundledCode: string | undefined;  // ESM format for browser UI
    let bundleUsed = false;

    try {
      // Always use esbuild for proper bundling - it handles all import types correctly
      log('info', 'Running esbuild bundler...');
      const bundleResult = await bundleCode(validatedFiles, entryFile.name);

      if (!bundleResult.success) {
        for (const err of bundleResult.errors) {
          log('error', err);
        }
        return error('Build failed: ' + bundleResult.errors.join(', '), 400);
      }

      for (const warn of bundleResult.warnings) {
        log('warn', warn);
      }

      // Only use bundled code if bundling actually changed something
      if (bundleResult.code !== entryFile.content) {
        bundledCode = bundleResult.code;
        esmBundledCode = bundleResult.esmCode;
        bundleUsed = true;
        log('success', 'Bundle complete (IIFE + ESM)');
      } else {
        log('success', 'No bundling needed (no imports)');
      }
    } catch (bundleErr) {
      // Bundling failed - try to continue with original code
      log('warn', `Bundling skipped: ${bundleErr instanceof Error ? bundleErr.message : String(bundleErr)}`);
      bundledCode = entryFile.content;
    }

    // Layer 1: Safety scan (before R2 upload)
    log('info', 'Running safety scan...');
    const { runSafetyScan } = await import('../services/integrity.ts');
    const safetyResult = runSafetyScan(validatedFiles);
    if (!safetyResult.passed) {
      const errorSummary = safetyResult.issues
        .filter(i => i.severity === 'error')
        .map(i => `[${i.rule}] ${i.message}`)
        .join('; ');
      log('error', `Safety scan blocked upload: ${errorSummary}`);
      return error(`Upload blocked by safety scan: ${errorSummary}`, 422);
    }
    if (safetyResult.summary.warnings > 0) {
      for (const warn of safetyResult.issues.filter(i => i.severity === 'warning')) {
        log('warn', `[${warn.rule}] ${warn.message}`);
      }
    }
    log('success', `Safety scan passed (${safetyResult.summary.warnings} warnings)`);

    // Generate app ID and version
    const appId = crypto.randomUUID();
    const version = manifest?.version || '1.0.0';
    // Use manifest name, provided name, or generate slug
    const slug = generateSlug(validatedFiles.find((f) => f.name === 'package.json')?.content);
    const appName = manifest?.name || providedName || slug;
    // Form field description takes precedence over manifest
    const appDescription = providedDescription || manifest?.description || null;
    const appType = manifest?.type || null; // null means legacy auto-detect

    // Initialize services
    const r2Service = createR2Service();
    const appsService = createAppsService();

    log('info', `Entry file normalized: ${entryFile.name} -> ${normalizedEntryName}`);

    // Prepare files for upload
    // We store multiple versions:
    // - index.tsx (IIFE bundle) - for MCP sandbox execution
    // - index.esm.js (ESM bundle) - for browser UI rendering
    // - _source_index.tsx - original source for generate-docs
    const filesToUpload = upsertManifestUploadFile(
      bundleUsed
      ? [
          // Upload IIFE bundled code as the entry file (for MCP sandbox)
          {
            name: normalizedEntryName,
            content: new TextEncoder().encode(bundledCode),
            contentType: getContentType(normalizedEntryName),
          },
          // Upload ESM bundled code for browser UI rendering
          ...(esmBundledCode ? [{
            name: normalizedEntryName.replace(/\.(tsx?|jsx?)$/, '.esm.js'),
            content: new TextEncoder().encode(esmBundledCode),
            contentType: 'application/javascript',
          }] : []),
          // Upload original entry file with _source_ prefix for generate-docs parsing
          // This preserves the original TypeScript code with export statements
          {
            name: `_source_${normalizedEntryName}`,
            content: new TextEncoder().encode(entryFile.content),
            contentType: getContentType(normalizedEntryName),
          },
          // Also upload original files for reference/debugging
          ...validatedFiles
            .filter(f => f.name !== entryFile.name)
            .map(f => ({
              name: normalizeFileName(f.name),
              content: new TextEncoder().encode(f.content),
              contentType: getContentType(f.name),
            })),
        ]
      : validatedFiles.map(f => ({
          name: normalizeFileName(f.name),
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

    // Check app count limit (10 apps max)
    const appLimitErr = await checkAppLimit(userId);
    if (appLimitErr) {
      throw new Error(appLimitErr);
    }

    // Read storage soft-cap status before uploading; request-size limits still apply.
    const totalUploadBytes = filesToUpload.reduce((sum, f) => sum + f.content.byteLength, 0);
    const quotaCheck = await checkStorageQuota(userId, totalUploadBytes, {
      mode: 'fail_closed',
      resource: 'app upload',
    });
    assertUploadQuota(quotaCheck, totalUploadBytes);

    // Upload files to R2
    log('info', 'Uploading to storage...');
    const storageKey = `apps/${appId}/${version}/`;
    await r2Service.uploadFiles(storageKey, filesToUpload);
    log('success', 'Upload complete');

    // Store ESM bundle in KV for Dynamic Worker loading (in-process MCP calls)
    if (esmBundledCode && globalThis.__env?.CODE_CACHE) {
      try {
        await globalThis.__env.CODE_CACHE.put(`esm:${appId}:${version}`, esmBundledCode);
        await globalThis.__env.CODE_CACHE.put(`esm:${appId}:latest`, esmBundledCode);
        log('info', 'ESM bundle cached in KV for Dynamic Workers');
      } catch (kvErr) {
        log('warn', `KV cache failed (non-fatal): ${kvErr instanceof Error ? kvErr.message : String(kvErr)}`);
      }
    }

    // Create app record in database
    const versionTrust = await buildVersionTrustMetadata({
      appId,
      version,
      runtime: 'deno',
      manifest,
      files: filesToUpload,
      storageKey,
    });
    log('info', 'Creating app record...');
    await appsService.create({
      id: appId,
      owner_id: userId,
      slug,
      name: appName,
      description: appDescription,
      storage_key: storageKey,
      exports,
      // Store manifest data for later use
      manifest: manifest ? JSON.stringify(manifest) : null,
      env_schema: manifest ? resolveManifestEnvSchema(manifest) : {},
      app_type: appType,
      version_metadata: [
        buildVersionMetadataEntry(version, totalUploadBytes, versionTrust),
      ],
    });
    log('success', 'App record created');

    // Record live storage usage for billing.
    const totalSizeBytes = filesToUpload.reduce((sum, f) => sum + f.content.byteLength, 0);
    await recordUploadStorage(userId, appId, version, totalSizeBytes);

    // D1 provisioning — SYNCHRONOUS, eager (not fire-and-forget)
    if (parsedMigrations.length > 0) {
      const { provisionAndMigrate } = await import('../services/upload-pipeline.ts');
      const d1Result = await provisionAndMigrate(appId, parsedMigrations);
      if (d1Result.status === 'ready') {
        log('success', `D1: ${d1Result.migrations_applied} migration(s) applied, ${d1Result.migrations_skipped} skipped`);
      } else if (d1Result.error) {
        log('error', `D1 provisioning: ${d1Result.error}`);
      }
    }

    // Compute + store source fingerprint and safety status (fire-and-forget)
    import('../services/originality.ts').then(async ({ computeFingerprint, storeIntegrityResults }) => {
      const mdFiles = validatedFiles.filter(f => f.name.endsWith('.md'));
      const mdContent = mdFiles.map(f => f.content).join('\n');
      const fingerprint = await computeFingerprint(entryFile.content, mdContent);
      await storeIntegrityResults(appId, {
        source_fingerprint: fingerprint,
        safety_status: safetyResult.summary.warnings > 0 ? 'warned' : 'clean',
        integrity_checked_at: new Date().toISOString(),
      });
    }).catch(err => integrityLogger.error('Fingerprint storage failed after upload', {
      app_id: appId,
      error: err,
    }));

    // Auto-generate Skills.md (fire-and-forget, non-blocking)
    log('info', 'Generating Skills.md...');
    const appsForSkills = await appsService.findById(appId);
    if (appsForSkills) {
      generateSkillsForVersion(appsForSkills, storageKey, version)
        .then(skills => {
          if (skills.skillsMd) {
            skillsLogger.info('Generated Skills.md after upload', {
              app_id: appId,
              version,
            });
          }
        })
        .catch(err => skillsLogger.error('Skills generation failed after upload', {
          app_id: appId,
          version,
          error: err,
        }));
    }

    // Always rebuild library + function index after upload (independent of skills gen)
    // Run synchronously to ensure it completes before the Worker exits
    try {
      await rebuildUserLibrary(userId);
      uploadLogger.info('Rebuilt user library after upload', { user_id: userId, app_id: appId });
    } catch (err) {
      uploadLogger.error('Library rebuild failed after upload', {
        user_id: userId,
        app_id: appId,
        error: err,
      });
    }
    try {
      const { rebuildFunctionIndex } = await import('../services/function-index.ts');
      await rebuildFunctionIndex(userId);
      uploadLogger.info('Rebuilt function index after upload', { user_id: userId, app_id: appId });
    } catch (err) {
      uploadLogger.error('Function index rebuild failed after upload', {
        user_id: userId,
        app_id: appId,
        error: err,
      });
    }

    log('success', 'Build complete!');

    const response: UploadResponse = {
      app_id: appId,
      slug,
      version,
      url: `/a/${appId}`,
      exports,
      build_success: true,
      build_logs: buildLogs,
    };

    return json(response, 201);
    });
  } catch (err) {
    uploadLogger.error('Upload request failed', { error: err });
    const status = typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: number }).status) || 500
      : 500;
    return error(err instanceof Error ? err.message : 'Upload failed', status);
  }
}

/**
 * Extract export names from TypeScript/JavaScript code
 * Basic regex-based extraction for MVP
 */
function extractExports(code: string): string[] {
  const exports: string[] = [];

  // Match: export function name(...) or export async function name(...)
  const functionRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
  let match;
  while ((match = functionRegex.exec(code)) !== null) {
    exports.push(match[1]);
  }

  // Match: export const name = ... or export let name = ...
  const constRegex = /export\s+(?:const|let|var)\s+(\w+)\s*=/g;
  while ((match = constRegex.exec(code)) !== null) {
    exports.push(match[1]);
  }

  // Match: export { name1, name2 }
  const namedExportRegex = /export\s*\{([^}]+)\}/g;
  while ((match = namedExportRegex.exec(code)) !== null) {
    const names = match[1].split(',').map((s) => s.trim().split(' as ')[0].trim());
    exports.push(...names);
  }

  // Match: export default ...
  if (/export\s+default/.test(code)) {
    exports.push('default');
  }

  return [...new Set(exports)]; // Deduplicate
}

/**
 * Generate slug from package.json or fallback
 */
export function generateSlug(packageJson?: string): string {
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson);
      if (pkg.name) {
        return pkg.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      }
    } catch {
      // Ignore parse error
    }
  }

  // Fallback: random slug
  return `app-${Math.random().toString(36).slice(2, 8)}`;
}

function getContentType(filename: string): string {
  if (filename.endsWith('.tsx')) return 'text/typescript-jsx';
  if (filename.endsWith('.ts')) return 'text/typescript';
  if (filename.endsWith('.jsx')) return 'text/javascript-jsx';
  if (filename.endsWith('.js')) return 'application/javascript';
  if (filename.endsWith('.json')) return 'application/json';
  if (filename.endsWith('.md')) return 'text/markdown';
  if (filename.endsWith('.css')) return 'text/css';
  return 'text/plain';
}

/**
 * Handle draft upload for an existing app
 * POST /api/apps/:appId/draft
 *
 * This uploads new code as a draft without replacing the published version.
 * The draft can then be published via POST /api/apps/:appId/publish
 */
export async function handleDraftUpload(request: Request, appId: string): Promise<Response> {
  try {
    // Authenticate user
    let userId: string;
    try {
      const user = await authenticate(request);
      userId = user.id;
    } catch (authErr: unknown) {
      uploadLogger.warn('Draft upload authentication failed', { app_id: appId, error: authErr });
      return error('Authentication required', 401);
    }

    // Get the app and verify ownership
    const appsService = createAppsService();
    const app = await appsService.findById(appId);

    if (!app) {
      return error('App not found', 404);
    }

    if (app.owner_id !== userId) {
      return error('Unauthorized', 403);
    }

    return await withSensitiveRouteRateLimit(userId, 'upload:draft', async () => {
    // Check if there's already a draft - warn but allow overwrite
    const hasDraft = !!app.draft_storage_key;

    // Parse multipart form data
    const formData = await request.formData();
    const files: File[] = [];

    for (const [name, value] of formData.entries()) {
      if (value instanceof File) {
        files.push(value);
      }
    }

    // Validate file count
    if (files.length === 0) {
      return error('No files uploaded');
    }
    if (files.length > MAX_FILES_PER_UPLOAD) {
      return error(`Maximum ${MAX_FILES_PER_UPLOAD} files allowed`);
    }

    // Validate file types and size
    let totalSize = 0;
    const validatedFiles: Array<{ name: string; content: string }> = [];

    for (const file of files) {
      const hasValidExt = ALLOWED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
      if (!hasValidExt) {
        return error(`File type not allowed: ${file.name}`);
      }

      totalSize += file.size;
      if (totalSize > MAX_UPLOAD_SIZE_BYTES) {
        return error(`Total upload size exceeds ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB limit`);
      }

      const content = await file.text();
      validatedFiles.push({ name: file.name, content });
    }

    // Check for entry file
    const entryFileNames = ['index.tsx', 'index.ts', 'index.jsx', 'index.js'];
    const entryFile = validatedFiles.find((f) => {
      const fileName = f.name.split('/').pop() || f.name;
      return entryFileNames.includes(fileName);
    });
    if (!entryFile) {
      return error('Entry file (index.ts, index.tsx, index.js, or index.jsx) required');
    }

    const normalizeFileName = (name: string): string => {
      const parts = name.split('/');
      if (parts.length > 1) {
        const firstPart = validatedFiles[0]?.name.split('/')[0];
        const allSameRoot = validatedFiles.every(f => f.name.startsWith(firstPart + '/'));
        if (allSameRoot && parts[0] === firstPart) {
          return parts.slice(1).join('/');
        }
      }
      return name;
    };

    const normalizedEntryName = normalizeFileName(entryFile.name);
    const uploadedManifest = parseUploadedManifest(validatedFiles);
    const manifestHydration = await hydrateManifestForSource({
      app: {
        name: app.name || app.slug,
        slug: app.slug,
        description: app.description,
      },
      existingManifest: uploadedManifest,
      sourceCode: entryFile.content,
      filename: normalizedEntryName,
      version: app.current_version || '1.0.0',
    });

    // Build logs
    const buildLogs: BuildLogEntry[] = [];
    const log = (level: BuildLogEntry['level'], message: string) => {
      buildLogs.push({ time: new Date().toISOString(), level, message });
    };

    if (hasDraft) {
      log('warn', 'Overwriting existing draft');
    }

    log('info', `Starting draft build for ${validatedFiles.length} files...`);
    log(
      'info',
      manifestHydration.source === 'merged'
        ? 'Normalized manifest-backed contracts from uploaded manifest and source code'
        : 'Generated manifest-backed contracts from source code',
    );
    for (const parseError of manifestHydration.parseResult.parseErrors) {
      log('warn', `[Manifest] ${parseError}`);
    }
    for (const parseWarning of manifestHydration.parseResult.parseWarnings) {
      log('warn', `[Manifest] ${parseWarning}`);
    }

    // Extract exports
    log('info', 'Parsing entry file...');
    const exports = manifestHydration.manifest.functions
      ? Object.keys(manifestHydration.manifest.functions)
      : [];
    log('success', `Found ${exports.length} functions from manifest: ${exports.join(', ')}`);

    // Bundle the code
    log('info', 'Bundling code...');
    let bundledCode = entryFile.content;
    let esmBundledCode: string | undefined;
    let bundleUsed = false;

    try {
      log('info', 'Running esbuild bundler...');
      const bundleResult = await bundleCode(validatedFiles, entryFile.name);

      if (!bundleResult.success) {
        for (const err of bundleResult.errors) {
          log('error', err);
        }
        return error('Build failed: ' + bundleResult.errors.join(', '), 400);
      }

      for (const warn of bundleResult.warnings) {
        log('warn', warn);
      }

      if (bundleResult.code !== entryFile.content) {
        bundledCode = bundleResult.code;
        esmBundledCode = bundleResult.esmCode;
        bundleUsed = true;
        log('success', 'Bundle complete (IIFE + ESM)');
      } else {
        log('success', 'No bundling needed (no imports)');
      }
    } catch (bundleErr) {
      log('warn', `Bundling skipped: ${bundleErr instanceof Error ? bundleErr.message : String(bundleErr)}`);
      bundledCode = entryFile.content;
    }

    // Layer 1: Safety scan (before R2 upload)
    log('info', 'Running safety scan...');
    const { runSafetyScan: runDraftSafetyScan } = await import('../services/integrity.ts');
    const draftSafetyResult = runDraftSafetyScan(validatedFiles);
    if (!draftSafetyResult.passed) {
      const errorSummary = draftSafetyResult.issues
        .filter(i => i.severity === 'error')
        .map(i => `[${i.rule}] ${i.message}`)
        .join('; ');
      log('error', `Safety scan blocked draft upload: ${errorSummary}`);
      return error(`Upload blocked by safety scan: ${errorSummary}`, 422);
    }
    if (draftSafetyResult.summary.warnings > 0) {
      for (const warn of draftSafetyResult.issues.filter(i => i.severity === 'warning')) {
        log('warn', `[${warn.rule}] ${warn.message}`);
      }
    }
    log('success', `Safety scan passed (${draftSafetyResult.summary.warnings} warnings)`);

    // Generate draft version
    const draftVersion = `draft-${Date.now()}`;

    // Initialize R2 service
    const r2Service = createR2Service();

    // Prepare files for upload
    const filesToUpload = upsertManifestUploadFile(
      bundleUsed
      ? [
          {
            name: normalizedEntryName,
            content: new TextEncoder().encode(bundledCode),
            contentType: getContentType(normalizedEntryName),
          },
          // Upload ESM bundle for browser rendering
          ...(esmBundledCode ? [{
            name: normalizedEntryName.replace(/\.(tsx?|jsx?)$/, '.esm.js'),
            content: new TextEncoder().encode(esmBundledCode),
            contentType: 'application/javascript',
          }] : []),
          // Upload original entry file with _source_ prefix for generate-docs parsing
          {
            name: `_source_${normalizedEntryName}`,
            content: new TextEncoder().encode(entryFile.content),
            contentType: getContentType(normalizedEntryName),
          },
          ...validatedFiles
            .filter(f => f.name !== entryFile.name)
            .map(f => ({
              name: normalizeFileName(f.name),
              content: new TextEncoder().encode(f.content),
              contentType: getContentType(f.name),
            })),
        ]
      : validatedFiles.map(f => ({
          name: normalizeFileName(f.name),
          content: new TextEncoder().encode(f.content),
          contentType: getContentType(f.name),
        })),
      manifestHydration.manifest,
      (manifestJson) => ({
        name: 'manifest.json',
        content: new TextEncoder().encode(manifestJson),
        contentType: 'application/json',
      }),
    );

    // Upload to draft storage location
    log('info', 'Uploading draft to storage...');
    const draftStorageKey = `apps/${appId}/draft/`;
    await r2Service.uploadFiles(draftStorageKey, filesToUpload);
    log('success', 'Draft upload complete');

    // Update app record with draft info
    log('info', 'Updating app record...');
    await appsService.update(appId, {
      draft_storage_key: draftStorageKey,
      draft_version: draftVersion,
      draft_uploaded_at: new Date().toISOString(),
      draft_exports: exports,
    });
    log('success', 'Draft record updated');

    log('success', 'Draft build complete! Use POST /api/apps/:appId/publish to publish.');

    const response: DraftUploadResponse = {
      app_id: appId,
      draft_version: draftVersion,
      draft_storage_key: draftStorageKey,
      exports,
      build_success: true,
      build_logs: buildLogs,
      message: 'Draft uploaded successfully. Publish when ready to update the app and regenerate documentation.',
    };

    return json(response, 200);
    });
  } catch (err) {
    uploadLogger.error('Draft upload failed', { app_id: appId, error: err });
    const status = typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: number }).status) || 500
      : 500;
    return error(err instanceof Error ? err.message : 'Draft upload failed', status);
  }
}

// ============================================
// PROGRAMMATIC UPLOAD FUNCTIONS
// For use by Platform MCP and CLI
// ============================================

interface UploadOptions {
  name?: string;
  slug?: string;
  description?: string;
  visibility?: 'private' | 'unlisted' | 'public';
  // v2 architecture: explicit entry points and app type
  app_type?: 'mcp';
  functions_entry?: string;  // e.g., "functions.ts"
  gap_id?: string;  // Links upload to a platform gap for assessment
}

/**
 * Programmatic upload handler for Platform MCP
 * Creates a new app from file array.
 * Uses the shared upload pipeline for consistent processing across all upload paths.
 */
export async function handleUploadFiles(
  userId: string,
  files: UploadFile[],
  options: UploadOptions = {}
): Promise<UploadResponse & { docs_generated?: boolean; docs_error?: string }> {
  const validatedOptions = validateProgrammaticUploadOptions(options);

  // Validate file count
  if (files.length === 0) {
    throw new Error('No files provided');
  }
  if (files.length > MAX_FILES_PER_UPLOAD) {
    throw new Error(`Maximum ${MAX_FILES_PER_UPLOAD} files allowed`);
  }

  // Validate file types and size
  let totalSize = 0;
  const validatedFiles: Array<{ name: string; content: string }> = [];

  for (const file of files) {
    const hasValidExt = ALLOWED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!hasValidExt) {
      throw new Error(`File type not allowed: ${file.name}`);
    }

    totalSize += file.size;
    if (totalSize > MAX_UPLOAD_SIZE_BYTES) {
      throw new Error(`Total upload size exceeds ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB limit`);
    }

    validatedFiles.push({ name: file.name, content: file.content });
  }

  // ── Run shared pipeline (manifest, entry, exports, bundle, safety, migrations) ──
  const { processUploadPipeline, provisionAndMigrate } = await import('../services/upload-pipeline.ts');
  const pipeline = await processUploadPipeline(validatedFiles, {
    appType: validatedOptions.app_type,
    functionsEntry: validatedOptions.functions_entry,
    name: validatedOptions.name,
    description: validatedOptions.description,
  });

  const manifest = pipeline.manifest;
  const exports = pipeline.exports;

  // Generate app identity
  const appId = crypto.randomUUID();
  const version = manifest?.version || '1.0.0';
  const slug = validatedOptions.slug || generateSlug(validatedFiles.find((f) => f.name === 'package.json')?.content);
  const appName = manifest?.name || validatedOptions.name || slug;
  const appDescription = validatedOptions.description || manifest?.description || null;
  const appType = manifest?.type || null;

  // Check app count limit
  const appCountErr = await checkAppLimit(userId);
  if (appCountErr) throw new Error(appCountErr);

  // Read storage soft-cap status before upload; product storage caps do not block.
  const totalUploadSizeBytes = pipeline.filesToUpload.reduce((sum, f) => sum + f.content.byteLength, 0);
  const uploadQuotaCheck = await checkStorageQuota(userId, totalUploadSizeBytes, {
    mode: 'fail_closed',
    resource: 'draft upload',
  });
  assertUploadQuota(uploadQuotaCheck, totalUploadSizeBytes);

  // Upload files to R2
  const r2Service = createR2Service();
  const storageKey = `apps/${appId}/${version}/`;
  await r2Service.uploadFiles(storageKey, pipeline.filesToUpload);

  if (globalThis.__env?.CODE_CACHE?.put && pipeline.esmBundledCode) {
    await globalThis.__env.CODE_CACHE.put(
      `esm:${appId}:${version}`,
      pipeline.esmBundledCode,
    );
    await globalThis.__env.CODE_CACHE.put(
      `esm:${appId}:latest`,
      pipeline.esmBundledCode,
    );
  }

  // Compute source fingerprint
  const { computeFingerprint, runOriginalityCheck, storeIntegrityResults } = await import('../services/originality.ts');
  const mdContent = validatedFiles.filter(f => f.name.endsWith('.md')).map(f => f.content).join('\n');
  const sourceFingerprint = await computeFingerprint(pipeline.entryFile.content, mdContent);

  // Visibility gating
  const requestedVisibility = validatedOptions.visibility || 'private';
  if (requestedVisibility !== 'private') {
    const uploaderTier = await getUserTier(userId);
    const visibilityErr = checkVisibilityAllowed(uploaderTier, requestedVisibility);
    if (visibilityErr) throw new Error(visibilityErr);

    const depositErr = await checkPublishDeposit(userId);
    if (depositErr) throw new Error(depositErr);

    const originalityResult = await runOriginalityCheck(userId, appId, validatedFiles, undefined, {
      mode: 'fail_closed',
    });
    if (!originalityResult.passed) {
      throw new Error(`Publish blocked: ${originalityResult.reason} (originality score: ${(originalityResult.score * 100).toFixed(1)}%)`);
    }
  }

  // Create app record
  const appsService = createAppsService();
  const versionTrust = await buildVersionTrustMetadata({
    appId,
    version,
    runtime: pipeline.runtime,
    manifest,
    files: pipeline.filesToUpload,
    storageKey,
  });
  const createPayload: Record<string, unknown> = {
    id: appId,
    owner_id: userId,
    slug,
    name: appName,
    description: appDescription,
    visibility: requestedVisibility,
    storage_key: storageKey,
    exports,
    manifest: manifest ? JSON.stringify(manifest) : null,
    env_schema: manifest ? resolveManifestEnvSchema(manifest) : {},
    app_type: appType,
    runtime: pipeline.runtime,
    ...(pipeline.runtime === 'gpu'
      ? {
          gpu_type: pipeline.gpuConfig?.gpu_type,
          gpu_status: 'building',
          gpu_config: pipeline.gpuConfig as unknown as Record<string, unknown> | undefined,
          gpu_max_duration_ms: pipeline.gpuConfig?.max_duration_ms || null,
          gpu_concurrency_limit: 5,
        }
      : {}),
    version_metadata: [
      buildVersionMetadataEntry(version, totalUploadSizeBytes, versionTrust),
    ],
  };
  if (validatedOptions.gap_id) createPayload.gap_id = validatedOptions.gap_id;
  await appsService.create(createPayload as Parameters<typeof appsService.create>[0]);

  // ── D1 provisioning — SYNCHRONOUS, eager ──
  let d1Status: UploadResponse['d1'];
  if (pipeline.hasMigrations) {
    const d1Result = await provisionAndMigrate(appId, pipeline.migrations);
    d1Status = {
      provisioned: d1Result.provisioned,
      status: d1Result.status,
      database_id: d1Result.database_id,
      migrations_applied: d1Result.migrations_applied,
      migrations_skipped: d1Result.migrations_skipped,
      error: d1Result.error,
    };
  }

  // Post-upload side effects (fire-and-forget)
  storeIntegrityResults(appId, {
    source_fingerprint: sourceFingerprint,
    safety_status: pipeline.safetyWarnings > 0 ? 'warned' : 'clean',
    integrity_checked_at: new Date().toISOString(),
  }).catch(err => integrityLogger.error('Fingerprint storage failed after programmatic upload', {
    app_id: appId,
    error: err,
  }));

  await recordUploadStorage(userId, appId, version, totalUploadSizeBytes);

  const appsForSkills = await appsService.findById(appId);
  if (appsForSkills) {
    generateSkillsForVersion(appsForSkills, storageKey, version)
      .then(skills => {
        if (skills.skillsMd) {
          skillsLogger.info('Generated Skills.md after programmatic upload', {
            app_id: appId,
            version,
          });
        }
        rebuildUserLibrary(userId).catch(err => uploadLogger.error('Library rebuild failed after programmatic upload', {
          user_id: userId,
          app_id: appId,
          error: err,
        }));
        import('../services/function-index.ts').then(m => m.rebuildFunctionIndex(userId)).catch(err => uploadLogger.error('Function index rebuild failed after programmatic upload', {
          user_id: userId,
          app_id: appId,
          error: err,
        }));
      })
      .catch(err => skillsLogger.error('Skills generation failed after programmatic upload', {
        app_id: appId,
        version,
        error: err,
      }));
  }

  return {
    app_id: appId,
    slug,
    version,
    url: `/a/${appId}`,
    exports,
    build_success: true,
    build_logs: pipeline.buildLogs,
    d1: d1Status,
  };
}

/**
 * Programmatic draft upload handler for Platform MCP
 * Uploads files as draft for an existing app
 */
export async function handleDraftUploadFiles(
  appId: string,
  userId: string,
  files: UploadFile[]
): Promise<{
  app_id: string;
  draft_version: string;
  draft_storage_key: string;
  exports: string[];
  build_success: boolean;
  build_logs: BuildLogEntry[];
  message: string;
}> {
  // Get the app and verify ownership
  const appsService = createAppsService();
  const app = await appsService.findById(appId);

  if (!app) {
    throw new Error('App not found');
  }

  if (app.owner_id !== userId) {
    throw new Error('Unauthorized');
  }

  // Validate file count
  if (files.length === 0) {
    throw new Error('No files provided');
  }
  if (files.length > MAX_FILES_PER_UPLOAD) {
    throw new Error(`Maximum ${MAX_FILES_PER_UPLOAD} files allowed`);
  }

  // Validate file types and size
  let totalSize = 0;
  const validatedFiles: Array<{ name: string; content: string }> = [];

  for (const file of files) {
    const hasValidExt = ALLOWED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!hasValidExt) {
      throw new Error(`File type not allowed: ${file.name}`);
    }

    totalSize += file.size;
    if (totalSize > MAX_UPLOAD_SIZE_BYTES) {
      throw new Error(`Total upload size exceeds ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB limit`);
    }

    validatedFiles.push({ name: file.name, content: file.content });
  }

  // Check for entry file
  const entryFileNames = ['index.tsx', 'index.ts', 'index.jsx', 'index.js'];
  const entryFile = validatedFiles.find((f) => {
    const fileName = f.name.split('/').pop() || f.name;
    return entryFileNames.includes(fileName);
  });
  if (!entryFile) {
    throw new Error('Entry file (index.ts, index.tsx, index.js, or index.jsx) required');
  }

  const normalizeFileName = (name: string): string => {
    const parts = name.split('/');
    if (parts.length > 1) {
      const firstPart = validatedFiles[0]?.name.split('/')[0];
      const allSameRoot = validatedFiles.every(f => f.name.startsWith(firstPart + '/'));
      if (allSameRoot && parts[0] === firstPart) {
        return parts.slice(1).join('/');
      }
    }
    return name;
  };

  const normalizedEntryName = normalizeFileName(entryFile.name);
  const uploadedManifest = parseUploadedManifest(validatedFiles);
  const manifestHydration = await hydrateManifestForSource({
    app: {
      name: app.name || app.slug,
      slug: app.slug,
      description: app.description,
    },
    existingManifest: uploadedManifest,
    sourceCode: entryFile.content,
    filename: normalizedEntryName,
    version: app.current_version || '1.0.0',
  });

  // Build logs
  const buildLogs: BuildLogEntry[] = [];
  const log = (level: BuildLogEntry['level'], message: string) => {
    buildLogs.push({ time: new Date().toISOString(), level, message });
  };

  const hasDraft = !!app.draft_storage_key;
  if (hasDraft) {
    log('warn', 'Overwriting existing draft');
  }

  log('info', `Starting draft build for ${validatedFiles.length} files...`);
  log(
    'info',
    manifestHydration.source === 'merged'
      ? 'Normalized manifest-backed contracts from uploaded manifest and source code'
      : 'Generated manifest-backed contracts from source code',
  );
  for (const parseError of manifestHydration.parseResult.parseErrors) {
    log('warn', `[Manifest] ${parseError}`);
  }
  for (const parseWarning of manifestHydration.parseResult.parseWarnings) {
    log('warn', `[Manifest] ${parseWarning}`);
  }

  // Extract exports
  log('info', 'Parsing entry file...');
  const exports = manifestHydration.manifest.functions
    ? Object.keys(manifestHydration.manifest.functions)
    : [];
  log('success', `Found ${exports.length} functions from manifest: ${exports.join(', ')}`);

  // Bundle the code
  log('info', 'Bundling code...');
  let bundledCode = entryFile.content;
  let esmBundledCode: string | undefined;
  let bundleUsed = false;

  try {
    log('info', 'Running esbuild bundler...');
    const bundleResult = await bundleCode(validatedFiles, entryFile.name);

    if (!bundleResult.success) {
      for (const err of bundleResult.errors) {
        log('error', err);
      }
      throw new Error('Build failed: ' + bundleResult.errors.join(', '));
    }

    for (const warn of bundleResult.warnings) {
      log('warn', warn);
    }

    if (bundleResult.code !== entryFile.content) {
      bundledCode = bundleResult.code;
      esmBundledCode = bundleResult.esmCode;
      bundleUsed = true;
      log('success', 'Bundle complete (IIFE + ESM)');
    } else {
      log('success', 'No bundling needed (no imports)');
    }
  } catch (bundleErr) {
    log('warn', `Bundling skipped: ${bundleErr instanceof Error ? bundleErr.message : String(bundleErr)}`);
    bundledCode = entryFile.content;
  }

  // Layer 1: Safety scan (before R2 upload)
  log('info', 'Running safety scan...');
  const { runSafetyScan: runProgrammaticDraftSafetyScan } = await import('../services/integrity.ts');
  const programmaticDraftSafetyResult = runProgrammaticDraftSafetyScan(validatedFiles);
  if (!programmaticDraftSafetyResult.passed) {
    const errorSummary = programmaticDraftSafetyResult.issues
      .filter(i => i.severity === 'error')
      .map(i => `[${i.rule}] ${i.message}`)
      .join('; ');
    throw new Error(`Upload blocked by safety scan: ${errorSummary}`);
  }
  if (programmaticDraftSafetyResult.summary.warnings > 0) {
    for (const warn of programmaticDraftSafetyResult.issues.filter(i => i.severity === 'warning')) {
      log('warn', `[${warn.rule}] ${warn.message}`);
    }
  }
  log('success', `Safety scan passed (${programmaticDraftSafetyResult.summary.warnings} warnings)`);

  // Generate draft version
  const draftVersion = `draft-${Date.now()}`;

  // Initialize R2 service
  const r2Service = createR2Service();

  // Prepare files for upload
  const filesToUpload = upsertManifestUploadFile(
    bundleUsed
    ? [
        {
          name: normalizedEntryName,
          content: new TextEncoder().encode(bundledCode),
          contentType: getContentType(normalizedEntryName),
        },
        // Upload ESM bundle for browser rendering
        ...(esmBundledCode ? [{
          name: normalizedEntryName.replace(/\.(tsx?|jsx?)$/, '.esm.js'),
          content: new TextEncoder().encode(esmBundledCode),
          contentType: 'application/javascript',
        }] : []),
        // Upload original entry file with _source_ prefix for generate-docs parsing
        {
          name: `_source_${normalizedEntryName}`,
          content: new TextEncoder().encode(entryFile.content),
          contentType: getContentType(normalizedEntryName),
        },
        ...validatedFiles
          .filter(f => f.name !== entryFile.name)
          .map(f => ({
            name: normalizeFileName(f.name),
            content: new TextEncoder().encode(f.content),
            contentType: getContentType(f.name),
          })),
      ]
    : validatedFiles.map(f => ({
        name: normalizeFileName(f.name),
        content: new TextEncoder().encode(f.content),
        contentType: getContentType(f.name),
      })),
    manifestHydration.manifest,
    (manifestJson) => ({
      name: 'manifest.json',
      content: new TextEncoder().encode(manifestJson),
      contentType: 'application/json',
    }),
  );

  // Upload to draft storage location
  log('info', 'Uploading draft to storage...');
  const draftStorageKey = `apps/${appId}/draft/`;
  await r2Service.uploadFiles(draftStorageKey, filesToUpload);
  log('success', 'Draft upload complete');

  // Update app record with draft info
  log('info', 'Updating app record...');
  await appsService.update(appId, {
    draft_storage_key: draftStorageKey,
    draft_version: draftVersion,
    draft_uploaded_at: new Date().toISOString(),
    draft_exports: exports,
  });
  log('success', 'Draft record updated');

  log('success', 'Draft build complete!');

  return {
    app_id: appId,
    draft_version: draftVersion,
    draft_storage_key: draftStorageKey,
    exports,
    build_success: true,
    build_logs: buildLogs,
    message: 'Draft uploaded successfully. Publish when ready.',
  };
}
