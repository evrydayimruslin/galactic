import {
  LAUNCH_API_ROUTES,
  LAUNCH_PUBLIC_ROUTES,
  type LaunchApiRoute,
  type LaunchPublicRoute,
} from "../../../../shared/contracts/launch.ts";

export type LaunchRouteKey =
  | "home"
  | "library"
  | "store"
  | "agent"
  | "settings"
  | "adminAgent"
  | "authCallback"
  | "terms"
  | "privacy";

export type LaunchRoutePath = LaunchPublicRoute | "/auth/callback";

export interface LaunchRouteDefinition {
  key: LaunchRouteKey;
  path: LaunchRoutePath;
  label: string;
  nav: "primary" | "account" | "hidden";
  apiRoutes: LaunchApiRoute[];
}

export interface ResolvedLaunchRoute {
  definition: LaunchRouteDefinition;
  params: Record<string, string>;
}

export const launchRoutes: LaunchRouteDefinition[] = [
  {
    key: "home",
    path: "/",
    label: "Home",
    nav: "primary",
    apiRoutes: [
      "GET /api/launch/status",
      "GET /api/launch/openapi.json",
      "GET /api/launch/install",
      "GET /api/launch/platform-primitives",
    ],
  },
  {
    key: "store",
    path: "/browse",
    label: "Browse",
    nav: "hidden",
    apiRoutes: ["GET /api/launch/store", "GET /api/launch/leaderboard"],
  },
  {
    key: "library",
    path: "/agents",
    label: "Agents",
    nav: "primary",
    apiRoutes: ["GET /api/launch/library"],
  },
  {
    key: "agent",
    path: "/agents/:slug",
    label: "Agent",
    nav: "hidden",
    apiRoutes: [
      "GET /api/launch/agents/:id",
      "GET /api/launch/agents/:id/functions",
      "POST /api/launch/agents/:id/functions/:functionName/run",
      "POST /api/launch/agents/:id/install",
      "DELETE /api/launch/agents/:id/install",
      "GET /api/launch/agents/:id/caller-permissions",
      "PATCH /api/launch/agents/:id/caller-permissions",
      "GET /api/launch/agents/:id/function-inference",
      "PUT /api/launch/agents/:id/function-inference",
      "DELETE /api/launch/agents/:id/function-inference",
      "GET /api/launch/agents/:id/settings",
      "PUT /api/launch/agents/:id/settings",
      "GET /api/launch/agents/:id/wiring",
      "GET /api/launch/agents/:id/caller-trust",
      "GET /api/launch/grants",
      "POST /api/launch/grants",
      "PATCH /api/launch/grants/:id",
      "POST /api/launch/grants/:id/approve",
      "DELETE /api/launch/grants/:id",
      "GET /api/launch/wiring/targets",
    ],
  },
  {
    key: "settings",
    path: "/account",
    label: "Profile",
    nav: "account",
    apiRoutes: [
      "GET /api/launch/wallet",
      "GET /api/launch/wallet/transactions",
      "GET /api/launch/wallet/receipts",
      "GET /api/launch/wallet/earnings",
      "GET /api/launch/wallet/payouts",
      "GET /api/launch/wallet/topup/quote",
      "POST /api/launch/wallet/topup/intent",
      "GET /api/launch/api-keys",
      "POST /api/launch/api-keys",
      "DELETE /api/launch/api-keys/:id",
      "GET /api/launch/byok",
      "PUT /api/launch/byok/:provider",
      "DELETE /api/launch/byok/:provider",
      "POST /api/launch/byok/primary",
      "PUT /api/launch/platform-model",
      "GET /api/launch/inference-options",
      "GET /api/launch/agents/:id/caller-permissions",
      "PATCH /api/launch/agents/:id/caller-permissions",
      "GET /api/launch/settings",
      "PATCH /api/launch/settings",
    ],
  },
  {
    key: "adminAgent",
    path: "/admin/agents/:id",
    label: "Agent admin",
    nav: "hidden",
    apiRoutes: [
      "GET /api/launch/admin/agents/:id",
      "GET /api/launch/agents/:id/functions",
      "POST /api/launch/agents/:id/functions/:functionName/run",
      "GET /api/launch/agents/:id/caller-permissions",
      "PATCH /api/launch/agents/:id/caller-permissions",
    ],
  },
  {
    key: "authCallback",
    path: "/auth/callback",
    label: "Auth callback",
    nav: "hidden",
    apiRoutes: [],
  },
  {
    key: "terms",
    path: "/terms",
    label: "Terms of Service",
    nav: "hidden",
    apiRoutes: [],
  },
  {
    key: "privacy",
    path: "/privacy",
    label: "Privacy Policy",
    nav: "hidden",
    apiRoutes: [],
  },
];

export function resolveLaunchRoute(pathname: string): ResolvedLaunchRoute {
  const cleanPath = normalizePath(pathname);
  for (const route of launchRoutes) {
    const match = matchRoute(route.path, cleanPath);
    if (match) return { definition: route, params: match };
  }
  return { definition: launchRoutes[0], params: {} };
}

export function primaryRoutes(): LaunchRouteDefinition[] {
  return launchRoutes.filter((route) => route.nav === "primary");
}

export function accountRoutes(): LaunchRouteDefinition[] {
  return launchRoutes.filter((route) => route.nav === "account");
}

export function launchRoutePaths(): readonly LaunchPublicRoute[] {
  return LAUNCH_PUBLIC_ROUTES;
}

export function launchApiRoutes(): readonly LaunchApiRoute[] {
  return LAUNCH_API_ROUTES;
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const cleanPath = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  // Library -> Agents, Store -> Browse, and the merged Wallet+Settings ->
  // Account rename. Legacy inbound paths stay routable for one compatibility
  // window (mirrors LAUNCH_COMPATIBILITY_PUBLIC_ROUTES).
  if (cleanPath === "/discover" || cleanPath === "/store") return "/browse";
  if (cleanPath === "/library") return "/agents";
  if (cleanPath === "/wallet" || cleanPath === "/settings") return "/account";
  // The Install page is retired — the add-to-agent flow is now a modal opened
  // from the "Add to agent" button. Legacy /install links fall back to home.
  if (cleanPath === "/install") return "/";
  // Tools -> Agents rename: legacy inbound paths stay routable for one
  // compatibility window (mirrors LAUNCH_COMPATIBILITY_PUBLIC_ROUTES).
  if (cleanPath.startsWith("/tools/")) {
    return `/agents/${cleanPath.slice("/tools/".length)}`;
  }
  if (cleanPath.startsWith("/admin/tools/")) {
    return `/admin/agents/${cleanPath.slice("/admin/tools/".length)}`;
  }
  return cleanPath;
}

function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = normalizePath(pattern).split("/").filter(Boolean);
  const pathParts = normalizePath(pathname).split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (patternPart !== pathPart) return null;
  }
  return params;
}
