import type { HealthWindows } from "../types/index.ts";
import type { MCPToolAnnotations } from "./mcp.ts";

export const LAUNCH_MVP_VERSION = "persistent-agent-mvp-v1" as const;

// Machine-readable safety/product invariants for the private persistent-Agent
// launch. Capability-basin code may support broader modes, but the Conjure and
// Agent-home paths must never silently widen these choices.
export const PERSISTENT_AGENT_LAUNCH_POLICY = {
  access: "private_owner_only",
  primaryRoutinesPerAgent: 1,
  scheduleSurface: "interval_only",
  reportingDestination: "galactic_inbox",
  activationAuthority: "account_session",
  connectedAgentAuthority: "scoped_builder_operator",
  crossAgentTargets: "owned_private_agents_only",
  crossAgentApproval: "account_session",
  budgetEnforcement: "hard_pre_execution",
  manualRunsCountTowardBudgets: true,
  updatePromotion: "test_then_promote",
  expandedCapabilitiesRequireReapproval: true,
} as const;

export const LAUNCH_INCLUDED_CAPABILITIES = [
  "private_agent_library",
  "persistent_agent_home",
  "full_time_routines",
  "sandboxed_execution",
  "owned_agent_composition",
  "runtime_monitoring",
  "owner_inbox_reporting",
  "hard_budget_limits",
  "encrypted_runtime_settings",
  "byok",
  "credits_balance",
  "scoped_builder_connection",
  "cli_api_mcp",
] as const;

export type LaunchIncludedCapability =
  typeof LAUNCH_INCLUDED_CAPABILITIES[number];

export const LAUNCH_DEFERRED_CAPABILITIES = [
  "marketplace",
  "public_discovery",
  "public_agent_pages",
  "agent_installation",
  "public_unlisted_publication",
  "seller_monetization",
  "earnings_payouts_referrals",
  "leaderboards",
  "marketplace_trust_reputation",
  "cross_user_sharing",
  "external_reporting_destinations",
  "multi_routine_agent_home",
  "cron_timezone_configuration",
  "command_cards",
  "command_dashboards",
  "agentic_ui_composer",
  "standalone_website_builder",
] as const;

export type LaunchDeferredCapability =
  typeof LAUNCH_DEFERRED_CAPABILITIES[number];

export const LAUNCH_PUBLIC_ROUTES = [
  "/",
  "/agents",
  "/browse",
  "/agents/:slug",
  "/account",
  "/admin/agents/:id",
  "/terms",
  "/privacy",
] as const;

export type LaunchPublicRoute = typeof LAUNCH_PUBLIC_ROUTES[number];

export const LAUNCH_COMPATIBILITY_PUBLIC_ROUTES = [
  "/discover",
  "/install",
  "/library",
  "/store",
  "/wallet",
  "/settings",
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
  "PUT /api/launch/platform-model",
  "GET /api/launch/inference-options",
  "GET /api/launch/library",
  "POST /api/launch/folders",
  "PATCH /api/launch/folders/:id",
  "DELETE /api/launch/folders/:id",
  "PUT /api/launch/folders/members",
  "GET /api/launch/store",
  "GET /api/launch/discover",
  "GET /api/launch/agents/:id",
  "GET /api/launch/agents/:id/routine",
  "PATCH /api/launch/agents/:id/routine",
  "POST /api/launch/agents/:id/routine/actions",
  "GET /api/launch/agents/:id/functions",
  "POST /api/launch/agents/:id/functions/:functionName/run",
  "POST /api/launch/agents/:id/install",
  "DELETE /api/launch/agents/:id/install",
  "GET /api/launch/agents/:id/caller-permissions",
  "PATCH /api/launch/agents/:id/caller-permissions",
  "GET /api/launch/agents/:id/function-inference",
  "PUT /api/launch/agents/:id/function-inference",
  "DELETE /api/launch/agents/:id/function-inference",
  "GET /api/launch/agents/:id/settings",
  "PUT /api/launch/agents/:id/settings",
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
  "GET /api/launch/jobs/:id",
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
  // Per-Agent fees-waived ranking (the Browse "Top Agents" chart).
  "agent_fee_credit",
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
  policy: typeof PERSISTENT_AGENT_LAUNCH_POLICY;
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
  /** Behavioral hints declared by the function's MCP manifest. */
  annotations?: MCPToolAnnotations | null;
  pricing?: LaunchPricingSummary | null;
  accessPolicy?: LaunchAccessPolicySummary | null;
  callerPermission?: LaunchCallerFunctionPermissionSummary | null;
  /** @deprecated Use callerPermission. */
  agentPermission?: LaunchCallerFunctionPermissionSummary | null;
  /** The viewer's per-function galactic.ai() provider+model override, if set. */
  inferenceOverride?: LaunchFunctionInferenceOverrideSummary | null;
  /** Whether this function calls galactic.ai() (gates the model picker UI). */
  usesInference?: boolean;
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

/** GET /api/launch/jobs/:id — poll a durable async execution (twin of ul.job). */
export interface LaunchJobStatusResponse {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  /** Present only when status is completed. */
  result: unknown;
  /** Present only when status is failed. */
  error: unknown;
  durationMs: number | null;
  aiCostCredits: number;
  /** Links the job to its execution receipt and AI-spend ledger entries. */
  executionId: string | null;
  createdAt: string;
  completedAt: string | null;
  generatedAt: string;
}

export type LaunchCallerFunctionPermissionSource = "explicit" | "default";

export interface LaunchCallerFunctionPermissionSummary {
  appId: string;
  functionName: string;
  policy: LaunchCallerFunctionPolicy;
  // When policy is "always", auto-allow ONLY if the target is recently healthy;
  // otherwise the call degrades to "ask". Ignored for "ask"/"never".
  healthGate: boolean;
  source: LaunchCallerFunctionPermissionSource;
  updatedAt?: string | null;
}

export interface LaunchCallerFunctionPermissionUpdate {
  functionName: string;
  policy: LaunchCallerFunctionPolicy;
  healthGate?: boolean;
}

export interface LaunchCallerFunctionPermissionsResponse {
  agent: LaunchAgentHandle;
  /** @deprecated Use agent. */
  tool: LaunchAgentHandle;
  defaultPolicy: LaunchCallerFunctionPolicy;
  defaultHealthGate: boolean;
  permissions: LaunchCallerFunctionPermissionSummary[];
  generatedAt: string;
}

/** Per-(viewer, app, function) galactic.ai() override. provider null = Galactic AI (credits). */
export interface LaunchFunctionInferenceOverrideSummary {
  appId: string;
  functionName: string;
  billingMode: "light" | "byok";
  provider: string | null;
  model: string | null;
  updatedAt?: string | null;
}

/** PUT body (alongside functionName): provider 'galactic'/'light' => credits, else a BYOK provider id. */
export interface LaunchFunctionInferenceOverrideRequest {
  provider: string;
  model?: string;
}

export interface LaunchFunctionInferenceResponse {
  agent: LaunchAgentHandle;
  /** @deprecated Use agent. */
  tool: LaunchAgentHandle;
  overrides: LaunchFunctionInferenceOverrideSummary[];
  generatedAt: string;
}

export interface LaunchCallerFunctionPermissionsUpdateRequest {
  defaultPolicy?: LaunchCallerFunctionPolicy;
  defaultHealthGate?: boolean;
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
  // Set when an "always" policy was downgraded to "ask" because the target was
  // not recently healthy (no_data or red), rather than an explicit "ask".
  reason?: "health_gate";
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
  /** Buyer email, so the client can pre-fill the PaymentElement for Stripe Link. */
  email?: string;
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

/** Set the platform (credits) OpenRouter model. No key required; empty clears it. */
export interface LaunchPlatformModelRequest {
  model: string;
}

export interface LaunchPlatformModelResponse {
  ok: true;
  platformModel: string | null;
}

export interface LaunchInferenceOptionsResponse {
  billingMode: "byok" | "credits";
  primaryProvider: string | null;
  /** The user's chosen platform (credits) OpenRouter model slug; null = default. */
  platformModel: string | null;
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

// A developer-shipped static HTML UI rendered in a sandboxed iframe on the
// Agent's public page (manifest `interfaces[]`, hash-stamped at upload).
export interface LaunchInterfaceSummary {
  id: string;
  label: string;
  description?: string | null;
  // Absolute URL on the interfaces sandbox origin. Content-addressed and
  // immutable — changes only when the interface HTML changes.
  url: string;
  // Bridge allowlist, already intersected with the agent's real manifest
  // functions; the host page must refuse calls outside this list.
  functions: string[];
  minHeight?: number | null;
}

// Owner notification (routine auto-pause / budget wall today; any subsystem
// later). The website bell + gx.notifications read the same rows.
export interface LaunchNotification {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  action_url?: string | null;
  created_at: string;
  read_at?: string | null;
}

export interface LaunchNotificationsResponse {
  notifications: LaunchNotification[];
  unread_count: number;
}

export interface LaunchNotificationsMarkReadResponse {
  ok: boolean;
  marked: number;
}

// Viewer-facing disclosure of an Agent's autonomous (full-time) behavior,
// derived from its manifest routine declaration. Present only when the Agent
// ships a routine template — the "this runs on its own" transparency card.
export interface LaunchFullTimeDisclosure {
  label: string;
  description?: string | null;
  // Human-readable cadence, e.g. "every 5 minutes" / "daily at 09:00 UTC".
  scheduleSummary: string | null;
  budget: {
    perRunLight: number | null;
    perDayLight: number | null;
    perMonthLight: number | null;
  };
  // Manifest flight_recorder flag — whether the platform records the agent's
  // reasoning + data changes each wake (owner + agent can review them).
  recordsReasoning: boolean;
  // Downstream Agents/functions the routine is declared to use autonomously.
  capabilities: Array<{
    appRef: string | null;
    functionName: string | null;
    access: "read" | "write" | null;
  }>;
}

export type LaunchAgentRoutineStatus =
  | "active"
  | "paused"
  | "disabled"
  | "error";

export type LaunchAgentRoutineHealth =
  | "active"
  | "paused"
  | "running"
  | "needs_approval"
  | "error";

export interface LaunchAgentRoutineBudget {
  maxLightPerRun: number;
  maxLightPerDay: number;
  maxLightPerMonth: number;
  maxCallsPerRun: number;
}

export interface LaunchAgentRoutineCapability {
  id: string;
  appId: string | null;
  appRef: string;
  functionName: string;
  access: "read" | "write";
  required: boolean;
  purpose: string | null;
  approved: boolean;
  approvedAt: string | null;
}

export interface LaunchAgentRoutineBlocker {
  code: string;
  message: string;
  capabilityIds?: string[];
}

export interface LaunchAgentRoutineRun {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  trigger: string;
  traceId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  totalLight: number;
  summary: string | null;
  errorCode: string | null;
  createdAt: string;
}

/**
 * Owner-only projection of the one primary routine stored for a private Agent.
 * It intentionally omits routine config, metadata, run arguments, and secret
 * values. The Agent settings endpoint separately reports secret presence only.
 */
export interface LaunchAgentRoutineOverview {
  id: string;
  status: LaunchAgentRoutineStatus;
  health: LaunchAgentRoutineHealth;
  mission: string;
  intervalSeconds: number;
  budgets: LaunchAgentRoutineBudget;
  capabilities: LaunchAgentRoutineCapability[];
  blockers: LaunchAgentRoutineBlocker[];
  reportingDestination: {
    kind: "galactic_inbox";
    label: "Galactic inbox";
  };
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  failureCount: number;
  autoPauseReason: string | null;
  errorReason: string | null;
  recentRuns: LaunchAgentRoutineRun[];
  actions: {
    canApproveCapabilities: boolean;
    canActivate: boolean;
    canPause: boolean;
    canRunNow: boolean;
  };
}

export interface LaunchAgentRoutineResponse {
  agent: {
    id: string;
    slug: string;
    name: string;
  };
  routine: LaunchAgentRoutineOverview | null;
  generatedAt: string;
}

export interface LaunchAgentRoutineUpdateRequest {
  mission?: string | null;
  intervalSeconds?: number;
  /** When supplied, all four hard ceilings are required. */
  budgets?: LaunchAgentRoutineBudget;
}

export type LaunchAgentRoutineAction =
  | "approve_capabilities"
  | "activate"
  | "pause"
  | "run_now";

export interface LaunchAgentRoutineActionRequest {
  action: LaunchAgentRoutineAction;
  /** Exact requested capability ids; valid only for approve_capabilities. */
  capabilityIds?: string[];
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
  // The folder this Agent is filed under within its tab on the library page, or
  // null for "Uncategorized". The tab (owned/installed) is implied by which list
  // the Agent appears in.
  folderId?: string | null;
  relevance?: LaunchRelevanceSummary;
  // Present only on the agent detail response, and only for interfaces with
  // a server-stamped artifact hash (renderable by the sandbox worker).
  interfaces?: LaunchInterfaceSummary[];
  // Present only on the agent detail response, and only when the Agent's
  // manifest declares a routine (full-time agent) — the autonomous-behavior
  // disclosure card.
  fullTime?: LaunchFullTimeDisclosure | null;
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
  // The owner's referral link for this Agent. Customers who arrive through it
  // are permanently attributed to the publisher (platform fees waived on their
  // usage). Null when the link could not be loaded.
  referral?: {
    url: string;
    slug: string;
    status: "active" | "disabled";
  } | null;
}

// A per-user secret that is a vaulted CREDENTIAL bound to one destination. The
// platform injects it host-side into requests to that destination ONLY (never
// into sandbox code, never to any other host). `connected` reflects the viewing
// user's own configured state — a value is never included.
export interface LaunchDestinationCredential {
  key: string;
  label: string;
  required: boolean;
  connected?: boolean;
}

// One outbound destination the Agent is allowed to reach, with the credentials
// (if any) bound to it. A destination with an empty `credentials` list is
// transparency-only: the Agent connects there but sends no user credential.
export interface LaunchNetworkDestination {
  host: string;
  label: string | null;
  description: string | null;
  credentials: LaunchDestinationCredential[];
}

// A per-user setting NOT bound to a specific destination: readable config
// (host/port/email/name) or a secret used generically. `secret` drives a masked
// input; `group` is a display-only cluster label. Never carries a value.
export interface LaunchGeneralSetting {
  key: string;
  label: string;
  description: string | null;
  input: string;
  required: boolean;
  secret: boolean;
  group: string | null;
  connected?: boolean;
}

// What the Agent connects to and the secrets it uses at each place. Powers the
// "Capabilities & connections" UI and gx.discover(inspect). Values are never
// included — only key names, requiredness, and the viewer's connected status.
export interface LaunchNetworkDisclosure {
  destinations: LaunchNetworkDestination[];
  general_settings: LaunchGeneralSetting[];
}

export interface LaunchTrustCard {
  schema_version: 1;
  // Attests the published SOURCE manifest only — label "source signed", never
  // imply the running code is verified. executed_integrity is the runtime claim.
  signed_manifest: boolean;
  // Does the EXECUTING bundle match its signed attestation? "verified"/
  // "unverified" on the detail surface; "unknown" on cheap batch surfaces.
  executed_integrity: "verified" | "unverified" | "unknown";
  signer: string | null;
  signed_at: string | null;
  version: string | null;
  runtime: string;
  manifest_hash: string | null;
  description_hash: string | null;
  artifact_hash: string | null;
  // Per-file SHA256 map for open-code verification (a downloading agent
  // recomputes each file's hash and matches it against this).
  artifact_hashes: Record<string, string>;
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
  // Grouped view of outbound destinations + the secrets bound to each, plus the
  // unbound per-user settings. Optional so lite/batch trust surfaces can omit it.
  network_disclosure?: LaunchNetworkDisclosure;
  access: {
    visibility: LaunchAgentVisibility;
    download_access: string | null;
  };
  // Open code: source is downloadable + hash-verifiable via gx.verify.
  open_code: boolean;
  // Identity: publisher's Stripe Connect account has payouts enabled.
  publisher_verified: boolean;
  // Binary call-success health over rolling windows (self + free calls excluded).
  health: HealthWindows;
  reliability?: unknown;
  // DISCLOSURE: the app's owner can read other users' data stored in this app
  // (declared `data:support_read`, read-only + audit-logged). Show it prominently.
  developer_can_read_user_data: boolean;
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

// A desktop-style, free-form folder on the library page, scoped to one tab
// ('owned' or 'installed'). Agents are assigned via LaunchAgentSummary.folderId.
export interface LaunchFolder {
  id: string;
  name: string;
  position: number;
}

export interface LaunchLibraryResponse {
  owned: LaunchAgentSummary[];
  installed: LaunchAgentSummary[];
  // Free-form folders per tab; an Agent's membership is carried on its folderId.
  folders: {
    owned: LaunchFolder[];
    installed: LaunchFolder[];
  };
  generatedAt: string;
}

export interface LaunchFolderMutationResponse {
  folder: LaunchFolder;
  generatedAt: string;
}

export interface LaunchFolderMemberMutationResponse {
  appId: string;
  scope: "owned" | "installed";
  folderId: string | null;
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
  /**
   * Free Mode is active for this account: the platform enforces no-spend mode
   * because the spendable balance is under the threshold (docs/FREE_MODE_DESIGN.md).
   * Server-driven — only true when the platform actually enforces it (the
   * FREE_MODE flag is on), so the UI never claims a mode that isn't in effect.
   */
  freeMode?: boolean;
  canTopUp: boolean;
  /**
   * Stripe publishable key + buyer email, so the top-up modal can mount the
   * Payment Element + Link wallet IMMEDIATELY on open (deferred-intent flow)
   * without first creating a PaymentIntent. Display-only / public values.
   */
  stripePublishableKey?: string;
  buyerEmail?: string;
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
  /** Per-transaction sales tax collected from the buyer (0 when not collecting). */
  tax: LaunchMoneyAmount;
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
    "Conjure a private persistent Agent; Galactic keeps it working, bounded, and portable.",
  policy: PERSISTENT_AGENT_LAUNCH_POLICY,
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
