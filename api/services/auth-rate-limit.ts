import { checkRateLimit, type RateLimitResult } from './ratelimit.ts';

export type AuthRateLimitRoute =
  | 'auth:login'
  | 'auth:session'
  | 'auth:refresh'
  | 'auth:merge'
  | 'auth:embed_bridge'
  | 'auth:embed_exchange'
  | 'auth:launch_exchange'
  | 'auth:page_share_exchange'
  | 'auth:signout'
  | 'auth:desktop-poll'
  | 'oauth:register'
  | 'oauth:authorize'
  | 'oauth:token'
  | 'oauth:revoke'
  | 'oauth:callback_complete'
  | 'oauth:consent_approve'
  | 'oauth:consent_deny';

type AuthRateLimitKeySource = 'ip' | 'session_id';
type AuthRateLimitResponseKind = 'json' | 'oauth_json' | 'html';

interface AuthRateLimitPolicy {
  endpoint: string;
  limit: number;
  windowMinutes: number;
  keySource: AuthRateLimitKeySource;
  responseKind: AuthRateLimitResponseKind;
  resource: string;
  limitMessage: string;
  unavailableMessage: string;
}

export const AUTH_ROUTE_RATE_LIMITS: Record<AuthRateLimitRoute, AuthRateLimitPolicy> = {
  'auth:login': {
    endpoint: 'auth:login',
    limit: 20,
    windowMinutes: 10,
    keySource: 'ip',
    responseKind: 'html',
    resource: '/auth/login',
    limitMessage: 'Too many sign-in attempts. Please wait a few minutes and try again.',
    unavailableMessage: 'Sign-in is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'auth:session': {
    endpoint: 'auth:session',
    limit: 20,
    windowMinutes: 5,
    keySource: 'ip',
    responseKind: 'json',
    resource: '/auth/session',
    limitMessage: 'Too many session bootstrap attempts. Please wait and try again.',
    unavailableMessage: 'Session bootstrap is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'auth:refresh': {
    endpoint: 'auth:refresh',
    limit: 30,
    windowMinutes: 5,
    keySource: 'ip',
    responseKind: 'json',
    resource: '/auth/refresh',
    limitMessage: 'Too many session refresh attempts. Please wait and try again.',
    unavailableMessage: 'Session refresh is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'auth:merge': {
    endpoint: 'auth:merge',
    limit: 10,
    windowMinutes: 10,
    keySource: 'ip',
    responseKind: 'json',
    resource: '/auth/merge',
    limitMessage: 'Too many account merge attempts. Please wait and try again.',
    unavailableMessage: 'Account merge is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'auth:embed_bridge': {
    endpoint: 'auth:embed_bridge',
    limit: 60,
    windowMinutes: 5,
    keySource: 'ip',
    responseKind: 'json',
    resource: '/auth/embed/bridge',
    limitMessage: 'Too many desktop embed bridge requests. Please wait and try again.',
    unavailableMessage: 'Desktop embed bridge is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'auth:embed_exchange': {
    endpoint: 'auth:embed_exchange',
    limit: 60,
    windowMinutes: 5,
    keySource: 'ip',
    responseKind: 'json',
    resource: '/auth/embed/exchange',
    limitMessage: 'Too many desktop embed session exchanges. Please wait and try again.',
    unavailableMessage: 'Desktop embed session exchange is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'auth:launch_exchange': {
    endpoint: 'auth:launch_exchange',
    limit: 60,
    windowMinutes: 5,
    keySource: 'ip',
    responseKind: 'json',
    resource: '/auth/launch/exchange',
    limitMessage: 'Too many launch web sign-in exchanges. Please wait and try again.',
    unavailableMessage: 'Launch web sign-in exchange is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'auth:page_share_exchange': {
    endpoint: 'auth:page_share_exchange',
    limit: 60,
    windowMinutes: 10,
    keySource: 'ip',
    responseKind: 'json',
    resource: '/auth/page-share/exchange',
    limitMessage: 'Too many shared page authorization attempts. Please wait and try again.',
    unavailableMessage: 'Shared page authorization is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'auth:signout': {
    endpoint: 'auth:signout',
    limit: 20,
    windowMinutes: 5,
    keySource: 'ip',
    responseKind: 'json',
    resource: '/auth/signout',
    limitMessage: 'Too many sign-out attempts. Please wait and try again.',
    unavailableMessage: 'Sign-out is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'auth:desktop-poll': {
    endpoint: 'auth:desktop-poll',
    limit: 300,
    windowMinutes: 5,
    keySource: 'session_id',
    responseKind: 'json',
    resource: '/auth/desktop-poll',
    limitMessage: 'Too many desktop sign-in polling requests. Please wait and try again.',
    unavailableMessage: 'Desktop sign-in polling is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'oauth:register': {
    endpoint: 'oauth:register',
    limit: 20,
    windowMinutes: 60,
    keySource: 'ip',
    responseKind: 'oauth_json',
    resource: '/oauth/register',
    limitMessage: 'Too many OAuth client registration attempts. Please wait and try again.',
    unavailableMessage: 'OAuth client registration is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'oauth:authorize': {
    endpoint: 'oauth:authorize',
    limit: 30,
    windowMinutes: 10,
    keySource: 'ip',
    responseKind: 'html',
    resource: '/oauth/authorize',
    limitMessage: 'Too many OAuth authorization attempts. Please wait and try again.',
    unavailableMessage: 'OAuth authorization is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'oauth:token': {
    endpoint: 'oauth:token',
    limit: 30,
    windowMinutes: 10,
    keySource: 'ip',
    responseKind: 'oauth_json',
    resource: '/oauth/token',
    limitMessage: 'Too many OAuth token exchange attempts. Please wait and try again.',
    unavailableMessage: 'OAuth token exchange is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'oauth:revoke': {
    endpoint: 'oauth:revoke',
    limit: 30,
    windowMinutes: 10,
    keySource: 'ip',
    responseKind: 'oauth_json',
    resource: '/oauth/revoke',
    limitMessage: 'Too many OAuth revocation attempts. Please wait and try again.',
    unavailableMessage: 'OAuth revocation is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'oauth:callback_complete': {
    endpoint: 'oauth:callback_complete',
    limit: 30,
    windowMinutes: 10,
    keySource: 'ip',
    responseKind: 'oauth_json',
    resource: '/oauth/callback/complete',
    limitMessage: 'Too many OAuth callback completion attempts. Please wait and try again.',
    unavailableMessage: 'OAuth callback completion is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'oauth:consent_approve': {
    endpoint: 'oauth:consent_approve',
    limit: 20,
    windowMinutes: 10,
    keySource: 'ip',
    responseKind: 'html',
    resource: '/oauth/consent/approve',
    limitMessage: 'Too many OAuth consent approval attempts. Please wait and try again.',
    unavailableMessage: 'OAuth consent approval is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
  'oauth:consent_deny': {
    endpoint: 'oauth:consent_deny',
    limit: 20,
    windowMinutes: 10,
    keySource: 'ip',
    responseKind: 'html',
    resource: '/oauth/consent/deny',
    limitMessage: 'Too many OAuth consent denial attempts. Please wait and try again.',
    unavailableMessage: 'OAuth consent denial is temporarily unavailable while auth protections recover. Please try again shortly.',
  },
};

interface AuthRateLimitOptions {
  limit?: number;
  windowMinutes?: number;
}

function getPolicy(
  route: AuthRateLimitRoute,
  options?: AuthRateLimitOptions,
): AuthRateLimitPolicy & { limit: number; windowMinutes: number } {
  const policy = AUTH_ROUTE_RATE_LIMITS[route];
  return {
    ...policy,
    limit: options?.limit ?? policy.limit,
    windowMinutes: options?.windowMinutes ?? policy.windowMinutes,
  };
}

export function getAuthRateLimitClientIp(request: Request): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || null;
}

export function resolveAuthRateLimitKey(
  request: Request,
  route: AuthRateLimitRoute,
): string {
  const policy = AUTH_ROUTE_RATE_LIMITS[route];
  const url = new URL(request.url);

  if (policy.keySource === 'session_id') {
    const sessionId = url.searchParams.get('session_id')?.trim();
    if (sessionId) return sessionId;
  }

  return getAuthRateLimitClientIp(request) || 'anonymous';
}

function getRetryAfterSeconds(resetAt: Date): string {
  const seconds = Math.ceil((resetAt.getTime() - Date.now()) / 1000);
  return String(Math.max(1, seconds));
}

export function buildAuthRateLimitHeaders(
  route: AuthRateLimitRoute,
  result: RateLimitResult,
  options?: AuthRateLimitOptions,
): Record<string, string> {
  const policy = getPolicy(route, options);
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(policy.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.floor(result.resetAt.getTime() / 1000)),
  };

  if (!result.allowed) {
    headers['Retry-After'] = getRetryAfterSeconds(result.resetAt);
  }

  return headers;
}

export function applyAuthRateLimitHeaders(
  response: Response,
  route: AuthRateLimitRoute,
  result: RateLimitResult,
  options?: AuthRateLimitOptions,
): Response {
  const headers = buildAuthRateLimitHeaders(route, result, options);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

function buildRateLimitHtml(title: string, message: string, resetAt: Date): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
    .card { max-width: 480px; width: 100%; background:#141414; border:1px solid #262626; border-radius:16px; padding:24px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    p { color:#b4b4b4; line-height:1.5; margin: 0 0 10px; }
    .muted { color:#888; font-size:13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="muted">Try again after ${resetAt.toISOString()}.</p>
  </div>
</body>
</html>`;
}

export function buildAuthRateLimitResponse(
  route: AuthRateLimitRoute,
  result: RateLimitResult,
  options?: AuthRateLimitOptions,
): Response {
  const policy = getPolicy(route, options);
  const blockedByServiceFailure = result.reason === 'service_unavailable';
  const status = blockedByServiceFailure ? 503 : 429;
  const message = blockedByServiceFailure ? policy.unavailableMessage : policy.limitMessage;
  const headers = buildAuthRateLimitHeaders(route, result, options);

  if (policy.responseKind === 'oauth_json') {
    return new Response(JSON.stringify({
      error: 'temporarily_unavailable',
      error_description: message,
      reset_at: result.resetAt.toISOString(),
    }), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    });
  }

  if (policy.responseKind === 'html') {
    return new Response(buildRateLimitHtml('Too Many Requests', message, result.resetAt), {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...headers,
      },
    });
  }

  return new Response(JSON.stringify({
    error: message,
    resetAt: result.resetAt.toISOString(),
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

export async function enforceAuthRouteRateLimit(
  request: Request,
  route: AuthRateLimitRoute,
  options?: AuthRateLimitOptions,
): Promise<{ result: RateLimitResult; response: Response | null }> {
  const policy = getPolicy(route, options);
  const rateLimitKey = resolveAuthRateLimitKey(request, route);
  const result = await checkRateLimit(
    rateLimitKey,
    policy.endpoint,
    policy.limit,
    policy.windowMinutes,
    {
      mode: 'fail_closed',
      resource: policy.resource,
    },
  );

  if (result.allowed) {
    return { result, response: null };
  }

  return {
    result,
    response: buildAuthRateLimitResponse(route, result, options),
  };
}

export async function withAuthRouteRateLimit(
  request: Request,
  route: AuthRateLimitRoute,
  handler: () => Promise<Response> | Response,
  options?: AuthRateLimitOptions,
): Promise<Response> {
  const { result, response } = await enforceAuthRouteRateLimit(request, route, options);
  if (response) {
    return response;
  }

  return applyAuthRateLimitHeaders(await handler(), route, result, options);
}
