import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  accountRoutes,
  type LaunchRouteKey,
  primaryRoutes,
  type ResolvedLaunchRoute,
  resolveLaunchRoute,
} from "./lib/routes";
import {
  type LaunchRouteLiveState,
  useLaunchRouteLiveData,
} from "./lib/live-data";
import {
  AccountFoundationPage,
  AdminFoundationPage,
  AgentFoundationPage,
  HomeFoundationPage,
  LibraryFoundationPage,
  StoreFoundationPage,
  PrivacyPage,
  TermsPage,
} from "./pages/foundation-pages";
import { LaunchShell } from "./components/launch-chrome";
import { NebulaFleetApp } from "./components/nebula-fleet";
import { SignInModalProvider } from "./components/sign-in-modal";
import {
  exchangeLaunchBridgeToken,
  getLaunchAuthToken,
  isLaunchRefreshAvailable,
  normalizeLocalPath,
  recordLaunchAuthDiagnostic,
  refreshLaunchSession,
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
  library: "Agents",
  store: "Browse",
  agent: "Agent",
  settings: "Profile",
  adminAgent: "Agent admin",
  authCallback: "Signing in",
  terms: "Terms of Service",
  privacy: "Privacy Policy",
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

  // Silent session restore on load: the access token only lives ~1h, but the
  // API may hold a refresh cookie. Without this the chrome renders signed-out
  // until some API call happens to refresh.
  useEffect(() => {
    if (getLaunchAuthToken() || !isLaunchRefreshAvailable()) return;
    let cancelled = false;
    refreshLaunchSession()
      .then((token) => {
        if (token && !cancelled) setLocation(currentLocation());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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

  // Per-page tab title: "<Page> | Galactic"; agent pages use the agent's name
  // ("Story Builder | Galactic"); the home page is just "Galactic".
  const agentDisplayName = route.definition.key === "agent"
    ? (live.data.agent?.agent?.name ?? live.data.agent?.tool?.name ?? null)
    : null;
  useEffect(() => {
    const key = route.definition.key;
    document.title = key === "home"
      ? "Galactic"
      : agentDisplayName
      ? `${agentDisplayName} | Galactic`
      : `${routeTitles[key]} | Galactic`;
  }, [route.definition.key, agentDisplayName]);

  const providerCodeMisrouted = route.definition.key !== "authCallback" &&
    new URLSearchParams(location.search).has("code");

  useEffect(() => {
    if (!providerCodeMisrouted) return;
    recordLaunchAuthDiagnostic({
      message:
        "Supabase returned an OAuth authorization code to the launch web origin instead of the API callback.",
      nextPath: location.pathname,
      status: "provider_code_misrouted",
    });
  }, [location.pathname, providerCodeMisrouted]);

  // Keep the top-nav item that LED here highlighted: the last primary/account
  // section the user visited sticks through detail pages (e.g. arriving at an
  // agent from "Agents" keeps Agents lit). A direct URL to a detail page has
  // no prior section, so it defaults to the user's Agent home.
  const [activeSection, setActiveSection] = useState<LaunchRouteKey>(
    route.definition.nav === "hidden" ? "library" : route.definition.key,
  );
  useEffect(() => {
    if (route.definition.nav !== "hidden") {
      setActiveSection(route.definition.key);
    }
  }, [route.definition.key, route.definition.nav]);

  const nebulaRoute = Boolean(getLaunchAuthToken()) && (
    route.definition.key === "home" ||
    route.definition.key === "library" ||
    route.definition.key === "settings" ||
    (route.definition.key === "agent" &&
      (live.data.agent?.agent ?? live.data.agent?.tool)?.relationship === "owner")
  );

  return (
    <SignInModalProvider>
      {nebulaRoute && !providerCodeMisrouted
        ? (
          <NebulaFleetApp
            live={live}
            location={location}
            route={route}
            navigate={navigate}
          />
        )
        : <LaunchShell
        accountRoutes={accountRoutes()}
        activeRoute={activeSection}
        navigate={navigate}
        primaryRoutes={primaryRoutes()}
        title={routeTitles[route.definition.key]}
      >
        {providerCodeMisrouted ? <MisroutedAuthCallbackPage /> : (
          <RouteSwitch
            live={live}
            location={location}
            route={route}
            navigate={navigate}
          />
        )}
      </LaunchShell>}
    </SignInModalProvider>
  );
}

function RouteSwitch(
  { live, location, route, navigate }: LaunchPageProps,
): ReactElement {
  switch (route.definition.key) {
    case "home":
      return (
        <HomeFoundationPage
          live={live}
          location={location}
          route={route}
          navigate={navigate}
        />
      );
    case "library":
      return (
        <LibraryFoundationPage
          live={live}
          location={location}
          route={route}
          navigate={navigate}
        />
      );
    case "store":
      return (
        <StoreFoundationPage
          live={live}
          location={location}
          route={route}
          navigate={navigate}
        />
      );
    case "agent":
      return (
        <AgentFoundationPage
          live={live}
          location={location}
          route={route}
          navigate={navigate}
        />
      );
    case "settings":
      return (
        <AccountFoundationPage
          live={live}
          location={location}
          route={route}
          navigate={navigate}
        />
      );
    case "adminAgent":
      return (
        <AdminFoundationPage
          live={live}
          location={location}
          route={route}
          navigate={navigate}
        />
      );
    case "authCallback":
      return <AuthCallbackPage location={location} />;
    case "terms":
      return <TermsPage />;
    case "privacy":
      return <PrivacyPage />;
  }
}

function AuthCallbackPage(
  { location }: { location: LocationState },
): ReactElement {
  const [message, setMessage] = useState("Finishing sign in...");

  useEffect(() => {
    let cancelled = false;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const query = new URLSearchParams(location.search);
    const bridgeToken = hash.get("bridge_token");
    const expiresIn = hash.get("expires_in");
    const nextPath = normalizeLocalPath(query.get("next"));
    recordLaunchAuthDiagnostic({
      bridgeTokenPresent: Boolean(bridgeToken),
      expiresIn,
      nextPath,
      status: "callback_loaded",
    });

    if (!bridgeToken) {
      recordLaunchAuthDiagnostic({
        bridgeTokenPresent: false,
        message: "The launch callback URL did not contain a bridge token.",
        nextPath,
        status: "callback_missing_bridge",
      });
      setMessage("Sign-in callback is missing a session token.");
      return;
    }

    recordLaunchAuthDiagnostic({
      bridgeTokenPresent: true,
      expiresIn,
      nextPath,
      status: "exchange_started",
    });
    exchangeLaunchBridgeToken(bridgeToken)
      .then((response) => {
        if (cancelled) return;
        recordLaunchAuthDiagnostic({
          bridgeTokenPresent: true,
          expiresIn: String(response.expires_in ?? expiresIn ?? ""),
          nextPath,
          status: "exchange_succeeded",
        });
        setLaunchAuthToken(response.access_token, response.expires_in);
        if (!getLaunchAuthToken()) {
          throw new Error("Browser storage rejected the launch session token.");
        }
        recordLaunchAuthDiagnostic({
          bridgeTokenPresent: true,
          expiresIn: String(response.expires_in ?? expiresIn ?? ""),
          nextPath,
          status: "token_stored",
        });
        window.location.replace(nextPath);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        recordLaunchAuthDiagnostic({
          bridgeTokenPresent: true,
          expiresIn,
          message,
          nextPath,
          status: "exchange_failed",
        });
        setMessage(message);
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

function MisroutedAuthCallbackPage(): ReactElement {
  return (
    <div className="launch-page-narrow auth-callback-page">
      <div className="auth-callback-panel">
        <p className="section-label">Google sign in</p>
        <h1>Sign-in callback landed on the web app.</h1>
        <p>
          The account provider returned an OAuth code here instead of sending it
          through the Galactic API callback, so no launch session was created.
        </p>
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
