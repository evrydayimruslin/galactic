// Launch API facade
// Thin MVP-facing endpoints for the external-agent-first website.

import { authenticate } from "./auth.ts";
import {
  type ComputeLaunchHandlerDependencies,
  handleLaunchComputeRoute,
  isLaunchComputePath,
} from "./launch-compute.ts";
import { handleRun } from "./run.ts";
import { error, json } from "./response.ts";
import { getEnv } from "../lib/env.ts";
import { isAccountSessionAuthSource } from "../services/control-plane-auth.ts";
import {
  getAgentFeeWaiverLeaderboard,
  getFeeWaiverLeaderboard,
  parseFeeWaiverLeaderboardQuery,
} from "../services/fee-waivers.ts";
import { getOrCreatePublisherReferralLink } from "../services/referrals.ts";
import { verifyAppIntegrity } from "../services/capabilities/verify.ts";
import { CapabilityError } from "../../shared/contracts/capabilities.ts";
import {
  COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS,
  COMPUTE_V1_MAX_ARTIFACT_BYTES,
} from "../../shared/contracts/compute.ts";
import {
  isGpuSupportEnabled,
  sanitizeGpuTrustCard,
} from "../services/gpu/feature-flag.ts";
import {
  buildAppNetworkDisclosure,
  buildAppTrustCard,
} from "../services/trust.ts";
import { resolveTrustSignals } from "../services/trust-signals.ts";
import { encryptEnvVar } from "../services/envvars.ts";
import {
  getScopedEnvSchemaEntries,
  resolveAppEnvSchema,
} from "../services/app-settings.ts";
import {
  buildPerUserSettingsStatus,
  type UserAppSecretStatusRow,
  validatePerUserSettingsValues,
} from "../services/user-app-settings.ts";
import { RequestValidationError } from "../services/request-validation.ts";
import { createEmbeddingService } from "../services/embedding.ts";
import { getRecentCalls } from "../services/call-logger.ts";
import {
  type ApiToken,
  createToken,
  listTokens,
  revokeToken,
} from "../services/tokens.ts";
import { withSensitiveRouteRateLimit } from "../services/sensitive-route-rate-limit.ts";
import {
  LAUNCH_API_ROUTES,
  LAUNCH_CALLER_FUNCTION_POLICIES,
  LAUNCH_DEFERRED_CAPABILITIES,
  LAUNCH_INCLUDED_CAPABILITIES,
  LAUNCH_INSTALL_TARGETS,
  LAUNCH_MVP_VERSION,
  LAUNCH_PLATFORM_PRIMITIVES,
  LAUNCH_PUBLIC_ROUTES,
  LAUNCH_SCOPE_CONTRACT,
  type LaunchAgentAdminSummary,
  type LaunchAgentCapacityResponse,
  type LaunchAgentCapacityUpdateRequest,
  type LaunchAgentFunctionsResponse,
  type LaunchAgentHomeActionRequest,
  type LaunchAgentHomeResponse,
  type LaunchAgentInstallContext,
  type LaunchAgentKind,
  type LaunchAgentManagedRoutineActionRequest,
  type LaunchAgentManagedRoutineUpdateRequest,
  type LaunchAgentOwnerSummary,
  type LaunchAgentRelationship,
  type LaunchAgentRoutineActionRequest,
  type LaunchAgentRoutineBlocker,
  type LaunchAgentRoutineOverview,
  type LaunchAgentRoutineResponse,
  type LaunchAgentRoutineRun,
  type LaunchAgentRoutineSchedule,
  type LaunchAgentRoutinesResponse,
  type LaunchAgentRoutineUpdateRequest,
  type LaunchAgentSummary,
  type LaunchAgentVisibility,
  type LaunchApiKeyCreateRequest,
  type LaunchApiKeySummary,
  type LaunchApiRoute,
  type LaunchByokMutationResponse,
  type LaunchByokProviderOption,
  type LaunchByokSummaryResponse,
  type LaunchCallerFunctionPermissionsResponse,
  type LaunchCallerFunctionPermissionsUpdateRequest,
  type LaunchDiscoveryRetrievalSummary,
  type LaunchDiscoverySource,
  type LaunchFleetActivity,
  type LaunchFleetAgentHealth,
  type LaunchFleetAgentState,
  type LaunchFleetResponse,
  type LaunchFolder,
  type LaunchFullTimeDisclosure,
  type LaunchFunctionInferenceResponse,
  type LaunchFunctionRunRequest,
  type LaunchFunctionRunResponse,
  type LaunchFunctionSummary,
  type LaunchInferenceOptionsResponse,
  type LaunchInstallInstruction,
  type LaunchInstallResponse,
  type LaunchInterfaceSummary,
  type LaunchJobStatusResponse,
  type LaunchLeaderboardEntry,
  type LaunchLeaderboardKind,
  type LaunchLeaderboardResponse,
  type LaunchMoneyAmount,
  type LaunchPayoutStatus,
  type LaunchPlatformModelResponse,
  type LaunchPlatformPrimitive,
  type LaunchPlatformPrimitiveSuggestion,
  type LaunchPricingSummary,
  type LaunchPublicRoute,
  type LaunchRelevanceSummary,
  type LaunchSemanticSubjectType,
  type LaunchSubscriptionCheckoutRequest,
  type LaunchSubscriptionRedirectResponse,
  type LaunchTrustCard,
  type LaunchWalletDetailKind,
  type LaunchWalletDetailResponse,
  type LaunchWalletEarningSummary,
  type LaunchWalletFundingFeeSummary,
  type LaunchWalletFundingIntentRequest,
  type LaunchWalletFundingMethod,
  type LaunchWalletPageInfo,
  type LaunchWalletPageRequest,
  type LaunchWalletPayoutSummary,
  type LaunchWalletReceiptSummary,
  type LaunchWalletSummary,
  type LaunchWalletTransaction,
  PERSISTENT_AGENT_LAUNCH_POLICY,
} from "../../shared/contracts/launch.ts";
import type { AppManifest } from "../../shared/contracts/manifest.ts";
import { validateEnvVarValue } from "../../shared/contracts/env.ts";
import {
  BYOK_PROVIDERS,
  isActiveBYOKProvider,
} from "../../shared/types/index.ts";
import type {
  ActiveBYOKProvider,
  BYOKProviderInfo,
  RunResponse,
  VersionMetadata,
} from "../../shared/types/index.ts";
import { createUserService } from "../services/user.ts";
import { validateAPIKey } from "../services/ai.ts";
import { checkChatBalance } from "../services/chat-billing.ts";
import {
  CHAT_MIN_BALANCE_LIGHT,
  FREE_MODE_BALANCE_LIGHT,
} from "../../shared/contracts/ai.ts";
import {
  functionUsesInference,
  isFreeModeEnabled,
} from "../services/free-mode.ts";
import { isValidModelId } from "../services/model-validation.ts";
import {
  type BillingAddressInput,
  publicBillingAddress,
} from "../services/billing-addresses.ts";
import { validateBillingAddressValue } from "../services/platform-request-validation.ts";
import {
  ensureBillingAddressForFunding,
  getOrCreateStripeCustomerForUser,
} from "../services/stripe-customers.ts";
import {
  createLaunchWalletPaymentIntent,
  LAUNCH_WALLET_DEPOSIT_TYPE,
  LaunchWalletFundingError,
} from "../services/stripe-launch-wallet-funding.ts";
import { markLightDepositFailed } from "../services/stripe-deposits.ts";
import { getSupabaseEnv } from "../services/user-supabase-configs.ts";
import {
  LAUNCH_WALLET_FUNDING_PRESETS,
  normalizeLaunchFundingAmountLight,
  normalizeLaunchFundingMethod,
  quoteLaunchWalletFunding,
} from "../services/stripe-processing-fees.ts";
import { getBillingConfig } from "../services/billing-config.ts";
import {
  listCallerFunctionPermissions,
  updateCallerFunctionPermissions,
} from "../services/caller-function-permissions.ts";
import {
  clearFunctionInferenceOverride,
  listFunctionInferenceOverrides,
  setFunctionInferenceOverride,
} from "../services/function-inference-overrides.ts";
import { resolveManifestAccessPolicy } from "../services/access-policy.ts";
import {
  approvePendingGrant,
  createGrant,
  fetchAppHandles,
  getGrant,
  getUserDisplayName,
  getUserGrantAutoApprove,
  listGrantSummaries,
  setGrantCap,
  setGrantStatus,
  setUserDisplayName,
  setUserGrantAutoApprove,
  toGrantSummary,
} from "../services/agent-grants.ts";
import {
  buildCallerTrustSummary,
  buildWiringView,
  listEligibleTargets,
} from "../services/agent-wiring.ts";
import type {
  AgentGrantApproveRequest,
  AgentGrantCreateRequest,
  AgentGrantStatus,
  AgentGrantUpdateRequest,
} from "../../shared/contracts/agent-grants.ts";
import type { SensitiveRoute } from "../services/sensitive-route-rate-limit.ts";
import {
  approveRoutineCapabilities,
  getRoutine,
  launchRoutineRole,
  pauseRoutine,
  resumeRoutine,
  type StoredRoutine,
  updateRoutine,
  validateRoutineActivation,
} from "../services/routines.ts";
import {
  normalizeRoutineSchedule,
  previewRoutineRunTimes,
  RoutineScheduleValidationError,
} from "../services/routine-schedule.ts";
import {
  getRoutineMonitorDetail,
  queueRoutineMonitorRun,
  type RoutineMonitorDetailResponse,
} from "../services/routine-monitoring.ts";
import {
  ROUTINE_PLATFORM_FORBIDDEN,
  ROUTINE_PLATFORM_NOT_FOUND,
  RoutinePlatformError,
  validateRoutineLaunchActivation,
} from "../services/routine-platform.ts";
import {
  DEFAULT_ROUTINE_BUDGET_POLICY,
  MIN_ROUTINE_INTERVAL_SECONDS,
} from "../../shared/contracts/routine.ts";
import {
  type AgentHomeBudgetUsage,
  agentHomeCallTargetKey,
  type AgentHomeSettingStatus,
  buildAgentHomeResponse,
  versionWasUploadedAfterLive,
} from "../services/agent-home.ts";
import {
  AgentHomeRevisionError,
  approveAgentHomeCapabilitiesCAS,
  assertAgentHomeRevision,
  claimAgentHomeAction,
  commitAgentHomePromotionAppRecord,
  completeAgentHomeAction,
  fenceAgentHomePromotionStep,
  getAgentHomeBudgetUsage,
  getAgentHomeRevision,
  parseAgentHomeRevision,
  pauseAgentHomeRoutineEmergency,
  queueAgentHomeRoutineRun,
  updateAgentHomeIdentityCAS,
  updateAgentHomeManagedRoutineCAS,
  updateAgentHomeManagedRoutineStatusCAS,
  updateAgentHomeSettingsCAS,
} from "../services/agent-home-revision.ts";
import {
  resolveAppRuntimeEnvVars,
  resolveRuntimeAppCallDependencies,
  resolveStrictManifestPermissions,
} from "../services/app-runtime-resources.ts";
import {
  loadLiveExecutedBundle,
  verifyExecutedBundle,
} from "../services/executed-bundle.ts";
import { readVersionSourceFiles } from "../services/code-verification.ts";
import { findPersistedTestAttestation } from "../services/test-attestation.ts";
import { summarizeManifestAuthorityChanges } from "../services/manifest-authority.ts";
import {
  executeSetVersion,
  inspectLiveAppStorageAccounting,
} from "./platform-mcp.ts";
import {
  createSubscriptionCheckout,
  createSubscriptionPortal,
  getLaunchSubscription,
  toLaunchCapacityResponse,
} from "../services/subscriptions.ts";
import {
  type AccountCapacityStatus,
  type AgentCapacityStatus,
  getAccountCapacityStatus,
  getAgentCapacityStatus,
  releaseAgentActivationSlot,
  setAgentCapacityCap,
} from "../services/account-capacity.ts";

// Cross-Agent grant + settings mutations are sensitive. The SensitiveRoute enum
// lives in sensitive-route-rate-limit.ts (outside this file's edit scope), so we
// reuse the closest existing user-scoped settings-mutation key rather than
// adding dedicated launch:grant_write / launch:settings_write keys. See the
// orchestrator leftovers note.
const LAUNCH_GRANT_WRITE_LIMIT: SensitiveRoute = "apps:user_settings_update";
const LAUNCH_GRANT_SETTINGS_WRITE_LIMIT: SensitiveRoute =
  "apps:user_settings_update";

function privateLaunchJson(data: unknown, status = 200): Response {
  const response = json(data, status);
  return withPrivateLaunchPrivacy(response);
}

function withPrivateLaunchPrivacy(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie, Authorization");
  return response;
}

async function privateLaunchRoute(
  operation: () => Promise<Response>,
): Promise<Response> {
  try {
    return withPrivateLaunchPrivacy(await operation());
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return privateLaunchJson({ error: err.message }, err.status);
    }
    if (err instanceof LaunchServiceUnavailableError) {
      return privateLaunchJson({ error: err.message }, 503);
    }
    throw err;
  }
}

const APP_SELECT = [
  "id",
  "owner_id",
  "slug",
  "name",
  "description",
  "icon_url",
  "visibility",
  "download_access",
  "current_version",
  "current_version_promoted_at",
  "versions",
  "manifest",
  "exports",
  "pricing_config",
  "gpu_pricing_config",
  "runtime",
  "app_type",
  "storage_key",
  "gpu_status",
  "gpu_type",
  "version_metadata",
  "env_schema",
  "tags",
  "category",
  "likes",
  "dislikes",
  "weighted_likes",
  "weighted_dislikes",
  "total_runs",
  "runs_30d",
  "hosting_suspended",
  "updated_at",
  "created_at",
].join(",");

const OWNER_SELECT = "id,display_name,profile_slug,avatar_url";
const USER_BALANCE_SELECT =
  "id,balance_light,deposit_balance_light,earned_balance_light,escrow_light," +
  "stripe_connect_account_id,stripe_connect_onboarded,stripe_connect_payouts_enabled";
const MAX_DISCOVERY_LIMIT = 100;
const DEFAULT_DISCOVERY_LIMIT = 24;
const MAX_WALLET_PAGE_LIMIT = 100;
const DEFAULT_WALLET_PAGE_LIMIT = 25;

interface AuthUser {
  id: string;
  email?: string;
  authSource?: string;
}

interface LaunchAppRow {
  id: string;
  owner_id: string;
  slug: string | null;
  name: string | null;
  description: string | null;
  icon_url?: string | null;
  visibility: string | null;
  download_access?: string | null;
  current_version?: string | null;
  current_version_promoted_at?: string | null;
  versions?: string[] | null;
  manifest?: unknown;
  exports?: string[] | null;
  pricing_config?: unknown;
  gpu_pricing_config?: unknown;
  runtime?: string | null;
  app_type?: string | null;
  storage_key?: string | null;
  gpu_status?: string | null;
  gpu_type?: string | null;
  version_metadata?: unknown;
  env_schema?: Record<string, unknown> | null;
  tags?: string[] | null;
  category?: string | null;
  likes?: number | null;
  dislikes?: number | null;
  weighted_likes?: number | null;
  weighted_dislikes?: number | null;
  total_runs?: number | null;
  runs_30d?: number | null;
  hosting_suspended?: boolean | null;
  updated_at?: string | null;
  created_at?: string | null;
}

interface LaunchFleetSnapshotRow {
  agent_id: string;
  routine_count?: number | string | null;
  active_routine_count?: number | string | null;
  state?: string | null;
  health?: string | null;
  next_wake_at?: string | null;
  last_run_at?: string | null;
  deferred_wake_count?: number | string | null;
  unread_alert_count?: number | string | null;
  recent_activity?: unknown;
  capacity_state?: string | null;
  capacity_burst_state?: string | null;
  capacity_weekly_state?: string | null;
  capacity_burst_resets_at?: string | null;
  capacity_weekly_resets_at?: string | null;
  capacity_next_eligible_at?: string | null;
  capacity_cap_basis_points?: number | string | null;
  capacity_burst_used_percent?: number | string | null;
  capacity_weekly_used_percent?: number | string | null;
}

interface OwnerRow {
  id: string;
  display_name: string | null;
  profile_slug: string | null;
  avatar_url: string | null;
}

interface LibraryRow {
  app_id: string;
}

interface WalletRow {
  balance_light: number | null;
  deposit_balance_light: number | null;
  earned_balance_light: number | null;
  escrow_light: number | null;
  stripe_connect_account_id?: string | null;
  stripe_connect_onboarded?: boolean | null;
  stripe_connect_payouts_enabled?: boolean | null;
}

interface BillingTransactionRow {
  id: string;
  type: string | null;
  category: string | null;
  description: string | null;
  amount_light: number | null;
  balance_after_light?: number | null;
  app_id?: string | null;
  app_name?: string | null;
  created_at?: string | null;
}

interface TransferRow {
  amount_light: number | null;
  app_id?: string | null;
  function_name?: string | null;
  reason?: string | null;
  created_at?: string | null;
}

interface PayoutRow {
  id: string;
  amount_light: number | null;
  status: string | null;
  created_at?: string | null;
  completed_at?: string | null;
}

interface BuilderLeaderboardRpcRow {
  rank?: number | null;
  user_id?: string | null;
  owner_id?: string | null;
  publisher_user_id?: string | null;
  display_name?: string | null;
  profile_slug?: string | null;
  avatar_url?: string | null;
  earnings_light?: number | null;
  score?: number | null;
  weighted_likes?: number | null;
  total_likes?: number | null;
  total_runs?: number | null;
  event_count?: number | null;
  app_id?: string | null;
  app_slug?: string | null;
  app_name?: string | null;
  featured_app_slug?: string | null;
  featured_app_name?: string | null;
}

interface SemanticAppMatchRow {
  id: string;
  similarity?: number | null;
}

interface ToolSemanticEmbeddingMatchRow {
  embedding_id: string;
  app_id: string | null;
  app_version: string;
  subject_type: LaunchSemanticSubjectType;
  subject_id: string;
  subject_label?: string | null;
  embedding_text_hash: string;
  similarity?: number | null;
}

interface LaunchQueryEmbedding {
  embedding: number[];
  model: string;
}

interface RankedLaunchAppRow extends LaunchAppRow {
  launchRelevance?: LaunchRelevanceSummary;
}

interface PrimitiveEmbeddingCache {
  model: string;
  entries: Array<{
    primitive: LaunchPlatformPrimitive;
    embedding: number[];
  }>;
}

type DbHeaders = Record<string, string>;

interface DbConfig {
  baseUrl: string;
  headers: DbHeaders;
}

interface ToolMapOptions {
  owners: Map<string, LaunchAgentOwnerSummary>;
  viewerId?: string | null;
  installedIds?: Set<string>;
  // Set on the agent DETAIL response only — store/browse rows stay lean and
  // the FE gates the Interface tab on the detail payload.
  includeInterfaces?: boolean;
}

interface PrimitiveMetadata {
  label: string;
  description: string;
  route?: LaunchPublicRoute;
  apiRoute?: LaunchApiRoute;
}

interface ParsedLaunchWalletFundingIntentRequest
  extends LaunchWalletFundingIntentRequest {
  amountCredits: number;
  /** @deprecated alias of amountCredits */
  amountLight: number;
  method: LaunchWalletFundingMethod;
  termsAccepted: true;
  billingAddress?: BillingAddressInput;
}

interface WalletPageResult<T> {
  items: T[];
  page: LaunchWalletPageInfo;
}

interface ParsedWalletPageRequest extends LaunchWalletPageRequest {
  limit: number;
  cursor?: string;
  tool?: string;
}

class LaunchServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchServiceUnavailableError";
  }
}

const PRIMITIVE_METADATA: Record<LaunchPlatformPrimitive, PrimitiveMetadata> = {
  install: {
    label: "Install Galactic",
    description: "Connect the Galactic MCP/API layer to an existing agent.",
    route: "/",
    apiRoute: "GET /api/launch/install",
  },
  deploy: {
    label: "Deploy an Agent",
    description: "Ship deployable Agent code onto hosted Galactic runtime.",
    route: "/",
    apiRoute: "GET /api/launch/install",
  },
  api_keys: {
    label: "API keys",
    description: "Create API tokens for MCP, CLI, and direct API access.",
    route: "/account",
    apiRoute: "GET /api/launch/api-keys",
  },
  owner_admin: {
    label: "Owner admin",
    description: "Manage the Agent home, runtime settings, secrets, and logs.",
    route: "/admin/agents/:id",
    apiRoute: "GET /api/launch/admin/agents/:id",
  },
};

const PUBLIC_SEARCH_USER_ID = "00000000-0000-0000-0000-000000000000";
const SEMANTIC_DISCOVERY_THRESHOLD = 0.35;
let primitiveEmbeddingCache: PrimitiveEmbeddingCache | null = null;

const userService = createUserService();

// Legacy request paths from the Tools -> Agents rename (Phase 3): the old
// /api/launch/tools/* and .../agent-permissions paths normalize onto the
// canonical /agents/caller-permissions handlers. Removal is scheduled one
// release window after clients migrate (LAUNCH_COMPATIBILITY_API_ROUTES).
function normalizeLaunchApiPath(pathname: string): string {
  let normalized = pathname;
  const legacyToolsPrefix = "/api/launch/" + "tools/";
  const legacyAdminToolsPrefix = "/api/launch/admin/" + "tools/";
  if (normalized.startsWith(legacyAdminToolsPrefix)) {
    normalized = "/api/launch/admin/agents/" +
      normalized.slice(legacyAdminToolsPrefix.length);
  } else if (normalized.startsWith(legacyToolsPrefix)) {
    normalized = "/api/launch/agents/" +
      normalized.slice(legacyToolsPrefix.length);
  }
  // Anchored so an Agent slugged "agent-permissions" cannot be hijacked:
  // only .../agents/{locator}/agent-permissions rewrites.
  normalized = normalized.replace(
    /^(\/api\/launch\/agents\/[^/]+)\/agent-permissions$/,
    "$1/caller-permissions",
  );
  return normalized;
}

export interface LaunchHandlerDependencies {
  compute?: ComputeLaunchHandlerDependencies;
}

export async function handleLaunch(
  request: Request,
  dependencies: LaunchHandlerDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizeLaunchApiPath(url.pathname);
  const method = request.method;

  try {
    if (path === "/api/launch/subscription" && method === "GET") {
      const user = await requireLaunchUser(request);
      return privateLaunchJson(await getLaunchSubscription(user.id));
    }

    if (path === "/api/launch/capacity" && method === "GET") {
      const user = await requireLaunchUser(request);
      return privateLaunchJson(
        toLaunchCapacityResponse(await getAccountCapacityStatus(user.id)),
      );
    }

    if (
      path === "/api/launch/subscription/checkout" ||
      path === "/api/launch/subscription/portal"
    ) {
      if (method !== "POST") return error("Method not allowed", 405);
      const user = await requireLaunchUser(request);
      if (!isAccountSessionAuthSource(user.authSource)) {
        return error(
          "Subscription management requires an account session",
          403,
        );
      }
      const body = await request.json().catch(() => ({})) as Record<
        string,
        unknown
      >;
      if (path.endsWith("/checkout") && body.plan !== "pro") {
        return error("plan must be pro", 400);
      }
      const siteOrigin = getEnv("LAUNCH_WEB_BASE_URL") ||
        new URL(request.url).origin;
      const returnUrl = typeof body.returnUrl === "string"
        ? body.returnUrl
        : null;
      const redirectUrl = path.endsWith("/checkout")
        ? await createSubscriptionCheckout({
          userId: user.id,
          plan: (body as unknown as LaunchSubscriptionCheckoutRequest).plan,
          requestOrigin: siteOrigin,
          returnUrl,
        })
        : await createSubscriptionPortal({
          userId: user.id,
          requestOrigin: siteOrigin,
          returnUrl,
        });
      return privateLaunchJson(
        {
          url: redirectUrl,
          generatedAt: new Date().toISOString(),
        } satisfies LaunchSubscriptionRedirectResponse,
      );
    }

    if (
      path === "/api/launch/platform-model" ||
      path.startsWith("/api/launch/wallet")
    ) {
      return error(
        "This credits endpoint is not part of the persistent-Agent launch. Use BYOK and subscription capacity.",
        410,
      );
    }

    if (
      path === "/api/launch/api-keys" ||
      path.startsWith("/api/launch/api-keys/")
    ) {
      return await handleLaunchApiKeys(request, path, method);
    }

    if (
      path === "/api/launch/byok" ||
      path.startsWith("/api/launch/byok/")
    ) {
      return await handleLaunchByok(request, path, method);
    }

    if (path === "/api/launch/platform-model") {
      return await handleLaunchPlatformModel(request, method);
    }

    if (path === "/api/launch/notifications") {
      return await privateLaunchRoute(() =>
        handleLaunchNotifications(request, method)
      );
    }

    if (
      path === "/api/launch/grants" ||
      path.startsWith("/api/launch/grants/")
    ) {
      return await handleLaunchGrants(request, path, method);
    }

    if (
      path === "/api/launch/folders" ||
      path.startsWith("/api/launch/folders/")
    ) {
      return await handleLaunchFolders(request, path, method);
    }

    if (path === "/api/launch/wiring/targets") {
      return await handleLaunchWiringTargets(request, url, method);
    }

    // Durable async executions: poll a queued/running job (website twin of
    // ul.job). User-scoped read.
    const jobMatch = path.match(/^\/api\/launch\/jobs\/([^/]+)$/);
    if (jobMatch) {
      if (method !== "GET") {
        return error("Method not allowed for launch job status", 405);
      }
      const user = await requireLaunchUser(request);
      const jobId = decodeURIComponent(jobMatch[1]).trim();
      if (!isUuid(jobId)) {
        return error("Invalid job id", 400);
      }
      const { asyncJobAdmissionStatus, getJob } = await import(
        "../services/async-jobs.ts"
      );
      const job = await getJob(jobId, user.id);
      if (!job) return error("Job not found", 404);
      return json(
        {
          jobId: job.id,
          status: job.status,
          result: job.status === "completed" ? job.result : null,
          error: job.status === "failed" ? job.error : null,
          durationMs: job.duration_ms,
          aiCostCredits: job.ai_cost_light,
          admissionWait: asyncJobAdmissionStatus(job),
          executionId: job.execution_id || null,
          createdAt: job.created_at,
          completedAt: job.completed_at,
          generatedAt: new Date().toISOString(),
        } satisfies LaunchJobStatusResponse,
      );
    }

    if (path === "/api/launch/settings") {
      return await handleLaunchSettings(request, method);
    }

    if (isLaunchComputePath(path)) {
      return await handleLaunchComputeRoute(
        request,
        path,
        dependencies.compute,
      );
    }

    const agentHomeMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/home(?:\/(identity|routine|settings|actions|pause))?$/,
    );
    if (agentHomeMatch) {
      return await handleLaunchAgentHomeRoute(
        request,
        agentHomeMatch[1],
        method,
        agentHomeMatch[2] || null,
      );
    }

    const agentCapacityMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/capacity$/,
    );
    if (agentCapacityMatch) {
      return await privateLaunchRoute(() =>
        handleLaunchAgentCapacity(
          request,
          agentCapacityMatch[1],
          method,
        )
      );
    }

    const agentManagedRoutineActionMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/routines\/([^/]+)\/actions$/,
    );
    if (agentManagedRoutineActionMatch) {
      return await privateLaunchRoute(() =>
        handleLaunchAgentManagedRoutines(
          request,
          agentManagedRoutineActionMatch[1],
          method,
          agentManagedRoutineActionMatch[2],
          true,
        )
      );
    }

    const agentManagedRoutineMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/routines(?:\/([^/]+))?$/,
    );
    if (agentManagedRoutineMatch) {
      return await privateLaunchRoute(() =>
        handleLaunchAgentManagedRoutines(
          request,
          agentManagedRoutineMatch[1],
          method,
          agentManagedRoutineMatch[2] || null,
          false,
        )
      );
    }

    const agentRoutineActionMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/routine\/actions$/,
    );
    if (agentRoutineActionMatch) {
      return await handleLaunchAgentRoutine(
        request,
        agentRoutineActionMatch[1],
        method,
        true,
      );
    }

    const agentRoutineMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/routine$/,
    );
    if (agentRoutineMatch) {
      return await handleLaunchAgentRoutine(
        request,
        agentRoutineMatch[1],
        method,
        false,
      );
    }

    const agentWiringMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/wiring$/,
    );
    if (agentWiringMatch) {
      return await handleLaunchAgentWiring(
        request,
        agentWiringMatch[1],
        method,
      );
    }

    const callerTrustMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/caller-trust$/,
    );
    if (callerTrustMatch) {
      return await handleLaunchCallerTrust(
        request,
        callerTrustMatch[1],
        method,
      );
    }

    if (path === "/api/launch/wallet/topup/intent") {
      if (method !== "POST") {
        return error("Method not allowed for launch wallet top-up intent", 405);
      }
      return await handleLaunchWalletTopUpIntent(request);
    }

    if (path === "/api/launch/wallet/topup/cancel") {
      if (method !== "POST") {
        return error("Method not allowed for launch wallet top-up cancel", 405);
      }
      return await handleLaunchWalletTopUpCancel(request);
    }

    if (path === "/api/launch/wallet/topup/update-amount") {
      if (method !== "POST") {
        return error(
          "Method not allowed for launch wallet top-up amount update",
          405,
        );
      }
      return await handleLaunchWalletTopUpUpdateAmount(request);
    }

    const agentPermissionsMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/caller-permissions$/,
    );
    if (agentPermissionsMatch && method === "PATCH") {
      return await handleLaunchToolAgentPermissionsUpdate(
        request,
        agentPermissionsMatch[1],
      );
    }

    const functionRunMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/functions\/([^/]+)\/run$/,
    );
    if (functionRunMatch && method === "POST") {
      return await handleLaunchFunctionRun(
        request,
        functionRunMatch[1],
        functionRunMatch[2],
      );
    }

    const agentInstallMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/install$/,
    );
    if (agentInstallMatch && (method === "POST" || method === "DELETE")) {
      return await handleLaunchAgentInstall(
        request,
        agentInstallMatch[1],
        method,
      );
    }

    const inferenceOverrideMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/function-inference$/,
    );
    if (inferenceOverrideMatch) {
      return await handleLaunchFunctionInferenceOverride(
        request,
        inferenceOverrideMatch[1],
        method,
      );
    }

    const agentSettingsMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/settings$/,
    );
    if (agentSettingsMatch) {
      return await handleLaunchAgentSettings(
        request,
        agentSettingsMatch[1],
        method,
      );
    }

    if (method !== "GET") {
      return error("Launch API is read-only in this MVP facade", 405);
    }

    if (path === "/api/launch/status") {
      return json(buildLaunchStatus(request));
    }

    if (path === "/api/launch/openapi.json") {
      return json(buildLaunchOpenApiSpec(request));
    }

    if (path === "/api/launch/install") {
      return json(await buildLaunchInstallResponse(request, url));
    }

    if (path === "/api/launch/platform-primitives") {
      return json({
        suggestions: await buildPrimitiveSuggestions(
          url.searchParams.get("q"),
        ),
        generatedAt: new Date().toISOString(),
      });
    }

    if (path === "/api/launch/store" || path === "/api/launch/discover") {
      return await handleLaunchDiscover(request, url);
    }

    if (path === "/api/launch/library") {
      return await handleLaunchLibrary(request);
    }

    if (path === "/api/launch/fleet") {
      if (method !== "GET") return error("Method not allowed", 405);
      return await privateLaunchRoute(() => handleLaunchFleet(request));
    }

    if (path === "/api/launch/inference-options") {
      return await handleLaunchInferenceOptions(request);
    }

    if (path === "/api/launch/wallet") {
      return await handleLaunchWallet(request);
    }

    const walletDetailMatch = path.match(
      /^\/api\/launch\/wallet\/(transactions|receipts|earnings|payouts)$/,
    );
    if (walletDetailMatch) {
      return await handleLaunchWalletDetail(
        request,
        url,
        walletDetailMatch[1] as LaunchWalletDetailKind,
      );
    }

    if (path === "/api/launch/wallet/topup/quote") {
      return await handleLaunchWalletTopUpQuote(request, url);
    }

    if (path === "/api/launch/leaderboard") {
      return await handleLaunchLeaderboard(url);
    }

    const adminAgentMatch = path.match(
      /^\/api\/launch\/admin\/agents\/([^/]+)$/,
    );
    if (adminAgentMatch) {
      return await handleLaunchToolAdmin(request, adminAgentMatch[1]);
    }

    if (agentPermissionsMatch) {
      return await handleLaunchToolAgentPermissions(
        request,
        agentPermissionsMatch[1],
      );
    }

    const functionsMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/functions$/,
    );
    if (functionsMatch) {
      return await handleLaunchToolFunctions(request, functionsMatch[1]);
    }

    // Web projection of the `verify` capability (registry) — the signed
    // integrity verdict gx.verify returns, mounted here so the website has
    // parity with MCP/CLI. Authenticated read (matches gx.verify).
    const verifyMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/verify$/,
    );
    if (verifyMatch) {
      return await handleLaunchAgentVerify(request, verifyMatch[1]);
    }

    const toolMatch = path.match(/^\/api\/launch\/agents\/([^/]+)$/);
    if (toolMatch) {
      return await handleLaunchTool(request, toolMatch[1]);
    }

    return error("Launch endpoint not found", 404);
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    if (err instanceof LaunchServiceUnavailableError) {
      return error(err.message, 503);
    }
    console.error("[LAUNCH] API facade failed:", err);
    return error("Launch API request failed", 500);
  }
}

// GET /api/launch/agents/:id/verify — website projection of the `verify`
// capability. Runs the identical surface-neutral handler gx.verify uses, so the
// verdict is byte-for-byte the same across MCP, CLI, and website. Authenticated
// read (any identity authenticate() accepts, matching gx.verify's Tier-1 reach).
async function handleLaunchAgentVerify(
  request: Request,
  encodedLocator: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  const locator = parseLocator(encodedLocator);
  try {
    const verdict = await verifyAppIntegrity(user.id, locator);
    return json({ verdict });
  } catch (err) {
    if (err instanceof CapabilityError) {
      const status = err.code === "not_found"
        ? 404
        : err.code === "invalid_input"
        ? 400
        : err.code === "forbidden"
        ? 403
        : 500;
      return error(err.message, status);
    }
    throw err;
  }
}

function buildLaunchStatus(request: Request): Record<string, unknown> {
  const baseUrl = publicBaseUrl(request);
  return {
    available: true,
    version: LAUNCH_MVP_VERSION,
    thesis: LAUNCH_SCOPE_CONTRACT.thesis,
    policy: PERSISTENT_AGENT_LAUNCH_POLICY,
    timestamp: new Date().toISOString(),
    baseUrl,
    publicRoutes: LAUNCH_PUBLIC_ROUTES,
    compatibilityPublicRoutes: LAUNCH_SCOPE_CONTRACT.compatibilityPublicRoutes,
    apiRoutes: LAUNCH_API_ROUTES,
    installTargets: LAUNCH_INSTALL_TARGETS,
    capabilities: {
      included: LAUNCH_INCLUDED_CAPABILITIES,
      deferred: LAUNCH_DEFERRED_CAPABILITIES,
    },
    endpoints: {
      status: "/api/launch/status",
      openapi: "/api/launch/openapi.json",
      install: "/api/launch/install",
      apiKeys: "/api/launch/api-keys",
      byok: "/api/launch/byok",
      inferenceOptions: "/api/launch/inference-options",
      store: "/api/launch/store?query={query}",
      discover: "/api/launch/discover?query={query}",
      discoverAlias: "/api/launch/discover?query={query}",
      agentFunctions: "/api/launch/agents/{id}/functions",
      agentHome: "/api/launch/agents/{id}/home",
      agentHomeActions: "/api/launch/agents/{id}/home/actions",
      agentHomePause: "/api/launch/agents/{id}/home/pause",
      agentRoutine: "/api/launch/agents/{id}/routine",
      agentComputeSettings: "/api/launch/agents/{id}/compute/settings",
      agentComputeRuns:
        "/api/launch/agents/{id}/compute/runs?limit=50&cursor={cursor}",
      agentComputeCancel: "/api/launch/agents/{id}/compute/runs/{runId}/cancel",
      agentComputeArtifact:
        "/api/launch/agents/{id}/compute/runs/{runId}/artifacts/{artifactId}",
      // Deprecated alias keys kept for one rename window.
      toolFunctions: "/api/launch/agents/{id}/functions",
      functionRun: "/api/launch/agents/{id}/functions/{functionName}/run",
      jobStatus: "/api/launch/jobs/{jobId}",
      callerPermissions: "/api/launch/agents/{id}/caller-permissions",
      agentPermissions: "/api/launch/agents/{id}/caller-permissions",
      wiring: "/api/launch/agents/{id}/wiring",
      callerTrust: "/api/launch/agents/{id}/caller-trust",
      grants:
        "/api/launch/grants?caller={callerId}&target={targetId}&status={status}",
      wiringTargets: "/api/launch/wiring/targets?q={query}",
      settings: "/api/launch/settings",
      platformPrimitives: "/api/launch/platform-primitives?q={query}",
      leaderboard: "/api/launch/leaderboard?kind=builder&period=30d",
      subscription: "/api/launch/subscription",
      subscriptionCheckout: "/api/launch/subscription/checkout",
      subscriptionPortal: "/api/launch/subscription/portal",
      capacity: "/api/launch/capacity",
      mcpPlatform: "/mcp/platform",
      mcpDiscovery: "/.well-known/mcp.json",
      website: "/",
    },
    externalAgentLoop: [
      "Install Galactic MCP, CLI, or direct API access.",
      "Inspect your private Agents and platform primitives.",
      "Inspect Agent functions, permissions, capacity, and runtime health.",
      "Call Agents through MCP/API and return public Agent links when UI matters.",
      "Preserve structured capacity waits and retry timestamps in the final response.",
    ],
  };
}

function buildLaunchOpenApiSpec(request: Request): Record<string, unknown> {
  const baseUrl = publicBaseUrl(request);
  const jsonContent = (schema: Record<string, unknown>) => ({
    "application/json": { schema },
  });
  const queryParam = (
    name: string,
    schema: Record<string, unknown>,
    description: string,
    required = false,
  ) => ({ name, in: "query", required, schema, description });
  const storeParameters = [
    queryParam(
      "query",
      { type: "string", maxLength: 200 },
      "Natural language query for public Agents and primitives",
    ),
    queryParam(
      "kind",
      {
        type: "string",
        enum: ["all", "mcp", "http", "markdown", "gpu"],
        default: "all",
      },
      "Optional Agent kind filter",
    ),
    queryParam(
      "limit",
      { type: "integer", minimum: 1, maximum: 100, default: 24 },
      "Maximum Agent results to return",
    ),
  ];
  const storeResponse = {
    "200": {
      description: "Launch store results",
      content: jsonContent({
        type: "object",
        properties: {
          query: { type: ["string", "null"] },
          results: {
            type: "array",
            items: { $ref: "#/components/schemas/ToolSummary" },
          },
          platformPrimitives: {
            type: "array",
            items: {
              $ref: "#/components/schemas/PlatformPrimitiveSuggestion",
            },
          },
          retrieval: {
            $ref: "#/components/schemas/DiscoveryRetrieval",
          },
          generatedAt: { type: "string", format: "date-time" },
        },
      }),
    },
  };
  const storePathSpec = {
    get: {
      operationId: "storeLaunchTools",
      summary: "Browse public launch Agents and platform primitives",
      description:
        "Canonical launch store endpoint. Semantic-first Agent retrieval with lexical fallback. Results expose public Agent pages, pricing, owner, and retrieval metadata.",
      parameters: storeParameters,
      responses: storeResponse,
    },
  };
  const legacyDiscoverPathSpec = {
    get: {
      operationId: "discoverLaunchToolsLegacy",
      summary: "Legacy alias for the launch store",
      description:
        "Compatibility alias for GET /api/launch/store. New clients should use the store endpoint.",
      parameters: storeParameters,
      responses: storeResponse,
    },
  };
  const walletPageParameters = [
    queryParam(
      "cursor",
      { type: "string", format: "date-time" },
      "Cursor from the previous response. Uses the final row createdAt timestamp.",
    ),
    queryParam(
      "limit",
      {
        type: "integer",
        minimum: 1,
        maximum: MAX_WALLET_PAGE_LIMIT,
        default: DEFAULT_WALLET_PAGE_LIMIT,
      },
      "Maximum wallet rows to return",
    ),
  ];
  const walletAgentFilterParameter = queryParam(
    "agent",
    { type: "string", maxLength: 200 },
    "Optional Agent id filter for receipts and earnings",
  );
  const walletToolFilterParameter = queryParam(
    "tool",
    { type: "string", maxLength: 200 },
    "Deprecated alias of the agent filter parameter",
  );
  const walletPagePathSpec = (
    operationId: string,
    summary: string,
    kind: LaunchWalletDetailKind,
    itemSchema: Record<string, unknown>,
    includeToolFilter = false,
  ) => ({
    get: {
      operationId,
      summary,
      security: [{ bearerAuth: [] }],
      parameters: includeToolFilter
        ? [...walletPageParameters, walletToolFilterParameter]
        : walletPageParameters,
      responses: {
        "200": {
          description: `Paginated wallet ${kind}`,
          content: jsonContent({
            type: "object",
            required: ["kind", "items", "page", "generatedAt"],
            properties: {
              kind: { type: "string", const: kind },
              items: {
                type: "array",
                items: itemSchema,
              },
              page: { $ref: "#/components/schemas/WalletPage" },
              generatedAt: { type: "string", format: "date-time" },
            },
          }),
        },
        "401": { description: "Authentication required" },
      },
    },
  });

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Galactic Launch API",
      description:
        "Launch-scoped API facade for existing agents to connect, conjure, inspect, and operate persistent Galactic Agents.",
      version: LAUNCH_MVP_VERSION,
      contact: { name: "Galactic", url: baseUrl },
    },
    servers: [{ url: baseUrl, description: "Configured launch API origin" }],
    security: [{ bearerAuth: [] }, {}],
    paths: {
      "/api/launch/status": {
        get: {
          operationId: "getLaunchStatus",
          summary: "Inspect launch API capabilities and links",
          responses: {
            "200": {
              description: "Launch API health, endpoints, and agent loop",
              content: jsonContent({
                type: "object",
                required: ["available", "version", "apiRoutes", "endpoints"],
                properties: {
                  available: { type: "boolean" },
                  version: { type: "string" },
                  thesis: { type: "string" },
                  timestamp: { type: "string", format: "date-time" },
                  apiRoutes: {
                    type: "array",
                    items: { type: "string" },
                  },
                  endpoints: { type: "object" },
                },
              }),
            },
          },
        },
      },
      "/api/launch/install": {
        get: {
          operationId: "getLaunchInstallInstructions",
          summary: "Get MCP, CLI, and direct API install instructions",
          parameters: [
            queryParam(
              "agent",
              { type: "string", maxLength: 200 },
              "Optional public Agent id or slug for an Agent-specific install handoff",
            ),
            queryParam(
              "tool",
              { type: "string", maxLength: 200 },
              "Deprecated alias of the agent parameter",
            ),
          ],
          responses: {
            "200": {
              description:
                "Copyable launch install instructions and optional Agent-specific install context",
              content: jsonContent({
                type: "object",
                required: ["instructions", "generatedAt"],
                properties: {
                  instructions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/InstallInstruction" },
                  },
                  agentInstall: {
                    oneOf: [
                      { $ref: "#/components/schemas/AgentInstallContext" },
                      { type: "null" },
                    ],
                  },
                  toolInstall: {
                    description: "Deprecated alias of agentInstall.",
                    oneOf: [
                      { $ref: "#/components/schemas/AgentInstallContext" },
                      { type: "null" },
                    ],
                  },
                  generatedAt: { type: "string", format: "date-time" },
                },
              }),
            },
            "404": { description: "Requested install Agent not found" },
          },
        },
      },
      "/api/launch/api-keys": {
        get: {
          operationId: "listLaunchApiKeys",
          summary: "List authenticated launch API keys",
          description:
            "Returns API key metadata only. Full tokens are never returned from list responses.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "API key metadata",
              content: jsonContent({
                type: "object",
                required: ["apiKeys", "generatedAt"],
                properties: {
                  apiKeys: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ApiKeySummary" },
                  },
                  generatedAt: { type: "string", format: "date-time" },
                },
              }),
            },
            "401": { description: "Authentication required" },
          },
        },
        post: {
          operationId: "createLaunchApiKey",
          summary: "Create a reveal-once API key for external agents",
          description:
            "Creates a salted-hash API token. The plaintext token is returned only in this response.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent({
              $ref: "#/components/schemas/ApiKeyCreateRequest",
            }),
          },
          responses: {
            "200": {
              description: "Reveal-once API key payload",
              content: jsonContent({
                type: "object",
                required: [
                  "success",
                  "apiKey",
                  "plaintextToken",
                  "message",
                  "generatedAt",
                ],
                properties: {
                  success: { type: "boolean", const: true },
                  apiKey: { $ref: "#/components/schemas/ApiKeySummary" },
                  plaintextToken: { type: "string" },
                  message: { type: "string" },
                  generatedAt: { type: "string", format: "date-time" },
                },
              }),
            },
            "400": { description: "Invalid API key request" },
            "401": { description: "Authentication required" },
            "409": { description: "API key name already exists" },
          },
        },
      },
      "/api/launch/api-keys/{id}": {
        delete: {
          operationId: "revokeLaunchApiKey",
          summary: "Revoke an authenticated launch API key",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "API key id",
          }],
          responses: {
            "200": {
              description: "API key revoked",
              content: jsonContent({
                type: "object",
                required: ["success", "revokedId", "message", "generatedAt"],
                properties: {
                  success: { type: "boolean", const: true },
                  revokedId: { type: "string" },
                  message: { type: "string" },
                  generatedAt: { type: "string", format: "date-time" },
                },
              }),
            },
            "401": { description: "Authentication required" },
          },
        },
      },
      "/api/launch/byok": {
        get: {
          operationId: "getLaunchByokProviders",
          summary: "List BYOK inference providers and configured state",
          description:
            "Account-session endpoint. Returns the BYOK provider registry with per-provider configured/primary state. API key material is never returned.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "BYOK provider summary",
              content: jsonContent({
                $ref: "#/components/schemas/ByokSummary",
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
      },
      "/api/launch/byok/{provider}": {
        put: {
          operationId: "upsertLaunchByokProvider",
          summary: "Add or update a BYOK provider API key",
          description:
            "Account-session endpoint. Stores the provider API key encrypted server-side. The key is validated against the provider unless validate is false.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "provider",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "BYOK provider id",
          }],
          requestBody: {
            required: true,
            content: jsonContent({
              $ref: "#/components/schemas/ByokUpsertRequest",
            }),
          },
          responses: {
            "200": {
              description: "BYOK provider configured",
              content: jsonContent({
                $ref: "#/components/schemas/ByokMutation",
              }),
            },
            "400": { description: "Invalid provider, key, or model" },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
        delete: {
          operationId: "removeLaunchByokProvider",
          summary: "Remove a BYOK provider API key",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "provider",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "BYOK provider id",
          }],
          responses: {
            "200": {
              description: "BYOK provider removed",
              content: jsonContent({
                $ref: "#/components/schemas/ByokMutation",
              }),
            },
            "400": { description: "Invalid provider" },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
      },
      "/api/launch/byok/primary": {
        post: {
          operationId: "setLaunchByokPrimaryProvider",
          summary: "Set the primary BYOK provider",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              required: ["provider"],
              properties: {
                provider: { type: "string" },
              },
            }),
          },
          responses: {
            "200": {
              description: "Primary BYOK provider updated",
              content: jsonContent({
                $ref: "#/components/schemas/ByokMutation",
              }),
            },
            "400": { description: "Invalid or unconfigured provider" },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
      },
      "/api/launch/platform-model": {
        put: {
          operationId: "setLaunchPlatformModel",
          summary:
            "Set the platform (credits) OpenRouter model — no key required; empty clears it",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              required: ["model"],
              properties: {
                model: { type: "string" },
              },
            }),
          },
          responses: {
            "200": {
              description: "Platform model updated",
              content: jsonContent({
                type: "object",
                required: ["ok", "platformModel"],
                properties: {
                  ok: { type: "boolean" },
                  platformModel: { type: ["string", "null"] },
                },
              }),
            },
            "400": { description: "Invalid model id format" },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
      },
      "/api/launch/inference-options": {
        get: {
          operationId: "getLaunchInferenceOptions",
          summary: "Inspect the effective inference billing mode",
          description:
            "Account-session endpoint. Reports whether inference bills against BYOK keys or platform credits, plus spendable credits state.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Inference billing options",
              content: jsonContent({
                $ref: "#/components/schemas/InferenceOptions",
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
      },
      "/api/launch/grants": {
        get: {
          operationId: "listLaunchGrants",
          summary: "List cross-Agent function grants for the account",
          description:
            "Account-session endpoint. Returns grant summaries joined with Agent handles. Optional caller/target params accept Agent ids or slugs; an unresolvable filter is omitted.",
          security: [{ bearerAuth: [] }],
          parameters: [
            queryParam(
              "caller",
              { type: "string", maxLength: 200 },
              "Filter by caller Agent id or slug",
            ),
            queryParam(
              "target",
              { type: "string", maxLength: 200 },
              "Filter by target Agent id or slug",
            ),
            queryParam(
              "status",
              { type: "string", enum: ["active", "pending", "revoked"] },
              "Filter by grant status",
            ),
          ],
          responses: {
            "200": {
              description: "Grant summaries",
              content: jsonContent({
                $ref: "#/components/schemas/AgentGrantListResponse",
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
        post: {
          operationId: "createLaunchGrant",
          summary: "Create a cross-Agent function grant",
          description:
            "Account-session endpoint. Authorizes caller Agent A to call function F on target Agent B for the user. Enforces the delegation-not-expansion safety invariant server-side.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent({
              $ref: "#/components/schemas/AgentGrantCreateRequest",
            }),
          },
          responses: {
            "201": {
              description: "Created grant summary",
              content: jsonContent({
                type: "object",
                required: ["grant"],
                properties: {
                  grant: { $ref: "#/components/schemas/AgentGrantSummary" },
                },
              }),
            },
            "401": { description: "Authentication required" },
            "403": {
              description:
                "Account session required, or safety invariant violation",
            },
            "404": { description: "Caller or target Agent not found" },
          },
        },
      },
      "/api/launch/grants/{id}": {
        patch: {
          operationId: "updateLaunchGrant",
          summary: "Update a grant cap or revoke it",
          description:
            "Account-session endpoint. Sets the monthly cap and/or revokes the grant.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Grant id",
          }],
          requestBody: {
            required: true,
            content: jsonContent({
              $ref: "#/components/schemas/AgentGrantUpdateRequest",
            }),
          },
          responses: {
            "200": {
              description: "Updated grant summary",
              content: jsonContent({
                type: "object",
                required: ["grant"],
                properties: {
                  grant: { $ref: "#/components/schemas/AgentGrantSummary" },
                },
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
            "404": { description: "Grant not found" },
          },
        },
        delete: {
          operationId: "revokeLaunchGrant",
          summary: "Revoke a cross-Agent function grant",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Grant id",
          }],
          responses: {
            "200": {
              description: "Grant revoked",
              content: jsonContent({
                type: "object",
                required: ["ok"],
                properties: { ok: { type: "boolean" } },
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
            "404": { description: "Grant not found" },
          },
        },
      },
      "/api/launch/grants/{id}/approve": {
        post: {
          operationId: "approveLaunchGrant",
          summary: "Approve a pending grant request",
          description:
            "Account-session endpoint. Re-runs the safety invariant, flips pending to active, and optionally sets a monthly cap.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Grant id",
          }],
          requestBody: {
            required: false,
            content: jsonContent({
              $ref: "#/components/schemas/AgentGrantApproveRequest",
            }),
          },
          responses: {
            "200": {
              description: "Approved grant summary",
              content: jsonContent({
                type: "object",
                required: ["grant"],
                properties: {
                  grant: { $ref: "#/components/schemas/AgentGrantSummary" },
                },
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
            "404": { description: "Grant not found" },
          },
        },
      },
      "/api/launch/agents/{id}/wiring": {
        get: {
          operationId: "getLaunchAgentWiring",
          summary: "Inspect an Agent's cross-Agent wiring view",
          description:
            "Account-session endpoint. Returns the Agent's declared slots (with bindings), outbound/inbound grants, and the pending-request inbox.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Agent id or slug",
          }],
          responses: {
            "200": {
              description: "Agent wiring view",
              content: jsonContent({
                $ref: "#/components/schemas/AgentWiringView",
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
            "404": { description: "Agent not found" },
          },
        },
      },
      "/api/launch/agents/{id}/caller-trust": {
        get: {
          operationId: "getLaunchCallerTrust",
          summary: "Inspect a caller Agent's egress-trust signals",
          description:
            "Account-session endpoint. Surfaces the caller's net-egress permissions, declared permissions, and code fingerprint (surface + warn, never block).",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Agent id or slug",
          }],
          responses: {
            "200": {
              description: "Caller trust summary",
              content: jsonContent({
                $ref: "#/components/schemas/AgentCallerTrustSummary",
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
            "404": { description: "Agent not found" },
          },
        },
      },
      "/api/launch/wiring/targets": {
        get: {
          operationId: "listLaunchWiringTargets",
          summary: "List Agents eligible as grant targets",
          description:
            "Account-session endpoint. Returns owned/installed Agents (with callable functions) the user could bind a slot or grant to.",
          security: [{ bearerAuth: [] }],
          parameters: [
            queryParam(
              "q",
              { type: "string", maxLength: 200 },
              "Optional query filtering by Agent name or function",
            ),
          ],
          responses: {
            "200": {
              description: "Eligible wiring targets",
              content: jsonContent({
                type: "object",
                required: ["targets", "generatedAt"],
                properties: {
                  targets: {
                    type: "array",
                    items: {
                      $ref: "#/components/schemas/AgentWiringTarget",
                    },
                  },
                  generatedAt: { type: "string", format: "date-time" },
                },
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
      },
      "/api/launch/settings": {
        get: {
          operationId: "getLaunchSettings",
          summary: "Read account grant settings",
          description:
            "Account-session endpoint. Reports whether the connected agent may approve grants (vs only propose/revoke).",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Account grant settings",
              content: jsonContent({
                $ref: "#/components/schemas/LaunchGrantSettings",
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
        patch: {
          operationId: "updateLaunchSettings",
          summary: "Update account grant settings",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              properties: {
                agentGrantAutoApprove: { type: "boolean" },
                displayName: { type: ["string", "null"] },
              },
            }),
          },
          responses: {
            "200": {
              description: "Updated account grant settings",
              content: jsonContent({
                $ref: "#/components/schemas/LaunchGrantSettings",
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
          },
        },
      },
      "/api/launch/store": storePathSpec,
      "/api/launch/discover": legacyDiscoverPathSpec,
      "/api/launch/agents/{id}": {
        get: {
          operationId: "getLaunchTool",
          summary: "Inspect a public Agent by id or slug",
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Agent id or slug",
          }],
          responses: {
            "200": {
              description: "Public Agent profile and trust metadata",
              content: jsonContent({
                type: "object",
                properties: {
                  agent: { $ref: "#/components/schemas/ToolSummary" },
                  tool: {
                    $ref: "#/components/schemas/ToolSummary",
                    description: "Deprecated alias of agent",
                  },
                  trustCard: { $ref: "#/components/schemas/TrustCard" },
                },
              }),
            },
            "404": { description: "Agent not found" },
          },
        },
      },
      "/api/launch/agents/{id}/home": {
        get: {
          operationId: "getLaunchAgentHome",
          summary: "Read the canonical private persistent Agent Home snapshot",
          description:
            "Owner account-session only. Returns one versioned read model for identity, responsibility, lifecycle/execution/health, setup blockers, secret-safe setting status, effective authority, exact budget usage, recent runs, and live/tested release state. Responses are private, no-store and vary on Cookie and Authorization.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Owned private Agent id or slug",
          }],
          responses: {
            "200": {
              description:
                "Canonical Agent Home snapshot; secret values are never returned",
              content: jsonContent({ $ref: "#/components/schemas/AgentHome" }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
            "404": { description: "Owned Agent not found" },
            "409": { description: "Agent is not private" },
            "503": { description: "An authoritative subsystem is unavailable" },
          },
        },
      },
      "/api/launch/agents/{id}/home/identity": {
        patch: {
          operationId: "updateLaunchAgentHomeIdentity",
          summary:
            "Atomically update Agent identity with optimistic concurrency",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              additionalProperties: false,
              required: ["expectedRevision"],
              properties: {
                expectedRevision: { type: "string" },
                name: { type: "string", minLength: 1, maxLength: 200 },
                description: { type: ["string", "null"], maxLength: 5000 },
              },
            }),
          },
          responses: {
            "200": {
              description: "Refreshed Agent Home snapshot",
              content: jsonContent({ $ref: "#/components/schemas/AgentHome" }),
            },
            "400": { description: "Invalid mutation" },
            "403": { description: "Account session required" },
            "412": {
              description:
                "Stale revision, with currentRevision and current snapshot",
            },
          },
        },
      },
      "/api/launch/agents/{id}/home/routine": {
        patch: {
          operationId: "updateLaunchAgentHomeRoutine",
          summary:
            "Atomically update mission, interval/cron cadence, or hard ceilings",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              additionalProperties: false,
              required: ["expectedRevision"],
              properties: {
                expectedRevision: { type: "string" },
                mission: { type: ["string", "null"], maxLength: 1000 },
                intervalSeconds: {
                  type: "integer",
                  minimum: MIN_ROUTINE_INTERVAL_SECONDS,
                },
                schedule: {
                  oneOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind", "intervalSeconds"],
                      properties: {
                        kind: { type: "string", const: "interval" },
                        intervalSeconds: {
                          type: "integer",
                          minimum: MIN_ROUTINE_INTERVAL_SECONDS,
                        },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["kind", "expression"],
                      properties: {
                        kind: { type: "string", const: "cron" },
                        expression: { type: "string" },
                        timezone: { type: "string", default: "UTC" },
                      },
                    },
                  ],
                },
                budgets: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "maxLightPerRun",
                    "maxLightPerDay",
                    "maxLightPerMonth",
                    "maxCallsPerRun",
                  ],
                  properties: {
                    maxLightPerRun: { type: "number", minimum: 0 },
                    maxLightPerDay: { type: "number", minimum: 0 },
                    maxLightPerMonth: { type: "number", minimum: 0 },
                    maxCallsPerRun: { type: "integer", minimum: 1 },
                  },
                },
              },
            }),
          },
          responses: {
            "200": {
              description: "Refreshed Agent Home snapshot",
              content: jsonContent({ $ref: "#/components/schemas/AgentHome" }),
            },
            "400": { description: "Invalid cadence or budget ceilings" },
            "403": { description: "Account session required" },
            "404": { description: "Routine proposal not found" },
            "412": { description: "Stale revision with the current snapshot" },
          },
        },
      },
      "/api/launch/agents/{id}/home/settings": {
        put: {
          operationId: "updateLaunchAgentHomeSettings",
          summary: "Atomically set, replace, or remove declared Agent settings",
          description:
            "Values are encrypted before the CAS transaction and never appear in the response. Use null to remove a value.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              additionalProperties: false,
              required: ["expectedRevision", "values"],
              properties: {
                expectedRevision: { type: "string" },
                values: {
                  type: "object",
                  minProperties: 1,
                  maxProperties: 50,
                  additionalProperties: { type: ["string", "null"] },
                },
              },
            }),
          },
          responses: {
            "200": {
              description: "Refreshed secret-safe Agent Home snapshot",
              content: jsonContent({ $ref: "#/components/schemas/AgentHome" }),
            },
            "400": { description: "Unknown or invalid setting" },
            "403": { description: "Account session required" },
            "412": { description: "Stale revision with the current snapshot" },
          },
        },
      },
      "/api/launch/agents/{id}/home/actions": {
        post: {
          operationId: "actOnLaunchAgentHome",
          summary: "Approve, activate, pause, wake, or safely promote an Agent",
          description:
            "Owner account-session only. Activation and manual wakes require every setup, grant, reporting, and executed-integrity blocker to be resolved. Promotion reuses the tested-version promotion transaction and never patches the generic Apps endpoint.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              additionalProperties: false,
              required: ["expectedRevision", "idempotencyKey", "action"],
              properties: {
                expectedRevision: { type: "string" },
                idempotencyKey: {
                  type: "string",
                  format: "uuid",
                  description:
                    "Stable across retries of this exact action; generate a new UUID for a new intent.",
                },
                action: {
                  type: "string",
                  enum: [
                    "approve_capabilities",
                    "activate",
                    "pause",
                    "run_now",
                    "promote_candidate",
                  ],
                },
                capabilityIds: {
                  type: "array",
                  minItems: 1,
                  maxItems: 100,
                  uniqueItems: true,
                  items: { type: "string" },
                },
                version: { type: "string" },
              },
            }),
          },
          responses: {
            "200": {
              description: "Refreshed Agent Home snapshot",
              content: jsonContent({ $ref: "#/components/schemas/AgentHome" }),
            },
            "400": { description: "Invalid action" },
            "403": { description: "Account session required" },
            "409": {
              description:
                "Action blocked, previously failed, or an identical action is still in progress",
            },
            "412": { description: "Stale revision with the current snapshot" },
          },
        },
      },
      "/api/launch/agents/{id}/home/pause": {
        post: {
          operationId: "pauseLaunchAgentHome",
          summary: "Emergency-pause a private persistent Agent",
          description:
            "Owner account-session only. This idempotent stop lane intentionally bypasses Home aggregation, optimistic revision checks, and promotion/action leases so it remains available during degraded or partially repaired runtime state.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          responses: {
            "200": { description: "Primary routine is paused" },
            "403": { description: "Account session required" },
            "404": { description: "Agent or routine proposal not found" },
            "409": { description: "Routine is disabled" },
          },
        },
      },
      "/api/launch/agents/{id}/routine": {
        get: {
          operationId: "getLaunchAgentRoutine",
          summary:
            "Get the owner-safe state of a private Agent's primary routine",
          description:
            "Account-session and owner-only. Returns mission, interval cadence, finite hard budgets, exact capability approvals, blockers, and sanitized recent-run summaries. Secret values and routine config are never returned.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Private Agent id or slug",
          }],
          responses: {
            "200": {
              description:
                "Primary routine overview, or an honest null proposal",
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
            "404": { description: "Owned Agent not found" },
            "409": { description: "Agent is not private" },
          },
        },
        patch: {
          deprecated: true,
          operationId: "retiredUpdateLaunchAgentRoutine",
          summary: "Retired: use PATCH /home/routine with expectedRevision",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          responses: {
            "403": { description: "Account session required" },
            "404": { description: "Routine proposal not found" },
            "410": { description: "Legacy mutation route retired" },
          },
        },
      },
      "/api/launch/agents/{id}/routine/actions": {
        post: {
          deprecated: true,
          operationId: "retiredActOnLaunchAgentRoutine",
          summary: "Retired: use /home/actions or /home/pause",
          description:
            "Retired so callers cannot bypass Agent Home CAS, durable idempotency, promotion serialization, or run concurrency gates.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          }],
          responses: {
            "403": { description: "Account session required" },
            "404": { description: "Routine proposal not found" },
            "410": { description: "Legacy mutation route retired" },
          },
        },
      },
      "/api/launch/agents/{id}/functions": {
        get: {
          operationId: "getLaunchToolFunctions",
          summary: "List launch-safe functions for a tool",
          description:
            "Returns public function metadata, pricing, and the signed-in user's effective external-agent policy when authenticated.",
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Agent id or slug",
          }],
          responses: {
            "200": {
              description: "Tool function summaries",
              content: jsonContent({
                $ref: "#/components/schemas/ToolFunctionsResponse",
              }),
            },
            "404": { description: "Agent not found" },
          },
        },
      },
      "/api/launch/agents/{id}/functions/{functionName}/run": {
        post: {
          operationId: "runLaunchToolFunction",
          summary: "Run one tool function from the launch website",
          description:
            "Authenticated account-session endpoint. Runs through the existing runtime, billing, secret, and receipt path. Connected-agent permission policies do not block manual website runs.",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Agent id or slug",
            },
            {
              name: "functionName",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Function name from the tool manifest",
            },
          ],
          requestBody: {
            required: false,
            content: jsonContent({
              type: "object",
              properties: {
                args: { type: "object", additionalProperties: true },
              },
            }),
          },
          responses: {
            "200": {
              description: "Function result and receipt id",
              content: jsonContent({
                $ref: "#/components/schemas/FunctionRunResponse",
              }),
            },
            "401": { description: "Authentication required" },
            "402": {
              description: "Credits balance required by runtime billing",
            },
            "404": { description: "Tool or function not found" },
          },
        },
      },
      "/api/launch/jobs/{jobId}": {
        get: {
          operationId: "getLaunchJobStatus",
          summary: "Poll a durable async execution",
          description:
            'Authenticated account-session endpoint. Functions declared async (or run with _async: true) return { _async: true, job_id, status: "queued" } from the run endpoint; poll this endpoint with that job_id until status is completed or failed. Jobs are user-scoped.',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "jobId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
              description: "The job_id from an async run envelope",
            },
          ],
          responses: {
            "200": {
              description: "Current job status (result present once completed)",
              content: jsonContent({
                $ref: "#/components/schemas/JobStatusResponse",
              }),
            },
            "400": { description: "Invalid job id" },
            "401": { description: "Authentication required" },
            "404": { description: "Job not found" },
          },
        },
      },
      "/api/launch/agents/{id}/caller-permissions": {
        get: {
          operationId: "getLaunchToolAgentPermissions",
          summary: "Get connected-agent permission policy for an Agent",
          description:
            "Account-session endpoint. Returns the user's default external-agent policy plus per-function effective policies for the selected tool.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Agent id or slug",
          }],
          responses: {
            "200": {
              description: "Per-function connected-agent permission policy",
              content: jsonContent({
                $ref: "#/components/schemas/CallerFunctionPermissions",
              }),
            },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
            "404": { description: "Agent not found" },
          },
        },
        patch: {
          operationId: "updateLaunchToolAgentPermissions",
          summary: "Update connected-agent permission policy for an Agent",
          description:
            "Sets the user's launch default policy and/or explicit per-function overrides. Default launch policy is ask.",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Agent id or slug",
          }],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              properties: {
                defaultPolicy: {
                  type: "string",
                  enum: LAUNCH_CALLER_FUNCTION_POLICIES,
                },
                permissions: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["functionName", "policy"],
                    properties: {
                      functionName: { type: "string" },
                      policy: {
                        type: "string",
                        enum: LAUNCH_CALLER_FUNCTION_POLICIES,
                      },
                    },
                  },
                },
              },
            }),
          },
          responses: {
            "200": {
              description: "Updated per-function external-agent policy",
              content: jsonContent({
                $ref: "#/components/schemas/CallerFunctionPermissions",
              }),
            },
            "400": { description: "Invalid policy request" },
            "401": { description: "Authentication required" },
            "403": { description: "Account session required" },
            "404": { description: "Agent not found" },
          },
        },
      },
      "/api/launch/library": {
        get: {
          operationId: "getLaunchLibrary",
          summary: "List authenticated owned and installed Agents",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Owned and installed launch tools",
              content: jsonContent({
                type: "object",
                properties: {
                  owned: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ToolSummary" },
                  },
                  installed: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ToolSummary" },
                  },
                },
              }),
            },
            "401": { description: "Authentication required" },
          },
        },
      },
      "/api/launch/admin/agents/{id}": {
        get: {
          operationId: "getLaunchToolAdmin",
          summary: "Inspect owner-only launch-safe tool administration",
          security: [{ bearerAuth: [] }],
          parameters: [{
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Owned tool id or slug",
          }],
          responses: {
            "200": {
              description: "Tool admin summary",
              content: jsonContent({
                type: "object",
                properties: {
                  admin: { type: "object" },
                  trustCard: { $ref: "#/components/schemas/TrustCard" },
                },
              }),
            },
            "401": { description: "Authentication required" },
            "404": { description: "Agent not found or not owned" },
          },
        },
      },
      "/api/launch/wallet": {
        get: {
          operationId: "getLaunchWallet",
          summary: "Get authenticated credits balance and payout status",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Credits wallet summary and recent wallet rows",
              content: jsonContent({
                type: "object",
                properties: {
                  wallet: { $ref: "#/components/schemas/WalletSummary" },
                  generatedAt: { type: "string", format: "date-time" },
                },
              }),
            },
            "401": { description: "Authentication required" },
          },
        },
      },
      "/api/launch/wallet/transactions": walletPagePathSpec(
        "listLaunchWalletTransactions",
        "List paginated credits wallet transactions",
        "transactions",
        { $ref: "#/components/schemas/WalletTransaction" },
      ),
      "/api/launch/wallet/receipts": walletPagePathSpec(
        "listLaunchWalletReceipts",
        "List paginated Agent-call receipts",
        "receipts",
        { $ref: "#/components/schemas/WalletReceipt" },
        true,
      ),
      "/api/launch/wallet/earnings": walletPagePathSpec(
        "listLaunchWalletEarnings",
        "List paginated creator earnings",
        "earnings",
        { $ref: "#/components/schemas/WalletEarning" },
        true,
      ),
      "/api/launch/wallet/payouts": walletPagePathSpec(
        "listLaunchWalletPayouts",
        "List paginated payout records",
        "payouts",
        { $ref: "#/components/schemas/WalletPayout" },
      ),
      "/api/launch/wallet/topup/quote": {
        get: {
          operationId: "quoteLaunchWalletTopUp",
          summary: "Quote a credits top-up with pass-through payment fees",
          security: [{ bearerAuth: [] }],
          parameters: [
            queryParam(
              "amount_credits",
              { type: "integer", minimum: 1000, maximum: 500000 },
              "Credits amount the user wants to receive",
            ),
            {
              ...queryParam(
                "amount_light",
                { type: "integer", minimum: 1000, maximum: 500000 },
                "Deprecated alias of amount_credits",
              ),
              deprecated: true,
            },
            queryParam(
              "method",
              { type: "string", enum: ["card", "ach"], default: "card" },
              "Funding method. ach is labeled Bank (ACH) in launch UI.",
            ),
          ],
          responses: {
            "200": {
              description: "Top-up fee quote and launch presets",
              content: jsonContent({
                type: "object",
                properties: {
                  quote: { $ref: "#/components/schemas/WalletFundingQuote" },
                  presets: {
                    type: "array",
                    items: { type: "object" },
                  },
                  generatedAt: { type: "string", format: "date-time" },
                },
              }),
            },
            "401": { description: "Authentication required" },
          },
        },
      },
      "/api/launch/wallet/topup/intent": {
        post: {
          operationId: "createLaunchWalletTopUpIntent",
          summary: "Create a Stripe PaymentIntent for a credits top-up",
          description:
            "Creates a PaymentIntent for the selected credits amount. The amount charged includes true gross-up for Stripe processing fees, and the wallet ledger credits exactly the requested amount after success. amount_credits is required; amount_light is accepted as a deprecated alias.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: jsonContent({
              type: "object",
              required: ["method", "terms_accepted"],
              properties: {
                amount_credits: {
                  type: "integer",
                  minimum: 1000,
                  maximum: 500000,
                },
                amount_light: {
                  type: "integer",
                  minimum: 1000,
                  maximum: 500000,
                  deprecated: true,
                  description: "Deprecated alias of amount_credits",
                },
                method: { type: "string", enum: ["card", "ach"] },
                terms_accepted: { type: "boolean", const: true },
                billing_address: { type: "object" },
              },
            }),
          },
          responses: {
            "200": {
              description: "Stripe client secret and fee quote",
              content: jsonContent({
                type: "object",
                properties: {
                  success: { type: "boolean", const: true },
                  publishableKey: { type: "string" },
                  paymentIntentId: { type: "string" },
                  clientSecret: { type: "string" },
                  stripeCustomerId: { type: "string" },
                  quote: { $ref: "#/components/schemas/WalletFundingQuote" },
                  billingAddress: { type: ["object", "null"] },
                  generatedAt: { type: "string", format: "date-time" },
                },
              }),
            },
            "400": { description: "Invalid funding request" },
            "401": { description: "Authentication required" },
            "503": { description: "Stripe wallet funding is not configured" },
          },
        },
      },
      "/api/launch/leaderboard": {
        get: {
          operationId: "getLaunchLeaderboard",
          summary:
            "Get a launch leaderboard. The Top Agents (agent_fee_credit) and " +
            "Top Builders (fee_credit) charts rank by platform fees waived — " +
            "earned by bringing customers through publisher referral links.",
          parameters: [
            queryParam(
              "kind",
              {
                type: "string",
                enum: ["builder", "fee_credit", "agent_fee_credit"],
                default: "builder",
              },
              "Leaderboard kind",
            ),
            queryParam(
              "period",
              { type: "string", enum: ["30d", "90d", "all"], default: "30d" },
              "Ranking period",
            ),
            queryParam(
              "limit",
              { type: "integer", minimum: 1, maximum: 100, default: 50 },
              "Maximum entries",
            ),
          ],
          responses: {
            "200": { description: "Launch leaderboard entries" },
          },
        },
      },
      "/api/launch/platform-primitives": {
        get: {
          operationId: "getLaunchPlatformPrimitives",
          summary: "Suggest platform primitives for an agent task",
          parameters: [
            queryParam(
              "q",
              { type: "string", maxLength: 200 },
              "Optional natural language query",
            ),
          ],
          responses: {
            "200": {
              description: "Platform primitive suggestions",
              content: jsonContent({
                type: "object",
                properties: {
                  suggestions: {
                    type: "array",
                    items: {
                      $ref: "#/components/schemas/PlatformPrimitiveSuggestion",
                    },
                  },
                },
              }),
            },
          },
        },
      },
      "/mcp/platform": {
        post: {
          operationId: "callPlatformMcp",
          summary: "Call the Galactic platform MCP JSON-RPC endpoint",
          description:
            "Use JSON-RPC 2.0 methods such as initialize, tools/list, and tools/call. Requires bearer auth for user-specific tools.",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "JSON-RPC response" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        InstallInstruction: {
          type: "object",
          properties: {
            target: { type: "string" },
            label: { type: "string" },
            description: { type: "string" },
            steps: { type: "array", items: { type: "string" } },
            configText: { type: "string" },
            requiresApiKey: { type: "boolean" },
          },
        },
        AgentInstallContext: {
          type: "object",
          required: [
            "agent",
            "selectedAgentSlug",
            "publicAgentUrl",
            "installUrl",
            "platformMcpUrl",
            "recommendedApiKey",
            "agentHandoff",
          ],
          properties: {
            agent: { $ref: "#/components/schemas/ToolSummary" },
            tool: {
              description: "Deprecated alias of agent.",
              $ref: "#/components/schemas/ToolSummary",
            },
            selectedAgentSlug: { type: "string" },
            selectedToolSlug: {
              type: "string",
              description: "Deprecated alias of selectedAgentSlug.",
            },
            publicAgentUrl: { type: "string" },
            publicToolUrl: {
              type: "string",
              description: "Deprecated alias of publicAgentUrl.",
            },
            installUrl: { type: "string" },
            platformMcpUrl: { type: "string" },
            recommendedApiKey: {
              $ref: "#/components/schemas/ApiKeyCreateRequest",
            },
            agentHandoff: { type: "array", items: { type: "string" } },
          },
        },
        ApiKeySummary: {
          type: "object",
          required: ["id", "name", "tokenPrefix", "scopes", "createdAt"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            tokenPrefix: { type: "string" },
            scopes: { type: "array", items: { type: "string" } },
            appIds: {
              type: ["array", "null"],
              items: { type: "string" },
            },
            functionNames: {
              type: ["array", "null"],
              items: { type: "string" },
            },
            lastUsedAt: { type: ["string", "null"], format: "date-time" },
            expiresAt: { type: ["string", "null"], format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        ApiKeyCreateRequest: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 50 },
            expiresInDays: {
              type: "integer",
              minimum: 1,
              maximum: 365,
            },
            scopes: { type: "array", items: { type: "string" } },
            appIds: { type: "array", items: { type: "string" } },
            functionNames: { type: "array", items: { type: "string" } },
          },
        },
        ByokProviderOption: {
          type: "object",
          required: ["id", "name", "configured", "primary"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            configured: { type: "boolean" },
            primary: { type: "boolean" },
            defaultModel: { type: ["string", "null"] },
            model: { type: ["string", "null"] },
            apiKeyPrefix: { type: ["string", "null"] },
            apiKeyUrl: { type: ["string", "null"] },
            docsUrl: { type: ["string", "null"] },
          },
        },
        ByokSummary: {
          type: "object",
          required: ["enabled", "primaryProvider", "providers"],
          properties: {
            enabled: { type: "boolean" },
            primaryProvider: { type: ["string", "null"] },
            providers: {
              type: "array",
              items: { $ref: "#/components/schemas/ByokProviderOption" },
            },
            generatedAt: { type: "string", format: "date-time" },
          },
        },
        ByokUpsertRequest: {
          type: "object",
          required: ["apiKey"],
          properties: {
            apiKey: { type: "string", minLength: 1 },
            model: { type: "string" },
            validate: { type: "boolean", default: true },
          },
        },
        ByokMutation: {
          type: "object",
          required: ["ok", "provider", "message"],
          properties: {
            ok: { type: "boolean", const: true },
            provider: { type: "string" },
            message: { type: "string" },
          },
        },
        InferenceOptions: {
          type: "object",
          required: [
            "billingMode",
            "primaryProvider",
            "configuredProviders",
          ],
          properties: {
            billingMode: { type: "string", const: "byok" },
            primaryProvider: { type: ["string", "null"] },
            configuredProviders: {
              type: "array",
              items: { type: "string" },
            },
            generatedAt: { type: "string", format: "date-time" },
          },
        },
        AgentHandle: {
          type: "object",
          required: ["id", "slug", "name"],
          properties: {
            id: { type: "string" },
            slug: { type: ["string", "null"] },
            name: { type: ["string", "null"] },
          },
        },
        AgentGrantSummary: {
          type: "object",
          required: [
            "id",
            "callerApp",
            "targetApp",
            "callerFunction",
            "slot",
            "targetFunction",
            "topic",
            "mode",
            "status",
            "monthlyCapCredits",
            "spentCreditsPeriod",
            "periodStart",
            "createdBy",
            "updatedAt",
          ],
          properties: {
            id: { type: "string" },
            callerApp: { $ref: "#/components/schemas/AgentHandle" },
            targetApp: { $ref: "#/components/schemas/AgentHandle" },
            callerFunction: { type: ["string", "null"] },
            slot: { type: ["string", "null"] },
            targetFunction: { type: "string" },
            topic: { type: ["string", "null"] },
            mode: { type: "string", enum: ["call", "subscribe"] },
            status: {
              type: "string",
              enum: ["active", "pending", "revoked"],
            },
            monthlyCapCredits: { type: ["number", "null"] },
            spentCreditsPeriod: { type: "number" },
            periodStart: { type: "string", format: "date-time" },
            createdBy: {
              type: "string",
              enum: ["user", "agent", "developer_hint", "auto_request"],
            },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        AgentGrantListResponse: {
          type: "object",
          required: ["grants", "generatedAt"],
          properties: {
            grants: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentGrantSummary" },
            },
            generatedAt: { type: "string", format: "date-time" },
          },
        },
        AgentGrantCreateRequest: {
          type: "object",
          required: ["callerAppId", "targetAppId", "targetFunction"],
          properties: {
            callerAppId: { type: "string" },
            targetAppId: { type: "string" },
            targetFunction: { type: "string" },
            callerFunction: { type: ["string", "null"] },
            slot: { type: ["string", "null"] },
            mode: { type: "string", enum: ["call", "subscribe"] },
            topic: { type: ["string", "null"] },
            monthlyCapCredits: { type: ["number", "null"] },
            constraints: { type: "object", additionalProperties: true },
          },
        },
        AgentGrantApproveRequest: {
          type: "object",
          properties: {
            monthlyCapCredits: { type: ["number", "null"] },
          },
        },
        AgentGrantUpdateRequest: {
          type: "object",
          properties: {
            monthlyCapCredits: { type: ["number", "null"] },
            status: { type: "string", enum: ["active", "revoked"] },
          },
        },
        AgentImportSlot: {
          type: "object",
          required: ["name", "expectedFunctions"],
          properties: {
            name: { type: "string" },
            description: { type: ["string", "null"] },
            signature: { type: ["string", "null"] },
            expectedFunctions: { type: "array", items: { type: "string" } },
            binding: {
              oneOf: [
                { $ref: "#/components/schemas/AgentGrantSummary" },
                { type: "null" },
              ],
            },
          },
        },
        AgentWiringTarget: {
          type: "object",
          required: ["app", "relationship", "visibility", "functions", "emits"],
          properties: {
            app: { $ref: "#/components/schemas/AgentHandle" },
            relationship: {
              type: "string",
              enum: ["owned", "installed", "accessible"],
            },
            visibility: { type: "string" },
            functions: {
              type: "array",
              items: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  description: { type: ["string", "null"] },
                },
              },
            },
            emits: { type: "array", items: { type: "string" } },
          },
        },
        AgentCallerTrustSummary: {
          type: "object",
          required: [
            "app",
            "visibility",
            "ownedByUser",
            "hasNetworkEgress",
            "declaredPermissions",
          ],
          properties: {
            app: { $ref: "#/components/schemas/AgentHandle" },
            visibility: { type: "string" },
            ownedByUser: { type: "boolean" },
            hasNetworkEgress: { type: "boolean" },
            declaredPermissions: { type: "array", items: { type: "string" } },
            codeFingerprint: { type: ["string", "null"] },
          },
        },
        AgentWiringView: {
          type: "object",
          required: [
            "app",
            "slots",
            "outboundGrants",
            "inboundGrants",
            "emits",
            "subscriptions",
            "publications",
            "pendingRequests",
            "callerTrustByApp",
            "generatedAt",
          ],
          properties: {
            app: { $ref: "#/components/schemas/AgentHandle" },
            slots: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentImportSlot" },
            },
            outboundGrants: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentGrantSummary" },
            },
            inboundGrants: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentGrantSummary" },
            },
            emits: { type: "array", items: { type: "string" } },
            subscriptions: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentGrantSummary" },
            },
            publications: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentGrantSummary" },
            },
            pendingRequests: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentGrantSummary" },
            },
            callerTrustByApp: {
              type: "object",
              additionalProperties: {
                $ref: "#/components/schemas/AgentCallerTrustSummary",
              },
            },
            generatedAt: { type: "string", format: "date-time" },
          },
        },
        LaunchGrantSettings: {
          type: "object",
          required: ["agentGrantAutoApprove", "generatedAt"],
          properties: {
            agentGrantAutoApprove: { type: "boolean" },
            displayName: {
              type: ["string", "null"],
              description: "Account display name, or null when unset.",
            },
            generatedAt: { type: "string", format: "date-time" },
          },
        },
        CallerFunctionPermission: {
          type: "object",
          required: ["appId", "functionName", "policy", "source"],
          properties: {
            appId: { type: "string" },
            functionName: { type: "string" },
            policy: {
              type: "string",
              enum: LAUNCH_CALLER_FUNCTION_POLICIES,
            },
            source: { type: "string", enum: ["explicit", "default"] },
            updatedAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        PricingSummary: {
          type: "object",
          properties: {
            defaultCallPrice: {
              oneOf: [
                { $ref: "#/components/schemas/MoneyAmount" },
                { type: "null" },
              ],
            },
            freeToInstall: { type: "boolean" },
            paidFunctionsCount: { type: "integer" },
          },
        },
        AccessPolicySummary: {
          type: "object",
          required: ["configured", "mode", "module", "exportName", "execution"],
          properties: {
            configured: { type: "boolean" },
            mode: { type: "string", enum: ["static", "module"] },
            module: { type: ["string", "null"] },
            exportName: { type: "string" },
            execution: {
              type: "string",
              enum: ["static_pricing", "runtime_policy"],
            },
          },
        },
        FunctionSummary: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            description: { type: ["string", "null"] },
            inputSchema: {
              type: ["object", "null"],
              additionalProperties: true,
            },
            outputSchema: {
              type: ["object", "null"],
              additionalProperties: true,
            },
            annotations: {
              type: ["object", "null"],
              properties: {
                readOnlyHint: { type: "boolean" },
                destructiveHint: { type: "boolean" },
                idempotentHint: { type: "boolean" },
                openWorldHint: { type: "boolean" },
              },
            },
            pricing: { $ref: "#/components/schemas/PricingSummary" },
            accessPolicy: {
              oneOf: [
                { $ref: "#/components/schemas/AccessPolicySummary" },
                { type: "null" },
              ],
            },
            callerPermission: {
              oneOf: [
                { $ref: "#/components/schemas/CallerFunctionPermission" },
                { type: "null" },
              ],
            },
            agentPermission: {
              description: "Deprecated alias of callerPermission.",
              oneOf: [
                { $ref: "#/components/schemas/CallerFunctionPermission" },
                { type: "null" },
              ],
            },
          },
        },
        ToolFunctionsResponse: {
          type: "object",
          required: ["agent", "functions", "generatedAt"],
          properties: {
            agent: { type: "object" },
            tool: {
              type: "object",
              description: "Deprecated alias of agent.",
            },
            functions: {
              type: "array",
              items: { $ref: "#/components/schemas/FunctionSummary" },
            },
            generatedAt: { type: "string", format: "date-time" },
          },
        },
        JobStatusResponse: {
          type: "object",
          required: ["jobId", "status", "aiCostCredits", "generatedAt"],
          properties: {
            jobId: { type: "string", format: "uuid" },
            status: {
              type: "string",
              enum: ["queued", "running", "completed", "failed"],
            },
            result: { description: "Present only when status is completed." },
            error: { description: "Present only when status is failed." },
            durationMs: { type: ["number", "null"] },
            aiCostCredits: { type: "number" },
            executionId: {
              type: ["string", "null"],
              description:
                "Links the job to its execution receipt and AI-spend ledger.",
            },
            createdAt: { type: "string", format: "date-time" },
            completedAt: { type: ["string", "null"], format: "date-time" },
            generatedAt: { type: "string", format: "date-time" },
          },
        },
        FunctionRunResponse: {
          type: "object",
          required: [
            "success",
            "agent",
            "functionName",
            "generatedAt",
          ],
          properties: {
            success: { type: "boolean" },
            agent: { type: "object" },
            tool: {
              type: "object",
              description: "Deprecated alias of agent.",
            },
            functionName: { type: "string" },
            result: {
              description:
                'Function return value. Async-declared functions (or _async: true runs) instead return { _async: true, job_id, status: "queued" } — poll /api/launch/jobs/{jobId}.',
            },
            receiptId: { type: ["string", "null"] },
            warnings: { type: "array", items: { type: "object" } },
            error: {
              type: ["object", "null"],
              properties: {
                type: { type: "string" },
                message: { type: "string" },
                details: {},
              },
            },
            generatedAt: { type: "string", format: "date-time" },
          },
        },
        CallerFunctionPermissions: {
          type: "object",
          required: ["agent", "defaultPolicy", "permissions", "generatedAt"],
          properties: {
            agent: { type: "object" },
            tool: {
              type: "object",
              description: "Deprecated alias of agent.",
            },
            defaultPolicy: {
              type: "string",
              enum: LAUNCH_CALLER_FUNCTION_POLICIES,
            },
            permissions: {
              type: "array",
              items: { $ref: "#/components/schemas/CallerFunctionPermission" },
            },
            generatedAt: { type: "string", format: "date-time" },
          },
        },
        AgentHome: {
          type: "object",
          additionalProperties: false,
          required: [
            "contractVersion",
            "revision",
            "generatedAt",
            "agent",
            "responsibility",
            "state",
            "setup",
            "authority",
            "routines",
            "capacity",
            "agentCapacity",
            "budget",
            "release",
            "recentRuns",
            "actions",
          ],
          properties: {
            contractVersion: { type: "string" },
            revision: {
              type: "string",
              description: "Opaque CAS token required by every Home mutation.",
            },
            generatedAt: { type: "string", format: "date-time" },
            agent: {
              type: "object",
              required: ["id", "slug", "name", "description", "visibility"],
              properties: {
                id: { type: "string" },
                slug: { type: "string" },
                name: { type: "string" },
                description: { type: ["string", "null"] },
                visibility: { type: "string", const: "private" },
              },
            },
            responsibility: {
              type: "object",
              required: ["mission", "cadence", "reporting"],
              properties: {
                mission: { type: "string" },
                cadence: {
                  oneOf: [
                    { type: "null" },
                    {
                      type: "object",
                      required: ["kind", "intervalSeconds", "label"],
                      properties: {
                        kind: { type: "string", const: "interval" },
                        intervalSeconds: { type: "integer", minimum: 60 },
                        label: { type: "string" },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "expression", "timezone", "label"],
                      properties: {
                        kind: { type: "string", const: "cron" },
                        expression: { type: "string" },
                        timezone: { type: "string" },
                        label: { type: "string" },
                      },
                    },
                  ],
                },
                reporting: {
                  type: "object",
                  properties: {
                    kind: { type: "string", const: "galactic_inbox" },
                    configured: { type: "boolean" },
                  },
                },
              },
            },
            state: {
              type: "object",
              required: ["lifecycle", "execution", "health", "blockers"],
              properties: {
                lifecycle: {
                  type: "string",
                  enum: [
                    "needs_setup",
                    "ready",
                    "active",
                    "paused",
                    "disabled",
                  ],
                },
                execution: {
                  type: "string",
                  enum: ["idle", "queued", "running"],
                },
                health: {
                  type: "string",
                  enum: ["unknown", "healthy", "degraded", "failing"],
                },
                blockers: { type: "array", items: { type: "object" } },
              },
            },
            setup: {
              type: "object",
              description:
                "Secret-safe requirements expose configured status and permitted actions, never values.",
              properties: {
                ready: { type: "boolean" },
                requirements: { type: "array", items: { type: "object" } },
              },
            },
            authority: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    required: [
                      "id",
                      "kind",
                      "requested",
                      "approved",
                      "effective",
                      "badges",
                    ],
                  },
                },
              },
            },
            routines: { type: "object" },
            capacity: { type: ["object", "null"] },
            agentCapacity: { type: ["object", "null"] },
            budget: {
              type: ["object", "null"],
              description:
                "Hard ceilings plus authoritative UTC run/reservation-ledger usage.",
            },
            release: {
              type: "object",
              description:
                "Live executed version/integrity plus newest exactly-tested candidate and structured authority delta.",
            },
            recentRuns: {
              type: "array",
              maxItems: 5,
              items: { type: "object" },
            },
            actions: { type: "object" },
          },
        },
        ToolSummary: {
          type: "object",
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            name: { type: "string" },
            iconUrl: { type: ["string", "null"] },
            description: { type: ["string", "null"] },
            kind: { type: "string", enum: ["mcp", "http", "markdown", "gpu"] },
            visibility: {
              type: "string",
              enum: ["public", "private", "unlisted"],
            },
            publicUrl: { type: ["string", "null"] },
            adminUrl: { type: ["string", "null"] },
            installUrl: { type: ["string", "null"] },
            relevance: { $ref: "#/components/schemas/Relevance" },
            interfaces: {
              type: "array",
              description:
                "Sandboxed HTML interfaces (agent detail responses only; present when the agent ships renderable interfaces)",
              items: { $ref: "#/components/schemas/InterfaceSummary" },
            },
          },
        },
        InterfaceSummary: {
          type: "object",
          required: ["id", "label", "url", "functions"],
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            description: { type: ["string", "null"] },
            url: {
              type: "string",
              description:
                "Immutable content-addressed URL on the interfaces sandbox origin",
            },
            functions: {
              type: "array",
              items: { type: "string" },
              description:
                "Bridge allowlist, intersected with the agent's manifest functions",
            },
            minHeight: { type: ["number", "null"] },
          },
        },
        TrustCard: {
          type: "object",
          required: [
            "schema_version",
            "signed_manifest",
            "runtime",
            "artifact_count",
            "permissions",
            "capability_summary",
            "required_secrets",
            "per_user_secrets",
            "access",
            "execution_receipts",
          ],
          properties: {
            schema_version: { type: "integer", const: 1 },
            signed_manifest: { type: "boolean" },
            executed_integrity: {
              type: "string",
              enum: ["verified", "unverified", "unknown"],
            },
            signer: { type: ["string", "null"] },
            signed_at: { type: ["string", "null"], format: "date-time" },
            version: { type: ["string", "null"] },
            runtime: { type: "string" },
            manifest_hash: { type: ["string", "null"] },
            artifact_hash: { type: ["string", "null"] },
            artifact_count: { type: "integer", minimum: 0 },
            permissions: { type: "array", items: { type: "string" } },
            capability_summary: {
              type: "object",
              required: ["ai", "network", "storage", "memory", "gpu"],
              properties: {
                ai: { type: "boolean" },
                network: { type: "boolean" },
                storage: { type: "boolean" },
                memory: { type: "boolean" },
                gpu: { type: "boolean" },
              },
            },
            required_secrets: { type: "array", items: { type: "string" } },
            per_user_secrets: { type: "array", items: { type: "string" } },
            access: {
              type: "object",
              properties: {
                visibility: {
                  type: "string",
                  enum: ["public", "private", "unlisted"],
                },
                download_access: { type: ["string", "null"] },
              },
            },
            reliability: {},
            execution_receipts: {
              type: "object",
              required: ["enabled", "field", "backing_log"],
              properties: {
                enabled: { type: "boolean", const: true },
                field: { type: "string", const: "receipt_id" },
                backing_log: { type: "string", const: "mcp_call_logs.id" },
              },
            },
          },
        },
        WalletSummary: {
          type: "object",
          properties: {
            balance: { $ref: "#/components/schemas/MoneyAmount" },
            spendableBalance: { $ref: "#/components/schemas/MoneyAmount" },
            depositBalance: { $ref: "#/components/schemas/MoneyAmount" },
            earnedBalance: { $ref: "#/components/schemas/MoneyAmount" },
            escrowBalance: { $ref: "#/components/schemas/MoneyAmount" },
            canTopUp: { type: "boolean" },
            topUpUrl: { type: ["string", "null"] },
            transactionsUrl: { type: ["string", "null"] },
            receiptsUrl: { type: ["string", "null"] },
            earningsUrl: { type: ["string", "null"] },
            payoutsUrl: { type: ["string", "null"] },
            payoutStatus: { type: ["object", "null"] },
            actions: { type: "array", items: { type: "object" } },
            recentTransactions: {
              type: "array",
              items: { type: "object" },
            },
            recentReceipts: { type: "array", items: { type: "object" } },
            recentEarnings: { type: "array", items: { type: "object" } },
            recentPayouts: { type: "array", items: { type: "object" } },
          },
        },
        WalletPage: {
          type: "object",
          required: ["limit", "hasMore"],
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_WALLET_PAGE_LIMIT,
            },
            nextCursor: { type: ["string", "null"], format: "date-time" },
            hasMore: { type: "boolean" },
          },
        },
        WalletTransaction: {
          type: "object",
          required: ["id", "type", "category", "description", "amount"],
          properties: {
            id: { type: "string" },
            type: { type: "string" },
            category: { type: "string" },
            description: { type: "string" },
            amount: { $ref: "#/components/schemas/MoneyAmount" },
            balanceAfter: {
              oneOf: [
                { $ref: "#/components/schemas/MoneyAmount" },
                { type: "null" },
              ],
            },
            appId: { type: ["string", "null"] },
            appName: { type: ["string", "null"] },
            createdAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        WalletReceipt: {
          type: "object",
          required: [
            "receiptId",
            "success",
            "total",
            "appCharge",
            "infraCharge",
            "platformFee",
            "developerNet",
          ],
          properties: {
            receiptId: { type: "string" },
            appId: { type: ["string", "null"] },
            appName: { type: ["string", "null"] },
            functionName: { type: ["string", "null"] },
            success: { type: "boolean" },
            total: { $ref: "#/components/schemas/MoneyAmount" },
            appCharge: { $ref: "#/components/schemas/MoneyAmount" },
            infraCharge: { $ref: "#/components/schemas/MoneyAmount" },
            platformFee: { $ref: "#/components/schemas/MoneyAmount" },
            developerNet: { $ref: "#/components/schemas/MoneyAmount" },
            tax: { $ref: "#/components/schemas/MoneyAmount" },
            billingConfigVersion: { type: ["integer", "null"], minimum: 1 },
            billingConfigVersions: {
              type: "array",
              items: { type: "integer", minimum: 1 },
            },
            createdAt: { type: ["string", "null"], format: "date-time" },
            receiptUrl: { type: ["string", "null"] },
          },
        },
        WalletEarning: {
          type: "object",
          required: ["amount", "reason"],
          properties: {
            amount: { $ref: "#/components/schemas/MoneyAmount" },
            appId: { type: ["string", "null"] },
            functionName: { type: ["string", "null"] },
            reason: { type: "string" },
            createdAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        WalletPayout: {
          type: "object",
          required: ["id", "amount", "status"],
          properties: {
            id: { type: "string" },
            amount: { $ref: "#/components/schemas/MoneyAmount" },
            status: { type: "string" },
            createdAt: { type: ["string", "null"], format: "date-time" },
            completedAt: { type: ["string", "null"], format: "date-time" },
          },
        },
        WalletFundingQuote: {
          type: "object",
          required: [
            "method",
            "methodLabel",
            "amountCredits",
            "amountLight",
            "creditsPerDollar",
            "lightPerDollar",
            "baseAmountCents",
            "processingFeeCents",
            "totalAmountCents",
            "feeFormula",
          ],
          properties: {
            method: { type: "string", enum: ["card", "ach"] },
            methodLabel: { type: "string", enum: ["Card", "Bank (ACH)"] },
            amountCredits: { type: "integer" },
            amountLight: {
              type: "integer",
              deprecated: true,
              description: "Deprecated alias of amountCredits",
            },
            creditsPerDollar: { type: "integer", const: 100 },
            lightPerDollar: {
              type: "integer",
              const: 100,
              deprecated: true,
              description: "Deprecated alias of creditsPerDollar",
            },
            baseAmountCents: { type: "integer" },
            processingFeeCents: { type: "integer" },
            totalAmountCents: { type: "integer" },
            feeFormula: { type: "string" },
          },
        },
        MoneyAmount: {
          type: "object",
          required: ["credits", "light", "display"],
          properties: {
            credits: { type: "number" },
            light: {
              type: "number",
              deprecated: true,
              description: "Deprecated alias of credits",
            },
            display: { type: "string" },
          },
        },
        PlatformPrimitiveSuggestion: {
          type: "object",
          properties: {
            primitive: { type: "string" },
            label: { type: "string" },
            description: { type: "string" },
            route: { type: "string" },
            apiRoute: { type: "string" },
            similarity: { type: ["number", "null"] },
            relevance: { $ref: "#/components/schemas/Relevance" },
          },
        },
        DiscoveryRetrieval: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["browse", "lexical", "semantic", "hybrid"],
            },
            embeddedSources: { type: "array", items: { type: "string" } },
            fallbackSources: { type: "array", items: { type: "string" } },
            embeddingModel: { type: ["string", "null"] },
            fallbackReason: { type: ["string", "null"] },
          },
        },
        Relevance: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: ["semantic", "lexical", "curated"],
            },
            score: { type: ["number", "null"] },
            signals: { type: "array", items: { type: "string" } },
            subjectType: {
              type: "string",
              enum: [
                "app",
                "function",
                "platform_primitive",
              ],
            },
            subjectId: { type: ["string", "null"] },
            subjectLabel: { type: ["string", "null"] },
            appVersion: { type: ["string", "null"] },
            embeddingTextHash: { type: ["string", "null"] },
          },
        },
      },
    },
    "x-launch-scope": {
      version: LAUNCH_MVP_VERSION,
      thesis: LAUNCH_SCOPE_CONTRACT.thesis,
      policy: PERSISTENT_AGENT_LAUNCH_POLICY,
      includedCapabilities: LAUNCH_INCLUDED_CAPABILITIES,
      deferredCapabilities: LAUNCH_DEFERRED_CAPABILITIES,
      publicRoutes: LAUNCH_PUBLIC_ROUTES,
      compatibilityPublicRoutes:
        LAUNCH_SCOPE_CONTRACT.compatibilityPublicRoutes,
      apiRoutes: LAUNCH_API_ROUTES,
    },
  };
  const publicSpec = spec as unknown as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  for (const path of Object.keys(publicSpec.paths)) {
    if (path.startsWith("/api/launch/wallet")) delete publicSpec.paths[path];
  }
  for (const schema of Object.keys(publicSpec.components.schemas)) {
    if (schema.startsWith("Wallet")) {
      delete publicSpec.components.schemas[schema];
    }
  }
  publicSpec.paths["/api/launch/subscription"] = {
    get: {
      operationId: "getLaunchSubscription",
      summary: "Get the account plan, Stripe state, and shared Agent capacity",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": { description: "Subscription and capacity summary" },
        "401": { description: "Authentication required" },
      },
    },
  };
  publicSpec.paths["/api/launch/capacity"] = {
    get: {
      operationId: "getLaunchCapacity",
      summary: "Get safe shared-capacity state and reset timestamps",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": { description: "Free raw allowances are deliberately omitted" },
        "401": { description: "Authentication required" },
      },
    },
  };
  publicSpec.paths["/api/launch/fleet"] = {
    get: {
      operationId: "getLaunchFleet",
      summary: "Get the signed-in owner's compact private Agent fleet",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description:
            "Batched Agent state, activity, Alerts, and shared capacity",
        },
        "401": { description: "Authentication required" },
      },
    },
  };
  publicSpec.paths["/api/launch/agents/{id}/capacity"] = {
    get: {
      operationId: "getLaunchAgentCapacity",
      summary:
        "Get one Agent's share and ceiling within shared account capacity",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": { description: "Agent and account-combined capacity state" },
        "403": { description: "Owner account session required" },
        "404": { description: "Owned private Agent not found" },
      },
    },
    patch: {
      operationId: "updateLaunchAgentCapacity",
      summary: "Set one paid-plan Agent's percentage ceiling",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: jsonContent({
          type: "object",
          additionalProperties: false,
          required: ["capPercent"],
          properties: {
            capPercent: {
              type: "number",
              minimum: 0.01,
              maximum: 100,
              multipleOf: 0.01,
            },
          },
        }),
      },
      responses: {
        "200": { description: "Updated Agent capacity state" },
        "409": { description: "Free has a fixed qualitative capacity policy" },
      },
    },
  };
  const computeAuthorityRuleBase = {
    callerFunction: {
      type: "string",
      pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$",
    },
    decision: {
      type: "string",
      enum: ["always", "ask", "never"],
    },
  };
  const computePlatformAuthorityRule = (includeVersion: boolean) => ({
    type: "object",
    additionalProperties: false,
    required: ["callerFunction", "decision", "action", "target"],
    properties: {
      ...computeAuthorityRuleBase,
      action: { type: "string", const: "platform.call" },
      target: {
        type: "object",
        additionalProperties: false,
        required: ["functionName"],
        properties: {
          functionName: {
            type: "string",
            pattern: "^(?:gx|ul)\\.[A-Za-z][A-Za-z0-9_.:-]{0,126}$",
            description:
              "One exact Galactic platform function; wildcards are forbidden.",
          },
        },
      },
      ...(includeVersion ? { version: { type: "string" } } : {}),
    },
  });
  const computeAgentAuthorityRule = (includeVersion: boolean) => ({
    type: "object",
    additionalProperties: false,
    required: ["callerFunction", "decision", "action", "target"],
    properties: {
      ...computeAuthorityRuleBase,
      action: { type: "string", const: "agents.call" },
      target: {
        type: "object",
        additionalProperties: false,
        required: ["agentId", "functionName"],
        properties: {
          agentId: { type: "string", format: "uuid" },
          functionName: {
            type: "string",
            pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$",
            description:
              "One exact target Agent function; wildcards are forbidden.",
          },
        },
      },
      ...(includeVersion ? { version: { type: "string" } } : {}),
    },
  });
  publicSpec.components.schemas["ComputeLaunchAuthorityRule"] = {
    oneOf: [
      computePlatformAuthorityRule(true),
      computeAgentAuthorityRule(true),
    ],
  };
  publicSpec.components.schemas["ComputeLaunchAuthorityRuleMutation"] = {
    oneOf: [
      computePlatformAuthorityRule(false),
      computeAgentAuthorityRule(false),
    ],
  };
  publicSpec.components.schemas["ComputeLaunchSettings"] = {
    type: "object",
    additionalProperties: false,
    required: [
      "enabled",
      "profile",
      "allowedTools",
      "secretBindings",
      "authorityRules",
      "limits",
      "manifestCeiling",
      "ownerConfirmedAt",
      "updatedAt",
    ],
    properties: {
      enabled: { type: "boolean" },
      profile: { type: "string", const: "developer-v1" },
      allowedTools: {
        type: "array",
        maxItems: 64,
        uniqueItems: true,
        items: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,127}$" },
      },
      secretBindings: {
        type: "array",
        maxItems: 50,
        items: { $ref: "#/components/schemas/ComputeLaunchSecretBinding" },
      },
      authorityRules: {
        type: "array",
        maxItems: 200,
        description:
          "Per-caller exact platform.call or agents.call decisions. Wildcards are forbidden.",
        items: { $ref: "#/components/schemas/ComputeLaunchAuthorityRule" },
      },
      limits: {
        type: "object",
        additionalProperties: false,
        required: [
          "maxTimeoutMs",
          "maxConcurrency",
          "maxArtifactBytes",
          "maxArtifacts",
        ],
        properties: {
          maxTimeoutMs: {
            type: "integer",
            minimum: 1000,
            maximum: COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS,
          },
          maxConcurrency: { type: "integer", minimum: 1, maximum: 32 },
          maxArtifactBytes: {
            type: "integer",
            minimum: 1,
            maximum: COMPUTE_V1_MAX_ARTIFACT_BYTES,
          },
          maxArtifacts: { type: "integer", minimum: 1, maximum: 1000 },
        },
      },
      manifestCeiling: {
        type: "object",
        additionalProperties: false,
        required: ["enabled", "profile", "tools", "secrets"],
        properties: {
          enabled: { type: "boolean" },
          profile: {
            type: ["string", "null"],
            enum: ["developer-v1", null],
          },
          tools: { type: "array", items: { type: "string" } },
          secrets: { type: "array", items: { type: "string" } },
        },
      },
      ownerConfirmedAt: {
        type: ["string", "null"],
        format: "date-time",
      },
      updatedAt: { type: ["string", "null"], format: "date-time" },
    },
  };
  publicSpec.components.schemas["ComputeLaunchRun"] = {
    type: "object",
    additionalProperties: false,
    required: [
      "runId",
      "receiptId",
      "receiptUrl",
      "status",
      "agentId",
      "agentName",
      "functionName",
      "createdAt",
      "startedAt",
      "finishedAt",
      "usage",
      "exitCode",
      "infraFailure",
      "artifacts",
      "cancellable",
    ],
    properties: {
      runId: { type: "string", format: "uuid" },
      receiptId: { type: ["string", "null"], format: "uuid" },
      receiptUrl: { type: ["string", "null"] },
      status: {
        type: "string",
        enum: [
          "queued",
          "reserving",
          "starting",
          "running",
          "completed",
          "failed",
          "cancelled",
          "settlement_pending",
        ],
      },
      agentId: { type: "string", format: "uuid" },
      agentName: { type: "string" },
      functionName: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      startedAt: { type: ["string", "null"], format: "date-time" },
      finishedAt: { type: ["string", "null"], format: "date-time" },
      usage: {
        type: "object",
        additionalProperties: false,
        required: ["reserved", "actual", "trueUp", "unit"],
        properties: {
          reserved: { type: "number", minimum: 0 },
          actual: { type: ["number", "null"], minimum: 0 },
          trueUp: { type: ["number", "null"] },
          unit: { type: "string" },
        },
      },
      exitCode: { type: ["integer", "null"] },
      infraFailure: {
        oneOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "retryable"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              retryable: { type: "boolean" },
            },
          },
        ],
      },
      artifacts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "sizeBytes", "expiresAt", "url"],
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            sizeBytes: { type: "integer", minimum: 0 },
            expiresAt: {
              type: "string",
              format: "date-time",
              description:
                "Exact database-owned expiry; admission and downloads fail after this time.",
            },
            url: {
              type: ["string", "null"],
              description:
                "Same-origin owner download route; never an R2 object URL.",
              pattern:
                "^/api/launch/agents/[^/]+/compute/runs/[0-9a-fA-F-]+/artifacts/[0-9a-fA-F-]+$",
            },
          },
        },
      },
      cancellable: { type: "boolean" },
    },
  };
  const computeSecretPresenceSchema = {
    type: "object",
    additionalProperties: false,
    required: [
      "name",
      "delivery",
      "configured",
      "version",
      "updatedAt",
    ],
    properties: {
      name: { type: "string" },
      delivery: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "envName"],
            properties: {
              kind: { type: "string", const: "env" },
              envName: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "path"],
            properties: {
              kind: { type: "string", const: "file" },
              path: { type: "string" },
            },
          },
        ],
      },
      configured: { type: "boolean" },
      version: { type: "string" },
      updatedAt: { type: ["string", "null"], format: "date-time" },
    },
  };
  publicSpec.components.schemas["ComputeLaunchSecretBinding"] =
    computeSecretPresenceSchema;
  const computeSettingsResponse = {
    description:
      "Owner-safe Compute settings and secret-presence metadata; secret values never appear",
    content: jsonContent({
      type: "object",
      additionalProperties: false,
      required: ["settings", "revision", "generatedAt"],
      properties: {
        settings: { $ref: "#/components/schemas/ComputeLaunchSettings" },
        revision: { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
        generatedAt: { type: "string", format: "date-time" },
      },
    }),
  };
  publicSpec.paths["/api/launch/agents/{id}/compute/settings"] = {
    get: {
      operationId: "getLaunchAgentComputeSettings",
      summary: "Get one owned Agent's Compute settings and secret presence",
      description:
        "Account-session and exact Agent ownership required. Values for Agent secrets are never returned.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": computeSettingsResponse,
        "401": { description: "Authentication required" },
        "403": { description: "Account session required" },
        "404": { description: "Agent not found or not owned" },
      },
    },
    put: {
      operationId: "putLaunchAgentComputeSettings",
      summary: "CAS-replace one owned Agent's complete Compute settings",
      description:
        "Requires expectedRevision and ownerConfirmed=true. Secret delivery mappings contain names and destinations only; values are never accepted.",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: jsonContent({
          type: "object",
          additionalProperties: false,
          required: ["expectedRevision", "ownerConfirmed", "settings"],
          properties: {
            expectedRevision: {
              oneOf: [
                { type: "string", pattern: "^(?:0|[1-9][0-9]*)$" },
                { type: "integer", minimum: 0 },
              ],
            },
            ownerConfirmed: { type: "boolean", const: true },
            settings: {
              type: "object",
              additionalProperties: false,
              required: [
                "enabled",
                "profile",
                "allowedTools",
                "secretBindings",
                "authorityRules",
                "limits",
              ],
              properties: {
                enabled: { type: "boolean" },
                profile: { type: "string", const: "developer-v1" },
                allowedTools: {
                  type: "array",
                  maxItems: 64,
                  uniqueItems: true,
                  items: {
                    type: "string",
                    pattern: "^[a-z][a-z0-9._-]{0,127}$",
                  },
                },
                secretBindings: {
                  type: "array",
                  maxItems: 50,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name", "delivery"],
                    properties: {
                      name: { type: "string" },
                      delivery: computeSecretPresenceSchema.properties.delivery,
                    },
                  },
                },
                authorityRules: {
                  type: "array",
                  maxItems: 200,
                  description:
                    "Whole replacement of exact per-caller grants and prompts; no wildcard target is accepted.",
                  items: {
                    $ref:
                      "#/components/schemas/ComputeLaunchAuthorityRuleMutation",
                  },
                },
                limits: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "maxTimeoutMs",
                    "maxConcurrency",
                    "maxArtifactBytes",
                    "maxArtifacts",
                  ],
                  properties: {
                    maxTimeoutMs: {
                      type: "integer",
                      minimum: 1000,
                      maximum: COMPUTE_V1_ASYNC_MAX_TIMEOUT_MS,
                    },
                    maxConcurrency: {
                      type: "integer",
                      minimum: 1,
                      maximum: 32,
                    },
                    maxArtifactBytes: {
                      type: "integer",
                      minimum: 1,
                      maximum: COMPUTE_V1_MAX_ARTIFACT_BYTES,
                    },
                    maxArtifacts: {
                      type: "integer",
                      minimum: 1,
                      maximum: 1000,
                    },
                  },
                },
              },
            },
          },
        }),
      },
      responses: {
        "200": computeSettingsResponse,
        "400": { description: "Invalid whole-settings document" },
        "415": { description: "JSON request body required" },
        "409": { description: "Compute settings revision conflict" },
        "403": { description: "Account session required" },
        "404": { description: "Agent not found or not owned" },
      },
    },
  };
  publicSpec.paths["/api/launch/agents/{id}/compute/runs"] = {
    get: {
      operationId: "listLaunchAgentComputeRuns",
      summary: "List secret-safe Compute runs for one owned Agent",
      description:
        "Run summaries omit argv, stdin, execution environment, token data, and secret values.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "limit",
          in: "query",
          schema: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 50,
          },
        },
        {
          name: "cursor",
          in: "query",
          schema: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
            pattern: "^[A-Za-z0-9_-]+$",
          },
        },
      ],
      responses: {
        "200": {
          description: "Newest-first Compute run page",
          content: jsonContent({
            type: "object",
            required: ["runs", "next_cursor", "generatedAt"],
            properties: {
              runs: {
                type: "array",
                items: { $ref: "#/components/schemas/ComputeLaunchRun" },
              },
              next_cursor: { type: ["string", "null"] },
              generatedAt: { type: "string", format: "date-time" },
            },
          }),
        },
        "400": { description: "Invalid pagination query" },
        "403": { description: "Account session required" },
        "404": { description: "Agent not found or not owned" },
      },
    },
  };
  publicSpec.paths[
    "/api/launch/agents/{id}/compute/runs/{runId}/cancel"
  ] = {
    post: {
      operationId: "cancelLaunchAgentComputeRun",
      summary: "Idempotently cancel one Compute run for an owned Agent",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: jsonContent({
          type: "object",
          additionalProperties: false,
          properties: {},
        }),
      },
      responses: {
        "200": { description: "Cancelled or already-terminal run summary" },
        "400": { description: "Invalid run id or body" },
        "415": { description: "JSON request body required" },
        "409": { description: "Run state/version conflict" },
        "403": { description: "Account session required" },
        "404": { description: "Agent or run not found" },
      },
    },
  };
  publicSpec.paths[
    "/api/launch/agents/{id}/compute/runs/{runId}/artifacts/{artifactId}"
  ] = {
    get: {
      operationId: "downloadLaunchAgentComputeArtifact",
      summary: "Download one private Compute artifact for an owned Agent",
      description:
        "Streams control-plane-authorized bytes. R2 bucket names, object keys, and public object URLs are never returned.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 200 },
        },
        {
          name: "runId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "artifactId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Private artifact bytes",
          headers: {
            "Content-Disposition": {
              schema: { type: "string" },
              description: "Sanitized attachment filename",
            },
            "Cache-Control": {
              schema: { type: "string", const: "private, no-store" },
            },
          },
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "400": { description: "Invalid run or artifact id" },
        "401": { description: "Authentication required" },
        "403": { description: "Account session required" },
        "404": { description: "Agent, run, or artifact not found" },
      },
    },
  };
  publicSpec.paths["/api/launch/agents/{id}/routines"] = {
    get: {
      operationId: "listLaunchAgentRoutines",
      summary: "List all launch-managed routines for an owned private Agent",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": {
          description: "Bounded routine collection with aggregate state",
        },
        "403": { description: "Owner account session required" },
        "404": { description: "Owned private Agent not found" },
      },
    },
  };
  publicSpec.paths["/api/launch/agents/{id}/routines/{routineId}"] = {
    get: {
      operationId: "getLaunchAgentManagedRoutine",
      summary: "Get one owner-safe managed routine",
      security: [{ bearerAuth: [] }],
      responses: { "200": { description: "Managed routine detail" } },
    },
    patch: {
      operationId: "updateLaunchAgentManagedRoutine",
      summary: "CAS-update one managed routine, including cron and timezone",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: jsonContent({
          type: "object",
          additionalProperties: false,
          required: ["expectedRevision"],
          properties: {
            expectedRevision: { type: "string" },
            name: { type: "string", minLength: 1, maxLength: 120 },
            description: { type: ["string", "null"], maxLength: 500 },
            mission: { type: ["string", "null"], maxLength: 1000 },
            intervalSeconds: { type: "integer", minimum: 60 },
            schedule: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "intervalSeconds"],
                  properties: {
                    kind: { type: "string", const: "interval" },
                    intervalSeconds: { type: "integer", minimum: 60 },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "expression"],
                  properties: {
                    kind: { type: "string", const: "cron" },
                    expression: { type: "string" },
                    timezone: { type: "string" },
                  },
                },
              ],
            },
            budgets: { type: "object" },
          },
        }),
      },
      responses: {
        "200": { description: "Updated managed routine and new revision" },
        "412": { description: "Agent Home revision conflict" },
      },
    },
  };
  publicSpec.paths["/api/launch/agents/{id}/routines/{routineId}/actions"] = {
    post: {
      operationId: "actOnLaunchAgentManagedRoutine",
      summary:
        "Idempotently approve, activate, pause, or wake one managed routine",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: jsonContent({
          type: "object",
          additionalProperties: false,
          required: ["expectedRevision", "idempotencyKey", "action"],
          properties: {
            expectedRevision: { type: "string" },
            idempotencyKey: { type: "string", format: "uuid" },
            action: {
              type: "string",
              enum: ["approve_capabilities", "activate", "pause", "run_now"],
            },
            capabilityIds: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              uniqueItems: true,
              items: { type: "string" },
            },
          },
        }),
      },
      responses: {
        "200": { description: "Updated managed routine and revision" },
        "409": { description: "Blocked or already in progress" },
        "412": { description: "Agent Home revision conflict" },
      },
    },
  };
  publicSpec.paths["/api/launch/notifications"] = {
    get: {
      operationId: "listLaunchNotifications",
      summary: "List owner Alerts, optionally filtered to one private Agent",
      security: [{ bearerAuth: [] }],
      parameters: [
        { name: "agent", in: "query", schema: { type: "string" } },
        {
          name: "unread",
          in: "query",
          schema: { type: "string", enum: ["1"] },
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 200 },
        },
      ],
      responses: {
        "200": {
          description: "Newest-first owner Alerts and filtered unread count",
        },
        "401": { description: "Authentication required" },
      },
    },
    patch: {
      operationId: "markLaunchNotificationsRead",
      summary: "Mark selected or filtered owner Alerts read",
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: jsonContent({
          type: "object",
          additionalProperties: false,
          properties: {
            agent: { type: "string", minLength: 1 },
            all: { type: "boolean", const: true },
            ids: {
              type: "array",
              minItems: 1,
              maxItems: 200,
              uniqueItems: true,
              items: { type: "string", format: "uuid" },
            },
          },
          oneOf: [
            { required: ["all"], not: { required: ["ids"] } },
            { required: ["ids"], not: { required: ["all"] } },
          ],
        }),
      },
      responses: {
        "200": { description: "Number of Alerts marked read" },
        "400": { description: "Invalid or ambiguous Alert selection" },
        "401": { description: "Authentication required" },
        "403": { description: "Owner account session required" },
      },
    },
  };
  publicSpec.paths["/api/launch/subscription/checkout"] = {
    post: {
      operationId: "createLaunchSubscriptionCheckout",
      summary: "Create a Stripe Checkout Session for Pro",
      security: [{ bearerAuth: [] }],
      responses: { "200": { description: "Stripe-hosted checkout redirect" } },
    },
  };
  publicSpec.paths["/api/launch/subscription/portal"] = {
    post: {
      operationId: "createLaunchSubscriptionPortal",
      summary: "Create a Stripe Billing Portal Session",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": { description: "Stripe-hosted billing portal redirect" },
      },
    },
  };
  return spec;
}

async function handleLaunchApiKeys(
  request: Request,
  path: string,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForApiKeys(user);

  if (path === "/api/launch/api-keys") {
    if (method === "GET") {
      const tokens = await listTokens(user.id);
      return json({
        apiKeys: tokens.map(toLaunchApiKeySummary),
        generatedAt: new Date().toISOString(),
      });
    }

    if (method === "POST") {
      return await withSensitiveRouteRateLimit(
        user.id,
        "user:token_create",
        async () => {
          try {
            const createRequest = parseLaunchApiKeyCreateRequest(
              await readJsonBody<Record<string, unknown>>(request),
            );
            const result = await createToken(user.id, createRequest.name, {
              expiresInDays: createRequest.expiresInDays,
              scopes: createRequest.scopes,
              app_ids: createRequest.appIds,
              function_names: createRequest.functionNames,
            });

            return json({
              success: true,
              apiKey: toLaunchApiKeySummary(result.token),
              plaintextToken: result.plaintext_token,
              message:
                "API key created. Copy it now; the full token is revealed only once.",
              generatedAt: new Date().toISOString(),
            });
          } catch (err) {
            if (err instanceof RequestValidationError) {
              return error(err.message, err.status);
            }
            if (
              err instanceof Error && err.message.includes("already exists")
            ) {
              return error(err.message, 409);
            }
            if (
              err instanceof Error &&
              err.message.includes("Token limit reached")
            ) {
              return error(err.message, 403);
            }
            console.error("[LAUNCH] API key creation failed:", err);
            return error("Failed to create API key", 500);
          }
        },
      );
    }

    return error("Method not allowed for launch API keys", 405);
  }

  const deleteMatch = path.match(/^\/api\/launch\/api-keys\/([^/]+)$/);
  if (deleteMatch && method === "DELETE") {
    const tokenId = parseApiKeyId(deleteMatch[1]);
    return await withSensitiveRouteRateLimit(
      user.id,
      "user:token_delete",
      async () => {
        try {
          await revokeToken(user.id, tokenId);
          return json({
            success: true,
            revokedId: tokenId,
            message: "API key revoked.",
            generatedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error("[LAUNCH] API key revocation failed:", err);
          return error("Failed to revoke API key", 500);
        }
      },
    );
  }

  if (deleteMatch) {
    return error("Method not allowed for launch API key", 405);
  }

  return error("Launch API key endpoint not found", 404);
}

async function handleLaunchByok(
  request: Request,
  path: string,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForByok(user);

  if (path === "/api/launch/byok") {
    if (method === "GET") {
      return json(await buildLaunchByokSummary(user.id));
    }
    return error("Method not allowed for launch BYOK providers", 405);
  }

  if (path === "/api/launch/byok/primary") {
    if (method === "POST") {
      return await handleLaunchByokPrimary(request, user);
    }
    return error("Method not allowed for launch BYOK primary provider", 405);
  }

  const providerMatch = path.match(/^\/api\/launch\/byok\/([^/]+)$/);
  if (providerMatch) {
    const providerEntry = resolveLaunchByokProvider(
      decodeURIComponent(providerMatch[1]),
    );
    if (!providerEntry) {
      return error(
        "Invalid provider. Must be one of: " +
          Object.keys(BYOK_PROVIDERS).join(", "),
        400,
      );
    }
    if (method === "PUT") {
      return await handleLaunchByokUpsert(request, user, providerEntry);
    }
    if (method === "DELETE") {
      return await withSensitiveRouteRateLimit(
        user.id,
        "user:byok_delete",
        async () => {
          try {
            await userService.removeBYOKProvider(
              user.id,
              providerEntry.provider,
            );
            return json(
              {
                ok: true,
                provider: providerEntry.provider,
                message: `${providerEntry.info.name} removed`,
              } satisfies LaunchByokMutationResponse,
            );
          } catch (err) {
            console.error("[LAUNCH] BYOK provider removal failed:", err);
            return error("Failed to remove BYOK provider", 500);
          }
        },
      );
    }
    return error("Method not allowed for launch BYOK provider", 405);
  }

  return error("Launch BYOK endpoint not found", 404);
}

async function handleLaunchByokUpsert(
  request: Request,
  user: AuthUser,
  providerEntry: LaunchByokProviderEntry,
): Promise<Response> {
  const body = asRecord(await readJsonBody<unknown>(request)) || {};
  const apiKeyValue = body.apiKey ?? body.api_key;
  if (
    !apiKeyValue || typeof apiKeyValue !== "string" ||
    apiKeyValue.trim().length === 0
  ) {
    return error("API key is required", 400);
  }
  const apiKey = apiKeyValue.trim();
  const model = normalizeLaunchByokModel(body.model);
  const validate = body.validate !== false;

  const profile = await userService.getUser(user.id);
  if (!profile) {
    return error("User not found", 404);
  }
  const configured = profile.byok_configs.some((config) =>
    config.provider === providerEntry.provider && config.has_key
  );

  return await withSensitiveRouteRateLimit(
    user.id,
    configured ? "user:byok_update" : "user:byok_create",
    async () => {
      try {
        if (validate) {
          try {
            await validateAPIKey(providerEntry.provider, apiKey);
          } catch (validationErr) {
            return error(
              `API key validation failed: ${
                validationErr instanceof Error
                  ? validationErr.message
                  : "Invalid key"
              }`,
              400,
            );
          }
        }

        if (configured) {
          await userService.updateBYOKProvider(
            user.id,
            providerEntry.provider,
            { apiKey, model },
          );
        } else {
          await userService.addBYOKProvider(
            user.id,
            providerEntry.provider,
            apiKey,
            model,
          );
        }

        return json(
          {
            ok: true,
            provider: providerEntry.provider,
            message: `${providerEntry.info.name} configured successfully`,
          } satisfies LaunchByokMutationResponse,
        );
      } catch (err) {
        console.error("[LAUNCH] BYOK provider upsert failed:", err);
        if (err instanceof Error && err.message.includes("not configured")) {
          return error(err.message, 400);
        }
        return error("Failed to save BYOK provider", 500);
      }
    },
  );
}

async function handleLaunchByokPrimary(
  request: Request,
  user: AuthUser,
): Promise<Response> {
  const body = asRecord(await readJsonBody<unknown>(request)) || {};
  const providerEntry = resolveLaunchByokProvider(body.provider);
  if (!providerEntry) {
    return error("Invalid provider", 400);
  }

  return await withSensitiveRouteRateLimit(
    user.id,
    "user:byok_primary",
    async () => {
      try {
        await userService.setPrimaryProvider(user.id, providerEntry.provider);
        return json(
          {
            ok: true,
            provider: providerEntry.provider,
            message: `${providerEntry.info.name} set as primary provider`,
          } satisfies LaunchByokMutationResponse,
        );
      } catch (err) {
        console.error("[LAUNCH] BYOK primary provider update failed:", err);
        if (err instanceof Error && err.message.includes("not configured")) {
          return error(err.message, 400);
        }
        return error("Failed to set primary provider", 500);
      }
    },
  );
}

// Set (or clear) the user's platform (credits) OpenRouter model. Unlike BYOK,
// this requires NO key — it's the slug the credit-billed Light path routes for
// the user, honored by both interactive chat and autonomous/agent runs.
// Owner notification inbox (launch-web bell). GET lists (newest-first, optional
// ?unread=1) with an unread count; PATCH marks read ({ ids } or { all: true }).
async function handleLaunchNotifications(
  request: Request,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  // Account-session only, like every other launch settings/grants route: reject
  // api_token / routine_actor / sandbox_actor so in-sandbox app code (or a
  // routine handler) can't read the owner's inbox or silently mark their
  // "agent paused" alerts read. Agents read notifications via gx.notifications.
  if (!isAccountSessionAuthSource(user.authSource)) {
    return error("Notifications require an account session", 403);
  }
  const {
    listNotifications,
    countUnread,
    markNotificationsRead,
    markAllNotificationsRead,
  } = await import("../services/notifications.ts");

  if (method === "GET") {
    const url = new URL(request.url);
    const unread = url.searchParams.get("unread");
    if (unread !== null && unread !== "1") {
      throw new RequestValidationError("unread must be 1 when supplied");
    }
    const unreadOnly = unread === "1";
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null
      ? 50
      : /^\d+$/u.test(limitParam)
      ? Number(limitParam)
      : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RequestValidationError(
        "limit must be an integer from 1 to 200",
      );
    }
    const agentLocator = url.searchParams.get("agent")?.trim() || null;
    let agentId: string | undefined;
    if (agentLocator) {
      const resolved = await resolveOwnerPrivateRoutineAgent(
        user,
        encodeURIComponent(agentLocator),
      );
      if (resolved instanceof Response) return resolved;
      agentId = resolved.id;
    }
    const [notifications, unreadCount] = await Promise.all([
      listNotifications(user.id, { unreadOnly, limit, agentId }),
      countUnread(user.id, { agentId }),
    ]);
    return privateLaunchJson({
      notifications,
      unread_count: unreadCount,
      ...(agentId ? { agent_id: agentId } : {}),
    });
  }

  if (method === "PATCH") {
    const body = asRecord(await readJsonBody<unknown>(request)) || {};
    const unknown = Object.keys(body).filter((key) =>
      key !== "agent" && key !== "all" && key !== "ids"
    );
    if (unknown.length > 0) {
      throw new RequestValidationError(
        `Unknown notification fields: ${unknown.join(", ")}`,
      );
    }
    const markAll = body.all === true;
    if (body.all !== undefined && body.all !== true) {
      throw new RequestValidationError("all must be true when supplied");
    }
    if (markAll && body.ids !== undefined) {
      throw new RequestValidationError("Provide all or ids, not both");
    }
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : null;
    if (
      !markAll &&
      (!ids || ids.length < 1 || ids.length > 200 ||
        ids.some((id) => typeof id !== "string" || !isUuid(id)))
    ) {
      throw new RequestValidationError(
        "ids must list 1 to 200 notification UUIDs, or set all to true",
      );
    }
    const agentLocator = typeof body.agent === "string" && body.agent.trim()
      ? body.agent.trim()
      : undefined;
    if (body.agent !== undefined && !agentLocator) {
      throw new RequestValidationError("agent must be a non-empty locator");
    }
    let agentId: string | undefined;
    if (agentLocator) {
      const resolved = await resolveOwnerPrivateRoutineAgent(
        user,
        encodeURIComponent(agentLocator),
      );
      if (resolved instanceof Response) return resolved;
      agentId = resolved.id;
    }
    const marked = markAll
      ? await markAllNotificationsRead(user.id, { agentId })
      : await markNotificationsRead(
        user.id,
        ids as string[],
        { agentId },
      );
    return privateLaunchJson({ ok: true, marked });
  }

  return error("Method not allowed for launch notifications", 405);
}

async function handleLaunchPlatformModel(
  request: Request,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForByok(user);
  if (method !== "PUT" && method !== "POST") {
    return error("Method not allowed for launch platform model", 405);
  }
  const body = asRecord(await readJsonBody<unknown>(request)) || {};
  // Throws RequestValidationError (400) on bad format — handled by the top-level
  // handleLaunch catch, same as the BYOK upsert path.
  const model = normalizeLaunchByokModel(body.model);

  return await withSensitiveRouteRateLimit(
    user.id,
    "user:platform_model",
    async () => {
      try {
        const { setPlatformInferenceModel } = await import(
          "../services/openrouter-keys.ts"
        );
        await setPlatformInferenceModel(user.id, model ?? null);
        return json(
          {
            ok: true,
            platformModel: model ?? null,
          } satisfies LaunchPlatformModelResponse,
        );
      } catch (e) {
        console.error("[LAUNCH] set platform model failed:", e);
        return error("Failed to set platform model", 500);
      }
    },
  );
}

async function buildLaunchByokSummary(
  userId: string,
): Promise<LaunchByokSummaryResponse> {
  const profile = await userService.getUser(userId);
  if (!profile) {
    throw new RequestValidationError("User not found", 404);
  }
  const configsByProvider = new Map(
    profile.byok_configs.map((config) => [config.provider, config]),
  );
  const providers: LaunchByokProviderOption[] = Object.values(BYOK_PROVIDERS)
    .map((info) => {
      const config = configsByProvider.get(info.id);
      const configured = config?.has_key === true;
      return {
        id: info.id,
        name: info.name,
        description: info.description,
        configured,
        primary: configured && profile.byok_provider === info.id,
        defaultModel: info.defaultModel ?? null,
        model: config?.model ?? null,
        apiKeyPrefix: info.apiKeyPrefix ?? null,
        apiKeyUrl: info.apiKeyUrl ?? null,
        docsUrl: info.docsUrl ?? null,
      };
    });

  return {
    enabled: profile.byok_enabled,
    primaryProvider: profile.byok_provider,
    providers,
    generatedAt: new Date().toISOString(),
  };
}

// Grant management is sensitive and the FE is always an account session, so
// api_token / routine_actor callers are rejected on every grant/wiring/settings
// route (mirrors requireAccountSessionForByok).
function requireAccountSessionForGrants(user: AuthUser): void {
  if (
    user.authSource === "api_token" ||
    user.authSource === "routine_actor" ||
    user.authSource === "sandbox_actor"
  ) {
    throw new RequestValidationError(
      "Cross-Agent grant management requires an account session",
      403,
    );
  }
}

// Resolve a uuid-or-slug locator to a concrete app id the user can address.
// Owned takes precedence, then public/unlisted, then an installed Agent.
async function resolveGrantAgentId(
  user: AuthUser,
  encodedLocator: string,
): Promise<string | null> {
  const resolved = await resolveLaunchRunnableTool(user, encodedLocator);
  return resolved?.row.id ?? null;
}

// Resolve a caller/target filter param (uuid or slug) to an app id. Returns
// undefined when the value is missing or unresolvable so the filter is omitted.
async function resolveGrantFilterAppId(
  value: string | null,
): Promise<string | undefined> {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (isUuid(trimmed)) return trimmed;
  try {
    const row = await fetchToolByLocator(parseLocator(trimmed), {});
    return row?.id;
  } catch {
    return undefined;
  }
}

// Add/remove an Agent to/from the signed-in user's library (the website twin
// of an ul.rate "like"/"none"). Idempotent in both directions. Account session
// required — provisional/token actors can't own a library.
async function handleLaunchAgentInstall(
  request: Request,
  encodedLocator: string,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForGrants(user);
  const resolved = await resolveLaunchRunnableTool(user, encodedLocator);
  if (!resolved) return error("Agent not found", 404);

  const lib = await import(
    "../services/capability-suggestion-telemetry.ts"
  );
  if (method === "DELETE") {
    const removed = await lib.removeAppFromUserLibrary(
      user.id,
      resolved.row.id,
    );
    if (!removed) {
      return error("Could not remove this Agent from your library", 502);
    }
    return json({
      installed: false,
      agentId: resolved.row.id,
      slug: resolved.row.slug || resolved.row.id,
      generatedAt: new Date().toISOString(),
    });
  }

  const installed = await lib.installAcceptedSuggestionApp(
    user.id,
    resolved.row.id,
    "launch_web_install",
  );
  if (!installed) {
    return error("Could not add this Agent to your library", 502);
  }
  return json({
    installed: true,
    agentId: resolved.row.id,
    slug: resolved.row.slug || resolved.row.id,
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchAgentWiring(
  request: Request,
  encodedLocator: string,
  method: string,
): Promise<Response> {
  if (method !== "GET") {
    return error("Method not allowed for launch Agent wiring", 405);
  }
  const user = await requireLaunchUser(request);
  requireAccountSessionForGrants(user);
  const appId = await resolveGrantAgentId(user, encodedLocator);
  if (!appId) return error("Agent not found", 404);
  const view = await buildWiringView(user.id, appId);
  if (!view) return error("Agent not found", 404);
  return json(view);
}

async function handleLaunchCallerTrust(
  request: Request,
  encodedLocator: string,
  method: string,
): Promise<Response> {
  if (method !== "GET") {
    return error("Method not allowed for launch caller trust", 405);
  }
  const user = await requireLaunchUser(request);
  requireAccountSessionForGrants(user);
  const appId = await resolveGrantAgentId(user, encodedLocator);
  if (!appId) return error("Agent not found", 404);
  const summary = await buildCallerTrustSummary(user.id, appId);
  if (!summary) return error("Agent not found", 404);
  return json(summary);
}

async function handleLaunchWiringTargets(
  request: Request,
  url: URL,
  method: string,
): Promise<Response> {
  if (method !== "GET") {
    return error("Method not allowed for launch wiring targets", 405);
  }
  const user = await requireLaunchUser(request);
  requireAccountSessionForGrants(user);
  const query = url.searchParams.get("q") || undefined;
  const targets = await listEligibleTargets(user.id, { query });
  return json({ targets, generatedAt: new Date().toISOString() });
}

async function handleLaunchSettings(
  request: Request,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForGrants(user);

  if (method === "GET") {
    return json({
      agentGrantAutoApprove: await getUserGrantAutoApprove(user.id),
      displayName: await getUserDisplayName(user.id),
      generatedAt: new Date().toISOString(),
    });
  }

  if (method === "PATCH") {
    return await withSensitiveRouteRateLimit(
      user.id,
      LAUNCH_GRANT_SETTINGS_WRITE_LIMIT,
      async () => {
        const body = asRecord(await readJsonBody<unknown>(request)) || {};
        if ("agentGrantAutoApprove" in body) {
          if (typeof body.agentGrantAutoApprove !== "boolean") {
            return error("agentGrantAutoApprove must be a boolean", 400);
          }
          await setUserGrantAutoApprove(user.id, body.agentGrantAutoApprove);
        }
        if ("displayName" in body) {
          if (
            body.displayName !== null && typeof body.displayName !== "string"
          ) {
            return error("displayName must be a string or null", 400);
          }
          const trimmed = typeof body.displayName === "string"
            ? body.displayName.trim()
            : "";
          if (trimmed.length > 80) {
            return error("displayName must be 80 characters or fewer", 400);
          }
          // Empty string clears the override back to the default label.
          await setUserDisplayName(
            user.id,
            trimmed.length > 0 ? trimmed : null,
          );
        }
        return json({
          agentGrantAutoApprove: await getUserGrantAutoApprove(user.id),
          displayName: await getUserDisplayName(user.id),
          generatedAt: new Date().toISOString(),
        });
      },
    );
  }

  return error("Method not allowed for launch settings", 405);
}

async function handleLaunchGrants(
  request: Request,
  path: string,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForGrants(user);

  if (path === "/api/launch/grants") {
    if (method === "GET") {
      const url = new URL(request.url);
      const [callerAppId, targetAppId] = await Promise.all([
        resolveGrantFilterAppId(url.searchParams.get("caller")),
        resolveGrantFilterAppId(url.searchParams.get("target")),
      ]);
      const status = parseGrantStatusFilter(url.searchParams.get("status"));
      const grants = await listGrantSummaries({
        userId: user.id,
        callerAppId,
        targetAppId,
        status,
      });
      return json({ grants, generatedAt: new Date().toISOString() });
    }

    if (method === "POST") {
      return await withSensitiveRouteRateLimit(
        user.id,
        LAUNCH_GRANT_WRITE_LIMIT,
        async () => {
          const body = asRecord(await readJsonBody<unknown>(request)) || {};
          const grant = await createGrant(
            user.id,
            body as unknown as AgentGrantCreateRequest,
            "user",
          );
          const apps = await fetchAppHandles([
            grant.callerAppId,
            grant.targetAppId,
          ]);
          return json(
            { grant: toGrantSummary(grant, apps) },
            201,
          );
        },
      );
    }

    return error("Method not allowed for launch grants", 405);
  }

  const approveMatch = path.match(
    /^\/api\/launch\/grants\/([^/]+)\/approve$/,
  );
  if (approveMatch) {
    if (method !== "POST") {
      return error("Method not allowed for launch grant approval", 405);
    }
    const grantId = parseGrantId(approveMatch[1]);
    return await withSensitiveRouteRateLimit(
      user.id,
      LAUNCH_GRANT_WRITE_LIMIT,
      async () => {
        const body = asRecord(await readJsonBody<unknown>(request)) || {};
        const approveRequest = body as unknown as AgentGrantApproveRequest;
        const grant = await approvePendingGrant(user.id, grantId, {
          monthlyCapCredits: approveRequest.monthlyCapCredits,
        });
        if (!grant) return error("Grant not found", 404);
        const apps = await fetchAppHandles([
          grant.callerAppId,
          grant.targetAppId,
        ]);
        return json({ grant: toGrantSummary(grant, apps) });
      },
    );
  }

  const grantMatch = path.match(/^\/api\/launch\/grants\/([^/]+)$/);
  if (grantMatch) {
    const grantId = parseGrantId(grantMatch[1]);

    if (method === "PATCH") {
      return await withSensitiveRouteRateLimit(
        user.id,
        LAUNCH_GRANT_WRITE_LIMIT,
        async () => {
          const body = asRecord(await readJsonBody<unknown>(request)) || {};
          const update = body as unknown as AgentGrantUpdateRequest;
          let grant = null;
          let touched = false;
          if (update.status === "revoked") {
            grant = await setGrantStatus(user.id, grantId, "revoked");
            touched = true;
          }
          if (update.monthlyCapCredits !== undefined) {
            grant = await setGrantCap(
              user.id,
              grantId,
              update.monthlyCapCredits,
            );
            touched = true;
          }
          if (!touched) {
            // No-op PATCH: return the current row so callers still get a
            // grant summary (or a 404 if the grant doesn't exist).
            grant = await getGrant(user.id, grantId);
          }
          if (!grant) return error("Grant not found", 404);
          const apps = await fetchAppHandles([
            grant.callerAppId,
            grant.targetAppId,
          ]);
          return json({ grant: toGrantSummary(grant, apps) });
        },
      );
    }

    if (method === "DELETE") {
      return await withSensitiveRouteRateLimit(
        user.id,
        LAUNCH_GRANT_WRITE_LIMIT,
        async () => {
          const grant = await setGrantStatus(user.id, grantId, "revoked");
          if (!grant) return error("Grant not found", 404);
          return json({ ok: true });
        },
      );
    }

    return error("Method not allowed for launch grant", 405);
  }

  return error("Launch grant endpoint not found", 404);
}

function parseGrantId(value: string): string {
  const id = decodeURIComponent(value).trim();
  if (!isUuid(id)) {
    throw new RequestValidationError("Invalid grant id");
  }
  return id;
}

function parseGrantStatusFilter(
  value: string | null,
): AgentGrantStatus | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (
    trimmed === "active" || trimmed === "pending" || trimmed === "revoked"
  ) {
    return trimmed;
  }
  throw new RequestValidationError(
    "status must be one of: active, pending, revoked",
  );
}

async function handleLaunchInferenceOptions(
  request: Request,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForByok(user);

  const profile = await userService.getUser(user.id);
  if (!profile) {
    return error("User not found", 404);
  }
  const configuredProviders = profile.byok_configs
    .filter((config) => config.has_key)
    .map((config) => config.provider);
  const primaryConfigured = profile.byok_provider !== null &&
    configuredProviders.includes(profile.byok_provider);
  return json(
    {
      billingMode: "byok",
      primaryProvider: primaryConfigured ? profile.byok_provider : null,
      configuredProviders,
      generatedAt: new Date().toISOString(),
    } satisfies LaunchInferenceOptionsResponse,
  );
}

async function handleLaunchDiscover(
  request: Request,
  url: URL,
): Promise<Response> {
  const query = normalizeQuery(
    url.searchParams.get("q") ?? url.searchParams.get("query"),
  );
  const kind = parseKind(url.searchParams.get("kind"));
  const limit = clampLimit(
    url.searchParams.get("limit"),
    DEFAULT_DISCOVERY_LIMIT,
  );
  const viewer = await tryAuthenticate(request);
  const installedIds = viewer
    ? await fetchInstalledIds(viewer.id)
    : new Set<string>();
  const embedding = query ? await tryEmbedLaunchQuery(query) : null;
  let rows: RankedLaunchAppRow[] = [];
  let toolFallbackReason: string | null = null;

  if (embedding) {
    try {
      rows = await fetchSemanticPublicApps({
        embedding: embedding.embedding,
        kind,
        limit,
      });
      if (rows.length === 0) {
        toolFallbackReason =
          "semantic Agent search returned no launch-safe rows";
      }
    } catch (err) {
      toolFallbackReason = err instanceof Error
        ? `semantic Agent search failed: ${err.message}`
        : "semantic Agent search failed";
    }
  } else if (query) {
    toolFallbackReason = "embedding service unavailable";
  }

  if (rows.length < limit) {
    const lexicalRows = await fetchPublicApps({
      query,
      kind,
      limit,
      excludeIds: new Set(rows.map((row) => row.id)),
    });
    rows = [
      ...rows,
      ...lexicalRows,
    ].slice(0, limit);
  }

  if (rows.length === 0 && query) {
    toolFallbackReason ||= "lexical search returned no launch-safe rows";
  }

  const platformPrimitives = await buildPrimitiveSuggestions(query, embedding);
  const owners = await fetchOwnerMap(rows.map((row) => row.owner_id));
  const retrieval = buildDiscoveryRetrieval({
    hasQuery: Boolean(query),
    embedding,
    toolRows: rows,
    primitiveSuggestions: platformPrimitives,
    fallbackReason: toolFallbackReason,
  });

  return json({
    query,
    results: rows.map((row) =>
      withToolRelevance(
        toLaunchAgentSummary(row, {
          owners,
          viewerId: viewer?.id,
          installedIds,
        }),
        row.launchRelevance,
      )
    ),
    platformPrimitives,
    retrieval,
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchLibrary(request: Request): Promise<Response> {
  const user = await requireLaunchUser(request);
  // Folders are a non-critical overlay on the library. If the folder tables are
  // missing (migration not yet applied — e.g. the API deploys a beat ahead of
  // the migration) or a read fails transiently, degrade to "no folders" rather
  // than failing the whole Agents page. Scoped to this read path: the folder
  // write handlers keep the strict fetchFolders so a real DB fault surfaces.
  const softFolders = (scope: LaunchFolderScope) =>
    fetchFolders(user.id, scope).catch((err) => {
      console.warn(`fetchFolders(${scope}) failed; degrading to none`, err);
      return [] as LaunchFolderRow[];
    });
  const softMembers = (scope: LaunchFolderScope) =>
    fetchFolderMembers(user.id, scope).catch((err) => {
      console.warn(`fetchFolderMembers(${scope}) failed; degrading`, err);
      return new Map<string, string>();
    });
  const [
    ownedRows,
    installedIds,
    ownedFolders,
    installedFolders,
    ownedMembers,
    installedMembers,
  ] = await Promise.all([
    fetchOwnedApps(user.id),
    fetchInstalledIds(user.id),
    softFolders("owned"),
    softFolders("installed"),
    softMembers("owned"),
    softMembers("installed"),
  ]);
  const installedRows = await fetchAppsByIds(
    Array.from(installedIds).filter((appId) =>
      !ownedRows.some((row) => row.id === appId)
    ),
  );
  const owners = await fetchOwnerMap([
    ...ownedRows.map((row) => row.owner_id),
    ...installedRows.map((row) => row.owner_id),
  ]);

  // Valid folder-id sets per tab. A membership pointing at a folder that no
  // longer exists is ignored (defense-in-depth — the composite FK already
  // cascades members on folder delete). Memberships for Agents not in the live
  // owned/installed set are never read here, so an uninstalled Agent leaves no
  // visible orphan.
  const ownedFolderIds = new Set(ownedFolders.map((f) => f.id));
  const installedFolderIds = new Set(installedFolders.map((f) => f.id));
  const folderIdFor = (
    appId: string,
    members: Map<string, string>,
    valid: Set<string>,
  ): string | null => {
    const fid = members.get(appId);
    return fid && valid.has(fid) ? fid : null;
  };

  const owned = ownedRows.map((row) => {
    const summary = toLaunchAgentSummary(row, {
      owners,
      viewerId: user.id,
      installedIds,
    });
    summary.folderId = folderIdFor(row.id, ownedMembers, ownedFolderIds);
    return summary;
  });
  const installed = installedRows.map((row) => {
    const summary = toLaunchAgentSummary(row, {
      owners,
      viewerId: user.id,
      installedIds,
    });
    summary.folderId = folderIdFor(
      row.id,
      installedMembers,
      installedFolderIds,
    );
    return summary;
  });

  return json({
    owned,
    installed,
    folders: {
      owned: ownedFolders.map(toLaunchFolder),
      installed: installedFolders.map(toLaunchFolder),
    },
    generatedAt: new Date().toISOString(),
  });
}

function launchFleetState(value: unknown): LaunchFleetAgentState {
  return value === "active" || value === "paused" || value === "error" ||
      value === "idle" || value === "unconfigured"
    ? value
    : "unconfigured";
}

function launchFleetHealth(value: unknown): LaunchFleetAgentHealth {
  return value === "healthy" || value === "waiting" || value === "paused" ||
      value === "error" || value === "idle"
    ? value
    : "idle";
}

function launchFleetCapacityState(
  value: unknown,
): LaunchAgentCapacityResponse["state"] | null {
  return value === "available" || value === "low" || value === "waiting"
    ? value
    : null;
}

function finiteFleetNumber(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
    ? Number(value)
    : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function fleetTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/** Map the bounded SQL Fleet projection without one status RPC per Agent. */
export function toLaunchFleetAgentCapacity(
  row: LaunchFleetSnapshotRow,
  generatedAt = new Date().toISOString(),
): LaunchAgentCapacityResponse | null {
  const state = launchFleetCapacityState(row.capacity_state);
  const burstState = launchFleetCapacityState(row.capacity_burst_state);
  const weeklyState = launchFleetCapacityState(row.capacity_weekly_state);
  const burstResetsAt = fleetTimestamp(row.capacity_burst_resets_at);
  const weeklyResetsAt = fleetTimestamp(row.capacity_weekly_resets_at);
  if (
    !state || !burstState || !weeklyState || !burstResetsAt || !weeklyResetsAt
  ) {
    return null;
  }
  const basisPoints = finiteFleetNumber(row.capacity_cap_basis_points);
  const paidCap = basisPoints !== null && Number.isInteger(basisPoints) &&
      basisPoints >= 1 && basisPoints <= 10_000
    ? basisPoints
    : null;
  const capPercent = paidCap === null ? null : paidCap / 100;
  const window = (
    windowState: LaunchAgentCapacityResponse["state"],
    resetsAt: string,
    rawShare: unknown,
  ): LaunchAgentCapacityResponse["burst"] => {
    const parsedShare = finiteFleetNumber(rawShare);
    const shareUsedPercent = capPercent !== null && parsedShare !== null
      ? Math.min(100, Math.max(0, parsedShare))
      : undefined;
    const capUsedPercent = shareUsedPercent !== undefined && capPercent! > 0
      ? Math.min(100, Math.max(0, shareUsedPercent / capPercent! * 100))
      : undefined;
    return {
      state: windowState,
      resetsAt,
      ...(shareUsedPercent === undefined ? {} : { shareUsedPercent }),
      ...(capUsedPercent === undefined ? {} : { capUsedPercent }),
    };
  };
  return {
    agentId: row.agent_id,
    capPercent,
    state,
    burst: window(
      burstState,
      burstResetsAt,
      row.capacity_burst_used_percent,
    ),
    weekly: window(
      weeklyState,
      weeklyResetsAt,
      row.capacity_weekly_used_percent,
    ),
    nextEligibleAt: fleetTimestamp(row.capacity_next_eligible_at),
    blocker: null,
    generatedAt,
  };
}

function launchFleetActivities(value: unknown): LaunchFleetActivity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LaunchFleetActivity[] => {
    const item = asRecord(entry);
    if (
      !item || typeof item.id !== "string" || typeof item.createdAt !== "string"
    ) {
      return [];
    }
    const kind = item.kind === "alert"
      ? "alert"
      : item.kind === "run"
      ? "run"
      : null;
    if (!kind) return [];
    return [{
      id: item.id,
      kind,
      title: typeof item.title === "string" && item.title.trim()
        ? item.title
        : kind === "run"
        ? "Agent wake"
        : "Agent Alert",
      summary: typeof item.summary === "string" ? item.summary : null,
      status: typeof item.status === "string" ? item.status : "unknown",
      routineId: typeof item.routineId === "string" ? item.routineId : null,
      createdAt: item.createdAt,
    }];
  }).slice(0, 3);
}

async function handleLaunchFleet(request: Request): Promise<Response> {
  const user = await requireLaunchUser(request);
  if (!isAccountSessionAuthSource(user.authSource)) {
    return error("Fleet access requires an account session", 403);
  }
  const db = getDbConfig();
  const [ownedRows, accountCapacity, snapshotResponse] = await Promise.all([
    fetchOwnedApps(user.id),
    getAccountCapacityStatus(user.id),
    fetch(`${db.baseUrl}/rest/v1/rpc/get_launch_fleet_snapshot`, {
      method: "POST",
      headers: db.headers,
      body: JSON.stringify({ p_user_id: user.id }),
    }),
  ]);
  const snapshotRows = await readRows<LaunchFleetSnapshotRow>(
    snapshotResponse,
    "Failed to fetch Fleet snapshot",
  );
  const snapshotByAgent = new Map(
    snapshotRows.map((row) => [row.agent_id, row]),
  );
  const privateRows = ownedRows.filter((row) => row.visibility === "private");
  const owners = await fetchOwnerMap(privateRows.map((row) => row.owner_id));
  const installedIds = new Set(privateRows.map((row) => row.id));

  const generatedAt = new Date().toISOString();
  const response: LaunchFleetResponse = {
    agents: privateRows.map((row) => {
      const snapshot = snapshotByAgent.get(row.id);
      return {
        agent: toLaunchAgentSummary(row, {
          owners,
          viewerId: user.id,
          installedIds,
        }),
        state: launchFleetState(snapshot?.state),
        health: launchFleetHealth(snapshot?.health),
        routineCount: Math.max(0, Math.floor(numeric(snapshot?.routine_count))),
        activeRoutineCount: Math.max(
          0,
          Math.floor(numeric(snapshot?.active_routine_count)),
        ),
        nextWakeAt: snapshot?.next_wake_at ?? null,
        lastRunAt: snapshot?.last_run_at ?? null,
        deferredWakeCount: Math.max(
          0,
          Math.floor(numeric(snapshot?.deferred_wake_count)),
        ),
        unreadAlertCount: Math.max(
          0,
          Math.floor(numeric(snapshot?.unread_alert_count)),
        ),
        recentActivity: launchFleetActivities(snapshot?.recent_activity),
        capacity: snapshot
          ? toLaunchFleetAgentCapacity(snapshot, generatedAt)
          : null,
      };
    }),
    accountCapacity: toLaunchCapacityResponse(accountCapacity),
    generatedAt,
  };
  return privateLaunchJson(response);
}

function toLaunchAgentCapacityResponse(
  status: AgentCapacityStatus,
  account: AccountCapacityStatus,
): LaunchAgentCapacityResponse {
  const combinedState = (
    left: AgentCapacityStatus["state"],
    right: AccountCapacityStatus["state"],
  ) =>
    left === "waiting" || right === "waiting"
      ? "waiting" as const
      : left === "low" || right === "low"
      ? "low" as const
      : "available" as const;
  const window = (
    agentWindow: AgentCapacityStatus["burst"],
    accountWindow: AccountCapacityStatus["burst"],
  ) => {
    const capPercent = status.capBasisPoints === null
      ? null
      : status.capBasisPoints / 100;
    const shareUsedPercent = capPercent !== null &&
        agentWindow.usedPercent !== undefined
      ? Math.min(
        100,
        Math.max(0, agentWindow.usedPercent * capPercent / 100),
      )
      : undefined;
    return {
      state: combinedState(agentWindow.state, accountWindow.state),
      resetsAt: accountWindow.resetsAt,
      ...(shareUsedPercent === undefined ? {} : { shareUsedPercent }),
      ...(agentWindow.usedPercent === undefined
        ? {}
        : { capUsedPercent: agentWindow.usedPercent }),
    };
  };
  return {
    agentId: status.agentId,
    capPercent: status.capBasisPoints === null
      ? null
      : status.capBasisPoints / 100,
    state: combinedState(status.state, account.state),
    burst: window(status.burst, account.burst),
    weekly: window(status.weekly, account.weekly),
    nextEligibleAt: [status.nextEligibleAt, account.nextEligibleAt]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null,
    blocker: null,
    generatedAt: new Date().toISOString(),
  };
}

async function handleLaunchAgentCapacity(
  request: Request,
  encodedLocator: string,
  method: string,
): Promise<Response> {
  if (method !== "GET" && method !== "PATCH") {
    return error("Method not allowed for Agent capacity", 405);
  }
  const user = await requireLaunchUser(request);
  requireAccountSessionForRoutine(user);
  const resolved = await resolveOwnerPrivateRoutineAgent(user, encodedLocator);
  if (resolved instanceof Response) return resolved;
  let account: AccountCapacityStatus | null = null;
  if (method === "PATCH") {
    const body = asRecord(await readJsonBody<unknown>(request));
    if (!body || Object.keys(body).some((key) => key !== "capPercent")) {
      throw new RequestValidationError(
        "Agent capacity body must contain only capPercent",
      );
    }
    const requestBody = body as unknown as LaunchAgentCapacityUpdateRequest;
    const basisPoints = typeof requestBody.capPercent === "number"
      ? Math.round(requestBody.capPercent * 100)
      : NaN;
    if (
      !Number.isFinite(requestBody.capPercent) ||
      !Number.isInteger(basisPoints) || basisPoints < 1 ||
      basisPoints > 10_000 ||
      Math.abs(basisPoints / 100 - requestBody.capPercent) > 1e-9
    ) {
      throw new RequestValidationError(
        "capPercent must be between 0.01 and 100 with at most two decimal places",
      );
    }
    account = await getAccountCapacityStatus(user.id);
    if (account.planCode === "free") {
      throw new RequestValidationError(
        "Free capacity is fixed; Agent caps are available on paid plans",
        409,
      );
    }
    try {
      await setAgentCapacityCap({
        userId: user.id,
        agentId: resolved.id,
        capBasisPoints: basisPoints,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Free")) {
        throw new RequestValidationError(
          "Free capacity is fixed; Agent caps are available on paid plans",
          409,
        );
      }
      throw err;
    }
  }
  const [agent, resolvedAccount] = await Promise.all([
    getAgentCapacityStatus(user.id, resolved.id),
    account ? Promise.resolve(account) : getAccountCapacityStatus(user.id),
  ]);
  return privateLaunchJson(
    toLaunchAgentCapacityResponse(agent, resolvedAccount),
  );
}

// ── Library folders (launch-web "Agents" page) ──────────────────────────────
// Browser-only, per-user organization of the library. CRITICAL: every read and
// write filters owner_user_id = the session user EXPLICITLY — getDbConfig() uses
// the service role, which bypasses RLS, so the RLS policies on these tables are
// defense-in-depth only, never the tenant boundary.

type LaunchFolderScope = "owned" | "installed";

interface LaunchFolderRow {
  id: string;
  name: string;
  position: number;
}

interface LaunchFolderMemberRow {
  app_id: string;
  folder_id: string;
}

const FOLDER_NAME_MAX = 60;
const MAX_FOLDERS_PER_SCOPE = 100;

function requireAccountSessionForFolders(user: AuthUser): void {
  if (
    user.authSource === "api_token" ||
    user.authSource === "routine_actor" ||
    user.authSource === "sandbox_actor"
  ) {
    throw new RequestValidationError(
      "Organizing library folders requires an account session",
      403,
    );
  }
}

function parseFolderScope(value: unknown): LaunchFolderScope | null {
  return value === "owned" || value === "installed" ? value : null;
}

function parseFolderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > FOLDER_NAME_MAX) return null;
  return name;
}

function toLaunchFolder(row: LaunchFolderRow): LaunchFolder {
  return { id: row.id, name: row.name, position: row.position };
}

async function fetchFolders(
  userId: string,
  scope: LaunchFolderScope,
): Promise<LaunchFolderRow[]> {
  const db = getDbConfig();
  return await dbGet<LaunchFolderRow>(db, "library_folders", {
    owner_user_id: `eq.${userId}`,
    scope: `eq.${scope}`,
    select: "id,name,position",
    order: "position.asc,created_at.asc",
    limit: "500",
  });
}

async function fetchFolderMembers(
  userId: string,
  scope: LaunchFolderScope,
): Promise<Map<string, string>> {
  const db = getDbConfig();
  const rows = await dbGet<LaunchFolderMemberRow>(
    db,
    "library_folder_members",
    {
      owner_user_id: `eq.${userId}`,
      scope: `eq.${scope}`,
      select: "app_id,folder_id",
      limit: "5000",
    },
  );
  return new Map(rows.map((r) => [r.app_id, r.folder_id]));
}

async function handleLaunchFolders(
  request: Request,
  path: string,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForFolders(user);

  // Move an Agent into a folder, or out (folder_id: null).
  if (path === "/api/launch/folders/members") {
    if (method !== "PUT") {
      return error("Method not allowed for folder membership", 405);
    }
    return await setFolderMember(request, user.id);
  }

  // Create.
  if (path === "/api/launch/folders") {
    if (method !== "POST") {
      return error("Method not allowed for launch folders", 405);
    }
    return await createFolder(request, user.id);
  }

  // Rename / delete.
  const itemMatch = path.match(/^\/api\/launch\/folders\/([^/]+)$/);
  if (itemMatch) {
    const folderId = decodeURIComponent(itemMatch[1]);
    if (!isUuid(folderId)) return error("Folder not found", 404);
    if (method === "PATCH") {
      return await renameFolder(request, user.id, folderId);
    }
    if (method === "DELETE") return await deleteFolder(user.id, folderId);
    return error("Method not allowed for launch folder", 405);
  }

  return error("Launch folder endpoint not found", 404);
}

async function createFolder(
  request: Request,
  userId: string,
): Promise<Response> {
  const body = asRecord(await readJsonBody<unknown>(request)) || {};
  const scope = parseFolderScope(body.scope);
  const name = parseFolderName(body.name);
  if (!scope) return error("scope must be 'owned' or 'installed'", 400);
  if (!name) return error(`name is required (1-${FOLDER_NAME_MAX} chars)`, 400);

  const existing = await fetchFolders(userId, scope);
  if (existing.length >= MAX_FOLDERS_PER_SCOPE) {
    return error("Folder limit reached for this tab", 409);
  }
  const position = existing.reduce((m, f) => Math.max(m, f.position), -1) + 1;

  const db = getDbConfig();
  const res = await fetch(`${db.baseUrl}/rest/v1/library_folders`, {
    method: "POST",
    headers: { ...db.headers, Prefer: "return=representation" },
    body: JSON.stringify({ owner_user_id: userId, scope, name, position }),
  });
  if (res.status === 409) {
    return error("A folder with that name already exists", 409);
  }
  if (!res.ok) return error("Couldn't create the folder", 502);
  const row = (await res.json() as LaunchFolderRow[])[0];
  return json(
    { folder: toLaunchFolder(row), generatedAt: new Date().toISOString() },
    201,
  );
}

async function renameFolder(
  request: Request,
  userId: string,
  folderId: string,
): Promise<Response> {
  const body = asRecord(await readJsonBody<unknown>(request)) || {};
  const name = parseFolderName(body.name);
  if (!name) return error(`name is required (1-${FOLDER_NAME_MAX} chars)`, 400);

  const db = getDbConfig();
  // Owner filter is the tenant boundary (service role bypasses RLS).
  const res = await fetch(
    `${db.baseUrl}/rest/v1/library_folders?id=eq.${folderId}&owner_user_id=eq.${userId}`,
    {
      method: "PATCH",
      headers: { ...db.headers, Prefer: "return=representation" },
      body: JSON.stringify({ name, updated_at: new Date().toISOString() }),
    },
  );
  if (res.status === 409) {
    return error("A folder with that name already exists", 409);
  }
  if (!res.ok) return error("Couldn't rename the folder", 502);
  const rows = await res.json() as LaunchFolderRow[];
  if (rows.length === 0) return error("Folder not found", 404);
  return json({
    folder: toLaunchFolder(rows[0]),
    generatedAt: new Date().toISOString(),
  });
}

async function deleteFolder(
  userId: string,
  folderId: string,
): Promise<Response> {
  const db = getDbConfig();
  const res = await fetch(
    `${db.baseUrl}/rest/v1/library_folders?id=eq.${folderId}&owner_user_id=eq.${userId}`,
    {
      method: "DELETE",
      headers: { ...db.headers, Prefer: "return=representation" },
    },
  );
  if (!res.ok) return error("Couldn't delete the folder", 502);
  const rows = await res.json() as Array<{ id: string }>;
  if (rows.length === 0) return error("Folder not found", 404);
  // library_folder_members rows cascade-delete via the composite FK.
  return json({ ok: true, generatedAt: new Date().toISOString() });
}

async function setFolderMember(
  request: Request,
  userId: string,
): Promise<Response> {
  const body = asRecord(await readJsonBody<unknown>(request)) || {};
  const scope = parseFolderScope(body.scope);
  const appId = typeof body.app_id === "string" ? body.app_id.trim() : "";
  const rawFolderId = body.folder_id;
  if (!scope) return error("scope must be 'owned' or 'installed'", 400);
  if (!isUuid(appId)) return error("app_id must be a valid id", 400);

  const db = getDbConfig();

  // null folder_id => uncategorize (remove the membership row).
  if (rawFolderId === null || rawFolderId === undefined) {
    const res = await fetch(
      `${db.baseUrl}/rest/v1/library_folder_members` +
        `?owner_user_id=eq.${userId}&scope=eq.${scope}&app_id=eq.${appId}`,
      { method: "DELETE", headers: db.headers },
    );
    if (!res.ok) return error("Couldn't update the folder", 502);
    return json({
      appId,
      scope,
      folderId: null,
      generatedAt: new Date().toISOString(),
    });
  }

  if (typeof rawFolderId !== "string" || !isUuid(rawFolderId)) {
    return error("folder_id must be a valid id or null", 400);
  }
  // Upsert on (owner, scope, app_id). The composite FK
  // (folder_id, owner_user_id, scope) -> library_folders guarantees the target
  // folder exists, is owned by THIS user, and is on the SAME tab — so a
  // forged/foreign/mismatched folder_id is rejected by the database itself.
  const res = await fetch(`${db.baseUrl}/rest/v1/library_folder_members`, {
    method: "POST",
    headers: { ...db.headers, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      owner_user_id: userId,
      scope,
      app_id: appId,
      folder_id: rawFolderId,
    }),
  });
  if (!res.ok) {
    return error("Folder not found for this tab", 404);
  }
  return json({
    appId,
    scope,
    folderId: rawFolderId,
    generatedAt: new Date().toISOString(),
  });
}

interface ManagedRoutineIdRow {
  id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface AgentHomeSettingsAppRow {
  id: string;
  env_vars: Record<string, string> | null;
  env_schema: Record<string, unknown> | null;
  manifest: unknown;
}

const AGENT_HOME_PRIVATE_CACHE_CONTROL = "private, no-store";

function withAgentHomePrivacy(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", AGENT_HOME_PRIVATE_CACHE_CONTROL);
  headers.set("Vary", "Cookie, Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function agentHomeJson(data: unknown, status = 200): Response {
  return withAgentHomePrivacy(json(data, status));
}

function agentHomeError(
  message: string,
  status: number,
  code?: string,
): Response {
  return agentHomeJson({
    error: message,
    ...(code ? { code } : {}),
  }, status);
}

function requireAccountSessionForAgentHome(user: AuthUser): void {
  if (!isAccountSessionAuthSource(user.authSource)) {
    throw new RequestValidationError(
      "Agent Home requires an authenticated account session",
      403,
    );
  }
}

function launchAgentHomeMethodAllowed(
  section: string | null,
  method: string,
): boolean {
  if (section === null) return method === "GET";
  if (section === "identity" || section === "routine") {
    return method === "PATCH";
  }
  if (section === "settings") return method === "PUT";
  if (section === "actions" || section === "pause") return method === "POST";
  return false;
}

function versionMetadata(row: LaunchAppRow): VersionMetadata[] {
  return Array.isArray(row.version_metadata)
    ? row.version_metadata.filter((entry): entry is VersionMetadata =>
      Boolean(entry && typeof entry === "object")
    ) as VersionMetadata[]
    : [];
}

function canonicalVersionMetadata(row: LaunchAppRow): VersionMetadata[] {
  const latest = new Map<string, VersionMetadata>();
  for (const entry of versionMetadata(row)) latest.set(entry.version, entry);
  return [...latest.values()].map((entry) => {
    if (
      !entry.test_attestation ||
      findPersistedTestAttestation([entry], entry.version)
    ) {
      return entry;
    }
    // Preserve safe release metadata while stripping malformed proof material
    // so the pure read-model builder cannot mistake it for a tested candidate.
    const { test_attestation: _invalidProof, ...safeEntry } = entry;
    return safeEntry;
  });
}

function newestTestedCandidateVersion(row: LaunchAppRow): string | null {
  const current = row.current_version || null;
  const available = new Set(
    Array.isArray(row.versions)
      ? row.versions
      : versionMetadata(row).map((entry) => entry.version),
  );
  // Uploads enforce unique versions, but legacy/corrupt rows can contain
  // duplicate metadata. Match the read-model rule exactly: the last row is
  // authoritative for a version, and an invalid replacement must not fall
  // back to a stale proof for potentially overwritten artifacts.
  const latestMetadata = new Map<string, VersionMetadata>();
  for (const entry of canonicalVersionMetadata(row)) {
    latestMetadata.set(entry.version, entry);
  }
  const canonicalMetadata = [...latestMetadata.values()];
  return [...latestMetadata.values()]
    .filter((entry) =>
      entry.version !== current && available.has(entry.version) &&
      findPersistedTestAttestation([entry], entry.version) !== null &&
      versionWasUploadedAfterLive(canonicalMetadata, current, entry.version)
    )
    .sort((left, right) =>
      (Date.parse(right.created_at) || 0) - (Date.parse(left.created_at) || 0)
    )[0]?.version || null;
}

async function loadAgentHomeCandidateManifest(
  row: LaunchAppRow,
  candidateVersion: string | null,
): Promise<AppManifest | null> {
  if (!candidateVersion || row.runtime === "gpu") return null;
  try {
    const files = await readVersionSourceFiles(row.id, candidateVersion);
    const manifestFile = files.find((file) => file.path === "manifest.json");
    if (!manifestFile) return null;
    const parsed = JSON.parse(manifestFile.content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as AppManifest
      : null;
  } catch {
    return null;
  }
}

async function loadAgentHomeSettingStatuses(
  userId: string,
  row: LaunchAppRow,
): Promise<AgentHomeSettingStatus[]> {
  const schema = resolveAppEnvSchema(row as never);
  const entries = Object.entries(schema);
  if (entries.length === 0) return [];

  const settingsRows = await dbGet<AgentHomeSettingsAppRow>(
    getDbConfig(),
    "apps",
    {
      id: `eq.${row.id}`,
      owner_id: `eq.${userId}`,
      deleted_at: "is.null",
      select: "id,env_vars,env_schema,manifest",
      limit: "1",
    },
  );
  const settingsRow = settingsRows[0];
  if (!settingsRow) {
    throw new LaunchServiceUnavailableError(
      "Agent Home settings state is unavailable",
    );
  }
  const runtimeApp = {
    id: settingsRow.id,
    env_vars: settingsRow.env_vars || {},
    env_schema: settingsRow.env_schema || {},
    manifest: settingsRow.manifest,
  } as unknown as Parameters<typeof resolveAppRuntimeEnvVars>[0];
  const [runtimeSettings, userSecretRows] = await Promise.all([
    resolveAppRuntimeEnvVars(runtimeApp, userId),
    dbGet<UserAppSecretStatusRow>(getDbConfig(), "user_app_secrets", {
      user_id: `eq.${userId}`,
      app_id: `eq.${row.id}`,
      select: "key,updated_at",
      limit: "100",
    }),
  ]);
  const perUserUpdatedAt = new Map(
    userSecretRows.map((secret) => [secret.key, secret.updated_at || null]),
  );
  return entries.map(([key, entry]) => {
    const perUser = entry.scope === "per_user";
    const credentialBound = Boolean(entry.credential);
    const configured = perUser || credentialBound
      ? Boolean(runtimeSettings.credentials[key]?.value)
      : Boolean(runtimeSettings.envVars[key]);
    return {
      key,
      scope: perUser ? "per_user" : "agent",
      label: entry.label || key,
      description: entry.description || null,
      help: entry.help || null,
      input: entry.input || "text",
      placeholder: entry.placeholder || null,
      group: entry.group || null,
      required: entry.required ?? false,
      configured,
      secret: entry.input === "password" || credentialBound,
      destination: entry.credential?.destination || null,
      updatedAt: perUser
        ? perUserUpdatedAt.get(key) || null
        : row.updated_at || null,
    } satisfies AgentHomeSettingStatus;
  });
}

async function loadAgentHomeBudgetUsage(
  userId: string,
  routine: LaunchAgentRoutineOverview | null,
): Promise<{
  usage: AgentHomeBudgetUsage | null;
  callsByRun: Map<string, number>;
}> {
  if (!routine) return { usage: null, callsByRun: new Map() };
  const exact = await getAgentHomeBudgetUsage({
    userId,
    routineId: routine.id,
    recentRunIds: routine.recentRuns.map((run) => run.id),
  });
  return {
    usage: {
      lastRun: exact.lastRun,
      lastRunCalls: exact.lastRunCalls,
      daily: exact.daily,
      monthly: exact.monthly,
      dayStartedAt: exact.dayStartedAt,
      monthStartedAt: exact.monthStartedAt,
    },
    callsByRun: new Map(exact.callsByRun),
  };
}

async function loadAgentHomeCallTargets(
  userId: string,
  routine: LaunchAgentRoutineOverview | null,
  dependencies: Array<{ app: string; functions: string[] }>,
): Promise<Map<string, { valid: boolean; targetAppId: string | null }>> {
  const requested = new Map<string, { appRef: string; functionName: string }>();
  for (const capability of routine?.capabilities || []) {
    const appRef = capability.appId || capability.appRef;
    requested.set(agentHomeCallTargetKey(appRef, capability.functionName), {
      appRef,
      functionName: capability.functionName,
    });
  }
  for (const dependency of dependencies) {
    for (const functionName of dependency.functions) {
      requested.set(agentHomeCallTargetKey(dependency.app, functionName), {
        appRef: dependency.app,
        functionName,
      });
    }
  }
  if (requested.size > 200) {
    throw new LaunchServiceUnavailableError(
      "Agent Home authority exceeds the supported target inspection bound",
    );
  }

  const result = new Map<
    string,
    { valid: boolean; targetAppId: string | null }
  >();
  await Promise.all([...requested.entries()].map(async ([key, request]) => {
    let target: LaunchAppRow | null = null;
    try {
      target = await fetchToolByLocator(parseLocator(request.appRef), {
        ownerId: userId,
      });
    } catch {
      target = null;
    }
    const targetManifest = target ? parseManifest(target.manifest) : null;
    const exposesFunction = Boolean(
      targetManifest?.functions &&
        Object.prototype.hasOwnProperty.call(
          targetManifest.functions,
          request.functionName,
        ),
    );
    result.set(key, {
      valid: Boolean(
        target && target.visibility === "private" && exposesFunction,
      ),
      targetAppId: target?.id || null,
    });
  }));
  return result;
}

function agentHomeCallTargetFingerprint(
  targets: ReadonlyMap<string, { valid: boolean; targetAppId: string | null }>,
): string {
  return JSON.stringify(
    [...targets.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function buildLaunchAgentHomeSnapshotAttempt(
  user: AuthUser,
  row: LaunchAppRow,
  revision: string,
): Promise<LaunchAgentHomeResponse | null> {
  const now = new Date();
  const routineId = await fetchPrimaryRoutineId(user.id, row.id);
  const routineResponse = await buildLaunchAgentRoutineResponse(
    user.id,
    row,
    routineId,
  );
  const routine = routineResponse.routine;
  const candidateVersion = newestTestedCandidateVersion(row);
  const manifest = parseManifest(row.manifest);
  const runtimeManifest = typeof row.manifest === "string"
    ? row.manifest
    : row.manifest
    ? JSON.stringify(row.manifest)
    : null;
  const dependencies = resolveRuntimeAppCallDependencies({
    manifest: runtimeManifest,
  });

  const [
    settings,
    functions,
    grants,
    candidateManifest,
    budget,
    liveBundle,
    callTargets,
    capacityStatus,
    agentCapacityStatus,
    routines,
    profile,
  ] = await Promise.all([
    loadAgentHomeSettingStatuses(user.id, row),
    buildLaunchFunctionSummaries(row, user.id),
    listGrantSummaries({ userId: user.id, callerAppId: row.id }),
    loadAgentHomeCandidateManifest(row, candidateVersion),
    loadAgentHomeBudgetUsage(user.id, routine),
    row.current_version
      ? loadLiveExecutedBundle(row.id)
      : Promise.resolve({ code: null, attestation: null }),
    loadAgentHomeCallTargets(user.id, routine, dependencies),
    getAccountCapacityStatus(user.id).catch((err) => {
      console.error("[CAPACITY] Agent Home status unavailable:", err);
      return null;
    }),
    getAgentCapacityStatus(user.id, row.id).catch((err) => {
      console.error("[CAPACITY] Agent-specific Home status unavailable:", err);
      return null;
    }),
    // The enclosing Home snapshot already brackets every dependency with this
    // exact revision, so the nested collection must not consume an independent
    // token (which would make one concurrent commit trigger nested retries).
    buildLaunchAgentRoutinesResponse(user.id, row, revision),
    userService.getUser(user.id),
  ]);
  // One atomic KV read supplies both executed bytes and their attestation.
  // Bind the verdict to the DB live version so a validly signed old bundle is
  // still surfaced as unverified rather than certifying a replay/downgrade.
  const integrity = !row.current_version || liveBundle.code === null
    ? "unknown" as const
    : await verifyExecutedBundle({
      appId: row.id,
      esmCode: liveBundle.code,
      attestation: liveBundle.attestation,
      expectedVersion: row.current_version,
    }).then((verdict) =>
      verdict.status === "ok"
        ? "verified" as const
        : verdict.status === "error"
        ? "unknown" as const
        : "unverified" as const
    );
  const permissionResolution = resolveStrictManifestPermissions({
    manifest: runtimeManifest,
  });
  const connectedKeys = new Set(
    settings.filter((setting) =>
      setting.scope === "per_user" && setting.configured
    ).map((
      setting,
    ) => setting.key),
  );
  const versions = Array.isArray(row.versions)
    ? row.versions
    : versionMetadata(row).map((entry) => entry.version);
  const candidateAuthorityChanges = candidateManifest
    ? summarizeManifestAuthorityChanges(manifest, candidateManifest)
    : [];
  // executeSetVersion performs the final proof, manifest, migration, bundle,
  // and live-pointer checks. GPU promotion is intentionally unavailable until
  // its staged build is version-addressable.
  const candidatePreflightReady = Boolean(candidateManifest) &&
    row.runtime !== "gpu";

  const home = buildAgentHomeResponse({
    now,
    revision,
    agent: {
      id: row.id,
      slug: row.slug || row.id,
      name: row.name || row.slug || row.id,
      description: row.description || null,
    },
    manifest,
    effectivePermissions: permissionResolution.permissions,
    ignoredPermissions: permissionResolution.ignoredPermissions,
    functions,
    dependencies,
    callTargets,
    grants,
    routine,
    settings,
    disclosure: buildAppNetworkDisclosure(manifest, connectedKeys),
    budgetUsage: budget.usage,
    callsByRun: budget.callsByRun,
    capacity: capacityStatus ? toLaunchCapacityResponse(capacityStatus) : null,
    byokConfigured: Boolean(
      profile?.byok_enabled && profile.byok_provider &&
        profile.byok_configs.some((config) =>
          config.provider === profile.byok_provider && config.has_key
        ),
    ),
    release: {
      versions,
      currentVersion: row.current_version || null,
      versionMetadata: canonicalVersionMetadata(row),
      promotedAt: row.current_version_promoted_at || null,
      executedVersion: liveBundle.attestation?.version || null,
      integrity,
      candidateAuthorityChanges,
      candidateManifestAvailable: Boolean(candidateManifest),
      candidatePreflightReady,
    },
  });
  if (routines.revision !== revision) return null;
  home.routines = {
    revision: routines.revision,
    primaryRoutineId: routines.primaryRoutineId,
    routines: routines.routines,
    aggregate: routines.aggregate,
  };
  home.agentCapacity = agentCapacityStatus && capacityStatus
    ? toLaunchAgentCapacityResponse(agentCapacityStatus, capacityStatus)
    : null;
  const confirmedTargets = await loadAgentHomeCallTargets(
    user.id,
    routine,
    dependencies,
  );
  if (
    agentHomeCallTargetFingerprint(confirmedTargets) !==
      agentHomeCallTargetFingerprint(callTargets)
  ) return null;
  return home;
}

async function reloadLaunchAgentHomeRow(
  userId: string,
  appId: string,
): Promise<LaunchAppRow> {
  const rows = await dbGet<LaunchAppRow>(getDbConfig(), "apps", {
    id: `eq.${appId}`,
    owner_id: `eq.${userId}`,
    deleted_at: "is.null",
    select: APP_SELECT,
    limit: "1",
  });
  const row = rows[0];
  if (!row) throw new RequestValidationError("Agent not found", 404);
  if (row.visibility !== "private") {
    throw new RequestValidationError(
      "Persistent Agent Home is available only for private Agents you own",
      409,
    );
  }
  return row;
}

async function buildLaunchAgentHomeSnapshot(
  user: AuthUser,
  initialRow: LaunchAppRow,
): Promise<LaunchAgentHomeResponse> {
  // The Home revision certifies configuration, not volatile execution state.
  // Re-read the app and every aggregate dependency between two revision reads;
  // retry when a configuration transaction commits during composition so a
  // returned token can never certify a mixed before/after projection.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const startedAtRevision = await getAgentHomeRevision(
      initialRow.id,
      user.id,
    );
    if (!startedAtRevision) {
      throw new LaunchServiceUnavailableError(
        "Agent Home revision state is unavailable",
      );
    }
    const row = await reloadLaunchAgentHomeRow(user.id, initialRow.id);
    const home = await buildLaunchAgentHomeSnapshotAttempt(
      user,
      row,
      startedAtRevision,
    );
    if (!home) continue;
    const completedAtRevision = await getAgentHomeRevision(
      initialRow.id,
      user.id,
    );
    if (completedAtRevision === startedAtRevision) return home;
  }
  throw new LaunchServiceUnavailableError(
    "Agent Home changed repeatedly while its snapshot was being assembled",
  );
}

class AgentHomeStaleMutationError extends Error {
  constructor(readonly currentRevision: string) {
    super("Agent Home changed since this page was loaded");
  }
}

function requireExpectedAgentHomeRevision(
  body: Record<string, unknown>,
  appId: string,
): string {
  if (
    typeof body.expectedRevision !== "string" || !body.expectedRevision.trim()
  ) {
    throw new RequestValidationError("expectedRevision is required");
  }
  const revision = body.expectedRevision.trim();
  parseAgentHomeRevision(revision, appId);
  return revision;
}

function rejectUnknownAgentHomeFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(body).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new RequestValidationError(
      `Unknown Agent Home fields: ${unknown.join(", ")}`,
    );
  }
}

async function refreshLaunchAgentHome(
  user: AuthUser,
  encodedLocator: string,
): Promise<LaunchAgentHomeResponse> {
  const resolved = await resolveOwnerPrivateRoutineAgent(user, encodedLocator);
  if (resolved instanceof Response) {
    throw new RequestValidationError("Agent not found", resolved.status);
  }
  return await buildLaunchAgentHomeSnapshot(user, resolved);
}

async function updateLaunchAgentHomeIdentity(
  user: AuthUser,
  row: LaunchAppRow,
  body: Record<string, unknown>,
): Promise<void> {
  rejectUnknownAgentHomeFields(body, [
    "expectedRevision",
    "name",
    "description",
  ]);
  const expectedRevision = requireExpectedAgentHomeRevision(body, row.id);
  if (!("name" in body) && !("description" in body)) {
    throw new RequestValidationError("Provide name or description");
  }
  if (
    "name" in body &&
    (typeof body.name !== "string" || !body.name.trim() ||
      body.name.trim().length > 200)
  ) {
    throw new RequestValidationError("name must be 1 to 200 characters");
  }
  if (
    "description" in body && body.description !== null &&
    (typeof body.description !== "string" || body.description.length > 5000)
  ) {
    throw new RequestValidationError(
      "description must be null or at most 5,000 characters",
    );
  }
  await updateAgentHomeIdentityCAS({
    appId: row.id,
    userId: user.id,
    expectedRevision,
    authSource: user.authSource,
    ...("name" in body ? { name: (body.name as string).trim() } : {}),
    ...("description" in body
      ? { description: body.description as string | null }
      : {}),
  });
}

async function updateLaunchAgentHomeRoutine(
  user: AuthUser,
  row: LaunchAppRow,
  routine: StoredRoutine,
  body: Record<string, unknown>,
): Promise<void> {
  rejectUnknownAgentHomeFields(body, [
    "expectedRevision",
    "mission",
    "intervalSeconds",
    "schedule",
    "budgets",
  ]);
  const expectedRevision = requireExpectedAgentHomeRevision(body, row.id);
  const { expectedRevision: _expected, ...update } =
    body as unknown as LaunchAgentManagedRoutineUpdateRequest;
  const prepared = prepareLaunchRoutineMutation(routine, update);
  await updateAgentHomeManagedRoutineCAS({
    appId: row.id,
    userId: user.id,
    routineId: routine.id,
    expectedRevision,
    authSource: user.authSource,
    ...(prepared.mission !== undefined ? { mission: prepared.mission } : {}),
    ...(prepared.schedule
      ? {
        schedule: prepared.schedule,
        activeNextRunAt: prepared.activeNextRunAt ?? null,
      }
      : {}),
    ...(prepared.budgets !== undefined ? { budgets: prepared.budgets } : {}),
  });
}

async function updateLaunchAgentHomeSettings(
  user: AuthUser,
  row: LaunchAppRow,
  body: Record<string, unknown>,
): Promise<void> {
  rejectUnknownAgentHomeFields(body, ["expectedRevision", "values"]);
  const expectedRevision = requireExpectedAgentHomeRevision(body, row.id);
  const values = asRecord(body.values);
  if (!values || Object.keys(values).length === 0) {
    throw new RequestValidationError("values must be a non-empty object");
  }
  if (Object.keys(values).length > 50) {
    throw new RequestValidationError(
      "At most 50 settings may be updated at once",
    );
  }
  const schema = resolveAppEnvSchema(row as never);
  const agentValues: Record<string, string | null> = {};
  const perUserValues: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(values)) {
    const entry = schema[key];
    if (!entry) {
      throw new RequestValidationError(
        `${key}: not a declared setting for this Agent`,
      );
    }
    if (value !== null && typeof value !== "string") {
      throw new RequestValidationError(
        `${key}: value must be a string or null`,
      );
    }
    if (typeof value === "string") {
      if (!value) {
        throw new RequestValidationError(
          `${key}: use null to remove a setting; empty values are not accepted`,
        );
      }
      const validation = validateEnvVarValue(value);
      if (!validation.valid) {
        throw new RequestValidationError(`${key}: ${validation.error}`);
      }
    }
    const encrypted = value === null ? null : await encryptEnvVar(value);
    (entry.scope === "per_user" ? perUserValues : agentValues)[key] = encrypted;
  }
  await updateAgentHomeSettingsCAS({
    appId: row.id,
    userId: user.id,
    expectedRevision,
    authSource: user.authSource,
    agentCiphertexts: agentValues,
    perUserCiphertexts: perUserValues,
  });
}

async function assertLaunchAgentHomeRevision(
  user: AuthUser,
  row: LaunchAppRow,
  expectedRevision: string,
): Promise<void> {
  await assertAgentHomeRevision({
    appId: row.id,
    userId: user.id,
    expectedRevision,
    authSource: user.authSource,
  });
}

interface LaunchAgentHomeActionOutcome {
  kind: "completed" | "pending" | "failed";
  requestId: string;
  replayed: boolean;
  response: Record<string, unknown>;
}

class LaunchAgentHomeActionStatusUnknownError extends Error {
  constructor(readonly requestId: string) {
    super(
      "The Agent Home action ran, but its durable result could not be confirmed",
    );
    this.name = "LaunchAgentHomeActionStatusUnknownError";
  }
}

function launchAgentHomeActionFailure(err: unknown): Record<string, unknown> {
  if (err instanceof AgentHomeRevisionError) {
    return { error: err.message, code: err.code, status: err.status };
  }
  if (err instanceof RequestValidationError) {
    return {
      error: err.message,
      code: "AGENT_HOME_ACTION_BLOCKED",
      status: err.status,
    };
  }
  if (err instanceof RoutinePlatformError) {
    return {
      error: err.message,
      code: "AGENT_HOME_ACTION_BLOCKED",
      status: 409,
    };
  }
  if (err instanceof Error && err.name === "ToolError") {
    const code = (err as Error & { code?: number }).code;
    return {
      error: err.message,
      code: "AGENT_HOME_PROMOTION_FAILED",
      status: code === -32003
        ? 403
        : code === -32602
        ? 400
        : code === -32006
        ? 409
        : 503,
    };
  }
  return {
    error: "Agent Home action failed",
    code: "AGENT_HOME_ACTION_FAILED",
    status: 500,
  };
}

function isDeterministicLaunchAgentHomeActionFailure(err: unknown): boolean {
  if (err instanceof AgentHomeStaleMutationError) return true;
  if (
    err instanceof RequestValidationError || err instanceof RoutinePlatformError
  ) {
    return true;
  }
  if (err instanceof Error && err.name === "ToolError") {
    const code = (err as Error & { code?: number }).code;
    return code === -32003 || code === -32006 || code === -32602;
  }
  return err instanceof AgentHomeRevisionError && err.status < 500;
}

type LaunchAgentHomeActionReconciliation =
  | "not_applied"
  | "applied"
  | "repair_required";

export function classifyLaunchAgentHomePromotionReconciliation(input: {
  databaseAtTarget: boolean;
  liveAtTarget: boolean;
  storageCurrent?: boolean;
}): LaunchAgentHomeActionReconciliation {
  if (!input.databaseAtTarget && !input.liveAtTarget) return "not_applied";
  if (!input.databaseAtTarget || !input.liveAtTarget) return "repair_required";
  return input.storageCurrent === true ? "applied" : "repair_required";
}

async function reconcileLaunchAgentHomeAction(input: {
  user: AuthUser;
  row: LaunchAppRow;
  action: LaunchAgentHomeActionRequest["action"];
  requestId: string;
  capabilityIds?: string[];
  routineId?: string;
  version?: string;
}): Promise<LaunchAgentHomeActionReconciliation> {
  // The durable run link is sufficient proof even if the routine was deleted
  // or ceased to be launch-primary after the queue insert committed.
  if (input.action === "run_now") {
    const runs = await dbGet<{ id: string }>(getDbConfig(), "routine_runs", {
      user_id: `eq.${input.user.id}`,
      agent_home_action_request_id: `eq.${input.requestId}`,
      select: "id",
      limit: "1",
    });
    return runs.length > 0 ? "applied" : "not_applied";
  }
  if (input.action === "promote_candidate") {
    if (!input.version) return "not_applied";
    const current = await reloadLaunchAgentHomeRow(input.user.id, input.row.id);
    const live = await loadLiveExecutedBundle(current.id);
    const liveAtTarget = live.code
      ? (await verifyExecutedBundle({
        appId: current.id,
        esmCode: live.code,
        attestation: live.attestation,
        expectedVersion: input.version,
      })).status === "ok"
      : false;
    const databaseAtTarget = current.current_version === input.version;
    if (!databaseAtTarget || !liveAtTarget) {
      return classifyLaunchAgentHomePromotionReconciliation({
        databaseAtTarget,
        liveAtTarget,
      });
    }

    const storage = await inspectLiveAppStorageAccounting(
      input.user.id,
      current.id,
      input.version,
    );
    return classifyLaunchAgentHomePromotionReconciliation({
      databaseAtTarget,
      liveAtTarget,
      storageCurrent: storage.current,
    });
  }

  const routineId = input.routineId ||
    await fetchPrimaryRoutineId(input.user.id, input.row.id);
  if (!routineId) return "not_applied";
  const routine = await getRoutine(input.user.id, routineId);
  if (!routine) return "not_applied";
  if (input.action === "activate") {
    return routine.status === "active" ? "applied" : "not_applied";
  }
  if (input.action === "pause") {
    return routine.status === "paused" ? "applied" : "not_applied";
  }
  if (input.action === "approve_capabilities") {
    const approved = new Set(
      routine.capabilities.filter((capability) => capability.approved).map(
        (capability) => capability.id,
      ),
    );
    return Boolean(input.capabilityIds?.length) &&
        input.capabilityIds!.every((id) => approved.has(id))
      ? "applied"
      : "not_applied";
  }
  return "not_applied";
}

async function performLaunchAgentHomeAction(
  user: AuthUser,
  row: LaunchAppRow,
  body: Record<string, unknown>,
  managedRoutineId?: string,
): Promise<LaunchAgentHomeActionOutcome> {
  rejectUnknownAgentHomeFields(body, [
    "expectedRevision",
    "idempotencyKey",
    "action",
    "capabilityIds",
    "version",
  ]);
  const expectedRevision = requireExpectedAgentHomeRevision(body, row.id);
  if (typeof body.idempotencyKey !== "string" || !isUuid(body.idempotencyKey)) {
    throw new RequestValidationError("idempotencyKey must be a UUID");
  }
  if (typeof body.action !== "string") {
    throw new RequestValidationError("action is required");
  }
  const action = body.action as LaunchAgentHomeActionRequest["action"];
  if (
    ![
      "approve_capabilities",
      "activate",
      "pause",
      "run_now",
      "promote_candidate",
    ].includes(action)
  ) {
    throw new RequestValidationError(
      "action must be approve_capabilities, activate, pause, run_now, or promote_candidate",
    );
  }
  let capabilityIds: string[] | undefined;
  let version: string | undefined;
  if (action === "approve_capabilities") {
    if (
      !Array.isArray(body.capabilityIds) || body.capabilityIds.length === 0 ||
      body.capabilityIds.length > 100 ||
      body.capabilityIds.some((id) => typeof id !== "string" || !id.trim())
    ) {
      throw new RequestValidationError(
        "capabilityIds must list 1 to 100 exact pending capabilities to approve",
      );
    }
    capabilityIds = [...new Set(body.capabilityIds as string[])].sort();
  } else if (body.capabilityIds !== undefined) {
    throw new RequestValidationError(
      "capabilityIds is valid only for approve_capabilities",
    );
  }
  if (action === "promote_candidate") {
    if (typeof body.version !== "string" || !body.version.trim()) {
      throw new RequestValidationError("version is required for promotion");
    }
    version = body.version.trim();
  } else if (body.version !== undefined) {
    throw new RequestValidationError(
      "version is valid only for promote_candidate",
    );
  }

  if (action === "pause" && !managedRoutineId) {
    // Pause is deliberately outside the serialized action saga. It is an
    // idempotent, owner/private, primary-routine stop lane and must remain
    // available while a promotion lease is slow, expired, or being repaired.
    // The executor re-checks active status before every delivery, so this also
    // fences already-queued work from starting after the pause commits.
    await pauseAgentHomeRoutineEmergency({
      appId: row.id,
      userId: user.id,
      authSource: user.authSource,
    });
    await releaseAgentActivationSlot(user.id, row.id).catch((slotError) => {
      console.warn("[CAPACITY] Failed to release paused Agent slot", slotError);
    });
    return {
      kind: "completed",
      requestId: body.idempotencyKey,
      replayed: false,
      response: { code: "AGENT_HOME_ACTION_COMPLETED", action },
    };
  }

  const claim = await claimAgentHomeAction({
    appId: row.id,
    userId: user.id,
    expectedRevision,
    authSource: user.authSource,
    idempotencyKey: body.idempotencyKey,
    action,
    requestPayload: {
      ...(capabilityIds ? { capabilityIds } : {}),
      ...(managedRoutineId ? { routineId: managedRoutineId } : {}),
      ...(version ? { version } : {}),
    },
  });
  if (!claim.isNew) {
    if (claim.status === "in_progress") {
      let reconciliation: LaunchAgentHomeActionReconciliation = "not_applied";
      try {
        reconciliation = await reconcileLaunchAgentHomeAction({
          user,
          row,
          action,
          requestId: claim.requestId,
          capabilityIds,
          routineId: managedRoutineId,
          version,
        });
      } catch {
        throw new LaunchAgentHomeActionStatusUnknownError(claim.requestId);
      }
      if (reconciliation === "applied") {
        const response = {
          code: "AGENT_HOME_ACTION_COMPLETED",
          action,
          requestFingerprint: claim.requestFingerprint,
        };
        try {
          await completeAgentHomeAction({
            appId: row.id,
            userId: user.id,
            requestId: claim.requestId,
            leaseToken: claim.leaseToken,
            authSource: user.authSource,
            status: "completed",
            response,
          });
        } catch {
          throw new LaunchAgentHomeActionStatusUnknownError(claim.requestId);
        }
        return {
          kind: "completed",
          requestId: claim.requestId,
          replayed: true,
          response,
        };
      }
    }
    return {
      kind: claim.status === "completed"
        ? "completed"
        : claim.status === "failed"
        ? "failed"
        : "pending",
      requestId: claim.requestId,
      replayed: true,
      response: claim.response,
    };
  }

  let sideEffectFinished = false;
  let repairRequired = false;
  // A reclaimed lease may represent a side effect that committed before its
  // completion acknowledgement. Reconcile before attempting it again.
  try {
    const reconciliation = await reconcileLaunchAgentHomeAction({
      user,
      row,
      action,
      requestId: claim.requestId,
      capabilityIds,
      routineId: managedRoutineId,
      version,
    });
    if (reconciliation === "applied") {
      sideEffectFinished = true;
    } else if (reconciliation === "repair_required") {
      repairRequired = true;
    }
  } catch {
    throw new LaunchAgentHomeActionStatusUnknownError(claim.requestId);
  }
  try {
    const home = sideEffectFinished || repairRequired
      ? null
      : await buildLaunchAgentHomeSnapshot(user, row);
    if (home && home.revision !== expectedRevision) {
      throw new AgentHomeStaleMutationError(home.revision);
    }
    if (sideEffectFinished) {
      // Reconciliation proved the original side effect already committed.
    } else if (action === "promote_candidate") {
      if (
        !repairRequired && (
          home!.release.candidate?.version !== version ||
          !home!.actions.canPromoteCandidate
        )
      ) {
        throw new RequestValidationError(
          "That tested candidate is unavailable for safe promotion",
          409,
        );
      }
      if (!repairRequired) {
        await assertLaunchAgentHomeRevision(user, row, expectedRevision);
      }
      await executeSetVersion(
        user.id,
        { app_id: row.id, version },
        {
          requireTestAttestation: true,
          beforeIrreversibleStep: async (step) => {
            await fenceAgentHomePromotionStep({
              appId: row.id,
              userId: user.id,
              requestId: claim.requestId,
              leaseToken: claim.leaseToken,
              authSource: user.authSource,
              step,
            });
          },
          applyAppRecord: async (record) => {
            await commitAgentHomePromotionAppRecord({
              appId: row.id,
              userId: user.id,
              requestId: claim.requestId,
              leaseToken: claim.leaseToken,
              authSource: user.authSource,
              version: record.version,
              storageKey: record.storageKey,
              exports: record.exports,
              manifest: record.manifest,
              envSchema: record.envSchema,
            });
          },
        },
      );
    } else {
      const routineId = managedRoutineId ||
        await fetchPrimaryRoutineId(user.id, row.id);
      if (!routineId) {
        throw new RequestValidationError("Agent has no routine proposal", 404);
      }
      const routine = await getRoutine(user.id, routineId);
      if (!routine) {
        throw new RequestValidationError("Agent has no routine proposal", 404);
      }
      if (action === "approve_capabilities") {
        const pendingIds = new Set(
          routine.capabilities.filter((capability) => !capability.approved).map(
            (capability) => capability.id,
          ),
        );
        const notPending = (capabilityIds || []).filter((id) =>
          !pendingIds.has(id)
        );
        if (notPending.length > 0) {
          throw new RequestValidationError(
            `Capabilities are no longer pending: ${notPending.join(", ")}`,
            409,
          );
        }
        await approveAgentHomeCapabilitiesCAS({
          appId: row.id,
          userId: user.id,
          routineId,
          expectedRevision,
          authSource: user.authSource,
          capabilityIds: capabilityIds || [],
        });
      } else if (action === "activate") {
        if (routine.status !== "active") {
          if (routine.status !== "paused" && routine.status !== "error") {
            throw new RequestValidationError(
              `Routine is ${routine.status} and cannot be activated`,
              409,
            );
          }
          const managedBlockers = managedRoutineId
            ? await collectLaunchRoutineBlockers(user.id, routine)
            : home!.state.blockers;
          if (
            managedRoutineId
              ? managedBlockers.length > 0
              : !home!.actions.canActivate
          ) {
            const err = new RequestValidationError(
              "Agent cannot activate until every setup and integrity blocker is resolved",
              409,
            ) as RequestValidationError & {
              blockers?: LaunchAgentRoutineBlocker[];
            };
            err.blockers = managedBlockers;
            throw err;
          }
          await validateRoutineLaunchActivation(user.id, routine);
          if (managedRoutineId) {
            await updateAgentHomeManagedRoutineStatusCAS({
              appId: row.id,
              userId: user.id,
              routineId,
              expectedRevision,
              authSource: user.authSource,
              status: "active",
              nextRunAt: new Date().toISOString(),
            });
          } else {
            // Compatibility primary action. The managed status RPC is also
            // valid for legacy launch_primary rows and closes the historical
            // Free-slot claim/status race.
            await updateAgentHomeManagedRoutineStatusCAS({
              appId: row.id,
              userId: user.id,
              routineId,
              expectedRevision,
              authSource: user.authSource,
              status: "active",
              nextRunAt: new Date().toISOString(),
            });
          }
        }
      } else if (action === "pause") {
        await updateAgentHomeManagedRoutineStatusCAS({
          appId: row.id,
          userId: user.id,
          routineId,
          expectedRevision,
          authSource: user.authSource,
          status: "paused",
          nextRunAt: null,
        });
      } else if (action === "run_now") {
        if (routine.status !== "active") {
          throw new RequestValidationError(
            `Routine is ${routine.status}; activate it before running manually`,
            409,
          );
        }
        const managedBlockers = managedRoutineId
          ? await collectLaunchRoutineBlockers(user.id, routine)
          : home!.state.blockers;
        if (
          managedRoutineId
            ? managedBlockers.length > 0
            : !home!.actions.canRunNow
        ) {
          throw new RequestValidationError(
            "Agent cannot run until every setup and integrity blocker is resolved",
            409,
          );
        }
        await queueAgentHomeRoutineRun({
          appId: row.id,
          userId: user.id,
          routineId,
          requestId: claim.requestId,
          leaseToken: claim.leaseToken,
          expectedRevision,
          authSource: user.authSource,
        });
      }
    }
    sideEffectFinished = true;
    const response = {
      code: "AGENT_HOME_ACTION_COMPLETED",
      action,
      requestFingerprint: claim.requestFingerprint,
    };
    await completeAgentHomeAction({
      appId: row.id,
      userId: user.id,
      requestId: claim.requestId,
      leaseToken: claim.leaseToken,
      authSource: user.authSource,
      status: "completed",
      response,
    });
    return {
      kind: "completed",
      requestId: claim.requestId,
      replayed: false,
      response,
    };
  } catch (err) {
    // A completion write can fail after the side effect committed. Never
    // overwrite that indeterminate request as failed; the client must retain
    // the same key and reconcile it on retry.
    if (sideEffectFinished) {
      throw new LaunchAgentHomeActionStatusUnknownError(claim.requestId);
    }
    let reconciliation: LaunchAgentHomeActionReconciliation = "not_applied";
    try {
      reconciliation = await reconcileLaunchAgentHomeAction({
        user,
        row,
        action,
        requestId: claim.requestId,
        capabilityIds,
        routineId: managedRoutineId,
        version,
      });
    } catch {
      throw new LaunchAgentHomeActionStatusUnknownError(claim.requestId);
    }
    if (reconciliation === "applied") {
      const response = {
        code: "AGENT_HOME_ACTION_COMPLETED",
        action,
        requestFingerprint: claim.requestFingerprint,
      };
      try {
        await completeAgentHomeAction({
          appId: row.id,
          userId: user.id,
          requestId: claim.requestId,
          leaseToken: claim.leaseToken,
          authSource: user.authSource,
          status: "completed",
          response,
        });
      } catch {
        throw new LaunchAgentHomeActionStatusUnknownError(claim.requestId);
      }
      return {
        kind: "completed",
        requestId: claim.requestId,
        replayed: false,
        response,
      };
    }
    if (
      reconciliation === "repair_required" ||
      !isDeterministicLaunchAgentHomeActionFailure(err)
    ) {
      throw new LaunchAgentHomeActionStatusUnknownError(claim.requestId);
    }
    const response = launchAgentHomeActionFailure(err);
    try {
      await completeAgentHomeAction({
        appId: row.id,
        userId: user.id,
        requestId: claim.requestId,
        leaseToken: claim.leaseToken,
        authSource: user.authSource,
        status: "failed",
        response,
      });
    } catch {
      throw new LaunchAgentHomeActionStatusUnknownError(claim.requestId);
    }
    const storedStatus = response.status;
    if (
      typeof storedStatus === "number" && Number.isInteger(storedStatus) &&
      storedStatus >= 500 && storedStatus <= 599
    ) {
      return {
        kind: "failed",
        requestId: claim.requestId,
        replayed: false,
        response,
      };
    }
    throw err;
  }
}

async function launchAgentHomeConflictResponse(
  user: AuthUser,
  encodedLocator: string,
): Promise<Response> {
  const current = await refreshLaunchAgentHome(user, encodedLocator);
  return agentHomeJson({
    error: "Agent Home changed since this page was loaded",
    code: "AGENT_HOME_REVISION_CONFLICT",
    currentRevision: current.revision,
    current,
  }, 412);
}

async function handleLaunchAgentHomeRoute(
  request: Request,
  encodedLocator: string,
  method: string,
  section: string | null,
): Promise<Response> {
  let user: AuthUser | null = null;
  try {
    if (!launchAgentHomeMethodAllowed(section, method)) {
      return agentHomeError("Method not allowed for Agent Home", 405);
    }
    user = await requireLaunchUser(request);
    requireAccountSessionForAgentHome(user);
    const resolved = await resolveOwnerPrivateRoutineAgent(
      user,
      encodedLocator,
    );
    if (resolved instanceof Response) return withAgentHomePrivacy(resolved);
    const row = resolved;

    if (section === null) {
      return agentHomeJson(await buildLaunchAgentHomeSnapshot(user, row));
    }
    if (section === "pause") {
      const paused = await pauseAgentHomeRoutineEmergency({
        appId: row.id,
        userId: user.id,
        authSource: user.authSource,
      });
      return agentHomeJson({
        paused: true,
        routineId: paused.routineId,
        revision: paused.revision,
        generatedAt: new Date().toISOString(),
      });
    }
    const rawBody = await readJsonBody<unknown>(request);
    const body = asRecord(rawBody);
    if (!body) {
      throw new RequestValidationError("Request body must be an object");
    }

    if (section === "identity") {
      await updateLaunchAgentHomeIdentity(user, row, body);
    } else if (section === "routine") {
      const routineId = await fetchPrimaryRoutineId(user.id, row.id);
      if (!routineId) {
        return agentHomeError("Agent has no routine proposal", 404);
      }
      const routine = await getRoutine(user.id, routineId);
      if (!routine) return agentHomeError("Agent has no routine proposal", 404);
      await updateLaunchAgentHomeRoutine(user, row, routine, body);
    } else if (section === "settings") {
      return withAgentHomePrivacy(
        await withSensitiveRouteRateLimit(
          user.id,
          "apps:user_settings_update",
          async () => {
            await updateLaunchAgentHomeSettings(user!, row, body);
            return agentHomeJson(
              await refreshLaunchAgentHome(user!, encodedLocator),
            );
          },
        ),
      );
    } else if (section === "actions") {
      const outcome = await performLaunchAgentHomeAction(user, row, body);
      if (outcome.kind === "pending") {
        return agentHomeJson({
          error: "An identical Agent Home action is already in progress",
          code: "AGENT_HOME_ACTION_IN_PROGRESS",
          status: "pending",
          terminal: false,
          requestId: outcome.requestId,
          replayed: outcome.replayed,
        }, 409);
      }
      if (outcome.kind === "failed") {
        const storedStatus = outcome.response.status;
        const status = typeof storedStatus === "number" &&
            Number.isInteger(storedStatus) && storedStatus >= 400 &&
            storedStatus <= 599
          ? storedStatus
          : 409;
        return agentHomeJson({
          status: "failed",
          terminal: true,
          requestId: outcome.requestId,
          replayed: outcome.replayed,
          error: typeof outcome.response.error === "string"
            ? outcome.response.error
            : "Agent Home action failed",
          ...(typeof outcome.response.code === "string"
            ? { code: outcome.response.code }
            : {}),
        }, status);
      }
    }
    return agentHomeJson(await refreshLaunchAgentHome(user, encodedLocator));
  } catch (err) {
    if (err instanceof LaunchAgentHomeActionStatusUnknownError) {
      return agentHomeJson({
        error:
          "The action result is still being reconciled. Retry with the same request key.",
        code: "AGENT_HOME_ACTION_STATUS_UNKNOWN",
        status: "unknown",
        terminal: false,
        requestId: err.requestId,
      }, 503);
    }
    if (
      user &&
      (err instanceof AgentHomeStaleMutationError ||
        (err instanceof AgentHomeRevisionError &&
          err.code === "AGENT_HOME_REVISION_CONFLICT"))
    ) {
      try {
        return await launchAgentHomeConflictResponse(user, encodedLocator);
      } catch (refreshErr) {
        console.error(
          "[LAUNCH] Failed to refresh stale Agent Home:",
          refreshErr,
        );
        return agentHomeError(
          "Agent Home state is temporarily unavailable",
          503,
        );
      }
    }
    if (err instanceof AgentHomeRevisionError) {
      if (
        err.code === "AGENT_HOME_ACTION_RECOVERY_REQUIRED" && err.recovery
      ) {
        // This route is already account-session, owner, and private-Agent
        // scoped. Returning the exact durable request lets the browser finish
        // an expired prior action after sessionStorage was lost, without
        // exposing recovery material on any public/read surface.
        return agentHomeJson({
          error: err.message,
          code: err.code,
          terminal: false,
          recovery: err.recovery,
        }, err.status);
      }
      return agentHomeError(err.message, err.status, err.code);
    }
    if (err instanceof RequestValidationError) {
      const blockers = (err as RequestValidationError & {
        blockers?: LaunchAgentRoutineBlocker[];
      }).blockers;
      return agentHomeJson({
        error: err.message,
        ...(blockers ? { blockers } : {}),
      }, err.status);
    }
    if (err instanceof RoutinePlatformError) {
      const status = err.code === ROUTINE_PLATFORM_FORBIDDEN
        ? 403
        : err.code === ROUTINE_PLATFORM_NOT_FOUND
        ? 404
        : 409;
      return agentHomeJson({
        error: err.message,
        blockers: [activationErrorBlocker(err)],
      }, status);
    }
    if (err instanceof LaunchServiceUnavailableError) {
      return agentHomeError(err.message, 503);
    }
    if (err instanceof Error && err.name === "ToolError") {
      const code = (err as Error & { code?: number }).code;
      const status = code === -32003 ? 403 : code === -32602 ? 400 : 503;
      return agentHomeError(err.message, status, "AGENT_HOME_PROMOTION_FAILED");
    }
    console.error("[LAUNCH] Agent Home request failed:", err);
    return agentHomeError("Agent Home request failed", 500);
  }
}

const LAUNCH_ROUTINE_BUDGET_KEYS = [
  "maxLightPerRun",
  "maxLightPerDay",
  "maxLightPerMonth",
  "maxCallsPerRun",
] as const;

function requireAccountSessionForRoutine(user: AuthUser): void {
  if (
    user.authSource === "api_token" ||
    user.authSource === "routine_actor" ||
    user.authSource === "sandbox_actor"
  ) {
    throw new RequestValidationError(
      "Persistent Agent routine management requires an account session",
      403,
    );
  }
}

async function resolveOwnerPrivateRoutineAgent(
  user: AuthUser,
  encodedLocator: string,
): Promise<LaunchAppRow | Response> {
  const locator = parseLocator(encodedLocator);
  const row = await fetchToolByLocator(locator, { ownerId: user.id });
  if (!row) return error("Agent not found", 404);
  if (row.visibility !== "private") {
    return error(
      "Persistent Agent routines are available only for private Agents you own",
      409,
    );
  }
  return row;
}

async function fetchPrimaryRoutineId(
  userId: string,
  appId: string,
): Promise<string | null> {
  const rows = await fetchManagedRoutineIds(userId, appId);
  return rows.find((row) => launchRoutineRole(row.metadata) === "primary")
    ?.id ||
    rows[0]?.id || null;
}

async function fetchManagedRoutineIds(
  userId: string,
  appId: string,
): Promise<ManagedRoutineIdRow[]> {
  return await dbGet<ManagedRoutineIdRow>(getDbConfig(), "user_routines", {
    user_id: `eq.${userId}`,
    composer_app_id: `eq.${appId}`,
    deleted_at: "is.null",
    or: "(metadata->>launch_managed.eq.true,metadata->>launch_primary.eq.true)",
    select: "id,metadata,created_at",
    order: "created_at.asc,id.asc",
    limit: "100",
  });
}

function launchRoutineSchedule(
  routine: StoredRoutine,
): { schedule: LaunchAgentRoutineSchedule; nextOccurrences: string[] } {
  const normalized = normalizeRoutineSchedule(routine.schedule);
  const nextOccurrences = previewRoutineRunTimes(normalized, new Date(), 3)
    .map((value) => value.toISOString());
  if (normalized.type === "cron") {
    return {
      schedule: {
        kind: "cron",
        expression: normalized.cron,
        timezone: normalized.timezone,
        label: `${normalized.cron} (${normalized.timezone})`,
      },
      nextOccurrences,
    };
  }
  const seconds = normalized.every_seconds;
  const label = seconds % 86_400 === 0
    ? `Every ${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`
    : seconds % 3_600 === 0
    ? `Every ${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`
    : seconds % 60 === 0
    ? `Every ${seconds / 60} minute${seconds === 60 ? "" : "s"}`
    : `Every ${seconds} seconds`;
  return {
    schedule: { kind: "interval", intervalSeconds: seconds, label },
    nextOccurrences,
  };
}

function safeRoutineReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{0,79}$/u.test(normalized) ? normalized : null;
}

function routineAutoPauseReason(routine: StoredRoutine): string | null {
  const metadata = asRecord(routine.metadata);
  const autoPause = asRecord(metadata?.auto_pause);
  return safeRoutineReason(autoPause?.reason);
}

function routineRunErrorCode(
  run:
    | RoutineMonitorDetailResponse["routine"]["recent_runs"][number]
    | undefined,
): string | null {
  if (!run) return null;
  return safeRoutineReason(asRecord(run.error)?.code);
}

function toLaunchRoutineRun(
  run: RoutineMonitorDetailResponse["routine"]["recent_runs"][number],
): LaunchAgentRoutineRun {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    traceId: run.trace_id,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    durationMs: run.duration_ms,
    totalLight: Number.isFinite(run.total_light)
      ? Math.max(0, run.total_light)
      : 0,
    summary: typeof run.summary === "string" ? run.summary.slice(0, 500) : null,
    errorCode: routineRunErrorCode(run),
    createdAt: run.created_at,
  };
}

function activationErrorBlocker(
  err: unknown,
): LaunchAgentRoutineBlocker | null {
  if (!(err instanceof RoutinePlatformError)) return null;
  return {
    code: err.code === ROUTINE_PLATFORM_FORBIDDEN
      ? "private_owner_required"
      : err.code === ROUTINE_PLATFORM_NOT_FOUND
      ? "capability_target_not_found"
      : "launch_invariant_failed",
    message: err.message,
  };
}

async function collectLaunchRoutineBlockers(
  userId: string,
  routine: StoredRoutine,
): Promise<LaunchAgentRoutineBlocker[]> {
  const blockers: LaunchAgentRoutineBlocker[] = validateRoutineActivation(
    routine,
  )
    .blockers.map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
      ...(blocker.capability_ids
        ? { capabilityIds: blocker.capability_ids }
        : {}),
    }));
  try {
    await validateRoutineLaunchActivation(userId, routine);
  } catch (err) {
    const blocker = activationErrorBlocker(err);
    if (!blocker) throw err;
    blockers.push(blocker);
  }
  if (routine.status === "disabled") {
    blockers.push({
      code: "routine_disabled",
      message: "This routine is disabled and cannot be activated.",
    });
  }
  return blockers.filter((blocker, index, all) =>
    all.findIndex((candidate) =>
      candidate.code === blocker.code && candidate.message === blocker.message
    ) === index
  );
}

async function buildLaunchAgentRoutineResponse(
  userId: string,
  row: LaunchAppRow,
  routineId: string | null,
): Promise<LaunchAgentRoutineResponse> {
  const agent = {
    id: row.id,
    slug: row.slug || row.id,
    name: row.name || row.slug || row.id,
  };
  if (!routineId) {
    return { agent, routine: null, generatedAt: new Date().toISOString() };
  }

  const detail = await getRoutineMonitorDetail(userId, routineId);
  if (!detail) {
    return { agent, routine: null, generatedAt: new Date().toISOString() };
  }
  const stored: StoredRoutine = {
    ...detail.routine,
    capabilities: detail.capabilities,
    dashboard_bindings: detail.dashboard_bindings,
  };
  if (stored.status === "deleted") {
    throw new Error("Deleted routine was returned by the active routine query");
  }
  const blockers = await collectLaunchRoutineBlockers(userId, stored);
  const budgetPolicy = {
    ...DEFAULT_ROUTINE_BUDGET_POLICY,
    ...(stored.budget_policy || {}),
  };
  const autoPauseReason = stored.status === "active"
    ? null
    : routineAutoPauseReason(stored);
  const lastFailedRun = detail.routine.recent_runs.find((run) =>
    run.status === "failed" || run.status === "skipped"
  );
  const errorReason = stored.status === "error"
    ? routineRunErrorCode(lastFailedRun || detail.routine.recent_runs[0]) ||
      autoPauseReason || "routine_error"
    : autoPauseReason;
  const hasPendingCapabilities = detail.capabilities.some((capability) =>
    !capability.approved
  );
  const activationReady = blockers.length === 0;
  const cadence = launchRoutineSchedule(stored);
  const role = launchRoutineRole(stored.metadata) || "routine";
  const routine: LaunchAgentRoutineOverview = {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    role,
    status: stored.status,
    health: detail.routine.health,
    mission: stored.intent || "",
    schedule: cadence.schedule,
    nextOccurrences: cadence.nextOccurrences,
    ...(cadence.schedule.kind === "interval"
      ? { intervalSeconds: cadence.schedule.intervalSeconds }
      : {}),
    budgets: {
      maxLightPerRun: budgetPolicy.max_light_per_run,
      maxLightPerDay: budgetPolicy.max_light_per_day,
      maxLightPerMonth: budgetPolicy.max_light_per_month,
      maxCallsPerRun: budgetPolicy.max_calls_per_run,
    },
    capabilities: detail.capabilities.map((capability) => ({
      id: capability.id,
      appId: capability.app_id,
      appRef: capability.app_ref,
      functionName: capability.function_name,
      access: capability.access,
      required: capability.required,
      purpose: capability.purpose,
      approved: capability.approved,
      approvedAt: capability.approved_at,
    })),
    blockers,
    reportingDestination: {
      kind: "galactic_inbox",
      label: "Galactic inbox",
    },
    nextRunAt: stored.next_run_at,
    lastRunAt: stored.last_run_at,
    lastSuccessAt: stored.last_success_at,
    lastErrorAt: stored.last_error_at,
    failureCount: stored.failure_count,
    autoPauseReason,
    errorReason,
    recentRuns: detail.routine.recent_runs.slice(0, 5).map(toLaunchRoutineRun),
    actions: {
      canApproveCapabilities: hasPendingCapabilities,
      canActivate: (stored.status === "paused" || stored.status === "error") &&
        activationReady,
      canPause: stored.status === "active",
      canRunNow: stored.status === "active" && activationReady,
    },
  };
  return { agent, routine, generatedAt: new Date().toISOString() };
}

async function assembleLaunchAgentRoutinesResponse(
  userId: string,
  row: LaunchAppRow,
  revision: string,
): Promise<LaunchAgentRoutinesResponse> {
  const managed = await fetchManagedRoutineIds(userId, row.id);
  const responses = await Promise.all(
    managed.map((item) =>
      buildLaunchAgentRoutineResponse(userId, row, item.id)
    ),
  );
  const routines = responses.flatMap((response) =>
    response.routine ? [response.routine] : []
  );
  const primaryRoutineId =
    routines.find((routine) => routine.role === "primary")
      ?.id || routines[0]?.id || null;
  const times = routines.flatMap((routine) =>
    routine.nextRunAt ? [routine.nextRunAt] : []
  ).sort();
  const lastRuns = routines.flatMap((routine) =>
    routine.lastRunAt ? [routine.lastRunAt] : []
  )
    .sort().reverse();
  return {
    revision,
    agent: {
      id: row.id,
      slug: row.slug || row.id,
      name: row.name || row.slug || row.id,
    },
    primaryRoutineId,
    routines,
    aggregate: {
      total: routines.length,
      active: routines.filter((routine) => routine.status === "active").length,
      paused: routines.filter((routine) => routine.status === "paused").length,
      failing:
        routines.filter((routine) =>
          routine.status === "error" || routine.health === "error"
        )
          .length,
      running:
        routines.filter((routine) => routine.health === "running").length,
      nextRunAt: times[0] || null,
      lastRunAt: lastRuns[0] || null,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function buildLaunchAgentRoutinesResponse(
  userId: string,
  row: LaunchAppRow,
  enclosingRevision?: string,
): Promise<LaunchAgentRoutinesResponse> {
  if (enclosingRevision) {
    return await assembleLaunchAgentRoutinesResponse(
      userId,
      row,
      enclosingRevision,
    );
  }
  // `revision` is an actionable CAS token, not decorative metadata. Fence the
  // complete collection read so it can never certify a mixed before/after set
  // of sibling routine configurations.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = await getAgentHomeRevision(row.id, userId);
    if (!revision) {
      throw new LaunchServiceUnavailableError(
        "Agent routine revision is unavailable",
      );
    }
    const response = await assembleLaunchAgentRoutinesResponse(
      userId,
      row,
      revision,
    );
    const completedAtRevision = await getAgentHomeRevision(row.id, userId);
    if (completedAtRevision !== revision) continue;
    return response;
  }
  throw new LaunchServiceUnavailableError(
    "Agent routines changed repeatedly while their snapshot was assembled",
  );
}

async function buildStableLaunchAgentRoutineResponse(
  userId: string,
  row: LaunchAppRow,
  routineId: string,
): Promise<LaunchAgentRoutineResponse | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = await getAgentHomeRevision(row.id, userId);
    if (!revision) {
      throw new LaunchServiceUnavailableError(
        "Agent routine revision is unavailable",
      );
    }
    const managed = await fetchManagedRoutineIds(userId, row.id);
    const isManaged = managed.some((candidate) => candidate.id === routineId);
    const response = isManaged
      ? await buildLaunchAgentRoutineResponse(userId, row, routineId)
      : null;
    const completedAtRevision = await getAgentHomeRevision(row.id, userId);
    if (completedAtRevision !== revision) continue;
    return response?.routine ? { ...response, revision } : null;
  }
  throw new LaunchServiceUnavailableError(
    "Agent routine changed repeatedly while its snapshot was assembled",
  );
}

function parseLaunchRoutineBudgets(
  value: unknown,
): LaunchAgentRoutineUpdateRequest["budgets"] {
  const record = asRecord(value);
  if (!record) {
    throw new RequestValidationError("budgets must be an object");
  }
  const unknown = Object.keys(record).filter((key) =>
    !LAUNCH_ROUTINE_BUDGET_KEYS.includes(
      key as typeof LAUNCH_ROUTINE_BUDGET_KEYS[number],
    )
  );
  if (unknown.length > 0) {
    throw new RequestValidationError(
      `Unknown budget fields: ${unknown.join(", ")}`,
    );
  }
  for (const key of LAUNCH_ROUTINE_BUDGET_KEYS) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key])) {
      throw new RequestValidationError(
        `budgets.${key} must be a finite number`,
      );
    }
  }
  const budgets = record as unknown as NonNullable<
    LaunchAgentRoutineUpdateRequest["budgets"]
  >;
  if (
    budgets.maxLightPerRun < 0 ||
    budgets.maxLightPerDay < budgets.maxLightPerRun ||
    budgets.maxLightPerMonth < budgets.maxLightPerDay ||
    !Number.isSafeInteger(budgets.maxCallsPerRun) ||
    budgets.maxCallsPerRun < 1
  ) {
    throw new RequestValidationError(
      "Budget ceilings must be non-negative, calls must be a positive integer, and run ≤ day ≤ month",
    );
  }
  return budgets;
}

function parseLaunchRoutineSchedule(
  body: LaunchAgentRoutineUpdateRequest,
  current: StoredRoutine["schedule"],
): ReturnType<typeof normalizeRoutineSchedule> {
  if (body.intervalSeconds !== undefined && body.schedule !== undefined) {
    throw new RequestValidationError(
      "Provide schedule or the legacy intervalSeconds field, not both",
    );
  }
  const raw = body.schedule !== undefined
    ? (() => {
      const value = asRecord(body.schedule);
      if (!value || (value.kind !== "interval" && value.kind !== "cron")) {
        throw new RequestValidationError(
          "schedule.kind must be interval or cron",
        );
      }
      const unknown = Object.keys(value).filter((key) =>
        value.kind === "interval"
          ? key !== "kind" && key !== "intervalSeconds"
          : key !== "kind" && key !== "expression" && key !== "timezone"
      );
      if (unknown.length > 0) {
        throw new RequestValidationError(
          `Unknown schedule fields: ${unknown.join(", ")}`,
        );
      }
      return value.kind === "interval"
        ? { type: "interval", every_seconds: value.intervalSeconds }
        : {
          type: "cron",
          cron: value.expression,
          ...(value.timezone === undefined ? {} : { timezone: value.timezone }),
        };
    })()
    : body.intervalSeconds !== undefined
    ? { type: "interval", every_seconds: body.intervalSeconds }
    : current;
  try {
    return normalizeRoutineSchedule(raw);
  } catch (err) {
    if (err instanceof RoutineScheduleValidationError) {
      throw new RequestValidationError(err.message);
    }
    throw err;
  }
}

interface PreparedLaunchRoutineMutation {
  name?: string;
  description?: string | null;
  mission?: string | null;
  schedule?: ReturnType<typeof normalizeRoutineSchedule>;
  activeNextRunAt?: string | null;
  budgets?: NonNullable<LaunchAgentRoutineUpdateRequest["budgets"]>;
  budgetPolicy: {
    max_light_per_run: number;
    max_light_per_day: number;
    max_light_per_month: number;
    max_calls_per_run: number;
  };
}

function prepareLaunchRoutineMutation(
  routine: StoredRoutine,
  body: LaunchAgentRoutineUpdateRequest,
): PreparedLaunchRoutineMutation {
  const suppliedKeys = Object.keys(body);
  const unknown = suppliedKeys.filter((key) =>
    key !== "name" && key !== "description" && key !== "mission" &&
    key !== "intervalSeconds" && key !== "schedule" && key !== "budgets"
  );
  if (unknown.length > 0) {
    throw new RequestValidationError(
      `Unknown routine fields: ${unknown.join(", ")}`,
    );
  }
  if (suppliedKeys.length === 0) {
    throw new RequestValidationError(
      "Provide name, description, mission, schedule, or budgets",
    );
  }
  if (
    body.name !== undefined &&
    (typeof body.name !== "string" || !body.name.trim() ||
      body.name.trim().length > 120)
  ) {
    throw new RequestValidationError("name must be 1 to 120 characters");
  }
  if (
    body.description !== undefined && body.description !== null &&
    (typeof body.description !== "string" || body.description.length > 500)
  ) {
    throw new RequestValidationError(
      "description must be null or at most 500 characters",
    );
  }
  if (
    body.mission !== undefined && body.mission !== null &&
    (typeof body.mission !== "string" || body.mission.trim().length > 1_000)
  ) {
    throw new RequestValidationError(
      "mission must be null or at most 1,000 characters",
    );
  }
  const currentBudget = {
    ...DEFAULT_ROUTINE_BUDGET_POLICY,
    ...(routine.budget_policy || {}),
  };
  const budgets = body.budgets === undefined
    ? {
      maxLightPerRun: currentBudget.max_light_per_run,
      maxLightPerDay: currentBudget.max_light_per_day,
      maxLightPerMonth: currentBudget.max_light_per_month,
      maxCallsPerRun: currentBudget.max_calls_per_run,
    }
    : parseLaunchRoutineBudgets(body.budgets)!;
  const schedule = parseLaunchRoutineSchedule(body, routine.schedule);
  const scheduleChanged = body.intervalSeconds !== undefined ||
    body.schedule !== undefined;
  const budgetPolicy = {
    max_light_per_run: budgets.maxLightPerRun,
    max_light_per_day: budgets.maxLightPerDay,
    max_light_per_month: budgets.maxLightPerMonth,
    max_calls_per_run: budgets.maxCallsPerRun,
  };
  const proposed: StoredRoutine = {
    ...routine,
    schedule,
    budget_policy: budgetPolicy,
  };
  const safetyBlockers = validateRoutineActivation(proposed).blockers.filter((
    blocker,
  ) => blocker.code !== "pending_required_capabilities");
  if (safetyBlockers.length > 0) {
    throw new RequestValidationError(
      safetyBlockers.map((item) => item.message).join(" "),
    );
  }
  // Edits must remain available while setup is incomplete so the owner can
  // repair a blocked Agent. Structural schedule/budget invariants are enforced
  // above; the full settings, reporting, grant, and executed-release contract
  // is enforced only at activation/run boundaries.

  return {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.description !== undefined
      ? { description: body.description }
      : {}),
    ...(body.mission !== undefined ? { mission: body.mission } : {}),
    ...(scheduleChanged
      ? {
        schedule,
        activeNextRunAt: routine.status === "active"
          ? previewRoutineRunTimes(schedule, new Date(), 1)[0]?.toISOString() ||
            null
          : null,
      }
      : {}),
    ...(body.budgets !== undefined ? { budgets } : {}),
    budgetPolicy,
  };
}

async function updateLaunchAgentRoutine(
  userId: string,
  routine: StoredRoutine,
  body: LaunchAgentRoutineUpdateRequest,
): Promise<void> {
  const prepared = prepareLaunchRoutineMutation(routine, body);
  await updateRoutine(userId, routine.id, {
    ...(prepared.name !== undefined ? { name: prepared.name } : {}),
    ...(prepared.description !== undefined
      ? { description: prepared.description }
      : {}),
    ...(prepared.mission !== undefined ? { intent: prepared.mission } : {}),
    ...(prepared.schedule
      ? {
        schedule: prepared.schedule,
        next_run_at: routine.status === "active"
          ? prepared.activeNextRunAt ?? null
          : routine.next_run_at,
      }
      : {}),
    ...(prepared.budgets !== undefined
      ? { budget_policy: prepared.budgetPolicy }
      : {}),
  });
}

function launchRoutineFailure(err: unknown): Response | null {
  if (err instanceof RequestValidationError) {
    return error(err.message, err.status);
  }
  if (err instanceof RoutinePlatformError) {
    const status = err.code === ROUTINE_PLATFORM_FORBIDDEN
      ? 403
      : err.code === ROUTINE_PLATFORM_NOT_FOUND
      ? 404
      : 409;
    return json({
      error: err.message,
      blockers: [activationErrorBlocker(err)],
    }, status);
  }
  if (err instanceof Error) {
    const withCode = err as Error & {
      code?: string;
      blockers?: Array<
        { code: string; message: string; capability_ids?: string[] }
      >;
    };
    if (withCode.code === "ROUTINE_ACTIVATION_BLOCKED") {
      return json({
        error: err.message,
        blockers: (withCode.blockers || []).map((blocker) => ({
          code: blocker.code,
          message: blocker.message,
          ...(blocker.capability_ids
            ? { capabilityIds: blocker.capability_ids }
            : {}),
        })),
      }, 409);
    }
    if (
      err.message.startsWith("Capabilities do not belong") ||
      err.message.includes("must be")
    ) {
      return error(err.message, 400);
    }
  }
  return null;
}

async function handleLaunchAgentManagedRoutines(
  request: Request,
  encodedLocator: string,
  method: string,
  encodedRoutineId: string | null,
  actionsRoute: boolean,
): Promise<Response> {
  const allowed = actionsRoute
    ? method === "POST"
    : encodedRoutineId
    ? method === "GET" || method === "PATCH"
    : method === "GET";
  if (!allowed) return error("Method not allowed for Agent routines", 405);
  const user = await requireLaunchUser(request);
  requireAccountSessionForRoutine(user);
  const resolved = await resolveOwnerPrivateRoutineAgent(user, encodedLocator);
  if (resolved instanceof Response) return resolved;
  const row = resolved;
  const managed = await fetchManagedRoutineIds(user.id, row.id);
  if (!encodedRoutineId) {
    return privateLaunchJson(
      await buildLaunchAgentRoutinesResponse(user.id, row),
    );
  }
  const routineId = decodeURIComponent(encodedRoutineId).trim();
  if (
    !isUuid(routineId) ||
    !managed.some((candidate) => candidate.id === routineId)
  ) {
    return error("Managed routine not found for this Agent", 404);
  }
  if (method === "GET") {
    const response = await buildStableLaunchAgentRoutineResponse(
      user.id,
      row,
      routineId,
    );
    return response
      ? privateLaunchJson(response)
      : error("Managed routine not found for this Agent", 404);
  }
  const routine = await getRoutine(user.id, routineId);
  if (!routine) return error("Managed routine not found for this Agent", 404);
  if (!actionsRoute && method === "PATCH") {
    try {
      const raw = asRecord(await readJsonBody<unknown>(request));
      if (!raw) {
        throw new RequestValidationError("Request body must be an object");
      }
      const expectedRevision = requireExpectedAgentHomeRevision(raw, row.id);
      const { expectedRevision: _expected, ...update } =
        raw as unknown as LaunchAgentManagedRoutineUpdateRequest;
      const prepared = prepareLaunchRoutineMutation(routine, update);
      await updateAgentHomeManagedRoutineCAS({
        appId: row.id,
        userId: user.id,
        routineId,
        expectedRevision,
        authSource: user.authSource,
        ...(prepared.name !== undefined ? { name: prepared.name } : {}),
        ...(prepared.description !== undefined
          ? { description: prepared.description }
          : {}),
        ...(prepared.mission !== undefined
          ? { mission: prepared.mission }
          : {}),
        ...(prepared.schedule
          ? {
            schedule: prepared.schedule,
            activeNextRunAt: prepared.activeNextRunAt ?? null,
          }
          : {}),
        ...(prepared.budgets !== undefined
          ? { budgets: prepared.budgets }
          : {}),
      });
      const response = await buildStableLaunchAgentRoutineResponse(
        user.id,
        row,
        routineId,
      );
      return response
        ? privateLaunchJson(response)
        : error("Managed routine not found for this Agent", 404);
    } catch (err) {
      if (
        err instanceof AgentHomeRevisionError &&
        err.code === "AGENT_HOME_REVISION_CONFLICT"
      ) {
        return await launchAgentHomeConflictResponse(user, encodedLocator);
      }
      const failure = launchRoutineFailure(err);
      if (failure) return failure;
      throw err;
    }
  }
  if (actionsRoute) {
    try {
      const body = asRecord(await readJsonBody<unknown>(request));
      if (!body) {
        throw new RequestValidationError("Request body must be an object");
      }
      const actionBody =
        body as unknown as LaunchAgentManagedRoutineActionRequest;
      if (
        ![
          "approve_capabilities",
          "activate",
          "pause",
          "run_now",
        ].includes(actionBody.action)
      ) {
        throw new RequestValidationError(
          "action must be approve_capabilities, activate, pause, or run_now",
        );
      }
      const outcome = await performLaunchAgentHomeAction(
        user,
        row,
        body,
        routineId,
      );
      if (outcome.kind === "pending") {
        return privateLaunchJson({
          error: "An identical managed routine action is already in progress",
          code: "AGENT_HOME_ACTION_IN_PROGRESS",
          status: "pending",
          terminal: false,
          requestId: outcome.requestId,
          replayed: outcome.replayed,
        }, 409);
      }
      if (outcome.kind === "failed") {
        const storedStatus = outcome.response.status;
        const status = typeof storedStatus === "number" &&
            Number.isInteger(storedStatus) && storedStatus >= 400 &&
            storedStatus <= 599
          ? storedStatus
          : 409;
        return privateLaunchJson({
          error: typeof outcome.response.error === "string"
            ? outcome.response.error
            : "Managed routine action failed",
          ...(typeof outcome.response.code === "string"
            ? { code: outcome.response.code }
            : {}),
          status: "failed",
          terminal: true,
          requestId: outcome.requestId,
          replayed: outcome.replayed,
        }, status);
      }
      const response = await buildStableLaunchAgentRoutineResponse(
        user.id,
        row,
        routineId,
      );
      return response
        ? privateLaunchJson(response)
        : error("Managed routine not found for this Agent", 404);
    } catch (err) {
      if (err instanceof LaunchAgentHomeActionStatusUnknownError) {
        return privateLaunchJson({
          error:
            "The action result is still being reconciled. Retry with the same request key.",
          code: "AGENT_HOME_ACTION_STATUS_UNKNOWN",
          status: "unknown",
          terminal: false,
          requestId: err.requestId,
        }, 503);
      }
      if (
        err instanceof AgentHomeStaleMutationError ||
        (err instanceof AgentHomeRevisionError &&
          err.code === "AGENT_HOME_REVISION_CONFLICT")
      ) {
        return await launchAgentHomeConflictResponse(user, encodedLocator);
      }
      if (err instanceof AgentHomeRevisionError) {
        return privateLaunchJson(
          { error: err.message, code: err.code },
          err.status,
        );
      }
      const failure = launchRoutineFailure(err);
      if (failure) return failure;
      throw err;
    }
  }
  return error("Unsupported managed routine mutation", 400);
}

async function handleLaunchAgentRoutine(
  request: Request,
  encodedLocator: string,
  method: string,
  actionsRoute: boolean,
): Promise<Response> {
  if (
    actionsRoute ? method !== "POST" : method !== "GET" && method !== "PATCH"
  ) {
    return error("Method not allowed for persistent Agent routine", 405);
  }
  const user = await requireLaunchUser(request);
  requireAccountSessionForRoutine(user);
  const resolved = await resolveOwnerPrivateRoutineAgent(user, encodedLocator);
  if (resolved instanceof Response) return resolved;
  const row = resolved;
  if (actionsRoute || method === "PATCH") {
    return error(
      "This legacy mutation route is retired. Use the Agent Home CAS/action endpoints; emergency pause is POST /home/pause.",
      410,
    );
  }
  const routineId = await fetchPrimaryRoutineId(user.id, row.id);
  if (!routineId) {
    if (method !== "GET") return error("Agent has no routine proposal", 404);
    return json(await buildLaunchAgentRoutineResponse(user.id, row, null));
  }

  try {
    if (!actionsRoute && method === "PATCH") {
      const routine = await getRoutine(user.id, routineId);
      if (!routine) return error("Agent has no routine proposal", 404);
      const rawBody = await readJsonBody<unknown>(request);
      const body = asRecord(rawBody);
      if (!body) {
        throw new RequestValidationError("Request body must be an object");
      }
      await updateLaunchAgentRoutine(user.id, routine, body);
    } else if (actionsRoute) {
      const rawBody = await readJsonBody<unknown>(request);
      const bodyRecord = asRecord(rawBody);
      if (!bodyRecord) {
        throw new RequestValidationError("Request body must be an object");
      }
      const unknownActionFields = Object.keys(bodyRecord).filter((key) =>
        key !== "action" && key !== "capabilityIds"
      );
      if (unknownActionFields.length > 0) {
        throw new RequestValidationError(
          `Unknown routine action fields: ${unknownActionFields.join(", ")}`,
        );
      }
      const body = bodyRecord as unknown as LaunchAgentRoutineActionRequest;
      const routine = await getRoutine(user.id, routineId);
      if (!routine) return error("Agent has no routine proposal", 404);
      if (body.action === "approve_capabilities") {
        if (
          !Array.isArray(body.capabilityIds) ||
          body.capabilityIds.length === 0 ||
          body.capabilityIds.length > 200
        ) {
          throw new RequestValidationError(
            "capabilityIds must list 1 to 200 exact pending capabilities to approve",
          );
        }
        const capabilityIds = Array.from(new Set(body.capabilityIds));
        if (capabilityIds.some((id) => typeof id !== "string" || !id.trim())) {
          throw new RequestValidationError(
            "capabilityIds must contain non-empty strings",
          );
        }
        const pendingIds = new Set(
          routine.capabilities.filter((capability) => !capability.approved).map(
            (capability) => capability.id,
          ),
        );
        const notPending = capabilityIds.filter((id) => !pendingIds.has(id));
        if (notPending.length > 0) {
          throw new RequestValidationError(
            `Capabilities are no longer pending: ${notPending.join(", ")}`,
            409,
          );
        }
        await approveRoutineCapabilities(user.id, routineId, capabilityIds);
      } else if (body.action === "activate") {
        if (body.capabilityIds !== undefined) {
          throw new RequestValidationError(
            "capabilityIds is valid only for approve_capabilities",
          );
        }
        if (
          routine.status !== "paused" && routine.status !== "error" &&
          routine.status !== "active"
        ) {
          throw new RequestValidationError(
            `Routine is ${routine.status} and cannot be activated`,
            409,
          );
        }
        await validateRoutineLaunchActivation(user.id, routine);
        await resumeRoutine(user.id, routineId);
      } else if (body.action === "pause") {
        if (body.capabilityIds !== undefined) {
          throw new RequestValidationError(
            "capabilityIds is valid only for approve_capabilities",
          );
        }
        if (routine.status === "disabled") {
          throw new RequestValidationError(
            "A disabled routine cannot be changed through the launch lifecycle",
            409,
          );
        }
        await pauseRoutine(user.id, routineId);
      } else if (body.action === "run_now") {
        if (body.capabilityIds !== undefined) {
          throw new RequestValidationError(
            "capabilityIds is valid only for approve_capabilities",
          );
        }
        if (routine.status !== "active") {
          throw new RequestValidationError(
            `Routine is ${routine.status}; activate it before running manually`,
            409,
          );
        }
        const blockers = await collectLaunchRoutineBlockers(user.id, routine);
        if (blockers.length > 0) {
          return json({
            error:
              "Routine cannot run until its launch-safety blockers are resolved",
            blockers,
          }, 409);
        }
        await queueRoutineMonitorRun(user.id, routineId);
      } else {
        throw new RequestValidationError(
          "action must be approve_capabilities, activate, pause, or run_now",
        );
      }
    }
  } catch (err) {
    const response = launchRoutineFailure(err);
    if (response) return response;
    throw err;
  }

  return json(await buildLaunchAgentRoutineResponse(user.id, row, routineId));
}

async function handleLaunchTool(
  request: Request,
  encodedLocator: string,
): Promise<Response> {
  const resolved = await resolveLaunchVisibleTool(request, encodedLocator);
  if (!resolved) return error("Agent not found", 404);
  const { installedIds, row, viewer } = resolved;

  const owners = await fetchOwnerMap([row.owner_id]);
  const tool = toLaunchAgentSummary(row, {
    owners,
    viewerId: viewer?.id,
    installedIds,
    includeInterfaces: true,
  });

  return json({
    agent: tool,
    // Deprecated alias kept for one rename window.
    tool,
    trustCard: await buildLaunchTrustCard(row),
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchToolFunctions(
  request: Request,
  encodedLocator: string,
): Promise<Response> {
  const viewer = await tryAuthenticate(request);
  const resolved = viewer
    ? await resolveLaunchRunnableTool(viewer, encodedLocator)
    : await resolvePublicLaunchTool(encodedLocator);
  if (!resolved) return error("Agent not found", 404);
  const { row, installedIds } = resolved;

  const owners = await fetchOwnerMap([row.owner_id]);
  const tool = toLaunchAgentSummary(row, {
    owners,
    viewerId: viewer?.id,
    installedIds,
  });
  const functions = await buildLaunchFunctionSummaries(row, viewer?.id);

  const handle = toLaunchToolHandle(tool);
  return json(
    {
      agent: handle,
      // Deprecated alias kept for one rename window.
      tool: handle,
      functions,
      generatedAt: new Date().toISOString(),
    } satisfies LaunchAgentFunctionsResponse,
  );
}

async function handleLaunchFunctionRun(
  request: Request,
  encodedLocator: string,
  encodedFunctionName: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForFunctionRun(user);
  const resolved = await resolveLaunchRunnableTool(user, encodedLocator);
  if (!resolved) return error("Agent not found", 404);
  const { row } = resolved;
  const functionName = parseFunctionName(encodedFunctionName);
  const functionNames = new Set(extractFunctionNames(row));
  if (!functionNames.has(functionName)) return error("Function not found", 404);

  const body = await readOptionalJsonBody<LaunchFunctionRunRequest>(request);
  const args = asRecord(body.args) || {};
  const runRequest = new Request(
    `${new URL(request.url).origin}/api/run/${encodeURIComponent(row.id)}`,
    {
      method: "POST",
      headers: forwardRuntimeHeaders(request),
      body: JSON.stringify({
        function: functionName,
        args,
      }),
    },
  );
  const runResponse = await handleRun(runRequest, row.id);
  const runPayload = await runResponse.json().catch(() => null) as
    | RunResponse
    | null;
  const tool = {
    id: row.id,
    slug: row.slug || row.id,
    name: row.name || row.slug || row.id,
  };

  if (!runResponse.ok || !runPayload?.success) {
    return json(
      {
        success: false,
        agent: tool,
        tool,
        functionName,
        receiptId: runPayload?.receipt_id || null,
        warnings: [],
        error: {
          type: runPayload?.error?.type,
          message: runPayload?.error?.message ||
            `Function run failed (${runResponse.status})`,
          details: runPayload?.error?.details,
        },
        generatedAt: new Date().toISOString(),
      } satisfies LaunchFunctionRunResponse,
      runResponse.ok ? 500 : runResponse.status,
    );
  }

  return json(
    {
      success: true,
      agent: tool,
      tool,
      functionName,
      result: runPayload.result,
      receiptId: runPayload.receipt_id || null,
      warnings: [],
      error: null,
      generatedAt: new Date().toISOString(),
    } satisfies LaunchFunctionRunResponse,
  );
}

async function handleLaunchToolAdmin(
  request: Request,
  encodedLocator: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  const locator = parseLocator(encodedLocator);
  const row = await fetchToolByLocator(locator, { ownerId: user.id });
  if (!row) return error("Agent not found", 404);

  const owners = await fetchOwnerMap([row.owner_id]);
  const tool = toLaunchAgentSummary(row, {
    owners,
    viewerId: user.id,
    installedIds: new Set<string>(),
  });
  // The owner's referral link: customers who arrive through it are permanently
  // attributed to the publisher (platform fees waived on their usage). Lazily
  // created on first view; degrade to null rather than failing the admin page.
  let referral: LaunchAgentAdminSummary["referral"] = null;
  try {
    const link = await getOrCreatePublisherReferralLink(row.id, user.id);
    referral = { url: link.url, slug: link.slug, status: link.status };
  } catch (err) {
    console.warn("[LAUNCH] Failed to load owner referral link:", err);
  }

  const admin: LaunchAgentAdminSummary = {
    agent: tool,
    // Deprecated alias kept for one rename window.
    tool,
    editableFields: [
      "name",
      "description",
      "visibility",
      "pricing",
      "secrets",
      "trust",
    ],
    receiptsUrl: `/admin/agents/${encodeURIComponent(row.id)}?tab=receipts`,
    logsUrl: `/admin/agents/${encodeURIComponent(row.id)}?tab=logs`,
    referral,
  };

  return json({
    admin,
    trustCard: await buildLaunchTrustCard(row),
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchToolAgentPermissions(
  request: Request,
  encodedLocator: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForAgentPermissions(user);
  const resolved = await resolveAgentPermissionTool(user, encodedLocator);
  if (!resolved) return error("Agent not found", 404);

  return json(
    await buildLaunchCallerPermissionsResponse(
      user,
      resolved.row,
      resolved.installedIds,
    ),
  );
}

async function handleLaunchToolAgentPermissionsUpdate(
  request: Request,
  encodedLocator: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForAgentPermissions(user);
  const resolved = await resolveAgentPermissionTool(user, encodedLocator);
  if (!resolved) return error("Agent not found", 404);

  const body = asRecord(await readJsonBody<unknown>(request));
  if (!body) {
    throw new RequestValidationError("Invalid agent permissions request");
  }
  const functionNames = extractFunctionNames(resolved.row);
  await updateCallerFunctionPermissions({
    userId: user.id,
    appId: resolved.row.id,
    defaultPolicy: body.defaultPolicy ?? body.default_policy,
    defaultHealthGate: body.defaultHealthGate ?? body.default_health_gate,
    permissions: body.permissions as
      | LaunchCallerFunctionPermissionsUpdateRequest["permissions"]
      | undefined,
    allowedFunctionNames: functionNames,
  });

  return json(
    await buildLaunchCallerPermissionsResponse(
      user,
      resolved.row,
      resolved.installedIds,
    ),
  );
}

// Per-(installer, app, function) galactic.ai() provider+model override.
// GET lists overrides; PUT sets one (provider 'galactic'/'light' => credits, else
// a configured BYOK provider); DELETE clears one (?functionName=).
// GET/PUT /api/launch/agents/:id/settings — the viewing user's own per-user
// secrets/config for this Agent. Mirrors /api/apps/:appId/settings but on the
// launch auth surface. READ returns key names + connected status ONLY (never a
// value); WRITE encrypts straight into the vault (user_app_secrets).
async function handleLaunchAgentSettings(
  request: Request,
  encodedLocator: string,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  if (method === "PUT" || method === "POST") {
    requireAccountSessionForAgentHome(user);
  }
  const resolved = await resolveAgentPermissionTool(user, encodedLocator);
  if (!resolved) return error("Agent not found", 404);
  const row = resolved.row;
  const appId = row.id;

  const isOwner = row.owner_id === user.id;
  if (!isOwner && !resolved.installedIds.has(appId)) {
    return error("Install this agent to configure your settings", 403);
  }

  const schema = resolveAppEnvSchema(row as never);
  if (getScopedEnvSchemaEntries(schema, "per_user").length === 0) {
    return error("This agent has no per-user settings", 400);
  }

  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
    "Content-Type": "application/json",
  };
  const secretsUrl =
    `${supabaseUrl}/rest/v1/user_app_secrets?user_id=eq.${user.id}&app_id=eq.${appId}&select=key,updated_at`;

  const loadStatus = async () => {
    const res = await fetch(secretsUrl, { headers });
    const rows = res.ok ? await res.json() as UserAppSecretStatusRow[] : [];
    return buildPerUserSettingsStatus(schema, rows);
  };

  if (method === "GET") {
    const status = await loadStatus();
    return json({
      app_id: appId,
      settings: status.settings,
      connected_keys: status.connectedKeys,
      missing_required: status.missingRequired,
      fully_connected: status.fullyConnected,
    });
  }

  if (method === "PUT" || method === "POST") {
    const body = asRecord(await readJsonBody<unknown>(request)) || {};
    const values = body.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      return error("values object is required", 400);
    }
    const validation = validatePerUserSettingsValues(
      schema,
      values as Record<string, unknown>,
    );
    if (validation.errors.length > 0) {
      return json({ success: false, errors: validation.errors }, 400);
    }
    if (validation.entries.length === 0) {
      return error("Provide at least one setting to update", 400);
    }

    const updatedAt = new Date().toISOString();
    const keysSaved: string[] = [];
    const keysRemoved: string[] = [];
    for (const [key, value] of validation.entries) {
      if (value === null) {
        const del = await fetch(
          `${supabaseUrl}/rest/v1/user_app_secrets?user_id=eq.${user.id}&app_id=eq.${appId}&key=eq.${
            encodeURIComponent(key)
          }`,
          { method: "DELETE", headers },
        );
        if (!del.ok) return error(`Failed to clear setting "${key}"`, 500);
        keysRemoved.push(key);
        continue;
      }
      const encrypted = await encryptEnvVar(value);
      const up = await fetch(`${supabaseUrl}/rest/v1/user_app_secrets`, {
        method: "POST",
        headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify({
          user_id: user.id,
          app_id: appId,
          key,
          value_encrypted: encrypted,
          updated_at: updatedAt,
        }),
      });
      if (!up.ok) return error(`Failed to save setting "${key}"`, 500);
      keysSaved.push(key);
    }

    const status = await loadStatus();
    return json({
      success: true,
      keys_saved: keysSaved,
      keys_removed: keysRemoved,
      connected_keys: status.connectedKeys,
      missing_required: status.missingRequired,
      fully_connected: status.fullyConnected,
    });
  }

  return error("Method not allowed", 405);
}

async function handleLaunchFunctionInferenceOverride(
  request: Request,
  encodedLocator: string,
  method: string,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForByok(user);
  const resolved = await resolveAgentPermissionTool(user, encodedLocator);
  if (!resolved) return error("Agent not found", 404);
  const appId = resolved.row.id;
  const functionNames = extractFunctionNames(resolved.row);

  if (method === "PUT" || method === "POST") {
    const body = asRecord(await readJsonBody<unknown>(request)) || {};
    const functionName = typeof body.functionName === "string"
      ? body.functionName.trim()
      : typeof body.function_name === "string"
      ? (body.function_name as string).trim()
      : "";
    if (!functionName) return error("functionName is required", 400);
    // Throws RequestValidationError(400) on bad slug format (top-level catch).
    const model = normalizeLaunchByokModel(body.model);
    if (!model) return error("model is required", 400);

    const providerRaw = typeof body.provider === "string"
      ? body.provider.trim()
      : "";
    const providerKind = providerRaw.toLowerCase();
    if (
      providerRaw === "" || providerKind === "galactic" ||
      providerKind === "light"
    ) {
      return error(
        "Galactic AI is not available in the launch plan. Choose a configured BYOK provider.",
        400,
      );
    } else {
      const entry = resolveLaunchByokProvider(providerRaw);
      if (!entry) {
        return error(
          "Unsupported provider. Choose a configured BYOK provider.",
          400,
        );
      }
      const profile = await userService.getUser(user.id);
      const configured = profile?.byok_configs.some(
        (config) => config.provider === entry.provider && config.has_key,
      );
      if (!configured) {
        return error(
          `${entry.info.name} is not configured for this account`,
          409,
        );
      }
      await setFunctionInferenceOverride({
        userId: user.id,
        appId,
        functionName,
        billingMode: "byok",
        provider: entry.provider,
        model,
        allowedFunctionNames: functionNames,
      });
    }
    return json(
      await buildLaunchFunctionInferenceResponse(
        user,
        resolved.row,
        resolved.installedIds,
      ),
    );
  }

  if (method === "DELETE") {
    const functionName =
      new URL(request.url).searchParams.get("functionName")?.trim() || "";
    if (!functionName) {
      return error("functionName query parameter is required", 400);
    }
    await clearFunctionInferenceOverride({
      userId: user.id,
      appId,
      functionName,
    });
    return json(
      await buildLaunchFunctionInferenceResponse(
        user,
        resolved.row,
        resolved.installedIds,
      ),
    );
  }

  if (method === "GET") {
    return json(
      await buildLaunchFunctionInferenceResponse(
        user,
        resolved.row,
        resolved.installedIds,
      ),
    );
  }

  return error("Method not allowed for function inference override", 405);
}

async function buildLaunchFunctionInferenceResponse(
  user: AuthUser,
  row: LaunchAppRow,
  installedIds: Set<string>,
): Promise<LaunchFunctionInferenceResponse> {
  const owners = await fetchOwnerMap([row.owner_id]);
  const tool = toLaunchAgentSummary(row, {
    owners,
    viewerId: user.id,
    installedIds,
  });
  const handle = {
    id: tool.id,
    slug: tool.slug,
    name: tool.name,
    relationship: tool.relationship,
    publicUrl: tool.publicUrl,
    adminUrl: tool.adminUrl,
  };
  const overrides = (await listFunctionInferenceOverrides({
    userId: user.id,
    appId: row.id,
    functionNames: extractFunctionNames(row),
  })).filter((override) => override.billingMode === "byok" && override.provider)
    .map((override) => ({
      ...override,
      billingMode: "byok" as const,
      provider: override.provider!,
    }));
  return {
    agent: handle,
    tool: handle,
    overrides,
    generatedAt: new Date().toISOString(),
  };
}

async function handleLaunchWallet(request: Request): Promise<Response> {
  const user = await requireLaunchUser(request);
  const db = getDbConfig();
  const [rows, transactions, receipts, earnings, payouts, billingConfig] =
    await Promise.all([
      dbGet<WalletRow>(
        db,
        "users",
        {
          id: `eq.${user.id}`,
          select: USER_BALANCE_SELECT,
          limit: "1",
        },
      ),
      fetchWalletTransactions(user.id),
      fetchWalletReceipts(user.id),
      fetchWalletEarnings(user.id),
      fetchWalletPayouts(user.id),
      getBillingConfig(),
    ]);
  const row = rows[0] || {
    balance_light: 0,
    deposit_balance_light: 0,
    earned_balance_light: 0,
    escrow_light: 0,
  };
  const balance = numeric(row.balance_light);
  const wallet: LaunchWalletSummary = {
    balance: money(balance),
    spendableBalance: money(balance),
    depositBalance: money(numeric(row.deposit_balance_light)),
    earnedBalance: money(numeric(row.earned_balance_light)),
    escrowBalance: money(numeric(row.escrow_light)),
    // Only surface Free Mode when the platform actually enforces it, so the UI
    // never claims a no-spend mode that isn't in effect (docs/FREE_MODE_DESIGN.md).
    freeMode: isFreeModeEnabled() && balance < FREE_MODE_BALANCE_LIGHT,
    canTopUp: true,
    // Public values so the top-up modal can mount the Payment Element + Link
    // wallet immediately (deferred-intent flow) without creating a PaymentIntent.
    stripePublishableKey: getEnv("STRIPE_PUBLISHABLE_KEY") || undefined,
    buyerEmail: user.email || undefined,
    publishRequirement: {
      enabled: billingConfig.publishDepositEnabled,
      requiredBalance: money(billingConfig.publisherMinPublishBalanceLight),
      currentBalance: money(balance),
      met: !billingConfig.publishDepositEnabled ||
        balance >= billingConfig.publisherMinPublishBalanceLight,
      nextAction: billingConfig.publishDepositEnabled &&
          balance < billingConfig.publisherMinPublishBalanceLight
        ? "Add credits from Wallet to go live."
        : null,
    },
    topUpUrl: "/wallet?tab=topup",
    transactionsUrl: "/wallet?tab=transactions",
    receiptsUrl: "/wallet?tab=receipts",
    earningsUrl: "/wallet?tab=earnings",
    payoutsUrl: "/wallet?tab=payouts",
    payoutStatus: payoutStatusFor(row),
    actions: [
      {
        id: "topup",
        label: "Add credits",
        description: "Fund Agent calls, installs, and hosting.",
        href: "/wallet?tab=topup",
        enabled: true,
      },
      {
        id: "transactions",
        label: "Transactions",
        description: "Review credit movements from wallet funding and charges.",
        href: "/wallet?tab=transactions",
        enabled: true,
      },
      {
        id: "receipts",
        label: "Receipts",
        description:
          "Inspect Agent-call receipts with app, infra, and fee economics.",
        href: "/wallet?tab=receipts",
        enabled: true,
      },
      {
        id: "earnings",
        label: "Earnings",
        description: "Track creator credits earned from monetized Agent usage.",
        href: "/wallet?tab=earnings",
        enabled: true,
      },
      {
        id: "payouts",
        label: "Payouts",
        description:
          "Review Stripe Connect payout readiness and recent payouts.",
        href: "/wallet?tab=payouts",
        enabled: true,
      },
    ],
    recentTransactions: transactions,
    recentReceipts: receipts,
    recentEarnings: earnings,
    recentPayouts: payouts,
  };

  return json({
    wallet,
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchWalletDetail(
  request: Request,
  url: URL,
  kind: LaunchWalletDetailKind,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  const pageRequest = parseWalletPageRequest(url, kind);

  switch (kind) {
    case "transactions": {
      const result = await fetchWalletTransactionsPage(user.id, pageRequest);
      return json(
        {
          kind: "transactions",
          items: result.items,
          page: result.page,
          generatedAt: new Date().toISOString(),
        } satisfies LaunchWalletDetailResponse,
      );
    }
    case "receipts": {
      const result = await fetchWalletReceiptsPage(user.id, pageRequest);
      return json(
        {
          kind: "receipts",
          items: result.items,
          page: result.page,
          generatedAt: new Date().toISOString(),
        } satisfies LaunchWalletDetailResponse,
      );
    }
    case "earnings": {
      const result = await fetchWalletEarningsPage(user.id, pageRequest);
      return json(
        {
          kind: "earnings",
          items: result.items,
          page: result.page,
          generatedAt: new Date().toISOString(),
        } satisfies LaunchWalletDetailResponse,
      );
    }
    case "payouts": {
      const result = await fetchWalletPayoutsPage(user.id, pageRequest);
      return json(
        {
          kind: "payouts",
          items: result.items,
          page: result.page,
          generatedAt: new Date().toISOString(),
        } satisfies LaunchWalletDetailResponse,
      );
    }
    default:
      return error("Wallet detail kind not found", 404);
  }
}

async function handleLaunchWalletTopUpQuote(
  request: Request,
  url: URL,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForWalletFunding(user);
  const amountCredits = normalizeLaunchFundingAmountLight(
    Number(
      url.searchParams.get("amount_credits") ||
        url.searchParams.get("amountCredits") ||
        url.searchParams.get("amount_light") ||
        url.searchParams.get("amountLight") || 2500,
    ),
  );
  const method = normalizeLaunchFundingMethod(
    url.searchParams.get("method") || "card",
  );
  return json({
    quote: withLaunchFundingCreditsAliases(
      quoteLaunchWalletFunding({ amountLight: amountCredits, method }),
    ),
    presets: LAUNCH_WALLET_FUNDING_PRESETS,
    generatedAt: new Date().toISOString(),
  });
}

async function handleLaunchWalletTopUpIntent(
  request: Request,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForWalletFunding(user);
  const createRequest = parseLaunchWalletFundingIntentRequest(
    await readJsonBody<Record<string, unknown>>(request),
  );
  const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) {
    return error("Stripe wallet funding is not configured yet.", 503);
  }

  try {
    const { stripeCustomerId, email } = await getOrCreateStripeCustomerForUser(
      user.id,
      stripeSecretKey,
    );
    // Billing address is OPTIONAL for card/Link wallet funding. Stripe collects
    // it at payment time (full address via Link, AVS for card) and it lands on
    // the resulting charge's billing_details — available for downstream sales-tax
    // use — so a missing on-file address must not block the intent. If one is
    // provided or already on file we still use and sync it. (Wire funding, which
    // calls ensureBillingAddressForFunding elsewhere, keeps requiring it.)
    let billingProfile:
      | Awaited<ReturnType<typeof ensureBillingAddressForFunding>>
      | null = null;
    try {
      billingProfile = await ensureBillingAddressForFunding({
        userId: user.id,
        billingAddress: createRequest.billingAddress,
        source: "wallet_funding",
        stripeSecretKey,
        stripeCustomerId,
      });
    } catch (billingErr) {
      if (
        billingErr instanceof RequestValidationError &&
        billingErr.message === "billing_address is required before adding Light"
      ) {
        billingProfile = null;
      } else {
        throw billingErr;
      }
    }
    const intent = await createLaunchWalletPaymentIntent({
      userId: user.id,
      stripeCustomerId,
      email,
      amountLight: createRequest.amountCredits,
      method: createRequest.method,
      termsAccepted: true,
      billingAddressId: billingProfile?.id,
      billingAddressVersion: billingProfile?.version,
    });

    return json({
      success: true,
      publishableKey: intent.publishableKey,
      paymentIntentId: intent.paymentIntentId,
      clientSecret: intent.clientSecret,
      stripeCustomerId: intent.stripeCustomerId,
      // Returned so the client can pre-fill the PaymentElement, which lets Stripe
      // Link recognize the returning user and show the one-tap flow.
      email,
      quote: withLaunchFundingCreditsAliases(intent.quote),
      billingAddress: billingProfile
        ? publicBillingAddress(billingProfile)
        : null,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    if (err instanceof LaunchWalletFundingError) {
      return error(err.message, err.status);
    }
    console.error("[LAUNCH] Wallet top-up intent failed:", err);
    return error(
      err instanceof Error ? err.message : "Wallet top-up failed",
      500,
    );
  }
}

// Best-effort cleanup of an abandoned/superseded wallet PaymentIntent. The
// checkout auto-prepares on modal open and re-prepares when the amount changes,
// so buyers leave behind uncaptured intents (+ pending deposit rows). The
// client calls this on amount-change and on close to cancel the stale intent.
// Never throws to the client — failed cleanup must not surface in the funding
// UI, and an abandoned intent never charges (Stripe also auto-expires it).
async function handleLaunchWalletTopUpCancel(
  request: Request,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  try {
    const body = asRecord(await readJsonBody<unknown>(request)) || {};
    const paymentIntentId = typeof body.payment_intent_id === "string"
      ? body.payment_intent_id.trim()
      : "";
    if (!paymentIntentId.startsWith("pi_")) {
      return json({ ok: false, reason: "invalid_payment_intent_id" });
    }
    const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return json({ ok: true, reason: "stripe_unconfigured" });
    }

    // Verify ownership via the intent metadata (stamped at creation) before
    // touching it, so a caller can't cancel another account's intent.
    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${
        encodeURIComponent(paymentIntentId)
      }`,
      { headers: { "Authorization": `Bearer ${stripeSecretKey}` } },
    );
    if (!piRes.ok) return json({ ok: true, reason: "not_found" });
    const pi = await piRes.json() as {
      id: string;
      status?: string;
      metadata?: Record<string, string>;
    };
    if (pi.metadata?.user_id !== user.id) {
      return error("Payment intent does not belong to this account", 403);
    }
    // Scope strictly to wallet top-up intents — never touch another funding
    // flow's intent even if it carries this user's id.
    if (pi.metadata?.type !== LAUNCH_WALLET_DEPOSIT_TYPE) {
      return json({ ok: true, reason: "not_topup" });
    }

    // Only cancel intents that have not progressed toward a charge — never
    // touch one that is confirming/processing/succeeded.
    const cancelable = pi.status === "requires_payment_method" ||
      pi.status === "requires_confirmation";
    if (cancelable) {
      await fetch(
        `https://api.stripe.com/v1/payment_intents/${
          encodeURIComponent(paymentIntentId)
        }/cancel`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${stripeSecretKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ cancellation_reason: "abandoned" })
            .toString(),
        },
      );
      // Only clear the pending row when we actually cancelled — never mark a row
      // failed for an intent that has progressed to (or toward) a charge; the
      // webhook finalizer owns those.
      await markLightDepositFailed({
        userId: user.id,
        stripeEventId: `client_cancel:${paymentIntentId}`,
        stripePaymentIntentId: paymentIntentId,
        fundingMethod: pi.metadata?.funding_method || "launch_card_gross_up",
        failureCode: "abandoned",
        failureMessage: "Top-up checkout abandoned or amount changed.",
      }).catch(() => null);
    }

    return json({ ok: true, canceled: cancelable });
  } catch (err) {
    console.error("[LAUNCH] Wallet top-up cancel failed:", err);
    return json({ ok: false });
  }
}

// Update an existing top-up PaymentIntent's amount in place (instead of
// creating a new one) when the buyer changes the dollar amount. This keeps the
// same clientSecret, so the mounted Payment Element + Link wallet stay put
// rather than reloading on every amount change. Only valid while the intent is
// still collecting a payment method.
async function handleLaunchWalletTopUpUpdateAmount(
  request: Request,
): Promise<Response> {
  const user = await requireLaunchUser(request);
  requireAccountSessionForWalletFunding(user);
  try {
    const body = asRecord(await readJsonBody<unknown>(request)) || {};
    const paymentIntentId = typeof body.payment_intent_id === "string"
      ? body.payment_intent_id.trim()
      : "";
    if (!paymentIntentId.startsWith("pi_")) {
      return error("A valid payment_intent_id is required", 400);
    }
    const amountCredits = normalizeLaunchFundingAmountLight(
      body.amount_credits ?? body.amountCredits,
    );
    const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      return error("Stripe wallet funding is not configured yet.", 503);
    }

    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${
        encodeURIComponent(paymentIntentId)
      }`,
      { headers: { "Authorization": `Bearer ${stripeSecretKey}` } },
    );
    if (!piRes.ok) return error("Payment intent not found", 404);
    const pi = await piRes.json() as {
      status?: string;
      customer?: string | null;
      metadata?: Record<string, string>;
    };
    if (
      pi.metadata?.user_id !== user.id ||
      pi.metadata?.type !== LAUNCH_WALLET_DEPOSIT_TYPE
    ) {
      return error("Payment intent does not belong to this account", 403);
    }
    // Once the intent is confirming/charged it can't be re-priced; the client
    // falls back to creating a fresh intent.
    if (
      pi.status !== "requires_payment_method" &&
      pi.status !== "requires_confirmation"
    ) {
      return error("Payment intent can no longer be updated", 409);
    }

    const quote = quoteLaunchWalletFunding({
      amountLight: amountCredits,
      method: "card",
    });

    const params = new URLSearchParams({
      amount: String(quote.totalAmountCents),
      "metadata[amount_cents]": String(quote.totalAmountCents),
      "metadata[base_amount_cents]": String(quote.baseAmountCents),
      "metadata[processing_fee_cents]": String(quote.processingFeeCents),
      "metadata[light_amount]": String(quote.amountLight),
    });
    const updRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${
        encodeURIComponent(paymentIntentId)
      }`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
    );
    if (!updRes.ok) {
      console.error(
        "[LAUNCH] Wallet top-up amount update failed:",
        await updRes.text(),
      );
      return error("Couldn't update the amount. Please try again.", 502);
    }

    // Re-price the pending deposit row IN PLACE. recordPendingLightDeposit's
    // upsert COALESCEs requested_amount_cents (existing-wins), so it would NOT
    // change it on a re-price — leaving a stale requested amount that makes the
    // webhook finalizer mislabel a fully-paid lower amount as
    // "partially_succeeded". PATCH the pending row directly so the requested
    // amount matches what will actually be charged. Best-effort; never blocks
    // the response (the PI metadata.light_amount, updated above, is what
    // actually drives the credited amount).
    try {
      const { SUPABASE_URL: sbUrl, SUPABASE_SERVICE_ROLE_KEY: sbKey } =
        getSupabaseEnv();
      const patchRes = await fetch(
        `${sbUrl}/rest/v1/light_deposits?stripe_payment_intent_id=eq.${
          encodeURIComponent(paymentIntentId)
        }&status=eq.pending`,
        {
          method: "PATCH",
          headers: {
            "apikey": sbKey,
            "Authorization": `Bearer ${sbKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({
            requested_amount_cents: quote.totalAmountCents,
            requested_light: quote.amountLight,
          }),
        },
      );
      // Surface a silent failure: if this PATCH doesn't land, the pending row
      // keeps its stale requested amount and the finalizer can mislabel a
      // lowered-amount deposit as partially_succeeded.
      if (!patchRes.ok) {
        console.error(
          "[LAUNCH] Re-price pending deposit PATCH failed:",
          patchRes.status,
          await patchRes.text().catch(() => ""),
        );
      }
    } catch (patchErr) {
      console.error(
        "[LAUNCH] Failed to re-price pending deposit row:",
        patchErr,
      );
    }

    return json({
      success: true,
      quote: withLaunchFundingCreditsAliases(quote),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error("[LAUNCH] Wallet top-up amount update error:", err);
    return error("Couldn't update the amount", 500);
  }
}

function payoutStatusFor(row: WalletRow): LaunchPayoutStatus {
  if (row.stripe_connect_payouts_enabled === true) {
    return {
      kind: "ready",
      label: "Payouts ready",
      description: "Stripe Connect payouts are enabled for creator earnings.",
      actionUrl: "/wallet?tab=payouts",
    };
  }
  if (row.stripe_connect_account_id || row.stripe_connect_onboarded) {
    return {
      kind: "onboarding",
      label: "Payout setup incomplete",
      description: "Complete Stripe onboarding before requesting bank payouts.",
      actionUrl: "/wallet?tab=payouts",
    };
  }
  return {
    kind: "not_connected",
    label: "Payouts not connected",
    description:
      "Creator earnings can accrue as credits before a payout account is connected.",
    actionUrl: "/wallet?tab=payouts",
  };
}

async function fetchWalletTransactions(
  userId: string,
): Promise<LaunchWalletTransaction[]> {
  return (await fetchWalletTransactionsPage(userId, { limit: 10 })).items;
}

async function fetchWalletTransactionsPage(
  userId: string,
  pageRequest: ParsedWalletPageRequest,
): Promise<WalletPageResult<LaunchWalletTransaction>> {
  try {
    const params: Record<string, string> = {
      user_id: `eq.${userId}`,
      select:
        "id,type,category,description,amount_light,balance_after_light,app_id,app_name,created_at",
      order: "created_at.desc",
      limit: String(pageRequest.limit + 1),
    };
    if (pageRequest.cursor) params.created_at = `lt.${pageRequest.cursor}`;
    const rows = await dbGet<BillingTransactionRow>(
      getDbConfig(),
      "billing_transactions",
      params,
    );
    return pageWalletItems(
      rows.map((row) => toLaunchWalletTransaction(row)),
      pageRequest.limit,
    );
  } catch (err) {
    console.warn("[LAUNCH] Wallet transactions unavailable:", err);
    return emptyWalletPage(pageRequest.limit);
  }
}

async function fetchWalletReceipts(
  userId: string,
): Promise<LaunchWalletReceiptSummary[]> {
  return (await fetchWalletReceiptsPage(userId, { limit: 10 })).items;
}

async function fetchWalletReceiptsPage(
  userId: string,
  pageRequest: ParsedWalletPageRequest,
): Promise<WalletPageResult<LaunchWalletReceiptSummary>> {
  try {
    const rows = await getRecentCalls(userId, {
      limit: pageRequest.limit + 1,
      before: pageRequest.cursor,
      appId: pageRequest.tool,
    });
    return pageWalletItems(
      rows.map((row) => toLaunchWalletReceipt(row)),
      pageRequest.limit,
    );
  } catch (err) {
    console.warn("[LAUNCH] Wallet receipts unavailable:", err);
    return emptyWalletPage(pageRequest.limit);
  }
}

async function fetchWalletEarnings(
  userId: string,
): Promise<LaunchWalletEarningSummary[]> {
  return (await fetchWalletEarningsPage(userId, { limit: 10 })).items;
}

async function fetchWalletEarningsPage(
  userId: string,
  pageRequest: ParsedWalletPageRequest,
): Promise<WalletPageResult<LaunchWalletEarningSummary>> {
  try {
    const params: Record<string, string> = {
      to_user_id: `eq.${userId}`,
      select: "amount_light,app_id,function_name,reason,created_at",
      reason: "not.in.(withdrawal,withdrawal_refund)",
      order: "created_at.desc",
      limit: String(pageRequest.limit + 1),
    };
    if (pageRequest.cursor) params.created_at = `lt.${pageRequest.cursor}`;
    if (pageRequest.tool) params.app_id = `eq.${pageRequest.tool}`;
    const rows = await dbGet<TransferRow>(
      getDbConfig(),
      "transfers",
      params,
    );
    return pageWalletItems(
      rows.map((row) => toLaunchWalletEarning(row)),
      pageRequest.limit,
    );
  } catch (err) {
    console.warn("[LAUNCH] Wallet earnings unavailable:", err);
    return emptyWalletPage(pageRequest.limit);
  }
}

async function fetchWalletPayouts(
  userId: string,
): Promise<LaunchWalletPayoutSummary[]> {
  return (await fetchWalletPayoutsPage(userId, { limit: 10 })).items;
}

async function fetchWalletPayoutsPage(
  userId: string,
  pageRequest: ParsedWalletPageRequest,
): Promise<WalletPageResult<LaunchWalletPayoutSummary>> {
  try {
    const params: Record<string, string> = {
      user_id: `eq.${userId}`,
      select: "id,amount_light,status,created_at,completed_at",
      order: "created_at.desc",
      limit: String(pageRequest.limit + 1),
    };
    if (pageRequest.cursor) params.created_at = `lt.${pageRequest.cursor}`;
    const rows = await dbGet<PayoutRow>(
      getDbConfig(),
      "payouts",
      params,
    );
    return pageWalletItems(
      rows.map((row) => toLaunchWalletPayout(row)),
      pageRequest.limit,
    );
  } catch (err) {
    console.warn("[LAUNCH] Wallet payouts unavailable:", err);
    return emptyWalletPage(pageRequest.limit);
  }
}

function parseWalletPageRequest(
  url: URL,
  kind: LaunchWalletDetailKind,
): ParsedWalletPageRequest {
  const limit = parseWalletPageLimit(url.searchParams.get("limit"));
  const cursor = parseWalletCursor(url.searchParams.get("cursor"));
  // ?agent= is canonical; ?tool= remains a deprecated alias for one window.
  const rawTool = url.searchParams.get("agent")?.trim() ||
    url.searchParams.get("tool")?.trim() || undefined;
  const tool = rawTool && (kind === "receipts" || kind === "earnings")
    ? normalizeWalletToolFilter(rawTool)
    : undefined;
  return { limit, cursor, tool };
}

function parseWalletPageLimit(value: string | null): number {
  if (!value) return DEFAULT_WALLET_PAGE_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RequestValidationError("limit must be a positive integer");
  }
  return Math.min(parsed, MAX_WALLET_PAGE_LIMIT);
}

function parseWalletCursor(value: string | null): string | undefined {
  const cursor = value?.trim();
  if (!cursor) return undefined;
  if (Number.isNaN(Date.parse(cursor))) {
    throw new RequestValidationError("cursor must be an ISO timestamp");
  }
  return cursor;
}

function normalizeWalletToolFilter(value: string): string {
  const tool = value.trim();
  if (!tool || tool.length > 200) {
    throw new RequestValidationError("tool must be 1-200 characters");
  }
  return tool;
}

function pageWalletItems<T extends { createdAt?: string | null }>(
  items: T[],
  limit: number,
): WalletPageResult<T> {
  const hasMore = items.length > limit;
  const visible = hasMore ? items.slice(0, limit) : items;
  return {
    items: visible,
    page: {
      limit,
      hasMore,
      nextCursor: hasMore ? visible.at(-1)?.createdAt || null : null,
    },
  };
}

function emptyWalletPage<T>(limit: number): WalletPageResult<T> {
  return {
    items: [],
    page: {
      limit,
      hasMore: false,
      nextCursor: null,
    },
  };
}

function toLaunchWalletTransaction(
  row: BillingTransactionRow,
): LaunchWalletTransaction {
  return {
    id: row.id,
    type: row.type || "transaction",
    category: row.category || "wallet",
    description: row.description || "Credits transaction",
    amount: money(numeric(row.amount_light)),
    balanceAfter: row.balance_after_light === undefined
      ? null
      : money(numeric(row.balance_after_light)),
    appId: row.app_id || null,
    appName: row.app_name || null,
    createdAt: row.created_at || null,
  };
}

function toLaunchWalletReceipt(
  row: Awaited<ReturnType<typeof getRecentCalls>>[number],
): LaunchWalletReceiptSummary {
  return {
    receiptId: row.receipt_id,
    appId: row.app_id || null,
    appName: row.app_name || null,
    functionName: row.function_name || null,
    success: row.success !== false,
    total: money(numeric(row.receipt.total_light)),
    appCharge: money(numeric(row.receipt.app_charge_light)),
    infraCharge: money(numeric(row.receipt.infra_light)),
    platformFee: money(numeric(row.receipt.platform_fee_light)),
    developerNet: money(numeric(row.receipt.developer_net_light)),
    tax: money(numeric(row.receipt.tax_amount_light)),
    billingConfigVersion: row.receipt.billing_config_version ?? null,
    billingConfigVersions: row.receipt.billing_config_versions ?? [],
    createdAt: row.created_at || null,
    receiptUrl: `/wallet?tab=receipts&receipt=${
      encodeURIComponent(row.receipt_id)
    }`,
  };
}

function toLaunchWalletEarning(row: TransferRow): LaunchWalletEarningSummary {
  return {
    amount: money(numeric(row.amount_light)),
    appId: row.app_id || null,
    functionName: row.function_name || null,
    reason: row.reason || "earning",
    createdAt: row.created_at || null,
  };
}

function toLaunchWalletPayout(row: PayoutRow): LaunchWalletPayoutSummary {
  return {
    id: row.id,
    amount: money(numeric(row.amount_light)),
    status: row.status || "pending",
    createdAt: row.created_at || null,
    completedAt: row.completed_at || null,
  };
}

async function handleLaunchLeaderboard(url: URL): Promise<Response> {
  const kind = parseLeaderboardKind(url.searchParams.get("kind"));
  if (kind === "agent_fee_credit") {
    // Top Agents: per-Agent ranking by platform fees waived (publisher
    // referral program) — the marketing-visibility reward for spreading tools.
    const leaderboard = await getAgentFeeWaiverLeaderboard(
      parseFeeWaiverLeaderboardQuery(normalizeLeaderboardUrl(url)),
    );
    const apps = await fetchAppsByIds(
      leaderboard.entries.map((entry) => entry.app_id),
    );
    const appsById = new Map(apps.map((row) => [row.id, row]));
    const response: LaunchLeaderboardResponse = {
      kind,
      period: leaderboard.period,
      generatedAt: leaderboard.generated_at,
      entries: leaderboard.entries.map((entry) => {
        const app = appsById.get(entry.app_id);
        const agent = {
          id: entry.app_id,
          slug: app?.slug || entry.app_id,
          name: app?.name || app?.slug || entry.app_id,
        };
        return {
          rank: entry.rank,
          userId: entry.publisher_user_id,
          displayName: agent.name,
          profileSlug: null,
          avatarUrl: null,
          value: money(entry.fee_waived_light),
          eventCount: entry.event_count,
          featuredAgent: agent,
          featuredTool: agent,
        };
      }),
    };
    return json(response);
  }
  if (kind === "fee_credit") {
    const leaderboard = await getFeeWaiverLeaderboard(
      parseFeeWaiverLeaderboardQuery(normalizeLeaderboardUrl(url)),
    );
    const response: LaunchLeaderboardResponse = {
      kind,
      period: leaderboard.period,
      generatedAt: leaderboard.generated_at,
      entries: leaderboard.entries.map((entry) => ({
        rank: entry.rank,
        userId: entry.publisher_user_id,
        displayName: entry.display_name,
        profileSlug: entry.profile_slug,
        avatarUrl: entry.avatar_url,
        value: money(entry.fee_waived_light),
        eventCount: entry.event_count,
      })),
    };
    return json(response);
  }

  return json(await fetchBuilderLeaderboard(url));
}

function buildInstallInstructions(
  request: Request,
): LaunchInstallInstruction[] {
  const baseUrl = publicBaseUrl(request);
  const mcpUrl = `${baseUrl}/mcp/platform`;
  const bearer = "Bearer $GALACTIC_API_KEY";
  const genericConfig = {
    mcpServers: {
      galactic: {
        url: mcpUrl,
        headers: { Authorization: bearer },
      },
    },
  };
  const claudeCodeAddCommand =
    `claude mcp add --transport http --scope user galactic ${mcpUrl} --header "Authorization: ${bearer}"`;
  const connectPrompt = [
    "Connect Galactic to this coding agent, then help me conjure one useful full-time Agent.",
    "",
    "Galactic hosts private persistent Agents. You write and test the Agent; Galactic keeps it scheduled, sandboxed, stateful, bounded by owner-approved budgets and capabilities, and visible through run history and inbox reports.",
    "",
    "1. Install the MCP server (pick whichever works in your environment):",
    `   - Claude Code: ${claudeCodeAddCommand}`,
    `   - Any MCP config file: ${JSON.stringify(genericConfig)}`,
    "   - Automated installer: npx galacticconnection setup --token $GALACTIC_API_KEY",
    "",
    "2. Connect, then learn the platform: the server's initialize response carries the full platform guide, including a first-contact directive for how to orient me on this first connection. The same docs are also served at " +
    `${baseUrl}/api/skills.`,
    "",
    '3. Inspect only my private Agent library with gx.discover({ scope: "library" }). Then ask me for one recurring responsibility. Turn it into a mission, scaffold with gx.download({ full_time: true }), implement and test a representative wake, upload it privately, and stop for my explicit review of capabilities, grants, cadence, secrets, and hard budgets before activation.',
    "",
    "Treat the API key in this prompt as a secret: never echo it back, log it, or commit it anywhere.",
  ].join("\n");

  return [
    {
      target: "prompt",
      label: "Agent prompt",
      description:
        "One prompt that makes any agent install Galactic itself and start using it.",
      steps: [
        "Create an API key so the prompt carries a real credential.",
        "Paste the prompt into any agent: Claude Code, Cursor, or anything MCP-capable.",
        "The agent installs the MCP server, reads the platform guide, and reports what it can do.",
      ],
      configText: connectPrompt,
      requiresApiKey: true,
    },
    {
      target: "claude_code",
      label: "Claude Code",
      description:
        "Add Galactic as a remote MCP server for an existing Claude Code workspace.",
      steps: [
        "Create an Galactic API token from Settings.",
        "Run the command below with your token in place of $GALACTIC_API_KEY.",
        "Run /mcp (or restart) so Claude Code picks up the galactic server.",
      ],
      configText: claudeCodeAddCommand,
      requiresApiKey: true,
    },
    {
      target: "cursor",
      label: "Cursor",
      description:
        "Install the Galactic MCP server in Cursor's MCP configuration.",
      steps: [
        "Open Cursor MCP settings.",
        "Add the galactic server entry below.",
        "Reload Cursor so it can discover Galactic Agents.",
      ],
      configText: JSON.stringify(genericConfig, null, 2),
      requiresApiKey: true,
    },
    {
      target: "codex",
      label: "Codex",
      description:
        "Connect Codex to the same remote MCP endpoint used by other agents.",
      steps: [
        "Create an Galactic API token.",
        "Add a remote MCP server named galactic.",
        "Use the platform MCP endpoint and Authorization header below.",
      ],
      configText:
        `[mcp_servers.galactic]\nurl = "${mcpUrl}"\nheaders = { Authorization = "${bearer}" }`,
      requiresApiKey: true,
    },
    {
      target: "openai_remote_mcp",
      label: "OpenAI Remote MCP",
      description:
        "Register Galactic as a remote MCP server for OpenAI agent runtimes that support MCP tools.",
      steps: [
        "Use the platform MCP endpoint as the server URL.",
        "Pass your Galactic API token as a bearer Authorization header.",
        "Allow your connected agent to list available Agents before calling specific ones.",
      ],
      configText: JSON.stringify(
        { server_url: mcpUrl, authorization: bearer },
        null,
        2,
      ),
      requiresApiKey: true,
    },
    {
      target: "generic_mcp",
      label: "Generic MCP",
      description:
        "Use the standard remote MCP server declaration for any compatible agent.",
      steps: [
        "Copy the server configuration into your agent's MCP config.",
        "Replace the API token placeholder with an Galactic API token.",
        "Restart your connected agent or refresh its MCP tool list.",
      ],
      configText: JSON.stringify(genericConfig, null, 2),
      requiresApiKey: true,
    },
    {
      target: "cli",
      label: "CLI",
      description:
        "Use the existing Galactic CLI to login, upload, test, and run deployed Agents.",
      steps: [
        "Install the galacticconnection package or use the local CLI during development.",
        "Run galactic login --token <your-token>.",
        "Run galactic upload . from a deployable Agent directory.",
      ],
      configText:
        "npm install -g galacticconnection\ngalactic login --token <your-token>\ngalactic upload .",
      requiresApiKey: true,
    },
    {
      target: "api",
      label: "Direct API",
      description:
        "Call launch and platform endpoints directly with an Galactic API token.",
      steps: [
        "Create an API token from Settings.",
        "Send Authorization: Bearer <token> on authenticated API requests.",
        "Read /api/launch/status and /api/launch/openapi.json before calling authenticated launch endpoints.",
        "Use /api/launch/store for public Agent discovery and /mcp/platform for MCP tools.",
      ],
      configText: `curl "${baseUrl}/api/launch/status"\n` +
        `curl "${baseUrl}/api/launch/openapi.json"\n` +
        `curl "${baseUrl}/api/launch/store?query=deploy"\n` +
        `curl -H "Authorization: ${bearer}" "${baseUrl}/api/launch/library"`,
      requiresApiKey: true,
    },
  ];
}

async function buildLaunchInstallResponse(
  request: Request,
  url: URL,
): Promise<LaunchInstallResponse> {
  const toolLocator = normalizeQuery(url.searchParams.get("agent")) ||
    normalizeQuery(url.searchParams.get("tool"));
  const agentInstall = toolLocator
    ? await buildToolInstallContext(request, toolLocator)
    : null;
  return {
    instructions: buildInstallInstructions(request),
    agentInstall: agentInstall,
    // Deprecated alias kept for one rename window.
    toolInstall: agentInstall,
    generatedAt: new Date().toISOString(),
  };
}

async function buildToolInstallContext(
  request: Request,
  locator: string,
): Promise<LaunchAgentInstallContext> {
  const row = await fetchToolByLocator(locator, { publicOnly: true });
  if (!row) {
    throw new RequestValidationError("Agent not found", 404);
  }
  if (shouldHideGpu(row)) {
    throw new RequestValidationError("Agent not found", 404);
  }

  const viewer = await tryAuthenticate(request);
  const installedIds = viewer
    ? await fetchInstalledIds(viewer.id)
    : new Set<string>();
  const owners = await fetchOwnerMap([row.owner_id]);
  const tool = toLaunchAgentSummary(row, {
    owners,
    viewerId: viewer?.id,
    installedIds,
  });
  const baseUrl = publicBaseUrl(request);
  const platformMcpUrl = `${baseUrl}/mcp/platform`;
  const publicToolUrl = `${baseUrl}${
    tool.publicUrl || `/agents/${encodeURIComponent(tool.slug)}`
  }`;
  const installUrl = `${baseUrl}/install?agent=${
    encodeURIComponent(tool.slug)
  }`;
  // The dedicated endpoint is uuid-addressed: /mcp/:appId resolves ids only,
  // and uuids stay unambiguous (slugs are only unique per owner).
  const agentMcpUrl = `${baseUrl}/mcp/${tool.id}`;
  const bearer = "Bearer $GALACTIC_API_KEY";
  const agentMcpConfig = {
    mcpServers: {
      [tool.slug]: {
        url: agentMcpUrl,
        headers: { Authorization: bearer },
      },
    },
  };
  const connectPrompt = [
    `Set up the "${tool.name}" Agent from Galactic for me, then start using it.`,
    "",
    `"${tool.name}" is an Agent hosted on Galactic. Connect to it as a standalone MCP server; the API key below is scoped to this Agent only.`,
    "",
    "1. Install the MCP server (pick whichever works in your environment):",
    `   - Claude Code: claude mcp add --transport http --scope user ${tool.slug} ${agentMcpUrl} --header "Authorization: ${bearer}"`,
    `   - Any MCP config file: ${JSON.stringify(agentMcpConfig)}`,
    "",
    `2. Connect, then run tools/list to see what "${tool.name}" can do. ${publicToolUrl} shows its Overview, Functions, Interfaces, and connection status.`,
    "",
    `3. Prove it works: pick its most representative read-only function and call it, then tell me in a few lines how you can use "${tool.name}" for me going forward.`,
    "",
    "Calls may spend credits from my Galactic wallet: preserve receipt_id values and surface any credits-balance errors. Treat the API key as a secret: never echo it back, log it, or commit it anywhere.",
  ].join("\n");

  return {
    agent: tool,
    // Deprecated aliases kept for one rename window.
    tool,
    selectedAgentSlug: tool.slug,
    selectedToolSlug: tool.slug,
    publicAgentUrl: publicToolUrl,
    publicToolUrl,
    installUrl,
    platformMcpUrl,
    agentMcpUrl,
    mcpConfigText: JSON.stringify(agentMcpConfig, null, 2),
    connectPrompt,
    recommendedApiKey: {
      name: `${tool.slug} connected agent`,
      expiresInDays: 90,
      scopes: ["apps:call"],
      appIds: [tool.id],
    },
    agentHandoff: [
      `Inspect ${publicToolUrl} for the Agent's mission, functions, interfaces, and runtime setup.`,
      `Connect via this Agent's dedicated MCP endpoint ${agentMcpUrl} (or the platform endpoint ${platformMcpUrl}) with a bearer API key scoped to app ${tool.id}.`,
      `Call this Agent through MCP/API, then return ${publicToolUrl} when UI is useful.`,
      "Preserve receipt_id values and credits balance errors in the final agent response.",
    ],
  };
}

async function fetchPublicApps(options: {
  query: string | null;
  kind: LaunchAgentKind | "all";
  limit: number;
  excludeIds?: Set<string>;
}): Promise<RankedLaunchAppRow[]> {
  const db = getDbConfig();
  const candidateLimit = Math.min(
    MAX_DISCOVERY_LIMIT,
    Math.max(options.limit * 4, 40),
  );
  const rows = await dbGet<LaunchAppRow>(
    db,
    "apps",
    {
      visibility: "eq.public",
      deleted_at: "is.null",
      select: APP_SELECT,
      order: "weighted_likes.desc,total_runs.desc,updated_at.desc",
      limit: String(candidateLimit),
    },
  );
  return rows
    .filter((row) => !shouldHideGpu(row))
    .filter((row) => !options.excludeIds?.has(row.id))
    .filter((row) => matchesKind(row, options.kind))
    .filter((row) => matchesQuery(row, options.query))
    .slice(0, options.limit)
    .map((row) => annotateLexicalRow(row, options.query));
}

async function tryEmbedLaunchQuery(
  query: string,
): Promise<LaunchQueryEmbedding | null> {
  const embeddingService = createEmbeddingService();
  if (!embeddingService) return null;
  try {
    const result = await embeddingService.embed(query);
    return {
      embedding: result.embedding,
      model: result.model,
    };
  } catch (err) {
    console.warn("[LAUNCH] Query embedding failed:", err);
    return null;
  }
}

async function fetchSemanticPublicApps(options: {
  embedding: number[];
  kind: LaunchAgentKind | "all";
  limit: number;
}): Promise<RankedLaunchAppRow[]> {
  let subjectRows: RankedLaunchAppRow[] = [];
  try {
    subjectRows = await fetchSubjectSemanticPublicApps(options);
  } catch (err) {
    console.warn("[LAUNCH] Subject semantic search unavailable:", err);
  }

  if (subjectRows.length >= options.limit) {
    return subjectRows.slice(0, options.limit);
  }

  let legacyRows: RankedLaunchAppRow[] = [];
  try {
    legacyRows = await fetchLegacySemanticPublicApps(options);
  } catch (err) {
    if (subjectRows.length > 0) return subjectRows.slice(0, options.limit);
    throw err;
  }

  const seen = new Set(subjectRows.map((row) => row.id));
  return [
    ...subjectRows,
    ...legacyRows.filter((row) => !seen.has(row.id)),
  ].slice(0, options.limit);
}

async function fetchSubjectSemanticPublicApps(options: {
  embedding: number[];
  kind: LaunchAgentKind | "all";
  limit: number;
}): Promise<RankedLaunchAppRow[]> {
  const db = getDbConfig();
  const response = await fetch(
    `${db.baseUrl}/rest/v1/rpc/search_tool_semantic_embeddings`,
    {
      method: "POST",
      headers: db.headers,
      body: JSON.stringify({
        p_query_embedding: vectorString(options.embedding),
        p_match_threshold: SEMANTIC_DISCOVERY_THRESHOLD,
        p_match_count: Math.min(
          MAX_DISCOVERY_LIMIT,
          Math.max(options.limit * 6, 60),
        ),
        p_subject_types: ["app", "function"],
        p_app_version: null,
        p_visibility: ["public", "unlisted"],
        p_include_platform_primitives: false,
      }),
    },
  );
  const matches = await readRows<ToolSemanticEmbeddingMatchRow>(
    response,
    "Failed to search launch subject embeddings",
  );

  const bestByApp = new Map<string, ToolSemanticEmbeddingMatchRow>();
  for (const match of matches) {
    if (!match.app_id) continue;
    const existing = bestByApp.get(match.app_id);
    if (!existing || numeric(match.similarity) > numeric(existing.similarity)) {
      bestByApp.set(match.app_id, match);
    }
  }

  const orderedMatches = Array.from(bestByApp.values())
    .sort((a, b) => numeric(b.similarity) - numeric(a.similarity));
  const rowsById = new Map(
    (await fetchAppsByIds(orderedMatches.map((match) => match.app_id!)))
      .map((row) => [row.id, row]),
  );

  const rankedRows: RankedLaunchAppRow[] = [];
  for (const match of orderedMatches) {
    const row = match.app_id ? rowsById.get(match.app_id) : null;
    if (!row) continue;
    rankedRows.push({
      ...row,
      launchRelevance: {
        source: "semantic",
        score: roundScore(match.similarity),
        signals: [`tool_semantic_embedding:${match.subject_type}`],
        subjectType: match.subject_type,
        subjectId: match.subject_id,
        subjectLabel: match.subject_label || null,
        appVersion: match.app_version,
        embeddingTextHash: match.embedding_text_hash,
      },
    });
  }

  return rankedRows
    .filter((row) => !shouldHideGpu(row))
    .filter((row) => matchesKind(row, options.kind))
    .filter((row) =>
      numeric(row.launchRelevance?.score) >= SEMANTIC_DISCOVERY_THRESHOLD
    )
    .slice(0, options.limit);
}

async function fetchLegacySemanticPublicApps(options: {
  embedding: number[];
  kind: LaunchAgentKind | "all";
  limit: number;
}): Promise<RankedLaunchAppRow[]> {
  const db = getDbConfig();
  const response = await fetch(`${db.baseUrl}/rest/v1/rpc/search_apps`, {
    method: "POST",
    headers: db.headers,
    body: JSON.stringify({
      p_query_embedding: vectorString(options.embedding),
      p_user_id: PUBLIC_SEARCH_USER_ID,
      p_limit: Math.min(MAX_DISCOVERY_LIMIT, Math.max(options.limit * 4, 40)),
      p_offset: 0,
    }),
  });
  const matches = await readRows<SemanticAppMatchRow>(
    response,
    "Failed to search launch app embeddings",
  );
  const similarityById = new Map(
    matches.map((match) => [match.id, numeric(match.similarity)]),
  );
  const rowsById = new Map(
    (await fetchAppsByIds(matches.map((match) => match.id)))
      .map((row) => [row.id, row]),
  );
  return matches
    .map((match) => rowsById.get(match.id))
    .filter((row): row is LaunchAppRow => Boolean(row))
    .filter((row) => !shouldHideGpu(row))
    .filter((row) => matchesKind(row, options.kind))
    .map((row) => ({
      ...row,
      launchRelevance: {
        source: "semantic",
        score: roundScore(similarityById.get(row.id)),
        signals: ["skills_embedding"],
      },
    } satisfies RankedLaunchAppRow))
    .filter((row) =>
      numeric(row.launchRelevance?.score) >= SEMANTIC_DISCOVERY_THRESHOLD
    )
    .slice(0, options.limit);
}

async function fetchOwnedApps(userId: string): Promise<LaunchAppRow[]> {
  const db = getDbConfig();
  return await dbGet<LaunchAppRow>(
    db,
    "apps",
    {
      owner_id: `eq.${userId}`,
      deleted_at: "is.null",
      select: APP_SELECT,
      order: "updated_at.desc",
      limit: "100",
    },
  );
}

async function fetchInstalledIds(userId: string): Promise<Set<string>> {
  const db = getDbConfig();
  const rows = await dbGet<LibraryRow>(
    db,
    "user_app_library",
    {
      user_id: `eq.${userId}`,
      select: "app_id",
      limit: "500",
    },
  );
  return new Set(rows.map((row) => row.app_id).filter(Boolean));
}

async function fetchAppsByIds(appIds: string[]): Promise<LaunchAppRow[]> {
  const ids = Array.from(new Set(appIds)).filter(Boolean).slice(0, 100);
  if (ids.length === 0) return [];
  const db = getDbConfig();
  return await dbGet<LaunchAppRow>(
    db,
    "apps",
    {
      id: `in.(${ids.join(",")})`,
      deleted_at: "is.null",
      select: APP_SELECT,
      order: "updated_at.desc",
      limit: String(ids.length),
    },
  );
}

async function fetchToolByLocator(
  locator: string,
  options: { publicOnly?: boolean; ownerId?: string },
): Promise<LaunchAppRow | null> {
  const db = getDbConfig();
  const params: Record<string, string> = {
    deleted_at: "is.null",
    select: APP_SELECT,
    limit: "1",
  };
  if (isUuid(locator)) {
    params.or = `(id.eq.${locator},slug.eq.${locator})`;
  } else {
    params.slug = `eq.${locator}`;
  }
  if (options.publicOnly) params.visibility = "in.(public,unlisted)";
  if (options.ownerId) params.owner_id = `eq.${options.ownerId}`;
  const rows = await dbGet<LaunchAppRow>(db, "apps", params);
  return rows[0] || null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

async function resolvePublicLaunchTool(
  encodedLocator: string,
): Promise<{ row: LaunchAppRow; installedIds: Set<string> } | null> {
  const locator = parseLocator(encodedLocator);
  const row = await fetchToolByLocator(locator, { publicOnly: true });
  if (!row || shouldHideGpu(row)) return null;
  return { row, installedIds: new Set<string>() };
}

async function resolveLaunchVisibleTool(
  request: Request,
  encodedLocator: string,
): Promise<
  | { row: LaunchAppRow; installedIds: Set<string>; viewer: AuthUser | null }
  | null
> {
  const viewer = await tryAuthenticate(request);
  const resolved = viewer
    ? await resolveLaunchRunnableTool(viewer, encodedLocator)
    : await resolvePublicLaunchTool(encodedLocator);
  if (!resolved) return null;
  return { ...resolved, viewer };
}

async function resolveLaunchRunnableTool(
  user: AuthUser,
  encodedLocator: string,
): Promise<{ row: LaunchAppRow; installedIds: Set<string> } | null> {
  const locator = parseLocator(encodedLocator);
  const installedIds = await fetchInstalledIds(user.id);
  const owned = await fetchToolByLocator(locator, { ownerId: user.id });
  if (owned && !shouldHideGpu(owned)) return { row: owned, installedIds };

  const publicRow = await fetchToolByLocator(locator, { publicOnly: true });
  if (publicRow && !shouldHideGpu(publicRow)) {
    return { row: publicRow, installedIds };
  }

  const candidate = await fetchToolByLocator(locator, {});
  if (
    candidate &&
    !shouldHideGpu(candidate) &&
    candidate.owner_id !== user.id &&
    installedIds.has(candidate.id)
  ) {
    return { row: candidate, installedIds };
  }

  return null;
}

async function resolveAgentPermissionTool(
  user: AuthUser,
  encodedLocator: string,
): Promise<{ row: LaunchAppRow; installedIds: Set<string> } | null> {
  return await resolveLaunchRunnableTool(user, encodedLocator);
}

async function buildLaunchCallerPermissionsResponse(
  user: AuthUser,
  row: LaunchAppRow,
  installedIds: Set<string>,
): Promise<LaunchCallerFunctionPermissionsResponse> {
  const owners = await fetchOwnerMap([row.owner_id]);
  const tool = toLaunchAgentSummary(row, {
    owners,
    viewerId: user.id,
    installedIds,
  });
  const permissions = await listCallerFunctionPermissions({
    userId: user.id,
    appId: row.id,
    functionNames: extractFunctionNames(row),
  });

  const handle = {
    id: tool.id,
    slug: tool.slug,
    name: tool.name,
    relationship: tool.relationship,
    publicUrl: tool.publicUrl,
    adminUrl: tool.adminUrl,
  };
  return {
    agent: handle,
    // Deprecated alias kept for one rename window.
    tool: handle,
    defaultPolicy: permissions.defaultPolicy,
    defaultHealthGate: permissions.defaultHealthGate,
    permissions: permissions.permissions,
    generatedAt: new Date().toISOString(),
  };
}

async function buildLaunchFunctionSummaries(
  row: LaunchAppRow,
  viewerId?: string,
): Promise<LaunchFunctionSummary[]> {
  const names = extractFunctionNames(row);
  const manifest = parseManifest(row.manifest);
  const manifestFunctions = asRecord(manifest?.functions) || {};
  const permissions = viewerId
    ? await listCallerFunctionPermissions({
      userId: viewerId,
      appId: row.id,
      functionNames: names,
    })
    : null;
  const permissionByFunction = new Map(
    (permissions?.permissions || []).map((permission) => [
      permission.functionName,
      permission,
    ]),
  );
  const overrides = viewerId
    ? await listFunctionInferenceOverrides({
      userId: viewerId,
      appId: row.id,
      functionNames: names,
    })
    : null;
  const overrideByFunction = new Map(
    (overrides || []).map((entry) => [entry.functionName, entry]),
  );
  const accessPolicy = accessPolicySummaryForTool(row);

  return names.map((name) => {
    const functionDef = asRecord(manifestFunctions[name]);
    return {
      name,
      description: stringOrNull(functionDef?.description),
      inputSchema: inputSchemaForFunction(functionDef),
      outputSchema: outputSchemaForFunction(functionDef),
      annotations: functionAnnotations(functionDef),
      pricing: pricingSummaryForFunction(row, name),
      accessPolicy,
      callerPermission: permissionByFunction.get(name) || null,
      // Deprecated alias kept for one rename window.
      agentPermission: permissionByFunction.get(name) || null,
      inferenceOverride: overrideByFunction.get(name) || null,
      usesInference: functionUsesInference(manifest, name),
    };
  });
}

function functionAnnotations(
  functionDef: Record<string, unknown> | null,
): NonNullable<LaunchFunctionSummary["annotations"]> | null {
  const raw = asRecord(functionDef?.annotations);
  if (!raw) return null;
  const annotations: NonNullable<LaunchFunctionSummary["annotations"]> = {};
  if (typeof raw.readOnlyHint === "boolean") {
    annotations.readOnlyHint = raw.readOnlyHint;
  }
  if (typeof raw.destructiveHint === "boolean") {
    annotations.destructiveHint = raw.destructiveHint;
  }
  if (typeof raw.idempotentHint === "boolean") {
    annotations.idempotentHint = raw.idempotentHint;
  }
  if (typeof raw.openWorldHint === "boolean") {
    annotations.openWorldHint = raw.openWorldHint;
  }
  return Object.keys(annotations).length > 0 ? annotations : null;
}

function accessPolicySummaryForTool(
  row: LaunchAppRow,
): LaunchFunctionSummary["accessPolicy"] {
  const policy = resolveManifestAccessPolicy({ manifest: row.manifest });
  return {
    configured: policy.configured,
    mode: policy.mode,
    module: policy.module,
    exportName: policy.exportName,
    execution: policy.configured && policy.mode === "module"
      ? "runtime_policy"
      : "static_pricing",
  };
}

function toLaunchToolHandle(
  tool: LaunchAgentSummary,
): Pick<
  LaunchAgentSummary,
  "id" | "slug" | "name" | "relationship" | "publicUrl" | "adminUrl"
> {
  return {
    id: tool.id,
    slug: tool.slug,
    name: tool.name,
    relationship: tool.relationship,
    publicUrl: tool.publicUrl,
    adminUrl: tool.adminUrl,
  };
}

function extractFunctionNames(row: LaunchAppRow): string[] {
  const names = new Set<string>();
  const manifest = parseManifest(row.manifest);
  const manifestFunctions = manifest?.functions;
  if (manifestFunctions && typeof manifestFunctions === "object") {
    for (const functionName of Object.keys(manifestFunctions)) {
      if (functionName.trim()) names.add(functionName.trim());
    }
  }
  for (const functionName of row.exports || []) {
    if (typeof functionName === "string" && functionName.trim()) {
      names.add(functionName.trim());
    }
  }
  return Array.from(names).sort((left, right) => left.localeCompare(right));
}

function inputSchemaForFunction(
  functionDef: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const parameters = asRecord(functionDef?.parameters);
  if (!parameters) {
    return { type: "object", properties: {}, required: [] };
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, rawParam] of Object.entries(parameters)) {
    const param = asRecord(rawParam);
    if (!param) continue;
    properties[name] = Object.fromEntries(
      Object.entries({
        type: typeof param.type === "string" ? param.type : "string",
        description: stringOrNull(param.description),
        enum: Array.isArray(param.enum) ? param.enum : undefined,
        default: param.default,
        items: param.items,
        properties: param.properties,
      }).filter(([, value]) => value !== undefined && value !== null),
    );
    if (param.required !== false) required.push(name);
  }
  return { type: "object", properties, required };
}

function outputSchemaForFunction(
  functionDef: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return asRecord(functionDef?.returns);
}

function pricingSummaryForFunction(
  row: LaunchAppRow,
  functionName: string,
): LaunchPricingSummary {
  const pricingConfig = asRecord(row.pricing_config);
  const defaultPrice = numeric(pricingConfig?.default_price_light);
  const functionPrices = asRecord(pricingConfig?.functions);
  const functionPriceValue = functionPrices?.[functionName];
  const price = functionPriceValue !== undefined
    ? functionPrice(functionPriceValue)
    : defaultPrice;
  return {
    defaultCallPrice: price > 0 ? money(price) : null,
    freeToInstall: true,
    paidFunctionsCount: price > 0 ? 1 : 0,
  };
}

async function fetchOwnerMap(
  ownerIds: string[],
): Promise<Map<string, LaunchAgentOwnerSummary>> {
  const ids = Array.from(new Set(ownerIds)).filter(Boolean);
  const map = new Map<string, LaunchAgentOwnerSummary>();
  for (const id of ids) {
    map.set(id, { userId: id });
  }
  if (ids.length === 0) return map;

  const db = getDbConfig();
  const rows = await dbGet<OwnerRow>(
    db,
    "users",
    {
      id: `in.(${ids.join(",")})`,
      select: OWNER_SELECT,
      limit: String(ids.length),
    },
  );
  for (const row of rows) {
    map.set(row.id, {
      userId: row.id,
      displayName: row.display_name,
      profileSlug: row.profile_slug,
      avatarUrl: row.avatar_url,
    });
  }
  return map;
}

async function fetchBuilderLeaderboard(
  url: URL,
): Promise<LaunchLeaderboardResponse> {
  const db = getDbConfig();
  const period = parseLeaderboardPeriod(url.searchParams.get("period"));
  const limit = clampLimit(url.searchParams.get("limit"), 50);
  const response = await fetch(`${db.baseUrl}/rest/v1/rpc/get_leaderboard`, {
    method: "POST",
    headers: db.headers,
    body: JSON.stringify({
      p_interval: period === "all" ? "at" : period,
      p_limit: limit,
    }),
  });
  const rows = await readRows<BuilderLeaderboardRpcRow>(
    response,
    "Failed to fetch builder leaderboard",
  );
  const generatedAt = new Date().toISOString();
  return {
    kind: "builder",
    period,
    generatedAt,
    entries: rows.map((row, index) => toBuilderLeaderboardEntry(row, index)),
  };
}

function toBuilderLeaderboardEntry(
  row: BuilderLeaderboardRpcRow,
  index: number,
): LaunchLeaderboardEntry {
  const userId = row.user_id || row.owner_id || row.publisher_user_id || "";
  const value = numeric(
    row.earnings_light ?? row.score ?? row.weighted_likes ?? row.total_likes ??
      row.total_runs,
  );
  const featuredSlug = row.app_slug || row.featured_app_slug || row.app_id;
  const featuredName = row.app_name || row.featured_app_name || featuredSlug;
  return {
    rank: numeric(row.rank) || index + 1,
    userId,
    displayName: row.display_name ?? null,
    profileSlug: row.profile_slug ?? null,
    avatarUrl: row.avatar_url ?? null,
    value: money(value),
    eventCount: numeric(row.event_count ?? row.total_runs),
    featuredAgent: featuredSlug
      ? {
        id: row.app_id || featuredSlug,
        slug: featuredSlug,
        name: featuredName || featuredSlug,
      }
      : null,
    // Deprecated alias kept for one rename window.
    featuredTool: featuredSlug
      ? {
        id: row.app_id || featuredSlug,
        slug: featuredSlug,
        name: featuredName || featuredSlug,
      }
      : null,
  };
}

function toLaunchAgentSummary(
  row: LaunchAppRow,
  options: ToolMapOptions,
): LaunchAgentSummary {
  const slug = row.slug || row.id;
  const installed = options.installedIds?.has(row.id) || false;
  const relationship = relationshipFor(row, options.viewerId, installed);
  const interfaces = options.includeInterfaces
    ? interfaceSummaries(row)
    : undefined;
  // Full-time disclosure rides the same detail-context flag as interfaces — both
  // are manifest-derived and only wanted on the agent detail response.
  const fullTime = options.includeInterfaces
    ? fullTimeDisclosure(row)
    : undefined;
  return {
    id: row.id,
    slug,
    name: row.name || slug,
    iconUrl: row.icon_url ?? null,
    description: row.description,
    kind: inferToolKind(row),
    visibility: normalizeVisibility(row.visibility),
    relationship,
    owner: options.owners.get(row.owner_id) || { userId: row.owner_id },
    installed,
    installUrl: `/install?tool=${encodeURIComponent(slug)}`,
    publicUrl: `/agents/${encodeURIComponent(slug)}`,
    adminUrl: relationship === "owner"
      ? `/admin/agents/${encodeURIComponent(row.id)}`
      : null,
    pricing: pricingSummary(row),
    tags: row.tags || [],
    updatedAt: row.updated_at || row.created_at || null,
    ...(interfaces ? { interfaces } : {}),
    ...(fullTime ? { fullTime } : {}),
  };
}

// Viewer-facing disclosure of an Agent's autonomous behavior, from its manifest
// routine declaration. Present only when the Agent ships a routine template — a
// full-time agent — so the detail page can show "this runs on its own".
function fullTimeDisclosure(
  row: LaunchAppRow,
): LaunchFullTimeDisclosure | undefined {
  const manifest = parseManifest(row.manifest);
  const routine = manifest?.routines?.[0];
  if (!routine) return undefined;

  type CapEntry = LaunchFullTimeDisclosure["capabilities"][number];
  const capabilities: CapEntry[] = (routine.capabilities || [])
    .flatMap((cap): CapEntry[] => {
      const access: "read" | "write" = cap.access === "write"
        ? "write"
        : "read";
      const fns = Array.isArray(cap.functions) ? cap.functions : [];
      if (fns.length === 0) {
        return [{ appRef: cap.app ?? null, functionName: null, access }];
      }
      return fns.map((fn): CapEntry => ({
        appRef: cap.app ?? null,
        functionName: fn,
        access,
      }));
    })
    .slice(0, 24);

  return {
    label: routine.label || "Full-time agent",
    description: routine.description ?? null,
    scheduleSummary: summarizeRoutineSchedule(routine.default_schedule),
    budget: {
      perRunLight: positiveOrNull(routine.budget_defaults?.max_light_per_run),
      perDayLight: positiveOrNull(routine.budget_defaults?.max_light_per_day),
      perMonthLight: positiveOrNull(
        routine.budget_defaults?.max_light_per_month,
      ),
    },
    recordsReasoning: manifest?.flight_recorder === true,
    capabilities,
  };
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

// Human-readable cadence from a manifest schedule declaration (string cron or
// interval/cron object).
function summarizeRoutineSchedule(schedule: unknown): string | null {
  if (!schedule) return null;
  if (typeof schedule === "string") {
    return schedule.trim() ? `cron ${schedule.trim()}` : null;
  }
  if (typeof schedule !== "object") return null;
  const s = schedule as Record<string, unknown>;
  if (typeof s.cron === "string" && s.cron.trim()) {
    return `cron ${s.cron.trim()}`;
  }
  const mins = s.every_minutes;
  if (typeof mins === "number" && mins > 0) {
    return mins === 1 ? "every minute" : `every ${mins} minutes`;
  }
  const secs = s.every_seconds;
  if (typeof secs === "number" && secs > 0) {
    return secs === 1 ? "every second" : `every ${secs} seconds`;
  }
  return null;
}

const INTERFACE_ARTIFACT_HASH_RE = /^[0-9a-f]{64}$/;

// Maps manifest interfaces[] to renderable summaries. Only entries with a
// server-stamped artifact hash (PR2) are exposed — unstamped declarations
// (GPU uploads, pre-PR2 manifests) have nothing the sandbox worker can
// serve. The bridge allowlist is intersected with the agent's REAL manifest
// functions so the FE never offers a call the runtime would refuse. URLs are
// built from explicit config, never the request Host (Phase-3 lesson); a
// missing INTERFACE_SANDBOX_BASE_URL fails closed to "no interfaces".
function interfaceSummaries(
  row: LaunchAppRow,
): LaunchInterfaceSummary[] | undefined {
  const manifest = parseManifest(row.manifest);
  const declarations = manifest?.interfaces;
  if (!Array.isArray(declarations) || declarations.length === 0) {
    return undefined;
  }
  const sandboxBaseUrl = (getEnv("INTERFACE_SANDBOX_BASE_URL") || "")
    .replace(/\/+$/, "");
  if (!sandboxBaseUrl) return undefined;

  const manifestFunctions = new Set(Object.keys(manifest?.functions || {}));
  const summaries: LaunchInterfaceSummary[] = [];
  for (const declaration of declarations) {
    if (!declaration || typeof declaration !== "object") continue;
    if (typeof declaration.id !== "string" || !declaration.id) continue;
    if (typeof declaration.label !== "string" || !declaration.label) continue;
    if (
      typeof declaration.hash !== "string" ||
      !INTERFACE_ARTIFACT_HASH_RE.test(declaration.hash)
    ) {
      continue;
    }
    const functions = Array.isArray(declaration.functions)
      ? declaration.functions.filter((fn): fn is string =>
        typeof fn === "string" && manifestFunctions.has(fn)
      )
      : [];
    summaries.push({
      id: declaration.id,
      label: declaration.label,
      description: typeof declaration.description === "string"
        ? declaration.description
        : null,
      url: `${sandboxBaseUrl}/i/${
        encodeURIComponent(row.id)
      }/${declaration.hash}`,
      functions,
      minHeight: typeof declaration.min_height === "number" &&
          Number.isFinite(declaration.min_height)
        ? declaration.min_height
        : null,
    });
  }
  return summaries.length > 0 ? summaries : undefined;
}

function pricingSummary(row: LaunchAppRow): LaunchPricingSummary {
  const pricingConfig = asRecord(row.pricing_config);
  const defaultPrice = numeric(pricingConfig?.default_price_light);
  const functionPrices = asRecord(pricingConfig?.functions);
  const paidFunctionsCount = functionPrices
    ? Object.values(functionPrices).filter((value) => functionPrice(value) > 0)
      .length
    : 0;

  return {
    defaultCallPrice: defaultPrice > 0 ? money(defaultPrice) : null,
    freeToInstall: true,
    paidFunctionsCount,
  };
}

function functionPrice(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const record = asRecord(value);
  return numeric(record?.price_light);
}

function inferToolKind(row: LaunchAppRow): LaunchAgentKind {
  if (row.app_type === "skill") return "markdown";
  if (row.runtime === "gpu") return "gpu";
  const manifest = parseManifest(row.manifest);
  if (manifest?.http) return "http";
  if (Array.isArray(row.exports) && row.exports.length > 0) return "mcp";
  return "mcp";
}

function relationshipFor(
  row: LaunchAppRow,
  viewerId: string | null | undefined,
  installed: boolean,
): LaunchAgentRelationship {
  if (viewerId && row.owner_id === viewerId) return "owner";
  if (installed) return "installed";
  return "public";
}

function normalizeVisibility(
  value: string | null | undefined,
): LaunchAgentVisibility {
  if (value === "private" || value === "unlisted" || value === "public") {
    return value;
  }
  return "private";
}

async function buildLaunchTrustCard(
  row: LaunchAppRow,
): Promise<LaunchTrustCard> {
  // Real runtime integrity + binary call health + publisher Connect verification,
  // gathered in parallel by the shared resolveTrustSignals (same signals the MCP
  // gx.discover inspect path now uses) — never the base builder's optimistic
  // defaults. Persisted signals, no live Stripe call per page load.
  const signals = await resolveTrustSignals(row);
  const card = sanitizeGpuTrustCard(buildAppTrustCard(
    {
      current_version: row.current_version || "",
      runtime: row.runtime === "gpu" && !isGpuSupportEnabled()
        ? "deno"
        : row.runtime || "deno",
      manifest: typeof row.manifest === "string"
        ? row.manifest
        : row.manifest
        ? JSON.stringify(row.manifest)
        : null,
      version_metadata: Array.isArray(row.version_metadata)
        ? row.version_metadata as never
        : [],
      visibility: normalizeVisibility(row.visibility),
      download_access: row.download_access || "owner",
      env_schema: row.env_schema || {},
    } as never,
    signals,
  ) as LaunchTrustCard);

  // Declared-only disclosure (no per-user connected state) — the trust card is a
  // public, cacheable artifact; the viewer's connection status comes from the
  // per-user settings endpoint instead.
  return {
    ...card,
    network_disclosure: buildAppNetworkDisclosure(
      (row.manifest ?? null) as Parameters<typeof buildAppNetworkDisclosure>[0],
    ),
  };
}

function shouldHideGpu(row: LaunchAppRow): boolean {
  return row.runtime === "gpu" && !isGpuSupportEnabled();
}

function matchesKind(
  row: LaunchAppRow,
  kind: LaunchAgentKind | "all",
): boolean {
  return kind === "all" || inferToolKind(row) === kind;
}

function matchesQuery(row: LaunchAppRow, query: string | null): boolean {
  if (!query) return true;
  const haystack = [
    row.name,
    row.slug,
    row.description,
    row.category,
    ...(row.tags || []),
  ].join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function annotateLexicalRow(
  row: LaunchAppRow,
  query: string | null,
): RankedLaunchAppRow {
  return {
    ...row,
    launchRelevance: {
      source: query ? "lexical" : "curated",
      score: query ? lexicalRowScore(row, query) : null,
      signals: query ? ["tool_metadata"] : [
        "community_signal",
      ],
    },
  };
}

function withToolRelevance(
  tool: LaunchAgentSummary,
  relevance?: LaunchRelevanceSummary,
): LaunchAgentSummary {
  return relevance ? { ...tool, relevance } : tool;
}

function lexicalRowScore(row: LaunchAppRow, query: string | null): number {
  const normalized = normalizeQuery(query);
  if (!normalized) return 0;
  const terms = normalized.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const haystack = [
    row.name,
    row.slug,
    row.description,
    row.category,
    ...(row.tags || []),
  ].join(" ").toLowerCase();
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return roundScore(matches / terms.length);
}

function buildDiscoveryRetrieval(options: {
  hasQuery: boolean;
  embedding: LaunchQueryEmbedding | null;
  toolRows: RankedLaunchAppRow[];
  primitiveSuggestions: LaunchPlatformPrimitiveSuggestion[];
  fallbackReason: string | null;
}): LaunchDiscoveryRetrievalSummary {
  if (!options.hasQuery) {
    return {
      mode: "browse",
      embeddedSources: [],
      fallbackSources: ["tools", "platform_primitives"],
      embeddingModel: null,
      fallbackReason: null,
    };
  }

  const embeddedSources = new Set<LaunchDiscoverySource>();
  const fallbackSources = new Set<LaunchDiscoverySource>();
  if (
    options.toolRows.some((row) => row.launchRelevance?.source === "semantic")
  ) {
    embeddedSources.add("tools");
  }
  if (
    options.toolRows.some((row) =>
      row.launchRelevance?.source === "lexical" ||
      row.launchRelevance?.source === "curated"
    )
  ) {
    fallbackSources.add("tools");
  }
  if (
    options.primitiveSuggestions.some((suggestion) =>
      suggestion.relevance?.source === "semantic"
    )
  ) {
    embeddedSources.add("platform_primitives");
    embeddedSources.add("install_docs");
  }
  if (
    options.primitiveSuggestions.some((suggestion) =>
      suggestion.relevance?.source !== "semantic"
    )
  ) {
    fallbackSources.add("platform_primitives");
    fallbackSources.add("install_docs");
  }

  const mode = embeddedSources.size > 0 && fallbackSources.size > 0
    ? "hybrid"
    : embeddedSources.size > 0
    ? "semantic"
    : "lexical";

  return {
    mode,
    embeddedSources: Array.from(embeddedSources),
    fallbackSources: Array.from(fallbackSources),
    embeddingModel: options.embedding?.model || null,
    fallbackReason: options.fallbackReason,
  };
}

async function buildPrimitiveSuggestions(
  query: string | null,
  embedding?: LaunchQueryEmbedding | null,
): Promise<LaunchPlatformPrimitiveSuggestion[]> {
  const normalized = normalizeQuery(query);
  if (normalized && embedding) {
    const semantic = await buildSemanticPrimitiveSuggestions(
      normalized,
      embedding,
    );
    if (semantic.length > 0) return semantic;
  }

  return buildLexicalPrimitiveSuggestions(normalized);
}

async function buildSemanticPrimitiveSuggestions(
  query: string,
  queryEmbedding: LaunchQueryEmbedding,
): Promise<LaunchPlatformPrimitiveSuggestion[]> {
  try {
    const cache = await getPrimitiveEmbeddingCache(queryEmbedding.model);
    return cache.entries
      .map((entry) => {
        const metadata = PRIMITIVE_METADATA[entry.primitive];
        const similarity = cosineSimilarity(
          queryEmbedding.embedding,
          entry.embedding,
        );
        return {
          primitive: entry.primitive,
          label: metadata.label,
          description: metadata.description,
          route: metadata.route,
          apiRoute: metadata.apiRoute,
          similarity: roundScore(similarity),
          relevance: {
            source: "semantic",
            score: roundScore(similarity),
            signals: ["platform_primitive_embedding"],
          },
        } satisfies LaunchPlatformPrimitiveSuggestion;
      })
      .filter((suggestion) => numeric(suggestion.similarity) > 0)
      .sort((a, b) => numeric(b.similarity) - numeric(a.similarity));
  } catch (err) {
    console.warn("[LAUNCH] Primitive embeddings failed:", err);
    return buildLexicalPrimitiveSuggestions(query);
  }
}

async function getPrimitiveEmbeddingCache(
  model: string,
): Promise<PrimitiveEmbeddingCache> {
  if (primitiveEmbeddingCache?.model === model) return primitiveEmbeddingCache;
  const embeddingService = createEmbeddingService();
  if (!embeddingService) {
    throw new Error("embedding service unavailable");
  }
  const results = await embeddingService.embedBatch(
    LAUNCH_PLATFORM_PRIMITIVES.map((primitive) =>
      primitiveEmbeddingText(primitive, PRIMITIVE_METADATA[primitive])
    ),
  );
  primitiveEmbeddingCache = {
    model,
    entries: LAUNCH_PLATFORM_PRIMITIVES.map((primitive, index) => ({
      primitive,
      embedding: results[index]?.embedding || [],
    })).filter((entry) => entry.embedding.length > 0),
  };
  return primitiveEmbeddingCache;
}

function buildLexicalPrimitiveSuggestions(
  normalized: string | null,
): LaunchPlatformPrimitiveSuggestion[] {
  return LAUNCH_PLATFORM_PRIMITIVES
    .map((primitive) => {
      const metadata = PRIMITIVE_METADATA[primitive];
      const similarity = normalized
        ? primitiveSimilarity(primitive, metadata, normalized)
        : null;
      const relevanceSource: LaunchRelevanceSummary["source"] = normalized
        ? "lexical"
        : "curated";
      return {
        primitive,
        label: metadata.label,
        description: metadata.description,
        route: metadata.route,
        apiRoute: metadata.apiRoute,
        similarity,
        relevance: {
          source: relevanceSource,
          score: similarity,
          signals: normalized ? ["primitive_text"] : ["launch_catalog"],
        },
      } satisfies LaunchPlatformPrimitiveSuggestion;
    })
    .filter((suggestion) =>
      suggestion.similarity === null || suggestion.similarity > 0
    )
    .sort((a, b) => numeric(b.similarity) - numeric(a.similarity));
}

function primitiveEmbeddingText(
  primitive: LaunchPlatformPrimitive,
  metadata: PrimitiveMetadata,
): string {
  return [
    `Galactic platform primitive: ${primitive}`,
    metadata.label,
    metadata.description,
    metadata.route ? `Website route ${metadata.route}` : "",
    metadata.apiRoute ? `API route ${metadata.apiRoute}` : "",
    "External agents can discover and call this platform function.",
  ].filter(Boolean).join(". ");
}

function primitiveSimilarity(
  primitive: LaunchPlatformPrimitive,
  metadata: PrimitiveMetadata,
  query: string,
): number {
  const text = `${primitive} ${metadata.label} ${metadata.description}`
    .toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const matches = terms.filter((term) => text.includes(term)).length;
  return matches / terms.length;
}

function parseManifest(value: unknown): AppManifest | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as AppManifest;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as AppManifest;
  return null;
}

async function readJsonBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new RequestValidationError("Invalid JSON body");
  }
}

async function readOptionalJsonBody<T>(
  request: Request,
): Promise<Partial<T>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Partial<T>;
  } catch {
    throw new RequestValidationError("Invalid JSON body");
  }
}

function forwardRuntimeHeaders(request: Request): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");
  const forwardedFor = request.headers.get("x-forwarded-for");
  const realIp = request.headers.get("x-real-ip");
  if (authorization) headers.set("Authorization", authorization);
  if (cookie) headers.set("Cookie", cookie);
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  if (realIp) headers.set("x-real-ip", realIp);
  return headers;
}

function toLaunchApiKeySummary(token: ApiToken): LaunchApiKeySummary {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.token_prefix,
    scopes: token.scopes || [],
    appIds: token.app_ids,
    functionNames: token.function_names,
    lastUsedAt: token.last_used_at,
    expiresAt: token.expires_at,
    createdAt: token.created_at,
  };
}

function requireAccountSessionForApiKeys(user: AuthUser): void {
  if (
    user.authSource === "api_token" ||
    user.authSource === "routine_actor" ||
    user.authSource === "sandbox_actor"
  ) {
    throw new RequestValidationError(
      "API key management requires an account session",
      403,
    );
  }
}

function requireAccountSessionForWalletFunding(user: AuthUser): void {
  if (
    user.authSource === "api_token" ||
    user.authSource === "routine_actor" ||
    user.authSource === "sandbox_actor"
  ) {
    throw new RequestValidationError(
      "Wallet funding requires an account session",
      403,
    );
  }
}

function requireAccountSessionForAgentPermissions(user: AuthUser): void {
  if (
    user.authSource === "api_token" ||
    user.authSource === "routine_actor" ||
    user.authSource === "sandbox_actor"
  ) {
    throw new RequestValidationError(
      "Agent permission management requires an account session",
      403,
    );
  }
}

function requireAccountSessionForFunctionRun(user: AuthUser): void {
  if (
    user.authSource === "api_token" ||
    user.authSource === "routine_actor" ||
    user.authSource === "sandbox_actor"
  ) {
    throw new RequestValidationError(
      "Launch website function runs require an account session",
      403,
    );
  }
}

function requireAccountSessionForByok(user: AuthUser): void {
  if (
    user.authSource === "api_token" ||
    user.authSource === "routine_actor" ||
    user.authSource === "sandbox_actor"
  ) {
    throw new RequestValidationError(
      "BYOK and inference settings require an account session",
      403,
    );
  }
}

interface LaunchByokProviderEntry {
  provider: ActiveBYOKProvider;
  info: BYOKProviderInfo;
}

function resolveLaunchByokProvider(
  value: unknown,
): LaunchByokProviderEntry | null {
  if (!isActiveBYOKProvider(value)) {
    return null;
  }
  return { provider: value, info: BYOK_PROVIDERS[value] };
}

function normalizeLaunchByokModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RequestValidationError("model must be a string");
  }
  if (!isValidModelId(value)) {
    throw new RequestValidationError(
      `Invalid model ID format: ${value}. Expected a provider-native model ID`,
    );
  }
  return value;
}

function parseLaunchApiKeyCreateRequest(
  body: Record<string, unknown>,
): LaunchApiKeyCreateRequest {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    throw new RequestValidationError("API key name is required");
  }
  if (name.length > 50) {
    throw new RequestValidationError(
      "API key name must be 50 characters or less",
    );
  }

  const expiresValue = body.expiresInDays ?? body.expires_in_days;
  let expiresInDays: number | undefined;
  if (expiresValue !== undefined) {
    if (
      typeof expiresValue !== "number" ||
      !Number.isInteger(expiresValue) ||
      expiresValue < 1 ||
      expiresValue > 365
    ) {
      throw new RequestValidationError(
        "expiresInDays must be an integer between 1 and 365",
      );
    }
    expiresInDays = expiresValue;
  }

  const scopes = optionalStringArray(body.scopes, "scopes");
  const appIds = optionalStringArray(body.appIds ?? body.app_ids, "appIds");
  const functionNames = optionalStringArray(
    body.functionNames ?? body.function_names,
    "functionNames",
  );

  return {
    name,
    ...(expiresInDays !== undefined ? { expiresInDays } : {}),
    ...(scopes !== undefined ? { scopes } : {}),
    ...(appIds !== undefined ? { appIds } : {}),
    ...(functionNames !== undefined ? { functionNames } : {}),
  };
}

function parseLaunchWalletFundingIntentRequest(
  body: Record<string, unknown>,
): ParsedLaunchWalletFundingIntentRequest {
  const amountCredits = normalizeLaunchFundingAmountLight(
    body.amountCredits ?? body.amount_credits ??
      body.amountLight ?? body.amount_light,
  );
  const method = normalizeLaunchFundingMethod(body.method);
  const termsAccepted = body.termsAccepted ?? body.terms_accepted;
  if (termsAccepted !== true) {
    throw new RequestValidationError(
      "terms_accepted must be true to add credits",
    );
  }

  const billingAddressValue = body.billingAddress ?? body.billing_address;
  const billingAddress = billingAddressValue === undefined
    ? undefined
    : validateBillingAddressValue(billingAddressValue);

  return {
    amountCredits,
    amountLight: amountCredits,
    method,
    termsAccepted: true,
    ...(billingAddress ? { billingAddress } : {}),
  };
}

function optionalStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new RequestValidationError(`${field} must be an array of strings`);
  }
  const normalized = value.map((entry) =>
    typeof entry === "string" ? entry.trim() : ""
  );
  if (normalized.some((entry) => !entry)) {
    throw new RequestValidationError(
      `${field} must be an array of non-empty strings`,
    );
  }
  return normalized;
}

function parseApiKeyId(encodedId: string): string {
  const id = decodeURIComponent(encodedId).trim();
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) {
    throw new RequestValidationError("Invalid API key id");
  }
  return id;
}

function parseFunctionName(encodedName: string): string {
  const name = decodeURIComponent(encodedName).trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(name)) {
    throw new RequestValidationError("Invalid function name");
  }
  return name;
}

function parseKind(value: string | null): LaunchAgentKind | "all" {
  if (!value || value === "all") return "all";
  if (
    value === "mcp" || value === "http" || value === "markdown" ||
    value === "gpu"
  ) {
    return value;
  }
  throw new RequestValidationError(
    "kind must be one of: all, mcp, http, markdown, gpu",
  );
}

function parseLeaderboardKind(value: string | null): LaunchLeaderboardKind {
  if (!value || value === "builder") return "builder";
  if (value === "fee_credit") return "fee_credit";
  if (value === "agent_fee_credit") return "agent_fee_credit";
  throw new RequestValidationError(
    "kind must be one of: builder, fee_credit, agent_fee_credit",
  );
}

function parseLeaderboardPeriod(value: string | null): "30d" | "90d" | "all" {
  if (!value || value === "30d") return "30d";
  if (value === "90d" || value === "all") return value;
  throw new RequestValidationError("period must be one of: 30d, 90d, all");
}

function normalizeLeaderboardUrl(url: URL): URL {
  const normalized = new URL(url.toString());
  normalized.searchParams.delete("kind");
  return normalized;
}

function normalizeQuery(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

function clampLimit(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new RequestValidationError("limit must be an integer");
  }
  if (parsed < 1 || parsed > MAX_DISCOVERY_LIMIT) {
    throw new RequestValidationError(
      `limit must be between 1 and ${MAX_DISCOVERY_LIMIT}`,
    );
  }
  return parsed;
}

function parseLocator(encodedLocator: string): string {
  const locator = decodeURIComponent(encodedLocator).trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(locator)) {
    throw new RequestValidationError("Invalid tool id");
  }
  return locator;
}

async function tryAuthenticate(request: Request): Promise<AuthUser | null> {
  try {
    return await authenticate(request) as AuthUser;
  } catch {
    return null;
  }
}

async function requireLaunchUser(request: Request): Promise<AuthUser> {
  try {
    return await authenticate(request) as AuthUser;
  } catch {
    throw new RequestValidationError("Authentication required", 401);
  }
}

function getDbConfig(): DbConfig {
  const baseUrl = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!baseUrl || !key) {
    throw new LaunchServiceUnavailableError("Launch data service unavailable");
  }
  return {
    baseUrl,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

async function dbGet<T>(
  db: DbConfig,
  table: string,
  params: Record<string, string>,
): Promise<T[]> {
  const url = new URL(`${db.baseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), { headers: db.headers });
  return await readRows<T>(response, `Failed to fetch ${table}`);
}

async function readRows<T>(response: Response, message: string): Promise<T[]> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail ? `${message}: ${detail}` : message);
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload as T[] : [payload as T];
}

function publicBaseUrl(request: Request): string {
  const configured = getEnv("BASE_URL");
  const origin = configured || new URL(request.url).origin;
  return origin.replace(/\/+$/, "");
}

function money(credits: number): LaunchMoneyAmount {
  const normalized = Number.isFinite(credits) ? credits : 0;
  return {
    credits: normalized,
    light: normalized,
    display: `${normalized.toLocaleString("en-US")} credits`,
  };
}

function withLaunchFundingCreditsAliases(
  quote: LaunchWalletFundingFeeSummary,
): LaunchWalletFundingFeeSummary {
  return {
    ...quote,
    amountCredits: quote.amountCredits ?? quote.amountLight,
    amountLight: quote.amountLight ?? quote.amountCredits,
    creditsPerDollar: 100,
    lightPerDollar: 100,
  };
}

function vectorString(embedding: number[]): string {
  return `[${embedding.filter(Number.isFinite).join(",")}]`;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index++) {
    const a = left[index];
    const b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function roundScore(value: unknown): number {
  const number = numeric(value);
  return Math.round(number * 10_000) / 10_000;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
