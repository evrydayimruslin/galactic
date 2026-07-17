// Apps Handler
// Handles app listing, discovery, and app-specific operations

import { error, json, toResponseBody } from "./response.ts";
import { authenticate } from "./auth.ts";
import { createAppsService } from "../services/apps.ts";
import { createR2Service, type R2Service } from "../services/storage.ts";
import {
  ICON_EXTENSIONS,
  iconContentVersion,
  iconContentType,
  isIconContentVersion,
  isIconExtension,
  legacyIconObjectKey,
  parseIconReference,
  selectVersionedIconKeysForDeletion,
  type IconExtension,
  validateIconImage,
  versionedIconObjectKey,
} from "../services/icon-image.ts";
import { getCodeCache } from "../services/codecache.ts";
import { bundleCode } from "../services/bundler.ts";
import { ogCardKey, renderAgentOgCard } from "../services/og-card.ts";
import { scheduleCaptureTask } from "../services/chat-capture.ts";
import { parseTypeScript, toSkillsParsed } from "../services/parser.ts";
import {
  generateManifestFromParseResult,
  rebuildUserLibrary,
} from "../services/library.ts";
import {
  generateEmbeddingText,
  generateSkillsMd,
  validateAndParseSkillsMd,
} from "../services/docgen.ts";
import {
  createEmbeddingService,
  isEmbeddingAvailable,
  storeAppEmbedding,
} from "../services/embedding.ts";
import type {
  App,
  AppPricingConfig,
  GenerationError,
  GenerationResult,
} from "../../shared/types/index.ts";
import {
  normalizeManifestParameters,
  resolveManifestEnvSchema,
} from "../../shared/contracts/manifest.ts";
import {
  ENV_VAR_LIMITS,
  validateEnvVarKey,
  validateEnvVarValue,
} from "../../shared/contracts/env.ts";
import {
  decryptEnvVars,
  encryptEnvVar,
  getEnvVarsSummary,
} from "../services/envvars.ts";
import {
  getScopedEnvSchemaEntries,
  parseAppManifest,
  resolveAppEnvSchema,
} from "../services/app-settings.ts";
import { type PublicAppServing } from "../services/public-apps.ts";
import {
  checkPublisherPublishReadiness,
  checkVisibilityAllowed,
  getUserTier,
  type PublishReadinessOptions,
  publishReadinessErrorPayload,
} from "../services/tier-enforcement.ts";
import {
  getVersionStorageBytes,
  reclaimAppStorage,
  recordUploadStorage,
} from "../services/storage-quota.ts";
import { validateGpuPricingConfig } from "../services/gpu/pricing-config.ts";
import {
  getGpuSupportDisabledMessage,
  isGpuSupportEnabled,
  sanitizeGpuTrustCard,
} from "../services/gpu/feature-flag.ts";
import { getEnv } from "../lib/env.ts";
import { withSensitiveRouteRateLimit } from "../services/sensitive-route-rate-limit.ts";
import { RequestValidationError } from "../services/request-validation.ts";
import {
  assertOwnedSupabaseConfig,
  validateAppSupabaseConfigRequest,
} from "../services/platform-request-validation.ts";
import { classifyAppSupabaseConfigState } from "../services/app-runtime-resources.ts";
import {
  AppContractMigrationRequiredError,
  logAppContractResolution,
  requireManifestFunctionContracts,
  resolveAppFunctionContracts,
} from "../services/app-contracts.ts";
import { resolveStoredManifestCoverage } from "../services/app-manifest-generation.ts";
import { createServerLogger } from "../services/logging.ts";
import {
  buildHttpRouteCatalog,
  formatHttpRouteCatalogLine,
  getRequestBaseUrl,
} from "../services/http-route-catalog.ts";
import {
  appendVersionTrustMetadata,
  buildAppTrustCard,
  buildVersionMetadataEntry,
  buildVersionTrustMetadata,
  diffManifests,
} from "../services/trust.ts";
import { putLiveExecutedBundle } from "../services/executed-bundle.ts";
import {
  buildPerUserSettingsStatus,
  type UserAppSecretStatusRow as SharedUserAppSecretStatusRow,
  validatePerUserSettingsValues,
} from "../services/user-app-settings.ts";
import { buildAppSecretDiagnostics } from "../services/app-diagnostics.ts";
import { isAccountSessionAuthSource } from "../services/control-plane-auth.ts";
import { extractRequestAccessToken } from "../services/request-auth.ts";
import { isRoutineActorToken } from "../services/routine-auth.ts";
import { isSandboxActorToken } from "../services/sandbox-actor.ts";

const appsLogger = createServerLogger("APPS");
const docsLogger = createServerLogger("DOCS");
const publishLogger = createServerLogger("PUBLISH");
const rebuildLogger = createServerLogger("REBUILD");
const callLogLogger = createServerLogger("CALL-LOG");

async function publisherPublishReadinessResponse(
  userId: string,
  options: PublishReadinessOptions = {},
): Promise<Response | null> {
  const readiness = await checkPublisherPublishReadiness(userId, options);
  if (readiness.allowed || !readiness.block) return null;
  return json(
    publishReadinessErrorPayload(readiness.block),
    readiness.block.status,
  );
}

function withOwnerTrustCard<T extends App>(
  app: T,
): T & { trust_card: ReturnType<typeof buildAppTrustCard> } {
  return {
    ...app,
    trust_card: sanitizeGpuTrustCard(buildAppTrustCard(app)),
  };
}

function shouldHideGpuApp(app: { runtime?: string | null }): boolean {
  return app.runtime === "gpu" && !isGpuSupportEnabled();
}

type EmbeddingUser = Awaited<ReturnType<typeof authenticate>> & {
  openrouter_api_key?: string;
};

type UserAppSecretRow = SharedUserAppSecretStatusRow;

interface LibraryAppIdRow {
  app_id: string;
}

interface LibraryContentIdRow {
  content_id: string;
}

interface LibraryAppRow {
  id: string;
  name: string | null;
  slug: string;
  description: string | null;
  current_version: string | null;
  exports: string[] | null;
  skills_parsed: unknown;
  manifest: unknown;
  owner_id: string;
}

interface LibraryContentRow {
  id: string;
  type: string;
  slug: string;
  title: string | null;
  description: string | null;
  owner_id: string;
}

interface ContentShareRow {
  content_id: string;
  expires_at: string | null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const body = await request.json();
  return isObjectRecord(body) ? body : {};
}

async function resolveStoredVersionStorageBytes(
  app: App,
  version: string,
  storageKey: string,
  r2Service: R2Service,
): Promise<number> {
  const metadataBytes = getVersionStorageBytes(app.version_metadata, version);
  if (metadataBytes !== null) {
    return metadataBytes;
  }

  const files = await r2Service.listFiles(storageKey);
  let totalBytes = 0;
  for (const fileKey of files) {
    const content = await r2Service.fetchFile(fileKey);
    totalBytes += content.byteLength;
  }
  return totalBytes;
}

async function resolveStoredVersionExports(
  storageKey: string,
  r2Service: R2Service,
  manifestJson: string | null,
): Promise<string[] | null> {
  if (manifestJson) {
    try {
      const manifest = JSON.parse(manifestJson);
      if (
        manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ) {
        const functions = (manifest as Record<string, unknown>).functions;
        if (
          functions && typeof functions === "object" &&
          !Array.isArray(functions)
        ) {
          return Object.keys(functions);
        }
      }
    } catch {
      // Fall back to source inspection below.
    }
  }

  const entryNames = [
    "_source_index.ts",
    "_source_index.tsx",
    "index.ts",
    "index.tsx",
    "index.js",
  ];
  for (const entry of entryNames) {
    try {
      const code = await r2Service.fetchTextFile(`${storageKey}${entry}`);
      const exportRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
      const constRegex = /export\s+(?:const|let|var)\s+(\w+)\s*=/g;
      const exports: string[] = [];
      let match;
      while ((match = exportRegex.exec(code)) !== null) exports.push(match[1]);
      while ((match = constRegex.exec(code)) !== null) exports.push(match[1]);
      return exports.length > 0 ? exports : null;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

function toDocgenPricingConfig(
  pricingConfig: AppPricingConfig | null | undefined,
): {
  default_price_light?: number;
  functions?: Record<string, number>;
  products?: Array<
    { id: string; name: string; price_light: number; description?: string }
  >;
} | undefined {
  if (!pricingConfig) {
    return undefined;
  }

  const functions = pricingConfig.functions
    ? Object.fromEntries(
      Object.entries(pricingConfig.functions).map(([name, config]) => [
        name,
        typeof config === "number" ? config : config.price_light,
      ]),
    )
    : undefined;

  return {
    default_price_light: pricingConfig.default_price_light,
    functions,
    products: pricingConfig.products?.map((product) => ({
      id: product.id,
      name: product.name,
      price_light: product.price_light,
      description: product.description,
    })),
  };
}

async function resolvePublicAppAccess(
  request: Request,
  appId: string,
  options: {
    allowPrivateOwner?: boolean;
    requireFullOwnerApp?: boolean;
  } = {},
): Promise<{
  app: App | PublicAppServing | null;
  isOwner: boolean;
}> {
  const appsService = createAppsService();
  const publicApp = await appsService.findPublicServingById(appId);

  let userId: string | null = null;
  try {
    const user: EmbeddingUser = await authenticate(request);
    userId = user.id;
  } catch {
    userId = null;
  }

  if (publicApp) {
    if (
      userId && publicApp.owner_id === userId && options.requireFullOwnerApp
    ) {
      const ownerApp = await appsService.findById(appId);
      if (ownerApp) {
        return { app: ownerApp, isOwner: true };
      }
    }

    return { app: publicApp, isOwner: userId === publicApp.owner_id };
  }

  if (!options.allowPrivateOwner || !userId) {
    return { app: null, isOwner: false };
  }

  const ownerApp = await appsService.findById(appId);
  if (
    !ownerApp || ownerApp.owner_id !== userId ||
    ownerApp.visibility !== "private"
  ) {
    return { app: null, isOwner: false };
  }

  return { app: ownerApp, isOwner: true };
}

/**
 * Handle /api/apps routes
 */
export async function handleApps(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  appsLogger.debug("Routing app handler request", { method, path });

  // Tenant code can read its short-lived sandbox bearer. The legacy Apps REST
  // reads authorize by user id and predate actor app/function scopes, so
  // accepting that bearer here would let one Agent inspect every Agent the
  // owner controls (source, call logs, health, and private metadata). Reject a
  // VERIFIED actor credential before every route. Invalid/forged actor-shaped
  // tokens still fall through as unauthenticated, preserving public reads.
  const presentedToken = extractRequestAccessToken(request);
  if (
    presentedToken &&
    (isRoutineActorToken(presentedToken) ||
      isSandboxActorToken(presentedToken))
  ) {
    try {
      const caller = await authenticate(request);
      if (
        caller.authSource === "routine_actor" ||
        caller.authSource === "sandbox_actor"
      ) {
        return error(
          "Agent runtime credentials cannot access the legacy Apps REST API. Use manifest-bound sandbox capabilities and scoped gx.* tools.",
          403,
        );
      }
    } catch {
      // An invalid actor-shaped token grants no private access. Public routes
      // retain their existing anonymous behavior; protected routes authenticate
      // again below and fail normally.
    }
  }

  // This legacy REST surface predates scoped Connect keys and cannot enforce
  // gx.test attestations or per-action builder/operator scopes. Keep reads for
  // compatibility, but require a browser/account session for every mutation.
  // Connected coding agents use Platform MCP's gx.* control plane instead.
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    try {
      const caller = await authenticate(request);
      if (!isAccountSessionAuthSource(caller.authSource)) {
        return error(
          "App management through the legacy REST API requires an authenticated Galactic account session. Connected agents must use scoped gx.* tools.",
          403,
        );
      }
    } catch {
      return error("Authentication required", 401);
    }
  }

  // GET /api/apps - List public apps
  if (path === "/api/apps" && method === "GET") {
    appsLogger.debug("Routing to list public apps", { method, path });
    return handleListPublicApps(request);
  }

  // GET /api/apps/me - List user's own apps (authenticated)
  if (path === "/api/apps/me" && method === "GET") {
    appsLogger.debug("Routing to list owner apps", { method, path });
    return handleListMyApps(request);
  }

  // GET /api/apps/me/library?tab=saved|shared - Library tabs
  if (path === "/api/apps/me/library" && method === "GET") {
    appsLogger.debug("Routing to library tab handler", { method, path });
    return handleLibraryTab(request);
  }

  // Routes with app ID: /api/apps/:appId/*
  const appIdMatch = path.match(/^\/api\/apps\/([^\/]+)(\/.*)?$/);
  if (appIdMatch) {
    const appId = appIdMatch[1];
    const subPath = appIdMatch[2] || "";

    // GET /api/apps/:appId - Get app details
    if (subPath === "" && method === "GET") {
      return handleGetApp(request, appId);
    }

    // GET /api/apps/:appId/code - Get app code (for client-side execution)
    if (subPath === "/code" && method === "GET") {
      return handleGetAppCode(request, appId);
    }

    // PATCH /api/apps/:appId - Update app
    if (subPath === "" && method === "PATCH") {
      return handleUpdateApp(request, appId);
    }

    // DELETE /api/apps/:appId - Delete app
    if (subPath === "" && method === "DELETE") {
      return handleDeleteApp(request, appId);
    }

    // POST /api/apps/:appId/icon - Upload app icon
    if (subPath === "/icon" && method === "POST") {
      return handleUploadIcon(request, appId);
    }

    // GET /api/apps/:appId/icon - Serve app icon
    if (subPath === "/icon" && method === "GET") {
      return handleGetIcon(request, appId);
    }

    // GET /api/apps/:appId/download - Download app code as zip
    if (subPath === "/download" && method === "GET") {
      return handleDownloadCode(request, appId);
    }

    // POST /api/apps/:appId/generate-docs - Generate Skills.md and parse skills
    if (subPath === "/generate-docs" && method === "POST") {
      return handleGenerateDocs(request, appId);
    }

    // GET /api/apps/:appId/instructions - Agent-ready instruction block for this app
    if (subPath === "/instructions" && method === "GET") {
      return handleGetAppInstructions(request, appId);
    }

    // GET /api/apps/:appId/http-routes - Declared direct HTTP route catalog
    if (subPath === "/http-routes" && method === "GET") {
      return handleGetHttpRoutes(request, appId);
    }

    // GET /api/apps/:appId/skills.md - Get Skills.md documentation
    if (subPath === "/skills.md" && method === "GET") {
      return handleGetSkillsMd(request, appId);
    }

    // PATCH /api/apps/:appId/skills - Update skills (with validation)
    if (subPath === "/skills" && method === "PATCH") {
      return handleUpdateSkills(request, appId);
    }

    // POST /api/apps/:appId/draft - Upload new code as draft
    if (subPath === "/draft" && method === "POST") {
      // Import and call draft upload handler
      const { handleDraftUpload } = await import("./upload.ts");
      return handleDraftUpload(request, appId);
    }

    // POST /api/apps/:appId/publish - Publish draft to production
    if (subPath === "/publish" && method === "POST") {
      return handlePublishDraft(request, appId);
    }

    // DELETE /api/apps/:appId/draft - Discard draft
    if (subPath === "/draft" && method === "DELETE") {
      return handleDiscardDraft(request, appId);
    }

    // GET /api/apps/:appId/draft - Get draft info
    if (subPath === "/draft" && method === "GET") {
      return handleGetDraft(request, appId);
    }

    // POST /api/apps/:appId/rebuild - Re-bundle app code from stored source
    if (subPath === "/rebuild" && method === "POST") {
      return handleRebuild(request, appId);
    }

    // ============================================
    // ENV VARS ENDPOINTS
    // ============================================

    // GET /api/apps/:appId/env - List env var keys (masked values)
    if (subPath === "/env" && method === "GET") {
      return handleGetEnvVars(request, appId);
    }

    // PUT /api/apps/:appId/env - Set all env vars (replaces existing)
    if (subPath === "/env" && method === "PUT") {
      return handleSetEnvVars(request, appId);
    }

    // PATCH /api/apps/:appId/env - Update specific env vars
    if (subPath === "/env" && method === "PATCH") {
      return handleUpdateEnvVars(request, appId);
    }

    // DELETE /api/apps/:appId/env/:key - Delete a specific env var
    const envKeyMatch = subPath.match(/^\/env\/([^\/]+)$/);
    if (envKeyMatch && method === "DELETE") {
      return handleDeleteEnvVar(request, appId, envKeyMatch[1]);
    }

    // DELETE /api/apps/:appId/versions/:version - Delete a specific version
    const versionMatch = subPath.match(/^\/versions\/([^\/]+)$/);
    if (versionMatch && method === "DELETE") {
      return handleDeleteVersion(request, appId, versionMatch[1]);
    }

    // GET /api/apps/:appId/supabase - Get Supabase configuration (masked)
    if (subPath === "/supabase" && method === "GET") {
      return handleGetSupabaseConfig(request, appId);
    }

    // PUT /api/apps/:appId/supabase - Set Supabase configuration
    if (subPath === "/supabase" && method === "PUT") {
      return handleSetSupabaseConfig(request, appId);
    }

    // DELETE /api/apps/:appId/supabase - Remove Supabase configuration
    if (subPath === "/supabase" && method === "DELETE") {
      return handleDeleteSupabaseConfig(request, appId);
    }

    // GET /api/apps/:appId/earnings - Get app earnings & revenue data
    if (subPath === "/earnings" && method === "GET") {
      return handleGetEarnings(request, appId);
    }

    // GET /api/apps/:appId/health - Get health events & auto-heal history
    if (subPath === "/health" && method === "GET") {
      return handleGetHealth(request, appId);
    }

    // PATCH /api/apps/:appId/health - Toggle auto-heal on/off
    if (subPath === "/health" && method === "PATCH") {
      return handleUpdateHealth(request, appId);
    }

    // GET /api/apps/:appId/call-log - Owner call log (all users' activity)
    if (subPath === "/call-log" && method === "GET") {
      return handleGetAppCallLog(request, appId);
    }

    // POST /api/apps/:appId/save - Save app to user's library
    if (subPath === "/save" && method === "POST") {
      return handleSaveApp(request, appId);
    }

    // DELETE /api/apps/:appId/save - Remove app from user's library
    if (subPath === "/save" && method === "DELETE") {
      return handleUnsaveApp(request, appId);
    }

    // GET /api/apps/:appId/library-status - Per-app { inLibrary, isOwner } for CTAs
    if (subPath === "/library-status" && method === "GET") {
      return handleGetLibraryStatus(request, appId);
    }

    // GET /api/apps/:appId/settings - Current user's per-user settings schema + status
    if (subPath === "/settings" && method === "GET") {
      return handleGetUserSettings(request, appId);
    }

    // PUT /api/apps/:appId/settings - Upsert current user's per-user settings
    if (subPath === "/settings" && method === "PUT") {
      return handleUpdateUserSettings(request, appId);
    }

    // App store listing screenshots

    // POST /api/apps/:appId/screenshots - Upload a new screenshot (owner)
    if (subPath === "/screenshots" && method === "POST") {
      return handleUploadScreenshot(request, appId);
    }

    // PUT /api/apps/:appId/screenshots/order - Reorder screenshots (owner)
    // Body: { order: number[] } — new index sequence
    if (subPath === "/screenshots/order" && method === "PUT") {
      return handleReorderScreenshots(request, appId);
    }

    // DELETE /api/apps/:appId/screenshots/:index - Delete a screenshot by index (owner)
    const screenshotDeleteMatch = subPath.match(/^\/screenshots\/(\d+)$/);
    if (screenshotDeleteMatch && method === "DELETE") {
      const idx = parseInt(screenshotDeleteMatch[1], 10);
      return handleDeleteScreenshot(request, appId, idx);
    }

    // GET /api/apps/:appId/screenshots/:index - Serve a screenshot by index (public if app is)
    if (screenshotDeleteMatch && method === "GET") {
      const idx = parseInt(screenshotDeleteMatch[1], 10);
      return handleGetScreenshot(request, appId, idx);
    }
  }

  return error("Not found", 404);
}

/**
 * List public apps for discovery
 */
async function handleListPublicApps(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const search = url.searchParams.get("q") || "";

  // Legacy endpoint retained for compatibility. Public discovery is served by /api/discover.
  const apps: unknown[] = [];

  return json({ apps });
}

/**
 * List authenticated user's own apps
 */
async function handleListMyApps(request: Request): Promise<Response> {
  appsLogger.debug("Listing owner apps");

  // Step 1: Authenticate
  let user;
  try {
    user = await authenticate(request);
    appsLogger.debug("Owner apps auth succeeded", { user_id: user.id });
  } catch (authErr) {
    appsLogger.warn("Owner apps auth failed", { error: authErr });
    return error("Authentication required", 401);
  }

  // Step 2: Create service
  let appsService;
  try {
    appsService = createAppsService();
  } catch (serviceErr) {
    appsLogger.error("Failed to initialize apps service", {
      error: serviceErr,
    });
    return error("Service initialization failed", 500);
  }

  // Step 3: List apps
  try {
    const apps = await appsService.listByOwner(user.id);
    appsLogger.info("Listed owner apps", {
      user_id: user.id,
      count: apps.length,
    });
    return json(apps);
  } catch (listErr) {
    appsLogger.error("Failed to list owner apps", {
      user_id: user.id,
      error: listErr,
    });
    return error("Failed to list apps", 500);
  }
}

/**
 * Resolve owner emails for a list of user IDs.
 */
async function resolveOwnerEmails(
  ownerIds: string[],
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<Map<string, string>> {
  if (ownerIds.length === 0) return new Map();
  const res = await fetch(
    `${supabaseUrl}/rest/v1/users?id=in.(${
      ownerIds.join(",")
    })&select=id,email`,
    { headers },
  );
  if (!res.ok) return new Map();
  const rows = await res.json() as Array<{ id: string; email: string }>;
  return new Map(rows.map((r) => [r.id, r.email]));
}

/**
 * Library tabs: saved and shared items
 * GET /api/apps/me/library?tab=saved|shared
 */
async function handleLibraryTab(request: Request): Promise<Response> {
  // Authenticate
  let user;
  try {
    user = await authenticate(request);
  } catch {
    return error("Authentication required", 401);
  }

  const url = new URL(request.url);
  const tab = url.searchParams.get("tab");
  if (tab !== "saved" && tab !== "shared") {
    return error('Invalid tab parameter. Must be "saved" or "shared".', 400);
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers: Record<string, string> = {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
  };

  try {
    if (tab === "saved") {
      return await handleSavedTab(user.id, supabaseUrl, headers);
    } else {
      return await handleSharedTab(user.id, user.email, supabaseUrl, headers);
    }
  } catch (err) {
    console.error("[LIBRARY] Failed to load tab:", tab, err);
    return error("Failed to load library tab", 500);
  }
}

async function handleSavedTab(
  userId: string,
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<Response> {
  // Saved apps
  const savedAppsRes = await fetch(
    `${supabaseUrl}/rest/v1/user_app_library?user_id=eq.${userId}&select=app_id&limit=100`,
    { headers },
  );
  const savedAppRows = savedAppsRes.ok
    ? await savedAppsRes.json() as LibraryAppIdRow[]
    : [];
  const savedAppIds = savedAppRows.map((row) => row.app_id);

  let savedApps: LibraryAppRow[] = [];
  if (savedAppIds.length > 0) {
    const appsRes = await fetch(
      `${supabaseUrl}/rest/v1/apps?id=in.(${
        savedAppIds.join(",")
      })&deleted_at=is.null&select=id,name,slug,description,current_version,exports,skills_parsed,manifest,owner_id`,
      { headers },
    );
    if (appsRes.ok) savedApps = await appsRes.json() as LibraryAppRow[];
  }

  // Saved content (pages)
  const savedContentRes = await fetch(
    `${supabaseUrl}/rest/v1/user_content_library?user_id=eq.${userId}&select=content_id&limit=100`,
    { headers },
  );
  const savedContentRows = savedContentRes.ok
    ? await savedContentRes.json() as LibraryContentIdRow[]
    : [];
  const savedContentIds = savedContentRows.map((row) => row.content_id);

  let savedContent: LibraryContentRow[] = [];
  if (savedContentIds.length > 0) {
    const contentRes = await fetch(
      `${supabaseUrl}/rest/v1/content?id=in.(${
        savedContentIds.join(",")
      })&type=eq.page&select=id,type,slug,title,description,owner_id`,
      { headers },
    );
    if (contentRes.ok) {
      savedContent = await contentRes.json() as LibraryContentRow[];
    }
  }

  // Resolve owner emails
  const ownerIds = [
    ...new Set([
      ...savedApps.map((a) => a.owner_id as string),
      ...savedContent.map((c) => c.owner_id as string),
    ]),
  ];
  const ownerMap = await resolveOwnerEmails(ownerIds, supabaseUrl, headers);

  // Build unified response
  const items = [
    ...savedApps.map((a) => ({
      id: a.id,
      type: "app",
      name: (a.name as string) || (a.slug as string),
      slug: a.slug,
      description: a.description || null,
      version: a.current_version || null,
      fn_count: getFnCount(a),
      owner_email: ownerMap.get(a.owner_id as string) || null,
    })),
    ...savedContent.map((c) => ({
      id: c.id,
      type: "page",
      name: (c.title as string) || (c.slug as string),
      slug: c.slug,
      description: c.description || null,
      version: null,
      fn_count: 0,
      owner_email: ownerMap.get(c.owner_id as string) || null,
    })),
  ];

  return json(items);
}

async function handleSharedTab(
  userId: string,
  userEmail: string,
  supabaseUrl: string,
  headers: Record<string, string>,
): Promise<Response> {
  // Shared apps (via permissions)
  const sharedPermsRes = await fetch(
    `${supabaseUrl}/rest/v1/user_app_permissions?granted_to_user_id=eq.${userId}&allowed=eq.true&select=app_id&limit=200`,
    { headers },
  );
  const sharedPermRows = sharedPermsRes.ok
    ? await sharedPermsRes.json() as LibraryAppIdRow[]
    : [];
  const sharedAppIds = [...new Set(sharedPermRows.map((row) => row.app_id))];

  let sharedApps: LibraryAppRow[] = [];
  if (sharedAppIds.length > 0) {
    // Exclude own apps
    const appsRes = await fetch(
      `${supabaseUrl}/rest/v1/apps?id=in.(${
        sharedAppIds.join(",")
      })&owner_id=neq.${userId}&deleted_at=is.null&select=id,name,slug,description,current_version,exports,skills_parsed,manifest,owner_id`,
      { headers },
    );
    if (appsRes.ok) sharedApps = await appsRes.json() as LibraryAppRow[];
  }

  // Shared content (via content_shares)
  const encodedEmail = encodeURIComponent(userEmail);
  const sharedContentRes = await fetch(
    `${supabaseUrl}/rest/v1/content_shares?or=(shared_with_user_id.eq.${userId},shared_with_email.eq.${encodedEmail})&select=content_id,expires_at&limit=200`,
    { headers },
  );
  const allShares = sharedContentRes.ok
    ? await sharedContentRes.json() as ContentShareRow[]
    : [];
  // Filter out expired shares
  const now = new Date();
  const validShares = allShares.filter((s) =>
    !s.expires_at || new Date(s.expires_at) > now
  );
  const sharedContentIds = [...new Set(validShares.map((s) => s.content_id))];

  let sharedContent: LibraryContentRow[] = [];
  if (sharedContentIds.length > 0) {
    const contentRes = await fetch(
      `${supabaseUrl}/rest/v1/content?id=in.(${
        sharedContentIds.join(",")
      })&type=eq.page&select=id,type,slug,title,description,owner_id`,
      { headers },
    );
    if (contentRes.ok) {
      sharedContent = await contentRes.json() as LibraryContentRow[];
    }
  }

  // Resolve owner emails
  const ownerIds = [
    ...new Set([
      ...sharedApps.map((a) => a.owner_id as string),
      ...sharedContent.map((c) => c.owner_id as string),
    ]),
  ];
  const ownerMap = await resolveOwnerEmails(ownerIds, supabaseUrl, headers);

  // Build unified response
  const items = [
    ...sharedApps.map((a) => ({
      id: a.id,
      type: "app",
      name: (a.name as string) || (a.slug as string),
      slug: a.slug,
      description: a.description || null,
      version: a.current_version || null,
      fn_count: getFnCount(a),
      owner_email: ownerMap.get(a.owner_id as string) || null,
    })),
    ...sharedContent.map((c) => ({
      id: c.id,
      type: "page",
      name: (c.title as string) || (c.slug as string),
      slug: c.slug,
      description: c.description || null,
      version: null,
      fn_count: 0,
      owner_email: ownerMap.get(c.owner_id as string) || null,
    })),
  ];

  return json(items);
}

/**
 * POST /api/apps/:appId/save — Save app to user's library
 */
async function handleSaveApp(
  request: Request,
  appId: string,
): Promise<Response> {
  let user;
  try {
    user = await authenticate(request);
  } catch {
    return error("Authentication required", 401);
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/user_app_library`, {
      method: "POST",
      headers: {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({ user_id: user.id, app_id: appId, source: "like" }),
    });
    if (!res.ok) {
      const err = await res.text();
      return error("Failed to save app: " + err, 500);
    }
    return json({ saved: true });
  } catch (err) {
    return error("Failed to save app", 500);
  }
}

/**
 * DELETE /api/apps/:appId/save — Remove app from user's library
 */
async function handleUnsaveApp(
  request: Request,
  appId: string,
): Promise<Response> {
  let user;
  try {
    user = await authenticate(request);
  } catch {
    return error("Authentication required", 401);
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");

  try {
    await fetch(
      `${supabaseUrl}/rest/v1/user_app_library?user_id=eq.${user.id}&app_id=eq.${appId}`,
      {
        method: "DELETE",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
        },
      },
    );
    return json({ saved: false });
  } catch (err) {
    return error("Failed to unsave app", 500);
  }
}

/**
 * GET /api/apps/:appId/library-status
 *
 * Returns install state plus per-user settings readiness for the authenticated
 * user + given app. Used by the public store page's client-side bootstrap
 * to decide which CTA buttons to render.
 *
 * This is intentionally a per-app endpoint (not "list my library") —
 * O(1) regardless of library size, never paginates.
 *
 * Auth required: returns 401 if the caller is anonymous. The store page
 * JS treats missing token as "anonymous" state without even calling this.
 */
async function handleGetLibraryStatus(
  request: Request,
  appId: string,
): Promise<Response> {
  let user;
  try {
    user = await authenticate(request);
  } catch {
    return error("Authentication required", 401);
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
  };

  try {
    // Cheap parallel queries: owner check + library membership check.
    const [appRes, libRes] = await Promise.all([
      fetch(
        `${supabaseUrl}/rest/v1/apps?id=eq.${appId}&select=owner_id,env_schema,manifest&limit=1`,
        { headers },
      ),
      fetch(
        `${supabaseUrl}/rest/v1/user_app_library?user_id=eq.${user.id}&app_id=eq.${appId}&select=app_id&limit=1`,
        { headers },
      ),
    ]);

    if (!appRes.ok) return error("App not found", 404);
    const appRows = await appRes.json() as Array<
      { owner_id: string; env_schema?: unknown; manifest?: unknown }
    >;
    if (appRows.length === 0) return error("App not found", 404);

    const isOwner = appRows[0].owner_id === user.id;
    const libRows = libRes.ok ? await libRes.json() as unknown[] : [];
    const inLibrary = libRows.length > 0;
    const resolvedSchema = resolveAppEnvSchema(appRows[0]);
    const perUserEntries = getScopedEnvSchemaEntries(
      resolvedSchema,
      "per_user",
    );

    let settingsStatus = {
      hasUserSettings: perUserEntries.length > 0,
      connectedKeys: [] as string[],
      missingRequired: [] as string[],
      fullyConnected: true,
      requiresSetup: false,
    };

    if (perUserEntries.length > 0 && (isOwner || inLibrary)) {
      const secretsRes = await fetch(
        `${supabaseUrl}/rest/v1/user_app_secrets?user_id=eq.${user.id}&app_id=eq.${appId}&select=key,updated_at`,
        { headers },
      );
      const secretRows = secretsRes.ok
        ? await secretsRes.json() as UserAppSecretRow[]
        : [];
      const perUserStatus = buildPerUserSettingsStatus(
        resolvedSchema,
        secretRows,
      );
      settingsStatus = {
        hasUserSettings: true,
        connectedKeys: perUserStatus.connectedKeys,
        missingRequired: perUserStatus.missingRequired,
        fullyConnected: perUserStatus.fullyConnected,
        requiresSetup: perUserStatus.missingRequired.length > 0,
      };
    }

    return json({
      inLibrary,
      isOwner,
      hasUserSettings: settingsStatus.hasUserSettings,
      connectedKeys: settingsStatus.connectedKeys,
      missingRequired: settingsStatus.missingRequired,
      fullyConnected: settingsStatus.fullyConnected,
      requiresSetup: settingsStatus.requiresSetup,
    });
  } catch (err) {
    console.error("[library-status] failed:", err);
    return error("Failed to get library status", 500);
  }
}

/**
 * GET /api/apps/:appId/settings
 *
 * Returns the authenticated user's per-user Settings schema + connection
 * status for an installed app. Owner-only app-wide settings stay on /a/:id.
 */
async function handleGetUserSettings(
  request: Request,
  appId: string,
): Promise<Response> {
  let user;
  try {
    user = await authenticate(request);
  } catch {
    return error("Authentication required", 401);
  }

  const appsService = createAppsService();
  const app = await appsService.findById(appId);
  if (!app) {
    return error("App not found", 404);
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
  };

  try {
    const isOwner = app.owner_id === user.id;
    let inLibrary = false;

    if (!isOwner) {
      const libRes = await fetch(
        `${supabaseUrl}/rest/v1/user_app_library?user_id=eq.${user.id}&app_id=eq.${appId}&select=app_id&limit=1`,
        { headers },
      );
      const libRows = libRes.ok
        ? await libRes.json() as Array<{ app_id: string }>
        : [];
      inLibrary = libRows.length > 0;
      if (!inLibrary) {
        return error("Install this app to configure your own settings", 403);
      }
    }

    const resolvedSchema = resolveAppEnvSchema(app);
    const universalSettings = getScopedEnvSchemaEntries(
      resolvedSchema,
      "universal",
    );

    const secretsRes = await fetch(
      `${supabaseUrl}/rest/v1/user_app_secrets?user_id=eq.${user.id}&app_id=eq.${appId}&select=key,updated_at`,
      { headers },
    );
    const secretRows = secretsRes.ok
      ? await secretsRes.json() as UserAppSecretRow[]
      : [];
    const perUserStatus = buildPerUserSettingsStatus(
      resolvedSchema,
      secretRows,
    );
    const requiredKeys = perUserStatus.settings
      .filter((setting) => setting.required)
      .map((setting) => setting.key);
    const diagnostics = buildAppSecretDiagnostics({
      appId: app.id,
      declaredKeys: perUserStatus.settings.map((setting) => setting.key),
      requiredKeys,
      connectedKeys: perUserStatus.connectedKeys,
      missingRequired: perUserStatus.missingRequired,
    });

    return json({
      app_id: app.id,
      app_name: app.name,
      inLibrary,
      isOwner,
      app_settings_count: universalSettings.length,
      owner_manage_url: isOwner ? `/a/${app.id}` : null,
      settings: perUserStatus.settings,
      connected_keys: perUserStatus.connectedKeys,
      missing_required: perUserStatus.missingRequired,
      fully_connected: perUserStatus.fullyConnected,
      diagnostics,
    });
  } catch (err) {
    console.error("[app-settings:get] failed:", err);
    return error("Failed to load app settings", 500);
  }
}

/**
 * PUT /api/apps/:appId/settings
 *
 * Upserts the authenticated user's per-user Settings values.
 */
async function handleUpdateUserSettings(
  request: Request,
  appId: string,
): Promise<Response> {
  let user;
  try {
    user = await authenticate(request);
  } catch {
    return error("Authentication required", 401);
  }

  return withSensitiveRouteRateLimit(
    user.id,
    "apps:user_settings_update",
    async () => {
      const appsService = createAppsService();
      const app = await appsService.findById(appId);
      if (!app) {
        return error("App not found", 404);
      }

      const supabaseUrl = getEnv("SUPABASE_URL");
      const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
      const headers = {
        "apikey": supabaseKey,
        "Authorization": `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
      };

      try {
        const isOwner = app.owner_id === user.id;
        if (!isOwner) {
          const libRes = await fetch(
            `${supabaseUrl}/rest/v1/user_app_library?user_id=eq.${user.id}&app_id=eq.${appId}&select=app_id&limit=1`,
            { headers },
          );
          const libRows = libRes.ok
            ? await libRes.json() as Array<{ app_id: string }>
            : [];
          if (libRows.length === 0) {
            return error(
              "Install this app to configure your own settings",
              403,
            );
          }
        }

        const resolvedSchema = resolveAppEnvSchema(app);
        if (
          getScopedEnvSchemaEntries(resolvedSchema, "per_user").length === 0
        ) {
          return error("This app has no per-user settings", 400);
        }

        const body = await request.json() as { values?: unknown };
        const values = body.values;
        if (!values || typeof values !== "object" || Array.isArray(values)) {
          return error("values object is required", 400);
        }

        const valuesRecord = values as Record<string, unknown>;
        const entries = Object.entries(valuesRecord);
        if (entries.length === 0) {
          return error("Provide at least one setting to update", 400);
        }

        const validation = validatePerUserSettingsValues(
          resolvedSchema,
          valuesRecord,
        );
        const validationErrors = validation.errors;

        if (validationErrors.length > 0) {
          return json({ success: false, errors: validationErrors }, 400);
        }

        const updatedAt = new Date().toISOString();
        const keysSaved: string[] = [];
        const keysRemoved: string[] = [];

        for (const [key, value] of validation.entries) {
          if (value === null) {
            const deleteRes = await fetch(
              `${supabaseUrl}/rest/v1/user_app_secrets?user_id=eq.${user.id}&app_id=eq.${app.id}&key=eq.${
                encodeURIComponent(key)
              }`,
              { method: "DELETE", headers },
            );
            if (!deleteRes.ok) {
              return error(`Failed to clear setting "${key}"`, 500);
            }
            keysRemoved.push(key);
            continue;
          }

          const encryptedValue = await encryptEnvVar(value);
          const upsertRes = await fetch(
            `${supabaseUrl}/rest/v1/user_app_secrets`,
            {
              method: "POST",
              headers: {
                ...headers,
                "Prefer": "resolution=merge-duplicates",
              },
              body: JSON.stringify({
                user_id: user.id,
                app_id: app.id,
                key,
                value_encrypted: encryptedValue,
                updated_at: updatedAt,
              }),
            },
          );

          if (!upsertRes.ok) {
            return error(`Failed to save setting "${key}"`, 500);
          }

          keysSaved.push(key);
        }

        const secretsRes = await fetch(
          `${supabaseUrl}/rest/v1/user_app_secrets?user_id=eq.${user.id}&app_id=eq.${appId}&select=key,updated_at`,
          { headers },
        );
        const secretRows = secretsRes.ok
          ? await secretsRes.json() as UserAppSecretRow[]
          : [];
        const perUserStatus = buildPerUserSettingsStatus(
          resolvedSchema,
          secretRows,
        );
        const requiredKeys = perUserStatus.settings
          .filter((setting) => setting.required)
          .map((setting) => setting.key);
        const diagnostics = buildAppSecretDiagnostics({
          appId: app.id,
          declaredKeys: perUserStatus.settings.map((setting) => setting.key),
          requiredKeys,
          connectedKeys: perUserStatus.connectedKeys,
          missingRequired: perUserStatus.missingRequired,
        });

        return json({
          success: true,
          keys_saved: keysSaved,
          keys_removed: keysRemoved,
          connected_keys: perUserStatus.connectedKeys,
          missing_required: perUserStatus.missingRequired,
          fully_connected: perUserStatus.fullyConnected,
          diagnostics,
        });
      } catch (err) {
        console.error("[app-settings:update] failed:", err);
        return error("Failed to update app settings", 500);
      }
    },
  );
}

// ============================================
// App Store Listing Screenshot Handlers
// ============================================

/** Max screenshots per app. Client UI enforces this too. */
const MAX_SCREENSHOTS = 6;
/** Max screenshot file size. */
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * POST /api/apps/:appId/screenshots — Owner uploads a new screenshot.
 *
 * Multipart form with field "screenshot". Appends to apps.screenshots JSONB
 * array. Rejects if app already has MAX_SCREENSHOTS. R2 key includes a
 * timestamp so replacing/reordering doesn't hit a stale CDN cache.
 *
 * Returns the updated screenshots array so the client can re-render the grid.
 */
async function handleUploadScreenshot(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();
    const r2Service = createR2Service();

    const app = await appsService.findById(appId);
    if (!app) return error("App not found", 404);
    if (app.owner_id !== user.id) return error("Unauthorized", 403);

    const existing = Array.isArray(app.screenshots) ? app.screenshots : [];
    if (existing.length >= MAX_SCREENSHOTS) {
      return error(`Maximum ${MAX_SCREENSHOTS} screenshots per app`, 400);
    }

    const formData = await request.formData();
    const file = formData.get("screenshot") as File | null;
    if (!file) return error("No screenshot file provided", 400);

    const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      return error("Invalid file type. Use PNG, JPG, or WebP.", 400);
    }
    if (file.size > MAX_SCREENSHOT_BYTES) {
      return error(
        `Screenshot must be less than ${MAX_SCREENSHOT_BYTES / 1024 / 1024}MB`,
        400,
      );
    }

    const ext = file.type === "image/png"
      ? "png"
      : file.type === "image/jpeg"
      ? "jpg"
      : "webp";
    // Timestamped key busts cache when files rotate. Index in key is purely
    // informational — the authoritative order comes from the JSONB array.
    const ts = Date.now();
    const newIndex = existing.length;
    const key = `apps/${appId}/media/screenshot-${newIndex}-${ts}.${ext}`;

    const content = new Uint8Array(await file.arrayBuffer());
    await r2Service.uploadFile(key, {
      name: `screenshot-${newIndex}.${ext}`,
      content,
      contentType: file.type,
    });

    const updated = [...existing, key];
    await appsService.update(appId, { screenshots: updated });

    return json({ screenshots: updated });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("[screenshots] upload failed:", err);
    return error("Failed to upload screenshot", 500);
  }
}

/**
 * DELETE /api/apps/:appId/screenshots/:index — Owner removes a screenshot.
 *
 * Deletes the R2 object best-effort and removes the entry from the JSONB
 * array. R2 cleanup failure is logged but doesn't fail the request — the
 * DB is the source of truth.
 */
async function handleDeleteScreenshot(
  request: Request,
  appId: string,
  index: number,
): Promise<Response> {
  try {
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();
    const r2Service = createR2Service();

    const app = await appsService.findById(appId);
    if (!app) return error("App not found", 404);
    if (app.owner_id !== user.id) return error("Unauthorized", 403);

    const existing = Array.isArray(app.screenshots) ? app.screenshots : [];
    if (!Number.isInteger(index) || index < 0 || index >= existing.length) {
      return error("Screenshot index out of range", 400);
    }

    const keyToDelete = existing[index];
    const updated = existing.filter((_, i) => i !== index);
    await appsService.update(appId, { screenshots: updated });

    // Best-effort R2 cleanup — don't block the response on it.
    if (typeof keyToDelete === "string") {
      r2Service.deleteFile(keyToDelete).catch((cleanupErr) =>
        console.warn(
          "[screenshots] R2 cleanup failed for",
          keyToDelete,
          cleanupErr,
        )
      );
    }

    return json({ screenshots: updated });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("[screenshots] delete failed:", err);
    return error("Failed to delete screenshot", 500);
  }
}

/**
 * PUT /api/apps/:appId/screenshots/order — Owner reorders screenshots.
 *
 * Body: { order: number[] } — a permutation of the current indices.
 * Must contain exactly the existing indices (0..n-1) once each. We rebuild
 * the array in the new order and PATCH the app record.
 */
async function handleReorderScreenshots(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();

    const app = await appsService.findById(appId);
    if (!app) return error("App not found", 404);
    if (app.owner_id !== user.id) return error("Unauthorized", 403);

    const body = await request.json() as { order?: unknown };
    const order = body.order;
    if (!Array.isArray(order)) {
      return error("order must be an array of numbers", 400);
    }

    const existing = Array.isArray(app.screenshots) ? app.screenshots : [];
    if (order.length !== existing.length) {
      return error("order length must match existing screenshot count", 400);
    }

    // Validate: must be a permutation of [0..n-1]
    const seen = new Set<number>();
    for (const idx of order) {
      if (
        typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 ||
        idx >= existing.length
      ) {
        return error("order contains invalid index", 400);
      }
      if (seen.has(idx)) return error("order contains duplicate index", 400);
      seen.add(idx);
    }

    const updated = (order as number[]).map((i) => existing[i]);
    await appsService.update(appId, { screenshots: updated });

    return json({ screenshots: updated });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("[screenshots] reorder failed:", err);
    return error("Failed to reorder screenshots", 500);
  }
}

/**
 * GET /api/apps/:appId/screenshots/:index — Serve a screenshot by its index.
 *
 * Public for public/unlisted apps; private apps require owner auth.
 * R2 keys are timestamped so we can serve with a long immutable cache —
 * when the developer replaces a screenshot the key changes.
 */
async function handleGetScreenshot(
  request: Request,
  appId: string,
  index: number,
): Promise<Response> {
  try {
    const r2Service = createR2Service();
    const { app } = await resolvePublicAppAccess(request, appId, {
      allowPrivateOwner: true,
    });
    if (!app) return error("Not found", 404);

    const screenshots = Array.isArray(app.screenshots) ? app.screenshots : [];
    if (!Number.isInteger(index) || index < 0 || index >= screenshots.length) {
      return error("Screenshot not found", 404);
    }

    const key = screenshots[index];
    if (typeof key !== "string") return error("Screenshot not found", 404);

    // Infer content type from the file extension embedded in the key.
    const extMatch = key.match(/\.(png|jpg|jpeg|webp)$/i);
    const contentType = extMatch && extMatch[1].toLowerCase() === "png"
      ? "image/png"
      : extMatch && extMatch[1].toLowerCase() === "webp"
      ? "image/webp"
      : "image/jpeg";

    let content: Uint8Array;
    try {
      content = await r2Service.fetchFile(key);
    } catch {
      return error("Screenshot file missing", 404);
    }

    // Use the R2 key as an ETag so replacements bust cache naturally even
    // though the URL stays the same (URL is index-based, R2 key has a
    // timestamp). Short max-age keeps dev iteration snappy.
    const etag = '"' + key.split("/").pop() + '"';
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { "ETag": etag } });
    }

    return new Response(toResponseBody(content), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=300, must-revalidate",
        "ETag": etag,
      },
    });
  } catch (err) {
    console.error("[screenshots] get failed:", err);
    return error("Failed to get screenshot", 500);
  }
}

/**
 * Extract function count from an app record.
 */
function getFnCount(
  app: { manifest: unknown; skills_parsed: unknown; exports: string[] | null },
): number {
  return resolveAppFunctionContracts({
    slug: "library-app",
    manifest: app.manifest,
    skills_parsed: app.skills_parsed,
    exports: app.exports,
  }, {
    allowLegacySkills: true,
    allowLegacyExports: true,
    allowGpuExports: isGpuSupportEnabled(),
  }).functions.length;
}

/**
 * Generate agent-ready instruction block for an app.
 * Public endpoint — no auth required for public apps.
 */
async function handleGetAppInstructions(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const { app } = await resolvePublicAppAccess(request, appId, {
      allowPrivateOwner: true,
    });
    if (!app) {
      return error("App not found", 404);
    }

    const name = app.name || app.slug || "Untitled";
    const desc = app.description || "";

    // Build the function list from canonical manifest contracts.
    const fnLines: string[] = [];
    const contractResolution = resolveAppFunctionContracts({
      slug: app.slug,
      runtime: app.runtime,
      manifest: app.manifest,
      skills_parsed: app.skills_parsed,
      exports: app.exports,
    }, {
      allowLegacySkills: true,
      allowLegacyExports: true,
      allowGpuExports: isGpuSupportEnabled(),
    });

    for (const fn of contractResolution.functions) {
      try {
        let paramStr = "";
        const normalizedParams = normalizeManifestParameters(fn.parameters);
        if (normalizedParams) {
          paramStr = Object.entries(normalizedParams)
            .map(([pName, pMeta]) =>
              `${pName}${pMeta.required === false ? "?" : ""}: ${
                pMeta.type || "any"
              }`
            ).join(", ");
        }
        const fnDesc = fn.description ? ` — ${fn.description}` : "";
        fnLines.push(
          `- ${fn.name}(${paramStr ? `{ ${paramStr} }` : ""})${fnDesc}`,
        );
      } catch (fnErr) {
        console.warn(
          `[INSTRUCTIONS] Error parsing function ${fn.name}:`,
          fnErr,
        );
        fnLines.push(`- ${fn.name}()`);
      }
    }

    const firstFn = fnLines.length > 0
      ? contractResolution.functions[0]?.name || "main"
      : "main";

    // Derive base URL from request
    const proto = request.headers.get("x-forwarded-proto") || "https";
    const host = request.headers.get("host") ||
      "api.connectgalactic.com";
    const baseUrl = `${proto}://${host}`;

    const sections: string[] = [];

    // Header
    sections.push(`# ${name} — Galactic MCP App`);
    if (desc) sections.push(desc);

    // Functions
    if (fnLines.length > 0) {
      sections.push(`## Available Functions\n${fnLines.join("\n")}`);
    }

    if (!contractResolution.manifestBacked && contractResolution.message) {
      sections.push(`## Contract Status\n${contractResolution.message}`);
    }

    // Connection: Platform gateway (for agents already connected to Galactic)
    sections.push(
      `## Connect & Use\n\n` +
        `**Option A — If already connected to Galactic:**\n` +
        `gx.call({ app_id: "${appId}", function_name: "${firstFn}", args: {} })\n\n` +
        `**Option B — Direct MCP (any HTTP agent):**\n` +
        `POST ${baseUrl}/mcp/${appId}\n` +
        `Authorization: Bearer {TOKEN}\n` +
        `Content-Type: application/json\n\n` +
        `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${firstFn}","arguments":{}}}`,
    );

    const httpRoutes = buildHttpRouteCatalog(app, { baseUrl });
    if (httpRoutes.length > 0) {
      sections.push(
        `## Direct HTTP Routes\n\n` +
          httpRoutes.map(formatHttpRouteCatalogLine).join("\n") +
          `\n\nPublic routes do not require an Galactic token. Authenticated routes require \`Authorization: Bearer {TOKEN}\`.`,
      );
    }

    // Documentation link
    sections.push(
      `## Full Documentation\n${baseUrl}/api/apps/${appId}/skills.md`,
    );

    const instructions = sections.join("\n\n");
    return json({ instructions });
  } catch (err) {
    console.error("[APPS] handleGetAppInstructions failed:", err);
    return error("Failed to generate instructions", 500);
  }
}

/**
 * Get a safe direct HTTP route catalog for an app.
 *
 * Public/unlisted apps expose only manifest-declared route policy, not the raw
 * manifest. Private apps require the owner and return the same shape.
 */
async function handleGetHttpRoutes(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const { app, isOwner } = await resolvePublicAppAccess(request, appId, {
      allowPrivateOwner: true,
      requireFullOwnerApp: true,
    });

    if (!app) {
      return error("App not found", 404);
    }

    if (!isOwner && shouldHideGpuApp(app)) {
      return error("App not found", 404);
    }

    const baseUrl = getRequestBaseUrl(request);
    return json({
      app_id: app.id,
      is_owner: isOwner,
      base_url: baseUrl,
      routes: buildHttpRouteCatalog(app, { baseUrl }),
    });
  } catch (err) {
    appsLogger.error("Failed to get HTTP route catalog", {
      app_id: appId,
      error: err,
    });
    return error("Failed to get HTTP route catalog", 500);
  }
}

/**
 * Get app details
 */
async function handleGetApp(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const appsService = createAppsService();
    const publicApp = await appsService.findPublicById(appId);

    let userId: string | null = null;
    try {
      const user = await authenticate(request);
      userId = user.id;
    } catch {
      userId = null;
    }

    if (publicApp) {
      if (userId && publicApp.owner_id === userId) {
        const ownerApp = await appsService.findById(appId);
        if (!ownerApp) return error("App not found", 404);
        const baseUrl = getRequestBaseUrl(request);
        return json({
          ...withOwnerTrustCard(ownerApp),
          http_routes: buildHttpRouteCatalog(ownerApp, { baseUrl }),
        });
      }

      const servingApp = await appsService.findPublicServingById(appId);
      if (!isGpuSupportEnabled()) {
        if (servingApp && shouldHideGpuApp(servingApp)) {
          return error("App not found", 404);
        }
      }

      const baseUrl = getRequestBaseUrl(request);
      return json({
        ...publicApp,
        http_routes: servingApp
          ? buildHttpRouteCatalog(servingApp, { baseUrl })
          : [],
      });
    }

    if (!userId) {
      return error("App not found", 404);
    }

    const ownerApp = await appsService.findById(appId);
    if (
      !ownerApp || ownerApp.owner_id !== userId ||
      ownerApp.visibility !== "private"
    ) {
      return error("App not found", 404);
    }

    const baseUrl = getRequestBaseUrl(request);
    return json({
      ...withOwnerTrustCard(ownerApp),
      http_routes: buildHttpRouteCatalog(ownerApp, { baseUrl }),
    });
  } catch (err) {
    appsLogger.error("Failed to get app", { app_id: appId, error: err });
    return error("Failed to get app", 500);
  }
}

/**
 * Get app code for client-side execution
 */
async function handleGetAppCode(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    appsLogger.debug("Fetching app code", { app_id: appId });
    const r2Service = createR2Service();
    const { app } = await resolvePublicAppAccess(request, appId, {
      allowPrivateOwner: true,
    });
    appsLogger.debug("Resolved app access for code fetch", {
      app_id: appId,
      found: !!app,
      visibility: app?.visibility,
    });

    if (!app) {
      appsLogger.debug("App code fetch found no app record", { app_id: appId });
      return error("App not found", 404);
    }

    // Fetch code from R2 - try different entry file extensions
    const storageKey = app.storage_key;
    appsLogger.debug("Fetching app code from storage", {
      app_id: appId,
      storage_key: storageKey,
    });
    let code: string | null = null;

    // Try entry files in order of preference: tsx, ts, jsx, js
    const entryFiles = ["index.tsx", "index.ts", "index.jsx", "index.js"];
    for (const entryFile of entryFiles) {
      try {
        code = await r2Service.fetchTextFile(`${storageKey}${entryFile}`);
        appsLogger.debug("Loaded app entry file from storage", {
          app_id: appId,
          entry_file: entryFile,
          code_length: code?.length ?? 0,
        });
        break;
      } catch {
        appsLogger.debug("App entry file missing; trying next candidate", {
          app_id: appId,
          entry_file: entryFile,
        });
      }
    }

    if (!code) {
      appsLogger.warn("No entry file found for app code fetch", {
        app_id: appId,
        storage_key: storageKey,
      });
      return error("App code not found", 404);
    }

    // Generate ETag for code endpoint caching
    const version = app.current_version || "0";
    const updated = app.updated_at || "0";
    let hashVal = 0;
    const hashStr = `code:${version}:${updated}:${app.storage_key}`;
    for (let i = 0; i < hashStr.length; i++) {
      const char = hashStr.charCodeAt(i);
      hashVal = ((hashVal << 5) - hashVal) + char;
      hashVal = hashVal & hashVal;
    }
    const codeEtag = `"code-${Math.abs(hashVal).toString(36)}"`;

    // Check If-None-Match for 304
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (
      ifNoneMatch &&
      (ifNoneMatch === codeEtag || ifNoneMatch === `W/${codeEtag}`)
    ) {
      return new Response(null, {
        status: 304,
        headers: { "ETag": codeEtag, "Cache-Control": "public, max-age=3600" },
      });
    }

    return new Response(
      JSON.stringify({
        code,
        name: app.name || app.slug,
        appId: app.id,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
          "ETag": codeEtag,
          "Vary": "Accept-Encoding",
        },
      },
    );
  } catch (err) {
    console.error("Failed to get app code:", err);
    return error("Failed to get app code", 500);
  }
}

/**
 * Update app settings
 */
async function handleUpdateApp(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user: EmbeddingUser = await authenticate(request);
    return withSensitiveRouteRateLimit(user.id, "apps:update_app", async () => {
      const appsService = createAppsService();

      const app = await appsService.findById(appId);

      if (!app) {
        return error("App not found", 404);
      }

      // Only owner can update
      if (app.owner_id !== user.id) {
        return error("Unauthorized", 403);
      }

      const updates = await readJsonObject(request);

      // Whitelist allowed updates
      const allowedFields = [
        "name",
        "description",
        "visibility",
        "icon_url",
        "tags",
        "category",
        "download_access",
        "pricing_config",
        "gpu_pricing_config",
        "long_description",
      ];
      const filteredUpdates: Record<string, unknown> = {};
      let liveVersionStorageBytes: number | null = null;
      let requestedLiveVersion: string | null = null;

      for (const field of allowedFields) {
        if (field in updates) {
          filteredUpdates[field] = updates[field];
        }
      }

      // long_description is markdown, nullable, and capped at 50KB
      if ("long_description" in filteredUpdates) {
        const ld = filteredUpdates.long_description;
        if (ld !== null && typeof ld !== "string") {
          return error("long_description must be a string or null", 400);
        }
        if (typeof ld === "string" && ld.length > 50000) {
          return error("long_description exceeds 50KB limit", 400);
        }
      }

      if ("current_version" in updates) {
        if (
          typeof updates.current_version !== "string" ||
          updates.current_version.trim().length === 0
        ) {
          return error("current_version must be a non-empty string", 400);
        }

        requestedLiveVersion = updates.current_version.trim();
        if (requestedLiveVersion !== app.current_version) {
          if (!app.versions?.includes(requestedLiveVersion)) {
            return error(`Version "${requestedLiveVersion}" not found`, 404);
          }

          if (app.visibility !== "private") {
            const readinessError = await publisherPublishReadinessResponse(
              user.id,
              {
                visibility: app.visibility,
                appConnectGateExempt: app.connect_gate_exempt,
              },
            );
            if (readinessError) return readinessError;
          }

          const r2Service = createR2Service();
          const versionStorageKey = `apps/${appId}/${requestedLiveVersion}/`;
          let manifestJson: string | null = null;
          try {
            manifestJson = await r2Service.fetchTextFile(
              `${versionStorageKey}manifest.json`,
            );
            const manifest = JSON.parse(manifestJson);
            filteredUpdates.manifest = manifestJson;
            filteredUpdates.env_schema = resolveManifestEnvSchema(manifest);
          } catch {
            manifestJson = null;
          }

          const versionExports = await resolveStoredVersionExports(
            versionStorageKey,
            r2Service,
            manifestJson,
          );
          if (versionExports) {
            filteredUpdates.exports = versionExports;
          }

          liveVersionStorageBytes = await resolveStoredVersionStorageBytes(
            app,
            requestedLiveVersion,
            versionStorageKey,
            r2Service,
          );
          filteredUpdates.current_version = requestedLiveVersion;
          filteredUpdates.storage_key = versionStorageKey;
        }
      }

      if (Object.keys(filteredUpdates).length === 0) {
        return error("No valid fields to update", 400);
      }

      // Gate visibility changes by tier and the configured publisher balance rule.
      if ("visibility" in filteredUpdates) {
        const userTier = await getUserTier(user.id);
        const visibilityErr = checkVisibilityAllowed(
          userTier,
          filteredUpdates.visibility as "private" | "unlisted" | "public",
        );
        if (visibilityErr) {
          return error(visibilityErr, 403);
        }
        if (filteredUpdates.visibility !== "private") {
          const readinessError = await publisherPublishReadinessResponse(
            user.id,
            {
              visibility: filteredUpdates.visibility as "public" | "unlisted",
              appConnectGateExempt: app.connect_gate_exempt,
            },
          );
          if (readinessError) return readinessError;
        }

        // Set per-app billing clock when transitioning from private to published
        if (
          filteredUpdates.visibility !== "private" &&
          app.visibility === "private"
        ) {
          filteredUpdates.hosting_last_billed_at = new Date().toISOString();
        }
      }

      // Validate pricing_config structure if provided
      if ("pricing_config" in filteredUpdates) {
        const pc = filteredUpdates.pricing_config;
        if (pc !== null) {
          const cfg = pc as Record<string, unknown>;
          if (typeof cfg !== "object" || Array.isArray(cfg)) {
            return error("pricing_config must be an object or null", 400);
          }
          if (cfg.default_price_light !== undefined) {
            if (
              typeof cfg.default_price_light !== "number" ||
              cfg.default_price_light < 0 || cfg.default_price_light > 10000
            ) {
              return error(
                "default_price_light must be 0-10000 (max ✦10000 per call)",
                400,
              );
            }
          }
          if (cfg.default_free_calls !== undefined) {
            if (
              typeof cfg.default_free_calls !== "number" ||
              cfg.default_free_calls < 0 ||
              !Number.isInteger(cfg.default_free_calls) ||
              cfg.default_free_calls > 1000000
            ) {
              return error(
                "default_free_calls must be a non-negative integer up to 1,000,000",
                400,
              );
            }
          }
          if (cfg.default_skill_pull_price_light !== undefined) {
            if (
              typeof cfg.default_skill_pull_price_light !== "number" ||
              cfg.default_skill_pull_price_light < 0 ||
              cfg.default_skill_pull_price_light > 10000
            ) {
              return error(
                "default_skill_pull_price_light must be 0-10000 (max ✦10000 per pull)",
                400,
              );
            }
          }
          if (cfg.default_free_skill_pulls !== undefined) {
            if (
              typeof cfg.default_free_skill_pulls !== "number" ||
              cfg.default_free_skill_pulls < 0 ||
              !Number.isInteger(cfg.default_free_skill_pulls) ||
              cfg.default_free_skill_pulls > 1000000
            ) {
              return error(
                "default_free_skill_pulls must be a non-negative integer up to 1,000,000",
                400,
              );
            }
          }
          if (cfg.free_calls_scope !== undefined) {
            if (
              cfg.free_calls_scope !== "app" &&
              cfg.free_calls_scope !== "function"
            ) {
              return error('free_calls_scope must be "app" or "function"', 400);
            }
          }
          if (cfg.functions !== undefined) {
            if (
              typeof cfg.functions !== "object" || cfg.functions === null ||
              Array.isArray(cfg.functions)
            ) {
              return error(
                "pricing_config.functions must be an object mapping function names to prices",
                400,
              );
            }
            for (
              const [fn, val] of Object.entries(
                cfg.functions as Record<string, unknown>,
              )
            ) {
              if (typeof val === "number") {
                // Legacy format: plain number (Light)
                if (val < 0 || val > 10000) {
                  return error(`Price for "${fn}" must be 0-10000 Light`, 400);
                }
              } else if (
                typeof val === "object" && val !== null && !Array.isArray(val)
              ) {
                // New format: FunctionPricing object
                const fp = val as Record<string, unknown>;
                if (
                  typeof fp.price_light !== "number" || fp.price_light < 0 ||
                  fp.price_light > 10000
                ) {
                  return error(
                    `price_light for "${fn}" must be 0-10000 Light`,
                    400,
                  );
                }
                if (fp.free_calls !== undefined) {
                  if (
                    typeof fp.free_calls !== "number" || fp.free_calls < 0 ||
                    !Number.isInteger(fp.free_calls) || fp.free_calls > 1000000
                  ) {
                    return error(
                      `free_calls for "${fn}" must be a non-negative integer up to 1,000,000`,
                      400,
                    );
                  }
                }
              } else {
                return error(
                  `Price for "${fn}" must be a number or { price_light, free_calls? }`,
                  400,
                );
              }
            }
          }
          if (cfg.skills !== undefined) {
            if (
              typeof cfg.skills !== "object" || cfg.skills === null ||
              Array.isArray(cfg.skills)
            ) {
              return error(
                "pricing_config.skills must be an object mapping skill ids to prices",
                400,
              );
            }
            for (
              const [skill, val] of Object.entries(
                cfg.skills as Record<string, unknown>,
              )
            ) {
              if (typeof val === "number") {
                if (val < 0 || val > 10000) {
                  return error(
                    `Skill price for "${skill}" must be 0-10000 Light`,
                    400,
                  );
                }
              } else if (
                typeof val === "object" && val !== null && !Array.isArray(val)
              ) {
                const sp = val as Record<string, unknown>;
                if (
                  typeof sp.price_light !== "number" || sp.price_light < 0 ||
                  sp.price_light > 10000
                ) {
                  return error(
                    `skill price_light for "${skill}" must be 0-10000 Light`,
                    400,
                  );
                }
                if (sp.free_pulls !== undefined) {
                  if (
                    typeof sp.free_pulls !== "number" || sp.free_pulls < 0 ||
                    !Number.isInteger(sp.free_pulls) || sp.free_pulls > 1000000
                  ) {
                    return error(
                      `free_pulls for "${skill}" must be a non-negative integer up to 1,000,000`,
                      400,
                    );
                  }
                }
              } else {
                return error(
                  `Skill price for "${skill}" must be a number or { price_light, free_pulls? }`,
                  400,
                );
              }
            }
          }
        }
      }

      if ("gpu_pricing_config" in filteredUpdates) {
        if (!isGpuSupportEnabled()) {
          return error(getGpuSupportDisabledMessage("GPU pricing"), 403);
        }
        if (app.runtime !== "gpu") {
          return error("gpu_pricing_config can only be set on GPU apps", 400);
        }
        const validation = validateGpuPricingConfig(
          filteredUpdates.gpu_pricing_config,
        );
        if (!validation.valid) {
          return error(validation.error || "Invalid gpu_pricing_config", 400);
        }
        filteredUpdates.gpu_pricing_config = validation.config;
      }

      const updatedApp = await appsService.update(appId, filteredUpdates);
      // Re-render the OG share card when a field shown on it changed (incl. a
      // private->public flip). No-op for non-public agents (gated in the renderer).
      if (
        updatedApp.name !== app.name ||
        updatedApp.description !== app.description ||
        updatedApp.visibility !== app.visibility
      ) {
        scheduleCaptureTask(renderAgentOgCard(updatedApp, { reason: "edit" }));
      }
      if (requestedLiveVersion && liveVersionStorageBytes !== null) {
        await recordUploadStorage(
          user.id,
          appId,
          requestedLiveVersion,
          liveVersionStorageBytes,
        );
      }

      return json(updatedApp);
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to update app:", err);
    return error("Failed to update app", 500);
  }
}

/**
 * Soft delete an app
 */
async function handleDeleteApp(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();

    const app = await appsService.findById(appId);

    if (!app) {
      return error("App not found", 404);
    }

    // Only owner can delete
    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    await reclaimAppStorage(user.id, appId);

    // Soft delete - set deleted_at timestamp
    await appsService.update(appId, {
      deleted_at: new Date().toISOString(),
    });

    // Rebuild user library to remove deleted app
    rebuildUserLibrary(user.id).catch((err) =>
      console.error("Library rebuild after delete failed:", err)
    );

    return json({ success: true, message: "App deleted" });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to delete app:", err);
    return error("Failed to delete app", 500);
  }
}

/**
 * Delete a specific app version
 * DELETE /api/apps/:appId/versions/:version
 *
 * Removes non-live version files from R2 and version metadata.
 * Cannot delete the current (active) version.
 */
async function handleDeleteVersion(
  request: Request,
  appId: string,
  version: string,
): Promise<Response> {
  try {
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();
    const r2Service = createR2Service();

    const app = await appsService.findById(appId);

    if (!app) {
      return error("App not found", 404);
    }

    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    // Cannot delete the current active version
    if (app.current_version === version) {
      return error(
        "Cannot delete the current active version. Deploy a new version first.",
        400,
      );
    }

    // Check version exists
    if (!app.versions?.includes(version)) {
      return error(`Version "${version}" not found`, 404);
    }

    // Delete version files from R2 (fire-and-forget)
    const versionStorageKey = `apps/${appId}/${version}/`;
    try {
      const versionFiles = await r2Service.listFiles(versionStorageKey);
      for (const fileKey of versionFiles) {
        await r2Service.deleteFile(fileKey);
      }
      console.log(
        `[DELETE_VERSION] Cleaned up ${versionFiles.length} files for ${appId}/${version}`,
      );
    } catch (cleanupErr) {
      console.error(
        `[DELETE_VERSION] R2 cleanup failed for ${appId}/${version}:`,
        cleanupErr,
      );
      // Non-fatal. Non-live versions do not change live storage billing.
    }

    await appsService.update(appId, {
      versions: (app.versions || []).filter((entry) => entry !== version),
      version_metadata: Array.isArray(app.version_metadata)
        ? app.version_metadata.filter((entry) => entry?.version !== version)
        : [],
    });

    return json({
      success: true,
      version_deleted: version,
      message: `Version ${version} deleted.`,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to delete version:", err);
    return error("Failed to delete version", 500);
  }
}

/**
 * Upload app icon
 */
function canonicalIconUrl(
  appId: string,
  extension: IconExtension,
  version: string,
): string {
  return `/api/apps/${encodeURIComponent(appId)}/icon?format=${extension}&v=${version}`;
}

async function fetchOrPromoteVersionedIcon(
  r2: R2Service,
  appId: string,
  extension: IconExtension,
  version: string,
  allowLegacyPromotion: boolean,
): Promise<Uint8Array | null> {
  const versionedKey = versionedIconObjectKey(appId, extension, version);
  try {
    return await r2.fetchFile(versionedKey);
  } catch {
    if (!allowLegacyPromotion) return null;
  }

  // Deployments before content-addressed R2 keys wrote a version into the URL
  // while still storing bytes at icon.<ext>. Promote only after checking that
  // those bytes actually hash to the requested version. A stale mutable object
  // can therefore never impersonate an immutable URL.
  try {
    const legacyBytes = await r2.fetchFile(legacyIconObjectKey(appId, extension));
    const computedVersion = await iconContentVersion(legacyBytes);
    if (
      computedVersion !== version &&
      !(version.length === 16 && computedVersion.startsWith(version))
    ) return null;
    await r2.uploadFile(versionedKey, {
      name: `${version}.${extension}`,
      content: legacyBytes,
      contentType: iconContentType(extension),
    });
    return legacyBytes;
  } catch {
    return null;
  }
}

function iconResponse(
  bytes: Uint8Array,
  extension: IconExtension,
  isPrivate: boolean,
  immutable: boolean,
): Response {
  const headers = new Headers({
    "Content-Type": iconContentType(extension),
    "Cache-Control": isPrivate
      ? "private, no-store"
      : immutable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  if (isPrivate) headers.set("Vary", "Authorization, Cookie");
  return new Response(toResponseBody(bytes), { headers });
}

async function handleUploadIcon(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();
    const r2Service = createR2Service();

    const app = await appsService.findById(appId);

    if (!app) {
      return error("App not found", 404);
    }

    // Only owner can upload icon
    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    // Parse multipart form data
    const formData = await request.formData();
    const iconFile = formData.get("icon") as File | null;

    if (!iconFile) {
      return error("No icon file provided", 400);
    }

    const maxBytes = iconFile.type === "image/gif" ? 2 * 1024 * 1024 : 1024 * 1024;
    if (iconFile.size > maxBytes) {
      return error(
        iconFile.type === "image/gif"
          ? "Animated icons must be less than 2MB"
          : "Icon must be less than 1MB",
        400,
      );
    }

    // Trust decoded bytes, never the multipart MIME claim. Validation also
    // bounds dimensions and GIF frame count before a browser ever decodes it.
    const content = new Uint8Array(await iconFile.arrayBuffer());
    let validated: ReturnType<typeof validateIconImage>;
    try {
      validated = validateIconImage(iconFile.type, content);
    } catch (validationError) {
      return error(
        validationError instanceof Error ? validationError.message : "Invalid icon image",
        400,
      );
    }
    const ext = validated.extension;
    const version = await iconContentVersion(content);
    const iconKey = versionedIconObjectKey(appId, ext, version);
    const previousReference = parseIconReference(app.icon_url);
    let previousVersionedKey: string | null = null;

    // Preserve the immediately previous pseudo-versioned URL when upgrading
    // from the old mutable object layout.
    if (previousReference?.extension && previousReference.version) {
      const previousBytes = await fetchOrPromoteVersionedIcon(
        r2Service,
        appId,
        previousReference.extension,
        previousReference.version,
        true,
      );
      if (previousBytes) {
        previousVersionedKey = versionedIconObjectKey(
          appId,
          previousReference.extension,
          previousReference.version,
        );
      }
    }

    await r2Service.uploadFile(iconKey, {
      name: `${version}.${ext}`,
      content,
      contentType: iconContentType(ext),
    });

    const iconUrl = canonicalIconUrl(appId, ext, version);

    // Update app record
    await appsService.update(appId, { icon_url: iconUrl });

    // Best-effort bounded history. Correctness never depends on cleanup: every
    // retained URL maps to exactly one content-addressed object, while removed
    // history returns 404 instead of silently serving replacement bytes.
    try {
      const prefix = `apps/${appId}/icons/`;
      const protectedKeys = new Set([iconKey]);
      if (previousVersionedKey) protectedKeys.add(previousVersionedKey);
      const versionedKeys = await r2Service.listFiles(prefix);
      await Promise.all(
        selectVersionedIconKeysForDeletion(versionedKeys, protectedKeys)
          .map((key) => r2Service.deleteFile(key)),
      );
      await Promise.all(
        ICON_EXTENSIONS.map((candidate) =>
          r2Service.deleteFile(legacyIconObjectKey(appId, candidate)).catch(() => {})
        ),
      );
    } catch (cleanupError) {
      console.warn("Failed to clean up historical icon objects:", cleanupError);
    }

    return json({
      success: true,
      icon_url: iconUrl,
      width: validated.width,
      height: validated.height,
      animated: ext === "gif" && validated.frameCount > 1,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to upload icon:", err);
    return error("Failed to upload icon", 500);
  }
}

/**
 * Serve app icon
 */
async function handleGetIcon(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const { app } = await resolvePublicAppAccess(request, appId, {
      allowPrivateOwner: true,
    });
    if (!app) {
      return error("Not found", 404);
    }

    const r2Service = createR2Service();
    const requestUrl = new URL(request.url);
    const requestedFormat = requestUrl.searchParams.get("format");
    const requestedVersion = requestUrl.searchParams.get("v");
    const currentReference = parseIconReference(app.icon_url);
    const isPrivate = app.visibility === "private";

    if (requestedFormat !== null || requestedVersion !== null) {
      if (
        !isIconExtension(requestedFormat) ||
        !isIconContentVersion(requestedVersion)
      ) {
        return error("Icon not found", 404);
      }
      const isCurrentReference = currentReference?.extension === requestedFormat &&
        currentReference.version === requestedVersion;
      const bytes = await fetchOrPromoteVersionedIcon(
        r2Service,
        appId,
        requestedFormat,
        requestedVersion,
        isCurrentReference,
      );
      if (!bytes) return error("Icon not found", 404);
      return iconResponse(bytes, requestedFormat, isPrivate, true);
    }

    if (currentReference?.extension && currentReference.version) {
      const headers = new Headers({
        "Location": canonicalIconUrl(
          appId,
          currentReference.extension,
          currentReference.version,
        ),
        "Cache-Control": isPrivate ? "private, no-store" : "public, max-age=300",
      });
      if (isPrivate) headers.set("Vary", "Authorization, Cookie");
      return new Response(null, { status: 302, headers });
    }

    // Mutable-key probing exists only for a persisted legacy, unversioned
    // reference. New and malformed references never fall through to it.
    if (!app.icon_url || !currentReference || currentReference.version !== null) {
      return error("Icon not found", 404);
    }
    const extensions: IconExtension[] = currentReference.extension
      ? [
        currentReference.extension,
        ...ICON_EXTENSIONS.filter((candidate) => candidate !== currentReference.extension),
      ]
      : [...ICON_EXTENSIONS];
    for (const extension of extensions) {
      try {
        const bytes = await r2Service.fetchFile(legacyIconObjectKey(appId, extension));
        return iconResponse(bytes, extension, isPrivate, false);
      } catch {
        // Try the next legacy format.
      }
    }
    return error("Icon not found", 404);
  } catch (err) {
    console.error("Failed to get icon:", err);
    return error("Failed to get icon", 500);
  }
}

/**
 * Serve the rendered per-agent OG share card — GET /og/:appId.png
 *
 * Public agents only (the card is the crawlable social preview). The PNG is
 * pre-rendered to R2 on edit/publish by services/og-card.ts. If it hasn't been
 * rendered yet, 302 to the icon so og:image always resolves to something. Short
 * max-age bounds staleness after a re-render without needing an ETag (the key
 * is stable and overwritten in place).
 */
const OG_APP_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleOgCard(
  request: Request,
  appId: string,
): Promise<Response> {
  // og:image URLs always carry the UUID app id; reject junk before hitting the
  // DB (a non-UUID would be a Postgres error -> 500).
  if (!OG_APP_ID_RE.test(appId)) {
    return error("Not found", 404);
  }
  try {
    const { app } = await resolvePublicAppAccess(request, appId, {
      allowPrivateOwner: false,
    });
    if (!app || app.visibility !== "public") {
      return error("Not found", 404);
    }

    const r2 = createR2Service();

    // 1. The rendered per-agent card (present once the agent has been
    //    created-public / published / edited so the render hook has fired).
    try {
      const png = await r2.fetchFile(ogCardKey(appId));
      return new Response(toResponseBody(png), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch { /* not rendered yet — fall through */ }

    // 2. The agent's uploaded icon, if any. Versioned references resolve only
    //    their exact object; mutable-key probing is reserved for persisted
    //    legacy references.
    const iconReference = parseIconReference(app.icon_url);
    if (iconReference?.extension && iconReference.version) {
      try {
        const bytes = await r2.fetchFile(
          versionedIconObjectKey(appId, iconReference.extension, iconReference.version),
        );
        return new Response(toResponseBody(bytes), {
          headers: {
            "Content-Type": iconContentType(iconReference.extension),
            "Cache-Control": "public, max-age=300",
          },
        });
      } catch { /* fall through to the generic card */ }
    } else if (app.icon_url && iconReference?.version === null) {
      const extensions: IconExtension[] = iconReference.extension
        ? [
          iconReference.extension,
          ...ICON_EXTENSIONS.filter((candidate) => candidate !== iconReference.extension),
        ]
        : [...ICON_EXTENSIONS];
      for (const extension of extensions) {
        try {
          const bytes = await r2.fetchFile(legacyIconObjectKey(appId, extension));
          return new Response(toResponseBody(bytes), {
            headers: {
              "Content-Type": iconContentType(extension),
              "Cache-Control": "public, max-age=300",
            },
          });
        } catch { /* try next legacy extension */ }
      }
    }

    // 3. Generic Galactic card — so og:image is never a broken link, even for
    //    agents that pre-date the renderer and have no icon.
    const base = getEnv("LAUNCH_WEB_BASE_URL") || "https://connectgalactic.com";
    return new Response(null, {
      status: 302,
      headers: {
        "Location": `${base}/og.png`,
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (err) {
    console.error("Failed to get OG card:", err);
    return error("Failed to get OG card", 500);
  }
}

/**
 * Download app code as zip
 */
async function handleDownloadCode(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const r2Service = createR2Service();
    const { app, isOwner } = await resolvePublicAppAccess(request, appId, {
      allowPrivateOwner: true,
      requireFullOwnerApp: true,
    });
    if (!app) {
      return error("App not found", 404);
    }

    // Check download access
    const downloadAccess = app.download_access || "owner";

    if (downloadAccess === "owner") {
      if (!isOwner) {
        try {
          const user = await authenticate(request);
          if (user.id !== app.owner_id) {
            return error("Download not allowed", 403);
          }
        } catch {
          return error("Authentication required", 401);
        }
      }
    }
    // If download_access is 'public', anyone can download

    // List all files in the app's storage
    const storageKey = app.storage_key;
    const fileKeys = await r2Service.listFiles(storageKey);

    if (fileKeys.length === 0) {
      return error("No files found", 404);
    }

    // Create a simple zip file manually (without external dependencies)
    // Using a basic ZIP format implementation
    const files: Array<{ name: string; content: Uint8Array }> = [];

    for (const key of fileKeys) {
      try {
        const content = await r2Service.fetchFile(key);
        // Remove the storage prefix from the filename
        const fileName = key.replace(storageKey, "");
        if (fileName) {
          files.push({ name: fileName, content });
        }
      } catch (e) {
        console.error(`Failed to fetch file ${key}:`, e);
      }
    }

    if (files.length === 0) {
      return error("No files could be read", 500);
    }

    // Build ZIP file
    const zipContent = buildZip(files);

    return new Response(toResponseBody(zipContent), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${
          app.name || app.slug
        }.zip"`,
      },
    });
  } catch (err) {
    console.error("Failed to download code:", err);
    return error("Failed to download code", 500);
  }
}

/**
 * Build a ZIP file from files array
 * Simple implementation without external dependencies
 */
function buildZip(
  files: Array<{ name: string; content: Uint8Array }>,
): Uint8Array {
  const localFileHeaders: Uint8Array[] = [];
  const centralDirectoryHeaders: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const fileName = new TextEncoder().encode(file.name);
    const content = file.content;

    // Local file header
    const localHeader = new Uint8Array(30 + fileName.length);
    const localView = new DataView(localHeader.buffer);

    localView.setUint32(0, 0x04034b50, true); // Local file header signature
    localView.setUint16(4, 20, true); // Version needed to extract
    localView.setUint16(6, 0, true); // General purpose bit flag
    localView.setUint16(8, 0, true); // Compression method (stored)
    localView.setUint16(10, 0, true); // File last modification time
    localView.setUint16(12, 0, true); // File last modification date
    localView.setUint32(14, crc32(content), true); // CRC-32
    localView.setUint32(18, content.length, true); // Compressed size
    localView.setUint32(22, content.length, true); // Uncompressed size
    localView.setUint16(26, fileName.length, true); // File name length
    localView.setUint16(28, 0, true); // Extra field length
    localHeader.set(fileName, 30);

    localFileHeaders.push(localHeader);
    localFileHeaders.push(content);

    // Central directory header
    const centralHeader = new Uint8Array(46 + fileName.length);
    const centralView = new DataView(centralHeader.buffer);

    centralView.setUint32(0, 0x02014b50, true); // Central directory signature
    centralView.setUint16(4, 20, true); // Version made by
    centralView.setUint16(6, 20, true); // Version needed to extract
    centralView.setUint16(8, 0, true); // General purpose bit flag
    centralView.setUint16(10, 0, true); // Compression method
    centralView.setUint16(12, 0, true); // File last modification time
    centralView.setUint16(14, 0, true); // File last modification date
    centralView.setUint32(16, crc32(content), true); // CRC-32
    centralView.setUint32(20, content.length, true); // Compressed size
    centralView.setUint32(24, content.length, true); // Uncompressed size
    centralView.setUint16(28, fileName.length, true); // File name length
    centralView.setUint16(30, 0, true); // Extra field length
    centralView.setUint16(32, 0, true); // File comment length
    centralView.setUint16(34, 0, true); // Disk number start
    centralView.setUint16(36, 0, true); // Internal file attributes
    centralView.setUint32(38, 0, true); // External file attributes
    centralView.setUint32(42, offset, true); // Relative offset of local header
    centralHeader.set(fileName, 46);

    centralDirectoryHeaders.push(centralHeader);
    offset += localHeader.length + content.length;
  }

  // End of central directory record
  const centralDirSize = centralDirectoryHeaders.reduce(
    (sum, h) => sum + h.length,
    0,
  );
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);

  endView.setUint32(0, 0x06054b50, true); // End of central directory signature
  endView.setUint16(4, 0, true); // Number of this disk
  endView.setUint16(6, 0, true); // Disk where central directory starts
  endView.setUint16(8, files.length, true); // Number of central directory records on this disk
  endView.setUint16(10, files.length, true); // Total number of central directory records
  endView.setUint32(12, centralDirSize, true); // Size of central directory
  endView.setUint32(16, offset, true); // Offset of start of central directory
  endView.setUint16(20, 0, true); // Comment length

  // Combine all parts
  const totalSize = offset + centralDirSize + 22;
  const zip = new Uint8Array(totalSize);
  let pos = 0;

  for (const header of localFileHeaders) {
    zip.set(header, pos);
    pos += header.length;
  }

  for (const header of centralDirectoryHeaders) {
    zip.set(header, pos);
    pos += header.length;
  }

  zip.set(endRecord, pos);

  return zip;
}

/**
 * CRC-32 calculation for ZIP files
 */
function crc32(data: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }

  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================
// DOCUMENTATION GENERATION HANDLERS
// ============================================

/**
 * Generate Skills.md documentation from app code
 * POST /api/apps/:appId/generate-docs
 */
async function handleGenerateDocs(
  request: Request,
  appId: string,
): Promise<Response> {
  const errors: GenerationError[] = [];
  const warnings: string[] = [];

  try {
    // Authenticate - only owner can generate docs
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();
    const r2Service = createR2Service();

    const app = await appsService.findById(appId);
    if (!app) {
      return error("App not found", 404);
    }

    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    // Check if generation is already in progress (debounce/lock)
    if (app.generation_in_progress) {
      return error("Documentation generation already in progress", 409);
    }

    // Set generation lock
    await appsService.update(appId, { generation_in_progress: true });

    try {
      // Parse request body for options
      let options = { ai_enhance: false };
      try {
        const body = await readJsonObject(request);
        options = { ...options, ...body };
      } catch {
        // No body or invalid JSON - use defaults
      }

      // Fetch app code from R2
      // Prefer _source_ prefixed files (original source before bundling) for parsing
      // Fall back to bundled entry file if source not available
      const storageKey = app.storage_key;
      let code: string | null = null;
      let filename = "index.ts";

      const entryFiles = ["index.tsx", "index.ts", "index.jsx", "index.js"];

      // First try to find original source file (unbundled, with ES module exports)
      for (const entryFile of entryFiles) {
        try {
          code = await r2Service.fetchTextFile(
            `${storageKey}_source_${entryFile}`,
          );
          filename = entryFile;
          docsLogger.debug("Found original source file for docs generation", {
            app_id: appId,
            filename: `_source_${entryFile}`,
          });
          break;
        } catch {
          // Try next
        }
      }

      // Fall back to bundled entry file if no source file found
      if (!code) {
        for (const entryFile of entryFiles) {
          try {
            code = await r2Service.fetchTextFile(`${storageKey}${entryFile}`);
            filename = entryFile;
            docsLogger.debug("Using bundled entry file for docs generation", {
              app_id: appId,
              filename: entryFile,
            });
            break;
          } catch {
            // Try next
          }
        }
      }

      if (!code) {
        errors.push({
          phase: "parse",
          message:
            "No entry file found (index.ts, index.tsx, index.js, or index.jsx)",
          suggestion:
            "Make sure your app has an entry file named index.ts or similar.",
        });

        const result: GenerationResult = {
          success: false,
          partial: false,
          skills_md: null,
          skills_parsed: null,
          embedding_text: null,
          errors,
          warnings,
        };

        return json(result, 400);
      }

      // Parse TypeScript source
      docsLogger.debug("Parsing app source for documentation", {
        app_id: appId,
        filename,
      });
      const parseResult = await parseTypeScript(code, filename);

      // Collect parse errors and warnings
      for (const err of parseResult.parseErrors) {
        errors.push({
          phase: "parse",
          message: err,
          suggestion: "Check your TypeScript syntax.",
        });
      }
      warnings.push(...parseResult.parseWarnings);

      if (parseResult.functions.length === 0) {
        warnings.push(
          "No exported functions found. Make sure to export your functions with `export` keyword.",
        );
      }

      // Generate Skills.md
      docsLogger.debug("Generating Skills.md", { app_id: appId });
      let skills_md: string;
      try {
        skills_md = generateSkillsMd(app.name || app.slug, parseResult, {
          includeExamples: true,
          includePermissions: true,
          pricingConfig: toDocgenPricingConfig(app.pricing_config),
          httpRoutes: buildHttpRouteCatalog(app),
        });
      } catch (genErr) {
        errors.push({
          phase: "generate_skills",
          message: `Failed to generate Skills.md: ${
            genErr instanceof Error ? genErr.message : String(genErr)
          }`,
        });

        const result: GenerationResult = {
          success: false,
          partial: parseResult.functions.length > 0,
          skills_md: null,
          skills_parsed: parseResult.functions.length > 0
            ? toSkillsParsed(parseResult)
            : null,
          embedding_text: null,
          errors,
          warnings,
        };

        return json(result, 500);
      }

      // Convert parser output into storage-ready shapes
      const skills_parsed = toSkillsParsed(parseResult);

      // Build the embedding source text
      docsLogger.debug("Generating embedding text", { app_id: appId });
      const embedding_text = generateEmbeddingText(
        app.name || app.slug,
        app.description,
        skills_parsed,
      );

      // Record AI-enhancement requests without mutating the generated docs path
      if (options.ai_enhance) {
        if (!user.openrouter_api_key) {
          warnings.push(
            "AI enhancement requested but BYOK not enabled. Enable BYOK for AI-enhanced descriptions.",
          );
        } else {
          warnings.push(
            "AI enhancement was requested, but this run used the standard docs generator. Review the generated copy and refine it manually if you want a more polished description.",
          );
        }
      }

      // Generate and store the embedding
      docsLogger.debug("Generating app embedding", { app_id: appId });
      let embeddingGenerated = false;
      const embeddingService = createEmbeddingService(user.openrouter_api_key);

      if (embeddingService && embedding_text) {
        try {
          const embeddingResult = await embeddingService.embed(embedding_text);
          await storeAppEmbedding(appId, embeddingResult.embedding);
          embeddingGenerated = true;
          docsLogger.info("Stored generated app embedding", { app_id: appId });
        } catch (embErr) {
          docsLogger.error("Failed to generate or store app embedding", {
            app_id: appId,
            error: embErr,
          });
          warnings.push(
            `Failed to generate embedding: ${
              embErr instanceof Error ? embErr.message : String(embErr)
            }. App will not appear in semantic search.`,
          );
        }
      } else if (!embeddingService) {
        warnings.push(
          "Embedding service not available. Enable BYOK or contact admin to enable semantic search.",
        );
      }

      // Generate the manifest and persist the generated docs
      docsLogger.info("Saving generated docs and manifest", { app_id: appId });
      const generatedManifest = generateManifestFromParseResult(
        app,
        parseResult,
        app.current_version || "1.0.0",
      );
      const existingManifest = parseAppManifest(app.manifest);
      const manifest = existingManifest?.type === "mcp"
        ? {
          ...generatedManifest,
          author: existingManifest.author,
          icon: existingManifest.icon,
          skills: existingManifest.skills ?? generatedManifest.skills,
          access_policy: existingManifest.access_policy,
          widgets: existingManifest.widgets,
          env: existingManifest.env,
          env_vars: existingManifest.env_vars,
          http: existingManifest.http,
        }
        : generatedManifest;
      await appsService.update(appId, {
        skills_md,
        skills_parsed,
        manifest: JSON.stringify(manifest),
        env_schema: resolveManifestEnvSchema(manifest),
        docs_generated_at: new Date().toISOString(),
        generation_in_progress: false,
      });

      // Success response
      const result: GenerationResult = {
        success: errors.length === 0,
        partial: errors.length > 0 && parseResult.functions.length > 0,
        skills_md,
        skills_parsed,
        embedding_text,
        embedding_generated: embeddingGenerated,
        errors,
        warnings,
      };

      return json(result);
    } finally {
      // Always release the lock
      await appsService.update(appId, { generation_in_progress: false }).catch(
        (lockErr) => {
          docsLogger.error("Failed to clear docs generation lock", {
            app_id: appId,
            error: lockErr,
          });
        },
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    docsLogger.error("Failed to generate docs", { app_id: appId, error: err });
    return error("Failed to generate documentation", 500);
  }
}

/**
 * Get Skills.md documentation
 * GET /api/apps/:appId/skills.md
 */
async function handleGetSkillsMd(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const { app } = await resolvePublicAppAccess(request, appId, {
      allowPrivateOwner: true,
    });
    if (!app) return error("App not found", 404);

    if (!app.skills_md) {
      return error(
        "Skills documentation not generated yet. Use POST /api/apps/:appId/generate-docs to generate.",
        404,
      );
    }

    // Return as markdown
    return new Response(app.skills_md, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
      },
    });
  } catch (err) {
    console.error("Failed to get skills.md:", err);
    return error("Failed to get skills documentation", 500);
  }
}

/**
 * Update skills documentation (with validation)
 * PATCH /api/apps/:appId/skills
 */
async function handleUpdateSkills(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    // Authenticate - only owner can update
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();

    const app = await appsService.findById(appId);
    if (!app) {
      return error("App not found", 404);
    }

    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    // Parse request body
    const body = await readJsonObject(request);
    const { skills_md } = body;

    if (!skills_md || typeof skills_md !== "string") {
      return error("skills_md field is required and must be a string", 400);
    }

    // Validate the markdown and parse back to structured data
    console.log("[UPDATE_SKILLS] Validating markdown...");
    const validation = validateAndParseSkillsMd(skills_md);

    if (!validation.valid) {
      return json({
        success: false,
        errors: validation.errors,
        warnings: validation.warnings,
      }, 400);
    }

    // Generate new embedding text from updated skills
    const embedding_text = validation.skills_parsed
      ? generateEmbeddingText(
        app.name || app.slug,
        app.description,
        validation.skills_parsed,
      )
      : null;

    // Regenerate embedding if embedding text changed
    let embeddingGenerated = false;
    const embeddingService = createEmbeddingService(user.openrouter_api_key);

    if (embeddingService && embedding_text) {
      try {
        console.log("[UPDATE_SKILLS] Regenerating embedding...");
        const embeddingResult = await embeddingService.embed(embedding_text);
        await storeAppEmbedding(appId, embeddingResult.embedding);
        embeddingGenerated = true;
        console.log("[UPDATE_SKILLS] Embedding updated successfully");
      } catch (embErr) {
        console.error(
          "[UPDATE_SKILLS] Failed to regenerate embedding:",
          embErr,
        );
        validation.warnings.push(
          `Failed to regenerate embedding: ${
            embErr instanceof Error ? embErr.message : String(embErr)
          }`,
        );
      }
    } else if (!embeddingService) {
      validation.warnings.push(
        "Embedding service not available. Enable BYOK to update semantic search indexing.",
      );
    }

    // Update database with both markdown and parsed data
    console.log("[UPDATE_SKILLS] Saving to database...");
    await appsService.update(appId, {
      skills_md,
      skills_parsed: validation.skills_parsed,
    });

    return json({
      success: true,
      skills_parsed: validation.skills_parsed,
      embedding_text,
      embedding_generated: embeddingGenerated,
      warnings: validation.warnings,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to update skills:", err);
    return error("Failed to update skills documentation", 500);
  }
}

// ============================================
// DRAFT/PUBLISH HANDLERS
// ============================================

/**
 * Get draft info for an app
 * GET /api/apps/:appId/draft
 */
async function handleGetDraft(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();

    const app = await appsService.findById(appId);
    if (!app) {
      return error("App not found", 404);
    }

    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    if (!app.draft_storage_key) {
      return json({
        has_draft: false,
        message: "No draft available",
      });
    }

    const includeDiff =
      new URL(request.url).searchParams.get("include_diff") === "1";
    let diffPayload: Record<string, unknown> = {};
    if (includeDiff) {
      const publishedExports = Array.isArray(app.exports) ? app.exports : [];
      const draftExports = Array.isArray(app.draft_exports)
        ? app.draft_exports
        : [];
      const publishedExportSet = new Set(publishedExports);
      const draftExportSet = new Set(draftExports);
      let draftManifest: string | null = null;
      try {
        const r2Service = createR2Service();
        draftManifest = await r2Service.fetchTextFile(
          `${app.draft_storage_key}manifest.json`,
        );
      } catch {
        draftManifest = null;
      }
      diffPayload = {
        exports_diff: {
          added: draftExports.filter((name) => !publishedExportSet.has(name))
            .sort(),
          removed: publishedExports.filter((name) => !draftExportSet.has(name))
            .sort(),
        },
        manifest_diff: diffManifests(app.manifest, draftManifest),
      };
    }

    return json({
      has_draft: true,
      draft_version: app.draft_version,
      draft_uploaded_at: app.draft_uploaded_at,
      draft_exports: app.draft_exports,
      published_version: app.current_version,
      published_storage_key: app.storage_key,
      ...diffPayload,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to get draft:", err);
    return error("Failed to get draft info", 500);
  }
}

/**
 * Publish draft to production
 * POST /api/apps/:appId/publish
 *
 * This replaces the published version with the draft and optionally regenerates docs.
 */
async function handlePublishDraft(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user: EmbeddingUser = await authenticate(request);
    const appsService = createAppsService();
    const r2Service = createR2Service();

    const app = await appsService.findById(appId);
    if (!app) {
      return error("App not found", 404);
    }

    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    if (!app.draft_storage_key) {
      return error("No draft to publish", 400);
    }

    // Gate: check tier visibility and the configured publisher balance rule.
    if (app.visibility !== "private") {
      const userTier = await getUserTier(user.id);
      const visibilityErr = checkVisibilityAllowed(
        userTier,
        app.visibility as "private" | "unlisted" | "public",
      );
      if (visibilityErr) {
        return error(`Cannot publish: ${visibilityErr}`, 403);
      }
      const readinessError = await publisherPublishReadinessResponse(user.id, {
        visibility: app.visibility,
        appConnectGateExempt: app.connect_gate_exempt,
      });
      if (readinessError) return readinessError;

      // Layer 2: Originality gate (publish only)
      const draftKey = app.draft_storage_key;
      let draftSource = "";
      for (
        const name of [
          "_source_index.ts",
          "_source_index.tsx",
          "index.ts",
          "index.tsx",
          "index.js",
        ]
      ) {
        try {
          draftSource = await r2Service.fetchTextFile(`${draftKey}${name}`);
          break;
        } catch {}
      }
      if (!draftSource) {
        return error(
          "Publish blocked: originality check requires the draft source entry file, but it could not be loaded.",
          500,
        );
      }

      const { runOriginalityCheck, computeFingerprint, storeIntegrityResults } =
        await import("../services/originality.ts");
      const mdContent = await r2Service.fetchTextFile(`${draftKey}README.md`)
        .catch(() => "");
      const originalityResult = await runOriginalityCheck(
        user.id,
        appId,
        [
          { name: "index.ts", content: draftSource },
          ...(mdContent ? [{ name: "README.md", content: mdContent }] : []),
        ],
        undefined,
        { mode: "fail_closed" },
      );
      if (!originalityResult.passed) {
        return error(
          `Publish blocked: ${originalityResult.reason} ` +
            `(originality score: ${
              (originalityResult.score * 100).toFixed(1)
            }%)`,
          422,
        );
      }
      // Store fingerprint + originality score (fire-and-forget)
      storeIntegrityResults(appId, {
        source_fingerprint: originalityResult.fingerprint,
        originality_score: originalityResult.score,
        integrity_checked_at: new Date().toISOString(),
      }).catch((err) =>
        console.error("[INTEGRITY] Publish gate storage failed:", err)
      );
    }

    // Parse request options
    let options = { regenerate_docs: true };
    try {
      const body = await readJsonObject(request);
      options = { ...options, ...body };
    } catch {
      // Use defaults
    }

    publishLogger.info("Starting draft publish", { app_id: appId });

    // Generate new version number
    const currentVersion = app.current_version || "1.0.0";
    const newVersion = incrementVersion(currentVersion);
    const newStorageKey = `apps/${appId}/${newVersion}/`;

    // Copy draft files to new version location, tracking total size
    publishLogger.debug("Copying draft files to new version", {
      app_id: appId,
      draft_storage_key: app.draft_storage_key,
      new_storage_key: newStorageKey,
    });
    const draftStorageKey = app.draft_storage_key;
    const draftFiles = await r2Service.listFiles(draftStorageKey);
    let publishedSizeBytes = 0;
    const publishedFilesForTrust: Array<{ name: string; content: Uint8Array }> =
      [];

    for (const fileKey of draftFiles) {
      const fileName = fileKey.replace(draftStorageKey, "");
      if (fileName) {
        const content = await r2Service.fetchFile(fileKey);
        publishedSizeBytes += content.byteLength;
        publishedFilesForTrust.push({ name: fileName, content });
        await r2Service.uploadFile(`${newStorageKey}${fileName}`, {
          name: fileName,
          content,
          contentType: getContentTypeFromName(fileName),
        });
      }
    }

    const manifestCoverage = await resolveStoredManifestCoverage({
      app: {
        name: app.name || app.slug,
        slug: app.slug,
        description: app.description,
      },
      fetchTextFile: (path) => r2Service.fetchTextFile(path),
      storageKey: newStorageKey,
      version: newVersion,
      existingManifest: app.manifest,
    });

    let publishedManifest: string | null = manifestCoverage.manifestJson;
    if (publishedManifest && manifestCoverage.source !== "stored") {
      await r2Service.uploadFile(`${newStorageKey}manifest.json`, {
        name: "manifest.json",
        content: new TextEncoder().encode(publishedManifest),
        contentType: "application/json",
      });
      publishedSizeBytes +=
        new TextEncoder().encode(publishedManifest).byteLength;
      publishedFilesForTrust.push({
        name: "manifest.json",
        content: new TextEncoder().encode(publishedManifest),
      });
      publishLogger.info("Wrote manifest.json for published draft", {
        app_id: appId,
        source: manifestCoverage.source,
      });
    } else if (publishedManifest) {
      publishLogger.debug("Found existing manifest.json in published files", {
        app_id: appId,
      });
    }

    const publishedContractResolution = resolveAppFunctionContracts({
      slug: app.slug,
      runtime: app.runtime,
      manifest: publishedManifest,
      skills_parsed: null,
      exports: app.draft_exports,
    });
    logAppContractResolution({
      appId,
      ownerId: user.id,
      appSlug: app.slug,
      runtime: app.runtime,
      surface: "app_publish_draft",
      source: publishedContractResolution.source,
      legacySourceDetected: publishedContractResolution.legacySourceDetected,
      functionCount: publishedContractResolution.functions.length,
      manifestBacked: publishedContractResolution.manifestBacked,
      migrationRequired: publishedContractResolution.migrationRequired,
      note: manifestCoverage.source,
    });

    try {
      requireManifestFunctionContracts({
        slug: app.slug,
        runtime: app.runtime,
        manifest: publishedManifest,
        exports: app.draft_exports,
      });
    } catch (contractErr) {
      if (contractErr instanceof AppContractMigrationRequiredError) {
        return error(`Publish blocked: ${contractErr.message}`, 422);
      }
      throw contractErr;
    }

    // Update app record with new version
    publishLogger.debug("Updating app record for published draft", {
      app_id: appId,
      new_version: newVersion,
    });
    const updateFields: Record<string, unknown> = {
      storage_key: newStorageKey,
      current_version: newVersion,
      versions: [...(app.versions || []), newVersion],
      exports: app.draft_exports,
      // Clear draft fields
      draft_storage_key: null,
      draft_version: null,
      draft_uploaded_at: null,
      draft_exports: null,
    };
    if (publishedManifest) {
      updateFields.manifest = publishedManifest;
      // Also update name/description from manifest
      try {
        const m = JSON.parse(publishedManifest);
        if (m.name) updateFields.name = m.name;
        if (m.description) updateFields.description = m.description;
        updateFields.env_schema = resolveManifestEnvSchema(m);
      } catch {}
    }
    if (publishedManifest) {
      const versionTrust = await buildVersionTrustMetadata({
        appId,
        version: newVersion,
        runtime: app.runtime || "deno",
        manifest: publishedManifest,
        files: publishedFilesForTrust,
        storageKey: newStorageKey,
      });
      updateFields.version_metadata = appendVersionTrustMetadata(
        app.version_metadata,
        buildVersionMetadataEntry(newVersion, publishedSizeBytes, versionTrust),
      );
    }
    await appsService.update(appId, updateFields);
    await recordUploadStorage(user.id, appId, newVersion, publishedSizeBytes);

    // The card embeds name+description, which a code publish can change via the
    // manifest — re-render (no-op for non-public agents).
    scheduleCaptureTask(
      renderAgentOgCard({ ...app, ...updateFields }, { reason: "publish" }),
    );

    // Invalidate code cache so next request fetches new version
    getCodeCache().invalidate(appId);

    // Rebuild ESM bundle in KV so Dynamic Workers get the new code immediately
    if (app.app_type !== "skill") {
      try {
        const entryFiles = ["index.tsx", "index.ts", "index.jsx", "index.js"];
        let sourceCode: string | null = null;
        let entryFile = "";
        for (const candidate of entryFiles) {
          try {
            sourceCode = await r2Service.fetchTextFile(
              `${newStorageKey}_source_${candidate}`,
            );
            entryFile = candidate;
            break;
          } catch { /* try next */ }
        }
        if (sourceCode && entryFile) {
          const bundleResult = await bundleCode([{
            name: entryFile,
            content: sourceCode,
          }], entryFile);
          if (bundleResult.success) {
            // Upload rebuilt bundles to R2
            const builtFiles = [{
              name: entryFile,
              content: new TextEncoder().encode(bundleResult.code),
              contentType: "application/javascript",
            }];
            if (bundleResult.esmCode) {
              builtFiles.push({
                name: entryFile.replace(/\.(tsx?|jsx?)$/, ".esm.js"),
                content: new TextEncoder().encode(bundleResult.esmCode),
                contentType: "application/javascript",
              });
            }
            await r2Service.uploadFiles(newStorageKey, builtFiles);
            // Cache ESM in KV for Dynamic Worker loading
            if (bundleResult.esmCode && globalThis.__env?.CODE_CACHE) {
              await putLiveExecutedBundle({
                appId,
                version: newVersion,
                esmCode: bundleResult.esmCode,
              });
            }
            publishLogger.info("Rebuilt and cached ESM bundle during publish", {
              app_id: appId,
              esm_length: bundleResult.esmCode?.length || 0,
            });
          }
        }
      } catch (rebuildErr) {
        publishLogger.warn("ESM rebuild failed during publish (non-fatal)", {
          app_id: appId,
          error: rebuildErr,
        });
      }
    }

    // If the published bundle includes migrations, provision D1 on first publish.
    if (!app.d1_database_id && app.app_type !== "skill") {
      try {
        const allFiles = await r2Service.listFiles(newStorageKey);
        const sqlFiles = allFiles.filter((f: string) =>
          f.includes("migrations/") && f.endsWith(".sql")
        ).sort();
        publishLogger.debug("Found migration files in published storage", {
          app_id: appId,
          migration_count: sqlFiles.length,
          files: sqlFiles,
        });

        if (sqlFiles.length > 0) {
          const { parseMigrationFiles } = await import(
            "../services/d1-migrations.ts"
          );
          const migrationContents: Record<string, string> = {};
          for (const key of sqlFiles) {
            const name = key.split("/").pop() || "";
            try {
              migrationContents[name] = await r2Service.fetchTextFile(key);
            } catch { /* skip unreadable files */ }
          }
          const parsed = parseMigrationFiles(migrationContents);
          if (parsed.length > 0) {
            const { provisionAndMigrate } = await import(
              "../services/upload-pipeline.ts"
            );
            const d1Result = await provisionAndMigrate(appId, parsed);
            publishLogger.info("Provisioned D1 during publish", {
              app_id: appId,
              status: d1Result.status,
              migrations_applied: d1Result.migrations_applied,
            });
          }
        }
      } catch (d1Err) {
        publishLogger.warn(
          "D1 provisioning failed during publish (non-fatal)",
          {
            app_id: appId,
            error: d1Err,
          },
        );
      }
    }

    // Optionally regenerate docs
    let docsResult = null;
    if (options.regenerate_docs && app.skills_md) {
      publishLogger.info("Regenerating docs during publish", { app_id: appId });
      try {
        // Fetch the new code
        let code: string | null = null;
        const entryFiles = ["index.tsx", "index.ts", "index.jsx", "index.js"];
        for (const entryFile of entryFiles) {
          try {
            code = await r2Service.fetchTextFile(
              `${newStorageKey}${entryFile}`,
            );
            break;
          } catch {
            // Try next
          }
        }

        if (code) {
          const parseResult = await parseTypeScript(code, "index.ts");
          const skills_md = generateSkillsMd(
            app.name || app.slug,
            parseResult,
            {
              pricingConfig: toDocgenPricingConfig(app.pricing_config),
            },
          );
          const skills_parsed = toSkillsParsed(parseResult);
          const embedding_text = generateEmbeddingText(
            app.name || app.slug,
            app.description,
            skills_parsed,
          );

          // Generate embedding
          let embeddingGenerated = false;
          const embeddingService = createEmbeddingService(
            user.openrouter_api_key,
          );
          if (embeddingService && embedding_text) {
            try {
              const embeddingResult = await embeddingService.embed(
                embedding_text,
              );
              await storeAppEmbedding(appId, embeddingResult.embedding);
              embeddingGenerated = true;
            } catch (embErr) {
              publishLogger.error(
                "Failed to generate embedding during publish",
                {
                  app_id: appId,
                  error: embErr,
                },
              );
            }
          }

          const manifest = generateManifestFromParseResult(
            app,
            parseResult,
            newVersion,
          );
          await appsService.update(appId, {
            skills_md,
            skills_parsed,
            manifest: JSON.stringify(manifest),
            env_schema: resolveManifestEnvSchema(manifest),
            docs_generated_at: new Date().toISOString(),
          });

          docsResult = {
            regenerated: true,
            embedding_generated: embeddingGenerated,
          };
        }
      } catch (docsErr) {
        publishLogger.error("Failed to regenerate docs during publish", {
          app_id: appId,
          error: docsErr,
        });
        docsResult = {
          regenerated: false,
          error: docsErr instanceof Error ? docsErr.message : String(docsErr),
        };
      }
    }

    // Clean up draft files after publish.
    try {
      publishLogger.debug("Cleaning up draft files after publish", {
        app_id: appId,
      });
      for (const fileKey of draftFiles) {
        await r2Service.deleteFile(fileKey);
      }
    } catch (cleanupErr) {
      publishLogger.error("Failed to clean up draft files after publish", {
        app_id: appId,
        error: cleanupErr,
      });
      // Non-fatal.
    }

    publishLogger.info("Draft publish complete", {
      app_id: appId,
      new_version: newVersion,
      published_size_bytes: publishedSizeBytes,
    });

    // Rebuild library + function index synchronously so app appears immediately
    try {
      await rebuildUserLibrary(user.id);
      publishLogger.info("Rebuilt user library after publish", {
        app_id: appId,
        user_id: user.id,
      });
    } catch (err) {
      publishLogger.error("Library rebuild failed after publish", {
        app_id: appId,
        user_id: user.id,
        error: err,
      });
    }
    try {
      const { rebuildFunctionIndex } = await import(
        "../services/function-index.ts"
      );
      await rebuildFunctionIndex(user.id);
      publishLogger.info("Rebuilt function index after publish", {
        app_id: appId,
        user_id: user.id,
      });
    } catch (err) {
      publishLogger.error("Function index rebuild failed after publish", {
        app_id: appId,
        user_id: user.id,
        error: err,
      });
    }

    return json({
      success: true,
      app_id: appId,
      new_version: newVersion,
      storage_key: newStorageKey,
      url: `/a/${appId}`,
      docs: docsResult,
      message: "Draft published successfully",
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    publishLogger.error("Failed to publish draft", {
      app_id: appId,
      error: err,
    });
    return error("Failed to publish draft", 500);
  }
}

/**
 * Rebuild app code from stored source files
 * POST /api/apps/:appId/rebuild
 *
 * Re-fetches the original source from R2, re-bundles with esbuild,
 * and uploads the new IIFE + ESM bundles. Useful when the bundler
 * or runtime changes and existing apps need their bundles regenerated.
 */
async function handleRebuild(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    const appsService = createAppsService();
    const r2Service = createR2Service();

    // Verify ownership
    const app = await appsService.findById(appId);
    if (!app) return error("App not found", 404);
    if (app.owner_id !== user.id) return error("Not authorized", 403);

    const storageKey = app.storage_key;
    if (!storageKey) return error("App has no stored code", 400);

    rebuildLogger.info("Starting app rebuild", {
      app_id: appId,
      storage_key: storageKey,
    });

    // Try standard source file names (avoids needing listFiles)
    const candidateEntries = ["index.tsx", "index.ts", "index.jsx", "index.js"];
    let sourceCode: string | null = null;
    let entryFileName = "";

    for (const candidate of candidateEntries) {
      try {
        sourceCode = await r2Service.fetchTextFile(
          `${storageKey}_source_${candidate}`,
        );
        entryFileName = candidate;
        rebuildLogger.debug("Found source file for rebuild", {
          app_id: appId,
          entry_file: `_source_${candidate}`,
          code_length: sourceCode.length,
        });
        break;
      } catch {
        // Try next candidate
      }
    }

    if (!sourceCode || !entryFileName) {
      return error(
        "No original source file found (_source_index.tsx/ts/jsx/js). App may need to be re-uploaded.",
        400,
      );
    }

    const files = [{ name: entryFileName, content: sourceCode }];

    rebuildLogger.debug("Bundling app rebuild source", {
      app_id: appId,
      file_count: files.length,
      entry_file: entryFileName,
    });

    // Re-bundle with esbuild
    const bundleResult = await bundleCode(files, entryFileName);

    if (!bundleResult.success) {
      rebuildLogger.error("App rebuild bundling failed", {
        app_id: appId,
        errors: bundleResult.errors,
      });
      return error(`Rebuild failed: ${bundleResult.errors.join(", ")}`, 500);
    }

    rebuildLogger.info("App rebuild bundling succeeded", {
      app_id: appId,
      iife_length: bundleResult.code.length,
      esm_length: bundleResult.esmCode?.length || 0,
    });

    // Upload new bundles to R2 (overwrite existing)
    const filesToUpload = [
      {
        name: entryFileName,
        content: new TextEncoder().encode(bundleResult.code),
        contentType: "application/javascript",
      },
    ];

    if (bundleResult.esmCode) {
      filesToUpload.push({
        name: entryFileName.replace(/\.(tsx?|jsx?)$/, ".esm.js"),
        content: new TextEncoder().encode(bundleResult.esmCode),
        contentType: "application/javascript",
      });
    }

    await r2Service.uploadFiles(storageKey, filesToUpload);
    rebuildLogger.info("Uploaded rebuilt app files", {
      app_id: appId,
      file_count: filesToUpload.length,
      storage_key: storageKey,
    });

    // Store ESM bundle in KV for Dynamic Worker loading
    if (bundleResult.esmCode && globalThis.__env?.CODE_CACHE) {
      try {
        await putLiveExecutedBundle({
          appId,
          version: app.current_version || "latest",
          esmCode: bundleResult.esmCode,
        });
        rebuildLogger.info("Cached rebuilt ESM bundle in KV", {
          app_id: appId,
          esm_length: bundleResult.esmCode.length,
        });
      } catch (kvErr) {
        rebuildLogger.error("KV cache write failed during rebuild", {
          app_id: appId,
          error: kvErr,
        });
      }
    }

    // Invalidate code cache so next request picks up rebuilt bundles
    getCodeCache().invalidate(appId);

    return json({
      success: true,
      message: "App rebuilt successfully",
      details: {
        entryFile: entryFileName,
        iifeSize: bundleResult.code.length,
        esmSize: bundleResult.esmCode?.length || 0,
        warnings: bundleResult.warnings,
      },
    });
  } catch (err) {
    rebuildLogger.error("App rebuild failed", { app_id: appId, error: err });
    return error(err instanceof Error ? err.message : "Rebuild failed", 500);
  }
}

/**
 * Discard draft without publishing
 * DELETE /api/apps/:appId/draft
 */
async function handleDiscardDraft(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    const appsService = createAppsService();
    const r2Service = createR2Service();

    const app = await appsService.findById(appId);
    if (!app) {
      return error("App not found", 404);
    }

    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    if (!app.draft_storage_key) {
      return json({
        success: true,
        message: "No draft to discard",
      });
    }

    console.log("[DISCARD] Discarding draft for app:", appId);

    // Delete draft files from R2
    const draftStorageKey = app.draft_storage_key;
    try {
      const draftFiles = await r2Service.listFiles(draftStorageKey);
      for (const fileKey of draftFiles) {
        await r2Service.deleteFile(fileKey);
      }
    } catch (deleteErr) {
      console.error("[DISCARD] Failed to delete draft files:", deleteErr);
      // Continue - clear the database record anyway
    }

    // Clear draft fields in database
    await appsService.update(appId, {
      draft_storage_key: null,
      draft_version: null,
      draft_uploaded_at: null,
      draft_exports: null,
    });

    console.log("[DISCARD] Draft discarded");

    return json({
      success: true,
      message: "Draft discarded",
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to discard draft:", err);
    return error("Failed to discard draft", 500);
  }
}

/**
 * Increment version number (semver minor bump)
 */
function incrementVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) {
    return "1.0.1";
  }
  const [major, minor, patch] = parts.map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Get content type from file name
 */
function getContentTypeFromName(filename: string): string {
  if (filename.endsWith(".tsx")) return "text/typescript-jsx";
  if (filename.endsWith(".ts")) return "text/typescript";
  if (filename.endsWith(".jsx")) return "text/javascript-jsx";
  if (filename.endsWith(".js")) return "application/javascript";
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".md")) return "text/markdown";
  if (filename.endsWith(".css")) return "text/css";
  return "text/plain";
}

// ============================================
// ENVIRONMENT VARIABLES HANDLERS
// ============================================

/**
 * Get environment variable keys with masked values
 * GET /api/apps/:appId/env
 */
async function handleGetEnvVars(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    const appsService = createAppsService();

    const app = await appsService.findById(appId);
    if (!app) {
      return error("App not found", 404);
    }

    // Only owner can view env vars
    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    const envVars = app.env_vars || {};

    // Decrypt for summary (to get actual lengths)
    let decrypted: Record<string, string> = {};
    try {
      decrypted = await decryptEnvVars(envVars);
    } catch {
      // If decryption fails, return keys only
      return json({
        env_vars: Object.keys(envVars).map((key) => ({
          key,
          masked: "••••",
          length: 0,
        })),
        count: Object.keys(envVars).length,
        limits: ENV_VAR_LIMITS,
      });
    }

    return json({
      env_vars: getEnvVarsSummary(decrypted),
      count: Object.keys(decrypted).length,
      limits: ENV_VAR_LIMITS,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to get env vars:", err);
    return error("Failed to get environment variables", 500);
  }
}

/**
 * Set all environment variables (replaces existing)
 * PUT /api/apps/:appId/env
 */
async function handleSetEnvVars(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    return withSensitiveRouteRateLimit(user.id, "apps:env_set", async () => {
      const appsService = createAppsService();

      const app = await appsService.findById(appId);
      if (!app) {
        return error("App not found", 404);
      }

      // Only owner can set env vars
      if (app.owner_id !== user.id) {
        return error("Unauthorized", 403);
      }

      const body = await readJsonObject(request);
      const { env_vars } = body;

      if (!env_vars || typeof env_vars !== "object") {
        return error("env_vars object is required", 400);
      }

      // Validate all keys and values
      const errors: string[] = [];
      const entries = Object.entries(env_vars as Record<string, string>);

      // Check count limit
      if (entries.length > ENV_VAR_LIMITS.max_vars_per_app) {
        return error(
          `Maximum ${ENV_VAR_LIMITS.max_vars_per_app} environment variables allowed`,
          400,
        );
      }

      for (const [key, value] of entries) {
        const keyValidation = validateEnvVarKey(key);
        if (!keyValidation.valid) {
          errors.push(`${key}: ${keyValidation.error}`);
          continue;
        }

        const valueValidation = validateEnvVarValue(value);
        if (!valueValidation.valid) {
          errors.push(`${key}: ${valueValidation.error}`);
        }
      }

      if (errors.length > 0) {
        return json({ success: false, errors }, 400);
      }

      // Encrypt all values
      const encryptedEnvVars: Record<string, string> = {};
      for (const [key, value] of entries) {
        encryptedEnvVars[key] = await encryptEnvVar(value);
      }

      // Update app
      await appsService.update(appId, { env_vars: encryptedEnvVars });

      return json({
        success: true,
        count: entries.length,
        keys: entries.map(([key]) => key),
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to set env vars:", err);
    return error("Failed to set environment variables", 500);
  }
}

/**
 * Update specific environment variables (merge with existing)
 * PATCH /api/apps/:appId/env
 */
async function handleUpdateEnvVars(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    return withSensitiveRouteRateLimit(user.id, "apps:env_update", async () => {
      const appsService = createAppsService();

      const app = await appsService.findById(appId);
      if (!app) {
        return error("App not found", 404);
      }

      // Only owner can update env vars
      if (app.owner_id !== user.id) {
        return error("Unauthorized", 403);
      }

      const body = await readJsonObject(request);
      const { env_vars } = body;

      if (!env_vars || typeof env_vars !== "object") {
        return error("env_vars object is required", 400);
      }

      // Get existing env vars
      const existingEnvVars = app.env_vars || {};

      // Validate new keys and values
      const errors: string[] = [];
      const newEntries = Object.entries(env_vars as Record<string, string>);

      // Check total count after merge
      const totalKeys = new Set([
        ...Object.keys(existingEnvVars),
        ...newEntries.map(([k]) => k),
      ]);
      if (totalKeys.size > ENV_VAR_LIMITS.max_vars_per_app) {
        return error(
          `Maximum ${ENV_VAR_LIMITS.max_vars_per_app} environment variables allowed`,
          400,
        );
      }

      for (const [key, value] of newEntries) {
        const keyValidation = validateEnvVarKey(key);
        if (!keyValidation.valid) {
          errors.push(`${key}: ${keyValidation.error}`);
          continue;
        }

        const valueValidation = validateEnvVarValue(value);
        if (!valueValidation.valid) {
          errors.push(`${key}: ${valueValidation.error}`);
        }
      }

      if (errors.length > 0) {
        return json({ success: false, errors }, 400);
      }

      // Encrypt new values and merge with existing
      const mergedEnvVars = { ...existingEnvVars };
      for (const [key, value] of newEntries) {
        mergedEnvVars[key] = await encryptEnvVar(value);
      }

      // Update app
      await appsService.update(appId, { env_vars: mergedEnvVars });

      return json({
        success: true,
        updated: newEntries.map(([key]) => key),
        total_count: Object.keys(mergedEnvVars).length,
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to update env vars:", err);
    return error("Failed to update environment variables", 500);
  }
}

/**
 * Delete a specific environment variable
 * DELETE /api/apps/:appId/env/:key
 */
async function handleDeleteEnvVar(
  request: Request,
  appId: string,
  key: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    return withSensitiveRouteRateLimit(user.id, "apps:env_delete", async () => {
      const appsService = createAppsService();

      const app = await appsService.findById(appId);
      if (!app) {
        return error("App not found", 404);
      }

      // Only owner can delete env vars
      if (app.owner_id !== user.id) {
        return error("Unauthorized", 403);
      }

      // Get existing env vars
      const existingEnvVars = app.env_vars || {};

      // Check if key exists
      if (!(key in existingEnvVars)) {
        return error(`Environment variable "${key}" not found`, 404);
      }

      // Remove the key
      const updatedEnvVars = { ...existingEnvVars };
      delete updatedEnvVars[key];

      // Update app
      await appsService.update(appId, { env_vars: updatedEnvVars });

      return json({
        success: true,
        deleted: key,
        remaining_count: Object.keys(updatedEnvVars).length,
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to delete env var:", err);
    return error("Failed to delete environment variable", 500);
  }
}

// ============================================
// SUPABASE CONFIGURATION HANDLERS
// ============================================

/**
 * Get Supabase configuration (masked)
 * GET /api/apps/:appId/supabase
 */
async function handleGetSupabaseConfig(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    const appsService = createAppsService();

    const app = await appsService.findById(appId);
    if (!app) {
      return error("App not found", 404);
    }

    if (app.owner_id !== user.id) {
      return error("Unauthorized", 403);
    }

    const resolutionSource = classifyAppSupabaseConfigState(app);

    return json({
      config_id: app.supabase_config_id || null,
      // Legacy fields for backward compatibility
      enabled: !!(app.supabase_config_id || app.supabase_enabled),
      url: app.supabase_url || null,
      has_anon_key: !!app.supabase_anon_key_encrypted,
      has_service_key: !!app.supabase_service_key_encrypted,
      resolution_source: resolutionSource,
      migration_required: resolutionSource !== "disabled" &&
        resolutionSource !== "saved_config",
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to get Supabase config:", err);
    return error("Failed to get Supabase configuration", 500);
  }
}

/**
 * Set Supabase configuration — now accepts config_id to link a saved server
 * PUT /api/apps/:appId/supabase
 */
async function handleSetSupabaseConfig(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    return await withSensitiveRouteRateLimit(
      user.id,
      "apps:supabase_set",
      async () => {
        const appsService = createAppsService();

        const app = await appsService.findById(appId);
        if (!app) {
          return error("App not found", 404);
        }

        if (app.owner_id !== user.id) {
          return error("Unauthorized", 403);
        }

        const { configId } = await validateAppSupabaseConfigRequest(request);

        if (configId) {
          await assertOwnedSupabaseConfig(user.id, configId);
        }

        // Update app to reference the saved server (or null to disable)
        await appsService.update(appId, {
          supabase_config_id: configId,
          supabase_enabled: !!configId,
          supabase_url: null,
          supabase_anon_key_encrypted: null,
          supabase_service_key_encrypted: null,
        });

        // If connecting Supabase, permanently flag app as ineligible for trading
        if (configId) {
          try {
            const { flagExternalDb } = await import(
              "../services/marketplace.ts"
            );
            await flagExternalDb(appId);
          } catch (err) {
            console.error(
              "[APPS] Failed to flag external DB for marketplace:",
              err,
            );
          }
        }

        return json({
          success: true,
          message: configId ? "Supabase server assigned" : "Supabase disabled",
        });
      },
    );
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to set Supabase config:", err);
    return error("Failed to set Supabase configuration", 500);
  }
}

/**
 * Remove Supabase configuration
 * DELETE /api/apps/:appId/supabase
 */
async function handleDeleteSupabaseConfig(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    return withSensitiveRouteRateLimit(
      user.id,
      "apps:supabase_delete",
      async () => {
        const appsService = createAppsService();

        const app = await appsService.findById(appId);
        if (!app) {
          return error("App not found", 404);
        }

        if (app.owner_id !== user.id) {
          return error("Unauthorized", 403);
        }

        await appsService.update(appId, {
          supabase_config_id: null,
          supabase_enabled: false,
          supabase_url: null,
          supabase_anon_key_encrypted: null,
          supabase_service_key_encrypted: null,
        });

        return json({
          success: true,
          message: "Supabase configuration removed",
        });
      },
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to delete Supabase config:", err);
    return error("Failed to delete Supabase configuration", 500);
  }
}

// ============================================
// EARNINGS / REVENUE HANDLERS
// ============================================

/**
 * Get earnings data for an app (owner only)
 * GET /api/apps/:appId/earnings?period=7d|30d|90d|all
 *
 * Returns:
 * - total_earned_light: lifetime earnings
 * - period_earned_light: earnings in the requested period
 * - total_transfers: count of paid calls
 * - daily: array of { date, earned_light, transfer_count } for charting
 * - by_function: array of { function_name, earned_light, call_count } breakdown
 * - recent: last 20 transfers
 */
async function handleGetEarnings(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    const appsService = createAppsService();

    const app = await appsService.findById(appId);
    if (!app) return error("App not found", 404);
    if (app.owner_id !== user.id) return error("Unauthorized", 403);

    const SUPABASE_URL = getEnv("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const headers = {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    };

    const url = new URL(request.url);
    const period = url.searchParams.get("period") || "30d";

    // Calculate date cutoff for period
    let periodDays = 30;
    if (period === "7d") periodDays = 7;
    else if (period === "90d") periodDays = 90;
    else if (period === "all") periodDays = 3650; // ~10 years

    const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000)
      .toISOString();

    // Fetch all transfers to this app within the period
    // (and also lifetime total for the summary)
    const [periodRes, lifetimeRes, recentRes] = await Promise.all([
      // Period transfers (for daily chart + by-function breakdown)
      fetch(
        `${SUPABASE_URL}/rest/v1/transfers?app_id=eq.${app.id}&to_user_id=eq.${user.id}&created_at=gte.${cutoff}&select=amount_light,function_name,reason,created_at&order=created_at.asc&limit=10000`,
        { headers },
      ),
      // Lifetime aggregate: just count and sum
      fetch(
        `${SUPABASE_URL}/rest/v1/transfers?app_id=eq.${app.id}&to_user_id=eq.${user.id}&select=amount_light`,
        { headers: { ...headers, "Prefer": "count=exact" } },
      ),
      // Recent transfers (last 20)
      fetch(
        `${SUPABASE_URL}/rest/v1/transfers?app_id=eq.${app.id}&to_user_id=eq.${user.id}&select=amount_light,function_name,reason,from_user_id,created_at&order=created_at.desc&limit=20`,
        { headers },
      ),
    ]);

    if (!periodRes.ok || !lifetimeRes.ok || !recentRes.ok) {
      throw new Error("Failed to query transfers");
    }

    const periodTransfers = await periodRes.json() as Array<{
      amount_light: number;
      function_name: string | null;
      reason: string;
      created_at: string;
    }>;

    const lifetimeTransfers = await lifetimeRes.json() as Array<
      { amount_light: number }
    >;
    const lifetimeCount = parseInt(
      lifetimeRes.headers.get("content-range")?.split("/")[1] || "0",
      10,
    );

    const recentTransfers = await recentRes.json() as Array<{
      amount_light: number;
      function_name: string | null;
      reason: string;
      from_user_id: string;
      created_at: string;
    }>;

    // Calculate lifetime total
    const totalEarnedLight = lifetimeTransfers.reduce(
      (sum, t) => sum + t.amount_light,
      0,
    );

    // Calculate period total
    const periodEarnedLight = periodTransfers.reduce(
      (sum, t) => sum + t.amount_light,
      0,
    );

    // Build daily aggregation for charting
    const dailyMap = new Map<
      string,
      { earned_light: number; transfer_count: number }
    >();
    for (const t of periodTransfers) {
      const date = t.created_at.slice(0, 10); // YYYY-MM-DD
      const entry = dailyMap.get(date) ||
        { earned_light: 0, transfer_count: 0 };
      entry.earned_light += t.amount_light;
      entry.transfer_count += 1;
      dailyMap.set(date, entry);
    }

    // Fill in missing days with zeros for a complete chart
    const daily: Array<
      { date: string; earned_light: number; transfer_count: number }
    > = [];
    const startDate = new Date(cutoff);
    const endDate = new Date();
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      const dateStr = d.toISOString().slice(0, 10);
      const entry = dailyMap.get(dateStr);
      daily.push({
        date: dateStr,
        earned_light: entry?.earned_light || 0,
        transfer_count: entry?.transfer_count || 0,
      });
    }

    // Build by-function breakdown
    const fnMap = new Map<
      string,
      { earned_light: number; call_count: number }
    >();
    for (const t of periodTransfers) {
      const fn = t.function_name || t.reason || "unknown";
      const entry = fnMap.get(fn) || { earned_light: 0, call_count: 0 };
      entry.earned_light += t.amount_light;
      entry.call_count += 1;
      fnMap.set(fn, entry);
    }
    const byFunction = Array.from(fnMap.entries())
      .map(([function_name, data]) => ({ function_name, ...data }))
      .sort((a, b) => b.earned_light - a.earned_light);

    return json({
      total_earned_light: totalEarnedLight,
      total_transfers: lifetimeCount,
      period,
      period_earned_light: periodEarnedLight,
      period_transfers: periodTransfers.length,
      daily,
      by_function: byFunction,
      recent: recentTransfers.map((t) => ({
        amount_light: t.amount_light,
        function_name: t.function_name,
        reason: t.reason,
        created_at: t.created_at,
      })),
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to get earnings:", err);
    return error("Failed to get earnings data", 500);
  }
}

// ============================================
// HEALTH MONITORING HANDLERS
// ============================================

/**
 * Get health status and detected issues for an app (owner only).
 * Failures are detected automatically every 30 min.
 * Agents fix issues via ul.logs({ health: true }) + ul.upload.
 * GET /api/apps/:appId/health
 */
async function handleGetAppCallLog(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    const appsService = createAppsService();
    const app = await appsService.findById(appId);
    if (!app) return error("App not found", 404);
    if (app.owner_id !== user.id) return error("Unauthorized", 403);

    const { getAppCallLog } = await import("../services/call-logger.ts");
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    callLogLogger.debug("Fetching app call log", { app_id: appId, limit });
    const logs = await getAppCallLog(appId, { limit: Math.min(limit, 200) });
    callLogLogger.info("Fetched app call log", {
      app_id: appId,
      count: logs.length,
    });
    return json({ logs });
  } catch (err: any) {
    if (err.message === "Not authenticated") return error("Unauthorized", 401);
    callLogLogger.error("Failed to fetch app call log", {
      app_id: appId,
      error: err,
    });
    return error(err?.message || "Failed to get call logs", 500);
  }
}

async function handleGetHealth(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    const appsService = createAppsService();
    const app = await appsService.findById(appId);
    if (!app) return error("App not found", 404);
    if (app.owner_id !== user.id) return error("Unauthorized", 403);

    const SUPABASE_URL = getEnv("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const headers = {
      "apikey": SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    };

    // Fetch recent health events
    const eventsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_health_events?app_id=eq.${appId}&select=*&order=created_at.desc&limit=20`,
      { headers },
    );

    const events = eventsRes.ok ? await eventsRes.json() : [];

    // Fetch recent error rate from call logs (last 2 hours)
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const logsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/mcp_call_logs?app_id=eq.${appId}&created_at=gte.${cutoff}&select=function_name,success&limit=5000`,
      { headers },
    );

    const logs = logsRes.ok
      ? await logsRes.json() as Array<
        { function_name: string; success: boolean }
      >
      : [];

    // Aggregate error rates per function
    const fnStats = new Map<string, { total: number; failed: number }>();
    for (const log of logs) {
      const entry = fnStats.get(log.function_name) || { total: 0, failed: 0 };
      entry.total++;
      if (!log.success) entry.failed++;
      fnStats.set(log.function_name, entry);
    }

    const functionHealth = Array.from(fnStats.entries()).map(([fn, stats]) => ({
      function_name: fn,
      total_calls: stats.total,
      failed_calls: stats.failed,
      error_rate: stats.total > 0 ? stats.failed / stats.total : 0,
    })).sort((a, b) => b.error_rate - a.error_rate);

    return json({
      health_status: app.health_status || "healthy",
      auto_heal_enabled: app.auto_heal_enabled !== false,
      function_health: functionHealth,
      events,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    console.error("Failed to get health:", err);
    return error("Failed to get health data", 500);
  }
}

/**
 * Toggle health monitoring for an app (owner only)
 * PATCH /api/apps/:appId/health
 * Body: { auto_heal_enabled: boolean }
 */
async function handleUpdateHealth(
  request: Request,
  appId: string,
): Promise<Response> {
  try {
    const user = await authenticate(request);
    const appsService = createAppsService();
    const app = await appsService.findById(appId);
    if (!app) return error("App not found", 404);
    if (app.owner_id !== user.id) return error("Unauthorized", 403);

    const body = await request.json() as { auto_heal_enabled?: boolean };
    if (typeof body.auto_heal_enabled !== "boolean") {
      return error("auto_heal_enabled (boolean) is required", 400);
    }

    await appsService.update(appId, {
      auto_heal_enabled: body.auto_heal_enabled,
    });

    return json({
      success: true,
      auto_heal_enabled: body.auto_heal_enabled,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Authentication")) {
      return error("Authentication required", 401);
    }
    return error("Failed to update health settings", 500);
  }
}
