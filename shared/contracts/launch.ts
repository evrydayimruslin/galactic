import type {
  HealthWindows,
  VersionTestQualificationMetadata,
} from "../types/index.ts";
import type { MCPToolAnnotations } from "./mcp.ts";

export const LAUNCH_MVP_VERSION = "persistent-agent-mvp-v1" as const;
export const AGENT_HOME_CONTRACT_VERSION = "2026-07-23.operator.1" as const;
export const OPERATOR_ISSUE_CONTRACT_VERSION =
  "2026-07-24.operator-issues.1" as const;
export const OPERATOR_DIAGNOSTIC_CONTRACT_VERSION =
  "2026-07-24.operator-diagnostics.1" as const;

/**
 * Machine-readable invariants for operator issues and remediation.
 *
 * Notifications remain immutable event/report evidence. A canonical issue
 * owns the observed condition lifecycle, while read/snooze/dismiss state is a
 * separate presentation concern. Clients render trusted server intent; they
 * never infer remediation from prose or execute a server-supplied URL.
 */
export const OPERATOR_ISSUE_POLICY = {
  diagnosisAuthority: "trusted_server_condition",
  remediationAuthority: "server_registry",
  navigationContract: "semantic_target",
  conditionLifecycleAuthority: "operator_issue",
  attentionStateAuthority: "operator_issue_attention_state",
  notificationRole: "immutable_evidence_and_reports",
  globalCountMeaning: "unique_items",
  agentCountMeaning: "relevance_projections",
  blockerOrdering: "dependency_then_source_order",
  scheduledResumeAfterRecovery: "explicit_owner_action",
  legacyProseAndUrlParsing: "compatibility_only",
} as const;

// Machine-readable safety/product invariants for the private persistent-Agent
// launch. Capability-basin code may support broader modes, but the Conjure and
// Agent-home paths must never silently widen these choices.
export const PERSISTENT_AGENT_LAUNCH_POLICY = {
  access: "private_owner_only",
  primaryRoutinesPerAgent: 1,
  additionalRoutinesPerAgent: "unbounded_within_shared_capacity",
  scheduleSurface: "interval_and_cron",
  reportingDestination: "galactic_inbox",
  perAgentCapacityCeiling: "owner_configured_share_of_account_windows",
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
  "multi_routine_agents",
  "cron_timezone_scheduling",
  "durable_event_triggers",
  "sandboxed_execution",
  "owned_agent_composition",
  "runtime_monitoring",
  "owner_inbox_reporting",
  "hard_budget_limits",
  "encrypted_runtime_settings",
  "byok",
  "subscription_capacity",
  "coalesced_capacity_waiting",
  "per_agent_capacity_caps",
  "agent_filtered_alerts",
  "compact_owner_fleet",
  "animated_agent_icons",
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
  "command_cards",
  "command_dashboards",
  "agentic_ui_composer",
  "standalone_website_builder",
] as const;

export type LaunchDeferredCapability =
  typeof LAUNCH_DEFERRED_CAPABILITIES[number];

export const LAUNCH_PUBLIC_ROUTES = [
  "/",
  "/connect",
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
  "POST /api/launch/handoffs",
  "POST /api/launch/agents/:id/handoffs",
  "GET /api/launch/candidates",
  "GET /api/launch/candidates/:candidateId",
  "POST /api/launch/candidates/:candidateId/deploy",
  "GET /api/launch/byok",
  "PUT /api/launch/byok/:provider",
  "DELETE /api/launch/byok/:provider",
  "POST /api/launch/byok/primary",
  "GET /api/launch/inference-options",
  "GET /api/launch/subscription",
  "POST /api/launch/subscription/checkout",
  "GET /api/launch/subscription/checkout-attempts/:attemptId",
  "POST /api/launch/subscription/checkout-attempts/:attemptId/cancel",
  "POST /api/launch/subscription/portal",
  "GET /api/launch/capacity",
  "GET /api/launch/fleet",
  "GET /api/launch/fleet/preferences",
  "PATCH /api/launch/fleet/preferences",
  "PUT /api/launch/fleet/order",
  "GET /api/launch/notifications",
  "GET /api/launch/attention",
  "PATCH /api/launch/operator-items/:id/attention",
  "POST /api/launch/operator-items/:id/actions",
  "PATCH /api/launch/notifications",
  "POST /api/launch/notifications/:id/actions",
  "GET /api/launch/search",
  "GET /api/launch/library",
  "POST /api/launch/folders",
  "PATCH /api/launch/folders/:id",
  "DELETE /api/launch/folders/:id",
  "PUT /api/launch/folders/members",
  "GET /api/launch/store",
  "GET /api/launch/discover",
  "GET /api/launch/agents/:id",
  "GET /api/launch/agents/:id/preferences",
  "PATCH /api/launch/agents/:id/preferences",
  "GET /api/launch/agents/:id/attention",
  "GET /api/launch/agents/:id/home",
  "GET /api/launch/agents/:id/home/activity",
  "GET /api/launch/agents/:id/routine-runs/:runId",
  "GET /api/launch/agents/:id/routine-runs/:runId/logs/:receiptId",
  "PATCH /api/launch/agents/:id/home/identity",
  "PATCH /api/launch/agents/:id/home/routine",
  "PUT /api/launch/agents/:id/home/settings",
  "POST /api/launch/agents/:id/home/actions",
  "POST /api/launch/agents/:id/home/pause",
  "GET /api/launch/agents/:id/routines",
  "GET /api/launch/agents/:id/routines/:routineId",
  "PATCH /api/launch/agents/:id/routines/:routineId",
  "POST /api/launch/agents/:id/routines/:routineId/actions",
  "GET /api/launch/agents/:id/capacity",
  "PATCH /api/launch/agents/:id/capacity",
  "GET /api/launch/agents/:id/compute/settings",
  "PUT /api/launch/agents/:id/compute/settings",
  "GET /api/launch/agents/:id/compute/runs",
  "POST /api/launch/agents/:id/compute/runs/:runId/cancel",
  "GET /api/launch/agents/:id/compute/runs/:runId/artifacts/:artifactId",
  "GET /api/launch/agents/:id/routine",
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

export const LAUNCH_HANDOFF_INTENTS = [
  "agent",
  "interface",
  "function",
  "routine",
  "connect",
] as const;

export type LaunchHandoffIntent = typeof LAUNCH_HANDOFF_INTENTS[number];

export const LAUNCH_AGENT_EXTENSION_HANDOFF_INTENTS = [
  "interface",
  "function",
  "routine",
] as const satisfies readonly LaunchHandoffIntent[];

export type LaunchAgentExtensionHandoffIntent =
  typeof LAUNCH_AGENT_EXTENSION_HANDOFF_INTENTS[number];

export const LAUNCH_HANDOFF_STATUSES = [
  "created",
  "connected",
  "staged",
  "tested",
  "uploaded",
  "promoted",
  "cancelled",
  "rejected",
  "revoked",
  "expired",
] as const;

export type LaunchHandoffStatus = typeof LAUNCH_HANDOFF_STATUSES[number];

/**
 * Human intent attached to a short-lived coding-agent handoff.
 *
 * `description` is required for structural work. The Connect intent may use an
 * empty description because connecting and waiting is itself the complete
 * request. Credential scope, target, and expiry are always server-derived.
 */
export interface LaunchHandoffCreateRequest {
  intent: LaunchHandoffIntent;
  description: string;
}

export type LaunchHandoffTarget =
  | { kind: "workspace" }
  | {
    kind: "new_agent";
    /** Server-reserved Agent UUID that this handoff alone may create. */
    reservedAgentId: string;
    /** New-Agent handoffs are permanently limited to one reserved Agent. */
    maxAgents: 1;
  }
  | {
    kind: "agent";
    agentId: string;
    agentSlug?: string | null;
    agentName: string;
  };

export interface LaunchHandoffCredential {
  id: string;
  tokenPrefix: string;
  plaintextToken: string;
  scopes: string[];
  appIds: string[] | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * Creation receipt for the current partial implementation. Once AS-BE-002 is
 * persisted, this shape becomes the durable lifecycle projection.
 */
export interface LaunchHandoffSession {
  id: string;
  intent: LaunchHandoffIntent;
  status: LaunchHandoffStatus;
  target: LaunchHandoffTarget;
  description: string;
  createdAt: string;
  expiresAt: string;
}

export interface LaunchHandoffCreateResponse {
  success: true;
  handoff: LaunchHandoffSession;
  credential: LaunchHandoffCredential;
  platformMcpUrl: string;
  message: string;
  generatedAt: string;
}

export const LAUNCH_CANDIDATE_STATUSES = [
  "ready",
  "deploying",
  "deployed",
  "stale",
  "blocked",
] as const;

export type LaunchCandidateStatus = typeof LAUNCH_CANDIDATE_STATUSES[number];

export type LaunchCandidateTarget =
  | {
    kind: "new_agent";
    reservedAgentId: string;
  }
  | {
    kind: "extension";
    agentId: string;
    agentSlug: string | null;
    agentName: string;
    baseLineage: {
      version: string;
      sourceHash: string | null;
      releaseDigest: string | null;
      stateDigest: string;
    };
    currentVersion: string | null;
    lineageStatus: "current" | "stale";
  };

export interface LaunchCandidateFunctionProjection {
  name: string;
  description: string;
  authorityLevel: "read" | "internal_write" | "external_write" | null;
  effects: Array<{
    id: string;
    policy: "ask" | "free";
  }>;
}

export interface LaunchCandidateInterfaceProjection {
  id: string;
  label: string;
  description: string | null;
  functions: string[];
}

export interface LaunchCandidateRoutineProjection {
  id: string;
  label: string;
  description: string | null;
  handler: string;
  hasDefaultSchedule: boolean;
}

export interface LaunchCandidateSettingProjection {
  key: string;
  label: string | null;
  description: string | null;
  required: boolean;
  secret: boolean;
  scope: "agent" | "per_user";
  destination: string | null;
}

/**
 * Durable owner-safe receipt for a completed candidate deployment.
 *
 * The receipt is projected from the committed deployment record so a browser
 * can recover setup navigation after a lost response or reload. It deliberately
 * contains no idempotency key, lease, storage key, source, or credential data.
 */
export interface LaunchCandidateDeploymentReceipt {
  deploymentId: string;
  completedAt: string;
  agent: {
    id: string;
    slug: string;
    name: string;
    version: string;
    setupRequired: true;
  };
}

/**
 * Owner-safe invitation for one immutable, qualified candidate.
 *
 * This projection intentionally excludes source bytes, executable bytes,
 * secret values, raw test inputs, and bearer credentials. The release and
 * evidence fields are derived from the digest-verified candidate archive.
 */
export interface LaunchCandidateInvitation {
  id: string;
  handoffId: string;
  intent: Exclude<LaunchHandoffIntent, "connect">;
  status: LaunchCandidateStatus;
  target: LaunchCandidateTarget;
  archive: {
    digest: string;
    byteCount: number;
    objectCount: number;
  };
  release: {
    version: string;
    name: string;
    description: string | null;
    functions: LaunchCandidateFunctionProjection[];
    interfaces: LaunchCandidateInterfaceProjection[];
    routines: LaunchCandidateRoutineProjection[];
    settings: LaunchCandidateSettingProjection[];
    network: Array<{
      host: string;
      label: string | null;
      description: string | null;
    }>;
    compute: {
      profile: string;
      tools: string[];
      secretNames: string[];
    } | null;
    permissions: string[];
  };
  evidence: {
    bundleId: string;
    sourceHash: string;
    attestationId: string;
    attestationDigest: string;
    documentDigest: string;
    reportDigest: string;
    releaseDigest: string;
    qualification: VersionTestQualificationMetadata;
  };
  deploymentReady: boolean;
  blocker: {
    code: string;
    message: string;
  } | null;
  /**
   * Present only when `status` is `deployed`. Non-completed candidates always
   * project null, including recoverable in-progress deployments.
   */
  deployment: LaunchCandidateDeploymentReceipt | null;
  /** Opaque revision the owner reviewed and must echo when deploying. */
  reviewRevision: string;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchCandidateListResponse {
  candidates: LaunchCandidateInvitation[];
  subscription: LaunchSubscriptionResponse;
  generatedAt: string;
}

export interface LaunchCandidateDetailResponse {
  candidate: LaunchCandidateInvitation;
  generatedAt: string;
}

export interface LaunchCandidateDeployRequest {
  idempotencyKey: string;
  archiveDigest: string;
  releaseDigest: string;
  reviewRevision: string;
}

export interface LaunchCandidateDeployResponse {
  success: boolean;
  candidateId: string;
  deploymentId: string;
  status: "pending" | "completed" | "failed";
  replayed: boolean;
  agent: {
    id: string;
    slug: string;
    name: string;
    version: string;
    setupRequired: boolean;
  } | null;
  message: string;
  generatedAt: string;
}

/**
 * Autonomous execution authority for work initiated by a persistent Agent.
 * This is deliberately separate from connected-caller permissions, routine
 * capability approval, and cross-Agent grants.
 */
export const LAUNCH_AUTONOMOUS_FUNCTION_POLICIES = [
  "off",
  "ask",
  "free",
] as const;

export type LaunchAutonomousFunctionPolicy =
  typeof LAUNCH_AUTONOMOUS_FUNCTION_POLICIES[number];

export const LAUNCH_FUNCTION_CONSEQUENCE_GROUPS = [
  "read",
  "internal_write",
  "external_side_effect",
  "spend",
] as const;

export type LaunchFunctionConsequenceGroup =
  typeof LAUNCH_FUNCTION_CONSEQUENCE_GROUPS[number];

export type LaunchAutonomousPolicyActor =
  | { kind: "user"; userId: string }
  | {
    kind: "system";
    source: "release_default" | "migration" | "safety_reset";
  };

export interface LaunchAutonomousFunctionPolicyProjection {
  agentId: string;
  functionName: string;
  /**
   * The function's single highest-authority classification. `spend`
   * supersedes the external side effect inherent in a paid action.
   */
  consequence: LaunchFunctionConsequenceGroup;
  policy: LaunchAutonomousFunctionPolicy;
  revision: string;
  declaredReleaseId: string;
  declaredReleaseVersion: string;
  declarationHash: string;
  updatedAt: string;
  updatedBy: LaunchAutonomousPolicyActor;
}

export interface LaunchAutonomousFunctionPolicyUpdateRequest {
  policy: LaunchAutonomousFunctionPolicy;
  expectedRevision: string;
  expectedReleaseId: string;
  expectedDeclarationHash: string;
  idempotencyKey: string;
}

export const LAUNCH_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "resuming",
  "completed",
  "expired",
  "failed",
] as const;

export type LaunchApprovalStatus = typeof LAUNCH_APPROVAL_STATUSES[number];

/**
 * Durable, owner-safe work envelope for a run held by an `ask` policy.
 * `source` and `proposal` are sanitized projections; raw model reasoning,
 * secrets, and unredacted function arguments are never part of this contract.
 */
export interface LaunchApprovalEnvelope {
  id: string;
  agentId: string;
  status: LaunchApprovalStatus;
  revision: string;
  releaseId: string;
  releaseVersion: string;
  functionName: string;
  consequence: LaunchFunctionConsequenceGroup;
  inputHash: string;
  trigger: string;
  /** Generic execution run held by the policy gate. */
  runId: string;
  routineId?: string | null;
  routineRunId?: string | null;
  traceId?: string | null;
  policyRevision: string;
  source: Record<string, unknown>;
  proposal: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
}

export const LAUNCH_APPROVAL_ACTIONS = [
  "approve",
  "revise",
  "reject",
] as const;

export type LaunchApprovalAction = typeof LAUNCH_APPROVAL_ACTIONS[number];

interface LaunchApprovalActionRequestBase {
  expectedRevision: string;
  idempotencyKey: string;
}

export type LaunchApprovalActionRequest =
  | LaunchApprovalActionRequestBase & {
    action: "approve";
    /** Atomically changes this function from `ask` to `free`. */
    stopAsking?: boolean;
  }
  | LaunchApprovalActionRequestBase & {
    action: "revise";
    /** Sanitized replacement input for the exact held run. */
    revisedInput: Record<string, unknown>;
    /** Atomically changes this function from `ask` to `free`. */
    stopAsking?: boolean;
  }
  | LaunchApprovalActionRequestBase & {
    action: "reject";
  };

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
  /** Structured pre-execution wait; null for an ordinary queue backlog. */
  admissionWait: {
    code: "capacity_waiting" | "agent_cap_waiting" | "concurrency_waiting";
    retryAt: string;
    nextAttemptAt: string | null;
    scope: "account" | "agent" | "ai" | "routine" | null;
    message: string | null;
  } | null;
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

/** Per-(viewer, app, function) galactic.ai() override. Launch inference is BYOK-only. */
export interface LaunchFunctionInferenceOverrideSummary {
  appId: string;
  functionName: string;
  billingMode: "byok";
  provider: string;
  model: string | null;
  updatedAt?: string | null;
}

/** PUT body (alongside functionName): provider must be a configured Class 1 BYOK provider. */
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

export type LaunchPlanCode = "pro";
export type LaunchCapacityState = "available" | "low" | "waiting";

export interface LaunchCapacityWindow {
  state: LaunchCapacityState;
  resetsAt: string;
  /** Deliberately omitted when the plan's exact allowance is unpublished. */
  usedPercent?: number;
}

export interface LaunchCapacityResponse {
  plan: LaunchPlanCode;
  state: LaunchCapacityState;
  weekly: LaunchCapacityWindow;
  nextEligibleAt: string | null;
  activeAgentLimit: number | null;
  deferredWakeCount?: number;
  generatedAt: string;
}

export interface LaunchAgentCapacityWindow {
  state: LaunchCapacityState;
  resetsAt: string;
  /** Agent usage as a share of the account window. Paid plans only. */
  shareUsedPercent?: number;
  /** How much of this Agent's configured ceiling has been consumed. */
  capUsedPercent?: number;
}

export interface LaunchAgentCapacityResponse {
  agentId: string;
  /** Percentage of the shared weekly allowance assigned to this Agent. */
  capPercent: number;
  state: LaunchCapacityState;
  weekly: LaunchAgentCapacityWindow;
  nextEligibleAt: string | null;
  blocker?: "agent_cap_too_low_for_request" | null;
  generatedAt: string;
}

export interface LaunchAgentCapacityUpdateRequest {
  /** Percent of the shared weekly allowance, with up to two decimal places. */
  capPercent: number;
}

export type LaunchSubscriptionStatus =
  | "inactive"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export interface LaunchSubscriptionResponse {
  plan: LaunchPlanCode;
  planName: string;
  priceCents: number;
  currency: "usd";
  interval: "month";
  status: LaunchSubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasActiveSubscription: boolean;
  canSubscribe: boolean;
  canManage: boolean;
  capacity: LaunchCapacityResponse;
  generatedAt: string;
}

export interface LaunchSubscriptionCheckoutRequest {
  plan: "pro";
  returnUrl: string;
  idempotencyKey: string;
}

export interface LaunchSubscriptionRedirectResponse {
  url: string;
  attemptId: string;
  status: "pending";
  generatedAt: string;
}

export type LaunchSubscriptionCheckoutAttemptStatus =
  | "creating"
  | "pending"
  | "active"
  | "cancelled"
  | "failed"
  | "expired";

export type LaunchSubscriptionCheckoutResponse =
  LaunchSubscriptionRedirectResponse;

export interface LaunchSubscriptionCheckoutAttemptResponse {
  attemptId: string;
  status: LaunchSubscriptionCheckoutAttemptStatus;
  subscription: LaunchSubscriptionResponse;
  generatedAt: string;
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
  billingMode: "byok";
  primaryProvider: string | null;
  configuredProviders: string[];
  /** @deprecated Legacy compatibility only; launch responses omit it. */
  platformModel?: string | null;
  /** @deprecated Legacy compatibility only; launch responses omit wallet state. */
  credits?: {
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
  // The live release and immutable artifact that supplied this declaration.
  // Read-model cache keys must include both so a promotion can never reuse a
  // result produced by different code.
  releaseVersion?: string | null;
  artifactHash?: string | null;
  // Cache authority derived from reviewed live function annotations, with
  // optional per-Interface TTL/prefetch overrides. Absent means every function
  // is executed live.
  readModels?: LaunchInterfaceReadModelSummary[];
  minHeight?: number | null;
}

export interface LaunchInterfaceReadModelSummary {
  functionName: string;
  freshForMs: number;
  staleForMs: number;
  // Presence (including an empty object) opts this exact live function into
  // background prefetch. Omission permits caching only after a user call.
  prefetchArgs?: Record<string, unknown>;
}

// Owner notification (routine auto-pause / budget wall today; any subsystem
// later). The website bell + gx.notifications read the same rows.
export interface LaunchNotification {
  id: string;
  agent_id?: string | null;
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
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "skipped";
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

export type LaunchAgentRoutineRole = "primary" | "routine";

export type LaunchAgentRoutineSchedule =
  | {
    kind: "interval";
    intervalSeconds: number;
    label: string;
  }
  | {
    kind: "cron";
    expression: string;
    timezone: string;
    label: string;
  };

/**
 * Owner-only projection of one managed routine stored for a private Agent.
 * It intentionally omits routine config, metadata, run arguments, and secret
 * values. The Agent settings endpoint separately reports secret presence only.
 */
export interface LaunchAgentRoutineOverview {
  id: string;
  name: string;
  description: string | null;
  role: LaunchAgentRoutineRole;
  status: LaunchAgentRoutineStatus;
  health: LaunchAgentRoutineHealth;
  mission: string;
  schedule: LaunchAgentRoutineSchedule;
  /** Bounded server-computed preview, useful for cron/DST review before activation. */
  nextOccurrences: string[];
  /** @deprecated Read schedule when available. Retained for older clients. */
  intervalSeconds?: number;
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
  revision?: string;
  agent: {
    id: string;
    slug: string;
    name: string;
  };
  routine: LaunchAgentRoutineOverview | null;
  generatedAt: string;
}

export interface LaunchAgentRoutinesResponse {
  revision: string;
  agent: LaunchAgentRoutineResponse["agent"];
  primaryRoutineId: string | null;
  routines: LaunchAgentRoutineOverview[];
  aggregate: {
    total: number;
    active: number;
    paused: number;
    failing: number;
    running: number;
    nextRunAt: string | null;
    lastRunAt: string | null;
  };
  generatedAt: string;
}

export interface LaunchAgentRoutineUpdateRequest {
  name?: string;
  description?: string | null;
  mission?: string | null;
  intervalSeconds?: number;
  schedule?:
    | { kind: "interval"; intervalSeconds: number }
    | { kind: "cron"; expression: string; timezone?: string };
  /** When supplied, all four hard ceilings are required. */
  budgets?: LaunchAgentRoutineBudget;
}

export interface LaunchAgentManagedRoutineUpdateRequest
  extends LaunchAgentRoutineUpdateRequest {
  expectedRevision: string;
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

export interface LaunchAgentManagedRoutineActionRequest
  extends LaunchAgentRoutineActionRequest {
  expectedRevision: string;
  /** Stable across retries of this exact action. */
  idempotencyKey: string;
}

export type LaunchAgentHomeLifecycleState =
  | "needs_setup"
  | "ready"
  | "active"
  | "paused"
  | "disabled";

export type LaunchAgentHomeExecutionState = "idle" | "queued" | "running";

export type LaunchAgentHomeHealth =
  | "unknown"
  | "healthy"
  | "degraded"
  | "failing";

export interface LaunchAgentHomeRequirement {
  id: string;
  /** Exact opaque id accepted by the corresponding action, when applicable. */
  actionId: string | null;
  kind: "routine" | "setting" | "capability" | "grant" | "release";
  label: string;
  description: string | null;
  required: boolean;
  configured: boolean;
  blocking: boolean;
  secret: boolean;
  settingKey: string | null;
  settingScope: "agent" | "per_user" | null;
  input: string | null;
  placeholder: string | null;
  help: string | null;
  group: string | null;
  destination: string | null;
  updatedAt: string | null;
  actions: Array<"set" | "replace" | "remove" | "approve" | "promote">;
}

export type LaunchAgentHomeAuthorityKind =
  | "function"
  | "agent_call"
  | "network"
  | "ai"
  | "storage"
  | "memory"
  | "reporting"
  | "compute"
  | "other";

export interface LaunchAgentHomeAuthorityItem {
  id: string;
  /** Exact capability/grant id accepted by an approval action, if any. */
  actionId: string | null;
  kind: LaunchAgentHomeAuthorityKind;
  direction: "inbound" | "outbound" | "internal";
  label: string;
  target: string | null;
  access: "read" | "write" | "execute";
  source: "manifest" | "routine" | "platform";
  requested: boolean;
  approved: boolean;
  approvalBasis:
    | "live_release"
    | "owner_capability_approval"
    | "platform_policy"
    | "pending";
  effective: boolean;
  required: boolean;
  purpose: string | null;
  badges: Array<"Read" | "Write" | "AI">;
}

export interface LaunchAgentHomeBudget {
  unit: "work_units";
  ceilings: {
    perRun: number;
    daily: number;
    monthly: number;
    callsPerRun: number;
  };
  usage: {
    lastRun: number;
    lastRunCalls: number;
    daily: number;
    monthly: number;
    dayStartedAt: string;
    monthStartedAt: string;
  };
}

export interface LaunchAgentHomeRun {
  id: string;
  status: LaunchAgentRoutineRun["status"];
  trigger: string;
  traceId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  workUnits: number;
  calls: number;
  summary: string | null;
  errorCode: string | null;
  createdAt: string;
  detailUrl: string | null;
}

export interface LaunchAgentHomeReleaseVersion {
  version: string;
  sourceFingerprint: string | null;
  uploadedAt: string | null;
  testedAt: string | null;
  /** Server-derived, owner-safe projection of a signed V2 gx.test result. */
  qualification?: {
    profile: "basic";
    status: "passed";
    summary: string;
    releaseDigest: string;
    cases: {
      declared: number;
      required: number;
      passed: number;
      optionalFailed: number;
    };
    functions: {
      declared: number;
      exercised: number;
    };
    effects: {
      declared: number;
      exercised: number;
      untested: number;
    };
  } | null;
}

export interface LaunchAgentHomeRelease {
  live:
    | (LaunchAgentHomeReleaseVersion & {
      promotedAt: string | null;
      executedVersion: string | null;
      integrity: "verified" | "unverified" | "unknown";
    })
    | null;
  candidate:
    | (LaunchAgentHomeReleaseVersion & {
      authorityChanges: Array<{
        change: "added" | "removed" | "changed";
        path: string;
        label: string;
      }>;
      reviewStatus: "ready" | "owner_review_required" | "unavailable";
      canPromote: boolean;
    })
    | null;
  candidateCount: number;
}

export type LaunchAgentPane =
  | "overview"
  | "interfaces"
  | "alerts"
  | "access"
  | "routines"
  | "functions"
  | "compute"
  | "settings";

/**
 * A navigation-only destination. Consumers must treat `href` as an internal
 * route, never as an executable action or an arbitrary external URL.
 */
export interface LaunchNavigationTarget {
  href: string;
  agentId?: string | null;
  pane?: LaunchAgentPane | null;
  itemId?: string | null;
}

export type LaunchAgentEvidenceKind =
  | "routine"
  | "run"
  | "schedule"
  | "notification"
  | "setting"
  | "authority"
  | "release"
  | "compute";

/**
 * Owner-safe provenance for an operator-facing conclusion. `sourceId` is an
 * opaque record identifier; evidence never contains secret values, raw run
 * arguments/results, or arbitrary model-supplied links.
 */
export interface LaunchAgentEvidenceReference {
  kind: LaunchAgentEvidenceKind;
  sourceId: string;
  label: string;
  observedAt: string | null;
  destination?: LaunchNavigationTarget | null;
}

export type LaunchOperatorItemClass = "report" | "issue";

export type LaunchOperatorConditionCode =
  | "ACCOUNT_BYOK_MISSING"
  | "ACCOUNT_USAGE_EXHAUSTED"
  | "AGENT_CAPABILITY_APPROVAL_REQUIRED"
  | "AGENT_GRANT_REQUIRED"
  | "AGENT_PRIMARY_ROUTINE_MISSING"
  | "AGENT_RELEASE_REVIEW_REQUIRED"
  | "AGENT_REPORTING_NOT_CONFIGURED"
  | "AGENT_SECRET_MISSING"
  | "AGENT_SETTING_MISSING"
  | "ROUTINE_PAUSED_AFTER_FAILURES"
  | "ROUTINE_USAGE_EXHAUSTED";

export type LaunchOperatorDiagnosisProvenance =
  | "platform"
  | "provider"
  | "developer"
  | "combined"
  | "unknown";

export type LaunchOperatorDiagnosticNavigationAction =
  | "inspect_run"
  | "open_logs"
  | "open_routine";

export interface LaunchOperatorDiagnosis {
  /** Stable platform-owned condition code. */
  code: LaunchOperatorConditionCode;
  /**
   * Optional bounded cause code. Provider/developer codes add specificity but
   * cannot select a remediation or impersonate the platform condition code.
   */
  causeCode: string | null;
  summary: string;
  detail: string | null;
  provenance: LaunchOperatorDiagnosisProvenance;
  evidence: LaunchAgentEvidenceReference[];
}

/**
 * Bounded, secret-safe diagnosis stored at the execution trust boundary.
 *
 * `code` is platform-owned when provenance includes `platform`. A developer
 * or provider identifier may only appear as `causeCode`; it cannot select a
 * privileged remediation or impersonate a platform condition.
 */
export interface LaunchOperatorRunDiagnostic {
  version: 1;
  code: string;
  causeCode: string | null;
  summary: string;
  detail: string | null;
  provenance: LaunchOperatorDiagnosisProvenance;
  retryable: boolean | null;
  /**
   * Server-normalized harmless navigation hints from reviewed manifest
   * metadata. They cannot create targets or executable/privileged actions.
   */
  suggestedActions?: LaunchOperatorDiagnosticNavigationAction[];
  redacted: boolean;
}

export interface LaunchOperatorRoutineRunStep {
  id: string;
  stepIndex: number;
  functionName: string;
  status: string;
  durationMs: number | null;
  usage: number;
  receiptId: string | null;
  diagnostic: LaunchOperatorRunDiagnostic | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface LaunchOperatorRoutineRunLogReceipt {
  receiptId: string;
  functionName: string;
  createdAt: string;
  logsAvailable: boolean;
}

export interface LaunchOperatorRoutineRunDetail {
  contractVersion: typeof OPERATOR_DIAGNOSTIC_CONTRACT_VERSION;
  agent: {
    id: string;
    slug: string;
    name: string;
  };
  routine: {
    id: string;
    name: string;
    status: string;
  };
  run: {
    id: string;
    status: string;
    trigger: string;
    traceId: string | null;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    usage: number;
    summary: string | null;
  };
  diagnostic: LaunchOperatorRunDiagnostic | null;
  steps: LaunchOperatorRoutineRunStep[];
  logReceipts: LaunchOperatorRoutineRunLogReceipt[];
  generatedAt: string;
}

export interface LaunchOperatorRoutineRunLogExcerpt {
  contractVersion: typeof OPERATOR_DIAGNOSTIC_CONTRACT_VERSION;
  runId: string;
  receiptId: string;
  functionName: string;
  error: string | null;
  truncated: boolean;
  droppedEntries: number;
  redactedEntries: number;
  logs: Array<{
    time: string;
    level: string;
    message: string;
  }>;
  generatedAt: string;
}

export type LaunchOperatorScope =
  | { kind: "account" }
  | { kind: "agent"; agentId: string }
  | { kind: "routine"; agentId: string; routineId: string }
  | {
    kind: "run";
    agentId: string;
    routineId: string;
    runId: string;
  };

/**
 * Navigation intent without a web route. Web, CLI, MCP, and native clients
 * translate the same target into their own presentation.
 */
export type LaunchOperatorSemanticTarget =
  | {
    kind: "account_provider";
    provider: string | null;
  }
  | {
    kind: "account_usage";
  }
  | {
    kind: "agent_setup_requirement";
    agentId: string;
    requirementId: string;
  }
  | {
    kind: "agent_setting";
    agentId: string;
    settingKey: string;
    settingScope: "agent" | "per_user";
  }
  | {
    kind: "agent_access_item";
    agentId: string;
    itemId: string;
  }
  | {
    kind: "agent_release";
    agentId: string;
    releaseId: string | null;
  }
  | {
    kind: "routine";
    agentId: string;
    routineId: string;
  }
  | {
    kind: "routine_run";
    agentId: string;
    routineId: string;
    runId: string;
  }
  | {
    kind: "routine_logs";
    agentId: string;
    routineId: string;
    runId: string | null;
  };

export type LaunchOperatorRemediationKey =
  | "adjust_capacity"
  | "approve_capability"
  | "approve_grant"
  | "configure_provider"
  | "configure_routine"
  | "configure_secret"
  | "configure_setting"
  | "enable_routine"
  | "inspect_run"
  | "open_logs"
  | "open_routine"
  | "review_access"
  | "review_release"
  | "resume_routine"
  | "run_once"
  | "verify_connection";

export type LaunchOperatorRemediationPresentation =
  | "inline"
  | "navigate"
  | "execute";

export type LaunchOperatorRemediationAuthority =
  | "account_session"
  | "agent_operate";

export type LaunchOperatorRemediationSideEffect =
  | "none"
  | "configuration_write"
  | "bounded_approval"
  | "routine_execution"
  | "schedule_change";

export interface LaunchOperatorRemediationTargetMap {
  adjust_capacity: Extract<LaunchOperatorSemanticTarget, { kind: "routine" }>;
  approve_capability: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "agent_access_item" }
  >;
  approve_grant: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "agent_access_item" }
  >;
  configure_provider: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "account_provider" }
  >;
  configure_routine: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "agent_setup_requirement" }
  >;
  configure_secret: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "agent_setting" }
  >;
  configure_setting: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "agent_setting" }
  >;
  enable_routine: Extract<LaunchOperatorSemanticTarget, { kind: "routine" }>;
  inspect_run: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "routine_run" }
  >;
  open_logs: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "routine_logs" }
  >;
  open_routine: Extract<LaunchOperatorSemanticTarget, { kind: "routine" }>;
  review_access: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "agent_access_item" }
  >;
  review_release: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "agent_release" }
  >;
  resume_routine: Extract<LaunchOperatorSemanticTarget, { kind: "routine" }>;
  run_once: Extract<LaunchOperatorSemanticTarget, { kind: "routine" }>;
  verify_connection: Extract<
    LaunchOperatorSemanticTarget,
    { kind: "routine" }
  >;
}

export interface LaunchOperatorRemediationBase<
  TKey extends LaunchOperatorRemediationKey,
> {
  /** Stable only within the containing issue/report. */
  id: string;
  key: TKey;
  label: string;
  description: string | null;
  presentation: LaunchOperatorRemediationPresentation;
  requiredAuthority: LaunchOperatorRemediationAuthority;
  sideEffect: LaunchOperatorRemediationSideEffect;
  target: LaunchOperatorRemediationTargetMap[TKey];
}

export type LaunchOperatorRemediation = {
  [TKey in LaunchOperatorRemediationKey]: LaunchOperatorRemediationBase<TKey>;
}[LaunchOperatorRemediationKey];

export interface LaunchOperatorAffectedAgent {
  agentId: string;
  /** Blocking is contextual to this Agent, not a property of the issue. */
  blocking: boolean;
}

export interface LaunchOperatorOrdering {
  /** Stable order from the trusted producer; it is not a type priority. */
  sourceOrdinal: number;
  /** Condition keys that should render before this item when present. */
  dependsOnConditionKeys: string[];
}

export interface LaunchOperatorRecoveryPolicy {
  mode:
    | "automatic_reset"
    | "revalidate_condition"
    | "successful_verification";
  mayRecoverAutomatically: boolean;
  /** Recovery never silently resumes a paused schedule. */
  resumesScheduledWork: false;
}

interface LaunchOperatorItemBase<TId extends string | null> {
  /** Null for a compiler candidate; persistent issue storage supplies an id. */
  id: TId;
  /** Stable active-condition/dedupe key derived only from trusted identifiers. */
  conditionKey: string;
  scope: LaunchOperatorScope;
  severity: "info" | "warning" | "critical";
  diagnosis: LaunchOperatorDiagnosis;
  affectedAgents: LaunchOperatorAffectedAgent[];
  remediations: LaunchOperatorRemediation[];
  requiresAction: boolean;
  requiresDecision: boolean;
  ordering: LaunchOperatorOrdering;
  recovery: LaunchOperatorRecoveryPolicy;
  detectedAt: string;
}

export interface LaunchOperatorIssue<TId extends string | null = string>
  extends LaunchOperatorItemBase<TId> {
  itemClass: "issue";
  requiresAction: true;
}

export interface LaunchOperatorReport<TId extends string | null = string>
  extends LaunchOperatorItemBase<TId> {
  itemClass: "report";
  requiresAction: false;
  requiresDecision: false;
  remediations: [];
}

export type LaunchOperatorItem<TId extends string | null = string> =
  | LaunchOperatorIssue<TId>
  | LaunchOperatorReport<TId>;

export type LaunchOperatorItemCandidate = LaunchOperatorItem<null>;

/**
 * Per-user presentation state for a canonical operator item. This state never
 * changes whether the underlying condition is active or recovered.
 */
export interface LaunchOperatorAttentionState {
  state: "open" | "snoozed" | "dismissed";
  readAt: string | null;
  snoozedUntil: string | null;
  dismissedAt: string | null;
}

export interface LaunchOperatorAttentionEntry {
  item: LaunchOperatorItem;
  attention: LaunchOperatorAttentionState;
}

export type LaunchOperatorAttentionAction =
  | "mark_read"
  | "mark_unread"
  | "snooze"
  | "reopen"
  | "dismiss";

export interface LaunchOperatorAttentionActionRequest {
  action: LaunchOperatorAttentionAction;
  /** Required only for `snooze`; must be a future ISO timestamp. */
  snoozedUntil?: string;
}

export interface LaunchOperatorAttentionActionResponse {
  itemId: string;
  attention: LaunchOperatorAttentionState;
}

/**
 * Executes one server-owned remediation from the current canonical issue.
 *
 * The client supplies only opaque IDs plus the Agent Home revision it
 * reviewed. It cannot choose an Agent, routine, authority, or side effect.
 */
export interface LaunchOperatorItemActionRequest {
  remediationId: string;
  /** Client-generated UUID; retries with the same key return the first run. */
  idempotencyKey: string;
  expectedRevision: string;
}

export interface LaunchOperatorItemActionResponse {
  itemId: string;
  remediationId: string;
  action: "run_once";
  requestId: string;
  runId: string;
  state: "queued";
  /** A successful verification still requires a separate owner decision. */
  scheduleState: "paused";
  replayed: boolean;
  generatedAt: string;
}

export interface LaunchOperatorAttentionAgentCount {
  agent: {
    id: string;
    slug: string;
    name: string;
  };
  /** Number of unique active items relevant to this Agent. */
  openCount: number;
  requiresDecisionCount: number;
  blockingCount: number;
}

/**
 * Canonical condition projection used during the Attention read migration.
 *
 * Global pages contain each condition once even when it affects many Agents.
 * Agent counts are relevance projections, so they may sum above `openCount`.
 */
export interface LaunchOperatorAttentionProjection {
  contractVersion: typeof OPERATOR_ISSUE_CONTRACT_VERSION;
  items: LaunchOperatorAttentionEntry[];
  agentCounts: LaunchOperatorAttentionAgentCount[];
  openCount: number;
  requiresDecisionCount: number;
  blockingCount: number;
  /** Opaque cursor for the next page in trusted producer order. */
  nextCursor: string | null;
  available: boolean;
  unavailableReason: "temporarily_unavailable" | null;
  generatedAt: string;
}

export type LaunchAttentionReadSource = "legacy" | "canonical";

/**
 * The Agent's canonical responsibility. Identity (name/description) remains a
 * separate Settings concern; this projection is derived from actual managed
 * routine configuration.
 */
export interface LaunchAgentDirective {
  mission: string;
  source: "primary_routine" | "managed_routines";
  sourceRoutineId: string | null;
  cadence: LaunchAgentRoutineSchedule | null;
  reporting: {
    kind: "galactic_inbox";
    label: "Galactic inbox";
    configured: boolean;
  };
}

export type LaunchAgentOperatingState =
  | "no_live_release"
  | "no_enabled_routine"
  | "setup_required"
  | "error"
  | "running"
  | "queued"
  | "capacity_waiting"
  | "scheduled"
  | "event_waiting"
  | "standing_by"
  | "paused"
  | "disabled";

export type LaunchAgentWorkingExclusionReason =
  | "no_live_release"
  | "no_enabled_routine"
  | "setup_required"
  | "error"
  | "paused"
  | "disabled";

/**
 * Strict fleet-count eligibility. `working` is true only when the Agent is
 * configured and at least one healthy managed routine is actually active.
 */
export interface LaunchAgentWorkingReadiness {
  working: boolean;
  ready: boolean;
  exclusionReason: LaunchAgentWorkingExclusionReason | null;
  activeRoutineCount: number;
  totalRoutineCount: number;
}

/**
 * Human-facing status backed only by routine/run/schedule evidence. It is not
 * inferred from the Agent name, tags, or description and requires no request-
 * path LLM call.
 */
export interface LaunchAgentOperatingSummary {
  mode: LaunchAgentOperatingState;
  /** @deprecated Use mode. */
  state?: LaunchAgentOperatingState;
  label: string;
  detail: string | null;
  basis:
    | "readiness"
    | "routine_run"
    | "capacity"
    | "next_wake"
    | "subscription"
    | "routine";
  routineId: string | null;
  routineName: string | null;
  runId: string | null;
  nextEventAt: string | null;
  lastObservedAt: string | null;
  readiness: LaunchAgentWorkingReadiness;
  evidence: LaunchAgentEvidenceReference[];
  derivedAt: string;
}

export type LaunchAgentActivityKind =
  | "scheduled_run"
  | "routine_run"
  | "agent_event"
  | "attention"
  | "compute_run"
  | "release";

export type LaunchAgentActivityPhase = "up_next" | "now" | "recent";

export interface LaunchAgentActivityItem {
  /** Stable source-derived id, for example `run:{uuid}`. */
  id: string;
  kind: LaunchAgentActivityKind;
  phase: LaunchAgentActivityPhase;
  title: string;
  summary: string | null;
  status: string;
  occurredAt: string | null;
  scheduledAt: string | null;
  routineId: string | null;
  sourceId: string;
  destination: LaunchNavigationTarget | null;
  evidence: LaunchAgentEvidenceReference[];
}

/**
 * Bounded Overview projection: one next event, currently active events, and
 * at most three completed/recent events. `items` is the deduplicated union in
 * display order.
 */
export interface LaunchAgentActivityPreview {
  upNext: LaunchAgentActivityItem | null;
  now: LaunchAgentActivityItem[];
  recent: LaunchAgentActivityItem[];
  items: LaunchAgentActivityItem[];
  generatedAt: string;
}

export interface LaunchAgentActivityResponse {
  agent: {
    id: string;
    slug: string;
    name: string;
  };
  activity: LaunchAgentActivityPreview;
  /** Opaque cursor for the next page of completed/recent events. */
  nextCursor: string | null;
  generatedAt: string;
}

export type LaunchAgentAttentionLifecycleState =
  | "open"
  | "snoozed"
  | "resolved"
  | "archived";

interface LaunchAgentAttentionLifecycleBase {
  /** Read state is orthogonal: reading an incident never resolves it. */
  readAt: string | null;
  stateChangedAt: string;
  resolutionReason: string | null;
}

export interface LaunchAgentAttentionReportLifecycle
  extends LaunchAgentAttentionLifecycleBase {
  state: "open" | "archived";
  snoozedUntil: null;
  resolvedAt: null;
  resolutionReason: null;
  archivedAt: string | null;
}

export interface LaunchAgentAttentionIncidentLifecycle
  extends LaunchAgentAttentionLifecycleBase {
  state: "open" | "snoozed" | "resolved";
  snoozedUntil: string | null;
  resolvedAt: string | null;
  archivedAt: null;
}

export type LaunchAgentAttentionLifecycle =
  | LaunchAgentAttentionReportLifecycle
  | LaunchAgentAttentionIncidentLifecycle;

export interface LaunchAgentAttentionBrief {
  headline: string;
  impact: string | null;
  context: string | null;
  recommendedNextMove: string | null;
  requiresDecision: boolean;
  confidence: number | null;
  evidence: LaunchAgentEvidenceReference[];
}

export type LaunchAgentAttentionActionKey =
  | "open_access_setting"
  | "open_release_review"
  | "open_routine"
  | "approve_grant"
  | "resume_agent";

/**
 * Canonical persisted/server action parameters. These names intentionally use
 * the same camelCase convention as the Launch API. An action is always bound
 * to its source Agent; optional targets open the corresponding top-level pane.
 */
export interface LaunchAgentAttentionActionParameterMap {
  open_access_setting: {
    agentId: string;
    settingKey?: string;
  };
  open_release_review: {
    agentId: string;
    releaseId?: string;
  };
  open_routine: {
    agentId: string;
    routineId: string;
  };
  approve_grant: {
    agentId: string;
    grantId: string;
  };
  resume_agent: {
    agentId: string;
  };
}

export type LaunchAgentAttentionCanonicalAction = {
  [TKey in LaunchAgentAttentionActionKey]: {
    key: TKey;
    parameters: LaunchAgentAttentionActionParameterMap[TKey];
  };
}[LaunchAgentAttentionActionKey];

/**
 * `id` is the only value accepted by the action endpoint. The server resolves
 * it to an allowlisted operation; clients never send model-produced params.
 */
export interface LaunchAgentAttentionAction {
  id: string;
  key: LaunchAgentAttentionActionKey;
  label: string;
  emphasis: "primary" | "secondary" | "danger";
  /** Server-validated parameters retained for audit/debug display only. */
  parameters: Record<string, string>;
  destination: LaunchNavigationTarget | null;
}

interface LaunchAgentAttentionBase<
  TLifecycle extends LaunchAgentAttentionLifecycle,
> {
  id: string;
  notificationId: string;
  agentId: string;
  severity: "info" | "warning" | "critical";
  requiresAction: boolean;
  lifecycle: TLifecycle;
  brief: LaunchAgentAttentionBrief;
  actions: LaunchAgentAttentionAction[];
  occurredAt: string;
  enrichment: {
    status: "raw" | "pending" | "ready" | "failed";
    version: string | null;
    generatedAt: string | null;
  };
  raw: {
    kind: string;
    title: string;
    body: string | null;
  };
}

export interface LaunchAgentAttentionReport
  extends LaunchAgentAttentionBase<LaunchAgentAttentionReportLifecycle> {
  type: "report";
  requiresAction: false;
}

export interface LaunchAgentAttentionIncident
  extends LaunchAgentAttentionBase<LaunchAgentAttentionIncidentLifecycle> {
  type: "incident";
  requiresAction: true;
  incidentCode: string | null;
}

export type LaunchAgentAttentionItem =
  | LaunchAgentAttentionReport
  | LaunchAgentAttentionIncident;

export interface LaunchAgentAttentionProjection {
  items: LaunchAgentAttentionItem[];
  openCount: number;
  requiresDecisionCount: number;
  /** Opaque cursor for the next, older page of active Attention. */
  nextCursor?: string | null;
  /**
   * False only when the optional Attention dependency could not be read.
   * Older servers omit this field; clients should treat omission as available.
   */
  available?: boolean;
  unavailableReason?: "temporarily_unavailable" | null;
  /**
   * Additive M5 read migration. Existing fields remain the legacy notification
   * projection until clients cut over; when `readSource` is canonical, clients
   * should render and count `operatorItems`.
   */
  readSource?: LaunchAttentionReadSource;
  operatorItems?: LaunchOperatorAttentionProjection;
}

export interface LaunchGlobalAttentionEntry {
  agent: {
    id: string;
    slug: string;
    name: string;
  };
  item: LaunchAgentAttentionItem;
}

export interface LaunchGlobalAttentionAgentCount {
  agent: LaunchGlobalAttentionEntry["agent"];
  openCount: number;
  requiresDecisionCount: number;
}

export interface LaunchGlobalAttentionResponse {
  entries: LaunchGlobalAttentionEntry[];
  /** Exact counts for every owned Agent with active Attention. */
  agentCounts: LaunchGlobalAttentionAgentCount[];
  openCount: number;
  requiresDecisionCount: number;
  /** Opaque cursor for the next, older page of active Attention. */
  nextCursor: string | null;
  available: boolean;
  unavailableReason: "temporarily_unavailable" | null;
  generatedAt: string;
  /**
   * Additive M5 read migration. Global canonical items are unique conditions;
   * affected-Agent fanout and exact per-Agent counts live in this projection.
   */
  readSource?: LaunchAttentionReadSource;
  operatorItems?: LaunchOperatorAttentionProjection;
}

export interface LaunchAgentAttentionActionRequest {
  action:
    | "read"
    | "archive"
    | "snooze"
    | "resolve"
    | "reopen"
    | "execute_brief";
  actionId?: string;
  snoozedUntil?: string;
  resolutionReason?: string;
  idempotencyKey: string;
}

export interface LaunchAgentAttentionActionResponse {
  ok: boolean;
  notificationId: string;
  actionId: string | null;
  lifecycle: LaunchAgentAttentionLifecycle;
  destination?: LaunchNavigationTarget | null;
}

export type LaunchAgentAccessGroupKind =
  | "external_endpoint"
  | "configuration"
  | "agent"
  | "ai"
  | "storage"
  | "memory"
  | "compute"
  | "reporting"
  | "internal";

export interface LaunchAgentAccessCredential {
  key: string;
  label: string;
  required: boolean;
  configured: boolean;
}

export interface LaunchAgentAccessSetting {
  key: string;
  label: string;
  required: boolean;
  configured: boolean;
  secret: boolean;
}

export interface LaunchAgentAccessConsumer {
  kind: "routine" | "function";
  id: string;
  label: string;
}

export interface LaunchAgentAccessGroup {
  id: string;
  kind: LaunchAgentAccessGroupKind;
  label: string;
  description: string | null;
  target: string | null;
  configured: boolean;
  effective: boolean;
  credentials: LaunchAgentAccessCredential[];
  settings: LaunchAgentAccessSetting[];
  authority: LaunchAgentHomeAuthorityItem[];
  consumers: LaunchAgentAccessConsumer[];
}

export interface LaunchAgentAccessProjection {
  groups: LaunchAgentAccessGroup[];
  configured: boolean;
  effective: boolean;
}

/**
 * Canonical owner-only read model for the private persistent Agent home.
 * Secret values, routine config/metadata, run arguments/results, and raw source
 * are intentionally excluded. `revision` is an opaque owner-configuration
 * concurrency token; it deliberately excludes run progress, usage, and
 * scheduling timestamps so a wake cannot make an unrelated edit stale. It must
 * be supplied to every Agent-home mutation.
 */
export interface LaunchAgentHomeResponse {
  contractVersion: typeof AGENT_HOME_CONTRACT_VERSION;
  revision: string;
  generatedAt: string;
  agent: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    visibility: "private";
  };
  /** Canonical Operator-grade projections; optional during additive rollout. */
  directive?: LaunchAgentDirective;
  operatingSummary?: LaunchAgentOperatingSummary;
  activity?: LaunchAgentActivityPreview;
  attention?: LaunchAgentAttentionProjection;
  access?: LaunchAgentAccessProjection;
  preferences?: LaunchAgentPreferences;
  responsibility: {
    mission: string;
    cadence: LaunchAgentRoutineSchedule | null;
    reporting: {
      kind: "galactic_inbox";
      label: "Galactic inbox";
      configured: boolean;
    };
  };
  state: {
    lifecycle: LaunchAgentHomeLifecycleState;
    execution: LaunchAgentHomeExecutionState;
    health: LaunchAgentHomeHealth;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    failureCount: number;
    blockers: LaunchAgentRoutineBlocker[];
  };
  setup: {
    ready: boolean;
    requirements: LaunchAgentHomeRequirement[];
  };
  authority: {
    items: LaunchAgentHomeAuthorityItem[];
  };
  /** Aggregate managed-routine state; primary fields above remain compatibility aliases. */
  routines?: Omit<LaunchAgentRoutinesResponse, "agent" | "generatedAt">;
  capacity: LaunchCapacityResponse | null;
  agentCapacity?: LaunchAgentCapacityResponse | null;
  budget: LaunchAgentHomeBudget | null;
  release: LaunchAgentHomeRelease;
  recentRuns: LaunchAgentHomeRun[];
  actions: {
    canEditIdentity: boolean;
    canEditRoutine: boolean;
    canManageSettings: boolean;
    canApproveCapabilities: boolean;
    canActivate: boolean;
    canPause: boolean;
    canRunNow: boolean;
    canPromoteCandidate: boolean;
  };
}

export interface LaunchAgentHomeMutationBase {
  expectedRevision: string;
}

export interface LaunchAgentHomeIdentityUpdateRequest
  extends LaunchAgentHomeMutationBase {
  name?: string;
  description?: string | null;
}

export interface LaunchAgentHomeRoutineUpdateRequest
  extends LaunchAgentHomeMutationBase, LaunchAgentRoutineUpdateRequest {}

export interface LaunchAgentHomeSettingsUpdateRequest
  extends LaunchAgentHomeMutationBase {
  values: Record<string, string | null>;
}

export type LaunchAgentHomeAction =
  | LaunchAgentRoutineAction
  | "promote_candidate";

export interface LaunchAgentHomeActionRequest
  extends LaunchAgentHomeMutationBase {
  action: LaunchAgentHomeAction;
  /** Client-generated UUID; retries with the same key return the first action. */
  idempotencyKey: string;
  capabilityIds?: string[];
  version?: string;
}

export interface LaunchAgentSummary {
  id: string;
  slug: string;
  name: string;
  iconUrl?: string | null;
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

export type LaunchFleetAgentState =
  | "active"
  | "paused"
  | "error"
  | "idle"
  | "unconfigured";

export type LaunchFleetAgentHealth =
  | "healthy"
  | "waiting"
  | "paused"
  | "error"
  | "idle";

export interface LaunchFleetActivity {
  id: string;
  kind: "run" | "alert";
  title: string;
  summary?: string | null;
  status: string;
  routineId?: string | null;
  createdAt: string;
}

export interface LaunchAgentPreferences {
  agentId: string;
  favoriteInterfaceIds: string[];
  /**
   * False means the server may initialize the first available Interface as the
   * onboarding favorite. Once true, an empty list is an intentional choice.
   */
  favoritesInitialized: boolean;
  /** True only after the owner explicitly chose this list, including none. */
  favoritesExplicit: boolean;
  revision: string;
  updatedAt: string | null;
}

export interface LaunchAgentPreferencesResponse {
  preferences: LaunchAgentPreferences;
}

export interface LaunchAgentPreferencesUpdateRequest {
  expectedRevision: string;
  favoriteInterfaceIds: string[];
  favoritesInitialized: true;
}

export interface LaunchFleetOrderUpdateRequest {
  /** Complete ordered list of owner-visible Agent ids. */
  agentIds: string[];
  expectedRevision: string;
}

export interface LaunchFleetOrderResponse {
  revision: string;
  positions: Array<{
    agentId: string;
    fleetPosition: number;
  }>;
  updatedAt: string;
}

export const LAUNCH_FLEET_SHORTCUT_ACTIONS = [
  "search",
  "alerts",
  "settings",
  "agent-1",
  "agent-2",
  "agent-3",
  "agent-4",
  "agent-5",
  "agent-6",
  "agent-7",
  "agent-8",
  "agent-9",
  "agent-10",
  "help",
  "dismiss",
] as const;

export type LaunchFleetShortcutAction =
  typeof LAUNCH_FLEET_SHORTCUT_ACTIONS[number];

export const LAUNCH_FLEET_SHORTCUT_DEFAULTS = {
  search: "k",
  alerts: "a",
  settings: "s",
  "agent-1": "1",
  "agent-2": "2",
  "agent-3": "3",
  "agent-4": "4",
  "agent-5": "5",
  "agent-6": "6",
  "agent-7": "7",
  "agent-8": "8",
  "agent-9": "9",
  "agent-10": "0",
  help: "?",
  dismiss: "Escape",
} as const satisfies Record<LaunchFleetShortcutAction, string>;

/**
 * Persisted shortcuts are partial overrides of the launch client's canonical
 * defaults. `null` deliberately disables one action without disabling the
 * complete keyboard-shortcut surface.
 */
export type LaunchFleetShortcutMap = Partial<
  Record<LaunchFleetShortcutAction, string | null>
>;

export interface LaunchFleetPreferences {
  revision: string;
  shortcutsEnabled: boolean;
  shortcutMap: LaunchFleetShortcutMap;
  updatedAt: string;
}

export interface LaunchFleetPreferencesResponse {
  preferences: LaunchFleetPreferences;
}

export interface LaunchFleetPreferencesUpdateRequest {
  expectedRevision: string;
  shortcutsEnabled: boolean;
  shortcutMap: LaunchFleetShortcutMap;
}

export interface LaunchFleetAgentSummary {
  agent: LaunchAgentSummary;
  state: LaunchFleetAgentState;
  health: LaunchFleetAgentHealth;
  routineCount: number;
  activeRoutineCount: number;
  nextWakeAt: string | null;
  lastRunAt: string | null;
  deferredWakeCount: number;
  /**
   * Canonical operator Attention: open incidents plus unread open reports.
   * `unreadAlertCount` remains for one compatibility release.
   */
  attentionCount?: number;
  unreadAlertCount: number;
  recentActivity: LaunchFleetActivity[];
  capacity?: LaunchAgentCapacityResponse | null;
  workingReadiness?: LaunchAgentWorkingReadiness;
  operatingSummary?: LaunchAgentOperatingSummary;
  preferences?: LaunchAgentPreferences;
  fleetPosition?: number | null;
}

export interface LaunchFleetWorkingSummary {
  working: number;
  total: number;
  paused: number;
  blocked: number;
  failing: number;
}

export interface LaunchFleetResponse {
  agents: LaunchFleetAgentSummary[];
  accountCapacity: LaunchCapacityResponse;
  workingSummary?: LaunchFleetWorkingSummary;
  fleetRevision?: string;
  generatedAt: string;
}

export type LaunchAgentSearchSubjectKind =
  | "agent"
  | "directive"
  | "interface"
  | "routine"
  | "function"
  | "function_field"
  | "attention"
  | "run"
  | "release"
  | "setting"
  | "authority";

export interface LaunchAgentSearchRequest {
  query: string;
  agentId?: string | null;
  kinds?: LaunchAgentSearchSubjectKind[];
  limit?: number;
}

/**
 * Search is navigation-only: results contain no mutation payload, action key,
 * secret value, raw run argument/result, or arbitrary external URL.
 */
export interface LaunchAgentSearchResult {
  id: string;
  kind: LaunchAgentSearchSubjectKind;
  agent: {
    id: string;
    slug: string;
    name: string;
  };
  title: string;
  summary: string | null;
  destination: LaunchNavigationTarget;
  score: number;
}

export interface LaunchAgentSearchResponse {
  query: string;
  results: LaunchAgentSearchResult[];
  generatedAt: string;
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
export type LaunchAgentFunctionPermissionSource =
  LaunchCallerFunctionPermissionSource;
/** @deprecated Use LaunchCallerFunctionPermissionSummary. */
export type LaunchAgentFunctionPermissionSummary =
  LaunchCallerFunctionPermissionSummary;
/** @deprecated Use LaunchCallerFunctionPermissionUpdate. */
export type LaunchAgentFunctionPermissionUpdate =
  LaunchCallerFunctionPermissionUpdate;
/** @deprecated Use LaunchCallerFunctionPermissionsResponse. */
export type LaunchAgentFunctionPermissionsResponse =
  LaunchCallerFunctionPermissionsResponse;
/** @deprecated Use LaunchCallerFunctionPermissionsUpdateRequest. */
export type LaunchAgentFunctionPermissionsUpdateRequest =
  LaunchCallerFunctionPermissionsUpdateRequest;
/** @deprecated Use LaunchCallerPermissionRequired. */
export type LaunchAgentPermissionRequired = LaunchCallerPermissionRequired;
/** @deprecated Use LaunchCallerPermissionDenied. */
export type LaunchAgentPermissionDenied = LaunchCallerPermissionDenied;
