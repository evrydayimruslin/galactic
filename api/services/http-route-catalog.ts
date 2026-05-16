import type { App } from "../../shared/types/index.ts";
import type {
  ManifestHttpAuthMode,
  ManifestHttpBillingMode,
  ManifestHttpDataScope,
  ManifestHttpMethod,
} from "../../shared/contracts/manifest.ts";
import { listManifestHttpRoutes } from "./http-policy.ts";
import { validateHttpRouteExecutionPolicy } from "./http-execution-policy.ts";

const ALL_HTTP_ROUTE_METHODS: ManifestHttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
];

export interface HttpRouteCatalogIssue {
  type: "INVALID_HTTP_ROUTE_POLICY" | "HTTP_ROUTE_UNSUPPORTED";
  message: string;
  status: number;
}

export interface HttpRouteCatalogEntry {
  function_name: string;
  path: string;
  url: string | null;
  auth: ManifestHttpAuthMode;
  public: boolean;
  requires_auth: boolean;
  billing: ManifestHttpBillingMode;
  data_scope: ManifestHttpDataScope;
  methods: ManifestHttpMethod[];
  allows_any_method: boolean;
  cors: {
    origins?: string[];
    credentials: boolean;
    headers?: string[];
    max_age_seconds?: number;
  } | null;
  rate_limit: {
    rpm?: number;
    burst?: number;
    daily?: number;
  } | null;
  executable: boolean;
  issue: HttpRouteCatalogIssue | null;
}

type HttpRouteCatalogApp = Pick<
  App,
  "id" | "owner_id" | "runtime" | "manifest"
>;

export interface BuildHttpRouteCatalogOptions {
  baseUrl?: string | null;
  auth?: ManifestHttpAuthMode;
}

export function getRequestBaseUrl(request: Request): string {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]
    ?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]
    ?.trim();
  const host = forwardedHost || request.headers.get("host") || url.host;
  const proto = forwardedProto || url.protocol.replace(/:$/, "") || "https";
  return `${proto}://${host}`;
}

function normalizeBaseUrl(baseUrl?: string | null): string | null {
  if (!baseUrl) return null;
  return baseUrl.replace(/\/+$/, "");
}

function buildHttpRoutePath(appId: string, functionName: string): string {
  return `/http/${encodeURIComponent(appId)}/${
    encodeURIComponent(functionName)
  }`;
}

export function buildHttpRouteCatalog(
  app: HttpRouteCatalogApp,
  options: BuildHttpRouteCatalogOptions = {},
): HttpRouteCatalogEntry[] {
  const baseUrl = normalizeBaseUrl(options.baseUrl);

  return listManifestHttpRoutes(app)
    .filter((route) => !options.auth || route.auth === options.auth)
    .map((route) => {
      const path = buildHttpRoutePath(app.id, route.functionName);
      const issue = validateHttpRouteExecutionPolicy(route, app);
      const methods = route.methods
        ? [...route.methods]
        : [...ALL_HTTP_ROUTE_METHODS];

      return {
        function_name: route.functionName,
        path,
        url: baseUrl ? `${baseUrl}${path}` : null,
        auth: route.auth,
        public: route.auth === "public",
        requires_auth: route.auth !== "public",
        billing: route.billing,
        data_scope: route.dataScope,
        methods,
        allows_any_method: route.methods === null,
        cors: route.cors
          ? {
            origins: route.cors.origins ? [...route.cors.origins] : undefined,
            credentials: route.cors.credentials,
            headers: route.cors.headers ? [...route.cors.headers] : undefined,
            max_age_seconds: route.cors.maxAgeSeconds,
          }
          : null,
        rate_limit: route.rateLimit ? { ...route.rateLimit } : null,
        executable: !issue,
        issue: issue ? { ...issue } : null,
      };
    });
}

export function formatHttpRouteCatalogLine(
  route: HttpRouteCatalogEntry,
): string {
  const methodLabel = route.allows_any_method ? "ANY" : route.methods.join("|");
  const target = route.url || route.path;
  const authLabel = route.public ? "public" : "requires Ultralight auth";
  const billingLabel = route.billing === "owner"
    ? "owner-billed"
    : "caller-billed";
  const dataLabel = route.data_scope === "app"
    ? "app data scope"
    : "user data scope";
  const issueLabel = route.issue ? `; blocked: ${route.issue.message}` : "";

  return `- \`${methodLabel} ${target}\` — ${authLabel}, ${billingLabel}, ${dataLabel}${issueLabel}`;
}
