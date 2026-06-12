import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentCallerTrustSummary,
  AgentWiringView,
} from "../../../../shared/contracts/agent-grants.ts";
import type {
  LaunchAgentFunctionsResponse,
  LaunchApiKeyListResponse,
  LaunchByokSummaryResponse,
  LaunchCallerFunctionPermissionsResponse,
  LaunchInferenceOptionsResponse,
  LaunchInstallResponse,
  LaunchLeaderboardResponse,
  LaunchLibraryResponse,
  LaunchStoreRequest,
  LaunchStoreResponse,
  LaunchWalletDetailResponse,
} from "../../../../shared/contracts/launch.ts";
import {
  launchApi,
  type LaunchAgentAdminResponse,
  type LaunchAgentResponse,
  type LaunchPlatformPrimitivesResponse,
  type LaunchWalletResponse,
} from "./api";
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
  agent?: LaunchAgentResponse;
  agentFunctions?: LaunchAgentFunctionsResponse;
  agentCallerPermissions?: LaunchCallerFunctionPermissionsResponse;
  agentWiring?: AgentWiringView;
  agentCallerTrust?: AgentCallerTrustSummary;
  wallet?: LaunchWalletResponse;
  walletDetail?: LaunchWalletDetailResponse;
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

type LoadResult = LaunchRouteLiveData;

export function useLaunchRouteLiveData(
  location: LocationLike,
  route: ResolvedLaunchRoute,
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
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const identityRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    // Navigating to a DIFFERENT route must drop the previous route's payload
    // and report "loading" — otherwise pages render stale data (or definitive
    // empty/not-found states) under the new URL while the fetch is in flight.
    // A same-route reload() keeps the current data on screen.
    const identity = `${routeKey}|${paramsKey}|${location.pathname}`;
    const routeChanged = identity !== identityRef.current;
    identityRef.current = identity;
    setState((current) =>
      routeChanged ? { data: {}, status: "loading" } : {
        data: current.data,
        status: current.status === "idle" ? "loading" : current.status,
      }
    );

    loadRouteData(location, route)
      .then((data) => {
        if (cancelled) return;
        setState({ data, status: "ready" });
      })
      .catch((err) => {
        if (cancelled) return;
        setState((current) => ({
          data: current.data,
          error: err instanceof Error ? err.message : String(err),
          status: "error",
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [location.pathname, location.search, route, routeKey, paramsKey, version]);

  return { ...state, reload };
}

async function loadRouteData(
  location: LocationLike,
  route: ResolvedLaunchRoute,
): Promise<LoadResult> {
  const search = new URLSearchParams(location.search);
  switch (route.definition.key) {
    case "home": {
      const [status, install, primitives, store] = await Promise.all([
        optional(() => launchApi.status()),
        optional(() => launchApi.install()),
        optional(() => launchApi.platformPrimitives()),
        optional(() => launchApi.store({ limit: 6 })),
      ]);
      return { status, install, platformPrimitives: primitives, store };
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
      // Wiring + caller-trust require an account session; they degrade to
      // undefined when signed out (the page renders an empty wiring state).
      const [
        agent,
        agentFunctions,
        agentCallerPermissions,
        agentWiring,
        agentCallerTrust,
        install,
      ] = await Promise
        .all([
          launchApi.agent(id),
          optional(() => launchApi.agentFunctions(id)),
          optional(() => launchApi.agentCallerPermissions(id)),
          optional(() => launchApi.agentWiring(id)),
          optional(() => launchApi.agentCallerTrust(id)),
          // Per-agent install context (dedicated MCP URL + connect prompt).
          optional(() => launchApi.install({ agent: id })),
        ]);
      return {
        agent,
        agentCallerPermissions,
        agentCallerTrust,
        agentFunctions,
        agentWiring,
        install,
      };
    }
    case "library": {
      return { library: await launchApi.library() };
    }
    case "settings": {
      // The account page merges wallet + settings, so it loads both payloads.
      const detailKind = walletDetailKind(search.get("tab"), search.get("view"));
      const [apiKeys, byok, inferenceOptions, wallet, walletDetail] =
        await Promise.all([
          launchApi.apiKeys(),
          optional(() => launchApi.byok()),
          optional(() => launchApi.inferenceOptions()),
          optional(() => launchApi.wallet()),
          optional(() => launchApi.walletDetail(detailKind, { limit: 25 })),
        ]);
      return { apiKeys, byok, inferenceOptions, wallet, walletDetail };
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

async function optional<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

function storeKind(value: string | null): LaunchStoreRequest["kind"] {
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
