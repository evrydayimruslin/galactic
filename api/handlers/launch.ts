// Launch API facade
// Thin MVP-facing endpoints for the external-agent-first website.

import { authenticate } from "./auth.ts";
import { handleRun } from "./run.ts";
import { error, json } from "./response.ts";
import { getEnv } from "../lib/env.ts";
import {
  getAgentFeeWaiverLeaderboard,
  getFeeWaiverLeaderboard,
  parseFeeWaiverLeaderboardQuery,
} from "../services/fee-waivers.ts";
import { getOrCreatePublisherReferralLink } from "../services/referrals.ts";
import {
  isGpuSupportEnabled,
  sanitizeGpuTrustCard,
} from "../services/gpu/feature-flag.ts";
import { buildAppTrustCard } from "../services/trust.ts";
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
  LAUNCH_CALLER_FUNCTION_POLICIES,
  LAUNCH_API_ROUTES,
  LAUNCH_DEFERRED_CAPABILITIES,
  LAUNCH_INCLUDED_CAPABILITIES,
  LAUNCH_INSTALL_TARGETS,
  LAUNCH_MVP_VERSION,
  LAUNCH_PLATFORM_PRIMITIVES,
  LAUNCH_PUBLIC_ROUTES,
  LAUNCH_SCOPE_CONTRACT,
  type LaunchCallerFunctionPermissionsResponse,
  type LaunchCallerFunctionPermissionsUpdateRequest,
  type LaunchApiKeyCreateRequest,
  type LaunchApiKeySummary,
  type LaunchApiRoute,
  type LaunchByokMutationResponse,
  type LaunchByokProviderOption,
  type LaunchByokSummaryResponse,
  type LaunchDiscoveryRetrievalSummary,
  type LaunchDiscoverySource,
  type LaunchFunctionRunRequest,
  type LaunchFunctionRunResponse,
  type LaunchJobStatusResponse,
  type LaunchFunctionSummary,
  type LaunchInferenceOptionsResponse,
  type LaunchInstallInstruction,
  type LaunchInstallResponse,
  type LaunchLeaderboardEntry,
  type LaunchLeaderboardKind,
  type LaunchLeaderboardResponse,
  type LaunchMoneyAmount,
  type LaunchPayoutStatus,
  type LaunchPlatformPrimitive,
  type LaunchPlatformPrimitiveSuggestion,
  type LaunchPricingSummary,
  type LaunchPublicRoute,
  type LaunchRelevanceSummary,
  type LaunchSemanticSubjectType,
  type LaunchAgentAdminSummary,
  type LaunchAgentFunctionsResponse,
  type LaunchAgentInstallContext,
  type LaunchAgentKind,
  type LaunchAgentOwnerSummary,
  type LaunchAgentRelationship,
  type LaunchAgentSummary,
  type LaunchInterfaceSummary,
  type LaunchAgentVisibility,
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
} from "../../shared/contracts/launch.ts";
import type { AppManifest } from "../../shared/contracts/manifest.ts";
import {
  BYOK_PROVIDERS,
  isActiveBYOKProvider,
} from "../../shared/types/index.ts";
import type {
  ActiveBYOKProvider,
  BYOKProviderInfo,
  RunResponse,
} from "../../shared/types/index.ts";
import { createUserService } from "../services/user.ts";
import { validateAPIKey } from "../services/ai.ts";
import { checkChatBalance } from "../services/chat-billing.ts";
import { CHAT_MIN_BALANCE_LIGHT } from "../../shared/contracts/ai.ts";
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
  LaunchWalletFundingError,
} from "../services/stripe-launch-wallet-funding.ts";
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

// Cross-Agent grant + settings mutations are sensitive. The SensitiveRoute enum
// lives in sensitive-route-rate-limit.ts (outside this file's edit scope), so we
// reuse the closest existing user-scoped settings-mutation key rather than
// adding dedicated launch:grant_write / launch:settings_write keys. See the
// orchestrator leftovers note.
const LAUNCH_GRANT_WRITE_LIMIT: SensitiveRoute = "apps:user_settings_update";
const LAUNCH_GRANT_SETTINGS_WRITE_LIMIT: SensitiveRoute =
  "apps:user_settings_update";

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
    label: "Install Ultralight",
    description: "Connect the Ultralight MCP/API layer to an existing agent.",
    route: "/",
    apiRoute: "GET /api/launch/install",
  },
  deploy: {
    label: "Deploy an Agent",
    description: "Ship deployable Agent code onto hosted Ultralight runtime.",
    route: "/",
    apiRoute: "GET /api/launch/install",
  },
  publish: {
    label: "Publish for discovery",
    description: "Make a deployed Agent public or unlisted for installs.",
    route: "/admin/agents/:id",
    apiRoute: "GET /api/launch/admin/agents/:id",
  },
  store: {
    label: "Browse",
    description: "Find public Agents.",
    route: "/browse",
    apiRoute: "GET /api/launch/store",
  },
  wallet: {
    label: "Credits wallet",
    description: "Manage spendable credits for installs, calls, and hosting.",
    route: "/account",
    apiRoute: "GET /api/launch/wallet",
  },
  pricing: {
    label: "Agent pricing",
    description: "Inspect per-call pricing and free-call configuration.",
    route: "/admin/agents/:id",
    apiRoute: "GET /api/launch/admin/agents/:id",
  },
  receipts: {
    label: "Receipts",
    description: "Track monetized Agent usage and marketplace receipts.",
    route: "/admin/agents/:id",
    apiRoute: "GET /api/launch/admin/agents/:id",
  },
  api_keys: {
    label: "API keys",
    description: "Create API tokens for MCP, CLI, and direct API access.",
    route: "/account",
    apiRoute: "GET /api/launch/api-keys",
  },
  owner_admin: {
    label: "Owner admin",
    description: "Manage visibility, pricing, logs, and receipts.",
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

export async function handleLaunch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizeLaunchApiPath(url.pathname);
  const method = request.method;

  try {
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

    if (
      path === "/api/launch/grants" ||
      path.startsWith("/api/launch/grants/")
    ) {
      return await handleLaunchGrants(request, path, method);
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
      const { getJob } = await import("../services/async-jobs.ts");
      const job = await getJob(jobId, user.id);
      if (!job) return error("Job not found", 404);
      return json({
        jobId: job.id,
        status: job.status,
        result: job.status === "completed" ? job.result : null,
        error: job.status === "failed" ? job.error : null,
        durationMs: job.duration_ms,
        aiCostCredits: job.ai_cost_light,
        executionId: job.execution_id || null,
        createdAt: job.created_at,
        completedAt: job.completed_at,
        generatedAt: new Date().toISOString(),
      } satisfies LaunchJobStatusResponse);
    }

    if (path === "/api/launch/settings") {
      return await handleLaunchSettings(request, method);
    }

    const agentWiringMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/wiring$/,
    );
    if (agentWiringMatch) {
      return await handleLaunchAgentWiring(request, agentWiringMatch[1], method);
    }

    const callerTrustMatch = path.match(
      /^\/api\/launch\/agents\/([^/]+)\/caller-trust$/,
    );
    if (callerTrustMatch) {
      return await handleLaunchCallerTrust(request, callerTrustMatch[1], method);
    }

    if (path === "/api/launch/wallet/topup/intent") {
      if (method !== "POST") {
        return error("Method not allowed for launch wallet top-up intent", 405);
      }
      return await handleLaunchWalletTopUpIntent(request);
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

function buildLaunchStatus(request: Request): Record<string, unknown> {
  const baseUrl = publicBaseUrl(request);
  return {
    available: true,
    version: LAUNCH_MVP_VERSION,
    thesis: LAUNCH_SCOPE_CONTRACT.thesis,
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
      // Deprecated alias keys kept for one rename window.
      toolFunctions: "/api/launch/agents/{id}/functions",
      functionRun: "/api/launch/agents/{id}/functions/{functionName}/run",
      jobStatus: "/api/launch/jobs/{jobId}",
      callerPermissions: "/api/launch/agents/{id}/caller-permissions",
      agentPermissions: "/api/launch/agents/{id}/caller-permissions",
      wiring: "/api/launch/agents/{id}/wiring",
      callerTrust: "/api/launch/agents/{id}/caller-trust",
      grants: "/api/launch/grants?caller={callerId}&target={targetId}&status={status}",
      wiringTargets: "/api/launch/wiring/targets?q={query}",
      settings: "/api/launch/settings",
      platformPrimitives: "/api/launch/platform-primitives?q={query}",
      leaderboard: "/api/launch/leaderboard?kind=builder&period=30d",
      wallet: "/api/launch/wallet",
      walletTransactions:
        "/api/launch/wallet/transactions?limit=25&cursor={cursor}",
      walletReceipts: "/api/launch/wallet/receipts?limit=25&cursor={cursor}",
      walletEarnings:
        "/api/launch/wallet/earnings?agent={agentId}&limit=25&cursor={cursor}",
      walletPayouts: "/api/launch/wallet/payouts?limit=25&cursor={cursor}",
      walletTopUpQuote:
        "/api/launch/wallet/topup/quote?amount_credits=2500&method=card",
      walletTopUpIntent: "/api/launch/wallet/topup/intent",
      mcpPlatform: "/mcp/platform",
      mcpDiscovery: "/.well-known/mcp.json",
      website: "/",
    },
    externalAgentLoop: [
      "Install Ultralight MCP, CLI, or direct API access.",
      "Browse the store for relevant Agents and platform primitives.",
      "Inspect Agent functions, pricing, and trust.",
      "Call Agents through MCP/API and return public Agent links when UI matters.",
      "Preserve credit receipts and errors in the final response.",
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

  return {
    openapi: "3.1.0",
    info: {
      title: "Ultralight Launch API",
      description:
        "Launch-scoped API facade for existing agents to install, discover, inspect, compose, and pay for Ultralight Agents.",
      version: LAUNCH_MVP_VERSION,
      contact: { name: "Ultralight", url: baseUrl },
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
            "Authenticated account-session endpoint. Functions declared async (or run with _async: true) return { _async: true, job_id, status: \"queued\" } from the run endpoint; poll this endpoint with that job_id until status is completed or failed. Jobs are user-scoped.",
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
          summary: "Call the Ultralight platform MCP JSON-RPC endpoint",
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
            "credits",
          ],
          properties: {
            billingMode: { type: "string", enum: ["byok", "credits"] },
            primaryProvider: { type: ["string", "null"] },
            configuredProviders: {
              type: "array",
              items: { type: "string" },
            },
            credits: {
              type: "object",
              required: [
                "spendable",
                "minimumForPlatformInference",
                "usable",
                "display",
              ],
              properties: {
                spendable: { type: ["number", "null"] },
                minimumForPlatformInference: { type: "number" },
                usable: { type: "boolean" },
                display: { type: "string" },
              },
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
                "Function return value. Async-declared functions (or _async: true runs) instead return { _async: true, job_id, status: \"queued\" } — poll /api/launch/jobs/{jobId}.",
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
        ToolSummary: {
          type: "object",
          properties: {
            id: { type: "string" },
            slug: { type: "string" },
            name: { type: "string" },
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
      includedCapabilities: LAUNCH_INCLUDED_CAPABILITIES,
      deferredCapabilities: LAUNCH_DEFERRED_CAPABILITIES,
      publicRoutes: LAUNCH_PUBLIC_ROUTES,
      compatibilityPublicRoutes:
        LAUNCH_SCOPE_CONTRACT.compatibilityPublicRoutes,
      apiRoutes: LAUNCH_API_ROUTES,
    },
  };
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
          await setUserDisplayName(user.id, trimmed.length > 0 ? trimmed : null);
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
  const billingMode = profile.byok_enabled && primaryConfigured
    ? "byok"
    : "credits";

  let spendable: number | null = null;
  try {
    spendable = await checkChatBalance(user.id);
  } catch (err) {
    console.error("[LAUNCH] Inference options balance check failed:", err);
    spendable = null;
  }
  const usable = spendable !== null && spendable >= CHAT_MIN_BALANCE_LIGHT;

  return json(
    {
      billingMode,
      primaryProvider: profile.byok_provider,
      configuredProviders,
      credits: {
        spendable,
        minimumForPlatformInference: CHAT_MIN_BALANCE_LIGHT,
        usable,
        display: money(spendable ?? 0).display,
      },
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
  const [ownedRows, installedIds] = await Promise.all([
    fetchOwnedApps(user.id),
    fetchInstalledIds(user.id),
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

  return json({
    owned: ownedRows.map((row) =>
      toLaunchAgentSummary(row, {
        owners,
        viewerId: user.id,
        installedIds,
      })
    ),
    installed: installedRows.map((row) =>
      toLaunchAgentSummary(row, {
        owners,
        viewerId: user.id,
        installedIds,
      })
    ),
    generatedAt: new Date().toISOString(),
  });
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
    trustCard: buildLaunchTrustCard(row),
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
    trustCard: buildLaunchTrustCard(row),
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
    canTopUp: true,
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
  const bearer = "Bearer $ULTRALIGHT_API_KEY";
  const genericConfig = {
    mcpServers: {
      ultralight: {
        url: mcpUrl,
        headers: { Authorization: bearer },
      },
    },
  };
  const claudeCodeAddCommand =
    `claude mcp add --transport http --scope user ultralight ${mcpUrl} --header "Authorization: ${bearer}"`;
  const connectPrompt = [
    "Set up Ultralight for me, then start using it.",
    "",
    "Ultralight is one MCP server that gives you a library of Agents (apps) you can discover, call, and deploy, with unified auth and per-call payments.",
    "",
    "1. Install the MCP server (pick whichever works in your environment):",
    `   - Claude Code: ${claudeCodeAddCommand}`,
    `   - Any MCP config file: ${JSON.stringify(genericConfig)}`,
    "   - Automated installer: npx ultralightagent setup --token $ULTRALIGHT_API_KEY",
    "",
    "2. Connect, then learn the platform: the server's initialize response carries the full platform guide. The same docs live at the ultralight://platform/skills.md MCP resource" +
    ` and ${baseUrl}/api/skills.`,
    "",
    '3. Prove it works: call gx.discover with {"scope":"library"} to list the Agents already installed on this account, then tell me in a few lines what you can now do for me.',
    "",
    "Treat the API key in this prompt as a secret: never echo it back, log it, or commit it anywhere.",
  ].join("\n");

  return [
    {
      target: "prompt",
      label: "Agent prompt",
      description:
        "One prompt that makes any agent install Ultralight itself and start using it.",
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
        "Add Ultralight as a remote MCP server for an existing Claude Code workspace.",
      steps: [
        "Create an Ultralight API token from Settings.",
        "Run the command below with your token in place of $ULTRALIGHT_API_KEY.",
        "Run /mcp (or restart) so Claude Code picks up the ultralight server.",
      ],
      configText: claudeCodeAddCommand,
      requiresApiKey: true,
    },
    {
      target: "cursor",
      label: "Cursor",
      description:
        "Install the Ultralight MCP server in Cursor's MCP configuration.",
      steps: [
        "Open Cursor MCP settings.",
        "Add the ultralight server entry below.",
        "Reload Cursor so it can discover Ultralight Agents.",
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
        "Create an Ultralight API token.",
        "Add a remote MCP server named ultralight.",
        "Use the platform MCP endpoint and Authorization header below.",
      ],
      configText:
        `[mcp_servers.ultralight]\nurl = "${mcpUrl}"\nheaders = { Authorization = "${bearer}" }`,
      requiresApiKey: true,
    },
    {
      target: "openai_remote_mcp",
      label: "OpenAI Remote MCP",
      description:
        "Register Ultralight as a remote MCP server for OpenAI agent runtimes that support MCP tools.",
      steps: [
        "Use the platform MCP endpoint as the server URL.",
        "Pass your Ultralight API token as a bearer Authorization header.",
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
        "Replace the API token placeholder with an Ultralight API token.",
        "Restart your connected agent or refresh its MCP tool list.",
      ],
      configText: JSON.stringify(genericConfig, null, 2),
      requiresApiKey: true,
    },
    {
      target: "cli",
      label: "CLI",
      description:
        "Use the existing Ultralight CLI to login, upload, test, and run deployed Agents.",
      steps: [
        "Install the ultralightagent package or use the local CLI during development.",
        "Run ultralight login --token <your-token>.",
        "Run ultralight upload . from a deployable Agent directory.",
      ],
      configText:
        "npm install -g ultralightagent\nultralight login --token <your-token>\nultralight upload .",
      requiresApiKey: true,
    },
    {
      target: "api",
      label: "Direct API",
      description:
        "Call launch and platform endpoints directly with an Ultralight API token.",
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
  const installUrl = `${baseUrl}/install?agent=${encodeURIComponent(tool.slug)}`;
  // The dedicated endpoint is uuid-addressed: /mcp/:appId resolves ids only,
  // and uuids stay unambiguous (slugs are only unique per owner).
  const agentMcpUrl = `${baseUrl}/mcp/${tool.id}`;
  const bearer = "Bearer $ULTRALIGHT_API_KEY";
  const agentMcpConfig = {
    mcpServers: {
      [tool.slug]: {
        url: agentMcpUrl,
        headers: { Authorization: bearer },
      },
    },
  };
  const connectPrompt = [
    `Set up the "${tool.name}" Agent from Ultralight for me, then start using it.`,
    "",
    `"${tool.name}" is an Agent hosted on Ultralight. Connect to it as a standalone MCP server; the API key below is scoped to this Agent only.`,
    "",
    "1. Install the MCP server (pick whichever works in your environment):",
    `   - Claude Code: claude mcp add --transport http --scope user ${tool.slug} ${agentMcpUrl} --header "Authorization: ${bearer}"`,
    `   - Any MCP config file: ${JSON.stringify(agentMcpConfig)}`,
    "",
    `2. Connect, then run tools/list to see what "${tool.name}" can do. ${publicToolUrl} documents pricing and trust.`,
    "",
    `3. Prove it works: pick its most representative read-only function and call it, then tell me in a few lines how you can use "${tool.name}" for me going forward.`,
    "",
    "Calls may spend credits from my Ultralight wallet: preserve receipt_id values and surface any credits-balance errors. Treat the API key as a secret: never echo it back, log it, or commit it anywhere.",
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
      `Inspect ${publicToolUrl} for pricing and trust.`,
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
  const accessPolicy = accessPolicySummaryForTool(row);

  return names.map((name) => {
    const functionDef = asRecord(manifestFunctions[name]);
    return {
      name,
      description: stringOrNull(functionDef?.description),
      inputSchema: inputSchemaForFunction(functionDef),
      outputSchema: outputSchemaForFunction(functionDef),
      pricing: pricingSummaryForFunction(row, name),
      accessPolicy,
      callerPermission: permissionByFunction.get(name) || null,
      // Deprecated alias kept for one rename window.
      agentPermission: permissionByFunction.get(name) || null,
    };
  });
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
  return {
    id: row.id,
    slug,
    name: row.name || slug,
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
  };
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
      url: `${sandboxBaseUrl}/i/${encodeURIComponent(row.id)}/${declaration.hash}`,
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

function buildLaunchTrustCard(row: LaunchAppRow): LaunchTrustCard {
  return sanitizeGpuTrustCard(buildAppTrustCard({
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
  } as never) as LaunchTrustCard);
}

function shouldHideGpu(row: LaunchAppRow): boolean {
  return row.runtime === "gpu" && !isGpuSupportEnabled();
}

function matchesKind(row: LaunchAppRow, kind: LaunchAgentKind | "all"): boolean {
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
    `Ultralight platform primitive: ${primitive}`,
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
