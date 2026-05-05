export type DesktopEnvironment = 'development' | 'staging' | 'production';

export interface DesktopEnvSource {
  readonly DEV?: boolean;
  readonly PROD?: boolean;
  readonly MODE?: string;
  readonly VITE_UL_ENVIRONMENT?: string;
  readonly VITE_UL_API_BASE?: string;
}

const DEVELOPMENT_FALLBACK_API_BASE = 'https://ultralight-api.rgn4jz429m.workers.dev';

const PINNED_API_BASES: Record<Exclude<DesktopEnvironment, 'development'>, string> = {
  production: 'https://ultralight-api.rgn4jz429m.workers.dev',
  staging: 'https://ultralight-api-staging.rgn4jz429m.workers.dev',
};

function normalizeEnvironment(raw: string | undefined): DesktopEnvironment | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;

  switch (value) {
    case 'dev':
    case 'development':
      return 'development';
    case 'stage':
    case 'staging':
      return 'staging';
    case 'prod':
    case 'production':
      return 'production';
    default:
      return null;
  }
}

function normalizeApiBase(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  const url = new URL(value);
  return url.origin;
}

export function resolveDesktopEnvironment(env: DesktopEnvSource): {
  environment: DesktopEnvironment;
  apiBase: string;
} {
  const rawEnvironment = env.VITE_UL_ENVIRONMENT;
  const normalizedEnvironment = normalizeEnvironment(rawEnvironment);

  if (rawEnvironment && !normalizedEnvironment) {
    throw new Error(
      `[env] Unsupported VITE_UL_ENVIRONMENT "${rawEnvironment}". Expected development, staging, or production.`,
    );
  }

  const environment = normalizedEnvironment ?? (env.PROD ? 'production' : 'development');
  const requestedApiBase = normalizeApiBase(env.VITE_UL_API_BASE);

  if (environment === 'development') {
    return {
      environment,
      // Use the direct Worker origin in local dev so desktop auth/chat still work
      // if the production custom domain is temporarily misrouted at the edge.
      apiBase: requestedApiBase || DEVELOPMENT_FALLBACK_API_BASE,
    };
  }

  const pinnedApiBase = PINNED_API_BASES[environment];
  if (requestedApiBase && requestedApiBase !== pinnedApiBase) {
    throw new Error(
      `[env] ${environment} builds must use ${pinnedApiBase}. Received ${requestedApiBase}.`,
    );
  }

  return {
    environment,
    apiBase: pinnedApiBase,
  };
}

const resolvedDesktopEnvironment = resolveDesktopEnvironment(import.meta.env);

export const DESKTOP_ENVIRONMENT = resolvedDesktopEnvironment.environment;
export const DESKTOP_API_BASE = resolvedDesktopEnvironment.apiBase;
