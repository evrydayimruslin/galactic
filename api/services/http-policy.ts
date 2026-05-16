import type {
  AppManifest,
  ManifestHttpAuthMode,
  ManifestHttpBillingMode,
  ManifestHttpCorsPolicy,
  ManifestHttpDataScope,
  ManifestHttpMethod,
  ManifestHttpRateLimitPolicy,
  ManifestHttpRouteDefaults,
  ManifestHttpRoutePolicy,
} from '../../shared/contracts/manifest.ts';
import { parseAppManifest } from './app-settings.ts';

export const DEFAULT_PUBLIC_HTTP_RATE_LIMIT_RPM = 60;

export interface HttpPolicyAppLike {
  manifest?: AppManifest | string | null;
}

export interface ResolvedHttpCorsPolicy {
  origins?: string[];
  credentials: boolean;
  headers?: string[];
  maxAgeSeconds?: number;
}

export interface ResolvedHttpRateLimitPolicy {
  rpm?: number;
  burst?: number;
  daily?: number;
}

export interface ResolvedHttpRoutePolicy {
  declared: boolean;
  functionName: string;
  auth: ManifestHttpAuthMode;
  methods: ManifestHttpMethod[] | null;
  cors: ResolvedHttpCorsPolicy | null;
  rateLimit: ResolvedHttpRateLimitPolicy | null;
  billing: ManifestHttpBillingMode;
  dataScope: ManifestHttpDataScope;
}

function copyStringArray(values: string[] | undefined): string[] | undefined {
  return values ? [...values] : undefined;
}

function copyMethods(values: ManifestHttpMethod[] | undefined): ManifestHttpMethod[] | null {
  return values ? [...values] : null;
}

function mergeCorsPolicy(
  defaults?: ManifestHttpCorsPolicy,
  route?: ManifestHttpCorsPolicy,
): ResolvedHttpCorsPolicy | null {
  if (!defaults && !route) return null;
  const merged = { ...(defaults || {}), ...(route || {}) };
  return {
    origins: copyStringArray(merged.origins),
    credentials: merged.credentials ?? false,
    headers: copyStringArray(merged.headers),
    maxAgeSeconds: merged.max_age_seconds,
  };
}

function mergeRateLimitPolicy(
  auth: ManifestHttpAuthMode,
  defaults?: ManifestHttpRateLimitPolicy,
  route?: ManifestHttpRateLimitPolicy,
): ResolvedHttpRateLimitPolicy | null {
  const merged = { ...(defaults || {}), ...(route || {}) };
  if (auth === 'public' && merged.rpm === undefined) {
    merged.rpm = DEFAULT_PUBLIC_HTTP_RATE_LIMIT_RPM;
  }

  const hasPolicy = merged.rpm !== undefined ||
    merged.burst !== undefined ||
    merged.daily !== undefined;
  if (!hasPolicy) return null;
  return {
    rpm: merged.rpm,
    burst: merged.burst,
    daily: merged.daily,
  };
}

function resolveDeclaredRoutePolicy(
  functionName: string,
  defaults: ManifestHttpRouteDefaults,
  route: ManifestHttpRoutePolicy,
): ResolvedHttpRoutePolicy {
  const auth = route.auth ?? defaults.auth ?? 'user';
  const billing = route.billing ?? defaults.billing ?? (auth === 'public' ? 'owner' : 'caller');
  const dataScope = route.data_scope ?? defaults.data_scope ?? 'app';

  return {
    declared: true,
    functionName,
    auth,
    methods: copyMethods(route.methods ?? defaults.methods),
    cors: mergeCorsPolicy(defaults.cors, route.cors),
    rateLimit: mergeRateLimitPolicy(auth, defaults.rate_limit, route.rate_limit),
    billing,
    dataScope,
  };
}

function defaultAuthenticatedPolicy(functionName: string): ResolvedHttpRoutePolicy {
  return {
    declared: false,
    functionName,
    auth: 'user',
    methods: null,
    cors: null,
    rateLimit: null,
    billing: 'caller',
    dataScope: 'app',
  };
}

export function resolveHttpRoutePolicy(
  appOrManifest: HttpPolicyAppLike | AppManifest | string | null | undefined,
  functionName: string,
): ResolvedHttpRoutePolicy {
  const manifest = typeof appOrManifest === 'object' && appOrManifest !== null &&
      'manifest' in appOrManifest
    ? parseAppManifest(appOrManifest.manifest)
    : parseAppManifest(appOrManifest);
  const route = manifest?.http?.routes?.[functionName];

  if (!route) {
    return defaultAuthenticatedPolicy(functionName);
  }

  return resolveDeclaredRoutePolicy(functionName, manifest.http?.defaults || {}, route);
}

export function listManifestHttpRoutes(
  appOrManifest: HttpPolicyAppLike | AppManifest | string | null | undefined,
): ResolvedHttpRoutePolicy[] {
  const manifest = typeof appOrManifest === 'object' && appOrManifest !== null &&
      'manifest' in appOrManifest
    ? parseAppManifest(appOrManifest.manifest)
    : parseAppManifest(appOrManifest);
  const routes = manifest?.http?.routes;
  if (!routes) return [];

  const defaults = manifest?.http?.defaults || {};
  return Object.entries(routes)
    .map(([functionName, route]) => resolveDeclaredRoutePolicy(functionName, defaults, route))
    .sort((a, b) => a.functionName.localeCompare(b.functionName));
}
