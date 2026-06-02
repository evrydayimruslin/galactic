import type {
  LaunchDiscoveryRequest,
  LaunchDiscoveryResponse,
  LaunchInstallInstruction,
  LaunchLeaderboardKind,
  LaunchLeaderboardResponse,
  LaunchLibraryResponse,
  LaunchPlatformPrimitiveSuggestion,
  LaunchToolAdminSummary,
  LaunchToolSummary,
  LaunchWalletSummary,
} from '../../../../shared/contracts/launch.ts';

export interface LaunchInstallResponse {
  instructions: LaunchInstallInstruction[];
  generatedAt?: string;
}

export interface LaunchToolResponse {
  tool: LaunchToolSummary;
  trustCard?: unknown;
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
  trustCard?: unknown;
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

  install(): Promise<LaunchInstallResponse> {
    return this.fetchJson('/api/launch/install');
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

  private async fetchJson<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const token = this.getAuthToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${this.baseUrl}${path}`, { headers });
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
