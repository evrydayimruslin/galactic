export const LAUNCH_MVP_VERSION = "launch-mvp-v1" as const;

export const LAUNCH_INCLUDED_CAPABILITIES = [
  "install",
  "tool_library",
  "tool_discovery",
  "public_tool_pages",
  "owner_admin",
  "credits_wallet",
  "byok",
  "builder_leaderboard",
  "fee_credit_leaderboard",
  "launch_embeddings",
  "cli_api_mcp",
] as const;

export type LaunchIncludedCapability =
  typeof LAUNCH_INCLUDED_CAPABILITIES[number];

export const LAUNCH_DEFERRED_CAPABILITIES = [
  "desktop",
  "web_search",
  "cerebras",
  "standalone_agent",
  "command_cards",
  "command_dashboards",
  "agentic_ui_composer",
  "routines",
  "tool_builder_agent",
] as const;

export type LaunchDeferredCapability =
  typeof LAUNCH_DEFERRED_CAPABILITIES[number];

export const LAUNCH_PUBLIC_ROUTES = [
  "/",
  "/install",
  "/library",
  "/store",
  "/agents/:slug",
  "/wallet",
  "/settings",
  "/admin/agents/:id",
] as const;

export type LaunchPublicRoute = typeof LAUNCH_PUBLIC_ROUTES[number];

export const LAUNCH_COMPATIBILITY_PUBLIC_ROUTES = [
  "/discover",
  "/tools/:slug",
  "/admin/tools/:id",
] as const;

export type LaunchCompatibilityPublicRoute =
  typeof LAUNCH_COMPATIBILITY_PUBLIC_ROUTES[number];

export const LAUNCH_API_ROUTES = [
  "GET /api/launch/status",
  "GET /api/launch/openapi.json",
  "GET /api/launch/install",
  "GET /api/launch/api-keys",
  "POST /api/launch/api-keys",
  "DELETE /api/launch/api-keys/:id",
  "GET /api/launch/byok",
  "PUT /api/launch/byok/:provider",
  "DELETE /api/launch/byok/:provider",
  "POST /api/launch/byok/primary",
  "GET /api/launch/inference-options",
  "GET /api/launch/library",
  "GET /api/launch/store",
  "GET /api/launch/discover",
  "GET /api/launch/agents/:id",
  "GET /api/launch/agents/:id/functions",
  "POST /api/launch/agents/:id/functions/:functionName/run",
  "GET /api/launch/agents/:id/caller-permissions",
  "PATCH /api/launch/agents/:id/caller-permissions",
  "GET /api/launch/admin/agents/:id",
  "GET /api/launch/agents/:id/wiring",
  "GET /api/launch/agents/:id/caller-trust",
  "GET /api/launch/grants",
  "POST /api/launch/grants",
  "PATCH /api/launch/grants/:id",
  "POST /api/launch/grants/:id/approve",
  "DELETE /api/launch/grants/:id",
  "GET /api/launch/wiring/targets",
  "GET /api/launch/settings",
  "PATCH /api/launch/settings",
  "GET /api/launch/wallet",
  "GET /api/launch/wallet/transactions",
  "GET /api/launch/wallet/receipts",
  "GET /api/launch/wallet/earnings",
  "GET /api/launch/wallet/payouts",
  "GET /api/launch/wallet/topup/quote",
  "POST /api/launch/wallet/topup/intent",
  "GET /api/launch/leaderboard",
  "GET /api/launch/platform-primitives",
] as const;

export type LaunchApiRoute = typeof LAUNCH_API_ROUTES[number];

// Legacy request paths from the Tools -> Agents rename. The facade still
// serves them (normalized to the canonical /agents/caller-permissions
// paths); removal is scheduled one release window after clients migrate.
export const LAUNCH_COMPATIBILITY_API_ROUTES = [
  "GET /api/launch/tools/:id",
  "GET /api/launch/tools/:id/functions",
  "POST /api/launch/tools/:id/functions/:functionName/run",
  "GET /api/launch/tools/:id/agent-permissions",
  "PATCH /api/launch/tools/:id/agent-permissions",
  "GET /api/launch/admin/tools/:id",
] as const;

export type LaunchCompatibilityApiRoute =
  typeof LAUNCH_COMPATIBILITY_API_ROUTES[number];

export const LAUNCH_INSTALL_TARGETS = [
  "prompt",
  "claude_code",
  "cursor",
  "codex",
  "openai_remote_mcp",
  "generic_mcp",
  "cli",
  "api",
] as const;

export type LaunchInstallTarget = typeof LAUNCH_INSTALL_TARGETS[number];

export const LAUNCH_AGENT_RELATIONSHIPS = [
  "owner",
  "installed",
  "public",
] as const;

export type LaunchAgentRelationship = typeof LAUNCH_AGENT_RELATIONSHIPS[number];

export const LAUNCH_AGENT_KINDS = [
  "mcp",
  "http",
  "markdown",
  "gpu",
] as const;

export type LaunchAgentKind = typeof LAUNCH_AGENT_KINDS[number];

export const LAUNCH_AGENT_VISIBILITIES = [
  "public",
  "private",
  "unlisted",
] as const;

export type LaunchAgentVisibility = typeof LAUNCH_AGENT_VISIBILITIES[number];

export const LAUNCH_LEADERBOARD_KINDS = [
  "builder",
  "fee_credit",
] as const;

export type LaunchLeaderboardKind = typeof LAUNCH_LEADERBOARD_KINDS[number];

export const LAUNCH_PLATFORM_PRIMITIVES = [
  "install",
  "deploy",
  "publish",
  "store",
  "wallet",
  "pricing",
  "receipts",
  "api_keys",
  "owner_admin",
] as const;

export type LaunchPlatformPrimitive = typeof LAUNCH_PLATFORM_PRIMITIVES[number];

export interface LaunchScopeContract {
  version: typeof LAUNCH_MVP_VERSION;
  thesis: string;
  includedCapabilities: readonly LaunchIncludedCapability[];
  deferredCapabilities: readonly LaunchDeferredCapability[];
  publicRoutes: readonly LaunchPublicRoute[];
  compatibilityPublicRoutes: readonly LaunchCompatibilityPublicRoute[];
  apiRoutes: readonly LaunchApiRoute[];
}

export interface LaunchInstallInstruction {
  target: LaunchInstallTarget;
  label: string;
  description: string;
  steps: string[];
  configText?: string;
  docsUrl?: string;
  requiresApiKey: boolean;
}

export interface LaunchAgentInstallContext {
  agent: LaunchAgentSummary;
  /** @deprecated Use agent. */
  tool: LaunchAgentSummary;
  selectedAgentSlug: string;
  /** @deprecated Use selectedAgentSlug. */
  selectedToolSlug: string;
  publicAgentUrl: string;
  /** @deprecated Use publicAgentUrl. */
  publicToolUrl: string;
  installUrl: string;
  platformMcpUrl: string;
  /** Dedicated MCP endpoint for this Agent (uuid-addressed). */
  agentMcpUrl: string;
  /** mcp.json snippet for the dedicated endpoint ($ULTRALIGHT_API_KEY placeholder). */
  mcpConfigText: string;
  /** Paste-into-agent prompt for this Agent ($ULTRALIGHT_API_KEY placeholder). */
  connectPrompt: string;
  recommendedApiKey: LaunchApiKeyCreateRequest;
  agentHandoff: string[];
}

export interface LaunchInstallResponse {
  instructions: LaunchInstallInstruction[];
  agentInstall?: LaunchAgentInstallContext | null;
  /** @deprecated Use agentInstall. */
  toolInstall?: LaunchAgentInstallContext | null;
  generatedAt: string;
}

export interface LaunchApiKeySummary {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  appIds?: string[] | null;
  functionNames?: string[] | null;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
}

export interface LaunchApiKeyCreateRequest {
  name: string;
  expiresInDays?: number;
  scopes?: string[];
  appIds?: string[];
  functionNames?: string[];
}

export interface LaunchApiKeyListResponse {
  apiKeys: LaunchApiKeySummary[];
  generatedAt: string;
}

export interface LaunchApiKeyCreateResponse {
  success: true;
  apiKey: LaunchApiKeySummary;
  plaintextToken: string;
  message: string;
  generatedAt: string;
}

export interface LaunchApiKeyDeleteResponse {
  success: true;
  revokedId: string;
  message: string;
  generatedAt: string;
}

export const LAUNCH_CALLER_FUNCTION_POLICIES = [
  "always",
  "ask",
  "never",
] as const;

export type LaunchCallerFunctionPolicy =
  typeof LAUNCH_CALLER_FUNCTION_POLICIES[number];

export const LAUNCH_WALLET_FUNDING_METHODS = [
  "card",
  "ach",
] as const;

export type LaunchWalletFundingMethod =
  typeof LAUNCH_WALLET_FUNDING_METHODS[number];

export interface LaunchMoneyAmount {
  credits: number;
  /** @deprecated alias of credits */
  light: number;
  display: string;
}

export interface LaunchPublisherPublishRequirement {
  enabled: boolean;
  requiredBalance: LaunchMoneyAmount;
  currentBalance: LaunchMoneyAmount;
  met: boolean;
  nextAction?: string | null;
}

export interface LaunchPricingSummary {
  defaultCallPrice?: LaunchMoneyAmount | null;
  freeToInstall: boolean;
  paidFunctionsCount?: number;
}

export interface LaunchAccessPolicySummary {
  configured: boolean;
  mode: "static" | "module";
  module: string | null;
  exportName: string;
  execution: "static_pricing" | "runtime_policy";
}

export interface LaunchFunctionSummary {
  name: string;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  pricing?: LaunchPricingSummary | null;
  accessPolicy?: LaunchAccessPolicySummary | null;
  callerPermission?: LaunchCallerFunctionPermissionSummary | null;
  /** @deprecated Use callerPermission. */
  agentPermission?: LaunchCallerFunctionPermissionSummary | null;
}

export type LaunchAgentHandle = Pick<
  LaunchAgentSummary,
  "id" | "slug" | "name" | "relationship" | "publicUrl" | "adminUrl"
>;

export interface LaunchAgentFunctionsResponse {
  agent: LaunchAgentHandle;
  /** @deprecated Use agent. */
  tool: LaunchAgentHandle;
  functions: LaunchFunctionSummary[];
  generatedAt: string;
}

export interface LaunchFunctionRunRequest {
  args?: Record<string, unknown>;
}

export interface LaunchFunctionRunWarning {
  type: string;
  message: string;
  details?: unknown;
}

export interface LaunchFunctionRunResponse {
  success: boolean;
  agent: Pick<LaunchAgentSummary, "id" | "slug" | "name">;
  /** @deprecated Use agent. */
  tool: Pick<LaunchAgentSummary, "id" | "slug" | "name">;
  functionName: string;
  result?: unknown;
  receiptId?: string | null;
  warnings?: LaunchFunctionRunWarning[];
  error?: {
    type?: string;
    message: string;
    details?: unknown;
  } | null;
  generatedAt: string;
}

export type LaunchCallerFunctionPermissionSource = "explicit" | "default";

export interface LaunchCallerFunctionPermissionSummary {
  appId: string;
  functionName: string;
  policy: LaunchCallerFunctionPolicy;
  source: LaunchCallerFunctionPermissionSource;
  updatedAt?: string | null;
}

export interface LaunchCallerFunctionPermissionUpdate {
  functionName: string;
  policy: LaunchCallerFunctionPolicy;
}

export interface LaunchCallerFunctionPermissionsResponse {
  agent: LaunchAgentHandle;
  /** @deprecated Use agent. */
  tool: LaunchAgentHandle;
  defaultPolicy: LaunchCallerFunctionPolicy;
  permissions: LaunchCallerFunctionPermissionSummary[];
  generatedAt: string;
}

export interface LaunchCallerFunctionPermissionsUpdateRequest {
  defaultPolicy?: LaunchCallerFunctionPolicy;
  permissions?: LaunchCallerFunctionPermissionUpdate[];
}

export interface LaunchCallerPermissionRequired {
  type: "permission_required";
  policy: "ask";
  appId: string;
  functionName: string;
  message: string;
  configureUrl: string;
  source?: LaunchCallerFunctionPermissionSource;
  updatedAt?: string | null;
}

export interface LaunchCallerPermissionDenied {
  type: "permission_denied";
  policy: "never";
  appId: string;
  functionName: string;
  message: string;
  configureUrl: string;
  source?: LaunchCallerFunctionPermissionSource;
  updatedAt?: string | null;
}

export interface LaunchWalletFundingPreset {
  light: number;
  label: string;
  recommended?: boolean;
}

export interface LaunchWalletFundingQuoteRequest {
  /** Wire param: amount_credits (preferred). */
  amountCredits: number;
  /** @deprecated alias of amountCredits (wire param: amount_light) */
  amountLight?: number;
  method: LaunchWalletFundingMethod;
}

export interface LaunchWalletFundingFeeSummary {
  method: LaunchWalletFundingMethod;
  methodLabel: "Card" | "Bank (ACH)";
  amountCredits: number;
  /** @deprecated alias of amountCredits */
  amountLight: number;
  creditsPerDollar: 100;
  /** @deprecated alias of creditsPerDollar */
  lightPerDollar: 100;
  baseAmountCents: number;
  processingFeeCents: number;
  totalAmountCents: number;
  feeFormula: string;
}

export interface LaunchWalletFundingQuoteResponse {
  quote: LaunchWalletFundingFeeSummary;
  presets: LaunchWalletFundingPreset[];
  generatedAt: string;
}

export interface LaunchWalletFundingIntentRequest
  extends LaunchWalletFundingQuoteRequest {
  // Required and literally `true`: this is a consent record — callers must
  // collect explicit acceptance, never default it.
  termsAccepted: true;
  billingAddress?: unknown;
  returnUrl?: string;
}

export interface LaunchWalletFundingIntentResponse {
  success: true;
  publishableKey: string;
  paymentIntentId: string;
  clientSecret: string;
  stripeCustomerId: string;
  quote: LaunchWalletFundingFeeSummary;
  billingAddress?: unknown;
  generatedAt: string;
}

export interface LaunchByokProviderOption {
  id: string;
  name: string;
  description?: string;
  configured: boolean;
  primary: boolean;
  defaultModel?: string | null;
  model?: string | null;
  apiKeyPrefix?: string | null;
  apiKeyUrl?: string | null;
  docsUrl?: string | null;
}

export interface LaunchByokSummaryResponse {
  enabled: boolean;
  primaryProvider: string | null;
  providers: LaunchByokProviderOption[];
  generatedAt?: string;
}

export interface LaunchByokUpsertRequest {
  apiKey: string;
  model?: string;
  validate?: boolean;
}

export interface LaunchByokMutationResponse {
  ok: true;
  provider: string;
  message: string;
}

export interface LaunchByokPrimaryRequest {
  provider: string;
}

export interface LaunchInferenceOptionsResponse {
  billingMode: "byok" | "credits";
  primaryProvider: string | null;
  configuredProviders: string[];
  credits: {
    spendable: number | null;
    minimumForPlatformInference: number;
    usable: boolean;
    display: string;
  };
  generatedAt?: string;
}

export type LaunchDiscoveryRetrievalMode =
  | "browse"
  | "lexical"
  | "semantic"
  | "hybrid";

export type LaunchDiscoverySource =
  | "tools"
  | "public_pages"
  | "install_docs"
  | "platform_primitives";

export type LaunchRelevanceSource = "semantic" | "lexical" | "curated";

export type LaunchSemanticSubjectType =
  | "app"
  | "function"
  | "platform_primitive";

export interface LaunchRelevanceSummary {
  source: LaunchRelevanceSource;
  score?: number | null;
  signals?: string[];
  subjectType?: LaunchSemanticSubjectType;
  subjectId?: string | null;
  subjectLabel?: string | null;
  appVersion?: string | null;
  embeddingTextHash?: string | null;
}

export interface LaunchDiscoveryRetrievalSummary {
  mode: LaunchDiscoveryRetrievalMode;
  embeddedSources: LaunchDiscoverySource[];
  fallbackSources: LaunchDiscoverySource[];
  embeddingModel?: string | null;
  fallbackReason?: string | null;
}

export interface LaunchAgentOwnerSummary {
  userId: string;
  displayName?: string | null;
  profileSlug?: string | null;
  avatarUrl?: string | null;
}

export interface LaunchAgentSummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  kind: LaunchAgentKind;
  visibility: LaunchAgentVisibility;
  relationship: LaunchAgentRelationship;
  owner: LaunchAgentOwnerSummary;
  installed: boolean;
  installUrl?: string | null;
  publicUrl?: string | null;
  adminUrl?: string | null;
  pricing?: LaunchPricingSummary;
  tags?: string[];
  updatedAt?: string | null;
  relevance?: LaunchRelevanceSummary;
}

export interface LaunchAgentAdminSummary {
  agent: LaunchAgentSummary;
  /** @deprecated Use agent. */
  tool: LaunchAgentSummary;
  editableFields: readonly (
    | "name"
    | "description"
    | "visibility"
    | "pricing"
    | "secrets"
    | "trust"
  )[];
  receiptsUrl?: string | null;
  logsUrl?: string | null;
}

export interface LaunchTrustCard {
  schema_version: 1;
  signed_manifest: boolean;
  signer: string | null;
  signed_at: string | null;
  version: string | null;
  runtime: string;
  manifest_hash: string | null;
  artifact_hash: string | null;
  artifact_count: number;
  permissions: string[];
  capability_summary: {
    ai: boolean;
    network: boolean;
    storage: boolean;
    memory: boolean;
    gpu: boolean;
  };
  required_secrets: string[];
  per_user_secrets: string[];
  access: {
    visibility: LaunchAgentVisibility;
    download_access: string | null;
  };
  reliability?: unknown;
  execution_receipts: {
    enabled: true;
    field: "receipt_id";
    backing_log: "mcp_call_logs.id";
  };
}

export interface LaunchDiscoveryRequest {
  query?: string;
  kind?: LaunchAgentKind | "all";
  limit?: number;
}

export interface LaunchDiscoveryResponse {
  query?: string | null;
  results: LaunchAgentSummary[];
  platformPrimitives?: LaunchPlatformPrimitiveSuggestion[];
  retrieval?: LaunchDiscoveryRetrievalSummary;
  generatedAt: string;
}

export type LaunchStoreRequest = LaunchDiscoveryRequest;
export type LaunchStoreResponse = LaunchDiscoveryResponse;

export interface LaunchLibraryResponse {
  owned: LaunchAgentSummary[];
  installed: LaunchAgentSummary[];
  generatedAt: string;
}

export interface LaunchPlatformPrimitiveSuggestion {
  primitive: LaunchPlatformPrimitive;
  label: string;
  description: string;
  route?: LaunchPublicRoute;
  apiRoute?: LaunchApiRoute;
  similarity?: number | null;
  relevance?: LaunchRelevanceSummary;
}

export interface LaunchWalletSummary {
  balance: LaunchMoneyAmount;
  spendableBalance: LaunchMoneyAmount;
  depositBalance?: LaunchMoneyAmount;
  earnedBalance?: LaunchMoneyAmount;
  escrowBalance?: LaunchMoneyAmount;
  canTopUp: boolean;
  topUpUrl?: string | null;
  transactionsUrl?: string | null;
  receiptsUrl?: string | null;
  earningsUrl?: string | null;
  payoutsUrl?: string | null;
  payoutStatus?: LaunchPayoutStatus | null;
  publishRequirement?: LaunchPublisherPublishRequirement | null;
  actions?: LaunchWalletAction[];
  recentTransactions?: LaunchWalletTransaction[];
  recentReceipts?: LaunchWalletReceiptSummary[];
  recentEarnings?: LaunchWalletEarningSummary[];
  recentPayouts?: LaunchWalletPayoutSummary[];
}

export type LaunchWalletDetailKind =
  | "transactions"
  | "receipts"
  | "earnings"
  | "payouts";

export interface LaunchWalletPageRequest {
  cursor?: string | null;
  limit?: number;
  /**
   * Tool id filter. Supported for receipts and earnings in the MVP launch facade.
   */
  agent?: string | null;
  /** @deprecated Use agent. */
  tool?: string | null;
}

export interface LaunchWalletPageInfo {
  limit: number;
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface LaunchWalletTransactionsResponse {
  kind: "transactions";
  items: LaunchWalletTransaction[];
  page: LaunchWalletPageInfo;
  generatedAt: string;
}

export interface LaunchWalletReceiptsResponse {
  kind: "receipts";
  items: LaunchWalletReceiptSummary[];
  page: LaunchWalletPageInfo;
  generatedAt: string;
}

export interface LaunchWalletEarningsResponse {
  kind: "earnings";
  items: LaunchWalletEarningSummary[];
  page: LaunchWalletPageInfo;
  generatedAt: string;
}

export interface LaunchWalletPayoutsResponse {
  kind: "payouts";
  items: LaunchWalletPayoutSummary[];
  page: LaunchWalletPageInfo;
  generatedAt: string;
}

export type LaunchWalletDetailResponse =
  | LaunchWalletTransactionsResponse
  | LaunchWalletReceiptsResponse
  | LaunchWalletEarningsResponse
  | LaunchWalletPayoutsResponse;

export type LaunchPayoutStatusKind =
  | "not_connected"
  | "onboarding"
  | "ready"
  | "unavailable";

export interface LaunchPayoutStatus {
  kind: LaunchPayoutStatusKind;
  label: string;
  description: string;
  actionUrl?: string | null;
}

export interface LaunchWalletAction {
  id: "topup" | "transactions" | "receipts" | "earnings" | "payouts";
  label: string;
  description: string;
  href?: string | null;
  enabled: boolean;
}

export interface LaunchWalletTransaction {
  id: string;
  type: string;
  category: string;
  description: string;
  amount: LaunchMoneyAmount;
  balanceAfter?: LaunchMoneyAmount | null;
  appId?: string | null;
  appName?: string | null;
  createdAt?: string | null;
}

export interface LaunchWalletReceiptSummary {
  receiptId: string;
  appId?: string | null;
  appName?: string | null;
  functionName?: string | null;
  success: boolean;
  total: LaunchMoneyAmount;
  appCharge: LaunchMoneyAmount;
  infraCharge: LaunchMoneyAmount;
  platformFee: LaunchMoneyAmount;
  developerNet: LaunchMoneyAmount;
  billingConfigVersion?: number | null;
  billingConfigVersions?: number[];
  createdAt?: string | null;
  receiptUrl?: string | null;
}

export interface LaunchWalletEarningSummary {
  amount: LaunchMoneyAmount;
  appId?: string | null;
  functionName?: string | null;
  reason: string;
  createdAt?: string | null;
}

export interface LaunchWalletPayoutSummary {
  id: string;
  amount: LaunchMoneyAmount;
  status: string;
  createdAt?: string | null;
  completedAt?: string | null;
}

export interface LaunchLeaderboardEntry {
  rank: number;
  userId: string;
  displayName?: string | null;
  profileSlug?: string | null;
  avatarUrl?: string | null;
  value: LaunchMoneyAmount;
  eventCount?: number;
  featuredAgent?: Pick<LaunchAgentSummary, "id" | "slug" | "name"> | null;
  /** @deprecated Use featuredAgent. */
  featuredTool?: Pick<LaunchAgentSummary, "id" | "slug" | "name"> | null;
}

export interface LaunchLeaderboardResponse {
  kind: LaunchLeaderboardKind;
  period: "30d" | "90d" | "all";
  entries: LaunchLeaderboardEntry[];
  generatedAt: string;
}

export const LAUNCH_SCOPE_CONTRACT: LaunchScopeContract = {
  version: LAUNCH_MVP_VERSION,
  thesis:
    "Deploy tools any existing agent can install, run, compose, and pay for.",
  includedCapabilities: LAUNCH_INCLUDED_CAPABILITIES,
  deferredCapabilities: LAUNCH_DEFERRED_CAPABILITIES,
  publicRoutes: LAUNCH_PUBLIC_ROUTES,
  compatibilityPublicRoutes: LAUNCH_COMPATIBILITY_PUBLIC_ROUTES,
  apiRoutes: LAUNCH_API_ROUTES,
};

export function isLaunchDeferredCapability(
  value: unknown,
): value is LaunchDeferredCapability {
  return typeof value === "string" &&
    (LAUNCH_DEFERRED_CAPABILITIES as readonly string[]).includes(value);
}

export function isLaunchIncludedCapability(
  value: unknown,
): value is LaunchIncludedCapability {
  return typeof value === "string" &&
    (LAUNCH_INCLUDED_CAPABILITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Deprecated aliases from the Tools -> Agents rename (Phase 3).
// Removal scheduled one release window after clients migrate.
// ---------------------------------------------------------------------------

/** @deprecated Use LAUNCH_AGENT_RELATIONSHIPS. */
export const LAUNCH_TOOL_RELATIONSHIPS = LAUNCH_AGENT_RELATIONSHIPS;
/** @deprecated Use LaunchAgentRelationship. */
export type LaunchToolRelationship = LaunchAgentRelationship;
/** @deprecated Use LAUNCH_AGENT_KINDS. */
export const LAUNCH_TOOL_KINDS = LAUNCH_AGENT_KINDS;
/** @deprecated Use LaunchAgentKind. */
export type LaunchToolKind = LaunchAgentKind;
/** @deprecated Use LAUNCH_AGENT_VISIBILITIES. */
export const LAUNCH_TOOL_VISIBILITIES = LAUNCH_AGENT_VISIBILITIES;
/** @deprecated Use LaunchAgentVisibility. */
export type LaunchToolVisibility = LaunchAgentVisibility;
/** @deprecated Use LaunchAgentInstallContext. */
export type LaunchToolInstallContext = LaunchAgentInstallContext;
/** @deprecated Use LaunchAgentFunctionsResponse. */
export type LaunchToolFunctionsResponse = LaunchAgentFunctionsResponse;
/** @deprecated Use LaunchAgentOwnerSummary. */
export type LaunchToolOwnerSummary = LaunchAgentOwnerSummary;
/** @deprecated Use LaunchAgentSummary. */
export type LaunchToolSummary = LaunchAgentSummary;
/** @deprecated Use LaunchAgentAdminSummary. */
export type LaunchToolAdminSummary = LaunchAgentAdminSummary;
/** @deprecated Use LAUNCH_CALLER_FUNCTION_POLICIES. */
export const LAUNCH_AGENT_FUNCTION_POLICIES = LAUNCH_CALLER_FUNCTION_POLICIES;
/** @deprecated Use LaunchCallerFunctionPolicy. */
export type LaunchAgentFunctionPolicy = LaunchCallerFunctionPolicy;
/** @deprecated Use LaunchCallerFunctionPermissionSource. */
export type LaunchAgentFunctionPermissionSource = LaunchCallerFunctionPermissionSource;
/** @deprecated Use LaunchCallerFunctionPermissionSummary. */
export type LaunchAgentFunctionPermissionSummary = LaunchCallerFunctionPermissionSummary;
/** @deprecated Use LaunchCallerFunctionPermissionUpdate. */
export type LaunchAgentFunctionPermissionUpdate = LaunchCallerFunctionPermissionUpdate;
/** @deprecated Use LaunchCallerFunctionPermissionsResponse. */
export type LaunchAgentFunctionPermissionsResponse = LaunchCallerFunctionPermissionsResponse;
/** @deprecated Use LaunchCallerFunctionPermissionsUpdateRequest. */
export type LaunchAgentFunctionPermissionsUpdateRequest = LaunchCallerFunctionPermissionsUpdateRequest;
/** @deprecated Use LaunchCallerPermissionRequired. */
export type LaunchAgentPermissionRequired = LaunchCallerPermissionRequired;
/** @deprecated Use LaunchCallerPermissionDenied. */
export type LaunchAgentPermissionDenied = LaunchCallerPermissionDenied;
