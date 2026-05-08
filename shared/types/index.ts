// Ultralight Shared Types
// Used across API, Web, and Runtime

// ============================================
// USER & AUTH
// ============================================

// Supported BYOK providers.
// Legacy provider values stay in the union so old DB records continue to hydrate safely.
export const ACTIVE_BYOK_PROVIDER_IDS = [
  'openrouter',
  'openai',
  'deepseek',
  'nvidia',
  'google',
  'xai',
] as const;

export const LEGACY_BYOK_PROVIDER_IDS = ['anthropic', 'moonshot'] as const;

export type ActiveBYOKProvider = typeof ACTIVE_BYOK_PROVIDER_IDS[number];
export type LegacyBYOKProvider = typeof LEGACY_BYOK_PROVIDER_IDS[number];
export type BYOKProvider = ActiveBYOKProvider | LegacyBYOKProvider;

export function isActiveBYOKProvider(
  value: unknown,
): value is ActiveBYOKProvider {
  return typeof value === 'string' &&
    (ACTIVE_BYOK_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isLegacyBYOKProvider(
  value: unknown,
): value is LegacyBYOKProvider {
  return typeof value === 'string' &&
    (LEGACY_BYOK_PROVIDER_IDS as readonly string[]).includes(value);
}

// BYOK configuration for a single provider
export interface BYOKConfig {
  provider: BYOKProvider;
  has_key: boolean; // Never expose actual key to frontend
  model?: string; // Default model for this provider
  added_at: string;
}

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  tier: Tier;
  tier_expires_at: string | null;
  ai_credit_balance: number; // Light
  ai_credit_resets_at: string | null;
  balance_light: number; // Spendable Light from deposits and converted earnings
  deposit_balance_light: number; // Purchased/top-up Light plus converted creator earnings
  earned_balance_light: number; // Unconverted creator earnings, payout-eligible or convertible
  escrow_light: number; // Total Light held in marketplace escrow
  escrow_deposit_light: number; // Escrowed purchased Light
  escrow_earned_light: number; // Escrowed earned Light
  total_earned_light: number; // Lifetime creator earnings before payout/spend debits
  auto_add_earnings_to_balance: boolean; // Future creator earnings convert to spendable balance automatically
  hosting_last_billed_at: string | null;
  // Stripe identity plus legacy auto top-up columns. Auto top-up is disabled.
  stripe_customer_id: string | null;
  auto_topup_enabled: boolean;
  auto_topup_threshold_light: number;
  auto_topup_amount_light: number;
  auto_topup_last_failed_at: string | null;
  byok_enabled: boolean;
  byok_provider: BYOKProvider | null; // Primary provider
  byok_configs: BYOKConfig[]; // All configured providers (keys stored encrypted separately)
  /** @deprecated DB column exists but unused. User memory now lives in memory.md (R2) and the memory table (Supabase KV). */
  root_memory: Record<string, unknown>;
  preferences: UserPreferences;
  created_at: string;
  updated_at: string;
}

export interface UserPreferences {
  email_notifications: boolean;
  public_profile: boolean;
  [key: string]: unknown;
}

// ============================================
// APPS
// ============================================

export interface VersionMetadata {
  version: string;
  size_bytes: number;
  created_at: string;
  trust?: VersionTrustMetadata;
}

export interface VersionTrustSignature {
  algorithm: 'HMAC-SHA256';
  signer: string;
  signed_at: string;
  signature: string;
  key_hint?: string;
}

export interface VersionTrustMetadata {
  schema_version: 1;
  app_id: string;
  version: string;
  runtime: 'deno' | 'gpu' | string;
  manifest_hash: string | null;
  artifact_hash: string;
  artifact_hashes: Record<string, string>;
  storage_key?: string;
  permissions: string[];
  entrypoints: string[];
  required_secrets: string[];
  per_user_secrets: string[];
  signature: VersionTrustSignature;
}

export type AppGpuStatus =
  | 'building'
  | 'benchmarking'
  | 'live'
  | 'build_failed'
  | 'benchmark_failed'
  | 'build_config_invalid';

export interface App {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  visibility: 'private' | 'unlisted' | 'public';
  download_access: 'owner' | 'public';
  current_version: string;
  versions: string[];
  version_metadata: VersionMetadata[];
  storage_key: string;
  storage_bytes: number;
  skills_md: string | null;
  skills_parsed: ParsedSkills | null;
  exports: string[];
  declared_permissions: PermissionDeclaration[];
  last_build_at: string | null;
  last_build_success: boolean | null;
  last_build_logs: BuildLogEntry[];
  last_build_error: string | null;
  total_runs: number;
  total_unique_users: number;
  runs_7d: number;
  runs_30d: number;
  // Like counters (denormalized, kept in sync by DB trigger)
  likes: number;
  dislikes: number;
  // Weighted counters (paid-tier likes only, used for search ranking)
  weighted_likes: number;
  weighted_dislikes: number;
  category: string | null;
  tags: string[];
  // App Store public listing (Phase 2)
  //   screenshots: ordered array of R2 storage keys rendered on /app/:id
  //   long_description: markdown body rendered below the hero
  screenshots: string[];
  long_description: string | null;
  // Environment variables (encrypted, keys only exposed to owner)
  env_vars: Record<string, string>;
  // Per-user env var schema: declares which keys are per_user with descriptions
  // Format: { "KEY_NAME": { scope: "per_user", description: "...", required: true } }
  env_schema: Record<string, EnvSchemaEntry>;
  // HTTP endpoint settings
  http_rate_limit: number;
  http_enabled: boolean;
  // Supabase integration (BYOS - Bring Your Own Supabase)
  supabase_url: string | null;
  supabase_anon_key_encrypted: string | null;
  supabase_service_key_encrypted: string | null;
  supabase_enabled: boolean;
  supabase_config_id: string | null;
  // Manifest-based configuration (v2 architecture)
  manifest: string | null; // JSON stringified AppManifest
  app_type: 'mcp' | 'skill' | null; // null means legacy auto-detect; 'skill' = .md context file
  // GPU compute runtime
  runtime: 'deno' | 'gpu' | null; // null = legacy deno
  gpu_type: string | null; // GpuType identifier (e.g. 'A100-80GB-SXM')
  gpu_status: AppGpuStatus | null;
  gpu_endpoint_id: string | null; // RunPod (or other provider) endpoint ID
  gpu_config: Record<string, unknown> | null; // Parsed ultralight.gpu.yaml
  gpu_benchmark: Record<string, unknown> | null; // BenchmarkStats from benchmark runs
  gpu_pricing_config: Record<string, unknown> | null; // GpuPricingConfig
  gpu_max_duration_ms: number | null; // Max execution time ceiling
  gpu_concurrency_limit: number | null; // Per-function concurrency cap
  // Per-app rate limit config (Pro, owner-configurable)
  rate_limit_config: AppRateLimitConfig | null;
  // Per-function pricing config (owner-configurable)
  pricing_config: AppPricingConfig | null;
  // Hosting billing
  hosting_suspended: boolean;
  // Health monitoring
  health_status: string; // 'healthy' | 'unhealthy'
  last_healed_at: string | null; // kept for migration compat
  auto_heal_enabled: boolean; // opt-out of health monitoring
  // D1 relational database (per-app, lazy-provisioned)
  d1_database_id: string | null; // Cloudflare D1 database UUID
  d1_status: 'pending' | 'provisioning' | 'ready' | 'error' | null;
  d1_provisioned_at: string | null;
  d1_last_migration_version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ParsedSkills {
  functions: SkillFunction[];
  permissions: PermissionDeclaration[];
  description?: string;
}

export interface SkillFunction {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  returns: unknown;
  examples?: string[];
}

export interface PermissionDeclaration {
  permission: string; // "memory:read", "ai:call", "net:api.openai.com"
  required: boolean;
  description?: string;
}

export interface BuildLogEntry {
  time: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

// ============================================
// ENVIRONMENT VARIABLES
// ============================================

export interface EnvVarLimits {
  max_vars_per_app: number;
  max_key_length: number;
  max_value_length: number;
  reserved_prefixes: string[];
}

// Per-user env var schema entry (declared by app owner)
export interface EnvSchemaEntry {
  scope: 'universal' | 'per_user';
  description?: string;
  required?: boolean;
  label?: string;
  input?: 'text' | 'password' | 'email' | 'number' | 'url' | 'textarea';
  placeholder?: string;
  help?: string;
}

export const ENV_VAR_LIMITS: EnvVarLimits = {
  max_vars_per_app: 50,
  max_key_length: 64,
  max_value_length: 4096,
  reserved_prefixes: ['ULTRALIGHT'],
};

/**
 * Validate an environment variable key
 */
export function validateEnvVarKey(
  key: string,
): { valid: boolean; error?: string } {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Key is required' };
  }

  if (key.length > ENV_VAR_LIMITS.max_key_length) {
    return {
      valid: false,
      error: `Key must be ${ENV_VAR_LIMITS.max_key_length} characters or less`,
    };
  }

  // Check reserved prefixes
  for (const prefix of ENV_VAR_LIMITS.reserved_prefixes) {
    if (key.toUpperCase().startsWith(prefix)) {
      return {
        valid: false,
        error: `Keys starting with "${prefix}" are reserved`,
      };
    }
  }

  // Must be valid env var format (uppercase, underscores, numbers)
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    return {
      valid: false,
      error: 'Key must be uppercase letters, numbers, and underscores, starting with a letter',
    };
  }

  return { valid: true };
}

/**
 * Validate an environment variable value
 */
export function validateEnvVarValue(
  value: string,
): { valid: boolean; error?: string } {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Value must be a string' };
  }

  if (value.length > ENV_VAR_LIMITS.max_value_length) {
    return {
      valid: false,
      error: `Value must be ${ENV_VAR_LIMITS.max_value_length} characters or less`,
    };
  }

  return { valid: true };
}

// ============================================
// MEMORY
// ============================================

export interface MemoryEntry {
  id: string;
  user_id: string;
  scope: string; // "user" or "app:{app_id}"
  key: string;
  value: unknown;
  value_type: string;
  created_by_app: string | null;
  updated_by_app: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================
// EXECUTION
// ============================================

export interface Execution {
  id: string;
  app_id: string;
  user_id: string;
  function_name: string;
  arguments: unknown;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  ai_provider: 'platform' | 'byok' | null;
  ai_model: string | null;
  ai_tokens_input: number | null;
  ai_tokens_output: number | null;
  ai_cost_light: number | null;
  success: boolean;
  result: unknown;
  error_type: string | null;
  error_message: string | null;
  error_stack: string | null;
  logs: LogEntry[];
  permissions_checked: string[];
}

export interface LogEntry {
  time: string;
  level: 'log' | 'error' | 'warn' | 'info';
  message: string;
}

// ============================================
// SDK
// ============================================

export interface SDKContext {
  userId: string;
  appId: string;
  executionId: string;
  permissions: string[];
  aiBudgetRemaining: number | null; // Light, null if unlimited (BYOK)
}

// ── AI Content Parts (multimodal) ──

export type AIContentPart = AITextPart | AIFilePart;

export interface AITextPart {
  type: 'text';
  text: string;
}

export interface AIFilePart {
  type: 'file';
  data: string; // base64 data URL or raw text
  filename?: string; // e.g. "notes.pdf" — used to detect type
}

export interface AIRequest {
  model?: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | AIContentPart[];
    cache_control?: { type: 'ephemeral' };
  }>;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

// ── Widget System ──

export interface WidgetDeclaration {
  id: string;
  label: string;
  description?: string;
  ui_function?: string;
  data_function?: string;
  data_tool?: string;
  poll_interval_s?: number;
  dependencies?: WidgetDependencyDeclaration[];
  cards?: CommandCardDeclaration[];
}

export type CommandCardRenderMode = 'native';

export type CommandCardKind =
  | 'metric'
  | 'list'
  | 'timeline'
  | 'sparkline'
  | 'progress'
  | 'summary'
  | 'composite';

export interface WidgetDependencyDeclaration {
  app: string;
  functions: string[];
  access?: 'read';
}

export interface CommandCardDeclaration {
  id: string;
  label: string;
  description?: string;
  size: string;
  render?: CommandCardRenderMode;
  kind?: CommandCardKind;
  data_view?: string;
  data_function?: string;
  refresh_interval_s?: number;
  dependencies?: WidgetDependencyDeclaration[];
}

export interface WidgetAction {
  label: string;
  icon?: string;
  style?: string;
  tool: string;
  args: Record<string, unknown>;
  editable?: {
    field: string;
    initial_value: string;
  };
  prompt_input?: {
    placeholder: string;
  };
}

export interface WidgetItem {
  id: string;
  html: string;
  actions: WidgetAction[];
}

export interface WidgetData {
  meta?: WidgetMeta;
  badge_count?: number;
  items?: WidgetItem[];
  cards?: Record<string, CommandCardDataPayload>;
}

// ── Widget App System (MCP-owned full HTML apps) ──

export interface WidgetMeta {
  title: string;
  icon?: string; // emoji or URL
  badge_count: number;
}

export interface WidgetAppResponse {
  meta: WidgetMeta;
  app_html: string; // complete HTML document
  version?: string; // cache-busting key
}

export interface CommandCardDataPayload {
  card_id?: string;
  meta?: Partial<WidgetMeta> & {
    status?: 'live' | 'paused' | 'error' | string;
    accent?: string;
    cost_per_min?: number;
  };
  body: CommandCardBody;
  footer?: string;
  updated_at?: string;
  version?: string;
}

export type CommandCardBody =
  | CommandMetricCardBody
  | CommandListCardBody
  | CommandTimelineCardBody
  | CommandSparklineCardBody
  | CommandProgressCardBody
  | CommandSummaryCardBody
  | CommandCompositeCardBody;

export interface CommandMetricCardBody {
  kind: 'metric';
  metric: string | number;
  label?: string;
  delta?: string;
}

export interface CommandListCardBody {
  kind: 'list';
  rows: Array<Array<string | number | boolean | null>>;
}

export interface CommandTimelineCardBody {
  kind: 'timeline';
  rows: Array<{
    time?: string;
    title: string;
    subtitle?: string;
    accent?: string;
  }>;
}

export interface CommandSparklineCardBody {
  kind: 'sparkline';
  metric?: string | number;
  label?: string;
  points: number[];
}

export interface CommandProgressCardBody {
  kind: 'progress';
  value: number;
  max?: number;
  label?: string;
}

export interface CommandSummaryCardBody {
  kind: 'summary';
  title?: string;
  lines: string[];
}

export interface CommandCompositeCardBody {
  kind: 'composite';
  children: Array<{
    app_id?: string;
    widget_id: string;
    card_id: string;
    label?: string;
  }>;
}

export interface AIResponse {
  content: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cost_light: number;
  };
  error?: string;
}

// ============================================
// API REQUESTS/RESPONSES
// ============================================

export interface UploadRequest {
  files: Array<{
    name: string;
    content: string;
    size: number;
  }>;
}

export interface UploadResponse {
  app_id: string;
  slug: string;
  version: string;
  url: string;
  exports: string[];
  build_success: boolean;
  build_logs: BuildLogEntry[];
  d1?: {
    provisioned: boolean;
    status: 'ready' | 'failed' | 'skipped';
    database_id?: string;
    migrations_applied: number;
    migrations_skipped: number;
    error?: string;
  };
}

export interface RunRequest {
  function: string;
  args?: unknown[];
}

export interface RunResponse {
  success: boolean;
  result: unknown;
  logs: LogEntry[];
  duration_ms: number;
  receipt_id?: string;
  ai_usage?: {
    model: string;
    input_tokens: number;
    output_tokens: number;
  };
  error?: {
    type: string;
    message: string;
    stack?: string;
    details?: unknown;
  };
}

// ============================================
// PERMISSIONS
// ============================================

export interface AppPermission {
  id: string;
  user_id: string;
  app_id: string;
  permission: string;
  granted_at: string;
  expires_at: string | null;
  duration: 'perpetual' | 'session' | '1h' | '24h' | '7d';
  budget_limit: number | null;
  budget_used: number;
  last_used_at: string | null;
}

// ── Granular Permission Constraints (Pro feature) ──

/** Constraints applied to a permission grant — checked at MCP call time */
export interface GrantConstraints {
  /** CIDR ranges or exact IPs that may call this app (e.g. ["10.0.0.0/8", "203.0.113.5"]) */
  allowed_ips?: string[] | null;
  /** Time window during which calls are allowed */
  time_window?: TimeWindow | null;
  /** Max calls allowed before access is suspended. Resets according to budget_period. */
  budget_limit?: number | null;
  /** Rolling period for budget reset. null = lifetime budget (never resets). */
  budget_period?: 'hour' | 'day' | 'week' | 'month' | null;
  /** ISO timestamp — permission auto-expires after this date */
  expires_at?: string | null;
  /** Per-parameter value whitelists. Keys are parameter names, values are arrays of allowed values. null = unrestricted. */
  allowed_args?: Record<string, (string | number | boolean)[]> | null;
}

/** Allowed time window for calls */
export interface TimeWindow {
  /** Start hour in 24h format (0-23) */
  start_hour: number;
  /** End hour in 24h format (0-23). If end < start, wraps past midnight. */
  end_hour: number;
  /** IANA timezone (e.g. "America/New_York"). Defaults to UTC. */
  timezone?: string;
  /** Days of week allowed (0=Sunday, 6=Saturday). Omit for all days. */
  days?: number[];
}

/** A row from the user_app_permissions table — extended with granular constraints */
export interface PermissionRow {
  app_id: string;
  granted_to_user_id: string;
  granted_by_user_id: string;
  function_name: string;
  allowed: boolean;
  // Granular constraints (stored as JSONB columns)
  allowed_ips: string[] | null;
  time_window: TimeWindow | null;
  budget_limit: number | null;
  budget_used: number;
  budget_period: string | null;
  expires_at: string | null;
  allowed_args: Record<string, (string | number | boolean)[]> | null;
  created_at: string;
  updated_at: string;
}

/** Token scoping — restrict which apps/functions a token can access */
export interface TokenScope {
  /** App IDs this token can access. null = all apps (wildcard). */
  app_ids?: string[] | null;
  /** Function names this token can call. null = all functions. */
  function_names?: string[] | null;
}

/** Per-app rate limit override — set by app owner (Pro) */
export interface AppRateLimitConfig {
  /** Max calls per consumer per minute. null = use platform default. */
  calls_per_minute?: number | null;
  /** Max calls per consumer per day. null = unlimited. */
  calls_per_day?: number | null;
}

/**
 * Per-app pricing config — set by app owner.
 * Enables agent-to-agent micropayments: caller's balance → owner's balance per call.
 * Platform fee is deducted on every transfer.
 */
export interface AppPricingConfig {
  /** Default price in Light per tool call. Applies to any function not in `functions`. 0 = free. */
  default_price_light: number;
  /** Default number of free calls per user before pricing kicks in. 0 = charge from first call. */
  default_free_calls?: number;
  /** Whether free call quota is counted per-app (shared) or per-function (separate). Default: 'function'. */
  free_calls_scope?: 'app' | 'function';
  /** Per-function price overrides. Value is Light (legacy number) or FunctionPricing object. */
  functions?: Record<string, number | FunctionPricing>;
  /** Product catalog for in-app purchases via ultralight.charge(). */
  products?: AppProduct[];
}

/** Per-function pricing override with optional free calls. */
export interface FunctionPricing {
  /** Price in Light per call. */
  price_light: number;
  /** Number of free calls for this function per user. Overrides app-level default_free_calls. */
  free_calls?: number;
}

/** A purchasable product defined by the app owner. */
export interface AppProduct {
  /** Unique product ID (e.g., "premium_report", "export_pdf") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Price in Light */
  price_light: number;
  /** Optional description */
  description?: string;
}

/**
 * Get the price in Light for a specific function call on an app.
 * Returns 0 if no pricing is configured.
 */
export function getCallPriceLight(
  pricingConfig: AppPricingConfig | null | undefined,
  functionName: string,
): number {
  if (!pricingConfig) return 0;
  // Check per-function override first, then default
  if (pricingConfig.functions && functionName in pricingConfig.functions) {
    const val = pricingConfig.functions[functionName];
    if (typeof val === 'number') return val; // legacy format
    return val.price_light; // FunctionPricing format
  }
  return pricingConfig.default_price_light || 0;
}

/**
 * Get the number of free calls for a specific function.
 * Checks per-function override first, then falls back to app-level default.
 * Returns 0 if no free calls configured.
 */
export function getFreeCalls(
  pricingConfig: AppPricingConfig | null | undefined,
  functionName: string,
): number {
  if (!pricingConfig) return 0;
  // Check per-function override first (only in FunctionPricing format)
  if (pricingConfig.functions && functionName in pricingConfig.functions) {
    const val = pricingConfig.functions[functionName];
    if (typeof val === 'object' && val.free_calls !== undefined) {
      return val.free_calls;
    }
  }
  // Fall back to app-level default
  return pricingConfig.default_free_calls || 0;
}

/**
 * Get the scope for free call counting.
 * 'app' = single shared counter across all functions.
 * 'function' = separate counter per function (default).
 */
export function getFreeCallsScope(
  pricingConfig: AppPricingConfig | null | undefined,
): 'app' | 'function' {
  return pricingConfig?.free_calls_scope || 'function';
}

// ============================================
// GPU PRICING HELPERS
// ============================================

/**
 * Get the GPU pricing display mode for an app.
 * Returns null if no GPU pricing is configured.
 */
export function getGpuPricingMode(
  gpuPricingConfig: Record<string, unknown> | null | undefined,
): 'per_call' | 'per_unit' | 'per_duration' | null {
  if (!gpuPricingConfig) return null;
  const mode = gpuPricingConfig.mode;
  if (mode === 'per_call' || mode === 'per_unit' || mode === 'per_duration') {
    return mode;
  }
  return null;
}

/**
 * Get a human-readable label for the GPU pricing unit.
 * Returns "call" for per_call, the unit_label for per_unit, "second" for per_duration.
 */
export function getGpuPricingUnitLabel(
  gpuPricingConfig: Record<string, unknown> | null | undefined,
): string {
  if (!gpuPricingConfig) return 'call';
  switch (gpuPricingConfig.mode) {
    case 'per_call':
      return 'call';
    case 'per_unit':
      return (typeof gpuPricingConfig.unit_label === 'string'
        ? gpuPricingConfig.unit_label
        : 'unit');
    case 'per_duration':
      return 'second';
    default:
      return 'call';
  }
}

// ============================================
// CONTENT LAYER (unified content index)
// ============================================

export type ContentType = 'page' | 'memory_md' | 'library_md';
export type ContentVisibility = 'public' | 'private' | 'shared';

/** A row from the content table — indexes pages, memory.md, library.md */
export interface ContentRow {
  id: string;
  owner_id: string;
  type: ContentType;
  slug: string;
  title: string | null;
  description: string | null;
  visibility: ContentVisibility;
  access_token: string | null;
  embedding_text: string | null;
  size: number | null;
  tags: string[] | null;
  published: boolean;
  // Billing fields
  hosting_suspended: boolean;
  price_light: number;
  created_at: string;
  updated_at: string;
}

/** A row from content_shares — per-email sharing for content items */
export interface ContentShare {
  id: string;
  content_id: string;
  shared_with_email: string;
  shared_with_user_id: string | null;
  access_level: 'read' | 'readwrite';
  created_at: string;
  expires_at: string | null;
}

/** A row from memory_shares — pattern-based KV key sharing */
export interface MemoryShare {
  id: string;
  owner_user_id: string;
  scope: string;
  key_pattern: string;
  shared_with_email: string;
  shared_with_user_id: string | null;
  access_level: 'read' | 'write' | 'readwrite';
  created_at: string;
  expires_at: string | null;
}

// ============================================
// TIER LIMITS
// ============================================
// Platform Limits & Billing Constants
//
// No tiers. Everyone gets the same generous limits for development.
// Published apps are protected by runtime cloud-unit and storage-at-rest metering.
// Storage thresholds are soft billing thresholds, not product hard quotas.
// The Tier type is retained for backward compatibility with the DB column
// but all values map to the same PLATFORM_LIMITS.
//
// Light (✦) is the platform's virtual currency.
//   - Canonical reference: 100 Light per $1 USD  (1 Light ≈ 1¢)
//   - Apple Pay / Google Pay funding: 95 Light per $1 USD
//   - Wire transfer funding: 99 Light per $1 USD
//   - Publisher payout: $1 USD per 100 Light
//   - 15% platform fee on creator revenue
//   - Light is divisible to 8 decimal places

export type Tier = 'free' | 'fun' | 'pro' | 'scale' | 'enterprise';

// ── Light Currency Constants ──

/** Light symbol character for display. */
export const LIGHT_SYMBOL = '✦';

/** Canonical Light/$ reference for internal USD-denominated costs and copy. */
export const LIGHT_PER_DOLLAR_CANONICAL = 100;

/** Exchange rate: Light credited per $1 USD through Apple Pay / Google Pay. */
export const LIGHT_PER_DOLLAR_WALLET = 95;

/** Exchange rate: Light credited per $1 USD through Stripe wire/bank transfer. */
export const LIGHT_PER_DOLLAR_WIRE = 99;

/** Legacy alias retained while old web checkout surfaces are migrated. */
export const LIGHT_PER_DOLLAR_WEB = LIGHT_PER_DOLLAR_WALLET;

/** Legacy alias retained for internal cost conversion at the canonical rate. */
export const LIGHT_PER_DOLLAR_DESKTOP = LIGHT_PER_DOLLAR_CANONICAL;

/** Exchange rate: $1 USD per this many Light when publishers withdraw. */
export const LIGHT_PER_DOLLAR_PAYOUT = LIGHT_PER_DOLLAR_CANONICAL;

/** Platform fee rate applied on creator revenue. */
export const PLATFORM_FEE_RATE = 0.15;

/** Minimum card wallet funding amount in USD cents. */
export const CARD_MINIMUM_CENTS = 2_500;

/** Minimum wire/bank transfer funding amount in USD cents. */
export const WIRE_MINIMUM_CENTS = 2_500;

/** Public cloud usage price, denominated per 1,000 cloud units for display. */
export const CLOUD_UNIT_LIGHT_PER_1K = 1;

/** Worker execution granularity: one cloud unit per started interval. */
export const WORKER_MS_PER_CLOUD_UNIT = 250;

/** D1 read granularity: one cloud unit per started row group. */
export const D1_READ_ROWS_PER_CLOUD_UNIT = 100;

/** D1 write granularity: one cloud unit per row written. */
export const D1_WRITE_ROWS_PER_CLOUD_UNIT = 1;

/** R2 operation granularity: one cloud unit per operation. */
export const R2_OPS_PER_CLOUD_UNIT = 1;

/** KV operation granularity: one cloud unit per operation. */
export const KV_OPS_PER_CLOUD_UNIT = 1;

/** Widget pull granularity: one cloud unit per pull. */
export const WIDGET_PULLS_PER_CLOUD_UNIT = 1;

/** Storage-at-rest rate in Light per GB-month after the free allowance. */
export const STORAGE_LIGHT_PER_GB_MONTH = 100;

// ── Billing Constants (in Light) ──

/** Legacy publish balance gate amount, used only when explicitly enabled. */
export const MIN_PUBLISH_DEPOSIT_LIGHT = 500; // ✦500

/** Legacy published hosting rate, used only when the old hosting meter is enabled. */
export const HOSTING_RATE_LIGHT_PER_MB_PER_HOUR = 2.25; // ✦2.25/MB/hr

/** Data storage soft-cap overage rate in Light per MB per hour (user pays).
 *  Charged hourly for combined storage exceeding the 100MB soft cap.
 *  ✦0.045/MB/hr — 50x cheaper than publisher hosting rate. */
export const DATA_RATE_LIGHT_PER_MB_PER_HOUR = 0.045;

/** Combined storage soft cap (source code + user data). 100MB. */
export const COMBINED_FREE_TIER_BYTES = 104_857_600;

/** Legacy auto top-up threshold (Light). Auto top-up is currently disabled. */
export const AUTO_TOPUP_DEFAULT_THRESHOLD_LIGHT = 100; // ✦100

/** Legacy auto top-up charge amount (Light). Auto top-up is currently disabled. */
export const AUTO_TOPUP_DEFAULT_AMOUNT_LIGHT = 1_000; // ✦1,000

/** Legacy minimum auto top-up amount (Light). Auto top-up is currently disabled. */
export const AUTO_TOPUP_MIN_AMOUNT_LIGHT = 500; // ✦500

/** Minimum withdrawal amount (Light). */
export const MIN_WITHDRAWAL_LIGHT = 5_000; // ✦5,000

/**
 * Stripe processing fee pass-through (still in USD cents — Stripe boundary only).
 * Standard Stripe rate: 2.9% + 30¢ per successful charge.
 */
export const STRIPE_FEE_PERCENT = 0.029; // 2.9%
export const STRIPE_FEE_FIXED_CENTS = 30; // 30¢

/** Calculate the gross USD cents charge that nets the desired deposit after Stripe fees. */
export function calcGrossWithStripeFee(desiredCents: number): number {
  return Math.ceil(
    (desiredCents + STRIPE_FEE_FIXED_CENTS) / (1 - STRIPE_FEE_PERCENT),
  );
}

/**
 * Format a Light amount for display using Instagram-style abbreviations.
 * Amounts >= 5,000 are abbreviated (K, M, B, T).
 * Symbol ✦ is always prepended.
 *
 * Examples: ✦42, ✦2,500, ✦14.5K, ✦2.05M, ✦1.30B
 */
export function formatLight(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  let formatted: string;
  if (abs >= 1_000_000_000_000) {
    formatted = (abs / 1_000_000_000_000).toFixed(2) + 'T';
  } else if (abs >= 1_000_000_000) {
    formatted = (abs / 1_000_000_000).toFixed(2) + 'B';
  } else if (abs >= 1_000_000) formatted = (abs / 1_000_000).toFixed(2) + 'M';
  else if (abs >= 5_000) formatted = (abs / 1_000).toFixed(1) + 'K';
  else if (abs % 1 === 0) formatted = String(abs);
  else formatted = abs.toFixed(2);
  return sign + '\u2726' + formatted;
}

const PLATFORM_LIMITS = {
  max_apps: Infinity,
  weekly_call_limit: 50_000,
  overage_cost_per_100k_light: 0,
  can_publish: true, // gated by deposit, not tier
  price_light_monthly: 0,
  daily_ai_credit_light: 1_600, // ✦1,600 (was $2.00 × 800)
  monthly_ai_credit_light: 48_000, // ✦48,000 (was $60.00 × 800)
  max_file_size_mb: 10,
  max_files_per_app: 50,
  max_storage_bytes: 104_857_600, // 100 MB soft cap (source code + user data)
  execution_timeout_ms: 120_000, // 2min
  log_retention_days: 90,
  allowed_visibility: ['private', 'unlisted', 'public'] as const,
} as const;

// All tier keys map to the same limits — no differentiation.
export const TIER_LIMITS = {
  free: PLATFORM_LIMITS,
  fun: PLATFORM_LIMITS,
  pro: PLATFORM_LIMITS,
  scale: PLATFORM_LIMITS,
  enterprise: PLATFORM_LIMITS,
} as const;

/** @deprecated No tiers — always returns true for backward compatibility. */
export function isProTier(_tier: Tier | string): boolean {
  return true;
}

// ============================================
// ALLOWED FILE TYPES
// ============================================

export const ALLOWED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.md',
  '.mdx',
  '.txt',
  '.csv',
  '.sql',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.conf',
  '.env',
  '.env.example',
  '.env.local',
  '.sh',
  '.bash',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.wasm',
  '.graphql',
  '.gql',
  '.prisma',
  '.lock',
  '.gitignore',
  '.dockerignore',
  '.dockerfile',
  '.editorconfig',
] as const;
export const MAX_UPLOAD_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const MAX_FILES_PER_UPLOAD = 50;

// ============================================
// USER CONTEXT (exposed to apps)
// ============================================

export interface UserContext {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  tier: Tier;
}

// ============================================
// QUERY HELPERS
// ============================================

export interface QueryOptions {
  filter?: (value: unknown) => boolean;
  sort?: { field: string; order: 'asc' | 'desc' };
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  key: string;
  value: unknown;
  updatedAt?: string;
}

// ============================================
// SDK INTERFACE (for TypeScript apps)
// ============================================

export interface UltralightSDK {
  // User context
  user: UserContext | null;
  isAuthenticated(): boolean;
  requireAuth(): UserContext;

  // Data storage (basic)
  store(key: string, value: unknown): Promise<void>;
  load(key: string): Promise<unknown>;
  remove(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;

  // Data storage (query helpers)
  query(prefix: string, options?: QueryOptions): Promise<QueryResult[]>;
  batchStore(items: Array<{ key: string; value: unknown }>): Promise<void>;
  batchLoad(keys: string[]): Promise<Array<{ key: string; value: unknown }>>;
  batchRemove(keys: string[]): Promise<void>;

  // User memory (cross-app)
  remember(key: string, value: unknown): Promise<void>;
  recall(key: string): Promise<unknown>;

  // AI
  ai(request: AIRequest): Promise<AIResponse>;
}

// ============================================
// DOCUMENTATION GENERATION
// ============================================

export interface GenerationConfig {
  ai_enhance: boolean;
}

export interface GenerationResult {
  success: boolean;
  partial: boolean;
  skills_md: string | null;
  skills_parsed: ParsedSkills | null;
  embedding_text: string | null;
  embedding_generated?: boolean;
  errors: GenerationError[];
  warnings: string[];
}

export interface GenerationError {
  phase: 'parse' | 'generate_skills' | 'validate' | 'embed';
  message: string;
  line?: number;
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  skills_parsed: ParsedSkills | null;
  errors: ValidationError[];
  warnings: string[];
}

export interface ValidationError {
  line?: number;
  message: string;
  suggestion?: string;
}

// ============================================
// DRAFT/PUBLISH SYSTEM
// ============================================

export interface AppDraft {
  storage_key: string;
  version: string;
  uploaded_at: string;
  exports: string[];
}

// Extended App interface with draft fields
export interface AppWithDraft extends App {
  draft_storage_key: string | null;
  draft_version: string | null;
  draft_uploaded_at: string | null;
  draft_exports: string[] | null;
  docs_generated_at: string | null;
  generation_in_progress: boolean;
  generation_config: GenerationConfig;
  // pgvector embedding stored as array (for reference, actual storage is vector type)
  skills_embedding?: number[] | null;
}

// ============================================
// MCP (Model Context Protocol)
// ============================================

export interface MCPToolAnnotations {
  /** Tool does not modify its environment (default: false) */
  readOnlyHint?: boolean;
  /** Tool may perform destructive updates (default: true). Only meaningful when readOnlyHint is false. */
  destructiveHint?: boolean;
  /** Calling repeatedly with same args has no additional effect (default: false) */
  idempotentHint?: boolean;
  /** Tool interacts with external entities (default: true) */
  openWorldHint?: boolean;
}

export interface MCPTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: MCPJsonSchema;
  outputSchema?: MCPJsonSchema;
  annotations?: MCPToolAnnotations;
}

export interface MCPJsonSchema {
  type?: string;
  properties?: Record<string, MCPJsonSchema>;
  items?: MCPJsonSchema;
  required?: string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  additionalProperties?: boolean | MCPJsonSchema;
  $ref?: string;
  oneOf?: MCPJsonSchema[];
  allOf?: MCPJsonSchema[];
  nullable?: boolean;
  format?: string;
  [key: string]: unknown;
}

export interface MCPToolsListResponse {
  tools: MCPTool[];
  nextCursor?: string;
}

export interface MCPToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolCallResponse {
  content: MCPContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface MCPContent {
  type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link';
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: MCPResource;
}

export interface MCPResource {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface MCPServerInfo {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { subscribe?: boolean; listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version: string;
  };
  instructions?: string;
}

export interface MCPResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// ============================================
// DISCOVERY
// ============================================

export interface DiscoverRequest {
  query: string;
  limit?: number;
  threshold?: number;
}

export interface DiscoverResult {
  apps: DiscoveredApp[];
  total: number;
  query: string;
  model?: string;
}

export interface DiscoveredApp {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isPublic: boolean;
  isOwner: boolean;
  similarity: number;
  mcpEndpoint: string;
}

// ============================================
// BYOK (Bring Your Own Key) PROVIDERS
// ============================================

export interface BYOKProviderInfo {
  id: ActiveBYOKProvider;
  name: string;
  description: string;
  protocol: 'openai-compatible';
  baseUrl: string;
  defaultModel: string;
  models: BYOKModel[];
  capabilities: BYOKProviderCapabilities;
  apiKeyPrefix?: string;
  docsUrl: string;
  apiKeyUrl: string; // Where users get their API key
}

export interface BYOKProviderCapabilities {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  jsonMode: boolean;
  multimodal: boolean;
}

export interface BYOKModel {
  id: string;
  name: string;
  contextWindow: number;
  inputPrice?: number; // per 1M tokens in USD, omitted when provider pricing is not pinned here
  outputPrice?: number; // per 1M tokens in USD, omitted when provider pricing is not pinned here
}

const OPENAI_COMPAT_TEXT_CAPABILITIES: BYOKProviderCapabilities = {
  chat: true,
  streaming: true,
  tools: true,
  jsonMode: true,
  multimodal: false,
};

// First-tier BYOK provider registry. Runtime routing still chooses how each entry is used.
export const BYOK_PROVIDERS: Record<ActiveBYOKProvider, BYOKProviderInfo> = {
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Access 100+ models from one API key',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4-flash',
    models: [
      {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        contextWindow: 1048576,
        inputPrice: 0.14,
        outputPrice: 0.28,
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1048576,
        inputPrice: 1.74,
        outputPrice: 3.48,
      },
      {
        id: 'openai/gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128000,
        inputPrice: 5,
        outputPrice: 15,
      },
      {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o Mini',
        contextWindow: 128000,
        inputPrice: 0.15,
        outputPrice: 0.6,
      },
      {
        id: 'google/gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        contextWindow: 1000000,
      },
      {
        id: 'x-ai/grok-4.20-reasoning',
        name: 'Grok 4.20 Reasoning',
        contextWindow: 256000,
      },
    ],
    capabilities: { ...OPENAI_COMPAT_TEXT_CAPABILITIES, multimodal: true },
    apiKeyPrefix: 'sk-or-',
    docsUrl: 'https://openrouter.ai/docs',
    apiKeyUrl: 'https://openrouter.ai/keys',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    description: 'Use GPT and OpenAI-compatible models with your own OpenAI key',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: [
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        contextWindow: 128000,
        inputPrice: 0.15,
        outputPrice: 0.6,
      },
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128000,
        inputPrice: 5,
        outputPrice: 15,
      },
    ],
    capabilities: { ...OPENAI_COMPAT_TEXT_CAPABILITIES, multimodal: true },
    apiKeyPrefix: 'sk-',
    docsUrl: 'https://platform.openai.com/docs',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'Use DeepSeek models directly with your own DeepSeek key',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    models: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        contextWindow: 1048576,
        inputPrice: 0.14,
        outputPrice: 0.28,
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1048576,
        inputPrice: 1.74,
        outputPrice: 3.48,
      },
    ],
    capabilities: OPENAI_COMPAT_TEXT_CAPABILITIES,
    apiKeyPrefix: 'sk-',
    docsUrl: 'https://api-docs.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    description: 'Use NVIDIA hosted NIM models with your own NVIDIA API key',
    protocol: 'openai-compatible',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'deepseek-ai/deepseek-v4-flash',
    models: [
      {
        id: 'deepseek-ai/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        contextWindow: 1048576,
        inputPrice: 0.14,
        outputPrice: 0.28,
      },
      {
        id: 'deepseek-ai/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 1048576,
        inputPrice: 1.74,
        outputPrice: 3.48,
      },
      {
        id: 'minimaxai/minimax-m2.7',
        name: 'MiniMax M2.7',
        contextWindow: 204800,
      },
    ],
    capabilities: OPENAI_COMPAT_TEXT_CAPABILITIES,
    docsUrl: 'https://docs.api.nvidia.com/nim/reference/llm-apis',
    apiKeyUrl: 'https://build.nvidia.com/models',
  },
  google: {
    id: 'google',
    name: 'Google Gemini',
    description: 'Use Gemini through Google AI Studio with your own key',
    protocol: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3-flash-preview',
    models: [
      {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        contextWindow: 1000000,
      },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000 },
    ],
    capabilities: { ...OPENAI_COMPAT_TEXT_CAPABILITIES, multimodal: true },
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  xai: {
    id: 'xai',
    name: 'xAI Grok',
    description: 'Use Grok models with your own xAI key',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.20-reasoning',
    models: [
      {
        id: 'grok-4.20-reasoning',
        name: 'Grok 4.20 Reasoning',
        contextWindow: 256000,
      },
      { id: 'grok-4.20-fast', name: 'Grok 4.20 Fast', contextWindow: 256000 },
    ],
    capabilities: { ...OPENAI_COMPAT_TEXT_CAPABILITIES, multimodal: true },
    apiKeyPrefix: 'xai-',
    docsUrl: 'https://docs.x.ai',
    apiKeyUrl: 'https://console.x.ai',
  },
};

// ============================================
// APP MANIFEST (v2 Architecture)
// ============================================

/**
 * App manifest schema for explicit app configuration.
 * Replaces auto-detection with explicit declarations.
 *
 * Example manifest.json:
 * {
 *   "name": "Todo App",
 *   "version": "1.0.0",
 *   "description": "A simple todo list manager",
 *   "type": "mcp",
 *   "entry": {
 *     "functions": "functions.ts"
 *   },
 *   "functions": {
 *     "addTodo": {
 *       "description": "Add a new todo item",
 *       "parameters": {
 *         "text": { "type": "string", "description": "The todo text" },
 *         "priority": { "type": "string", "enum": ["low", "medium", "high"], "default": "medium" }
 *       },
 *       "returns": { "type": "object", "description": "The created todo" }
 *     }
 *   }
 * }
 */
export interface AppManifest {
  // Required
  name: string;
  version: string;

  // Optional metadata
  description?: string;
  author?: string;
  icon?: string;

  // App type - MCP only
  type: 'mcp';

  // Entry points
  entry: {
    // File containing MCP-callable functions
    functions?: string;
  };

  // Function declarations for MCP tools
  // Key is function name, value is function metadata
  functions?: Record<string, ManifestFunction>;

  // Permissions this app requires
  permissions?: string[];

  // Widget and command-card declarations
  widgets?: WidgetDeclaration[];

  // Environment variables this app expects
  env?: Record<string, ManifestEnvVar>;
  env_vars?: Record<string, ManifestEnvVar>;
}

export interface ManifestFunction {
  description: string;
  parameters?: Record<string, ManifestParameter>;
  returns?: ManifestReturn;
  examples?: string[];
  /** MCP tool annotations — behavioral hints for agents (readOnlyHint, destructiveHint, etc.) */
  annotations?: MCPToolAnnotations;
}

export interface ManifestParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  items?: ManifestParameter; // For array types
  properties?: Record<string, ManifestParameter>; // For object types
}

export interface ManifestReturn {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'void';
  description?: string;
}

export interface ManifestEnvVar {
  description?: string;
  required?: boolean;
  default?: string;
  scope?: EnvSchemaEntry['scope'];
  type?: EnvSchemaEntry['scope']; // Legacy alias for scope
  label?: string;
  input?: EnvSchemaEntry['input'];
  placeholder?: string;
  help?: string;
}

export function humanizeEnvVarKey(key: string): string {
  return key
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeEnvScope(value: unknown): EnvSchemaEntry['scope'] {
  return value === 'per_user' ? 'per_user' : 'universal';
}

function inferEnvInputType(
  key: string,
  description?: string,
): NonNullable<EnvSchemaEntry['input']> {
  const upperKey = key.toUpperCase();
  const combined = `${upperKey} ${description || ''}`.toUpperCase();

  if (
    /(PASS|PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|SERVICE_KEY|ACCESS_KEY)/
      .test(combined)
  ) {
    return 'password';
  }

  if (/(EMAIL|E-MAIL|MAILBOX|ADDRESS)/.test(combined)) {
    return 'email';
  }

  if (/(PORT|TIMEOUT|LIMIT|COUNT|INTERVAL)/.test(combined)) {
    return 'number';
  }

  if (/(URL|URI|WEBHOOK|ENDPOINT)/.test(combined) && !/HOST/.test(upperKey)) {
    return 'url';
  }

  return 'text';
}

function normalizeEnvInput(
  value: unknown,
  key: string,
  description?: string,
): NonNullable<EnvSchemaEntry['input']> {
  if (
    value === 'text' ||
    value === 'password' ||
    value === 'email' ||
    value === 'number' ||
    value === 'url' ||
    value === 'textarea'
  ) {
    return value;
  }

  return inferEnvInputType(key, description);
}

function normalizeManifestEnvVarEntry(
  key: string,
  entry: unknown,
): ManifestEnvVar | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const raw = entry as Record<string, unknown>;
  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const label = typeof raw.label === 'string' && raw.label.trim()
    ? raw.label.trim()
    : humanizeEnvVarKey(key);

  return {
    description,
    required: typeof raw.required === 'boolean' ? raw.required : undefined,
    default: typeof raw.default === 'string' ? raw.default : undefined,
    scope: normalizeEnvScope(raw.scope ?? raw.type),
    label,
    input: normalizeEnvInput(raw.input, key, description),
    placeholder: typeof raw.placeholder === 'string' ? raw.placeholder : undefined,
    help: typeof raw.help === 'string' ? raw.help : undefined,
  };
}

export function normalizeManifestEnvVars(
  envVars: unknown,
): Record<string, ManifestEnvVar> | undefined {
  if (envVars === undefined || envVars === null) return undefined;
  if (typeof envVars !== 'object' || Array.isArray(envVars)) return undefined;

  const normalized: Record<string, ManifestEnvVar> = {};
  for (
    const [key, value] of Object.entries(envVars as Record<string, unknown>)
  ) {
    const entry = normalizeManifestEnvVarEntry(key, value);
    if (entry) {
      normalized[key] = entry;
    }
  }

  return normalized;
}

export function getManifestEnvVars(
  manifest: { env?: unknown; env_vars?: unknown } | null | undefined,
): Record<string, ManifestEnvVar> | undefined {
  if (!manifest) return undefined;

  const legacy = normalizeManifestEnvVars(manifest.env) || {};
  const current = normalizeManifestEnvVars(manifest.env_vars) || {};
  const merged = { ...legacy, ...current };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function manifestEnvVarsToEnvSchema(
  envVars: Record<string, ManifestEnvVar> | undefined,
): Record<string, EnvSchemaEntry> {
  if (!envVars) return {};

  const schema: Record<string, EnvSchemaEntry> = {};
  for (const [key, value] of Object.entries(envVars)) {
    schema[key] = {
      scope: normalizeEnvScope(value.scope ?? value.type),
      description: value.description,
      required: value.required,
      label: value.label || humanizeEnvVarKey(key),
      input: normalizeEnvInput(value.input, key, value.description),
      placeholder: value.placeholder,
      help: value.help,
    };
  }
  return schema;
}

export function resolveManifestEnvSchema(
  manifest: { env?: unknown; env_vars?: unknown } | null | undefined,
): Record<string, EnvSchemaEntry> {
  return manifestEnvVarsToEnvSchema(getManifestEnvVars(manifest));
}

export function normalizeEnvSchema(
  input: unknown,
): Record<string, EnvSchemaEntry> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

  const normalized: Record<string, EnvSchemaEntry> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const description = typeof entry.description === 'string' ? entry.description : undefined;
    normalized[key] = {
      scope: normalizeEnvScope(entry.scope),
      description,
      required: typeof entry.required === 'boolean' ? entry.required : undefined,
      label: typeof entry.label === 'string' && entry.label.trim()
        ? entry.label.trim()
        : humanizeEnvVarKey(key),
      input: normalizeEnvInput(entry.input, key, description),
      placeholder: typeof entry.placeholder === 'string' ? entry.placeholder : undefined,
      help: typeof entry.help === 'string' ? entry.help : undefined,
    };
  }

  return normalized;
}

// Validation result for manifest
export interface ManifestValidationResult {
  valid: boolean;
  manifest?: AppManifest;
  errors: ManifestValidationError[];
  warnings: string[];
}

export interface ManifestValidationError {
  path: string;
  message: string;
}

/**
 * Normalize manifest parameters from array format to object-keyed format.
 *
 * Manifests can arrive with parameters in two shapes:
 *   Array:  [{ name: "action", type: "string", required: true, description: "..." }, ...]
 *   Object: { action: { type: "string", required: true, description: "..." }, ... }
 *
 * The canonical format is object-keyed (matches JSON Schema `properties`).
 * This function converts arrays → objects and passes objects through unchanged.
 */
export function normalizeManifestParameters(
  params: unknown,
): Record<string, ManifestParameter> | undefined {
  if (params === undefined || params === null) return undefined;

  // Already object-keyed — pass through
  if (typeof params === 'object' && !Array.isArray(params)) {
    return params as Record<string, ManifestParameter>;
  }

  // Array format — convert [{name, type, ...}] → {name: {type, ...}}
  if (Array.isArray(params)) {
    const result: Record<string, ManifestParameter> = {};
    for (const item of params) {
      if (item && typeof item === 'object' && typeof item.name === 'string') {
        const { name, ...rest } = item;
        result[name] = rest as ManifestParameter;
      }
    }
    return result;
  }

  return undefined;
}

const COMMAND_CARD_SIZE_RE = /^[1-4]x[1-4]$/;

function validateWidgetDependencies(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'dependencies must be an array' });
    return;
  }

  value.forEach((dependency, index) => {
    const depPath = `${path}.${index}`;
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
      errors.push({ path: depPath, message: 'dependency must be an object' });
      return;
    }

    const dep = dependency as Record<string, unknown>;
    if (typeof dep.app !== 'string' || !dep.app.trim()) {
      errors.push({
        path: `${depPath}.app`,
        message: 'app is required and must be a string',
      });
    }
    if (
      !Array.isArray(dep.functions) ||
      dep.functions.length === 0 ||
      dep.functions.some((fn) => typeof fn !== 'string' || !fn.trim())
    ) {
      errors.push({
        path: `${depPath}.functions`,
        message: 'functions must be a non-empty array of strings',
      });
    }
    if (dep.access !== undefined && dep.access !== 'read') {
      errors.push({
        path: `${depPath}.access`,
        message: 'command card dependencies only support read access',
      });
    }
  });
}

function validateManifestWidgets(
  value: unknown,
  functions: Record<string, unknown>,
  errors: ManifestValidationError[],
  warnings: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path: 'widgets', message: 'widgets must be an array' });
    return;
  }

  const seenWidgetIds = new Set<string>();
  value.forEach((widget, index) => {
    const widgetPath = `widgets.${index}`;
    if (!widget || typeof widget !== 'object' || Array.isArray(widget)) {
      errors.push({
        path: widgetPath,
        message: 'widget declaration must be an object',
      });
      return;
    }

    const w = widget as Record<string, unknown>;
    const widgetId = typeof w.id === 'string' ? w.id.trim() : '';
    if (!widgetId) {
      errors.push({
        path: `${widgetPath}.id`,
        message: 'id is required and must be a string',
      });
    } else if (seenWidgetIds.has(widgetId)) {
      errors.push({
        path: `${widgetPath}.id`,
        message: `duplicate widget id "${widgetId}"`,
      });
    } else {
      seenWidgetIds.add(widgetId);
    }

    if (typeof w.label !== 'string' || !w.label.trim()) {
      errors.push({
        path: `${widgetPath}.label`,
        message: 'label is required and must be a string',
      });
    }

    for (const key of ['description', 'ui_function', 'data_function', 'data_tool']) {
      if (w[key] !== undefined && typeof w[key] !== 'string') {
        errors.push({ path: `${widgetPath}.${key}`, message: `${key} must be a string` });
      }
    }

    if (
      w.poll_interval_s !== undefined &&
      (typeof w.poll_interval_s !== 'number' ||
        !Number.isFinite(w.poll_interval_s) ||
        w.poll_interval_s < 0)
    ) {
      errors.push({
        path: `${widgetPath}.poll_interval_s`,
        message: 'poll_interval_s must be a non-negative number',
      });
    }

    validateWidgetDependencies(w.dependencies, `${widgetPath}.dependencies`, errors);

    const uiFunction = typeof w.ui_function === 'string' && w.ui_function.trim()
      ? w.ui_function.trim()
      : widgetId
      ? `widget_${widgetId}_ui`
      : null;
    const dataFunction = typeof w.data_function === 'string' && w.data_function.trim()
      ? w.data_function.trim()
      : typeof w.data_tool === 'string' && w.data_tool.trim()
      ? w.data_tool.trim()
      : widgetId
      ? `widget_${widgetId}_data`
      : null;

    if (uiFunction && Object.keys(functions).length > 0 && !functions[uiFunction]) {
      warnings.push(`Widget "${widgetId}" references missing UI function "${uiFunction}".`);
    }
    if (dataFunction && Object.keys(functions).length > 0 && !functions[dataFunction]) {
      warnings.push(`Widget "${widgetId}" references missing data function "${dataFunction}".`);
    }

    if (w.cards === undefined) return;
    if (!Array.isArray(w.cards)) {
      errors.push({ path: `${widgetPath}.cards`, message: 'cards must be an array' });
      return;
    }

    const seenCardIds = new Set<string>();
    w.cards.forEach((card, cardIndex) => {
      const cardPath = `${widgetPath}.cards.${cardIndex}`;
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        errors.push({ path: cardPath, message: 'card declaration must be an object' });
        return;
      }

      const c = card as Record<string, unknown>;
      const cardId = typeof c.id === 'string' ? c.id.trim() : '';
      if (!cardId) {
        errors.push({
          path: `${cardPath}.id`,
          message: 'id is required and must be a string',
        });
      } else if (seenCardIds.has(cardId)) {
        errors.push({
          path: `${cardPath}.id`,
          message: `duplicate card id "${cardId}"`,
        });
      } else {
        seenCardIds.add(cardId);
      }

      if (typeof c.label !== 'string' || !c.label.trim()) {
        errors.push({
          path: `${cardPath}.label`,
          message: 'label is required and must be a string',
        });
      }
      if (typeof c.size !== 'string' || !COMMAND_CARD_SIZE_RE.test(c.size)) {
        errors.push({
          path: `${cardPath}.size`,
          message: 'size must use the form "2x1" with 1-4 columns and rows',
        });
      }
      if (c.render !== undefined && c.render !== 'native') {
        errors.push({
          path: `${cardPath}.render`,
          message: 'only native command cards are supported',
        });
      }
      if (c.kind !== undefined && typeof c.kind !== 'string') {
        errors.push({ path: `${cardPath}.kind`, message: 'kind must be a string' });
      }
      for (const key of ['description', 'data_view', 'data_function']) {
        if (c[key] !== undefined && typeof c[key] !== 'string') {
          errors.push({ path: `${cardPath}.${key}`, message: `${key} must be a string` });
        }
      }
      if (
        c.refresh_interval_s !== undefined &&
        (typeof c.refresh_interval_s !== 'number' ||
          !Number.isFinite(c.refresh_interval_s) ||
          c.refresh_interval_s < 0)
      ) {
        errors.push({
          path: `${cardPath}.refresh_interval_s`,
          message: 'refresh_interval_s must be a non-negative number',
        });
      }
      validateWidgetDependencies(c.dependencies, `${cardPath}.dependencies`, errors);

      const cardDataFunction = typeof c.data_function === 'string' && c.data_function.trim()
        ? c.data_function.trim()
        : dataFunction;
      if (cardDataFunction && Object.keys(functions).length > 0 && !functions[cardDataFunction]) {
        warnings.push(
          `Widget card "${widgetId}.${cardId}" references missing data function "${cardDataFunction}".`,
        );
      }
    });
  });
}

/**
 * Validate an app manifest
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];
  const warnings: string[] = [];

  if (!input || typeof input !== 'object') {
    return {
      valid: false,
      errors: [{ path: '', message: 'Manifest must be an object' }],
      warnings,
    };
  }

  const manifest = input as Record<string, unknown>;

  // Required fields
  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push({
      path: 'name',
      message: 'name is required and must be a string',
    });
  }

  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push({
      path: 'version',
      message: 'version is required and must be a string',
    });
  }

  // Type validation - MCP only
  if (!manifest.type || manifest.type !== 'mcp') {
    errors.push({ path: 'type', message: 'type must be "mcp"' });
  }

  // Entry validation
  if (!manifest.entry || typeof manifest.entry !== 'object') {
    errors.push({
      path: 'entry',
      message: 'entry is required and must be an object',
    });
  } else {
    const entry = manifest.entry as Record<string, unknown>;
    if (!entry.functions) {
      errors.push({
        path: 'entry.functions',
        message: 'entry.functions is required for MCP apps',
      });
    }
  }

  // Functions validation (optional but must be valid if present)
  if (manifest.functions !== undefined) {
    if (typeof manifest.functions !== 'object' || manifest.functions === null) {
      errors.push({
        path: 'functions',
        message: 'functions must be an object',
      });
    } else {
      const functions = manifest.functions as Record<string, unknown>;
      for (const [fnName, fnDef] of Object.entries(functions)) {
        if (!fnDef || typeof fnDef !== 'object') {
          errors.push({
            path: `functions.${fnName}`,
            message: 'function definition must be an object',
          });
          continue;
        }

        const fn = fnDef as Record<string, unknown>;
        if (!fn.description || typeof fn.description !== 'string') {
          errors.push({
            path: `functions.${fnName}.description`,
            message: 'description is required',
          });
        }

        // Normalize parameters: convert array format → object-keyed format in-place
        if (fn.parameters !== undefined) {
          if (typeof fn.parameters !== 'object') {
            errors.push({
              path: `functions.${fnName}.parameters`,
              message: 'parameters must be an object or array',
            });
          } else {
            fn.parameters = normalizeManifestParameters(fn.parameters);
          }
        }
      }
    }
  }

  // Environment variable / settings validation
  if (
    manifest.env !== undefined &&
    (typeof manifest.env !== 'object' || manifest.env === null ||
      Array.isArray(manifest.env))
  ) {
    errors.push({ path: 'env', message: 'env must be an object' });
  }

  if (
    (manifest as Record<string, unknown>).env_vars !== undefined &&
    (typeof (manifest as Record<string, unknown>).env_vars !== 'object' ||
      (manifest as Record<string, unknown>).env_vars === null ||
      Array.isArray((manifest as Record<string, unknown>).env_vars))
  ) {
    errors.push({ path: 'env_vars', message: 'env_vars must be an object' });
  }

  const functionsForWidgetValidation =
    manifest.functions && typeof manifest.functions === 'object' &&
      !Array.isArray(manifest.functions)
      ? manifest.functions as Record<string, unknown>
      : {};
  validateManifestWidgets(
    manifest.widgets,
    functionsForWidgetValidation,
    errors,
    warnings,
  );

  const rawEnvVars = {
    ...((manifest.env && typeof manifest.env === 'object' &&
        !Array.isArray(manifest.env))
      ? manifest.env as Record<string, unknown>
      : {}),
    ...((((manifest as Record<string, unknown>).env_vars) &&
        typeof (manifest as Record<string, unknown>).env_vars === 'object' &&
        !Array.isArray((manifest as Record<string, unknown>).env_vars))
      ? (manifest as Record<string, unknown>).env_vars as Record<
        string,
        unknown
      >
      : {}),
  };

  for (const [key, value] of Object.entries(rawEnvVars)) {
    const keyValidation = validateEnvVarKey(key);
    if (!keyValidation.valid) {
      errors.push({
        path: `env_vars.${key}`,
        message: keyValidation.error || 'Invalid env var key',
      });
      continue;
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push({
        path: `env_vars.${key}`,
        message: 'env var entry must be an object',
      });
      continue;
    }

    const envVar = value as Record<string, unknown>;

    if (
      envVar.scope !== undefined &&
      envVar.scope !== 'universal' &&
      envVar.scope !== 'per_user'
    ) {
      errors.push({
        path: `env_vars.${key}.scope`,
        message: 'scope must be "universal" or "per_user"',
      });
    }

    if (
      envVar.type !== undefined &&
      envVar.type !== 'universal' &&
      envVar.type !== 'per_user'
    ) {
      errors.push({
        path: `env_vars.${key}.type`,
        message: 'type must be "universal" or "per_user"',
      });
    }

    if (
      envVar.input !== undefined &&
      envVar.input !== 'text' &&
      envVar.input !== 'password' &&
      envVar.input !== 'email' &&
      envVar.input !== 'number' &&
      envVar.input !== 'url' &&
      envVar.input !== 'textarea'
    ) {
      errors.push({
        path: `env_vars.${key}.input`,
        message: 'input must be one of: text, password, email, number, url, textarea',
      });
    }

    if (
      envVar.description !== undefined && typeof envVar.description !== 'string'
    ) {
      errors.push({
        path: `env_vars.${key}.description`,
        message: 'description must be a string',
      });
    }

    if (envVar.required !== undefined && typeof envVar.required !== 'boolean') {
      errors.push({
        path: `env_vars.${key}.required`,
        message: 'required must be a boolean',
      });
    }

    if (envVar.default !== undefined && typeof envVar.default !== 'string') {
      errors.push({
        path: `env_vars.${key}.default`,
        message: 'default must be a string',
      });
    }

    if (envVar.label !== undefined && typeof envVar.label !== 'string') {
      errors.push({
        path: `env_vars.${key}.label`,
        message: 'label must be a string',
      });
    }

    if (
      envVar.placeholder !== undefined && typeof envVar.placeholder !== 'string'
    ) {
      errors.push({
        path: `env_vars.${key}.placeholder`,
        message: 'placeholder must be a string',
      });
    }

    if (envVar.help !== undefined && typeof envVar.help !== 'string') {
      errors.push({
        path: `env_vars.${key}.help`,
        message: 'help must be a string',
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  const normalizedEnvVars = getManifestEnvVars(manifest);
  if (normalizedEnvVars) {
    manifest.env = normalizedEnvVars;
    (manifest as Record<string, unknown>).env_vars = normalizedEnvVars;
  }

  return {
    valid: true,
    manifest: input as AppManifest,
    errors: [],
    warnings,
  };
}

/**
 * Convert manifest functions to MCP tools format
 */
export function manifestToMCPTools(
  manifest: AppManifest,
  _appId: string,
  appSlug: string,
): MCPTool[] {
  if (!manifest.functions) return [];

  const tools: MCPTool[] = [];
  const defaultAnnotations: MCPToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  for (const [fnName, fnDef] of Object.entries(manifest.functions)) {
    const tool: MCPTool = {
      name: `${appSlug}_${fnName}`,
      title: fnName,
      description: fnDef.description,
      annotations: fnDef.annotations
        ? { ...defaultAnnotations, ...fnDef.annotations }
        : defaultAnnotations,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    };

    // Convert parameters to JSON Schema (normalize array→object for legacy DB records)
    if (fnDef.parameters) {
      const normalized = normalizeManifestParameters(fnDef.parameters) || {};
      const properties: Record<string, MCPJsonSchema> = {};
      const required: string[] = [];

      for (const [paramName, paramDef] of Object.entries(normalized)) {
        properties[paramName] = {
          type: paramDef.type,
          description: paramDef.description,
        };

        if (paramDef.enum) {
          properties[paramName].enum = paramDef.enum;
        }

        if (paramDef.default !== undefined) {
          properties[paramName].default = paramDef.default;
        }

        if (paramDef.required !== false) {
          required.push(paramName);
        }
      }

      tool.inputSchema.properties = properties;
      tool.inputSchema.required = required;
    }

    tools.push(tool);
  }

  return tools;
}

// ============================================
// CHAT (Agent Platform)
// ============================================

/** Request body for POST /chat/stream */
export interface ChatStreamRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  temperature?: number; // default 0.7
  max_tokens?: number; // default 4096
  stream?: boolean; // default true
  trace?: ChatTraceContext;
}

export interface ChatTraceContext {
  traceId?: string;
  conversationId?: string;
  messageId?: string;
  source?: string;
}

/** OpenAI-compatible message format */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** OpenAI-compatible tool definition */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** OpenAI-compatible tool call */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Token usage reported in the final SSE chunk */
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ============================================
// D1 (Cloudflare D1 Relational Data Layer)
// ============================================

/** Result from ultralight.db.run() — INSERT/UPDATE/DELETE */
export interface D1RunResult {
  success: boolean;
  meta: D1QueryMeta;
}

/** Result from ultralight.db.exec() — raw DDL (migrations only) */
export interface D1ExecResult {
  success: boolean;
  count: number;
}

/** Metadata returned with every D1 query */
export interface D1QueryMeta {
  changes: number;
  last_row_id: number;
  duration: number;
  rows_read: number;
  rows_written: number;
}

/** D1 free tier thresholds (per user per month) */
export const D1_FREE_TIER = {
  ROWS_READ: 50_000,
  ROWS_WRITTEN: 10_000,
  STORAGE_BYTES: 50 * 1024 * 1024, // 50 MB
} as const;

/** D1 rate limits by tier (per minute) */
export const D1_RATE_LIMITS: Record<
  string,
  { reads: number; writes: number; concurrent: number }
> = {
  free: { reads: 100, writes: 20, concurrent: 3 },
  pro: { reads: 500, writes: 100, concurrent: 10 },
  scale: { reads: 2000, writes: 500, concurrent: 25 },
  enterprise: { reads: 10000, writes: 2000, concurrent: 100 },
};

/** D1 overage billing rates (in Light ✦) */
export const D1_BILLING_RATES = {
  RATE_PER_1K_READS: 0.01, // 0.01 Light per 1,000 reads
  RATE_PER_1K_WRITES: 1, // 1 Light per 1,000 writes
  RATE_PER_MB_PER_HOUR: 0.36, // 0.36 Light per MB per hour (matches R2 data overage)
} as const;

/** Result of a chat billing deduction */
export interface ChatBillingResult {
  cost_light: number;
  balance_after: number;
  was_depleted: boolean;
}

/** Request body for POST /chat/tool-invocation */
export interface ToolInvocationTelemetryRequest {
  invocationId: string;
  traceId?: string;
  conversationId?: string;
  parentLlmInvocationId?: string;
  source: string;
  toolCallId?: string;
  toolName: string;
  toolKind?: string;
  appId?: string;
  mcpId?: string;
  functionName?: string;
  schemaSnapshot?: unknown;
  args?: unknown;
  result?: unknown;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status: 'success' | 'error' | 'aborted' | 'timeout';
  errorType?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

/** Minimum balance in Light required to start a chat stream */
export const CHAT_MIN_BALANCE_LIGHT = 50; // ✦50

/** Platform markup multiplier on OpenRouter costs */
export const CHAT_PLATFORM_MARKUP = 1.0; // Pass through OpenRouter cost in Light-debit mode
