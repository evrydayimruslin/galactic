import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentWiringView } from "../../../../shared/contracts/agent-grants.ts";
import type {
  LaunchAgentFunctionsResponse,
  LaunchAgentCapacityResponse,
  LaunchAgentHomeResponse,
  LaunchAgentRoutinesResponse,
  LaunchApiKeyListResponse,
  LaunchByokSummaryResponse,
  LaunchCallerFunctionPermissionsResponse,
  LaunchFleetResponse,
  LaunchInferenceOptionsResponse,
  LaunchInstallResponse,
  LaunchLeaderboardResponse,
  LaunchLibraryResponse,
  LaunchStoreRequest,
  LaunchStoreResponse,
  LaunchSubscriptionResponse,
  LaunchWalletDetailResponse,
} from "../../../../shared/contracts/launch.ts";
import {
  launchApi,
  type LaunchAgentAdminResponse,
  type LaunchAgentResponse,
  type LaunchPlatformPrimitivesResponse,
  type LaunchWalletResponse,
} from "./api";
import {
  getLaunchAuthToken,
  hasLaunchAuthToken,
  isLaunchAuthSessionStorageChange,
  LAUNCH_AUTH_SESSION_CHANGED_EVENT,
  launchAuthSessionIdentity,
} from "./auth";
import type { ResolvedLaunchRoute } from "./routes";

export type LaunchLoadStatus = "idle" | "loading" | "ready" | "error";

export interface LaunchRouteLiveData {
  status?: Record<string, unknown>;
  install?: LaunchInstallResponse;
  apiKeys?: LaunchApiKeyListResponse;
  byok?: LaunchByokSummaryResponse;
  inferenceOptions?: LaunchInferenceOptionsResponse;
  store?: LaunchStoreResponse;
  agentFeeLeaderboard?: LaunchLeaderboardResponse;
  feeLeaderboard?: LaunchLeaderboardResponse;
  library?: LaunchLibraryResponse;
  fleet?: LaunchFleetResponse;
  agent?: LaunchAgentResponse;
  agentFunctions?: LaunchAgentFunctionsResponse;
  agentCapacity?: LaunchAgentCapacityResponse;
  agentHome?: LaunchAgentHomeResponse;
  agentRoutines?: LaunchAgentRoutinesResponse;
  agentHomeError?: string;
  agentCallerPermissions?: LaunchCallerFunctionPermissionsResponse;
  agentWiring?: AgentWiringView;
  wallet?: LaunchWalletResponse;
  walletDetail?: LaunchWalletDetailResponse;
  subscription?: LaunchSubscriptionResponse;
  adminAgent?: LaunchAgentAdminResponse;
  platformPrimitives?: LaunchPlatformPrimitivesResponse;
}

export interface LaunchRouteLiveState {
  data: LaunchRouteLiveData;
  error?: string;
  reload: () => void;
  status: LaunchLoadStatus;
}

interface LocationLike {
  pathname: string;
  search: string;
}

interface LaunchLiveDataContext {
  sessionIdentity: string;
  sessionRevision: number;
  suspend?: boolean;
}

type LoadResult = LaunchRouteLiveData;

/**
 * Session-lived cache of the last payload fetched per route identity. Cache
 * keys include the non-secret account identity and App-managed session
 * revision; every token transition also clears the map and advances the epoch
 * used to reject prior-session async completions.
 */
export class LaunchRouteDataCache {
  private readonly entries = new Map<string, LaunchRouteLiveData>();
  private sessionEpoch = 0;

  get epoch(): number {
    return this.sessionEpoch;
  }

  clearForSessionChange(): void {
    this.sessionEpoch += 1;
    this.entries.clear();
  }

  get(identity: string): LaunchRouteLiveData | undefined {
    return this.entries.get(identity);
  }

  set(identity: string, data: LaunchRouteLiveData): void {
    this.entries.set(identity, data);
  }
}

const routeCache = new LaunchRouteDataCache();

if (typeof window !== "undefined") {
  window.addEventListener(
    LAUNCH_AUTH_SESSION_CHANGED_EVENT,
    () => routeCache.clearForSessionChange(),
  );
  window.addEventListener("storage", (event) => {
    if (isLaunchAuthSessionStorageChange(event.key)) {
      routeCache.clearForSessionChange();
    }
  });
}

export function useLaunchRouteLiveData(
  location: LocationLike,
  route: ResolvedLaunchRoute,
  {
    sessionIdentity,
    sessionRevision,
    suspend = false,
  }: LaunchLiveDataContext,
): LaunchRouteLiveState {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<Omit<LaunchRouteLiveState, "reload">>({
    data: {},
    status: "idle",
  });

  const routeKey = route.definition.key;
  const paramsKey = useMemo(
    () => JSON.stringify(route.params),
    [route.params],
  );
  const dataSearch = useMemo(
    () => launchRouteDataSearchKey(routeKey, location.search),
    [location.search, routeKey],
  );
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const identityRef = useRef("");
  const identity = launchRouteDataIdentity({
    paramsKey,
    pathname: location.pathname,
    routeKey,
    searchKey: dataSearch,
    sessionIdentity,
    sessionRevision,
  });

  useEffect(() => {
    let cancelled = false;
    const capturedAuthScope: LaunchAuthScopeSnapshot = {
      cacheEpoch: routeCache.epoch,
      sessionIdentity,
    };
    const authScopeChanged = (): boolean => {
      return !sameLaunchAuthScope(capturedAuthScope, {
        cacheEpoch: routeCache.epoch,
        sessionIdentity: launchAuthSessionIdentity(getLaunchAuthToken()),
      });
    };
    // Never fetch or surface cached route data while a refresh cookie is being
    // revalidated. In particular, this prevents an expired owner session from
    // painting its last private Agent payload before authorization is known.
    if (suspend) {
      identityRef.current = identity;
      setState({ data: {}, status: "loading" });
      return () => {
        cancelled = true;
      };
    }
    // Navigating to a DIFFERENT route must drop the previous route's payload
    // and report "loading" — otherwise pages render stale data (or definitive
    // empty/not-found states) under the new URL while the fetch is in flight.
    // A same-route reload() keeps the current data on screen.
    const routeChanged = identity !== identityRef.current;
    identityRef.current = identity;
    // On a route change, paint this route's cached payload immediately if we've
    // loaded it before (no blank/loading flash, no layout shift) and revalidate
    // below. A first visit still shows "loading"; a same-route reload() keeps the
    // current data on screen.
    const cached = routeCache.get(identity);
    // Agent Home is an aggregate view and can be slower or temporarily
    // unavailable while its independent emergency-pause lane is still healthy.
    // Accumulate its result separately so the core Agent page can render—and
    // expose Pause—without waiting for Home aggregation to settle.
    let accumulated = cached ?? {};
    setState((current) =>
      routeChanged
        ? (cached ? { data: cached, status: "ready" } : { data: {}, status: "loading" })
        : {
          data: current.data,
          status: current.status === "idle" ? "loading" : current.status,
        }
    );

    loadAgentHomeRouteData(route)?.then((homeData) => {
      if (cancelled || authScopeChanged()) return;
      accumulated = { ...accumulated, ...homeData };
      routeCache.set(identity, accumulated);
      setState((current) => ({ ...current, data: accumulated }));
    });

    loadRouteData({ ...location, search: dataSearch }, route)
      .then((data) => {
        if (cancelled || authScopeChanged()) return;
        accumulated = { ...accumulated, ...data };
        routeCache.set(identity, accumulated);
        setState({ data: accumulated, status: "ready" });
      })
      .catch((err) => {
        if (cancelled || authScopeChanged()) return;
        setState((current) => ({
          // A failed revalidation may retain stale-while-revalidate data only
          // for the exact current route + account + session revision. Never
          // preserve a payload that belongs to the previously rendered scope.
          data: launchRouteDataAfterError({
            currentData: current.data,
            currentIdentity: identityRef.current,
            requestIdentity: identity,
          }),
          error: err instanceof Error ? err.message : String(err),
          status: "error",
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [
    dataSearch,
    identity,
    location.pathname,
    paramsKey,
    route,
    routeKey,
    sessionIdentity,
    sessionRevision,
    suspend,
    version,
  ]);

  // Derive the displayed state DURING render, not only in the effect above. On a
  // route change the committed `state` still holds the PREVIOUS route's payload,
  // so returning it for one paint makes the new page flash its empty/loader
  // state before the effect swaps in this route's cached data. When we have a
  // cached payload for the new identity, surface it immediately (the effect
  // still revalidates); otherwise show loading. Same-route renders use `state`.
  if (suspend) return { data: {}, reload, status: "loading" };

  let effective = state;
  if (identity !== identityRef.current) {
    const cached = routeCache.get(identity);
    effective = cached
      ? { data: cached, status: "ready" }
      : { data: {}, status: "loading" };
  }

  return { ...effective, reload };
}

export function launchRouteDataIdentity({
  paramsKey,
  pathname,
  routeKey,
  searchKey = "",
  sessionIdentity,
  sessionRevision,
}: {
  paramsKey: string;
  pathname: string;
  routeKey: string;
  searchKey?: string;
  sessionIdentity: string;
  sessionRevision: number;
}): string {
  const sessionScope = `${sessionIdentity}@${sessionRevision}`;
  const base = `${sessionScope}|${routeKey}|${paramsKey}|${pathname}`;
  return searchKey ? `${base}|${searchKey}` : base;
}

export function launchRouteDataAfterError({
  currentData,
  currentIdentity,
  requestIdentity,
}: {
  currentData: LaunchRouteLiveData;
  currentIdentity: string;
  requestIdentity: string;
}): LaunchRouteLiveData {
  return currentIdentity === requestIdentity ? currentData : {};
}

export function launchRouteDataSearchKey(
  routeKey: string,
  search: string,
): string {
  if (routeKey !== "store") return "";

  const source = new URLSearchParams(search);
  const relevant = new URLSearchParams();
  relevant.set("kind", storeKind(source.get("kind")));
  const query = source.get("q");
  if (query) relevant.set("q", query);
  return relevant.toString();
}

export interface LaunchAuthScopeSnapshot {
  cacheEpoch: number;
  sessionIdentity: string;
}

export function sameLaunchAuthScope(
  captured: LaunchAuthScopeSnapshot,
  current: LaunchAuthScopeSnapshot,
): boolean {
  return captured.cacheEpoch === current.cacheEpoch &&
    captured.sessionIdentity === current.sessionIdentity;
}

async function loadRouteData(
  location: LocationLike,
  route: ResolvedLaunchRoute,
): Promise<LoadResult> {
  const search = new URLSearchParams(location.search);
  switch (route.definition.key) {
    case "home": {
      if (hasLaunchAuthToken()) {
        const fleet = await launchApi.fleet();
        return { fleet };
      }
      const [status, install, primitives] = await Promise.all([
        optional(() => launchApi.status()),
        optional(() => launchApi.install()),
        optional(() => launchApi.platformPrimitives()),
      ]);
      return { status, install, platformPrimitives: primitives };
    }
    case "store": {
      const request: LaunchStoreRequest = {
        kind: storeKind(search.get("kind")),
        limit: 24,
        query: search.get("q") || undefined,
      };
      const [store, agentFeeLeaderboard, feeLeaderboard] = await Promise.all([
        launchApi.store(request),
        optional(() =>
          launchApi.leaderboard("agent_fee_credit", { period: "30d", limit: 5 })
        ),
        optional(() => launchApi.leaderboard("fee_credit", { period: "30d", limit: 5 })),
      ]);
      return { agentFeeLeaderboard, feeLeaderboard, store };
    }
    case "agent": {
      const id = route.params.slug || "";
      if (!id) return {};
      // Per-function wiring requires an account session and degrades to
      // undefined when signed out.
      const [
        agent,
        agentFunctions,
        agentCallerPermissions,
        agentWiring,
        agentCapacity,
        agentRoutines,
        install,
        byok,
        inferenceOptions,
        fleet,
      ] = await Promise
        .all([
          launchApi.agent(id),
          optional(() => launchApi.agentFunctions(id)),
          optional(() => launchApi.agentCallerPermissions(id)),
          optional(() => launchApi.agentWiring(id)),
          optional(() => launchApi.agentCapacity(id)),
          optional(() => launchApi.agentRoutines(id)),
          // Per-agent install context (dedicated MCP URL + connect prompt).
          optional(() => launchApi.install({ agent: id })),
          // Loaded so the per-function inference control can list the viewer's
          // providers configured with the user's own API keys.
          optional(() => launchApi.byok()),
          optional(() => launchApi.inferenceOptions()),
          optional(() => launchApi.fleet()),
        ]);
      return {
        agent,
        agentCallerPermissions,
        agentFunctions,
        agentCapacity,
        agentRoutines,
        agentWiring,
        byok,
        inferenceOptions,
        install,
        fleet,
      };
    }
    case "library": {
      if (hasLaunchAuthToken()) {
        const fleet = await launchApi.fleet();
        return { fleet };
      }
      const [library, fleet] = await Promise.all([
        launchApi.library(),
        optional(() => launchApi.fleet()),
      ]);
      return { fleet, library };
    }
    case "settings": {
      if (hasLaunchAuthToken()) {
        const fleet = await launchApi.fleet();
        return { fleet };
      }
      const [apiKeys, byok, inferenceOptions, subscription, fleet] =
        await Promise.all([
          launchApi.apiKeys(),
          optional(() => launchApi.byok()),
          optional(() => launchApi.inferenceOptions()),
          launchApi.subscription(),
          optional(() => launchApi.fleet()),
        ]);
      return { apiKeys, byok, inferenceOptions, subscription, fleet };
    }
    case "adminAgent": {
      const id = route.params.id || "";
      if (!id) return {};
      const [adminAgent, agentFunctions, agentCallerPermissions] = await Promise
        .all([
          launchApi.agentAdmin(id),
          optional(() => launchApi.agentFunctions(id)),
          optional(() => launchApi.agentCallerPermissions(id)),
        ]);
      return { adminAgent, agentCallerPermissions, agentFunctions };
    }
    case "authCallback":
      return {};
    case "terms":
    case "privacy":
      return {};
  }
}

function loadAgentHomeRouteData(
  route: ResolvedLaunchRoute,
): Promise<LoadResult> | undefined {
  if (route.definition.key !== "agent") return undefined;
  const id = route.params.slug || "";
  if (!id) return undefined;
  // The canonical Agent home is owner-only. Preserve an explicit load failure
  // so an owner never sees a misleading "no routine" state; public
  // compatibility pages ignore the result. Crucially, this promise is not
  // awaited by the core route load, so a hung aggregate cannot hide Pause.
  return attempted(() => launchApi.agentHome(id)).then((result) => ({
    agentHome: result.value,
    agentHomeError: result.error,
  }));
}

async function optional<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

async function attempted<T>(
  load: () => Promise<T>,
): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await load() };
  } catch (err) {
    return {
      error: err instanceof Error && err.message
        ? err.message
        : "Agent home could not be loaded.",
    };
  }
}

function storeKind(
  value: string | null,
): NonNullable<LaunchStoreRequest["kind"]> {
  return value === "mcp" || value === "http" ? value : "all";
}

function walletDetailKind(
  tab: string | null,
  view: string | null,
): "transactions" | "receipts" | "earnings" | "payouts" {
  if (tab === "earnings") return "earnings";
  if (view === "receipts") return "receipts";
  return "transactions";
}
