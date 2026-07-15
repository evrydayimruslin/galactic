import type { App } from "../../shared/types/index.ts";
import type {
  EnvSchemaEntry,
  ResolvedCredential,
} from "../../shared/contracts/env.ts";
import type { WidgetDependencyDeclaration } from "../../shared/contracts/widget.ts";
import { getEnv } from "../lib/env.ts";
import { buildAppSecretDiagnostics } from "./app-diagnostics.ts";
import {
  getScopedEnvSchemaEntries,
  resolveAppEnvSchema,
} from "./app-settings.ts";
import { createD1DataService } from "./d1-data.ts";
import { getD1DatabaseId } from "./d1-provisioning.ts";
import { decryptEnvVar, decryptEnvVars } from "./envvars.ts";
import { createR2Service } from "./storage.ts";
import {
  type DecryptedSupabaseConfig,
  getDecryptedPlatformSupabase,
  getDecryptedSupabaseConfig,
} from "./user-supabase-configs.ts";
import {
  type AppSupabaseResolutionLogInput,
  type AppSupabaseResolutionSource,
  logAppSupabaseResolution,
} from "./app-runtime-telemetry.ts";
import { createServerLogger, type LoggerLike } from "./logging.ts";
import { getManifestPermissions } from "./trust.ts";

export const APP_ENTRY_FILES = [
  "index.tsx",
  "index.ts",
  "index.jsx",
  "index.js",
] as const;

type RuntimeApp = Pick<
  App,
  | "id"
  | "owner_id"
  | "storage_key"
  | "env_vars"
  | "env_schema"
  | "manifest"
  | "d1_database_id"
  | "supabase_config_id"
  | "supabase_enabled"
  | "supabase_url"
  | "supabase_anon_key_encrypted"
  | "supabase_service_key_encrypted"
>;

type AppCodeCache = {
  get: (appId: string, storageKey: string) => string | null | undefined;
  set: (appId: string, storageKey: string, code: string) => void;
};

interface FetchAppEntryCodeOptions {
  r2Service?: ReturnType<typeof createR2Service>;
  codeCache?: AppCodeCache;
  entryFiles?: readonly string[];
  onCacheHit?: (code: string) => void;
  onCacheMiss?: () => void;
  onFileLoaded?: (entryFile: string, code: string) => void;
}

interface RuntimeResourceDeps {
  decryptEnvVarsFn?: typeof decryptEnvVars;
  decryptEnvVarFn?: typeof decryptEnvVar;
  getDecryptedSupabaseConfigFn?: typeof getDecryptedSupabaseConfig;
  getDecryptedPlatformSupabaseFn?: typeof getDecryptedPlatformSupabase;
  createD1DataServiceFn?: typeof createD1DataService;
  getD1DatabaseIdFn?: typeof getD1DatabaseId;
  logAppSupabaseResolutionFn?: (input: AppSupabaseResolutionLogInput) => void;
  logger?: LoggerLike;
  allowLegacyAppConfig?: boolean;
  allowPlatformDefault?: boolean;
  requireCanonicalWhenEnabled?: boolean;
}

interface ResolveAppRuntimeEnvVarsDeps extends RuntimeResourceDeps {
  fetchFn?: typeof fetch;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
}

interface UserAppSecretRow {
  key: string;
  value_encrypted: string;
}

export interface ResolvedAppRuntimeEnv {
  // Universal (developer-owned) vars only. Injected into the sandbox as
  // ultralight.env. Per-user secrets are NOT here — they are vaulted in
  // `credentials` and never enter the sandbox (Phase 3).
  envVars: Record<string, string>;
  // Per-user secrets, decrypted, keyed by env var name. Consumed HOST-SIDE only
  // (the CredentialBinding / NET binding); never stringified into the sandbox.
  credentials: Record<string, ResolvedCredential>;
  envSchema: Record<string, EnvSchemaEntry>;
  missingRequiredSecrets: string[];
}

export interface MissingAppSecretsErrorDetails {
  type: "MISSING_SECRETS";
  state: "not_required" | "ready" | "action_required";
  missing_secrets: string[];
  app_id: string;
  message: string;
  remediation: string;
  hint: string;
  connect_command: string | null;
}

export type AppSupabaseConfigState =
  | "disabled"
  | "saved_config"
  | "missing_saved_config"
  | "legacy_app_config"
  | "platform_default";

export function classifyAppSupabaseConfigState(
  app: Pick<
    RuntimeApp,
    | "supabase_config_id"
    | "supabase_enabled"
    | "supabase_url"
    | "supabase_anon_key_encrypted"
  >,
): AppSupabaseConfigState {
  if (app.supabase_config_id) {
    return "saved_config";
  }

  if (!app.supabase_enabled) {
    return "disabled";
  }

  if (app.supabase_url && app.supabase_anon_key_encrypted) {
    return "legacy_app_config";
  }

  return "platform_default";
}

function getSupabaseMigrationMessage(
  reason: Exclude<AppSupabaseConfigState, "disabled" | "saved_config">,
): string {
  switch (reason) {
    case "missing_saved_config":
      return "This app references a saved Supabase server that is missing or invalid. Reassign a saved server in App Settings > Supabase before running it.";
    case "legacy_app_config":
      return "This app still uses legacy app-level Supabase credentials. Reconnect or assign a saved server in App Settings > Supabase before running it.";
    case "platform_default":
      return "This app still depends on the deprecated default Supabase server. Assign a saved server in App Settings > Supabase before running it.";
  }
}

export class SupabaseConfigMigrationRequiredError extends Error {
  readonly appId: string;
  readonly reason: Exclude<AppSupabaseConfigState, "disabled" | "saved_config">;

  constructor(
    appId: string,
    reason: Exclude<AppSupabaseConfigState, "disabled" | "saved_config">,
  ) {
    super(getSupabaseMigrationMessage(reason));
    this.name = "SupabaseConfigMigrationRequiredError";
    this.appId = appId;
    this.reason = reason;
  }
}

export async function fetchAppEntryCode(
  app: Pick<RuntimeApp, "id" | "storage_key">,
  options?: FetchAppEntryCodeOptions,
): Promise<string | null> {
  const codeCache = options?.codeCache;
  const cachedCode = codeCache?.get(app.id, app.storage_key);
  if (cachedCode) {
    options?.onCacheHit?.(cachedCode);
    return cachedCode;
  }

  options?.onCacheMiss?.();

  const r2Service = options?.r2Service ?? createR2Service();
  const entryFiles = options?.entryFiles ?? APP_ENTRY_FILES;

  for (const entryFile of entryFiles) {
    try {
      const code = await r2Service.fetchTextFile(
        `${app.storage_key}${entryFile}`,
      );
      if (!code) {
        continue;
      }
      codeCache?.set(app.id, app.storage_key, code);
      options?.onFileLoaded?.(entryFile, code);
      return code;
    } catch {
      // Try the next supported entry file.
    }
  }

  return null;
}

export async function resolveAppEnvVars(
  app: Pick<RuntimeApp, "env_vars">,
  deps?: RuntimeResourceDeps,
): Promise<Record<string, string>> {
  const decryptEnvVarsFn = deps?.decryptEnvVarsFn ?? decryptEnvVars;
  const logger = deps?.logger ?? createServerLogger("APP-RUNTIME");

  try {
    return await decryptEnvVarsFn(app.env_vars || {});
  } catch (err) {
    logger.error("Failed to decrypt env vars", {
      app_env_present: !!app.env_vars,
      error: err,
    });
    return {};
  }
}

export function buildMissingAppSecretsMessage(
  missingSecrets: string[],
): string {
  return `Missing required secrets: ${
    missingSecrets.join(", ")
  }. Use gx.secrets to provide them.`;
}

export function buildMissingAppSecretsErrorDetails(
  appId: string,
  missingSecrets: string[],
): MissingAppSecretsErrorDetails {
  const diagnostics = buildAppSecretDiagnostics({
    appId,
    declaredKeys: missingSecrets,
    requiredKeys: missingSecrets,
    connectedKeys: [],
    missingRequired: missingSecrets,
  });

  return {
    type: "MISSING_SECRETS",
    state: diagnostics.state,
    missing_secrets: missingSecrets,
    app_id: appId,
    message: diagnostics.message,
    remediation: diagnostics.remediation,
    hint: `Call gx.secrets with app_id="${appId}" and provide: ${
      missingSecrets.join(", ")
    }`,
    connect_command: diagnostics.connect_command,
  };
}

export async function resolveAppRuntimeEnvVars(
  app: Pick<RuntimeApp, "id" | "env_vars" | "env_schema" | "manifest">,
  userId: string | null | undefined,
  deps?: ResolveAppRuntimeEnvVarsDeps,
): Promise<ResolvedAppRuntimeEnv> {
  const decryptEnvVarFn = deps?.decryptEnvVarFn ?? decryptEnvVar;
  const fetchFn = deps?.fetchFn ?? fetch;
  const logger = deps?.logger ?? createServerLogger("APP-RUNTIME");
  const envVars = await resolveAppEnvVars(app, deps);
  const envSchema = resolveAppEnvSchema(app);
  const universalEntries = getScopedEnvSchemaEntries(envSchema, "universal");
  const perUserEntries = getScopedEnvSchemaEntries(envSchema, "per_user");
  const declaredPerUserKeys = new Set(perUserEntries.map(({ key }) => key));
  // All per-user values are resolved into this PARENT-SIDE map (host-side net.*
  // and the CredentialBinding resolve them by key). Non-secret CONFIG is ALSO
  // copied into envVars (readable) below; SECRETS live only here.
  const credentials: Record<string, ResolvedCredential> = {};
  // Secret/config split: a per-user var is a VAULTED SECRET iff input:"password"
  // or it declares a credential binding; otherwise it is readable CONFIG (host,
  // port, the user's email, etc.), injected into the sandbox like a universal var.
  const isVaultedSecret = (entry: EnvSchemaEntry): boolean =>
    entry.input === "password" || !!entry.credential;
  // Credential bindings are always parent-side, regardless of who owns the
  // value. Universal credentials are decrypted from the Agent store, moved to
  // the host credential map, and removed before sandbox env injection.
  for (const { key, entry } of universalEntries) {
    if (!entry.credential) continue;
    const value = envVars[key];
    if (typeof value === "string") {
      credentials[key] = { value, credential: entry.credential };
    }
    delete envVars[key];
  }
  // Remove any app-level default for a per-user SECRET key — secrets must never
  // sit in the sandbox env, even as a developer default.
  for (const { key, entry } of perUserEntries) {
    if (isVaultedSecret(entry)) delete envVars[key];
  }

  if (perUserEntries.length > 0 && userId) {
    const supabaseUrl = deps?.supabaseUrl ?? getEnv("SUPABASE_URL");
    const supabaseServiceRoleKey = deps?.supabaseServiceRoleKey ??
      getEnv("SUPABASE_SERVICE_ROLE_KEY");

    try {
      const secretsRes = await fetchFn(
        `${supabaseUrl}/rest/v1/user_app_secrets?user_id=eq.${userId}&app_id=eq.${app.id}&select=key,value_encrypted`,
        {
          headers: {
            "apikey": supabaseServiceRoleKey,
            "Authorization": `Bearer ${supabaseServiceRoleKey}`,
          },
        },
      );

      const userSecrets = secretsRes.ok
        ? await secretsRes.json() as UserAppSecretRow[]
        : [];

      for (const secret of userSecrets) {
        // The live manifest/schema is the authority boundary. Rows may outlive
        // an older version's declaration; never decrypt or expose a dormant row
        // merely because generated code guessed its historic key.
        if (!declaredPerUserKeys.has(secret.key)) continue;
        try {
          const value = await decryptEnvVarFn(secret.value_encrypted);
          const entry = envSchema[secret.key];
          credentials[secret.key] = { value, credential: entry.credential };
          // Non-secret per-user CONFIG (host/port/email/name) is readable in the
          // sandbox env, like a universal var. Actual SECRETS stay vaulted-only.
          if (!isVaultedSecret(entry)) {
            envVars[secret.key] = value;
          }
        } catch (err) {
          logger.error("Failed to decrypt per-user secret", {
            app_id: app.id,
            user_id: userId,
            secret_key: secret.key,
            error: err,
          });
        }
      }
    } catch (err) {
      logger.error("Failed to load per-user secrets", {
        app_id: app.id,
        user_id: userId,
        error: err,
      });
    }
  }

  const missingRequiredUniversal = universalEntries
    .filter(({ entry }) => entry.required)
    .map(({ key, entry }) => ({ key, credential: Boolean(entry.credential) }))
    .filter(({ key, credential }) =>
      credential
        ? !credentials[key] || credentials[key].value.length === 0
        : typeof envVars[key] !== "string" || envVars[key].length === 0
    )
    .map(({ key }) => key);
  const missingRequiredPerUser = perUserEntries
    .filter(({ entry }) => entry.required)
    .map(({ key }) => key)
    .filter((key) => !credentials[key] || credentials[key].value.length === 0);
  const missingRequiredSecrets = [
    ...missingRequiredUniversal,
    ...missingRequiredPerUser,
  ];

  return { envVars, credentials, envSchema, missingRequiredSecrets };
}

export async function resolveAppSupabaseConfig(
  app: Pick<
    RuntimeApp,
    | "id"
    | "owner_id"
    | "supabase_config_id"
    | "supabase_enabled"
    | "supabase_url"
    | "supabase_anon_key_encrypted"
    | "supabase_service_key_encrypted"
  >,
  deps?: RuntimeResourceDeps,
): Promise<DecryptedSupabaseConfig | undefined> {
  const decryptEnvVarFn = deps?.decryptEnvVarFn ?? decryptEnvVar;
  const getDecryptedSupabaseConfigFn = deps?.getDecryptedSupabaseConfigFn ??
    getDecryptedSupabaseConfig;
  const getDecryptedPlatformSupabaseFn = deps?.getDecryptedPlatformSupabaseFn ??
    getDecryptedPlatformSupabase;
  const logAppSupabaseResolutionFn = deps?.logAppSupabaseResolutionFn ??
    logAppSupabaseResolution;
  const logger = deps?.logger ?? createServerLogger("APP-RUNTIME");
  const allowLegacyAppConfig = deps?.allowLegacyAppConfig ?? false;
  const allowPlatformDefault = deps?.allowPlatformDefault ?? false;
  const requireCanonicalWhenEnabled = deps?.requireCanonicalWhenEnabled ?? true;
  const resolutionNotes: string[] = [];
  const appState = classifyAppSupabaseConfigState(app);
  const logResolution = (source: AppSupabaseResolutionSource): void => {
    logAppSupabaseResolutionFn({
      appId: app.id,
      ownerId: app.owner_id,
      source,
      supabaseEnabled: !!app.supabase_enabled,
      hasConfigId: !!app.supabase_config_id,
      hasLegacyAppConfig:
        !!(app.supabase_url && app.supabase_anon_key_encrypted),
      note: resolutionNotes.length > 0 ? resolutionNotes.join(",") : undefined,
    });
  };

  if (app.supabase_config_id) {
    try {
      const config = await getDecryptedSupabaseConfigFn(app.supabase_config_id);
      if (config) {
        logResolution("saved_config");
        return config;
      }
      resolutionNotes.push("saved_config_missing");
    } catch (err) {
      logger.error("Failed to get saved Supabase config by ID", {
        app_id: app.id,
        supabase_config_id: app.supabase_config_id,
        error: err,
      });
      resolutionNotes.push("saved_config_error");
    }
  }

  if (
    app.supabase_enabled && app.supabase_url && app.supabase_anon_key_encrypted
  ) {
    if (allowLegacyAppConfig) {
      try {
        const anonKey = await decryptEnvVarFn(app.supabase_anon_key_encrypted);
        const config: DecryptedSupabaseConfig = {
          url: app.supabase_url,
          anonKey,
        };
        if (app.supabase_service_key_encrypted) {
          config.serviceKey = await decryptEnvVarFn(
            app.supabase_service_key_encrypted,
          );
        }
        logResolution("legacy_app_config");
        return config;
      } catch (err) {
        logger.error("Failed to decrypt legacy app-level Supabase config", {
          app_id: app.id,
          error: err,
        });
        resolutionNotes.push("legacy_app_config_error");
      }
    } else {
      resolutionNotes.push("legacy_app_config_disabled");
    }
  } else if (app.supabase_enabled) {
    resolutionNotes.push("legacy_app_config_unavailable");
  }

  if (app.supabase_enabled) {
    if (allowPlatformDefault) {
      try {
        const platformConfig = await getDecryptedPlatformSupabaseFn(
          app.owner_id,
        );
        if (platformConfig) {
          logResolution("platform_default");
          return platformConfig;
        }
        resolutionNotes.push("platform_default_missing");
      } catch (err) {
        logger.error("Failed to get platform default Supabase config", {
          app_id: app.id,
          owner_id: app.owner_id,
          error: err,
        });
        resolutionNotes.push("platform_default_error");
      }
    } else {
      resolutionNotes.push("platform_default_disabled");
    }
  }

  logResolution("none");

  if (app.supabase_enabled && requireCanonicalWhenEnabled) {
    const reason = appState === "saved_config"
      ? "missing_saved_config"
      : appState === "disabled"
      ? "platform_default"
      : appState;
    throw new SupabaseConfigMigrationRequiredError(app.id, reason);
  }

  return undefined;
}

export async function createAppD1Resources(
  app: Pick<RuntimeApp, "id" | "d1_database_id">,
  deps?: RuntimeResourceDeps,
): Promise<{
  d1DatabaseId: string | null;
  d1DataService: ReturnType<typeof createD1DataService> | null;
}> {
  const getD1DatabaseIdFn = deps?.getD1DatabaseIdFn ?? getD1DatabaseId;
  const createD1DataServiceFn = deps?.createD1DataServiceFn ??
    createD1DataService;
  const d1DatabaseId = app.d1_database_id || await getD1DatabaseIdFn(app.id);
  if (!d1DatabaseId) {
    return {
      d1DatabaseId: null,
      d1DataService: null,
    };
  }
  return {
    d1DatabaseId,
    d1DataService: createD1DataServiceFn(app.id, d1DatabaseId),
  };
}

interface AppD1StorageDisclosure {
  type: "d1";
  status: App["d1_status"] | "unknown";
  provisioned: boolean;
  migration_version: number;
  note: string;
}

export function resolveAppD1StorageDisclosure(
  app: Pick<
    App,
    "d1_database_id" | "d1_status" | "d1_last_migration_version"
  >,
): AppD1StorageDisclosure | null {
  if (!app.d1_database_id && !app.d1_status) return null;
  return {
    type: "d1",
    status: app.d1_status || "unknown",
    provisioned: Boolean(app.d1_database_id),
    migration_version: Number.isInteger(app.d1_last_migration_version)
      ? Math.max(0, app.d1_last_migration_version)
      : 0,
    note:
      "Agent-owned Galactic D1 storage. Data remains scoped by Agent and user.",
  };
}

export function resolveManifestPermissions(
  app: Pick<RuntimeApp, "manifest">,
  basePermissions: string[],
  allowedManifestPermissions = ["net:connect"],
): string[] {
  const permissions = [...basePermissions];

  try {
    const rawManifest = app.manifest;
    const parsed = typeof rawManifest === "string"
      ? JSON.parse(rawManifest)
      : rawManifest;
    const manifestPermissions = Array.isArray(parsed?.permissions)
      ? parsed.permissions
      : [];

    for (const permission of manifestPermissions) {
      if (
        typeof permission === "string" &&
        allowedManifestPermissions.includes(permission) &&
        !permissions.includes(permission)
      ) {
        permissions.push(permission);
      }
    }
  } catch {
    // Invalid manifest payloads should not crash execution setup.
  }

  return permissions;
}

// Durable execution: max budget a queue-consumer execution may run. Bounded
// by the queue consumer's 15-min wall budget with settlement headroom.
export const MAX_ASYNC_EXECUTION_MS = 300_000;

interface FunctionExecutionPolicy {
  // True when the manifest declares execution.class 'async' for the function.
  async: boolean;
  // Consumer budget for async executions: manifest timeout_ms may LOWER the
  // platform ceiling, never raise it.
  timeoutMs: number;
}

/**
 * Read a function's declared execution policy from the app manifest.
 * Malformed manifests resolve to the synchronous default — never crash
 * execution setup.
 */
export function resolveFunctionExecutionPolicy(
  app: Pick<RuntimeApp, "manifest">,
  functionName: string,
): FunctionExecutionPolicy {
  const fallback: FunctionExecutionPolicy = {
    async: false,
    timeoutMs: MAX_ASYNC_EXECUTION_MS,
  };
  try {
    const rawManifest = app.manifest;
    const parsed = typeof rawManifest === "string"
      ? JSON.parse(rawManifest)
      : rawManifest;
    const fn = parsed?.functions?.[functionName];
    const execution = fn && typeof fn === "object"
      ? (fn as { execution?: unknown }).execution
      : undefined;
    if (!execution || typeof execution !== "object") return fallback;
    const { class: executionClass, timeout_ms: timeoutMs } = execution as {
      class?: unknown;
      timeout_ms?: unknown;
    };
    return {
      async: executionClass === "async",
      timeoutMs:
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) &&
          timeoutMs > 0
          ? Math.min(Math.floor(timeoutMs), MAX_ASYNC_EXECUTION_MS)
          : MAX_ASYNC_EXECUTION_MS,
    };
  } catch {
    return fallback;
  }
}

const STRICT_RUNTIME_PERMISSIONS = new Set([
  "storage:read",
  "storage:write",
  "storage:delete",
  "memory:read",
  "memory:write",
  "ai:call",
  "ai:embed",
  "net:fetch",
  "net:connect",
  "app:call",
  "gpu:execute",
  "notify:owner",
]);

export interface StrictRuntimePermissionResolution {
  permissions: string[];
  manifestBacked: boolean;
  ignoredPermissions: string[];
}

export interface RuntimeAppCallDependency {
  app: string;
  functions: string[];
  access: "read" | "write";
}

type RuntimeDependencyAccess = RuntimeAppCallDependency["access"];
type RuntimeDependencyMap = Map<string, Map<string, RuntimeDependencyAccess>>;

interface RoutineActorCapabilityLike {
  app_id?: string | null;
  app_ref?: string | null;
  function_name?: string | null;
  access?: RuntimeDependencyAccess | null;
}

interface RuntimeCallerLike {
  routineActor?: {
    capabilities?: RoutineActorCapabilityLike[];
  };
}

function addRuntimeAppCallDependency(
  byApp: RuntimeDependencyMap,
  app: string,
  functionName: string,
  access: RuntimeDependencyAccess,
): void {
  const appKey = app.trim();
  const fn = functionName.trim();
  if (!appKey || !fn) return;

  const existingFunctions = byApp.get(appKey) ?? new Map();
  const existingAccess = existingFunctions.get(fn);
  existingFunctions.set(
    fn,
    existingAccess === "write" || access === "write" ? "write" : "read",
  );
  byApp.set(appKey, existingFunctions);
}

function flattenRuntimeAppCallDependencies(
  byApp: RuntimeDependencyMap,
): RuntimeAppCallDependency[] {
  const dependencies: RuntimeAppCallDependency[] = [];
  const sortedApps = Array.from(byApp.keys()).sort((a, b) =>
    a.localeCompare(b)
  );

  for (const app of sortedApps) {
    const functionsByAccess = byApp.get(app);
    if (!functionsByAccess) continue;

    for (const access of ["read", "write"] as const) {
      const functions = Array.from(functionsByAccess.entries())
        .filter(([, fnAccess]) => fnAccess === access)
        .map(([fn]) => fn)
        .sort((a, b) => a.localeCompare(b));
      if (functions.length === 0) continue;
      dependencies.push({ app, functions, access });
    }
  }

  return dependencies;
}

function collectWidgetAppCallDependencies(
  dependencies: unknown,
  byApp: RuntimeDependencyMap,
): void {
  if (!Array.isArray(dependencies)) return;

  for (const dependency of dependencies) {
    if (
      !dependency || typeof dependency !== "object" || Array.isArray(dependency)
    ) continue;
    const dep = dependency as WidgetDependencyDeclaration;
    const app = typeof dep.app === "string" ? dep.app.trim() : "";
    const access = dep.access ?? "read";
    if (!app || access !== "read" || !Array.isArray(dep.functions)) continue;

    const functions = dep.functions
      .filter((fn): fn is string => typeof fn === "string" && !!fn.trim())
      .map((fn) => fn.trim());
    if (functions.length === 0) continue;

    for (const fn of functions) {
      addRuntimeAppCallDependency(byApp, app, fn, "read");
    }
  }
}

function collectManifestWidgetAppCallDependencies(
  app: Pick<RuntimeApp, "manifest">,
  byApp: RuntimeDependencyMap,
): void {
  let parsed: unknown;
  try {
    parsed = typeof app.manifest === "string"
      ? JSON.parse(app.manifest)
      : app.manifest;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

  const manifest = parsed as { widgets?: unknown };
  if (!Array.isArray(manifest.widgets)) return;

  for (const widget of manifest.widgets) {
    if (!widget || typeof widget !== "object" || Array.isArray(widget)) {
      continue;
    }
    const widgetRecord = widget as { dependencies?: unknown; cards?: unknown };
    collectWidgetAppCallDependencies(widgetRecord.dependencies, byApp);
    if (Array.isArray(widgetRecord.cards)) {
      for (const card of widgetRecord.cards) {
        if (!card || typeof card !== "object" || Array.isArray(card)) continue;
        collectWidgetAppCallDependencies(
          (card as { dependencies?: unknown }).dependencies,
          byApp,
        );
      }
    }
  }
}

export function resolveWidgetAppCallDependencies(
  app: Pick<RuntimeApp, "manifest">,
): RuntimeAppCallDependency[] {
  const byApp: RuntimeDependencyMap = new Map();
  collectManifestWidgetAppCallDependencies(app, byApp);
  return flattenRuntimeAppCallDependencies(byApp);
}

// Top-level manifest declaration of functions on OTHER Agents this app calls
// (manifest.external_functions). This is the P5 cross-Agent dependency
// mechanism that generalizes the widget-scoped `dependencies` declarations.
function collectManifestExternalFunctionDependencies(
  app: Pick<RuntimeApp, "manifest">,
  byApp: RuntimeDependencyMap,
): void {
  let parsed: unknown;
  try {
    parsed = typeof app.manifest === "string"
      ? JSON.parse(app.manifest)
      : app.manifest;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

  const manifest = parsed as { external_functions?: unknown };
  if (!Array.isArray(manifest.external_functions)) return;

  for (const dependency of manifest.external_functions) {
    if (
      !dependency || typeof dependency !== "object" || Array.isArray(dependency)
    ) continue;
    const dep = dependency as {
      app?: unknown;
      functions?: unknown;
      access?: unknown;
    };
    const targetApp = typeof dep.app === "string" ? dep.app.trim() : "";
    if (!targetApp || !Array.isArray(dep.functions)) continue;
    const access = dep.access === "write" ? "write" : "read";

    for (const fn of dep.functions) {
      if (typeof fn !== "string" || !fn.trim()) continue;
      addRuntimeAppCallDependency(byApp, targetApp, fn.trim(), access);
    }
  }
}


function collectRoutineActorAppCallDependencies(
  caller: RuntimeCallerLike | undefined,
  byApp: RuntimeDependencyMap,
): void {
  const capabilities = caller?.routineActor?.capabilities;
  if (!Array.isArray(capabilities)) return;

  for (const capability of capabilities) {
    const functionName = typeof capability.function_name === "string"
      ? capability.function_name.trim()
      : "";
    if (!functionName) continue;

    const access = capability.access === "write" ? "write" : "read";
    for (const app of [capability.app_id, capability.app_ref]) {
      if (typeof app !== "string" || !app.trim()) continue;
      addRuntimeAppCallDependency(byApp, app, functionName, access);
    }
  }
}

export function resolveRoutineActorAppCallDependencies(
  caller: RuntimeCallerLike | undefined,
): RuntimeAppCallDependency[] {
  const byApp: RuntimeDependencyMap = new Map();
  collectRoutineActorAppCallDependencies(caller, byApp);
  return flattenRuntimeAppCallDependencies(byApp);
}

export function resolveRuntimeAppCallDependencies(
  app: Pick<RuntimeApp, "manifest">,
  caller?: RuntimeCallerLike,
): RuntimeAppCallDependency[] {
  const byApp: RuntimeDependencyMap = new Map();
  collectManifestExternalFunctionDependencies(app, byApp);
  collectManifestWidgetAppCallDependencies(app, byApp);
  collectRoutineActorAppCallDependencies(caller, byApp);
  return flattenRuntimeAppCallDependencies(byApp);
}

export function resolveStrictManifestPermissions(
  app: Pick<RuntimeApp, "manifest">,
): StrictRuntimePermissionResolution {
  const manifestPermissions = getManifestPermissions(app.manifest);
  const permissions: string[] = [];
  const ignoredPermissions: string[] = [];

  for (const permission of manifestPermissions) {
    if (STRICT_RUNTIME_PERMISSIONS.has(permission)) {
      permissions.push(permission);
    } else {
      ignoredPermissions.push(permission);
    }
  }

  return {
    permissions: [...new Set(permissions)],
    manifestBacked: !!app.manifest,
    ignoredPermissions,
  };
}
