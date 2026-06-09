const launchApiBaseUrl =
  import.meta.env.VITE_LAUNCH_API_BASE_URL?.trim().replace(/\/$/u, "") || "";

export const LAUNCH_AUTH_TOKEN_KEY = "ultralight.launch.authToken";

export interface LaunchAuthExchangeResponse {
  access_token: string;
  audience: "launch_web";
  expires_in: number | null;
  user: {
    email: string;
    id: string;
    metadata?: Record<string, unknown>;
  };
}

export function getLaunchAuthToken(): string | null {
  return window.localStorage.getItem(LAUNCH_AUTH_TOKEN_KEY);
}

export function hasLaunchAuthToken(): boolean {
  return Boolean(getLaunchAuthToken());
}

export function setLaunchAuthToken(token: string): void {
  window.localStorage.setItem(LAUNCH_AUTH_TOKEN_KEY, token);
}

export function clearLaunchAuthToken(): void {
  window.localStorage.removeItem(LAUNCH_AUTH_TOKEN_KEY);
}

export function buildLaunchSignInUrl(nextPath = currentLaunchPath()): string {
  const apiBase = launchApiBaseUrl || window.location.origin;
  const returnTo = new URL(normalizeLocalPath(nextPath), window.location.origin);
  const loginUrl = new URL("/auth/login", apiBase);
  loginUrl.searchParams.set("return_to", returnTo.toString());
  return loginUrl.toString();
}

export async function exchangeLaunchBridgeToken(
  bridgeToken: string,
): Promise<LaunchAuthExchangeResponse> {
  const apiBase = launchApiBaseUrl || window.location.origin;
  const response = await fetch(`${apiBase}/auth/launch/exchange`, {
    method: "POST",
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

  return await response.json() as LaunchAuthExchangeResponse;
}

export async function signOutLaunch(): Promise<void> {
  const token = getLaunchAuthToken();
  clearLaunchAuthToken();
  if (!token) return;

  const apiBase = launchApiBaseUrl || window.location.origin;
  await fetch(`${apiBase}/auth/signout`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ scope: "local" }),
  }).catch(() => {});
}

export function normalizeLocalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/settings";
  }
  return value;
}

function currentLaunchPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}
