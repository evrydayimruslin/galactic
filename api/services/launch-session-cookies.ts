// Launch web session refresh cookie.
//
// The launch website (Cloudflare Pages) is a different origin from the API
// Worker, so its refresh credential must be a SameSite=None cookie — the
// shared auth-cookies.ts session cookies are SameSite=Lax and are never sent
// on cross-origin fetches from the Pages SPA. The access token itself stays a
// short-lived bearer in the SPA; only the refresh token lives in this
// HttpOnly cookie, which the browser presents exclusively to
// POST /auth/launch/refresh (fetch credentials: "include").
//
// __Host- prefix: Secure, no Domain, Path=/ — workers.dev is on the Public
// Suffix List, so sibling workers.dev subdomains cannot plant or shadow it.

const LAUNCH_REFRESH_COOKIE_NAME = '__Host-ul_launch_refresh';
const LAUNCH_REFRESH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function buildLaunchRefreshCookie(value: string, maxAgeSeconds: number): string {
  return [
    `${LAUNCH_REFRESH_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=None',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join('; ');
}

export function getLaunchRefreshTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() !== LAUNCH_REFRESH_COOKIE_NAME) continue;
    const value = part.slice(separatorIndex + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

export function appendLaunchRefreshCookie(headers: Headers, refreshToken: string): void {
  headers.append(
    'Set-Cookie',
    buildLaunchRefreshCookie(refreshToken, LAUNCH_REFRESH_COOKIE_MAX_AGE_SECONDS),
  );
}

export function clearLaunchRefreshCookie(headers: Headers): void {
  headers.append('Set-Cookie', buildLaunchRefreshCookie('', 0));
}
