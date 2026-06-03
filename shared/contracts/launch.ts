export const LAUNCH_MVP_VERSION = 'launch-mvp-v1' as const;

export const LAUNCH_INCLUDED_CAPABILITIES = [
  'install',
  'tool_library',
  'tool_discovery',
  'public_tool_pages',
  'widgets',
  'owner_admin',
  'light_wallet',
  'builder_leaderboard',
  'fee_credit_leaderboard',
  'launch_embeddings',
  'cli_api_mcp',
] as const;

export type LaunchIncludedCapability = typeof LAUNCH_INCLUDED_CAPABILITIES[number];

export const LAUNCH_DEFERRED_CAPABILITIES = [
  'desktop',
  'byok',
  'web_search',
  'cerebras',
  'standalone_agent',
  'command_cards',
  'command_dashboards',
  'agentic_ui_composer',
  'routines',
  'tool_builder_agent',
] as const;

export type LaunchDeferredCapability = typeof LAUNCH_DEFERRED_CAPABILITIES[number];

export const LAUNCH_PUBLIC_ROUTES = [
  '/',
  '/install',
  '/library',
  '/discover',
  '/tools/:slug',
  '/wallet',
  '/settings',
  '/admin/tools/:id',
] as const;

export type LaunchPublicRoute = typeof LAUNCH_PUBLIC_ROUTES[number];

export const LAUNCH_API_ROUTES = [
  'GET /api/launch/status',
  'GET /api/launch/openapi.json',
  'GET /api/launch/install',
  'GET /api/launch/api-keys',
  'POST /api/launch/api-keys',
  'DELETE /api/launch/api-keys/:id',
  'GET /api/launch/library',
  'GET /api/launch/discover',
  'GET /api/launch/tools/:id',
  'GET /api/launch/tools/:id/widgets',
  'GET /api/launch/tools/:id/widgets/:widgetId',
  'POST /api/launch/tools/:id/widgets/:widgetId/render',
  'GET /api/launch/admin/tools/:id',
  'GET /api/launch/wallet',
  'GET /api/launch/leaderboard',
  'GET /api/launch/platform-primitives',
] as const;

export type LaunchApiRoute = typeof LAUNCH_API_ROUTES[number];

export const LAUNCH_INSTALL_TARGETS = [
  'claude_code',
  'cursor',
  'codex',
  'openai_remote_mcp',
  'generic_mcp',
  'cli',
  'api',
] as const;

export type LaunchInstallTarget = typeof LAUNCH_INSTALL_TARGETS[number];

export const LAUNCH_TOOL_RELATIONSHIPS = [
  'owner',
  'installed',
  'public',
] as const;

export type LaunchToolRelationship = typeof LAUNCH_TOOL_RELATIONSHIPS[number];

export const LAUNCH_TOOL_KINDS = [
  'mcp',
  'http',
  'markdown',
  'gpu',
] as const;

export type LaunchToolKind = typeof LAUNCH_TOOL_KINDS[number];

export const LAUNCH_TOOL_VISIBILITIES = [
  'public',
  'private',
  'unlisted',
] as const;

export type LaunchToolVisibility = typeof LAUNCH_TOOL_VISIBILITIES[number];

export const LAUNCH_LEADERBOARD_KINDS = [
  'builder',
  'fee_credit',
] as const;

export type LaunchLeaderboardKind = typeof LAUNCH_LEADERBOARD_KINDS[number];

export const LAUNCH_PLATFORM_PRIMITIVES = [
  'install',
  'deploy',
  'publish',
  'discover',
  'wallet',
  'pricing',
  'receipts',
  'api_keys',
  'owner_admin',
  'widgets',
] as const;

export type LaunchPlatformPrimitive = typeof LAUNCH_PLATFORM_PRIMITIVES[number];

export interface LaunchScopeContract {
  version: typeof LAUNCH_MVP_VERSION;
  thesis: string;
  includedCapabilities: readonly LaunchIncludedCapability[];
  deferredCapabilities: readonly LaunchDeferredCapability[];
  publicRoutes: readonly LaunchPublicRoute[];
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

export interface LaunchToolInstallContext {
  tool: LaunchToolSummary;
  selectedToolSlug: string;
  publicToolUrl: string;
  installUrl: string;
  platformMcpUrl: string;
  recommendedApiKey: LaunchApiKeyCreateRequest;
  widgetUrls: Array<{
    id: string;
    label: string;
    openUrl: string;
    renderUrl?: string | null;
  }>;
  agentHandoff: string[];
}

export interface LaunchInstallResponse {
  instructions: LaunchInstallInstruction[];
  toolInstall?: LaunchToolInstallContext | null;
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

export interface LaunchMoneyAmount {
  light: number;
  display: string;
}

export interface LaunchPricingSummary {
  defaultCallPrice?: LaunchMoneyAmount | null;
  freeToInstall: boolean;
  paidFunctionsCount?: number;
}

export interface LaunchWidgetSummary {
  id: string;
  label: string;
  description?: string | null;
  public: boolean;
  previewAvailable: boolean;
  openUrl?: string | null;
  detailUrl?: string | null;
  renderUrl?: string | null;
}

export interface LaunchWidgetFunctionSummary {
  uiFunction?: string | null;
  dataFunction?: string | null;
  dataTool?: string | null;
}

export interface LaunchWidgetRenderSurface {
  mode: 'runtime_function';
  endpoint: LaunchApiRoute;
  method: 'POST';
  authRequired: true;
  uiFunction: string;
  dataFunction?: string | null;
  dataTool?: string | null;
  htmlField: 'app_html';
  sandbox: {
    iframe: true;
    allowScripts: true;
    allowSameOrigin: false;
  };
}

export interface LaunchWidgetDetail {
  summary: LaunchWidgetSummary;
  functions: LaunchWidgetFunctionSummary;
  pollIntervalSeconds?: number | null;
  dependencies?: unknown[];
  renderSurface?: LaunchWidgetRenderSurface | null;
}

export interface LaunchWidgetDetailResponse {
  tool: Pick<
    LaunchToolSummary,
    'id' | 'slug' | 'name' | 'relationship' | 'publicUrl' | 'adminUrl'
  >;
  widget: LaunchWidgetDetail;
  generatedAt: string;
}

export interface LaunchWidgetRenderRequest {
  args?: Record<string, unknown>;
}

export interface LaunchWidgetRenderedPayload {
  html: string;
  meta?: Record<string, unknown> | null;
  version?: string | null;
  rawResult?: unknown;
  receiptId?: string | null;
  durationMs?: number | null;
}

export interface LaunchWidgetRenderResponse {
  success: boolean;
  tool: Pick<LaunchToolSummary, 'id' | 'slug' | 'name'>;
  widget: Pick<LaunchWidgetSummary, 'id' | 'label' | 'description'>;
  render: LaunchWidgetRenderedPayload | null;
  error?: {
    type?: string;
    message: string;
    details?: unknown;
  } | null;
  generatedAt: string;
}

export type LaunchDiscoveryRetrievalMode =
  | 'browse'
  | 'lexical'
  | 'semantic'
  | 'hybrid';

export type LaunchDiscoverySource =
  | 'tools'
  | 'widgets'
  | 'public_pages'
  | 'install_docs'
  | 'platform_primitives';

export type LaunchRelevanceSource = 'semantic' | 'lexical' | 'curated';

export interface LaunchRelevanceSummary {
  source: LaunchRelevanceSource;
  score?: number | null;
  signals?: string[];
}

export interface LaunchDiscoveryRetrievalSummary {
  mode: LaunchDiscoveryRetrievalMode;
  embeddedSources: LaunchDiscoverySource[];
  fallbackSources: LaunchDiscoverySource[];
  embeddingModel?: string | null;
  fallbackReason?: string | null;
}

export interface LaunchToolOwnerSummary {
  userId: string;
  displayName?: string | null;
  profileSlug?: string | null;
  avatarUrl?: string | null;
}

export interface LaunchToolSummary {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  kind: LaunchToolKind;
  visibility: LaunchToolVisibility;
  relationship: LaunchToolRelationship;
  owner: LaunchToolOwnerSummary;
  installed: boolean;
  installUrl?: string | null;
  publicUrl?: string | null;
  adminUrl?: string | null;
  pricing?: LaunchPricingSummary;
  widgets: LaunchWidgetSummary[];
  tags?: string[];
  updatedAt?: string | null;
  relevance?: LaunchRelevanceSummary;
}

export interface LaunchToolAdminSummary {
  tool: LaunchToolSummary;
  editableFields: readonly (
    | 'name'
    | 'description'
    | 'visibility'
    | 'pricing'
    | 'widgets'
    | 'secrets'
    | 'trust'
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
    visibility: LaunchToolVisibility;
    download_access: string | null;
  };
  reliability?: unknown;
  execution_receipts: {
    enabled: true;
    field: 'receipt_id';
    backing_log: 'mcp_call_logs.id';
  };
}

export interface LaunchDiscoveryRequest {
  query?: string;
  kind?: LaunchToolKind | 'all';
  includeWidgets?: boolean;
  limit?: number;
}

export interface LaunchDiscoveryResponse {
  query?: string | null;
  results: LaunchToolSummary[];
  platformPrimitives?: LaunchPlatformPrimitiveSuggestion[];
  retrieval?: LaunchDiscoveryRetrievalSummary;
  generatedAt: string;
}

export interface LaunchLibraryResponse {
  owned: LaunchToolSummary[];
  installed: LaunchToolSummary[];
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
  actions?: LaunchWalletAction[];
  recentTransactions?: LaunchWalletTransaction[];
  recentReceipts?: LaunchWalletReceiptSummary[];
  recentEarnings?: LaunchWalletEarningSummary[];
  recentPayouts?: LaunchWalletPayoutSummary[];
}

export type LaunchPayoutStatusKind =
  | 'not_connected'
  | 'onboarding'
  | 'ready'
  | 'unavailable';

export interface LaunchPayoutStatus {
  kind: LaunchPayoutStatusKind;
  label: string;
  description: string;
  actionUrl?: string | null;
}

export interface LaunchWalletAction {
  id: 'topup' | 'transactions' | 'receipts' | 'earnings' | 'payouts';
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
  featuredTool?: Pick<LaunchToolSummary, 'id' | 'slug' | 'name'> | null;
}

export interface LaunchLeaderboardResponse {
  kind: LaunchLeaderboardKind;
  period: '30d' | '90d' | 'all';
  entries: LaunchLeaderboardEntry[];
  generatedAt: string;
}

export const LAUNCH_SCOPE_CONTRACT: LaunchScopeContract = {
  version: LAUNCH_MVP_VERSION,
  thesis: 'Deploy tools any existing agent can install, run, compose, and pay for.',
  includedCapabilities: LAUNCH_INCLUDED_CAPABILITIES,
  deferredCapabilities: LAUNCH_DEFERRED_CAPABILITIES,
  publicRoutes: LAUNCH_PUBLIC_ROUTES,
  apiRoutes: LAUNCH_API_ROUTES,
};

export function isLaunchDeferredCapability(
  value: unknown,
): value is LaunchDeferredCapability {
  return typeof value === 'string' &&
    (LAUNCH_DEFERRED_CAPABILITIES as readonly string[]).includes(value);
}

export function isLaunchIncludedCapability(
  value: unknown,
): value is LaunchIncludedCapability {
  return typeof value === 'string' &&
    (LAUNCH_INCLUDED_CAPABILITIES as readonly string[]).includes(value);
}
