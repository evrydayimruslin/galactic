type RuntimeEnvShape = {
  BASE_URL?: string;
  ENVIRONMENT?: string;
  CORS_ALLOWED_ORIGINS?: string;
};

export interface CorsConfigInput {
  baseUrl?: string | null;
  environment?: string | null;
  allowedOrigins?: string | readonly string[] | null;
}

export interface RouteCorsPolicyInput {
  origins?: readonly string[] | null;
  credentials?: boolean | null;
  headers?: readonly string[] | null;
  methods?: readonly string[] | null;
  maxAgeSeconds?: number | null;
}

const DEFAULT_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_ALLOW_HEADERS = "Content-Type, Authorization, X-Requested-With";
const PREFLIGHT_MAX_AGE_SECONDS = "86400";
const LOCAL_DEV_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5178",
  "http://127.0.0.1:5178",
] as const;

function normalizeOrigin(origin: string | null | undefined): string | null {
  if (!origin) return null;
  const trimmed = origin.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function readRuntimeCorsConfig(): CorsConfigInput {
  const runtimeEnv =
    (globalThis as typeof globalThis & { __env?: RuntimeEnvShape }).__env;
  if (runtimeEnv) {
    return {
      baseUrl: runtimeEnv.BASE_URL ?? null,
      environment: runtimeEnv.ENVIRONMENT ?? null,
      allowedOrigins: runtimeEnv.CORS_ALLOWED_ORIGINS ?? null,
    };
  }

  const denoEnv = (globalThis as typeof globalThis & {
    Deno?: { env?: { get(key: string): string | undefined } };
  }).Deno?.env;
  if (!denoEnv?.get) return {};

  return {
    baseUrl: denoEnv.get("BASE_URL") ?? null,
    environment: denoEnv.get("ENVIRONMENT") ?? null,
    allowedOrigins: denoEnv.get("CORS_ALLOWED_ORIGINS") ?? null,
  };
}

function appendOrigin(
  set: Set<string>,
  origin: string | null | undefined,
): void {
  const normalized = normalizeOrigin(origin);
  if (normalized) {
    set.add(normalized);
  }
}

export function resolveAllowedCorsOrigins(
  config: CorsConfigInput = readRuntimeCorsConfig(),
): string[] {
  const allowed = new Set<string>();

  const configuredOrigins = Array.isArray(config.allowedOrigins)
    ? config.allowedOrigins
    : String(config.allowedOrigins || "").split(",");

  for (const origin of configuredOrigins) {
    appendOrigin(allowed, origin);
  }

  appendOrigin(allowed, config.baseUrl);

  const environment = (config.environment || "").trim().toLowerCase();
  if (environment !== "production") {
    for (const origin of LOCAL_DEV_ALLOWED_ORIGINS) {
      allowed.add(origin);
    }
  }

  return Array.from(allowed);
}

function buildBaseCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Methods": DEFAULT_ALLOW_METHODS,
    "Access-Control-Allow-Headers": DEFAULT_ALLOW_HEADERS,
  };
}

function normalizeHeaderName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function joinUniqueCsv(values: readonly string[]): string {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized.join(", ");
}

function normalizeRouteMethod(value: string | null | undefined): string | null {
  if (!value) return null;
  const method = value.trim().toUpperCase();
  return method || null;
}

function resolveRouteAllowMethods(
  policy?: RouteCorsPolicyInput | null,
): string[] {
  const methods = (policy?.methods || [])
    .map((method) => normalizeRouteMethod(method))
    .filter((method): method is string => !!method);
  if (methods.length === 0) {
    return DEFAULT_ALLOW_METHODS.split(",").map((method) => method.trim());
  }

  const withOptions = methods.includes("OPTIONS")
    ? methods
    : [...methods, "OPTIONS"];
  return [...new Set(withOptions)];
}

function resolveRouteAllowHeaders(
  policy?: RouteCorsPolicyInput | null,
): string[] {
  const defaultHeaders = DEFAULT_ALLOW_HEADERS.split(",")
    .map((header) => normalizeHeaderName(header))
    .filter((header): header is string => !!header);
  const policyHeaders = (policy?.headers || [])
    .map((header) => normalizeHeaderName(header))
    .filter((header): header is string => !!header);
  return [...defaultHeaders, ...policyHeaders];
}

function buildRouteBaseCorsHeaders(
  policy?: RouteCorsPolicyInput | null,
): Record<string, string> {
  return {
    "Access-Control-Allow-Methods": joinUniqueCsv(
      resolveRouteAllowMethods(policy),
    ),
    "Access-Control-Allow-Headers": joinUniqueCsv(
      resolveRouteAllowHeaders(policy),
    ),
  };
}

function appendVaryHeader(headers: Headers, value: string): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", value);
    return;
  }

  const parts = existing
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.includes(value)) {
    parts.push(value);
    headers.set("Vary", parts.join(", "));
  }
}

export function isCorsOriginAllowed(
  requestOrigin: string | null | undefined,
  config: CorsConfigInput = readRuntimeCorsConfig(),
): boolean {
  const normalized = normalizeOrigin(requestOrigin);
  if (!normalized) return true;
  return resolveAllowedCorsOrigins(config).includes(normalized);
}

export function buildCorsHeaders(
  request: Request,
  config: CorsConfigInput = readRuntimeCorsConfig(),
): Record<string, string> {
  const origin = normalizeOrigin(request.headers.get("Origin"));
  const headers = buildBaseCorsHeaders();

  if (!origin) {
    return headers;
  }

  if (!isCorsOriginAllowed(origin, config)) {
    return headers;
  }

  return {
    ...headers,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
  };
}

export function isRouteCorsOriginAllowed(
  requestOrigin: string | null | undefined,
  policy?: RouteCorsPolicyInput | null,
  config: CorsConfigInput = readRuntimeCorsConfig(),
): boolean {
  const origin = normalizeOrigin(requestOrigin);
  if (!origin) return true;

  if (!policy?.origins) {
    return isCorsOriginAllowed(origin, config);
  }

  const allowedOrigins = policy.origins
    .map((allowed) => allowed === "*" ? "*" : normalizeOrigin(allowed))
    .filter((allowed): allowed is string => !!allowed);
  return allowedOrigins.includes("*") || allowedOrigins.includes(origin);
}

export function isRouteCorsMethodAllowed(
  requestedMethod: string | null | undefined,
  policy?: RouteCorsPolicyInput | null,
): boolean {
  const method = normalizeRouteMethod(requestedMethod);
  if (!method || method === "OPTIONS") return true;
  if (!policy?.methods || policy.methods.length === 0) return true;
  return policy.methods
    .map((allowed) => normalizeRouteMethod(allowed))
    .includes(method);
}

export function buildRouteCorsHeaders(
  request: Request,
  policy?: RouteCorsPolicyInput | null,
  config: CorsConfigInput = readRuntimeCorsConfig(),
): Record<string, string> {
  const origin = normalizeOrigin(request.headers.get("Origin"));
  const headers = buildRouteBaseCorsHeaders(policy);

  if (!origin) {
    return headers;
  }

  if (!isRouteCorsOriginAllowed(origin, policy, config)) {
    return headers;
  }

  const credentials = policy?.credentials ??
    (policy?.origins && policy.origins.length > 0 ? false : true);
  const allowsWildcard = policy?.origins?.includes("*") === true;
  const allowOrigin = allowsWildcard && !credentials ? "*" : origin;

  return {
    ...headers,
    "Access-Control-Allow-Origin": allowOrigin,
    ...(credentials ? { "Access-Control-Allow-Credentials": "true" } : {}),
  };
}

export function applyCorsHeaders(
  headers: Headers,
  request: Request,
  config: CorsConfigInput = readRuntimeCorsConfig(),
): void {
  appendVaryHeader(headers, "Origin");

  for (
    const [key, value] of Object.entries(buildCorsHeaders(request, config))
  ) {
    headers.set(key, value);
  }
}

export function applyRouteCorsHeaders(
  headers: Headers,
  request: Request,
  policy?: RouteCorsPolicyInput | null,
  config: CorsConfigInput = readRuntimeCorsConfig(),
): void {
  appendVaryHeader(headers, "Origin");
  headers.delete("Access-Control-Allow-Origin");
  headers.delete("Access-Control-Allow-Credentials");

  for (
    const [key, value] of Object.entries(
      buildRouteCorsHeaders(request, policy, config),
    )
  ) {
    headers.set(key, value);
  }
}

export function buildCorsPreflightResponse(
  request: Request,
  config: CorsConfigInput = readRuntimeCorsConfig(),
): Response {
  const headers = new Headers();
  applyCorsHeaders(headers, request, config);
  headers.set("Access-Control-Max-Age", PREFLIGHT_MAX_AGE_SECONDS);

  const origin = normalizeOrigin(request.headers.get("Origin"));
  if (origin && !isCorsOriginAllowed(origin, config)) {
    return new Response(null, { status: 403, headers });
  }

  return new Response(null, { status: 204, headers });
}

export function buildRouteCorsPreflightResponse(
  request: Request,
  policy?: RouteCorsPolicyInput | null,
  config: CorsConfigInput = readRuntimeCorsConfig(),
): Response {
  const headers = new Headers();
  applyRouteCorsHeaders(headers, request, policy, config);
  headers.set(
    "Access-Control-Max-Age",
    String(policy?.maxAgeSeconds ?? Number(PREFLIGHT_MAX_AGE_SECONDS)),
  );

  const origin = normalizeOrigin(request.headers.get("Origin"));
  if (origin && !isRouteCorsOriginAllowed(origin, policy, config)) {
    return new Response(null, { status: 403, headers });
  }

  const requestedMethod = request.headers.get("Access-Control-Request-Method");
  if (!isRouteCorsMethodAllowed(requestedMethod, policy)) {
    headers.set("Allow", joinUniqueCsv(resolveRouteAllowMethods(policy)));
    return new Response(null, { status: 405, headers });
  }

  return new Response(null, { status: 204, headers });
}
