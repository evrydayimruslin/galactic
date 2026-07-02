export interface EnvVarLimits {
    max_vars_per_app: number;
    max_key_length: number;
    max_value_length: number;
    reserved_prefixes: string[];
}
export interface EnvSchemaEntry {
    scope: 'universal' | 'per_user';
    description?: string;
    required?: boolean;
    label?: string;
    input?: 'text' | 'password' | 'email' | 'number' | 'url' | 'textarea';
    placeholder?: string;
    help?: string;
    group?: string;
    credential?: EnvCredential;
}
export type EnvCredentialInjection = {
    as: 'bearer';
} | {
    as: 'header';
    name: string;
    prefix?: string;
} | {
    as: 'basic';
    username_env?: string;
} | {
    as: 'query';
    name: string;
};
export interface EnvCredential {
    destination: string;
    inject: EnvCredentialInjection;
}
export interface ResolvedCredential {
    value: string;
    credential?: EnvCredential;
}
export declare const ENV_VAR_LIMITS: EnvVarLimits;
export declare function validateEnvVarKey(key: string): {
    valid: boolean;
    error?: string;
};
export declare function validateEnvVarValue(value: string): {
    valid: boolean;
    error?: string;
};
