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
  // When set, this secret is a CREDENTIAL the platform uses on the Agent's
  // behalf against a declared destination — the plaintext is never injected
  // into the sandbox (the Phase 3 vault). See EnvCredential.
  credential?: EnvCredential;
}

// How the platform attaches a vaulted credential to an outbound request. The
// secret value is applied in the parent isolate and never returned to app code.
export type EnvCredentialInjection =
  | { as: 'bearer' }
  | { as: 'header'; name: string; prefix?: string }
  | { as: 'basic'; username_env?: string }
  | { as: 'query'; name: string };

export interface EnvCredential {
  // Host the credential may be sent to. MUST match a
  // network.allowed_destinations host declared in the app manifest.
  destination: string;
  inject: EnvCredentialInjection;
}

// A per-user secret resolved for HOST-SIDE use: the decrypted value (kept in the
// parent isolate — never injected into the sandbox) plus its optional credential
// binding. Keyed by env var name in the runtime credentials map (Phase 3 vault).
export interface ResolvedCredential {
  value: string;
  credential?: EnvCredential;
}

export const ENV_VAR_LIMITS: EnvVarLimits = {
  max_vars_per_app: 50,
  max_key_length: 64,
  max_value_length: 4096,
  reserved_prefixes: ['ULTRALIGHT'],
};

export function validateEnvVarKey(key: string): { valid: boolean; error?: string } {
  if (!key || typeof key !== 'string') {
    return { valid: false, error: 'Key is required' };
  }

  if (key.length > ENV_VAR_LIMITS.max_key_length) {
    return { valid: false, error: `Key must be ${ENV_VAR_LIMITS.max_key_length} characters or less` };
  }

  for (const prefix of ENV_VAR_LIMITS.reserved_prefixes) {
    if (key.toUpperCase().startsWith(prefix)) {
      return { valid: false, error: `Keys starting with "${prefix}" are reserved` };
    }
  }

  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    return { valid: false, error: 'Key must be uppercase letters, numbers, and underscores, starting with a letter' };
  }

  return { valid: true };
}

export function validateEnvVarValue(value: string): { valid: boolean; error?: string } {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Value must be a string' };
  }

  if (value.length > ENV_VAR_LIMITS.max_value_length) {
    return { valid: false, error: `Value must be ${ENV_VAR_LIMITS.max_value_length} characters or less` };
  }

  return { valid: true };
}
