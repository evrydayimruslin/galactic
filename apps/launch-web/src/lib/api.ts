import type {
  LaunchApiKeyCreateRequest,
  LaunchApiKeyCreateResponse,
  LaunchApiKeyDeleteResponse,
  LaunchApiKeyListResponse,
  LaunchDiscoveryRequest,
  LaunchDiscoveryResponse,
  LaunchInstallInstruction,
  LaunchInstallResponse,
  LaunchLeaderboardKind,
  LaunchLeaderboardResponse,
  LaunchLibraryResponse,
  LaunchPlatformPrimitiveSuggestion,
  LaunchToolAdminSummary,
  LaunchToolSummary,
  LaunchTrustCard,
  LaunchWalletSummary,
  LaunchWidgetDetailResponse,
  LaunchWidgetRenderRequest,
  LaunchWidgetRenderResponse,
} from '../../../../shared/contracts/launch.ts';

export interface LaunchToolResponse {
  tool: LaunchToolSummary;
  trustCard?: LaunchTrustCard;
  generatedAt?: string;
}

export interface LaunchToolWidgetsResponse {
  tool: Pick<
    LaunchToolSummary,
    'id' | 'slug' | 'name' | 'relationship' | 'publicUrl' | 'adminUrl'
  >;
  widgets: LaunchToolSummary['widgets'];
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
}

export interface LaunchLeaderboardRequest {
  period?: LaunchLeaderboardResponse['period'];
  limit?: number;
}

export class LaunchApiClient {
  private readonly baseUrl: string;
  private readonly getAuthToken?: () => string | null;

  constructor(options: LaunchApiClientOptions = {}) {
    this.baseUrl = options.baseUrl?.replace(/\/$/u, '') || '';
    this.getAuthToken = options.getAuthToken;
  }

  install(request: { tool?: string } = {}): Promise<LaunchInstallResponse> {
    const params = new URLSearchParams();
    if (request.tool) params.set('tool', request.tool);
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.fetchJson(`/api/launch/install${suffix}`);
  }

  library(): Promise<LaunchLibraryResponse> {
    return this.fetchJson('/api/launch/library');
  }

  discover(
    request: LaunchDiscoveryRequest = {},
  ): Promise<LaunchDiscoveryResponse> {
    const params = new URLSearchParams();
    if (request.query) params.set('query', request.query);
    if (request.kind && request.kind !== 'all') {
      params.set('kind', request.kind);
    }
    if (request.includeWidgets !== undefined) {
      params.set('includeWidgets', String(request.includeWidgets));
    }
    if (request.limit) params.set('limit', String(request.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.fetchJson(`/api/launch/discover${suffix}`);
  }

  tool(idOrSlug: string): Promise<LaunchToolResponse> {
    return this.fetchJson(`/api/launch/tools/${encodeURIComponent(idOrSlug)}`);
  }

  toolWidgets(
    idOrSlug: string,
  ): Promise<LaunchToolWidgetsResponse> {
    return this.fetchJson(
      `/api/launch/tools/${encodeURIComponent(idOrSlug)}/widgets`,
    );
  }

  widgetDetail(
    idOrSlug: string,
    widgetId: string,
  ): Promise<LaunchWidgetDetailResponse> {
    return this.fetchJson(
      `/api/launch/tools/${encodeURIComponent(idOrSlug)}/widgets/${
        encodeURIComponent(widgetId)
      }`,
    );
  }

  renderWidget(
    idOrSlug: string,
    widgetId: string,
    request: LaunchWidgetRenderRequest = {},
  ): Promise<LaunchWidgetRenderResponse> {
    return this.fetchJson(
      `/api/launch/tools/${encodeURIComponent(idOrSlug)}/widgets/${
        encodeURIComponent(widgetId)
      }/render`,
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
    );
  }

  wallet(): Promise<LaunchWalletResponse> {
    return this.fetchJson('/api/launch/wallet');
  }

  leaderboard(
    kind: LaunchLeaderboardKind = 'builder',
    request: LaunchLeaderboardRequest = {},
  ): Promise<LaunchLeaderboardResponse> {
    const params = new URLSearchParams({ kind });
    if (request.period) params.set('period', request.period);
    if (request.limit) params.set('limit', String(request.limit));
    return this.fetchJson(
      `/api/launch/leaderboard?${params.toString()}`,
    );
  }

  platformPrimitives(): Promise<LaunchPlatformPrimitivesResponse> {
    return this.fetchJson('/api/launch/platform-primitives');
  }

  toolAdmin(id: string): Promise<LaunchToolAdminResponse> {
    return this.fetchJson(`/api/launch/admin/tools/${encodeURIComponent(id)}`);
  }

  apiKeys(): Promise<LaunchApiKeyListResponse> {
    return this.fetchJson('/api/launch/api-keys');
  }

  createApiKey(
    request: LaunchApiKeyCreateRequest,
  ): Promise<LaunchApiKeyCreateResponse> {
    return this.fetchJson('/api/launch/api-keys', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  revokeApiKey(id: string): Promise<LaunchApiKeyDeleteResponse> {
    return this.fetchJson(`/api/launch/api-keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  private async fetchJson<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    if (init.body) headers.set('Content-Type', 'application/json');
    const token = this.getAuthToken?.();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers.set(key, value);
      });
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(
        message || `Launch API request failed (${response.status})`,
      );
    }
    return await response.json() as T;
  }
}

export const launchApi = new LaunchApiClient({
  getAuthToken: () => window.localStorage.getItem('ultralight.launch.authToken'),
});
