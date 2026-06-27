/**
 * API Token Service
 *
 * Handles creation, validation, and management of personal access tokens.
 * Tokens are generated with a secure random value, hashed for storage,
 * and the plaintext is shown only once during creation.
 *
 * Token format: ul_[32 random hex chars] = 35 chars total
 * Example: ul_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
 */

import { createClient } from '@supabase/supabase-js';
import { getEnv } from '../lib/env.ts';

interface UserApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  token_salt: string | null;
  plaintext_token: string | null;
  scopes: string[] | null;
  app_ids: string[] | null;
  function_names: string[] | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  created_at: string;
}

interface UserApiTokenInsert {
  id?: string;
  user_id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  token_salt?: string | null;
  plaintext_token?: string | null;
  scopes?: string[] | null;
  app_ids?: string[] | null;
  function_names?: string[] | null;
  last_used_at?: string | null;
  last_used_ip?: string | null;
  expires_at?: string | null;
  created_at?: string;
}

interface UserRow {
  id: string;
  email: string;
  tier: string | null;
  provisional: boolean | null;
  last_active_at: string | null;
}

interface Database {
  public: {
    Tables: {
      user_api_tokens: {
        Row: UserApiTokenRow;
        Insert: UserApiTokenInsert;
        Update: Partial<UserApiTokenInsert>;
        Relationships: [];
      };
      users: {
        Row: UserRow;
        Insert: Partial<UserRow> & { id: string };
        Update: Partial<UserRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

type UserApiTokenInsertPayload = Database['public']['Tables']['user_api_tokens']['Insert'];
type TokensSupabaseClient = ReturnType<typeof createTokensSupabaseClient>;

// Lazy Supabase client — CF Workers env not available at module init
let _supabase: TokensSupabaseClient | undefined;

function createTokensSupabaseClient() {
  return createClient<Database, 'public'>(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'));
}

function getSupabase(): TokensSupabaseClient {
  if (!_supabase) {
    _supabase = createTokensSupabaseClient();
  }

  return _supabase;
}

// The repo does not yet have a shared generated Supabase schema, so `from(...)`
// can collapse to `never` in isolated files. Bridge the two tables we use here
// through local wrappers until the broader schema story is cleaned up.
function tokensTable() {
  return getSupabase().from('user_api_tokens' as never) as any;
}

function usersTable() {
  return getSupabase().from('users' as never) as any;
}

// Token prefix for easy identification. New keys are minted as `gx_`; the
// legacy `ul_` prefix is still ACCEPTED (deprecated) so existing keys keep
// working. Both are 3 chars + 32 hex = 35 chars total.
const TOKEN_PREFIX = 'gx_';
const LEGACY_TOKEN_PREFIX = 'ul_';

/** True if the token carries a current (`gx_`) or legacy (`ul_`) API-key prefix. */
function hasApiTokenPrefix(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX) ||
    token.startsWith(LEGACY_TOKEN_PREFIX);
}

export interface ApiToken {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  plaintext_token: string | null;
  scopes: string[];
  /** App IDs this token is scoped to. null or ['*'] = all apps. */
  app_ids: string[] | null;
  /** Function names this token can call. null or ['*'] = all functions. */
  function_names: string[] | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface CreateTokenResult {
  token: ApiToken;
  plaintext_token: string; // Only returned on creation!
}

export interface ValidatedToken {
  user_id: string;
  token_id: string;
  scopes: string[];
  /** App IDs this token is restricted to. null = unrestricted. */
  app_ids: string[] | null;
  /** Function names this token can call. null = unrestricted. */
  function_names: string[] | null;
}

export type ApiTokenCompatibilityState =
  | 'canonical'
  | 'canonical_missing_plaintext'
  | 'legacy_backfillable_from_plaintext'
  | 'legacy_unrecoverable';

export interface ApiTokenVerificationOutcome {
  valid: boolean;
  state: ApiTokenCompatibilityState;
  reason?: 'hash_mismatch' | 'plaintext_mismatch' | 'missing_token_material';
  canonical_update?: {
    token_hash: string;
    token_salt: string;
  };
}

/**
 * Generate a cryptographically secure random token
 */
function generateToken(): string {
  const bytes = new Uint8Array(16); // 16 bytes = 32 hex chars
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${TOKEN_PREFIX}${hex}`;
}

/**
 * Constant-time string comparison to prevent timing attacks on token hashes.
 * Uses XOR accumulation so execution time is independent of where strings differ.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Hash a token with a per-token salt using HMAC-SHA256.
 * The salt acts as key material, making each token's hash unique even if tokens collide.
 */
async function hashTokenWithSalt(token: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a random hex salt for token hashing (16 bytes = 32 hex chars).
 */
function generateTokenSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function classifyApiTokenCompatibility(row: {
  token_salt: string | null;
  plaintext_token: string | null;
}): ApiTokenCompatibilityState {
  if (row.token_salt) {
    return row.plaintext_token ? 'canonical' : 'canonical_missing_plaintext';
  }

  if (row.plaintext_token) {
    return 'legacy_backfillable_from_plaintext';
  }

  return 'legacy_unrecoverable';
}

export async function verifyApiTokenRecord(
  token: string,
  row: {
    token_hash: string;
    token_salt: string | null;
    plaintext_token: string | null;
  },
): Promise<ApiTokenVerificationOutcome> {
  const state = classifyApiTokenCompatibility(row);

  if (row.token_salt) {
    const tokenHash = await hashTokenWithSalt(token, row.token_salt);
    const valid = constantTimeEqual(row.token_hash, tokenHash);
    return {
      valid,
      state,
      reason: valid ? undefined : 'hash_mismatch',
    };
  }

  if (!row.plaintext_token) {
    return {
      valid: false,
      state,
      reason: 'missing_token_material',
    };
  }

  if (!constantTimeEqual(row.plaintext_token, token)) {
    return {
      valid: false,
      state,
      reason: 'plaintext_mismatch',
    };
  }

  const tokenSalt = generateTokenSalt();
  return {
    valid: true,
    state,
    canonical_update: {
      token_salt: tokenSalt,
      token_hash: await hashTokenWithSalt(token, tokenSalt),
    },
  };
}

async function backfillCanonicalTokenHash(
  tokenId: string,
  update: {
    token_hash: string;
    token_salt: string;
  },
): Promise<void> {
  const { error } = await tokensTable()
    .update(update)
    .eq('id', tokenId);

  if (error) {
    throw new Error(`Failed to backfill canonical token hash: ${error.message}`);
  }
}

/**
 * Create a new API token for a user.
 * All tiers have unlimited API tokens.
 */
export async function createToken(
  userId: string,
  name: string,
  options?: {
    expiresInDays?: number;
    scopes?: string[];
    app_ids?: string[];
    function_names?: string[];
  }
): Promise<CreateTokenResult> {
  // Check if token with this name already exists
  const { data: existing } = await tokensTable()
    .select('id')
    .eq('user_id', userId)
    .eq('name', name)
    .single();

  if (existing) {
    throw new Error(`Token with name "${name}" already exists`);
  }

  // Generate token with per-token salt
  const plaintextToken = generateToken();
  const tokenSalt = generateTokenSalt();
  const tokenHash = await hashTokenWithSalt(plaintextToken, tokenSalt);
  const tokenPrefix = plaintextToken.substring(0, 8); // "ul_xxxxx"

  // Calculate expiry if specified
  let expiresAt: string | null = null;
  if (options?.expiresInDays) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + options.expiresInDays);
    expiresAt = expiry.toISOString();
  }

  // Insert token into the canonical schema.
  const insertPayload: UserApiTokenInsertPayload = {
    user_id: userId,
    name,
    token_prefix: tokenPrefix,
    token_hash: tokenHash,
    token_salt: tokenSalt,
    plaintext_token: null,
    scopes: options?.scopes || ['*'],
    app_ids: options?.app_ids || null,
    function_names: options?.function_names || null,
    expires_at: expiresAt,
  };

  let { data, error } = await tokensTable()
    .insert(insertPayload)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create token: ${error.message}`);
  }
  if (!data) {
    throw new Error('Failed to create token: insert returned no row');
  }

  return {
    token: data,
    plaintext_token: plaintextToken,
  };
}

/**
 * List all tokens for a user (without exposing hashes)
 */
export async function listTokens(userId: string): Promise<ApiToken[]> {
  let { data, error } = await tokensTable()
    .select(
      'id, user_id, name, token_prefix, scopes, app_ids, function_names, last_used_at, last_used_ip, expires_at, created_at',
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list tokens: ${error.message}`);
  }

  return (data || []).map((row: Omit<ApiToken, 'plaintext_token'>) => ({
    ...row,
    plaintext_token: null,
  }));
}

/**
 * Revoke (delete) a token
 */
export async function revokeToken(userId: string, tokenId: string): Promise<void> {
  const { error } = await tokensTable()
    .delete()
    .eq('id', tokenId)
    .eq('user_id', userId); // Ensure user owns the token

  if (error) {
    throw new Error(`Failed to revoke token: ${error.message}`);
  }
  invalidateTokenVerdictsForUser(userId);
}

/**
 * Revoke all tokens for a user
 */
export async function revokeAllTokens(userId: string): Promise<number> {
  const { data, error } = await tokensTable()
    .delete()
    .eq('user_id', userId)
    .select('id');

  if (error) {
    throw new Error(`Failed to revoke tokens: ${error.message}`);
  }
  invalidateTokenVerdictsForUser(userId);

  return data?.length || 0;
}

/**
 * Revoke a token by its plaintext value (used by OAuth revocation endpoint).
 * Looks up the token by prefix + hash verification, then deletes it.
 * Returns true if the token was found and revoked, false if not found.
 * Per RFC 7009, callers should return 200 OK regardless.
 */
export async function revokeByToken(token: string): Promise<boolean> {
  // Quick format check
  if (!hasApiTokenPrefix(token) || token.length !== 35) {
    return false;
  }

  const tokenPrefix = token.substring(0, 8);

  // Look up by prefix (indexed), then verify canonical token material.
  const { data, error: lookupErr } = await tokensTable()
    .select('id, token_hash, token_salt, plaintext_token')
    .eq('token_prefix', tokenPrefix)
    .single();

  if (lookupErr || !data) {
    return false;
  }

  const verification = await verifyApiTokenRecord(token, data);
  if (!verification.valid) {
    return false;
  }

  // Delete the token
  const { error: deleteErr } = await tokensTable()
    .delete()
    .eq('id', data.id);

  if (deleteErr) {
    console.error('Failed to revoke token by value:', deleteErr);
    return false;
  }

  // We hold the raw token here, so evict the exact verdict — the public
  // RFC 7009 endpoint is the revocation most likely invoked under credential
  // compromise.
  dropTokenVerdict(await tokenVerdictKey(token));
  return true;
}

/**
 * Revoke excess tokens when a user downgrades tier.
 * Keeps the most recently created tokens up to maxTokens,
 * revokes the rest. Returns the number of tokens revoked.
 */
export async function revokeExcessTokens(
  userId: string,
  maxTokens: number
): Promise<{ revoked_count: number; kept_count: number; revoked_names: string[] }> {
  // Get all tokens ordered by created_at descending (newest first)
  const { data: tokens, error: listErr } = await tokensTable()
    .select('id, name, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (listErr || !tokens) {
    console.error('revokeExcessTokens: failed to list tokens:', listErr);
    return { revoked_count: 0, kept_count: 0, revoked_names: [] };
  }

  if (tokens.length <= maxTokens) {
    return { revoked_count: 0, kept_count: tokens.length, revoked_names: [] };
  }

  // Keep the newest maxTokens, revoke the rest
  const tokensToRevoke = tokens.slice(maxTokens);
  const revokedNames: string[] = [];

  for (const token of tokensToRevoke) {
    const { error: revokeErr } = await tokensTable()
      .delete()
      .eq('id', token.id)
      .eq('user_id', userId);

    if (!revokeErr) {
      revokedNames.push(token.name);
    } else {
      console.error(`revokeExcessTokens: failed to revoke token ${token.id}:`, revokeErr);
    }
  }

  if (revokedNames.length > 0) invalidateTokenVerdictsForUser(userId);
  return {
    revoked_count: revokedNames.length,
    kept_count: maxTokens,
    revoked_names: revokedNames,
  };
}

/**
 * Validate a token and return user info if valid
 * This is called on every authenticated request
 */
export async function validateToken(
  token: string,
  clientIp?: string
): Promise<ValidatedToken | null> {
  // Quick format check
  if (!hasApiTokenPrefix(token)) {
    console.log(`[TOKEN] Rejected: missing prefix "gx_"/"ul_" — got "${token.substring(0, 6)}..."`);
    return null;
  }
  if (token.length !== 35) {
    console.log(`[TOKEN] Rejected: wrong length — expected 35, got ${token.length} (prefix: ${token.substring(0, 8)})`);
    return null;
  }

  const tokenPrefix = token.substring(0, 8);
  console.log(`[TOKEN] Validating token with prefix: ${tokenPrefix}`);

  // Look up token by prefix first (indexed), then verify hash
  const { data, error } = await tokensTable()
    .select('id, user_id, token_hash, token_salt, plaintext_token, scopes, app_ids, function_names, expires_at')
    .eq('token_prefix', tokenPrefix)
    .single();

  if (error || !data) {
    console.log(`[TOKEN] Prefix lookup FAILED for "${tokenPrefix}" — error: ${error?.message || 'no rows'}, code: ${error?.code || 'n/a'}`);
    return null;
  }
  console.log(`[TOKEN] Prefix lookup OK — token_id: ${data.id}, user_id: ${data.user_id}, state: ${classifyApiTokenCompatibility(data)}`);

  const verification = await verifyApiTokenRecord(token, data);
  if (!verification.valid) {
    console.log(`[TOKEN] Validation failed for token_id: ${data.id} (reason: ${verification.reason || 'unknown'})`);
    return null;
  }
  if (verification.canonical_update) {
    try {
      await backfillCanonicalTokenHash(data.id, verification.canonical_update);
      console.log(`[TOKEN] Canonical token hash backfilled for token_id: ${data.id}`);
    } catch (err) {
      console.warn('[TOKEN] Failed to backfill canonical token hash', err);
    }
  }
  console.log(`[TOKEN] Hash verified OK for token_id: ${data.id}`);

  // Check expiry
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    console.log(`[TOKEN] EXPIRED — token_id: ${data.id}, expired_at: ${data.expires_at}`);
    return null;
  }

  // Update last used (fire and forget - don't wait)
  tokensTable()
    .update({
      last_used_at: new Date().toISOString(),
      last_used_ip: clientIp || null,
    })
    .eq('id', data.id)
    .then(() => {}); // Ignore result

  console.log(`[TOKEN] Validation SUCCESS — token_id: ${data.id}, user_id: ${data.user_id}`);
  return {
    user_id: data.user_id,
    token_id: data.id,
    scopes: data.scopes || ['*'],
    app_ids: data.app_ids || null,
    function_names: data.function_names || null,
  };
}

// ── API-token verdict cache ────────────────────────────────────────────────
// Successful token verifications cost 2 Supabase reads (token row + user
// row) on EVERY api-token request. Cache the verdict in-isolate for 60s,
// keyed by a digest of the raw token (never the token itself). Failures are
// NEVER cached. Staleness consequences within the TTL: a revoked token keeps
// working ≤60s in isolates the revoke endpoint didn't run in (the revoking
// isolate is invalidated immediately), last_used_at/_ip bump only on cache
// misses, and a provisional 24h expiry lands ≤60s late.

interface TokenVerdict {
  id: string;
  email: string;
  tier: string;
  provisional?: boolean;
  tokenId: string;
  tokenAppIds?: string[] | null;
  tokenFunctionNames?: string[] | null;
  scopes?: string[];
}

const TOKEN_VERDICT_TTL_MS = 60_000;
const TOKEN_VERDICT_MAX_ENTRIES = 2_000;
const tokenVerdictCache = new Map<
  string,
  { verdict: TokenVerdict; cachedAt: number }
>();
const tokenVerdictKeysByUser = new Map<string, Set<string>>();

async function tokenVerdictKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function cacheTokenVerdict(key: string, verdict: TokenVerdict): void {
  if (tokenVerdictCache.size >= TOKEN_VERDICT_MAX_ENTRIES) {
    // Maps iterate in insertion order; hits re-insert (below), so the first
    // key is the least recently USED entry.
    const oldest = tokenVerdictCache.keys().next().value;
    if (oldest !== undefined) dropTokenVerdict(oldest);
  }
  // Copy the authorization-bearing arrays: the shallow spread on return
  // shares them by reference, and a downstream in-place mutation must never
  // poison authorization decisions for later requests.
  tokenVerdictCache.set(key, {
    verdict: {
      ...verdict,
      scopes: verdict.scopes ? [...verdict.scopes] : verdict.scopes,
      tokenAppIds: verdict.tokenAppIds
        ? [...verdict.tokenAppIds]
        : verdict.tokenAppIds,
      tokenFunctionNames: verdict.tokenFunctionNames
        ? [...verdict.tokenFunctionNames]
        : verdict.tokenFunctionNames,
    },
    cachedAt: Date.now(),
  });
  let keys = tokenVerdictKeysByUser.get(verdict.id);
  if (!keys) {
    keys = new Set();
    tokenVerdictKeysByUser.set(verdict.id, keys);
  }
  keys.add(key);
}

function dropTokenVerdict(key: string): void {
  const entry = tokenVerdictCache.get(key);
  tokenVerdictCache.delete(key);
  if (entry) {
    const keys = tokenVerdictKeysByUser.get(entry.verdict.id);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) tokenVerdictKeysByUser.delete(entry.verdict.id);
    }
  }
}

// Revocation hook (in-isolate; other isolates converge within the TTL). The
// revoke endpoints know the user, not the raw token, so eviction is by user.
// Exported for revocation paths that delete token rows outside this module.
export function invalidateTokenVerdictsForUser(userId: string): void {
  const keys = tokenVerdictKeysByUser.get(userId);
  if (!keys) return;
  for (const key of [...keys]) tokenVerdictCache.delete(key);
  tokenVerdictKeysByUser.delete(userId);
}

/**
 * Get user info from a validated token
 * Used by auth middleware to get full user context
 */
export async function getUserFromToken(token: string, clientIp?: string): Promise<{
  id: string;
  email: string;
  tier: string;
  provisional?: boolean;
  tokenId: string;
  tokenAppIds?: string[] | null;
  tokenFunctionNames?: string[] | null;
  scopes?: string[];
} | null> {
  const cacheKey = await tokenVerdictKey(token);
  const cached = tokenVerdictCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < TOKEN_VERDICT_TTL_MS) {
    // Re-insert so Map insertion order tracks USE order (true LRU eviction).
    tokenVerdictCache.delete(cacheKey);
    tokenVerdictCache.set(cacheKey, cached);
    return {
      ...cached.verdict,
      scopes: cached.verdict.scopes ? [...cached.verdict.scopes] : undefined,
      tokenAppIds: cached.verdict.tokenAppIds
        ? [...cached.verdict.tokenAppIds]
        : cached.verdict.tokenAppIds,
      tokenFunctionNames: cached.verdict.tokenFunctionNames
        ? [...cached.verdict.tokenFunctionNames]
        : cached.verdict.tokenFunctionNames,
    };
  }
  if (cached) dropTokenVerdict(cacheKey);

  console.log(`[TOKEN] getUserFromToken called — token length: ${token.length}, prefix: ${token.substring(0, 8)}`);

  const validated = await validateToken(token, clientIp);
  if (!validated) {
    console.log(`[TOKEN] getUserFromToken: validateToken returned null`);
    return null;
  }

  // Get user from database (include provisional + last_active_at for expiry check)
  const { data: user, error } = await usersTable()
    .select('id, email, tier, provisional, last_active_at')
    .eq('id', validated.user_id)
    .single();

  if (error || !user) {
    console.log(`[TOKEN] getUserFromToken: user lookup FAILED for user_id: ${validated.user_id} — error: ${error?.message || 'no user found'}`);
    return null;
  }
  console.log(`[TOKEN] getUserFromToken: user found — email: ${user.email}, tier: ${user.tier}, provisional: ${user.provisional}`);

  // Reject expired provisional users (no MCP call in 24 hours)
  if (user.provisional && user.last_active_at) {
    const lastActive = new Date(user.last_active_at).getTime();
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    if (lastActive < twentyFourHoursAgo) {
      console.log(`[TOKEN] getUserFromToken: provisional user EXPIRED — last_active: ${user.last_active_at}`);
      return null; // Expired provisional — treat as invalid token
    }
  }

  console.log(`[TOKEN] getUserFromToken SUCCESS — user: ${user.id}, tier: ${user.tier}`);
  const verdict: TokenVerdict = {
    id: user.id,
    email: user.email,
    tier: user.tier || 'free',
    provisional: user.provisional || false,
    tokenId: validated.token_id,
    tokenAppIds: validated.app_ids,
    tokenFunctionNames: validated.function_names,
    scopes: validated.scopes,
  };
  cacheTokenVerdict(cacheKey, verdict);
  return { ...verdict };
}

/**
 * Check if a string looks like an API token (vs JWT)
 */
export function isApiToken(authValue: string): boolean {
  return hasApiTokenPrefix(authValue);
}
