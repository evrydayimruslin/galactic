import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import {
  accountRoutes,
  primaryRoutes,
  resolveLaunchRoute,
  type LaunchRouteKey,
  type ResolvedLaunchRoute,
} from "./lib/routes";
import {
  useLaunchRouteLiveData,
  type LaunchRouteLiveState,
} from "./lib/live-data";
import {
  AdminFoundationPage,
  HomeFoundationPage,
  InstallFoundationPage,
  LibraryFoundationPage,
  SettingsFoundationPage,
  StoreFoundationPage,
  ToolFoundationPage,
  WalletFoundationPage,
} from "./pages/foundation-pages";
import { LaunchShell } from "./components/launch-chrome";
import {
  exchangeLaunchBridgeToken,
  normalizeLocalPath,
  setLaunchAuthToken,
} from "./lib/auth";

export interface LocationState {
  pathname: string;
  search: string;
}

export interface LaunchPageProps {
  live: LaunchRouteLiveState;
  location: LocationState;
  route: ResolvedLaunchRoute;
  navigate: (to: string) => void;
}

const routeTitles: Record<LaunchRouteKey, string> = {
  home: "Home",
  install: "Install",
  library: "Library",
  store: "Store",
  tool: "Tool",
  wallet: "Wallet",
  settings: "Settings",
  adminTool: "Tool admin",
  authCallback: "Signing in",
};

export function App(): ReactElement {
  const [location, setLocation] = useState<LocationState>(() =>
    currentLocation()
  );

  useEffect(() => {
    const onPopState = () => setLocation(currentLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((to: string) => {
    const next = new URL(to, window.location.origin);
    if (next.origin !== window.location.origin) {
      window.location.href = next.href;
      return;
    }
    window.history.pushState(null, "", `${next.pathname}${next.search}`);
    setLocation(currentLocation());
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const route = useMemo(
    () => resolveLaunchRoute(location.pathname),
    [location.pathname],
  );
  const live = useLaunchRouteLiveData(location, route);

  return (
    <LaunchShell
      accountRoutes={accountRoutes()}
      activeRoute={route.definition.key}
      navigate={navigate}
      primaryRoutes={primaryRoutes()}
      title={routeTitles[route.definition.key]}
    >
      <RouteSwitch live={live} location={location} route={route} navigate={navigate} />
    </LaunchShell>
  );
}

function RouteSwitch({ live, location, route, navigate }: LaunchPageProps): ReactElement {
  switch (route.definition.key) {
    case "home":
      return <HomeFoundationPage live={live} location={location} route={route} navigate={navigate} />;
    case "install":
      return <InstallFoundationPage live={live} location={location} route={route} navigate={navigate} />;
    case "library":
      return <LibraryFoundationPage live={live} location={location} route={route} navigate={navigate} />;
    case "store":
      return <StoreFoundationPage live={live} location={location} route={route} navigate={navigate} />;
    case "tool":
      return <ToolFoundationPage live={live} location={location} route={route} navigate={navigate} />;
    case "wallet":
      return <WalletFoundationPage live={live} location={location} route={route} navigate={navigate} />;
    case "settings":
      return <SettingsFoundationPage live={live} location={location} route={route} navigate={navigate} />;
    case "adminTool":
      return <AdminFoundationPage live={live} location={location} route={route} navigate={navigate} />;
    case "authCallback":
      return <AuthCallbackPage location={location} />;
  }
}

function AuthCallbackPage({ location }: { location: LocationState }): ReactElement {
  const [message, setMessage] = useState("Finishing sign in...");

  useEffect(() => {
    let cancelled = false;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const query = new URLSearchParams(location.search);
    const bridgeToken = hash.get("bridge_token");
    const nextPath = normalizeLocalPath(query.get("next"));

    if (!bridgeToken) {
      setMessage("Sign-in callback is missing a session token.");
      return;
    }

    exchangeLaunchBridgeToken(bridgeToken)
      .then((response) => {
        if (cancelled) return;
        setLaunchAuthToken(response.access_token);
        window.location.replace(nextPath);
      })
      .catch((err) => {
        if (cancelled) return;
        setMessage(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [location.search]);

  return (
    <div className="launch-page-narrow auth-callback-page">
      <div className="auth-callback-panel">
        <p className="section-label">Google sign in</p>
        <h1>{message}</h1>
      </div>
    </div>
  );
}

function currentLocation(): LocationState {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}
