import type { EnvCredential, EnvSchemaEntry } from './env.ts';
import { validateEnvVarKey } from './env.ts';
import type { MCPJsonSchema, MCPTool, MCPToolAnnotations } from './mcp.ts';
import type {
  RoutineBudgetDefaults,
  RoutineCapabilityDeclaration,
  RoutineDeclaration,
} from './routine.ts';
import type {
  WidgetContextSourceDeclaration,
  WidgetDeclaration,
  WidgetGenerationHints,
} from './widget.ts';

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
  // Functions on OTHER Agents this app calls via ultralight.call(). Declared
  // at deploy time so the runtime can authorize cross-Agent calls and so
  // Agent pages can surface which callers want access (P5 grant model).
  external_functions?: ManifestExternalDependency[];
  // Abstract capability slots this Agent calls via ultralight.use("name").
  // The developer declares a logical port (NOT a concrete target); the USER
  // binds each slot to a function on an Agent they own/installed — including
  // private Agents the developer could never name. These are hints that
  // prepopulate the wiring UI; the binding (a grant) is the real authority.
  imports?: Record<string, ManifestSlotImport>;
  // Pub/sub topics this Agent publishes via ultralight.emit(topic, payload).
  // A hint that prepopulates the subscription UI; emitting is unprivileged —
  // a subscriber only receives if the user wired a mode='subscribe' grant.
  emits?: string[];
  // Static HTML UIs rendered in a sandboxed iframe on the Agent's public
  // page. Each entry names a self-contained file in the uploaded bundle;
  // the sandbox blocks all network access, so `functions` is the complete
  // I/O surface — the host page only forwards bridge calls on that list.
  interfaces?: ManifestInterfaceDeclaration[];
  widgets?: WidgetDeclaration[];
  context_sources?: WidgetContextSourceDeclaration[];
  routines?: RoutineDeclaration[];
  env?: Record<string, ManifestEnvVar>;
  env_vars?: Record<string, ManifestEnvVar>;
  http?: ManifestHttpConfig;
  // Outbound network allowlist. In Phase 2 this becomes default-deny: with
  // net:fetch granted, the Agent's code may reach ONLY these hosts. Surfaced to
  // the user before install, and the only destinations a vaulted per-user
  // credential may be sent to.
  network?: ManifestNetworkConfig;
}

export interface ManifestNetworkConfig {
  allowed_destinations?: ManifestNetworkDestination[];
}

export interface ManifestNetworkDestination {
  // Hostname the Agent may reach: a bare host ("api.openai.com"), a subdomain
  // wildcard ("*.example.com"), optionally with a port ("imap.gmail.com:993").
  // No scheme, path, or query. Matched case-insensitively.
  host: string;
  // Human label + reason shown to the user before install ("OpenAI API — used
  // to generate taglines").
  label?: string;
  description?: string;
}

export interface ManifestExternalDependency {
  // Target Agent id or slug.
  app: string;
  // Function names on the target Agent this app wants to call.
  functions: string[];
  // 'write' is reserved until cross-Agent grants enforce the distinction
  // (P5); the runtime gate currently treats every dependency identically,
  // so the manifest must not record an authorization level nothing honors.
  access?: 'read';
}

export interface ManifestSlotImport {
  // Human-readable description of what this slot needs ("a source of stock
  // levels"). Shown in the wiring UI so the user knows what to bind.
  description?: string;
  // Optional expected call shape, e.g. "getStock(sku: string) -> { qty }".
  // Used only to rank eligible targets in the picker; not enforced.
  signature?: string;
  // Optional hint of the function name(s) the slot expects on the target.
  functions?: string[];
}

export interface ManifestInterfaceDeclaration {
  // Unique within interfaces[]; doubles as the picker anchor on the Agent
  // page, so it must be slug-safe.
  id: string;
  label: string;
  description?: string;
  // Path of a self-contained HTML file inside the uploaded bundle. The
  // upload pipeline copies it to content-addressed storage; it is never
  // served from the bundle location.
  entry: string;
  // Bridge allowlist: the only functions the host page will call on this
  // interface's behalf. The sandbox has no other I/O path.
  functions: string[];
  min_height?: number;
  // sha256 (hex) of the uploaded entry file. Stamped by the upload
  // pipeline; developer-supplied values are overwritten, never trusted.
  hash?: string;
}

export type ManifestHttpAuthMode = 'user' | 'public';
export type ManifestHttpBillingMode = 'owner' | 'caller';
export type ManifestHttpDataScope = 'app' | 'user';
export type ManifestHttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD';

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
  generation_hints?: WidgetGenerationHints;
  // Upload-derived: this function (transitively) calls galactic.ai()/
  // ultralight.ai(). Drives Free Mode (AI functions need a BYOK key when the
  // caller is in free mode). Conservative — see docs/FREE_MODE_DESIGN.md.
  uses_inference?: boolean;
  // Durable execution: class 'async' dispatches calls to the execution queue
  // — the caller gets a { _async, job_id } envelope in milliseconds and polls
  // ul.job. Queue executions run with an extended budget (timeout_ms can only
  // LOWER it; the platform ceiling applies). Default/'sync' runs in-request.
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
    // The calling Agent for a cross-Agent call (P5), or null/undefined for a
    // direct user call. Lets a policy module deny or reprice per caller.
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

export type ToolAccessPolicyDecision =
  | ToolAccessPolicyAllowDecision
  | ToolAccessPolicyDenyDecision;

export type ToolAccessPolicyFunction = (
  payload: ToolAccessPolicyPlanPayload,
) => ToolAccessPolicyDecision | Promise<ToolAccessPolicyDecision>;

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
  // Marks this secret as a CREDENTIAL: the platform attaches it to outbound
  // requests to `credential.destination` in the parent isolate and never
  // injects the plaintext into the sandbox (Phase 3 vault). destination must be
  // declared in network.allowed_destinations.
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

export function humanizeEnvVarKey(key: string): string {
  return key
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const DEST_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// A destination host for the outbound allowlist / credential binding: a bare
// hostname, optionally a "*." subdomain wildcard, optionally a ":port". No
// scheme, path, or query. Returns the canonical (lowercased) host, or null.
function normalizeDestinationHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (
    !raw || raw.includes('://') || raw.includes('/') || raw.includes('?') ||
    raw.includes(' ') || raw.includes('@')
  ) {
    return null;
  }

  let host = raw;
  let port = '';
  const colon = raw.indexOf(':');
  if (colon !== -1) {
    host = raw.slice(0, colon);
    port = raw.slice(colon + 1);
    const portNum = Number(port);
    if (!/^\d{1,5}$/.test(port) || portNum < 1 || portNum > 65535) return null;
  }

  const bare = host.startsWith('*.') ? host.slice(2) : host;
  if (!bare || !bare.includes('.')) return null;
  if (!bare.split('.').every((label) => DEST_LABEL_RE.test(label))) return null;

  return port ? `${host}:${port}` : host;
}

function normalizeEnvCredential(value: unknown): EnvCredential | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const destination = normalizeDestinationHost(raw.destination);
  const inject = raw.inject;
  if (!destination || !inject || typeof inject !== 'object') return undefined;
  const i = inject as Record<string, unknown>;

  if (i.as === 'bearer') {
    return { destination, inject: { as: 'bearer' } };
  }
  if (i.as === 'header' && typeof i.name === 'string' && i.name.trim()) {
    return {
      destination,
      inject: {
        as: 'header',
        name: i.name.trim(),
        prefix: typeof i.prefix === 'string' ? i.prefix : undefined,
      },
    };
  }
  if (i.as === 'basic') {
    return {
      destination,
      inject: {
        as: 'basic',
        username_env: typeof i.username_env === 'string'
          ? i.username_env
          : undefined,
      },
    };
  }
  if (i.as === 'query' && typeof i.name === 'string' && i.name.trim()) {
    return { destination, inject: { as: 'query', name: i.name.trim() } };
  }
  return undefined;
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
    credential: normalizeEnvCredential(raw.credential),
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
      credential: value.credential,
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
      credential: normalizeEnvCredential(entry.credential),
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
        item && typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string'
      ) {
        const { name, ...rest } = item as
          & { name: string }
          & Record<string, unknown>;
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
      errors.push({
        path: `${path}.${index}`,
        message: 'method must be a string',
      });
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
      errors.push({
        path: `${path}.${index}`,
        message: `duplicate method "${upper}"`,
      });
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
      errors.push({
        path: `${path}.origins`,
        message: 'origins must be a non-empty array',
      });
    } else {
      const origins: string[] = [];
      const seen = new Set<string>();
      for (const [index, originValue] of cors.origins.entries()) {
        if (typeof originValue !== 'string') {
          errors.push({
            path: `${path}.origins.${index}`,
            message: 'origin must be a string',
          });
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
      errors.push({
        path: `${path}.credentials`,
        message: 'credentials must be a boolean',
      });
    } else {
      normalized.credentials = cors.credentials;
    }
  }

  if (cors.headers !== undefined) {
    if (!Array.isArray(cors.headers)) {
      errors.push({
        path: `${path}.headers`,
        message: 'headers must be an array',
      });
    } else {
      const headers: string[] = [];
      const seen = new Set<string>();
      for (const [index, headerValue] of cors.headers.entries()) {
        if (
          typeof headerValue !== 'string' ||
          !HTTP_HEADER_NAME_RE.test(headerValue.trim())
        ) {
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
  if (
    typeof value !== 'number' || !Number.isInteger(value) || value < 1 ||
    value > max
  ) {
    errors.push({
      path,
      message: `${label} must be an integer between 1 and ${max}`,
    });
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
  const billing = validateHttpBillingMode(
    value.billing,
    `${path}.billing`,
    errors,
  );
  const dataScope = validateHttpDataScope(
    value.data_scope,
    `${path}.data_scope`,
    errors,
  );
  const methods = validateHttpMethods(value.methods, `${path}.methods`, errors);
  const cors = validateHttpCors(value.cors, `${path}.cors`, errors);
  const rateLimit = validateHttpRateLimit(
    value.rate_limit,
    `${path}.rate_limit`,
    errors,
  );

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
    if (
      !http.defaults || typeof http.defaults !== 'object' ||
      Array.isArray(http.defaults)
    ) {
      errors.push({
        path: 'http.defaults',
        message: 'defaults must be an object',
      });
    } else {
      defaults = validateHttpRouteDefaults(
        http.defaults as Record<string, unknown>,
        'http.defaults',
        errors,
      );
    }
  }

  if (http.routes === undefined) return;
  if (
    !http.routes || typeof http.routes !== 'object' ||
    Array.isArray(http.routes)
  ) {
    errors.push({ path: 'http.routes', message: 'routes must be an object' });
    return;
  }

  for (
    const [routeName, routeValue] of Object.entries(
      http.routes as Record<string, unknown>,
    )
  ) {
    const routePath = `http.routes.${routeName}`;
    if (
      !routeName || routeName.trim() !== routeName || /[/?#\s]/.test(routeName)
    ) {
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
    if (
      !routeValue || typeof routeValue !== 'object' || Array.isArray(routeValue)
    ) {
      errors.push({
        path: routePath,
        message: 'route policy must be an object',
      });
      continue;
    }

    const routeRecord = routeValue as Record<string, unknown>;
    const route = validateHttpRouteDefaults(routeRecord, routePath, errors);
    const auth = route.auth ?? defaults.auth ?? 'user';
    const methods = route.methods ?? defaults.methods;
    const billing = route.billing ?? defaults.billing ??
      (auth === 'public' ? 'owner' : 'caller');
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
    if (
      !dependency || typeof dependency !== 'object' || Array.isArray(dependency)
    ) {
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

function validateManifestExternalFunctions(
  value: unknown,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({
      path: 'external_functions',
      message: 'external_functions must be an array',
    });
    return;
  }

  value.forEach((dependency, index) => {
    const depPath = `external_functions.${index}`;
    if (
      !dependency || typeof dependency !== 'object' || Array.isArray(dependency)
    ) {
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
        message:
          'external_functions access "write" is reserved until cross-Agent grants land; omit or use "read"',
      });
    }
  });
}

const INTERFACE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

// Entry paths address files inside the developer's uploaded bundle; reject
// anything that could escape it or smuggle a non-HTML artifact into the
// interface serving path.
function isSafeInterfaceEntryPath(entry: string): boolean {
  if (!entry.endsWith('.html')) return false;
  if (entry.startsWith('/') || entry.includes('\\')) return false;
  return entry
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validateManifestInterfaces(
  value: unknown,
  functions: Record<string, unknown>,
  errors: ManifestValidationError[],
  warnings: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push({ path: 'interfaces', message: 'interfaces must be an array' });
    return;
  }

  const seenIds = new Set<string>();
  value.forEach((declaration, index) => {
    const ifacePath = `interfaces.${index}`;
    if (
      !declaration || typeof declaration !== 'object' ||
      Array.isArray(declaration)
    ) {
      errors.push({ path: ifacePath, message: 'interface must be an object' });
      return;
    }

    const iface = declaration as Record<string, unknown>;
    if (typeof iface.id !== 'string' || !INTERFACE_ID_RE.test(iface.id)) {
      errors.push({
        path: `${ifacePath}.id`,
        message:
          'id is required and must start with a letter and contain only letters, numbers, hyphens, or underscores (max 64 chars)',
      });
    } else if (seenIds.has(iface.id)) {
      errors.push({
        path: `${ifacePath}.id`,
        message: `duplicate interface id "${iface.id}"`,
      });
    } else {
      seenIds.add(iface.id);
    }

    if (typeof iface.label !== 'string' || !iface.label.trim()) {
      errors.push({
        path: `${ifacePath}.label`,
        message: 'label is required and must be a non-empty string',
      });
    }
    if (iface.description !== undefined && typeof iface.description !== 'string') {
      errors.push({
        path: `${ifacePath}.description`,
        message: 'description must be a string',
      });
    }

    if (
      typeof iface.entry !== 'string' || !iface.entry.trim() ||
      !isSafeInterfaceEntryPath(iface.entry)
    ) {
      errors.push({
        path: `${ifacePath}.entry`,
        message:
          'entry is required and must be a relative bundle path ending in .html (no leading "/", no ".." segments)',
      });
    }

    if (
      !Array.isArray(iface.functions) ||
      iface.functions.length === 0 ||
      iface.functions.some((fn) => typeof fn !== 'string' || !fn.trim())
    ) {
      errors.push({
        path: `${ifacePath}.functions`,
        message: 'functions must be a non-empty array of strings',
      });
    } else if (Object.keys(functions).length > 0) {
      const interfaceId = typeof iface.id === 'string' ? iface.id : `${index}`;
      for (const fn of iface.functions) {
        if (!functions[fn]) {
          warnings.push(
            `Interface "${interfaceId}" allowlists missing function "${fn}".`,
          );
        }
      }
    }

    if (
      iface.min_height !== undefined &&
      (typeof iface.min_height !== 'number' ||
        !Number.isFinite(iface.min_height) || iface.min_height <= 0)
    ) {
      errors.push({
        path: `${ifacePath}.min_height`,
        message: 'min_height must be a positive number of pixels',
      });
    }

    // hash is server-stamped at upload; tolerate (and ignore) any supplied
    // string so re-validating a stored manifest stays clean.
    if (iface.hash !== undefined && typeof iface.hash !== 'string') {
      errors.push({
        path: `${ifacePath}.hash`,
        message: 'hash must be a string (set by the platform at upload)',
      });
    }
  });
}

function validateManifestImports(
  value: unknown,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push({ path: 'imports', message: 'imports must be an object' });
    return;
  }

  for (const [slotName, slot] of Object.entries(value)) {
    const slotPath = `imports.${slotName}`;
    if (!slotName.trim()) {
      errors.push({ path: 'imports', message: 'slot names must be non-empty' });
    }
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      errors.push({ path: slotPath, message: 'slot must be an object' });
      continue;
    }
    const entry = slot as Record<string, unknown>;
    for (const field of ['description', 'signature']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        errors.push({ path: `${slotPath}.${field}`, message: `${field} must be a string` });
      }
    }
    if (
      entry.functions !== undefined &&
      (!Array.isArray(entry.functions) ||
        entry.functions.some((fn) => typeof fn !== 'string' || !fn.trim()))
    ) {
      errors.push({
        path: `${slotPath}.functions`,
        message: 'functions must be an array of non-empty strings',
      });
    }
  }
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

const GENERATION_COMPONENT_KINDS = new Set([
  'metric',
  'list',
  'table',
  'detail',
  'form',
  'action_bar',
  'timeline',
  'card_ref',
  'widget_embed',
  'routine_panel',
  'text',
]);

function validateGenerationHints(
  value: unknown,
  path: string,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path, message: 'generation_hints must be an object' });
    return;
  }

  const hints = value as Record<string, unknown>;
  validateOptionalStringArray(
    hints.tags,
    `${path}.tags`,
    'tags must be an array of non-empty strings',
    errors,
  );
  validateOptionalStringArray(
    hints.entity_types,
    `${path}.entity_types`,
    'entity_types must be an array of non-empty strings',
    errors,
  );
  validateOptionalStringArray(
    hints.prompt_examples,
    `${path}.prompt_examples`,
    'prompt_examples must be an array of non-empty strings',
    errors,
  );

  if (
    hints.preferred_component !== undefined &&
    (typeof hints.preferred_component !== 'string' ||
      !GENERATION_COMPONENT_KINDS.has(hints.preferred_component))
  ) {
    errors.push({
      path: `${path}.preferred_component`,
      message: 'preferred_component must be a supported generated component kind',
    });
  }
  if (
    hints.action_group !== undefined && typeof hints.action_group !== 'string'
  ) {
    errors.push({
      path: `${path}.action_group`,
      message: 'action_group must be a string',
    });
  }
  if (
    hints.safe_default_filters !== undefined &&
    (!hints.safe_default_filters ||
      typeof hints.safe_default_filters !== 'object' ||
      Array.isArray(hints.safe_default_filters))
  ) {
    errors.push({
      path: `${path}.safe_default_filters`,
      message: 'safe_default_filters must be an object',
    });
  }

  if (hints.suggested_components !== undefined) {
    if (!Array.isArray(hints.suggested_components)) {
      errors.push({
        path: `${path}.suggested_components`,
        message: 'suggested_components must be an array',
      });
    } else {
      hints.suggested_components.forEach((component, index) => {
        const componentPath = `${path}.suggested_components.${index}`;
        if (
          !component || typeof component !== 'object' ||
          Array.isArray(component)
        ) {
          errors.push({
            path: componentPath,
            message: 'suggested component must be an object',
          });
          return;
        }
        const c = component as Record<string, unknown>;
        if (
          typeof c.kind !== 'string' ||
          !GENERATION_COMPONENT_KINDS.has(c.kind)
        ) {
          errors.push({
            path: `${componentPath}.kind`,
            message: 'kind must be a supported generated component kind',
          });
        }
        for (
          const key of [
            'title',
            'description',
            'data_view',
            'context_source_id',
          ]
        ) {
          if (c[key] !== undefined && typeof c[key] !== 'string') {
            errors.push({
              path: `${componentPath}.${key}`,
              message: `${key} must be a string`,
            });
          }
        }
        validateOptionalStringArray(
          c.action_ids,
          `${componentPath}.action_ids`,
          'action_ids must be an array of non-empty strings',
          errors,
        );
      });
    }
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
    errors.push({
      path: 'context_sources',
      message: 'context_sources must be an array',
    });
    return ids;
  }

  const seen = new Set<string>();
  value.forEach((source, index) => {
    const sourcePath = `context_sources.${index}`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      errors.push({
        path: sourcePath,
        message: 'context source declaration must be an object',
      });
      return;
    }

    const s = source as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!id) {
      errors.push({
        path: `${sourcePath}.id`,
        message: 'id is required and must be a string',
      });
    } else if (seen.has(id)) {
      errors.push({
        path: `${sourcePath}.id`,
        message: `duplicate context source id "${id}"`,
      });
    } else {
      seen.add(id);
      ids.add(id);
    }

    if (typeof s.label !== 'string' || !s.label.trim()) {
      errors.push({
        path: `${sourcePath}.label`,
        message: 'label is required and must be a string',
      });
    }
    if (s.description !== undefined && typeof s.description !== 'string') {
      errors.push({
        path: `${sourcePath}.description`,
        message: 'description must be a string',
      });
    }
    if (
      s.type !== 'd1_table' && s.type !== 'd1_query' && s.type !== 'function'
    ) {
      errors.push({
        path: `${sourcePath}.type`,
        message: 'type must be one of d1_table, d1_query, or function',
      });
    }
    if (s.access !== 'read') {
      errors.push({
        path: `${sourcePath}.access`,
        message: 'access is required and must be read',
      });
    }
    if (s.searchable !== undefined && typeof s.searchable !== 'boolean') {
      errors.push({
        path: `${sourcePath}.searchable`,
        message: 'searchable must be a boolean',
      });
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
        if (
          typeof tableName === 'string' && tableName.trim() &&
          !isSafeContextSqlIdentifier(tableName.trim())
        ) {
          errors.push({
            path: `${sourcePath}.tables.${tableIndex}`,
            message: 'table names must be simple SQL identifiers',
          });
        }
      }
    }

    if (s.query !== undefined && typeof s.query !== 'string') {
      errors.push({
        path: `${sourcePath}.query`,
        message: 'query must be a string',
      });
    }
    if (s.function !== undefined && typeof s.function !== 'string') {
      errors.push({
        path: `${sourcePath}.function`,
        message: 'function must be a string',
      });
    }

    if (
      s.type === 'd1_table' &&
      (!Array.isArray(s.tables) || s.tables.length === 0)
    ) {
      errors.push({
        path: `${sourcePath}.tables`,
        message: 'd1_table context sources must declare tables',
      });
    }
    if (
      s.type === 'd1_query' && (typeof s.query !== 'string' || !s.query.trim())
    ) {
      errors.push({
        path: `${sourcePath}.query`,
        message: 'd1_query context sources must declare query',
      });
    } else if (s.type === 'd1_query' && typeof s.query === 'string') {
      if (!isSelectOnlyContextQuery(s.query)) {
        errors.push({
          path: `${sourcePath}.query`,
          message: 'd1_query context source query must be SELECT-only',
        });
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
        errors.push({
          path: `${sourcePath}.function`,
          message: 'function context sources must declare function',
        });
      } else if (
        Object.keys(functions).length > 0 && !functions[functionName]
      ) {
        warnings.push(
          `Context source "${id || index}" references missing function "${functionName}".`,
        );
      }
    }

    if (s.redactions !== undefined) {
      if (!Array.isArray(s.redactions)) {
        errors.push({
          path: `${sourcePath}.redactions`,
          message: 'redactions must be an array',
        });
      } else {
        s.redactions.forEach((redaction, redactionIndex) => {
          const redactionPath = `${sourcePath}.redactions.${redactionIndex}`;
          if (
            !redaction || typeof redaction !== 'object' ||
            Array.isArray(redaction)
          ) {
            errors.push({
              path: redactionPath,
              message: 'redaction must be an object',
            });
            return;
          }
          const r = redaction as Record<string, unknown>;
          for (const key of ['field', 'pattern', 'replacement']) {
            if (r[key] !== undefined && typeof r[key] !== 'string') {
              errors.push({
                path: `${redactionPath}.${key}`,
                message: `${key} must be a string`,
              });
            }
          }
        });
      }
    }
    validateGenerationHints(
      s.generation_hints,
      `${sourcePath}.generation_hints`,
      errors,
    );
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
      errors.push({
        path: actionPath,
        message: 'agent action must be an object',
      });
      return;
    }

    const a = action as Record<string, unknown>;
    const id = typeof a.id === 'string' ? a.id.trim() : '';
    if (!id) {
      errors.push({
        path: `${actionPath}.id`,
        message: 'id is required and must be a string',
      });
    } else if (seen.has(id)) {
      errors.push({
        path: `${actionPath}.id`,
        message: `duplicate agent action id "${id}"`,
      });
    } else {
      seen.add(id);
    }

    if (typeof a.label !== 'string' || !a.label.trim()) {
      errors.push({
        path: `${actionPath}.label`,
        message: 'label is required and must be a string',
      });
    }
    if (a.description !== undefined && typeof a.description !== 'string') {
      errors.push({
        path: `${actionPath}.description`,
        message: 'description must be a string',
      });
    }
    if (a.mode !== 'read' && a.mode !== 'write' && a.mode !== 'ui') {
      errors.push({
        path: `${actionPath}.mode`,
        message: 'mode must be one of read, write, or ui',
      });
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
      warnings.push(
        `Agent action "${id || index}" is write-mode but has no confirmation policy.`,
      );
    }
    if (
      a.args_schema !== undefined &&
      (!a.args_schema || typeof a.args_schema !== 'object' ||
        Array.isArray(a.args_schema))
    ) {
      errors.push({
        path: `${actionPath}.args_schema`,
        message: 'args_schema must be an object',
      });
    }
    if (
      a.expected_result !== undefined && typeof a.expected_result !== 'string'
    ) {
      errors.push({
        path: `${actionPath}.expected_result`,
        message: 'expected_result must be a string',
      });
    }
    validateGenerationHints(
      a.generation_hints,
      `${actionPath}.generation_hints`,
      errors,
    );

    if (a.mcp !== undefined) {
      if (!a.mcp || typeof a.mcp !== 'object' || Array.isArray(a.mcp)) {
        errors.push({
          path: `${actionPath}.mcp`,
          message: 'mcp must be an object',
        });
      } else {
        const mcp = a.mcp as Record<string, unknown>;
        const functionName = typeof mcp.function === 'string' ? mcp.function.trim() : '';
        if (!functionName) {
          errors.push({
            path: `${actionPath}.mcp.function`,
            message: 'function is required and must be a string',
          });
        } else if (
          Object.keys(functions).length > 0 && !functions[functionName]
        ) {
          warnings.push(
            `Agent action "${id || index}" references missing MCP function "${functionName}".`,
          );
        }
        if (
          mcp.args_template !== undefined &&
          (!mcp.args_template || typeof mcp.args_template !== 'object' ||
            Array.isArray(mcp.args_template))
        ) {
          errors.push({
            path: `${actionPath}.mcp.args_template`,
            message: 'args_template must be an object',
          });
        }
      }
    }

    if (a.ui !== undefined) {
      if (!a.ui || typeof a.ui !== 'object' || Array.isArray(a.ui)) {
        errors.push({
          path: `${actionPath}.ui`,
          message: 'ui must be an object',
        });
      } else {
        const ui = a.ui as Record<string, unknown>;
        if (ui.command !== undefined && typeof ui.command !== 'string') {
          errors.push({
            path: `${actionPath}.ui.command`,
            message: 'command must be a string',
          });
        }
        if (
          ui.component_id !== undefined && typeof ui.component_id !== 'string'
        ) {
          errors.push({
            path: `${actionPath}.ui.component_id`,
            message: 'component_id must be a string',
          });
        }
        if (
          ui.args_template !== undefined &&
          (!ui.args_template || typeof ui.args_template !== 'object' ||
            Array.isArray(ui.args_template))
        ) {
          errors.push({
            path: `${actionPath}.ui.args_template`,
            message: 'args_template must be an object',
          });
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
        errors.push({
          path: `${widgetPath}.${key}`,
          message: `${key} must be a string`,
        });
      }
    }

    if (w.agentic !== undefined && typeof w.agentic !== 'boolean') {
      errors.push({
        path: `${widgetPath}.agentic`,
        message: 'agentic must be a boolean',
      });
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

    validateWidgetDependencies(
      w.dependencies,
      `${widgetPath}.dependencies`,
      errors,
    );
    validateOptionalStringArray(
      w.context_sources,
      `${widgetPath}.context_sources`,
      'context_sources must be an array of non-empty strings',
      errors,
    );

    if (Array.isArray(w.context_sources)) {
      for (const sourceId of w.context_sources) {
        if (
          typeof sourceId === 'string' && sourceId.trim() &&
          !contextSourceIds.has(sourceId.trim())
        ) {
          warnings.push(
            `Widget "${widgetId || index}" references unknown context source "${sourceId.trim()}".`,
          );
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
    validateGenerationHints(
      w.generation_hints,
      `${widgetPath}.generation_hints`,
      errors,
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

    if (
      uiFunction && Object.keys(functions).length > 0 && !functions[uiFunction]
    ) {
      warnings.push(
        `Widget "${widgetId}" references missing UI function "${uiFunction}".`,
      );
    }
    if (
      dataFunction && Object.keys(functions).length > 0 &&
      !functions[dataFunction]
    ) {
      warnings.push(
        `Widget "${widgetId}" references missing data function "${dataFunction}".`,
      );
    }

    const contextFunction = typeof w.context_function === 'string' && w.context_function.trim()
      ? w.context_function.trim()
      : null;
    const actionsFunction = typeof w.actions_function === 'string' && w.actions_function.trim()
      ? w.actions_function.trim()
      : null;
    if (
      contextFunction && Object.keys(functions).length > 0 &&
      !functions[contextFunction]
    ) {
      warnings.push(
        `Widget "${widgetId}" references missing context function "${contextFunction}".`,
      );
    }
    if (
      actionsFunction && Object.keys(functions).length > 0 &&
      !functions[actionsFunction]
    ) {
      warnings.push(
        `Widget "${widgetId}" references missing actions function "${actionsFunction}".`,
      );
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
      errors.push({
        path: `${widgetPath}.cards`,
        message: 'cards must be an array',
      });
      return;
    }

    const seenCardIds = new Set<string>();
    w.cards.forEach((card, cardIndex) => {
      const cardPath = `${widgetPath}.cards.${cardIndex}`;
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        errors.push({
          path: cardPath,
          message: 'card declaration must be an object',
        });
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
        errors.push({
          path: `${cardPath}.kind`,
          message: 'kind must be a string',
        });
      }
      for (const key of ['description', 'data_view', 'data_function']) {
        if (c[key] !== undefined && typeof c[key] !== 'string') {
          errors.push({
            path: `${cardPath}.${key}`,
            message: `${key} must be a string`,
          });
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
      validateWidgetDependencies(
        c.dependencies,
        `${cardPath}.dependencies`,
        errors,
      );
      validateGenerationHints(
        c.generation_hints,
        `${cardPath}.generation_hints`,
        errors,
      );

      const cardDataFunction = typeof c.data_function === 'string' && c.data_function.trim()
        ? c.data_function.trim()
        : dataFunction;
      if (
        cardDataFunction && Object.keys(functions).length > 0 &&
        !functions[cardDataFunction]
      ) {
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

  const hasInterval = schedule.every_seconds !== undefined ||
    schedule.every_minutes !== undefined;
  const hasCron = typeof schedule.cron === 'string' && !!schedule.cron.trim();
  if (!hasInterval && !hasCron) {
    errors.push({
      path,
      message: 'schedule object must define cron, every_seconds, or every_minutes',
    });
  }

  if (
    schedule.timezone !== undefined && typeof schedule.timezone !== 'string'
  ) {
    errors.push({
      path: `${path}.timezone`,
      message: 'timezone must be a string',
    });
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
    if (
      !capability || typeof capability !== 'object' || Array.isArray(capability)
    ) {
      errors.push({ path: capPath, message: 'capability must be an object' });
      return;
    }

    const cap = capability as
      & RoutineCapabilityDeclaration
      & Record<string, unknown>;
    if (typeof cap.app !== 'string' || !cap.app.trim()) {
      errors.push({
        path: `${capPath}.app`,
        message: 'app is required and must be a string',
      });
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
    if (
      cap.access !== undefined && cap.access !== 'read' &&
      cap.access !== 'write'
    ) {
      errors.push({
        path: `${capPath}.access`,
        message: 'access must be "read" or "write"',
      });
    }
    if (cap.required !== undefined && typeof cap.required !== 'boolean') {
      errors.push({
        path: `${capPath}.required`,
        message: 'required must be a boolean',
      });
    }
    if (cap.purpose !== undefined && typeof cap.purpose !== 'string') {
      errors.push({
        path: `${capPath}.purpose`,
        message: 'purpose must be a string',
      });
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
      errors.push({
        path: `${path}.${key}`,
        message: `${key} must be a boolean`,
      });
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
      errors.push({
        path: `${path}.command_cards`,
        message: 'command_cards must be an array',
      });
    } else {
      surfaces.command_cards.forEach((card, index) => {
        const cardPath = `${path}.command_cards.${index}`;
        if (!card || typeof card !== 'object' || Array.isArray(card)) {
          errors.push({
            path: cardPath,
            message: 'command card binding must be an object',
          });
          return;
        }
        const binding = card as Record<string, unknown>;
        if (
          typeof binding.widget_id !== 'string' || !binding.widget_id.trim()
        ) {
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
  if (
    surfaces.dashboard_key !== undefined &&
    typeof surfaces.dashboard_key !== 'string'
  ) {
    errors.push({
      path: `${path}.dashboard_key`,
      message: 'dashboard_key must be a string',
    });
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
      errors.push({
        path: routinePath,
        message: 'routine declaration must be an object',
      });
      return;
    }

    const r = routine as Record<string, unknown>;
    const routineId = typeof r.id === 'string' ? r.id.trim() : '';
    if (!routineId) {
      errors.push({
        path: `${routinePath}.id`,
        message: 'id is required and must be a string',
      });
    } else if (!ROUTINE_ID_RE.test(routineId)) {
      errors.push({
        path: `${routinePath}.id`,
        message:
          'id must start with a letter and contain only letters, numbers, hyphens, or underscores',
      });
    } else if (seenRoutineIds.has(routineId)) {
      errors.push({
        path: `${routinePath}.id`,
        message: `duplicate routine id "${routineId}"`,
      });
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
      errors.push({
        path: `${routinePath}.description`,
        message: 'description must be a string',
      });
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
      warnings.push(
        `Routine "${routineId || index}" references missing handler "${handler}".`,
      );
    }

    validateRoutineSchedule(
      r.default_schedule,
      `${routinePath}.default_schedule`,
      errors,
    );
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
    validateRoutineCapabilities(
      r.capabilities,
      `${routinePath}.capabilities`,
      errors,
    );
    validateRoutineBudgetDefaults(
      r.budget_defaults,
      `${routinePath}.budget_defaults`,
      errors,
    );
    validateRoutineApprovalPolicy(
      r.approval_policy,
      `${routinePath}.approval_policy`,
      errors,
    );
    validateRoutineSurfaces(r.surfaces, `${routinePath}.surfaces`, errors);
  });
}

function isSafeManifestModulePath(value: string): boolean {
  const trimmed = value.trim();
  if (
    !trimmed || trimmed.startsWith('/') || trimmed.includes('\\') ||
    !/\.(ts|js|mjs)$/.test(trimmed)
  ) {
    return false;
  }

  const parts = trimmed.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..');
}

function isSafeManifestExportName(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value.trim());
}

function validateManifestAccessPolicy(
  policy: unknown,
  errors: ManifestValidationError[],
): void {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    errors.push({
      path: 'access_policy',
      message: 'access_policy must be an object',
    });
    return;
  }

  const accessPolicy = policy as Record<string, unknown>;
  if (
    accessPolicy.mode !== undefined && accessPolicy.mode !== 'static' &&
    accessPolicy.mode !== 'module'
  ) {
    errors.push({
      path: 'access_policy.mode',
      message: 'mode must be "static" or "module"',
    });
  }

  if (accessPolicy.mode === 'module' && accessPolicy.module === undefined) {
    errors.push({
      path: 'access_policy.module',
      message: 'module is required when mode is "module"',
    });
  }

  if (accessPolicy.mode === 'static' && accessPolicy.module !== undefined) {
    errors.push({
      path: 'access_policy.module',
      message: 'module cannot be set when mode is "static"',
    });
  }

  if (accessPolicy.module !== undefined) {
    if (
      typeof accessPolicy.module !== 'string' ||
      !isSafeManifestModulePath(accessPolicy.module)
    ) {
      errors.push({
        path: 'access_policy.module',
        message: 'module must be a relative .ts, .js, or .mjs path without . or .. segments',
      });
    }
  }

  if (accessPolicy.export !== undefined) {
    if (
      typeof accessPolicy.export !== 'string' ||
      !isSafeManifestExportName(accessPolicy.export)
    ) {
      errors.push({
        path: 'access_policy.export',
        message: 'export must be a valid JavaScript identifier',
      });
    }
  }
}

// Validates manifest.network and normalizes allowed_destinations in place to the
// canonical object form. Returns the set of declared (canonical) hosts so the
// env-var loop can cross-check credential.destination against it.
function validateManifestNetwork(
  value: unknown,
  errors: ManifestValidationError[],
): Set<string> {
  const hosts = new Set<string>();
  if (value === undefined) return hosts;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path: 'network', message: 'network must be an object' });
    return hosts;
  }

  const net = value as Record<string, unknown>;
  if (net.allowed_destinations === undefined) return hosts;
  if (!Array.isArray(net.allowed_destinations)) {
    errors.push({
      path: 'network.allowed_destinations',
      message: 'allowed_destinations must be an array',
    });
    return hosts;
  }

  const normalized: ManifestNetworkDestination[] = [];
  net.allowed_destinations.forEach((entry, index) => {
    const path = `network.allowed_destinations.${index}`;
    const raw = typeof entry === 'string' ? { host: entry } : entry;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({
        path,
        message: 'destination must be a host string or an object with a host',
      });
      return;
    }
    const r = raw as Record<string, unknown>;
    const host = normalizeDestinationHost(r.host);
    if (!host) {
      errors.push({
        path: `${path}.host`,
        message:
          'host must be a bare hostname (optionally "*.domain" or ":port"), with no scheme, path, or query',
      });
      return;
    }
    if (hosts.has(host)) {
      errors.push({ path: `${path}.host`, message: `duplicate destination "${host}"` });
      return;
    }
    if (r.label !== undefined && typeof r.label !== 'string') {
      errors.push({ path: `${path}.label`, message: 'label must be a string' });
    }
    if (r.description !== undefined && typeof r.description !== 'string') {
      errors.push({
        path: `${path}.description`,
        message: 'description must be a string',
      });
    }
    hosts.add(host);
    normalized.push({
      host,
      label: typeof r.label === 'string' ? r.label : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
    });
  });

  net.allowed_destinations = normalized;
  return hosts;
}

// Validates an env var's optional credential binding. destination must be an
// exact host declared in network.allowed_destinations (declare the specific host
// even if you also declare a wildcard), and inject must be a supported shape.
function validateEnvCredential(
  value: unknown,
  path: string,
  allowedHosts: Set<string>,
  errors: ManifestValidationError[],
): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path, message: 'credential must be an object' });
    return;
  }
  const c = value as Record<string, unknown>;

  const destination = normalizeDestinationHost(c.destination);
  if (!destination) {
    errors.push({
      path: `${path}.destination`,
      message: 'destination must be a bare hostname (no scheme or path)',
    });
  } else if (!allowedHosts.has(destination)) {
    errors.push({
      path: `${path}.destination`,
      message:
        `destination "${destination}" must be declared in network.allowed_destinations`,
    });
  }

  if (!c.inject || typeof c.inject !== 'object' || Array.isArray(c.inject)) {
    errors.push({
      path: `${path}.inject`,
      message: 'inject is required and must be an object',
    });
    return;
  }
  const inject = c.inject as Record<string, unknown>;
  switch (inject.as) {
    case 'bearer':
      break;
    case 'header':
      if (
        typeof inject.name !== 'string' ||
        !HTTP_HEADER_NAME_RE.test(inject.name.trim())
      ) {
        errors.push({
          path: `${path}.inject.name`,
          message: 'header inject requires a valid header name',
        });
      }
      if (inject.prefix !== undefined && typeof inject.prefix !== 'string') {
        errors.push({
          path: `${path}.inject.prefix`,
          message: 'prefix must be a string',
        });
      }
      break;
    case 'basic':
      if (
        inject.username_env !== undefined &&
        typeof inject.username_env !== 'string'
      ) {
        errors.push({
          path: `${path}.inject.username_env`,
          message: 'username_env must be a string',
        });
      }
      break;
    case 'query':
      if (typeof inject.name !== 'string' || !inject.name.trim()) {
        errors.push({
          path: `${path}.inject.name`,
          message: 'query inject requires a name',
        });
      }
      break;
    default:
      errors.push({
        path: `${path}.inject.as`,
        message: 'inject.as must be one of: bearer, header, basic, query',
      });
  }
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

  if (!manifest.type || manifest.type !== 'mcp') {
    errors.push({ path: 'type', message: 'type must be "mcp"' });
  }

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
        validateGenerationHints(
          fn.generation_hints,
          `functions.${fnName}.generation_hints`,
          errors,
        );

        if (fn.execution !== undefined) {
          if (!fn.execution || typeof fn.execution !== 'object') {
            errors.push({
              path: `functions.${fnName}.execution`,
              message: 'execution must be an object',
            });
          } else {
            const execution = fn.execution as Record<string, unknown>;
            if (
              execution.class !== undefined && execution.class !== 'sync' &&
              execution.class !== 'async'
            ) {
              errors.push({
                path: `functions.${fnName}.execution.class`,
                message: "execution.class must be 'sync' or 'async'",
              });
            }
            if (execution.timeout_ms !== undefined) {
              const timeout = execution.timeout_ms;
              if (
                typeof timeout !== 'number' || !Number.isFinite(timeout) ||
                !Number.isInteger(timeout) || timeout <= 0 ||
                timeout > 600_000
              ) {
                errors.push({
                  path: `functions.${fnName}.execution.timeout_ms`,
                  message:
                    'execution.timeout_ms must be a positive integer of milliseconds (max 600000)',
                });
              }
            }
          }
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

  if (manifest.skills !== undefined) {
    if (
      typeof manifest.skills !== 'object' || manifest.skills === null ||
      Array.isArray(manifest.skills)
    ) {
      errors.push({
        path: 'skills',
        message: 'skills must be an object',
      });
    } else {
      const skills = manifest.skills as Record<string, unknown>;
      for (const [skillId, skillDef] of Object.entries(skills)) {
        const skillPath = `skills.${skillId}`;
        if (!skillId.trim()) {
          errors.push({
            path: 'skills',
            message: 'skill ids must be non-empty strings',
          });
        }
        if (
          !skillDef || typeof skillDef !== 'object' || Array.isArray(skillDef)
        ) {
          errors.push({
            path: skillPath,
            message: 'skill definition must be an object',
          });
          continue;
        }

        const skill = skillDef as Record<string, unknown>;
        if (!skill.description || typeof skill.description !== 'string') {
          errors.push({
            path: `${skillPath}.description`,
            message: 'description is required',
          });
        }
        for (
          const field of [
            'name',
            'semantic_description',
            'preview',
            'resource',
          ]
        ) {
          if (skill[field] !== undefined && typeof skill[field] !== 'string') {
            errors.push({
              path: `${skillPath}.${field}`,
              message: `${field} must be a string`,
            });
          }
        }
        if (
          skill.format !== undefined && skill.format !== 'markdown' &&
          skill.format !== 'text'
        ) {
          errors.push({
            path: `${skillPath}.format`,
            message: 'format must be "markdown" or "text"',
          });
        }
      }
    }
  }

  if (manifest.access_policy !== undefined) {
    validateManifestAccessPolicy(manifest.access_policy, errors);
  }

  validateManifestExternalFunctions(manifest.external_functions, errors);
  validateManifestImports(manifest.imports, errors);
  if (manifest.emits !== undefined) {
    if (
      !Array.isArray(manifest.emits) ||
      manifest.emits.some((t) => typeof t !== 'string' || !t.trim())
    ) {
      errors.push({
        path: 'emits',
        message: 'emits must be an array of non-empty topic strings',
      });
    }
  }

  if (
    manifest.env !== undefined &&
    (typeof manifest.env !== 'object' || manifest.env === null ||
      Array.isArray(manifest.env))
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
  validateManifestInterfaces(
    manifest.interfaces,
    functionsForWidgetValidation,
    errors,
    warnings,
  );
  validateManifestHttp(manifest.http, functionsForWidgetValidation, errors);
  validateManifestRoutines(
    manifest.routines,
    functionsForWidgetValidation,
    errors,
    warnings,
  );
  const allowedNetworkHosts = validateManifestNetwork(manifest.network, errors);

  const rawEnvVars = {
    ...((manifest.env && typeof manifest.env === 'object' &&
        !Array.isArray(manifest.env))
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
      errors.push({
        path: `env_vars.${key}`,
        message: 'env var entry must be an object',
      });
      continue;
    }

    const envVar = value as Record<string, unknown>;

    if (
      envVar.scope !== undefined && envVar.scope !== 'universal' &&
      envVar.scope !== 'per_user'
    ) {
      errors.push({
        path: `env_vars.${key}.scope`,
        message: 'scope must be "universal" or "per_user"',
      });
    }

    if (
      envVar.type !== undefined && envVar.type !== 'universal' &&
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

    validateEnvCredential(
      envVar.credential,
      `env_vars.${key}.credential`,
      allowedNetworkHosts,
      errors,
    );
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
