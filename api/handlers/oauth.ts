// OAuth 2.1 Handler for MCP Spec Compliance
// Implements RFC 9728 (Protected Resource Metadata), OAuth Authorization Server Metadata,
// Dynamic Client Registration (RFC 7591), Authorization Code + PKCE flow.
//
// This wraps Galactic's existing Supabase Google OAuth + ul_ token system
// into the standard OAuth 2.1 shape that MCP clients (Claude Desktop, etc.) expect.

import { json, error } from './response.ts';
import { createToken, revokeByToken } from '../services/tokens.ts';
import { authenticate } from './auth.ts';
import { hasScope } from '../services/request-auth.ts';
import { createUserService } from '../services/user.ts';
import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../lib/env.ts';
import { withAuthRouteRateLimit } from '../services/auth-rate-limit.ts';
import {
  RequestValidationError,
  validateAuthorizeQuery,
  validateDynamicClientRegistrationRequest,
  validateOAuthRevocationRequest,
  validateOAuthTokenExchangeRequest,
} from '../services/auth-request-validation.ts';

// Lazy Supabase client — CF Workers env not available at module init
let _supabase: ReturnType<typeof createClient>;
function getSupabase() {
  if (!_supabase) _supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'));
  return _supabase;
}

interface OAuthClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  owner_user_id: string | null;
  client_secret_hash: string | null;
  client_secret_salt: string | null;
  logo_url: string | null;
  description: string | null;
  is_developer_app: boolean | null;
}

interface OAuthConsentRow {
  scopes: string[] | null;
}

interface OAuthAuthorizationCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  supabase_access_token: string;
  supabase_refresh_token: string | null;
  user_id: string;
  user_email: string;
  scope: string;
  created_at: string;
}

interface SupabaseAuthUser {
  id: string;
  email: string;
}

interface SupabaseTokenExchangeResponse {
  access_token: string;
  refresh_token?: string;
}

// The repo still lacks a shared generated Supabase schema, so isolated handlers
// can collapse query results to `never`. Keep the typing boundary local here
// until the broader schema work is done.
function oauthClientsTable() {
  return getSupabase().from('oauth_clients' as never) as any;
}

function oauthConsentsTable() {
  return getSupabase().from('oauth_consents' as never) as any;
}

function oauthAuthorizationCodesTable() {
  return getSupabase().from('oauth_authorization_codes' as never) as any;
}

// ============================================
// OAUTH CLIENT PERSISTENCE (Supabase)
// ============================================

interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
}

interface OAuthClientFull extends OAuthClient {
  owner_user_id?: string;
  client_secret_hash?: string;
  client_secret_salt?: string;
  logo_url?: string;
  description?: string;
  is_developer_app: boolean;
}

/**
 * Save an OAuth client to the database.
 */
async function saveOAuthClient(client: OAuthClient): Promise<void> {
  const { error: err } = await oauthClientsTable()
    .insert({
      client_id: client.client_id,
      client_name: client.client_name || null,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    });

  if (err) {
    console.error('Failed to save OAuth client:', err);
    throw new Error(`Failed to save OAuth client: ${err.message}`);
  }
}

/**
 * Look up an OAuth client by client_id from the database.
 */
async function getOAuthClient(clientId: string): Promise<OAuthClient | null> {
  const { data, error: err } = await oauthClientsTable()
    .select('client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method')
    .eq('client_id', clientId)
    .single();

  if (err || !data) return null;

  const client = data as OAuthClientRow;

  return {
    client_id: client.client_id,
    client_name: client.client_name || undefined,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
  };
}

/**
 * Look up full OAuth client including developer app fields.
 */
async function getOAuthClientFull(clientId: string): Promise<OAuthClientFull | null> {
  const { data, error: err } = await oauthClientsTable()
    .select('client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, owner_user_id, client_secret_hash, client_secret_salt, logo_url, description, is_developer_app')
    .eq('client_id', clientId)
    .single();

  if (err || !data) return null;

  const client = data as OAuthClientRow;

  return {
    client_id: client.client_id,
    client_name: client.client_name || undefined,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    owner_user_id: client.owner_user_id || undefined,
    client_secret_hash: client.client_secret_hash || undefined,
    client_secret_salt: client.client_secret_salt || undefined,
    logo_url: client.logo_url || undefined,
    description: client.description || undefined,
    is_developer_app: client.is_developer_app || false,
  };
}

/**
 * Get existing consent record for a user/client pair.
 */
async function getExistingConsent(userId: string, clientId: string): Promise<{ scopes: string[] } | null> {
  const { data, error: err } = await oauthConsentsTable()
    .select('scopes')
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .is('revoked_at', null)
    .single();

  if (err || !data) return null;
  return { scopes: ((data as OAuthConsentRow).scopes) || [] };
}

/**
 * Save or update consent record.
 */
async function saveConsent(userId: string, clientId: string, scopes: string[]): Promise<void> {
  await oauthConsentsTable()
    .upsert({
      user_id: userId,
      client_id: clientId,
      scopes,
      created_at: new Date().toISOString(),
      revoked_at: null,
    }, { onConflict: 'user_id,client_id' });
}

/**
 * Check if existing consent scopes satisfy the requested scopes.
 */
function scopesSatisfied(existingScopes: string[], requestedScopes: string[]): boolean {
  if (existingScopes.includes('*')) return true;
  return requestedScopes.every(s => existingScopes.includes(s));
}

// ============================================
// AUTHORIZATION CODES (persisted to Supabase)
// ============================================

interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  supabase_access_token: string;
  supabase_refresh_token?: string;
  user_id: string;
  user_email: string;
  scope: string;
  created_at: number;
}

/**
 * Save an authorization code to the database.
 * Codes auto-expire via the `expires_at` column (5 min from creation).
 */
async function saveAuthorizationCode(entry: AuthorizationCode): Promise<void> {
  // Encrypt Supabase tokens before storing — they're sensitive session credentials
  const encryptedAccessToken = await encryptToken(entry.supabase_access_token);
  const encryptedRefreshToken = entry.supabase_refresh_token
    ? await encryptToken(entry.supabase_refresh_token)
    : null;

  const { error: err } = await oauthAuthorizationCodesTable()
    .insert({
      code: entry.code,
      client_id: entry.client_id,
      redirect_uri: entry.redirect_uri,
      code_challenge: entry.code_challenge,
      code_challenge_method: entry.code_challenge_method,
      supabase_access_token: encryptedAccessToken,
      supabase_refresh_token: encryptedRefreshToken,
      user_id: entry.user_id,
      user_email: entry.user_email,
      scope: entry.scope,
    });
  if (err) {
    console.error('Failed to save authorization code:', err);
    throw new Error(`Failed to save authorization code: ${err.message}`);
  }
}

/**
 * Retrieve and atomically delete an authorization code (one-time use).
 * Returns null if the code doesn't exist or has expired.
 */
async function getAndDeleteAuthorizationCode(code: string): Promise<AuthorizationCode | null> {
  // Select the code (only if not expired)
  const { data, error: selectErr } = await oauthAuthorizationCodesTable()
    .select('*')
    .eq('code', code)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (selectErr || !data) return null;

  // Delete immediately (one-time use)
  await oauthAuthorizationCodesTable()
    .delete()
    .eq('code', code);

  // Decrypt Supabase tokens from the canonical encrypted format.
  const authCode = data as OAuthAuthorizationCodeRow;

  const accessToken = await decryptToken(authCode.supabase_access_token);
  const refreshToken = authCode.supabase_refresh_token
    ? await decryptToken(authCode.supabase_refresh_token)
    : undefined;

  return {
    code: authCode.code,
    client_id: authCode.client_id,
    redirect_uri: authCode.redirect_uri,
    code_challenge: authCode.code_challenge,
    code_challenge_method: authCode.code_challenge_method,
    supabase_access_token: accessToken,
    supabase_refresh_token: refreshToken,
    user_id: authCode.user_id,
    user_email: authCode.user_email,
    scope: authCode.scope,
    created_at: new Date(authCode.created_at).getTime(),
  };
}

/**
 * Clean up expired authorization codes from the database.
 * Called periodically to prevent stale rows from accumulating.
 */
async function cleanupExpiredCodes(): Promise<void> {
  try {
    await oauthAuthorizationCodesTable()
      .delete()
      .lt('expires_at', new Date().toISOString());
  } catch (err) {
    console.error('Failed to cleanup expired auth codes:', err);
  }
}

// Cleanup runs lazily when auth codes are checked (CF Workers don't allow setInterval at module scope)

// ============================================
// TOKEN ENCRYPTION (AES-256-GCM with per-record salt)
// ============================================

// Supabase access/refresh tokens stored in oauth_authorization_codes are encrypted at rest.
// Uses the same blob format as BYOK/envvars: [salt(16) + IV(12) + ciphertext].
const TOKEN_SALT_LENGTH = 16;
const TOKEN_IV_LENGTH = 12;

async function deriveTokenEncryptionKey(salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const normalizedSalt = Uint8Array.from(salt);
  // Domain-separated key derivation from the service role key
  const keyData = encoder.encode(`oauth-token-encryption:${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`);
  const keyMaterial = await crypto.subtle.importKey('raw', keyData, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: normalizedSalt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptToken(token: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(TOKEN_SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(TOKEN_IV_LENGTH));
  const key = await deriveTokenEncryptionKey(salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token)
  );
  const combined = new Uint8Array(TOKEN_SALT_LENGTH + TOKEN_IV_LENGTH + encrypted.byteLength);
  combined.set(salt);
  combined.set(iv, TOKEN_SALT_LENGTH);
  combined.set(new Uint8Array(encrypted), TOKEN_SALT_LENGTH + TOKEN_IV_LENGTH);
  return btoa(String.fromCharCode(...combined));
}

async function decryptToken(encryptedToken: string): Promise<string> {
  const combined = Uint8Array.from(atob(encryptedToken), c => c.charCodeAt(0));
  const salt = combined.slice(0, TOKEN_SALT_LENGTH);
  const iv = combined.slice(TOKEN_SALT_LENGTH, TOKEN_SALT_LENGTH + TOKEN_IV_LENGTH);
  const data = combined.slice(TOKEN_SALT_LENGTH + TOKEN_IV_LENGTH);
  const key = await deriveTokenEncryptionKey(salt);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

// ============================================
// STATE SIGNING (HMAC-SHA256)
// ============================================

// Derive a signing key from the Supabase service role key (always available, never exposed to clients).
// This prevents OAuth state forgery — attackers cannot craft valid state params without this key.
let _stateSigningKey: CryptoKey | null = null;

async function getStateSigningKey(): Promise<CryptoKey> {
  if (_stateSigningKey) return _stateSigningKey;
  const encoder = new TextEncoder();
  // Use a domain-separated derivation so the signing key differs from the raw service key
  const keyData = encoder.encode(`oauth-state-signing:${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`);
  _stateSigningKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  return _stateSigningKey;
}

/**
 * Sign an encoded OAuth state string. Returns "encodedState.signature".
 */
async function signState(encodedState: string): Promise<string> {
  const key = await getStateSigningKey();
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedState));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${encodedState}.${sigHex}`;
}

/**
 * Verify and extract a signed OAuth state string. Returns the encoded state or null if invalid.
 */
async function verifySignedState(signedState: string): Promise<string | null> {
  const dotIdx = signedState.lastIndexOf('.');
  if (dotIdx === -1) return null; // no signature present

  const encodedState = signedState.substring(0, dotIdx);
  const sigHex = signedState.substring(dotIdx + 1);

  // Decode hex signature
  const sigBytes = new Uint8Array(sigHex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(sigHex.substring(i * 2, i * 2 + 2), 16);
  }

  const key = await getStateSigningKey();
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(encodedState));
  return valid ? encodedState : null;
}

// ============================================
// HELPERS
// ============================================

function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  // Behind DigitalOcean + Cloudflare, internal requests arrive as http://
  // but the service is always accessed via https:// externally.
  // Use x-forwarded-proto if available, otherwise default to https for non-localhost.
  const proto = request.headers.get('x-forwarded-proto')
    || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyPKCE(codeVerifier: string, codeChallenge: string, method: string): Promise<boolean> {
  if (method === 'S256') {
    const hashed = await sha256(codeVerifier);
    const computed = base64UrlEncode(hashed);
    return computed === codeChallenge;
  }
  // plain method (not recommended but spec-legal)
  return codeVerifier === codeChallenge;
}

// Verify a Supabase JWT and get user info
async function verifySupabaseToken(accessToken: string): Promise<{ id: string; email: string } | null> {
  const res = await fetch(`${getEnv('SUPABASE_URL')}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': (getEnv('SUPABASE_ANON_KEY') || getEnv('SUPABASE_SERVICE_ROLE_KEY')),
    },
  });
  if (!res.ok) return null;
  const user = await res.json() as Partial<SupabaseAuthUser>;
  if (!user.id || !user.email) return null;
  return { id: user.id, email: user.email };
}

// ============================================
// MAIN ROUTER
// ============================================

export async function handleOAuth(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Protected Resource Metadata (RFC 9728)
  if (path === '/.well-known/oauth-protected-resource' && method === 'GET') {
    return handleProtectedResourceMetadata(request);
  }

  // Authorization Server Metadata
  if (path === '/.well-known/oauth-authorization-server' && method === 'GET') {
    return handleAuthorizationServerMetadata(request);
  }

  // Dynamic Client Registration (RFC 7591)
  if (path === '/oauth/register' && method === 'POST') {
    return withAuthRouteRateLimit(request, 'oauth:register', () => handleClientRegistration(request));
  }

  // Authorization endpoint
  if (path === '/oauth/authorize' && method === 'GET') {
    return withAuthRouteRateLimit(request, 'oauth:authorize', () => handleAuthorize(request));
  }

  // OAuth callback — internal, handles Supabase redirect back
  if (path === '/oauth/callback') {
    return handleOAuthCallback(request);
  }

  // Token endpoint
  if (path === '/oauth/token' && method === 'POST') {
    return withAuthRouteRateLimit(request, 'oauth:token', () => handleTokenExchange(request));
  }

  // Userinfo endpoint (OIDC-compatible)
  if (path === '/oauth/userinfo' && (method === 'GET' || method === 'POST')) {
    return handleUserinfo(request);
  }

  // Consent approval (POST from consent screen form)
  if (path === '/oauth/consent/approve' && method === 'POST') {
    return withAuthRouteRateLimit(request, 'oauth:consent_approve', () => handleConsentApprove(request));
  }

  // Consent denial
  if (path === '/oauth/consent/deny' && method === 'POST') {
    return withAuthRouteRateLimit(request, 'oauth:consent_deny', () => handleConsentDeny(request));
  }

  // Token revocation (RFC 7009)
  if (path === '/oauth/revoke' && method === 'POST') {
    return withAuthRouteRateLimit(request, 'oauth:revoke', () => handleTokenRevocation(request));
  }

  // Implicit flow completion (called from browser JS in the callback HTML)
  if (path === '/oauth/callback/complete' && method === 'POST') {
    return withAuthRouteRateLimit(request, 'oauth:callback_complete', () => handleOAuthCallbackComplete(request));
  }

  return error('OAuth endpoint not found', 404);
}

// ============================================
// USERINFO ENDPOINT (OIDC-compatible)
// ============================================

async function handleUserinfo(request: Request): Promise<Response> {
  let authResult: { id: string; email: string; scopes?: string[] };
  try {
    authResult = await authenticate(request);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer error="invalid_token"',
      },
    });
  }

  // Require user:read scope
  if (!hasScope(authResult.scopes, 'user:read')) {
    return new Response(JSON.stringify({ error: 'insufficient_scope' }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="user:read"',
      },
    });
  }

  // Fetch full profile
  const userService = createUserService();
  const profile = await userService.getUser(authResult.id);
  if (!profile) {
    return new Response(JSON.stringify({ error: 'user_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Build OIDC-compatible response
  const response: Record<string, unknown> = {
    sub: profile.id,
    name: profile.display_name || profile.email.split('@')[0],
    picture: profile.avatar_url || null,
  };

  // Only include email if user:email scope is present
  if (hasScope(authResult.scopes, 'user:email')) {
    response.email = profile.email;
    response.email_verified = true; // Google OAuth emails are always verified
  }

  return json(response);
}

// ============================================
// CONSENT FLOW
// ============================================

/**
 * Encrypt OAuth state + Supabase tokens into an opaque consent token.
 * Uses the same AES-256-GCM pattern as auth code encryption.
 */
async function encryptConsentToken(data: {
  supabase_access_token: string;
  supabase_refresh_token?: string;
  oauth_state: string; // signed state string
  user_id: string;
  user_email: string;
}): Promise<string> {
  return encryptToken(JSON.stringify(data));
}

async function decryptConsentToken(encrypted: string): Promise<{
  supabase_access_token: string;
  supabase_refresh_token?: string;
  oauth_state: string;
  user_id: string;
  user_email: string;
} | null> {
  try {
    const decrypted = await decryptToken(encrypted);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

/**
 * Check if consent is needed for a developer app. If so, render consent screen.
 * MCP dynamic clients auto-approve. Developer apps check existing consent.
 */
async function checkAndRenderConsent(
  supabaseAccessToken: string,
  supabaseRefreshToken: string | undefined,
  oauthState: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    state: string;
    scope: string;
  },
  signedState: string
): Promise<Response> {
  // Look up full client info
  const client = await getOAuthClientFull(oauthState.client_id);

  // If not a developer app (MCP dynamic client), auto-approve
  if (!client || !client.is_developer_app) {
    return generateAuthCodeAndRedirect(supabaseAccessToken, supabaseRefreshToken, oauthState);
  }

  // Verify user identity
  const user = await verifySupabaseToken(supabaseAccessToken);
  if (!user) {
    return error('Failed to verify user identity', 500);
  }

  // Check existing consent
  const requestedScopes = oauthState.scope.split(' ').filter(Boolean);
  const existingConsent = await getExistingConsent(user.id, oauthState.client_id);

  if (existingConsent && scopesSatisfied(existingConsent.scopes, requestedScopes)) {
    // Already consented with sufficient scopes — auto-approve
    return generateAuthCodeAndRedirect(supabaseAccessToken, supabaseRefreshToken, oauthState);
  }

  // Need consent — encrypt state into consent token and render screen
  const consentToken = await encryptConsentToken({
    supabase_access_token: supabaseAccessToken,
    supabase_refresh_token: supabaseRefreshToken,
    oauth_state: signedState,
    user_id: user.id,
    user_email: user.email,
  });

  return new Response(getConsentScreenHTML(client, requestedScopes, consentToken, oauthState.redirect_uri), {
    headers: { 'Content-Type': 'text/html' },
  });
}

/**
 * Handle consent approval — decrypt token, save consent, resume auth code flow.
 */
async function handleConsentApprove(request: Request): Promise<Response> {
  let body: Record<string, string>;
  try {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await request.text();
      const params = new URLSearchParams(text);
      body = Object.fromEntries(params.entries());
    } else {
      body = await request.json();
    }
  } catch {
    return error('Invalid request', 400);
  }

  const consentTokenStr = body.consent_token;
  if (!consentTokenStr) {
    return error('Missing consent_token', 400);
  }

  // Decrypt consent token
  const consentData = await decryptConsentToken(consentTokenStr);
  if (!consentData) {
    return error('Invalid or expired consent token', 400);
  }

  // Verify the signed state
  const encodedState = await verifySignedState(consentData.oauth_state);
  if (!encodedState) {
    return error('Invalid OAuth state in consent token', 400);
  }

  let oauthState: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    state: string;
    scope: string;
  };
  try {
    oauthState = JSON.parse(atob(encodedState));
  } catch {
    return error('Invalid OAuth state', 400);
  }

  // Save consent record
  const requestedScopes = oauthState.scope.split(' ').filter(Boolean);
  await saveConsent(consentData.user_id, oauthState.client_id, requestedScopes);

  // Resume the auth code flow
  return generateAuthCodeAndRedirect(
    consentData.supabase_access_token,
    consentData.supabase_refresh_token,
    oauthState
  );
}

/**
 * Handle consent denial — redirect back to client with error=access_denied.
 */
async function handleConsentDeny(request: Request): Promise<Response> {
  let body: Record<string, string>;
  try {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const text = await request.text();
      const params = new URLSearchParams(text);
      body = Object.fromEntries(params.entries());
    } else {
      body = await request.json();
    }
  } catch {
    return error('Invalid request', 400);
  }

  const redirectUri = body.redirect_uri;
  if (!redirectUri) {
    return error('Missing redirect_uri', 400);
  }

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set('error', 'access_denied');
  redirectUrl.searchParams.set('error_description', 'User denied the authorization request');

  return new Response(null, {
    status: 302,
    headers: { 'Location': redirectUrl.toString() },
  });
}

/**
 * Generate consent screen HTML.
 */
function getConsentScreenHTML(
  client: OAuthClientFull,
  scopes: string[],
  consentToken: string,
  redirectUri: string
): string {
  const appName = client.client_name || 'Unknown Application';
  const logoHtml = client.logo_url
    ? `<img src="${escapeHtml(client.logo_url)}" alt="" style="width:64px;height:64px;border-radius:12px;margin-bottom:1rem;">`
    : `<div style="width:64px;height:64px;border-radius:12px;background:#222;display:flex;align-items:center;justify-content:center;margin-bottom:1rem;font-size:28px;">${escapeHtml(appName.charAt(0).toUpperCase())}</div>`;

  const scopeDescriptions: Record<string, string> = {
    'user:read': 'View your profile information (name, avatar)',
    'user:email': 'View your email address',
    'apps:read': 'List your apps and their details',
    'apps:call': 'Call your app functions via MCP',
    'mcp:read': 'Read access to MCP tools',
    'mcp:write': 'Write access to MCP tools',
  };

  const scopeListHtml = scopes
    .map(s => {
      const desc = scopeDescriptions[s] || s;
      return `<li style="padding:0.5rem 0;border-bottom:1px solid #222;">${escapeHtml(desc)}</li>`;
    })
    .join('');

  // Escape the consent token for safe embedding in HTML form
  const escapedToken = escapeHtml(consentToken);
  const escapedRedirectUri = escapeHtml(redirectUri);

  return `<!DOCTYPE html>
<html>
<head>
  <title>Authorize ${escapeHtml(appName)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
    .card { background: #141414; border: 1px solid #222; border-radius: 16px; padding: 2rem; max-width: 420px; width: 100%; }
    .header { text-align: center; margin-bottom: 1.5rem; display: flex; flex-direction: column; align-items: center; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem; }
    .subtitle { color: #888; font-size: 0.875rem; }
    .scopes { margin: 1.5rem 0; }
    .scopes h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 0.75rem; }
    .scopes ul { list-style: none; font-size: 0.875rem; }
    .scopes li { display: flex; align-items: center; gap: 0.5rem; }
    .scopes li::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #22c55e; flex-shrink: 0; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    .actions form { flex: 1; }
    button { width: 100%; padding: 0.75rem; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: none; transition: background 0.15s; }
    .btn-authorize { background: #fff; color: #000; }
    .btn-authorize:hover { background: #e5e5e5; }
    .btn-deny { background: #222; color: #888; }
    .btn-deny:hover { background: #333; color: #e5e5e5; }
    .description { color: #888; font-size: 0.8rem; margin-top: 0.5rem; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      ${logoHtml}
      <h1>${escapeHtml(appName)}</h1>
      <p class="subtitle">wants to access your Galactic account</p>
    </div>
    <div class="scopes">
      <h2>This will allow the application to:</h2>
      <ul>${scopeListHtml}</ul>
    </div>
    <div class="actions">
      <form method="POST" action="/oauth/consent/approve">
        <input type="hidden" name="consent_token" value="${escapedToken}">
        <button type="submit" class="btn-authorize">Authorize</button>
      </form>
      <form method="POST" action="/oauth/consent/deny">
        <input type="hidden" name="redirect_uri" value="${escapedRedirectUri}">
        <button type="submit" class="btn-deny">Deny</button>
      </form>
    </div>
    <p class="description">Authorizing will redirect you back to ${escapeHtml(new URL(redirectUri).hostname)}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// CLIENT SECRET HELPERS
// ============================================

const CLIENT_SECRET_PREFIX = 'uls_';

/**
 * Generate a client secret: uls_ + 32 hex chars
 */
export function generateClientSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${CLIENT_SECRET_PREFIX}${hex}`;
}

/**
 * Generate a random hex salt for client secret hashing.
 */
export function generateSecretSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash a client secret with HMAC-SHA256 using a per-secret salt.
 */
export async function hashClientSecret(secret: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(secret));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a client secret against stored hash + salt.
 */
async function verifyClientSecret(secret: string, storedHash: string, salt: string): Promise<boolean> {
  const hash = await hashClientSecret(secret, salt);
  // Constant-time comparison
  if (hash.length !== storedHash.length) return false;
  let result = 0;
  for (let i = 0; i < hash.length; i++) {
    result |= hash.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return result === 0;
}

// ============================================
// P2A: PROTECTED RESOURCE METADATA
// ============================================

function handleProtectedResourceMetadata(request: Request): Response {
  const baseUrl = getBaseUrl(request);

  return json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: ['user:read', 'user:email', 'apps:read', 'apps:call'],
    bearer_methods_supported: ['header'],
  });
}

// ============================================
// P2B: AUTHORIZATION SERVER METADATA
// ============================================

function handleAuthorizationServerMetadata(request: Request): Response {
  const baseUrl = getBaseUrl(request);

  return json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    userinfo_endpoint: `${baseUrl}/oauth/userinfo`,
    scopes_supported: ['user:read', 'user:email', 'apps:read', 'apps:call'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ['none'],
    service_documentation: `${baseUrl}/docs/mcp`,
  });
}

// ============================================
// P2C: DYNAMIC CLIENT REGISTRATION
// ============================================

async function handleClientRegistration(request: Request): Promise<Response> {
  try {
    const payload = await validateDynamicClientRegistrationRequest(request);
    const clientId = crypto.randomUUID();

    const client: OAuthClient = {
      client_id: clientId,
      client_name: payload.clientName,
      redirect_uris: payload.redirectUris,
      grant_types: payload.grantTypes,
      response_types: payload.responseTypes,
      token_endpoint_auth_method: payload.tokenEndpointAuthMethod,
    };

    // Persist to Supabase so clients survive restarts and work across instances
    try {
      await saveOAuthClient(client);
    } catch (err) {
      console.error('OAuth client registration failed:', err);
      return error('Failed to register client', 500);
    }

    return json({
      client_id: clientId,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    }, 201);
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    console.error('OAuth client registration validation failed:', err);
    return error('Failed to register client', 500);
  }
}

// ============================================
// P2D: AUTHORIZATION ENDPOINT
// ============================================

async function handleAuthorize(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const baseUrl = getBaseUrl(request);

  let query;
  try {
    query = validateAuthorizeQuery(url);
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return error(err.message, err.status);
    }
    throw err;
  }

  // Validate client exists and redirect_uri is registered
  const client = await getOAuthClient(query.clientId);
  if (client && !client.redirect_uris.includes(query.redirectUri)) {
    return error('redirect_uri not registered for this client', 400);
  }

  // Store the OAuth state in a secure cookie-like param through the Supabase redirect.
  // We encode the OAuth params into our callback URL so we can reconstruct the flow.
  // The state is HMAC-signed to prevent forgery of redirect_uri, code_challenge, etc.
  const oauthState = JSON.stringify({
    client_id: query.clientId,
    redirect_uri: query.redirectUri,
    code_challenge: query.codeChallenge,
    code_challenge_method: query.codeChallengeMethod,
    state: query.state,
    scope: query.scope,
  });
  const encodedState = btoa(oauthState);
  const signedState = await signState(encodedState);

  // Redirect to Supabase Google OAuth, with our /oauth/callback as the redirect
  const callbackUrl = `${baseUrl}/oauth/callback?oauth_state=${encodeURIComponent(signedState)}`;
  const authUrl = `${getEnv('SUPABASE_URL')}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(callbackUrl)}`;

  return new Response(null, {
    status: 302,
    headers: { 'Location': authUrl },
  });
}

// ============================================
// OAUTH CALLBACK (internal — handles Supabase return)
// ============================================

async function handleOAuthCallback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const signedState = url.searchParams.get('oauth_state') || '';

  // Supabase may return with a code (PKCE flow) or hash-based tokens
  const code = url.searchParams.get('code');

  // Verify HMAC signature on the OAuth state to prevent forgery
  const encodedState = await verifySignedState(signedState);
  if (!encodedState) {
    return error('Invalid or tampered OAuth state', 400);
  }

  // Try to decode the OAuth state
  let oauthState: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    state: string;
    scope: string;
  };

  try {
    oauthState = JSON.parse(atob(encodedState));
  } catch {
    return error('Invalid OAuth state', 400);
  }

  if (code) {
    // Supabase code exchange — exchange Supabase auth code for tokens
    const tokenResponse = await fetch(`${getEnv('SUPABASE_URL')}/auth/v1/token?grant_type=authorization_code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: '',
      }),
    });

    if (tokenResponse.ok) {
      const tokens = await tokenResponse.json() as Partial<SupabaseTokenExchangeResponse>;
      if (!tokens.access_token) {
        return error('Supabase token exchange succeeded without an access token', 500);
      }
      return checkAndRenderConsent(tokens.access_token, tokens.refresh_token, oauthState, signedState);
    }
  }

  // Supabase implicit flow — tokens come in URL hash (client-side only).
  // Return HTML that extracts the hash token and POSTs it to complete the flow.
  // Pass the full signed state so the complete endpoint can verify it too.
  return new Response(getOAuthCallbackHTML(signedState), {
    headers: { 'Content-Type': 'text/html' },
  });
}

/**
 * Generate an authorization code and redirect back to the MCP client
 */
async function generateAuthCodeAndRedirect(
  supabaseAccessToken: string,
  supabaseRefreshToken: string | undefined,
  oauthState: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    state: string;
    scope: string;
  }
): Promise<Response> {
  // Verify the Supabase token to get user info
  const user = await verifySupabaseToken(supabaseAccessToken);
  if (!user) {
    return error('Failed to verify user identity', 500);
  }

  // Generate authorization code
  const authCode = crypto.randomUUID();

  const codeEntry: AuthorizationCode = {
    code: authCode,
    client_id: oauthState.client_id,
    redirect_uri: oauthState.redirect_uri,
    code_challenge: oauthState.code_challenge,
    code_challenge_method: oauthState.code_challenge_method,
    supabase_access_token: supabaseAccessToken,
    supabase_refresh_token: supabaseRefreshToken,
    user_id: user.id,
    user_email: user.email,
    scope: oauthState.scope,
    created_at: Date.now(),
  };

  await saveAuthorizationCode(codeEntry);

  // Redirect back to the MCP client with the authorization code
  const redirectUrl = new URL(oauthState.redirect_uri);
  redirectUrl.searchParams.set('code', authCode);
  if (oauthState.state) {
    redirectUrl.searchParams.set('state', oauthState.state);
  }

  return new Response(null, {
    status: 302,
    headers: { 'Location': redirectUrl.toString() },
  });
}

// ============================================
// P2E: TOKEN EXCHANGE ENDPOINT
// ============================================

async function handleTokenExchange(request: Request): Promise<Response> {
  let payload;
  try {
    payload = await validateOAuthTokenExchangeRequest(request);
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return oauthError(err.oauthErrorCode || 'invalid_request', err.message, err.status);
    }
    return oauthError('invalid_request', 'Could not parse request body', 400);
  }

  // Look up and atomically delete authorization code (one-time use, checks expiry)
  const codeEntry = await getAndDeleteAuthorizationCode(payload.code);
  if (!codeEntry) {
    return oauthError('invalid_grant', 'Invalid or expired authorization code', 400);
  }

  if (payload.clientId && payload.clientId !== codeEntry.client_id) {
    return oauthError('invalid_grant', 'client_id mismatch', 400);
  }

  // Verify redirect_uri matches
  if (payload.redirectUri && payload.redirectUri !== codeEntry.redirect_uri) {
    return oauthError('invalid_grant', 'redirect_uri mismatch', 400);
  }

  // Verify PKCE
  const pkceValid = await verifyPKCE(payload.codeVerifier, codeEntry.code_challenge, codeEntry.code_challenge_method);
  if (!pkceValid) {
    return oauthError('invalid_grant', 'PKCE verification failed', 400);
  }

  // For developer apps, verify client_secret
  const client = await getOAuthClientFull(codeEntry.client_id);
  if (client && client.is_developer_app && client.client_secret_hash) {
    const clientSecret = payload.clientSecret;
    if (!clientSecret) {
      return oauthError('invalid_client', 'client_secret required for this application', 401);
    }
    const secretValid = await verifyClientSecret(clientSecret, client.client_secret_hash, client.client_secret_salt || '');
    if (!secretValid) {
      return oauthError('invalid_client', 'Invalid client_secret', 401);
    }
  }

  // Parse scopes from the authorization code — use real scopes instead of wildcard
  const scopes = codeEntry.scope
    ? codeEntry.scope.split(' ').filter(Boolean)
    : ['*'];

  // Mint an Galactic API token for this user
  try {
    const tokenName = `oauth-${codeEntry.client_id.slice(0, 8)}-${Date.now()}`;
    const result = await createToken(codeEntry.user_id, tokenName, {
      scopes,
    });

    return json({
      access_token: result.plaintext_token,
      token_type: 'bearer',
      scope: codeEntry.scope,
    });
  } catch (err) {
    console.error('OAuth token creation failed:', err);
    return oauthError('server_error', 'Failed to create access token', 500);
  }
}

// ============================================
// P2F: TOKEN REVOCATION (RFC 7009)
// ============================================

async function handleTokenRevocation(request: Request): Promise<Response> {
  let payload;
  try {
    payload = await validateOAuthRevocationRequest(request);
  } catch (err) {
    if (err instanceof RequestValidationError) {
      return oauthError(err.oauthErrorCode || 'invalid_request', err.message, err.status);
    }
    return oauthError('invalid_request', 'Could not parse request body', 400);
  }

  // Attempt to revoke — per RFC 7009, always return 200 regardless of outcome
  try {
    await revokeByToken(payload.token);
  } catch (err) {
    console.error('Token revocation error:', err);
    // Still return 200 per spec
  }

  return new Response(null, { status: 200 });
}

// ============================================
// IMPLICIT FLOW COMPLETION
// ============================================

/**
 * Called from the browser-side JS when Supabase returns tokens in the URL hash.
 * Receives the Supabase access token, generates an auth code, and returns a redirect URL.
 */
async function handleOAuthCallbackComplete(request: Request): Promise<Response> {
  let body: Record<string, string>;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON', 400);
  }

  const accessToken = body.access_token;
  const refreshToken = body.refresh_token;
  const signedState = body.oauth_state;

  if (!accessToken || !signedState) {
    return error('Missing access_token or oauth_state', 400);
  }

  // Verify HMAC signature on the OAuth state
  const encodedState = await verifySignedState(signedState);
  if (!encodedState) {
    return error('Invalid or tampered OAuth state', 400);
  }

  let oauthState: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    state: string;
    scope: string;
  };

  try {
    oauthState = JSON.parse(atob(encodedState));
  } catch {
    return error('Invalid OAuth state', 400);
  }

  // Check if this is a developer app that needs consent
  const client = await getOAuthClientFull(oauthState.client_id);
  if (client && client.is_developer_app) {
    // Verify the Supabase token to check consent
    const user = await verifySupabaseToken(accessToken);
    if (!user) {
      return error('Invalid Supabase token', 401);
    }

    const requestedScopes = oauthState.scope.split(' ').filter(Boolean);
    const existingConsent = await getExistingConsent(user.id, oauthState.client_id);

    if (!existingConsent || !scopesSatisfied(existingConsent.scopes, requestedScopes)) {
      // Need consent — return consent HTML for the browser to render
      const consentToken = await encryptConsentToken({
        supabase_access_token: accessToken,
        supabase_refresh_token: refreshToken,
        oauth_state: signedState,
        user_id: user.id,
        user_email: user.email,
      });
      return json({ consent_required: true, consent_html: getConsentScreenHTML(client, requestedScopes, consentToken, oauthState.redirect_uri) });
    }
  }

  // No consent needed — proceed with auth code generation
  const user = await verifySupabaseToken(accessToken);
  if (!user) {
    return error('Invalid Supabase token', 401);
  }

  // Generate authorization code
  const authCode = crypto.randomUUID();

  const codeEntry: AuthorizationCode = {
    code: authCode,
    client_id: oauthState.client_id,
    redirect_uri: oauthState.redirect_uri,
    code_challenge: oauthState.code_challenge,
    code_challenge_method: oauthState.code_challenge_method,
    supabase_access_token: accessToken,
    supabase_refresh_token: refreshToken,
    user_id: user.id,
    user_email: user.email,
    scope: oauthState.scope,
    created_at: Date.now(),
  };

  await saveAuthorizationCode(codeEntry);

  // Build redirect URL back to the MCP client
  const redirectUrl = new URL(oauthState.redirect_uri);
  redirectUrl.searchParams.set('code', authCode);
  if (oauthState.state) {
    redirectUrl.searchParams.set('state', oauthState.state);
  }

  return json({ redirect: redirectUrl.toString() });
}

// ============================================
// HELPERS
// ============================================

function oauthError(errorCode: string, description: string, status: number): Response {
  return new Response(JSON.stringify({
    error: errorCode,
    error_description: description,
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * HTML page for handling Supabase implicit flow (hash-based tokens).
 * Extracts #access_token from URL hash and completes the OAuth flow.
 */
function getOAuthCallbackHTML(encodedState: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Authorizing...</title>
  <style>
    body { font-family: system-ui; background: #0a0a0a; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { text-align: center; }
    .spinner { width: 40px; height: 40px; border: 3px solid #333; border-top-color: #667eea; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 1rem; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <p>Completing authorization...</p>
  </div>
  <script>
    (async function() {
      // Supabase implicit flow returns tokens in URL hash
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');

      if (!accessToken) {
        document.querySelector('p').textContent = 'Authorization failed. No token received.';
        return;
      }

      // POST the token to our server-side handler to complete the flow
      try {
        const res = await fetch('/oauth/callback/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken || '',
            oauth_state: '${encodedState}',
          }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.consent_required && data.consent_html) {
            document.open();
            document.write(data.consent_html);
            document.close();
          } else if (data.redirect) {
            window.location.href = data.redirect;
          } else {
            document.querySelector('p').textContent = 'Authorization complete!';
          }
        } else {
          document.querySelector('p').textContent = 'Authorization failed. Please try again.';
        }
      } catch (e) {
        document.querySelector('p').textContent = 'Authorization failed: ' + e.message;
      }
    })();
  </script>
</body>
</html>`;
}
