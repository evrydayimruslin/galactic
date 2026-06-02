import {
  LAUNCH_API_ROUTES,
  LAUNCH_PUBLIC_ROUTES,
  type LaunchApiRoute,
  type LaunchPublicRoute,
} from '../../../../shared/contracts/launch.ts';

export type LaunchRouteKey =
  | 'home'
  | 'install'
  | 'library'
  | 'discover'
  | 'tool'
  | 'wallet'
  | 'settings'
  | 'adminTool';

export interface LaunchRouteDefinition {
  key: LaunchRouteKey;
  path: LaunchPublicRoute;
  label: string;
  nav: 'primary' | 'account' | 'hidden';
  apiRoutes: LaunchApiRoute[];
}

export interface ResolvedLaunchRoute {
  definition: LaunchRouteDefinition;
  params: Record<string, string>;
}

export const launchRoutes: LaunchRouteDefinition[] = [
  {
    key: 'home',
    path: '/',
    label: 'Home',
    nav: 'primary',
    apiRoutes: [
      'GET /api/launch/status',
      'GET /api/launch/openapi.json',
      'GET /api/launch/install',
      'GET /api/launch/platform-primitives',
    ],
  },
  {
    key: 'install',
    path: '/install',
    label: 'Install',
    nav: 'primary',
    apiRoutes: [
      'GET /api/launch/install',
      'GET /api/launch/status',
      'GET /api/launch/openapi.json',
    ],
  },
  {
    key: 'library',
    path: '/library',
    label: 'Library',
    nav: 'primary',
    apiRoutes: ['GET /api/launch/library'],
  },
  {
    key: 'discover',
    path: '/discover',
    label: 'Discover',
    nav: 'primary',
    apiRoutes: ['GET /api/launch/discover', 'GET /api/launch/leaderboard'],
  },
  {
    key: 'tool',
    path: '/tools/:slug',
    label: 'Tool',
    nav: 'hidden',
    apiRoutes: [
      'GET /api/launch/tools/:id',
      'GET /api/launch/tools/:id/widgets',
    ],
  },
  {
    key: 'wallet',
    path: '/wallet',
    label: 'Wallet',
    nav: 'account',
    apiRoutes: ['GET /api/launch/wallet'],
  },
  {
    key: 'settings',
    path: '/settings',
    label: 'Settings',
    nav: 'account',
    apiRoutes: ['GET /api/launch/install'],
  },
  {
    key: 'adminTool',
    path: '/admin/tools/:id',
    label: 'Tool Admin',
    nav: 'hidden',
    apiRoutes: ['GET /api/launch/admin/tools/:id'],
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
  return launchRoutes.filter((route) => route.nav === 'primary');
}

export function accountRoutes(): LaunchRouteDefinition[] {
  return launchRoutes.filter((route) => route.nav === 'account');
}

export function launchRoutePaths(): readonly LaunchPublicRoute[] {
  return LAUNCH_PUBLIC_ROUTES;
}

export function launchApiRoutes(): readonly LaunchApiRoute[] {
  return LAUNCH_API_ROUTES;
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = normalizePath(pattern).split('/').filter(Boolean);
  const pathParts = normalizePath(pathname).split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];
    if (patternPart.startsWith(':')) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }
    if (patternPart !== pathPart) return null;
  }
  return params;
}
