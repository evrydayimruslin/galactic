const launchApiBaseUrl =
  import.meta.env.VITE_LAUNCH_API_BASE_URL?.trim().replace(/\/$/u, "") || "";

export const LAUNCH_AUTH_TOKEN_KEY = "ultralight.launch.authToken";
export const LAUNCH_AUTH_EXPIRES_AT_KEY = "ultralight.launch.authExpiresAt";
export const LAUNCH_AUTH_DIAGNOSTIC_KEY = "ultralight.launch.authDiagnostic";
// Marker that the API set an HttpOnly refresh cookie for this browser. The
// cookie itself is invisible to JS; without the marker every signed-out
// visitor would burn a refresh round-trip per API call.
export const LAUNCH_AUTH_REFRESH_AVAILABLE_KEY =
  "ultralight.launch.refreshAvailable";
export const LAUNCH_AUTH_GENERATION_KEY =
  "ultralight.launch.authGeneration";
export const LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY =
  "ultralight.launch.signedOutGeneration";
export const LAUNCH_AUTH_SESSION_CHANGED_EVENT =
  "galactic:launch-auth-session-changed";
const AUTH_EXPIRY_SKEW_MS = 30_000;
// Keep the original refresh lock name so tabs running the prior deployment
// still serialize their cookie rotation with a logout from this deployment.
const LAUNCH_AUTH_SESSION_LOCK_NAME = "ultralight:launch-refresh";

export type LaunchAuthDiagnosticStatus =
  | "redirecting"
  | "callback_loaded"
  | "callback_missing_bridge"
  | "exchange_started"
  | "exchange_succeeded"
  | "provider_code_misrouted"
  | "session_expired"
  | "session_refreshed"
  | "refresh_failed"
  | "token_stored"
  | "exchange_failed";

export interface LaunchAuthDiagnostic {
  at: string;
  bridgeTokenPresent?: boolean;
  expiresIn?: string | null;
  message?: string;
  nextPath?: string;
  status: LaunchAuthDiagnosticStatus;
}

export interface LaunchAuthExchangeResponse {
  access_token: string;
  audience: "launch_web";
  expires_in: number | null;
  refresh_supported?: boolean;
  user: {
    email: string;
    id: string;
    metadata?: Record<string, unknown>;
  };
}

export interface LaunchPasswordAuthResponse {
  access_token?: string;
  audience: "launch_web";
  confirmation_required: boolean;
  email?: string;
  expires_in?: number | null;
  refresh_supported?: boolean;
  user?: {
    email: string;
    id: string;
    metadata?: Record<string, unknown>;
  };
}

export interface LaunchMagicLinkRequestResponse {
  audience: "launch_web";
  email: string;
  link_sent: true;
}

export function launchAuthSubject(token: string | null): string | null {
  const encodedPayload = token?.split(".")[1];
  if (!encodedPayload) return null;

  try {
    const normalized = encodedPayload.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(globalThis.atob(padded)) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.length > 0
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

/**
 * Stable, non-secret browser cache scope for the current account.
 *
 * Valid launch access tokens always carry a Supabase subject. The opaque
 * fallback keeps malformed/non-standard tokens separated without ever putting
 * the bearer token itself into a cache key or diagnostic surface.
 */
export function launchAuthSessionIdentity(token: string | null): string {
  if (!token) return "public";
  const subject = launchAuthSubject(token);
  return subject
    ? `user:${subject}`
    : `opaque:${token.length}:${fingerprintLaunchAuthToken(token)}`;
}

export function isLaunchAuthSessionStorageChange(
  key: string | null,
): boolean {
  return key === null ||
    key === LAUNCH_AUTH_TOKEN_KEY ||
    key === LAUNCH_AUTH_GENERATION_KEY ||
    key === LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY;
}

function fingerprintLaunchAuthToken(token: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function announceLaunchAuthSessionChange(
  previousToken: string | null,
  nextToken: string | null,
): void {
  if (previousToken === nextToken || typeof window === "undefined") return;
  window.dispatchEvent(new Event(LAUNCH_AUTH_SESSION_CHANGED_EVENT));
}

export function getLaunchAuthToken(): string | null {
  const token = window.localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY);
  if (!token) return null;
  const expiresAt = launchAuthExpiresAt();
  if (expiresAt && Date.now() + AUTH_EXPIRY_SKEW_MS >= expiresAt) {
    clearLaunchAuthToken();
    recordLaunchAuthDiagnostic({
      message: "The launch web session expired before an API request.",
      status: "session_expired",
    });
    return null;
  }
  return token;
}

export function hasLaunchAuthToken(): boolean {
  return Boolean(getLaunchAuthToken());
}

export function setLaunchAuthToken(
  token: string,
  expiresInSeconds?: number | null,
): void {
  clearLaunchAuthSignOutTombstone(readLaunchAuthGeneration());
  writeLaunchAuthToken(token, expiresInSeconds);
}

function writeLaunchAuthToken(
  token: string,
  expiresInSeconds?: number | null,
): void {
  const previousToken = window.localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY);
  window.localStorage.setItem(LAUNCH_AUTH_TOKEN_KEY, token);
  if (typeof expiresInSeconds === "number" && expiresInSeconds > 0) {
    window.localStorage.setItem(
      LAUNCH_AUTH_EXPIRES_AT_KEY,
      String(Date.now() + expiresInSeconds * 1000),
    );
  } else {
    window.localStorage.removeItem(LAUNCH_AUTH_EXPIRES_AT_KEY);
  }
  announceLaunchAuthSessionChange(previousToken, token);
}

export function clearLaunchAuthToken(): void {
  const previousToken = window.localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY);
  window.localStorage.removeItem(LAUNCH_AUTH_TOKEN_KEY);
  window.localStorage.removeItem(LAUNCH_AUTH_EXPIRES_AT_KEY);
  announceLaunchAuthSessionChange(previousToken, null);
}

export function isLaunchRefreshAvailable(): boolean {
  return window.localStorage.getItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY) === "1";
}

export function setLaunchRefreshAvailable(value: boolean): void {
  if (value) {
    if (isLaunchAuthGenerationSignedOut(readLaunchAuthGeneration())) return;
    window.localStorage.setItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY, "1");
  } else {
    window.localStorage.removeItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY);
  }
}

function readLaunchAuthGeneration(): number {
  const raw = window.localStorage.getItem(LAUNCH_AUTH_GENERATION_KEY);
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) &&
      parsed >= 0 &&
      parsed < Number.MAX_SAFE_INTEGER
    ? parsed
    : 0;
}

function beginLaunchAuthSignOut(): number {
  const current = readLaunchAuthGeneration();
  const next = Math.max(current + 1, Date.now());
  window.localStorage.setItem(LAUNCH_AUTH_GENERATION_KEY, String(next));
  window.localStorage.setItem(
    LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY,
    String(next),
  );
  return next;
}

function isCurrentLaunchAuthGeneration(generation: number): boolean {
  return readLaunchAuthGeneration() === generation;
}

function isLaunchAuthGenerationSignedOut(generation: number): boolean {
  return window.localStorage.getItem(
    LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY,
  ) === String(generation);
}

function clearLaunchAuthSignOutTombstone(generation: number): void {
  if (isLaunchAuthGenerationSignedOut(generation)) {
    window.localStorage.removeItem(LAUNCH_AUTH_SIGNED_OUT_GENERATION_KEY);
  }
}

async function withLaunchAuthSessionLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks?.request) {
    return await locks.request(LAUNCH_AUTH_SESSION_LOCK_NAME, operation);
  }
  return await operation();
}

export function getLaunchAuthDiagnostic(): LaunchAuthDiagnostic | null {
  try {
    const raw = window.localStorage.getItem(LAUNCH_AUTH_DIAGNOSTIC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LaunchAuthDiagnostic;
    return parsed && typeof parsed.status === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function recordLaunchAuthDiagnostic(
  diagnostic: Omit<LaunchAuthDiagnostic, "at">,
): void {
  try {
    window.localStorage.setItem(
      LAUNCH_AUTH_DIAGNOSTIC_KEY,
      JSON.stringify({ ...diagnostic, at: new Date().toISOString() }),
    );
  } catch {
    // Diagnostics are best-effort and should never block sign-in.
  }
}

export function buildLaunchSignInUrl(nextPath = currentLaunchPath()): string {
  const apiBase = launchApiBaseUrl || window.location.origin;
  const returnTo = new URL(
    normalizeLocalPath(nextPath),
    window.location.origin,
  );
  const loginUrl = new URL("/auth/login", apiBase);
  loginUrl.searchParams.set("return_to", returnTo.toString());
  return loginUrl.toString();
}

async function readLaunchAuthResponse(
  response: Response,
): Promise<LaunchPasswordAuthResponse> {
  const payload = await response.json().catch(() => null) as
    | (LaunchPasswordAuthResponse & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.error || `Authentication failed (${response.status})`,
    );
  }
  if (!payload) {
    throw new Error("Authentication returned an empty response.");
  }
  return payload;
}

function storeLaunchPasswordSession(
  payload: LaunchPasswordAuthResponse,
  generation: number,
): void {
  if (!payload.access_token) return;
  if (
    !commitLaunchAuthSession(
      payload.access_token,
      payload.expires_in,
      Boolean(payload.refresh_supported),
      generation,
      true,
    )
  ) {
    throw new Error("Authentication was superseded by sign-out.");
  }
}

export async function requestLaunchMagicLink(
  email: string,
  nextPath = currentLaunchPath(),
): Promise<LaunchMagicLinkRequestResponse> {
  const apiBase = launchApiBaseUrl || window.location.origin;
  const response = await fetch(`${apiBase}/auth/launch/magic-link`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      next: normalizeLocalPath(nextPath),
    }),
  });
  const payload = await response.json().catch(() => null) as
    | (LaunchMagicLinkRequestResponse & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.error || `Unable to send sign-in link (${response.status})`,
    );
  }
  if (!payload?.link_sent) {
    throw new Error("Email sign-in returned an empty response.");
  }
  return payload;
}

export async function establishLaunchMagicLinkSession(
  tokenHash: string,
): Promise<LaunchPasswordAuthResponse> {
  const generation = readLaunchAuthGeneration();
  return await withLaunchAuthSessionLock(async () => {
    const apiBase = launchApiBaseUrl || window.location.origin;
    const response = await fetch(`${apiBase}/auth/launch/verify`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token_hash: tokenHash }),
    });
    const payload = await readLaunchAuthResponse(response);
    storeLaunchPasswordSession(payload, generation);
    return payload;
  });
}

export async function authenticateLaunchWithPassword(
  mode: "sign_in" | "sign_up",
  email: string,
  password: string,
  nextPath = currentLaunchPath(),
): Promise<LaunchPasswordAuthResponse> {
  const generation = readLaunchAuthGeneration();
  return await withLaunchAuthSessionLock(async () => {
    const apiBase = launchApiBaseUrl || window.location.origin;
    const response = await fetch(`${apiBase}/auth/launch/password`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        mode,
        next: normalizeLocalPath(nextPath),
        password,
      }),
    });
    const payload = await readLaunchAuthResponse(response);
    storeLaunchPasswordSession(payload, generation);
    return payload;
  });
}

export async function establishLaunchConfirmationSession(
  accessToken: string,
  refreshToken: string | null,
): Promise<LaunchPasswordAuthResponse> {
  const generation = readLaunchAuthGeneration();
  return await withLaunchAuthSessionLock(async () => {
    const apiBase = launchApiBaseUrl || window.location.origin;
    const response = await fetch(`${apiBase}/auth/launch/session`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        access_token: accessToken,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      }),
    });
    const payload = await readLaunchAuthResponse(response);
    storeLaunchPasswordSession(payload, generation);
    return payload;
  });
}

export async function exchangeLaunchBridgeToken(
  bridgeToken: string,
): Promise<LaunchAuthExchangeResponse> {
  const generation = readLaunchAuthGeneration();
  return await withLaunchAuthSessionLock(async () => {
    const apiBase = launchApiBaseUrl || window.location.origin;
    // credentials: "include" lets the exchange set the HttpOnly cross-origin
    // refresh cookie alongside the returned bearer token.
    const response = await fetch(`${apiBase}/auth/launch/exchange`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bridge_token: bridgeToken }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `Sign-in exchange failed (${response.status})`);
    }

    const payload = await response.json() as LaunchAuthExchangeResponse;
    if (
      !commitLaunchAuthSession(
        payload.access_token,
        payload.expires_in,
        Boolean(payload.refresh_supported),
        generation,
        true,
      )
    ) {
      throw new Error("Authentication was superseded by sign-out.");
    }
    return payload;
  });
}

function commitLaunchAuthSession(
  token: string,
  expiresInSeconds: number | null | undefined,
  refreshSupported: boolean,
  generation: number,
  establishesSession: boolean,
): boolean {
  if (!isCurrentLaunchAuthGeneration(generation)) return false;
  if (
    isLaunchAuthGenerationSignedOut(generation) &&
    !establishesSession
  ) {
    return false;
  }

  if (establishesSession) clearLaunchAuthSignOutTombstone(generation);
  if (
    !isCurrentLaunchAuthGeneration(generation) ||
    isLaunchAuthGenerationSignedOut(generation)
  ) {
    return false;
  }

  writeLaunchAuthToken(token, expiresInSeconds);
  if (
    !isCurrentLaunchAuthGeneration(generation) ||
    isLaunchAuthGenerationSignedOut(generation)
  ) {
    clearLaunchAuthTokenIfMatching(token);
    setLaunchRefreshAvailable(false);
    return false;
  }

  setLaunchRefreshAvailable(refreshSupported);
  if (
    !isCurrentLaunchAuthGeneration(generation) ||
    isLaunchAuthGenerationSignedOut(generation)
  ) {
    clearLaunchAuthTokenIfMatching(token);
    setLaunchRefreshAvailable(false);
    return false;
  }
  return true;
}

function clearLaunchAuthTokenIfMatching(token: string): void {
  if (window.localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY) !== token) return;
  clearLaunchAuthToken();
}

interface LaunchRefreshInFlight {
  generation: number;
  promise: Promise<string | null>;
}

let refreshInFlight: LaunchRefreshInFlight | null = null;

async function performLaunchSessionRefresh(
  generation: number,
  establishesSession: boolean,
): Promise<string | null> {
  const apiBase = launchApiBaseUrl || window.location.origin;
  let response: Response;
  try {
    response = await fetch(`${apiBase}/auth/launch/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  } catch {
    // Network failure is transient — keep the refresh marker so a later
    // attempt can still succeed.
    return null;
  }

  if (!response.ok) {
    if (
      (response.status === 401 || response.status === 403) &&
      isCurrentLaunchAuthGeneration(generation)
    ) {
      setLaunchRefreshAvailable(false);
      recordLaunchAuthDiagnostic({
        message: "The launch session refresh was rejected.",
        status: "refresh_failed",
      });
    }
    return null;
  }

  const payload = await response.json().catch(() => null) as
    | LaunchAuthExchangeResponse
    | null;
  if (!payload?.access_token) return null;

  const committed = commitLaunchAuthSession(
    payload.access_token,
    payload.expires_in,
    payload.refresh_supported !== false,
    generation,
    establishesSession,
  );
  if (!committed) return null;

  recordLaunchAuthDiagnostic({
    expiresIn: String(payload.expires_in ?? ""),
    status: "session_refreshed",
  });
  return payload.access_token;
}

// Silently rotate the launch session via the HttpOnly refresh cookie.
// Single-flight within this tab, and serialized ACROSS tabs via the Web Locks
// API: tabs share the refresh cookie, and Supabase's refresh-token-reuse
// detection revokes the whole token family when two tabs rotate the same
// token outside the reuse window.
export function refreshLaunchSession(
  options: { establishSession?: boolean } = {},
): Promise<string | null> {
  const generation = readLaunchAuthGeneration();
  const establishesSession = options.establishSession === true;
  if (
    isLaunchAuthGenerationSignedOut(generation) &&
    !establishesSession
  ) {
    return Promise.resolve(null);
  }
  if (refreshInFlight?.generation === generation) {
    return refreshInFlight.promise;
  }

  // Raw read (not getLaunchAuthToken — that self-clears on expiry): if the
  // stored token CHANGES while we wait on the lock, another tab already
  // rotated, and its result is in shared localStorage.
  const tokenAtEntry = window.localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY);
  let promise: Promise<string | null>;
  promise = withLaunchAuthSessionLock(async () => {
    if (!isCurrentLaunchAuthGeneration(generation)) return null;
    if (
      isLaunchAuthGenerationSignedOut(generation) &&
      !establishesSession
    ) {
      return null;
    }

    const current = window.localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY);
    if (current && current !== tokenAtEntry) return current;
    return await performLaunchSessionRefresh(generation, establishesSession);
  }).finally(() => {
    if (refreshInFlight?.promise === promise) refreshInFlight = null;
  });
  refreshInFlight = { generation, promise };
  return promise;
}

// Refresh only when the API previously granted a refresh cookie — avoids a
// guaranteed-401 round-trip on every call for signed-out visitors.
export async function refreshLaunchSessionIfAvailable(): Promise<
  string | null
> {
  if (!isLaunchRefreshAvailable()) return null;
  return await refreshLaunchSession();
}

export async function signOutLaunch(): Promise<void> {
  const token = getLaunchAuthToken();
  const signOutGeneration = beginLaunchAuthSignOut();
  clearLaunchAuthToken();
  setLaunchRefreshAvailable(false);

  await withLaunchAuthSessionLock(async () => {
    // A genuinely new passwordless/OAuth completion may establish a newer
    // session while this operation waits behind another tab. Do not revoke
    // that replacement session.
    if (
      !isCurrentLaunchAuthGeneration(signOutGeneration) ||
      !isLaunchAuthGenerationSignedOut(signOutGeneration)
    ) {
      return;
    }

    // A tab running the previous bundle may have completed a refresh while
    // this logout waited for the legacy-named Web Lock. Clear its localStorage
    // write before revoking the shared cookie.
    clearLaunchAuthToken();
    setLaunchRefreshAvailable(false);

    const apiBase = launchApiBaseUrl || window.location.origin;
    // credentials: "include" so the response can clear the HttpOnly refresh
    // cookie along with revoking the Supabase session. Always make the call:
    // an in-flight refresh handoff can own a live HttpOnly cookie before the
    // shared browser marker is written.
    await fetch(`${apiBase}/auth/signout`, {
      method: "POST",
      credentials: "include",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope: "local" }),
    }).catch(() => {});

    // Fail closed even if an older, unlocked auth path wrote during the
    // request. A newer session clears this tombstone and is left untouched.
    if (isLaunchAuthGenerationSignedOut(signOutGeneration)) {
      clearLaunchAuthToken();
      setLaunchRefreshAvailable(false);
    }
  });
}

export function normalizeLocalPath(value: string | null | undefined): string {
  if (
    !value || !value.startsWith("/") || value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/account";
  }
  return value;
}

export function resolveMagicLinkNextPath(
  value: string | null | undefined,
  origin = window.location.origin,
): string {
  if (!value) return "/account";
  try {
    const target = new URL(value, origin);
    if (target.origin !== new URL(origin).origin) return "/account";
    if (
      target.pathname === "/auth/callback" ||
      target.pathname === "/auth/confirm"
    ) {
      return normalizeLocalPath(target.searchParams.get("next"));
    }
    return normalizeLocalPath(`${target.pathname}${target.search}`);
  } catch {
    return "/account";
  }
}

function currentLaunchPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function launchAuthExpiresAt(): number | null {
  const raw = window.localStorage.getItem(LAUNCH_AUTH_EXPIRES_AT_KEY);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}
