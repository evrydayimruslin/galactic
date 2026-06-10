import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  LaunchAgentFunctionPermissionsResponse,
  LaunchApiKeyListResponse,
  LaunchInstallResponse,
  LaunchLeaderboardResponse,
  LaunchLibraryResponse,
  LaunchToolFunctionsResponse,
  LaunchStoreRequest,
  LaunchStoreResponse,
  LaunchWalletDetailResponse,
} from "../../../../shared/contracts/launch.ts";
import {
  launchApi,
  type LaunchPlatformPrimitivesResponse,
  type LaunchToolAdminResponse,
  type LaunchToolResponse,
  type LaunchWalletResponse,
} from "./api";
import type { ResolvedLaunchRoute } from "./routes";

export type LaunchLoadStatus = "idle" | "loading" | "ready" | "error";

export interface LaunchRouteLiveData {
  status?: Record<string, unknown>;
  install?: LaunchInstallResponse;
  apiKeys?: LaunchApiKeyListResponse;
  store?: LaunchStoreResponse;
  builderLeaderboard?: LaunchLeaderboardResponse;
  feeLeaderboard?: LaunchLeaderboardResponse;
  library?: LaunchLibraryResponse;
  tool?: LaunchToolResponse;
  toolFunctions?: LaunchToolFunctionsResponse;
  toolAgentPermissions?: LaunchAgentFunctionPermissionsResponse;
  wallet?: LaunchWalletResponse;
  walletDetail?: LaunchWalletDetailResponse;
  adminTool?: LaunchToolAdminResponse;
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

  useEffect(() => {
    let cancelled = false;
    setState((current) => ({
      data: current.data,
      status: current.status === "idle" ? "loading" : current.status,
    }));

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
    case "install": {
      const tool = search.get("tool") || undefined;
      const [install, apiKeys] = await Promise.all([
        launchApi.install({ tool }),
        optional(() => launchApi.apiKeys()),
      ]);
      return { install, apiKeys };
    }
    case "store": {
      const request: LaunchStoreRequest = {
        kind: storeKind(search.get("kind")),
        limit: 24,
        query: search.get("q") || undefined,
      };
      const [store, builderLeaderboard, feeLeaderboard] = await Promise.all([
        launchApi.store(request),
        optional(() => launchApi.leaderboard("builder", { period: "30d", limit: 5 })),
        optional(() => launchApi.leaderboard("fee_credit", { period: "30d", limit: 5 })),
      ]);
      return { builderLeaderboard, feeLeaderboard, store };
    }
    case "tool": {
      const id = route.params.slug || "";
      if (!id) return {};
      const [tool, toolFunctions, toolAgentPermissions] = await Promise.all([
        launchApi.tool(id),
        optional(() => launchApi.toolFunctions(id)),
        optional(() => launchApi.toolAgentPermissions(id)),
      ]);
      return { tool, toolAgentPermissions, toolFunctions };
    }
    case "library": {
      return { library: await launchApi.library() };
    }
    case "wallet": {
      const detailKind = walletDetailKind(search.get("tab"));
      const [wallet, walletDetail] = await Promise.all([
        launchApi.wallet(),
        optional(() => launchApi.walletDetail(detailKind, { limit: 25 })),
      ]);
      return { wallet, walletDetail };
    }
    case "settings": {
      return { apiKeys: await launchApi.apiKeys() };
    }
    case "adminTool": {
      const id = route.params.id || "";
      if (!id) return {};
      const [adminTool, toolFunctions, toolAgentPermissions] = await Promise.all([
        launchApi.toolAdmin(id),
        optional(() => launchApi.toolFunctions(id)),
        optional(() => launchApi.toolAgentPermissions(id)),
      ]);
      return { adminTool, toolAgentPermissions, toolFunctions };
    }
    case "authCallback":
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

function walletDetailKind(tab: string | null): "transactions" | "receipts" | "earnings" | "payouts" {
  if (tab === "receipts" || tab === "earnings" || tab === "payouts") {
    return tab;
  }
  return "transactions";
}
