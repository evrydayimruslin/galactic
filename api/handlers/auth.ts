// Auth Handler
// Handles authentication via Supabase Google OAuth and API tokens

import { error, json } from './response.ts';
import { isApiToken } from '../services/tokens.ts';
import { createProvisionalUser, isProvisionalUser, mergeProvisionalUser, markOnboardingProvisionalCreated, type MergeMethod } from '../services/provisional.ts';
import {
  consumeDesktopOAuthSession,
  createDesktopOAuthSession,
  storeDesktopOAuthSessionToken,
} from '../services/desktop-oauth-sessions.ts';
import {
  appendAuthSessionCookies,
  clearAuthSessionCookies,
  getAuthAccessTokenFromRequest,
  getAuthRefreshTokenFromRequest,
  getCookieValueFromRequest,
} from '../services/auth-cookies.ts';
import {
  authenticateRequest,
  type AuthenticatedRequestUser,
  ensureUserExists,
  extractBearerToken,
  hasScope,
  verifySupabaseAccessToken,
} from '../services/request-auth.ts';
import { logLegacyAuthTransport } from '../services/auth-transport.ts';
import {
  consumeEmbedBridgeToken,
  getAccessTokenRemainingLifetimeSeconds,
  issueEmbedBridgeToken,
} from '../services/embed-bridge.ts';
import { appendPageShareSessionCookie } from '../services/page-share-session.ts';
import { normalizeOAuthPrompt } from '../services/oauth-login.ts';
import { revokeSupabaseSession } from '../services/session-revocation.ts';
import {
  claimReferralLandingsForUser,
  claimReferralTokenForUser,
  REFERRAL_VISITOR_COOKIE_NAME,
  transferReferralAttributionBetweenUsers,
} from '../services/referrals.ts';
import { withAuthRouteRateLimit } from '../services/auth-rate-limit.ts';
import {
  RequestValidationError,
  validateEmbedBridgeExchangeRequest,
  validatePageShareExchangeRequest,
  validateRefreshRequest,
  validateSessionBootstrapRequest,
  validateSignoutRequest,
} from '../services/auth-request-validation.ts';
// Base64 URL encoding for PKCE (replaces Deno std encodeBase64Url)
function encodeBase64Url(data: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...data));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
import { getEnv } from '../lib/env.ts';


// PKCE helpers
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return encodeBase64Url(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return encodeBase64Url(new Uint8Array(digest));
}

function getSupabaseAuthHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'apikey': (getEnv('SUPABASE_ANON_KEY') || getEnv('SUPABASE_SERVICE_ROLE_KEY')),
  };
}

async function exchangeRefreshToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const tokenResponse = await fetch(
    `${getEnv('SUPABASE_URL')}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: getSupabaseAuthHeaders(),
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );

  if (!tokenResponse.ok) {
    throw new Error('Token refresh failed');
  }

  return await tokenResponse.json();
}

function appendBrowserSession(
  response: Response,
  session: {
    accessToken: string;
    refreshToken?: string | null;
    accessTokenTtlSeconds?: number | null;
  },
): Response {
  appendAuthSessionCookies(response.headers, session);
  return response;
}

async function claimReferralCookieForUser(request: Request, userId: string): Promise<void> {
  const visitorId = getCookieValueFromRequest(request, REFERRAL_VISITOR_COOKIE_NAME);
  if (!visitorId) return;
  try {
    await claimReferralLandingsForUser({ userId, anonymousVisitorId: visitorId });
  } catch (err) {
    console.warn('[auth] Failed to claim referral landings:', err);
  }
}

async function claimReferralCookieForAccessToken(
  request: Request,
  accessToken: string,
): Promise<void> {
  const verifiedUser = await verifySupabaseAccessToken(accessToken);
  if (!verifiedUser) return;
  await ensureUserExists(verifiedUser).catch(() => {});
  await claimReferralCookieForUser(request, verifiedUser.id);
}

export async function handleAuth(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Initiate Google OAuth - redirects to Supabase Auth with PKCE
  if (path === '/auth/login') {
    return withAuthRouteRateLimit(request, 'auth:login', async () => {
      // Force HTTPS — DigitalOcean terminates TLS at load balancer so request.url is HTTP internally
      const origin = url.origin.replace('http://', 'https://');
      const returnTo = url.searchParams.get('return_to');
      const desktopSession = url.searchParams.get('desktop_session');
      const desktopPollSecretHash = url.searchParams.get('desktop_poll_secret_hash');
      const oauthPrompt = normalizeOAuthPrompt(url.searchParams.get('prompt'));

      if (desktopSession) {
        try {
          await createDesktopOAuthSession(desktopSession, desktopPollSecretHash);
        } catch (err) {
          console.error('[auth] Failed to create desktop OAuth session:', err);
          return new Response(getCallbackErrorHTML('Unable to start desktop sign-in. Please try again.'), {
            headers: { 'Content-Type': 'text/html' },
          });
        }
      }

      // Generate PKCE code verifier and challenge (S256)
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);

      // Embed verifier in callback URL so it survives the redirect chain
      const callbackParams = new URLSearchParams();
      callbackParams.set('v', codeVerifier);
      if (returnTo) callbackParams.set('return_to', returnTo);
      if (desktopSession) callbackParams.set('desktop_session', desktopSession);
      const callbackUrl = `${origin}/auth/callback?${callbackParams.toString()}`;

      const authUrl = new URL(`${getEnv('SUPABASE_URL')}/auth/v1/authorize`);
      authUrl.searchParams.set('provider', 'google');
      authUrl.searchParams.set('redirect_to', callbackUrl);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      if (oauthPrompt) {
        authUrl.searchParams.set('prompt', oauthPrompt);
      }

      return new Response(null, {
        status: 302,
        headers: { 'Location': authUrl.toString() },
      });
    });
  }

  // Google OAuth callback - handle token from hash or code exchange
  if (path === '/auth/callback') {
    // Check for explicit error first
    const errorDesc = url.searchParams.get('error_description');
    if (errorDesc) {
      return new Response(getCallbackErrorHTML(errorDesc), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const code = url.searchParams.get('code');

    if (code) {
      // Read PKCE code_verifier from query param (embedded in redirect_to URL)
      const codeVerifier = url.searchParams.get('v') || '';

      // Exchange code + verifier for tokens (Supabase PKCE grant)
      const tokenResponse = await fetch(`${getEnv('SUPABASE_URL')}/auth/v1/token?grant_type=pkce`, {
        method: 'POST',
        headers: getSupabaseAuthHeaders(),
        body: JSON.stringify({
          auth_code: code,
          code_verifier: codeVerifier,
        }),
      });

      if (tokenResponse.ok) {
        const tokens = await tokenResponse.json() as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };
        const desktopSession = url.searchParams.get('desktop_session');
        await claimReferralCookieForAccessToken(request, tokens.access_token);

        // Desktop OAuth flow: store token for polling, show "close this tab" page
        if (desktopSession) {
          const stored = await storeDesktopOAuthSessionToken(desktopSession, tokens.access_token);
          if (!stored) {
            return new Response(getCallbackErrorHTML('Desktop sign-in expired. Please return to the app and try again.'), {
              headers: { 'Content-Type': 'text/html' },
            });
          }
          return new Response(getDesktopCallbackHTML(), {
            headers: { 'Content-Type': 'text/html' },
          });
        }

        const returnTo = url.searchParams.get('return_to') || undefined;
        return appendBrowserSession(new Response(getCallbackSuccessHTML(returnTo), {
          headers: { 'Content-Type': 'text/html' },
        }), {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          accessTokenTtlSeconds: tokens.expires_in,
        });
      }

      // Code exchange failed — show error with full details for debugging
      let errBody = '';
      try { errBody = await tokenResponse.text(); } catch {}
      console.error('[auth] Code exchange failed:', tokenResponse.status, errBody);
      const hasVerifier = codeVerifier ? 'yes (' + codeVerifier.length + ' chars)' : 'MISSING';
      let supabaseError = '';
      try { const parsed = JSON.parse(errBody); supabaseError = parsed.error_description || parsed.msg || parsed.error || ''; } catch { supabaseError = errBody.substring(0, 200); }
      return new Response(getCallbackErrorHTML('Code exchange failed (status ' + tokenResponse.status + ', verifier: ' + hasVerifier + '). Supabase says: ' + supabaseError), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // No code param — return HTML that handles hash-based implicit tokens (fallback)
    return new Response(getCallbackHTML(), {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  }

  // Get current user from JWT
  if (path === '/auth/user') {
    try {
      const user = await authenticate(request);
      return json(user);
    } catch {
      return json({ user: null });
    }
  }

  // Establish a browser session into HttpOnly cookies.
  if (path === '/auth/session' && request.method === 'POST') {
    return withAuthRouteRateLimit(request, 'auth:session', async () => {
      try {
        const payload = await validateSessionBootstrapRequest(request);
        let accessToken = payload.accessToken || '';
        let refreshToken = payload.refreshToken || '';
        let expiresIn: number | undefined;

        if (accessToken || refreshToken) {
          logLegacyAuthTransport({
            kind: 'body_token_bootstrap',
            surface: 'browser_session_bootstrap',
            request,
            token: accessToken || refreshToken,
            note: accessToken ? 'access_token_body' : 'refresh_token_body',
          });
        }

        let verifiedUser = accessToken ? await verifySupabaseAccessToken(accessToken) : null;
        if (!verifiedUser && refreshToken) {
          const refreshed = await exchangeRefreshToken(refreshToken);
          accessToken = refreshed.access_token;
          refreshToken = refreshed.refresh_token || refreshToken;
          expiresIn = refreshed.expires_in;
          verifiedUser = await verifySupabaseAccessToken(accessToken);
        }

        if (!verifiedUser || !accessToken) {
          return error('Invalid or expired session tokens', 401);
        }

        await ensureUserExists(verifiedUser).catch(() => {});
        await claimReferralCookieForUser(request, verifiedUser.id);

        return appendBrowserSession(json({ ok: true }), {
          accessToken,
          refreshToken,
          accessTokenTtlSeconds: expiresIn,
        });
      } catch (err) {
        if (err instanceof RequestValidationError) {
          return error(err.message, err.status);
        }
        console.error('[auth] Session establishment failed:', err);
        return error('Failed to establish session', 500);
      }
    });
  }

  // Create a short-lived opaque bridge token for desktop embed flows.
  if (path === '/auth/embed/bridge' && request.method === 'POST') {
    return withAuthRouteRateLimit(request, 'auth:embed_bridge', async () => {
      const accessToken = extractBearerToken(request);
      if (!accessToken || isApiToken(accessToken)) {
        return error('Desktop embed bridge requires a signed-in user token', 401);
      }

      const verifiedUser = await verifySupabaseAccessToken(accessToken);
      if (!verifiedUser) {
        return error('Invalid or expired session token', 401);
      }

      const remainingLifetime = getAccessTokenRemainingLifetimeSeconds(accessToken);
      if (remainingLifetime !== null && remainingLifetime <= 0) {
        return error('Session token is expired', 401);
      }

      const issued = await issueEmbedBridgeToken({
        accessToken,
        userId: verifiedUser.id,
      });

      return json({
        bridge_token: issued.token,
        expires_in: issued.expiresIn,
        audience: 'desktop_embed',
        transport: 'fragment',
      });
    });
  }

  // Exchange a desktop embed bridge token into the cookie session context used by embedded pages.
  if (path === '/auth/embed/exchange' && request.method === 'POST') {
    return withAuthRouteRateLimit(request, 'auth:embed_exchange', async () => {
      try {
        const { bridgeToken } = await validateEmbedBridgeExchangeRequest(request);

        const bridgePayload = await consumeEmbedBridgeToken(bridgeToken);
        if (!bridgePayload) {
          return error('Invalid or expired bridge token', 401);
        }

        const verifiedUser = await verifySupabaseAccessToken(bridgePayload.access_token);
        if (!verifiedUser || verifiedUser.id !== bridgePayload.sub) {
          return error('Bridge token session is invalid', 401);
        }

        await ensureUserExists(verifiedUser).catch(() => {});
        await claimReferralCookieForUser(request, verifiedUser.id);

        const accessTokenTtlSeconds = getAccessTokenRemainingLifetimeSeconds(bridgePayload.access_token);
        return appendBrowserSession(json({
          ok: true,
          expires_in: accessTokenTtlSeconds ?? null,
          audience: bridgePayload.aud,
        }), {
          accessToken: bridgePayload.access_token,
          accessTokenTtlSeconds: accessTokenTtlSeconds ?? undefined,
        });
      } catch (err) {
        if (err instanceof RequestValidationError) {
          return error(err.message, err.status);
        }
        console.error('[auth] Embed bridge exchange failed:', err);
        return error('Failed to establish embed session', 500);
      }
    });
  }

  // Exchange a shared-page secret into a short-lived page-scoped session cookie.
  if (path === '/auth/page-share/exchange' && request.method === 'POST') {
    return withAuthRouteRateLimit(request, 'auth:page_share_exchange', async () => {
      try {
        const { ownerId, slug, shareToken } = await validatePageShareExchangeRequest(request);
        const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
        const contentResponse = await fetch(
          `${getEnv('SUPABASE_URL')}/rest/v1/content?owner_id=eq.${ownerId}&type=eq.page&slug=eq.${encodeURIComponent(slug)}&visibility=eq.shared&select=id,access_token&limit=1`,
          {
            headers: {
              'apikey': serviceRoleKey,
              'Authorization': `Bearer ${serviceRoleKey}`,
            },
          },
        );

        if (!contentResponse.ok) {
          console.error('[auth] Shared page lookup failed:', await contentResponse.text());
          return error('Failed to authorize shared page', 500);
        }

        const rows = await contentResponse.json() as Array<{ id: string; access_token: string | null }>;
        const contentRow = rows[0];
        if (!contentRow) {
          return error('Shared page not found', 404);
        }
        if (!contentRow.access_token || shareToken !== contentRow.access_token) {
          return error('Invalid or expired shared page token', 401);
        }

        const response = new Response(null, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        });
        const issued = await appendPageShareSessionCookie(response.headers, {
          contentId: contentRow.id,
          ownerId,
          slug,
          accessToken: shareToken,
        });
        response.headers.set('Content-Type', 'application/json');
        return new Response(JSON.stringify({
          ok: true,
          expires_in: issued.expiresIn,
          audience: 'shared_page',
          page_path: `/p/${ownerId}/${slug}`,
        }), {
          status: 200,
          headers: response.headers,
        });
      } catch (err) {
        if (err instanceof RequestValidationError) {
          return error(err.message, err.status);
        }
        console.error('[auth] Shared page exchange failed:', err);
        return error('Failed to authorize shared page', 500);
      }
    });
  }

  // Sign out - revokes the current Supabase session when possible, then clears cookies.
  if (path === '/auth/signout') {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { 'Allow': 'POST' },
      });
    }

    return withAuthRouteRateLimit(request, 'auth:signout', async () => {
      try {
        await validateSignoutRequest(request);
        const accessToken = extractBearerToken(request) || getAuthAccessTokenFromRequest(request);
        await revokeSupabaseSession(accessToken, 'local');
        const response = json({ ok: true });
        clearAuthSessionCookies(response.headers);
        return response;
      } catch (err) {
        if (err instanceof RequestValidationError) {
          return error(err.message, err.status);
        }
        console.error('[auth] Sign-out revocation failed:', err);
        const response = json({ error: 'Failed to revoke session' }, 502);
        clearAuthSessionCookies(response.headers);
        return response;
      }
    });
  }

  // Refresh token - exchange refresh_token for a new access_token.
  // Body-based refresh remains for non-cookie clients; cookie refresh powers browser sessions.
  if (path === '/auth/refresh' && request.method === 'POST') {
    return withAuthRouteRateLimit(request, 'auth:refresh', async () => {
      try {
        const payload = await validateRefreshRequest(request);
        const bodyRefreshToken = payload.refreshToken || '';
        const refreshToken = bodyRefreshToken || getAuthRefreshTokenFromRequest(request);

        if (bodyRefreshToken) {
          logLegacyAuthTransport({
            kind: 'body_token_bootstrap',
            surface: 'refresh_body_bootstrap',
            request,
            token: bodyRefreshToken,
            note: 'refresh_token_body',
          });
        }

        if (!refreshToken) {
          return error('Missing refresh_token', 400);
        }

        const tokens = await exchangeRefreshToken(refreshToken);
        const response = json({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
        });
        appendAuthSessionCookies(response.headers, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || refreshToken,
          accessTokenTtlSeconds: tokens.expires_in,
        });
        return response;
      } catch (err) {
        if (err instanceof RequestValidationError) {
          return error(err.message, err.status);
        }
        return error('Token refresh failed', 500);
      }
    });
  }

  // Create provisional user (no auth required) — pre-auth onboarding
  if (path === '/auth/provisional' && request.method === 'POST') {
    try {
      const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
        || request.headers.get('x-real-ip')
        || '0.0.0.0';

      console.log(`[AUTH] Provisional request from IP: ${clientIp}`);
      const result = await createProvisionalUser(clientIp);
      console.log(`[AUTH] Provisional user created: ${result.id}, token_id: ${result.tokenId}`);

      // Correlate with onboarding template request (fire-and-forget)
      markOnboardingProvisionalCreated(clientIp);

      return json({
        user_id: result.id,
        token: result.token,
        token_id: result.tokenId,
        provisional: true,
        limits: {
          daily_calls: 50,
          storage_mb: 5,
          memory: false,
          inactivity_expiry_hours: 24,
        },
      });
    } catch (err: any) {
      console.error(`[AUTH] Provisional creation failed:`, err.message, err.status);
      if (err.status === 429) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (err.status === 503) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      console.error('[AUTH] Provisional creation failed:', err);
      return error('Failed to create provisional account', 500);
    }
  }

  // Merge provisional user into authenticated account (JWT auth required)
  if (path === '/auth/merge' && request.method === 'POST') {
    return withAuthRouteRateLimit(request, 'auth:merge', async () => {
      try {
        const user = await authenticate(request);
        const body = await request.json() as {
          provisional_user_id?: string;
          merge_method?: string;
        };
        const provisionalUserId = body.provisional_user_id;
        const mergeMethod = (body.merge_method || 'api_merge') as MergeMethod;

        if (!provisionalUserId) {
          return error('Missing provisional_user_id', 400);
        }

        // Verify provisional user exists and is actually provisional
        if (!await isProvisionalUser(provisionalUserId)) {
          return error('Not a provisional user', 400);
        }

        // Prevent self-merge
        if (provisionalUserId === user.id) {
          return error('Cannot merge into self', 400);
        }

        await transferReferralAttributionBetweenUsers(provisionalUserId, user.id).catch((err) => {
          console.warn('[auth] Failed to transfer provisional referral attribution:', err);
        });
        const result = await mergeProvisionalUser(provisionalUserId, user.id, mergeMethod);
        await claimReferralCookieForUser(request, user.id);
        return json({ success: true, merged: result });
      } catch (err: any) {
        console.error('[AUTH] Merge failed:', err);
        return error(err.message || 'Merge failed', 500);
      }
    });
  }

  // Redeem a browser-to-desktop referral claim token.
  if (path === '/auth/referral-claim' && request.method === 'POST') {
    try {
      let user: AuthenticatedRequestUser;
      try {
        user = await authenticate(request);
      } catch {
        return error('Unauthorized', 401);
      }
      const body = await request.json() as { claim_token?: unknown };
      const claimToken = typeof body.claim_token === 'string' ? body.claim_token : '';
      if (!claimToken) {
        return error('Missing claim_token', 400);
      }

      const result = await claimReferralTokenForUser(claimToken, user.id);
      return json({
        ok: true,
        claimed_landing_count: result.claimedLandingCount,
        grant_ids: result.grantIds,
      });
    } catch (err) {
      console.error('[AUTH] Referral claim failed:', err);
      return error('Failed to claim referral', 500);
    }
  }

  // Desktop OAuth polling — desktop app polls this after opening browser for Google OAuth
  if (path === '/auth/desktop-poll' && request.method === 'GET') {
    return withAuthRouteRateLimit(request, 'auth:desktop-poll', async () => {
      const sessionId = url.searchParams.get('session_id');
      if (!sessionId) {
        return error('Missing session_id', 400);
      }

      const pollSecret = url.searchParams.get('session_secret');
      const token = await consumeDesktopOAuthSession(sessionId, pollSecret);
      if (token) {
        return json({ status: 'complete', token });
      }
      return json({ status: 'pending' });
    });
  }

  return error('Auth endpoint not found', 404);
}

/**
 * Extract and verify JWT or API token from request
 * Also ensures user exists in public.users table
 */
export const authenticate = authenticateRequest;

/**
 * Get user ID from request, or throw if not authenticated
 */
export async function getUserId(request: Request): Promise<string> {
  const user = await authenticate(request);
  return user.id;
}

/**
 * Ensure user exists in public.users table
 * Uses direct REST API to bypass any client library issues
 */

// Callback page HTML - handles Supabase's hash-based token return
// and stores it in HttpOnly cookies via POST /auth/session.
function getCallbackHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Signing in...</title>
  <style>
    body { font-family: system-ui; background: #fff; color: #0a0a0a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { text-align: center; max-width: 500px; padding: 20px; }
    .spinner { width: 40px; height: 40px; border: 3px solid #e5e5e5; border-top-color: #0a0a0a; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 1rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .debug { font-size: 11px; color: #999; margin-top: 20px; word-break: break-all; text-align: left; }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <p id="status">Signing you in...</p>
    <div id="debug" class="debug"></div>
  </div>
  <script>
    var debugEl = document.getElementById('debug');
    var statusEl = document.getElementById('status');

    // Supabase implicit flow returns tokens in URL hash
    var hash = window.location.hash.substring(1);
    var params = new URLSearchParams(hash);
    var accessToken = params.get('access_token');
    var refreshToken = params.get('refresh_token');

    var queryParams = new URLSearchParams(window.location.search);
    var returnTo = queryParams.get('return_to');
    var redirectTarget = (returnTo && returnTo.startsWith('/')) ? returnTo : '/';

    if (accessToken) {
      statusEl.textContent = 'Finalizing sign-in...';
      fetch('/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          access_token: accessToken,
          refresh_token: refreshToken
        })
      }).then(function(res) {
        if (!res.ok) throw new Error('session_failed');
        window.location.href = redirectTarget;
      }).catch(function() {
        statusEl.textContent = 'Authentication failed. Please try again.';
        debugEl.textContent = 'We could not establish a browser session.';
      });
    } else {
      var error = queryParams.get('error_description');
      if (error) {
        var safe = error.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
        document.body.innerHTML = '<div class="container"><p style="color: #ef4444;">Error: ' + safe + '</p><a href="/" style="color: #0a0a0a;">Go back</a></div>';
      } else {
        statusEl.textContent = 'No token received. Waiting 3s then retrying...';
        // Wait a moment — sometimes the hash is set after page load
        setTimeout(function() {
          var retryHash = window.location.hash.substring(1);
          var retryParams = new URLSearchParams(retryHash);
          var retryToken = retryParams.get('access_token');
          if (retryToken) {
            var retryRefresh = retryParams.get('refresh_token');
            fetch('/auth/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({
                access_token: retryToken,
                refresh_token: retryRefresh
              })
            }).then(function(res) {
              if (!res.ok) throw new Error('session_failed');
              window.location.href = redirectTarget;
            }).catch(function() {
              statusEl.textContent = 'Authentication failed. Please try again.';
              debugEl.textContent = 'We could not establish a browser session.';
            });
          } else {
            statusEl.textContent = 'Authentication failed. No tokens found.';
            document.body.innerHTML += '<div style="text-align:center;margin-top:20px;"><a href="/" style="color:#0a0a0a;">Go back</a> &nbsp; <a href="/auth/login" style="color:#0a0a0a;">Try again</a></div>';
          }
        }, 3000);
      }
    }
  </script>
</body>
</html>`;
}

function getCallbackSuccessHTML(returnTo?: string): string {
  // Validate return_to is a relative path (prevent open redirect)
  const redirectTarget = (returnTo && returnTo.startsWith('/')) ? returnTo : '/';
  const safeRedirect = redirectTarget.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3c');
  return `<!DOCTYPE html>
<html>
<head><title>Signed in!</title></head>
<body>
  <script>
    // Check for provisional user to merge (same-device path)
    var provUserId = localStorage.getItem('ultralight_provisional_user_id');
    if (provUserId) {
      fetch('/auth/merge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'same-origin',
        body: JSON.stringify({ provisional_user_id: provUserId, merge_method: 'oauth_callback' })
      }).then(function() {
        localStorage.removeItem('ultralight_provisional_token_id');
        localStorage.removeItem('ultralight_provisional_user_id');
        localStorage.removeItem('ultralight_setup_v3');
        window.location.href = '${safeRedirect}';
      }).catch(function() {
        // Merge failed — proceed anyway (user still gets authenticated)
        localStorage.removeItem('ultralight_provisional_token_id');
        localStorage.removeItem('ultralight_provisional_user_id');
        window.location.href = '${safeRedirect}';
      });
    } else {
      window.location.href = '${safeRedirect}';
    }
  </script>
</body>
</html>`;
}

function getDesktopCallbackHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Signed in!</title>
  <style>
    body { font-family: system-ui; background: #fff; color: #0a0a0a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { text-align: center; max-width: 400px; padding: 20px; }
    .checkmark { font-size: 48px; margin-bottom: 16px; }
    p { color: #666; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">&#10003;</div>
    <h2>Signed in to Ultralight</h2>
    <p>You can close this tab and return to the desktop app.</p>
  </div>
</body>
</html>`;
}

function getCallbackErrorHTML(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Sign in failed</title>
  <style>
    body { font-family: system-ui; background: #fff; color: #0a0a0a; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { text-align: center; }
    a { color: #0a0a0a; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <p style="color: #ef4444;">Error: ${message}</p>
    <a href="/">Go back</a>
  </div>
</body>
</html>`;
}
