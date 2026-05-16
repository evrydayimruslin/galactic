import type { EnvSchemaEntry } from './env.ts';
import type { MCPTool, MCPToolAnnotations } from './mcp.ts';
import type { WidgetDeclaration } from './widget.ts';
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
    permissions?: string[];
    widgets?: WidgetDeclaration[];
    env?: Record<string, ManifestEnvVar>;
    env_vars?: Record<string, ManifestEnvVar>;
    http?: ManifestHttpConfig;
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
}
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
