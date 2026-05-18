import { CANONICAL_BASE } from "../lib/urls.ts";
import { getEnv } from "../lib/env.ts";

export const REFERRAL_VISITOR_COOKIE_NAME = "__Host-ul_ref_visitor";
export const REFERRAL_VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

const REFERRAL_GRANT_DURATION_MS = 90 * 24 * 60 * 60 * 1000;
const REFERRAL_CLAIM_TOKEN_TTL_MS = REFERRAL_GRANT_DURATION_MS;
const REFERRAL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FetchLike = typeof fetch;

interface ReferralDeps {
  fetchFn?: FetchLike;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
  baseUrl?: string;
}

interface ReferralLinkRow {
  id: string;
  app_id: string;
  publisher_user_id: string;
  slug: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at?: string;
}

interface ReferralLandingRow {
  id: string;
  referral_link_id: string;
  publisher_user_id: string;
  app_id: string | null;
  anonymous_visitor_id: string | null;
  user_id: string | null;
  landed_at: string;
  claimed_at: string | null;
}

interface ExistingGrantRow {
  id: string;
  starts_at: string;
  expires_at: string;
}

interface ReferralGrantRow extends ExistingGrantRow {
  publisher_user_id: string;
  source_landing_id: string | null;
}

interface AppOwnerRow {
  owner_id: string | null;
}

export interface PublisherReferralLink {
  id: string;
  app_id: string;
  publisher_user_id: string;
  slug: string;
  url: string;
  status: "active" | "disabled";
  created_at: string;
}

export interface ReferralLandingMetadata {
  ipHash?: string | null;
  userAgentHash?: string | null;
  landingUrl?: string | null;
  referrerUrl?: string | null;
}

export interface ReferralLandingResult {
  status: "recorded" | "self_referral_ignored" | "not_found" | "stale_owner";
  appId?: string;
  visitorId?: string;
  landingId?: string;
  grantId?: string | null;
}

export interface ReferralClaimResult {
  claimedLandingCount: number;
  grantIds: string[];
}

export interface ReferralTransferResult {
  grantsTransferred: number;
  grantsSkipped: number;
  landingsClaimed: number;
}

function fetchFn(deps?: ReferralDeps): FetchLike {
  return deps?.fetchFn || fetch;
}

function dbHeaders(): Record<string, string> {
  return {
    "apikey": getEnv("SUPABASE_SERVICE_ROLE_KEY"),
    "Authorization": `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
  };
}

function jsonHeaders(prefer = "return=representation"): Record<string, string> {
  return {
    ...dbHeaders(),
    "Content-Type": "application/json",
    "Prefer": prefer,
  };
}

function postgrestEq(value: string): string {
  return encodeURIComponent(`eq.${value}`);
}

function randomSlug(deps?: ReferralDeps): string {
  const bytes = deps?.randomBytes
    ? deps.randomBytes(18)
    : crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function referralLinkFromRow(row: ReferralLinkRow, baseUrl?: string): PublisherReferralLink {
  return {
    id: row.id,
    app_id: row.app_id,
    publisher_user_id: row.publisher_user_id,
    slug: row.slug,
    url: referralUrl(row.slug, baseUrl),
    status: row.status,
    created_at: row.created_at,
  };
}

function normalizeVisitorId(value: string | null | undefined): string | null {
  if (!value) return null;
  return UUID_PATTERN.test(value) ? value : null;
}

function generateVisitorId(): string {
  return crypto.randomUUID();
}

function addGrantDuration(landedAt: string): string {
  return new Date(new Date(landedAt).getTime() + REFERRAL_GRANT_DURATION_MS).toISOString();
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlDecodeString(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacSha256Base64Url(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getEnv("REFERRAL_CLAIM_TOKEN_SECRET") || getEnv("SUPABASE_SERVICE_ROLE_KEY")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function isValidReferralSlug(slug: string): boolean {
  return REFERRAL_SLUG_PATTERN.test(slug);
}

export function referralUrl(slug: string, baseUrl = CANONICAL_BASE): string {
  return `${baseUrl.replace(/\/+$/, "")}/r/${encodeURIComponent(slug)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createReferralClaimToken(
  input: { landingId: string; visitorId: string },
  deps: ReferralDeps = {},
): Promise<string> {
  const exp = (deps.now?.() || new Date()).getTime() + REFERRAL_CLAIM_TOKEN_TTL_MS;
  const payload = base64UrlEncodeString(JSON.stringify({
    v: 1,
    landing_id: input.landingId,
    visitor_id: input.visitorId,
    exp,
  }));
  const signature = await hmacSha256Base64Url(payload);
  return `${payload}.${signature}`;
}

async function fetchActiveReferralLink(
  appId: string,
  publisherUserId: string,
  deps?: ReferralDeps,
): Promise<ReferralLinkRow | null> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_links?app_id=${
      postgrestEq(appId)
    }&publisher_user_id=${postgrestEq(publisherUserId)}&status=eq.active&select=id,app_id,publisher_user_id,slug,status,created_at,updated_at&limit=1`,
    { headers: dbHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch referral link (${response.status})`);
  }
  const rows = await response.json() as ReferralLinkRow[];
  return rows[0] || null;
}

async function fetchActiveReferralLinkForApp(
  appId: string,
  deps?: ReferralDeps,
): Promise<ReferralLinkRow | null> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_links?app_id=${
      postgrestEq(appId)
    }&status=eq.active&select=id,app_id,publisher_user_id,slug,status,created_at,updated_at&limit=1`,
    { headers: dbHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch app referral link (${response.status})`);
  }
  const rows = await response.json() as ReferralLinkRow[];
  return rows[0] || null;
}

async function recoverReferralLinkConflict(
  appId: string,
  publisherUserId: string,
  deps?: ReferralDeps,
): Promise<PublisherReferralLink | null> {
  const racedExisting = await fetchActiveReferralLink(appId, publisherUserId, deps);
  if (racedExisting) return referralLinkFromRow(racedExisting, deps?.baseUrl);

  const activeForApp = await fetchActiveReferralLinkForApp(appId, deps);
  if (activeForApp && activeForApp.publisher_user_id !== publisherUserId) {
    await disableReferralLink(activeForApp.id, deps);
  }
  return null;
}

export async function getOrCreatePublisherReferralLink(
  appId: string,
  publisherUserId: string,
  deps: ReferralDeps = {},
): Promise<PublisherReferralLink> {
  const existing = await fetchActiveReferralLink(appId, publisherUserId, deps);
  if (existing) {
    return referralLinkFromRow(existing, deps.baseUrl);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = randomSlug(deps);
    const response = await fetchFn(deps)(
      `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_links`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          app_id: appId,
          publisher_user_id: publisherUserId,
          slug,
          status: "active",
        }),
      },
    );

    if (response.ok) {
      const rows = await response.json() as ReferralLinkRow[];
      if (rows[0]) return referralLinkFromRow(rows[0], deps.baseUrl);
    }

    const body = await response.text().catch(() => "");
    if (response.status === 409 || body.includes("23505") || body.includes("duplicate")) {
      const recovered = await recoverReferralLinkConflict(appId, publisherUserId, deps);
      if (recovered) return recovered;
      continue;
    }

    throw new Error(`Failed to create referral link (${response.status})`);
  }

  throw new Error("Failed to create unique referral link");
}

async function fetchActiveReferralLinkBySlug(
  slug: string,
  deps?: ReferralDeps,
): Promise<ReferralLinkRow | null> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_links?slug=${
      postgrestEq(slug)
    }&status=eq.active&select=id,app_id,publisher_user_id,slug,status,created_at,updated_at&limit=1`,
    { headers: dbHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch referral link by slug (${response.status})`);
  }
  const rows = await response.json() as ReferralLinkRow[];
  return rows[0] || null;
}

async function appOwnerMatchesLink(link: ReferralLinkRow, deps?: ReferralDeps): Promise<boolean> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/apps?id=${postgrestEq(link.app_id)}&select=owner_id&limit=1`,
    { headers: dbHeaders() },
  );
  if (!response.ok) return true;
  const rows = await response.json() as AppOwnerRow[];
  const app = rows[0];
  return !app || app.owner_id === link.publisher_user_id;
}

async function disableReferralLink(linkId: string, deps?: ReferralDeps): Promise<void> {
  await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_links?id=${postgrestEq(linkId)}`,
    {
      method: "PATCH",
      headers: jsonHeaders("return=minimal"),
      body: JSON.stringify({
        status: "disabled",
        disabled_at: (deps?.now?.() || new Date()).toISOString(),
      }),
    },
  ).catch(() => {});
}

async function markLandingClaimed(
  landingId: string,
  userId: string,
  deps?: ReferralDeps,
): Promise<void> {
  await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_landings?id=${postgrestEq(landingId)}`,
    {
      method: "PATCH",
      headers: jsonHeaders("return=minimal"),
      body: JSON.stringify({
        user_id: userId,
        claimed_at: (deps?.now?.() || new Date()).toISOString(),
      }),
    },
  );
}

async function fetchExistingReferralGrant(
  userId: string,
  publisherUserId: string,
  deps?: ReferralDeps,
): Promise<ExistingGrantRow | null> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_fee_waiver_grants?user_id=${
      postgrestEq(userId)
    }&publisher_user_id=${postgrestEq(publisherUserId)}&source=eq.referral&select=id,starts_at,expires_at&limit=1`,
    { headers: dbHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch referral grant (${response.status})`);
  }
  const rows = await response.json() as ExistingGrantRow[];
  return rows[0] || null;
}

async function fetchClaimableLandingsForVisitor(
  visitorId: string,
  deps?: ReferralDeps,
): Promise<ReferralLandingRow[]> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_landings?anonymous_visitor_id=${
      postgrestEq(visitorId)
    }&user_id=is.null&select=id,referral_link_id,publisher_user_id,app_id,anonymous_visitor_id,user_id,landed_at,claimed_at&order=landed_at.asc`,
    { headers: dbHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch referral landings (${response.status})`);
  }
  return await response.json() as ReferralLandingRow[];
}

async function fetchLandingForClaimToken(
  landingId: string,
  visitorId: string,
  deps?: ReferralDeps,
): Promise<ReferralLandingRow | null> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_landings?id=${
      postgrestEq(landingId)
    }&anonymous_visitor_id=${postgrestEq(visitorId)}&select=id,referral_link_id,publisher_user_id,app_id,anonymous_visitor_id,user_id,landed_at,claimed_at&limit=1`,
    { headers: dbHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch referral landing (${response.status})`);
  }
  const rows = await response.json() as ReferralLandingRow[];
  return rows[0] || null;
}

async function fetchReferralGrantsForUser(
  userId: string,
  deps?: ReferralDeps,
): Promise<ReferralGrantRow[]> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_fee_waiver_grants?user_id=${
      postgrestEq(userId)
    }&source=eq.referral&select=id,publisher_user_id,source_landing_id,starts_at,expires_at&order=starts_at.asc`,
    { headers: dbHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch referral grants (${response.status})`);
  }
  return await response.json() as ReferralGrantRow[];
}

async function fetchLandingsForUser(
  userId: string,
  deps?: ReferralDeps,
): Promise<ReferralLandingRow[]> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_landings?user_id=${
      postgrestEq(userId)
    }&select=id,referral_link_id,publisher_user_id,app_id,anonymous_visitor_id,user_id,landed_at,claimed_at&order=landed_at.asc`,
    { headers: dbHeaders() },
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch user referral landings (${response.status})`);
  }
  return await response.json() as ReferralLandingRow[];
}

async function updateReferralGrantUser(
  grantId: string,
  userId: string,
  deps?: ReferralDeps,
): Promise<void> {
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_fee_waiver_grants?id=${postgrestEq(grantId)}`,
    {
      method: "PATCH",
      headers: jsonHeaders("return=minimal"),
      body: JSON.stringify({ user_id: userId }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to transfer referral grant (${response.status})`);
  }
}

async function claimReferralLanding(
  landing: ReferralLandingRow,
  userId: string,
  deps?: ReferralDeps,
): Promise<string | null> {
  if (userId === landing.publisher_user_id) return null;

  const existing = await fetchExistingReferralGrant(userId, landing.publisher_user_id, deps);
  if (existing) {
    await markLandingClaimed(landing.id, userId, deps);
    return existing.id;
  }

  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_fee_waiver_grants`,
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        user_id: userId,
        publisher_user_id: landing.publisher_user_id,
        source: "referral",
        source_landing_id: landing.id,
        starts_at: landing.landed_at,
        expires_at: addGrantDuration(landing.landed_at),
        metadata: {
          referral_link_id: landing.referral_link_id,
          app_id: landing.app_id,
        },
      }),
    },
  );

  if (response.ok) {
    const rows = await response.json() as ExistingGrantRow[];
    await markLandingClaimed(landing.id, userId, deps);
    return rows[0]?.id || null;
  }

  const body = await response.text().catch(() => "");
  if (response.status === 409 || body.includes("23505") || body.includes("duplicate")) {
    const racedExisting = await fetchExistingReferralGrant(userId, landing.publisher_user_id, deps);
    if (racedExisting) {
      await markLandingClaimed(landing.id, userId, deps);
      return racedExisting.id;
    }
  }

  throw new Error(`Failed to create referral grant (${response.status})`);
}

export async function claimReferralLandingsForUser(
  input: { userId: string; anonymousVisitorId?: string | null },
  deps: ReferralDeps = {},
): Promise<ReferralClaimResult> {
  const visitorId = normalizeVisitorId(input.anonymousVisitorId);
  if (!visitorId) return { claimedLandingCount: 0, grantIds: [] };

  const landings = await fetchClaimableLandingsForVisitor(visitorId, deps);
  const grantIds = new Set<string>();
  let claimedLandingCount = 0;

  for (const landing of landings) {
    const grantId = await claimReferralLanding(landing, input.userId, deps);
    if (grantId) grantIds.add(grantId);
    if (landing.publisher_user_id !== input.userId) claimedLandingCount += 1;
  }

  return {
    claimedLandingCount,
    grantIds: [...grantIds],
  };
}

export async function transferReferralAttributionBetweenUsers(
  sourceUserId: string,
  targetUserId: string,
  deps: ReferralDeps = {},
): Promise<ReferralTransferResult> {
  if (sourceUserId === targetUserId) {
    return { grantsTransferred: 0, grantsSkipped: 0, landingsClaimed: 0 };
  }

  const grants = await fetchReferralGrantsForUser(sourceUserId, deps);
  let grantsTransferred = 0;
  let grantsSkipped = 0;

  for (const grant of grants) {
    if (grant.publisher_user_id === targetUserId) {
      grantsSkipped += 1;
      continue;
    }

    const existing = await fetchExistingReferralGrant(targetUserId, grant.publisher_user_id, deps);
    if (!existing) {
      await updateReferralGrantUser(grant.id, targetUserId, deps);
      grantsTransferred += 1;
    } else {
      grantsSkipped += 1;
    }

    if (grant.source_landing_id) {
      await markLandingClaimed(grant.source_landing_id, targetUserId, deps);
    }
  }

  const sourceLandings = await fetchLandingsForUser(sourceUserId, deps);
  let landingsClaimed = 0;
  for (const landing of sourceLandings) {
    if (landing.publisher_user_id === targetUserId) continue;
    await claimReferralLanding(landing, targetUserId, deps);
    landingsClaimed += 1;
  }

  return {
    grantsTransferred,
    grantsSkipped,
    landingsClaimed,
  };
}

async function verifyReferralClaimToken(token: string, deps?: ReferralDeps): Promise<{
  landingId: string;
  visitorId: string;
} | null> {
  if (token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const expectedSignature = await hmacSha256Base64Url(parts[0]);
  if (!timingSafeEqual(parts[1], expectedSignature)) return null;

  let payload: {
    v?: unknown;
    landing_id?: unknown;
    visitor_id?: unknown;
    exp?: unknown;
  };
  try {
    payload = JSON.parse(base64UrlDecodeString(parts[0]));
  } catch {
    return null;
  }

  if (
    payload.v !== 1 ||
    typeof payload.landing_id !== "string" ||
    typeof payload.visitor_id !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (!normalizeVisitorId(payload.visitor_id)) return null;
  if ((deps?.now?.() || new Date()).getTime() > payload.exp) return null;

  return {
    landingId: payload.landing_id,
    visitorId: payload.visitor_id,
  };
}

export async function claimReferralTokenForUser(
  token: string,
  userId: string,
  deps: ReferralDeps = {},
): Promise<ReferralClaimResult> {
  const verified = await verifyReferralClaimToken(token, deps);
  if (!verified) return { claimedLandingCount: 0, grantIds: [] };

  const landing = await fetchLandingForClaimToken(verified.landingId, verified.visitorId, deps);
  if (!landing) return { claimedLandingCount: 0, grantIds: [] };
  if (landing.user_id && landing.user_id !== userId) {
    return { claimedLandingCount: 0, grantIds: [] };
  }

  const grantId = await claimReferralLanding(landing, userId, deps);
  return {
    claimedLandingCount: landing.publisher_user_id === userId ? 0 : 1,
    grantIds: grantId ? [grantId] : [],
  };
}

export async function recordReferralLanding(
  input: {
    slug: string;
    anonymousVisitorId?: string | null;
    userId?: string | null;
    metadata?: ReferralLandingMetadata;
  },
  deps: ReferralDeps = {},
): Promise<ReferralLandingResult> {
  const slug = input.slug.trim();
  if (!isValidReferralSlug(slug)) {
    return { status: "not_found" };
  }

  const link = await fetchActiveReferralLinkBySlug(slug, deps);
  if (!link) {
    return { status: "not_found" };
  }

  const appStillOwnedByPublisher = await appOwnerMatchesLink(link, deps);
  if (!appStillOwnedByPublisher) {
    await disableReferralLink(link.id, deps);
    return { status: "stale_owner", appId: link.app_id };
  }

  if (input.userId && input.userId === link.publisher_user_id) {
    return { status: "self_referral_ignored", appId: link.app_id };
  }

  const visitorId = normalizeVisitorId(input.anonymousVisitorId) || generateVisitorId();
  const response = await fetchFn(deps)(
    `${getEnv("SUPABASE_URL")}/rest/v1/publisher_referral_landings`,
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        referral_link_id: link.id,
        publisher_user_id: link.publisher_user_id,
        app_id: link.app_id,
        anonymous_visitor_id: visitorId,
        user_id: input.userId || null,
        claimed_at: null,
        ip_hash: input.metadata?.ipHash || null,
        user_agent_hash: input.metadata?.userAgentHash || null,
        landing_url: input.metadata?.landingUrl || null,
        referrer_url: input.metadata?.referrerUrl || null,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to record referral landing (${response.status})`);
  }

  const rows = await response.json() as ReferralLandingRow[];
  const landing = rows[0];
  if (!landing) {
    throw new Error("Referral landing insert returned no row");
  }

  const grantId = input.userId
    ? await claimReferralLanding(landing, input.userId, deps)
    : null;

  return {
    status: "recorded",
    appId: link.app_id,
    visitorId,
    landingId: landing.id,
    grantId,
  };
}
