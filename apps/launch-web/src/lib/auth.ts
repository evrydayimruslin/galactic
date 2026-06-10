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
const AUTH_EXPIRY_SKEW_MS = 30_000;

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
  window.localStorage.setItem(LAUNCH_AUTH_TOKEN_KEY, token);
  if (typeof expiresInSeconds === "number" && expiresInSeconds > 0) {
    window.localStorage.setItem(
      LAUNCH_AUTH_EXPIRES_AT_KEY,
      String(Date.now() + expiresInSeconds * 1000),
    );
  } else {
    window.localStorage.removeItem(LAUNCH_AUTH_EXPIRES_AT_KEY);
  }
}

export function clearLaunchAuthToken(): void {
  window.localStorage.removeItem(LAUNCH_AUTH_TOKEN_KEY);
  window.localStorage.removeItem(LAUNCH_AUTH_EXPIRES_AT_KEY);
}

export function isLaunchRefreshAvailable(): boolean {
  return window.localStorage.getItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY) === "1";
}

export function setLaunchRefreshAvailable(value: boolean): void {
  if (value) {
    window.localStorage.setItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY, "1");
  } else {
    window.localStorage.removeItem(LAUNCH_AUTH_REFRESH_AVAILABLE_KEY);
  }
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

export async function exchangeLaunchBridgeToken(
  bridgeToken: string,
): Promise<LaunchAuthExchangeResponse> {
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
  setLaunchRefreshAvailable(Boolean(payload.refresh_supported));
  return payload;
}

let refreshInFlight: Promise<string | null> | null = null;

// Silently rotate the launch session via the HttpOnly refresh cookie.
// Single-flight: Supabase rotates refresh tokens, so concurrent refresh
// calls would race each other into 401s.
export function refreshLaunchSession(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
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
      if (response.status === 401 || response.status === 403) {
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

    setLaunchAuthToken(payload.access_token, payload.expires_in);
    setLaunchRefreshAvailable(payload.refresh_supported !== false);
    recordLaunchAuthDiagnostic({
      expiresIn: String(payload.expires_in ?? ""),
      status: "session_refreshed",
    });
    return payload.access_token;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
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
  const hadRefreshCookie = isLaunchRefreshAvailable();
  clearLaunchAuthToken();
  setLaunchRefreshAvailable(false);
  // Even with an expired local token, the HttpOnly refresh cookie may still
  // be live server-side — call signout so the response clears it.
  if (!token && !hadRefreshCookie) return;

  const apiBase = launchApiBaseUrl || window.location.origin;
  // credentials: "include" so the response can clear the HttpOnly refresh
  // cookie along with revoking the Supabase session.
  await fetch(`${apiBase}/auth/signout`, {
    method: "POST",
    credentials: "include",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scope: "local" }),
  }).catch(() => {});
}

export function normalizeLocalPath(value: string | null | undefined): string {
  if (
    !value || !value.startsWith("/") || value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/settings";
  }
  return value;
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
