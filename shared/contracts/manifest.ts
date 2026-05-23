import type { EnvSchemaEntry } from './env.ts';
import { validateEnvVarKey } from './env.ts';
import type { MCPJsonSchema, MCPTool, MCPToolAnnotations } from './mcp.ts';
import type {
  RoutineBudgetDefaults,
  RoutineCapabilityDeclaration,
  RoutineDeclaration,
} from './routine.ts';
import type { WidgetContextSourceDeclaration, WidgetDeclaration } from './widget.ts';

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
  context_sources?: WidgetContextSourceDeclaration[];
  routines?: RoutineDeclaration[];
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

export interface ManifestHttpRoutePolicy extends ManifestHttpRouteDefaults {}

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

  if (/(PASS|PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|SERVICE_KEY|ACCESS_KEY)/.test(combined)) {
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
  for (const [key, value] of Object.entries(envVars as Record<string, unknown>)) {
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

export function normalizeEnvSchema(input: unknown): Record<string, EnvSchemaEntry> {
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

export function normalizeManifestParameters(
  params: unknown,
): Record<string, ManifestParameter> | undefined {
  if (params === undefined || params === null) return undefined;

  if (typeof params === 'object' && !Array.isArray(params)) {
    return params as Record<string, ManifestParameter>;
  }

  if (Array.isArray(params)) {
    const result: Record<string, ManifestParameter> = {};
    for (const item of params) {
      if (
        item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
      ) {
        const { name, ...rest } = item as { name: string } & Record<string, unknown>;
        const candidate = rest as Record<string, unknown>;
        if (
          candidate.type === 'string' ||
          candidate.type === 'number' ||
          candidate.type === 'boolean' ||
          candidate.type === 'object' ||
          candidate.type === 'array'
        ) {
          result[name] = candidate as unknown as ManifestParameter;
        }
      }
    }
    return result;
  }

  return undefined;
}

const COMMAND_CARD_SIZE_RE = /^[1-4]x[1-4]$/;
const MANIFEST_HTTP_METHODS: ManifestHttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
];
const MANIFEST_HTTP_RATE_LIMIT_MAX_RPM = 10_000;
const MANIFEST_HTTP_RATE_LIMIT_MAX_BURST = 10_000;
const MANIFEST_HTTP_RATE_LIMIT_MAX_DAILY = 10_000_000;
const HTTP_HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_|~-]+$/;

function validateHttpAuthMode(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): ManifestHttpAuthMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'user' || value === 'public') return value;
  errors.push({ path, message: 'auth must be one of: user, public' });
  return undefined;
}

function validateHttpBillingMode(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): ManifestHttpBillingMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'owner' || value === 'caller') return value;
  errors.push({ path, message: 'billing must be one of: owner, caller' });
  return undefined;
}

function validateHttpDataScope(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): ManifestHttpDataScope | undefined {
  if (value === undefined) return undefined;
  if (value === 'app' || value === 'user') return value;
  errors.push({ path, message: 'data_scope must be one of: app, user' });
  return undefined;
}

function validateHttpMethods(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): ManifestHttpMethod[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, message: 'methods must be a non-empty array' });
    return undefined;
  }

  const normalized: ManifestHttpMethod[] = [];
  const seen = new Set<string>();
  for (const [index, method] of value.entries()) {
    if (typeof method !== 'string') {
      errors.push({ path: `${path}.${index}`, message: 'method must be a string' });
      continue;
    }
    const upper = method.trim().toUpperCase();
    if (!MANIFEST_HTTP_METHODS.includes(upper as ManifestHttpMethod)) {
      errors.push({
        path: `${path}.${index}`,
        message: `method must be one of: ${MANIFEST_HTTP_METHODS.join(', ')}`,
      });
      continue;
    }
    if (seen.has(upper)) {
      errors.push({ path: `${path}.${index}`, message: `duplicate method "${upper}"` });
      continue;
    }
    seen.add(upper);
    normalized.push(upper as ManifestHttpMethod);
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeHttpCorsOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  if (trimmed === 'tauri://localhost') return trimmed;

  try {
    const url = new URL(trimmed);
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function validateHttpCors(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): ManifestHttpCorsPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path, message: 'cors must be an object' });
    return undefined;
  }

  const cors = value as Record<string, unknown>;
  const normalized: ManifestHttpCorsPolicy = {};
  if (cors.origins !== undefined) {
    if (!Array.isArray(cors.origins) || cors.origins.length === 0) {
      errors.push({ path: `${path}.origins`, message: 'origins must be a non-empty array' });
    } else {
      const origins: string[] = [];
      const seen = new Set<string>();
      for (const [index, originValue] of cors.origins.entries()) {
        if (typeof originValue !== 'string') {
          errors.push({ path: `${path}.origins.${index}`, message: 'origin must be a string' });
          continue;
        }
        const origin = normalizeHttpCorsOrigin(originValue);
        if (!origin) {
          errors.push({
            path: `${path}.origins.${index}`,
            message: 'origin must be "*", "tauri://localhost", or a URL origin',
          });
          continue;
        }
        if (seen.has(origin)) {
          errors.push({
            path: `${path}.origins.${index}`,
            message: `duplicate origin "${origin}"`,
          });
          continue;
        }
        seen.add(origin);
        origins.push(origin);
      }
      if (origins.length > 0) normalized.origins = origins;
    }
  }

  if (cors.credentials !== undefined) {
    if (typeof cors.credentials !== 'boolean') {
      errors.push({ path: `${path}.credentials`, message: 'credentials must be a boolean' });
    } else {
      normalized.credentials = cors.credentials;
    }
  }

  if (cors.headers !== undefined) {
    if (!Array.isArray(cors.headers)) {
      errors.push({ path: `${path}.headers`, message: 'headers must be an array' });
    } else {
      const headers: string[] = [];
      const seen = new Set<string>();
      for (const [index, headerValue] of cors.headers.entries()) {
        if (typeof headerValue !== 'string' || !HTTP_HEADER_NAME_RE.test(headerValue.trim())) {
          errors.push({
            path: `${path}.headers.${index}`,
            message: 'header must be a valid HTTP header name',
          });
          continue;
        }
        const header = headerValue.trim();
        const lower = header.toLowerCase();
        if (seen.has(lower)) {
          errors.push({
            path: `${path}.headers.${index}`,
            message: `duplicate header "${header}"`,
          });
          continue;
        }
        seen.add(lower);
        headers.push(header);
      }
      if (headers.length > 0) normalized.headers = headers;
    }
  }

  if (cors.max_age_seconds !== undefined) {
    if (
      typeof cors.max_age_seconds !== 'number' ||
      !Number.isInteger(cors.max_age_seconds) ||
      cors.max_age_seconds < 0 ||
      cors.max_age_seconds > 86_400
    ) {
      errors.push({
        path: `${path}.max_age_seconds`,
        message: 'max_age_seconds must be an integer between 0 and 86400',
      });
    } else {
      normalized.max_age_seconds = cors.max_age_seconds;
    }
  }

  if (normalized.credentials === true && normalized.origins?.includes('*')) {
    errors.push({
      path: `${path}.credentials`,
      message: 'credentials cannot be true when origins includes "*"',
    });
  }

  return normalized;
}

function validateHttpPositiveInteger(
  value: unknown,
  path: string,
  label: string,
  max: number,
  errors: ManifestValidationError[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    errors.push({ path, message: `${label} must be an integer between 1 and ${max}` });
    return undefined;
  }
  return value;
}

function validateHttpRateLimit(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): ManifestHttpRateLimitPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path, message: 'rate_limit must be an object' });
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const rateLimit: ManifestHttpRateLimitPolicy = {};
  const rpm = validateHttpPositiveInteger(
    raw.rpm,
    `${path}.rpm`,
    'rpm',
    MANIFEST_HTTP_RATE_LIMIT_MAX_RPM,
    errors,
  );
  const burst = validateHttpPositiveInteger(
    raw.burst,
    `${path}.burst`,
    'burst',
    MANIFEST_HTTP_RATE_LIMIT_MAX_BURST,
    errors,
  );
  const daily = validateHttpPositiveInteger(
    raw.daily,
    `${path}.daily`,
    'daily',
    MANIFEST_HTTP_RATE_LIMIT_MAX_DAILY,
    errors,
  );
  if (rpm !== undefined) rateLimit.rpm = rpm;
  if (burst !== undefined) rateLimit.burst = burst;
  if (daily !== undefined) rateLimit.daily = daily;
  return rateLimit;
}

function validateHttpRouteDefaults(
  value: Record<string, unknown>,
  path: string,
  errors: ManifestValidationError[],
): ManifestHttpRouteDefaults {
  const defaults: ManifestHttpRouteDefaults = {};
  const auth = validateHttpAuthMode(value.auth, `${path}.auth`, errors);
  const billing = validateHttpBillingMode(value.billing, `${path}.billing`, errors);
  const dataScope = validateHttpDataScope(value.data_scope, `${path}.data_scope`, errors);
  const methods = validateHttpMethods(value.methods, `${path}.methods`, errors);
  const cors = validateHttpCors(value.cors, `${path}.cors`, errors);
  const rateLimit = validateHttpRateLimit(value.rate_limit, `${path}.rate_limit`, errors);

  if (auth !== undefined) defaults.auth = auth;
  if (billing !== undefined) defaults.billing = billing;
  if (dataScope !== undefined) defaults.data_scope = dataScope;
  if (methods !== undefined) {
    defaults.methods = methods;
    value.methods = methods;
  }
  if (cors !== undefined) {
    defaults.cors = cors;
    value.cors = cors;
  }
  if (rateLimit !== undefined) defaults.rate_limit = rateLimit;
  return defaults;
}

function mergeHttpCors(
  defaults?: ManifestHttpCorsPolicy,
  route?: ManifestHttpCorsPolicy,
): ManifestHttpCorsPolicy | undefined {
  if (!defaults && !route) return undefined;
  return { ...(defaults || {}), ...(route || {}) };
}

function validateManifestHttp(
  value: unknown,
  functions: Record<string, unknown>,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path: 'http', message: 'http must be an object' });
    return;
  }

  const http = value as Record<string, unknown>;
  let defaults: ManifestHttpRouteDefaults = {};
  if (http.defaults !== undefined) {
    if (!http.defaults || typeof http.defaults !== 'object' || Array.isArray(http.defaults)) {
      errors.push({ path: 'http.defaults', message: 'defaults must be an object' });
    } else {
      defaults = validateHttpRouteDefaults(
        http.defaults as Record<string, unknown>,
        'http.defaults',
        errors,
      );
    }
  }

  if (http.routes === undefined) return;
  if (!http.routes || typeof http.routes !== 'object' || Array.isArray(http.routes)) {
    errors.push({ path: 'http.routes', message: 'routes must be an object' });
    return;
  }

  for (const [routeName, routeValue] of Object.entries(http.routes as Record<string, unknown>)) {
    const routePath = `http.routes.${routeName}`;
    if (!routeName || routeName.trim() !== routeName || /[/?#\s]/.test(routeName)) {
      errors.push({
        path: routePath,
        message: 'route name must be a single function path segment',
      });
    }
    if (Object.keys(functions).length > 0 && !functions[routeName]) {
      errors.push({
        path: routePath,
        message: `route references missing function "${routeName}"`,
      });
    }
    if (!routeValue || typeof routeValue !== 'object' || Array.isArray(routeValue)) {
      errors.push({ path: routePath, message: 'route policy must be an object' });
      continue;
    }

    const routeRecord = routeValue as Record<string, unknown>;
    const route = validateHttpRouteDefaults(routeRecord, routePath, errors);
    const auth = route.auth ?? defaults.auth ?? 'user';
    const methods = route.methods ?? defaults.methods;
    const billing = route.billing ?? defaults.billing ?? (auth === 'public' ? 'owner' : 'caller');
    const dataScope = route.data_scope ?? defaults.data_scope ?? 'app';
    const cors = mergeHttpCors(defaults.cors, route.cors);

    if (auth === 'public') {
      if (!methods || methods.length === 0) {
        errors.push({
          path: `${routePath}.methods`,
          message: 'public HTTP routes must declare at least one method',
        });
      }
      if (billing !== 'owner') {
        errors.push({
          path: `${routePath}.billing`,
          message: 'public HTTP routes must use owner billing',
        });
      }
      if (dataScope !== 'app') {
        errors.push({
          path: `${routePath}.data_scope`,
          message: 'public HTTP routes must use app data scope',
        });
      }
    }

    if (cors?.credentials === true && cors.origins?.includes('*')) {
      errors.push({
        path: `${routePath}.cors.credentials`,
        message: 'credentials cannot be true when resolved origins includes "*"',
      });
    }
  }
}

const ROUTINE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ROUTINE_HANDLER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

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
      errors.push({ path: `${depPath}.app`, message: 'app is required and must be a string' });
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

function validateOptionalStringArray(
  value: unknown,
  path: string,
  message: string,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    errors.push({ path, message });
  }
}

function isSafeContextSqlIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isSelectOnlyContextQuery(sql: string): boolean {
  const normalized = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .trim();
  if (!normalized) return false;
  if (normalized.includes(';')) return false;
  if (!/^(select|with)\b/i.test(normalized)) return false;
  return !/\b(insert|update|delete|drop|alter|create|replace|truncate|attach|detach|vacuum|pragma|reindex|merge|grant|revoke)\b/i
    .test(normalized);
}

function validateManifestContextSources(
  value: unknown,
  functions: Record<string, unknown>,
  errors: ManifestValidationError[],
  warnings: string[],
): Set<string> {
  const ids = new Set<string>();
  if (value === undefined) return ids;
  if (!Array.isArray(value)) {
    errors.push({ path: 'context_sources', message: 'context_sources must be an array' });
    return ids;
  }

  const seen = new Set<string>();
  value.forEach((source, index) => {
    const sourcePath = `context_sources.${index}`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      errors.push({ path: sourcePath, message: 'context source declaration must be an object' });
      return;
    }

    const s = source as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!id) {
      errors.push({ path: `${sourcePath}.id`, message: 'id is required and must be a string' });
    } else if (seen.has(id)) {
      errors.push({ path: `${sourcePath}.id`, message: `duplicate context source id "${id}"` });
    } else {
      seen.add(id);
      ids.add(id);
    }

    if (typeof s.label !== 'string' || !s.label.trim()) {
      errors.push({ path: `${sourcePath}.label`, message: 'label is required and must be a string' });
    }
    if (s.description !== undefined && typeof s.description !== 'string') {
      errors.push({ path: `${sourcePath}.description`, message: 'description must be a string' });
    }
    if (s.type !== 'd1_table' && s.type !== 'd1_query' && s.type !== 'function') {
      errors.push({
        path: `${sourcePath}.type`,
        message: 'type must be one of d1_table, d1_query, or function',
      });
    }
    if (s.access !== 'read') {
      errors.push({ path: `${sourcePath}.access`, message: 'access is required and must be read' });
    }
    if (s.searchable !== undefined && typeof s.searchable !== 'boolean') {
      errors.push({ path: `${sourcePath}.searchable`, message: 'searchable must be a boolean' });
    }

    validateOptionalStringArray(
      s.default_for_widgets,
      `${sourcePath}.default_for_widgets`,
      'default_for_widgets must be an array of non-empty strings',
      errors,
    );
    validateOptionalStringArray(
      s.tables,
      `${sourcePath}.tables`,
      'tables must be an array of non-empty strings',
      errors,
    );
    if (Array.isArray(s.tables)) {
      for (const [tableIndex, tableName] of s.tables.entries()) {
        if (typeof tableName === 'string' && tableName.trim() && !isSafeContextSqlIdentifier(tableName.trim())) {
          errors.push({
            path: `${sourcePath}.tables.${tableIndex}`,
            message: 'table names must be simple SQL identifiers',
          });
        }
      }
    }

    if (s.query !== undefined && typeof s.query !== 'string') {
      errors.push({ path: `${sourcePath}.query`, message: 'query must be a string' });
    }
    if (s.function !== undefined && typeof s.function !== 'string') {
      errors.push({ path: `${sourcePath}.function`, message: 'function must be a string' });
    }

    if (s.type === 'd1_table' && (!Array.isArray(s.tables) || s.tables.length === 0)) {
      errors.push({ path: `${sourcePath}.tables`, message: 'd1_table context sources must declare tables' });
    }
    if (s.type === 'd1_query' && (typeof s.query !== 'string' || !s.query.trim())) {
      errors.push({ path: `${sourcePath}.query`, message: 'd1_query context sources must declare query' });
    } else if (s.type === 'd1_query' && typeof s.query === 'string') {
      if (!isSelectOnlyContextQuery(s.query)) {
        errors.push({ path: `${sourcePath}.query`, message: 'd1_query context source query must be SELECT-only' });
      }
      if (s.query.includes('?')) {
        errors.push({
          path: `${sourcePath}.query`,
          message: 'd1_query context source query must use named placeholders',
        });
      }
      if (!/[:@$]user_id\b/i.test(s.query)) {
        errors.push({
          path: `${sourcePath}.query`,
          message: 'd1_query context source query must include :user_id',
        });
      }
    }
    if (s.type === 'function') {
      const functionName = typeof s.function === 'string' ? s.function.trim() : '';
      if (!functionName) {
        errors.push({ path: `${sourcePath}.function`, message: 'function context sources must declare function' });
      } else if (Object.keys(functions).length > 0 && !functions[functionName]) {
        warnings.push(`Context source "${id || index}" references missing function "${functionName}".`);
      }
    }

    if (s.redactions !== undefined) {
      if (!Array.isArray(s.redactions)) {
        errors.push({ path: `${sourcePath}.redactions`, message: 'redactions must be an array' });
      } else {
        s.redactions.forEach((redaction, redactionIndex) => {
          const redactionPath = `${sourcePath}.redactions.${redactionIndex}`;
          if (!redaction || typeof redaction !== 'object' || Array.isArray(redaction)) {
            errors.push({ path: redactionPath, message: 'redaction must be an object' });
            return;
          }
          const r = redaction as Record<string, unknown>;
          for (const key of ['field', 'pattern', 'replacement']) {
            if (r[key] !== undefined && typeof r[key] !== 'string') {
              errors.push({ path: `${redactionPath}.${key}`, message: `${key} must be a string` });
            }
          }
        });
      }
    }
  });

  return ids;
}

function validateWidgetAgentActions(
  value: unknown,
  path: string,
  functions: Record<string, unknown>,
  errors: ManifestValidationError[],
  warnings: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'agent_actions must be an array' });
    return;
  }

  const seen = new Set<string>();
  value.forEach((action, index) => {
    const actionPath = `${path}.${index}`;
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      errors.push({ path: actionPath, message: 'agent action must be an object' });
      return;
    }

    const a = action as Record<string, unknown>;
    const id = typeof a.id === 'string' ? a.id.trim() : '';
    if (!id) {
      errors.push({ path: `${actionPath}.id`, message: 'id is required and must be a string' });
    } else if (seen.has(id)) {
      errors.push({ path: `${actionPath}.id`, message: `duplicate agent action id "${id}"` });
    } else {
      seen.add(id);
    }

    if (typeof a.label !== 'string' || !a.label.trim()) {
      errors.push({ path: `${actionPath}.label`, message: 'label is required and must be a string' });
    }
    if (a.description !== undefined && typeof a.description !== 'string') {
      errors.push({ path: `${actionPath}.description`, message: 'description must be a string' });
    }
    if (a.mode !== 'read' && a.mode !== 'write' && a.mode !== 'ui') {
      errors.push({ path: `${actionPath}.mode`, message: 'mode must be one of read, write, or ui' });
    }
    if (
      a.confirmation !== undefined &&
      a.confirmation !== 'none' &&
      a.confirmation !== 'user' &&
      a.confirmation !== 'high_risk'
    ) {
      errors.push({
        path: `${actionPath}.confirmation`,
        message: 'confirmation must be one of none, user, or high_risk',
      });
    }
    if (a.mode === 'write' && a.confirmation === undefined) {
      warnings.push(`Agent action "${id || index}" is write-mode but has no confirmation policy.`);
    }
    if (
      a.args_schema !== undefined &&
      (!a.args_schema || typeof a.args_schema !== 'object' || Array.isArray(a.args_schema))
    ) {
      errors.push({ path: `${actionPath}.args_schema`, message: 'args_schema must be an object' });
    }
    if (a.expected_result !== undefined && typeof a.expected_result !== 'string') {
      errors.push({ path: `${actionPath}.expected_result`, message: 'expected_result must be a string' });
    }

    if (a.mcp !== undefined) {
      if (!a.mcp || typeof a.mcp !== 'object' || Array.isArray(a.mcp)) {
        errors.push({ path: `${actionPath}.mcp`, message: 'mcp must be an object' });
      } else {
        const mcp = a.mcp as Record<string, unknown>;
        const functionName = typeof mcp.function === 'string' ? mcp.function.trim() : '';
        if (!functionName) {
          errors.push({ path: `${actionPath}.mcp.function`, message: 'function is required and must be a string' });
        } else if (Object.keys(functions).length > 0 && !functions[functionName]) {
          warnings.push(`Agent action "${id || index}" references missing MCP function "${functionName}".`);
        }
        if (
          mcp.args_template !== undefined &&
          (!mcp.args_template || typeof mcp.args_template !== 'object' ||
            Array.isArray(mcp.args_template))
        ) {
          errors.push({ path: `${actionPath}.mcp.args_template`, message: 'args_template must be an object' });
        }
      }
    }

    if (a.ui !== undefined) {
      if (!a.ui || typeof a.ui !== 'object' || Array.isArray(a.ui)) {
        errors.push({ path: `${actionPath}.ui`, message: 'ui must be an object' });
      } else {
        const ui = a.ui as Record<string, unknown>;
        if (ui.command !== undefined && typeof ui.command !== 'string') {
          errors.push({ path: `${actionPath}.ui.command`, message: 'command must be a string' });
        }
        if (ui.component_id !== undefined && typeof ui.component_id !== 'string') {
          errors.push({ path: `${actionPath}.ui.component_id`, message: 'component_id must be a string' });
        }
        if (
          ui.args_template !== undefined &&
          (!ui.args_template || typeof ui.args_template !== 'object' ||
            Array.isArray(ui.args_template))
        ) {
          errors.push({ path: `${actionPath}.ui.args_template`, message: 'args_template must be an object' });
        }
      }
    }
  });
}

function validateManifestWidgets(
  value: unknown,
  functions: Record<string, unknown>,
  contextSourceIds: Set<string>,
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
      errors.push({ path: widgetPath, message: 'widget declaration must be an object' });
      return;
    }

    const w = widget as Record<string, unknown>;
    const widgetId = typeof w.id === 'string' ? w.id.trim() : '';
    if (!widgetId) {
      errors.push({ path: `${widgetPath}.id`, message: 'id is required and must be a string' });
    } else if (seenWidgetIds.has(widgetId)) {
      errors.push({ path: `${widgetPath}.id`, message: `duplicate widget id "${widgetId}"` });
    } else {
      seenWidgetIds.add(widgetId);
    }

    if (typeof w.label !== 'string' || !w.label.trim()) {
      errors.push({
        path: `${widgetPath}.label`,
        message: 'label is required and must be a string',
      });
    }

    for (
      const key of [
        'description',
        'ui_function',
        'data_function',
        'data_tool',
        'context_function',
        'actions_function',
      ]
    ) {
      if (w[key] !== undefined && typeof w[key] !== 'string') {
        errors.push({ path: `${widgetPath}.${key}`, message: `${key} must be a string` });
      }
    }

    if (w.agentic !== undefined && typeof w.agentic !== 'boolean') {
      errors.push({ path: `${widgetPath}.agentic`, message: 'agentic must be a boolean' });
    }

    if (
      w.poll_interval_s !== undefined &&
      (typeof w.poll_interval_s !== 'number' || !Number.isFinite(w.poll_interval_s) ||
        w.poll_interval_s < 0)
    ) {
      errors.push({
        path: `${widgetPath}.poll_interval_s`,
        message: 'poll_interval_s must be a non-negative number',
      });
    }

    validateWidgetDependencies(w.dependencies, `${widgetPath}.dependencies`, errors);
    validateOptionalStringArray(
      w.context_sources,
      `${widgetPath}.context_sources`,
      'context_sources must be an array of non-empty strings',
      errors,
    );

    if (Array.isArray(w.context_sources)) {
      for (const sourceId of w.context_sources) {
        if (typeof sourceId === 'string' && sourceId.trim() && !contextSourceIds.has(sourceId.trim())) {
          warnings.push(`Widget "${widgetId || index}" references unknown context source "${sourceId.trim()}".`);
        }
      }
    }
    validateWidgetAgentActions(
      w.agent_actions,
      `${widgetPath}.agent_actions`,
      functions,
      errors,
      warnings,
    );

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

    const contextFunction = typeof w.context_function === 'string' && w.context_function.trim()
      ? w.context_function.trim()
      : null;
    const actionsFunction = typeof w.actions_function === 'string' && w.actions_function.trim()
      ? w.actions_function.trim()
      : null;
    if (contextFunction && Object.keys(functions).length > 0 && !functions[contextFunction]) {
      warnings.push(`Widget "${widgetId}" references missing context function "${contextFunction}".`);
    }
    if (actionsFunction && Object.keys(functions).length > 0 && !functions[actionsFunction]) {
      warnings.push(`Widget "${widgetId}" references missing actions function "${actionsFunction}".`);
    }
    if (
      w.agentic === true &&
      !contextFunction &&
      !actionsFunction &&
      (!Array.isArray(w.context_sources) || w.context_sources.length === 0) &&
      (!Array.isArray(w.agent_actions) || w.agent_actions.length === 0)
    ) {
      warnings.push(
        `Widget "${widgetId}" declares agentic mode but has no context or action source.`,
      );
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
        errors.push({ path: `${cardPath}.id`, message: 'id is required and must be a string' });
      } else if (seenCardIds.has(cardId)) {
        errors.push({ path: `${cardPath}.id`, message: `duplicate card id "${cardId}"` });
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

function validateRoutineSchedule(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (typeof value === 'string') {
    if (!value.trim()) {
      errors.push({ path, message: 'default_schedule must not be empty' });
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      path,
      message: 'default_schedule must be a cron string or schedule object',
    });
    return;
  }

  const schedule = value as Record<string, unknown>;
  if (
    schedule.type !== undefined &&
    schedule.type !== 'interval' &&
    schedule.type !== 'cron'
  ) {
    errors.push({
      path: `${path}.type`,
      message: 'type must be "interval" or "cron"',
    });
  }

  if (schedule.cron !== undefined && typeof schedule.cron !== 'string') {
    errors.push({ path: `${path}.cron`, message: 'cron must be a string' });
  } else if (typeof schedule.cron === 'string' && !schedule.cron.trim()) {
    errors.push({ path: `${path}.cron`, message: 'cron must not be empty' });
  }

  for (const key of ['every_seconds', 'every_minutes']) {
    const intervalValue = schedule[key];
    if (intervalValue === undefined) continue;
    if (
      typeof intervalValue !== 'number' ||
      !Number.isFinite(intervalValue) ||
      intervalValue <= 0
    ) {
      errors.push({
        path: `${path}.${key}`,
        message: `${key} must be a positive number`,
      });
    }
  }

  const hasInterval = schedule.every_seconds !== undefined || schedule.every_minutes !== undefined;
  const hasCron = typeof schedule.cron === 'string' && !!schedule.cron.trim();
  if (!hasInterval && !hasCron) {
    errors.push({
      path,
      message: 'schedule object must define cron, every_seconds, or every_minutes',
    });
  }

  if (schedule.timezone !== undefined && typeof schedule.timezone !== 'string') {
    errors.push({ path: `${path}.timezone`, message: 'timezone must be a string' });
  }
}

function validateRoutineCapabilities(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'capabilities must be an array' });
    return;
  }

  value.forEach((capability, index) => {
    const capPath = `${path}.${index}`;
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
      errors.push({ path: capPath, message: 'capability must be an object' });
      return;
    }

    const cap = capability as RoutineCapabilityDeclaration & Record<string, unknown>;
    if (typeof cap.app !== 'string' || !cap.app.trim()) {
      errors.push({ path: `${capPath}.app`, message: 'app is required and must be a string' });
    }
    if (
      !Array.isArray(cap.functions) ||
      cap.functions.length === 0 ||
      cap.functions.some((fn) => typeof fn !== 'string' || !fn.trim())
    ) {
      errors.push({
        path: `${capPath}.functions`,
        message: 'functions must be a non-empty array of strings',
      });
    }
    if (cap.access !== undefined && cap.access !== 'read' && cap.access !== 'write') {
      errors.push({
        path: `${capPath}.access`,
        message: 'access must be "read" or "write"',
      });
    }
    if (cap.required !== undefined && typeof cap.required !== 'boolean') {
      errors.push({ path: `${capPath}.required`, message: 'required must be a boolean' });
    }
    if (cap.purpose !== undefined && typeof cap.purpose !== 'string') {
      errors.push({ path: `${capPath}.purpose`, message: 'purpose must be a string' });
    }
  });
}

function validateRoutineBudgetDefaults(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path, message: 'budget_defaults must be an object' });
    return;
  }

  const budget = value as RoutineBudgetDefaults & Record<string, unknown>;
  for (
    const key of [
      'max_light_per_run',
      'max_light_per_day',
      'max_light_per_month',
      'max_calls_per_run',
    ]
  ) {
    const budgetValue = budget[key];
    if (budgetValue === undefined) continue;
    if (
      typeof budgetValue !== 'number' ||
      !Number.isFinite(budgetValue) ||
      budgetValue < 0
    ) {
      errors.push({
        path: `${path}.${key}`,
        message: `${key} must be a non-negative number`,
      });
    }
  }
}

function validateRoutineApprovalPolicy(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path, message: 'approval_policy must be an object' });
    return;
  }

  const policy = value as Record<string, unknown>;
  for (
    const key of [
      'require_user_approval',
      'require_paid_capability_approval',
      'require_external_side_effect_approval',
    ]
  ) {
    if (policy[key] !== undefined && typeof policy[key] !== 'boolean') {
      errors.push({ path: `${path}.${key}`, message: `${key} must be a boolean` });
    }
  }
}

function validateRoutineSurfaces(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path, message: 'surfaces must be an object' });
    return;
  }

  const surfaces = value as Record<string, unknown>;
  if (surfaces.widgets !== undefined) {
    if (
      !Array.isArray(surfaces.widgets) ||
      surfaces.widgets.some((widget) => typeof widget !== 'string' || !widget.trim())
    ) {
      errors.push({
        path: `${path}.widgets`,
        message: 'widgets must be an array of strings',
      });
    }
  }
  if (surfaces.command_cards !== undefined) {
    if (!Array.isArray(surfaces.command_cards)) {
      errors.push({ path: `${path}.command_cards`, message: 'command_cards must be an array' });
    } else {
      surfaces.command_cards.forEach((card, index) => {
        const cardPath = `${path}.command_cards.${index}`;
        if (!card || typeof card !== 'object' || Array.isArray(card)) {
          errors.push({ path: cardPath, message: 'command card binding must be an object' });
          return;
        }
        const binding = card as Record<string, unknown>;
        if (typeof binding.widget_id !== 'string' || !binding.widget_id.trim()) {
          errors.push({
            path: `${cardPath}.widget_id`,
            message: 'widget_id is required and must be a string',
          });
        }
        if (typeof binding.card_id !== 'string' || !binding.card_id.trim()) {
          errors.push({
            path: `${cardPath}.card_id`,
            message: 'card_id is required and must be a string',
          });
        }
      });
    }
  }
  if (surfaces.dashboard_key !== undefined && typeof surfaces.dashboard_key !== 'string') {
    errors.push({ path: `${path}.dashboard_key`, message: 'dashboard_key must be a string' });
  }
}

function validateManifestRoutines(
  value: unknown,
  functions: Record<string, unknown>,
  errors: ManifestValidationError[],
  warnings: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path: 'routines', message: 'routines must be an array' });
    return;
  }

  const seenRoutineIds = new Set<string>();
  value.forEach((routine, index) => {
    const routinePath = `routines.${index}`;
    if (!routine || typeof routine !== 'object' || Array.isArray(routine)) {
      errors.push({ path: routinePath, message: 'routine declaration must be an object' });
      return;
    }

    const r = routine as Record<string, unknown>;
    const routineId = typeof r.id === 'string' ? r.id.trim() : '';
    if (!routineId) {
      errors.push({ path: `${routinePath}.id`, message: 'id is required and must be a string' });
    } else if (!ROUTINE_ID_RE.test(routineId)) {
      errors.push({
        path: `${routinePath}.id`,
        message:
          'id must start with a letter and contain only letters, numbers, hyphens, or underscores',
      });
    } else if (seenRoutineIds.has(routineId)) {
      errors.push({ path: `${routinePath}.id`, message: `duplicate routine id "${routineId}"` });
    } else {
      seenRoutineIds.add(routineId);
    }

    if (typeof r.label !== 'string' || !r.label.trim()) {
      errors.push({
        path: `${routinePath}.label`,
        message: 'label is required and must be a string',
      });
    }

    if (r.description !== undefined && typeof r.description !== 'string') {
      errors.push({ path: `${routinePath}.description`, message: 'description must be a string' });
    }

    const handler = typeof r.handler === 'string' ? r.handler.trim() : '';
    if (!handler) {
      errors.push({
        path: `${routinePath}.handler`,
        message: 'handler is required and must be a string',
      });
    } else if (!ROUTINE_HANDLER_RE.test(handler)) {
      errors.push({
        path: `${routinePath}.handler`,
        message: 'handler must be a valid exported function name',
      });
    } else if (Object.keys(functions).length > 0 && !functions[handler]) {
      warnings.push(`Routine "${routineId || index}" references missing handler "${handler}".`);
    }

    validateRoutineSchedule(r.default_schedule, `${routinePath}.default_schedule`, errors);
    if (r.config_schema !== undefined) {
      if (
        typeof r.config_schema !== 'object' ||
        r.config_schema === null ||
        Array.isArray(r.config_schema)
      ) {
        errors.push({
          path: `${routinePath}.config_schema`,
          message: 'config_schema must be an object',
        });
      } else {
        r.config_schema = normalizeManifestParameters(r.config_schema);
      }
    }
    if (
      r.default_config !== undefined &&
      (typeof r.default_config !== 'object' || r.default_config === null ||
        Array.isArray(r.default_config))
    ) {
      errors.push({
        path: `${routinePath}.default_config`,
        message: 'default_config must be an object',
      });
    }
    validateRoutineCapabilities(r.capabilities, `${routinePath}.capabilities`, errors);
    validateRoutineBudgetDefaults(r.budget_defaults, `${routinePath}.budget_defaults`, errors);
    validateRoutineApprovalPolicy(r.approval_policy, `${routinePath}.approval_policy`, errors);
    validateRoutineSurfaces(r.surfaces, `${routinePath}.surfaces`, errors);
  });
}

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

  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push({ path: 'name', message: 'name is required and must be a string' });
  }

  if (!manifest.version || typeof manifest.version !== 'string') {
    errors.push({ path: 'version', message: 'version is required and must be a string' });
  }

  if (!manifest.type || manifest.type !== 'mcp') {
    errors.push({ path: 'type', message: 'type must be "mcp"' });
  }

  if (!manifest.entry || typeof manifest.entry !== 'object') {
    errors.push({ path: 'entry', message: 'entry is required and must be an object' });
  } else {
    const entry = manifest.entry as Record<string, unknown>;
    if (!entry.functions) {
      errors.push({ path: 'entry.functions', message: 'entry.functions is required for MCP apps' });
    }
  }

  if (manifest.functions !== undefined) {
    if (typeof manifest.functions !== 'object' || manifest.functions === null) {
      errors.push({ path: 'functions', message: 'functions must be an object' });
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

  if (
    manifest.env !== undefined &&
    (typeof manifest.env !== 'object' || manifest.env === null || Array.isArray(manifest.env))
  ) {
    errors.push({ path: 'env', message: 'env must be an object' });
  }

  if (
    manifest.env_vars !== undefined &&
    (typeof manifest.env_vars !== 'object' || manifest.env_vars === null ||
      Array.isArray(manifest.env_vars))
  ) {
    errors.push({ path: 'env_vars', message: 'env_vars must be an object' });
  }

  const functionsForWidgetValidation =
    manifest.functions && typeof manifest.functions === 'object' &&
      !Array.isArray(manifest.functions)
      ? manifest.functions as Record<string, unknown>
      : {};
  const contextSourceIds = validateManifestContextSources(
    manifest.context_sources,
    functionsForWidgetValidation,
    errors,
    warnings,
  );
  validateManifestWidgets(
    manifest.widgets,
    functionsForWidgetValidation,
    contextSourceIds,
    errors,
    warnings,
  );
  validateManifestHttp(manifest.http, functionsForWidgetValidation, errors);
  validateManifestRoutines(manifest.routines, functionsForWidgetValidation, errors, warnings);

  const rawEnvVars = {
    ...((manifest.env && typeof manifest.env === 'object' && !Array.isArray(manifest.env))
      ? manifest.env as Record<string, unknown>
      : {}),
    ...((manifest.env_vars && typeof manifest.env_vars === 'object' &&
        !Array.isArray(manifest.env_vars))
      ? manifest.env_vars as Record<string, unknown>
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
      errors.push({ path: `env_vars.${key}`, message: 'env var entry must be an object' });
      continue;
    }

    const envVar = value as Record<string, unknown>;

    if (envVar.scope !== undefined && envVar.scope !== 'universal' && envVar.scope !== 'per_user') {
      errors.push({
        path: `env_vars.${key}.scope`,
        message: 'scope must be "universal" or "per_user"',
      });
    }

    if (envVar.type !== undefined && envVar.type !== 'universal' && envVar.type !== 'per_user') {
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

    if (envVar.description !== undefined && typeof envVar.description !== 'string') {
      errors.push({ path: `env_vars.${key}.description`, message: 'description must be a string' });
    }

    if (envVar.required !== undefined && typeof envVar.required !== 'boolean') {
      errors.push({ path: `env_vars.${key}.required`, message: 'required must be a boolean' });
    }

    if (envVar.default !== undefined && typeof envVar.default !== 'string') {
      errors.push({ path: `env_vars.${key}.default`, message: 'default must be a string' });
    }

    if (envVar.label !== undefined && typeof envVar.label !== 'string') {
      errors.push({ path: `env_vars.${key}.label`, message: 'label must be a string' });
    }

    if (envVar.placeholder !== undefined && typeof envVar.placeholder !== 'string') {
      errors.push({ path: `env_vars.${key}.placeholder`, message: 'placeholder must be a string' });
    }

    if (envVar.help !== undefined && typeof envVar.help !== 'string') {
      errors.push({ path: `env_vars.${key}.help`, message: 'help must be a string' });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  const normalizedEnvVars = getManifestEnvVars(manifest);
  if (normalizedEnvVars) {
    manifest.env = normalizedEnvVars;
    manifest.env_vars = normalizedEnvVars;
  }

  return {
    valid: true,
    manifest: input as AppManifest,
    errors: [],
    warnings,
  };
}

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
