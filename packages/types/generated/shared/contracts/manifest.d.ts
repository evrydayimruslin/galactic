import type { EnvCredential, EnvSchemaEntry } from './env.ts';
import type { MCPTool, MCPToolAnnotations } from './mcp.ts';
import type { RoutineDeclaration } from './routine.ts';
import type { WidgetContextSourceDeclaration, WidgetDeclaration, WidgetGenerationHints } from './widget.ts';
export interface AppManifest {
    name: string;
    version: string;
    description?: string;
    author?: string;
    icon?: string;
    type: 'mcp';
    entry: {
        functions?: string;
    };
    functions?: Record<string, ManifestFunction>;
    skills?: Record<string, ManifestSkill>;
    access_policy?: ManifestAccessPolicy;
    permissions?: string[];
    external_functions?: ManifestExternalDependency[];
    imports?: Record<string, ManifestSlotImport>;
    emits?: string[];
    interfaces?: ManifestInterfaceDeclaration[];
    widgets?: WidgetDeclaration[];
    context_sources?: WidgetContextSourceDeclaration[];
    routines?: RoutineDeclaration[];
    env?: Record<string, ManifestEnvVar>;
    env_vars?: Record<string, ManifestEnvVar>;
    http?: ManifestHttpConfig;
    network?: ManifestNetworkConfig;
}
export interface ManifestNetworkConfig {
    allowed_destinations?: ManifestNetworkDestination[];
}
export interface ManifestNetworkDestination {
    host: string;
    label?: string;
    description?: string;
}
export interface ManifestExternalDependency {
    app: string;
    functions: string[];
    access?: 'read';
}
export interface ManifestSlotImport {
    description?: string;
    signature?: string;
    functions?: string[];
}
export interface ManifestInterfaceDeclaration {
    id: string;
    label: string;
    description?: string;
    entry: string;
    functions: string[];
    min_height?: number;
    hash?: string;
}
export type ManifestHttpAuthMode = 'user' | 'public';
export type ManifestHttpBillingMode = 'owner' | 'caller';
export type ManifestHttpDataScope = 'app' | 'user';
export type ManifestHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
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
    annotations?: MCPToolAnnotations;
    generation_hints?: WidgetGenerationHints;
    uses_inference?: boolean;
    execution?: ManifestFunctionExecution;
}
export interface ManifestFunctionExecution {
    class?: 'sync' | 'async';
    timeout_ms?: number;
}
export interface ManifestSkill {
    name?: string;
    description: string;
    semantic_description?: string;
    preview?: string;
    resource?: string;
    format?: 'markdown' | 'text';
}
export type ManifestAccessPolicyMode = 'static' | 'module';
export interface ManifestAccessPolicy {
    /**
     * `static` uses dashboard/static pricing config only.
     * `module` runs the declared policy export from the bundled app entry surface.
     */
    mode?: ManifestAccessPolicyMode;
    module?: string;
    export?: string;
}
export type ToolAccessPolicySubjectKind = 'function' | 'skill';
export interface ToolAccessPolicyPlanPayload {
    version: 1;
    app: {
        id: string;
        slug: string | null;
        ownerId: string;
        owner_id: string;
    };
    caller: {
        userId: string;
        authState?: 'authenticated' | 'anonymous';
        callerAppId?: string | null;
    };
    subject: {
        kind: ToolAccessPolicySubjectKind;
        id: string;
    };
    input: Record<string, unknown>;
    metadata: Record<string, unknown>;
    static: {
        effect: 'allow';
        subjectKind: ToolAccessPolicySubjectKind;
        subject_kind: ToolAccessPolicySubjectKind;
        subjectId: string;
        subject_id: string;
        priceLight: number;
        price_light: number;
        chargeLight: number;
        charge_light: number;
        free: boolean;
        freeQuotaLimit: number;
        free_quota_limit: number;
        freeQuotaCounterKey: string | null;
        free_quota_counter_key: string | null;
        selfAccess: boolean;
        self_access: boolean;
    };
}
export interface ToolAccessPolicyAllowDecision {
    effect?: 'allow';
    price_light?: number;
    priceLight?: number;
    charge_light?: number;
    chargeLight?: number;
    free?: boolean;
    free_quota_limit?: number;
    freeQuotaLimit?: number;
    free_quota_counter_key?: string | null;
    freeQuotaCounterKey?: string | null;
    metadata?: Record<string, unknown>;
}
export interface ToolAccessPolicyDenyDecision {
    effect: 'deny';
    reason?: string;
    message?: string;
    metadata?: Record<string, unknown>;
}
export type ToolAccessPolicyDecision = ToolAccessPolicyAllowDecision | ToolAccessPolicyDenyDecision;
export type ToolAccessPolicyFunction = (payload: ToolAccessPolicyPlanPayload) => ToolAccessPolicyDecision | Promise<ToolAccessPolicyDecision>;
export interface ManifestParameter {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    description?: string;
    required?: boolean;
    default?: unknown;
    enum?: unknown[];
    items?: ManifestParameter;
    properties?: Record<string, ManifestParameter>;
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
    type?: EnvSchemaEntry['scope'];
    label?: string;
    input?: EnvSchemaEntry['input'];
    placeholder?: string;
    help?: string;
    credential?: EnvCredential;
}
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
export declare function normalizeManifestParameters(params: unknown): Record<string, ManifestParameter> | undefined;
export declare function validateManifest(input: unknown): ManifestValidationResult;
export declare function manifestToMCPTools(manifest: AppManifest, _appId: string, appSlug: string): MCPTool[];
