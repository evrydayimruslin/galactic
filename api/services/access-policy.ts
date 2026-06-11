import type {
  AppManifest,
  ManifestAccessPolicy,
  ManifestAccessPolicyMode,
} from "../../shared/contracts/manifest.ts";
import type { AppPricingConfig } from "../../shared/types/index.ts";
import {
  getCallPriceLight,
  getFreeCalls,
  getFreeCallsScope,
  getFreeSkillPulls,
  getSkillPullPriceLight,
} from "../../shared/types/index.ts";

export type AccessPolicySubjectKind = "function" | "skill";
export type AccessPolicyDecisionSource =
  | "static_config"
  | "manifest_policy_declared_static_fallback"
  | "runtime_policy"
  | "runtime_policy_error";

export interface AccessPolicyApp {
  id: string;
  owner_id: string;
  slug?: string | null;
  pricing_config?: AppPricingConfig | null | unknown;
  manifest?: AppManifest | string | null | unknown;
}

export interface AccessPolicySubject {
  kind: AccessPolicySubjectKind;
  id: string;
}

export interface AccessPolicyCaller {
  userId: string;
  authState?: "authenticated" | "anonymous";
  // The calling Agent for a cross-Agent call (P5), or null for a direct user
  // call. A developer access_policy module can deny or reprice per caller.
  callerAppId?: string | null;
}

export interface AccessPolicyContext {
  app: AccessPolicyApp;
  caller: AccessPolicyCaller;
  subject: AccessPolicySubject;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AccessPolicyAllowDecision {
  effect: "allow";
  source: AccessPolicyDecisionSource;
  subjectKind: AccessPolicySubjectKind;
  subjectId: string;
  priceLight: number;
  chargeLight: number;
  free: boolean;
  freeQuotaLimit: number;
  freeQuotaCounterKey: string | null;
  selfAccess: boolean;
  metadata: Record<string, unknown>;
}

export interface AccessPolicyDenyDecision {
  effect: "deny";
  source: AccessPolicyDecisionSource;
  subjectKind: AccessPolicySubjectKind;
  subjectId: string;
  reason: string;
  code: "access_policy_denied" | "access_policy_error";
  selfAccess: boolean;
  metadata: Record<string, unknown>;
}

export type AccessPolicyDecision =
  | AccessPolicyAllowDecision
  | AccessPolicyDenyDecision;

export interface ResolvedManifestAccessPolicy {
  configured: boolean;
  mode: ManifestAccessPolicyMode;
  module: string | null;
  exportName: string;
}

export interface AccessPolicyRuntimeEvaluationRequest {
  context: AccessPolicyContext;
  staticDecision: AccessPolicyAllowDecision;
  manifestPolicy: ResolvedManifestAccessPolicy;
}

export type AccessPolicyRuntimeEvaluator = (
  request: AccessPolicyRuntimeEvaluationRequest,
) => Promise<unknown>;

export interface AccessPolicyEvaluationOptions {
  executeRuntimePolicy?: AccessPolicyRuntimeEvaluator | null;
}

export async function evaluateAccessPolicy(
  context: AccessPolicyContext,
  options: AccessPolicyEvaluationOptions = {},
): Promise<AccessPolicyDecision> {
  const staticDecision = evaluateStaticAccessPolicy(context);
  const manifestPolicy = resolveManifestAccessPolicy(context.app);

  if (
    !manifestPolicy.configured || manifestPolicy.mode !== "module" ||
    !options.executeRuntimePolicy
  ) {
    return staticDecision;
  }

  try {
    const rawDecision = await options.executeRuntimePolicy({
      context,
      staticDecision,
      manifestPolicy,
    });
    return normalizeRuntimePolicyDecision(
      context,
      staticDecision,
      manifestPolicy,
      rawDecision,
    );
  } catch (err) {
    return denyDecision(context, {
      source: "runtime_policy_error",
      code: "access_policy_error",
      reason: err instanceof Error
        ? `Access policy failed: ${err.message}`
        : "Access policy failed.",
      metadata: {
        ...staticDecision.metadata,
        access_policy_source: "runtime_policy_error",
        access_policy_decision_source: "runtime_policy_error",
        access_policy_configured: true,
        access_policy_mode: manifestPolicy.mode,
        access_policy_module: manifestPolicy.module,
        access_policy_export: manifestPolicy.exportName,
        access_policy_executed: true,
        access_policy_error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export function evaluateStaticAccessPolicy(
  context: AccessPolicyContext,
): AccessPolicyAllowDecision {
  const pricingConfig = normalizePricingConfig(context.app.pricing_config);
  const manifestPolicy = resolveManifestAccessPolicy(context.app);
  const decisionSource: AccessPolicyDecisionSource =
    manifestPolicy.configured && manifestPolicy.mode === "module"
      ? "manifest_policy_declared_static_fallback"
      : "static_config";
  const selfAccess = context.caller.userId === context.app.owner_id;
  const priceLight = getStaticSubjectPriceLight(
    pricingConfig,
    context.subject,
  );
  const freeQuotaLimit = selfAccess || priceLight <= 0
    ? 0
    : getStaticSubjectFreeQuotaLimit(pricingConfig, context.subject);
  const freeQuotaCounterKey = freeQuotaLimit > 0
    ? getStaticSubjectFreeQuotaCounterKey(pricingConfig, context.subject)
    : null;
  const chargeLight = selfAccess ? 0 : priceLight;
  const free = !selfAccess && priceLight <= 0;

  return {
    effect: "allow",
    source: decisionSource,
    subjectKind: context.subject.kind,
    subjectId: context.subject.id,
    priceLight,
    chargeLight,
    free,
    freeQuotaLimit,
    freeQuotaCounterKey,
    selfAccess,
    metadata: {
      access_policy_source: "static_config",
      access_policy_decision_source: decisionSource,
      access_policy_configured: manifestPolicy.configured,
      access_policy_mode: manifestPolicy.mode,
      access_policy_module: manifestPolicy.module,
      access_policy_export: manifestPolicy.exportName,
      access_policy_executed: false,
      subject_kind: context.subject.kind,
      subject_id: context.subject.id,
      app_id: context.app.id,
      app_slug: context.app.slug || null,
      price_light: priceLight,
      charge_light: chargeLight,
      free_quota_limit: freeQuotaLimit,
      free_quota_counter_key: freeQuotaCounterKey,
    },
  };
}

export function isAccessPolicyDenied(
  decision: AccessPolicyDecision,
): decision is AccessPolicyDenyDecision {
  return decision.effect === "deny";
}

export function resolveManifestAccessPolicy(
  app: Pick<AccessPolicyApp, "manifest">,
): ResolvedManifestAccessPolicy {
  const manifest = parseManifestObject(app.manifest);
  const policy = manifest?.access_policy;
  if (!isRecord(policy)) {
    return defaultManifestPolicy(false);
  }

  const accessPolicy = policy as ManifestAccessPolicy;
  const modulePath = typeof accessPolicy.module === "string" &&
      isSafeManifestModulePath(accessPolicy.module)
    ? accessPolicy.module.trim()
    : null;
  const mode = resolveManifestPolicyMode(accessPolicy, modulePath);
  const exportName = typeof accessPolicy.export === "string" &&
      isSafeManifestExportName(accessPolicy.export)
    ? accessPolicy.export.trim()
    : "planAccess";

  return {
    configured: true,
    mode,
    module: mode === "module" ? modulePath : null,
    exportName,
  };
}

export function getStaticSubjectPriceLight(
  pricingConfig: AppPricingConfig | null,
  subject: AccessPolicySubject,
): number {
  const price = subject.kind === "skill"
    ? getSkillPullPriceLight(pricingConfig, subject.id)
    : getCallPriceLight(pricingConfig, subject.id);
  return Math.max(numeric(price), 0);
}

export function getStaticSubjectFreeQuotaLimit(
  pricingConfig: AppPricingConfig | null,
  subject: AccessPolicySubject,
): number {
  const limit = subject.kind === "skill"
    ? getFreeSkillPulls(pricingConfig, subject.id)
    : getFreeCalls(pricingConfig, subject.id);
  return Math.max(numeric(limit), 0);
}

export function getStaticSubjectFreeQuotaCounterKey(
  pricingConfig: AppPricingConfig | null,
  subject: AccessPolicySubject,
): string {
  if (subject.kind === "skill") {
    return `skill:${subject.id}`;
  }
  return getFreeCallsScope(pricingConfig) === "app" ? "__app__" : subject.id;
}

function normalizePricingConfig(value: unknown): AppPricingConfig | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as AppPricingConfig
    : null;
}

function defaultManifestPolicy(
  configured: boolean,
): ResolvedManifestAccessPolicy {
  return {
    configured,
    mode: "static",
    module: null,
    exportName: "planAccess",
  };
}

function normalizeRuntimePolicyDecision(
  context: AccessPolicyContext,
  staticDecision: AccessPolicyAllowDecision,
  manifestPolicy: ResolvedManifestAccessPolicy,
  rawDecision: unknown,
): AccessPolicyDecision {
  if (!isRecord(rawDecision)) {
    throw new Error("Policy result must be an object");
  }

  const runtimeMetadata = isRecord(rawDecision.metadata)
    ? rawDecision.metadata
    : {};
  const baseRuntimeMetadata = {
    ...staticDecision.metadata,
    ...runtimeMetadata,
    access_policy_source: "runtime_policy",
    access_policy_decision_source: "runtime_policy",
    access_policy_configured: true,
    access_policy_mode: manifestPolicy.mode,
    access_policy_module: manifestPolicy.module,
    access_policy_export: manifestPolicy.exportName,
    access_policy_executed: true,
  };

  if (rawDecision.effect === "deny") {
    return denyDecision(context, {
      source: "runtime_policy",
      code: "access_policy_denied",
      reason: stringField(rawDecision.reason) ||
        stringField(rawDecision.message) ||
        "Access denied by app policy.",
      metadata: baseRuntimeMetadata,
    });
  }

  const selfAccess = context.caller.userId === context.app.owner_id;
  const priceLight = nonNegativeNumberField(
    rawDecision.price_light,
    rawDecision.priceLight,
    staticDecision.priceLight,
  );
  const chargeLight = selfAccess ? 0 : nonNegativeNumberField(
    rawDecision.charge_light,
    rawDecision.chargeLight,
    priceLight,
  );
  const freeQuotaLimit = selfAccess || priceLight <= 0
    ? 0
    : nonNegativeNumberField(
      rawDecision.free_quota_limit,
      rawDecision.freeQuotaLimit,
      staticDecision.freeQuotaLimit,
    );
  const rawCounterKey = rawDecision.free_quota_counter_key ??
    rawDecision.freeQuotaCounterKey;
  const freeQuotaCounterKey = freeQuotaLimit > 0
    ? typeof rawCounterKey === "string" && rawCounterKey.trim()
      ? rawCounterKey.trim()
      : staticDecision.freeQuotaCounterKey
    : null;
  const free = selfAccess
    ? false
    : typeof rawDecision.free === "boolean"
    ? rawDecision.free
    : chargeLight <= 0 || priceLight <= 0;

  return {
    effect: "allow",
    source: "runtime_policy",
    subjectKind: context.subject.kind,
    subjectId: context.subject.id,
    priceLight,
    chargeLight,
    free,
    freeQuotaLimit,
    freeQuotaCounterKey,
    selfAccess,
    metadata: {
      ...baseRuntimeMetadata,
      price_light: priceLight,
      charge_light: chargeLight,
      free_quota_limit: freeQuotaLimit,
      free_quota_counter_key: freeQuotaCounterKey,
    },
  };
}

function denyDecision(
  context: AccessPolicyContext,
  input: {
    source: AccessPolicyDecisionSource;
    code: AccessPolicyDenyDecision["code"];
    reason: string;
    metadata: Record<string, unknown>;
  },
): AccessPolicyDenyDecision {
  return {
    effect: "deny",
    source: input.source,
    subjectKind: context.subject.kind,
    subjectId: context.subject.id,
    reason: input.reason,
    code: input.code,
    selfAccess: context.caller.userId === context.app.owner_id,
    metadata: {
      ...input.metadata,
      access_policy_denied: true,
      access_policy_denial_code: input.code,
      access_policy_denial_reason: input.reason,
      subject_kind: context.subject.kind,
      subject_id: context.subject.id,
      app_id: context.app.id,
      app_slug: context.app.slug || null,
    },
  };
}

function parseManifestObject(value: unknown): AppManifest | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed as unknown as AppManifest : null;
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value as unknown as AppManifest : null;
}

function resolveManifestPolicyMode(
  policy: ManifestAccessPolicy,
  modulePath: string | null,
): ManifestAccessPolicyMode {
  if (policy.mode === "module" && modulePath) {
    return "module";
  }
  if (policy.mode === "static") {
    return "static";
  }
  return modulePath ? "module" : "static";
}

function isSafeManifestModulePath(value: string): boolean {
  const trimmed = value.trim();
  if (
    !trimmed || trimmed.startsWith("/") || trimmed.includes("\\") ||
    !/\.(ts|js|mjs)$/.test(trimmed)
  ) {
    return false;
  }

  const parts = trimmed.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function isSafeManifestExportName(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonNegativeNumberField(
  primary: unknown,
  secondary: unknown,
  fallback: number,
): number {
  const value = typeof primary === "number" && Number.isFinite(primary)
    ? primary
    : typeof secondary === "number" && Number.isFinite(secondary)
    ? secondary
    : fallback;
  return Math.max(value, 0);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
