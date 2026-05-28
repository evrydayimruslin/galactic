export { isAgenticInterfaceSpec, validateAgenticInterfaceSpec, } from "../contracts/agentic-interface.ts";
export type * from "../contracts/agentic-interface.ts";
export declare const ACTIVE_BYOK_PROVIDER_IDS: readonly ["openrouter", "openai", "deepseek", "nvidia", "google", "xai"];
export declare const LEGACY_BYOK_PROVIDER_IDS: readonly ["anthropic", "moonshot"];
export type ActiveBYOKProvider = typeof ACTIVE_BYOK_PROVIDER_IDS[number];
export type LegacyBYOKProvider = typeof LEGACY_BYOK_PROVIDER_IDS[number];
export type BYOKProvider = ActiveBYOKProvider | LegacyBYOKProvider;
export declare function isActiveBYOKProvider(value: unknown): value is ActiveBYOKProvider;
export declare function isLegacyBYOKProvider(value: unknown): value is LegacyBYOKProvider;
export interface BYOKConfig {
    provider: BYOKProvider;
    has_key: boolean;
    model?: string;
    added_at: string;
}
export interface User {
    id: string;
    email: string;
    display_name: string | null;
    avatar_url: string | null;
    tier: Tier;
    tier_expires_at: string | null;
    ai_credit_balance: number;
    ai_credit_resets_at: string | null;
    balance_light: number;
    deposit_balance_light: number;
    earned_balance_light: number;
    escrow_light: number;
    escrow_deposit_light: number;
    escrow_earned_light: number;
    total_earned_light: number;
    auto_add_earnings_to_balance: boolean;
    hosting_last_billed_at: string | null;
    stripe_customer_id: string | null;
    auto_topup_enabled: boolean;
    auto_topup_threshold_light: number;
    auto_topup_amount_light: number;
    auto_topup_last_failed_at: string | null;
    byok_enabled: boolean;
    byok_provider: BYOKProvider | null;
    byok_configs: BYOKConfig[];
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
export interface VersionMetadata {
    version: string;
    size_bytes: number;
    created_at: string;
    trust?: VersionTrustMetadata;
}
export interface VersionTrustSignature {
    algorithm: "HMAC-SHA256";
    signer: string;
    signed_at: string;
    signature: string;
    key_hint?: string;
}
export interface VersionTrustMetadata {
    schema_version: 1;
    app_id: string;
    version: string;
    runtime: "deno" | "gpu" | string;
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
export type AppGpuStatus = "building" | "benchmarking" | "live" | "build_failed" | "benchmark_failed" | "build_config_invalid";
export interface App {
    id: string;
    owner_id: string;
    slug: string;
    name: string;
    description: string | null;
    icon_url: string | null;
    /** Whether the requesting user has this app in their library
     *  (`user_app_library` join). Optional + viewer-scoped — only the
     *  /app/:id endpoint that handles auth populates it; bulk discover
     *  responses leave it undefined. Seeded into the B11 install button
     *  state machine on ToolDetailView. */
    is_installed?: boolean;
    visibility: "private" | "unlisted" | "public";
    download_access: "owner" | "public";
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
    likes: number;
    dislikes: number;
    weighted_likes: number;
    weighted_dislikes: number;
    category: string | null;
    tags: string[];
    screenshots: string[];
    long_description: string | null;
    env_vars: Record<string, string>;
    env_schema: Record<string, EnvSchemaEntry>;
    http_rate_limit: number;
    http_enabled: boolean;
    supabase_url: string | null;
    supabase_anon_key_encrypted: string | null;
    supabase_service_key_encrypted: string | null;
    supabase_enabled: boolean;
    supabase_config_id: string | null;
    manifest: string | null;
    app_type: "mcp" | "skill" | null;
    runtime: "deno" | "gpu" | null;
    gpu_type: string | null;
    gpu_status: AppGpuStatus | null;
    gpu_endpoint_id: string | null;
    gpu_config: Record<string, unknown> | null;
    gpu_benchmark: Record<string, unknown> | null;
    gpu_pricing_config: Record<string, unknown> | null;
    gpu_max_duration_ms: number | null;
    gpu_concurrency_limit: number | null;
    gpu_image_ref: string | null;
    gpu_image_digest: string | null;
    gpu_base_profile: string | null;
    gpu_build_provider: string | null;
    gpu_build_run_id: string | null;
    gpu_build_cost_light: number | null;
    gpu_build_started_at: string | null;
    gpu_build_finished_at: string | null;
    gpu_build_error: string | null;
    gpu_image_size_bytes: number | null;
    gpu_image_user_storage_bytes: number | null;
    rate_limit_config: AppRateLimitConfig | null;
    pricing_config: AppPricingConfig | null;
    hosting_suspended: boolean;
    health_status: string;
    last_healed_at: string | null;
    auto_heal_enabled: boolean;
    d1_database_id: string | null;
    d1_status: "pending" | "provisioning" | "ready" | "error" | null;
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
    /** Telemetry-derived metrics (B5). Both fields are optional; the
     *  ToolDetailView function table renders an em-dash when either is
     *  absent so the BE can stage the rollout one function at a time
     *  without breaking the row.
     *
     *  `price_per_call_light` — average per-call cost rolled up from the
     *  recent invocation window (BE picks the window; recommendation is
     *  last 30 days, matching the rest of the marketplace surface).
     *  `latency_p50_ms` — median request latency over the same window.
     *  Authors may also self-declare these in the manifest; the BE
     *  source of truth resolves to either.
     */
    price_per_call_light?: number;
    latency_p50_ms?: number;
}
export interface PermissionDeclaration {
    permission: string;
    required: boolean;
    description?: string;
}
export interface BuildLogEntry {
    time: string;
    level: "info" | "warn" | "error" | "success";
    message: string;
}
export interface EnvVarLimits {
    max_vars_per_app: number;
    max_key_length: number;
    max_value_length: number;
    reserved_prefixes: string[];
}
export interface EnvSchemaEntry {
    scope: "universal" | "per_user";
    description?: string;
    required?: boolean;
    label?: string;
    input?: "text" | "password" | "email" | "number" | "url" | "textarea";
    placeholder?: string;
    help?: string;
}
export declare const ENV_VAR_LIMITS: EnvVarLimits;
/**
 * Validate an environment variable key
 */
export declare function validateEnvVarKey(key: string): {
    valid: boolean;
    error?: string;
};
/**
 * Validate an environment variable value
 */
export declare function validateEnvVarValue(value: string): {
    valid: boolean;
    error?: string;
};
export interface MemoryEntry {
    id: string;
    user_id: string;
    scope: string;
    key: string;
    value: unknown;
    value_type: string;
    created_by_app: string | null;
    updated_by_app: string | null;
    expires_at: string | null;
    created_at: string;
    updated_at: string;
}
export interface Execution {
    id: string;
    app_id: string;
    user_id: string;
    function_name: string;
    arguments: unknown;
    started_at: string;
    ended_at: string | null;
    duration_ms: number | null;
    ai_provider: "platform" | "byok" | null;
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
    level: "log" | "error" | "warn" | "info";
    message: string;
}
export interface SDKContext {
    userId: string;
    appId: string;
    executionId: string;
    permissions: string[];
    aiBudgetRemaining: number | null;
}
export type AIContentPart = AITextPart | AIFilePart;
export interface AITextPart {
    type: "text";
    text: string;
}
export interface AIFilePart {
    type: "file";
    data: string;
    filename?: string;
}
export interface AIRequest {
    model?: string;
    messages: Array<{
        role: "system" | "user" | "assistant";
        content: string | AIContentPart[];
        cache_control?: {
            type: "ephemeral";
        };
    }>;
    temperature?: number;
    max_tokens?: number;
    tools?: Array<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    }>;
}
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
    agentic?: boolean;
    context_function?: string;
    actions_function?: string;
    context_sources?: WidgetContextSourceRef[];
    agent_actions?: WidgetActionDeclaration[];
    generation_hints?: WidgetGenerationHints;
}
export type WidgetContextSourceRef = string;
export type WidgetGenerationComponentKind = "metric" | "list" | "table" | "detail" | "form" | "action_bar" | "timeline" | "card_ref" | "widget_embed" | "routine_panel" | "text";
export interface WidgetGenerationSuggestedComponent {
    kind: WidgetGenerationComponentKind;
    title?: string;
    description?: string;
    data_view?: string;
    context_source_id?: string;
    action_ids?: string[];
}
export interface WidgetGenerationHints {
    tags?: string[];
    preferred_component?: WidgetGenerationComponentKind;
    entity_types?: string[];
    action_group?: string;
    safe_default_filters?: Record<string, unknown>;
    suggested_components?: WidgetGenerationSuggestedComponent[];
    prompt_examples?: string[];
}
export type WidgetContextSourceType = "d1_table" | "d1_query" | "function";
export interface WidgetContextSourceDeclaration {
    id: string;
    label: string;
    description?: string;
    type: WidgetContextSourceType;
    access: "read";
    searchable?: boolean;
    default_for_widgets?: string[];
    tables?: string[];
    query?: string;
    function?: string;
    redactions?: WidgetContextRedaction[];
    generation_hints?: WidgetGenerationHints;
}
export interface WidgetContextRedaction {
    field?: string;
    pattern?: string;
    replacement?: string;
}
export type WidgetActionMode = "read" | "write" | "ui";
export type WidgetConfirmationPolicy = "none" | "user" | "high_risk";
export interface WidgetMcpActionBinding {
    function: string;
    args_template?: Record<string, unknown>;
}
export interface WidgetUiActionBinding {
    command?: string;
    component_id?: string;
    args_template?: Record<string, unknown>;
}
export interface WidgetActionDeclaration {
    id: string;
    label: string;
    description?: string;
    mode: WidgetActionMode;
    args_schema?: Record<string, unknown>;
    confirmation?: WidgetConfirmationPolicy;
    mcp?: WidgetMcpActionBinding;
    ui?: WidgetUiActionBinding;
    expected_result?: string;
    generation_hints?: WidgetGenerationHints;
}
export interface WidgetDataRef {
    type?: string;
    id?: string;
    label?: string;
    table?: string;
    field?: string;
    value?: unknown;
}
export interface WidgetVisibleComponent {
    id: string;
    type?: string;
    label?: string;
    purpose?: string;
    data_refs?: WidgetDataRef[];
    actions?: string[];
    state?: Record<string, unknown>;
}
export interface WidgetPendingEdit {
    field: string;
    label?: string;
    value?: unknown;
    dirty?: boolean;
    entity?: WidgetDataRef;
}
export interface WidgetStateSnapshot {
    surface_id?: string;
    surface_type?: ActiveSurfaceType;
    app_id?: string;
    app_slug?: string;
    widget_id: string;
    interface_id?: string;
    interface_title?: string;
    title?: string;
    summary?: string;
    current_view?: string;
    visible_components?: WidgetVisibleComponent[];
    visible_data_refs?: WidgetDataRef[];
    selected_entities?: WidgetDataRef[];
    pending_edits?: WidgetPendingEdit[];
    enabled_actions?: string[];
    errors?: string[];
    updated_at?: string;
}
export type WidgetSurfaceEventKind = "user" | "agent" | "data" | "navigation" | "error" | "system";
export interface WidgetSurfaceEvent {
    id?: string;
    surface_id?: string;
    widget_id?: string;
    interface_id?: string;
    kind: WidgetSurfaceEventKind;
    action_id?: string;
    turn_id?: string;
    label?: string;
    input?: Record<string, unknown>;
    result?: unknown;
    error?: string;
    snapshot?: WidgetStateSnapshot;
    created_at?: string;
}
export type WidgetSurfaceKind = "inline" | "window" | "command_card" | "generated_interface";
export type ActiveSurfaceType = "widget" | "generated_interface";
export type WidgetSurfaceStatus = "opening" | "ready" | "stale" | "closed";
export interface ActiveWidgetContext {
    surfaceId: string;
    surfaceType?: ActiveSurfaceType;
    kind?: WidgetSurfaceKind;
    appId: string;
    appSlug: string;
    appName: string;
    widgetId: string;
    widgetName?: string;
    interfaceId?: string;
    interfaceTitle?: string;
    interfaceMode?: "temporary" | "saved";
    title?: string;
    context?: Record<string, string>;
    status?: WidgetSurfaceStatus;
    snapshot?: WidgetStateSnapshot | null;
    actions?: WidgetActionDeclaration[];
    recentEvents?: WidgetSurfaceEvent[];
    recentEventSummary?: string;
    recentEventCount?: number;
    latestDataPayload?: Record<string, unknown> | null;
    updatedAt?: number;
}
export interface WidgetActionInvocation {
    surface_id: string;
    widget_id: string;
    action_id: string;
    args?: Record<string, unknown>;
    turn_id?: string;
    source?: "user" | "agent" | "system";
}
export interface WidgetActionResult {
    surface_id?: string;
    widget_id?: string;
    action_id: string;
    turn_id?: string;
    ok: boolean;
    data?: unknown;
    error?: string;
    snapshot?: WidgetStateSnapshot;
    event?: WidgetSurfaceEvent;
}
export type CommandCardRenderMode = "native";
export type CommandCardKind = "metric" | "list" | "timeline" | "sparkline" | "progress" | "summary" | "composite";
export interface WidgetDependencyDeclaration {
    app: string;
    functions: string[];
    access?: "read";
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
    generation_hints?: WidgetGenerationHints;
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
export interface WidgetMeta {
    title: string;
    icon?: string;
    badge_count: number;
}
export interface WidgetAppResponse {
    meta: WidgetMeta;
    app_html: string;
    version?: string;
}
export interface CommandCardDataPayload {
    card_id?: string;
    meta?: Partial<WidgetMeta> & {
        status?: "live" | "paused" | "error" | string;
        accent?: string;
        cost_per_min?: number;
    };
    body: CommandCardBody;
    footer?: string;
    updated_at?: string;
    version?: string;
}
export type CommandCardBody = CommandMetricCardBody | CommandListCardBody | CommandTimelineCardBody | CommandSparklineCardBody | CommandProgressCardBody | CommandSummaryCardBody | CommandCompositeCardBody;
export interface CommandMetricCardBody {
    kind: "metric";
    metric: string | number;
    label?: string;
    delta?: string;
}
export interface CommandListCardBody {
    kind: "list";
    rows: Array<Array<string | number | boolean | null>>;
}
export interface CommandTimelineCardBody {
    kind: "timeline";
    rows: Array<{
        time?: string;
        title: string;
        subtitle?: string;
        accent?: string;
    }>;
}
export interface CommandSparklineCardBody {
    kind: "sparkline";
    metric?: string | number;
    label?: string;
    points: number[];
}
export interface CommandProgressCardBody {
    kind: "progress";
    value: number;
    max?: number;
    label?: string;
}
export interface CommandSummaryCardBody {
    kind: "summary";
    title?: string;
    lines: string[];
}
export interface CommandCompositeCardBody {
    kind: "composite";
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
        status: "ready" | "failed" | "skipped";
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
export interface AppPermission {
    id: string;
    user_id: string;
    app_id: string;
    permission: string;
    granted_at: string;
    expires_at: string | null;
    duration: "perpetual" | "session" | "1h" | "24h" | "7d";
    budget_limit: number | null;
    budget_used: number;
    last_used_at: string | null;
}
/** Constraints applied to a permission grant — checked at MCP call time */
export interface GrantConstraints {
    /** CIDR ranges or exact IPs that may call this app (e.g. ["10.0.0.0/8", "203.0.113.5"]) */
    allowed_ips?: string[] | null;
    /** Time window during which calls are allowed */
    time_window?: TimeWindow | null;
    /** Max calls allowed before access is suspended. Resets according to budget_period. */
    budget_limit?: number | null;
    /** Rolling period for budget reset. null = lifetime budget (never resets). */
    budget_period?: "hour" | "day" | "week" | "month" | null;
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
    free_calls_scope?: "app" | "function";
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
export declare function getCallPriceLight(pricingConfig: AppPricingConfig | null | undefined, functionName: string): number;
/**
 * Get the number of free calls for a specific function.
 * Checks per-function override first, then falls back to app-level default.
 * Returns 0 if no free calls configured.
 */
export declare function getFreeCalls(pricingConfig: AppPricingConfig | null | undefined, functionName: string): number;
/**
 * Get the scope for free call counting.
 * 'app' = single shared counter across all functions.
 * 'function' = separate counter per function (default).
 */
export declare function getFreeCallsScope(pricingConfig: AppPricingConfig | null | undefined): "app" | "function";
/**
 * Get the GPU pricing display mode for an app.
 * Returns null if no GPU pricing is configured.
 */
export declare function getGpuPricingMode(gpuPricingConfig: Record<string, unknown> | null | undefined): "per_call" | "per_unit" | "per_duration" | null;
/**
 * Get a human-readable label for the GPU pricing unit.
 * Returns "call" for per_call, the unit_label for per_unit, "second" for per_duration.
 */
export declare function getGpuPricingUnitLabel(gpuPricingConfig: Record<string, unknown> | null | undefined): string;
export type ContentType = "page" | "memory_md" | "library_md";
export type ContentVisibility = "public" | "private" | "shared";
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
    access_level: "read" | "readwrite";
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
    access_level: "read" | "write" | "readwrite";
    created_at: string;
    expires_at: string | null;
}
export type Tier = "free" | "fun" | "pro" | "scale" | "enterprise";
/** Light symbol character for display. */
export declare const LIGHT_SYMBOL = "\u2726";
/** Canonical Light/$ reference for internal USD-denominated costs and copy. */
export declare const LIGHT_PER_DOLLAR_CANONICAL = 100;
/** Exchange rate: Light credited per $1 USD through Apple Pay / Google Pay. */
export declare const LIGHT_PER_DOLLAR_WALLET = 95;
/** Exchange rate: Light credited per $1 USD through Stripe wire/bank transfer. */
export declare const LIGHT_PER_DOLLAR_WIRE = 99;
/** Legacy alias retained while old web checkout surfaces are migrated. */
export declare const LIGHT_PER_DOLLAR_WEB = 95;
/** Legacy alias retained for internal cost conversion at the canonical rate. */
export declare const LIGHT_PER_DOLLAR_DESKTOP = 100;
/** Exchange rate: $1 USD per this many Light when publishers withdraw. */
export declare const LIGHT_PER_DOLLAR_PAYOUT = 100;
/** Platform fee rate applied on creator revenue. */
export declare const PLATFORM_FEE_RATE = 0.15;
/** Minimum card wallet funding amount in USD cents. */
export declare const CARD_MINIMUM_CENTS = 2500;
/** Minimum wire/bank transfer funding amount in USD cents. */
export declare const WIRE_MINIMUM_CENTS = 2500;
/** Public cloud usage price, denominated per 1,000 cloud units for display. */
export declare const CLOUD_UNIT_LIGHT_PER_1K = 1;
/** Worker execution granularity: one cloud unit per started interval. */
export declare const WORKER_MS_PER_CLOUD_UNIT = 250;
/** D1 read granularity: one cloud unit per started row group. */
export declare const D1_READ_ROWS_PER_CLOUD_UNIT = 100;
/** D1 write granularity: one cloud unit per row written. */
export declare const D1_WRITE_ROWS_PER_CLOUD_UNIT = 1;
/** R2 operation granularity: one cloud unit per operation. */
export declare const R2_OPS_PER_CLOUD_UNIT = 1;
/** KV operation granularity: one cloud unit per operation. */
export declare const KV_OPS_PER_CLOUD_UNIT = 1;
/** Widget pull granularity: one cloud unit per pull. */
export declare const WIDGET_PULLS_PER_CLOUD_UNIT = 1;
/** Storage-at-rest rate in Light per GB-month after the free allowance. */
export declare const STORAGE_LIGHT_PER_GB_MONTH = 100;
/** Legacy publish balance gate amount, used only when explicitly enabled. */
export declare const MIN_PUBLISH_DEPOSIT_LIGHT = 500;
/** Legacy published hosting rate, used only when the old hosting meter is enabled. */
export declare const HOSTING_RATE_LIGHT_PER_MB_PER_HOUR = 2.25;
/** Data storage soft-cap overage rate in Light per MB per hour (user pays).
 *  Charged hourly for combined storage exceeding the 100MB soft cap.
 *  ✦0.045/MB/hr — 50x cheaper than publisher hosting rate. */
export declare const DATA_RATE_LIGHT_PER_MB_PER_HOUR = 0.045;
/** Combined storage soft cap (source code + user data). 100MB. */
export declare const COMBINED_FREE_TIER_BYTES = 104857600;
/** Legacy auto top-up threshold (Light). Auto top-up is currently disabled. */
export declare const AUTO_TOPUP_DEFAULT_THRESHOLD_LIGHT = 100;
/** Legacy auto top-up charge amount (Light). Auto top-up is currently disabled. */
export declare const AUTO_TOPUP_DEFAULT_AMOUNT_LIGHT = 1000;
/** Legacy minimum auto top-up amount (Light). Auto top-up is currently disabled. */
export declare const AUTO_TOPUP_MIN_AMOUNT_LIGHT = 500;
/** Minimum withdrawal amount (Light). */
export declare const MIN_WITHDRAWAL_LIGHT = 5000;
/**
 * Stripe processing fee pass-through (still in USD cents — Stripe boundary only).
 * Standard Stripe rate: 2.9% + 30¢ per successful charge.
 */
export declare const STRIPE_FEE_PERCENT = 0.029;
export declare const STRIPE_FEE_FIXED_CENTS = 30;
/** Calculate the gross USD cents charge that nets the desired deposit after Stripe fees. */
export declare function calcGrossWithStripeFee(desiredCents: number): number;
/**
 * Format a Light amount for display using Instagram-style abbreviations.
 * Amounts >= 5,000 are abbreviated (K, M, B, T).
 * Symbol ✦ is always prepended.
 *
 * Examples: ✦42, ✦2,500, ✦14.5K, ✦2.05M, ✦1.30B
 */
export declare function formatLight(amount: number): string;
export declare const TIER_LIMITS: {
    readonly free: {
        readonly max_apps: number;
        readonly weekly_call_limit: 50000;
        readonly overage_cost_per_100k_light: 0;
        readonly can_publish: true;
        readonly price_light_monthly: 0;
        readonly daily_ai_credit_light: 1600;
        readonly monthly_ai_credit_light: 48000;
        readonly max_file_size_mb: 10;
        readonly max_files_per_app: 50;
        readonly max_storage_bytes: 104857600;
        readonly execution_timeout_ms: 120000;
        readonly log_retention_days: 90;
        readonly allowed_visibility: readonly ["private", "unlisted", "public"];
    };
    readonly fun: {
        readonly max_apps: number;
        readonly weekly_call_limit: 50000;
        readonly overage_cost_per_100k_light: 0;
        readonly can_publish: true;
        readonly price_light_monthly: 0;
        readonly daily_ai_credit_light: 1600;
        readonly monthly_ai_credit_light: 48000;
        readonly max_file_size_mb: 10;
        readonly max_files_per_app: 50;
        readonly max_storage_bytes: 104857600;
        readonly execution_timeout_ms: 120000;
        readonly log_retention_days: 90;
        readonly allowed_visibility: readonly ["private", "unlisted", "public"];
    };
    readonly pro: {
        readonly max_apps: number;
        readonly weekly_call_limit: 50000;
        readonly overage_cost_per_100k_light: 0;
        readonly can_publish: true;
        readonly price_light_monthly: 0;
        readonly daily_ai_credit_light: 1600;
        readonly monthly_ai_credit_light: 48000;
        readonly max_file_size_mb: 10;
        readonly max_files_per_app: 50;
        readonly max_storage_bytes: 104857600;
        readonly execution_timeout_ms: 120000;
        readonly log_retention_days: 90;
        readonly allowed_visibility: readonly ["private", "unlisted", "public"];
    };
    readonly scale: {
        readonly max_apps: number;
        readonly weekly_call_limit: 50000;
        readonly overage_cost_per_100k_light: 0;
        readonly can_publish: true;
        readonly price_light_monthly: 0;
        readonly daily_ai_credit_light: 1600;
        readonly monthly_ai_credit_light: 48000;
        readonly max_file_size_mb: 10;
        readonly max_files_per_app: 50;
        readonly max_storage_bytes: 104857600;
        readonly execution_timeout_ms: 120000;
        readonly log_retention_days: 90;
        readonly allowed_visibility: readonly ["private", "unlisted", "public"];
    };
    readonly enterprise: {
        readonly max_apps: number;
        readonly weekly_call_limit: 50000;
        readonly overage_cost_per_100k_light: 0;
        readonly can_publish: true;
        readonly price_light_monthly: 0;
        readonly daily_ai_credit_light: 1600;
        readonly monthly_ai_credit_light: 48000;
        readonly max_file_size_mb: 10;
        readonly max_files_per_app: 50;
        readonly max_storage_bytes: 104857600;
        readonly execution_timeout_ms: 120000;
        readonly log_retention_days: 90;
        readonly allowed_visibility: readonly ["private", "unlisted", "public"];
    };
};
/** @deprecated No tiers — always returns true for backward compatibility. */
export declare function isProTier(_tier: Tier | string): boolean;
export declare const ALLOWED_EXTENSIONS: readonly [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".css", ".scss", ".less", ".html", ".htm", ".xml", ".svg", ".md", ".mdx", ".txt", ".csv", ".sql", ".yaml", ".yml", ".toml", ".ini", ".conf", ".env", ".env.example", ".env.local", ".sh", ".bash", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".cpp", ".h", ".hpp", ".wasm", ".graphql", ".gql", ".prisma", ".lock", ".gitignore", ".dockerignore", ".dockerfile", ".editorconfig"];
export declare const MAX_UPLOAD_SIZE_BYTES: number;
export declare const MAX_FILES_PER_UPLOAD = 50;
export interface UserContext {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    tier: Tier;
}
export interface QueryOptions {
    filter?: (value: unknown) => boolean;
    sort?: {
        field: string;
        order: "asc" | "desc";
    };
    limit?: number;
    offset?: number;
}
export interface QueryResult {
    key: string;
    value: unknown;
    updatedAt?: string;
}
export interface UltralightSDK {
    user: UserContext | null;
    isAuthenticated(): boolean;
    requireAuth(): UserContext;
    store(key: string, value: unknown): Promise<void>;
    load(key: string): Promise<unknown>;
    remove(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
    query(prefix: string, options?: QueryOptions): Promise<QueryResult[]>;
    batchStore(items: Array<{
        key: string;
        value: unknown;
    }>): Promise<void>;
    batchLoad(keys: string[]): Promise<Array<{
        key: string;
        value: unknown;
    }>>;
    batchRemove(keys: string[]): Promise<void>;
    remember(key: string, value: unknown): Promise<void>;
    recall(key: string): Promise<unknown>;
    ai(request: AIRequest): Promise<AIResponse>;
}
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
    phase: "parse" | "generate_skills" | "validate" | "embed";
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
export interface AppDraft {
    storage_key: string;
    version: string;
    uploaded_at: string;
    exports: string[];
}
export interface AppWithDraft extends App {
    draft_storage_key: string | null;
    draft_version: string | null;
    draft_uploaded_at: string | null;
    draft_exports: string[] | null;
    docs_generated_at: string | null;
    generation_in_progress: boolean;
    generation_config: GenerationConfig;
    skills_embedding?: number[] | null;
}
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
    type: "text" | "image" | "audio" | "resource" | "resource_link";
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
        tools?: {
            listChanged?: boolean;
        };
        resources?: {
            subscribe?: boolean;
            listChanged?: boolean;
        };
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
export interface BYOKProviderInfo {
    id: ActiveBYOKProvider;
    name: string;
    description: string;
    protocol: "openai-compatible";
    baseUrl: string;
    defaultModel: string;
    models: BYOKModel[];
    capabilities: BYOKProviderCapabilities;
    apiKeyPrefix?: string;
    docsUrl: string;
    apiKeyUrl: string;
}
export interface BYOKProviderCapabilities {
    chat: boolean;
    streaming: boolean;
    tools: boolean;
    jsonMode: boolean;
    multimodal: boolean;
    realtime: boolean;
}
export interface BYOKModel {
    id: string;
    name: string;
    contextWindow: number;
    inputPrice?: number;
    outputPrice?: number;
    /** Editorial tier annotation (B1). When set, the composer's
     *  ModelPickerPopover shows this model only on the matching tier;
     *  `'both'` keeps it on both popovers. When the field is absent on
     *  every model in a provider's catalog the FE falls back to its
     *  pre-B1 behaviour (show everything on both tiers), so deployments
     *  can stage the annotation rollout without breaking the picker. */
    tier?: "flash" | "heavy" | "both";
}
export declare const BYOK_PROVIDERS: Record<ActiveBYOKProvider, BYOKProviderInfo>;
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
    name: string;
    version: string;
    description?: string;
    author?: string;
    icon?: string;
    type: "mcp";
    entry: {
        functions?: string;
    };
    functions?: Record<string, ManifestFunction>;
    permissions?: string[];
    widgets?: WidgetDeclaration[];
    context_sources?: WidgetContextSourceDeclaration[];
    env?: Record<string, ManifestEnvVar>;
    env_vars?: Record<string, ManifestEnvVar>;
    http?: ManifestHttpConfig;
}
export type ManifestHttpAuthMode = "user" | "public";
export type ManifestHttpBillingMode = "owner" | "caller";
export type ManifestHttpDataScope = "app" | "user";
export type ManifestHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export interface ManifestHttpConfig {
    defaults?: ManifestHttpRouteDefaults;
    routes?: Record<string, ManifestHttpRoutePolicy>;
}
export interface ManifestHttpRouteDefaults {
    auth?: ManifestHttpAuthMode;
    methods?: ManifestHttpMethod[];
    cors?: ManifestHttpCorsPolicy;
    rate_limit?: ManifestHttpRateLimitPolicy;
    billing?: ManifestHttpBillingMode;
    data_scope?: ManifestHttpDataScope;
}
export interface ManifestHttpRoutePolicy extends ManifestHttpRouteDefaults {
}
export interface ManifestHttpCorsPolicy {
    origins?: string[];
    credentials?: boolean;
    headers?: string[];
    max_age_seconds?: number;
}
export interface ManifestHttpRateLimitPolicy {
    rpm?: number;
    burst?: number;
    daily?: number;
}
export interface ManifestFunction {
    description: string;
    parameters?: Record<string, ManifestParameter>;
    returns?: ManifestReturn;
    examples?: string[];
    /** MCP tool annotations — behavioral hints for agents (readOnlyHint, destructiveHint, etc.) */
    annotations?: MCPToolAnnotations;
    generation_hints?: WidgetGenerationHints;
}
export interface ManifestParameter {
    type: "string" | "number" | "boolean" | "object" | "array";
    description?: string;
    required?: boolean;
    default?: unknown;
    enum?: unknown[];
    items?: ManifestParameter;
    properties?: Record<string, ManifestParameter>;
}
export interface ManifestReturn {
    type: "string" | "number" | "boolean" | "object" | "array" | "void";
    description?: string;
}
export interface ManifestEnvVar {
    description?: string;
    required?: boolean;
    default?: string;
    scope?: EnvSchemaEntry["scope"];
    type?: EnvSchemaEntry["scope"];
    label?: string;
    input?: EnvSchemaEntry["input"];
    placeholder?: string;
    help?: string;
}
export declare function humanizeEnvVarKey(key: string): string;
export declare function normalizeManifestEnvVars(envVars: unknown): Record<string, ManifestEnvVar> | undefined;
export declare function getManifestEnvVars(manifest: {
    env?: unknown;
    env_vars?: unknown;
} | null | undefined): Record<string, ManifestEnvVar> | undefined;
export declare function manifestEnvVarsToEnvSchema(envVars: Record<string, ManifestEnvVar> | undefined): Record<string, EnvSchemaEntry>;
export declare function resolveManifestEnvSchema(manifest: {
    env?: unknown;
    env_vars?: unknown;
} | null | undefined): Record<string, EnvSchemaEntry>;
export declare function normalizeEnvSchema(input: unknown): Record<string, EnvSchemaEntry>;
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
export declare function normalizeManifestParameters(params: unknown): Record<string, ManifestParameter> | undefined;
/**
 * Validate an app manifest
 */
export declare function validateManifest(input: unknown): ManifestValidationResult;
/**
 * Convert manifest functions to MCP tools format
 */
export declare function manifestToMCPTools(manifest: AppManifest, _appId: string, appSlug: string): MCPTool[];
/** Request body for POST /chat/stream */
export interface ChatStreamRequest {
    model: string;
    messages: ChatMessage[];
    tools?: ChatTool[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
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
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
    name?: string;
}
/** OpenAI-compatible tool definition */
export interface ChatTool {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}
/** OpenAI-compatible tool call */
export interface ChatToolCall {
    id: string;
    type: "function";
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
export declare const D1_FREE_TIER: {
    readonly ROWS_READ: 50000;
    readonly ROWS_WRITTEN: 10000;
    readonly STORAGE_BYTES: number;
};
/** D1 rate limits by tier (per minute) */
export declare const D1_RATE_LIMITS: Record<string, {
    reads: number;
    writes: number;
    concurrent: number;
}>;
/** D1 overage billing rates (in Light ✦) */
export declare const D1_BILLING_RATES: {
    readonly RATE_PER_1K_READS: 0.01;
    readonly RATE_PER_1K_WRITES: 1;
    readonly RATE_PER_MB_PER_HOUR: 0.36;
};
/** Result of a chat billing deduction */
export interface ChatBillingResult {
    cost_light: number;
    balance_after: number;
    was_depleted: boolean;
}
export interface WidgetToolInvocationTelemetryContext {
    surfaceId?: string;
    widgetId?: string;
    actionId?: string;
    turnId?: string;
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
    receiptId?: string;
    routineId?: string;
    routineRunId?: string;
    schemaSnapshot?: unknown;
    args?: unknown;
    result?: unknown;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    status: "success" | "error" | "aborted" | "timeout";
    errorType?: string;
    errorMessage?: string;
    widgetAction?: WidgetToolInvocationTelemetryContext;
    metadata?: Record<string, unknown>;
}
/** Minimum balance in Light required to start a chat stream */
export declare const CHAT_MIN_BALANCE_LIGHT = 50;
/** Platform markup multiplier on OpenRouter costs */
export declare const CHAT_PLATFORM_MARKUP = 1;
