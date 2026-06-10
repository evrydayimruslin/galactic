import type {
  LaunchAgentFunctionPermissionsResponse,
  LaunchAgentFunctionPermissionsUpdateRequest,
  LaunchApiKeyCreateRequest,
  LaunchApiKeyCreateResponse,
  LaunchApiKeyDeleteResponse,
  LaunchApiKeyListResponse,
  LaunchDiscoveryRequest,
  LaunchDiscoveryResponse,
  LaunchFunctionRunRequest,
  LaunchFunctionRunResponse,
  LaunchInstallInstruction,
  LaunchInstallResponse,
  LaunchLeaderboardKind,
  LaunchLeaderboardResponse,
  LaunchLibraryResponse,
  LaunchPlatformPrimitiveSuggestion,
  LaunchStoreRequest,
  LaunchStoreResponse,
  LaunchToolAdminSummary,
  LaunchToolFunctionsResponse,
  LaunchToolSummary,
  LaunchTrustCard,
  LaunchWalletDetailKind,
  LaunchWalletDetailResponse,
  LaunchWalletFundingIntentRequest,
  LaunchWalletFundingIntentResponse,
  LaunchWalletFundingMethod,
  LaunchWalletFundingQuoteResponse,
  LaunchWalletPageRequest,
  LaunchWalletSummary,
} from "../../../../shared/contracts/launch.ts";
import {
  clearLaunchAuthToken,
  getLaunchAuthToken,
  recordLaunchAuthDiagnostic,
  refreshLaunchSessionIfAvailable,
} from "./auth";

export interface LaunchToolResponse {
  tool: LaunchToolSummary;
  trustCard?: LaunchTrustCard;
  generatedAt?: string;
}

export interface LaunchWalletResponse {
  wallet: LaunchWalletSummary;
  generatedAt?: string;
}

export interface LaunchPlatformPrimitivesResponse {
  suggestions: LaunchPlatformPrimitiveSuggestion[];
  generatedAt?: string;
}

export interface LaunchToolAdminResponse {
  admin: LaunchToolAdminSummary;
  trustCard?: LaunchTrustCard;
  generatedAt?: string;
}

export interface LaunchApiClientOptions {
  baseUrl?: string;
  getAuthToken?: () => string | null;
  // Silent session refresh hook. Called when no token is available before a
  // request, and once after a 401, then the request is retried.
  refreshAuthToken?: () => Promise<string | null>;
}

export class LaunchApiAuthenticationError extends Error {
  override name = "LaunchApiAuthenticationError";
}

const configuredLaunchApiBaseUrl =
  import.meta.env.VITE_LAUNCH_API_BASE_URL?.trim().replace(/\/$/u, "") || "";

export interface LaunchLeaderboardRequest {
  period?: LaunchLeaderboardResponse["period"];
  limit?: number;
}

export class LaunchApiClient {
  private readonly baseUrl: string;
  private readonly getAuthToken?: () => string | null;
  private readonly refreshAuthToken?: () => Promise<string | null>;

  constructor(options: LaunchApiClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/u, "") || "";
    this.getAuthToken = options.getAuthToken;
    this.refreshAuthToken = options.refreshAuthToken;
  }

  status(): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/launch/status");
  }

  install(request: { tool?: string } = {}): Promise<LaunchInstallResponse> {
    const params = new URLSearchParams();
    if (request.tool) params.set("tool", request.tool);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.fetchJson(`/api/launch/install${suffix}`);
  }

  library(): Promise<LaunchLibraryResponse> {
    return this.fetchJson("/api/launch/library");
  }

  store(request: LaunchStoreRequest = {}): Promise<LaunchStoreResponse> {
    const params = new URLSearchParams();
    if (request.query) params.set("query", request.query);
    if (request.kind && request.kind !== "all") {
      params.set("kind", request.kind);
    }
    if (request.limit) params.set("limit", String(request.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.fetchJson(`/api/launch/store${suffix}`);
  }

  discover(
    request: LaunchDiscoveryRequest = {},
  ): Promise<LaunchDiscoveryResponse> {
    return this.store(request);
  }

  tool(idOrSlug: string): Promise<LaunchToolResponse> {
    return this.fetchJson(`/api/launch/tools/${encodeURIComponent(idOrSlug)}`);
  }

  toolFunctions(idOrSlug: string): Promise<LaunchToolFunctionsResponse> {
    return this.fetchJson(
      `/api/launch/tools/${encodeURIComponent(idOrSlug)}/functions`,
    );
  }

  runToolFunction(
    idOrSlug: string,
    functionName: string,
    request: LaunchFunctionRunRequest = {},
  ): Promise<LaunchFunctionRunResponse> {
    return this.fetchJson(
      `/api/launch/tools/${encodeURIComponent(idOrSlug)}/functions/${
        encodeURIComponent(functionName)
      }/run`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  toolAgentPermissions(
    idOrSlug: string,
  ): Promise<LaunchAgentFunctionPermissionsResponse> {
    return this.fetchJson(
      `/api/launch/tools/${encodeURIComponent(idOrSlug)}/agent-permissions`,
    );
  }

  updateToolAgentPermissions(
    idOrSlug: string,
    request: LaunchAgentFunctionPermissionsUpdateRequest,
  ): Promise<LaunchAgentFunctionPermissionsResponse> {
    return this.fetchJson(
      `/api/launch/tools/${encodeURIComponent(idOrSlug)}/agent-permissions`,
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
    );
  }

  wallet(): Promise<LaunchWalletResponse> {
    return this.fetchJson("/api/launch/wallet");
  }

  walletDetail(
    kind: LaunchWalletDetailKind,
    request: LaunchWalletPageRequest = {},
  ): Promise<LaunchWalletDetailResponse> {
    const params = new URLSearchParams();
    if (request.cursor) params.set("cursor", request.cursor);
    if (request.limit) params.set("limit", String(request.limit));
    if (request.tool) params.set("tool", request.tool);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.fetchJson(`/api/launch/wallet/${kind}${suffix}`);
  }

  walletTopUpQuote(request: {
    amountLight: number;
    method: LaunchWalletFundingMethod;
  }): Promise<LaunchWalletFundingQuoteResponse> {
    const params = new URLSearchParams({
      amount_light: String(request.amountLight),
      method: request.method,
    });
    return this.fetchJson(
      `/api/launch/wallet/topup/quote?${params.toString()}`,
    );
  }

  createWalletTopUpIntent(
    request: LaunchWalletFundingIntentRequest,
  ): Promise<LaunchWalletFundingIntentResponse> {
    return this.fetchJson("/api/launch/wallet/topup/intent", {
      method: "POST",
      body: JSON.stringify({
        amount_light: request.amountLight,
        method: request.method,
        terms_accepted: request.termsAccepted ?? true,
        ...(request.billingAddress !== undefined
          ? { billing_address: request.billingAddress }
          : {}),
      }),
    });
  }

  leaderboard(
    kind: LaunchLeaderboardKind = "builder",
    request: LaunchLeaderboardRequest = {},
  ): Promise<LaunchLeaderboardResponse> {
    const params = new URLSearchParams({ kind });
    if (request.period) params.set("period", request.period);
    if (request.limit) params.set("limit", String(request.limit));
    return this.fetchJson(
      `/api/launch/leaderboard?${params.toString()}`,
    );
  }

  platformPrimitives(): Promise<LaunchPlatformPrimitivesResponse> {
    return this.fetchJson("/api/launch/platform-primitives");
  }

  toolAdmin(id: string): Promise<LaunchToolAdminResponse> {
    return this.fetchJson(`/api/launch/admin/tools/${encodeURIComponent(id)}`);
  }

  apiKeys(): Promise<LaunchApiKeyListResponse> {
    return this.fetchJson("/api/launch/api-keys");
  }

  createApiKey(
    request: LaunchApiKeyCreateRequest,
  ): Promise<LaunchApiKeyCreateResponse> {
    return this.fetchJson("/api/launch/api-keys", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  revokeApiKey(id: string): Promise<LaunchApiKeyDeleteResponse> {
    return this.fetchJson(`/api/launch/api-keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  private async sendRequest(
    path: string,
    init: RequestInit,
    token: string | null,
  ): Promise<Response> {
    const headers = new Headers({ Accept: "application/json" });
    if (init.body) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }

    return await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
  }

  private async fetchJson<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    let token = this.getAuthToken?.() || null;
    // The stored access token expired (or was cleared) but the API may have
    // granted a refresh cookie — restore the session before the request.
    if (!token && this.refreshAuthToken) {
      token = await this.refreshAuthToken().catch(() => null);
    }

    let response = await this.sendRequest(path, init, token);

    // One silent refresh + retry on a rejected token. Request bodies here are
    // always strings, so re-sending is safe.
    if (response.status === 401 && token && this.refreshAuthToken) {
      const refreshedToken = await this.refreshAuthToken().catch(() => null);
      if (refreshedToken && refreshedToken !== token) {
        token = refreshedToken;
        response = await this.sendRequest(path, init, token);
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = text;
      try {
        const parsed = JSON.parse(text) as {
          error?: unknown;
          message?: unknown;
        };
        message = String(parsed.error || parsed.message || text);
      } catch {
        // Keep the raw text response.
      }
      if (response.status === 401) {
        if (token) {
          clearLaunchAuthToken();
          recordLaunchAuthDiagnostic({
            message: message || "The launch API rejected the stored session.",
            status: "session_expired",
          });
        }
        throw new LaunchApiAuthenticationError(
          message || "Authentication required",
        );
      }
      throw new Error(
        message || `Launch API request failed (${response.status})`,
      );
    }
    return await response.json() as T;
  }
}

export const launchApi = new LaunchApiClient({
  baseUrl: configuredLaunchApiBaseUrl,
  getAuthToken: getLaunchAuthToken,
  refreshAuthToken: refreshLaunchSessionIfAvailable,
});
