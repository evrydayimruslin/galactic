import type {
  AgentGrantApproveRequest,
  AgentGrantCreateRequest,
  AgentGrantSummary,
  AgentGrantUpdateRequest,
  AgentWiringTarget,
  AgentWiringView,
} from "../../../../shared/contracts/agent-grants.ts";
import type {
  LaunchAgentAdminSummary,
  LaunchAgentActivityResponse,
  LaunchAgentAttentionActionRequest,
  LaunchAgentAttentionActionResponse,
  LaunchAgentAttentionProjection,
  LaunchAgentFunctionsResponse,
  LaunchAgentCapacityResponse,
  LaunchAgentCapacityUpdateRequest,
  LaunchAgentHomeActionRequest,
  LaunchAgentHomeIdentityUpdateRequest,
  LaunchAgentHomeResponse,
  LaunchAgentHomeRoutineUpdateRequest,
  LaunchAgentHomeSettingsUpdateRequest,
  LaunchAgentRoutineActionRequest,
  LaunchAgentManagedRoutineActionRequest,
  LaunchAgentManagedRoutineUpdateRequest,
  LaunchAgentPreferencesResponse,
  LaunchAgentPreferencesUpdateRequest,
  LaunchAgentRoutineResponse,
  LaunchAgentRoutinesResponse,
  LaunchAgentRoutineUpdateRequest,
  LaunchAgentSummary,
  LaunchApiKeyCreateRequest,
  LaunchApiKeyCreateResponse,
  LaunchApiKeyDeleteResponse,
  LaunchApiKeyListResponse,
  LaunchByokMutationResponse,
  LaunchCallerFunctionPermissionsResponse,
  LaunchNotificationsMarkReadResponse,
  LaunchNotificationsResponse,
  LaunchCallerFunctionPermissionsUpdateRequest,
  LaunchFunctionInferenceOverrideRequest,
  LaunchFunctionInferenceResponse,
  LaunchByokPrimaryRequest,
  LaunchByokSummaryResponse,
  LaunchByokUpsertRequest,
  LaunchDiscoveryRequest,
  LaunchDiscoveryResponse,
  LaunchFunctionRunRequest,
  LaunchFunctionRunResponse,
  LaunchGlobalAttentionResponse,
  LaunchInferenceOptionsResponse,
  LaunchPlatformModelRequest,
  LaunchPlatformModelResponse,
  LaunchInstallInstruction,
  LaunchInstallResponse,
  LaunchJobStatusResponse,
  LaunchLeaderboardKind,
  LaunchLeaderboardResponse,
  LaunchFolderMemberMutationResponse,
  LaunchFolderMutationResponse,
  LaunchFleetOrderResponse,
  LaunchFleetOrderUpdateRequest,
  LaunchFleetPreferencesResponse,
  LaunchFleetPreferencesUpdateRequest,
  LaunchFleetResponse,
  LaunchLibraryResponse,
  LaunchPlatformPrimitiveSuggestion,
  LaunchStoreRequest,
  LaunchStoreResponse,
  LaunchAgentSearchRequest,
  LaunchAgentSearchResponse,
  LaunchSubscriptionResponse,
  LaunchSubscriptionRedirectResponse,
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
import type {
  LaunchComputeRunSummary,
  LaunchComputeRunsResponse,
  LaunchComputeSettingsResponse,
  LaunchComputeSettingsUpdateRequest,
} from "./compute";

export interface LaunchAgentResponse {
  agent?: LaunchAgentSummary;
  /** @deprecated Alias emitted during the Tools -> Agents rename window. */
  tool?: LaunchAgentSummary;
  trustCard?: LaunchTrustCard;
  generatedAt?: string;
}

/** @deprecated Use LaunchAgentResponse. */
export type LaunchToolResponse = LaunchAgentResponse;

export interface LaunchWalletResponse {
  wallet: LaunchWalletSummary;
  generatedAt?: string;
}

export interface LaunchPlatformPrimitivesResponse {
  suggestions: LaunchPlatformPrimitiveSuggestion[];
  generatedAt?: string;
}

export interface LaunchAgentAdminResponse {
  admin: LaunchAgentAdminSummary;
  trustCard?: LaunchTrustCard;
  generatedAt?: string;
}

/** @deprecated Use LaunchAgentAdminResponse. */
export type LaunchToolAdminResponse = LaunchAgentAdminResponse;

export interface LaunchGrantListResponse {
  grants: AgentGrantSummary[];
  generatedAt?: string;
}

export interface LaunchWiringTargetsResponse {
  targets: AgentWiringTarget[];
  generatedAt?: string;
}

export interface LaunchGrantMutationResponse {
  grant: AgentGrantSummary;
  generatedAt?: string;
}

export interface LaunchSettingsResponse {
  // When true the user's connected agent may approve cross-Agent wiring
  // grants on their behalf; when false approvals happen here on the website.
  agentGrantAutoApprove: boolean;
  // Account display name (also the public author label on published Agents).
  // null when the user hasn't set one.
  displayName?: string | null;
}

export interface LaunchGrantListQuery {
  caller?: string;
  target?: string;
  status?: "active" | "pending" | "revoked";
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

export class LaunchApiRequestError extends Error {
  override name = "LaunchApiRequestError";
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly details: unknown = null,
    public readonly responseBody: unknown = null,
  ) {
    super(message);
  }
}

export type { LaunchJobStatusResponse };

const configuredLaunchApiBaseUrl =
  import.meta.env.VITE_LAUNCH_API_BASE_URL?.trim().replace(/\/$/u, "") || "";

// Origin of the API worker — also the MCP host that install snippets point at.
export function launchApiOrigin(): string {
  return configuredLaunchApiBaseUrl || window.location.origin;
}

export interface LaunchLeaderboardRequest {
  period?: LaunchLeaderboardResponse["period"];
  limit?: number;
}

/** Stripe Connect payout-account status (from /api/user/connect/status). */
export interface LaunchConnectStatus {
  connected: boolean;
  onboarded: boolean;
  payouts_enabled: boolean;
  account_id: string | null;
  country: string | null;
  default_currency: string | null;
  verification_status?: string | null;
  requirements_currently_due?: string[];
  requirements_past_due?: string[];
  requirements_disabled_reason?: string | null;
  withdrawable_earnings_light?: number;
}

export interface LaunchConnectOnboardResponse {
  onboarding_url: string;
  account_id: string;
}

// Per-user settings status for an Agent (GET /api/launch/agents/:id/settings).
// Values are NEVER returned — only whether each declared key is configured.
export interface LaunchAgentSettingItem {
  key: string;
  label: string;
  description: string | null;
  help: string | null;
  input: string;
  placeholder: string | null;
  required: boolean;
  configured: boolean;
  updated_at: string | null;
}

export interface LaunchAgentSettingsResponse {
  app_id: string;
  settings: LaunchAgentSettingItem[];
  connected_keys: string[];
  missing_required: string[];
  fully_connected: boolean;
}

export interface LaunchAgentSettingsUpdateResponse {
  success: boolean;
  keys_saved?: string[];
  keys_removed?: string[];
  connected_keys: string[];
  missing_required: string[];
  fully_connected: boolean;
  errors?: string[];
}

/** Result of moving creator earnings into the spendable balance. */
export interface LaunchEarningsConversionResponse {
  success: boolean;
  conversion_id: string;
  converted_light: number;
  balance_light: number;
  spendable_balance_light: number;
  deposit_balance_light: number;
  earned_balance_light: number;
  convertible_earnings_light: number;
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

  install(
    request: { agent?: string; tool?: string } = {},
  ): Promise<LaunchInstallResponse> {
    const params = new URLSearchParams();
    const agent = request.agent || request.tool;
    if (agent) {
      params.set("agent", agent);
      // Deprecated alias kept for one rename window.
      params.set("tool", agent);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.fetchJson(`/api/launch/install${suffix}`);
  }

  library(): Promise<LaunchLibraryResponse> {
    return this.fetchJson("/api/launch/library");
  }

  /** Compact owner-only projection used by the merged Home/Fleet surface. */
  fleet(): Promise<LaunchFleetResponse> {
    return this.fetchJson("/api/launch/fleet");
  }

  updateFleetOrder(
    request: LaunchFleetOrderUpdateRequest,
  ): Promise<LaunchFleetOrderResponse> {
    return this.fetchJson("/api/launch/fleet/order", {
      method: "PUT",
      body: JSON.stringify(request),
    });
  }

  fleetPreferences(): Promise<LaunchFleetPreferencesResponse> {
    return this.fetchJson("/api/launch/fleet/preferences");
  }

  updateFleetPreferences(
    request: LaunchFleetPreferencesUpdateRequest,
  ): Promise<LaunchFleetPreferencesResponse> {
    return this.fetchJson("/api/launch/fleet/preferences", {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  }

  createFolder(
    scope: "owned" | "installed",
    name: string,
  ): Promise<LaunchFolderMutationResponse> {
    return this.fetchJson("/api/launch/folders", {
      method: "POST",
      body: JSON.stringify({ scope, name }),
    });
  }

  renameFolder(
    id: string,
    name: string,
  ): Promise<LaunchFolderMutationResponse> {
    return this.fetchJson(`/api/launch/folders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  deleteFolder(id: string): Promise<{ ok: boolean }> {
    return this.fetchJson(`/api/launch/folders/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /** Move an Agent into a folder, or out of all folders (folderId: null). */
  setAgentFolder(
    scope: "owned" | "installed",
    appId: string,
    folderId: string | null,
  ): Promise<LaunchFolderMemberMutationResponse> {
    return this.fetchJson("/api/launch/folders/members", {
      method: "PUT",
      body: JSON.stringify({ scope, app_id: appId, folder_id: folderId }),
    });
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

  agent(idOrSlug: string): Promise<LaunchAgentResponse> {
    return this.fetchJson(`/api/launch/agents/${encodeURIComponent(idOrSlug)}`);
  }

  /** @deprecated Use agent(). */
  tool(idOrSlug: string): Promise<LaunchAgentResponse> {
    return this.agent(idOrSlug);
  }

  agentFunctions(idOrSlug: string): Promise<LaunchAgentFunctionsResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/functions`,
    );
  }

  agentCapacity(idOrSlug: string): Promise<LaunchAgentCapacityResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/capacity`,
    );
  }

  updateAgentCapacity(
    idOrSlug: string,
    request: LaunchAgentCapacityUpdateRequest,
  ): Promise<LaunchAgentCapacityResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/capacity`,
      { method: "PATCH", body: JSON.stringify(request) },
    );
  }

  /** Canonical owner-only snapshot for a private persistent Agent home. */
  agentHome(idOrSlug: string): Promise<LaunchAgentHomeResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/home`,
    );
  }

  agentPreferences(
    idOrSlug: string,
  ): Promise<LaunchAgentPreferencesResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/preferences`,
    );
  }

  updateAgentPreferences(
    idOrSlug: string,
    request: LaunchAgentPreferencesUpdateRequest,
  ): Promise<LaunchAgentPreferencesResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/preferences`,
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
    );
  }

  agentActivity(
    idOrSlug: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<LaunchAgentActivityResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/home/activity${
        query ? `?${query}` : ""
      }`,
    );
  }

  agentAttention(
    idOrSlug: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<LaunchAgentAttentionProjection> {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/attention${
        query ? `?${query}` : ""
      }`,
    );
  }

  searchAgents(
    request: LaunchAgentSearchRequest,
  ): Promise<LaunchAgentSearchResponse> {
    const params = new URLSearchParams({ q: request.query });
    if (request.agentId) params.set("agent", request.agentId);
    if (request.kinds?.length) params.set("kinds", request.kinds.join(","));
    if (request.limit) params.set("limit", String(request.limit));
    return this.fetchJson(`/api/launch/search?${params.toString()}`);
  }

  updateAgentHomeIdentity(
    idOrSlug: string,
    request: LaunchAgentHomeIdentityUpdateRequest,
  ): Promise<LaunchAgentHomeResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/home/identity`,
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
    );
  }

  updateAgentHomeRoutine(
    idOrSlug: string,
    request: LaunchAgentHomeRoutineUpdateRequest,
  ): Promise<LaunchAgentHomeResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/home/routine`,
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
    );
  }

  updateAgentHomeSettings(
    idOrSlug: string,
    request: LaunchAgentHomeSettingsUpdateRequest,
  ): Promise<LaunchAgentHomeResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/home/settings`,
      {
        method: "PUT",
        body: JSON.stringify(request),
      },
    );
  }

  actOnAgentHome(
    idOrSlug: string,
    request: LaunchAgentHomeActionRequest,
  ): Promise<LaunchAgentHomeResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/home/actions`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  /** Safety-only stop lane; independent of Home aggregation/action sagas. */
  pauseAgentHome(
    idOrSlug: string,
  ): Promise<{
    paused: true;
    routineId: string;
    revision: string;
    generatedAt: string;
  }> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/home/pause`,
      { method: "POST" },
    );
  }

  /** Owner-only operational state for the Agent's one primary routine. */
  agentRoutine(idOrSlug: string): Promise<LaunchAgentRoutineResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/routine`,
    );
  }

  agentRoutines(idOrSlug: string): Promise<LaunchAgentRoutinesResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/routines`,
    );
  }

  agentManagedRoutine(
    idOrSlug: string,
    routineId: string,
  ): Promise<LaunchAgentRoutineResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/routines/${encodeURIComponent(routineId)}`,
    );
  }

  updateAgentManagedRoutine(
    idOrSlug: string,
    routineId: string,
    request: LaunchAgentManagedRoutineUpdateRequest,
  ): Promise<LaunchAgentRoutineResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/routines/${encodeURIComponent(routineId)}`,
      { method: "PATCH", body: JSON.stringify(request) },
    );
  }

  actOnAgentManagedRoutine(
    idOrSlug: string,
    routineId: string,
    request: LaunchAgentManagedRoutineActionRequest,
  ): Promise<LaunchAgentRoutineResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/routines/${encodeURIComponent(routineId)}/actions`,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  updateAgentRoutine(
    idOrSlug: string,
    request: LaunchAgentRoutineUpdateRequest,
  ): Promise<LaunchAgentRoutineResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/routine`,
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
    );
  }

  actOnAgentRoutine(
    idOrSlug: string,
    request: LaunchAgentRoutineActionRequest,
  ): Promise<LaunchAgentRoutineResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/routine/actions`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  /** @deprecated Use agentFunctions(). */
  toolFunctions(idOrSlug: string): Promise<LaunchAgentFunctionsResponse> {
    return this.agentFunctions(idOrSlug);
  }

  runAgentFunction(
    idOrSlug: string,
    functionName: string,
    request: LaunchFunctionRunRequest = {},
  ): Promise<LaunchFunctionRunResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/functions/${
        encodeURIComponent(functionName)
      }/run`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  /** @deprecated Use runAgentFunction(). */
  runToolFunction(
    idOrSlug: string,
    functionName: string,
    request: LaunchFunctionRunRequest = {},
  ): Promise<LaunchFunctionRunResponse> {
    return this.runAgentFunction(idOrSlug, functionName, request);
  }

  /** Add an Agent to the signed-in user's library. Idempotent. */
  installAgent(
    idOrSlug: string,
  ): Promise<{ installed: boolean; agentId: string; slug: string }> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/install`,
      { method: "POST" },
    );
  }

  /** Remove an Agent from the signed-in user's library. Idempotent. */
  uninstallAgent(
    idOrSlug: string,
  ): Promise<{ installed: boolean; agentId: string; slug: string }> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/install`,
      { method: "DELETE" },
    );
  }

  // Poll a durable async execution (a run that returned { _async, job_id }).
  launchJob(jobId: string): Promise<LaunchJobStatusResponse> {
    return this.fetchJson(`/api/launch/jobs/${encodeURIComponent(jobId)}`);
  }

  agentCallerPermissions(
    idOrSlug: string,
  ): Promise<LaunchCallerFunctionPermissionsResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/caller-permissions`,
    );
  }

  /** @deprecated Use agentCallerPermissions(). */
  toolAgentPermissions(
    idOrSlug: string,
  ): Promise<LaunchCallerFunctionPermissionsResponse> {
    return this.agentCallerPermissions(idOrSlug);
  }

  updateAgentCallerPermissions(
    idOrSlug: string,
    request: LaunchCallerFunctionPermissionsUpdateRequest,
  ): Promise<LaunchCallerFunctionPermissionsResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/caller-permissions`,
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
    );
  }

  agentFunctionInference(
    idOrSlug: string,
  ): Promise<LaunchFunctionInferenceResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/function-inference`,
    );
  }

  updateAgentFunctionInference(
    idOrSlug: string,
    functionName: string,
    request: LaunchFunctionInferenceOverrideRequest,
  ): Promise<LaunchFunctionInferenceResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/function-inference`,
      {
        method: "PUT",
        body: JSON.stringify({ functionName, ...request }),
      },
    );
  }

  // The viewing user's own per-user secrets/config for this Agent. The response
  // reports connected status per key, never a value.
  agentSettings(idOrSlug: string): Promise<LaunchAgentSettingsResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/settings`,
    );
  }

  /**
   * Owner-only Compute authority view. This response contains secret binding
   * metadata and configured presence only; the API must never return values.
   */
  agentComputeSettings(
    idOrSlug: string,
  ): Promise<LaunchComputeSettingsResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/compute/settings`,
    );
  }

  /** Narrow the release's manifest ceiling after explicit owner review. */
  updateAgentComputeSettings(
    idOrSlug: string,
    request: LaunchComputeSettingsUpdateRequest,
  ): Promise<LaunchComputeSettingsResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/compute/settings`,
      { method: "PUT", body: JSON.stringify(request) },
    );
  }

  /** Owner-only Compute run ledger for one Agent. */
  agentComputeRuns(
    idOrSlug: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<LaunchComputeRunsResponse> {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/compute/runs${
        query ? `?${query}` : ""
      }`,
    );
  }

  /** Idempotent owner cancellation request. Terminal runs remain unchanged. */
  cancelAgentComputeRun(
    idOrSlug: string,
    runId: string,
  ): Promise<LaunchComputeRunSummary> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/compute/runs/${
        encodeURIComponent(runId)
      }/cancel`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  // Write per-user secrets/config. Values go straight to the vault; pass null to
  // clear a key. Only declared per-user keys are accepted.
  updateAgentSettings(
    idOrSlug: string,
    values: Record<string, string | null>,
  ): Promise<LaunchAgentSettingsUpdateResponse> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/settings`,
      {
        method: "PUT",
        body: JSON.stringify({ values }),
      },
    );
  }

  /** @deprecated Use updateAgentCallerPermissions(). */
  updateToolAgentPermissions(
    idOrSlug: string,
    request: LaunchCallerFunctionPermissionsUpdateRequest,
  ): Promise<LaunchCallerFunctionPermissionsResponse> {
    return this.updateAgentCallerPermissions(idOrSlug, request);
  }

  wallet(): Promise<LaunchWalletResponse> {
    return this.fetchJson("/api/launch/wallet");
  }

  subscription(): Promise<LaunchSubscriptionResponse> {
    return this.fetchJson("/api/launch/subscription");
  }

  createSubscriptionCheckout(
    returnUrl = `${window.location.origin}/account`,
  ): Promise<LaunchSubscriptionRedirectResponse> {
    return this.fetchJson("/api/launch/subscription/checkout", {
      method: "POST",
      body: JSON.stringify({ plan: "pro", returnUrl }),
    });
  }

  createSubscriptionPortal(
    returnUrl = `${window.location.origin}/account`,
  ): Promise<LaunchSubscriptionRedirectResponse> {
    return this.fetchJson("/api/launch/subscription/portal", {
      method: "POST",
      body: JSON.stringify({ returnUrl }),
    });
  }

  walletDetail(
    kind: LaunchWalletDetailKind,
    request: LaunchWalletPageRequest = {},
  ): Promise<LaunchWalletDetailResponse> {
    const params = new URLSearchParams();
    if (request.cursor) params.set("cursor", request.cursor);
    if (request.limit) params.set("limit", String(request.limit));
    const agentFilter = request.agent || request.tool;
    if (agentFilter) {
      params.set("agent", agentFilter);
      // Deprecated alias kept for one rename window.
      params.set("tool", agentFilter);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.fetchJson(`/api/launch/wallet/${kind}${suffix}`);
  }

  walletTopUpQuote(request: {
    amountCredits: number;
    method: LaunchWalletFundingMethod;
  }): Promise<LaunchWalletFundingQuoteResponse> {
    const params = new URLSearchParams({
      amount_credits: String(request.amountCredits),
      // Deprecated alias kept for one rename window.
      amount_light: String(request.amountCredits),
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
        amount_credits: request.amountCredits,
        // Deprecated alias kept for one rename window.
        amount_light: request.amountCredits,
        method: request.method,
        terms_accepted: request.termsAccepted,
        ...(request.billingAddress !== undefined
          ? { billing_address: request.billingAddress }
          : {}),
      }),
    });
  }

  /**
   * Best-effort cancel of an abandoned/superseded top-up PaymentIntent (the
   * checkout auto-prepares on open and re-prepares on amount change). Fire and
   * forget — the caller ignores the result.
   */
  cancelWalletTopUp(
    paymentIntentId: string,
  ): Promise<{ ok: boolean; canceled?: boolean }> {
    return this.fetchJson("/api/launch/wallet/topup/cancel", {
      method: "POST",
      body: JSON.stringify({ payment_intent_id: paymentIntentId }),
    });
  }

  /**
   * Re-price an existing top-up PaymentIntent in place when the buyer changes
   * the amount — keeps the same clientSecret so the mounted Payment Element +
   * Link wallet don't reload. Returns the new server-locked quote.
   */
  updateWalletTopUpAmount(
    paymentIntentId: string,
    amountCredits: number,
  ): Promise<{
    success: boolean;
    quote: {
      baseAmountCents: number;
      processingFeeCents: number;
      feeFormula: string;
      totalAmountCents: number;
    };
  }> {
    return this.fetchJson("/api/launch/wallet/topup/update-amount", {
      method: "POST",
      body: JSON.stringify({
        payment_intent_id: paymentIntentId,
        amount_credits: amountCredits,
      }),
    });
  }

  /** Seller Stripe Connect payout-account status. */
  connectStatus(): Promise<LaunchConnectStatus> {
    return this.fetchJson("/api/user/connect/status");
  }

  /** Start (or resume) Stripe Connect onboarding; returns a hosted link URL. */
  startConnectOnboarding(): Promise<LaunchConnectOnboardResponse> {
    return this.fetchJson("/api/user/connect/onboard", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  /**
   * Move creator earnings into the spendable balance — instant internal
   * transfer, no Stripe leg. Pass all=true to convert whatever is currently
   * available (avoids racing a balance that moved since the page loaded).
   */
  convertEarningsToBalance(request: {
    amountCredits?: number;
    all?: boolean;
    termsAccepted: boolean;
  }): Promise<LaunchEarningsConversionResponse> {
    return this.fetchJson("/api/user/earnings/convert-to-balance", {
      method: "POST",
      body: JSON.stringify({
        ...(request.all
          ? { all: true }
          : { amount_light: request.amountCredits }),
        terms_accepted: request.termsAccepted,
      }),
    });
  }

  byok(): Promise<LaunchByokSummaryResponse> {
    return this.fetchJson("/api/launch/byok");
  }

  upsertByokProvider(
    provider: string,
    request: LaunchByokUpsertRequest,
  ): Promise<LaunchByokMutationResponse> {
    return this.fetchJson(
      `/api/launch/byok/${encodeURIComponent(provider)}`,
      {
        method: "PUT",
        body: JSON.stringify(request),
      },
    );
  }

  deleteByokProvider(provider: string): Promise<LaunchByokMutationResponse> {
    return this.fetchJson(
      `/api/launch/byok/${encodeURIComponent(provider)}`,
      {
        method: "DELETE",
      },
    );
  }

  setByokPrimary(provider: string): Promise<LaunchByokMutationResponse> {
    const request: LaunchByokPrimaryRequest = { provider };
    return this.fetchJson("/api/launch/byok/primary", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  inferenceOptions(): Promise<LaunchInferenceOptionsResponse> {
    return this.fetchJson("/api/launch/inference-options");
  }

  /** Set the platform (credits) OpenRouter model. Empty string clears it. */
  setPlatformModel(model: string): Promise<LaunchPlatformModelResponse> {
    const request: LaunchPlatformModelRequest = { model };
    return this.fetchJson("/api/launch/platform-model", {
      method: "PUT",
      body: JSON.stringify(request),
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

  agentAdmin(id: string): Promise<LaunchAgentAdminResponse> {
    return this.fetchJson(`/api/launch/admin/agents/${encodeURIComponent(id)}`);
  }

  /** @deprecated Use agentAdmin(). */
  toolAdmin(id: string): Promise<LaunchAgentAdminResponse> {
    return this.agentAdmin(id);
  }

  // Cross-Agent wiring (P5): the Agent's declared slots + their bindings, the
  // raw grants it holds/receives, and the pending-approval inbox.
  agentWiring(idOrSlug: string): Promise<AgentWiringView> {
    return this.fetchJson(
      `/api/launch/agents/${encodeURIComponent(idOrSlug)}/wiring`,
    );
  }

  listGrants(
    query: LaunchGrantListQuery = {},
  ): Promise<LaunchGrantListResponse> {
    const params = new URLSearchParams();
    if (query.caller) params.set("caller", query.caller);
    if (query.target) params.set("target", query.target);
    if (query.status) params.set("status", query.status);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.fetchJson(`/api/launch/grants${suffix}`);
  }

  createGrant(
    request: AgentGrantCreateRequest,
  ): Promise<LaunchGrantMutationResponse> {
    return this.fetchJson("/api/launch/grants", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  approveGrant(
    id: string,
    request: AgentGrantApproveRequest = {},
  ): Promise<LaunchGrantMutationResponse> {
    return this.fetchJson(
      `/api/launch/grants/${encodeURIComponent(id)}/approve`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  updateGrant(
    id: string,
    request: AgentGrantUpdateRequest,
  ): Promise<LaunchGrantMutationResponse> {
    return this.fetchJson(`/api/launch/grants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  }

  // Revoking is a soft delete (status -> revoked); also used to deny pending.
  revokeGrant(id: string): Promise<LaunchGrantMutationResponse> {
    return this.fetchJson(`/api/launch/grants/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  wiringTargets(query?: string): Promise<LaunchWiringTargetsResponse> {
    const params = new URLSearchParams();
    // The facade reads ?q= for the target search filter.
    if (query) params.set("q", query);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.fetchJson(`/api/launch/wiring/targets${suffix}`);
  }

  getLaunchSettings(): Promise<LaunchSettingsResponse> {
    return this.fetchJson("/api/launch/settings");
  }

  updateLaunchSettings(
    request: {
      agentGrantAutoApprove?: boolean;
      // Empty string clears the override back to the default label.
      displayName?: string | null;
    },
  ): Promise<LaunchSettingsResponse> {
    return this.fetchJson("/api/launch/settings", {
      method: "PATCH",
      body: JSON.stringify(request),
    });
  }

  /**
   * Update an Agent's editable fields (owner only). Calls the platform app
   * handler directly — same origin, same auth (authenticate()) as the launch
   * facade, so it reuses every server-side validation + visibility gate.
   */
  updateAgent(
    id: string,
    fields: {
      name?: string;
      description?: string;
      visibility?: "public" | "unlisted" | "private";
      category?: string;
    },
  ): Promise<unknown> {
    return this.fetchJson(`/api/apps/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
  }

  /** Upload a static or animated Agent icon. The server validates bytes,
   * dimensions, animation frames, and ownership; it returns a content-addressed
   * URL so replacing an icon cannot leave a stale browser cache behind. */
  uploadAgentIcon(
    id: string,
    file: File,
  ): Promise<{ success: true; icon_url: string }> {
    const body = new FormData();
    body.set("icon", file);
    return this.fetchJson(`/api/apps/${encodeURIComponent(id)}/icon`, {
      method: "POST",
      body,
    });
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

  listNotifications(
    options: { unreadOnly?: boolean; limit?: number; agent?: string } = {},
  ): Promise<LaunchNotificationsResponse> {
    const params = new URLSearchParams();
    if (options.unreadOnly) params.set("unread", "1");
    if (options.limit) params.set("limit", String(options.limit));
    if (options.agent) params.set("agent", options.agent);
    const qs = params.toString();
    return this.fetchJson(
      `/api/launch/notifications${qs ? `?${qs}` : ""}`,
    );
  }

  globalAttention(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<LaunchGlobalAttentionResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.fetchJson(
      `/api/launch/attention${query ? `?${query}` : ""}`,
    );
  }

  markNotificationsRead(
    body: { ids?: string[]; all?: boolean; agent?: string },
  ): Promise<LaunchNotificationsMarkReadResponse> {
    return this.fetchJson("/api/launch/notifications", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  actOnAttention(
    notificationId: string,
    request: LaunchAgentAttentionActionRequest,
  ): Promise<LaunchAgentAttentionActionResponse> {
    return this.fetchJson(
      `/api/launch/notifications/${
        encodeURIComponent(notificationId)
      }/actions`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  private async sendRequest(
    path: string,
    init: RequestInit,
    token: string | null,
  ): Promise<Response> {
    const headers = new Headers({ Accept: "application/json" });
    if (typeof init.body === "string") {
      headers.set("Content-Type", "application/json");
    }
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
      let responseBody: unknown = null;
      let errorCode: string | null = null;
      let errorDetails: unknown = null;
      try {
        const parsed = JSON.parse(text) as {
          code?: unknown;
          details?: unknown;
          error?: unknown;
          message?: unknown;
        };
        responseBody = parsed;
        // The API returns errors either as a string or a structured object
        // ({ type, message, details }). Pull the human-readable message out —
        // never String() the object (that yields the useless "[object Object]").
        const errField = parsed.error;
        if (typeof errField === "string") {
          message = errField;
        } else if (
          errField && typeof errField === "object" &&
          typeof (errField as { message?: unknown }).message === "string"
        ) {
          message = (errField as { message: string }).message;
        } else if (typeof parsed.message === "string") {
          message = parsed.message;
        }
        if (typeof parsed.code === "string") {
          errorCode = parsed.code;
        } else if (
          errField && typeof errField === "object" &&
          typeof (errField as { code?: unknown }).code === "string"
        ) {
          errorCode = (errField as { code: string }).code;
        } else if (
          errField && typeof errField === "object" &&
          typeof (errField as { type?: unknown }).type === "string"
        ) {
          errorCode = (errField as { type: string }).type;
        }
        errorDetails = parsed.details ??
          (errField && typeof errField === "object"
            ? (errField as { details?: unknown }).details ?? null
            : null);
        // else: fall through to the raw `text` (already assigned above).
      } catch {
        // Non-JSON error body (e.g. an upstream HTML error page): never
        // surface raw markup or page-sized bodies in UI error states.
        if (/^\s*</.test(text) || text.length > 300) {
          message = `Launch API request failed (${response.status})`;
        }
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
      throw new LaunchApiRequestError(
        message || `Launch API request failed (${response.status})`,
        response.status,
        errorCode,
        errorDetails,
        responseBody,
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
