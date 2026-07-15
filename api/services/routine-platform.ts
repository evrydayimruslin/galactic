import { getEnv } from "../lib/env.ts";
import type { App } from "../../shared/types/index.ts";
import {
  type RoutineApprovalPolicy,
  type RoutineBudgetDefaults,
  type RoutineCapabilityDeclaration,
  type RoutineScheduleDeclaration,
} from "../../shared/contracts/routine.ts";
import {
  parseAppManifest,
} from "./app-settings.ts";
import {
  resolveAppRuntimeEnvVars,
  resolveStrictManifestPermissions,
} from "./app-runtime-resources.ts";
import { resolveCallerGrant } from "./agent-grants.ts";
import {
  loadLiveExecutedBundle,
  verifyExecutedBundle,
} from "./executed-bundle.ts";
import {
  buildRoutineIndexForApp,
  type RoutineIndexEntry,
} from "./codemode-tools.ts";
import {
  createRoutine,
  createRoutineRun,
  deleteRoutine,
  getRoutine,
  listRoutines,
  normalizeRoutineBudgetPolicy,
  pauseRoutine,
  resumeRoutine,
  routineCapabilitiesFromManifest,
  type RoutineCapabilityInput,
  type RoutineCreateInput,
  type RoutineDashboardBindingInput,
  type RoutineStatus,
  type StoredRoutine,
  updateRoutine,
} from "./routines.ts";

export const ROUTINE_PLATFORM_ACTIONS = [
  "templates",
  "plan",
  "create",
  "list",
  "get",
  "update",
  "pause",
  "resume",
  "delete",
  "run_now",
] as const;

export type RoutinePlatformAction = typeof ROUTINE_PLATFORM_ACTIONS[number];

export const ROUTINE_PLATFORM_INVALID_PARAMS = -32602;
export const ROUTINE_PLATFORM_NOT_FOUND = -32002;
export const ROUTINE_PLATFORM_FORBIDDEN = -32003;

const APP_SELECT =
  "id,owner_id,slug,name,description,visibility,manifest,current_version,updated_at,env_schema,env_vars";

export class RoutinePlatformError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RoutinePlatformError";
    this.code = code;
    this.data = data;
  }
}

interface RoutineTemplateApp {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description?: string | null;
  visibility: App["visibility"] | string;
  manifest?: unknown;
  current_version?: string | null;
  updated_at?: string | null;
  env_schema?: unknown;
  env_vars?: Record<string, string> | null;
}

export interface RoutineTemplateSummary extends RoutineIndexEntry {
  templateKey: string;
  appDescription?: string | null;
  appVisibility?: string;
  appVersion?: string | null;
  appUpdatedAt?: string | null;
  appOwnerId: string;
  createExample: {
    action: "create";
    app_id: string;
    template_id: string;
  };
}

interface PlannedRoutine {
  template: RoutineTemplateSummary;
  routine: RoutineCreateInput;
  pendingCapabilities: RoutineCapabilityInput[];
  approvedCapabilities: RoutineCapabilityInput[];
  createArgs: Record<string, unknown>;
}

function serviceHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

function restUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${getEnv("SUPABASE_URL")}/rest/v1/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function readRows<T>(res: Response, label: string): Promise<T[]> {
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(`${label} (${res.status}): ${message}`);
  }
  const value = await res.json();
  return Array.isArray(value) ? value as T[] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      `${field} is required`,
    );
  }
  return normalized;
}

function isAction(value: string): value is RoutinePlatformAction {
  return ROUTINE_PLATFORM_ACTIONS.includes(value as RoutinePlatformAction);
}

function numericLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function objectOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function templateSearchText(template: RoutineTemplateSummary): string {
  const capabilityText = (template.capabilities || [])
    .flatMap((capability) => [
      capability.app,
      ...(capability.functions || []),
      capability.purpose || "",
    ])
    .join(" ");
  return [
    template.id,
    template.templateKey,
    template.label,
    template.description || "",
    template.appName,
    template.appSlug,
    capabilityText,
  ].join(" ").toLowerCase();
}

function buildTemplatesForApp(
  app: RoutineTemplateApp,
): RoutineTemplateSummary[] {
  const manifest = parseAppManifest(app.manifest);
  if (!manifest?.routines?.length) return [];

  return buildRoutineIndexForApp({
    id: app.id,
    name: app.name,
    slug: app.slug,
    manifest: {
      functions: manifest.functions,
      widgets: manifest.widgets,
      routines: manifest.routines,
    },
  }).map((template) => ({
    ...template,
    templateKey: `${app.slug}/${template.id}`,
    appDescription: app.description ?? null,
    appVisibility: app.visibility,
    appVersion: app.current_version ?? null,
    appUpdatedAt: app.updated_at ?? null,
    appOwnerId: app.owner_id,
    createExample: {
      action: "create",
      app_id: app.id,
      template_id: template.id,
    },
  }));
}

function dedupeApps(apps: RoutineTemplateApp[]): RoutineTemplateApp[] {
  const byId = new Map<string, RoutineTemplateApp>();
  for (const app of apps) {
    if (!app?.id || byId.has(app.id)) continue;
    byId.set(app.id, app);
  }
  return Array.from(byId.values());
}

async function fetchApps(
  params: Record<string, string>,
): Promise<RoutineTemplateApp[]> {
  return await readRows<RoutineTemplateApp>(
    await fetch(restUrl("apps", { ...params, select: APP_SELECT }), {
      headers: serviceHeaders(),
    }),
    "Failed to load routine template apps",
  );
}

async function appIsAccessible(
  userId: string,
  app: RoutineTemplateApp,
): Promise<boolean> {
  if (app.owner_id === userId) return true;
  if (app.visibility === "public" || app.visibility === "unlisted") {
    return true;
  }

  const rows = await readRows<{ id: string }>(
    await fetch(
      restUrl("user_app_permissions", {
        app_id: `eq.${app.id}`,
        granted_to_user_id: `eq.${userId}`,
        allowed: "eq.true",
        select: "id",
        limit: "1",
      }),
      { headers: serviceHeaders() },
    ),
    "Failed to check routine template app permissions",
  );
  return rows.length > 0;
}

async function loadAccessibleApp(
  userId: string,
  appIdOrSlug: string,
): Promise<RoutineTemplateApp> {
  const candidates: RoutineTemplateApp[] = [];

  if (isUuid(appIdOrSlug)) {
    candidates.push(
      ...await fetchApps({
        id: `eq.${appIdOrSlug}`,
        deleted_at: "is.null",
        limit: "1",
      }),
    );
  }

  candidates.push(
    ...await fetchApps({
      slug: `eq.${appIdOrSlug}`,
      deleted_at: "is.null",
      limit: "10",
    }),
  );

  for (const app of dedupeApps(candidates)) {
    if (await appIsAccessible(userId, app)) return app;
  }

  if (candidates.length > 0) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_FORBIDDEN,
      "This routine template app is private and you do not have access",
    );
  }
  throw new RoutinePlatformError(
    ROUTINE_PLATFORM_NOT_FOUND,
    `Routine template app not found: ${appIdOrSlug}`,
  );
}

async function listTemplateApps(
  userId: string,
  limit: number,
): Promise<RoutineTemplateApp[]> {
  const ownedApps = await fetchApps({
    owner_id: `eq.${userId}`,
    visibility: "eq.private",
    deleted_at: "is.null",
    order: "updated_at.desc",
    limit: String(limit),
  });
  return dedupeApps(ownedApps);
}

function assertPrivateOwnedTemplate(
  userId: string,
  template: RoutineTemplateSummary,
): void {
  if (template.appOwnerId !== userId || template.appVisibility !== "private") {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_FORBIDDEN,
      "Persistent Agents must be created from an Agent you own with private visibility.",
    );
  }
}

function assertIntervalSchedule(schedule: unknown): void {
  if (!isRecord(schedule) || typeof schedule.cron === "string" || schedule.type === "cron") {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "Launch routines use interval schedules only. Cron remains available internally but is not part of the launch contract.",
    );
  }
  const seconds = typeof schedule.every_seconds === "number"
    ? schedule.every_seconds
    : typeof schedule.every_minutes === "number"
    ? schedule.every_minutes * 60
    : 0;
  if (!Number.isFinite(seconds) || seconds < 60) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "Routine cadence must be an interval of at least 60 seconds.",
    );
  }
}

async function assertNoExistingPrimaryRoutine(
  userId: string,
  composerAppId: string,
  exceptRoutineId?: string,
): Promise<void> {
  const rows = await readRows<{ id: string }>(
    await fetch(
      restUrl("user_routines", {
        user_id: `eq.${userId}`,
        composer_app_id: `eq.${composerAppId}`,
        deleted_at: "is.null",
        select: "id",
        limit: "2",
      }),
      { headers: serviceHeaders() },
    ),
    "Failed to check primary routine",
  );
  if (rows.some((row) => row.id !== exceptRoutineId)) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "This Agent already has its primary routine. The launch contract supports one primary routine per Agent.",
    );
  }
}

function isLaunchPrimaryUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("idx_user_routines_one_launch_primary");
}

async function validateRequiredCapabilityTargets(
  userId: string,
  capabilities: RoutineCapabilityInput[],
  options: { activation?: boolean } = {},
): Promise<void> {
  const authority = capabilities.filter((capability) =>
    capability.required !== false ||
    (options.activation && capability.approved === true)
  );
  await Promise.all(authority.map(async (capability) => {
    const ref = optionalString(capability.app_id) ||
      optionalString(capability.app_ref) || optionalString(capability.app);
    if (!ref) return;
    let target: RoutineTemplateApp;
    try {
      target = await loadAccessibleApp(userId, ref);
    } catch (err) {
      if (
        err instanceof RoutinePlatformError &&
        err.code === ROUTINE_PLATFORM_NOT_FOUND &&
        !options.activation
      ) {
        // Slugs may resolve only after another private Agent is uploaded. It
        // remains pending and cannot activate until account approval resolves it.
        return;
      }
      if (
        options.activation && err instanceof RoutinePlatformError &&
        err.code === ROUTINE_PLATFORM_NOT_FOUND
      ) {
        throw new RoutinePlatformError(
          ROUTINE_PLATFORM_INVALID_PARAMS,
          `Capability target ${ref} must resolve to one of your private Agents before activation.`,
        );
      }
      throw err;
    }
    if (target.owner_id !== userId || target.visibility !== "private") {
      throw new RoutinePlatformError(
        ROUTINE_PLATFORM_FORBIDDEN,
        `Required capability target ${ref} must be one of your private Agents.`,
      );
    }
  }));
}

async function assertRequiredRoutineSettings(
  userId: string,
  app: RoutineTemplateApp,
): Promise<void> {
  const resolved = await resolveAppRuntimeEnvVars(
    app as Parameters<typeof resolveAppRuntimeEnvVars>[0],
    userId,
  );
  const missing = resolved.missingRequiredSecrets;
  if (missing.length > 0) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      `Required Agent settings are missing: ${missing.join(", ")}.`,
      { missing_settings: missing },
    );
  }
}

async function assertRoutineReportingAndIntegrity(
  app: RoutineTemplateApp,
): Promise<void> {
  const permissions = resolveStrictManifestPermissions({
    manifest: typeof app.manifest === "string"
      ? app.manifest
      : app.manifest
      ? JSON.stringify(app.manifest)
      : null,
  }).permissions;
  if (!permissions.includes("notify:owner")) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      'Persistent launch Agents must declare the "notify:owner" permission for Galactic inbox reporting.',
    );
  }
  if (!app.current_version) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "A live Agent version is required before routine activation.",
    );
  }
  const { code, attestation } = await loadLiveExecutedBundle(app.id);
  if (!code) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "The live Agent bundle is unavailable and cannot be activated.",
    );
  }
  const verdict = await verifyExecutedBundle({
    appId: app.id,
    esmCode: code,
    attestation,
    expectedVersion: app.current_version,
  });
  if (verdict.status !== "ok") {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      `The live Agent bundle is not verified (${verdict.status}); repair or promote a tested version before activation.`,
      { executed_integrity: verdict.status },
    );
  }
}

async function assertRequiredCapabilityGrants(
  userId: string,
  routine: StoredRoutine,
): Promise<void> {
  for (const capability of routine.capabilities) {
    if (capability.required === false) continue;
    const targetRef = optionalString(capability.app_id) ||
      optionalString(capability.app_ref);
    if (!targetRef) continue;
    const target = await loadAccessibleApp(userId, targetRef);
    const targetFunctions = new Set(
      Object.keys(parseAppManifest(target.manifest)?.functions || {}),
    );
    if (!targetFunctions.has(capability.function_name)) {
      throw new RoutinePlatformError(
        ROUTINE_PLATFORM_INVALID_PARAMS,
        `Required capability ${target.slug}.${capability.function_name} no longer exists.`,
      );
    }
    const grant = await resolveCallerGrant({
      userId,
      callerAppId: routine.composer_app_id!,
      callerFunction: null,
      targetAppId: target.id,
      targetFunction: capability.function_name,
    });
    if (!grant.allowed) {
      throw new RoutinePlatformError(
        ROUTINE_PLATFORM_INVALID_PARAMS,
        `Required capability ${target.slug}.${capability.function_name} needs an active bounded grant.`,
        { grant_reason: grant.reason || "no_grant" },
      );
    }
  }
}

/**
 * Authoritative activation contract for the single-player launch surface.
 * Every user-facing resume path and the executor defense-in-depth check call
 * this same validator so a monitor/API path cannot silently weaken gx.routine.
 */
export async function validateRoutineLaunchActivation(
  userId: string,
  routine: StoredRoutine,
): Promise<void> {
  if (!routine.composer_app_id) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "Routine has no composer Agent.",
    );
  }
  const app = await loadAccessibleApp(userId, routine.composer_app_id);
  if (app.owner_id !== userId || app.visibility !== "private") {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_FORBIDDEN,
      "Only an owner-private Agent can be activated as a launch routine.",
    );
  }
  assertIntervalSchedule(routine.schedule);
  if (routine.max_concurrency !== 1) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "Launch routines use max_concurrency=1.",
    );
  }
  await assertNoExistingPrimaryRoutine(userId, app.id, routine.id);
  await validateRequiredCapabilityTargets(userId, routine.capabilities, {
    activation: true,
  });
  await assertRequiredRoutineSettings(userId, app);
  await assertRoutineReportingAndIntegrity(app);
  await assertRequiredCapabilityGrants(userId, routine);
}

async function listRoutineTemplates(
  userId: string,
  args: Record<string, unknown>,
): Promise<{
  query?: string;
  templates: RoutineTemplateSummary[];
  count: number;
}> {
  const limit = numericLimit(args.limit, 50, 100);
  const query = optionalString(args.query);
  const appId = optionalString(args.app_id);
  const apps = appId
    ? [await loadAccessibleApp(userId, appId)]
    : await listTemplateApps(userId, limit);
  let templates = apps.flatMap(buildTemplatesForApp);

  if (query) {
    const normalizedQuery = query.toLowerCase();
    templates = templates.filter((template) =>
      templateSearchText(template).includes(normalizedQuery)
    );
  }

  templates = templates.slice(0, limit);
  return { ...(query ? { query } : {}), templates, count: templates.length };
}

function templateMatchesReference(
  template: RoutineTemplateSummary,
  templateId: string,
): boolean {
  return template.id === templateId ||
    template.templateKey === templateId ||
    `${template.appId}/${template.id}` === templateId ||
    `${template.appSlug}:${template.id}` === templateId ||
    `${template.appId}:${template.id}` === templateId;
}

async function resolveRoutineTemplate(
  userId: string,
  args: Record<string, unknown>,
): Promise<RoutineTemplateSummary> {
  const templateId = requiredString(args.template_id, "template_id");
  const appId = optionalString(args.app_id);

  if (appId) {
    const app = await loadAccessibleApp(userId, appId);
    const template = buildTemplatesForApp(app).find((candidate) =>
      templateMatchesReference(candidate, templateId)
    );
    if (!template) {
      throw new RoutinePlatformError(
        ROUTINE_PLATFORM_NOT_FOUND,
        `Routine template not found: ${templateId}`,
      );
    }
    return template;
  }

  const { templates } = await listRoutineTemplates(userId, { limit: 100 });
  const matches = templates.filter((template) =>
    templateMatchesReference(template, templateId)
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      `Multiple routine templates match "${templateId}". Provide app_id.`,
      { matches: matches.map((template) => template.templateKey) },
    );
  }
  throw new RoutinePlatformError(
    ROUTINE_PLATFORM_NOT_FOUND,
    `Routine template not found: ${templateId}`,
  );
}

function bindingsFromTemplateSurfaces(
  template: RoutineTemplateSummary,
): RoutineDashboardBindingInput[] {
  const dashboardKey = template.surfaces?.dashboard_key || "command_home";
  const widgetBindings = (template.surfaces?.widgets || []).map((widgetId) => ({
    dashboard_key: dashboardKey,
    app_id: template.appId,
    app_ref: template.appSlug,
    widget_id: widgetId,
  }));
  const cardBindings = (template.surfaces?.command_cards || []).map((card) => ({
    dashboard_key: dashboardKey,
    app_id: template.appId,
    app_ref: template.appSlug,
    widget_id: card.widget_id,
    card_id: card.card_id,
  }));
  return [...widgetBindings, ...cardBindings];
}

function capabilityInputsFromArgs(
  template: RoutineTemplateSummary,
  args: Record<string, unknown>,
): RoutineCapabilityInput[] {
  const baseCapabilities = Array.isArray(args.capabilities)
    ? args.capabilities as RoutineCapabilityInput[]
    : routineCapabilitiesFromManifest(
      template.capabilities as RoutineCapabilityDeclaration[] | undefined,
    );
  const extraCapabilities = Array.isArray(args.extra_capabilities)
    ? args.extra_capabilities as RoutineCapabilityInput[]
    : [];
  // Connected agents may propose authority, never grant it to themselves.
  // Ignore embedded `approved` flags as untrusted input; approval is available
  // only through the account-session service primitive.
  return [...baseCapabilities, ...extraCapabilities].map((capability) => ({
    ...capability,
    approved: false,
  }));
}

function scheduleFromArgs(
  template: RoutineTemplateSummary,
  args: Record<string, unknown>,
): RoutineScheduleDeclaration | undefined {
  return args.schedule !== undefined
    ? args.schedule as RoutineScheduleDeclaration
    : template.defaultSchedule;
}

function buildRoutinePlan(
  template: RoutineTemplateSummary,
  args: Record<string, unknown>,
): PlannedRoutine {
  if (args.approve_capabilities === true) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_FORBIDDEN,
      "Connected agents cannot approve routine capabilities. Create the routine paused, then ask the account owner to approve it.",
    );
  }
  if (args.max_concurrency !== undefined && args.max_concurrency !== 1) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "Launch routines use max_concurrency=1.",
    );
  }
  if (args.schedule !== undefined) assertIntervalSchedule(args.schedule);
  const capabilities = capabilityInputsFromArgs(template, args);
  const pendingCapabilities = capabilities.filter((capability) =>
    capability.approved !== true
  );
  const approvedCapabilities = capabilities.filter((capability) =>
    capability.approved === true
  );
  const defaultConfig = template.defaultConfig || {};
  const config = {
    ...defaultConfig,
    ...(objectOrUndefined(args.config) || {}),
  };
  const dashboardBindings = Array.isArray(args.dashboard_bindings)
    ? args.dashboard_bindings as RoutineDashboardBindingInput[]
    : bindingsFromTemplateSurfaces(template);
  let budgetPolicy: Required<RoutineBudgetDefaults>;
  try {
    budgetPolicy = normalizeRoutineBudgetPolicy(
      args.budget_policy !== undefined
        ? args.budget_policy
        : template.budgetDefaults || {},
    );
  } catch (error) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      error instanceof Error ? error.message : "Invalid budget_policy.",
    );
  }
  const approvalPolicy =
    (args.approval_policy !== undefined
      ? args.approval_policy
      : template.approvalPolicy || {}) as RoutineApprovalPolicy;

  const routine: RoutineCreateInput = {
    composer_app_id: template.appId,
    composer_app_slug: template.appSlug,
    template_id: template.id,
    template_version: template.appVersion ?? null,
    name: optionalString(args.name) || template.label,
    description: optionalString(args.description) ||
      template.description ||
      null,
    intent: optionalString(args.intent) || null,
    handler_function: optionalString(args.handler_function) ||
      template.handler,
    schedule: scheduleFromArgs(template, args) || { every_minutes: 5 },
    config,
    budget_policy: budgetPolicy,
    approval_policy: approvalPolicy,
    max_concurrency: 1,
    next_run_at: optionalString(args.next_run_at) || null,
    created_by_trace_id: optionalString(args.trace_id) || null,
    metadata: {
      ...(objectOrUndefined(args.metadata) || {}),
      source: "ul.routine",
      // Server-owned marker used by the partial unique index. Keep the broader
      // source marker for compatibility, but do not index historical source
      // rows because they may legitimately contain pre-launch duplicates.
      launch_primary: true,
      template_label: template.label,
      template_app_name: template.appName,
      approval_confirmed: false,
      approval_source: "account_session_required",
    },
    capabilities,
    dashboard_bindings: dashboardBindings,
  };

  return {
    template,
    routine,
    pendingCapabilities,
    approvedCapabilities,
    createArgs: {
      action: "create",
      app_id: template.appId,
      template_id: template.id,
      name: routine.name,
      schedule: routine.schedule,
      config: routine.config,
      budget_policy: routine.budget_policy,
      activate: args.activate === true,
    },
  };
}

async function planRoutine(
  userId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const template = await resolveRoutineTemplate(userId, args);
  assertPrivateOwnedTemplate(userId, template);
  const plan = buildRoutinePlan(template, args);
  assertIntervalSchedule(plan.routine.schedule);
  await validateRequiredCapabilityTargets(
    userId,
    plan.routine.capabilities as RoutineCapabilityInput[],
  );
  return {
    template: plan.template,
    routine: plan.routine,
    approvals: {
      capability_count: plan.pendingCapabilities.length +
        plan.approvedCapabilities.length,
      approved_count: plan.approvedCapabilities.length,
      pending_count: plan.pendingCapabilities.length,
      pending_capabilities: plan.pendingCapabilities,
      approval_required_via: "account_session",
    },
    command_surfaces: plan.routine.dashboard_bindings || [],
    create_args: plan.createArgs,
    will_start_paused: args.activate !== true ||
      plan.pendingCapabilities.length > 0,
  };
}

async function createRoutineFromTemplate(
  userId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const template = await resolveRoutineTemplate(userId, args);
  assertPrivateOwnedTemplate(userId, template);
  const plan = buildRoutinePlan(template, args);
  assertIntervalSchedule(plan.routine.schedule);
  await validateRequiredCapabilityTargets(
    userId,
    plan.routine.capabilities as RoutineCapabilityInput[],
  );
  await assertNoExistingPrimaryRoutine(userId, template.appId);
  const activate = args.activate === true;

  const pendingRequired = plan.pendingCapabilities.filter((capability) =>
    capability.required !== false
  );
  if (activate && pendingRequired.length > 0) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "Cannot activate a routine with pending capabilities. The account owner must approve them first.",
      { pending_capabilities: pendingRequired },
    );
  }

  let routine: Awaited<ReturnType<typeof createRoutine>>;
  try {
    routine = await createRoutine(userId, plan.routine);
  } catch (error) {
    if (isLaunchPrimaryUniqueViolation(error)) {
      throw new RoutinePlatformError(
        ROUTINE_PLATFORM_INVALID_PARAMS,
        "This Agent already has its primary routine. The launch contract supports one primary routine per Agent.",
      );
    }
    throw error;
  }
  if (activate) {
    await validateRoutineLaunchActivation(userId, routine);
    const activeRoutine = await resumeRoutine(userId, routine.id);
    routine = { ...routine, ...activeRoutine };
  }

  return {
    routine,
    template: plan.template,
    approvals: {
      capability_count: routine.capabilities.length,
      approved_count:
        routine.capabilities.filter((capability) => capability.approved).length,
      pending_count:
        routine.capabilities.filter((capability) => !capability.approved)
          .length,
    },
    command_surfaces: routine.dashboard_bindings,
    next_step: activate
      ? "Routine is active. The durable executor will claim due runs after PR5."
      : "Routine is saved paused. Resume it when ready.",
  };
}

async function updateRoutineFromArgs(
  userId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const routineId = requiredString(args.routine_id, "routine_id");
  const updates: Partial<RoutineCreateInput> & { status?: RoutineStatus } = {};
  if (args.max_concurrency !== undefined && args.max_concurrency !== 1) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      "Launch routines use max_concurrency=1.",
    );
  }
  if (args.schedule !== undefined) assertIntervalSchedule(args.schedule);
  for (
    const key of [
      "name",
      "description",
      "intent",
      "schedule",
      "config",
      "budget_policy",
      "approval_policy",
      "max_concurrency",
      "next_run_at",
      "metadata",
      "status",
    ] as const
  ) {
    if (args[key] !== undefined) {
      (updates as Record<string, unknown>)[key] = args[key];
    }
  }
  const routine = await updateRoutine(userId, routineId, updates);
  return { routine };
}

async function runRoutineNow(
  userId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const routineId = requiredString(args.routine_id, "routine_id");
  const routine = await getRoutine(userId, routineId);
  if (!routine) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_NOT_FOUND,
      `Routine ${routineId} not found`,
    );
  }
  if (routine.status !== "active") {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      `Routine ${routineId} is ${routine.status}; only an active, owner-approved routine can run now`,
    );
  }

  const traceId = optionalString(args.trace_id) || crypto.randomUUID();
  const run = await createRoutineRun({
    routineId,
    userId,
    trigger: "manual",
    traceId,
    status: "queued",
    runConfig: objectOrUndefined(args.run_config) || {},
    metadata: {
      ...(objectOrUndefined(args.metadata) || {}),
      source: "ul.routine.run_now",
      routine_status_at_queue: routine.status,
    },
  });

  return {
    queued: true,
    run,
    routine: {
      id: routine.id,
      name: routine.name,
      status: routine.status,
      handler_function: routine.handler_function,
    },
    executor_status: "queued",
    message: "Run is queued for the durable routine executor.",
  };
}

export async function executeRoutinePlatformAction(
  userId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const action = requiredString(args.action, "action");
  if (!isAction(action)) {
    throw new RoutinePlatformError(
      ROUTINE_PLATFORM_INVALID_PARAMS,
      `Invalid routine action: ${action}. Use ${
        ROUTINE_PLATFORM_ACTIONS.join("|")
      }`,
    );
  }

  switch (action) {
    case "templates":
      return await listRoutineTemplates(userId, args);
    case "plan":
      return await planRoutine(userId, args);
    case "create":
      return await createRoutineFromTemplate(userId, args);
    case "list":
      return await listRoutines(userId, {
        status: args.status as RoutineStatus | undefined,
        limit: numericLimit(args.limit, 50, 100),
      });
    case "get": {
      const routineId = requiredString(args.routine_id, "routine_id");
      const routine = await getRoutine(userId, routineId);
      if (!routine) {
        throw new RoutinePlatformError(
          ROUTINE_PLATFORM_NOT_FOUND,
          `Routine ${routineId} not found`,
        );
      }
      return { routine };
    }
    case "update":
      return await updateRoutineFromArgs(userId, args);
    case "pause": {
      const routineId = requiredString(args.routine_id, "routine_id");
      return { routine: await pauseRoutine(userId, routineId) };
    }
    case "resume": {
      const routineId = requiredString(args.routine_id, "routine_id");
      const routine = await getRoutine(userId, routineId);
      if (!routine) {
        throw new RoutinePlatformError(
          ROUTINE_PLATFORM_NOT_FOUND,
          `Routine ${routineId} not found`,
        );
      }
      await validateRoutineLaunchActivation(userId, routine);
      return { routine: await resumeRoutine(userId, routineId) };
    }
    case "delete": {
      const routineId = requiredString(args.routine_id, "routine_id");
      return await deleteRoutine(userId, routineId);
    }
    case "run_now":
      return await runRoutineNow(userId, args);
  }
}
